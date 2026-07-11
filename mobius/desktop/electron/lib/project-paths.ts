// 每个 mobius 项目 → 本机工作路径 的本地持久化映射。
// 不能存服务器（PC 会断开/改名/路径本就机器特定），所以存桌面端本地 userData，
// key 用 serverOrigin::projectId（projectId 是服务端稳定标识，与机器名无关）。
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = (): string => path.join(app.getPath("userData"), "project-paths.json");

interface Store {
  [k: string]: { path: string; updatedAt: string };
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
  store[key(server, projectId)] = { path: p, updatedAt: new Date().toISOString() };
  write(store);
}

/** 把项目名清理成文件系统安全的目录名（保留中文等普通字符，去掉路径分隔/控制符）。 */
export function sanitizeName(name: string): string {
  const s = name.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").trim();
  return s || "project";
}
