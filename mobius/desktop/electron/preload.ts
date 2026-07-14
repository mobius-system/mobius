// preload 同时服务两处渲染上下文：
//   - 本地登录页 (file://)：用 window.desktop
//   - 远程 web UI (loadURL)：用 window.mobiusDesktop (Fork B desktop 模式)
// contextIsolation:true → 页面只能读不能改这些桥。
import { contextBridge, ipcRenderer } from "electron";

const desktopApi = {
  login: (creds: { server: string; username: string; password: string }) =>
    ipcRenderer.invoke("auth:login", creds),
  getLastServer: () => ipcRenderer.invoke("auth:get-last-server"),
  setTitleBarOverlay: (opts: { color?: string; symbolColor?: string; height?: number }) =>
    ipcRenderer.invoke("desktop:set-title-bar-overlay", opts),
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("window:is-maximized"),
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
  // 前端切主题后上报: 透明背景 + 当前主题文字色作窗口按钮图标色 (Win/Linux overlay 用)
  setTitleBarOverlay: (opts: { color?: string; symbolColor?: string; height?: number }) =>
    ipcRenderer.invoke("desktop:set-title-bar-overlay", opts),
  // 自绘窗口控制按钮用 (titleBarOverlay 原生按钮符号在此环境不渲染)
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  windowClose: () => ipcRenderer.invoke("window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onMaximizeChange: (cb: (maximized: boolean) => void) => {
    const listener = (_e: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on("window:maximize-changed", listener);
    return () => ipcRenderer.removeListener("window:maximize-changed", listener);
  },
  logout: () => ipcRenderer.invoke("auth:logout"),
  clearCache: () => ipcRenderer.invoke("app:clear-cache"),
};
contextBridge.exposeInMainWorld("mobiusDesktop", mobiusDesktop);
