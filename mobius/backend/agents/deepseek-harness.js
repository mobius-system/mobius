const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { AgentBackend } = require('./base')
const { HarnessJsonRpcPeer } = require('./deepseek-harness-protocol')
const { projectHarnessEvent } = require('./deepseek-harness-events')
const {
  appendMobiusPromptEntry,
  appendMobiusExternalEntry,
  watchMergedJsonl,
  readMergedJsonlHistory,
} = require('../services/mobius-jsonl')
const {
  timeConsumeWaterfallFromBackend,
  clearTimeConsumeWaterfallForBackend,
} = require('../services/time-consume-waterfall')
const {
  safeWriteRunningFlag,
  safeRemoveRunningFlag,
  safeRemoveFlagDir,
  runningFlagPathOf,
  failedFlagPathOf,
} = require('../utils/session-flags')
const { recordPromptPaste } = require('../services/agent-prompt-events')
const { MOBIUS_DATA_PATH } = require('../config')

const RUNTIME_FILE = path.join(MOBIUS_DATA_PATH, 'deepseek-harness-runtime.json')
const ARCHIVE_FILE = path.join(MOBIUS_DATA_PATH, 'deepseek-harness-archive.json')
const SESSION_ROOT = path.join(MOBIUS_DATA_PATH, 'deepseek-harness-sessions')
const RUNTIME_PACKAGE = path.join(__dirname, '..', '..', 'deepseek-harness-runtime')
const DEFAULT_RUNTIME_BIN = path.join(RUNTIME_PACKAGE, 'node_modules', '.bin', 'dsh-jsonrpc-agent')
const DEFAULT_CONFIG = path.join(RUNTIME_PACKAGE, 'cordis.yml')
const DEFAULT_NODE = path.join(os.homedir(), '.nvm', 'versions', 'node', 'v22.22.2', 'bin', 'node')
const DEFAULT_PROXY_BIN = '/usr/bin/proxychains'
const DEFAULT_PROXY_CONFIG = path.join(os.homedir(), 'proxy_claude.conf')
const MAX_STDERR_BYTES = 64 * 1024

function pidAlive(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return false
  try { process.kill(Number(pid), 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function resolveRuntimeCommand(opts = {}) {
  const explicit = opts.runtimeCommand || process.env.DEEPSEEK_HARNESS_RUNTIME_COMMAND
  let command
  let args
  if (explicit) {
    command = explicit
    args = Array.isArray(opts.runtimeArgs) ? opts.runtimeArgs : []
  } else {
    const node = opts.runtimeNode || process.env.DEEPSEEK_HARNESS_NODE || DEFAULT_NODE
    if (!fs.existsSync(node)) throw new Error(`DeepSeek Harness requires Node 22/24 runtime: ${node}`)
    if (!fs.existsSync(DEFAULT_RUNTIME_BIN)) throw new Error(`DeepSeek Harness runtime is not installed: ${DEFAULT_RUNTIME_BIN}`)
    command = node
    args = [DEFAULT_RUNTIME_BIN, opts.runtimeConfig || DEFAULT_CONFIG]
  }
  if (!opts.useProxy) return { command, args }
  const proxyBin = opts.proxyBin || DEFAULT_PROXY_BIN
  const proxyConfig = opts.proxyConfig || DEFAULT_PROXY_CONFIG
  if (!fs.existsSync(proxyBin) || !fs.existsSync(proxyConfig)) {
    throw new Error(`DeepSeek Harness proxy prerequisites missing: ${proxyBin}, ${proxyConfig}`)
  }
  return { command: proxyBin, args: ['-q', '-f', proxyConfig, command, ...args] }
}

function appendJsonl(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)
}

class DeepSeekHarnessBackend extends AgentBackend {
  constructor(opts = {}) {
    super({ name: 'deepseek-harness', runtimeFile: opts.runtimeFile || RUNTIME_FILE, archiveFile: opts.archiveFile || ARCHIVE_FILE })
    this.runtime = new Map()
    this.spawn = opts.spawn || spawn
    this.runtimeOptions = opts.runtimeOptions || {}
    this.sessionRoot = opts.sessionRoot || SESSION_ROOT
    for (const [sessionId, entry] of Object.entries(this.persisted)) {
      this.runtime.set(sessionId, { ...entry, child: null, peer: null, working: false, pending: [], stderr: '', watcher: null })
    }
  }

  _sessionDir(sessionId) { return path.join(this.sessionRoot, sessionId) }
  _jsonlPath(sessionId) { return path.join(this._sessionDir(sessionId), 'mobius-harness.jsonl') }
  _nativeRoot(sessionId) { return path.join(this._sessionDir(sessionId), 'native') }
  _resolveJsonlPath(sessionId) {
    return this.runtime.get(sessionId)?.jsonlPath || this._lookupPersistedJsonlPath(sessionId) || this._lookupArchivedJsonlPath(sessionId)
  }

  _watch(sessionId, jsonlPath, startSentinel) {
    const entry = this.runtime.get(sessionId)
    if (!entry) return
    entry.watcher?.stop?.()
    entry.watcher = watchMergedJsonl({
      path: jsonlPath,
      startSentinel,
      onEntry: (entry) => this._emitRaw(sessionId, entry),
      onError: (error) => this._captureError(sessionId, error),
    })
  }

  _captureError(sessionId, error, rawLine = '') {
    const entry = this.runtime.get(sessionId)
    if (!entry) return
    entry.recentError = { message: String(error?.message || error), rawLine: String(rawLine || ''), capturedAt: new Date().toISOString() }
  }

  _appendMobiusPromptEntry(entry, mobiusJsonl) {
    if (!entry?.jsonlPath || !mobiusJsonl) return false
    try {
      const append = mobiusJsonl.kind === 'external_session_message'
        ? appendMobiusExternalEntry
        : appendMobiusPromptEntry
      append({
        jsonlPath: entry.jsonlPath,
        sessionId: entry.sessionId,
        agentSessionId: entry.agentSessionId,
        cwd: entry.cwd,
        backendName: this.name,
        ...mobiusJsonl,
      })
      return true
    } catch (error) {
      this._captureError(entry.sessionId, error)
      return false
    }
  }

  _onNotification(sessionId, method, params) {
    const entry = this.runtime.get(sessionId)
    if (!entry) return
    if (method === 'session.status' && params.sessionId === entry.agentSessionId) {
      entry.working = params.status === 'running'
      if (!entry.working) entry.pending = []
      return
    }
    if (method === 'session.event' && params.sessionId === entry.agentSessionId) {
      const projected = projectHarnessEvent(params.event, entry)
      for (const value of projected) appendJsonl(entry.jsonlPath, value)
      if (params.event?.type === 'turn/end') {
        const reason = params.event?.data?.reason
        if (reason?.kind === 'error') this._captureError(sessionId, new Error(reason.error?.message || 'DeepSeek Harness turn failed'))
      }
    }
  }

  async _start(sessionId, opts, prompt) {
    const previous = this.runtime.get(sessionId)
    previous?.watcher?.stop?.()
    const cwd = path.resolve(opts.cwd)
    const flagRoot = path.resolve(opts.flagRoot || cwd)
    const agentSessionId = opts.agentSessionId || sessionId
    const jsonlPath = this._jsonlPath(sessionId)
    const nativeRoot = this._nativeRoot(sessionId)
    fs.mkdirSync(nativeRoot, { recursive: true })
    if (!fs.existsSync(jsonlPath)) fs.writeFileSync(jsonlPath, '')
    const command = resolveRuntimeCommand({ ...this.runtimeOptions, ...opts, useProxy: !!opts.useProxy })
    const env = {
      ...process.env,
      DEEPSEEK_API_KEY: String(opts.harnessSecretValue || ''),
      DEEPSEEK_BASE_URL: String(opts.harnessBaseUrl || 'https://api.deepseek.com'),
      DSH_CWD: cwd,
      DSH_SESSION_ROOT: nativeRoot,
      DSH_MAX_TOKENS_AS_SUCCESS: 'false',
      DSH_SYSTEM_PROMPT: String(opts.systemPrompt || 'You are a coding agent operating inside Mobius.'),
    }
    const child = this.spawn(command.command, command.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const entry = {
      sessionId, agentSessionId, cwd, flagRoot, jsonlPath, nativeRoot, pid: child.pid || null,
      model: opts.model, provider: opts.harnessProvider || 'deepseek-official', maxTokens: opts.harnessMaxTokens || null,
      runtimeVersion: opts.harnessRuntimeVersion || '0.0.1-rc.5', useProxy: !!opts.useProxy,
      startedAt: Date.now(), child, peer: null, working: false, pending: [], stderr: '', recentError: null, watcher: null,
    }
    this.runtime.set(sessionId, entry)
    const peer = new HarnessJsonRpcPeer(child, {
      requestTimeoutMs: Number(opts.harnessRequestTimeoutMs) || 30000,
      onNotification: (method, params) => this._onNotification(sessionId, method, params),
      onProtocolError: (error) => this._captureError(sessionId, error),
    })
    entry.peer = peer
    child.stderr.on('data', (chunk) => {
      entry.stderr = (entry.stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES)
    })
    child.once('exit', (code, signal) => {
      entry.working = false
      entry.pending = []
      entry.pid = null
      if (code && !entry.terminating) this._captureError(sessionId, new Error(`DeepSeek Harness runtime exited with code ${code}`), entry.stderr)
      this._persistEntry(sessionId, { pid: null, lastExitCode: code, lastExitSignal: signal || null })
    })
    try {
      this._persistEntry(sessionId, {
        sessionId, agentSessionId, cwd, flagRoot, jsonlPath, nativeRoot, pid: entry.pid, model: entry.model,
        provider: entry.provider, maxTokens: entry.maxTokens, runtimeVersion: entry.runtimeVersion, useProxy: entry.useProxy,
        startedAt: entry.startedAt,
      })
      this._watch(sessionId, jsonlPath)
      await peer.request('initialize', {
        cwd,
        provider: entry.provider,
        model: entry.model,
        ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
      })
      this._appendMobiusPromptEntry(entry, opts.mobiusJsonl)
      await this._sendPrompt(entry, prompt)
      if (!opts.suppressRunningFlag) {
        safeWriteRunningFlag(flagRoot, sessionId, { backend: this.name }, this.name)
      }
      return { sessionId, agentSessionId, pid: entry.pid }
    } catch (error) {
      this._captureError(sessionId, error)
      await this._stopRuntime(entry, false).catch(() => {})
      throw error
    }
  }

  async _sendPrompt(entry, prompt) {
    const text = String(prompt || '').trim()
    if (!text) return
    entry.pending.push({ content: text, enqueuedAt: new Date().toISOString() })
    entry.working = true
    const result = await entry.peer.request('session/prompt', {
      sessionId: entry.agentSessionId,
      contentBlocks: [{ type: 'text', text }],
    })
    recordPromptPaste({ backendName: this.name, sessionId: entry.sessionId, contentLength: text.length })
    return result
  }

  createNewSession(opts) {
    return this._withLock(opts.sessionId, async () => {
      if (this.isAlive(opts.sessionId)) throw new Error(`DeepSeek Harness session already alive: ${opts.sessionId}`)
      return this._start(opts.sessionId, opts, opts.prompt)
    })
  }

  noPauseCurrentAndQueueQueryAtSession(opts) {
    return this._withLock(opts.sessionId, async () => {
      let entry = this.runtime.get(opts.sessionId)
      if (!entry || !this.isAlive(opts.sessionId)) {
        await this._start(opts.sessionId, { ...entry, ...opts, agentSessionId: entry?.agentSessionId || opts.agentSessionId }, opts.prompt)
        return
      }
      this._appendMobiusPromptEntry(entry, opts.mobiusJsonl)
      await this._sendPrompt(entry, opts.prompt)
      if (!opts.suppressRunningFlag) {
        safeWriteRunningFlag(opts.flagRoot || entry.flagRoot || entry.cwd, opts.sessionId, { backend: this.name }, this.name)
      }
    })
  }

  pauseCurrentAndResumeFromSession(opts) {
    return this._withLock(opts.sessionId, async () => {
      const old = this.runtime.get(opts.sessionId)
      if (old && this.isAlive(opts.sessionId)) await this._stopRuntime(old, false)
      if (!String(opts.prompt || '').trim()) {
        safeRemoveRunningFlag(opts.flagRoot || old?.flagRoot || old?.cwd || opts.cwd, opts.sessionId, this.name)
        return
      }
      await this._start(opts.sessionId, { ...old, ...opts, agentSessionId: old?.agentSessionId || opts.agentSessionId }, opts.prompt)
    })
  }

  async _stopRuntime(entry, graceful = true) {
    if (!entry?.child) return
    entry.terminating = true
    if (graceful && entry.peer && !entry.peer.closed) {
      try { await entry.peer.request('shutdown', undefined, 5000) } catch {}
    }
    if (pidAlive(entry.child.pid)) entry.child.kill('SIGTERM')
    await new Promise((resolve) => {
      if (entry.child.exitCode != null || entry.child.signalCode) return resolve()
      const timer = setTimeout(() => { if (pidAlive(entry.child.pid)) entry.child.kill('SIGKILL'); resolve() }, 3000)
      entry.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    entry.peer?.close()
    entry.watcher?.stop?.()
    entry.child = null
    entry.peer = null
    entry.pid = null
    entry.working = false
    entry.pending = []
  }

  terminateSession(sessionId) {
    return this._withLock(sessionId, async () => {
      const entry = this.runtime.get(sessionId)
      if (entry) await this._stopRuntime(entry, true)
      this.runtime.delete(sessionId)
      this._forgetPersisted(sessionId)
      if (entry?.flagRoot || entry?.cwd) safeRemoveFlagDir(entry.flagRoot || entry.cwd, sessionId, this.name)
    })
  }

  isAlive(sessionId) {
    const entry = this.runtime.get(sessionId)
    return !!entry?.child && pidAlive(entry.child.pid)
  }
  isWorking(sessionId) { return this.isAlive(sessionId) && !!this.runtime.get(sessionId)?.working }
  listSessions() {
    return [...this.runtime.values()].filter((entry) => this.isAlive(entry.sessionId)).map((entry) => ({
      sessionId: entry.sessionId, agentSessionId: entry.agentSessionId, pid: entry.child?.pid || null,
      paneDead: false, working: this.isWorking(entry.sessionId),
      lastActivityMs: entry.startedAt || null,
      lastActivityAt: entry.startedAt ? new Date(entry.startedAt).toISOString() : null,
    }))
  }
  getPendingRequests(sessionId) { return [...(this.runtime.get(sessionId)?.pending || [])] }
  getRecentError(sessionId) { return this.runtime.get(sessionId)?.recentError || null }
  getHistory(sessionId, opts = {}) {
    const jsonlPath = this._resolveJsonlPath(sessionId)
    return jsonlPath ? readMergedJsonlHistory(jsonlPath, opts) : { entries: [], sentinel: null }
  }

  get_time_consume_waterfall(sessionId, opts = {}) {
    return timeConsumeWaterfallFromBackend(this, sessionId, opts)
  }

  clear_time_consume_waterfall(sessionId, opts = {}) {
    return clearTimeConsumeWaterfallForBackend(this, sessionId, opts)
  }
  getAgentRawThoughtStream(sessionId, listener, opts = {}) {
    const jsonlPath = this._resolveJsonlPath(sessionId)
    if (!jsonlPath) return super.getAgentRawThoughtStream(sessionId, listener, opts)
    const watcher = watchMergedJsonl({
      path: jsonlPath,
      startSentinel: opts.fromSentinel,
      onEntry: (entry) => listener(entry),
    })
    return () => watcher.stop?.()
  }
  isJobGoalAccomplished(sessionId) {
    const entry = this.runtime.get(sessionId) || this._lookupPersistedEntry(sessionId)
    const root = entry?.flagRoot || entry?.cwd
    return !!root && !fs.existsSync(runningFlagPathOf(root, sessionId))
  }
  isFailed(sessionId) {
    const entry = this.runtime.get(sessionId) || this._lookupPersistedEntry(sessionId)
    const root = entry?.flagRoot || entry?.cwd
    return !!root && fs.existsSync(failedFlagPathOf(root, sessionId))
  }
}

module.exports = { DeepSeekHarnessBackend, resolveRuntimeCommand, pidAlive }
