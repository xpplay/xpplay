# Panduan Admin & Super Admin — XP PLAY (v3.1.0)

> Untuk panduan operasional khusus **Kasir (`/cashier`)**, lihat `CASHIER_GUIDE.md`. Untuk matriks izin lengkap 4 role, lihat `ROLE_PERMISSION.md`.

## Login & Routing Otomatis
Akses **`/admin/login`** dan masuk dengan **Email & Password** yang terdaftar pada koleksi `admins` (Super Admin bootstrap: `spv.xpplay@gmail.com`). Untuk aktivasi pertama kali, gunakan tab **Aktivasi Akun** dan verifikasi tautan yang dikirim ke email Anda.
- **`SUPER_ADMIN`** diarahkan ke **`/superadmin`** (juga dapat mengakses `/admin` & `/cashier` untuk supervisi).
- **`ADMIN`** diarahkan ke **`/admin`** (akses penuh operasional Demang & Sekip; diblokir dari `/superadmin`).
- **`CASHIER` / `STAFF`** diarahkan ke **`/cashier`** dan diblokir (`403 Unauthorized`) dari `/admin/*` serta `/superadmin/*`.

## Ringkasan Role & Hak Akses
- **SUPER_ADMIN**: Semua menu termasuk *Admin & Cashier Management* (dengan 4 slot kasir cabang Demang/Sekip + matriks RBAC), *Levels*, *XP Settings* (`refundOnExpiry`), *Reset / Membership Cycle*, *Branches*, dan *Backup & Restore / System Health*.
- **ADMIN**: Dashboard Overview (dengan metrik terpisah **`NEW PRE-REGISTERED`** vs **`NEW ACTIVE MEMBERS`**), Manajemen Member + Panel Quick Pre-Register + **8-Tab Member Detail Drawer** (termasuk kartu Two-Step & re-issue kode 6-digit), *Inactive Members* + tab **Pendaftaran Belum Selesai (7 / 14 / 30 hari)**, Password Member, XP Adjustment, Level Override, CMS Homepage, Transaksi XP, Riwayat XP Ledger 12 kolom, Benefit Requests & Kasir, Benefits, Challenges/Events/Promos, Notifikasi & Audit Logs.
- **CASHIER**: Portal terpisah `/cashier` (9 menu saja, terkunci ketat per cabang `DEMANG` atau `SEKIP`).

## Alur Operasional Utama Admin
1. **Monitoring Split Metrik Member Baru (Overview)**:
   - Pantau secara terpisah **New Pre-Registered (`Hari Ini / 7 Hari / 30 Hari`)** dan **New Active Members (`Hari Ini / 7 Hari / 30 Hari`)** beserta daftar terbaru masing-masing dan panel **Notifikasi Member Baru (`NEW_PRE_REGISTERED` & `NEW_MEMBER_REGISTERED`)** lengkap dengan tombol `View Member`.
2. **Pre-Register & Manajemen Member (8-Tab Drawer)**:
   - Gunakan panel **Pre-Register Member (Tahap 1)** di halaman `Members` untuk mendaftarkan nomor WhatsApp pelanggan pada cabang `DEMANG` atau `SEKIP` dan langsung mendapatkan **Kode Verifikasi 6-Digit** + tautan QR onboarding.
   - Filter status **`PRE_REGISTERED`** maupun `ACTIVE`, lalu klik **Detail** untuk membuka Drawer 8 tab (`Profil`, `Transaksi`, `Riwayat XP`, `Benefit Request`, `Referral`, `Level`, `Notifikasi`, `Aktivitas`). Kartu **Status Two-Step Registration** di tab `Profil` menampilkan cabang pre-register, kasir pembuat, waktu selesai, status bonus `+10 XP`, dan tombol **Terbitkan Ulang Kode 6-Digit**.
3. **Laporan Pendaftaran Belum Selesai (Read-Only)**:
   - Buka `Inactive Members` -> tab **`Pendaftaran Belum Selesai`** untuk melihat daftar pelanggan `PRE_REGISTERED` yang melewati **7 / 14 / 30 hari** (filter per cabang tersedia). Laporan ini bersifat **read-only** dan sistem tidak pernah menghapus akun `PRE_REGISTERED` secara otomatis.
4. **Manajemen Admin & 4 Slot Kasir (`SUPER_ADMIN`)**:
   - Buka `Admin Management` untuk menugaskan akun Email Firebase Auth ke 4 slot kasir (`CASHIER_DEMANG_01`, `CASHIER_DEMANG_02`, `CASHIER_SEKIP_01`, `CASHIER_SEKIP_02`) — cabang kasir wajib terkunci ke `DEMANG` atau `SEKIP` (menolak `ALL`) — serta memantau tabel matriks RBAC 4 role secara langsung.
5. **Input Transaksi XP, Benefit Requests & Riwayat XP Ledger**:
   - Transaksi XP cabang (`DEMANG` / `SEKIP`) dan Benefit Requests mendukung member **`ACTIVE`** maupun **`PRE_REGISTERED`**; seluruh saldo dan transaksi Tahap 1 otomatis terbawa saat pelanggan menyelesaikan Tahap 2.
   - Audit riwayat mutasi di `Riwayat XP Ledger` (12 kolom) termasuk sumber `REGISTRATION_BONUS`, `BENEFIT_REQUEST_HOLD`, `DENIED_REFUND`, `EXPIRY_REFUND`, `ADMIN_ADJUSTMENT`.
6. **Reset Cycle, XP Adjustment, Level Override, Password Member & Backup/Restore**:
   - Seluruh aksi sensitif tercatat immutable di `auditLogs` dan diproteksi oleh `SUPER_ADMIN`/`ADMIN` RBAC. Lihat `BACKUP_RESTORE.md` untuk panduan backup 26 koleksi, restore lock, dan 15-Point Integrity Audit.
