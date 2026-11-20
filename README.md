# XP PLAY Member System — Demang & Sekip

Sistem web membership resmi untuk **XP PLAY DEMANG (XP PLAY GAME CENTER)** dan **XP PLAY SEKIP (XP PLAY GAME PLATINUM)**.

## Fitur Utama (v3.1.0)
- **Two-Step Membership Registration (Tanpa Registrasi Publik Sembarangan)**:
  - **Tahap 1 (Kasir / Admin)**: Pre-registrasi pelanggan hanya dengan nomor WhatsApp (`PRE_REGISTERED` / `PHONE_ONLY`, `0 XP`, belum ada akun Firebase Auth, tanpa bonus `+10 XP`), menerbitkan **Kode Verifikasi 6-Digit Sekali Pakai** (HMAC-SHA256, 7 hari, maks 5 percobaan) + tautan QR `/register?wa=...&code=...`.
  - **Tahap 2 (Customer Online di `/register` & `/complete-membership`)**: Verifikasi nomor WhatsApp + CAPTCHA -> verifikasi kode 6-digit -> lengkapi profil & buat password -> aktivasi atomik Firebase Auth (`PRE_REGISTERED -> ACTIVE`), migrasi penuh saldo XP & riwayat Tahap 1, serta **bonus `+10 XP` sekali pakai (idempoten)** + referral opsional `+5/+5 XP`.
- **Dedicated Branch-Isolated Cashier Portal (`/cashier`) & 4-Role RBAC**:
  - Matriks hak akses formal **`MEMBER`**, **`CASHIER`**, **`ADMIN`**, **`SUPER_ADMIN`** di 4 lapisan (UI, React Router 403, Express API, & Firestore Security Rules).
  - Portal `/cashier` menampilkan **hanya 9 menu operasional** yang terkunci ketat ke cabang masing-masing (`DEMANG` atau `SEKIP`), termasuk 4 slot akun kasir yang dikelola Super Admin tanpa kredensial hardcoded.
  - Akses ilegal ke `/admin/*`, `/superadmin/*`, XP Adjustment, Level Override, Password Member, CMS, Benefit/Campaign CRUD, atau Backup/Restore otomatis diblokir (`403 Forbidden`) dan dicatat sebagai `CASHIER_DENIED_ACTION`.
- **Pemisahan Saldo XP Progress, XP Reward Tersedia & Reserved XP Hold**: `XP Progress` menentukan level & benefit tanpa pernah berkurang saat redeem/hold; `XP Reward` langsung ditahan (*immediate atomic XP Hold*) saat pengajuan benefit dan otomatis dikembalikan (*auto-refund*) bila ditolak.
- **Unified Benefit Request, Masa Berlaku 7 Hari & Bantuan Kasir**: Pengajuan Benefit Umum, Level Benefit, Challenge, Event, dan Promo terpusat dalam satu alur (`ON_PROCESS -> APPROVED/DENIED/REFUNDED -> USED/EXPIRED/REFUNDED`) dengan kode voucher `BRQ-...`, masa berlaku 7 hari, kebijakan opsional `refundOnExpiry`, dukungan bantuan Kasir (termasuk bagi pelanggan `PRE_REGISTERED`), serta verifikasi `MARK AS USED`.
- **Admin & Super Admin Console + Laporan Split Metrik**: Pemisahan metrik `NEW PRE-REGISTERED` vs `NEW ACTIVE MEMBERS`, laporan read-only **Pendaftaran Belum Selesai (7 / 14 / 30 hari)**, 8-Tab Member Detail Drawer dengan kartu Two-Step & re-issue kode, CMS Homepage Studio, XP Adjustment, Level Override, Password Member, Inactive Members, Reset Cycle non-destruktif, serta Backup & Restore (26 koleksi) + **15-Point Data Integrity Audit**.

## Cabang Resmi
- **XP PLAY DEMANG** — XP PLAY GAME CENTER ([Maps](https://maps.app.goo.gl/JCAvqgP2X2M9morS7))
- **XP PLAY SEKIP** — XP PLAY GAME PLATINUM ([Maps](https://maps.app.goo.gl/KZGGXG7JYzJ3hQA39))
- **WhatsApp Resmi**: `08983761001`
- **Timezone**: `Asia/Jakarta`

## Menjalankan Secara Lokal
```bash
npm install
cp .env.example .env
npm run dev
```

## Dokumentasi Lengkap
- `ARCHITECTURE.md` — Arsitektur full-stack & alur data
- `MEMBER_REGISTRATION.md` — Panduan Two-Step Membership Registration & Kode 6-Digit
- `CASHIER_GUIDE.md` — Panduan Portal Kasir (`/cashier`), 9 Menu & Isolasi Cabang
- `ROLE_PERMISSION.md` — Matriks RBAC 4 Role (`MEMBER`, `CASHIER`, `ADMIN`, `SUPER_ADMIN`) & 4 Slot Kasir
- `DATABASE.md` — Struktur koleksi Firestore, onboarding status/verifications & composite indexes
- `AUTH.md` — Autentikasi, CAPTCHA, Kode 6-Digit Onboarding & setup Service Account
- `SECURITY.md` — Model ancaman, Firestore/Storage Rules & isolasi cabang Kasir
- `XP_SYSTEM.md` — Aturan perhitungan XP Progress, XP Reward, Bonus Idempoten, Level & Reset Cycle
- `XP_LEDGER.md` — Spesifikasi buku besar XP immutable, XP Hold & Auto-Refund
- `BENEFIT_REQUEST.md` — Alur Unified Benefit Request, Masa Berlaku 7 Hari & Mode Kasir
- `ADMIN_GUIDE.md` — Panduan operasional Admin & Super Admin
- `MEMBER_GUIDE.md` — Panduan penggunaan Member Dashboard (4-tab mobile-first)
- `BACKUP_RESTORE.md` — Panduan Full System Backup, Restore & 15-Point Integrity Audit
- `DEPLOYMENT.md` — Panduan build & deploy produksi
- `TESTING.md` — Skenario & hasil pengujian otomatis (80 tests termasuk TEST 1–20)
- `CHANGELOG.md` — Riwayat perubahan rilis
