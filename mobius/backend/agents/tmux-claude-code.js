/**
 * tmux-claude-code.js — TmuxClaudeCodeBackend.
 *
 * 在专用 tmux server 的固定 session `imac_claude_code_agent_hub` 里, 每个
 * MOBIUS session_id → 一个 tmux window, window 名 = session_id. window 内跑 `proxychains -q -f
 * ~/proxy_claude.conf claude --dangerously-skip-permissions ...` (交互式 TUI 模式).
 *
 * 写入: tmux load-buffer + paste-buffer -p (bracketed) + send-keys Enter×3
 * 读取: ~/.claude/projects/<cwd-enc>/<uuid>.jsonl 文件 tail
 * 中断: tmux send-keys C-c × 3 (TUI 第 1 次会吞, 实测 3 次稳)
 * 终结: tmux kill-window
 *
 * 跨进程重启: runtime 持久化到 MOBIUS_DATA_PATH/hub-runtime.json. 后端 reload 时 tmux window 还活,
 * 我们重新加载 (sessionId → agentSessionId, jsonlPath) 映射, 不 kill 正在跑的 claude.
 *
 * 实现 AgentBackend 抽象的 5 个方法 + isAlive / isWorking / listSessions /
 * getHistory / isJobGoalAccomplished.
 *
 * 任务运行标记: 每次提交 prompt 时在 <cwd>/.imac/flags/<sessionId>/running.flag
 * 落一个文件, agent 收工 (无论成功/失败) 时自删 (提示见 session-context.js 注入的上下文).
 * isJobGoalAccomplished 据该文件是否还在判断任务是否结束.
 */
const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const { AgentBackend } = require('./base')
const {
  appendMobiusPromptEntry,
  readMergedJsonlHistory,
  watchMergedJsonl,
} = require('../services/mobius-jsonl')
const { recordPromptPaste } = require('../services/agent-prompt-events')
const {
  runningFlagPathOf,
  failedFlagPathOf,
  safeWriteRunningFlag,
  safeRemoveRunningFlag,
  safeRemoveFlagDir,
} = require('../utils/session-flags')
const { MOBIUS_DATA_PATH } = require('../config')
const { AGENT_TMUX_SOCKET, log, tmux } = require('./tmux-operation-log')
const { take_tmux_window_text } = require('./tmux_utils')

// ── 常量 ────────────────────────────────────────────────
const HUB = 'imac_claude_code_agent_hub'
const HOME = os.homedir()
const PROXY_ENVS = path.join(HOME, 'proxy_envs.bash')
const PROXY_CONF = path.join(HOME, 'proxy_claude.conf')
const RUNTIME_FILE = path.join(MOBIUS_DATA_PATH, 'hub-runtime.json')
// archive: 任何启动过的 session 都留一条 (sessionId → jsonlPath/agentSessionId/cwd...),
// terminate 时不删. 用来在 admin 关 window / cleaner 清理之后, getHistory 仍能找到 jsonl 文件读历史.
const ARCHIVE_FILE = path.join(MOBIUS_DATA_PATH, 'hub-archive.json')

// claude TUI 启动就绪轮询: 看底栏 "bypass permissions on" 出现 (splash 后常驻).
const READY_POLL_MS = 250
const READY_TIMEOUT_MS = 25000
const READY_SENTINEL = 'bypass permissions on'

// 首次进入一个新目录, claude 会弹「是否信任此文件夹」对话框 (--dangerously-skip-permissions
// 不跳过它). cwd 是平台为该用户/项目自建的工作区, 自动选默认项 "Yes, I trust this folder"
// 即可; claude 接受后自己落盘信任, 同目录后续不再弹.
const TRUST_PROMPT_SENTINELS = [
  'trust this folder',
  'Is this a project you created or one you trust',
  'Do you trust the files',
]
const TRUST_PRESS_INTERVAL_MS = 1500

// 首次启动的一次性引导对话框 (主题选择、欢迎屏幕等), 会阻塞 TUI ready: 自动按 Enter 确认.
const ONBOARDING_PROMPT_SENTINELS = [
  'Choose the text style',
  'Let\'s get started',
  'Welcome to Claude Code',
]
const ONBOARDING_PRESS_INTERVAL_MS = 1500

// "Detected a custom API key in your environment" 对话框: claude 检测到 ANTHROPIC_API_KEY 环境变量
// 并询问是否使用. 按 "1" 选择 Yes (使用该 key) 并关闭对话框.
const API_KEY_PROMPT_SENTINELS = [
  'Detected a custom API key in your environment',
  'Do you want to use this API key',
]
const API_KEY_PRESS_INTERVAL_MS = 1500

// "WARNING: Claude Code running in Bypass Permissions mode" 对话框: 新版 claude 在使用
// --dangerously-skip-permissions 时会显示一次性确认框. 默认选项是 "1. No, exit".
// 必须按 "2" + Enter 才能接受并进入正常 TUI.
const BYPASS_WARN_SENTINELS = [
  'WARNING: Claude Code running in Bypass Permissions mode',
  'Yes, I accept',
]
const BYPASS_WARN_INTERVAL_MS = 1500

// 主路径: 起 TUI 前直接在本服务用户的 ~/.claude.json 把 cwd 标记为已信任.
// claude 对每个项目路径用 projects[absPath].hasTrustDialogAccepted 持久化信任, 无
// 官方 CLI 可设 (`claude project` 只有 purge); --dangerously-skip-permissions 不跳过
// 信任框, -p/--bare 又与交互式 TUI 架构不兼容. 故只能预写这个权威 key.
// 幂等: 已 true 直接跳过, 仅为全新 cwd ADD key (该项目此刻还没 claude 进程, 不与其
// 竞争); 整文件 tmp+rename 原子落地; 任何失败都不阻断启动 —— 还有 ready 轮询里的
// 截屏自动确认作兜底 (双保险).
const CLAUDE_CONFIG = path.join(HOME, '.claude.json')

function ensureProjectTrusted(cwd) {
  try {
    const abs = path.resolve(cwd)
    if (!fs.existsSync(CLAUDE_CONFIG)) return false
    const j = JSON.parse(fs.readFileSync(CLAUDE_CONFIG, 'utf8'))
    if (!j.projects || typeof j.projects !== 'object') j.projects = {}
    const cur = j.projects[abs]
    if (cur && cur.hasTrustDialogAccepted === true) return true
    j.projects[abs] = { ...(cur || {}), hasTrustDialogAccepted: true }
    const tmp = `${CLAUDE_CONFIG}.imac-tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2))
    fs.renameSync(tmp, CLAUDE_CONFIG)
    log(`[tmux-claude-code] 预置目录信任: ${abs} → ~/.claude.json`)
    return true
  } catch (e) {
    console.warn(`[tmux-claude-code] 预置目录信任失败 (走截屏兜底): ${e.message}`)
    return false
  }
}

// paste 落地探测 + 兜底
const PASTE_PROBE_TIMEOUT_MS = 8000
const PASTE_PROBE_INTERVAL_MS = 200
const PASTE_SLEEP_BASE_MS = 800
const PASTE_SLEEP_MAX_MS = 5000
// 提交 Enter 间隔重发: bracketed-paste(-p) 后 TUI 切输入模式时偶发吞掉首个 Enter.
// 幂等重发 N 次 (paste 原子, 多按不会拆消息; 提交后空框 Enter 是 no-op).
const SUBMIT_ENTER_ATTEMPTS = 3
const SUBMIT_ENTER_INTERVAL_MS = 500
const INITIAL_CONTEXT_DELAY_MS = 5000
const INITIAL_CONTEXT_GREETING_CHOICES = ['hello', 'greeting', 'are you there', 'good day']

// ── 模块级 helpers (无状态) ─────────────────────────────
function hubExists() {
  return tmux(['has-session', '-t', HUB]).status === 0
}

function ensureHub() {
  if (hubExists()) return
  const r = tmux(['new-session', '-d', '-s', HUB, '-n', '_root'])
  if (r.status !== 0) throw new Error(`tmux new-session 失败: ${r.stderr}`)
  log(`[tmux-claude-code] created tmux session ${HUB}`)
}

function windowExists(name) {
  const r = tmux(['list-windows', '-t', HUB, '-F', '#{window_name}'])
  if (r.status !== 0) return false
  return r.stdout.split('\n').includes(name)
}

// list-windows 结果缓存 (仅状态查询用).
// /status / syncer 每 2~5s 轮询, 一次 /status 内 isAlive + isWorking(内部再 isAlive)
// + listSessions 会重复 list-windows 3 次 (全是 spawnSync, 阻塞 Node 单事件循环).
// 缓存 list-windows 解析结果 12s 内复用, 把单次 /status 的 spawnSync 降到 0~1 次,
// 消除"偶发某次 tmux 慢 → 事件循环被占 → 期间到达的请求全部排队"的雪崩.
// 控制流 (create/terminate/pause/recovery 里的 windowExists) 仍走实时查询, 不受 TTL 影响.
const LIST_WINDOWS_TTL_MS = 3 * 1000
let _listWindowsCache = null // { ts: number, rows: string[][] }

// isWorking 反向扫描 transcript 的尾部窗口. 必须远大于单条记录: claude-code 的
// 上下文注入 user 条目 (🚁🍕 项目+memory 注入) 与长篇 assistant 输出单行可达 30KB+,
// 旧的 16KB 窗口连一条都装不下 → 第一个 thinking 阶段唯一的 user 标记被挤出窗口,
// 窗口里只剩元数据 (attachment/mode/permission-mode/ai-title...) → 扫不到标记 →
// working 误判 false, 卡"待命"数分钟直到首条 assistant 落盘. 256KB 足以跨过巨型注入
// 条目看到最近的 user/assistant 标记, 读取代价可忽略 (纯文件读, 无 tmux 子进程).
const CLAUDE_WORKING_TAIL_BYTES = 256 * 1024

// realTimeInfo: 识别 claude TUI 当前的状态行. 核心锚 = 以 elapsed 开头的括号组 "(<elapsed> · ...)".
// elapsed 格式: Ns | Mm Ss | Hh Mm Ss. 覆盖两种形态:
//   ① "(6m 36s · ↓ 20.0k tokens · thinking more)"  — 带 token 流量
//   ② "(29s · thinking more)"                       — 仅 elapsed + 状态词 (思考早期未出 token)
// 命中即返回整行 (含 spinner + 任务描述 + 括号组). \( 后紧跟数字+时间单位, 排除 "(3 files changed)" 等输出.
const CLAUDE_STATUS_LINE_RE = /\(\d+(?:s|m\s+\d+s|h\s+\d+m\s+\d+s)[^()]*\)/u
// claude TUI API 连接失败后的自动重试状态. 该行没有常规状态行的 elapsed 括号组:
//   ✻ Unable to connect to API (ConnectionRefused) · Retrying in 25s · attempt 10/10
// 独立成与 CLAUDE_STATUS_LINE_RE 并列的特例, 以后若有误判可单独移除, 不影响原规则.
const CLAUDE_RETRYING_LINE_RE = /·\s*Retrying\s+in\s+\d+s\s*·/i

function findClaudeRealTimeInfo(paneText) {
  const lines = String(paneText || '').split('\n')
  // 从末尾往上找最近一条状态行 (TUI 同时只显示一条).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line && (CLAUDE_STATUS_LINE_RE.test(line) || CLAUDE_RETRYING_LINE_RE.test(line))) {
      return line.trim()
    }
  }
  return ''
}
// claude TUI "等待 background agents" 状态行. 主 agent 派出后台子 agent (Task 工具) 后,
// 本轮 JSONL 常以 end_turn 收尾 (Task 当 fire-and-forget), 但 TUI 实际显示
// "✻ Waiting for 3 background agents to finish". JSONL 反向扫描此时判 false → 误判"待命",
// 甚至被 inactive-tmux-cleaner 当闲置误杀. 这个 TUI 等待态 JSONL 表达不了, 故 isWorking 在
// JSONL 看似收工时再 capture-pane 兜底 (见 isWorking 末尾), 命中此行 (N≥1) → 仍在工作.
// 不锚 spinner 字符 (✻ 随帧变), 大小写不敏感, [1-9]\d* 排除 N=0 (结束态不再显示此行).
const CLAUDE_BG_AGENTS_WAITING_RE = /Waiting\s+for\s+[1-9]\d*\s+background\s+agents?\s+to\s+finish/i

// claude TUI "危险操作权限框". 即便 --dangerously-skip-permissions / 底栏 "bypass permissions on",
// claude 仍会对"作用在工作目录或其祖先上的危险操作"(典型: rm -rf <cwd 子树>) 弹一次性确认框:
//   Dangerous rm operation on working directory or its ancestor: /home/.../verify-overflow
//   Do you want to proceed?   1. Yes   ❯ 2. No   Esc to cancel · Tab to amend · ctrl+e to explain
// 此时 agent 卡在权限框等输入, TUI 不再推进 → session 表面"待命/卡死". realTimeInfo 检测到此框
// → 抽 danger_warning 整行 → fire-and-forget 自愈 (Esc 取消 → 等 5s → resume 提示 agent 跳过/
// 换温和命令), 不阻塞 /status 轮询. "Dangerous <kind> operation on working directory or its
// ancestor: <path>" 整行 (非贪婪到行尾, kind 可能是 rm/git/curl 等单字).
const CLAUDE_DANGER_OPERATION_RE = /Dangerous\s+\S[^\n]*?operation\s+on\s+working\s+directory\s+or\s+its\s+ancestor:[^\n]*/i
// 自愈节流: 单 session 同时只跑一个自愈; 同一 warning 文本冷却期内不重复触发 (防 Esc 没干净 +
// pane 5s 缓存残留导致 realTimeInfo 反复命中, 把 agent 轰成复读机).
const DANGER_HEAL_COOLDOWN_MS = 30 * 1000
const _dangerHealState = new Map() // sessionId → { healing: boolean, lastWarning: string, lastTs: number }

// capture-pane 尾部纯文本缓存 (5s TTL). isWorking 兜底 + realTimeInfo 共用同一份 spawn,
// 把 capture-pane 频次压到 ≤1/5s/session. 去掉 ANSI 转义; 失败/非命中返回 "".
const PANE_TAIL_TTL_MS = 5 * 1000
const _paneTailCache = new Map() // sessionId → { ts: number, text: string }
function capturePaneTail(sessionId) {
  const now = Date.now()
  const cached = _paneTailCache.get(sessionId)
  if (cached && now - cached.ts < PANE_TAIL_TTL_MS) return cached.text
  let text = ''
  try {
    const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-S', '-25'])
    if (pane.status === 0 && pane.stdout) {
      text = pane.stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    }
  } catch { /* best-effort: 失败即 "" */ }
  _paneTailCache.set(sessionId, { ts: now, text })
  return text
}

// /stop 强杀托底用: 抓 pane 最新文本 (绕过 5s 缓存, 反映 C-c 后真实状态), 判断 claude TUI
// 是否仍在跑 turn. 两个 busy 锚点: 状态行 "(... ↓ tokens ...)" + "Waiting for N background
// agents to finish". 任一命中 → C-c×3 未生效, 仍在工作; 都不命中 → 已回 idle 输入态, C-c 生效.
// 失败/空 → false (不 escalate, 避免误杀正常软停的 window).
function claudePaneStillBusy(sessionId) {
  let text = ''
  try {
    const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-S', '-25'])
    if (pane.status === 0 && pane.stdout) {
      text = pane.stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    }
  } catch { /* best-effort: 失败即不忙, 不 escalate */ }
  if (!text) return false
  return CLAUDE_STATUS_LINE_RE.test(text) || CLAUDE_BG_AGENTS_WAITING_RE.test(text)
}

// 检测 claude TUI 是否正卡在"危险操作权限框". 返回 { pending, warning }.
// warning = "Dangerous <kind> operation on working directory or its ancestor: <path>" 整行.
// 必须同时命中 danger 行 + "Do you want to proceed?" + "Esc to cancel" 三个特征才算"正卡在框上"
// (三者同屏出现是权限框的强信号, 避免历史日志/输出里残留的 danger 文本误判).
function detectDangerPermission(text) {
  if (!text) return { pending: false, warning: null }
  const m = text.match(CLAUDE_DANGER_OPERATION_RE)
  if (!m) return { pending: false, warning: null }
  if (!/Do you want to proceed\?/.test(text) || !/Esc to cancel/.test(text)) {
    return { pending: false, warning: null }
  }
  return { pending: true, warning: m[0].trim() }
}

function listWindowsRowsCached() {
  const now = Date.now()
  if (_listWindowsCache && now - _listWindowsCache.ts < LIST_WINDOWS_TTL_MS) {
    return _listWindowsCache.rows
  }
  const r = tmux(['list-windows', '-t', HUB, '-F', '#{window_name}|#{pane_pid}|#{window_index}|#{window_activity}|#{pane_dead}|#{pane_current_command}'])
  const rows = r.status === 0
    ? r.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('|'))
    : []
  _listWindowsCache = { ts: now, rows }
  return rows
}

// cwd → ~/.claude/projects/ 下子目录名. 所有非字母数字字符替换为 '-'.
// 例: /home/u/cc-workspace/foo_bar → -home-u-cc-workspace-foo-bar
function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function jsonlPathOf(cwd, claudeSessionId) {
  return path.join(HOME, '.claude', 'projects', encodeCwd(cwd), `${claudeSessionId}.jsonl`)
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

function normalizeUseProxy(value, fallback = true) {
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  return !!fallback
}

function proxyPrereqMissing() {
  const missing = []
  if (!fs.existsSync(PROXY_ENVS)) missing.push(`file: ${PROXY_ENVS}`)
  if (!fs.existsSync(PROXY_CONF)) missing.push(`file: ${PROXY_CONF}`)
  if (spawnSync('which', ['proxychains']).status !== 0) missing.push('bin (PATH): proxychains')
  return missing
}

function assertProxyAvailable() {
  const missing = proxyPrereqMissing()
  if (missing.length) throw new Error(`use_proxy=true 但代理依赖缺失: ${missing.join(', ')}`)
}

// 任务运行标记: <root>/.imac/flags/<sessionId>/running.flag
// root = flagRoot (项目仓库根 bind_path); 非 worktree 时 == cwd, worktree 时为
// 仓库根而非 cwd — 这样 agent 第一步清理/重建 worktree 目录不会误删 flag.
// 每次提交 prompt 后端都会刷新 running.flag, agent 收工 (成功/失败) 时自删
// (见 session-context 注入的提示). isJobGoalAccomplished 据"文件是否还在"判断任务是否结束.
function markRunning(root, sessionId) {
  return safeWriteRunningFlag(root, sessionId, {}, 'tmux-claude-code')
}

function clearRunning(root, sessionId) {
  return safeRemoveRunningFlag(root, sessionId, 'tmux-claude-code')
}

// 找 text 末尾的 ASCII 连续片段 (5~15 字符), 用作 paste 落地的 capture-pane marker.
// 中文/特殊字符在 tmux pane 里渲染未必逐字, 用 ASCII tail 更可靠.
function findAsciiTailMarker(text) {
  const ASCII = /[\x20-\x7E]/
  let i = text.length - 1
  while (i >= 0 && /\s/.test(text[i])) i--
  let tail = ''
  while (i >= 0 && tail.length < 15) {
    if (!ASCII.test(text[i])) break
    tail = text[i] + tail
    i--
  }
  return tail.length >= 5 ? tail : null
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function pickInitialContextPlan() {
  const roll = Math.random()
  if (roll < 1 / 3) return 'greeting_then_context'
  if (roll < 2 / 3) return 'direct_context'
  return 'delay_then_context'
}

function pickInitialContextGreeting() {
  const index = Math.floor(Math.random() * INITIAL_CONTEXT_GREETING_CHOICES.length)
  return INITIAL_CONTEXT_GREETING_CHOICES[index]
}

// ── 启动时 preflight (模块加载时一次性, 缺失硬失败) ────
;(function preflight() {
  const missing = []
  for (const bin of ['tmux', 'claude']) {
    if (spawnSync('which', [bin]).status !== 0) missing.push(`bin (PATH): ${bin}`)
  }
  if (missing.length) {
    console.error('[tmux-claude-code] ❌ preflight 失败, 拒绝启动:')
    for (const m of missing) console.error('   - ' + m)
    process.exit(1)
  }
  const proxyMissing = proxyPrereqMissing()
  if (proxyMissing.length) {
    console.warn(`[tmux-claude-code] ⚠️  proxychains 依赖不完整; use_proxy=false 的会话仍可直连启动: ${proxyMissing.join(', ')}`)
  }
  log(`[tmux-claude-code] ✅ preflight pass (SOCKET=${AGENT_TMUX_SOCKET}, HUB=${HUB})`)
})()

// ── Backend ────────────────────────────────────────────
class TmuxClaudeCodeBackend extends AgentBackend {
  constructor() {
    super({ name: 'tmux-claude-code', runtimeFile: RUNTIME_FILE, archiveFile: ARCHIVE_FILE })
    // runtime: sessionId → { agentSessionId, cwd, flagRoot, model, settingsPath, displayName, jsonlPath, startedAt, watch }
    this.runtime = new Map()
    this._restoreFromPersisted()
  }

  // 后端启动时从 hub-runtime.json 把 sessionId → agentSessionId/jsonlPath 映射拉回.
  // 进程 (claude TUI 在 tmux 里) 当然可能还活 — 我们不重启它. 起 jsonl watcher 接 tail.
  _restoreFromPersisted() {
    let total = 0
    for (const [sid, p] of Object.entries(this.persisted)) {
      total++
      if (!p?.jsonlPath || !fs.existsSync(p.jsonlPath)) {
        log(`[tmux-claude-code] runtime 条目 ${sid} 被丢弃 (jsonl 缺失: ${p?.jsonlPath})`)
        continue
      }
      this.runtime.set(sid, {
        agentSessionId: p.agentSessionId || null,
        cwd: p.cwd,
        flagRoot: p.flagRoot || p.cwd,
        model: p.model || null,
        useProxy: normalizeUseProxy(p.useProxy, true),
        settingsPath: p.settingsPath || null,
        forceNoProxy: !!p.forceNoProxy,
        displayName: p.displayName || null,
        jsonlPath: p.jsonlPath,
        startedAt: p.startedAt || 0,
        watch: null,
      })
      this._ensureWatcher(sid)
    }
    log(`[tmux-claude-code] runtime 加载 ${this.runtime.size}/${total} 条`)
  }

  // 每个 session 起一个 jsonl-watcher (后端唯一), 新行 → _emitRaw 给所有订阅者.
  // 已活则不重起. startOffset=current size 因为初始内容由 getHistory 提供 (sentinel).
  _ensureWatcher(sessionId) {
    const entry = this.runtime.get(sessionId)
    if (!entry?.jsonlPath || entry.watch) return
    entry.watch = watchMergedJsonl({
      path: entry.jsonlPath,
      startSentinel: null,
      onEntry: (raw) => this._emitRaw(sessionId, raw),
      onError: (e) => console.warn(`[tmux-claude-code/watch ${sessionId}] ${e.message}`),
    })
  }

  // ── 公开方法 (基类锁包装) ─────────────────────────────
  createNewSession(opts) {
    return this._withLock(opts?.sessionId, () => this._createImpl(opts))
  }
  pauseCurrentAndResumeFromSession(opts) {
    return this._withLock(opts?.sessionId, () => this._pauseImpl(opts))
  }
  noPauseCurrentAndQueueQueryAtSession(opts) {
    return this._withLock(opts?.sessionId, () => this._queueImpl(opts))
  }
  terminateSession(sessionId) {
    return this._withLock(sessionId, () => this._terminateImpl(sessionId))
  }

  // ── 状态查询 (不上锁, 跟写操作并发安全) ─────────────
  isAlive(sessionId) {
    // 状态查询走缓存 (12s TTL); 控制流 (create/terminate 等) 请用 windowExists (实时).
    return listWindowsRowsCached().some((cols) => cols[0] === sessionId)
  }

  isWorking(sessionId) {
    if (!this.isAlive(sessionId)) return false
    const entry = this.runtime.get(sessionId)
    if (!entry?.jsonlPath) return false
    let lines
    try {
      if (!fs.existsSync(entry.jsonlPath)) return false
      const stat = fs.statSync(entry.jsonlPath)
      if (stat.size === 0) return false
      const len = Math.min(stat.size, CLAUDE_WORKING_TAIL_BYTES)
      const buf = Buffer.alloc(len)
      const fd = fs.openSync(entry.jsonlPath, 'r')
      try { fs.readSync(fd, buf, 0, len, stat.size - len) } finally { fs.closeSync(fd) }
      lines = buf.toString('utf8').split('\n').filter(Boolean)
    } catch { return false }

    // 反向扫描: 白名单逻辑 — 只有 user / assistant / system+特定 subtype 决定状态,
    // 其他 type (attachment / last-prompt / custom-title / agent-name / permission-mode /
    // file-history-snapshot / queue-operation / 以及 TUI 或 gateway 未来新增的任何元数据)
    // 一律跳过. 这样新增元数据 type 不会再破坏判断.
    for (let i = lines.length - 1; i >= 0; i--) {
      let e
      try { e = JSON.parse(lines[i]) } catch { continue }
      if (e.type === 'assistant') {
        // stop_reason 缺失 / 'tool_use' → 还在跑; end_turn / max_tokens / stop_sequence → 收工
        const sr = e.message?.stop_reason
        return !sr || sr === 'tool_use'
      }
      if (e.type === 'user') return true
      if (e.type === 'system') {
        const sub = e.subtype
        if (sub === 'init' || sub === 'hook_started' || sub === 'hook_response') return true
        // turn_duration / stop_hook_summary / away_summary / 未来未知 subtype → 跳过
      }
      // 其他 type 全跳过
    }
    // JSONL 看似收工 (尾部最近的白名单记录是 end_turn 收尾的 assistant), 但 TUI 可能在
    // 等待 background agents —— 该等待态 JSONL 表达不了, 兜底看 pane 是否有
    // "Waiting for N background agents to finish". 命中则仍视为工作中, 避免误判待命 / 误回收.
    return CLAUDE_BG_AGENTS_WAITING_RE.test(capturePaneTail(sessionId))
  }

  // 任务是否结束: session 启动时落 running.flag, agent 收工 (成功/失败) 自删.
  // flag 不在 → 任务已结束 (accomplished=true). 未知 session → false (说不准).
  // 锚点用 flagRoot (仓库根); 老条目无 flagRoot 时回退 cwd.
  isJobGoalAccomplished(sessionId) {
    const entry = this.runtime.get(sessionId)
    const root = entry?.flagRoot || entry?.cwd
    if (!root) return false
    return !fs.existsSync(runningFlagPathOf(root, sessionId))
  }

  // 任务是否失败: failed.flag 在 → true. 未知 session (无 root) → false (说不准).
  // 与 isJobGoalAccomplished 同锚点 (flagRoot 仓库根; 老条目回退 cwd).
  isFailed(sessionId) {
    const entry = this.runtime.get(sessionId)
    const root = entry?.flagRoot || entry?.cwd
    if (!root) return false
    return fs.existsSync(failedFlagPathOf(root, sessionId))
  }

  listSessions() {
    return listWindowsRowsCached().map(cols => {
      const [name, pid, idx, activity, paneDead, paneCurrentCommand] = cols
      const entry = this.runtime.get(name)
      const lastActivitySec = Number(activity)
      const lastActivityMs = Number.isFinite(lastActivitySec) && lastActivitySec > 0
        ? lastActivitySec * 1000
        : null
      return {
        sessionId: name,
        agentSessionId: entry?.agentSessionId || null,
        pid: Number(pid),
        index: Number(idx),
        lastActivityMs,
        lastActivityAt: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
        tmuxOpen: true,
        paneDead: paneDead === '1',
        paneCurrentCommand: paneCurrentCommand || null,
      }
    })
  }

  // 实时状态行 (给 session 页 LIVE 卡片): 抓 tmux pane 倒数 15 行, 找 claude TUI 状态行.
  // 非 alive / 非 working → "". TTL 5s 缓存 (含空结果), 把 capture-pane 频次压到 ≤1/5s.
  // 锦上添花功能: 失败静默返回 "", 绝不抛错压垮 /status 轮询.
  realTimeInfo(sessionId) {
    // 复用 capturePaneTail 的 5s 缓存: 与 isWorking 兜底共用同一份 capture-pane spawn,
    // 不重复 spawn. isWorking 在"等待 background agents"等灰色地带已 capture 过, 这里直接命中缓存.
    try {
      if (this.isAlive(sessionId) && this.isWorking(sessionId)) {
        const paneText = capturePaneTail(sessionId)
        // 危险操作权限框: 即便开了 "bypass permissions on" claude 仍会对此类操作弹框, agent
        // 卡在框上等输入 → TUI 不推进 → session 卡死. tool_use pending 时 isWorking 判 true,
        // 正好覆盖此态. fire-and-forget 自愈 (Esc + 等 5s + resume), 不阻塞 /status 轮询.
        const danger = detectDangerPermission(paneText)
        if (danger.pending) this._maybeHealDangerPermission(sessionId, danger.warning)
        const info = findClaudeRealTimeInfo(paneText)
        if (info) return info
      }
    } catch { /* best-effort: 失败即 "" */ }
    return ''
  }

  // 危险权限框自愈节流: 单 session 同时只跑一个自愈 + 同一 warning 冷却期内不重复触发.
  // realTimeInfo 命中 detectDangerPermission 时调; fire-and-forget, 立即返回不阻塞 /status.
  _maybeHealDangerPermission(sessionId, warning) {
    const st = _dangerHealState.get(sessionId) || { healing: false, lastWarning: '', lastTs: 0 }
    const now = Date.now()
    if (st.healing) return  // 已在自愈中, 不重复
    if (warning === st.lastWarning && now - st.lastTs < DANGER_HEAL_COOLDOWN_MS) return  // 同框近期已处理
    _dangerHealState.set(sessionId, { healing: true, lastWarning: warning, lastTs: now })
    this._healDangerPermission(sessionId, warning)
      .catch((e) => log(`[tmux-claude-code] danger heal 失败 session=${sessionId}: ${e?.message || e}`))
      .finally(() => {
        const cur = _dangerHealState.get(sessionId)
        if (cur) _dangerHealState.set(sessionId, { ...cur, healing: false })
      })
  }

  // 危险权限框自愈主流程 (detached async, 不阻塞 realTimeInfo / /status):
  //   1) Esc 取消权限框 (claude 回 pending/输入态, 不执行那条危险命令; 对话框提示即 "Esc to cancel")
  //   2) 等 5s 让 TUI 消化, 对话框彻底消失
  //   3) pauseCurrentAndResumeFromSession 发 "$warning, please skip or try commands that are less aggressive."
  //      (内部 C-c×3 中断当前 turn 再 queue 新 prompt; 即便 Esc 后 agent 还在原 turn 也会被重置).
  async _healDangerPermission(sessionId, warning) {
    if (!windowExists(sessionId)) return
    tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Escape'])
    _paneTailCache.delete(sessionId)  // 失效缓存, 让后续判定看到取消后的真实屏幕
    log(`[tmux-claude-code] danger permission 检测到, 已 Esc 取消 (session=${sessionId}): ${warning}`)
    await new Promise((r) => setTimeout(r, 5000))
    if (!windowExists(sessionId)) return
    await this.pauseCurrentAndResumeFromSession({
      sessionId,
      prompt: `${warning}, please skip or try commands that are less aggressive.`,
      urgent: false,
    })
    log(`[tmux-claude-code] danger permission 已 resume 提示 agent 跳过/换温和命令 (session=${sessionId})`)
  }

  // sessionId → jsonl 文件路径的三级查表:
  //   runtime (Map, 进程内)        — 当前正活的 session
  //   persisted (hub-runtime.json) — live, terminate 时被清
  //   archive (hub-archive.json)   — 历史全集, terminate 不清; admin 关 window 后靠它找历史
  _resolveJsonlPath(sessionId) {
    return this.runtime.get(sessionId)?.jsonlPath
        || this._lookupPersistedJsonlPath(sessionId)
        || this._lookupArchivedJsonlPath(sessionId)
        || null
  }

  // 历史 + sentinel: 上层用 sentinel 串到 live 流, 不重复.
  getHistory(sessionId, opts = {}) {
    const jsonlPath = this._resolveJsonlPath(sessionId)
    if (!jsonlPath) {
      return { entries: [], total: 0, truncated: false, sentinel: 0 }
    }
    const r = readMergedJsonlHistory(jsonlPath, opts)
    return { entries: r.entries, total: r.total, totalApproximate: r.totalApproximate, truncated: r.truncated, sentinel: r.sentinel }
  }

  // 订阅 raw 流: opts.fromSentinel 指定字节 offset → 起独立 watcher 从那点 tail.
  // 不传 sentinel = 走基类的 EventEmitter (用后端共享 watcher emit 的 live 流).
  getAgentRawThoughtStream(sessionId, listener, opts = {}) {
    if (opts && opts.fromSentinel != null) {
      const jsonlPath = this._resolveJsonlPath(sessionId)
      if (!jsonlPath) {
        // 没 jsonl 路径 (session 没起过) → 退回基类 (live event-emitter)
        return super.getAgentRawThoughtStream(sessionId, listener, opts)
      }
      // 独立 watcher, 从 sentinel 开始 tail. 这样多个 stream 并发各自从各自 sentinel 拿,
      // 互不影响, 也不会跟后端共享 watcher (_ensureWatcher) 重复 emit.
      // 注意: 独立 watcher 会跟共享 watcher 同时 tail 同一文件 — 这是 OK 的, fs.watch
      // 多个 listener 互不干扰. 后端共享 watcher 喂 base.emitter, 这个独立 watcher 直
      // 接喂用户的 listener.
      const w = watchMergedJsonl({
        path: jsonlPath,
        startSentinel: opts.fromSentinel,
        onEntry: (raw) => listener(raw),
        onError: (e) => console.warn(`[tmux-claude-code/sub ${sessionId}] ${e.message}`),
      })
      return () => { try { w.stop() } catch {} }
    }
    return super.getAgentRawThoughtStream(sessionId, listener, opts)
  }

  _appendMobiusPromptEntry(sessionId, mobiusJsonl) {
    if (!mobiusJsonl) return false
    const entry = this.runtime.get(sessionId)
    if (!entry?.jsonlPath) {
      console.warn(`[tmux-claude-code] mobius jsonl skipped (${sessionId}): original jsonl path missing`)
      return false
    }
    try {
      appendMobiusPromptEntry({
        jsonlPath: entry.jsonlPath,
        sessionId,
        agentSessionId: entry.agentSessionId || null,
        cwd: entry.cwd || null,
        backendName: this.name,
        ...mobiusJsonl,
      })
      return true
    } catch (e) {
      console.warn(`[tmux-claude-code] mobius jsonl append failed (${sessionId}): ${e.message}`)
      return false
    }
  }

  // ── 内部实现 ──────────────────────────────────────────
  async _createImpl({ sessionId, cwd, flagRoot, model, useProxy, displayName, initialPrompt, agentSessionId, isInitialContextPrompt = false, settingsPath, forceNoProxy = false }) {
    if (!sessionId || !cwd) throw new Error('createNewSession 需要 sessionId + cwd')
    if (!initialPrompt) throw new Error('createNewSession 需要 initialPrompt')
    if (!fs.existsSync(cwd)) throw new Error(`cwd 不存在: ${cwd}`)

    // tmux 模式特点: window 可跨后端重启存活. 已有活窗口 → 复用 (跟原 hub.startSession
    // idempotent 一致). 这跟 stream-json 那版"严格新建"语义不同, 是有意为之.
    if (!windowExists(sessionId)) {
      await this._spawnWindow({ sessionId, cwd, flagRoot, model, useProxy, displayName, agentSessionId, settingsPath, forceNoProxy })
    } else {
      // 窗口在但 runtime entry 可能不在 (后端首次 reload) — 兜底建一个
      if (!this.runtime.has(sessionId) && agentSessionId) {
        const jp = jsonlPathOf(cwd, agentSessionId)
        const finalSettingsPath = settingsPath || null
        const finalForceNoProxy = !!forceNoProxy || !!finalSettingsPath
        const finalUseProxy = finalForceNoProxy ? false : normalizeUseProxy(useProxy, false)
        this.runtime.set(sessionId, {
          agentSessionId, cwd, flagRoot: flagRoot || cwd, model: model || null, useProxy: finalUseProxy,
          settingsPath: finalSettingsPath, forceNoProxy: finalForceNoProxy, displayName: displayName || null,
          jsonlPath: jp, startedAt: Date.now(), watch: null,
        })
        this._persistEntry(sessionId, {
          agentSessionId, cwd, flagRoot: flagRoot || cwd, model, useProxy: finalUseProxy,
          settingsPath: finalSettingsPath, forceNoProxy: finalForceNoProxy, displayName,
          jsonlPath: jp, startedAt: Date.now(),
        })
        this._ensureWatcher(sessionId)
      }
    }

    const entry = this.runtime.get(sessionId)
    await this._sendMaybeInitialContextPrompt(sessionId, initialPrompt, isInitialContextPrompt)
    markRunning(flagRoot || entry?.flagRoot || entry?.cwd || cwd, sessionId)
    return {
      sessionId,
      agentSessionId: entry?.agentSessionId || null,
      jsonlPath: entry?.jsonlPath || null,
      startedAt: entry?.startedAt || Date.now(),
    }
  }

  // 宽松版 — 没活进程就按 opts 自动 spawn (chat 不区分首发/续发, 统一走这里).
  async _queueImpl({ sessionId, prompt, cwd, flagRoot, model, useProxy, displayName, agentSessionId, isInitialContextPrompt = false, settingsPath, forceNoProxy = false, mobiusJsonl = null }) {
    if (!sessionId) throw new Error('需要 sessionId')
    if (!prompt) throw new Error('需要 prompt')

    if (!windowExists(sessionId)) {
      // 没活窗口 → 必须能 spawn. cwd 优先 opts, 否则 runtime persisted.
      const persisted = this.runtime.get(sessionId)
      const finalCwd = cwd || persisted?.cwd
      const finalAgentSid = agentSessionId || persisted?.agentSessionId
      const finalSettingsPath = settingsPath || persisted?.settingsPath || null
      const finalForceNoProxy = !!forceNoProxy || !!persisted?.forceNoProxy || !!finalSettingsPath
      const finalUseProxy = finalForceNoProxy ? false : normalizeUseProxy(useProxy, persisted?.useProxy ?? false)
      if (!finalCwd) throw new Error(`session ${sessionId} 没活 window 且无 cwd, 无法 spawn`)
      await this._spawnWindow({
        sessionId,
        cwd: finalCwd,
        flagRoot: flagRoot || persisted?.flagRoot || finalCwd,
        model: model || persisted?.model,
        useProxy: finalUseProxy,
        settingsPath: finalSettingsPath,
        forceNoProxy: finalForceNoProxy,
        displayName: displayName || persisted?.displayName,
        agentSessionId: finalAgentSid,
      })
    }
    this._appendMobiusPromptEntry(sessionId, mobiusJsonl)
    await this._sendMaybeInitialContextPrompt(sessionId, prompt, isInitialContextPrompt)
    const entry = this.runtime.get(sessionId)
    markRunning(flagRoot || entry?.flagRoot || entry?.cwd || cwd, sessionId)
  }

  async _pauseImpl({ sessionId, prompt, cwd, flagRoot, urgent = false, mobiusJsonl = null }) {
    if (!sessionId) throw new Error('需要 sessionId')
    const persisted = this.runtime.get(sessionId)

    if (windowExists(sessionId)) {
      if (urgent) {
        // 加急: 单次 C-c 中断当前 turn (实测单次足够). 用 await setTimeout 间隔,
        // 不能用 spawnSync('sleep') 那会阻塞 event loop, 冻住整个 node 进程.
        tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'C-c'])
        await new Promise(r => setTimeout(r, 250))
        // 中断后旧输入可能回到输入区, 先 Alt+Enter 换行隔开, 否则和新 prompt 粘一起
        tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'M-Enter'])
        await new Promise(r => setTimeout(r, 80))
      } else {
        // /stop: 3 个 C-c 中断当前 turn (不 kill window). 用户实测一次会被 TUI 吞.
        for (let i = 0; i < 3; i++) {
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'C-c'])
          if (i < 2) await new Promise(r => setTimeout(r, 50))
        }
        // 给 claude TUI 一点时间消化中断
        await new Promise(r => setTimeout(r, 300))
        // 兜底: C-c×3 偶发被 TUI 吞/卡在对话框, 实际没停下. 仅空 prompt 软停 (/stop) 场景
        // escalate 到 tmux kill-window 强杀托底, 保证 /stop 一定能让后台 agent 停下来
        // (window 死了下次发消息 _queueImpl 会 respawn, 不影响会话续接); urgent+新 prompt
        // 路径要保留 window 接新输入, 不走强杀. 双重确认 (capture busy → 再等 700ms 让 TUI
        // 消化 → 仍 busy) 避免状态行短暂残留导致误杀正常软停的 window.
        if (!prompt) {
          _paneTailCache.delete(sessionId)
          if (claudePaneStillBusy(sessionId)) {
            await new Promise(r => setTimeout(r, 700))
            _paneTailCache.delete(sessionId)
            if (windowExists(sessionId) && claudePaneStillBusy(sessionId)) {
              tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
              log(`[tmux-claude-code] /stop fallback: C-c×3 未停止, kill-window=${sessionId}`)
            }
          }
        }
      }
    }

    if (!prompt) {
      clearRunning(flagRoot || persisted?.flagRoot || persisted?.cwd || cwd, sessionId)
      return  // 空 prompt = 只中断, 不再发
    }

    // 走 queue 路径 (含 respawn-if-dead 逻辑)
    await this._queueImpl({
      sessionId,
      prompt,
      cwd: persisted?.cwd,
      flagRoot: persisted?.flagRoot,
      model: persisted?.model,
      useProxy: persisted?.useProxy,
      displayName: persisted?.displayName,
      agentSessionId: persisted?.agentSessionId,
      isInitialContextPrompt: false,
      mobiusJsonl,
    })
  }

  // 返回 { sessionId, killed, wasWorking } — 调用方 (删除路由) 据此"抛出提醒":
  // killed=true 表示确实有活的后台 claude code 被杀掉; wasWorking=true 表示它当时
  // 还在 turn 中 (强行中断了正在跑的任务).
  async _terminateImpl(sessionId) {
    const wasAlive = windowExists(sessionId)
    // isWorking 内部会再判 isAlive; 趁 window 还在先采样.
    const wasWorking = wasAlive && this.isWorking(sessionId)
    const entry = this.runtime.get(sessionId)
    if (entry?.watch) { try { entry.watch.stop() } catch {} }
    this.runtime.delete(sessionId)
    this._forgetPersisted(sessionId)
    if (wasAlive) {
      tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
      log(`[tmux-claude-code] terminate: killed window=${sessionId} (wasWorking=${wasWorking})`)
    }
    // 顺手清掉 running flag 目录 (agent 没自删的话别留垃圾)
    const flagRoot = entry?.flagRoot || entry?.cwd
    if (flagRoot) {
      safeRemoveFlagDir(flagRoot, sessionId, 'tmux-claude-code')
    }
    return { sessionId, killed: wasAlive, wasWorking }
  }

  // ── tmux 操作底层 ─────────────────────────────────────
  // 启动一个新的 Claude Code tmux 窗口，并把运行态登记到内存和持久化存储。
  async _spawnWindow({ sessionId, cwd, flagRoot, model, useProxy, displayName, agentSessionId, settingsPath, forceNoProxy = false }) {
    // 确保承载 agent 窗口的 tmux hub session 已经存在。
    ensureHub()
    // 运行标记默认写在 cwd 下；调用方传 flagRoot 时优先使用仓库根等稳定路径。
    const effFlagRoot = flagRoot || cwd
    // 新启动用调用方传入的 session 实际值；没有历史 runtime 时默认不走代理。
    // settingsPath 传入时转成绝对路径，避免后续 bash 命令受当前目录影响。
    const finalSettingsPath = settingsPath ? path.resolve(settingsPath) : null
    // 如果指定了 settings 文件，就在启动前确认文件真实存在。
    if (finalSettingsPath && !fs.existsSync(finalSettingsPath)) {
      // settings 文件缺失时直接失败，避免 Claude 用默认配置悄悄启动。
      throw new Error(`Claude Code settings 文件不存在: ${finalSettingsPath}`)
    }
    // 指定 settings 时强制不走代理；显式 forceNoProxy 也会关闭代理。
    const finalForceNoProxy = !!forceNoProxy || !!finalSettingsPath
    // 只有未强制关闭代理时才按调用参数归一化代理开关。
    const finalUseProxy = finalForceNoProxy ? false : normalizeUseProxy(useProxy, false)
    // 需要代理时先检查 proxychains 相关文件和命令是否可用。
    if (finalUseProxy) assertProxyAvailable()

    // resume 保护: 老 session 的 jsonl 可能不在我们的路径下 (旧 SDK 链路来源).
    // agentSessionId 存在表示希望恢复旧 Claude 会话。
    let useResume = !!agentSessionId
    // 恢复前确认目标 jsonl 在当前 cwd 下可见。
    if (useResume && !fs.existsSync(jsonlPathOf(cwd, agentSessionId))) {
      // 找不到 jsonl 时打印警告，并退化为新建会话。
      console.warn(`[tmux-claude-code] resume target jsonl 不存在 (${agentSessionId}), fallback 为新 session`)
      // 关闭 resume 路径，后面会生成新的 Claude session id。
      useResume = false
    }
    // resume 使用旧 agentSessionId，新会话生成一个新的 UUID。
    const claudeSessionId = useResume ? agentSessionId : crypto.randomUUID()

    // 组装传给 claude CLI 的参数列表。
    const claudeArgs = [
      // 跳过权限确认，让后台 agent 可以自动执行。
      `--dangerously-skip-permissions`,
      // 绝对禁止 agent 停下来问人: 在 harness 层 deny 掉 AskUserQuestion 工具.
      // 同时禁掉 ExitPlanMode, 避免 agent 卡在 plan 模式里等待用户批准.
      `--disallowedTools AskUserQuestion,ExitPlanMode`,
      // resume 用 --resume，新会话用 --session-id 绑定固定会话 id。
      useResume ? `--resume ${claudeSessionId}` : `--session-id ${claudeSessionId}`,
    ]
    // 如果调用方指定模型，就追加 --model 参数并做 shell 转义。
    if (model) claudeArgs.push(`--model ${shellQuote(model)}`)
    // settings 参数优先使用调用方指定文件，否则使用默认 Mobius Claude settings。
    const settingsArg = finalSettingsPath
      ? `--settings ${shellQuote(finalSettingsPath)}`
      : `--settings "$HOME/.claude/mobiusdefault.settings.json"`

    // bash -lc 链: 按 Session 配置决定是否用 proxychains, 但都清理 IDE IPC 环境。
    // 构造 bash -lc 要执行的命令片段；数组里的 null 会在后面过滤掉。
    const cmd = [
      // 走代理时先加载代理环境变量。
      finalUseProxy ? `source "$HOME/proxy_envs.bash"` : null,
      // 清掉 VS Code 相关 IPC 环境，避免 CLI 误连到宿主 IDE。
      `unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN`,
      // 标记当前进程运行在受控沙箱环境中。
      `export IS_SANDBOX=1`,
      // 根据代理开关选择 proxychains 包裹 claude，或直接 exec claude。
      // settingsArg 两分支都要带: 代理分支此前漏拼 --settings, 导致开代理的 session
      // settings 文件 (channel/key/权限/withproxy.json) 被静默丢弃回退全局默认。
      finalUseProxy
        ? `exec proxychains -q -f "$HOME/proxy_claude.conf" claude ${settingsArg} ${claudeArgs.join(' ')}`
        : `exec claude ${settingsArg} ${claudeArgs.join(' ')}`,
      // 删除空片段，并用 && 保证前一步失败时不继续执行。
    ].filter(Boolean).join(' && ')

    // 主路径: 预置信任, 让 TUI 根本不弹「是否信任此文件夹」(失败有截屏兜底).
    // 提前写入项目可信状态，减少 TUI 启动时的交互弹窗。
    ensureProjectTrusted(cwd)

    // 在 hub session 下创建后台 tmux window，并在 cwd 中执行 bash -lc cmd。
    const r = tmux(['new-window', '-d', '-t', HUB, '-n', sessionId, '-c', cwd, 'bash', '-lc', cmd])
    // tmux 创建失败时把 stderr 带出，方便定位命令层问题。
    if (r.status !== 0) throw new Error(`tmux new-window 失败: ${r.stderr}`)
    // 记录窗口、目录、Claude 会话、代理和 settings 信息。
    log(`[tmux-claude-code] started: window=${sessionId} cwd=${cwd} claude_session=${claudeSessionId} use_proxy=${finalUseProxy ? 1 : 0}${finalSettingsPath ? ` settings=${finalSettingsPath}` : ''}`)

    // 等 TUI ready (底栏 "bypass permissions on" 出现)
    // 设置等待 TUI ready 的截止时间。
    const deadline = Date.now() + READY_TIMEOUT_MS
    // ready 标记会在探测到哨兵文本时置为 true。
    let ready = false
    // 记录上次自动按信任确认的时间，用来限频。
    let lastTrustPress = 0
    // 记录上次自动按引导对话框确认的时间，用来限频。
    let lastOnboardingPress = 0
    // 记录上次自动按 API Key 对话框确认的时间，用来限频。
    let lastApiKeyPress = 0
    // 记录上次自动按 Bypass 警告确认的时间，用来限频。
    let lastBypassPress = 0
    const target = `${HUB}:${sessionId}`
    // 在超时前持续轮询 tmux pane 内容。
    while (Date.now() < deadline) {
      // capture 失败时按空屏幕处理，下一轮继续尝试。
      const { text: screen } = take_tmux_window_text(target, 100)
      // 看到 ready 哨兵文本就结束等待。
      if (screen.includes(READY_SENTINEL)) { ready = true; break }
      // 信任对话框: 默认已高亮 "❯ 1. Yes, I trust this folder", 回车即确认.
      // 限频重发兜底 send-keys Enter 偶发被 TUI 吞的情况, 直到对话框消失.
      // 如果屏幕上出现信任提示，就进入自动确认逻辑。
      if (TRUST_PROMPT_SENTINELS.some(s => screen.includes(s))) {
        // 读取当前时间，用于判断是否到达下一次按键间隔。
        const now = Date.now()
        // 防止过于频繁地向 TUI 发送 Enter。
        if (now - lastTrustPress > TRUST_PRESS_INTERVAL_MS) {
          // 向当前 tmux window 发送 Enter，确认信任目录。
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
          // 更新上次发送 Enter 的时间。
          lastTrustPress = now
          // 写日志说明已自动处理信任弹窗。
          log(`[tmux-claude-code] window=${sessionId} 检测到目录信任对话框, 已自动确认信任 (cwd=${cwd})`)
        }
      }
      // 首次启动引导对话框 (主题选择、欢迎屏幕): 自动按 Enter 确认.
      if (ONBOARDING_PROMPT_SENTINELS.some(s => screen.includes(s))) {
        const now = Date.now()
        if (now - lastOnboardingPress > ONBOARDING_PRESS_INTERVAL_MS) {
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
          lastOnboardingPress = now
          log(`[tmux-claude-code] window=${sessionId} 检测到首次启动引导对话框, 已自动确认`)
        }
      }
      // "Detected a custom API key" 对话框: 按 "1" 确认使用环境变量中的 Key.
      if (API_KEY_PROMPT_SENTINELS.some(s => screen.includes(s))) {
        const now = Date.now()
        if (now - lastApiKeyPress > API_KEY_PRESS_INTERVAL_MS) {
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, '1'])
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
          lastApiKeyPress = now
          log(`[tmux-claude-code] window=${sessionId} 检测到 API Key 对话框, 已自动选择使用环境变量 Key`)
        }
      }
      // "Bypass Permissions mode" 警告: 按 "2" + Enter 接受 (选项 1 = No/退出, 选项 2 = Yes/接受).
      if (BYPASS_WARN_SENTINELS.some(s => screen.includes(s))) {
        const now = Date.now()
        if (now - lastBypassPress > BYPASS_WARN_INTERVAL_MS) {
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, '2'])
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
          lastBypassPress = now
          log(`[tmux-claude-code] window=${sessionId} 检测到 Bypass Permissions 警告, 已自动确认接受`)
        }
      }
      // 等待一个轮询间隔后继续检查屏幕内容。
      await new Promise(r => setTimeout(r, READY_POLL_MS))
    }
    // 超时仍未 ready 时清理刚创建的 window 并抛错。
    if (!ready) {
      // 避免留下不可用的后台窗口。
      tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
      // 把超时信息和 cwd 带给调用方。
      throw new Error(`claude TUI 未在 ${READY_TIMEOUT_MS}ms 内 ready (cwd=${cwd}).`)
    }
    // 记录 TUI 已可用。
    log(`[tmux-claude-code] window=${sessionId} TUI ready`)

    // 计算该 Claude session 对应的 jsonl 文件路径。
    const jp = jsonlPathOf(cwd, claudeSessionId)
    // 把当前 window 的运行态写入内存 runtime。
    this.runtime.set(sessionId, {
      // Claude 内部会话 id。
      agentSessionId: claudeSessionId,
      // 工作目录、运行标记根目录、模型和代理设置。
      cwd, flagRoot: effFlagRoot, model: model || null, useProxy: finalUseProxy,
      // settings、强制不走代理、展示名等启动参数。
      settingsPath: finalSettingsPath, forceNoProxy: finalForceNoProxy, displayName: displayName || null,
      // jsonl 路径、启动时间和 watcher 占位。
      jsonlPath: jp, startedAt: Date.now(), watch: null,
    })
    // 把同一份核心状态持久化，便于服务重启后恢复。
    this._persistEntry(sessionId, {
      // 持久化 Claude 内部会话 id、工作目录和运行标记根目录。
      agentSessionId: claudeSessionId, cwd, flagRoot: effFlagRoot,
      // 持久化模型、代理、settings 和展示名。
      model: model || null, useProxy: finalUseProxy,
      settingsPath: finalSettingsPath, forceNoProxy: finalForceNoProxy, displayName: displayName || null,
      // 持久化 jsonl 路径和启动时间。
      jsonlPath: jp, startedAt: Date.now(),
    })
    // 启动 jsonl watcher，把 agent 输出持续接入系统。
    this._ensureWatcher(sessionId)

    // window 启动 → 先落运行标记; 每次提交 prompt 后还会刷新一次.
    // agent 收工时按 session-context 提示自删.
    // flagRoot 锚在仓库根 (worktree 时 ≠ cwd), agent 重建 worktree 不会误删.
    // 写入 running flag，让外部逻辑知道该 session 正在运行。
    markRunning(effFlagRoot, sessionId)
  }

  // tmux load-buffer + paste-buffer -p + marker 落地探测 + 间隔重发 Enter×3.
  // 必须用 -p (bracketed paste): 否则文本内 \n 被 TUI 当回车, 多行消息会在首个换行处
  // 提前提交, 余下内容连同末尾那个显式 Enter 变成第二条 (多行被拆成两条消息的根因).
  // -p 历史上被移除是因为它之后那个显式 Enter 偶发被 TUI 吞掉 -> 改用确认式重发解决.
  async _sendMaybeInitialContextPrompt(sessionId, text, isInitialContextPrompt) {
    if (!isInitialContextPrompt) {
      await this._sendPromptToWindow(sessionId, text)
      return
    }

    const plan = pickInitialContextPlan()
    if (plan === 'greeting_then_context') {
      const greeting = pickInitialContextGreeting()
      log(`[tmux-claude-code] initial context plan=${plan} greeting=${JSON.stringify(greeting)} delay_ms=${INITIAL_CONTEXT_DELAY_MS}`)
      await this._sendPromptToWindow(sessionId, greeting)
      await sleep(INITIAL_CONTEXT_DELAY_MS)
      await this._sendPromptToWindow(sessionId, text)
      return
    }

    if (plan === 'delay_then_context') {
      log(`[tmux-claude-code] initial context plan=${plan} delay_ms=${INITIAL_CONTEXT_DELAY_MS}`)
      await sleep(INITIAL_CONTEXT_DELAY_MS)
      await this._sendPromptToWindow(sessionId, text)
      return
    }

    log(`[tmux-claude-code] initial context plan=${plan}`)
    await this._sendPromptToWindow(sessionId, text)
  }

  async _sendPromptToWindow(sessionId, text) {
    if (!windowExists(sessionId)) {
      throw new Error(`window ${sessionId} 不存在`)
    }

    const marker = findAsciiTailMarker(text)
    log(`[tmux-claude-code] sendPrompt window=${sessionId} len=${text.length} marker=${marker ? JSON.stringify(marker) : '(none)'}`)

    const bufName = `imac_${process.pid}_${Date.now()}`
    const r1 = tmux(['load-buffer', '-b', bufName, '-'], { input: text })
    if (r1.status !== 0) throw new Error(`tmux load-buffer 失败: ${r1.stderr}`)

    const r2 = tmux(['paste-buffer', '-p', '-d', '-b', bufName, '-t', `${HUB}:${sessionId}`])
    if (r2.status !== 0) {
      tmux(['delete-buffer', '-b', bufName])
      throw new Error(`tmux paste-buffer 失败: ${r2.stderr}`)
    }

    if (marker) {
      // 探测 marker 出现 (= paste 真进了 TUI 输入框)
      const deadline = Date.now() + PASTE_PROBE_TIMEOUT_MS
      let saw = false
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, PASTE_PROBE_INTERVAL_MS))
        const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-S', '-80'])
        if (pane.status === 0 && pane.stdout.includes(marker)) { saw = true; break }
      }
      if (!saw) console.warn(`[tmux-claude-code] paste marker 未出现 (${PASTE_PROBE_TIMEOUT_MS}ms 内), Enter 仍发送`)
    } else {
      // 找不到 ASCII marker → 退回 sleep, 时间随 text 长度线性放大
      const sleepMs = Math.min(PASTE_SLEEP_MAX_MS, Math.max(PASTE_SLEEP_BASE_MS, Math.floor(text.length * 0.5)))
      await new Promise(r => setTimeout(r, sleepMs))
    }

    // 提交: bracketed-paste(-p) 是原子事件, 末尾多按几次 Enter 不会拆分消息;
    // 而 TUI 切输入模式时偶发吞掉首个 Enter, 故按既有 "C-c×3 / 信任框重按" 同款
    // 幂等思路, 间隔重发 N 次. 已提交后输入框为空, 多余 Enter 在 claude TUI 是 no-op.
    for (let i = 0; i < SUBMIT_ENTER_ATTEMPTS; i++) {
      const r = tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
      if (r.status !== 0) throw new Error(`tmux send-keys Enter 失败: ${r.stderr}`)
      if (i < SUBMIT_ENTER_ATTEMPTS - 1) await new Promise(r => setTimeout(r, SUBMIT_ENTER_INTERVAL_MS))
    }

    recordPromptPaste({ backendName: this.name, sessionId, contentLength: text.length })
  }
}

module.exports = {
  TmuxClaudeCodeBackend,
  HUB,
  encodeCwd,
  jsonlPathOf,
  runningFlagPathOf,
  failedFlagPathOf,
  findClaudeRealTimeInfo,
}
