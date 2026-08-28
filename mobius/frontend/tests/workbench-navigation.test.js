import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advancedPageReturnNavigation,
  homeNavigation,
  homePath,
  issueNavigation,
  legacySessionRedirect,
  navigateToWorkbench,
  navigateToWorkbenchObject,
  projectNavigation,
  readWorkbenchFocusTarget,
  readWorkbenchReturnTo,
  readWorkbenchSourceSurface,
  researchGraphNavigation,
  researchNavigation,
  returnNavigation,
  safeWorkbenchReturnTo,
  sessionNavigation,
  sessionPath,
  systemVisualizationNavigation,
  systemVisualizationPath,
  WORKBENCH_CLEAR_OBJECT_SELECTION_EVENT,
  WORKBENCH_EXIT_CENTER_TOOL_EVENT,
  workbenchLocationPath,
  workbenchReturnLabel,
} from '../src/services/workbench-navigation.ts'

test('Session 始终生成 canonical 短路由并编码 path/query', () => {
  assert.equal(sessionPath('user name', 'session/1'), '/u/user%20name/s/session%2F1')
  assert.deepEqual(sessionNavigation('u', 's', { match: 'entry/1', timestamp: '2026-08-28T00:00:00Z' }), {
    path: '/u/u/s/s?match=entry%2F1&ts=2026-08-28T00%3A00%3A00Z',
    state: { workbench: { focus: 'composer' } },
  })
})

test('Home、Project、Issue、Research 生成统一 query 与焦点 state', () => {
  assert.equal(homePath('u', { projectId: 'p', view: 'projects', panel: 'skills' }), '/u/u?project=p&view=projects&panel=skills')
  assert.deepEqual(homeNavigation('u', { projectId: 'p' }), {
    path: '/u/u?project=p',
    state: { workbench: { focus: 'composer' } },
  })
  assert.equal(projectNavigation('u', 'p').path, '/u/u/p/p')
  assert.equal(issueNavigation('u', 'p', 'i', { newSession: true }).path, '/u/u/p/p/i/i?newSession=1')
  assert.equal(researchNavigation('u', 'p', 'r', { newLeader: true }).path, '/u/u/p/p/r/r?newLeader=1')
  assert.equal(readWorkbenchFocusTarget(projectNavigation('u', 'p').state), 'main-heading')
})

test('Research Graph 携带 session、view、可校验 returnTo 与标题焦点', () => {
  const destination = researchGraphNavigation('user', 'project', 'research', 'session')
  assert.equal(
    destination.path,
    '/u/user/p/project/r/research?session=session&view=graph&returnTo=%2Fu%2Fuser%2Fs%2Fsession',
  )
  assert.deepEqual(destination.state, {
    workbench: { focus: 'main-heading', returnTo: '/u/user/s/session' },
  })
})

test('系统可视化使用独立全屏路由并携带可刷新来源', () => {
  const source = '/u/user/s/session'
  assert.equal(
    systemVisualizationPath('user name', 'cluster', { returnTo: source }),
    '/u/user%20name/mobius_overview_cluster?returnTo=%2Fu%2Fuser%2Fs%2Fsession',
  )
  assert.deepEqual(systemVisualizationNavigation('user', 'overview', { returnTo: source }), {
    path: '/u/user/mobius_overview?returnTo=%2Fu%2Fuser%2Fs%2Fsession',
    state: { workbench: { focus: 'main-heading', returnTo: source } },
  })
})

test('Issue / Research 进入短 Session 时只在 navigation state 携带来源表面', () => {
  const issueSession = sessionNavigation('user', 'session', { sourceSurface: 'issue' })
  const researchSession = sessionNavigation('user', 'session', { sourceSurface: 'research' })
  assert.equal(issueSession.path, '/u/user/s/session')
  assert.equal(researchSession.path, '/u/user/s/session')
  assert.equal(readWorkbenchSourceSurface(issueSession.state), 'issue')
  assert.equal(readWorkbenchSourceSurface(researchSession.state), 'research')
  assert.equal(readWorkbenchSourceSurface({ workbench: { sourceSurface: 'project' } }), null)
})

test('returnTo 仅接受站内工作台路径，并对非法值使用安全 fallback', () => {
  const fallback = '/u/user/s/session'
  assert.equal(safeWorkbenchReturnTo('/u/user/p/project?view=graph'), '/u/user/p/project?view=graph')
  assert.equal(safeWorkbenchReturnTo('https://evil.example/u/user', fallback), fallback)
  assert.equal(safeWorkbenchReturnTo('//evil.example/u/user', fallback), fallback)
  assert.equal(safeWorkbenchReturnTo('/admin', fallback), fallback)
  assert.equal(safeWorkbenchReturnTo('/u/user\\@evil.example', fallback), fallback)
  assert.equal(readWorkbenchReturnTo('?returnTo=https%3A%2F%2Fevil.example', fallback), fallback)
  assert.equal(returnNavigation('//evil.example', fallback)?.path, fallback)
})

test('Home、Session、Project 三种来源都生成可刷新且语义明确的高级页返回链', () => {
  const homeSource = '/u/alice?view=projects&panel=skills'
  const projectFromHome = projectNavigation('alice', 'project', { returnTo: homeSource })
  assert.equal(readWorkbenchReturnTo(projectFromHome.path.split('?')[1] || ''), homeSource)
  assert.deepEqual(advancedPageReturnNavigation(homeSource), {
    path: homeSource,
    state: { workbench: { focus: 'composer' } },
  })
  assert.equal(workbenchReturnLabel(homeSource), '返回工作台')

  const sessionSource = sessionPath('alice', 'session')
  const projectFromSession = projectNavigation('alice', 'project', { returnTo: sessionSource })
  assert.equal(readWorkbenchReturnTo(projectFromSession.path.split('?')[1] || ''), sessionSource)
  assert.equal(advancedPageReturnNavigation(sessionSource)?.path, sessionSource)
  assert.equal(workbenchReturnLabel(sessionSource), '返回来源会话')

  const projectSource = projectFromHome.path
  const issueFromProject = issueNavigation('alice', 'project', 'issue', { returnTo: projectSource })
  const researchFromProject = researchNavigation('alice', 'project', 'research', { returnTo: projectSource })
  assert.equal(readWorkbenchReturnTo(issueFromProject.path.split('?')[1] || ''), projectSource)
  assert.equal(readWorkbenchReturnTo(researchFromProject.path.split('?')[1] || ''), projectSource)
  assert.deepEqual(advancedPageReturnNavigation(projectSource), {
    path: projectSource,
    state: { workbench: { focus: 'main-heading' } },
  })
  assert.equal(workbenchReturnLabel(projectSource), '返回来源项目')
})

test('深链接无需 history state，按页面层级获得稳定 fallback', () => {
  const projectFallback = '/u/alice/p/project'
  assert.deepEqual(advancedPageReturnNavigation('', projectFallback), {
    path: projectFallback,
    state: { workbench: { focus: 'main-heading' } },
  })
  assert.equal(
    workbenchLocationPath({ pathname: '/u/alice/p/project', search: '?returnTo=%2Fu%2Falice', hash: '#settings' }),
    '/u/alice/p/project?returnTo=%2Fu%2Falice#settings',
  )
})

test('旧 ?session= 链接读取后跳短路由，并保留其余 query/hash', () => {
  assert.equal(
    legacySessionRedirect('user', '?session=session%2F1&view=graph&match=entry', '#message'),
    '/u/user/s/session%2F1?view=graph&match=entry#message',
  )
  assert.equal(legacySessionRedirect('user', '?view=graph'), null)
})

test('navigateToWorkbench 同时传递 path、replace 与导航 state', () => {
  const calls = []
  navigateToWorkbench((path, options) => calls.push({ path, options }), sessionNavigation('u', 's'), { replace: true })
  assert.deepEqual(calls, [{
    path: '/u/u/s/s',
    options: { replace: true, state: { workbench: { focus: 'composer' } } },
  }])
})

test('对象导航先退出中心工具、清选择，再改短路由', () => {
  const events = []
  const originalWindow = globalThis.window
  globalThis.window = {
    dispatchEvent(event) {
      events.push(event.type)
      return true
    },
  }
  try {
    const calls = []
    navigateToWorkbenchObject((path) => calls.push(path), sessionNavigation('u', 'next'))
    assert.deepEqual(events, [
      WORKBENCH_EXIT_CENTER_TOOL_EVENT,
      WORKBENCH_CLEAR_OBJECT_SELECTION_EVENT,
    ])
    assert.deepEqual(calls, ['/u/u/s/next'])
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})
