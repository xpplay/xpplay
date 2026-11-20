# Unified Benefit Request, XP Hold & Cashier Verification — XP PLAY (v3.0.0)

Dokumen ini menjelaskan sistem terpadu **Benefit Request** (`benefitRequests` collection) yang menyatukan pengajuan **Benefit Umum (XP Reward)**, **Benefit Level**, serta klaim **Challenge, Event, dan Promo** ke dalam satu alur yang aman, konsisten, dan dapat diverifikasi oleh kasir cabang Demang & Sekip.

> **Kompatibilitas Legacy:** Koleksi `claims` dan `redemptions` lama **tetap dipertahankan dan tetap terbaca** pada panel Admin (`Antrian Legacy Claims & Redemptions`), Member Detail Drawer, maupun riwayat legacy Member Dashboard.

## 1. Sumber Benefit Terpadu (`sourceType`)

| `sourceType` | Sumber Katalog | `xpCost` (Hold) | `xpRewardGrant` (saat Approve) |
| :--- | :--- | :---: | :---: |
| `GENERAL_BENEFIT` | `benefits/{id}` | `benefit.xpCost` | `0` |
| `LEVEL_BENEFIT` | `benefits/{id}` | `benefit.xpCost` (umumnya `0`) | `0` |
| `CHALLENGE` | `campaigns/{id}` | `0` | `campaign.xpReward` |
| `EVENT` | `campaigns/{id}` | `0` | `campaign.xpReward` |
| `PROMO` | `campaigns/{id}` | `0` | `campaign.xpReward` |

## 2. State Machine Lifecycle

```text
Member Submit (XP Hold jika xpCost > 0)
        │
        ▼
   [ ON_PROCESS ] ───────► Admin Deny (xpCost = 0) ──────► [ DENIED ] (Terminal)
        │
        ├────────────────► Admin Deny (xpCost > 0) ──────► [ REFUNDED ] (resolution: DENIED, Terminal)
        │                   (+DENIED_REFUND ledger)
        │
        ▼ Admin Approve (expiresAt = approvedAt + 7 hari, reservedXp dilepas)
   [ APPROVED ] ─────────► Kasir MARK AS USED (<= 7 hari) ► [ USED ] (Terminal)
        │
        ├────────────────► Lewat 7 hari (refundOnExpiry=false) ► [ EXPIRED ] (Terminal)
        │
        └────────────────► Lewat 7 hari (refundOnExpiry=true)  ► [ REFUNDED ] (resolution: EXPIRED, Terminal)
                            (+EXPIRY_REFUND ledger)
```

### Aturan Transisi Wajib (Ditegakkan di Server + Firestore Rules)
- `ON_PROCESS` hanya boleh berpindah ke `APPROVED`, `DENIED`, atau `REFUNDED`.
- `APPROVED` hanya boleh berpindah ke `USED`, `EXPIRED`, atau `REFUNDED`.
- Status terminal (`USED`, `DENIED`, `EXPIRED`, `REFUNDED`) **tidak dapat diubah lagi** sehingga mustahil terjadi double approve, double deny, double refund, maupun pemakaian voucher dua kali.

## 3. Masa Berlaku 7 Hari (`BENEFIT_VALIDITY_DAYS = 7`)

- Saat Admin menyetujui pengajuan (`APPROVED`), sistem menetapkan:
  - `approvedAt = now`
  - `expiresAt = approvedAt + 7 * 24 * 60 * 60 * 1000` (7 hari kalender penuh)
- Member melihat kode voucher unik (`BRQ-YYYYMMDD-XXXX`), tombol **Salin Kode**, status, serta countdown sisa hari (`X hari lagi` / `X jam lagi` / `Kadaluarsa`).
- Jika waktu sekarang melewati `expiresAt`:
  - Kasir **otomatis diblokir** dari menandai `MARK AS USED` meskipun batch proses expiry belum dijalankan.
  - Admin dapat menjalankan tombol **Proses Benefit Expired (>7 Hari)** (`POST /api/admin/benefit-requests/process-expired`) untuk memfinalisasi seluruh dokumen `APPROVED` kadaluarsa secara transaksional.

## 4. Kebijakan `refundOnExpiry`

Dikonfigurasi oleh `SUPER_ADMIN` pada **Pengaturan XP -> Kebijakan Benefit Expired**:
- **`false` (Default):** Benefit yang sudah di-approve lalu tidak digunakan melewati 7 hari akan menjadi `EXPIRED` dan XP tidak dikembalikan.
- **`true`:** Benefit kadaluarsa yang memiliki `xpCost > 0` akan otomatis menjadi `REFUNDED` (`resolution: 'EXPIRED'`), mengembalikan `xpCost` ke `member.xpReward`, serta mencatat ledger `EXPIRY_REFUND`.

## 5. Mode Kasir / Verifikasi Benefit

Pada tab **Admin -> Benefit Requests & Kasir -> Kasir / Verifikasi Benefit**:
1. Kasir/Staff memasukkan **Request ID (`BRQ-...`)**, **Username**, **Nama Member**, atau **Nomor WhatsApp**.
2. Sistem menampilkan daftar benefit aktif milik member tersebut beserta validitas 7 hari.
3. Kasir memilih cabang pemakaian (**Demang** / **Sekip**), mengisi nomor struk/referensi opsional, dan menekan **MARK AS USED**.
4. Dokumen diperbarui atomik menjadi `USED` dengan `usedAt`, `usedBy`, `usedBranch`, `receiptReference`, mengirim notifikasi ke inbox member, dan mencatat entri immutable di `auditLogs`.

## 6. Endpoint REST API (Server-Authoritative Mode)

| Method | Path | Role | Deskripsi |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/benefit-requests` | Active Member | Pengajuan benefit + immediate atomic XP Hold |
| `POST` | `/api/admin/benefit-requests/:requestId/review` | Staff / Admin / Super Admin | Approve (set 7 hari) atau Deny + Auto-Refund |
| `POST` | `/api/admin/benefit-requests/:requestId/use` | Staff / Admin / Super Admin | Verifikasi Kasir `MARK AS USED` |
| `POST` | `/api/admin/benefit-requests/process-expired` | Admin / Super Admin | Batch finalisasi benefit melewati 7 hari |
