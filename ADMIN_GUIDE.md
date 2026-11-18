# Panduan Admin & Operator — XP PLAY

## Login Admin
Akses `/admin/login` dan masuk dengan **Email & Password** yang terdaftar pada koleksi `admins` (Super Admin awal: `spv.xpplay@gmail.com`). Untuk aktivasi pertama kali, gunakan tab **Aktivasi Akun** dan verifikasi tautan yang dikirim ke email Anda.

## Role & Hak Akses
- **SUPER_ADMIN**: Semua menu termasuk *Admin Management*, *Levels*, *XP Settings*, *Reset / Membership Cycle*, *Branches*, dan *Backup & Restore / System Health*.
- **ADMIN**: Manajemen Member, Inactive Members, Password Member, XP Adjustment, Level Override, CMS Homepage, Transaksi XP, Approval Claims & Redemptions, Benefits, Challenges/Events/Promos, Notifikasi & Kampanye Inaktif.
- **STAFF**: Operasional kasir (*Transactions*), review *Claims* dan *Redemptions*, serta akses baca terbatas pada daftar member dan audit.

## Alur Operasional Utama
1. **Input Transaksi XP**: Buka menu `Transactions`, masukkan Username/WhatsApp member, nominal Rupiah (integer), cabang (`DEMANG` atau `SEKIP`), nomor struk, lalu simpan.
2. **Review Claim XP**: Buka `Claims` (filter `ON_PROCESS`), periksa bukti foto, lalu klik `APPROVE` (menambah XP Progress & XP Reward) atau `DENY` disertai alasan.
3. **Review Redemption**: Buka `Redemptions`, klik `APPROVE` (memotong XP Reward saja tanpa mengubah XP Progress/Level) atau `DENY`.
4. **Kampanye Member Inaktif**: Buka `Inactive Members` (atau `Notifications`), pilih periode `7 / 14 / 30 / 60 / 90 / 180 / 365 / Custom` hari, mode `Pernah Bermain` atau `Belum Pernah Bermain`, filter cabang/level, lalu kirim notifikasi massal terdeduplikasi atau pengingat individual. Lihat detail pada `INACTIVE_MEMBER.md`.
5. **Reset Cycle**: Buka `Reset / Membership Cycle`, tentukan ID Season baru (mis. `2026-S2`), lalu jalankan reset.
6. **XP Adjustment**: Buka `XP Adjustment` untuk menambah/mengurangi `XP Progress` atau `XP Reward` secara terpisah (khusus `ADMIN` & `SUPER_ADMIN`).
7. **Level Override & Recalculate**: Buka `Level Override` (atau tombol `Level` pada tabel `Members`) untuk melakukan *Force Level Override* (`MANUAL_OVERRIDE`) atau *Recalculate Level From XP* (`AUTOMATIC`) tanpa mengubah saldo XP (khusus `ADMIN` & `SUPER_ADMIN`).
8. **Manajemen Password Member**: Buka `Password Member` (atau tombol `Password` pada tabel `Members`), cari member, masukkan password baru yang kuat + alasan, lalu konfirmasi. Memerlukan Firebase Admin SDK aktif di server; lihat `MEMBER_PASSWORD_ADMIN.md`.
9. **Backup, Verifikasi & Retensi (`SUPER_ADMIN`)**: Buka `Backup & Restore` -> pantau **9-Component System Health**, buat backup baru, verifikasi integritas 9-cek, inspeksi `manifest.json`, dan atur kebijakan retensi.
10. **Full System Restore & 12-Point Integrity Audit (`SUPER_ADMIN`)**: Pada `Backup & Restore`, jalankan **Preview Restore**, ketik konfirmasi persis `RESTORE XP PLAY` + alasan. Sistem otomatis mengaktifkan Restore Lock (Maintenance Mode), membuat **Pre-Restore Backup**, memulihkan data, lalu menjalankan verifikasi & 12-Point Data Integrity Audit. Lihat panduan lengkap di `BACKUP_RESTORE.md`.


