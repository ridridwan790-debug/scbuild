// ─────────────────────────────────────────────────────────────────────────
// telegramAdapter.js
//
// Adapter yang bikin Telegraf "menyamar" jadi API lama (client.sendMessage,
// client.sendFile, client.editMessage, dst — gaya GramJS) supaya index.js
// TIDAK perlu dibongkar total. Semua logic bisnis di index.js tetap sama;
// hanya lapisan pengiriman/penerimaan pesannya yang sekarang jalan di atas
// Telegraf (Bot API) untuk TEKS/MENU/TOMBOL. Untuk FILE (kirim & terima),
// SELALU lewat GramJS/MTProto (hybridFile.js + mtproto.js) — gak ada
// pengecualian ukuran, biar satu jalur aja & gak bikin bingung.
// ─────────────────────────────────────────────────────────────────────────

const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");
const CONFIG = require("./config");
const hybridFile = require("./hybridFile");
const mtproto = require("./mtproto");

const bot = new Telegraf(CONFIG.BOT_TOKEN, { handlerTimeout: 15 * 60 * 1000 });

// Kelas penanda doang (buat instanceof di index.js), gak ada logic di dalamnya.
class NewMessage {
  constructor(_opts) {}
}
class CallbackQuery {
  constructor(_opts) {}
}

let messageHandler = null;
let callbackHandler = null;

function mapParseMode(pm) {
  if (!pm) return undefined;
  const v = String(pm).toLowerCase();
  if (v === "html") return "HTML";
  if (v === "md" || v === "markdown") return "Markdown";
  return undefined;
}

function wrapOutgoing(msg) {
  if (!msg || typeof msg !== "object") return msg;
  return { ...msg, id: msg.message_id };
}

// Telegram (Bot API & MTProto) WAJIB format "@username" buat channel/grup
// by username. CONFIG.CHANNEL_USERNAME dkk di config.js disimpen TANPA "@"
// (mis. "INFOZIPER"), jadi kalau dikirim apa adanya ke Telegraf, chat-nya
// gak ketemu & pesan gagal terkirim DIAM-DIAM (gak selalu throw error jelas).
// ID numerik (termasuk grup/channel "-100...") dibiarin apa adanya.
function normalizeChatId(chatId) {
  if (typeof chatId !== "string") return chatId; // udah numeric id
  if (/^-?\d+$/.test(chatId)) return chatId; // "-1001234..." dst
  return chatId.startsWith("@") ? chatId : `@${chatId}`;
}

// Ubah pesan Telegraf jadi bentuk media yang dipahami index.js
// (media.document.size / .attributes[].fileName / media.isPhoto / media.photo)
// chatId+msgId disertain supaya kalau media ini nanti mau di-forward ulang
// (mis. broadcast), hybridFile bisa native-forward via MTProto tanpa download.
function extractMedia(tgMsg, chatId) {
  if (!tgMsg) return null;

  if (tgMsg.document) {
    const d = tgMsg.document;
    return {
      isPhoto: false,
      photo: null,
      fileId: d.file_id,
      size: d.file_size || 0,
      chatId,
      messageId: tgMsg.message_id,
      document: {
        size: d.file_size || 0,
        fileId: d.file_id,
        attributes: [{ fileName: d.file_name || "" }],
      },
    };
  }

  if (tgMsg.photo && tgMsg.photo.length) {
    const largest = tgMsg.photo[tgMsg.photo.length - 1];
    return {
      isPhoto: true,
      photo: { size: largest.file_size || 0 },
      document: null,
      fileId: largest.file_id,
      size: largest.file_size || 0,
      chatId,
      messageId: tgMsg.message_id,
    };
  }

  if (tgMsg.video) {
    const v = tgMsg.video;
    return {
      isPhoto: false,
      photo: null,
      fileId: v.file_id,
      size: v.file_size || 0,
      chatId,
      messageId: tgMsg.message_id,
      document: {
        size: v.file_size || 0,
        fileId: v.file_id,
        attributes: [{ fileName: v.file_name || "video.mp4" }],
      },
    };
  }

  return null;
}

function wrapMessage(tgMsg, chatId, chatType) {
  if (!tgMsg) return null;
  const media = extractMedia(tgMsg, chatId);
  return {
    id: tgMsg.message_id,
    chatId,
    senderId: tgMsg.from?.id,
    text: tgMsg.text || tgMsg.caption || "",
    entities: tgMsg.entities || tgMsg.caption_entities || [],
    media,
    document: media?.document ? { file_name: media.document.attributes[0]?.fileName || "" } : null,
    // true kalau chat privat 1-on-1, false kalau grup/channel — dipakai buat
    // ganti pengecekan lama GramJS (event.message.peerId.className !== "PeerUser")
    isPrivate: chatType ? chatType === "private" : true,
    getSender: async () => ({
      id: tgMsg.from?.id,
      username: tgMsg.from?.username,
      firstName: tgMsg.from?.first_name,
    }),
    getReplyMessage: async () => wrapMessage(tgMsg.reply_to_message, chatId, chatType),
  };
}

function addEventHandler(handler, filter) {
  if (filter instanceof CallbackQuery) callbackHandler = handler;
  else messageHandler = handler;
}

// ── API "client.*" gaya GramJS, diimplementasi pakai Telegraf (teks/menu)
//    dan GramJS murni (file, apapun ukurannya) ─────────────────────────

// Kalau `file` yang dikasih adalah object media hasil getReplyMessage()/msg.media
// (bukan path lokal), ubah jadi referensi {chatId, messageId} biar hybridFile
// bisa native-forward pesan aslinya lewat MTProto tanpa download-upload ulang.
function normalizeFileArg(file) {
  if (file && typeof file === "object" && file.fileId) {
    return { file: null, forwardRef: { chatId: file.chatId, messageId: file.messageId } };
  }
  return { file, forwardRef: null };
}

async function sendMessage(chatId, opts = {}) {
  chatId = normalizeChatId(chatId);
  const text = opts.message ?? opts.text ?? "";
  const parse_mode = mapParseMode(opts.parseMode);
  const reply_markup = opts.buttons ? { inline_keyboard: opts.buttons } : undefined;

  if (opts.file) {
    const { file, forwardRef } = normalizeFileArg(opts.file);
    return wrapOutgoing(
      await hybridFile.sendFileSmart(bot, chatId, {
        file,
        forwardRef,
        caption: text,
        parse_mode,
        reply_markup,
        forceDocument: opts.forceDocument,
      })
    );
  }
  return wrapOutgoing(await bot.telegram.sendMessage(chatId, text, { parse_mode, reply_markup }));
}

async function sendFile(chatId, opts = {}) {
  chatId = normalizeChatId(chatId);
  const parse_mode = mapParseMode(opts.parseMode);
  const reply_markup = opts.buttons ? { inline_keyboard: opts.buttons } : undefined;
  const { file, forwardRef } = normalizeFileArg(opts.file);
  return wrapOutgoing(
    await hybridFile.sendFileSmart(bot, chatId, {
      file,
      forwardRef,
      caption: opts.caption || "",
      parse_mode,
      reply_markup,
      forceDocument: opts.forceDocument,
    })
  );
}

// Khusus buat foto UI/dekoratif (welcome, notif user baru, dll — biasanya
// dari folder images/), SELALU lewat Telegraf, BUKAN GramJS. Alasannya:
// GramJS gak support field `style` (warna tombol Bot API 9.4), jadi kalau
// foto+tombol dikirim lewat GramJS, tombolnya jadi abu-abu polos. Foto UI
// ini selalu kecil & lokal, jadi aman & malah lebih cepat lewat Bot API.
async function sendPhotoTelegraf(chatId, opts = {}) {
  chatId = normalizeChatId(chatId);
  const { file, caption = "", parseMode, buttons, forceDocument = false } = opts;
  const parse_mode = mapParseMode(parseMode);
  const reply_markup = buttons ? { inline_keyboard: buttons } : undefined;
  const source = { source: fs.createReadStream(file), filename: path.basename(file) };
  const msg = forceDocument
    ? await bot.telegram.sendDocument(chatId, source, { caption, parse_mode, reply_markup })
    : await bot.telegram.sendPhoto(chatId, source, { caption, parse_mode, reply_markup });
  return wrapOutgoing(msg);
}

async function editMessage(chatId, opts = {}) {
  chatId = normalizeChatId(chatId);
  const parse_mode = mapParseMode(opts.parseMode);
  const reply_markup = opts.buttons ? { inline_keyboard: opts.buttons } : undefined;
  try {
    return await bot.telegram.editMessageText(chatId, opts.message, undefined, opts.text, {
      parse_mode,
      reply_markup,
    });
  } catch (e) {
    // Pesan targetnya FOTO (ada caption, bukan teks biasa) -> editMessageText
    // gak bisa dipakai buat itu, Telegram butuh editMessageCaption. Ini
    // kejadian di banyak menu karena banyak pesan awalnya dikirim sebagai
    // foto (welcome photo dkk) lalu di-"edit" pas ganti menu.
    const msg = e?.message || e?.description || "";
    if (msg.includes("no text in the message to edit") || msg.includes("there is no text")) {
      return await bot.telegram.editMessageCaption(chatId, opts.message, undefined, opts.text, {
        parse_mode,
        reply_markup,
      });
    }
    throw e;
  }
}

async function deleteMessages(chatId, ids = []) {
  chatId = normalizeChatId(chatId);
  for (const id of ids) {
    try {
      await bot.telegram.deleteMessage(chatId, id);
    } catch (_) {}
  }
}

async function getEntity(idOrUsername) {
  const chat = await bot.telegram.getChat(normalizeChatId(idOrUsername));
  return {
    id: chat.id,
    firstName: chat.first_name || chat.title,
    username: chat.username,
    className: chat.type,
  };
}

async function getMe() {
  return await bot.telegram.getMe();
}

async function getMessages(chatId, { ids } = {}) {
  // Bot API TIDAK bisa ambil pesan lama by ID -> lewat MTProto (GramJS)
  const client = await mtproto.ensureConnected();
  const msgs = await client.getMessages(chatId, { ids });
  return msgs.map((m) => ({ message: m.message, caption: m.message }));
}

async function downloadMedia(msgLike, opts = {}) {
  const media = msgLike?.media || msgLike;
  const fileId = media?.fileId || media?.document?.fileId;
  const size = media?.size || media?.document?.size || 0;
  if (!fileId) throw new Error("[adapter] Pesan ini tidak punya file media untuk didownload");
  await hybridFile.downloadFileSmart(
    bot,
    { fileId, fileSize: size, chatId: msgLike.chatId, messageId: msgLike.id },
    opts.outputFile
  );
  return opts.outputFile;
}

async function downloadProfilePhoto(sender) {
  try {
    const userId = typeof sender === "object" ? sender.id : sender;
    const client = await mtproto.ensureConnected();
    const buf = await client.downloadProfilePhoto(userId, { isBig: false });
    return buf && buf.length ? buf : null;
  } catch (e) {
    console.warn("[adapter] downloadProfilePhoto gagal:", e.message);
    return null;
  }
}

async function setMyCommands(commands) {
  return await bot.telegram.setMyCommands(commands);
}

async function invoke() {
  throw new Error(
    "[adapter] client.invoke() tidak dipakai lagi di mode Telegraf — pakai client.setMyCommands() atau bot.telegram langsung."
  );
}

async function start() {
  // PENTING soal concurrency: Telegraf secara default memproses update
  // SATU-SATU berurutan — kalau handler di-`await` di sini, update
  // berikutnya (misal /start dari user lain) BARU diproses setelah yang
  // sekarang selesai total (cek 3 channel + load gambar + kirim pesan, dst).
  // Efeknya kalau lagi rame/di-spam, antreannya numpuk dan user ngerasa bot
  // "diem"/"stuck" padahal cuma lagi ngantre. GramJS versi lama gak seketat
  // ini soal urutan, makanya dulu kerasa lebih responsif pas rame.
  //
  // Fix: jangan di-`await` di sini — biar Telegraf langsung lanjut ambil
  // update berikutnya, dan tiap /start atau callback diproses PARALEL
  // (bukan antre satu-satu). Error tetap ketangkep lewat .catch().
  bot.on("message", (ctx) => {
    console.log(`📨 [adapter] Update pesan masuk dari ${ctx.from?.id} (${ctx.from?.username || "-"}): "${ctx.message?.text || "[non-text]"}"`);
    if (!messageHandler) {
      console.warn("⚠️ [adapter] messageHandler belum terdaftar, update ini dilewati.");
      return;
    }
    const chatId = ctx.chat.id;
    const msg = wrapMessage(ctx.message, chatId, ctx.chat.type);
    messageHandler({ message: msg, chatId }).catch((e) =>
      console.error("[adapter] message handler error:", e)
    );
  });

  bot.on("callback_query", (ctx) => {
    console.log(`🔘 [adapter] Callback masuk dari ${ctx.callbackQuery.from?.id}: "${ctx.callbackQuery.data}"`);
    if (!callbackHandler) {
      console.warn("⚠️ [adapter] callbackHandler belum terdaftar, update ini dilewati.");
      return;
    }
    const cq = ctx.callbackQuery;
    const chatId = cq.message?.chat.id;
    callbackHandler({
      data: Buffer.from(cq.data || ""),
      chatId,
      senderId: cq.from.id,
      messageId: cq.message?.message_id,
      answer: async (a = {}) => {
        try {
          await ctx.answerCbQuery(a.message || undefined, { show_alert: !!a.alert });
        } catch (_) {}
      },
    }).catch((e) => {
      console.error("[adapter] callback handler error:", e);
    });
  });

  bot.catch((err) => console.error("[adapter] Telegraf error:", err));

  // Hapus webhook lama kalau ada — kalau webhook masih aktif, long-polling
  // TIDAK akan pernah menerima update apapun (Telegram cuma kirim ke satu-satunya
  // jalur yang aktif: webhook ATAU polling, gak bisa dua-duanya).
  try {
    const info = await bot.telegram.getWebhookInfo();
    if (info.url) {
      console.log(`🧹 [adapter] Webhook lama terdeteksi (${info.url}) -> dihapus supaya polling bisa jalan...`);
      await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    }
  } catch (e) {
    console.error("[adapter] gagal cek/hapus webhook:", e.message);
  }

  // PENTING: bot.launch() di Telegraf BLOCKING — promise-nya baru resolve
  // kalau bot di-stop, BUKAN pas polling berhasil nyala. Kalau di-`await`,
  // baris `client.addEventHandler(...)` di index.js (yang dipanggil setelah
  // `await client.start()`) gak akan PERNAH kejalan, jadi messageHandler /
  // callbackHandler selamanya null -> bot connect tapi gak pernah nyaut apa-apa.
  // Makanya di sini SENGAJA gak di-await.
  bot.launch()
    .then(() => console.log("✅ [adapter] Polling Telegraf aktif."))
    .catch((e) => console.error("❌ [adapter] bot.launch() gagal:", e));

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

const client = {
  sendMessage,
  sendFile,
  sendPhotoTelegraf,
  editMessage,
  deleteMessages,
  getEntity,
  getMe,
  getMessages,
  downloadMedia,
  downloadProfilePhoto,
  setMyCommands,
  invoke,
  addEventHandler,
  start,
};

module.exports = { bot, client, NewMessage, CallbackQuery };
