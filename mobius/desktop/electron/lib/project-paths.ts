// 每个 mobius 项目 → 本机工作路径 的本地持久化映射。
// 不能存服务器（PC 会断开/改名/路径本就机器特定），所以存桌面端本地 userData，
// key 用 serverOrigin::projectId（projectId 是服务端稳定标识，与机器名无关）。
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const FILE = (): string => path.join(app.getPath("userData"), "project-paths.json");

interface Store {
  [k: string]: { path?: string; workMode?: string; updatedAt: string };
}

/** TUI-compatible mapping stored in the user's shared ~/.mobius directory. */
export function sharedMobiusHome(): string {
  return path.join(os.homedir(), ".mobius");
}

export function readSharedDir2Project(): Record<string, string> {
  try {
    const file = path.join(sharedMobiusHome(), "dir2project.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Exact path first, then the nearest bound ancestor (useful for subfolders). */
export function findSharedProjectForPath(rawPath: string): { projectId: string; root: string } | null {
  const target = path.resolve(rawPath);
  const map = readSharedDir2Project();
  let best: { projectId: string; root: string } | null = null;
  for (const [rawRoot, rawId] of Object.entries(map)) {
    if (typeof rawId !== "string" || !rawId.trim()) continue;
    const root = path.resolve(rawRoot);
    const rel = path.relative(root, target);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      if (!best || root.length > best.root.length) best = { projectId: rawId.trim(), root };
    }
  }
  return best;
}

export function bindSharedProjectPath(rawPath: string, projectId: string): void {
  const file = path.join(sharedMobiusHome(), "dir2project.json");
  const target = path.resolve(rawPath);
  try {
    const map = readSharedDir2Project();
    map[target] = projectId;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error("[project-paths] 写入共享 .mobius 映射失败:", e);
  }
}

function read(): Store {
  try {
    return JSON.parse(fs.readFileSync(FILE(), "utf8"));
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    fs.writeFileSync(FILE(), JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error("[project-paths] 写入失败:", e);
  }
}

const key = (server: string, projectId: string): string => `${server}::${projectId}`;

export function getProjectLocalPath(server: string, projectId: string): string | null {
  return read()[key(server, projectId)]?.path || null;
}

export function setProjectLocalPath(server: string, projectId: string, p: string): void {
  const store = read();
  const k = key(server, projectId);
  store[k] = { ...store[k], path: p, updatedAt: new Date().toISOString() };
  write(store);
}

/** Session 工作模式偏好: hub=只在中枢 / pc=只在此电脑 / dual=双侧(默认)。 */
export function getProjectWorkMode(server: string, projectId: string): string | null {
  return read()[key(server, projectId)]?.workMode || null;
}
export function setProjectWorkMode(server: string, projectId: string, mode: string): void {
  const store = read();
  const k = key(server, projectId);
  store[k] = { ...store[k], workMode: mode, updatedAt: new Date().toISOString() };
  write(store);
}

/** 把项目名清理成文件系统安全的目录名（保留中文等普通字符，去掉路径分隔/控制符）。 */
export function sanitizeName(name: string): string {
  const s = name.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").trim();
  return s || "project";
}
