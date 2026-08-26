// ─────────────────────────────────────────────────────────────────────────
// hybridFile.js
//
// SEMUA transfer file (kirim & terima) lewat GramJS/MTProto, TANPA
// pengecualian ukuran — file kecil atau gede, dua-duanya selalu GramJS.
// Gambar/foto UI (welcome, notif, dll) TIDAK lewat sini — itu lewat
// telegramAdapter.js:sendPhotoTelegraf() langsung ke Telegraf, biar warna
// tombol (style) tetap kepake (GramJS gak support field itu).
//
// CATATAN: sempat ada fitur "workers paralel" buat percepat transfer, tapi
// dicabut lagi — di VPS yang koneksinya pas-pasan, banyak koneksi sekaligus
// malah lebih gampang gagal daripada 1 koneksi biasa. Simpel & reliable
// lebih diutamakan di sini.
// ─────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const mtproto = require("./mtproto");

function fmtMB(bytes) {
  return ((bytes || 0) / 1024 / 1024).toFixed(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildGramButtons(inlineKeyboard) {
  const { Button } = require("telegram/tl/custom/button");
  return inlineKeyboard.map((row) =>
    row.map((btn) =>
      btn.url ? Button.url(btn.text, btn.url) : Button.inline(btn.text, Buffer.from(btn.callback_data || ""))
    )
  );
}

function toGramParseMode(parse_mode) {
  if (parse_mode === "HTML") return "html";
  if (parse_mode === "Markdown" || parse_mode === "MarkdownV2") return "md";
  return undefined;
}

async function withRetry(label, fn, maxAttempts = 5) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.warn(`[hybridFile] ⚠️ ${label} percobaan ${attempt}/${maxAttempts} gagal: ${e?.message || e}`);
      if (attempt < maxAttempts) {
        // Kalau errornya keliatan kayak koneksi beneran putus (bukan cuma 1
        // chunk telat), paksa reconnect dulu sebelum retry berikutnya —
        // retry di koneksi yang sama-sama mati percuma aja.
        if (mtproto.isNetworkError(e)) {
          await mtproto.forceReconnect();
        }
        const delay = Math.min(3000 * attempt, 15000); // 3s,6s,9s,12s,15s (dibatasi 15s)
        console.log(`[hybridFile] ⏳ Coba lagi dalam ${delay / 1000}s...`);
        await sleep(delay);
      }
    }
  }
  throw new Error(`Gagal ${label} setelah ${maxAttempts}x percobaan: ${lastErr?.message || lastErr}`);
}

// ── KIRIM FILE (selalu GramJS, ukuran berapapun) ────────────────────────
/**
 * @param {import('telegraf').Telegraf} bot - gak dipakai lagi di sini, dibiarin
 *        di parameter biar signature tetap kompatibel sama pemanggil lama.
 * @param {number|string} chatId
 * @param {{
 *   file?: string,                              // path lokal
 *   forwardRef?: {chatId:number, messageId:number}, // forward pesan lain apa adanya (broadcast dst)
 *   caption?: string, parse_mode?: string, reply_markup?: object, forceDocument?: boolean
 * }} opts
 */
async function sendFileSmart(bot, chatId, opts = {}) {
  const { file, forwardRef, caption = "", parse_mode, reply_markup, forceDocument = false } = opts;

  const client = await mtproto.ensureConnected();

  // Forward pesan asli (mis. broadcast reply media) -> native forward via
  // MTProto, gak perlu download+upload ulang sama sekali, size berapapun ok.
  if (forwardRef && forwardRef.chatId && forwardRef.messageId) {
    return await withRetry("forward file", () =>
      client.forwardMessages(chatId, { messages: [forwardRef.messageId], fromPeer: forwardRef.chatId })
    );
  }

  if (!file) throw new Error("[hybridFile] sendFileSmart dipanggil tanpa file/forwardRef yang valid");

  const stat = fs.statSync(file);
  console.log(`[hybridFile] 📦 Kirim ${path.basename(file)} (${fmtMB(stat.size)}MB) via GramJS`);

  const gramButtons = reply_markup?.inline_keyboard ? buildGramButtons(reply_markup.inline_keyboard) : undefined;

  return await withRetry("upload file", () =>
    client.sendFile(chatId, {
      file,
      caption,
      parseMode: toGramParseMode(parse_mode),
      forceDocument,
      ...(gramButtons ? { buttons: gramButtons } : {}),
    })
  );
}

// ── TERIMA FILE (selalu GramJS, ukuran berapapun) ───────────────────────
/**
 * @param {import('telegraf').Telegraf} bot - gak dipakai lagi, lihat catatan di atas.
 * @param {{fileId?:string, fileSize?:number, chatId:number, messageId:number}} src
 * @param {string} destPath
 */
async function downloadFileSmart(bot, src, destPath) {
  const { chatId, messageId, fileSize = 0 } = src;
  console.log(`[hybridFile] 📥 Terima file (${fmtMB(fileSize)}MB) via GramJS`);

  const client = await mtproto.ensureConnected();

  return await withRetry("download file", async () => {
    const msgs = await client.getMessages(chatId, { ids: [messageId] });
    const msg = msgs?.[0];
    if (!msg) throw new Error("Pesan tidak ditemukan untuk didownload via MTProto");
    await client.downloadMedia(msg, { outputFile: destPath });
    return destPath;
  });
}

module.exports = {
  sendFileSmart,
  downloadFileSmart,
};
