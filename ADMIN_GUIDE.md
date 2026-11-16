# Panduan Admin & Operator — XP PLAY

## Login Admin
Akses `/admin/login` dan masuk dengan **Email & Password** yang terdaftar pada koleksi `admins` (Super Admin awal: `spv.xpplay@gmail.com`). Untuk aktivasi pertama kali, gunakan tab **Aktivasi Akun** dan verifikasi tautan yang dikirim ke email Anda.

## Role & Hak Akses
- **SUPER_ADMIN**: Semua menu termasuk *Admin Management*, *Levels*, *XP Settings*, *Reset / Membership Cycle*, dan *Branches*.
- **ADMIN**: Manajemen Member, Transaksi XP, Approval Claims & Redemptions, Benefits, Challenges/Events/Promos, Notifikasi & Kampanye Inaktif.
- **STAFF**: Operasional kasir (*Transactions*), serta review *Claims* dan *Redemptions*.

## Alur Operasional Utama
1. **Input Transaksi XP**: Buka menu `Transactions`, masukkan Username/WhatsApp member, nominal Rupiah (integer), cabang (`DEMANG` atau `SEKIP`), nomor struk, lalu simpan.
2. **Review Claim XP**: Buka `Claims` (filter `ON_PROCESS`), periksa bukti foto, lalu klik `APPROVE` (menambah XP Progress & XP Reward) atau `DENY` disertai alasan.
3. **Review Redemption**: Buka `Redemptions`, klik `APPROVE` (memotong XP Reward saja tanpa mengubah XP Progress/Level) atau `DENY`.
4. **Kampanye Member Inaktif**: Buka `Notifications`, pilih `Member Tidak Aktif (Last Play)`, pilih `7`, `14`, `30`, atau custom hari, lalu kirim. Sistem mencegah duplikasi per kampanye.
5. **Reset Cycle**: Buka `Reset / Membership Cycle`, tentukan ID Season baru (mis. `2026-S2`), lalu jalankan reset.
