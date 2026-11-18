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

## [1.1.0 — Phase A] — 2026-11-17
### Added
- **Admin CMS Homepage Studio (`CMS Homepage`)**: Pengelolaan konten halaman depan lengkap (Logo, Brand, Nama Toko, Favicon, Header, Hero, Banner, Promo Banner, Announcement, CTA, Tentang XP PLAY, Section Titles/Images, FAQ Builder, Kontak/Alamat/Jam Operasional/Maps/WhatsApp/Social Media, Footer).
- **Workflow Draft / Preview / Publish / Immutable Version History / Rollback**: Terpisah ke `cmsDrafts/homepage`, `cmsPublished/homepage`, dan `cmsVersions/{versionId}` lengkap dengan audit logs (`CMS_DRAFT_SAVE`, `CMS_PUBLISH`, `CMS_ROLLBACK`).
- **CMS Security & Asset Upload**: Sanitasi XSS (`src/shared/cmsSanitizer.ts`), validasi `firestore.rules` untuk CMS, fallback otorisasi REST di `requireAdminRole`, endpoint `POST /api/admin/cms/assets` (JPG/PNG/WEBP magic bytes) + `GET /api/cms/assets/:fileName`, serta dokumentasi `CMS_GUIDE.md` dan test suite `src/tests/cms.test.ts`.

## [1.2.0 — Phase B] — 2026-11-17
### Added
- **Admin XP Adjustment (`XP Adjustment`)**: Penyesuaian `XP Progress` (`ADMIN_ADJUSTMENT` dengan recalculation level dinamis dan isolasi terhadap `xpReward`) serta `XP Reward` (`XP_REWARD_ADMIN_ADJUSTMENT` tanpa mengubah `xpProgress` maupun `currentLevel`).
- **Preview, Konfirmasi, Audit Trail & Idempotensi**: Modal konfirmasi dengan `operationId` idempoten (`xpAdjustments/adj_<operationId>`), riwayat paginated di Admin Console, endpoint otoritatif `POST /api/admin/xp-adjustments`, transaksi atomik client fallback, aturan `firestore.rules` & index komposit `firestore.indexes.json`, test suite `src/tests/xpAdjustment.test.ts` (MODULE 27 TEST 1 & TEST 2), dan dokumentasi `ADMIN_XP_ADJUSTMENT.md`.

## [1.3.0 — Phase C] — 2026-11-17
### Added
- **Admin Level Override (`Level Override`)**: Force Level Change (`MANUAL_OVERRIDE`) tanpa memodifikasi `XP Progress` atau `XP Reward`, serta aksi `RECALCULATE LEVEL FROM XP` untuk mengembalikan mode `AUTOMATIC` berdasarkan threshold XP di database.
- **Pelestarian Level Override pada UI & Engine**: Penambahan `levelMode` (`AUTOMATIC | MANUAL_OVERRIDE | RESET`) dan `resolveEffectiveMemberLevel` pada Member Dashboard (`MemberXpShowcase`, `MemberDashboardPage`), transaksi XP, approval claim, dan redemption agar level hasil override tetap terlindungi.
- **Keamanan, Idempotensi & Audit**: Endpoint otoritatif `POST /api/admin/level-overrides` (`ADMIN`/`SUPER_ADMIN`), transaksi atomik `levelOverrides/ovr_<operationId>`, `levelHistory`, `memberNotifications`, dan `auditLogs`, aturan `firestore.rules` + index `firestore.indexes.json`, test suite `src/tests/levelOverride.test.ts` (MODULE 27 TEST 3 & TEST 4), serta dokumentasi `ADMIN_LEVEL_OVERRIDE.md`.

## [2.4.0 — Phases D–M] — 2026-11-18
### Added
- **Phase D — Admin Member Password Management (`Password Member`)**: Endpoint server-side `POST /api/admin/members/:memberUid/password` berbasis Firebase Admin SDK dengan validasi kekuatan password, pencabutan sesi aktif (`revokeRefreshTokens`), zero-credential-leak audit log (`PASSWORD_CHANGED_BY_ADMIN`), notifikasi member, penolakan jujur `503 ADMIN_SDK_UNAVAILABLE` bila Admin SDK belum aktif, dan tombol shortcut di tabel `Members`.
- **Phase E — Inactive Member Management (`Inactive Members`)**: Tampilan 11 kolom lengkap dengan preset `7/14/30/60/90/180/365/Custom` hari, switcher `Pernah Bermain` vs `Belum Pernah Bermain`, filter cabang/level/pencarian, cursor pagination terindeks (`firestore.indexes.json`), urutan terlama-inaktif, serta integrasi pengiriman notifikasi massal & individual dengan deduplikasi harian Jakarta (`UTC+7`).
- **Phase F & G — Full System Backup, 9-Check Verification, Retention & 9-Component System Health (`Backup & Restore`)**: `BackupRestoreEngine` dengan isolasi direktori `.backups/<backupId>/`, collision lock (`backupLock`), dukungan dual-mode (Admin SDK / `SUPER_ADMIN` Firestore REST), pelaporan scope jujur (`FULL_SYSTEM_BACKUP` vs `FIRESTORE_AND_STORAGE_BACKUP`), 9 pemeriksaan verifikasi otomatis sebelum `COMPLETED`, inspeksi `manifest.json`, kebijakan retensi dengan perlindungan backup sukses & pre-restore terbaru, serta panel kesehatan 9 komponen sistem.
- **Phase H & I — Full System Restore, Pre-Restore Backup, Restore Lock & Post-Restore Verification**: Alur restore khusus `SUPER_ADMIN` dengan `Preview Restore`, konfirmasi ketat `RESTORE XP PLAY` + alasan, aktivasi otomatis **Restore Lock / Maintenance Mode** (zero-PII `systemOperations/restoreLock`, middleware `requireSystemNotLocked()`, layar maintenance real-time di Member Portal), pembuatan **Pre-Restore Backup** wajib sebelum menimpa data, perlindungan permanen `auditLogs`/`systemBackups`/`restoreJobs`/`systemOperations`, verifikasi jumlah dokumen & storage pasca-restore, status ketat `VERIFICATION_FAILED` saat gagal, serta Force Unlock darurat.
- **Phase J — Hardened `firestore.rules`, Blueprint & Indexes**: Penegakan `!isSystemRestoreLocked()` pada seluruh mutasi operasional, pembatasan eksklusif `SUPER_ADMIN` pada `systemBackups`, `restoreJobs`, dan `systemOperations`, zero-PII enforcement (`data.lockedByEmail == null`) pada `restoreLock`, serta validator Eight Pillars yang lolos `@firebase/eslint-plugin-security-rules`.
- **Phase K — 12-Point Data Integrity Audit**: Engine `runDataIntegrityChecks` yang dijalankan otomatis pasca-restore dan dapat dipicu kapan saja secara on-demand (`POST /api/admin/integrity-audit`) mencakup ke-12 pemeriksaan konsistensi XP, Level, Unikitas Username/WhatsApp, Referral, Claims, Redemptions, Transaksi, Storage, dan Aset CMS.
- **Phase L & M — Comprehensive Test Suite & Documentation**: Penambahan `src/tests/passwordAndInactive.test.ts` dan `src/tests/backupRestoreIntegrity.test.ts` (mencakup MODULE 27 Critical Tests 5–10 dan seluruh 12 integrity checks), dokumentasi baru `MEMBER_PASSWORD_ADMIN.md`, `INACTIVE_MEMBER.md`, `BACKUP_RESTORE.md` (18 bagian lengkap MODULE 25), serta pembaruan `SECURITY.md`, `DATABASE.md`, `ARCHITECTURE.md`, `ADMIN_GUIDE.md`, `TESTING.md`, dan `CHANGELOG.md`.



