/**
 * AIMUX bootstrap for the terminal client.
 *
 * This mirrors the Electron shell: create a user-owned Python venv, install
 * aimux on first use, then keep `aimux reverse connect` attached to the
 * currently authenticated Mobius server.  Nothing is started before login.
 */
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs, existsSync, createWriteStream, mkdirSync, openSync, closeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import extract from 'extract-zip'
import lockfile from 'proper-lockfile'
import { mobiusHome } from './config.js'

export type AimuxState = 'starting' | 'connected' | 'failed' | 'stopped' | 'disabled'
export type AimuxPhase = 'idle' | 'python' | 'venv' | 'install' | 'connecting' | 'heartbeat' | 'retrying' | 'connected'
export interface AimuxStatus {
  state: AimuxState
  phase?: AimuxPhase
  detail?: string
  /** Runtime package version when known; falls back to the bundled version. */
  version?: string
  identifier?: string
  attempt?: number
}
export interface InstallProgress { phase: 'python' | 'venv' | 'install' | 'ready'; detail?: string }

/** aimux 的调用方式：venv 直接执行，或用内置 python 跑 `-m aimux`（Plan B 兜底）。 */
export type AimuxLauncher =
  | { kind: 'exe'; path: string }
  | { kind: 'module'; python: string }

const AIMUX_TARGET_VERSION = '0.1.37'
const AIMUX_PACKAGE = `aimux==${AIMUX_TARGET_VERSION}`
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
const BUNDLE_VER = '7'
const BUNDLE_AIMUX_VERSION = AIMUX_TARGET_VERSION
/** Version expected from the installed or bundled AIMUX runtime. */
export const AIMUX_VERSION = BUNDLE_AIMUX_VERSION
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

/** 以守护进程形态 spawn aimux：detached(父变 init)+ stdio 重定向到 aimux.log, 不随 TUI 退出而亡。 */
function spawnDetachedDaemon(launcher: AimuxLauncher, args: string[]): ChildProcess {
  let logFd = -1
  try { mkdirSync(mobiusHome(), { recursive: true }); logFd = openSync(aimuxLogPath(), 'a') } catch { logFd = -1 }
  const stdio: StdioOptions = logFd >= 0 ? ['ignore', logFd, logFd] : 'ignore'
  const child = launcher.kind === 'exe'
    ? spawn(launcher.path, args, { detached: true, stdio, windowsHide: true })
    : spawn(launcher.python, ['-m', 'aimux', ...args], { detached: true, stdio, windowsHide: true })
  if (logFd >= 0) { try { closeSync(logFd) } catch { /* ignore */ } }
  child.unref?.()
  return child
}

/** test-only 导出: 暴露内部 downloadBundle 以便单测 mock fetch 验证流式下载+进度。 */
export const downloadBundleForTest = downloadBundle

function venvReady(): boolean {
  if (!existsSync(aimuxExe()) || !existsSync(venvPython())) return false
  try {
    return spawnSync(
      venvPython(),
      ['-c', `import aimux; assert aimux.__version__ == '${AIMUX_TARGET_VERSION}'`],
      { stdio: 'ignore', windowsHide: true },
    ).status === 0
  } catch {
    return false
  }
}

export async function ensureAimux(onProgress?: (p: InstallProgress) => void): Promise<{ ok: boolean; error?: string; launcher?: AimuxLauncher }> {
  // Fast-path：venv 里已有 aimux 可执行 → 直接用。
  if (venvReady()) { logInstall(`ensureAimux fast-path: venv aimux ${AIMUX_TARGET_VERSION} present\n`); onProgress?.({ phase: 'ready' }); return { ok: true, launcher: { kind: 'exe', path: aimuxExe() } } }
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

/** Effective OS user (not `$USER`, which sudo/containers can pollute). */
function currentUsername(): string {
  try { return os.userInfo().username } catch { return process.env.USER || process.env.USERNAME || 'user' }
}

/** Per (username, workspace) hash — reused by the identifier and the lease/lock filenames. */
export function aimuxWorkspaceHash(username = currentUsername(), cwd = process.cwd()): string {
  return createHash('sha256').update(`${username}:${path.resolve(cwd)}`).digest('hex').slice(0, 10)
}

export function tuiAimuxIdentifier(hostname = os.hostname(), cwd = process.cwd(), username = currentUsername()): string {
  const host = hostname.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  // One machine may run several Mobius TUIs for different projects (and for
  // different users). A hostname-only identifier makes every reverse client
  // register with the same name and --replace continuously evicts its siblings.
  // The (username, cwd) hash is stable across restarts/resume but unique per
  // user and per workspace, so separate projects/users never collide.
  return `tui-${host || 'pc'}-${aimuxWorkspaceHash(username, cwd)}`
}

// ── shared-daemon coordination files (one reverse connect per user+workspace) ──
// The reverse connect is a detached daemon shared by every TUI in the same
// user+workspace. Two files coordinate it, both under ~/.mobius/aimux-runtime/:
//   <hash>.lease — mtime = "some TUI renewed me recently" (liveness heartbeat);
//                  content = the daemon's pid (for dead-process detection).
//   <hash>.lock  — short-lived spawn lock (proper-lockfile), so exactly one TUI
//                  spawns at a time and a crashed spawner never wedges the lock.
const LEASE_RENEW_MS = 5_000
const BRIDGE_FAILURE_LIMIT = 3
const LEASE_STALE_MS = 15_000
const STOP_WAIT_MS = 2_000

const aimuxRuntimeDir = () => path.join(mobiusHome(), 'aimux-runtime')
const leasePath = (hash: string) => path.join(aimuxRuntimeDir(), `${hash}.lease`)
const lockPath = (hash: string) => path.join(aimuxRuntimeDir(), `${hash}.lock`)

async function ensureRuntimeDir(): Promise<void> {
  await fs.mkdir(aimuxRuntimeDir(), { recursive: true, mode: 0o700 })
}

async function writeLease(hash: string, pid: number, owner: string, metadata: Partial<LeaseRecord> = {}): Promise<void> {
  await ensureRuntimeDir()
  await fs.writeFile(leasePath(hash), JSON.stringify({ pid, owners: [owner], ...metadata }), { mode: 0o600 })
}

interface LeaseRecord { pid: number; owners: string[]; identifier?: string; nonce?: string; startedAt?: number }
async function readLease(hash: string): Promise<LeaseRecord | null> {
  try {
    const raw = await fs.readFile(leasePath(hash), 'utf8')
    try {
      const value = JSON.parse(raw) as Partial<LeaseRecord>
      if (Number.isInteger(value.pid) && value.pid! > 0) return { ...value, pid: value.pid!, owners: Array.isArray(value.owners) ? value.owners.filter(Boolean) : [] }
    } catch {
      const pid = Number.parseInt(raw, 10)
      if (Number.isInteger(pid) && pid > 0) return { pid, owners: [] }
    }
  } catch {}
  return null
}

async function readLeasePid(hash: string): Promise<number | null> {
  return (await readLease(hash))?.pid ?? null
}

async function leaseFresh(hash: string): Promise<boolean> {
  try { return Date.now() - (await fs.stat(leasePath(hash))).mtimeMs <= LEASE_STALE_MS } catch { return false }
}

async function addLeaseOwner(hash: string, owner: string): Promise<void> {
  const lease = await readLease(hash)
  if (!lease) return
  if (!lease.owners.includes(owner)) lease.owners.push(owner)
  await fs.writeFile(leasePath(hash), JSON.stringify(lease), { mode: 0o600 })
}

async function releaseLease(hash: string, owner: string): Promise<{ pid: number | null; last: boolean }> {
  const lease = await readLease(hash)
  if (!lease) return { pid: null, last: true }
  lease.owners = lease.owners.filter(item => item !== owner)
  if (lease.owners.length > 0) {
    await fs.writeFile(leasePath(hash), JSON.stringify(lease), { mode: 0o600 })
    return { pid: lease.pid, last: false }
  }
  await fs.rm(leasePath(hash), { force: true }).catch(() => {})
  return { pid: lease.pid, last: true }
}

async function withLeaseLock<T>(hash: string, action: () => Promise<T>): Promise<T> {
  await ensureRuntimeDir()
  const release = await lockfile.lock(lockPath(hash), {
    stale: 30_000,
    retries: { retries: 30, factor: 1.2, minTimeout: 100, maxTimeout: 1000 },
  }).catch(() => null)
  try { return await action() } finally { if (release) await release() }
}

/** Bump the lease mtime so the daemon sees "someone still wants me". */
async function touchLease(hash: string): Promise<void> {
  await ensureRuntimeDir()
  const now = new Date()
  try { await fs.utimes(leasePath(hash), now, now) } catch { /* no lease yet (not spawned) */ }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitForExit(pid: number, timeoutMs = STOP_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (pidAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  return !pidAlive(pid)
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

/** Result of a bridge heartbeat: is the stream up, and did the JWT just get rejected? */
export interface AimuxBridgeProbe { connected: boolean; authError: boolean }

/** Heartbeat probe that distinguishes "stream down" from "JWT expired" (401/403). */
export async function probeAimuxBridge(
  server: string,
  token: string,
  identifier: string,
  timeoutMs = 4_000,
): Promise<AimuxBridgeProbe> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(
      `${server.replace(/\/$/, '')}/aimux_bridge/api/remotes/${encodeURIComponent(identifier)}/connection`,
      { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal },
    )
    if (response.status === 401 || response.status === 403) return { connected: false, authError: true }
    if (!response.ok) return { connected: false, authError: false }
    const data: any = await response.json().catch(() => ({}))
    return { connected: data?.identifier === identifier && data?.event_stream_connected === true, authError: false }
  } catch {
    return { connected: false, authError: false }
  } finally {
    clearTimeout(timeout)
  }
}

export async function probeAimuxBridgeConnection(
  server: string,
  token: string,
  identifier: string,
  timeoutMs = 4_000,
): Promise<boolean> {
  return (await probeAimuxBridge(server, token, identifier, timeoutMs)).connected
}

interface SupervisorOptions {
  server: string
  token: string
  identifier: string
  onStatus: (s: AimuxStatus) => void
  /** Re-authenticate after AIMUX reports an expired/invalid bridge JWT. */
  refreshToken?: () => Promise<string | null>
  heartbeatIntervalMs?: number
  retryBaseMs?: number
  probeConnection?: () => Promise<boolean | AimuxBridgeProbe>
  spawnProcess?: (token: string) => ChildProcess
}

/**
 * Coordinates the shared `aimux reverse connect` daemon for one user+workspace.
 *
 * The daemon is spawned detached (survives this TUI) and shared by every TUI in
 * the same user+workspace. Two files under ~/.mobius/aimux-runtime/ coordinate
 * it: a lease (mtime = "a TUI renewed me recently", content = daemon pid) and a
 * short-lived spawn lock (proper-lockfile). A TUI only spawns when no live daemon
 * is found; otherwise it adopts and keeps renewing the lease. The daemon is never
 * killed on TUI exit — it is torn down when the lease expires (handled by aimux).
 */
export class AimuxSupervisor {
  private stopping = false
  private refreshingToken = false
  private reconnectAttempt = 0
  private leaseTimer: ReturnType<typeof setTimeout> | null = null
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private bridgeFailures = 0
  private readonly nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  private readonly owner = `${process.pid}-${Math.random().toString(36).slice(2)}`
  private opts: SupervisorOptions
  private hash: string
  constructor(opts: SupervisorOptions) { this.opts = opts; this.hash = aimuxWorkspaceHash() }

  async start(): Promise<void> {
    this.stopping = false
    await this.ensureDaemon()
    this.startLeaseRenewal()
    this.scheduleProbe()
  }

  /** Adopt an existing daemon if one is alive; otherwise spawn (under the lock). */
  private async ensureDaemon(): Promise<void> {
    await withLeaseLock(this.hash, async () => {
      if (this.stopping) return
      const current = await readLease(this.hash)
      const pid = current?.pid ?? null
      if (pid !== null && pidAlive(pid) && await leaseFresh(this.hash)) {
        const raw = await (this.opts.probeConnection?.() ?? probeAimuxBridge(this.opts.server, this.opts.token, this.opts.identifier, 1500))
        const connected = typeof raw === 'boolean' ? raw : raw.connected
        if (connected) {
          if (!current!.owners.includes(this.owner)) current!.owners.push(this.owner)
          await fs.writeFile(leasePath(this.hash), JSON.stringify(current), { mode: 0o600 })
          this.opts.onStatus({ state: 'connected', phase: 'connected', detail: `AIMUX bridge 已连接 · ${this.opts.identifier}`, identifier: this.opts.identifier })
          return
        }
      }
      if (pid !== null && pidAlive(pid)) { try { process.kill(pid, 'SIGTERM') } catch {} ; await waitForExit(pid) }
      await fs.rm(leasePath(this.hash), { force: true }).catch(() => {})
      await this.spawnDaemonLocked()
    })
  }

  /** Spawn the detached daemon exactly once, serialized by the path lock. */
  private async spawnDaemon(): Promise<void> {
    if (this.stopping) return
    await withLeaseLock(this.hash, async () => {
      await this.spawnDaemonLocked()
    })
  }

  private async spawnDaemonLocked(): Promise<void> {
      if (this.stopping) return
      // Re-check under the lock — another TUI may have spawned while we waited.
      const pid = await readLeasePid(this.hash)
      if (pid !== null && pidAlive(pid)) { await addLeaseOwner(this.hash, this.owner); return }
      const { server, token, identifier, onStatus } = this.opts
      onStatus({ state: 'starting', phase: 'connecting', detail: '正在启动 AIMUX 守护进程…', identifier, attempt: this.reconnectAttempt })
      const child = this.opts.spawnProcess?.(token) ?? spawnDetachedDaemon({ kind: 'exe', path: aimuxExe() }, reverseConnectArgs(server, identifier, token))
      child.on('error', (e: Error) => { appendAimuxLog(installLogQueue, `\n[aimux spawn error] ${e.stack || e.message}\n`) })
      await writeLease(this.hash, child.pid ?? 0, this.owner, { identifier, nonce: this.nonce, startedAt: Date.now() })
      child.unref?.()
      this.reconnectAttempt = 0
  }

  /** Renew the lease every 5s while this TUI is alive. */
  private startLeaseRenewal(): void {
    const tick = () => {
      if (this.stopping) return
      void touchLease(this.hash).catch(() => {})
      this.leaseTimer = setTimeout(tick, LEASE_RENEW_MS)
    }
    void touchLease(this.hash).catch(() => {})
    this.leaseTimer = setTimeout(tick, LEASE_RENEW_MS)
  }

  private scheduleProbe(): void {
    if (this.stopping) return
    this.probeTimer = setTimeout(() => void this.checkDaemon(), this.opts.heartbeatIntervalMs ?? 5_000)
  }

  /** Probe the bridge; refresh on auth error, respawn only when the daemon died. */
  private async checkDaemon(): Promise<void> {
    if (this.stopping) return
    const raw = await (this.opts.probeConnection?.() ?? probeAimuxBridge(this.opts.server, this.opts.token, this.opts.identifier))
    const probe: AimuxBridgeProbe = typeof raw === 'boolean' ? { connected: raw, authError: false } : raw
    if (this.stopping) return
    if (probe.authError) {
      await this.refreshCredentials('JWT 已过期')
    } else if (probe.connected) {
      this.reconnectAttempt = 0
      this.opts.onStatus({ state: 'connected', phase: 'connected', detail: `心跳正常 · ${this.opts.identifier}`, identifier: this.opts.identifier })
      this.bridgeFailures = 0
    } else {
      this.bridgeFailures += 1
      const pid = await readLeasePid(this.hash)
      if (pid === null || !pidAlive(pid) || this.bridgeFailures >= BRIDGE_FAILURE_LIMIT) {
        this.reconnectAttempt += 1
        this.opts.onStatus({ state: 'failed', phase: 'retrying', detail: `AIMUX bridge 无响应，重启连接中（第 ${this.reconnectAttempt} 次）…`, identifier: this.opts.identifier, attempt: this.reconnectAttempt })
        if (pid !== null && pidAlive(pid)) { try { process.kill(pid, 'SIGTERM') } catch {} }
        await fs.rm(leasePath(this.hash), { force: true }).catch(() => {})
        this.bridgeFailures = 0
        await this.spawnDaemon()
      } else {
        // Daemon alive but stream down → transient; its own reconnect handles it.
        this.opts.onStatus({ state: 'starting', phase: 'heartbeat', detail: '等待 bridge 心跳确认…', identifier: this.opts.identifier })
      }
    }
    this.scheduleProbe()
  }

  private async refreshCredentials(reason: string): Promise<void> {
    if (this.stopping || this.refreshingToken) return
    const refreshToken = this.opts.refreshToken
    if (!refreshToken) return
    this.refreshingToken = true
    this.opts.onStatus({ state: 'starting', phase: 'retrying', detail: 'AIMUX 登录凭据已过期，正在刷新 JWT…', identifier: this.opts.identifier })
    try {
      const token = await refreshToken()
      if (this.stopping) return
      if (!token) throw new Error('登录接口未返回新 JWT')
      this.opts.token = token
      this.reconnectAttempt = 0
      appendAimuxLog(installLogQueue, `AIMUX JWT refreshed at ${new Date().toISOString()}; restarting bridge client\n`)
      this.opts.onStatus({ state: 'starting', phase: 'connecting', detail: 'JWT 已刷新，正在重新连接 AIMUX bridge…', identifier: this.opts.identifier })
      await this.spawnDaemon()
    } catch {
      // refresh failed → the probe loop will retry on the next tick
    } finally {
      this.refreshingToken = false
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = null
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.probeTimer = null
    const release = await withLeaseLock(this.hash, () => releaseLease(this.hash, this.owner))
    if (release.last && release.pid !== null && pidAlive(release.pid)) {
      try { process.kill(release.pid, 'SIGTERM') } catch {}
    }
    this.opts.onStatus({ state: 'stopped', phase: 'idle', detail: release.last ? 'AIMUX 已停止' : 'AIMUX 已停止（其他 TUI 仍在使用）', identifier: this.opts.identifier })
  }
}

let supervisor: AimuxSupervisor | null = null
let installing: Promise<void> | null = null
// Resolved Windows console-hiding flag for the installed aimux (undefined =
// not probed yet this process). Cached so reconnects reuse it without re-running
// `aimux reverse connect --help`. See reverseConnectArgs for why this is probed.
let cachedSilentFlag: string | null | undefined = undefined

export async function startAimuxConnection(opts: {
  server: string
  token: string
  onStatus?: (s: AimuxStatus) => void
  refreshToken?: () => Promise<string | null>
}): Promise<void> {
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
      server: opts.server, token: opts.token, identifier, onStatus, refreshToken: opts.refreshToken,
      spawnProcess: token => spawnDetachedDaemon(launcher, reverseConnectArgs(opts.server, identifier, token, process.platform, silentFlag)),
    })
    await supervisor.start()
  })().finally(() => { installing = null })
  await installing
}

export async function stopAimuxConnection(): Promise<void> {
  const current = supervisor; supervisor = null
  await current?.stop()
}
