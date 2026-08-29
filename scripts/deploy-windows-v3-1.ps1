#requires -Version 5.1
<#
.SYNOPSIS
  Mobius Windows Docker 一键部署（PowerShell 5.1+）。
.DESCRIPTION
  检查 Docker Desktop、克隆或更新 Mobius、生成配置、构建镜像并等待健康检查。
  脚本可通过 irm <url> | iex 执行，不要求管理员权限；Docker Desktop、Git 和 Python 3
  需要用户预先安装。安装目录可用 -InstallDir 覆盖（直接运行保存后的脚本时）。
.EXAMPLE
  irm https://serve.nutshellai.cn/publish/auto/tutorial/deploy-windows-v3-1.ps1 | iex
#>

param(
    [string] $InstallDir = (Join-Path $env:USERPROFILE "mobius")
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Say([string] $Message) { Write-Host "[mobius] $Message" -ForegroundColor Cyan }
function Ok([string] $Message) { Write-Host "[mobius] $Message" -ForegroundColor Green }
function Warn([string] $Message) { Write-Host "[mobius] $Message" -ForegroundColor Yellow }
function Fail([string] $Message) { throw $Message }

function Invoke-Checked([string] $Command, [string[]] $Arguments) {
    Say ("执行: {0} {1}" -f $Command, ($Arguments -join " "))
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { Fail ("命令失败（退出码 {0}）: {1}" -f $LASTEXITCODE, $Command) }
}

function Test-Command([string] $Name) {
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-DockerInfo {
    # Windows PowerShell 5.1 promotes native stderr to NativeCommandError when
    # $ErrorActionPreference=Stop. Capture both streams to files while allowing
    # the native command to finish, then trust only its actual exit code.
    $stdoutFile = Join-Path $env:TEMP ("mobius-docker-info-{0}.out" -f $PID)
    $stderrFile = Join-Path $env:TEMP ("mobius-docker-info-{0}.err" -f $PID)
    Remove-Item $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & docker info 1>$stdoutFile 2>$stderrFile
        $exitCode = $LASTEXITCODE
    } catch {
        $exitCode = 1
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    $output = if (Test-Path $stdoutFile) { Get-Content $stdoutFile -Raw -ErrorAction SilentlyContinue } else { "" }
    $errorOutput = if (Test-Path $stderrFile) { Get-Content $stderrFile -Raw -ErrorAction SilentlyContinue } else { "" }
    Remove-Item $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
    return @{ ExitCode = $exitCode; Output = [string]$output; Error = [string]$errorOutput }
}

function Wait-DockerReady {
    if (-not (Test-Command "docker")) {
        Fail "未找到 docker。请安装并启动 Docker Desktop: https://www.docker.com/products/docker-desktop/"
    }

    $probe = Invoke-DockerInfo
    if ($probe.ExitCode -ne 0 -and (Test-Path "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe")) {
        Say "Docker 引擎未运行，正在启动 Docker Desktop..."
        Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe" | Out-Null
    }

    for ($i = 1; $i -le 60; $i++) {
        $probe = Invoke-DockerInfo
        if (($probe.ExitCode -eq 0) -and ($probe.Output -match "OSType:\s*linux")) { break }
        if ($i -eq 1) { Say "等待 Docker Desktop 引擎就绪（最多 5 分钟）..." }
        if (($i % 3) -eq 0) { Say ("Docker 引擎仍在启动（已等待 {0} 秒）..." -f ($i * 5)) }
        Start-Sleep -Seconds 5
    }
    if ($probe.Output -match "OSType:\s*windows") {
        Fail "当前 Docker 使用 Windows containers，请在 Docker Desktop 菜单切换到 Linux containers。"
    }
    if (($probe.ExitCode -ne 0) -or ($probe.Output -notmatch "OSType:\s*linux")) {
        Fail "Docker 引擎未就绪。请打开 Docker Desktop，切换到 Linux containers 后重新运行。"
    }
    Ok "Docker 引擎运行中（Linux containers）"
    if (-not (Test-Command "git")) { Fail "未找到 git。请安装 Git for Windows: https://git-scm.com/download/win" }
    if (-not (Test-Command "python")) {
        if (Test-Command "python3") { $script:PythonCommand = "python3" }
        else { Fail "未找到 Python 3。请安装 Python 3.10+: https://www.python.org/downloads/windows/" }
    } else { $script:PythonCommand = "python" }
    try { $pythonVersion = & $script:PythonCommand --version 2>&1 } catch { $pythonVersion = "" }
    if (($LASTEXITCODE -ne 0) -or ([string]$pythonVersion -notmatch '^Python 3\.(1[0-9]|[2-9][0-9])')) {
        Fail "需要 Python 3.10 或更高版本。请安装后确认 python --version 可用。"
    }
    try { & docker compose version 2>$null | Out-Null } catch { Fail "需要 Docker Compose v2（docker compose）。请更新 Docker Desktop。" }
    if ($LASTEXITCODE -ne 0) { Fail "需要 Docker Compose v2（docker compose）。请更新 Docker Desktop。" }
}

function Test-FreeDisk([string] $Root) {
    $fullPath = [IO.Path]::GetFullPath($Root)
    $driveName = [IO.Path]::GetPathRoot($fullPath).Substring(0, 1)
    $drive = Get-PSDrive -Name $driveName -ErrorAction Stop
    $freeGb = [math]::Floor($drive.Free / 1GB)
    if ($freeGb -lt 20) { Fail "磁盘可用空间不足（当前 ${freeGb}GB，建议至少 20GB）。" }
    Ok "前置体检通过（Git / Python / Docker Compose / 磁盘 ${freeGb}GB 可用）"
}

function Ensure-Repository([string] $Root) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Root) | Out-Null
    if (-not (Test-Path (Join-Path $Root ".git"))) {
        Say "首次部署，克隆 Mobius 到 $Root ..."
        Invoke-Checked "git" @("clone", "https://floral-sun-8219.mobius-os.workers.dev/https://github.com/mobius-system/mobius.git", $Root)
    } else {
        Say "使用已有仓库: $Root"
        Push-Location $Root
        try {
            $dirty = (& git status --porcelain 2>$null)
            if ($dirty) { Warn "工作区有本地改动，跳过 git pull。" }
            else {
                & git fetch origin main --quiet 2>$null
                if ($LASTEXITCODE -eq 0) { & git merge --ff-only FETCH_HEAD 2>$null | Out-Null }
                if ($LASTEXITCODE -ne 0) { Warn "无法自动更新仓库，继续使用当前版本。" }
            }
        } finally { Pop-Location }
    }
}

function Ensure-ChinaDockerfiles([string] $Root) {
    $base = Join-Path $Root "deploy\Dockerfile4zh"
    $exe = Join-Path $Root "Dockerfile4zh"
    if (-not ((Test-Path $base) -and (Test-Path $exe))) {
        Say "下载中国网络适配 Dockerfile4zh ..."
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "https://serve.nutshellai.cn/publish/auto/tutorial/deploy-Dockerfile4zh" -OutFile $base
            Invoke-WebRequest -UseBasicParsing -Uri "https://serve.nutshellai.cn/publish/auto/tutorial/Dockerfile4zh" -OutFile $exe
            Ok "Dockerfile4zh 已就位"
        } catch {
            Remove-Item $base, $exe -Force -ErrorAction SilentlyContinue
            Warn "Dockerfile4zh 下载失败，将使用仓库内官方 Dockerfile。"
        }
    }
    if (Test-Path $base) {
        $baseText = Get-Content $base -Raw
        if ($baseText -match '(?m)^FROM\s+node:18-bookworm\s*$') {
            $baseText = $baseText -replace '(?m)^FROM\s+node:18-bookworm\s*$', 'FROM docker.1ms.run/library/node:18-bookworm'
            [IO.File]::WriteAllText($base, $baseText, (New-Object Text.UTF8Encoding($false)))
            Say "已将基础镜像切换到 docker.1ms.run 镜像源"
        }
    }
}

function Get-EnvValue([string] $Root, [string] $Name, [string] $Fallback) {
    $line = Get-Content (Join-Path $Root ".env") -ErrorAction SilentlyContinue |
        Where-Object { $_ -match ("^" + [regex]::Escape($Name) + "=") } | Select-Object -Last 1
    if ($line) { return ($line -split "=", 2)[1].Trim().Trim('"') }
    return $Fallback
}

function Print-BootstrapUsers([string] $Root) {
    $line = Get-EnvValue $Root "MOBIUS_BOOTSTRAP_USERS" ""
    if (-not $line) { return }
    Write-Host ""
    Say "初始登录账号（请妥善保存）"
    foreach ($entry in ($line -split ';')) {
        if ($entry) { Write-Host ("  {0}" -f $entry) }
    }
}

try {
    Write-Host ""
    Say "Mobius Windows 一键部署（deploy-windows-v2）"
    Say "目录: $InstallDir"
    Wait-DockerReady
    Test-FreeDisk $InstallDir
    Ensure-Repository $InstallDir
    Ensure-ChinaDockerfiles $InstallDir

    Push-Location $InstallDir
    try {
        if (-not (Test-Path ".env")) {
            Say "生成 .env（随机 JWT 密钥和初始密码）..."
            Invoke-Checked $script:PythonCommand @("conf_prepare.py", "--docker")
        } else { Say ".env 已存在，跳过生成。" }
        Invoke-Checked $script:PythonCommand @("conf_check.py", "--docker")

        foreach ($dir in @("host-data\app", "host-data\data", "host-data\codex", "host-data\claude")) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
        $baseDockerfile = if ((Test-Path "deploy\Dockerfile4zh") -and (Test-Path "Dockerfile4zh")) { "deploy\Dockerfile4zh" } else { "deploy\Dockerfile" }
        $exeDockerfile = if ($baseDockerfile -eq "deploy\Dockerfile4zh") { "Dockerfile4zh" } else { "Dockerfile" }
        if ($baseDockerfile -eq "deploy\Dockerfile4zh") {
            $baseContent = Get-Content $baseDockerfile -Raw
            if ($baseContent -match '(?m)^FROM\s+node:18-bookworm\s*$') {
                $baseContent = $baseContent -replace '(?m)^FROM\s+node:18-bookworm\s*$', 'FROM docker.1ms.run/library/node:18-bookworm'
                [IO.File]::WriteAllText($baseDockerfile, $baseContent, (New-Object Text.UTF8Encoding($false)))
                Say "已将基础镜像切换到 docker.1ms.run 镜像源"
            }
        }
        Say "构建基础镜像（首次可能需要 10-20 分钟）..."
        Invoke-Checked "docker" @("build", "-t", "mobius-system-base:latest", "-f", $baseDockerfile, ".")
        Say "构建应用镜像..."
        Invoke-Checked "docker" @("build", "-t", "mobius-system-exe:latest", "-f", $exeDockerfile, ".")
        Invoke-Checked "docker" @("compose", "up", "-d")

        $webPort = Get-EnvValue $InstallDir "VITE_PORT" "33316"
        $health = "http://localhost:{0}/api/v2/health" -f $webPort
        Say "等待服务就绪（最多 10 分钟）: $health"
        $ready = $false
        for ($i = 1; $i -le 120; $i++) {
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $health -TimeoutSec 5 | Out-Null
                $ready = $true; break
            } catch { }
            if (($i % 12) -eq 0) { Say ("仍在启动中（{0} 秒），最近日志：" -f ($i * 5)); & docker compose logs --tail=5 2>$null }
            Start-Sleep -Seconds 5
        }
        if (-not $ready) {
            Warn "健康检查超时。请在 $InstallDir 执行: docker compose logs --tail=100"
            Fail "部署未完成，容器可能仍在启动。"
        }
        Ok "部署成功"
        Write-Host "登录地址: http://localhost:$webPort" -ForegroundColor Green
        Print-BootstrapUsers $InstallDir
        Write-Host "常用命令: docker compose ps / docker compose logs -f / docker compose down" -ForegroundColor Gray
    } finally { Pop-Location }
} catch {
    Write-Host ""; Write-Host ("[mobius] 部署失败: {0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host "可重新运行同一条命令继续，已有 .env 和镜像会复用。" -ForegroundColor Yellow
    try { Read-Host "按 Enter 返回 PowerShell（窗口不会自动关闭）" | Out-Null } catch { }
    return
}
