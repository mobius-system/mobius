// preload 同时服务两处渲染上下文：
//   - 本地登录页 (file://)：用 window.desktop
//   - 远程 web UI (loadURL)：用 window.mobiusDesktop (Fork B desktop 模式)
// contextIsolation:true → 页面只能读不能改这些桥。
import { contextBridge, ipcRenderer } from "electron";

let lastZoomWheelAt = 0;
window.addEventListener("wheel", (event) => {
  if (!event.ctrlKey || event.deltaY === 0) return;
  event.preventDefault();
  const now = Date.now();
  if (now - lastZoomWheelAt < 80) return;
  lastZoomWheelAt = now;
  const channel = event.deltaY < 0 ? "window:zoom-in" : "window:zoom-out";
  void ipcRenderer.invoke(channel).catch(() => {});
}, { capture: true, passive: false });

const desktopApi = {
  login: (creds: { server: string; username: string; password: string }) =>
    ipcRenderer.invoke("auth:login", creds),
  getLastServer: () => ipcRenderer.invoke("auth:get-last-server"),
  setTitleBarOverlay: (opts: { color?: string; symbolColor?: string; height?: number }) =>
    ipcRenderer.invoke("desktop:set-title-bar-overlay", opts),
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowZoomIn: () => ipcRenderer.invoke("window:zoom-in"),
  windowZoomOut: () => ipcRenderer.invoke("window:zoom-out"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  windowStartDrag: () => ipcRenderer.invoke("window:start-drag"),
  windowEndDrag: () => ipcRenderer.invoke("window:end-drag"),
};
contextBridge.exposeInMainWorld("desktop", desktopApi);

const mobiusDesktop = {
  isDesktop: true as const,
  getBootData: () => ipcRenderer.invoke("desktop:boot-data"),
  // 本机该账号上次退出页面路径 (供 /welcome 欢迎向导"从上次结束处继续"); 首次运行返 null。
  getLastRoute: () => ipcRenderer.invoke("desktop:get-last-route"),
  getAimuxStatus: () => ipcRenderer.invoke("aimux:status"),
  getAimuxDetails: () => ipcRenderer.invoke("aimux:details"),
  getAimuxVersion: () => ipcRenderer.invoke("aimux:version"),
  reconnectAimux: () => ipcRenderer.invoke("aimux:reconnect"),
  startAimuxPortForward: (remotePort: number) => ipcRenderer.invoke("aimux:port-forward", { remotePort }),
  getAimuxEnabled: () => ipcRenderer.invoke("aimux:get-enabled"),
  setAimuxEnabled: (enabled: boolean) => ipcRenderer.invoke("aimux:set-enabled", enabled),
  onAimuxStatus: (cb: (s: { state: string; detail?: string }) => void) => {
    const listener = (_e: unknown, s: { state: string; detail?: string }) => cb(s);
    ipcRenderer.on("aimux:status-changed", listener);
    return () => ipcRenderer.removeListener("aimux:status-changed", listener);
  },
  onAimuxLog: (cb: (line: string) => void) => {
    const listener = (_e: unknown, line: string) => cb(line);
    ipcRenderer.on("aimux:log", listener);
    return () => ipcRenderer.removeListener("aimux:log", listener);
  },
  updateAimux: () => ipcRenderer.invoke("aimux:update"),
  syncReload: () => ipcRenderer.invoke("app:sync-reload"),
  openStatusPanel: () => ipcRenderer.invoke("app:open-status"),
  openDevTools: () => ipcRenderer.invoke("app:open-devtools"),
  pickDirectory: () => ipcRenderer.invoke("project:pick-directory"),
  confirmProjectPath: (projectId: string, path: string) =>
    ipcRenderer.invoke("project:confirm-path", projectId, path),
  getProjectBindStatus: (projectId: string) =>
    ipcRenderer.invoke("project:bind-status", projectId),
  getMachineInfo: () => ipcRenderer.invoke("desktop:machine-info"),
  getProjectLocalPath: (projectId: string) => ipcRenderer.invoke("project:get-path", projectId),
  getProjectWorkMode: (projectId: string) => ipcRenderer.invoke("project:get-work-mode", projectId),
  setProjectWorkMode: (projectId: string, mode: string) => ipcRenderer.invoke("project:set-work-mode", projectId, mode),
  listProjectLocalFiles: (projectId: string, path: string) => ipcRenderer.invoke("project:list-local-files", projectId, path),
  readProjectLocalFile: (projectId: string, path: string) => ipcRenderer.invoke("project:read-local-file", projectId, path),
  writeProjectLocalFile: (projectId: string, path: string, content: string) => ipcRenderer.invoke("project:write-local-file", projectId, path, content),
  // 原生文件编辑器右键菜单: 本机下载(另存为)/复制/重命名。返回 { ok, error?, code? }。
  downloadProjectLocalFile: (projectId: string, path: string) => ipcRenderer.invoke("project:download-local-file", projectId, path),
  copyProjectLocalEntry: (projectId: string, sourcePath: string, targetDir: string) => ipcRenderer.invoke("project:copy-local-entry", projectId, sourcePath, targetDir),
  renameProjectLocalEntry: (projectId: string, path: string, newName: string) => ipcRenderer.invoke("project:rename-local-entry", projectId, path, newName),
  moveProjectLocalEntry: (projectId: string, sourcePath: string, targetDir: string) => ipcRenderer.invoke("project:move-local-entry", projectId, sourcePath, targetDir),
  // 前端切主题后上报: 透明背景 + 当前主题文字色作窗口按钮图标色 (Win/Linux overlay 用)
  setTitleBarOverlay: (opts: { color?: string; symbolColor?: string; height?: number }) =>
    ipcRenderer.invoke("desktop:set-title-bar-overlay", opts),
  // 自绘窗口控制按钮用 (titleBarOverlay 原生按钮符号在此环境不渲染)
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowZoomIn: () => ipcRenderer.invoke("window:zoom-in"),
  windowZoomOut: () => ipcRenderer.invoke("window:zoom-out"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  windowStartDrag: () => ipcRenderer.invoke("window:start-drag"),
  windowEndDrag: () => ipcRenderer.invoke("window:end-drag"),
  onMaximizeChange: (cb: (maximized: boolean) => void) => {
    const listener = (_e: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on("window:maximize-changed", listener);
    return () => ipcRenderer.removeListener("window:maximize-changed", listener);
  },
  logout: () => ipcRenderer.invoke("auth:logout"),
  clearCache: () => ipcRenderer.invoke("app:clear-cache"),
  // 多 tab 管理 (实验版 0.0.12)：每个 tab = 一个独立 webContents (WebContentsView)。
  // 壳侧 TabManager 维护 tab 列表，前端 tab 栏经这些 API 订阅状态、发切换/新建/关闭/排序指令。
  newTab: (opts?: { url?: string }) => ipcRenderer.invoke("tabs:new", opts),
  closeTab: (id: string) => ipcRenderer.invoke("tabs:close", id),
  switchTab: (id: string) => ipcRenderer.invoke("tabs:switch", id),
  reorderTabs: (ids: string[]) => ipcRenderer.invoke("tabs:reorder", ids),
  getTabs: () =>
    ipcRenderer.invoke("tabs:get") as Promise<Array<{ id: string; url: string; title?: string }>>,
  getActiveTabId: () => ipcRenderer.invoke("tabs:get-active") as Promise<string | null>,
  onTabsChanged: (
    cb: (tabs: Array<{ id: string; url: string; title?: string }>, activeId: string | null) => void,
  ) => {
    const listener = (
      _e: unknown,
      payload: { tabs: Array<{ id: string; url: string; title?: string }>; activeId: string | null },
    ) => cb(payload.tabs, payload.activeId);
    ipcRenderer.on("tabs:changed", listener);
    return () => ipcRenderer.removeListener("tabs:changed", listener);
  },
};
contextBridge.exposeInMainWorld("mobiusDesktop", mobiusDesktop);
