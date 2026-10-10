---
id: cv-builder-frontend-hardening-and-csp
domain: security
last_verified: 2026-10-10
dependencies:
  - cv-builder-ats-root-index
---

# Frontend Hardening & Zero Inline Styling Architecture

## 1. Context & Obiectiv
Acest document stabilește regulile inviolabile de securitate la nivelul interfeței utilizator pentru `cv-builder-ats`, asigurând compatibilitate completă cu politicile stricte Content Security Policy (fără clauza `unsafe-inline` în directivele de stil sau script).

## 2. Zero Inline Styling (Zero-Inline CSS)
- **HTML Curat:** Niciun atribut `style="..."` nu este permis în `index.html`. Toate componentele vizuale (modale, bare de navigare, butoane GDPR, carduri de prețuri, scoruri ATS) sunt mapate prin clase CSS semantice (`.sub-info--active`, `.pro-plans--grid`, `.ats-chk`, etc.) definite în `styles.css`.
- **Mutații Dinamice în JavaScript:** Modificarea directă `element.style.prop = val` este interzisă. Modificările dinamice de layout sau dimensiune se efectuează exclusiv prin variabile CSS personalizate (`CSS Custom Properties`):
  - `--ats-progress` pentru bara de progres a scorului ATS.
  - `--kw-fill-width` pentru barele de frecvență a cuvintelor cheie.
  - `--page-break-top` pentru indicatorii de paginare A4.
  - `--ta-height` pentru redimensionarea automată a câmpurilor textarea.
  - `--cv-accent`, `--cv-font`, `--cv-pad`, `--cv-size`, `--cv-lh`, `--cv-gap` pentru parametrizarea CV-ului.

## 3. Zero-Trust DOM Mutation & Sanitizare
- **Interzicerea `innerHTML`:** Nicio asignare directă nesanitizată de tip `element.innerHTML = ...` nu este permisă.
- **`setSafeContent(element, htmlString)`:** Metodă unificată de inserare a conținutului formatat (markdown bullets, descrieri CV, corpuri de mesaje internaționalizate). Folosește `DOMPurify.sanitize()` cu whitelist restrâns de taguri (`ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'u', 'br', 'p', 'ul', 'li', 'span', 'code']`) și atribute (`class`), injectat prin fragment `<template>`.
- **Construcție Programatică DOM:** Toate listele dinamice (experiențe, proiecte, educație, certificări, limbi, competențe, verificări ATS, pitfalls, keywords) sunt generate prin `document.createElement()`, `textContent`, `append()`, iar golirea containerelor se face exclusiv prin `replaceChildren()`.
- **Link-uri Securizate:** Toate link-urile externe sunt filtrate prin `safeUrl()` pentru neutralizarea protocoalelor periculoase (`javascript:`, `data:`, `vbscript:`) și injectate cu `rel="noopener noreferrer"`.
