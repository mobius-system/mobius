/** AIMUX status UI + heartbeat/reconnect regression tests. */
import React from 'react'
import { EventEmitter } from 'node:events'
import { render } from 'ink-testing-library'
import { AimuxStatusLine } from '../src/components/AimuxStatus.js'
import { AimuxSupervisor, probeAimuxBridgeConnection } from '../src/aimux.js'

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

async function main() {
  await testStatusLine()
  await testProbeContract()
  await testAutomaticReconnect()
  console.log(`\n==== AIMUX RESULT: ${pass} passed, ${fail} failed ====\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(error => { console.error('FATAL', error); process.exit(2) })
