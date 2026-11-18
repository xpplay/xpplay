# Admin Member Password Management — XP PLAY

Dokumen ini menjelaskan arsitektur, alur kerja, kontrol keamanan, dan batasan operasional untuk fitur **Manajemen Password Member oleh Admin** (Phase D / MODULE 5).

## 1. Tujuan & Hak Akses (RBAC)
Member yang lupa password atau memerlukan bantuan pemulihan akun di kasir cabang Demang maupun Sekip dapat dibantu oleh operator berwenang melalui menu **Password Member** (atau tombol shortcut `Password` pada tabel `Members`).

| Role | Melihat Riwayat Audit | Mengubah Password Member |
| --- | :---: | :---: |
| `SUPER_ADMIN` | Ya | Ya |
| `ADMIN` | Ya | Ya |
| `STAFF` | Baca saja | Ditolak (`403 Forbidden`) |
| `MEMBER` | Ditolak | Ditolak (`403 Forbidden`) |

## 2. Arsitektur Keamanan (Zero-Credential-Leak)
1. **Server-Side Only (`Firebase Admin SDK`)**:
   - Perubahan password **dilarang keras** dilakukan dari browser / client SDK.
   - Permintaan dikirim melalui `POST /api/admin/members/:memberUid/password` yang memverifikasi Firebase ID Token (`requireAuth`), peran operator (`requireAdminRole(['SUPER_ADMIN', 'ADMIN'])`), serta status Restore Lock (`requireSystemNotLocked()`).
   - Server memanggil `adminAuth.updateUser(uid, { password: newPassword })` melalui **Firebase Admin SDK**.
2. **Pencabutan Sesi Aktif (`revokeRefreshTokens`)**:
   - Secara default aktif (`revokeSessions: true`), server memanggil `adminAuth.revokeRefreshTokens(uid)` agar seluruh token sesi lama di perangkat sebelumnya segera dicabut.
3. **Nol Penyimpanan Password Mentah / Hash di Database & Audit Log**:
   - Password baru, password lama, maupun hash password **tidak pernah** disimpan di Firestore, `auditLogs`, `memberNotifications`, maupun file backup.
   - Input password pada UI Admin langsung dihapus dari state memori segera setelah permintaan berhasil diproses.
   - Validasi kekuatan password ditegakkan pada client dan server (`src/shared/inactiveLogic.ts`): minimal 8 karakter, maksimal 128 karakter, kombinasi huruf dan angka, tanpa spasi di awal/akhir, dan cocok dengan field konfirmasi.

## 3. Audit Trail & Notifikasi Member
Setiap penggantian password yang berhasil secara atomik menulis:
1. **`auditLogs/{auditId}`** dengan `action: 'PASSWORD_CHANGED_BY_ADMIN'` yang hanya memuat metadata non-rahasia (`operationId`, `adminId`, `adminEmail`, `adminRole`, `memberId`, `memberUid`, `memberUsername`, `reason`, `reference`, `sessionsRevoked`, `timestamp`).
2. **`memberNotifications/{notifId}`** berjenis `SYSTEM` yang menginformasikan member bahwa password telah diperbarui oleh Admin (dan apakah sesi lama dicabut).

## 4. Batasan Environment & Cara Mengaktifkan di Production
- Fitur ini **wajib** memiliki kredensial server **`FIREBASE_SERVICE_ACCOUNT_JSON`** (lihat `.env.example`).
- Apabila `FIREBASE_SERVICE_ACCOUNT_JSON` belum dikonfigurasi (misalnya pada sandbox preview tanpa service account), server akan menolak secara jujur dengan **HTTP `503`** (`code: 'ADMIN_SDK_UNAVAILABLE'`) dan UI menampilkan peringatan status — sistem tidak pernah memalsukan keberhasilan perubahan password.
- Saat **Restore Lock** sedang aktif (`RESTORE_IN_PROGRESS`), endpoint ini juga otomatis diblokir dengan **HTTP `503`** (`code: 'RESTORE_IN_PROGRESS'`).
