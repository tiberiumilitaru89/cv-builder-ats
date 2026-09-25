const functions = require('firebase-functions');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Cheia secreta este preluata din mediul de rulare
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

// Restrictionam cererile doar la domeniile permise pentru a preveni utilizarea neautorizata
const allowedOrigins = [
    'https://domeniultau.ro', 
    'http://localhost:5000', 
    'http://127.0.0.1:5000', 
    'http://127.0.0.1:8080', 
    'http://localhost:8080',
    /https:\/\/.*\.web\.app$/, 
    /https:\/\/.*\.firebaseapp\.com$/
];
const cors = require('cors')({ origin: allowedOrigins });

const { getFirestore } = require("firebase-admin/firestore");

admin.initializeApp();
const db = getFirestore();

// 1. Stripe Webhook pentru activare cont PRO în timp real
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // Cheia secreta pentru webhook este preluata din mediul de rulare

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const customerEmail = session.customer_details.email;
        
        // Căutăm ID-ul trimis de la client
        const firebaseUid = session.client_reference_id;
        
        const usersRef = db.collection('users');
        const isSubscription = session.mode === 'subscription';
        
        const subscriptionData = {
            stripeCustomerId: session.customer,
            proActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
            email: customerEmail // Salvăm oricum email-ul pentru backup
        };
        
        if (isSubscription) {
            subscriptionData.isPro = true;
            subscriptionData.subscriptionId = session.subscription;
        } else {
            subscriptionData.exportCredits = admin.firestore.FieldValue.increment(1);
        }
        
        // Salvăm sigur pe baza de UID din Firebase pentru a lega plata direct la contul logat
        if (firebaseUid) {
            await usersRef.doc(firebaseUid).set(subscriptionData, { merge: true });
        } else if (customerEmail) {
            // Fallback (dacă s-a pierdut referința, se face matching pe email)
            const snapshot = await usersRef.where('email', '==', customerEmail).get();
            if (!snapshot.empty) {
                snapshot.forEach(async (doc) => {
                    await usersRef.doc(doc.id).set(subscriptionData, { merge: true });
                });
            } else {
                await usersRef.doc(customerEmail).set(subscriptionData, { merge: true });
            }
        }
    }

    res.json({ received: true });
});

// 2. Funcție generare PDF Ultra-Securizată (Fără watermark doar pentru PRO autentificați)
exports.generatePDF = functions.runWith({ memory: '2GB', timeoutSeconds: 60 }).https.onRequest((req, res) => {
    cors(req, res, async () => {
        if (req.method !== 'POST') {
            return res.status(405).send('Method Not Allowed');
        }

        const { cvData, token } = req.body;

        if (!cvData) {
            return res.status(400).send('Lipsește obiectul de date cvData.');
        }

        try {
            let isPro = false;
            if (token) {
                try {
                    const decodedToken = await admin.auth().verifyIdToken(token);
                    const uid = decodedToken.uid;
                    const userDoc = await db.collection('users').doc(uid).get();
                    if (userDoc.exists) {
                        const data = userDoc.data();
                        if (data.isPro) {
                            isPro = true;
                        } else if (data.exportCredits > 0) {
                            isPro = true;
                            await db.collection('users').doc(uid).update({
                                exportCredits: admin.firestore.FieldValue.increment(-1)
                            });
                        }
                    }
                } catch(e) {
                    console.error("Token invalid:", e.message);
                }
            }

            const origin = req.headers.origin || 'http://localhost:5000';

            // GENERARE LAYOUT DINAMIC DIRECT PE SERVER PE BAZA TEXTELOR PRIMITE
            const renderPills = (arr) => arr && arr.length ? arr.map(p => `<div class="cv-pill">${p}</div>`).join('') : '';
            const renderItems = (arr, subField) => arr && arr.length ? arr.map(item => `
                <div class="cv-item">
                    <div class="cv-item__hdr">
                        <div class="cv-item__title">${item.role || item.degree || item.name || ''}</div>
                        <div class="cv-item__date">${item.period || ''}</div>
                    </div>
                    <div class="cv-item__sub">${item.company || item.institution || item.issuer || item.tech || ''}</div>
                    ${item.desc ? `<div class="cv-text">${item.desc.split('\n').map(l => `<p>${l}</p>`).join('')}</div>` : ''}
                </div>
            `).join('') : '';

            // Maparea ordonării secțiunilor alese de utilizator
            const sections = {
                summary: cvData.summary ? `<div class="cv-sec"><div class="cv-sec__title">Profil Profesional</div><div class="cv-text">${cvData.summary}</div></div>` : '',
                experience: renderItems(cvData.experiences),
                projects: renderItems(cvData.projects),
                education: renderItems(cvData.educations),
                certifications: renderItems(cvData.certifications),
                languages: cvData.languages && cvData.languages.length ? `<div class="cv-sec"><div class="cv-sec__title">Limbi Străine</div><div class="cv-pills">${cvData.languages.map(l => `<div class="cv-pill">${l.name} ${l.level ? '— ' + l.level : ''}</div>`).join('')}</div></div>` : '',
                skills: cvData.skills && cvData.skills.length ? `<div class="cv-sec"><div class="cv-sec__title">Competențe</div><div class="cv-pills">${renderPills(cvData.skills)}</div></div>` : ''
            };

            const orderedSections = (cvData.order || [])
                .filter(key => !(cvData.hidden || []).includes(key))
                .map(key => sections[key] || '')
                .join('');

            const docHTML = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
                    <link rel="stylesheet" href="${origin}/styles.css">
                    <style>
                        :root {
                            --cv-accent: ${cvData.color || '#3b82f6'};
                            --cv-font: ${cvData.font || "'Inter', sans-serif"};
                            --cv-pad: ${cvData.padding || 20}mm;
                            --cv-size: ${cvData.size || 14}px;
                            --cv-lh: ${cvData.lh || 1.6};
                            --cv-gap: ${cvData.gap || 24}px;
                        }
                        body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                        .cv-doc { border: none !important; box-shadow: none !important; margin: 0 !important; max-width: 100% !important; min-height: 100vh !important; padding: var(--cv-pad); font-family: var(--cv-font); font-size: var(--cv-size); line-height: var(--cv-lh); }
                    </style>
                </head>
                <body>
                    <div class="cv-doc">
                        <div class="cv-hdr">
                            ${cvData.photo ? `<img class="cv-photo" src="${cvData.photo}" style="display:block;">` : ''}
                            <div class="cv-meta">
                                <div class="cv-name">${cvData.name || ''}</div>
                                <div class="cv-role">${cvData.title || ''}</div>
                            </div>
                            <div class="cv-contact">
                                ${cvData.email ? `<div>${cvData.email}</div>` : ''}
                                ${cvData.phone ? `<div>${cvData.phone}</div>` : ''}
                                ${cvData.location ? `<div>${cvData.location}</div>` : ''}
                            </div>
                        </div>
                        ${orderedSections}
                        ${!isPro ? `<div class="cv-watermark">Creat cu CV Builder Pro | domeniultau.ro</div>` : ''}
                    </div>
                </body>
                </html>
            `;

            const browser = await puppeteer.launch({
                args: chromium.args,
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(),
                headless: chromium.headless,
                ignoreHTTPSErrors: true
            });
            
            const page = await browser.newPage();
            await page.setContent(docHTML, { waitUntil: 'networkidle0' });
            
            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' }
            });

            await browser.close();

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="CV_${(cvData.name || 'Export').replace(/\\s+/g, '_')}.pdf"`);
            res.send(pdfBuffer);
            
        } catch (error) {
            console.error("Eroare server la generarea PDF:", error);
            res.status(500).send("A apărut o eroare la generarea PDF-ului.");
        }
    });
});
