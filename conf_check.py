#!/usr/bin/env python3
"""Validate .env before startup.

Checks:
  1. JWT_SECRET must be set and not the default placeholder.
  2. MOBIUS_BOOTSTRAP_USERS passwords must not be the default placeholder.
  3. APP_DIR, MOBIUS_DATA_PATH, and WORKSPACE_ROOT must exist on disk.
  4. MOBIUS_PORT, AIMUX_BRIDGE_PORT, and VITE_PORT must be free to bind.
  5. code-server must be installed via scripts/install-code-server.bash.
  6. helper bash commands must be installed via scripts/install-dummy-bash-cmd-list.bash.
  7. optionally install the experimental aimux bridge via mobius/scripts/setup-aimux-bridge.sh.

Checks 3, 4, 5, 6, and 7 are skipped when --docker is passed, because inside the
container these are absolute container paths / container-local ports / image-baked
tools that should not be checked against the host filesystem/network.

Exits non-zero on any failure so callers (e.g. start.py / CI) can abort cleanly.
"""
import argparse
import os
import re
import socket
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
ENV = BASE_DIR / ".env"
CODE_SERVER_INSTALLER = BASE_DIR / "scripts" / "install-code-server.bash"
DUMMY_BASH_CMD_INSTALLER = BASE_DIR / "scripts" / "install-dummy-bash-cmd-list.bash"
AIMUX_BRIDGE_INSTALLER = BASE_DIR / "mobius" / "scripts" / "setup-aimux-bridge.sh"
# The placeholder shipped in .env.default; treat it (and empty) as "unset".
DEFAULT_JWT_SECRET = "change-me-please-generate-a-random-secret"
# Default placeholder password inside MOBIUS_BOOTSTRAP_USERS (id:password:role:name).
DEFAULT_BOOTSTRAP_PASSWORD = "change-me-strong-password"


def parse_env(path):
    """Parse a simple KEY=VALUE .env file into a dict.

    Skips blank lines and comments. Does not handle quoting/expansion — the
    template uses plain values, and that's all we need to read here.
    """
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip()
    return env


def check_existing_path(env, key):
    """Fail unless `key` is set and points at an existing host path."""
    value = env.get(key, "").strip()
    if not value:
        print(f"ERROR: {key} is not set.", file=sys.stderr)
        sys.exit(1)

    path = Path(value)
    if not path.exists():
        print(f"ERROR: {key} ({path}) does not exist.", file=sys.stderr)
        sys.exit(1)


def read_port(env, key):
    """Return `key` parsed as a TCP port, or fail with a clear message."""
    value = env.get(key, "").strip()
    if not value:
        print(f"ERROR: {key} is not set.", file=sys.stderr)
        sys.exit(1)

    try:
        port = int(value, 10)
    except ValueError:
        print(f"ERROR: {key} ({value}) is not a valid TCP port.", file=sys.stderr)
        sys.exit(1)

    if port < 1 or port > 65535:
        print(f"ERROR: {key} ({port}) is outside the valid TCP port range.", file=sys.stderr)
        sys.exit(1)

    return port


def check_unique_ports(ports):
    """Fail if multiple required services are configured to use one port."""
    seen = {}
    for key, port in ports.items():
        if port in seen:
            print(
                f"ERROR: {key} and {seen[port]} are both configured to use port {port}.",
                file=sys.stderr,
            )
            sys.exit(1)
        seen[port] = key


def check_free_port(key, port):
    """Fail unless `port` can be bound on all IPv4 interfaces."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("0.0.0.0", port))
        except OSError as exc:
            print(f"ERROR: {key} ({port}) is not free to use: {exc}", file=sys.stderr)
            sys.exit(1)


def code_server_version(binary):
    """Return a short code-server version string, or None if it cannot be read."""
    try:
        result = subprocess.run(
            [str(binary), "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None

    if result.returncode != 0:
        return None

    for line in result.stdout.splitlines():
        line = line.strip()
        if re.match(r"^\d+(?:\.\d+)+(?:\s|$)", line):
            return line
    return None


def run_setup_script(script, label, *, env=None):
    """Run a local setup script and fail with context if it exits non-zero."""
    if not script.is_file():
        print(f"ERROR: {label} script not found: {script}", file=sys.stderr)
        sys.exit(1)

    print(f"Running {label}: {script}")
    try:
        subprocess.run(
            ["bash", str(script)],
            cwd=BASE_DIR,
            check=True,
            env=env,
        )
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: {label} failed with exit code {exc.returncode}.", file=sys.stderr)
        sys.exit(exc.returncode)


def confirm_experimental_aimux_bridge():
    """Ask whether to install the experimental aimux bridge."""
    print()
    print("Experimental functionality: aimux bridge")
    print("This can connect Mobius with other devices for remote compute workflows.")
    print("It installs/refreshes mobius/.venv-aimux by running mobius/scripts/setup-aimux-bridge.sh.")
    print("It may download Python packages from PyPI and can take a few minutes.")

    if not sys.stdin.isatty():
        print("Skipping aimux bridge setup because stdin is not interactive.")
        return False

    answer = input("Allow this experimental setup now? [y/N]: ").strip().lower()
    return answer in {"y", "yes"}


def install_code_server(env):
    """Install code-server for local, non-Docker startup."""
    binary = Path(env.get("CS_BIN", "/usr/bin/code-server").strip() or "/usr/bin/code-server")
    if binary.is_file() and os.access(binary, os.X_OK):
        version = code_server_version(binary)
        suffix = f" ({version})" if version else ""
        print(f"code-server already installed: {binary}{suffix}")
        return

    print(f"code-server not found at CS_BIN={binary}")
    print("Installing code-server now. This may take a few minutes and can prompt for sudo.")
    run_setup_script(
        CODE_SERVER_INSTALLER,
        "code-server installer",
        env={**os.environ, "CS_BIN": str(binary)},
    )

    if not (binary.is_file() and os.access(binary, os.X_OK)):
        print(
            f"ERROR: code-server installer completed, but CS_BIN is still not executable: {binary}",
            file=sys.stderr,
        )
        sys.exit(1)

    version = code_server_version(binary)
    suffix = f" ({version})" if version else ""
    print(f"code-server installed: {binary}{suffix}")


def install_dummy_bash_commands():
    """Install local helper shell commands for non-Docker startup."""
    run_setup_script(DUMMY_BASH_CMD_INSTALLER, "dummy bash command installer")


def maybe_install_aimux_bridge():
    """Install the experimental aimux bridge when the user explicitly agrees."""
    if not confirm_experimental_aimux_bridge():
        print("Skipped experimental aimux bridge setup.")
        return

    run_setup_script(AIMUX_BRIDGE_INSTALLER, "experimental aimux bridge setup")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--docker",
        action="store_true",
        help="skip host path and port checks for container-local resources",
    )
    args = parser.parse_args()

    # No .env yet -> the operator has not run prepare_conf.py.
    if not ENV.exists():
        print("ERROR: .env not found. Run prepare_conf.py first.", file=sys.stderr)
        sys.exit(1)

    env = parse_env(ENV)

    # Check 1: JWT_SECRET must be a real, per-deployment secret.
    jwt_secret = env.get("JWT_SECRET", "")
    if not jwt_secret or jwt_secret == DEFAULT_JWT_SECRET:
        print("ERROR: JWT_SECRET is still the default value. Run prepare_conf.py.", file=sys.stderr)
        sys.exit(1)

    # Check 2: every MOBIUS_BOOTSTRAP_USERS entry is "id:password:role:name" (multiple
    # entries separated by ";"). The password field must not be the default placeholder.
    # NOTE: this assumes passwords contain no ":" or ";" — consistent with the format
    # documented in .env.default.
    bootstrap_users = env.get("MOBIUS_BOOTSTRAP_USERS", "")
    if bootstrap_users:
        for entry in bootstrap_users.split(";"):
            entry = entry.strip()
            if not entry:
                continue
            parts = entry.split(":")
            if len(parts) >= 2 and parts[1] == DEFAULT_BOOTSTRAP_PASSWORD:
                print(
                    "ERROR: MOBIUS_BOOTSTRAP_USERS still has the default password "
                    f"for user '{parts[0]}'. Set a strong password.",
                    file=sys.stderr,
                )
                sys.exit(1)

    # Check 3/4: required host resources must be available. In Docker these are
    # container-local, so skip the checks there.
    if not args.docker:
        for key in ("APP_DIR", "MOBIUS_DATA_PATH", "WORKSPACE_ROOT"):
            check_existing_path(env, key)

        ports = {
            key: read_port(env, key)
            for key in ("MOBIUS_PORT", "AIMUX_BRIDGE_PORT", "VITE_PORT")
        }
        check_unique_ports(ports)
        for key, port in ports.items():
            check_free_port(key, port)
        install_code_server(env)
        install_dummy_bash_commands()
        maybe_install_aimux_bridge()

    print("Configuration OK")


if __name__ == "__main__":
    main()
