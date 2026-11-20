# XP Ledger Architecture — XP PLAY Member System (v3.0.0)

Dokumen ini menjelaskan desain buku besar (**immutable XP Ledger**) pada **XP PLAY Member System — Demang & Sekip** termasuk pemisahan **XP Progress**, **XP Reward Tersedia**, dan **XP Ditahan (Reserved XP Hold)** serta mekanisme refund otomatis.

## 1. Tiga Saldo XP Member

Setiap dokumen `members/{uid}` menyimpan tiga nilai integer non-negatif:

| Field | Fungsi | Pengaruh terhadap Level | Bisa Ditukar Benefit? |
| :--- | :--- | :--- | :--- |
| `xpProgress` | Akumulasi XP progresi untuk menentukan level (`BRONZE`, `SILVER`, `JURAGAN`, `SULTAN`) | **Ya** (mode `AUTOMATIC`) | **Tidak** (tidak pernah berkurang saat redeem/hold) |
| `xpReward` | Saldo **XP Reward Tersedia** yang dapat digunakan untuk mengajukan benefit | **Tidak** | **Ya** |
| `reservedXp` | Saldo **XP Reward Ditahan (Hold)** dari pengajuan `benefitRequests` berstatus `ON_PROCESS` | **Tidak** | Terkunci sampai diputuskan Admin (`APPROVED` / `DENIED`) |

## 2. Dua Koleksi Buku Besar Immutable

Seluruh mutasi XP tercatat secara **append-only** (tidak dapat diubah atau dihapus, kecuali saat `SUPER_ADMIN` melakukan Full System Restore):

- **`xpProgressLedger/{entryId}`** — mencatat setiap penambahan/pengurangan/reset `xpProgress`.
- **`xpRewardLedger/{entryId}`** — mencatat setiap penambahan, hold (`BENEFIT_REQUEST_HOLD`), pengurangan, pengembalian (`DENIED_REFUND`, `EXPIRY_REFUND`, `ADMIN_REFUND`, `REVERSAL_REFUND`), dan reset `xpReward`.

### Struktur Field `XpLedgerEntry`

```ts
{
  id: string;
  memberId: string;
  memberUid: string;
  memberUsername?: string;
  amount: number;              // Positif untuk CREDIT/refund, negatif untuk DEBIT/hold
  beforeBalance?: number;      // Snapshot saldo sebelum mutasi
  afterBalance?: number;       // Snapshot saldo sesudah mutasi
  type: 'PROGRESS' | 'REWARD';
  direction: 'CREDIT' | 'DEBIT';
  source: XpLedgerSource;
  referenceId: string;         // ID transaksi / BRQ-... / adjustmentId / cycleId
  branch: 'DEMANG' | 'SEKIP' | null;
  cycleId: string;
  createdAt: number;
  createdBy: string;
  note: string;
}
```

## 3. Klasifikasi Pergerakan & Label UI

Semua tampilan Member (`Riwayat`) maupun Admin (`Riwayat XP Ledger`) mengelompokkan pergerakan XP secara eksplisit melalui `classifyXpLedgerMovement` & `getXpLedgerMovementLabel`:

| `source` | `direction` | Kategori | Label Bahasa Indonesia |
| :--- | :--- | :--- | :--- |
| `REGISTRATION`, `REFERRAL`, `TRANSACTION`, `CHALLENGE`, `EVENT`, `PROMO`, `LEVEL_BONUS`, `ADMIN_ADD`, `ADMIN_ADJUSTMENT` (`+`), `XP_REWARD_ADMIN_ADJUSTMENT` (`+`) | `CREDIT` | `POSITIVE` | **XP Bertambah (+)** |
| `BENEFIT_REQUEST_HOLD` | `DEBIT` | `NEGATIVE` | **XP Ditahan (Hold)** |
| `REDEMPTION`, `ADMIN_DEDUCT`, `TRANSACTION_REVERSAL`, `ADMIN_ADJUSTMENT` (`-`), `XP_REWARD_ADMIN_ADJUSTMENT` (`-`), `RESET` | `DEBIT` | `NEGATIVE` | **XP Berkurang (-)** |
| `DENIED_REFUND` | `CREDIT` | `REFUND` | **XP Dikembalikan (Refund Ditolak)** |
| `EXPIRY_REFUND` | `CREDIT` | `REFUND` | **XP Dikembalikan (Refund Expired)** |
| `ADMIN_REFUND`, `REVERSAL_REFUND` | `CREDIT` | `REFUND` | **XP Dikembalikan (Refund)** |

## 4. Alur Akuntansi XP Hold & Refund (Contoh Nyata)

Misalkan member memiliki `xpProgress = 180 (SILVER)`, `xpReward = 300`, `reservedXp = 0`:

1. **Member mengajukan benefit seharga `100 XP`** (`BRQ-20260610-XXXX`):
   - `xpReward`: `300 -> 200` (langsung terpotong di dalam Firestore Transaction).
   - `reservedXp`: `0 -> 100`.
   - `xpProgress`: tetap `180`, `currentLevel`: tetap `SILVER`.
   - Ledger ditulis: `xpRewardLedger` (`amount: -100`, `source: 'BENEFIT_REQUEST_HOLD'`, `referenceId: 'BRQ-...'`, `beforeBalance: 300`, `afterBalance: 200`).
2. **Kasus A — Admin Approve**:
   - `reservedXp`: `100 -> 0` (XP dianggap terpakai permanen; `xpReward` tetap `200`).
   - `expiresAt = approvedAt + 7 hari`.
   - Tidak ada ledger refund; tidak ada potongan ganda.
3. **Kasus B — Admin Deny**:
   - `xpReward`: `200 -> 300`, `reservedXp`: `100 -> 0`.
   - Status dokumen menjadi `REFUNDED` (`resolution: 'DENIED'`).
   - Ledger ditulis: `xpRewardLedger` (`amount: +100`, `source: 'DENIED_REFUND'`, `referenceId: 'BRQ-...'`, `beforeBalance: 200`, `afterBalance: 300`).
4. **Kasus C — Approved Melewati 7 Hari (Expired)**:
   - Jika `systemSettings.refundOnExpiry === false` (default): status menjadi `EXPIRED`, `xpReward` tetap `200` (tanpa refund).
   - Jika `systemSettings.refundOnExpiry === true`: status menjadi `REFUNDED` (`resolution: 'EXPIRED'`), `xpReward`: `200 -> 300`, ledger ditulis dengan `source: 'EXPIRY_REFUND'`.

## 5. Proteksi Anti Double Deduction & Anti Double Refund

- Setiap operasi submit, approve, deny, mark-used, dan process-expired dijalankan dalam **atomic Firestore Transaction**.
- Transisi status dikunci oleh state machine baik di server (`xpEngineServer.ts`), client fallback (`xpService.ts`), maupun **`firestore.rules`**.
- **15-Point Data Integrity Audit** (`NO_ORPHAN_BENEFIT_REQUESTS` & `NO_DUPLICATE_DEDUCTION_OR_REFUND`) secara aktif memeriksa bahwa:
  - `member.reservedXp` sama persis dengan jumlah `xpCost` dari seluruh `benefitRequests` berstatus `ON_PROCESS`.
  - Tidak pernah ada lebih dari 1 entri `BENEFIT_REQUEST_HOLD` atau lebih dari 1 entri `DENIED_REFUND` / `EXPIRY_REFUND` untuk satu `referenceId`.
