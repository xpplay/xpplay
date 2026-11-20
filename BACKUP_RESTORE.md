# Full System Backup, Verification, Restore & Data Integrity — XP PLAY

Dokumen ini merupakan referensi operasional lengkap untuk sistem **Backup, Verifikasi, Retensi, Restore, Maintenance Lock, Post-Restore Verification, 15-Point Data Integrity Audit, dan 9-Component System Health** (v3.0.0 / `xpplay-schema-v3`).

---

## 1. Backup Scope (Cakupan Backup)
Setiap eksekusi backup membentuk paket snapshot terisolasi pada `.backups/<backupId>/` yang mencakup tiga domain utama:
1. **Firestore Database**: Seluruh **26 koleksi** sistem (`members`, `identityIndex`, `admins`, `branches`, `levels`, `systemSettings`, `transactions`, `xpProgressLedger`, `xpRewardLedger`, `xpAdjustments`, `levelOverrides`, `levelHistory`, `referrals`, `benefits`, `campaigns`, `benefitRequests`, `claims`, `redemptions`, `notifications`, `memberNotifications`, `membershipCycles`, `cycleSnapshots`, `cmsPublished`, `cmsDrafts`, `cmsVersions`, `auditLogs`).
2. **Storage Objects**: Seluruh file bukti klaim member (`.uploads/claims/**`) dan aset gambar CMS Homepage (`.uploads/cms/**`).
3. **Auth Metadata**: Daftar metadata akun user (UID, email, displayName, status disabled, emailVerified, provider, roleHint, timestamps) **tanpa pernah mengekspor password plaintext maupun hash password**.

**Kejujuran Scope (MODULE 28)**:
- Jika `FIREBASE_SERVICE_ACCOUNT_JSON` aktif di server (`Firebase Admin SDK`), backup ditandai secara eksplisit sebagai **`FULL_SYSTEM_BACKUP`** (`authExportMode: 'FIREBASE_ADMIN_SDK'`).
- Jika `FIREBASE_SERVICE_ACCOUNT_JSON` belum aktif (mode REST/preview), backup ditandai secara eksplisit sebagai **`FIRESTORE_AND_STORAGE_BACKUP`** (`authExportMode: 'FIRESTORE_DERIVED_METADATA_ONLY'`) beserta catatan keterbatasan di manifest dan UI. Sistem tidak pernah mengklaim *Full Backup* apabila Auth SDK tidak aktif.

---

## 2. Firestore Backup
- Setiap koleksi diekspor dalam urutan deterministik (diurutkan berdasarkan `docId`) ke file terpisah `.backups/<backupId>/firestore/<collection>.json`.
- Setiap file koleksi dipindai oleh `detectForbiddenPasswordFields()` sebelum ditulis — jika ditemukan field terlarang (`password`, `newPassword`, `passwordHash`, dll.), backup langsung dibatalkan.
- Dihitung ukuran byte dan checksum **SHA-256** untuk setiap koleksi.

---

## 3. Auth Metadata Backup & Provider Limitations
- File `.backups/<backupId>/auth/users_metadata.json` hanya menyimpan metadata non-rahasia user.
- **Batasan Penyedia (Firebase Auth)**: Firebase Auth mengelola hash password secara terenkripsi di sisi Google Cloud dan tidak menyediakan password plaintext. Oleh karena itu:
  - Password member & admin **tidak pernah** dimasukkan ke dalam file backup.
  - Pada saat restore, akun yang sudah ada di Firebase Auth tetap mempertahankan kredensial password aslinya. Jika Admin SDK aktif, langkah `RESTORE_AUTH_METADATA` hanya menyinkronkan flag `disabled` dan `displayName`. Jika Admin SDK tidak aktif, langkah ini ditandai `SKIPPED` secara transparan.

---

## 4. Storage Backup
- Seluruh objek biner di `.uploads/claims/` dan `.uploads/cms/` disalin utuh ke `.backups/<backupId>/storage/files/<relativePath>`.
- Indeks lengkap (relativePath, bucketGroup, byteSize, checksumSha256, modifiedAt) disimpan di `.backups/<backupId>/storage/storage_manifest.json` beserta SHA-256 dari manifest storage tersebut.

---

## 5. Manifest Specification (`manifest.json`)
Setiap backup menghasilkan `.backups/<backupId>/manifest.json` berisi:
- Identitas: `backupId`, `operationId`, `kind` (`MANUAL | SCHEDULED | PRE_RESTORE`), `scopeType`, `scopeDescription`, `authExportMode`, `authLimitationNotice`.
- Versi & Lingkungan: `appVersion` (`3.0.0`), `schemaVersion` (`xpplay-schema-v3`), `projectId`, `firestoreDatabaseId`.
- Operator & Waktu: `createdAt`, `createdBy`, `createdByEmail`, `createdByRole`.
- Ringkasan & Checksum: `firestoreCollections[]` (jumlah dokumen, byte, SHA-256), `totalDocuments`, `authUserCount`, `authChecksumSha256`, `storageFiles[]`, `storageFileCount`, `storageTotalBytes`, `storageManifestChecksumSha256`, `totalBackupBytes`, dan **`manifestChecksumSha256`** (hash SHA-256 atas seluruh payload manifest).

---

## 6. Backup Verification (9 Pemeriksaan Wajib — MODULE 8)
Backup **tidak pernah** berstatus `COMPLETED` sebelum lulus seluruh 9 pemeriksaan verifikasi otomatis (dan dapat dijalankan ulang kapan saja melalui `POST /api/admin/backups/:backupId/verify`):
1. `MANIFEST_EXISTS`: Keberadaan dan struktur JSON `manifest.json`.
2. `MANIFEST_CHECKSUM`: Rekomputasi SHA-256 manifest cocok dengan `manifestChecksumSha256`.
3. `SCHEMA_COMPATIBILITY`: `schemaVersion` dan major `appVersion` kompatibel.
4. `FIRESTORE_FILES_AND_COUNTS`: Seluruh file koleksi ada dan jumlah dokumen cocok 100% dengan manifest.
5. `FIRESTORE_CHECKSUMS`: SHA-256 seluruh file koleksi cocok 100%.
6. `AUTH_METADATA`: File `auth/users_metadata.json` valid, checksum & jumlah user cocok.
7. `STORAGE_INTEGRITY`: `storage_manifest.json` dan seluruh objek file fisik ada dengan ukuran & SHA-256 cocok.
8. `NO_PASSWORD_SECRETS`: Terverifikasi nol field password/hash terlarang.
9. `CORE_COLLECTIONS`: Koleksi inti (`members`, `levels`, `systemSettings`) lengkap.

Jika satu saja gagal, status berubah menjadi **`VERIFICATION_FAILED`** dan backup tidak dapat dipakai untuk restore.

---

## 7. Backup Retention Policy
Konfigurasi tersimpan di `systemOperations/backupRetention` (`GET/PUT /api/admin/backup-retention`):
- `dailyRetentionCount` (default 7, batas 1–90)
- `weeklyRetentionCount` (default 4, batas 1–52)
- `monthlyRetentionCount` (default 3, batas 1–36)
- `customMaxAgeDays` (default 90, batas 7–3650)
- **Perlindungan Penghapusan Wajib** (`canDeleteBackupRecord`):
  - `alwaysKeepLatestSuccessful`: Backup regular `COMPLETED` terbaru **tidak dapat dihapus**.
  - `alwaysKeepLatestPreRestore`: `PRE_RESTORE` backup `COMPLETED` terbaru **tidak dapat dihapus**.
  - Backup yang sedang berjalan (`REQUESTED | PREPARING | RUNNING | VERIFYING`) atau sedang dipakai oleh proses restore aktif **selalu diblokir** dari penghapusan.

---

## 8. Concurrency Control
- Mutex memori lokal (`localBackupLock`, `localRestoreLock`) dipadukan dengan dokumen lock persisten di Firestore (`systemOperations/backupLock` dan `systemOperations/restoreLock`).
- Permintaan backup paralel saat backup lain berjalan langsung ditolak dengan **HTTP `409`** (`code: 'BACKUP_IN_PROGRESS'`).
- Permintaan restore saat backup atau restore lain sedang berjalan langsung ditolak dengan **HTTP `409`**.
- Permintaan backup biasa saat Restore Lock aktif ditolak dengan **HTTP `503`** (`code: 'RESTORE_IN_PROGRESS'`), kecuali **Pre-Restore Backup** internal yang dipicu oleh job restore itu sendiri.

---

## 9. Collision Prevention
- Setiap backup memperoleh `backupId` unik berbasis timestamp UTC + 8 karakter hex acak kriptografis (`backup_YYYYMMDD_HHMMSS_<hex>` atau `backup_pre_restore_YYYYMMDD_HHMMSS_<hex>`) dan `operationId` unik.
- Server memverifikasi direktori `.backups/<backupId>` belum ada sebelum menulis; Backup A dan Backup B tidak pernah saling menimpa.

---

## 10. Pre-Restore Backup (Wajib — MODULE 11)
- Sebelum menimpa satu dokumen atau satu file storage pun, `executeRestore()` **wajib** menjalankan `createSystemBackup({ kind: 'PRE_RESTORE', allowDuringRestoreLock: true })` dari kondisi live saat ini.
- Apabila Pre-Restore Backup gagal atau tidak lulus verifikasi `COMPLETED`, seluruh proses restore **langsung dibatalkan** sebelum mengubah data live.
- Koleksi sistem terproteksi (`auditLogs`, `systemBackups`, `restoreJobs`, `systemOperations`) **tidak pernah** dihapus atau ditimpa saat restore agar seluruh jejak audit dan riwayat backup (termasuk Pre-Restore Backup) tetap utuh.

---

## 11. Restore Lock / Maintenance Mode (MODULE 12)
Saat restore dimulai:
1. Dokumen zero-PII `systemOperations/restoreLock` diaktifkan (`locked: true`, `state: 'RESTORE_IN_PROGRESS'`, `lockedByEmail: null`, `message: "XP PLAY sedang melakukan maintenance sistem. Silakan kembali beberapa saat lagi."`).
2. **Backend Middleware (`requireSystemNotLocked`)**: Memblokir seluruh mutasi operasional (Transaksi XP, Claim, Redemption, XP Adjustment, Level Override, Reset Cycle, Upload Evidence, Upload CMS Asset, Ubah Password) dengan **HTTP `503`** (`code: 'RESTORE_IN_PROGRESS'`).
3. **Firestore Rules (`!isSystemRestoreLocked()`)**: Memblokir langsung seluruh write dari Member, `STAFF`, dan `ADMIN` di lapisan database selama Restore Lock aktif.
4. **Member Portal (`AuthContext` + `MemberDashboardPage`)**: Mendengarkan `systemOperations/restoreLock` secara real-time (`onSnapshot`) dan langsung menampilkan layar Maintenance Mode dengan pesan resmi di atas.
5. Lock otomatis dilepas pada blok `finally` setelah restore selesai/gagal; tersedia pula tombol darurat **Force Unlock** (`POST /api/admin/restores/force-unlock`) khusus `SUPER_ADMIN` dengan alasan wajib & audit log.

---

## 12. Restore Preview (MODULE 14)
Sebelum eksekusi, `SUPER_ADMIN` menjalankan `POST /api/admin/restores/preview` untuk melihat:
- Validasi status & kompatibilitas `appVersion` / `schemaVersion`.
- Alasan pemblokir (`blockingReasons`) dan peringatan (`warnings`, termasuk notice Auth metadata).
- Perbandingan jumlah dokumen live vs jumlah dokumen dalam backup untuk ke-26 koleksi (menandai koleksi terproteksi seperti `auditLogs`).
- Perbandingan jumlah file storage live vs backup.

---

## 13. Restore Confirmation (MODULE 15)
Eksekusi restore (`POST /api/admin/restores/execute`) mensyaratkan **tiga gerbang**:
1. Role pemanggil wajib `SUPER_ADMIN`.
2. Frasa konfirmasi harus persis **`RESTORE XP PLAY`** (case-sensitive).
3. Alasan operasional wajib diisi (minimal 3 karakter).

---

## 14. Post-Restore Verification & 15-Point Data Integrity Audit (MODULES 17 & 18 + FASE 32)
Setelah pemulihan Firestore, Storage, dan Auth metadata selesai, engine menjalankan:
1. **Perbandingan Jumlah Dokumen & Storage**: Jumlah dokumen setiap koleksi bisnis dan jumlah file storage pasca-restore wajib cocok 100% dengan manifest backup.
2. **15-Point Data Integrity Audit** (`src/shared/integrityLogic.ts`, juga dapat dijalankan kapan saja secara on-demand via `POST /api/admin/integrity-audit`):
   1. `XP_PROGRESS_CONSISTENCY`: Validitas saldo & ledger `xpProgressLedger`.
   2. `XP_REWARD_CONSISTENCY`: Validitas saldo `xpReward`, `reservedXp` & ledger `xpRewardLedger`.
   3. `LEVEL_CONSISTENCY`: Kecocokan `currentLevel` terhadap threshold untuk member ber-`levelMode: 'AUTOMATIC'`.
   4. `NO_NEGATIVE_BALANCE`: Nol saldo `xpProgress`, `xpReward`, maupun `reservedXp` negatif.
   5. `NO_DUPLICATE_USERNAME`: Unikitas username seluruh member non-`DELETED`.
   6. `NO_DUPLICATE_WHATSAPP`: Unikitas nomor WhatsApp seluruh member non-`DELETED`.
   7. `REFERRAL_INTEGRITY`: Tidak ada *self-referral* maupun broken reference pada `members` & `referrals`.
   8. `NO_ORPHAN_CLAIMS`: Seluruh `claims` merujuk `memberUid` dan `campaignId` valid.
   9. `NO_ORPHAN_REDEMPTIONS`: Seluruh `redemptions` merujuk `memberUid` dan `benefitId` valid.
   10. `TRANSACTION_INTEGRITY`: Validitas `memberUid`, cabang (`DEMANG`/`SEKIP`), `amountIdr > 0`, `xpGenerated >= 0`.
   11. `STORAGE_OBJECT_INTEGRITY`: Seluruh referensi file bukti `claims` & `benefitRequests` benar-benar ada di `.uploads/claims/`.
   12. `CMS_ASSET_INTEGRITY`: Seluruh referensi aset lokal CMS Published & Draft ada di `.uploads/cms/`.
   13. `NO_ORPHAN_BENEFIT_REQUESTS`: Seluruh `benefitRequests` terhubung ke member & katalog valid serta total `ON_PROCESS` hold sama persis dengan `member.reservedXp`.
   14. `NO_DUPLICATE_DEDUCTION_OR_REFUND`: Tidak ada double `BENEFIT_REQUEST_HOLD` maupun double `DENIED_REFUND`/`EXPIRY_REFUND` pada `xpRewardLedger`.
   15. `VALID_MEMBER_STATUS_AND_PROFILE`: Validitas status akun, format & tanggal kalender `birthDate` (tidak di masa depan), serta kategori `memberCategory`.

---

## 15. Restore Failure Handling
- Apabila verifikasi jumlah dokumen, jumlah file storage, atau 15-Point Integrity Check menemukan **satu saja ketidaksesuaian atau isu kritikal**, status job restore **WAJIB** ditetapkan menjadi **`VERIFICATION_FAILED`** (HTTP `422`) dan **TIDAK PERNAH** ditandai `COMPLETED`.
- Apabila terjadi exception runtime di tengah proses, status ditetapkan `FAILED` dan audit log `RESTORE_FAILED` ditulis.
- Backup target maupun Pre-Restore Backup tidak pernah dihapus oleh kegagalan restore.

---

## 16. Recovery Procedure (Rollback)
Jika restore berstatus `VERIFICATION_FAILED` atau `FAILED`:
1. Buka tab **Restore Logs** di menu `Backup & Restore` dan catat `preRestoreBackupId` pada rekomendasi pemulihan (`recoveryRecommendation`).
2. Jalankan tab **Integrity Audit** untuk meninjau detail temuan per check.
3. Untuk kembali ke kondisi tepat sebelum restore, buka tab **Restore Center**, pilih `preRestoreBackupId`, lakukan **Preview Restore**, dan jalankan restore dengan konfirmasi `RESTORE XP PLAY`.
4. Jika sistem terhenti mendadak saat proses restore (misalnya server restart), gunakan tombol **Force Unlock Restore Lock** (tab **Restore Logs**) setelah memastikan tidak ada proses restore aktif.

---

## 17. Role Permissions Matrix

| Operasi | `SUPER_ADMIN` | `ADMIN` | `STAFF` | `MEMBER` |
| --- | :---: | :---: | :---: | :---: |
| System Health (9 Komponen) | Ya | Ya (Read) | Tidak | Tidak |
| Run 15-Point Integrity Audit | Ya | Ya | Tidak | Tidak |
| Create / Verify / View / Delete Backup | Ya | Tidak | Tidak | Tidak |
| Edit Backup Retention Policy | Ya | Tidak | Tidak | Tidak |
| Preview / Execute Restore / Force Unlock | Ya | Tidak | Tidak | Tidak |
| Read `systemOperations/restoreLock` | Ya | Ya | Ya | Ya (Maintenance UI) |

---

## 18. Troubleshooting
- **Status `FIRESTORE_AND_STORAGE_BACKUP` alih-alih `FULL_SYSTEM_BACKUP`**: Variabel lingkungan `FIREBASE_SERVICE_ACCOUNT_JSON` belum disetel di server. Tambahkan JSON service account Firebase pada environment server dan restart server untuk mengaktifkan ekspor & sinkronisasi Firebase Auth penuh.
- **HTTP `409 BACKUP_IN_PROGRESS`**: Backup lain sedang berjalan. Tunggu selesai, atau jika proses server sempat mati mendadak, lock remote yang berusia >30 menit akan dianggap kadaluarsa otomatis.
- **HTTP `503 RESTORE_IN_PROGRESS`**: Restore Lock aktif. Tunggu restore selesai, atau `SUPER_ADMIN` dapat memeriksa status di tab **Restore Logs** dan menggunakan **Force Unlock** jika benar-benar stale.
- **Verifikasi Backup Gagal (`VERIFICATION_FAILED`)**: Periksa file yang korup/hilang pada modal hasil verifikasi di tab **Backup History**; jangan gunakan backup tersebut untuk restore dan buat backup baru yang sehat.
