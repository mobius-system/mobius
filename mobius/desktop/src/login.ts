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
}
const desktop = (window as unknown as { desktop: DesktopApi }).desktop;

// 预填上次服务器地址
desktop
  ?.getLastServer()
  .then((s) => {
    if (s) serverEl.value = s;
  })
  .catch(() => {});

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
    progEl.textContent = "登录成功，正在准备本机 aimux 环境并进入工作台…";
    // 之后由主进程 loadURL 切到远程页，本页自然卸载
  } catch (err) {
    errEl.hidden = false;
    errEl.textContent = (err as Error).message || "登录失败";
    progEl.hidden = true;
    submitEl.disabled = false;
  }
});
