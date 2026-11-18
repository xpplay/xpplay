# Panduan Admin XP Adjustment — XP PLAY Member System

## Ringkasan
Fitur **XP Adjustment** memungkinkan operator berwenang (`ADMIN` dan `SUPER_ADMIN`) untuk menambah atau mengurangi saldo **XP Progress** maupun **XP Reward** member secara terpisah, terverifikasi, idempoten, dan tercatat penuh di ledger serta audit log tanpa menghapus riwayat XP sebelumnya.

## Pemisahan Saldo (Strict Balance Isolation)

### 1. XP Progress Adjustment (`ADMIN_ADJUSTMENT`)
- Mengubah `members/{uid}.xpProgress` sebesar nilai `adjustment` (`+/-` bilangan bulat, saldo akhir wajib `>= 0`).
- **Level dihitung ulang otomatis** berdasarkan konfigurasi level aktif di Firestore (`Bronze < Silver < Juragan < Sultan`). Penyesuaian negatif dapat menurunkan level member (contoh: `650 XP Sultan` dikurangi `100 XP` menjadi `550 XP Juragan`).
- **Tidak pernah mengubah `xpReward`.**
- Mencatat entri ledger baru yang immutable pada `xpProgressLedger` dengan `source = 'ADMIN_ADJUSTMENT'`, `referenceId = adj_<operationId>`, `direction = 'CREDIT' | 'DEBIT'`, dan `amount = +/-N`.
- Jika level berubah, mencatat entri baru di `levelHistory` (`source = 'ADMIN_ADJUSTMENT'`).

### 2. XP Reward Adjustment (`XP_REWARD_ADMIN_ADJUSTMENT`)
- Mengubah `members/{uid}.xpReward` sebesar nilai `adjustment` (`+/-` bilangan bulat, saldo akhir wajib `>= 0`).
- **Tidak pernah mengubah `xpProgress` maupun `currentLevel`.**
- Mencatat entri ledger baru yang immutable pada `xpRewardLedger` dengan `source = 'XP_REWARD_ADMIN_ADJUSTMENT'`, `referenceId = adj_<operationId>`, beserta metadata lengkap.

## Alur Penggunaan di Admin Console
1. Buka menu **XP Adjustment** pada sidebar Admin Console (atau klik tombol **Adjust XP** pada baris member di menu **Members**).
2. Pilih mode **XP Progress** atau **XP Reward**.
3. Cari member berdasarkan `username` atau nomor `WhatsApp`.
4. Masukkan nilai adjustment (`+` untuk menambah, `-` untuk mengurangi) serta alasan wajib (`Reason`) dan referensi opsional.
5. Periksa panel **Preview Perubahan** (`Before -> After`, `Level Before -> Level After`).
6. Klik **Lanjut ke Konfirmasi** dan verifikasi ringkasan di modal konfirmasi.
7. Klik **Konfirmasi & Simpan**. Transaksi atomik mengeksekusi penyesuaian sekaligus menulis ledger, `xpAdjustments`, `memberNotifications`, dan `auditLogs`.

## Guardrail Keamanan & Idempotensi
- **RBAC**: Hanya `SUPER_ADMIN` dan `ADMIN` dengan email terverifikasi yang dapat mengeksekusi penyesuaian. Role `STAFF` melihat tampilan Read-Only dan diblokir baik di UI, endpoint API (`/api/admin/xp-adjustments`), maupun `firestore.rules`.
- **Idempotency**: Setiap modal konfirmasi menghasilkan `operationId` unik (`adj_<operationId>`). Klik ganda atau retry tidak akan menggandakan pengurangan/penambahan XP.
- **No Data Loss**: Riwayat ledger lama tidak pernah diubah atau dihapus (`allow update, delete: if false`).
- **No Silent Failure**: Kegagalan validasi, izin, atau jaringan selalu ditampilkan eksplisit ke admin.
