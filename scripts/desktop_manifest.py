#!/usr/bin/env python3
"""Mobius Desktop 分发清单 (manifest.json) 生成 / 校验 / 版本一致性检查。

单一可信源 = mobius/desktop/package.json 的 version。manifest 的 version 必须与之一致,
否则下载页会指向服务器上不存在的文件 (再触发 server.js 的 404 兜底)。

manifest schema (与 docs/macOS桌面客户端签名与分发修复方案.md §A4 一致):

    {
      "version": "0.0.22",
      "generatedAt": "2026-07-25T00:00:00Z",
      "builds": [
        {
          "platform": "mac",            # mac | win
          "arch": "arm64",              # arm64 | x64
          "format": "dmg",              # dmg | zip
          "file": "mobius-desktop-0.0.22-mac-arm64.dmg",
          "size": 123456789,
          "sha256": "<64 hex>"
        }
      ]
    }

被 build.py (构建后写清单) 与 scripts/sync-desktop-builds.py (从 GitHub Release 同步后写清单)
共用; CI 用 `check-tag` 校验 tag 与 package.json 一致, 用 `validate` 校验落地产物。
纯标准库, 无第三方依赖。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DESKTOP_PKG = REPO_ROOT / "mobius" / "desktop" / "package.json"
DESKTOP_BUILDS_DIR = REPO_ROOT / "mobius" / "desktop-builds"
MANIFEST_NAME = "manifest.json"

# mobius-desktop-<version>-<os>-<arch>.<ext>   os∈{mac,win} arch∈{arm64,x64} ext∈{dmg,zip}
FILENAME_RE = re.compile(
    r"^mobius-desktop-(?P<ver>.+?)-(?P<os>mac|win)-(?P<arch>arm64|x64)\.(?P<ext>dmg|zip)$"
)

REQUIRED_BUILD_KEYS = ("platform", "arch", "format", "file", "size", "sha256")


def read_desktop_version(pkg: Path = DESKTOP_PKG) -> str:
    return json.loads(pkg.read_text(encoding="utf-8"))["version"]


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_filename(name: str) -> tuple[str, str, str, str] | None:
    """返回 (version, platform, arch, format) 或 None(不是桌面端产物)。"""
    m = FILENAME_RE.match(name)
    if not m:
        return None
    return m.group("ver"), m.group("os"), m.group("arch"), m.group("ext")


def entry_for(path: Path, platform: str, arch: str, fmt: str) -> dict:
    """由实际文件计算 size + sha256, 组一条 build entry。"""
    size = path.stat().st_size
    return {
        "platform": platform,
        "arch": arch,
        "format": fmt,
        "file": path.name,
        "size": size,
        "sha256": sha256_of(path),
    }


def manifest_path(dir_: Path = DESKTOP_BUILDS_DIR) -> Path:
    return dir_ / MANIFEST_NAME


def load_manifest(dir_: Path = DESKTOP_BUILDS_DIR) -> dict | None:
    p = manifest_path(dir_)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def write_manifest(
    dir_: Path,
    version: str,
    entries: list[dict],
    generated_at: str | None = None,
) -> Path:
    """原子写 manifest: 先写临时文件再 os.replace, 避免下载页读到半截 JSON。

    generated_at 缺省取当前 UTC (ISO8601 + Z)。CI 调用方可注入构建时间戳以可复现。
    """
    dir_.mkdir(parents=True, exist_ok=True)
    # entries 按 (platform, arch, format) 稳定排序, 同一产物多次写入顺序一致, diff 干净。
    order = {"mac": 0, "win": 1}
    entries = sorted(
        entries,
        key=lambda e: (order.get(e["platform"], 9), e["arch"], {"dmg": 0, "zip": 1}.get(e["format"], 9)),
    )
    doc = {
        "version": version,
        "generatedAt": generated_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "builds": entries,
    }
    target = manifest_path(dir_)
    # 原子替换: NamedTemporaryFile 在同目录, os.replace 在同一文件系统原子上线。
    fd, tmp = tempfile.mkstemp(prefix=".manifest-", suffix=".json", dir=str(dir_))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return target


def scan_entries(dir_: Path, version: str | None = None) -> list[tuple[Path, str, str, str]]:
    """扫描目录里桌面端产物 (mobius-desktop-*.{dmg,zip}) -> [(path, platform, arch, fmt)]。

    version 给定时只返回该版本 (旧版本可留在目录里用于回滚, 但不进当前 manifest)。
    """
    out: list[tuple[Path, str, str, str]] = []
    if not dir_.exists():
        return out
    for p in sorted(dir_.iterdir()):
        parsed = parse_filename(p.name)
        if parsed and p.is_file():
            ver, platform, arch, fmt = parsed
            if version is not None and ver != version:
                continue
            out.append((p, platform, arch, fmt))
    return out


def validate_manifest(
    dir_: Path = DESKTOP_BUILDS_DIR,
    pkg: Path = DESKTOP_PKG,
) -> tuple[bool, list[str]]:
    """校验 manifest: schema 完整 + version==package.json + 每条 entry 文件存在且 size/sha 匹配。

    返回 (ok, errors)。ok=False 时 errors 列出每一处问题, CI 据此失败。
    """
    errors: list[str] = []
    m = load_manifest(dir_)
    if m is None:
        return False, [f"manifest 不存在或无法解析: {manifest_path(dir_)}"]
    if not isinstance(m, dict):
        return False, ["manifest 顶层不是对象"]
    version = m.get("version")
    if not isinstance(version, str) or not version:
        errors.append("manifest.version 缺失或非字符串")
    else:
        pkg_ver = read_desktop_version(pkg)
        if version != pkg_ver:
            errors.append(f"版本漂移: manifest.version={version} ≠ package.json version={pkg_ver}")
    builds = m.get("builds")
    if not isinstance(builds, list) or not builds:
        errors.append("manifest.builds 缺失或为空")
        return False, errors
    # 同一 file 不应重复登记
    seen: set[str] = set()
    for i, b in enumerate(builds):
        if not isinstance(b, dict):
            errors.append(f"builds[{i}] 不是对象")
            continue
        for k in REQUIRED_BUILD_KEYS:
            if k not in b:
                errors.append(f"builds[{i}] 缺字段 {k}")
        fname = b.get("file")
        if not fname:
            continue
        if fname in seen:
            errors.append(f"builds[{i}] 重复登记文件 {fname}")
        seen.add(fname)
        # 校验文件名格式 (防止手写错进 manifest)
        parsed = parse_filename(fname)
        if parsed is None:
            errors.append(f"builds[{i}].file 不是合法桌面端产物名: {fname}")
            continue
        fver, fplat, farch, ffmt = parsed
        if version and fver != version:
            errors.append(f"builds[{i}].file={fname} 版本 {fver} ≠ manifest.version {version}")
        if b.get("platform") != fplat or b.get("arch") != farch or b.get("format") != ffmt:
            errors.append(
                f"builds[{i}].file={fname} 与 platform/arch/format "
                f"({b.get('platform')}/{b.get('arch')}/{b.get('format')}) 不一致"
            )
        fpath = dir_ / fname
        if not fpath.exists():
            errors.append(f"builds[{i}].file 在服务器不存在: {fname}")
            continue
        actual_size = fpath.stat().st_size
        if b.get("size") != actual_size:
            errors.append(f"{fname}: size 不匹配 (manifest={b.get('size')} 实际={actual_size})")
        actual_sha = sha256_of(fpath)
        if b.get("sha256") != actual_sha:
            errors.append(f"{fname}: sha256 不匹配 (manifest={str(b.get('sha256'))[:12]}… 实际={actual_sha[:12]}…)")
    return (len(errors) == 0), errors


def cmd_generate(args: argparse.Namespace) -> int:
    dir_ = Path(args.dir)
    version = args.version or read_desktop_version(Path(args.pkg))
    scanned = scan_entries(dir_, version=version)
    if not scanned:
        print(f"[manifest] 目录里没有桌面端产物: {dir_}", file=sys.stderr)
        return 1
    entries = [entry_for(p, plat, arch, fmt) for (p, plat, arch, fmt) in scanned]
    out = write_manifest(dir_, version, entries, generated_at=args.generated_at)
    print(f"[manifest] 写入 {out} (version={version}, {len(entries)} 条 build)")
    for e in entries:
        print(f"    {e['file']}  ({e['size'] / (1024 * 1024):.1f} MB)  sha256={e['sha256'][:12]}…")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    ok, errors = validate_manifest(Path(args.dir), Path(args.pkg))  # type: ignore[arg-type]
    if ok:
        print(f"[manifest] ✓ 校验通过: {manifest_path(Path(args.dir))}")
        return 0
    print(f"[manifest] ✗ 校验失败 ({len(errors)} 处):", file=sys.stderr)
    for e in errors:
        print(f"    - {e}", file=sys.stderr)
    return 1


def cmd_check_tag(args: argparse.Namespace) -> int:
    # tag 形如 desktop-v0.0.22 -> 0.0.22
    m = re.match(r"^desktop-v(.+)$", args.tag)
    if not m:
        print(f"[manifest] tag 不是 desktop-v<version> 形式: {args.tag}", file=sys.stderr)
        return 2
    tag_ver = m.group(1)
    pkg_ver = read_desktop_version(Path(args.pkg))
    if tag_ver != pkg_ver:
        print(
            f"[manifest] ✗ tag 版本 {tag_ver} ≠ package.json version {pkg_ver}",
            file=sys.stderr,
        )
        return 1
    print(f"[manifest] ✓ tag {args.tag} 与 package.json {pkg_ver} 一致")
    return 0


def _selftest() -> int:
    """无 pytest 也能跑的自检: 临时目录造假产物, generate→validate 全绿, 并测负面用例。"""
    import tempfile
    from pathlib import Path as P

    failures: list[str] = []
    with tempfile.TemporaryDirectory() as td:
        d = P(td)
        pkg = d / "pkg.json"
        pkg.write_text(json.dumps({"version": "0.0.9"}), encoding="utf-8")
        # 造假产物
        for name in ["mobius-desktop-0.0.9-mac-arm64.dmg", "mobius-desktop-0.0.9-mac-arm64.zip",
                     "mobius-desktop-0.0.9-mac-x64.dmg", "mobius-desktop-0.0.9-win-x64.zip"]:
            (d / name).write_bytes(name.encode())  # 内容无所谓, 只验流程
        # generate
        entries = [entry_for(p, *parse_filename(p.name)[1:]) for p in d.iterdir() if parse_filename(p.name)]
        write_manifest(d, "0.0.9", entries, generated_at="2026-07-25T00:00:00Z")
        ok, errs = validate_manifest(d, pkg)
        if not ok:
            failures.append(f"正例 validate 应通过但失败: {errs}")
        # 负例 1: 版本漂移
        pkg.write_text(json.dumps({"version": "0.0.10"}), encoding="utf-8")
        ok2, errs2 = validate_manifest(d, pkg)
        if ok2 or not any("版本漂移" in e for e in errs2):
            failures.append(f"版本漂移应被检出: ok={ok2} errs={errs2}")
        # 负例 2: 文件被删
        pkg.write_text(json.dumps({"version": "0.0.9"}), encoding="utf-8")
        (d / "mobius-desktop-0.0.9-win-x64.zip").unlink()
        ok3, errs3 = validate_manifest(d, pkg)
        if ok3 or not any("不存在" in e for e in errs3):
            failures.append(f"文件缺失应被检出: ok={ok3} errs={errs3}")
    # parse_filename
    if parse_filename("mobius-desktop-0.0.22-mac-arm64.dmg") != ("0.0.22", "mac", "arm64", "dmg"):
        failures.append("parse_filename 解析错误")
    if parse_filename("mobius-mobile-0.1.7-android-arm64.apk") is not None:
        failures.append("parse_filename 不该匹配 mobile apk")
    if failures:
        print("[selftest] ✗ 失败:")
        for f in failures:
            print(f"    - {f}")
        return 1
    print("[selftest] ✓ 全部通过")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Mobius Desktop manifest 生成/校验/版本一致性")
    p.add_argument("--selftest", action="store_true", help="内置自检 (不依赖 pytest)")
    sub = p.add_subparsers(dest="cmd")
    pg = sub.add_parser("generate", help="扫描目录生成 manifest.json")
    pg.add_argument("--dir", default=str(DESKTOP_BUILDS_DIR))
    pg.add_argument("--pkg", default=str(DESKTOP_PKG))
    pg.add_argument("--version", help="覆盖版本 (默认读 package.json)")
    pg.add_argument("--generated-at", dest="generated_at", help="注入 generatedAt (可复现)")
    pg.set_defaults(func=cmd_generate)
    pv = sub.add_parser("validate", help="校验 manifest schema + 版本一致 + size/sha")
    pv.add_argument("--dir", default=str(DESKTOP_BUILDS_DIR))
    pv.add_argument("--pkg", default=str(DESKTOP_PKG))
    pv.set_defaults(func=cmd_validate)
    pt = sub.add_parser("check-tag", help="校验 desktop-v<V> tag 与 package.json 一致")
    pt.add_argument("tag")
    pt.add_argument("--pkg", default=str(DESKTOP_PKG))
    pt.set_defaults(func=cmd_check_tag)
    args = p.parse_args()
    if args.selftest or not args.cmd:
        return _selftest()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
