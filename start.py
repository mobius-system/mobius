#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

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
    loader = EnvFileLoader(KNOWN_SETTINGS)
    loader.mark_preexisting()

    env_file = run_cwd / ".env"
    env_default_file = run_cwd / ".env.default"
    env_file_status = loader.load_dotenv(env_file, "loaded from .env")
    env_default_file_status = loader.load_dotenv(
        env_default_file,
        "loaded from .env.default",
        require_non_empty=True,
    )

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

    _hidden_folder = os.environ.get("MOBIUS_HIDDEN_FOLDER_NAME", ".mobius")
    loader.set_default("MOBIUS_DEBUG_ENV_FILE", f"{app_dir}/{_hidden_folder}/debug-env.json")
    loader.set_default("VITE_API_TARGET", f"http://0.0.0.0:{mobius_port}")
    loader.set_default("CODE_SERVER_BIND", f"127.0.0.1:{code_server_port}")
    loader.set_default("VSCODE_WEB_URL", f"http://0.0.0.0:{code_server_port}")

    return loader, env_file, env_default_file, env_file_status, env_default_file_status


def env_snapshot_keys(loader: EnvFileLoader) -> list[str]:
    return ordered_unique([*KNOWN_SETTINGS, *sorted(loader.loaded_env_keys)])


def write_runtime_env_file(file_path: Path, loader: EnvFileLoader, generated_by: str) -> None:
    env = {
        key: os.environ[key]
        for key in env_snapshot_keys(loader)
        if key in os.environ
    }
    write_json_private(
        file_path,
        {
            "generated_by": generated_by,
            "generated_at": utc_timestamp(),
            "env": env,
        },
    )


def accepted_setting_rows(loader: EnvFileLoader) -> list[tuple[str, str, str]]:
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
    product_port = os.environ.get("VITE_PORT") or os.environ.get("MOBIUS_PORT") or "45616"
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
    start_script = root / "mobius" / start_script_name
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
        print(f"=== [bootstrap] bootstrap flag is invalid JSON; rechecking: {path} ===", flush=True)
        return None
    if not isinstance(data, dict):
        print(f"=== [bootstrap] bootstrap flag has an invalid shape; rechecking: {path} ===", flush=True)
        return None
    return data


def write_bootstrap_flag(root: Path, raw_users: str) -> None:
    write_json_private(bootstrap_flag_path(root), {"MOBIUS_BOOTSTRAP_USERS": raw_users})


def bootstrap_users(root: Path) -> None:
    raw_users = os.environ.get("MOBIUS_BOOTSTRAP_USERS") or ""
    if not raw_users:
        print("=== [bootstrap] MOBIUS_BOOTSTRAP_USERS is not set; skipping user bootstrap ===", flush=True)
        return
    flag = read_bootstrap_flag(root)
    if flag:
        previous_users = flag.get("MOBIUS_BOOTSTRAP_USERS")
        if previous_users == raw_users:
            print(f"=== [bootstrap] users already bootstrapped; skipping: {bootstrap_flag_path(root)} ===", flush=True)
            return
        print("=== [bootstrap] MOBIUS_BOOTSTRAP_USERS changed; seeding missing users ===", flush=True)

    script = root / "mobius" / "scripts" / "bootstrap-users.js"
    if not script.is_file():
        raise ConfigError(f"missing bootstrap script: {script}")
    print("=== [bootstrap] seed missing users (MOBIUS_BOOTSTRAP_USERS) ===", flush=True)
    run(["node", "scripts/bootstrap-users.js"], cwd=root / "mobius", env=dict(os.environ))
    write_bootstrap_flag(root, raw_users)
    print(f"=== [bootstrap] wrote bootstrap flag: {bootstrap_flag_path(root)} ===", flush=True)


def bootstrap_self_evolve(root: Path) -> None:
    script = root / "mobius" / "scripts" / "bootstrap-self-evolve.js"
    if not script.is_file():
        print(f"=== [bootstrap] skipping self-evolve seed: {script} does not exist ===", flush=True)
        return
    print("=== [bootstrap] seed default Mobius Self Evolve project (idempotent) ===", flush=True)
    run(["node", "scripts/bootstrap-self-evolve.js"], cwd=root / "mobius", env=dict(os.environ))


def code_server_is_healthy() -> bool:
    return tmux_session_exists("code-server") and port_is_listening(os.environ["CODE_SERVER_PORT"])


def start_code_server(*, force_restart: bool = True) -> None:
    print()
    print(f"=== [2/3] code-server {os.environ['CODE_SERVER_BIND']} ===")

    if not force_restart and code_server_is_healthy():
        print("   code-server is healthy; skipping restart")
        print("   to force a restart, run start.py with --force-vscode-server-restart")
        return

    if not force_restart:
        print("   code-server is not healthy; starting it")

    if kill_tmux_session("code-server"):
        print("   old code-server tmux session killed")

    kill_tcp_port_with_fuser(os.environ["CODE_SERVER_PORT"])

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
    command = "unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN; " + command

    env = safe_tmux_environment(os.environ, exclude=VSCODE_IPC_ENV)
    argv = [
        "tmux",
        "new-session",
        "-d",
        "-s",
        "code-server",
        "-c",
        os.environ["CODE_SERVER_CWD"],
    ]
    add_tmux_environment(argv, env)
    argv.append(command)

    run(argv)
    time.sleep(2)


def _diagnose_backend_down(mobius_dir: Path) -> None:
    """Internal helper."""
    log_dir = Path(mobius_log_dir())
    print("   -- diagnostic: mobius backend is not listening; checking PM2 and logs --")
    pm2 = ["npx", "--no-install", "pm2"]

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
                f"   PM2 mobius-system: status={status} restarts={restarts} "
                f"pid={app.get('pid')}"
            )
            if status != "online":
                print("   backend is not online; this is usually a startup exception. Check the log tail below.")
        else:
            print("   PM2 has no mobius-system app (not registered/started yet?)")
    except Exception as exc:
        print(f"   (failed to read PM2 status: {exc})")

    for name in ["mobius-server-error.log", "mobius-server.log"]:
        log_path = log_dir / name
        if not log_path.is_file() or log_path.stat().st_size == 0:
            print(f"   {log_path}: (empty)")
            continue
        print(f"   -- {log_path} (last 25 lines) --")
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
            print(f"     (read failed: {exc})")

    print(f"   central log directory (host-visible): {log_dir}")
    print(f"   manual check: cd {mobius_dir} && npx --no-install pm2 logs mobius-system --lines 50")


def print_health_check() -> None:
    print()
    print("=== [3/3] port health check ===")
    time.sleep(3)

    mobius_port = os.environ["MOBIUS_PORT"]
    ports = [os.environ["CODE_SERVER_PORT"], mobius_port]

    for port in ports:
        if port_is_listening(port):
            print(f"   ✓ :{port} listen")
        else:
            print(f"   x :{port} not started")
            if port == mobius_port:
                _diagnose_backend_down(Path(os.environ["APP_DIR"]) / "mobius")


def print_summary(root: Path) -> None:
    frontend_port = os.environ["MOBIUS_PORT"]
    agent_tmux_socket = os.environ.get("MOBIUS_AGENT_TMUX_SOCKET") or "mobius-agent"

    print()
    print(f"accepted settings: {root / 'accepted_setting.log'}")
    print(f"frontend:       http://0.0.0.0:{frontend_port}")
    print(f"backend health: http://0.0.0.0:{os.environ['MOBIUS_PORT']}/api/v2/health")
    print(f"mobius PM2:     cd {root / 'mobius'} && npx --no-install pm2 logs mobius-system")
    print("code-server:    tmux attach -t code-server")
    print(f"agent tmux hub:  tmux -L {agent_tmux_socket} attach -t imac_claude_code_agent_hub  (starts on demand when the user sends the first message)")
    print(f"stop all:       cd {root / 'mobius'} && npx --no-install pm2 stop mobius-system; tmux kill-session -t code-server; tmux -L {agent_tmux_socket} kill-session -t imac_claude_code_agent_hub; tmux -L {agent_tmux_socket} kill-session -t imac_codex_agent_hub")


def print_frontend_update_summary(root: Path) -> None:
    frontend_port = os.environ["MOBIUS_PORT"]

    print()
    print(f"accepted settings: {root / 'accepted_setting.log'}")
    print(f"frontend static files: {root / 'mobius' / 'public'}")
    print(f"access URL:            http://0.0.0.0:{frontend_port}")
    if port_is_listening(frontend_port):
        print(f"backend status:        :{frontend_port} listen; not restarted")
    else:
        print(f"backend status:        :{frontend_port} not listening; backend was not started in this run")


LIVE_FRONTEND_PM2_APP = "mobius-system-vite-dev"
LIVE_FRONTEND_ECOSYSTEM = "ecosystem.live-frontend.config.js"


def _live_frontend_vite_port(backend_port: str) -> str:
    explicit = (os.environ.get("MOBIUS_LIVE_FRONTEND_PORT") or "").strip()
    if explicit:
        if not explicit.isdigit():
            raise ConfigError(f"MOBIUS_LIVE_FRONTEND_PORT must be a numeric port; current value: {explicit}")
        if explicit == backend_port:
            raise ConfigError(
                f"MOBIUS_LIVE_FRONTEND_PORT ({explicit}) must not equal the backend port; choose another port"
            )
        return explicit
    derived = str(int(backend_port) + 2)
    if derived == backend_port:
        derived = str(int(backend_port) + 3)
    return derived


def _pm2(argv: list[str], *, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(["npx", "--no-install", "pm2", *argv], cwd=Path(os.environ["APP_DIR"]) / "mobius", capture=capture, check=check)


def _ensure_backend_for_live_debug(root: Path, start_script_name: str) -> None:
    backend_port = os.environ["MOBIUS_PORT"]
    if port_is_listening(backend_port):
        print(f"   backend already listening on :{backend_port}; reusing existing PM2 backend (no restart)")
        return
    print(f"   backend is not listening on :{backend_port}; starting backend first (build + PM2) ...")
    sys.stdout.flush()
    start_mobius(root, start_script_name)


def _start_vite_dev_pm2(backend_port: str, vite_port: str) -> None:
    os.environ["VITE_PORT"] = vite_port
    os.environ["VITE_HOST"] = os.environ.get("VITE_HOST") or "0.0.0.0"
    os.environ["VITE_API_TARGET"] = f"http://127.0.0.1:{backend_port}"
    os.environ["VITE_ALLOWED_HOSTS"] = "all"

    ecosystem = Path(os.environ["APP_DIR"]) / "mobius" / LIVE_FRONTEND_ECOSYSTEM
    if not ecosystem.is_file():
        raise ConfigError(f"missing vite dev ecosystem file: {ecosystem}")

    _pm2(["startOrReload", str(ecosystem), "--update-env"])


def print_live_frontend_summary(backend_port: str, vite_port: str) -> None:
    vite_host = os.environ.get("VITE_HOST") or "0.0.0.0"
    access_host = "127.0.0.1" if vite_host == "0.0.0.0" else vite_host
    log_dir = Path(os.environ.get("MOBIUS_LOG_DIR") or "/data/logs")
    print()
    print("=== [live-frontend-debug] live frontend debug mode started ===")
    print(f"   frontend dev (HMR): http://{access_host}:{vite_port}   (bind {vite_host}; LAN access can use this machine IP as well)")
    print(f"   backend API:        http://127.0.0.1:{backend_port}    (vite proxies /api /extension /_next /code-server)")
    print()
    print("   Usage: edit mobius/frontend/src/** and the browser hot-reloads automatically (no rebuild needed).")
    print(f"   vite logs: pm2 logs {LIVE_FRONTEND_PM2_APP}    (or tail -f {log_dir / 'mobius-vite-dev.log'})")
    print(f"   exit debug: pm2 delete {LIVE_FRONTEND_PM2_APP}    (backend is unaffected; production frontend remains on :{backend_port})")


def run_live_frontend_debug(root: Path, start_script_name: str) -> int:
    print()
    print("=== [live-frontend-debug] live frontend debug mode (Vite dev + HMR, managed by PM2) ===")
    backend_port = os.environ["MOBIUS_PORT"]
    vite_port = _live_frontend_vite_port(backend_port)

    print(f"=== [1/3] ensure backend is running (:{backend_port}) ===")
    _ensure_backend_for_live_debug(root, start_script_name)

    print()
    print(f"=== [2/3] start Vite dev server (:{vite_port}, proxy backend :{backend_port}) via PM2 ===")
    sys.stdout.flush()
    _start_vite_dev_pm2(backend_port, vite_port)
    time.sleep(5)
    if port_is_listening(vite_port):
        print(f"   ✓ :{vite_port} listen (Vite dev server)")
    else:
        print(
            f"   x :{vite_port} not listening yet - vite may still be cold-starting; check `pm2 logs {LIVE_FRONTEND_PM2_APP}`"
        )

    print()
    print("=== [3/3] done ===")
    print_live_frontend_summary(backend_port, vite_port)
    return 0


def attach_to_mobius() -> None:
    print()
    print("Backend is managed by PM2. View logs manually: cd mobius && npx --no-install pm2 logs mobius-system")


def ensure_daily_sync_scheduler(root: Path) -> None:
    """Internal helper."""
    loop = root / ".mobius" / "scripts" / "daily-sync-loop.sh"
    if not loop.is_file():
        return
    name = "mobius-daily-sync"
    try:
        import json as _json
        res = _pm2(["jlist"], capture=True, check=False)
        apps = _json.loads(res.stdout or "[]")
        app = next((a for a in apps if a.get("name") == name), None)
        if app:
            status = (app.get("pm2_env") or {}).get("status", "")
            if status != "online":
                _pm2(["start", name], check=False)
                print(f"   daily-sync scheduler: mobius-daily-sync revived (was {status})")
            return
        _pm2(["start", str(loop), "--name", name, "--cwd", str(root), "--time"], check=False)
        _pm2(["save"], check=False)
        print("   daily-sync scheduler: registered mobius-daily-sync (syncs daily at 04:00 Asia/Shanghai)")
    except Exception as exc:
        print(f"   daily-sync scheduler: skipped ({exc})")


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
    run_cwd = Path.cwd().resolve()

    try:
        loader, env_file, env_default_file, env_status, default_status = load_configuration(run_cwd, script_name)
        if args.other_versions and args.hard_reset:
            raise ConfigError("--other-versions and --hard-reset cannot be used together")
        if args.only_update_frontend and (args.other_versions or args.hard_reset):
            raise ConfigError("--only-update-frontend cannot be used with --other-versions / --hard-reset")
        if args.live_frontend_debug and (
            args.other_versions or args.hard_reset or args.only_update_frontend or args.detach
        ):
            raise ConfigError(
                "--live-frontend-debug cannot be used with --other-versions / --hard-reset / "
                "--only-update-frontend / --detach"
            )
        apply_product_port()

        root = Path(os.environ["APP_DIR"])
        debug_env_file = Path(os.environ["MOBIUS_DEBUG_ENV_FILE"])

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

        if args.live_frontend_debug:
            return run_live_frontend_debug(root, start_script_name)
        if args.only_update_frontend:
            print(f"=== [1/1] update mobius frontend (compile + replace :{os.environ['MOBIUS_PORT']}) ===")
        else:
            bootstrap_users(root)
            bootstrap_self_evolve(root)
            print(f"=== [1/3] start mobius (compile + serve :{os.environ['MOBIUS_PORT']}) ===")
        sys.stdout.flush()
        start_mobius(
            root,
            start_script_name,
            args.other_versions,
            args.hard_reset,
            args.only_update_frontend,
        )
        if args.only_update_frontend:
            print_frontend_update_summary(root)
            return 0

        start_code_server(force_restart=args.force_vscode_server_restart)
        ensure_daily_sync_scheduler(root)
        print_health_check()
        print_summary(root)

        if not args.detach:
            attach_to_mobius()

        return 0

    except ConfigError as exc:
        print(f"{script_name}: {exc}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        print(f"{script_name}: command failed with exit code {exc.returncode}: {exc.cmd}", file=sys.stderr)
        return exc.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
