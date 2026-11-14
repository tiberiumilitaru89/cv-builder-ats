# CV Builder PRO & ATS Analyzer

Editor CV client-side și analizor ATS cu backend Firebase Cloud Functions și Firestore.

## Structură

- `public/` — aplicația SPA statică (HTML, CSS, JS, `purify.min.js` pentru sanitizare HTML)
- `functions/` — Firebase Cloud Functions și module de securitate/stilizare PDF
- `tests/` — teste automate Node (`cv-builder-security.test.js`)

## Verificare

```bash
npm run gatekeeper  # verificare sintaxă JS, gatekeeper functions, audit prod și teste
```

## Producție

- URL: https://cvsmartats.web.app
