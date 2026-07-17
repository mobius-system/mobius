#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import shlex
import signal
import socket
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Mapping, MutableMapping, Sequence


VALID_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
SECRET_SETTING = re.compile(r"(SECRET|TOKEN|PASSWORD|PASS|API_KEY|AUTH|BOOTSTRAP_USERS)")

TMUX_ENV_EXCLUDE = {
    "TMUX",
    "TMUX_PANE",
}

VSCODE_IPC_ENV = {
    "VSCODE_IPC_HOOK_CLI",
    "VSCODE_GIT_ASKPASS_NODE",
    "VSCODE_GIT_ASKPASS_MAIN",
}


class ConfigError(RuntimeError):
    pass


def ordered_unique(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


RUNTIME_SETTINGS = ordered_unique(
    [
        "APP_DIR",
        "MOBIUS_HIDDEN_FOLDER_NAME",
        "MOBIUS_PORT",
        "VITE_PORT",
        "VITE_HOST",
        "VITE_ALLOWED_HOSTS",
        "VITE_API_TARGET",
        "VITE_HMR_PROTOCOL",
        "VITE_HMR_CLIENT_PORT",
        "MOBIUS_LIVE_FRONTEND_PORT",
        "CODE_SERVER_PORT",
        "MOBIUS_SSH_PORT",
        "MOBIUS_SSH_URL",
        "MOBIUS_SSH_FORWARD_USER",
        "MOBIUS_SSH_FORWARD_DIR",
        "MOBIUS_SSH_PRIVATE_KEY_PATH",
        "MOBIUS_SSH_KEY_PATH",
        "CODE_SERVER_BIND",
        "CODE_SERVER_CWD",
        "VSCODE_WEB_URL",
        "CS_BIN",
        "CODE_SERVER_DATA_ROOT",
        "CS_DATA_ROOT",
        "CS_EXT_ROOT",
        "DB_PATH",
        "MOBIUS_DATA_PATH",
        "MODEL_ACCESS_PATH",
        "CORE_DATA_PATH",
        "JWT_SECRET",
        "ENABLE_PASSWORD_LOGIN",
        "WORKSPACE_ROOT",
        "HOME_WORKSPACE_ROOT",
        "LOCAL_WORKSPACE_ROOT",
        "TURNS_SUMMARY_DIR",
        "CODEX_HOME",
        "MOBIUS_DEBUG_ENV_FILE",
        "MOBIUS_SKILLS_PROXY",
        "MOBIUS_SKILLS_NO_PROXY",
        "MOBIUS_TMUX_AGENT_INACTIVE_MS",
        "MOBIUS_TMUX_AGENT_CLEANUP_INTERVAL_MS",
        "MOBIUS_TMUX_AGENT_CLEANUP_FIRST_DELAY_MS",
        "CS_PORT_BASE",
        "CS_POOL_MAX",
        "CS_IDLE_TIMEOUT_MIN",
        "CS_MAX_PER_USER",
        "CS_MAX_TOTAL",
        "CS_READY_TIMEOUT_MS",
        "MOBIUS_BOOTSTRAP_USERS",
        "NPM_REGISTRY",
        "MOBIUS_LOG_DIR",
        "MOBIUS_TOKEN_PROXY_HOST",
        "MOBIUS_TOKEN_PROXY_PORT",
    ]
)


DEFAULT_LOG_DIR = "/data/logs"


def mobius_log_dir() -> str:
    """Internal helper."""
    return os.environ.get("MOBIUS_LOG_DIR") or DEFAULT_LOG_DIR


def ensure_log_dir() -> Path:
    """Internal helper."""
    log_dir = Path(mobius_log_dir())
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir


def parse_env_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]

    value = re.split(r"\s+#", value, maxsplit=1)[0]
    return value.strip()


def parse_env_line(line: str) -> tuple[str, str] | None:
    stripped = line.rstrip("\n").rstrip("\r").strip()
    if not stripped or stripped.startswith("#"):
        return None

    if stripped.startswith("export ") and len(stripped) > len("export "):
        stripped = stripped[len("export ") :].strip()

    match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", stripped)
    if not match:
        return None

    key, raw_value = match.groups()
    return key, parse_env_value(raw_value)


@dataclass
class EnvFileLoader:
    known_settings: Sequence[str]
    environ: MutableMapping[str, str] = field(default_factory=lambda: os.environ)
    setting_source: dict[str, str] = field(default_factory=dict)
    loaded_env_keys: set[str] = field(default_factory=set)

    def mark_preexisting(self) -> None:
        for key in self.known_settings:
            if key in self.environ:
                self.setting_source.setdefault(key, "loaded from external environment")

    def load_dotenv(self, env_file: Path, source: str, require_non_empty: bool = False) -> str:
        if not env_file.is_file():
            return "missing"

        with env_file.open("r", encoding="utf-8") as handle:
            for line in handle:
                parsed = parse_env_line(line)
                if parsed is None:
                    continue

                key, value = parsed
                if require_non_empty and value == "":
                    raise ConfigError(f"{env_file} contains an empty default for {key}")

                if key in self.environ:
                    current_source = self.setting_source.get(key, "loaded from external environment")
                    self.setting_source[key] = current_source
                    if current_source != source:
                        continue

                self.environ[key] = value
                self.setting_source[key] = source
                self.loaded_env_keys.add(key)

        return "loaded"

    def load_runtime_json(self, env_file: Path, source: str) -> str:
        if not env_file.is_file():
            return "missing"

        try:
            with env_file.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
        except json.JSONDecodeError as exc:
            raise ConfigError(f"{env_file} is not valid JSON: {exc}") from exc

        env_values = data.get("env", data)
        if not isinstance(env_values, dict):
            raise ConfigError(f"{env_file} does not contain an env object")

        for key, value in env_values.items():
            if not isinstance(key, str) or not VALID_ENV_NAME.match(key):
                continue
            if value is None:
                continue

            self.environ[key] = str(value)
            self.setting_source[key] = source
            self.loaded_env_keys.add(key)

        return "loaded"

    def require(self, key: str, script_name: str) -> None:
        if not self.environ.get(key):
            raise ConfigError(
                f"{script_name}: missing required setting {key}; "
                "set it in external environment, .env, or .env.default"
            )

    def set_default(self, key: str, value: str, source: str = "derived default") -> None:
        if self.environ.get(key):
            return
        self.environ[key] = value
        self.setting_source.setdefault(key, source)


def chmod_private(file_path: Path) -> None:
    file_path.chmod(0o600)


def write_json_private(file_path: Path, data: object) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    chmod_private(file_path)


def mask_setting_value(key: str, value: str) -> str:
    if SECRET_SETTING.search(key):
        if value == "":
            return ""
        return f"<redacted:{len(value)} chars>"
    return value


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def shell_join(argv: Sequence[str | Path]) -> str:
    return " ".join(shlex.quote(str(arg)) for arg in argv)


def tee_command(argv: Sequence[str | Path], log_file: str | Path) -> str:
    return f"{shell_join(argv)} 2>&1 | tee {shlex.quote(str(log_file))}"


def run(
    argv: Sequence[str | Path],
    *,
    check: bool = True,
    capture: bool = False,
    quiet: bool = False,
    cwd: Path | None = None,
    env: Mapping[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    stdout = subprocess.PIPE if capture else (subprocess.DEVNULL if quiet else None)
    stderr = subprocess.PIPE if capture else (subprocess.DEVNULL if quiet else None)
    return subprocess.run(
        [str(arg) for arg in argv],
        check=check,
        cwd=str(cwd) if cwd else None,
        env=dict(env) if env is not None else None,
        text=True,
        stdout=stdout,
        stderr=stderr,
    )


def command_succeeds(argv: Sequence[str | Path]) -> bool:
    return run(argv, check=False, quiet=True).returncode == 0


def tmux_session_exists(session: str) -> bool:
    return command_succeeds(["tmux", "has-session", "-t", session])


def kill_tmux_session(session: str) -> bool:
    if not tmux_session_exists(session):
        return False
    run(["tmux", "kill-session", "-t", session])
    return True


def safe_tmux_environment(
    environ: Mapping[str, str],
    *,
    exclude: Iterable[str] = (),
) -> dict[str, str]:
    excluded = set(TMUX_ENV_EXCLUDE)
    excluded.update(exclude)

    result: dict[str, str] = {}
    for key, value in environ.items():
        if key in excluded:
            continue
        if not VALID_ENV_NAME.match(key):
            continue
        result[key] = value
    return result


def add_tmux_environment(argv: list[str], environ: Mapping[str, str]) -> list[str]:
    for key in sorted(environ):
        argv.extend(["-e", f"{key}={environ[key]}"])
    return argv


def pids_on_tcp_port(port: str | int) -> list[int]:
    try:
        completed = run(["lsof", f"-ti:{port}"], check=False, capture=True)
    except FileNotFoundError:
        return []

    pids: list[int] = []
    for line in completed.stdout.splitlines():
        line = line.strip()
        if line.isdigit():
            pids.append(int(line))
    return pids


def kill_tcp_port_with_lsof(port: str | int) -> bool:
    pids = pids_on_tcp_port(port)
    if not pids:
        return False

    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return True


def kill_tcp_port_with_fuser(port: str | int) -> None:
    try:
        run(["fuser", "-k", f"{port}/tcp"], check=False, quiet=True)
    except FileNotFoundError:
        return


def port_is_listening(port: str | int) -> bool:
    port_text = str(port)
    try:
        with socket.create_connection(("127.0.0.1", int(port_text)), timeout=0.4):
            return True
    except OSError:
        return False


def ss_lines_for_ports(ports: Iterable[str | int], include_process: bool = False) -> list[str]:
    port_values = [str(port) for port in ports]
    if not port_values:
        return []

    try:
        completed = run(["ss", "-tlnp" if include_process else "-tln"], check=False, capture=True)
    except FileNotFoundError:
        return []

    result: list[str] = []
    for line in completed.stdout.splitlines():
        if any(re.search(rf":{re.escape(port)}\b", line) for port in port_values):
            result.append(line)
    return result
