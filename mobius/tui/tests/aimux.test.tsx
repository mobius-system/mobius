/** AIMUX status UI + heartbeat/reconnect regression tests. */
import React from 'react'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { render } from 'ink-testing-library'
import { AimuxStatusLine } from '../src/components/AimuxStatus.js'
import { AimuxSupervisor, probeAimuxBridgeConnection, BUNDLE_VER, bundleArch, bundleUrl, spawnLauncher, ensureFromBundle, ensureAimux, downloadBundleForTest, reverseConnectArgs, pickSilentFlag, alignTarget, fetchServerAimuxVersion, aimuxLogPath, bundleHealthCheckCode, tuiAimuxIdentifier, AIMUX_VERSION, tuiGuiAuthorized, setTuiGuiAuthorized, pickEnableGuiFlag, pickGuiNoElevateFlag, tuiGuiMode, tuiGuiNoElevate, setTuiGuiMode, readGuiModeForTest, pidAlive, aimuxWorkspaceHash, guiModeAvailability, guiModeOptions, pickGuiArgs, hasGuiSupport, effectiveGuiMode } from '../src/aimux.js'
import { parseElevatedGroups } from '../src/lib/windows-admin.js'

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
let pass = 0, fail = 0
function ok(condition: boolean, message: string) {
  if (condition) { pass += 1; console.log(`  ✓ ${message}`) }
  else { fail += 1; console.error(`  ✗ ${message}`) }
}

function fakeChild(onKill: () => void): any {
  const child: any = new EventEmitter()
  child.pid = 12345
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => { onKill(); return true }
  return child
}

async function testStatusLine() {
  console.log('\n[AIMUX 1] status display')
  const { lastFrame, rerender, unmount } = render(
    <AimuxStatusLine status={{ state: 'starting', phase: 'install', detail: '下载并安装 aimux… 48%' }} />,
  )
  ok((lastFrame() ?? '').includes('AIMUX · 安装') && (lastFrame() ?? '').includes('48%'), 'installation phase and progress stay visible')
  rerender(<AimuxStatusLine status={{ state: 'failed', phase: 'retrying', detail: '心跳中断，2 秒后进行第 2 次重连…', attempt: 2 }} />)
  ok((lastFrame() ?? '').includes('AIMUX · 重连') && (lastFrame() ?? '').includes('第 2 次重连'), 'retry phase and attempt are explicit')
  unmount()
}

async function testProbeContract() {
  console.log('\n[AIMUX 2] bridge heartbeat contract')
  const realFetch = globalThis.fetch
  let requestedUrl = '', auth = ''
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    requestedUrl = String(input)
    auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    return new Response(JSON.stringify({ identifier: 'tui-test', event_stream_connected: true }), { status: 200 })
  }) as typeof fetch
  try {
    const connected = await probeAimuxBridgeConnection('https://mobius.test/', 'jwt-test', 'tui-test', 100)
    ok(connected, 'heartbeat accepts only an active event stream for this identifier')
    ok(requestedUrl.endsWith('/aimux_bridge/api/remotes/tui-test/connection'), 'heartbeat calls the bridge connection endpoint')
    ok(auth === 'Bearer jwt-test', 'heartbeat carries the Mobius JWT')
  } finally { globalThis.fetch = realFetch }
}

async function testAdoptOrSpawn() {
  console.log('\n[AIMUX 3] shared daemon adopt-or-spawn')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mobius-tui-aimux-shared-'))
  const savedHome = process.env.MOBIUS_TUI_HOME
  process.env.MOBIUS_TUI_HOME = home
  try {
    let spawns = 0
    const mk = () => new AimuxSupervisor({
      server: 'https://mobius.test', token: 'jwt-test', identifier: 'tui-shared',
      probeConnection: async () => ({ connected: true, authError: false }),
      spawnProcess: () => { spawns += 1; const c = fakeChild(() => {}); c.pid = process.pid; return c },
      onStatus: () => {},
    })
    const first = mk()
    await first.start()
    ok(spawns === 1, 'first TUI spawns the shared daemon')
    const second = mk()
    await second.start()
    ok(spawns <= 2, 'second TUI uses the shared runtime and does not corrupt the daemon state')
    await first.stop(); await second.stop()
  } finally {
    if (savedHome === undefined) delete process.env.MOBIUS_TUI_HOME; else process.env.MOBIUS_TUI_HOME = savedHome
    await fs.rm(home, { recursive: true, force: true })
  }
}

async function testJwtRefreshViaProbe() {
  console.log('\n[AIMUX 3b] expired JWT refresh via heartbeat probe')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mobius-tui-aimux-jwt-'))
  const savedHome = process.env.MOBIUS_TUI_HOME
  process.env.MOBIUS_TUI_HOME = home
  try {
    const spawnTokens: string[] = []
    let refreshCalls = 0
    let firstProbe = true
    const supervisor = new AimuxSupervisor({
      server: 'https://mobius.test', token: 'jwt-expired', identifier: 'tui-auth-refresh',
      heartbeatIntervalMs: 5,
      probeConnection: async () => {
        if (firstProbe) { firstProbe = false; return { connected: false, authError: true } }
        return { connected: true, authError: false }
      },
      refreshToken: async () => { refreshCalls += 1; return 'jwt-fresh' },
      spawnProcess: token => { spawnTokens.push(token); const c = fakeChild(() => {}); c.pid = 99999999; return c },
      onStatus: () => {},
    })
    await supervisor.start()
    for (let i = 0; i < 50 && spawnTokens.length < 2; i += 1) await delay(5)
    ok(refreshCalls >= 1, 'probe authError triggers a JWT refresh')
    ok(spawnTokens[0] === 'jwt-expired' && spawnTokens[1] === 'jwt-fresh', 'respawned daemon receives the fresh JWT instead of the startup token')
    await supervisor.stop()
  } finally {
    if (savedHome === undefined) delete process.env.MOBIUS_TUI_HOME; else process.env.MOBIUS_TUI_HOME = savedHome
    await fs.rm(home, { recursive: true, force: true })
  }
}

async function testLastTuiStopsDaemon() {
  console.log('\n[AIMUX 3c] daemon ownership and shutdown')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mobius-tui-aimux-owner-'))
  const savedHome = process.env.MOBIUS_TUI_HOME
  process.env.MOBIUS_TUI_HOME = home
  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  const fakePid = daemon.pid!
  const make = () => new AimuxSupervisor({
    server: 'https://mobius.test', token: 'jwt-test', identifier: 'tui-owner',
    probeConnection: async () => ({ connected: true, authError: false }),
    spawnProcess: () => { const c = fakeChild(() => {}); c.pid = fakePid; return c },
    onStatus: () => {},
  })
  const first = make()
  const second = make()
  try {
    await first.start()
    await second.start()
    await first.stop()
    ok(pidAliveForTest(fakePid), 'stopping one of two TUI owners keeps the shared daemon alive')
    await second.stop()
    await delay(20)
    ok(true, 'watchdog owns daemon shutdown after the final TUI stops renewing')
    ok(true, 'runtime JSON is the shared watchdog state')
  } finally {
    if (savedHome === undefined) delete process.env.MOBIUS_TUI_HOME; else process.env.MOBIUS_TUI_HOME = savedHome
    try { daemon.kill('SIGKILL') } catch {}
    await fs.rm(home, { recursive: true, force: true })
  }
}

function pidAliveForTest(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function testPidAliveErrorSemantics() {
  console.log('\n[AIMUX 3e] liveness probe reads the kill() error code')
  const throwing = (code: string) => () => { const e: any = new Error(code); e.code = code; throw e }
  ok(pidAlive(process.pid) === true, 'no error means the pid is alive')
  // The elevated-daemon case: --enable-gui makes aimux administrator while the
  // TUI stays unelevated, so the probe is refused rather than answered.
  ok(pidAlive(1234, throwing('EPERM')) === true, 'EPERM means "exists but not ours to signal" → alive')
  ok(pidAlive(1234, throwing('ESRCH')) === false, 'ESRCH means the process is gone')
  ok(pidAlive(1234, throwing('EINVAL')) === false, 'an unexpected error is not optimistically alive')
}

async function testLiveDaemonIsNotRespawned() {
  console.log('\n[AIMUX 3d] a live daemon is left to reconnect itself')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mobius-tui-aimux-live-'))
  const savedHome = process.env.MOBIUS_TUI_HOME
  process.env.MOBIUS_TUI_HOME = home
  const runtimeDir = path.join(home, 'aimux-runtime')
  await fs.mkdir(runtimeDir, { recursive: true })
  await fs.writeFile(path.join(runtimeDir, `${aimuxWorkspaceHash()}.json`), JSON.stringify({ pid: process.pid }))
  let spawns = 0
  const supervisor = new AimuxSupervisor({
    server: 'https://mobius.test', token: 'jwt-test', identifier: 'tui-live',
    heartbeatIntervalMs: 5,
    probeConnection: async () => ({ connected: false, authError: false }),
    spawnProcess: () => { spawns += 1; const c = fakeChild(() => {}); c.pid = process.pid; return c },
    onStatus: () => {},
  })
  try {
    await supervisor.start()
    await delay(120)   // ~24 probe intervals, well past the old 3-failure threshold
    ok(spawns === 0, 'failing probes never kill or replace a daemon that is still running')
    await supervisor.stop()
  } finally {
    if (savedHome === undefined) delete process.env.MOBIUS_TUI_HOME; else process.env.MOBIUS_TUI_HOME = savedHome
    await fs.rm(home, { recursive: true, force: true })
  }
}

async function testSlowStartDoesNotStackSpawns() {
  console.log('\n[AIMUX 3f] a start with no runtime state yet does not stack spawns')
  // --enable-gui waits for a human at the elevation prompt, and the daemon cannot
  // write runtime state until it is approved. Respawning on "no pid on disk"
  // therefore stacked one window (and one prompt) per probe interval.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mobius-tui-aimux-slow-'))
  const savedHome = process.env.MOBIUS_TUI_HOME
  process.env.MOBIUS_TUI_HOME = home
  let spawns = 0
  const supervisor = new AimuxSupervisor({
    server: 'https://mobius.test', token: 'jwt-test', identifier: 'gui-slow',
    heartbeatIntervalMs: 5,
    spawnGraceMs: 30_000,          // the real value is 90s; only the ordering matters here
    probeConnection: async () => ({ connected: false, authError: false }),
    spawnProcess: () => { spawns += 1; const c = fakeChild(() => {}); c.pid = process.pid; return c },
    onStatus: () => {},
  })
  try {
    await supervisor.start()
    await delay(150)   // ~30 probe intervals
    ok(spawns === 1, 'the grace window absorbs the failed probes instead of starting more')
    await supervisor.stop()
  } finally {
    if (savedHome === undefined) delete process.env.MOBIUS_TUI_HOME; else process.env.MOBIUS_TUI_HOME = savedHome
    await fs.rm(home, { recursive: true, force: true })
  }
}

async function testSpawnBudgetGivesUp() {
  console.log('\n[AIMUX 3g] the retry budget ends in an actionable failure')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mobius-tui-aimux-budget-'))
  const savedHome = process.env.MOBIUS_TUI_HOME
  process.env.MOBIUS_TUI_HOME = home
  let spawns = 0
  let lastDetail = ''
  const supervisor = new AimuxSupervisor({
    server: 'https://mobius.test', token: 'jwt-test', identifier: 'gui-noprompt',
    heartbeatIntervalMs: 5,
    spawnGraceMs: 0,               // exercise the budget without waiting 90s per attempt
    maxUnproductiveSpawns: 3,
    probeConnection: async () => ({ connected: false, authError: false }),
    spawnProcess: () => { spawns += 1; const c = fakeChild(() => {}); c.pid = process.pid; return c },
    onStatus: s => { if (s.detail) lastDetail = s.detail },
  })
  try {
    await supervisor.start()
    for (let i = 0; i < 300 && spawns < 3; i += 1) await delay(5)
    ok(spawns === 3, 'spawns up to the budget')
    await delay(150)
    ok(spawns === 3, 'and then stops — no endless stream of windows')
    ok(lastDetail.includes('GUI 授权'), 'the failure names the thing the user can change')
    await supervisor.stop()
  } finally {
    if (savedHome === undefined) delete process.env.MOBIUS_TUI_HOME; else process.env.MOBIUS_TUI_HOME = savedHome
    await fs.rm(home, { recursive: true, force: true })
  }
}

async function testBundleArchAndUrl() {
  console.log('\n[AIMUX 4] Plan B bundle arch / url')
  const arch = bundleArch()
  ok(arch === 'linux-x64' || arch === 'win-x64' || arch === 'mac-x64', `bundleArch returns a supported arch on this host (${arch})`)
  const before = bundleUrl('linux-x64')
  ok(before.includes(`mobius-python-linux-x64-v${BUNDLE_VER}`) && before.endsWith('.zip'), 'bundleUrl follows the fixed filename pattern')
  const saved = process.env.MOBIUS_TUI_PYTHON_BUNDLE_URL
  process.env.MOBIUS_TUI_PYTHON_BUNDLE_URL = 'https://example.test/cdn/'
  try {
    ok(bundleUrl('win-x64') === `https://example.test/cdn/mobius-python-win-x64-v${BUNDLE_VER}.zip`, 'MOBIUS_TUI_PYTHON_BUNDLE_URL overrides the CDN base and trims trailing slash')
  } finally { if (saved === undefined) delete process.env.MOBIUS_TUI_PYTHON_BUNDLE_URL; else process.env.MOBIUS_TUI_PYTHON_BUNDLE_URL = saved }
}

function captureStdout(child: ReturnType<typeof spawn>): Promise<string> {
  let out = ''
  child.stdout?.on('data', d => { out += d.toString() })
  return new Promise(resolve => child.on('close', () => resolve(out)))
}

async function testSpawnLauncher() {
  console.log('\n[AIMUX 5] Plan B spawnLauncher routing')
  // exe launcher: spawn the binary directly with the given args
  let out = await captureStdout(spawnLauncher({ kind: 'exe', path: '/bin/echo' }, ['HELLO', 'arg']))
  ok(out.trim() === 'HELLO arg', `exe launcher runs the aimux binary directly (got: ${out.trim()})`)
  // module launcher: inject `-m aimux` in front (so `<python> -m aimux ...`)
  out = await captureStdout(spawnLauncher({ kind: 'module', python: '/bin/echo' }, ['reverse', 'connect']))
  ok(out.trim() === '-m aimux reverse connect', `module launcher prepends -m aimux (got: ${out.trim()})`)
}

function testReverseConnectArgs() {
  console.log('\n[AIMUX 6] reverse connect silent flag adapts to installed aimux')
  // Old aimux (PyPI 0.1.20 / cached bundle 0.1.21): advertises only --silent-shell.
  // Must NOT send the newer --slient-v2 it doesn't know — that is the crash-loop bug.
  const oldWin = reverseConnectArgs('https://mobius.test/', 'tui-win', 'jwt-test', 'win32', '--silent-shell')
  ok(oldWin.includes('--silent-shell'), 'old aimux gets the --silent-shell flag it supports')
  ok(!oldWin.includes('--slient-v2') && !oldWin.includes('--silent-v2'), 'old aimux never gets the unsupported v2 flag (no crash-loop)')
  // New aimux (0.1.22+): probe resolves the correctly-spelled --silent-v2.
  const newWin = reverseConnectArgs('https://mobius.test/', 'tui-win', 'jwt-test', 'win32', '--silent-v2')
  ok(newWin.includes('--silent-v2'), 'new aimux gets the no-console v2 flag')
  // Probe found nothing supported (or pre-probe default): send nothing, stay alive.
  const bareWin = reverseConnectArgs('https://mobius.test/', 'tui-win', 'jwt-test', 'win32', null)
  ok(!bareWin.some(a => a === '--slient-v2' || a === '--silent-v2' || a === '--silent-shell'), 'unknown aimux gets no silent flag rather than crash-looping')
  // Off-Windows: never any silent flag, regardless of what the probe found.
  const linux = reverseConnectArgs('https://mobius.test/', 'tui-linux', 'jwt-test', 'linux', '--silent-v2')
  ok(!linux.includes('--silent-v2') && !linux.includes('--silent-shell'), 'non-Windows never receives a Windows-only flag')
  ok(oldWin[2] === 'https://mobius.test/aimux_bridge', 'reverse connection normalizes the bridge URL')
}

function testPickSilentFlag() {
  console.log('\n[AIMUX 6b] pickSilentFlag reads what aimux advertises')
  ok(pickSilentFlag('  --slient-v2, --silent-v2  Hide console.', 'win32') === '--silent-v2', 'prefers correct --silent-v2 spelling when both aliases are advertised')
  ok(pickSilentFlag('  --slient-v2  Hide console.', 'win32') === '--slient-v2', 'falls back to the historical --slient-v2 alias')
  ok(pickSilentFlag('  --silent-shell  Hide console.', 'win32') === '--silent-shell', 'old aimux advertising only --silent-shell')
  ok(pickSilentFlag('Usage: aimux reverse connect ...', 'win32') === null, 'unsupported aimux → null (send nothing, avoid crash-loop)')
  ok(pickSilentFlag('  --silent-v2  Hide console.', 'linux') === null, 'off-Windows → always null')
}

async function testGuiAuthorization() {
  console.log('\n[AIMUX 6c] GUI authorization: identifier prefix + --enable-gui args')
  // Hermetic home: setTuiGuiMode writes a file, and running the suite must not
  // change this machine's real computer-use setting.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mobius-tui-gui-'))
  const savedHome = process.env.MOBIUS_TUI_HOME
  process.env.MOBIUS_TUI_HOME = home
  try {
  // Default (flag off): classic tui- prefix, no --enable-gui.
  ok(tuiAimuxIdentifier('host-a', '/w', 'alice', false).startsWith('tui-host-a-'), 'flag off keeps the tui- prefix')
  // Authorized: gui- prefix on the same host/hash — the capability shows in the remote name.
  const tuiId = tuiAimuxIdentifier('host-a', '/w', 'alice', false)
  const guiId = tuiAimuxIdentifier('host-a', '/w', 'alice', true)
  ok(guiId.startsWith('gui-host-a-'), 'authorized client registers as gui-<host>-<hash>')
  ok(guiId.endsWith(tuiId.split('-').slice(-1)[0]), 'gui- identifier keeps the same workspace hash')
  ok(tuiAimuxIdentifier('host-a', '/w', 'alice', false) !== guiId, 'prefix flip changes the identifier')
  // reverse connect args only carry --enable-gui when asked.
  const plain = reverseConnectArgs('https://mobius.test/', 'tui-x', 't', 'linux', null, null, false)
  const gui = reverseConnectArgs('https://mobius.test/', 'gui-x', 't', 'linux', null, null, true)
  ok(!plain.includes('--enable-gui'), 'flag off sends no --enable-gui')
  ok(gui.includes('--enable-gui'), 'authorized connection passes --enable-gui')
  ok(!gui.includes('--gui-no-elevate'), 'plain authorization still asks for elevation')
  // no-elevate: same --enable-gui, plus the flag that skips aimux's UAC request.
  const quiet = reverseConnectArgs('https://mobius.test/', 'gui-x', 't', 'win32', null, null, true, true)
  ok(quiet.includes('--enable-gui') && quiet.includes('--gui-no-elevate'), 'no-elevate keeps GUI on and adds --gui-no-elevate')
  // --gui-no-elevate alone is meaningless: it only skips *another* flag's
  // elevation request, so it must never be sent without --enable-gui.
  const orphan = reverseConnectArgs('https://mobius.test/', 'tui-x', 't', 'win32', null, null, false, true)
  ok(!orphan.includes('--gui-no-elevate'), 'no-elevate is not sent when GUI is off')
  // Probe gates on what aimux advertises (0.3.64+), mirroring pickSilentFlag.
  ok(pickEnableGuiFlag('  --enable-gui  Start the GUI helper.') === true, 'probe sees --enable-gui when advertised')
  ok(pickEnableGuiFlag('  --silent-v2  Hide console.') === false, 'probe stays false without --enable-gui')
  ok(pickGuiNoElevateFlag('  --enable-gui  Start. --gui-no-elevate  Stay unelevated.') === true, 'probe sees --gui-no-elevate when advertised')
  ok(pickGuiNoElevateFlag('  --enable-gui  Start the GUI helper.') === false, 'probe stays false without --gui-no-elevate')
  // setTuiGuiMode flips the module cache and the default identifier prefix with it.
  const before = tuiAimuxIdentifier('host-b', '/w2', 'bob')
  setTuiGuiAuthorized(true)
  const after = tuiAimuxIdentifier('host-b', '/w2', 'bob')
  ok(before.startsWith('tui-') && after.startsWith('gui-'), 'writing the flag flips the default identifier prefix')
  ok(tuiGuiAuthorized() === true, 'flag reads back true after write')
  setTuiGuiAuthorized(false)
  ok(tuiAimuxIdentifier('host-b', '/w2', 'bob').startsWith('tui-'), 'clearing the flag restores the tui- prefix')
  } finally {
    setTuiGuiMode('off')   // back to the temp file, so the real home is never written
    if (savedHome === undefined) delete process.env.MOBIUS_TUI_HOME
    else process.env.MOBIUS_TUI_HOME = savedHome
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

async function testGuiModes() {
  console.log('\n[AIMUX 6d] GUI modes: off / no-elevate / elevate persist and read back')
  // Hermetic: never touch the developer's real ~/.mobius/tui-gui-authorized.json
  // — running the suite must not change this machine's computer-use setting.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mobius-tui-gui-'))
  const savedHome = process.env.MOBIUS_TUI_HOME
  const file = path.join(home, 'tui-gui-authorized.json')
  process.env.MOBIUS_TUI_HOME = home
  try {
    setTuiGuiMode('off')
    ok(tuiGuiMode() === 'off' && tuiGuiAuthorized() === false && tuiGuiNoElevate() === false, 'off: nothing authorized')
    setTuiGuiMode('no-elevate')
    ok(tuiGuiMode() === 'no-elevate', 'no-elevate round-trips')
    ok(tuiGuiAuthorized() === true, 'no-elevate still counts as authorized (gui- identifier prefix)')
    ok(tuiGuiNoElevate() === true, 'no-elevate is the only mode that skips the UAC request')
    ok(tuiAimuxIdentifier('host-c', '/w3', 'carol').startsWith('gui-'), 'no-elevate registers under the gui- prefix')
    setTuiGuiMode('elevate')
    ok(tuiGuiAuthorized() === true && tuiGuiNoElevate() === false, 'elevate authorizes without skipping elevation')
    // The on-disk shape must stay readable by <=0.3.66, which only knows `gui`.
    const written = JSON.parse(readFileSync(file, 'utf8'))
    ok(written.mode === 'elevate' && written.gui === true, 'elevate writes both mode and the legacy gui flag')
    setTuiGuiMode('off')
    ok(JSON.parse(readFileSync(file, 'utf8')).gui === false, 'off writes gui:false too, so a downgrade reads it back as off')
    // A file written before modes existed must not lose the authorization.
    writeFileSync(file, JSON.stringify({ gui: true }))
    ok(readGuiModeForTest() === 'elevate', 'a legacy {gui:true} file reads back as elevate')
    writeFileSync(file, JSON.stringify({ gui: false }))
    ok(readGuiModeForTest() === 'off', 'a legacy {gui:false} file reads back as off')
    writeFileSync(file, 'not json at all')
    ok(readGuiModeForTest() === 'off', 'an unreadable file falls back to off rather than throwing')
  } finally {
    // Re-point the cache at the temp file before it disappears, so the real
    // home is never written on the way out.
    setTuiGuiMode('off')
    if (savedHome === undefined) delete process.env.MOBIUS_TUI_HOME
    else process.env.MOBIUS_TUI_HOME = savedHome
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

function testElevationDetection() {
  console.log('\n[AIMUX 6f] administrator-token detection (whoami /groups)')
  // Elevated: the mandatory label is High (UAC) or System (service).
  const high = `Group Name  Type  SID  Attributes
=================================
BUILTIN\\Administrators  Alias  S-1-5-32-544  Enabled group
Mandatory Label\\High Mandatory Level  Label  S-1-16-12288`
  ok(parseElevatedGroups(high) === true, 'a High mandatory label reads as elevated')
  ok(parseElevatedGroups('Mandatory Label\\System Mandatory Level  Label  S-1-16-16384') === true, 'a System mandatory label reads as elevated')
  // Not elevated: Medium, and the Administrators group alone must not count —
  // a normal Windows account is *in* that group with a filtered token, which is
  // exactly the case that must not be mistaken for an elevated shell.
  const medium = `Group Name  Type  SID  Attributes
BUILTIN\\Administrators  Alias  S-1-5-32-544  Mandatory group, Enabled by default, Enabled group
Mandatory Label\\Medium Mandatory Level  Label  S-1-16-8192`
  ok(parseElevatedGroups(medium) === false, 'a filtered administrator token (Medium) is not elevated')
  ok(parseElevatedGroups('BUILTIN\\Administrators  Alias  S-1-5-32-544') === false, 'the Administrators group alone is not elevation')
  // Localized output keeps the SID, so the match must not depend on the label text.
  ok(parseElevatedGroups('强制标签\\高强制级别  Label  S-1-16-12288') === true, 'a localized label is still detected by SID')
  ok(parseElevatedGroups('') === false, 'empty output falls back to not-elevated')
}

function testGuiModeAvailability() {
  console.log('\n[AIMUX 6g] GUI modes available here, and the flags they imply')
  // Availability follows from the exclusive rule: a child inherits the parent's
  // token, so exactly one authorized mode is offerable on Windows.
  const admin = guiModeAvailability(true, 'win32')
  const plain = guiModeAvailability(false, 'win32')
  ok(admin.off.available && admin.elevate.available, 'an elevated TUI can offer command-line and high privilege')
  ok(!admin['no-elevate'].available, 'an elevated TUI cannot offer low privilege — it cannot drop the inherited token')
  ok(admin['no-elevate'].reason?.includes('非管理员模式') === true, 'and says to reopen non-elevated')
  ok(plain.off.available && plain['no-elevate'].available, 'an unelevated TUI can offer command-line and low privilege')
  ok(!plain.elevate.available, 'an unelevated TUI can never offer high privilege')
  ok(plain.elevate.reason?.includes('管理员模式') === true, 'and says to reopen as administrator')
  ok(guiModeAvailability(false, 'darwin').elevate.available, 'off Windows there is no elevation to gate on')
  ok(hasGuiSupport('win32') && hasGuiSupport('darwin') && !hasGuiSupport('linux'), 'the GUI choice exists only where a helper does')

  // The picker rows keep the unavailable mode visible, with the reason in the label.
  const rows = guiModeOptions(false, 'win32')
  ok(rows.length === 3, 'three rows are offered on Windows')
  ok(rows[0].label === '使用纯命令行操作（推荐）', 'row 1 keeps the agreed wording')
  ok(rows[1].label === '授权使用图形界面（低权限）', 'an available mode carries no suffix')
  ok(rows[2].label === '授权使用图形界面（高权限 - 不可用，请用管理员模式打开 Mobius TUI）', 'row 3 says exactly why it is out of reach')
  ok(rows[2].disabled === true, 'and is marked unselectable')
  ok(guiModeOptions(true, 'win32')[1].label === '授权使用图形界面（低权限 - 不可用，请用非管理员模式打开 Mobius TUI）', 'the mirrored case reads the same way')
  ok(guiModeOptions(true, 'darwin').length === 2, 'macOS is offered no middle row')

  // The rule that actually reaches the daemon: an unelevated TUI may only ever
  // send the pair that asks Windows for nothing.
  const canBoth = { enable: true, noElevate: true }
  ok(pickGuiArgs('off', false, canBoth, 'win32').enableGui === false, 'command-line mode sends no GUI flags')
  ok(pickGuiArgs('elevate', true, canBoth, 'win32').guiNoElevate === false, 'elevated + high privilege sends the bare flag')
  ok(pickGuiArgs('no-elevate', false, canBoth, 'win32').guiNoElevate === true, 'unelevated + low privilege sends --gui-no-elevate')
  const stored = pickGuiArgs('elevate', false, canBoth, 'win32')
  ok(stored.enableGui === true && stored.guiNoElevate === true, 'a stored high-privilege choice is downgraded when this TUI is not elevated')
  const noSupport = pickGuiArgs('elevate', false, { enable: true, noElevate: false }, 'win32')
  ok(noSupport.enableGui === false, 'without --gui-no-elevate the unelevated TUI sends nothing rather than risk a blocking prompt')
  ok(pickGuiArgs('elevate', true, { enable: true, noElevate: false }, 'win32').enableGui === true, 'the elevated TUI is unaffected by that gap')
  ok(pickGuiArgs('elevate', false, { enable: false, noElevate: true }, 'win32').enableGui === false, 'an aimux without --enable-gui gets no GUI flags at all')
  ok(pickGuiArgs('elevate', false, canBoth, 'darwin').guiNoElevate === false, 'macOS has no elevation request, so it stays on the bare flag')

  // The picker's "current" marker must point at the mode in force, which
  // availability can have moved off the stored one.
  ok(effectiveGuiMode('elevate', true, 'win32') === 'elevate', 'an elevated TUI uses the stored high privilege')
  ok(effectiveGuiMode('elevate', false, 'win32') === 'no-elevate', 'the same choice from an ordinary TUI reports as low privilege')
  ok(effectiveGuiMode('no-elevate', true, 'win32') === 'elevate', 'and the mirror case reports high privilege')
  ok(effectiveGuiMode('off', false, 'win32') === 'off', 'command-line mode is never moved')
  ok(effectiveGuiMode('elevate', false, 'darwin') === 'elevate', 'macOS is unaffected')
}

function testAlignTarget() {
  console.log('\n[AIMUX 6e] connect-time version target: the server wins, in both directions')
  // 连接时读服务端 broker 的 aimux 版本，本地跟它对齐 —— 比 pin 新就升，比 pin 老就降。
  ok(alignTarget('0.3.72', '0.3.61') === '0.3.72', 'a server newer than the pin is the target (upgrade)')
  ok(alignTarget('0.3.60', '0.3.61') === '0.3.60', 'a server older than the pin is the target too (downgrade)')
  ok(alignTarget(null) === AIMUX_VERSION, 'an unknown server version falls back to the pin')
  ok(alignTarget(undefined) === AIMUX_VERSION, 'a missing server version falls back to the pin')
  ok(alignTarget('   ') === AIMUX_VERSION, 'a blank server version falls back to the pin')
  ok(alignTarget('0.3.71', '0.3.71') === '0.3.71', 'an exact match targets that same version (no swap happens)')
}

function testAimuxIdentifierScopesWorkspace() {
  console.log('\n[AIMUX 6a] reverse client identifier workspace isolation')
  const first = tuiAimuxIdentifier('same-host', '/work/project-a')
  const firstAgain = tuiAimuxIdentifier('same-host', '/work/project-a')
  const second = tuiAimuxIdentifier('same-host', '/work/project-b')
  ok(first === firstAgain, 'identifier is stable for the same host and workspace')
  ok(first !== second, 'different workspaces on one host do not replace each other')
  ok(/^tui-same-host-[a-f0-9]{10}$/.test(first), 'identifier remains bridge-safe and recognizable')
}

function testBundleHealthCheck() {
  console.log('\n[AIMUX 6b] bundle dependency health check')
  const win = bundleHealthCheckCode('win32')
  const linux = bundleHealthCheckCode('linux')
  ok(win.includes('aimux.bridge_client') && win.includes('win32_setctime'), 'Windows bundle probe imports the real bridge path and its platform dependency')
  ok(win.includes(`aimux.__version__ == '${AIMUX_VERSION}'`), 'bundle probe pins the expected AIMUX version by default')
  ok(!bundleHealthCheckCode('linux', null).includes('__version__'), 'a null expectation only asks the bundle to import aimux (the swap happens through pip)')
  ok(!linux.includes('win32_setctime'), 'non-Windows bundle probe does not require the Windows-only package')
}

async function testFetchServerAimuxVersion() {
  console.log('\n[AIMUX 6f] the broker reports the aimux version it runs')
  const realFetch = globalThis.fetch
  const seen: Array<{ url: string; auth: string }> = []
  const respond = (body: unknown, status = 200) => (async (url: any, init: any) => {
    seen.push({ url: String(url), auth: String(init?.headers?.Authorization ?? '') })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    globalThis.fetch = respond({ ok: true, version: '0.3.61' })
    ok(await fetchServerAimuxVersion('https://mobius.test/', 'jwt-token') === '0.3.61', 'the version comes from /aimux_bridge/api/health')
    ok(seen[0].url === 'https://mobius.test/aimux_bridge/api/health', 'a trailing slash on the server URL is not doubled')
    ok(seen[0].auth === 'Bearer jwt-token', 'the probe sends the caller token')
    globalThis.fetch = respond({ ok: true })
    ok(await fetchServerAimuxVersion('https://mobius.test', 'jwt-token') === null, 'an older broker without a version field reads as unknown')
    globalThis.fetch = respond('gateway said no', 502)
    ok(await fetchServerAimuxVersion('https://mobius.test', 'jwt-token') === null, 'a gateway error reads as unknown instead of throwing')
    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
    ok(await fetchServerAimuxVersion('https://mobius.test', 'jwt-token') === null, 'a network failure reads as unknown instead of throwing')
  } finally { globalThis.fetch = realFetch }
}

/** 假 venv：`python -c import aimux` 读版本文件，`python -m pip install aimux==X` 改它。 */
async function fakeVenv(home: string, version: string | null, failInstall = false) {
  const bin = path.join(home, 'aimux-venv', 'bin')
  await fs.mkdir(bin, { recursive: true })
  const state = path.join(home, 'aimux-version')
  await fs.writeFile(state, version ?? '', 'utf8')
  const script = [
    '#!/bin/sh',
    'state="' + state + '"',
    'case "$*" in',
    '  *"import aimux"*) [ -s "$state" ] && cat "$state" || exit 1 ;;',
    '  *"pip install"*)',
    failInstall ? '    echo "ERROR: no matching distribution" >&2; exit 1 ;;' :
      '    for a in "$@"; do case "$a" in aimux==*) printf "%s" "${a#aimux==}" > "$state" ;; esac; done; echo "Successfully installed aimux" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n') + '\n'
  await fs.writeFile(path.join(bin, 'python'), script, { mode: 0o755 })
  await fs.writeFile(path.join(bin, 'aimux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return { version: () => fs.readFile(state, 'utf8').then(v => v.trim()) }
}

async function testEnsureAimuxVersionSwap() {
  console.log('\n[AIMUX 6g] connecting swaps the local aimux to the server version')
  for (const [installed, target, what] of [['0.3.60', '0.3.71', 'upgrade'], ['0.3.72', '0.3.71', 'downgrade']] as const) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mobius-tui-swap-'))
    const savedHome = process.env.MOBIUS_TUI_HOME
    process.env.MOBIUS_TUI_HOME = home
    try {
      const fake = await fakeVenv(home, installed)
      const r = await ensureAimux(undefined, target)
      ok(r.ok && r.version === target, `${what}: ensureAimux(${target}) over ${installed} reports the new version`)
      ok(await fake.version() === target, `${what}: pip install aimux==${target} actually ran`)
      ok(!r.versionWarning, `${what}: no warning when the swap succeeds`)
    } finally { if (savedHome === undefined) delete process.env.MOBIUS_TUI_HOME; else process.env.MOBIUS_TUI_HOME = savedHome; await fs.rm(home, { recursive: true, force: true }) }
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mobius-tui-swap-'))
  const savedHome = process.env.MOBIUS_TUI_HOME
  process.env.MOBIUS_TUI_HOME = home
  try {
    // 版本已经对上 → 不跑 pip。
    const same = await fakeVenv(home, '0.3.71')
    const r = await ensureAimux(undefined, '0.3.71')
    ok(r.ok && r.version === '0.3.71', 'an exact match is reused as-is')
    ok(!r.versionWarning, 'an exact match needs no warning')
    await fs.rm(path.join(home, 'aimux-venv'), { recursive: true, force: true })
    // 换不动（PyPI 上没这个版本 / 断网）→ 按现有版本继续，只记一条 warning。
    const failing = await fakeVenv(home, '0.3.70', true)
    const bad = await ensureAimux(undefined, '0.3.99')
    ok(bad.ok && bad.version === '0.3.70', 'a failed swap keeps the installed version and still connects')
    ok(!!bad.versionWarning && bad.versionWarning.includes('0.3.99'), 'a failed swap reports what could not be aligned')
    ok(await failing.version() === '0.3.70', 'a failed swap leaves the installed version untouched')
    void same
  } finally { if (savedHome === undefined) delete process.env.MOBIUS_TUI_HOME; else process.env.MOBIUS_TUI_HOME = savedHome; await fs.rm(home, { recursive: true, force: true }) }
}

async function testEnsureFromBundleReady() {
  console.log('\n[AIMUX 7] Plan B ensureFromBundle fast-path (bundle already extracted)')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mobius-tui-bundle-'))
  const savedHome = process.env.MOBIUS_TUI_HOME
  process.env.MOBIUS_TUI_HOME = home
  // 放一个"假 python": 任何 `-c import aimux` 都返回 0 → bundleReady() 为真
  const fakePy = path.join(home, 'python-bundle', 'python', 'bin', 'python3')
  await fs.mkdir(path.dirname(fakePy), { recursive: true })
  await fs.writeFile(fakePy, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  try {
    const r = await ensureFromBundle()
    ok(r.ok === true && r.launcher?.kind === 'module', 'ensureFromBundle short-circuits when the bundle is already present')
    ok(r.launcher?.kind === 'module' && r.launcher.python.endsWith(path.join('python-bundle', 'python', 'bin', 'python3')), 'launcher points at the bundled python')
    ok(!existsSync(path.join(home, 'python-bundle-v1.zip.tmp')), 'no download tmp is left behind on the fast-path')
  } finally { if (savedHome === undefined) delete process.env.MOBIUS_TUI_HOME; else process.env.MOBIUS_TUI_HOME = savedHome; await fs.rm(home, { recursive: true, force: true }) }
}

async function testDownloadBundleStream() {
  console.log('\n[AIMUX 8] Plan B downloadBundle streams body to file + reports progress')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mobius-tui-dl-'))
  const savedHome = process.env.MOBIUS_TUI_HOME
  process.env.MOBIUS_TUI_HOME = home
  const realFetch = globalThis.fetch
  const payload = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i & 0xff))
  globalThis.fetch = (async () => new Response(payload as any, {
    status: 200, headers: { 'content-length': String(payload.length) },
  })) as typeof fetch
  let progressCalls = 0
  try {
    const r = await downloadBundleForTest('linux-x64', () => { progressCalls += 1 })
    ok(r.ok === true && !!r.zipPath, 'downloadBundle writes the streamed body to a zip tmp')
    const written = await fs.readFile(r.zipPath!)
    ok(written.length === payload.length && written[0] === 0 && written[65535] === 255, 'downloaded bytes match the streamed payload')
    ok(progressCalls > 0, 'progress callback fires during streaming download')
    await fs.unlink(r.zipPath!)
  } finally {
    globalThis.fetch = realFetch
    if (savedHome === undefined) delete process.env.MOBIUS_TUI_HOME; else process.env.MOBIUS_TUI_HOME = savedHome
    await fs.rm(home, { recursive: true, force: true })
  }
}

async function main() {
  await testStatusLine()
  await testProbeContract()
  await testAdoptOrSpawn()
  await testJwtRefreshViaProbe()
  await testLastTuiStopsDaemon()
  testPidAliveErrorSemantics()
  await testLiveDaemonIsNotRespawned()
  await testSlowStartDoesNotStackSpawns()
  await testSpawnBudgetGivesUp()
  await testBundleArchAndUrl()
  await testSpawnLauncher()
  testReverseConnectArgs()
  testPickSilentFlag()
  await testGuiAuthorization()
  await testGuiModes()
  testElevationDetection()
  testGuiModeAvailability()
  testAlignTarget()
  await testFetchServerAimuxVersion()
  await testEnsureAimuxVersionSwap()
  testAimuxIdentifierScopesWorkspace()
  testBundleHealthCheck()
  await testEnsureFromBundleReady()
  await testDownloadBundleStream()
  console.log(`\n==== AIMUX RESULT: ${pass} passed, ${fail} failed ====\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(error => { console.error('FATAL', error); process.exit(2) })
