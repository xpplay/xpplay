# Deployment Guide — XP PLAY Member System

## 1. Environment Variables
Aplikasi berjalan out-of-the-box tanpa memerlukan secret tambahan (CAPTCHA gambar SVG bertanda tangan HMAC dan Firebase Client Auth aktif otomatis):
- `APP_URL`: URL publik aplikasi (di-inject otomatis oleh AI Studio).
- *(Opsional untuk hosting eksternal)* `FIREBASE_SERVICE_ACCOUNT_JSON`, `VITE_RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET_KEY`, `CAPTCHA_HMAC_SECRET`, `BOOTSTRAP_SUPER_ADMIN_EMAILS`.

## 2. Firebase Configuration Checklist
1. Pastikan `firebase-applet-config.json` mengarah ke `projectId: "adept-extension-t40px"` dan `firestoreDatabaseId` yang benar.
2. Aktifkan **Email/Password** pada **Firebase Authentication → Sign-in method**.
3. Deploy Firestore Security Rules:
   ```bash
   firebase deploy --only firestore:rules
   ```
4. Deploy Firestore Composite Indexes (`firestore.indexes.json`):
   ```bash
   firebase deploy --only firestore:indexes
   ```

## 3. Build & Start Production
```bash
npm install
npm run lint
npm run lint:rules
npm test
npm run build
NODE_ENV=production npm start
```

## 4. Production Verification Checklist
- [ ] `NODE_ENV=production` berjalan pada port `3000`.
- [ ] Provider **Email/Password** aktif di Firebase Authentication.
- [ ] `firestore.rules` lolos `npm run lint:rules` tanpa error.
- [ ] Akun Super Admin (`spv.xpplay@gmail.com`) berhasil aktivasi, verifikasi email, dan login di `/admin/login`.
