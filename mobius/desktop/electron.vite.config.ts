import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

// 渲染层只承载"登录前"页面 (vanilla TS, 无 React)；登录后 loadURL 远程 web UI。
export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, "electron/main.ts") } },
    },
  },
  preload: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, "electron/preload.ts") } },
    },
  },
  renderer: {
    root: ".",
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "index.html"),
          status: resolve(__dirname, "status.html"),
        },
      },
    },
  },
});
