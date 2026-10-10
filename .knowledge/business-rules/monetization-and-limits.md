---
id: monetization-and-limits
domain: business-rules
last_verified: 2026-10-08
dependencies: [cv-builder-ats-root-index]
---

# Reguli de Business & Monetizare - CV Builder PRO

## 1. Niveluri de Acces (Tiers)

1. **Free Tier (Utilizator Gratuit)**:
   - Acces nelimitat la editorul vizual și la analiza de conformitate ATS.
   - Export PDF disponibil cu watermark discret: `"Creat cu CV Builder Pro | domeniultau.ro"`.
   - Copiere text brut ATS blocată (funcție PRO).

2. **PRO Subscription (5 EUR / lună - recurent)**:
   - Exporturi PDF nelimitate fără watermark, randate vectorial în Cloud Functions.
   - Acces complet la funcția de copiere text brut pentru parsere ATS (raw paste).
   - Suport prioritar.

3. **PRO One-Time Export (Credit Unic per Export)**:
   - Utilizatorul achiziționează un credit individual de descărcare fără watermark (`exportCredits = exportCredits + 1`).
   - La fiecare descărcare PRO efectuată pe baza unui credit, `exportCredits` se decrementează atomic pe server.

## 2. Fluxul Plăților (Stripe)

* Plata se inițiază prin Stripe Payment Links cu parametrul `client_reference_id = <firebaseUid>`.
* Webhook-ul Stripe (`stripeWebhook`) ascultă exclusiv evenimentul criptat `checkout.session.completed`.
* Pe baza parametrului `session.mode`:
  - `subscription` -> activează `isPro = true` și salvează `subscriptionId`.
  - `payment` (one-time) -> incrementează atomic `exportCredits` cu `1`.
