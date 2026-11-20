# Database Architecture — Firestore Collections (v3.1.0)

Blueprint schema terdefinisi di `firebase-blueprint.json` dan index komposit di `firestore.indexes.json`.

## Koleksi Utama
- `branches/{branchId}`: Data cabang `DEMANG` dan `SEKIP`.
- `levels/{levelId}`: Konfigurasi tier `BRONZE`, `SILVER`, `JURAGAN`, `SULTAN` beserta `minXp` yang dapat diatur Super Admin.
- `systemSettings/default`: Rate transaksi (`2000`), bonus daftar (`10`), bonus referral (`5`), `refundOnExpiry` (default `false`), `currentCycleId`, dan kebijakan reset periodik.
- `admins/{uid}`: Profil operator dan role (`SUPER_ADMIN`, `ADMIN`, `CASHIER`, legacy `STAFF`), `branchScope` (`DEMANG | SEKIP` wajib untuk `CASHIER`/`STAFF`; `ALL` untuk `ADMIN`/`SUPER_ADMIN`), `branchId`, `cashierCode` (`CASHIER_DEMANG_01/02`, `CASHIER_SEKIP_01/02`), dan `permissions`.
- `members/{uid}`: Data member dengan pemisahan field `xpProgress`, `xpReward` (tersedia), dan `reservedXp` (hold), serta field Two-Step Registration:
  - `status` (`PRE_REGISTERED | ACTIVE | SUSPENDED | INACTIVE | DELETED`)
  - `registrationStatus` (`PRE_REGISTERED | ACTIVE`) dan `registrationStage` (`PHONE_ONLY | COMPLETED`)
  - `authUid` (`null` saat `PRE_REGISTERED`, terisi Firebase UID saat `COMPLETED`), `migratedFromUid` (ID dokumen `pre_*` asal)
  - `branchId`, `preRegisteredAt`, `preRegisteredBy`, `preRegisteredByRole`, `completedAt`, `verifiedPhoneAt`, `registrationBonusGranted`, `preRegistrationNotes`
  - `birthDate`/`birthMonth`/`birthDay`, `memberCategory` (`MAHASISWA | PELAJAR | PEKERJA | LAINNYA`), `currentLevel`, `levelMode`, `lastPlayAt`, `lastPlayBranch`, `currentCycleId`.
- `onboardingPublicStatus/{wHash}` *(BARU v3.1.0)*: Indeks status publik **Zero-PII** berkey `w_<sha256(normalizedWhatsapp)>` yang hanya menyimpan `status`, `hasActiveCode`, `branchId`, `memberUid`, `updatedAt`. Tidak pernah menyimpan nama, saldo XP, atau kode plaintext.
- `onboardingVerifications/{wHash}` *(BARU v3.1.0)*: Penyimpanan **kode 6-digit sekali pakai** ter-hash HMAC-SHA256 (`codeHmac`), `attempts`, `maxAttempts` (`5`), `expiresAt` (`7 hari`), `usedAt`, `branchId`, `memberUid`, `issuedBy`, `issuedByRole`. Diblokir total dari publik; hanya dapat ditulis/dibaca staff terotorisasi atau server Admin SDK.
- `authIndex/{hashId}` & `identityIndex/{indexKey}`: Pemetaan unik `u_<sha256>` / `w_<sha256>` (zero-PII login lookup) dan `username:<val>` / `wa:<val>` (server-only / `SUPER_ADMIN` backup).
- `xpProgressLedger/{entryId}` & `xpRewardLedger/{entryId}`: Buku besar immutable setiap mutasi XP termasuk ID deterministik bonus pendaftaran (`regbonus_prog_<memberId>` & `regbonus_rew_<memberId>`, `source: 'REGISTRATION_BONUS'`), serta `BENEFIT_REQUEST_HOLD`, `DENIED_REFUND`, `EXPIRY_REFUND`, dll.
- `transactions/{transactionId}`: Riwayat transaksi IDR cabang (`amountIdr` integer, `xpRateUsed`, `xpGenerated`, `receiptNumber`, `branch: DEMANG | SEKIP`). Mendukung member `ACTIVE` maupun `PRE_REGISTERED`.
- `referrals/{referralId}`: Riwayat referral valid antar member aktif (hanya tercipta saat Tahap 2 selesai).
- `levelHistory/{historyId}`: Riwayat kenaikan/perubahan level (termasuk `ADMIN_MANUAL_OVERRIDE` dan `ADMIN_RECALCULATE`).
- `benefits/{benefitId}` & `campaigns/{campaignId}`: Katalog benefit XP, benefit level, Challenge, Event, dan Promo (CRUD khusus `ADMIN` / `SUPER_ADMIN`).
- `benefitRequests/{requestId}`: Pengajuan benefit terpadu (`GENERAL_BENEFIT | LEVEL_BENEFIT | CHALLENGE | EVENT | PROMO`) dengan kode `BRQ-...`, XP Hold (`holdLedgerId`), refund (`refundLedgerId`), validitas 7 hari (`expiresAt`), verifikasi Kasir (`usedAt`, `usedBy`, `usedBranch`, `receiptReference`), mendukung `PRE_REGISTERED` (via bantuan Kasir, `memberUsername: ''`) maupun `ACTIVE`.
- `claims/{claimId}` & `redemptions/{redemptionId}`: Antrean persetujuan legacy (`ON_PROCESS | APPROVED | DENIED`).
- `notifications/{notificationId}` & `memberNotifications/{id}`: Kampanye notifikasi (termasuk `NEW_PRE_REGISTERED` dan `NEW_MEMBER_REGISTERED`) serta inbox read/unread member.
- `membershipCycles/{cycleId}` & `cycleSnapshots/{snapshotId}`: Periode season dan snapshot saldo sebelum reset non-destruktif.
- `auditLogs/{logId}`: Catatan audit immutable (`allow update, delete: if false`) termasuk aksi baru `PRE_REGISTERED_MEMBER_CREATED`, `ONBOARDING_CODE_REGENERATED`, `MEMBER_REGISTRATION_COMPLETED`, `CASHIER_LOGIN`, `CASHIER_ACTION`, `CASHIER_DENIED_ACTION`.
- `cmsPublished/homepage`, `cmsDrafts/homepage`, `cmsVersions/{versionId}`: Konten CMS homepage khusus `ADMIN`/`SUPER_ADMIN` (Kasir diblokir).
- `xpAdjustments/{adjustmentId}` & `levelOverrides/{overrideId}`: Catatan immutable penyesuaian XP & override level khusus `ADMIN`/`SUPER_ADMIN` (Kasir diblokir).
- `systemBackups/{backupId}`, `restoreJobs/{restoreJobId}`, `systemOperations/{opId}`: Backup, restore job permanen, dan restore lock zero-PII khusus `SUPER_ADMIN`.

## Index Komposit Tambahan (`firestore.indexes.json`)
- `benefitRequests`: `(memberUid ASC, createdAt DESC)`, `(memberUid ASC, sourceId ASC)`, `(status ASC, createdAt DESC)`, `(memberUsername ASC, createdAt DESC)`, `(memberWhatsapp ASC, createdAt DESC)`.
- `notifications`: `(targetType ASC, createdAt DESC)`.
- `referrals`: `(referrerUid ASC, createdAt DESC)` & `(refereeUid ASC, createdAt DESC)`.
- `members`: `(status ASC, lastPlayAt ASC, createdAt ASC)`, `(status ASC, lastPlayBranch ASC, lastPlayAt ASC)`, `(status ASC, currentLevel ASC, lastPlayAt ASC)`.
- `auditLogs`: `(action ASC, timestamp DESC)` & `(targetId ASC, timestamp DESC)`.
