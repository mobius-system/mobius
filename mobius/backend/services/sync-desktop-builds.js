/**
 * 桌面客户端产物同步服务 (多服务器友好)。
 *
 * 每台服务器独立从 GitHub Release 拉取最新 zip + manifest.json 到 mobius/desktop-builds/。
 * 被三种方式调用:
 *   1. cron 定时:  server.js 启动后每 30 分钟自动跑一次
 *   2. webhook:   POST /api/webhook/desktop-sync (CI 发版后立即触发, 加速同步)
 *   3. CLI 手动:   node tools/sync-desktop-builds.js
 *
 * 幂等: 本地文件 size 与 GitHub Release asset 一致则跳过; manifest.json 每次覆盖。
 * 多服务器: 每台独立运行, 无需互相知道对方, 各自从同一个 GitHub Release 拉取即可。
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const DESKTOP_BUILDS_DIR = path.join(__dirname, "..", "..", "desktop-builds");
const MOBILE_BUILDS_DIR = path.join(__dirname, "..", "..", "mobile-builds");
const GITHUB_API = "https://api.github.com";
const REPO = "mobius-system/mobius";
// 移动端 Release 源仓库可配(默认与桌面端同仓; App 仓库独立时设
// MOBIUS_MOBILE_SYNC_REPO=owner/repo, 例如 Louis-ZhangLe/momo-mobile):
const MOBILE_REPO = process.env.MOBIUS_MOBILE_SYNC_REPO || REPO;

/**
 * 下载单个文件 (支持自动跟随重定向, 幂等: size 一致跳过).
 */
function downloadFile(url, destPath, expectedSize, token) {
  return new Promise((resolve, reject) => {
    // 幂等检查
    try {
      const st = fs.statSync(destPath);
      if (st.size === expectedSize) {
        return resolve({ skipped: true, file: path.basename(destPath), size: st.size });
      }
    } catch (_) { /* 文件不存在, 继续 */ }

    const file = fs.createWriteStream(destPath);
    const timeout = setTimeout(() => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(new Error("Download timeout"));
    }, 180000);

    const headers = { "User-Agent": "Mobius-Desktop-Sync/1.0" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      // api.github.com 资产端点需 octet-stream 才返回文件本体(否则返回资产元数据 JSON)
      if (url.startsWith("https://api.github.com/")) headers["Accept"] = "application/octet-stream";
    }
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        clearTimeout(timeout);
        return downloadFile(res.headers.location, destPath, expectedSize).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        clearTimeout(timeout);
        fs.unlink(destPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on("finish", () => {
        clearTimeout(timeout);
        file.close();
        resolve({ skipped: false, file: path.basename(destPath), size: file.bytesWritten });
      });
      file.on("error", (err) => { clearTimeout(timeout); file.close(); fs.unlink(destPath, () => {}); reject(err); });
    }).on("error", (err) => { clearTimeout(timeout); file.close(); fs.unlink(destPath, () => {}); reject(err); });
  });
}

/**
 * 调用 GitHub REST API 获取最新非 draft Release 的 asset 列表。
 * token 可选 (public repo 不需要; 配了可提高 rate limit: 60→5000 req/h)。
 */
function fetchLatestRelease(token) {
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": "Mobius-Desktop-Sync/1.0", "Accept": "application/vnd.github+json" };
    if (token) headers["Authorization"] = `token ${token}`;

    const url = `${GITHUB_API}/repos/${REPO}/releases/latest`;
    https.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        let body = "";
        res.on("data", (d) => body += d);
        res.on("end", () => reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`)));
        return;
      }
      let body = "";
      res.on("data", (d) => body += d);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
      });
    }).on("error", reject);
  });
}

/**
 * 核心同步逻辑: 从 GitHub Release 拉取所有桌面端产物 + manifest.json。
 * 返回 { ok, tag, version, downloaded, skipped, failed, elapsed, files[] }。
 */
async function syncDesktopBuilds(options = {}) {
  const {
    token: ghToken = process.env.GITHUB_TOKEN_DESKTOP || process.env.GITHUB_TOKEN || null,
    log = console.log,
  } = options;

  const startTime = Date.now();
  log(`[desktop-sync] Checking latest release from ${REPO}...`);

  // 1. 获取最新 desktop Release (tag 前缀 desktop-v; 不能用 releases/latest —
  //    mobile-v 等 Release 会抢占全局 latest 位置导致桌面端拉错资产)
  const release = await fetchLatestReleaseByTagPrefix("desktop-v", ghToken);
  const assets = release.assets || [];
  log(`[desktop-sync] Latest: ${release.tag_name}, ${assets.length} assets`);

  if (assets.length === 0) {
    return { ok: false, error: "No assets in release", tag: release.tag_name };
  }

  // 2. 确保目录存在
  fs.mkdirSync(DESKTOP_BUILDS_DIR, { recursive: true });

  const results = [];

  // 3. 下载所有资产 (manifest.json 每次覆盖; zip 按 size 幂等)
  for (const asset of assets) {
    const destPath = path.join(DESKTOP_BUILDS_DIR, asset.name);
    try {
      // 私有仓库: browser_download_url(CDN通道)对 PAT 常404, 用 asset.url(api端点+octet-stream)稳定
      const assetUrl = ghToken ? (asset.url || asset.browser_download_url) : asset.browser_download_url;
      const r = await downloadFile(assetUrl, destPath, asset.size, ghToken);
      results.push({ ...r });
      if (!r.skipped) {
        log(`[desktop-sync]   ↓ ${r.file} (${(r.size / 1024 / 1024).toFixed(1)} MB)`);
      }
    } catch (err) {
      log(`[desktop-sync]   ✗ ${asset.name}: ${err.message}`);
      results.push({ file: asset.name, error: err.message });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const downloaded = results.filter(r => !r.error && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;
  const failed = results.filter(r => r.error).length;

  // 4. 清理旧版本文件 (不在当前 release 中的 zip, 保留 manifest.json)
  const currentZipNames = new Set(assets.map(a => a.name).filter(n => n.endsWith(".zip")));
  try {
    for (const entry of fs.readdirSync(DESKTOP_BUILDS_DIR)) {
      if (entry === "manifest.json") continue;
      if (entry.endsWith(".zip") && !currentZipNames.has(entry)) {
        const oldPath = path.join(DESKTOP_BUILDS_DIR, entry);
        fs.unlinkSync(oldPath);
        log(`[desktop-sync]   ✕ removed old: ${entry}`);
      }
    }
  } catch (_) { /* 清理失败不影响 */ }

  // 5. 若 Release 未包含 manifest.json (旧 CI), 则从本地 zip 重新生成
  const hasManifest = assets.some(a => a.name === "manifest.json");
  if (!hasManifest && downloaded > 0) {
    try {
      const version = (release.tag_name || "").replace("desktop-v", "");
      const builds = [];
      for (const name of currentZipNames) {
        const filePath = path.join(DESKTOP_BUILDS_DIR, name);
        try {
          const st = fs.statSync(filePath);
          const sha256 = require("crypto").createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
          // 从文件名解析: mobius-desktop-0.0.19-win-x64.zip
          const rest = name.replace(/^mobius-desktop-[^-]+-[^-]+-/, "").replace(".zip", ""); // mac-arm64
          const sep = rest.lastIndexOf("-");
          const platform = sep > 0 ? rest.slice(0, sep) : rest;
          const arch = sep > 0 ? rest.slice(sep + 1) : "x64";
          const format = name.endsWith(".dmg") ? "dmg" : "zip";
          builds.push({ platform, arch, format, file: name, size: st.size, sha256 });
        } catch (_) { /* skip */ }
      }
      if (builds.length > 0) {
        const manifest = {
          version,
          generatedAt: new Date().toISOString(),
          builds: builds.sort((a, b) => `${a.platform}-${a.arch}`.localeCompare(`${b.platform}-${b.arch}`)),
        };
        fs.writeFileSync(path.join(DESKTOP_BUILDS_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
        log(`[desktop-sync]   ✓ generated manifest.json (${builds.length} builds, from local zip)`);
      }
    } catch (e) {
      log(`[desktop-sync]   ⚠ manifest.json generation failed: ${e.message}`);
    }
  }

  log(`[desktop-sync] Done ${elapsed}s: ${downloaded} new, ${skipped} cached, ${failed} failed`);

  return {
    ok: failed === 0,
    tag: release.tag_name,
    version: (release.tag_name || "").replace("desktop-v", ""),
    downloaded,
    skipped,
    failed,
    elapsed: `${elapsed}s`,
    dest: DESKTOP_BUILDS_DIR,
    files: results,
  };
}

/**
 * 按 tag 前缀查最新 Release (releases/latest 只返回全局最新, mobile 与 desktop 各自独立发版).
 * 列出全部 releases (per_page=20), 取 tag_name 以 prefix 开头且非 draft/prerelease 的第一个 (列表按创建时间倒序).
 */
function fetchLatestReleaseByTagPrefix(prefix, token, repoOverride) {
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": "Mobius-Desktop-Sync/1.0", "Accept": "application/vnd.github+json" };
    if (token) headers["Authorization"] = `token ${token}`;

    const repo = repoOverride || REPO;
    const url = `${GITHUB_API}/repos/${repo}/releases?per_page=20`;
    https.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        let body = "";
        res.on("data", (d) => body += d);
        res.on("end", () => reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`)));
        return;
      }
      let body = "";
      res.on("data", (d) => body += d);
      res.on("end", () => {
        try {
          const list = JSON.parse(body);
          const hit = (Array.isArray(list) ? list : []).find(
            (r) => !r.draft && !r.prerelease && typeof r.tag_name === "string" && r.tag_name.startsWith(prefix)
          );
          if (!hit) return reject(new Error(`No release with tag prefix '${prefix}'`));
          resolve(hit);
        } catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
      });
    }).on("error", reject);
  });
}

/**
 * 移动端同步: 从 tag 前缀 mobile-v 的 Release 拉取 APK + manifest.json 到 mobius/mobile-builds/.
 * 与桌面端同构: 幂等 (size 一致跳过), manifest 每次覆盖, 旧 APK 清理仅限 mobius-mobile-* 模式.
 * Release 不存在时静默跳过 (移动端发版晚于桌面端属正常), 不影响桌面端结果.
 */
async function syncMobileBuilds(options = {}) {
  const {
    token: ghToken = process.env.GITHUB_TOKEN_DESKTOP || process.env.GITHUB_TOKEN || null,
    log = console.log,
  } = options;

  const startTime = Date.now();
  let release;
  try {
    release = await fetchLatestReleaseByTagPrefix("mobile-v", ghToken, MOBILE_REPO);
  } catch (e) {
    log(`[mobile-sync] skip: ${e.message}`);
    return { ok: true, skipped: true, reason: e.message };
  }
  const assets = release.assets || [];
  log(`[mobile-sync] Latest: ${release.tag_name}, ${assets.length} assets`);

  const apkAssets = assets.filter((a) => a.name.endsWith(".apk") || a.name === "manifest.json");
  if (apkAssets.length === 0) {
    return { ok: true, skipped: true, reason: "No apk/manifest assets in release" };
  }

  fs.mkdirSync(MOBILE_BUILDS_DIR, { recursive: true });
  const results = [];
  for (const asset of apkAssets) {
    const destPath = path.join(MOBILE_BUILDS_DIR, asset.name);
    try {
      // 私有仓库: browser_download_url(CDN通道)对 PAT 常404, 用 asset.url(api端点+octet-stream)稳定
      const assetUrl = ghToken ? (asset.url || asset.browser_download_url) : asset.browser_download_url;
      const r = await downloadFile(assetUrl, destPath, asset.size, ghToken);
      results.push({ ...r });
      if (!r.skipped) log(`[mobile-sync]   ↓ ${r.file} (${(r.size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      log(`[mobile-sync]   ✗ ${asset.name}: ${err.message}`);
      results.push({ file: asset.name, error: err.message });
    }
  }

  // 清理旧版本 APK (mobius-mobile-*.apk 且不在当前 release 中; 备份目录 _backup-* 不动)
  const currentApkNames = new Set(apkAssets.map((a) => a.name));
  try {
    for (const entry of fs.readdirSync(MOBILE_BUILDS_DIR)) {
      if (entry.startsWith("mobius-mobile-") && entry.endsWith(".apk") && !currentApkNames.has(entry)) {
        fs.unlinkSync(path.join(MOBILE_BUILDS_DIR, entry));
        log(`[mobile-sync]   ✕ removed old: ${entry}`);
      }
    }
  } catch (_) { /* 清理失败不影响 */ }

  // 若 Release 未包含 manifest.json (旧 CI 或独立 APK 仓库), 则从本地 APK 重新生成。
  // 镜像桌面 syncDesktopBuilds 165-197 行的 hasManifest 分支, 供 MobileDownloadModal 运行时读取。
  const hasMobileManifest = apkAssets.some((a) => a.name === "manifest.json");
  if (!hasMobileManifest) {
    try {
      const version = (release.tag_name || "").replace("mobile-v", "");
      const builds = [];
      const currentApkOnly = new Set(apkAssets.map((a) => a.name).filter((n) => n.endsWith(".apk")));
      for (const name of currentApkOnly) {
        const filePath = path.join(MOBILE_BUILDS_DIR, name);
        try {
          const st = fs.statSync(filePath);
          const sha256 = require("crypto").createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
          // 从文件名解析: mobius-mobile-<version>-android-<arch>.apk
          //   mobius-mobile-0.1.26-android-arm64.apk          -> rest = "android-arm64"
          //   mobius-mobile-0.1.26-android-armeabi-v7a.apk    -> rest = "android-armeabi-v7a"
          // 用 firstIndexOf("-") 而非 lastIndexOf: armeabi-v7a 这种多段 arch 需要保留整体。
          const rest = name.replace(/^mobius-mobile-[^-]+-/, "").replace(".apk", "");
          const sep = rest.indexOf("-");
          const platform = sep > 0 ? rest.slice(0, sep) : rest;
          const arch = sep > 0 ? rest.slice(sep + 1) : "arm64";
          builds.push({ platform, arch, format: "apk", file: name, size: st.size, sha256 });
        } catch (_) { /* skip */ }
      }
      if (builds.length > 0) {
        const manifest = {
          version,
          generatedAt: new Date().toISOString(),
          builds: builds.sort((a, b) => `${a.platform}-${a.arch}`.localeCompare(`${b.platform}-${b.arch}`)),
        };
        fs.writeFileSync(path.join(MOBILE_BUILDS_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
        log(`[mobile-sync]   ✓ generated manifest.json (${builds.length} builds, from local apk)`);
      }
    } catch (e) {
      log(`[mobile-sync]   ⚠ manifest.json generation failed: ${e.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const downloaded = results.filter((r) => !r.error && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => r.error).length;
  log(`[mobile-sync] Done ${elapsed}s: ${downloaded} new, ${skipped} cached, ${failed} failed`);

  return {
    ok: failed === 0,
    tag: release.tag_name,
    version: (release.tag_name || "").replace("mobile-v", ""),
    downloaded, skipped, failed,
    elapsed: `${elapsed}s`,
    dest: MOBILE_BUILDS_DIR,
    files: results,
  };
}

module.exports = {
  syncDesktopBuilds,
  syncMobileBuilds,
  fetchLatestRelease,
  fetchLatestReleaseByTagPrefix,
  downloadFile,
  DESKTOP_BUILDS_DIR,
  MOBILE_BUILDS_DIR,
};
