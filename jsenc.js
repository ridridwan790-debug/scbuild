const crypto = require("crypto");
let JsConfuser;
try {
  JsConfuser = require("js-confuser");
} catch {
  JsConfuser = null; // ditangani di pemanggil: kalau null, fitur enc JS dimatikan otomatis
}

// ─── HELPERS ──────────────────────────────────────────────────────────────
function randomString(set, length) {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += set[Math.floor(Math.random() * set.length)];
  }
  return result;
}

function randomLength(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const ALPHANUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";

const MANDARIN = ["龙", "虎", "风", "云", "山", "河", "天", "地", "雷", "电", "火", "水", "木", "金", "土", "星", "月", "日", "光", "影"];
const ARABIC = ["أ", "ب", "ت", "ث", "ج", "ح", "خ", "د", "ذ", "ر", "ز", "س", "ش", "ص", "ض", "ط", "ظ", "ع", "غ", "ف"];
const JAPANESE = ["あ", "い", "う", "え", "お", "か", "き", "く", "け", "こ", "さ", "し", "す", "せ", "そ", "た", "ち", "つ", "て", "と"];
const JAPANESE_ARABIC = [...JAPANESE, ...ARABIC];

const buildConfig = (overrides) => ({
  target: "node",
  compact: true,
  renameVariables: true,
  renameGlobals: true,
  identifierGenerator: "randomized",
  ...overrides,
});

// ─── JS-CONFUSER CONFIGS (15+ mode) ───────────────────────────────────────
const JsConfig = {
  standard: () => buildConfig({
    stringEncoding: true, stringSplitting: true, controlFlowFlattening: 0.75,
    duplicateLiteralsRemoval: true, deadCode: true, opaquePredicates: true,
  }),
  strong: () => buildConfig({
    stringEncoding: true, stringSplitting: true, controlFlowFlattening: 0.85,
    duplicateLiteralsRemoval: true, deadCode: true, opaquePredicates: true,
  }),
  ultra: () => buildConfig({
    identifierGenerator: () => `z${randomString(DIGITS, 1)}${randomString(LOWERCASE, 1)}${randomString(ALPHANUM, 4)}`,
    stringCompression: true, stringEncoding: true, stringSplitting: true,
    controlFlowFlattening: 0.9, flatten: true, rgf: true, deadCode: true, opaquePredicates: true,
  }),
  nebula: () => buildConfig({
    identifierGenerator: () => `NX${randomString(ALPHA, 4)}`,
    stringCompression: true, stringEncoding: true, stringSplitting: true,
    controlFlowFlattening: 0.75, flatten: true, rgf: true, deadCode: true, opaquePredicates: true,
    globalConcealing: true, objectExtraction: true, duplicateLiteralsRemoval: true,
  }),
  nexus: () => buildConfig({
    identifierGenerator: () => {
      const prefixes = ["ペラNEXUS", "座NEXUS齐ENC", "ペHARD続ENC"];
      const selected = prefixes[Math.floor(Math.random() * prefixes.length)];
      const hash = crypto.createHash("sha256").update(crypto.randomBytes(8)).digest("hex").slice(0, 6);
      return selected + "_" + hash;
    },
    stringCompression: true, stringConcealing: true, stringEncoding: true, stringSplitting: true,
    controlFlowFlattening: 0.5, flatten: true, opaquePredicates: true,
    globalConcealing: true, objectExtraction: true, duplicateLiteralsRemoval: true,
  }),
  siu: () => buildConfig({
    // NOTE: sebelumnya pakai karakter "Mathematical Bold" (𝗡𝗲𝘅𝘂𝘀 dll) yang
    // TIDAK valid sebagai identifier JS (tidak punya properti ID_Start/
    // ID_Continue di spesifikasi ECMAScript) -> hasil obfuscate selalu jadi
    // syntax error waktu dijalankan. Diganti ke campuran Han+Hiragana (valid
    // ID_Start) supaya tetap unik & "eksotis" tapi hasilnya jalan normal.
    identifierGenerator: () => `犬Nexusえ火Modzu水${randomString(ALPHANUM, 6)}`,
    stringCompression: true, stringEncoding: true, stringSplitting: true,
    controlFlowFlattening: 0.85, flatten: true, duplicateLiteralsRemoval: true,
    deadCode: true, opaquePredicates: true,
  }),
  mandarin: () => buildConfig({
    identifierGenerator: () => randomString(MANDARIN, randomLength(3, 6)),
    stringEncoding: true, stringSplitting: true, controlFlowFlattening: 0.85,
    duplicateLiteralsRemoval: true, deadCode: true, opaquePredicates: true,
  }),
  arab: () => buildConfig({
    identifierGenerator: () => randomString(ARABIC, randomLength(3, 6)),
    stringEncoding: true, stringSplitting: true, controlFlowFlattening: 0.85,
    duplicateLiteralsRemoval: true, deadCode: true, opaquePredicates: true,
  }),
  japan: () => buildConfig({
    identifierGenerator: () => randomString(JAPANESE, randomLength(3, 6)),
    stringEncoding: true, stringSplitting: true, controlFlowFlattening: 0.85,
    flatten: true, duplicateLiteralsRemoval: true, deadCode: true, opaquePredicates: true,
  }),
  japxab: () => buildConfig({
    identifierGenerator: () => randomString(JAPANESE_ARABIC, randomLength(3, 6)),
    stringCompression: true, stringConcealing: true, stringEncoding: true, stringSplitting: true,
    controlFlowFlattening: 0.85, flatten: true, duplicateLiteralsRemoval: true,
    deadCode: true, opaquePredicates: true,
  }),
  invis: () => buildConfig({
    identifierGenerator: () => {
      let result = "";
      const len = randomLength(2, 4);
      for (let i = 0; i < len; i++) result += "_";
      result += Math.random().toString(36).slice(2, 5);
      return result;
    },
    stringEncoding: true, stringSplitting: true, controlFlowFlattening: 0.15,
    duplicateLiteralsRemoval: true, deadCode: true, opaquePredicates: true,
  }),
  stealth: () => buildConfig({
    identifierGenerator: () => randomString(ALPHA, randomLength(1, 2)),
    stringEncoding: true, stringSplitting: true, controlFlowFlattening: 0.25,
    duplicateLiteralsRemoval: true, deadCode: true, opaquePredicates: true,
  }),
  big: () => buildConfig({
    identifierGenerator: () => randomString(ALPHA, randomLength(8, 12)),
    stringEncoding: true, stringSplitting: true, controlFlowFlattening: 0.4,
    duplicateLiteralsRemoval: true, deadCode: true, opaquePredicates: true,
  }),
  max: (intensity = 8) => buildConfig({
    identifierGenerator: () => `mX${randomString(ALPHA, randomLength(5, 8))}`,
    stringCompression: true, stringConcealing: true, stringEncoding: true, stringSplitting: true,
    controlFlowFlattening: intensity / 10, flatten: true, rgf: true, deadCode: true,
    opaquePredicates: true, globalConcealing: true, objectExtraction: true, duplicateLiteralsRemoval: false,
  }),
  custom: (name = "ZIPERR") => buildConfig({
    identifierGenerator: () => `${name}_${randomString(ALPHANUM, randomLength(2, 4))}`,
    stringEncoding: true, stringSplitting: true, controlFlowFlattening: 0.75,
    duplicateLiteralsRemoval: true, deadCode: true, opaquePredicates: true,
  }),
};

async function obfTimeLocked(code, days = 30) {
  if (!JsConfuser) throw new Error("Modul js-confuser tidak terinstall di server.");
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + parseInt(days));

  const wrappedCode =
    `(function(){
      const expiry=${expiry.getTime()};
      if(new Date().getTime() > expiry) {
        throw new Error('Script expired');
      }
      ${code}
    })();`;

  const result = await JsConfuser.obfuscate(wrappedCode, {
    target: "node", compact: true, renameVariables: true, renameGlobals: true,
    identifierGenerator: "randomized", stringCompression: true, stringConcealing: true,
    stringEncoding: true, controlFlowFlattening: 0.5, flatten: true, opaquePredicates: true,
    globalConcealing: true, duplicateLiteralsRemoval: true, selfDefending: true, antiDebug: true,
  });

  return result.code || result;
}

async function obfQuantum(code) {
  if (!JsConfuser) throw new Error("Modul js-confuser tidak terinstall di server.");
  const phantomCode = new Date().getMilliseconds() % 3 === 0
    ? "if(Math.random() > 0.999) console.log('PT');"
    : "";

  const result = await JsConfuser.obfuscate(code + phantomCode, {
    target: "node", compact: true, renameVariables: true, renameGlobals: true,
    identifierGenerator: () => {
      const timestamp = new Date().getTime().toString().slice(-5);
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$#@&*";
      let id = "qV_";
      for (let i = 0; i < 6; i++) {
        const charIndex = (parseInt(timestamp[i % 5]) + i * 2) % chars.length;
        id += chars[charIndex];
      }
      return id;
    },
    stringCompression: true, stringEncoding: true, controlFlowFlattening: 0.6,
    flatten: true, rgf: true, opaquePredicates: true, globalConcealing: true,
    duplicateLiteralsRemoval: true, selfDefending: true, antiDebug: true,
  });

  return result.code || result;
}

// Cek hasil obfuscate itu JS yang bisa di-parse atau tidak. js-confuser kadang
// menghasilkan kode rusak untuk kombinasi konfigurasi/identifier tertentu —
// tanpa cek ini, bot bakal ngirim file "berhasil" padahal isinya syntax error.
function isValidJsOutput(code) {
  try {
    new Function(code);
    return true;
  } catch {
    return false;
  }
}

async function obfuscateJS(code, style, _isRetry = false) {
  if (!JsConfuser) throw new Error("Modul js-confuser tidak terinstall di server.");
  if (style === "quantum") return obfQuantum(code);
  if (style === "timelocked") return obfTimeLocked(code, 30);

  const configFn = JsConfig[style];
  if (!configFn) throw new Error(`Mode enkripsi JS "${style}" tidak dikenal.`);

  const config = style === "max" ? configFn(8) : style === "custom" ? configFn("ZIPERR") : configFn();
  const result = await JsConfuser.obfuscate(code, config);

  let output = result;
  if (result && typeof result === "object") {
    output = result.code || result.result || JSON.stringify(result);
  }
  if (typeof output !== "string" || output.length < 5) {
    throw new Error("Hasil enkripsi kosong atau tidak valid.");
  }

  if (!isValidJsOutput(output)) {
    // Fallback otomatis: mode ini menghasilkan kode rusak (biasanya gara-gara
    // identifierGenerator custom). Coba ulang sekali pakai konfig "standard"
    // (identifier default js-confuser, dijamin valid) daripada kirim file rusak.
    if (!_isRetry) return obfuscateJS(code, "standard", true);
    throw new Error(
      `Mode "${style}" menghasilkan kode dengan syntax error, dan fallback mode "standard" juga gagal. ` +
      `Kemungkinan ada masalah di source code aslinya — cek dulu sintaks file kamu.`
    );
  }

  return output;
}

const JS_MODES = [
  "standard", "strong", "ultra", "quantum", "timelocked", "nebula", "nexus",
  "siu", "mandarin", "arab", "japan", "japxab", "invis", "stealth", "big", "max", "custom",
];

// ─── HTML ENKRIPSI / DEKRIPSI ──────────────────────────────────────────────
function encryptBase64HTML(html) {
  const base64 = Buffer.from(html).toString("base64");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Protected</title>
</head>
<body>
  <script>
    (function() {
      var decoded = atob("${base64}");
      var container = document.createElement("div");
      container.innerHTML = decoded;
      document.body.appendChild(container);
      container.querySelectorAll("script").forEach(function(el) {
        var script = document.createElement("script");
        script.text = el.textContent;
        document.head.appendChild(script);
      });
    })()
  </script>
</body>
</html>`;
}

function obfuscateHTML(html) {
  const base64 = Buffer.from(html, "utf8").toString("base64");
  const hexEncoded = base64.split("").map(char =>
    `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`
  ).join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Protected</title>
</head>
<body>
  <script>
    !function() {
      var encoded = ['${hexEncoded}'];
      var decodedString = encoded[0].replace(/\\\\x([0-9a-f]{2})/gi, function(match, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      });
      var decodedBase64 = atob(decodedString);
      document.open();
      document.write(decodedBase64);
      document.close();
    }()
  </script>
</body>
</html>`;
}

function decryptBase64HTML(encrypted) {
  const match = encrypted.match(/atob\(["']([A-Za-z0-9+/=]+)["']\)/);
  if (match) {
    try { return Buffer.from(match[1], "base64").toString("utf8"); } catch {}
  }
  try {
    return Buffer.from(encrypted.trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
}

function decryptBase64JS(encrypted) {
  const match = encrypted.match(/atob\(["']([A-Za-z0-9+/=]+)["']\)/);
  if (match) {
    try {
      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      if (decoded.includes("\\u")) {
        return decoded.replace(/\\u([0-9a-f]{4})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
      }
      return decoded;
    } catch {}
  }
  try {
    return Buffer.from(encrypted.trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
}

module.exports = {
  isAvailable: !!JsConfuser,
  JS_MODES,
  obfuscateJS,
  encryptBase64HTML,
  obfuscateHTML,
  decryptBase64HTML,
  decryptBase64JS,
};
