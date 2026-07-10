# Mobius Desktop (Fork B)

薄壳桌面端：本地只承载"登录前"页面，登录后 `loadURL` 远程 web UI；本机自动跑 `aimux reverse connect` 注册为 mobius 可调度节点。

## 目录
- `electron/main.ts` — 窗口 / 登录 / loadURL / aimux 编排 / 菜单
- `electron/preload.ts` — `window.desktop`(登录页) + `window.mobiusDesktop`(远程页 desktop 模式)
- `electron/lib/secrets.ts` — safeStorage 加密存账号/JWT/identifier
- `electron/lib/host-info.ts` — OS/IP/CPU/内存采集 → bootData
- `electron/lib/python-runtime.ts` — 内置 python + venv + pip install aimux (幂等)
- `electron/lib/aimux-supervisor.ts` — spawn reverse connect / 断线重启 / JWT 续期 / 退出杀进程
- `electron/lib/status-overlay.ts` — 远程页注入"aimux 连接状态"常驻徽标
- `scripts/fetch-python.ts` — 构建期拉 python-build-standalone (win-x64)
- `src/login.ts` — vanilla 登录页

## 关键设计
- **不做免二次登录**：桌面登录拿的 JWT 只喂 aimux；web UI 走它自己的登录。
- **aimux 状态徽标**：主进程在远程页 `did-finish-load` 注入固定置顶 DOM，状态变化时 `executeJavaScript` 更新；不依赖 web UI。
- **退出断开**：`before-quit` 调 `supervisor.stop()`，Windows 用 `taskkill /T /F` 连进程树杀。
- **JWT 续期**：解析 exp，提前 10min 用存的账号密码重登拿新 token，重启 supervisor。

## 构建 (Windows)
```
npm install
npm run dist:win     # = fetch-python + build + electron-builder --win
```
产物在 `release/`。首启会 `pip install aimux`（需联网）。
