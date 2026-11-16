# Changelog — XP PLAY Member System

## [1.0.0] — 2026-11-16
### Added
- **Phase 0**: Audit menyeluruh project existing dan penyusunan arsitektur incremental.
- **Phase 1**: Backend Express (`server.ts`) + Firebase Provisioning + Auth Register & Login (Username/WhatsApp + Password & Google Sign-In) + Server-side CAPTCHA (Google reCAPTCHA & HMAC-signed SVG fallback).
- **Phase 2–4**: Member Dashboard mobile-first, pemisahan saldo `XP Progress` vs `XP Reward`, Dual Ledger (`xpProgressLedger`, `xpRewardLedger`), dan Referral berbasis username (`+10 XP` daftar, `+5 XP` referral).
- **Phase 5–8**: Transaction XP cabang `DEMANG` & `SEKIP` (integer `floor(amount / rate)`), Level dinamis (`Bronze`, `Silver`, `Juragan`, `Sultan`), katalog Benefit & Level Benefit, serta manajemen Challenge/Event/Promo dengan auto-expiration.
- **Phase 9–11**: Pengajuan Claim XP dengan upload bukti foto terproteksi (`ON_PROCESS` -> `APPROVED/DENIED`), Redemption XP Reward & Level Benefit atomik dan idempoten.
- **Phase 12–18**: Admin Console 19 menu, Member Management (soft status), Admin RBAC (`SUPER_ADMIN`, `ADMIN`, `STAFF`), Notification & Inactivity Campaign (`7/14/30/custom` hari), Non-destructive Idempotent Cycle Reset + Snapshot, Audit Logs, dan Reporting.
- **Phase 19–22**: Zero-Trust `firestore.rules` (lolos `@firebase/eslint-plugin-security-rules`), `storage.rules`, `firestore.indexes.json`, Vitest suite (`src/tests/xpSystem.test.ts`), dan dokumentasi lengkap (`README.md`, `ARCHITECTURE.md`, `DATABASE.md`, `AUTH.md`, `SECURITY.md`, `XP_SYSTEM.md`, `ADMIN_GUIDE.md`, `MEMBER_GUIDE.md`, `DEPLOYMENT.md`, `TESTING.md`).
