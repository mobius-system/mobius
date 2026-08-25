/**
 * AIMUX bootstrap for the terminal client.
 *
 * This mirrors the Electron shell: create a user-owned Python venv, install
 * aimux on first use, then keep `aimux reverse connect` attached to the
 * currently authenticated Mobius server.  Nothing is started before login.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs, existsSync, createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import extract from 'extract-zip'
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

/** aimux 的调用方式：venv 直接执行，或用内置 python 跑 `-m aimux`（Plan B 兜底）。 */
export type AimuxLauncher =
  | { kind: 'exe'; path: string }
  | { kind: 'module'; python: string }

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

// ── Plan B: 内置 python+aimux 运行时（本地 venv/pip 失败时的离线兜底）─────────
// 一个 zip 内含完整的 python-build-standalone（自带 ensurepip+pip）+ 预装 aimux；
// 解压到 ~/.mobius/python-bundle/ 后用 `<python> -m aimux` 运行，彻底绕开宿主机
// 系统 python（如被精简掉 ensurepip 的容器镜像）。aimux 全部依赖为纯 Python，
// 故三平台可共用同一套打包产物，分别按 arch 发布到 CDN。
const BUNDLE_VER = '3'
const BUNDLE_AIMUX_VERSION = '0.1.24'
const bundleDir = () => path.join(mobiusHome(), 'python-bundle')
const bundlePython = () => WIN
  ? path.join(bundleDir(), 'python', 'python.exe')
  : path.join(bundleDir(), 'python', 'bin', 'python3')

/** Persistent child-process diagnostics. Never include the JWT in this file. */
export const aimuxLogPath = () => path.join(mobiusHome(), 'aimux.log')

function appendAimuxLog(write: { queue: Promise<void> }, text: string): void {
  write.queue = write.queue
    .then(async () => {
      await fs.mkdir(mobiusHome(), { recursive: true })
      await fs.appendFile(aimuxLogPath(), text, 'utf8')
    })
    .catch(() => {})
}

// 安装阶段(download/extract/verify)独享的日志队列 —— 与 supervisor 的分离，避免互相阻塞。
// 关键: 原先安装阶段一行都不写 aimux.log，"卡在解压内置运行时"时日志完全空白 = 黑盒。
// 现在每个子步骤(连接/首字节/字节增量/解压文件数/import 校验/退出码/耗时)都落盘带时间戳，
// 下次卡住直接 tail ~/.mobius/aimux.log 就知道卡在第几秒、哪个环节、下了多少 MB。
const installLogQueue = { queue: Promise.resolve() as Promise<void> }
const logInstall = (text: string): void => appendAimuxLog(installLogQueue, text)

/** 当前平台对应的内置运行时包名；mac-arm64 走 mac-x64（Rosetta 2）。 */
export function bundleArch(): string | null {
  const { platform, arch } = process
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) return 'mac-x64'
  return null
}

/** CDN 基址可用 MOBIUS_TUI_PYTHON_BUNDLE_URL 覆盖；文件名固定为 mobius-python-<arch>-v<N>.zip。 */
export const bundleBaseUrl = () => (process.env.MOBIUS_TUI_PYTHON_BUNDLE_URL || 'https://serve.nutshellai.cn/publish/auto/mobius-tui').replace(/\/$/, '')
export const bundleUrl = (arch: string) => `${bundleBaseUrl()}/mobius-python-${arch}-v${BUNDLE_VER}.zip`

export function bundleHealthCheckCode(platform: NodeJS.Platform = process.platform): string {
  const imports = platform === 'win32'
    ? 'import aimux, aimux.bridge_client, win32_setctime'
    : 'import aimux, aimux.bridge_client'
  return `${imports}; assert aimux.__version__ == '${BUNDLE_AIMUX_VERSION}'`
}

function bundleReady(): boolean {
  return existsSync(bundlePython()) && spawnSync(
    bundlePython(),
    ['-c', bundleHealthCheckCode()],
    { stdio: 'ignore', windowsHide: true },
  ).status === 0
}

async function downloadBundle(arch: string, onProgress?: (p: InstallProgress) => void): Promise<{ ok: boolean; error?: string; zipPath?: string }> {
  const url = bundleUrl(arch)
  const zipPath = path.join(mobiusHome(), `python-bundle-v${BUNDLE_VER}.zip.tmp`)
  await fs.mkdir(path.dirname(zipPath), { recursive: true })   // 首次安装 ~/.mobius 可能尚未创建
  const startedAt = Date.now()
  logInstall(`\n===== bundle download start ${new Date().toISOString()} arch=${arch} =====\n  url=${url}\n`)
  // fetch 无内置超时：受限网络（训练 pod 出网被掐 / 被透明代理劫持成慢速 chunked）下会永久挂起 → spinner 永转。
  // 用一个可重置的 AbortController：连接/首字节给 CONNECT_MS，之后每收到一块重置为 STALL_MS，停滞即 abort 并给出可读原因。
  const CONNECT_MS = 45_000, STALL_MS = 30_000
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stallReason = ''
  const arm = (ms: number, reason: string) => { if (timer) clearTimeout(timer); stallReason = reason; timer = setTimeout(() => controller.abort(), ms) }
  arm(CONNECT_MS, `连接/首字节超时（${CONNECT_MS / 1000}s 未响应，可能出网被掐）`)
  let res: Response
  try { res = await fetch(url, { signal: controller.signal }) }
  catch (e: any) {
    if (timer) clearTimeout(timer)
    const msg = e?.name === 'AbortError' ? `下载失败: ${stallReason}` : `下载失败: ${e?.message ?? e}`
    logInstall(`  fetch error: ${e?.name} ${e?.message ?? e} elapsed=${Date.now() - startedAt}ms\n`)
    return { ok: false, error: msg }
  }
  if (!res.ok) { if (timer) clearTimeout(timer); logInstall(`  HTTP ${res.status} ${res.statusText}\n`); return { ok: false, error: `下载失败: HTTP ${res.status} (${url})` } }
  const total = Number(res.headers.get('content-length') || 0)
  logInstall(`  200 OK content-length=${total || 'unknown (chunked)'}\n`)
  const ws = createWriteStream(zipPath)
  let got = 0, last = 0
  try {
    const stream = Readable.fromWeb(res.body as any)
    for await (const chunk of stream) {
      arm(STALL_MS, `下载停滞超时（已下载 ${(got / 1048576).toFixed(0)}MB，${STALL_MS / 1000}s 无新增数据）`)
      ws.write(chunk as Buffer)
      got += (chunk as Buffer).length
      // 始终反馈进度：有 content-length 用百分比，否则按 3MB 增量报 MB（chunked 传输无 total 时也能动）。
      if (total) { if (got - last > total * 0.03) { last = got; onProgress?.({ phase: 'install', detail: `下载内置运行时 ${Math.round((got / total) * 100)}%` }) } }
      else if (got - last > 3 * 1048576) { last = got; onProgress?.({ phase: 'install', detail: `下载内置运行时 ${(got / 1048576).toFixed(0)}MB` }) }
    }
    onProgress?.({ phase: 'install', detail: total ? `下载内置运行时 100%` : `下载内置运行时 ${(got / 1048576).toFixed(0)}MB` })
    await new Promise<void>((resolve, reject) => { ws.end(() => resolve()); ws.on('error', reject) })
    logInstall(`  done bytes=${got} (${(got / 1048576).toFixed(1)}MB) elapsed=${Date.now() - startedAt}ms avg=${Math.round(got / 1024 / Math.max(1, (Date.now() - startedAt) / 1000))}KB/s\n`)
  } catch (e: any) {
    try { ws.destroy() } catch {}
    try { await fs.unlink(zipPath) } catch {}
    const msg = e?.name === 'AbortError' ? `下载失败: ${stallReason}` : `下载失败: ${e?.message ?? e}`
    logInstall(`  stream error: ${e?.name} ${e?.message ?? e} got=${got} (${(got / 1048576).toFixed(1)}MB) elapsed=${Date.now() - startedAt}ms\n`)
    return { ok: false, error: msg }
  } finally { if (timer) clearTimeout(timer) }
  return { ok: true, zipPath }
}

async function extractBundle(zipPath: string, onProgress?: (p: InstallProgress) => void): Promise<{ ok: boolean; error?: string }> {
  const staging = path.join(mobiusHome(), 'python-bundle.new')
  const finalDir = bundleDir()
  const stagingPython = WIN ? path.join(staging, 'python', 'python.exe') : path.join(staging, 'python', 'bin', 'python3')
  await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(staging, { recursive: true })
  logInstall(`  extract start → ${staging}\n`)
  let entryCount = 0
  const startedAt = Date.now()
  // 解压几千个小文件在慢盘(网络 FS / CPFS)上可能耗时数十秒；用 onEntry 计数周期性反馈进度，
  // 避免"解压内置运行时…"文案在漫长解压期间一动不动 = 看起来像死机。
  try {
    await extract(zipPath, {
      dir: staging, defaultDirMode: 0o755, defaultFileMode: 0o644,
      onEntry: () => { entryCount += 1; if (entryCount % 300 === 0) onProgress?.({ phase: 'install', detail: `解压内置运行时… ${entryCount} 个文件` }) },
    })
  } catch (e: any) { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); logInstall(`  extract error: ${e?.message ?? e} entries=${entryCount}\n`); return { ok: false, error: `解压失败: ${e?.message ?? e}` } }
  logInstall(`  extract done entries=${entryCount} elapsed=${Date.now() - startedAt}ms\n`)
  if (!WIN) try { await fs.chmod(stagingPython, 0o755) } catch {}   // 保险：确保可执行位（extract-zip 通常已还原）
  await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {})
  await fs.rename(staging, finalDir)
  return { ok: true }
}

/** 解压后校验内置 python 能 import aimux。用 spawn（非阻塞 spawnSync）避免冻结 Ink 渲染；
 *  60s 上限强杀（首次 import 在慢盘上可能慢，但不会无限）；stderr(traceback) 落日志，让"解压完仍卡"可诊断。 */
async function verifyBundle(onProgress?: (p: InstallProgress) => void): Promise<{ ok: boolean; error?: string }> {
  onProgress?.({ phase: 'install', detail: '校验内置运行时（首次 import aimux，可能耗时）…' })
  const py = bundlePython()
  logInstall(`  verify start: ${py} -c "import aimux…" (expect v${BUNDLE_AIMUX_VERSION})\n`)
  const startedAt = Date.now()
  return new Promise(resolve => {
    let child: ChildProcess
    try { child = spawn(py, ['-c', bundleHealthCheckCode()], { windowsHide: true }) }
    catch (e: any) { resolve({ ok: false, error: `校验失败: ${e?.message ?? e}` }); return }
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {}; resolve({ ok: false, error: `校验超时（60s 未完成 import aimux，疑似慢盘）· 日志: ${aimuxLogPath()}` }) }, 60_000)
    child.stdout?.on('data', b => logInstall(`  verify stdout: ${b.toString('utf8').slice(-200)}`))
    child.stderr?.on('data', b => { stderr += b.toString('utf8') })
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: `校验失败: ${e.message}` }) })
    child.on('close', code => {
      clearTimeout(timer)
      logInstall(`  verify exit code=${code} elapsed=${Date.now() - startedAt}ms stderr=${stderr.slice(-300) || '(empty)'}\n`)
      if (code === 0) resolve({ ok: true })
      else resolve({ ok: false, error: `内置运行时无法 import aimux (code=${code}) · 日志: ${aimuxLogPath()}` })
    })
  })
}

export async function ensureFromBundle(onProgress?: (p: InstallProgress) => void): Promise<{ ok: boolean; error?: string; launcher?: AimuxLauncher }> {
  if (bundleReady()) { logInstall(`bundle fast-path: python-bundle already ready\n`); return { ok: true, launcher: { kind: 'module', python: bundlePython() } } }
  const arch = bundleArch()
  if (!arch) return { ok: false, error: `当前平台无内置运行时 (platform=${process.platform} arch=${process.arch})` }
  logInstall(`bundle install begin: arch=${arch} platform=${process.platform} home=${mobiusHome()}\n`)
  onProgress?.({ phase: 'install', detail: `下载内置运行时 (${arch})…` })
  const dl = await downloadBundle(arch, onProgress)
  if (!dl.ok || !dl.zipPath) return { ok: false, error: dl.error }
  onProgress?.({ phase: 'install', detail: '解压内置运行时…' })
  const ex = await extractBundle(dl.zipPath, onProgress)
  try { await fs.unlink(dl.zipPath) } catch {}
  if (!ex.ok) return { ok: false, error: ex.error }
  const v = await verifyBundle(onProgress)
  if (!v.ok) return { ok: false, error: v.error ?? '内置运行时解压后仍无法 import aimux' }
  logInstall(`bundle install OK\n`)
  return { ok: true, launcher: { kind: 'module', python: bundlePython() } }
}

/** 按 launcher 把 aimux 参数变成实际 spawn。 */
export function spawnLauncher(launcher: AimuxLauncher, args: string[]): ChildProcess {
  return launcher.kind === 'exe'
    ? spawn(launcher.path, args, { windowsHide: true })
    : spawn(launcher.python, ['-m', 'aimux', ...args], { windowsHide: true })
}

/** test-only 导出: 暴露内部 downloadBundle 以便单测 mock fetch 验证流式下载+进度。 */
export const downloadBundleForTest = downloadBundle

export async function ensureAimux(onProgress?: (p: InstallProgress) => void): Promise<{ ok: boolean; error?: string; launcher?: AimuxLauncher }> {
  // Fast-path：venv 里已有 aimux 可执行 → 直接用。
  if (existsSync(aimuxExe()) && existsSync(venvPython())) { logInstall(`ensureAimux fast-path: venv aimux exe present\n`); onProgress?.({ phase: 'ready' }); return { ok: true, launcher: { kind: 'exe', path: aimuxExe() } } }
  logInstall(`\n########## ensureAimux install begin ${new Date().toISOString()} platform=${process.platform} arch=${process.arch} home=${mobiusHome()} ##########\n`)
  const py = await pythonForAimux(onProgress)
  logInstall(`  pythonForAimux → ${py ?? '(null: no system python)'}\n`)
  let venvError = '未找到 Python。请先安装 Python 3.10+（或安装 uv 后重试）。'
  if (py) {
    onProgress?.({ phase: 'venv', detail: `创建 Python 虚拟环境（${py}）…` })
    let r = await run(py, ['-m', 'venv', venvDir()])
    if (r.code !== 0 && py === 'py') r = await run(py, ['-3', '-m', 'venv', venvDir()])
    if (r.code === 0) {
      onProgress?.({ phase: 'install', detail: `下载并安装 ${AIMUX_PACKAGE}…` })
      r = await run(venvPython(), ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', AIMUX_PACKAGE], line => {
        if (/downloading|collecting|installing|using cached|%\s*\d|━|─/i.test(line)) onProgress?.({ phase: 'install', detail: line.slice(0, 120) })
      })
      if (r.code === 0 && existsSync(aimuxExe())) { onProgress?.({ phase: 'ready' }); return { ok: true, launcher: { kind: 'exe', path: aimuxExe() } } }
      venvError = r.code === 0 ? `aimux 可执行未生成: ${aimuxExe()}` : `pip install 失败: ${r.stderr || r.stdout}`
    } else {
      venvError = `venv 创建失败: ${r.stderr || r.stdout}`
    }
  }
  // ── Plan B 兜底：本地 python/venv 不可用 → 下载内置 python+aimux 运行时 ──
  logInstall(`  venv path failed (${venvError || ''}) → falling back to bundle\n`)
  onProgress?.({ phase: 'install', detail: '本地 Python 不可用，改用内置运行时…' })
  const bundle = await ensureFromBundle(onProgress)
  if (bundle.ok && bundle.launcher) { onProgress?.({ phase: 'ready' }); return { ok: true, launcher: bundle.launcher } }
  logInstall(`########## ensureAimux FAILED: ${venvError}；内置运行时也失败: ${bundle.error} ##########\n`)
  return { ok: false, error: `${venvError}；内置运行时也失败: ${bundle.error}` }
}

export function tuiAimuxIdentifier(hostname = os.hostname(), cwd = process.cwd()): string {
  const host = hostname.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  // One machine may run several Mobius TUIs for different projects.  A
  // hostname-only identifier makes every reverse client register with the
  // same name and --replace continuously evicts its siblings ("client
  // replaced").  The normalized cwd hash is stable across restarts/resume but
  // unique for the common multi-project case.
  const workspace = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 10)
  return `tui-${host || 'pc'}-${workspace}`
}

/**
 * Build the reverse-connect command in one place. On Windows the bridge shells
 * must run headless or every remote command flashes a console and steals
 * keyboard focus from the TUI — but *which* flag asks for that depends on the
 * installed aimux: `--silent-shell` landed in 0.1.18, the no-console
 * `--slient-v2`/`--silent-v2` only in 0.1.22+. PyPI and cached bundles in the
 * wild are often older, and hard-coding any one spelling makes Click reject the
 * whole command ("No such option: --slient-v2") and the supervisor crash-loop.
 * So the caller probes `reverse connect --help` once (see probeReverseConnectHelp
 * + pickSilentFlag) and passes the flag aimux actually advertises; when nothing
 * is supported we send nothing rather than crash.
 */
export function reverseConnectArgs(
  server: string,
  identifier: string,
  token: string,
  platform: NodeJS.Platform = process.platform,
  silentFlag: string | null = null,
): string[] {
  return [
    'reverse', 'connect', `${server.replace(/\/$/, '')}/aimux_bridge`,
    '--identifier', identifier,
    '--token', token,
    '--replace',
    ...(platform === 'win32' && silentFlag ? [silentFlag] : []),
  ]
}

/**
 * Capture `aimux reverse connect --help` so we can see which console-hiding
 * flags this particular build advertises. Returns '' on any failure (the
 * caller then sends no silent flag and stays alive instead of crash-looping).
 */
export async function probeReverseConnectHelp(launcher: AimuxLauncher): Promise<string> {
  const base = launcher.kind === 'exe'
    ? { cmd: launcher.path, args: ['reverse', 'connect', '--help'] }
    : { cmd: launcher.python, args: ['-m', 'aimux', 'reverse', 'connect', '--help'] }
  try {
    const r = await run(base.cmd, base.args)
    return `${r.stdout}\n${r.stderr}`
  } catch {
    return ''
  }
}

/**
 * Pick the strongest console-hiding flag aimux advertised for Windows. Prefers
 * the correctly-spelled --silent-v2 (future-proof if the historical --slient-v2
 * typo alias is ever dropped), then the --slient-v2 alias, then --silent-shell.
 * Returns null off-Windows or when the installed aimux supports none.
 */
export function pickSilentFlag(helpText: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return null
  if (/--silent-v2\b/.test(helpText)) return '--silent-v2'
  if (/--slient-v2\b/.test(helpText)) return '--slient-v2'
  if (/--silent-shell\b/.test(helpText)) return '--silent-shell'
  return null
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
      reverseConnectArgs(server, identifier, token),
      { windowsHide: true },
    )
    this.child = child
    this.startHeartbeat()
    let tail = ''   // 缓存 aimux 最近输出, 进程异常退出时带进状态行, 便于诊断(code=1 不再是黑盒)
    const logWrite = { queue: Promise.resolve() }
    appendAimuxLog(logWrite, `\n===== AIMUX start ${new Date().toISOString()} =====\n`)
    appendAimuxLog(logWrite, `server=${server} identifier=${identifier} platform=${process.platform} arch=${process.arch}\n`)
    const classify = (buf: Buffer) => {
      const text = buf.toString('utf8')
      tail = (tail + text).slice(-4000)
      appendAimuxLog(logWrite, text)
      if (!this.bridgeConnected && /connected|registered|event stream|heartbeat|sse/i.test(text)) {
        onStatus({ state: 'starting', phase: 'heartbeat', detail: 'AIMUX 已启动，等待 bridge 心跳确认…', identifier })
      } else if (/connection (refused|reset|closed|error)|failed to connect|unauthorized|forbidden|token.*invalid/i.test(text)) {
        onStatus({ state: 'failed', phase: 'heartbeat', detail: text.trim().slice(-200), identifier })
      }
    }
    child.stdout?.on('data', classify); child.stderr?.on('data', classify)
    child.on('error', e => {
      appendAimuxLog(logWrite, `\n[spawn error] ${e.stack || e.message}\n`)
      onStatus({ state: 'failed', phase: 'retrying', detail: `AIMUX 启动失败: ${e.message} · 日志: ${aimuxLogPath()}`, identifier })
    })
    child.on('exit', code => {
      if (this.child !== child) return
      this.child = null
      this.stopHeartbeat()
      if (this.stopping) { onStatus({ state: 'stopped', phase: 'idle', detail: 'AIMUX 已停止', identifier }); return }
      appendAimuxLog(logWrite, `\n===== AIMUX exit code=${code} ${new Date().toISOString()} =====\n`)
      const reason = code !== 0 && tail.trim()
        ? `AIMUX 进程退出（code=${code}）: ${tail.trim().split(/[\r\n]+/).filter(Boolean).slice(-3).join(' ⏎ ').slice(-220)} · 日志: ${aimuxLogPath()}`
        : `AIMUX 进程退出（code=${code}） · 日志: ${aimuxLogPath()}`
      this.scheduleReconnect(reason)
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
// Resolved Windows console-hiding flag for the installed aimux (undefined =
// not probed yet this process). Cached so reconnects reuse it without re-running
// `aimux reverse connect --help`. See reverseConnectArgs for why this is probed.
let cachedSilentFlag: string | null | undefined = undefined

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
    if (!ready.ok || !ready.launcher) { logInstall(`startAimuxConnection giving up: ${ready.error}\n`); onStatus({ state: 'failed', phase: 'idle', detail: `${ready.error} · 日志: ${aimuxLogPath()}` }); return }
    const identifier = tuiAimuxIdentifier()
    const launcher = ready.launcher
    // Windows only: ask the installed aimux which console-hiding flag it accepts
    // before spawning, so a version mismatch (older PyPI/bundle aimux without
    // --slient-v2) can't crash-loop the supervisor with "No such option".
    if (WIN && cachedSilentFlag === undefined) {
      const help = await probeReverseConnectHelp(launcher)
      cachedSilentFlag = pickSilentFlag(help)
      logInstall(`reverse-connect silent flag probe → ${cachedSilentFlag ?? '(none supported; sending no flag)'}\n`)
    }
    const silentFlag = cachedSilentFlag
    supervisor = new AimuxSupervisor({
      server: opts.server, token: opts.token, identifier, onStatus,
      spawnProcess: () => spawnLauncher(launcher, reverseConnectArgs(opts.server, identifier, opts.token, process.platform, silentFlag)),
    })
    supervisor.start()
  })().finally(() => { installing = null })
  await installing
}

export async function stopAimuxConnection(): Promise<void> {
  const current = supervisor; supervisor = null
  await current?.stop()
}
