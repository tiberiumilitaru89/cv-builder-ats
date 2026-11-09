// @ts-check
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const securityCore = require('../functions/security-core.js');
const { sanitizePhotoUrl, isPrivateOrInternalUrl, isAllowedOrigin, sendProblem, handleHealthz } = securityCore;

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
    assert.equal(headers['cache-control'], 'no-store');
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
    assert.equal(probBody.status, 403);
    assert.equal(probBody.error, 'Origine interzisa');
});
