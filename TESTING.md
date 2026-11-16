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
   - Default deny, `identityIndex` terkunci, member dilarang ubah XP/level/status, claims/redemptions terkunci `ON_PROCESS` saat create & hanya Admin yang boleh update.

## Pengujian Manual End-to-End (Browser)
1. Login sebagai Super Admin (`spv.xpplay@gmail.com`) di `/admin/login`.
2. Tambahkan member baru di menu `Members` (atau daftar via `/register`). Pastikan `XP Progress = 10`, `XP Reward = 10`.
3. Tambahkan transaksi `Rp100.000` di cabang `DEMANG`. Pastikan `XP Progress = 60`, `XP Reward = 60`, `Last Play` terisi.
4. Uji Redemption: saat `XP Progress = 450, XP Reward = 450`, approve redeem `200 XP` -> pastikan `XP Progress` tetap `450`, `XP Reward` menjadi `250`, dan level tetap `JURAGAN`.
5. Uji penolakan (`DENY`) Claim & Redemption -> pastikan saldo tidak berubah dan alasan tercatat.
6. Uji Reset Cycle -> pastikan snapshot terbentuk di `cycleSnapshots` dan ledger/transaksi lama tetap ada.
