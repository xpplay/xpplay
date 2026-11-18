# Architecture — XP PLAY Member System

## Ringkasan Arsitektur
Aplikasi dibangun menggunakan arsitektur **Full-Stack Authoritative Hybrid** pada port `3000`:

1. **Frontend (`src/`)**: React 19 + TypeScript + Tailwind CSS v4 + React Router v7.
   - Member Portal (`/member`, `/login`, `/register`) berdesain *mobile-first* dengan bottom navigation bar (`44px+` touch hitbox), layout responsif hingga desktop 1440px, dan dukungan Maintenance Mode real-time saat Restore Lock aktif.
   - Admin Console (`/admin`, `/admin/login`) menggunakan sidebar terstruktur dengan kontrol RBAC (`SUPER_ADMIN`, `ADMIN`, `STAFF`), mencakup CMS Homepage Studio (Phase A), Admin XP Adjustment (Phase B), Admin Level Override & Recalculate (Phase C), Manajemen Password Member (Phase D), Inactive Members + Notifikasi Terdeduplikasi (Phase E), serta Backup, Verifikasi, Restore, 12-Point Integrity Audit, & 9-Component System Health (Phases F–K).
2. **Backend (`server.ts` + `src/server/`)**: Express + TypeScript (`tsx`).
   - Melayani API otoritatif di `/api/*` dan SPA frontend via `vite.middlewares` (dev) atau `dist/` (prod).
   - **Restore Lock Middleware** (`src/server/middleware/authMiddleware.ts` — `requireSystemNotLocked()`): Memblokir seluruh endpoint mutasi operasional dengan HTTP `503 RESTORE_IN_PROGRESS` saat restore aktif, dan mengekspos status publik `GET /api/system/maintenance`.
   - **CAPTCHA Service** (`src/server/services/captchaService.ts`): Verifikasi server-side Google reCAPTCHA (jika dikonfigurasi) atau tantangan SVG bertanda tangan HMAC-SHA256 dengan TTL 5 menit dan pencegahan replay.
   - **Evidence & CMS Asset Upload Guard** (`src/server/routes/api.ts`): Validasi magic bytes (JPG/PNG/WEBP), batas ukuran 5 MB, penyimpanan terisolasi per `memberUid`/CMS, dan endpoint baca terotorisasi.
   - **XP Engine Server** (`src/server/services/xpEngineServer.ts`): Menggunakan Firebase Admin SDK untuk registrasi username/WhatsApp, login anti-enumeration, transaksi XP atomik, approval claim/redemption idempoten, penyesuaian XP Progress & XP Reward terpisah (`POST /api/admin/xp-adjustments`), override & rekalkulasi level (`POST /api/admin/level-overrides`), penggantian password member teraudit (`POST /api/admin/members/:memberUid/password`), dan reset cycle.
   - **Backup, Verification, Restore & Integrity Engine** (`src/server/services/backupRestoreService.ts`, `src/server/services/firestoreRestHelper.ts`, `src/shared/backupRestoreLogic.ts`, `src/shared/integrityLogic.ts`): Mendukung dual-mode (Admin SDK atau verified `SUPER_ADMIN` Firestore REST) dengan pelaporan jujur (`FULL_SYSTEM_BACKUP` vs `FIRESTORE_AND_STORAGE_BACKUP`), 9-check backup verification, collision lock, mandatory Pre-Restore Backup, Restore Lock, Post-Restore Verification, 12-Point Data Integrity Audit, dan 9-Component System Health.
3. **Database & Rules (`firestore.rules`, `storage.rules`, `firebase-blueprint.json`, `firestore.indexes.json`)**:
   - Firestore dengan database bernama sesuai `firebase-applet-config.json`.
   - Zero-Trust Rules memastikan member tidak pernah dapat memodifikasi XP, level, saldo, approval, transaksi, atau konfigurasi sistem langsung dari client SDK, memblokir write saat `isSystemRestoreLocked()`, dan melindungi `auditLogs`, `restoreJobs`, serta `systemOperations` dari penghapusan.

