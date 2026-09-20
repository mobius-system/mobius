import { driver, type DriveStep, type Driver } from 'driver.js'
import 'driver.js/dist/driver.css'

// =====================================================================
// 管理中心引导 —— 项目内仅保留这一条引导路线.
// 旧的首登叙事引导、引导中心 (guide-help) 的 demo 路线、Research/会话页/aimux 场景引导
// 均已整体移除; 此处只留 runAdminCenterTour 及其所需的 driver 基础设施.
// =====================================================================

const WAIT_STEP_MS = 80

function guideParagraphs(...paragraphs: string[]) {
  return paragraphs.join('\n')
}

let activeDriver: Driver | null = null

function destroyActiveTour() {
  if (activeDriver?.isActive()) {
    activeDriver.destroy()
  }
  activeDriver = null
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

function launchDriver(steps: DriveStep[], onDestroyed?: () => void) {
  if (!steps.length) return false

  let currentDriver: Driver | null = null
  const prefersReducedMotion = typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  currentDriver = driver({
    animate: !prefersReducedMotion,
    smoothScroll: !prefersReducedMotion,
    allowClose: true,
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
    onDestroyed: () => {
      if (activeDriver === currentDriver) activeDriver = null
      onDestroyed?.()
    },
  })

  currentDriver.setSteps(steps)
  activeDriver = currentDriver
  currentDriver.drive()
  return true
}

// 管理中心首触引导. 8 个 tab 条件挂载, 故采用"点 tab → 等内容挂载 → 讲解"链式 step (单个 driver 实例内完成).
// 点切换按钮(tab)后, 轮询等目标 section 挂载, 再 refresh+moveNext.
// driver.js 的 onNextClick 是同步的, 不能 await; 故 moveNext 放 setTimeout 内轮询.
function clickSwitchThenMoveNext(opts: { driver: Driver }, toggleSelector: string, sectionSelector: string) {
  clickIfPresent(toggleSelector)
  const started = Date.now()
  const poll = () => {
    if (Date.now() - started > 3200) {
      // 超时: 目标 section 迟迟没挂载. 直接前进跳过, 不让用户停在"切到这里看"步无法继续
      // (该步的"下一步"已被 onNextClick 消费, 不主动 moveNext 会变成软卡死). 桌面端/web 通用.
      try { opts.driver.moveNext() } catch {}
      return
    }
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
        '想重看时点管理中心标题右侧的引导按钮。'
      ),
      doneBtnText: '完成',
      side: 'right',
      align: 'start',
    },
  })

  return launchDriver(steps, onDestroyed)
}

// 场景引导目前只剩管理中心一条. onDone 在引导真正启动且销毁时 (用户看完或跳过) 调用,
// controller 据此标记 seen 门禁; 未启动 (返回 false) 不标记, 避免吃掉未来的引导.
export type SceneTourKind = 'admin-center'

export async function startSceneTour(scene: SceneTourKind, onDone?: (finished: boolean) => void): Promise<boolean> {
  destroyActiveTour()
  let started = false
  const onDestroyed = () => { try { onDone?.(true) } catch {} }
  if (scene === 'admin-center') started = await runAdminCenterTour(onDestroyed)
  if (!started) {
    try { onDone?.(false) } catch {}
  }
  return started
}
