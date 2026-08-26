const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

// ─── HELPERS ──────────────────────────────────────────────────────────────
function isTextExt(name, exts) {
  const lower = name.toLowerCase();
  return exts.some(ext => lower.endsWith(ext));
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── DOMAIN REPLACE ───────────────────────────────────────────────────────
// Replace semua kemunculan oldUrl -> newUrl di semua file .dart dalam zip.
// Return { changedFiles: [...], occurrences: N }
function replaceDomainInZip(inputZipPath, outputZipPath, oldUrl, newUrl) {
  const zip = new AdmZip(inputZipPath);
  const entries = zip.getEntries();

  const oldRe = new RegExp(escapeRegExp(oldUrl), "g");
  let totalOccurrences = 0;
  const changedFiles = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!isTextExt(entry.entryName, [".dart"])) continue;

    const content = entry.getData().toString("utf8");
    if (!content.includes(oldUrl)) continue;

    const matches = content.match(oldRe);
    const count = matches ? matches.length : 0;
    if (count === 0) continue;

    const newContent = content.replace(oldRe, newUrl);
    zip.updateFile(entry, Buffer.from(newContent, "utf8"));

    totalOccurrences += count;
    changedFiles.push({ file: entry.entryName, count });
  }

  zip.writeZip(outputZipPath);
  return { changedFiles, totalOccurrences };
}

// ─── FULL TEXT REPLACE (di file .dart) ───────────────────────────────────
// Replace semua kemunculan teks lama -> teks baru di semua file .dart dalam zip.
// Beda dengan replaceAppNameInZip: ini cari-ganti teks BEBAS (misal nama toko,
// bukan hanya field app_name di AndroidManifest/strings.xml/Info.plist).
// Return { changedFiles: [...], totalOccurrences: N }
function replaceTextInZip(inputZipPath, outputZipPath, oldText, newText) {
  const zip = new AdmZip(inputZipPath);
  const entries = zip.getEntries();

  const oldRe = new RegExp(escapeRegExp(oldText), "g");
  let totalOccurrences = 0;
  const changedFiles = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!isTextExt(entry.entryName, [".dart"])) continue;

    let content;
    try {
      content = entry.getData().toString("utf8");
    } catch {
      continue;
    }
    if (!content.includes(oldText)) continue;

    const matches = content.match(oldRe);
    const count = matches ? matches.length : 0;
    if (count === 0) continue;

    const newContent = content.replace(oldRe, newText);
    zip.updateFile(entry, Buffer.from(newContent, "utf8"));

    totalOccurrences += count;
    changedFiles.push({ file: entry.entryName, count });
  }

  zip.writeZip(outputZipPath);
  return { changedFiles, totalOccurrences };
}

// Scan zip untuk cari kandidat teks (opsional, untuk validasi keberadaan sebelum proses)
function scanTextInZip(inputZipPath, searchText) {
  const zip = new AdmZip(inputZipPath);
  const entries = zip.getEntries();
  let totalOccurrences = 0;
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!isTextExt(entry.entryName, [".dart"])) continue;

    let content;
    try {
      content = entry.getData().toString("utf8");
    } catch {
      continue;
    }
    if (!content.includes(searchText)) continue;

    const count = content.split(searchText).length - 1;
    totalOccurrences += count;
    files.push({ file: entry.entryName, count });
  }

  return { files, totalOccurrences };
}

// Scan zip untuk cari kandidat "domain lama" (semua http/https url unik di file .dart)
function scanUrlsInZip(inputZipPath) {
  const zip = new AdmZip(inputZipPath);
  const entries = zip.getEntries();
  const urlRegex = /https?:\/\/[^\s"'`)]+/g;
  const counts = new Map();

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!isTextExt(entry.entryName, [".dart"])) continue;

    const content = entry.getData().toString("utf8");
    let m;
    while ((m = urlRegex.exec(content)) !== null) {
      // Ambil base URL saja: protocol://host:port (buang path)
      const full = m[0];
      const baseMatch = full.match(/^(https?:\/\/[^\/\s"'`)]+)/);
      const base = baseMatch ? baseMatch[1] : full;
      counts.set(base, (counts.get(base) || 0) + 1);
    }
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// ─── COLOR REPLACE ────────────────────────────────────────────────────────
// Cari warna hex dominan (RRGGBB, tanpa alpha) di semua file .dart.
function scanDominantColors(inputZipPath) {
  const zip = new AdmZip(inputZipPath);
  const entries = zip.getEntries();
  const hexRegex = /0x(?:[0-9A-Fa-f]{2})?([0-9A-Fa-f]{6})\b/g;
  const counts = new Map();

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!isTextExt(entry.entryName, [".dart"])) continue;

    const content = entry.getData().toString("utf8");
    let m;
    while ((m = hexRegex.exec(content)) !== null) {
      const hex = m[1].toUpperCase();
      if (hex === "FFFFFF" || hex === "000000") continue; // skip putih/hitam polos, biasanya bukan brand color
      counts.set(hex, (counts.get(hex) || 0) + 1);
    }
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// Ganti warna dominan (hex RRGGBB) ke warna baru di:
// - semua file .dart: pattern 0x[AA]RRGGBB (pertahankan prefix alpha kalau ada, default FF)
// - pubspec.yaml: flutter_native_splash color / color_dark (format "#RRGGBB")
// - android/**/values*/colors.xml: <color name="...">#RRGGBB</color>
// - ios/**/Contents.json (opsional, di-skip kalau tidak ada)
function replaceColorInZip(inputZipPath, outputZipPath, oldHex, newHex) {
  const zip = new AdmZip(inputZipPath);
  const entries = zip.getEntries();

  const oldHexUpper = oldHex.toUpperCase();
  const oldHexLower = oldHex.toLowerCase();
  const newHexUpper = newHex.toUpperCase();

  let totalOccurrences = 0;
  const changedFiles = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const name = entry.entryName.toLowerCase();
    let content;
    let isBinary = false;

    try {
      content = entry.getData().toString("utf8");
    } catch {
      isBinary = true;
    }
    if (isBinary || content == null) continue;

    let changed = false;
    let fileCount = 0;

    // 1. File .dart: Color(0x[AA]RRGGBB) case-insensitive
    if (name.endsWith(".dart")) {
      const dartRe = new RegExp(`0x([0-9A-Fa-f]{2})?${oldHexUpper}\\b`, "gi");
      const matches = content.match(dartRe);
      if (matches && matches.length > 0) {
        content = content.replace(dartRe, (full, alphaPrefix) => {
          const alpha = alphaPrefix || "FF";
          return `0x${alpha}${newHexUpper}`;
        });
        fileCount += matches.length;
        changed = true;
      }
    }

    // 2. pubspec.yaml: flutter_native_splash color/color_dark "#RRGGBB"
    if (name === "pubspec.yaml") {
      const yamlRe = new RegExp(`#${oldHexUpper}\\b`, "gi");
      const matches = content.match(yamlRe);
      if (matches && matches.length > 0) {
        content = content.replace(yamlRe, `#${newHexUpper}`);
        fileCount += matches.length;
        changed = true;
      }
    }

    // 3. Android colors.xml / styles.xml: #RRGGBB atau #AARRGGBB
    if (name.includes("/values") && name.endsWith(".xml")) {
      const xmlRe = new RegExp(`#([0-9A-Fa-f]{2})?${oldHexUpper}\\b`, "gi");
      const matches = content.match(xmlRe);
      if (matches && matches.length > 0) {
        content = content.replace(xmlRe, (full, alphaPrefix) => {
          const alpha = alphaPrefix || "";
          return `#${alpha}${newHexUpper}`;
        });
        fileCount += matches.length;
        changed = true;
      }
    }

    if (changed) {
      zip.updateFile(entry, Buffer.from(content, "utf8"));
      totalOccurrences += fileCount;
      changedFiles.push({ file: entry.entryName, count: fileCount });
    }
  }

  zip.writeZip(outputZipPath);
  return { changedFiles, totalOccurrences };
}

// Preset warna umum (hex tanpa #)
const COLOR_PRESETS = {
  merah:  "F44336",
  biru:   "2196F3",
  hijau:  "4CAF50",
  ungu:   "9C27B0",
  kuning: "FFC107",
  orange: "FF9800",
  pink:   "E91E63",
  hitam:  "212121",
  putih:  "FAFAFA",
  cyan:   "00BCD4",
  indigo: "3F51B5",
  teal:   "009688",
};

function isValidHex(hex) {
  return /^[0-9A-Fa-f]{6}$/.test(hex);
}

// ─── ICON REPLACE ─────────────────────────────────────────────────────────
// Ukuran standar icon Android mipmap (px) per density folder
const ANDROID_ICON_SIZES = {
  "mipmap-mdpi": 48,
  "mipmap-hdpi": 72,
  "mipmap-xhdpi": 96,
  "mipmap-xxhdpi": 144,
  "mipmap-xxxhdpi": 192,
};

// Ukuran standar icon iOS AppIcon (px), nama file mengikuti pola umum flutter create
const IOS_ICON_SIZES = {
  "Icon-App-20x20@1x.png": 20,
  "Icon-App-20x20@2x.png": 40,
  "Icon-App-20x20@3x.png": 60,
  "Icon-App-29x29@1x.png": 29,
  "Icon-App-29x29@2x.png": 58,
  "Icon-App-29x29@3x.png": 87,
  "Icon-App-40x40@1x.png": 40,
  "Icon-App-40x40@2x.png": 80,
  "Icon-App-40x40@3x.png": 120,
  "Icon-App-60x60@2x.png": 120,
  "Icon-App-60x60@3x.png": 180,
  "Icon-App-76x76@1x.png": 76,
  "Icon-App-76x76@2x.png": 152,
  "Icon-App-83.5x83.5@2x.png": 167,
  "Icon-App-1024x1024@1x.png": 1024,
};

// Coba load sharp untuk resize; kalau tidak ada, fallback tanpa resize (pakai gambar asli).
let _sharp = null;
try {
  _sharp = require("sharp");
} catch {
  _sharp = null;
}

async function resizeOrOriginal(buffer, size) {
  if (!_sharp) return buffer; // fallback: tanpa resize
  try {
    return await _sharp(buffer).resize(size, size).png().toBuffer();
  } catch {
    return buffer; // gagal resize, tetap pakai buffer asli
  }
}

// Replace semua file icon Android (mipmap ic_launcher.png) & iOS (AppIcon.appiconset) dengan iconBuffer baru.
// Kalau sharp tersedia, otomatis di-resize sesuai ukuran masing-masing slot; kalau tidak, pakai gambar asli.
async function replaceIconInZip(inputZipPath, outputZipPath, iconBuffer) {
  const zip = new AdmZip(inputZipPath);
  const entries = zip.getEntries();

  let changedCount = 0;
  const changedFiles = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    const lower = name.toLowerCase();

    // Android: android/app/src/main/res/mipmap-*/ic_launcher.png (atau ic_launcher_round.png / ic_launcher_foreground.png)
    const androidMatch = lower.match(/android\/app\/src\/main\/res\/(mipmap-[a-z]+)\/(ic_launcher(?:_round|_foreground)?\.png)$/);
    if (androidMatch) {
      const density = androidMatch[1];
      const size = ANDROID_ICON_SIZES[density] || 192;
      const resized = await resizeOrOriginal(iconBuffer, size);
      zip.updateFile(entry, resized);
      changedCount++;
      changedFiles.push(name);
      continue;
    }

    // iOS: ios/Runner/Assets.xcassets/AppIcon.appiconset/*.png
    const iosMatch = lower.match(/ios\/runner\/assets\.xcassets\/appicon\.appiconset\/(.+\.png)$/);
    if (iosMatch) {
      const fileName = name.split("/").pop();
      const size = IOS_ICON_SIZES[fileName] || 192;
      const resized = await resizeOrOriginal(iconBuffer, size);
      zip.updateFile(entry, resized);
      changedCount++;
      changedFiles.push(name);
      continue;
    }
  }

  zip.writeZip(outputZipPath);
  return { changedFiles, changedCount, resized: !!_sharp };
}

// Scan apakah ada icon Android/iOS yang bisa diganti (untuk validasi sebelum proses)
function scanIconTargets(inputZipPath) {
  const zip = new AdmZip(inputZipPath);
  const entries = zip.getEntries();
  const targets = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const lower = entry.entryName.toLowerCase();
    if (lower.match(/android\/app\/src\/main\/res\/mipmap-[a-z]+\/ic_launcher(?:_round|_foreground)?\.png$/)) {
      targets.push(entry.entryName);
    } else if (lower.match(/ios\/runner\/assets\.xcassets\/appicon\.appiconset\/.+\.png$/)) {
      targets.push(entry.entryName);
    }
  }
  return targets;
}

// ─── NAME REPLACE ─────────────────────────────────────────────────────────
// Ganti nama aplikasi di:
// - android/app/src/main/AndroidManifest.xml: android:label="..."
// - pubspec.yaml: name: ... (opsional, biasanya tidak perlu diubah tapi disediakan)
// - ios/Runner/Info.plist: <key>CFBundleDisplayName</key><string>...</string> dan CFBundleName
function replaceAppNameInZip(inputZipPath, outputZipPath, newName) {
  const zip = new AdmZip(inputZipPath);
  const entries = zip.getEntries();

  let totalOccurrences = 0;
  const changedFiles = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const lower = entry.entryName.toLowerCase();

    let content;
    try {
      content = entry.getData().toString("utf8");
    } catch {
      continue;
    }

    let changed = false;
    let fileCount = 0;

    // 1. AndroidManifest.xml -> android:label="..."
    if (lower.endsWith("androidmanifest.xml")) {
      const labelRe = /android:label\s*=\s*"([^"]*)"/g;
      const matches = content.match(labelRe);
      if (matches && matches.length > 0) {
        content = content.replace(labelRe, `android:label="${newName}"`);
        fileCount += matches.length;
        changed = true;
      }
    }

    // 2. android/app/build.gradle atau build.gradle.kts -> resValue "string", "app_name", "..."
    if (lower.endsWith("build.gradle") || lower.endsWith("build.gradle.kts")) {
      const resRe = /resValue\s*\(?\s*"string"\s*,\s*"app_name"\s*,\s*"([^"]*)"\s*\)?/g;
      const matches = content.match(resRe);
      if (matches && matches.length > 0) {
        content = content.replace(resRe, `resValue "string", "app_name", "${newName}"`);
        fileCount += matches.length;
        changed = true;
      }
    }

    // 3. android/app/src/main/res/values*/strings.xml -> <string name="app_name">...</string>
    if (lower.includes("/values") && lower.endsWith("strings.xml")) {
      const stringsRe = /(<string\s+name="app_name">)([^<]*)(<\/string>)/g;
      const matches = content.match(stringsRe);
      if (matches && matches.length > 0) {
        content = content.replace(stringsRe, `$1${newName}$3`);
        fileCount += matches.length;
        changed = true;
      }
    }

    // 4. ios/Runner/Info.plist -> CFBundleDisplayName & CFBundleName
    if (lower.endsWith("info.plist")) {
      const plistRe = /(<key>CFBundle(?:Display)?Name<\/key>\s*<string>)([^<]*)(<\/string>)/g;
      const matches = content.match(plistRe);
      if (matches && matches.length > 0) {
        content = content.replace(plistRe, `$1${newName}$3`);
        fileCount += matches.length;
        changed = true;
      }
    }

    if (changed) {
      zip.updateFile(entry, Buffer.from(content, "utf8"));
      totalOccurrences += fileCount;
      changedFiles.push({ file: entry.entryName, count: fileCount });
    }
  }

  zip.writeZip(outputZipPath);
  return { changedFiles, totalOccurrences };
}

module.exports = {
  replaceDomainInZip,
  scanUrlsInZip,
  scanDominantColors,
  replaceColorInZip,
  replaceIconInZip,
  scanIconTargets,
  replaceAppNameInZip,
  replaceTextInZip,
  scanTextInZip,
  COLOR_PRESETS,
  isValidHex,
};
