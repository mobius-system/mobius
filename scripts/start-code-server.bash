#!/usr/bin/env bash
#
#

set -uo pipefail

SESSION=code-server
BIN=/usr/bin/code-server
PORT=45617
HOST=127.0.0.1
WORKDIR=${CODE_SERVER_CWD:-${HOME:-$(pwd)}}

ACTION=${1:-start}

if [[ ! -x "$BIN" ]]; then
  echo "x $BIN not found; install with: proxychains bash -c \"curl -fsSL https://code-server.dev/install.sh | sh\""
  exit 1
fi

case "$ACTION" in
  --stop|stop)
    tmux kill-session -t "$SESSION" 2>/dev/null && echo "stopped $SESSION" || echo "not running"
    fuser -k "${PORT}/tcp" 2>/dev/null
    exit 0
    ;;
  --restart|restart)
    tmux kill-session -t "$SESSION" 2>/dev/null
    fuser -k "${PORT}/tcp" 2>/dev/null
    sleep 1
    ;;
esac

if tmux has-session -t "$SESSION" 2>/dev/null && ss -tln 2>/dev/null | grep -qE "127.0.0.1:$PORT\b"; then
  echo "ok code-server already running (tmux session: $SESSION, http://$HOST:$PORT)"
  exit 0
fi

if ss -tln 2>/dev/null | grep -qE "127.0.0.1:$PORT\b"; then
  fuser -k "${PORT}/tcp" 2>/dev/null
  sleep 1
fi

tmux kill-session -t "$SESSION" 2>/dev/null
tmux new-session -d -s "$SESSION" -c "$WORKDIR"
tmux send-keys -t "$SESSION" \
  "unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN; exec '$BIN' --bind-addr ${HOST}:${PORT} --auth none --disable-telemetry --disable-update-check '$WORKDIR'" C-m

sleep 5
if ss -tln 2>/dev/null | grep -qE "127.0.0.1:$PORT\b"; then
  echo "✓ code-server up: http://$HOST:$PORT"
  echo "  tmux session: $SESSION (attach: tmux attach -t $SESSION)"
else
  echo "x startup failed; run: tmux capture-pane -p -t $SESSION"
fi
