"""``running.flag`` / ``failed.flag`` filesystem helpers.

The backends drop small marker files inside each project's
``.imac/flags/<session_id>/`` directory so that *external* processes
(the agent itself, monitoring scripts, etc.) can communicate task state
without a shared in-memory store.

Layout
------

::

    <root>/
    └── .imac/
        └── flags/
            └── <session_id>/
                ├── running.flag   ← present while a job is in progress
                └── failed.flag    ← present iff the agent terminated abnormally

Both files are tiny ``key=value`` text files. The agent removes
``running.flag`` when its job ends (success or failure) and writes
``failed.flag`` if it failed. The backend treats "running.flag missing"
as "job done", and "failed.flag present" as "job failed".

The functions in this module are designed to never throw — the ``safe_``
variants log the error and return ``False``. They are also idempotent:
removing a missing file is a no-op, and writing an existing file
overwrites it atomically (open-write-close, no temp file because the
race window does not matter for these markers).
"""

from __future__ import annotations

import os
import shutil
from datetime import datetime, timezone
from typing import Any, Mapping, Optional


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------
# TODO(mobius-rename): 本模块仍硬编码 ".imac", 尚未迁移到 MOBIUS_HIDDEN_FOLDER_NAME
# (JS 侧 backend/utils/session-flags.ts 已迁移). 当前本机 .env 设为 .imac, 故 JS / py 两端
# 一致, 不影响; 但新装若用默认 .mobius, 此处会写 .imac/flags 而 JS 后端读 .mobius/flags,
# 导致 flag 完成检测断裂. 迁移只需把下行 ".imac" 换成
# os.environ.get("MOBIUS_HIDDEN_FOLDER_NAME", ".mobius"). 暂按用户要求"忽略 agents_py".
def flag_dir_of(root: str | os.PathLike[str], session_id: str) -> str:
    """Return the absolute path of ``<root>/.imac/flags/<session_id>/``."""
    return os.path.join(os.path.abspath(str(root)), ".imac", "flags", session_id)


def running_flag_path_of(root: str | os.PathLike[str], session_id: str) -> str:
    return os.path.join(flag_dir_of(root, session_id), "running.flag")


def failed_flag_path_of(root: str | os.PathLike[str], session_id: str) -> str:
    return os.path.join(flag_dir_of(root, session_id), "failed.flag")


# ---------------------------------------------------------------------------
# Value escaping
# ---------------------------------------------------------------------------
# We keep the flag-file format compatible with the original JS schema:
# one ``key=value`` per line, with literal newlines in *values* encoded as
# ``\n`` so each entry stays on a single line and values truncated at 2000
# chars to bound file size.

def _encode_flag_value(value: Any) -> str:
    s = "" if value is None else str(value)
    return s.replace("\r\n", "\\n").replace("\n", "\\n")[:2000]


def _decode_flag_value(value: Any) -> str:
    return ("" if value is None else str(value)).replace("\\n", "\n")


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
def read_failed_flag(root: str | os.PathLike[str], session_id: str) -> Optional[dict]:
    """Parse ``failed.flag`` into a dict.

    Returns ``None`` if the file is missing or unreadable. Decodes the
    ``\\n``-escaped newlines that :func:`write_failed_flag` produces.
    """
    if not root or not session_id:
        return None
    try:
        with open(failed_flag_path_of(root, session_id), "r", encoding="utf-8") as f:
            body = f.read()
    except OSError:
        return None
    out: dict = {}
    for line in body.split("\n"):
        i = line.find("=")
        if i < 0:
            continue
        out[line[:i]] = _decode_flag_value(line[i + 1 :])
    return out


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------
def _now_iso() -> str:
    """Return the current UTC time as an ISO-8601 string with millisecond precision."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _write_kv_file(path: str, body: Mapping[str, Any]) -> None:
    """Write ``body`` as a ``key=value\\n`` text file, skipping empty values."""
    lines = []
    for k, v in body.items():
        if v is None or v == "":
            continue
        lines.append(f"{k}={v}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def write_running_flag(
    root: str | os.PathLike[str],
    session_id: str,
    fields: Optional[Mapping[str, Any]] = None,
) -> bool:
    """Write ``running.flag``. Creates the parent directory if needed.

    The file always includes ``session`` (the session id), ``pid`` (the
    writer's PID) and ``startedAt`` (UTC ISO timestamp). Additional keys
    can be supplied via ``fields``.
    """
    if not root or not session_id:
        return False
    os.makedirs(flag_dir_of(root, session_id), exist_ok=True)
    body: dict = {
        "session": session_id,
        "pid": os.getpid(),
        "startedAt": _now_iso(),
    }
    if fields:
        body.update(fields)
    _write_kv_file(running_flag_path_of(root, session_id), body)
    return True


def safe_write_running_flag(
    root: str | os.PathLike[str],
    session_id: str,
    fields: Optional[Mapping[str, Any]] = None,
    label: str = "session-flags",
) -> bool:
    """Like :func:`write_running_flag` but never raises; logs and returns ``False`` on error."""
    try:
        return write_running_flag(root, session_id, fields)
    except Exception as e:  # pragma: no cover — defensive
        print(f"[{label}] write running.flag failed ({session_id}): {e}")
        return False


def remove_running_flag(root: str | os.PathLike[str], session_id: str) -> bool:
    """Remove ``running.flag`` if present. No-op if already gone."""
    if not root or not session_id:
        return False
    try:
        os.remove(running_flag_path_of(root, session_id))
    except FileNotFoundError:
        pass
    return True


def safe_remove_running_flag(
    root: str | os.PathLike[str], session_id: str, label: str = "session-flags"
) -> bool:
    try:
        return remove_running_flag(root, session_id)
    except Exception as e:  # pragma: no cover — defensive
        print(f"[{label}] remove running.flag failed ({session_id}): {e}")
        return False


def write_failed_flag(
    root: str | os.PathLike[str],
    session_id: str,
    fields: Optional[Mapping[str, Any]] = None,
) -> bool:
    """Write ``failed.flag``. Values are newline-escaped.

    The file always includes ``session`` and ``failedAt`` (UTC ISO timestamp).
    """
    if not root or not session_id:
        return False
    os.makedirs(flag_dir_of(root, session_id), exist_ok=True)
    body: dict = {
        "session": session_id,
        "failedAt": _now_iso(),
    }
    if fields:
        body.update(fields)
    encoded = {k: _encode_flag_value(v) for k, v in body.items() if v is not None and v != ""}
    _write_kv_file(failed_flag_path_of(root, session_id), encoded)
    return True


def safe_write_failed_flag(
    root: str | os.PathLike[str],
    session_id: str,
    fields: Optional[Mapping[str, Any]] = None,
    label: str = "session-flags",
) -> bool:
    try:
        return write_failed_flag(root, session_id, fields)
    except Exception as e:  # pragma: no cover — defensive
        print(f"[{label}] write failed.flag failed ({session_id}): {e}")
        return False


def safe_remove_flag_dir(
    root: str | os.PathLike[str], session_id: str, label: str = "session-flags"
) -> bool:
    """Recursively remove ``<root>/.imac/flags/<session_id>/``. Safe if missing."""
    if not root or not session_id:
        return False
    try:
        shutil.rmtree(flag_dir_of(root, session_id), ignore_errors=False)
        return True
    except FileNotFoundError:
        return True
    except Exception as e:  # pragma: no cover — defensive
        print(f"[{label}] remove flag dir failed ({session_id}): {e}")
        return False


__all__ = [
    "flag_dir_of",
    "running_flag_path_of",
    "failed_flag_path_of",
    "read_failed_flag",
    "write_running_flag",
    "safe_write_running_flag",
    "remove_running_flag",
    "safe_remove_running_flag",
    "write_failed_flag",
    "safe_write_failed_flag",
    "safe_remove_flag_dir",
]
