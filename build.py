#!/usr/bin/env python3
# build.py — 一键构建产物。
#
# 目前支持:
#   python3 build.py --build-electron
#     重新编译 Mobius Desktop (Electron 薄壳) 三个平台客户端
#     (win-x64 / mac-arm64 / mac-x64), 落到 mobius/desktop-builds/,
#     经 server.js 的 /desktop-builds 静态路由供 "下载桌面客户端" 菜单分发。
#
# 桌面端有自己独立的版本号 (mobius/desktop/package.json 的 version), 与 mobius
# 主版本解耦。本脚本以它为单一来源: 戳进 electron-builder 产物名 + 文件名, 并在
# 版本变化时同步下载菜单的 DESKTOP_VERSION (改 modals.tsx + 重建前端), 保证
# "菜单显示版本 == 文件名版本 == 构建版本" 三者永远一致。
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

# 三平台构建目标。plat/arch 是 electron-builder 的 CLI 标志; os/farch 用于拼产物名
# (electron-builder.yml artifactName = ${productName}-${version}-${os}-${arch});
# py 是该 arch 对应的内置 python-build-standalone 目录 (resources/python-<key>).
TARGETS: dict[str, dict[str, str]] = {
    "win-x64": {"plat": "win", "arch": "x64", "os": "win", "farch": "x64", "py": "python-win-x64"},
    "mac-arm64": {"plat": "mac", "arch": "arm64", "os": "mac", "farch": "arm64", "py": "python-mac-arm64"},
    "mac-x64": {"plat": "mac", "arch": "x64", "os": "mac", "farch": "x64", "py": "python-mac-x64"},
}


def run(cmd: list[str], cwd: Path | None = None) -> None:
    # 统一子进程包装: 打印命令 + 失败即抛错中止。构建任一步失败都不该继续往下跑。
    print(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=True)


def npx_bin(name: str) -> str:
    # desktop 是私有 node_modules, 直接用里面的 .bin, 不依赖全局、不恢复 package.json 的 npm scripts。
    return str(DESKTOP_DIR / "node_modules" / ".bin" / name)


def read_desktop_version() -> str:
    pkg = json.loads((DESKTOP_DIR / "package.json").read_text(encoding="utf-8"))
    return pkg["version"]


def ensure_node_modules() -> None:
    if not (DESKTOP_DIR / "node_modules" / ".bin" / "electron-builder").exists():
        sys.exit(
            f"[build] 缺少 {DESKTOP_DIR}/node_modules。\n"
            f"        请先在该目录跑一次: cd mobius/desktop && npm install"
        )


def build_renderer_once() -> None:
    # out/ (main + preload + renderer) 与 arch 无关, 整个流程只构建一次。
    print("=== [1] electron-vite build (out/) ===")
    run([npx_bin("electron-vite"), "build"], cwd=DESKTOP_DIR)


def fetch_python(key: str) -> None:
    # 幂等: resources/python-<key>/python/... 已存在则脚本内部自动跳过。
    print(f"--- fetch-python {key} ---")
    run([npx_bin("tsx"), "scripts/fetch-python.ts", key], cwd=DESKTOP_DIR)


def swap_python(key: str) -> None:
    # electron-builder.yml 的 extraResources 只有一个 resources/python (canonical),
    # 每个 arch 构建前把对应 arch 的 python-build-standalone 拷进去。
    t = TARGETS[key]
    canon = DESKTOP_DIR / "resources" / "python"
    src = DESKTOP_DIR / "resources" / t["py"]
    if not src.exists():
        sys.exit(f"[build] 缺少 {src}, 先确保 fetch-python {key} 成功")
    if canon.exists() or canon.is_symlink():
        shutil.rmtree(canon)
    shutil.copytree(src, canon)


def produced_zip_name(version: str, key: str) -> str:
    # electron-builder artifactName = ${productName}-${version}-${os}-${arch}.${ext}
    # productName = "Mobius Desktop" (electron-builder.yml). 产物名带空格 + 大写。
    t = TARGETS[key]
    return f"Mobius Desktop-{version}-{t['os']}-{t['farch']}.zip"


def published_zip_name(version: str, key: str) -> str:
    # 下载菜单 (modals.tsx DESKTOP_BUILDS) 要的小写 kebab 文件名。
    t = TARGETS[key]
    return f"mobius-desktop-{version}-{t['os']}-{t['farch']}.zip"


def build_target(key: str, version: str) -> Path:
    t = TARGETS[key]
    print(f"=== [target] {key} (electron-builder --{t['plat']} --{t['arch']}) ===")
    swap_python(key)
    # 关键坑: 不能用 `--mac zip` 这种带 target 名的形式 —— 那会把 arch 覆盖成 host (Linux=x64)。
    # 用平台 + arch 两个独立标志 (electron-builder --mac --arm64), 让 arch 精确生效。
    # 免签名: win.signAndEditExecutable:false / mac.identity:null 已在 electron-builder.yml 配好。
    run([npx_bin("electron-builder"), f"--{t['plat']}", f"--{t['arch']}"], cwd=DESKTOP_DIR)

    produced = DESKTOP_DIR / "release" / produced_zip_name(version, key)
    if not produced.exists():
        sys.exit(f"[build] 预期产物不存在: {produced}\n        检查 release/ 实际文件名是否匹配 electron-builder.yml artifactName")
    published = published_zip_name(version, key)
    SERVE_DIR.mkdir(parents=True, exist_ok=True)
    dest = SERVE_DIR / published
    shutil.copy2(produced, dest)
    size_mb = dest.stat().st_size / (1024 * 1024)
    print(f"    ✓ {published}  ({size_mb:.1f} MB)")
    return dest


def current_menu_version() -> str | None:
    text = MODALS_TSX.read_text(encoding="utf-8")
    m = re.search(r"const\s+DESKTOP_VERSION\s*=\s*'([^']+)'", text)
    return m.group(1) if m else None


def sync_menu(version: str, skip: bool) -> None:
    # 桌面端版本独立, 菜单显示版本必须 == 构建版本, 否则下载链接文件名对不上。
    # 版号没变就跳过 (省一次前端重建); 变了才改 modals.tsx + 重建前端静态包。
    cur = current_menu_version()
    if skip:
        print(f"=== [sync-menu] 跳过 (--skip-menu-sync); 菜单当前 DESKTOP_VERSION={cur} ===")
        return
    if cur == version:
        print(f"=== [sync-menu] 菜单 DESKTOP_VERSION 已是 {version}, 无需重建前端 ===")
        return
    if cur is None:
        print(f"[sync-menu] ⚠ 未在 {MODALS_TSX} 找到 DESKTOP_VERSION, 跳过同步")
        return
    print(f"=== [sync-menu] DESKTOP_VERSION {cur} -> {version}, 改 modals.tsx + 重建前端 ===")
    text = MODALS_TSX.read_text(encoding="utf-8")
    new_text = re.sub(
        r"const\s+DESKTOP_VERSION\s*=\s*'[^']+'",
        f"const DESKTOP_VERSION = '{version}'",
        text,
    )
    MODALS_TSX.write_text(new_text, encoding="utf-8")
    # 复用 start.py 的纯前端更新流程: 编译并替换 mobius/public, 不重启后端。
    run([sys.executable, str(START_PY), "--only-update-frontend"], cwd=REPO_ROOT)


def parse_targets(raw: str) -> list[str]:
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    bad = [k for k in keys if k not in TARGETS]
    if bad:
        sys.exit(f"[build] 未知 target: {bad}; 可选: {', '.join(TARGETS)}")
    return keys


def build_electron(args: argparse.Namespace) -> int:
    version = args.version or read_desktop_version()
    targets = parse_targets(args.targets)
    print(f"=== Mobius Desktop 一键构建 | 版本 {version} | 目标 {targets} ===")
    ensure_node_modules()
    build_renderer_once()
    if not args.skip_fetch_python:
        for key in targets:
            fetch_python(key)
    SERVE_DIR.mkdir(parents=True, exist_ok=True)
    for key in targets:
        build_target(key, version)
    print(f"\n=== 产物已发布到 {SERVE_DIR} ===")
    for p in sorted(SERVE_DIR.glob("mobius-desktop-*.zip")):
        print(f"    {p.name}  ({p.stat().st_size / (1024 * 1024):.1f} MB)")
    sync_menu(version, args.skip_menu_sync)
    print(f"\n=== 完成。下载菜单分发路径: /desktop-builds/ (经 server.js 同源静态托管) ===")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="一键构建产物。当前支持 --build-electron (Mobius Desktop 三平台客户端)。"
    )
    parser.add_argument("--build-electron", action="store_true", help="构建 Mobius Desktop (win/mac-arm/mac-x64)")
    parser.add_argument("--version", metavar="V", help="覆盖版本号 (默认读 mobius/desktop/package.json)")
    parser.add_argument("--targets", default="win-x64,mac-arm64,mac-x64", help="逗号分隔的子集 (默认全部 3 个)")
    parser.add_argument("--skip-fetch-python", action="store_true", help="复用已有 resources/python-* (默认会幂等 fetch)")
    parser.add_argument("--skip-menu-sync", action="store_true", help="不同步下载菜单版本 (默认版本变了就同步+重建前端)")
    args = parser.parse_args()

    if not args.build_electron:
        parser.print_help()
        return 0
    return build_electron(args)


if __name__ == "__main__":
    raise SystemExit(main())
