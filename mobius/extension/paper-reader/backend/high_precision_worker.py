#!/usr/bin/env python3
"""后台高精度 PDF 解析 worker。

该进程由 paper-reader 以 detached 子进程启动，所有阶段通过 status.json
持久化，避免受 Mobius extension handler 的 30 秒限制。只在用户点击授权后
上传到 Doc2X；不会在本地快速解析阶段自动外传 PDF。
"""

from __future__ import annotations

import ast
import json
import os
import re
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import requests


API_ROOT = "https://v2.doc2x.noedgeai.com/api/v2"


def atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def status(path: Path, state: str, stage: str, progress: int, **extra) -> None:
    atomic_json(path, {"state": state, "stage": stage, "progress": progress,
                       "updated_at": time.time(), **extra})


def get_api_key() -> str:
    key = os.environ.get("DOC2X_API_KEY", "").strip()
    if key:
        return key
    config_path = Path(os.environ.get("DOC2X_CONFIG_PATH", "/home/tianyi/gpt_academic_private/config.py"))
    if not config_path.exists():
        return ""
    try:
        tree = ast.parse(config_path.read_text(encoding="utf-8"), filename=str(config_path))
        for node in tree.body:
            targets = getattr(node, "targets", [])
            if any(isinstance(t, ast.Name) and t.id == "DOC2X_API_KEY" for t in targets):
                value = ast.literal_eval(node.value)
                return str(value or "").strip()
    except Exception:
        return ""
    return ""


def api_json(session: requests.Session, method: str, url: str, **kwargs) -> dict:
    response = session.request(method, url, timeout=kwargs.pop("timeout", 30), **kwargs)
    try:
        body = response.json()
    except Exception as exc:
        raise RuntimeError(f"Doc2X 返回了无法解析的响应（HTTP {response.status_code}）") from exc
    data = body.get("data") or {}
    code = body.get("code", "")
    if response.status_code != 200 or code not in ("ok", "success"):
        message = data.get("message") or body.get("message") or code or f"HTTP {response.status_code}"
        raise RuntimeError(f"Doc2X 请求失败：{message}")
    return data


def wait_parse(session: requests.Session, key: str, uid: str, status_path: Path) -> None:
    for _ in range(90):
        data = api_json(session, "GET", f"{API_ROOT}/parse/status", headers={"Authorization": f"Bearer {key}"},
                       params={"uid": uid}, timeout=20)
        state = data.get("status")
        progress = int(float(data.get("progress") or 0))
        status(status_path, "running", "云端版面分析", min(65, 10 + int(progress * .55)), remote_status=state)
        if state == "success":
            return
        if state not in ("processing", "queued", "pending"):
            raise RuntimeError(f"Doc2X 解析失败：{data}")
        time.sleep(4)
    raise RuntimeError("Doc2X 原始解析超过 6 分钟仍未完成")


def convert(session: requests.Session, key: str, uid: str, fmt: str, status_path: Path, base: int) -> tuple[bytes, str]:
    api_json(session, "POST", f"{API_ROOT}/convert/parse", headers={"Authorization": f"Bearer {key}"},
             json={"uid": uid, "to": fmt, "formula_mode": "dollar", "filename": "paper-reader"}, timeout=20)
    for _ in range(80):
        data = api_json(session, "GET", f"{API_ROOT}/convert/parse/result", headers={"Authorization": f"Bearer {key}"},
                       params={"uid": uid}, timeout=20)
        state = data.get("status")
        status(status_path, "running", "生成 Markdown 与 LaTeX", base + (12 if fmt == "md" else 20), derivative=fmt, remote_status=state)
        if state == "success":
            url = str(data.get("url") or "")
            if not url:
                raise RuntimeError(f"Doc2X 没有返回 {fmt} 下载地址")
            response = session.get(url, timeout=90)
            response.raise_for_status()
            return response.content, url
        if state not in ("processing", "queued", "pending"):
            raise RuntimeError(f"Doc2X {fmt} 转换失败：{data}")
        time.sleep(3)
    raise RuntimeError(f"Doc2X {fmt} 转换超过 4 分钟仍未完成")


def first_file(root: Path, suffixes: tuple[str, ...]) -> Path | None:
    files = [p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in suffixes]
    return sorted(files, key=lambda p: (len(p.parts), str(p)))[0] if files else None


def extract_zip(blob: bytes, root: Path, suffix: str) -> tuple[str, str]:
    root.mkdir(parents=True, exist_ok=True)
    archive = root / f"{suffix}.zip"
    archive.write_bytes(blob)
    target = root / suffix
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as zf:
        for member in zf.infolist():
            name = Path(member.filename)
            if name.is_absolute() or ".." in name.parts:
                continue
            zf.extract(member, target)
    source = first_file(target, (f".{suffix}",))
    if source is None:
        raise RuntimeError(f"Doc2X 压缩包中没有找到 {suffix.upper()} 文件")
    return source.read_text(encoding="utf-8", errors="replace"), str(target)


def run(job: dict) -> None:
    status_path = Path(job["status_path"])
    output_dir = Path(job["output_dir"])
    pdf_path = Path(job["pdf_path"])
    status(status_path, "running", "准备高精度云解析", 2)
    key = get_api_key()
    if not key:
        raise RuntimeError("未配置 DOC2X_API_KEY，无法启动高精度云解析")
    if not pdf_path.exists():
        raise RuntimeError("原始 PDF 不存在，无法启动高精度云解析")
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {key}", "User-Agent": "Mobius Paper Reader"})
    status(status_path, "running", "上传 PDF 到高精度解析服务", 8)
    pre = api_json(session, "POST", f"{API_ROOT}/parse/preupload", timeout=20)
    upload_url, uid = str(pre.get("url") or ""), str(pre.get("uid") or "")
    if not upload_url or not uid:
        raise RuntimeError("Doc2X 预上传没有返回有效任务 UID")
    with pdf_path.open("rb") as fh:
        response = session.put(upload_url, data=fh, timeout=120)
        response.raise_for_status()
    wait_parse(session, key, uid, status_path)
    md_blob, md_root = convert(session, key, uid, "md", status_path, 65)
    md, _ = extract_zip(md_blob, output_dir, "md")
    tex_blob, tex_root = convert(session, key, uid, "tex", status_path, 77)
    tex, _ = extract_zip(tex_blob, output_dir, "tex")
    md = md.replace("```markdown", "").replace("```md", "")
    result = {"provider": "doc2x", "provider_version": "v2", "uid": uid,
              "markdown": md[:4_000_000], "latex": tex[:8_000_000],
              "markdown_root": md_root, "latex_root": tex_root}
    atomic_json(output_dir / "result.json", result)
    status(status_path, "completed", "高精度解析完成，等待写入阅读索引", 100,
           result_path=str(output_dir / "result.json"), uid=uid)


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    status_path = Path(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["status_path"])
    try:
        job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        run(job)
        return 0
    except Exception as exc:
        status(status_path, "failed", "高精度解析失败", 100, error=str(exc)[:2000])
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
