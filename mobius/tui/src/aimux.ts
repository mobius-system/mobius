/**
 * AIMUX bootstrap for the terminal client.
 *
 * This mirrors the Electron shell: create a user-owned Python venv, install
 * aimux on first use, then keep `aimux reverse connect` attached to the
 * currently authenticated Mobius server.  Nothing is started before login.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mobiusHome } from './config.js'

export type AimuxState = 'starting' | 'connected' | 'failed' | 'stopped' | 'disabled'
export type AimuxPhase = 'idle' | 'python' | 'venv' | 'install' | 'connecting' | 'heartbeat' | 'retrying' | 'connected'
export interface AimuxStatus {
  state: AimuxState
  phase?: AimuxPhase
  detail?: string
  identifier?: string
  attempt?: number
}
export interface InstallProgress { phase: 'python' | 'venv' | 'install' | 'ready'; detail?: string }

const AIMUX_PACKAGE = 'aimux'
const WIN = process.platform === 'win32'
const venvDir = () => path.join(mobiusHome(), 'aimux-venv')
const venvPython = () => WIN ? path.join(venvDir(), 'Scripts', 'python.exe') : path.join(venvDir(), 'bin', 'python')
const aimuxExe = () => WIN ? path.join(venvDir(), 'Scripts', 'aimux.exe') : path.join(venvDir(), 'bin', 'aimux')

interface RunResult { code: number; stdout: string; stderr: string }

function run(cmd: string, args: string[], onLine?: (line: string) => void): Promise<RunResult> {
  return new Promise(resolve => {
    let stdout = '', stderr = ''
    let child: ChildProcess
    try { child = spawn(cmd, args, { windowsHide: true }) } catch (e: any) {
      resolve({ code: 1, stdout, stderr: e?.message ?? String(e) }); return
    }
    const feed = (buf: Buffer, sink: (s: string) => void) => {
      const text = buf.toString('utf8'); sink(text)
      for (const line of text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean)) onLine?.(line)
    }
    child.stdout?.on('data', b => feed(b, s => { stdout += s }))
    child.stderr?.on('data', b => feed(b, s => { stderr += s }))
    child.on('error', e => resolve({ code: 1, stdout, stderr: e.message }))
    child.on('close', code => resolve({ code: code ?? 0, stdout, stderr }))
  })
}

function executable(cmd: string, args: string[] = ['--version']): boolean {
  try { return spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true }).status === 0 } catch { return false }
}

/** Find Python without assuming a package-manager-specific installation. */
function findPython(): string | null {
  const configured = process.env.MOBIUS_TUI_PYTHON
  if (configured && executable(configured, ['--version'])) return configured
  const candidates = WIN ? ['python.exe', 'python', 'py'] : ['python3', 'python']
  for (const candidate of candidates) if (executable(candidate, candidate === 'py' ? ['-3', '--version'] : ['--version'])) return candidate
  return null
}

/** Install a user-local Python when no interpreter is present (requires uv). */
async function installPython(onProgress?: (p: InstallProgress) => void): Promise<string | null> {
  if (!executable('uv', ['--version'])) return null
  onProgress?.({ phase: 'python', detail: '未找到 Python，使用 uv 安装 Python 3.11…' })
  const r = await run('uv', ['python', 'install', '3.11'], line => onProgress?.({ phase: 'python', detail: line.slice(0, 120) }))
  if (r.code !== 0) return null
  const found = await run('uv', ['python', 'find', '3.11'])
  const candidate = found.stdout.trim().split(/\r?\n/).pop()?.trim()
  return candidate && executable(candidate, ['--version']) ? candidate : findPython()
}

async function pythonForAimux(onProgress?: (p: InstallProgress) => void): Promise<string | null> {
  return findPython() ?? installPython(onProgress)
}

export async function ensureAimux(onProgress?: (p: InstallProgress) => void): Promise<{ ok: boolean; error?: string }> {
  if (existsSync(aimuxExe()) && existsSync(venvPython())) { onProgress?.({ phase: 'ready' }); return { ok: true } }
  const py = await pythonForAimux(onProgress)
  if (!py) return { ok: false, error: '未找到 Python。请先安装 Python 3.10+（或安装 uv 后重试）。' }
  onProgress?.({ phase: 'venv', detail: `创建 Python 虚拟环境（${py}）…` })
  let r = await run(py, ['-m', 'venv', venvDir()])
  if (r.code !== 0 && py === 'py') r = await run(py, ['-3', '-m', 'venv', venvDir()])
  if (r.code !== 0) return { ok: false, error: `venv 创建失败: ${r.stderr || r.stdout}` }
  onProgress?.({ phase: 'install', detail: `下载并安装 ${AIMUX_PACKAGE}…` })
  r = await run(venvPython(), ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', AIMUX_PACKAGE], line => {
    if (/downloading|collecting|installing|using cached|%\s*\d|━|─/i.test(line)) onProgress?.({ phase: 'install', detail: line.slice(0, 120) })
  })
  if (r.code !== 0) return { ok: false, error: `pip install 失败: ${r.stderr || r.stdout}` }
  if (!existsSync(aimuxExe())) return { ok: false, error: `aimux 可执行未生成: ${aimuxExe()}` }
  onProgress?.({ phase: 'ready' }); return { ok: true }
}

export function tuiAimuxIdentifier(): string {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return `tui-${host || 'pc'}`
}

export async function probeAimuxBridgeConnection(
  server: string,
  token: string,
  identifier: string,
  timeoutMs = 4_000,
): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(
      `${server.replace(/\/$/, '')}/aimux_bridge/api/remotes/${encodeURIComponent(identifier)}/connection`,
      { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
    )
    if (!response.ok) return false
    const data: any = await response.json().catch(() => ({}))
    return data?.identifier === identifier && data?.event_stream_connected === true
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

interface SupervisorOptions {
  server: string
  token: string
  identifier: string
  onStatus: (s: AimuxStatus) => void
  heartbeatIntervalMs?: number
  heartbeatFailureThreshold?: number
  retryBaseMs?: number
  probeConnection?: () => Promise<boolean>
  spawnProcess?: () => ChildProcess
}

export class AimuxSupervisor {
  private child: ChildProcess | null = null
  private stopping = false
  private retry: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatEpoch = 0
  private heartbeatFailures = 0
  private reconnectAttempt = 0
  private bridgeConnected = false
  private opts: SupervisorOptions
  constructor(opts: SupervisorOptions) { this.opts = opts }
  start() { this.stopping = false; this.spawnChild() }
  private spawnChild() {
    const { server, token, identifier, onStatus } = this.opts
    onStatus({ state: 'starting', phase: 'connecting', detail: '正在连接 Mobius AIMUX bridge…', identifier, attempt: this.reconnectAttempt })
    const child = this.opts.spawnProcess?.() ?? spawn(
      aimuxExe(),
      ['reverse', 'connect', `${server.replace(/\/$/, '')}/aimux_bridge`, '--identifier', identifier, '--token', token, '--replace'],
      { windowsHide: true },
    )
    this.child = child
    this.startHeartbeat()
    const classify = (buf: Buffer) => {
      const text = buf.toString('utf8')
      if (!this.bridgeConnected && /connected|registered|event stream|heartbeat|sse/i.test(text)) {
        onStatus({ state: 'starting', phase: 'heartbeat', detail: 'AIMUX 已启动，等待 bridge 心跳确认…', identifier })
      } else if (/connection (refused|reset|closed|error)|failed to connect|unauthorized|forbidden|token.*invalid/i.test(text)) {
        onStatus({ state: 'failed', phase: 'heartbeat', detail: text.trim().slice(-200), identifier })
      }
    }
    child.stdout?.on('data', classify); child.stderr?.on('data', classify)
    child.on('error', e => onStatus({ state: 'failed', phase: 'retrying', detail: `AIMUX 启动失败: ${e.message}`, identifier }))
    child.on('exit', code => {
      if (this.child !== child) return
      this.child = null
      this.stopHeartbeat()
      if (this.stopping) { onStatus({ state: 'stopped', phase: 'idle', detail: 'AIMUX 已停止', identifier }); return }
      this.scheduleReconnect(`AIMUX 进程退出（code=${code}）`)
    })
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatFailures = 0
    this.bridgeConnected = false
    const epoch = ++this.heartbeatEpoch
    void this.checkHeartbeat(epoch)
  }

  private stopHeartbeat() {
    this.heartbeatEpoch += 1
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private async checkHeartbeat(epoch: number): Promise<void> {
    const connected = await (this.opts.probeConnection?.() ?? probeAimuxBridgeConnection(this.opts.server, this.opts.token, this.opts.identifier))
    if (this.stopping || epoch !== this.heartbeatEpoch || !this.child) return

    const threshold = this.opts.heartbeatFailureThreshold ?? 3
    if (connected) {
      this.heartbeatFailures = 0
      this.reconnectAttempt = 0
      this.bridgeConnected = true
      this.opts.onStatus({
        state: 'connected', phase: 'connected',
        detail: `心跳正常 · ${this.opts.identifier}`,
        identifier: this.opts.identifier,
      })
    } else {
      this.heartbeatFailures += 1
      if (this.heartbeatFailures >= threshold) {
        this.bridgeConnected = false
        await this.restartAfterDisconnect(`bridge 心跳连续 ${this.heartbeatFailures} 次未响应`)
        return
      }
      this.opts.onStatus({
        state: 'starting', phase: 'heartbeat',
        detail: `等待 bridge 心跳确认（${this.heartbeatFailures}/${threshold}）…`,
        identifier: this.opts.identifier,
      })
    }
    const interval = this.opts.heartbeatIntervalMs ?? 5_000
    this.heartbeatTimer = setTimeout(() => void this.checkHeartbeat(epoch), interval)
  }

  private async restartAfterDisconnect(reason: string) {
    this.stopHeartbeat()
    await this.killChild()
    if (!this.stopping) this.scheduleReconnect(reason)
  }

  private scheduleReconnect(reason: string) {
    if (this.stopping || this.retry) return
    this.reconnectAttempt += 1
    const base = this.opts.retryBaseMs ?? 1_000
    const delay = Math.min(15_000, base * (2 ** Math.min(this.reconnectAttempt - 1, 4)))
    const seconds = Math.max(1, Math.ceil(delay / 1_000))
    this.opts.onStatus({
      state: 'failed', phase: 'retrying',
      detail: `${reason}，${seconds} 秒后进行第 ${this.reconnectAttempt} 次重连…`,
      identifier: this.opts.identifier,
      attempt: this.reconnectAttempt,
    })
    this.retry = setTimeout(() => {
      this.retry = null
      if (!this.stopping) this.spawnChild()
    }, delay)
  }

  private async killChild() {
    const child = this.child
    this.child = null
    if (!child?.pid) return
    if (WIN) await run('taskkill', ['/PID', String(child.pid), '/T', '/F'])
    else try { child.kill('SIGTERM') } catch { /* ignore */ }
  }

  async stop() {
    this.stopping = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.stopHeartbeat()
    await this.killChild()
    this.opts.onStatus({ state: 'stopped', phase: 'idle', detail: 'AIMUX 已停止', identifier: this.opts.identifier })
  }
}

let supervisor: AimuxSupervisor | null = null
let installing: Promise<void> | null = null

export async function startAimuxConnection(opts: { server: string; token: string; onStatus?: (s: AimuxStatus) => void }): Promise<void> {
  const onStatus = opts.onStatus ?? (() => {})
  // Tests and explicitly opted-out users should not spawn a network worker.
  if (process.env.MOBIUS_TUI_DISABLE_AIMUX === '1') {
    onStatus({ state: 'disabled', phase: 'idle', detail: 'AIMUX 自动连接已关闭' }); return
  }
  if (process.env.NODE_ENV === 'test' || /^https?:\/\/mock(?:\.local)?(?::\d+)?$/i.test(opts.server)) {
    onStatus({ state: 'disabled', phase: 'idle', detail: 'AIMUX 测试连接已跳过' }); return
  }
  if (supervisor || installing) return
  installing = (async () => {
    onStatus({ state: 'starting', phase: 'python', detail: '检查 Python 与 AIMUX 运行环境…' })
    const ready = await ensureAimux(p => onStatus({
      state: 'starting',
      phase: p.phase === 'ready' ? 'connecting' : p.phase,
      detail: p.detail || (p.phase === 'ready' ? 'AIMUX 已就绪，准备连接…' : p.phase),
    }))
    if (!ready.ok) { onStatus({ state: 'failed', phase: 'idle', detail: ready.error }); return }
    supervisor = new AimuxSupervisor({ server: opts.server, token: opts.token, identifier: tuiAimuxIdentifier(), onStatus })
    supervisor.start()
  })().finally(() => { installing = null })
  await installing
}

export async function stopAimuxConnection(): Promise<void> {
  const current = supervisor; supervisor = null
  await current?.stop()
}
