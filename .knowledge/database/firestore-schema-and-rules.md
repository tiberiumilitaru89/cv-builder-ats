---
id: firestore-schema-and-rules
domain: database-schema
last_verified: 2026-10-08
dependencies: [cv-builder-ats-root-index]
---

# Model de Date & Reguli de Securitate Firestore

## 1. Structura Colecției `users/{userId}`

Fiecare utilizator autentificat via Firebase Auth are un document unic asociat cu cheia `userId = auth.uid`:

```typescript
interface UserDocument {
  email: string;
  isPro?: boolean;
  exportCredits?: number;
  stripeCustomerId?: string;
  subscriptionId?: string;
  proActivatedAt?: FirebaseFirestore.Timestamp;
}
```

### Invariante de Securitate (Zero-Client Mutations):
* Utilizatorii **nu au drept de scriere directă** pe documentul rădăcină `users/{userId}`.
* Mutațiile stării de abonament (`isPro`, `exportCredits`) sunt efectuate **exclusiv de procese de backend de încredere** (Firebase Admin SDK în cadrul `stripeWebhook` sau la decrementarea creditelor în `generatePDF`).

## 2. Subcolecția `users/{userId}/drafts/{draftId}`

Permite utilizatorilor autentificați să își sincronizeze și stocheze în siguranță draft-urile de CV în Cloud:

```typescript
interface CVDraftDocument {
  updatedAt: FirebaseFirestore.Timestamp;
  cvData: Record<string, unknown>;
  name?: string;
}
```

Regula de securitate aplicată:
```javascript
match /users/{userId}/drafts/{draftId} {
  allow read, write: if request.auth != null && request.auth.uid == userId;
}
```
Această separare garantează că un utilizator își poate modifica CV-ul fără a putea modifica câmpurile financiare `isPro` sau `exportCredits`.
