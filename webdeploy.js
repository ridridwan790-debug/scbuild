const axios = require("axios");
const AdmZip = require("adm-zip");

// Modul ini butuh env: GITHUB_TOKEN, GITHUB_USERNAME, VERCEL_TOKEN, (opsional) VERCEL_TEAM_ID
// Semua diambil dari CONFIG yang di-pass saat init(), supaya tidak duplikat load env.

let GITHUB_TOKEN, GITHUB_USERNAME, VERCEL_TOKEN, VERCEL_TEAM_ID;
const GH_API = "https://api.github.com";

function init(config) {
  GITHUB_TOKEN = config.GITHUB_TOKEN;
  GITHUB_USERNAME = config.GITHUB_USERNAME;
  VERCEL_TOKEN = config.VERCEL_TOKEN;
  VERCEL_TEAM_ID = config.VERCEL_TEAM_ID || "";
}

function isConfigured() {
  return !!(GITHUB_TOKEN && GITHUB_USERNAME && VERCEL_TOKEN);
}

const ghHdr = () => ({
  Authorization: `token ${GITHUB_TOKEN}`,
  "Content-Type": "application/json",
  "User-Agent": "FlutterBuilder-Bot/1.0",
  Accept: "application/vnd.github.v3+json",
});

const vercelHeaders = () => ({
  Authorization: `Bearer ${VERCEL_TOKEN}`,
  "Content-Type": "application/json",
});

const vercelParams = (extra = {}) => VERCEL_TEAM_ID ? { teamId: VERCEL_TEAM_ID, ...extra } : { ...extra };

async function githubCreateRepo(name) {
  const response = await axios.post(
    `${GH_API}/user/repos`,
    { name, private: false, auto_init: true, description: "🚀 Deployed via Bot" },
    { headers: ghHdr() }
  );
  return response.data;
}

async function githubGetSha(repo, file) {
  try {
    const response = await axios.get(`${GH_API}/repos/${GITHUB_USERNAME}/${repo}/contents/${file}`, { headers: ghHdr() });
    return response.data.sha || null;
  } catch {
    return null;
  }
}

async function githubPush(repo, file, content) {
  const sha = await githubGetSha(repo, file);
  const body = { message: "🚀 Deploy via Bot", content: Buffer.from(content).toString("base64") };
  if (sha) body.sha = sha;
  await axios.put(`${GH_API}/repos/${GITHUB_USERNAME}/${repo}/contents/${file}`, body, { headers: ghHdr() });
}

// Push banyak file sekaligus pakai Git Trees API (jauh lebih cepat & hemat rate-limit
// dibanding githubPush satu-satu). files = [{ path: "index.html", content: Buffer|string, isBinary: bool }]
async function githubPushMultipleFiles(repo, files) {
  // 1. Ambil ref & commit SHA terkini dari branch main
  const refRes = await axios.get(`${GH_API}/repos/${GITHUB_USERNAME}/${repo}/git/ref/heads/main`, { headers: ghHdr() });
  const latestCommitSha = refRes.data.object.sha;

  const commitRes = await axios.get(`${GH_API}/repos/${GITHUB_USERNAME}/${repo}/git/commits/${latestCommitSha}`, { headers: ghHdr() });
  const baseTreeSha = commitRes.data.tree.sha;

  // 2. Upload setiap file sebagai blob, kumpulkan SHA-nya
  const treeItems = [];
  for (const f of files) {
    // f.content bisa Buffer (dari ZIP) atau string (dari HTML paste langsung) — keduanya
    // di-convert ke Buffer dulu sebelum base64, supaya konsisten untuk teks maupun binary.
    const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, "utf8");
    const contentBase64 = buf.toString("base64");

    const blobRes = await axios.post(
      `${GH_API}/repos/${GITHUB_USERNAME}/${repo}/git/blobs`,
      { content: contentBase64, encoding: "base64" },
      { headers: ghHdr() }
    );

    treeItems.push({
      path: f.path,
      mode: "100644",
      type: "blob",
      sha: blobRes.data.sha,
    });
  }

  // 3. Buat tree baru berdasarkan base tree + file-file baru
  const treeRes = await axios.post(
    `${GH_API}/repos/${GITHUB_USERNAME}/${repo}/git/trees`,
    { base_tree: baseTreeSha, tree: treeItems },
    { headers: ghHdr() }
  );

  // 4. Buat commit baru menunjuk ke tree itu
  const newCommitRes = await axios.post(
    `${GH_API}/repos/${GITHUB_USERNAME}/${repo}/git/commits`,
    { message: "🚀 Deploy via Bot (multi-file)", tree: treeRes.data.sha, parents: [latestCommitSha] },
    { headers: ghHdr() }
  );

  // 5. Update ref branch main ke commit baru
  await axios.patch(
    `${GH_API}/repos/${GITHUB_USERNAME}/${repo}/git/refs/heads/main`,
    { sha: newCommitRes.data.sha },
    { headers: ghHdr() }
  );
}

async function githubDeleteRepo(repo) {
  try {
    await axios.delete(`${GH_API}/repos/${GITHUB_USERNAME}/${repo}`, { headers: ghHdr() });
  } catch {}
}

async function vercelDeleteProject(name) {
  try {
    await axios.delete(`https://api.vercel.com/v9/projects/${name}`, { headers: vercelHeaders(), params: vercelParams() });
  } catch {}
}

async function vercelCreateProject(projectName, repoName) {
  await vercelDeleteProject(projectName);
  const response = await axios.post(
    "https://api.vercel.com/v10/projects",
    {
      name: projectName,
      gitRepository: { type: "github", repo: `${GITHUB_USERNAME}/${repoName}` },
      framework: null, buildCommand: null, outputDirectory: null, installCommand: null,
    },
    { headers: vercelHeaders(), params: vercelParams() }
  );
  return response.data;
}

async function vercelDeploy(projectName, repoName) {
  const response = await axios.post(
    "https://api.vercel.com/v13/deployments",
    {
      name: projectName, target: "production",
      gitSource: { type: "github", org: GITHUB_USERNAME, repo: repoName, ref: "main" },
      projectSettings: { framework: null },
    },
    { headers: vercelHeaders(), params: vercelParams() }
  );
  return response.data;
}

async function vercelGetDeployment(id) {
  const response = await axios.get(`https://api.vercel.com/v13/deployments/${id}`, { headers: vercelHeaders(), params: vercelParams() });
  return response.data;
}

async function vercelGetProductionURL(projectName) {
  try {
    const response = await axios.get(`https://api.vercel.com/v9/projects/${projectName}`, { headers: vercelHeaders(), params: vercelParams() });
    const aliases = response.data?.targets?.production?.alias || [];
    if (aliases.length > 0) return `https://${aliases[0]}`;
  } catch {}
  return null;
}

async function vercelAddDomain(projectName, domain) {
  const response = await axios.post(
    `https://api.vercel.com/v10/projects/${projectName}/domains`,
    { name: domain },
    { headers: vercelHeaders(), params: vercelParams() }
  );
  return response.data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Ekstensi yang dianggap teks (dibaca sebagai utf8, bukan binary base64 mentah).
// Sisanya (png, jpg, ico, woff, dll) dianggap binary.
const TEXT_EXTENSIONS = [".html", ".htm", ".css", ".js", ".json", ".txt", ".md", ".svg", ".xml", ".webmanifest"];

function isTextFile(filePath) {
  const lower = filePath.toLowerCase();
  return TEXT_EXTENSIONS.some(ext => lower.endsWith(ext));
}

// Baca ZIP project web (html+css+js+images), normalisasi path (strip folder pembungkus
// kalau semua file ada di dalam 1 folder yang sama), dan filter file yang tidak relevan.
// Return: [{ path, content (Buffer), isBinary }]
function extractWebZip(zipPath) {
  let zip;
  try {
    zip = new AdmZip(zipPath);
  } catch (err) {
    throw new Error(
      `File ZIP tidak bisa dibaca (${err.message}). ` +
      `Kemungkinan file corrupt saat upload, atau format ZIP tidak didukung. ` +
      `Coba: 1) zip ulang project-nya, 2) pastikan tidak ada karakter aneh di nama file di dalam ZIP, 3) upload ulang.`
    );
  }

  let entries;
  try {
    entries = zip.getEntries().filter(e => !e.isDirectory);
  } catch (err) {
    throw new Error(`Gagal membaca isi ZIP (${err.message}). File ZIP mungkin rusak/tidak lengkap.`);
  }

  // Filter file yang tidak perlu di-deploy (metadata OS, folder git, dll)
  const skip = (name) => (
    name.includes("__MACOSX") ||
    name.endsWith(".DS_Store") ||
    name.startsWith(".git/") ||
    name.includes("/.git/") ||
    name === ".gitignore"
  );

  const usableEntries = entries.filter(e => !skip(e.entryName));
  if (usableEntries.length === 0) {
    throw new Error("ZIP kosong atau tidak ada file yang bisa di-deploy.");
  }

  // Deteksi folder pembungkus tunggal untuk di-strip
  const topLevelDirs = new Set(usableEntries.map(e => e.entryName.split("/")[0]));
  let stripPrefix = null;
  if (topLevelDirs.size === 1) {
    const candidate = [...topLevelDirs][0];
    const allNested = usableEntries.every(e => e.entryName.startsWith(candidate + "/"));
    if (allNested && candidate) stripPrefix = candidate + "/";
  }

  return usableEntries.map(e => {
    const normalizedPath = stripPrefix ? e.entryName.slice(stripPrefix.length) : e.entryName;
    const binary = !isTextFile(normalizedPath);
    return {
      path: normalizedPath,
      content: e.getData(), // selalu Buffer; githubPushMultipleFiles akan handle text vs binary
      isBinary: binary,
    };
  });
}

async function vercelWaitForDeployment(deploymentId, onProgress, timeout = 180000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const deployment = await vercelGetDeployment(deploymentId);
    const state = deployment.readyState || deployment.state || "";
    const elapsed = Math.round((Date.now() - start) / 1000);

    if (state === "READY") return deployment;
    if (["ERROR", "CANCELED", "FAILED"].includes(state)) {
      throw new Error(`Deployment ${state}`);
    }

    if (typeof onProgress === "function") {
      await onProgress({ state, elapsed, deploymentId });
    }
    await sleep(6000);
  }

  throw new Error("Timeout — deployment lebih dari 3 menit");
}

// Extract pesan error yang lebih informatif dari axios error object
function extractApiError(err, stepLabel) {
  const data = err.response?.data;
  const status = err.response?.status ? ` (HTTP ${err.response.status})` : "";

  // GitHub API: { message: "...", errors: [{ resource, field, code, message }] }
  // Vercel API: { error: { message: "...", code: "..." } }
  let apiMsg = data?.error?.message || data?.message;

  let detailParts = [];
  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    detailParts = data.errors.map(e => {
      const parts = [e.field, e.code, e.message].filter(Boolean);
      return parts.join(": ");
    });
  }

  if (!apiMsg) {
    apiMsg = typeof data === "string" ? data : err.message;
  }

  const detailText = detailParts.length > 0 ? `\n→ ${detailParts.join("\n→ ")}` : "";
  const wrapped = new Error(`[${stepLabel}]${status} ${apiMsg}${detailText}`);
  wrapped.original = err;
  wrapped.step = stepLabel;
  return wrapped;
}

// ─── FULL PIPELINE ──────────────────────────────────────────────────────────
// Deploy 1 file HTML (index.html) ke Vercel via GitHub repo baru.
// onProgress(step, total, title, detail) dipanggil di setiap tahap.
async function deployHTML(html, projectName, domainName, onProgress) {
  const baseName = projectName || ("site" + Date.now().toString().slice(-4));
  const repoName = baseName;
  const projName = baseName;
  let repoCreated = false;

  const notify = async (step, total, title, detail) => {
    if (typeof onProgress === "function") await onProgress(step, total, title, detail);
  };

  try {
    await notify(1, 5, "Membuat GitHub Repo", `Repo: ${repoName}`);
    try {
      await githubCreateRepo(repoName);
    } catch (err) {
      throw extractApiError(err, "GitHub Create Repo");
    }
    repoCreated = true;
    await sleep(2000);

    await notify(2, 5, "Push File ke GitHub", "File: index.html");
    try {
      await githubPush(repoName, "index.html", html);
    } catch (err) {
      throw extractApiError(err, "GitHub Push File");
    }
    await sleep(1500);

    await notify(3, 5, "Membuat Vercel Project", `Project: ${projName}`);
    try {
      await vercelCreateProject(projName, repoName);
    } catch (err) {
      throw extractApiError(err, "Vercel Create Project");
    }
    await sleep(2000);

    await notify(4, 5, "Trigger Deployment", "Target: production");
    let deployment;
    try {
      deployment = await vercelDeploy(projName, repoName);
    } catch (err) {
      throw extractApiError(err, "Vercel Trigger Deploy");
    }
    const deploymentId = deployment.id || deployment.uid;
    if (!deploymentId) throw new Error("[Vercel Trigger Deploy] Deploy ID tidak ditemukan di response");

    const readyDeployment = await vercelWaitForDeployment(deploymentId, async ({ state, elapsed }) => {
      await notify(4, 5, "Building...", `Status: ${state} | ${elapsed}s`);
    });

    await notify(5, 5, "Mengambil URL Production", "");
    await sleep(1000);

    let siteUrl = await vercelGetProductionURL(projName);
    if (!siteUrl) {
      const aliases = readyDeployment.alias || readyDeployment.aliases || [];
      const cleanAlias = aliases.find(alias => !alias.match(/[a-f0-9]{8,}-[a-f0-9]{6,}/));
      siteUrl = cleanAlias ? `https://${cleanAlias}` : `https://${readyDeployment.url}`;
    }

    let domainError = null;
    if (domainName) {
      try {
        await vercelAddDomain(projName, domainName);
      } catch (err) {
        domainError = err.response?.data?.error?.message || err.message;
      }
    }

    return { siteUrl, repoName, projName, domainName: domainName || null, domainError };
  } catch (err) {
    if (repoCreated) {
      await githubDeleteRepo(repoName).catch(() => {});
      await vercelDeleteProject(projName).catch(() => {});
    }
    throw err;
  }
}

// Deploy banyak file sekaligus (dari ZIP project web: html+css+js+images).
// files = [{ path: "index.html", content: Buffer|string, isBinary: bool }]
// Wajib ada salah satu file "index.html" di root (setelah normalisasi path).
async function deployFiles(files, projectName, domainName, onProgress) {
  const baseName = projectName || ("site" + Date.now().toString().slice(-4));
  const repoName = baseName;
  const projName = baseName;
  let repoCreated = false;

  const notify = async (step, total, title, detail) => {
    if (typeof onProgress === "function") await onProgress(step, total, title, detail);
  };

  const hasIndexHtml = files.some(f => f.path.toLowerCase() === "index.html");
  if (!hasIndexHtml) {
    throw new Error("Tidak ditemukan index.html di root project. Pastikan ada file index.html.");
  }

  try {
    await notify(1, 5, "Membuat GitHub Repo", `Repo: ${repoName}`);
    try {
      await githubCreateRepo(repoName);
    } catch (err) {
      throw extractApiError(err, "GitHub Create Repo");
    }
    repoCreated = true;
    await sleep(2000);

    await notify(2, 5, "Push File ke GitHub", `${files.length} file`);
    try {
      await githubPushMultipleFiles(repoName, files);
    } catch (err) {
      throw extractApiError(err, "GitHub Push Multi-File");
    }
    await sleep(1500);

    await notify(3, 5, "Membuat Vercel Project", `Project: ${projName}`);
    try {
      await vercelCreateProject(projName, repoName);
    } catch (err) {
      throw extractApiError(err, "Vercel Create Project");
    }
    await sleep(2000);

    await notify(4, 5, "Trigger Deployment", "Target: production");
    let deployment;
    try {
      deployment = await vercelDeploy(projName, repoName);
    } catch (err) {
      throw extractApiError(err, "Vercel Trigger Deploy");
    }
    const deploymentId = deployment.id || deployment.uid;
    if (!deploymentId) throw new Error("[Vercel Trigger Deploy] Deploy ID tidak ditemukan di response");

    const readyDeployment = await vercelWaitForDeployment(deploymentId, async ({ state, elapsed }) => {
      await notify(4, 5, "Building...", `Status: ${state} | ${elapsed}s`);
    });

    await notify(5, 5, "Mengambil URL Production", "");
    await sleep(1000);

    let siteUrl = await vercelGetProductionURL(projName);
    if (!siteUrl) {
      const aliases = readyDeployment.alias || readyDeployment.aliases || [];
      const cleanAlias = aliases.find(alias => !alias.match(/[a-f0-9]{8,}-[a-f0-9]{6,}/));
      siteUrl = cleanAlias ? `https://${cleanAlias}` : `https://${readyDeployment.url}`;
    }

    let domainError = null;
    if (domainName) {
      try {
        await vercelAddDomain(projName, domainName);
      } catch (err) {
        domainError = err.response?.data?.error?.message || err.message;
      }
    }

    return { siteUrl, repoName, projName, domainName: domainName || null, domainError, fileCount: files.length };
  } catch (err) {
    if (repoCreated) {
      await githubDeleteRepo(repoName).catch(() => {});
      await vercelDeleteProject(projName).catch(() => {});
    }
    throw err;
  }
}

module.exports = {
  init,
  isConfigured,
  deployHTML,
  deployFiles,
  extractWebZip,
  githubCreateRepo,
  githubPush,
  githubPushMultipleFiles,
  githubDeleteRepo,
  vercelCreateProject,
  vercelDeleteProject,
  vercelDeploy,
  vercelGetDeployment,
  vercelGetProductionURL,
  vercelAddDomain,
  vercelWaitForDeployment,
};
