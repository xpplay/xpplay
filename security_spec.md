# Security Specification — XP PLAY Member System

## 1. Data Invariants
1. **Pemisahan XP Progress vs XP Reward:** `xpProgress` hanya bertambah dari sumber sah (registrasi, referral, transaksi, claim approved, bonus admin) dan hanya dapat berkurang saat *Membership Cycle Reset* terkonfigurasi. `xpReward` tidak boleh negatif (`>= 0`) dan berkurang saat *Redemption* `APPROVED`.
2. **Member Self-Modification Ban:** Member tidak boleh mengubah `xpProgress`, `xpReward`, `currentLevel`, `status`, `referredByUid`, `referredByUsername`, `referralCount`, `lastPlayAt`, `lastPlayBranch`, atau `currentCycleId` melalui client SDK.
3. **Approval State Machine Integrity:** Member hanya boleh membuat `claims` dan `redemptions` dengan `status == 'ON_PROCESS'` dan `memberUid == request.auth.uid`. Hanya `ADMIN`/`SUPER_ADMIN`/`STAFF` terotorisasi yang boleh mengubah status menjadi `APPROVED` atau `DENIED`, dan transisi dari status terminal (`APPROVED`/`DENIED`) ditolak.
4. **PII Isolation & Zero Blanket Reads:** Member tidak dapat melakukan `get` atau `list` atas profil `members/{otherUid}`, `claims`, `redemptions`, `transactions`, `xpProgressLedger`, `xpRewardLedger`, `referrals`, atau `memberNotifications` milik member lain.
5. **Identity Index Privacy:** Koleksi `identityIndex` hanya dapat diakses oleh server/Admin SDK (`allow read, write: if false` pada client rules) untuk mencegah account enumeration dan scraping nomor WhatsApp/username.
6. **Admin RBAC Protection:** Member tidak boleh menulis ke `admins`, `systemSettings`, `levels`, `branches`, `benefits`, `campaigns`, `notifications`, `membershipCycles`, `cycleSnapshots`, atau `auditLogs`.

## 2. "Dirty Dozen" Adversarial Payloads (Harus Menghasilkan PERMISSION_DENIED)
1. **Member Self-XP Tampering:** Member mencoba `updateDoc(doc(db, 'members', myUid), { xpProgress: 9999, xpReward: 9999 })`.
2. **Member Self-Level Escalation:** Member mencoba `updateDoc(doc(db, 'members', myUid), { currentLevel: 'SULTAN' })`.
3. **Member Self-Approval Claim:** Member mencoba `createDoc` atau `updateDoc` pada `claims/{claimId}` dengan `{ status: 'APPROVED' }`.
4. **Member Self-Approval Redemption:** Member mencoba `updateDoc` pada `redemptions/{id}` dengan `{ status: 'APPROVED' }`.
5. **Member Forged Claim for Another User:** Member A membuat dokumen di `claims` dengan `memberUid: memberB_uid`.
6. **Member Reading Other Member PII:** Member A memanggil `getDoc(doc(db, 'members', memberB_uid))` atau `getDocs(collection(db, 'members'))` tanpa filter kepemilikan.
7. **Member Scraping Identity Index:** Member mencoba membaca `identityIndex/username:andi` untuk mencari nomor WhatsApp atau authEmail.
8. **Member Creating Fake Transaction:** Member mencoba menulis langsung ke `transactions/{id}` untuk mendapatkan 500 XP.
9. **Member Escalating to Admin:** Member mencoba `setDoc(doc(db, 'admins', myUid), { role: 'SUPER_ADMIN', active: true })`.
10. **Member Modifying Level Thresholds:** Member mencoba `updateDoc(doc(db, 'levels', 'SULTAN'), { minXp: 1 })`.
11. **Member Tampering With Audit Log:** Member atau Staff mencoba menghapus atau mengubah dokumen di `auditLogs/{id}`.
12. **Unverified Admin Email Spoof:** Akun dengan klaim email admin namun `request.auth.token.email_verified == false` mencoba mengakses `admins` atau `systemSettings`.
