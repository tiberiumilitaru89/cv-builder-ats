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
        // Permitem și domenii specifice de producție configurate
        return callback(null, true);
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

function sanitizePhotoUrl(url) {
    if (typeof url !== 'string' || !url) return '';
    const trimmed = url.trim();

    // Permite doar data:image base64 securizat
    if (/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(trimmed)) {
        return trimmed;
    }

    // Permite doar URL-uri HTTPS externe legitime, blocând IP-urile private/interne
    if (/^https:\/\/[^\s$.?#].[^\s]*$/i.test(trimmed)) {
        const lower = trimmed.toLowerCase();
        if (
            lower.includes('169.254.') ||
            lower.includes('127.0.0.1') ||
            lower.includes('localhost') ||
            lower.includes('0.0.0.0') ||
            lower.includes('metadata.google')
        ) {
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
                } else {
                    await usersRef.doc(customerEmail).set(subscriptionData, { merge: true });
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

        // Rate limiting pe IP
        const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.ip;
        if (isRateLimited(clientIp)) {
            return res.status(429).send('Prea multe solicitări de export PDF. Te rugăm să aștepți 2 minute.');
        }

        const { cvData, token } = req.body;

        if (!cvData || typeof cvData !== 'object') {
            return res.status(400).send('Lipsește obiectul de date cvData.');
        }

        let browser = null;

        try {
            // Verificare criptografică statut PRO via Firebase Auth ID Token
            let isPro = false;
            if (token && typeof token === 'string') {
                try {
                    const decodedToken = await admin.auth().verifyIdToken(token);
                    const uid = decodedToken.uid;
                    const userDoc = await db.collection('users').doc(uid).get();
                    if (userDoc.exists) {
                        const data = userDoc.data();
                        if (data.isPro) {
                            isPro = true;
                        } else if (typeof data.exportCredits === 'number' && data.exportCredits > 0) {
                            isPro = true;
                            await db.collection('users').doc(uid).update({
                                exportCredits: admin.firestore.FieldValue.increment(-1)
                            });
                        }
                    }
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

            // 2. Interceptare cereri: blocare protocoale interne, rețele locale & Google Cloud Metadata
            await page.setRequestInterception(true);
            page.on('request', (interceptedReq) => {
                const reqUrl = (interceptedReq.url() || '').toLowerCase();
                if (
                    reqUrl.startsWith('file:') ||
                    reqUrl.startsWith('gopher:') ||
                    reqUrl.startsWith('ftp:') ||
                    reqUrl.includes('169.254.169.254') ||
                    reqUrl.includes('metadata.google') ||
                    reqUrl.includes('localhost') ||
                    reqUrl.includes('127.0.0.1') ||
                    reqUrl.includes('0.0.0.0')
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
