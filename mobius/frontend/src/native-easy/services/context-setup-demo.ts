import { HIDDEN_FOLDER_NAME } from '../store'

export const CONTEXT_SETUP_DEMO_TOUR_EVENT = 'imac:context-setup-demo-tour:start'
export const CONTEXT_SETUP_DEMO_STATE_KEY = 'imac-demo:context-setup'

export type ContextSetupDemoState = {
  active?: boolean
  startedAt?: number
  completedAt?: number
  sessionCompletedAt?: number
  memorySyncedAt?: number
  skillImportedAt?: number
  preparedAt?: number
  projectId?: string
  issueId?: string
  sessionId?: string
  projectName: string
  projectDescription: string
  projectRelPath: string
  projectKnowledgeRelPath: string
  skillSourceRelPath: string
  memoryMaterialRelPath: string
  skillMaterialRelPath: string
  materialsZipRelPath: string
  sampleNotesRelPath: string
  outputRelPath: string
  issueTitle: string
  issueDescription: string
  sessionName: string
  sessionDescription: string
  memoryName: string
  skillName: string
  skillDescription: string
}

export const CONTEXT_SETUP_DEMO_DEFAULTS = {
  projectName: '莫比乌斯开发资料配置案例',
  projectDescription: '学习把莫比乌斯开发项目知识和拓展开发方法导入项目，让新的执行会话带上这些资料。',
  projectRelPath: '/imac-demo/context-setup',
  projectKnowledgeRelPath: `/imac-demo/context-setup/${HIDDEN_FOLDER_NAME}/project_knowledge.md`,
  skillSourceRelPath: `/imac-demo/context-setup/${HIDDEN_FOLDER_NAME}/uploaded-skills/mobius-extension`,
  memoryMaterialRelPath: 'context-materials/project_knowledge.md',
  skillMaterialRelPath: 'context-materials/mobius-extension/SKILL.md',
  materialsZipRelPath: 'context-materials/context-setup-materials.zip',
  sampleNotesRelPath: 'README.md',
  outputRelPath: 'CONTEXT_CHECK.md',
  issueTitle: '验证莫比乌斯开发资料已注入',
  issueDescription: [
    '# 背景',
    '这是一个莫比乌斯开发资料配置演示。目标是学习项目知识和项目方法会如何进入新的执行会话。',
    '',
    '这条路线只验证资料注入，不修改莫比乌斯自身代码。',
    '',
    '# 目标',
    '读取当前项目的 README.md 和本次注入的上下文，生成 `CONTEXT_CHECK.md`。',
    '',
    '# 输入',
    '- 项目知识：`莫比乌斯自主开发项目知识`，说明莫比乌斯是什么、代码位置、验证命令和安全边界。',
    '- 项目方法：`mobius-extension`，说明如何开发莫比乌斯拓展以及必须遵守的协议。',
    '',
    '# 执行步骤',
    '1. 读取 README.md。',
    '2. 检查注入上下文里是否包含 `莫比乌斯自主开发项目知识` 和 `mobius-extension`。',
    '3. 写入 `CONTEXT_CHECK.md`，用中文列出这两份资料分别提供了什么帮助。',
    '',
    '# 验收标准',
    '- `CONTEXT_CHECK.md` 已生成。',
    '- 内容明确区分项目知识和项目方法。',
    '- 不修改莫比乌斯源码。',
    '- 不加入真实账号、token 或私人信息。',
    '',
    '# 最终回复',
    '请用 4 行以内说明：读取了哪个文件、生成了哪个文件、看到了哪条项目知识和项目方法、是否修改了源码。',
  ].join('\n'),
  sessionName: '验证开发资料注入',
  sessionDescription: [
    '# 背景',
    '这是一个莫比乌斯开发资料配置演示。用户要确认项目知识和项目方法已经进入新的执行会话。',
    '',
    '这一步只是验证资料配置，不修改莫比乌斯自身。',
    '',
    '# 目标',
    '读取 README.md，生成 `CONTEXT_CHECK.md`，说明本次带入的两份资料如何帮助智能体工作。',
    '',
    '# 输入',
    '- 项目知识：`莫比乌斯自主开发项目知识`。',
    '- 项目方法：`mobius-extension`。',
    '',
    '# 执行步骤',
    '1. 读取 README.md。',
    '2. 查看当前注入上下文，确认包含 `莫比乌斯自主开发项目知识` 和 `mobius-extension`。',
    '3. 写入 `CONTEXT_CHECK.md`。',
    '4. 在文件中用两小段说明：项目知识告诉了哪些事实，项目方法告诉了哪些做法。',
    '',
    '# 验收标准',
    '- `CONTEXT_CHECK.md` 已生成。',
    '- 内容明确区分项目知识和项目方法。',
    '- 没有修改莫比乌斯源码。',
    '- 不加入真实账号、token 或私人信息。',
    '',
    '# 边界',
    '- 不要使用外部服务。',
    '- 不要安装依赖。',
    '- 不要修改莫比乌斯自身代码。',
    '- 不要加入真实账号、token 或私人信息。',
    '',
    '# 最终回复',
    '请用 4 行以内说明：读取了哪个文件、生成了哪个文件、看到了哪条项目知识和项目方法、是否修改了源码。',
  ].join('\n'),
  memoryName: '莫比乌斯自主开发项目知识',
  skillName: 'mobius-extension',
  skillDescription: '开发莫比乌斯拓展时使用的项目方法，包含目录结构、前端 SDK、后端 handler 协议和安全边界。',
} satisfies Omit<ContextSetupDemoState, 'active' | 'startedAt' | 'completedAt' | 'memorySyncedAt' | 'skillImportedAt' | 'preparedAt' | 'projectId' | 'issueId' | 'sessionId'>

export function contextSetupDemoAbsPath(userWorkDir: string | undefined, relPath: string | undefined) {
  const root = (userWorkDir || '').replace(/\/+$/, '')
  const rel = (relPath || '').replace(/^\/+/, '')
  return root && rel ? `${root}/${rel}` : ''
}

export function createContextSetupDemoState(): ContextSetupDemoState {
  return {
    active: true,
    startedAt: Date.now(),
    ...CONTEXT_SETUP_DEMO_DEFAULTS,
  }
}

function normalizeContextSetupDemoState(value: unknown): ContextSetupDemoState | null {
  if (!value || typeof value !== 'object') return null
  return {
    ...CONTEXT_SETUP_DEMO_DEFAULTS,
    ...(value as Partial<ContextSetupDemoState>),
  }
}

export function readContextSetupDemoState(): ContextSetupDemoState | null {
  try {
    const raw = sessionStorage.getItem(CONTEXT_SETUP_DEMO_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return normalizeContextSetupDemoState(parsed)
  } catch {
    return null
  }
}

export function writeContextSetupDemoState(state: ContextSetupDemoState) {
  try {
    sessionStorage.setItem(CONTEXT_SETUP_DEMO_STATE_KEY, JSON.stringify(state))
  } catch {}
}

export function patchContextSetupDemoState(patch: Partial<ContextSetupDemoState>) {
  const current = readContextSetupDemoState() || createContextSetupDemoState()
  writeContextSetupDemoState({ ...current, ...patch })
}

export function completeContextSetupDemoState() {
  patchContextSetupDemoState({ active: false, completedAt: Date.now() })
}

export function contextSetupDemoIsActive() {
  return !!readContextSetupDemoState()?.active
}

export function isContextSetupDemoProject(projectId?: string) {
  const state = readContextSetupDemoState()
  return !!state?.active && !!projectId && state.projectId === projectId
}

export function isContextSetupDemoIssue(issueId?: string) {
  const state = readContextSetupDemoState()
  return !!state?.active && !!issueId && state.issueId === issueId
}

export function isContextSetupDemoSession(sessionId?: string) {
  const state = readContextSetupDemoState()
  return !!state?.active && !!sessionId && state.sessionId === sessionId
}
