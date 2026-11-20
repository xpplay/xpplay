# Panduan Pendaftaran Member Dua Tahap — XP PLAY (v3.1.0)

Sistem XP PLAY menerapkan **Two-Step Membership Registration** untuk memastikan setiap member yang terdaftar di cabang **XP PLAY DEMANG** dan **XP PLAY SEKIP** merupakan pelanggan terverifikasi kasir tanpa celah registrasi publik sembarangan (*zero public self-registration*).

---

## Ringkasan Alur Dua Tahap

| Aspek | Tahap 1 — Pre-Registration (Kasir / Admin) | Tahap 2 — Online Completion (Customer) |
| :--- | :--- | :--- |
| **Aktor** | `CASHIER` (terkunci cabang), `ADMIN`, `SUPER_ADMIN` | Pelanggan melalui `/register` atau `/complete-membership` |
| **Input Wajib** | Nomor WhatsApp saja (+ catatan opsional) | WhatsApp + CAPTCHA -> Kode 6-Digit -> Profil Lengkap + Password |
| **Status Member** | `PRE_REGISTERED` (`registrationStage: PHONE_ONLY`) | `ACTIVE` (`registrationStage: COMPLETED`) |
| **Akun Firebase Auth** | **Belum dibuat** (`authUid: null`) | **Dibuat secara atomik saat penyelesaian** |
| **Akses `/member`** | **DIBLOKIR** hingga Tahap 2 selesai | **DIIZINKAN** |
| **Bonus `+10 XP`** | **TIDAK diberikan** (`0 XP`) | **Diberikan sekali secara idempoten** (`regbonus_prog_<memberId>`, `regbonus_rew_<memberId>`) |
| **Bonus Referral `+5/+5 XP`** | **TIDAK diberikan** | **Diberikan jika referral username valid saat Tahap 2** |
| **Transaksi XP & Benefit** | **Tetap bisa bermain, mengumpulkan XP transaksi, dan mengajukan Benefit Request via Kasir** | **Seluruh saldo XP, transaksi, & riwayat Tahap 1 dipertahankan 100%** |

---

## Tahap 1 — Pre-Registration di Kasir / Admin

1. **Kasir** membuka `/cashier` -> tab **Register Customer** (cabang otomatis terkunci ke `DEMANG` atau `SEKIP`), atau **Admin / Super Admin** membuka panel Pre-Register pada menu **Members**.
2. Input nomor **WhatsApp** pelanggan (dinormalisasi otomatis ke format Indonesia `628...`) dan catatan opsional.
3. Sistem memvalidasi **anti-duplikasi** nomor WhatsApp terhadap member aktif maupun pre-registered.
4. Sistem membuat:
   - Dokumen `members/{preDocId}` dengan `status: 'PRE_REGISTERED'`, `registrationStage: 'PHONE_ONLY'`, `xpProgress: 0`, `xpReward: 0`, `reservedXp: 0`, `registrationBonusGranted: false`, `authUid: null`.
   - Indeks status publik zero-PII `onboardingPublicStatus/{wHash}` (`status: 'PRE_REGISTERED'`, `hasActiveCode: true`, `branchId`).
   - **Kode Verifikasi 6-Digit Sekali Pakai** (*cryptographic HMAC-SHA256*, berlaku **7 hari**, maks **5 percobaan** salah) yang hanya ditampilkan satu kali kepada Kasir/Admin dan disimpan dalam bentuk hash HMAC di `onboardingVerifications/{wHash}` (tidak pernah plaintext di dokumen publik).
   - **Tautan Onboarding Siap Salin / QR**: `/register?wa=<nomor>&code=<6digit>`.
   - Audit log `PRE_REGISTERED_MEMBER_CREATED` dan notifikasi admin `NEW_PRE_REGISTERED`.
5. Jika kode 6-digit hilang atau kadaluarsa (>7 hari), Kasir (khusus cabangnya) atau Admin dapat menekan **Terbitkan Ulang Kode** (`ONBOARDING_CODE_REGENERATED`) dari detail member.

---

## Tahap 2 — Penyelesaian Pendaftaran Online (`/register` & `/complete-membership`)

### Step 1: Verifikasi Nomor WhatsApp + CAPTCHA
Pelanggan memasukkan nomor WhatsApp dan menyelesaikan CAPTCHA:
- **Belum terdaftar (`NOT_FOUND`)**: Pendaftaran **ditolak** dengan pesan wajib:
  > *"Nomor WhatsApp belum didaftarkan oleh XP PLAY. Silakan hubungi Kasir XP PLAY untuk mendaftar sebagai member."*
- **Sudah aktif (`ACTIVE`)**: Pendaftaran **ditolak** dengan pesan:
  > *"Membership sudah aktif. Silakan masuk menggunakan akun Anda."* (+ tombol ke `/login`).
- **Disuspend (`SUSPENDED`)**: Pendaftaran **ditolak**.
- **Terdaftar di Kasir (`PRE_REGISTERED`)**: Menampilkan banner resmi:
  > *"Nomor WhatsApp Anda sudah terdaftar di XP PLAY! Silakan lengkapi data profil Anda untuk mengaktifkan akun dan klaim bonus +10 XP."*
  serta tombol **`LENGKAPI PENDAFTARAN`**.

### Step 2: Verifikasi Kode 6-Digit Sekali Pakai
- Pelanggan memasukkan kode 6-digit yang diberikan Kasir (otomatis terisi jika membuka tautan QR dari Kasir).
- Validasi server-side (`/api/onboarding/verify-code`) menggunakan perbandingan timing-safe terhadap HMAC-SHA256:
  - Maksimal **5 kali** salah input sebelum terkunci (butuh re-issue oleh Kasir/Admin).
  - Masa berlaku **7 hari**.
  - Menghasilkan `onboardingSessionToken` bertanda tangan HMAC **sekali pakai** (*single-use replay-protected*).

### Step 3: Lengkapi Profil & Buat Password
- **Nomor WhatsApp**: terkunci (*read-only*, tidak dapat diubah).
- **Field wajib**: Nama Lengkap, Username (unik, 3–24 karakter, bukan reserved word), Tanggal Lahir (validasi Gregorian Asia/Jakarta), Status Member (`Mahasiswa`, `Pelajar`, `Pekerja`, `Lainnya`), Cabang Pilihan (`DEMANG` / `SEKIP`), Password & Konfirmasi Password.
- **Field opsional**: Social Media, Username Referral (anti *self-referral* & hanya referrer `ACTIVE`).

### Step 4: Aktivasi Atomik & Migrasi Data Tahap 1
1. Membuat akun **Firebase Auth (Email/Password)** untuk pertama kalinya.
2. Menyalin & memigrasikan seluruh saldo XP, `lastPlayAt`, `lastPlayBranch`, transaksi, dan riwayat benefit dari dokumen `pre_*` ke `members/{authUid}` dengan `migratedFromUid`, serta memensiunkan dokumen lama secara atomik.
3. Mengubah `status: 'PRE_REGISTERED' -> 'ACTIVE'` dan `registrationStage: 'PHONE_ONLY' -> 'COMPLETED'`.
4. Mengkreditkan **Bonus Registrasi `+10 XP Progress` & `+10 XP Reward`** secara **idempoten satu kali saja** menggunakan ID ledger deterministik `regbonus_prog_<memberId>` dan `regbonus_rew_<memberId>` (`source: 'REGISTRATION_BONUS'`). Pengulangan form atau replay token tidak akan pernah memicu bonus kedua.
5. Jika terdapat referral valid, menambahkan **`+5 XP`** ke member baru dan **`+5 XP`** ke referrer (total bonus daftar + referral untuk member baru = `+15 XP`).

---

## Aturan Login Member `PRE_REGISTERED`

Jika pelanggan berstatus `PRE_REGISTERED` mencoba login melalui `/login`:
- Sistem menampilkan pesan resmi:
  > *"Nomor WhatsApp Anda sudah didaftarkan oleh Kasir, namun Anda belum menyelesaikan pendaftaran online. Silakan lengkapi pendaftaran terlebih dahulu."*
- Menyediakan tombol langsung **`Lengkapi Pendaftaran`** yang mengarahkan ke `/register?wa=<nomor>`.

---

## Laporan Pendaftaran Belum Selesai (*Incomplete Registration Report*)

Admin dan Super Admin dapat memantau daftar pelanggan `PRE_REGISTERED` yang belum menyelesaikan Tahap 2 pada menu **Inactive Members -> Pendaftaran Belum Selesai** dengan filter **7 / 14 / 30 hari** dan filter cabang (`DEMANG` / `SEKIP`). Laporan bersifat **read-only** dan sistem **tidak pernah menghapus otomatis** akun `PRE_REGISTERED` agar riwayat transaksi tetap aman.
