import assert from 'node:assert/strict'
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const helperPath = path.resolve(here, '../src/services/workbench-navigation.ts')
const bundled = await build({
  entryPoints: [helperPath],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const dataUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
const navigation = await import(dataUrl)

const {
  advancedPageReturnNavigation,
  homePath,
  issueNavigation,
  issuePath,
  legacySessionRedirect,
  navigateToWorkbench,
  projectNavigation,
  projectPath,
  readWorkbenchFocusTarget,
  readWorkbenchReturnTo,
  researchGraphNavigation,
  researchPath,
  returnNavigation,
  safeWorkbenchReturnTo,
  sessionNavigation,
  sessionPath,
  workbenchLocationPath,
  workbenchReturnLabel,
} = navigation

assert.equal(homePath('alice'), '/u/alice')
assert.equal(
  homePath('alice', { projectId: 'project one', view: 'projects', panel: 'memory' }),
  '/u/alice?project=project+one&view=projects&panel=memory',
)

assert.equal(
  sessionPath('alice/team', 'session ? 1', { match: 'entry/2', timestamp: '2026-08-28T09:30:00Z' }),
  '/u/alice%2Fteam/s/session%20%3F%201?match=entry%2F2&ts=2026-08-28T09%3A30%3A00Z',
)

assert.equal(
  projectPath('alice', 'project-1', { returnTo: '/u/alice/s/session-1?match=entry#message' }),
  '/u/alice/p/project-1?returnTo=%2Fu%2Falice%2Fs%2Fsession-1%3Fmatch%3Dentry%23message',
)
assert.equal(
  issuePath('alice', 'project-1', 'issue-1', { newSession: true, returnTo: '/u/alice/p/project-1' }),
  '/u/alice/p/project-1/i/issue-1?newSession=1&returnTo=%2Fu%2Falice%2Fp%2Fproject-1',
)
assert.equal(
  researchPath('alice', 'project-1', 'research-1', { sessionId: 'session-1', view: 'blackboard', newLeader: true }),
  '/u/alice/p/project-1/r/research-1?session=session-1&view=blackboard&newLeader=1',
)

const graphTarget = researchGraphNavigation('alice', 'project-1', 'research-1', 'session-1')
assert.deepEqual(graphTarget, {
  path: '/u/alice/p/project-1/r/research-1?session=session-1&view=graph&returnTo=%2Fu%2Falice%2Fs%2Fsession-1',
  state: {
    workbench: {
      focus: 'main-heading',
      returnTo: '/u/alice/s/session-1',
    },
  },
})

assert.deepEqual(sessionNavigation('alice', 'session-1'), {
  path: '/u/alice/s/session-1',
  state: { workbench: { focus: 'composer' } },
})
assert.deepEqual(projectNavigation('alice', 'project-1', { returnTo: '/u/alice/s/session-1' }), {
  path: '/u/alice/p/project-1?returnTo=%2Fu%2Falice%2Fs%2Fsession-1',
  state: { workbench: { focus: 'main-heading', returnTo: '/u/alice/s/session-1' } },
})
assert.equal(issueNavigation('alice', 'project-1', 'issue-1').state.workbench.focus, 'main-heading')

const calls = []
navigateToWorkbench((path, options) => calls.push({ path, options }), graphTarget, { replace: true })
assert.deepEqual(calls, [{ path: graphTarget.path, options: { replace: true, state: graphTarget.state } }])

for (const unsafe of [
  'https://evil.example/u/alice',
  '//evil.example/u/alice',
  '/admin',
  '/u/../admin',
  '/u/alice\\evil',
]) {
  assert.equal(safeWorkbenchReturnTo(unsafe), '', `必须拒绝不安全 returnTo: ${unsafe}`)
}
assert.equal(safeWorkbenchReturnTo('/u/alice/s/session-1?view=graph#node'), '/u/alice/s/session-1?view=graph#node')
assert.equal(safeWorkbenchReturnTo('/welcome?from=settings'), '/welcome?from=settings')
assert.equal(readWorkbenchReturnTo('?returnTo=%2Fu%2Falice%2Fs%2Fsession-1'), '/u/alice/s/session-1')
assert.equal(readWorkbenchReturnTo('?returnTo=https%3A%2F%2Fevil.example', '/u/alice'), '/u/alice')

assert.deepEqual(returnNavigation('//evil.example', '/u/alice/s/session-1'), {
  path: '/u/alice/s/session-1',
  state: { workbench: { focus: 'composer' } },
})
assert.equal(returnNavigation('//evil.example'), null)
assert.equal(readWorkbenchFocusTarget(graphTarget.state), 'main-heading')
assert.equal(readWorkbenchFocusTarget({ workbench: { focus: 'unknown' } }), null)

const homeSource = '/u/alice?view=projects&panel=skills'
const projectFromHome = projectNavigation('alice', 'project-1', { returnTo: homeSource })
assert.equal(readWorkbenchReturnTo(projectFromHome.path.split('?')[1] || ''), homeSource)
assert.equal(workbenchReturnLabel(homeSource), '返回工作台')
assert.deepEqual(advancedPageReturnNavigation(homeSource), {
  path: homeSource,
  state: { workbench: { focus: 'composer' } },
})

const sessionSource = sessionPath('alice', 'session-1')
const projectFromSession = projectNavigation('alice', 'project-1', { returnTo: sessionSource })
assert.equal(readWorkbenchReturnTo(projectFromSession.path.split('?')[1] || ''), sessionSource)
assert.equal(workbenchReturnLabel(sessionSource), '返回来源会话')

const projectSource = projectFromHome.path
const issueFromProject = issueNavigation('alice', 'project-1', 'issue-1', { returnTo: projectSource })
const researchFromProject = navigation.researchNavigation('alice', 'project-1', 'research-1', { returnTo: projectSource })
assert.equal(readWorkbenchReturnTo(issueFromProject.path.split('?')[1] || ''), projectSource)
assert.equal(readWorkbenchReturnTo(researchFromProject.path.split('?')[1] || ''), projectSource)
assert.equal(workbenchReturnLabel(projectSource), '返回来源项目')
assert.deepEqual(advancedPageReturnNavigation(projectSource), {
  path: projectSource,
  state: { workbench: { focus: 'main-heading' } },
})

assert.deepEqual(advancedPageReturnNavigation('', '/u/alice/p/project-1'), {
  path: '/u/alice/p/project-1',
  state: { workbench: { focus: 'main-heading' } },
})
assert.equal(
  workbenchLocationPath({ pathname: '/u/alice/p/project-1', search: '?returnTo=%2Fu%2Falice', hash: '#settings' }),
  '/u/alice/p/project-1?returnTo=%2Fu%2Falice#settings',
)

assert.equal(
  legacySessionRedirect('alice', '?session=session%2F1&view=graph&foo=a+b', '#node'),
  '/u/alice/s/session%2F1?view=graph&foo=a+b#node',
)
assert.equal(legacySessionRedirect('alice', '?view=graph'), null)
assert.equal(legacySessionRedirect('alice', '?session=session-1', 'javascript:alert(1)'), '/u/alice/s/session-1')

console.log('workbench navigation contract test passed')
