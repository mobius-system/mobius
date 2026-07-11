// preload 同时服务两处渲染上下文：
//   - 本地登录页 (file://)：用 window.desktop
//   - 远程 web UI (loadURL)：用 window.mobiusDesktop (Fork B desktop 模式)
// contextIsolation:true → 页面只能读不能改这些桥。
import { contextBridge, ipcRenderer } from "electron";

const desktopApi = {
  login: (creds: { server: string; username: string; password: string }) =>
    ipcRenderer.invoke("auth:login", creds),
  getLastServer: () => ipcRenderer.invoke("auth:get-last-server"),
};
contextBridge.exposeInMainWorld("desktop", desktopApi);

const mobiusDesktop = {
  isDesktop: true as const,
  getBootData: () => ipcRenderer.invoke("desktop:boot-data"),
  getAimuxStatus: () => ipcRenderer.invoke("aimux:status"),
  getAimuxDetails: () => ipcRenderer.invoke("aimux:details"),
  getAimuxVersion: () => ipcRenderer.invoke("aimux:version"),
  reconnectAimux: () => ipcRenderer.invoke("aimux:reconnect"),
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
  logout: () => ipcRenderer.invoke("auth:logout"),
};
contextBridge.exposeInMainWorld("mobiusDesktop", mobiusDesktop);
