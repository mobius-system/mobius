#!/usr/bin/env python3
from __future__ import annotations

# 标准库导入按用途分组：文件/JSON/正则/Shell/信号/socket/子进程
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


# 合法环境变量名格式（POSIX 命名规则）：字母/下划线开头，后接字母数字下划线。
# 用于过滤加载时遇到的非法键，避免把脏数据塞进 tmux/子进程环境。
VALID_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# 命中这些子串的键被认为是敏感配置，在日志/打印时会被脱敏（见 mask_setting_value）。
SECRET_SETTING = re.compile(r"(SECRET|TOKEN|PASSWORD|PASS|API_KEY|AUTH|BOOTSTRAP_USERS)")

# tmux 会继承父进程环境，但 TMUX/TMUX_PANE 是 tmux 自身的内部变量，
# 在已有 tmux 会话内再启动新会话时这些值会冲突，因此注入前必须剥离。
TMUX_ENV_EXCLUDE = {
    "TMUX",
    "TMUX_PANE",
}

# VSCode CLI 注入的 IPC 钩子变量。它们指向当前父 VSCode 进程的 socket/脚本，
# 子进程若继承会试图连接到错误的实例，启动前需剔除。
VSCODE_IPC_ENV = {
    "VSCODE_IPC_HOOK_CLI",
    "VSCODE_GIT_ASKPASS_NODE",
    "VSCODE_GIT_ASKPASS_MAIN",
}


class ConfigError(RuntimeError):
    pass


def ordered_unique(items: Iterable[str]) -> list[str]:
    # 保序去重：dict.from_keys 的等价手写版，保留首次出现顺序以便 RUNTIME_SETTINGS 的展示顺序稳定。
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


# 全项目允许通过 .env / 运行时 JSON 配置的键白名单。
# 用 ordered_unique 而不是 set，是为了让日志输出与文档顺序一致；
# 任何不在该列表里的 env 键会被加载器忽略，避免配置漂移。
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


# 集中日志目录的"最后兜底"值。权威取值来自 .env / .env.default 里的 MOBIUS_LOG_DIR
# (容器内该路径被 docker-compose 挂载到宿主机 ./host-data/data/logs, 宿主机可直接查看);
# 只有当 env 文件里都没设 MOBIUS_LOG_DIR 时才回落到这里的 /data/logs。
DEFAULT_LOG_DIR = "/data/logs"


def mobius_log_dir() -> str:
    """返回集中日志目录 (默认 /data/logs), 供所有脚本/服务统一引用。"""
    return os.environ.get("MOBIUS_LOG_DIR") or DEFAULT_LOG_DIR


def ensure_log_dir() -> Path:
    """创建集中日志目录 (存在即跳过), 返回该 Path。PM2 不会自动建目录, 启动前必须先建好。"""
    log_dir = Path(mobius_log_dir())
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir


def parse_env_value(raw: str) -> str:
    value = raw.strip()
    # 整体被单/双引号包裹时视为字面字符串，剥掉首尾引号并不再处理内部内容。
    # 这样可以保留值里的 # 号（例如 token），否则会被下面的注释分割误删。
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]

    # 未加引号：值后面跟着空白 + # 视为行内注释，截断掉。
    # 注意只匹配"空白+#"，避免误杀 URL/路径里的 # 片段。
    value = re.split(r"\s+#", value, maxsplit=1)[0]
    return value.strip()


def parse_env_line(line: str) -> tuple[str, str] | None:
    # 统一去掉换行与首尾空白后再判定。
    stripped = line.rstrip("\n").rstrip("\r").strip()
    # 空行和注释行直接跳过，返回 None 让调用方 continue。
    if not stripped or stripped.startswith("#"):
        return None

    # 兼容 shell 风格的 `export FOO=bar` 写法，去掉 export 前缀。
    # 长度判断是为了防止单独一行 "export "（仅前缀无内容）越界。
    if stripped.startswith("export ") and len(stripped) > len("export "):
        stripped = stripped[len("export ") :].strip()

    # 只接受 KEY=... 形式；不合法（如纯文本说明行）返回 None 被忽略。
    match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", stripped)
    if not match:
        return None

    key, raw_value = match.groups()
    return key, parse_env_value(raw_value)


@dataclass
class EnvFileLoader:
    known_settings: Sequence[str]
    # 默认指向 os.environ，便于在测试中注入隔离的 mapping。
    environ: MutableMapping[str, str] = field(default_factory=lambda: os.environ)
    # 记录每个键的来源（external env / .env / .env.default / 派生默认），用于诊断"为什么是这个值"。
    setting_source: dict[str, str] = field(default_factory=dict)
    # 仅记录由文件实际写入的键（不含外部环境自带的），用于判断哪些值需要落盘。
    loaded_env_keys: set[str] = field(default_factory=set)

    def mark_preexisting(self) -> None:
        # 在加载任何 .env 之前调用，把外部环境里已存在的键标注为"外部环境"来源，
        # 使其优先级高于后续 .env 文件（见 load_dotenv 中的优先级仲裁）。
        for key in self.known_settings:
            if key in self.environ:
                self.setting_source.setdefault(key, "loaded from external environment")

    def load_dotenv(self, env_file: Path, source: str, require_non_empty: bool = False) -> str:
        if not env_file.is_file():
            # 文件不存在不算错误，返回 missing 让调用方按需警告或跳过。
            return "missing"

        with env_file.open("r", encoding="utf-8") as handle:
            for line in handle:
                parsed = parse_env_line(line)
                if parsed is None:
                    continue

                key, value = parsed
                # 默认配置文件（.env.default）不允许空值，防止用空字符串误覆盖真正的默认；
                # .env 自身允许空值，以便用户主动清空某项。
                if require_non_empty and value == "":
                    raise ConfigError(f"{env_file} contains an empty default for {key}")

                if key in self.environ:
                    # 优先级仲裁：已被更高优先级来源（外部环境或更早加载的 .env）设置的键不被覆盖。
                    current_source = self.setting_source.get(key, "loaded from external environment")
                    self.setting_source[key] = current_source
                    if current_source != source:
                        # 仅同源才允许覆盖（即同一文件里后面行覆盖前面行）。
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
            # 把 JSON 语法错误转成项目统一的 ConfigError，便于上层统一捕获。
            raise ConfigError(f"{env_file} is not valid JSON: {exc}") from exc

        # 兼容两种结构：顶层就是 env 对象，或 {"env": {...}} 包裹。
        env_values = data.get("env", data)
        if not isinstance(env_values, dict):
            raise ConfigError(f"{env_file} does not contain an env object")

        for key, value in env_values.items():
            # 跳过非法键名（例如带连字符或数字开头的），保护下游 env 注入。
            if not isinstance(key, str) or not VALID_ENV_NAME.match(key):
                continue
            # JSON 里显式 null 视为未设置，跳过，否则会被 str() 转成字符串 "None"。
            if value is None:
                continue

            self.environ[key] = str(value)
            self.setting_source[key] = source
            self.loaded_env_keys.add(key)

        return "loaded"

    def require(self, key: str, script_name: str) -> None:
        # 用 .get() 的 falsy 判定而非 `key not in environ`，把空字符串也视作未设置。
        if not self.environ.get(key):
            raise ConfigError(
                f"{script_name}: missing required setting {key}; "
                "set it in external environment, .env, or .env.default"
            )

    def set_default(self, key: str, value: str, source: str = "derived default") -> None:
        # 仅在尚未被任何来源设置时填充默认值，优先级最低。
        if self.environ.get(key):
            return
        self.environ[key] = value
        # 用 setdefault：若已被 mark_preexisting 标过则保留原来源标签。
        self.setting_source.setdefault(key, source)


def chmod_private(file_path: Path) -> None:
    # 0600：仅文件所有者可读写，用于保护可能含密钥/会话的产物（如 .env 缓存、token 文件）。
    file_path.chmod(0o600)


def write_json_private(file_path: Path, data: object) -> None:
    # 先建父目录，避免首次写入时因目录缺失失败；存在即跳过。
    file_path.parent.mkdir(parents=True, exist_ok=True)
    # sort_keys 让输出稳定，便于 diff/重入校验；末尾换行符合 POSIX 文本文件惯例。
    file_path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    chmod_private(file_path)


def mask_setting_value(key: str, value: str) -> str:
    if SECRET_SETTING.search(key):
        # 空值显式返回空串（而不是 <redacted:0 chars>），避免在日志里看起来像异常。
        if value == "":
            return ""
        # 只暴露长度而非内容，方便诊断"是否被设置"且仍然不泄露明文。
        return f"<redacted:{len(value)} chars>"
    return value


def utc_timestamp() -> str:
    # 固定 UTC + Z 后缀，避免本地时区歧义，便于跨机器日志对齐。
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def shell_join(argv: Sequence[str | Path]) -> str:
    return " ".join(shlex.quote(str(arg)) for arg in argv)


def tee_command(argv: Sequence[str | Path], log_file: str | Path) -> str:
    # 拼出一条同时写入终端和日志文件的 shell 命令字符串（供脚本/SSH 等场景使用）。
    # 注意：调用方负责确保 log_file 路径可信，这里仅做 shlex 转义不验证内容。
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
    # 三种输出策略：capture=捕获到 CompletedProcess；quiet=完全丢弃；默认=继承父进程。
    # capture 与 quiet 同时为真时 capture 优先（更具体的诉求先满足）。
    stdout = subprocess.PIPE if capture else (subprocess.DEVNULL if quiet else None)
    stderr = subprocess.PIPE if capture else (subprocess.DEVNULL if quiet else None)
    return subprocess.run(
        # argv 允许传 Path，这里统一转成 str 以兼容 Windows/序列化场景。
        [str(arg) for arg in argv],
        check=check,
        # cwd 为 None 时让子进程继承当前工作目录；显式空字符串会被当作 falsy 同样继承。
        cwd=str(cwd) if cwd else None,
        # 复制成新 dict，避免 subprocess 内部修改传入的 environ 引发副作用。
        env=dict(env) if env is not None else None,
        # text=True 统一按文本读取 stdout/stderr，省去调用方手动 decode。
        text=True,
        stdout=stdout,
        stderr=stderr,
    )


def command_succeeds(argv: Sequence[str | Path]) -> bool:
    # 静默执行并仅根据退出码判断成功；用于探测类查询（如 tmux has-session、命令是否存在）。
    return run(argv, check=False, quiet=True).returncode == 0


def tmux_session_exists(session: str) -> bool:
    # tmux has-session 退出码：0=存在，1=不存在。check=False 把 1 转为返回值而非抛异常。
    return command_succeeds(["tmux", "has-session", "-t", session])


def kill_tmux_session(session: str) -> bool:
    # 先探测再杀，避免 kill-session 对不存在的会话报错污染日志。
    if not tmux_session_exists(session):
        return False
    run(["tmux", "kill-session", "-t", session])
    return True


def safe_tmux_environment(
    environ: Mapping[str, str],
    *,
    exclude: Iterable[str] = (),
) -> dict[str, str]:
    # 组装注入 tmux 之前要剥离的键集合：内置排除项 + 调用方临时追加的 exclude。
    excluded = set(TMUX_ENV_EXCLUDE)
    excluded.update(exclude)

    result: dict[str, str] = {}
    for key, value in environ.items():
        # 跳过 tmux 自身变量（避免套娃）以及任何非法命名的键（防止 tmux -e 报错）。
        if key in excluded:
            continue
        if not VALID_ENV_NAME.match(key):
            continue
        result[key] = value
    return result


def add_tmux_environment(argv: list[str], environ: Mapping[str, str]) -> list[str]:
    # 按 key 排序后追加成 tmux -e KEY=VAL 序列；排序是为了让生成的命令稳定、可复现/可对比。
    for key in sorted(environ):
        argv.extend(["-e", f"{key}={environ[key]}"])
    return argv


def pids_on_tcp_port(port: str | int) -> list[int]:
    try:
        completed = run(["lsof", f"-ti:{port}"], check=False, capture=True)
    except FileNotFoundError:
        # 系统未装 lsof 时静默返回空列表，让上层走其他清理路径（如 fuser）。
        return []

    pids: list[int] = []
    for line in completed.stdout.splitlines():
        # -t 让 lsof 只输出 PID（每行一个），但仍防御性地过滤掉非数字行。
        line = line.strip()
        if line.isdigit():
            pids.append(int(line))
    return pids


def kill_tcp_port_with_lsof(port: str | int) -> bool:
    pids = pids_on_tcp_port(port)
    if not pids:
        return False

    # 直接 SIGKILL 而非 SIGTERM：引导阶段通常要快速腾出端口给本服务，不留优雅退出的余地。
    # ProcessLookupError 表示进程在我们列出和发信号之间已退出，吞掉即可。
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return True


def kill_tcp_port_with_fuser(port: str | int) -> None:
    try:
        # fuser 是 lsof 不可用时的备用方案；check=False 静默忽略无进程占用的退出码。
        run(["fuser", "-k", f"{port}/tcp"], check=False, quiet=True)
    except FileNotFoundError:
        return


def port_is_listening(port: str | int) -> bool:
    port_text = str(port)
    try:
        # 主动建立 TCP 连接来判定端口是否真的在 accept；比解析 lsof/ss 更直接。
        # 仅探测 127.0.0.1（本机回环），不验证对外可达性。
        with socket.create_connection(("127.0.0.1", int(port_text)), timeout=0.4):
            return True
    except OSError:
        # 连接被拒/超时/路由不可达都视为"未监听"，统一返回 False。
        return False


def ss_lines_for_ports(ports: Iterable[str | int], include_process: bool = False) -> list[str]:
    port_values = [str(port) for port in ports]
    if not port_values:
        return []

    try:
        # -t=tcp -l=listen -n=不解析端口名；带 include_process 时再加 -p 显示进程信息（需 root）。
        completed = run(["ss", "-tlnp" if include_process else "-tln"], check=False, capture=True)
    except FileNotFoundError:
        return []

    result: list[str] = []
    for line in completed.stdout.splitlines():
        # 在每行里搜索 ":<port>" 词边界匹配；用 re.escape 防止 port 里出现正则元字符。
        if any(re.search(rf":{re.escape(port)}\b", line) for port in port_values):
            result.append(line)
    return result
