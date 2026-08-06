/**
 * Webhook handler: GitHub Actions desktop-release.yml 通知服务器同步产物。
 *
 * 工作流: CI 发布 GitHub Release → POST /api/webhook/desktop-sync → 下载所有 zip + manifest.json
 *         到 mobius/desktop-builds/ → 网页下载菜单立即可用。
 *
 * 鉴权: X-Webhook-Token header 必须匹配 DESKTOP_WEBHOOK_TOKEN 环境变量 (或 fallback 文件)。
 * 幂等: 已下载且 size 一致的文件跳过; manifest.json 每次覆盖。
 * 超时: 整体 120s (3 个 ~150MB zip 约需 60-90s GitHub + 网络)。
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");

const DESKTOP_BUILDS_DIR = path.join(__dirname, "..", "..", "desktop-builds");
const GITHUB_API = "https://api.github.com";

/**
 * 读取 webhook token: DESKTOP_WEBHOOK_TOKEN 环境变量 > desktop_builds_webhook_token 文件
 * (与后端其他配置一致的兜底策略)。
 */
function getWebhookToken() {
  if (process.env.DESKTOP_WEBHOOK_TOKEN) return process.env.DESKTOP_WEBHOOK_TOKEN;
  const tokenFile = path.join(__dirname, "..", "..", "ext_data_dir", "desktop_webhook_token");
  try {
    return fs.readFileSync(tokenFile, "utf-8").trim();
  } catch (_) {
    return null;
  }
}

/**
 * 从 GitHub Release 下载文件 (支持自动跟随重定向)。
 */
function downloadFile(url, destPath, expectedSize) {
  return new Promise((resolve, reject) => {
    // 幂等: 本地文件已存在且 size 匹配则跳过
    try {
      const st = fs.statSync(destPath);
      if (st.size === expectedSize) {
        console.log(`  SKIP ${path.basename(destPath)} (size match)`);
        return resolve({ skipped: true, size: st.size });
      }
    } catch (_) { /* 文件不存在, 继续下载 */ }

    const file = fs.createWriteStream(destPath);
    const timeout = setTimeout(() => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(new Error(`Download timeout: ${url}`));
    }, 120000);

    https.get(url, { headers: { "User-Agent": "Mobius-Desktop-Webhook/1.0" } }, (res) => {
      // 跟随重定向 (S3 / Release asset URL)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        clearTimeout(timeout);
        return downloadFile(res.headers.location, destPath, expectedSize).then(resolve, reject);
      }

      if (res.statusCode !== 200) {
        file.close();
        clearTimeout(timeout);
        fs.unlink(destPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      }

      res.pipe(file);
      file.on("finish", () => {
        clearTimeout(timeout);
        file.close();
        console.log(`  DOWNLOADED ${path.basename(destPath)} (${(file.bytesWritten / 1024 / 1024).toFixed(1)} MB)`);
        resolve({ skipped: false, size: file.bytesWritten });
      });

      file.on("error", (err) => {
        clearTimeout(timeout);
        file.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }).on("error", (err) => {
      clearTimeout(timeout);
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * 调用 GitHub REST API 获取最新 Release (非 draft, 非 prerelease) 的 asset 列表。
 * token 可选 (避免 rate limit); 不用 token 也能读 public repo release。
 */
function fetchLatestRelease(token) {
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": "Mobius-Desktop-Webhook/1.0", "Accept": "application/vnd.github+json" };
    if (token) headers["Authorization"] = `token ${token}`;

    // 直接用 /releases/latest (GitHub 官方 API)
    const url = `${GITHUB_API}/repos/nutshellai-tech/mobius/releases/latest`;
    https.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        let body = "";
        res.on("data", (d) => body += d);
        res.on("end", () => reject(new Error(`GitHub API returned ${res.statusCode}: ${body}`)));
        return;
      }
      let body = "";
      res.on("data", (d) => body += d);
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Failed to parse GitHub API response: ${e.message}`));
        }
      });
    }).on("error", reject);
  });
}

/**
 * Express 路由 handler。
 */
async function handleDesktopSync(req, res) {
  const startTime = Date.now();

  // 1. 鉴权
  const expectedToken = getWebhookToken();
  if (!expectedToken) {
    console.error("[desktop-webhook] DESKTOP_WEBHOOK_TOKEN 未配置");
    return res.status(500).json({ error: "Webhook token not configured on server" });
  }

  const providedToken = req.headers["x-webhook-token"] || "";
  if (!providedToken || providedToken !== expectedToken) {
    console.warn(`[desktop-webhook] Token mismatch from ${req.ip}`);
    return res.status(403).json({ error: "Invalid webhook token" });
  }

  const version = req.body?.version || req.headers["x-desktop-version"] || "unknown";
  console.log(`[desktop-webhook] Sync requested for version ${version}`);

  // 2. 获取 GitHub token (可选, public repo 不给也能读 release)
  const ghToken = process.env.GITHUB_TOKEN_DESKTOP || process.env.GITHUB_TOKEN || null;

  try {
    // 3. 获取最新 Release 的 asset 列表
    const release = await fetchLatestRelease(ghToken);
    const assets = release.assets || [];
    console.log(`[desktop-webhook] Latest release: ${release.tag_name}, ${assets.length} assets`);

    if (assets.length === 0) {
      return res.status(404).json({ error: "No assets found in latest release" });
    }

    // 4. 下载 manifest.json
    const manifestAsset = assets.find(a => a.name === "manifest.json");
    if (!manifestAsset) {
      console.error("[desktop-webhook] manifest.json not found in release assets");
      return res.status(404).json({ error: "manifest.json not found in release" });
    }

    // 5. 确保目标目录存在
    fs.mkdirSync(DESKTOP_BUILDS_DIR, { recursive: true });

    // 6. 下载 manifest.json (每次覆盖)
    const manifestPath = path.join(DESKTOP_BUILDS_DIR, "manifest.json");
    await downloadFile(manifestAsset.browser_download_url, manifestPath, manifestAsset.size);

    // 7. 下载所有 zip 产物 (非 manifest)
    const zipAssets = assets.filter(a => a.name.endsWith(".zip") && a.name !== "manifest.json");
    console.log(`[desktop-webhook] Downloading ${zipAssets.length} zip artifacts...`);

    const results = [];
    for (const asset of zipAssets) {
      const destPath = path.join(DESKTOP_BUILDS_DIR, asset.name);
      try {
        const r = await downloadFile(asset.browser_download_url, destPath, asset.size);
        results.push({ file: asset.name, ...r });
      } catch (err) {
        console.error(`[desktop-webhook] Failed to download ${asset.name}: ${err.message}`);
        results.push({ file: asset.name, error: err.message });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const downloaded = results.filter(r => !r.error && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => r.error).length;

    console.log(`[desktop-webhook] Done in ${elapsed}s: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);

    res.json({
      ok: true,
      version,
      tag: release.tag_name,
      elapsed: `${elapsed}s`,
      summary: `${downloaded} downloaded, ${skipped} skipped, ${failed} failed`,
      files: results,
    });
  } catch (err) {
    console.error(`[desktop-webhook] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Express Router — 挂载到 /api/webhook/desktop-sync。
 */
const router = require("express").Router();
router.post("/desktop-sync", handleDesktopSync);

module.exports = { router };
