#!/usr/bin/env python3
#
#   python3 build.py --build-electron
#
#
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
DESKTOP_DIR = REPO_ROOT / "mobius" / "desktop"
SERVE_DIR = REPO_ROOT / "mobius" / "desktop-builds"
MODALS_TSX = REPO_ROOT / "mobius" / "frontend" / "src" / "components" / "modals.tsx"
START_PY = REPO_ROOT / "start.py"
TMP_DIR = Path("/tmp")

# (artifactName = ${productName}-${version}-${os}-${arch})。
TARGETS: dict[str, dict[str, str]] = {
    "win-x64": {"plat": "win", "arch": "x64", "os": "win", "farch": "x64"},
    "mac-arm64": {"plat": "mac", "arch": "arm64", "os": "mac", "farch": "arm64"},
    "mac-x64": {"plat": "mac", "arch": "x64", "os": "mac", "farch": "x64"},
}

EB_BASE_CONFIG: dict = {
    "appId": "com.agentmatrix.mobius.desktop",
    "productName": "Mobius Desktop",
    "artifactName": "${productName}-${version}-${os}-${arch}.${ext}",
    "files": ["out/**/*", "package.json"],
    "extraMetadata": {"main": "out/main/index.js"},
    "asar": True,
    "win": {"target": ["zip"], "signAndEditExecutable": False},
    "mac": {"target": ["zip"], "identity": None},
    "nsis": {"oneClick": False, "allowToChangeInstallationDirectory": True},
}


def run(cmd: list[str], cwd: Path | None = None) -> None:
    print(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=True)


def npx_bin(name: str) -> str:
    return str(DESKTOP_DIR / "node_modules" / ".bin" / name)


def read_desktop_version() -> str:
    return json.loads((DESKTOP_DIR / "package.json").read_text(encoding="utf-8"))["version"]


def ensure_node_modules() -> None:
    if not (DESKTOP_DIR / "node_modules" / ".bin" / "electron-builder").exists():
        sys.exit(
            f"[build] missing {DESKTOP_DIR}/node_modules.\n"
            f"        run this once in that directory first: cd mobius/desktop && npm install"
        )


def build_renderer_once() -> None:
    print("=== [1] electron-vite build (out/) ===")
    run([npx_bin("electron-vite"), "build"], cwd=DESKTOP_DIR)


def fetch_python(key: str) -> None:
    print(f"--- fetch-python {key} ---")
    run([npx_bin("tsx"), "scripts/fetch-python.ts", key], cwd=DESKTOP_DIR)


def write_arch_config(key: str) -> Path:
    cfg = json.loads(json.dumps(EB_BASE_CONFIG))  # deep copy
    cfg["directories"] = {"output": f"release/{key}"}
    cfg["extraResources"] = [
        {"from": f"resources/python-{key}", "to": "python", "filter": ["**/*"]},
        {"from": "build/icon.png", "to": "icon.png"},
    ]
    cfg_path = TMP_DIR / f"mobius-eb-{key}.json"
    cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return cfg_path


def produced_zip_name(version: str, key: str) -> str:
    # artifactName = ${productName}-${version}-${os}-${arch}.${ext}, productName="Mobius Desktop"。
    t = TARGETS[key]
    return f"Mobius Desktop-{version}-{t['os']}-{t['farch']}.zip"


def published_zip_name(version: str, key: str) -> str:
    t = TARGETS[key]
    return f"mobius-desktop-{version}-{t['os']}-{t['farch']}.zip"


def eb_cmd(key: str, cfg_path: Path) -> list[str]:
    t = TARGETS[key]
    return [npx_bin("electron-builder"), f"--{t['plat']}", f"--{t['arch']}", "--config", str(cfg_path)]


def publish(key: str, version: str) -> Path:
    produced = DESKTOP_DIR / "release" / key / produced_zip_name(version, key)
    if not produced.exists():
        sys.exit(
            f"[build] expected artifact does not exist: {produced}\n"
            f"        check release/{key}/ for the actual filename, or /tmp/mobius-eb-{key}.log for errors"
        )
    SERVE_DIR.mkdir(parents=True, exist_ok=True)
    dest = SERVE_DIR / published_zip_name(version, key)
    shutil.copy2(produced, dest)
    return dest


def build_targets(targets: list[str], version: str, parallel: bool) -> None:
    plans: list[tuple[str, Path, Path]] = []
    for key in targets:
        if not (DESKTOP_DIR / "resources" / f"python-{key}").exists():
            sys.exit(f"[build] missing resources/python-{key}; make sure fetch-python {key} succeeded first")
        plans.append((key, write_arch_config(key), TMP_DIR / f"mobius-eb-{key}.log"))

    if parallel and len(plans) > 1:
        print(f"=== [2] electron-builder x {len(plans)} parallel (independent config/output per arch) ===")
        procs: list[tuple[str, subprocess.Popen, object, Path]] = []
        for key, cfg, log in plans:
            logf = open(log, "w", encoding="utf-8")
            cmd = eb_cmd(key, cfg)
            logf.write(f"$ {' '.join(cmd)}\n\n")
            logf.flush()
            p = subprocess.Popen(cmd, cwd=str(DESKTOP_DIR), stdout=logf, stderr=subprocess.STDOUT)
            procs.append((key, p, logf, log))
            print(f"  [launch] {key} (pid {p.pid})")
        rcs: dict[str, int] = {}
        for key, p, logf, log in procs:
            rc = p.wait()
            logf.close()
            rcs[key] = rc
            print(f"  [{'✓' if rc == 0 else '✗'}] {key} done (rc={rc})  log: {log}")
        failed = [k for k, rc in rcs.items() if rc != 0]
        if failed:
            sys.exit(f"[build] parallel build failed for arch: {failed}; check {TMP_DIR}/mobius-eb-*.log")
    else:
        mode = "sequential" if not parallel else "sequential (single arch)"
        print(f"=== [2] electron-builder {mode} build ({len(plans)} target(s)) ===")
        for key, cfg, log in plans:
            print(f"  --- {key} ---")
            with open(log, "w", encoding="utf-8") as logf:
                cmd = eb_cmd(key, cfg)
                logf.write(f"$ {' '.join(cmd)}\n\n")
                logf.flush()
                r = subprocess.run(cmd, cwd=str(DESKTOP_DIR), stdout=logf, stderr=subprocess.STDOUT)
            if r.returncode != 0:
                sys.exit(f"[build] {key} failed (rc={r.returncode}); log: {log}")

    print(f"=== [3] publish to {SERVE_DIR} ===")
    for key, _, _ in plans:
        dest = publish(key, version)
        print(f"    ✓ {dest.name}  ({dest.stat().st_size / (1024 * 1024):.1f} MB)")


def current_menu_version() -> str | None:
    text = MODALS_TSX.read_text(encoding="utf-8")
    m = re.search(r"const\s+DESKTOP_VERSION\s*=\s*'([^']+)'", text)
    return m.group(1) if m else None


def sync_menu(version: str, skip: bool) -> None:
    cur = current_menu_version()
    if skip:
        print(f"=== [sync-menu] skip (--skip-menu-sync); current menu DESKTOP_VERSION={cur} ===")
        return
    if cur == version:
        print(f"=== [sync-menu] menu DESKTOP_VERSION is already {version}; no frontend rebuild needed ===")
        return
    if cur is None:
        print(f"[sync-menu] did not find DESKTOP_VERSION in {MODALS_TSX}; skipping sync")
        return
    print(f"=== [sync-menu] DESKTOP_VERSION {cur} -> {version}, update modals.tsx + rebuild frontend ===")
    text = MODALS_TSX.read_text(encoding="utf-8")
    new_text = re.sub(
        r"const\s+DESKTOP_VERSION\s*=\s*'[^']+'",
        f"const DESKTOP_VERSION = '{version}'",
        text,
    )
    MODALS_TSX.write_text(new_text, encoding="utf-8")
    run([sys.executable, str(START_PY), "--only-update-frontend"], cwd=REPO_ROOT)


def parse_targets(raw: str) -> list[str]:
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    bad = [k for k in keys if k not in TARGETS]
    if bad:
        sys.exit(f"[build] unknown target: {bad}; choices: {', '.join(TARGETS)}")
    return keys


def build_electron(args: argparse.Namespace) -> int:
    version = args.version or read_desktop_version()
    targets = parse_targets(args.targets)
    mode = "parallel" if (args.parallel and len(targets) > 1) else "sequential"
    print(f"=== Mobius Desktop one-shot build | version {version} | targets {targets} | {mode} ===")
    ensure_node_modules()
    build_renderer_once()
    if not args.skip_fetch_python:
        for key in targets:
            fetch_python(key)
    SERVE_DIR.mkdir(parents=True, exist_ok=True)
    build_targets(targets, version, args.parallel)
    print(f"\n=== artifacts published to {SERVE_DIR} ===")
    for p in sorted(SERVE_DIR.glob("mobius-desktop-*.zip")):
        print(f"    {p.name}  ({p.stat().st_size / (1024 * 1024):.1f} MB)")
    sync_menu(version, args.skip_menu_sync)
    print(f"\n=== done. Download menu distribution path: /desktop-builds/ (served as same-origin static files by server.js) ===")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="One-shot artifact build. Currently supports --build-electron (Mobius Desktop clients for three platforms)."
    )
    parser.add_argument("--build-electron", action="store_true", help="build Mobius Desktop (win/mac-arm/mac-x64)")
    parser.add_argument("--version", metavar="V", help="override version (defaults to mobius/desktop/package.json)")
    parser.add_argument("--targets", default="win-x64,mac-arm64,mac-x64", help="comma-separated target subset (defaults to all three)")
    parser.add_argument("--skip-fetch-python", action="store_true", help="reuse existing resources/python-* (default fetch is idempotent)")
    parser.add_argument("--skip-menu-sync", action="store_true", help="do not sync download menu version (default syncs + rebuilds frontend when version changes)")
    parser.add_argument(
        "--sequential",
        action="store_true",
        help="sequential build (default builds three arch targets in parallel; use when memory is tight or debugging)",
    )
    args = parser.parse_args()
    args.parallel = not args.sequential

    if not args.build_electron:
        parser.print_help()
        return 0
    return build_electron(args)


if __name__ == "__main__":
    raise SystemExit(main())
