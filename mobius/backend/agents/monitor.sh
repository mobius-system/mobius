#!/bin/sh
# monitor.sh - 循环轮询一个 agent session 的状态 (每 3s 一轮).
#
# 用法:
#   bash mobius/backend/agents/monitor.sh --session=<sessionId> --type=<claude|codex|deepseek>
#
# 每轮打印:
#   isAlive / isWorking / getRecentError / getHistory / getSessionTitle / realTimeInfo
#
# 说明: 直接 require 后端 AgentBackend 单例 (与 server 同一套持久化映射文件),
# 只读查询, 不创建/终止 session. Ctrl-C 退出.
set -eu

SESSION_ID=""
AGENT_TYPE=""

for arg in "$@"; do
  case "$arg" in
    --session=*) SESSION_ID="${arg#--session=}" ;;
    --type=*)    AGENT_TYPE="${arg#--type=}" ;;
    --help|-h)
      sed -n '2,12p' "$0"; exit 0 ;;
    *)
      echo "未知参数: $arg" >&2; echo "用法: $0 --session=<sessionId> --type=<claude|codex|deepseek>" >&2; exit 1 ;;
  esac
done

if [ -z "$SESSION_ID" ] || [ -z "$AGENT_TYPE" ]; then
  echo "用法: $0 --session=<sessionId> --type=<claude|codex|deepseek>" >&2
  exit 1
fi

# 脚本在 agents/ 目录下, 保证相对 require 可解析
cd "$(dirname "$0")"

# backend services 是 .ts, 与 server 同款 tsx hook 加载
TSX="$PWD/../../node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "找不到 tsx: $TSX (需要在 mobius/ 下 npm install)" >&2
  exit 1
fi

export MONITOR_SESSION_ID="$SESSION_ID"
export MONITOR_AGENT_TYPE="$AGENT_TYPE"

exec node --require "$PWD/../../node_modules/tsx/dist/cjs/index.cjs" - <<'EOF'
const { get } = require('./index')

const sessionId = process.env.MONITOR_SESSION_ID
const agentType = process.env.MONITOR_AGENT_TYPE

const TYPE_TO_BACKEND = {
  claude: 'tmux-claude-code',
  codex: 'tmux-codex',
  deepseek: 'deepseek-harness',
}
const backendName = TYPE_TO_BACKEND[agentType]
if (!backendName) {
  console.error(`未知 --type: ${agentType} (可选 claude / codex / deepseek)`)
  process.exit(1)
}

const backend = get(backendName)
console.log(`[monitor] backend=${backendName} session=${sessionId} (Ctrl-C 退出)`)

// 单值压成一行可读文本; 超长截断, 避免刷屏.
function fmt(value, maxLen = 300) {
  let text
  if (value === null || value === undefined) text = String(value)
  else if (typeof value === 'string') text = value
  else text = JSON.stringify(value)
  if (text === undefined) text = String(value) // JSON.stringify(undefined)
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) text = '(空)'
  return text.length > maxLen ? text.slice(0, maxLen) + ` …(共${text.length}字符)` : text
}

// getHistory 可能是几百条 entry, 只打摘要 + 末条预览.
function fmtHistory(hist) {
  if (!hist || typeof hist !== 'object') return fmt(hist)
  const entries = Array.isArray(hist.entries) ? hist.entries : []
  const last = entries[entries.length - 1]
  const lastPreview = last
    ? `末条[type=${last.type ?? '?'} ts=${last.timestamp ?? last.ts ?? '?'}] ${fmt(last, 160)}`
    : '(无条目)'
  return `entries=${entries.length} sentinel=${fmt(hist.sentinel, 80)} | ${lastPreview}`
}

function safe(fn, fallback = '(调用失败)') {
  try { return fn() } catch (e) { return `(调用失败: ${e?.message || e})` }
}

let round = 0
function tick() {
  round++
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
  console.log(`\n===== #${round} ${now} =====`)
  console.log(`isAlive        : ${fmt(safe(() => backend.isAlive(sessionId)))}`)
  console.log(`isWorking      : ${fmt(safe(() => backend.isWorking(sessionId)))}`)
  console.log(`getRecentError : ${fmt(safe(() => backend.getRecentError(sessionId)))}`)
  console.log(`getHistory     : ${fmt(safe(() => fmtHistory(backend.getHistory(sessionId))))}`)
  console.log(`getSessionTitle: ${fmt(safe(() => backend.getSessionTitle(sessionId)))}`)
  console.log(`realTimeInfo   : ${fmt(safe(() => backend.realTimeInfo(sessionId)))}`)
}

tick()
setInterval(tick, 3000)
EOF
