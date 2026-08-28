export const SELF_EVOLVE_DEMO_TOUR_EVENT = 'imac:self-evolve-demo-tour:start'
export const SELF_EVOLVE_DEMO_STATE_KEY = 'imac-demo:self-evolve'

export const SELF_EVOLVE_REQUIRED_SKILL_NAME = 'mobius-extension'
export const SELF_EVOLVE_REQUIRED_MEMORY_NAME = '莫比乌斯自主开发项目知识'
export const SELF_EVOLVE_PROJECT_KNOWLEDGE_MEMORY_NAME = 'MOBIUS中台开发的项目知识'
export const SELF_EVOLVE_GUIDE_STYLE_MEMORY_NAMES = ['用户引导文案写法', '引导文案与路线设计规则', 'guide-copywriting-style']

export const SELF_EVOLVE_MEMORY_BODY = [
  '# 莫比乌斯自主开发项目知识',
  '',
  '这是一份用于莫比乌斯自迭代任务的项目知识。它告诉智能体当前系统是什么、代码在哪里、怎么验证，以及哪些边界不能碰。',
  '',
  '## 项目定位',
  '',
  '- 莫比乌斯是自进化 Agent 工作台，把项目资料、任务单和执行会话串起来。',
  '- 核心工作模型是 Project -> Issue -> Session：项目保存长期资料，任务单写清本次目标，执行会话负责真实执行。',
  '- 修改莫比乌斯自身时，应在自迭代项目中创建受控任务，明确文件范围、验收命令和禁止事项。',
  '',
  '## 代码位置',
  '',
  '- 主前端代码在 `mobius/frontend/src/`。',
  '- 后端接口在 `mobius/backend/`。',
  '- 引导中心入口主要在 `mobius/frontend/src/components/guide-help.tsx`。',
  '- Driver.js 引导路线主要在 `mobius/frontend/src/services/tour.ts`。',
  '- 演示状态文件在 `mobius/frontend/src/services/*-demo.ts`。',
  '- 演示素材准备在 `mobius/backend/services/guided-demo-assets.js`。',
  '- 莫比乌斯拓展优先放在 `mobius/extension/<name>/`。',
  '',
  '## 修改边界',
  '',
  '- 只有通用能力、核心流程或共享 UI 才修改主项目。',
  '- 单个拓展应用优先放在 `mobius/extension/<name>/`，不要为了一个拓展改主项目协议。',
  '- 不要改无关文件，不要顺手重构。',
  '- 不要提交 `node_modules/`、`dist/`、临时日志或构建产物。',
  '- 不要写入真实账号、密码、token 或私人凭据。',
  '',
  '## 常用验证',
  '',
  '- 前端构建：`cd mobius/frontend && npm run build`。',
  '- 后端语法检查：`node -c <modified-backend-file.js>`。',
  '- 引导路线修改后，优先用短文案、稳定 `data-tour` 选择器和真实页面检查验证。',
].join('\n')

export type SelfEvolveDemoState = {
  active?: boolean
  startedAt?: number
  completedAt?: number
  sessionCompletedAt?: number
  projectId?: string
  projectName: string
  projectDescription?: string
  projectRelPath?: string
  issueId?: string
  sessionId?: string
  issueTitle: string
  issueDescription: string
  sessionName: string
  sessionDescription: string
  requiredSkillName: string
  requiredMemoryName: string
}

export const SELF_EVOLVE_DEMO_DEFAULTS = {
  projectName: '莫比乌斯自迭代项目',
  projectDescription: '绑定莫比乌斯自身代码目录，用来安全改进系统本身。',
  projectRelPath: '/imac-test',
  issueTitle: '更新自迭代演示时间',
  issueDescription: [
    '这是一个莫比乌斯自迭代演示任务。目标是让智能体安全地修改莫比乌斯自身的一处受控文字。',
    '',
    '请只修改引导中心中专门用于演示的时间文字，不要修改其他功能。',
    '',
    '目标：',
    '- 读取当前系统时间。',
    '- 将 `SELF_EVOLVE_DEMO_TIMESTAMP_TEXT` 或同等明确标记区域更新为：`自迭代演示时间：<当前时间>`。',
    '- 当前时间必须在执行时通过系统命令获取，例如 `date \'+%Y-%m-%d %H:%M:%S %Z\'`，不要写死本提示词中的日期。',
    '',
    '严格边界：',
    '- 只允许修改 `mobius/frontend/src/components/guide-help.tsx` 中的演示时间常量或明确标记区域。',
    '- 不允许修改路由结构。',
    '- 不允许修改后端。',
    '- 不允许修改数据库。',
    '- 不允许修改 package 文件。',
    '- 不允许重构引导系统。',
    '- 如果找不到明确标记区域，停止并说明原因。',
    '',
    '验收：',
    '- 页面中能看到新的“自迭代演示时间”文字。',
    '- 前端构建通过。',
  ].join('\n'),
  sessionName: '安全更新自迭代演示时间',
  sessionDescription: [
    '请执行一个最小自迭代验证：只更新引导中心中专门用于演示的时间文字。',
    '',
    '必须先确认当前 Session 已带上这些上下文：',
    '- Skill：`mobius-extension`',
    '- Memory：`莫比乌斯自主开发项目知识`',
    '- 当前自迭代项目必要 Memory，例如项目知识和引导文案规则',
    '',
    '执行步骤：',
    '1. 读取 `mobius/frontend/src/components/guide-help.tsx`。',
    '2. 找到 `SELF_EVOLVE_DEMO_TIMESTAMP_TEXT` 或明确标记为自迭代演示时间的区域。',
    '3. 运行 `date \'+%Y-%m-%d %H:%M:%S %Z\'` 获取执行时当前时间。',
    '4. 只更新这一个演示文字。',
    '5. 运行 `cd mobius/frontend && npm run build` 验证。',
    '6. 最终回复说明：读取了哪个文件、修改了哪一处、写入的时间、验证命令是否通过。',
    '',
    '禁止事项：',
    '- 不要修改除演示时间文字以外的内容。',
    '- 不要改后端。',
    '- 不要改数据模型。',
    '- 不要改其他引导路线。',
    '- 不要重构。',
  ].join('\n'),
  requiredSkillName: SELF_EVOLVE_REQUIRED_SKILL_NAME,
  requiredMemoryName: SELF_EVOLVE_REQUIRED_MEMORY_NAME,
} satisfies Omit<SelfEvolveDemoState, 'active' | 'startedAt' | 'completedAt' | 'sessionCompletedAt' | 'projectId' | 'issueId' | 'sessionId'>

export function createSelfEvolveDemoState(patch: Partial<SelfEvolveDemoState> = {}): SelfEvolveDemoState {
  return {
    active: true,
    startedAt: Date.now(),
    ...SELF_EVOLVE_DEMO_DEFAULTS,
    ...patch,
  }
}

function normalizeSelfEvolveDemoState(value: unknown): SelfEvolveDemoState | null {
  if (!value || typeof value !== 'object') return null
  return {
    ...SELF_EVOLVE_DEMO_DEFAULTS,
    ...(value as Partial<SelfEvolveDemoState>),
  }
}

export function readSelfEvolveDemoState(): SelfEvolveDemoState | null {
  try {
    const raw = sessionStorage.getItem(SELF_EVOLVE_DEMO_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return normalizeSelfEvolveDemoState(parsed)
  } catch {
    return null
  }
}

export function writeSelfEvolveDemoState(state: SelfEvolveDemoState) {
  try {
    sessionStorage.setItem(SELF_EVOLVE_DEMO_STATE_KEY, JSON.stringify(state))
  } catch {}
}

export function patchSelfEvolveDemoState(patch: Partial<SelfEvolveDemoState>) {
  const current = readSelfEvolveDemoState() || createSelfEvolveDemoState()
  writeSelfEvolveDemoState({ ...current, ...patch })
}

export function completeSelfEvolveDemoState() {
  patchSelfEvolveDemoState({ active: false, completedAt: Date.now() })
}

export function isSelfEvolveDemoProject(projectId?: string) {
  const state = readSelfEvolveDemoState()
  return !!state?.active && !!projectId && state.projectId === projectId
}

export function isSelfEvolveDemoIssue(issueId?: string) {
  const state = readSelfEvolveDemoState()
  return !!state?.active && !!issueId && state.issueId === issueId
}

export function isSelfEvolveDemoSession(sessionId?: string) {
  const state = readSelfEvolveDemoState()
  return !!state?.active && !!sessionId && state.sessionId === sessionId
}
