# Panduan Operasional Kasir — XP PLAY (v3.1.0)

Kasir memiliki portal operasional tersendiri pada rute **`/cashier`** yang terisolasi ketat per cabang (**XP PLAY DEMANG** atau **XP PLAY SEKIP**). Kasir **tidak memiliki akses** ke panel `/admin` maupun `/superadmin`.

---

## Login & Isolasi Cabang Kasir

1. Masuk melalui **`/cashier/login`** (**Portal Login Kasir** tersendiri, terpisah dari `/admin/login`) menggunakan akun Email & Password yang diotorisasi oleh Super Admin (email wajib terverifikasi).
2. Setelah login berhasil dan cabang terverifikasi, role `CASHIER` otomatis diarahkan ke **`/cashier`**. Akun Kasir tidak diperbolehkan masuk melalui `/admin/login`.
3. Setiap akun Kasir dikunci permanen ke satu cabang:
   - **Kasir Demang** (`branchScope: 'DEMANG'`): Hanya dapat melihat dan memproses operasional cabang **DEMANG**.
   - **Kasir Sekip** (`branchScope: 'SEKIP'`): Hanya dapat melihat dan memproses operasional cabang **SEKIP**.
4. Percobaan mengakses data cabang lain atau membuka URL `/admin/*` / `/superadmin/*` akan langsung diblokir (**HTTP 403 Forbidden / Unauthorized**) dan dicatat otomatis ke `auditLogs` dengan aksi **`CASHIER_DENIED_ACTION`**.

### 4 Slot Operasional Kasir (Tanpa Kredensial Hardcoded)
Super Admin mengelola 4 slot akun kasir melalui menu **Admin & Cashier Management**:
- `CASHIER_DEMANG_01` — Shift 1 Cabang Demang (`DEMANG`)
- `CASHIER_DEMANG_02` — Shift 2 Cabang Demang (`DEMANG`)
- `CASHIER_SEKIP_01` — Shift 1 Cabang Sekip (`SEKIP`)
- `CASHIER_SEKIP_02` — Shift 2 Cabang Sekip (`SEKIP`)

---

## 9 Menu Resmi Dashboard Kasir (`/cashier`)

1. **Dashboard**: Ringkasan harian cabang (total transaksi hari ini, XP terbit hari ini, jumlah `PRE_REGISTERED` cabang, antrian Benefit Request cabang).
2. **Register Customer**: Pre-registrasi Tahap 1 cukup dengan nomor WhatsApp (+ catatan opsional). Menampilkan **Kode Verifikasi 6-Digit** dan tautan/QR `/register?wa=...&code=...` siap salin/kirim ke WhatsApp pelanggan.
3. **Members**: Daftar member cabang (termasuk filter `PRE_REGISTERED` vs `ACTIVE`), tombol terbitkan ulang kode 6-digit untuk `PRE_REGISTERED`, tanpa tombol edit XP/Level/Password.
4. **Transactions**: Input transaksi Rupiah cabang (`XP = floor(nominal / rate)`) yang langsung mengkreditkan `XP Progress` & `XP Reward` baik untuk member **`ACTIVE`** maupun **`PRE_REGISTERED`**, serta daftar riwayat transaksi cabang.
5. **Benefit Requests**:
   - **Ajukan Benefit (Bantuan Kasir)**: Membantu member `ACTIVE` maupun `PRE_REGISTERED` mengajukan benefit dengan atomic **XP Hold**.
   - **Antrian Cabang (`ON_PROCESS`)**: Melakukan `APPROVE` (aktifkan masa berlaku 7 hari) atau `DENY` (auto-refund XP Hold ke `xpReward`).
   - **Verifikasi Voucher (`APPROVED`)**: Cari kode `BRQ-...` / Username / WhatsApp -> klik **`MARK AS USED`** (terkunci ke cabang kasir).
6. **Member Lookup**: Pencarian cepat pelanggan berdasarkan Nomor WhatsApp, Username, atau Member ID untuk mengecek saldo `XP Progress`, `XP Reward`, `Reserved XP`, Level, dan status registrasi (`PRE_REGISTERED` / `ACTIVE`).
7. **Customer Activity**: Pemantauan aktivitas transaksi & benefit pelanggan di cabang terkait.
8. **Notifications**: Daftar notifikasi operasional cabang (termasuk pemberitahuan `NEW_PRE_REGISTERED` / `NEW_MEMBER_REGISTERED`).
9. **Profile / Logout**: Informasi profil kasir, kode slot, cabang aktif yang terkunci, dan tombol Logout.

---

## Tindakan yang DILARANG KERAS untuk Kasir

Sistem memblokir fitur berikut pada **4 lapis sekaligus** (UI, React Router 403, Express API 403, dan Firestore Security Rules):

- ❌ Pengaturan XP (`XP Settings`) & Penyesuaian XP Manual (`XP Progress / XP Reward Adjustment`)
- ❌ Pengaturan Level (`Level Settings`) & `Level Override / Recalculate`
- ❌ Reset Password Member (`Password Member`)
- ❌ Tambah / Ubah / Hapus Katalog Benefit, Challenge, Event, dan Promo (CRUD)
- ❌ CMS Homepage (Draft, Edit, Publish, Rollback)
- ❌ Manajemen Admin & Kasir (`Admin Management`), Manajemen Cabang (`Branches`), dan Role/Security Settings
- ❌ Backup, Restore, Reset Cycle, dan membaca `auditLogs` penuh
- ❌ Akses data operasional lintas cabang (`DEMANG <-> SEKIP`)
