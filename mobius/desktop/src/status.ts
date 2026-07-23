// aimux 状态面板：拉取 details + 订阅 status/log 实时更新；按钮触发主进程动作。
type State = "stopped" | "starting" | "connected" | "failed" | "disabled";

const md = window.mobiusDesktop;

const stateEl = document.getElementById("state") as HTMLDivElement;
const stateTxt = stateEl.querySelector(".txt") as HTMLSpanElement;
const detailEl = document.getElementById("detail") as HTMLDivElement;
const toggleEl = document.getElementById("toggle-enabled") as HTMLButtonElement | null;

const STATE_LABEL: Record<State, string> = {
  starting: "连接中",
  connected: "已连接",
  failed: "失败",
  stopped: "已停止",
  disabled: "已关闭",
};

function setState(state: string, detail?: string): void {
  stateEl.className = `state s-${state}`;
  stateTxt.textContent = STATE_LABEL[state as State] || state;
  detailEl.textContent = detail || "—";
  detailEl.classList.toggle("err", state === "failed");
}

function toast(msg: string): void {
  const t = document.getElementById("toast") as HTMLDivElement;
  t.textContent = msg;
  t.hidden = false;
  setTimeout(() => { t.hidden = true; }, 3500);
}

function setToggleUI(enabled: boolean): void {
  if (!toggleEl) return;
  toggleEl.setAttribute("aria-checked", enabled ? "true" : "false");
}

async function refresh(): Promise<void> {
  const d = await md.getAimuxDetails();
  setState(d.status.state, d.status.detail);
  setToggleUI(d.aimuxEnabled);
  (document.getElementById("identifier") as HTMLElement).textContent = d.identifier || "—";
  (document.getElementById("server") as HTMLElement).textContent = d.serverOrigin || "—";
  (document.getElementById("venv") as HTMLElement).textContent = d.venvDir || "—";
  (document.getElementById("aimux-log-path") as HTMLElement).textContent = d.aimuxLogPath || "—";
  (document.getElementById("bundled") as HTMLElement).textContent = d.hasBundledPython ? "已内置" : "未内置（回退系统 python）";
  const h = d.hostInfo;
  (document.getElementById("host-os") as HTMLElement).textContent = `${h.platform} ${h.osVersion}`;
  (document.getElementById("host-name") as HTMLElement).textContent = h.hostname;
  (document.getElementById("host-arch") as HTMLElement).textContent = h.arch;
  (document.getElementById("host-ip") as HTMLElement).textContent = h.ips.join(", ") || "—";
  (document.getElementById("host-cpu") as HTMLElement).textContent = `${h.cpuModel} ×${h.cpuCount}`;
  (document.getElementById("host-mem") as HTMLElement).textContent = `${h.totalMemGB} GB`;
  const logEl = document.getElementById("log") as HTMLPreElement;
  logEl.textContent = d.logs.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

// 版本单独拉（要 spawn pip show）
md.getAimuxVersion().then((v) => {
  (document.getElementById("version") as HTMLElement).textContent = v;
});

// 实时更新
md.onAimuxStatus((s) => setState(s.state, s.detail));
md.onAimuxLog((line) => {
  const logEl = document.getElementById("log") as HTMLPreElement;
  logEl.textContent += (logEl.textContent ? "\n" : "") + line;
  // 保留最近 500 行
  const lines = logEl.textContent.split("\n");
  if (lines.length > 500) logEl.textContent = lines.slice(-500).join("\n");
  logEl.scrollTop = logEl.scrollHeight;
});

// 按钮
document.getElementById("btn-update")?.addEventListener("click", async () => {
  toast("正在更新 aimux…");
  const r = await md.updateAimux();
  toast(r.ok ? `已更新到 ${r.version}` : `更新失败: ${r.error}`);
  const v = await md.getAimuxVersion();
  (document.getElementById("version") as HTMLElement).textContent = v;
});
document.getElementById("btn-reconnect")?.addEventListener("click", async () => {
  toast("正在重新连接…");
  const r = await md.reconnectAimux();
  toast(r.ok ? "已触发重连" : `重连失败: ${r.error}`);
});
document.getElementById("btn-sync")?.addEventListener("click", async () => {
  await md.syncReload();
  toast("已请求同步最新代码");
});
document.getElementById("btn-devtools")?.addEventListener("click", () => md.openDevTools());
document.getElementById("btn-clear-log")?.addEventListener("click", () => {
  (document.getElementById("log") as HTMLPreElement).textContent = "";
});

// aimux 反连开关：关=停 supervisor+反连子进程；开=装+连
toggleEl?.addEventListener("click", async () => {
  const next = toggleEl.getAttribute("aria-checked") !== "true";
  toggleEl.disabled = true;
  const r = await md.setAimuxEnabled(next);
  toggleEl.disabled = false;
  if (r.ok) {
    setToggleUI(r.enabled ?? next);
    toast(r.enabled ? "已开启 aimux 连接" : "已关闭 aimux 连接");
  } else {
    toast(`切换失败: ${r.error}`);
  }
  refresh();
});

// ===== 新手说明卡片：折叠参数词典 + 跳引导提示 =====
const introToggle = document.getElementById("intro-toggle");
const introGlossary = document.getElementById("intro-glossary");
introToggle?.addEventListener("click", () => {
  if (!introGlossary) return;
  const willShow = introGlossary.hasAttribute("hidden");
  if (willShow) introGlossary.removeAttribute("hidden"); else introGlossary.setAttribute("hidden", "");
  introToggle.setAttribute("aria-expanded", willShow ? "true" : "false");
  introToggle.textContent = willShow ? "收起说明" : "这些信息分别是什么意思？";
});
document.getElementById("intro-learn")?.addEventListener("click", () => {
  toast("请回到主界面，点击右上角「?」问号，选择「认识 aimux」查看完整引导。");
});

refresh();
