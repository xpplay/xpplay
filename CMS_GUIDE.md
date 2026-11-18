# CMS Homepage Guide — XP PLAY Member System

## Ringkasan Fitur (Phase A)
Admin (`SUPER_ADMIN` dan `ADMIN`) dapat mengubah seluruh konten halaman depan website langsung melalui dashboard **Admin → CMS Homepage** tanpa menyentuh source code atau melakukan redeploy.

Role `STAFF` dan Member hanya memiliki akses baca terhadap konten `Published` (tidak dapat menyimpan draft, mengunggah aset CMS, mempublikasikan, maupun melakukan rollback).

---

## Konten yang Dapat Dikelola
1. **Identitas Brand & Header**: Nama XP PLAY, Nama Toko (`document.title`), Logo (upload JPG/PNG/WEBP atau URL HTTPS), Favicon, Header Tagline, Header CTA Button Text.
2. **Hero Section & CTA**: Hero Title, Hero Subtitle, Hero Description, Hero Image, Primary CTA (Text + URL), Secondary CTA (Text + URL).
3. **Banner & Announcement**: Announcement Bar toggle + teks, Highlight Banner (toggle, judul, deskripsi, gambar), Promo Banner (toggle, judul, teks, CTA text & URL).
4. **Section & Tentang XP PLAY**: Judul & deskripsi Tentang XP PLAY, Section Image, serta judul/subjudul untuk section Cara Kerja XP, Tingkatan Level, dan Cabang Resmi.
5. **FAQ Builder**: Toggle aktif/nonaktif, judul section FAQ, tambah/ubah/hapus hingga 15 item pertanyaan & jawaban.
6. **Kontak, Lokasi, Jam Operasional & Social Media**: Alamat lengkap, WhatsApp resmi, Google Maps URL, Jam operasional, tautan Instagram / TikTok / Facebook / YouTube, teks footer, dan copyright.

---

## Alur Kerja Aman (Draft → Preview → Publish)
1. **Admin Edit & Simpan Draft**: Perubahan disimpan ke koleksi `cmsDrafts/homepage` serta dicatat ke `auditLogs` (`CMS_DRAFT_SAVE`). Pengunjung publik **tidak** terdampak oleh perubahan draft.
2. **Preview**: Admin dapat memeriksa hasil perubahan melalui modal **Preview Draft** di dalam studio CMS maupun membuka URL penuh `/?cmsPreview=draft` (URL preview hanya aktif jika akun yang sedang login adalah `ADMIN` / `SUPER_ADMIN`).
3. **Publish**: Saat admin menekan **Publish Homepage** dan mengonfirmasi, transaksi atomik Firestore akan:
   - Membaca `versionNumber` terakhir dan membuat versi baru (`v1`, `v2`, `v3`, dst.).
   - Menyimpan snapshot lengkap yang bersifat immutable ke `cmsVersions/{versionId}`.
   - Memperbarui `cmsPublished/homepage` yang langsung disinkronkan secara real-time ke pengunjung.
   - Mencatat audit log `CMS_PUBLISH`.

---

## Version History & Rollback
- Setiap versi di `cmsVersions` tidak pernah dihapus maupun ditimpa (`allow update, delete: if false;` di `firestore.rules`).
- Admin dapat menekan **Lihat Versi** untuk meninjau snapshot versi lama, atau **Rollback** untuk memulihkan konten versi sebelumnya.
- Proses Rollback tetap membuat nomor versi baru (misalnya rollback dari `v4` ke `v2` akan membuat `v5` dengan `sourceAction: 'ROLLBACK'` dan `restoredFromVersionId: 'v2'`) serta mencatat `CMS_ROLLBACK` di `auditLogs`.

---

## Keamanan CMS (XSS & Asset Guard)
- Seluruh input teks CMS menolak tag HTML/JavaScript (`<script>`, `<iframe>`, `<svg>`, event handler `on*=`, URI `javascript:`, `vbscript:`, `data:text/html`, `data:image/svg+xml`).
- Render halaman depan hanya menggunakan React text nodes tanpa `dangerouslySetInnerHTML`.
- Upload gambar CMS (`POST /api/admin/cms/assets`) memverifikasi JWT Firebase Auth + role aktif `SUPER_ADMIN` / `ADMIN` dan memeriksa magic bytes biner untuk `JPG`, `PNG`, atau `WEBP` (maksimum `5 MB`; upload SVG dilarang).
