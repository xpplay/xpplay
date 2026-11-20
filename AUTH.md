# Authentication, Onboarding Verification & CAPTCHA Guide (v3.1.0)

## Mekanisme Autentikasi
1. **Password Security**: Tidak ada password plaintext maupun custom password hash yang disimpan di Firestore. Seluruh kredensial dikelola oleh **Firebase Authentication (Email/Password)**.
2. **Two-Step Member Registration & Login (`/register`, `/complete-membership`, `/login`)**:
   - **Pendaftaran publik bebas DIBLOKIR**: Pelanggan wajib didaftarkan terlebih dahulu oleh Kasir/Admin (`PRE_REGISTERED` / `PHONE_ONLY`, **tanpa** akun Firebase Auth).
   - **Verifikasi Status Nomor WhatsApp Zero-PII**: Endpoint `POST /api/onboarding/check` + dokumen publik tanpa PII `onboardingPublicStatus/{wHash}` hanya mengembalikan status registrasi (`NOT_FOUND | PRE_REGISTERED | ACTIVE | SUSPENDED`), status kode aktif, dan cabang — tanpa pernah membocorkan nama, saldo XP, atau data pribadi lain.
   - **Kode Verifikasi 6-Digit Sekali Pakai**:
     - Diterbitkan server (`POST /api/onboarding/pre-register` & `POST /api/onboarding/regenerate-code`) menggunakan `crypto.randomInt(0, 1_000_000)` dan disimpan dalam bentuk **HMAC-SHA256** (`ONBOARDING_HMAC_SECRET`) pada `onboardingVerifications/{wHash}`.
     - Masa berlaku **7 hari**, maksimal **5 percobaan salah**, dan verifikasi sukses (`POST /api/onboarding/verify-code`) menghasilkan `onboardingSessionToken` bertanda tangan HMAC **sekali pakai** (*single-use replay-protected*).
   - **Aktivasi Akun Firebase Auth**: Akun Firebase Auth (`@member.xpplay.app` melalui `authIndex` berbasis hash SHA-256 tanpa PII) **hanya dibuat** saat pelanggan menyelesaikan Tahap 2 secara penuh (`PRE_REGISTERED -> ACTIVE`).
   - **Pemblokiran Login `PRE_REGISTERED`**: Pelanggan yang belum menyelesaikan Tahap 2 dilarang masuk ke `/member`. Halaman `/login` mendeteksi status `PRE_REGISTERED` dan mengarahkan ke `/register?wa=<nomor>`.
   - **Anti-Account-Enumeration**: Pesan kesalahan login untuk kredensial salah tetap generik.
3. **Pemisahan Portal Login Kasir vs Portal Login Admin (Email + Password + Email Verification)**:
   - **Portal Login Kasir (`/cashier/login`)**: Khusus akun `CASHIER` (dan legacy `STAFF`) cabang `DEMANG`/`SEKIP` dengan identitas operasional tersendiri (aksen Emerald/Teal). Memverifikasi cabang tetap sebelum masuk ke `/cashier` dan menolak akun `ADMIN`/`SUPER_ADMIN`/`MEMBER`.
   - **Portal Login Admin (`/admin/login`)**: Khusus akun `ADMIN` (`-> /admin`) dan `SUPER_ADMIN` (`-> /superadmin`) dengan identitas manajemen tersendiri (aksen Indigo/Purple). Akun Kasir yang mencoba masuk lewat `/admin/login` ditolak dan dicatat otomatis sebagai `CASHIER_DENIED_ACTION`.
   - **Aktivasi Pertama Kali**: Masing-masing portal memiliki tab aktivasi akun (buat password + kirim verifikasi email wajib `email_verified == true`).

## Konfigurasi Wajib di Firebase Console
1. Buka **Firebase Console** untuk project aktif aplikasi (`firebase-applet-config.json`).
2. Masuk ke **Authentication → Sign-in method** lalu aktifkan provider **Email/Password** → **Save**.

## Environment Variables Keamanan Produksi
- `FIREBASE_SERVICE_ACCOUNT_JSON` (server-only): Wajib untuk aktivasi penuh Firebase Admin SDK (penulisan otoritatif server-side, reset password member, full Auth/Firestore backup).
- `ONBOARDING_HMAC_SECRET` (server-only): Secret kriptografis 32+ byte untuk menandatangani hash kode 6-digit dan `onboardingSessionToken`.
- `CAPTCHA_HMAC_SECRET` (server-only): Secret fallback CAPTCHA SVG bertanda tangan HMAC (5 menit, nonce satu kali).
- `VITE_RECAPTCHA_SITE_KEY` & `RECAPTCHA_SECRET_KEY`: Konfigurasi Google reCAPTCHA v2/v3 produksi.
