# Panduan Admin Level Override — XP PLAY Member System

## Ringkasan
Fitur **Level Override** memungkinkan operator berwenang (`ADMIN` dan `SUPER_ADMIN`) mengubah level keanggotaan member secara manual (**Force Level Override**) atau menghitung ulang level berdasarkan saldo `XP Progress` (**Recalculate Level From XP**) tanpa memodifikasi saldo `XP Progress` maupun `XP Reward`.

## Mode Level (`levelMode`)
Setiap profil member menyimpan field `levelMode` untuk menentukan bagaimana level dievaluasi:
- **`AUTOMATIC`**: Default member baru; level mengikuti threshold `XP Progress` (`Bronze < Silver < Juragan < Sultan`). Transaksi XP dan penyesuaian `XP Progress` memperbarui level secara otomatis.
- **`MANUAL_OVERRIDE`**: Ditetapkan melalui aksi Admin **Force Level Override**. Dashboard member, benefit eligibility, transaksi XP baru, dan klaim XP **tidak akan menimpa** level hasil override selama status masih `MANUAL_OVERRIDE`.
- **`RESET`**: Ditetapkan saat penutupan *Membership Cycle* ketika kebijakan reset level aktif.

## Dua Aksi Utama
1. **Force Level Override (`MANUAL_OVERRIDE`)**
   - Mengubah `members/{uid}.currentLevel` langsung ke `BRONZE`, `SILVER`, `JURAGAN`, atau `SULTAN`.
   - Mengubah `members/{uid}.levelMode` menjadi `'MANUAL_OVERRIDE'`.
   - **XP Progress dan XP Reward tidak berubah.**
2. **Recalculate Level From XP (`RECALCULATE`)**
   - Menghitung ulang level berdasarkan `xpProgress` member dan konfigurasi threshold di Firestore (`levels`).
   - Mengembalikan `members/{uid}.levelMode` menjadi `'AUTOMATIC'`.
   - **XP Progress dan XP Reward tidak berubah.**

## Alur Penggunaan di Admin Console
1. Buka menu **Level Override** di sidebar Admin Console (atau klik tombol **Level** pada baris member di menu **Members**).
2. Pilih mode **Force Level Override** atau **Recalculate From XP**.
3. Cari member berdasarkan `username` atau nomor `WhatsApp`.
4. Untuk Force Override, pilih target level baru. Isi **Reason** (wajib minimal 3 karakter) dan **Reference** (opsional).
5. Periksa panel **Preview Perubahan Level** (`Level Before -> After`, `Mode Before -> After`, serta konfirmasi bahwa saldo XP tetap utuh).
6. Klik **Lanjut ke Konfirmasi**, periksa modal konfirmasi, lalu klik **Konfirmasi & Simpan**.

## Guardrail Keamanan, Audit & Idempotensi
- **RBAC**: Hanya `ADMIN` dan `SUPER_ADMIN` dengan email terverifikasi yang diizinkan (`requireAdminRole(['SUPER_ADMIN', 'ADMIN'])` di `/api/admin/level-overrides` dan `isFullAdminOrSuper()` di `firestore.rules`). Role `STAFF` diblokir (tampilan Read-Only).
- **Idempotency**: Setiap konfirmasi menggunakan `operationId` unik (`levelOverrides/ovr_<operationId>`), mencegah eksekusi ganda pada klik berulang atau retry jaringan.
- **Audit Trail & Ledger**: Setiap eksekusi mencatat dokumen immutable di `levelOverrides`, entri di `levelHistory` (`ADMIN_MANUAL_OVERRIDE` atau `ADMIN_RECALCULATE`), notifikasi member (`memberNotifications`), dan log `auditLogs` (`LEVEL_MANUAL_OVERRIDE` / `LEVEL_RECALCULATE_FROM_XP`).
