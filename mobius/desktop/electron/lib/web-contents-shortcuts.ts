import type { WebContents } from "electron";

export function changeWebContentsZoom(webContents: WebContents, delta: number): number {
  const current = webContents.getZoomFactor();
  const zoomFactor = Math.min(2, Math.max(0.5, Math.round((current + delta) * 10) / 10));
  webContents.setZoomFactor(zoomFactor);
  return zoomFactor;
}

export function installWebContentsShortcuts(webContents: WebContents): void {
  webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F5" || input.code === "F5") {
      event.preventDefault();
      webContents.reload();
      return;
    }
    if (input.key !== "F12") return;
    event.preventDefault();
    if (webContents.isDevToolsOpened()) webContents.closeDevTools();
    else webContents.openDevTools({ mode: "detach" });
  });
}
