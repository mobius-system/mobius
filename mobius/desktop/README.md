# Mobius Desktop

Electron 桌面客户端：本地负责登录、窗口和 AIMUX，工作台页面由 Mobius 服务器提供。

## AIMUX 连接规则

以 TUI 的连接约定为准，两端共用 `../tui/src/lib/aimux-protocol.ts` 的版本回退、参数探测、标识哈希及 GUI 权限规则。

- **版本**：连接时读取 `/aimux_bridge/api/health`，把本地 AIMUX 升级或降级到服务端版本；读取失败使用与 TUI 相同的 `0.3.72` 回退版本。版本切换失败但旧环境仍能导入时，记录警告并继续连接。
- **手动更新**：菜单“更新 aimux”从 PyPI 官方索引安装最新版，禁用缓存；本次重连保留新版本，下次启动重新按服务端对齐。没有启动后的后台追最新版任务。
- **参数**：启动前读取 `reverse connect --help`；Windows 静默参数优先 `--silent-v2`，兼容 `--slient-v2`、`--silent-shell`，不发送不支持的开关。
- **守护进程**：detached 启动，输出直接写入 `userData/logs/aimux.log`；每 5 秒更新 runtime 中的 `last_feed_watchdog`。活进程在网络故障时自行重连，桌面端不会因为 bridge 暂时离线而杀进程。
- **退出与关闭**：普通退出仅停止续租，由 watchdog 到期退出；显式关闭连接、注销、升级和手动重连会等待旧进程停止。启动失败有 90 秒宽限，连续 3 次未启动成功后停止反复拉起。
- **凭据**：JWT 到期前 10 分钟或收到 401/403 时重新登录，停止旧守护进程后使用新 token 重连；失败限速重试，日志不记录 token。
- **设备标识**：`desktop-主机名-哈希`，GUI 授权后为 `gui-主机名-哈希`。桌面端一个窗口可管理多个项目，因此哈希使用 OS 用户和稳定的 `userData` 路径；runtime 另按服务器和登录账号隔离，不与 TUI 的工作区守护进程混用。
- **GUI 授权**：菜单“AIMUX 图形界面授权”，默认纯命令行。Windows 普通进程只会使用 `--enable-gui --gui-no-elevate`；管理员进程可直接使用已有权限，不请求额外提权。不支持相应开关时不启用 GUI。

桌面端继续优先使用安装包内置 Python，再回退系统 Python；TUI 按需下载 Python 的分发方式没有搬入桌面端。

## 验证与构建

```bash
# 项目根目录
npm run build --prefix mobius/desktop
node mobius/desktop/tests/aimux-lifecycle.test.cjs
npm run test:aimux --prefix mobius/tui
python3 build.py --build-electron --targets win-x64 --skip-menu-sync --skip-fetch-python
```

`--skip-fetch-python` 适用于本地已经具备目标平台 Python 的情况。Electron 壳代码编译进 `app.asar`，服务器的 `python3 start.py` 不会替换已安装客户端的壳；客户端需要安装新包或更新 `app.asar`。
