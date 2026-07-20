#!/usr/bin/env python3

#   ┌────────────────┬─────────────────────────────────────────────────────────────────────────────────────────┐
#   ├────────────────┼─────────────────────────────────────────────────────────────────────────────────────────┤
#   └────────────────┴─────────────────────────────────────────────────────────────────────────────────────────┘

#   ┌──────────────┬─────────────────────────────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────────────────┐
#   ├──────────────┼─────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────────────┤
#   └──────────────┴─────────────────────────────────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────────────────┘

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tempfile
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from boot_utils import (  # noqa: E402
    ConfigError,
    EnvFileLoader,
    RUNTIME_SETTINGS,
    DEFAULT_LOG_DIR,
    ensure_log_dir,
    kill_tcp_port_with_lsof,
    kill_tmux_session,
    run,
    ss_lines_for_ports,
    tmux_session_exists,
)


HERE = Path(__file__).resolve().parent
SESSION = "mobius-system"
PM2_APP = "mobius-system"
KNOWN_SETTINGS = RUNTIME_SETTINGS
BUILD_DIR = HERE / ".build"
PUBLIC_DIR = HERE / "public"
STAGING_PUBLIC_DIR = BUILD_DIR / "public.next"
BACKUP_PUBLIC_DIR = BUILD_DIR / "public.previous"
SERVER_TMP_VERSION = HERE / "server_tmp_version.js"
PM2_ECOSYSTEM = HERE / "ecosystem.config.js"
OTHER_VERSION_ROOT = Path(os.environ.get("MOBIUS_OTHER_VERSION_ROOT", "/tmp/mobius-system-other-versions"))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build and serve Mobius product frontend/backend.")
    parser.add_argument(
        "--other-versions",
        metavar="GIT_HASH",
        help="Build frontend and serve backend from another git commit via a temporary git worktree.",
    )
    parser.add_argument(
        "--hard-reset",
        metavar="GIT_HASH",
        help="Save current HEAD to discard/<timestamp>, reset hard to the commit, then rebuild in place.",
    )
    parser.add_argument(
        "--only-update-frontend",
        action="store_true",
        help="Compile frontend and replace mobius/public without restarting backend.",
    )
    return parser.parse_args()


def set_if_blank(key: str, value: str) -> None:
    if not os.environ.get(key):
        os.environ[key] = value


def load_configuration() -> None:
    loader = EnvFileLoader(KNOWN_SETTINGS)
    loader.mark_preexisting()
    loader.load_dotenv(REPO_ROOT / ".env", "loaded from .env")
    loader.load_dotenv(REPO_ROOT / ".env.default", "loaded from .env.default")

    debug_env_file = os.environ.get("MOBIUS_DEBUG_ENV_FILE")
    if debug_env_file:
        loader.load_runtime_json(Path(debug_env_file), "loaded from debug env")

    product_port = os.environ.get("VITE_PORT") or os.environ.get("MOBIUS_PORT") or "45616"
    os.environ["VITE_PORT"] = product_port
    os.environ["MOBIUS_PORT"] = product_port
    set_if_blank("NODE_ENV", "production")
    set_if_blank("MOBIUS_LOG_DIR", DEFAULT_LOG_DIR)
    ensure_log_dir()
    set_if_blank("VITE_API_TARGET", f"http://0.0.0.0:{product_port}")


def validate_production_config() -> None:
    """Internal helper."""
    problems = []
    secret = (os.environ.get("JWT_SECRET") or "").strip()
    if not secret or secret.startswith("change-me"):
        problems.append(
            "JWT_SECRET is unset or still a placeholder (change-me-...). The production backend will refuse to start.\n"
            "      Fix: set JWT_SECRET=<long random string> in .env\n"
            "      Generate: openssl rand -hex 32"
        )
    if problems:
        raise ConfigError("production configuration preflight failed:\n  " + "\n  ".join(problems))


def build_frontend(
    mobius_dir: Path = HERE,
    staging_public_dir: Path = STAGING_PUBLIC_DIR,
    step_label: str = "[1/4]",
) -> Path:
    print(f"=== {step_label} compile frontend into staging ===", flush=True)
    if staging_public_dir.exists():
        shutil.rmtree(staging_public_dir)
    staging_public_dir.parent.mkdir(parents=True, exist_ok=True)
    out_dir = os.path.relpath(staging_public_dir, mobius_dir / "frontend")
    build_env = dict(os.environ)
    build_env["MOBIUS_FRONTEND_OUT_DIR"] = out_dir

    run(
        ["npm", "run", "build", "--", "--emptyOutDir"],
        cwd=mobius_dir / "frontend",
        env=build_env,
    )
    return staging_public_dir


def promote_frontend_build(staging_dir: Path, step_label: str = "[2/4]") -> None:
    print()
    print(f"=== {step_label} promote compiled frontend ===", flush=True)
    if not (staging_dir / "index.html").is_file():
        raise ConfigError(f"compiled frontend missing {staging_dir / 'index.html'}")

    if BACKUP_PUBLIC_DIR.exists():
        shutil.rmtree(BACKUP_PUBLIC_DIR)

    moved_current_public = False
    try:
        if PUBLIC_DIR.exists():
            PUBLIC_DIR.rename(BACKUP_PUBLIC_DIR)
            moved_current_public = True
        staging_dir.rename(PUBLIC_DIR)
    except Exception:
        if moved_current_public and not PUBLIC_DIR.exists() and BACKUP_PUBLIC_DIR.exists():
            BACKUP_PUBLIC_DIR.rename(PUBLIC_DIR)
        raise

    _db_src = BACKUP_PUBLIC_DIR / "desktop-builds"
    _db_dst = PUBLIC_DIR / "desktop-builds"
    if _db_src.is_dir() and not _db_dst.exists():
        _db_src.rename(_db_dst)

    if BACKUP_PUBLIC_DIR.exists():
        shutil.rmtree(BACKUP_PUBLIC_DIR)


def reset_tmux_session() -> None:
    if tmux_session_exists(SESSION):
        print(f"kill existing {SESSION}")
        kill_tmux_session(SESSION)


def free_application_ports() -> None:
    ports = list(dict.fromkeys([os.environ["MOBIUS_PORT"], os.environ["VITE_PORT"]]))

    for port in ports:
        if kill_tcp_port_with_lsof(port):
            print(f"port {port} occupied, killing")
            time.sleep(0.2)


def pm2_command() -> list[str]:
    return ["npx", "--no-install", "pm2"]


def pm2_app_exists() -> bool:
    try:
        result = run(pm2_command() + ["describe", PM2_APP], cwd=HERE, check=False, quiet=True)
    except FileNotFoundError as exc:
        raise ConfigError("npm/npx not found; cannot start PM2") from exc
    return result.returncode == 0


def prepare_for_pm2_start() -> None:
    if pm2_app_exists():
        return
    reset_tmux_session()
    free_application_ports()


def ensure_aimux_bridge_runtime_env() -> None:
    """Populate AIMUX_BRIDGE_* defaults so PM2 ecosystem + Node backend pick them up."""
    core_data = os.environ.get("CORE_DATA_PATH") or str(REPO_ROOT / "protected_data")
    os.environ.setdefault("AIMUX_BRIDGE_HOST", "127.0.0.1")
    os.environ.setdefault("AIMUX_BRIDGE_PORT", "33315")


def ensure_aimux_bridge_venv() -> None:
    """Install or refresh mobius/.venv-aimux with aimux==0.1.14 (idempotent)."""
    print("=== ensuring aimux bridge venv (mobius/.venv-aimux) ===", flush=True)
    run(["bash", str(HERE / "scripts" / "setup-aimux-bridge.sh")], cwd=HERE)


def reload_backend(entrypoint: Path = HERE / "pm2-entrypoint.js") -> None:
    print()
    print(f"=== [3/4] reload product backend with PM2 :{os.environ['MOBIUS_PORT']} ===", flush=True)

    if not PM2_ECOSYSTEM.is_file():
        raise ConfigError(f"missing PM2 ecosystem file: {PM2_ECOSYSTEM}")

    env = dict(os.environ)
    env["MOBIUS_PM2_ENTRYPOINT"] = str(entrypoint)
    run(pm2_command() + ["startOrReload", PM2_ECOSYSTEM, "--update-env"], cwd=HERE, env=env)


def resolve_commit_hash(raw_hash: str, label: str) -> str:
    value = str(raw_hash or "").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{7,40}", value):
        raise ConfigError(f"{label} must be a 7-40 character git commit hash")
    result = run(
        ["git", "rev-parse", "--verify", f"{value}^{{commit}}"],
        cwd=REPO_ROOT,
        capture=True,
    )
    return result.stdout.strip()


def resolve_other_version_hash(raw_hash: str) -> str:
    return resolve_commit_hash(raw_hash, "other version")


def clear_tmp_version_entrypoint() -> None:
    if SERVER_TMP_VERSION.exists() or SERVER_TMP_VERSION.is_symlink():
        SERVER_TMP_VERSION.unlink()


def copy_if_exists(src: Path, dst: Path) -> None:
    if src.is_file():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def symlink_dependency_dir(src: Path, dst: Path) -> None:
    if dst.exists() or dst.is_symlink():
        return
    if not src.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(src, dst, target_is_directory=True)


def prepare_other_version_worktree(commit_hash: str) -> Path:
    OTHER_VERSION_ROOT.mkdir(parents=True, exist_ok=True)
    worktree = Path(tempfile.mkdtemp(prefix=f"mobius-{commit_hash[:12]}-", dir=OTHER_VERSION_ROOT))
    worktree.rmdir()
    run(["git", "worktree", "add", "--detach", worktree, commit_hash], cwd=REPO_ROOT)

    copy_if_exists(REPO_ROOT / ".env", worktree / ".env")
    copy_if_exists(REPO_ROOT / ".env.default", worktree / ".env.default")
    symlink_dependency_dir(HERE / "node_modules", worktree / "mobius" / "node_modules")
    symlink_dependency_dir(HERE / "frontend" / "node_modules", worktree / "mobius" / "frontend" / "node_modules")
    return worktree


def write_tmp_version_entrypoint(worktree: Path, commit_hash: str) -> None:
    mobius_dir = worktree / "mobius"
    server_js = mobius_dir / "server.js"
    if not server_js.is_file():
        raise ConfigError(f"other version missing {server_js}")
    SERVER_TMP_VERSION.write_text(
        "\n".join([
            "// Generated by mobius/start_product.py --other-versions.",
            "// Do not edit or commit this file.",
            f"process.env.MOBIUS_OTHER_VERSION_HASH = {json.dumps(commit_hash)};",
            f"process.env.MOBIUS_OTHER_VERSION_WORKTREE = {json.dumps(str(worktree))};",
            f"process.chdir({json.dumps(str(mobius_dir))});",
            f"require({json.dumps(str(server_js))});",
            "",
        ]),
        encoding="utf-8",
    )


def deploy_other_version(raw_hash: str) -> None:
    commit_hash = resolve_other_version_hash(raw_hash)
    print(f"=== [other-version] build Mobius from {commit_hash} ===")
    worktree = prepare_other_version_worktree(commit_hash)
    mobius_dir = worktree / "mobius"
    staging_dir = mobius_dir / ".build" / "public.next"
    staging_dir = build_frontend(mobius_dir, staging_dir)

    temp_public = mobius_dir / "public"
    if temp_public.exists():
        shutil.rmtree(temp_public)
    shutil.copytree(staging_dir, temp_public)

    promote_frontend_build(staging_dir)
    write_tmp_version_entrypoint(worktree, commit_hash)
    ensure_aimux_bridge_runtime_env()
    ensure_aimux_bridge_venv()
    prepare_for_pm2_start()
    reload_backend(SERVER_TMP_VERSION)
    time.sleep(2)
    print_status()


def build_and_start_current_tree() -> None:
    clear_tmp_version_entrypoint()
    staging_dir = build_frontend()
    promote_frontend_build(staging_dir)
    ensure_aimux_bridge_runtime_env()
    ensure_aimux_bridge_venv()
    prepare_for_pm2_start()
    reload_backend()
    time.sleep(2)
    print_status()


def update_frontend_only() -> None:
    staging_dir = build_frontend(step_label="[1/2]")
    promote_frontend_build(staging_dir, step_label="[2/2]")
    print_frontend_update_status()


def discard_branch_exists(branch_name: str) -> bool:
    result = run(
        ["git", "rev-parse", "--verify", f"refs/heads/{branch_name}"],
        cwd=REPO_ROOT,
        check=False,
        quiet=True,
    )
    return result.returncode == 0


def create_discard_branch() -> str:
    current_head = run(["git", "rev-parse", "--verify", "HEAD"], cwd=REPO_ROOT, capture=True).stdout.strip()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    base_name = f"discard/{timestamp}"
    branch_name = base_name
    suffix = 1
    while discard_branch_exists(branch_name):
        suffix += 1
        branch_name = f"{base_name}-{suffix}"
    run(["git", "branch", branch_name, current_head], cwd=REPO_ROOT)
    print(f"saved current HEAD {current_head} to branch {branch_name}")
    return branch_name


def hard_reset_current_tree(raw_hash: str) -> None:
    commit_hash = resolve_commit_hash(raw_hash, "hard reset target")
    print(f"=== [hard-reset] save current HEAD then reset Mobius to {commit_hash} ===")
    clear_tmp_version_entrypoint()
    discard_branch = create_discard_branch()
    run(["git", "reset", "--hard", commit_hash], cwd=REPO_ROOT)
    print(f"reset complete; previous HEAD is preserved at {discard_branch}")
    build_and_start_current_tree()


def print_status() -> None:
    port = os.environ["MOBIUS_PORT"]
    protected_data = os.environ.get("CORE_DATA_PATH") or str(REPO_ROOT / "protected_data")
    bridge_port = os.environ.get("AIMUX_BRIDGE_PORT", "33315")
    bridge_runtime = os.environ.get("AIMUX_BRIDGE_RUNTIME", "(default ~/.aimux/bridge/runtime.json)")

    print()
    print("=== [4/4] product stack status ===")
    for line in ss_lines_for_ports([port, bridge_port], include_process=True):
        print(line)

    print()
    print(f"pm2 app:        {PM2_APP} + mobius-system-bridge")
    print(f"frontend:       http://0.0.0.0:{port}")
    print(f"backend health: http://0.0.0.0:{port}/api/v2/health")
    print(f"aimux bridge:   http://127.0.0.1:{bridge_port} (proxy: /aimux_bridge/*)")
    print(f"bridge runtime: {bridge_runtime}")
    print(f"database:       {os.environ.get('DB_PATH', '(server default)')}")
    print(f"protected_data: {protected_data}")
    print()
    print(f"attach logs:    cd {HERE} && npx --no-install pm2 logs {PM2_APP} mobius-system-bridge")
    print(f"stop:           cd {HERE} && npx --no-install pm2 stop {PM2_APP} mobius-system-bridge")


def print_frontend_update_status() -> None:
    port = os.environ["MOBIUS_PORT"]

    print()
    print("=== frontend update complete ===")
    for line in ss_lines_for_ports([port], include_process=True):
        print(line)

    print()
    print("frontend files: mobius/public")
    print(f"frontend:       http://0.0.0.0:{port}")
    if pm2_app_exists():
        print(f"backend:        existing PM2 app {PM2_APP} left running")
    elif tmux_session_exists(SESSION):
        print(f"backend:        existing tmux session {SESSION} left running")
    else:
        print(f"backend:        no existing backend process detected; not started")


def main() -> int:
    args = parse_args()
    try:
        load_configuration()
        if args.other_versions and args.hard_reset:
            raise ConfigError("--other-versions and --hard-reset cannot be used together")
        if args.only_update_frontend and (args.other_versions or args.hard_reset):
            raise ConfigError("--only-update-frontend cannot be used with --other-versions / --hard-reset")
        if args.only_update_frontend:
            update_frontend_only()
            return 0
        validate_production_config()
        if args.other_versions:
            deploy_other_version(args.other_versions)
            return 0
        if args.hard_reset:
            hard_reset_current_tree(args.hard_reset)
            return 0
        build_and_start_current_tree()
        return 0
    except ConfigError as exc:
        print(f"start_product.py: {exc}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        print(f"start_product.py: command failed with exit code {exc.returncode}: {exc.cmd}", file=sys.stderr)
        return exc.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
