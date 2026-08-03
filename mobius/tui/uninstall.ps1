#requires -Version 5.1
<#
.SYNOPSIS
  Completely uninstall the current-user Mobius TUI installation on Windows.
.DESCRIPTION
  Removes the portable Node runtime, npm package, launchers, AIMUX/Python bundle,
  saved login and preferences under ~/.mobius, user PATH entries, and both
  Explorer "Open in Mobius" context-menu registrations. No administrator rights
  are required. Unrelated system Node.js/Python/AIMUX installations are untouched.
.EXAMPLE
  irm https://serve.nutshellai.cn/publish/auto/mobiustui/uninstall-v11.ps1 | iex
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!]  $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "[X]  $m" -ForegroundColor Red }

function Normalize-PathEntry($value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return '' }
    return $value.Trim().Trim('"').TrimEnd('\')
}

function Invoke-MobiusUninstall {
    $mobiusHome = Join-Path $env:USERPROFILE '.mobius'
    $mobiusBin = Join-Path $mobiusHome 'bin'
    $npmGlobal = Join-Path $mobiusHome 'npm-global'
    $npmGlobalBin = Join-Path $npmGlobal 'bin'

    Write-Host '=== Mobius TUI Windows 全面卸载（当前用户）===' -ForegroundColor White
    Write-Host ''
    Warn "将永久删除: $mobiusHome"
    Warn '包括登录信息、项目缓存、目录绑定、Issue 偏好、便携 Node、TUI 和 AIMUX/Python bundle。'
    Warn '还会删除用户 PATH 中的 Mobius 项和两个“在 Mobius 中打开”右键菜单。'
    Write-Host ''

    if ($env:MOBIUS_UNINSTALL_FORCE -ne '1') {
        $confirmation = Read-Host '确认全面卸载请输入 UNINSTALL'
        if ($confirmation -cne 'UNINSTALL') {
            Warn '已取消，没有删除任何内容。'
            return
        }
    }

    Step '停止正在使用便携 Node 的 Mobius 进程...'
    $portableProcesses = @(Get-Process node -ErrorAction SilentlyContinue | Where-Object {
        try {
            $_.Path -and $_.Path.StartsWith($mobiusHome, [System.StringComparison]::OrdinalIgnoreCase)
        } catch {
            $false
        }
    })
    foreach ($process in $portableProcesses) {
        try {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
            Ok "已停止进程: node.exe (PID $($process.Id))"
        } catch {
            Warn "无法停止 PID $($process.Id): $($_.Exception.Message)"
        }
    }
    if ($portableProcesses.Count -eq 0) { Ok '没有正在运行的 Mobius Node 进程。' }
    Start-Sleep -Milliseconds 500

    Step '删除 Explorer 右键菜单...'
    $contextMenuKeys = @(
        'HKCU:\Software\Classes\Directory\shell\Mobius',
        'HKCU:\Software\Classes\Directory\Background\shell\Mobius'
    )
    foreach ($key in $contextMenuKeys) {
        if (Test-Path $key) { Remove-Item $key -Recurse -Force }
    }
    Ok '文件夹本身和文件夹空白处的右键菜单已删除。'

    Step '从当前用户 PATH 删除 Mobius 目录...'
    $removeEntries = @($mobiusBin, $npmGlobal, $npmGlobalBin) |
        ForEach-Object { Normalize-PathEntry $_ }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -ne $userPath) {
        $filteredUserPath = @($userPath -split ';' | Where-Object {
            $normalized = Normalize-PathEntry $_
            $normalized -and -not ($removeEntries -contains $normalized)
        })
        [Environment]::SetEnvironmentVariable('Path', ($filteredUserPath -join ';'), 'User')
    }
    $filteredCurrentPath = @($env:Path -split ';' | Where-Object {
        $normalized = Normalize-PathEntry $_
        $normalized -and -not ($removeEntries -contains $normalized)
    })
    $env:Path = $filteredCurrentPath -join ';'
    Ok '用户 PATH 已清理。'

    Step '清除 Mobius TUI 用户级环境变量...'
    foreach ($name in @('MOBIUS_TUI_HOME', 'MOBIUS_TUI_PYTHON', 'MOBIUS_TUI_PYTHON_BUNDLE_URL')) {
        [Environment]::SetEnvironmentVariable($name, $null, 'User')
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
    Ok 'Mobius TUI 用户级环境变量已清理。'

    Step '删除 Mobius TUI 的全部用户数据和运行时...'
    if (Test-Path $mobiusHome) {
        $removed = $false
        for ($attempt = 1; $attempt -le 4 -and -not $removed; $attempt++) {
            Remove-Item $mobiusHome -Recurse -Force -ErrorAction SilentlyContinue
            $removed = -not (Test-Path $mobiusHome)
            if (-not $removed) { Start-Sleep -Milliseconds (500 * $attempt) }
        }
        if (-not $removed) {
            throw "无法完全删除 $mobiusHome；仍有进程或安全软件占用其中的文件。"
        }
    }
    Ok "已删除: $mobiusHome"

    Step '删除临时安装器和旧错误日志...'
    Get-ChildItem $env:TEMP -Filter 'mobius-install-v*.ps1' -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:TEMP 'mobius-install-v10-error.log') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:TEMP 'mobius-install-v11-error.log') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:TEMP 'mobius-uninstall-v11-error.log') -Force -ErrorAction SilentlyContinue
    Ok '临时安装文件已清理。'

    Write-Host ''
    Write-Host '=== Mobius TUI 已全面卸载 ===' -ForegroundColor Green
    Write-Host '请关闭并重新打开 PowerShell/Explorer，使 PATH 和右键菜单刷新。' -ForegroundColor Gray
}

try {
    Invoke-MobiusUninstall
} catch {
    $errorLog = Join-Path $env:TEMP 'mobius-uninstall-v11-error.log'
    $errorText = $_ | Format-List * -Force | Out-String
    $errorText | Set-Content -Path $errorLog -Encoding UTF8
    Write-Host ''
    Err "Mobius 卸载失败: $($_.Exception.Message)"
    Write-Host "完整错误日志: $errorLog" -ForegroundColor Yellow
    Write-Host $errorText -ForegroundColor DarkYellow
    try { Read-Host '按 Enter 返回 PowerShell（窗口不会自动关闭）' | Out-Null } catch { }
    return
}
