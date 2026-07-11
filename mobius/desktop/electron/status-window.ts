// aimux 状态面板窗口：独立 BrowserWindow 加载本地 status.html。
// 主进程通过 IPC 提供数据（aimux:details / aimux:version / aimux:log 等）。
import { BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// electron-vite 把本文件打进 out/main/index.js，故 import.meta.url 指向 out/main。
const currentDir = dirname(fileURLToPath(import.meta.url));

let statusWindow: BrowserWindow | null = null;

export function createStatusWindow(): void {
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
      preload: join(currentDir, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void statusWindow.loadFile(join(currentDir, "../renderer/status.html"));
  statusWindow.on("closed", () => {
    statusWindow = null;
  });
}
