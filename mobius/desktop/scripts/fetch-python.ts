// 构建期：为目标平台下载 python-build-standalone 到 resources/<plat>/。
// MVP 默认 Windows x86_64。扩 mac/linux 时在此加 case。
// 实际构建在 Linux 服务器上跑（cross-build Windows 包）；下载 github 走代理即可。
import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// python-build-standalone 发布 tag + 文件名（按需更新到较新稳定版）。
const PBS_TAG = "20241002";
const PBS_FILE = `cpython-3.12.7+${PBS_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz`;
const PBS_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${PBS_FILE}`;
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "resources", "python-win-x64");

function download(url: string, dest: string, redirects = 0): Promise<void> {
  if (redirects > 5) return Promise.reject(new Error("重定向次数过多"));
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        resolve(download(res.headers.location!, dest, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`HTTP ${res.statusCode} 下载 ${url} 失败`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    });
    req.on("error", (e) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(e);
    });
  });
}

async function main(): Promise<void> {
  // install_only 包解压后顶层就是 python/，含 python.exe
  if (fs.existsSync(path.join(OUT_DIR, "python", "python.exe"))) {
    console.log(`[fetch-python] 已存在 ${OUT_DIR}/python/python.exe，跳过`);
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tarball = path.join(OUT_DIR, PBS_FILE);
  console.log(`[fetch-python] 下载 ${PBS_URL}`);
  await download(PBS_URL, tarball);
  console.log(`[fetch-python] 解压到 ${OUT_DIR}`);
  execFileSync("tar", ["-xzf", tarball, "-C", OUT_DIR], { stdio: "inherit" });
  fs.unlinkSync(tarball);
  const ok = fs.existsSync(path.join(OUT_DIR, "python", "python.exe"));
  console.log(ok ? `[fetch-python] 完成 → ${OUT_DIR}/python` : `[fetch-python] ⚠ 解压后未找到 python.exe，检查包结构`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
