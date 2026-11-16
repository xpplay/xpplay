# XP System Specification

## 1. Pemisahan Saldo (Wajib)
- **XP Progress (`xpProgress`)**: Menentukan level member (`BRONZE`, `SILVER`, `JURAGAN`, `SULTAN`) dan kelayakan benefit level. **Tidak pernah berkurang saat melakukan redeem benefit.**
- **XP Reward (`xpReward`)**: Saldo aktif yang dapat ditukarkan dengan benefit. Berkurang hanya saat Redemption berstatus `APPROVED`.

**Contoh:**
- Awal: `XP Progress = 450`, `XP Reward = 450`, `Level = JURAGAN`
- Member redeem `200 XP` (`APPROVED`)
- Hasil: `XP Progress = 450`, `XP Reward = 250`, `Level = JURAGAN`.

## 2. Perolehan XP
- **Registrasi Baru**: `+10 XP Progress` dan `+10 XP Reward`.
- **Referral Username Valid**: Member baru `+5 XP`, Referrer `+5 XP` (total member baru saat daftar dengan referral = `15 XP`).
- **Transaksi Cabang**: `XP = floor(nominalRupiah / transactionXpRate)` (default `Rp2.000 = 1 XP`, contoh `Rp100.000 -> 50 XP`), menggunakan aritmatika integer tanpa floating point.
- **Challenge / Event / Promo**: Masuk setelah Admin melakukan `APPROVE` atas claim berstatus `ON_PROCESS`.

## 3. Level Default (Dapat Dikonfigurasi Admin)
- `BRONZE`: `0 – 149` XP Progress
- `SILVER`: `150 – 299` XP Progress
- `JURAGAN`: `300 – 599` XP Progress
- `SULTAN`: `600+` XP Progress
Validasi wajib: `Bronze < Silver < Juragan < Sultan`.

## 4. Membership Cycle & Reset
Reset bersifat **non-destruktif** dan **idempoten**: sebelum saldo di-reset ke cycle baru, snapshot disimpan ke `cycleSnapshots` dan seluruh ledger/transaksi/claim/redemption/level history lama tetap tersimpan permanen.
