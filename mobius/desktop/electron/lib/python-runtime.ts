// 内置 python-build-standalone 解释器 + 用户态 venv + pip install aimux。
// 验证实际可导入的版本；自动对齐服务端，手动更新单独走 upgradeAimux。
// Verify the importable version; align to the broker automatically and upgrade only on request.
import { app } from "electron";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// 自动连接对齐服务端版本，手动更新才安装最新版。
// Automatic connections match the broker; only manual updates install the latest release.
import { AIMUX_TARGET_VERSION, alignTarget } from "../../../tui/src/lib/aimux-protocol";
export const AIMUX_PIN = `aimux==${AIMUX_TARGET_VERSION}`;

/*
 * Match the broker version on connection; fall back to the same pin as TUI.
 */
export async function fetchAimuxTarget(server: string, token: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${server.replace(/\/$/, "")}/aimux_bridge/api/health`, {
      headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    });
    if (!response.ok) return AIMUX_TARGET_VERSION;
    const data = await response.json() as { version?: string };
    return alignTarget(data.version);
  } catch { return AIMUX_TARGET_VERSION; }
  finally { clearTimeout(timer); }
}

interface AimuxReady { ok: boolean; error?: string; version?: string; versionWarning?: string }


const WIN = process.platform === "win32";

/** 打包后内置 python 解释器：兼容两种 extraResources 布局。
 *  - 单层：resources/python/python.exe
 *  - 双层：resources/python/python/python.exe（当前 electron-builder extraResources 的实际产物）*/
function bundledPythonExe(): string | null {
  const candidates = WIN
    ? [
        path.join(process.resourcesPath, "python", "python.exe"),
        path.join(process.resourcesPath, "python", "python", "python.exe"),
      ]
    : [
        path.join(process.resourcesPath, "python", "bin", "python3"),
        path.join(process.resourcesPath, "python", "python", "bin", "python3"),
      ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function hasBundledPython(): boolean {
  return !!bundledPythonExe();
}

/** 实际可用的 python 解释器（内置优先，回退系统）。 */
export function pythonExe(): string {
  return bundledPythonExe() || (WIN ? "python.exe" : "python3");
}

export const venvDir = (): string => path.join(app.getPath("userData"), "aimux-venv");
const venvPython = (): string =>
  WIN ? path.join(venvDir(), "Scripts", "python.exe") : path.join(venvDir(), "bin", "python");
/** venv 内 aimux 可执行路径。 */
export function aimuxExe(): string {
  return WIN ? path.join(venvDir(), "Scripts", "aimux.exe") : path.join(venvDir(), "bin", "aimux");
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], onLine?: (line: string) => void, onRaw?: (data: string) => void): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const feed = (b: Buffer, sink: (s: string) => void) => {
      const s = b.toString("utf8");
      sink(s);
      onRaw?.(s);
      if (onLine) {
        // 按 \r 和 \n 都切：pip 下载进度用 \r 原地刷新，这样才能拿到百分比行
        for (const seg of s.split(/[\r\n]+/)) {
          const t = seg.trim();
          if (t) onLine(t);
        }
      }
    };
    child.stdout.on("data", (b: Buffer) => feed(b, (x) => (stdout += x)));
    child.stderr.on("data", (b: Buffer) => feed(b, (x) => (stderr += x)));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

export interface InstallProgress {
  phase: "venv" | "install" | "ready";
  detail?: string;
}

export interface AimuxUpdateCheck {
  ok: boolean;
  current?: string;
  latest?: string;
  updateAvailable?: boolean;
  error?: string;
}

/** venv 根目录的 pyvenv.cfg，记录原始 Python 安装路径。 */
const pyvenvCfgPath = (): string => path.join(venvDir(), "pyvenv.cfg");

/** 从 pyvenv.cfg 提取 home 字段（原始 Python 所在目录）。 */
function readPyvenvHome(): string | null {
  const cfg = pyvenvCfgPath();
  if (!fs.existsSync(cfg)) return null;
  try {
    const text = fs.readFileSync(cfg, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*home\s*=\s*(.+)\s*$/i);
      if (m) return m[1].trim();
    }
  } catch { /* ignore */ }
  return null;
}

/** 验证 venv 的 python.exe 是否真实可用。
 *
 *  双重检测：
 *  1. 读 `pyvenv.cfg` 的 `home` 字段，检查指向的原始 Python 二进制是否还在
 *  2. 真跑 `venvPython() --version` 确认能启动
 *
 *  跨版本升级后旧 venv 的 `pyvenv.cfg` 可能指向已被删除的旧版内置 python，
 *  fs.existsSync 查 file 存在没用，必须溯源判断。 */
async function verifyVenvPython(): Promise<{ ok: boolean; reason?: string }> {
  const py = venvPython();
  if (!fs.existsSync(py)) return { ok: false, reason: "venv python.exe 文件不存在" };

  // 1) 检查 pyvenv.cfg 的 home 指向
  const home = readPyvenvHome();
  if (home) {
    // home 指向的是 python 所在目录（如 resources/python/python/），
    // 该目录下应有 python.exe（Windows）或 python3（macOS/Linux）
    const exeCandidate = WIN
      ? path.join(home, "python.exe")
      : path.join(home, "python3");
    if (!fs.existsSync(exeCandidate)) {
      return { ok: false, reason: `pyvenv.cfg 指向的 Python 已删除: ${exeCandidate}` };
    }
  }

  // 2) 真跑 --version 确认可执行
  const r = await run(py, ["--version"]);
  if (r.code !== 0) {
    return { ok: false, reason: `venv python.exe 启动失败: ${r.stderr || r.stdout || "未知错误"}` };
  }
  return { ok: true };
}

/*
 * Ensure a working runtime matching the broker, including downgrades. If a
 * version swap fails, continue only when the existing runtime still imports.
 */
export async function ensureAimux(onProgress?: (p: InstallProgress) => void, onRaw?: (data: string) => void, target = AIMUX_TARGET_VERSION): Promise<AimuxReady> {
  // Fast-path：aimux 已装好 → 验证 venv python 真实可用才跳过
  if (fs.existsSync(aimuxExe())) {
    const check = await verifyVenvPython();
    if (check.ok) {
      const current = await getAimuxVersion();
      if (current === target) {
        onProgress?.({ phase: "ready" });
        return { ok: true, version: current };
      }
      onProgress?.({ phase: "install", detail: `对齐 AIMUX ${current} → ${target}…` });
      const swap = await run(venvPython(), ["-m", "pip", "install", "--no-input", "--disable-pip-version-check", `aimux==${target}`], undefined, onRaw);
      const actual = await getAimuxVersion();
      if (actual === "未知" || actual === "未安装") return { ok: false, error: "AIMUX 安装后无法导入，请重新安装" };
      const versionWarning = swap.code !== 0 || actual !== target ? `AIMUX 版本未对齐：本地 ${actual}／目标 ${target}，按现有版本继续` : undefined;
      if (versionWarning) onRaw?.(`${versionWarning}\n`);
      onProgress?.({ phase: "ready", detail: versionWarning });
      return { ok: true, version: actual, versionWarning };
    }
    // Venv python 坏了。常见原因：用户升级桌面端后，旧 venv 的 pyvenv.cfg 还记着已删旧版 Python 路径。
    // 删 venv 目录，让下面正常流程用当前 bundled python 重建。
    onProgress?.({ phase: "venv", detail: `旧 venv 已损坏 (${check.reason})，删除并重建…` });
    onRaw?.(`[ensureAimux] venv python 不可用: ${check.reason}\n`);
    await fs.promises.rm(venvDir(), { recursive: true, force: true }).catch(() => {});
  }
  const py = pythonExe();
  // 1) 建 venv。不带 --upgrade-deps：内置 python-build-standalone 的 pip 已够新，省一次联网升级
  onProgress?.({ phase: "venv", detail: py });
  let r = await run(py, ["-m", "venv", venvDir()], undefined, onRaw);
  // 内置 python 可能损坏 / 架构不匹配 (报 spawn ENOENT 或非零退出): 回退系统 python3 重试一次,
  // 避免一直卡在 "venv 创建失败"。系统 python 需用户预装, 且 aimux 要求 3.10+。
  if (r.code !== 0) {
    const sysPy = WIN ? "python.exe" : "python3";
    if (py !== sysPy) {
      onRaw?.(`[ensureAimux] bundled python 不可用 (${(r.stderr || r.stdout).trim()}), 回退系统 ${sysPy}…\n`);
      onProgress?.({ phase: "venv", detail: `内置 Python 不可用，改用系统 ${sysPy}…` });
      r = await run(sysPy, ["-m", "venv", venvDir()], undefined, onRaw);
    }
  }
  if (r.code !== 0) return { ok: false, error: `venv 创建失败: ${r.stderr || r.stdout}` };

  // 2) 装 aimux（--no-input 防交互卡死，--disable-pip-version-check 减噪音）；实时回传 pip 下载进度
  onProgress?.({ phase: "install", detail: `下载并安装 aimux==${target}…` });
  r = await run(
    venvPython(),
    ["-m", "pip", "install", "--no-input", "--disable-pip-version-check", `aimux==${target}`],
    (line) => {
      if (/downloading|collecting|installing|using cached|%\s*\d|━|─/i.test(line)) {
        onProgress?.({ phase: "install", detail: line.slice(0, 100) });
      }
    },
    onRaw,
  );
  if (r.code !== 0) return { ok: false, error: `pip install 失败: ${r.stderr || r.stdout}` };
  if (!fs.existsSync(aimuxExe())) return { ok: false, error: `aimux 可执行未生成: ${aimuxExe()}` };

  const version = await getAimuxVersion();
  if (version !== target) return { ok: false, error: `AIMUX 安装版本校验失败: ${version} / ${target}` };
  onProgress?.({ phase: "ready" });
  return { ok: true, version };
}

/** 查询当前 venv 里 aimux 的版本（状态面板展示用）。 */
export async function getAimuxVersion(): Promise<string> {
  if (!fs.existsSync(venvPython())) return "未安装";
  const r = await run(venvPython(), ["-c", "import aimux, aimux.bridge_client; print(aimux.__version__)"]);
  return r.code === 0 ? r.stdout.trim().split(/\s+/).pop() || "未知" : "未知";
}

/** "更新 aimux"按钮：升到最新版并回写 marker（解除首装 pin）。onProgress 回传 pip 实时输出供状态面板显示。 */
export async function upgradeAimux(onProgress?: (p: InstallProgress) => void, onRaw?: (data: string) => void): Promise<{ ok: boolean; version?: string; error?: string }> {
  // venv 尚未创建/损坏: 走完整安装 (ensureAimux 幂等, 会重建损坏 venv, 内置 python 坏时回退系统 python),
  // 而非直接报 "venv 尚未创建" 卡死。这样 "更新 aimux" 按钮在首装失败 / venv 损坏时也能恢复。
  if (!(await verifyVenvPython()).ok) {
    onProgress?.({ phase: "venv", detail: "aimux 未就绪，重新安装…" });
    const inst = await ensureAimux(onProgress, onRaw);
    if (!inst.ok) return { ok: false, error: inst.error };

  }
  onProgress?.({ phase: "install", detail: "pip install --upgrade aimux…" });
  const r = await run(
    venvPython(),
    ["-m", "pip", "install", "--no-input", "--disable-pip-version-check", "--upgrade", "--no-cache-dir", "--index-url", "https://pypi.org/simple", "aimux"],
    (line) => {
      if (/downloading|collecting|installing|using cached|uninstalling|successfully|%\s*\d|━|─/i.test(line)) {
        onProgress?.({ phase: "install", detail: line.slice(0, 100) });
      }
    },
    onRaw,
  );
  if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
  const version = await getAimuxVersion();
  if (version === "未知" || version === "未安装") return { ok: false, error: "更新后 AIMUX 无法导入" };
  onProgress?.({ phase: "ready" });
  return { ok: true, version };
}
