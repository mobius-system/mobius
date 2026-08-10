#!/usr/bin/env python3
#
#   python3 build.py --build-electron              # 官方构建 (mac 须 Darwin; 见下)
#   python3 build.py --build-electron --targets win-x64
#   python3 build.py --build-electron --targets mac-arm64 --dev-adhoc   # 本地开发包 (不发布)
#   python3 build.py --build-tui                   # npm 可安装包 (mobius 命令)
#   python3 build.py --build-tui-and-install       # 构建并安装到 ~/.local (无需 sudo)
#
# 桌面端构建配置的唯一完整来源 = mobius/desktop/electron-builder.yml。
# 本脚本不再维护重复的 EB_BASE_CONFIG: 官方构建直接 prep resources/python 后调用
# `electron-builder --<plat> --<arch>` (不传 --config, 由 electron-builder 自动读 yml)。
#
# 正式 macOS 包必须在 macOS (Darwin) 主机上构建 —— codesign/notarytool/stapler/dmg 工具
# 只在 macOS 上可用。非 Darwin 主机请求正式 mac 构建会立即失败 (不再产出"看似成功"的未签名包)。
# 没有 Apple 证书的本地开发用 --dev-unsigned / --dev-adhoc: 产物带 -dev 后缀且绝不入 /desktop-builds/。
#
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
DESKTOP_DIR = REPO_ROOT / "mobius" / "desktop"
SERVE_DIR = REPO_ROOT / "mobius" / "desktop-builds"
MODALS_TSX = REPO_ROOT / "mobius" / "frontend" / "src" / "components" / "modals.tsx"
START_PY = REPO_ROOT / "start.py"
DESKTOP_MANIFEST_PY = REPO_ROOT / "scripts" / "desktop_manifest.py"
TMP_DIR = Path("/tmp")

# ===== Mobius TUI =====
TUI_DIR = REPO_ROOT / "mobius" / "tui"
TUI_SERVE_DIR = REPO_ROOT / "mobius" / "tui-builds"

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
# electron-builder 的 ${os} token: mac→"mac", win→"win"。
TARGETS: dict[str, dict[str, str]] = {
    "win-x64": {"plat": "win", "arch": "x64", "os": "win", "farch": "x64"},
    "mac-arm64": {"plat": "mac", "arch": "arm64", "os": "mac", "farch": "arm64"},
    "mac-x64": {"plat": "mac", "arch": "x64", "os": "mac", "farch": "x64"},
}

# 每个 target 的官方产物格式 (与 electron-builder.yml 的 mac.target/win.target 对齐)。
OFFICIAL_FORMATS: dict[str, list[str]] = {
    "win-x64": ["zip"],
    "mac-arm64": ["dmg", "zip"],
    "mac-x64": ["dmg", "zip"],
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


def prep_python(key: str) -> None:
    """把 resources/python-<key> 拷成 canonical resources/python (electron-builder.yml 的 extraResources 认这个)。

    官方构建一次只构一个 target, 故不存在多 arch 共享 resources/python 的竞争 (见方案 §3.3)。
    """
    src = DESKTOP_DIR / "resources" / f"python-{key}"
    if not src.exists():
        sys.exit(f"[build] missing {src}; make sure fetch-python {key} succeeded first")
    dst = DESKTOP_DIR / "resources" / "python"
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    print(f"    prep resources/python <- resources/python-{key}")


def produced_path(version: str, key: str, ext: str, out_subdir: str = "") -> Path:
    """electron-builder 产物路径。${productName}="Mobius Desktop", ${os}=mac/win。"""
    t = TARGETS[key]
    base = DESKTOP_DIR / "release"
    if out_subdir:
        base = base / out_subdir
    return base / f"Mobius Desktop-{version}-{t['os']}-{t['farch']}.{ext}"


def published_name(version: str, key: str, ext: str) -> str:
    """下发到 /desktop-builds/ 的 kebab-case 文件名 (与下载菜单约定 + manifest 一致)。"""
    t = TARGETS[key]
    return f"mobius-desktop-{version}-{t['os']}-{t['farch']}.{ext}"


def official_eb_cmd(key: str) -> list[str]:
    """官方构建: 不传 --config, electron-builder 自动读 electron-builder.yml (唯一配置源)。"""
    t = TARGETS[key]
    return [npx_bin("electron-builder"), f"--{t['plat']}", f"--{t['arch']}"]


def assert_mac_official_host(key: str) -> None:
    """正式 macOS 包必须在 Darwin 上构建。Linux/Windows 无 codesign/notarytool/dmg 工具。"""
    if key.startswith("mac-") and platform.system() != "Darwin":
        sys.exit(
            f"[build] 正式 macOS 包必须在 macOS 主机构建 (当前 {platform.system()})。\n"
            f"        方案: 1) 在 macOS 上跑本命令;  2) 走 CI (push tag desktop-v<V> 或 workflow_dispatch);\n"
            f"              3) 仅本地测试用 --dev-unsigned / --dev-adhoc (产物不入 /desktop-builds/)。\n"
            f"        不再在非 macOS 主机产出'看似成功'的未签名 mac 包。"
        )


def write_dev_config(key: str, mode: str) -> Path:
    """本地开发包配置: extends electron-builder.yml, 只覆盖签名/输出/后缀。

    mode: "unsigned" (完全不签名) | "adhoc" (afterPack 套 ad-hoc 签名, Apple Silicon 可启动)。
    产物带 -dev-<mode> 后缀, 输出到 release/dev-<mode>-<key>/, 绝不复制到 /desktop-builds/。
    extends 经实测 (electron-builder 24.13.3) 会正确加载 desktop/electron-builder.yml 作 parent。
    """
    override: dict = {
        "extends": "./electron-builder.yml",
        "directories": {"output": f"release/dev-{mode}-{key}"},
        "artifactName": f"${{productName}}-${{version}}-${{os}}-${{arch}}-dev-{mode}.${{ext}}",
        "mac": {
            "target": ["zip"],          # dev 不出 dmg (免 dmg-license + 不依赖签名)
            "identity": None,           # 跳过 Developer ID 签名 (正式包严禁这么做)
            "notarize": False,          # dev 不公证
            "hardenedRuntime": False,   # 无签名时无意义
        },
    }
    if mode == "adhoc":
        # afterPack 套 ad-hoc 签名 (见 scripts/after-pack-adhoc.js)
        override["afterPack"] = "./scripts/after-pack-adhoc.js"
    cfg_path = TMP_DIR / f"mobius-eb-dev-{mode}-{key}.json"
    cfg_path.write_text(json.dumps(override, indent=2), encoding="utf-8")
    return cfg_path


def dev_eb_cmd(key: str, cfg_path: Path) -> list[str]:
    t = TARGETS[key]
    return [npx_bin("electron-builder"), f"--{t['plat']}", f"--{t['arch']}", "--config", str(cfg_path)]


def build_one_official(key: str, version: str, skip_fetch_python: bool) -> None:
    assert_mac_official_host(key)
    print(f"  --- [official] {key} (reads electron-builder.yml, no --config) ---")
    if not skip_fetch_python:
        fetch_python(key)
    prep_python(key)
    cfg = official_eb_cmd(key)
    with open(TMP_DIR / f"mobius-eb-{key}.log", "w", encoding="utf-8") as logf:
        logf.write(f"$ {' '.join(cfg)}\n\n")
        logf.flush()
        r = subprocess.run(cfg, cwd=str(DESKTOP_DIR), stdout=logf, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        sys.exit(f"[build] {key} failed (rc={r.returncode}); log: {TMP_DIR}/mobius-eb-{key}.log")
    publish_files(key, version, OFFICIAL_FORMATS[key])


def build_one_dev(key: str, version: str, mode: str, skip_fetch_python: bool) -> None:
    if not key.startswith("mac-"):
        sys.exit(f"[build] --dev-{mode} 仅用于 mac 目标 (win 本就免签名); 收到 {key}")
    print(f"  --- [dev-{mode}] {key} (不发布, 产物带 -dev-{mode} 后缀) ---")
    if not skip_fetch_python:
        fetch_python(key)
    prep_python(key)
    cfg_path = write_dev_config(key, mode)
    cfg = dev_eb_cmd(key, cfg_path)
    log = TMP_DIR / f"mobius-eb-dev-{mode}-{key}.log"
    with open(log, "w", encoding="utf-8") as logf:
        logf.write(f"$ {' '.join(cfg)}\n\n")
        logf.flush()
        r = subprocess.run(cfg, cwd=str(DESKTOP_DIR), stdout=logf, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        sys.exit(f"[build] dev-{mode} {key} failed (rc={r.returncode}); log: {log}")
    produced = produced_path(version, key, "zip", out_subdir=f"dev-{mode}-{key}")
    print(f"    ✓ dev 产物 (未发布): {produced}  ({produced.stat().st_size / (1024*1024):.1f} MB)")
    print(f"    ⚠ 本地开发包, 未用 Developer ID 签名/公证, 不可分发; 不写入 /desktop-builds/ 或 manifest")


def publish_files(key: str, version: str, formats: list[str]) -> None:
    """把官方产物改名拷到 /desktop-builds/ (kebab-case, 与下载菜单+manifest 约定一致)。"""
    SERVE_DIR.mkdir(parents=True, exist_ok=True)
    for ext in formats:
        produced = produced_path(version, key, ext)
        if not produced.exists():
            sys.exit(
                f"[build] 预期产物不存在: {produced}\n"
                f"        检查 release/ 实际内容, 或 {TMP_DIR}/mobius-eb-{key}.log 排错"
            )
        dest = SERVE_DIR / published_name(version, key, ext)
        shutil.copy2(produced, dest)
        print(f"    ✓ {dest.name}  ({dest.stat().st_size / (1024 * 1024):.1f} MB)")


def regenerate_manifest() -> None:
    """构建发布后重写 /desktop-builds/manifest.json (只登记当前版本, 旧版留作回滚不进清单)。"""
    run([sys.executable, str(DESKTOP_MANIFEST_PY), "generate", "--dir", str(SERVE_DIR)], cwd=REPO_ROOT)


def current_menu_version() -> str | None:
    text = MODALS_TSX.read_text(encoding="utf-8")
    m = re.search(r"const\s+DESKTOP_VERSION\s*=\s*'([^']+)'", text)
    return m.group(1) if m else None


def sync_menu(version: str, skip: bool) -> None:
    """桌面下载页已改为运行时读 /desktop-builds/manifest.json (见 modals.tsx DesktopDownloadModal),
    故不再有 DESKTOP_VERSION 常量 —— 本函数对桌面自动 no-op (current_menu_version 返回 None 即跳过)。
    移动端仍用硬编码 MOBILE_VERSION, 由 sync_mobile_menu 单独处理。"""
    cur = current_menu_version()
    if skip:
        print(f"=== [sync-menu] skip (--skip-menu-sync); current menu DESKTOP_VERSION={cur} ===")
        return
    if cur is None:
        print(f"=== [sync-menu] 桌面下载页改为读 manifest.json, 无 DESKTOP_VERSION 常量, 跳过 ===")
        return
    if cur == version:
        print(f"=== [sync-menu] menu DESKTOP_VERSION is already {version}; no frontend rebuild needed ===")
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
    dev_mode = "unsigned" if args.dev_unsigned else ("adhoc" if args.dev_adhoc else None)
    if dev_mode:
        # dev 模式一次一个 target, 不并行, 不发布, 不写 manifest
        print(f"=== Mobius Desktop DEV build (--dev-{dev_mode}) | version {version} | targets {targets} ===")
        ensure_node_modules()
        build_renderer_once()
        for key in targets:
            build_one_dev(key, version, dev_mode, args.skip_fetch_python)
        print(f"\n=== dev 产物在 {DESKTOP_DIR}/release/dev-{dev_mode}-*/ (未发布, 仅本地测试) ===")
        return 0

    print(f"=== Mobius Desktop OFFICIAL build | version {version} | targets {targets} ===")
    # 任何构建动作前先校验宿主: 正式 mac 包必须在 Darwin 上, 否则立即失败 (不白跑 renderer 构建)。
    for key in targets:
        assert_mac_official_host(key)
    ensure_node_modules()
    build_renderer_once()
    SERVE_DIR.mkdir(parents=True, exist_ok=True)
    for key in targets:
        build_one_official(key, version, args.skip_fetch_python)
    regenerate_manifest()
    sync_menu(version, args.skip_menu_sync)
    print(f"\n=== artifacts published to {SERVE_DIR} ===")
    for p in sorted(SERVE_DIR.glob(f"mobius-desktop-{version}-*")):
        print(f"    {p.name}  ({p.stat().st_size / (1024 * 1024):.1f} MB)")
    print(f"\n=== manifest: {SERVE_DIR / 'manifest.json'} ===")
    print(f"=== 下载页运行时读 /desktop-builds/manifest.json (server.js 同源静态分发) ===")
    return 0


# ===== Mobius TUI (Node + Ink) =====

def read_tui_version() -> str:
    return json.loads((TUI_DIR / "package.json").read_text(encoding="utf-8"))["version"]


def ensure_tui_node_modules() -> None:
    missing = [
        TUI_DIR / "node_modules" / ".bin" / "tsc",
        TUI_DIR / "node_modules" / ".bin" / "tsx",
    ]
    if any(not path.exists() for path in missing):
        sys.exit(
            f"[build] missing TUI dependencies under {TUI_DIR}/node_modules.\n"
            "        run: cd mobius/tui && npm install --include=dev"
        )


def make_tui_package_manifest(version: str) -> dict:
    """生成发布用 package.json。

    TUI 当前直接由 tsx 执行 TypeScript 源码，因此源码清单本身必须把 tsx
    声明为运行时依赖，以保证直接 npm publish 与构建产物都能被正确安装。
    其余测试/类型依赖不进入分发包。
    """
    source = json.loads((TUI_DIR / "package.json").read_text(encoding="utf-8"))
    dependencies = dict(source.get("dependencies", {}))
    if not dependencies.get("tsx"):
        sys.exit("[build] mobius/tui/package.json is missing dependencies.tsx")
    return {
        "name": source.get("name", "mobius"),
        "version": version,
        "type": "module",
        "description": source.get("description", "Mobius terminal client"),
        "bin": source.get("bin", {"mobius": "bin/mobius-tui.js"}),
        "scripts": {"start": "tsx src/main.tsx"},
        "files": ["bin", "src", "README.md"],
        "dependencies": dependencies,
        "engines": source.get("engines", {"node": ">=18"}),
    }


def write_tui_manifest(version: str, artifact: Path) -> None:
    size = artifact.stat().st_size
    manifest = {
        "version": version,
        "file": artifact.name,
        "size": size,
        "sha256": sha256_of(artifact),
        "install": f'npm install --global --prefix "$HOME/.local" {artifact.name}',
    }
    (TUI_SERVE_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (TUI_SERVE_DIR / f"{artifact.name}.sha256").write_text(
        f"{manifest['sha256']}  {artifact.name}\n",
        encoding="utf-8",
    )


def install_tui_artifact(artifact: Path, prefix: Path) -> None:
    prefix.mkdir(parents=True, exist_ok=True)
    print(f"=== install TUI to user prefix: {prefix} ===")
    run(["npm", "install", "--global", "--prefix", str(prefix), str(artifact)], cwd=REPO_ROOT)
    bin_dir = prefix if platform.system() == "Windows" else prefix / "bin"
    command = bin_dir / ("mobius.cmd" if platform.system() == "Windows" else "mobius")
    if not command.exists():
        sys.exit(f"[build] npm install finished but mobius command is missing: {command}")
    print(f"    ✓ installed command: {command}")
    if platform.system() != "Windows":
        print(f'    ensure PATH contains: export PATH="{bin_dir}:$PATH"')


def build_tui(args: argparse.Namespace, install: bool = False) -> int:
    version = read_tui_version()
    if args.version:
        sys.exit(
            f"[build] TUI version is defined only by {TUI_DIR / 'package.json'} ({version}); "
            "do not override it with --version"
        )
    print(f"=== Mobius TUI build | version {version} ===")
    ensure_tui_node_modules()
    print("=== [1/4] typecheck ===")
    run(["npm", "run", "typecheck"], cwd=TUI_DIR)
    print("=== [2/4] AIMUX supervisor tests ===")
    run(["npm", "run", "test:aimux"], cwd=TUI_DIR)

    TUI_SERVE_DIR.mkdir(parents=True, exist_ok=True)
    artifact = TUI_SERVE_DIR / f"mobius-tui-{version}.tgz"
    with tempfile.TemporaryDirectory(prefix="mobius-tui-package-") as temp:
        stage = Path(temp)
        shutil.copytree(TUI_DIR / "bin", stage / "bin")
        shutil.copytree(TUI_DIR / "src", stage / "src")
        shutil.copy2(TUI_DIR / "README.md", stage / "README.md")
        (stage / "package.json").write_text(
            json.dumps(make_tui_package_manifest(version), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print("=== [3/4] npm pack ===")
        result = subprocess.run(
            ["npm", "pack", "--json", "--pack-destination", str(TUI_SERVE_DIR)],
            cwd=str(stage),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        try:
            packed_name = json.loads(result.stdout)[0]["filename"]
        except (json.JSONDecodeError, KeyError, IndexError) as exc:
            sys.exit(f"[build] cannot parse npm pack output: {exc}\n{result.stdout}\n{result.stderr}")
        packed = TUI_SERVE_DIR / packed_name
        if packed != artifact:
            if artifact.exists():
                artifact.unlink()
            packed.replace(artifact)

    print("=== [4/4] manifest + checksum ===")
    write_tui_manifest(version, artifact)
    digest = sha256_of(artifact)
    print(f"    ✓ {artifact}  ({artifact.stat().st_size / (1024 * 1024):.2f} MB)")
    print(f"    ✓ sha256={digest}")
    print("\n=== user-level install (no sudo, avoids /usr/local EACCES) ===")
    print(f'    npm install --global --prefix "$HOME/.local" "{artifact}"')
    print('    export PATH="$HOME/.local/bin:$PATH"')
    print("    mobius")
    if install:
        install_tui_artifact(artifact, Path(args.tui_install_prefix).expanduser().resolve())
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
        description="One-shot artifact build. Supports --build-electron (Mobius Desktop) "
        "--build-mobile (Mobius Mobile Android), --build-tui (installable npm package), "
        "and --build-tui-and-install (build + user-level install)."
    )
    parser.add_argument("--build-electron", action="store_true", help="build Mobius Desktop (win/mac-arm/mac-x64). 官方 mac 须在 macOS 上构建。")
    parser.add_argument("--build-mobile", action="store_true", help="build Mobius Mobile (Android arm64 + armeabi-v7a APK, sourced from momo-mobile)")
    parser.add_argument("--build-tui", action="store_true", help="build Mobius TUI as an installable npm .tgz (provides the global `mobius` command)")
    parser.add_argument(
        "--build-tui-and-install",
        action="store_true",
        help="build Mobius TUI and install the `mobius` command to a user-writable npm prefix (default ~/.local)",
    )
    parser.add_argument("--version", metavar="V", help="override version (electron package.json; mobile: momo-mobile androidApp versionName; TUI reads mobius/tui/package.json only)")
    parser.add_argument("--targets", default="win-x64,mac-arm64,mac-x64", help="[electron] comma-separated target subset (defaults to all three)")
    parser.add_argument("--skip-fetch-python", action="store_true", help="[electron] reuse existing resources/python-* (default fetch is idempotent)")
    parser.add_argument("--skip-menu-sync", action="store_true", help="do not sync download menu version/size/sha256 (default syncs into modals.tsx)")
    parser.add_argument(
        "--dev-unsigned",
        action="store_true",
        help="[electron][本地开发] mac 免签名 dev 包 (产物带 -dev-unsigned, 不发布; 仅 mac 目标)",
    )
    parser.add_argument(
        "--dev-adhoc",
        action="store_true",
        help="[electron][本地开发] mac ad-hoc 签名 dev 包 (Apple Silicon 可启动; 产物带 -dev-adhoc, 不发布; 仅 mac 目标)",
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
    parser.add_argument(
        "--tui-install-prefix",
        default=str(Path.home() / ".local"),
        help="[tui install] user-writable npm prefix (default: ~/.local; avoids /usr/local EACCES)",
    )
    args = parser.parse_args()

    selected_builds = [args.build_electron, args.build_mobile, args.build_tui, args.build_tui_and_install]
    if not any(selected_builds):
        parser.print_help()
        return 0
    if sum(bool(selected) for selected in selected_builds) > 1:
        sys.exit("[build] --build-electron / --build-mobile / --build-tui / --build-tui-and-install are mutually exclusive")
    if args.dev_unsigned and args.dev_adhoc:
        sys.exit("[build] --dev-unsigned 与 --dev-adhoc 互斥, 二选一")
    if args.build_mobile:
        return build_mobile(args)
    if args.build_tui:
        return build_tui(args)
    if args.build_tui_and_install:
        return build_tui(args, install=True)
    return build_electron(args)


if __name__ == "__main__":
    raise SystemExit(main())
