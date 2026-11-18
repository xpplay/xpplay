# Testing Guide & Mandatory Test Cases

## Perintah Pengujian
```bash
npm test          # Menjalankan Vitest unit & security invariant tests
npm run lint      # TypeScript type-check (tsc --noEmit)
npm run lint:rules # Validasi Firestore security rules (@firebase/eslint-plugin-security-rules)
npm run build     # Verifikasi production Vite bundle
```

## Cakupan Test Case Wajib (`src/tests/xpSystem.test.ts`)
1. **Level Thresholds**:
   - `149 XP` -> `BRONZE`, `150 XP` -> `SILVER`, `299 XP` -> `SILVER`, `300 XP` -> `JURAGAN`, `599 XP` -> `JURAGAN`, `600 XP` -> `SULTAN`.
   - Validasi urutan threshold `Bronze < Silver < Juragan < Sultan`.
2. **Transaction XP Integer Arithmetic**:
   - `Rp100.000 / 2000 = 50 XP`, `Rp10.000 = 5 XP`, `Rp20.000 = 10 XP`, `Rp50.000 = 25 XP`.
   - Menolak nilai negatif atau non-integer.
3. **Username & WhatsApp Normalization**:
   - Case normalization username, blokir username reserved (`admin`, `superadmin`), normalisasi nomor Indonesia (`0898...` -> `62898...`).
4. **Level Benefit Eligibility**:
   - `currentLevel >= requiredLevel` ditegakkan.
5. **Campaign Automatic Expiration**:
   - `currentTime > endAt` otomatis berstatus `EXPIRED` dan `isCampaignClaimable` bernilai `false`.
6. **Server-Side CAPTCHA**:
   - Verifikasi token SVG bertanda tangan HMAC, menolak jawaban salah atau token kosong.
7. **Firestore Security Rules Invariants**:
   - Default deny, `identityIndex` terkunci untuk non-Super Admin, member dilarang ubah XP/level/status, claims/redemptions terkunci `ON_PROCESS` saat create & hanya Admin yang boleh update.

## Cakupan Test Suite Modular (Phases A–L / MODULES 26 & 27)
1. **`src/tests/cms.test.ts` (Phase A)**:
   - Sanitasi XSS CMS, validasi URL aman, workflow Draft/Publish/Rollback & versi immutable.
2. **`src/tests/xpAdjustment.test.ts` (Phase B — MODULE 27 TEST 1 & TEST 2)**:
   - Adjustment `XP Progress` mengubah level secara dinamis tanpa menyentuh `XP Reward`; adjustment `XP Reward` tidak menyentuh `XP Progress` maupun `Level`; pencegahan saldo negatif dan validasi `operationId`.
3. **`src/tests/levelOverride.test.ts` (Phase C — MODULE 27 TEST 3 & TEST 4)**:
   - Force Level Override (`MANUAL_OVERRIDE`) tanpa mengubah saldo XP, pelestarian override saat transaksi/claim, serta `RECALCULATE LEVEL FROM XP` kembali ke `AUTOMATIC`.
4. **`src/tests/passwordAndInactive.test.ts` (Phases D & E — MODULES 5, 6, 26)**:
   - Validasi kekuatan password baru Admin, deteksi field password terlarang (`detectForbiddenPasswordFields`), penolakan jujur HTTP `503 ADMIN_SDK_UNAVAILABLE` tanpa Admin SDK, perhitungan inactivity (`7/14/30/60/90/180/365/Custom` hari), baseline `neverPlayed`, urutan terlama-inaktif, pengecualian `SUSPENDED`/`DELETED`, dan kunci deduplikasi notifikasi harian Jakarta (`UTC+7`).
5. **`src/tests/backupRestoreIntegrity.test.ts` (Phases F–K — MODULE 27 TEST 5–10 & MODULE 18)**:
   - **TEST 5**: Backup A dan Backup B memiliki `backupId`, `operationId`, direktori, dan `manifest.json` terisolasi dan tidak pernah saling menimpa.
   - **TEST 6**: Eksekusi backup paralel bertabrakan ditolak dengan HTTP `409 BACKUP_IN_PROGRESS`.
   - **TEST 7**: `executeRestore` otomatis membuat **Pre-Restore Backup** (`backup_pre_restore_...`) terlebih dahulu sebelum menimpa live Firestore/Storage, memulihkan data dengan akurat, dan menjaga `auditLogs` serta `systemBackups` tetap utuh.
   - **TEST 8 & TEST 9**: Restore Lock memblokir mutasi operasional Admin maupun Member dengan HTTP `503 RESTORE_IN_PROGRESS` dan mengembalikan pesan Maintenance Mode resmi tanpa PII (`lockedByEmail: null`).
   - **TEST 10**: Kegagalan verifikasi pasca-restore (injeksi saldo negatif + orphan claim) secara ketat menetapkan status `'VERIFICATION_FAILED'` (tidak pernah `'COMPLETED'`) lengkap dengan `recoveryRecommendation` yang merujuk `preRestoreBackupId`.
   - **Verifikasi Tambahan**: Deteksi file backup korup/tampered, kompatibilitas schema/versi, pembatasan `SUPER_ADMIN` & frasa `RESTORE XP PLAY`, perlindungan retensi untuk backup sukses & pre-restore terakhir, pengujian seluruh **12 poin `runDataIntegrityChecks`** (sehat & korup), **9-Component System Health**, serta audit statis `firestore.rules`.

## Pengujian Manual End-to-End (Browser)
1. Login sebagai Super Admin (`spv.xpplay@gmail.com`) di `/admin/login`.
2. Tambahkan member baru di menu `Members` (atau daftar via `/register`). Pastikan `XP Progress = 10`, `XP Reward = 10`.
3. Tambahkan transaksi `Rp100.000` di cabang `DEMANG`. Pastikan `XP Progress = 60`, `XP Reward = 60`, `Last Play` terisi.
4. Uji Redemption: saat `XP Progress = 450, XP Reward = 450`, approve redeem `200 XP` -> pastikan `XP Progress` tetap `450`, `XP Reward` menjadi `250`, dan level tetap `JURAGAN`.
5. Uji penolakan (`DENY`) Claim & Redemption -> pastikan saldo tidak berubah dan alasan tercatat.
6. Uji Reset Cycle -> pastikan snapshot terbentuk di `cycleSnapshots` dan ledger/transaksi lama tetap ada.
7. Uji Inactive Members -> ubah preset `7/14/30/60/90/180/365/Custom` dan mode `Pernah Bermain`/`Belum Pernah Bermain`, lalu kirim notifikasi terdeduplikasi.
8. Uji Backup & Restore (`SUPER_ADMIN`) -> periksa 9-Component Health, jalankan Create Backup, Verify Backup, 12-Point Integrity Audit, Preview Restore, dan Execute Restore (`RESTORE XP PLAY`).

