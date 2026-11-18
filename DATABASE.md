# Database Architecture — Firestore Collections

Blueprint schema terdefinisi di `firebase-blueprint.json` dan index komposit di `firestore.indexes.json`.

## Koleksi Utama
- `branches/{branchId}`: Data cabang `DEMANG` dan `SEKIP`.
- `levels/{levelId}`: Konfigurasi tier `BRONZE`, `SILVER`, `JURAGAN`, `SULTAN` beserta `minXp` yang dapat diatur Admin.
- `systemSettings/default`: Rate transaksi (`2000`), bonus daftar (`10`), bonus referral (`5`), `currentCycleId`, dan kebijakan reset periodik.
- `admins/{uid}`: Profil operator dan role (`SUPER_ADMIN`, `ADMIN`, `STAFF`) serta `branchScope`.
- `members/{uid}`: Data member dengan pemisahan field `xpProgress` dan `xpReward`, `currentLevel`, `levelMode` (`AUTOMATIC | MANUAL_OVERRIDE | RESET`), `status` (`ACTIVE | SUSPENDED | INACTIVE | DELETED`), `lastPlayAt`, `lastPlayBranch`, dan `currentCycleId`.
- `identityIndex/{indexKey}`: Pemetaan unik `username:<val>` dan `wa:<val>` (server-only, tertutup dari client).
- `xpProgressLedger/{entryId}` & `xpRewardLedger/{entryId}`: Buku besar immutable setiap mutasi XP.
- `transactions/{transactionId}`: Riwayat transaksi IDR cabang (`amountIdr` integer, `xpRateUsed`, `xpGenerated`, `receiptNumber`).
- `referrals/{referralId}`: Riwayat referral valid antar member.
- `levelHistory/{historyId}`: Riwayat kenaikan/perubahan level (termasuk `ADMIN_MANUAL_OVERRIDE` dan `ADMIN_RECALCULATE`).
- `benefits/{benefitId}`: Katalog benefit XP & benefit level (`claimable`, `redeemable`, `levelRequirement`, `stock`).
- `campaigns/{campaignId}`: Challenge, Event, dan Promo (`startAt`, `endAt`, `xpReward`, `maxClaimsPerMember`, `status`).
- `claims/{claimId}` & `redemptions/{redemptionId}`: Antrean persetujuan (`ON_PROCESS | APPROVED | DENIED`) dengan jejak reviewer.
- `notifications/{notificationId}` & `memberNotifications/{id}`: Kampanye notifikasi (termasuk target inactivity) dan inbox read/unread member.
- `membershipCycles/{cycleId}` & `cycleSnapshots/{snapshotId}`: Periode season dan snapshot saldo sebelum reset tanpa menghapus riwayat lama.
- `auditLogs/{logId}`: Catatan audit setiap aksi penting (`actorId`, `actorRole`, `action`, `before`, `after`, `timestamp`).
- `cmsPublished/homepage`: Konten halaman depan versi aktif (`PUBLISHED`) yang dibaca publik & member secara real-time.
- `cmsDrafts/homepage`: Konten draft homepage khusus `ADMIN` / `SUPER_ADMIN` sebelum dipublikasikan.
- `cmsVersions/{versionId}`: Riwayat snapshot versi immutable CMS homepage (`v1`, `v2`, dst.) dengan metadata pembuat, waktu publish, dan `sourceAction` (`PUBLISH | ROLLBACK`).
- `xpAdjustments/{adjustmentId}`: Catatan immutable penyesuaian `XP Progress` (`ADMIN_ADJUSTMENT`) dan `XP Reward` (`XP_REWARD_ADMIN_ADJUSTMENT`) oleh `ADMIN`/`SUPER_ADMIN`, dengan `operationId` idempoten, `beforeBalance`, `afterBalance`, `levelBefore`, `levelAfter`, `reason`, `reference`, `auditId`, `adminId`, dan `timestamp`.
- `levelOverrides/{overrideId}`: Catatan immutable perubahan level manual (`MANUAL_OVERRIDE`) dan rekalkulasi dari XP (`RECALCULATE`) oleh `ADMIN`/`SUPER_ADMIN`, menyimpan `operationId`, `xpProgressSnapshot`, `previousLevel`, `newLevel`, `previousLevelMode`, `newLevelMode`, `reason`, `reference`, `auditId`, dan `timestamp`.
- `systemBackups/{backupId}`: Metadata immutable/terproteksi untuk setiap snapshot backup (`MANUAL`, `SCHEDULED`, `PRE_RESTORE`), status siklus hidup, `scopeType` (`FULL_SYSTEM_BACKUP | FIRESTORE_AND_STORAGE_BACKUP`), checksum manifest SHA-256, hasil verifikasi 9-cek, dan flag perlindungan retensi (`SUPER_ADMIN` only).
- `restoreJobs/{restoreJobId}`: Riwayat permanen (`allow delete: if false`) setiap eksekusi Full System Restore termasuk `preRestoreBackupId`, log langkah (`steps`), perbandingan jumlah dokumen/storage, laporan 12-Point Data Integrity Audit, status akhir (`COMPLETED | VERIFICATION_FAILED | FAILED`), dan rekomendasi pemulihan (`SUPER_ADMIN` only).
- `systemOperations/{opId}`: Tiga dokumen operasional singleton (`restoreLock` zero-PII untuk Maintenance Mode real-time, `backupLock` untuk pencegahan tabrakan backup paralel, dan `backupRetention` untuk konfigurasi retensi).

## Index Komposit Tambahan (`firestore.indexes.json`)
- `members`: `(status ASC, lastPlayAt ASC, createdAt ASC)`, `(status ASC, lastPlayBranch ASC, lastPlayAt ASC)`, `(status ASC, currentLevel ASC, lastPlayAt ASC)` untuk query Inactive Members berbasis cursor pagination.
- `auditLogs`: `(action ASC, timestamp DESC)` untuk filter cepat riwayat `PASSWORD_CHANGED_BY_ADMIN` dan audit backup/restore.


