// @ts-check
const functions = require('firebase-functions/v1');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const Stripe = require('stripe');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { CV_BASE_STYLES } = require('./cv-styles');
const {
    ALLOWED_ORIGINS,
    MAX_PAYLOAD_BYTES,
    getCorrelationId,
    sendProblem,
    isAllowedOrigin,
    validateBrowserRequestOrigin,
    extractClientIp,
    hashRateLimitKey,
    escapeHtml,
    isPrivateOrInternalUrl,
    sanitizePhotoUrl,
    safeHttpUrl,
    validateAndSanitizeCvData,
    maskIdentifier,
    evaluateStripeCheckoutSession,
    handleHealthz
} = require('./security-core');

if (!getApps().length) {
    initializeApp();
}
const db = getFirestore();

/**
 * Lazy fail-closed Stripe client initialization.
 * Prevents runtime execution against placeholder keys.
 * @returns {import('stripe').Stripe}
 */
function getStripeClient() {
    const apiKey = (process.env.STRIPE_SECRET_KEY || '').trim();
    if (!apiKey || apiKey.startsWith('sk_test_placeholder') || apiKey.includes('REPLACE_ME')) {
        throw new Error('STRIPE_SECRET_KEY is not configured in runtime environment');
    }
    return new Stripe(apiKey);
}

// ════════════════════════════════════════════════════════════════
// OBSERVABILITATE, CORRELATION ID & RFC 7807 PROBLEM DETAILS
// ════════════════════════════════════════════════════════════════
/**
 * Emits structured JSON log records without PII or stack traces.
 * @param {'info' | 'warn' | 'error'} level
 * @param {string} event
 * @param {string} correlationId
 * @param {Record<string, unknown>} [details]
 */
function logStructured(level, event, correlationId, details = {}) {
    const payload = {
        timestamp: new Date().toISOString(),
        correlation_id: correlationId,
        level,
        event,
        ...details
    };
    if (level === 'error') {
        functions.logger.error(event, payload);
    } else if (level === 'warn') {
        functions.logger.warn(event, payload);
    } else {
        functions.logger.info(event, payload);
    }
}

// ════════════════════════════════════════════════════════════════
// RATE LIMITING SERVERLESS (Sliding Window in-memory + Upstash Redis)
// ════════════════════════════════════════════════════════════════
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 2 * 60 * 1000; // 2 minute
const RATE_LIMIT_WINDOW_SECONDS = 120;
const MAX_REQUESTS_PER_WINDOW = 6;

function cleanupRateLimits() {
    if (rateLimitMap.size > 500) {
        const now = Date.now();
        for (const [key, record] of rateLimitMap.entries()) {
            if (now - record.startTime > RATE_LIMIT_WINDOW_MS) {
                rateLimitMap.delete(key);
            }
        }
    }
}

/**
 * @param {string} bucketHash
 * @returns {boolean}
 */
function isRateLimited(bucketHash) {
    cleanupRateLimits();

    const now = Date.now();
    const record = rateLimitMap.get(bucketHash);

    if (!record || now - record.startTime > RATE_LIMIT_WINDOW_MS) {
        rateLimitMap.set(bucketHash, { count: 1, startTime: now });
        return false;
    }

    if (record.count >= MAX_REQUESTS_PER_WINDOW) {
        return true;
    }

    record.count += 1;
    return false;
}

/**
 * @param {string} rawKey
 * @returns {Promise<boolean>}
 */
async function isRateLimitedAsync(rawKey) {
    const bucketHash = hashRateLimitKey(rawKey);

    const kvUrl = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').trim();
    const kvToken = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim();

    if (kvUrl && kvToken) {
        try {
            const redisKey = `cvbuilder:rl:${bucketHash}`;
            const res = await fetch(`${kvUrl.replace(/\/$/, '')}/pipeline`, {
                method: 'POST',
                signal: AbortSignal.timeout(1500),
                headers: {
                    'Authorization': `Bearer ${kvToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify([
                    ['INCR', redisKey],
                    ['EXPIRE', redisKey, RATE_LIMIT_WINDOW_SECONDS, 'NX']
                ])
            });
            if (res.ok) {
                const data = await res.json();
                const currentCount = Array.isArray(data) && data[0] ? Number(data[0].result) : 1;
                return currentCount > MAX_REQUESTS_PER_WINDOW;
            }
        } catch (_) {
            // Fallback in-memory dacă store-ul distribuit nu răspunde în 1.5s
        }
    }

    return isRateLimited(bucketHash);
}

// ════════════════════════════════════════════════════════════════
// [CVB-SEC-003] CORS MIDDLEWARE (Strict Whitelist + RFC 7807 Errors)
// ════════════════════════════════════════════════════════════════
const corsMiddleware = require('cors')({
    origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
            return callback(null, true);
        }
        return callback(null, false);
    },
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID']
});

/**
 * @param {Array<{period?: string}>} experiences
 * @returns {number}
 */
function calculateTotalExperienceYears(experiences) {
    const nowYear = new Date().getFullYear();
    let total = 0;
    for (const exp of experiences) {
        const periodStr = exp.period || '';
        const years = periodStr.match(/\b\d{4}\b/g);
        if (years && years.length >= 1) {
            const start = parseInt(years[0], 10);
            const end = years.length >= 2
                ? parseInt(years[1], 10)
                : (/prezent|present|current|acum/i.test(periodStr) ? nowYear : start);
            if (end >= start) {
                total += Math.max(1, end - start);
            }
        }
    }
    return total;
}

/**
 * Converts plain multiline bullet text into safe escaped HTML paragraphs/lists.
 * @param {string} txt
 * @returns {string}
 */
function renderSafeDescriptionHtml(txt) {
    if (!txt) return '';
    const lines = txt.split('\n');
    let html = '';
    let inList = false;
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            if (inList) {
                html += '</ul>';
                inList = false;
            }
            continue;
        }
        const bulletMatch = line.match(/^[-*\u2022]\s+(.*)/);
        if (bulletMatch) {
            if (!inList) {
                html += '<ul>';
                inList = true;
            }
            html += `<li>${escapeHtml(bulletMatch[1])}</li>`;
        } else {
            if (inList) {
                html += '</ul>';
                inList = false;
            }
            html += `<p>${escapeHtml(line)}</p>`;
        }
    }
    if (inList) html += '</ul>';
    return html;
}

// ════════════════════════════════════════════════════════════════
// 0. HEALTHCHECK ENDPOINT (/healthz & /readyz)
// ════════════════════════════════════════════════════════════════
const onRequest = functions.https.onRequest;

exports.healthz = onRequest(handleHealthz);

// ════════════════════════════════════════════════════════════════
// 1. STRIPE WEBHOOK (Activare cont PRO, Revocare & Credite cu Ledger)
// ════════════════════════════════════════════════════════════════
exports.stripeWebhook = onRequest(async (req, res) => {
    const correlationId = getCorrelationId(req, 'strp');
    if (typeof res.setHeader === 'function') {
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Correlation-ID', correlationId);
    }

    if (req.method !== 'POST') {
        return sendProblem(res, 405, 'Method Not Allowed', 'Only POST requests are accepted on Stripe webhook.', '/stripeWebhook', correlationId);
    }

    const sig = req.headers['stripe-signature'];
    const endpointSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();

    if (!endpointSecret || endpointSecret.includes('REPLACE_ME')) {
        logStructured('error', 'Missing STRIPE_WEBHOOK_SECRET in runtime environment', correlationId);
        return sendProblem(res, 500, 'Webhook Configuration Error', 'Webhook secret neconfigurat.', '/stripeWebhook', correlationId);
    }

    let stripeClient;
    try {
        stripeClient = getStripeClient();
    } catch (_) {
        logStructured('error', 'Missing STRIPE_SECRET_KEY in runtime environment', correlationId);
        return sendProblem(res, 500, 'Webhook Configuration Error', 'Stripe API key neconfigurată.', '/stripeWebhook', correlationId);
    }

    let event;
    try {
        event = stripeClient.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Invalid signature';
        logStructured('error', 'Webhook signature verification failed', correlationId, { errorName: 'SignatureVerificationError' });
        return sendProblem(res, 400, 'Webhook Signature Error', `Webhook Error: ${errMsg}`, '/stripeWebhook', correlationId);
    }

    const eventId = event.id;
    const supportedEvents = new Set([
        'checkout.session.completed',
        'customer.subscription.deleted',
        'invoice.payment_failed'
    ]);

    if (!supportedEvents.has(event.type)) {
        return res.json({ received: true });
    }

    const usersRef = db.collection('users');
    const processedEventRef = db.collection('processed_stripe_events').doc(eventId);

    if (event.type === 'checkout.session.completed') {
        const expectedCurrency = (process.env.STRIPE_CURRENCY || 'eur').trim().toLowerCase();
        const subscriptionMinCents = Number(process.env.STRIPE_SUBSCRIPTION_MIN_CENTS || 500);
        const onetimeMinCents = Number(process.env.STRIPE_ONETIME_MIN_CENTS || 300);

        const evaluation = evaluateStripeCheckoutSession(event.data.object, {
            expectedCurrency,
            subscriptionMinCents,
            onetimeMinCents
        });

        if (!evaluation.ok) {
            if (String(evaluation.reason).startsWith('unpaid_status:')) {
                logStructured('warn', 'Stripe checkout session not paid yet, skipping activation', correlationId, {
                    eventId,
                    reason: evaluation.reason
                });
                return res.json({ received: true, skipped_unpaid: true });
            }
            logStructured('error', 'Stripe checkout session failed integrity check', correlationId, {
                eventId,
                reason: evaluation.reason
            });
            return res.json({ received: true, rejected_integrity: true });
        }

        const isSubscription = Boolean(evaluation.isSubscription);

        try {
            const outcome = await db.runTransaction(async (transaction) => {
                const eventDoc = await transaction.get(processedEventRef);
                if (eventDoc.exists) {
                    return { alreadyProcessed: true };
                }

                /** @type {Array<{ ref: FirebaseFirestore.DocumentReference, currentCredits: number }>} */
                const targets = [];

                if (evaluation.firebaseUid) {
                    const directRef = usersRef.doc(evaluation.firebaseUid);
                    const directDoc = await transaction.get(directRef);
                    const existingCredits = directDoc.exists && Number.isInteger(directDoc.data()?.exportCredits)
                        ? Number(directDoc.data()?.exportCredits)
                        : Math.max(0, Math.floor(Number(directDoc.data()?.exportCredits || 0)));
                    targets.push({ ref: directRef, currentCredits: existingCredits });
                } else if (evaluation.customerEmail) {
                    const snap = await transaction.get(usersRef.where('email', '==', evaluation.customerEmail));
                    snap.forEach((doc) => {
                        const existingCredits = Number.isInteger(doc.data()?.exportCredits)
                            ? Number(doc.data()?.exportCredits)
                            : Math.max(0, Math.floor(Number(doc.data()?.exportCredits || 0)));
                        targets.push({ ref: doc.ref, currentCredits: existingCredits });
                    });
                }

                for (const target of targets) {
                    /** @type {Record<string, unknown>} */
                    const userUpdate = {
                        stripeCustomerId: evaluation.stripeCustomerId,
                        proActivatedAt: FieldValue.serverTimestamp()
                    };
                    if (evaluation.customerEmail) {
                        userUpdate.email = evaluation.customerEmail;
                    }
                    if (isSubscription) {
                        userUpdate.isPro = true;
                        userUpdate.status = 'active';
                        userUpdate.subscriptionId = evaluation.subscriptionId;
                    } else {
                        const nextCredits = target.currentCredits + 1;
                        userUpdate.exportCredits = nextCredits;

                        const ledgerRef = db.collection('credit_ledger').doc();
                        transaction.set(ledgerRef, {
                            userId: target.ref.id,
                            uid: target.ref.id,
                            delta: +1,
                            balanceAfter: nextCredits,
                            reason: 'CREDIT_PURCHASE',
                            stripeEventId: eventId,
                            timestamp: FieldValue.serverTimestamp()
                        });
                    }

                    transaction.set(target.ref, userUpdate, { merge: true });

                    const auditRef = db.collection('audit_logs').doc();
                    transaction.set(auditRef, {
                        action: isSubscription ? 'SUBSCRIPTION_ACTIVATED' : 'CREDIT_PURCHASE',
                        userId: target.ref.id,
                        stripeCustomerMasked: maskIdentifier(evaluation.stripeCustomerId),
                        amountTotal: evaluation.amountTotal,
                        currency: evaluation.currency,
                        stripeEventId: eventId,
                        correlationId,
                        timestamp: FieldValue.serverTimestamp()
                    });
                }

                transaction.set(processedEventRef, {
                    eventId,
                    processedAt: FieldValue.serverTimestamp(),
                    type: event.type,
                    matchedUsers: targets.length,
                    correlationId
                });

                return { alreadyProcessed: false, matchedUsers: targets.length };
            });

            if (outcome.alreadyProcessed) {
                logStructured('info', 'Stripe event already processed, skipping mutation', correlationId, { eventId });
                return res.json({ received: true, already_processed: true });
            }

            if (outcome.matchedUsers === 0) {
                logStructured('warn', 'Paid Stripe session had no matching Firebase user', correlationId, { eventId });
            }
        } catch (_) {
            logStructured('error', 'Atomic Stripe purchase transaction failed', correlationId, { eventId });
            return sendProblem(res, 500, 'Database Update Failed', 'Eroare actualizare bază de date.', '/stripeWebhook', correlationId);
        }
    } else if (event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
        const eventObj = event.data.object || {};
        const stripeCustomerId = typeof eventObj.customer === 'string' && eventObj.customer.trim()
            ? eventObj.customer.trim()
            : null;
        const nextStatus = event.type === 'customer.subscription.deleted' ? 'cancelled' : 'past_due';

        try {
            const outcome = await db.runTransaction(async (transaction) => {
                const eventDoc = await transaction.get(processedEventRef);
                if (eventDoc.exists) {
                    return { alreadyProcessed: true, revokedCount: 0 };
                }

                let revokedCount = 0;
                if (stripeCustomerId) {
                    const snapshot = await transaction.get(usersRef.where('stripeCustomerId', '==', stripeCustomerId));
                    snapshot.forEach((doc) => {
                        revokedCount += 1;
                        transaction.set(
                            doc.ref,
                            {
                                isPro: false,
                                status: nextStatus,
                                subRevokedAt: FieldValue.serverTimestamp()
                            },
                            { merge: true }
                        );
                        const auditRef = db.collection('audit_logs').doc();
                        transaction.set(auditRef, {
                            action: 'SUBSCRIPTION_REVOKED',
                            userId: doc.id,
                            stripeCustomerMasked: maskIdentifier(stripeCustomerId),
                            eventType: event.type,
                            stripeEventId: eventId,
                            correlationId,
                            timestamp: FieldValue.serverTimestamp()
                        });
                    });
                }

                transaction.set(processedEventRef, {
                    eventId,
                    processedAt: FieldValue.serverTimestamp(),
                    type: event.type,
                    revokedCount,
                    correlationId
                });

                return { alreadyProcessed: false, revokedCount };
            });

            if (outcome.alreadyProcessed) {
                logStructured('info', 'Stripe revocation event already processed, skipping mutation', correlationId, { eventId });
                return res.json({ received: true, already_processed: true });
            }

            logStructured('info', 'Processed subscription revocation event', correlationId, {
                eventId,
                eventType: event.type,
                revokedCount: outcome.revokedCount
            });
        } catch (_) {
            logStructured('error', 'Failed atomic subscription revocation in Firestore', correlationId, { eventId });
            return sendProblem(res, 500, 'Subscription Revocation Failed', 'Eroare la revocarea abonamentului.', '/stripeWebhook', correlationId);
        }
    }

    return res.json({ received: true });
});

// ════════════════════════════════════════════════════════════════
// 2. GENERARE PDF ULTRA-SECURIZATĂ (Puppeteer Chromium Hardening)
// ════════════════════════════════════════════════════════════════
exports.generatePDF = functions.runWith({ memory: '2GB', timeoutSeconds: 60 }).https.onRequest((req, res) => {
    const correlationId = getCorrelationId(req, 'pdf');
    if (typeof res.setHeader === 'function') {
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Correlation-ID', correlationId);
    }

    const originHeader = req.headers ? req.headers.origin : '';
    if (originHeader && !isAllowedOrigin(originHeader)) {
        logStructured('warn', 'Blocked unauthorized CORS origin on generatePDF', correlationId);
        return sendProblem(res, 403, 'Forbidden Origin', 'Blocat de politica de securitate CORS. Originea nu este autorizată.', '/generatePDF', correlationId);
    }

    corsMiddleware(req, res, async () => {
        if (req.method === 'OPTIONS') {
            return res.status(204).send('');
        }

        if (req.method !== 'POST') {
            return sendProblem(res, 405, 'Method Not Allowed', 'Only POST is allowed.', '/generatePDF', correlationId);
        }

        const originCheck = validateBrowserRequestOrigin(req);
        if (!originCheck.allowed) {
            logStructured('warn', 'Blocked missing or unauthorized Origin/Fetch-Site on POST generatePDF', correlationId, {
                reason: originCheck.reason
            });
            return sendProblem(res, 403, 'Forbidden Origin', 'Originea cererii nu este autorizată.', '/generatePDF', correlationId);
        }

        // Guard dimensiune payload înainte de operații costisitoare (Denial-of-Wallet: max 512 KB)
        const rawBodyLen = req.rawBody ? req.rawBody.length : Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');
        if (rawBodyLen > MAX_PAYLOAD_BYTES) {
            logStructured('warn', 'Payload too large on generatePDF', correlationId, { rawBodyLen });
            return sendProblem(res, 413, 'Payload Too Large', 'Payload-ul CV-ului depășește limita maximă admisă (512 KB).', '/generatePDF', correlationId);
        }

        // Rate limiting distribuit hibrid cu extracție IP rezistentă la XFF spoofing
        const clientIp = extractClientIp(req);
        if (await isRateLimitedAsync(clientIp)) {
            logStructured('warn', 'Rate limit exceeded on generatePDF', correlationId);
            return sendProblem(res, 429, 'Too Many Requests', 'Prea multe solicitări de export PDF. Te rugăm să aștepți 2 minute.', '/generatePDF', correlationId);
        }

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const sanitizedCv = validateAndSanitizeCvData(body.cvData);
        if (!sanitizedCv) {
            return sendProblem(res, 400, 'Validation Error', 'Lipsește obiectul valid de date cvData.', '/generatePDF', correlationId);
        }

        // Autentificare: preferăm header Authorization: Bearer <token>, cu fallback body.token; Fail-Closed dacă tokenul este invalid!
        const authHeader = req.headers && typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
        const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
        const rawToken = bearerMatch ? bearerMatch[1].trim() : (typeof body.token === 'string' ? body.token.trim() : '');

        let isPro = false;
        let browser = null;
        let deductedCredit = false;
        /** @type {string | null} */
        let deductedUid = null;

        if (rawToken) {
            let decodedUid = null;
            try {
                const decodedToken = await getAuth().verifyIdToken(rawToken);
                decodedUid = decodedToken.uid;
            } catch (_) {
                logStructured('warn', 'Invalid or expired Firebase ID token on generatePDF', correlationId);
                return sendProblem(
                    res,
                    401,
                    'Invalid Authentication Token',
                    'Sesiunea de autentificare a expirat. Reîncarcă sesiunea și încearcă din nou.',
                    '/generatePDF',
                    correlationId
                );
            }

            const userRef = db.collection('users').doc(decodedUid);
            try {
                await db.runTransaction(async (transaction) => {
                    const userDoc = await transaction.get(userRef);
                    if (!userDoc.exists) return;
                    const data = userDoc.data() || {};
                    if (data.isPro === true) {
                        isPro = true;
                        return;
                    }
                    const currentCredits = Number.isInteger(data.exportCredits)
                        ? Number(data.exportCredits)
                        : Math.floor(Number(data.exportCredits || 0));
                    if (currentCredits > 0) {
                        const newBalance = currentCredits - 1;
                        if (newBalance < 0) {
                            throw new Error('Invariant violation: negative credit balance');
                        }
                        isPro = true;
                        deductedCredit = true;
                        deductedUid = decodedUid;
                        transaction.update(userRef, { exportCredits: newBalance });

                        const ledgerRef = db.collection('credit_ledger').doc();
                        transaction.set(ledgerRef, {
                            userId: decodedUid,
                            uid: decodedUid,
                            reason: 'DEBIT_EXPORT',
                            type: 'DEBIT_EXPORT',
                            delta: -1,
                            balanceAfter: newBalance,
                            correlationId,
                            createdAt: FieldValue.serverTimestamp()
                        });

                        const auditRef = db.collection('audit_logs').doc();
                        transaction.set(auditRef, {
                            action: 'PDF_CREDIT_CONSUMED',
                            userId: decodedUid,
                            balanceAfter: newBalance,
                            correlationId,
                            timestamp: FieldValue.serverTimestamp()
                        });
                    }
                });
            } catch (_) {
                logStructured('error', 'Failed atomic credit verification transaction', correlationId);
                return sendProblem(res, 500, 'Credit Verification Failed', 'Nu s-a putut verifica soldul contului.', '/generatePDF', correlationId);
            }
        }

        try {
            const renderPills = (arr) => {
                if (!Array.isArray(arr) || !arr.length) return '';
                return arr.map((p) => `<div class="cv-pill">${escapeHtml(String(p))}</div>`).join('');
            };

            const renderItems = (sectionTitle, arr, mapFields) => {
                if (!Array.isArray(arr) || !arr.length) return '';
                const itemsHtml = arr.map((item) => {
                    const mapped = mapFields(item);
                    const safeLink = mapped.url ? safeHttpUrl(mapped.url) : '';
                    const titleHtml = safeLink
                        ? `<a href="${escapeHtml(safeLink)}">${escapeHtml(mapped.title)}</a>`
                        : escapeHtml(mapped.title);
                    const dateHtml = escapeHtml(mapped.date);
                    const subHtml = escapeHtml(mapped.sub);
                    const descHtml = mapped.desc ? renderSafeDescriptionHtml(mapped.desc) : '';

                    return `
                        <div class="cv-item">
                            <div class="cv-item__hdr">
                                <div class="cv-item__title">${titleHtml}</div>
                                <div class="cv-item__date">${dateHtml}</div>
                            </div>
                            ${subHtml ? `<div class="cv-item__sub">${subHtml}</div>` : ''}
                            ${descHtml ? `<div class="cv-text">${descHtml}</div>` : ''}
                        </div>
                    `;
                }).join('');

                return `
                    <div class="cv-sec">
                        <div class="cv-sec__title">${escapeHtml(sectionTitle)}</div>
                        ${itemsHtml}
                    </div>
                `;
            };

            const sections = {
                summary: sanitizedCv.summary
                    ? `<div class="cv-sec"><div class="cv-sec__title">Profil Profesional</div><div class="cv-text">${renderSafeDescriptionHtml(sanitizedCv.summary)}</div></div>`
                    : '',
                experience: renderItems('Experiență Profesională', sanitizedCv.experiences, (e) => ({
                    title: e.role || '',
                    date: e.period || '',
                    sub: e.company || '',
                    desc: e.desc || ''
                })),
                projects: renderItems('Proiecte', sanitizedCv.projects, (p) => ({
                    title: p.name || '',
                    date: p.period || '',
                    sub: p.tech || '',
                    desc: p.desc || '',
                    url: p.url || ''
                })),
                education: renderItems('Educație', sanitizedCv.educations, (e) => ({
                    title: e.degree || '',
                    date: e.period || '',
                    sub: e.institution || ''
                })),
                certifications: renderItems('Certificări', sanitizedCv.certifications, (c) => ({
                    title: c.name || '',
                    date: c.period || '',
                    sub: c.issuer || ''
                })),
                languages: sanitizedCv.languages.length
                    ? `
                    <div class="cv-sec">
                        <div class="cv-sec__title">Limbi Străine</div>
                        <div class="cv-pills">
                            ${sanitizedCv.languages.map((l) => `<div class="cv-pill">${escapeHtml(l.name)}${l.level ? ' — ' + escapeHtml(l.level) : ''}</div>`).join('')}
                        </div>
                    </div>
                `
                    : '',
                skills: sanitizedCv.skills.length
                    ? `
                    <div class="cv-sec">
                        <div class="cv-sec__title">Competențe Tehnice &amp; Soft Skills</div>
                        <div class="cv-pills">${renderPills(sanitizedCv.skills)}</div>
                    </div>
                `
                    : ''
            };

            const orderedSections = sanitizedCv.order
                .filter((key) => !sanitizedCv.hidden.includes(key))
                .map((key) => sections[key] || '')
                .join('');

            const expYears = calculateTotalExperienceYears(sanitizedCv.experiences);
            const expBadgeHtml = expYears > 0
                ? `<span class="cv-exp-badge">${expYears}${expYears === 1 ? ' An' : ' Ani'} Exp.</span>`
                : '';

            const contactLinks = [];
            if (sanitizedCv.email) contactLinks.push(`<div class="cv-ci"><a href="mailto:${escapeHtml(sanitizedCv.email)}">${escapeHtml(sanitizedCv.email)}</a></div>`);
            if (sanitizedCv.phone) contactLinks.push(`<div class="cv-ci"><a href="tel:${escapeHtml(sanitizedCv.phone)}">${escapeHtml(sanitizedCv.phone)}</a></div>`);
            if (sanitizedCv.location) contactLinks.push(`<div class="cv-ci">${escapeHtml(sanitizedCv.location)}</div>`);
            if (sanitizedCv.linkedin) contactLinks.push(`<div class="cv-ci"><a href="${escapeHtml(sanitizedCv.linkedin)}">LinkedIn</a></div>`);
            if (sanitizedCv.github) contactLinks.push(`<div class="cv-ci"><a href="${escapeHtml(sanitizedCv.github)}">GitHub</a></div>`);
            if (sanitizedCv.portfolio) contactLinks.push(`<div class="cv-ci"><a href="${escapeHtml(sanitizedCv.portfolio)}">Portofoliu</a></div>`);
            for (const link of sanitizedCv.links) {
                contactLinks.push(`<div class="cv-ci"><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></div>`);
            }

            const docHTML = `
                <!DOCTYPE html>
                <html lang="ro">
                <head>
                    <meta charset="UTF-8">
                    <style>
                        ${CV_BASE_STYLES}
                        :root {
                            --cv-accent: ${sanitizedCv.color};
                            --cv-font: ${sanitizedCv.font};
                            --cv-pad: ${sanitizedCv.padding}mm;
                            --cv-size: ${sanitizedCv.size}px;
                            --cv-lh: ${sanitizedCv.lh};
                            --cv-gap: ${sanitizedCv.gap}px;
                        }
                    </style>
                </head>
                <body>
                    <div class="cv-doc">
                        <div class="cv-hdr">
                            ${sanitizedCv.photo ? `<img class="cv-photo" src="${sanitizedCv.photo}" alt="Photo">` : ''}
                            <div class="cv-meta">
                                <div class="cv-name">${escapeHtml(sanitizedCv.name)}</div>
                                <div class="cv-role-row">
                                    <div class="cv-role">${escapeHtml(sanitizedCv.title)}</div>
                                    ${expBadgeHtml}
                                </div>
                            </div>
                            <div class="cv-contact">
                                ${contactLinks.join('')}
                            </div>
                        </div>
                        ${orderedSections}
                        ${!isPro ? '<div class="cv-watermark">Creat cu CV Builder Pro</div>' : ''}
                    </div>
                </body>
                </html>
            `;

            // Lansare securizată Chromium (Puppeteer 24/25 + Sparticuz Chromium 143)
            browser = await puppeteer.launch({
                args: puppeteer.defaultArgs({
                    args: [
                        ...chromium.args,
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-extensions'
                    ],
                    headless: 'shell'
                }),
                defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
                executablePath: await chromium.executablePath(),
                headless: 'shell'
            });

            const page = await browser.newPage();

            // 1. Dezactivare completă interpretare JS (Elimină Server-Side XSS la zero)
            await page.setJavaScriptEnabled(false);

            // 2. [CVB-SEC-001] Interceptare strictă: exclusiv 'about:' și 'data:image/' (Zero conexiuni de rețea -> 0% SSRF)
            await page.setRequestInterception(true);
            page.on('request', (interceptedReq) => {
                const reqUrl = (interceptedReq.url() || '').toLowerCase();
                if (reqUrl.startsWith('data:image/') || reqUrl.startsWith('about:')) {
                    return interceptedReq.continue();
                }
                return interceptedReq.abort();
            });

            await page.setContent(docHTML, { waitUntil: 'load', timeout: 20000 });

            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' }
            });

            const safeFileName = (sanitizedCv.name || 'Export').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'Export';
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Cache-Control', 'private, no-store, max-age=0');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Disposition', `attachment; filename="CV_${safeFileName}.pdf"`);
            return res.send(pdfBuffer);
        } catch (error) {
            // [CVB-SEC-002] Tranzacție compensatorie: restituire credit la eșec Puppeteer
            if (deductedCredit && deductedUid) {
                try {
                    const userRef = db.collection('users').doc(deductedUid);
                    await db.runTransaction(async (transaction) => {
                        const userDoc = await transaction.get(userRef);
                        const currentCredits = userDoc.exists ? Number(userDoc.data()?.exportCredits || 0) : 0;
                        const refundedBalance = currentCredits + 1;
                        transaction.set(userRef, { exportCredits: refundedBalance }, { merge: true });

                        const ledgerRef = db.collection('credit_ledger').doc();
                        transaction.set(ledgerRef, {
                            userId: deductedUid,
                            uid: deductedUid,
                            delta: +1,
                            reason: 'CREDIT_REFUND_RENDER_ERROR',
                            type: 'CREDIT_REFUND_RENDER_ERROR',
                            balanceAfter: refundedBalance,
                            correlationId,
                            createdAt: FieldValue.serverTimestamp()
                        });

                        const auditRef = db.collection('audit_logs').doc();
                        transaction.set(auditRef, {
                            action: 'CREDIT_REFUND_RENDER_ERROR',
                            userId: deductedUid,
                            balanceAfter: refundedBalance,
                            correlationId,
                            timestamp: FieldValue.serverTimestamp()
                        });
                    });
                    logStructured('info', 'Refunded 1 export credit after Puppeteer failure', correlationId, { userId: deductedUid });
                } catch (_) {
                    logStructured('error', 'Failed to refund export credit after render failure', correlationId, { userId: deductedUid });
                }
            }

            logStructured('error', 'Server error generating PDF', correlationId, {
                errorName: error instanceof Error ? error.name : 'RenderError'
            });
            return sendProblem(res, 500, 'PDF Generation Failed', 'A apărut o eroare la generarea PDF-ului.', '/generatePDF', correlationId);
        } finally {
            if (browser) {
                try {
                    await browser.close();
                } catch (_) {
                    logStructured('error', 'Error closing browser instance', correlationId);
                }
            }
        }
    });
});

exports.__test__ = {
    sanitizePhotoUrl,
    safeHttpUrl,
    validateAndSanitizeCvData,
    evaluateStripeCheckoutSession,
    isPrivateOrInternalUrl,
    isAllowedOrigin,
    validateBrowserRequestOrigin,
    extractClientIp,
    hashRateLimitKey,
    maskIdentifier,
    ALLOWED_ORIGINS,
    sendProblem,
    getStripeClient
};
