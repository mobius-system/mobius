#!/usr/bin/env bash
# install-mobius-cli.bash — 把 mobius CLI 安装到 ~/.local/bin.
#
#   bash scripts/install-mobius-cli.bash
#
# 安装内容 (均无秘密, 可被 agent 任意查看):
#   multiagent_send        跨智能体双向通讯 (纯 curl → /api/multiagent_communication)
#   generate_localhost_jwt 从 .env 读 JWT_SECRET 签短期用户 JWT (node + jsonwebtoken)
set -euo pipefail

PREFIX="${PREFIX:-$HOME/.local/bin}"
SRC_DIR="$(cd "$(dirname "$(readlink -f "$0")")/cli" && pwd)"

mkdir -p "$PREFIX"

for cmd in multiagent_send generate_localhost_jwt; do
  src="$SRC_DIR/$cmd"
  if [ ! -f "$src" ]; then
    echo "ERROR: source not found: $src" >&2
    exit 1
  fi
  install -m 755 "$src" "$PREFIX/$cmd"
  echo "installed: $PREFIX/$cmd"
done

echo
echo "Done. Verification examples:"
echo "  multiagent_send --help"
echo "  generate_localhost_jwt <user_id>   # prints a 1h JWT"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo
     echo "Note: \$PATH does not contain $PREFIX; add this to your shell configuration:"
     echo "  export PATH=\"$PREFIX:\$PATH\"" ;;
esac
