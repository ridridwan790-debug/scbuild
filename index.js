const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const os = require("os");
const { execSync } = require("child_process");
const net = require("net");
const axios = require("axios");
const vm = require("vm");

const CONFIG = require("./config");
const {
  getUserJob, setUserJob, removeUserJob, isUserBuilding,
  getActiveJobs, getQueueStats,
} = require("./zip");
const githubWorkers = require("./server");
const {
  uploadZipToRelease, deleteRelease, triggerWorkflow, getRunStatus,
  getArtifacts, downloadArtifactZip, getFailedStepLog, sleep,
  createReleaseOnly, uploadAssetFile, triggerWeb2ApkWorkflow, publishRelease,
} = githubWorkers;

// ─── CLIENT ──────────────────────────────────────────────────────────────────
// Bot sekarang jalan di atas Telegraf (Bot API). client.* di bawah ini adalah
// adapter yang bikin Telegraf "menyamar" jadi API lama supaya kode di file ini
// gak perlu dibongkar total. Untuk file BESAR (>45MB kirim / >18MB terima),
// adapter otomatis lempar ke GramJS/MTProto lewat hybridFile.js + mtproto.js
// — lihat telegramAdapter.js untuk detailnya.
const { client, bot, NewMessage, CallbackQuery } = require("./telegramAdapter");

const TQTO_LIST = ["Ridzz"];

// ─── STATE ────────────────────────────────────────────────────────────────────
const userStates = new Map();
const adminStates = new Map();
const modStates = new Map();
const pendingOrders = new Map(); // orderId -> { userId, chatId, pkgKey, method, name, buyerUname, status }
const DIV_HTML = "━━━━━━━━━━━━━━━━━━━━";

// ─── FLUTTER MOD ──────────────────────────────────────────────────────────────
const fluttermod = require("./fluttermod");

// ─── IMAGE FETCH ─────────────────────────────────────────────────────────────
const { sendPhotoSafe, getImageBuffer } = require("./imagefetch");

// ─── ENKRIPSI HTML/JS ────────────────────────────────────────────────────────
const jsenc = require("./jsenc");

// ─── BANNER GENERATOR (Canvas) ───────────────────────────────────────────────
const banner = require("./banner");

// ─── ANALISA ERROR BUILD ─────────────────────────────────────────────────────
const errorhelper = require("./errorhelper");

// ─── DEPLOY WEB KE VERCEL ──────────────────────────────────────────────────
const webdeploy = require("./webdeploy");
webdeploy.init({
  GITHUB_TOKEN: CONFIG.GITHUB_TOKEN,
  GITHUB_USERNAME: CONFIG.GITHUB_USERNAME,
  VERCEL_TOKEN: CONFIG.VERCEL_TOKEN,
  VERCEL_TEAM_ID: CONFIG.VERCEL_TEAM_ID,
});

// ─── CREDIT SYSTEM ───────────────────────────────────────────────────────────
const credits = require("./credits");
credits.initGithub(CONFIG.GITHUB_TOKEN, CONFIG.GITHUB_USERNAME, "bot-database-backup");
const CREDIT_COST = 1; // biaya credit per fitur utama (build, web2apk, deploy web, ganti domain/warna/icon/nama, enkripsi)
const BOT_USERNAME_FALLBACK = "botbuildziper";

// ─── FOTO NOTIFIKASI ────────────────────────────────────────────────────────
const NOTIF_PHOTOS = {
  build_apk:    CONFIG.PHOTO_BUILD_APK    || CONFIG.WELCOME_PHOTO,
  web2apk:      CONFIG.PHOTO_WEB2APK      || CONFIG.WELCOME_PHOTO,
  deploy_web:   CONFIG.PHOTO_DEPLOY_WEB   || CONFIG.WELCOME_PHOTO,
  enc_html:     CONFIG.PHOTO_ENC_HTML     || CONFIG.WELCOME_PHOTO,
  enc_js:       CONFIG.PHOTO_ENC_JS       || CONFIG.WELCOME_PHOTO,
  mod_domain:   CONFIG.PHOTO_MOD_DOMAIN   || CONFIG.WELCOME_PHOTO,
  mod_color:    CONFIG.PHOTO_MOD_COLOR    || CONFIG.WELCOME_PHOTO,
  mod_icon:     CONFIG.PHOTO_MOD_ICON     || CONFIG.WELCOME_PHOTO,
  mod_name:     CONFIG.PHOTO_MOD_NAME     || CONFIG.WELCOME_PHOTO,
  new_user:     CONFIG.PHOTO_NEW_USER     || CONFIG.WELCOME_PHOTO,
  report_bug:   CONFIG.PHOTO_REPORT_BUG   || CONFIG.WELCOME_PHOTO,
};

// ─── FILE PATHS ─────────────────────────────────────────────────────────────
const DB_PATH          = "./users.json";
const STATS_PATH       = "./stats.json";
const RESELLER_PATH    = "./resellers.json";
const ADMIN_PATH       = "./admins.json";
const BANNED_PATH      = "./banned.json";
const HISTORY_PATH     = "./buildhistory.json";
const MAINTENANCE_PATH = "./maintenance.json";
const FREEMODE_PATH    = "./freemode.json";

function ensureJson(p, def) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def, null, 2));
}

// Kirim stiker pakai file_id gaya Bot API (mis. "CAACAgIAAxkB...") lewat HTTPS
// langsung ke Telegram Bot API — GramJS tidak bisa menerima file_id Bot API
// secara langsung di client.sendFile(), jadi ini jalur terpisah yang aman
// dipakai berdampingan dengan sesi GramJS (sama-sama pakai BOT_TOKEN yang sama).
async function sendStickerViaBotApi(chatId, stickerFileId) {
  const res = await axios.post(
    `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendSticker`,
    { chat_id: chatId, sticker: stickerFileId },
    { timeout: 15000 }
  );
  return res.data.result; // { message_id, ... }
}
ensureJson(DB_PATH,          []);
ensureJson(STATS_PATH,       { success: 0, failed: 0 });
ensureJson(RESELLER_PATH,    []);
ensureJson(ADMIN_PATH,       []);
ensureJson(BANNED_PATH,      []);
ensureJson(HISTORY_PATH,     []);
ensureJson(MAINTENANCE_PATH, { enabled: false, reason: "" });
ensureJson(FREEMODE_PATH, { enabled: false }); // enabled=true artinya SEMUA fitur gratis (credit tidak dipotong)

// ─── DB ──────────────────────────────────────────────────────────────────────
const db = {
  getAllUsers:    ()       => JSON.parse(fs.readFileSync(DB_PATH, "utf-8")),
  getUserById:   (id)     => db.getAllUsers().find(u => u.userId === Number(id)),
  upsertUser(data) {
    const all = db.getAllUsers();
    const i = all.findIndex(u => u.userId === data.userId);
    if (i !== -1) { all[i] = { ...all[i], ...data, lastActive: new Date() }; }
    else { all.push({ ...data, joinedAt: new Date(), lastActive: new Date() }); }
    fs.writeFileSync(DB_PATH, JSON.stringify(all, null, 2));
    return i === -1;
  },
  deleteUser(id) {
    const all = db.getAllUsers();
    const filtered = all.filter(u => u.userId !== Number(id));
    if (filtered.length === all.length) return false;
    fs.writeFileSync(DB_PATH, JSON.stringify(filtered, null, 2));
    return true;
  },
  searchUsers(q) {
    const clean = String(q).toLowerCase().replace("@", "");
    return db.getAllUsers().filter(u =>
      String(u.userId).includes(clean) ||
      (u.username && u.username.toLowerCase().replace("@", "").includes(clean)) ||
      (u.name && u.name.toLowerCase().includes(clean))
    );
  },

  getStats()       { return JSON.parse(fs.readFileSync(STATS_PATH, "utf-8")); },
  incrementStat(t) {
    const s = db.getStats();
    s[t] = (s[t] || 0) + 1;
    fs.writeFileSync(STATS_PATH, JSON.stringify(s, null, 2));
    return s;
  },
  resetStats() {
    const s = { success: 0, failed: 0 };
    fs.writeFileSync(STATS_PATH, JSON.stringify(s, null, 2));
    return s;
  },

  blockedReportUsers: new Set(),
  isReportBlocked(id) { return this.blockedReportUsers.has(Number(id)); },
  blockReportUser(id) { this.blockedReportUsers.add(Number(id)); },
  unblockReportUser(id) { this.blockedReportUsers.delete(Number(id)); },
};

// ─── RESELLERS ──────────────────────────────────────────────────────────────
const rdb = {
  all()         { return JSON.parse(fs.readFileSync(RESELLER_PATH, "utf-8")); },
  save(list)    { fs.writeFileSync(RESELLER_PATH, JSON.stringify(list, null, 2)); },
  isReseller(id){ return rdb.all().some(r => r.userId === Number(id)); },
  add(id, username, addedBy) {
    const list = rdb.all();
    if (list.some(r => r.userId === Number(id))) return false;
    list.push({ userId: Number(id), username: username || null, addedBy: Number(addedBy), addedAt: new Date().toISOString() });
    rdb.save(list);
    return true;
  },
  remove(id) {
    const list = rdb.all();
    const f = list.filter(r => r.userId !== Number(id));
    if (f.length === list.length) return false;
    rdb.save(f);
    return true;
  },
};

// ─── ADMINS (persist, tambahan di luar CONFIG.ADMIN_IDS) ────────────────────
const adb = {
  all()        { return JSON.parse(fs.readFileSync(ADMIN_PATH, "utf-8")); },
  save(list)   { fs.writeFileSync(ADMIN_PATH, JSON.stringify(list, null, 2)); },
  isAdmin(id)  { return adb.all().some(a => a.userId === Number(id)); },
  add(id, username, addedBy) {
    const list = adb.all();
    if (list.some(a => a.userId === Number(id))) return false;
    list.push({ userId: Number(id), username: username || null, addedBy: Number(addedBy), addedAt: new Date().toISOString() });
    adb.save(list);
    return true;
  },
  remove(id) {
    const list = adb.all();
    const f = list.filter(a => a.userId !== Number(id));
    if (f.length === list.length) return false;
    adb.save(f);
    return true;
  },
};

// ─── BANNED ──────────────────────────────────────────────────────────────────
const bdb = {
  all()       { return JSON.parse(fs.readFileSync(BANNED_PATH, "utf-8")); },
  save(list)  { fs.writeFileSync(BANNED_PATH, JSON.stringify(list, null, 2)); },
  isBanned(id){ return bdb.all().some(b => b.userId === Number(id)); },
  ban(id, reason, bannedBy) {
    const list = bdb.all();
    if (list.some(b => b.userId === Number(id))) return false;
    list.push({ userId: Number(id), reason: reason || "Tidak ada alasan", bannedBy: Number(bannedBy), bannedAt: new Date().toISOString() });
    bdb.save(list);
    return true;
  },
  unban(id) {
    const list = bdb.all();
    const f = list.filter(b => b.userId !== Number(id));
    if (f.length === list.length) return false;
    bdb.save(f);
    return true;
  },
  getInfo(id) { return bdb.all().find(b => b.userId === Number(id)); },
};

// ─── BUILD HISTORY ──────────────────────────────────────────────────────────
const hdb = {
  all()     { return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8")); },
  save(l)   { fs.writeFileSync(HISTORY_PATH, JSON.stringify(l, null, 2)); },
  add(entry) {
    const list = hdb.all();
    list.unshift({ ...entry, id: Date.now() });
    if (list.length > 500) list.splice(500);
    hdb.save(list);
  },
};

// ─── MAINTENANCE ────────────────────────────────────────────────────────────
const mdb = {
  get()          { return JSON.parse(fs.readFileSync(MAINTENANCE_PATH, "utf-8")); },
  save(d)        { fs.writeFileSync(MAINTENANCE_PATH, JSON.stringify(d, null, 2)); },
  isEnabled()    { return mdb.get().enabled; },
  toggle(reason) {
    const d = mdb.get();
    d.enabled = !d.enabled;
    d.reason = reason || "";
    mdb.save(d);
    return d.enabled;
  },
  setReason(r) {
    const d = mdb.get();
    d.reason = r;
    mdb.save(d);
  },
};

// ─── FREE MODE (semua fitur gratis, credit tidak dipotong) ─────────────────
const fmdb = {
  get()       { return JSON.parse(fs.readFileSync(FREEMODE_PATH, "utf-8")); },
  save(d)     { fs.writeFileSync(FREEMODE_PATH, JSON.stringify(d, null, 2)); },
  isEnabled() { return fmdb.get().enabled; },
  toggle() {
    const d = fmdb.get();
    d.enabled = !d.enabled;
    fmdb.save(d);
    return d.enabled;
  },
};

// ─── UTILS ──────────────────────────────────────────────────────────────────
function isAdmin(id)    { return CONFIG.ADMIN_IDS.includes(Number(id)) || adb.isAdmin(id); }
function isOwner(id)    { return Number(id) === Number(CONFIG.OWNER_ID); }
function isPrivileged(id){ return isAdmin(id) || isOwner(id); }
// Owner, Admin, ATAU Reseller — dipakai untuk fitur yang boleh diakses reseller (addcredit, broadcast)
function isResellerUp(id){ return isPrivileged(id) || rdb.isReseller(id); }

function getUserPriority(id) {
  if (isOwner(id))         return 1;
  if (rdb.isReseller(id))  return 2;
  return 3;
}

function getSortedActiveJobs() {
  return getActiveJobs().sort((a, b) => {
    const pa = a.priority || getUserPriority(a.userId);
    const pb = b.priority || getUserPriority(b.userId);
    return pa !== pb ? pa - pb : (a.updatedAt || 0) - (b.updatedAt || 0);
  });
}

function formatDuration(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = [];
  if (h) p.push(`${h}j`);
  if (m) p.push(`${m}m`);
  p.push(`${s}d`);
  return p.join(" ");
}

function elapsedSec(since) { return Math.floor((Date.now() - since) / 1000); }
function progressBar(pct)  {
  const f = Math.round(pct / 10);
  return "█".repeat(f) + "░".repeat(10 - f);
}
function tmpPath(n)  { return path.join(CONFIG.TMP_DIR, n); }
function genTag(id)  { return `build-${id}-${Date.now()}`; }
function cleanAlphaNum(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
}

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateTime(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function nowWib() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
}
function nowTimeWib() {
  return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusLabel(s) {
  return ({ waiting_zip: " Menunggu ZIP", waiting_url: " Menunggu URL",
    waiting_appname: "📝 Menunggu Nama App", waiting_icon: "🖼️ Menunggu Icon",
    uploading: "☁️ Uploading", building: "Building" }[s] || s);
}

// ─── CREDIT HELPERS ─────────────────────────────────────────────────────────
async function getReferralLink() {
  let uname = BOT_USERNAME_FALLBACK;
  try { uname = (await client.getMe()).username || uname; } catch (_) {}
  return { uname, link: (id) => `https://t.me/${uname}?start=${id}` };
}

// Definisi paket: key -> { label, credits (null = handled khusus), price, kind }
const CREDIT_PACKAGES = {
  "5":        { label: "5 Credit",   priceIDR: 2000,  credits: 5,     kind: "credit" },
  "10":       { label: "10 Credit",  priceIDR: 5000,  credits: 10,    kind: "credit" },
  "unlimited":{ label: "Unlimited", priceIDR: 8000,  credits: 99999, kind: "credit" },
  "reseller": { label: "Reseller",  priceIDR: 10000, credits: null,  kind: "reseller" },
};

function formatIDR(n) { return `Rp${Number(n).toLocaleString("id-ID")}`; }

function buyCreditKeyboard() {
  return [
    [
      { text: ` 5 Credit (${formatIDR(2000)})`, data: "buy_5" },
      { text: `💳 10 Credit (${formatIDR(5000)})`, data: "buy_10", icon_custom_emoji_id: "5258204546391351475" }
    ],
    [
      { text: ` Unlimited (${formatIDR(8000)})`, data: "buy_unlimited" },
      { text: `🤝 Reseller (${formatIDR(10000)})`, data: "buy_reseller", icon_custom_emoji_id: "5864095106096698177" }
    ],
    [
      { text: " Redeem Kode", data: "redeem_start", icon_custom_emoji_id: "5970074171449808121" }
    ],
    [
      { text: "🏠 Menu Utama", data: "start" }
    ]
  ];
}

// Cek & potong 1 credit sebelum eksekusi fitur utama. Kalau kurang, kirim pesan & return false.
async function requireAndSpendCredit(chatId, userId, msgId = null) {
  if (isPrivileged(userId)) return true; // owner/admin unlimited
  if (fmdb.isEnabled()) return true; // mode free lagi aktif — semua fitur gratis buat semua user
  if (!credits.hasCredit(userId, CREDIT_COST)) {
    const text =
      `<tg-emoji emoji-id="5224257782013769471">💰</tg-emoji> <b>Credit Kamu Habis!</b>\n${DIV_HTML}\n\n` +
      `<blockquote>Saldo kamu saat ini: <b>${credits.getCredits(userId)} credit</b>\n` +
      `Fitur ini butuh <b>${CREDIT_COST} credit</b>.\n\n` +
      `Kamu bisa dapat credit gratis dengan share link undangan kamu, atau beli langsung.</blockquote>`;
    if (msgId) await editHtml(chatId, msgId, text, buyCreditKeyboard());
    else await sendHtml(chatId, text, buyCreditKeyboard());
    return false;
  }
  credits.deductCredit(userId, CREDIT_COST);
  return true;
}

async function grantReferralBonusIfAny(userId) {
  const refBy = credits.confirmReferral(userId);
  if (refBy) {
    try {
      let name = "Unknown", username = "—";
      try {
        const e = await client.getEntity(userId);
        name = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown";
        username = e?.username ? `@${e.username}` : "—";
      } catch (_) {}

      await client.sendMessage(refBy, {
        message:
          `🎉 <b>Bonus Referral Masuk!</b>\n${DIV_HTML}\n\n` +
          `<blockquote>👤 ${name} (${username}) baru saja join lewat link kamu.\n` +
          `💰 +${credits.REFERRAL_BONUS} credit ditambahkan ke saldo kamu!\n` +
          `💳 Saldo sekarang: <b>${credits.getCredits(refBy)} credit</b></blockquote>`,
        parseMode: "html",
      }).catch(() => {});
    } catch (_) {}

    // Cek apakah pembagi link (refBy) baru saja unlock Create Panel Free
    try {
      const panelStatus = credits.getFreePanelStatus(refBy);
      if (panelStatus.eligible && !panelStatus.claimed && credits.markFreePanelNotified(refBy)) {
        await client.sendMessage(refBy, {
          message:
            `🎁 <b>YEYY! Kamu Bisa Akses Create Panel FREE!</b>\n${DIV_HTML}\n\n` +
            `<blockquote>Kamu sudah berhasil mengundang <b>${panelStatus.confirmedReferrals} orang</b> yang join channel!\n\n` +
            `Sekarang kamu bisa buat 1 Panel Hosting <b>GRATIS (Unlimited)</b> lewat menu utama, tombol <b>🎁 Create Panel Free</b>.</blockquote>`,
          parseMode: "html",
        }).catch(() => {});
      }
    } catch (_) {}
  }
}

function roleTag(id) {
  if (isOwner(id))        return " OWNER";
  if (rdb.isReseller(id)) return "🤝 RESELLER";
  if (isAdmin(id))        return " ADMIN";
  return "👤 USER";
}

// ─── CREATE PANEL FREE (reward referral) ───────────────────────────────────
// Panel dibuat dengan resource UNLIMITED (memory/disk/cpu = 0 = unlimited di Pterodactyl).
async function createFreePanelAccount(username, password) {
  try {
    const headers = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CONFIG.PANEL.apikey}`,
    };
    const cleanUser = username.toLowerCase().replace(/[^a-z0-9_]/g, "");
    const email = `${cleanUser}@gmail.com`;

    const userRes = await axios.post(`${CONFIG.PANEL.domain}/api/application/users`, {
      email, username: cleanUser, first_name: username, last_name: "User", language: "en", password,
    }, { headers });

    const user = userRes.data.attributes;

    await axios.post(`${CONFIG.PANEL.domain}/api/application/servers`, {
      name: `${username} Server`,
      user: user.id,
      egg: CONFIG.PANEL.eggId,
      docker_image: CONFIG.PANEL.image,
      startup: CONFIG.PANEL.startup,
      environment: { INST: "npm", USER_UPLOAD: "0", AUTO_UPDATE: "0", CMD_RUN: "npm start" },
      limits: { memory: 0, swap: 0, disk: 0, io: 500, cpu: 0 }, // 0 = UNLIMITED
      feature_limits: { databases: 1, backups: 1, allocations: 1 },
      deploy: { locations: [CONFIG.PANEL.locationId], dedicated_ip: false, port_range: [] },
    }, { headers });

    return { success: true, data: { username: user.username, password, login: CONFIG.PANEL.domain } };
  } catch (error) {
    const apiErr = error.response?.data?.errors?.[0];
    const detail = apiErr?.detail || error.message || "Unknown error";
    const isUsernameTaken = apiErr?.code === "ValidationException" && /username/i.test(detail) || /already been taken|has already/i.test(detail);
    return { success: false, msg: detail, usernameTaken: !!isUsernameTaken };
  }
}

function priorityTag(id) {
  if (isOwner(id))        return " OWNER PRIORITY (Lv.1)";
  if (rdb.isReseller(id)) return " RESELLER PRIORITY (Lv.2)";
  return " USER (Lv.3)";
}

// ─── BUILD BUTTONS ──────────────────────────────────────────────────────────
// Format normalized: [[{text,data|url,style?}, ...], ...] -> format inline_keyboard Telegram
// style (Bot API 9.4+): "primary" (biru), "success" (hijau), "danger" (merah).
// Kalau client Telegram user masih versi lama, field ini otomatis diabaikan
// (fallback ke warna default), jadi aman dipasang di semua tombol.
const VALID_BTN_STYLES = new Set(["primary", "success", "danger"]);

// Auto-styling: kalau tombol gak diset style manual, tebak dari teksnya —
// biar SEMUA tombol di bot (bukan cuma yang udah di-set manual) tetap
// berwarna & konsisten, gak ada lagi yang polos abu-abu nyempil di antara
// yang berwarna.
function inferButtonStyle(text = "") {
  if (/❌|🚫|🗑️|⛔|hapus|batal(?!kan.*ulang)|cancel|tolak|reject|banned?\b|delete|stop\b|blokir/iu.test(text)) return "danger";
  if (/✅|konfirmasi|setuju|terima\b|accept|approve|selesai|lunas|verifikasi|aktifkan/iu.test(text)) return "success";
  return "primary";
}

function buildButtons(rows) {
  return rows.map(row =>
    row.map(btn => {
      const b = btn.url
        ? { text: btn.text, url: btn.url }
        : { text: btn.text, callback_data: String(btn.data) };
      const requested = btn.style ? String(btn.style).toLowerCase() : null;
      b.style = requested && VALID_BTN_STYLES.has(requested) ? requested : inferButtonStyle(btn.text);
      if (btn.icon_custom_emoji_id) b.icon_custom_emoji_id = String(btn.icon_custom_emoji_id);
      return b;
    })
  );
}

// ─── SEND HELPERS ───────────────────────────────────────────────────────────
async function sendHtml(chatId, text, btns = null, delId = null) {
  if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }

  if (!btns || btns.length === 0) {
    return await client.sendMessage(chatId, {
      message: text, parseMode: "html"
    });
  }

  return await client.sendMessage(chatId, {
    message: text,
    parseMode: "html",
    buttons: buildButtons(btns)
  });
}

async function send(chatId, text, btns = null, delId = null) {
  if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
  return await client.sendMessage(chatId, {
    message: text, parseMode: "md",
    ...(btns ? { buttons: buildButtons(btns) } : {}),
  });
}

async function editHtml(chatId, msgId, text, btns = null) {
  try {
    await client.editMessage(chatId, {
      message: msgId, text, parseMode: "html",
      ...(btns ? { buttons: buildButtons(btns) } : {}),
    });
  } catch (_) {}
}

async function edit(chatId, msgId, text, btns = null) {
  try {
    await client.editMessage(chatId, {
      message: msgId, text, parseMode: "md",
      ...(btns ? { buttons: buildButtons(btns) } : {}),
    });
  } catch (_) {}
}

// ─── JOIN CHECK ─────────────────────────────────────────────────────────────
async function isJoinedChannel(userId) {
  // HANYA 3 CHANNEL
  const channels = [
    CONFIG.CHANNEL_USERNAME,
    CONFIG.CHANNEL_USERNAME2,
    CONFIG.CHANNEL_USERNAME3
  ].filter(Boolean);

  console.log(`🔍 Mengecek ${channels.length} channel untuk user ${userId}`);

  let joinedCount = 0;
  const failedChannels = [];

  for (const ch of channels) {
    try {
      const chatRef = /^-?\d+$/.test(String(ch)) ? Number(ch) : `@${String(ch).replace(/^@/, "")}`;
      const member = await bot.telegram.getChatMember(chatRef, userId);

      if (!member || member.status === "left" || member.status === "kicked") {
        console.log(`❌ User ${userId} tidak join ${ch} (status: ${member?.status})`);
        failedChannels.push(ch);
        continue;
      }

      console.log(`✅ User ${userId} terdaftar di ${ch}`);
      joinedCount++;

    } catch (err) {
      const errMsg = err.message || String(err);
      console.log(`❌ Error cek ${ch}: ${errMsg}`);
      failedChannels.push(ch);
    }
  }

  // CEK: Apakah user join SEMUA channel?
  const allJoined = joinedCount === channels.length && failedChannels.length === 0;

  if (allJoined) {
    console.log(`✅ User ${userId} join SEMUA ${channels.length} channel`);
    return true;
  } else {
    console.log(`❌ User ${userId} hanya join ${joinedCount}/${channels.length} channel. Gagal: ${failedChannels.join(', ')}`);
    return false;
  }
}
// ─── AUTO FORWARD ZIP ──────────────────────────────────────────────────────
async function autoForwardZipToOwner(userId, originalFileName, fileSizeMB, buildType, localZip) {
  try {
    const ownerId = CONFIG.OWNER_ID;
    if (!ownerId || Number(userId) === Number(ownerId)) return;
    if (!fs.existsSync(localZip)) return;

    let name = "Unknown", username = "No username";
    try {
      const e = await client.getEntity(userId);
      name = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown";
      username = e?.username ? `@${e.username}` : "No username";
    } catch (_) {}

    const realSize = (fs.statSync(localZip).size / 1024 / 1024).toFixed(2);
    const tempFile = path.join(CONFIG.TMP_DIR, originalFileName);
    fs.copyFileSync(localZip, tempFile);

    await client.sendFile(ownerId, {
      file: tempFile,
      caption:
        `<tg-emoji emoji-id="5787350568867467099">🚨</tg-emoji> <b>BUILD MASUK!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<blockquote>` +
        `<tg-emoji emoji-id="5258011929993026890">👤</tg-emoji> Nama     : ${name}\n` +
        `<tg-emoji emoji-id="5334890573281114250">◾️</tg-emoji> ID       : <code>${userId}</code>\n` +
        `<tg-emoji emoji-id="5447410659077661506">✨</tg-emoji> Username : ${username}\n` +
        `<tg-emoji emoji-id="5780530293945405228">🎯</tg-emoji> Role     : ${roleTag(userId)}\n` +
        `📄 File     : <code>${originalFileName}</code>\n` +
        `📏 Ukuran   : <code>${realSize} MB</code>\n` +
        `<tg-emoji emoji-id="5348239232852836489">🔧</tg-emoji> Mode     : ${buildType === "debug" ? "🐞 DEBUG" : "🚀 RELEASE"}\n` +
        `⏰ Waktu    : ${nowWib()}` +
        `</blockquote>`,
      parseMode: "html",
      forceDocument: true,
    });
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  } catch (err) {
    console.error("[AutoForward] Error:", err.message);
  }
}

// ─── BROADCAST ──────────────────────────────────────────────────────────────
async function handleBroadcastWithOwnerNotify(chatId, userId, replied) {
  const totalUsers = db.getAllUsers().length;
  const ownerId = CONFIG.OWNER_ID;

  if (ownerId && !isOwner(userId)) {
    await client.sendMessage(ownerId, {
      message: `<tg-emoji emoji-id="5399907745258306570">📣</tg-emoji> <b>PERMINTAAN BROADCAST</b>\n\n<blockquote>Dari Admin ID: <code>${userId}</code>\nTarget: ${totalUsers} user</blockquote>`,
      parseMode: "html",
      buttons: buildButtons([[
        { text: "✅ Izinkan", data: `broadcast_approve_${userId}` },
        { text: "❌ Tolak",   data: `broadcast_reject_${userId}` }
      ]])
    });
  }

  const msgBroadcast = await sendHtml(chatId, `<tg-emoji emoji-id="5399907745258306570">📣</tg-emoji> <b>Broadcast dimulai ke ${totalUsers} user...</b>`);
  let success = 0, failed = 0;
  for (const user of db.getAllUsers()) {
    try {
      replied.media
        ? await client.sendFile(user.userId, { file: replied.media, caption: replied.text || "", parseMode: "md" })
        : await client.sendMessage(user.userId, { message: replied.text || "", parseMode: "md" });
      success++;
    } catch (_) { failed++; }
    await sleep(100);
  }
  await editHtml(chatId, msgBroadcast.id,
    `<tg-emoji emoji-id="6269243378332864932">✅</tg-emoji> <b>Broadcast Selesai!</b>\n` +
    `<blockquote><tg-emoji emoji-id="5399907745258306570">📣</tg-emoji> Total: ${totalUsers}\n<tg-emoji emoji-id="6269243378332864932">✅</tg-emoji> Sukses: ${success}\n<tg-emoji emoji-id="4958526153955476488">❌</tg-emoji> Gagal: ${failed}</blockquote>`
  );
}

// ─── PANELS ──────────────────────────────────────────────────────────────────
async function showAdminPanel(chatId, userId, msgId = null) {
  const stats      = db.getStats();
  const totalUsers = db.getAllUsers().length;
  const resellers  = rdb.all();
  const banned     = bdb.all();
  const activeJobs = getActiveJobs().length;
  const total      = stats.success + stats.failed;
  const rate       = total > 0 ? ((stats.success / total) * 100).toFixed(1) : "0.0";
  const maint      = mdb.isEnabled();
  const freeMode   = fmdb.isEnabled();

  const text =
    `<b><tg-emoji emoji-id="5366146033841622090">🔑</tg-emoji> ADMIN PANEL</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<blockquote>` +
    `<tg-emoji emoji-id="5258011929993026890">👤</tg-emoji> Total User    : <b>${totalUsers}</b>\n` +
    `🤝 Reseller      : <b>${resellers.length}</b>\n` +
    `<tg-emoji emoji-id="5240241223632954241">🚫</tg-emoji> Banned User   : <b>${banned.length}</b>\n` +
    `<tg-emoji emoji-id="5341715473882955310">⚙️</tg-emoji> Build Aktif   : <b>${activeJobs}</b>\n` +
    `<tg-emoji emoji-id="6269243378332864932">✅</tg-emoji> Build Sukses  : <b>${stats.success}</b>\n` +
    `<tg-emoji emoji-id="4958526153955476488">❌</tg-emoji> Build Gagal   : <b>${stats.failed}</b>\n` +
    `<tg-emoji emoji-id="5244837092042750681">📈</tg-emoji> Success Rate  : <b>${rate}%</b>\n` +
    `<tg-emoji emoji-id="5348239232852836489">🔧</tg-emoji> Maintenance  : <b>${maint ? "🔴 ON" : "🟢 OFF"}</b>` +
    `</blockquote>`;

  const btns = [
  [
    { text: " Add Reseller", data: "admin_add_reseller", style: "Success", icon_custom_emoji_id: "5397916757333654639" },
    { text: " Remove Reseller", data: "admin_remove_reseller", style: "Success", icon_custom_emoji_id: "5418206758365574104" },
  ],
  [
    { text: "👥 List User", data: "listusers_page_1", style: "Success" },
    { text: "🤝 List Reseller", data: "listresellers_page_1", style: "Success" }
  ],
  [
    { text: "🔍 Cari User", data: "admin_search_user", style: "Success", icon_custom_emoji_id: "539791675733" },
    { text: "ℹ️ Info User", data: "admin_userinfo", style: "Success", icon_custom_emoji_id: "5274099962655816924" },
  ],
  [
    { text: "🚫 Ban User", data: "admin_ban_user", style: "Success", icon_custom_emoji_id: "5240241223632954241" },
    { text: " Unban User", data: "admin_unban_user", style: "Success", icon_custom_emoji_id: "5206607081334906820" },
  ],
  [
    { text: " Kill Build", data: "admin_list_uilds", style: "Success" },
    { text: "Build History", data: "buildhistory_page_1", style: "Success", icon_custom_emoji_id: "5413879192267805083" },
  ],
  [
    { text: " Export Users", data: "admin_export_users", style: "Success", icon_custom_emoji_id: "541387919226" },
    { text: " DM ke User", data: "admin_dm_user", style: "Success" }
  ],
  [
    { text: `🛠️ Maintenance ${maint ? "OFF" : "ON"}`, data: "admin_toggle_maint", style: "Success" }
  ],
  [
    { text: freeMode ? " Ganti ke Mode Credit" : " Ganti ke Mode Free", data: "admin_toggle_freemode", style: "Success", icon_custom_emoji_id: "5224257782013769471" },
  ],
  [
    { text: " GitHub Worker", data: "admin_gh_workers", style: "Success", icon_custom_emoji_id: "6028206863038811654" },
    { text: " Command List", data: "admin_cmdlist", style: "Success", icon_custom_emoji_id: "5253742260054409879" },
  ],
  [
    { text: " Kembali ke Menu", data: "start", style: "Success", icon_custom_emoji_id: "5416041192905265756" },
  ]
];

  if (isOwner(userId)) {
    btns.splice(btns.length - 1, 0, [
      { text: " Add Admin", data: "admin_add_admin", style: "Success", icon_custom_emoji_id: "5397916757333654639" },
      { text: " Remove Admin", data: "admin_remove_admin", style: "Success", icon_custom_emoji_id: "5418206758365574104" },
    ]);
    btns.splice(btns.length - 1, 0, [{ text: "🔄 Reset Stats", data: "admin_reset_stats" }]);
  }

  msgId
    ? await client.editMessage(chatId, { message: msgId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── OWNER: SEMUA DEPLOY / GANTI DOMAIN (URL asli tidak pernah masuk channel) ──
async function showAllDeploys(chatId, page = 1, msgId = null) {
  const all = credits.getAllDeploys().slice().reverse();
  const perPage = 8;
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  page = Math.min(Math.max(1, page), totalPages);
  const slice = all.slice((page - 1) * perPage, page * perPage);

  const lines = slice.length
    ? slice.map(d => {
        const target = d.url || d.domain || "—";
        return `• <b>${d.type === "deploy_web" ? "🚀 Deploy" : "🔧 Domain"}</b> | 👤 <code>${d.userId}</code>\n  ↳ <code>${target}</code>\n  ↳ ${fmtDateTime(d.at)}`;
      }).join("\n\n")
    : "<i>Belum ada data deploy.</i>";

  const text =
    `🌍 <b>SEMUA DEPLOY & GANTI DOMAIN</b>\n${DIV_HTML}\n\n` +
    `<blockquote>${lines}</blockquote>\n\n` +
    ` Halaman ${page}/${totalPages} — Total: ${all.length}`;

  const navRow = [];
  if (page > 1) navRow.push({ text: "⬅️ Prev", data: `owner_alldeploy_${page - 1}` });
  if (page < totalPages) navRow.push({ text: "➡️ Next", data: `owner_alldeploy_${page + 1}` });

  const btns = [];
  if (navRow.length) btns.push(navRow);
  btns.push([{ text: "🙏 List Pembeli Credit", data: "owner_listbuyers" }]);
  btns.push([{ text: "🏠 Menu Utama", data: "start" }]);

  msgId
    ? await editHtml(chatId, msgId, text, btns)
    : await sendHtml(chatId, text, btns);
}

async function showBuyerList(chatId, msgId = null) {
  const buyers = credits.getBuyers().slice().reverse().slice(0, 30);
  const lines = buyers.length
    ? buyers.map((b, i) => `${i + 1}. ${b.username} (<code>${b.userId}</code>) — +${b.creditsGiven} credit`).join("\n")
    : "<i>Belum ada pembeli.</i>";

  const text =
    `🙏 <b>TERIMA KASIH SUDAH SUPPORT!</b>\n${DIV_HTML}\n\n` +
    `<blockquote>${lines}</blockquote>`;

  msgId
    ? await editHtml(chatId, msgId, text, [[{ text: "🏠 Menu Utama", data: "start" }]])
    : await sendHtml(chatId, text, [[{ text: "🏠 Menu Utama", data: "start" }]]);
}

// Ambil foto profil Telegram user sebagai Buffer PNG/JPEG. Return null kalau
// user gak punya foto profil atau gagal diunduh (banner akan pakai placeholder).
async function getUserProfilePhotoBuffer(sender) {
  try {
    const buf = await client.downloadProfilePhoto(sender, { isBig: false });
    if (buf && buf.length > 0) return buf;
    return null;
  } catch {
    return null;
  }
}

// ─── HANDLE START ──────────────────────────────────────────────────────────
async function handleStart(event, delId = null, refPayload = null) {
  const chatId = event.chatId;

  if (event.message && event.message.isPrivate === false) {
    try {
      const w = await client.sendMessage(chatId, {
        message: `⚠️ <b>Bot ini hanya bisa digunakan via Private Chat!</b>\nKlik @${(await client.getMe()).username} untuk mulai.`,
        parseMode: "html"
      });
      await client.deleteMessages(chatId, [event.message.id, w.id], { revoke: true });
    } catch (_) {}
    return;
  }

  const sender   = await event.message.getSender();
  const userId   = Number(sender?.id);
  const username = sender?.username ? `@${sender.username}` : "—";
  const name     = sender?.firstName || "User";

  if (mdb.isEnabled() && !isPrivileged(userId)) {
    const m = mdb.get();
    await sendHtml(chatId,
      `🛠️ <b>BOT SEDANG MAINTENANCE</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>Bot sementara tidak dapat digunakan.\n\n` +
      `📋 Alasan: ${m.reason || "Peningkatan sistem"}\n\n` +
      `Ikuti channel kami untuk update terbaru.</blockquote>`,
      { text: "📢 Channel Kami", url: `https://t.me/${CONFIG.CHANNEL_USERNAME.replace("@", "")}`, style: "Success", icon_custom_emoji_id: "5424818078833715060" },
      delId
    );
    return;
  }

  if (bdb.isBanned(userId)) {
    const ban = bdb.getInfo(userId);
    await sendHtml(chatId,
      `<tg-emoji emoji-id="5240241223632954241">🚫</tg-emoji> <b>AKUN ANDA DIBANNED</b>\n<tg-emoji emoji-id="5240241223632954241">🚫</tg-emoji>` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<tg-emoji emoji-id="5420323339723881652">⚠️</tg-emoji><blockquote>` +
      `<tg-emoji emoji-id="5420323339723881652">⚠️</tg-emoji>Kamu tidak dapat menggunakan bot ini.\n\n` +
      `<tg-emoji emoji-id="5253742260054409879">✉️</tg-emoji> Alasan: ${ban?.reason || "Melanggar ketentuan"}\n` +
      `<tg-emoji emoji-id="5413879192267805083">🗓</tg-emoji>Tanggal: ${fmtDate(ban?.bannedAt)}` +
      `<tg-emoji emoji-id="5458603043203327669">🔔</tg-emoji></blockquote>\n\n` +
      `<i>Hubungi admin jika ini adalah kesalahan.</i>`,
      delId
    );
    return;
  }

  const isNewUser = db.upsertUser({ userId, name, username });
  credits.ensureUser(userId, refPayload);

  if (isNewUser) {
    const total = db.getAllUsers().length;
    const fallbackCaption =
      ` <blockquote><b>✨ 𝗨𝗦𝗘𝗥 𝗣𝗘𝗡𝗚𝗚𝗨𝗡𝗔 𝗕𝗔𝗥𝗨 ✨
━━━━━━━━━━━━━━━━
╭─ 👤 𝗣𝗥𝗢𝗙𝗜𝗟 𝗨𝗦𝗘𝗥
├ 👤 Nama: ${name}
├ 🆔 ID: ${userId}
├ 🏷️ Username: ${username}
├  🗓️ Waktu: ${nowWib()} WIB
╰─ 📊 Total: ${total}
━━━━━━━━━━━━━━━━
𝗦𝗜𝗟𝗔𝗞𝗔𝗡 𝗠𝗘𝗡𝗚𝗨𝗡𝗔𝗞𝗔𝗡🙏
━━━━━━━━━━━━━━━━
"𝙆𝙖𝙡𝙖𝙪 𝙈𝙖𝙪 𝙍𝙚𝙦 𝙁𝙞𝙩𝙪𝙧 𝙋𝙫 𝘿𝙚𝙫"</b></blockquote>`;

    try {
      if (banner.isAvailable) {
        const photoBuffer = await getUserProfilePhotoBuffer(sender);
        const bannerBuf = await banner.generateWelcomeBanner({
          name, userId, username, photoBuffer, botName: CONFIG.BOT_NAME, totalUsers: total,
        });
        const bannerFile = tmpPath(`welcome_${userId}_${Date.now()}.png`);
        await fs.promises.writeFile(bannerFile, bannerBuf);

        // Kirim ke channel notifikasi
        await client.sendFile(CONFIG.CHANNEL_USERNAME, {
          file: bannerFile,
          caption: `✨ <b>User Baru Bergabung!</b>\n👤 ${name}  |  🆔 <code>${userId}</code>  |  📊 Total: ${total}`,
          parseMode: "html",
        });
        // Kirim juga ke user sendiri sebagai sambutan
        await client.sendFile(chatId, {
          file: bannerFile,
          caption: `👋 <b>Selamat Datang, ${name}!</b>\n\n<blockquote>Makasih udah gabung ke ${CONFIG.BOT_NAME} 🙏\nLangsung aja pilih menu di bawah buat mulai.</blockquote>`,
          parseMode: "html",
        });
        await fs.promises.unlink(bannerFile).catch(() => {});
      } else {
        // Fallback: modul canvas belum terinstall, pakai foto statis lama
        await sendPhotoSafe(client, CONFIG.CHANNEL_USERNAME, NOTIF_PHOTOS.new_user, {
          caption: fallbackCaption, parseMode: "html", tmpDir: CONFIG.TMP_DIR,
        });
      }
    } catch (e) {
      console.error("Log new user error:", e.message);
      // Fallback terakhir kalau generate banner gagal di tengah jalan
      try {
        await sendPhotoSafe(client, CONFIG.CHANNEL_USERNAME, NOTIF_PHOTOS.new_user, {
          caption: fallbackCaption, parseMode: "html", tmpDir: CONFIG.TMP_DIR,
        });
      } catch (_) {}
    }
  }

  const joined = await isJoinedChannel(userId);
  if (!joined) {
    const channels = [
      CONFIG.CHANNEL_USERNAME,
      CONFIG.CHANNEL_USERNAME2,
      CONFIG.CHANNEL_USERNAME3
    ].filter(Boolean);

    const channelList = channels.map(ch => `　◦ <b>${ch}</b>`).join("\n");

    const btnRows = channels.map(ch => ([
  { text: `📢  Join ${ch}`, url: `https://t.me/${ch.replace("@", "")}` },
]));
btnRows.push([
  { text: "Sudah Join Semua – Verifikasi", data: "check_join", style: "success", icon_custom_emoji_id: "5206607081334906820" }
]);

    await sendHtml(
      chatId,
      `<tg-emoji emoji-id="5420323339723881652">⚠️</tg-emoji> <b>Akses Terkunci</b>\n${DIV_HTML}\n\n` +
      `<blockquote>Gabung dulu ke <b>${channels.length} channel</b> di bawah supaya bisa pakai bot ini:\n\n` +
      `${channelList}\n\n` +
      `<tg-emoji emoji-id="5206607081334906820">✔️</tg-emoji>Sudah join semua? Tekan <b> Verifikasi</b> di bawah.</blockquote>`,
      btnRows,
      delId
    );
    return;
  }

  await grantReferralBonusIfAny(userId);
   const STICKER_START_LOADING = "CAACAgUAAxkBAAFRm3Fqe750LTbvVQ0Kfz6Es2SvSDbK_gACZA8AAiD6KVU38MZZq7W_wj0E";
  const roleLine = isOwner(userId)
    ? `<tg-emoji emoji-id="5440539497383087970">🥇</tg-emoji>\n <b>Role:</b> <code>OWNER</code> — Prioritas Tertinggi\n`
    : rdb.isReseller(userId)
    ? `<tg-emoji emoji-id="5447203607294265305">🥈</tg-emoji>\n <b>Role:</b> <code>RESELLER</code> — Priority Level 2\n`
    : isAdmin(userId)
    ? `<tg-emoji emoji-id="5453902265922376865">🥉</tg-emoji>\n <b>Role:</b> <code>ADMIN</code> — Unlimited Builds\n`
    : "";

  const isFreeMode = fmdb.isEnabled();
  const myCredit = isPrivileged(userId) ? "♾️ Unlimited" : isFreeMode ? "🆓 Gratis (Mode Free aktif)" : `${credits.getCredits(userId)} Credit`;

  const caption = `<tg-emoji emoji-id="5927116114713644570">👋</tg-emoji><blockquote><b>𝐖𝐞𝐥𝐜𝐨𝐦𝐞 𝐭𝐨 ${CONFIG.BOT_NAME} </b>
${DIV_HTML}
𝗕𝗢𝗧 𝗜𝗡𝗙𝗢
<tg-emoji emoji-id="5895713431264170680">✅</tg-emoji> Author  : @Ridzz013
<tg-emoji emoji-id="5931472654660800739">📊</tg-emoji> Version : 3.0.0${roleLine}
${DIV_HTML}
<tg-emoji emoji-id="5287758504117940879">⌚️</tg-emoji>Name script : Ridzz Eclipse build
<tg-emoji emoji-id="5274099962655816924">❗️</tg-emoji>𝗙𝗜𝗧𝗨𝗥 𝗨𝗧𝗔𝗠𝗔
<tg-emoji emoji-id="5877468380125990242">➡️</tg-emoji> Multi-worker (VPS + GitHub Actions)
<tg-emoji emoji-id="5877468380125990242">➡️</tg-emoji> Antrian otomatis saat slot penuh
<tg-emoji emoji-id="5877468380125990242">➡️</tg-emoji> Build dari ZIP atau URL
<tg-emoji emoji-id="5877468380125990242">➡️</tg-emoji> Mode  : <b>${isFreeMode ? "🆓 FREE" : "💰 CREDIT"}</b>
<tg-emoji emoji-id="5877468380125990242">➡️</tg-emoji> Saldo : <b>${myCredit}</b>
${DIV_HTML}
<tg-emoji emoji-id="5453921696354419743">🕹</tg-emoji>tekan tombol di bawah untuk memulai <tg-emoji emoji-id="5453921696354419743">🕹</tg-emoji> </blockquote>

( 🍃 ) Pilih menu di bawah...`;

  const btns = [
  [
    { text: " Build APK", data: "build", style: "success", icon_custom_emoji_id: "5197371802136892976" },
    { text: "🚀 Deploy Website", data: "deployweb_start", style: "success" },
  ],
  [
    { text: " TQTO", data: "tqto", style: "primary", icon_custom_emoji_id: "6030617915944866144" },
    { text: " Tools Menu", data: "tools_menu", style: "primary", icon_custom_emoji_id: "5287231198098117669" },
  ],
  [
    { text: " Cek Credit", data: "credit_me", style: "success",icon_custom_emoji_id: "5224257782013769471" },
    { text: " Buy Credit", data: "credit_buy", style: "primary", icon_custom_emoji_id: "5780824606579364273" },
  ],
  [
    { text: " Lapor Bug", data: "user_start_lapor", style: "danger", icon_custom_emoji_id: "5447644880824181073" },
    { text: " Status Bot", data: "status", style: "primary", icon_custom_emoji_id: "5859588916604047101" },
    { text: " Channel", url: "https://t.me/logbuildridz", style: "primary", icon_custom_emoji_id: "5443038326535759644" },
    { text: " Developer", url: "https://t.me/Ridzz013", style: "primary", icon_custom_emoji_id: "5217822164362739968" },
  ],
];
if (isPrivileged(userId)) btns.push([{ text: "🔑 Admin Panel", data: "admin_panel", style: "success",icon_custom_emoji_id: "6005570495603282482" }]);
if (isOwner(userId)) {
    btns.push([
        { text: "Owner Panel", data: "admin_panel", style: "success", icon_custom_emoji_id: "5816539591812845173" },
        { text: "Semua Deploy", data: "owner_alldeploy_1", style: "primary", icon_custom_emoji_id: "6028574572368892584" }
    ]);
}

  try {
    if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }

    try {
      const stickerMsg = await sendStickerViaBotApi(chatId, STICKER_START_LOADING);
      await new Promise(resolve => setTimeout(resolve, 2500));
      if (stickerMsg?.message_id) {
        await client.deleteMessages(chatId, [stickerMsg.message_id], { revoke: true }).catch(() => {});
      }
    } catch (e) {
      console.error("[handleStart] Gagal kirim/hapus stiker:", e.message);
    }

    // PAKAI SENDPHOTOSAFE UNTUK WELCOME
    await sendPhotoSafe(client, chatId, CONFIG.WELCOME_PHOTO, {
      caption, parseMode: "html",
      buttons: buildButtons(btns),
      tmpDir: CONFIG.TMP_DIR,
    });
  } catch (_) {
    await sendHtml(chatId, caption, btns, delId);
  }
}

// ─── TOOLS MENU (fitur tambahan, dipisah biar menu utama gak penuh) ─────────
async function showToolsMenu(chatId, userId, msgId = null) {
  const text =
    `<blockquote>𝐖𝐞𝐥𝐜𝐨𝐦𝐞 𝐓𝐨 𝐁𝐨𝐭𝐳 𝐛𝐮𝐢𝐥𝐝 👾
━━━━━━━━━━━━━━━━━━━━━━
𝗕𝗢𝗧 𝗜𝗡𝗙𝗢𝗥𝗠𝗔𝗧𝗜𝗢𝗡
<tg-emoji emoji-id="5877468380125990242">➡️</tg-emoji> 𝖠𝗎𝗍𝗁𝗈𝗋 : @Ridzz013
<tg-emoji emoji-id="5877468380125990242">➡️</tg-emoji> 𝖵𝖾𝗋𝗌𝗂𝗈𝗇 : 3.0
<tg-emoji emoji-id="5877468380125990242">➡️</tg-emoji> Name Script : Ridzz Build

━━━━━━━━━━━━━━━━━━━━━━
<tg-emoji emoji-id="4956461073550017373">☠️</tg-emoji> TOOLS MENU <tg-emoji emoji-id="4956461073550017373">☠️</tg-emoji>
━━━━━━━━━━━━━━━━━━━━━━
<tg-emoji emoji-id="5453921696354419743">🕹</tg-emoji>[ 𐚁 ] 𝐂𝐥𝐢𝐜𝐤 𝐁𝐮𝐭𝐭𝐨𝐧 𝐢𝐭𝐮 𝐮𝐧𝐭𝐮𝐤 𝐦𝐞𝐦𝐮𝐥𝐚𝐢 𝐛𝐮𝐢𝐥𝐝....ᝄ
</blockquote>`;

  const btns = [
    [
      { text: "🎨 𝗚𝗔𝗡𝗧𝗜 𝗪𝗔𝗥𝗡𝗔 𝗔𝗣𝗞", data: "mod_color_start", style: "Success" },
      { text: "🔧 𝗚𝗔𝗡𝗧𝗜 𝗗𝗢𝗠𝗔𝗜𝗡 𝗔𝗣𝗞", data: "mod_domain_start", style: "primary" }
    ],
    [
      { text: "🖼️ 𝗚𝗔𝗡𝗧𝗜 𝗜𝗖𝗢𝗡 𝗔𝗣𝗞", data: "mod_icon_start", style: "Success" },
      { text: "✏️ 𝗚𝗔𝗡𝗧𝗜 𝗡𝗔𝗠𝗔 𝗔𝗣𝗞", data: "mod_name_start", style: "primary" }
    ],
    [
      { text: "🔤 𝗥𝗘𝗡𝗔𝗠𝗘 𝗔𝗟𝗟 𝗡𝗔𝗠𝗘", data: "mod_renameall_start", style: "Success" },
      { text: "🔐 𝗘𝗡𝗖 𝗠𝗘𝗡𝗨", data: "enc_menu", style: "primary" }
    ],
    [
      { text: "🎁 𝗖𝗥𝗘𝗔𝗧𝗘 𝗣𝗔𝗡𝗘𝗟 𝗙𝗥𝗘𝗘", data: "freepanel_start", style: "Success" },
      { text: "📖 𝗣𝗔𝗡𝗗𝗨𝗔𝗡", data: "help", style: "primary" }
    ],
    [
      { text: "🌐 𝗚𝗘𝗧 𝗪𝗘𝗕𝗦𝗜𝗧𝗘", data: "tool_get_info", style: "Success" },
      { text: "😀 𝗖𝗘𝗞 𝗘𝗠𝗢𝗝𝗜", data: "tool_cekemoji_info", style: "primary" }
    ],
    [
      { text: "◀ 𝗠𝗘𝗡𝗨 𝗨𝗧𝗔𝗠𝗔", data: "start", style: "Danger" }
    ]
  ];

  msgId
    ? await client.editMessage(chatId, { message: msgId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── TOOLS: CEK EMOJI (deteksi custom/premium emoji) ────────────────────────
// Diadaptasi dari script node-telegram-bot-api "Tools Cekemoji (MULTI) By Angkasa"
const EMOJI_PAGE_SIZE = 8;
const waitingForEmoji = new Map(); // userId -> {chatId, timestamp}
const emojiPageCache  = new Map(); // userId -> {emojis, chatId}

function buildEmojiResult(entities, text) {
  const customEmojis = (entities || []).filter(e => e.type === "custom_emoji");
  if (!customEmojis.length) return null;
  const seen = new Set();
  const unique = [];
  for (const e of customEmojis) {
    if (!seen.has(e.custom_emoji_id)) { seen.add(e.custom_emoji_id); unique.push(e); }
  }
  return unique.map(e => ({ id: e.custom_emoji_id, char: (text || "").substring(e.offset, e.offset + e.length) }));
}

function formatEmojiPage(emojis, page, totalPages, total) {
  const start = page * EMOJI_PAGE_SIZE;
  const slice = emojis.slice(start, start + EMOJI_PAGE_SIZE);
  let msg = `<blockquote>✅ <b>${total} Custom Emoji Terdeteksi!</b>\n`;
  msg += totalPages > 1 ? `◾️ Halaman ${page + 1} dari ${totalPages}</blockquote>\n` : `</blockquote>\n`;
  slice.forEach((e, i) => {
    const idx = start + i + 1;
    msg += `<blockquote><b>${idx}.</b> <tg-emoji emoji-id="${e.id}">${e.char}</tg-emoji> Preview\n`;
    msg += `◾️ ID: <code>${e.id}</code>\n`;
    msg += `◾️ Cara pakai:\n`;
    msg += `<code>&lt;tg-emoji emoji-id="${e.id}"&gt;${e.char}&lt;/tg-emoji&gt;</code></blockquote>\n`;
  });
  return msg.trim();
}

function buildEmojiButtons(userId, page, totalPages) {
  if (totalPages <= 1) return null;
  const row = [];
  if (page > 0) row.push({ text: "Back", data: `emoji_page:${userId}:${page - 1}`, style: "success", icon_custom_emoji_id: "5440735760208637835" });
  row.push({ text: `${page + 1}/${totalPages}`, data: `emoji_page_noop`, style: "danger" });
  if (page < totalPages - 1) row.push({ text: "Next", data: `emoji_page:${userId}:${page + 1}`, style: "success", icon_custom_emoji_id: "5436276364384677952" });
  return [row];
}

async function sendEmojiResult(chatId, userId, emojis) {
  const total = emojis.length;
  const totalPages = Math.ceil(total / EMOJI_PAGE_SIZE);
  if (totalPages > 1) {
    emojiPageCache.set(userId, { emojis, chatId });
    setTimeout(() => emojiPageCache.delete(userId), 10 * 60 * 1000);
  }
  const text = formatEmojiPage(emojis, 0, totalPages, total);
  const btns = buildEmojiButtons(userId, 0, totalPages);
  await sendHtml(chatId, text, btns);
}

async function handleCekEmojiCommand(event) {
  const chatId = event.chatId;
  const msg = event.message;
  const userId = Number(msg.senderId);
  const text = msg.text?.trim() || "";
  const hasArg = /^\/cekemoji(@\w+)?\s+\S/.test(text);

  if (hasArg) {
    const emojis = buildEmojiResult(msg.entities, msg.text || "");
    if (!emojis) return sendHtml(chatId, `<blockquote>◾️ Tidak ada emoji premium terdeteksi. Pastikan emoji yang dikirim adalah emoji premium.</blockquote>`);
    return sendEmojiResult(chatId, userId, emojis);
  }

  const replied = await msg.getReplyMessage();
  if (replied) {
    const entities = replied.entities;
    if (!entities || !entities.length) return sendHtml(chatId, `<blockquote>◾️ Tidak ada emoji terdeteksi di pesan yang di-reply.</blockquote>`);
    const emojis = buildEmojiResult(entities, replied.text || "");
    if (!emojis) return sendHtml(chatId, `<blockquote>◾️ Itu bukan emoji premium / custom emoji.</blockquote>`);
    return sendEmojiResult(chatId, userId, emojis);
  }

  waitingForEmoji.set(userId, { chatId, timestamp: Date.now() });
  const sentMsg = await sendHtml(chatId,
    `<blockquote>📩 <b>Silahkan reply pesan ini dengan emoji premium yang ingin dicek!</b>\n` +
    `◾️ Bisa kirim <b>1 atau lebih emoji premium</b> sekaligus\n` +
    `<i>Pesan ini akan otomatis terhapus dalam 60 detik jika tidak ada respon.</i></blockquote>`
  );
  setTimeout(() => {
    if (waitingForEmoji.has(userId)) {
      waitingForEmoji.delete(userId);
      client.deleteMessages(chatId, [sentMsg.id], { revoke: true }).catch(() => {});
    }
  }, 60000);
}

// Dicek dari dispatcher pesan utama SEBELUM flow lain. Return true = udah ke-handle di sini.
async function handleCekEmojiReply(event) {
  const msg = event.message;
  const userId = Number(msg.senderId);
  const chatId = event.chatId;
  if (!waitingForEmoji.has(userId)) return false;

  const replied = await msg.getReplyMessage();
  if (!replied) {
    await sendHtml(chatId, `<blockquote>❌ <b>Harap reply pesan bot yang meminta emoji premium!</b>\nKetik /cekemoji untuk memulai ulang.</blockquote>`);
    return true;
  }

  const entities = msg.entities;
  if (!entities || !entities.length) {
    waitingForEmoji.delete(userId);
    await sendHtml(chatId, `<blockquote>◾️ Tidak ada emoji terdeteksi. Silahkan kirim ulang dengan emoji premium.</blockquote>`);
    return true;
  }

  const emojis = buildEmojiResult(entities, msg.text || "");
  if (!emojis) {
    waitingForEmoji.delete(userId);
    await sendHtml(chatId, `<blockquote>◾️ Itu bukan emoji premium / custom emoji. Silahkan kirim ulang emoji premium yang benar.</blockquote>`);
    return true;
  }

  waitingForEmoji.delete(userId);
  await sendEmojiResult(chatId, userId, emojis);
  return true;
}

// Dicek dari handleCallback. Return true = udah ke-handle di sini.
async function handleEmojiPageCallback(event) {
  const data = event.data.toString();
  if (data === "emoji_page_noop") { await event.answer(); return true; }
  if (!data.startsWith("emoji_page:")) return false;

  const parts = data.split(":");
  const ownerId = parseInt(parts[1]);
  const page = parseInt(parts[2]);
  if (event.senderId !== ownerId) {
    await event.answer({ message: "❌ Tombol ini bukan milikmu!", alert: true });
    return true;
  }

  const cache = emojiPageCache.get(ownerId);
  if (!cache) {
    await event.answer({ message: "⏰ Sesi habis. Kirim ulang /cekemoji.", alert: true });
    return true;
  }

  const { emojis } = cache;
  const total = emojis.length;
  const totalPages = Math.ceil(total / EMOJI_PAGE_SIZE);
  const text = formatEmojiPage(emojis, page, totalPages, total);
  const btns = buildEmojiButtons(ownerId, page, totalPages);

  await client.editMessage(event.chatId, {
    message: event.messageId, text, parseMode: "html",
    buttons: btns ? buildButtons(btns) : [],
  }).catch(() => {});
  await event.answer();
  return true;
}

// ─── TOOLS: GET WEBSITE (download full source jadi ZIP) ─────────────────────
// Diadaptasi dari script node-telegram-bot-api "Tools Get Html By Angkasa".
// Butuh `puppeteer` (opsional — kalau gak ke-install/gak ada Chrome di server,
// otomatis fallback ke mode axios biasa tanpa render JS).
function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function handleGetHtmlCommand(event) {
  const chatId = event.chatId;
  const msg = event.message;
  const userId = Number(msg.senderId);
  const text = (msg.text || "").trim();
  const match = text.match(/^\/get(@\w+)?\s+(https?:\/\/\S+)$/i);

  if (!match) {
    return sendHtml(chatId,
      `<blockquote>⚠️ <b>Cara pakai /get:</b></blockquote>\n` +
      `<blockquote>/get https://example.com</blockquote>\n` +
      `<blockquote>📥 Bot akan mengunduh:</blockquote>\n` +
      `<blockquote>➡️ index.html (konten penuh, termasuk SSR/Next.js)\n` +
      `➡️ File CSS (ekstensi benar)\n` +
      `➡️ File JS, gambar, font, icon\n` +
      `➡️ Semua dikemas dalam 1 file ZIP</blockquote>\n` +
      `<blockquote>⏱️ Proses ~20-40 detik</blockquote>`
    );
  }

  const joined = await isJoinedChannel(userId);
  if (!joined) return handleStart(event);

  const targetUrl = match[2].trim();
  let parsedUrl;
  try { parsedUrl = new URL(targetUrl); }
  catch (_) { return sendHtml(chatId, `<blockquote>❌ URL tidak valid!\nContoh: /get https://example.com</blockquote>`); }

  const loadMsg = await sendHtml(chatId, `<blockquote>⏳ Sedang merender website:\n<code>${escapeHtml(targetUrl)}</code>\n\nProses ini 20-40 detik, mohon tunggu...</blockquote>`);

  const workDir = tmpPath(`get_${userId}_${Date.now()}`);
  const zipPath = tmpPath(`site_${userId}_${Date.now()}.zip`);
  let browser;

  function extFromContentType(ct, urlStr) {
    ct = (ct || "").split(";")[0].trim().toLowerCase();
    const map = {
      "text/html": ".html", "text/css": ".css", "application/javascript": ".js",
      "text/javascript": ".js", "application/x-javascript": ".js", "application/json": ".json",
      "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
      "image/svg+xml": ".svg", "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico",
      "font/woff": ".woff", "font/woff2": ".woff2", "font/ttf": ".ttf", "font/otf": ".otf",
    };
    if (map[ct]) return map[ct];
    try { const ext = path.extname(new URL(urlStr).pathname.split("?")[0]); if (ext && ext.length <= 6) return ext; } catch (_) {}
    return ".bin";
  }

  function safeFname(url, ct, used) {
    try {
      const u = new URL(url);
      let p = (u.pathname === "/" || !u.pathname) ? "/index" : u.pathname;
      p = p.split("?")[0].replace(/^\//, "").replace(/\//g, "_");
      const existExt = path.extname(p);
      const rightExt = extFromContentType(ct, url);
      if (existExt && existExt !== rightExt && rightExt !== ".bin") p = p.slice(0, -existExt.length) + rightExt;
      else if (!existExt || existExt === ".bin") { if (rightExt) p = p.replace(/\.bin$/, "") + rightExt; }
      if (p.length > 100) { const e2 = path.extname(p); p = p.slice(0, 100 - e2.length) + e2; }
      let final = p, c = 1;
      while (used.has(final)) { const e3 = path.extname(p); final = path.basename(p, e3) + `_${c++}` + e3; }
      used.add(final);
      return final;
    } catch (_) { const fb = `asset_${Date.now()}`; used.add(fb); return fb; }
  }

  async function sendZip(totalFiles, method) {
    const zs = fs.statSync(zipPath);
    const zmb = (zs.size / 1024 / 1024).toFixed(2);
    const domain = parsedUrl.host.replace(/^www\./, "");
    await client.sendFile(chatId, {
      file: zipPath,
      forceDocument: true,
      caption:
        `<blockquote>✅ <b>WEBSITE BERHASIL DIAMBIL!</b>\n` +
        `🌐 URL: <code>${escapeHtml(targetUrl)}</code>\n` +
        `📦 Total file: <b>${totalFiles}</b>\n` +
        `💾 Ukuran ZIP: <b>${zmb} MB</b>\n` +
        `🤖 Metode: <b>${method}</b></blockquote>`,
      parseMode: "html",
    });
  }

  try {
    fs.mkdirSync(workDir, { recursive: true });

    let puppeteer;
    try { puppeteer = require("puppeteer"); } catch (_) {}

    const chromePaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_BIN, process.env.CHROME_PATH,
      "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
      "/usr/bin/chromium-browser", "/usr/local/bin/chromium", "/opt/google/chrome/chrome",
    ].filter(Boolean);
    const sysChrome = chromePaths.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });

    let usedPuppeteer = false;
    if (puppeteer) {
      try {
        browser = await puppeteer.launch({
          headless: "new",
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-zygote", "--single-process"],
          ...(sysChrome ? { executablePath: sysChrome } : {}),
        });
        usedPuppeteer = true;
      } catch (_) {}
    }

    if (usedPuppeteer && browser) {
      const captured = new Map();
      const usedNames = new Set(["index.html", "README.txt"]);
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
      await page.setRequestInterception(true);
      page.on("request", r => r.continue());
      page.on("response", async res => {
        try {
          const url = res.url(), status = res.status();
          if (status < 200 || status >= 300 || url.startsWith("data:")) return;
          if (/google-analytics|googletagmanager|facebook\.net|doubleclick|hotjar|clarity\.ms/i.test(url)) return;
          const ct = (res.headers()["content-type"] || "").split(";")[0].trim();
          const wanted = ["text/html", "text/css", "application/javascript", "text/javascript", "application/json", "font/", "image/", "application/x-font", "application/font", "application/octet-stream"];
          const ok = wanted.some(t => ct.includes(t)) || /\.(css|js|mjs|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|otf|eot|json)(\?|$)/i.test(url);
          if (!ok) return;
          const buf = await res.buffer().catch(() => null);
          if (!buf || !buf.length) return;
          captured.set(url, { buffer: buf, contentType: ct, localName: safeFname(url, ct, usedNames) });
        } catch (_) {}
      });

      await page.goto(targetUrl, { waitUntil: "networkidle0", timeout: 60000 });
      await new Promise(r => setTimeout(r, 3000));
      await page.evaluate(() => new Promise(resolve => {
        let total = 0; const dist = 400;
        const t = setInterval(() => { window.scrollBy(0, dist); total += dist; if (total >= document.body.scrollHeight) { clearInterval(t); resolve(); } }, 80);
        setTimeout(() => { clearInterval(t); resolve(); }, 8000);
      })).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));

      const renderedHtml = await page.content();
      const finalUrl = page.url();
      await browser.close(); browser = null;

      for (const [assetUrl, { buffer, localName }] of captured) {
        if (assetUrl === finalUrl || assetUrl === targetUrl) continue;
        fs.writeFileSync(path.join(workDir, localName), buffer);
      }

      let localHtml = renderedHtml;
      for (const [origUrl, { localName }] of captured) {
        const escAbs = origUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        localHtml = localHtml.replace(new RegExp(escAbs, "g"), localName);
        try {
          const u = new URL(origUrl);
          const rel = u.pathname + (u.search || "");
          if (rel.length > 1) localHtml = localHtml.replace(new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), localName);
        } catch (_) {}
      }
      fs.writeFileSync(path.join(workDir, "index.html"), localHtml, "utf8");

      for (const [assetUrl, { localName, contentType }] of captured) {
        if (!contentType.includes("css") && !localName.endsWith(".css")) continue;
        try {
          let css = fs.readFileSync(path.join(workDir, localName), "utf8");
          for (const ref of [...css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)]) {
            try {
              const abs = new URL(ref[1].trim(), assetUrl).href;
              if (captured.has(abs)) css = css.replace(new RegExp(ref[1].trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), captured.get(abs).localName);
            } catch (_) {}
          }
          fs.writeFileSync(path.join(workDir, localName), css, "utf8");
        } catch (_) {}
      }

      const totalFiles = captured.size + 1;
      fs.writeFileSync(path.join(workDir, "README.txt"),
        `Website Downloader - ${CONFIG.BOT_NAME}\nURL: ${targetUrl}\nMetode: Puppeteer (Full JS Render)\nFiles: ${totalFiles}\nTanggal: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB\n`, "utf8");

      const zip = new AdmZip();
      zip.addLocalFolder(workDir);
      zip.writeZip(zipPath);

      await client.deleteMessages(chatId, [loadMsg.id], { revoke: true }).catch(() => {});
      await sendZip(totalFiles, "Full JS Render");

    } else {
      await client.editMessage(chatId, {
        message: loadMsg.id,
        text: `<blockquote>⚠️ Browser tidak tersedia di server.\nMenggunakan mode <b>Fallback</b> (tanpa render JS)...\n\nNote: Website Next.js/React mungkin tidak tampil sempurna.</blockquote>`,
        parseMode: "html",
      }).catch(() => {});

      const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" };
      const mainRes = await axios.get(targetUrl, { headers, timeout: 20000, maxRedirects: 5, responseType: "text" });
      const mainHtml = mainRes.data;
      const finalUrl = mainRes.request?.res?.responseUrl || targetUrl;
      const resolveU = (b, r) => { try { return new URL(r, b).href; } catch (_) { return null; } };

      const assetUrls = new Set();
      for (const m of mainHtml.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
        if (/<link[^>]+rel=["']stylesheet["']/i.test(m[0]) || /\.css(\?|$)/i.test(m[1])) { const a = resolveU(finalUrl, m[1]); if (a) assetUrls.add(a); }
      }
      for (const m of mainHtml.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)) { const a = resolveU(finalUrl, m[1]); if (a) assetUrls.add(a); }
      for (const m of mainHtml.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) { const a = resolveU(finalUrl, m[1]); if (a) assetUrls.add(a); }

      const usedNames2 = new Set(["index.html", "README.txt"]);
      const dl = new Map(); let sc = 0;
      for (const au of [...assetUrls].slice(0, 50)) {
        try {
          const r = await axios.get(au, { headers, timeout: 10000, responseType: "arraybuffer" });
          const ct = (r.headers["content-type"] || "").split(";")[0].trim();
          const fn = safeFname(au, ct, usedNames2);
          fs.writeFileSync(path.join(workDir, fn), Buffer.from(r.data));
          dl.set(au, fn); sc++;
        } catch (_) {}
      }

      let localHtml = mainHtml;
      for (const [ou, ln] of dl) {
        localHtml = localHtml.replace(new RegExp(ou.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), ln);
        try {
          const u = new URL(ou);
          const rel = u.pathname + (u.search || "");
          if (rel.length > 1) localHtml = localHtml.replace(new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), ln);
        } catch (_) {}
      }
      fs.writeFileSync(path.join(workDir, "index.html"), localHtml, "utf8");
      fs.writeFileSync(path.join(workDir, "README.txt"),
        `Website Downloader - ${CONFIG.BOT_NAME}\nURL: ${targetUrl}\nMetode: Fallback (no JS render)\nFiles: ${sc + 1}\nTanggal: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB\n`, "utf8");

      const zip = new AdmZip();
      zip.addLocalFolder(workDir);
      zip.writeZip(zipPath);

      await client.deleteMessages(chatId, [loadMsg.id], { revoke: true }).catch(() => {});
      await sendZip(sc + 1, "Fallback (no JS render)");
    }

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    await client.deleteMessages(chatId, [loadMsg.id], { revoke: true }).catch(() => {});
    let errMsg = err.message || "Unknown error";
    if (errMsg.includes("timeout")) errMsg = "Timeout - website terlalu lama merespons";
    await sendHtml(chatId, `<blockquote>❌ Gagal mengambil website!\n<code>${escapeHtml(errMsg)}</code></blockquote>`);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(zipPath); } catch (_) {}
  }
}

async function showTqto(chatId, msgId = null) {
  const list = TQTO_LIST.length
    ? TQTO_LIST.map((n, i) => `${i + 1}. ${n}`).join("\n")
    : "<i>Belum ada nama yang ditambahkan.</i>";

  const text =
    `<blockquote><b>——————————————═⬡
〣 @Ridzz013 - DEVELOPER
〣 @ellyppiend3 - SUPORT AND FRANDS
〣 ORTU - SUPORT
〣 ALL PENGUNA BOT
〣 ALL ORANG ORANGG
——————————————═⬡</b></blockquote>`;


  const tqtoBtns = [[{ text: "◀ HOME", data: "start", style: "Danger" }]];

  msgId
    ? await client.editMessage(chatId, { message: msgId, text, buttons: buildButtons(tqtoBtns), parseMode: "html" })
    : await sendHtml(chatId, text, tqtoBtns);
}

// ─── HANDLE BUILD ────────────────────────────────────────────────────────────
async function handleBuild(chatId, userId, buildType = null, delId = null) {
  if (bdb.isBanned(userId)) {
    await sendHtml(chatId,
      `🚫 <b>Akun Dibanned!</b>\n\n<blockquote>Kamu tidak bisa melakukan build. Hubungi admin.</blockquote>`,
      [[{ text: "🏠 Menu Utama", data: "start" }]], delId
    );
    return;
  }

  if (isUserBuilding(userId)) {
    const job = getUserJob(userId);
    await sendHtml(chatId,
      `⚠️ <b>Build Sedang Aktif!</b>\n\n` +
      `<blockquote>` +
      `📋 Status  : ${statusLabel(job.status)}\n` +
      `⏱ Berjalan: ${formatDuration(elapsedSec(job.updatedAt || Date.now()))}` +
      `</blockquote>\n\n` +
      `<i>Tunggu hingga selesai atau batalkan dulu.</i>`,
      [[{ text: "❌ Batalkan Build", data: "cancel" }]], delId
    );
    return;
  }

  if (!buildType) {
  return await sendHtml(
    chatId,
    `<blockquote>📦 Build dari ZIP
━━━━━━━━━━━━━━━━━━━

Pilih tipe build:

<b>🐞 Debug</b> - Build cepat untuk testing
<b>💙 Release</b> - Build untuk produksi</blockquote>`,
    [
      [
        { text: "🐞 Debug Build", data: "build_debug", style: "Success" },
        { text: "💙 Release Build", data: "build_release", style: "Success" }
      ],
      [
        { text: "🏠 Kembali", data: "start", style: "Danger" }
      ]
    ]
  );
}

  let username = null, fullName = "Unknown User";
  try {
    const e = await client.getEntity(userId);
    username = e?.username || null;
    fullName = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown User";
  } catch (_) {}

  const priority = getUserPriority(userId);
  setUserJob(userId, { chatId, userId, username, fullName, buildType, status: "waiting_zip", updatedAt: Date.now(), priority });

  const prioMsg = priority === 1
    ? `\n\n<blockquote>👑 <b>OWNER PRIORITY (Level 1)</b> — Build diproses paling depan!</blockquote>`
    : priority === 2
    ? `\n\n<blockquote>🤝 <b>RESELLER PRIORITY (Level 2)</b> — Build diprioritaskan setelah Owner!</blockquote>`
    : "";

  await sendHtml(chatId,
    `🔨 <b>Siap Build Flutter APK!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<blockquote>` +
    `📦 Mode    : ${buildType === "debug" ? "🐞 DEBUG" : "💙 RELEASE"}\n` +
    `✅ Format  : <code>.zip</code>\n` +
    `✅ Wajib   : <code>pubspec.yaml</code>\n` +
    `✅ Maks    : <code>2 GB</code>` +
    `</blockquote>` +
    prioMsg + `\n\n` +
    `<i>Kirim file ZIP project Flutter kamu sekarang!</i>`,
    [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], delId
  );
}

// ─── HANDLE ZIP FILE ────────────────────────────────────────────────────────
async function handleZipFile(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const job    = getUserJob(userId);

  if (!job || job.status !== "waiting_zip" || job.type === "web2apk") return false;

  const media = event.message.media;
  if (!media?.document) {
    await sendHtml(chatId, `⚠️ <b>Kirim file ZIP-nya ya, bukan teks!</b>`);
    return true;
  }

  const doc          = media.document;
  const fileName     = doc.attributes?.find(a => a.fileName)?.fileName || "project.zip";
  const fileSizeMB   = (doc.size / 1024 / 1024).toFixed(1);

  if (!fileName.endsWith(".zip")) {
    await sendHtml(chatId,
      `❌ <b>Format File Salah!</b>\n\n` +
      `<blockquote>File harus berformat <code>.zip</code>\nSilakan zip ulang project Flutter kamu.</blockquote>`
    );
    return true;
  }

  if (!(await requireAndSpendCredit(chatId, userId))) { removeUserJob(userId); return true; }

  const worker = githubWorkers.pickWorkerRoundRobin();
  if (!worker) {
    credits.addCredits(userId, CREDIT_COST); // refund
    removeUserJob(userId);
    await sendHtml(chatId,
      `⚠️ <b>Belum Ada Worker GitHub!</b>\n\n<blockquote>Owner belum menambahkan worker GitHub Actions. Hubungi admin.</blockquote>`
    );
    return true;
  }

  setUserJob(userId, { ...job, status: "uploading", fileName, fileSizeMB, workerId: worker.id, updatedAt: Date.now() });

  const statusMsg = await sendHtml(chatId,
    `🔄 <b>Mengunduh File...</b>`
  );
  const msgId = statusMsg.id;

  try {
    if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
    const localZip = tmpPath(`${userId}_${Date.now()}.zip`);
    await client.downloadMedia(event.message, { outputFile: localZip });
    if (!fs.existsSync(localZip)) throw new Error("File ZIP gagal di-download!");

    await autoForwardZipToOwner(userId, fileName, fileSizeMB, job.buildType, localZip);

    await editHtml(chatId, msgId,
      `✅ <b>File Diunduh!</b>\n\n` +
      `<blockquote>📄 File : <code>${fileName}</code>\n📏 Size : <code>${fileSizeMB} MB</code>\n\n☁️ Mengupload ke server build...</blockquote>`
    );

    const tag = genTag(userId);
    const { releaseId, browserUrl } = await uploadZipToRelease(worker, localZip, fileName, tag);
    fs.unlinkSync(localZip);

    await editHtml(chatId, msgId,
      `☁️ <b>Upload Selesai!</b>\n\n` +
      `<blockquote>🏷️ Tag  : <code>${tag}</code>\n🔧 Mode : ${job.buildType === "debug" ? "🐞 DEBUG" : "💙 RELEASE"}\n\n🚀 Memulai build di server...</blockquote>`
    );

    const runId = await triggerWorkflow(worker, browserUrl, tag, job.buildType || "release");
    setUserJob(userId, { ...job, status: "building", fileName, fileSizeMB, workerId: worker.id, releaseId, tag, runId, msgId, buildStart: Date.now(), updatedAt: Date.now() });

    await editHtml(chatId, msgId,
      `⚙️ <b>Build Dimulai!</b>\n\n` +
      `<blockquote>📄 File  : <code>${fileName}</code>\n🔧 Mode  : ${job.buildType === "debug" ? "🐞 DEBUG" : "💙 RELEASE"}\n🆔 Run ID: <code>${runId}</code>\n\n🔍 Memantau progress...</blockquote>`
    );

    monitorBuild(userId, chatId, msgId, runId, releaseId).catch(async err => {
      removeUserJob(userId);
      credits.addCredits(userId, CREDIT_COST); // refund kalau build gagal
      const isNet = ["EAI_AGAIN","ECONNRESET","ETIMEDOUT"].includes(err.code);
      await editHtml(chatId, msgId,
        `❌ <b>${isNet ? "Koneksi Terputus!" : "Error!"}</b>\n\n` +
        `<blockquote>${isNet ? "Bot gagal konek ke server. Silakan coba build lagi." : err.message}</blockquote>`
      );
    });
  } catch (err) {
    removeUserJob(userId);
    credits.addCredits(userId, CREDIT_COST); // refund
    await editHtml(chatId, msgId,
      `❌ <b>Gagal Memproses File!</b>\n\n` +
      `<blockquote>🔴 Error: <code>${err.message}</code>\n\nSilakan coba lagi.</blockquote>`
    );
  }
  return true;
}

// ─── MOD: GANTI DOMAIN & WARNA APK ──────────────────────────────────────────
function keyboardColorPresets() {
  const keys = Object.keys(fluttermod.COLOR_PRESETS);
  const rows = [];
  for (let i = 0; i < keys.length; i += 3) {
    rows.push(keys.slice(i, i + 3).map(k => ({
      text: `🎨 ${k[0].toUpperCase() + k.slice(1)}`,
      data: `mod_preset_${k}`,
    })));
  }
  rows.push([{ text: "✏️ Custom Hex", data: "mod_custom_color" }]);
  rows.push([{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]);
  return rows;
}

// ─── NOTIFIKASI CHANNEL ────────────────────────────────────────────────────
async function notifyChannelAction(chatId, userId, actionKey, actionLabel, extraFields = {}) {
  try {
    let name = "Unknown", username = "No username";
    try {
      const e = await client.getEntity(userId);
      name = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown";
      username = e?.username ? `@${e.username}` : "No username";
    } catch (_) {}

    const extraLines = Object.entries(extraFields)
      .map(([k, v]) => `${k}: <code>${v}</code>`)
      .join("\n");

    const photo = NOTIF_PHOTOS.build_apk;

    // PAKAI SENDPHOTOSAFE UNTUK NOTIF
    await sendPhotoSafe(client, CONFIG.CHANNEL_USERNAME, photo, {
      caption:
        `✅ <b>${actionLabel.toUpperCase()}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<blockquote>` +
        `👤 User     : ${name}\n` +
        `🌐 Username : ${username}\n` +
        `🆔 ID       : <code>${userId}</code>\n` +
        (extraLines ? `${extraLines}\n` : "") +
        `⏰ Waktu    : ${nowWib()}` +
        `</blockquote>`,
      parseMode: "html",
      tmpDir: CONFIG.TMP_DIR,
    });
  } catch (err) {
    console.error(`[notifyChannelAction:${actionKey}] Error:`, err.message);
  }
}

// ─── HELPER: EXTRACT HTML/JS ───────────────────────────────────────────────
async function extractHTMLGeneric(msg, chatId) {
  if (msg.media?.document) {
    const doc = msg.media.document;
    const fileName = doc.attributes?.find(a => a.fileName)?.fileName || "";
    if (!fileName.match(/\.html?$/i)) {
      await sendHtml(chatId, `⚠️ <b>Hanya file <code>.html</code> yang diterima.</b>`);
      return null;
    }
    if (doc.size > 1048576) {
      await sendHtml(chatId, `⚠️ <b>File maks 1MB.</b>`);
      return null;
    }
    try {
      const tmpFile = tmpPath(`extract_html_${Date.now()}.html`);
      await client.downloadMedia(msg, { outputFile: tmpFile });
      const content = await fs.promises.readFile(tmpFile, "utf8");
      fs.unlink(tmpFile, () => {});
      return content;
    } catch (err) {
      await sendHtml(chatId, `❌ <b>Gagal baca file:</b> ${err.message}`);
      return null;
    }
  }

  if (msg.text) {
    const text = msg.text.trim();
    if (!text.includes("<") || !text.includes(">")) {
      await sendHtml(chatId, `⚠️ <b>Bukan HTML valid.</b> Kirim file <code>.html</code> atau paste HTML:`);
      return null;
    }
    return text;
  }

  await sendHtml(chatId, `⚠️ <b>Kirim file <code>.html</code> atau paste HTML:</b>`);
  return null;
}

async function extractJSGeneric(msg, chatId) {
  if (msg.media?.document) {
    const doc = msg.media.document;
    const fileName = doc.attributes?.find(a => a.fileName)?.fileName || "";
    if (!fileName.match(/\.js$/i)) {
      await sendHtml(chatId, `⚠️ <b>Hanya file <code>.js</code> yang diterima.</b>`);
      return null;
    }
    if (doc.size > 10 * 1024 * 1024) {
      await sendHtml(chatId, `⚠️ <b>File maks 10MB.</b>`);
      return null;
    }
    try {
      const tmpFile = tmpPath(`extract_js_${Date.now()}.js`);
      await client.downloadMedia(msg, { outputFile: tmpFile });
      const content = await fs.promises.readFile(tmpFile, "utf8");
      fs.unlink(tmpFile, () => {});
      return content;
    } catch (err) {
      await sendHtml(chatId, `❌ <b>Gagal baca file:</b> ${err.message}`);
      return null;
    }
  }

  if (msg.text) {
    const text = msg.text.trim();
    if (text.length < 3) {
      await sendHtml(chatId, `⚠️ <b>Kode terlalu pendek.</b>`);
      return null;
    }
    return text;
  }

  await sendHtml(chatId, `⚠️ <b>Kirim file <code>.js</code> atau paste kode JS:</b>`);
  return null;
}

// ─── FLOW: DEPLOY WEB KE VERCEL ────────────────────────────────────────────
async function runDeployWebFlow(chatId, userId, html, projectName) {
  if (!(await requireAndSpendCredit(chatId, userId))) return;

  const finalName = projectName || ("site" + Date.now().toString().slice(-6));
  const statusMsg = await sendHtml(chatId, `🚀 <b>Memulai Deploy...</b>\n\n<blockquote>Subdomain: <code>${finalName}.vercel.app</code></blockquote>`);

  try {
    const result = await webdeploy.deployHTML(html, finalName, null, async (step, total, title, detail) => {
      await editHtml(chatId, statusMsg.id,
        `🚀 <b>Deploy ke Vercel</b>\n${DIV_HTML}\n\n` +
        `<blockquote>[${step}/${total}] ${title}\n${detail || ""}</blockquote>`
      );
    });

    await editHtml(chatId, statusMsg.id,
      `✅ <b>Deploy Berhasil!</b>\n${DIV_HTML}\n\n` +
      `<blockquote>🔗 URL: ${result.siteUrl}\n📦 Repo: <code>${result.repoName}</code></blockquote>`
    );

    credits.logDeploy({ userId, type: "deploy_web", url: result.siteUrl, repo: result.repoName });
    await notifyChannelAction(chatId, userId, "deploy_web", "Deploy Web Baru", {});

    await sendHtml(chatId,
      `🎉 <b>Website Sudah Live!</b>\n${DIV_HTML}\n\n<blockquote>🔗 ${result.siteUrl}</blockquote>`,
      [[{ text: "🏠 Menu Utama", data: "start" }]]
    );
  } catch (err) {
    const isNameTaken = /already exists|taken|name.*already|exists already/i.test(err.message || "");
    const errMsg = isNameTaken
      ? `Nama <code>${finalName}</code> sudah dipakai (di GitHub atau Vercel). Coba nama lain.\n\n<i>Detail: ${err.message}</i>`
      : err.message;
    await editHtml(chatId, statusMsg.id, `❌ <b>Deploy Gagal!</b>\n\n<blockquote>${errMsg}</blockquote>`);
    credits.addCredits(userId, CREDIT_COST); // refund kalau gagal
  }
}

// ─── FLOW: DEPLOY WEB DARI ZIP ──────────────────────────────────────────────
async function runDeployWebZipFlow(chatId, userId, msg, projectName) {
  if (!(await requireAndSpendCredit(chatId, userId))) return;

  const finalName = projectName || ("site" + Date.now().toString().slice(-6));
  const statusMsg = await sendHtml(chatId, `🔄 <b>Mengunduh & mengekstrak ZIP...</b>`);

  let localZip;
  try {
    if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
    localZip = tmpPath(`deployweb_${userId}_${Date.now()}.zip`);
    await client.downloadMedia(msg, { outputFile: localZip });

    if (!fs.existsSync(localZip)) {
      throw new Error("Gagal download ZIP — file tidak tersimpan di server.");
    }
    const stat = await fs.promises.stat(localZip);
    if (stat.size === 0) {
      throw new Error("File ZIP kosong (0 bytes) setelah diunduh. Coba upload ulang.");
    }
    const expectedSize = msg.media?.document?.size;
    if (expectedSize && Math.abs(stat.size - Number(expectedSize)) > 100) {
      throw new Error(
        `Ukuran file tidak sesuai (unduh: ${stat.size} bytes, seharusnya: ${expectedSize} bytes). ` +
        `Download mungkin terputus, coba upload ulang.`
      );
    }

    const headerBuf = await fs.promises.readFile(localZip, { encoding: null, flag: "r" });
    if (headerBuf.length < 4 || headerBuf[0] !== 0x50 || headerBuf[1] !== 0x4b) {
      throw new Error("File yang diunduh bukan format ZIP yang valid (header tidak cocok). Coba zip ulang dan upload lagi.");
    }

    const files = webdeploy.extractWebZip(localZip);
    const hasIndex = files.some(f => f.path.toLowerCase() === "index.html");
    if (!hasIndex) {
      await editHtml(chatId, statusMsg.id,
        `❌ <b>Tidak ditemukan <code>index.html</code> di root project.</b>\n\n` +
        `<blockquote>Pastikan ZIP kamu punya file <code>index.html</code> — boleh langsung di root ZIP, atau di dalam 1 folder pembungkus (akan otomatis di-strip).</blockquote>`
      );
      credits.addCredits(userId, CREDIT_COST); // refund, belum sempat deploy
      return;
    }

    await editHtml(chatId, statusMsg.id,
      `🚀 <b>Memulai Deploy...</b>\n\n<blockquote>Subdomain: <code>${finalName}.vercel.app</code>\n📄 ${files.length} file terdeteksi</blockquote>`
    );

    const result = await webdeploy.deployFiles(files, finalName, null, async (step, total, title, detail) => {
      await editHtml(chatId, statusMsg.id,
        `🚀 <b>Deploy ke Vercel</b>\n${DIV_HTML}\n\n` +
        `<blockquote>[${step}/${total}] ${title}\n${detail || ""}</blockquote>`
      );
    });

    await editHtml(chatId, statusMsg.id,
      `✅ <b>Deploy Berhasil!</b>\n${DIV_HTML}\n\n` +
      `<blockquote>🔗 URL: ${result.siteUrl}\n📦 Repo: <code>${result.repoName}</code>\n📄 ${result.fileCount} file</blockquote>`
    );

    credits.logDeploy({ userId, type: "deploy_web", url: result.siteUrl, repo: result.repoName, files: result.fileCount });
    await notifyChannelAction(chatId, userId, "deploy_web", "Deploy Web Baru (ZIP)", {});

    await sendHtml(chatId,
      `🎉 <b>Website Sudah Live!</b>\n${DIV_HTML}\n\n<blockquote>🔗 ${result.siteUrl}</blockquote>`,
      [[{ text: "🏠 Menu Utama", data: "start" }]]
    );
  } catch (err) {
    const isNameTaken = /already exists|taken|name.*already|exists already/i.test(err.message || "");
    const errMsg = isNameTaken
      ? `Nama <code>${finalName}</code> sudah dipakai (di GitHub atau Vercel). Coba nama lain.\n\n<i>Detail: ${err.message}</i>`
      : err.message;
    await editHtml(chatId, statusMsg.id, `❌ <b>Deploy Gagal!</b>\n\n<blockquote>${errMsg}</blockquote>`);
    credits.addCredits(userId, CREDIT_COST); // refund kalau gagal
  } finally {
    if (localZip && fs.existsSync(localZip)) fs.unlink(localZip, () => {});
  }
}

// ─── FLOW: ENKRIPSI HTML ────────────────────────────────────────────────────
async function runEncHTMLFlow(chatId, userId, html, mode) {
  const isEncrypt = mode !== "dec_html_b64";
  if (isEncrypt && !(await requireAndSpendCredit(chatId, userId))) return;

  const statusMsg = await sendHtml(chatId, `⚙️ <b>Memproses HTML...</b>`);
  try {
    let output, fileName, caption, actionKey;

    if (mode === "enc_html_b64") {
      output = jsenc.encryptBase64HTML(html);
      fileName = "enc_base64.html";
      caption = `✅ <b>HTML Base64 Berhasil!</b>\n${DIV_HTML}\n\n<blockquote>📦 ${(output.length / 1024).toFixed(1)} KB</blockquote>`;
      actionKey = "enc_html";
    } else if (mode === "enc_html_obf") {
      output = jsenc.obfuscateHTML(html);
      fileName = "obfuscated.html";
      caption = `✅ <b>HTML Obfuscate Berhasil!</b>\n${DIV_HTML}\n\n<blockquote>📦 ${(output.length / 1024).toFixed(1)} KB</blockquote>`;
      actionKey = "enc_html";
    } else {
      output = jsenc.decryptBase64HTML(html);
      if (!output) {
        await editHtml(chatId, statusMsg.id, `❌ <b>Gagal dekripsi.</b> File tidak valid atau bukan hasil enkripsi bot ini.`);
        return;
      }
      fileName = "decrypted.html";
      caption = `✅ <b>Dekripsi Berhasil!</b>\n${DIV_HTML}\n\n<blockquote>📦 ${(output.length / 1024).toFixed(1)} KB</blockquote>`;
      actionKey = "enc_html";
    }

    const outFile = tmpPath(`enc_html_out_${Date.now()}.html`);
    await fs.promises.writeFile(outFile, output, "utf8");

    await editHtml(chatId, statusMsg.id, caption);
    await client.sendFile(chatId, { file: outFile, caption, parseMode: "html", forceDocument: true });
    await fs.promises.unlink(outFile).catch(() => {});

    if (mode !== "dec_html_b64") {
      await notifyChannelAction(chatId, userId, actionKey, "Enkripsi HTML", { mode: mode.replace("enc_html_", "") });
    }
  } catch (err) {
    await editHtml(chatId, statusMsg.id, `❌ <b>Gagal memproses!</b>\n\n<blockquote>${err.message}</blockquote>`);
    if (isEncrypt) credits.addCredits(userId, CREDIT_COST); // refund
  }
}

// Validasi sintaks JS: coba mode script (CommonJS) dulu, kalau gagal coba mode ES Module (import/export).
// Ini supaya file modern (Vite/React/Next/dsb yang pakai import/export) tidak ditolak,
// padahal sintaksnya valid — cuma beda "sourceType" saja.
function validateJsSyntax(code) {
  try {
    new Function(code);
    return; // valid sebagai CommonJS/script biasa
  } catch (scriptErr) {
    // Kalau errornya spesifik soal import/export di top-level, kemungkinan besar ini ES Module yang valid
    if (/import statement|export statement|Unexpected token 'export'|Unexpected token 'import'/i.test(scriptErr.message)) {
      try {
        new vm.SourceTextModule(code, { context: vm.createContext({}) });
        return; // dikonfirmasi valid sebagai ES Module
      } catch (moduleErr) {
        // vm.SourceTextModule butuh flag --experimental-vm-modules; kalau tidak tersedia,
        // tetap loloskan karena error aslinya cuma soal import/export (bukan typo/sintaks rusak)
        if (/--experimental-vm-modules|SourceTextModule is not a constructor/i.test(moduleErr.message)) {
          return;
        }
        throw new Error("Sintaks JS tidak valid: " + moduleErr.message);
      }
    }
    throw new Error("Sintaks JS tidak valid: " + scriptErr.message);
  }
}

// ─── FLOW: ENKRIPSI JS ──────────────────────────────────────────────────────
async function runEncJSFlow(chatId, userId, code, mode, fileName) {
  if (!(await requireAndSpendCredit(chatId, userId))) return;

  const statusMsg = await sendHtml(chatId, `⚙️ <b>Mengenkripsi JS (${mode})...</b>`);
  try {
    validateJsSyntax(code);

    const output = await jsenc.obfuscateJS(code, mode);
    const safeName = path.basename(fileName || "code.js");
    const outFile = tmpPath(`enc_js_out_${Date.now()}_${safeName}`);
    await fs.promises.writeFile(outFile, output, "utf8");

    const caption =
      `✅ <b>Enkripsi Berhasil!</b>\n${DIV_HTML}\n\n` +
      `<blockquote>🔒 Mode: <code>${mode}</code>\n📄 File: <code>${safeName}</code>\n📦 ${(output.length / 1024).toFixed(1)} KB</blockquote>`;

    await editHtml(chatId, statusMsg.id, caption);
    await client.sendFile(chatId, { file: outFile, caption, parseMode: "html", forceDocument: true });
    await fs.promises.unlink(outFile).catch(() => {});

    await notifyChannelAction(chatId, userId, "enc_js", "Enkripsi JS", { mode });
  } catch (err) {
    await editHtml(chatId, statusMsg.id, `❌ <b>Enkripsi Gagal!</b>\n\n<blockquote>${err.message}</blockquote>`);
    credits.addCredits(userId, CREDIT_COST); // refund
  }
}

async function runDecJSFlow(chatId, userId, code) {
  const statusMsg = await sendHtml(chatId, `⚙️ <b>Mendekripsi JS...</b>`);
  try {
    const output = jsenc.decryptBase64JS(code);
    if (!output) {
      await editHtml(chatId, statusMsg.id, `❌ <b>Gagal dekripsi JS.</b>`);
      return;
    }
    const outFile = tmpPath(`dec_js_out_${Date.now()}.js`);
    await fs.promises.writeFile(outFile, output, "utf8");

    const caption = `✅ <b>Dekripsi Berhasil!</b>\n${DIV_HTML}\n\n<blockquote>📦 ${(output.length / 1024).toFixed(1)} KB</blockquote>`;
    await editHtml(chatId, statusMsg.id, caption);
    await client.sendFile(chatId, { file: outFile, caption, parseMode: "html", forceDocument: true });
    await fs.promises.unlink(outFile).catch(() => {});
  } catch (err) {
    await editHtml(chatId, statusMsg.id, `❌ <b>Gagal memproses!</b>\n\n<blockquote>${err.message}</blockquote>`);
  }
}

// ─── HANDLE MOD MESSAGE ─────────────────────────────────────────────────────
async function handleModMessage(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const state  = modStates.get(userId);
  if (!state) return false;

  const msg  = event.message;
  const text = msg.text?.trim();

  // STEP: waiting_redeem_code
  if (state.step === "waiting_redeem_code") {
    modStates.delete(userId);
    if (!text) { await sendHtml(chatId, `⚠️ <b>Kirim kode redeem yang valid.</b>`); return true; }
    const res = credits.redeemCode(userId, text);
    if (!res.ok) {
      const reasonMsg = { notfound: "Kode tidak ditemukan.", exhausted: "Kode sudah habis dipakai.", already: "Kamu sudah pernah pakai kode ini." }[res.reason] || "Kode tidak valid.";
      await sendHtml(chatId, `❌ <b>Gagal Redeem!</b>\n\n<blockquote>${reasonMsg}</blockquote>`, [[{ text: "🏠 Menu Utama", data: "start" }]]);
      return true;
    }
    await sendHtml(chatId,
      `🎉 <b>Redeem Berhasil!</b>\n${DIV_HTML}\n\n<blockquote>💰 +${res.credits} Credit ditambahkan.\n💳 Saldo sekarang: <b>${credits.getCredits(userId)} Credit</b></blockquote>`,
      [[{ text: "🏠 Menu Utama", data: "start" }]]
    );
    try {
      let name = "Unknown", uname = "—";
      try {
        const e = await client.getEntity(userId);
        name = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown";
        uname = e?.username ? `@${e.username}` : "—";
      } catch (_) {}
      await client.sendMessage(CONFIG.CHANNEL_USERNAME, {
        message: `🎁 <b>KODE REDEEM DIPAKAI</b>\n${DIV_HTML}\n\n<blockquote>👤 ${name} (${uname})\n💰 +${res.credits} Credit</blockquote>`,
        parseMode: "html",
      });
    } catch (_) {}
    return true;
  }

  // STEP: admin kirim foto QRIS -> forward ke user, minta bukti TF
  if (state.step === "waiting_qris_photo") {
    const order = pendingOrders.get(state.orderId);
    if (!order) { modStates.delete(userId); await sendHtml(chatId, `❌ <b>Order sudah tidak berlaku.</b>`); return true; }
    if (!msg.media || !msg.media.isPhoto) {
      await sendHtml(chatId, `⚠️ <b>Kirim foto QRIS, bukan teks!</b>`);
      return true;
    }
    modStates.delete(userId);
    const pkg = CREDIT_PACKAGES[order.pkgKey];
    try {
      const qrisPath = tmpPath(`qris_${state.orderId}_${Date.now()}.jpg`);
      await client.downloadMedia(msg, { outputFile: qrisPath });
      await client.sendMessage(order.chatId, {
        message: `🇶 <b>QRIS Pembayaran</b>\n${DIV_HTML}\n\n<blockquote>📦 Paket : <b>${pkg.label}</b>\n💵 Total : <b>${formatIDR(pkg.priceIDR)}</b>\n\nScan QRIS di atas, lalu kirim <b>screenshot bukti transfer</b> ke sini.</blockquote>`,
        file: qrisPath,
        parseMode: "html",
      });
      if (fs.existsSync(qrisPath)) fs.unlinkSync(qrisPath);
    } catch (_) {}
    order.status = "waiting_proof";
    modStates.set(order.userId, { step: "waiting_payment_proof", orderId: state.orderId, updatedAt: Date.now() });
    await sendHtml(chatId, `✅ <b>QRIS terkirim ke user.</b>`);
    return true;
  }

  // STEP: admin kirim nomor DANA -> forward ke user, minta bukti TF
  if (state.step === "waiting_dana_number") {
    const order = pendingOrders.get(state.orderId);
    if (!order) { modStates.delete(userId); await sendHtml(chatId, `❌ <b>Order sudah tidak berlaku.</b>`); return true; }
    if (!text) { await sendHtml(chatId, `⚠️ <b>Ketik nomor DANA-nya!</b>`); return true; }
    modStates.delete(userId);
    const pkg = CREDIT_PACKAGES[order.pkgKey];
    try {
      await client.sendMessage(order.chatId, {
        message: `💗 <b>Pembayaran via DANA</b>\n${DIV_HTML}\n\n<blockquote>📦 Paket : <b>${pkg.label}</b>\n💵 Total : <b>${formatIDR(pkg.priceIDR)}</b>\n📱 No. DANA : <code>${text}</code>\n\nTransfer ke nomor di atas, lalu kirim <b>screenshot bukti transfer</b> ke sini.</blockquote>`,
        parseMode: "html",
      });
    } catch (_) {}
    order.status = "waiting_proof";
    modStates.set(order.userId, { step: "waiting_payment_proof", orderId: state.orderId, updatedAt: Date.now() });
    await sendHtml(chatId, `✅ <b>Nomor DANA terkirim ke user.</b>`);
    return true;
  }

  // STEP: user kirim bukti TF -> forward ke admin utk ACC final
  if (state.step === "waiting_payment_proof") {
    const order = pendingOrders.get(state.orderId);
    if (!order) { modStates.delete(userId); await sendHtml(chatId, `❌ <b>Order sudah tidak berlaku, silakan order ulang.</b>`); return true; }
    if (!msg.media || !msg.media.isPhoto) {
      await sendHtml(chatId, `⚠️ <b>Kirim screenshot bukti transfer (foto), bukan teks!</b>`);
      return true;
    }
    modStates.delete(userId);
    const pkg = CREDIT_PACKAGES[order.pkgKey];
    try {
      const proofPath = tmpPath(`proof_${state.orderId}_${Date.now()}.jpg`);
      await client.downloadMedia(msg, { outputFile: proofPath });
      await client.sendMessage(CONFIG.OWNER_ID, {
        message:
          `🧾 <b>BUKTI TRANSFER MASUK</b>\n${DIV_HTML}\n\n` +
          `<blockquote>👤 ${order.name} (${order.buyerUname})\n🆔 <code>${order.userId}</code>\n📦 Paket: <b>${pkg.label}</b>\n💵 Total: <b>${formatIDR(pkg.priceIDR)}</b>\n💳 Metode: <b>${order.method.toUpperCase()}</b></blockquote>`,
        file: proofPath,
        parseMode: "html",
        buttons: buildButtons([
          [{ text: "✅ ACC Pembelian", data: `orderfinalacc_${state.orderId}` }],
          [{ text: "❌ Tolak", data: `orderfinalreject_${state.orderId}` }],
        ]),
      });
      if (fs.existsSync(proofPath)) fs.unlinkSync(proofPath);
    } catch (_) {}
    await sendHtml(chatId, `📩 <b>Bukti transfer terkirim!</b>\n\n<blockquote>Menunggu konfirmasi admin. Credit akan otomatis masuk setelah di-ACC.</blockquote>`);
    return true;
  }

  // STEP 1: waiting_zip_domain
  if (state.step === "waiting_zip_domain") {
    const media = msg.media;
    if (!media?.document) {
      await sendHtml(chatId, `⚠️ <b>Kirim file ZIP-nya ya, bukan teks!</b>`);
      return true;
    }
    const doc      = media.document;
    const fileName = doc.attributes?.find(a => a.fileName)?.fileName || "project.zip";
    if (!fileName.endsWith(".zip")) {
      await sendHtml(chatId, `❌ <b>Harus file <code>.zip</code>!</b>`);
      return true;
    }
    if (doc.size > 500 * 1024 * 1024) {
      await sendHtml(chatId, `❌ <b>Maks ukuran ZIP untuk fitur ini: 500 MB.</b>`);
      return true;
    }

    const statusMsg = await sendHtml(chatId, `🔄 <b>Mengunduh & memindai ZIP...</b>`);
    try {
      if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
      const localZip = tmpPath(`mod_domain_${userId}_${Date.now()}.zip`);
      await client.downloadMedia(msg, { outputFile: localZip });
      if (!fs.existsSync(localZip)) throw new Error("Gagal download ZIP");

      const urls = fluttermod.scanUrlsInZip(localZip);
      if (urls.length === 0) {
        await editHtml(chatId, statusMsg.id,
          `⚠️ <b>Tidak ditemukan URL http/https di file .dart manapun.</b>\n\n<blockquote>Kirim URL lama secara manual (ketik langsung):</blockquote>`
        );
        state.step = "waiting_old_url_manual";
        state.localZip = localZip;
        modStates.set(userId, state);
        return true;
      }

      state.step = "waiting_pick_url";
      state.localZip = localZip;
      state.foundUrls = urls;
      modStates.set(userId, state);

      const listText = urls.slice(0, 10).map((u, i) => `${i + 1}. <code>${u[0]}</code> (${u[1]}x)`).join("\n");
      const btnRows = urls.slice(0, 10).map((u, i) => [{ text: `${i + 1}. ${u[0].slice(0, 35)}`, data: `mod_pickurl_${i}` }]);
      btnRows.push([{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]);

      await editHtml(chatId, statusMsg.id,
        `🔧 <b>Ganti Domain APK</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>Ditemukan URL berikut di project kamu:\n\n${listText}</blockquote>\n\n` +
        `Pilih salah satu untuk diganti:`,
        btnRows
      );
    } catch (err) {
      await editHtml(chatId, statusMsg.id, `❌ <b>Gagal memproses ZIP!</b>\n\n<blockquote>${err.message}</blockquote>`);
      modStates.delete(userId);
    }
    return true;
  }

  // STEP 1b: waiting_old_url_manual
  if (state.step === "waiting_old_url_manual") {
    if (!text || !text.startsWith("http")) {
      await sendHtml(chatId, `⚠️ <b>Kirim URL lama yang valid</b> (harus mulai dengan http:// atau https://):`);
      return true;
    }
    state.oldUrl = text;
    state.step = "waiting_new_url";
    modStates.set(userId, state);
    await sendHtml(chatId,
      `✅ URL lama: <code>${text}</code>\n\nSekarang kirim <b>URL server baru</b>:`,
      [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]]
    );
    return true;
  }

  // STEP 2: waiting_new_url
  if (state.step === "waiting_new_url") {
    if (!text || !text.startsWith("http")) {
      await sendHtml(chatId, `⚠️ <b>Kirim URL baru yang valid</b> (harus mulai dengan http:// atau https://):`);
      return true;
    }
    await processDomainChange(chatId, userId, state, text);
    return true;
  }

  // STEP: waiting_zip_color
  if (state.step === "waiting_zip_color") {
    const media = msg.media;
    if (!media?.document) {
      await sendHtml(chatId, `⚠️ <b>Kirim file ZIP-nya ya, bukan teks!</b>`);
      return true;
    }
    const doc      = media.document;
    const fileName = doc.attributes?.find(a => a.fileName)?.fileName || "project.zip";
    if (!fileName.endsWith(".zip")) {
      await sendHtml(chatId, `❌ <b>Harus file <code>.zip</code>!</b>`);
      return true;
    }
    if (doc.size > 500 * 1024 * 1024) {
      await sendHtml(chatId, `❌ <b>Maks ukuran ZIP untuk fitur ini: 500 MB.</b>`);
      return true;
    }

    const statusMsg = await sendHtml(chatId, `🔄 <b>Mengunduh & memindai warna...</b>`);
    try {
      if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
      const localZip = tmpPath(`mod_color_${userId}_${Date.now()}.zip`);
      await client.downloadMedia(msg, { outputFile: localZip });
      if (!fs.existsSync(localZip)) throw new Error("Gagal download ZIP");

      const colors = fluttermod.scanDominantColors(localZip);
      state.localZip = localZip;
      state.step = "waiting_pick_color";

      if (colors.length === 0) {
        state.oldHex = null;
      } else {
        state.oldHex = colors[0][0];
      }
      modStates.set(userId, state);

      const detectedText = state.oldHex
        ? `Warna dominan terdeteksi: <code>#${state.oldHex}</code>`
        : `Tidak ada warna hex terdeteksi otomatis — kamu tetap bisa lanjut, tapi kemungkinan tidak ada yang diganti.`;

      await editHtml(chatId, statusMsg.id,
        `🎨 <b>Ganti Warna APK</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>${detectedText}</blockquote>\n\n` +
        `Pilih warna pengganti:`,
        keyboardColorPresets()
      );
    } catch (err) {
      await editHtml(chatId, statusMsg.id, `❌ <b>Gagal memproses ZIP!</b>\n\n<blockquote>${err.message}</blockquote>`);
      modStates.delete(userId);
    }
    return true;
  }

  // STEP: waiting_custom_hex
  if (state.step === "waiting_custom_hex") {
    const hex = (text || "").replace("#", "").trim();
    if (!fluttermod.isValidHex(hex)) {
      await sendHtml(chatId, `⚠️ <b>Format hex tidak valid.</b>\n\n<blockquote>Kirim 6 digit hex, contoh: <code>FF5733</code></blockquote>`);
      return true;
    }
    await processColorChange(chatId, userId, state, hex.toUpperCase());
    return true;
  }

  // STEP: waiting_zip_icon
  if (state.step === "waiting_zip_icon") {
    const media = msg.media;
    if (!media?.document) {
      await sendHtml(chatId, `⚠️ <b>Kirim file ZIP-nya ya, bukan teks!</b>`);
      return true;
    }
    const doc      = media.document;
    const fileName = doc.attributes?.find(a => a.fileName)?.fileName || "project.zip";
    if (!fileName.endsWith(".zip")) {
      await sendHtml(chatId, `❌ <b>Harus file <code>.zip</code>!</b>`);
      return true;
    }
    if (doc.size > 500 * 1024 * 1024) {
      await sendHtml(chatId, `❌ <b>Maks ukuran ZIP untuk fitur ini: 500 MB.</b>`);
      return true;
    }

    const statusMsg = await sendHtml(chatId, `🔄 <b>Mengunduh & memindai icon...</b>`);
    try {
      if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
      const localZip = tmpPath(`mod_icon_${userId}_${Date.now()}.zip`);
      await client.downloadMedia(msg, { outputFile: localZip });
      if (!fs.existsSync(localZip)) throw new Error("Gagal download ZIP");

      const targets = fluttermod.scanIconTargets(localZip);
      if (targets.length === 0) {
        await editHtml(chatId, statusMsg.id, `⚠️ <b>Tidak ditemukan slot icon Android/iOS di project ini.</b>`);
        safeCleanupModState(userId, state);
        return true;
      }

      state.localZip = localZip;
      state.step = "waiting_icon_image";
      state.iconTargetsCount = targets.length;
      modStates.set(userId, state);

      await editHtml(chatId, statusMsg.id,
        `🖼️ <b>Ganti Icon APK</b>\n${DIV_HTML}\n\n` +
        `<blockquote>✅ Ditemukan ${targets.length} slot icon (Android + iOS).</blockquote>\n\n` +
        `📤 Sekarang kirim gambar icon baru (PNG/JPG, disarankan persegi 1:1):`
      );
    } catch (err) {
      await editHtml(chatId, statusMsg.id, `❌ <b>Gagal memproses ZIP!</b>\n\n<blockquote>${err.message}</blockquote>`);
      modStates.delete(userId);
    }
    return true;
  }

  if (state.step === "waiting_icon_image") {
    const media = msg.media;
    if (!media?.photo && !media?.document) {
      await sendHtml(chatId, `⚠️ <b>Kirim gambar (foto atau file PNG/JPG)!</b>`);
      return true;
    }
    if (!(await requireAndSpendCredit(chatId, userId))) { safeCleanupModState(userId, state); return true; }
    const statusMsg = await sendHtml(chatId, `⚙️ <b>Mengganti icon...</b>`);
    try {
      const iconPath = tmpPath(`icon_src_${userId}_${Date.now()}.png`);
      await client.downloadMedia(msg, { outputFile: iconPath });
      const iconBuffer = await fs.promises.readFile(iconPath);
      fs.unlink(iconPath, () => {});

      const outZip = tmpPath(`mod_icon_out_${userId}_${Date.now()}.zip`);
      const result = await fluttermod.replaceIconInZip(state.localZip, outZip, iconBuffer);

      if (result.changedCount === 0) {
        await editHtml(chatId, statusMsg.id, `⚠️ <b>Tidak ada icon yang berhasil diganti.</b>`);
        credits.addCredits(userId, CREDIT_COST); // refund
        safeCleanupModState(userId, state);
        return true;
      }

      const resizeNote = result.resized
        ? "✅ Icon otomatis di-resize sesuai ukuran tiap slot."
        : "⚠️ Modul resize (sharp) tidak tersedia di server — icon dipasang tanpa resize otomatis.";

      await editHtml(chatId, statusMsg.id,
        `✅ <b>Icon Berhasil Diganti!</b>\n${DIV_HTML}\n\n` +
        `<blockquote>📝 ${result.changedCount} file icon diganti.\n${resizeNote}</blockquote>\n\n` +
        `📦 Mengirim ZIP hasil...`
      );

      await notifyChannelAction(chatId, userId, "mod_icon", "Ganti Icon APK", { jumlah: `${result.changedCount} file` });

      await client.sendFile(chatId, {
        file: outZip,
        caption: `📦 <b>ZIP Hasil Ganti Icon</b>\n${DIV_HTML}\n\n<blockquote>Siap dibuild.</blockquote>`,
        parseMode: "html",
        forceDocument: true,
      });
      await fs.promises.unlink(outZip).catch(() => {});
    } catch (err) {
      await editHtml(chatId, statusMsg.id, `❌ <b>Gagal mengganti icon!</b>\n\n<blockquote>${err.message}</blockquote>`);
      credits.addCredits(userId, CREDIT_COST); // refund
    } finally {
      safeCleanupModState(userId, state);
    }
    return true;
  }

  // STEP: waiting_zip_name
  if (state.step === "waiting_zip_name") {
    const media = msg.media;
    if (!media?.document) {
      await sendHtml(chatId, `⚠️ <b>Kirim file ZIP-nya ya, bukan teks!</b>`);
      return true;
    }
    const doc      = media.document;
    const fileName = doc.attributes?.find(a => a.fileName)?.fileName || "project.zip";
    if (!fileName.endsWith(".zip")) {
      await sendHtml(chatId, `❌ <b>Harus file <code>.zip</code>!</b>`);
      return true;
    }
    if (doc.size > 500 * 1024 * 1024) {
      await sendHtml(chatId, `❌ <b>Maks ukuran ZIP untuk fitur ini: 500 MB.</b>`);
      return true;
    }

    const statusMsg = await sendHtml(chatId, `🔄 <b>Mengunduh ZIP...</b>`);
    try {
      if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
      const localZip = tmpPath(`mod_name_${userId}_${Date.now()}.zip`);
      await client.downloadMedia(msg, { outputFile: localZip });
      if (!fs.existsSync(localZip)) throw new Error("Gagal download ZIP");

      state.localZip = localZip;
      state.step = "waiting_new_name";
      modStates.set(userId, state);

      await editHtml(chatId, statusMsg.id,
        `✏️ <b>Ganti Nama APK</b>\n${DIV_HTML}\n\n📝 Kirim nama aplikasi baru:`
      );
    } catch (err) {
      await editHtml(chatId, statusMsg.id, `❌ <b>Gagal memproses ZIP!</b>\n\n<blockquote>${err.message}</blockquote>`);
      modStates.delete(userId);
    }
    return true;
  }

  if (state.step === "waiting_new_name") {
    if (!text || text.length < 1 || text.length > 50) {
      await sendHtml(chatId, `⚠️ <b>Nama harus 1-50 karakter.</b> Kirim ulang:`);
      return true;
    }
    if (!(await requireAndSpendCredit(chatId, userId))) { safeCleanupModState(userId, state); return true; }
    const statusMsg = await sendHtml(chatId, `⚙️ <b>Mengganti nama app...</b>`);
    try {
      const outZip = tmpPath(`mod_name_out_${userId}_${Date.now()}.zip`);
      const result = fluttermod.replaceAppNameInZip(state.localZip, outZip, text);

      if (result.totalOccurrences === 0) {
        await editHtml(chatId, statusMsg.id, `⚠️ <b>Tidak ditemukan tempat untuk mengganti nama app.</b>`);
        credits.addCredits(userId, CREDIT_COST); // refund
        safeCleanupModState(userId, state);
        return true;
      }

      const fileList = result.changedFiles.map(f => `• <code>${f.file}</code> (${f.count}x)`).join("\n");

      await editHtml(chatId, statusMsg.id,
        `✅ <b>Nama App Berhasil Diganti!</b>\n${DIV_HTML}\n\n` +
        `<blockquote>✏️ Nama baru: <b>${text}</b>\n📝 Total: ${result.totalOccurrences}x di ${result.changedFiles.length} file\n\n${fileList}</blockquote>\n\n` +
        `📦 Mengirim ZIP hasil...`
      );

      await notifyChannelAction(chatId, userId, "mod_name", "Ganti Nama APK", { nama: text });

      await client.sendFile(chatId, {
        file: outZip,
        caption: `📦 <b>ZIP Hasil Ganti Nama</b>\n${DIV_HTML}\n\n<blockquote>Nama app: <b>${text}</b></blockquote>`,
        parseMode: "html",
        forceDocument: true,
      });
      await fs.promises.unlink(outZip).catch(() => {});
    } catch (err) {
      await editHtml(chatId, statusMsg.id, `❌ <b>Gagal mengganti nama!</b>\n\n<blockquote>${err.message}</blockquote>`);
      credits.addCredits(userId, CREDIT_COST); // refund
    } finally {
      safeCleanupModState(userId, state);
    }
    return true;
  }

  // MOD: RENAME ALL NAME — STEP 1: terima ZIP
  if (state.step === "waiting_zip_renameall") {
    const media = msg.media;
    if (!media?.document) {
      await sendHtml(chatId, `⚠️ <b>Kirim file ZIP-nya ya, bukan teks!</b>`);
      return true;
    }
    const doc      = media.document;
    const fileName = doc.attributes?.find(a => a.fileName)?.fileName || "project.zip";
    if (!fileName.endsWith(".zip")) {
      await sendHtml(chatId, `❌ <b>Harus file <code>.zip</code>!</b>`);
      return true;
    }
    if (doc.size > 500 * 1024 * 1024) {
      await sendHtml(chatId, `❌ <b>Maks ukuran ZIP untuk fitur ini: 500 MB.</b>`);
      return true;
    }

    const statusMsg = await sendHtml(chatId, `🔄 <b>Mengunduh ZIP...</b>`);
    try {
      if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
      const localZip = tmpPath(`mod_renameall_${userId}_${Date.now()}.zip`);
      await client.downloadMedia(msg, { outputFile: localZip });
      if (!fs.existsSync(localZip)) throw new Error("Gagal download ZIP");

      state.localZip = localZip;
      state.step = "waiting_old_text_renameall";
      modStates.set(userId, state);

      await editHtml(chatId, statusMsg.id,
        `🔤 <b>Rename All Name</b>\n${DIV_HTML}\n\n📝 Kirim nama/teks yang ingin dicari (contoh: <code>TOKO KLONTONG ZIPER</code>):`
      );
    } catch (err) {
      await editHtml(chatId, statusMsg.id, `❌ <b>Gagal memproses ZIP!</b>\n\n<blockquote>${err.message}</blockquote>`);
      modStates.delete(userId);
    }
    return true;
  }

  // MOD: RENAME ALL NAME — STEP 2: nama/teks lama
  if (state.step === "waiting_old_text_renameall") {
    if (!text || text.length < 1 || text.length > 200) {
      await sendHtml(chatId, `⚠️ <b>Teks harus 1-200 karakter.</b> Kirim ulang:`);
      return true;
    }
    state.oldText = text;
    state.step = "waiting_new_text_renameall";
    modStates.set(userId, state);
    await sendHtml(chatId,
      `✅ Teks lama: <code>${text}</code>\n\n📝 Sekarang kirim <b>teks/nama baru</b> penggantinya:`,
      [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]]
    );
    return true;
  }

  // MOD: RENAME ALL NAME — STEP 3: nama/teks baru, lalu proses
  if (state.step === "waiting_new_text_renameall") {
    if (!text || text.length < 1 || text.length > 200) {
      await sendHtml(chatId, `⚠️ <b>Teks harus 1-200 karakter.</b> Kirim ulang:`);
      return true;
    }
    if (!(await requireAndSpendCredit(chatId, userId))) { safeCleanupModState(userId, state); return true; }
    const statusMsg = await sendHtml(chatId, `⚙️ <b>Mengganti semua kemunculan teks...</b>`);
    try {
      const outZip = tmpPath(`mod_renameall_out_${userId}_${Date.now()}.zip`);
      const result = fluttermod.replaceTextInZip(state.localZip, outZip, state.oldText, text);

      if (result.totalOccurrences === 0) {
        await editHtml(chatId, statusMsg.id, `⚠️ <b>Tidak ditemukan teks "<code>${state.oldText}</code>" di file .dart manapun.</b>`);
        credits.addCredits(userId, CREDIT_COST); // refund
        safeCleanupModState(userId, state);
        return true;
      }

      const fileList = result.changedFiles.map(f => `• <code>${f.file}</code> (${f.count}x)`).join("\n");

      await editHtml(chatId, statusMsg.id,
        `✅ <b>Rename All Name Berhasil!</b>\n${DIV_HTML}\n\n` +
        `<blockquote>🔎 Teks lama: <b>${state.oldText}</b>\n✏️ Teks baru: <b>${text}</b>\n📝 Total: ${result.totalOccurrences}x di ${result.changedFiles.length} file\n\n${fileList}</blockquote>\n\n` +
        `📦 Mengirim ZIP hasil...`
      );

      await notifyChannelAction(chatId, userId, "mod_renameall", "Rename All Name", { lama: state.oldText, baru: text });

      await client.sendFile(chatId, {
        file: outZip,
        caption: `📦 <b>ZIP Hasil Rename All Name</b>\n${DIV_HTML}\n\n<blockquote>Lama: <b>${state.oldText}</b>\nBaru: <b>${text}</b></blockquote>`,
        parseMode: "html",
        forceDocument: true,
      });
      await fs.promises.unlink(outZip).catch(() => {});
    } catch (err) {
      await editHtml(chatId, statusMsg.id, `❌ <b>Gagal mengganti teks!</b>\n\n<blockquote>${err.message}</blockquote>`);
      credits.addCredits(userId, CREDIT_COST); // refund
    } finally {
      safeCleanupModState(userId, state);
    }
    return true;
  }

  // (Alur guided /addworkergithub lama sudah diganti command satu baris /addwolker,
  // lihat handler /addwolker di bagian routing command.)

  // CREATE PANEL FREE — STEP 1: username
  if (state.step === "waiting_freepanel_username") {
    if (!text || !/^[a-zA-Z0-9_]{3,20}$/.test(text)) {
      await sendHtml(chatId, `⚠️ <b>Username harus 3-20 karakter, hanya huruf/angka/underscore.</b> Kirim ulang:`);
      return true;
    }
    // Re-cek eligibility & jatah di setiap step (jaga-jaga state basi / race condition)
    const st = credits.getFreePanelStatus(userId);
    if (st.claimed) {
      modStates.delete(userId);
      await sendHtml(chatId, `⚠️ <b>Jatah Sudah Terpakai!</b>\n\n<blockquote>Kamu sudah pernah membuat Panel Free sebelumnya.</blockquote>`, [[{ text: "🏠 Menu Utama", data: "start" }]]);
      return true;
    }
    if (!st.eligible) {
      modStates.delete(userId);
      await sendHtml(chatId, `🔒 <b>Belum Eligible.</b>\n\n<blockquote>Progress kamu: ${st.confirmedReferrals}/${st.required} orang.</blockquote>`, [[{ text: "🏠 Menu Utama", data: "start" }]]);
      return true;
    }
    state.panelUsername = text;
    state.step = "waiting_freepanel_password";
    modStates.set(userId, state);
    await sendHtml(chatId,
      `✅ Username: <code>${text}</code>\n\n🔑 Sekarang masukan <b>Password</b> untuk panel kamu (min. 8 karakter):`,
      [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]]
    );
    return true;
  }

  // CREATE PANEL FREE — STEP 2: password, lalu proses create
  if (state.step === "waiting_freepanel_password") {
    if (!text || text.length < 8) {
      await sendHtml(chatId, `⚠️ <b>Password minimal 8 karakter.</b> Kirim ulang:`);
      return true;
    }
    // Cek claim lagi sebelum eksekusi (cegah double-claim kalau user buka 2 sesi)
    const st = credits.getFreePanelStatus(userId);
    if (st.claimed) {
      modStates.delete(userId);
      await sendHtml(chatId, `⚠️ <b>Jatah Sudah Terpakai!</b>`, [[{ text: "🏠 Menu Utama", data: "start" }]]);
      return true;
    }
    if (!credits.markFreePanelClaimed(userId)) {
      modStates.delete(userId);
      await sendHtml(chatId, `⚠️ <b>Jatah Sudah Terpakai!</b>`, [[{ text: "🏠 Menu Utama", data: "start" }]]);
      return true;
    }

    const statusMsg = await sendHtml(chatId, `⚙️ <b>Membuat Panel Hosting...</b>\n\n<blockquote>Mohon tunggu sebentar.</blockquote>`);
    const result = await createFreePanelAccount(state.panelUsername, text);

    if (!result.success) {
      // Gagal (misal username sudah dipakai) -> refund jatah, user boleh coba lagi tanpa kehilangan jatah
      credits.unmarkFreePanelClaimed(userId);
      await editHtml(chatId, statusMsg.id,
        `❌ <b>Gagal Membuat Panel!</b>\n\n<blockquote>${result.msg}</blockquote>\n\n` +
        `${result.usernameTaken ? "Username sudah dipakai, coba username lain ya." : "Silakan coba lagi."}`,
        [[{ text: "🔁 Coba Lagi", data: "freepanel_start" }], [{ text: "🏠 Menu Utama", data: "start" }]]
      );
      safeCleanupModState(userId, state);
      return true;
    }

    const d = result.data;
    await editHtml(chatId, statusMsg.id,
      `✅ <b>Panel Berhasil Dibuat!</b>\n${DIV_HTML}\n\n` +
      `<blockquote>` +
      `👤 Username : <code>${d.username}</code>\n` +
      `🔑 Password : <code>${d.password}</code>\n` +
      `🌐 Login    : ${d.login}\n` +
      `💾 Resource : Unlimited` +
      `</blockquote>\n\n` +
      `⚠️ Simpan info di atas baik-baik. Jatah Create Panel Free kamu sudah terpakai (1x per user).`,
      [[{ text: "🏠 Menu Utama", data: "start" }]]
    );

    await notifyChannelAction(chatId, userId, "free_panel", "Create Panel Free (Reward Referral)", { username: d.username });
    safeCleanupModState(userId, state);
    return true;
  }

  // DEPLOY WEB: waiting_name
  if (state.step === "deployweb_waiting_name") {
    if (!text) {
      await sendHtml(chatId, `⚠️ <b>Ketik nama subdomain kamu:</b>`);
      return true;
    }
    const clean = cleanAlphaNum(text.trim());
    if (clean.length < 3) {
      await sendHtml(chatId,
        `⚠️ <b>Nama minimal 3 karakter, huruf kecil & angka saja.</b>\n\nKetik ulang:`
      );
      return true;
    }
    state.projectName = clean;
    state.step = "deployweb_waiting_html";
    modStates.set(userId, state);
    await sendHtml(chatId,
      `✅ <b>Nama Tersimpan!</b>\n\n` +
      `<blockquote>🌍 Subdomain: <code>https://${clean}.vercel.app</code></blockquote>\n\n` +
      `📤 Sekarang kirim:\n` +
      `• File <code>.html</code> tunggal, <b>atau</b>\n` +
      `• File <code>.zip</code> project web (html+css+js+gambar)`,
      [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]]
    );
    return true;
  }

  // DEPLOY WEB: waiting_html
  if (state.step === "deployweb_waiting_html") {
    const projectName = state.projectName;

    const doc = msg.media?.document;
    const fileName = doc?.attributes?.find(a => a.fileName)?.fileName || "";
    if (doc && fileName.toLowerCase().endsWith(".zip")) {
      if (doc.size > 50 * 1024 * 1024) {
        await sendHtml(chatId, `⚠️ <b>Maks ukuran ZIP untuk deploy web: 50 MB.</b>`);
        return true;
      }
      modStates.delete(userId);
      await runDeployWebZipFlow(chatId, userId, msg, projectName);
      return true;
    }

    const html = await extractHTMLGeneric(msg, chatId);
    if (!html) return true;
    modStates.delete(userId);
    await runDeployWebFlow(chatId, userId, html, projectName);
    return true;
  }

  // ENC HTML
  if (state.step === "enc_html_b64" || state.step === "enc_html_obf" || state.step === "dec_html_b64") {
    const html = await extractHTMLGeneric(msg, chatId);
    if (!html) return true;
    modStates.delete(userId);
    await runEncHTMLFlow(chatId, userId, html, state.step);
    return true;
  }

  // ENC JS
  if (state.step === "enc_js_wait") {
    const js = await extractJSGeneric(msg, chatId);
    if (!js) return true;
    const mode = state.jsMode;
    modStates.delete(userId);
    await runEncJSFlow(chatId, userId, js, mode, msg.document?.file_name || msg.media?.document?.attributes?.find(a => a.fileName)?.fileName);
    return true;
  }

  if (state.step === "dec_js_b64") {
    const js = await extractJSGeneric(msg, chatId);
    if (!js) return true;
    modStates.delete(userId);
    await runDecJSFlow(chatId, userId, js);
    return true;
  }

  return false;
}

// ─── PROCESS DOMAIN CHANGE ─────────────────────────────────────────────────
async function processDomainChange(chatId, userId, state, newUrl, msgId = null) {
  if (!(await requireAndSpendCredit(chatId, userId, msgId))) { safeCleanupModState(userId, state); return; }

  const statusMsg = msgId
    ? { id: msgId }
    : await sendHtml(chatId, `⚙️ <b>Mengganti domain...</b>`);

  try {
    const outZip = tmpPath(`mod_domain_out_${userId}_${Date.now()}.zip`);
    const result = fluttermod.replaceDomainInZip(state.localZip, outZip, state.oldUrl, newUrl);

    if (result.totalOccurrences === 0) {
      await editHtml(chatId, statusMsg.id,
        `⚠️ <b>URL lama tidak ditemukan di file manapun.</b>\n\n<blockquote>Pastikan URL yang kamu ketik sama persis dengan yang ada di kode.</blockquote>`
      );
      credits.addCredits(userId, CREDIT_COST); // refund
      safeCleanupModState(userId, state);
      return;
    }

    const fileList = result.changedFiles.map(f => `• <code>${f.file}</code> (${f.count}x)`).join("\n");

    await editHtml(chatId, statusMsg.id,
      `✅ <b>Domain Berhasil Diganti!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>` +
      `🔻 Lama: <code>${state.oldUrl}</code>\n` +
      `🔺 Baru: <code>${newUrl}</code>\n` +
      `📝 Total: ${result.totalOccurrences}x di ${result.changedFiles.length} file\n\n` +
      `${fileList}` +
      `</blockquote>\n\n` +
      `📦 Mengirim file ZIP hasil...`
    );

    const buffer = await fs.promises.readFile(outZip);
    credits.logDeploy({ userId, type: "mod_domain", domain: newUrl, oldDomain: state.oldUrl });
    await notifyChannelAction(chatId, userId, "mod_domain", "Ganti Domain APK", {});
    await client.sendFile(chatId, {
      file: outZip,
      caption:
        `📦 <b>ZIP Hasil Ganti Domain</b>\n${DIV_HTML}\n\n` +
        `<blockquote>Siap dibuild atau langsung dipakai.</blockquote>`,
      parseMode: "html",
      forceDocument: true,
    });

    await fs.promises.unlink(outZip).catch(() => {});
  } catch (err) {
    await editHtml(chatId, statusMsg.id, `❌ <b>Gagal mengganti domain!</b>\n\n<blockquote>${err.message}</blockquote>`);
    credits.addCredits(userId, CREDIT_COST); // refund
  } finally {
    safeCleanupModState(userId, state);
  }
}

// ─── PROCESS COLOR CHANGE ──────────────────────────────────────────────────
async function processColorChange(chatId, userId, state, newHex, msgId = null) {
  if (!(await requireAndSpendCredit(chatId, userId, msgId))) { safeCleanupModState(userId, state); return; }

  const statusMsg = msgId
    ? { id: msgId }
    : await sendHtml(chatId, `⚙️ <b>Mengganti warna...</b>`);

  try {
    if (!state.oldHex) {
      await editHtml(chatId, statusMsg.id,
        `⚠️ <b>Tidak ada warna lama yang terdeteksi untuk diganti.</b>\n\n<blockquote>Project ini mungkin tidak punya warna hex hardcoded di kode.</blockquote>`
      );
      credits.addCredits(userId, CREDIT_COST); // refund
      safeCleanupModState(userId, state);
      return;
    }

    const outZip = tmpPath(`mod_color_out_${userId}_${Date.now()}.zip`);
    const result = fluttermod.replaceColorInZip(state.localZip, outZip, state.oldHex, newHex);

    if (result.totalOccurrences === 0) {
      await editHtml(chatId, statusMsg.id,
        `⚠️ <b>Tidak ada file yang berhasil diganti.</b>`
      );
      credits.addCredits(userId, CREDIT_COST); // refund
      safeCleanupModState(userId, state);
      return;
    }

    const fileList = result.changedFiles.map(f => `• <code>${f.file}</code> (${f.count}x)`).join("\n");

    await editHtml(chatId, statusMsg.id,
      `✅ <b>Warna Berhasil Diganti!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `<blockquote>` +
      `🔻 Lama: <code>#${state.oldHex}</code>\n` +
      `🔺 Baru: <code>#${newHex}</code>\n` +
      `📝 Total: ${result.totalOccurrences}x di ${result.changedFiles.length} file\n\n` +
      `${fileList}` +
      `</blockquote>\n\n` +
      `📦 Mengirim file ZIP hasil...`
    );

    await notifyChannelAction(chatId, userId, "mod_color", "Ganti Warna APK", {
      lama: `#${state.oldHex}`, baru: `#${newHex}`,
    });
    await client.sendFile(chatId, {
      file: outZip,
      caption:
        `📦 <b>ZIP Hasil Ganti Warna</b>\n${DIV_HTML}\n\n` +
        `<blockquote>Warna theme + splash sudah diperbarui.</blockquote>`,
      parseMode: "html",
      forceDocument: true,
    });

    await fs.promises.unlink(outZip).catch(() => {});
  } catch (err) {
    await editHtml(chatId, statusMsg.id, `❌ <b>Gagal mengganti warna!</b>\n\n<blockquote>${err.message}</blockquote>`);
    credits.addCredits(userId, CREDIT_COST); // refund
  } finally {
    safeCleanupModState(userId, state);
  }
}

function safeCleanupModState(userId, state) {
  if (state?.localZip && fs.existsSync(state.localZip)) {
    fs.unlink(state.localZip, () => {});
  }
  modStates.delete(userId);
}

// ─── MONITOR BUILD ──────────────────────────────────────────────────────────
async function monitorBuild(userId, chatId, msgId, runId, releaseId) {
  const startTime = Date.now();
  let lastStatus  = "";
  let chanMsgId   = null;

  const job         = getUserJob(userId) || {};
  const worker       = githubWorkers.getWorker(job.workerId);
  const displayMode = job.buildType === "debug" ? "🐞 Debug Build" : job.type === "web2apk" ? "🌐 Web to APK" : "🚀 Release Build";
  const userDisplay = job.fullName && job.fullName !== "Unknown User" ? job.fullName : (job.username ? `@${job.username}` : `User_${userId}`);
  const projDisplay = job.type === "web2apk" ? (job.appName || "Web App") : (job.fileName || "Flutter Project");
  const prioText    = priorityTag(userId);
  const notifPhoto  = job.type === "web2apk" ? NOTIF_PHOTOS.web2apk : NOTIF_PHOTOS.build_apk;

  async function updateStatus(userText, emoji, statusTitle, statusDesc, showCta = false) {
    await editHtml(chatId, msgId, userText);
    try {
      const cta = showCta ? [[{ text: "🚀 Mau Build Juga? Gas!", url: `https://t.me/${(await client.getMe()).username}?start` }]] : null;
      const chanText =
        `${emoji} <b>LIVE BUILD MONITOR</b> ${emoji}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<blockquote>` +
        `👤 Developer : ${userDisplay}\n` +
        `🆔 User ID   : <code>${userId}</code>\n` +
        `🎯 Priority  : ${prioText}\n` +
        `📦 Project   : <code>${projDisplay}</code>\n` +
        `🔧 Mode      : <code>${displayMode}</code>` +
        `</blockquote>\n\n` +
        `<blockquote>` +
        `📊 STATUS : <b>${statusTitle}</b>\n` +
        `💬 DETAIL : ${statusDesc}\n` +
        `⏱ WAKTU  : <code>${formatDuration(Math.floor((Date.now() - startTime) / 1000))}</code>` +
        `</blockquote>`;
      if (!chanMsgId) {
        // PAKAI SENDPHOTOSAFE
        const m = await sendPhotoSafe(client, CONFIG.CHANNEL_USERNAME, notifPhoto, {
          caption: chanText, parseMode: "html",
          buttons: cta ? buildButtons(cta) : undefined,
          tmpDir: CONFIG.TMP_DIR,
        });
        chanMsgId = m.id;
      } else {
        await client.editMessage(CONFIG.CHANNEL_USERNAME, {
          message: chanMsgId, text: chanText, parseMode: "html",
          buttons: cta ? buildButtons(cta) : undefined,
        });
      }
    } catch (e) { console.error("Channel update error:", e.message); }
  }

  // Kalau build error/gagal/timeout: channel TIDAK boleh nampilin status error,
  // progress message yang kadung kebentuk di channel langsung dihapus aja.
  // Channel cuma boleh nampilin log kalau build-nya SUKSES.
  async function clearChannelMsg() {
    if (chanMsgId) {
      try { await client.deleteMessages(CONFIG.CHANNEL_USERNAME, [chanMsgId], { revoke: true }); } catch (_) {}
      chanMsgId = null;
    }
  }

  if (!worker) {
    removeUserJob(userId);
    credits.addCredits(userId, CREDIT_COST); // refund
    await editHtml(chatId, msgId,
      `❌ <b>Worker GitHub Tidak Ditemukan!</b>\n\n<blockquote>Worker yang menangani build ini sudah dihapus atau tidak valid. Hubungi admin.</blockquote>`
    );
    return;
  }

  while (true) {
    if (Date.now() - startTime > CONFIG.BUILD_TIMEOUT_MS) {
      if (releaseId) await deleteRelease(worker, releaseId).catch(() => {});
      const j = getUserJob(userId);
      if (j?.iconReleaseId) await deleteRelease(worker, j.iconReleaseId).catch(() => {});
      removeUserJob(userId);
      hdb.add({ userId, userName: userDisplay, project: projDisplay, mode: displayMode, status: "timeout", duration: Math.floor((Date.now() - startTime) / 1000), at: new Date().toISOString() });
      await editHtml(chatId, msgId,
        `🛑 <b>[ BUILD TIMEOUT ]</b>\n\n` +
        `<blockquote>` +
        `📡 Server  : <code>🔴 TIMEOUT</code>\n` +
        `🔧 Mode    : <code>${displayMode}</code>\n` +
        `📦 Project : <code>${projDisplay}</code>\n` +
        `⏱ Limit   : <code>${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} Menit</code>\n\n` +
        `⚠️ Waktu habis! Cek dependensi kodenya dan coba lagi.` +
        `</blockquote>`
      );
      await clearChannelMsg();
      return;
    }

    const run     = await getRunStatus(worker, runId);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (run.status === "queued" && lastStatus !== "queued") {
      lastStatus = "queued";
      await updateStatus(
        `⏳ <b>[ MENUNGGU SERVER ]</b>\n\n` +
        `<blockquote>` +
        `📡 Server   : <code>🟢 ONLINE</code>\n` +
        `🎯 Priority : ${prioText}\n` +
        `🔧 Mode     : <code>${displayMode}</code>\n` +
        `📦 Project  : <code>${projDisplay}</code>\n` +
        `⏱ Waktu    : <code>${formatDuration(elapsed)}</code>\n\n` +
        `☕ VM sedang disiapkan. Jangan batalkan!` +
        `</blockquote>`,
        "⏳", "MENUNGGU RUNNER", "VM sedang dipersiapkan.", true
      );

    } else if (run.status === "in_progress") {
      lastStatus = "in_progress";
      const pct = Math.min(Math.round((elapsed / 300) * 100), 95);
      await updateStatus(
        `
        🚀 Build APK Berjalan
━━━━━━━━━━━━━━━━━━

📡 Server   : <code>🟡 PROCESSING</code>
📱 projek :  <code>${projDisplay}</code>
📊 Progress: 🔨 <b>${pct}%</b>
${progressBar(pct)} <b>${pct}%</b>

Building APK...`,
 "⚡", `COMPILING (${pct}%)`, "Flutter SDK mengompilasi source code ke APK.", true
      );

    } else if (run.status === "completed") {
      if (run.conclusion === "success") {
        db.incrementStat("success");
        await updateStatus(
          `📦 <b>[ MENGAMBIL APK ]</b>\n\n` +
          `<blockquote>` +
          `📡 Server  : <code>🟢 SUCCESS</code>\n` +
          `⏱ Durasi  : <code>${formatDuration(run.durationSec)}</code>\n` +
          `📦 Project : <code>${projDisplay}</code>\n\n` +
          `🎉 Kompilasi sukses! Mengambil APK dari cloud...` +
          `</blockquote>`,
          "📦", "UPLOADING ARTIFACT", "Memindahkan APK ke Telegram."
        );

        const artifacts = await getArtifacts(worker, runId);
        const apkArtifact = artifacts.find(a => a.name.toLowerCase().includes("apk") || a.name.toLowerCase().includes("build")) || artifacts[0];

        if (!apkArtifact) {
          removeUserJob(userId);
          if (releaseId) await deleteRelease(worker, releaseId).catch(() => {});
          await editHtml(chatId, msgId, `⚠️ <b>File APK Tidak Ditemukan!</b>\n\n<blockquote>Kompilasi sukses tapi output APK tidak terdeteksi. Hubungi admin.</blockquote>`);
          await clearChannelMsg();
          return;
        }

        const zipDest = tmpPath(`flutter_${Date.now()}.zip`);
        await downloadArtifactZip(worker, apkArtifact.id, zipDest);
        const zip      = new AdmZip(zipDest);
        const apkEntry = zip.getEntries().find(e => e.entryName.endsWith(".apk"));

        if (!apkEntry) {
          removeUserJob(userId);
          fs.unlinkSync(zipDest);
          if (releaseId) await deleteRelease(worker, releaseId).catch(() => {});
          await editHtml(chatId, msgId, `⚠️ <b>APK Tidak Ada di Arsip!</b>\n\n<blockquote>Isi ZIP output kosong atau korup. Hubungi admin.</blockquote>`);
          await clearChannelMsg();
          return;
        }

        const apkDest  = tmpPath(`flutter_${Date.now()}.apk`);
        fs.writeFileSync(apkDest, apkEntry.getData());
        fs.unlinkSync(zipDest);
        const apkSize  = (fs.statSync(apkDest).size / 1024 / 1024).toFixed(2);

        await editHtml(chatId, msgId,
          `🚀 <b>Mengupload APK...</b>\n\n` +
          `<blockquote>Kompilasi sukses! APK <code>${apkSize} MB</code> sedang dikirim ke chat kamu...</blockquote>`
        );

        await client.sendFile(chatId, {
          file: apkDest,
          caption:
            `🎉 <b>APK SIAP DIGUNAKAN!</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `<blockquote>` +
            `⏱ Durasi   : <b>${formatDuration(run.durationSec)}</b>\n` +
            `💾 Ukuran   : <b>${apkSize} MB</b>\n` +
            `🔧 Mode     : <b>${displayMode}</b>\n` +
            `🎯 Priority : ${prioText}` +
            `</blockquote>\n\n` +
            `<i>Terima kasih sudah menggunakan ${CONFIG.BOT_NAME}! 🚀</i>`,
          parseMode: "html",
        });

        // ── Banner build-sukses (canvas), dikirim ke user & ke channel ──────
        // Ini best-effort: kalau modul canvas belum terinstall atau gagal
        // generate, dilewati aja tanpa ganggu pengiriman APK yang sudah sukses.
        let buildBannerFile = null;
        try {
          if (banner.isAvailable) {
            const bannerBuf = await banner.generateBuildBanner({
              name: userDisplay, userId, project: projDisplay, mode: displayMode,
              apkSize, duration: formatDuration(run.durationSec),
              botName: CONFIG.BOT_NAME, type: "build apk",
            });
            buildBannerFile = tmpPath(`buildok_${userId}_${Date.now()}.png`);
            await fs.promises.writeFile(buildBannerFile, bannerBuf);

            await client.sendFile(chatId, {
              file: buildBannerFile,
              caption: `🏆 <b>Build Berhasil!</b>\n📦 <code>${projDisplay}</code> — ${apkSize} MB`,
              parseMode: "html",
            });
            await client.sendFile(CONFIG.CHANNEL_USERNAME, {
              file: buildBannerFile,
              caption: `🎉 <b>BUILD SUCCESS</b>\n👤 ${userDisplay}  |  📦 <code>${projDisplay}</code>  |  💾 ${apkSize} MB`,
              parseMode: "html",
            });
          }
        } catch (e) {
          console.error("Build banner error:", e.message);
        } finally {
          if (buildBannerFile) await fs.promises.unlink(buildBannerFile).catch(() => {});
        }

        hdb.add({ userId, userName: userDisplay, project: projDisplay, mode: displayMode, status: "success", apkSize, duration: run.durationSec, at: new Date().toISOString() });

        try {
          await client.editMessage(CONFIG.CHANNEL_USERNAME, {
            message: chanMsgId,
            text:
              `🎉 <b>BUILD SUCCESS!</b>\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `<blockquote>` +
              `👤 Developer : ${userDisplay}\n` +
              `📦 Project   : <code>${projDisplay}</code>\n` +
              `🔧 Mode      : <code>${displayMode}</code>\n` +
              `⏱ Durasi    : <code>${formatDuration(run.durationSec)}</code>\n` +
              `💾 Ukuran    : <code>${apkSize} MB</code>\n` +
              `🟢 Status    : <b>SUKSES TERKIRIM</b>` +
              `</blockquote>`,
            parseMode: "html",
          });
        } catch (_) {}

        fs.unlinkSync(apkDest);
        if (releaseId) await deleteRelease(worker, releaseId).catch(() => {});
        const curJob = getUserJob(userId);
        if (curJob?.iconReleaseId) await deleteRelease(worker, curJob.iconReleaseId).catch(() => {});
        removeUserJob(userId);
        return;

      } else {
        db.incrementStat("failed");
        await editHtml(chatId, msgId,
          `❌ <b>[ BUILD GAGAL ]</b>\n\n` +
          `<blockquote>` +
          `📡 Server  : <code>🔴 FAILED</code>\n` +
          `🔧 Mode    : <code>${displayMode}</code>\n` +
          `📦 Project : <code>${projDisplay}</code>\n\n` +
          `🔍 Mengambil log error dari server...` +
          `</blockquote>`
        );
        // Channel gak boleh nampilin build gagal — progress message dihapus aja.
        await clearChannelMsg();

        if (releaseId) await deleteRelease(worker, releaseId).catch(() => {});
        await sleep(3000);

        const errDetail = await Promise.race([
          getFailedStepLog(worker, runId),
          new Promise(resolve => setTimeout(() => resolve(null), 30000)),
        ]);

        hdb.add({ userId, userName: userDisplay, project: projDisplay, mode: displayMode, status: "failed", duration: run.durationSec, at: new Date().toISOString() });

        let errText =
          `❌ <b>BUILD FAILED</b>\n\n` +
          `<blockquote>` +
          `🔴 Step gagal : <code>${errDetail?.stepName || "Kompilasi Utama"}</code>\n` +
          `⏱ Durasi     : <code>${formatDuration(run.durationSec)}</code>` +
          `</blockquote>`;

        if (errDetail?.errorLines?.length) {
          const analysis = errorhelper.analyzeError(errDetail.errorLines);
          errText += errorhelper.formatAnalysisHtml(analysis);
          errText += `\n\n<pre>${errDetail.errorLines.join("\n").slice(0, 1500)}</pre>`;
          await editHtml(chatId, msgId, errText);

          const logFile = tmpPath(`build_error_${userId}_${Date.now()}.txt`);
          fs.writeFileSync(logFile, `
 BUILD FAILED
 Step: ${errDetail.stepName}
 ============================
 𝗪𝗘𝗕 𝗧𝗢 𝗔𝗣𝗞 𝗕𝗬 𝗭𝗜𝗣𝗘𝗥𝗥
 
 
 ${errDetail.errorLines.join("\n")}`);
          await client.sendFile(chatId, {
            file: logFile,
            caption: `📄 <b>Full Build Error Log</b>\n\n<i>Gunakan file ini untuk menemukan baris kode yang error secara detail.</i>`,
            parseMode: "html",
          });
          if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
        } else {
          errText += `\n\n<blockquote>Gagal mengambil log error otomatis dari server.</blockquote>`;
          await editHtml(chatId, msgId, errText);
        }

        const curJob = getUserJob(userId);
        if (curJob?.iconReleaseId) await deleteRelease(worker, curJob.iconReleaseId).catch(() => {});
        removeUserJob(userId);
        return;
      }
    }
    await sleep(CONFIG.POLL_INTERVAL_MS);
  }
}

// ─── QUEUE ──────────────────────────────────────────────────────────────────
const queueMessages = new Map();

async function handleQueue(chatId, delId = null) {
  try {
    const qs   = getQueueStats();
    const cs   = db.getStats();
    const jobs = getSortedActiveJobs();

    let text =
      `<b>📊 STATUS BUILD QUEUE</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `<blockquote>` +
      `⏳ Menunggu  : <b>${qs.waiting}</b>\n` +
      `☁️ Uploading : <b>${qs.uploading}</b>\n` +
      `⚙️ Building  : <b>${qs.building}</b>` +
      `</blockquote>\n\n`;

    if (jobs.length === 0) {
      text += `<i>🚫 Tidak ada build aktif saat ini.</i>\n\n`;
    } else {
      text += `🔥 <b>Build Aktif (${jobs.length})</b>\n\n`;
      jobs.forEach((j, i) => {
        const icon = j.status === "building" ? "⚙️" : j.status === "uploading" ? "☁️" : "⏳";
        const prioIcon = getUserPriority(j.userId) === 1 ? "👑" : getUserPriority(j.userId) === 2 ? "🤝" : "👤";
        const elapsed  = formatDuration(elapsedSec(j.updatedAt));
        const usr      = j.fullName && j.fullName !== "Unknown User" ? j.fullName : (j.username ? `@${j.username}` : `User_${j.userId}`);
        text +=
          `${i + 1}. ${prioIcon} ${icon} <b>${usr}</b>\n` +
          `<blockquote>` +
          `Status : ${statusLabel(j.status)}\n` +
          `Mode   : ${j.buildType === "debug" ? "🐞 Debug" : j.type === "web2apk" ? "🌐 Web2APK" : "🚀 Release"}\n` +
          `Aktif  : ${elapsed}` +
          `</blockquote>\n`;
      });
    }

    text +=
      `\n<blockquote>` +
      `🟢 Sukses: <b>${cs.success}</b>  |  🔴 Gagal: <b>${cs.failed}</b>\n` +
      `🕒 ${nowTimeWib()} WIB` +
      `</blockquote>`;

    const btns = [[{ text: "🔄 Refresh", data: "queue" }, { text: "🏠 Menu Utama", data: "start" }]];

    if (delId) { try { await client.deleteMessages(chatId, [delId], { revoke: true }); } catch (_) {} }
    else {
      const old = queueMessages.get(chatId);
      if (old) { try { await client.deleteMessages(chatId, [old]); } catch (_) {} }
    }

    const m = await client.sendMessage(chatId, { message: text, buttons: buildButtons(btns), parseMode: "html" });
    queueMessages.set(chatId, m.id);
  } catch (err) {
    console.error("handleQueue error:", err);
  }
}

// ─── STATUS BOT ──────────────────────────────────────────────────────────────
async function handleStatus(chatId, userId, delId = null) {
  const qs      = getQueueStats();
  const uptime  = formatDuration(Math.floor(process.uptime()));
  const cs      = db.getStats();
  const total   = cs.success + cs.failed;
  const rate    = total > 0 ? ((cs.success / total) * 100).toFixed(1) : "0.0";

  const totalRam = (os.totalmem() / 1073741824).toFixed(2);
  const freeRam  = (os.freemem()  / 1073741824).toFixed(2);
  const usedRam  = (totalRam - freeRam).toFixed(2);
  const ramPct   = ((usedRam / totalRam) * 100).toFixed(1);
  const cpus     = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() || "Unknown";
  const cpuLoad  = (os.loadavg()[0] * 100 / cpus.length).toFixed(1);

  let disk = { total: "N/A", used: "N/A", free: "N/A", pct: "N/A" };
  try {
    const df = execSync("df -h / | tail -1").toString().trim().split(/\s+/);
    if (df.length >= 5) disk = { total: df[1], used: df[2], free: df[3], pct: df[4] };
  } catch (_) {}

  let cloud = "Generic KVM";
  try {
    const v = execSync("cat /sys/class/dmi/id/sys_vendor 2>/dev/null").toString().trim().toLowerCase();
    const p = execSync("cat /sys/class/dmi/id/product_name 2>/dev/null").toString().trim().toLowerCase();
    if (v.includes("digitalocean")) cloud = "DigitalOcean Droplet";
    else if (v.includes("amazon")) cloud = "AWS EC2";
    else if (v.includes("google")) cloud = "Google Cloud (GCP)";
    else if (v.includes("linode")) cloud = "Linode VPS";
    else if (v.includes("vultr"))  cloud = "Vultr VPS";
    else if (v.includes("qemu") || p.includes("kvm")) cloud = "KVM Virtual Server";
    else if (v.length > 0) cloud = `${v.toUpperCase()}`;
  } catch (_) {}

  const ping = await new Promise(resolve => {
    const start = Date.now();
    const s = new net.Socket();
    s.setTimeout(2000);
    s.connect(443, "api.github.com", () => {
      const ms = Date.now() - start;
      s.destroy();
      resolve(`${ms}ms — ${ms > 350 ? "🔴 Lambat" : ms > 150 ? "🟡 Sedang" : "🟢 Bagus"}`);
    });
    s.on("error",   () => { s.destroy(); resolve("❌ Gagal"); });
    s.on("timeout", () => { s.destroy(); resolve("❌ Timeout"); });
  });

  await sendHtml(chatId,
    `⚙️ <b>INFRASTRUKTUR BOT</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>🤖 Bot Info</b>\n` +
    `<blockquote>` +
    `📦 Nama    : ${CONFIG.BOT_NAME} <code>v${CONFIG.BOT_VERSION}</code>\n` +
    `🟢 Status  : Online / Active\n` +
    `⏱ Uptime  : ${uptime}\n` +
    `👥 User DB : ${db.getAllUsers().length} pengguna\n` +
    `✅ Sukses  : ${cs.success} build\n` +
    `❌ Gagal   : ${cs.failed} build\n` +
    `📈 Rate    : <b>${rate}%</b>` +
    `</blockquote>\n\n` +
    `<b>📊 Queue Engine</b>\n` +
    `<blockquote>` +
    `⏳ Menunggu  : ${qs.waiting}\n` +
    `☁️ Uploading : ${qs.uploading}\n` +
    `⚙️ Building  : ${qs.building}` +
    `</blockquote>\n\n` +
    `<b>☁️ Cloud Server</b>\n` +
    `<blockquote>` +
    `🌐 Provider : <code>${cloud}</code>\n` +
    `⚡ Ping     : <code>${ping}</code>\n` +
    `🐧 OS       : ${os.type()} ${os.release()} (${os.arch()})` +
    `</blockquote>\n\n` +
    `<b>💾 Hardware</b>\n` +
    `<blockquote>` +
    `🧠 CPU  : ${cpuModel} (${cpus.length} Core)\n` +
    `⚡ Load : <code>${cpuLoad}%</code>\n` +
    `🗄️ RAM  : <code>${usedRam}/${totalRam} GB (${ramPct}%)</code>\n` +
    `💽 SSD  : <code>${disk.used}/${disk.total} (${disk.pct})</code>` +
    `</blockquote>\n\n` +
    `<i>🕒 ${nowWib()} WIB</i>`,
    [[{ text: "🔄 Refresh", data: "status" }, { text: "🏠 Menu Utama", data: "start" }]],
    delId
  );
}

// ─── HELP ────────────────────────────────────────────────────────────────────
async function handleHelp(chatId, delId = null, userId = null) {
  const privileged = userId ? isPrivileged(userId) : false;
  const btns = [
    [{ text: "🚀 Mulai Build APK", data: "build", style: "Success" }, { text: "🌐 Web to APK", data: "web2apk", style: "Success" }],
  ];
  if (privileged) btns.push([{ text: "🛠️ Command List (Admin)", data: "admin_cmdlist", style: "Success" }]);
  btns.push([{ text: "🏠 Menu Utama", data: "start", style: "Danger" }]);

  await sendHtml(chatId,
    `📖 <b>PANDUAN ${CONFIG.BOT_NAME.toUpperCase()}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>🚀 Build APK Flutter</b>\n` +
    `<blockquote>` +
    `1️⃣ Klik <b>🚀 Mulai Build APK</b>\n` +
    `2️⃣ Pilih mode Debug / Release\n` +
    `3️⃣ Kirim file ZIP project Flutter\n` +
    `4️⃣ Bot build di cloud &amp; kirim APK otomatis` +
    `</blockquote>\n\n` +
    `<b>🌐 Web to APK</b>\n` +
    `<blockquote>` +
    `1️⃣ Klik <b>🌐 Web to APK</b>\n` +
    `2️⃣ Kirim URL website\n` +
    `3️⃣ Kirim nama aplikasi\n` +
    `4️⃣ Kirim logo/icon (PNG/JPG)\n` +
    `5️⃣ APK dikirim otomatis` +
    `</blockquote>\n\n` +
    `<b>🔧 Ganti Domain APK</b>\n` +
    `<blockquote>` +
    `1️⃣ Klik <b>🔧 Ganti Domain APK</b>\n` +
    `2️⃣ Kirim ZIP project Flutter\n` +
    `3️⃣ Pilih URL lama yang terdeteksi (atau ketik manual)\n` +
    `4️⃣ Kirim URL server baru\n` +
    `5️⃣ Bot kirim balik ZIP hasil ganti domain` +
    `</blockquote>\n\n` +
    `<b>🎨 Ganti Warna APK</b>\n` +
    `<blockquote>` +
    `1️⃣ Klik <b>🎨 Ganti Warna APK</b>\n` +
    `2️⃣ Kirim ZIP project Flutter\n` +
    `3️⃣ Pilih warna preset atau custom hex\n` +
    `4️⃣ Bot kirim balik ZIP dengan theme + splash sudah diganti` +
    `</blockquote>\n\n` +
    `<b>🖼️ Ganti Icon APK</b>\n` +
    `<blockquote>` +
    `1️⃣ Klik <b>🖼️ Ganti Icon</b>\n` +
    `2️⃣ Kirim ZIP project Flutter\n` +
    `3️⃣ Kirim gambar icon baru (PNG/JPG)\n` +
    `4️⃣ Bot kirim balik ZIP dengan icon Android+iOS sudah diganti` +
    `</blockquote>\n\n` +
    `<b>✏️ Ganti Nama APK</b>\n` +
    `<blockquote>` +
    `1️⃣ Klik <b>✏️ Ganti Nama</b>\n` +
    `2️⃣ Kirim ZIP project Flutter\n` +
    `3️⃣ Kirim nama aplikasi baru\n` +
    `4️⃣ Bot kirim balik ZIP dengan nama sudah diganti` +
    `</blockquote>\n\n` +
    `<b>🔤 Rename All Name</b>\n` +
    `<blockquote>` +
    `1️⃣ Klik <b>🔤 Rename All Name</b>\n` +
    `2️⃣ Kirim ZIP project Flutter\n` +
    `3️⃣ Kirim nama/teks lama yang mau dicari (contoh: <code>TOKO KLONTONG ZIPER</code>)\n` +
    `4️⃣ Kirim nama/teks baru penggantinya (contoh: <code>TOKO KLONTONG ZENOS</code>)\n` +
    `5️⃣ Bot cari &amp; ganti SEMUA kemunculan teks itu di file <code>.dart</code>, lalu kirim balik ZIP hasil` +
    `</blockquote>\n\n` +
    `<b>🚀 Deploy Web ke Vercel</b>\n` +
    `<blockquote>` +
    `1️⃣ Klik <b>🚀 Deploy Web</b>\n` +
    `2️⃣ Ketik nama subdomain (jadi nama.vercel.app)\n` +
    `3️⃣ Kirim file <code>.html</code> tunggal atau <code>.zip</code> project web\n` +
    `4️⃣ Bot otomatis push GitHub &amp; deploy Vercel\n` +
    `5️⃣ Dapat link production siap pakai` +
    `</blockquote>\n\n` +
    `<b>🔐 Enkripsi HTML/JS</b>\n` +
    `<blockquote>` +
    `1️⃣ Klik <b>🔐 Enkripsi</b>\n` +
    `2️⃣ Pilih HTML (Base64/Obfuscate/Dekripsi) atau JS (15+ mode)\n` +
    `3️⃣ Kirim file, hasil dikirim otomatis` +
    `</blockquote>\n\n` +
    `<b>📋 Ketentuan</b>\n` +
    `<blockquote>` +
    `• Maks <b>1 build aktif</b> per user\n` +
    `• Maks ukuran ZIP: <b>2 GB</b>\n` +
    `• Timeout build: <b>${Math.round(CONFIG.BUILD_TIMEOUT_MS / 60000)} menit</b>` +
    `</blockquote>`,
    btns,
    delId
  );
}

// Daftar command admin/owner mentah — dipisah dari /help biar tampilan
// untuk user biasa gak berantakan. Cuma bisa diakses lewat tombol
// "🛠️ Command List (Admin)" di Admin/Owner Panel, khusus privileged user.
async function handleAdminCommandList(chatId, userId, msgId = null) {
  if (!isPrivileged(userId)) return sendHtml(chatId, `❌ <b>Akses ditolak!</b>`);

  let text =
    `<b>🛠️ COMMAND LIST — ADMIN &amp; OWNER</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>🤝 Perintah Reseller &amp; Admin</b>\n` +
    `<blockquote>` +
    `/broadcast — Kirim pesan ke semua user\n` +
    `/addcredit &lt;id&gt; &lt;jumlah&gt; — Tambah credit user` +
    `</blockquote>\n\n` +
    `<b>🔑 Perintah Admin (khusus Admin &amp; Owner)</b>\n` +
    `<blockquote>` +
    `/addreseller &lt;id&gt; — Tambah reseller\n` +
    `/removereseller &lt;id&gt; — Hapus reseller\n` +
    `/searchuser &lt;query&gt; — Cari user\n` +
    `/userinfo &lt;id&gt; — Info detail user\n` +
    `/deleteuser &lt;id&gt; — Hapus user dari DB\n` +
    `/banuser &lt;id&gt; [alasan] — Ban user\n` +
    `/unbanuser &lt;id&gt; — Unban user\n` +
    `/dmuser &lt;id&gt; &lt;pesan&gt; — Kirim DM ke user\n` +
    `/exportusers — Export CSV semua user\n` +
    `/buildhistory — Riwayat build\n` +
    `/killbuild &lt;id&gt; — Force kill build user` +
    `</blockquote>`;

  if (isOwner(userId)) {
    text += `\n\n<b>👑 Perintah Owner</b>\n` +
      `<blockquote>` +
      `/addadmin &lt;id&gt; — Tambah admin\n` +
      `/removeadmin &lt;id&gt; — Hapus admin\n` +
      `/addwolker title|repo|token — Tambah worker GitHub (build APK)\n` +
      `/listworkergithub — Lihat daftar worker GitHub\n` +
      `/removeworkergithub &lt;id&gt; — Hapus worker GitHub` +
      `</blockquote>`;
  }

  const btns = [[{ text: "🖥️ Kelola GitHub Worker", data: "admin_gh_workers" }]];
  if (isOwner(userId)) btns.push([{ text: "◀ Owner Panel", data: "admin_panel" }]);
  else btns.push([{ text: "◀ Admin Panel", data: "admin_panel" }]);

  if (msgId) return editHtml(chatId, msgId, text, btns);
  return sendHtml(chatId, text, btns);
}

// ─── WEB2APK ────────────────────────────────────────────────────────────────
async function handleWeb2Apk(chatId, userId, delId = null) {
  if (CONFIG.WEB2APK_MAINTENANCE) {
    await sendHtml(chatId,
      `🛠️ <b>Fitur Dalam Maintenance</b>\n\n` +
      `<blockquote>Fitur Web to APK sementara ditutup untuk peningkatan sistem.\n\nGunakan Build APK biasa untuk sementara.</blockquote>`,
      [[{ text: "🏠 Menu Utama", data: "start", style: "Danger" }]], delId
    );
    return;
  }
  if (isUserBuilding(userId)) {
    const job = getUserJob(userId);
    await sendHtml(chatId,
      `⚠️ <b>Build Aktif!</b>\n\n<blockquote>Status: ${statusLabel(job.status)}\n\nTunggu selesai atau batalkan dulu.</blockquote>`,
      [[{ text: "❌ Batalkan Build", data: "cancel" }]], delId
    );
    return;
  }

  let username = null, fullName = "Unknown User";
  try {
    const e = await client.getEntity(userId);
    username = e?.username || null;
    fullName = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown User";
  } catch (_) {}

  const priority = getUserPriority(userId);
  setUserJob(userId, { status: "waiting_url", chatId, userId, username, fullName, type: "web2apk", updatedAt: Date.now(), priority });

  const prioMsg = priority === 1 ? `\n\n<blockquote>👑 <b>OWNER PRIORITY (Level 1)</b></blockquote>`
    : priority === 2           ? `\n\n<blockquote>🤝 <b>RESELLER PRIORITY (Level 2)</b></blockquote>`
    : "";

  await sendHtml(chatId,
    `🌐 <b>Web to APK — Langkah 1/3</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Kirim <b>URL website</b> yang ingin dijadikan APK.${prioMsg}\n\n` +
    `<blockquote>📌 Contoh: <code>https://example.com</code></blockquote>`,
    [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], delId
  );
}

async function handleWeb2ApkUrl(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const text   = event.message.text?.trim();
  const job    = getUserJob(userId);
  if (!job || job.status !== "waiting_url" || job.type !== "web2apk") return;
  try { new URL(text); } catch {
    await sendHtml(chatId, `❌ <b>URL tidak valid!</b>\n\n<blockquote>Contoh: <code>https://example.com</code></blockquote>`);
    return;
  }
  setUserJob(userId, { ...job, status: "waiting_appname", webUrl: text, updatedAt: Date.now() });
  await sendHtml(chatId,
    `✅ <b>URL Tersimpan!</b>\n\n` +
    `🌐 <b>Web to APK — Langkah 2/3</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Kirim <b>nama aplikasi</b> yang diinginkan.\n\n` +
    `<blockquote>📌 Contoh: <code>Toko Online Saya</code></blockquote>`,
    [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]]
  );
}

async function handleWeb2ApkName(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const text   = event.message.text?.trim();
  const job    = getUserJob(userId);
  if (!job || job.status !== "waiting_appname" || job.type !== "web2apk") return;
  setUserJob(userId, { ...job, status: "waiting_icon", appName: text, updatedAt: Date.now() });
  await sendHtml(chatId,
    `✅ <b>Nama App Tersimpan!</b>\n\n` +
    `🌐 <b>Web to APK — Langkah 3/3</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Kirim <b>foto/logo</b> untuk icon APK.\n\n` +
    `<blockquote>📌 Tips:\n• Kirim sebagai foto atau file gambar\n• Disarankan ukuran 1:1 (persegi)\n• Format: PNG, JPG</blockquote>`,
    [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]]
  );
}

async function handleWeb2ApkIcon(event) {
  const chatId = event.chatId;
  const userId = Number(event.message.senderId);
  const job    = getUserJob(userId);
  if (!job || job.status !== "waiting_icon" || job.type !== "web2apk") return false;
  const media = event.message.media;
  if (!media) return false;
  if (!media.photo && !media.document) {
    await sendHtml(chatId, `⚠️ <b>Kirim ikon dalam bentuk Foto atau File Gambar!</b>`);
    return true;
  }

  if (!(await requireAndSpendCredit(chatId, userId))) { removeUserJob(userId); return true; }

  const worker = githubWorkers.pickWorkerRoundRobin();
  if (!worker) {
    credits.addCredits(userId, CREDIT_COST); // refund
    removeUserJob(userId);
    await sendHtml(chatId,
      `⚠️ <b>Belum Ada Worker GitHub!</b>\n\n<blockquote>Owner belum menambahkan worker GitHub Actions. Hubungi admin.</blockquote>`
    );
    return true;
  }

  const statusMsg = await sendHtml(chatId,
    `⚙️ <b>Memproses Web to APK...</b>\n\n` +
    `<blockquote>🌐 URL  : <code>${job.webUrl}</code>\n📱 Nama : <code>${job.appName}</code>\n\n🔥 Memproses icon...</blockquote>`
  );
  const msgId = statusMsg.id;

  try {
    if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
    const iconPath = tmpPath(`icon_${userId}_${Date.now()}.png`);
    await client.downloadMedia(event.message, { outputFile: iconPath });
    await editHtml(chatId, msgId,
      `⚙️ <b>Memproses Web to APK...</b>\n\n` +
      `<blockquote>🌐 URL  : <code>${job.webUrl}</code>\n📱 Nama : <code>${job.appName}</code>\n\n☁️ Menyiapkan aset di GitHub Release...</blockquote>`
    );
    const tag = genTag(userId);
    const { releaseId: iconReleaseId, uploadUrl } = await createReleaseOnly(worker, tag);
    await uploadAssetFile(worker, uploadUrl, iconPath, "icon.png", "image/png");
    if (fs.existsSync(iconPath)) fs.unlinkSync(iconPath);
    const iconUrl = await publishRelease(worker, iconReleaseId);
    if (!iconUrl) throw new Error("URL icon gagal diambil!");
    const runId = await triggerWeb2ApkWorkflow(worker, job.webUrl, job.appName, iconUrl);
    setUserJob(userId, { ...job, status: "building", workerId: worker.id, releaseId: null, iconReleaseId, runId, msgId, buildStart: Date.now(), updatedAt: Date.now() });
    await editHtml(chatId, msgId,
      `⚙️ <b>Build Web to APK Dimulai!</b>\n\n` +
      `<blockquote>🌐 URL  : <code>${job.webUrl}</code>\n📱 Nama : <code>${job.appName}</code>\n🆔 Run  : <code>${runId}</code>\n\n🔍 Memantau progress...</blockquote>`
    );
    monitorBuild(userId, chatId, msgId, runId, null).catch(async err => {
      removeUserJob(userId);
      credits.addCredits(userId, CREDIT_COST); // refund
      await editHtml(chatId, msgId, `❌ <b>Error Build Server!</b>\n\n<blockquote>${err.message}</blockquote>`);
    });
  } catch (err) {
    removeUserJob(userId);
    credits.addCredits(userId, CREDIT_COST); // refund
    await editHtml(chatId, msgId, `❌ <b>Gagal Memproses Asset!</b>\n\n<blockquote>${err.message}</blockquote>`);
  }
  return true;
}

// ─── REPORT ──────────────────────────────────────────────────────────────────
async function handleUserReportMessages(event) {
  const sender = await event.message.getSender();
  const userId = Number(sender?.id);
  const chatId = event.chatId;
  const state  = userStates.get(userId);
  if (!state) return false;

  if (state.step === "WAITING_FOR_REASON") {
    if (!event.message.text || event.message.text.length < 10) {
      await client.sendMessage(chatId, {
        message: "⚠️ **Mohon berikan alasan yang lebih detail (minimal 10 karakter).**",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]]),
        parseMode: "md"
      });
      return true;
    }
    userStates.set(userId, { step: "WAITING_FOR_SCREENSHOT", reason: event.message.text });
    await client.sendMessage(chatId, {
      message: "📸 **BUKTI SCREENSHOT**\n\nKirimkan **1 Foto/Screenshot** bukti pendukung.",
      parseMode: "md",
      buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]])
    });
    return true;
  }

  if (state.step === "WAITING_FOR_SCREENSHOT") {
    if (!event.message.media || !event.message.media.isPhoto) {
      await client.sendMessage(chatId, {
        message: "⚠️ **Format salah! Kirimkan bukti berupa Foto/Gambar.**",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]]),
        parseMode: "md"
      });
      return true;
    }
    const username = sender?.username ? `@${sender.username}` : "—";
    const name     = sender?.firstName || "User";
    try {
      const reportPath = tmpPath(`report_${userId}_${Date.now()}.jpg`);
      await client.downloadMedia(event.message, { outputFile: reportPath });
      await client.sendMessage(CONFIG.CHANNEL_USERNAME, {
        message:
          `🚨 <b>LAPORAN MASUK</b>\n\n` +
          `<blockquote>` +
          `👤 Nama    : ${name}\n` +
          `🆔 ID      : <code>${userId}</code>\n` +
          `🌐 Username: ${username}\n\n` +
          `📝 Alasan:\n${state.reason}` +
          `</blockquote>`,
        file: reportPath,
        parseMode: "html",
        buttons: buildButtons([
          [{ text: "✅ Selesai", data: `adm_fix_${userId}` }],
          [{ text: "🔒 Blokir", data: `adm_blk_${userId}` }, { text: "🔓 Unblokir", data: `adm_unblk_${userId}` }]
        ])
      });
      if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
      await client.sendMessage(chatId, {
        message: `✅ **Laporan Terkirim!**\n\nTerima kasih, laporan kamu sudah masuk ke sistem admin.`,
        parseMode: "md"
      });
    } catch (e) {
      await client.sendMessage(chatId, { message: "❌ Gagal mengirim laporan." });
    }
    userStates.delete(userId);
    return true;
  }
  return false;
}

// ─── ADMIN COMMANDS ──────────────────────────────────────────────────────────
async function handleAddReseller(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, `❌ <b>Akses ditolak!</b>`); return; }
  if (!targetId) { await sendHtml(chatId, `➕ <b>Tambah Reseller</b>\n\n<blockquote>Gunakan: <code>/addreseller 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (isNaN(num)) { await sendHtml(chatId, `❌ <b>ID tidak valid!</b>`); return; }
  const info = db.getUserById(num);
  if (rdb.add(num, info?.username, userId)) {
    await sendHtml(chatId, `✅ <b>Reseller ditambahkan!</b>\n\n<blockquote>🆔 ID: <code>${num}</code>\n👤 Username: ${info?.username || "—"}\n🎯 Priority Level 2</blockquote>`);
    try { await client.sendMessage(num, { message: `🎉 **SELAMAT!**\n\nKamu sekarang menjadi **RESELLER** dari ${CONFIG.BOT_NAME}!\n\n✨ Priority Level 2 - Build diprioritaskan!`, parseMode: "md" }); } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ <b>User ID <code>${num}</code> sudah menjadi reseller.</b>`);
  }
}

async function handleRemoveReseller(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, `❌ <b>Akses ditolak!</b>`); return; }
  if (!targetId) { await sendHtml(chatId, `➖ <b>Hapus Reseller</b>\n\n<blockquote>Gunakan: <code>/removereseller 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (rdb.remove(num)) {
    await sendHtml(chatId, `✅ <b>Reseller dihapus!</b>\n\n<blockquote>🆔 ID: <code>${num}</code></blockquote>`);
    try { await client.sendMessage(num, { message: `⚠️ **PEMBERITAHUAN**\n\nStatus reseller kamu telah dicabut.`, parseMode: "md" }); } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ <b>ID <code>${num}</code> bukan reseller.</b>`);
  }
}

// ─── ADMIN (owner-only management) ──────────────────────────────────────────
async function handleAddAdmin(chatId, userId, targetId) {
  if (!isOwner(userId)) { await sendHtml(chatId, `❌ <b>Hanya Owner yang bisa menambah Admin!</b>`); return; }
  if (!targetId) { await sendHtml(chatId, `➕ <b>Tambah Admin</b>\n\n<blockquote>Gunakan: <code>/addadmin 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (isNaN(num)) { await sendHtml(chatId, `❌ <b>ID tidak valid!</b>`); return; }
  if (isOwner(num)) { await sendHtml(chatId, `❌ <b>User ini sudah Owner!</b>`); return; }
  const info = db.getUserById(num);
  if (adb.add(num, info?.username, userId)) {
    await sendHtml(chatId, `✅ <b>Admin ditambahkan!</b>\n\n<blockquote>🆔 ID: <code>${num}</code>\n👤 Username: ${info?.username || "—"}\n🔑 Role: ADMIN</blockquote>`);
    try { await client.sendMessage(num, { message: `🎉 **SELAMAT!**\n\nKamu sekarang menjadi **ADMIN** dari ${CONFIG.BOT_NAME}!\n\n🔑 Kamu bisa: Add Reseller, Add Credit, Broadcast.`, parseMode: "md" }); } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ <b>User ID <code>${num}</code> sudah menjadi admin.</b>`);
  }
}

async function handleRemoveAdmin(chatId, userId, targetId) {
  if (!isOwner(userId)) { await sendHtml(chatId, `❌ <b>Hanya Owner yang bisa menghapus Admin!</b>`); return; }
  if (!targetId) { await sendHtml(chatId, `➖ <b>Hapus Admin</b>\n\n<blockquote>Gunakan: <code>/removeadmin 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (adb.remove(num)) {
    await sendHtml(chatId, `✅ <b>Admin dihapus!</b>\n\n<blockquote>🆔 ID: <code>${num}</code></blockquote>`);
    try { await client.sendMessage(num, { message: `⚠️ **PEMBERITAHUAN**\n\nStatus admin kamu telah dicabut.`, parseMode: "md" }); } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ <b>ID <code>${num}</code> bukan admin (yang ditambah lewat bot). Admin dari ENV config tidak bisa dihapus lewat sini.</b>`);
  }
}

// ─── WORKER GITHUB (owner-only) ─────────────────────────────────────────────
async function handleListWorkerGithub(chatId, msgId = null) {
  const workers = githubWorkers.listWorkers();

  const header =
    `🖥️ <b>GitHub Worker</b>\n${DIV_HTML}\n\n` +
    `<blockquote>Tambah worker baru pakai command:\n<code>/addwolker title|repo|token</code></blockquote>\n\n`;

  if (workers.length === 0) {
    const text = header + `<i>Belum ada worker terdaftar.</i>`;
    const btns = [[{ text: "◀ Admin Panel", data: "admin_panel" }]];
    return msgId ? editHtml(chatId, msgId, text, btns) : sendHtml(chatId, text, btns);
  }

  const list = workers.map((w, i) =>
    `${i + 1}. <b>${w.label}</b> ${w.enabled === false ? "🔴 (nonaktif)" : "🟢"}\n` +
    `   🆔 <code>${w.id}</code>\n` +
    `   📦 <code>${w.repo}</code>`
  ).join("\n\n");

  const text = header + list;
  const btns = workers.map(w => [{ text: `🗑️ Hapus: ${w.label}`, data: `admin_gh_del_${w.id}`, style: "Danger" }]);
  btns.push([{ text: "◀ Admin Panel", data: "admin_panel" }]);

  return msgId ? editHtml(chatId, msgId, text, btns) : sendHtml(chatId, text, btns);
}

async function handleRemoveWorkerGithub(chatId, workerId, msgId = null) {
  if (!workerId) {
    const text = `➖ <b>Hapus Worker GitHub</b>\n\n<blockquote>Gunakan: <code>/removeworkergithub gh-xxxxx</code>\n\nLihat ID lewat tombol 🖥️ GitHub Worker di Admin Panel.</blockquote>`;
    return msgId ? editHtml(chatId, msgId, text) : sendHtml(chatId, text);
  }
  const ok = githubWorkers.removeWorker(workerId);
  const text = ok
    ? `✅ <b>Worker GitHub dihapus!</b>\n\n<blockquote>🆔 ID: <code>${workerId}</code></blockquote>`
    : `❌ <b>Worker dengan ID <code>${workerId}</code> tidak ditemukan.</b>`;

  if (msgId) {
    await editHtml(chatId, msgId, text);
    await sleep(1200);
    return handleListWorkerGithub(chatId, msgId);
  }
  return sendHtml(chatId, text);
}

// ─── LIST USERS ──────────────────────────────────────────────────────────────
async function handleListUsers(chatId, userId, page = 1, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }

  const all      = db.getAllUsers();
  const perPage  = 8;
  const total    = Math.max(1, Math.ceil(all.length / perPage));
  page           = Math.min(Math.max(1, page), total);
  const slice    = all.slice((page - 1) * perPage, page * perPage);

  let text =
    `<b>👥 DAFTAR USER (${all.length})</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Halaman ${page}/${total}</i>\n\n`;

  slice.forEach((u, i) => {
    const role    = roleTag(u.userId);
    const isRes   = rdb.isReseller(u.userId);
    const isBan   = bdb.isBanned(u.userId);
    const joinStr = fmtDate(u.joinedAt);
    text +=
      `<b>${(page - 1) * perPage + i + 1}. ${role}${isBan ? " 🚫" : ""}</b>\n` +
      `<blockquote>` +
      `🆔 ID       : <code>${u.userId}</code>\n` +
      `👤 Nama     : ${u.name || "Unknown"}\n` +
      `🌐 Username : ${u.username || "—"}\n` +
      `📅 Join     : ${joinStr}` +
      `</blockquote>\n`;
  });

  const nav = [];
  if (page > 1)    nav.push({ text: "◀️ Prev", data: `listusers_page_${page - 1}` });
  nav.push({ text: `📄 ${page}/${total}`, data: "noop" });
  if (page < total) nav.push({ text: "Next ▶️", data: `listusers_page_${page + 1}` });

  const btns = [
    nav,
    [{ text: "🔍 Cari User", data: "admin_search_user" }, { text: "📤 Export", data: "admin_export_users" }],
    [{ text: "◀ Admin Panel", data: "admin_panel" }],
  ];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── LIST RESELLERS ──────────────────────────────────────────────────────────
async function handleListResellers(chatId, userId, page = 1, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }

  const all     = rdb.all();
  const perPage = 8;
  const total   = Math.max(1, Math.ceil(all.length / perPage));
  page          = Math.min(Math.max(1, page), total);
  const slice   = all.slice((page - 1) * perPage, page * perPage);

  let text =
    `<b>🤝 DAFTAR RESELLER (${all.length})</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Halaman ${page}/${total}</i>\n\n`;

  if (all.length === 0) {
    text += `<i>Belum ada reseller yang terdaftar.</i>`;
  } else {
    slice.forEach((r, i) => {
      text +=
        `<b>${(page - 1) * perPage + i + 1}. 🤝 RESELLER</b>\n` +
        `<blockquote>` +
        `🆔 ID          : <code>${r.userId}</code>\n` +
        `🌐 Username    : ${r.username || "—"}\n` +
        `📅 Ditambahkan : ${fmtDate(r.addedAt)}\n` +
        `🎯 Priority    : Level 2` +
        `</blockquote>\n`;
    });
  }

  const nav = [];
  if (page > 1)    nav.push({ text: "◀️ Prev", data: `listresellers_page_${page - 1}` });
  nav.push({ text: `📄 ${page}/${total}`, data: "noop" });
  if (page < total) nav.push({ text: "Next ▶️", data: `listresellers_page_${page + 1}` });

  const btns = [nav, [{ text: "◀ Admin Panel", data: "admin_panel" }]];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── BUILD HISTORY ───────────────────────────────────────────────────────────
async function handleBuildHistory(chatId, userId, page = 1, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }

  const all     = hdb.all();
  const perPage = 6;
  const total   = Math.max(1, Math.ceil(all.length / perPage));
  page          = Math.min(Math.max(1, page), total);
  const slice   = all.slice((page - 1) * perPage, page * perPage);

  let text =
    `<b>📋 RIWAYAT BUILD (${all.length})</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Halaman ${page}/${total}</i>\n\n`;

  if (all.length === 0) {
    text += `<i>Belum ada riwayat build.</i>`;
  } else {
    slice.forEach((h, i) => {
      const statusIcon = h.status === "success" ? "✅" : h.status === "timeout" ? "⏱️" : "❌";
      text +=
        `<b>${(page - 1) * perPage + i + 1}. ${statusIcon} ${h.status.toUpperCase()}</b>\n` +
        `<blockquote>` +
        `👤 User    : ${h.userName || `ID:${h.userId}`}\n` +
        `📦 Project : <code>${h.project || "—"}</code>\n` +
        `🔧 Mode    : ${h.mode || "—"}\n` +
        (h.apkSize  ? `💾 APK     : <code>${h.apkSize} MB</code>\n` : "") +
        (h.duration ? `⏱ Durasi  : <code>${formatDuration(h.duration)}</code>\n` : "") +
        `📅 Waktu   : ${fmtDateTime(h.at)}` +
        `</blockquote>\n`;
    });
  }

  const cs   = db.getStats();
  const tot  = cs.success + cs.failed;
  const rate = tot > 0 ? ((cs.success / tot) * 100).toFixed(1) : "0.0";
  text +=
    `\n<blockquote>` +
    `✅ Total Sukses : <b>${cs.success}</b>\n` +
    `❌ Total Gagal  : <b>${cs.failed}</b>\n` +
    `📈 Success Rate : <b>${rate}%</b>` +
    `</blockquote>`;

  const nav = [];
  if (page > 1)    nav.push({ text: "◀️ Prev", data: `buildhistory_page_${page - 1}` });
  nav.push({ text: `📄 ${page}/${total}`, data: "noop" });
  if (page < total) nav.push({ text: "Next ▶️", data: `buildhistory_page_${page + 1}` });

  const btns = [nav, [{ text: "◀ Admin Panel", data: "admin_panel" }]];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── SEARCH USER ─────────────────────────────────────────────────────────────
async function handleSearchUser(chatId, userId, query) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!query) {
    await sendHtml(chatId,
      `🔍 <b>Cari User</b>\n\n` +
      `<blockquote>Gunakan:\n<code>/searchuser 123456789</code>\n<code>/searchuser @username</code>\n<code>/searchuser nama</code></blockquote>`
    );
    return;
  }
  const results = db.searchUsers(query);
  if (results.length === 0) {
    await sendHtml(chatId,
      `🔍 <b>Hasil Pencarian</b>\n\n<blockquote>Tidak ada user cocok dengan: <code>${query}</code></blockquote>`,
      [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
    );
    return;
  }
  let text = `🔍 <b>Hasil Pencarian "${query}" (${results.length})</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  results.slice(0, 10).forEach(u => {
    text +=
      `<b>${roleTag(u.userId)}${bdb.isBanned(u.userId) ? " 🚫" : ""}</b>\n` +
      `<blockquote>` +
      `🆔 ID       : <code>${u.userId}</code>\n` +
      `👤 Nama     : ${u.name || "Unknown"}\n` +
      `🌐 Username : ${u.username || "—"}\n` +
      `📅 Join     : ${fmtDate(u.joinedAt)}` +
      `</blockquote>\n`;
  });
  if (results.length > 10) text += `\n<i>+${results.length - 10} hasil lainnya</i>`;
  await sendHtml(chatId, text, [[{ text: "◀ Admin Panel", data: "admin_panel" }]]);
}

// ─── USER INFO ──────────────────────────────────────────────────────────────
async function handleUserInfo(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!targetId) {
    await sendHtml(chatId,
      `ℹ️ <b>Info User</b>\n\n<blockquote>Gunakan: <code>/userinfo 123456789</code></blockquote>`
    );
    return;
  }
  const num  = Number(targetId);
  const u    = db.getUserById(num);
  if (!u) { await sendHtml(chatId, `❌ <b>User ID <code>${num}</code> tidak ditemukan!</b>`); return; }

  const isRes = rdb.isReseller(num);
  const isBan = bdb.isBanned(num);
  const ban   = isBan ? bdb.getInfo(num) : null;
  const job   = getUserJob(num);

  let tgInfo = "—";
  try {
    const e = await client.getEntity(num);
    tgInfo  = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "—";
  } catch (_) {}

  const text =
    `ℹ️ <b>INFO USER</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<blockquote>` +
    `🆔 ID           : <code>${num}</code>\n` +
    `👤 Nama (DB)    : ${u.name || "Unknown"}\n` +
    `👤 Nama (TG)    : ${tgInfo}\n` +
    `🌐 Username     : ${u.username || "—"}\n` +
    `🏅 Role         : ${roleTag(num)}\n` +
    `📅 Join         : ${fmtDateTime(u.joinedAt)}\n` +
    `⏰ Last Active  : ${fmtDateTime(u.lastActive)}\n` +
    `🤝 Reseller     : ${isRes ? "✅ Ya" : "❌ Tidak"}\n` +
    `🚫 Status Ban   : ${isBan ? `🔴 Dibanned\n📋 Alasan: ${ban?.reason || "—"}\n📅 Dibanned: ${fmtDate(ban?.bannedAt)}` : "🟢 Normal"}\n` +
    `⚙️ Build Aktif  : ${job ? `✅ ${statusLabel(job.status)}` : "❌ Tidak ada"}` +
    `</blockquote>`;

  const btns = [
    isRes
      ? [{ text: "➖ Remove Reseller", data: `adm_rm_reseller_${num}` }]
      : [{ text: "➕ Add Reseller", data: `adm_add_reseller_${num}` }],
    isBan
      ? [{ text: "✅ Unban User", data: `adm_unban_${num}` }]
      : [{ text: "🚫 Ban User", data: `adm_ban_${num}` }],
    [{ text: "◀ Admin Panel", data: "admin_panel" }],
  ];

  await sendHtml(chatId, text, btns);
}

// ─── BAN / UNBAN ─────────────────────────────────────────────────────────────
async function handleBanUser(chatId, userId, args) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!args) {
    await sendHtml(chatId, `🚫 <b>Ban User</b>\n\n<blockquote>Gunakan: <code>/banuser 123456789 alasan ban</code></blockquote>`);
    return;
  }
  const parts  = args.trim().split(/\s+/);
  const num    = Number(parts[0]);
  const reason = parts.slice(1).join(" ") || "Melanggar ketentuan";
  if (isNaN(num))     { await sendHtml(chatId, "❌ ID tidak valid!"); return; }
  if (isOwner(num))   { await sendHtml(chatId, "❌ Tidak bisa ban Owner!"); return; }
  if (bdb.ban(num, reason, userId)) {
    await sendHtml(chatId,
      `🚫 <b>User Dibanned!</b>\n\n` +
      `<blockquote>🆔 ID     : <code>${num}</code>\n📋 Alasan : ${reason}</blockquote>`,
      [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
    );
    try {
      await client.sendMessage(num, {
        message: `🚫 **AKUN ANDA DIBANNED**\n\nKamu tidak bisa menggunakan bot ini.\n\n📋 Alasan: ${reason}\n\nHubungi admin jika ini kesalahan.`,
        parseMode: "md"
      });
    } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ User ID <code>${num}</code> sudah dalam status ban.`);
  }
}

async function handleUnbanUser(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!targetId) {
    await sendHtml(chatId, `✅ <b>Unban User</b>\n\n<blockquote>Gunakan: <code>/unbanuser 123456789</code></blockquote>`);
    return;
  }
  const num = Number(targetId);
  if (bdb.unban(num)) {
    await sendHtml(chatId,
      `✅ <b>User Diunban!</b>\n\n<blockquote>🆔 ID: <code>${num}</code></blockquote>`,
      [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
    );
    try {
      await client.sendMessage(num, {
        message: `✅ **AKSES DIKEMBALIKAN**\n\nAkun kamu telah diunban. Kamu bisa menggunakan bot ini kembali.`,
        parseMode: "md"
      });
    } catch (_) {}
  } else {
    await sendHtml(chatId, `❌ User ID <code>${num}</code> tidak sedang dalam status ban.`);
  }
}

// ─── KILL BUILD ──────────────────────────────────────────────────────────────
async function handleListBuildsForKill(chatId, userId, editId = null) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  const jobs = getSortedActiveJobs();

  let text =
    `💀 <b>FORCE KILL BUILD</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (jobs.length === 0) {
    text += `<i>Tidak ada build aktif saat ini.</i>`;
    const btns = [[{ text: "◀ Admin Panel", data: "admin_panel" }]];
    editId
      ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
      : await sendHtml(chatId, text, btns);
    return;
  }

  text += `<i>Pilih build yang ingin dihentikan paksa:</i>\n\n`;
  jobs.forEach((j, i) => {
    const usr = j.fullName && j.fullName !== "Unknown User" ? j.fullName : (j.username ? `@${j.username}` : `User_${j.userId}`);
    text +=
      `${i + 1}. <b>${roleTag(j.userId)}</b> — ${usr}\n` +
      `<blockquote>Status: ${statusLabel(j.status)}  |  ${formatDuration(elapsedSec(j.updatedAt))}</blockquote>\n`;
  });

  const btns = [
    ...jobs.map(j => {
      const usr = j.fullName && j.fullName !== "Unknown User" ? j.fullName.split(" ")[0] : (j.username || `U${j.userId}`);
      return [{ text: `💀 Kill: ${usr}`, data: `kill_build_${j.userId}` }];
    }),
    [{ text: "◀ Admin Panel", data: "admin_panel" }],
  ];

  editId
    ? await client.editMessage(chatId, { message: editId, text, buttons: buildButtons(btns), parseMode: "html" })
    : await sendHtml(chatId, text, btns);
}

// ─── DELETE USER / EXPORT / DM ──────────────────────────────────────────────
async function handleDeleteUser(chatId, userId, targetId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!targetId) { await sendHtml(chatId, `🗑️ <b>Hapus User</b>\n\n<blockquote>Gunakan: <code>/deleteuser 123456789</code></blockquote>`); return; }
  const num = Number(targetId);
  if (isNaN(num))   { await sendHtml(chatId, "❌ ID tidak valid!"); return; }
  if (isOwner(num)) { await sendHtml(chatId, "❌ Tidak bisa menghapus Owner!"); return; }
  const u = db.getUserById(num);
  if (!u) { await sendHtml(chatId, `❌ User ID <code>${num}</code> tidak ditemukan.`); return; }
  db.deleteUser(num);
  rdb.remove(num);
  await sendHtml(chatId,
    `✅ <b>User Dihapus!</b>\n\n<blockquote>🆔 ID: <code>${num}</code>\n👤 Nama: ${u.name || "Unknown"}</blockquote>`,
    [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
  );
}

async function handleExportUsers(chatId, userId) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  const all  = db.getAllUsers();
  const res  = rdb.all();
  const ban  = bdb.all();
  const hdrs = ["No","User ID","Nama","Username","Role","Reseller","Banned","Join Date","Last Active"];
  const rows = all.map((u, i) => {
    const isRes = res.some(r => r.userId === u.userId);
    const isBan = ban.some(b => b.userId === u.userId);
    const role  = isOwner(u.userId) ? "OWNER" : isRes ? "RESELLER" : isAdmin(u.userId) ? "ADMIN" : "USER";
    return [i + 1, u.userId, u.name || "Unknown", u.username || "-", role, isRes ? "Ya" : "Tidak", isBan ? "Ya" : "Tidak", fmtDate(u.joinedAt), fmtDate(u.lastActive)];
  });
  const csv     = [hdrs, ...rows].map(r => r.join(",")).join("\n");
  const csvPath = tmpPath(`users_export_${Date.now()}.csv`);
  fs.writeFileSync(csvPath, csv, "utf-8");
  try {
    await client.sendFile(chatId, {
      file: csvPath,
      caption:
        `📤 <b>Export Database User</b>\n\n` +
        `<blockquote>📊 Total User    : ${all.length}\n🤝 Total Reseller: ${res.length}\n🚫 Total Banned  : ${ban.length}\n📅 Diekspor      : ${nowWib()}</blockquote>`,
      parseMode: "html",
      forceDocument: true,
    });
    if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
  } catch (e) {
    if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
    await sendHtml(chatId, `❌ Gagal export: <code>${e.message}</code>`);
  }
}

async function handleDmUser(chatId, userId, args) {
  if (!isPrivileged(userId)) { await sendHtml(chatId, "❌ Akses ditolak!"); return; }
  if (!args) { await sendHtml(chatId, `📣 <b>Kirim DM ke User</b>\n\n<blockquote>Gunakan: <code>/dmuser 123456789 pesan kamu</code></blockquote>`); return; }
  const parts = args.trim().split(/\s+/);
  const num   = Number(parts[0]);
  const msg   = parts.slice(1).join(" ");
  if (isNaN(num) || !msg) { await sendHtml(chatId, `❌ Format salah!\n\n<blockquote>Gunakan: <code>/dmuser 123456789 pesan</code></blockquote>`); return; }
  try {
    await client.sendMessage(num, { message: msg, parseMode: "md" });
    await sendHtml(chatId,
      `✅ <b>Pesan Terkirim!</b>\n\n<blockquote>🆔 Ke: <code>${num}</code>\n💬 Pesan: ${msg}</blockquote>`,
      [[{ text: "◀ Admin Panel", data: "admin_panel" }]]
    );
  } catch (e) {
    await sendHtml(chatId, `❌ Gagal kirim: <code>${e.message}</code>`);
  }
}

// ─── CALLBACK ────────────────────────────────────────────────────────────────
async function handleCallback(event) {
  try {
    const data   = event.data.toString();
    const chatId = event.chatId;
    const userId = Number(event.senderId);
    const msgId  = event.messageId;

    // Broadcast
    if (data.startsWith("broadcast_approve_")) {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      try { await client.sendMessage(parseInt(data.split("_")[2]), { message: `✅ **Broadcast disetujui Owner!**`, parseMode: "md" }); } catch (_) {}
      return await event.answer({ message: "✅ Disetujui!" });
    }
    if (data.startsWith("broadcast_reject_")) {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      try { await client.sendMessage(parseInt(data.replace("broadcast_reject_", "")), { message: `❌ **Broadcast ditolak Owner!**`, parseMode: "md" }); } catch (_) {}
      return await event.answer({ message: "❌ Ditolak!" });
    }

    // Noop
    if (data === "noop") return await event.answer();

    // ─── TOOLS: Cek Emoji pagination ───────────────────────────────────────
    if (data === "emoji_page_noop" || data.startsWith("emoji_page:")) {
      const handled = await handleEmojiPageCallback(event);
      if (handled) return;
    }

    // ─── TOOLS: info penggunaan (dari Tools Menu) ──────────────────────────
    if (data === "tool_get_info") {
      await event.answer();
      return await sendHtml(chatId,
        `<blockquote>⚠️ <b>Cara pakai /get:</b></blockquote>\n` +
        `<blockquote>/get https://example.com</blockquote>\n` +
        `<blockquote>📥 Bot akan mengunduh index.html, CSS, JS, gambar, font, dikemas jadi 1 ZIP.</blockquote>\n` +
        `<blockquote>⏱️ Proses ~20-40 detik</blockquote>`
      );
    }
    if (data === "tool_cekemoji_info") {
      await event.answer();
      return await sendHtml(chatId,
        `<blockquote>😀 <b>Cara pakai /cekemoji:</b></blockquote>\n` +
        `<blockquote>/cekemoji [kirim/reply emoji premium]</blockquote>\n` +
        `<blockquote>Bisa juga ketik <code>/cekemoji</code> doang, nanti bot minta kamu reply pesan yang ada emoji premium-nya.</blockquote>`
      );
    }

    // ─── CREDIT: Saldo saya + link referral ───────────────────────────────
    if (data === "credit_me") {
      await event.answer();
      const stats = credits.getReferralStats(userId);
      const { link } = await getReferralLink();
      const saldo = isPrivileged(userId) ? "♾️ Unlimited (Owner/Admin)" : `${stats.credits} Credit`;
      return await sendHtml(chatId,
        `💰 <b>Credit Saya</b>\n${DIV_HTML}\n\n` +
        `<blockquote>` +
        `💳 Saldo         : <b>${saldo}</b>\n` +
        `🎁 Teman Join    : <b>${stats.confirmedReferrals}</b> orang\n` +
        `⏳ Menunggu Join : <b>${stats.pendingReferrals}</b> orang\n\n` +
        `🔗 Link Undangan Kamu:\n<code>${link(userId)}</code>\n\n` +
        `Setiap 1 orang join lewat link kamu dan bergabung ke channel, kamu dapat <b>+${credits.REFERRAL_BONUS} credit</b> gratis!` +
        `</blockquote>`,
        [
          [{ text: "🛒 Beli / Redeem Credit", data: "credit_buy" }],
          [{ text: "🏠 Menu Utama", data: "start" }],
        ], msgId
      );
    }

    // ─── CREDIT: Menu beli / redeem ────────────────────────────────────────
    if (data === "credit_buy") {
      await event.answer();
      return await sendHtml(chatId,
        `🛒 <b>Beli / Redeem Credit</b>\n${DIV_HTML}\n\n` +
        `<blockquote>` +
        `Pilih paket di bawah untuk order manual ke admin, atau tukar kode redeem kalau kamu punya.\n\n` +
        `💡 Gratis: share link undangan kamu di menu <b>Credit Saya</b>!` +
        `</blockquote>`,
        buyCreditKeyboard(), msgId
      );
    }

    // Step 1: user pencet paket -> tampilkan konfirmasi pembelian
    if (data.startsWith("buy_") && CREDIT_PACKAGES[data.replace("buy_", "")]) {
      const pkgKey = data.replace("buy_", "");
      const pkg = CREDIT_PACKAGES[pkgKey];
      await event.answer();
      return await sendHtml(chatId,
        `🛒 <b>Konfirmasi Pembelian</b>\n${DIV_HTML}\n\n` +
        `<blockquote>📦 Paket : <b>${pkg.label}</b>\n💵 Harga : <b>${formatIDR(pkg.priceIDR)}</b></blockquote>\n\n` +
        `Lanjutkan pembelian?`,
        [
          [{ text: "✅ Konfirmasi", data: `buyconfirm_${pkgKey}` }],
          [{ text: "❌ Batal", data: "credit_buy", style: "Danger" }],
        ], msgId
      );
    }

    // Step 2: user konfirmasi -> pilih metode pembayaran
    if (data.startsWith("buyconfirm_")) {
      const pkgKey = data.replace("buyconfirm_", "");
      const pkg = CREDIT_PACKAGES[pkgKey];
      if (!pkg) return await event.answer({ message: "❌ Paket tidak valid.", alert: true });
      await event.answer();
      return await sendHtml(chatId,
        `💳 <b>Pilih Metode Pembayaran</b>\n${DIV_HTML}\n\n` +
        `<blockquote>📦 Paket : <b>${pkg.label}</b>\n💵 Harga : <b>${formatIDR(pkg.priceIDR)}</b></blockquote>`,
        [
          [{ text: "🇶 QRIS", data: `paymethod_${pkgKey}_qris` }, { text: "💗 DANA", data: `paymethod_${pkgKey}_dana` }],
          [{ text: "❌ Batal", data: "credit_buy", style: "Danger" }],
        ], msgId
      );
    }

    // Step 3: user pilih metode -> kirim notif ke admin utk ACC & minta admin siapkan pembayaran
    if (data.startsWith("paymethod_")) {
      const [, pkgKey, method] = data.match(/^paymethod_(.+)_(qris|dana)$/) || [];
      const pkg = pkgKey && CREDIT_PACKAGES[pkgKey];
      if (!pkg) return await event.answer({ message: "❌ Paket tidak valid.", alert: true });
      await event.answer();

      const orderId = `${userId}_${Date.now()}`;
      let name = "Unknown", buyerUname = "—";
      try {
        const e = await client.getEntity(userId);
        name = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown";
        buyerUname = e?.username ? `@${e.username}` : "—";
      } catch (_) {}

      pendingOrders.set(orderId, {
        userId, chatId, pkgKey, method, name, buyerUname,
        status: "waiting_admin_method_ack", createdAt: Date.now(),
      });

      // ── Auto-kirim QRIS/DANA dari config (kalau sudah diisi) ────────────
      // Ini yang bikin proses gak perlu admin kirim QRIS/nomor manual tiap
      // ada order — cukup diisi SEKALI di config.js.
      const pay = CONFIG.PAYMENT || {};
      const qrisReady = method === "qris" && pay.QRIS_IMAGE && fs.existsSync(pay.QRIS_IMAGE);
      const danaReady = method === "dana" && pay.DANA_NUMBER && pay.DANA_NUMBER !== "ISI_NOMOR_DANA_LU";

      if (qrisReady || danaReady) {
        const order = pendingOrders.get(orderId);
        order.status = "waiting_proof";
        try {
          if (qrisReady) {
            await client.sendFile(chatId, {
              file: pay.QRIS_IMAGE,
              caption:
                `🇶 <b>QRIS Pembayaran</b>\n${DIV_HTML}\n\n` +
                `<blockquote>📦 Paket : <b>${pkg.label}</b>\n💵 Total : <b>${formatIDR(pkg.priceIDR)}</b>\n\n` +
                `Scan QRIS di atas, lalu kirim <b>screenshot bukti transfer</b> ke sini.</blockquote>`,
              parseMode: "html",
            });
          } else {
            await sendHtml(chatId,
              `💗 <b>Pembayaran via DANA</b>\n${DIV_HTML}\n\n` +
              `<blockquote>📦 Paket : <b>${pkg.label}</b>\n💵 Total : <b>${formatIDR(pkg.priceIDR)}</b>\n` +
              `📱 No. DANA : <code>${pay.DANA_NUMBER}</code>\n👤 A/N : <b>${pay.DANA_NAME}</b>\n\n` +
              `Transfer ke nomor di atas, lalu kirim <b>screenshot bukti transfer</b> ke sini.</blockquote>`
            );
          }
        } catch (e) {
          console.error("Auto payment send error:", e.message);
        }
        modStates.set(userId, { step: "waiting_payment_proof", orderId, updatedAt: Date.now() });

        // Admin tetap dikasih tau ada order baru (buat dipantau), tapi TIDAK
        // perlu ngapa-ngapain sampai user kirim bukti transfer nanti.
        try {
          await client.sendMessage(CONFIG.OWNER_ID, {
            message:
              `🛒 <b>ORDER BARU (Auto-Payment)</b>\n${DIV_HTML}\n\n` +
              `<blockquote>👤 ${name} (${buyerUname})\n🆔 <code>${userId}</code>\n📦 Paket: <b>${pkg.label}</b>\n💵 Harga: <b>${formatIDR(pkg.priceIDR)}</b>\n💳 Metode: <b>${method.toUpperCase()}</b>\n\nQRIS/DANA sudah otomatis terkirim ke user. Tunggu bukti transfer masuk.</blockquote>`,
            parseMode: "html",
          });
        } catch (_) {}

        return await sendHtml(chatId,
          `⏳ <b>Menunggu Bukti Transfer</b>\n${DIV_HTML}\n\n<blockquote>Info pembayaran sudah dikirim di atas. Setelah transfer, kirim screenshot bukti transfer ke chat ini.</blockquote>`,
          null, msgId
        );
      }

      // ── Fallback lama: QRIS/DANA belum diisi di config, admin kirim manual ──

      try {
        await client.sendMessage(CONFIG.OWNER_ID, {
          message:
            `🛒 <b>PERMINTAAN BELI CREDIT</b>\n${DIV_HTML}\n\n` +
            `<blockquote>👤 ${name} (${buyerUname})\n🆔 <code>${userId}</code>\n📦 Paket: <b>${pkg.label}</b>\n💵 Harga: <b>${formatIDR(pkg.priceIDR)}</b>\n💳 Metode: <b>${method.toUpperCase()}</b></blockquote>`,
          parseMode: "html",
          buttons: buildButtons([
            [{ text: "✅ ACC", data: `orderacc_${orderId}` }],
            [{ text: "❌ Tolak", data: `orderreject_${orderId}` }],
          ]),
        });
      } catch (_) {}

      return await sendHtml(chatId,
        `⏳ <b>Menunggu Admin...</b>\n${DIV_HTML}\n\n` +
        `<blockquote>Permintaan pembayaran <b>${method.toUpperCase()}</b> sudah dikirim ke admin.\nTunggu sebentar, admin sedang menyiapkan ${method === "qris" ? "QRIS" : "nomor DANA"}.</blockquote>`,
        [[{ text: "🏠 Menu Utama", data: "start" }]], msgId
      );
    }

    // Admin ACC permintaan metode pembayaran
    if (data.startsWith("orderacc_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Hanya Admin/Owner!", alert: true });
      const orderId = data.replace("orderacc_", "");
      const order = pendingOrders.get(orderId);
      if (!order) return await event.answer({ message: "❌ Order tidak ditemukan/expired.", alert: true });

      await event.answer({ message: "✅ Diterima." });

      if (order.method === "qris") {
        // Admin diminta upload foto QRIS, reply ke pesan ini
        modStates.set(userId, { step: "waiting_qris_photo", orderId, updatedAt: Date.now() });
        await client.sendMessage(chatId, {
          message: `📤 <b>Kirim Foto QRIS</b>\n\n<blockquote>Kirim foto QRIS sekarang untuk diteruskan ke user (order <code>${orderId}</code>).</blockquote>`,
          parseMode: "html",
        });
      } else {
        // DANA: minta admin ketik nomor DANA
        modStates.set(userId, { step: "waiting_dana_number", orderId, updatedAt: Date.now() });
        await client.sendMessage(chatId, {
          message: `📤 <b>Kirim Nomor DANA</b>\n\n<blockquote>Ketik nomor DANA tujuan sekarang untuk diteruskan ke user (order <code>${orderId}</code>).</blockquote>`,
          parseMode: "html",
        });
      }
      return;
    }

    if (data.startsWith("orderreject_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Hanya Admin/Owner!", alert: true });
      const orderId = data.replace("orderreject_", "");
      const order = pendingOrders.get(orderId);
      await event.answer({ message: "❌ Ditolak." });
      if (order) {
        pendingOrders.delete(orderId);
        try { await client.sendMessage(order.chatId, { message: `❌ <b>Permintaan beli credit kamu ditolak admin.</b>`, parseMode: "html" }); } catch (_) {}
      }
      return;
    }

    // User kirim bukti TF -> notif ke admin utk ACC final
    if (data.startsWith("orderfinalacc_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Hanya Admin/Owner!", alert: true });
      const orderId = data.replace("orderfinalacc_", "");
      const order = pendingOrders.get(orderId);
      if (!order) return await event.answer({ message: "❌ Order tidak ditemukan/expired.", alert: true });

      const pkg = CREDIT_PACKAGES[order.pkgKey];
      await event.answer({ message: "✅ Disetujui!" });

      if (pkg.kind === "reseller") {
        rdb.add(order.userId, order.buyerUname !== "—" ? order.buyerUname.replace("@", "") : null, userId);
        try {
          await client.sendMessage(order.chatId, {
            message: `🎉 <b>Top Up Berhasil!</b>\n\n<blockquote>🤝 Kamu sekarang jadi <b>Reseller</b>!\n\n🙏 Terima kasih sudah support!</blockquote>`,
            parseMode: "html",
          });
        } catch (_) {}
        credits.addBuyer(order.userId, order.buyerUname, pkg.priceIDR, 0, userId);
      } else {
        credits.addCredits(order.userId, pkg.credits);
        try {
          await client.sendMessage(order.chatId, {
            message: `🎉 <b>Top Up Berhasil!</b>\n\n<blockquote>💰 +${pkg.credits} Credit ditambahkan.\n💳 Saldo sekarang: <b>${credits.getCredits(order.userId)} Credit</b>\n\n🙏 Terima kasih sudah support!</blockquote>`,
            parseMode: "html",
          });
        } catch (_) {}
        credits.addBuyer(order.userId, order.buyerUname, pkg.priceIDR, pkg.credits, userId);
      }
      pendingOrders.delete(orderId);
      return;
    }

    if (data.startsWith("orderfinalreject_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Hanya Admin/Owner!", alert: true });
      const orderId = data.replace("orderfinalreject_", "");
      const order = pendingOrders.get(orderId);
      await event.answer({ message: "❌ Ditolak." });
      if (order) {
        pendingOrders.delete(orderId);
        try { await client.sendMessage(order.chatId, { message: `❌ <b>Bukti transfer kamu ditolak admin. Silakan hubungi admin jika ini kesalahan.</b>`, parseMode: "html" }); } catch (_) {}
      }
      return;
    }

    if (data === "redeem_start") {
      await event.answer();
      modStates.set(userId, { step: "waiting_redeem_code", chatId, updatedAt: Date.now() });
      return await sendHtml(chatId,
        `🎁 <b>Redeem Kode Credit</b>\n${DIV_HTML}\n\n<blockquote>Kirim kode redeem kamu sekarang:</blockquote>`,
        [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], msgId
      );
    }

    // ─── OWNER: Semua deploy web & ganti domain (URL/domain tidak pernah masuk channel) ──
    if (data.startsWith("owner_alldeploy_")) {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      const page = parseInt(data.replace("owner_alldeploy_", "")) || 1;
      await event.answer();
      return await showAllDeploys(chatId, page, msgId);
    }

    if (data === "owner_listbuyers") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      await event.answer();
      return await showBuyerList(chatId, msgId);
    }

    // Pagination: list users
    if (data.startsWith("listusers_page_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const page = parseInt(data.replace("listusers_page_", ""));
      await event.answer();
      return await handleListUsers(chatId, userId, page, msgId);
    }

    // Pagination: list resellers
    if (data.startsWith("listresellers_page_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const page = parseInt(data.replace("listresellers_page_", ""));
      await event.answer();
      return await handleListResellers(chatId, userId, page, msgId);
    }

    // Pagination: build history
    if (data.startsWith("buildhistory_page_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const page = parseInt(data.replace("buildhistory_page_", ""));
      await event.answer();
      return await handleBuildHistory(chatId, userId, page, msgId);
    }

    // Kill build
    if (data.startsWith("kill_build_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("kill_build_", ""));
      const job = getUserJob(targetId);
      if (!job) return await event.answer({ message: "ℹ️ Build sudah selesai.", alert: true });
      removeUserJob(targetId);
      await event.answer({ message: `💀 Build user ${targetId} dihentikan!` });
      try { await client.sendMessage(job.chatId, { message: `⚠️ **Build kamu dihentikan paksa oleh admin.**`, parseMode: "md" }); } catch (_) {}
      return await handleListBuildsForKill(chatId, userId, msgId);
    }

    // Quick userinfo from button
    if (data.startsWith("adm_add_reseller_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_add_reseller_", ""));
      await event.answer();
      await handleAddReseller(chatId, userId, targetId);
      return;
    }
    if (data.startsWith("adm_rm_reseller_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_rm_reseller_", ""));
      await event.answer();
      await handleRemoveReseller(chatId, userId, targetId);
      return;
    }
    if (data.startsWith("adm_ban_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_ban_", ""));
      await event.answer();
      await handleBanUser(chatId, userId, `${targetId} Via panel`);
      return;
    }
    if (data.startsWith("adm_unban_")) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const targetId = parseInt(data.replace("adm_unban_", ""));
      await event.answer();
      await handleUnbanUser(chatId, userId, targetId);
      return;
    }

    // Report actions
    if (data === "user_start_lapor") {
      if (db.isReportBlocked(userId)) return event.answer({ message: "❌ Kamu diblokir dari fitur laporan.", alert: true });
      userStates.set(userId, { step: "WAITING_FOR_REASON" });
      await client.editMessage(chatId, {
        message: msgId,
        text: `📝 <b>MENU LAPORAN</b>\n\n<blockquote>Ketik alasan dan detail laporan kamu dengan jelas, lalu kirim lewat chat.\n\n⚠️ Laporan palsu akan menyebabkan akun diblokir.</blockquote>`,
        parseMode: "html",
        buttons: buildButtons([[{ text: "❌ Batalkan Laporan", data: "user_cancel_lapor" }]])
      });
      return await event.answer();
    }
    if (data === "user_cancel_lapor") {
      userStates.delete(userId);
      await client.editMessage(chatId, {
        message: msgId,
        text: `❌ <b>Laporan Dibatalkan</b>\n\n<blockquote>Proses laporan dihentikan.</blockquote>`,
        parseMode: "html",
        buttons: []
      });
      return await event.answer({ message: "Laporan dibatalkan" });
    }

    // Admin panel
    if (data === "admin_panel" || data === "owner_panel") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await showAdminPanel(chatId, userId, msgId);
      return await event.answer();
    }

    if (data === "admin_add_reseller") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `➕ <b>Tambah Reseller</b>\n\n<blockquote>Gunakan: <code>/addreseller 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_remove_reseller") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `➖ <b>Hapus Reseller</b>\n\n<blockquote>Gunakan: <code>/removereseller 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_add_admin") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      await sendHtml(chatId, `➕ <b>Tambah Admin</b>\n\n<blockquote>Gunakan: <code>/addadmin 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_remove_admin") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      await sendHtml(chatId, `➖ <b>Hapus Admin</b>\n\n<blockquote>Gunakan: <code>/removeadmin 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_search_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `🔍 <b>Cari User</b>\n\n<blockquote>Gunakan:\n<code>/searchuser 123456789</code>\n<code>/searchuser @username</code>\n<code>/searchuser nama</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_userinfo") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `ℹ️ <b>Info User</b>\n\n<blockquote>Gunakan: <code>/userinfo 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_ban_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `🚫 <b>Ban User</b>\n\n<blockquote>Gunakan: <code>/banuser 123456789 alasan</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_unban_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `✅ <b>Unban User</b>\n\n<blockquote>Gunakan: <code>/unbanuser 123456789</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_list_builds") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await event.answer();
      return await handleListBuildsForKill(chatId, userId, msgId);
    }
    if (data === "admin_export_users") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await event.answer({ message: "📤 Mengekspor..." });
      return await handleExportUsers(chatId, userId);
    }
    if (data === "admin_dm_user") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      await sendHtml(chatId, `📣 <b>Kirim DM ke User</b>\n\n<blockquote>Gunakan: <code>/dmuser 123456789 pesan kamu</code></blockquote>`);
      return await event.answer();
    }
    if (data === "admin_toggle_maint") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const now = mdb.toggle();
      await event.answer({ message: `🛠️ Maintenance ${now ? "AKTIF" : "NONAKTIF"}!` });
      return await showAdminPanel(chatId, userId, msgId);
    }
    if (data === "admin_toggle_freemode") {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      const now = fmdb.toggle();
      await event.answer({ message: now ? "🆓 Mode FREE aktif — semua fitur gratis!" : "💰 Mode CREDIT aktif — fitur potong credit lagi." });
      return await showAdminPanel(chatId, userId, msgId);
    }
    if (data === "admin_reset_stats") {
      if (!isOwner(userId)) return await event.answer({ message: "❌ Hanya Owner!", alert: true });
      db.resetStats();
      await event.answer({ message: "✅ Stats direset!" });
      return await showAdminPanel(chatId, userId, msgId);
    }

    // Report admin actions
    const isAdminAct = data.startsWith("adm_fix_") || data.startsWith("adm_blk_") || data.startsWith("adm_unblk_");
    if (isAdminAct) {
      if (!isPrivileged(userId)) return await event.answer({ message: "❌ Akses ditolak!", alert: true });
      let origText = "Laporan User";
      try { const m = await client.getMessages(chatId, { ids: [msgId] }); origText = m[0]?.message || m[0]?.caption || origText; } catch (_) {}

      if (data.startsWith("adm_fix_")) {
        const tid = Number(data.replace("adm_fix_", ""));
        try {
          await client.sendMessage(tid, { message: `🎉 **LAPORAN SELESAI!**\n\nKendala yang kamu laporkan telah diperbaiki oleh admin. Terima kasih!`, parseMode: "md" });
          await event.answer({ message: "✅ User diberitahu!" });
        } catch (_) { await event.answer({ message: "⚠️ Gagal kirim DM!", alert: true }); }
        await client.editMessage(chatId, { message: msgId, text: origText + "\n\n🟢 **STATUS:** Selesai & user diberitahu.", parseMode: "md", buttons: buildButtons([[{ text: "🔒 Blokir", data: `adm_blk_${tid}` }]]) });
        return;
      }
      if (data.startsWith("adm_blk_")) {
        const tid = Number(data.replace("adm_blk_", ""));
        if (db.isReportBlocked(tid)) return await event.answer({ message: "ℹ️ Sudah diblokir.", alert: true });
        db.blockReportUser(tid);
        await event.answer({ message: `🔒 User ${tid} diblokir!` });
        await client.editMessage(chatId, { message: msgId, text: origText + "\n\n🔴 **STATUS:** User diblokir.", parseMode: "md", buttons: buildButtons([[{ text: "🔓 Unblokir", data: `adm_unblk_${tid}` }]]) });
        try { await client.sendMessage(tid, { message: `⚠️ **DIBLOKIR!**\n\nFitur laporan kamu dinonaktifkan.`, parseMode: "md" }); } catch (_) {}
        return;
      }
      if (data.startsWith("adm_unblk_")) {
        const tid = Number(data.replace("adm_unblk_", ""));
        if (!db.isReportBlocked(tid)) return await event.answer({ message: "ℹ️ Tidak dalam blokir.", alert: true });
        db.unblockReportUser(tid);
        await event.answer({ message: `🔓 User ${tid} diunblokir!` });
        await client.editMessage(chatId, { message: msgId, text: origText + "\n\n⚪ **STATUS:** Akses normal.", parseMode: "md", buttons: buildButtons([[{ text: "✅ Selesai", data: `adm_fix_${tid}` }, { text: "🔒 Blokir", data: `adm_blk_${tid}` }]]) });
        try { await client.sendMessage(tid, { message: `✅ **AKSES DIKEMBALIKAN!**\n\nFitur laporan kamu aktif kembali.`, parseMode: "md" }); } catch (_) {}
        return;
      }
    }

    // Check join
    if (data === "check_join") {
      const joined = await isJoinedChannel(userId);
      if (!joined) return event.answer({ message: "❌ Belum join semua channel!", alert: true });
      await event.answer({ message: "✅ Verifikasi berhasil!" });
      let firstName = "User";
      try { const e = await client.getEntity(userId); firstName = e?.firstName || "User"; } catch (_) {}
      return handleStart({ chatId, message: { getSender: async () => ({ id: userId, firstName, username: null }) } }, msgId);
    }

    await event.answer();

    // Main navigation
    if (data === "start") {
      return await handleStart({
        chatId,
        message: {
          getSender: async () => {
            try { const e = await client.getEntity(userId); return { id: userId, firstName: e?.firstName || "User", username: e?.username || null }; }
            catch (_) { return { id: userId, firstName: "User" }; }
          }
        }
      }, msgId);
    }
    if (data === "build")         return await handleBuild(chatId, userId, null,      msgId);
    if (data === "tqto")          return await showTqto(chatId, msgId);
    if (data === "build_debug")   return await handleBuild(chatId, userId, "debug",   msgId);
    if (data === "tools_menu")    return await showToolsMenu(chatId, userId, msgId);
    if (data === "build_release") return await handleBuild(chatId, userId, "release", msgId);
    if (data === "web2apk")       return await handleWeb2Apk(chatId, userId, msgId);
    if (data === "queue")         return await handleQueue(chatId, msgId);
    if (data === "help")          return await handleHelp(chatId, msgId, userId);
    if (data === "admin_cmdlist") return await handleAdminCommandList(chatId, userId, msgId);
    if (data === "admin_gh_workers") {
      if (!isPrivileged(userId)) return sendHtml(chatId, `❌ <b>Akses ditolak!</b>`);
      return await handleListWorkerGithub(chatId, msgId);
    }
    if (data?.startsWith("admin_gh_del_")) {
      if (!isPrivileged(userId)) return sendHtml(chatId, `❌ <b>Akses ditolak!</b>`);
      const workerId = data.replace("admin_gh_del_", "");
      return await handleRemoveWorkerGithub(chatId, workerId, msgId);
    }
    if (data === "status")        return await handleStatus(chatId, userId, msgId);

    if (data === "cancel") {
      removeUserJob(userId);
      modStates.delete(userId);
      return await sendHtml(chatId,
        `✅ <b>Dibatalkan.</b>\n\n<blockquote>Ketik /start atau klik tombol di bawah untuk kembali ke menu utama.</blockquote>`,
        [[{ text: "🏠 Menu Utama", data: "start" }]], msgId
      );
    }

    // MOD: GANTI DOMAIN
    if (data === "mod_domain_start") {
      if (isUserBuilding(userId)) {
        return await sendHtml(chatId,
          `⚠️ <b>Build Sedang Aktif!</b>\n\n<blockquote>Selesaikan atau batalkan build kamu dulu sebelum ganti domain.</blockquote>`,
          [[{ text: "❌ Batalkan Build", data: "cancel" }]], msgId
        );
      }
      modStates.set(userId, { step: "waiting_zip_domain", chatId, updatedAt: Date.now() });
      return await sendHtml(chatId,
        `🔧 <b>Ganti Domain APK</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `📤 Kirim file <code>.zip</code> project Flutter kamu.\n\n` +
        `Bot akan cari semua URL <code>http://</code> / <code>https://</code> di file <code>.dart</code>, lalu kamu tinggal pilih mana yang mau diganti.` +
        `</blockquote>`,
        [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], msgId
      );
    }

    if (data.startsWith("mod_pickurl_")) {
      const state = modStates.get(userId);
      if (!state || state.step !== "waiting_pick_url") {
        return await sendHtml(chatId, `⚠️ <b>Sesi kedaluwarsa.</b> Mulai ulang dari menu.`, [[{ text: "🏠 Menu Utama", data: "start" }]], msgId);
      }
      const idx = parseInt(data.replace("mod_pickurl_", ""), 10);
      const picked = state.foundUrls?.[idx];
      if (!picked) {
        return await sendHtml(chatId, `❌ <b>Pilihan tidak valid.</b>`, [[{ text: "🏠 Menu Utama", data: "start" }]], msgId);
      }
      state.oldUrl = picked[0];
      state.step = "waiting_new_url";
      modStates.set(userId, state);
      return await sendHtml(chatId,
        `🔧 <b>Ganti Domain APK</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>✅ URL lama: <code>${state.oldUrl}</code></blockquote>\n\n` +
        `Sekarang kirim <b>URL server baru</b> (contoh: <code>http://panelkulegalv4.xzcl.web.id:9049</code>):`,
        [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], msgId
      );
    }

    // MOD: GANTI WARNA
    if (data === "mod_color_start") {
      if (isUserBuilding(userId)) {
        return await sendHtml(chatId,
          `⚠️ <b>Build Sedang Aktif!</b>\n\n<blockquote>Selesaikan atau batalkan build kamu dulu sebelum ganti warna.</blockquote>`,
          [[{ text: "❌ Batalkan Build", data: "cancel" }]], msgId
        );
      }
      modStates.set(userId, { step: "waiting_zip_color", chatId, updatedAt: Date.now() });
      return await sendHtml(chatId,
        `🎨 <b>Ganti Warna APK</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `📤 Kirim file <code>.zip</code> project Flutter kamu.\n\n` +
        `Bot akan deteksi warna utama (theme + splash) secara otomatis, lalu kamu pilih warna pengganti.` +
        `</blockquote>`,
        [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], msgId
      );
    }

    if (data.startsWith("mod_preset_")) {
      const state = modStates.get(userId);
      if (!state || state.step !== "waiting_pick_color") {
        return await sendHtml(chatId, `⚠️ <b>Sesi kedaluwarsa.</b> Mulai ulang dari menu.`, [[{ text: "🏠 Menu Utama", data: "start" }]], msgId);
      }
      const presetKey = data.replace("mod_preset_", "");
      const newHex = fluttermod.COLOR_PRESETS[presetKey];
      if (!newHex) {
        return await sendHtml(chatId, `❌ <b>Preset tidak dikenal.</b>`, [[{ text: "🏠 Menu Utama", data: "start" }]], msgId);
      }
      return await processColorChange(chatId, userId, state, newHex, msgId);
    }

    if (data === "mod_custom_color") {
      const state = modStates.get(userId);
      if (!state || state.step !== "waiting_pick_color") {
        return await sendHtml(chatId, `⚠️ <b>Sesi kedaluwarsa.</b> Mulai ulang dari menu.`, [[{ text: "🏠 Menu Utama", data: "start" }]], msgId);
      }
      state.step = "waiting_custom_hex";
      modStates.set(userId, state);
      return await sendHtml(chatId,
        `🎨 <b>Warna Custom</b>\n\n<blockquote>Kirim kode hex warna kamu (6 digit, tanpa #).\nContoh: <code>FF5733</code></blockquote>`,
        [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], msgId
      );
    }

    // MOD: GANTI ICON
    if (data === "mod_icon_start") {
      if (isUserBuilding(userId)) {
        return await sendHtml(chatId,
          `⚠️ <b>Build Sedang Aktif!</b>\n\n<blockquote>Selesaikan atau batalkan build kamu dulu sebelum ganti icon.</blockquote>`,
          [[{ text: "❌ Batalkan Build", data: "cancel" }]], msgId
        );
      }
      modStates.set(userId, { step: "waiting_zip_icon", chatId, updatedAt: Date.now() });
      return await sendHtml(chatId,
        `🖼️ <b>Ganti Icon APK</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `📤 Kirim file <code>.zip</code> project Flutter kamu.\n\n` +
        `Bot akan cek icon Android & iOS yang ada di project.` +
        `</blockquote>`,
        [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], msgId
      );
    }

    // MOD: GANTI NAMA
    if (data === "mod_name_start") {
      if (isUserBuilding(userId)) {
        return await sendHtml(chatId,
          `⚠️ <b>Build Sedang Aktif!</b>\n\n<blockquote>Selesaikan atau batalkan build kamu dulu sebelum ganti nama.</blockquote>`,
          [[{ text: "❌ Batalkan Build", data: "cancel" }]], msgId
        );
      }
      modStates.set(userId, { step: "waiting_zip_name", chatId, updatedAt: Date.now() });
      return await sendHtml(chatId,
        `✏️ <b>Ganti Nama APK</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `📤 Kirim file <code>.zip</code> project Flutter kamu.\n\n` +
        `Bot akan ganti nama app di AndroidManifest, strings.xml, dan Info.plist (iOS).` +
        `</blockquote>`,
        [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], msgId
      );
    }

    // MOD: RENAME ALL NAME (find & replace teks bebas di semua file .dart)
    if (data === "mod_renameall_start") {
      if (isUserBuilding(userId)) {
        return await sendHtml(chatId,
          `⚠️ <b>Build Sedang Aktif!</b>\n\n<blockquote>Selesaikan atau batalkan build kamu dulu sebelum rename.</blockquote>`,
          [[{ text: "❌ Batalkan Build", data: "cancel" }]], msgId
        );
      }
      modStates.set(userId, { step: "waiting_zip_renameall", chatId, updatedAt: Date.now() });
      return await sendHtml(chatId,
        `🔤 <b>Rename All Name</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `📤 Kirim file <code>.zip</code> project Flutter kamu.\n\n` +
        `Bot akan cari &amp; ganti SEMUA kemunculan sebuah nama/teks (misal nama toko) di seluruh file <code>.dart</code> project kamu.` +
        `</blockquote>`,
        [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], msgId
      );
    }

    // CREATE PANEL FREE (reward: undang 5 orang confirmed)
    if (data === "freepanel_start") {
      const st = credits.getFreePanelStatus(userId);
      if (st.claimed) {
        return await sendHtml(chatId,
          `⚠️ <b>Jatah Sudah Terpakai!</b>\n\n<blockquote>Kamu sudah pernah membuat Panel Free sebelumnya. Setiap user hanya bisa membuat <b>1 kali</b>.</blockquote>`,
          [[{ text: "🏠 Menu Utama", data: "start" }]], msgId
        );
      }
      if (!st.eligible) {
        const { link } = await getReferralLink();
        const myLink = link(userId);
        const sisa = st.required - st.confirmedReferrals;
        return await sendHtml(chatId,
          `🔒 <b>Belum Bisa Akses Create Panel Free</b>\n${DIV_HTML}\n\n` +
          `<blockquote>Kamu harus mengundang <b>${st.required} orang</b> untuk START bot ini &amp; join semua channel wajib.\n\n` +
          `📊 Progress kamu: <b>${st.confirmedReferrals} / ${st.required}</b> orang\n` +
          `⏳ Kurang <b>${sisa} orang</b> lagi!</blockquote>\n\n` +
          `📤 <b>Bagikan bot ini</b> ke teman kamu pakai link di bawah:\n<code>${myLink}</code>\n\n` +
          `Begitu ${sisa === st.required ? "5" : sisa} orang buka link itu, START bot, dan join semua channel, kamu otomatis dapat notifikasi &amp; akses Create Panel Free!`,
          [
            [{ text: "📤 Share Bot Sekarang", url: `https://t.me/share/url?url=${encodeURIComponent(myLink)}&text=${encodeURIComponent("Yuk build APK gratis di bot ini!")}` }],
            [{ text: "🏠 Menu Utama", data: "start" }],
          ], msgId
        );
      }
      if (isUserBuilding(userId)) {
        return await sendHtml(chatId,
          `⚠️ <b>Build Sedang Aktif!</b>\n\n<blockquote>Selesaikan atau batalkan build kamu dulu sebelum create panel.</blockquote>`,
          [[{ text: "❌ Batalkan Build", data: "cancel" }]], msgId
        );
      }
      modStates.set(userId, { step: "waiting_freepanel_username", chatId, updatedAt: Date.now() });
      return await sendHtml(chatId,
        `🎁 <b>Create Panel Free</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `Selamat! Kamu berhak dapat <b>1 Panel Hosting Gratis (Unlimited)</b>.\n\n` +
        `📝 Masukan <b>Username</b> untuk panel kamu:` +
        `</blockquote>`,
        [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], msgId
      );
    }

    // DEPLOY WEB KE VERCEL
    if (data === "deployweb_start") {
      if (!webdeploy.isConfigured()) {
        return await sendHtml(chatId,
          `⚠️ <b>Fitur Belum Dikonfigurasi</b>\n\n<blockquote>Owner belum mengatur GITHUB_TOKEN / GITHUB_USERNAME / VERCEL_TOKEN di server.</blockquote>`,
          [[{ text: "🏠 Menu Utama", data: "start" }]], msgId
        );
      }
      modStates.set(userId, { step: "deployweb_waiting_name", chatId, updatedAt: Date.now() });
      return await sendHtml(chatId,
        `🚀 <b>Deploy Web ke Vercel</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `📝 Masukkan nama untuk subdomain kamu.\n\n` +
        `Contoh: <code>tokoklontongziper</code> → jadi\n` +
        `<code>https://tokoklontongziper.vercel.app</code>` +
        `</blockquote>\n\n` +
        `⚠️ Hanya huruf kecil (a-z) & angka (0-9), min 3 karakter, tanpa spasi/simbol.`,
        [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], msgId
      );
    }

    // ENKRIPSI: MENU UTAMA
    if (data === "enc_menu") {
      modStates.delete(userId);
      return await sendHtml(chatId,
        `🔐 <b>Menu Enkripsi</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `<blockquote>` +
        `🌐 <b>Enkripsi HTML</b> — Base64 wrap / Obfuscate hex / Dekripsi\n\n` +
        `⚡ <b>Enkripsi JS</b> — 15+ mode (Standard, Ultra, Quantum, Nebula, dll)` +
        `</blockquote>`,
        [
          [{ text: "🌐 Enkripsi HTML", data: "enc_html_menu", style: "Success" }],
          [{ text: "⚡ Enkripsi JS", data: "enc_js_menu", style: "primary" }],
          [{ text: "🏠 Menu Utama", data: "start", style: "Danger" }],
        ], msgId
      );
    }

    if (data === "enc_html_menu") {
      return await sendHtml(chatId,
        `🌐 <b>Enkripsi HTML</b>\n${DIV_HTML}\n\n` +
        `<blockquote>` +
        `🔐 Base64 — HTML di-encode Base64, auto decode di browser\n` +
        `🌀 Obfuscate — Kode dikacak pakai hex encoding\n` +
        `🔓 Dekripsi — Kembalikan HTML terenkripsi ke original` +
        `</blockquote>`,
        [
          [{ text: "🔐 Base64 HTML", data: "enc_html_b64", style: "Success" }],
          [{ text: "🌀 Obfuscate HTML", data: "enc_html_obf", style: "Success" }],
          [{ text: "🔓 Dekripsi HTML", data: "dec_html_b64", style: "Success" }],
          [{ text: "‹ Kembali", data: "enc_menu", style: "Danger" }],
        ], msgId
      );
    }

    if (data === "enc_html_b64" || data === "enc_html_obf" || data === "dec_html_b64") {
      modStates.set(userId, { step: data, chatId, updatedAt: Date.now() });
      const label = data === "enc_html_b64" ? "Enkripsi Base64" : data === "enc_html_obf" ? "Enkripsi Obfuscate" : "Dekripsi";
      return await sendHtml(chatId,
        `🌐 <b>${label} HTML</b>\n${DIV_HTML}\n\n📤 Kirim file <code>.html</code> atau paste kode HTML:`,
        [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], msgId
      );
    }

    if (data === "enc_js_menu") {
      if (!jsenc.isAvailable) {
        return await sendHtml(chatId,
          `⚠️ <b>Modul js-confuser tidak terinstall di server.</b>\n\n<blockquote>Owner perlu jalankan <code>npm install js-confuser</code> di server bot.</blockquote>`,
          [[{ text: "🏠 Menu Utama", data: "start" }]], msgId
        );
      }
      const modeLabels = {
        standard: "Standard", strong: "Strong", ultra: "Ultra", quantum: "Quantum",
        timelocked: "TimeLocked", nebula: "Nebula", nexus: "Nexus", siu: "SiuCalcrick",
        mandarin: "Mandarin", arab: "Arab", japan: "Japan", japxab: "JapanXArab",
        invis: "Invisible", stealth: "Stealth", big: "Big", max: "Max", custom: "Custom",
      };
      const rows = [];
      const modes = jsenc.JS_MODES;
      for (let i = 0; i < modes.length; i += 2) {
        const pair = modes.slice(i, i + 2).map(m => ({ text: modeLabels[m] || m, data: `ejs_${m}`, style: "Success" }));
        rows.push(pair);
      }
      rows.push([{ text: "🔓 Dekripsi JS", data: "dec_js_b64", style: "primary" }]);
      rows.push([{ text: "‹ Kembali", data: "enc_menu", style: "Danger" }]);

      return await sendHtml(chatId,
        `⚡ <b>Enkripsi JS — Pilih Mode</b>\n${DIV_HTML}\n\n` +
        `<blockquote>Pilih salah satu mode enkripsi di bawah, lalu kirim file <code>.js</code>.</blockquote>`,
        rows, msgId
      );
    }

    if (data.startsWith("ejs_")) {
      const mode = data.replace("ejs_", "");
      if (!jsenc.JS_MODES.includes(mode)) {
        return await sendHtml(chatId, `❌ <b>Mode tidak dikenal.</b>`, [[{ text: "🏠 Menu Utama", data: "start" }]], msgId);
      }
      modStates.set(userId, { step: "enc_js_wait", jsMode: mode, chatId, updatedAt: Date.now() });
      return await sendHtml(chatId,
        `⚡ <b>Mode: ${mode}</b>\n${DIV_HTML}\n\n📤 Kirim file <code>.js</code> kamu (maks 10MB):`,
        [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], msgId
      );
    }

    if (data === "dec_js_b64") {
      modStates.set(userId, { step: "dec_js_b64", chatId, updatedAt: Date.now() });
      return await sendHtml(chatId,
        `🔓 <b>Dekripsi JS</b>\n${DIV_HTML}\n\n📤 Kirim file <code>.js</code> yang terenkripsi (Base64):`,
        [[{ text: "❌ Batalkan", data: "cancel", style: "Danger" }]], msgId
      );
    }
  } catch (err) {
    console.error("Callback error:", err);
  }
}

// ─── SET BOT COMMANDS (menu perintah di UI Telegram) ────────────────────────
async function setBotCommands() {
  try {
    await client.setMyCommands([
      { command: "start", description: "🏠 Mulai menggunakan bot" },
      { command: "help", description: "❓ Bantuan & panduan" },
      { command: "gencode", description: "✨ Membuat redeem code" },
      { command: "broadcast", description: "📢 Broadcast pesan (Admin)" },
      { command: "addcredit", description: "addcredit userid,jumlah ( Ress & Owner )" },
      { command: "addreseller", description: "Add Reseller (Owner Only)" },
    ]);
    console.log("✅ Bot commands berhasil di-set!");
  } catch (e) {
    console.error("Failed to set commands:", e.message);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🚀 Starting ${CONFIG.BOT_NAME}...`);
  console.log(`👑 OWNER_ID: ${CONFIG.OWNER_ID}`);
  console.log(`🎯 PRIORITY: Owner (1) > Reseller (2) > User (3)`);

  if (!fs.existsSync(CONFIG.TMP_DIR)) fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });

  await client.start();
  console.log("✅ Bot terhubung via Telegraf!");
  await setBotCommands();

  client.addEventHandler(async (event) => {
    try {
      const msg    = event.message;
      const text   = msg?.text?.trim();
      const chatId = event.chatId;
      const userId = Number(msg.senderId);

      if (text === "/start" || text?.startsWith("/start ")) {
        const refPayload = text.includes(" ") ? text.split(" ")[1]?.trim() : null;
        return handleStart(event, null, refPayload);
      }
      if (text === "/help")   return handleHelp(chatId, null, userId);
      if (text === "/cekemoji" || text?.startsWith("/cekemoji ") || /^\/cekemoji(@\w+)?$/.test(text || "")) {
        return handleCekEmojiCommand(event);
      }
      if (text?.startsWith("/get ") || text === "/get" || /^\/get(@\w+)?/.test(text || "")) {
        return handleGetHtmlCommand(event);
      }

      if (text === "/broadcast" && isResellerUp(userId)) {
        const replied = await event.message.getReplyMessage();
        if (!replied) return sendHtml(chatId, `⚠️ <b>Cara Broadcast:</b>\n\n<blockquote>Reply pesan yang ingin di-broadcast, lalu ketik /broadcast</blockquote>`);
        isOwner(userId)
          ? await (async () => {
              const all = db.getAllUsers();
              const m   = await sendHtml(chatId, `📢 <b>Broadcast dimulai ke ${all.length} user...</b>`);
              let ok = 0, fail = 0;
              for (const u of all) {
                try {
                  replied.media
                    ? await client.sendFile(u.userId, { file: replied.media, caption: replied.text || "", parseMode: "md" })
                    : await client.sendMessage(u.userId, { message: replied.text || "", parseMode: "md" });
                  ok++;
                } catch (_) { fail++; }
                await sleep(100);
              }
              await editHtml(chatId, m.id, `✅ <b>Broadcast Selesai!</b>\n\n<blockquote>📢 Total: ${all.length}\n✔️ Sukses: ${ok}\n❌ Gagal: ${fail}</blockquote>`);
            })()
          : await handleBroadcastWithOwnerNotify(chatId, userId, replied);
        return;
      }

      if (text?.startsWith("/addreseller") && isPrivileged(userId)) {
        const parts = text.split(" ");
        return handleAddReseller(chatId, userId, parts[1]);
      }
      if (text?.startsWith("/removereseller") && isPrivileged(userId)) {
        const parts = text.split(" ");
        return handleRemoveReseller(chatId, userId, parts[1]);
      }
      if (text?.startsWith("/addadmin") && isOwner(userId)) {
        const parts = text.split(" ");
        return handleAddAdmin(chatId, userId, parts[1]);
      }
      if (text?.startsWith("/removeadmin") && isOwner(userId)) {
        const parts = text.split(" ");
        return handleRemoveAdmin(chatId, userId, parts[1]);
      }
      if (text?.startsWith("/addwolker") && isOwner(userId)) {
        const raw = text.replace("/addwolker", "").trim();
        const parts = raw.split("|").map(s => s.trim()).filter(Boolean);
        const [label, repo, token] = parts;

        if (parts.length < 3) {
          return sendHtml(chatId,
            `➕ <b>Tambah Worker GitHub</b>\n${DIV_HTML}\n\n` +
            `<blockquote>Format:\n<code>/addwolker title|repo|ghp-token</code>\n\n` +
            `Contoh:\n<code>/addwolker Worker Utama|ziperr22/build-flutter|ghp_abcd1234xyz</code>\n\n` +
            `📌 repo format: <code>owner/repo</code>\n` +
            `📌 token butuh scope: <code>repo</code> + <code>workflow</code></blockquote>`
          );
        }
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          return sendHtml(chatId, `⚠️ <b>Format repo salah.</b> Harus <code>owner/repo</code>, contoh: <code>ziperr22/build-flutter</code>`);
        }
        if (!token || token.length < 10) {
          return sendHtml(chatId, `⚠️ <b>Token GitHub tidak valid.</b>`);
        }

        // Hapus pesan berisi token dari chat demi keamanan
        try { await client.deleteMessages(chatId, [msg.id], { revoke: true }); } catch (_) {}

        const worker = githubWorkers.addWorker({ label, repo, token, addedBy: userId });
        return sendHtml(chatId,
          `✅ <b>Worker GitHub Ditambahkan!</b>\n${DIV_HTML}\n\n` +
          `<blockquote>` +
          `🆔 ID    : <code>${worker.id}</code>\n` +
          `🏷️ Label : <b>${worker.label}</b>\n` +
          `📦 Repo  : <code>${worker.repo}</code>\n` +
          `⚙️ Workflow : <code>${worker.workflows.flutter}</code>` +
          `</blockquote>\n\n` +
          `Worker langsung aktif & dipakai round-robin. Pesan token sudah dihapus dari chat.`,
          [[{ text: "🏠 Menu Utama", data: "start" }]]
        );
      }
      if (text === "/listworkergithub" && isOwner(userId)) {
        return handleListWorkerGithub(chatId);
      }
      if (text?.startsWith("/removeworkergithub") && isOwner(userId)) {
        const parts = text.split(" ");
        return handleRemoveWorkerGithub(chatId, parts[1]);
      }
      if ((text === "/listusers" || text?.match(/^\/listusers\s+\d+$/)) && isPrivileged(userId)) {
        const page = text.includes(" ") ? parseInt(text.split(" ")[1]) : 1;
        return handleListUsers(chatId, userId, page);
      }
      if ((text === "/listresellers" || text?.match(/^\/listresellers\s+\d+$/)) && isPrivileged(userId)) {
        const page = text.includes(" ") ? parseInt(text.split(" ")[1]) : 1;
        return handleListResellers(chatId, userId, page);
      }
      if (text?.startsWith("/searchuser") && isPrivileged(userId)) {
        return handleSearchUser(chatId, userId, text.replace("/searchuser", "").trim());
      }
      if (text?.startsWith("/userinfo") && isPrivileged(userId)) {
        return handleUserInfo(chatId, userId, text.replace("/userinfo", "").trim());
      }
      if (text?.startsWith("/deleteuser") && isPrivileged(userId)) {
        return handleDeleteUser(chatId, userId, text.replace("/deleteuser", "").trim());
      }
      if (text?.startsWith("/banuser") && isPrivileged(userId)) {
        return handleBanUser(chatId, userId, text.replace("/banuser", "").trim());
      }
      if (text?.startsWith("/unbanuser") && isPrivileged(userId)) {
        return handleUnbanUser(chatId, userId, text.replace("/unbanuser", "").trim());
      }
      if (text?.startsWith("/dmuser") && isPrivileged(userId)) {
        return handleDmUser(chatId, userId, text.replace("/dmuser", "").trim());
      }
      if (text === "/exportusers" && isPrivileged(userId)) {
        return handleExportUsers(chatId, userId);
      }
      if ((text === "/buildhistory" || text?.match(/^\/buildhistory\s+\d+$/)) && isPrivileged(userId)) {
        const page = text.includes(" ") ? parseInt(text.split(" ")[1]) : 1;
        return handleBuildHistory(chatId, userId, page);
      }
      if (text?.startsWith("/killbuild") && isPrivileged(userId)) {
        const targetId = parseInt(text.replace("/killbuild", "").trim());
        if (!isNaN(targetId)) {
          const job = getUserJob(targetId);
          if (!job) return sendHtml(chatId, `❌ <b>User ID <code>${targetId}</code> tidak sedang build.</b>`);
          removeUserJob(targetId);
          await sendHtml(chatId, `💀 <b>Build user <code>${targetId}</code> dihentikan paksa!</b>`);
          try { await client.sendMessage(job.chatId, { message: `⚠️ **Build kamu dihentikan paksa oleh admin.**`, parseMode: "md" }); } catch (_) {}
        }
        return;
      }

      if (text?.startsWith("/redeem")) {
        const code = text.replace("/redeem", "").trim();
        if (!code) return sendHtml(chatId, `🎁 <b>Redeem Kode</b>\n\n<blockquote>Gunakan: <code>/redeem KODE-KAMU</code></blockquote>`);
        const res = credits.redeemCode(userId, code);
        if (!res.ok) {
          const reasonMsg = { notfound: "Kode tidak ditemukan.", exhausted: "Kode sudah habis dipakai.", already: "Kamu sudah pernah pakai kode ini." }[res.reason] || "Kode tidak valid.";
          return sendHtml(chatId, `❌ <b>Gagal Redeem!</b>\n\n<blockquote>${reasonMsg}</blockquote>`);
        }
        try {
          let name = "Unknown", uname = "—";
          try {
            const e = await client.getEntity(userId);
            name = [e?.firstName, e?.lastName].filter(Boolean).join(" ") || "Unknown";
            uname = e?.username ? `@${e.username}` : "—";
          } catch (_) {}
          await client.sendMessage(CONFIG.CHANNEL_USERNAME, {
            message: `🎁 <b>KODE REDEEM DIPAKAI</b>\n${DIV_HTML}\n\n<blockquote>👤 ${name} (${uname})\n💰 +${res.credits} Credit</blockquote>`,
            parseMode: "html",
          });
        } catch (_) {}
        return sendHtml(chatId, `🎉 <b>Redeem Berhasil!</b>\n\n<blockquote>💰 +${res.credits} Credit\n💳 Saldo: <b>${credits.getCredits(userId)} Credit</b></blockquote>`);
      }

      if (text?.startsWith("/gencode") && isPrivileged(userId)) {
  const parts = text.split(" ");
  const amount = Number(parts[1]);
  const maxUses = Number(parts[2]) || 1;
  
  if (!amount) {
    return sendHtml(chatId, `
🔑 <b>Generate Kode Redeem</b>

<blockquote>Gunakan: <code>/gencode &lt;jumlah_credit&gt; [max_pemakaian]</code>
Contoh: <code>/gencode 10 5</code></blockquote>
`);
  }
  
  const code = credits.createRedeemCode(amount, maxUses, userId);
  return sendHtml(chatId, `
  <blockquote>🎁 KODE REDEEM BARU!</blockquote>
<blockquote>┣ 🔑 Kode : <code>${code}</code>
┣ 💰 Hadiah : <b>${amount}</b> CREDIT
┗ 👥 Kuota : <b>${maxUses}</b></blockquote>

<blockquote>📌 Cara Klaim:
Buka bot @buildapkridz_bot lalu ketik:
/redeem <code>${code}</code></blockquote>
`);
}

      if (text?.startsWith("/addcredit") && isResellerUp(userId)) {
        const parts = text.split(" ");
        const targetId = Number(parts[1]);
        const amount = Number(parts[2]);
        if (!targetId || !amount) return sendHtml(chatId, `💰 <b>Tambah Credit</b>\n\n<blockquote>Gunakan: <code>/addcredit &lt;user_id&gt; &lt;jumlah&gt;</code></blockquote>`);
        const newBal = credits.addCredits(targetId, amount);
        const giverLabel = isOwner(userId) ? "owner" : isAdmin(userId) ? "admin" : "reseller";
        try { await client.sendMessage(targetId, { message: `🎉 <b>Kamu Dapat Bonus Credit!</b>\n\n<blockquote>💰 +${amount} Credit dari ${giverLabel}.\n💳 Saldo: <b>${newBal}</b></blockquote>`, parseMode: "html" }); } catch (_) {}
        return sendHtml(chatId, `✅ <b>Berhasil!</b>\n\n<blockquote>User <code>${targetId}</code> sekarang punya <b>${newBal} Credit</b>.</blockquote>`);
      }

      if (text === "/alldeploy" && isOwner(userId)) return showAllDeploys(chatId, 1);
      if (text === "/listbuyers" && isOwner(userId)) return showBuyerList(chatId);

      if (text === "/backup" && isOwner(userId)) {
        const m = await sendHtml(chatId, `🔄 <b>Membackup SEMUA file server...</b>\n\n⏳ Tunggu sebentar, sedang compress...`);
        try {
          const result = credits.downloadFullServerBackup();
          if (result.ok) {
            const fileSizeMB = (result.size / 1024 / 1024).toFixed(2);
            await client.sendFile(chatId, {
              file: result.path,
              caption: `✅ <b>FULL SERVER BACKUP BERHASIL!</b>\n\n📦 File: <code>server_full_backup.zip</code>\n📊 Ukuran: <code>${fileSizeMB} MB</code>\n📁 Total Files: <code>${result.files} files</code>\n⏰ Waktu: <code>${new Date().toLocaleString("id-ID")}</code>\n\n📂 Isi Backup:\n  ✓ Semua .js files\n  ✓ Semua .json files\n  ✓ Semua .txt & .md files\n  ✓ .env, .npmrc, .gitignore\n  ✓ Folder data_credits/\n  ✓ Folder images/\n  ✓ Semua config files\n\n❌ Tidak diinclude:\n  ✗ node_modules/\n  ✗ .git/\n  ✗ .cache/\n  ✗ .npm/\n\n💾 Restore: Extract ZIP dan copy semua file ke server`,
              parseMode: "html"
            });
            // Hapus pesan lama
            try { await client.deleteMessages(chatId, [m.id]); } catch (_) {}
          } else {
            return editHtml(chatId, m.id, `❌ <b>Backup Gagal!</b>\n\n<blockquote>${result.reason}</blockquote>`);
          }
        } catch (err) {
          return editHtml(chatId, m.id, `❌ <b>Backup Gagal!</b>\n\n<blockquote>${err.message}</blockquote>`);
        }
      }

      if (text === "/dbbackup" && isOwner(userId)) {
        const m = await sendHtml(chatId, `🔄 <b>Membackup database ke GitHub...</b>`);
        const result = await credits.backupToGithub({
          "users.json": fs.readFileSync(DB_PATH, "utf-8"),
          "resellers.json": fs.readFileSync(RESELLER_PATH, "utf-8"),
          "banned.json": fs.readFileSync(BANNED_PATH, "utf-8"),
          "buildhistory.json": fs.readFileSync(HISTORY_PATH, "utf-8"),
        });
        return editHtml(chatId, m.id, result.ok
          ? `✅ <b>Backup Berhasil!</b>\n\n<blockquote>📦 Repo: <code>${result.repo}</code>\n🔗 ${result.url}</blockquote>`
          : `❌ <b>Backup Gagal!</b>\n\n<blockquote>${result.reason}</blockquote>`);
      }

      const reported = await handleUserReportMessages(event);
      if (reported) return;

      const emojiHandled = await handleCekEmojiReply(event);
      if (emojiHandled) return;

      const modHandled = await handleModMessage(event);
      if (modHandled) return;

      const job = getUserJob(userId);
      if (job?.type === "web2apk") {
        if (job.status === "waiting_url"     && text?.startsWith("http")) return handleWeb2ApkUrl(event);
        if (job.status === "waiting_appname" && text)                     return handleWeb2ApkName(event);
        if (job.status === "waiting_icon"    && msg.media)                return handleWeb2ApkIcon(event);
      }

      if (msg.media) await handleZipFile(event);
    } catch (err) { console.error("Handler error:", err); }
  }, new NewMessage({}));

  client.addEventHandler(async (event) => {
    try { await handleCallback(event); }
    catch (err) { console.error("Callback error:", err); }
  }, new CallbackQuery({}));

  // Auto-bersihin folder tmp (CONFIG.TMP_DIR) tiap 15 menit — file build/
  // download sementara yang lebih tua dari 30 menit dihapus otomatis. Ini
  // jaring pengaman umum: gak perlu ngandelin tiap alur (build, deploy, enc/dec,
  // dst) buat rapi-rapi sendiri, sekali pasang langsung nyapu semuanya.
  const TMP_MAX_AGE_MS = 30 * 60 * 1000;
  function cleanupTmpDir() {
    try {
      if (!fs.existsSync(CONFIG.TMP_DIR)) return;
      const now = Date.now();
      let removed = 0;
      for (const name of fs.readdirSync(CONFIG.TMP_DIR)) {
        const full = path.join(CONFIG.TMP_DIR, name);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > TMP_MAX_AGE_MS) {
            fs.rmSync(full, { recursive: true, force: true });
            removed++;
          }
        } catch (_) {}
      }
      if (removed > 0) console.log(`🧹 [cleanup] ${removed} file/folder lama di tmp/ dibersihkan.`);
    } catch (err) {
      console.error("[cleanup] Gagal bersihin tmp/:", err.message);
    }
  }
  cleanupTmpDir(); // langsung sekali pas bot nyala, bersihin sisa2 dari sesi sebelumnya
  setInterval(cleanupTmpDir, 15 * 60 * 1000);

  // Auto-backup database ke GitHub tiap 30 menit — biar kalau server mati/hilang,
  // data user & credit tetap aman dan bisa dipulihkan lewat bot.
  if (credits.isGithubConfigured()) {
    setInterval(async () => {
      try {
        await credits.backupToGithub({
          "users.json": fs.readFileSync(DB_PATH, "utf-8"),
          "resellers.json": fs.readFileSync(RESELLER_PATH, "utf-8"),
          "banned.json": fs.readFileSync(BANNED_PATH, "utf-8"),
          "buildhistory.json": fs.readFileSync(HISTORY_PATH, "utf-8"),
        });
        console.log("[Backup] Database berhasil di-backup ke GitHub.");
      } catch (err) {
        console.error("[Backup] Gagal backup:", err.message);
      }
    }, 30 * 60 * 1000);
  }

  console.log(`🤖 ${CONFIG.BOT_NAME} v${CONFIG.BOT_VERSION} aktif!`);
  await new Promise(() => {});
}

main();