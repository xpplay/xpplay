# Database Architecture — Firestore Collections

Blueprint schema terdefinisi di `firebase-blueprint.json` dan index komposit di `firestore.indexes.json`.

## Koleksi Utama
- `branches/{branchId}`: Data cabang `DEMANG` dan `SEKIP`.
- `levels/{levelId}`: Konfigurasi tier `BRONZE`, `SILVER`, `JURAGAN`, `SULTAN` beserta `minXp` yang dapat diatur Admin.
- `systemSettings/default`: Rate transaksi (`2000`), bonus daftar (`10`), bonus referral (`5`), `currentCycleId`, dan kebijakan reset periodik.
- `admins/{uid}`: Profil operator dan role (`SUPER_ADMIN`, `ADMIN`, `STAFF`) serta `branchScope`.
- `members/{uid}`: Data member dengan pemisahan field `xpProgress` dan `xpReward`, `currentLevel`, `status` (`ACTIVE | SUSPENDED | INACTIVE | DELETED`), `lastPlayAt`, `lastPlayBranch`, dan `currentCycleId`.
- `identityIndex/{indexKey}`: Pemetaan unik `username:<val>` dan `wa:<val>` (server-only, tertutup dari client).
- `xpProgressLedger/{entryId}` & `xpRewardLedger/{entryId}`: Buku besar immutable setiap mutasi XP.
- `transactions/{transactionId}`: Riwayat transaksi IDR cabang (`amountIdr` integer, `xpRateUsed`, `xpGenerated`, `receiptNumber`).
- `referrals/{referralId}`: Riwayat referral valid antar member.
- `levelHistory/{historyId}`: Riwayat kenaikan level.
- `benefits/{benefitId}`: Katalog benefit XP & benefit level (`claimable`, `redeemable`, `levelRequirement`, `stock`).
- `campaigns/{campaignId}`: Challenge, Event, dan Promo (`startAt`, `endAt`, `xpReward`, `maxClaimsPerMember`, `status`).
- `claims/{claimId}` & `redemptions/{redemptionId}`: Antrean persetujuan (`ON_PROCESS | APPROVED | DENIED`) dengan jejak reviewer.
- `notifications/{notificationId}` & `memberNotifications/{id}`: Kampanye notifikasi (termasuk target inactivity) dan inbox read/unread member.
- `membershipCycles/{cycleId}` & `cycleSnapshots/{snapshotId}`: Periode season dan snapshot saldo sebelum reset tanpa menghapus riwayat lama.
- `auditLogs/{logId}`: Catatan audit setiap aksi penting (`actorId`, `actorRole`, `action`, `before`, `after`, `timestamp`).
