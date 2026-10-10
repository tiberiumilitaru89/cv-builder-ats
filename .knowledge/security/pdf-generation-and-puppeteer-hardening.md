---
id: pdf-generation-and-puppeteer-hardening
domain: security
last_verified: 2026-10-08
dependencies: [cv-builder-ats-root-index]
---

# Securitate Serverless & Headless Chromium Hardening

## 1. Vectori de Atac & Măsuri Defensive în Puppeteer

Randarea conținutului arbitrar provenit de la clienți într-o instanță de browser headless (Chromium) prezintă riscuri majore dacă nu este izolată corespunzător.

### A. Prevenirea Server-Side XSS & Execuție de Cod Arbitrar
* **Dezactivare Execuție JS:** În instanța Puppeteer, apelul `await page.setJavaScriptEnabled(false)` dezactivează interpretarea oricărui script din documentul HTML compilat.
* **Ecranare HTML Completă:** Toate câmpurile dinamice primite din `cvData` sunt ecranate riguros prin funcția `escapeHtml` (`&`, `<`, `>`, `"`, `'`), neutralizând orice payload injectat.

### B. Prevenirea SSRF & Local File Read (LFI)
* **Blocare Cereri de Rețea Interne:** Se configurează interceptarea cererilor (`page.setRequestInterception(true)`):
  - Orice cerere către adrese locale (`localhost`, `127.0.0.1`, `0.0.0.0`), protocoale interne (`file://`, `gopher://`, `ftp://`) sau adrese de metadate Cloud (`169.254.169.254`) este **abortată instantaneu**.
* **Validare Câmp Foto:** Fotografia profilului este permisă doar dacă respectă formatul `data:image/(png|jpeg|jpg|webp);base64,...` sau un URL `https://` sigur.
* **Inlining CSS:** Stilurile grafice ale CV-ului sunt compilate inline în șablon, eliminând cererile externe către fișiere CSS din antetul `Origin`.

### C. Prevenirea Scurgerilor de Memorie & Zombie Processes
* Închiderea procesului Puppeteer (`browser.close()`) se realizează obligatoriu în clauza `finally`, garantând că nicio eroare sau timeout nu lasă instanțe de Chromium agățate în memoria containerului Cloud Functions.

### D. Rate Limiting pe `generatePDF`
* Apelurile sunt limitate la un prag determinist (ex: 5 generări per fereastră de 2 minute per IP) pentru a preveni abuzurile de resurse și costurile neprevăzute.
