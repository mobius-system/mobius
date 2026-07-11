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
    appVersion: opts.appVersion
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
      if (/command failed|request_id=/.test(lower)) return;
      if (/error|fail|refused|expired|invalid|traceback|exception/.test(lower)) {
        onStatus({ state: "failed", detail: line, identifier });
      } else if (/connected|registered|event stream|sse/i.test(lower)) {
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
const BADGE_ID = "__mobius_desktop_status_badge__";
const POS_KEY = "__mobius_desktop_badge_pos__";
const CSS$1 = `
#${BADGE_ID} {
  position: fixed; left: 10px; top: 10px; z-index: 2147483647;
  font: 12px/1.4 -apple-system, "Segoe UI", Roboto, "PingFang SC", sans-serif;
  padding: 5px 10px; border-radius: 14px; color: #fff;
  background: rgba(40,40,40,0.92); box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  display: flex; align-items: center; gap: 6px; pointer-events: auto; cursor: grab; user-select: none;
  -webkit-user-drag: none; touch-action: none;
}
#${BADGE_ID}.dragging { cursor: grabbing; opacity: 0.92; }
#${BADGE_ID}:hover { background: rgba(20,20,20,0.95); }
#${BADGE_ID} .dot { width: 8px; height: 8px; border-radius: 50%; background: #999; }
#${BADGE_ID}.s-starting .dot { background: #f5a623; animation: __md_pulse 1s infinite; }
#${BADGE_ID}.s-connected .dot { background: #34c759; }
#${BADGE_ID}.s-failed   .dot { background: #ff3b30; }
#${BADGE_ID}.s-stopped  .dot { background: #999; }
@keyframes __md_pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
`;
const TEXT = {
  starting: "aimux 连接中…",
  connected: "aimux 已连接",
  failed: "aimux 断开",
  stopped: "aimux 已断开"
};
async function injectBadge(wc) {
  try {
    await wc.insertCSS(CSS$1, { cssOrigin: "user" });
    await wc.executeJavaScript(`
      (() => {
        if (document.getElementById('${BADGE_ID}')) return;
        const el = document.createElement('div');
        el.id = '${BADGE_ID}';
        el.className = 's-starting';
        el.title = '点击查看 aimux 详情；按住可拖动到任意位置';
        el.innerHTML = '<span class="dot"></span><span class="txt">${TEXT.starting}</span>';
        document.documentElement.appendChild(el);

        // —— 位置：localStorage 持久化，缺省顶部居中；始终 clamp 不出视口 ——
        function setPos(x, y) {
          const w = el.offsetWidth || 120, h = el.offsetHeight || 28;
          const mx = Math.max(0, window.innerWidth - w);
          const my = Math.max(0, window.innerHeight - h);
          el.style.left = Math.min(Math.max(0, x), mx) + 'px';
          el.style.top  = Math.min(Math.max(0, y), my) + 'px';
        }
        function getPos() { return [parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0]; }

        let saved = null;
        try { saved = JSON.parse(localStorage.getItem('${POS_KEY}') || 'null'); } catch (e) {}
        if (saved && Array.isArray(saved) && saved.length === 2 && typeof saved[0] === 'number') {
          setPos(saved[0], saved[1]);
        } else {
          setPos((window.innerWidth - (el.offsetWidth || 120)) / 2, 10);
        }
        window.addEventListener('resize', () => { const p = getPos(); setPos(p[0], p[1]); });

        // —— 拖拽（pointer events 统一鼠标/触屏；setPointerCapture 让指针离开元素仍跟随）——
        let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
        el.addEventListener('pointerdown', (e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          dragging = true; moved = false;
          sx = e.clientX; sy = e.clientY; const p = getPos(); ox = p[0]; oy = p[1];
          el.classList.add('dragging');
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
          e.preventDefault();
        });
        el.addEventListener('pointermove', (e) => {
          if (!dragging) return;
          const dx = e.clientX - sx, dy = e.clientY - sy;
          if (!moved && Math.hypot(dx, dy) < 4) return; // 小位移视作点击
          moved = true;
          setPos(ox + dx, oy + dy);
        });
        function endDrag(e) {
          if (!dragging) return;
          dragging = false;
          el.classList.remove('dragging');
          try { el.releasePointerCapture(e.pointerId); } catch (err) {}
          if (moved) { const p = getPos(); try { localStorage.setItem('${POS_KEY}', JSON.stringify(p)); } catch (err) {} }
        }
        el.addEventListener('pointerup', endDrag);
        el.addEventListener('pointercancel', endDrag);

        // —— 点击（非拖拽）打开状态面板 ——
        el.addEventListener('click', (e) => {
          if (moved) { e.preventDefault(); e.stopPropagation(); return; }
          try { window.mobiusDesktop && window.mobiusDesktop.openStatusPanel && window.mobiusDesktop.openStatusPanel(); } catch (err) {}
        });
      })();
      true;
    `);
  } catch {
  }
}
async function setBadge(wc, state, detail) {
  const text = detail ? `aimux: ${state}` : TEXT[state];
  try {
    await wc.executeJavaScript(`
      (() => {
        const el = document.getElementById('${BADGE_ID}');
        if (!el) return;
        el.classList.remove('s-starting','s-connected','s-failed','s-stopped');
        el.classList.add('s-' + ${JSON.stringify(state)}); // 保留 dragging 类
        const txt = el.querySelector('.txt'); if (txt) txt.textContent = ${JSON.stringify(text)};
      })();
      true;
    `);
  } catch {
  }
}
const OVERLAY_ID = "__mobius_project_path_overlay__";
const TOAST_ID = "__mobius_desktop_toast__";
const CSS = `
#${OVERLAY_ID} { position: fixed; inset: 0; z-index: 2147483646; }
#${OVERLAY_ID} .mdpp-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; }
#${OVERLAY_ID} .mdpp-card { width: 460px; max-width: calc(100vw - 40px); background: #fff; border-radius: 14px; padding: 22px 24px; box-shadow: 0 12px 40px rgba(0,0,0,0.25); font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", sans-serif; color: #1d1d1f; }
#${OVERLAY_ID} h3 { margin: 0 0 10px; font-size: 16px; }
#${OVERLAY_ID} .mdpp-msg { margin: 0 0 14px; font-size: 13px; color: #6e6e73; }
#${OVERLAY_ID} label { display: block; font-size: 12px; color: #8e8e93; margin-bottom: 6px; }
#${OVERLAY_ID} .mdpp-row { display: flex; gap: 8px; }
#${OVERLAY_ID} .mdpp-row input { flex: 1; padding: 9px 11px; border: 1px solid #d2d2d7; border-radius: 8px; font-size: 13px; outline: none; }
#${OVERLAY_ID} .mdpp-row input:focus { border-color: #0a84ff; }
#${OVERLAY_ID} .mdpp-row button { padding: 0 14px; border: 1px solid #d2d2d7; background: #f5f5f7; border-radius: 8px; font-size: 13px; cursor: pointer; }
#${OVERLAY_ID} .mdpp-actions { margin-top: 16px; display: flex; justify-content: flex-end; }
#${OVERLAY_ID} .mdpp-primary { padding: 9px 20px; border: none; border-radius: 9px; background: #0a84ff; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
#${OVERLAY_ID} .mdpp-primary:disabled { opacity: 0.6; cursor: default; }
#${TOAST_ID} { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%); z-index: 2147483647; padding: 10px 18px; border-radius: 10px; font: 13px/1.4 -apple-system, "Segoe UI", "PingFang SC", sans-serif; color: #fff; background: rgba(40,40,40,0.94); box-shadow: 0 4px 16px rgba(0,0,0,0.25); transition: opacity 0.3s; opacity: 0; pointer-events: none; max-width: calc(100vw - 40px); }
#${TOAST_ID}.ok { background: rgba(48,138,76,0.96); }
#${TOAST_ID}.err { background: rgba(209,72,54,0.96); }
`;
async function injectProjectPathOverlay(wc, opts) {
  try {
    await wc.insertCSS(CSS, { cssOrigin: "user" });
    const script = `
(function(){
  if (document.getElementById(${JSON.stringify(OVERLAY_ID)})) return;
  var o = ${JSON.stringify(opts)};
  var root = document.createElement('div'); root.id = ${JSON.stringify(OVERLAY_ID)};
  var back = document.createElement('div'); back.className = 'mdpp-backdrop';
  var card = document.createElement('div'); card.className = 'mdpp-card';
  var h = document.createElement('h3'); h.textContent = '绑定本地工作路径';
  var p = document.createElement('p'); p.className = 'mdpp-msg';
  p.textContent = '本项目「' + o.projectName + '」还没有绑定这台机器（' + o.machineInfo + '）的本地工作路径。您必须选择一个本地路径才能继续。';
  var lab = document.createElement('label'); lab.textContent = '本地路径';
  var row = document.createElement('div'); row.className = 'mdpp-row';
  var input = document.createElement('input'); input.type = 'text'; input.value = o.defaultPath; input.style.width = '100%';
  var browse = document.createElement('button'); browse.textContent = '浏览…';
  var actions = document.createElement('div'); actions.className = 'mdpp-actions';
  var confirm = document.createElement('button'); confirm.className = 'mdpp-primary'; confirm.textContent = '确认绑定';
  row.appendChild(input); row.appendChild(browse);
  actions.appendChild(confirm);
  card.appendChild(h); card.appendChild(p); card.appendChild(lab); card.appendChild(row); card.appendChild(actions);
  back.appendChild(card); root.appendChild(back); document.documentElement.appendChild(root);
  input.focus(); input.select();
  browse.onclick = async function () {
    var d = await window.mobiusDesktop.pickDirectory();
    if (d) input.value = d;
  };
  confirm.onclick = async function () {
    confirm.disabled = true; confirm.textContent = '处理中…';
    var r = await window.mobiusDesktop.confirmProjectPath(o.projectId, input.value);
    if (!r || !r.ok) { confirm.disabled = false; confirm.textContent = '确认绑定'; alert((r && r.error) || '绑定失败'); }
  };
})();
true;`;
    await wc.executeJavaScript(script);
  } catch (e) {
    console.error("[project-overlay] 注入失败:", e);
  }
}
async function dismissOverlay(wc) {
  try {
    await wc.executeJavaScript(`var e=document.getElementById(${JSON.stringify(OVERLAY_ID)}); if(e) e.remove(); true;`);
  } catch {
  }
}
async function injectToast(wc, msg, type) {
  try {
    await wc.executeJavaScript(`
(function(){
  var id = ${JSON.stringify(TOAST_ID)};
  var t = document.getElementById(id);
  if (!t) { t = document.createElement('div'); t.id = id; document.documentElement.appendChild(t); }
  t.className = ${JSON.stringify(type)};
  t.textContent = ${JSON.stringify(msg)};
  t.style.opacity = '1';
  clearTimeout(t.__h);
  t.__h = setTimeout(function(){ t.style.opacity = '0'; }, 3600);
})();
true;`);
  } catch {
  }
}
const FILE = () => path.join(app.getPath("userData"), "project-paths.json");
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
    console.error("[project-paths] 写入失败:", e);
  }
}
const key = (server, projectId) => `${server}::${projectId}`;
function getProjectLocalPath(server, projectId) {
  return read()[key(server, projectId)]?.path || null;
}
function setProjectLocalPath(server, projectId, p) {
  const store = read();
  const k = key(server, projectId);
  store[k] = { ...store[k], path: p, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  write(store);
}
function getProjectWorkMode(server, projectId) {
  return read()[key(server, projectId)]?.workMode || null;
}
function setProjectWorkMode(server, projectId, mode) {
  const store = read();
  const k = key(server, projectId);
  store[k] = { ...store[k], workMode: mode, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  write(store);
}
function sanitizeName(name) {
  const s = name.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").trim();
  return s || "project";
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
let lastProjectId = null;
function handleProjectUrl(url) {
  const m = url.match(/\/u\/[^/]+\/p\/([^/?#]+)/);
  if (!m) {
    if (lastProjectId !== null) {
      lastProjectId = null;
      if (mainWindow) void dismissOverlay(mainWindow.webContents);
    }
    return;
  }
  const projectId = m[1];
  if (projectId === lastProjectId) return;
  lastProjectId = projectId;
  void ensureProjectPath(projectId);
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
async function ensureProjectPath(projectId) {
  if (!mainWindow || !creds) return;
  const server = serverOrigin();
  const saved = getProjectLocalPath(server, projectId);
  if (saved) {
    if (!fs.existsSync(saved)) {
      try {
        fs.mkdirSync(saved, { recursive: true });
        void injectToast(mainWindow.webContents, `已创建本地路径：${saved}`, "ok");
      } catch (e) {
        void injectToast(mainWindow.webContents, `创建本地路径失败：${e.message}`, "err");
      }
    }
    return;
  }
  const projectName = await fetchProjectName(server, projectId);
  const defaultPath = join(app.getPath("desktop"), "MobiusOS", sanitizeName(projectName));
  const machineInfo = `${os.hostname()} · ${process.platform}`;
  void injectProjectPathOverlay(mainWindow.webContents, { projectId, projectName, defaultPath, machineInfo });
}
function emitStatus(s) {
  lastStatus = s;
  applyStatusToBadge();
  broadcast("aimux:status-changed", s);
  if (s.detail) appendLog(`[${s.state}] ${s.detail}`);
}
function applyStatusToBadge() {
  if (!mainWindow) return;
  void setBadge(mainWindow.webContents, lastStatus.state, lastStatus.detail);
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
async function bootDesktop() {
  if (!mainWindow || !creds) return;
  const server = serverOrigin();
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
  } else {
    emitStatus({ state: "starting", detail: "aimux 就绪，正在反向连接 mobius…" });
    supervisor = buildSupervisor();
    supervisor?.start();
  }
  emitStatus({ state: lastStatus.state, detail: "正在登录工作台…" });
  await seedWebAuth(server, creds.jwt);
  void mainWindow.loadURL(`${server}/u/${encodeURIComponent(creds.username)}`);
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
  emitStatus({ state: "starting", detail: `aimux ${r.version} 已就绪, 正在反向连接…` });
  supervisor = buildSupervisor();
  supervisor?.start();
  return { ok: true, version: r.version };
}
async function runLogout() {
  await supervisor?.stop();
  supervisor = null;
  clearCreds();
  creds = null;
  mainWindow?.loadFile(join(currentDir, "../renderer/index.html"));
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
    titleBarStyle: isMac ? "hiddenInset" : "default",
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
  mainWindow.webContents.on("will-navigate", (_e, url) => {
    if (url.startsWith("file://")) return;
    const origin = serverOrigin();
    if (origin && !url.startsWith(origin)) _e.preventDefault();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    const u = mainWindow?.webContents.getURL() || "";
    if (u.startsWith("http")) {
      void injectBadge(mainWindow.webContents).then(() => applyStatusToBadge());
      handleProjectUrl(u);
    }
  });
  mainWindow.webContents.on("did-navigate-in-page", (_e, url) => handleProjectUrl(url));
  mainWindow.webContents.on("did-navigate", (_e, url) => handleProjectUrl(url));
}
function buildMenu() {
  const tpl = [
    {
      label: "Mobius Desktop",
      submenu: [
        { label: "同步最新代码", accelerator: "CmdOrCtrl+Shift+R", click: () => runSyncReload() },
        { label: "更新 aimux", click: () => void runUpdateAimux() },
        { label: "aimux 状态面板", accelerator: "CmdOrCtrl+Shift+A", click: () => createStatusWindow() },
        { type: "separator" },
        { label: "切换账号 / 服务器", click: () => void runLogout() },
        { role: "quit", label: "退出" }
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
ipcMain.handle("aimux:status", () => lastStatus);
ipcMain.handle("aimux:update", () => runUpdateAimux());
ipcMain.handle("app:sync-reload", () => {
  runSyncReload();
  return { ok: true };
});
ipcMain.handle("aimux:details", () => ({
  status: lastStatus,
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
  await supervisor?.stop();
  supervisor = buildSupervisor();
  if (!supervisor) return { ok: false, error: "aimux 未就绪（venv 可能未建好），请稍后重试" };
  supervisor.start();
  return { ok: true };
});
ipcMain.handle("app:open-status", () => {
  createStatusWindow();
  return { ok: true };
});
ipcMain.handle("app:open-devtools", () => {
  mainWindow?.webContents.openDevTools({ mode: "detach" });
  return { ok: true };
});
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
    void injectToast(mainWindow.webContents, `创建本地路径失败：${e.message}`, "err");
    return { ok: false, error: e.message };
  }
  setProjectLocalPath(serverOrigin(), projectId, p);
  void dismissOverlay(mainWindow.webContents);
  void injectToast(mainWindow.webContents, `已绑定本地路径：${p}`, "ok");
  return { ok: true };
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
  void supervisor?.stop();
});
