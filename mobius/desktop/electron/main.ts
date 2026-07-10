// Mobius Desktop 主进程：登录 → 保证 aimux → reverse connect → loadURL 远程 web UI。
// 详见 README。关键：退出前务必 supervisor.stop() 杀 aimux；aimux 状态经徽标+IPC 常驻可见。
import { app, BrowserWindow, Menu, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as fs from "node:fs";
import { loadCreds, saveCreds, clearCreds, type StoredCreds } from "./lib/secrets";
import { gatherHostInfo, type BootData } from "./lib/host-info";
import { ensureAimux, upgradeAimux, aimuxExe, type InstallProgress } from "./lib/python-runtime";
import { AimuxSupervisor, type AimuxStatus } from "./lib/aimux-supervisor";
import { injectBadge, setBadge } from "./lib/status-overlay";

const currentDir = dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === "darwin";

let mainWindow: BrowserWindow | null = null;
let supervisor: AimuxSupervisor | null = null;
let creds: StoredCreds | null = null;
let lastStatus: AimuxStatus = { state: "stopped" };
let installing = false;

function serverOrigin(): string {
  return (creds?.server || "").replace(/\/$/, "");
}

function defaultIdentifier(): string {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return `desktop-${host || "pc"}`;
}

// ——— 状态分发：徽标 + 推给 web UI ———
function emitStatus(s: AimuxStatus): void {
  lastStatus = s;
  applyStatusToBadge();
  mainWindow?.webContents.send("aimux:status-changed", s);
}

function applyStatusToBadge(): void {
  if (!mainWindow) return;
  void setBadge(mainWindow.webContents, lastStatus.state, lastStatus.detail);
}

// ——— 登录 ———
async function doLogin(serverRaw: string, username: string, password: string): Promise<StoredCreds | { error: string }> {
  const server = serverRaw.replace(/\/$/, "");
  if (!/^https?:\/\//.test(server)) {
    return { error: "服务 URL 需以 http:// 或 https:// 开头" };
  }
  try {
    const res = await fetch(`${server}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { error: `登录失败 (${res.status}): ${t.slice(0, 200)}` };
    }
    const data = (await res.json()) as Record<string, unknown>;
    const token = (data.token || data.jwt || data.access_token) as string | undefined;
    const user = (data.user || data) as StoredCreds["user"];
    if (!token) return { error: "登录响应缺少 token" };
    const identifier = creds?.identifier || defaultIdentifier();
    return { server, username, password, jwt: token, user, identifier };
  } catch (e) {
    return { error: `登录请求失败: ${(e as Error).message}` };
  }
}

function buildSupervisor(): AimuxSupervisor | null {
  if (!creds) return null;
  const exe = aimuxExe();
  if (!fs.existsSync(exe)) return null;
  return new AimuxSupervisor({
    aimuxExe: exe,
    bridgeUrl: `${serverOrigin()}/aimux_bridge`,
    token: creds.jwt,
    identifier: creds.identifier,
    onStatus: emitStatus,
    onTokenExpired: async () => {
      if (!creds) return null;
      const r = await doLogin(creds.server, creds.username, creds.password);
      if ("error" in r) return null;
      creds.jwt = r.jwt;
      saveCreds(creds);
      return r.jwt;
    },
  });
}

// ——— 登录成功后：装 aimux → 反连 → 加载用户主页 ———
async function bootDesktop(): Promise<void> {
  if (!mainWindow || !creds) return;
  const server = serverOrigin();

  installing = true;
  emitStatus({ state: "starting", detail: "正在准备本机 aimux 环境…" });
  const inst = await ensureAimux((p: InstallProgress) => {
    if (p.phase === "venv") emitStatus({ state: "starting", detail: "创建 Python 虚拟环境…" });
    else if (p.phase === "install") emitStatus({ state: "starting", detail: `pip 安装 ${p.detail}…（首装需联网）` });
  });
  installing = false;

  if (!inst.ok) {
    emitStatus({ state: "failed", detail: inst.error });
  } else {
    supervisor = buildSupervisor();
    supervisor?.start();
  }

  // 不做免二次登录：web UI 走它自己的登录；这里只深链到用户主页。
  void mainWindow.loadURL(`${server}/u/${encodeURIComponent(creds.username)}`);
}

// ——— 菜单动作（与 IPC 共用同一份实现）———
function runSyncReload(): void {
  mainWindow?.webContents.reloadIgnoringCache();
}

async function runUpdateAimux(): Promise<{ ok: boolean; version?: string; error?: string }> {
  if (installing) return { ok: false, error: "正在安装中，请稍候" };
  emitStatus({ state: "starting", detail: "正在更新 aimux…" });
  const r = await upgradeAimux();
  if (!r.ok) {
    emitStatus({ state: "failed", detail: r.error });
    return { ok: false, error: r.error };
  }
  await supervisor?.stop();
  supervisor = buildSupervisor();
  supervisor?.start();
  return { ok: true, version: r.version };
}

async function runLogout(): Promise<void> {
  await supervisor?.stop();
  supervisor = null;
  clearCreds();
  creds = null;
  mainWindow?.loadFile(join(currentDir, "../renderer/index.html"));
}

// ——— 窗口 ———
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 960,
    minWidth: 1040,
    minHeight: 760,
    show: false,
    backgroundColor: "#ffffff",
    title: "Mobius Desktop",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(currentDir, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // 外链交给系统浏览器，不在 app 内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // 只允许在登录服务器 origin 内导航，防被重定向到钓鱼页
  mainWindow.webContents.on("will-navigate", (_e, url) => {
    if (url.startsWith("file://")) return;
    const origin = serverOrigin();
    if (origin && !url.startsWith(origin)) _e.preventDefault();
  });

  // 远程页就绪后注入 aimux 状态徽标
  mainWindow.webContents.on("did-finish-load", () => {
    const u = mainWindow?.webContents.getURL() || "";
    if (u.startsWith("http")) {
      void injectBadge(mainWindow!.webContents).then(() => applyStatusToBadge());
    }
  });
}

function buildMenu(): void {
  const tpl: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Mobius Desktop",
      submenu: [
        { label: "同步最新代码", accelerator: "CmdOrCtrl+Shift+R", click: () => runSyncReload() },
        { label: "更新 aimux", click: () => void runUpdateAimux() },
        { type: "separator" },
        { label: "切换账号 / 服务器", click: () => void runLogout() },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "刷新" },
        { role: "forceReload", label: "强制刷新" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "重置缩放" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ——— IPC ———
ipcMain.handle("auth:login", async (_e, c: { server: string; username: string; password: string }) => {
  const r = await doLogin(c.server, c.username, c.password);
  if ("error" in r) return { ok: false as const, error: r.error };
  creds = r;
  saveCreds(creds);
  void bootDesktop();
  return { ok: true as const };
});
ipcMain.handle("auth:get-last-server", () => creds?.server || "");
ipcMain.handle("auth:logout", () => {
  void runLogout();
  return { ok: true };
});
ipcMain.handle("desktop:boot-data", (): BootData =>
  gatherHostInfo({ aimuxIdentifier: creds?.identifier || "", serverOrigin: serverOrigin(), appVersion: app.getVersion() }),
);
ipcMain.handle("aimux:status", () => lastStatus);
ipcMain.handle("aimux:update", () => runUpdateAimux());
ipcMain.handle("app:sync-reload", () => {
  runSyncReload();
  return { ok: true };
});

// ——— 生命周期 ———
app.whenReady().then(async () => {
  buildMenu();
  createWindow();

  // 启动恢复：有保存的凭据就静默重登直进；否则进登录页
  const saved = loadCreds();
  if (saved) {
    const r = await doLogin(saved.server, saved.username, saved.password);
    if (!("error" in r)) {
      creds = { ...saved, jwt: r.jwt, user: r.user };
      saveCreds(creds);
      void bootDesktop();
      return;
    }
  }
  mainWindow?.loadFile(join(currentDir, "../renderer/index.html"));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});

// 退出前务必杀 aimux（Windows taskkill /T 连进程树）
app.on("before-quit", () => {
  void supervisor?.stop();
});
