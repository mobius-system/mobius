export const BIRTHDAY_DEMO_TOUR_EVENT = 'imac:birthday-demo-tour:start'
export const BIRTHDAY_DEMO_STATE_KEY = 'imac-demo:mobius-dot-logo-space'

export type BirthdayDemoState = {
  active?: boolean
  startedAt?: number
  completedAt?: number
  sessionCompletedAt?: number
  projectId?: string
  issueId?: string
  sessionId?: string
  projectName: string
  projectDescription: string
  projectRelPath: string
  issueTitle: string
  issueDescription: string
  sessionName: string
  sessionDescription: string
}

export const BIRTHDAY_DEMO_DEFAULTS = {
  projectName: '莫比乌斯光点标志空间案例',
  projectDescription: '用于第一次完成任务的演示项目：检查并迭代一个已经准备好的莫比乌斯光点视觉拓展。',
  projectRelPath: '/imac-demo/mobius-dot-logo-space',
  issueTitle: '设计莫比乌斯光点标志空间',
  issueDescription: [
    '请基于当前项目中已经准备好的莫比乌斯拓展原型，完成一个 Three.js 光点标志空间设计迭代。',
    '',
    '目标：',
    '1. 光点沿莫比乌斯环缓慢流动，明暗按呼吸节奏变化。',
    '2. 支持调整环半径、带宽、扭数、纵向缩放、光点密度、调色盘、视角、流速、呼吸频率和呼吸幅度。',
    '3. 保持莫比乌斯拓展结构：extension.json、frontend/index.html、frontend/main.js、frontend/styles.css、backend/extension_backend_handler.js。',
    '4. 使用项目记忆中的设计约束，并使用项目技能 mobius-extension 检查拓展协议。',
    '5. 不提交 node_modules、frontend/dist 或其他构建产物。',
    '6. 完成后更新 README.md，并新增或更新 AGENT_OUTPUT_GUIDE.md，说明智能体执行日志中常见字段是什么意思、应该怎么看。',
  ].join('\n'),
  sessionName: '迭代 Three.js 光点标志空间',
  sessionDescription: [
    '请在当前项目目录中完成莫比乌斯光点标志空间的设计迭代。',
    '',
    '开始前：',
    '1. 读取 README.md、extension.json、frontend/ 和 backend/ 下的真实代码。',
    '2. 读取注入的项目记忆和 mobius-extension 技能。',
    '3. 先判断现有原型已经完成哪些能力，再只做必要的小幅代码改动或文档补齐。',
    '',
    '执行要求：',
    '1. 保持零编译优先；除非确有必要，不要新增 package.json，不要安装依赖。',
    '2. 确认 frontend/index.html 使用 importmap 引入 Three.js，frontend/main.js 使用 Three.js 和 OrbitControls。',
    '3. 确认交互控制覆盖形状、密度、调色盘、视角和运动参数。',
    '4. 如果改动后端 handler，必须保持 CommonJS、stateless，并只写 ext_data_dir。',
    '5. 更新 README.md，说明项目结构和如何把原型放入 mobius/extension/ 运行。',
    '6. 新增或更新 AGENT_OUTPUT_GUIDE.md，用面向新用户的中文解释执行日志常见字段：user、assistant/response_item、tool_use/function_call、tool_result/function_call_output、event_msg、session_meta、turn_context、input、result、output、error、usage、status。',
    '',
    '约束：',
    '* 不要修改项目目录之外的文件。',
    '* 不要提交 node_modules 或 frontend/dist。',
    '* 不要启动长期运行的服务器。',
    '',
    '完成后请总结：检查了哪些文件、实际改了哪些文件、是否保持莫比乌斯拓展协议、用户应该如何阅读这次执行日志。',
  ].join('\n'),
} satisfies Omit<BirthdayDemoState, 'active' | 'startedAt' | 'completedAt' | 'projectId' | 'issueId' | 'sessionId'>

export function createBirthdayDemoState(): BirthdayDemoState {
  return {
    active: true,
    startedAt: Date.now(),
    ...BIRTHDAY_DEMO_DEFAULTS,
  }
}

function normalizeBirthdayDemoState(value: unknown): BirthdayDemoState | null {
  if (!value || typeof value !== 'object') return null
  return {
    ...BIRTHDAY_DEMO_DEFAULTS,
    ...(value as Partial<BirthdayDemoState>),
  }
}

export function readBirthdayDemoState(): BirthdayDemoState | null {
  try {
    const raw = sessionStorage.getItem(BIRTHDAY_DEMO_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return normalizeBirthdayDemoState(parsed)
  } catch {
    return null
  }
}

export function writeBirthdayDemoState(state: BirthdayDemoState) {
  try {
    sessionStorage.setItem(BIRTHDAY_DEMO_STATE_KEY, JSON.stringify(state))
  } catch {}
}

export function patchBirthdayDemoState(patch: Partial<BirthdayDemoState>) {
  const current = readBirthdayDemoState() || createBirthdayDemoState()
  writeBirthdayDemoState({ ...current, ...patch })
}

export function completeBirthdayDemoState() {
  patchBirthdayDemoState({ active: false, completedAt: Date.now() })
}

export function birthdayDemoIsActive() {
  return !!readBirthdayDemoState()?.active
}

export function isBirthdayDemoProject(projectId?: string) {
  const state = readBirthdayDemoState()
  return !!state?.active && !!projectId && state.projectId === projectId
}

export function isBirthdayDemoIssue(issueId?: string) {
  const state = readBirthdayDemoState()
  return !!state?.active && !!issueId && state.issueId === issueId
}

export function isBirthdayDemoSession(sessionId?: string) {
  const state = readBirthdayDemoState()
  return !!state?.active && !!sessionId && state.sessionId === sessionId
}
