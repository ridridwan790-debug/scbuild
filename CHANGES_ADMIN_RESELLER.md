# Perubahan: Admin & Reseller + Rename All Name + Create Panel Free

## 5. Fitur BARU: "Create Panel Free" (reward referral)

**Alur:**
1. User share link undangan mereka (dari menu Credit Saya / callback `freepanel_start` sebelum eligible)
2. Begitu 5 orang confirmed (start bot + join semua channel wajib), bot otomatis kirim DM "🎁 YEYY! Kamu Bisa Akses Create Panel FREE!"
3. Tombol baru **🎁 CREATE PANEL FREE** muncul di menu utama (hanya kalau eligible & belum pernah claim)
4. User klik tombol → bot minta Username → user kirim → bot minta Password → user kirim
5. Bot create akun panel Pterodactyl dengan resource **Unlimited**, kirim detail login (username/password/URL panel)

**Detail teknis:**
- `credits.js`: tambah `INVITES_FOR_FREE_PANEL` (=5), `getFreePanelStatus()`, `markFreePanelNotified()`, `markFreePanelClaimed()`, `unmarkFreePanelClaimed()` — semua berbasis data referral yang sudah ada (`confirmReferral`/`getReferralStats`)
- `index.js`: fungsi baru `createFreePanelAccount()` (adaptasi dari `SC_AUTO_ORDER_QRISPY`, resource di-set unlimited: `memory/disk/cpu = 0`)
- Jatah **1x per user** — kalau create gagal (misal username sudah dipakai), jatah **tidak hilang**, user boleh coba lagi dengan username lain
- **`config.js`** — perlu diisi manual sebelum dipakai:
  ```js
  PANEL: {
    domain: "https://domain-panel-lu",
    apikey: "APPLICATION_API_KEY_dari_Pterodactyl",
    nestId, eggId, locationId, // sesuaikan dengan panel kamu
  }
  ```
  Isi ini WAJIB diisi sesuai panel Pterodactyl kamu sendiri (bisa lihat contoh nilai di config SC_AUTO_ORDER kamu) sebelum fitur ini bisa jalan.

## 4. Fitur BARU: "Rename All Name" (`🔤 RENAME ALL NAME`)
Fitur berbeda dari "Ganti Nama APK" yang sudah ada sebelumnya (yang itu cuma ganti field `app_name` di AndroidManifest/strings.xml/Info.plist).

Fitur baru ini adalah **find & replace teks bebas** di semua file `.dart` — dipakai misalnya untuk ganti semua kemunculan nama toko di dalam kode project.

**Alur pemakaian (sesuai permintaan):**
1. User klik tombol **🔤 RENAME ALL NAME** di menu utama
2. Bot minta kirim ZIP project Flutter
3. User kirim ZIP
4. Bot minta teks/nama yang mau dicari → user kirim, misal `TOKO KLONTONG ZIPER`
5. Bot minta teks/nama baru penggantinya → user kirim, misal `TOKO KLONTONG ZENOS`
6. Bot cari semua kemunculan `TOKO KLONTONG ZIPER` di semua file `.dart` dalam ZIP, lalu ganti jadi `TOKO KLONTONG ZENOS`, dan kirim balik ZIP hasil beserta daftar file & jumlah yang diganti

**Detail teknis:**
- Fungsi baru `replaceTextInZip()` dan `scanTextInZip()` ditambahkan di `fluttermod.js` (tidak mengubah fungsi lama `replaceAppNameInZip`/`replaceDomainInZip`)
- Pencarian dilakukan hanya di file `.dart` (sama seperti fitur ganti domain), case-sensitive, cocok exact string match (bukan regex khusus — nama dengan karakter spesial otomatis di-escape)
- Memotong 1 credit per pemakaian (sama seperti fitur mod lain), refund otomatis kalau teks tidak ditemukan
- Tercatat di channel notifikasi seperti fitur mod lainnya

## Yang ditambahkan

### 1. `/addadmin <id>` dan `/removeadmin <id>` — khusus Owner
- Owner sekarang bisa menambah/menghapus **Admin** langsung dari bot (tidak perlu edit `ADMIN_IDS` di `config.js`/env lagi).
- Data admin baru disimpan permanen di file baru `admins.json` (format sama seperti `resellers.json`).
- Admin yang berasal dari `ADMIN_IDS` (env/config) tetap admin seperti biasa — tidak bisa dihapus lewat `/removeadmin` (masih harus lewat env, sesuai desain awal). Admin yang ditambah lewat `/addadmin` bisa dihapus lewat `/removeadmin`.
- Tombol "➕ Add Admin" / "➖ Remove Admin" muncul di Owner Panel.

### 2. Reseller sekarang bisa:
- **`/addcredit <user_id> <jumlah>`** — reseller bisa nambah credit ke user manapun, tanpa batas (sama seperti admin).
- **`/broadcast`** — reseller bisa broadcast pesan ke semua user (untuk non-owner, tetap lewat alur approval Owner seperti yang sudah ada — Owner akan dapat notifikasi izinkan/tolak).

### 3. Yang TETAP tidak berubah (sesuai permintaan):
- **Reseller TIDAK BISA** `/addreseller` atau `/removereseller` — itu tetap khusus Admin & Owner.
- Semua fitur privileged lain (ban/unban, delete user, kill build, dll) tetap khusus Admin & Owner, reseller tidak bisa akses.

## File yang berubah
- `index.js` — semua logic di atas
- `admins.json` — file baru (kosong `[]` di awal), otomatis terisi saat Owner pakai `/addadmin`

## Ringkasan hak akses akhir

| Fitur                          | Owner | Admin | Reseller | User |
|---------------------------------|:---:|:---:|:---:|:---:|
| `/addadmin`, `/removeadmin`     | ✅ | ❌ | ❌ | ❌ |
| `/addreseller`, `/removereseller` | ✅ | ✅ | ❌ | ❌ |
| `/addcredit`                     | ✅ | ✅ | ✅ | ❌ |
| `/broadcast`                     | ✅ | ✅ (approval) | ✅ (approval) | ❌ |
| Ban/unban/delete user, dll       | ✅ | ✅ | ❌ | ❌ |

## Catatan keamanan (tidak terkait permintaan ini, tapi penting)
File `config.js` di dalam backup ini masih berisi `BOT_TOKEN`, `GITHUB_TOKEN`, dan `VERCEL_TOKEN` dalam bentuk plaintext hardcoded. Ini sudah disebut di `CHANGES_README.md` sebelumnya juga — sangat disarankan untuk rotate/revoke token-token tersebut dan pindahkan ke environment variable, terutama karena file backup ini sempat di-share.

## 6. PERUBAHAN BESAR: Mesin Build Diganti Total — GitHub Actions Only (multi-worker)

**Yang lama:** `server.js` sebelumnya berisi kode yang **di-obfuscate berat** (variabel nama Kanji/Thai acak, base64 eval) — saya tidak pernah membuka atau menjalankan isinya. File itu sekarang disimpan sebagai `server.js.obfuscated.old` (tidak dipakai lagi, tidak di-require dari mana pun) — boleh dihapus manual kalau tidak dibutuhkan lagi.

**Yang baru:** `server.js` sekarang adalah kode bersih (bisa dibaca, bukan hasil obfuscate) yang saya tulis ulang dari nol, mem-build APK **HANYA lewat GitHub Actions** (tidak ada VPS sama sekali, sesuai permintaan). Kontrak dispatch-nya (`inputs: {jobId, userId, payload}`, artifact dinamai `apk-${jobId}`) **disamakan persis** dengan project `WEB2APK_GEN_2`/`ziperbuild`, supaya kompatibel dengan file workflow yang sama.

**Fitur baru: Multi-Worker GitHub (round-robin)**
Sekarang bisa daftar LEBIH DARI SATU repo/token GitHub sebagai "worker" — build akan dibagi rata (round-robin) supaya tidak numpuk/kena rate-limit di satu repo saja.

- `/addworkergithub` (Owner only) — alur step-by-step aman (label → repo → token → nama file workflow Flutter → nama file workflow Android). Pesan berisi token otomatis dihapus dari chat setelah tersimpan.
- `/listworkergithub` (Owner only) — lihat semua worker terdaftar
- `/removeworkergithub <id>` (Owner only) — hapus satu worker
- Data worker disimpan di `githubworkers.json` (baru, format sama pola `resellers.json`/`admins.json`)

**File workflow GitHub Actions (WAJIB ada di repo GitHub yang didaftarkan sebagai worker):**
File referensi sudah disertakan di `.github/workflows/build-flutter.yml` dan `.github/workflows/build-android.yml` (disalin dari `ziperbuild`/`WEB2APK_GEN_2`). **Copy kedua file ini ke folder `.github/workflows/` di REPO GITHUB milik Anda sendiri** (bukan di server bot) — GitHub Actions cuma jalan kalau file ini ada di repo yang benar.

### File yang berubah/ditambah:
- `server.js` — **DIGANTI TOTAL**, sekarang bersih & GitHub-only (sebelumnya obfuscated)
- `server.js.obfuscated.old` — backup file lama, tidak dipakai lagi
- `githubworkers.json` — file baru, penyimpanan data worker GitHub
- `.github/workflows/build-flutter.yml`, `.github/workflows/build-android.yml` — file referensi workflow (copy ke repo GitHub Anda)
- `index.js` — semua pemanggilan build (`handleZipFile`, `monitorBuild`, `handleWeb2ApkIcon`) disesuaikan untuk pilih & pakai worker secara eksplisit

### Cara pakai:
1. Push kedua file `.github/workflows/*.yml` ke repo GitHub Anda (branch `main`)
2. Di bot, ketik `/addworkergithub` → ikuti langkah (label, `owner/repo`, token PAT dengan scope `repo`+`actions`, nama file workflow)
3. Ulangi untuk repo lain kalau mau tambah worker lagi (load akan dibagi round-robin)
4. Build APK seperti biasa — otomatis pakai worker yang terdaftar
