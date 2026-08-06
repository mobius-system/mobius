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
  irm https://serve.nutshellai.cn/publish/auto/mobiustui/install-v15.ps1 | iex
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

function Step($m){ Write-Host "[*] $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "[OK] $m" -ForegroundColor Green }
function Warn($m){ Write-Host "[!]  $m" -ForegroundColor Yellow }
function Err($m) { Write-Host "[X]  $m" -ForegroundColor Red }
function Fail($m) { throw $m }

function Invoke-MobiusInstall {
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
    if ($actual -ne $NODE_SHA256.ToLower()) { Fail "Node zip sha256 不匹配 (下载损坏? 期望 $NODE_SHA256 实际 $actual)" }
    Step "解压..."
    $tmp = Join-Path $MHOME "_extract"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Join-Path $tmp "node-$NODE_VER-win-x64"
    if (-not (Test-Path (Join-Path $inner "node.exe"))) { Fail "解压后未找到 node.exe" }
    if (Test-Path $NODE_DIR) { Remove-Item $NODE_DIR -Recurse -Force }
    Move-Item $inner $NODE_DIR -Force
    Remove-Item $tmp -Recurse -Force
    Remove-Item $zip -Force
    Ok "便携 Node 就绪: $NODE_DIR"
}

# --- 2. npm 装 @mobius-os/mobius (node.exe 直跑 npm-cli.js, 绕过 npm.ps1 的 ExecutionPolicy 拦截) ---
Step "npm 安装 @mobius-os/mobius@latest (本地 install 到便携目录, 官方 registry)..."
New-Item -ItemType Directory -Force -Path $GLOBAL_DIR | Out-Null
$oldNodeModules = Join-Path $GLOBAL_DIR "node_modules"
$oldPackageJson = Join-Path $GLOBAL_DIR "package.json"
for ($attempt = 1; $attempt -le 3 -and (Test-Path $oldNodeModules); $attempt++) {
    Remove-Item $oldNodeModules -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $oldNodeModules) { Start-Sleep -Milliseconds (300 * $attempt) }
}
if (Test-Path $oldNodeModules) {
    Warn "请关闭正在运行的 mobius 终端后重试: $oldNodeModules"
    Fail "无法清理旧 node_modules，可能仍有 Mobius/Node 进程占用文件"
}
Remove-Item $oldPackageJson -Force -ErrorAction SilentlyContinue
$npmLog = Join-Path $MHOME "npm-install.log"
$npmStdout = Join-Path $MHOME "npm-install.stdout.log"
$npmStderr = Join-Path $MHOME "npm-install.stderr.log"
$previousPath = $env:Path
# npm lifecycle scripts use cmd.exe and resolve `node` from PATH.
$env:Path = "$NODE_DIR;$env:Path"
Push-Location $GLOBAL_DIR
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    # PowerShell 5.1 会把 npm 的 stderr warning 包装成 NativeCommandError。
    # 合并输出并只依据原生进程退出码判定成败，避免 warning 提前终止脚本。
    & $nodeExe $npmCli init -y 2>&1 | Out-Null
    $initExitCode = $LASTEXITCODE
    if ($initExitCode -ne 0) { throw "npm 初始化失败 (退出码 $initExitCode)" }

    # npm 11 默认拦截 esbuild postinstall，安装前明确允许该脚本。旧 npm 会忽略该字段。
    & $nodeExe $npmCli pkg set "allowScripts.esbuild=true" --json 2>&1 | Out-Null
    $configExitCode = $LASTEXITCODE
    if ($configExitCode -ne 0) { throw "配置 esbuild 安装脚本授权失败 (退出码 $configExitCode)" }

    function Invoke-NpmInstallAttempt([string]$registry, [int]$timeoutSeconds) {
        Remove-Item $npmStdout, $npmStderr -Force -ErrorAction SilentlyContinue
        # Do not call System.Diagnostics.Process instance methods here.
        # Windows PowerShell ConstrainedLanguage blocks those methods even
        # though Start-Process itself is allowed. A tiny cmd wrapper records
        # %ERRORLEVEL%; Wait-Process and taskkill remain CLM-safe.
        $attemptCmd = Join-Path $GLOBAL_DIR 'npm-install-attempt.cmd'
        $exitCodeFile = Join-Path $GLOBAL_DIR 'npm-install.exitcode'
        Remove-Item $exitCodeFile -Force -ErrorAction SilentlyContinue
        $attemptLines = @(
            '@echo off',
            'setlocal',
            ('set "PATH={0};%PATH%"' -f $NODE_DIR),
            ('"{0}" "{1}" install "@mobius-os/mobius@latest" --registry "{2}" --loglevel warn >"{3}" 2>"{4}"' -f $nodeExe, $npmCli, $registry, $npmStdout, $npmStderr),
            'set "EXIT_CODE=%ERRORLEVEL%"',
            ('>"{0}" echo %EXIT_CODE%' -f $exitCodeFile),
            'exit /b %EXIT_CODE%'
        )
        Set-Content -Path $attemptCmd -Value $attemptLines -Encoding ASCII
        $proc = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', ('"{0}"' -f $attemptCmd)) `
            -WorkingDirectory $GLOBAL_DIR -PassThru -WindowStyle Hidden
        Wait-Process -Id $proc.Id -Timeout $timeoutSeconds -ErrorAction SilentlyContinue | Out-Null
        # Allow cmd a short moment to flush the marker after it exits, without
        # invoking any restricted Process instance methods.
        for ($markerAttempt = 1; $markerAttempt -le 20 -and -not (Test-Path $exitCodeFile); $markerAttempt++) {
            Start-Sleep -Milliseconds 100
        }
        if (-not (Test-Path $exitCodeFile)) {
            Warn "npm 官方源安装超过 $timeoutSeconds 秒，正在终止并切换镜像源..."
            & $env:ComSpec /d /s /c "taskkill /PID $($proc.Id) /T /F" 2>&1 | Out-Null
            Start-Sleep -Milliseconds 300
            Remove-Item $attemptCmd -Force -ErrorAction SilentlyContinue
            return @{ TimedOut = $true; ExitCode = $null }
        }
        $exitText = Get-Content -Path $exitCodeFile -Raw -ErrorAction SilentlyContinue
        $exitCode = $exitText -as [int]
        if ($null -eq $exitCode) { $exitCode = 1 }
        Remove-Item $attemptCmd, $exitCodeFile -Force -ErrorAction SilentlyContinue
        return @{ TimedOut = $false; ExitCode = $exitCode }
    }

    function Save-NpmAttemptLog([string]$label) {
        Add-Content -Path $npmLog -Value "`n===== $label ====="
        if (Test-Path $npmStdout) { Get-Content $npmStdout | Add-Content -Path $npmLog }
        if (Test-Path $npmStderr) { Get-Content $npmStderr | Add-Content -Path $npmLog }
    }

    Remove-Item $npmLog -Force -ErrorAction SilentlyContinue
    $official = Invoke-NpmInstallAttempt "https://registry.npmjs.org/" 10
    Save-NpmAttemptLog "official registry.npmjs.org"
    $npmSucceeded = (-not $official.TimedOut -and $official.ExitCode -eq 0)
    if (-not $npmSucceeded) {
        if ($official.TimedOut) {
            Warn "官方源超时，切换 npmmirror 镜像源重试..."
        } else {
            Warn "官方源安装失败 (退出码 $($official.ExitCode))，切换 npmmirror 镜像源重试..."
        }
        # A timed-out npm process can leave a partial tree behind; remove only
        # the package tree and keep the user-level install directory intact.
        if (Test-Path $oldNodeModules) { Remove-Item $oldNodeModules -Recurse -Force -ErrorAction SilentlyContinue }
        $mirror = Invoke-NpmInstallAttempt "https://registry.npmmirror.com/" 120
        Save-NpmAttemptLog "mirror registry.npmmirror.com"
        $npmSucceeded = (-not $mirror.TimedOut -and $mirror.ExitCode -eq 0)
    }
    if (-not $npmSucceeded) {
        Err "npm 安装失败"
        if (Test-Path $npmLog) {
            Write-Host "--- npm 最近日志: $npmLog ---" -ForegroundColor Yellow
            Get-Content $npmLog -Tail 120
            Write-Host "--- npm 日志结束 ---" -ForegroundColor Yellow
        }
        Fail "npm 安装失败，完整日志: $npmLog"
    }
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
    $env:Path = $previousPath
    Pop-Location
}
$tsxCli = Join-Path $GLOBAL_DIR "node_modules\tsx\dist\cli.mjs"
$esbuildExe = Join-Path $GLOBAL_DIR "node_modules\@esbuild\win32-x64\esbuild.exe"
if (-not (Test-Path $tsxCli)) { Fail "npm 包缺少 tsx 运行时依赖，日志: $npmLog" }
if (-not (Test-Path $esbuildExe)) { Fail "esbuild Windows 二进制未正确安装，日志: $npmLog" }
Ok "mobius 装到: $GLOBAL_DIR"

# --- 3. mobius 启动器 (.cmd batch, 用绝对路径指向便携 node, 不依赖系统 PATH/ExecutionPolicy) ---
$binDir   = Join-Path $MHOME "bin"
$entryJs  = Join-Path $GLOBAL_DIR "node_modules\@mobius-os\mobius\bin\mobius-tui.js"
if (-not (Test-Path $entryJs)) { Fail "未找到 mobius 入口: $entryJs" }
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$mainTsx   = Join-Path $GLOBAL_DIR "node_modules\@mobius-os\mobius\src\main.tsx"
$mobiusCmd = Join-Path $binDir "mobius.cmd"
@"
@echo off
"$nodeExe" "$tsxCli" "$mainTsx" %*
"@ | Set-Content -Path $mobiusCmd -Encoding ASCII
Ok "启动器: $mobiusCmd"

# --- 4. 用户 PATH (无需 admin) ---
$userPath = (Get-ItemProperty -Path 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path
if ($userPath -notlike "*$binDir*") {
    $newPath = if ($userPath) { "$userPath;$binDir" } else { $binDir }
    if (Test-Path 'HKCU:\Environment') {
        Set-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value $newPath
    } else {
        New-Item -Path 'HKCU:\Environment' -Force | Out-Null
        New-ItemProperty -Path 'HKCU:\Environment' -Name Path -Value $newPath -PropertyType ExpandString -Force | Out-Null
    }
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
$openHereCmd = Join-Path $binDir "mobius-open-here.cmd"
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
}

try {
    Invoke-MobiusInstall
} catch {
    $errorLog = Join-Path $env:TEMP "mobius-install-v15-error.log"
    $errorText = $_ | Format-List * -Force | Out-String
    $errorText | Set-Content -Path $errorLog -Encoding UTF8
    Write-Host ""
    Err "Mobius 安装失败: $($_.Exception.Message)"
    Write-Host "完整错误日志: $errorLog" -ForegroundColor Yellow
    Write-Host $errorText -ForegroundColor DarkYellow
    try { Read-Host "按 Enter 返回 PowerShell（窗口不会自动关闭）" | Out-Null } catch { }
    return
}
