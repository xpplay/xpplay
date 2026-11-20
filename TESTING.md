# Testing Guide & Mandatory Test Cases (v3.1.0)

## Perintah Pengujian
```bash
npm test           # Menjalankan seluruh 8 Vitest test suites (80 automated tests)
npm run lint       # TypeScript type-check (tsc --noEmit)
npm run lint:rules # Validasi Firestore security rules (@firebase/eslint-plugin-security-rules)
npm run build      # Verifikasi production Vite bundle
```

## Ringkasan 8 Suite Pengujian Otomatis (80 Tests — 100% Pass)
1. **`src/tests/xpSystem.test.ts` (10 tests)**: Level thresholds (`149/150/299/300/599/600`), urutan threshold, integer arithmetic transaksi XP, normalisasi Username/WhatsApp, level eligibility, campaign expiration, Asia/Jakarta datetime, server CAPTCHA HMAC, zero-PII `authIndex` SHA-256, dan invarian `firestore.rules`.
2. **`src/tests/cms.test.ts` (5 tests)**: Sanitasi XSS CMS, validasi URL aman, workflow Draft/Publish/Rollback & versi immutable.
3. **`src/tests/xpAdjustment.test.ts` (5 tests)**: Adjustment `XP Progress` & `XP Reward` terisolasi, pencegahan saldo negatif, validasi `operationId`.
4. **`src/tests/levelOverride.test.ts` (5 tests)**: Force Level Override (`MANUAL_OVERRIDE`) tanpa mengubah XP, pelestarian override, dan `RECALCULATE LEVEL FROM XP`.
5. **`src/tests/passwordAndInactive.test.ts` (7 tests)**: Validasi password Admin SDK, zero credential leak, HTTP `503 ADMIN_SDK_UNAVAILABLE`, inactivity presets (`7–365/Custom`), baseline `neverPlayed`, deduplikasi harian Jakarta.
6. **`src/tests/backupRestoreIntegrity.test.ts` (9 tests)**: Backup isolation, collision lock `409`, Pre-Restore Backup wajib, Restore Lock `503` zero-PII, deteksi `VERIFICATION_FAILED`, 15-Point Integrity Audit, 9-Component System Health, dan audit statis `firestore.rules`.
7. **`src/tests/benefitRequestAndProfiles.test.ts` (15 tests)**: Immediate Atomic XP Hold, Approve 7 hari, Deny Auto-Refund, Cashier `MARK AS USED`, kebijakan `refundOnExpiry`, validasi Gregorian Tanggal Lahir & Status Member, filter/sort 10 opsi, dan XP Ledger labels.
8. **`src/tests/twoStepRegistrationAndCashier.test.ts` (24 tests — TEST 1 hingga TEST 20 + EXTRA 1–4)**:

### Daftar 20 Test Wajib Two-Step Registration & Cashier RBAC (`twoStepRegistrationAndCashier.test.ts`)
- **TEST 1**: Kasir melakukan pre-register pelanggan -> status `PRE_REGISTERED`, `PHONE_ONLY`, `0 XP`, tidak mendapat `+10 XP`, diblokir dari `/member`.
- **TEST 2**: Pelanggan memasukkan WhatsApp `PRE_REGISTERED` -> diizinkan lanjut Tahap 2 lengkap dengan banner resmi.
- **TEST 3**: Pelanggan memasukkan WhatsApp belum terdaftar -> diblokir dengan pesan wajib (dan Firestore Rules memblokir registrasi publik bebas tanpa `migratedFromUid` `PRE_REGISTERED`).
- **TEST 4**: Pelanggan menyelesaikan registrasi online penuh -> `PRE_REGISTERED -> ACTIVE`, bisa login, menerima `+10 XP Progress` & `+10 XP Reward` sekali dengan ID ledger deterministik.
- **TEST 5**: Mengulang form/replay penyelesaian registrasi -> diblokir & **tidak pernah** memberi bonus `+10 XP` kedua (idempoten).
- **TEST 6**: Penyelesaian registrasi dengan referral username valid -> Member baru `+10 + 5 = +15 XP`, Referrer `+5 XP`.
- **TEST 7**: Pelanggan `PRE_REGISTERED` bermain sebelum Tahap 2 -> XP transaksi (`Rp50.000 -> +25 XP`) tercatat, tetap diblokir dari `/member` hingga Tahap 2 selesai, lalu saat selesai saldo menjadi `25 + 10 = 35 XP` (semua riwayat Tahap 1 terpelihara).
- **TEST 8**: Kasir `DEMANG` mencoba mengakses data operasional `SEKIP` -> **DITOLAK** pada RBAC, API (`enforceBranchScopeInRequest`), dan Firestore Rules.
- **TEST 9**: Kasir mencoba XP Adjustment (Progress / Reward) -> **DITOLAK** (RBAC, `requirePermission`, Firestore Rules).
- **TEST 10**: Kasir mencoba Level Override -> **DITOLAK** (RBAC, `requirePermission('LEVEL_OVERRIDE')`, Firestore Rules).
- **TEST 11**: Kasir mencoba Reset Password Member -> **DITOLAK** (RBAC, `requirePermission('PASSWORD_RESET_MEMBER')`).
- **TEST 12**: Kasir mencoba Benefit CRUD -> **DITOLAK**.
- **TEST 13**: Kasir mencoba Challenge CRUD -> **DITOLAK**.
- **TEST 14**: Kasir mencoba Event CRUD -> **DITOLAK**.
- **TEST 15**: Kasir mencoba Promo CRUD -> **DITOLAK**.
- **TEST 16**: Kasir mencoba CMS Edit / Publish -> **DITOLAK** (`isAdmin()` mengecualikan `CASHIER`/`STAFF`, `cmsDrafts`/`cmsPublished` terkunci).
- **TEST 17**: Kasir membuka URL `/admin/*` / `/superadmin/*` atau API admin langsung -> **`403 UnauthorizedPage` / HTTP `403`** + audit log `CASHIER_DENIED_ACTION`.
- **TEST 18**: Admin melakukan XP Progress & XP Reward Adjustment -> **DIIZINKAN** dengan perhitungan before/after dan kenaikan level akurat (`130 + 30 = 160 -> SILVER`).
- **TEST 19**: Super Admin mengelola 4 slot Kasir (`CASHIER_DEMANG_01/02`, `CASHIER_SEKIP_01/02`) dengan cabang tetap dan menolak `branchScope: 'ALL'` bagi Kasir.
- **TEST 20**: Metrik Member Baru Admin Dashboard memisahkan secara akurat `PRE_REGISTERED` vs `ACTIVE` (`Hari Ini / 7 Hari / 30 Hari`).
- **EXTRA 1**: Kode Verifikasi 6-Digit kriptografis (HMAC-SHA256), batas 5 percobaan salah, kadaluarsa 7 hari, dan proteksi replay `onboardingSessionToken` sekali pakai.
- **EXTRA 2**: Laporan read-only `Incomplete Registration` (7 / 14 / 30 hari + filter cabang) tanpa pernah menghapus data `PRE_REGISTERED`.
- **EXTRA 3**: Siklus penuh Cashier-assisted Benefit Request untuk member `PRE_REGISTERED` (`Hold -> Approve -> Used` & `Deny -> Auto-Refund`).
- **EXTRA 4**: Integrity Engine mengizinkan `username` kosong khusus `PRE_REGISTERED` dan menangkap bonus `REGISTRATION_BONUS` prematur/ganda pada `xpProgressLedger` maupun `xpRewardLedger`.

## Pengujian Manual End-to-End (Browser)
1. Login sebagai `CASHIER` cabang `DEMANG` di `/admin/login` -> pastikan otomatis diarahkan ke `/cashier` dan hanya melihat 9 menu.
2. Buka tab **Register Customer**, input nomor WhatsApp baru -> salin **Kode 6-Digit** dan tautan QR `/register?wa=...&code=...`. Pastikan status `PRE_REGISTERED`, `0 XP`.
3. Coba navigasi manual ke `/admin` atau `/superadmin` sebagai Kasir -> pastikan muncul halaman **403 Akses Ditolak** dan tercatat di `auditLogs` (`CASHIER_DENIED_ACTION`).
4. Coba login di `/login` dengan nomor `PRE_REGISTERED` -> pastikan diblokir dengan tombol **`Lengkapi Pendaftaran`**.
5. Input transaksi `Rp50.000` di `/cashier` untuk nomor `PRE_REGISTERED` -> pastikan saldo menjadi `25 XP`.
6. Buka tautan `/register?wa=...&code=...` sebagai pelanggan -> selesaikan CAPTCHA -> verifikasi kode 6-digit -> lengkapi profil + password -> pastikan login ke `/member` berhasil dengan saldo `35 XP` (`25 XP transaksi + 10 XP bonus`).
7. Login sebagai `ADMIN` / `SUPER_ADMIN` -> pastikan metrik `NEW PRE-REGISTERED` vs `NEW ACTIVE MEMBERS` terpisah, cek tab `Pendaftaran Belum Selesai` di `Inactive Members`, dan cek 4 slot kasir di `Admin Management`.
