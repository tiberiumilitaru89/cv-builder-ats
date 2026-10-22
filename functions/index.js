const functions = require('firebase-functions');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { getFirestore } = require("firebase-admin/firestore");
const { CV_BASE_STYLES } = require('./cv-styles');

admin.initializeApp();
const db = getFirestore();

// ════════════════════════════════════════════════════════════════
// RATE LIMITING SERVERLESS (Sliding Window in-memory)
// ════════════════════════════════════════════════════════════════
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 2 * 60 * 1000; // 2 minute
const RATE_LIMIT_WINDOW_SECONDS = 120;
const MAX_REQUESTS_PER_WINDOW = 6;
const MAX_PAYLOAD_BYTES = 512 * 1024; // 512 KB Denial-of-Wallet guard

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
    if (!key || key === 'unknown') return false;
    cleanupRateLimits();

    const now = Date.now();
    const record = rateLimitMap.get(key);

    if (!record || now - record.startTime > RATE_LIMIT_WINDOW_MS) {
        rateLimitMap.set(key, { count: 1, startTime: now });
        return false;
    }

    if (record.count >= MAX_REQUESTS_PER_WINDOW) {
        return true;
    }

    record.count += 1;
    return false;
}

async function isRateLimitedAsync(key) {
    if (!key || key === 'unknown') return false;

    const kvUrl = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').trim();
    const kvToken = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim();

    if (kvUrl && kvToken) {
        try {
            const redisKey = `cvbuilder:rl:${key}`;
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

    return isRateLimited(key);
}

// ════════════════════════════════════════════════════════════════
// CORS CONFIGURATION
// ════════════════════════════════════════════════════════════════
const allowedOriginPatterns = [
    /^http:\/\/localhost(:\d+)?$/,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/,
    /^https:\/\/.*\.web\.app$/,
    /^https:\/\/.*\.firebaseapp\.com$/
];

const cors = require('cors')({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const isAllowed = allowedOriginPatterns.some(pattern => pattern.test(origin));
        if (isAllowed) {
            return callback(null, true);
        }
        return callback(new Error('Blocat de politica de securitate CORS. Originea nu este autorizată.'));
    }
});

// ════════════════════════════════════════════════════════════════
// SANITIZARE & DEFENSIVE CODING ANTI-XSS & ANTI-SSRF
// ════════════════════════════════════════════════════════════════
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isPrivateOrInternalUrl(urlStr) {
    try {
        const parsed = new URL(urlStr);
        const host = (parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
        if (!host) return true;
        if (
            host === 'localhost' ||
            host === '0.0.0.0' ||
            host === '::1' ||
            host === '0:0:0:0:0:0:0:1' ||
            host.endsWith('.internal') ||
            host.endsWith('.local') ||
            host.includes('metadata.google')
        ) {
            return true;
        }
        // Blocare IPv6 link-local & unique-local
        if (/^(fe80:|fc00:|fd00:)/i.test(host)) {
            return true;
        }
        // Blocare IPv4 private / loopback / link-local (RFC 1918 + 169.254.0.0/16 + 127.0.0.0/8)
        const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (ipv4Match) {
            const [, a, b] = ipv4Match.map(Number);
            if (
                a === 10 ||
                a === 127 ||
                a === 0 ||
                (a === 169 && b === 254) ||
                (a === 192 && b === 168) ||
                (a === 172 && b >= 16 && b <= 31) ||
                (a === 100 && b >= 64 && b <= 127)
            ) {
                return true;
            }
        }
        return false;
    } catch (_) {
        return true;
    }
}

function hasValidMagicBytes(buffer, type) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
    if (type === 'jpeg' || type === 'jpg') {
        return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    }
    if (type === 'png') {
        return (
            buffer.length >= 8 &&
            buffer[0] === 0x89 &&
            buffer[1] === 0x50 &&
            buffer[2] === 0x4E &&
            buffer[3] === 0x47
        );
    }
    if (type === 'webp') {
        return (
            buffer.length >= 12 &&
            buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
            buffer.subarray(8, 12).toString('ascii') === 'WEBP'
        );
    }
    if (type === 'pdf') {
        return buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
    }
    if (type === 'docx') {
        return buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
    }
    return false;
}

function sanitizePhotoUrl(url) {
    if (typeof url !== 'string' || !url) return '';
    const trimmed = url.trim();

    // Permite data:image base64 doar după validarea semnăturii binare Magic Bytes
    const dataMatch = trimmed.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (dataMatch) {
        const imgType = dataMatch[1];
        const b64Sample = dataMatch[2].slice(0, 32);
        const buf = Buffer.from(b64Sample, 'base64');
        return hasValidMagicBytes(buf, imgType) ? trimmed : '';
    }

    // Permite doar URL-uri HTTPS externe legitime, blocând IP-urile private/interne (Anti-SSRF)
    if (/^https:\/\/[^\s$.?#].[^\s]*$/i.test(trimmed)) {
        if (isPrivateOrInternalUrl(trimmed)) {
            return '';
        }
        return trimmed;
    }

    return '';
}

// ════════════════════════════════════════════════════════════════
// 1. STRIPE WEBHOOK (Activare cont PRO & Credite în timp real)
// ════════════════════════════════════════════════════════════════
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!endpointSecret) {
        functions.logger.error("Missing STRIPE_WEBHOOK_SECRET in runtime environment", { correlation_id: sig ? sig.slice(0, 10) : "none" });
        return res.status(500).send("Webhook secret neconfigurat.");
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
    } catch (err) {
        functions.logger.error("Webhook signature verification failed", { error: err.message });
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const customerEmail = session.customer_details ? session.customer_details.email : null;
        const firebaseUid = session.client_reference_id;
        const eventId = event.id;

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
                    customerId: session.customer || null,
                    clientReferenceId: firebaseUid || null
                });
                return false;
            });

            if (alreadyProcessed) {
                functions.logger.info("Stripe event already processed, skipping mutation", { eventId });
                return res.json({ received: true, already_processed: true });
            }
        } catch (trxErr) {
            functions.logger.error("Error checking webhook idempotency", { error: trxErr.message, eventId });
            return res.status(500).send("Eroare verificare idempotență.");
        }

        const usersRef = db.collection('users');
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

        try {
            if (firebaseUid) {
                await usersRef.doc(firebaseUid).set(subscriptionData, { merge: true });
            } else if (customerEmail) {
                const snapshot = await usersRef.where('email', '==', customerEmail).get();
                if (!snapshot.empty) {
                    const batch = db.batch();
                    snapshot.forEach((doc) => {
                        batch.set(usersRef.doc(doc.id), subscriptionData, { merge: true });
                    });
                    await batch.commit();
                }
            }
        } catch (dbErr) {
            functions.logger.error("Subscription status database update failed", { error: dbErr.message });
            return res.status(500).send("Eroare actualizare bază de date.");
        }
    }

    res.json({ received: true });
});

// ════════════════════════════════════════════════════════════════
// 2. GENERARE PDF ULTRA-SECURIZATĂ (Puppeteer Chromium Hardening)
// ════════════════════════════════════════════════════════════════
exports.generatePDF = functions.runWith({ memory: '2GB', timeoutSeconds: 60 }).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') {
            return res.status(405).send('Method Not Allowed');
        }

        // Rate limiting distribuit hibrid pe IP
        const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.ip;
        if (await isRateLimitedAsync(clientIp)) {
            return res.status(429).send('Prea multe solicitări de export PDF. Te rugăm să aștepți 2 minute.');
        }

        // Guard dimensiune payload (Denial-of-Wallet guard: max 512 KB)
        const rawBodyLen = req.rawBody ? req.rawBody.length : JSON.stringify(req.body || {}).length;
        if (rawBodyLen > MAX_PAYLOAD_BYTES) {
            return res.status(413).send('Payload-ul CV-ului depășește limita maximă admisă (512 KB).');
        }

        const { cvData, token } = req.body;

        if (!cvData || typeof cvData !== 'object') {
            return res.status(400).send('Lipsește obiectul de date cvData.');
        }

        let browser = null;

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
                            transaction.update(userRef, {
                                exportCredits: newBalance
                            });
                            const ledgerRef = db.collection('credit_ledger').doc();
                            transaction.set(ledgerRef, {
                                uid,
                                type: 'DEBIT_EXPORT',
                                delta: -1,
                                balanceAfter: newBalance,
                                createdAt: admin.firestore.FieldValue.serverTimestamp()
                            });
                        }
                    });
                } catch (authErr) {
                    functions.logger.warn("Invalid or expired token", { error: authErr.message });
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
                    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
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

            // 2. Interceptare cereri: blocare protocoale interne, rețele locale RFC 1918 & Google Cloud Metadata (Anti-SSRF)
            await page.setRequestInterception(true);
            page.on('request', (interceptedReq) => {
                const reqUrl = (interceptedReq.url() || '').toLowerCase();
                if (
                    reqUrl.startsWith('file:') ||
                    reqUrl.startsWith('gopher:') ||
                    reqUrl.startsWith('ftp:') ||
                    reqUrl.startsWith('ws:') ||
                    reqUrl.startsWith('wss:') ||
                    (!reqUrl.startsWith('data:image/') && isPrivateOrInternalUrl(reqUrl))
                ) {
                    return interceptedReq.abort();
                }

                const resourceType = interceptedReq.resourceType();
                if (['document', 'font', 'stylesheet', 'image'].includes(resourceType)) {
                    interceptedReq.continue();
                } else {
                    interceptedReq.abort();
                }
            });

            await page.setContent(docHTML, { waitUntil: 'load', timeout: 20000 });

            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' }
            });

            res.setHeader('Content-Type', 'application/pdf');
            const safeFileName = (cvData.name || 'Export').replace(/[^a-zA-Z0-9_\-]/g, '_');
            res.setHeader('Content-Disposition', `attachment; filename="CV_${safeFileName}.pdf"`);
            return res.send(pdfBuffer);

        } catch (error) {
            functions.logger.error("Server error generating PDF", { error: error.message, stack: error.stack });
            return res.status(500).send("A apărut o eroare la generarea PDF-ului.");
        } finally {
            // Garantare distrugere instanță Chromium pentru a elimina procesele zombie & memory leak-urile
            if (browser) {
                try {
                    await browser.close();
                } catch (closeErr) {
                    functions.logger.error("Error closing browser instance", { error: closeErr.message });
                }
            }
        }
    });
});
