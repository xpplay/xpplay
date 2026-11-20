# Role & Permission Matrix — XP PLAY (v3.1.0)

XP PLAY menerapkan **4-Role RBAC** (`MEMBER`, `CASHIER`, `ADMIN`, `SUPER_ADMIN`) yang ditegakkan secara konsisten di **4 lapisan keamanan**:
1. **UI Layer** (`src/shared/rbac.ts`, dashboard terpisah per role)
2. **Route Guard Layer** (`src/App.tsx`, halaman `403 UnauthorizedPage` + logging `CASHIER_DENIED_ACTION`)
3. **Express API Layer** (`requireAdminRole`, `requirePermission`, `enforceBranchScopeInRequest`)
4. **Firestore Security Rules** (`firestore.rules`: `isSuperAdmin()`, `isAdmin()`, `isFullAdminOrSuper()`, `isCashier()`, `cashierBranch()`)

> **Kompatibilitas Legacy:** Akun lama dengan role `STAFF` diperlakukan identik dengan `CASHIER` dan wajib memiliki `branchScope` tetap (`DEMANG` atau `SEKIP`).

---

## Rute Dashboard Per Role

| Role | Rute Utama | Branch Scope |
| :--- | :--- | :--- |
| `MEMBER` (`ACTIVE`) | `/member` | Preferensi cabang pribadi |
| `MEMBER` (`PRE_REGISTERED`) | **Diblokir dari `/member`** -> `/register` | Cabang saat pre-registrasi |
| `CASHIER` (dan legacy `STAFF`) | `/cashier` | **Terkunci ketat** (`DEMANG` ATAU `SEKIP` saja) |
| `ADMIN` | `/admin` | `ALL` (Demang & Sekip) |
| `SUPER_ADMIN` | `/superadmin` (dan `/admin`) | `ALL` (Demang & Sekip) |

---

## Matriks Hak Akses Lengkap

| Fitur / Kapabilitas | `MEMBER` (`ACTIVE`) | `CASHIER` (Branch-Locked) | `ADMIN` | `SUPER_ADMIN` |
| :--- | :---: | :---: | :---: | :---: |
| Akses Portal Member (`/member`) | ✅ | ❌ | ❌ | ❌ |
| Akses Portal Kasir (`/cashier`) | ❌ | ✅ (Cabang sendiri) | ❌ | ✅ (Supervisi) |
| Akses Admin Console (`/admin`) | ❌ | ❌ (`403`) | ✅ | ✅ |
| Akses Super Admin Console (`/superadmin`) | ❌ | ❌ (`403`) | ❌ (`403`) | ✅ |
| Pre-Register Member (Tahap 1 WhatsApp) | ❌ | ✅ (Cabang sendiri) | ✅ | ✅ |
| Re-Issue Kode 6-Digit Onboarding | ❌ | ✅ (Cabang sendiri) | ✅ | ✅ |
| Member Lookup & Daftar Member | ❌ (Profil sendiri) | ✅ (Cabang sendiri) | ✅ (Semua) | ✅ (Semua) |
| Input Transaksi XP Kasir | ❌ | ✅ (Cabang sendiri) | ✅ (Semua) | ✅ (Semua) |
| Ajukan Benefit Request (Sendiri / Via Kasir) | ✅ (Sendiri) | ✅ (Assisted cabang) | ✅ | ✅ |
| Approve / Deny / Mark As Used Benefit | ❌ | ✅ (Cabang sendiri) | ✅ (Semua) | ✅ (Semua) |
| Laporan Incomplete Registration (7/14/30d) | ❌ | ❌ | ✅ | ✅ |
| Inactive Member Campaign & Broadcast | ❌ | ❌ | ✅ | ✅ |
| **XP Progress / XP Reward Adjustment** | ❌ | ❌ (`403`) | ✅ | ✅ |
| **Level Override / Recalculate** | ❌ | ❌ (`403`) | ✅ | ✅ |
| **Reset Password Member (Admin SDK)** | ❌ | ❌ (`403`) | ✅ | ✅ |
| **Benefit / Challenge / Event / Promo CRUD** | ❌ | ❌ (`403`) | ✅ | ✅ |
| **CMS Homepage Draft / Publish / Rollback** | ❌ | ❌ (`403`) | ✅ | ✅ |
| **XP Settings & Level Threshold Settings** | ❌ | ❌ (`403`) | ❌ | ✅ |
| **Membership Cycle Reset** | ❌ | ❌ (`403`) | ❌ | ✅ |
| **Admin & Cashier Slot Management** | ❌ | ❌ (`403`) | ❌ | ✅ |
| **Full System Backup & Restore** | ❌ | ❌ (`403`) | ❌ | ✅ |
| **Audit Logs (Read All)** | ❌ | ❌ (`403`) | ✅ | ✅ |
| **Tulis Audit Log `CASHIER_DENIED_ACTION`** | ❌ | ✅ (Otomatis saat ditolak) | ✅ | ✅ |

---

## Slot Operasional Kasir (`CASHIER_SLOT_TEMPLATES`)

Tidak ada email atau password kasir yang di-hardcode di dalam source code. Super Admin menugaskan UID/Email akun Firebase Auth nyata ke 4 slot berikut melalui tab **Admin Management**:

| Kode Slot | Cabang Terkunci | Role | Keterangan |
| :--- | :---: | :---: | :--- |
| `CASHIER_DEMANG_01` | `DEMANG` | `CASHIER` | Kasir Demang Shift 1 |
| `CASHIER_DEMANG_02` | `DEMANG` | `CASHIER` | Kasir Demang Shift 2 |
| `CASHIER_SEKIP_01` | `SEKIP` | `CASHIER` | Kasir Sekip Shift 1 |
| `CASHIER_SEKIP_02` | `SEKIP` | `CASHIER` | Kasir Sekip Shift 2 |

> **Validasi Firestore Rules:** Dokumen `admins/{uid}` dengan `role in ['CASHIER', 'STAFF']` **wajib** memiliki `branchScope in ['DEMANG', 'SEKIP']`. Menyimpan Kasir dengan `branchScope: 'ALL'` ditolak otomatis oleh aturan database dan API.
