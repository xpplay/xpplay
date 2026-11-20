# Security Architecture — XP PLAY (v3.1.0)

## Prinsip Zero-Trust & Pertahanan Berlapis (4 Layer)
Seluruh aturan keamanan XP PLAY ditegakkan serentak di **UI**, **React Router 403**, **Express API Middlewares**, dan **Firestore / Storage Security Rules**.

1. **Firestore Rules (`firestore.rules`)**:
   - Default deny (`allow read, write: if false`).
   - Seluruh aturan dilint tanpa error menggunakan `@firebase/eslint-plugin-security-rules` (`npm run lint:rules`) dan dideploy ke database Firestore.
   - `identityIndex` diblokir total dari client SDK (`allow read, write: if false`).
   - Member hanya dapat membaca dokumen miliknya (`uid == request.auth.uid`) dan dilarang mengubah `xpProgress`, `xpReward`, `reservedXp`, `currentLevel`, `status`, `registrationStatus`, `registrationStage`, `registrationBonusGranted`, `referredBy*`, `lastPlay*`, `transactions`, `levels`, `systemSettings`, `admins`, atau `auditLogs`.

2. **Two-Step Registration & Anti-Public-Self-Registration Security (v3.1.0)**:
   - **Blokir Registrasi Publik di Database**: `members/{uid}` pada `allow create` secara matematis mensyaratkan pengguna non-staff memiliki `migratedFromUid` yang merujuk pada dokumen `members/pre_*` berstatus `PRE_REGISTERED` dengan nomor WhatsApp dan `memberId` identik serta memensiunkan dokumen `pre_*` lama ke `DELETED` dalam batch atomik yang sama. Pendaftaran publik bebas tanpa pre-registrasi Kasir/Admin **mustahil berhasil** bahkan jika penyerang memanggil Firestore SDK langsung.
   - **Zero-PII Status Check**: `onboardingPublicStatus/{wHash}` hanya mengizinkan `get` (bukan `list`) dan tidak pernah memuat PII (nama, saldo XP, tanggal lahir) ataupun kode 6-digit plaintext.
   - **Cryptographic 6-Digit One-Time Code**: Disimpan sebagai HMAC-SHA256 (`onboardingVerifications/{wHash}`), tidak pernah plaintext di publik, dibatasi 5 percobaan salah, kadaluarsa 7 hari, dan menghasilkan `onboardingSessionToken` sekali pakai dengan proteksi replay.
   - **Proteksi Dokumen `pre_*`**: Akses baca `members/pre_*` dibatasi hanya untuk staff cabang terkait atau pengguna baru yang belum memiliki dokumen `members/{request.auth.uid}` (`!exists(...)`) sehingga member aktif tidak dapat membaca dokumen pre-registrasi pelanggan lain.
   - **Bonus `+10 XP` Idempoten**: ID ledger deterministik `regbonus_prog_<memberId>` dan `regbonus_rew_<memberId>` mencegah pemberian bonus kedua dalam skenario replay/retry; dicek ulang oleh Check #14 pada 15-Point Integrity Audit.

3. **Branch-Isolated Cashier RBAC (`CASHIER` & Legacy `STAFF`) (v3.1.0)**:
   - Fungsi helper `isAdmin()` di `firestore.rules` **hanya** mengizinkan `['SUPER_ADMIN', 'ADMIN']` (tidak pernah mencakup `CASHIER` atau `STAFF`).
   - `isCashier()` mewajibkan `role in ['CASHIER', 'STAFF']` dan `branchScope in ['DEMANG', 'SEKIP']` (menolak `branchScope: 'ALL'`).
   - **Isolasi Cabang Ketat**: Kasir `DEMANG` hanya dapat membaca/menulis transaksi, pre-register, kode verifikasi, dan benefit request dengan `branch == 'DEMANG'` (demikian pula `SEKIP`). Percobaan lintas cabang ditolak dengan HTTP `403 CROSS_BRANCH_FORBIDDEN` dan Firestore `PERMISSION_DENIED`.
   - **Blokir Total Fitur Terlarang bagi Kasir**: XP Adjustment (`xpAdjustments`), Level Override (`levelOverrides`), Member Password Reset (`/api/admin/members/:uid/password`), Benefit/Campaign CRUD (`benefits`, `campaigns`), CMS (`cmsDrafts`, `cmsPublished`, `cmsVersions`), Admin/Cashier Management (`admins`), XP/Level Settings (`systemSettings`, `levels`), Cycle Reset, Backup/Restore (`systemBackups`, `restoreJobs`, `systemOperations`), dan pembacaan `auditLogs` seluruhnya diblokir dengan `403` dan dicatat sebagai **`CASHIER_DENIED_ACTION`**.
   - **Direct-URL Protection**: Navigasi langsung Kasir ke `/admin/*` atau `/superadmin/*` merender halaman `403 UnauthorizedPage` dan mengirim event audit `CASHIER_DENIED_ACTION`.

4. **Idempotency & Anti-Fraud (Benefit Request, Atomic XP Hold, Legacy Claims)**:
   - Pembuatan `benefitRequests/{requestId}` oleh member memverifikasi langsung terhadap katalog aktif, mengunci status awal `'ON_PROCESS'`, dan mensyaratkan pemotongan atomik `xpReward -> reservedXp` + entri ledger `BENEFIT_REQUEST_HOLD`.
   - Transisi status `benefitRequests` hanya mengizinkan `ON_PROCESS -> [APPROVED, DENIED, REFUNDED]` dan `APPROVED -> [USED, EXPIRED, REFUNDED]`, mengunci status terminal dari perubahan ulang maupun double refund.

5. **Upload Bukti Foto & Storage Hardening (`storage.rules`)**:
   - Validasi magic bytes (`JPG`, `PNG`, `WEBP`), ukuran maks `5 MB`, dan isolasi per `memberUid` pada `/claims/{memberUid}/{claimId}/{fileName}`.
   - Akses langsung client SDK ke `/cms/**` dan `/backups/**` diblokir eksplisit (`allow read, write: if false`).

6. **CMS, XP Adjustment, Level Override, Password Reset & Backup/Restore Security**:
   - Sanitasi XSS CMS (`cmsSanitizer.ts`) & `cmsVersions` immutable.
   - `xpAdjustments` & `levelOverrides` immutable, idempoten (`!exists(...)`), khusus `ADMIN`/`SUPER_ADMIN`.
   - Reset password member wajib server-side via Firebase Admin SDK (zero credential storage di Firestore/audit/backup), menolak jujur dengan `503 ADMIN_SDK_UNAVAILABLE` jika Admin SDK belum aktif.
   - Restore Lock (`systemOperations/restoreLock`) zero-PII (`lockedByEmail == null`) memblokir seluruh mutasi operasional (`503 RESTORE_IN_PROGRESS`) selama restore; `auditLogs`, `restoreJobs`, dan `systemOperations` memiliki `allow delete: if false` permanen.
