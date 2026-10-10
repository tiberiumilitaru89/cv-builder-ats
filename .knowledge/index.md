---
id: cv-builder-ats-root-index
domain: cv-builder-ats-architecture
last_verified: 2026-10-10
dependencies: []
---

# Knowledge Index - CV Builder PRO & ATS Analyzer

Acest director reprezintă Sursa Unică de Adevăr (SSOT) pentru arhitectura, regulile de business, modelul de date și securitatea platformei `cv-builder-ats`.

## Noduri de Cunoaștere Atomice

1. [Reguli de Business & Monetizare](file:///d:/Antigravity/cv-builder-ats/.knowledge/business-rules/monetization-and-limits.md)
   - Modele de acces: Free (cu watermark) și PRO (fără watermark, export vector PDF de înaltă rezoluție, copiere text raw ATS).
   - Prețuri și integrări Stripe (Abonament lunar 5 EUR, Plată unică per export).
2. [Model de Date & Reguli Firestore](file:///d:/Antigravity/cv-builder-ats/.knowledge/database/firestore-schema-and-rules.md)
   - Structura documentelor `users/{userId}`: `isPro`, `exportCredits`, `stripeCustomerId`, `subscriptionId`.
   - Reguli de securitate: izolarea `users` cu interzicerea mutațiilor client-side pe câmpurile financiare.
   - Salvare draft-uri utilizator în `users/{userId}/drafts/cv`.
3. [Securitate Serverless & Headless Chromium Hardening](file:///d:/Antigravity/cv-builder-ats/.knowledge/security/pdf-generation-and-puppeteer-hardening.md)
   - Apărare Anti-SSRF și Server-Side XSS în Puppeteer (dezactivare JavaScript, ecranare HTML completă, validare strictă URL/data: URI pentru foto).
   - Prevenirea scurgerilor de procese (Lifecycle management: `finally { await browser.close() }`).
   - Rate limiting pe Cloud Functions și protecție webhook Stripe prin semnătură criptografică `stripe-signature`.
4. [Securitate Frontend & Zero Inline Styling](file:///d:/Antigravity/cv-builder-ats/.knowledge/security/frontend-hardening-and-csp.md)
   - Eliminare completă a atributelor de stil inline și a apelurilor `innerHTML` brute.
   - Izolare variabile CSS dinamice (`--ats-progress`, `--kw-fill-width`, `--ta-height`, `--page-break-top`).
   - Sanitizare deterministă prin `setSafeContent()` și `DOMPurify`.
