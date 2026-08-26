# Ringkasan Perubahan (v2)

## ⚠️ Sebelum deploy — WAJIB dibaca
`config.js` berisi token asli plaintext (`BOT_TOKEN`, `API_HASH`, `GITHUB_TOKEN`,
`VERCEL_TOKEN`). Karena file ini sudah pernah keluar dari server (diupload),
**rotate/ganti semua token itu** lalu isi lewat environment variable
(`process.env.BOT_TOKEN`, dst) — jangan hardcode lagi di file.

## 1. Fix bug di ENC Menu (`jsenc.js`)
- **Penyebab utama ditemukan:** mode `siu` pakai karakter Unicode
  "Mathematical Bold" (𝗡𝗲𝘅𝘂𝘀, 𝗠𝗼𝗱𝘇, dst) sebagai identifier/nama variabel.
  Karakter itu **tidak valid** sebagai identifier JavaScript (tidak masuk
  kategori `ID_Start`/`ID_Continue` di spesifikasi ECMAScript) — jadi setiap
  kali user pilih mode `SiuCalcrick`, hasil enkripsinya selalu syntax error /
  file rusak. Sudah diganti ke kombinasi Han + Latin + angka yang valid tapi
  tetap unik gayanya.
- **Validasi otomatis ditambahkan:** setiap hasil `obfuscateJS()` sekarang
  dicek dulu apakah bisa di-parse sebagai JS valid (`new Function(code)`).
  Kalau ternyata rusak (mode apapun, bukan cuma `siu`), bot otomatis retry
  sekali pakai mode `standard` (identifier default js-confuser, dijamin
  valid) sebelum mengirim ke user — jadi user gak akan lagi menerima file
  hasil enkripsi yang corrupt.

## 2. Mode Free / Credit
- Toggle baru di **Admin Panel** (tombol "🆓 Ganti ke Mode Free" /
  "💰 Ganti ke Mode Credit"), disimpan di `freemode.json` (auto-dibuat).
- Kalau **Free Mode aktif**: semua fitur (build, enkripsi, deploy, ganti
  domain/warna/icon/nama, dll) gratis untuk SEMUA user, credit tidak dipotong
  sama sekali.
- Kalau **Credit Mode** (default): balik ke perilaku lama — potong 1 credit
  per fitur, owner/admin tetap unlimited seperti biasa.
- Status mode ini ditampilkan di menu utama user (`💳 Saldo`) dan di admin
  panel.

## 3. Banner Welcome (canvas) untuk user baru
- File baru: `banner.js` — generator gambar PNG pakai `@napi-rs/canvas`
  (dipilih karena prebuilt binary, **tidak perlu compile native** seperti
  paket `canvas` biasa yang sering gagal install di panel/VPS kecil).
- Saat ada `/start` dari user baru: bot ambil **foto profil Telegram asli**
  user (kalau ada), nama, username, dan ID, lalu generate banner PNG custom
  → dikirim ke **channel notifikasi** DAN ke **chat user itu sendiri**
  sebagai sambutan.
- Kalau modul canvas belum terinstall di server / gagal generate, otomatis
  fallback ke foto statis lama (`PHOTO_NEW_USER`) — bot tidak akan crash.

## 4. Banner Build Sukses (canvas)
- Setiap build APK **sukses**, bot generate banner PNG (developer, project,
  mode, ukuran APK, durasi) → dikirim ke **user** (setelah file APK) dan ke
  **channel notifikasi**.
- Best-effort: kalau gagal generate, APK tetap terkirim normal seperti biasa
  (fitur banner tidak akan menggagalkan pengiriman APK).

## 5. Analisa Error Build (dev tools)
- File baru: `errorhelper.js` — baca log error dari GitHub Actions dan:
  - Cari baris yang nunjuk ke **file + nomor baris** spesifik (dart/kotlin/
    java/gradle/xml/yaml/json), ditampilkan sebagai "📍 Lokasi Terdeteksi".
  - Cocokkan ke daftar pola error umum Flutter/Gradle (dependency conflict,
    manifest merger, google-services.json hilang, out of memory, versi Java
    gak cocok, null check error, dll) → ditampilkan sebagai
    "💡 Kemungkinan Penyebab".
  - Ini heuristik best-effort (bukan AI analysis), tujuannya biar user gak
    cuma dikasih raw log tapi juga petunjuk awal mau mulai cek di mana. Raw
    log lengkap tetap dikirim seperti biasa.

## 6. Auto Payment — QRIS & DANA dari config
- Sekarang QRIS & nomor DANA cukup **diisi sekali** di `config.js` →
  `CONFIG.PAYMENT.QRIS_IMAGE` (taruh file gambar di `images/qris.jpg`) dan
  `CONFIG.PAYMENT.DANA_NUMBER` / `DANA_NAME`.
- Begitu user pilih metode pembayaran, bot **langsung kirim otomatis**
  QRIS/nomor DANA — admin gak perlu lagi kirim manual tiap ada order baru.
  Admin cuma dapat notifikasi info aja, lalu tinggal ACC setelah user kirim
  bukti transfer (approve manual tetap ada karena belum pakai payment
  gateway otomatis — sesuai yang kamu bilang susah nyari API-nya).
- Kalau `QRIS_IMAGE` belum ada filenya / `DANA_NUMBER` masih placeholder,
  bot otomatis fallback ke alur lama (admin kirim manual) — jadi aman,
  gak akan error walau belum sempat diisi.

## Yang perlu kamu lakukan sendiri
1. `npm install` ulang di server (nambah dependency `@napi-rs/canvas`).
2. Taruh gambar QRIS kamu di `images/qris.jpg`, isi `DANA_NUMBER` &
   `DANA_NAME` di `config.js` (atau env var) biar fitur auto-payment aktif.
3. Kalau server-nya minim RAM/CPU (VPS kecil / panel gratisan), tes dulu
   generate 1-2 banner manual buat mastiin `@napi-rs/canvas` jalan lancar di
   environment kamu — kalau modul gagal load, fitur banner otomatis nonaktif
   sendiri dan fallback ke foto statis, jadi bot tetap aman jalan.
4. Rotate token di `config.js` (lihat peringatan di atas).

## Belum dikerjakan (perlu arahan lebih spesifik)
- "Banyak fitur developer" masih general di luar 2 hal yang sudah dikerjakan
  di atas (analisa error + auto payment) — kasih tau kalau ada tools
  spesifik lain yang kamu mau ditambahkan.
- Perombakan UI "semua sekaligus" — sudah dirapikan bagian yang paling sering
  dilihat (menu utama, admin panel, alur beli credit). File `index.js`-nya
  ~4800 baris dengan puluhan pesan berbeda, jadi buat benar-benar "semua"
  konsisten butuh beberapa putaran lagi — kasih tau kalau mau saya lanjutkan
  bagian per bagian (misal: semua pesan enkripsi dulu, atau semua pesan mod
  APK dulu) biar hasilnya rapi dan gak asal ganti.
