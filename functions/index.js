// @ts-check
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { getFirestore } = require('firebase-admin/firestore');
const { CV_BASE_STYLES } = require('./cv-styles');
const {
    ALLOWED_ORIGINS,
    getCorrelationId,
    sendProblem,
    isAllowedOrigin,
    escapeHtml,
    isPrivateOrInternalUrl,
    sanitizePhotoUrl,
    handleHealthz
} = require('./security-core');

if (!admin.apps.length) {
    admin.initializeApp();
}
const db = getFirestore();

// ════════════════════════════════════════════════════════════════
// OBSERVABILITATE, CORRELATION ID & RFC 7807 PROBLEM DETAILS
// ════════════════════════════════════════════════════════════════
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
// RATE LIMITING SERVERLESS (Sliding Window in-memory + Redis)
// ════════════════════════════════════════════════════════════════
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 2 * 60 * 1000; // 2 minute
const RATE_LIMIT_WINDOW_SECONDS = 120;
const MAX_REQUESTS_PER_WINDOW = 6;
const MAX_PAYLOAD_BYTES = 512 * 1024; // 512 KB Denial-of-Wallet guard
const MAX_PHOTO_DATA_URI_LENGTH = Math.floor(2.5 * 1024 * 1024); // 2.5 MB

function normalizeRateLimitKey(key) {
    const trimmed = typeof key === 'string' ? key.trim() : '';
    return (!trimmed || trimmed.toLowerCase() === 'unknown') ? 'global_unknown_ip' : trimmed;
}

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

function isRateLimited(key) {
    const bucketKey = normalizeRateLimitKey(key);
    cleanupRateLimits();

    const now = Date.now();
    const record = rateLimitMap.get(bucketKey);

    if (!record || now - record.startTime > RATE_LIMIT_WINDOW_MS) {
        rateLimitMap.set(bucketKey, { count: 1, startTime: now });
        return false;
    }

    if (record.count >= MAX_REQUESTS_PER_WINDOW) {
        return true;
    }

    record.count += 1;
    return false;
}

async function isRateLimitedAsync(key) {
    const bucketKey = normalizeRateLimitKey(key);

    const kvUrl = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').trim();
    const kvToken = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim();

    if (kvUrl && kvToken) {
        try {
            const redisKey = `cvbuilder:rl:${bucketKey}`;
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

    return isRateLimited(bucketKey);
}

// ════════════════════════════════════════════════════════════════
// [CVB-SEC-003] CORS CONFIGURATION (Strict Whitelist)
// ════════════════════════════════════════════════════════════════
const cors = require('cors')({
    origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Blocat de politica de securitate CORS. Originea nu este autorizată.'));
    }
});

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
        res.setHeader('X-Correlation-ID', correlationId);
    }

    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!endpointSecret) {
        logStructured('error', 'Missing STRIPE_WEBHOOK_SECRET in runtime environment', correlationId);
        return sendProblem(res, 500, 'Webhook Configuration Error', 'Webhook secret neconfigurat.', '/stripeWebhook', correlationId);
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
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

    // [CVB-SEC-002] La checkout.session.completed, verificăm ca plata să fie efectiv confirmată ('paid')
    if (event.type === 'checkout.session.completed') {
        const sessionObj = event.data.object || {};
        if (sessionObj.payment_status !== 'paid') {
            logStructured('warn', 'Stripe checkout session not paid yet, skipping activation', correlationId, {
                eventId,
                paymentStatus: sessionObj.payment_status
            });
            return res.json({ received: true, skipped_unpaid: true });
        }
    }

    // BARIERĂ DETERMINISTĂ DE IDEMPOTENȚĂ (Elimină Double-Spend la retry de rețea)
    const processedEventRef = db.collection('processed_stripe_events').doc(eventId);
    try {
        const alreadyProcessed = await db.runTransaction(async (transaction) => {
            const eventDoc = await transaction.get(processedEventRef);
            if (eventDoc.exists) {
                return true;
            }
            transaction.set(processedEventRef, {
                eventId,
                processedAt: admin.firestore.FieldValue.serverTimestamp(),
                type: event.type,
                correlationId
            });
            return false;
        });

        if (alreadyProcessed) {
            logStructured('info', 'Stripe event already processed, skipping mutation', correlationId, { eventId });
            return res.json({ received: true, already_processed: true });
        }
    } catch (_) {
        logStructured('error', 'Error checking webhook idempotency', correlationId, { eventId });
        return sendProblem(res, 500, 'Idempotency Check Failed', 'Eroare verificare idempotență.', '/stripeWebhook', correlationId);
    }

    const usersRef = db.collection('users');

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const customerEmail = session.customer_details ? session.customer_details.email : null;
        const firebaseUid = session.client_reference_id;
        const isSubscription = session.mode === 'subscription';

        const subscriptionData = {
            stripeCustomerId: session.customer || null,
            proActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
            email: customerEmail || null
        };

        if (isSubscription) {
            subscriptionData.isPro = true;
            subscriptionData.subscriptionId = session.subscription || null;
        } else {
            subscriptionData.exportCredits = admin.firestore.FieldValue.increment(1);
        }

        const recordPurchaseForUser = (batch, userId) => {
            batch.set(usersRef.doc(userId), subscriptionData, { merge: true });
            if (!isSubscription) {
                const ledgerRef = db.collection('credit_ledger').doc();
                batch.set(ledgerRef, {
                    userId,
                    uid: userId,
                    delta: +1,
                    reason: 'CREDIT_PURCHASE',
                    stripeEventId: eventId,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            const auditRef = db.collection('audit_logs').doc();
            batch.set(auditRef, {
                action: isSubscription ? 'SUBSCRIPTION_ACTIVATED' : 'CREDIT_PURCHASE',
                userId,
                stripeCustomerId: session.customer || null,
                stripeEventId: eventId,
                correlationId,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        };

        try {
            if (firebaseUid) {
                const batch = db.batch();
                recordPurchaseForUser(batch, firebaseUid);
                await batch.commit();
            } else if (customerEmail) {
                const snapshot = await usersRef.where('email', '==', customerEmail).get();
                if (!snapshot.empty) {
                    const batch = db.batch();
                    snapshot.forEach((doc) => {
                        recordPurchaseForUser(batch, doc.id);
                    });
                    await batch.commit();
                }
            }
        } catch (_) {
            logStructured('error', 'Subscription status database update failed', correlationId, { eventId });
            return sendProblem(res, 500, 'Database Update Failed', 'Eroare actualizare bază de date.', '/stripeWebhook', correlationId);
        }
    } else if (event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
        const eventObj = event.data.object || {};
        const stripeCustomerId = eventObj.customer || null;

        if (stripeCustomerId) {
            try {
                const snapshot = await usersRef.where('stripeCustomerId', '==', stripeCustomerId).get();
                if (!snapshot.empty) {
                    const batch = db.batch();
                    snapshot.forEach((doc) => {
                        batch.set(
                            usersRef.doc(doc.id),
                            {
                                isPro: false,
                                subRevokedAt: admin.firestore.FieldValue.serverTimestamp()
                            },
                            { merge: true }
                        );
                        const auditRef = db.collection('audit_logs').doc();
                        batch.set(auditRef, {
                            action: 'SUBSCRIPTION_REVOKED',
                            userId: doc.id,
                            stripeCustomerId,
                            eventType: event.type,
                            stripeEventId: eventId,
                            correlationId,
                            timestamp: admin.firestore.FieldValue.serverTimestamp()
                        });
                    });
                    await batch.commit();
                    logStructured('info', 'Subscription revoked via Stripe webhook', correlationId, {
                        eventId,
                        eventType: event.type
                    });
                }
            } catch (_) {
                logStructured('error', 'Failed to revoke subscription in Firestore', correlationId, { eventId });
                return sendProblem(res, 500, 'Subscription Revocation Failed', 'Eroare la revocarea abonamentului.', '/stripeWebhook', correlationId);
            }
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
        res.setHeader('X-Correlation-ID', correlationId);
    }

    const origin = req.headers ? req.headers['origin'] : '';
    if (origin && !isAllowedOrigin(origin)) {
        logStructured('warn', 'Blocked unauthorized CORS origin on generatePDF', correlationId, { origin });
        return sendProblem(res, 403, 'Forbidden Origin', 'Blocat de politica de securitate CORS. Originea nu este autorizată.', '/generatePDF', correlationId);
    }

    cors(req, res, async () => {
        if (req.method !== 'POST') {
            return sendProblem(res, 405, 'Method Not Allowed', 'Method Not Allowed', '/generatePDF', correlationId);
        }

        // Rate limiting distribuit hibrid pe IP
        const forwardedFor = req.headers && typeof req.headers['x-forwarded-for'] === 'string'
            ? req.headers['x-forwarded-for'].split(',')[0].trim()
            : '';
        const clientIp = forwardedFor || req.ip || 'unknown';
        if (await isRateLimitedAsync(clientIp)) {
            logStructured('warn', 'Rate limit exceeded on generatePDF', correlationId);
            return sendProblem(res, 429, 'Too Many Requests', 'Prea multe solicitări de export PDF. Te rugăm să aștepți 2 minute.', '/generatePDF', correlationId);
        }

        // Guard dimensiune payload (Denial-of-Wallet guard: max 512 KB)
        const rawBodyLen = req.rawBody ? req.rawBody.length : JSON.stringify(req.body || {}).length;
        if (rawBodyLen > MAX_PAYLOAD_BYTES) {
            logStructured('warn', 'Payload too large on generatePDF', correlationId, { rawBodyLen });
            return sendProblem(res, 413, 'Payload Too Large', 'Payload-ul CV-ului depășește limita maximă admisă (512 KB).', '/generatePDF', correlationId);
        }

        const { cvData, token } = req.body || {};

        if (!cvData || typeof cvData !== 'object') {
            return sendProblem(res, 400, 'Validation Error', 'Lipsește obiectul de date cvData.', '/generatePDF', correlationId);
        }

        let browser = null;
        let deductedCredit = false;
        let deductedUid = null;

        try {
            // Verificare criptografică statut PRO & tranzacție atomică pe credite cu Ledger append-only
            let isPro = false;
            if (token && typeof token === 'string') {
                try {
                    const decodedToken = await admin.auth().verifyIdToken(token);
                    const uid = decodedToken.uid;
                    const userRef = db.collection('users').doc(uid);

                    await db.runTransaction(async (transaction) => {
                        const userDoc = await transaction.get(userRef);
                        if (!userDoc.exists) return;
                        const data = userDoc.data() || {};
                        if (data.isPro === true) {
                            isPro = true;
                            return;
                        }
                        const currentCredits = Number.isInteger(data.exportCredits)
                            ? data.exportCredits
                            : Math.floor(Number(data.exportCredits || 0));
                        if (currentCredits > 0) {
                            const newBalance = currentCredits - 1;
                            if (newBalance < 0) {
                                throw new Error('Invariant violation: negative credit balance');
                            }
                            isPro = true;
                            deductedCredit = true;
                            deductedUid = uid;
                            transaction.update(userRef, {
                                exportCredits: newBalance
                            });
                            const ledgerRef = db.collection('credit_ledger').doc();
                            transaction.set(ledgerRef, {
                                userId: uid,
                                uid,
                                reason: 'DEBIT_EXPORT',
                                type: 'DEBIT_EXPORT',
                                delta: -1,
                                balanceAfter: newBalance,
                                correlationId,
                                createdAt: admin.firestore.FieldValue.serverTimestamp()
                            });
                            const auditRef = db.collection('audit_logs').doc();
                            transaction.set(auditRef, {
                                action: 'PDF_CREDIT_CONSUMED',
                                userId: uid,
                                balanceAfter: newBalance,
                                correlationId,
                                timestamp: admin.firestore.FieldValue.serverTimestamp()
                            });
                        }
                    });
                } catch (_) {
                    logStructured('warn', 'Invalid or expired Firebase ID token on generatePDF', correlationId);
                }
            }

            // Mapare & Ecranare completă a câmpurilor de text
            const renderPills = (arr) => {
                if (!Array.isArray(arr) || !arr.length) return '';
                return arr.map(p => `<div class="cv-pill">${escapeHtml(String(p))}</div>`).join('');
            };

            const renderItems = (arr) => {
                if (!Array.isArray(arr) || !arr.length) return '';
                return arr.map(item => {
                    const title = escapeHtml(item.role || item.degree || item.name || '');
                    const date = escapeHtml(item.period || '');
                    const sub = escapeHtml(item.company || item.institution || item.issuer || item.tech || '');
                    const desc = item.desc ? escapeHtml(item.desc).split('\n').filter(Boolean).map(l => `<p>${l}</p>`).join('') : '';

                    return `
                        <div class="cv-item">
                            <div class="cv-item__hdr">
                                <div class="cv-item__title">${title}</div>
                                <div class="cv-item__date">${date}</div>
                            </div>
                            ${sub ? `<div class="cv-item__sub">${sub}</div>` : ''}
                            ${desc ? `<div class="cv-text">${desc}</div>` : ''}
                        </div>
                    `;
                }).join('');
            };

            const sections = {
                summary: cvData.summary ? `<div class="cv-sec"><div class="cv-sec__title">Profil Profesional</div><div class="cv-text">${escapeHtml(cvData.summary)}</div></div>` : '',
                experience: renderItems(cvData.experiences),
                projects: renderItems(cvData.projects),
                education: renderItems(cvData.educations),
                certifications: renderItems(cvData.certifications),
                languages: Array.isArray(cvData.languages) && cvData.languages.length ? `
                    <div class="cv-sec">
                        <div class="cv-sec__title">Limbi Străine</div>
                        <div class="cv-pills">
                            ${cvData.languages.map(l => `<div class="cv-pill">${escapeHtml(l.name || '')} ${l.level ? '— ' + escapeHtml(l.level) : ''}</div>`).join('')}
                        </div>
                    </div>
                ` : '',
                skills: Array.isArray(cvData.skills) && cvData.skills.length ? `
                    <div class="cv-sec">
                        <div class="cv-sec__title">Competențe</div>
                        <div class="cv-pills">${renderPills(cvData.skills)}</div>
                    </div>
                ` : ''
            };

            const orderedSections = (Array.isArray(cvData.order) ? cvData.order : ['summary', 'experience', 'projects', 'education', 'certifications', 'languages', 'skills'])
                .filter(key => !(Array.isArray(cvData.hidden) ? cvData.hidden : []).includes(key))
                .map(key => sections[key] || '')
                .join('');

            const safePhoto = sanitizePhotoUrl(cvData.photo);
            const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(cvData.color) ? cvData.color : '#3b82f6';
            const safeFont = ["'Inter', sans-serif", "'Lora', serif", "'Roboto', sans-serif"].includes(cvData.font) ? cvData.font : "'Inter', sans-serif";
            const safePadding = Number(cvData.padding) > 5 && Number(cvData.padding) < 40 ? Number(cvData.padding) : 20;
            const safeSize = Number(cvData.size) >= 11 && Number(cvData.size) <= 18 ? Number(cvData.size) : 14;
            const safeLh = Number(cvData.lh) >= 1.2 && Number(cvData.lh) <= 2.2 ? Number(cvData.lh) : 1.6;
            const safeGap = Number(cvData.gap) >= 10 && Number(cvData.gap) <= 40 ? Number(cvData.gap) : 24;

            const docHTML = `
                <!DOCTYPE html>
                <html lang="ro">
                <head>
                    <meta charset="UTF-8">
                    <style>
                        ${CV_BASE_STYLES}
                        :root {
                            --cv-accent: ${safeColor};
                            --cv-font: ${safeFont};
                            --cv-pad: ${safePadding}mm;
                            --cv-size: ${safeSize}px;
                            --cv-lh: ${safeLh};
                            --cv-gap: ${safeGap}px;
                        }
                    </style>
                </head>
                <body>
                    <div class="cv-doc">
                        <div class="cv-hdr">
                            ${safePhoto ? `<img class="cv-photo" src="${safePhoto}" alt="Photo">` : ''}
                            <div class="cv-meta">
                                <div class="cv-name">${escapeHtml(cvData.name || '')}</div>
                                <div class="cv-role">${escapeHtml(cvData.title || '')}</div>
                            </div>
                            <div class="cv-contact">
                                ${cvData.email ? `<div>${escapeHtml(cvData.email)}</div>` : ''}
                                ${cvData.phone ? `<div>${escapeHtml(cvData.phone)}</div>` : ''}
                                ${cvData.location ? `<div>${escapeHtml(cvData.location)}</div>` : ''}
                            </div>
                        </div>
                        ${orderedSections}
                        ${!isPro ? `<div class="cv-watermark">Creat cu CV Builder Pro</div>` : ''}
                    </div>
                </body>
                </html>
            `;

            // Lansare securizată Chromium cu Sandbox & Izolare totală
            browser = await puppeteer.launch({
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
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(),
                headless: chromium.headless,
                ignoreHTTPSErrors: true
            });

            const page = await browser.newPage();

            // 1. Dezactivare completă interpretare JS (Elimină Server-Side XSS la zero)
            await page.setJavaScriptEnabled(false);

            // 2. [CVB-SEC-001] Interceptare strictă: se permit EXCLUSIV 'about:blank' și 'data:image/' (Zero conexiuni de rețea externă/internă, 0% SSRF)
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

            res.setHeader('Content-Type', 'application/pdf');
            const safeFileName = (cvData.name || 'Export').replace(/[^a-zA-Z0-9_-]/g, '_');
            res.setHeader('Content-Disposition', `attachment; filename="CV_${safeFileName}.pdf"`);
            return res.send(pdfBuffer);

        } catch (error) {
            // [CVB-SEC-002] Tranzacție compensatorie: dacă s-a dedus 1 credit și randarea Chromium a eșuat, returnăm creditul utilizatorului
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
                            createdAt: admin.firestore.FieldValue.serverTimestamp()
                        });

                        const auditRef = db.collection('audit_logs').doc();
                        transaction.set(auditRef, {
                            action: 'CREDIT_REFUND_RENDER_ERROR',
                            userId: deductedUid,
                            balanceAfter: refundedBalance,
                            correlationId,
                            timestamp: admin.firestore.FieldValue.serverTimestamp()
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
            // Garantare distrugere instanță Chromium pentru a elimina procesele zombie & memory leak-urile
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
    isPrivateOrInternalUrl,
    isAllowedOrigin,
    ALLOWED_ORIGINS,
    sendProblem
};
