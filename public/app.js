(function () {
            'use strict';

            // ══════════════════════════════════════════════════
            // FIREBASE CONFIG — înlocuiește cu datele tale!
            // Pasul 1: Mergi la https://console.firebase.google.com
            // Pasul 2: Creează proiect → Web App → copiază config
            // Pasul 3: Activează Authentication > Google Sign-In
            // Pasul 4: Activează Firestore Database
            // ══════════════════════════════════════════════════
            var FIREBASE_CONFIG = {
                apiKey:            'INLOCUIESTE_API_KEY',
                authDomain:        'INLOCUIESTE.firebaseapp.com',
                projectId:         'INLOCUIESTE_PROJECT_ID',
                storageBucket:     'INLOCUIESTE.appspot.com',
                messagingSenderId: 'INLOCUIESTE_SENDER_ID',
                appId:             'INLOCUIESTE_APP_ID'
            };

            // ══════════════════════════════════════════════════
            // STRIPE LINKS — înlocuiește cu link-urile tale!
            // Pasul 1: Mergi la https://dashboard.stripe.com
            // Pasul 2: Creează Product: "CV Builder PRO" — 5 EUR/lună (Recurring)
            // Pasul 3: Creează Payment Link pentru acel produs
            // Pasul 4: La "After payment" setează redirect:
            //    https://DOMENIULTAU.ro/?session_id={CHECKOUT_SESSION_ID}
            // Pasul 5: Înlocuiește URL-urile de mai jos:
            var STRIPE_URL_MONTHLY = 'https://buy.stripe.com/7sY4gCc6e7kmgaDd3t3oA00';
            var STRIPE_URL_ONETIME = 'https://buy.stripe.com/cNidRc3zI346cYrbZp3oA02';
            // Stripe Billing Portal — pentru ca utilizatorii să-și gestioneze/anuleze abonamentul
            // Activează în Stripe Dashboard > Customer Portal
            var STRIPE_BILLING_PORTAL = 'https://billing.stripe.com/p/login/7sY4gCc6e7kmgaDd3t3oA00';
            // Pasul 6: Înlocuiește URL-ul Cloud Function-ului tău (vezi rezultatul comenzii firebase deploy)
            var CLOUD_FUNCTION_URL = 'https://eur3-cvsmartats.cloudfunctions.net/generatePDF';
            // ══════════════════════════════════════════════════

            // ══════════════════════════════════════════════════
            // FIREBASE INIT
            // ══════════════════════════════════════════════════
            var fbApp, fbAuth, fbDb;
            var firebaseReady = false;
            try {
                if (FIREBASE_CONFIG.apiKey !== 'INLOCUIESTE_API_KEY') {
                    fbApp  = firebase.initializeApp(FIREBASE_CONFIG);
                    fbAuth = firebase.auth();
                    fbDb   = firebase.firestore();
                    firebaseReady = true;
                    // Persistenta autentificare pe browser (inclusiv inchidere tab)
                    fbAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
                }
            } catch(e) { console.warn('Firebase init error:', e); }
            // ══════════════════════════════════════════════════

            // ══════════════════════════════════════════════════
            // INTERNATIONALIZATION (i18n)
            // ══════════════════════════════════════════════════
            var I18N = {
                ro: {
                    tabEditor: 'Editor', tabPreview: 'Vizualizare CV',
                    appSubtitle: 'ATS Optimized | Securizat & Rapid',
                    btnSaveJSON: 'Salvare JSON', btnImport: 'Importă',
                    btnCopyText: '📋 Copiază Text', btnReset: 'Resetare', btnExportPDF: '🖨️ Exportă PDF',
                    btnAddLink: '+ Adaugă Link', btnAddExp: '+ Adaugă Experiență', btnAddProj: '+ Adaugă Proiect',
                    btnAddEdu: '+ Adaugă Educație', btnAddCert: '+ Adaugă Certificare',
                    btnAddLang: '+ Adaugă Limbă', btnAddSkill: 'Adaugă',
                    btnParseExp: '+ Experiență', btnParseProj: '+ Proiect', btnRmPhoto: 'Șterge fotografia',
                    profileLabel: 'Profil CV activ',
                    secSmart: 'Import Rapid (Smart Paste)', secJD: 'Compatibilitate Anunț Job (JD)',
                    secPersonal: 'Date Personale', secAspect: 'Aspect CV', secOrder: 'Ordine & Vizibilitate',
                    secLinks: 'Link-uri Profesionale', secExp: 'Experiență Profesională', secProj: 'Proiecte',
                    secEdu: 'Educație', secCert: 'Certificări', secLang: 'Limbi Străine', secSkills: 'Competențe',
                    lblSmartText: 'Text brut (Experiențe / Proiecte)', lblJD: 'Lipește descrierea jobului căutat (JD)',
                    lblPhoto: 'Fotografie (Max 2MB)', lblName: 'Nume Complet', lblTitle: 'Titlu Profesional',
                    lblEmail: 'Email', lblPhone: 'Telefon', lblLocation: 'Locație', lblLinkedIn: 'LinkedIn URL',
                    lblGitHub: 'GitHub URL', lblPortfolio: 'Website / Portfolio',
                    lblSummary: 'Profil Profesional', lblAccentColor: 'Culoare Accent',
                    lblColorDesc: 'Culoarea de bază din șablon', lblFont: 'Font CV',
                    lblPad: 'Margini CV', lblSize: 'Dimensiune Text', lblLH: 'Spațiere Linii', lblGap: 'Spațiere Secțiuni',
                    cvSummary: 'Profil Profesional', cvExp: 'Experiență Profesională', cvProj: 'Proiecte',
                    cvEdu: 'Educație', cvCert: 'Certificări', cvLang: 'Limbi Străine',
                    cvSkills: 'Competențe Tehnice & Soft Skills',
                    atsTitle: 'Compatibilitate Sistem ATS', atsEmptyStart: 'Completează datele din stânga pentru a analiza profilul',
                    atsKwTitle: '🔑 Densitate Cuvinte Cheie Detectate (Top 10)',
                    jdTitle: 'Analiză Comparativă cu Fișa Postului', jdScore: 'Rată potrivire:',
                    jdMissing: 'Cuvinte cheie absente din CV-ul tău:',
                    toastSaved: 'Salvat în browser',
                    watermark: 'Creat cu CV Builder Pro | domeniultau.ro',
                    modalResetTitle: 'Resetare date', modalResetCancel: 'Anulează', modalResetConfirm: 'Da, șterge tot',
                    modalProTitle: 'Deblochează Export PRO', modalProCancel: 'Export gratuit (cu watermark)', modalProBuy: 'Cumpără PRO 5€/lună',
                    toastLoginRequired: 'Autentifică-te pentru a accesa PRO pe orice dispozitiv! 🔐',
                    toastLoggedIn: 'Autentificat cu succes! ✅',
                    toastLoggedOut: 'Delogat cu succes.',
                    toastSubActive: 'Abonament PRO activ ✅',
                    toastSubCancelled: 'Abonamentul va expira la finalul perioadei curente.',
                    toastSubExpired: 'Abonamentul PRO a expirat. Reînnoiește pentru acces.',
                    toastLoginError: 'Eroare la autentificare. Încearcă din nou.',
                    toastProActivated: 'Abonament PRO activat! Bun venit! 🎉',
                    subInfoActive: '✅ Abonamentul tău PRO este activ și se reînnoiește automat.',
                    subInfoNone: 'Nu ai un abonament PRO activ.',
                    loginModalTitle: '🔐 Autentificare',
                    loginModalBody: 'Creează un cont gratuit sau autentifică-te pentru a accesa abonamentul PRO pe orice dispozitiv.',
                    loginGoogleBtn: 'Continuă cu Google',
                    loginDivider: 'Datele tale sunt private și securizate',
                    loginCancelBtn: 'Continuă fără cont',
                    manageSubTitle: '⚙️ Abonamentul tău PRO',
                    manageSubClose: 'Închide',
                    cancelSubBtn: 'Anulează abonamentul',
                    openBillingPortal: 'Gestionează plăți în Stripe →',
                    authNotLogged: 'Neautentificat',
                    btnLogin: 'Login',
                    btnLogout: 'Delogare',
                    btnManageSub: 'Abonament',
                    subTrialing: 'Perioadă de probă activă.',
                    toastFirebaseNotSet: 'Firebase nu este configurat încă.',
                    toastPortalNotSet: 'Stripe Customer Portal nu este configurat încă.',
                    planExportLabel: '/ export', planExportDesc: 'Un singur CV, fără abonament',
                    planBadge: 'CEL MAI POPULAR', planMonthlyLabel: '/ lună', planMonthlyDesc: 'Exporturi nelimitate',
                    proFeat1: 'PDF fără watermark', proFeat2: 'Export JSON nelimitat',
                    proFeat3: 'Copiere text CV (ATS raw paste)', proFeat4: 'Suport prioritar',
                    orderHint: 'Reordonează cu butoanele ↑↓. Apasă pe ochiul 👁 pentru a ascunde secțiunea în document.',
                    smartHint: 'Detectează automat perioade, roluri, companii și skill-uri relevante.',
                    phSmartPaste: 'Ex: Software Engineer la Google (2022 - Prezent)\n- Am dezvoltat aplicații React\n- Am optimizat query-urile SQL în PostgreSQL',
                    phJD: 'Lipește aici cerințele și responsabilitățile postului pentru a verifica automat potrivirea cu CV-ul...',
                    phName: 'Ion Popescu', phTitle: 'Software Engineer', phEmail: 'ion@example.com',
                    phPhone: '+40 700 000 000', phLocation: 'București, România',
                    phLinkedIn: 'linkedin.com/in/username', phGitHub: 'github.com/username',
                    phPortfolio: 'https://portofoliu.ro', phSummary: 'Scurt rezumat al carierei tale...',
                    phSkill: 'Ex: React, Node.js, Python',
                    atsHigh: 'CV bine optimizat pentru parserul ATS ✅',
                    atsMed: 'Stadiu bun, dar necesită îmbunătățiri ⚡',
                    atsLow: 'Modificări majore recomandate ⚠️',
                    atsEmpty: 'Informații insuficiente pentru o evaluare corectă 🔍',
                    chkEmail: 'Email valid', chkPhone: 'Telefon', chkLocation: 'Locație',
                    chkName: 'Nume complet (≥2 cuvinte)', chkTitle: 'Titlu profesional',
                    chkSummary: 'Profil (≥30 caractere)', chkExp: 'Experiență înregistrată',
                    chkBullets: 'Bullets în descrieri', chkQty: 'Rezultate cuantificabile',
                    chkEdu: 'Studii completate', chkSkills: 'Competențe relevante (≥3)',
                    chkLang: 'Limbi străine cunoscute', chkCert: 'Certificări obținute',
                    chkLinkedIn: 'LinkedIn configurat', chkNoPhoto: 'Fără fotografie (ATS-friendly)',
                    chkFont: 'Font compatibil ATS', chkProj: 'Proiecte adăugate',
                    pitPhoto: 'Fotografiile atașate pot bloca parsoarele ATS rigide. Se recomandă eliminarea ei.',
                    pitEmail: 'Adresa de email lipsește sau are un format eronat.',
                    pitPhone: 'Numărul de telefon lipsește sau este incomplet.',
                    pitSummary: 'Profilul profesional este absent sau prea scurt. Adaugă un rezumat relevant.',
                    pitLinkedIn: 'Link-ul de LinkedIn lipsește. Majoritatea recrutorilor analizează profilul online.',
                    pitExpShort: ' experiență/e au o descriere mult prea sumară.',
                    pitSkills: 'Numărul de competențe listate este mic. Adaugă minimum 5-10 abilități.',
                    pitMissing: 'Secțiuni obligatorii absente: ',
                    cpSummary: 'PROFIL PROFESIONAL', cpExp: 'EXPERIENȚĂ PROFESIONALĂ', cpSkills: 'COMPETENȚE:',
                    secnSummary: 'Profil Profesional', secnExperience: 'Experiență', secnProjects: 'Proiecte',
                    secnEducation: 'Educație', secnCertifications: 'Certificări', secnLanguages: 'Limbi Străine', secnSkills: 'Competențe',
                    emptyNothing: 'Nimic adăugat încă', emptyNoLinks: 'Niciun link',
                    skillExists: 'Skill-ul "%s" există deja.', skillHint: 'Scrie o abilitate și apasă Enter.',
                    toastImportOk: 'Datele au fost importate cu succes!',
                    toastImportErr: 'Fișierul JSON importat este corupt sau invalid.',
                    toastCopied: 'CV copiat în clipboard ca text simplu! ✅',
                    toastPaid: 'Plata confirmată! Modul PRO a fost activat permanent pe acest browser. ✅',
                    toastStripeNotSet: 'URL-ul Stripe nu a fost setat încă în codul sursă!',
                    toastProfilCreat: ' a fost creat!', toastProfilRedenumit: 'Profil redenumit cu succes!',
                    toastProfilSters: 'Profilul selectat a fost șters.',
                    toastProfilUnic: 'Nu poți șterge unicul profil activ!',
                    toastProfilComutat: 'Profil comutat pe: ',
                    toastEdit: 'Editare secțiune: ', toastStorage: 'Spațiu insuficient în LocalStorage! Încearcă o imagine de rezoluție mai mică.',
                    toastJSONOk: 'Backup JSON descărcat cu succes! ✅',
                    toastSmartEmpty: 'Introduceți un text brut mai întâi.', toastPhotoSize: 'Fotografia depășește 2MB.',
                    toastSmartExpOk: 'Experiența a fost adăugată cu succes!', toastSmartProjOk: 'Proiectul a fost adăugat cu succes!',
                    toastNoProfileDel: 'Nu poți șterge unicul profil!', toastNewProfile: 'Numele noului profil:',
                    toastNewProfileName: 'Profil Nou', toastRenameProfile: 'Redenumește profilul:',
                    toastConfirmDel: 'Sigur dorești să ștergi profilul "%s"?',
                    modalResetBodyHTML: 'Toate datele CV-ului vor fi șterse definitiv.<br><strong>Acțiunea nu poate fi anulată.</strong><br>Recomandăm exportul unui backup JSON înainte.',
                    modalProBodyHTML: 'Versiunea <strong>gratuită</strong> exportă cu watermark discret. Cu <strong>PRO</strong> obții PDF-ul curat, fără nicio siglă sau watermark.',
                    smartParseDefaultCo: 'Companie Nespecificată', smartParseFree: 'Freelance', smartParseDefaultRole: 'Rol Nespecificat',
                    smartParseDefaultProj: 'Proiect', smartParsePresent: 'Prezent',
                    pageBreakLabel: 'Pagina %n | Limită A4',
                    moveUp: 'Mută sus', moveDown: 'Mută jos', delItem: 'Șterge', delSkill: 'Șterge ',
                    showSec: 'Arată', hideSec: 'Ascunde',
                    expYear: ' An', expYears: ' Ani',
                    langHtml: 'ro',
                    gdprText: 'Folosim stocarea locală și cookie-uri strict necesare pentru a-ți salva progresul și a permite autentificarea. Datele tale sunt private și nu le vindem terților.',
                    gdprAcceptBtn: 'Am înțeles și sunt de acord',
                    loginGdprLabel: 'Prin autentificare, ești de acord cu Termenii de Utilizare și cu prelucrarea datelor cu caracter personal (Nume, Email, poză profil) strict pentru cont și facturare.',
                    atsDisclaimer: 'ℹ️ Analiza ATS este orientativă. Sistemele companiei pot varia în funcție de parserul utilizat (Taleo, Workday, etc). Scopul acestui scor este să îți valideze prezența cuvintelor cheie și formatarea corectă.'
                },
                en: {
                    tabEditor: 'Editor', tabPreview: 'CV Preview',
                    appSubtitle: 'ATS Optimized | Secure & Fast',
                    btnSaveJSON: 'Save JSON', btnImport: 'Import',
                    btnCopyText: '📋 Copy Text', btnReset: 'Reset', btnExportPDF: '🖨️ Export PDF',
                    btnAddLink: '+ Add Link', btnAddExp: '+ Add Experience', btnAddProj: '+ Add Project',
                    btnAddEdu: '+ Add Education', btnAddCert: '+ Add Certification',
                    btnAddLang: '+ Add Language', btnAddSkill: 'Add',
                    btnParseExp: '+ Experience', btnParseProj: '+ Project', btnRmPhoto: 'Remove photo',
                    profileLabel: 'Active CV Profile',
                    secSmart: 'Quick Import (Smart Paste)', secJD: 'Job Description Compatibility',
                    secPersonal: 'Personal Details', secAspect: 'CV Appearance', secOrder: 'Order & Visibility',
                    secLinks: 'Professional Links', secExp: 'Work Experience', secProj: 'Projects',
                    secEdu: 'Education', secCert: 'Certifications', secLang: 'Languages', secSkills: 'Skills',
                    lblSmartText: 'Raw text (Experiences / Projects)', lblJD: 'Paste job description (JD)',
                    lblPhoto: 'Photo (Max 2MB)', lblName: 'Full Name', lblTitle: 'Professional Title',
                    lblEmail: 'Email', lblPhone: 'Phone', lblLocation: 'Location', lblLinkedIn: 'LinkedIn URL',
                    lblGitHub: 'GitHub URL', lblPortfolio: 'Website / Portfolio',
                    lblSummary: 'Professional Summary', lblAccentColor: 'Accent Color',
                    lblColorDesc: 'Main color of the template', lblFont: 'CV Font',
                    lblPad: 'CV Margins', lblSize: 'Text Size', lblLH: 'Line Spacing', lblGap: 'Section Spacing',
                    cvSummary: 'Professional Summary', cvExp: 'Work Experience', cvProj: 'Projects',
                    cvEdu: 'Education', cvCert: 'Certifications', cvLang: 'Languages',
                    cvSkills: 'Technical Skills & Soft Skills',
                    atsTitle: 'ATS System Compatibility', atsEmptyStart: 'Fill in the data on the left to analyze your profile',
                    atsKwTitle: '🔑 Detected Keyword Density (Top 10)',
                    jdTitle: 'Comparative Analysis with Job Description', jdScore: 'Match rate:',
                    jdMissing: 'Keywords missing from your CV:',
                    toastSaved: 'Saved in browser',
                    watermark: 'Generat cu CV Builder PRO',
                    modalResetTitle: 'Reset Data', modalResetCancel: 'Cancel', modalResetConfirm: 'Yes, delete all',
                    modalProTitle: 'Unlock PRO Export', modalProCancel: 'Free export (with watermark)', modalProBuy: 'Get PRO €5/mo',
                    toastLoginRequired: 'Sign in to access PRO on any device! 🔐',
                    toastLoggedIn: 'Signed in successfully! ✅',
                    toastLoggedOut: 'Signed out.',
                    toastSubActive: 'PRO subscription active ✅',
                    toastSubCancelled: 'Subscription will expire at end of current period.',
                    toastSubExpired: 'PRO subscription expired. Renew to restore access.',
                    toastLoginError: 'Sign-in error. Please try again.',
                    toastProActivated: 'PRO subscription activated! Welcome! 🎉',
                    subInfoActive: '✅ Your PRO subscription is active and renews automatically.',
                    subInfoNone: 'You have no active PRO subscription.',
                    loginModalTitle: '🔐 Sign In',
                    loginModalBody: 'Create a free account or sign in to access your PRO subscription on any device.',
                    loginGoogleBtn: 'Continue with Google',
                    loginDivider: 'Your data is private and secure',
                    loginCancelBtn: 'Continue without account',
                    manageSubTitle: '⚙️ Your PRO Subscription',
                    manageSubClose: 'Close',
                    cancelSubBtn: 'Cancel subscription',
                    openBillingPortal: 'Manage payments in Stripe →',
                    authNotLogged: 'Not signed in',
                    btnLogin: 'Login',
                    btnLogout: 'Sign out',
                    btnManageSub: 'Subscription',
                    subTrialing: 'Active trial period.',
                    toastFirebaseNotSet: 'Firebase is not configured yet.',
                    toastPortalNotSet: 'Stripe Customer Portal is not configured yet.',
                    planExportLabel: '/ export', planExportDesc: 'Single CV, no subscription',
                    planBadge: 'MOST POPULAR', planMonthlyLabel: '/ month', planMonthlyDesc: 'Unlimited exports',
                    proFeat1: 'PDF without watermark', proFeat2: 'Unlimited JSON export',
                    proFeat3: 'Copy CV text (ATS raw paste)', proFeat4: 'Priority support',
                    orderHint: 'Reorder with ↑↓ buttons. Click the eye 👁 to hide a section in the document.',
                    smartHint: 'Automatically detects dates, roles, companies and relevant skills.',
                    phSmartPaste: 'Ex: Software Engineer at Google (2022 - Present)\n- Built React features\n- Optimized PostgreSQL queries',
                    phJD: 'Paste job requirements and responsibilities here to auto-check match with your CV...',
                    phName: 'John Smith', phTitle: 'Software Engineer', phEmail: 'john@example.com',
                    phPhone: '+44 700 000 000', phLocation: 'London, UK',
                    phLinkedIn: 'linkedin.com/in/username', phGitHub: 'github.com/username',
                    phPortfolio: 'https://portfolio.com', phSummary: 'Brief career summary...',
                    phSkill: 'Ex: React, Node.js, Python',
                    atsHigh: 'CV well optimized for ATS parsers ✅',
                    atsMed: 'Good progress, but improvements needed ⚡',
                    atsLow: 'Major changes recommended ⚠️',
                    atsEmpty: 'Insufficient data for a proper evaluation 🔍',
                    chkEmail: 'Valid email', chkPhone: 'Phone number', chkLocation: 'Location',
                    chkName: 'Full name (≥2 words)', chkTitle: 'Professional title',
                    chkSummary: 'Summary (≥30 chars)', chkExp: 'Work experience added',
                    chkBullets: 'Bullet points in descriptions', chkQty: 'Quantified results (%, numbers)',
                    chkEdu: 'Education completed', chkSkills: 'Relevant skills (≥3)',
                    chkLang: 'Foreign languages', chkCert: 'Certifications',
                    chkLinkedIn: 'LinkedIn configured', chkNoPhoto: 'No photo (ATS-friendly)',
                    chkFont: 'ATS-compatible font', chkProj: 'Projects added',
                    pitPhoto: 'Attached photos may block strict ATS parsers. Consider removing it.',
                    pitEmail: 'Email address is missing or has an incorrect format.',
                    pitPhone: 'Phone number is missing or incomplete.',
                    pitSummary: 'Professional summary is missing or too short. Add a relevant summary.',
                    pitLinkedIn: 'LinkedIn link is missing. Most recruiters check your online profile.',
                    pitExpShort: ' experience(s) have a description that is too brief.',
                    pitSkills: 'Too few skills listed. Add at least 5-10 relevant skills.',
                    pitMissing: 'Required sections missing: ',
                    cpSummary: 'PROFESSIONAL SUMMARY', cpExp: 'WORK EXPERIENCE', cpSkills: 'SKILLS:',
                    secnSummary: 'Summary', secnExperience: 'Experience', secnProjects: 'Projects',
                    secnEducation: 'Education', secnCertifications: 'Certifications', secnLanguages: 'Languages', secnSkills: 'Skills',
                    emptyNothing: 'Nothing added yet', emptyNoLinks: 'No links',
                    skillExists: 'Skill "%s" already exists.', skillHint: 'Type a skill and press Enter.',
                    toastImportOk: 'Data imported successfully!',
                    toastImportErr: 'The JSON file is corrupted or invalid.',
                    toastCopied: 'CV copied to clipboard as plain text! ✅',
                    toastPaid: 'Payment confirmed! PRO mode permanently activated on this browser. ✅',
                    toastStripeNotSet: 'Stripe URL has not been set in the source code yet!',
                    toastProfilCreat: ' has been created!', toastProfilRedenumit: 'Profile renamed successfully!',
                    toastProfilSters: 'Selected profile deleted.',
                    toastProfilUnic: 'You cannot delete the only active profile!',
                    toastProfilComutat: 'Switched to profile: ',
                    toastEdit: 'Editing section: ', toastStorage: 'LocalStorage full! Try a smaller image.',
                    toastJSONOk: 'JSON backup downloaded successfully! ✅',
                    toastSmartEmpty: 'Please enter some raw text first.', toastPhotoSize: 'Photo exceeds 2MB.',
                    toastSmartExpOk: 'Experience added successfully!', toastSmartProjOk: 'Project added successfully!',
                    toastNoProfileDel: 'Cannot delete the only profile!', toastNewProfile: 'New profile name:',
                    toastNewProfileName: 'New Profile', toastRenameProfile: 'Rename profile:',
                    toastConfirmDel: 'Are you sure you want to delete profile "%s"?',
                    modalResetBodyHTML: 'All CV data will be permanently deleted.<br><strong>This action cannot be undone.</strong><br>We recommend exporting a JSON backup first.',
                    modalProBodyHTML: 'The <strong>free</strong> version exports with a subtle watermark. With <strong>PRO</strong> you get a clean PDF, with no watermark.',
                    smartParseDefaultCo: 'Unknown Company', smartParseFree: 'Freelance', smartParseDefaultRole: 'Unspecified Role',
                    smartParseDefaultProj: 'Project', smartParsePresent: 'Present',
                    pageBreakLabel: 'Page %n | A4 Limit',
                    moveUp: 'Move up', moveDown: 'Move down', delItem: 'Delete', delSkill: 'Remove ',
                    showSec: 'Show', hideSec: 'Hide',
                    expYear: ' Year', expYears: ' Years',
                    langHtml: 'en',
                    gdprText: 'We use local storage and secure cookies to save your progress and enable authentication. Your data is private and never sold to third parties.',
                    gdprAcceptBtn: 'I understand and agree',
                    loginGdprLabel: 'By signing in, you agree to the Terms of Service and data processing (Name, Email, Profile Picture) strictly for account management and billing.',
                    atsDisclaimer: 'ℹ️ ATS Analysis is indicative. Company systems may vary depending on the parser used. The goal of this score is to validate keywords and basic formatting.'
                }
            };

            var currentLang = localStorage.getItem('cvpro_lang') || 'ro';

            function t(key) {
                return (I18N[currentLang] && I18N[currentLang][key] !== undefined) ? I18N[currentLang][key] : (I18N.ro[key] || key);
            }

            function applyLang(lang) {
                currentLang = lang;
                localStorage.setItem('cvpro_lang', lang);
                document.documentElement.lang = t('langHtml');

                // Update all data-i18n text elements
                document.querySelectorAll('[data-i18n]').forEach(function(el) {
                    var key = el.getAttribute('data-i18n');
                    var val = t(key);
                    if (val !== undefined) el.textContent = val;
                });

                // Update all placeholder elements
                document.querySelectorAll('[data-i18n-ph]').forEach(function(el) {
                    var key = el.getAttribute('data-i18n-ph');
                    var val = t(key);
                    if (val !== undefined) el.placeholder = val;
                });

                // Update all title elements
                document.querySelectorAll('[data-i18n-title]').forEach(function(el) {
                    var key = el.getAttribute('data-i18n-title');
                    var val = t(key);
                    if (val !== undefined) el.title = val;
                });

                // Language toggle button
                var btn = document.getElementById('langToggle');
                if (btn) btn.textContent = lang === 'ro' ? '🇬🇧 EN' : '🇷🇴 RO';

                // Reset modal body (has HTML)
                var rmb = document.getElementById('resetModalBody');
                if (rmb) rmb.innerHTML = t('modalResetBodyHTML');

                // PRO modal body (has HTML)
                var pmb = document.getElementById('proModalBody');
                if (pmb) pmb.innerHTML = t('modalProBodyHTML');

                // Watermark
                var wm = document.getElementById('cvWatermark');
                if (wm && !App.isPro) wm.textContent = t('watermark');

                // summCtr - update only if empty/default
                var sc = document.getElementById('summCtr');
                if (sc && App.s) App.updSummCtr();
            }

            var LSK='cvpro_v4', LSAC='cvpro_v4_ac', LSTB='cvpro_v4_tab', LSPROF='cvpro_v4_prof';

            var PATHS={
                up:'M10 3a1 1 0 01.707.293l5 5a1 1 0 01-1.414 1.414L11 6.414V17a1 1 0 11-2 0V6.414L5.707 9.707a1 1 0 01-1.414-1.414l5-5A1 1 0 0110 3z',
                down:'M10 17a1 1 0 01-.707-.293l-5-5a1 1 0 011.414-1.414L9 13.586V3a1 1 0 112 0v10.586l3.293-3.293a1 1 0 111.414 1.414l-5 5A1 1 0 0110 17z',
                del:'M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z',
                email:'M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z',
                phone:'M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z',
                location:'M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z',
                link:'M12.586 4.586a2 2 0 112.828 2.828l-3 3a2 2 0 01-2.828 0 1 1 0 00-1.414 1.414 4 4 0 005.656 0l3-3a4 4 0 00-5.656-5.656l-1.5 1.5a1 1 0 101.414 1.414l1.5-1.5zm-5 5a2 2 0 012.828 0 1 1 0 101.414-1.414 4 4 0 00-5.656 0l-3 3a4 4 0 105.656 5.656l1.5-1.5a1 1 0 10-1.414-1.414l-1.5 1.5a2 2 0 11-2.828-2.828l3-3z'
            };

            var T={};
            function deb(k,fn,ms){clearTimeout(T[k]);T[k]=setTimeout(fn,ms||300);}
            var svgC={};
            function ico(name){if(!svgC[name]){var s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox','0 0 20 20');s.setAttribute('aria-hidden','true');var p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('fill-rule','evenodd');p.setAttribute('clip-rule','evenodd');p.setAttribute('d',PATHS[name]||'');s.appendChild(p);svgC[name]=s;}return svgC[name].cloneNode(true);}

            function def(){return{color:'#3b82f6',photo:'',name:'',title:'',email:'',phone:'',location:'',linkedin:'',github:'',portfolio:'',summary:'',links:[],experiences:[],projects:[],educations:[],certifications:[],languages:[],skills:[],font:"'Inter', sans-serif",padding:20,size:14,lh:1.6,gap:24,order:['summary','experience','projects','education','certifications','languages','skills'],hidden:[],jd:''};}

            function norm(d){var b=def();if(!d||typeof d!=='object'||Array.isArray(d))return b;var s=Object.assign({},b,d);['links','experiences','projects','educations','certifications','languages','skills','order','hidden'].forEach(function(k){if(!Array.isArray(s[k]))s[k]=b[k];});s.order=s.order.filter(function(k){return b.order.includes(k);});b.order.forEach(function(k){if(!s.order.includes(k))s.order.push(k);});s.projects=s.projects.map(function(p){return Object.assign({url:''},p);});s.experiences=s.experiences.map(function(e){return Object.assign({desc:''},e);});return s;}

            var $=function(id){return document.getElementById(id);};
            function el(t,c,tx){var e=document.createElement(t);if(c)e.className=c;if(tx)e.textContent=tx;return e;}
            function esc(s){return s ? DOMPurify.sanitize(s + '', { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }) : '';}
            function safeUrl(u){if(!u)return'';var t=u.trim();if(/^(javascript:|data:|vbscript:)/i.test(t))return'#';return t.startsWith('http')?t:'https://'+t;}
            function validEmail(e){return/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e||'');}
            function resize(e){e.style.height='auto';e.style.height=e.scrollHeight+'px';}
            function parseDesc(txt){if(!txt)return'';var cleanTxt = DOMPurify.sanitize(txt, { ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'u', 'br'], ALLOWED_ATTR: [] }); var lines=cleanTxt.split('\n');var html='',inL=false;lines.forEach(function(l){var t=l.trim();if(!t){if(inL){html+='</ul>';inL=false;}return;}var m=t.match(/^[-*]\s+(.*)/);if(m){if(!inL){html+='<ul>';inL=true;}html+='<li>'+m[1]+'</li>';}else{if(inL){html+='</ul>';inL=false;}html+='<p style="margin-bottom:3px">'+t+'</p>';}});if(inL)html+='</ul>';return html;}

            var App={
                s:def(),_st:null,isPro:false,selectedPlan:'monthly',
                profiles:{activeId:'default',list:{default:{name:'Profil Implicit',state:null}}},
                currentUser: null,
                subStatus: null, // 'active' | 'cancelled' | null
                _unsubAuth: null,

                init:function(){
                    this.loadProfiles();
                    this.bindAccordions();
                    this.bindTabs();
                    this.bindModals();
                    this.bindToolbar();
                    this.bindSidebar();
                    this.bindKeys();
                    this.setupClickToEdit();
                    this.initFirebaseAuth();
                    
                    // GDPR Banner Logic
                    if (!localStorage.getItem('cvpro_gdpr')) {
                        var banner = $('gdprBanner');
                        if (banner) banner.classList.remove('hidden');
                    }
                    var gdprBtn = $('gdprAccept');
                    if (gdprBtn) {
                        gdprBtn.addEventListener('click', function() {
                            localStorage.setItem('cvpro_gdpr', '1');
                            $('gdprBanner').classList.add('hidden');
                        });
                    }

                    // Language
                    applyLang(currentLang);
                    var self=this;
                    document.getElementById('langToggle').addEventListener('click',function(){
                        self.setLang(currentLang==='ro'?'en':'ro');
                    });
                    this.renderUI();
                    this.renderCV();
                },

                setLang:function(lang){
                    applyLang(lang);
                    this.fullRender();
                },

                // ─── FIREBASE AUTH ───────────────────────────────────
                initFirebaseAuth: function() {
                    var self = this;
                    if (!firebaseReady) {
                        // Firebase not configured yet — fall back to localStorage
                        self.isPro = localStorage.getItem('cvpro_pro') === '1';
                        self.updateProUI();
                        self.updateAuthUI();
                        self.checkStripeReturn();
                        return;
                    }
                    // Listen for auth state changes (fires immediately with current user)
                    fbAuth.onAuthStateChanged(function(user) {
                        self.currentUser = user;
                        if (user) {
                            self.checkProStatusCloud(function() {
                                self.updateAuthUI();
                                self.updateProUI();
                                self.checkStripeReturn();
                            });
                        } else {
                            // Not logged in — check local cache as fallback
                            self.isPro = localStorage.getItem('cvpro_pro') === '1';
                            self.subStatus = null;
                            self.updateAuthUI();
                            self.updateProUI();
                            self.checkStripeReturn();
                        }
                    });
                },

                checkProStatusCloud: function(cb) {
                    const self = this;
                    
                    if (!firebaseReady || !self.currentUser) {
                        self.isPro = localStorage.getItem('cvpro_pro') === '1';
                        if (cb) cb();
                        return;
                    }

                    fbDb.collection('users').doc(self.currentUser.uid).get()
                        .then((doc) => {
                            if (doc.exists) {
                                const data = doc.data();
                                const isActive = !!data.isPro || (typeof data.exportCredits === 'number' && data.exportCredits > 0);
                                
                                self.isPro = isActive;
                                self.subStatus = data.status || null;
                                
                                localStorage.setItem('cvpro_pro', isActive ? '1' : '0');
                            } else {
                                self.isPro = false;
                                self.subStatus = null;
                                localStorage.removeItem('cvpro_pro');
                            }
                            
                            if (cb) cb();
                        })
                        .catch((err) => {
                            console.warn('Firestore read error:', err);
                            self.isPro = localStorage.getItem('cvpro_pro') === '1';
                            if (cb) cb();
                        });
                },

                updateAuthUI: function() {
                    var user = this.currentUser;
                    var loggedOut = $('authLoggedOut'), loggedIn = $('authLoggedIn');
                    var loginBtn = $('loginOpenBtn'), logoutBtn = $('logoutBtn'), manageBtn = $('manageSubBtn');
                    var avatar = $('authAvatar'), emailSpan = $('authEmailSpan'), proChip = $('authProChip');

                    if (user) {
                        if (loggedOut) loggedOut.style.display = 'none';
                        if (loggedIn) loggedIn.style.display = 'flex';
                        if (loginBtn) loginBtn.style.display = 'none';
                        if (logoutBtn) logoutBtn.style.display = 'block';
                        if (manageBtn) manageBtn.style.display = this.isPro ? 'block' : 'none';
                        if (avatar) {
                            if (user.photoURL) {
                                avatar.innerHTML = '<img src="'+user.photoURL+'" style="width:26px;height:26px;border-radius:50%;object-fit:cover">';
                            } else {
                                avatar.textContent = (user.displayName || user.email || '?').charAt(0).toUpperCase();
                            }
                        }
                        if (emailSpan) emailSpan.textContent = user.displayName || user.email || '';
                        if (proChip) proChip.style.display = this.isPro ? 'inline-block' : 'none';
                    } else {
                        if (loggedOut) loggedOut.style.display = 'flex';
                        if (loggedIn) loggedIn.style.display = 'none';
                        if (loginBtn) loginBtn.style.display = 'block';
                        if (logoutBtn) logoutBtn.style.display = 'none';
                        if (manageBtn) manageBtn.style.display = 'none';
                    }
                },

                loginWithGoogle: function() {
                    if (!firebaseReady) {
                        this.toast(t('toastFirebaseNotSet'), 'error');
                        return;
                    }
                    var gdprCheck = $('loginGdprCheck');
                    if (gdprCheck && !gdprCheck.checked) {
                        this.toast(currentLang === 'ro' ? 'Te rugăm să accepți Termenii și Prelucrarea Datelor pentru a continua.' : 'Please accept the Terms & Data Processing to continue.', 'warning');
                        return;
                    }
                    
                    var self = this;
                    var provider = new firebase.auth.GoogleAuthProvider();
                    fbAuth.signInWithPopup(provider)
                        .then(function(result) {
                            $('loginModal').classList.remove('open');
                            self.toast(t('toastLoggedIn'), 'success');
                        })
                        .catch(function(err) {
                            console.error('Login error:', err);
                            self.toast(t('toastLoginError'), 'error');
                        });
                },

                logout: function() {
                    if (!firebaseReady) return;
                    var self = this;
                    fbAuth.signOut().then(function() {
                        self.isPro = false;
                        self.subStatus = null;
                        localStorage.removeItem('cvpro_pro');
                        self.updateProUI();
                        self.updateAuthUI();
                        self.toast(t('toastLoggedOut'), 'info');
                    });
                },

                openManageSub: function() {
                    var modal = $('manageSubModal');
                    var info = $('manageSubInfo');
                    var cancelBtn = $('cancelSubBtn');
                    var activeStatuses = ['active', 'trialing'];
                    var isActive = this.isPro && activeStatuses.indexOf(this.subStatus) > -1;

                    if (info) {
                        info.innerHTML = isActive
                            ? '<p style="color:var(--ok);margin-bottom:8px">'+t('subInfoActive')+'</p>'
                              + (this.subStatus === 'trialing' ? '<p style="font-size:12px;color:var(--txt3)">'+t('subTrialing')+'</p>' : '')
                            : '<p style="color:var(--err)">'+t('subInfoNone')+'</p>';
                    }
                    if (cancelBtn) cancelBtn.style.display = 'none'; // Gestionat prin Stripe portal
                    if (modal) modal.classList.add('open');
                },

                checkProStatus:function(){
                    // Fallback simplu pentru compatibilitate — logica reală e în initFirebaseAuth
                    if (!firebaseReady) {
                        this.isPro = localStorage.getItem('cvpro_pro') === '1';
                        this.updateProUI();
                    }
                },

                updateProUI:function(){
                    var badge=$('proStatusBadge'),wm=$('cvWatermark');
                    if(this.isPro){if(badge)badge.style.display='inline-block';if(wm)wm.classList.add('hidden');}
                    else{if(badge)badge.style.display='none';if(wm)wm.classList.remove('hidden');}
                    // Actualizează și chip-ul din auth bar
                    var chip = $('authProChip');
                    if (chip) chip.style.display = this.isPro ? 'inline-block' : 'none';
                    var manageBtn = $('manageSubBtn');
                    if (manageBtn) manageBtn.style.display = (this.isPro && this.currentUser) ? 'block' : 'none';
                },

                checkStripeReturn:function(){
                    var params=new URLSearchParams(window.location.search);
                    if(params.has('session_id')){
                        // Stripe a redirecționat înapoi după plată
                        // Cloud Function-ul a setat deja statusul în Firestore
                        // Citim statusul actualizat
                        var self = this;
                        history.replaceState({},'',window.location.pathname);
                        if (firebaseReady && self.currentUser) {
                            // Mic delay pentru a lăsa Cloud Function să scrie în Firestore
                            setTimeout(function() {
                                self.checkProStatusCloud(function() {
                                    self.updateProUI();
                                    self.updateAuthUI();
                                    if (self.isPro) {
                                        self.toast(t('toastProActivated'), 'success');
                                    } else {
                                        // Încearcă din nou după 3 secunde (webhook poate întârzia)
                                        setTimeout(function() {
                                            self.checkProStatusCloud(function() {
                                                self.updateProUI();
                                                self.updateAuthUI();
                                                if (self.isPro) self.toast(t('toastProActivated'), 'success');
                                            });
                                        }, 3000);
                                    }
                                });
                            }, 1500);
                        } else if (!firebaseReady) {
                            // Fallback fără Firebase
                            localStorage.setItem('cvpro_pro','1');
                            this.isPro = true;
                            this.updateProUI();
                            this.toast(t('toastPaid'),'success');
                        }
                    }
                },

                toast:function(msg,type){
                    var box=$('toastBox'),icons={success:'✅',error:'❌',warning:'⚠️',info:'ℹ️'};
                    type=type||'info';
                    var toast=el('div','toast '+type);
                    toast.innerHTML='<span class="toast__i">'+(icons[type]||icons.info)+'</span><span class="toast__m">'+msg+'</span>';
                    box.appendChild(toast);
                    var dismiss=function(){toast.classList.add('out');setTimeout(function(){if(toast.parentNode)toast.remove();},280);};
                    setTimeout(dismiss,3800);toast.addEventListener('click',dismiss,{once:true});
                },

                flashSave:function(){var i=$('saveInd');if(!i)return;i.classList.add('on');clearTimeout(this._st);this._st=setTimeout(function(){i.classList.remove('on');},2000);},

                bindAccordions:function(){
                    var saved=JSON.parse(localStorage.getItem(LSAC)||'{}');
                    document.querySelectorAll('.sec[data-id]').forEach(function(sec){
                        var id=sec.dataset.id;
                        if(saved[id]!==undefined)sec.classList.toggle('open',saved[id]);
                        var hd=sec.querySelector('.sec__hd');
                        if(hd)hd.addEventListener('click',function(){
                            sec.classList.toggle('open');
                            var st=JSON.parse(localStorage.getItem(LSAC)||'{}');
                            st[id]=sec.classList.contains('open');
                            localStorage.setItem(LSAC,JSON.stringify(st));
                        });
                    });
                },

                bindTabs:function(){
                    var self=this;
                    var saved=sessionStorage.getItem(LSTB)||'editor';
                    this.setTab(saved,false);
                    document.querySelectorAll('.tab-btn').forEach(function(b){b.addEventListener('click',function(){self.setTab(b.dataset.tab);});});
                },

                setTab:function(tab,save){
                    document.documentElement.className='tab-'+tab;
                    document.querySelectorAll('.tab-btn').forEach(function(b){var a=b.dataset.tab===tab;b.classList.toggle('active',a);b.setAttribute('aria-pressed',a);});
                    if(save!==false)sessionStorage.setItem(LSTB,tab);
                },

                bindModals:function(){
                    var self=this;

                    // ── Reset Modal ────────────────────────────────────
                    var rm=$('resetModal');
                    $('clearBtn').addEventListener('click',function(){rm.classList.add('open');});
                    $('resetCancel').addEventListener('click',function(){rm.classList.remove('open');});
                    $('resetConfirm').addEventListener('click',function(){
                        [LSK,LSAC,LSPROF].forEach(function(k){localStorage.removeItem(k);});
                        sessionStorage.clear();
                        localStorage.removeItem('cvpro_pro');
                        location.reload();
                    });
                    rm.addEventListener('click',function(e){if(e.target===rm)rm.classList.remove('open');});

                    // ── PRO Modal ──────────────────────────────────────
                    var pm=$('proModal');
                    var planOneTime=$('planOneTime'), planMonthly=$('planMonthly');
                    self.selectedPlan = 'monthly';
                    
                    if(planOneTime && planMonthly) {
                        planOneTime.addEventListener('click', function(){
                            self.selectedPlan = 'onetime';
                            planOneTime.style.borderColor = '#3b82f6';
                            planOneTime.style.background = 'rgba(59,130,246,0.05)';
                            planMonthly.style.borderColor = 'var(--border)';
                            planMonthly.style.background = 'transparent';
                            $('proPayBtn').textContent = 'Cumpără (3 EUR)';
                        });
                        planMonthly.addEventListener('click', function(){
                            self.selectedPlan = 'monthly';
                            planMonthly.style.borderColor = '#3b82f6';
                            planMonthly.style.background = 'rgba(59,130,246,0.05)';
                            planOneTime.style.borderColor = 'var(--border)';
                            planOneTime.style.background = 'transparent';
                            $('proPayBtn').textContent = 'Cumpără PRO';
                        });
                    }

                    $('proCancel').addEventListener('click',function(){
                        pm.classList.remove('open');
                        self.generateSecurePDF();
                    });
                    $('proPayBtn').addEventListener('click',function(){
                        // Dacă utilizatorul nu e autentificat, cere login mai întâi
                        if (firebaseReady && !self.currentUser) {
                            pm.classList.remove('open');
                            $('loginModal').classList.add('open');
                            return;
                        }
                        // Construiește URL-ul Stripe cu firebase UID
                        var url = self.selectedPlan === 'onetime' ? STRIPE_URL_ONETIME : STRIPE_URL_MONTHLY;
                        if (!url || url.startsWith('LIPESTE')) {
                            self.toast('Te rugăm să adaugi linkurile Stripe în app.js', 'error');
                            return;
                        }
                        // Adaugă UID-ul Firebase ca parametru client_reference_id
                        // Stripe îl trimite în webhook și Cloud Function îl folosește
                        if (firebaseReady && self.currentUser) {
                            var sep = url.indexOf('?') > -1 ? '&' : '?';
                            url = url + sep + 'client_reference_id=' + encodeURIComponent(self.currentUser.uid);
                        }
                        window.location.href = url;
                    });
                    pm.addEventListener('click',function(e){if(e.target===pm)pm.classList.remove('open');});

                    // ── Login Modal ────────────────────────────────────
                    var lm = $('loginModal');
                    $('loginOpenBtn').addEventListener('click', function() { lm.classList.add('open'); });
                    $('loginCancel').addEventListener('click', function() { lm.classList.remove('open'); });
                    $('loginGoogleBtn').addEventListener('click', function() { self.loginWithGoogle(); });
                    lm.addEventListener('click', function(e) { if (e.target === lm) lm.classList.remove('open'); });

                    // ── Manage Subscription Modal ──────────────────────
                    var msm = $('manageSubModal');
                    $('manageSubBtn').addEventListener('click', function() { self.openManageSub(); });
                    $('manageSubClose').addEventListener('click', function() { msm.classList.remove('open'); });
                    $('openBillingPortal').addEventListener('click', function() {
                        if (!STRIPE_BILLING_PORTAL || STRIPE_BILLING_PORTAL.startsWith('LIPESTE')) {
                            self.toast(t('toastPortalNotSet'), 'warning');
                            return;
                        }
                        window.open(STRIPE_BILLING_PORTAL, '_blank');
                    });
                    msm.addEventListener('click', function(e) { if (e.target === msm) msm.classList.remove('open'); });

                    // ── Logout ─────────────────────────────────────────
                    $('logoutBtn').addEventListener('click', function() { self.logout(); });

                    // ── Escape key ─────────────────────────────────────
                    document.addEventListener('keydown',function(e){
                        if(e.key==='Escape'){
                            rm.classList.remove('open');
                            pm.classList.remove('open');
                            lm.classList.remove('open');
                            msm.classList.remove('open');
                        }
                    });
                },

                bindToolbar:function(){
                    var self=this;
                    $('printBtn').addEventListener('click',function(){
                        if(self.isPro){
                            self.generateSecurePDF();
                        } else {
                            // Dacă Firebase e activ și userul nu e logat, sugerează login
                            if (firebaseReady && !self.currentUser) {
                                self.toast(t('toastLoginRequired'), 'info');
                                setTimeout(function() { $('loginModal').classList.add('open'); }, 600);
                            } else {
                                $('proModal').classList.add('open');
                            }
                        }
                    });
                    $('exportBtn').addEventListener('click',function(){self.exportJSON();});
                    $('importInput').addEventListener('change',function(e){self.importJSON(e);});
                    $('copyBtn').addEventListener('click',function(){
                        // Copy text e feature PRO
                        if (!self.isPro) { $('proModal').classList.add('open'); return; }
                        self.copyText();
                    });
                    $('atsHd').addEventListener('click',function(){$('atsPanel').classList.toggle('expanded');});
                },

                bindKeys:function(){
                    var self=this;
                    document.addEventListener('keydown',function(e){
                        if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();self.exportJSON();}
                        if((e.ctrlKey||e.metaKey)&&e.key==='p'){e.preventDefault();$('printBtn').click();}
                    });
                },

                generateSecurePDF: async function() {
                    const self = this;
                    if (!CLOUD_FUNCTION_URL || CLOUD_FUNCTION_URL.startsWith('LIPESTE')) {
                        self.toast('Server de randare neconfigurat. Se deschide dialogul de export nativ...', 'info');
                        window.print();
                        return;
                    }

                    const btn = $('printBtn');
                    const originalText = btn.innerHTML;
                    btn.innerHTML = 'Se generează PDF... ⏳';
                    btn.disabled = true;
                    btn.style.opacity = '0.7';
                    btn.style.cursor = 'wait';
                    
                    var loadingOverlay = $('loadingOverlay');
                    if (loadingOverlay) loadingOverlay.classList.remove('hidden');

                    self.toast('Se generează PDF-ul pe server...', 'info');

                    try {
                        let token = null;
                        if (typeof firebase !== 'undefined' && firebase.apps.length && self.currentUser) {
                            token = await self.currentUser.getIdToken();
                        }

                        // OPTIMIZARE: Trimitem doar obiectul curat cu texte și setări grafice (s)
                        const response = await fetch(CLOUD_FUNCTION_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                cvData: self.s, 
                                token: token
                            })
                        });

                        if (!response.ok) throw new Error('Eroare server: ' + response.statusText);

                        const blob = await response.blob();
                        const url = window.URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = (self.s.name || 'CV').replace(/\s+/g, '_') + '.pdf';
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        window.URL.revokeObjectURL(url);
                        
                        self.toast('PDF descărcat cu succes!', 'success');

                    } catch (err) {
                        console.error('Eroare generare PDF:', err);
                        self.toast('Serverul de export este indisponibil momentan. Se deschide dialogul nativ de salvare...', 'info');
                        setTimeout(function() {
                            window.print();
                        }, 600);
                    } finally {
                        btn.innerHTML = originalText;
                        btn.disabled = false;
                        btn.style.opacity = '1';
                        btn.style.cursor = 'pointer';
                        
                        if (loadingOverlay) loadingOverlay.classList.add('hidden');
                    }
                },

                bindSidebar:function(){
                    var self=this;
                    $('in-photo').addEventListener('change',function(e){self.handlePhoto(e);});
                    $('rmPhoto').addEventListener('click',function(){self.s.photo='';$('in-photo').value='';self.fullRender();});
                    ['name','title','email','phone','location','linkedin','github','portfolio'].forEach(function(k){
                        var el2=$('in-'+k);if(!el2)return;
                        el2.addEventListener('input',function(e){
                            self.s[k]=e.target.value;
                            deb(k,function(){self.save();self.renderCV();});
                        });
                    });
                    $('in-summary').addEventListener('input',function(e){
                        self.s.summary=e.target.value;
                        resize(e.target);self.updSummCtr();
                        deb('summary',function(){self.save();self.renderCV();});
                    });
                    $('in-jd').addEventListener('input',function(e){
                        self.s.jd=e.target.value;
                        deb('jd',function(){self.save();self.renderCV();},400);
                    });
                    $('in-color').addEventListener('input',function(e){self.s.color=e.target.value;self.save();self.renderCV();});
                    $('in-font').addEventListener('change',function(e){self.s.font=e.target.value;self.save();self.renderCV();});
                    [['in-pad','padding','vPad','mm'],['in-sz','size','vSz','px'],['in-lh','lh','vLh',''],['in-gap','gap','vGap','px']].forEach(function(arr){
                        var id=arr[0],key=arr[1],vid=arr[2],sfx=arr[3];
                        var el2=$(id);if(!el2)return;
                        el2.addEventListener('input',function(e){
                            var v=parseFloat(e.target.value);
                            self.s[key]=v;$(vid).textContent=v+sfx;
                            deb(key,function(){self.save();self.renderCV();},120);
                        });
                    });
                    $('parseExp').addEventListener('click',function(){self.smartParse('exp');});
                    $('parseProj').addEventListener('click',function(){self.smartParse('proj');});

                    function addDynItem(id,arr,obj){
                        $(id).addEventListener('click',function(){
                            arr.push(JSON.parse(JSON.stringify(obj)));
                            self.fullRender();
                        });
                    }
                    addDynItem('addLink',self.s.links,{label:'',url:''});
                    addDynItem('addExp',self.s.experiences,{company:'',role:'',period:'',desc:''});
                    addDynItem('addProj',self.s.projects,{name:'',tech:'',url:'',period:'',desc:''});
                    addDynItem('addEdu',self.s.educations,{institution:'',degree:'',period:''});
                    addDynItem('addCert',self.s.certifications,{name:'',issuer:'',period:''});
                    addDynItem('addLang',self.s.languages,{name:'',level:''});

                    $('addSkill').addEventListener('click',function(){self.addSkill();});
                    $('in-skill').addEventListener('keypress',function(e){if(e.key==='Enter'){e.preventDefault();self.addSkill();}});

                    $('profileSelect').addEventListener('change',function(e){self.switchProfile(e.target.value);});
                    $('newProfileBtn').addEventListener('click',function(){self.createProfile();});
                    $('renameProfileBtn').addEventListener('click',function(){self.renameProfile();});
                    $('deleteProfileBtn').addEventListener('click',function(){self.deleteProfile();});
                },

                addSkill:function(){
                    var inp=$('in-skill'),v=inp.value.trim();if(!v)return;
                    var s=this.s;
                    if(s.skills.some(function(x){return x.toLowerCase()===v.toLowerCase();})){
                        this.toast(t('skillExists').replace('%s',v),'warning');
                        return;
                    }
                    s.skills.push(v);
                    inp.value='';
                    this.fullRender();
                },

                updSummCtr:function(){
                    var len=this.s.summary.length,c=$('summCtr');if(!c)return;
                    var cls='ok',msg='';
                    if(currentLang==='ro'){
                        if(len<30){cls='bad';msg=len+' - minim 30 caractere';}
                        else if(len<300){cls='warn';msg=len+' - adaugă detalii (ideal: 300-600)';}
                        else if(len<=600){cls='good';msg=len+' lungime ideală';}
                        else{cls='warn';msg=len+' - prea lung (ideal: sub 600)';}
                    } else {
                        if(len<30){cls='bad';msg=len+' - min 30 characters';}
                        else if(len<300){cls='warn';msg=len+' - add more details (ideal: 300-600)';}
                        else if(len<=600){cls='good';msg=len+' ideal length';}
                        else{cls='warn';msg=len+' - too long (ideal: under 600)';}
                    }
                    c.textContent=msg;c.className='char-ctr '+cls;
                },

                handlePhoto:function(e){
                    var self=this,f=e.target.files[0];if(!f)return;
                    if(f.size>2*1024*1024){this.toast(t('toastPhotoSize'),'error');return;}
                    var r=new FileReader();
                    r.onload=function(ev){
                        var img=new Image();
                        img.onload=function(){
                            var c=document.createElement('canvas'),MAX=200,w=img.width,h=img.height;
                            if(w>h){if(w>MAX){h=h*MAX/w;w=MAX;}}else{if(h>MAX){w=w*MAX/h;h=MAX;}}
                            c.width=w;c.height=h;
                            c.getContext('2d').drawImage(img,0,0,w,h);
                            self.s.photo=c.toDataURL('image/jpeg',.75);
                            self.fullRender();
                        };
                        img.src=ev.target.result;
                    };
                    r.readAsDataURL(f);
                },

                smartParse:function(type){
                    var self=this,raw=$('in-smart').value.trim();
                    if(!raw){this.toast(t('toastSmartEmpty'),'warning');return;}
                    var lines=raw.split('\n').map(function(l){return l.trim();}).filter(Boolean);
                    var DRX=[
                        /(?:(?:din|from|între)\s+)?((?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|ian|mai|iun|iul|sept)[.\s\/]*\d{2,4}|\d{2}[.\/]\d{2,4}|\b\d{4}\b)[\s\S]*?(?:-|to|pana|până)\s*(?:[^\s]*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[.\s\/]*\d{2,4}|\d{2}[.\/]\d{2,4}|\b\d{4}\b|prezent|present|current|acum))/i,
                        /((?:\d{2}[.\/])?\b\d{4}\b\s*(?:-|to|pana)\s*(?:\d{2}[.\/])?(?:\b\d{4}\b|prezent|present|current|acum))/i,
                        /((?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|ian|mai|iun|iul|sept)[.\s\/]*\d{2,4})|\b\d{4}\b)/i
                    ];
                    var period='',hIdx=0,rawM='';
                    for(var ri=0;ri<DRX.length;ri++){
                        for(var li=0;li<Math.min(3,lines.length);li++){
                            var m=lines[li].match(DRX[ri]);
                            if(m){rawM=m[0];period=(m[1]||m[0]).trim();hIdx=li;break;}
                        }
                        if(period)break;
                    }
                    var hdr=lines[hIdx]||lines[0],clean=hdr;
                    if(rawM)clean=clean.replace(rawM,'');
                    clean=clean.replace(/[()[\]|]/g,' ').replace(/^[,;.\-\s]+/,'').replace(/[,;.\-\s]+$/,'').trim();
                    var ROLES=['engineer','developer','programmer','manager','lead','specialist','consultant','analyst','architect','intern','administrator','expert','director','coordonator','operator','asistent','agent','reprezentant','officer','designer','tester','inginer','contabil','sofer','driver'];
                    var scoreRole=function(t2){if(!t2)return 0;var s=0;ROLES.forEach(function(r){if(new RegExp('\\b'+r+'\\b','i').test(t2))s+=10;});if(t2.length<30)s+=2;return s;};
                    var splitters=[/\s+la\s+/i,/\s+at\s+/i,/\s+in\s+/i,/\s*-\s*/,/\s*\|\s*/,/\s*,\s*/];
                    var p1=clean,p2='',split=false;
                    for(var si=0;si<splitters.length;si++){
                        var ps=clean.split(splitters[si]);
                        if(ps.length>=2){p1=ps[0].trim();p2=ps.slice(1).join(' ').trim();split=true;break;}
                    }
                    if(split&&scoreRole(p2)>scoreRole(p1)){var tmp=p1;p1=p2;p2=tmp;}
                    if(period){period=period.replace(/\b(pana in|pana la|to|and)\b/gi,'-');period=period.replace(/\s*-\s*/g,' - ');}
                    var descLines=lines.slice(hIdx+1).map(function(l){var c=l.replace(/^[-*\u2022\s\d.)\]]+\s*/,'').trim();return c?'- '+c:'';}).filter(Boolean).join('\n');
                    var SKS=['React','Angular','Vue','Next.js','TypeScript','JavaScript','HTML','CSS','Tailwind','Node.js','Express','Python','Django','Flask','Java','Spring Boot','C++','C#','.NET','PHP','Laravel','Go','Rust','SQL','PostgreSQL','MySQL','MongoDB','Redis','AWS','Azure','GCP','Docker','Kubernetes','CI/CD','Git','GitHub','Linux','Agile','Scrum','REST API','GraphQL','DevOps','Excel','Figma','Office','SAP'];
                    SKS.forEach(function(sk){
                        var e=sk.replace(/[-\/\\^$*+?.()|[\]{}]/g,'\\$&');
                        if(new RegExp('\\b'+e+'\\b','i').test(raw)&&!self.s.skills.some(function(s){return s.toLowerCase()===sk.toLowerCase();})){self.s.skills.push(sk);}
                    });
                    if(type==='exp'){
                        self.s.experiences.push({company:p2||(split?t('smartParseDefaultCo'):t('smartParseFree')),role:p1||t('smartParseDefaultRole'),period:period||t('smartParsePresent'),desc:descLines});
                    } else {
                        self.s.projects.push({name:p1||t('smartParseDefaultProj'),tech:p2||'',url:'',period:period||'',desc:descLines});
                    }
                    $('in-smart').value='';
                    self.fullRender();
                    self.toast(type==='exp'?t('toastSmartExpOk'):t('toastSmartProjOk'),'success');
                },

                calcExp:function(){
                    var now=new Date().getFullYear(),tot=0;
                    (this.s.experiences||[]).forEach(function(e){
                        var ys=(e.period||'').match(/\b\d{4}\b/g);
                        if(ys&&ys.length>=1){var s2=parseInt(ys[0]),end=ys.length>=2?parseInt(ys[1]):/prezent|present|current|acum/i.test(e.period)?now:s2;if(end>=s2)tot+=Math.max(1,end-s2);}
                    });
                    return tot;
                },

                move:function(arr,i,d){var i2=i+d;if(i2<0||i2>=arr.length)return;var tmp=arr[i];arr[i]=arr[i2];arr[i2]=tmp;this.fullRender();},
                del:function(arr,i){arr.splice(i,1);this.fullRender();},
                fullRender:function(){this.save();this.renderUI();this.renderCV();},

                renderUI:function(){
                    var self=this,s=this.s;
                    function sv(id,v){var e=$(id);if(e)e.value=v||'';}
                    ['name','title','email','phone','location','linkedin','github','portfolio','summary'].forEach(function(k){sv('in-'+k,s[k]);});
                    sv('in-jd',s.jd||'');sv('in-color',s.color||'#3b82f6');sv('in-font',s.font);
                    sv('in-pad',s.padding);$('vPad').textContent=s.padding+'mm';
                    sv('in-sz',s.size);$('vSz').textContent=s.size+'px';
                    sv('in-lh',s.lh);$('vLh').textContent=s.lh;
                    sv('in-gap',s.gap);$('vGap').textContent=s.gap+'px';
                    var sumTa=$('in-summary');if(sumTa)resize(sumTa);
                    this.updSummCtr();
                    $('rmPhoto').classList.toggle('hidden',!s.photo);

                    function cBtn2(n,cls2,lbl){var b=el('button','ctrl-btn'+(cls2?' ctrl-btn--'+cls2:''));b.setAttribute('aria-label',lbl);b.appendChild(ico(n));return b;}
                    function ctrls(arr,i){
                        var d=el('div','item-ctrls'),u=cBtn2('up','',t('moveUp')),dn=cBtn2('down','',t('moveDown')),rm=cBtn2('del','del',t('delItem'));
                        u.onclick=function(e){e.stopPropagation();self.move(arr,i,-1);};
                        dn.onclick=function(e){e.stopPropagation();self.move(arr,i,1);};
                        rm.onclick=function(e){e.stopPropagation();self.del(arr,i);};
                        d.append(u,dn,rm);return d;
                    }
                    function bind(inp,obj,key,isTA){
                        inp.value=obj[key]||'';if(isTA)resize(inp);
                        inp.setAttribute('autocomplete','off');
                        inp.oninput=function(e){obj[key]=e.target.value;if(isTA)resize(e.target);deb('f'+key+Math.random(),function(){self.save();self.renderCV();},300);};
                    }
                    function buildSection(contId,items,fields){
                        var cont=$(contId);cont.innerHTML='';
                        if(!items.length){cont.innerHTML='<div class="empty-hint"><b>-</b>'+t('emptyNothing')+'</div>';return;}
                        items.forEach(function(item,i){
                            var card=el('div','item-card');card.appendChild(ctrls(items,i));
                            var fs=el('div','item-card__fields');
                            fields.forEach(function(fd){
                                var f=el('div','field'),lb=el('label','field__lbl',fd.l);
                                if(fd.ta){var inp=el('textarea','field__ta');inp.rows=3;if(fd.ph)inp.placeholder=fd.ph;bind(inp,item,fd.k,true);f.append(lb,inp);}
                                else{var inp=el('input','field__inp');inp.type=fd.k==='url'?'url':'text';if(fd.ph)inp.placeholder=fd.ph;bind(inp,item,fd.k);f.append(lb,inp);}
                                fs.appendChild(f);
                            });
                            card.appendChild(fs);cont.appendChild(card);
                        });
                    }

                    var lc=$('linksCont');lc.innerHTML='';
                    if(!s.links.length){lc.innerHTML='<div class="empty-hint"><b>-</b>'+t('emptyNoLinks')+'</div>';}
                    else s.links.forEach(function(l,i){
                        var card=el('div','item-card');card.appendChild(ctrls(s.links,i));
                        var fs=el('div','item-card__fields');
                        [{k:'label',l:currentLang==='ro'?'Etichetă':'Label',ph:'GitHub'},{k:'url',l:'URL',ph:'https://...'}].forEach(function(fd){
                            var f=el('div','field'),lb=el('label','field__lbl',fd.l),inp=el('input','field__inp');
                            inp.type=fd.k==='url'?'url':'text';inp.placeholder=fd.ph||'';bind(inp,l,fd.k);f.append(lb,inp);fs.appendChild(f);
                        });
                        card.appendChild(fs);lc.appendChild(card);
                    });

                    var isEN=currentLang==='en';
                    buildSection('expCont',s.experiences,[
                        {k:'company',l:isEN?'Company':'Companie',ph:'Google'},
                        {k:'role',l:isEN?'Role':'Rol',ph:'Software Engineer'},
                        {k:'period',l:isEN?'Period':'Perioadă',ph:isEN?'2022 - Present':'2022 - Prezent'},
                        {k:'desc',l:isEN?'Description (- for bullets)':'Descriere (- pentru bullets)',ta:true,ph:isEN?'- Developed...\n- Optimized...':'- Am dezvoltat...\n- Am optimizat...'}
                    ]);
                    buildSection('projCont',s.projects,[
                        {k:'name',l:isEN?'Project':'Proiect',ph:'CV Builder'},
                        {k:'tech',l:isEN?'Technologies':'Tehnologii',ph:'React, Node.js'},
                        {k:'url',l:isEN?'Project URL (optional)':'URL Proiect (opțional)',ph:'https://github.com/...'},
                        {k:'period',l:isEN?'Period':'Perioadă',ph:'2024'},
                        {k:'desc',l:isEN?'Description':'Descriere',ta:true}
                    ]);
                    buildSection('eduCont',s.educations,[
                        {k:'institution',l:isEN?'Institution':'Instituție',ph:isEN?'MIT':'Universitatea Politehnica'},
                        {k:'degree',l:isEN?'Degree / Specialization':'Diplomă / Specializare',ph:isEN?'B.Sc. Computer Science':'Ing. Calculatoare'},
                        {k:'period',l:isEN?'Period':'Perioadă',ph:'2018 - 2022'}
                    ]);
                    buildSection('certCont',s.certifications,[
                        {k:'name',l:isEN?'Certification':'Certificare',ph:'AWS Solutions Architect'},
                        {k:'issuer',l:isEN?'Issuer':'Emitent',ph:'Amazon'},
                        {k:'period',l:isEN?'Year':'An',ph:'2023'}
                    ]);
                    buildSection('langCont',s.languages,[
                        {k:'name',l:isEN?'Language':'Limbă',ph:isEN?'English':'Engleză'},
                        {k:'level',l:isEN?'Level (A1-C2 / Native)':'Nivel (A1-C2 / Nativ)',ph:'C1 Advanced'}
                    ]);

                    var sw=$('skillsWrap');sw.innerHTML='';
                    if(!s.skills.length){sw.innerHTML='<p class="field__hint">'+t('skillHint')+'</p>';}
                    else s.skills.forEach(function(sk,i){
                        var tag=el('div','stag');tag.appendChild(document.createTextNode(sk));
                        var rm2=el('button','stag__rm','✕');rm2.setAttribute('aria-label',t('delSkill')+sk);
                        rm2.onclick=function(){s.skills.splice(i,1);self.fullRender();};
                        tag.appendChild(rm2);sw.appendChild(tag);
                    });

                    var oc=$('orderCont');oc.innerHTML='';
                    var SECN={
                        summary:t('secnSummary'),experience:t('secnExperience'),projects:t('secnProjects'),
                        education:t('secnEducation'),certifications:t('secnCertifications'),languages:t('secnLanguages'),skills:t('secnSkills')
                    };
                    s.order.forEach(function(key,i){
                        var hidden=s.hidden.includes(key),row=el('div','order-row'+(hidden?' hidden-sec':''));
                        var lbl2=el('span','order-row__lbl',SECN[key]||key),cd=el('div','item-ctrls item-ctrls--static');
                        var u2=el('button','ctrl-btn');u2.setAttribute('aria-label',t('moveUp'));u2.appendChild(ico('up'));
                        u2.onclick=function(e){e.stopPropagation();self.move(s.order,i,-1);};
                        var dn2=el('button','ctrl-btn');dn2.setAttribute('aria-label',t('moveDown'));dn2.appendChild(ico('down'));
                        dn2.onclick=function(e){e.stopPropagation();self.move(s.order,i,1);};
                        cd.append(u2,dn2);
                        var eye=el('span','order-row__eye',hidden?'🚫':'👁');eye.setAttribute('role','button');eye.setAttribute('aria-label',hidden?t('showSec'):t('hideSec'));
                        eye.onclick=function(){
                            if(hidden)self.s.hidden=s.hidden.filter(function(h){return h!==key;});
                            else self.s.hidden=s.hidden.concat([key]);
                            self.fullRender();
                        };
                        row.append(lbl2,cd,eye);oc.appendChild(row);
                    });
                    this.renderProfileSelector();
                },

                renderCV:function(){
                    var self=this,s=this.s,root=document.documentElement;
                    root.style.setProperty('--cv-accent',s.color||'#3b82f6');
                    root.style.setProperty('--cv-font',s.font||"'Inter', sans-serif");
                    root.style.setProperty('--cv-pad',(s.padding||20)+'mm');
                    root.style.setProperty('--cv-size',(s.size||14)+'px');
                    root.style.setProperty('--cv-lh',s.lh||1.6);
                    root.style.setProperty('--cv-gap',(s.gap||24)+'px');

                    $('cv-name').textContent=s.name||'';$('cv-role').textContent=s.title||'';
                    var yrs=this.calcExp(),eb=$('cv-expb');
                    if(yrs>0){eb.textContent=yrs+(yrs===1?t('expYear'):t('expYears'))+' Exp.';eb.style.display='inline-block';}
                    else eb.style.display='none';

                    var ph=$('cv-photo');
                    if(s.photo){ph.src=s.photo;ph.style.display='block';}
                    else{ph.style.display='none';ph.src='';}

                    var cont=$('cv-cont');cont.innerHTML='';
                    function ci(tx,icon,href){
                        var d=el('div','cv-ci');d.appendChild(ico(icon));
                        if(href){var a=el('a','',tx);a.href=href;if(href.startsWith('http')){a.target='_blank';a.rel='noopener noreferrer';}d.appendChild(a);}
                        else d.appendChild(document.createTextNode(tx));
                        return d;
                    }
                    if(s.email)cont.appendChild(ci(s.email,'email','mailto:'+s.email));
                    if(s.phone)cont.appendChild(ci(s.phone,'phone','tel:'+s.phone));
                    if(s.location)cont.appendChild(ci(s.location,'location'));
                    if(s.linkedin)cont.appendChild(ci('LinkedIn','link',safeUrl(s.linkedin)));
                    if(s.github)cont.appendChild(ci('GitHub','link',safeUrl(s.github)));
                    if(s.portfolio)cont.appendChild(ci(currentLang==='ro'?'Portofoliu':'Portfolio','link',safeUrl(s.portfolio)));
                    s.links.forEach(function(l){if(l.label&&l.url)cont.appendChild(ci(l.label,'link',safeUrl(l.url)));});

                    function showSec(id,content){var sec=$(id);if(!sec)return;if(content)sec.classList.remove('hidden');else sec.classList.add('hidden');}
                    if(s.summary){showSec('sec-summary',true);$('cv-summ').innerHTML=parseDesc(s.summary);}
                    else showSec('sec-summary',false);

                    function buildList(secId,listId,items,renderFn){
                        var list=$(listId);list.innerHTML='';
                        if(items&&items.length){showSec(secId,true);items.forEach(function(item){list.appendChild(renderFn(item));});}
                        else showSec(secId,false);
                    }
                    buildList('sec-exp','cv-exp',s.experiences,function(e){
                        var d=el('div','cv-item'),h=el('div','cv-item__hdr');h.append(el('div','cv-item__title',e.role),el('div','cv-item__date',e.period));
                        d.appendChild(h);d.appendChild(el('div','cv-item__sub',e.company));
                        if(e.desc){var txt=el('div','cv-text');txt.innerHTML=parseDesc(e.desc);d.appendChild(txt);}
                        return d;
                    });
                    buildList('sec-proj','cv-proj',s.projects,function(p){
                        var d=el('div','cv-item'),h=el('div','cv-item__hdr'),tEl=el('div','cv-item__title');
                        if(p.url){var a=el('a','',p.name);a.href=safeUrl(p.url);a.target='_blank';a.rel='noopener noreferrer';a.style.color='inherit';tEl.appendChild(a);}
                        else tEl.textContent=p.name;
                        h.append(tEl,el('div','cv-item__date',p.period));d.appendChild(h);d.appendChild(el('div','cv-item__sub',p.tech));
                        if(p.desc){var txt=el('div','cv-text');txt.innerHTML=parseDesc(p.desc);d.appendChild(txt);}
                        return d;
                    });
                    buildList('sec-edu','cv-edu',s.educations,function(e){
                        var d=el('div','cv-item'),h=el('div','cv-item__hdr');h.append(el('div','cv-item__title',e.degree),el('div','cv-item__date',e.period));
                        d.appendChild(h);d.appendChild(el('div','cv-item__sub',e.institution));return d;
                    });
                    buildList('sec-cert','cv-cert',s.certifications,function(c){
                        var d=el('div','cv-item'),h=el('div','cv-item__hdr');h.append(el('div','cv-item__title',c.name),el('div','cv-item__date',c.period));
                        d.appendChild(h);d.appendChild(el('div','cv-item__sub',c.issuer));return d;
                    });

                    var langList=$('cv-lang');langList.innerHTML='';
                    if(s.languages&&s.languages.length){showSec('sec-lang',true);s.languages.forEach(function(l){if(l.name)langList.appendChild(el('div','cv-pill',l.level?l.name+' — '+l.level:l.name));});}
                    else showSec('sec-lang',false);

                    var skillList=$('cv-skills');skillList.innerHTML='';
                    if(s.skills&&s.skills.length){showSec('sec-skills',true);s.skills.forEach(function(sk){skillList.appendChild(el('div','cv-pill',sk));});}
                    else showSec('sec-skills',false);

                    var SM={summary:'sec-summary',experience:'sec-exp',projects:'sec-proj',education:'sec-edu',certifications:'sec-cert',languages:'sec-lang',skills:'sec-skills'};
                    var cvDoc=$('cvDoc');
                    s.order.forEach(function(key){
                        var secEl=document.getElementById(SM[key]);if(!secEl)return;
                        if(s.hidden.includes(key))secEl.classList.add('hidden');
                        cvDoc.appendChild(secEl);
                    });
                    var wm=$('cvWatermark');if(wm)cvDoc.appendChild(wm);

                    deb('ats',function(){self.runATS();self.updatePageBreaks();},500);
                    this.updateProUI();
                    // Re-apply i18n for CV section titles after re-render
                    document.querySelectorAll('#cvDoc [data-i18n]').forEach(function(el2){
                        var key=el2.getAttribute('data-i18n');
                        var val=t(key);
                        if(val!==undefined)el2.textContent=val;
                    });
                },

                setupClickToEdit:function(){
                    var self=this;
                    var preview=$('cvDoc');if(!preview)return;
                    preview.addEventListener('click',function(e){
                        var current=e.target;
                        while(current&&current!==preview){
                            if(current.id&&current.id.startsWith('sec-')){
                                var sectionKey=current.id.replace('sec-','');
                                var mappedId=sectionKey;
                                if(sectionKey==='summary')mappedId='personal';
                                var secEl=document.querySelector('.sec[data-id="'+mappedId+'"]');
                                if(secEl){
                                    if(!secEl.classList.contains('open')){
                                        secEl.classList.add('open');
                                        var st=JSON.parse(localStorage.getItem(LSAC)||'{}');
                                        st[mappedId]=true;
                                        localStorage.setItem(LSAC,JSON.stringify(st));
                                    }
                                    secEl.scrollIntoView({behavior:'smooth',block:'start'});
                                    var firstInp=secEl.querySelector('input, textarea');
                                    if(firstInp)firstInp.focus();
                                    var lbl=secEl.querySelector('.sec__label');
                                    self.toast(t('toastEdit')+(lbl?lbl.textContent:''),'info');
                                }
                                break;
                            }
                            current=current.parentElement;
                        }
                    });
                },

                updatePageBreaks:function(){
                    var doc=$('cvDoc');if(!doc)return;
                    doc.querySelectorAll('.page-break-indicator').forEach(function(el2){el2.remove();});
                    var docHeight=doc.scrollHeight;
                    var temp=document.createElement('div');
                    temp.style.height='297mm';temp.style.position='absolute';temp.style.visibility='hidden';
                    document.body.appendChild(temp);
                    var a4PxHeight=temp.clientHeight;
                    document.body.removeChild(temp);
                    if(docHeight>a4PxHeight){
                        var numPages=Math.ceil(docHeight/a4PxHeight);
                        for(var i=1;i<numPages;i++){
                            var topPos=i*a4PxHeight;
                            var indicator=el('div','page-break-indicator');
                            indicator.style.top=topPos+'px';
                            var lbl=el('span','page-break-label',t('pageBreakLabel').replace('%n',i));
                            indicator.appendChild(lbl);
                            doc.appendChild(indicator);
                        }
                    }
                },

                runATS:function(){
                    var self=this,s=this.s,score=0,checks=[];
                    function chk(lbl,pts,pass,isPenalty){
                        checks.push({lbl:lbl,pts:pts,pass:pass,isPenalty:isPenalty});
                        if(isPenalty){if(pass)score-=pts;}else{if(pass)score+=pts;}
                    }
                    chk(t('chkLocation')||'Locatie',5,!!s.location);
                    chk(t('chkName')||'Nume Complet',8,!!(s.name&&s.name.trim().split(/\s+/).length>=2));
                    chk(t('chkTitle')||'Titlu Job',7,!!s.title);
                    chk(t('chkSummary')||'Sumar Profesional',10,s.summary.length>=30);
                    chk(t('chkExp')||'Experienta',10,!!(s.experiences&&s.experiences.length));
                    
                    var expDesc=(s.experiences||[]).map(function(e){return (e.role+' '+e.company+' '+e.desc).toLowerCase();}).join(' ');
                    chk('Verbe de Actiune',5,/\b(coordonat|dezvoltat|implementat|condus|optimizat|realizat|managed|led|created|achieved|improved)\b/i.test(expDesc));
                    chk(t('chkBullets')||'Formatare Bullets',5,/(^|\n)[-*]/m.test(expDesc));
                    chk(t('chkQty')||'Cuantificare Rezultate',10,/\d+[%x]\s|\d+\s*(k|mii|mil|lei|usd|euro)/i.test(expDesc));
                    chk('Date Cronologice (An)',5,/\b(19\d{2}|20\d{2})\b/.test(expDesc));
                    
                    chk(t('chkEdu')||'Educatie',6,!!(s.educations&&s.educations.length));
                    chk(t('chkSkills')||'Aptitudini Tehnice',8,(s.skills&&s.skills.length||0)>=3);
                    
                    var skillsInContext = (s.skills||[]).filter(function(sk){ return expDesc.includes(sk.toLowerCase()); }).length;
                    chk('Aptitudini In Context',5, s.skills && s.skills.length > 0 && skillsInContext > 0);
                    
                    chk(t('chkLang')||'Limbi Straine',4,!!(s.languages&&s.languages.length));
                    chk(t('chkCert')||'Certificari',3,!!(s.certifications&&s.certifications.length));
                    chk(t('chkLinkedIn')||'Link LinkedIn',4,!!s.linkedin||s.links.some(function(l){return l.url&&l.url.toLowerCase().includes('linkedin');}));
                    chk(t('chkNoPhoto')||'Fara Fotografie',3,!s.photo);
                    var fl=(s.font||'').toLowerCase();chk(t('chkFont')||'Font Standard',2,fl.includes('inter')||fl.includes('roboto')||fl.includes('arial'));
                    
                    var allText = (s.summary + ' ' + expDesc).toLowerCase();
                    chk('Cuvinte de Umplutura (Fluff)', 5, /\b(punctual|muncitor|atent la detalii|jucator de echipa|hardworking|perfectionist|synergy)\b/i.test(allText), true);
                    chk('Wall of Text (Sumar prea lung)', 5, (s.summary&&s.summary.length>600&&!s.summary.includes('\n')), true);

                    var pct=Math.min(100,Math.round(score)),cls=pct>=70?'high':pct>=40?'medium':'low';
                    var badge=$('atsBadge');badge.textContent=pct;badge.className='ats-badge '+cls;
                    var mini=$('atsMini');mini.textContent='ATS '+pct;mini.className='ats-mini '+cls;
                    $('atsBar').style.width=pct+'%';
                    $('atsBar').style.background=pct>=70?'var(--ok)':pct>=40?'var(--warn)':'var(--err)';
                    $('atsLbl').textContent=pct>=80?t('atsHigh'):pct>=60?t('atsMed'):pct>=40?t('atsLow'):t('atsEmpty');

                    $('atsGrid').innerHTML=checks.map(function(c){
                        return '<div class="ats-chk"><span class="ats-chk__lbl" title="'+esc(c.lbl)+'">'+esc(c.lbl)+'</span><span class="ats-chk__val '+(c.pass?'pass':'fail')+'">'+(c.pass?('+ '+c.pts):'✗ 0')+'</span></div>';
                    }).join('');

                    this.renderKws();this.renderPits();this.renderJDMatch();
                },

                renderKws:function(){
                    var s=this.s,all=[s.summary,s.title].concat((s.experiences||[]).reduce(function(a,e){return a.concat([e.role,e.company,e.desc]);},[])).concat((s.projects||[]).reduce(function(a,p){return a.concat([p.name,p.tech,p.desc]);},[])).concat(s.skills||[]).join(' ').toLowerCase();
                    var KWS=['management','leadership','team','agile','scrum','analiza','dezvoltare','implementare','optimizare','coordonare','comunicare','colaborare','inovare','digital','performanta','client','vanzari','calitate','securitate','testare','automatizare','javascript','python','java','react','angular','vue','node','sql','aws','docker','kubernetes','git','api','cloud','devops'];
                    var cnt={};KWS.forEach(function(k){var m=all.match(new RegExp('\\b'+k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','g'));if(m)cnt[k]=m.length;});
                    var top=Object.entries(cnt).sort(function(a,b){return b[1]-a[1];}).slice(0,10);
                    var sec=$('atsKws');if(!top.length){sec.classList.add('hidden');return;}sec.classList.remove('hidden');
                    var mx=top[0][1];
                    $('atsKwList').innerHTML=top.map(function(arr){
                        return '<div class="kw-row"><span class="kw-row__name">'+arr[0]+'</span><div class="kw-row__bar"><div class="kw-row__fill" style="width:'+Math.round(arr[1]/mx*100)+'%"></div></div><span class="kw-row__cnt">'+arr[1]+'</span></div>';
                    }).join('');
                },

                renderPits:function(){
                    var s=this.s,p=[];
                    if(s.photo)p.push(t('pitPhoto'));
                    if(!validEmail(s.email||''))p.push(t('pitEmail'));
                    if(!s.phone||(s.phone.replace(/\D/g,'').length<7))p.push(t('pitPhone'));
                    if(s.summary.length<30)p.push(t('pitSummary'));
                    if(!s.linkedin&&!s.links.some(function(l){return l.url&&l.url.includes('linkedin');}))p.push(t('pitLinkedIn'));
                    var shortExp=(s.experiences||[]).filter(function(e){return!e.desc||e.desc.length<20;});
                    if(shortExp.length)p.push(shortExp.length+t('pitExpShort'));
                    if((s.skills||[]).length<5)p.push(t('pitSkills'));
                    var missing=[];if(!(s.experiences&&s.experiences.length))missing.push(t('secnExperience'));if(!(s.educations&&s.educations.length))missing.push(t('secnEducation'));
                    if(missing.length)p.push(t('pitMissing')+missing.join(', ')+'.');
                    $('atsPits').innerHTML=p.map(function(txt){return '<div class="pitfall"><span class="pitfall__i">⚠️</span>'+txt+'</div>';}).join('');
                },

                renderJDMatch:function(){
                    var jd=(this.s.jd||'').trim(),panel=$('jdMatchPanel');
                    if(!jd){panel.classList.add('hidden');return;}panel.classList.remove('hidden');
                    var cvText=[this.s.summary,this.s.title].concat((this.s.experiences||[]).reduce(function(a,e){return a.concat([e.role,e.company,e.desc]);},[])).concat(this.s.skills||[]).join(' ').toLowerCase();
                    var jdWords=jd.toLowerCase().match(/\b\w{4,}\b/g)||[];
                    var stopWords=['este','sunt','care','pentru','prin','unde','dupa','inainte','avem','avut','poate','putem','trebuie','face','with','that','have','this','from','will','your','they','them','been','were','their','what','when','more','also','than','into','some','each','most','these','those'];
                    var jdKws=jdWords.filter(function(w){return!stopWords.includes(w);}).filter(function(v,i,a){return a.indexOf(v)===i;});
                    var matched=jdKws.filter(function(w){return new RegExp('\\b'+w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b').test(cvText);});
                    var missing=jdKws.filter(function(w){return!matched.includes(w);}).slice(0,12);
                    var pct=jdKws.length?Math.round(matched.length/Math.min(jdKws.length,30)*100):0;
                    $('jdScoreText').textContent=Math.min(100,pct)+'%';
                    $('jdMissingList').innerHTML=missing.map(function(w){return '<span style="background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);color:#fca5a5;font-size:11px;padding:2px 8px;border-radius:12px;">'+w+'</span>';}).join('');
                },

                copyText:function(){
                    var s=this.s,L=[];
                    if(s.name)L.push(s.name.toUpperCase(),'');if(s.title)L.push(s.title,'');
                    var c=[];if(s.email)c.push(s.email);if(s.phone)c.push(s.phone);if(s.location)c.push(s.location);if(s.linkedin)c.push(s.linkedin);if(s.github)c.push(s.github);if(s.portfolio)c.push(s.portfolio);s.links.forEach(function(l){if(l.label&&l.url)c.push(l.label+': '+l.url);});
                    if(c.length){L.push(c.join(' | '),'');}
                    if(s.summary){L.push(t('cpSummary'),'--',s.summary,'');}
                    if(s.experiences&&s.experiences.length){
                        L.push(t('cpExp'),'--');s.experiences.forEach(function(e){
                            L.push(e.role+' — '+e.company+' ('+e.period+')');
                            if(e.desc)e.desc.split('\n').forEach(function(ln){L.push(ln.trim());});L.push('');
                        });
                    }
                    if(s.skills&&s.skills.length)L.push(t('cpSkills')+' '+s.skills.join(' / '),'');
                    var txt=L.join('\n');
                    if(navigator.clipboard){
                        navigator.clipboard.writeText(txt).then(function(){App.toast(t('toastCopied'),'success');}).catch(function(){var ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();App.toast(t('toastCopied'),'success');});
                    } else {
                        var ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();this.toast(t('toastCopied'),'success');
                    }
                },

                save:function(){
                    try{
                        this.profiles.list[this.profiles.activeId].state=JSON.parse(JSON.stringify(this.s));
                        localStorage.setItem(LSPROF,JSON.stringify(this.profiles));
                        this.flashSave();
                    }
                    catch(e){if(e.name==='QuotaExceededError')this.toast(t('toastStorage'),'error');}
                },

                loadProfiles:function(){
                    var raw=localStorage.getItem(LSPROF);
                    if(raw){try{this.profiles=JSON.parse(raw);}catch(e){}}
                    var active=this.profiles.list[this.profiles.activeId];
                    if(active&&active.state){this.s=norm(active.state);}
                },

                switchProfile:function(id){
                    if(!this.profiles.list[id])return;
                    this.profiles.activeId=id;
                    this.s=norm(this.profiles.list[id].state||{});
                    this.save();this.fullRender();
                    this.toast(t('toastProfilComutat')+this.profiles.list[id].name,'info');
                },

                createProfile:function(){
                    var name=prompt(t('toastNewProfile'),t('toastNewProfileName'));if(!name)return;
                    var id='prof_'+Date.now();
                    this.profiles.list[id]={name:name,state:JSON.parse(JSON.stringify(this.s))};
                    this.profiles.activeId=id;
                    this.save();this.fullRender();
                    this.toast('"'+name+'"'+t('toastProfilCreat'),'success');
                },

                renameProfile:function(){
                    var curr=this.profiles.list[this.profiles.activeId],newName=prompt(t('toastRenameProfile'),curr.name);
                    if(!newName)return;
                    curr.name=newName;this.save();this.renderProfileSelector();
                    this.toast(t('toastProfilRedenumit'),'success');
                },

                deleteProfile:function(){
                    var keys=Object.keys(this.profiles.list);
                    if(keys.length<=1){this.toast(t('toastProfilUnic'),'warning');return;}
                    var curr=this.profiles.list[this.profiles.activeId];
                    if(!confirm(t('toastConfirmDel').replace('%s',curr.name)))return;
                    var toDelete=this.profiles.activeId,nextId=keys.find(function(k){return k!==toDelete;});
                    delete this.profiles.list[toDelete];
                    this.profiles.activeId=nextId;
                    this.s=norm(this.profiles.list[nextId].state||{});
                    this.save();this.fullRender();
                    this.toast(t('toastProfilSters'),'info');
                },

                renderProfileSelector:function(){
                    var sel=$('profileSelect');if(!sel)return;
                    sel.innerHTML='';
                    var self=this;
                    Object.keys(this.profiles.list).forEach(function(id){
                        var opt=document.createElement('option');
                        opt.value=id;opt.textContent=self.profiles.list[id].name;
                        opt.selected=id===self.profiles.activeId;
                        sel.appendChild(opt);
                    });
                },

                exportJSON:function(){
                    var dt=new Date().toISOString().slice(0,10);
                    var name=(this.s.name||'CV').replace(/\s+/g,'_');
                    var a=document.createElement('a');
                    a.href='data:text/json;charset=utf-8,'+encodeURIComponent(JSON.stringify(this.s,null,2));
                    a.download=name+'_'+dt+'.json';
                    document.body.appendChild(a);a.click();a.remove();
                    this.toast(t('toastJSONOk'),'success');
                },

                importJSON:function(e){
                    var self=this,f=e.target.files[0];if(!f)return;
                    var r=new FileReader();
                    r.onload=function(ev){
                        try{
                            self.s=norm(JSON.parse(ev.target.result));
                            self.fullRender();
                            self.toast(t('toastImportOk'),'success');
                        }catch(err){self.toast(t('toastImportErr'),'error');}
                    };
                    r.readAsText(f);e.target.value='';
                }
            };

            window.App = App;
            App.init();
        })();