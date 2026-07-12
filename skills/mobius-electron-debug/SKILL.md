---
name: mobius-electron-debug
description: Iterate on the Mobius desktop (Electron) client on a remote Windows machine via aimux — hot-swap app.asar through the bridge, restart the exe, and verify with a screenshot feedback loop. Use when changing Electron-shell code (main process / preload / title bar / window controls) that requires repackaging.
---

# Mobius 桌面端 (Electron) 远程调试循环

改桌面端 Electron 壳代码（主进程 / preload / 标题栏 / 窗口控制等）后，**必须重打包 + 替换真机 `app.asar` 才生效**。本 skill 总结如何在 aimux 反向连接的 Windows 真机上，做「改代码 → 重打包 → 热替换 asar → 重启 exe → 截图验证 → 据反馈再改」的闭环迭代，无需用户手动操作。

> 本文所有路径里的 `<remote>` = aimux bridge remote 名（Windows 主机）；`<version>` = 桌面端版本号（见 `mobius/desktop/package.json` 的 `version`）。真机工作目录示例 `C:\tmp\mobius-desktop-<version>-win-x64`。

## 0. 先判断：这次改动要不要重打包？

| 改动位置 | 进 app.asar？ | 生效方式 |
|---|---|---|
| `mobius/desktop/electron/**`（main.ts / preload.ts / lib/*） | ✅ 进 asar | **必须重打包 + 替换真机 asar + 重启 exe** |
| `mobius/desktop/src/**`（登录页 login.ts / styles.css / index.html） | ✅ 进 asar（renderer） | 同上 |
| `mobius/frontend/src/**`（远程工作台前端 shell.tsx / App.tsx 等） | ❌ 不进 asar（服务器托管） | `python3 start.py --only-update-frontend` 部署后，exe **重启或硬刷新**即生效 |
| `python-runtime` / Electron 版本 / electron-builder.yml | — | 整包重打 + 重装 |

关键：**壳改动（main/preload/登录页）在 asar 里，远程前端改动在服务器**。两者都要让 exe 重新加载——壳改动靠替换 asar + 重启 exe，前端改动靠重启 exe（loadURL 会拉最新前端 hash）。

## 1. 核心约束：aimux bridge 依赖 exe 运行

桌面端的 aimux supervisor 是 **exe 的子进程**。这意味着：

- **kill exe = 断 bridge = 你的 aimux session 立即失联**。
- 但 exe 重启后 supervisor 会自动 reverse-connect，**bridge 几秒内重连**，可重新 `aimux new` 建会话。
- 因此替换 asar 必须用 **detached 脚本**（独立进程），让它在 bridge 断开后仍能完成 kill → 替换 → 重启。不能在当前 session 里同步 kill exe（会把自己掐断，替换/重启就没人执行了）。

## 2. 完整调试循环（一次迭代 ≈ 3–4 分钟）

### 步骤 1：改代码 + 本地类型检查

```bash
cd mobius/desktop && npx tsc --noEmit          # 壳类型检查（exit 0 才继续）
cd mobius/frontend && npm run build            # 前端改动时验证 vite build 通过
```

### 步骤 2：重打包壳（只打 win-x64，跳过菜单同步省时间）

```bash
python3 build.py --build-electron --targets win-x64 --skip-menu-sync
# 产物：mobius/desktop/release/win-unpacked/resources/app.asar  （约 48KB！）
#       mobius/desktop/release/Mobius Desktop-<version>-win-x64.zip
```

> **关键优化**：标题栏/窗口控制这类壳改动**全部编译进 `app.asar`**（仅几十 KB）。**只需替换真机的 `app.asar`，不用推 180MB 整个目录**。asar 不含 python runtime（python 是 extraResources，单独在 `resources/python/`）。

### 步骤 3：建 aimux 会话 + 备份原版 asar + 推新 asar 到临时目录

```bash
export PATH="$HOME/.local/bin:$PATH"
BASE='C:\tmp\mobius-desktop-<version>-win-x64'

aimux new --remote <remote> --profile powershell --name sw --reuse
# 首次：把真机自带的原始 app.asar 另存为 .orig（永久回滚点，只存一次）
aimux send-keys "<remote>/sw" -- "if (!(Test-Path '$BASE\resources\app.asar.orig')) { Copy-Item '$BASE\resources\app.asar' '$BASE\resources\app.asar.orig' -Force; 'ORIG_SAVED' } else { 'ORIG_EXISTS' }" Enter
sleep 2

# 推新 asar 到临时目录（不直接覆盖运行中的 app.asar！）
aimux send_files <remote> 'C:\tmp\new-asar' 'mobius/desktop/release/win-unpacked/resources/app.asar'
```

> **不要**直接 `send_files` 覆盖 `resources\app.asar`：运行中的 Electron 可能锁文件，且覆盖到一半会损坏。永远先推到临时目录，再用脚本原子替换。

### 步骤 4：detached 脚本原子替换 + 重启 exe

把 `swap-asar.ps1`（见 §3）推到真机并 detached 执行：

```bash
aimux send_files <remote> 'C:\tmp\new-asar' '/tmp/swap-asar.ps1'
# detached 启动：Start-Process 起独立 powershell 进程，当前 session 命令立即返回
aimux send-keys "<remote>/sw" -- 'Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","C:\tmp\new-asar\swap-asar.ps1"; echo LAUNCHED' Enter
```

脚本时序：`sleep 2`（让当前 session 命令返回）→ 备份当前 asar → `Stop-Process` 杀 exe（**bridge 断**）→ 替换 asar → `Start-Process` 重启 exe → 写完成标记。

### 步骤 5：等 bridge 重连 + 建新会话

```bash
sleep 20                                                       # 等 exe 重启 + supervisor 反连
aimux remote ls | grep <remote>                                # 确认 connected
aimux new --remote <remote> --profile powershell --name chk    # 用新会话名（见 §5 坑）
```

### 步骤 6：验证 asar 已替换 + exe 在跑

```bash
aimux send-keys "<remote>/chk" -- \
  "Write-Output ('asar=' + (Get-Item '$BASE\resources\app.asar').Length)" Enter \
  '$p = @(Get-Process "Mobius Desktop" -ErrorAction SilentlyContinue); Write-Output ("proc=" + $p.Count)' Enter \
  "Write-Output ('done=' + (Get-Content C:\tmp\new-asar\swap-done.txt -ErrorAction SilentlyContinue))" Enter
sleep 3
aimux capture "<remote>/chk" --lines 20 | sed 's/\x1b\[[0-9;]*[mGKHJ]//g' | tail -10
```

期望：`asar=` = 新 asar 字节数、`proc=4`（Electron 多进程：main + GPU + renderer + utility）、`done=DONE_HHMMSS`。

### 步骤 7：截图验证（见 §4 详述）→ 据反馈回到步骤 1

---

## 3. 关键脚本（推到真机 `C:\tmp\new-asar\` 下）

### swap-asar.ps1 —— 原子替换 + 重启

```powershell
Start-Sleep -Seconds 2
$base = 'C:\tmp\mobius-desktop-<version>-win-x64'
# 备份当前 asar（每次覆盖 .bak；原版永久存在 .orig）
try { Copy-Item "$base\resources\app.asar" "$base\resources\app.asar.bak" -Force -ErrorAction SilentlyContinue } catch {}
# 杀 exe（会断 aimux bridge；supervisor 重启后自动重连）
Get-Process -Name 'Mobius Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
# 替换 asar
Copy-Item 'C:\tmp\new-asar\app.asar' "$base\resources\app.asar" -Force
Start-Sleep -Seconds 1
# 重启 exe（加载新 asar；supervisor 起 bridge 重连）
Start-Process -FilePath "$base\Mobius Desktop.exe" -WorkingDirectory $base
# 完成标记
'DONE_' + (Get-Date -Format 'HHmmss') | Out-File 'C:\tmp\new-asar\swap-done.txt'
```

### screenshot.ps1 —— 激活窗口 + 截全屏

```powershell
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
}
"@
# 把 Mobius 窗口拉到前台（截图前必须，否则截到的是别的窗口）
$procs = Get-Process 'Mobius Desktop' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }
if ($procs) {
  $h = $procs[0].MainWindowHandle
  [Win32]::ShowWindowAsync($h, 9) | Out-Null      # SW_RESTORE
  Start-Sleep -Milliseconds 400
  [Win32]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 700
}
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
$bmp.Save('C:\tmp\new-asar\screen.png')
$g.Dispose(); $bmp.Dispose()
Write-Output ('shot=' + (Get-Item 'C:\tmp\new-asar\screen.png').Length + ' ' + $b.Width + 'x' + $b.Height)
```

> ⚠️ **避坑**：曾尝试在 screenshot.ps1 里加 `$wsh.SendKeys('^+{R}')` 触发 exe 的 Ctrl+Shift+R 硬刷新，结果 conda 的 PowerShell 报 `ParserError: UnexpectedToken`。**reload exe 改用 swap 重启**（swap 不换 asar 也行，纯重启就重新 loadURL 拉最新前端），别在 ps1 里混 SendKeys。

---

## 4. 截图 feedback 循环（本 skill 的核心价值）

「改了壳代码但看不到效果」是桌面端调试最大痛点。这套循环让你**纯远程、无需用户介入**就能看到渲染结果并迭代。

### 4.1 截图
```bash
aimux send-keys "<remote>/chk" -- 'powershell -ExecutionPolicy Bypass -File C:\tmp\new-asar\screenshot.ps1' Enter
sleep 6   # 激活+截图含几处 sleep，留够时间
aimux capture "<remote>/chk" --lines 5   # 看到 shot=xxxx 即成功
```

### 4.2 下载到本地
```bash
aimux get_files <remote> /tmp/host-screen 'C:\tmp\new-asar\screen.png'
```

### 4.3 裁剪 + 放大要看的区域
全屏图（可能双屏 3840×1080）细节看不清。用 ffmpeg 裁目标区域放大：

```bash
cd /tmp/host-screen
# 裁右上角窗口按钮区（坐标按实际截图调整：crop=宽:高:x:y，原点左上）
ffmpeg -y -loglevel error -i screen.png -filter "crop=380:130:3460:0,scale=1140:390" topright.png
# 裁整个顶栏
ffmpeg -y -loglevel error -i screen.png -filter "crop=1920:420:1920:0,scale=1600:350" topnav.png
```

> 没有 ffmpeg 就用 PIL：`python3 -c "from PIL import Image; Image.open('screen.png').crop((x,y,x+w,y+h)).save('out.png')"`。

### 4.4 看图 + 客观验证
- `Read` 一张图 → 直接看到渲染效果（图会自动上传 CDN）。
- 细节拿不准（按钮有没有渲染？图标大小协调吗？）→ 用 `analyze_image` **客观提问**（「右上角有几个按钮？图标颜色？距右边缘多远？」），不要让它推测。
- **根据截图判断是否符合预期** → 不符合就回 §2 步骤 1 改代码，进入下一轮。

### 4.5 实战案例：标题栏按钮的 5 轮迭代
这个循环在本任务里跑了多轮，每轮都靠截图发现问题：

| 轮次 | 改动 | 截图反馈 | 结论 |
|---|---|---|---|
| v1 | `titleBarStyle:hidden` + `titleBarOverlay:{color:rgba(0,0,0,0)}` | 右上角**无按钮** | 透明 color 不渲染符号 |
| v2 | overlay color 改不透明 `#0a0e16` | 右上角**仍无按钮**（只有背景色块，无 min/max/close 符号） | 此环境（未签名 exe + 高 DPI）titleBarOverlay 原生按钮符号根本不渲染 |
| v3 | **放弃 overlay，改前端自绘按钮** + `window:*` IPC | 右上角**4 个按钮齐全** ✅ | 自绘方案生效 |
| v4 | 自绘按钮缩小 + 加刷新按钮 | 刷新图标比其他大很多 | svg `viewBox 24 width 12` vs 其他 `viewBox 11 width 10`，视觉不一致 |
| v5 | 刷新 svg 改 `width 10` | 4 图标大小协调 ✅ | 完成 |

**没有截图循环，v1/v2 的「按钮不渲染」根本发现不了**（代码逻辑全对、tsc 全过、exe 正常跑），会误以为成功。

---

## 5. aimux bridge session 的坑

### 坑 1：session 状态不一致（zombie session）
exe 重启（bridge 断再重连）后，旧的 session 在 aimux 本地有记录、但 bridge 上已失效：

```
aimux new  --reuse   →  error: session 'X' already exists     # 本地有记录
aimux capture X      →  error: session not found              # bridge 上没有
aimux kill X         →  error: session not found              # kill 走 bridge 通道也失败，清不掉本地记录
```

**解法**：直接**换一个新 session 名**（`sw`→`sw2`→`sw3`…），绕开僵尸记录。不要在 kill/new 上死磕。

### 坑 2：capture 报 `client replaced`
detached 脚本 kill exe 时，当前 capture 会报 `bridge remote disconnected: client replaced`。这是**预期**（新 exe 已重连替换旧连接），不是错误。等 20s 后 `aimux new` 新会话即可。

### 坑 3：bridge remote 必须带 `--profile`
反向 Windows 设备的 `aimux new` 必须带 `--profile`（`cmd` / `powershell` / `mingw64`，见 `aimux remote ls` 的 PROFILES 列）。推荐 `powershell`（脚本兼容性最好）。

---

## 6. titleBarOverlay 陷阱 + 自绘窗口按钮方案

### 陷阱
Windows 上 `titleBarStyle:"hidden"` + `titleBarOverlay:{color,symbolColor,height}` 理论上叠原生 min/max/close 按钮。但**在未签名 exe（`signAndEditExecutable:false`）+ 高 DPI 缩放**的真机上，overlay 只渲染背景色块、**按钮符号（symbolColor）不显示**。用户将无法最小化/关闭窗口。

### 方案：前端自绘按钮（VSCode 同款，完全可控）
1. **主进程** `main.ts`：`titleBarStyle:"hidden"`，**不用** titleBarOverlay；加 `window:minimize` / `window:toggle-maximize` / `window:close` / `window:is-maximized` IPC；`maximize`/`unmaximize` 事件经 `broadcast` 推前端。
2. **preload**：`mobiusDesktop` 暴露 `windowMinimize` / `windowToggleMaximize` / `windowClose` / `windowIsMaximized` / `onMaximizeChange`。
3. **前端** `window-controls.tsx`：仅 `!IS_MAC_PLATFORM` 渲染（macOS 用系统交通灯 `hiddenInset`）；图标色 `var(--text-primary)` → **天然随主题**；关闭键 hover 红 `#e81123`。
4. **顶栏 drag**：`.mobius-topnav` 加 `-webkit-app-region:drag`，内部交互元素 `no-drag`（仅 `window.mobiusDesktop.isDesktop` 时挂 class，Web 端零影响）。

### 主题自适应
顶栏背景本就是 `var(--bg-primary)`（随主题切换的 CSS 变量）。隐藏原生标题栏后，顶栏直接充当标题栏 → **切主题自动变色，零额外逻辑**。这是「让前端既有顶栏充当标题栏」相比「自绘独立标题栏条」的最大优势。

---

## 7. 回滚

真机保留了两个备份（在 `resources\` 下）：
- `app.asar.orig` —— 真机出厂原版（永久，首次 swap 时存）。最稳回滚点。
- `app.asar.bak` —— 上一次替换前的版本（每次 swap 覆盖）。

回滚：`Copy-Item app.asar.orig app.asar -Force` → 重启 exe（再跑一次 swap-asar.ps1，或改脚本只重启不替换）。

---

## 8. 速查表（一次迭代）

```bash
# 0. PATH
export PATH="$HOME/.local/bin:$PATH"
REMOTE=<remote>; BASE='C:\tmp\mobius-desktop-<version>-win-x64'

# 1. 改代码 + 类型检查
cd mobius/desktop && npx tsc --noEmit

# 2. 重打包（只 win-x64）
python3 build.py --build-electron --targets win-x64 --skip-menu-sync
# 前端改动另加: python3 start.py --only-update-frontend

# 3. 推 asar + 脚本到临时目录
aimux send_files $REMOTE 'C:\tmp\new-asar' 'mobius/desktop/release/win-unpacked/resources/app.asar'
aimux send_files $REMOTE 'C:\tmp\new-asar' '/tmp/swap-asar.ps1'

# 4. detached 原子替换 + 重启
aimux new --remote $REMOTE --profile powershell --name sw --reuse
aimux send-keys "$REMOTE/sw" -- 'Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","C:\tmp\new-asar\swap-asar.ps1"; echo GO' Enter

# 5. 等重连 + 验证
sleep 20 && aimux remote ls | grep $REMOTE
aimux new --remote $REMOTE --profile powershell --name chk
aimux send-keys "$REMOTE/chk" -- "Write-Output ((Get-Item '$BASE\resources\app.asar').Length)" Enter
sleep 3 && aimux capture "$REMOTE/chk" --lines 6

# 6. 截图 → 下载 → 裁剪 → 看
aimux send-keys "$REMOTE/chk" -- 'powershell -ExecutionPolicy Bypass -File C:\tmp\new-asar\screenshot.ps1' Enter
sleep 6
aimux get_files $REMOTE /tmp/host-screen 'C:\tmp\new-asar\screen.png'
cd /tmp/host-screen && ffmpeg -y -loglevel error -i screen.png -filter "crop=380:130:3460:0,scale=1140:390" topright.png
# Read topright.png 看效果; 不满意回到步骤 1
```

## 9. 收尾

- 任务完成后销毁 aimux 会话：`aimux kill "<remote>/chk"` 等（exe 多次重启后旧会话已是 zombie，kill 报 not found 属正常）。
- 真机临时文件 `C:\tmp\new-asar\*` 可留（下次迭代复用脚本）；`app.asar.orig` 务必保留。
- 壳改动入 git（`mobius/desktop/electron/**` 被跟踪；只有 `release/`、`node_modules/`、`desktop-builds/` 被 gitignore）。
