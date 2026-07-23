// Mobius Desktop 主进程：登录 → 保证 aimux → reverse connect → loadURL 远程 web UI。
// 详见 README。关键：退出前务必 supervisor.stop() 杀 aimux；aimux 状态经徽标+IPC 常驻可见。
import { app, BrowserWindow, Menu, ipcMain, shell, dialog, session, screen, type WebPreferences } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as fs from "node:fs";
import { loadCreds, saveCreds, clearCreds, loadServerUrl, saveServerUrl, loadServerFromOldCreds, type StoredCreds } from "./lib/secrets";
import { gatherHostInfo, type BootData } from "./lib/host-info";
import { ensureAimux, upgradeAimux, getAimuxVersion, checkAimuxUpdate, aimuxExe, venvDir, hasBundledPython, type InstallProgress } from "./lib/python-runtime";
import { AimuxSupervisor, aimuxLogPath, appendAimuxLog, type AimuxStatus } from "./lib/aimux-supervisor";
import { getProjectLocalPath, setProjectLocalPath, getProjectWorkMode, setProjectWorkMode, sanitizeName } from "./lib/project-paths";
import { FileOpError, validateNewName, assertNoSymlink, isDirEqualOrChild, copyEntryRecursive } from "./lib/project-file-ops";
import { getAimuxEnabled, setAimuxEnabled, getLastRoute } from "./lib/desktop-settings";
import { createStatusWindow } from "./status-window";
import { TabManager } from "./lib/tab-manager";
import { changeWebContentsZoom, installWebContentsShortcuts } from "./lib/web-contents-shortcuts";

const currentDir = dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === "darwin";

let mainWindow: BrowserWindow | null = null;
let supervisor: AimuxSupervisor | null = null;
let creds: StoredCreds | null = null;
let serverUrl: string | null = null;
let lastStatus: AimuxStatus = { state: "stopped" };
let installing = false;
let updatingAimux = false;
let autoUpdateTimer: NodeJS.Timeout | null = null;
let windowDragTimer: NodeJS.Timeout | null = null;
// aimux 反向连接开关（持久化于 userData/desktop-settings.json，默认开）。
// 关闭后本机不再作为可调度节点连入 mobius，桌面端其他功能不受影响。
let aimuxEnabled = true;

// 多 tab 编排（实验版 0.0.12）。每个 tab = 一个独立 WebContentsView，挂 mainWindow.contentView。
let tabManager: TabManager | null = null;
// mainWindow.webContents 降级为空白容器（内容全在子 view）后的占位页。
const ABOUT_BLANK = "about:blank";

type PortForwardEntry = {
  remotePort: number;
  localPort: number;
  child: ChildProcess;
};

const portForwards = new Map<number, PortForwardEntry>();

/** 每个 tab view 复用的 webPreferences（与原 mainWindow 同配置：ESM preload 需 sandbox:false）。 */
function tabWebPreferences(): WebPreferences {
  return {
    preload: join(currentDir, "../preload/index.mjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    webSecurity: true,
  };
}

/** 延迟创建 TabManager（依赖 mainWindow + creds 就绪）。幂等。 */
function ensureTabManager(): void {
  if (tabManager || !mainWindow || !creds) return;
  tabManager = new TabManager({
    window: () => mainWindow,
    serverOrigin: () => serverOrigin(),
    username: () => creds?.username || "",
    homePath: () => `/u/${encodeURIComponent(creds?.username || "user")}`,
    webPreferences: tabWebPreferences(),
    openExternal: (url) => { void shell.openExternal(url); },
    openDetached: (url) => openDetachedCodeServerWindow(url),
  });
}

function openDetachedCodeServerWindow(url: string): void {
  const origin = serverOrigin();
  const isCodeServerUrl = (target: string) => target === origin + "/code-server" || target.startsWith(origin + "/code-server/");
  if (!origin || !isCodeServerUrl(url)) {
    void shell.openExternal(url);
    return;
  }
  const child = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    title: "Mobius Code Server",
    autoHideMenuBar: true,
    backgroundColor: "#1e1e1e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  child.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    if (isCodeServerUrl(nextUrl)) openDetachedCodeServerWindow(nextUrl);
    else void shell.openExternal(nextUrl);
    return { action: "deny" };
  });
  child.webContents.on("will-navigate", (e, nextUrl) => {
    if (isCodeServerUrl(nextUrl)) return;
    e.preventDefault();
    void shell.openExternal(nextUrl);
  });
  installWebContentsShortcuts(child.webContents);
  child.loadURL(url).catch((error) => {
    dialog.showErrorBox("code-server 打开失败", error?.message || String(error));
    try { child.close(); } catch { /* ignore */ }
  });
}

// aimux 日志环形缓冲（供状态面板查看历史 + 失败原因）
const LOG_MAX = 300;
const logBuffer: string[] = [];
function broadcast(channel: string, payload: unknown): void {
  // 主窗口容器 + aimux 状态窗口等所有窗口，再 + 所有 tab view（每个 tab 页面都要收 aimux 状态/窗口状态）。
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try { w.webContents.send(channel, payload); } catch { /* 窗口可能正在加载 */ }
    }
  }
  tabManager?.sendToAllViews(channel, payload);
}
function appendLog(line: string): void {
  logBuffer.push(line);
  if (logBuffer.length > LOG_MAX) logBuffer.splice(0, logBuffer.length - LOG_MAX);
  broadcast("aimux:log", line);
}

function appendAimuxLine(line: string): void {
  appendLog(line);
  appendAimuxLog(`${line}\n`);
}

function stopWindowDrag(): void {
  if (windowDragTimer) {
    clearInterval(windowDragTimer);
    windowDragTimer = null;
  }
}

function cancelAutoAimuxUpdateCheck(): void {
  if (autoUpdateTimer) {
    clearTimeout(autoUpdateTimer);
    autoUpdateTimer = null;
  }
}

function serverOrigin(): string {
  return (serverUrl || "").replace(/\/$/, "");
}

function defaultIdentifier(): string {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return `desktop-${host || "pc"}`;
}

function resolveLocalProjectPath(projectId: string, rawPath: unknown = "/"): { error: string } | { root: string; relPath: string; absPath: string } {
  const saved = getProjectLocalPath(serverOrigin(), projectId);
  if (!saved) return { error: "未绑定本机工作路径" };
  const root = resolve(saved);
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    return { error: (e as Error).message || "本机工作路径不可用" };
  }
  const relPathRaw = String(rawPath || "/").replace(/\.\./g, "");
  const absPath = resolve(root, relPathRaw.replace(/^[/\\]+/, ""));
  if (absPath !== root && !absPath.startsWith(root + sep)) return { error: "Access denied" };
  return { root, relPath: "/" + relative(root, absPath).replace(/\\/g, "/"), absPath };
}

// ——— 项目本地路径绑定状态（供前端 ProjectPathBindGate 拉取决定是否弹绑定弹窗）———
// 取代旧版主进程注入 overlay：前端在进入项目页时调 project:bind-status，未绑定则自己渲染弹窗。
async function fetchProjectName(server: string, projectId: string): Promise<string> {
  if (!creds) return projectId;
  try {
    const res = await fetch(`${server}/api/projects`, { headers: { Authorization: `Bearer ${creds.jwt}` } });
    if (!res.ok) return projectId;
    const data = await res.json();
    const list: unknown[] = Array.isArray(data) ? data : (data as { projects?: unknown[] }).projects || [];
    const p = list.find((x) => (x as { id?: string }).id === projectId) as { name?: string } | undefined;
    return p?.name || projectId;
  } catch {
    return projectId;
  }
}

// ——— 状态分发：推给 web UI（前端 AimuxStatusBadge 通过 IPC 接收，不再由主进程注入徽标）———
function emitStatus(s: AimuxStatus): void {
  lastStatus = s;
  broadcast("aimux:status-changed", s);
  if (s.detail) appendLog(`[${s.state}] ${s.detail}`);
}

async function probeAimuxBridgeConnection(identifier: string): Promise<boolean> {
  if (!creds || !serverUrl) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${serverOrigin()}/aimux_bridge/api/remotes/${encodeURIComponent(identifier)}/connection`, {
      headers: { Authorization: `Bearer ${creds.jwt}` },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const data = await response.json() as { identifier?: unknown; event_stream_connected?: unknown };
    return data.identifier === identifier && data.event_stream_connected === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
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
    return { username, password, jwt: token, user, identifier };
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
    onLog: (line) => appendLog(line),
    probeBridgeConnection: () => probeAimuxBridgeConnection(creds!.identifier),
    onTokenExpired: async () => {
      if (!creds || !serverUrl) return null;
      const r = await doLogin(serverUrl, creds.username, creds.password);
      if ("error" in r) return null;
      creds.jwt = r.jwt;
      saveCreds(creds);
      return r.jwt;
    },
  });
}

function normalizePort(value: unknown): number | null {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function isPortForwardAlive(entry: PortForwardEntry): boolean {
  return !!entry.child.pid && entry.child.exitCode === null && !entry.child.killed;
}

function localPortUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

function findFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("无法分配本地端口"));
      });
    });
  });
}

function waitForTcpPort(port: number, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (!err) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`本地端口 ${port} 未在 ${timeoutMs}ms 内就绪`));
          return;
        }
        setTimeout(tryConnect, 250);
      };
      socket.setTimeout(1000, () => done(new Error("timeout")));
      socket.on("connect", () => done());
      socket.on("error", (err) => done(err));
    };
    tryConnect();
  });
}

async function ensureAimuxForPortForward(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (installing) return { ok: false, error: "aimux 正在安装中，请稍后再试" };
  installing = true;
  emitStatus({ state: "starting", detail: "正在检查 aimux port forward 环境…" });
  appendAimuxLog(`\n==== [${new Date().toISOString()}] ensure aimux (port forward) ====\n`);
  try {
    const r = await ensureAimux(
      (p: InstallProgress) => {
        if (p.phase === "venv") emitStatus({ state: "starting", detail: "创建 Python 虚拟环境…" });
        else if (p.phase === "install") emitStatus({ state: "starting", detail: `下载并安装 aimux… ${p.detail ?? ""}` });
      },
      (data: string) => appendAimuxLog(data),
    );
    return r.ok ? { ok: true } : { ok: false, error: r.error || "aimux 安装失败" };
  } finally {
    installing = false;
  }
}

async function startAimuxPortForward(remotePortValue: unknown): Promise<{ ok: boolean; url?: string; localPort?: number; remotePort?: number; reused?: boolean; error?: string }> {
  if (!creds) return { ok: false, error: "未登录" };
  const remotePort = normalizePort(remotePortValue);
  if (!remotePort) return { ok: false, error: "项目端口必须是 1-65535 的整数" };

  const existing = portForwards.get(remotePort);
  if (existing && isPortForwardAlive(existing)) {
    return { ok: true, url: localPortUrl(existing.localPort), localPort: existing.localPort, remotePort, reused: true };
  }
  if (existing) portForwards.delete(remotePort);

  const ready = await ensureAimuxForPortForward();
  if (!ready.ok) return ready;

  const localPort = await findFreeLocalPort();
  const exe = aimuxExe();
  const bridgeUrl = `${serverOrigin()}/aimux_bridge`;
  const args = [
    "port", "forward", bridgeUrl,
    "--local-host", "127.0.0.1",
    "--local-port", String(localPort),
    "--remote-host", "127.0.0.1",
    "--remote-port", String(remotePort),
    "--token", creds.jwt,
  ];
  appendAimuxLog(`\n==== [${new Date().toISOString()}] spawn port forward local=${localPort} remote=${remotePort} ====\n`);
  const child = spawn(exe, args, { windowsHide: true });
  const entry: PortForwardEntry = { remotePort, localPort, child };
  portForwards.set(remotePort, entry);

  const handle = (b: Buffer) => {
    appendAimuxLog(b);
    for (const line of b.toString("utf8").split(/[\r\n]+/)) {
      const t = line.trim();
      if (t) appendLog(`[port ${remotePort}] ${t}`);
    }
  };
  child.stdout?.on("data", handle);
  child.stderr?.on("data", handle);
  child.on("exit", (code) => {
    appendAimuxLog(`\n---- [${new Date().toISOString()}] port forward remote=${remotePort} exited code=${code} ----\n`);
    const current = portForwards.get(remotePort);
    if (current?.child === child) portForwards.delete(remotePort);
  });
  child.on("error", (err) => {
    appendAimuxLine(`[aimux port-forward] spawn failed remote=${remotePort}: ${err.message}`);
  });

  try {
    await waitForTcpPort(localPort);
  } catch (e) {
    portForwards.delete(remotePort);
    try { child.kill(); } catch { /* ignore */ }
    return { ok: false, error: (e as Error).message || "aimux port forward 启动失败" };
  }

  appendAimuxLine(`[aimux port-forward] ready remote=${remotePort} local=${localPort}`);
  return { ok: true, url: localPortUrl(localPort), localPort, remotePort, reused: false };
}

async function stopAllPortForwards(): Promise<void> {
  const entries = [...portForwards.values()];
  portForwards.clear();
  await Promise.all(entries.map((entry) => new Promise<void>((resolveDone) => {
    const child = entry.child;
    if (!child.pid || child.exitCode !== null || child.killed) {
      resolveDone();
      return;
    }
    child.once("exit", () => resolveDone());
    try { child.kill(); } catch { resolveDone(); }
    setTimeout(resolveDone, 1500).unref?.();
  })));
}

// ——— 登录成功后：装 aimux → 反连 → 加载用户主页 ———
/** 用隐藏窗口把 JWT 注入服务器 origin 的 localStorage['cc-token']，让 web UI 免二次登录。
 *  web UI 的 api() 从 cc-token 取 token 发 Bearer，App.tsx 启动若有 token 就调 /api/auth/me 自动登录。*/
async function seedWebAuth(origin: string, jwt: string): Promise<void> {
  return new Promise((resolve) => {
    const seed = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { seed.destroy(); } catch { /* ignore */ }
      resolve();
    };
    seed.webContents.once("dom-ready", async () => {
      try {
        await seed.webContents.executeJavaScript(
          `try { localStorage.setItem('cc-token', ${JSON.stringify(jwt)}); } catch (e) {} true`
        );
      } catch { /* ignore */ }
      finish();
    });
    seed.loadURL(`${origin}/`).catch(finish);
    setTimeout(finish, 5000); // 兜底，避免隐藏窗口卡住阻塞进工作台
  });
}

/** 装 aimux（幂等）→ 反向连接。供 bootDesktop(启动) 与 applyAimuxEnabled(开启) 共用。
 *  安装期间若用户关闭开关，装完也不连（末尾按 aimuxEnabled 复核）。 */
async function startAimuxConnection(): Promise<void> {
  if (!creds || installing) return;
  installing = true;
  emitStatus({ state: "starting", detail: "首次启动需在本机下载 aimux（联网，约 30-90 秒）…" });
  appendAimuxLog(`\n==== [${new Date().toISOString()}] ensure aimux (install) ====\n`);
  const inst = await ensureAimux(
    (p: InstallProgress) => {
      if (p.phase === "venv") emitStatus({ state: "starting", detail: "创建 Python 虚拟环境…" });
      else if (p.phase === "install") emitStatus({ state: "starting", detail: `下载并安装 aimux… ${p.detail ?? ""}` });
    },
    (data: string) => appendAimuxLog(data),
  );
  installing = false;

  if (!inst.ok) {
    emitStatus({ state: "failed", detail: inst.error });
    return;
  }
  if (!aimuxEnabled) return; // 安装期间用户关闭了开关：装完也不连
  emitStatus({ state: "starting", detail: "aimux 就绪，正在反向连接 mobius…" });
  supervisor = buildSupervisor();
  supervisor?.start();
}

async function bootDesktop(): Promise<void> {
  if (!mainWindow || !creds) return;
  const server = serverOrigin();

  if (aimuxEnabled) {
    await startAimuxConnection();
    emitStatus({ state: lastStatus.state, detail: "正在登录工作台…" });
  } else {
    // 用户已关闭 aimux 反连：不装不连，直接进工作台。徽标显示"已关闭"。
    emitStatus({ state: "disabled", detail: "aimux 连接已关闭（可在 aimux 状态面板开启）" });
    appendAimuxLog(`\n==== [${new Date().toISOString()}] aimux disabled by user, skip reverse connect ====\n`);
  }

  await seedWebAuth(server, creds.jwt);
  // 多 tab（实验版 0.0.12）：mainWindow.webContents 降级为空白容器，TabManager 接管所有页面。
  // 每个用户页面 = contentView 的子 WebContentsView，独立 webContents 状态隔离；
  // restore() 有 lastTabs 则恢复上次 tab 列表，否则建一个用户主页 tab。
  ensureTabManager();
  void mainWindow.loadURL(ABOUT_BLANK);
  tabManager!.restore();
  scheduleAutoAimuxUpdateCheck();
}

/** 退出前持久化当前 tab 列表（多 tab 版 0.0.12，取代单页 persistLastRoute）。 */
function persistTabs(): void {
  tabManager?.persist();
}

// ——— 菜单动作（与 IPC 共用同一份实现）———
function runSyncReload(): void {
  // 多 tab：刷新当前激活 tab（而非 mainWindow 容器）。
  tabManager?.reloadActive();
}

// 切换到相邻 tab（offset=1 下一个，-1 上一个，循环）。供菜单 Cmd+Tab / Cmd+Shift+Tab。
function switchTabOffset(offset: number): void {
  if (!tabManager) return;
  const tabs = tabManager.getTabs();
  const active = tabManager.getActiveTabId();
  if (tabs.length < 2 || !active) return;
  const idx = tabs.findIndex((t) => t.id === active);
  if (idx < 0) return;
  const next = (idx + offset + tabs.length) % tabs.length;
  tabManager.switchTab(tabs[next].id);
}

async function runUpdateAimux(source: "manual" | "auto" = "manual"): Promise<{ ok: boolean; version?: string; error?: string }> {
  if (installing) return { ok: false, error: "正在安装中，请稍候" };
  if (updatingAimux) return { ok: false, error: "正在更新中，请稍候" };
  updatingAimux = true;
  // 1) 先断开现有连接 (停 supervisor + 反连子进程), 释放 venv 文件锁, 避免 pip 升级时 aimux 还在跑.
  try {
    emitStatus({ state: "starting", detail: source === "auto" ? "检测到 aimux 新版本，准备后台更新…" : "断开现有连接, 准备更新 aimux…" });
    await supervisor?.stop();
    supervisor = null;
    // 2) 升级: pip 实时输出 -> appendAimuxLog (aimux.log 持久化) + appendLog (状态面板环形缓冲) + emitStatus (徽标显示当前阶段).
    emitStatus({ state: "starting", detail: source === "auto" ? "正在后台更新 aimux…" : "正在更新 aimux…" });
    appendAimuxLog(`\n==== [${new Date().toISOString()}] ${source} upgrade aimux ====\n`);
    const r = await upgradeAimux(
      (p) => {
        if (p.detail) {
          appendLog(p.detail);
          emitStatus({ state: "starting", detail: p.detail });
        }
      },
      (data: string) => appendAimuxLog(data),
    );
    if (!r.ok) {
      emitStatus({ state: "failed", detail: r.error });
      return { ok: false, error: r.error };
    }
    // 3) 升级成功. 开关开着才重连；关着则只升级不连。
    if (aimuxEnabled) {
      emitStatus({ state: "starting", detail: `aimux ${r.version} 已就绪, 正在反向连接…` });
      supervisor = buildSupervisor();
      supervisor?.start();
    } else {
      emitStatus({ state: "disabled", detail: `aimux ${r.version} 已更新（连接已关闭）` });
    }
    return { ok: true, version: r.version };
  } finally {
    updatingAimux = false;
  }
}

function scheduleAutoAimuxUpdateCheck(): void {
  if (autoUpdateTimer) clearTimeout(autoUpdateTimer);
  autoUpdateTimer = setTimeout(() => {
    autoUpdateTimer = null;
    void runAutoAimuxUpdateCheck();
  }, 8000);
}

async function runAutoAimuxUpdateCheck(): Promise<void> {
  if (!creds || installing || updatingAimux) return;
  if (!fs.existsSync(aimuxExe())) {
    appendAimuxLine(`[aimux auto-update] skip: aimux 尚未安装`);
    return;
  }
  appendAimuxLog(`\n==== [${new Date().toISOString()}] auto check aimux update ====\n`);
  const check = await checkAimuxUpdate((data: string) => appendAimuxLog(data));
  if (!check.ok) {
    appendAimuxLine(`[aimux auto-update] check failed: ${check.error || "unknown error"}`);
    return;
  }
  appendAimuxLine(`[aimux auto-update] current=${check.current} latest=${check.latest}`);
  if (!check.updateAvailable) return;
  appendAimuxLine(`[aimux auto-update] upgrading aimux ${check.current} -> ${check.latest}`);
  const result = await runUpdateAimux("auto");
  appendAimuxLine(result.ok
    ? `[aimux auto-update] upgraded to ${result.version || check.latest}`
    : `[aimux auto-update] upgrade failed: ${result.error || "unknown error"}`);
}

async function runLogout(): Promise<void> {
  cancelAutoAimuxUpdateCheck();
  await stopAllPortForwards();
  await supervisor?.stop();
  supervisor = null;
  // 多 tab：销毁所有 tab view + TabManager，回到登录页。
  tabManager?.destroyAll();
  tabManager = null;
  clearCreds();
  creds = null;
  // serverUrl 不清除，保留给登录页预填（URL 本身不是敏感信息）
  mainWindow?.loadFile(join(currentDir, "../renderer/index.html"));
}

/** 切换 aimux 反连开关并即时生效：关=停 supervisor+反连子进程；开=装+连（未登录则等下次 boot）。 */
async function applyAimuxEnabled(enabled: boolean): Promise<void> {
  aimuxEnabled = enabled;
  setAimuxEnabled(enabled);
  if (!enabled) {
    await supervisor?.stop();
    supervisor = null;
    emitStatus({ state: "disabled", detail: "aimux 连接已关闭" });
    appendAimuxLog(`\n==== [${new Date().toISOString()}] aimux disabled by user ====\n`);
  } else if (creds && mainWindow) {
    if (installing) {
      // 正在安装：装完会按 aimuxEnabled 自动连接，这里只提示
      emitStatus({ state: "starting", detail: "aimux 安装中，完成后将自动连接…" });
    } else {
      await startAimuxConnection();
    }
  }
  updateMenuChecked();
}

/** 把菜单里 "允许 aimux 反向连接" checkbox 同步到当前 aimuxEnabled（状态面板切换后调用）。 */
function updateMenuChecked(): void {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  for (const top of menu.items) {
    const sub = top.submenu;
    if (!sub) continue;
    for (const it of sub.items) {
      if (it.label === "允许 aimux 反向连接") { it.checked = aimuxEnabled; return; }
    }
  }
}

// ——— 窗口 ———
function createWindow(): void {
  // 应用图标：打包后从 extraResources 读 (process.resourcesPath/icon.png)，dev 时读源 build/icon.png。
  // Windows/Linux 任务栏 + 窗口图标用它；macOS 走 .app 内 icns (构建期由 build/icon.png 自动生成)。
  const appIconPath = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(currentDir, "../../build/icon.png");
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 960,
    minWidth: 1040,
    minHeight: 760,
    show: false,
    backgroundColor: "#ffffff",
    title: "Mobius Desktop",
    icon: appIconPath,
    // Windows/Linux: 隐藏原生标题栏 + titleBarOverlay 叠原生窗口按钮 (VSCode 风),
    // 让远程 mobius 顶栏充当标题栏; macOS: hiddenInset 已是 VSCode 风 (交通灯内嵌), 保持。
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    // 不用 titleBarOverlay: 此环境 (未签名 exe + 高 DPI 缩放) 下原生窗口按钮符号不渲染 (只剩背景色块)。
    // 改由前端自绘窗口按钮 (WindowControls) + window:* IPC 控制, 主题自适应可靠。macOS 用系统交通灯。
    // 隐藏菜单条 (Windows/Linux 按 Alt 唤出, macOS 系统菜单栏不受影响); 快捷键与功能全保留。
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(currentDir, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:false 是必须的：preload 是 ESM(.mjs)，Electron 沙箱下 ESM preload 不会执行
      // → contextBridge 不注入 → window.desktop 为 undefined（登录报 "reading 'login'"）。
      // contextIsolation:true + nodeIntegration:false 已保证页面拿不到 Node，安全边界不变。
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // mainWindow.webContents 是空白容器（多 tab 0.0.12）：不加载用户页面，故不再挂
  // setWindowOpenHandler / will-navigate / F12。这些改为挂到每个 tab view（见 TabManager.attachHandlers）。

  // 最大化状态变化推给前端 (自绘窗口按钮在 最大化↔还原 图标间切换)
  mainWindow.on("maximize", () => broadcast("window:maximize-changed", true));
  mainWindow.on("unmaximize", () => broadcast("window:maximize-changed", false));

  // 缩放约束：拖拽时强制 width >= height（不锁 aspectRatio，仅维持不等式 w ≥ h）。
  // will-resize 在用户手动拖拽改尺寸前触发；setBounds 不会触发本事件，故无递归。
  // minWidth:1040 / minHeight:760 保持不变（width=1040 时 height 同步为 1040 仍 ≥760，无冲突）；
  // 最大化/还原不经过 will-resize，行为不受影响。同一份代码三平台统一处理。
  mainWindow.on("will-resize", (event, newBounds) => {
    if (newBounds.width < newBounds.height) {
      event.preventDefault();
      // 把 height 同步为 width，确保 w ≥ h（相等即满足）。
      mainWindow?.setBounds({ ...newBounds, height: newBounds.width });
    }
  });

  // 窗口尺寸变化时重布局所有 tab view（view 铺满客户区，需跟随 resize）。
  mainWindow.on("resize", () => tabManager?.relayout());

  // 窗口关闭时持久化当前 tab 列表：退出/关窗都会触发 close，覆盖 Mac(关窗不退出) 与 三平台退出。
  mainWindow.on("close", () => persistTabs());
  // 项目本地路径绑定已移至前端 ProjectPathBindGate（进入项目页时拉 project:bind-status 自行渲染弹窗）。
}

function buildMenu(): void {
  const tpl: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Mobius Desktop",
      submenu: [
        { label: "同步最新代码", accelerator: "CmdOrCtrl+Shift+R", click: () => runSyncReload() },
        { label: "更新 aimux", click: () => void runUpdateAimux() },
        { label: "aimux 状态面板", accelerator: "CmdOrCtrl+Shift+A", click: () => createStatusWindow() },
        {
          label: "允许 aimux 反向连接",
          type: "checkbox",
          checked: aimuxEnabled,
          click: (mi) => {
            if (installing) { mi.checked = aimuxEnabled; return; } // 安装中不允许切换，还原勾选
            void applyAimuxEnabled(mi.checked);
          },
        },
        { type: "separator" },
        { label: "切换账号 / 服务器", click: () => void runLogout() },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "新建标签页", accelerator: "CmdOrCtrl+T", click: () => tabManager?.createTab(undefined, { activate: true }) },
        { label: "关闭标签页", accelerator: "CmdOrCtrl+W", click: () => { const id = tabManager?.getActiveTabId(); if (id) tabManager?.closeTab(id); } },
        { label: "下一个标签页", accelerator: "CmdOrCtrl+Tab", click: () => switchTabOffset(1) },
        { label: "上一个标签页", accelerator: "CmdOrCtrl+Shift+Tab", click: () => switchTabOffset(-1) },
        { type: "separator" },
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
  serverUrl = c.server.replace(/\/$/, "");
  saveCreds(creds);
  saveServerUrl(serverUrl);
  void bootDesktop();
  return { ok: true as const };
});
ipcMain.handle("auth:get-last-server", () => serverUrl || "");
ipcMain.handle("auth:logout", () => {
  void runLogout();
  return { ok: true };
});
ipcMain.handle("desktop:boot-data", (): BootData =>
  gatherHostInfo({ aimuxIdentifier: creds?.identifier || "", serverOrigin: serverOrigin(), appVersion: app.getVersion() }),
);
// /welcome 欢迎向导"从上次结束处继续"用：返本机该账号上次退出页路径 (仅 /u/username 前缀内, 跨账号/跨域不存)。
// 无记录 (首次运行) 或未登录返 null -> 向导隐藏该项。
ipcMain.handle("desktop:get-last-route", () => {
  if (!creds) return null;
  const saved = getLastRoute(serverOrigin(), creds.username);
  if (!saved) return null;
  const homePath = `/u/${encodeURIComponent(creds.username)}`;
  return saved.startsWith(homePath) ? saved : null;
});
// ——— 多 tab（实验版 0.0.12）：前端 tab 栏经这些 IPC 订阅状态、发指令 ———
ipcMain.handle("tabs:get", () => tabManager?.getTabs() ?? []);
ipcMain.handle("tabs:get-active", () => tabManager?.getActiveTabId() ?? null);
ipcMain.handle("tabs:new", (_e, opts?: { url?: string }) => {
  if (!tabManager) return { ok: false as const, error: "未就绪" };
  tabManager.createTab(opts?.url, { activate: true });
  return { ok: true as const };
});
ipcMain.handle("tabs:close", (_e, id: string) => { tabManager?.closeTab(id); return { ok: true }; });
ipcMain.handle("tabs:switch", (_e, id: string) => { tabManager?.switchTab(id); return { ok: true }; });
ipcMain.handle("tabs:reorder", (_e, ids: string[]) => { tabManager?.reorderTabs(ids); return { ok: true }; });
ipcMain.handle("aimux:status", () => lastStatus);
ipcMain.handle("aimux:update", () => runUpdateAimux());
ipcMain.handle("app:sync-reload", () => {
  runSyncReload();
  return { ok: true };
});
ipcMain.handle("aimux:details", () => ({
  status: lastStatus,
  aimuxEnabled,
  identifier: creds?.identifier || "",
  serverOrigin: serverOrigin(),
  venvDir: venvDir(),
  aimuxExe: aimuxExe(),
  aimuxLogPath: aimuxLogPath(),
  hasBundledPython: hasBundledPython(),
  hostInfo: gatherHostInfo({ aimuxIdentifier: creds?.identifier || "", serverOrigin: serverOrigin(), appVersion: app.getVersion() }),
  logs: [...logBuffer],
}));
ipcMain.handle("aimux:version", () => getAimuxVersion());
ipcMain.handle("aimux:reconnect", async () => {
  if (!creds) return { ok: false, error: "未登录" };
  if (!aimuxEnabled) return { ok: false, error: "aimux 连接已关闭，请先开启开关" };
  await supervisor?.stop();
  supervisor = buildSupervisor();
  if (!supervisor) return { ok: false, error: "aimux 未就绪（venv 可能未建好），请稍后重试" };
  supervisor.start();
  return { ok: true };
});
ipcMain.handle("aimux:port-forward", async (_e, opts: { remotePort?: number }) => {
  return startAimuxPortForward(opts?.remotePort);
});
ipcMain.handle("aimux:get-enabled", () => aimuxEnabled);
ipcMain.handle("aimux:set-enabled", async (_e, enabled: boolean) => {
  if (installing) return { ok: false as const, error: "正在安装 aimux，请稍候" };
  await applyAimuxEnabled(Boolean(enabled));
  return { ok: true as const, enabled: aimuxEnabled };
});
ipcMain.handle("app:open-status", () => {
  createStatusWindow();
  return { ok: true };
});
ipcMain.handle("app:open-devtools", () => {
  // 多 tab：打开激活 tab 的 devtools（而非 mainWindow 容器）。
  tabManager?.openDevTools();
  return { ok: true };
});
// 清除缓存 (远程前端 HTTP/SW 缓存, 保留登录态 cc-token): clearCache + 清 SW/Cache/Shader (不动 localstorage/cookies),
// 再 reloadIgnoringCache 让前端拉最新资源。供 /welcome「清除缓存」按钮调用。
ipcMain.handle("app:clear-cache", async () => {
  try {
    const ses = mainWindow?.webContents.session || session.defaultSession;
    await ses.clearCache().catch(() => {});
    await ses.clearStorageData({ storages: ["serviceworkers", "cachestorage", "shadercache"] }).catch(() => {});
  } catch { /* 忽略, 仍尝试刷新 */ }
  // 多 tab：刷新激活 tab（所有 tab 共享 defaultSession，清缓存对所有 tab 生效）。
  tabManager?.reloadActive();
  return { ok: true };
});
// 前端切主题后上报标题栏覆盖层: 透明背景透出顶栏主题色 + 当前 --text-primary 作窗口按钮图标色。
// macOS 用原生交通灯, 无 overlay, 直接忽略。
ipcMain.handle("desktop:set-title-bar-overlay", (_e, opts: { color?: string; symbolColor?: string; height?: number }) => {
  if (isMac) return { ok: true };
  try { mainWindow?.setTitleBarOverlay(opts); } catch { /* 窗口未就绪 */ }
  return { ok: true };
});
// 窗口控制 (前端自绘按钮调用; titleBarOverlay 原生按钮符号在此环境不渲染, 故自绘)
ipcMain.handle("window:minimize", () => { mainWindow?.minimize(); return { ok: true }; });
ipcMain.handle("window:zoom-in", (event) => {
  const zoomFactor = changeWebContentsZoom(event.sender, 0.1);
  return { ok: true, zoomFactor };
});
ipcMain.handle("window:zoom-out", (event) => {
  const zoomFactor = changeWebContentsZoom(event.sender, -0.1);
  return { ok: true, zoomFactor };
});
ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) return { ok: true, maximized: false };
  if (mainWindow.isMaximized()) { mainWindow.unmaximize(); return { ok: true, maximized: false }; }
  mainWindow.maximize(); return { ok: true, maximized: true };
});
ipcMain.handle("window:close", () => { mainWindow?.close(); return { ok: true }; });
ipcMain.handle("window:is-maximized", () => !!mainWindow?.isMaximized());
ipcMain.handle("window:start-drag", () => {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return { ok: false };
  if (isMac) return { ok: true };
  stopWindowDrag();

  const startCursor = screen.getCursorScreenPoint();
  if (win.isMaximized()) {
    const maximizedBounds = win.getBounds();
    const xRatio = maximizedBounds.width > 0
      ? Math.max(0, Math.min(1, (startCursor.x - maximizedBounds.x) / maximizedBounds.width))
      : 0.5;
    win.unmaximize();
    const restored = win.getBounds();
    win.setPosition(
      Math.round(startCursor.x - restored.width * xRatio),
      Math.round(startCursor.y - 18),
      false,
    );
  }

  const dragCursor = screen.getCursorScreenPoint();
  const startBounds = win.getBounds();
  let lastX = startBounds.x;
  let lastY = startBounds.y;
  windowDragTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      stopWindowDrag();
      return;
    }
    const p = screen.getCursorScreenPoint();
    const x = Math.round(startBounds.x + p.x - dragCursor.x);
    const y = Math.round(startBounds.y + p.y - dragCursor.y);
    if (x === lastX && y === lastY) return;
    lastX = x;
    lastY = y;
    mainWindow.setPosition(x, y, false);
  }, 16);
  return { ok: true };
});
ipcMain.handle("window:end-drag", () => { stopWindowDrag(); return { ok: true }; });
// ——— 项目本地路径绑定 ———
ipcMain.handle("project:pick-directory", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});
ipcMain.handle("project:confirm-path", async (_e, projectId: string, pathRaw: string) => {
  if (!mainWindow || !creds) return { ok: false, error: "未登录" };
  const p = String(pathRaw || "").trim();
  if (!p) return { ok: false, error: "路径不能为空" };
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  setProjectLocalPath(serverOrigin(), projectId, p);
  return { ok: true, path: p };
});
// 进入项目页时前端拉取：已绑则(必要时补建目录)返回 bound:true；未绑返回默认路径供弹窗预填。
ipcMain.handle("project:bind-status", async (_e, projectId: string) => {
  if (!creds) return null;
  const server = serverOrigin();
  const machineInfo = `${os.hostname()} · ${process.platform}`;
  const saved = getProjectLocalPath(server, projectId);
  if (saved) {
    if (!fs.existsSync(saved)) {
      try { fs.mkdirSync(saved, { recursive: true }); } catch { /* 前端会提示用户 */ }
    }
    return { bound: true, path: saved, machineInfo };
  }
  const projectName = await fetchProjectName(server, projectId);
  const defaultPath = join(app.getPath("desktop"), "MobiusOS", sanitizeName(projectName));
  return { bound: false, path: null, defaultPath, projectName, machineInfo };
});
ipcMain.handle("desktop:machine-info", () => `${os.hostname()} · ${process.platform}`);
// 读/写 project 的本机路径与工作模式偏好 (新建 Session 第1步 PC 任务模式区块用)
ipcMain.handle("project:get-path", (_e, projectId: string) => getProjectLocalPath(serverOrigin(), projectId));
ipcMain.handle("project:get-work-mode", (_e, projectId: string) => getProjectWorkMode(serverOrigin(), projectId));
ipcMain.handle("project:set-work-mode", (_e, projectId: string, mode: string) => {
  setProjectWorkMode(serverOrigin(), projectId, String(mode || "dual"));
  return { ok: true };
});

const LOCAL_FILE_READ_MAX_BYTES = 1.5 * 1024 * 1024;
const LOCAL_FILE_WRITE_MAX_BYTES = 5 * 1024 * 1024;

ipcMain.handle("project:list-local-files", (_e, projectId: string, rawPath: string = "/") => {
  const resolved = resolveLocalProjectPath(projectId, rawPath);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const { root, absPath, relPath } = resolved;
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isDirectory()) return { ok: false, error: "Not a directory" };
    const entries = fs.readdirSync(absPath, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => {
        const full = join(absPath, entry.name);
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { return null; }
        return {
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
          size: entry.isFile() ? st.size : null,
          modified: st.mtime,
          abs_path: full,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name));
    return { ok: true, bind_path: root, path: relPath, entries };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "Read failed" };
  }
});

ipcMain.handle("project:read-local-file", (_e, projectId: string, rawPath: string = "/") => {
  const resolved = resolveLocalProjectPath(projectId, rawPath);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const { absPath, relPath } = resolved;
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { ok: false, error: "Not a file" };
    const buf = fs.readFileSync(absPath);
    if (buf.indexOf(0) !== -1) {
      return { ok: true, path: relPath, name: basename(absPath), abs_path: absPath, size: buf.length, content: "", truncated: false, binary: true };
    }
    const truncated = buf.length > LOCAL_FILE_READ_MAX_BYTES;
    const content = (truncated ? buf.subarray(0, LOCAL_FILE_READ_MAX_BYTES) : buf).toString("utf8");
    return { ok: true, path: relPath, name: basename(absPath), abs_path: absPath, size: buf.length, content, truncated, binary: false };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "Read failed" };
  }
});

ipcMain.handle("project:write-local-file", (_e, projectId: string, rawPath: string = "/", content: string = "") => {
  const resolved = resolveLocalProjectPath(projectId, rawPath);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const { absPath, relPath } = resolved;
  if (typeof content !== "string") return { ok: false, error: "content 必须是字符串" };
  const byteLen = Buffer.byteLength(content, "utf8");
  if (byteLen > LOCAL_FILE_WRITE_MAX_BYTES) return { ok: false, error: `文件过大 (${byteLen} 字节)，超过 ${LOCAL_FILE_WRITE_MAX_BYTES} 上限` };
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { ok: false, error: "Not a file" };
    fs.writeFileSync(absPath, content, "utf8");
    return { ok: true, path: relPath, name: basename(absPath), abs_path: absPath, size: byteLen, saved: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "Write failed" };
  }
});

// —— 原生文件编辑器右键菜单: 本机下载 / 复制 / 重命名 (设计文档 §8, §13) ——
// 主进程对所有 renderer 传入路径重新校验 (resolveLocalProjectPath + lstat + 符号链接),
// renderer 的禁用态只用于体验, 不构成安全边界。错误统一带 code。
// 把 FileOpError 归一成 { ok, error, code } 返回, 与既有本机文件 IPC 形状一致 (额外加 code)。
function localFileOpError(e: unknown): { ok: false; error: string; code: string } {
  if (e instanceof FileOpError) return { ok: false, error: e.message, code: e.code };
  return { ok: false, error: (e as Error)?.message || "操作失败", code: "UNKNOWN" };
}

// 本机"下载"= 另存为: 校验源是普通文件 (拒绝符号链接) -> 系统保存对话框 -> 异步 copyFile (libuv 流式, 不进内存)。
ipcMain.handle("project:download-local-file", async (_e, projectId: string, rawPath: string = "/") => {
  const resolved = resolveLocalProjectPath(projectId, rawPath);
  if ("error" in resolved) return { ok: false, error: resolved.error, code: "OUTSIDE_ROOT" };
  const { absPath } = resolved;
  try {
    let lst: fs.Stats;
    try {
      lst = await fs.promises.lstat(absPath);
    } catch {
      return { ok: false, error: "文件不存在", code: "NOT_FOUND" };
    }
    if (lst.isSymbolicLink()) return { ok: false, error: "不支持下载符号链接", code: "SYMLINK_UNSUPPORTED" };
    if (!lst.isFile()) return { ok: false, error: "只能下载文件，目录打包下载暂不支持", code: "INVALID_NAME" };
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const saveResult = win
      ? await dialog.showSaveDialog(win, { defaultPath: basename(absPath) })
      : await dialog.showSaveDialog({ defaultPath: basename(absPath) });
    if (saveResult.canceled || !saveResult.filePath) return { ok: false, error: "已取消", code: "CANCELLED" };
    // copyFile 由 libuv 流式拷贝, 不把整文件读入 JS 堆。
    await fs.promises.copyFile(absPath, saveResult.filePath);
    return { ok: true, savedTo: saveResult.filePath };
  } catch (e) {
    return localFileOpError(e);
  }
});

// 本机复制: 源/目标均 resolveLocalProjectPath + lstat + 中间目录符号链接校验;
// 拒绝目录复制到自身/子目录; 同名返回 CONFLICT; 目录异步递归复制带上限。
ipcMain.handle("project:copy-local-entry", async (_e, projectId: string, sourcePath: string, targetDir: string) => {
  const src = resolveLocalProjectPath(projectId, sourcePath);
  if ("error" in src) return { ok: false, error: src.error, code: "OUTSIDE_ROOT" };
  const tgt = resolveLocalProjectPath(projectId, targetDir);
  if ("error" in tgt) return { ok: false, error: tgt.error, code: "OUTSIDE_ROOT" };
  const { absPath: srcAbs, root } = src;
  const { absPath: tgtAbs, relPath: tgtRel } = tgt;
  try {
    let srcLst: fs.Stats;
    try {
      srcLst = await fs.promises.lstat(srcAbs);
    } catch {
      return { ok: false, error: "源文件不存在", code: "NOT_FOUND" };
    }
    if (srcLst.isSymbolicLink()) return { ok: false, error: "不支持操作符号链接", code: "SYMLINK_UNSUPPORTED" };
    let tgtLst: fs.Stats;
    try {
      tgtLst = await fs.promises.lstat(tgtAbs);
    } catch {
      return { ok: false, error: "目标目录不存在", code: "NOT_FOUND" };
    }
    if (tgtLst.isSymbolicLink()) return { ok: false, error: "不支持操作符号链接", code: "SYMLINK_UNSUPPORTED" };
    if (!tgtLst.isDirectory()) return { ok: false, error: "目标必须是目录", code: "INVALID_NAME" };
    await assertNoSymlink(root, srcAbs);
    await assertNoSymlink(root, tgtAbs);
    try {
      await fs.promises.access(tgtAbs, fs.constants.W_OK);
    } catch {
      return { ok: false, error: "目标目录只读或无写权限", code: "READ_ONLY" };
    }
    if (srcLst.isDirectory() && isDirEqualOrChild(srcAbs, tgtAbs)) {
      return { ok: false, error: "不能将目录复制到自身或其子目录", code: "CONFLICT" };
    }
    const baseName = basename(srcAbs);
    const dstAbs = join(tgtAbs, baseName);
    try {
      await fs.promises.lstat(dstAbs);
      return { ok: false, error: "目标目录已存在同名文件或目录", code: "CONFLICT" };
    } catch {
      /* 目标不存在, 继续 */
    }
    await copyEntryRecursive(srcAbs, dstAbs);
    return { ok: true, path: (tgtRel === "/" ? "" : tgtRel) + "/" + baseName, type: srcLst.isDirectory() ? "dir" : "file" };
  } catch (e) {
    return localFileOpError(e);
  }
});

// 本机重命名: 校验 newName (单段, 无分隔符) -> 拒绝根目录 -> 符号链接 -> 同名 CONFLICT -> 父目录 W_OK -> rename。
ipcMain.handle("project:rename-local-entry", async (_e, projectId: string, rawPath: string, newNameRaw: string) => {
  const resolved = resolveLocalProjectPath(projectId, rawPath);
  if ("error" in resolved) return { ok: false, error: resolved.error, code: "OUTSIDE_ROOT" };
  const { root, relPath, absPath } = resolved;
  if (absPath === root) return { ok: false, error: "不能重命名项目根目录", code: "INVALID_NAME" };
  let newName: string;
  try {
    newName = validateNewName(newNameRaw);
  } catch (e) {
    return localFileOpError(e);
  }
  try {
    let srcLst: fs.Stats;
    try {
      srcLst = await fs.promises.lstat(absPath);
    } catch {
      return { ok: false, error: "文件不存在", code: "NOT_FOUND" };
    }
    if (srcLst.isSymbolicLink()) return { ok: false, error: "不支持操作符号链接", code: "SYMLINK_UNSUPPORTED" };
    await assertNoSymlink(root, absPath);
    const parentAbs = dirname(absPath);
    const newAbs = join(parentAbs, newName);
    if (newAbs !== root && !newAbs.startsWith(root + sep)) {
      return { ok: false, error: "新路径越出项目根目录", code: "OUTSIDE_ROOT" };
    }
    try {
      await fs.promises.lstat(newAbs);
      return { ok: false, error: "已存在同名文件或目录", code: "CONFLICT" };
    } catch {
      /* 不存在, 继续 */
    }
    try {
      await fs.promises.access(parentAbs, fs.constants.W_OK);
    } catch {
      return { ok: false, error: "目录只读或无写权限", code: "READ_ONLY" };
    }
    await fs.promises.rename(absPath, newAbs);
    const newRel = "/" + relative(root, newAbs).replace(/\\/g, "/");
    return { ok: true, oldPath: relPath, path: newRel, name: newName };
  } catch (e) {
    return localFileOpError(e);
  }
});

// 本机移动: 源/目标 resolve + lstat + 中间目录符号链接校验; 拒绝目录移到自身/子目录;
// 已在目标目录空操作; 同名 CONFLICT; 跨目录 fs.rename 即移动 (同卷原子)。
ipcMain.handle("project:move-local-entry", async (_e, projectId: string, sourcePath: string, targetDir: string) => {
  const src = resolveLocalProjectPath(projectId, sourcePath);
  if ("error" in src) return { ok: false, error: src.error, code: "OUTSIDE_ROOT" };
  const tgt = resolveLocalProjectPath(projectId, targetDir);
  if ("error" in tgt) return { ok: false, error: tgt.error, code: "OUTSIDE_ROOT" };
  const { absPath: srcAbs, relPath: srcRel, root } = src;
  const { absPath: tgtAbs, relPath: tgtRel } = tgt;
  if (srcAbs === root) return { ok: false, error: "不能移动项目根目录", code: "INVALID_NAME" };
  try {
    let srcLst: fs.Stats;
    try {
      srcLst = await fs.promises.lstat(srcAbs);
    } catch {
      return { ok: false, error: "源文件不存在", code: "NOT_FOUND" };
    }
    if (srcLst.isSymbolicLink()) return { ok: false, error: "不支持操作符号链接", code: "SYMLINK_UNSUPPORTED" };
    let tgtLst: fs.Stats;
    try {
      tgtLst = await fs.promises.lstat(tgtAbs);
    } catch {
      return { ok: false, error: "目标目录不存在", code: "NOT_FOUND" };
    }
    if (tgtLst.isSymbolicLink()) return { ok: false, error: "不支持操作符号链接", code: "SYMLINK_UNSUPPORTED" };
    if (!tgtLst.isDirectory()) return { ok: false, error: "目标必须是目录", code: "INVALID_NAME" };
    await assertNoSymlink(root, srcAbs);
    await assertNoSymlink(root, tgtAbs);
    try {
      await fs.promises.access(tgtAbs, fs.constants.W_OK);
    } catch {
      return { ok: false, error: "目标目录只读或无写权限", code: "READ_ONLY" };
    }
    if (srcLst.isDirectory() && isDirEqualOrChild(srcAbs, tgtAbs)) {
      return { ok: false, error: "不能将目录移动到自身或其子目录", code: "CONFLICT" };
    }
    const baseName = basename(srcAbs);
    const dstAbs = join(tgtAbs, baseName);
    if (dstAbs !== root && !dstAbs.startsWith(root + sep)) {
      return { ok: false, error: "新路径越出项目根目录", code: "OUTSIDE_ROOT" };
    }
    if (dirname(srcAbs) === tgtAbs) {
      const cur = "/" + relative(root, srcAbs).replace(/\\/g, "/");
      return { ok: true, oldPath: srcRel, path: cur, name: baseName };
    }
    try {
      await fs.promises.lstat(dstAbs);
      return { ok: false, error: "目标目录已存在同名文件或目录", code: "CONFLICT" };
    } catch {
      /* 目标不存在, 继续 */
    }
    await fs.promises.rename(srcAbs, dstAbs);
    const newPath = (tgtRel === "/" ? "" : tgtRel) + "/" + baseName;
    return { ok: true, oldPath: srcRel, path: newPath, name: baseName };
  } catch (e) {
    return localFileOpError(e);
  }
});

// ——— 生命周期 ———
// 单实例锁：避免重复启动多个进程（每个都会反连注册同一节点，造成 4 个进程 / 节点冲突）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    aimuxEnabled = getAimuxEnabled();
    buildMenu();
    createWindow();

    // 启动恢复：有保存的凭据就静默重登直进；否则进登录页
    // serverUrl 从纯文本 server-url.json 读取（不在加密文件中）
    const saved = loadCreds();
    let savedUrl = loadServerUrl();
    if (!savedUrl) {
      savedUrl = loadServerFromOldCreds(); // 迁移：旧格式 URL 在 secrets.enc 里
      if (savedUrl) saveServerUrl(savedUrl);
    }
    if (savedUrl) serverUrl = savedUrl;
    if (saved && serverUrl) {
      const r = await doLogin(serverUrl, saved.username, saved.password);
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
}

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});

// 退出前务必杀 aimux（Windows taskkill /T 连进程树）
app.on("before-quit", () => {
  cancelAutoAimuxUpdateCheck();
  persistTabs(); // 兜底：退出前再存一次当前 tab 列表。
  tabManager?.destroyAll();
  void stopAllPortForwards();
  void supervisor?.stop();
});
