import { driver, type DriveStep, type Driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import {
  BIRTHDAY_DEMO_TOUR_EVENT,
  createBirthdayDemoState,
  readBirthdayDemoState,
  writeBirthdayDemoState,
} from './birthday-demo'
import {
  PROJECT_IMPORT_DEMO_TOUR_EVENT,
  createProjectImportDemoState,
  readProjectImportDemoState,
  writeProjectImportDemoState,
  type ProjectImportDemoState,
} from './project-import-demo'
import {
  CONTEXT_SETUP_DEMO_TOUR_EVENT,
  createContextSetupDemoState,
  readContextSetupDemoState,
  writeContextSetupDemoState,
  type ContextSetupDemoState,
} from './context-setup-demo'
import {
  EXTENSION_DEMO_TOUR_EVENT,
  createExtensionDemoState,
  readExtensionDemoState,
  writeExtensionDemoState,
} from './extension-demo'
import {
  SELF_EVOLVE_DEMO_TOUR_EVENT,
  createSelfEvolveDemoState,
  readSelfEvolveDemoState,
  writeSelfEvolveDemoState,
  type SelfEvolveDemoState,
} from './self-evolve-demo'
import {
  LOGO_REVIEW_DEMO_TOUR_EVENT,
  createLogoReviewDemoState,
  readLogoReviewDemoState,
  writeLogoReviewDemoState,
  type LogoReviewDemoState,
} from './logo-review-demo'
import { readActiveGuidedDemo, type ActiveGuidedDemo, type GuidedDemoState } from './guided-demo'

export { BIRTHDAY_DEMO_TOUR_EVENT }
export { PROJECT_IMPORT_DEMO_TOUR_EVENT }
export { CONTEXT_SETUP_DEMO_TOUR_EVENT }
export { SELF_EVOLVE_DEMO_TOUR_EVENT }
export { EXTENSION_DEMO_TOUR_EVENT }
export { LOGO_REVIEW_DEMO_TOUR_EVENT }
export const FIRST_ISSUE_TOUR_EVENT = 'imac:first-login-guide:start'
export const GUIDED_DEMO_TOUR_EVENT = 'imac:guided-demo-tour:start'

const WAIT_STEP_MS = 80

function guideParagraphs(...paragraphs: string[]) {
  return paragraphs.join('\n')
}

type TourSegment =
  | 'home'
  | 'project-form'
  | 'project'
  | 'issue-form'
  | 'issue-created'
  | 'session-form'
  | 'session-preview'
  | 'session-start'
  | 'session-chat'
  | 'session-complete'
  | 'project-cleanup'
  | 'project-delete-form'
  | 'remote-compute'
  | 'logo-review-project'
  | 'logo-review-issue'
  | 'logo-review-session'
  | 'logo-review-extension-project'
  | 'logo-review-cleanup'

let activeDriver: Driver | null = null
let lastRunKey = ''
let preparing = false
let preserveActiveOnDestroy = false

function destroyActiveTour(resetLastRun = false) {
  if (activeDriver?.isActive()) {
    preserveActiveOnDestroy = true
    activeDriver.destroy()
  }
  activeDriver = null
  if (resetLastRun) lastRunKey = ''
}

function dispatchGuidedDemoTour(force = true) {
  window.dispatchEvent(new CustomEvent(GUIDED_DEMO_TOUR_EVENT, { detail: { force } }))
}

function deactivateActiveDemoTour() {
  const demo = readActiveGuidedDemo()
  if (demo?.kind === 'birthday') {
    const state = readBirthdayDemoState()
    if (state?.active) writeBirthdayDemoState({ ...state, active: false })
  } else if (demo?.kind === 'project-import') {
    const state = readProjectImportDemoState()
    if (state?.active) writeProjectImportDemoState({ ...state, active: false })
  } else if (demo?.kind === 'context-setup') {
    const state = readContextSetupDemoState()
    if (state?.active) writeContextSetupDemoState({ ...state, active: false })
  } else if (demo?.kind === 'self-evolve') {
    const state = readSelfEvolveDemoState()
    if (state?.active) writeSelfEvolveDemoState({ ...state, active: false })
  } else if (demo?.kind === 'extension') {
    const state = readExtensionDemoState()
    if (state?.active) writeExtensionDemoState({ ...state, active: false })
  } else if (demo?.kind === 'logo-review') {
    const state = readLogoReviewDemoState()
    if (state?.active) writeLogoReviewDemoState({ ...state, active: false })
  }
  lastRunKey = ''
}

export function startBirthdayDemoTour() {
  const importState = readProjectImportDemoState()
  const contextState = readContextSetupDemoState()
  const selfEvolveState = readSelfEvolveDemoState()
  const extensionState = readExtensionDemoState()
  const reviewState = readLogoReviewDemoState()
  if (importState?.active) writeProjectImportDemoState({ ...importState, active: false })
  if (contextState?.active) writeContextSetupDemoState({ ...contextState, active: false })
  if (selfEvolveState?.active) writeSelfEvolveDemoState({ ...selfEvolveState, active: false })
  if (extensionState?.active) writeExtensionDemoState({ ...extensionState, active: false })
  if (reviewState?.active) writeLogoReviewDemoState({ ...reviewState, active: false })
  const current = readBirthdayDemoState()
  const base = current?.active ? current : createBirthdayDemoState()
  writeBirthdayDemoState({
    ...base,
    active: true,
    startedAt: base.startedAt || Date.now(),
  })
  lastRunKey = ''
  dispatchGuidedDemoTour(true)
  window.dispatchEvent(new CustomEvent(BIRTHDAY_DEMO_TOUR_EVENT, { detail: { force: true } }))
}

export function startFirstIssueTour() {
  startBirthdayDemoTour()
  window.dispatchEvent(new CustomEvent(FIRST_ISSUE_TOUR_EVENT, { detail: { force: true } }))
}

export function startProjectImportDemoTour() {
  const birthdayState = readBirthdayDemoState()
  const contextState = readContextSetupDemoState()
  const selfEvolveState = readSelfEvolveDemoState()
  const extensionState = readExtensionDemoState()
  const reviewState = readLogoReviewDemoState()
  if (birthdayState?.active) writeBirthdayDemoState({ ...birthdayState, active: false })
  if (contextState?.active) writeContextSetupDemoState({ ...contextState, active: false })
  if (selfEvolveState?.active) writeSelfEvolveDemoState({ ...selfEvolveState, active: false })
  if (extensionState?.active) writeExtensionDemoState({ ...extensionState, active: false })
  if (reviewState?.active) writeLogoReviewDemoState({ ...reviewState, active: false })
  const current = readProjectImportDemoState()
  const base = current?.active ? current : createProjectImportDemoState()
  writeProjectImportDemoState({
    ...base,
    active: true,
    startedAt: base.startedAt || Date.now(),
  })
  lastRunKey = ''
  dispatchGuidedDemoTour(true)
  window.dispatchEvent(new CustomEvent(PROJECT_IMPORT_DEMO_TOUR_EVENT, { detail: { force: true } }))
}

export function startContextSetupDemoTour() {
  const birthdayState = readBirthdayDemoState()
  const importState = readProjectImportDemoState()
  const extensionState = readExtensionDemoState()
  const selfEvolveState = readSelfEvolveDemoState()
  const reviewState = readLogoReviewDemoState()
  if (birthdayState?.active) writeBirthdayDemoState({ ...birthdayState, active: false })
  if (importState?.active) writeProjectImportDemoState({ ...importState, active: false })
  if (extensionState?.active) writeExtensionDemoState({ ...extensionState, active: false })
  if (selfEvolveState?.active) writeSelfEvolveDemoState({ ...selfEvolveState, active: false })
  if (reviewState?.active) writeLogoReviewDemoState({ ...reviewState, active: false })
  const current = readContextSetupDemoState()
  const base = current?.active ? current : createContextSetupDemoState()
  writeContextSetupDemoState({
    ...base,
    active: true,
    startedAt: base.startedAt || Date.now(),
  })
  lastRunKey = ''
  dispatchGuidedDemoTour(true)
  window.dispatchEvent(new CustomEvent(CONTEXT_SETUP_DEMO_TOUR_EVENT, { detail: { force: true } }))
}

export function startSelfEvolveDemoTour(patch: Partial<SelfEvolveDemoState> = {}) {
  const birthdayState = readBirthdayDemoState()
  const importState = readProjectImportDemoState()
  const contextState = readContextSetupDemoState()
  const extensionState = readExtensionDemoState()
  const reviewState = readLogoReviewDemoState()
  if (birthdayState?.active) writeBirthdayDemoState({ ...birthdayState, active: false })
  if (importState?.active) writeProjectImportDemoState({ ...importState, active: false })
  if (contextState?.active) writeContextSetupDemoState({ ...contextState, active: false })
  if (extensionState?.active) writeExtensionDemoState({ ...extensionState, active: false })
  if (reviewState?.active) writeLogoReviewDemoState({ ...reviewState, active: false })
  const current = readSelfEvolveDemoState()
  const base = current?.active ? current : createSelfEvolveDemoState()
  writeSelfEvolveDemoState({
    ...base,
    ...patch,
    active: true,
    startedAt: base.startedAt || Date.now(),
  })
  lastRunKey = ''
  dispatchGuidedDemoTour(true)
  window.dispatchEvent(new CustomEvent(SELF_EVOLVE_DEMO_TOUR_EVENT, { detail: { force: true } }))
}

export function startExtensionDemoTour() {
  const birthdayState = readBirthdayDemoState()
  const importState = readProjectImportDemoState()
  const contextState = readContextSetupDemoState()
  const selfEvolveState = readSelfEvolveDemoState()
  const reviewState = readLogoReviewDemoState()
  if (birthdayState?.active) writeBirthdayDemoState({ ...birthdayState, active: false })
  if (importState?.active) writeProjectImportDemoState({ ...importState, active: false })
  if (contextState?.active) writeContextSetupDemoState({ ...contextState, active: false })
  if (selfEvolveState?.active) writeSelfEvolveDemoState({ ...selfEvolveState, active: false })
  if (reviewState?.active) writeLogoReviewDemoState({ ...reviewState, active: false })
  const current = readExtensionDemoState()
  const base = current?.active ? current : createExtensionDemoState()
  writeExtensionDemoState({
    ...base,
    active: true,
    startedAt: base.startedAt || Date.now(),
  })
  lastRunKey = ''
  dispatchGuidedDemoTour(true)
  window.dispatchEvent(new CustomEvent(EXTENSION_DEMO_TOUR_EVENT, { detail: { force: true } }))
}

export function startLogoReviewDemoTour(patch: Partial<LogoReviewDemoState> = {}) {
  const birthdayState = readBirthdayDemoState()
  const importState = readProjectImportDemoState()
  const contextState = readContextSetupDemoState()
  const selfEvolveState = readSelfEvolveDemoState()
  const extensionState = readExtensionDemoState()
  if (birthdayState?.active) writeBirthdayDemoState({ ...birthdayState, active: false })
  if (importState?.active) writeProjectImportDemoState({ ...importState, active: false })
  if (contextState?.active) writeContextSetupDemoState({ ...contextState, active: false })
  if (selfEvolveState?.active) writeSelfEvolveDemoState({ ...selfEvolveState, active: false })
  if (extensionState?.active) writeExtensionDemoState({ ...extensionState, active: false })
  const base = createLogoReviewDemoState()
  writeLogoReviewDemoState({
    ...base,
    ...patch,
    active: true,
    startedAt: Date.now(),
  })
  lastRunKey = ''
  dispatchGuidedDemoTour(true)
  window.dispatchEvent(new CustomEvent(LOGO_REVIEW_DEMO_TOUR_EVENT, { detail: { force: true } }))
}

export function stopBirthdayDemoTour() {
  const state = readBirthdayDemoState()
  if (state?.active) writeBirthdayDemoState({ ...state, active: false })
  destroyActiveTour(true)
}

export function stopProjectImportDemoTour() {
  const state = readProjectImportDemoState()
  if (state?.active) writeProjectImportDemoState({ ...state, active: false })
  destroyActiveTour(true)
}

export function stopContextSetupDemoTour() {
  const state = readContextSetupDemoState()
  if (state?.active) writeContextSetupDemoState({ ...state, active: false })
  destroyActiveTour(true)
}

export function stopSelfEvolveDemoTour() {
  const state = readSelfEvolveDemoState()
  if (state?.active) writeSelfEvolveDemoState({ ...state, active: false })
  destroyActiveTour(true)
}

export function stopExtensionDemoTour() {
  const state = readExtensionDemoState()
  if (state?.active) writeExtensionDemoState({ ...state, active: false })
  destroyActiveTour(true)
}

export function stopLogoReviewDemoTour() {
  const state = readLogoReviewDemoState()
  if (state?.active) writeLogoReviewDemoState({ ...state, active: false })
  destroyActiveTour(true)
}

export async function startIntroTour() {
  deactivateActiveDemoTour()
  destroyActiveTour(true)
  await waitForElement('[data-tour="user-projects-sidebar"]', 4200)
  await waitForElement('[data-tour="top-guide-help"]', 1800)
  await waitForAnyElement([
    '[data-tour="user-project-card"]',
    '[data-tour="user-empty-create-project"]',
    '[data-tour="user-new-project"]',
  ], 1800)

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="top-nav-brand"]', {
    popover: {
      title: '这里是工作台',
      description: guideParagraphs(
        '莫比乌斯把智能体工作放进项目里。',
        '你可以在这里查看、创建和继续项目。'
      ),
      nextBtnText: '看项目列表',
      doneBtnText: '完成认识',
      side: 'bottom',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="user-projects-sidebar"]', {
    popover: {
      title: '项目放代码和资料',
      description: guideParagraphs(
        '左侧是你能进入的项目。',
        '项目是一块工作空间，代码、背景资料和项目规则都放在这里。'
      ),
      nextBtnText: '看项目卡片',
      doneBtnText: '完成认识',
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="user-projects-main"]', {
    popover: {
      title: '项目卡片',
      description: guideParagraphs(
        '中间展示项目摘要和入口。',
        '点进项目后，可以继续看任务单、研究和项目资料。'
      ),
      nextBtnText: '看新建入口',
      doneBtnText: '完成认识',
      side: 'left',
      align: 'start',
    },
  })
  const newProjectSelector = firstPresent([
    '[data-tour="user-empty-create-project"]',
    '[data-tour="user-new-project"]',
  ])
  if (newProjectSelector) {
    addStepIfPresent(steps, newProjectSelector, {
      popover: {
        title: '从新建项目开始',
        description: guideParagraphs(
          '真正开工前，先创建项目。',
          '后面的任务单和执行记录都会挂在项目下面。'
        ),
        nextBtnText: '看引导入口',
        doneBtnText: '完成认识',
        side: newProjectSelector.includes('empty') ? 'top' : 'left',
        align: 'center',
      },
    })
  }
  addStepIfPresent(steps, '[data-tour="top-guide-help"]', {
    popover: {
      title: '随时回来学习',
      description: guideParagraphs(
        '忘了流程时，从这里重新打开引导中心。',
        '你可以按当前目标选择不同路线。'
      ),
      nextBtnText: '看系统状态',
      doneBtnText: '完成认识',
      side: 'bottom',
      align: 'end',
    },
  })
  addStepIfPresent(steps, '[data-tour="top-system-status"]', {
    popover: {
      title: '先看系统是否正常',
      description: guideParagraphs(
        '这里显示服务状态和版本。',
        '页面卡顿或刚重启时，可以先看这里。'
      ),
      nextBtnText: '看外观设置',
      doneBtnText: '完成认识',
      side: 'bottom',
      align: 'end',
    },
  })
  addStepIfPresent(steps, '[data-tour="top-theme-toggle"]', {
    popover: {
      title: '切换外观',
      description: guideParagraphs(
        '这里切换浅色、深色和紫色模式。',
        '它只影响页面外观，不会改项目内容。'
      ),
      nextBtnText: '看用户菜单',
      doneBtnText: '完成认识',
      side: 'bottom',
      align: 'end',
    },
  })
  addStepIfPresent(steps, '[data-tour="top-user-menu"]', {
    popover: {
      title: '个人设置',
      description: guideParagraphs(
        '这里进入个人设置。',
        '管理员也可以从这里打开管理中心。'
      ),
      doneBtnText: '完成认识',
      side: 'bottom',
      align: 'end',
    },
  })

  return launchDriver(steps)
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms))
}

async function waitForElement(selector: string, timeoutMs = 2600) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const el = document.querySelector(selector)
    if (el) return el
    await delay(WAIT_STEP_MS)
  }
  return null
}

async function waitForAnyElement(selectors: string[], timeoutMs = 2200) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const found = selectors.find(selector => document.querySelector(selector))
    if (found) return found
    await delay(WAIT_STEP_MS)
  }
  return ''
}

function has(selector: string) {
  return !!document.querySelector(selector)
}

function clickIfPresent(selector: string) {
  const el = document.querySelector<HTMLElement>(selector)
  if (!el) return false
  el.click()
  return true
}

function addStepIfPresent(steps: DriveStep[], selector: string, step: Omit<DriveStep, 'element'>) {
  if (!has(selector)) return
  const originalOnHighlightStarted = step.onHighlightStarted
  steps.push({
    element: selector,
    ...step,
    onHighlightStarted: (element, activeStep, opts) => {
      element?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
      window.requestAnimationFrame(() => opts.driver.refresh())
      originalOnHighlightStarted?.(element, activeStep, opts)
    },
  })
}

// 无条件 push 一个 step (不因元素当前不存在而跳过). 用于"点切换→等挂载"链式 step 的目标 step:
// 此刻元素还没挂载 (条件渲染), 但 onNextClick 的 poll 会等它出现后才 moveNext, 故切过去时元素已存在.
// 复用 addStepIfPresent 的 onHighlightStarted (scrollIntoView + refresh) 逻辑.
function pushStepAlways(steps: DriveStep[], selector: string, step: Omit<DriveStep, 'element'>) {
  const originalOnHighlightStarted = step.onHighlightStarted
  steps.push({
    element: selector,
    ...step,
    onHighlightStarted: (element, activeStep, opts) => {
      element?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
      window.requestAnimationFrame(() => opts.driver.refresh())
      originalOnHighlightStarted?.(element, activeStep, opts)
    },
  })
}

function firstPresent(selectors: string[]) {
  return selectors.find(selector => has(selector)) || ''
}

function clickAfterTour(selector: string, resetLastRun = true) {
  return (_element: Element | undefined, _step: DriveStep, opts: { driver: Driver }) => {
    preserveActiveOnDestroy = true
    opts.driver.destroy()
    if (resetLastRun) lastRunKey = ''
    window.setTimeout(() => {
      clickIfPresent(selector)
      scheduleGuidedDemoTourRerun()
    }, 80)
  }
}

function scheduleGuidedDemoTourRerun() {
  ;[700, 1400, 2600, 4200].forEach(delayMs => {
    window.setTimeout(() => {
      dispatchGuidedDemoTour(false)
    }, delayMs)
  })
}

function markContextRemoteReviewedAndClick(selector: string) {
  return (_element: Element | undefined, _step: DriveStep, opts: { driver: Driver }) => {
    const state = readContextSetupDemoState()
    if (state?.active) writeContextSetupDemoState({ ...state, preparedAt: Date.now() })
    preserveActiveOnDestroy = true
    opts.driver.destroy()
    lastRunKey = ''
    window.setTimeout(() => {
      clickIfPresent(selector)
      scheduleGuidedDemoTourRerun()
    }, 80)
  }
}

function addActionStepIfPresent(
  steps: DriveStep[],
  selector: string,
  step: Omit<DriveStep, 'element'>,
  actionSelector = selector,
  resetLastRun = true,
) {
  if (!has(selector)) return
  steps.push({
    element: selector,
    ...step,
    popover: {
      ...step.popover,
      onNextClick: clickAfterTour(actionSelector, resetLastRun),
    },
  })
}

function addClickNextStepIfPresent(
  steps: DriveStep[],
  selector: string,
  step: Omit<DriveStep, 'element'>,
  actionSelector = selector,
) {
  if (!has(selector)) return
  addStepIfPresent(steps, selector, {
    ...step,
    popover: {
      ...step.popover,
      onNextClick: (_element, _step, opts) => {
        clickIfPresent(actionSelector)
        window.setTimeout(() => opts.driver.moveNext(), 80)
      },
    },
  })
}

function addImmediateActionStepIfPresent(
  steps: DriveStep[],
  selector: string,
  step: Omit<DriveStep, 'element'>,
  actionSelector = selector,
  resetLastRun = true,
  rerunAfterClick = true,
) {
  if (!has(selector)) return
  addStepIfPresent(steps, selector, {
    ...step,
    popover: {
      ...step.popover,
      onNextClick: (_element, _step, opts) => {
        clickIfPresent(actionSelector)
        preserveActiveOnDestroy = true
        opts.driver.destroy()
        if (resetLastRun) lastRunKey = ''
        if (rerunAfterClick) scheduleGuidedDemoTourRerun()
      },
    },
  })
}

// 强制点击步: 隐藏 popover 的"下一步"按钮, 用户必须点击高亮元素才前进.
// 实现要点: driver.js 的 SVG stage 对位于滚动容器 (overflow-y-auto) 内的元素会拦截原生点击
// (elementFromPoint 命中 svg path), 导致点元素反而触发 driver 的 overlay-close (引导被销毁).
// 故不监听元素 click, 改在 document capture 阶段按点击坐标 hit-test 高亮元素 boundingRect:
//   - 落在 popover 内 → 放行 (让 close/prev 按钮正常工作)
//   - 落在高亮元素 rect 内 → 前进 (moveNext / done 时 destroy)
//   - 落在 overlay → 阻止 driver close, 引导保留 (强制用户点高亮处)
// done=true 用于最后一步: 点击后销毁引导.
let activeClickAdvanceHandler: ((e: MouseEvent) => void) | null = null
function clearClickAdvanceHandler() {
  if (activeClickAdvanceHandler) {
    document.removeEventListener('click', activeClickAdvanceHandler, true)
    activeClickAdvanceHandler = null
  }
}

function addClickToAdvanceStep(
  steps: DriveStep[],
  selector: string,
  popover: { title: string; description: string; doneBtnText?: string; side?: any; align?: any },
  opts?: { done?: boolean },
) {
  if (!has(selector)) return
  const isDone = !!opts?.done
  steps.push({
    element: selector,
    popover: {
      title: popover.title,
      description: popover.description,
      popoverClass: 'imac-driver-popover imac-driver-click-advance',
      side: popover.side,
      align: popover.align,
      doneBtnText: popover.doneBtnText,
    } as any,
    onHighlightStarted: (element: Element | undefined, _activeStep: DriveStep | undefined, dOpts: { driver: Driver }) => {
      element?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
      window.requestAnimationFrame(() => { try { dOpts.driver.refresh() } catch {} })
      clearClickAdvanceHandler()
      const handler = (e: MouseEvent) => {
        const target = e.target as Element | null
        if (target?.closest?.('.driver-popover')) return // popover 内 (close/prev 按钮) 放行
        const el = document.querySelector(selector) as HTMLElement | null
        if (!el) return
        const r = el.getBoundingClientRect()
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
        // 命中与否都拦截: capture 阶段 stopImmediatePropagation 阻止 bubble 阶段的 driver overlay-close.
        e.stopImmediatePropagation()
        e.preventDefault()
        if (!inside) return // 点 overlay: 仅阻止 close, 引导保留
        clearClickAdvanceHandler()
        window.setTimeout(() => {
          try {
            if (isDone) dOpts.driver.destroy()
            else dOpts.driver.moveNext()
          } catch {}
        }, 60)
      }
      activeClickAdvanceHandler = handler
      document.addEventListener('click', handler, true)
    },
  } as any)
}

function launchDriver(steps: DriveStep[], onDestroyed?: () => void, opts?: { disableOverlayClose?: boolean }) {
  if (!steps.length) return false

  // disableOverlayClose (allowClose:false) 时, driver.js 会连带把 X 关闭按钮从 showButtons 里剔除 →
  // closeButton.display='none'. 这会让引导失去退出入口: 强制点击步一旦高亮元素缺失/不可点,
  // 用户只能反复点"上一步"而死循环 (用户报的"只有上一步, 没有下一步, 进行不下去").
  // 这里在每次 popover 渲染后强制把关闭按钮显示回来, 保证引导恒定有退出备选项.
  // 该回调对所有走 launchDriver 的引导通用 (web 与桌面端共享前端, 桌面端同样受益, 不影响其他引导).
  const forceCloseButton = !!opts?.disableOverlayClose
  let currentDriver: Driver | null = null
  currentDriver = driver({
    animate: true,
    smoothScroll: true,
    allowClose: !opts?.disableOverlayClose,
    allowKeyboardControl: true,
    overlayColor: '#020617',
    overlayOpacity: 0.58,
    stagePadding: 8,
    stageRadius: 8,
    popoverClass: 'imac-driver-popover',
    showButtons: ['previous', 'next', 'close'],
    showProgress: true,
    progressText: '{{current}} / {{total}}',
    nextBtnText: '下一步',
    prevBtnText: '上一步',
    doneBtnText: '完成',
    onPopoverRender: (popover: any) => {
      if (forceCloseButton && popover?.closeButton) {
        popover.closeButton.style.display = 'block'
      }
    },
    onCloseClick: (_element, _step, opts) => {
      deactivateActiveDemoTour()
      opts.driver.destroy()
    },
    onDestroyed: () => {
      const shouldPreserveActive = preserveActiveOnDestroy
      preserveActiveOnDestroy = false
      if (!shouldPreserveActive) deactivateActiveDemoTour()
      if (activeDriver === currentDriver) activeDriver = null
      clearClickAdvanceHandler()
      onDestroyed?.()
    },
  })

  currentDriver.setSteps(steps)
  activeDriver = currentDriver
  currentDriver.drive()
  return true
}

function pathContainsId(pathname: string, kind: 'p' | 'i', id?: string) {
  return !!id && new RegExp(`/${kind}/${id}(?:/|$)`).test(pathname)
}

function activeDemoOrBirthday(): ActiveGuidedDemo {
  return readActiveGuidedDemo() || { kind: 'birthday', state: createBirthdayDemoState() }
}

function isProjectImportTour(demo: ActiveGuidedDemo) {
  return demo.kind === 'project-import'
}

function isContextSetupTour(demo: ActiveGuidedDemo) {
  return demo.kind === 'context-setup'
}

function isSelfEvolveTour(demo: ActiveGuidedDemo) {
  return demo.kind === 'self-evolve'
}

function isExtensionTour(demo: ActiveGuidedDemo) {
  return demo.kind === 'extension' || demo.kind === 'birthday'
}

function isLogoReviewTour(demo: ActiveGuidedDemo) {
  return demo.kind === 'logo-review'
}

function projectImportState(state: GuidedDemoState) {
  return state as ProjectImportDemoState
}

function contextSetupState(state: GuidedDemoState) {
  return state as ContextSetupDemoState
}

function selfEvolveState(state: GuidedDemoState) {
  return state as SelfEvolveDemoState
}

function logoReviewState(state: GuidedDemoState) {
  return state as LogoReviewDemoState
}

function detectSegment(pathname: string): TourSegment | null {
  const demo = readActiveGuidedDemo()
  const state = demo?.state
  const sessionParam = new URLSearchParams(window.location.search).get('session') || ''

  if (has('[data-tour="delete-project-modal"]')) return 'project-delete-form'
  if (demo?.kind === 'logo-review' && state) {
    const review = logoReviewState(state)
    if (/\/i\/[^/]+/.test(pathname)) {
      return sessionParam ? 'logo-review-session' : 'logo-review-issue'
    }
    if (pathContainsId(pathname, 'p', review.extensionProjectId)) return 'logo-review-extension-project'
    if (review.cleanupProjectId && pathContainsId(pathname, 'p', review.cleanupProjectId)) return 'logo-review-cleanup'
    if (pathContainsId(pathname, 'p', review.projectId)) return 'logo-review-project'
    return null
  }
  if (demo?.kind === 'context-setup' && has('[data-tour="remote-compute-modal"]')) return 'remote-compute'
  if (has('[data-tour="session-start-modal"]')) return 'session-start'
  if (has('[data-tour="session-modal"]')) {
    return has('[data-tour="session-preview"]') ? 'session-preview' : 'session-form'
  }
  if (has('[data-tour="issue-modal"]')) return 'issue-form'
  if (has('[data-tour="project-modal"]')) return 'project-form'

  if (/\/i\/[^/]+/.test(pathname)) {
    if (has('[data-tour="session-chat-header"]')) return 'session-chat'
    if (sessionParam) return null
    if (state?.sessionId && state.sessionCompletedAt) return 'session-complete'
    if (state?.sessionId) return null
    return 'issue-created'
  }

  if (/\/p\/[^/]+/.test(pathname)) {
    if (demo?.kind !== 'self-evolve' && state?.sessionId && state.sessionCompletedAt && pathContainsId(pathname, 'p', state.projectId)) return 'project-cleanup'
    if (state?.sessionId && pathContainsId(pathname, 'p', state.projectId)) return null
    return 'project'
  }

  if (/^\/u\/[^/]+\/?$/.test(pathname)) return 'home'
  return null
}

async function runHomeSegment() {
  const demo = activeDemoOrBirthday()
  const state = demo.state
  const isImport = isProjectImportTour(demo)
  const isContext = isContextSetupTour(demo)
  const isExtension = isExtensionTour(demo)
  await waitForElement('[data-tour="user-new-project"]')
  await waitForAnyElement([
    '[data-tour="user-project-card"]',
    '[data-tour="user-empty-create-project"]',
  ], 1400)

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="user-projects-sidebar"]', {
    popover: {
      title: isContext ? '资料配置路线介绍' : isImport ? '导入代码需要先建项目' : isExtension ? '光点拓展演示路线' : '先完成一个小任务',
      description: isContext
        ? guideParagraphs(
          '莫比乌斯处理任务通常分三步：',
          '1. 项目放资料',
          '2. 任务单写目标',
          '3. 执行会话让智能体执行。',
          '这条路线会用莫比乌斯开发资料做例子。',
          '你会手动上传项目知识和项目方法，再看它们怎样进入新的执行会话。'
        )
        : isImport
          ? guideParagraphs(
            '导入代码前，先创建一个项目作为放代码和资料的地方。',
            '这条路线会演示两种真实入口：1. 通过公开 Git 仓库下载，2. 下载示例文件后用网页编辑器上传。'
          )
          : isExtension
          ? guideParagraphs(
            '这条路线会创建一个光点拓展演示项目。',
            '你会写任务单、创建执行会话，并让智能体检查和迭代原型。'
          )
          : guideParagraphs(
            '这条路线会创建一个演示项目。',
            '做完后，你会看到智能体改过的文件。'
          ),
      side: 'right',
      align: 'start',
    },
  })
  const newProjectSelector = firstPresent([
    '[data-tour="user-empty-create-project"]',
    '[data-tour="user-new-project"]',
  ])
  if (newProjectSelector) {
    addActionStepIfPresent(steps, newProjectSelector, {
      popover: {
        title: '创建一个入门项目',
        description: isContext
          ? guideParagraphs(
            '点击这里打开新建项目表单。',
            '项目知识保存项目事实和边界。',
            '项目方法保存遇到这类任务时的稳定做法。'
          )
          : isImport
            ? guideParagraphs(
              '点击这里打开新建项目表单。',
              '表单会预填一个待办事项示例项目的名称、描述和目录。',
              '这个示例文件少、入口清楚，既能练习网页上传，也能练习从公开仓库下载。',
              '学会这条流程后，换成自己的项目就是换资料来源和目录。'
            )
            : guideParagraphs(
              '点击这里打开新建项目表单。',
              isExtension ? '系统会预填光点标志空间案例的名称、描述和目录。' : '系统会预填小网页案例的名称、描述和目录。',
              '你只需要检查后创建。'
            ),
        doneBtnText: '打开表单',
        side: newProjectSelector.includes('empty') ? 'top' : 'left',
        align: 'center',
      },
    })
  }

  return launchDriver(steps)
}

async function runProjectFormSegment() {
  const demo = activeDemoOrBirthday()
  const state = demo.state
  const isImport = isProjectImportTour(demo)
  const isContext = isContextSetupTour(demo)
  const isExtension = isExtensionTour(demo)
  await waitForElement('[data-tour="project-modal"]')

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="project-modal"]', {
    popover: {
      title: '项目表单已经预填',
      description: isContext
        ? guideParagraphs(
          '项目是放资料的地方。',
          '这个项目会绑定到用户工作目录下的一处演示目录。',
          '点击创建时，系统只准备资料素材；项目知识和项目方法稍后手动上传。'
        )
        : isImport
          ? guideParagraphs(
            '项目是放资料和代码的地方。',
            '这个项目会绑定到用户工作目录下的一处导入目录。',
            '系统会准备真实上传样例，并预填公开仓库地址。',
            '这里演示网页编辑器上传和公开仓库下载两种常用入口。',
            '页面里的下载按钮只服务本次演示，普通项目不会显示。'
          )
          : guideParagraphs(
            '项目是放资料的地方。',
            '这个项目会绑定到用户工作目录下的一处演示目录。',
            isExtension ? '创建后会写入拓展原型、项目知识和拓展技能。' : '创建后会写入一个简单网页和项目说明。'
          ),
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-name-input"]', {
    popover: {
      title: '项目名称',
      description: `这里使用固定案例名「${state.projectName}」。它能帮你在项目列表里一眼识别这是演示项目。`,
      side: 'bottom',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-path-input"]', {
    popover: {
      title: '绑定目录',
      description: isContext
        ? guideParagraphs(
          '绑定目录是智能体读写文件的位置。',
          '这个案例会把资料素材和验证结果都放在这里。',
          '手动上传成功后，项目知识和项目方法会挂到这个项目下面。'
        )
        : isImport
          ? '项目绑定到用户工作目录下的一个普通子目录。导入已有项目时，先把代码放进这个目录，再让后续任务单和执行会话基于它工作。'
          : guideParagraphs(
            '绑定目录是智能体读写文件的位置。',
            '这个案例使用用户工作目录下的普通演示目录。',
            '它不会改你的真实项目目录。'
          ),
      side: 'bottom',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-worktree-toggle"]', {
    popover: {
      title: '本案例关闭工作树',
      description: isContext
        ? guideParagraphs(
          '工作树可以理解成给一次任务单独开一个代码副本。',
          '它适合风险较高的代码修改：任务失败时，不容易影响主目录。',
          '这个案例只验证资料是否注入，所以关闭工作树。'
        )
        : isImport
          ? guideParagraphs(
            '工作树可以理解成给一次任务单独开一个代码副本。',
            '导入第一步要把代码放进项目绑定目录本身，所以这里先关闭。',
            '后续修改代码时，再按任务风险决定是否打开。'
          )
          : guideParagraphs(
            '工作树可以理解成给一次任务单独开一个代码副本。',
            '它适合风险较高的代码修改：任务失败时，不容易影响主目录。',
            isExtension ? '这个案例只改演示目录里的原型文件，所以关闭工作树。' : '这个案例只改演示目录里的小网页文件，所以关闭工作树。'
          ),
      side: 'top',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-research-toggle"]', {
    popover: {
      title: '本案例不启用研究',
      description: isContext
        ? guideParagraphs(
          '研究适合较长的开放问题，例如比较方案、收集资料、跟踪结论。',
          '这个案例目标很明确：确认项目知识和项目方法会进入会话。',
          '它不是开放式调研，所以研究保持关闭。'
        )
        : isImport
          ? guideParagraphs(
            '研究适合较长的开放问题，例如比较方案、收集资料、跟踪结论。',
            '这个案例只是导入一个公开示例项目。',
            '它不是开放式调研，所以研究保持关闭。'
          )
          : guideParagraphs(
            '研究适合较长的开放问题，例如比较方案、收集资料、跟踪结论。',
            isExtension ? '这个案例目标明确：检查并迭代一个拓展原型。' : '这个案例目标明确：修改一个小网页。',
            '它不是开放式调研，所以研究保持关闭。'
          ),
      side: 'top',
      align: 'start',
    },
  })
  addActionStepIfPresent(steps, '[data-tour="project-submit"]', {
    popover: {
      title: '创建项目',
      description: isContext
        ? guideParagraphs(
          '点击创建后进入项目页。',
          '系统会准备真实资料文件。',
          '下一步先下载资料，再手动上传项目知识和项目方法。'
        )
        : isImport
          ? guideParagraphs(
            '点击创建后进入项目页。',
            '系统会写入一份可下载、可上传的真实样例文件。',
            '下一步先看上传入口，再创建一个带公开仓库地址的导入任务单。'
          )
          : isExtension
            ? '点击创建后进入项目页。系统会准备真实拓展原型、项目知识和拓展技能，下一步创建光点迭代任务单。'
            : '点击创建后进入项目页。系统会准备一个小网页，下一步创建修改任务单。',
      doneBtnText: '创建项目',
      side: 'top',
      align: 'center',
    },
  })

  return launchDriver(steps)
}

async function runContextSetupProjectSegment(demo: ActiveGuidedDemo) {
  const state = contextSetupState(demo.state)

  await waitForElement('[data-tour="project-settings-panel"]')
  await waitForAnyElement([
    '[data-tour="project-skill-manager"]',
    '[data-tour="project-memory-manager"]',
  ], 1800)

  const steps: DriveStep[] = []

  if (!state.memorySyncedAt) {
    addStepIfPresent(steps, '[data-tour="project-settings-panel"]', {
      popover: {
        title: '先准备真实资料',
        description: guideParagraphs(
          '项目已经创建，素材在演示目录里。',
          '本路线只演示下载后上传；项目知识也可以同步或复制。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addClickNextStepIfPresent(steps, '[data-tour="project-context-memory-download"]', {
      popover: {
        title: '下载项目知识',
        description: guideParagraphs(
          '点击这里下载项目知识文件。',
          '它记录莫比乌斯代码位置、验证命令和安全边界。'
        ),
        doneBtnText: '下载项目知识',
        side: 'bottom',
        align: 'center',
      },
    })
    addClickNextStepIfPresent(steps, '[data-tour="project-context-skill-download"]', {
      popover: {
        title: '下载方法文件',
        description: guideParagraphs(
          '点击这里下载方法文件。',
          '项目方法也可以上传、复制或从内置 Skill 导入。'
        ),
        doneBtnText: '下载方法文件',
        side: 'bottom',
        align: 'center',
      },
    })
    addStepIfPresent(steps, '[data-tour="project-memory-manager"]', {
      popover: {
        title: '上传项目知识',
        description: guideParagraphs(
          '项目知识保存项目事实和边界。',
          '上传刚下载的文件后，路线会进入方法导入步骤。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addImmediateActionStepIfPresent(steps, '[data-tour="project-memory-upload-knowledge"]', {
      popover: {
        title: '选择项目知识文件',
        description: guideParagraphs(
          '点击后选择刚下载的项目知识文件。',
          '文件上传并同步成功后，下一步才会继续。'
        ),
        doneBtnText: '选择文件',
        side: 'bottom',
        align: 'center',
      },
    }, '[data-tour="project-memory-upload-knowledge"]', true, false)
    return launchDriver(steps)
  }

  if (!state.skillImportedAt) {
    addStepIfPresent(steps, '[data-tour="project-memory-manager"]', {
      popover: {
        title: '项目知识已就绪',
        description: guideParagraphs(
          `这里已经有「${state.memoryName}」。`,
          '刚才上传的项目知识已经可用了。',
          '下一步导入一份项目方法。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addClickNextStepIfPresent(steps, '[data-tour="project-context-skill-download"]', {
      popover: {
        title: '下载方法文件',
        description: guideParagraphs(
          '如果刚才还没下载方法文件，现在从这里下载。',
          '方法文件保存的是开发莫比乌斯拓展的稳定做法。'
        ),
        doneBtnText: '下载方法文件',
        side: 'bottom',
        align: 'center',
      },
    })
    addStepIfPresent(steps, '[data-tour="project-skill-manager"]', {
      popover: {
        title: '上传项目方法',
        description: guideParagraphs(
          '项目方法保存可重复使用的做法。',
          '把刚下载的方法文件上传到这里，系统会导入到当前项目。',
          '导入成功后，才能创建使用这些资料的执行会话。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addImmediateActionStepIfPresent(steps, '[data-tour="project-skill-upload-file"]', {
      popover: {
        title: '选择方法文件',
        description: guideParagraphs(
          '点击后选择刚下载的方法文件。',
          '导入成功后，路线会继续到任务单区域。'
        ),
        doneBtnText: '选择文件',
        side: 'bottom',
        align: 'center',
      },
    }, '[data-tour="project-skill-upload-file"]', true, false)
    return launchDriver(steps)
  }

  await waitForElement('[data-tour="project-items-panel"]')
  clickIfPresent('[data-tour="project-issue-tab"]')
  await waitForAnyElement([
    '[data-tour="project-new-issue"]',
    '[data-tour="project-empty-create-issue"]',
    '[data-tour="project-sidebar-new-issue"]',
  ])

  addStepIfPresent(steps, '[data-tour="project-memory-manager"]', {
    popover: {
      title: '项目知识已导入',
      description: guideParagraphs(
        `这里会出现「${state.memoryName}」。`,
        '这说明项目背景已经挂到当前项目。',
        '后面只做一次小验证。'
      ),
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-skill-manager"]', {
    popover: {
      title: '项目方法已导入',
      description: guideParagraphs(
        `这里会出现「${state.skillName}」。`,
        '这说明项目方法已经挂到当前项目。',
        '接下来只确认它能进入执行会话。'
      ),
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-context-whitelist"]', {
    popover: {
      title: '个人资料筛选',
      description: guideParagraphs(
        '这个区域用于筛选个人资料。',
        '本案例先不调整这里。',
        '刚刚导入的项目资料会跟着当前项目进入后续会话。'
      ),
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-items-panel"]', {
    popover: {
      title: '做一次小验证',
      description: guideParagraphs(
        '右侧是任务单和研究区。',
        '这个案例不是开放式调研，所以研究区没有内容。',
        '接下来只创建一个小任务，确认刚导入的资料能被带入执行会话。'
      ),
      side: 'left',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-issue-tab"]', {
    popover: {
      title: '任务单写验证目标',
      description: guideParagraphs(
        '任务单这里只写一个简单验证目标。',
        '内容已经预填好，按默认创建即可。'
      ),
      side: 'bottom',
      align: 'start',
    },
  })
  const newIssueSelector = firstPresent([
    '[data-tour="project-new-issue"]',
    '[data-tour="project-empty-create-issue"]',
    '[data-tour="project-sidebar-new-issue"]',
  ])
  if (newIssueSelector) {
    addActionStepIfPresent(steps, newIssueSelector, {
      popover: {
        title: '新建验证任务',
        description: guideParagraphs(
          '点击这里打开任务单表单。',
          `标题和描述会自动填成「${state.issueTitle}」。`,
          '这一步不是重点，只是用来验证资料配置。'
        ),
        doneBtnText: '打开表单',
        side: newIssueSelector.includes('sidebar') ? 'right' : newIssueSelector.includes('empty') ? 'top' : 'left',
        align: newIssueSelector.includes('sidebar') ? 'start' : 'center',
      },
    })
  }

  return launchDriver(steps)
}

async function runProjectSegment() {
  const demo = activeDemoOrBirthday()
  const state = demo.state
  if (isContextSetupTour(demo)) return runContextSetupProjectSegment(demo)
  const isImport = isProjectImportTour(demo)
  const isSelfEvolve = isSelfEvolveTour(demo)
  const isExtension = isExtensionTour(demo)
  const importState = isImport ? projectImportState(state) : null
  const uploadSampleDownloaded = !!importState?.uploadSampleDownloadedAt
  const uploadSampleUploaded = !!importState?.uploadSampleUploadedAt
  const uploadSampleCleared = !!importState?.uploadSampleClearedAt
  await waitForElement('[data-tour="project-items-panel"]')
  clickIfPresent('[data-tour="project-issue-tab"]')
  await waitForAnyElement([
    '[data-tour="project-new-issue"]',
    '[data-tour="project-empty-create-issue"]',
    '[data-tour="project-sidebar-new-issue"]',
  ])

  const steps: DriveStep[] = []
  if (isImport && !uploadSampleDownloaded) {
    addStepIfPresent(steps, '[data-tour="project-settings-panel"]', {
      popover: {
        title: '先准备上传样例',
        description: guideParagraphs(
          '如果代码已经在本机，可以用网页编辑器把文件拖进项目目录。',
          `本案例准备了${importState?.uploadExampleName ? `「${importState.uploadExampleName}」` : '上传样例'}，用于真实体验这个流程。`,
          '这里出现的下载和清理按钮只属于本演示项目，普通项目不会显示。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addClickNextStepIfPresent(steps, '[data-tour="project-import-sample-download"]', {
      popover: {
        title: '下载真实上传样例',
        description: guideParagraphs(
          '点击这里会下载一个可解压的待办事项示例。',
          '下载后先解压。',
          '下一步会引导你把解压后的文件夹真实拖进网页编辑器。',
          '这个下载按钮是教学样例入口，只在当前演示项目显示。'
        ),
        doneBtnText: '下载样例',
        side: 'bottom',
        align: 'center',
      },
    })
    return launchDriver(steps)
  }

  if (isImport && !uploadSampleUploaded) {
    addStepIfPresent(steps, '[data-tour="project-settings-panel"]', {
      popover: {
        title: '现在真实上传',
        description: guideParagraphs(
          '样例已经下载。',
          '请先把压缩包解开，再打开网页代码编辑器。',
          '把解压后的文件夹拖进左侧资源管理器，看到文件出现在项目目录后再确认。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addClickNextStepIfPresent(steps, '[data-tour="vscode-open-button"]', {
      popover: {
        title: '打开网页代码编辑器',
        description: guideParagraphs(
          '点击这里打开当前项目目录。',
          '在新打开的编辑器里，把解压后的文件夹拖到左侧资源管理器。',
          '拖拽上传完成后，回到本页面点击“我已完成上传”。'
        ),
        doneBtnText: '打开编辑器',
        side: 'bottom',
        align: 'center',
      },
    })
    addImmediateActionStepIfPresent(steps, '[data-tour="project-import-confirm-upload-sample"]', {
      popover: {
        title: '确认上传完成',
        description: guideParagraphs(
          '只有真实上传完成后再点这里。',
          '系统会检查项目目录里是否出现上传样例。',
          '检查通过后，才会进入清空样例步骤。'
        ),
        doneBtnText: '我已上传',
        side: 'bottom',
        align: 'center',
      },
    }, '[data-tour="project-import-confirm-upload-sample"]', true, false)
    return launchDriver(steps)
  }

  if (isImport && !uploadSampleCleared) {
    addStepIfPresent(steps, '[data-tour="project-settings-panel"]', {
      popover: {
        title: '上传已确认',
        description: guideParagraphs(
          '网页编辑器上传方式已经真实走完。',
          '现在清空刚才上传的样例，避免它影响下一条公开仓库下载路径。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addImmediateActionStepIfPresent(steps, '[data-tour="project-import-clear-upload-sample"]', {
      popover: {
        title: '清空样例，继续下一种方式',
        description: guideParagraphs(
          '网页上传方式已经体验完。',
          '点击这里会清理刚才上传的样例文件，让演示目录回到可继续学习的状态。',
          '清理后，引导会进入公开仓库下载方式。'
        ),
        doneBtnText: '清空并继续',
        side: 'bottom',
        align: 'center',
      },
    }, '[data-tour="project-import-clear-upload-sample"]', true, false)
    return launchDriver(steps)
  }
  addStepIfPresent(steps, '[data-tour="project-items-panel"]', {
    popover: {
      title: isImport ? '第二条路径：公开仓库下载' : isSelfEvolve ? '自迭代任务区' : '项目里的任务区',
      description: isImport
        ? guideParagraphs(
          '现在走第二种常用入口：把公开仓库地址写进任务单。',
          '这条路径也要真实执行，不只是看表单。',
          '后面会创建执行会话，并点击立即执行，让智能体把公开仓库下载到项目目录。'
        )
        : isSelfEvolve
          ? guideParagraphs(
            '这里是莫比乌斯自身项目。',
            '这次只创建一个受控任务：更新一处演示时间文字。'
          )
        : guideParagraphs(
          '右侧列出当前项目的任务单和研究。',
          '这个案例目标很明确，只需要创建任务单。',
          isExtension ? '任务会让智能体检查并迭代拓展原型。' : '任务会让智能体修改一个小网页。'
        ),
      side: 'left',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-issue-tab"]', {
    popover: {
      title: isSelfEvolve ? '只写小任务' : isExtension ? '任务单写清目标' : '写清这次要做什么',
      description: isImport
        ? '导入类任务单要写清楚代码来源、目标目录、是否允许覆盖文件、完成后怎么看结果。执行会话再负责真正下载。'
        : isSelfEvolve
          ? '任务单会写明只改一处演示文字，并列出不能碰的边界。'
        : isExtension
          ? '任务单负责描述目标和验收标准；执行会话负责一次具体执行。先创建任务单，再创建执行会话。'
          : '任务单就是给智能体的工作说明。这次我们只让它修改一个小网页。',
      side: 'bottom',
      align: 'start',
    },
  })
  const newIssueSelector = firstPresent([
    '[data-tour="project-new-issue"]',
    '[data-tour="project-empty-create-issue"]',
    '[data-tour="project-sidebar-new-issue"]',
  ])
  if (newIssueSelector) {
    addActionStepIfPresent(steps, newIssueSelector, {
      popover: {
        title: isSelfEvolve ? '新建自迭代任务' : '新建演示任务单',
        description: isImport
          ? guideParagraphs(
            '点击这里打开任务单表单。',
            '标题和描述会自动填入待办事项示例项目的公开仓库地址。',
            `地址是：${importState?.gitUrl || ''}`
          )
          : isSelfEvolve
            ? guideParagraphs(
              '点击这里打开任务单表单。',
              `标题会自动填成「${state.issueTitle}」。`,
              '这次只改一处演示时间文字。'
            )
          : `点击这里打开任务单表单。标题和描述会自动填成「${state.issueTitle}」。`,
        doneBtnText: '打开表单',
        side: newIssueSelector.includes('sidebar') ? 'right' : newIssueSelector.includes('empty') ? 'top' : 'left',
        align: newIssueSelector.includes('sidebar') ? 'start' : 'center',
      },
    })
  }

  return launchDriver(steps)
}

async function runIssueFormSegment() {
  const demo = activeDemoOrBirthday()
  const isImport = isProjectImportTour(demo)
  const isContext = isContextSetupTour(demo)
  const isSelfEvolve = isSelfEvolveTour(demo)
  const isExtension = isExtensionTour(demo)
  const importState = isImport ? projectImportState(demo.state) : null
  await waitForElement('[data-tour="issue-modal"]')

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="issue-modal"]', {
    popover: {
      title: '任务单已经预填成具体案例',
      description: isContext
        ? guideParagraphs(
          '这里已经预填一个小验证任务。',
          '它只用来确认刚导入的项目知识和项目方法能进入执行会话。',
          '按默认内容创建即可。'
        )
        : isImport
          ? '这个任务单演示“把公开仓库地址写进任务，让智能体下载代码”。示例使用公开待办事项项目，不包含任何私人账号或内部路径。'
          : isSelfEvolve
          ? guideParagraphs(
            '任务单已经限定范围。',
            '智能体只允许更新一处演示时间文字。'
          )
          : isExtension
          ? guideParagraphs(
            '任务单写的是“要完成什么”。',
            '这个案例会让智能体检查现有原型。',
            '目标是改进画面效果、调节面板，并补充日志阅读说明。'
          )
          : guideParagraphs(
            '任务单写的是“要完成什么”。',
            '这个案例只让智能体修改一个小网页。',
            '按默认内容创建即可。'
          ),
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="issue-title-input"]', {
    popover: {
      title: '标题是任务目标',
      description: isContext
        ? guideParagraphs(
          '标题已经写好验证目标。',
          '不用在这里重新设计任务。'
        )
        : isSelfEvolve
          ? guideParagraphs(
            '标题保持固定。',
            '它说明这次只更新自迭代演示时间。'
          )
        : isImport
          ? '标题保持短而明确，让列表里一眼能看出这是一次项目导入任务。'
          : '标题保持短而明确，让列表里一眼能看懂要做什么。',
      side: 'bottom',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="issue-description-input"]', {
    popover: {
      title: isContext ? '任务描述' : isImport ? '描述写清下载地址和约束' : isSelfEvolve ? '描述写清边界' : '任务描述',
      description: isContext
        ? guideParagraphs(
          '描述已经写清输入文件和输出文件。',
          '重点是后面确认会话会带上刚导入的资料。'
        )
        : isImport
          ? `这里已经写入 ${importState?.gitUrl || '公开仓库地址'}，并明确“目录非空就下载到子目录”“不要使用私人凭据”“完成后说明查看方式”。`
          : isSelfEvolve
          ? guideParagraphs(
            '描述只允许修改引导中心的演示时间常量。',
            '如果找不到明确标记，智能体必须停止。'
          )
          : isExtension
          ? guideParagraphs(
            '这里描述你需要完成的任务内容。',
            '以本案例为例：写清要做一个光点标志空间。',
            '也要写清完成后怎么看结果。'
          )
          : guideParagraphs(
            '这里描述你需要完成的任务内容。',
            '以本案例为例：写清光点标志空间的视觉、交互和拓展结构要求。',
            '做完后要说明改了哪些文件，以及怎样查看成品拓展。'
          ),
      side: 'bottom',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="issue-worktree-toggle"]', {
    popover: {
      title: '本案例不使用工作树',
      description: isContext
        ? guideParagraphs(
          '这里是任务单级的工作树开关。',
          '打开后，执行会话会在单独副本里做事，更适合风险较高的代码修改。',
          '本案例只生成一个检查文件，所以关闭。'
        )
        : isImport
          ? guideParagraphs(
            '这里是任务单级的工作树开关。',
            '打开后，执行会话会在单独副本里做事。',
            '导入第一步要把已有代码放进项目绑定目录，所以这里关闭。'
          )
          : isSelfEvolve
          ? guideParagraphs(
            '这里保持关闭。',
            '这次只改一个受控常量，范围已经写在任务单里。'
          )
          : guideParagraphs(
            '这里是任务单级的工作树开关。',
            '打开后，执行会话会在单独副本里做事。',
            '本案例只改演示目录里的拓展原型文件，所以关闭。'
          ),
      side: 'top',
      align: 'start',
    },
  })
  addActionStepIfPresent(steps, '[data-tour="issue-submit"]', {
    popover: {
      title: '创建任务单',
      description: isContext
        ? guideParagraphs(
          '点击创建后进入任务单页面。',
          '下一步只检查执行会话会带上哪些资料。'
        )
        : isImport
          ? '点击创建后进入任务单页面。接着创建执行会话，让智能体按公开仓库导入说明执行。'
          : isSelfEvolve
            ? '点击创建后进入任务单页面。接着创建执行会话，确认只带入必要资料。'
          : isExtension
            ? '点击创建后进入任务单页面。接着创建执行会话，让智能体按光点标志空间任务执行。'
            : '点击创建后进入任务单页面。接着创建执行会话，让智能体检查并迭代光点拓展原型。',
      doneBtnText: '创建任务单',
      side: 'top',
      align: 'center',
    },
  })

  return launchDriver(steps)
}

async function runIssueCreatedSegment() {
  const demo = activeDemoOrBirthday()
  const isImport = isProjectImportTour(demo)
  const isContext = isContextSetupTour(demo)
  const isSelfEvolve = isSelfEvolveTour(demo)
  const isExtension = isExtensionTour(demo)
  await waitForElement('[data-tour="issue-created-summary"]')
  await waitForAnyElement([
    '[data-tour="issue-new-session"]',
    '[data-tour="issue-empty-create-session"]',
    '[data-tour="issue-sidebar-new-session"]',
  ])

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="issue-created-summary"]', {
    popover: {
      title: '任务单已经创建',
      description: isContext
        ? guideParagraphs(
          '任务单已经建好。',
          '下面创建一次执行会话，只用来验证资料是否带入。'
        )
        : isImport
          ? '左侧显示导入目标和公开仓库地址。现在创建一次执行会话，把“下载并整理待办事项示例仓库”真实交给智能体执行。'
          : isSelfEvolve
          ? guideParagraphs(
            '任务单已经建好。',
            '下面创建执行会话，只让智能体改一处演示文字。'
          )
          : isExtension
          ? guideParagraphs(
            '左侧显示设计目标和验收标准。',
            '现在创建一次执行会话。',
            '把光点标志空间的迭代任务交给智能体。'
          )
          : guideParagraphs(
            '左侧显示本次修改目标。',
            '现在创建一次执行会话。',
            '让智能体真正开始改文件。'
          ),
      side: 'right',
      align: 'start',
    },
  })
  const newSessionSelector = firstPresent([
    '[data-tour="issue-new-session"]',
    '[data-tour="issue-empty-create-session"]',
    '[data-tour="issue-sidebar-new-session"]',
  ])
  if (newSessionSelector) {
    addActionStepIfPresent(steps, newSessionSelector, {
      popover: {
        title: '新建执行会话',
        description: isContext
          ? guideParagraphs(
            '点击这里打开执行会话向导。',
            '重点看预览页里有没有刚导入的项目知识和项目方法。'
          )
          : isImport
            ? '点击这里打开执行会话向导。第二条路径的真实下载发生在执行会话中，日志会记录下载和文件检查过程。'
            : isSelfEvolve
              ? guideParagraphs(
                '点击这里打开执行会话向导。',
                '下一页会确认只带入必要项目知识和项目方法。'
              )
            : isExtension
              ? '点击这里打开执行会话向导。执行会话会保存模型、带入资料和执行日志。'
              : '点击这里打开执行会话向导。这里会保存本次执行记录。',
        doneBtnText: '打开向导',
        side: newSessionSelector.includes('sidebar') ? 'right' : newSessionSelector.includes('empty') ? 'top' : 'left',
        align: newSessionSelector.includes('sidebar') ? 'start' : 'center',
      },
    })
  }

  return launchDriver(steps)
}

async function runSessionFormSegment() {
  const demo = activeDemoOrBirthday()
  const isImport = isProjectImportTour(demo)
  const isContext = isContextSetupTour(demo)
  const isSelfEvolve = isSelfEvolveTour(demo)
  const isExtension = isExtensionTour(demo)
  await waitForElement('[data-tour="session-modal"]')

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="session-modal"]', {
    popover: {
      title: '执行会话向导',
      description: isContext
        ? guideParagraphs(
          '这一步不用改太多。',
          '保持默认内容，继续到资料预览页。'
        )
        : isSelfEvolve
          ? guideParagraphs(
            '这次执行会话已经预填。',
            '先保持默认，下一步检查带入资料。'
          )
        : isExtension
          ? '执行会话会把任务目标、选择的资料和模型放在一起，准备交给智能体执行。'
          : '执行会话是智能体真正开工的一次记录。保持默认内容即可。',
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-name-input"]', {
    popover: {
      title: '执行会话名称',
      description: isContext
        ? guideParagraphs(
          '名称已经预填。',
          '它只是帮助你在列表里识别这次验证执行。'
        )
        : isImport
          ? '本案例预填为“下载并整理待办事项示例仓库”，表示这次执行负责真正导入公开项目。'
          : isSelfEvolve
          ? guideParagraphs(
            '名称已经预填。',
            '它说明这次只做安全时间文字更新。'
          )
          : isExtension
          ? guideParagraphs(
            '名称用于区分不同执行记录。',
            '这里预填为“迭代 Three.js 光点标志空间”。',
            '它表示这次执行会真正检查和调整原型文件。'
          )
          : guideParagraphs(
            '名称用于区分不同执行记录。',
            '这里预填为“迭代 Three.js 光点标志空间”。',
            '它表示这次执行会真正检查和调整拓展原型文件。'
          ),
      side: 'bottom',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-description-input"]', {
    popover: {
      title: '执行指令',
      description: isContext
        ? guideParagraphs(
          '执行指令已经预填。',
          '它会让智能体读取说明文件，并按刚导入的资料输出。'
        )
        : isImport
          ? '这里是给智能体的第一条任务消息，明确要求下载公开仓库、目录非空时放到子目录、不要使用任何私人凭据。'
          : isSelfEvolve
            ? guideParagraphs(
              '指令只允许改一个常量。',
              '时间必须由执行时的 date 命令取得。'
            )
          : isExtension
            ? '这里是给智能体的第一条任务消息，要求先读真实原型和上下文，再小幅迭代代码或补齐说明文档。'
            : '这里是给智能体的第一条任务消息。它会先读文件，再做最小必要修改。',
      side: 'bottom',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-model-picker"]', {
    popover: {
      title: '选择模型',
      description: guideParagraphs(
        '这里选择本次执行会话使用的模型。',
        '一般代码和文件任务可以先用默认模型。',
        '更复杂的任务再按需要切换。'
      ),
      side: 'top',
      align: 'start',
    },
  })
  addActionStepIfPresent(steps, '[data-tour="session-preview-next"]', {
    popover: {
      title: '查看带入资料',
      description: isContext
        ? '点击下一步，只确认刚导入的项目知识和项目方法在列表里。'
        : isSelfEvolve
          ? '点击下一步，确认只保留本次自迭代需要的资料。'
        : isExtension
          ? '点击下一步后，可以看到这次任务会带给智能体哪些资料。确认无误再创建执行会话。'
          : '点击下一步后，确认这次任务会带上哪些说明。保持默认即可。',
      doneBtnText: '查看预览',
      side: 'top',
      align: 'center',
    },
  })

  return launchDriver(steps)
}

async function runSessionPreviewSegment() {
  const demo = activeDemoOrBirthday()
  const isImport = isProjectImportTour(demo)
  const isContext = isContextSetupTour(demo)
  const isSelfEvolve = isSelfEvolveTour(demo)
  const isExtension = isExtensionTour(demo)
  await waitForElement('[data-tour="session-preview"]')

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="session-preview"]', {
    popover: {
      title: '确认带入的资料',
      description: isContext
        ? guideParagraphs(
          '这里只确认两件事。',
          '项目知识告诉智能体项目事实和边界。',
          '项目方法告诉智能体遇到这类任务怎么做。'
        )
        : isImport
          ? '这里展示本次导入任务会带上的资料。确认下载地址和“不要使用私人凭据”等要求已经写清。'
          : isSelfEvolve
          ? guideParagraphs(
            '这里只保留本次需要的资料。',
            '创建后，这份选择会固定为执行快照。'
          )
          : isExtension
          ? guideParagraphs(
            '这里展示本次执行会带上的资料。',
            '创建后，这份选择会固定在本次会话里。',
            '请确认项目知识和拓展技能都在列表中。'
          )
          : guideParagraphs(
            '这里展示本次执行会带上的说明。',
            '这个小网页案例主要依赖任务单和项目文件。',
            '保持默认选择即可。'
          ),
      side: 'left',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-preview-skills"]', {
    popover: {
      title: isContext ? '确认项目方法' : isImport ? '资料可按需调整' : isSelfEvolve ? '确认项目方法' : isExtension ? '确认拓展技能' : '无需额外方法',
      description: isImport
        ? guideParagraphs(
          '导入案例主要依赖任务单里的公开地址和边界。',
          '如果列表里有不相关的方法，可以取消勾选。'
        )
        : isContext
        ? guideParagraphs(
          '这里确认 `mobius-extension` 在列表里。',
          '它保存开发莫比乌斯拓展的稳定做法。',
          '保持勾选即可，不需要调整其他选项。'
        )
        : isSelfEvolve
        ? guideParagraphs(
          '这里保留 `mobius-extension`。',
          '它提醒智能体遵守拓展协议和开发边界。'
        )
        : isExtension
        ? guideParagraphs(
          '拓展技能保存开发莫比乌斯拓展的做法。',
          '这个案例会用它检查文件结构和后端约束。',
          '保持相关技能勾选，让智能体按正确结构检查文件。'
        )
        : guideParagraphs(
          '这个入门案例不需要额外项目方法。',
          '让智能体按任务单修改文件即可。'
        ),
      side: 'left',
      align: 'start',
    },
  })
  if (isExtension || isSelfEvolve) {
    addStepIfPresent(steps, '[data-tour="session-preview-mobius-extension-skill"]', {
      popover: {
        title: isSelfEvolve ? '保留项目方法' : '保留拓展技能',
        description: isSelfEvolve
          ? guideParagraphs(
            '这里保持勾选 `mobius-extension`。',
            '它告诉智能体如何遵守莫比乌斯拓展协议和开发边界。'
          )
          : guideParagraphs(
            '这里保持勾选 `mobius-extension`。',
            '它告诉智能体拓展项目的文件结构、前后端约束和不能提交哪些产物。'
          ),
        side: 'left',
        align: 'start',
      },
    })
  }
  addStepIfPresent(steps, '[data-tour="session-preview-memories"]', {
    popover: {
      title: isContext ? '确认项目知识' : isImport ? '确认任务资料' : isSelfEvolve ? '确认必要记忆' : isExtension ? '确认项目知识' : '确认任务说明',
      description: isImport
        ? guideParagraphs(
          '这里列出会带入本次执行的项目事实。',
          '导入案例主要看任务单里的地址和约束。',
          '如果列表里有不相关的记忆，可以取消勾选。'
        )
        : isContext
        ? guideParagraphs(
          '这里确认「莫比乌斯自主开发项目知识」在列表里。',
          '保持勾选即可。'
        )
        : isSelfEvolve
        ? guideParagraphs(
          '这里保留少量必要项目知识。',
          '无关历史记录不默认带入。'
        )
        : isExtension
        ? guideParagraphs(
          '项目知识保存项目事实。',
          '例如这个案例的设计目标、文件范围和检查重点。',
          '保持勾选即可。'
        )
        : guideParagraphs(
          '这里列出会带入本次执行的项目事实。',
          '小网页案例已经把要求写在任务单里。',
          '保持默认选择即可。'
        ),
      side: 'left',
      align: 'start',
    },
  })
  if (isExtension) {
    addStepIfPresent(steps, '[data-tour="session-preview-logo-memory"]', {
      popover: {
        title: '保留项目知识',
        description: guideParagraphs(
          '这里保持勾选“莫比乌斯光点标志空间案例”的项目知识。',
          '它保存这个案例的真实约束，能帮助智能体少跑偏。'
        ),
        side: 'left',
        align: 'start',
      },
    })
  }
  if (isSelfEvolve) {
    addStepIfPresent(steps, '[data-tour="session-preview-self-evolve-required-memory"]', {
      popover: {
        title: '保留项目知识',
        description: guideParagraphs(
          '这里保持勾选「莫比乌斯自主开发项目知识」。',
          '它告诉智能体代码位置、运行方式和安全边界。'
        ),
        side: 'left',
        align: 'start',
      },
    })
    addStepIfPresent(steps, '[data-tour="session-preview-self-evolve-project-memory"]', {
      popover: {
        title: '保留实现记录',
        description: guideParagraphs(
          '这类项目知识记录当前引导系统和已有实现位置。',
          '本次任务需要它帮助智能体少走弯路。'
        ),
        side: 'left',
        align: 'start',
      },
    })
    addStepIfPresent(steps, '[data-tour="session-preview-self-evolve-guide-memory"]', {
      popover: {
        title: '保留文案规则',
        description: guideParagraphs(
          '文案规则约束中文优先、短句和少讲内部实现。',
          '本次修改引导中心时需要遵守。'
        ),
        side: 'left',
        align: 'start',
      },
    })
  }
  addActionStepIfPresent(steps, '[data-tour="session-submit"]', {
    popover: {
      title: '确认并创建',
      description: isContext
        ? guideParagraphs(
          '看到这两份资料后就可以创建。',
          '后面只是验证资料配置，不会修改莫比乌斯自身。'
        )
        : isImport
          ? '点击后会进入对话页，并弹出“是否开始执行”的确认窗。导入动作还不会自动执行。'
          : isSelfEvolve
            ? guideParagraphs(
              '点击后会进入对话页。',
              '开始执行前仍会要求你确认。'
            )
          : guideParagraphs(
            '点击后会进入对话页，并弹出“是否开始执行”的确认窗。',
            '确认执行前，你仍可以停下来检查带入资料是否正确。'
          ),
      doneBtnText: '创建执行会话',
      side: 'top',
      align: 'center',
    },
  })

  return launchDriver(steps)
}

async function runSessionStartSegment() {
  const demo = activeDemoOrBirthday()
  const isImport = isProjectImportTour(demo)
  const isContext = isContextSetupTour(demo)
  const isSelfEvolve = isSelfEvolveTour(demo)
  const isExtension = isExtensionTour(demo)
  await waitForElement('[data-tour="session-start-modal"]')

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="session-start-modal"]', {
    popover: {
      title: '开始执行确认',
      description: isContext
        ? guideParagraphs(
          '这里会发送刚才预填的验证任务。',
          '确认后，智能体会读取说明文件并写出验证结果。'
        )
        : isImport
          ? '这里是公开仓库下载路径的真实执行入口。确认后，任务消息会发送给智能体，下载动作才会开始。'
          : isSelfEvolve
          ? guideParagraphs(
            '这里会发送自迭代任务。',
            '确认后，智能体只应修改一处演示时间文字。'
          )
          : isExtension
          ? guideParagraphs(
            '这里会把光点标志原型的迭代要求作为第一条任务消息发送给智能体。',
            '开始执行前仍会等待你确认。'
          )
          : guideParagraphs(
            '这里会把小网页修改要求发送给智能体。',
            '确认后，它会开始读文件和改文件。'
          ),
      side: 'left',
      align: 'start',
    },
  })
  addActionStepIfPresent(steps, '[data-tour="session-start-confirm"]', {
    popover: {
      title: isContext ? '让智能体验证资料' : isImport ? '让智能体开始下载项目' : isSelfEvolve ? '开始自迭代' : isExtension ? '让智能体迭代原型' : '让智能体开工',
      description: isContext
        ? guideParagraphs(
          '点击后开始验证。',
          '完成后看结果文件和回复摘要即可。'
        )
        : isImport
          ? '点击“立即执行”后，智能体会真的在项目目录里下载公开待办事项示例仓库，并检查关键文件。'
          : isSelfEvolve
          ? guideParagraphs(
            '点击后才会真正执行。',
            '本次只允许改一个演示时间常量。'
          )
          : isExtension
          ? guideParagraphs(
            '点击“立即执行”后，智能体会开始处理这个小任务。',
            '它会检查原型文件，按需要迭代。',
            '执行开始后，我们再看日志。'
          )
          : guideParagraphs(
            '点击“立即执行”后，智能体会开始处理这个小任务。',
            '它会检查网页文件，按要求修改。',
            '执行完成后，我们再看结果。'
          ),
      doneBtnText: '立即执行',
      side: 'top',
      align: 'center',
    },
  })

  return launchDriver(steps)
}

async function runSessionChatSegment() {
  const demo = activeDemoOrBirthday()
  const isImport = isProjectImportTour(demo)
  const isContext = isContextSetupTour(demo)
  const isSelfEvolve = isSelfEvolveTour(demo)
  const isExtension = isExtensionTour(demo)
  await waitForElement('[data-tour="session-chat-header"]')
  const logTargets = [
    '[data-tour="session-log-user-card"]',
    '[data-tour="session-log-event-card"]',
    '[data-tour="session-log-event-token-count-card"]',
    '[data-tour="session-log-response-reasoning-card"]',
    '[data-tour="session-log-response-tool-call-card"]',
    '[data-tour="session-log-response-tool-result-card"]',
    '[data-tour="session-log-response-assistant-card"]',
    '[data-tour="session-log-assistant-card"]',
  ]
  const firstLogTarget = await waitForAnyElement(logTargets, isContext || isImport ? 5200 : 15000)
  if (isExtension && !firstLogTarget) {
    window.setTimeout(() => {
      lastRunKey = ''
      dispatchGuidedDemoTour(false)
    }, 2400)
    return false
  }

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="session-chat-header"]', {
    popover: {
      title: '执行现场',
      description: isContext
        ? guideParagraphs(
          '这里显示智能体执行过程。',
          '本案例只需要确认它生成资料检查结果。'
        )
        : isImport
          ? '这里是导入执行会话的实时执行页面。左侧会出现智能体的下载命令、文件检查和结果总结。'
          : isSelfEvolve
          ? guideParagraphs(
            '这里显示自迭代执行过程。',
            '重点看它是否只修改演示时间文字。'
          )
          : isExtension
          ? guideParagraphs(
            '这里是本次执行会话的实时页面。',
            '左侧会出现智能体检查原型、调用工具和总结变更的过程。',
            '执行开始后，再阅读这些日志。'
          )
          : guideParagraphs(
            '这里显示智能体执行过程。',
            '本案例重点看它是否修改了网页文件，并在最后说明结果。'
          ),
      side: 'bottom',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-status"]', {
    popover: {
      title: '观察执行状态',
      description: isContext
        ? guideParagraphs(
          '状态变为已结束后，再看结果。',
          '重点看是否生成检查文件。'
        )
        : isImport
          ? '状态会在启动中、执行中、待命、已结束之间切换。导入完成后可以查看下载位置和项目文件。'
          : isSelfEvolve
            ? '状态会在启动中、执行中、待命、已结束之间切换。完成后重点看修改文件和构建结果。'
          : isExtension
            ? '状态会在启动中、执行中、待命、已结束之间切换。完成后重点看原型、README 和日志说明是否更新。'
            : '状态会在启动中、执行中、待命、已结束之间切换。完成后重点看修改文件和最终回复。',
      side: 'bottom',
      align: 'center',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-jsonl-view"]', {
    popover: {
      title: '执行日志',
      description: isContext
        ? guideParagraphs(
          '这里可以简单扫一眼执行过程。',
          '这个案例只应读取本地说明文件，不需要外部服务。'
        )
        : isImport
          ? '智能体的过程会沉淀在这里。公开仓库不应要求账号或 token（访问凭证）；如果日志里出现私人凭据请求，就应该停下并改写任务。'
          : isSelfEvolve
          ? guideParagraphs(
            '智能体过程会沉淀在这里。',
            '看工具调用是否只碰了指定文件。'
          )
          : isExtension
          ? guideParagraphs(
            '智能体的过程会沉淀在这里。',
            '每张卡片左上角是类型。',
            '下面看几类最常见的日志。'
          )
          : guideParagraphs(
            '日志记录智能体做过的动作。',
            '入门时先看最终回复，再回头查工具结果。'
          ),
      side: 'right',
      align: 'start',
    },
  })
  if (isExtension) {
    addStepIfPresent(steps, '[data-tour="session-log-user-card"]', {
      popover: {
        title: '用户输入',
        description: guideParagraphs(
          '`user` 是日志字段名，表示你发出的任务要求。',
          '本案例里，它就是开始执行时发送给智能体的那段指令。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addStepIfPresent(steps, '[data-tour="session-log-event-card"]', {
      popover: {
        title: '系统事件',
        description: guideParagraphs(
          '`event_msg` 是日志字段名，表示执行过程中的状态消息。',
          '它通常记录启动、输出片段、完成等系统事件。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addStepIfPresent(steps, '[data-tour="session-log-response-reasoning-card"]', {
      popover: {
        title: '思考记录',
        description: guideParagraphs(
          '`reasoning` 是日志字段名，表示模型整理思路和判断方向的记录。',
          '新用户可以略读，重点看它是否围绕任务检查。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addStepIfPresent(steps, '[data-tour="session-log-response-tool-call-card"]', {
      popover: {
        title: '工具调用',
        description: guideParagraphs(
          '`function_call` 是日志字段名，表示智能体准备调用的工具或命令。',
          '看这里可以知道它要读文件、改文件，还是执行检查命令。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addStepIfPresent(steps, '[data-tour="session-log-response-tool-result-card"]', {
      popover: {
        title: '工具结果',
        description: guideParagraphs(
          '`function_call_output` 是日志字段名，表示工具返回结果。',
          '重点看 `output`、`error`、`status`，判断命令是否成功。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addStepIfPresent(steps, '[data-tour="session-log-event-token-count-card"]', {
      popover: {
        title: '消耗统计',
        description: guideParagraphs(
          '`token_count` 是日志字段名，表示本轮消耗统计。',
          '它帮助判断上下文长度和执行成本，不是结果内容。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addStepIfPresent(steps, '[data-tour="session-log-response-assistant-card"]', {
      popover: {
        title: '智能体回复',
        description: guideParagraphs(
          '`assistant` 是日志字段名，表示智能体给用户看的总结或回复。',
          '完成时优先读这里，看它改了哪些文件、怎么验收。'
        ),
        side: 'right',
        align: 'start',
      },
    })
    addStepIfPresent(steps, '[data-tour="session-log-assistant-card"]', {
      popover: {
        title: '智能体回复',
        description: guideParagraphs(
          '`assistant` 是日志字段名，表示智能体给用户看的总结或回复。',
          '完成时优先读这里，看它改了哪些文件、怎么验收。'
        ),
        side: 'right',
        align: 'start',
      },
    })
  }
  addStepIfPresent(steps, '[data-tour="session-chat-input"]', {
    popover: {
      title: '继续补充要求',
      description: isContext
        ? guideParagraphs(
          '如果检查结果不清楚，可以继续发消息补充要求。',
          '例如：用两段话分别解释项目知识和项目方法。'
        )
        : isImport
          ? '如果导入结果不清楚，可以继续发消息，例如“列出 examples/vanillajs 的入口文件并说明如何预览”。'
          : isSelfEvolve
            ? '如果结果不清楚，可以继续发消息，例如“列出这次实际修改的文件和构建命令”。'
          : isExtension
            ? '如果效果不满意，可以继续发消息，例如“把光点密度降低一点，并换成冷白和青绿色调色盘”。'
            : '如果结果不符合预期，可以继续发消息，例如“把按钮文案改得更短，并说明改了哪些文件”。',
      side: 'left',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="issue-overview-link"]', {
    popover: {
      title: '完成后回到执行会话列表',
      description: isContext
        ? guideParagraphs(
          '先留在这里观察执行。',
          '等智能体完成并生成检查结果后，再点击这里回到任务单概览。'
        )
        : isImport
          ? '先留在这里观察执行。等导入完成后，再点击这里回到任务单概览，查看导入结果。'
          : isSelfEvolve
          ? guideParagraphs(
            '先留在这里观察执行。',
            '完成后回到任务单概览，检查结果是否只改一处文字。'
          )
          : isExtension
          ? guideParagraphs(
            '先留在这里观察执行。',
            '等智能体完成、回复总结出现后，再点击这里回到任务单概览。',
            '回去后会继续引导你查看成品文件。'
          )
          : guideParagraphs(
            '先留在这里观察执行。',
            '等智能体完成并回复总结后，再点击这里回到任务单概览。',
            '回去后会继续引导你查看修改结果。'
          ),
      side: 'right',
      align: 'start',
    },
  })

  return launchDriver(steps)
}

async function runSessionCompleteSegment() {
  const demo = activeDemoOrBirthday()
  const isImport = isProjectImportTour(demo)
  const isContext = isContextSetupTour(demo)
  const isSelfEvolve = isSelfEvolveTour(demo)
  const isExtension = isExtensionTour(demo)
  if (has('[data-tour="session-complete-confirm"]')) {
    const steps: DriveStep[] = []
    addStepIfPresent(steps, '[data-tour="session-complete-confirm-modal"]', {
      popover: {
        title: '确认完成',
        description: isContext
          ? guideParagraphs(
            '确认后，系统会记录这个执行会话已完成。',
            '然后继续引导你回到项目页做最后清理。'
          )
          : isImport
            ? '确认后，系统会记录这个导入案例的执行会话已完成，然后继续引导你回到项目页做最后清理。'
            : isSelfEvolve
              ? '确认后，系统会记录这次自迭代执行已完成。自迭代项目不会被清理。'
            : isExtension
              ? '确认后，系统会记录这个拓展案例的执行会话已完成，然后继续引导你回到项目页做最后清理。'
              : '确认后，系统会记录这次小网页修改已完成，然后继续引导你回到项目页查看结果。',
        side: 'left',
        align: 'start',
      },
    })
    addActionStepIfPresent(steps, '[data-tour="session-complete-confirm"]', {
      popover: {
        title: '确认完成',
        description: isContext
          ? guideParagraphs(
            '点击完成后，这次资料配置验证会进入完成状态。',
            '接着回到项目页删除演示项目。'
          )
          : isImport
            ? '点击完成后，这次导入执行会进入完成状态。接着回到项目页删除演示项目，避免留下示例代码。'
            : isSelfEvolve
              ? '点击完成后，这次自迭代执行会进入完成状态。自迭代项目本身会保留。'
            : isExtension
              ? '点击完成后，这次拓展迭代会进入完成状态。接着回到项目页删除演示项目。'
              : '点击完成后，这次网页修改会进入完成状态。接着回到项目页查看文件。',
        doneBtnText: '确认完成',
        side: 'top',
        align: 'center',
      },
    })
    return launchDriver(steps)
  }

  await waitForAnyElement([
    '[data-tour="session-card"]',
    '[data-tour="issue-empty-create-session"]',
    '[data-tour="issue-sidebar-new-session"]',
  ])
  await waitForAnyElement([
    '[data-tour="project-files-card"]',
  ], 1600)
  await waitForAnyElement([
    '[data-tour="project-file-readme"]',
    '[data-tour="project-file-agent-output-guide"]',
    '[data-tour="project-files-vscode-open"]',
  ], 2600)

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="session-card"]', {
    popover: {
      title: '本次执行记录',
      description: isContext
        ? guideParagraphs(
          '执行会话卡片会显示任务、消息数、状态和最后活跃时间。',
          '任务结束后，状态会自动更新为已完成或失败。'
        )
        : isImport
          ? '执行会话卡片会显示导入任务、消息数、状态和最后活跃时间。导入结束后，状态会自动更新为已完成或失败。'
          : isSelfEvolve
            ? '执行会话卡片会显示这次自迭代任务。重点看最终回复是否说明只改了演示时间文字。'
          : '执行会话卡片会显示任务目标、消息数、状态和最后活跃时间。任务结束后，状态会自动更新为已完成或失败。',
      side: 'top',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-files-card"]', {
    popover: {
      title: isContext ? '查看检查结果' : isImport ? '查看导入结果' : isSelfEvolve ? '查看受控修改' : isExtension ? '查看成品文件' : '查看修改结果',
      description: isContext
        ? guideParagraphs(
          '这里是演示目录里的文件。',
          '智能体完成后，可以在这里确认检查文件是否生成。'
        )
        : isImport
          ? guideParagraphs(
            '这里是项目绑定目录里的文件。',
            '导入完成后，可以在这里确认公开示例项目是否已经下载。'
          )
          : isSelfEvolve
          ? guideParagraphs(
            '这里是莫比乌斯自身代码目录。',
            '本次只应看到引导中心演示时间文字被更新。'
          )
          : isExtension
          ? guideParagraphs(
            '这里是演示目录里的文件。',
            '智能体完成后，先看说明文档和日志阅读文档。',
            '再打开编辑器查看原型文件。'
          )
          : guideParagraphs(
            '这里是演示目录里的文件。',
            '智能体完成后，可以查看网页文件是否已经修改。'
          ),
      side: 'left',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-file-readme"]', {
    popover: {
      title: 'README',
      description: isContext
        ? 'README 通常说明项目里的材料和结果查看方式。'
        : isImport
          ? 'README 通常说明导入项目的来源、结构和查看方式。'
          : isSelfEvolve
            ? 'README 是项目说明。自迭代任务不应修改它。'
          : isExtension
            ? 'README 说明原型文件结构、查看方式和本次执行结果。'
            : 'README 说明这个小网页的文件结构和查看方式。',
      side: 'left',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-file-agent-output-guide"]', {
    popover: {
      title: '日志阅读说明',
      description: guideParagraphs(
        '`AGENT_OUTPUT_GUIDE.md` 用中文解释常见执行日志字段。',
        '以后看到类似日志，可以先看这份说明再判断结果。'
      ),
      side: 'left',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-files-vscode-open"]', {
    popover: {
      title: '打开文件查看',
      description: isContext
        ? '点击这里可以在网页编辑器里打开演示目录，查看检查结果文件。'
        : isImport
          ? '点击这里可以在网页编辑器里打开导入目录，查看下载后的代码结构。'
          : isSelfEvolve
            ? '点击这里可以在网页编辑器里打开代码目录，查看引导中心文件。'
          : isExtension
            ? '点击这里可以在网页编辑器里打开演示目录，查看原型文件和说明文档。'
            : '点击这里可以在网页编辑器里打开演示目录，查看 index.html 和 style.css。',
      side: 'left',
      align: 'center',
    },
  })
  addActionStepIfPresent(steps, '[data-tour="project-back-link"]', {
    popover: {
      title: '返回项目页',
      description: isContext
        ? guideParagraphs(
          '执行会话完成后，点击项目名返回项目页。',
          '最后一步会删除演示项目和演示目录。'
        )
        : isImport
          ? '执行会话完成后，点击项目名返回项目页。最后一步会引导你删除这次导入演示项目。'
          : isSelfEvolve
            ? '执行会话完成后，可以回到项目页。自迭代项目不会被删除。'
          : isExtension
            ? '执行会话完成后，点击项目名返回项目页。最后一步会删除拓展演示项目和目录。'
            : '执行会话完成后，点击项目名返回项目页。最后一步会删除这个入门演示项目。',
      doneBtnText: '返回项目',
      side: 'right',
      align: 'start',
    },
  })

  return launchDriver(steps)
}

async function runProjectCleanupSegment() {
  const demo = activeDemoOrBirthday()
  const isImport = isProjectImportTour(demo)
  const isContext = isContextSetupTour(demo)
  const isExtension = isExtensionTour(demo)
  await waitForElement('[data-tour="project-settings-panel"]')
  // 删除项目按钮已移入「项目设置」tab 底部的危险操作区, 先切到该 tab 确保按钮在 DOM 中.
  clickIfPresent('[data-tour="project-settings-tab"]')
  await waitForElement('[data-tour="project-delete"]')

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="project-settings-panel"]', {
    popover: {
      title: '演示项目清理',
      description: isContext
        ? guideParagraphs(
          '案例完成后，从这里删除演示项目。',
          '系统会清理项目记录、项目知识、项目方法和演示目录。'
        )
        : isImport
          ? '导入案例完成后，可以从项目设置区域删除这个演示项目，避免示例代码留在真实项目列表里。'
          : isExtension
            ? '拓展案例完成后，可以从项目设置区域删除这个演示项目，避免污染真实项目列表。'
            : '入门案例完成后，可以从项目设置区域删除这个演示项目，避免示例文件留在真实项目列表里。',
      side: 'right',
      align: 'start',
    },
  })
  addActionStepIfPresent(steps, '[data-tour="project-delete"]', {
    popover: {
      title: '删除演示项目',
      description: isContext
        ? guideParagraphs(
          '点击删除会打开确认窗。',
          '确认后会恢复到演示前状态。',
          '开发资料配置示例文件不会保留。'
        )
        : '点击删除会打开确认窗。确认后会移除演示项目、任务单、执行会话和演示目录。',
      doneBtnText: '打开确认窗',
      side: 'left',
      align: 'center',
    },
  })

  return launchDriver(steps)
}

async function runProjectDeleteFormSegment() {
  const demo = activeDemoOrBirthday()
  const state = demo.state
  const isImport = isProjectImportTour(demo)
  const isContext = isContextSetupTour(demo)
  const isExtension = isExtensionTour(demo)
  const review = isLogoReviewTour(demo) ? logoReviewState(state) : null
  const deletingReviewCleanupProject = !!review?.cleanupProjectId && pathContainsId(window.location.pathname, 'p', review.cleanupProjectId)
  const deleteProjectName = deletingReviewCleanupProject ? (review?.cleanupProjectName || '临时演示项目') : state.projectName
  await waitForElement('[data-tour="delete-project-modal"]')

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="delete-project-modal"]', {
    popover: {
      title: '确认删除',
      description: '为了避免误删，删除普通项目需要输入项目名，并勾选不可恢复确认。密码登录开启时还会要求管理员密码。',
      side: 'left',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="delete-project-confirm-input"]', {
    popover: {
      title: '输入项目名',
      description: `输入“${deleteProjectName}”后，确认删除按钮才会可用。`,
      side: 'bottom',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="delete-project-final-confirm"]', {
    popover: {
      title: '第二重确认',
      description: '勾选这里后，系统才会允许提交删除。',
      side: 'bottom',
      align: 'start',
    },
  })
  addActionStepIfPresent(steps, '[data-tour="delete-project-submit"]', {
    popover: {
      title: '完成清理',
      description: isContext
        ? guideParagraphs(
          '点击确认删除后，开发资料配置案例就结束了。',
          '项目、示例文件、项目级记忆和项目级技能都会被清理。'
        )
        : deletingReviewCleanupProject
          ? guideParagraphs(
            '点击确认删除后，刚创建的临时演示项目就会清理掉。',
            '固定完成案例会继续保留，之后还能从验收路线进入。'
          )
        : isImport
          ? '点击确认删除后，导入现有项目案例就结束了。系统会把引导状态标记为完成。'
          : isExtension
            ? '点击确认删除后，拓展开发案例就结束了。项目、演示文件、项目知识和拓展技能都会被清理。'
            : '点击确认删除后，第一次完成任务路线就结束了。项目和演示文件都会被清理。',
      doneBtnText: '确认删除',
      side: 'top',
      align: 'center',
    },
  }, '[data-tour="delete-project-submit"]', false)

  return launchDriver(steps)
}

async function runLogoReviewProjectSegment() {
  const demo = activeDemoOrBirthday()
  const state = logoReviewState(demo.state)
  await waitForElement('[data-tour="project-items-panel"]')
  await waitForAnyElement([
    '[data-tour="logo-review-issue-link"]',
    '[data-tour="project-files-card"]',
    '[data-tour="project-issue-tab"]',
  ], 2200)

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="project-settings-panel"]', {
    popover: {
      title: '这是完成版案例',
      description: guideParagraphs(
        `这里是固定完成项目「${state.projectName}」。`,
        '它用于验收，不是刚才创建的临时演示项目。',
        '这条路线不会删除它。'
      ),
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-items-panel"]', {
    popover: {
      title: '看相同任务',
      description: guideParagraphs(
        '右侧列出任务单和执行记录。',
        `请进入「${state.issueTitle}」，查看同一个任务完成后的会话和文件。`
      ),
      side: 'left',
      align: 'start',
    },
  })
  addActionStepIfPresent(steps, '[data-tour="logo-review-issue-link"]', {
    popover: {
      title: '进入完成任务',
      description: guideParagraphs(
        '点击这里进入已完成任务单。',
        '下一步会看执行记录、结果文件和如何打开成品拓展。'
      ),
      doneBtnText: '进入任务单',
      side: 'bottom',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-files-card"]', {
    popover: {
      title: '也可以先看文件',
      description: guideParagraphs(
        '这里显示案例目录里的文件。',
        '重点看 README 和 AGENT_OUTPUT_GUIDE：一个说明原型怎么运行，一个说明执行日志怎么看。'
      ),
      side: 'left',
      align: 'start',
    },
  })

  return launchDriver(steps)
}

async function runLogoReviewIssueSegment() {
  const demo = activeDemoOrBirthday()
  const state = logoReviewState(demo.state)
  await waitForElement('[data-tour="issue-created-summary"]')
  await waitForAnyElement([
    '[data-tour="logo-review-session-card"]',
    '[data-tour="project-files-card"]',
    '[data-tour="issue-empty-create-session"]',
    '[data-tour="issue-sidebar-new-session"]',
  ], 2600)

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="issue-created-summary"]', {
    popover: {
      title: '先看任务目标',
      description: guideParagraphs(
        '左侧是已经完成的任务单。',
        '验收时先对照这里的目标，再看执行会话最后交付了什么。'
      ),
      side: 'right',
      align: 'start',
    },
  })
  addActionStepIfPresent(steps, '[data-tour="logo-review-session-card"]', {
    popover: {
      title: '打开完成会话',
      description: guideParagraphs(
        `进入「${state.sessionName}」。`,
        '完成会话里能看到智能体读了什么、改了什么，以及最后如何总结结果。'
      ),
      doneBtnText: '打开会话',
      side: 'top',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-files-card"]', {
    popover: {
      title: '验收交付文件',
      description: guideParagraphs(
        '如果不想先进会话，也可以从这里看文件。',
        'README 说明项目结构，AGENT_OUTPUT_GUIDE 说明执行日志常见字段。'
      ),
      side: 'left',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="project-files-vscode-open"]', {
    popover: {
      title: '打开代码查看',
      description: '点击这里可以在网页代码编辑器中查看 extension.json、frontend/ 和 backend/ 下的真实代码。',
      side: 'left',
      align: 'center',
    },
  })

  return launchDriver(steps)
}

async function runLogoReviewSessionSegment() {
  const demo = activeDemoOrBirthday()
  const state = logoReviewState(demo.state)
  await waitForElement('[data-tour="session-chat-header"]')
  await waitForAnyElement([
    '[data-tour="session-log-logo-extension-answer-card"]',
    '[data-tour="session-log-response-assistant-card"]',
    '[data-tour="session-log-assistant-card"]',
    '[data-tour="session-jsonl-view"]',
  ], 5000)

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="session-chat-header"]', {
    popover: {
      title: '这是完成版会话',
      description: guideParagraphs(
        '这里展示同一个光点标志空间任务已经完成后的记录。',
        '验收时先看状态和最终回复，再回看工具调用细节。'
      ),
      side: 'bottom',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-status"]', {
    popover: {
      title: '确认执行状态',
      description: '这里显示会话当前状态。验收完成版时，优先看最终回复、文件变化和说明文档；如果自己的新会话仍在执行，就先等待它结束。',
      side: 'bottom',
      align: 'center',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-jsonl-view"]', {
    popover: {
      title: '阅读执行日志',
      description: guideParagraphs(
        '日志按卡片展示用户输入、工具调用、工具结果和智能体回复。',
        '这个固定案例重点看三类内容：读取了哪些文件、是否识别为拓展、最终怎么打开。'
      ),
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-log-user-card"]', {
    popover: {
      title: '用户输入',
      description: guideParagraphs(
        '`user` 表示这轮任务的输入。',
        '在本案例里，它要求智能体读取 README、extension.json、frontend/ 和 backend/，再判断光点拓展原型是否完整。'
      ),
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-log-logo-file-tool-call-card"]', {
    popover: {
      title: '工具调用',
      description: guideParagraphs(
        '`function_call` 表示智能体准备执行一个工具。',
        '看到 extension.json 或 AGENT_OUTPUT_GUIDE.md，说明它正在检查插件名、入口文件或日志说明文档。'
      ),
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-log-logo-file-tool-result-card"]', {
    popover: {
      title: '工具结果',
      description: guideParagraphs(
        '`function_call_output` 是工具返回的结果。',
        '本案例里如果返回包含 dot-logo-3d，就说明智能体已经读到了拓展配置，而不是只凭任务描述猜测。'
      ),
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-log-logo-extension-answer-card"]', {
    popover: {
      title: '看懂拓展地址',
      description: guideParagraphs(
        '这类回复是在解释交付物类型。',
        '`extension.json` 里的 `name` 是 `dot-logo-3d`，所以正式入口是 `/extension/dot-logo-3d/`。',
        '这说明它是莫比乌斯拓展应用，不是直接双击打开的普通网页。'
      ),
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-log-response-assistant-card"]', {
    popover: {
      title: '先读最终总结',
      description: guideParagraphs(
        '最终总结通常会列出检查了哪些文件、实际改了哪些文件，以及怎样查看交付结果。',
        '本案例要特别确认三点：保留拓展目录结构、插件名是 dot-logo-3d、访问入口是 /extension/dot-logo-3d/。'
      ),
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-log-assistant-card"]', {
    popover: {
      title: '先读最终总结',
      description: guideParagraphs(
        '最终总结通常会列出检查了哪些文件、实际改了哪些文件，以及怎样查看交付结果。',
        '本案例要特别确认三点：保留拓展目录结构、插件名是 dot-logo-3d、访问入口是 /extension/dot-logo-3d/。'
      ),
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="session-chat-input"]', {
    popover: {
      title: '继续追问或返工',
      description: guideParagraphs(
        '如果验收后还有要求，就在这里继续对话。',
        '例如：说明如何打开成品拓展，或要求把光点密度、颜色和运动速度再调一版。'
      ),
      side: 'left',
      align: 'start',
    },
  })
  if (state.cleanupProjectId) {
    addStepIfPresent(steps, '[data-tour="issue-overview-link"]', {
      popover: {
        title: '继续验收拓展',
        description: guideParagraphs(
          '任务单概览可以看案例文件，但这条路线还没有结束。',
          `下一步会进入 dot-logo-3d 拓展项目，再说明怎样打开 ${state.extensionUrl} 验收成品。`,
          `之后再清理刚才创建的「${state.cleanupProjectName || '演示项目'}」。`
        ),
        doneBtnText: '去拓展项目',
        side: 'right',
        align: 'start',
        onNextClick: (_element, _step, opts) => {
          const userId = window.location.pathname.match(/^\/u\/([^/]+)/)?.[1] || ''
          if (!userId) return
          preserveActiveOnDestroy = true
          opts.driver.destroy()
          lastRunKey = ''
          window.setTimeout(() => {
            window.location.assign(`/u/${userId}/p/${state.extensionProjectId}`)
          }, 80)
        },
      },
    })
  } else {
    addStepIfPresent(steps, '[data-tour="issue-overview-link"]', {
      popover: {
        title: '继续验收拓展',
        description: guideParagraphs(
          '任务单概览可以看案例文件，但这条路线还没有结束。',
          `下一步会进入 dot-logo-3d 拓展项目，再打开 ${state.extensionUrl} 验收成品。`
        ),
        doneBtnText: '去拓展项目',
        side: 'right',
        align: 'start',
        onNextClick: (_element, _step, opts) => {
          const userId = window.location.pathname.match(/^\/u\/([^/]+)/)?.[1] || ''
          if (!userId) return
          preserveActiveOnDestroy = true
          opts.driver.destroy()
          lastRunKey = ''
          window.setTimeout(() => {
            window.location.assign(`/u/${userId}/p/${state.extensionProjectId}`)
          }, 80)
        },
      },
    })
  }

  return launchDriver(steps)
}

async function runLogoReviewExtensionProjectSegment() {
  const demo = activeDemoOrBirthday()
  const state = logoReviewState(demo.state)
  await waitForElement('[data-tour="project-extension-entry"]')

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="project-extension-entry"]', {
    popover: {
      title: '这是拓展项目',
      description: guideParagraphs(
        '这里是系统同步出来的 dot-logo-3d 拓展项目。',
        '拓展项目负责承载一个可打开的小应用；下一步会打开真实拓展网页。'
      ),
      side: 'left',
      align: 'start',
    },
  })
  if (state.cleanupProjectId) {
    addStepIfPresent(steps, '[data-tour="project-extension-open"]', {
      popover: {
        title: '打开拓展网页',
        description: guideParagraphs(
          `这个按钮对应 ${state.extensionUrl}。`,
          '这就是完成案例交付出来的拓展网页。',
          '点击后会在新标签打开成品，当前页面继续走清理步骤。'
        ),
        doneBtnText: '新标签打开',
        side: 'bottom',
        align: 'center',
        onNextClick: (_element, _step, opts) => {
          window.open(state.extensionUrl, '_blank', 'noopener,noreferrer')
          window.setTimeout(() => opts.driver.moveNext(), 80)
        },
      },
    })
    addStepIfPresent(steps, '[data-tour="project-extension-entry"]', {
      popover: {
        title: '回到临时项目',
        description: guideParagraphs(
          '成品拓展的入口已经看过。',
          `接下来去清理刚才创建的「${state.cleanupProjectName || '演示项目'}」。`,
          '固定完成项目和 dot-logo-3d 拓展项目都会保留。'
        ),
        doneBtnText: '去清理项目',
        side: 'left',
        align: 'start',
        onNextClick: (_element, _step, opts) => {
          const userId = window.location.pathname.match(/^\/u\/([^/]+)/)?.[1] || ''
          if (!userId || !state.cleanupProjectId) return
          preserveActiveOnDestroy = true
          opts.driver.destroy()
          lastRunKey = ''
          window.setTimeout(() => {
            window.location.assign(`/u/${userId}/p/${state.cleanupProjectId}`)
          }, 80)
        },
      },
    })
  } else {
    addStepIfPresent(steps, '[data-tour="project-extension-open"]', {
      popover: {
        title: '打开拓展网页',
        description: guideParagraphs(
          `这个按钮对应 ${state.extensionUrl}。`,
          '拓展网页是最终可使用的交付物。',
          '点击后会在新标签打开它，你可以直接体验页面是否能交互。'
        ),
        doneBtnText: '打开应用',
        side: 'bottom',
        align: 'center',
        onNextClick: (_element, _step, opts) => {
          window.open(state.extensionUrl, '_blank', 'noopener,noreferrer')
          writeLogoReviewDemoState({ ...state, active: false, completedAt: Date.now() })
          opts.driver.destroy()
        },
      },
    })
  }

  return launchDriver(steps)
}

async function runLogoReviewCleanupSegment() {
  const demo = activeDemoOrBirthday()
  const state = logoReviewState(demo.state)
  await waitForElement('[data-tour="project-settings-panel"]')
  // 删除项目按钮已移入「项目设置」tab 底部的危险操作区, 先切到该 tab 确保按钮在 DOM 中.
  clickIfPresent('[data-tour="project-settings-tab"]')
  await waitForElement('[data-tour="project-delete"]')

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="project-settings-panel"]', {
    popover: {
      title: '清理刚创建的演示项目',
      description: guideParagraphs(
        `这里是你刚才创建的「${state.cleanupProjectName || '演示项目'}」。`,
        '验收已经用固定完成项目看过了，这个临时项目可以删除。',
        '注意：固定完成项目不能删除。'
      ),
      side: 'right',
      align: 'start',
    },
  })
  addActionStepIfPresent(steps, '[data-tour="project-delete"]', {
    popover: {
      title: '删除临时项目',
      description: '点击后会打开删除确认窗。确认后会删除这个临时演示项目、任务单和执行会话。',
      doneBtnText: '打开确认窗',
      side: 'left',
      align: 'center',
    },
  })

  return launchDriver(steps)
}

async function runRemoteComputeSegment() {
  await waitForElement('[data-tour="remote-compute-modal"]')

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="remote-compute-modal"]', {
    popover: {
      title: '远程算力会写成记忆',
      description: '这里读取 aimux remote（远程算力连接配置）清单，也能新增 SSH remote（通过 SSH 连接的远程机器）。生成的结果不会变成技能，而是一条项目记忆，因为主机名、路径、状态和硬件都会随环境变化。',
      side: 'left',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="remote-compute-row"]', {
    popover: {
      title: '选择可用远程机器',
      description: '勾选需要授权给本项目后续执行会话使用的远程机器。状态为 reachable 表示已通过免密 SSH 探测；auth-required 表示还需要处理登录认证。',
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="remote-compute-test"]', {
    popover: {
      title: '连通性测试',
      description: '测试按钮用于确认当前主机名（Host）是否可达。新建真实任务前，先确认远程机器可连接，能减少执行会话里的无效等待。',
      side: 'bottom',
      align: 'center',
    },
  })
  addStepIfPresent(steps, '[data-tour="remote-compute-hardware"]', {
    popover: {
      title: '硬件探测',
      description: '硬件按钮会探测 GPU（图形处理器）、CPU（中央处理器）和内存摘要。这样后续智能体能判断哪些任务适合 GPU，哪些只需要 CPU。',
      side: 'bottom',
      align: 'center',
    },
  })
  addStepIfPresent(steps, '[data-tour="remote-compute-path-input"]', {
    popover: {
      title: '远程工作目录',
      description: '为每台远程机器填写默认工作路径。后续可按记忆中的格式使用命令，例如 `aimux new --remote <Host> --cwd <远程路径> --name <session-name>`。其中 Host 是主机名，cwd 是工作目录，session-name 是会话名称。',
      side: 'bottom',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="remote-compute-add-form"]', {
    popover: {
      title: '新增远程服务器',
      description: '如果清单里没有目标机器，可以在这里录入 alias（别名）、HostName/IP（主机地址）、SSH user（登录用户）、port（端口）和 IdentityFile（私钥文件路径）。真实私钥路径这类信息属于记忆，不属于技能。',
      side: 'left',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="remote-compute-memory-preview"]', {
    popover: {
      title: '记忆文本预览',
      description: '勾选远程机器后会生成一条 Markdown（结构化文本格式）项目记忆。它记录主机名、路径、状态、硬件和使用方式，供新的执行会话使用。',
      side: 'left',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="remote-compute-create-memory"]', {
    popover: {
      title: '创建项目记忆',
      description: '真实使用时点这里写入项目记忆。本案例可以先不创建，理解流程后关闭弹窗，继续创建一个验证执行会话。',
      side: 'top',
      align: 'center',
    },
  })
  addStepIfPresent(steps, '[data-tour="remote-compute-close"]', {
    popover: {
      title: '回到项目页',
      description: '先关闭弹窗。下一步会创建一个验证任务单和执行会话，看这些资料如何被新任务带上。',
      doneBtnText: '关闭弹窗',
      side: 'bottom',
      align: 'center',
      onNextClick: markContextRemoteReviewedAndClick('[data-tour="remote-compute-close"]'),
    },
  })

  return launchDriver(steps)
}

async function runSegment(segment: TourSegment) {
  if (segment === 'home') return runHomeSegment()
  if (segment === 'project-form') return runProjectFormSegment()
  if (segment === 'project') return runProjectSegment()
  if (segment === 'issue-form') return runIssueFormSegment()
  if (segment === 'issue-created') return runIssueCreatedSegment()
  if (segment === 'session-form') return runSessionFormSegment()
  if (segment === 'session-preview') return runSessionPreviewSegment()
  if (segment === 'session-start') return runSessionStartSegment()
  if (segment === 'session-chat') return runSessionChatSegment()
  if (segment === 'session-complete') return runSessionCompleteSegment()
  if (segment === 'project-cleanup') return runProjectCleanupSegment()
  if (segment === 'remote-compute') return runRemoteComputeSegment()
  if (segment === 'logo-review-project') return runLogoReviewProjectSegment()
  if (segment === 'logo-review-issue') return runLogoReviewIssueSegment()
  if (segment === 'logo-review-session') return runLogoReviewSessionSegment()
  if (segment === 'logo-review-extension-project') return runLogoReviewExtensionProjectSegment()
  if (segment === 'logo-review-cleanup') return runLogoReviewCleanupSegment()
  return runProjectDeleteFormSegment()
}

export async function runFirstIssueTourForPath(pathname: string, options: { force?: boolean } = {}) {
  const demo = readActiveGuidedDemo()
  if (!demo?.state.active) return
  const state = demo.state

  const segment = detectSegment(pathname)
  if (!segment) return

  const key = `${demo.kind}:${segment}:${pathname}:${state.projectId || ''}:${state.issueId || ''}:${state.sessionId || ''}`
  if (!options.force && key === lastRunKey) return
  if (preparing) return

  destroyActiveTour()

  preparing = true
  try {
    const started = await runSegment(segment)
    if (started) lastRunKey = key
    else if (lastRunKey === key) lastRunKey = ''
  } finally {
    preparing = false
  }
}

// =====================================================================
// 场景级首触引导 (无状态纯讲解, 不走 demo 门禁).
// 与 startIntroTour 同构: 不写 sessionStorage demo 状态, 不经 runFirstIssueTourForPath
// (后者要求 demo.state.active). 由 tour-controller 在首次进入某场景时按 seen 门禁自动启动,
// 也可由 guide-help 路线卡片手动重温. seen 门禁走后端 /api/profile/scene-seen/:scene (跨设备).
// =====================================================================

export type SceneTourKind = 'admin-center' | 'research-page' | 'session-page' | 'aimux'

// 无状态场景引导分发器: 启动前清场 (避免与 demo 路线冲突), 然后跑对应场景路线.
// onDone 在引导真正启动且销毁时 (用户看完或跳过) 调用, controller 据此标记 seen 门禁.
// 若该场景路线未实现 (返回 false), 不调 onDone, controller 不标记 seen (避免吃掉未来要做的引导).
export async function startSceneTour(scene: SceneTourKind, onDone?: (finished: boolean) => void): Promise<boolean> {
  deactivateActiveDemoTour()
  destroyActiveTour(true)
  let started = false
  const onDestroyed = () => { try { onDone?.(true) } catch {} }
  if (scene === 'admin-center') started = await runAdminCenterTour(onDestroyed)
  else if (scene === 'research-page') started = await runResearchPageTour(onDestroyed)
  else if (scene === 'session-page') started = await runSessionPageTour(onDestroyed)
  else if (scene === 'aimux') started = await runAimuxTour(onDestroyed)
  if (!started) {
    // 未启动: 不绑定 seen (该场景路线尚未实现, 避免静默标记吃掉未来引导).
    try { onDone?.(false) } catch {}
  }
  return started
}

// aimux 能力首触引导 (无状态纯讲解). 以顶栏 aimux 状态徽标 (data-tour="top-aimux-status") 为主轴,
// 讲清 aimux 是什么 → 连上能做什么 (PC 任务模式 / 远程算力 / 端口转发) → 如何连接另一台电脑.
// top-aimux-status 仅桌面端渲染; 非桌面端 (浏览器) 该锚点不存在, waitForElement 超时后 steps 为空,
// launchDriver 返回 false, startSceneTour 据此不标记 seen (aimux 本就是桌面端特性, 浏览器端不启动合理).
async function runAimuxTour(onDestroyed?: () => void): Promise<boolean> {
  await waitForElement('[data-tour="top-aimux-status"]', 4200)

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="top-aimux-status"]', {
    popover: {
      title: '什么是 aimux',
      description: guideParagraphs(
        '这个绿点就是 aimux,它是莫比乌斯与你电脑之间的反向连接通道。',
        '桌面端登录后会自动连上——连上之后,智能体就能在你电脑上运行命令、修改代码、操作文件。'
      ),
      nextBtnText: '看它能做什么',
      doneBtnText: '我了解了',
      side: 'bottom',
      align: 'end',
    },
  })
  addStepIfPresent(steps, '[data-tour="top-aimux-status"]', {
    popover: {
      title: '连上 aimux 能做什么',
      description: guideParagraphs(
        '① 让智能体在你电脑上干活:新建会话时选「PC 任务模式」。',
        '② 调度别的机器:用「远程算力」把其他 SSH 电脑也接进来一起干活。',
        '③ 端口转发:把本机的服务暴露给服务器使用。'
      ),
      nextBtnText: '怎么连别的电脑',
      doneBtnText: '我了解了',
      side: 'bottom',
      align: 'end',
    },
  })
  addStepIfPresent(steps, '[data-tour="top-aimux-status"]', {
    popover: {
      title: '连接另一台电脑',
      description: guideParagraphs(
        '想让另一台电脑 (Windows / Mac / Linux) 也连进来,从右上角头像菜单打开「AIMUX 连接指引」。',
        '那里有一条现成命令,复制到那台电脑执行即可,几秒后它就会出现在已连接列表里。'
      ),
      doneBtnText: '完成',
      side: 'bottom',
      align: 'end',
    },
  })

  return launchDriver(steps, onDestroyed)
}

// 管理中心首触引导. 复用 tcrgsz 分镜文案 (每个 tab 一句中文).
// 8 个 tab 条件挂载, 故采用"点 tab → 等内容挂载 → 讲解"链式 step (单个 driver 实例内完成).
// 点切换按钮(tab/视图)后, 轮询等目标 section 挂载, 再 refresh+moveNext.
// driver.js 的 onNextClick 是同步的, 不能 await; 故 moveNext 放 setTimeout 内轮询, 模仿
// addClickNextStepIfPresent 的同步模式 (该模式已被现有 demo 路线证明可工作).
function clickSwitchThenMoveNext(opts: { driver: Driver }, toggleSelector: string, sectionSelector: string) {
  clickIfPresent(toggleSelector)
  const started = Date.now()
  const poll = () => {
    if (Date.now() - started > 3200) return // 超时放弃, 避免永久卡住
    if (document.querySelector(sectionSelector)) {
      try { opts.driver.refresh() } catch {}
      window.setTimeout(() => { try { opts.driver.moveNext() } catch {} }, 40)
      return
    }
    window.setTimeout(poll, 80)
  }
  window.setTimeout(poll, 80)
}

function addAdminTabStep(
  steps: DriveStep[],
  tabSelector: string,
  sectionSelector: string,
  popover: { title: string; description: string; doneBtnText?: string },
) {
  // 高亮 tab 按钮; 用户点"下一步"时, 同步点该 tab, 轮询等 section 挂载后 refresh+moveNext 到 section 讲解 step.
  addStepIfPresent(steps, tabSelector, {
    popover: {
      ...popover,
      nextBtnText: '切到这里看',
      side: 'top',
      align: 'center',
    } as any,
  } as any)
  const lastStep = steps[steps.length - 1] as any
  if (lastStep) {
    lastStep.popover = {
      ...(lastStep.popover as any),
      onNextClick: (_element: any, _step: any, opts: { driver: Driver }) => {
        clickSwitchThenMoveNext(opts, tabSelector, sectionSelector)
      },
    }
  }
  // 切换后高亮该 tab 的 section 讲解一句. 用 pushStepAlways: section 此刻可能未挂载 (条件渲染),
  // 但 onNextClick 的 poll 会等它出现才 moveNext, 切过去时元素已存在.
  pushStepAlways(steps, sectionSelector, {
    popover: {
      title: popover.title,
      description: guideParagraphs(popover.description),
      doneBtnText: popover.doneBtnText,
      side: 'top',
      align: 'center',
    } as any,
  } as any)
}

async function runAdminCenterTour(onDestroyed?: () => void): Promise<boolean> {
  await waitForElement('[data-tour="admin-center-header"]', 4200)
  await waitForElement('[data-tour="admin-tab-bar"]', 1800)

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="admin-center-header"]', {
    popover: {
      title: '这里是管理中心',
      description: guideParagraphs(
        '这是系统级管理的总入口。',
        '下面的模块按需切换，每个管一个方面。'
      ),
      nextBtnText: '看模块切换',
      doneBtnText: '我了解了',
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="admin-tab-bar"]', {
    popover: {
      title: '按模块切换',
      description: guideParagraphs(
        '这里八个模块各自独立。',
        '跟着引导逐个看一遍，了解每个模块管什么。'
      ),
      nextBtnText: '看用户管理',
      doneBtnText: '我了解了',
      side: 'bottom',
      align: 'start',
    },
  })
  // users 是默认激活 tab (页面打开即显示), 直接高亮讲解, 不需"切换"动作.
  addStepIfPresent(steps, '[data-tour="admin-section-users"]', {
    popover: {
      title: '用户管理',
      description: guideParagraphs('管员工账号、角色(管理员/成员)和权限。'),
      nextBtnText: '下一个模块',
      doneBtnText: '我了解了',
      side: 'top',
      align: 'center',
    },
  })
  // 其余 tab 需点击切换后讲解 (条件挂载, 故用链式 step: 点 tab → poll 等 section → moveNext).
  addAdminTabStep(steps, '[data-tour="admin-tab-models"]', '[data-tour="admin-section-models"]', {
    title: '模型接入',
    description: '配置各 AI 模型的接入通道、密钥和网络代理。',
    doneBtnText: '下一个模块',
  })
  addAdminTabStep(steps, '[data-tour="admin-tab-settings"]', '[data-tour="admin-section-settings"]', {
    title: '系统设置',
    description: '模型创建配额、全局默认模型和代理链都在这里。',
    doneBtnText: '下一个模块',
  })
  addAdminTabStep(steps, '[data-tour="admin-tab-extensions"]', '[data-tour="admin-section-extensions"]', {
    title: '拓展管理',
    description: '安装、启用、隐藏莫比乌斯的拓展插件。',
    doneBtnText: '下一个模块',
  })
  addAdminTabStep(steps, '[data-tour="admin-tab-migration"]', '[data-tour="skill-memory-manage-panel"]', {
    title: 'Skill与Memory管理',
    description: '迁移并管理项目级的技能和记忆。',
    doneBtnText: '完成',
  })
  addStepIfPresent(steps, '[data-tour="admin-center-header"]', {
    popover: {
      title: '改动影响所有人',
      description: guideParagraphs(
        '这些设置对全站生效，改前先确认。',
        '想重看时从右上角问号进引导中心重温。'
      ),
      doneBtnText: '完成',
      side: 'right',
      align: 'start',
    },
  })

  return launchDriver(steps, onDestroyed)
}

// Research 课题页首触引导. 复用 lo663f 分镜文案 (短句, 中文优先).
// 三视图 (对话/图谱/黑板) 靠 ?view= search param 切换, 点击后组件异步挂载, 故用与 admin 同构的
// "点切换按钮 → 等容器挂载 → 讲解" 链式 step (单个 driver 实例内完成).
function addResearchViewStep(
  steps: DriveStep[],
  toggleSelector: string,
  viewSelector: string,
  popover: { title: string; description: string; doneBtnText?: string },
) {
  addStepIfPresent(steps, toggleSelector, {
    popover: {
      ...popover,
      nextBtnText: '切到这里看',
      side: 'right',
      align: 'start',
    } as any,
  } as any)
  const lastStep = steps[steps.length - 1] as any
  if (lastStep) {
    lastStep.popover = {
      ...(lastStep.popover as any),
      onNextClick: (_element: any, _step: any, opts: { driver: Driver }) => {
        clickSwitchThenMoveNext(opts, toggleSelector, viewSelector)
      },
    }
  }
  // 视图切换后高亮容器. 用 pushStepAlways: blackboard/graph 容器此刻未挂载 (?view= 切换才渲染),
  // 但 poll 会等它出现才 moveNext, 切过去时元素已存在.
  pushStepAlways(steps, viewSelector, {
    popover: {
      title: popover.title,
      description: guideParagraphs(popover.description),
      doneBtnText: popover.doneBtnText,
      side: 'left',
      align: 'start',
    } as any,
  } as any)
}

async function runResearchPageTour(onDestroyed?: () => void): Promise<boolean> {
  await waitForElement('[data-tour="research-header"]', 4200)
  await waitForElement('[data-tour="research-agent-list"]', 1800)

  const steps: DriveStep[] = []
  addStepIfPresent(steps, '[data-tour="research-header"]', {
    popover: {
      title: '研究课题工作台',
      description: guideParagraphs(
        '这是莫比乌斯的研究子系统。',
        '一个研究课题里，可以组建多智能体团队协作。'
      ),
      nextBtnText: '看 Agent 列表',
      doneBtnText: '我了解了',
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="research-agent-list"]', {
    popover: {
      title: '研究员列表',
      description: guideParagraphs(
        '这里是这个课题里的研究员。',
        '首席研究员锁定不可删，统筹全局；研究助理并行执行子任务，把进展写回黑板。'
      ),
      nextBtnText: '看新建入口',
      doneBtnText: '我了解了',
      side: 'right',
      align: 'start',
    },
  })
  addStepIfPresent(steps, '[data-tour="research-new-agent"]', {
    popover: {
      title: '新建研究员',
      description: guideParagraphs(
        '点这里可以创建单个研究员，也可以一键拉起一个团队。',
        '团队默认一名首席加若干助理。'
      ),
      nextBtnText: '看协作黑板',
      doneBtnText: '我了解了',
      side: 'right',
      align: 'start',
    },
  })
  addResearchViewStep(steps, '[data-tour="research-toggle-blackboard"]', '[data-tour="research-blackboard"]', {
    title: '协作黑板',
    description: '黑板汇总各研究员实时写回的研究进展与结论，自动刷新。',
    doneBtnText: '看研究图谱',
  })
  addResearchViewStep(steps, '[data-tour="research-toggle-graph"]', '[data-tour="research-graph"]', {
    title: '研究图谱',
    description: '图谱用节点图展示团队的分工与研究进展，可拖拽布局。',
    doneBtnText: '完成',
  })
  addStepIfPresent(steps, '[data-tour="research-header"]', {
    popover: {
      title: '研究是项目级能力',
      description: guideParagraphs(
        '研究功能需在项目设置里开启。',
        '想重看时从右上角问号进引导中心重温。'
      ),
      doneBtnText: '完成',
      side: 'right',
      align: 'start',
    },
  })

  return launchDriver(steps, onDestroyed)
}

// Session 会话页首触引导. 仅在 controller 检测到有 currentSession 时触发 (无 session 不讲).
// 强制点击式: 除"发送"外, 每步隐藏"下一步"按钮, 用户必须点击高亮按钮本身才前进 (capture 监听),
// 按钮真实功能照常触发; Bash 步点击会开弹窗, 点击后自动关遮罩再前进.
// "发送"步例外: 空输入时按钮 disabled 点不动, 故用普通"下一步" (讲解而非强制点击).
async function runSessionPageTour(onDestroyed?: () => void): Promise<boolean> {
  await waitForElement('[data-tour="session-chat-send"]', 4200)

  const steps: DriveStep[] = []
  addClickToAdvanceStep(steps, '[data-tour="top-layout-toggle"]', {
    title: '切换工作区布局',
    description: '在三种不同的工作布局之间快速切换（日常、代码、文件）。\n点击高亮按钮继续；找不到时也可点“下一步”跳过。',
    side: 'bottom',
    align: 'end',
  })
  addStepIfPresent(steps, '[data-tour="session-chat-send"]', {
    popover: {
      title: '发送指令',
      description: '把写好的指令发给智能体执行。',
      nextBtnText: '看 Skill 与记忆',
      doneBtnText: '我了解了',
      side: 'top',
      align: 'start',
    },
  })
  addClickToAdvanceStep(steps, '[data-tour="session-memory-toggle"]', {
    title: 'Skill 与记忆',
    description: '这里显示当前会话启用的技能和记忆，智能体忘了时可临时追加给它。\n点击高亮按钮继续；找不到时也可点“下一步”跳过。',
    side: 'top',
    align: 'start',
  })
  addClickToAdvanceStep(steps, '[data-tour="session-bash-commands"]', {
    title: '查看会话命令',
    description: '回看智能体执行过的所有 Bash 命令与结果。\n点击高亮按钮继续；找不到时也可点“下一步”跳过。',
    side: 'top',
    align: 'start',
  })
  addClickToAdvanceStep(steps, '[data-tour="session-cooperable-pc"]', {
    title: '声明可合作计算机',
    description: '生成一条声明直接发给智能体，告诉它需要时可调用 SSH 服务器算力，或与任意笔记本电脑、工作站、嵌入式设备、云 GPU 服务器协同工作。\n点击高亮按钮完成；或点“完成”结束引导。',
    doneBtnText: '完成',
    side: 'top',
    align: 'start',
  }, { done: true })

  return launchDriver(steps, onDestroyed, { disableOverlayClose: true })
}
