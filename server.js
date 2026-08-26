// ─── SERVER.JS — GITHUB ACTIONS BUILD ENGINE ────────────────────────────────
// File ini MENGGANTIKAN TOTAL server.js lama (yang obfuscated/tidak terbaca).
// Build APK sepenuhnya lewat GitHub Actions (GitHub-only worker, tanpa VPS),
// diadaptasi dari pola worker/githubWorker.js project WEB2APK_GEN_2 /
// ziperbuild, memakai kontrak dispatch yang SAMA PERSIS dengan workflow
// .github/workflows/build-flutter.yml & build-android.yml (inputs: jobId,
// userId, payload -- payload.url dibaca oleh workflow untuk download+unzip
// source project, artifact hasil build dinamai apk-${jobId}).
//
// Mendukung BANYAK worker GitHub (multi repo/token) dengan pemilihan
// round-robin, supaya beban build tersebar & tidak kena rate-limit satu
// repo saja. Kelola lewat command /addworkergithub, /listworkergithub,
// /removeworkergithub di bot (owner-only).
//
// Setiap "worker" = { id, label, repo (owner/repo), token,
//                      workflows: { flutter, android }, enabled, addedBy, addedAt }

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const WORKERS_PATH = path.join(__dirname, "githubworkers.json");

function ensureJson(p, def) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def, null, 2));
}
ensureJson(WORKERS_PATH, []);

// ─── WORKER CRUD ──────────────────────────────────────────────────────────
function listWorkers() {
  try { return JSON.parse(fs.readFileSync(WORKERS_PATH, "utf-8")); } catch { return []; }
}
function saveWorkers(list) {
  fs.writeFileSync(WORKERS_PATH, JSON.stringify(list, null, 2));
}
function getWorker(id) {
  return listWorkers().find(w => w.id === id) || null;
}
function addWorker({ label, repo, token, workflowFlutter, workflowAndroid, addedBy }) {
  const list = listWorkers();
  const id = "gh-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const worker = {
    id,
    label: label || repo,
    repo,   // format: "owner/repo"
    token,
    workflows: {
      flutter: workflowFlutter || "build-flutter.yml",
      android: workflowAndroid || workflowFlutter || "build-flutter.yml",
    },
    enabled: true,
    addedBy: Number(addedBy),
    addedAt: new Date().toISOString(),
  };
  list.push(worker);
  saveWorkers(list);
  return worker;
}
function removeWorker(id) {
  const list = listWorkers();
  const filtered = list.filter(w => w.id !== id);
  if (filtered.length === list.length) return false;
  saveWorkers(filtered);
  return true;
}
function setWorkerEnabled(id, enabled) {
  const list = listWorkers();
  const w = list.find(x => x.id === id);
  if (!w) return false;
  w.enabled = !!enabled;
  saveWorkers(list);
  return true;
}

// ─── ROUND ROBIN SELECTION ──────────────────────────────────────────────────
let _cursor = 0;
function pickWorkerRoundRobin() {
  const candidates = listWorkers().filter(w => w.enabled !== false);
  if (candidates.length === 0) return null;
  const idx = _cursor % candidates.length;
  _cursor = (idx + 1) % candidates.length;
  return candidates[idx];
}

function authHeaders(worker) {
  return {
    "Authorization": `Bearer ${worker.token}`,
    "Accept": "application/vnd.github.v3+json",
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── RELEASE / ASSET UPLOAD (dipakai untuk kirim ZIP source ke GitHub) ──────

const _defaultBranchCache = new Map();

async function getDefaultBranch(worker) {
  if (_defaultBranchCache.has(worker.repo)) return _defaultBranchCache.get(worker.repo);
  try {
    const res = await axios.get(`https://api.github.com/repos/${worker.repo}`, { headers: authHeaders(worker) });
    const branch = res.data.default_branch || "main";
    _defaultBranchCache.set(worker.repo, branch);
    return branch;
  } catch (_) {
    return "main";
  }
}

async function getLatestCommitSha(worker) {
  const branch = await getDefaultBranch(worker);
  const res = await axios.get(
    `https://api.github.com/repos/${worker.repo}/git/ref/heads/${branch}`,
    { headers: authHeaders(worker) }
  );
  return res.data.object.sha;
}

// Upload file ZIP project sebagai release asset sementara.
// Return { releaseId, browserUrl } — browserUrl dipakai workflow untuk download source.
async function uploadZipToRelease(worker, localZipPath, fileName, tag) {
  const headers = authHeaders(worker);

  try {
    const sha = await getLatestCommitSha(worker);
    await axios.post(`https://api.github.com/repos/${worker.repo}/git/refs`, {
      ref: `refs/tags/${tag}`,
      sha,
    }, { headers }).catch(() => {}); // tag mungkin sudah ada, lanjut saja
  } catch (_) {}

  const releaseRes = await axios.post(
    `https://api.github.com/repos/${worker.repo}/releases`,
    {
      tag_name: tag,
      name: `Build Source ${tag}`,
      body: `Temporary release untuk build ${tag}. Akan dihapus otomatis setelah build selesai.`,
      draft: false,
      prerelease: true,
    },
    { headers }
  );

  const releaseId = releaseRes.data.id;
  const uploadUrl = releaseRes.data.upload_url.replace("{?name,label}", `?name=${encodeURIComponent(fileName || "project.zip")}`);
  const fileData = fs.readFileSync(localZipPath);

  const assetRes = await axios.post(uploadUrl, fileData, {
    headers: { ...headers, "Content-Type": "application/zip" },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 300000,
  });

  return { releaseId, browserUrl: assetRes.data.browser_download_url };
}

// Buat release kosong (tanpa asset) — dipakai untuk upload icon Web2APK.
// Return { releaseId, uploadUrl }
async function createReleaseOnly(worker, tag) {
  const headers = authHeaders(worker);
  const releaseRes = await axios.post(
    `https://api.github.com/repos/${worker.repo}/releases`,
    {
      tag_name: tag,
      name: `Asset ${tag}`,
      body: `Temporary release untuk asset ${tag}.`,
      draft: false,
      prerelease: true,
    },
    { headers }
  );
  return {
    releaseId: releaseRes.data.id,
    uploadUrl: releaseRes.data.upload_url,
  };
}

// Upload satu file ke release yang sudah dibuat lewat createReleaseOnly.
async function uploadAssetFile(worker, uploadUrl, filePath, assetName, contentType) {
  const cleanUploadUrl = uploadUrl.replace("{?name,label}", `?name=${encodeURIComponent(assetName)}`);
  const fileData = fs.readFileSync(filePath);
  await axios.post(cleanUploadUrl, fileData, {
    headers: { ...authHeaders(worker), "Content-Type": contentType || "application/octet-stream" },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 300000,
  });
}

// "Publish" — di sini cukup ambil browser_download_url dari asset yang baru diupload
// (release sudah dibuat non-draft dari awal, jadi otomatis publik).
async function publishRelease(worker, releaseId) {
  const res = await axios.get(
    `https://api.github.com/repos/${worker.repo}/releases/${releaseId}`,
    { headers: authHeaders(worker) }
  );
  const asset = (res.data.assets || [])[0];
  return asset ? asset.browser_download_url : null;
}

async function deleteRelease(worker, releaseId) {
  if (!releaseId) return;
  const headers = authHeaders(worker);
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${worker.repo}/releases/${releaseId}`,
      { headers }
    );
    const tag = res.data.tag_name;
    await axios.delete(`https://api.github.com/repos/${worker.repo}/releases/${releaseId}`, { headers }).catch(() => {});
    if (tag) {
      await axios.delete(`https://api.github.com/repos/${worker.repo}/git/refs/tags/${tag}`, { headers }).catch(() => {});
    }
  } catch (_) {
    // release mungkin sudah tidak ada, abaikan
  }
}

// ─── WORKFLOW DISPATCH & POLLING ────────────────────────────────────────────
// PENTING: kontrak input dispatch ini SENGAJA disamakan persis dengan
// project WEB2APK_GEN_2 (worker/githubWorker.js) — inputs: { jobId, userId, payload }
// — supaya repo & file workflow (.yml) GitHub Actions yang sudah kamu pakai di
// WEB2APK_GEN_2 bisa langsung dipakai ulang di sini tanpa bikin workflow baru.
// Workflow di GitHub diasumsikan mem-parse `payload` (JSON string) dan
// menamai artifact hasil build sebagai `apk-${jobId}`.

// Cari run terbaru yang baru saja di-dispatch (dalam window 2 menit terakhir).
async function findWorkflowRun(worker, workflowFile, maxRetries = 8) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await axios.get(
        `https://api.github.com/repos/${worker.repo}/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&per_page=5`,
        { headers: authHeaders(worker) }
      );
      const runs = res.data.workflow_runs || [];
      const now = Date.now();
      for (const run of runs) {
        const createdAt = new Date(run.created_at).getTime();
        if (now - createdAt < 120000) {
          return run.id;
        }
      }
    } catch (_) {}
    await sleep(4000);
  }
  return null;
}

// Trigger build dari ZIP source (browserUrl = link download ZIP dari release).
// jobId dipakai sebagai `tag` (juga jadi jobId unik untuk matching artifact).
// Return runId.
async function triggerWorkflow(worker, browserUrl, tag, buildType) {
  const workflowFile = worker.workflows?.flutter || "build-flutter.yml";
  const jobId = String(tag);
  const branch = await getDefaultBranch(worker);

  await axios.post(
    `https://api.github.com/repos/${worker.repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      ref: branch,
      inputs: {
        jobId,
        userId: "0", // bot ini tidak selalu punya userId numerik terpisah dari job; jobId sudah unik
        payload: JSON.stringify({
          mode: "zip",
          url: browserUrl,
          buildType: buildType || "release",
          tag,
        }),
      },
    },
    { headers: authHeaders(worker), timeout: 30000 }
  );

  await sleep(5000);
  const runId = await findWorkflowRun(worker, workflowFile);
  if (!runId) throw new Error("Gagal menemukan workflow run di GitHub Actions setelah dispatch.");
  return runId;
}

// Trigger build Web2APK (URL + nama app + icon). Return runId.
async function triggerWeb2ApkWorkflow(worker, webUrl, appName, iconUrl) {
  const workflowFile = worker.workflows?.flutter || "build-flutter.yml";
  const jobId = "w2a-" + Date.now();
  const branch = await getDefaultBranch(worker);

  await axios.post(
    `https://api.github.com/repos/${worker.repo}/actions/workflows/${workflowFile}/dispatches`,
    {
      ref: branch,
      inputs: {
        jobId,
        userId: "0",
        payload: JSON.stringify({
          mode: "url",
          url: webUrl,
          appName,
          iconUrl: iconUrl || "",
        }),
      },
    },
    { headers: authHeaders(worker), timeout: 30000 }
  );

  await sleep(5000);
  const runId = await findWorkflowRun(worker, workflowFile);
  if (!runId) throw new Error("Gagal menemukan workflow run di GitHub Actions setelah dispatch.");
  return runId;
}

// Ambil status run terkini. Return { status, conclusion, durationSec }.
async function getRunStatus(worker, runId) {
  const res = await axios.get(
    `https://api.github.com/repos/${worker.repo}/actions/runs/${runId}`,
    { headers: authHeaders(worker) }
  );
  const run = res.data;
  let durationSec = 0;
  if (run.run_started_at) {
    const start = new Date(run.run_started_at).getTime();
    const end = run.updated_at ? new Date(run.updated_at).getTime() : Date.now();
    durationSec = Math.max(0, Math.round((end - start) / 1000));
  }
  return { status: run.status, conclusion: run.conclusion, durationSec };
}

// Ambil daftar artifact dari sebuah run. Return [{ id, name }]
async function getArtifacts(worker, runId) {
  const res = await axios.get(
    `https://api.github.com/repos/${worker.repo}/actions/runs/${runId}/artifacts`,
    { headers: authHeaders(worker) }
  );
  return (res.data.artifacts || []).map(a => ({ id: a.id, name: a.name }));
}

// Download artifact (berupa .zip berisi APK) ke path lokal.
async function downloadArtifactZip(worker, artifactId, destPath) {
  const res = await axios.get(
    `https://api.github.com/repos/${worker.repo}/actions/artifacts/${artifactId}/zip`,
    {
      headers: authHeaders(worker),
      responseType: "arraybuffer",
      maxContentLength: 500 * 1024 * 1024,
      timeout: 300000,
    }
  );
  fs.writeFileSync(destPath, res.data);
}

// Ambil log ASLI (bukan cuma nama step) dari step yang gagal di sebuah run.
// Return { stepName, errorLines } — errorLines berisi baris-baris log mentah
// (compiler/gradle/flutter error beneran), dipakai index.js buat dikirim ke user.
async function getFailedStepLog(worker, runId) {
  const headers = authHeaders(worker);
  let failedJob = null;

  try {
    const res = await axios.get(
      `https://api.github.com/repos/${worker.repo}/actions/runs/${runId}/jobs`,
      { headers }
    );
    const jobs = res.data.jobs || [];
    failedJob = jobs.find(j => j.conclusion === "failure");
  } catch (_) {
    return null;
  }

  if (!failedJob) return null;

  const failedStep = failedJob.steps?.find(s => s.conclusion === "failure");
  const stepName = failedStep?.name || failedJob.name;

  try {
    const logRes = await axios.get(
      `https://api.github.com/repos/${worker.repo}/actions/jobs/${failedJob.id}/logs`,
      {
        headers,
        responseType: "text",
        transformResponse: [(d) => d], // jangan di-JSON.parse, ini teks mentah
        timeout: 30000,
      }
    );

    const rawLines = String(logRes.data || "")
      .split("\n")
      .map(line => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "")) // buang timestamp GitHub
      .filter(Boolean);

    // Ambil baris-baris terakhir — di situ biasanya letak error compiler/gradle/flutter beneran.
    const errorLines = rawLines.slice(-60);
    return { stepName, errorLines };
  } catch (_) {
    // Gagal ambil log mentah, minimal masih kasih tau nama step yang gagal.
    return { stepName, errorLines: [] };
  }
}

module.exports = {
  // CRUD & selection
  listWorkers, addWorker, removeWorker, getWorker, setWorkerEnabled, pickWorkerRoundRobin,
  // GitHub Actions API
  uploadZipToRelease, deleteRelease, triggerWorkflow, getRunStatus,
  getArtifacts, downloadArtifactZip, getFailedStepLog, sleep,
  createReleaseOnly, uploadAssetFile, triggerWeb2ApkWorkflow, publishRelease,
};
