// 内置 python-build-standalone 解释器 + 用户态 venv + pip install aimux。
// 幂等：venv 里已有 aimux 可执行即跳过；"更新 aimux"按钮单独走 upgradeAimux。
import { app } from "electron";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// 首装 pin 的 aimux 版本（与 mobius 引导页一致）。升级后由 upgradeAimux 改写 marker。
export const AIMUX_PIN = "aimux==0.1.9";

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

function run(cmd: string, args: string[], onLine?: (line: string) => void): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const feed = (b: Buffer, sink: (s: string) => void) => {
      const s = b.toString("utf8");
      sink(s);
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

/** 确保 venv + aimux 就绪。已有 aimux 可执行则直接返回（幂等，不强制 pin 版本以免覆盖手动升级）。 */
export async function ensureAimux(onProgress?: (p: InstallProgress) => void): Promise<{ ok: boolean; error?: string }> {
  if (fs.existsSync(aimuxExe())) {
    onProgress?.({ phase: "ready" });
    return { ok: true };
  }
  const py = pythonExe();
  // 1) 建 venv。不带 --upgrade-deps：内置 python-build-standalone 的 pip 已够新，省一次联网升级
  onProgress?.({ phase: "venv", detail: py });
  let r = await run(py, ["-m", "venv", venvDir()]);
  if (r.code !== 0) return { ok: false, error: `venv 创建失败: ${r.stderr || r.stdout}` };

  // 2) 装 aimux（--no-input 防交互卡死，--disable-pip-version-check 减噪音）；实时回传 pip 下载进度
  onProgress?.({ phase: "install", detail: `下载并安装 ${AIMUX_PIN}…` });
  r = await run(
    venvPython(),
    ["-m", "pip", "install", "--no-input", "--disable-pip-version-check", AIMUX_PIN],
    (line) => {
      if (/downloading|collecting|installing|using cached|%\s*\d|━|─/i.test(line)) {
        onProgress?.({ phase: "install", detail: line.slice(0, 100) });
      }
    }
  );
  if (r.code !== 0) return { ok: false, error: `pip install 失败: ${r.stderr || r.stdout}` };
  if (!fs.existsSync(aimuxExe())) return { ok: false, error: `aimux 可执行未生成: ${aimuxExe()}` };

  onProgress?.({ phase: "ready" });
  return { ok: true };
}

/** 查询当前 venv 里 aimux 的版本（状态面板展示用）。 */
export async function getAimuxVersion(): Promise<string> {
  if (!fs.existsSync(venvPython())) return "未安装";
  const r = await run(venvPython(), ["-m", "pip", "show", "aimux"]);
  const m = r.stdout.match(/Version:\s*(\S+)/);
  return m ? m[1] : "未知";
}

/** "更新 aimux"按钮：升到最新版并回写 marker（解除首装 pin）。onProgress 回传 pip 实时输出供状态面板显示。 */
export async function upgradeAimux(onProgress?: (p: InstallProgress) => void): Promise<{ ok: boolean; version?: string; error?: string }> {
  if (!fs.existsSync(venvPython())) return { ok: false, error: "venv 尚未创建" };
  onProgress?.({ phase: "install", detail: "pip install --upgrade aimux…" });
  const r = await run(
    venvPython(),
    ["-m", "pip", "install", "--no-input", "--disable-pip-version-check", "--upgrade", "aimux"],
    (line) => {
      if (/downloading|collecting|installing|using cached|uninstalling|successfully|%\s*\d|━|─/i.test(line)) {
        onProgress?.({ phase: "install", detail: line.slice(0, 100) });
      }
    }
  );
  if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
  const show = await run(venvPython(), ["-m", "pip", "show", "aimux"]);
  const m = show.stdout.match(/Version:\s*(\S+)/);
  onProgress?.({ phase: "ready" });
  return { ok: true, version: m ? m[1] : "unknown" };
}
