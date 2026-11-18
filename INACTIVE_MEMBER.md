# Inactive Member Management — XP PLAY

Dokumen ini menjelaskan sistem pelacakan, penyaringan, pagination terindeks, dan integrasi notifikasi untuk **Member Tidak Aktif (Inactive Members)** pada cabang Demang & Sekip (Phase E / MODULE 6).

## 1. Definisi & Perhitungan Ketidakaktifan
Sumber data utama: koleksi `members` dengan status `ACTIVE` (member `SUSPENDED`, `INACTIVE`, dan `DELETED` otomatis dikecualikan agar tidak mengganggu daftar re-engagement).

- **Mode Pernah Bermain (`PLAYED`)**:
  - Baseline: `member.lastPlayAt` (diperbarui setiap kali member mencatat transaksi XP di cabang `DEMANG` atau `SEKIP`).
  - Member dianggap tidak aktif jika `lastPlayAt <= now - (thresholdDays * 86_400_000)`.
- **Mode Belum Pernah Bermain (`NEVER_PLAYED`)**:
  - Baseline: `member.createdAt` dengan syarat `member.lastPlayAt == null`.
  - Member dianggap tidak aktif jika `createdAt <= now - (thresholdDays * 86_400_000)`.
- **Urutan Default**:
  - Selalu diurutkan dari **paling lama tidak bermain** (`daysInactive` terbesar / `baselineTimestamp` paling lama terlebih dahulu).

## 2. Preset Periode & Filter Tersedia
Menu **Inactive Members** di Admin Console menyediakan:
- **Preset Periode**: `7 Hari`, `14 Hari`, `30 Hari`, `60 Hari`, `90 Hari`, `180 Hari`, `1 Tahun (365 Hari)`, serta **Custom** (`1–3650` hari).
- **Filter Tambahan**: Mode (`Pernah Bermain` / `Belum Pernah Bermain`), Cabang (`ALL`, `DEMANG`, `SEKIP`), Level (`ALL`, `BRONZE`, `SILVER`, `JURAGAN`, `SULTAN`), dan pencarian real-time (Nama, Username, WhatsApp, Member ID).
- **11 Kolom Wajib Tabel**:
  1. Member ID
  2. Nama Lengkap
  3. Username
  4. WhatsApp
  5. Level & Mode Level
  6. XP Progress
  7. XP Reward
  8. Cabang Terakhir (atau Cabang Preferensi)
  9. Last Play (WIB) / Belum Pernah Main
  10. Durasi Tidak Aktif (hari)
  11. Status Akun & Aksi Cepat (Kirim Notifikasi, Ubah Password, XP Adjustment)

## 3. Skalabilitas & Composite Index Firestore
Query menggunakan cursor pagination (`startAfter`, ukuran halaman 25 baris) tanpa pernah memuat seluruh koleksi `members` ke memori browser. Index komposit yang didefinisikan pada `firestore.indexes.json`:
- `members`: `(status ASC, lastPlayAt ASC)`
- `members`: `(status ASC, lastPlayAt ASC, createdAt ASC)`
- `members`: `(status ASC, lastPlayBranch ASC, lastPlayAt ASC)`
- `members`: `(status ASC, currentLevel ASC, lastPlayAt ASC)`

## 4. Integrasi Notifikasi & Deduplikasi Harian
Admin (`SUPER_ADMIN`, `ADMIN`, atau operator dengan izin `manageNotifications`) dapat mengirim:
1. **Notifikasi Massal Kohort Inaktif**: Menarget seluruh member aktif yang memenuhi ambang hari, cabang, dan level yang dipilih.
2. **Notifikasi Individual Cepat**: Mengirim pengingat langsung ke satu member dari baris tabel.

**Pencegahan Spam / Duplikasi**:
- Fungsi `buildInactiveNotificationDedupeKey` (`src/shared/inactiveLogic.ts`) menghasilkan kunci deterministik berdasarkan tanggal Jakarta (`UTC+7`), ambang hari, cabang, dan level (contoh: `inact_2026-11-18_d30_DEMANG_ALL`).
- Bila opsi **Deduplikasi Harian** aktif, member yang sudah menerima notifikasi kohort pada hari Jakarta yang sama otomatis dilewati (`skippedDuplicateCount`) sehingga tidak menerima pesan ganda jika tombol ditekan berulang kali.
- Setiap kampanye dicatat di koleksi `notifications`, distribusi per member di `memberNotifications`, dan jejak audit di `auditLogs`.
