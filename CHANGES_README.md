# Ringkasan Perubahan

## File baru
- **credits.js** — modul kredit: saldo, referral, kode redeem, log deploy (khusus owner), list pembeli, backup GitHub.
  Data disimpan di folder `./data_credits/` (`credits.json`, `redeem.json`, `deploys.json`, `buyers.json`).

## Fitur yang ditambahkan di index.js

1. **Credit awal 5** — otomatis diberikan saat user pertama kali `/start`.
2. **Potong 1 credit** di semua fitur utama: Build APK, Web2APK, Deploy Web (HTML & ZIP), Ganti Domain, Ganti Warna, Ganti Icon, Ganti Nama, Enkripsi HTML/JS.
   Kalau prosesnya gagal/dibatalkan sistem otomatis refund credit-nya.
   Owner & Admin (`OWNER_ID` / `ADMIN_IDS`) **unlimited**, tidak kena potong.
3. **Sistem referral** — link `https://t.me/<username_bot>?start=<user_id>` bisa dilihat di menu **💰 Credit Saya**.
   Begitu orang yang diajak start bot + join semua channel wajib, pembagi link otomatis dapat **+5 credit** dan dapat notifikasi DM.
4. **Beli / Redeem Credit** — tombol di menu utama:
   - Klik paket → order dikirim ke Owner (`credit_approve_/credit_reject_`), owner approve → credit masuk otomatis + tercatat di **list pembeli** (`/listbuyers` atau tombol "🙏 List Pembeli Credit" di panel owner).
   - Redeem kode: tombol atau command `/redeem KODE`.
   - Generate kode (owner/admin): `/gencode <jumlah_credit> [maks_pemakaian]`
   - Tambah credit manual (owner/admin): `/addcredit <user_id> <jumlah>`
5. **Privasi deploy** — untuk **Deploy Web** dan **Ganti Domain**, URL/domain asli **tidak lagi dikirim ke channel notifikasi publik** (supaya info server tidak bocor ke publik). User tetap dapat link/hasil mereka sendiri lewat DM seperti biasa.
   Semua histori deploy & ganti-domain tetap dicatat dan hanya bisa dilihat Owner lewat:
   - Tombol **🌍 Semua Deploy** di menu utama (khusus owner), atau
   - Command `/alldeploy`
6. **Backup database ke GitHub** — otomatis tiap 30 menit (private repo `bot-database-backup` di akun `GITHUB_USERNAME`), backup manual: `/dbbackup` (owner). Yang di-backup: users, resellers, banned, buildhistory, credits, redeem codes, deploy log, buyer list. Kalau server mati, data ini bisa dipulihkan dari repo GitHub tsb.
7. **Ganti Icon APK** — sudah dari awal **hanya** mengganti file di path
   `android/app/src/main/res/mipmap-*/ic_launcher*.png` (dan slot resmi iOS `AppIcon.appiconset`), tidak menyentuh
   file gambar lain di project — sudah sesuai permintaan, tidak perlu diubah.

## Yang PERLU kamu lakukan sendiri
- **Ganti/rotate `GITHUB_TOKEN` dan `VERCEL_TOKEN`** di `config.js` — token yang ada di file upload kamu itu masih hardcoded plaintext dan sudah saya lihat isinya. Kalau file ini sempat ke-share/ke-leak ke orang lain, tokennya sebaiknya di-revoke & buat baru, lalu taruh lewat environment variable (`process.env.GITHUB_TOKEN`, dst) bukan hardcode di file.
- Halaman UI/notifikasi channel sudah saya rapikan sedikit (nambah baris saldo + menyembunyikan URL sensitif), tapi karena file `index.js` sudah sangat besar (~3400 baris awal), saya fokus ke fungsi yang kamu minta. Kalau mau desain ulang total tampilan (emoji, layout blockquote, dst) bilang aja bagian mana yang mau diubah gaya nya.
- Sistem "beli credit" masih **manual approve by owner** (belum ada payment gateway/QRIS otomatis) — kalau mau otomatis pakai QRIS kayak di bot `SC_AUTO_ORDER_DITZ` kamu, bilang aja nanti saya sambungkan ke Qrispy.
