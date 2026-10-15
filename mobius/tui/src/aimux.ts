/**
 * AIMUX bootstrap for the terminal client.
 *
 * This mirrors the Electron shell: create a user-owned Python venv, install
 * aimux on first use, then keep `aimux reverse connect` attached to the
 * currently authenticated Mobius server.  Nothing is started before login.
 */
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs, existsSync, createWriteStream, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import extract from 'extract-zip'
import { mobiusHome } from './config.js'
import { windowsElevated } from './lib/windows-admin.js'

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

/**
 * 兜底 pin：只在读不到服务端版本时用（老 broker / 网络不通），**不是**"最低可用版本"。
 * 正常情况下连接时会读服务端 broker 的 aimux 版本，本地跟它对齐（升级、降级都一样）。
 */
const AIMUX_TARGET_VERSION = '0.3.72'
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
/** Plan B 内置运行时包版本；每次发版跟 aimux pin 一起 +1，测试也从这里取。 */
export const BUNDLE_VER = '18'
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

/**
 * 内置运行时校验脚本。`expected` 非 null 时额外断言 aimux 版本——版本对不上就重下整包
 * （老行为，pin 与包版本一致时用）。传 null 表示"只要求能 import"：服务端要求另一个
 * 版本时靠 pip 就地换，而不是重下几百 MB 的包。
 */
export function bundleHealthCheckCode(
  platform: NodeJS.Platform = process.platform,
  expected: string | null = BUNDLE_AIMUX_VERSION,
): string {
  const imports = platform === 'win32'
    ? 'import aimux, aimux.bridge_client, win32_setctime'
    : 'import aimux, aimux.bridge_client'
  return expected ? `${imports}; assert aimux.__version__ == '${expected}'` : imports
}

function bundleReady(expected: string | null = BUNDLE_AIMUX_VERSION): boolean {
  return existsSync(bundlePython()) && spawnSync(
    bundlePython(),
    ['-c', bundleHealthCheckCode(process.platform, expected)],
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
async function verifyBundle(onProgress?: (p: InstallProgress) => void, expected: string | null = BUNDLE_AIMUX_VERSION): Promise<{ ok: boolean; error?: string }> {
  onProgress?.({ phase: 'install', detail: '校验内置运行时（首次 import aimux，可能耗时）…' })
  const py = bundlePython()
  logInstall(`  verify start: ${py} -c "import aimux…" (expect ${expected ? `v${expected}` : 'any version'})\n`)
  const startedAt = Date.now()
  return new Promise(resolve => {
    let child: ChildProcess
    try { child = spawn(py, ['-c', bundleHealthCheckCode(process.platform, expected)], { windowsHide: true }) }
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

export async function ensureFromBundle(onProgress?: (p: InstallProgress) => void, expected: string | null = BUNDLE_AIMUX_VERSION): Promise<{ ok: boolean; error?: string; launcher?: AimuxLauncher }> {
  if (bundleReady(expected)) { logInstall(`bundle fast-path: python-bundle already ready\n`); return { ok: true, launcher: { kind: 'module', python: bundlePython() } } }
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
  const v = await verifyBundle(onProgress, expected)
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

/** 某个 python 环境里的 aimux 版本（跑不起来时 null）。 */
function pythonAimuxVersion(python: string): string | null {
  try {
    const r = spawnSync(python, ['-c', 'import aimux; print(aimux.__version__)'], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) return null
    const v = (r.stdout ?? '').trim().split(/\s+/).pop()
    return v || null
  } catch {
    return null
  }
}

/** venv 里现成的 aimux 版本（跑不起来时 null）。 */
function installedAimuxVersion(): string | null {
  if (!existsSync(aimuxExe()) || !existsSync(venvPython())) return null
  return pythonAimuxVersion(venvPython())
}

/**
 * 连接前要装的版本：**服务端 broker 跑的那个版本**。
 *
 * 服务端版本读不到（老 broker 没有 /api/health 的 version 字段、或网络不通）时退回 pin——
 * 宁可不动，也不要凭猜测给用户换一个版本。
 */
export function alignTarget(serverVersion: string | null | undefined, pin = AIMUX_TARGET_VERSION): string {
  const v = typeof serverVersion === 'string' ? serverVersion.trim() : ''
  return v || pin
}

/**
 * 读服务端 broker 的 aimux 版本（`GET <server>/aimux_bridge/api/health`）。
 * 经 mobius 代理转发：这里带的 token 是登录 JWT，代理会换成 broker token。
 * 任何失败都返回 null —— 读不到就按"未知"处理，绝不猜。
 */
export async function fetchServerAimuxVersion(server: string, token: string, timeoutMs = 8_000): Promise<string | null> {
  const url = `${server.replace(/\/$/, '')}/aimux_bridge/api/health`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
    if (!res.ok) { logInstall(`server aimux version probe: HTTP ${res.status} (${url})\n`); return null }
    const body: any = await res.json().catch(() => null)
    const v = typeof body?.version === 'string' ? body.version.trim() : ''
    if (!v) logInstall(`server aimux version probe: no version field (${url})\n`)
    return v || null
  } catch (e: any) {
    logInstall(`server aimux version probe failed (${url}): ${e?.name === 'AbortError' ? 'timeout' : e?.message ?? e}\n`)
    return null
  } finally { clearTimeout(timer) }
}

/**
 * 把某个 python 环境里的 aimux 换成指定版本。pip 装 `aimux==X` 自己会卸掉当前版本，
 * 所以**升级和降级是同一条命令**，不需要先卸载、更不需要重建 venv。
 */
async function swapAimuxVersion(python: string, target: string, current: string, onProgress?: (p: InstallProgress) => void): Promise<{ ok: boolean; error?: string }> {
  logInstall(`aimux version swap ${current} → ${target} via ${python}\n`)
  onProgress?.({ phase: 'install', detail: `切换 AIMUX ${current} → ${target}…` })
  const r = await run(python, [
    '-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', `aimux==${target}`,
  ], line => {
    if (/downloading|collecting|installing|uninstalling|using cached|%\s*\d|━|─/i.test(line)) onProgress?.({ phase: 'install', detail: line.slice(0, 120) })
  })
  if (r.code !== 0) return { ok: false, error: `pip install 失败: ${(r.stderr || r.stdout).slice(-300)}` }
  const after = pythonAimuxVersion(python)
  if (after !== target) return { ok: false, error: `装完仍是 ${after ?? '(无法读取版本)'}` }
  logInstall(`aimux version swap OK → ${after}\n`)
  return { ok: true }
}

/** ensureAimux 的结果；`versionWarning` = 想对齐但没成，已按现有版本继续。 */
export interface AimuxReady {
  ok: boolean
  error?: string
  launcher?: AimuxLauncher
  /** 实际会用上的版本。 */
  version?: string
  versionWarning?: string
}

/**
 * 保证本地有一个能跑的 aimux，且版本恰好是 `target`。
 *
 * `target` 默认是 pin；连接时上层传的是**服务端 broker 的版本**（见 alignTarget），
 * 所以本地比服务端新也会被换下去——版本不匹配本身就会让 bridge 出各种怪问题。
 * 换版本失败不阻断连接：记一条 `versionWarning`，按现有版本继续。
 */
export async function ensureAimux(onProgress?: (p: InstallProgress) => void, target = AIMUX_TARGET_VERSION): Promise<AimuxReady> {
  // Fast-path：版本正好对上 → 直接用。
  const existing = installedAimuxVersion()
  if (existing === target) {
    logInstall(`ensureAimux fast-path: venv aimux ${existing} == target ${target}\n`)
    onProgress?.({ phase: 'ready' })
    return { ok: true, launcher: { kind: 'exe', path: aimuxExe() }, version: existing }
  }
  // 手上已经有 venv，只是版本不对 → 原地换版本（升级/降级同一条路）。
  if (existing !== null) {
    const swap = await swapAimuxVersion(venvPython(), target, existing, onProgress)
    if (swap.ok) { onProgress?.({ phase: 'ready' }); return { ok: true, launcher: { kind: 'exe', path: aimuxExe() }, version: target } }
    logInstall(`########## ensureAimux version swap failed: ${swap.error}；按现有 ${existing} 继续 ##########\n`)
    onProgress?.({ phase: 'ready' })
    return {
      ok: true, launcher: { kind: 'exe', path: aimuxExe() }, version: existing,
      versionWarning: `AIMUX 版本未对齐：本地 ${existing}／目标 ${target}（${swap.error}）`,
    }
  }
  logInstall(`\n########## ensureAimux install begin ${new Date().toISOString()} platform=${process.platform} arch=${process.arch} home=${mobiusHome()} ##########\n`)
  const pkg = `aimux==${target}`
  const py = await pythonForAimux(onProgress)
  logInstall(`  pythonForAimux → ${py ?? '(null: no system python)'}\n`)
  let venvError = '未找到 Python。请先安装 Python 3.10+（或安装 uv 后重试）。'
  if (py) {
    onProgress?.({ phase: 'venv', detail: `创建 Python 虚拟环境（${py}）…` })
    let r = await run(py, ['-m', 'venv', venvDir()])
    if (r.code !== 0 && py === 'py') r = await run(py, ['-3', '-m', 'venv', venvDir()])
    if (r.code === 0) {
      onProgress?.({ phase: 'install', detail: `下载并安装 ${pkg}…` })
      r = await run(venvPython(), ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', pkg], line => {
        if (/downloading|collecting|installing|uninstalling|using cached|%\s*\d|━|─/i.test(line)) onProgress?.({ phase: 'install', detail: line.slice(0, 120) })
      })
      if (r.code === 0 && existsSync(aimuxExe())) { onProgress?.({ phase: 'ready' }); return { ok: true, launcher: { kind: 'exe', path: aimuxExe() }, version: pythonAimuxVersion(venvPython()) ?? target } }
      venvError = r.code === 0 ? `aimux 可执行未生成: ${aimuxExe()}` : `pip install 失败: ${r.stderr || r.stdout}`
    } else {
      venvError = `venv 创建失败: ${r.stderr || r.stdout}`
    }
  }
  // ── Plan B 兜底：本地 python/venv 不可用 → 下载内置 python+aimux 运行时 ──
  logInstall(`  venv path failed (${venvError || ''}) → falling back to bundle\n`)
  onProgress?.({ phase: 'install', detail: '本地 Python 不可用，改用内置运行时…' })
  // 目标就是 pin 时仍按老规矩校验包内版本（版本不对就重下整包）；目标是服务端版本时
  // 只要求包能 import，随后用 pip 就地换成目标版本——否则每次都得重下整包还会校验失败。
  const expected = target === AIMUX_TARGET_VERSION ? BUNDLE_AIMUX_VERSION : null
  const bundle = await ensureFromBundle(onProgress, expected)
  if (bundle.ok && bundle.launcher) {
    const py2 = bundle.launcher.kind === 'module' ? bundle.launcher.python : null
    const bundled = py2 ? pythonAimuxVersion(py2) : null
    if (py2 && bundled !== null && bundled !== target) {
      const swap = await swapAimuxVersion(py2, target, bundled, onProgress)
      if (!swap.ok) {
        logInstall(`########## bundle version swap failed: ${swap.error}；按现有 ${bundled} 继续 ##########\n`)
        onProgress?.({ phase: 'ready' })
        return { ok: true, launcher: bundle.launcher, version: bundled, versionWarning: `内置运行时 AIMUX 未对齐：本地 ${bundled}／目标 ${target}（${swap.error}）` }
      }
    }
    onProgress?.({ phase: 'ready' })
    return { ok: true, launcher: bundle.launcher, version: py2 ? pythonAimuxVersion(py2) ?? undefined : undefined }
  }
  logInstall(`########## ensureAimux FAILED: ${venvError}；内置运行时也失败: ${bundle.error} ##########\n`)
  return { ok: false, error: `${venvError}；内置运行时也失败: ${bundle.error}` }
}

/** Effective OS user (not `$USER`, which sudo/containers can pollute). */
function currentUsername(): string {
  try { return os.userInfo().username } catch { return process.env.USER || process.env.USERNAME || 'user' }
}

/** Per (username, workspace) hash — reused by the identifier and runtime JSON path. */
export function aimuxWorkspaceHash(username = currentUsername(), cwd = process.cwd()): string {
  return createHash('sha256').update(`${username}:${path.resolve(cwd)}`).digest('hex').slice(0, 10)
}

// ── GUI (computer use) authorization ─────────────────────────────────────
// Machine-level choice made in the first-run wizard.
//
// The daemon's privilege is decided by this TUI's own privilege, once, and is
// never negotiated at start time. A TUI must never ask Windows for rights it
// does not already have: aimux satisfies such a request with
// ShellExecuteW("runas"), which is synchronous and raises its consent prompt on
// the secure desktop — a prompt nobody answers blocks the daemon *before* it
// writes any state or starts its watchdog, leaving an immortal process the
// supervisor can neither see nor kill. So:
//
//   unelevated TUI  --enable-gui --gui-no-elevate   (nothing is ever requested)
//   elevated TUI    --enable-gui                    (aimux sees it is already
//                                                    administrator and stays put)
//
// That is also why the modes are exclusive: a child inherits the parent's token,
// so an elevated TUI cannot produce a low-privilege daemon, and an unelevated
// one cannot produce an elevated daemon without prompting.
//
//   off        no GUI helper at all; registers as tui-<host>-<hash>
//   no-elevate GUI helper, unelevated: Windows UIPI then blocks input into
//              elevated windows
//   elevate    GUI helper that can also drive administrator windows
// Either authorized mode registers as gui-<host>-<hash>.
export type GuiMode = 'off' | 'no-elevate' | 'elevate'

/** Whether a mode can be offered here, and if not, what the user must change. */
export interface GuiModeAvailability { available: boolean; reason?: string }

const ADMIN_REASON = '请用管理员模式打开 Mobius TUI'
const NON_ADMIN_REASON = '请用非管理员模式打开 Mobius TUI'

/**
 * Which GUI modes this machine can provide. Availability follows from the
 * exclusive rule above: exactly one of the two authorized modes is offerable,
 * and which one is decided by the TUI's own token.
 */
export function guiModeAvailability(
  elevated: boolean,
  platform: NodeJS.Platform = process.platform,
): Record<GuiMode, GuiModeAvailability> {
  return {
    off: { available: true },
    'no-elevate': platform === 'win32' && elevated
      ? { available: false, reason: NON_ADMIN_REASON }
      : { available: true },
    // Off Windows there is no elevation to speak of, so the mode is always fine.
    elevate: platform !== 'win32' || elevated ? { available: true } : { available: false, reason: ADMIN_REASON },
  }
}

/**
 * The GUI authorization picker's rows. An unavailable mode stays visible with
 * the reason in its label — the user needs to know *why* the level they want is
 * out of reach, and what to do about it.
 */
export function guiModeOptions(
  elevated: boolean,
  platform: NodeJS.Platform = process.platform,
): Array<{ label: string; value: GuiMode; desc?: string; disabled?: boolean }> {
  const availability = guiModeAvailability(elevated, platform)
  const label = (name: string, mode: GuiMode): string => {
    const a = availability[mode]
    return a.available ? `授权使用图形界面（${name}）` : `授权使用图形界面（${name} - 不可用，${a.reason}）`
  }
  const rows: Array<{ label: string; value: GuiMode; desc?: string; disabled?: boolean }> = [
    { label: '使用纯命令行操作（推荐）', value: 'off', desc: '仅命令行/文件方式操作本机' },
  ]
  // Off Windows there is no elevation request to skip, so the middle choice
  // would be identical to the last one; only offer it where it means something.
  if (platform === 'win32') {
    rows.push({
      label: label('低权限', 'no-elevate'),
      value: 'no-elevate',
      desc: availability['no-elevate'].available ? '不弹 UAC；能操作普通窗口，管理员窗口不行' : undefined,
      disabled: !availability['no-elevate'].available,
    })
  }
  rows.push({
    label: label('高权限', 'elevate'),
    value: 'elevate',
    desc: availability.elevate.available
      ? (platform === 'win32' ? '可操作管理员窗口（TUI 已是管理员，不会弹 UAC）' : '启用界面操作工具')
      : undefined,
    disabled: !availability.elevate.available,
  })
  return rows
}

/** Platforms where a computer-use helper exists at all, so the GUI choice applies. */
export function hasGuiSupport(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

const GUI_AUTH_FILE = 'tui-gui-authorized.json'
let guiModeCache: GuiMode | undefined = undefined

/** Read the stored mode, also accepting the `{gui: boolean}` file written by <=0.3.66. */
function readGuiMode(): GuiMode {
  try {
    const raw = JSON.parse(readFileSync(path.join(mobiusHome(), GUI_AUTH_FILE), 'utf8')) as { mode?: unknown; gui?: unknown }
    if (raw?.mode === 'off' || raw?.mode === 'no-elevate' || raw?.mode === 'elevate') return raw.mode
    return raw?.gui === true ? 'elevate' : 'off'
  } catch { return 'off' }
}

export function tuiGuiMode(): GuiMode {
  if (guiModeCache === undefined) guiModeCache = readGuiMode()
  return guiModeCache
}

/** test-only: read the stored mode straight from disk, bypassing the module cache. */
export const readGuiModeForTest = readGuiMode

export function setTuiGuiMode(mode: GuiMode): void {
  guiModeCache = mode
  try {
    mkdirSync(mobiusHome(), { recursive: true })
    // `gui` is written alongside `mode` so that a downgrade to <=0.3.66 still
    // reads the right boolean instead of silently dropping the authorization.
    writeFileSync(path.join(mobiusHome(), GUI_AUTH_FILE), JSON.stringify({ mode, gui: mode !== 'off' }), { mode: 0o600 })
  } catch { /* unwritable home: the in-memory cache still holds this session */ }
}

/** Authorized in either mode — this is what flips the gui- identifier prefix. */
export function tuiGuiAuthorized(): boolean { return tuiGuiMode() !== 'off' }

/** Only this mode makes aimux request elevation, i.e. show a UAC prompt. */
export function tuiGuiNoElevate(): boolean { return tuiGuiMode() === 'no-elevate' }

export function setTuiGuiAuthorized(value: boolean): void { setTuiGuiMode(value ? 'elevate' : 'off') }

export function tuiAimuxIdentifier(hostname = os.hostname(), cwd = process.cwd(), username = currentUsername(), guiEnabled = tuiGuiAuthorized()): string {
  const host = hostname.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  // One machine may run several Mobius TUIs for different projects (and for
  // different users). A hostname-only identifier makes every reverse client
  // register with the same name and --replace continuously evicts its siblings.
  // The (username, cwd) hash is stable across restarts/resume but unique per
  // user and per workspace, so separate projects/users never collide.
  // GUI-authorized machines register under a gui- prefix so the capability is
  // visible in the remote name itself (web device picker, remote ls).
  return `${guiEnabled ? 'gui' : 'tui'}-${host || 'pc'}-${aimuxWorkspaceHash(username, cwd)}`
}

// ── shared daemon runtime JSON (one reverse connect per user+workspace) ──
const LEASE_RENEW_MS = 5_000
/**
 * How long a freshly spawned daemon has to put runtime state on disk before the
 * supervisor may conclude it never started.
 *
 * Generous on purpose. With --enable-gui on Windows the daemon cannot write
 * anything until a human approves the elevation prompt — `runtime_update()` runs
 * inside bridge_client.connect, which is *after* the elevation gate — so "no pid
 * recorded yet" is the normal shape of a start in progress, not evidence of
 * failure. Respawning on that evidence stacks another process (and another
 * prompt) on top of the one already waiting.
 */
const SPAWN_GRACE_MS = 90_000
/**
 * Give up after this many consecutive spawns that never produced runtime state.
 * Each attempt may raise a system authorization prompt, so an unbounded retry
 * turns into a stream of windows; a clear failure the user can act on is worth
 * far more than one more attempt.
 */
const MAX_UNPRODUCTIVE_SPAWNS = 3

const aimuxRuntimeDir = () => path.join(mobiusHome(), 'aimux-runtime')
const runtimePath = (hash: string) => path.join(aimuxRuntimeDir(), `${hash}.json`)

async function ensureRuntimeDir(): Promise<void> {
  await fs.mkdir(aimuxRuntimeDir(), { recursive: true, mode: 0o700 })
}

interface RuntimeRecord { pid?: number; last_feed_watchdog?: number; need_external_restart?: boolean; realtime_healthy_display?: boolean; identifier?: string; launched_at?: number }
async function readRuntime(hash: string): Promise<RuntimeRecord | null> {
  try {
    return JSON.parse(await fs.readFile(runtimePath(hash), 'utf8')) as RuntimeRecord
  } catch { return null }
}

/**
 * Feed the daemon's watchdog. `last_feed_watchdog` is the liveness signal the
 * daemon reads, so a feed must never be dropped just because the daemon has
 * not written its runtime state yet — that would be a missed heartbeat.
 */
async function touchWatchdog(hash: string): Promise<void> {
  await ensureRuntimeDir()
  const file = runtimePath(hash)
  let state: Record<string, unknown> = {}
  try {
    state = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
  } catch { /* AIMUX has not written runtime state yet — start a fresh record */ }
  state.last_feed_watchdog = Date.now()
  try {
    const tmp = `${file}.tmp-${process.pid}`
    await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 })
    await fs.rename(tmp, file)
  } catch { /* directory not writable; nothing useful to do here */ }
}

/**
 * Is `pid` still running? `process.kill(pid, 0)` is the only portable probe, and
 * its *error* carries the answer: ESRCH means gone, EPERM means the process is
 * there and simply not ours to signal. EPERM is the normal case now that
 * --enable-gui makes the daemon an elevated process while the TUI stays
 * unelevated (and it is the classic cross-user case on POSIX). Reading EPERM as
 * dead is what made the supervisor kill and respawn healthy daemons on every
 * bridge hiccup.
 */
export function pidAlive(
  pid: number,
  probe: (pid: number, signal: number) => void = (p, s) => process.kill(p, s),
): boolean {
  try { probe(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
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
  runtimeFile: string | null = null,
  enableGui = false,
  guiNoElevate = false,
): string[] {
  return [
    'reverse', 'connect', `${server.replace(/\/$/, '')}/aimux_bridge`,
    '--identifier', identifier,
    '--token', token,
    '--replace',
    ...(runtimeFile ? ['--runtime', runtimeFile, '--watchdog', runtimeFile] : []),
    ...(platform === 'win32' && silentFlag ? [silentFlag] : []),
    ...(enableGui ? ['--enable-gui'] : []),
    // Only meaningful next to --enable-gui: it skips that flag's elevation
    // request, and without --enable-gui there is no request to skip.
    ...(enableGui && guiNoElevate ? ['--gui-no-elevate'] : []),
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

/**
 * Does this aimux build advertise --enable-gui (0.3.64+)? Older installs
 * reject unknown options outright, so the flag is only sent when the help
 * text confirms it — same defensive pattern as pickSilentFlag.
 */
export function pickEnableGuiFlag(helpText: string): boolean {
  return /--enable-gui\b/.test(helpText)
}

/**
 * Does this aimux build advertise --gui-no-elevate? It landed in the same
 * 0.3.64 release as --enable-gui, but probe it separately: sending it to a
 * build that lacks it is the same "No such option" crash-loop.
 */
export function pickGuiNoElevateFlag(helpText: string): boolean {
  return /--gui-no-elevate\b/.test(helpText)
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
  /** Grace before a spawn that produced no runtime state counts as failed (tests shrink this). */
  spawnGraceMs?: number
  /** Spawns allowed before giving up (tests shrink this). */
  maxUnproductiveSpawns?: number
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
 * runtime JSON is the shared watchdog state. A TUI only spawns when no live
 * daemon is found; otherwise it feeds the watchdog and reuses it.
 */
export class AimuxSupervisor {
  private stopping = false
  private refreshingToken = false
  private reconnectAttempt = 0
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private bridgeFailures = 0
  /** When this supervisor last started a daemon (0 = it has not started any). */
  private spawnedAt = 0
  /** Spawns in a row that never reached runtime state — see MAX_UNPRODUCTIVE_SPAWNS. */
  private unproductiveSpawns = 0
  /** Set once the retry budget is spent: keep probing (so a late approval still recovers) but stop spawning. */
  private gaveUp = false
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
    if (this.stopping) return
    const current = await readRuntime(this.hash)
    const pid = current?.pid ?? null
    if (current && pid !== null && pidAlive(pid)) {
      await touchWatchdog(this.hash)
      this.opts.onStatus({ state: 'starting', phase: 'heartbeat', detail: 'AIMUX runtime 已存在，复用中…', identifier: this.opts.identifier })
      return
    }
    await this.spawnDaemon()
  }

  /** Spawn the detached daemon exactly once, serialized by the path lock. */
  private async spawnDaemon(): Promise<void> {
    if (this.stopping) return
      const current = await readRuntime(this.hash)
      const pid = current?.pid ?? null
      if (pid !== null && pidAlive(pid)) { await touchWatchdog(this.hash); return }
      const { server, token, identifier, onStatus } = this.opts
      onStatus({ state: 'starting', phase: 'connecting', detail: '正在启动 AIMUX 守护进程…', identifier, attempt: this.reconnectAttempt })
      const gui = resolvedGuiArgs()
      const child = this.opts.spawnProcess?.(token) ?? spawnDetachedDaemon({ kind: 'exe', path: aimuxExe() }, reverseConnectArgs(server, identifier, token, process.platform, null, runtimePath(this.hash), gui.enableGui, gui.guiNoElevate))
      child.on('error', (e: Error) => { appendAimuxLog(installLogQueue, `\n[aimux spawn error] ${e.stack || e.message}\n`) })
      child.unref?.()
      this.spawnedAt = Date.now()
      this.unproductiveSpawns += 1
      appendAimuxLog(installLogQueue, `\n[aimux spawn] at=${new Date(this.spawnedAt).toISOString()} workspace=${this.hash} cwd=${process.cwd()} pid=${process.pid} gui=${gui.enableGui ? (gui.guiNoElevate ? 'no-elevate' : 'elevate') : 'off'} attempt=${this.unproductiveSpawns}\n`)
      this.reconnectAttempt = 0
  }

  /** Renew the lease every 5s while this TUI is alive. */
  private startLeaseRenewal(): void {
    const tick = () => {
      if (this.stopping) return
      void touchWatchdog(this.hash).catch(() => {})
      this.watchdogTimer = setTimeout(tick, LEASE_RENEW_MS)
    }
    void touchWatchdog(this.hash).catch(() => {})
    this.watchdogTimer = setTimeout(tick, LEASE_RENEW_MS)
  }

  private scheduleProbe(): void {
    if (this.stopping) return
    this.probeTimer = setTimeout(() => void this.checkDaemon(), this.opts.heartbeatIntervalMs ?? 5_000)
  }

  /** Probe the bridge; refresh on auth error, respawn only when the daemon is gone. */
  private async checkDaemon(): Promise<void> {
    if (this.stopping) return
      const raw = await (this.opts.probeConnection?.() ?? probeAimuxBridge(this.opts.server, this.opts.token, this.opts.identifier))
      const probe: AimuxBridgeProbe = typeof raw === 'boolean' ? { connected: raw, authError: false } : raw
      if (this.stopping) return
      if (probe.authError) {
      await this.setRuntimeRestartRequested()
        await this.refreshCredentials('JWT 已过期')
    } else if (probe.connected) {
      this.reconnectAttempt = 0
      this.gaveUp = false
      this.unproductiveSpawns = 0
      this.opts.onStatus({ state: 'connected', phase: 'connected', detail: `心跳正常 · ${this.opts.identifier}`, identifier: this.opts.identifier })
      this.bridgeFailures = 0
    } else {
      this.bridgeFailures += 1
      await this.updateRuntimeHealth(false)
      const runtime = await readRuntime(this.hash)
      const pid = runtime?.pid ?? null
      const alive = pid !== null && pidAlive(pid)
      // Runtime state on disk means the daemon got past its own start — which on
      // Windows may have meant an elevation prompt — so the attempt produced
      // something and the retry budget is not the thing to withhold.
      if (pid !== null) this.unproductiveSpawns = 0
      if (alive) {
        // The daemon owns reconnection — it retries with backoff and re-registers
        // on its own. Killing a live daemon cannot fix a bridge problem, and on
        // Windows the replacement costs a UAC prompt; worse, the two then take
        // turns evicting each other through --replace, which drops the stream
        // again. So a live daemon is left alone no matter how long it takes.
        this.opts.onStatus({ state: 'starting', phase: 'heartbeat', detail: '等待 bridge 心跳确认…', identifier: this.opts.identifier })
      } else if (pid === null && this.unproductiveSpawns >= (this.opts.maxUnproductiveSpawns ?? MAX_UNPRODUCTIVE_SPAWNS)) {
        // Stop rather than keep stacking attempts the user cannot act on. The
        // actionable cause is almost always a system authorization prompt that
        // was never shown (a remote or locked session) or never answered, and
        // the daemon cannot reach its watchdog until the prompt is dealt with.
        this.opts.onStatus({
          state: 'failed', phase: 'idle',
          detail: `AIMUX 连续 ${this.unproductiveSpawns} 次启动失败。若系统授权弹窗看不到或点不了（远程/锁屏会话），请在向导里把 GUI 授权改为「低权限」或「纯命令行」。日志: ${aimuxLogPath()}`,
          identifier: this.opts.identifier,
        })
        this.gaveUp = true
      } else if (pid === null && Date.now() - this.spawnedAt < (this.opts.spawnGraceMs ?? SPAWN_GRACE_MS)) {
        // Nothing on disk yet. With --enable-gui on Windows the daemon cannot
        // write runtime state until a human approves the elevation prompt, so
        // this is the normal shape of a start in progress — respawning here
        // stacks another prompt every probe interval. Wait it out.
        this.opts.onStatus({ state: 'starting', phase: 'connecting', detail: '等待 AIMUX 守护进程就绪（若弹出系统授权请点击确认）…', identifier: this.opts.identifier })
      } else if (!this.gaveUp) {
        // No runtime state and our own spawn is long past, or the recorded pid is
        // genuinely gone (ESRCH) — nothing to reconnect, so start one.
        this.reconnectAttempt += 1
        this.opts.onStatus({ state: 'failed', phase: 'retrying', detail: `AIMUX 守护进程未响应，重启连接中（第 ${this.reconnectAttempt} 次）…`, identifier: this.opts.identifier, attempt: this.reconnectAttempt })
        this.bridgeFailures = 0
        await this.spawnDaemon()
      }
    }
    this.scheduleProbe()
  }

  private async updateRuntimeHealth(healthy: boolean): Promise<void> {
    const file = runtimePath(this.hash)
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
      state.realtime_healthy_display = healthy
      if (healthy) state.last_healthy_heartbeat = Date.now()
      const tmp = `${file}.tmp-${process.pid}`
      await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 })
      await fs.rename(tmp, file)
    } catch {}
  }

  private async setRuntimeRestartRequested(): Promise<void> {
    const file = runtimePath(this.hash)
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
      state.need_external_restart = true
      state.realtime_healthy_display = false
      const tmp = `${file}.tmp-${process.pid}`
      await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 })
      await fs.rename(tmp, file)
    } catch {}
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
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer)
    this.watchdogTimer = null
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.probeTimer = null
    this.opts.onStatus({ state: 'stopped', phase: 'idle', detail: 'AIMUX watchdog 将在续租超时后停止', identifier: this.opts.identifier })
  }
}

let supervisor: AimuxSupervisor | null = null
let installing: Promise<void> | null = null
/** 上一次 startAimuxConnection 的参数，供 `/upgrade` 重装后原地重连。 */
let lastStartOpts: StartOptions | null = null
/**
 * `/upgrade` 显式装了 PyPI 最新版之后，跳过**下一次**连接时的版本对齐。
 * 否则刚升级完的那次重连会立刻把它拽回服务端版本，用户看到的是"升级没生效"。
 * 只跳过一次：下次启动 TUI 仍然对齐。
 */
let skipAutoAlignOnce = false
/** 实际装着的 aimux 版本，供状态行显示（自动对齐后可能和 pin 不同）。 */
let runtimeAimuxVersion: string | null = null

interface StartOptions {
  server: string
  token: string
  onStatus?: (s: AimuxStatus) => void
  refreshToken?: () => Promise<string | null>
}
// Resolved Windows console-hiding flag for the installed aimux (undefined =
// not probed yet this process). Cached so reconnects reuse it without re-running
// `aimux reverse connect --help`. See reverseConnectArgs for why this is probed.
let cachedSilentFlag: string | null | undefined = undefined
// Same caching for --enable-gui support (aimux 0.3.64+): sending it to an older
// build crashes the supervisor with "No such option".
let cachedEnableGui: boolean | undefined = undefined
// --gui-no-elevate shipped in that same release, so it is probed from the same
// help text and only consulted while --enable-gui is being sent.
let cachedGuiNoElevate: boolean | undefined = undefined

/**
 * The mode actually in force, as opposed to the stored preference. Availability
 * can invalidate a stored choice — a machine-level 'elevate' picked from an
 * administrator session, reopened from an ordinary one — and the daemon gets
 * this, not what was stored. Mirrors pickGuiArgs so the picker's "current"
 * marker cannot point at a mode this machine will not use.
 */
export function effectiveGuiMode(
  mode: GuiMode = tuiGuiMode(),
  elevated = windowsElevated(),
  platform: NodeJS.Platform = process.platform,
): GuiMode {
  if (mode === 'off') return 'off'
  if (guiModeAvailability(elevated, platform)[mode].available) return mode
  if (platform !== 'win32') return mode
  return elevated ? 'elevate' : 'no-elevate'
}

/**
 * The GUI flags to send, given the stored mode, this TUI's own privilege and
 * what the installed aimux advertises.
 *
 * Pure so the rule can be tested directly. The rule is that an unelevated TUI may
 * only ever send the pair that requests nothing; when the installed build cannot
 * express that, it sends no GUI flags at all rather than risk a daemon start that
 * blocks on a consent prompt the supervisor can neither see nor clean up.
 */
export function pickGuiArgs(
  mode: GuiMode,
  elevated: boolean,
  supports: { enable: boolean; noElevate: boolean },
  platform: NodeJS.Platform = process.platform,
): { enableGui: boolean; guiNoElevate: boolean } {
  if (mode === 'off' || !supports.enable) return { enableGui: false, guiNoElevate: false }
  if (platform !== 'win32') return { enableGui: true, guiNoElevate: mode === 'no-elevate' && supports.noElevate }
  if (elevated) return { enableGui: true, guiNoElevate: false }
  return supports.noElevate ? { enableGui: true, guiNoElevate: true } : { enableGui: false, guiNoElevate: false }
}

/** pickGuiArgs bound to the stored mode, this process's token and the probe caches. */
function resolvedGuiArgs(): { enableGui: boolean; guiNoElevate: boolean } {
  return pickGuiArgs(
    tuiGuiMode(),
    windowsElevated(),
    { enable: cachedEnableGui === true, noElevate: cachedGuiNoElevate === true },
  )
}

export async function startAimuxConnection(opts: StartOptions): Promise<void> {
  const onStatus = opts.onStatus ?? (() => {})
  // Tests and explicitly opted-out users should not spawn a network worker.
  if (process.env.MOBIUS_TUI_DISABLE_AIMUX === '1') {
    onStatus({ state: 'disabled', phase: 'idle', detail: 'AIMUX 自动连接已关闭' }); return
  }
  if (process.env.NODE_ENV === 'test' || /^https?:\/\/mock(?:\.local)?(?::\d+)?$/i.test(opts.server)) {
    onStatus({ state: 'disabled', phase: 'idle', detail: 'AIMUX 测试连接已跳过' }); return
  }
  if (supervisor || installing) return
  lastStartOpts = opts
  installing = (async () => {
    onStatus({ state: 'starting', phase: 'python', detail: '检查 Python 与 AIMUX 运行环境…' })
    // 连接前先读服务端 broker 的 aimux 版本：不一致就把本地换成同一个版本（升、降都算）。
    // 读不到服务端版本时退回 pin —— 见 alignTarget。
    const skipAlign = skipAutoAlignOnce
    skipAutoAlignOnce = false
    const installedBefore = installedAimuxVersion()
    const serverVersion = skipAlign ? null : await fetchServerAimuxVersion(opts.server, opts.token)
    const target = skipAlign ? (installedBefore ?? AIMUX_TARGET_VERSION) : alignTarget(serverVersion)
    logInstall(`aimux target=${target} server=${serverVersion ?? '(unknown)'} pin=${AIMUX_TARGET_VERSION} installed=${installedBefore ?? '(none)'}${skipAlign ? ' (auto-align skipped once after /upgrade)' : ''}\n`)
    const ready = await ensureAimux(p => onStatus({
      state: 'starting',
      phase: p.phase === 'ready' ? 'connecting' : p.phase,
      detail: p.detail || (p.phase === 'ready' ? 'AIMUX 已就绪，准备连接…' : p.phase),
    }), target)
    if (!ready.ok || !ready.launcher) { logInstall(`startAimuxConnection giving up: ${ready.error}\n`); onStatus({ state: 'failed', phase: 'idle', detail: `${ready.error} · 日志: ${aimuxLogPath()}` }); return }
    if (ready.versionWarning) { logInstall(`########## ${ready.versionWarning} ##########\n`); onStatus({ state: 'starting', phase: 'connecting', detail: ready.versionWarning }) }
    // 状态行显示的版本跟实际装的一致（自动对齐后可能和 pin 不同）。
    runtimeAimuxVersion = ready.version ?? null
    const emit = (s: AimuxStatus): void => onStatus({ ...s, version: s.version ?? runtimeAimuxVersion ?? undefined })
    // 版本被换过 → 上次探测到的命令行开关不再可信，且旧的守护进程还跑着老版本。
    if (installedBefore !== null && ready.version !== undefined && ready.version !== installedBefore) {
      logInstall(`aimux ${installedBefore} → ${ready.version}: re-probing flags and dropping the old daemon\n`)
      cachedSilentFlag = undefined; cachedEnableGui = undefined; cachedGuiNoElevate = undefined
      await stopDaemonFromRuntime()
    }
    const identifier = tuiAimuxIdentifier()
    const launcher = ready.launcher
    // Windows only: ask the installed aimux which console-hiding flag it accepts
    // before spawning, so a version mismatch (older PyPI/bundle aimux without
    // --slient-v2) can't crash-loop the supervisor with "No such option".
    const needGuiFlag = tuiGuiAuthorized()
    if (cachedSilentFlag === undefined || (needGuiFlag && cachedEnableGui === undefined)) {
      const help = await probeReverseConnectHelp(launcher)
      if (WIN && cachedSilentFlag === undefined) {
        cachedSilentFlag = pickSilentFlag(help)
        logInstall(`reverse-connect silent flag probe → ${cachedSilentFlag ?? '(none supported; sending no flag)'}\n`)
      }
      if (needGuiFlag && cachedEnableGui === undefined) {
        cachedEnableGui = pickEnableGuiFlag(help)
        cachedGuiNoElevate = pickGuiNoElevateFlag(help)
        logInstall(`reverse-connect --enable-gui probe → ${cachedEnableGui ? 'supported' : 'NOT supported (skipping; upgrade aimux to 0.3.64+)'} · --gui-no-elevate ${cachedGuiNoElevate ? 'supported' : 'NOT supported'}\n`)
      }
    }
    const silentFlag = cachedSilentFlag
    const gui = resolvedGuiArgs()
    logInstall(`GUI mode ${tuiGuiMode()} → ${gui.enableGui ? (gui.guiNoElevate ? '--enable-gui --gui-no-elevate (no UAC)' : '--enable-gui (UAC on Windows)') : 'no GUI flags'}\n`)
    supervisor = new AimuxSupervisor({
      server: opts.server, token: opts.token, identifier, onStatus: emit, refreshToken: opts.refreshToken,
      spawnProcess: token => spawnDetachedDaemon(launcher, reverseConnectArgs(opts.server, identifier, token, process.platform, silentFlag, runtimePath(aimuxWorkspaceHash()), gui.enableGui, gui.guiNoElevate)),
    })
    await supervisor.start()
  })().finally(() => { installing = null })
  await installing
}

export async function stopAimuxConnection(): Promise<void> {
  const current = supervisor; supervisor = null
  await current?.stop()
}

/**
 * Re-do the reverse connection after the GUI authorization choice changed.
 * The old daemon must die first (its runtime JSON is keyed by workspace hash,
 * not by the identifier or flags) and a fresh one spawns with the new set:
 * the identifier flips tui-⇄gui- on off⇄authorized, and the flags differ
 * between no-elevate and elevate. No-op when no connection is up yet — the
 * next startAimuxConnection picks the new mode up anyway.
 */
export async function restartAimuxConnectionForGuiChange(): Promise<void> {
  const opts = lastStartOpts
  await stopAimuxConnection()
  await stopDaemonFromRuntime()
  if (opts) await startAimuxConnection(opts)
}

/** SIGTERM 掉本工作区 runtime JSON 里记录的守护进程，并删掉该文件。
 *  不这么做的话，新 supervisor 会按 pid 复用到刚升级前的旧 daemon。 */
async function stopDaemonFromRuntime(): Promise<void> {
  const hash = aimuxWorkspaceHash()
  const pid = (await readRuntime(hash))?.pid ?? null
  if (pid !== null && pidAlive(pid)) {
    // EPERM means the daemon is elevated and not ours to signal; waiting for it
    // to die would just stall the caller, so leave it to its own watchdog.
    let ours = true
    try { process.kill(pid, 'SIGTERM') } catch (e: any) { ours = e?.code !== 'EPERM' }
    if (ours) {
      for (let i = 0; i < 30 && pidAlive(pid); i++) await new Promise(r => setTimeout(r, 100))
      if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ } }
    }
  }
  try { await fs.unlink(runtimePath(hash)) } catch { /* 本来就没有 */ }
}

/** `/upgrade` 装的永远是 PyPI 上的最新版，故意不走 AIMUX_TARGET_VERSION 这条 pin。 */
const AIMUX_PYPI_INDEX = 'https://pypi.org/simple'

/** 从 PyPI 官方索引安装最新 aimux（不带版本约束），返回实际装上的版本。 */
async function installLatestAimux(onProgress?: (p: InstallProgress) => void): Promise<{ ok: boolean; version?: string; error?: string }> {
  const py = await pythonForAimux(onProgress)
  if (!py) return { ok: false, error: '未找到 Python 3.10+（或 uv），无法升级 AIMUX' }
  if (!existsSync(venvPython())) {
    onProgress?.({ phase: 'venv', detail: `创建 Python 虚拟环境（${py}）…` })
    let r = await run(py, ['-m', 'venv', venvDir()])
    if (r.code !== 0 && py === 'py') r = await run(py, ['-3', '-m', 'venv', venvDir()])
    if (r.code !== 0) return { ok: false, error: `venv 创建失败: ${r.stderr || r.stdout}` }
  }
  onProgress?.({ phase: 'install', detail: '正在从 PyPI 安装最新 aimux…' })
  // --no-cache-dir：刚发布的版本可能还躺在 pip 的索引/包缓存里（TTL 内），
  // 用户点 /upgrade 就是要立刻拿到新版本，宁可多下一次也不吃缓存。
  const r = await run(venvPython(), [
    '-m', 'pip', 'install', '--no-input', '--disable-pip-version-check',
    '--upgrade', '--no-cache-dir', '--index-url', AIMUX_PYPI_INDEX, 'aimux',
  ], line => {
    if (/downloading|collecting|installing|using cached|%\s*\d|━|─/i.test(line)) onProgress?.({ phase: 'install', detail: line.slice(0, 120) })
  })
  if (r.code !== 0) return { ok: false, error: `pip install 失败: ${r.stderr || r.stdout}` }
  const v = await run(venvPython(), ['-c', 'import aimux; print(aimux.__version__)'])
  const version = v.code === 0 ? v.stdout.trim().split(/\s+/).pop() : undefined
  logInstall(`/upgrade installed aimux ${version ?? '(version unknown)'} from ${AIMUX_PYPI_INDEX}\n`)
  return { ok: true, version }
}

/**
 * `/upgrade`：把本地 AIMUX 升到 PyPI 上的最新版并原地重连。
 *
 * 顺序很关键——先停 TUI 的续租与旧守护进程，再装，最后用上次的连接参数重连：
 * 否则 supervisor 会按旧 pid 把升级前的 daemon 复用回来，升级看起来"没生效"。
 */
export async function upgradeAimuxRuntime(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const opts = lastStartOpts
  const onStatus = opts?.onStatus ?? (() => {})
  if (process.env.MOBIUS_TUI_DISABLE_AIMUX === '1') {
    const error = 'AIMUX 自动连接已关闭 (MOBIUS_TUI_DISABLE_AIMUX=1)'
    onStatus({ state: 'disabled', phase: 'idle', detail: 'AIMUX 自动连接已关闭' })
    return { ok: false, error }
  }
  if (!opts) return { ok: false, error: '尚未登录或 AIMUX 未启动，无法升级' }
  logInstall(`\n########## /upgrade requested ${new Date().toISOString()} ##########\n`)
  onStatus({ state: 'starting', phase: 'install', detail: '正在停止 AIMUX 守护进程…' })
  await stopAimuxConnection()
  await stopDaemonFromRuntime()
  const installed = await installLatestAimux(p => onStatus({
    state: 'starting',
    phase: p.phase === 'ready' ? 'connecting' : p.phase,
    detail: p.detail || (p.phase === 'ready' ? 'AIMUX 已就绪，准备连接…' : p.phase),
  }))
  if (!installed.ok) {
    logInstall(`########## /upgrade FAILED: ${installed.error} ##########\n`)
    onStatus({ state: 'failed', phase: 'idle', detail: `${installed.error} · 日志: ${aimuxLogPath()}` })
    return { ok: false, error: installed.error }
  }
  onStatus({ state: 'starting', phase: 'connecting', detail: `AIMUX ${installed.version ?? '最新版'} 已安装，正在重新连接…` })
  // 这次重连不把刚升上去的版本又对齐回服务端版本（见 skipAutoAlignOnce）。
  skipAutoAlignOnce = true
  await startAimuxConnection(opts)
  return { ok: true, version: installed.version }
}
