# Authentication & CAPTCHA Guide

## Mekanisme Autentikasi
1. **Password Security**: Tidak ada password plaintext maupun custom password hash yang disimpan di Firestore. Seluruh kredensial dikelola oleh **Firebase Authentication (Email/Password)**.
2. **Member Register & Login (Username / Nomor WhatsApp + Password)**:
   - Pendaftaran dan login Member menggunakan Username atau Nomor WhatsApp + Password + CAPTCHA.
   - Ketika server Admin SDK belum dikonfigurasi (`FIREBASE_SERVICE_ACCOUNT_JSON` kosong), aplikasi berjalan penuh secara native melalui **Firebase Client SDK (Email/Password)** menggunakan indeks SHA-256 tanpa PII (`authIndex`) yang memetakan hash identifier ke akun opaque internal `@member.xpplay.app`.
   - Pesan error login selalu generik untuk mencegah *account enumeration*.
3. **Admin & Operator Login (Email + Password + Email Verification)**:
   - Admin masuk melalui `/admin/login` menggunakan Email & Password.
   - Untuk aktivasi pertama kali (termasuk Super Admin awal `spv.xpplay@gmail.com`), gunakan tab **Aktivasi Akun**, buat password, lalu klik link verifikasi email yang dikirim oleh Firebase Authentication (`email_verified == true` diwajibkan oleh Firestore Security Rules).

## Konfigurasi Wajib di Firebase Console
1. Buka **Firebase Console** untuk project `adept-extension-t40px`.
2. Masuk ke **Authentication → Sign-in method** lalu aktifkan provider **Email/Password** → **Save**.

## Konfigurasi CAPTCHA Production (Google reCAPTCHA)
1. Daftar di Google reCAPTCHA Admin Console dan pilih tipe v2 Checkbox atau v3.
2. Masukkan domain deployment Anda (`APP_URL` dan `localhost` untuk dev).
3. Isi environment variable:
   - `VITE_RECAPTCHA_SITE_KEY` (frontend)
   - `RECAPTCHA_SECRET_KEY` (server-only)
4. Jika `RECAPTCHA_SECRET_KEY` belum diisi, server otomatis menggunakan tantangan gambar SVG bertanda tangan HMAC (`CAPTCHA_HMAC_SECRET`) dengan masa berlaku 5 menit dan konsumsi nonce satu kali.
