// 桌面端本地设置（存 userData，不进服务器）：aimux 反向连接开关等。
// 与 project-paths 同构：JSON 文件 + 0o600 权限。机器特定，不随账号迁移。
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = (): string => path.join(app.getPath("userData"), "desktop-settings.json");

interface Store {
  aimuxEnabled?: boolean;
  // 上次退出时所在页面：key=`${serverOrigin}::${username}` → 路径(pathname+search+hash)。
  // 仅存路径不含 origin，按 账号 维度隔离，桌面端启动时回到上次离开的页面。
  lastRoutes?: Record<string, string>;
  // 多 tab (实验版 0.0.12)：上次退出时该账号打开的 tab 列表，按 tab 顺序存 url(pathname+search+hash)。
  // 重启后按此恢复 tab 列表 + 激活 tab。key 同 lastRoutes = `${serverOrigin}::${username}`。
  lastTabs?: Record<string, { urls: string[]; activeUrl?: string }>;
  updatedAt?: string;
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
    console.error("[desktop-settings] 写入失败:", e);
  }
}

/** aimux 反向连接开关，默认开启（保持原有行为）。
 *  关闭后本机不再作为可调度节点反连 mobius，但桌面端登录/工作台等其他功能正常。 */
export function getAimuxEnabled(): boolean {
  return read().aimuxEnabled !== false; // undefined / true → true；仅显式 false 才关
}

export function setAimuxEnabled(enabled: boolean): void {
  write({ ...read(), aimuxEnabled: enabled, updatedAt: new Date().toISOString() });
}

// ——— 上次退出页面（启动恢复用）———
// key 维度为 服务器 origin + 用户名：换账号/换服务器不会错配恢复路径。
const routeKey = (server: string, username: string): string => `${server}::${username}`;

/** 取本机上次退出时该账号所在页面路径（pathname+search+hash），无则 null。 */
export function getLastRoute(server: string, username: string): string | null {
  return read().lastRoutes?.[routeKey(server, username)] || null;
}

/** 记录本机该账号上次退出页面路径（仅存路径，不含 origin，跨启动稳定）。 */
export function setLastRoute(server: string, username: string, route: string): void {
  const store = read();
  if (!store.lastRoutes) store.lastRoutes = {};
  store.lastRoutes[routeKey(server, username)] = route;
  store.updatedAt = new Date().toISOString();
  write(store);
}

// ——— 多 tab 列表（启动恢复用）———
export interface SavedTabs {
  urls: string[];
  activeUrl?: string;
}

/** 取本机该账号上次退出时的 tab 列表 (urls + 激活 url)，无则 null。 */
export function getLastTabs(server: string, username: string): SavedTabs | null {
  return read().lastTabs?.[routeKey(server, username)] || null;
}

/** 记录本机该账号上次退出时的 tab 列表 (重启恢复用)。urls 为空则清空该账号记录。 */
export function setLastTabs(server: string, username: string, tabs: SavedTabs): void {
  const store = read();
  if (!store.lastTabs) store.lastTabs = {};
  if (tabs.urls.length === 0) {
    delete store.lastTabs[routeKey(server, username)];
  } else {
    store.lastTabs[routeKey(server, username)] = tabs;
  }
  store.updatedAt = new Date().toISOString();
  write(store);
}
