# Security Specification — XP PLAY Member System (v3.1.0)

## 1. Data Invariants
1. **Pemisahan XP Progress vs XP Reward:** `xpProgress` hanya bertambah dari sumber sah (penyelesaian pendaftaran online `+10 XP`, referral `+5 XP`, transaksi kasir, claim/campaign approved, penyesuaian Admin) dan hanya dapat berkurang saat *Membership Cycle Reset* atau penyesuaian Admin resmi. `xpReward` tidak boleh negatif (`>= 0`) dan berkurang saat *XP Hold* / *Redemption*.
2. **Two-Step Registration Gate (Anti Public Self-Registration):**
   - Tidak ada pendaftaran publik mandiri tanpa Stage 1 (`PRE_REGISTERED`) dari Kasir/Admin.
   - Dokumen `PRE_REGISTERED` (`registrationStage: 'PHONE_ONLY'`) selalu dibuat dengan `xpProgress == 0`, `xpReward == 0`, `registrationBonusGranted == false`, tanpa akun Firebase Auth, dan tanpa bonus `+10 XP`.
   - Stage 2 (`COMPLETED`) hanya diizinkan secara atomik dengan migrasi dari dokumen `PRE_REGISTERED` yang valid (`migratedFromUid` harus menunjuk ke dokumen `PRE_REGISTERED` dengan `whatsapp` dan `memberId` yang sama, sekaligus menandai dokumen lama `DELETED` + `mergedIntoUid`).
   - Bonus registrasi `+10 XP` bersifat idempoten 1x seumur hidup dengan ID ledger deterministik (`regbonus_prog_{memberId}` & `regbonus_rew_{memberId}`).
   - Akun `PRE_REGISTERED` dilarang mengakses `/member` dashboard maupun membaca dokumen sensitif.
3. **Strict 4-Role RBAC & Cashier Branch Isolation:**
   - Role resmi: `MEMBER`, `CASHIER` (dengan `STAFF` sebagai legacy alias), `ADMIN`, `SUPER_ADMIN`.
   - `CASHIER` wajib terikat pada `branchScope in ['DEMANG', 'SEKIP']` (dilarang `ALL`).
   - Kasir Demang hanya boleh membaca/menulis transaksi, benefit request, pre-registrasi, dan kode verifikasi cabang `DEMANG`; Kasir Sekip hanya untuk cabang `SEKIP`.
   - `CASHIER` dilarang keras melakukan: XP Adjustment, Level Override, Password Reset Member, Benefit CRUD, Challenge/Event/Promo CRUD, CMS Edit/Publish, Admin/Cashier Management, Backup/Restore, System/Level/XP Settings, atau membaca `auditLogs`.
4. **Member Self-Modification Ban:** Member tidak boleh mengubah `xpProgress`, `xpReward` (selain atomic hold resmi), `currentLevel`, `levelMode`, `status`, `referredByUid`, `referredByUsername`, `referralCount`, `lastPlayAt`, `lastPlayBranch`, `registrationBonusGranted`, atau `currentCycleId` melalui client SDK.
5. **Approval State Machine Integrity:** Member hanya boleh membuat `benefitRequests`/`claims`/`redemptions` dengan `status == 'ON_PROCESS'` dan `memberUid == request.auth.uid` jika berstatus `ACTIVE` & `COMPLETED`. Transisi status hanya boleh dilakukan operator terotorisasi (`APPROVED`/`DENIED`/`USED`/`EXPIRED`/`REFUNDED`) dan status terminal tidak dapat diubah mundur.
6. **PII Isolation & Zero-PII Public Lookup:**
   - `identityIndex` hanya dapat diakses server/Admin SDK (`SUPER_ADMIN` backup/restore).
   - `authIndex` dan `onboardingPublicStatus` hanya mengizinkan `get` menggunakan exact SHA-256 hash (`^[uw]_[a-f0-9]{64}$`) dan tidak menyimpan PII maupun kode verifikasi plaintext.
   - `onboardingVerifications` menyimpan HMAC-SHA256 + salt (bukan kode 6-digit plaintext) dan tidak dapat dibaca publik maupun member.
7. **Immutable Audit Trail:** `auditLogs` melarang `update` dan `delete` untuk semua role (termasuk `SUPER_ADMIN` saat restore). Setiap penolakan akses Kasir dicatat dengan action `CASHIER_DENIED_ACTION`.

## 2. Adversarial Payloads ("Dirty Dozen+" — Wajib Menghasilkan PERMISSION_DENIED / HTTP 403)
1. **Member Self-XP Tampering:** Member mencoba `updateDoc(doc(db, 'members', myUid), { xpProgress: 9999, xpReward: 9999 })`.
2. **Member Self-Level Escalation:** Member mencoba `updateDoc(doc(db, 'members', myUid), { currentLevel: 'SULTAN' })`.
3. **Member Self-Approval Claim / Benefit Request:** Member mencoba `createDoc` atau `updateDoc` dengan `{ status: 'APPROVED' }`.
4. **Member Self-Approval Redemption:** Member mencoba `updateDoc` pada `redemptions/{id}` dengan `{ status: 'APPROVED' }`.
5. **Member Forged Request for Another User:** Member A membuat dokumen di `claims`/`benefitRequests` dengan `memberUid: memberB_uid`.
6. **Member Reading Other Member PII:** Member A memanggil `getDoc(doc(db, 'members', memberB_uid))` atau `getDocs(collection(db, 'members'))`.
7. **Member Scraping Identity Index or Onboarding Verifications:** Member/anonim mencoba membaca `identityIndex/*`, `onboardingVerifications/*`, atau `list` pada `onboardingPublicStatus`.
8. **Member Creating Fake Transaction:** Member mencoba menulis langsung ke `transactions/{id}` untuk mendapatkan 500 XP.
9. **Member Escalating to Admin/Cashier:** Member mencoba `setDoc(doc(db, 'admins', myUid), { role: 'SUPER_ADMIN', active: true })`.
10. **Member Modifying Level Thresholds:** Member mencoba `updateDoc(doc(db, 'levels', 'SULTAN'), { minXp: 1 })`.
11. **Tampering With Audit Log:** Member, Cashier, Admin, atau Super Admin mencoba `update`/`delete` pada `auditLogs/{id}`.
12. **Unverified Admin/Cashier Email Spoof:** Akun dengan email admin/kasir namun `request.auth.token.email_verified == false` mencoba mengakses `admins` atau menulis transaksi.
13. **Public Self-Registration Bypass:** Pengguna baru tanpa dokumen `PRE_REGISTERED` mencoba `setDoc(doc(db, 'members', myUid), { status: 'ACTIVE', xpProgress: 10 })` secara langsung.
14. **Duplicate Registration Bonus Replay:** Member yang sudah menyelesaikan registrasi mencoba menulis kedua kalinya ke `xpProgressLedger/regbonus_prog_{memberId}` atau mengulang form completion.
15. **PRE_REGISTERED Dashboard Access:** Customer berstatus `PRE_REGISTERED` mencoba login atau mengajukan self-request ke `benefitRequests`/`claims`.
16. **Cashier Cross-Branch Violation:** Kasir `DEMANG` mencoba mencatat transaksi, pre-registrasi, atau memproses benefit request dengan `branch: 'SEKIP'` atau membaca `transactions` cabang `SEKIP`.
17. **Cashier XP Adjustment Attempt:** Kasir mencoba menulis ke `xpAdjustments/{id}`, mengubah XP secara manual, atau menulis ledger `ADMIN_ADJUSTMENT` / `XP_REWARD_ADMIN_ADJUSTMENT`.
18. **Cashier Level Override Attempt:** Kasir mencoba menulis ke `levelOverrides/{id}` atau mengubah `levelMode: 'MANUAL_OVERRIDE'`.
19. **Cashier Benefit / Campaign CRUD Attempt:** Kasir mencoba membuat/mengubah/menghapus dokumen di `benefits` atau `campaigns`.
20. **Cashier CMS Edit / Publish Attempt:** Kasir mencoba membaca `cmsDrafts`, `cmsVersions`, atau menulis ke `cmsPublished`/`cmsDrafts`/`cmsVersions`.
21. **Cashier Admin / Backup / Settings Attempt:** Kasir mencoba mengakses `admins` (selain dokumen sendiri), `systemSettings` write, `systemBackups`, `restoreJobs`, atau membaca `auditLogs`.
22. **Shadow Field / Value Poisoning Attack:** Pengguna atau Kasir menyisipkan field tak dikenal (e.g., `isVerified: true`, `superBonus: 999`) atau string 1MB pada `members`, `onboardingPublicStatus`, `onboardingVerifications`, atau `admins`.
