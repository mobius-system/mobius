// 登录页：收集 URL/账号/密码 → IPC 给主进程；主进程负责登录、装 aimux、loadURL。
const form = document.getElementById("login-form") as HTMLFormElement;
const serverEl = document.getElementById("server") as HTMLInputElement;
const userEl = document.getElementById("username") as HTMLInputElement;
const passEl = document.getElementById("password") as HTMLInputElement;
const errEl = document.getElementById("error") as HTMLDivElement;
const progEl = document.getElementById("progress") as HTMLDivElement;
const submitEl = document.getElementById("submit") as HTMLButtonElement;

interface DesktopApi {
  login: (c: { server: string; username: string; password: string }) => Promise<{ ok: boolean; error?: string }>;
  getLastServer: () => Promise<string>;
  setTitleBarOverlay?: (o: { color?: string; symbolColor?: string }) => Promise<unknown>;
  windowStartDrag?: () => Promise<unknown>;
  windowEndDrag?: () => Promise<unknown>;
}
const desktop = (window as unknown as { desktop: DesktopApi }).desktop;

const endWindowDrag = () => {
  desktop?.windowEndDrag?.().catch(() => {});
};
document.querySelector(".login")?.addEventListener("pointerdown", (event) => {
  const e = event as PointerEvent;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  if ((e.target as HTMLElement | null)?.closest(".login-panel")) return;
  e.preventDefault();
  desktop?.windowStartDrag?.().catch(() => {});
  window.addEventListener("pointerup", endWindowDrag, { once: true });
  window.addEventListener("blur", endWindowDrag, { once: true });
});

// 预填上次服务器地址
desktop
  ?.getLastServer()
  .then((s) => {
    if (s) serverEl.value = s;
  })
  .catch(() => {});

// 登录页是浅色底 (#f5f5f7): overlay 背景设为该浅色 + 深色图标, 避免透明背景导致按钮不显示 / 浅图标在浅底看不清。
// 进入工作台后由远程前端 App.tsx 按当前主题再覆盖。
desktop?.setTitleBarOverlay?.({ color: "#f5f5f7", symbolColor: "#3d3d3d" }).catch(() => {});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errEl.hidden = true;
  progEl.hidden = false;
  progEl.textContent = "正在登录…";
  submitEl.disabled = true;
  try {
    const res = await desktop.login({
      server: serverEl.value.trim(),
      username: userEl.value.trim(),
      password: passEl.value,
    });
    if (!res.ok) throw new Error(res.error || "登录失败");
    // 登录后主进程会装 aimux + 反连 + 注入登录态；这里订阅实时进度展示给用户
    progEl.innerHTML = '<span class="spin"></span><span id="prog-text">登录成功，正在准备本机 aimux 环境…</span>';
    const md = (window as unknown as { mobiusDesktop?: { onAimuxStatus?: (cb: (s: { detail?: string }) => void) => unknown } }).mobiusDesktop;
    md?.onAimuxStatus?.((s) => {
      const t = document.getElementById("prog-text");
      if (t && s?.detail) t.textContent = s.detail;
    });
  } catch (err) {
    errEl.hidden = false;
    errEl.textContent = (err as Error).message || "登录失败";
    progEl.hidden = true;
    submitEl.disabled = false;
  }
});
