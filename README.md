# XP PLAY Member System — Demang & Sekip

Sistem web membership resmi untuk **XP PLAY DEMANG (XP PLAY GAME CENTER)** dan **XP PLAY SEKIP (XP PLAY GAME PLATINUM)**.

## Fitur Utama
- **Pemisahan Saldo XP Progress & XP Reward**: `XP Progress` menentukan level & benefit tanpa pernah berkurang saat redeem; `XP Reward` adalah saldo yang dapat ditukarkan benefit.
- **Registrasi & Login Aman**: Login dengan Username atau Nomor WhatsApp + Password (atau Google Sign-In) dilengkapi CAPTCHA terverifikasi di server dan pencegahan *account enumeration*.
- **Referral Berbasis Username**: Bonus daftar `+10 XP` dan bonus referral valid `+5 XP` untuk member baru maupun referrer, dengan proteksi *self-referral* dan duplikasi.
- **Transaksi XP Kasir**: Nominal Rupiah bilangan bulat (`floor(nominal / rate)`, default `Rp2.000 = 1 XP`) per cabang (`DEMANG` / `SEKIP`), memperbarui *Last Play*, dual ledger, dan kenaikan level otomatis.
- **Challenge, Event, Promo & Claim XP**: Pengajuan bukti foto terproteksi (`ON_PROCESS` -> `APPROVED` / `DENIED`), auto-expiration server & client, dan anti-duplicate claim.
- **Redemption & Level Benefit**: Redeem XP Reward maupun Benefit Level (`BRONZE`, `SILVER`, `JURAGAN`, `SULTAN`) secara atomik tanpa mengurangi XP Progress.
- **Admin Console (19 Menu) & RBAC**: Role `SUPER_ADMIN`, `ADMIN`, `STAFF`, manajemen member (soft status), notifikasi target & member inaktif (`7/14/30/custom` hari), serta **Reset Membership Cycle** non-destruktif berbasis snapshot.

## Cabang Resmi
- **XP PLAY DEMANG** — XP PLAY GAME CENTER ([Maps](https://maps.app.goo.gl/JCAvqgP2X2M9morS7))
- **XP PLAY SEKIP** — XP PLAY GAME PLATINUM ([Maps](https://maps.app.goo.gl/KZGGXG7JYzJ3hQA39))
- **WhatsApp Resmi**: `08983761001`
- **Timezone**: `Asia/Jakarta`

## Menjalankan Secara Lokal
```bash
npm install
cp .env.example .env
npm run dev
```

## Dokumentasi Lengkap
- `ARCHITECTURE.md` — Arsitektur full-stack & alur data
- `DATABASE.md` — Struktur koleksi Firestore, ledger & composite indexes
- `AUTH.md` — Autentikasi, CAPTCHA, & setup Email/Password + Service Account
- `SECURITY.md` — Model ancaman, Firestore/Storage Rules & RBAC
- `XP_SYSTEM.md` — Aturan perhitungan XP Progress, XP Reward, Level & Reset Cycle
- `ADMIN_GUIDE.md` — Panduan operasional Admin, Kasir/Staff & Super Admin
- `MEMBER_GUIDE.md` — Panduan penggunaan Member Dashboard
- `DEPLOYMENT.md` — Panduan build & deploy produksi
- `TESTING.md` — Skenario & hasil pengujian
- `CHANGELOG.md` — Riwayat perubahan rilis
