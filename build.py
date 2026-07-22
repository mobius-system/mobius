#!/usr/bin/env python3
#
#   python3 build.py --build-electron
#
#
from __future__ import annotations

import argparse
import hashlib
import json
import os
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

# ===== Mobius Mobile (Android) =====
# momo-mobile (d78c6e39「小莫助理 app 开发」) 源码项目; 可由 --mobile-src 覆盖。
MOBILE_SRC_DEFAULT = Path("/data/workspace/home/mengxiaofei/cc-workspace/clever_wave/momo-mobile")
MOBILE_SERVE_DIR = REPO_ROOT / "mobius" / "mobile-builds"
MOBILE_ANDROID_APP = "androidApp"  # gradle 模块名 (见 momo-mobile/settings.gradle.kts)
# ABI → 下载菜单文件名后缀 (与 modals.tsx MOBILE_BUILDS 的 file 模板对齐)。
# momo-mobile/androidApp/build.gradle.kts 的 splits.abi 必须包含同名 ABI。
MOBILE_ABIS: dict[str, str] = {
    "arm64-v8a": "arm64",
    "armeabi-v7a": "armeabi-v7a",
}

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


# ===== Mobius Mobile (Android) =====

def read_mobile_version(mobile_src: Path) -> str:
    gradle = mobile_src / MOBILE_ANDROID_APP / "build.gradle.kts"
    m = re.search(r'versionName\s*=\s*"([^"]+)"', gradle.read_text(encoding="utf-8"))
    if not m:
        sys.exit(f"[build] cannot find versionName in {gradle}")
    return m.group(1)


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def find_mobile_apk(mobile_src: Path, abi: str) -> Path | None:
    # splits.abi 产出: <module>/build/outputs/apk/debug/<module>-<abi>-debug.apk
    debug_dir = mobile_src / MOBILE_ANDROID_APP / "build" / "outputs" / "apk" / "debug"
    hits = sorted(debug_dir.glob(f"*-{abi}-debug.apk"))
    return hits[-1] if hits else None


def run_gradle_assemble_debug(mobile_src: Path) -> None:
    gradlew = mobile_src / "gradlew"
    if not gradlew.exists():
        sys.exit(f"[build] gradlew not found at {gradlew}; wrong --mobile-src?")
    env = dict(os.environ)
    env.setdefault("ANDROID_HOME", "/root/android-sdk")
    env.setdefault("ANDROID_SDK_ROOT", env["ANDROID_HOME"])
    cmd = ["bash", str(gradlew), f":{MOBILE_ANDROID_APP}:assembleDebug", "--no-daemon"]
    print(f"=== [mobile] gradle assembleDebug in {mobile_src} (per-ABI splits) ===")
    print(f"$ {' '.join(cmd)}")
    # run() 不接受 env; 这里需要带 ANDROID_HOME, 故直接 subprocess.
    subprocess.run(cmd, cwd=str(mobile_src), env=env, check=True)


def ensure_mobile_apks(mobile_src: Path, no_build: bool) -> dict[str, Path]:
    found: dict[str, Path] = {}
    missing: list[str] = []
    for abi in MOBILE_ABIS:
        p = find_mobile_apk(mobile_src, abi)
        if p:
            found[abi] = p
        else:
            missing.append(abi)
    if missing and not no_build:
        run_gradle_assemble_debug(mobile_src)
        for abi in missing:
            p = find_mobile_apk(mobile_src, abi)
            if p:
                found[abi] = p
            else:
                sys.exit(
                    f"[build] {abi} APK still missing after gradle build; expected "
                    f"*-{abi}-debug.apk under {mobile_src}/{MOBILE_ANDROID_APP}/build/outputs/apk/debug/ "
                    f"(check splits.abi in {MOBILE_ANDROID_APP}/build.gradle.kts)"
                )
    elif missing:
        sys.exit(
            f"[build] missing per-ABI APKs {missing} and --no-mobile-build given; "
            f"run `./gradlew :{MOBILE_ANDROID_APP}:assembleDebug` in {mobile_src} first"
        )
    return found


def current_mobile_menu_version() -> str | None:
    text = MODALS_TSX.read_text(encoding="utf-8")
    m = re.search(r"const\s+MOBILE_VERSION\s*=\s*'([^']+)'", text)
    return m.group(1) if m else None


def sync_mobile_entry(text: str, abi_suffix: str, size: int, sha256: str) -> str:
    # 锚定 file 模板里的 `mobius-mobile-${MOBILE_VERSION}-android-<suffix>.apk` 行,
    # 顺带替换紧跟其后的 size / sha256 两个字段。版本号走 ${MOBILE_VERSION}, 故与版本无关。
    pattern = (
        r"(file: `mobius-mobile-\$\{MOBILE_VERSION\}-android-" + re.escape(abi_suffix) + r"\.apk`,\s*\n"
        r"\s*size: )\d+(,\s*\n\s*sha256: )'[^']*'()"
    )

    def repl(m: re.Match[str]) -> str:
        return f"{m.group(1)}{size}{m.group(2)}'{sha256}'"

    new_text, n = re.subn(pattern, repl, text)
    if n != 1:
        sys.exit(
            f"[build] expected exactly 1 MOBILE_BUILDS entry for android-{abi_suffix}, matched {n}; "
            f"check modals.tsx formatting (need file/size/sha256 on consecutive lines)"
        )
    return new_text


def sync_mobile_menu(version: str, info: list[tuple[str, int, str]], skip: bool) -> None:
    cur = current_mobile_menu_version()
    text = MODALS_TSX.read_text(encoding="utf-8")
    if skip:
        print(f"=== [sync-menu] skip (--skip-menu-sync); current MOBILE_VERSION={cur} ===")
    else:
        if cur is None:
            print(f"[sync-menu] did not find MOBILE_VERSION in {MODALS_TSX}; skipping version sync")
        elif cur != version:
            print(f"=== [sync-menu] MOBILE_VERSION {cur} -> {version} ===")
            text = re.sub(
                r"const\s+MOBILE_VERSION\s*=\s*'[^']+'",
                f"const MOBILE_VERSION = '{version}'",
                text,
            )
        else:
            print(f"=== [sync-menu] MOBILE_VERSION already {version}; no version change ===")
    print("=== [sync-menu] backfill size/sha256 into MOBILE_BUILDS ===")
    for abi, size, sha256 in info:
        text = sync_mobile_entry(text, MOBILE_ABIS[abi], size, sha256)
        print(f"    android-{MOBILE_ABIS[abi]}: {size} bytes, sha256={sha256[:12]}…")
    MODALS_TSX.write_text(text, encoding="utf-8")
    print("=== [sync-menu] modals.tsx updated; frontend rebuild happens via the subsequent `python3 start.py` ===")


def build_mobile(args: argparse.Namespace) -> int:
    mobile_src = Path(args.mobile_src)
    if not mobile_src.exists():
        sys.exit(f"[build] mobile source not found: {mobile_src}; pass --mobile-src <path>")
    version = args.version or read_mobile_version(mobile_src)
    print(f"=== Mobius Mobile one-shot build | version {version} | src {mobile_src} | ABIs {list(MOBILE_ABIS)} ===")
    apks = ensure_mobile_apks(mobile_src, args.no_mobile_build)
    MOBILE_SERVE_DIR.mkdir(parents=True, exist_ok=True)
    info: list[tuple[str, int, str]] = []  # (abi, size, sha256)
    for abi in MOBILE_ABIS:
        src = apks[abi]
        dest_name = f"mobius-mobile-{version}-android-{MOBILE_ABIS[abi]}.apk"
        dest = MOBILE_SERVE_DIR / dest_name
        shutil.copy2(src, dest)
        size = dest.stat().st_size
        digest = sha256_of(dest)
        info.append((abi, size, digest))
        print(f"    ✓ {dest_name}  ({size / (1024 * 1024):.1f} MB)  sha256={digest[:12]}…  ← {src.name}")
    sync_mobile_menu(version, info, args.skip_menu_sync)
    print(f"\n=== artifacts published to {MOBILE_SERVE_DIR} ===")
    for abi, size, digest in info:
        print(f"    mobius-mobile-{version}-android-{MOBILE_ABIS[abi]}.apk  ({size / (1024 * 1024):.1f} MB)  sha256={digest}")
    print(f"\n=== done. Download menu distribution path: /mobile-builds/ (served as same-origin static files by server.js) ===")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="One-shot artifact build. Supports --build-electron (Mobius Desktop, three platforms) "
        "and --build-mobile (Mobius Mobile Android, arm64 + armeabi-v7a, sourced from momo-mobile)."
    )
    parser.add_argument("--build-electron", action="store_true", help="build Mobius Desktop (win/mac-arm/mac-x64)")
    parser.add_argument("--build-mobile", action="store_true", help="build Mobius Mobile (Android arm64 + armeabi-v7a APK, sourced from momo-mobile)")
    parser.add_argument("--version", metavar="V", help="override version (electron: mobius/desktop/package.json; mobile: momo-mobile androidApp versionName)")
    parser.add_argument("--targets", default="win-x64,mac-arm64,mac-x64", help="[electron] comma-separated target subset (defaults to all three)")
    parser.add_argument("--skip-fetch-python", action="store_true", help="[electron] reuse existing resources/python-* (default fetch is idempotent)")
    parser.add_argument("--skip-menu-sync", action="store_true", help="do not sync download menu version/size/sha256 (default syncs into modals.tsx)")
    parser.add_argument(
        "--sequential",
        action="store_true",
        help="[electron] sequential build (default builds three arch targets in parallel; use when memory is tight or debugging)",
    )
    parser.add_argument(
        "--mobile-src",
        default=str(MOBILE_SRC_DEFAULT),
        help=f"[mobile] path to momo-mobile source (default: {MOBILE_SRC_DEFAULT})",
    )
    parser.add_argument(
        "--no-mobile-build",
        action="store_true",
        help="[mobile] do not run gradle if per-ABI APKs are missing; just copy existing ones",
    )
    args = parser.parse_args()
    args.parallel = not args.sequential

    if not args.build_electron and not args.build_mobile:
        parser.print_help()
        return 0
    if args.build_mobile:
        return build_mobile(args)
    return build_electron(args)


if __name__ == "__main__":
    raise SystemExit(main())
