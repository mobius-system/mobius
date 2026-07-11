// 桌面端本地设置（存 userData，不进服务器）：aimux 反向连接开关等。
// 与 project-paths 同构：JSON 文件 + 0o600 权限。机器特定，不随账号迁移。
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

const FILE = (): string => path.join(app.getPath("userData"), "desktop-settings.json");

interface Store {
  aimuxEnabled?: boolean;
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
