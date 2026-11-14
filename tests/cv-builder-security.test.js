// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const securityCore = require('../functions/security-core.js');
const {
    sanitizePhotoUrl,
    isPrivateOrInternalUrl,
    isAllowedOrigin,
    validateBrowserRequestOrigin,
    extractClientIp,
    hashRateLimitKey,
    safeHttpUrl,
    validateAndSanitizeCvData,
    maskIdentifier,
    evaluateStripeCheckoutSession,
    sendProblem,
    handleHealthz
} = securityCore;
const functionsEntry = require('../functions/index.js');

test('1. [CVB-SEC-001] Blocare SSRF si DNS Rebinding (nip.io) + acceptare data:image/png;base64 cu Magic Bytes valide', () => {
    // 1x1 transparent PNG in base64 (valid PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A)
    const validPngDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    assert.equal(sanitizePhotoUrl(validPngDataUri), validPngDataUri, 'Trebuie sa accepte data:image/png;base64 cu magic bytes valide');

    // Fake base64 without PNG magic bytes
    const invalidMagicPng = 'data:image/png;base64,SGVsbG9Xb3JsZFRoaXNJc05vdEFQbmc=';
    assert.equal(sanitizePhotoUrl(invalidMagicPng), '', 'Trebuie sa respinga data:image/png fara semnatura binara PNG');

    // DNS Rebinding & Cloud Metadata SSRF attempts
    assert.equal(sanitizePhotoUrl('https://169.254.169.254.nip.io/latest/meta-data/'), '', 'Trebuie sa blocheze URL-ul DNS rebinding nip.io');
    assert.equal(sanitizePhotoUrl('http://169.254.169.254/computeMetadata/v1/'), '', 'Trebuie sa blocheze metadata GCP');
    assert.equal(isPrivateOrInternalUrl('https://169.254.169.254.nip.io/latest/meta-data/'), true, 'isPrivateOrInternalUrl trebuie sa detecteze nip.io');
    assert.equal(isPrivateOrInternalUrl('https://10.0.0.1.sslip.io/admin'), true, 'isPrivateOrInternalUrl trebuie sa detecteze sslip.io');
});

test('2. [CVB-SEC-003] Respingere CORS pentru origini Firebase straine (https://attacker-app.web.app)', () => {
    assert.equal(isAllowedOrigin('https://cvsmartats.web.app'), true);
    assert.equal(isAllowedOrigin('https://cvsmartats.firebaseapp.com'), true);
    assert.equal(isAllowedOrigin('http://localhost:5000'), true);

    assert.equal(isAllowedOrigin('https://attacker-app.web.app'), false, 'Trebuie sa respinga subdomenii .web.app neautorizate');
    assert.equal(isAllowedOrigin('https://evil-tenant.firebaseapp.com'), false, 'Trebuie sa respinga subdomenii .firebaseapp.com neautorizate');
    assert.equal(isAllowedOrigin('https://evil.example.com'), false);
});

test('3. [CVB-SEC-003] Absenta activarii directe isPro = true la ?session_id= in public/app.js', () => {
    const appJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'app.js'), 'utf8');
    const stripeReturnMatch = appJs.match(/checkStripeReturn\s*:\s*function\s*\(\)\s*\{[\s\S]*?\n                \},/);
    assert.ok(stripeReturnMatch, 'Functia checkStripeReturn trebuie sa existe in public/app.js');

    const stripeReturnBody = stripeReturnMatch[0];
    assert.ok(!/this\.isPro\s*=\s*true/.test(stripeReturnBody), 'checkStripeReturn NU trebuie sa seteze direct this.isPro = true pe client');
    assert.ok(!/state\.isPro\s*=\s*true/.test(stripeReturnBody), 'checkStripeReturn NU trebuie sa seteze direct state.isPro = true pe client');
    assert.ok(!/localStorage\.setItem\(\s*['"]cvpro_pro['"]\s*,\s*['"]1['"]\s*\)/.test(stripeReturnBody), 'checkStripeReturn NU trebuie sa scrie cvpro_pro=1 fara verificare server');
});

test('4. [CVB-SEC-002 & ETAPA 3.2] Prezenta customer.subscription.deleted, CREDIT_REFUND_RENDER_ERROR si RFC 7807 in functions/', () => {
    const fnCode = fs.readFileSync(path.join(ROOT_DIR, 'functions', 'index.js'), 'utf8') +
        '\n' +
        fs.readFileSync(path.join(ROOT_DIR, 'functions', 'security-core.js'), 'utf8');
    assert.ok(fnCode.includes('customer.subscription.deleted'), 'Trebuie sa trateze customer.subscription.deleted');
    assert.ok(fnCode.includes('invoice.payment_failed'), 'Trebuie sa trateze invoice.payment_failed');
    assert.ok(fnCode.includes("sessionObj.payment_status !== 'paid'"), 'Trebuie sa verifice payment_status === paid');
    assert.ok(fnCode.includes('CREDIT_REFUND_RENDER_ERROR'), 'Trebuie sa implementeze tranzactia de refund la eroare Puppeteer');
    assert.ok(fnCode.includes('application/problem+json'), 'Trebuie sa foloseasca RFC 7807 application/problem+json');
});

test('5. [ETAPA 3.2] Endpoint-ul exports.healthz si helperul sendProblem functioneaza conform RFC 7807', () => {
    const headers = {};
    let statusCode = 200;
    let bodyPayload = null;
    const mockRes = {
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        status(c) { statusCode = c; return this; },
        json(p) { bodyPayload = p; return this; }
    };

    handleHealthz({ method: 'GET', headers: { 'x-correlation-id': 'test_corr_healthz_01' } }, mockRes);
    assert.equal(statusCode, 200);
    assert.equal(headers['cache-control'], 'private, no-store, max-age=0');
    assert.equal(headers['x-correlation-id'], 'test_corr_healthz_01');
    assert.equal(bodyPayload.status, 'ok');
    assert.equal(bodyPayload.service, 'cv-builder-ats');

    const probHeaders = {};
    let probStatus = 200;
    let probBody = null;
    const mockProbRes = {
        setHeader(k, v) { probHeaders[k.toLowerCase()] = v; },
        status(c) { probStatus = c; return this; },
        json(p) { probBody = p; return this; }
    };
    sendProblem(mockProbRes, 403, 'Forbidden Origin', 'Origine interzisa', '/generatePDF', 'corr_prob_403');
    assert.equal(probStatus, 403);
    assert.equal(probHeaders['content-type'], 'application/problem+json');
    assert.equal(probHeaders['cache-control'], 'private, no-store, max-age=0');
    assert.equal(probBody.status, 403);
    assert.equal(probBody.error, 'Origine interzisa');
});

test('6. [CVB-SEC-001b] Blocare IPv6 hex mapped SSRF & normalizare safeHttpUrl', () => {
    assert.equal(isPrivateOrInternalUrl('http://[::ffff:a9fe:a9fe]/latest/meta-data/'), true, 'Trebuie sa blocheze ::ffff:a9fe:a9fe');
    assert.equal(isPrivateOrInternalUrl('http://[::ffff:7f00:1]/'), true, 'Trebuie sa blocheze ::ffff:7f00:1');
    assert.equal(safeHttpUrl('java\tscript:alert(1)'), '', 'Trebuie sa blocheze scheme smuggling cu control chars');
    assert.equal(safeHttpUrl('//evil.example.com/phish'), '', 'Trebuie sa blocheze URL protocol-relative');
    assert.equal(safeHttpUrl('https://user:pass@evil.example.com/'), '', 'Trebuie sa blocheze credentials in URL');
    assert.equal(safeHttpUrl('linkedin.com/in/tiberiu'), 'https://linkedin.com/in/tiberiu');
});

test('7. [CVB-SEC-004] Validare Origin/Fetch pe POST + extractClientIp anti-XFF-spoofing + hashRateLimitKey', () => {
    assert.equal(validateBrowserRequestOrigin({ headers: {} }).allowed, false, 'POST fara Origin sau Sec-Fetch-Site trebuie respins');
    assert.equal(validateBrowserRequestOrigin({ headers: { 'sec-fetch-site': 'same-origin' } }).allowed, true);
    assert.equal(validateBrowserRequestOrigin({ headers: { origin: 'https://attacker-app.web.app' } }).allowed, false);
    assert.equal(validateBrowserRequestOrigin({ headers: { origin: 'https://cvsmartats.web.app' } }).allowed, true);

    const resolvedIp = extractClientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.42' } });
    assert.equal(resolvedIp, '198.51.100.42', 'extractClientIp trebuie sa ia IP-ul adaugat spre dreapta');

    const bucketHash = hashRateLimitKey(resolvedIp);
    assert.match(bucketHash, /^[0-9a-f]{32}$/);
    assert.ok(!bucketHash.includes(resolvedIp), 'Cheia de rate-limit nu trebuie sa expuna IP-ul brut');
});

test('8. [CVB-SEC-005] Sanitare payload CV (font/culoare/lista/photo SSRF) si mascare PII audit', () => {
    assert.equal(validateAndSanitizeCvData([]), null);
    const cleaned = validateAndSanitizeCvData({
        name: 'Ion Popescu',
        font: 'Georgia, serif',
        color: 'expression(alert(1))',
        photo: 'http://169.254.169.254/latest/meta-data/',
        linkedin: 'javascript:alert(1)',
        skills: Array.from({ length: 100 }, (_, i) => `Skill ${i}`)
    });
    assert.ok(cleaned);
    assert.equal(cleaned.font, 'Georgia, serif');
    assert.equal(cleaned.color, '#3b82f6');
    assert.equal(cleaned.photo, '');
    assert.equal(cleaned.linkedin, '');
    assert.equal(cleaned.skills.length, 60);

    const masked = maskIdentifier('cus_1234567890abcdef');
    assert.equal(masked, 'cus_1***cdef');
    assert.equal(maskIdentifier('short'), '***');
});

test('9. [CVB-SEC-006] evaluateStripeCheckoutSession & getStripeClient fail-closed', () => {
    assert.equal(evaluateStripeCheckoutSession({ payment_status: 'unpaid', mode: 'subscription', currency: 'eur', amount_total: 500 }).ok, false);
    assert.equal(evaluateStripeCheckoutSession({ payment_status: 'paid', mode: 'subscription', currency: 'ron', amount_total: 500 }).ok, false);
    assert.equal(evaluateStripeCheckoutSession({ payment_status: 'paid', mode: 'subscription', currency: 'eur', amount_total: 499 }).ok, false);
    assert.equal(evaluateStripeCheckoutSession({ payment_status: 'paid', mode: 'payment', currency: 'eur', amount_total: 299 }).ok, false);

    const validSub = evaluateStripeCheckoutSession({
        payment_status: 'paid',
        mode: 'subscription',
        currency: 'eur',
        amount_total: 500,
        client_reference_id: 'uid_123',
        customer: 'cus_abc',
        subscription: 'sub_xyz'
    });
    assert.equal(validSub.ok, true);
    assert.equal(validSub.isSubscription, true);

    const validOneTime = evaluateStripeCheckoutSession({
        payment_status: 'paid',
        mode: 'payment',
        currency: 'eur',
        amount_total: 300,
        customer_details: { email: 'USER@Example.COM' },
        customer: 'cus_def'
    });
    assert.equal(validOneTime.ok, true);
    assert.equal(validOneTime.isSubscription, false);
    assert.equal(validOneTime.customerEmail, 'user@example.com');

    const prevKey = process.env.STRIPE_SECRET_KEY;
    try {
        delete process.env.STRIPE_SECRET_KEY;
        assert.throws(() => functionsEntry.__test__.getStripeClient(), /STRIPE_SECRET_KEY/);
        process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder_123';
        assert.throws(() => functionsEntry.__test__.getStripeClient(), /STRIPE_SECRET_KEY/);
    } finally {
        if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
        else process.env.STRIPE_SECRET_KEY = prevKey;
    }
});

test('10. [CVB-CONF-001] Hardening Firebase Hosting, Firestore Rules si CSP', () => {
    const firebaseConfig = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'firebase.json'), 'utf8'));
    const rewrites = firebaseConfig.hosting?.rewrites || [];
    assert.ok(rewrites.some((r) => r.source === '/api/generate-pdf' && r.function === 'generatePDF'));
    assert.ok(rewrites.some((r) => r.source === '/api/stripe-webhook' && r.function === 'stripeWebhook'));

    const allHeaderEntries = (firebaseConfig.hosting?.headers || []).flatMap((h) => h.headers || []);
    const headerMap = new Map(allHeaderEntries.map((h) => [h.key, h.value]));
    assert.equal(headerMap.get('X-XSS-Protection'), '0');
    assert.equal(headerMap.get('Cross-Origin-Opener-Policy'), 'same-origin-allow-popups');
    const csp = headerMap.get('Content-Security-Policy') || '';
    assert.ok(!csp.includes('cdnjs.cloudflare.com'));
    assert.ok(csp.includes("form-action 'self' https://checkout.stripe.com https://buy.stripe.com"));

    const rules = fs.readFileSync(path.join(ROOT_DIR, 'firestore.rules'), 'utf8');
    assert.ok(rules.includes('match /processed_stripe_events/{eventId}'));
    assert.ok(rules.includes('match /audit_logs/{logId}'));
    assert.ok(rules.includes('cvData is map'));
});

test('11. [CVB-UI-001] Hardening Client SPA (DOMPurify local, zero fallback cvpro_pro, pret aliniat 3 EUR)', () => {
    assert.ok(fs.statSync(path.join(ROOT_DIR, 'public', 'vendor', 'purify.min.js')).size > 1000);

    const html = fs.readFileSync(path.join(ROOT_DIR, 'public', 'index.html'), 'utf8');
    assert.ok(html.includes('vendor/purify.min.js'));
    assert.ok(!html.includes('cdnjs.cloudflare.com'));
    assert.ok(!html.includes('apple-mobile-web-app-capable'));
    assert.ok(!html.includes('1.50 EUR'));
    assert.ok(html.includes('id="privacyModal"'));
    assert.ok(html.includes('class="skip-link"'));

    const appJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'app.js'), 'utf8');
    assert.ok(!appJs.includes("localStorage.getItem('cvpro_pro')"));
    assert.ok(!appJs.includes("localStorage.setItem('cvpro_pro'"));
    assert.ok(appJs.includes("'/api/generate-pdf'"));
    assert.ok(!appJs.includes('eur3-cvsmartats.cloudfunctions.net'));
    assert.ok(!/domeniultau\.ro/i.test(html), 'public/index.html nu trebuie sa contina domeniul placeholder domeniultau.ro');
    assert.ok(!/domeniultau\.ro/i.test(appJs), 'public/app.js nu trebuie sa contina domeniul placeholder domeniultau.ro');
    assert.ok(appJs.includes('if (!firebaseReady) {'), 'Checkout-ul Stripe trebuie sa blocheze redirectionarea cand Firebase nu este configurat');
});
