# Security Architecture — XP PLAY

## Prinsip Zero-Trust
1. **Firestore Rules (`firestore.rules`)**:
   - Default deny (`allow read, write: if false`).
   - Member hanya dapat membaca dokumen miliknya (`uid == request.auth.uid`) dan katalog publik yang aktif.
   - Member **dilarang keras** mengubah `xpProgress`, `xpReward`, `currentLevel`, `status`, `referredBy*`, `lastPlay*`, `transactions`, `claims` status terminal, `redemptions` status terminal, `levels`, `systemSettings`, `admins`, atau `auditLogs`.
   - `identityIndex` diblokir total dari client SDK (`allow read, write: if false`).
   - Seluruh aturan divalidasi dengan `@firebase/eslint-plugin-security-rules`.
2. **Idempotency & Anti-Fraud**:
   - Approval Claim & Redemption memeriksa `status === 'ON_PROCESS'` di dalam `runTransaction` sehingga tidak mungkin terjadi *double credit* maupun *double deduction*.
   - Saldo `xpReward` dicek `>= xpCost` secara atomik sebelum dipotong.
   - Referral hanya berlaku saat registrasi, menolak *self-referral*, dan memastikan username & WhatsApp unik.
3. **Upload Bukti Foto (`storage.rules` & `/api/claims/evidence`)**:
   - Validasi magic bytes (`JPG`, `PNG`, `WEBP`), ukuran maksimum `5 MB`, dan isolasi direktori per `memberUid`.
   - Akses unduh bukti hanya diizinkan untuk pemilik file atau Admin aktif setelah verifikasi Firebase ID Token.
