# XP System Specification (v3.1.0)

## 1. Pemisahan Saldo (Wajib)
- **XP Progress (`xpProgress`)**: Menentukan level member (`BRONZE`, `SILVER`, `JURAGAN`, `SULTAN`) dan kelayakan benefit level. **Tidak pernah berkurang saat mengajukan/redeem benefit.**
- **XP Reward Tersedia (`xpReward`)**: Saldo aktif yang dapat ditukarkan dengan benefit. Saat member (atau Kasir atas nama member) mengajukan `benefitRequests` berbiaya XP, nominal `xpCost` **langsung ditahan (Hold)** dari `xpReward` ke `reservedXp` di dalam transaksi atomik.
- **XP Ditahan / Reserved XP (`reservedXp`)**: Saldo yang terkunci selama status pengajuan `ON_PROCESS`. Dilepas permanen saat `APPROVED`, atau dikembalikan otomatis (`DENIED_REFUND`) ke `xpReward` saat `DENIED`. Lihat detail lengkap di `XP_LEDGER.md` & `BENEFIT_REQUEST.md`.

**Contoh:**
- Awal: `XP Progress = 450`, `XP Reward = 450`, `Reserved XP = 0`, `Level = JURAGAN`
- Pengajuan benefit `200 XP` (`ON_PROCESS`): `XP Progress = 450`, `XP Reward = 250`, `Reserved XP = 200`, `Level = JURAGAN`
- Jika `APPROVED`: `XP Reward = 250`, `Reserved XP = 0`, berlaku 7 hari (`expiresAt = approvedAt + 7 hari`)
- Jika `DENIED`: `XP Reward = 450`, `Reserved XP = 0`, tercatat ledger `+200 DENIED_REFUND`.

## 2. Perolehan XP & Aturan Two-Step Registration (v3.1.0)
- **Tahap 1 — Pre-Registration (`PRE_REGISTERED` / `PHONE_ONLY`)**:
  - Saldo awal **`0 XP Progress` & `0 XP Reward`**.
  - **TIDAK** diberikan bonus pendaftaran `+10 XP` dan **TIDAK** diberikan bonus referral pada Tahap 1.
  - Pelanggan `PRE_REGISTERED` **sudah dapat** mengumpulkan XP dari transaksi kasir dan menukarkan benefit via bantuan Kasir; seluruh saldo & transaksi tersebut tetap tersimpan utuh.
- **Tahap 2 — Online Completion (`PRE_REGISTERED -> ACTIVE`)**:
  - Seluruh XP dari transaksi Tahap 1 **dipertahankan penuh**.
  - **Bonus Registrasi Idempoten**: `+10 XP Progress` dan `+10 XP Reward` (`source: 'REGISTRATION_BONUS'`, ID ledger deterministik `regbonus_prog_<memberId>` dan `regbonus_rew_<memberId>`). Hanya diberikan **satu kali** saat penyelesaian penuh; pengulangan form/replay token tidak akan pernah menambah bonus kedua.
  - **Referral Username Valid (Opsional saat Tahap 2)**: Member baru `+5 XP`, Referrer aktif `+5 XP` (total bonus daftar + referral untuk member baru = `+15 XP`).
- **Transaksi Cabang (`DEMANG` / `SEKIP`)**: `XP = floor(nominalRupiah / transactionXpRate)` (default `Rp2.000 = 1 XP`, contoh `Rp100.000 -> 50 XP`), menggunakan aritmatika integer tanpa floating point. Berlaku untuk member `ACTIVE` maupun `PRE_REGISTERED`.
- **Challenge / Event / Promo**: Masuk setelah approval atas pengajuan `ON_PROCESS`.
- **Admin XP Adjustment (`ADMIN` / `SUPER_ADMIN` only; Kasir diblokir)**: Penyesuaian `XP Progress` (`ADMIN_ADJUSTMENT`) dan `XP Reward` (`XP_REWARD_ADMIN_ADJUSTMENT`) terpisah dengan audit immutable.

## 3. Level Default (Dapat Dikonfigurasi Super Admin)
- `BRONZE`: `0 – 149` XP Progress
- `SILVER`: `150 – 299` XP Progress
- `JURAGAN`: `300 – 599` XP Progress
- `SULTAN`: `600+` XP Progress
Validasi wajib: `Bronze < Silver < Juragan < Sultan`.

## 4. Membership Cycle & Reset
Reset bersifat **non-destruktif** dan **idempoten**: sebelum saldo di-reset ke cycle baru, snapshot disimpan ke `cycleSnapshots` dan seluruh ledger/transaksi/benefitRequests/claim/redemption/level history lama tetap tersimpan permanen.
