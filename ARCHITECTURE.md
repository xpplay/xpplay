# Architecture — XP PLAY Member System

## Ringkasan Arsitektur
Aplikasi dibangun menggunakan arsitektur **Full-Stack Authoritative Hybrid** pada port `3000`:

1. **Frontend (`src/`)**: React 19 + TypeScript + Tailwind CSS v4 + React Router v7.
   - Member Portal (`/member`, `/login`, `/register`) berdesain *mobile-first* dengan bottom navigation bar (`44px+` touch hitbox) dan layout responsif hingga desktop 1440px.
   - Admin Console (`/admin`, `/admin/login`) menggunakan sidebar 19 modul dengan kontrol RBAC (`SUPER_ADMIN`, `ADMIN`, `STAFF`).
2. **Backend (`server.ts` + `src/server/`)**: Express + TypeScript (`tsx`).
   - Melayani API otoritatif di `/api/*` dan SPA frontend via `vite.middlewares` (dev) atau `dist/` (prod).
   - **CAPTCHA Service** (`src/server/services/captchaService.ts`): Verifikasi server-side Google reCAPTCHA (jika dikonfigurasi) atau tantangan SVG bertanda tangan HMAC-SHA256 dengan TTL 5 menit dan pencegahan replay.
   - **Evidence Upload Guard** (`src/server/routes/api.ts`): Validasi magic bytes (JPG/PNG/WEBP), batas ukuran 5 MB, penyimpanan terisolasi per `memberUid`, dan endpoint baca terotorisasi (hanya pemilik atau Admin).
   - **XP Engine Server** (`src/server/services/xpEngineServer.ts`): Menggunakan Firebase Admin SDK untuk registrasi username/WhatsApp, login anti-enumeration dengan custom token, transaksi XP atomik, approval claim/redemption idempoten, dan reset cycle.
3. **Database & Rules (`firestore.rules`, `storage.rules`, `firebase-blueprint.json`)**:
   - Firestore dengan database bernama sesuai `firebase-applet-config.json`.
   - Zero-Trust Rules memastikan member tidak pernah dapat memodifikasi XP, level, saldo, approval, transaksi, atau konfigurasi sistem langsung dari client SDK.
