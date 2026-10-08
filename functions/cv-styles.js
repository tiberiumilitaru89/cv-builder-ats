// cv-styles.js - Inlined CSS for Headless Chromium Serverless PDF Rendering
// Elimină orice dependență de rețea, prevenind vulnerabilitățile SSRF și 404 pe domeniu

const CV_BASE_STYLES = `
*, *::before, *::after {
    box-sizing: border-box;
}

body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
}

.cv-doc {
    background: #ffffff;
    width: 210mm;
    min-height: 297mm;
    padding: var(--cv-pad, 20mm);
    color: #0f172a;
    font-family: var(--cv-font, 'Inter', sans-serif);
    font-size: var(--cv-size, 14px);
    line-height: var(--cv-lh, 1.6);
    margin: 0 auto;
    position: relative;
    border: none !important;
    box-shadow: none !important;
}

.cv-watermark {
    position: absolute;
    bottom: 12mm;
    left: 0;
    width: 100%;
    text-align: center;
    font-size: 11px;
    font-weight: 700;
    color: rgba(100, 116, 139, 0.45);
    letter-spacing: 2px;
    text-transform: uppercase;
    pointer-events: none;
    user-select: none;
}

.cv-hdr {
    display: flex;
    gap: 20px;
    border-bottom: 2.5px solid var(--cv-accent, #3b82f6);
    padding-bottom: 18px;
    margin-bottom: 20px;
    align-items: center;
}

.cv-photo {
    width: 95px;
    height: 95px;
    border-radius: 50%;
    object-fit: cover;
    border: 2.5px solid #e2e8f0;
    flex-shrink: 0;
}

.cv-meta {
    flex: 1;
    min-width: 0;
}

.cv-name {
    font-size: 30px;
    font-weight: 800;
    line-height: 1.15;
    margin-bottom: 3px;
    color: #0f172a;
    letter-spacing: -.3px;
}

.cv-role-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.cv-role {
    font-size: 17px;
    font-weight: 500;
    color: var(--cv-accent, #3b82f6);
    margin: 0;
}

.cv-exp-badge {
    background: var(--cv-accent, #3b82f6);
    color: #ffffff;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 20px;
    text-transform: uppercase;
    letter-spacing: .5px;
}

.cv-contact {
    font-size: 12.5px;
    color: #475569;
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: flex-end;
    flex-shrink: 0;
}

.cv-ci {
    display: flex;
    align-items: center;
    gap: 5px;
    justify-content: flex-end;
}

.cv-ci svg {
    width: 12px;
    height: 12px;
    fill: var(--cv-accent, #3b82f6);
    flex-shrink: 0;
}

.cv-ci a {
    color: var(--cv-accent, #3b82f6);
    text-decoration: none;
}

.cv-sec {
    margin-bottom: var(--cv-gap, 24px);
    break-inside: avoid;
    page-break-inside: avoid;
}

.cv-sec__title {
    font-size: 15px;
    font-weight: 700;
    text-transform: uppercase;
    color: #0f172a;
    border-bottom: 1.5px solid #e2e8f0;
    padding-bottom: 5px;
    margin-bottom: 14px;
    letter-spacing: 1.2px;
    break-after: avoid;
    page-break-after: avoid;
}

.cv-item {
    margin-bottom: 14px;
    break-inside: avoid;
    page-break-inside: avoid;
}

.cv-item:last-child {
    margin-bottom: 0;
}

.cv-item__hdr {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 3px;
}

.cv-item__title {
    font-weight: 700;
    font-size: 14.5px;
    color: #0f172a;
}

.cv-item__date {
    font-size: 12px;
    font-weight: 500;
    color: #64748b;
    white-space: nowrap;
    flex-shrink: 0;
}

.cv-item__sub {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--cv-accent, #3b82f6);
    margin-bottom: 5px;
}

.cv-text {
    font-size: 13.5px;
    color: #334155;
    line-height: 1.65;
    text-align: justify;
}

.cv-text p {
    margin: 0 0 4px 0;
}

.cv-text p:last-child {
    margin-bottom: 0;
}

.cv-text ul {
    margin-left: 18px;
    margin-top: 3px;
    margin-bottom: 3px;
}

.cv-text li {
    margin-bottom: 2px;
}

.cv-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.cv-pill {
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    color: #334155;
    font-size: 12px;
    padding: 3px 11px;
    border-radius: 20px;
    font-weight: 500;
}
`;

module.exports = { CV_BASE_STYLES };
