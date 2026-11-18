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
4. **CMS Homepage Security (Phase A)**:
   - Publik hanya dapat membaca `cmsPublished/homepage`; `cmsDrafts` dan `cmsVersions` terisolasi untuk Admin dan hanya dapat ditulis oleh `ADMIN` / `SUPER_ADMIN` dengan email terverifikasi (`isFullAdminOrSuper()`).
   - `cmsVersions` bersifat immutable (`allow update, delete: if false`).
   - XSS prevention berlapis (`src/shared/cmsSanitizer.ts`, aturan regex URL di `firestore.rules`, tanpa `dangerouslySetInnerHTML`) dan upload aset CMS (`POST /api/admin/cms/assets`) dibatasi pada raster `JPG`/`PNG`/`WEBP` untuk Admin aktif.
5. **Admin XP Adjustment Security (Phase B)**:
   - Penyesuaian `XP Progress` dan `XP Reward` dibatasi ketat untuk `SUPER_ADMIN` & `ADMIN` (`isFullAdminOrSuper()` di `firestore.rules` dan `requireAdminRole(['SUPER_ADMIN', 'ADMIN'])` di `/api/admin/xp-adjustments`).
   - `xpAdjustments` bersifat immutable & idempoten (`!exists(...)` pada `adj_<operationId>`, `allow update, delete: if false`).
   - `firestore.rules` memvalidasi `afterBalance == beforeBalance + adjustment`, non-negatif (`>= 0`), dan invarian bahwa adjustment `REWARD` tidak boleh mengubah `xpProgress` atau `currentLevel`.
6. **Admin Level Override Security (Phase C)**:
   - Force Level Change (`MANUAL_OVERRIDE`) dan Recalculate Level From XP (`RECALCULATE`) dibatasi ketat untuk `SUPER_ADMIN` & `ADMIN` (`isFullAdminOrSuper()` di `firestore.rules` dan `requireAdminRole(['SUPER_ADMIN', 'ADMIN'])` di `/api/admin/level-overrides`).
   - `levelOverrides` bersifat immutable & idempoten (`!exists(...)` pada `ovr_<operationId>`, `allow update, delete: if false`).
   - Member dilarang mengubah `currentLevel` maupun `levelMode` (`levelMode` saat registrasi dibatasi ke `'AUTOMATIC'`).
7. **Admin Member Password Management Security (Phase D)**:
   - Perubahan password member oleh `SUPER_ADMIN`/`ADMIN` wajib berjalan di server via Firebase Admin SDK (`POST /api/admin/members/:memberUid/password`) dengan pencabutan sesi aktif opsional (`revokeRefreshTokens`) — ditolak dengan HTTP `503 ADMIN_SDK_UNAVAILABLE` bila Admin SDK belum aktif.
   - Zero credential storage: tidak ada field password mentah maupun hash yang pernah disimpan di Firestore, `auditLogs` (`PASSWORD_CHANGED_BY_ADMIN`), `memberNotifications`, maupun file backup (`detectForbiddenPasswordFields()`).
8. **Backup, Restore Lock & Protected System Collections Security (Phases F–K)**:
   - Seluruh operasi Backup, Verifikasi, Retensi, Preview/Execute Restore, dan Force Unlock dibatasi eksklusif untuk `SUPER_ADMIN` baik di Express API maupun `firestore.rules` (`systemBackups`, `restoreJobs`, `systemOperations`).
   - Dokumen `systemOperations/restoreLock` dapat dibaca oleh user login (`isSignedIn()`) untuk Maintenance Mode secara real-time, dengan penegakan **Zero-PII** (`data.lockedByEmail == null`) di level `firestore.rules`.
   - Saat Restore Lock aktif (`isSystemRestoreLocked()`), seluruh write operasional Member, `STAFF`, dan `ADMIN` diblokir serentak oleh middleware backend (`HTTP 503 RESTORE_IN_PROGRESS`) dan `firestore.rules` (`!isSystemRestoreLocked()`).
   - Koleksi sistem terproteksi (`auditLogs`, `restoreJobs`, `systemOperations`) memiliki `allow delete: if false` permanen (dan `auditLogs` memiliki `allow update, delete: if false`) sehingga riwayat audit dan job restore tidak pernah terhapus bahkan saat Full System Restore berjalan.


