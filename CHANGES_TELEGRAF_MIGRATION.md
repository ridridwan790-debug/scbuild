# Migrasi ke Telegraf + Hybrid File Transport (GramJS)

## Ringkasan
Bot sekarang jalan di atas **Telegraf** (Bot API) untuk semua interaksi normal
(menu, tombol, teks). **GramJS/MTProto** dipertahankan HANYA sebagai jalur
khusus file besar, lewat 2 file baru:

- `mtproto.js` — client GramJS, login sebagai bot yang sama (pakai
  `session.txt` yang sudah ada), konek lazy (baru nyala pas dibutuhkan).
- `hybridFile.js` — logic auto-switch:
  - **Kirim file** ≤ 45MB → Telegraf (Bot API). > 45MB → GramJS (sampai 2GB).
  - **Terima file** ≤ 18MB → Telegraf. > 18MB → GramJS.
  (Bot API resmi: limit kirim ~50MB, limit download 20MB — makanya dikasih
  buffer aman di 45MB / 18MB.)
- `telegramAdapter.js` — adapter yang bikin Telegraf "menyamar" jadi API lama
  gaya GramJS (`client.sendMessage`, `client.sendFile`, dst), supaya
  `index.js` (hampir 5000 baris) TIDAK perlu dibongkar total. Semua logic
  bisnis (build APK, deploy web, credit system, dst) tetap sama persis.

## Cara pakai
```bash
npm install
node index.js
```
`session.txt` yang lama tetap dipakai (dipakai ulang oleh `mtproto.js` untuk
login MTProto). Kalau file itu hilang/invalid, GramJS akan otomatis re-login
pakai `BOT_TOKEN` dari `config.js` dan bikin `session.txt` baru — gak perlu
input kode OTP karena ini login sebagai BOT, bukan akun pribadi.

## Update: File 100% GramJS (gak ada lagi threshold ukuran)
Awalnya ada logic "kecil lewat Telegraf, besar lewat GramJS" — tapi ini bikin
2 jalur kode berbeda buat hal yang sama, jadi rawan bug & bikin pusing. Atas
permintaan langsung, sekarang disederhanakan:

- **Teks, menu, tombol, callback** → tetap Telegraf (Bot API), gak berubah.
- **Semua file (kirim & terima), APAPUN UKURANNYA** → selalu GramJS/MTProto,
  gak ada percabangan berdasarkan ukuran lagi.
- **Forward media** (mis. broadcast reply yang ada attachment) → sekarang
  native forward via MTProto (`client.forwardMessages`), bukan lagi
  "download dulu terus upload ulang" — lebih cepat & hemat bandwidth,
  jalan berapapun ukuran filenya.
- `getUserProfilePhotoBuffer` (foto profil buat notif admin) ikut dipindah
  ke GramJS juga (`client.downloadProfilePhoto`), biar konsisten satu jalur.
- `UPLOAD_THRESHOLD_MB` / `DOWNLOAD_THRESHOLD_MB` di `hybridFile.js` sudah
  dihapus (gak relevan lagi).

Konsekuensinya: GramJS/`mtproto.js` sekarang WAJIB nyala & konek dengan
benar dari awal (bukan lagi lazy-connect cuma pas ada file gede) — kalau
`session.txt` bermasalah, fitur kirim/terima file APAPUN (kecil sekalipun)
bakal kena imbas, bukan cuma yang gede. Auto-recovery `AUTH_KEY_DUPLICATED`
dan retry timeout yang udah dibahas di atas tetap berlaku sama persis.

## Bug Fixes (dari testing & laporan real usage)
1. **`bot.launch()` blocking (bot connect tapi gak pernah nyaut apa-apa)** —
   Telegraf punya sifat `bot.launch()`-nya gak resolve sampe bot di-`stop()`.
   Kode awal migrasi nulis `await bot.launch()`, jadi baris
   `client.addEventHandler(...)` di `index.js` (yang daftarin handler pesan
   & callback) gak pernah kejalan. Sekarang `bot.launch()` gak di-`await`,
   plus ditambah log diagnostik (`📨 Update pesan masuk...`) biar ketauan
   kalau ada masalah serupa ke depannya.
2. **`406: AUTH_KEY_DUPLICATED` pas kirim file besar** — kejadian kalau
   `session.txt` yang sama dipakai konek MTProto dari 2 proses berbeda dalam
   waktu tumpang tindih (biasanya gara-gara restart di panel yang gak nutup
   proses lama dengan bersih). `mtproto.js` sekarang **auto-recovery**: kalau
   ketemu error ini, otomatis hapus `session.txt` & login ulang dengan
   session baru (aman, karena login sebagai BOT lewat `botAuthToken`, gak
   butuh OTP). Juga ditambah graceful-shutdown (`SIGINT`/`SIGTERM`) supaya
   koneksi ditutup bersih pas proses berhenti, biar gak nyisain session
   "nyangkut" yang bikin proses berikutnya konflik lagi.
3. **Antrean numpuk pas banyak user `/start` bareng ("keliatan stuck")** —
   Telegraf secara default proses update satu-satu berurutan (nunggu handler
   user A selesai total baru mulai proses user B). Kalau lagi rame, ini bikin
   user belakangan nunggu lama & keliatan kayak bot ngehang. Sekarang tiap
   update diproses **paralel** (fire-and-forget per update, gak saling
   nunggu) — user A dan B diproses bersamaan, bukan antre.
   - **Catatan:** kalau SATU user yang sama ngirim banyak pesan cepet-cepet
     berturut-turut, urutan proses pesannya sekarang gak 100% dijamin
     berurutan lagi (beda pesan bisa selesai duluan atau belakangan
     tergantung mana yang lebih cepat). Biasanya gak masalah, tapi kalau
     kamu nemuin state kacau (misal pesan kedua ke-proses padahal pesan
     pertama belum), bilang aja — bisa ditambah antrean per-user (queue)
     biar tiap user tetap urut tapi antar-user tetap paralel.
- Import GramJS (`telegram`, `telegram/sessions`, dst) diganti jadi 1 baris:
  `require("./telegramAdapter")` — expose `client`, `bot`, `NewMessage`,
  `CallbackQuery` dengan API yang sama seperti sebelumnya.
- `buildButtons()` sekarang menghasilkan format inline_keyboard Telegraf,
  bukan objek `Button` GramJS.
- `isJoinedChannel()` ditulis ulang pakai `bot.telegram.getChatMember()`
  (lebih simpel & resmi dibanding `Api.channels.GetParticipant` GramJS).
- `setBotCommands()` disederhanakan pakai `bot.telegram.setMyCommands()`.
- 3 titik `instanceof Api.MessageMediaPhoto` diganti flag `.isPhoto` yang
  dinormalisasi oleh adapter.
- **Bug yang ikut kebenerin sambil migrasi:**
  - Cek "bot cuma bisa dipakai di private chat" tadinya baca properti GramJS
    (`peerId.className`) yang gak akan pernah match lewat Telegraf — sekarang
    pakai flag `isPrivate` yang benar.
  - Variabel `roleLine` (badge OWNER/RESELLER/ADMIN) dihitung tapi gak pernah
    dipasang di pesan welcome — sekarang beneran ditampilkan.
  - Typo tombol "𝗦𝗧𝗔𝗧𝗨𝗔" → "Status Bot".

4. **`-503: Timeout (caused by upload.GetFile)` pas kirim/terima file besar** —
   ini RPC internal MTProto buat download chunk file, timeout-nya biasanya
   transient (network kepending sesaat), makin gede filenya makin banyak
   chunk request jadi makin rawan. Dua lapis fix:
   - `mtproto.js`: naikin `connectionRetries` (5→10), tambah `downloadRetries: 5`,
     `requestRetries: 5`, `retryDelay: 2000` di GramJS client.
   - `hybridFile.js`: upload & download file besar sekarang **retry manual**
     sampai 4x dengan jeda 3s/6s/9s kalau tetep gagal, sebelum beneran nyerah.
- Layar "harus join channel dulu" dirapikan (dinamis sesuai jumlah channel
  yang di-set, bukan hardcode 3 baris).
- Pesan welcome dirapikan strukturnya, role badge sekarang muncul.
- **Tombol berwarna aktif** — Telegram Bot API 9.4 (rilis Feb 2026) nambahin
  field resmi `style` ("primary"=biru, "success"=hijau, "danger"=merah) buat
  inline keyboard button. Kode lama sebenernya udah nulis `style: "Success"`
  dsb di ~86 tombol di seluruh file, tapi `buildButtons()` gak pernah baca
  properti itu (dari versi GramJS lama juga, bukan gara-gara migrasi) — jadi
  kebuang percuma. Sekarang `buildButtons()` udah baca & pasang field itu,
  semua 86 tombol otomatis kepakai warnanya tanpa perlu diedit satu-satu.
  Kalau HP/client Telegram user versinya lama, field ini otomatis diabaikan
  (fallback ke warna default), jadi aman.
- (Menu lain kalau mau ikut dipercantik style-nya sama, tinggal bilang bagian
  mana.)

5. **Notif ke channel gak pernah kekirim** — `CONFIG.CHANNEL_USERNAME` di
   `config.js` disimpen TANPA tanda `@` (mis. `"INFOZIPER"`). Telegraf/Bot
   API WAJIB format `@INFOZIPER` buat ngirim ke channel by username, jadi
   semua notif ke channel gagal diem-diem selama ini. Sekarang ada
   `normalizeChatId()` di adapter yang otomatis nambahin `@` kalau belum
   ada — berlaku buat semua fungsi kirim/edit/hapus pesan, jadi gak perlu
   ubah satu-satu ke-12 titik yang manggil `CONFIG.CHANNEL_USERNAME`.
6. **Tombol cuma berwarna di menu awal, menu lain polos** — dari 184 tombol
   di seluruh bot, cuma 86 yang dari awal punya `style` di-set manual
   (kebanyakan panel admin). Sekarang `buildButtons()` auto-nebak warna dari
   teks tombolnya kalau `style` gak di-set manual: kata/emoji kayak
   "Hapus"/"Batal"/❌/🚫 → merah, "Verifikasi"/"Setuju"/✅ → hijau, selain itu
   → biru. Jadi SEMUA tombol di semua menu sekarang berwarna konsisten,
   bukan cuma yang di-set manual doang.
7. **Folder `tmp/` numpuk terus, gak pernah dibersihin** — ditambah cleanup
   otomatis: sekali pas bot baru nyala (bersihin sisa sesi sebelumnya), lalu
   tiap 15 menit ngecek & hapus file/folder di `CONFIG.TMP_DIR` yang lebih
   tua dari 30 menit. Gak perlu ngandelin tiap alur (build/deploy/enc-dec)
   buat rapi-rapi sendiri — satu jaring pengaman buat semuanya.


8. **Download/upload lambat** — GramJS bisa transfer file PARALEL pake
   beberapa koneksi sekaligus (opsi `workers`), bukan cuma 1 koneksi narik
   semua data berurutan. Sekarang jumlah worker nyesuain ukuran file:
   < 5MB → 1 (gak perlu, overhead-nya malah nambah lambat), 5–50MB → 4,
   50–200MB → 8, > 200MB → 16 (dibatasi 16 biar gak gampang kena
   flood-limit dari Telegram). Berlaku buat kirim maupun terima.
9. **Foto welcome/notif jadi bikin tombol abu-abu polos** — `sendPhotoSafe`
   (dipakai buat foto welcome, notif user baru ke channel, dll dari folder
   `images/`) manggil `client.sendFile`, yang sejak "full GramJS" di atas
   SELALU lewat GramJS. Masalahnya GramJS gak support field `style` (warna
   tombol), jadi tombol yang nempel di pesan berfoto kehilangan warnanya.
   Sekarang ditambah jalur baru: foto LOKAL dari `images/` (dicek lewat
   `fs.existsSync`) dikirim langsung lewat Telegraf (`sendPhotoTelegraf` —
   fungsi baru di adapter), bukan GramJS — warna tombol tetap kepake. Foto
   dari URL remote (jarang dipakai) tetap lewat jalur lama (GramJS) karena
   ukurannya gak selalu bisa dipastikan kecil.

10. **"Bad Request: there is no text in the message to edit" — banyak
    tombol error** — kejadian kalau bot coba "edit" pesan yang ASLINYA
    dikirim sebagai FOTO (ada caption, bukan teks polos) — misal welcome
    photo, terus user pencet tombol buka menu lain (admin panel dst), bot
    coba `editMessageText` padahal pesannya foto. Telegram butuh method
    beda buat itu: `editMessageCaption`. Sekarang `editMessage()` di adapter
    otomatis fallback ke `editMessageCaption` kalau ketemu error ini — gak
    perlu ubah apapun di `index.js`, semua menu yang kena masalah ini
    kebenerin otomatis.
11. **"Koneksi Terputus!" pas kirim APK hasil build (padahal build sukses)**
    — efek samping dari fix "percepat transfer" (poin 8): banyak worker
    paralel emang lebih cepet KALAU koneksi VPS-nya kuat, tapi kalau
    koneksinya pas-pasan/gak stabil, banyak koneksi sekaligus malah lebih
    gampang gagal (bukannya lebih ngebut). Sekarang dibikin **adaptif**:
    percobaan pertama tetep full-speed (banyak worker sesuai ukuran file),
    tapi kalau gagal, percobaan berikutnya otomatis TURUN jumlah worker-nya
    (dibagi 2 tiap gagal) sampai akhirnya di percobaan terakhir cuma 1
    koneksi — paling lambat tapi paling gak gampang gagal. Jadi tetep dapet
    kecepatan pas koneksi lagi bagus, tapi otomatis "mundur" ke mode aman
    kalau koneksinya lagi jelek.

## Update: Fitur "percepat transfer" (workers) DICABUT
Fitur `workers` paralel di poin 8/11 di atas balik dicabut atas permintaan
langsung — kesimpulannya lebih banyak masalah (gagal kirim) daripada manfaat
di VPS yang koneksinya gak konsisten. Sekarang `hybridFile.js` balik simpel:
1 koneksi, retry biasa (gak ada percobaan adaptif turun-naik worker lagi).
Yang tetap dipertahankan (dan dikonfirmasi sesuai keinginan): **semua file,
kecil atau besar, SELALU lewat GramJS** — bot cuma butuh tau "ini file" untuk
otomatis rute ke GramJS, gak ada pengecualian ukuran. **Gambar/foto UI**
(welcome, notif, dll dari folder `images/`) **TETAP lewat Telegraf**, bukan
GramJS, biar warna tombol tetap kepake.

## Fitur Baru: 2 Tools Tambahan
Diintegrasikan dari script `Tools_Get_Html_By_Angkasa.js` dan
`Tools_Cekemoji__MULTI__By_Angkasa.js` (aslinya ditulis buat library
`node-telegram-bot-api`, di sini di-port ke gaya Telegraf/adapter yang
dipakai bot ini):

- **`/get <url>`** — download source lengkap sebuah website (HTML hasil
  render JS kalau ada Puppeteer + Chrome di server, CSS, JS, gambar, font)
  jadi 1 file ZIP. Kalau Puppeteer/Chrome gak ke-install di server, otomatis
  fallback ke mode tanpa render JS (masih bisa ambil HTML+asset dasar, cuma
  gak jalanin React/Next.js). Hasil ZIP dikirim lewat GramJS (jadi gak ada
  lagi limit 50MB kayak versi asli — ukuran berapapun tetep bisa).
  **Perlu `npm install puppeteer`** (sudah ditambah ke `package.json`) DAN
  Chrome/Chromium ter-install di server (`apt install chromium` atau set
  `CHROME_BIN`/`PUPPETEER_EXECUTABLE_PATH`) kalau mau mode full-render.
  Tanpa itu, tool tetap jalan (mode fallback), cuma kurang lengkap.
- **`/cekemoji`** — deteksi emoji premium/custom di pesan (langsung kirim,
  reply, atau ketik `/cekemoji` doang lalu reply pesan yang diminta bot).
  Nampilin ID emoji + cara pakainya di HTML (`<tg-emoji emoji-id="...">`),
  dengan pagination kalau emoji-nya banyak.
- Ditambah 2 tombol baru di **Tools Menu**: "🌐 GET WEBSITE" & "😀 CEK EMOJI"
  (nampilin cara pakai; command-nya sendiri langsung diketik user).
- Tombol pagination `/cekemoji` sekarang juga pake `icon_custom_emoji_id`
  (ikon emoji kecil di depan teks tombol) — didukung penuh, `buildButtons()`
  udah diupdate buat nerusin field ini.
- Adapter (`telegramAdapter.js`) sekarang juga nerusin `msg.entities` /
  `msg.caption_entities` mentah dari Telegram (dibutuhin buat deteksi emoji
  premium) — sebelumnya field ini gak ke-expose sama sekali di pesan sintetis.


- Boot penuh (`main()`) via mock Telegraf + GramJS — jalan tanpa error.
- Simulasi `/start` end-to-end: user baru → cek join channel → kirim menu
  utama dengan tombol.
- Simulasi callback query (`credit_me`) → edit/hapus pesan → balas.
- `hybridFile.sendFileSmart` & `downloadFileSmart` — dikonfirmasi SEMUA
  file (kecil maupun besar) lewat GramJS, teks tetap lewat Telegraf.
- Forward media (skenario broadcast) → native forward via MTProto, gak
  download-upload ulang.
- Auto-recovery `AUTH_KEY_DUPLICATED` & retry timeout `upload.GetFile`.

**Belum ditest:** koneksi ke Telegram beneran (perlu jaringan asli). Disarankan
jalanin dulu di server/staging sebelum production, terutama untuk fitur upload
file dan broadcast.
