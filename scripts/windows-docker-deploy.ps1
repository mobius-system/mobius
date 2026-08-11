# windows-docker-deploy.ps1
# =============================================================================
# Mobius Windows Docker - Stage 1 bootstrap.
#
# This script does ONE thing: ensure a portable Python 3 runtime exists,
# then delegates EVERYTHING else to windows-docker-deploy.py (Stage 2).
#
# Usage:
#   .\scripts\windows-docker-deploy.ps1
#   .\scripts\windows-docker-deploy.ps1 -ProxyHost 111.36.208.22 -ProxyPort 12321 -ProxyUser fuqingxu -ProxyPass claraclara
# =============================================================================

param(
    [string] $ProxyHost = "",
    [string] $ProxyPort = "",
    [string] $ProxyUser = "",
    [string] $ProxyPass = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path "$ScriptDir\.."
$PortablePythonDir = "$ProjectRoot\.python-portable"
$PythonExe = "$PortablePythonDir\python.exe"

# -----------------------------------------------------------------------------
# 1.  Ensure portable Python 3.10 embeddable package
# -----------------------------------------------------------------------------
if (-not (Test-Path $PythonExe)) {
    Write-Host "[*] Portable Python not found - downloading Python 3.10 embeddable ..." -ForegroundColor Cyan

    $zipUrl = "https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip"
    $zipFile = "$env:TEMP\python-embed-amd64.zip"

    New-Item -ItemType Directory -Path $PortablePythonDir -Force | Out-Null
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -UseBasicParsing
    Expand-Archive -Path $zipFile -DestinationPath $PortablePythonDir -Force
    Remove-Item $zipFile

    # Enable site-packages so stdlib works fully (uncomment "import site" in ._pth)
    $pthFile = Get-ChildItem "$PortablePythonDir\python*._pth" | Select-Object -First 1
    if ($pthFile) {
        $c = Get-Content $pthFile.FullName
        $c = $c -replace "^#import site", "import site"
        $c = $c -replace "^#Lib", "Lib"
        $c | Set-Content $pthFile.FullName -Encoding ASCII
    }

    Write-Host "[+] Portable Python installed: $PythonExe" -ForegroundColor Green
    & $PythonExe --version
} else {
    Write-Host "[*] Portable Python found: $PythonExe" -ForegroundColor Cyan
    & $PythonExe --version
}

# -----------------------------------------------------------------------------
# 2.  Delegate to windows-docker-deploy.py (Stage 2)
# -----------------------------------------------------------------------------
$pyScript = "$ScriptDir\windows-docker-deploy.py"
if (-not (Test-Path $pyScript)) {
    Write-Host "[-] Missing stage-2 script: $pyScript" -ForegroundColor Red
    exit 1
}

$pyArgs = @($pyScript)
if ($ProxyHost) { $pyArgs += "--proxy-host", $ProxyHost }
if ($ProxyPort) { $pyArgs += "--proxy-port", $ProxyPort }
if ($ProxyUser) { $pyArgs += "--proxy-user", $ProxyUser }
if ($ProxyPass) { $pyArgs += "--proxy-pass", $ProxyPass }

Write-Host "[*] Delegating to windows-docker-deploy.py ..." -ForegroundColor Cyan
& $PythonExe @pyArgs
exit $LASTEXITCODE
