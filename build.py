#!/usr/bin/env python3
# build.py — 一键构建产物。
#
#   python3 build.py --build-electron
#     并行编译 Mobius Desktop (Electron 薄壳) 三个平台客户端
#     (win-x64 / mac-arm64 / mac-x64), 落到 mobius/desktop-builds/,
#     经 server.js 的 /desktop-builds 静态路由供 "下载桌面客户端" 菜单分发。
#
# 并行原理: 每个 arch 生成一份独立 electron-builder config —— extraResources 指自己的
# resources/python-<target>, directories.output 指自己的 release/<target>。这样三个 arch
# 没有任何共享可写状态 (旧设计的 resources/python swap + 共享 release/ 是两个竞争点),
# 可以安全并行打包。--sequential 退回顺序构建 (调试/OOM 兜底)。
#
# 桌面端有独立版本号 (mobius/desktop/package.json 的 version), 与 mobius 主版本解耦。
# 本脚本以它为单一来源: 戳进 electron-builder 产物名 + 文件名, 并在版本变化时同步
# 下载菜单的 DESKTOP_VERSION (改 modals.tsx + 重建前端), 保证 "菜单版本==文件名版本==构建版本"。
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
TMP_DIR = Path("/tmp")  # 各 arch 并行构建的 config + 日志落这里, 不污染仓库

# 三平台构建目标。plat/arch 是 electron-builder 的 CLI 标志; os/farch 用于拼产物名
# (artifactName = ${productName}-${version}-${os}-${arch})。
TARGETS: dict[str, dict[str, str]] = {
    "win-x64": {"plat": "win", "arch": "x64", "os": "win", "farch": "x64"},
    "mac-arm64": {"plat": "mac", "arch": "arm64", "os": "mac", "farch": "arm64"},
    "mac-x64": {"plat": "mac", "arch": "x64", "os": "mac", "farch": "x64"},
}

# electron-builder 基础配置 (镜像 mobius/desktop/electron-builder.yml; 改 yml 同步改这里)。
# 每个 arch 在此基础上覆盖 directories.output 和 extraResources[0].from, 其余字段三 arch 共用。
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
    # 统一子进程包装: 打印命令 + 失败即抛错中止。构建任一步失败都不该继续往下跑。
    print(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=True)


def npx_bin(name: str) -> str:
    # desktop 是私有 node_modules, 直接用里面的 .bin, 不依赖全局、不恢复 npm scripts。
    return str(DESKTOP_DIR / "node_modules" / ".bin" / name)


def read_desktop_version() -> str:
    return json.loads((DESKTOP_DIR / "package.json").read_text(encoding="utf-8"))["version"]


def ensure_node_modules() -> None:
    if not (DESKTOP_DIR / "node_modules" / ".bin" / "electron-builder").exists():
        sys.exit(
            f"[build] 缺少 {DESKTOP_DIR}/node_modules。\n"
            f"        请先在该目录跑一次: cd mobius/desktop && npm install"
        )


def build_renderer_once() -> None:
    # out/ (main + preload + renderer) 与 arch 无关, 整个流程只构建一次, 三 arch 共享读。
    print("=== [1] electron-vite build (out/) ===")
    run([npx_bin("electron-vite"), "build"], cwd=DESKTOP_DIR)


def fetch_python(key: str) -> None:
    # 幂等: resources/python-<key>/python/... 已存在则脚本内部自动跳过。
    print(f"--- fetch-python {key} ---")
    run([npx_bin("tsx"), "scripts/fetch-python.ts", key], cwd=DESKTOP_DIR)


def write_arch_config(key: str) -> Path:
    # 每个 arch 独立 config: extraResources 指自己的 resources/python-<key>, output 指自己的
    # release/<key>。这是并行的前提 —— 不再共享 resources/python swap, 不再共享 release/。
    cfg = json.loads(json.dumps(EB_BASE_CONFIG))  # deep copy
    cfg["directories"] = {"output": f"release/{key}"}
    cfg["extraResources"] = [
        {"from": f"resources/python-{key}", "to": "python", "filter": ["**/*"]},
        {"from": "build/icon.png", "to": "icon.png"},  # 应用图标随包下发, 供 BrowserWindow({icon}) 运行时读取
    ]
    cfg_path = TMP_DIR / f"mobius-eb-{key}.json"
    cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return cfg_path


def produced_zip_name(version: str, key: str) -> str:
    # artifactName = ${productName}-${version}-${os}-${arch}.${ext}, productName="Mobius Desktop"。
    t = TARGETS[key]
    return f"Mobius Desktop-{version}-{t['os']}-{t['farch']}.zip"


def published_zip_name(version: str, key: str) -> str:
    # 下载菜单 (modals.tsx DESKTOP_BUILDS) 要的小写 kebab 文件名。
    t = TARGETS[key]
    return f"mobius-desktop-{version}-{t['os']}-{t['farch']}.zip"


def eb_cmd(key: str, cfg_path: Path) -> list[str]:
    # 平台 + arch 两个独立标志 (不能用 `--mac zip` 这种带 target 名的, 会把 arch 覆盖成 host)。
    t = TARGETS[key]
    return [npx_bin("electron-builder"), f"--{t['plat']}", f"--{t['arch']}", "--config", str(cfg_path)]


def publish(key: str, version: str) -> Path:
    produced = DESKTOP_DIR / "release" / key / produced_zip_name(version, key)
    if not produced.exists():
        sys.exit(
            f"[build] 预期产物不存在: {produced}\n"
            f"        查 release/{key}/ 实际文件名, 或 /tmp/mobius-eb-{key}.log 看报错"
        )
    SERVE_DIR.mkdir(parents=True, exist_ok=True)
    dest = SERVE_DIR / published_zip_name(version, key)
    shutil.copy2(produced, dest)
    return dest


def build_targets(targets: list[str], version: str, parallel: bool) -> None:
    # 准备每个 arch 的 config + 日志, 并校验对应 python 目录在位。
    plans: list[tuple[str, Path, Path]] = []
    for key in targets:
        if not (DESKTOP_DIR / "resources" / f"python-{key}").exists():
            sys.exit(f"[build] 缺少 resources/python-{key}, 先确保 fetch-python {key} 成功")
        plans.append((key, write_arch_config(key), TMP_DIR / f"mobius-eb-{key}.log"))

    if parallel and len(plans) > 1:
        print(f"=== [2] electron-builder × {len(plans)} 并行 (各 arch 独立 config/output) ===")
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
            sys.exit(f"[build] 并行构建失败的 arch: {failed}; 查 {TMP_DIR}/mobius-eb-*.log")
    else:
        mode = "顺序" if not parallel else "顺序(单 arch)"
        print(f"=== [2] electron-builder {mode}构建 ({len(plans)} 个) ===")
        for key, cfg, log in plans:
            print(f"  --- {key} ---")
            with open(log, "w", encoding="utf-8") as logf:
                cmd = eb_cmd(key, cfg)
                logf.write(f"$ {' '.join(cmd)}\n\n")
                logf.flush()
                r = subprocess.run(cmd, cwd=str(DESKTOP_DIR), stdout=logf, stderr=subprocess.STDOUT)
            if r.returncode != 0:
                sys.exit(f"[build] {key} 失败 (rc={r.returncode}); log: {log}")

    print(f"=== [3] 发布到 {SERVE_DIR} ===")
    for key, _, _ in plans:
        dest = publish(key, version)
        print(f"    ✓ {dest.name}  ({dest.stat().st_size / (1024 * 1024):.1f} MB)")


def current_menu_version() -> str | None:
    text = MODALS_TSX.read_text(encoding="utf-8")
    m = re.search(r"const\s+DESKTOP_VERSION\s*=\s*'([^']+)'", text)
    return m.group(1) if m else None


def sync_menu(version: str, skip: bool) -> None:
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
    mode = "并行" if (args.parallel and len(targets) > 1) else "顺序"
    print(f"=== Mobius Desktop 一键构建 | 版本 {version} | 目标 {targets} | {mode} ===")
    ensure_node_modules()
    build_renderer_once()
    if not args.skip_fetch_python:
        for key in targets:
            fetch_python(key)
    SERVE_DIR.mkdir(parents=True, exist_ok=True)
    build_targets(targets, version, args.parallel)
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
    parser.add_argument(
        "--sequential",
        action="store_true",
        help="顺序构建 (默认三 arch 并行; 内存紧张或调试时用)",
    )
    args = parser.parse_args()
    args.parallel = not args.sequential

    if not args.build_electron:
        parser.print_help()
        return 0
    return build_electron(args)


if __name__ == "__main__":
    raise SystemExit(main())
