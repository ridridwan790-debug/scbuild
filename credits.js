const fs = require("fs");
const path = require("path");
const axios = require("axios");

// ─── PATHS ───────────────────────────────────────────────────────────────────
const DATA_DIR       = "./data_credits";
const CREDITS_PATH   = path.join(DATA_DIR, "credits.json");
const REDEEM_PATH    = path.join(DATA_DIR, "redeem.json");
const DEPLOYS_PATH   = path.join(DATA_DIR, "deploys.json");
const BUYERS_PATH    = path.join(DATA_DIR, "buyers.json");

const START_CREDIT    = 5; // credit awal user baru
const REFERRAL_BONUS  = 5; // credit yang didapat pembagi link kalau referral-nya join
const INVITES_FOR_FREE_PANEL = 5; // jumlah referral confirmed buat unlock create panel free

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function ensureJson(p, def) { ensureDir(); if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def, null, 2)); }
ensureJson(CREDITS_PATH, {});
ensureJson(REDEEM_PATH, {});
ensureJson(DEPLOYS_PATH, []);
ensureJson(BUYERS_PATH, []);

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf-8")); }
function writeJson(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }

// ─── CREDITS ─────────────────────────────────────────────────────────────────
function getCredits(userId) {
  const all = readJson(CREDITS_PATH);
  return all[String(userId)]?.credits ?? 0;
}

// Panggil tiap kali /start. Kalau user baru -> dikasih START_CREDIT + simpan refBy (kalau ada).
function ensureUser(userId, refByRaw = null) {
  const all = readJson(CREDITS_PATH);
  const key = String(userId);
  if (all[key]) return { isNew: false, credits: all[key].credits };

  const refBy = Number(refByRaw);
  all[key] = {
    credits: START_CREDIT,
    joinedAt: new Date().toISOString(),
    refBy: (refBy && refBy !== Number(userId)) ? refBy : null,
    refConfirmed: false,
  };
  writeJson(CREDITS_PATH, all);
  return { isNew: true, credits: START_CREDIT };
}

function addCredits(userId, amount) {
  const all = readJson(CREDITS_PATH);
  const key = String(userId);
  if (!all[key]) all[key] = { credits: 0, joinedAt: new Date().toISOString(), refBy: null, refConfirmed: false };
  all[key].credits = (all[key].credits || 0) + Number(amount);
  writeJson(CREDITS_PATH, all);
  return all[key].credits;
}

function setCredits(userId, amount) {
  const all = readJson(CREDITS_PATH);
  const key = String(userId);
  if (!all[key]) all[key] = { credits: 0, joinedAt: new Date().toISOString(), refBy: null, refConfirmed: false };
  all[key].credits = Number(amount);
  writeJson(CREDITS_PATH, all);
  return all[key].credits;
}

function hasCredit(userId, amount = 1) { return getCredits(userId) >= amount; }

// Potong credit. Return false kalau saldo kurang (tidak dipotong).
function deductCredit(userId, amount = 1) {
  const all = readJson(CREDITS_PATH);
  const key = String(userId);
  if (!all[key] || (all[key].credits || 0) < amount) return false;
  all[key].credits -= amount;
  writeJson(CREDITS_PATH, all);
  return true;
}

// ─── REFERRAL ────────────────────────────────────────────────────────────────
// Dipanggil setelah user berhasil lolos verifikasi join channel (baru dikonfirmasi sekali).
// Return userId pembagi link kalau bonus baru saja diberikan, else null.
function confirmReferral(userId) {
  const all = readJson(CREDITS_PATH);
  const key = String(userId);
  const u = all[key];
  if (!u || !u.refBy || u.refConfirmed) return null;

  u.refConfirmed = true;
  const refKey = String(u.refBy);
  if (!all[refKey]) all[refKey] = { credits: 0, joinedAt: new Date().toISOString(), refBy: null, refConfirmed: false };
  all[refKey].credits = (all[refKey].credits || 0) + REFERRAL_BONUS;

  writeJson(CREDITS_PATH, all);
  return u.refBy;
}

function getReferralStats(userId) {
  const all = readJson(CREDITS_PATH);
  const key = String(userId);
  let confirmedCount = 0, pendingCount = 0;
  for (const k in all) {
    if (Number(all[k].refBy) === Number(userId)) {
      if (all[k].refConfirmed) confirmedCount++;
      else pendingCount++;
    }
  }
  return {
    credits: all[key]?.credits ?? 0,
    confirmedReferrals: confirmedCount,
    pendingReferrals: pendingCount,
  };
}

// ─── FREE PANEL (reward 5 referral confirmed) ───────────────────────────────
// Eligible kalau confirmedReferrals >= INVITES_FOR_FREE_PANEL DAN belum pernah claim.
function getFreePanelStatus(userId) {
  const all = readJson(CREDITS_PATH);
  const key = String(userId);
  const u = all[key] || {};
  const { confirmedReferrals } = getReferralStats(userId);
  return {
    confirmedReferrals,
    required: INVITES_FOR_FREE_PANEL,
    eligible: confirmedReferrals >= INVITES_FOR_FREE_PANEL,
    claimed: !!u.freePanelClaimed,
    notifiedEligible: !!u.freePanelNotified,
  };
}

// Tandai user sudah dinotifikasi "eligible" (biar notif cuma dikirim sekali). Return true kalau baru ditandai.
function markFreePanelNotified(userId) {
  const all = readJson(CREDITS_PATH);
  const key = String(userId);
  if (!all[key]) return false;
  if (all[key].freePanelNotified) return false;
  all[key].freePanelNotified = true;
  writeJson(CREDITS_PATH, all);
  return true;
}

// Tandai user sudah claim panel free (jatah habis, 1x per user). Return false kalau sudah pernah claim.
function markFreePanelClaimed(userId) {
  const all = readJson(CREDITS_PATH);
  const key = String(userId);
  if (!all[key]) all[key] = { credits: 0, joinedAt: new Date().toISOString(), refBy: null, refConfirmed: false };
  if (all[key].freePanelClaimed) return false;
  all[key].freePanelClaimed = true;
  all[key].freePanelClaimedAt = new Date().toISOString();
  writeJson(CREDITS_PATH, all);
  return true;
}

// Batalkan status claimed (dipanggil kalau create panel gagal di sisi API, biar user bisa coba lagi
// dengan username lain tanpa kehilangan jatah 1x-nya).
function unmarkFreePanelClaimed(userId) {
  const all = readJson(CREDITS_PATH);
  const key = String(userId);
  if (!all[key]) return false;
  all[key].freePanelClaimed = false;
  delete all[key].freePanelClaimedAt;
  writeJson(CREDITS_PATH, all);
  return true;
}

// ─── REDEEM CODE ─────────────────────────────────────────────────────────────
function generateCodeString(len = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function createRedeemCode(creditAmount, maxUses = 1, createdBy) {
  const all = readJson(REDEEM_PATH);
  let code;
  do { code = generateCodeString(); } while (all[code]);
  all[code] = {
    credits: Number(creditAmount),
    maxUses: Number(maxUses) || 1,
    uses: 0,
    usedBy: [],
    createdBy: Number(createdBy),
    createdAt: new Date().toISOString(),
  };
  writeJson(REDEEM_PATH, all);
  return code;
}

function redeemCode(userId, rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  const all = readJson(REDEEM_PATH);
  const c = all[code];
  if (!c) return { ok: false, reason: "notfound" };
  if (c.uses >= c.maxUses) return { ok: false, reason: "exhausted" };
  if (c.usedBy.includes(Number(userId))) return { ok: false, reason: "already" };

  c.uses += 1;
  c.usedBy.push(Number(userId));
  writeJson(REDEEM_PATH, all);
  addCredits(userId, c.credits);
  return { ok: true, credits: c.credits };
}

function listRedeemCodes() { return readJson(REDEEM_PATH); }

// ─── DEPLOY LOG (khusus owner, tidak ditampilkan ke channel/user lain) ──────
function logDeploy(entry) {
  const all = readJson(DEPLOYS_PATH);
  all.push({ ...entry, at: new Date().toISOString() });
  writeJson(DEPLOYS_PATH, all);
}

function getAllDeploys() { return readJson(DEPLOYS_PATH); }

// ─── BUYERS (list "terima kasih" pembeli credit) ────────────────────────────
function addBuyer(userId, username, amountIDR, creditsGiven, approvedBy) {
  const all = readJson(BUYERS_PATH);
  all.push({
    userId: Number(userId), username: username || "—",
    amountIDR: Number(amountIDR) || 0, creditsGiven: Number(creditsGiven) || 0,
    approvedBy: Number(approvedBy), at: new Date().toISOString(),
  });
  writeJson(BUYERS_PATH, all);
}

function getBuyers() { return readJson(BUYERS_PATH); }

// ─── GITHUB BACKUP (biar kalau server mati, data user/credit tetap aman) ────
let _ghToken = null, _ghUser = null, _ghRepo = "bot-database-backup";

function initGithub(token, username, repo) {
  _ghToken = token;
  _ghUser  = username;
  if (repo) _ghRepo = repo;
}

function isGithubConfigured() { return !!(_ghToken && _ghUser); }

async function backupToGithub(extraFilesMap = {}) {
  if (!isGithubConfigured()) return { ok: false, reason: "not_configured" };

  const hdr = {
    Authorization: `token ${_ghToken}`,
    "Content-Type": "application/json",
    "User-Agent": "CreditBackup-Bot/1.0",
    Accept: "application/vnd.github.v3+json",
  };
  const base = "https://api.github.com";

  try {
    try {
      await axios.get(`${base}/repos/${_ghUser}/${_ghRepo}`, { headers: hdr });
    } catch {
      await axios.post(
        `${base}/user/repos`,
        { name: _ghRepo, private: true, auto_init: true, description: "🔒 Auto backup database bot (jangan dihapus)" },
        { headers: hdr }
      );
      await new Promise(r => setTimeout(r, 2000));
    }

    const filesMap = {
      "credits.json": fs.readFileSync(CREDITS_PATH, "utf-8"),
      "redeem.json": fs.readFileSync(REDEEM_PATH, "utf-8"),
      "deploys.json": fs.readFileSync(DEPLOYS_PATH, "utf-8"),
      "buyers.json": fs.readFileSync(BUYERS_PATH, "utf-8"),
      ...extraFilesMap, // caller kirim users.json, resellers.json, dll dari index.js
    };

    for (const [name, content] of Object.entries(filesMap)) {
      let sha = null;
      try {
        const r = await axios.get(`${base}/repos/${_ghUser}/${_ghRepo}/contents/${name}`, { headers: hdr });
        sha = r.data.sha;
      } catch {}

      const body = {
        message: `🔄 Auto backup - ${new Date().toISOString()}`,
        content: Buffer.from(content, "utf-8").toString("base64"),
      };
      if (sha) body.sha = sha;

      await axios.put(`${base}/repos/${_ghUser}/${_ghRepo}/contents/${name}`, body, { headers: hdr });
    }

    return { ok: true, repo: `${_ghUser}/${_ghRepo}`, url: `https://github.com/${_ghUser}/${_ghRepo}` };
  } catch (err) {
    return { ok: false, reason: err.response?.data?.message || err.message };
  }
}

// ─── FULL SERVER BACKUP (Backup semua file & folder di server) ───────────────
function createFullServerBackupZip(baseDir = "./") {
  const AdmZip = require("adm-zip");
  const zip = new AdmZip();
  
  function addDirToZip(dir, zipPath = "") {
    try {
      const files = fs.readdirSync(dir);
      files.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        const zipEntryPath = zipPath ? `${zipPath}/${file}` : file;
        
        // Skip node_modules, .git, dan folder besar lainnya
        if (file === "node_modules" || file === ".git" || file === ".cache" || 
            file === ".npm" || file === ".npm-global" || file === "backups") {
          return;
        }
        
        if (stat.isDirectory()) {
          addDirToZip(fullPath, zipEntryPath);
        } else if (stat.isFile()) {
          // Backup semua JS, JSON, dan file config penting
          if (file.match(/\.(js|json|txt|md|env|config|lock)$/i) || 
              file === "package.json" || file === ".npmrc" || file === ".gitignore") {
            const content = fs.readFileSync(fullPath, "utf-8");
            zip.addFile(zipEntryPath, Buffer.from(content));
          }
        }
      });
    } catch (err) {
      console.error(`Error reading directory ${dir}:`, err.message);
    }
  }
  
  // Mulai backup dari root project directory
  addDirToZip(baseDir);
  
  // Tambahkan metadata backup
  const metadata = {
    backupAt: new Date().toISOString(),
    baseDir: baseDir,
    includeFiles: ["*.js", "*.json", "*.txt", "*.md", ".env", ".npmrc", ".gitignore"],
    excludeFolders: ["node_modules", ".git", ".cache", ".npm", ".npm-global", "backups"],
    filesCount: zip.getEntries().length
  };
  zip.addFile("BACKUP_MANIFEST.json", Buffer.from(JSON.stringify(metadata, null, 2)));
  
  return zip;
}

function getFullBackupPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").split("T")[0];
  const backupDir = path.join("./", "backups");
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  return path.join(backupDir, `server_full_backup_${timestamp}.zip`);
}

function downloadFullServerBackup() {
  try {
    const zip = createFullServerBackupZip("./");
    const backupPath = getFullBackupPath();
    zip.writeZip(backupPath);
    const size = fs.statSync(backupPath).size;
    const fileCount = zip.getEntries().length;
    return { ok: true, path: backupPath, size: size, files: fileCount };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  START_CREDIT, REFERRAL_BONUS, INVITES_FOR_FREE_PANEL,
  ensureUser, getCredits, addCredits, setCredits, hasCredit, deductCredit,
  confirmReferral, getReferralStats,
  getFreePanelStatus, markFreePanelNotified, markFreePanelClaimed, unmarkFreePanelClaimed,
  createRedeemCode, redeemCode, listRedeemCodes,
  logDeploy, getAllDeploys,
  addBuyer, getBuyers,
  initGithub, isGithubConfigured, backupToGithub,
  createFullServerBackupZip, downloadFullServerBackup, getFullBackupPath,
};
