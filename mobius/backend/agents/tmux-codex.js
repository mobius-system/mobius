/**
 * tmux-codex.js — TmuxCodexBackend.
 *
 * 每个 IMAC session_id 对应一个 tmux window, window 内运行 Codex 交互式 TUI.
 * 对外实现与 tmux-claude-code 相同的 AgentBackend 合同:
 *   - 输入: tmux load-buffer + paste-buffer -p + Enter
 *   - 读取: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-...<thread-id>.jsonl tail
 *   - 中断: tmux send-keys C-c x 3
 *   - 终结: tmux kill-window
 *   - 任务完成判断: 与 Claude backend 共用 .imac/flags/<sessionId> 标记约定
 */
const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

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
const { log, tmux } = require('./tmux-operation-log')
const { take_tmux_window_text } = require('./tmux_utils')

let Database = null
try { Database = require('better-sqlite3') } catch {}

const HUB = 'imac_codex_agent_hub'
const HOME = os.homedir()
const PROXY_ENVS = path.join(HOME, 'proxy_envs.bash')
const PROXY_CONF = path.join(HOME, 'proxy_claude.conf')
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex')
const CODEX_CONFIG = path.join(CODEX_HOME, 'config.toml')
const CODEX_STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite')
// 每个渠道 TOML 声明 env_key, 启动 tmux 时由本后端 export 对应环境变量.
const RUNTIME_FILE = path.join(MOBIUS_DATA_PATH, 'codex-hub-runtime.json')
// archive: 任何启动过的 session 都留一条 (sessionId → jsonlPath/agentSessionId/cwd...),
// terminate 时不删. 用来在 admin 关 window / cleaner 清理之后, getHistory 仍能找到 jsonl 文件读历史.
const ARCHIVE_FILE = path.join(MOBIUS_DATA_PATH, 'codex-hub-archive.json')
// Legacy fallback: 旧 codex-hub-runtime.json 里 model 字段为空时 (理论不应发生, 新数据都从
// 注册表来). 留作防御性兜底, 业务流都通过 model-registry.launchOptionsForSession 传 codexModel.
const DEFAULT_MODEL = 'gpt-5.5'
const CODEX_CHANNEL_RE = /^[A-Za-z]+$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
// Codex TUI 错误扫描只看尾部 N 行: 状态接口会反复触发 getRecentError, 全量抓 scrollback 太重.
const CODEX_ERROR_SCAN_TAIL_LINES = 50

const READY_POLL_MS = 250
const READY_TIMEOUT_MS = 25000
const READY_SENTINELS = [
  'OpenAI Codex',
  'permissions: YOLO mode',
  '/model to change',
]
const TRUST_PROMPT_SENTINELS = [
  'Do you trust the contents of this directory',
  'Trusting the directory allows',
]
const TRUST_PRESS_INTERVAL_MS = 1500
const UPDATE_PROMPT_SENTINELS = [
  'Update available!',
  'Skip until next version',
]
const UPDATE_PRESS_INTERVAL_MS = 1500

const PASTE_PROBE_TIMEOUT_MS = 8000
const PASTE_PROBE_INTERVAL_MS = 200
const PASTE_SLEEP_BASE_MS = 800
const PASTE_SLEEP_MAX_MS = 5000
const SUBMIT_ENTER_ATTEMPTS = 3
const SUBMIT_ENTER_INTERVAL_MS = 500
const THREAD_BIND_TIMEOUT_MS = 30000
const THREAD_BIND_POLL_MS = 300
const THREAD_BIND_UPDATED_SKEW_MS = 1000

function hubExists() {
  return tmux(['has-session', '-t', HUB]).status === 0
}

function ensureHub() {
  if (hubExists()) return
  const r = tmux(['new-session', '-d', '-s', HUB, '-n', '_root'])
  if (r.status !== 0) throw new Error(`tmux new-session failed: ${r.stderr}`)
  log(`[tmux-codex] created tmux session ${HUB}`)
}

function windowExists(name) {
  const r = tmux(['list-windows', '-t', HUB, '-F', '#{window_name}'])
  if (r.status !== 0) return false
  return r.stdout.split('\n').includes(name)
}

// list-windows 结果缓存 (仅状态查询用).
// /status / syncer 每 2~5s 轮询, 一次 /status 内 isAlive + isWorking(内部再 isAlive)
// + listSessions + getRecentError 的 isAlive 会重复 list-windows 多达 5 次 (全是 spawnSync,
// 阻塞 Node 单事件循环). 缓存解析结果 12s 内复用, 把单次 /status 的 spawnSync 降到 0~1 次,
// 消除"偶发某次 tmux 慢 → 事件循环被占 → 期间请求全部排队"的雪崩.
// 控制流 (create/terminate/pause/recovery 里的 windowExists) 仍走实时查询, 不受 TTL 影响.
const LIST_WINDOWS_TTL_MS = 12 * 1000
let _listWindowsCache = null // { ts: number, rows: string[][] }

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

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

function normalizeCodexChannel(value) {
  const channel = String(value || '').trim()
  if (!channel) throw new Error('tmux-codex requires codex channel (--profile)')
  if (!CODEX_CHANNEL_RE.test(channel)) {
    throw new Error(`invalid codex channel '${channel}': channel must contain letters only`)
  }
  return channel
}

function normalizeSecretEnvKey(value) {
  const key = String(value || '').trim()
  if (!key) throw new Error('tmux-codex requires codex secret env key')
  if (!ENV_KEY_RE.test(key)) throw new Error(`invalid codex secret env key '${key}'`)
  return key
}

function resolveSecretValue(secretEnvKey, secretValue) {
  const explicit = secretValue == null ? '' : String(secretValue)
  const value = explicit || process.env[secretEnvKey] || ''
  if (!value) throw new Error(`missing value for codex secret env key ${secretEnvKey}`)
  return value
}

function tomlStringValue(tomlText, key) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = String(tomlText || '').match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*=\\s*(['"])([^'"]+)\\1`))
  return match ? match[2].trim() : ''
}

function normalizeUseProxy(value, fallback = false) {
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
  if (missing.length) throw new Error(`use_proxy=true but proxy prerequisites are missing: ${missing.join(', ')}`)
}

function tomlBasicString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function codexProjectHeader(cwd) {
  return `[projects.${tomlBasicString(path.resolve(cwd))}]`
}

function ensureProjectTrusted(cwd) {
  try {
    fs.mkdirSync(CODEX_HOME, { recursive: true })
    const header = codexProjectHeader(cwd)
    let text = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf8') : ''
    const lines = text.split(/\r?\n/)
    let start = lines.findIndex((line) => line.trim() === header)
    if (start < 0) {
      if (text && !text.endsWith('\n')) text += '\n'
      fs.writeFileSync(CODEX_CONFIG, `${text}\n${header}\ntrust_level = "trusted"\n`)
      log(`[tmux-codex] trusted project in ${CODEX_CONFIG}: ${path.resolve(cwd)}`)
      return true
    }

    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[.*\]\s*$/.test(lines[i])) { end = i; break }
    }
    const trustIdx = lines.slice(start + 1, end).findIndex((line) => /^\s*trust_level\s*=/.test(line))
    if (trustIdx >= 0) {
      const idx = start + 1 + trustIdx
      if (/^\s*trust_level\s*=\s*"trusted"\s*$/.test(lines[idx])) return true
      lines[idx] = 'trust_level = "trusted"'
    } else {
      lines.splice(start + 1, 0, 'trust_level = "trusted"')
    }
    const tmp = `${CODEX_CONFIG}.imac-tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, lines.join('\n'))
    fs.renameSync(tmp, CODEX_CONFIG)
    log(`[tmux-codex] trusted project in ${CODEX_CONFIG}: ${path.resolve(cwd)}`)
    return true
  } catch (e) {
    console.warn(`[tmux-codex] failed to pre-trust project; screen fallback will handle it: ${e.message}`)
    return false
  }
}

function summarizeScreen(screen) {
  return String(screen || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-16)
    .join('\n')
    .slice(0, 2000)
}

function markRunning(root, sessionId) {
  return safeWriteRunningFlag(root, sessionId, { backend: 'tmux-codex' }, 'tmux-codex')
}

function clearRunning(root, sessionId) {
  return safeRemoveRunningFlag(root, sessionId, 'tmux-codex')
}

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

// ── 启动时 preflight (模块加载时一次性, 缺失降级为警告) ────
;(function preflight() {
  const missing = []
  for (const bin of ['tmux', 'codex']) {
    if (spawnSync('which', [bin]).status !== 0) missing.push(`bin (PATH): ${bin}`)
  }
  if (!Database) missing.push('node module: better-sqlite3')
  if (missing.length) {
    console.warn('[tmux-codex] ⚠️  preflight 依赖不完整, codex 会话不可用 (不影响 claude-code):')
    for (const m of missing) console.warn('   - ' + m)
    return
  }
  const proxyMissing = proxyPrereqMissing()
  if (proxyMissing.length) {
    console.warn(`[tmux-codex] ⚠️  proxychains 依赖不完整; use_proxy=false 的会话仍可直连启动: ${proxyMissing.join(', ')}`)
  }
  log(`[tmux-codex] ✅ preflight pass (HUB=${HUB}, CODEX_HOME=${CODEX_HOME})`)
})()

function openStateDb() {
  if (!Database || !fs.existsSync(CODEX_STATE_DB)) return null
  try { return new Database(CODEX_STATE_DB, { readonly: true, fileMustExist: true }) }
  catch (e) {
    console.warn(`[tmux-codex] failed to open state db: ${e.message}`)
    return null
  }
}

function snapshotThreadIds(cwd) {
  const db = openStateDb()
  if (!db) return new Set()
  try {
    const rows = db.prepare('SELECT id FROM threads WHERE cwd = ?').all(path.resolve(cwd))
    return new Set(rows.map((r) => r.id))
  } catch {
    return new Set()
  } finally {
    try { db.close() } catch {}
  }
}

function codexThreadById(threadId) {
  if (!threadId) return null
  const db = openStateDb()
  if (!db) return null
  try {
    return db.prepare(`
      SELECT id, rollout_path, cwd, model,
             COALESCE(created_at_ms, created_at * 1000) AS created_ms,
             COALESCE(updated_at_ms, updated_at * 1000) AS updated_ms
      FROM threads
      WHERE id = ?
    `).get(threadId) || null
  } catch (e) {
    console.warn(`[tmux-codex] failed to read thread ${threadId}: ${e.message}`)
    return null
  } finally {
    try { db.close() } catch {}
  }
}

function findRolloutPathByThreadId(threadId) {
  const row = codexThreadById(threadId)
  if (row?.rollout_path) return row.rollout_path

  const root = path.join(CODEX_HOME, 'sessions')
  if (!threadId || !fs.existsSync(root)) return null
  const suffix = `${threadId}.jsonl`
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let items = []
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const it of items) {
      const p = path.join(dir, it.name)
      if (it.isDirectory()) stack.push(p)
      else if (it.isFile() && it.name.endsWith(suffix)) return p
    }
  }
  return null
}

function findNewestThread({ cwd, model, sinceMs, excludeIds }) {
  const db = openStateDb()
  if (!db) return null
  try {
    const rows = db.prepare(`
      SELECT id, rollout_path, cwd, model,
             COALESCE(created_at_ms, created_at * 1000) AS created_ms,
             COALESCE(updated_at_ms, updated_at * 1000) AS updated_ms,
             first_user_message
      FROM threads
      WHERE cwd = ?
        AND COALESCE(created_at_ms, created_at * 1000) >= ?
      ORDER BY COALESCE(created_at_ms, created_at * 1000) DESC
      LIMIT 20
    `).all(path.resolve(cwd), sinceMs)
    return rows.find((r) => {
      if (excludeIds?.has(r.id)) return false
      if (model && r.model && r.model !== model) return false
      return true
    }) || null
  } catch (e) {
    console.warn(`[tmux-codex] failed to find newest thread: ${e.message}`)
    return null
  } finally {
    try { db.close() } catch {}
  }
}

function findRecentlyUpdatedThread({ cwd, model, sinceMs }) {
  const db = openStateDb()
  if (!db) return null
  try {
    const rows = db.prepare(`
      SELECT id, rollout_path, cwd, model,
             COALESCE(created_at_ms, created_at * 1000) AS created_ms,
             COALESCE(updated_at_ms, updated_at * 1000) AS updated_ms,
             first_user_message
      FROM threads
      WHERE cwd = ?
        AND COALESCE(updated_at_ms, updated_at * 1000) >= ?
      ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
      LIMIT 20
    `).all(path.resolve(cwd), sinceMs)
    return rows.find((r) => {
      if (model && r.model && r.model !== model) return false
      return true
    }) || null
  } catch (e) {
    console.warn(`[tmux-codex] failed to find recently updated thread: ${e.message}`)
    return null
  } finally {
    try { db.close() } catch {}
  }
}

function codexRolloutPathOf(threadId) {
  return findRolloutPathByThreadId(threadId)
}

function isCodexTaskComplete(entry) {
  return entry?.type === 'event_msg' && entry?.payload?.type === 'task_complete'
}

function isCodexTaskStart(entry) {
  return entry?.type === 'event_msg' && ['task_started', 'user_message'].includes(entry?.payload?.type)
}

class TmuxCodexBackend extends AgentBackend {
  constructor() {
    super({ name: 'tmux-codex', runtimeFile: RUNTIME_FILE, archiveFile: ARCHIVE_FILE })
    this.runtime = new Map()
    this._restoreFromPersisted()
  }

  _restoreFromPersisted() {
    let total = 0
    for (const [sid, p] of Object.entries(this.persisted)) {
      total++
      if (!p?.agentSessionId) {
        if (!p?.cwd || !windowExists(sid)) continue
        const recovered = findNewestThread({
          cwd: p.cwd,
          model: p.model || DEFAULT_MODEL,
          sinceMs: Math.max(0, (p.startedAt || 0) - THREAD_BIND_UPDATED_SKEW_MS),
          excludeIds: null,
        })
        const recoveredJsonl = recovered?.id ? (recovered.rollout_path || codexRolloutPathOf(recovered.id)) : null
        if (recovered?.id && recoveredJsonl && fs.existsSync(recoveredJsonl)) {
          const entry = {
            agentSessionId: recovered.id,
            cwd: p.cwd,
            flagRoot: p.flagRoot || p.cwd,
            model: recovered.model || p.model || DEFAULT_MODEL,
            codexProfileKey: p.codexProfileKey || null,
            codexConfigPath: p.codexConfigPath || null,
            codexSecretEnvKey: p.codexSecretEnvKey || null,
            useProxy: normalizeUseProxy(p.useProxy, false),
            displayName: p.displayName || null,
            jsonlPath: recoveredJsonl,
            startedAt: recovered.created_ms || p.startedAt || 0,
            working: true,
            watch: null,
          }
          this.runtime.set(sid, entry)
          this._persistEntry(sid, {
            agentSessionId: entry.agentSessionId,
            cwd: entry.cwd,
            flagRoot: entry.flagRoot,
            model: entry.model,
            codexProfileKey: entry.codexProfileKey,
            codexConfigPath: entry.codexConfigPath,
            codexSecretEnvKey: entry.codexSecretEnvKey,
            useProxy: entry.useProxy,
            displayName: entry.displayName,
            jsonlPath: entry.jsonlPath,
            startedAt: entry.startedAt,
            pendingBind: false,
          })
          this._ensureWatcher(sid)
          log(`[tmux-codex] recovered pending runtime ${sid} to codex_thread=${entry.agentSessionId}`)
          continue
        }
        this.runtime.set(sid, {
          agentSessionId: null,
          cwd: p.cwd,
          flagRoot: p.flagRoot || p.cwd,
          model: p.model || DEFAULT_MODEL,
          codexProfileKey: p.codexProfileKey || null,
          codexConfigPath: p.codexConfigPath || null,
          codexSecretEnvKey: p.codexSecretEnvKey || null,
          useProxy: normalizeUseProxy(p.useProxy, false),
          displayName: p.displayName || null,
          jsonlPath: null,
          startedAt: p.startedAt || 0,
          working: true,
          watch: null,
        })
        log(`[tmux-codex] restored pending runtime ${sid}; waiting for codex thread bind`)
        continue
      }
      const jsonlPath = p.jsonlPath || codexRolloutPathOf(p.agentSessionId)
      if (!jsonlPath || !fs.existsSync(jsonlPath)) {
        log(`[tmux-codex] dropping runtime ${sid}; rollout jsonl missing: ${jsonlPath}`)
        continue
      }
      this.runtime.set(sid, {
        agentSessionId: p.agentSessionId,
        cwd: p.cwd,
        flagRoot: p.flagRoot || p.cwd,
        model: p.model || DEFAULT_MODEL,
        codexProfileKey: p.codexProfileKey || null,
        codexConfigPath: p.codexConfigPath || null,
        codexSecretEnvKey: p.codexSecretEnvKey || null,
        useProxy: normalizeUseProxy(p.useProxy, false),
        displayName: p.displayName || null,
        jsonlPath,
        startedAt: p.startedAt || 0,
        working: false,
        watch: null,
      })
      this._ensureWatcher(sid)
    }
    log(`[tmux-codex] runtime loaded ${this.runtime.size}/${total}`)
  }

  _ensureWatcher(sessionId, startOffset = null) {
    const entry = this.runtime.get(sessionId)
    if (!entry?.jsonlPath || entry.watch) return
    const startSentinel = startOffset == null
      ? null
      : { primary: startOffset, mobius: startOffset === 0 ? 0 : undefined }
    entry.watch = watchMergedJsonl({
      path: entry.jsonlPath,
      startSentinel,
      onEntry: (raw) => {
        this._emitRaw(sessionId, raw)
      },
      onPrimaryEntry: (raw) => this._updateWorkingFromEntry(entry, raw),
      onError: (e) => console.warn(`[tmux-codex/watch ${sessionId}] ${e.message}`),
    })
  }

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

  isAlive(sessionId) {
    // 状态查询走缓存 (12s TTL); 控制流 (create/terminate 等) 请用 windowExists (实时).
    return listWindowsRowsCached().some((cols) => cols[0] === sessionId)
  }

  isWorking(sessionId) {
    if (!this.isAlive(sessionId)) return false
    const entry = this.runtime.get(sessionId)
    if (entry?.working && !entry?.jsonlPath) return true
    const fromJsonl = this._readWorkingFromJsonl(entry?.jsonlPath)
    return fromJsonl == null ? !!entry?.working : fromJsonl
  }

  _readWorkingFromJsonl(jsonlPath) {
    if (!jsonlPath || !fs.existsSync(jsonlPath)) return null
    let lines
    try {
      const stat = fs.statSync(jsonlPath)
      if (stat.size === 0) return null
      const len = Math.min(stat.size, 64 * 1024)
      const buf = Buffer.alloc(len)
      const fd = fs.openSync(jsonlPath, 'r')
      try { fs.readSync(fd, buf, 0, len, stat.size - len) } finally { fs.closeSync(fd) }
      lines = buf.toString('utf8').split('\n').filter(Boolean)
    } catch { return null }

    for (let i = lines.length - 1; i >= 0; i--) {
      let e
      try { e = JSON.parse(lines[i]) } catch { continue }
      if (isCodexTaskComplete(e)) return false
      if (isCodexTaskStart(e)) return true
      if (e.type === 'response_item') {
        const pt = e.payload?.type
        if (['function_call', 'function_call_output', 'reasoning', 'message'].includes(pt)) return true
      }
      if (e.type === 'turn_context') return true
    }
    return null
  }

  isJobGoalAccomplished(sessionId) {
    const entry = this.runtime.get(sessionId)
    const root = entry?.flagRoot || entry?.cwd
    if (!root) return false
    return !fs.existsSync(runningFlagPathOf(root, sessionId))
  }

  isFailed(sessionId) {
    const entry = this.runtime.get(sessionId)
    const root = entry?.flagRoot || entry?.cwd
    if (!root) return false
    return fs.existsSync(failedFlagPathOf(root, sessionId))
  }

  // 扫 Codex TUI 屏幕找最近一条 ErrorEvent.
  // 信号设计 (参考 codex tui/src/history_cell/notices.rs:184):
  //   - 主信号: ■ (U+25A0) — 所有 ErrorEvent 渲染前缀, 几乎只有错误用
  //   - 辅信号: 任一红色 ANSI 序列 — 排除 ■ 的非错误用法
  // 红色 ANSI 三种形式都得覆盖 (colored crate 视 terminfo 选不同 SGR):
  //   - \x1b[31m / \x1b[1;31m           — 基础 16 色红 / 粗体红 (dumb terminal 走这条)
  //   - \x1b[38;5;1m                     — 256 色调色板 index 1 红 (tmux 实测走这条)
  //   - \x1b[38;2;255;G;Bm               — truecolor 红 (R 满 G/B 任意)
  // 单靠颜色不可靠 (警告用黄、系统消息用灰也带 ANSI), 必须 ■ + 红色 双匹配.
  // 坑: Codex TUI 用 alt screen, 进程退出时内容会被销毁; 因此仅在 isAlive 时扫,
  //     历史 session 拿不到. 调用方需要时应另开后台 capture 循环落盘.
  getRecentError(sessionId) {
    if (!this.isAlive(sessionId)) return null
    // -p stdout; -e 保留 ANSI; -S -N 只抓尾部 N 行 (避免全量 scrollback 扫描); -J 拼接折行避免错误被切行.
    const cap = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-e', '-S', `-${CODEX_ERROR_SCAN_TAIL_LINES}`, '-J'])
    if (cap.status !== 0) return null
    const RED_RE = /\x1b\[(?:[0-9;]*;)?(?:31|38;5;1|38;2;255;[0-9]+;[0-9]+)m/
    const ANSI_RE = /\x1b\[[0-9;]*m/g
    const lines = String(cap.stdout || '').split('\n')
    // 反向找最后一条命中 (最近的错误优先).
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('■')) continue
      if (!RED_RE.test(line)) continue
      const cleaned = line.replace(ANSI_RE, '').trim()
      const idx = cleaned.indexOf('■')
      return {
        message: idx >= 0 ? cleaned.slice(idx).trim() : cleaned,
        rawLine: line,
        capturedAt: new Date().toISOString(),
      }
    }
    return null
  }

  listSessions() {
    return listWindowsRowsCached().map((cols) => {
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

  // sessionId → jsonl 文件路径的三级查表 (跟 tmux-claude-code 对称):
  //   runtime (Map, 进程内) > persisted (codex-hub-runtime.json, live) > archive (codex-hub-archive.json, all-time)
  _resolveJsonlPath(sessionId) {
    return this.runtime.get(sessionId)?.jsonlPath
        || this._lookupPersistedJsonlPath(sessionId)
        || this._lookupArchivedJsonlPath(sessionId)
        || null
  }

  getHistory(sessionId, opts = {}) {
    const jsonlPath = this._resolveJsonlPath(sessionId)
    if (!jsonlPath) {
      return { entries: [], total: 0, truncated: false, sentinel: 0 }
    }
    const r = readMergedJsonlHistory(jsonlPath, opts)
    return { entries: r.entries, total: r.total, totalApproximate: r.totalApproximate, truncated: r.truncated, sentinel: r.sentinel }
  }

  getAgentRawThoughtStream(sessionId, listener, opts = {}) {
    if (opts && opts.fromSentinel != null) {
      const jsonlPath = this._resolveJsonlPath(sessionId)
      if (!jsonlPath) return super.getAgentRawThoughtStream(sessionId, listener, opts)
      const w = watchMergedJsonl({
        path: jsonlPath,
        startSentinel: opts.fromSentinel,
        onEntry: (raw) => listener(raw),
        onError: (e) => console.warn(`[tmux-codex/sub ${sessionId}] ${e.message}`),
      })
      return () => { try { w.stop() } catch {} }
    }
    return super.getAgentRawThoughtStream(sessionId, listener, opts)
  }

  _appendMobiusPromptEntry(sessionId, mobiusJsonl) {
    if (!mobiusJsonl) return false
    const entry = this.runtime.get(sessionId)
    if (!entry?.jsonlPath) {
      console.warn(`[tmux-codex] mobius jsonl skipped (${sessionId}): original jsonl path missing`)
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
      console.warn(`[tmux-codex] mobius jsonl append failed (${sessionId}): ${e.message}`)
      return false
    }
  }

  async _createImpl({ sessionId, cwd, flagRoot, model, useProxy, codexProfileKey, codexChannel, codexConfigPath, codexSecretEnvKey, codexSecretValue, displayName, initialPrompt, agentSessionId }) {
    if (!sessionId || !cwd) throw new Error('createNewSession requires sessionId + cwd')
    if (!initialPrompt) throw new Error('createNewSession requires initialPrompt')
    if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`)

    let spawnInfo = null
    let allowUpdatedThreadFallback = false
    if (!windowExists(sessionId)) {
      spawnInfo = await this._spawnWindow({ sessionId, cwd, flagRoot, model, useProxy, codexProfileKey, codexChannel, codexConfigPath, codexSecretEnvKey, codexSecretValue, displayName, agentSessionId })
    } else {
      await this._ensureRuntimeFromKnownThread({ sessionId, cwd, flagRoot, model, useProxy, codexProfileKey: codexChannel || codexProfileKey, codexConfigPath, codexSecretEnvKey, displayName, agentSessionId })
      allowUpdatedThreadFallback = true
    }

    const bindKnownThreadIds = spawnInfo?.knownThreadIds || snapshotThreadIds(cwd)
    const bindSinceMs = spawnInfo?.startedAt || Date.now()
    await this._sendPromptToWindow(sessionId, initialPrompt)
    let entry = this.runtime.get(sessionId)
    markRunning(flagRoot || entry?.flagRoot || entry?.cwd || cwd, sessionId)
    if (!this.runtime.get(sessionId)?.agentSessionId) {
      await this._bindRuntimeAfterPrompt({
        sessionId,
        cwd,
        flagRoot: flagRoot || cwd,
        model: model || DEFAULT_MODEL,
        useProxy: normalizeUseProxy(useProxy, false),
        codexProfileKey: codexChannel || codexProfileKey,
        codexConfigPath,
        codexSecretEnvKey,
        displayName,
        sinceMs: bindSinceMs,
        knownThreadIds: bindKnownThreadIds,
        allowUpdatedThreadFallback,
      })
    }

    entry = this.runtime.get(sessionId)
    return {
      sessionId,
      agentSessionId: entry?.agentSessionId || null,
      jsonlPath: entry?.jsonlPath || null,
      startedAt: entry?.startedAt || Date.now(),
    }
  }

  async _queueImpl({ sessionId, prompt, cwd, flagRoot, model, useProxy, codexProfileKey, codexChannel, codexConfigPath, codexSecretEnvKey, codexSecretValue, displayName, agentSessionId, mobiusJsonl = null }) {
    if (!sessionId) throw new Error('sessionId required')
    if (!prompt) throw new Error('prompt required')

    let spawnInfo = null
    let allowUpdatedThreadFallback = false
    if (!windowExists(sessionId)) {
      const persisted = this.runtime.get(sessionId)
      const finalCwd = cwd || persisted?.cwd
      const finalAgentSid = agentSessionId || persisted?.agentSessionId
      const finalUseProxy = normalizeUseProxy(useProxy, persisted?.useProxy ?? false)
      const finalProfileKey = codexChannel || codexProfileKey || persisted?.codexProfileKey
      const finalConfigPath = codexConfigPath || persisted?.codexConfigPath
      const finalSecretEnvKey = codexSecretEnvKey || persisted?.codexSecretEnvKey
      if (!finalCwd) throw new Error(`session ${sessionId} has no live window and no cwd`)
      spawnInfo = await this._spawnWindow({
        sessionId,
        cwd: finalCwd,
        flagRoot: flagRoot || persisted?.flagRoot || finalCwd,
        model: model || persisted?.model || DEFAULT_MODEL,
        useProxy: finalUseProxy,
        codexProfileKey: finalProfileKey,
        codexConfigPath: finalConfigPath,
        codexSecretEnvKey: finalSecretEnvKey,
        codexSecretValue,
        displayName: displayName || persisted?.displayName,
        agentSessionId: finalAgentSid,
      })
      cwd = finalCwd
      flagRoot = flagRoot || persisted?.flagRoot || finalCwd
      model = model || persisted?.model || DEFAULT_MODEL
      useProxy = finalUseProxy
      codexProfileKey = finalProfileKey
      codexConfigPath = finalConfigPath
      codexSecretEnvKey = finalSecretEnvKey
      displayName = displayName || persisted?.displayName
    } else {
      await this._ensureRuntimeFromKnownThread({ sessionId, cwd, flagRoot, model, useProxy, codexProfileKey: codexChannel || codexProfileKey, codexConfigPath, codexSecretEnvKey, displayName, agentSessionId })
      allowUpdatedThreadFallback = true
    }

    const bindKnownThreadIds = spawnInfo?.knownThreadIds || snapshotThreadIds(cwd)
    const bindSinceMs = spawnInfo?.startedAt || Date.now()
    const entry = this.runtime.get(sessionId)
    if (entry) entry.working = true
    let mobiusJsonlWritten = false
    if (entry?.jsonlPath) {
      mobiusJsonlWritten = this._appendMobiusPromptEntry(sessionId, mobiusJsonl)
    }
    await this._sendPromptToWindow(sessionId, prompt)
    markRunning(flagRoot || entry?.flagRoot || entry?.cwd || cwd, sessionId)
    if (!this.runtime.get(sessionId)?.agentSessionId) {
      await this._bindRuntimeAfterPrompt({
        sessionId,
        cwd,
        flagRoot: flagRoot || cwd,
        model: model || DEFAULT_MODEL,
        useProxy: normalizeUseProxy(useProxy, false),
        codexProfileKey: codexChannel || codexProfileKey,
        codexConfigPath,
        codexSecretEnvKey,
        displayName,
        sinceMs: bindSinceMs,
        knownThreadIds: bindKnownThreadIds,
        allowUpdatedThreadFallback,
      })
      if (!mobiusJsonlWritten) {
        mobiusJsonlWritten = this._appendMobiusPromptEntry(sessionId, mobiusJsonl)
      }
    }
  }

  async _pauseImpl({ sessionId, prompt, cwd, flagRoot }) {
    if (!sessionId) throw new Error('sessionId required')
    const persisted = this.runtime.get(sessionId)

    if (windowExists(sessionId)) {
      for (let i = 0; i < 3; i++) {
        tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'C-c'])
        if (i < 2) await new Promise((r) => setTimeout(r, 50))
      }
      if (persisted) persisted.working = false
      await new Promise((r) => setTimeout(r, 300))
    }

    if (!prompt) {
      clearRunning(flagRoot || persisted?.flagRoot || persisted?.cwd || cwd, sessionId)
      return
    }
    await this._queueImpl({
      sessionId,
      prompt,
      cwd: persisted?.cwd,
      flagRoot: persisted?.flagRoot,
      model: persisted?.model,
      useProxy: persisted?.useProxy,
      codexProfileKey: persisted?.codexProfileKey,
      codexConfigPath: persisted?.codexConfigPath,
      codexSecretEnvKey: persisted?.codexSecretEnvKey,
      displayName: persisted?.displayName,
      agentSessionId: persisted?.agentSessionId,
    })
  }

  async _terminateImpl(sessionId) {
    const wasAlive = windowExists(sessionId)
    const wasWorking = wasAlive && this.isWorking(sessionId)
    const entry = this.runtime.get(sessionId)
    if (entry?.watch) { try { entry.watch.stop() } catch {} }
    this.runtime.delete(sessionId)
    this._forgetPersisted(sessionId)
    if (wasAlive) {
      tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
      log(`[tmux-codex] terminate: killed window=${sessionId} (wasWorking=${wasWorking})`)
    }
    const flagRoot = entry?.flagRoot || entry?.cwd
    if (flagRoot) {
      safeRemoveFlagDir(flagRoot, sessionId, 'tmux-codex')
    }
    return { sessionId, killed: wasAlive, wasWorking }
  }

  async _ensureRuntimeFromKnownThread({ sessionId, cwd, flagRoot, model, useProxy, codexProfileKey, codexConfigPath, codexSecretEnvKey, displayName, agentSessionId }) {
    if (this.runtime.has(sessionId)) return this.runtime.get(sessionId)
    if (!agentSessionId) return null
    const jsonlPath = codexRolloutPathOf(agentSessionId)
    if (!jsonlPath) return null
    const entry = {
      agentSessionId,
      cwd,
      flagRoot: flagRoot || cwd,
      model: model || DEFAULT_MODEL,
      codexProfileKey: codexProfileKey || null,
      codexConfigPath: codexConfigPath || null,
      codexSecretEnvKey: codexSecretEnvKey || null,
      useProxy: normalizeUseProxy(useProxy, false),
      displayName: displayName || null,
      jsonlPath,
      startedAt: Date.now(),
      working: false,
      watch: null,
    }
    this.runtime.set(sessionId, entry)
    this._persistEntry(sessionId, {
      agentSessionId,
      cwd,
      flagRoot: flagRoot || cwd,
      model: model || DEFAULT_MODEL,
      codexProfileKey: entry.codexProfileKey,
      codexConfigPath: entry.codexConfigPath,
      codexSecretEnvKey: entry.codexSecretEnvKey,
      useProxy: normalizeUseProxy(useProxy, false),
      displayName: displayName || null,
      jsonlPath,
      startedAt: entry.startedAt,
      pendingBind: false,
    })
    this._ensureWatcher(sessionId)
    return entry
  }

  async _bindRuntimeAfterPrompt({ sessionId, cwd, flagRoot, model, useProxy, codexProfileKey, codexConfigPath, codexSecretEnvKey, displayName, sinceMs, knownThreadIds, allowUpdatedThreadFallback = false }) {
    const deadline = Date.now() + THREAD_BIND_TIMEOUT_MS
    let found = null
    let foundBy = 'created'
    while (Date.now() < deadline) {
      found = findNewestThread({
        cwd,
        model: model || DEFAULT_MODEL,
        sinceMs: sinceMs || Date.now() - 10000,
        excludeIds: knownThreadIds || new Set(),
      })
      if (found?.id) {
        foundBy = 'created'
        break
      }
      if (allowUpdatedThreadFallback) {
        found = findRecentlyUpdatedThread({
          cwd,
          model: model || DEFAULT_MODEL,
          sinceMs: Math.max(0, (sinceMs || Date.now()) - THREAD_BIND_UPDATED_SKEW_MS),
        })
        if (found?.id) {
          foundBy = 'updated'
          break
        }
      }
      await new Promise((r) => setTimeout(r, THREAD_BIND_POLL_MS))
    }
    if (!found?.id) throw new Error(`Codex thread was not recorded within ${THREAD_BIND_TIMEOUT_MS}ms (cwd=${cwd})`)

    const jsonlPath = found.rollout_path || codexRolloutPathOf(found.id)
    if (!jsonlPath) throw new Error(`Codex thread ${found.id} has no rollout_path`)
    const entry = {
      agentSessionId: found.id,
      cwd,
      flagRoot: flagRoot || cwd,
      model: found.model || model || DEFAULT_MODEL,
      codexProfileKey: codexProfileKey || null,
      codexConfigPath: codexConfigPath || null,
      codexSecretEnvKey: codexSecretEnvKey || null,
      useProxy: normalizeUseProxy(useProxy, false),
      displayName: displayName || null,
      jsonlPath,
      startedAt: found.created_ms || Date.now(),
      working: true,
      watch: null,
    }
    this.runtime.set(sessionId, entry)
    this._persistEntry(sessionId, {
      agentSessionId: found.id,
      cwd,
      flagRoot: flagRoot || cwd,
      model: entry.model,
      codexProfileKey: entry.codexProfileKey,
      codexConfigPath: entry.codexConfigPath,
      codexSecretEnvKey: entry.codexSecretEnvKey,
      useProxy: entry.useProxy,
      displayName: displayName || null,
      jsonlPath,
      startedAt: entry.startedAt,
      pendingBind: false,
    })
    // First stream subscribers attach before Codex has a rollout path; emit from byte 0.
    this._ensureWatcher(sessionId, 0)
    log(`[tmux-codex] bound window=${sessionId} to codex_thread=${found.id} via ${foundBy} jsonl=${jsonlPath}`)
    return entry
  }

  _updateWorkingFromEntry(entry, raw) {
    if (!entry) return
    if (isCodexTaskComplete(raw)) entry.working = false
    else if (isCodexTaskStart(raw)) entry.working = true
    else if (raw?.type === 'response_item') {
      const pt = raw.payload?.type
      if (['function_call', 'function_call_output', 'reasoning', 'message'].includes(pt)) entry.working = true
    }
  }

  // 启动一个新的 Codex tmux 窗口，并返回用于后续绑定 rollout 的启动信息。
  async _spawnWindow({ sessionId, cwd, flagRoot, model, useProxy, codexProfileKey, codexChannel, codexConfigPath, codexSecretEnvKey, codexSecretValue, displayName, agentSessionId }) {
    // 确保承载 agent 窗口的 tmux hub session 已经存在。
    ensureHub()
    // 记录启动时间，后续会写入 runtime 和持久化状态。
    const startedAt = Date.now()
    // 启动前先快照当前 cwd 下已有的 Codex thread，便于新会话后续识别新增 rollout。
    const knownThreadIds = snapshotThreadIds(cwd)
    // 运行标记默认写在 cwd 下；调用方传 flagRoot 时优先使用稳定根目录。
    const effFlagRoot = flagRoot || cwd
    // 未指定模型时使用 Codex backend 的默认模型。
    const finalModel = model || DEFAULT_MODEL
    // codexChannel 优先，其次兼容旧的 codexProfileKey，并统一归一化。
    const profileKey = normalizeCodexChannel(codexChannel || codexProfileKey)
    // Codex profile 对应 $CODEX_HOME/<profile>.config.toml。
    const expectedConfigPath = path.join(CODEX_HOME, `${profileKey}.config.toml`)
    // 启动前确认 profile 配置文件存在。
    if (!fs.existsSync(expectedConfigPath)) {
      // 配置缺失时直接失败，避免 Codex 用错误 profile 启动。
      throw new Error(`codex channel config missing: ${expectedConfigPath}`)
    }
    // 读取 profile 配置，用来解析 env_key 和可能内嵌的 api_key。
    const configText = fs.readFileSync(expectedConfigPath, 'utf8')
    // 从 TOML 中提取秘钥环境变量名。
    const configEnvKey = tomlStringValue(configText, 'env_key')
    // 对环境变量名做规范化，避免非法或空白值进入 export 命令。
    const secretEnvKey = configEnvKey ? normalizeSecretEnvKey(configEnvKey) : null
    // 如果 profile 指定了 env_key，就解析最终要注入 tmux 命令的秘钥值。
    const secretValue = secretEnvKey
      // 秘钥值优先取 TOML api_key，其次取调用方传入的 codexSecretValue，再交给 resolver 兜底。
      ? resolveSecretValue(secretEnvKey, tomlStringValue(configText, 'api_key') || codexSecretValue)
      // 没有 env_key 时不导出秘钥。
      : ''
    // useProxy 与 profile 完全解耦: 只决定是否套 proxychains 网络层.
    // 把调用方的代理参数归一化成布尔值，默认不走代理。
    const finalUseProxy = normalizeUseProxy(useProxy, false)
    // 需要代理时先检查 proxychains 相关文件和命令是否可用。
    if (finalUseProxy) assertProxyAvailable()

    // agentSessionId 存在表示希望恢复已有 Codex thread。
    let useResume = !!agentSessionId
    // rolloutPath 会在 resume 成功时指向已有 Codex rollout jsonl。
    let rolloutPath = null
    // 只有 resume 模式需要查找旧 rollout。
    if (useResume) {
      // 根据 Codex thread id 查找对应 rollout 文件。
      rolloutPath = codexRolloutPathOf(agentSessionId)
      // 找不到 rollout 时不能可靠 resume。
      if (!rolloutPath) {
        // 打印警告，并退化为新建 thread。
        console.warn(`[tmux-codex] resume target rollout not found (${agentSessionId}), starting a new thread`)
        // 关闭 resume 路径，后面会按新会话处理。
        useResume = false
      }
    }

    // 系统调用 codex 强制走 --profile: 加载 $CODEX_HOME/<channel>.config.toml,
    // 并在 tmux 命令中 export TOML env_key 对应的秘钥环境变量.
    // 组装 Codex CLI 参数：模型、工作目录以及自动审批/沙箱绕过参数。
    const codexArgs = ['-m', finalModel, '-C', cwd, '--dangerously-bypass-approvals-and-sandbox']
    // resume 模式下把 thread id 追加给 codex resume 子命令。
    if (useResume) codexArgs.push(agentSessionId)
    // Codex 新会话不需要子命令，resume 模式需要 "resume " 前缀。
    const subcommand = useResume ? 'resume ' : ''
    // 对每个 Codex 参数做 shell 转义后拼成命令行字符串。
    const argStr = codexArgs.map(shellQuote).join(' ')
    // profile 参数固定指向归一化后的 channel/profile。
    const profileArg = `--profile ${shellQuote(profileKey)}`

    // 逐行构造 bash -lc 命令，最后用 && 串起来。
    const cmdLines = [
      // 清掉 VS Code 相关 IPC 环境，避免 CLI 误连到宿主 IDE。
      'unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN',
      // 标记当前进程运行在受控沙箱环境中。
      'export IS_SANDBOX=1',
    ]
    // profile 有 env_key 时，把秘钥导出到 Codex 进程环境里。
    if (secretEnvKey) cmdLines.push(`export ${secretEnvKey}=${shellQuote(secretValue)}`)
    // 按代理开关决定是否加载代理环境并套 proxychains。
    if (finalUseProxy) {
      // 加载代理相关环境变量。
      cmdLines.push(`source ${shellQuote(PROXY_ENVS)}`)
      // 通过 proxychains 启动 Codex，并传入 profile、子命令和参数。
      cmdLines.push(`exec proxychains -q -f ${shellQuote(PROXY_CONF)} codex ${profileArg} ${subcommand}${argStr}`)
    } else {
      // 不走代理时直接启动 Codex。
      cmdLines.push(`exec codex ${profileArg} ${subcommand}${argStr}`)
    }
    // 用 && 串联命令，确保任何前置步骤失败都会阻止后续 exec。
    const cmd = cmdLines.join(' && ')

    // 提前写入项目可信状态，减少 TUI 启动时的交互弹窗。
    ensureProjectTrusted(cwd)

    // 在 hub session 下创建后台 tmux window，并在 cwd 中执行 bash -lc cmd。
    const r = tmux(['new-window', '-d', '-t', HUB, '-n', sessionId, '-c', cwd, 'bash', '-lc', cmd])
    // tmux 创建失败时把 stderr 带出，方便定位命令层问题。
    if (r.status !== 0) throw new Error(`tmux new-window failed: ${r.stderr}`)
    // 记录启动参数，包含模型、代理、profile、秘钥环境变量和 resume 信息。
    log(`[tmux-codex] started: window=${sessionId} cwd=${cwd} model=${finalModel} use_proxy=${finalUseProxy ? 1 : 0} profile-v2=${profileKey} secret_env=${secretEnvKey} config=${codexConfigPath || expectedConfigPath}${useResume ? ` resume=${agentSessionId}` : ''}`)

    // 设置等待 TUI ready 的截止时间。
    const deadline = Date.now() + READY_TIMEOUT_MS
    // ready 标记会在探测到所有 Codex ready 哨兵文本时置为 true。
    let ready = false
    // 记录上次自动按信任确认的时间，用来限频。
    let lastTrustPress = 0
    // 记录上次跳过更新提示的时间，用来限频。
    let lastUpdatePress = 0
    // 保留最后一次非空屏幕内容，超时报错时给调用方看。
    let lastScreen = ''
    const target = `${HUB}:${sessionId}`
    // 在超时前持续轮询 tmux pane 内容。
    while (Date.now() < deadline) {
      // capture 失败时按空屏幕处理，下一轮继续尝试。
      const screen = take_tmux_window_text(target, 100)
      // 如果当前屏幕非空，就保存为最新屏幕快照。
      lastScreen = screen || lastScreen
      // 看到所有 ready 哨兵文本就结束等待。
      if (READY_SENTINELS.every((s) => screen.includes(s))) { ready = true; break }
      // 如果出现 Codex 更新提示，就自动选择跳过更新。
      if (UPDATE_PROMPT_SENTINELS.every((s) => screen.includes(s))) {
        // 读取当前时间，用于判断是否到达下一次按键间隔。
        const now = Date.now()
        // 防止过于频繁地向 TUI 发送跳过更新按键。
        if (now - lastUpdatePress > UPDATE_PRESS_INTERVAL_MS) {
          // 发送 "2" 和 Enter，选择更新提示里的跳过选项。
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, '2', 'Enter'])
          // 更新上次跳过更新提示的时间。
          lastUpdatePress = now
          // 写日志说明已自动跳过 Codex 更新提示。
          log(`[tmux-codex] window=${sessionId} skipped Codex update prompt (cwd=${cwd})`)
        }
      }
      // 如果屏幕上出现目录信任提示，就进入自动确认逻辑。
      if (TRUST_PROMPT_SENTINELS.some((s) => screen.includes(s))) {
        // 读取当前时间，用于判断是否到达下一次按键间隔。
        const now = Date.now()
        // 防止过于频繁地向 TUI 发送 Enter。
        if (now - lastTrustPress > TRUST_PRESS_INTERVAL_MS) {
          // 向当前 tmux window 发送 Enter，确认信任目录。
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
          // 更新上次发送 Enter 的时间。
          lastTrustPress = now
          // 写日志说明已自动处理信任弹窗。
          log(`[tmux-codex] window=${sessionId} confirmed Codex directory trust (cwd=${cwd})`)
        }
      }
      // 等待一个轮询间隔后继续检查屏幕内容。
      await new Promise((r) => setTimeout(r, READY_POLL_MS))
    }
    // 超时仍未 ready 时清理刚创建的 window 并抛错。
    if (!ready) {
      // 避免留下不可用的后台窗口。
      tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
      // 把最后屏幕内容整理成更短的错误详情。
      const detail = summarizeScreen(lastScreen)
      // 把超时信息、cwd 和最后屏幕摘要带给调用方。
      throw new Error(`Codex TUI was not ready within ${READY_TIMEOUT_MS}ms (cwd=${cwd})${detail ? `; last screen:\n${detail}` : ''}`)
    }
    // 记录 TUI 已可用。
    log(`[tmux-codex] window=${sessionId} TUI ready`)

    // 新会话此时还不知道 Codex thread id，需要后续通过新增 rollout 绑定。
    if (!useResume) {
      // 构造新会话的内存 runtime 条目；agentSessionId/jsonlPath 先留空。
      const entry = {
        // 新会话启动后才会发现 Codex thread id。
        agentSessionId: null,
        // 工作目录。
        cwd,
        // running flag 写入根目录。
        flagRoot: effFlagRoot,
        // 实际使用的模型。
        model: finalModel,
        // 实际使用的 Codex profile。
        codexProfileKey: profileKey,
        // 实际使用的 Codex 配置路径。
        codexConfigPath: codexConfigPath || expectedConfigPath,
        // 注入给 Codex 的秘钥环境变量名。
        codexSecretEnvKey: secretEnvKey,
        // 实际使用的代理开关。
        useProxy: finalUseProxy,
        // UI 展示名。
        displayName: displayName || null,
        // 新会话尚未绑定 rollout，因此 jsonlPath 为空。
        jsonlPath: null,
        // 启动时间。
        startedAt,
        // 刚启动时还未提交 prompt，标记为非工作中。
        working: false,
        // watcher 会在绑定 rollout 后再创建。
        watch: null,
      }
      // 把新会话运行态写入内存。
      this.runtime.set(sessionId, entry)
      // 持久化新会话启动参数，并标记 pendingBind 等待绑定 rollout。
      this._persistEntry(sessionId, {
        // 工作目录和 running flag 根目录。
        cwd,
        flagRoot: effFlagRoot,
        // 模型、profile、配置路径和秘钥环境变量名。
        model: finalModel,
        codexProfileKey: profileKey,
        codexConfigPath: codexConfigPath || expectedConfigPath,
        codexSecretEnvKey: secretEnvKey,
        // 代理开关、展示名和启动时间。
        useProxy: finalUseProxy,
        displayName: displayName || null,
        startedAt,
        // 新会话需要后续根据新增 rollout 绑定 thread/jsonl。
        pendingBind: true,
      })
    } else {
      // resume 会话已经知道 thread id 和 rollout 路径，可以立即登记完整状态。
      const entry = {
        // 恢复的 Codex thread id。
        agentSessionId,
        // 工作目录。
        cwd,
        // running flag 写入根目录。
        flagRoot: effFlagRoot,
        // 实际使用的模型。
        model: finalModel,
        // 实际使用的 Codex profile。
        codexProfileKey: profileKey,
        // 实际使用的 Codex 配置路径。
        codexConfigPath: codexConfigPath || expectedConfigPath,
        // 注入给 Codex 的秘钥环境变量名。
        codexSecretEnvKey: secretEnvKey,
        // 实际使用的代理开关。
        useProxy: finalUseProxy,
        // UI 展示名。
        displayName: displayName || null,
        // 已找到的 Codex rollout jsonl 路径。
        jsonlPath: rolloutPath,
        // 启动时间。
        startedAt,
        // 刚恢复时还未提交新 prompt，标记为非工作中。
        working: false,
        // watcher 占位，下面会立即创建。
        watch: null,
      }
      // 把 resume 会话运行态写入内存。
      this.runtime.set(sessionId, entry)
      // 持久化 resume 会话的完整状态。
      this._persistEntry(sessionId, {
        // 恢复的 Codex thread id。
        agentSessionId,
        // 工作目录和 running flag 根目录。
        cwd,
        flagRoot: effFlagRoot,
        // 模型、profile、配置路径和秘钥环境变量名。
        model: finalModel,
        codexProfileKey: profileKey,
        codexConfigPath: codexConfigPath || expectedConfigPath,
        codexSecretEnvKey: secretEnvKey,
        // 代理开关、展示名和 rollout 路径。
        useProxy: finalUseProxy,
        displayName: displayName || null,
        jsonlPath: rolloutPath,
        // 启动时间。
        startedAt,
        // resume 已经绑定 rollout，不需要 pendingBind。
        pendingBind: false,
      })
      // resume 已有 jsonlPath，可以立即启动 watcher。
      this._ensureWatcher(sessionId)
    }

    // 写入 running flag，让外部逻辑知道该 session 正在运行。
    markRunning(effFlagRoot, sessionId)
    // 返回启动时间和旧 thread 快照，供调用方在新会话场景下定位新增 thread。
    return { startedAt, knownThreadIds }
  }

  async _sendPromptToWindow(sessionId, text) {
    if (!windowExists(sessionId)) throw new Error(`window ${sessionId} does not exist`)
    const marker = findAsciiTailMarker(text)
    log(`[tmux-codex] sendPrompt window=${sessionId} len=${text.length} marker=${marker ? JSON.stringify(marker) : '(none)'}`)

    const bufName = `imac_codex_${process.pid}_${Date.now()}`
    const r1 = tmux(['load-buffer', '-b', bufName, '-'], { input: text })
    if (r1.status !== 0) throw new Error(`tmux load-buffer failed: ${r1.stderr}`)

    const r2 = tmux(['paste-buffer', '-p', '-d', '-b', bufName, '-t', `${HUB}:${sessionId}`])
    if (r2.status !== 0) {
      tmux(['delete-buffer', '-b', bufName])
      throw new Error(`tmux paste-buffer failed: ${r2.stderr}`)
    }

    if (marker) {
      const deadline = Date.now() + PASTE_PROBE_TIMEOUT_MS
      let saw = false
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, PASTE_PROBE_INTERVAL_MS))
        const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-S', '-80'])
        if (pane.status === 0 && pane.stdout.includes(marker)) { saw = true; break }
      }
      if (!saw) console.warn(`[tmux-codex] paste marker did not appear within ${PASTE_PROBE_TIMEOUT_MS}ms; sending Enter anyway`)
    } else {
      const sleepMs = Math.min(PASTE_SLEEP_MAX_MS, Math.max(PASTE_SLEEP_BASE_MS, Math.floor(text.length * 0.5)))
      await new Promise((r) => setTimeout(r, sleepMs))
    }

    const entry = this.runtime.get(sessionId)
    if (entry) entry.working = true
    for (let i = 0; i < SUBMIT_ENTER_ATTEMPTS; i++) {
      const r = tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
      if (r.status !== 0) throw new Error(`tmux send-keys Enter failed: ${r.stderr}`)
      if (i < SUBMIT_ENTER_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, SUBMIT_ENTER_INTERVAL_MS))
    }

    recordPromptPaste({ backendName: this.name, sessionId, contentLength: text.length })
  }
}

module.exports = { TmuxCodexBackend, HUB, codexRolloutPathOf, runningFlagPathOf, failedFlagPathOf }
