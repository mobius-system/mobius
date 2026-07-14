import { safeStorage, app, BrowserWindow, ipcMain, Menu, shell, dialog } from "electron";
import * as path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
function file() {
  return path.join(app.getPath("userData"), "secrets.enc");
}
function loadCreds() {
  try {
    const buf = fs.readFileSync(file());
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString("utf8");
    const data = JSON.parse(json);
    if (!data || !data.server || !data.jwt) return null;
    return data;
  } catch {
    return null;
  }
}
function saveCreds(c) {
  const json = JSON.stringify(c);
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, "utf8");
  try {
    fs.writeFileSync(file(), buf, { mode: 384 });
  } catch (e) {
    console.error("[secrets] 写入失败:", e);
  }
}
function clearCreds() {
  try {
    fs.unlinkSync(file());
  } catch {
  }
}
function gatherHostInfo(opts) {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) ips.push(net.address);
    }
  }
  const cpus = os.cpus();
  return {
    platform: process.platform,
    osVersion: os.release(),
    arch: process.arch,
    hostname: os.hostname(),
    ips,
    cpuModel: cpus[0]?.model || "unknown",
    cpuCount: cpus.length,
    totalMemGB: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10,
    aimuxIdentifier: opts.aimuxIdentifier,
    serverOrigin: opts.serverOrigin,
    appVersion: opts.appVersion,
    desktopPath: app.getPath("desktop")
  };
}
const AIMUX_PIN = "aimux";
const WIN = process.platform === "win32";
function bundledPythonExe() {
  const candidates = WIN ? [
    path.join(process.resourcesPath, "python", "python.exe"),
    path.join(process.resourcesPath, "python", "python", "python.exe")
  ] : [
    path.join(process.resourcesPath, "python", "bin", "python3"),
    path.join(process.resourcesPath, "python", "python", "bin", "python3")
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}
function hasBundledPython() {
  return !!bundledPythonExe();
}
function pythonExe() {
  return bundledPythonExe() || (WIN ? "python.exe" : "python3");
}
const venvDir = () => path.join(app.getPath("userData"), "aimux-venv");
const venvPython = () => WIN ? path.join(venvDir(), "Scripts", "python.exe") : path.join(venvDir(), "bin", "python");
function aimuxExe() {
  return WIN ? path.join(venvDir(), "Scripts", "aimux.exe") : path.join(venvDir(), "bin", "aimux");
}
function run(cmd, args, onLine, onRaw) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const feed = (b, sink) => {
      const s = b.toString("utf8");
      sink(s);
      onRaw?.(s);
      if (onLine) {
        for (const seg of s.split(/[\r\n]+/)) {
          const t = seg.trim();
          if (t) onLine(t);
        }
      }
    };
    child.stdout.on("data", (b) => feed(b, (x) => stdout += x));
    child.stderr.on("data", (b) => feed(b, (x) => stderr += x));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}
async function ensureAimux(onProgress, onRaw) {
  if (fs.existsSync(aimuxExe())) {
    onProgress?.({ phase: "ready" });
    return { ok: true };
  }
  const py = pythonExe();
  onProgress?.({ phase: "venv", detail: py });
  let r = await run(py, ["-m", "venv", venvDir()], void 0, onRaw);
  if (r.code !== 0) return { ok: false, error: `venv 创建失败: ${r.stderr || r.stdout}` };
  onProgress?.({ phase: "install", detail: `下载并安装 ${AIMUX_PIN}…` });
  r = await run(
    venvPython(),
    ["-m", "pip", "install", "--no-input", "--disable-pip-version-check", AIMUX_PIN],
    (line) => {
      if (/downloading|collecting|installing|using cached|%\s*\d|━|─/i.test(line)) {
        onProgress?.({ phase: "install", detail: line.slice(0, 100) });
      }
    },
    onRaw
  );
  if (r.code !== 0) return { ok: false, error: `pip install 失败: ${r.stderr || r.stdout}` };
  if (!fs.existsSync(aimuxExe())) return { ok: false, error: `aimux 可执行未生成: ${aimuxExe()}` };
  onProgress?.({ phase: "ready" });
  return { ok: true };
}
async function getAimuxVersion() {
  if (!fs.existsSync(venvPython())) return "未安装";
  const r = await run(venvPython(), ["-m", "pip", "show", "aimux"]);
  const m = r.stdout.match(/Version:\s*(\S+)/);
  return m ? m[1] : "未知";
}
async function upgradeAimux(onProgress, onRaw) {
  if (!fs.existsSync(venvPython())) return { ok: false, error: "venv 尚未创建" };
  onProgress?.({ phase: "install", detail: "pip install --upgrade aimux…" });
  const r = await run(
    venvPython(),
    ["-m", "pip", "install", "--no-input", "--disable-pip-version-check", "--upgrade", "aimux"],
    (line) => {
      if (/downloading|collecting|installing|using cached|uninstalling|successfully|%\s*\d|━|─/i.test(line)) {
        onProgress?.({ phase: "install", detail: line.slice(0, 100) });
      }
    },
    onRaw
  );
  if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
  const show = await run(venvPython(), ["-m", "pip", "show", "aimux"]);
  const m = show.stdout.match(/Version:\s*(\S+)/);
  onProgress?.({ phase: "ready" });
  return { ok: true, version: m ? m[1] : "unknown" };
}
function aimuxLogPath() {
  return path.join(app.getPath("userData"), "logs", "aimux.log");
}
function appendAimuxLog(data) {
  const logPath = aimuxLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, data);
  } catch (e) {
    console.error(`[aimux-supervisor] 写 aimux 日志失败 (${logPath}):`, e);
  }
}
class AimuxSupervisor {
  child = null;
  stopping = false;
  respawnTimer = null;
  refreshTimer = null;
  opts;
  constructor(opts) {
    this.opts = opts;
  }
  start() {
    this.stopping = false;
    this.spawnChild();
    this.scheduleTokenRefresh();
  }
  spawnChild() {
    const { aimuxExe: aimuxExe2, bridgeUrl, token, identifier, onStatus } = this.opts;
    onStatus({ state: "starting", detail: "正在连接 mobius…", identifier });
    appendAimuxLog(`
==== [${(/* @__PURE__ */ new Date()).toISOString()}] spawn reverse connect identifier=${identifier} ====
`);
    const child = spawn(aimuxExe2, ["reverse", "connect", bridgeUrl, "--identifier", identifier, "--token", token, "--replace"]);
    this.child = child;
    const classify = (line) => {
      this.opts.onLog?.(line);
      const lower = line.toLowerCase();
      // 命令级噪声（命令崩溃首行 + 整段 Python traceback）与 bridge 连接无关 —— bridge 仍连着，不改连接状态。
      // 旧版宽泛正则 /error|fail|traceback|exception/ 会把这些行误判成 failed（"诊断太敏感"根因）。
      if (/command (crashed|failed)|request_id=/.test(lower) || /traceback \(most recent call last\)/.test(lower) || /^file ".+", line \d+, in /.test(lower) || /^\[failed\]/.test(lower)) return;
      // 仅连接级故障才算 failed（持久性失败由 child.exit 兜底）；通用 error/fail 不再触发。
      if (/connection (refused|reset|closed|error)|connect.*failed|failed to connect|unauthorized|forbidden|\b40[13]\b|token.*(expired|invalid)|jwt.*(expired|invalid)|reconnect.*(failed|exhaust|gave up|giving up)|max retries exceeded/.test(lower)) {
        onStatus({ state: "failed", detail: line, identifier });
        return;
      }
      if (/connected|registered|event stream|heartbeat|\bsse\b/.test(lower)) {
        onStatus({ state: "connected", detail: line, identifier });
      }
    };
    const handle = (b) => {
      appendAimuxLog(b);
      for (const l of b.toString("utf8").split(/[\r\n]+/)) {
        const t = l.trim();
        if (t) classify(t);
      }
    };
    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);
    child.on("exit", (code) => {
      this.child = null;
      appendAimuxLog(`
---- [${(/* @__PURE__ */ new Date()).toISOString()}] child exited code=${code} ----
`);
      if (this.stopping) {
        this.opts.onStatus({ state: "stopped", identifier });
        return;
      }
      this.opts.onStatus({ state: "failed", detail: `aimux 退出 code=${code}，5s 后重启`, identifier });
      this.respawnTimer = setTimeout(() => {
        if (!this.stopping) this.spawnChild();
      }, 5e3);
    });
    child.on("error", (err) => {
      appendAimuxLog(`
---- [${(/* @__PURE__ */ new Date()).toISOString()}] spawn error: ${err.message} ----
`);
      this.opts.onStatus({ state: "failed", detail: `spawn 失败: ${err.message}`, identifier });
    });
  }
  /** 用新 token 重启（JWT 续期后调用）。 */
  async restartWithToken(token) {
    this.opts = { ...this.opts, token };
    await this.killChild();
    if (!this.stopping) this.spawnChild();
  }
  /** 解析 JWT exp，提前 10 分钟触发续期。 */
  scheduleTokenRefresh() {
    try {
      const payload = JSON.parse(Buffer.from(this.opts.token.split(".")[1], "base64").toString("utf8"));
      const expMs = (payload.exp || 0) * 1e3;
      const refreshAt = expMs - 10 * 60 * 1e3;
      const delay = Math.max(6e4, refreshAt - Date.now());
      this.refreshTimer = setTimeout(() => void this.refreshToken(), delay);
    } catch {
    }
  }
  async refreshToken() {
    if (this.stopping) return;
    const newToken = await this.opts.onTokenExpired();
    if (newToken) {
      await this.restartWithToken(newToken);
      this.scheduleTokenRefresh();
    }
  }
  async killChild() {
    const child = this.child;
    if (!child?.pid) {
      this.child = null;
      return;
    }
    if (process.platform === "win32") {
      await new Promise((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          detached: true,
          stdio: "ignore"
        });
        killer.on("close", () => resolve());
        killer.on("error", () => resolve());
        killer.unref();
      });
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
      }
    }
    this.child = null;
  }
  /** 应用退出前必须调用：杀进程 + 清定时器，避免 aimux 残留继续连服务器。 */
  async stop() {
    this.stopping = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await this.killChild();
    this.opts.onStatus({ state: "stopped", identifier: this.opts.identifier });
  }
}
const FILE$1 = () => path.join(app.getPath("userData"), "project-paths.json");
function read$1() {
  try {
    return JSON.parse(fs.readFileSync(FILE$1(), "utf8"));
  } catch {
    return {};
  }
}
function write$1(store) {
  try {
    fs.writeFileSync(FILE$1(), JSON.stringify(store, null, 2), { mode: 384 });
  } catch (e) {
    console.error("[project-paths] 写入失败:", e);
  }
}
const key = (server, projectId) => `${server}::${projectId}`;
function getProjectLocalPath(server, projectId) {
  return read$1()[key(server, projectId)]?.path || null;
}
function setProjectLocalPath(server, projectId, p) {
  const store = read$1();
  const k = key(server, projectId);
  store[k] = { ...store[k], path: p, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  write$1(store);
}
function getProjectWorkMode(server, projectId) {
  return read$1()[key(server, projectId)]?.workMode || null;
}
function setProjectWorkMode(server, projectId, mode) {
  const store = read$1();
  const k = key(server, projectId);
  store[k] = { ...store[k], workMode: mode, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  write$1(store);
}
function sanitizeName(name) {
  const s = name.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").trim();
  return s || "project";
}
const FILE = () => path.join(app.getPath("userData"), "desktop-settings.json");
function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), "utf8"));
  } catch {
    return {};
  }
}
function write(store) {
  try {
    fs.writeFileSync(FILE(), JSON.stringify(store, null, 2), { mode: 384 });
  } catch (e) {
    console.error("[desktop-settings] 写入失败:", e);
  }
}
function getAimuxEnabled() {
  return read().aimuxEnabled !== false;
}
function setAimuxEnabled(enabled) {
  write({ ...read(), aimuxEnabled: enabled, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
}
const routeKey = (server, username) => `${server}::${username}`;
function getLastRoute(server, username) {
  return read().lastRoutes?.[routeKey(server, username)] || null;
}
function setLastRoute(server, username, route) {
  const store = read();
  if (!store.lastRoutes) store.lastRoutes = {};
  store.lastRoutes[routeKey(server, username)] = route;
  store.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  write(store);
}
const currentDir$1 = dirname(fileURLToPath(import.meta.url));
let statusWindow = null;
function createStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.focus();
    return;
  }
  statusWindow = new BrowserWindow({
    width: 680,
    height: 720,
    title: "Mobius Desktop · aimux 状态",
    autoHideMenuBar: true,
    backgroundColor: "#f5f5f7",
    webPreferences: {
      preload: join(currentDir$1, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  void statusWindow.loadFile(join(currentDir$1, "../renderer/status.html"));
  statusWindow.on("closed", () => {
    statusWindow = null;
  });
}
const currentDir = dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === "darwin";
let mainWindow = null;
let supervisor = null;
let creds = null;
let lastStatus = { state: "stopped" };
let installing = false;
let aimuxEnabled = true;
const LOG_MAX = 300;
const logBuffer = [];
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send(channel, payload);
      } catch {
      }
    }
  }
}
function appendLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > LOG_MAX) logBuffer.splice(0, logBuffer.length - LOG_MAX);
  broadcast("aimux:log", line);
}
function serverOrigin() {
  return (creds?.server || "").replace(/\/$/, "");
}
function defaultIdentifier() {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return `desktop-${host || "pc"}`;
}
async function fetchProjectName(server, projectId) {
  if (!creds) return projectId;
  try {
    const res = await fetch(`${server}/api/projects`, { headers: { Authorization: `Bearer ${creds.jwt}` } });
    if (!res.ok) return projectId;
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.projects || [];
    const p = list.find((x) => x.id === projectId);
    return p?.name || projectId;
  } catch {
    return projectId;
  }
}
function emitStatus(s) {
  lastStatus = s;
  broadcast("aimux:status-changed", s);
  if (s.detail) appendLog(`[${s.state}] ${s.detail}`);
}
async function doLogin(serverRaw, username, password) {
  const server = serverRaw.replace(/\/$/, "");
  if (!/^https?:\/\//.test(server)) {
    return { error: "服务 URL 需以 http:// 或 https:// 开头" };
  }
  try {
    const res = await fetch(`${server}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { error: `登录失败 (${res.status}): ${t.slice(0, 200)}` };
    }
    const data = await res.json();
    const token = data.token || data.jwt || data.access_token;
    const user = data.user || data;
    if (!token) return { error: "登录响应缺少 token" };
    const identifier = creds?.identifier || defaultIdentifier();
    return { server, username, password, jwt: token, user, identifier };
  } catch (e) {
    return { error: `登录请求失败: ${e.message}` };
  }
}
function buildSupervisor() {
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
    onTokenExpired: async () => {
      if (!creds) return null;
      const r = await doLogin(creds.server, creds.username, creds.password);
      if ("error" in r) return null;
      creds.jwt = r.jwt;
      saveCreds(creds);
      return r.jwt;
    }
  });
}
async function seedWebAuth(origin, jwt) {
  return new Promise((resolve) => {
    const seed = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        seed.destroy();
      } catch {
      }
      resolve();
    };
    seed.webContents.once("dom-ready", async () => {
      try {
        await seed.webContents.executeJavaScript(
          `try { localStorage.setItem('cc-token', ${JSON.stringify(jwt)}); } catch (e) {} true`
        );
      } catch {
      }
      finish();
    });
    seed.loadURL(`${origin}/`).catch(finish);
    setTimeout(finish, 5e3);
  });
}
async function startAimuxConnection() {
  if (!creds || installing) return;
  installing = true;
  emitStatus({ state: "starting", detail: "首次启动需在本机下载 aimux（联网，约 30-90 秒）…" });
  appendAimuxLog(`
==== [${(/* @__PURE__ */ new Date()).toISOString()}] ensure aimux (install) ====
`);
  const inst = await ensureAimux(
    (p) => {
      if (p.phase === "venv") emitStatus({ state: "starting", detail: "创建 Python 虚拟环境…" });
      else if (p.phase === "install") emitStatus({ state: "starting", detail: `下载并安装 aimux… ${p.detail ?? ""}` });
    },
    (data) => appendAimuxLog(data)
  );
  installing = false;
  if (!inst.ok) {
    emitStatus({ state: "failed", detail: inst.error });
    return;
  }
  if (!aimuxEnabled) return;
  emitStatus({ state: "starting", detail: "aimux 就绪，正在反向连接 mobius…" });
  supervisor = buildSupervisor();
  supervisor?.start();
}
async function bootDesktop() {
  if (!mainWindow || !creds) return;
  const server = serverOrigin();
  if (aimuxEnabled) {
    await startAimuxConnection();
    emitStatus({ state: lastStatus.state, detail: "正在登录工作台…" });
  } else {
    emitStatus({ state: "disabled", detail: "aimux 连接已关闭（可在 aimux 状态面板开启）" });
    appendAimuxLog(`
==== [${(/* @__PURE__ */ new Date()).toISOString()}] aimux disabled by user, skip reverse connect ====
`);
  }
  await seedWebAuth(server, creds.jwt);
  void mainWindow.loadURL(`${server}/welcome`);
}
function persistLastRoute() {
  if (!mainWindow || !creds) return;
  const origin = serverOrigin();
  if (!origin) return;
  try {
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed()) return;
    const raw = wc.getURL();
    if (!raw || !raw.startsWith(origin)) return;
    const path2 = new URL(raw).pathname + new URL(raw).search + new URL(raw).hash;
    const homePrefix = `/u/${encodeURIComponent(creds.username)}`;
    if (!path2.startsWith(homePrefix)) return;
    setLastRoute(origin, creds.username, path2);
  } catch {
  }
}
function runSyncReload() {
  mainWindow?.webContents.reloadIgnoringCache();
}
async function runUpdateAimux() {
  if (installing) return { ok: false, error: "正在安装中，请稍候" };
  emitStatus({ state: "starting", detail: "断开现有连接, 准备更新 aimux…" });
  await supervisor?.stop();
  supervisor = null;
  emitStatus({ state: "starting", detail: "正在更新 aimux…" });
  appendAimuxLog(`
==== [${(/* @__PURE__ */ new Date()).toISOString()}] upgrade aimux ====
`);
  const r = await upgradeAimux(
    (p) => {
      if (p.detail) {
        appendLog(p.detail);
        emitStatus({ state: "starting", detail: p.detail });
      }
    },
    (data) => appendAimuxLog(data)
  );
  if (!r.ok) {
    emitStatus({ state: "failed", detail: r.error });
    return { ok: false, error: r.error };
  }
  if (aimuxEnabled) {
    emitStatus({ state: "starting", detail: `aimux ${r.version} 已就绪, 正在反向连接…` });
    supervisor = buildSupervisor();
    supervisor?.start();
  } else {
    emitStatus({ state: "disabled", detail: `aimux ${r.version} 已更新（连接已关闭）` });
  }
  return { ok: true, version: r.version };
}
async function runLogout() {
  await supervisor?.stop();
  supervisor = null;
  clearCreds();
  creds = null;
  mainWindow?.loadFile(join(currentDir, "../renderer/index.html"));
}
async function applyAimuxEnabled(enabled) {
  aimuxEnabled = enabled;
  setAimuxEnabled(enabled);
  if (!enabled) {
    await supervisor?.stop();
    supervisor = null;
    emitStatus({ state: "disabled", detail: "aimux 连接已关闭" });
    appendAimuxLog(`
==== [${(/* @__PURE__ */ new Date()).toISOString()}] aimux disabled by user ====
`);
  } else if (creds && mainWindow) {
    if (installing) {
      emitStatus({ state: "starting", detail: "aimux 安装中，完成后将自动连接…" });
    } else {
      await startAimuxConnection();
    }
  }
  updateMenuChecked();
}
function updateMenuChecked() {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  for (const top of menu.items) {
    const sub = top.submenu;
    if (!sub) continue;
    for (const it of sub.items) {
      if (it.label === "允许 aimux 反向连接") {
        it.checked = aimuxEnabled;
        return;
      }
    }
  }
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 960,
    minWidth: 1040,
    minHeight: 760,
    show: false,
    backgroundColor: "#ffffff",
    title: "Mobius Desktop",
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
      webSecurity: true
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("maximize", () => broadcast("window:maximize-changed", true));
  mainWindow.on("unmaximize", () => broadcast("window:maximize-changed", false));
  mainWindow.on("will-resize", (event, newBounds) => {
    if (newBounds.width < newBounds.height) {
      event.preventDefault();
      mainWindow?.setBounds({ ...newBounds, height: newBounds.width });
    }
  });
  mainWindow.webContents.on("will-navigate", (_e, url) => {
    if (url.startsWith("file://")) return;
    const origin = serverOrigin();
    if (origin && !url.startsWith(origin)) _e.preventDefault();
  });
  mainWindow.webContents.on("before-input-event", (_e, input) => {
    if (input.type !== "keyDown" || input.key !== "F12") return;
    _e.preventDefault();
    const wc = mainWindow?.webContents;
    if (!wc) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: "detach" });
  });
  mainWindow.on("close", () => persistLastRoute());
}
function buildMenu() {
  const tpl = [
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
            if (installing) {
              mi.checked = aimuxEnabled;
              return;
            }
            void applyAimuxEnabled(mi.checked);
          }
        },
        { type: "separator" },
        { label: "切换账号 / 服务器", click: () => void runLogout() },
        { role: "quit", label: "退出" }
      ]
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
        { role: "selectAll", label: "全选" }
      ]
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
        { role: "zoomOut", label: "缩小" }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}
ipcMain.handle("auth:login", async (_e, c) => {
  const r = await doLogin(c.server, c.username, c.password);
  if ("error" in r) return { ok: false, error: r.error };
  creds = r;
  saveCreds(creds);
  void bootDesktop();
  return { ok: true };
});
ipcMain.handle("auth:get-last-server", () => creds?.server || "");
ipcMain.handle("auth:logout", () => {
  void runLogout();
  return { ok: true };
});
ipcMain.handle(
  "desktop:boot-data",
  () => gatherHostInfo({ aimuxIdentifier: creds?.identifier || "", serverOrigin: serverOrigin(), appVersion: app.getVersion() })
);
ipcMain.handle("desktop:get-last-route", () => {
  if (!creds) return null;
  const saved = getLastRoute(serverOrigin(), creds.username);
  if (!saved) return null;
  const homePath = `/u/${encodeURIComponent(creds.username)}`;
  return saved.startsWith(homePath) ? saved : null;
});
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
  logs: [...logBuffer]
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
ipcMain.handle("aimux:get-enabled", () => aimuxEnabled);
ipcMain.handle("aimux:set-enabled", async (_e, enabled) => {
  if (installing) return { ok: false, error: "正在安装 aimux，请稍候" };
  await applyAimuxEnabled(Boolean(enabled));
  return { ok: true, enabled: aimuxEnabled };
});
ipcMain.handle("app:open-status", () => {
  createStatusWindow();
  return { ok: true };
});
ipcMain.handle("app:open-devtools", () => {
  mainWindow?.webContents.openDevTools({ mode: "detach" });
  return { ok: true };
});
ipcMain.handle("desktop:set-title-bar-overlay", (_e, opts) => {
  if (isMac) return { ok: true };
  try {
    mainWindow?.setTitleBarOverlay(opts);
  } catch {
  }
  return { ok: true };
});
ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
  return { ok: true };
});
ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) return { ok: true, maximized: false };
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return { ok: true, maximized: false };
  }
  mainWindow.maximize();
  return { ok: true, maximized: true };
});
ipcMain.handle("window:close", () => {
  mainWindow?.close();
  return { ok: true };
});
ipcMain.handle("window:is-maximized", () => !!mainWindow?.isMaximized());
ipcMain.handle("project:pick-directory", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});
ipcMain.handle("project:confirm-path", async (_e, projectId, pathRaw) => {
  if (!mainWindow || !creds) return { ok: false, error: "未登录" };
  const p = String(pathRaw || "").trim();
  if (!p) return { ok: false, error: "路径不能为空" };
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  setProjectLocalPath(serverOrigin(), projectId, p);
  return { ok: true, path: p };
});
ipcMain.handle("project:bind-status", async (_e, projectId) => {
  if (!creds) return null;
  const server = serverOrigin();
  const machineInfo = `${os.hostname()} · ${process.platform}`;
  const saved = getProjectLocalPath(server, projectId);
  if (saved) {
    if (!fs.existsSync(saved)) {
      try {
        fs.mkdirSync(saved, { recursive: true });
      } catch {
      }
    }
    return { bound: true, path: saved, machineInfo };
  }
  const projectName = await fetchProjectName(server, projectId);
  const defaultPath = join(app.getPath("desktop"), "MobiusOS", sanitizeName(projectName));
  return { bound: false, path: null, defaultPath, projectName, machineInfo };
});
ipcMain.handle("desktop:machine-info", () => `${os.hostname()} · ${process.platform}`);
ipcMain.handle("project:get-path", (_e, projectId) => getProjectLocalPath(serverOrigin(), projectId));
ipcMain.handle("project:get-work-mode", (_e, projectId) => getProjectWorkMode(serverOrigin(), projectId));
ipcMain.handle("project:set-work-mode", (_e, projectId, mode) => {
  setProjectWorkMode(serverOrigin(), projectId, String(mode || "dual"));
  return { ok: true };
});
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
}
app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});
app.on("before-quit", () => {
  persistLastRoute();
  void supervisor?.stop();
});
