import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(frontendDir, '../..')
const nativeEasyBaseline = '99e3b3e4'
const normalBaseline = '912ef2af'
const sourcePrefix = 'mobius/frontend/src/'

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function verifyNativeEasySnapshot() {
  const rows = git(['ls-tree', '-r', nativeEasyBaseline, sourcePrefix]).split('\n').filter(Boolean)
  const mismatches = []
  for (const row of rows) {
    const match = row.match(/^[0-9]+ blob ([0-9a-f]+)\t(.+)$/)
    if (!match) continue
    const relativePath = match[2].slice(sourcePrefix.length)
    const snapshotPath = path.join(frontendDir, 'src/native-easy', relativePath)
    let actual = 'missing'
    try {
      actual = git(['hash-object', snapshotPath])
    } catch { /* reported below */ }
    if (actual !== match[1]) mismatches.push(relativePath)
  }
  if (mismatches.length) {
    throw new Error(`native easy-mode snapshot drifted:\n${mismatches.join('\n')}`)
  }
  return rows.length
}

function verifyNativeEasyRouteContract() {
  const entry = readFileSync(path.join(frontendDir, 'src/easy-native-main.tsx'), 'utf8')
  const app = readFileSync(path.join(frontendDir, 'src/native-easy/App.tsx'), 'utf8')
  const checks = [
    [entry.includes('hostPathToNativeWorkbench'), 'easy entry must translate the host URL'],
    [entry.includes('WORKBENCH_HOME_PATH'), 'easy entry must preserve the Workbench home route'],
    [entry.includes("search.set('session'"), 'easy entry must preserve the selected session'],
    [app.includes('<Route path="/u/:user" element={<WorkbenchRouteLayout />}>'), 'snapshot must expose the native Workbench route'],
    [app.includes('<Route path="/u/:user/easy_mode" element={<EasyModePage />} />'), 'snapshot must keep the two historical surfaces distinguishable'],
  ]
  const failures = checks.filter(([ok]) => !ok).map(([, message]) => message)
  if (failures.length) throw new Error(`native easy-mode route contract drifted:\n${failures.join('\n')}`)
  return checks.length
}

function verifyNormalModeSource() {
  const allowedFiles = new Set([
    'mobius/frontend/NATIVE_EASY_BASELINE.md',
    'mobius/frontend/easy-native.html',
    'mobius/frontend/package-lock.json',
    'mobius/frontend/package.json',
    'mobius/frontend/scripts/verify-ui-mode-baselines.mjs',
    'mobius/frontend/src/App.tsx',
    'mobius/frontend/src/components/assistant-chat.tsx',
    'mobius/frontend/src/components/modals.tsx',
    'mobius/frontend/src/components/native-easy-mode-frame.tsx',
    'mobius/frontend/src/components/panels.tsx',
    'mobius/frontend/src/components/research-agent-team-modal.tsx',
    'mobius/frontend/src/components/session-model-picker.tsx',
    'mobius/frontend/src/easy-native-main.tsx',
    'mobius/frontend/src/pages/Login.tsx',
    'mobius/frontend/vite.config.ts',
  ])
  const changed = git(['diff', '--name-only', normalBaseline, '--', 'mobius/frontend'])
    .split('\n')
    .filter(Boolean)
  const unexpected = changed.filter((file) => (
    !allowedFiles.has(file) && !file.startsWith('mobius/frontend/src/native-easy/')
  ))
  if (unexpected.length) {
    throw new Error(`regular-mode source drifted from main-fork:\n${unexpected.join('\n')}`)
  }
  return changed.length
}

const snapshotFiles = verifyNativeEasySnapshot()
const routeChecks = verifyNativeEasyRouteContract()
const integrationFiles = verifyNormalModeSource()
console.log(`ui mode baselines: ok (native snapshot ${snapshotFiles} files; route contract ${routeChecks} checks; normal integration ${integrationFiles} files)`)
