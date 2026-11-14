// @ts-check
/**
 * Pure domain & security module for CV Builder ATS Cloud Functions.
 * Zero external runtime dependencies — shared directly between functions/index.js and tests.
 */
const crypto = require('node:crypto');

const CORRELATION_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_PHOTO_DATA_URI_LENGTH = Math.floor(2.5 * 1024 * 1024); // 2.5 MB
const MAX_PAYLOAD_BYTES = 512 * 1024; // 512 KB Denial-of-Wallet guard

const ALLOWED_CV_FONTS = new Set([
    "'Inter', sans-serif",
    "'Roboto', sans-serif",
    "'Lora', serif",
    'Georgia, serif'
]);

const ALLOWED_CV_SECTIONS = [
    'summary',
    'experience',
    'projects',
    'education',
    'certifications',
    'languages',
    'skills'
];

const ALLOWED_ORIGINS = new Set([
    'https://cvsmartats.web.app',
    'https://cvsmartats.firebaseapp.com',
    'https://cv-builder-ats-2026.web.app',
    'https://cv-builder-ats-2026.firebaseapp.com',
    'http://localhost:5000',
    'http://127.0.0.1:5000'
]);

/**
 * Generates or propagates a sanitized correlation ID using CSPRNG.
 * @param {any} req
 * @param {string} [prefix]
 * @returns {string}
 */
function getCorrelationId(req, prefix = 'cvb') {
    const rawHeader = req && req.headers ? req.headers['x-correlation-id'] : '';
    const incoming = typeof rawHeader === 'string' ? rawHeader.trim() : '';
    if (CORRELATION_ID_REGEX.test(incoming)) {
        return incoming;
    }
    const cleanPrefix = String(prefix || 'cvb').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'cvb';
    return `${cleanPrefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Emits an RFC 7807 Problem Details JSON response with private no-store caching.
 * @param {any} res
 * @param {number} status
 * @param {string} title
 * @param {string} detail
 * @param {string} instance
 * @param {string} correlationId
 */
function sendProblem(res, status, title, detail, instance, correlationId) {
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/problem+json');
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Correlation-ID', correlationId);
    }
    return res.status(status).json({
        type: `https://cvsmartats.web.app/problems/http-${status}`,
        title,
        status,
        detail,
        instance,
        correlation_id: correlationId,
        error: detail
    });
}

/**
 * Checks whether an Origin header belongs to the strict whitelist.
 * Note: For POST endpoints, callers should use validateBrowserRequestOrigin(req).
 * @param {string | undefined | null} origin
 * @returns {boolean}
 */
function isAllowedOrigin(origin) {
    if (!origin) return true;
    return ALLOWED_ORIGINS.has(String(origin).trim());
}

/**
 * Enforces browser Origin & Fetch Metadata checks on mutating / expensive endpoints.
 * @param {any} req
 * @returns {{ allowed: boolean, reason: string, origin: string }}
 */
function validateBrowserRequestOrigin(req) {
    const headers = (req && req.headers) || {};
    const origin = typeof headers.origin === 'string' ? headers.origin.trim() : '';
    const secFetchSite = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'].trim().toLowerCase() : '';

    if (origin) {
        if (!ALLOWED_ORIGINS.has(origin)) {
            return { allowed: false, reason: 'Origin not in allowlist', origin };
        }
        return { allowed: true, reason: 'origin_allowed', origin };
    }

    // Without an Origin header, only permit explicit same-origin browser metadata (or HEAD/GET preflight exempt callers)
    if (secFetchSite === 'same-origin') {
        return { allowed: true, reason: 'sec_fetch_same_origin', origin: '' };
    }

    return { allowed: false, reason: 'Missing Origin header on POST request', origin: '' };
}

/**
 * Extracts client IP conservatively to defeat X-Forwarded-For left-side header spoofing.
 * Behind Firebase Hosting / Cloud Run / GFE, the platform appends the true client IP near the right edge.
 * @param {any} req
 * @returns {string}
 */
function extractClientIp(req) {
    const headers = (req && req.headers) || {};
    const fastlyIp = typeof headers['fastly-client-ip'] === 'string' ? headers['fastly-client-ip'].trim() : '';
    if (fastlyIp && /^[0-9a-fA-F:.]{3,45}$/.test(fastlyIp)) {
        return fastlyIp;
    }

    const rawXff = typeof headers['x-forwarded-for'] === 'string' ? headers['x-forwarded-for'] : '';
    if (rawXff) {
        const parts = rawXff
            .split(',')
            .map((part) => part.trim())
            .filter((part) => /^[0-9a-fA-F:.]{3,45}$/.test(part));
        if (parts.length > 0) {
            return parts[parts.length - 1];
        }
    }

    const directIp = (req && (req.ip || req.socket?.remoteAddress)) ? String(req.ip || req.socket.remoteAddress).trim() : '';
    return directIp || 'unknown';
}

/**
 * Hashes rate-limit bucket identifiers so raw client IPs never enter Redis keys or logs.
 * @param {string} rawKey
 * @returns {string}
 */
function hashRateLimitKey(rawKey) {
    const normalized = typeof rawKey === 'string' && rawKey.trim() && rawKey.trim().toLowerCase() !== 'unknown'
        ? rawKey.trim()
        : 'global_unknown_ip';
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * Escapes HTML special characters for safe XSS-free HTML rendering.
 * @param {unknown} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Checks whether an IPv4 tuple falls into private, loopback, link-local, or CGNAT space.
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 */
function isPrivateIpv4Octets(a, b) {
    if (!Number.isInteger(a) || !Number.isInteger(b)) return true;
    return (
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 169 && b === 254) ||
        (a === 192 && b === 168) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 100 && b >= 64 && b <= 127)
    );
}

/**
 * Detects private, loopback, cloud metadata, IPv4-mapped IPv6, and DNS rebinding hosts.
 * @param {string} urlStr
 * @returns {boolean}
 */
function isPrivateOrInternalUrl(urlStr) {
    try {
        const parsed = new URL(urlStr);
        const host = (parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
        if (!host) return true;
        if (
            host === 'localhost' ||
            host === '0.0.0.0' ||
            host === '::1' ||
            host === '::' ||
            host === '0:0:0:0:0:0:0:1' ||
            host.endsWith('.internal') ||
            host.endsWith('.local') ||
            host.endsWith('.nip.io') ||
            host.endsWith('.sslip.io') ||
            host.endsWith('.xip.io') ||
            host.endsWith('.localtest.me') ||
            host.endsWith('.lvh.me') ||
            host.includes('metadata.google')
        ) {
            return true;
        }
        if (/^(fe80:|fc00:|fd00:|::ffff:)/i.test(host)) {
            return true;
        }
        // Catch hex-encoded IPv4-mapped IPv6 produced by Node URL parser (e.g. ::ffff:a9fe:a9fe -> ::ffff:7f00:1)
        const v6MappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
        if (v6MappedHex) {
            const hi = parseInt(v6MappedHex[1], 16);
            const a = (hi >> 8) & 0xff;
            const b = hi & 0xff;
            if (isPrivateIpv4Octets(a, b)) return true;
        }
        const embeddedIpv4Match = host.match(/(?:^|\.)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.|$)/);
        if (embeddedIpv4Match) {
            const [, a, b] = embeddedIpv4Match.map(Number);
            if (isPrivateIpv4Octets(a, b)) {
                return true;
            }
        }
        return false;
    } catch (_) {
        return true;
    }
}

/**
 * Verifies binary Magic Bytes for supported raster image formats (JPEG, PNG, WebP).
 * @param {Buffer} buffer
 * @param {string} type
 * @returns {boolean}
 */
function hasValidMagicBytes(buffer, type) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
    const normalizedType = String(type).toLowerCase();
    if (normalizedType === 'jpeg' || normalizedType === 'jpg') {
        return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    }
    if (normalizedType === 'png') {
        return (
            buffer.length >= 8 &&
            buffer[0] === 0x89 &&
            buffer[1] === 0x50 &&
            buffer[2] === 0x4E &&
            buffer[3] === 0x47
        );
    }
    if (normalizedType === 'webp') {
        return (
            buffer.length >= 12 &&
            buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
            buffer.subarray(8, 12).toString('ascii') === 'WEBP'
        );
    }
    return false;
}

/**
 * Validates photo strictly as a base64 raster data-URI with matching binary Magic Bytes.
 * Rejects all http/https/svg/script URLs to make Puppeteer SSRF impossible.
 * @param {unknown} url
 * @returns {string}
 */
function sanitizePhotoUrl(url) {
    if (typeof url !== 'string' || !url) return '';
    const trimmed = url.trim();
    if (trimmed.length > MAX_PHOTO_DATA_URI_LENGTH) return '';

    const dataMatch = trimmed.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/i);
    if (dataMatch) {
        const imgType = dataMatch[1].toLowerCase();
        const b64Sample = dataMatch[2].slice(0, 64);
        const buf = Buffer.from(b64Sample, 'base64');
        return hasValidMagicBytes(buf, imgType) ? trimmed : '';
    }

    return '';
}

/**
 * Normalizes and strictly validates external HTTP(S) profile/project hyperlinks.
 * Blocks control characters, protocol-relative URLs, credentials, and dangerous schemes.
 * @param {unknown} rawUrl
 * @returns {string}
 */
function safeHttpUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return '';
    // Strip ASCII control characters to prevent scheme smuggling (e.g. java\tscript:)
    const cleaned = rawUrl.replace(/[\u0000-\u001f\u007f]+/g, '').trim().slice(0, 512);
    if (!cleaned || cleaned.startsWith('//')) return '';

    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(cleaned);
    const candidate = hasScheme ? cleaned : `https://${cleaned}`;
    try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
        if (parsed.username || parsed.password) return '';
        return parsed.href;
    } catch (_) {
        return '';
    }
}

/**
 * Sanitizes string values with strict length caps.
 * @param {unknown} val
 * @param {number} maxLen
 * @returns {string}
 */
function capString(val, maxLen) {
    if (typeof val !== 'string') return '';
    return val.replace(/\u0000/g, '').slice(0, maxLen);
}

/**
 * Validates and normalizes incoming CV payload to bound memory/DOM complexity and enforce styling allowlists.
 * @param {unknown} rawCvData
 * @returns {Record<string, any> | null}
 */
function validateAndSanitizeCvData(rawCvData) {
    if (!rawCvData || typeof rawCvData !== 'object' || Array.isArray(rawCvData)) {
        return null;
    }
    const src = /** @type {Record<string, any>} */ (rawCvData);

    const clampNum = (val, min, max, fallback) => {
        const num = Number(val);
        return Number.isFinite(num) && num >= min && num <= max ? num : fallback;
    };

    const sanitizeList = (arr, maxItems, mapper) => {
        if (!Array.isArray(arr)) return [];
        return arr
            .slice(0, maxItems)
            .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
            .map(mapper);
    };

    const rawColor = typeof src.color === 'string' ? src.color.trim() : '';
    const safeColor = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(rawColor) ? rawColor : '#3b82f6';
    const rawFont = typeof src.font === 'string' ? src.font.trim() : '';
    const safeFont = ALLOWED_CV_FONTS.has(rawFont) ? rawFont : "'Inter', sans-serif";

    const rawOrder = Array.isArray(src.order)
        ? src.order.filter((key) => typeof key === 'string' && ALLOWED_CV_SECTIONS.includes(key))
        : [];
    const safeOrder = [...new Set([...rawOrder, ...ALLOWED_CV_SECTIONS])];
    const safeHidden = Array.isArray(src.hidden)
        ? [...new Set(src.hidden.filter((key) => typeof key === 'string' && ALLOWED_CV_SECTIONS.includes(key)))]
        : [];

    return {
        name: capString(src.name, 120),
        title: capString(src.title, 140),
        email: capString(src.email, 160),
        phone: capString(src.phone, 40),
        location: capString(src.location, 120),
        linkedin: safeHttpUrl(src.linkedin),
        github: safeHttpUrl(src.github),
        portfolio: safeHttpUrl(src.portfolio),
        summary: capString(src.summary, 5000),
        photo: sanitizePhotoUrl(src.photo),
        color: safeColor,
        font: safeFont,
        padding: clampNum(src.padding, 5, 40, 20),
        size: clampNum(src.size, 11, 18, 14),
        lh: clampNum(src.lh, 1.2, 2.2, 1.6),
        gap: clampNum(src.gap, 10, 40, 24),
        order: safeOrder,
        hidden: safeHidden,
        links: sanitizeList(src.links, 20, (l) => ({
            label: capString(l.label, 60),
            url: safeHttpUrl(l.url)
        })).filter((l) => l.label && l.url),
        experiences: sanitizeList(src.experiences, 35, (e) => ({
            company: capString(e.company, 140),
            role: capString(e.role, 140),
            period: capString(e.period, 80),
            desc: capString(e.desc, 2500)
        })),
        projects: sanitizeList(src.projects, 35, (p) => ({
            name: capString(p.name, 140),
            tech: capString(p.tech, 200),
            url: safeHttpUrl(p.url),
            period: capString(p.period, 80),
            desc: capString(p.desc, 2500)
        })),
        educations: sanitizeList(src.educations, 25, (e) => ({
            institution: capString(e.institution, 160),
            degree: capString(e.degree, 160),
            period: capString(e.period, 80)
        })),
        certifications: sanitizeList(src.certifications, 25, (c) => ({
            name: capString(c.name, 160),
            issuer: capString(c.issuer, 140),
            period: capString(c.period, 80)
        })),
        languages: sanitizeList(src.languages, 20, (l) => ({
            name: capString(l.name, 80),
            level: capString(l.level, 60)
        })),
        skills: Array.isArray(src.skills)
            ? src.skills.slice(0, 60).map((sk) => capString(sk, 60)).filter(Boolean)
            : []
    };
}

/**
 * Redacts Stripe customer IDs and emails before storing in SOC 2 audit logs.
 * @param {unknown} value
 * @returns {string | null}
 */
function maskIdentifier(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const trimmed = value.trim();
    if (trimmed.length <= 8) return '***';
    return `${trimmed.slice(0, 5)}***${trimmed.slice(-4)}`;
}

/**
 * Validates Stripe checkout.session.completed payment integrity (status, mode, currency, minimum amount).
 * @param {any} sessionObj
 * @param {{ expectedCurrency?: string, subscriptionMinCents?: number, onetimeMinCents?: number }} [config]
 * @returns {{ ok: boolean, reason?: string, isSubscription?: boolean, amountTotal?: number, currency?: string, firebaseUid?: string | null, customerEmail?: string | null, stripeCustomerId?: string | null, subscriptionId?: string | null }}
 */
function evaluateStripeCheckoutSession(sessionObj, config = {}) {
    if (!sessionObj || typeof sessionObj !== 'object') {
        return { ok: false, reason: 'missing_session' };
    }
    if (sessionObj.payment_status !== 'paid') {
        return { ok: false, reason: `unpaid_status:${String(sessionObj.payment_status || 'unknown')}` };
    }

    const mode = sessionObj.mode;
    if (mode !== 'subscription' && mode !== 'payment') {
        return { ok: false, reason: `unsupported_mode:${String(mode || 'unknown')}` };
    }

    const expectedCurrency = String(config.expectedCurrency || 'eur').toLowerCase();
    const actualCurrency = typeof sessionObj.currency === 'string' ? sessionObj.currency.toLowerCase() : '';
    if (actualCurrency !== expectedCurrency) {
        return { ok: false, reason: `currency_mismatch:${actualCurrency || 'missing'}` };
    }

    const isSubscription = mode === 'subscription';
    const minCents = isSubscription
        ? (Number.isInteger(config.subscriptionMinCents) ? Number(config.subscriptionMinCents) : 500)
        : (Number.isInteger(config.onetimeMinCents) ? Number(config.onetimeMinCents) : 300);

    // Check amount_subtotal (pre-coupon listed catalog price) if amount_total isn't discounted via legitimate promo,
    // while still requiring amount_total > 0 so $0 bypasses fail closed unless 100% coupon explicitly verified.
    const amountTotal = Number(sessionObj.amount_total);
    const amountSubtotal = sessionObj.amount_subtotal !== undefined && sessionObj.amount_subtotal !== null
        ? Number(sessionObj.amount_subtotal)
        : amountTotal;
    if (!Number.isFinite(amountTotal) || amountTotal <= 0 || !Number.isFinite(amountSubtotal) || amountSubtotal < minCents) {
        return { ok: false, reason: `amount_below_minimum:${amountTotal}/${amountSubtotal}<${minCents}` };
    }

    const firebaseUid = typeof sessionObj.client_reference_id === 'string' && sessionObj.client_reference_id.trim()
        ? sessionObj.client_reference_id.trim()
        : null;
    const customerEmail = sessionObj.customer_details && typeof sessionObj.customer_details.email === 'string'
        ? sessionObj.customer_details.email.trim().toLowerCase()
        : null;
    const stripeCustomerId = typeof sessionObj.customer === 'string' && sessionObj.customer.trim()
        ? sessionObj.customer.trim()
        : null;
    const subscriptionId = typeof sessionObj.subscription === 'string' && sessionObj.subscription.trim()
        ? sessionObj.subscription.trim()
        : null;

    return {
        ok: true,
        isSubscription,
        amountTotal,
        currency: actualCurrency,
        firebaseUid,
        customerEmail,
        stripeCustomerId,
        subscriptionId
    };
}

/**
 * Readiness/health check handler compliant with Modulul 7.
 * @param {any} req
 * @param {any} res
 */
function handleHealthz(req, res) {
    const correlationId = getCorrelationId(req, 'hlth');
    if (typeof res.setHeader === 'function') {
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Correlation-ID', correlationId);
    }
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
        return sendProblem(res, 405, 'Method Not Allowed', 'Only GET and HEAD are allowed on /healthz.', '/healthz', correlationId);
    }
    return res.status(200).json({
        status: 'ok',
        service: 'cv-builder-ats',
        timestamp: new Date().toISOString(),
        correlation_id: correlationId
    });
}

module.exports = {
    CORRELATION_ID_REGEX,
    MAX_PHOTO_DATA_URI_LENGTH,
    MAX_PAYLOAD_BYTES,
    ALLOWED_ORIGINS,
    ALLOWED_CV_FONTS,
    ALLOWED_CV_SECTIONS,
    getCorrelationId,
    sendProblem,
    isAllowedOrigin,
    validateBrowserRequestOrigin,
    extractClientIp,
    hashRateLimitKey,
    escapeHtml,
    isPrivateOrInternalUrl,
    hasValidMagicBytes,
    sanitizePhotoUrl,
    safeHttpUrl,
    validateAndSanitizeCvData,
    maskIdentifier,
    evaluateStripeCheckoutSession,
    handleHealthz
};
