#!/usr/bin/env python3
"""Build the double-clickable Windows installer (.cmd) from install.ps1.

A .ps1 cannot be double-clicked: Explorer opens it in Notepad and the default
execution policy blocks it. A .cmd can, so this script appends the exact
install.ps1 payload to a small batch stub.

Two constraints shape the layout:

* The stub is ASCII-only. cmd.exe decodes batch files with the console code
  page; UTF-8 Chinese inside the stub would print as mojibake. All Chinese
  output comes from the PowerShell payload, which is a real UTF-8 file.
* cmd.exe executes batch line by line and every outcome in the stub ends with
  "exit /b" before the marker line, so the appended PowerShell text is never
  parsed as batch. The stub uses PowerShell to slice the payload out of its own
  file (PowerShell knows the file is UTF-8) and runs it with -File, which also
  keeps `#requires` handling and exit codes intact.

Usage:
    python3 mobius/tui/scripts/build-install-cmd.py
    python3 mobius/tui/scripts/build-install-cmd.py --version v21
"""
from __future__ import annotations

import argparse
import hashlib
import pathlib
import sys

STUB_PS1 = pathlib.Path(__file__).resolve().parents[1] / "install.ps1"
REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT_DIR = REPO_ROOT / "mobius" / "installers"
MARKER = "#__MOBIUS_INSTALLER_PAYLOAD__"

STUB = r"""@echo off
rem ===================================================================
rem  Mobius TUI installer for Windows - double-click to run.
rem
rem  GENERATED FILE, do not edit by hand. Rebuild with:
rem      python3 mobius/tui/scripts/build-install-cmd.py
rem  Payload source of truth: mobius/tui/install.ps1
rem
rem  The stub is ASCII-only on purpose: cmd.exe decodes batch files with the
rem  console code page, which would mangle UTF-8 Chinese. Everything the user
rem  reads comes from the PowerShell payload appended below the marker.
rem  cmd.exe executes this file line by line and every path here ends with
rem  "exit /b" before the marker, so the payload is never parsed as batch.
rem  The stub mentions the marker text itself, so the payload is located with
rem  LastIndexOf (the marker line is always the final occurrence).
rem ===================================================================
setlocal
set "MOBIUS_INSTALL_LAUNCHER=1"
set "MOBIUS_SELF=%~f0"
set "MOBIUS_PAYLOAD=%TEMP%\mobius-install-%RANDOM%%RANDOM%.ps1"

echo.
echo Preparing the Mobius TUI installer...
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $text = Get-Content -LiteralPath $env:MOBIUS_SELF -Raw -Encoding UTF8; $marker = '#__MOBIUS_INSTALLER_PAYLOAD__'; $at = $text.LastIndexOf($marker); if ($at -lt 0) { throw 'installer payload marker missing' }; $body = $text.Substring($at + $marker.Length).TrimStart(); [IO.File]::WriteAllText($env:MOBIUS_PAYLOAD, $body, (New-Object System.Text.UTF8Encoding($true))) } catch { Write-Host ('[X] ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 (
    echo.
    echo [X] Could not unpack the installer. Please download the file again.
    echo.
    pause
    exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%MOBIUS_PAYLOAD%"
set "MOBIUS_RC=%ERRORLEVEL%"
del /f /q "%MOBIUS_PAYLOAD%" >nul 2>&1

echo.
if not "%MOBIUS_RC%"=="0" echo [X] Installation failed. Exit code: %MOBIUS_RC%
echo.
pause
exit /b %MOBIUS_RC%

"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the double-clickable Windows installer.")
    parser.add_argument("--version", default="v20", help="installer version used in the file name")
    args = parser.parse_args()

    payload = STUB_PS1.read_text(encoding="utf-8")
    if MARKER in payload:
        print(f"error: {STUB_PS1} already contains the marker {MARKER}", file=sys.stderr)
        return 1
    # A BOM would break cmd.exe's first line and confuse Get-Content -Encoding UTF8.
    if payload.startswith("\ufeff"):
        payload = payload[1:]
    if not payload.startswith("#requires"):
        print(f"error: {STUB_PS1} must start with a #requires line", file=sys.stderr)
        return 1

    non_ascii = [(i, line) for i, line in enumerate(STUB.splitlines(), 1) if not line.isascii()]
    if non_ascii:
        print(f"error: batch stub must stay ASCII-only, offending line {non_ascii[0][0]}: {non_ascii[0][1]!r}",
              file=sys.stderr)
        return 1

    # cmd.exe needs CRLF; the payload goes through unchanged apart from line endings.
    content = (STUB + MARKER + "\r\n" + payload).replace("\r\n", "\n").replace("\n", "\r\n")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"tui-install-{args.version}.cmd"
    with out.open("w", encoding="utf-8", newline="") as handle:
        handle.write(content)

    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    print(f"wrote {out.relative_to(REPO_ROOT)} ({len(content.encode('utf-8'))} bytes, sha256 {digest})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
