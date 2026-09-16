#!/usr/bin/env bash
# Install the Mobius CLI commands into ~/.local/bin.
set -euo pipefail

PREFIX="${PREFIX:-$HOME/.local/bin}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SRC_DIR="$SCRIPT_DIR/cli"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "ERROR: CLI source directory not found: $SRC_DIR" >&2
  exit 1
fi
for required in bash awk curl node python3 install; do
  command -v "$required" >/dev/null 2>&1 || { echo "ERROR: required command not found: $required" >&2; exit 1; }
done
mkdir -p -- "$PREFIX"

APP_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "ERROR: required Mobius environment file not found: $APP_DIR/.env" >&2
  exit 1
fi

for cmd in multiagent_send generate_localhost_jwt declare_job_done declare_job_failed research_blackboard_read research_blackboard_write; do
  src="$SRC_DIR/$cmd"
  [[ -f "$src" ]] || { echo "ERROR: source not found: $src" >&2; exit 1; }
  install -m 755 -- "$src" "$PREFIX/$cmd"
  echo "installed: $PREFIX/$cmd"
done
install -m 755 -- "$SRC_DIR/research_blackboard_cli.js" "$PREFIX/.research_blackboard_cli"
printf '%s\n' "$APP_DIR" > "$PREFIX/.mobius-cli-app-dir"
chmod 644 "$PREFIX/.mobius-cli-app-dir"

echo
echo "Done. Safe verification examples:"
echo "  multiagent_send --help"
echo "  generate_localhost_jwt --help"
echo "  declare_job_done --help"
echo "  declare_job_failed --help"
echo "  research_blackboard_read --help"
echo "  research_blackboard_write --help"
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo; echo "Note: PATH does not contain $PREFIX; add: export PATH=\"$PREFIX:\$PATH\"" ;;
esac
