const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// Cache
const _cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

// Download dari URL
function downloadBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Terlalu banyak redirect"));

    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { 
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadBuffer(res.headers.location, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

// Ambil buffer gambar - SUPPORT FILE LOKAL + URL
async function getImageBuffer(url) {
  if (!url) return null;

  // CEK FILE LOKAL
  try {
    if (url.startsWith("/") || url.startsWith(".") || 
        url.includes(".jpg") || url.includes(".png") || 
        url.includes(".jpeg") || url.includes(".gif") || url.includes(".webp")) {
      
      if (fs.existsSync(url)) {
        const buffer = fs.readFileSync(url);
        console.log(`[imagefetch] ✅ Load local file: ${path.basename(url)} (${buffer.length} bytes)`);
        return buffer;
      }
    }
  } catch (err) {}

  // CEK CACHE
  const cached = _cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return cached.buffer;
  }

  // DOWNLOAD DARI URL
  try {
    console.log(`[imagefetch] 🌐 Downloading: ${url}`);
    const buffer = await downloadBuffer(url);
    _cache.set(url, { buffer, at: Date.now() });
    return buffer;
  } catch (err) {
    console.error(`[imagefetch] ❌ Gagal: ${url} - ${err.message}`);
    return null;
  }
}

// Kirim foto - FALLBACK KE TEKS
async function sendPhotoSafe(client, chatId, imageUrl, options = {}) {
  const { caption, parseMode = "html", buttons, forceDocument = false, tmpDir = "." } = options;

  // Foto lokal dari folder images/ (welcome, notif user baru, dll) -> selalu
  // lewat Telegraf langsung (client.sendPhotoTelegraf), BUKAN GramJS, biar
  // warna tombol (style) kepake. Ini aman karena foto UI selalu kecil & lokal.
  const isLocalFile = imageUrl && (imageUrl.startsWith("/") || imageUrl.startsWith(".")) && fs.existsSync(imageUrl);
  if (isLocalFile && client.sendPhotoTelegraf) {
    try {
      console.log(`[imagefetch] ✅ Load local file: ${path.basename(imageUrl)} (lewat Telegraf)`);
      return await client.sendPhotoTelegraf(chatId, {
        file: imageUrl,
        caption: caption || "",
        parseMode,
        buttons,
        forceDocument,
      });
    } catch (err) {
      console.error("[sendPhotoSafe] Gagal kirim foto lokal via Telegraf:", err.message);
      // lanjut ke fallback teks di bawah
    }
    return await client.sendMessage(chatId, { message: caption || "", parseMode, ...(buttons ? { buttons } : {}) });
  }

  // Foto dari URL remote (bukan file lokal) -> download dulu, kirim lewat
  // client.sendFile (GramJS) seperti biasa.
  const buffer = await getImageBuffer(imageUrl);

  if (buffer && buffer.length > 0) {
    const tmpFile = path.join(tmpDir, `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
    try {
      fs.writeFileSync(tmpFile, buffer);
      const result = await client.sendFile(chatId, {
        file: tmpFile,
        caption: caption || "",
        parseMode,
        ...(buttons ? { buttons } : {}),
        forceDocument,
      });
      fs.unlink(tmpFile, () => {});
      return result;
    } catch (err) {
      fs.unlink(tmpFile, () => {});
      console.error("[sendPhotoSafe] Gagal kirim foto:", err.message);
    }
  }

  // FALLBACK: Kirim teks aja
  return await client.sendMessage(chatId, {
    message: caption || "",
    parseMode,
    ...(buttons ? { buttons } : {}),
  });
}

module.exports = { downloadBuffer, getImageBuffer, sendPhotoSafe };