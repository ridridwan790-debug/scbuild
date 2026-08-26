// ─── ANALISA ERROR BUILD ────────────────────────────────────────────────────
// Best-effort: baca log error mentah dari GitHub Actions, cari baris yang
// nunjuk ke file+line spesifik, dan cocokkan pola error umum Flutter/Gradle
// ke kemungkinan penyebab yang gampang dibaca. Ini heuristik, bukan analisa
// sempurna — tujuannya cuma bantu user tau harus mulai cek di mana.

// pattern file:line, contoh: lib/main.dart:42:7, app/build.gradle:15
const FILE_LINE_RE = /([A-Za-z0-9_\-./]+\.(dart|kt|kts|java|gradle|xml|yaml|yml|json|properties)):(\d+)(:(\d+))?/g;

// [regex, label penyebab]
const CAUSE_PATTERNS = [
  [/SDK location not found|ANDROID_HOME/i, "Path Android SDK bermasalah di runner (bukan salah project kamu, biasanya self-recover atau perlu lapor owner)."],
  [/Execution failed for task ':app:.*[Dd]ex/i, "Proses dexing/compile Android gagal — biasanya dependency Android yang konflik versi."],
  [/Manifest merger failed/i, "Konflik di AndroidManifest.xml (permission/tag/atribut ganda antar plugin)."],
  [/Could not resolve|Could not find|Could not GET/i, "Dependency tidak ditemukan — cek koneksi/nama package di pubspec.yaml atau build.gradle, mungkin ada typo versi."],
  [/duplicate class|Duplicate class/i, "Ada class/dependency duplikat — biasanya 2 plugin bawa library yang sama versi beda."],
  [/Target of URI doesn't exist|Error.*Target of URI/i, "Import di kode Dart nunjuk ke file/package yang gak ada. Cek nama file & path import-nya."],
  [/google-services\.json/i, "File konfigurasi Firebase (google-services.json) hilang atau salah lokasi di project."],
  [/Unsupported class file major version/i, "Versi Java yang dipakai runner gak cocok sama versi Gradle project. Biasanya perlu update Gradle wrapper di project."],
  [/OutOfMemoryError|out of memory|heap space/i, "Runner kehabisan memori saat proses build — project mungkin terlalu besar/kompleks."],
  [/A problem occurred configuring root project/i, "Ada kesalahan konfigurasi di build.gradle level root project."],
  [/pubspec\.yaml.*not found|No pubspec\.yaml/i, "File pubspec.yaml gak ketemu di root project — cek struktur ZIP kamu."],
  [/version solving failed|Because .* depends on/i, "Konflik versi dependency di pubspec.yaml — beberapa package minta versi yang saling bentrok."],
  [/Null check operator used on a null value/i, "Ada variabel null yang diakses paksa (`!`) di kode Dart kamu — bug logic, bukan masalah environment."],
  [/Undefined name|isn't defined for the (class|type)/i, "Ada nama variabel/fungsi/class yang dipanggil tapi gak terdefinisi — kemungkinan typo atau import kurang."],
  [/Gradle build daemon disappeared|Daemon.*crashed/i, "Gradle daemon di runner crash — biasanya masalah resource runner, coba build ulang."],
  [/keystore|signing config/i, "Ada masalah konfigurasi signing/keystore APK."],
];

function extractLocations(text, max = 5) {
  const found = [];
  const seen = new Set();
  let m;
  FILE_LINE_RE.lastIndex = 0;
  while ((m = FILE_LINE_RE.exec(text)) && found.length < max) {
    const key = m[0];
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ file: m[1], line: m[3], col: m[5] || null });
  }
  return found;
}

function matchCauses(text, max = 3) {
  const hits = [];
  for (const [re, label] of CAUSE_PATTERNS) {
    if (re.test(text)) {
      hits.push(label);
      if (hits.length >= max) break;
    }
  }
  return hits;
}

// errorLines: array of string (dari getFailedStepLog)
function analyzeError(errorLines) {
  if (!errorLines || !errorLines.length) {
    return { locations: [], causes: [] };
  }
  const text = errorLines.join("\n");
  return {
    locations: extractLocations(text),
    causes: matchCauses(text),
  };
}

// Format jadi blok HTML siap tempel di pesan Telegram. Return "" kalau gak
// nemu apa-apa (biar pesan gak jadi aneh nampilin section kosong).
function formatAnalysisHtml(analysis) {
  let out = "";
  if (analysis.locations.length) {
    const lines = analysis.locations.map(l =>
      `• <code>${l.file}</code>${l.line ? ` — baris <b>${l.line}</b>${l.col ? `:${l.col}` : ""}` : ""}`
    ).join("\n");
    out += `\n\n📍 <b>Lokasi Terdeteksi:</b>\n<blockquote>${lines}</blockquote>`;
  }
  if (analysis.causes.length) {
    const lines = analysis.causes.map(c => `• ${c}`).join("\n");
    out += `\n\n💡 <b>Kemungkinan Penyebab:</b>\n<blockquote>${lines}</blockquote>`;
  }
  return out;
}

module.exports = { analyzeError, formatAnalysisHtml };
