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
export interface AimuxStatus { state: AimuxState; detail?: string; identifier?: string }
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

function defaultIdentifier(): string {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return `tui-${host || 'pc'}`
}

class AimuxSupervisor {
  private child: ChildProcess | null = null
  private stopping = false
  private retry: ReturnType<typeof setTimeout> | null = null
  private opts: { server: string; token: string; identifier: string; onStatus: (s: AimuxStatus) => void }
  constructor(opts: AimuxSupervisor['opts']) { this.opts = opts }
  start() { this.stopping = false; this.spawnChild() }
  private spawnChild() {
    const { server, token, identifier, onStatus } = this.opts
    onStatus({ state: 'starting', detail: '正在连接 Mobius aimux bridge…', identifier })
    const child = spawn(aimuxExe(), ['reverse', 'connect', `${server.replace(/\/$/, '')}/aimux_bridge`, '--identifier', identifier, '--token', token, '--replace'], { windowsHide: true })
    this.child = child
    const classify = (buf: Buffer) => {
      const text = buf.toString('utf8')
      if (/connected|registered|event stream|heartbeat|sse/i.test(text)) onStatus({ state: 'connected', detail: text.trim().slice(-160), identifier })
      else if (/connection (refused|reset|closed|error)|failed to connect|unauthorized|forbidden|token.*invalid/i.test(text)) onStatus({ state: 'failed', detail: text.trim().slice(-200), identifier })
    }
    child.stdout?.on('data', classify); child.stderr?.on('data', classify)
    child.on('error', e => onStatus({ state: 'failed', detail: `aimux 启动失败: ${e.message}`, identifier }))
    child.on('exit', code => {
      if (this.child !== child) return
      this.child = null
      if (this.stopping) { onStatus({ state: 'stopped', identifier }); return }
      onStatus({ state: 'failed', detail: `aimux 退出 code=${code}，5 秒后重试`, identifier })
      this.retry = setTimeout(() => { if (!this.stopping) this.spawnChild() }, 5000)
    })
  }
  async stop() {
    this.stopping = true
    if (this.retry) clearTimeout(this.retry)
    const child = this.child; this.child = null
    if (child?.pid) {
      if (WIN) await run('taskkill', ['/PID', String(child.pid), '/T', '/F'])
      else try { child.kill('SIGTERM') } catch { /* ignore */ }
    }
    this.opts.onStatus({ state: 'stopped', identifier: this.opts.identifier })
  }
}

let supervisor: AimuxSupervisor | null = null
let installing: Promise<void> | null = null

export async function startAimuxConnection(opts: { server: string; token: string; onStatus?: (s: AimuxStatus) => void }): Promise<void> {
  // Tests and explicitly opted-out users should not spawn a network worker.
  if (process.env.MOBIUS_TUI_DISABLE_AIMUX === '1' || process.env.NODE_ENV === 'test' || /^https?:\/\/mock(?:\.local)?(?::\d+)?$/i.test(opts.server)) return
  const onStatus = opts.onStatus ?? (() => {})
  if (supervisor || installing) return
  installing = (async () => {
    onStatus({ state: 'starting', detail: '准备 AIMUX（首次启动会安装 Python 和 aimux）…' })
    const ready = await ensureAimux(p => onStatus({ state: 'starting', detail: p.detail || (p.phase === 'ready' ? 'aimux 已就绪' : p.phase) }))
    if (!ready.ok) { onStatus({ state: 'failed', detail: ready.error }); return }
    supervisor = new AimuxSupervisor({ server: opts.server, token: opts.token, identifier: defaultIdentifier(), onStatus })
    supervisor.start()
  })().finally(() => { installing = null })
  await installing
}

export async function stopAimuxConnection(): Promise<void> {
  const current = supervisor; supervisor = null
  await current?.stop()
}
