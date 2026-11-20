# Architecture — XP PLAY Member System

## Ringkasan Arsitektur
Aplikasi dibangun menggunakan arsitektur **Full-Stack Authoritative Hybrid** pada port `3000`:

1. **Frontend (`src/`)**: React 19 + TypeScript + Tailwind CSS v4 + React Router v7.
   - Member Portal (`/member`, `/login`, `/register`) berdesain *mobile-first* dengan 4 tab navigasi bawah (`Ringkasan`, `Benefit`, `Riwayat`, `Profil` dengan `44px+` touch hitbox), tampilan saldo `XP Reward Tersedia` vs `Ditahan (Hold)`, kode voucher `BRQ-...` dengan countdown 7 hari, form Tanggal Lahir & Status Member, serta dukungan Maintenance Mode real-time saat Restore Lock aktif.
   - Admin Console (`/admin`, `/admin/login`) menggunakan sidebar terstruktur dengan RBAC (`SUPER_ADMIN`, `ADMIN`, `STAFF`), mencakup Dashboard Overview Member Baru & Notifikasi `NEW_MEMBER_REGISTERED`, **Benefit Requests & Kasir** (`AdminBenefitRequests.tsx`), **8-Tab Member Detail Drawer** (`AdminMemberDetail.tsx`), **Riwayat XP Ledger 12 kolom** (`AdminXpHistory.tsx`), filter/sorting Member & Transaksi lanjutan, CMS Homepage Studio, XP Adjustment, Level Override, Manajemen Password Member, Inactive Members, serta Backup/Restore (26 koleksi) + **15-Point Integrity Audit** & 9-Component System Health.
2. **Backend (`server.ts` + `src/server/`)**: Express + TypeScript (`tsx`).
   - Melayani API otoritatif di `/api/*` dan SPA frontend via `vite.middlewares` (dev) atau `dist/` (prod).
   - **Restore Lock Middleware** (`src/server/middleware/authMiddleware.ts` — `requireSystemNotLocked()`): Memblokir seluruh endpoint mutasi operasional dengan HTTP `503 RESTORE_IN_PROGRESS` saat restore aktif, dan mengekspos status publik `GET /api/system/maintenance`.
   - **CAPTCHA Service** (`src/server/services/captchaService.ts`): Verifikasi server-side Google reCAPTCHA (jika dikonfigurasi) atau tantangan SVG bertanda tangan HMAC-SHA256 dengan TTL 5 menit dan pencegahan replay.
   - **Evidence & CMS Asset Upload Guard** (`src/server/routes/api.ts`): Validasi magic bytes (JPG/PNG/WEBP), batas ukuran 5 MB, penyimpanan terisolasi per `memberUid`/CMS, dan endpoint baca terotorisasi.
   - **XP Engine Server** (`src/server/services/xpEngineServer.ts`): Menggunakan Firebase Admin SDK untuk registrasi username/WhatsApp (termasuk Tanggal Lahir, Status Member & notifikasi member baru Admin), login anti-enumeration, transaksi XP atomik, **Unified Benefit Request + Immediate XP Hold + 7-Day Approval/Deny Auto-Refund + Cashier `MARK AS USED` + Batch Expiry (`POST /api/benefit-requests`, `/api/admin/benefit-requests/*`)**, approval legacy claim/redemption, penyesuaian XP, override level, penggantian password member, dan reset cycle.
   - **Backup, Verification, Restore & Integrity Engine** (`src/server/services/backupRestoreService.ts`, `src/shared/backupRestoreLogic.ts`, `src/shared/integrityLogic.ts`): Schema `xpplay-schema-v3` (26 koleksi), 9-check backup verification, collision lock, mandatory Pre-Restore Backup, Restore Lock, Post-Restore Verification, **15-Point Data Integrity Audit**, dan 9-Component System Health.
3. **Database & Rules (`firestore.rules`, `storage.rules`, `firebase-blueprint.json`, `firestore.indexes.json`)**:
   - Firestore dengan database bernama sesuai `firebase-applet-config.json`.
   - Zero-Trust Rules menegakkan atomisitas XP Hold (`BENEFIT_REQUEST_HOLD`), state machine ketat pada `benefitRequests`, proteksi anti-tampering biaya/grant katalog, pembatasan notifikasi `new_member_<uid>`, validasi `birthDate`/`memberCategory`/`refundOnExpiry`, pemblokiran saat `isSystemRestoreLocked()`, dan immutabilitas `auditLogs`/`restoreJobs`/`systemOperations`.

