import { contextBridge, ipcRenderer } from "electron";

const desktopShell = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
  close: () => ipcRenderer.invoke("window:close"),
};

contextBridge.exposeInMainWorld("desktopShell", desktopShell);
