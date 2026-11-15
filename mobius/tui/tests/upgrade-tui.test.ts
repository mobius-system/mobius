import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { installationPrefix, performTuiUpgrade, type TuiUpgradeStatus } from '../src/upgrade-tui.js'

assert.equal(installationPrefix('/home/me/.local/lib/node_modules/@mobius-os/mobius', 'linux'), '/home/me/.local')
assert.equal(installationPrefix('C:\\Users\\Me\\AppData\\Roaming\\npm\\node_modules\\@mobius-os\\mobius', 'win32'), 'C:\\Users\\Me\\AppData\\Roaming\\npm')
assert.throws(() => installationPrefix('/work/mobius/tui', 'linux'), /不是 npm 全局安装/)
assert.throws(() => installationPrefix('/home/me/.npm/_npx/123/node_modules/@mobius-os/mobius', 'linux'))

const tmp = await mkdtemp(path.join(os.tmpdir(), 'tui upgrade test-'))
const root = path.join(tmp, 'lib/node_modules/@mobius-os/mobius')
await mkdir(root, { recursive: true })
try {
  const statuses: TuiUpgradeStatus[] = []
  const calls: string[][] = []
  await performTuiUpgrade(s => statuses.push(s), {
    root, platform: 'linux', currentVersion: '0.3.82',
    run: async args => {
      calls.push(args)
      if (args[0] === 'view') return '"0.3.83"'
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.3.83' }))
      return ''
    },
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[1][calls[1].indexOf('--prefix') + 1], tmp)
  assert.ok(calls[1].includes('@mobius-os/mobius@0.3.83'))
  assert.equal(statuses.at(-1)?.state, 'success')
  assert.match(statuses.at(-1)!.detail, /重新运行 mobius/)
  let count = 0
  await performTuiUpgrade(() => {}, { root, platform: 'linux', currentVersion: '0.3.83', run: async () => { count++; return '"0.3.83"' } })
  assert.equal(count, 1, 'already latest must not install')
  count = 0
  await performTuiUpgrade(() => {}, { root, platform: 'linux', currentVersion: '0.4.0', run: async () => { count++; return '"0.3.83"' } })
  assert.equal(count, 1, 'newer local release must not be downgraded')
  await assert.rejects(performTuiUpgrade(() => {}, { root, platform: 'linux', run: async () => '"invalid;command"' }), /版本无效/)
  await assert.rejects(performTuiUpgrade(() => {}, { root, platform: 'linux', currentVersion: '0.3.82', run: async args => {
    if (args[0] === 'view') return '"0.3.84"'
    throw new Error('EACCES permission denied')
  } }), /EACCES/)
  await assert.rejects(performTuiUpgrade(() => {}, { root, platform: 'linux', currentVersion: '0.3.82', run: async args => args[0] === 'view' ? '"0.3.84"' : '' }), /版本校验失败/)
  console.log('TUI upgrade tests passed: install prefixes, source/npx rejection, version lookup, upgrade, no-op, invalid response, install failure, verification failure')
} finally { await rm(tmp, { recursive: true, force: true }) }
