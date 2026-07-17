#!/usr/bin/env bash
set -euo pipefail

: "${APP_DIR:=/app}"
: "${MOBIUS_DATA_PATH:=/data}"
: "${MODEL_ACCESS_PATH:=$MOBIUS_DATA_PATH/model-access.json}"
: "${CORE_DATA_PATH:=/data/protected_data}"
: "${WORKSPACE_ROOT:=/data/workspace}"
: "${CS_DATA_ROOT:=/data/code_server/cs-data}"
: "${CS_EXT_ROOT:=/data/code_server/cs-ext}"
: "${CODE_SERVER_PORT:=33317}"
: "${MOBIUS_SSH_PORT:=33318}"
: "${MOBIUS_SSH_URL:=localhost:${MOBIUS_SSH_PORT}}"
: "${MOBIUS_SSH_FORWARD_USER:=mobius-forward}"

: "${AIMUX_BRIDGE_HOST:=127.0.0.1}"
: "${AIMUX_BRIDGE_PORT:=33315}"
export AIMUX_BRIDGE_HOST AIMUX_BRIDGE_PORT

export APP_DIR MOBIUS_DATA_PATH MODEL_ACCESS_PATH CORE_DATA_PATH WORKSPACE_ROOT
export CS_DATA_ROOT CS_EXT_ROOT CODE_SERVER_PORT
export MOBIUS_SSH_PORT MOBIUS_SSH_URL MOBIUS_SSH_FORWARD_USER

mkdir -p \
  "$APP_DIR" \
  "$MOBIUS_DATA_PATH" \
  "$(dirname "$MODEL_ACCESS_PATH")" \
  "$CORE_DATA_PATH" \
  "$WORKSPACE_ROOT" \
  "$CS_DATA_ROOT" \
  "$CS_EXT_ROOT"

if [[ -d /app_image ]] && [[ ! -d "$APP_DIR/mobius" ]]; then
  echo "[entrypoint] seeding $APP_DIR from /app_image (missing $APP_DIR/mobius)"
  cp -a /app_image/. "$APP_DIR"/
fi

# Keep the dummy image-display command available even when an older /app bind
# mount already exists or the image was built before this installer was added.
if [[ -f /app_image/scripts/install-dummy-bash-cmd-list.bash ]] && [[ ! -x /usr/local/bin/display_images ]]; then
  echo "[entrypoint] installing display_images"
  PREFIX=/usr/local/bin bash /app_image/scripts/install-dummy-bash-cmd-list.bash
fi

# -- seed codex credentials into the persistent bind mount on first boot --
CODEX_HOME_DIR="${CODEX_HOME:-${HOME:-/root}/.codex}"
if [[ -d /opt/codex-seed ]] && [[ -z "$(ls -A "$CODEX_HOME_DIR" 2>/dev/null)" ]]; then
  echo "[entrypoint] seeding $CODEX_HOME_DIR from /opt/codex-seed (first boot)"
  mkdir -p "$CODEX_HOME_DIR"
  cp -a /opt/codex-seed/. "$CODEX_HOME_DIR"/
fi

# -- seed claude settings into the persistent bind mount on first boot --
CLAUDE_HOME_DIR="${HOME:-/root}/.claude"
if [[ -d /opt/claude-seed ]] && [[ -z "$(ls -A "$CLAUDE_HOME_DIR" 2>/dev/null)" ]]; then
  echo "[entrypoint] seeding $CLAUDE_HOME_DIR from /opt/claude-seed (first boot)"
  mkdir -p "$CLAUDE_HOME_DIR"
  cp -a /opt/claude-seed/. "$CLAUDE_HOME_DIR"/
fi

if [[ -x /app_image/mobius/scripts/setup-ssh-port-forward.sh ]]; then
  echo "[entrypoint] starting ssh port-forward sshd on :${MOBIUS_SSH_PORT}"
  CORE_DATA_PATH="$CORE_DATA_PATH" \
  MOBIUS_SSH_PORT="$MOBIUS_SSH_PORT" \
  MOBIUS_SSH_FORWARD_USER="$MOBIUS_SSH_FORWARD_USER" \
    /app_image/mobius/scripts/setup-ssh-port-forward.sh start \
    || echo "[entrypoint] ssh port-forward sshd setup failed (startup continues)"
fi

cd "$APP_DIR/mobius"

# -- seed users + self-evolve project ------------------
if [[ -n "${MOBIUS_BOOTSTRAP_USERS:-}" ]]; then
  echo "[entrypoint] bootstrap-users"
  node scripts/bootstrap-users.js || echo "[entrypoint] bootstrap-users failed (startup continues)"
  IFS=';' read -ra _bs_users <<< "$MOBIUS_BOOTSTRAP_USERS"
  for _u in "${_bs_users[@]}"; do
    _id="${_u%%:*}"; _id="${_id## }"; _id="${_id%% }"
    [[ -n "$_id" ]] && mkdir -p "$WORKSPACE_ROOT/$_id"
  done
fi
echo "[entrypoint] bootstrap-self-evolve"
node scripts/bootstrap-self-evolve.js || echo "[entrypoint] bootstrap-self-evolve failed (continuing)"

# -- startup: start.py --detach starts backend/vite/code-server, then tail keeps PID 1 alive --
echo "[entrypoint] starting: python3 $APP_DIR/start.py --detach (injecting APP_DIR + CODE_SERVER_BIND)"
cd "$APP_DIR"
APP_DIR="$APP_DIR" \
CODE_SERVER_BIND="0.0.0.0:${CODE_SERVER_PORT}" \
CODE_SERVER_CWD="$APP_DIR" \
  python3 "start.py" --detach || echo "[entrypoint] start.py exit code $?"

sleep infinity;
