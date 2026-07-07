#!/usr/bin/env python3
# imac-test 的启动入口：加载配置 -> 写 accepted_setting.log / 调试 env 快照 ->
# 起 mobius -> 起 code-server tmux -> 端口健康检查 -> attach。
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# 启动相关的工具函数集中在 boot_utils，这里只编排流程，不重复实现细节。
from boot_utils import (
    ConfigError,
    EnvFileLoader,
    RUNTIME_SETTINGS,
    VSCODE_IPC_ENV,
    add_tmux_environment,
    ensure_log_dir,
    kill_tcp_port_with_fuser,
    kill_tmux_session,
    mask_setting_value,
    mobius_log_dir,
    ordered_unique,
    port_is_listening,
    run,
    safe_tmux_environment,
    tee_command,
    tmux_session_exists,
    utc_timestamp,
    write_json_private,
)


KNOWN_SETTINGS = RUNTIME_SETTINGS
BOOTSTRAP_USERS_FLAG_NAME = "bootstrap-users.json"


def parse_args(description: str) -> argparse.Namespace:
    # CLI 选项都对应主流程里的分支开关；互斥校验在 main() 里做，这里只负责声明。
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--detach",
        action="store_true",
        help="restart services without attaching to logs/session",
    )
    parser.add_argument(
        "--other-versions",
        metavar="GIT_HASH",
        help="build and serve Mobius from another git commit hash",
    )
    parser.add_argument(
        "--hard-reset",
        metavar="GIT_HASH",
        help="save current HEAD to discard/<timestamp>, reset hard to the commit, then rebuild in place",
    )
    parser.add_argument(
        "--force-vscode-server-restart",
        action="store_true",
        help="restart code-server even when the existing server is healthy",
    )
    parser.add_argument(
        "--only-update-frontend",
        action="store_true",
        help="compile and replace static frontend without restarting backend",
    )
    parser.add_argument(
        "--live-frontend-debug",
        action="store_true",
        help=(
            "run the Vite dev server (HMR) on a dedicated port so edits to "
            "mobius/frontend/src/** take effect in the browser instantly; backend stays on PM2"
        ),
    )
    return parser.parse_args()


def load_configuration(run_cwd: Path, script_name: str) -> tuple[EnvFileLoader, Path, Path, str, str]:
    # 用一份受控的白名单（KNOWN_SETTINGS）来解析 .env，避免任意变量意外进入子进程环境。
    loader = EnvFileLoader(KNOWN_SETTINGS)
    # 把启动前 os.environ 里就已经存在的键标记为 "external"，使后续 .env 不会覆盖外部已设的值。
    loader.mark_preexisting()

    env_file = run_cwd / ".env"
    env_default_file = run_cwd / ".env.default"
    env_file_status = loader.load_dotenv(env_file, "loaded from .env")
    # .env.default 必须非空：它是"默认值兜底"，若被设成空字符串会静默把功能关掉，故在此 fail-fast。
    env_default_file_status = loader.load_dotenv(
        env_default_file,
        "loaded from .env.default",
        require_non_empty=True,
    )

    # 这些是后续步骤（端口、工作目录、可执行路径）的硬依赖；缺一个都无法继续。
    for key in [
        "APP_DIR",
        "MOBIUS_PORT",
        "VITE_PORT",
        "VITE_HOST",
        "CODE_SERVER_PORT",
        "CODE_SERVER_CWD",
        "CS_BIN"
    ]:
        loader.require(key, script_name)

    app_dir = os.environ["APP_DIR"]
    mobius_port = os.environ["MOBIUS_PORT"]
    code_server_port = os.environ["CODE_SERVER_PORT"]

    # 派生默认值：仅在用户没显式设过时才写入（set_default 内部判断）。
    # debug-env.json 落到隐藏工作缓存目录下 (.imac / .mobius, 由 MOBIUS_HIDDEN_FOLDER_NAME 决定)。
    _hidden_folder = os.environ.get("MOBIUS_HIDDEN_FOLDER_NAME", ".mobius")
    loader.set_default("MOBIUS_DEBUG_ENV_FILE", f"{app_dir}/{_hidden_folder}/debug-env.json")
    loader.set_default("VITE_API_TARGET", f"http://0.0.0.0:{mobius_port}")
    # code-server 监听地址（host:port 格式），仅本机回环，避免裸暴露到外网。
    loader.set_default("CODE_SERVER_BIND", f"127.0.0.1:{code_server_port}")
    # code-server 对外宣称的访问 URL；和 BIND 不同，这里用 0.0.0.0 是给浏览器端展示用的。
    loader.set_default("VSCODE_WEB_URL", f"http://0.0.0.0:{code_server_port}")

    return loader, env_file, env_default_file, env_file_status, env_default_file_status


def env_snapshot_keys(loader: EnvFileLoader) -> list[str]:
    # 顺序：先白名单（稳定可读），再补 .env 里出现过的其余键；ordered_unique 去重并保留首次出现顺序。
    return ordered_unique([*KNOWN_SETTINGS, *sorted(loader.loaded_env_keys)])


def write_runtime_env_file(file_path: Path, loader: EnvFileLoader, generated_by: str) -> None:
    # 把当前实际生效的环境写一份到 <隐藏缓存目录>/debug-env.json，便于事后排查"为什么是这个值"。
    env = {
        key: os.environ[key]
        for key in env_snapshot_keys(loader)
        if key in os.environ
    }
    # write_json_private 会 chmod 0o600：调试文件里可能含敏感配置，不能给其他用户读。
    write_json_private(
        file_path,
        {
            "generated_by": generated_by,
            "generated_at": utc_timestamp(),
            "env": env,
        },
    )


def accepted_setting_rows(loader: EnvFileLoader) -> list[tuple[str, str, str]]:
    # 生成 (key, 来源, 脱敏值) 三元组列表；mask_setting_value 会把名称里带 SECRET/TOKEN 等的值打码。
    rows: list[tuple[str, str, str]] = []
    for key in env_snapshot_keys(loader):
        if key not in os.environ:
            continue
        value = os.environ[key]
        source = loader.setting_source.get(key, "loaded from external environment")
        rows.append((key, source, mask_setting_value(key, value)))
    return rows


def write_accepted_settings_log(
    log_file: Path,
    loader: EnvFileLoader,
    env_file: Path,
    env_default_file: Path,
    env_file_status: str,
    env_default_file_status: str,
    debug_env_file: Path,
) -> None:
    # 人可读的"本次启动实际生效的配置"快照；和 debug-env.json 互补（那个完整、这个脱敏+带来源）。
    lines = [
        f"accepted settings generated_at={utc_timestamp()}",
        f"root={os.environ['APP_DIR']}",
        f"env_file={env_file}",
        f"env_file_status={env_file_status}",
        f"env_default_file={env_default_file}",
        f"env_default_file_status={env_default_file_status}",
        f"debug_env_file={debug_env_file}",
        "",
        f"{'KEY':<44} {'SOURCE':<24} VALUE",
        f"{'---':<44} {'------':<24} -----",
    ]

    for key, source, masked_value in accepted_setting_rows(loader):
        lines.append(f"{key:<44} {source:<24} {masked_value}")

    log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")


def apply_product_port() -> None:
    # 关键约束：前端 dev server 和后端 API 必须用同一个端口（VITE 反代到自身）。
    # 取值优先级：显式 VITE_PORT > 显式 MOBIUS_PORT > 硬编码兜底 45616。
    product_port = os.environ.get("VITE_PORT") or os.environ.get("MOBIUS_PORT") or "45616"
    # 强制把两个变量对齐成同一个值，避免前端/后端各监听各的导致跨端口。
    os.environ["VITE_PORT"] = product_port
    os.environ["MOBIUS_PORT"] = product_port
    if not os.environ.get("VITE_API_TARGET"):
        os.environ["VITE_API_TARGET"] = f"http://0.0.0.0:{product_port}"


def start_mobius(
    root: Path,
    start_script_name: str,
    other_versions: str | None = None,
    hard_reset: str | None = None,
    only_update_frontend: bool = False,
) -> None:
    # 委托给 mobius/start_product.py：编译 + 启动的工作不在主入口里展开，这里只透传 CLI 选项。
    start_script = root / "mobius" / start_script_name
    # 用当前解释器（sys.executable）起子脚本，避免 PATH 里 python 指向别的版本。
    argv = [sys.executable, start_script]
    if other_versions:
        argv.extend(["--other-versions", other_versions])
    if hard_reset:
        argv.extend(["--hard-reset", hard_reset])
    if only_update_frontend:
        argv.append("--only-update-frontend")
    run(argv)


def bootstrap_flag_path(root: Path) -> Path:
    data_root = os.environ.get("MOBIUS_DATA_PATH")
    if not data_root:
        raise ConfigError("MOBIUS_DATA_PATH is required for bootstrap flag")
    return Path(data_root) / BOOTSTRAP_USERS_FLAG_NAME


def read_bootstrap_flag(root: Path) -> dict | None:
    path = bootstrap_flag_path(root)
    if not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError:
        print(f"=== [bootstrap] 初始化标记损坏，将重新检测: {path} ===", flush=True)
        return None
    if not isinstance(data, dict):
        print(f"=== [bootstrap] 初始化标记格式异常，将重新检测: {path} ===", flush=True)
        return None
    return data


def write_bootstrap_flag(root: Path, raw_users: str) -> None:
    write_json_private(bootstrap_flag_path(root), {"MOBIUS_BOOTSTRAP_USERS": raw_users})


def bootstrap_users(root: Path) -> None:
    # 直接部署路径没有 docker-entrypoint.sh, 首次启动需要补跑用户 seed。
    # 用 MOBIUS_DATA_PATH/bootstrap-users.json 做部署级标记, 避免每次启动都碰 users 表。
    # start.py 只看文件标记, 不直接读写数据库；真正建用户交给幂等的 bootstrap-users.js。
    raw_users = os.environ.get("MOBIUS_BOOTSTRAP_USERS") or ""
    if not raw_users:
        print("=== [bootstrap] MOBIUS_BOOTSTRAP_USERS 未设置，跳过用户初始化 ===", flush=True)
        return
    flag = read_bootstrap_flag(root)
    if flag:
        previous_users = flag.get("MOBIUS_BOOTSTRAP_USERS")
        if previous_users == raw_users:
            print(f"=== [bootstrap] 用户已初始化，跳过: {bootstrap_flag_path(root)} ===", flush=True)
            return
        print("=== [bootstrap] MOBIUS_BOOTSTRAP_USERS 已变化，补建缺失用户 ===", flush=True)

    script = root / "mobius" / "scripts" / "bootstrap-users.js"
    if not script.is_file():
        raise ConfigError(f"missing bootstrap script: {script}")
    print("=== [bootstrap] 初始化缺失用户 (MOBIUS_BOOTSTRAP_USERS) ===", flush=True)
    run(["node", "scripts/bootstrap-users.js"], cwd=root / "mobius", env=dict(os.environ))
    write_bootstrap_flag(root, raw_users)
    print(f"=== [bootstrap] 已写初始化标记: {bootstrap_flag_path(root)} ===", flush=True)


def bootstrap_self_evolve(root: Path) -> None:
    # 直接部署路径漏跑了 docker-entrypoint.sh 里的 bootstrap-self-evolve, 全新部署时
    # admin 看不到默认的 "Mobius Self Evolve" 自迭代项目。bootstrap-self-evolve.js 自身
    # 已做 admin 检查 + bind_path 幂等, 每次启动跑一次是安全的, 不需要 flag 文件。
    script = root / "mobius" / "scripts" / "bootstrap-self-evolve.js"
    if not script.is_file():
        print(f"=== [bootstrap] 跳过 self-evolve seed: {script} 不存在 ===", flush=True)
        return
    print("=== [bootstrap] seed 默认 Mobius Self Evolve 项目 (幂等) ===", flush=True)
    run(["node", "scripts/bootstrap-self-evolve.js"], cwd=root / "mobius", env=dict(os.environ))


def code_server_is_healthy() -> bool:
    # 健康判定要同时满足两个条件：tmux 会话还在 + 端口真的能连上。
    # 单看 tmux 会进程已死但 session 残留；单看端口可能撞上别的服务。
    return tmux_session_exists("code-server") and port_is_listening(os.environ["CODE_SERVER_PORT"])


def start_code_server(*, force_restart: bool = True) -> None:
    print()
    print(f"=== [2/3] code-server {os.environ['CODE_SERVER_BIND']} ===")

    # 幂等优化：默认启动时若已健康则跳过，减少无谓重启；--force-vscode-server-restart 可强制。
    if not force_restart and code_server_is_healthy():
        print("   code-server 已正常运行，跳过重启")
        print("   如需强制重启，执行 start.py 时加 --force-vscode-server-restart")
        return

    if not force_restart:
        print("   code-server 未正常运行，准备启动")

    # 先清理上一次的残留：kill 旧 tmux 会话 + 用 fuser 杀掉占用端口的进程。
    # 注意两步缺一不可：tmux kill 不会释放已被 code-server 子进程占住的端口。
    if kill_tmux_session("code-server"):
        print("   旧 code-server tmux 已 kill")

    kill_tcp_port_with_fuser(os.environ["CODE_SERVER_PORT"])

    # 构造实际要跑的 shell 命令：tee 一份到集中日志目录方便事后看输出 (宿主机可见)。
    command = tee_command(
        [
            os.environ["CS_BIN"],
            "--bind-addr",
            os.environ["CODE_SERVER_BIND"],
            "--auth",
            "none",
            "--disable-telemetry",
            "--disable-update-check",
            os.environ["CODE_SERVER_CWD"],
        ],
        str(ensure_log_dir() / "code-server.log"),
    )
    # 必须前置 unset 这几个变量：它们是从启动者（可能是另一个 VS Code 终端）继承下来的 IPC 句柄，
    # 若带进 code-server 子进程，会让新 code-server 误连到外层 VS Code 而不是自己起进程。
    command = "unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN; " + command

    # 过滤环境变量再传给 tmux：safe_tmux_environment 剔除名称非法的键和 VSCODE_IPC_ENV 这类敏感 IPC 变量。
    env = safe_tmux_environment(os.environ, exclude=VSCODE_IPC_ENV)
    argv = [
        "tmux",
        "new-session",
        "-d",  # detached：不 attach，让脚本继续往下走
        "-s",
        "code-server",
        "-c",
        os.environ["CODE_SERVER_CWD"],
    ]
    # add_tmux_environment 把每个环境变量转成 -e KEY=VAL 注入到 tmux 会话里。
    add_tmux_environment(argv, env)
    argv.append(command)

    run(argv)
    # 给 code-server 一点时间完成启动，再做后续健康检查（否则端口探测太早会误报失败）。
    time.sleep(2)


def _diagnose_backend_down(mobius_dir: Path) -> None:
    """后端端口没起来时, 主动把 PM2 状态和最近的日志打出来。

    避免"PM2 status=errored + 0 字节日志"的静默崩溃循环让人无从下手: 这里直接给出
    PM2 app 状态/重启次数, 并 tail 集中日志目录里的 error/out 日志, 指向根因。
    """
    log_dir = Path(mobius_log_dir())
    print("   ── 诊断: mobius 后端未监听, 正在排查 PM2 与日志 ──")
    pm2 = ["npx", "--no-install", "pm2"]

    # 1) PM2 app 状态 + 重启次数 (jlist 输出 JSON, 便于结构化解析)。
    try:
        completed = run(
            pm2 + ["jlist"], cwd=mobius_dir, check=False, capture=True, quiet=True
        )
        apps = json.loads(completed.stdout) if completed.stdout.strip() else []
        app = next((a for a in apps if a.get("name") == "mobius-system"), None)
        if app:
            env = app.get("pm2_env", {}) or {}
            status = env.get("status")
            restarts = env.get("restart_time")
            print(
                f"   PM2 mobius-system: status={status} 重启={restarts}次 "
                f"pid={app.get('pid')}"
            )
            if status != "online":
                print("   ⚠️  后端未处于 online —— 多为启动期抛错。查看下方日志尾部。")
        else:
            print("   PM2 里没有 mobius-system app (尚未注册/启动?)")
    except Exception as exc:  # noqa: BLE001 - 诊断逻辑里任何失败都不应掩盖端口未起的事实
        print(f"   (读取 PM2 状态失败: {exc})")

    # 2) tail 集中日志目录里的 error / out 日志 (宿主机同样可见)。
    for name in ["mobius-server-error.log", "mobius-server.log"]:
        log_path = log_dir / name
        if not log_path.is_file() or log_path.stat().st_size == 0:
            print(f"   {log_path}: (空)")
            continue
        print(f"   ── {log_path} (最后 25 行) ──")
        try:
            tail = run(
                ["tail", "-n", "25", str(log_path)],
                check=False,
                capture=True,
                quiet=True,
            )
            for line in (tail.stdout or "").splitlines():
                print(f"     {line}")
        except Exception as exc:  # noqa: BLE001
            print(f"     (读取失败: {exc})")

    print(f"   集中日志目录 (宿主机可见): {log_dir}")
    print(f"   手动排查: cd {mobius_dir} && npx --no-install pm2 logs mobius-system --lines 50")


def print_health_check() -> None:
    print()
    print("=== [3/3] 端口健康检查 ===")
    # 再多等一会儿：mobius 编译 + serve 起来比 code-server 慢，需要更长 grace period。
    time.sleep(3)

    mobius_port = os.environ["MOBIUS_PORT"]
    ports = [os.environ["CODE_SERVER_PORT"], mobius_port]

    for port in ports:
        if port_is_listening(port):
            print(f"   ✓ :{port} listen")
        else:
            print(f"   ✗ :{port} 未启动")
            # 后端端口没起来时不要只报"未启动": 主动诊断 PM2 + 日志, 把根因暴露出来。
            if port == mobius_port:
                _diagnose_backend_down(Path(os.environ["APP_DIR"]) / "mobius")


def print_summary(root: Path) -> None:
    frontend_port = os.environ["MOBIUS_PORT"]

    print()
    print(f"accepted settings: {root / 'accepted_setting.log'}")
    print(f"前端:           http://0.0.0.0:{frontend_port}")
    print(f"后端 health:    http://0.0.0.0:{os.environ['MOBIUS_PORT']}/api/v2/health")
    print(f"mobius PM2:     cd {root / 'mobius'} && npx --no-install pm2 logs mobius-system")
    print("code-server:    tmux attach -t code-server")
    print("claude code hub: tmux attach -t imac_claude_code_agent_hub  (用户首次发消息时按需起)")
    print(f"全停:           cd {root / 'mobius'} && npx --no-install pm2 stop mobius-system; tmux kill-session -t code-server -t imac_claude_code_agent_hub")


def print_frontend_update_summary(root: Path) -> None:
    frontend_port = os.environ["MOBIUS_PORT"]

    print()
    print(f"accepted settings: {root / 'accepted_setting.log'}")
    print(f"前端静态文件:     {root / 'mobius' / 'public'}")
    print(f"访问地址:         http://0.0.0.0:{frontend_port}")
    if port_is_listening(frontend_port):
        print(f"后端状态:         :{frontend_port} listen，未重启")
    else:
        print(f"后端状态:         :{frontend_port} 未监听，本次未启动后端")


LIVE_FRONTEND_PM2_APP = "mobius-system-vite-dev"
LIVE_FRONTEND_ECOSYSTEM = "ecosystem.live-frontend.config.js"


def _live_frontend_vite_port(backend_port: str) -> str:
    # 优先用显式配置 MOBIUS_LIVE_FRONTEND_PORT; 否则取后端口 +2 (45616 -> 45618),
    # 避开 +1 位置 (通常被 code-server 占用)。确保不和后端/同号冲突。
    explicit = (os.environ.get("MOBIUS_LIVE_FRONTEND_PORT") or "").strip()
    if explicit:
        if not explicit.isdigit():
            raise ConfigError(f"MOBIUS_LIVE_FRONTEND_PORT 必须是数字端口号, 当前值: {explicit}")
        if explicit == backend_port:
            raise ConfigError(
                f"MOBIUS_LIVE_FRONTEND_PORT ({explicit}) 不能等于后端端口, 请指定其它端口"
            )
        return explicit
    derived = str(int(backend_port) + 2)
    if derived == backend_port:
        derived = str(int(backend_port) + 3)
    return derived


def _pm2(argv: list[str], *, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess[str]:
    # 复用 start_product.py 的 pm2 调用约定 (npx --no-install, cwd=mobius), 与后端同一套管理面。
    return run(["npx", "--no-install", "pm2", *argv], cwd=Path(os.environ["APP_DIR"]) / "mobius", capture=capture, check=check)


def _ensure_backend_for_live_debug(root: Path, start_script_name: str) -> None:
    # 复用已在跑的生产后端: 后端在监听就直接用, 不重建不重启。
    # 后端没在跑才触发一次完整部署 (build + pm2), 保证 /api 可用 —— 这种情况罕见且一次性。
    backend_port = os.environ["MOBIUS_PORT"]
    if port_is_listening(backend_port):
        print(f"   后端已在 :{backend_port} 监听, 复用现有 PM2 后端 (不重启)")
        return
    print(f"   后端未在 :{backend_port} 监听, 先完整启动后端 (build + pm2) ...")
    sys.stdout.flush()
    start_mobius(root, start_script_name)


def _start_vite_dev_pm2(backend_port: str, vite_port: str) -> None:
    # 把 vite dev 需要的环境写进 os.environ, ecosystem 文件 (envKeys 白名单) 会在 pm2 start 时继承。
    # VITE_ALLOWED_HOSTS=all: dev 服务器放开 host 校验, 任凭 localhost / 局域网 IP / 域名访问都能打开
    # (前端 dev 本身无鉴权, 真实鉴权仍在后端 /api)。
    os.environ["VITE_PORT"] = vite_port
    os.environ["VITE_HOST"] = os.environ.get("VITE_HOST") or "0.0.0.0"
    os.environ["VITE_API_TARGET"] = f"http://127.0.0.1:{backend_port}"
    os.environ["VITE_ALLOWED_HOSTS"] = "all"

    ecosystem = Path(os.environ["APP_DIR"]) / "mobius" / LIVE_FRONTEND_ECOSYSTEM
    if not ecosystem.is_file():
        raise ConfigError(f"missing vite dev ecosystem file: {ecosystem}")

    # startOrReload 幂等: 已经在跑就 reload (更新 env), 没有就 start。
    _pm2(["startOrReload", str(ecosystem), "--update-env"])


def print_live_frontend_summary(backend_port: str, vite_port: str) -> None:
    vite_host = os.environ.get("VITE_HOST") or "0.0.0.0"
    access_host = "127.0.0.1" if vite_host == "0.0.0.0" else vite_host
    log_dir = Path(os.environ.get("MOBIUS_LOG_DIR") or "/data/logs")
    print()
    print("=== [live-frontend-debug] 前端实时调试模式已启动 ===")
    print(f"   前端 dev (HMR): http://{access_host}:{vite_port}   (绑定 {vite_host}; 局域网用本机 IP 也能访问)")
    print(f"   后端 API:       http://127.0.0.1:{backend_port}    (vite 已反代 /api /extension /_next /code-server)")
    print()
    print("   用法: 编辑 mobius/frontend/src/** 后, 浏览器自动热更新 (无需重新 build)。")
    print(f"   vite 日志: pm2 logs {LIVE_FRONTEND_PM2_APP}    (或 tail -f {log_dir / 'mobius-vite-dev.log'})")
    print(f"   退出调试: pm2 delete {LIVE_FRONTEND_PM2_APP}    (后端不受影响, 生产前端仍在 :{backend_port})")


def run_live_frontend_debug(root: Path, start_script_name: str) -> int:
    print()
    print("=== [live-frontend-debug] 前端实时调试模式 (Vite dev + HMR, 全程 PM2 管理) ===")
    backend_port = os.environ["MOBIUS_PORT"]
    vite_port = _live_frontend_vite_port(backend_port)

    print(f"=== [1/3] 确保后端运行 (:{backend_port}) ===")
    _ensure_backend_for_live_debug(root, start_script_name)

    print()
    print(f"=== [2/3] 启动 Vite dev server (:{vite_port}, 反代后端 :{backend_port}) via PM2 ===")
    sys.stdout.flush()
    _start_vite_dev_pm2(backend_port, vite_port)
    # vite 首次冷启动要扫描源码, 给几秒再探端口; 未就绪不报错, 提示看 pm2 logs。
    time.sleep(5)
    if port_is_listening(vite_port):
        print(f"   ✓ :{vite_port} listen (Vite dev server)")
    else:
        print(
            f"   ✗ :{vite_port} 暂未监听 — vite 可能仍在冷启动, 稍候查看 `pm2 logs {LIVE_FRONTEND_PM2_APP}`"
        )

    print()
    print("=== [3/3] 完成 ===")
    print_live_frontend_summary(backend_port, vite_port)
    return 0


def attach_to_mobius() -> None:
    # mobius 后端跑在 PM2 下而非前台 tmux，所以这里没有真正的 attach；
    # 只打印查看日志的方式给用户参考（与 print_summary 一致，避免用户以为没启动）。
    print()
    print("后端由 PM2 管理。可手动查看日志: cd mobius && npx --no-install pm2 logs mobius-system")


def main(
    *,
    script_name: str = "start.py",
    description: str = (
        "Restart Mobius (compile + serve frontend), compile/promote frontend only with "
        "--only-update-frontend, or run the Vite dev server with --live-frontend-debug."
    ),
    start_script_name: str = "start_product.py",
) -> int:
    args = parse_args(description)
    # 用解析后的绝对路径定位 .env；不依赖脚本文件位置，方便从不同目录调用。
    run_cwd = Path.cwd().resolve()

    try:
        loader, env_file, env_default_file, env_status, default_status = load_configuration(run_cwd, script_name)
        # 互斥的 CLI 组合，提前报错比让 start_product 自己崩更清晰。
        if args.other_versions and args.hard_reset:
            raise ConfigError("--other-versions 和 --hard-reset 不能同时使用")
        if args.only_update_frontend and (args.other_versions or args.hard_reset):
            raise ConfigError("--only-update-frontend 不能和 --other-versions / --hard-reset 同时使用")
        if args.live_frontend_debug and (
            args.other_versions or args.hard_reset or args.only_update_frontend or args.detach
        ):
            raise ConfigError(
                "--live-frontend-debug 不能和 --other-versions / --hard-reset / "
                "--only-update-frontend / --detach 同时使用"
            )
        apply_product_port()

        root = Path(os.environ["APP_DIR"])
        debug_env_file = Path(os.environ["MOBIUS_DEBUG_ENV_FILE"])

        # 先落盘两份快照（debug-env.json 全量、accepted_setting.log 脱敏），再起服务；
        # 这样即便后续启动失败也能事后看"当时打算用哪份配置"。
        write_runtime_env_file(debug_env_file, loader, script_name)
        write_accepted_settings_log(
            root / "accepted_setting.log",
            loader,
            env_file,
            env_default_file,
            env_status,
            default_status,
            debug_env_file,
        )

        # --only-update-frontend 走的是独立的 [1/1] 单步流程，到下面会 return 提前结束。
        # --live-frontend-debug 同样是独立流程: 复用现有后端 + 起 vite dev, 起完即 return。
        if args.live_frontend_debug:
            return run_live_frontend_debug(root, start_script_name)
        if args.only_update_frontend:
            print(f"=== [1/1] 更新 mobius 前端 (compile + replace :{os.environ['MOBIUS_PORT']}) ===")
        else:
            bootstrap_users(root)
            bootstrap_self_evolve(root)
            print(f"=== [1/3] 起 mobius (compile + serve :{os.environ['MOBIUS_PORT']}) ===")
        # 显式 flush：start_mobius 内部 run 会阻塞编译，这里先确保步骤标题被打印出去再阻塞。
        sys.stdout.flush()
        start_mobius(
            root,
            start_script_name,
            args.other_versions,
            args.hard_reset,
            args.only_update_frontend,
        )
        # 纯前端更新模式到此结束：不起 code-server、不做端口健康检查、不 attach。
        if args.only_update_frontend:
            print_frontend_update_summary(root)
            return 0

        start_code_server(force_restart=args.force_vscode_server_restart)
        print_health_check()
        print_summary(root)

        # 默认非 detach 模式下提示用户日志入口；--detach 用于自动化场景，跳过交互提示。
        if not args.detach:
            attach_to_mobius()

        return 0

    except ConfigError as exc:
        # 配置类错误统一退出码 2，区别于命令执行失败的子进程退出码。
        print(f"{script_name}: {exc}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        # 子进程失败时透传其退出码；若子进程退出码为 0（理论不该发生）则兜底 1。
        print(f"{script_name}: command failed with exit code {exc.returncode}: {exc.cmd}", file=sys.stderr)
        return exc.returncode or 1


if __name__ == "__main__":
    # 把 main 的返回值转成进程退出码；return 0 -> exit 0，return 2 -> exit 2。
    raise SystemExit(main())
