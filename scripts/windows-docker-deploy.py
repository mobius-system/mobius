#!/usr/bin/env python3
"""
windows-docker-deploy.py  -  Stage 2: Mobius Docker deployment.

Called by windows-docker-deploy.ps1 after the portable Python runtime is ready.
Handles:
  1. conf_prepare.py --docker   (generate .env with random secrets)
  2. conf_check.py --docker     (validate the generated .env)
  3. docker build               (mobius-system-base + mobius-system-exe)
  4. docker compose up -d       (launch the stack)

Usage (normally invoked by the .ps1 bootstrap):
  python windows-docker-deploy.py
  python windows-docker-deploy.py --proxy-host 111.36.208.22 --proxy-port 12321 --proxy-user fuqingxu --proxy-pass claraclara
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Terminal helpers -- ANSI escapes work in Windows Terminal, degrade gracefully
# in classic conhost.
# ---------------------------------------------------------------------------
_RESET = "\033[0m"
_BOLD = "\033[1m"
_RED = "\033[31m"
_GREEN = "\033[32m"
_YELLOW = "\033[33m"
_CYAN = "\033[36m"
_MAGENTA = "\033[35m"
_GRAY = "\033[90m"


def _status(msg: str) -> None:
    print(f"{_CYAN}[*]{_RESET} {msg}")


def _success(msg: str) -> None:
    print(f"{_GREEN}[+]{_RESET} {msg}")


def _warning(msg: str) -> None:
    print(f"{_YELLOW}[!]{_RESET} {msg}")


def _error(msg: str) -> None:
    print(f"{_RED}[-]{_RESET} {msg}", file=sys.stderr)


def _banner() -> None:
    print()
    print(f"{_MAGENTA}{'=' * 48}{_RESET}")
    print(f"{_MAGENTA}  Mobius Windows Docker Deploy - Stage 2{_RESET}")
    print(f"{_MAGENTA}{'=' * 48}{_RESET}")
    print()


# ---------------------------------------------------------------------------
# Resolve paths relative to this script (scripts/), project root is parent.
# ---------------------------------------------------------------------------
_SCRIPT_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _SCRIPT_DIR.parent


def _run(argv: list, **kwargs) -> subprocess.CompletedProcess:
    """Run a command; print it; raise on non-zero exit."""
    cmd_str = " ".join(argv)
    _status(f"Running: {cmd_str}")
    kwargs.setdefault("check", True)
    kwargs.setdefault("cwd", str(_PROJECT_ROOT))
    return subprocess.run(argv, **kwargs)


# =========================================================================
# Step 1 - Generate .env with conf_prepare.py --docker
# =========================================================================
def step_conf_prepare() -> None:
    env_file = _PROJECT_ROOT / ".env"
    if env_file.exists():
        _warning(".env already exists - skipping conf_prepare.py.")
        _warning("  Delete it manually if you need fresh secrets: del .env")
        return

    _status("Generating .env from .env.default (docker mode) ...")
    script = str(_PROJECT_ROOT / "conf_prepare.py")
    _run([sys.executable, script, "--docker"])
    _success(".env generated with randomized secrets.")


# =========================================================================
# Step 2 - Validate .env with conf_check.py --docker
# =========================================================================
def step_conf_check() -> None:
    _status("Validating .env ...")
    script = str(_PROJECT_ROOT / "conf_check.py")
    _run([sys.executable, script, "--docker"])
    _success("Configuration validated.")


# =========================================================================
# Step 3 - Create host-data directories expected by docker-compose.yml
# =========================================================================
def step_host_data_dirs() -> None:
    _status("Creating host-data directories ...")
    dirs = ["host-data/app", "host-data/data", "host-data/codex", "host-data/claude"]
    for d in dirs:
        p = _PROJECT_ROOT / d
        p.mkdir(parents=True, exist_ok=True)
        print(f"  {'created' if not any(p.iterdir()) else 'exists':>8s}: {d}")
    _success("host-data directories ready.")


# =========================================================================
# Step 4 - Docker build (base + exe images)
# =========================================================================
def _docker_image_exists(tag: str) -> bool:
    result = subprocess.run(
        ["docker", "images", "-q", tag],
        capture_output=True, text=True, cwd=str(_PROJECT_ROOT),
    )
    return bool(result.stdout.strip())


def step_docker_build(proxy: dict | None) -> None:
    _status("Building Docker images ...")

    # --- 4a: mobius-system-base ---
    base_tag = "mobius-system-base:latest"
    if _docker_image_exists(base_tag):
        _warning(f"Image {base_tag} already exists - skipping build.")
        _warning(f"  Remove manually: docker rmi {base_tag}")
    else:
        _status(f"Building {base_tag} (deploy/Dockerfile) ...")
        base_args = [
            "docker", "build", "-t", base_tag,
            "-f", "deploy/Dockerfile",
        ]
        if proxy and proxy.get("host") and proxy.get("port"):
            base_args.extend(["--build-arg", f"PROXY_HOST={proxy['host']}"])
            base_args.extend(["--build-arg", f"PROXY_PORT={proxy['port']}"])
            if proxy.get("user"):
                base_args.extend(["--build-arg", f"PROXY_USER={proxy['user']}"])
            if proxy.get("pass"):
                base_args.extend(["--build-arg", f"PROXY_PASS={proxy['pass']}"])
        base_args.append(".")
        _run(base_args)
        _success(f"{base_tag} built.")

    # --- 4b: mobius-system-exe ---
    exe_tag = "mobius-system-exe:latest"
    if _docker_image_exists(exe_tag):
        _warning(f"Image {exe_tag} already exists - skipping build.")
        _warning(f"  Remove manually: docker rmi {exe_tag}")
    else:
        _status(f"Building {exe_tag} (Dockerfile) ...")
        _run(["docker", "build", "-t", exe_tag, "."])
        _success(f"{exe_tag} built.")


# =========================================================================
# Step 5 - docker compose up -d
# =========================================================================
def step_compose_up() -> None:
    _status("Launching stack with docker compose ...")

    # Bring down existing containers to get a clean slate.
    ps_result = subprocess.run(
        ["docker", "compose", "ps", "-q"],
        capture_output=True, text=True, cwd=str(_PROJECT_ROOT),
    )
    if ps_result.stdout.strip():
        _warning("Containers already running - bringing them down first.")
        _run(["docker", "compose", "down"])

    _run(["docker", "compose", "up", "-d"])
    _success("Stack launched.")

    # --- friendly summary ---
    print()
    _run(["docker", "compose", "ps"])
    print()

    # Read ports from .env
    vite_port = "33316"
    ssh_port = "33318"
    env_file = _PROJECT_ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("VITE_PORT="):
                vite_port = line.split("=", 1)[1].strip()
            elif line.startswith("MOBIUS_SSH_PORT="):
                ssh_port = line.split("=", 1)[1].strip()

    print(f"{_GREEN}{'=' * 48}{_RESET}")
    print(f"{_GREEN}  Mobius is starting!{_RESET}")
    print(f"  {_CYAN}Web UI:    http://localhost:{vite_port}{_RESET}")
    print(f"  {_CYAN}SSH:       localhost:{ssh_port}{_RESET}")
    print()
    print(f"  {_GRAY}Check logs:  docker compose logs -f{_RESET}")
    print(f"  {_GRAY}Stop stack:  docker compose down{_RESET}")
    print(f"{_GREEN}{'=' * 48}{_RESET}")


# =========================================================================
# Pre-flight checks
# =========================================================================
def _check_docker() -> None:
    """Verify Docker Desktop is running in Linux container mode."""
    try:
        result = subprocess.run(
            ["docker", "info"], capture_output=True, text=True, timeout=15,
        )
    except FileNotFoundError:
        _error("Docker is not installed. Please install Docker Desktop.")
        _error("  https://www.docker.com/products/docker-desktop/")
        sys.exit(1)
    except subprocess.TimeoutExpired:
        _error("Docker daemon is not responding. Please start Docker Desktop.")
        sys.exit(1)

    if result.returncode != 0:
        _error("Docker daemon is not running. Please start Docker Desktop.")
        sys.exit(1)

    if "OSType:" in result.stdout and "windows" in result.stdout.split("OSType:")[1].splitlines()[0].strip().lower():
        _error("Docker is in Windows container mode. Switch to Linux containers in Docker Desktop settings.")
        sys.exit(1)

    _success("Docker daemon is running (Linux containers).")

    # Check registry mirrors
    _check_registry_mirrors(result.stdout)

    # Show versions
    try:
        ver = subprocess.run(["docker", "--version"], capture_output=True, text=True, check=True)
        print(f"  {ver.stdout.strip()}")
    except Exception:
        pass
    try:
        ver = subprocess.run(["docker", "compose", "version"], capture_output=True, text=True, check=True)
        print(f"  {ver.stdout.strip()}")
    except Exception:
        pass


# =========================================================================
# Main
# =========================================================================
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Mobius Windows Docker Deploy - Stage 2",
    )
    parser.add_argument("--proxy-host", default="", help="HTTP proxy host")
    parser.add_argument("--proxy-port", default="", help="HTTP proxy port")
    parser.add_argument("--proxy-user", default="", help="HTTP proxy username")
    parser.add_argument("--proxy-pass", default="", help="HTTP proxy password")
    args = parser.parse_args()

    proxy = None
    if args.proxy_host and args.proxy_port:
        proxy = {
            "host": args.proxy_host,
            "port": args.proxy_port,
            "user": args.proxy_user,
            "pass": args.proxy_pass,
        }
        _status(f"Proxy: {args.proxy_host}:{args.proxy_port} (user: {args.proxy_user})")

    _banner()

    # --- pre-flight ---
    _check_docker()

    # --- deploy steps ---
    step_conf_prepare()
    step_conf_check()
    step_host_data_dirs()
    step_docker_build(proxy)
    step_compose_up()

    _success("Deployment complete.")



def _check_registry_mirrors(docker_info: str) -> None:
    """Check whether Docker Registry Mirrors are configured.

    Parses 'docker info' output for the 'Registry Mirrors:' section.
    Also checks the daemon.json file as a fallback.
    If no mirrors are found, displays a 10-second countdown warning in Chinese
    and lets the user decide whether to continue or abort.
    """
    mirrors: list[str] = []

    # -- parse 'docker info' output --
    in_mirror_section = False
    for line in docker_info.splitlines():
        stripped = line.strip()
        if stripped == "Registry Mirrors:":
            in_mirror_section = True
            continue
        if in_mirror_section:
            if stripped.startswith("http://") or stripped.startswith("https://"):
                mirrors.append(stripped)
            elif stripped == "" or not stripped.startswith(" "):
                if stripped and not stripped.startswith(" "):
                    in_mirror_section = False

    # -- fallback: read daemon.json --
    if not mirrors:
        daemon_json_paths = [
            Path(os.environ.get("USERPROFILE", "~")) / ".docker" / "daemon.json",
            Path("C:/ProgramData/Docker/config/daemon.json"),
        ]
        for p in daemon_json_paths:
            try:
                if p.exists():
                    import json
                    cfg = json.loads(p.read_text(encoding="utf-8"))
                    cfg_mirrors = cfg.get("registry-mirrors", [])
                    if cfg_mirrors:
                        mirrors.extend(cfg_mirrors)
                        break
            except Exception:
                pass

    if mirrors:
        _success(f"Registry Mirrors configured ({len(mirrors)} source(s)):")
        for m in mirrors:
            print(f"  {m}")
        return

    # -- no mirrors found: 10-second warning --
    import time as _time
    print()
    print(f"{_YELLOW}{'=' * 56}{_RESET}")
    print(f"{_YELLOW}  [警告] 未检测到 Docker Registry Mirror 镜像源配置{_RESET}")
    print(f"{_YELLOW}  {'=' * 56}{_RESET}")
    print()
    print(f"  未配置镜像源会导致 docker pull / build 下载速度极其缓慢。")
    print(f"  强烈建议在 Docker Desktop 设置中配置国内镜像源。")
    print()
    print(f"  配置方法 (Docker Desktop):")
    print(f"    Settings -> Docker Engine -> 编辑 daemon.json, 添加:")
    print(f"    {{")
    print(f'      "registry-mirrors": [')
    print(f'        "https://docker.1ms.run",')
    print(f'        "https://docker.xuanyuan.me"')
    print(f"      ]")
    print(f"    }}")
    print()
    print(f"  然后点击 'Apply & restart' 重启 Docker。")
    print()

    for remaining in range(10, 0, -1):
        print(f"\r  继续等待 {remaining:2d} 秒后自动继续 (按 Ctrl+C 可退出)...", end="", flush=True)
        _time.sleep(1)
    print()
    print(f"{_YELLOW}  已超时，将继续执行（但下载速度可能非常慢）。{_RESET}")
    print()


if __name__ == "__main__":
    main()
