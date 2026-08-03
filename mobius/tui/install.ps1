#requires -Version 5.1
<#
.SYNOPSIS
  Mobius TUI Windows 便携安装 (自带 portable Node, 无需 admin, 不依赖 npm.ps1)
.DESCRIPTION
  下载 portable Node win-x64 zip 解压到 ~/.mobius/node-portable/ → 用 node.exe 直跑 npm-cli.js
  装 @mobius-os/mobius 到 ~/.mobius/npm-global/ → 自建 mobius.cmd 启动器(绝对路径指向便携 node)
  → 加 ~/.mobius/bin 到用户 PATH (无需 admin)。
  npm 安装和 mobius 启动均直接使用 node.exe/tsx；安装完成后同时注册两个
  Explorer 右键入口：“在 Mobius 中打开”（文件夹本身 + 文件夹空白处）。
.EXAMPLE
  irm https://serve.nutshellai.cn/publish/auto/mobiustui/install-v9.ps1 | iex
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

function Step($m){ Write-Host "[*] $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "[OK] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "[!]  $m" -ForegroundColor Yellow }
function Err($m) { Write-Host "[X]  $m" -ForegroundColor Red }

Write-Host "=== Mobius TUI Windows 便携安装 (无需 admin) ===" -ForegroundColor White

$MHOME      = Join-Path $env:USERPROFILE ".mobius"
$NODE_DIR   = Join-Path $MHOME "node-portable"
$GLOBAL_DIR = Join-Path $MHOME "npm-global"
$NODE_VER   = "v24.18.1"
$ZIP_URL     = "https://serve.nutshellai.cn/publish/auto/mobius-tui/node/node-$NODE_VER-win-x64.zip"
$NODE_SHA256 = "ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765"  # node v24.18.1 win-x64
$nodeExe    = Join-Path $NODE_DIR "node.exe"
$npmCli     = Join-Path $NODE_DIR "node_modules\npm\bin\npm-cli.js"

New-Item -ItemType Directory -Force -Path $MHOME | Out-Null

# --- 1. portable Node ---
if (Test-Path $nodeExe) {
    Ok "便携 Node 已存在: $NODE_DIR"
} else {
    Step "下载便携 Node $NODE_VER (~37MB), 可能需 1-2 分钟..."
    $zip = Join-Path $MHOME "node.zip"
    Invoke-WebRequest -Uri $ZIP_URL -OutFile $zip
    Step "校验 sha256..."
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $NODE_SHA256.ToLower()) { Err "Node zip sha256 不匹配 (下载损坏? 期望 $NODE_SHA256 实际 $actual)"; exit 1 }
    Step "解压..."
    $tmp = Join-Path $MHOME "_extract"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Join-Path $tmp "node-$NODE_VER-win-x64"
    if (-not (Test-Path (Join-Path $inner "node.exe"))) { Err "解压后未找到 node.exe"; exit 1 }
    if (Test-Path $NODE_DIR) { Remove-Item $NODE_DIR -Recurse -Force }
    Move-Item $inner $NODE_DIR -Force
    Remove-Item $tmp -Recurse -Force
    Remove-Item $zip -Force
    Ok "便携 Node 就绪: $NODE_DIR"
}

# --- 2. npm 装 @mobius-os/mobius (node.exe 直跑 npm-cli.js, 绕过 npm.ps1 的 ExecutionPolicy 拦截) ---
Step "npm 安装 @mobius-os/mobius@latest (本地 install 到便携目录, 官方 registry)..."
New-Item -ItemType Directory -Force -Path $GLOBAL_DIR | Out-Null
Remove-Item (Join-Path $GLOBAL_DIR "node_modules") -Recurse -Force -EA SilentlyContinue   # 清旧 node_modules (脏结构会让 npm 跳过 tsx)
Remove-Item (Join-Path $GLOBAL_DIR "package.json") -Force -EA SilentlyContinue
Push-Location $GLOBAL_DIR
& $nodeExe $npmCli init -y *>$null   # 本地 install (非 -g --prefix, 后者 global 模式漏装 tsx)
& $nodeExe $npmCli install "@mobius-os/mobius@latest" --registry https://registry.npmjs.org/
if ($LASTEXITCODE -ne 0) { Err "npm 安装失败"; exit 1 }
# npm 11 默认拦截 esbuild postinstall。approve-scripts 会把精确版本写入
# 当前 npm-global/package.json 的 allowScripts，随后 rebuild 真正生成二进制。
& $nodeExe $npmCli approve-scripts esbuild
if ($LASTEXITCODE -ne 0) { Err "批准 esbuild 安装脚本失败"; exit 1 }
& $nodeExe $npmCli rebuild esbuild
if ($LASTEXITCODE -ne 0) { Err "重建 esbuild 失败"; exit 1 }
Pop-Location
Ok "mobius 装到: $GLOBAL_DIR"

# --- 3. mobius 启动器 (.cmd batch, 用绝对路径指向便携 node, 不依赖系统 PATH/ExecutionPolicy) ---
$binDir   = Join-Path $MHOME "bin"
$entryJs  = Join-Path $GLOBAL_DIR "node_modules\@mobius-os\mobius\bin\mobius-tui.js"
if (-not (Test-Path $entryJs)) { Err "未找到 mobius 入口: $entryJs"; exit 1 }
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$mainTsx   = Join-Path $GLOBAL_DIR "node_modules\@mobius-os\mobius\src\main.tsx"
$tsxCli    = Join-Path $GLOBAL_DIR "node_modules\tsx\dist\cli.mjs"
$mobiusCmd = Join-Path $binDir "mobius.cmd"
@"
@echo off
"$nodeExe" "$tsxCli" "$mainTsx" %*
"@ | Set-Content -Path $mobiusCmd -Encoding ASCII
Ok "启动器: $mobiusCmd"

# --- 4. 用户 PATH (无需 admin) ---
$userPath = [Environment]::GetEnvironmentVariable("Path","User")
if ($userPath -notlike "*$binDir*") {
    $newPath = if ($userPath) { "$userPath;$binDir" } else { $binDir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    $env:Path += ";$binDir"
    Ok "已加入用户 PATH: $binDir (重开 PowerShell 生效)"
} else {
    Ok "PATH 已含: $binDir"
}

# --- 5. Explorer 右键菜单 (当前用户，无需 admin) ----------------------------
# 两个入口必须同时注册：
#   Directory\shell\Mobius            = 右键文件夹本身，目标参数 %1
#   Directory\Background\shell\Mobius = 右键文件夹空白处，目标参数 %V
# 使用 .cmd 辅助启动器，避免右键动作依赖 PowerShell ExecutionPolicy。
$openHereCmd = [System.IO.Path]::Combine($MHOME, "bin", "mobius-open-here.cmd")
if ([string]::IsNullOrWhiteSpace($openHereCmd)) { Err "无法确定右键菜单辅助启动器路径"; exit 1 }
$openHereLines = @(
    '@echo off',
    'setlocal',
    'set "MOBIUS_TARGET=%~1"',
    'if not defined MOBIUS_TARGET set "MOBIUS_TARGET=%CD%"',
    'cd /d "%MOBIUS_TARGET%"',
    'call "%~dp0mobius.cmd"',
    'endlocal'
)
Set-Content -Path $openHereCmd -Value $openHereLines -Encoding ASCII

$classes = "HKCU:\Software\Classes"
$folderMenu = Join-Path $classes "Directory\shell\Mobius"
$folderCommand = Join-Path $folderMenu "command"
$backgroundMenu = Join-Path $classes "Directory\Background\shell\Mobius"
$backgroundCommand = Join-Path $backgroundMenu "command"

foreach ($key in @($folderCommand, $backgroundCommand)) {
    New-Item -Path $key -Force | Out-Null
}

foreach ($menu in @($folderMenu, $backgroundMenu)) {
    Set-ItemProperty -Path $menu -Name "MUIVerb" -Value "在 Mobius 中打开"
    Set-ItemProperty -Path $menu -Name "Icon" -Value "$env:SystemRoot\System32\cmd.exe,0"
}

# Explorer command quoting: cmd /c ""helper.cmd" "%1"".
$folderCommandValue = '"{0}" /d /s /c ""{1}" "%1""' -f $env:ComSpec, $openHereCmd
$backgroundCommandValue = '"{0}" /d /s /c ""{1}" "%V""' -f $env:ComSpec, $openHereCmd
Set-Item -Path $folderCommand -Value $folderCommandValue
Set-Item -Path $backgroundCommand -Value $backgroundCommandValue
Ok "右键菜单已添加: 在 Mobius 中打开 (文件夹 + 空白处)"

Write-Host ""
Write-Host "=== 完成! 重开 PowerShell 后运行:  mobius ===" -ForegroundColor Green
Write-Host "(或直接运行: $mobiusCmd)" -ForegroundColor Gray
Write-Host "右键文件夹或文件夹空白处，可选择: 在 Mobius 中打开" -ForegroundColor Gray
