#!/usr/bin/env python3
"""从 GitHub Release 同步 Mobius Desktop 产物到网站下载目录 /desktop-builds/。

方案 §C4 原子发布 + §3.1 "GitHub Release 与网站目录分发同一批已校验文件"。

流程:
  1. 按 --tag 从 GitHub Release 取资产清单 (含 manifest.json);
  2. 校验 manifest schema + version (须 == tag 版本, 且 == package.json);
  3. 下载所有产物到 staging 目录 (desktop-builds/.staging-<version>/);
  4. 逐个校验 size + SHA-256 与 manifest 一致 (任一不符中止, 不污染正式目录);
  5. 原子替换正式目录里【同版本】文件 (os.replace), 旧版本文件保留以便回滚;
  6. 最后才把 manifest.json 替换到位 (避免下载页先展示新版本而二进制还没就绪)。

【绝不】在本机/服务器重新构建 macOS 包 —— mac 包只能在 macOS CI runner 上签名公证。
本脚本只搬运已校验产物。

人工配置项 (在产品服务器上):
  - GH_TOKEN: 访问 GitHub Release (公开仓库可不带, 但易触发匿名限流; 私有仓库必须)。建议配只读 PAT。
  - 运行权限: 进程须能写入 <dest> (默认 mobius/desktop-builds/)。
  - 服务器时钟: 用于 Last-Modified 缓存 (非必需)。

用法:
  GH_TOKEN=ghp_xxx python3 scripts/sync-desktop-builds.py --tag desktop-v0.0.22
  python3 scripts/sync-desktop-builds.py --tag desktop-v0.0.22 --repo nutshellai-tech/mobius --dest mobius/desktop-builds
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import ssl
import sys
import urllib.request
from pathlib import Path

# 复用 manifest 校验逻辑 (同目录模块)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import desktop_manifest as dm  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPO = "nutshellai-tech/mobius"
DEFAULT_DEST = REPO_ROOT / "mobius" / "desktop-builds"


def http_get_json(url: str, token: str | None) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "mobius-sync-desktop-builds", "Accept": "application/vnd.github+json"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=60, context=ssl.create_default_context()) as r:
        return json.loads(r.read().decode("utf-8"))


def http_download(url: str, dest: Path, token: str | None, expected_sha: str | None, expected_size: int | None) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "mobius-sync-desktop-builds"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    h = hashlib.sha256()
    got = 0
    with urllib.request.urlopen(req, timeout=300, context=ssl.create_default_context()) as r, dest.open("wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            h.update(chunk)
            got += len(chunk)
    if expected_size is not None and got != expected_size:
        raise RuntimeError(f"{dest.name}: size 不匹配 (期望 {expected_size} 实际 {got})")
    if expected_sha is not None and h.hexdigest() != expected_sha:
        raise RuntimeError(f"{dest.name}: SHA-256 不匹配 (期望 {expected_sha[:12]}… 实际 {h.hexdigest()[:12]}…)")


def parse_tag_version(tag: str) -> str:
    import re
    m = re.match(r"^desktop-v(.+)$", tag)
    if not m:
        sys.exit(f"[sync] tag 不是 desktop-v<version>: {tag}")
    return m.group(1)


def main() -> int:
    ap = argparse.ArgumentParser(description="从 GitHub Release 原子同步桌面端产物到 /desktop-builds/")
    ap.add_argument("--tag", required=True, help="Release tag, 如 desktop-v0.0.22")
    ap.add_argument("--repo", default=DEFAULT_REPO, help=f"GitHub 仓库 (默认 {DEFAULT_REPO})")
    ap.add_argument("--dest", default=str(DEFAULT_DEST), help="网站下载目录 (默认 mobius/desktop-builds)")
    ap.add_argument("--token", default=os.environ.get("GH_TOKEN"), help="GitHub PAT (默认读 GH_TOKEN 环境变量)")
    ap.add_argument("--pkg", default=str(dm.DESKTOP_PKG), help="mobius/desktop/package.json 路径")
    ap.add_argument("--keep-staging-on-error", action="store_true", help="出错时保留 staging 目录便于排查 (默认清理)")
    args = ap.parse_args()

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)
    tag_version = parse_tag_version(args.tag)

    # 0) 版本一致性: tag 版本 == package.json (网站前端的 manifest 也以此为单一可信源)
    pkg_version = dm.read_desktop_version(Path(args.pkg))
    if tag_version != pkg_version:
        sys.exit(f"[sync] ✗ tag 版本 {tag_version} ≠ package.json {pkg_version} —— 拒绝同步, 先 bump 版本并重发 Release")

    # 1) 取 Release 资产清单
    api = f"https://api.github.com/repos/{args.repo}/releases/tags/{args.tag}"
    print(f"[sync] 查询 Release: {api}")
    rel = http_get_json(api, args.token)
    assets = {a["name"]: a for a in rel.get("assets", [])}
    print(f"[sync] Release 含 {len(assets)} 个资产: {sorted(assets)}")
    if "manifest.json" not in assets:
        sys.exit(f"[sync] ✗ Release 缺 manifest.json —— 该 Release 未走标准发布流程, 拒绝同步")

    # 2) 下载并校验 manifest
    staging = dest / f".staging-{tag_version}"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    try:
        tmp_manifest = staging / "manifest.json"
        http_download(assets["manifest.json"]["browser_download_url"], tmp_manifest, args.token, None, None)
        manifest = json.loads(tmp_manifest.read_text(encoding="utf-8"))
        if manifest.get("version") != tag_version:
            raise RuntimeError(f"manifest.version {manifest.get('version')} ≠ tag {tag_version}")
        if not isinstance(manifest.get("builds"), list) or not manifest["builds"]:
            raise RuntimeError("manifest.builds 缺失或为空")

        # 3) 下载每个产物并校验 size + sha256
        for b in manifest["builds"]:
            fname = b["file"]
            if fname not in assets:
                raise RuntimeError(f"manifest 列出 {fname} 但 Release 无此资产")
            url = assets[fname]["browser_download_url"]
            print(f"[sync]   ↓ {fname}  ({b.get('size', 0) / (1024 * 1024):.1f} MB)")
            http_download(url, staging / fname, args.token, b.get("sha256"), b.get("size"))

        # 4) 原子替换: 同版本文件覆盖到正式目录 (旧版本文件不动, 留作回滚)
        print(f"[sync] 原子部署到 {dest}")
        for b in manifest["builds"]:
            fname = b["file"]
            os.replace(staging / fname, dest / fname)
        # 5) manifest 最后替换 (下载页此时才有新版本, 且二进制已全部就位)
        os.replace(tmp_manifest, dest / "manifest.json")

        # 6) 复核: 用统一校验器验证落地结果
        ok, errs = dm.validate_manifest(dest, Path(args.pkg))
        if not ok:
            raise RuntimeError(f"部署后 manifest 复核失败: {errs}")
        print(f"[sync] ✓ {args.tag} 同步完成: {len(manifest['builds'])} 个产物 + manifest.json")
        print(f"[sync]   版本 {tag_version} (= package.json); 旧版本文件保留在 {dest} 以便回滚")
        return 0
    except BaseException as e:
        print(f"[sync] ✗ 同步失败: {e}", file=sys.stderr)
        if not args.keep_staging_on_error:
            shutil.rmtree(staging, ignore_errors=True)
            print(f"[sync]   已清理 {staging}; 正式目录未被污染", file=sys.stderr)
        else:
            print(f"[sync]   保留 {staging} 供排查 (--keep-staging-on-error)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
