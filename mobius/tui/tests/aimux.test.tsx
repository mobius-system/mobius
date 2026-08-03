/** AIMUX status UI + heartbeat/reconnect regression tests. */
import React from 'react'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { render } from 'ink-testing-library'
import { AimuxStatusLine } from '../src/components/AimuxStatus.js'
import { AimuxSupervisor, probeAimuxBridgeConnection, bundleArch, bundleUrl, spawnLauncher, ensureFromBundle, downloadBundleForTest, reverseConnectArgs } from '../src/aimux.js'

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

async function testAutomaticReconnect() {
  console.log('\n[AIMUX 3] heartbeat-triggered reconnect')
  const statuses: string[] = []
  let probes = 0, spawns = 0, kills = 0
  const supervisor = new AimuxSupervisor({
    server: 'https://mobius.test', token: 'jwt-test', identifier: 'tui-test',
    heartbeatIntervalMs: 5, heartbeatFailureThreshold: 2, retryBaseMs: 5,
    probeConnection: async () => { probes += 1; return probes >= 3 },
    spawnProcess: () => { spawns += 1; return fakeChild(() => { kills += 1 }) },
    onStatus: status => statuses.push(`${status.state}:${status.phase}:${status.detail}`),
  })
  supervisor.start()
  for (let i = 0; i < 30 && !statuses.some(s => s.startsWith('connected:')); i += 1) await delay(5)
  ok(kills >= 1, 'two failed heartbeats terminate the stale AIMUX process')
  ok(spawns >= 2, 'supervisor starts a fresh AIMUX process after heartbeat loss')
  ok(statuses.some(s => s.includes('第 1 次重连')), 'reconnect status reports its retry attempt')
  ok(statuses.some(s => s.startsWith('connected:connected:心跳正常')), 'a later successful heartbeat restores connected state')
  await supervisor.stop()
}

async function testBundleArchAndUrl() {
  console.log('\n[AIMUX 4] Plan B bundle arch / url')
  const arch = bundleArch()
  ok(arch === 'linux-x64' || arch === 'win-x64' || arch === 'mac-x64', `bundleArch returns a supported arch on this host (${arch})`)
  const before = bundleUrl('linux-x64')
  ok(before.includes('mobius-python-linux-x64-v') && before.endsWith('.zip'), 'bundleUrl follows the fixed filename pattern')
  const saved = process.env.MOBIUS_TUI_PYTHON_BUNDLE_URL
  process.env.MOBIUS_TUI_PYTHON_BUNDLE_URL = 'https://example.test/cdn/'
  try {
    ok(bundleUrl('win-x64') === 'https://example.test/cdn/mobius-python-win-x64-v1.zip', 'MOBIUS_TUI_PYTHON_BUNDLE_URL overrides the CDN base and trims trailing slash')
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
  console.log('\n[AIMUX 6] reverse connect Windows shell visibility')
  const win = reverseConnectArgs('https://mobius.test/', 'tui-win', 'jwt-test', 'win32')
  const linux = reverseConnectArgs('https://mobius.test/', 'tui-linux', 'jwt-test', 'linux')
  ok(win.includes('--silent-shell'), 'Windows reverse connection always requests hidden command shells')
  ok(!linux.includes('--silent-shell'), 'non-Windows reverse connection does not receive the Windows-only flag')
  ok(win[2] === 'https://mobius.test/aimux_bridge', 'reverse connection normalizes the bridge URL')
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
  await testAutomaticReconnect()
  await testBundleArchAndUrl()
  await testSpawnLauncher()
  testReverseConnectArgs()
  await testEnsureFromBundleReady()
  await testDownloadBundleStream()
  console.log(`\n==== AIMUX RESULT: ${pass} passed, ${fail} failed ====\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(error => { console.error('FATAL', error); process.exit(2) })
