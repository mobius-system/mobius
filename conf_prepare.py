#!/usr/bin/env python3
"""Copy .env.default to .env and randomize the secrets in it.

  - JWT_SECRET                  -> a fresh random hex string.
  - MOBIUS_BOOTSTRAP_USERS        -> a fresh random password per bootstrap user.
  - local path settings         -> host paths derived from the project root
                                   unless --docker is passed.

Run this once before first start to materialize a real .env with non-default
credentials. Without it the backend refuses to start (see mobius/backend/config.js).
After writing .env, the changed key-value pairs are echoed to the console
(highlighted) so the operator can see the new values without opening the file.
"""
import argparse
import re
import secrets
import sys
from pathlib import Path

# Both files live next to this script (project root), resolve via __file__ so the
# script works no matter the current working directory it is invoked from.
BASE_DIR = Path(__file__).resolve().parent
ENV_DEFAULT = BASE_DIR / ".env.default"
ENV = BASE_DIR / ".env"

# ANSI styles for highlighting the changed values in the console.
_RESET = "\033[0m"
_BOLD = "\033[1m"
_YELLOW = "\033[33m"
_GREEN = "\033[32m"

LOCAL_PATH_KEYS = (
    "APP_DIR",
    "MOBIUS_DATA_PATH",
    "CORE_DATA_PATH",
    "MODEL_ACCESS_PATH",
    "DB_PATH",
    "MOBIUS_LOG_DIR",
    "WORKSPACE_ROOT",
    "HOME_WORKSPACE_ROOT",
    "LOCAL_WORKSPACE_ROOT",
    "TURNS_SUMMARY_DIR",
    "CODE_SERVER_DATA_ROOT",
    "CS_DATA_ROOT",
    "CS_EXT_ROOT",
)

LOCAL_DIRECTORY_KEYS = (
    "MOBIUS_DATA_PATH",
    "CORE_DATA_PATH",
    "MOBIUS_LOG_DIR",
    "WORKSPACE_ROOT",
    "HOME_WORKSPACE_ROOT",
    "LOCAL_WORKSPACE_ROOT",
    "TURNS_SUMMARY_DIR",
    "CODE_SERVER_DATA_ROOT",
    "CS_DATA_ROOT",
    "CS_EXT_ROOT",
)


def _randomize_bootstrap_users(match):
    """Replace the password field of each MOBIUS_BOOTSTRAP_USERS entry.

    Each entry is "id:password:role:display_name" (entries separated by ";").
    Only the password field (index 1) is replaced; id / role / display_name are
    preserved verbatim. NOTE: assumes passwords contain no ":" — consistent with
    the documented format in .env.default.
    """
    value = match.group(1)
    entries = []
    for entry in value.split(";"):
        parts = entry.split(":")
        if len(parts) >= 2:
            # 18 random bytes -> ~24-char URL-safe string; strong and login-safe.
            parts[1] = secrets.token_urlsafe(18)
            entry = ":".join(parts)
        entries.append(entry)
    return f"MOBIUS_BOOTSTRAP_USERS={';'.join(entries)}"


def _find_value(content, key):
    """Return the value of `key=` in content, or None if the key is absent."""
    m = re.search(rf"^{re.escape(key)}=(.*)$", content, flags=re.MULTILINE)
    return m.group(1) if m else None


def _set_value(content, key, value):
    """Replace `key=` in content, appending it if the key is absent."""
    line = f"{key}={value}"
    pattern = rf"^{re.escape(key)}=.*$"
    if re.search(pattern, content, flags=re.MULTILINE):
        return re.sub(pattern, line, content, flags=re.MULTILINE)
    return content.rstrip() + "\n" + line + "\n"


def _print_changed(key, value):
    """Print one changed key-value pair, highlighting the value when on a TTY."""
    if sys.stdout.isatty():
        line = f"  {_BOLD}{_YELLOW}{key}{_RESET}={_BOLD}{_GREEN}{value}{_RESET}"
    else:
        # Plain text when piped / not a console, to avoid raw escape codes in logs.
        line = f"  {key}={value}"
    print(line)


def _prompt_path(key, default):
    """Ask for a path value, using `default` when the user presses Enter."""
    if not sys.stdin.isatty():
        print(f"Using {key}={default} (stdin is not interactive).")
        return default

    value = input(f"{key} [{default}]: ").strip()
    return value or default


def _local_path_values(app_dir, data_path):
    """Build local path settings from APP_DIR and MOBIUS_DATA_PATH."""
    data = Path(data_path).expanduser().resolve()
    workspace = data / "workspace"
    code_server = data / "code_server"

    return {
        "APP_DIR": str(Path(app_dir).expanduser().resolve()),
        "MOBIUS_DATA_PATH": str(data),
        "CORE_DATA_PATH": str(data / "protected_data"),
        "MODEL_ACCESS_PATH": str(data / "model-access.json"),
        "DB_PATH": str(data / "mobuis.db"),
        "MOBIUS_LOG_DIR": str(data / "logs"),
        "WORKSPACE_ROOT": str(workspace),
        "HOME_WORKSPACE_ROOT": str(workspace / "home"),
        "LOCAL_WORKSPACE_ROOT": str(workspace / "employees"),
        "TURNS_SUMMARY_DIR": str(data / "turn-summaries"),
        "CODE_SERVER_DATA_ROOT": str(code_server),
        "CS_DATA_ROOT": str(code_server / "cs-data"),
        "CS_EXT_ROOT": str(code_server / "cs-ext"),
    }


def _prepare_local_paths(content):
    """Prompt for local roots, derive dependent paths, and create directories."""
    default_app_dir = str(BASE_DIR)
    default_data_path = str(BASE_DIR / "host_data" / "data")

    print("Local path configuration:")
    app_dir = _prompt_path("APP_DIR", default_app_dir)
    data_path = _prompt_path("MOBIUS_DATA_PATH", default_data_path)
    values = _local_path_values(app_dir, data_path)

    for key in LOCAL_PATH_KEYS:
        content = _set_value(content, key, values[key])

    for key in LOCAL_DIRECTORY_KEYS:
        Path(values[key]).mkdir(parents=True, exist_ok=True)

    return content


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--docker",
        action="store_true",
        help="keep container path defaults from .env.default",
    )
    args = parser.parse_args()

    # Start from the committed template; never mutate .env.default.
    content = ENV_DEFAULT.read_text(encoding="utf-8")

    # 32 random bytes -> 64-char hex string, matching the generation command
    # documented in .env.default (node crypto.randomBytes(32).toString('hex')).
    secret = secrets.token_hex(32)

    # Replace only the JWT_SECRET line (anchored at line start so we don't touch
    # any comments that happen to mention the key name).
    content = re.sub(r"^JWT_SECRET=.*$", f"JWT_SECRET={secret}", content, flags=re.MULTILINE)

    # Replace each bootstrap user's password; see _randomize_bootstrap_users.
    content = re.sub(
        r"^MOBIUS_BOOTSTRAP_USERS=(.*)$",
        _randomize_bootstrap_users,
        content,
        flags=re.MULTILINE,
    )

    if not args.docker:
        content = _prepare_local_paths(content)

    ENV.write_text(content, encoding="utf-8")
    print(f"Copied {ENV_DEFAULT.name} -> {ENV.name} and randomized secrets.")

    # Echo the changed key-value pairs, highlighted, so the new values are
    # visible immediately. Pull them back out of the final content (single source
    # of truth) rather than re-deriving them here.
    print("Changed values:")
    changed_keys = ["JWT_SECRET", "MOBIUS_BOOTSTRAP_USERS"]
    if not args.docker:
        changed_keys.extend(LOCAL_PATH_KEYS)
    for key in changed_keys:
        value = _find_value(content, key)
        if value is not None:
            _print_changed(key, value)


if __name__ == "__main__":
    main()
