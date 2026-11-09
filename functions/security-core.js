// @ts-check
/**
 * Pure domain & security module for CV Builder ATS Cloud Functions.
 * Zero external runtime dependencies — shared directly between functions/index.js and tests.
 */

const CORRELATION_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_PHOTO_DATA_URI_LENGTH = Math.floor(2.5 * 1024 * 1024); // 2.5 MB

/**
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
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
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

const ALLOWED_ORIGINS = new Set([
    'https://cvsmartats.web.app',
    'https://cvsmartats.firebaseapp.com',
    'https://cv-builder-ats-2026.web.app',
    'https://cv-builder-ats-2026.firebaseapp.com',
    'http://localhost:5000',
    'http://127.0.0.1:5000'
]);

/**
 * @param {string | undefined | null} origin
 * @returns {boolean}
 */
function isAllowedOrigin(origin) {
    if (!origin) return true;
    return ALLOWED_ORIGINS.has(String(origin).trim());
}

/**
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
        if (/^(fe80:|fc00:|fd00:)/i.test(host)) {
            return true;
        }
        const embeddedIpv4Match = host.match(/(?:^|\.)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.|$)/);
        if (embeddedIpv4Match) {
            const [, a, b] = embeddedIpv4Match.map(Number);
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

/**
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
        const b64Sample = dataMatch[2].slice(0, 32);
        const buf = Buffer.from(b64Sample, 'base64');
        return hasValidMagicBytes(buf, imgType) ? trimmed : '';
    }

    return '';
}

/**
 * @param {any} req
 * @param {any} res
 */
function handleHealthz(req, res) {
    const correlationId = getCorrelationId(req, 'hlth');
    if (typeof res.setHeader === 'function') {
        res.setHeader('Cache-Control', 'no-store');
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
    ALLOWED_ORIGINS,
    getCorrelationId,
    sendProblem,
    isAllowedOrigin,
    escapeHtml,
    isPrivateOrInternalUrl,
    hasValidMagicBytes,
    sanitizePhotoUrl,
    handleHealthz
};
