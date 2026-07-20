// safeStorage 加密存储账号 / JWT / identifier。Windows 走 DPAPI，macOS 走 Keychain。
// 若环境无 keychain（罕见），回退明文并写日志——不影响功能，仅弱化静态加密。
import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

export interface MobiusUser {
  id?: string;
  name?: string;
  display_name?: string;
  role?: string;
}

export interface StoredCreds {
  username: string;
  password: string;
  jwt: string;
  user: MobiusUser | null;
  identifier: string;
}

function file(): string {
  return path.join(app.getPath("userData"), "secrets.enc");
}

export function loadCreds(): StoredCreds | null {
  try {
    const buf = fs.readFileSync(file());
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString("utf8");
    const data = JSON.parse(json);
    if (!data || !data.jwt) return null;
    return data as StoredCreds;
  } catch {
    return null;
  }
}

export function saveCreds(c: StoredCreds): void {
  const json = JSON.stringify(c);
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, "utf8");
  try {
    fs.writeFileSync(file(), buf, { mode: 0o600 });
  } catch (e) {
    console.error("[secrets] 写入失败:", e);
  }
}

export function clearCreds(): void {
  try {
    fs.unlinkSync(file());
  } catch {
    /* 不存在即视为已清 */
  }
}

// ——— 服务器 URL（纯文本独立存储，不在加密文件中）———

function serverUrlFile(): string {
  return path.join(app.getPath("userData"), "server-url.json");
}

export function loadServerUrl(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(serverUrlFile(), "utf8"));
    return typeof data.server === "string" && data.server ? data.server : null;
  } catch {
    return null;
  }
}

export function saveServerUrl(server: string): void {
  try {
    fs.writeFileSync(serverUrlFile(), JSON.stringify({ server }), { mode: 0o600 });
  } catch (e) {
    console.error("[secrets] 服务器 URL 写入失败:", e);
  }
}

/** 从旧版 secrets.enc 提取 server 字段（迁移用：首次启动没有 server-url.json 时兜底） */
export function loadServerFromOldCreds(): string | null {
  try {
    const f = file();
    if (!fs.existsSync(f)) return null;
    const buf = fs.readFileSync(f);
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString("utf8");
    const data = JSON.parse(json);
    return typeof data.server === "string" && data.server ? data.server : null;
  } catch {
    return null;
  }
}
