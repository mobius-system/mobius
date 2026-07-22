// 构建期：按目标平台下载 python-build-standalone 到 resources/python-<target>/。
// 用法: tsx scripts/fetch-python.ts <win-x64|mac-arm64|mac-x64>  (默认 win-x64)
import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PBS_TAG = "20241002";
const PY_VER = "3.12.7";

const TARGETS: Record<string, { file: string; dir: string; marker: string }> = {
  "win-x64": {
    file: `cpython-${PY_VER}+${PBS_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz`,
    dir: "python-win-x64",
    marker: "python/python.exe",
  },
  "mac-arm64": {
    file: `cpython-${PY_VER}+${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz`,
    dir: "python-mac-arm64",
    marker: "python/bin/python3",
  },
  "mac-x64": {
    file: `cpython-${PY_VER}+${PBS_TAG}-x86_64-apple-darwin-install_only.tar.gz`,
    dir: "python-mac-x64",
    marker: "python/bin/python3",
  },
};

const target = process.argv[2] || "win-x64";
const t = TARGETS[target];
if (!t) {
  console.error(`[fetch-python] 未知目标: ${target}，可选: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}
const PBS_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${t.file}`;
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "resources", t.dir);

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
  // install_only 包解压后顶层就是 python/，含 bin/python3(mac) 或 python.exe(win)
  if (fs.existsSync(path.join(OUT_DIR, t.marker))) {
    console.log(`[fetch-python] 已存在 ${OUT_DIR}/${t.marker}，跳过`);
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tarball = path.join(OUT_DIR, t.file);
  console.log(`[fetch-python] 下载 ${PBS_URL}`);
  await download(PBS_URL, tarball);
  console.log(`[fetch-python] 解压到 ${OUT_DIR}`);
  // --force-local: GNU tar 默认把含冒号的路径当 host:path 解释 (Windows git-bash 下
  // D:\a\... 的 D 会被当主机名 -> "Cannot connect to D: resolve failed")。该标志强制把
  // 冒号当文件名一部分。GNU tar (Linux / git-bash) 支持此标志; macOS 自带 BSD tar 不识别,
  // 传了会报错退出。这里探测一次: 支持才加, 保证三平台都能跑。
  const forceLocal = (() => {
    try {
      execFileSync("tar", ["--force-local", "--version"], { stdio: "ignore" });
      return ["--force-local"];
    } catch {
      return [];
    }
  })();
  // GNU tar (含 git-bash) 还会把反斜杠当转义符: Windows 绝对路径 D:\a\mobius 的 \a \m
  // 被吞掉/改写, 即使加了 --force-local(只绕开冒号) 仍报 "Cannot open: No such file or directory"。
  // 统一成正斜杠: Linux/mac 本就无反斜杠(空操作), Windows 下 D:/a/mobius/... GNU tar 正常解析。
  const posix = (p: string) => p.split(path.sep).join("/");
  execFileSync("tar", [...forceLocal, "-xzf", posix(tarball), "-C", posix(OUT_DIR)], { stdio: "inherit" });
  fs.unlinkSync(tarball);
  const ok = fs.existsSync(path.join(OUT_DIR, t.marker));
  console.log(ok ? `[fetch-python] 完成 → ${OUT_DIR}` : `[fetch-python] ⚠ 解压后未找到 ${t.marker}`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
