// ─────────────────────────────────────────────────────────────────────────
// mtproto.js
//
// Client GramJS (MTProto) yang HANYA dipakai untuk operasi file besar:
//   - upload file > UPLOAD_THRESHOLD_MB (lihat hybridFile.js)
//   - download file > DOWNLOAD_THRESHOLD_MB (Bot API cuma bisa download
//     sampai 20MB, GramJS/MTProto bisa sampai 2GB)
//   - ambil ulang pesan lama by ID (client.getMessages), karena Bot API
//     TIDAK punya cara resmi untuk ambil pesan lama by ID.
//
// Login-nya tetap sebagai BOT (botAuthToken), bukan akun user, jadi aman
// dipakai bareng Telegraf yang juga jalan sebagai bot yang sama.
// Koneksi baru dibuka pas pertama kali dibutuhkan (lazy), bukan pas start.
// ─────────────────────────────────────────────────────────────────────────

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");
const CONFIG = require("./config");

const SESSION_FILE = "./session.txt";

const API_ID = parseInt(process.env.API_ID || CONFIG.API_ID || "36242737");
const API_HASH = process.env.API_HASH || CONFIG.API_HASH || "904e85ba2506348c1801cd1db421816c";

function readSessionString() {
  return fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, "utf8").trim() : "";
}

// connectionRetries & downloadRetries dinaikin dari default -- server/VPS
// kadang koneksinya ke DC Telegram gak selalu stabil, apalagi buat file
// gede yang butuh banyak chunk request (upload.GetFile). Biar gak gampang
// nyerah gara-gara 1-2 chunk timeout doang.
const CLIENT_OPTS = {
  connectionRetries: 10,
  retryDelay: 2000,
  downloadRetries: 5,
  requestRetries: 5,
  floodSleepThreshold: 60,
};

let mtclient = new TelegramClient(new StringSession(readSessionString()), API_ID, API_HASH, CLIENT_OPTS);

let readyPromise = null;
let isReady = false;

async function doConnect(sessionStr) {
  console.log("[mtproto] 🔌 Menghubungkan client MTProto (khusus file besar)...");
  mtclient = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, CLIENT_OPTS);
  await mtclient.start({
    botAuthToken: CONFIG.BOT_TOKEN,
    onError: (err) => console.error("[mtproto] ❌ Error:", err.message),
  });
  fs.writeFileSync(SESSION_FILE, mtclient.session.save());
}

/**
 * Pastikan client MTProto sudah konek & login sebagai bot.
 * Aman dipanggil berkali-kali — cuma konek sekali (idempotent).
 *
 * Auto-recovery: kalau ketemu AUTH_KEY_DUPLICATED (biasanya gara-gara ada
 * proses lama yang belum mati bersih & masih pegang session yang sama),
 * session.txt otomatis dihapus dan dicoba login ulang sekali dengan session
 * fresh — karena ini login sebagai BOT (botAuthToken), re-login gak butuh
 * OTP/approval apapun, jadi aman di-otomatisasi.
 */
async function ensureConnected() {
  if (isReady) return mtclient;
  if (!readyPromise) {
    readyPromise = (async () => {
      try {
        await doConnect(readSessionString());
      } catch (e) {
        const msg = e?.message || String(e);
        if (msg.includes("AUTH_KEY_DUPLICATED")) {
          console.warn(
            "[mtproto] ⚠️ AUTH_KEY_DUPLICATED terdeteksi (kemungkinan ada proses lain masih pegang session ini). " +
            "Menghapus session.txt & login ulang dengan session baru..."
          );
          try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
          await doConnect(""); // fresh session, botAuthToken gak butuh OTP
        } else {
          throw e;
        }
      }
      isReady = true;
      console.log("[mtproto] ✅ Siap dipakai untuk transfer file besar.");
    })();

    // Kalau gagal total (bukan cuma AUTH_KEY_DUPLICATED), reset state biar
    // panggilan ensureConnected() berikutnya bisa coba konek lagi dari nol,
    // bukan malah stuck ngulang promise yang udah gagal selamanya.
    readyPromise.catch(() => {
      readyPromise = null;
      isReady = false;
    });
  }
  await readyPromise;
  return mtclient;
}

async function disconnect() {
  try {
    if (isReady) await mtclient.disconnect();
  } catch (_) {}
}

/**
 * Paksa reconnect: dipanggil kalau ada operasi (kirim/terima file) yang
 * gagal karena error jaringan (ECONNRESET/ETIMEDOUT/EAI_AGAIN/dst). GramJS
 * punya auto-reconnect internal, tapi kalau koneksinya beneran mati total,
 * client lama bisa "nyangkut" — retry di client yang sama percuma. Fungsi
 * ini reset state-nya biar panggilan ensureConnected() berikutnya bikin
 * koneksi baru dari nol, bukan ngulang di koneksi yang udah rusak.
 */
async function forceReconnect() {
  console.warn("[mtproto] 🔄 Koneksi bermasalah, reconnect paksa...");
  try {
    await mtclient.disconnect();
  } catch (_) {}
  isReady = false;
  readyPromise = null;
}

// Error jaringan umum yang nandain koneksi TCP-nya beneran putus (bukan
// sekadar 1 chunk telat) — kalau ketemu ini pas transfer file, mtproto
// harus reconnect paksa sebelum retry berikutnya, bukan cuma nunggu & ulang.
const NETWORK_ERROR_HINTS = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "socket", "disconnect", "not connected", "Not connected"];
function isNetworkError(err) {
  const s = `${err?.code || ""} ${err?.message || err}`;
  return NETWORK_ERROR_HINTS.some((hint) => s.includes(hint));
}

// Pastikan koneksi MTProto ditutup dengan bersih pas proses berhenti, supaya
// Telegram gak nganggep session-nya "masih aktif" pas proses berikutnya
// nyala dan bikin AUTH_KEY_DUPLICATED lagi.
process.once("SIGINT", disconnect);
process.once("SIGTERM", disconnect);
process.once("beforeExit", disconnect);

module.exports = {
  get client() { return mtclient; },
  ensureConnected,
  disconnect,
  forceReconnect,
  isNetworkError,
};
