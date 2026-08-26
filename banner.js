// ─── BANNER GENERATOR (Canvas) ─────────────────────────────────────────────
// Pakai @napi-rs/canvas: prebuilt binary, TIDAK butuh compile native
let CanvasLib = null;
try {
  CanvasLib = require("@napi-rs/canvas");
} catch {
  CanvasLib = null;
}

const { createCanvas, loadImage, GlobalFonts } = CanvasLib || {};

// ─── HELPERS ────────────────────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawVerticalGradient(ctx, w, h, colorStops) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  colorStops.forEach(([stop, color]) => g.addColorStop(stop, color));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function drawDiagonalAccent(ctx, w, h, colorStops) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  colorStops.forEach(([stop, color]) => g.addColorStop(stop, color));
  return g;
}

function drawParticles(ctx, w, h, count, color) {
  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = Math.random() * 2 + 0.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

async function drawAvatar(ctx, photoBuffer, cx, cy, radius, ringColor) {
  // Ring glow
  ctx.save();
  ctx.shadowColor = ringColor;
  ctx.shadowBlur = 30;
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 6, 0, Math.PI * 2);
  ctx.fillStyle = ringColor;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (photoBuffer) {
    try {
      const img = await loadImage(photoBuffer);
      const size = Math.min(img.width, img.height);
      const sx = (img.width - size) / 2;
      const sy = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, cx - radius, cy - radius, radius * 2, radius * 2);
    } catch {
      drawAvatarPlaceholder(ctx, cx, cy, radius);
    }
  } else {
    drawAvatarPlaceholder(ctx, cx, cy, radius);
  }
  ctx.restore();
}

function drawAvatarPlaceholder(ctx, cx, cy, radius) {
  ctx.fillStyle = "#1a1e2e";
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  ctx.fillStyle = "#6b7a9f";
  ctx.font = `bold ${Math.floor(radius * 1.1)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("👤", cx, cy + 4);
}

function fitText(ctx, text, maxWidth, baseSize, fontWeight = "bold") {
  let size = baseSize;
  ctx.font = `${fontWeight} ${size}px sans-serif`;
  while (ctx.measureText(text).width > maxWidth && size > 14) {
    size -= 2;
    ctx.font = `${fontWeight} ${size}px sans-serif`;
  }
  return size;
}

function truncate(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + "…";
}

// ─── BANNER 1: WELCOME USER BARU ───────────────────────────────────────────
// Warna: Dark Purple to Deep Blue (Elegan & Profesional)
async function generateWelcomeBanner({ name, userId, username, photoBuffer, botName, totalUsers }) {
  if (!CanvasLib) throw new Error("Modul @napi-rs/canvas tidak terinstall di server.");

  const W = 1200, H = 675;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Gradient background modern
  drawVerticalGradient(ctx, W, H, [
    [0, "#0c0e1a"],
    [0.5, "#141829"],
    [1, "#1a2040"],
  ]);
  drawParticles(ctx, W, H, 120, "#7b9cff");

  // Diagonal accent kanan atas (lebih halus)
  ctx.save();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = drawDiagonalAccent(ctx, W, H, [[0, "#6c8cff"], [1, "#a855f7"]]);
  ctx.beginPath();
  ctx.moveTo(W * 0.6, 0);
  ctx.lineTo(W, 0);
  ctx.lineTo(W, H * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Card utama dengan glassmorphism
  const cardX = 60, cardY = 60, cardW = W - 120, cardH = H - 120;
  ctx.save();
  ctx.shadowColor = "rgba(108, 140, 255, 0.15)";
  ctx.shadowBlur = 50;
  roundRect(ctx, cardX, cardY, cardW, cardH, 32);
  ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
  ctx.fill();
  ctx.restore();
  
  ctx.save();
  roundRect(ctx, cardX, cardY, cardW, cardH, 32);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.stroke();
  ctx.restore();

  // ─── EMOJI & ICON DI GAMBAR (FIX) ──────────────────────────────────────
  // Badge atas - pake bentuk geometris bukan emoji biar fix
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, cardX + 40, cardY + 32, 8, 8, 2);
  ctx.fillStyle = "#6c8cff";
  ctx.fill();
  ctx.restore();
  
  ctx.font = "600 20px sans-serif";
  ctx.fillStyle = "#8aa4ff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("WELCOME NEW MEMBER", cardX + 58, cardY + 48);

  ctx.font = "bold 28px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(botName || "BOT BUILD APK", cardX + 58, cardY + 82);

  // Garis dekorasi
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cardX + 40, cardY + 105);
  ctx.lineTo(cardX + 280, cardY + 105);
  ctx.strokeStyle = "rgba(108, 140, 255, 0.3)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // Avatar
  const avatarCx = cardX + 150, avatarCy = cardY + 260, avatarR = 95;
  await drawAvatar(ctx, photoBuffer, avatarCx, avatarCy, avatarR, "#6c8cff");

  // Info user
  const infoX = avatarCx + avatarR + 70;
  const infoMaxW = cardX + cardW - 48 - infoX;

  const displayName = name || "User";
  const nameSize = fitText(ctx, displayName, infoMaxW, 44);
  ctx.font = `bold ${nameSize}px sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(truncate(ctx, displayName, infoMaxW), infoX, avatarCy - 40);

  // Detail dengan icon geometris (bukan emoji)
  ctx.font = "20px sans-serif";
  ctx.fillStyle = "#8896b8";
  ctx.textBaseline = "middle";
  
  // ID
  ctx.save();
  ctx.beginPath();
  ctx.arc(infoX + 6, avatarCy - 2, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#6c8cff";
  ctx.fill();
  ctx.restore();
  ctx.fillText(`ID  ${userId}`, infoX + 18, avatarCy - 2);
  
  // Username
  ctx.save();
  ctx.beginPath();
  ctx.arc(infoX + 6, avatarCy + 32, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#a855f7";
  ctx.fill();
  ctx.restore();
  ctx.fillText(`User  ${username || "—"}`, infoX + 18, avatarCy + 32);
  
  // Total users
  if (totalUsers != null) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(infoX + 6, avatarCy + 66, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#22d3ee";
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#22d3ee";
    ctx.fillText(`Member ke-${totalUsers}`, infoX + 18, avatarCy + 66);
  }

  // Footer
  ctx.textBaseline = "bottom";
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cardX + 40, cardY + cardH - 80);
  ctx.lineTo(cardX + cardW - 40, cardY + cardH - 80);
  ctx.stroke();

  ctx.font = "18px sans-serif";
  ctx.fillStyle = "#5a6a8a";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }), cardX + 40, cardY + cardH - 32);

  ctx.textAlign = "right";
  ctx.fillStyle = "#6c8cff";
  ctx.font = "600 18px sans-serif";
  ctx.fillText("Welcome to the community", cardX + cardW - 40, cardY + cardH - 32);

  return canvas.toBuffer("image/png");
}

// ─── BANNER 2: BUILD SUKSES ─────────────────────────────────────────────────
// Warna: Dark Emerald to Teal (Fresh & Professional)
async function generateBuildBanner({ name, userId, project, mode, apkSize, duration, botName, type }) {
  if (!CanvasLib) throw new Error("Modul @napi-rs/canvas tidak terinstall di server.");

  const W = 1200, H = 675;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Gradient modern
  drawVerticalGradient(ctx, W, H, [
    [0, "#061210"],
    [0.5, "#0a1f1a"],
    [1, "#0d2d26"],
  ]);
  drawParticles(ctx, W, H, 120, "#34d399");

  // Diagonal accent
  ctx.save();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = drawDiagonalAccent(ctx, W, H, [[0, "#10b981"], [1, "#06b6d4"]]);
  ctx.beginPath();
  ctx.moveTo(W * 0.6, 0);
  ctx.lineTo(W, 0);
  ctx.lineTo(W, H * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const cardX = 60, cardY = 60, cardW = W - 120, cardH = H - 120;
  ctx.save();
  ctx.shadowColor = "rgba(16, 185, 129, 0.15)";
  ctx.shadowBlur = 50;
  roundRect(ctx, cardX, cardY, cardW, cardH, 32);
  ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
  ctx.fill();
  ctx.restore();
  
  roundRect(ctx, cardX, cardY, cardW, cardH, 32);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.stroke();

  // ─── EMOJI & ICON DI GAMBAR (FIX) ──────────────────────────────────────
  // Success mark - pake bentuk geometris
  ctx.save();
  ctx.shadowColor = "#10b981";
  ctx.shadowBlur = 40;
  ctx.beginPath();
  ctx.arc(cardX + 80, cardY + 80, 40, 0, Math.PI * 2);
  ctx.fillStyle = "#10b981";
  ctx.fill();
  ctx.restore();
  
  // Centang (bukan emoji)
  ctx.save();
  ctx.translate(cardX + 80, cardY + 80);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(-16, 2);
  ctx.lineTo(-6, 12);
  ctx.lineTo(18, -10);
  ctx.stroke();
  ctx.restore();

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "600 20px sans-serif";
  ctx.fillStyle = "#34d399";
  ctx.fillText("BUILD SUCCESSFUL", cardX + 135, cardY + 58);

  ctx.font = "bold 28px sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(botName || "BOT BUILD APK", cardX + 135, cardY + 94);

  // Garis dekorasi
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cardX + 40, cardY + 118);
  ctx.lineTo(cardX + 300, cardY + 118);
  ctx.strokeStyle = "rgba(16, 185, 129, 0.3)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // Rincian dengan icon geometris
  const detailData = [
    { label: "Developer", value: name || "-", color: "#34d399" },
    { label: "User ID", value: String(userId), color: "#60a5fa" },
    { label: "Project", value: project || "-", color: "#a78bfa" },
    { label: "Mode", value: mode || "-", color: "#f472b6" },
    { label: "Size", value: apkSize ? `${apkSize} MB` : "-", color: "#fbbf24" },
    { label: "Duration", value: duration || "-", color: "#34d399" },
  ];

  let rowY = cardY + 185;
  const rowGap = 58;
  const labelX = cardX + 48;
  const dotX = labelX + 16;
  const valueX = cardX + 170;
  const valueMaxW = cardX + cardW - 48 - valueX;

  detailData.forEach(({ label, value, color }) => {
    // Dot icon
    ctx.save();
    ctx.beginPath();
    ctx.arc(dotX, rowY + 2, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();

    ctx.font = "20px sans-serif";
    ctx.fillStyle = "#8896b8";
    ctx.textBaseline = "middle";
    ctx.fillText(label, dotX + 14, rowY + 2);

    ctx.font = "600 22px sans-serif";
    ctx.fillStyle = "#e8edf5";
    ctx.fillText(truncate(ctx, String(value), valueMaxW), valueX, rowY + 2);
    rowY += rowGap;
  });

  // Footer
  ctx.textBaseline = "bottom";
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cardX + 40, cardY + cardH - 80);
  ctx.lineTo(cardX + cardW - 40, cardY + cardH - 80);
  ctx.stroke();

  ctx.font = "18px sans-serif";
  ctx.fillStyle = "#5a7a72";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }), cardX + 40, cardY + cardH - 32);

  ctx.textAlign = "right";
  ctx.fillStyle = "#10b981";
  ctx.font = "600 18px sans-serif";
  ctx.fillText("Build completed successfully", cardX + cardW - 40, cardY + cardH - 32);

  return canvas.toBuffer("image/png");
}

module.exports = {
  isAvailable: !!CanvasLib,
  generateWelcomeBanner,
  generateBuildBanner,
};