export const PROJECT_IMPORT_DEMO_TOUR_EVENT = 'imac:project-import-demo-tour:start'
export const PROJECT_IMPORT_DEMO_STATE_KEY = 'imac-demo:project-import'

export type ProjectImportDemoState = {
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
  gitUrl: string
  uploadExampleName: string
  uploadFileExamples: string[]
  uploadSampleDirRelPath: string
  uploadSampleZipRelPath: string
  preparedAt?: number
  uploadSampleDownloadedAt?: number
  uploadSampleUploadedAt?: number
  uploadWalkthroughCompletedAt?: number
  uploadSampleClearedAt?: number
}

export const PROJECT_IMPORT_DEMO_DEFAULTS = {
  projectName: '待办事项项目导入案例',
  projectDescription: '一个用于学习导入已有代码的演示项目：待办事项示例体量小、入口清楚，适合练习网页上传和公开仓库下载两种常用导入方式。',
  projectRelPath: '/imac-demo/todomvc-import',
  issueTitle: '导入待办事项示例项目',
  gitUrl: 'https://github.com/tastejs/todomvc.git',
  uploadExampleName: '待办事项上传样例',
  uploadFileExamples: ['index.html', 'package.json', 'src/app.js', 'src/styles.css'],
  uploadSampleDirRelPath: 'upload-samples/vanilla-todomvc',
  uploadSampleZipRelPath: 'upload-samples/vanilla-todomvc-upload-sample.zip',
  issueDescription: [
    '# 背景',
    '这是一个导入已有代码的演示。用户要学习：如何把公开仓库下载到莫比乌斯项目目录。',
    '',
    '# 目标',
    '将公开仓库 `https://github.com/tastejs/todomvc.git` 下载到当前项目绑定目录，并说明入口文件在哪里。',
    '',
    '# 执行步骤',
    '1. 先检查当前目录是否为空。',
    '2. 如果为空，执行浅克隆：`git clone --depth 1 https://github.com/tastejs/todomvc.git .`。',
    '3. 如果不为空，克隆到 `todomvc-source/`，不要覆盖已有文件。',
    '4. 下载后检查 `examples/vanillajs/`。',
    '5. 列出用户最应该打开的 3-5 个文件。',
    '',
    '# 边界',
    '- 不使用私人仓库、账号、token 或个人路径。',
    '- 不删除已有文件。',
    '- 不启动长期运行的服务器。',
    '',
    '# 最终回复',
    '请说明：仓库下载到了哪里、TodoMVC 的经典示例在哪里、用户可以先打开哪些文件、是否遇到下载或目录冲突问题。',
  ].join('\n'),
  sessionName: '下载并整理待办事项示例仓库',
  sessionDescription: [
    '# 背景',
    '这是一个导入已有代码的演示。用户要学习如何让智能体把公开仓库下载到项目目录。',
    '',
    '# 目标',
    '将公开仓库 `https://github.com/tastejs/todomvc.git` 下载到当前项目绑定目录，并说明入口文件在哪里。',
    '',
    '# 执行步骤',
    '1. 先检查当前目录是否为空。',
    '2. 如果为空，执行浅克隆：`git clone --depth 1 https://github.com/tastejs/todomvc.git .`。',
    '3. 如果不为空，克隆到 `todomvc-source/`，不要覆盖已有文件。',
    '4. 下载后检查 `examples/vanillajs/`。',
    '5. 列出用户最应该打开的 3-5 个文件。',
    '',
    '# 边界',
    '- 不使用私人仓库、账号、token 或个人路径。',
    '- 不删除已有文件。',
    '- 不启动长期运行的服务器。',
    '',
    '# 最终回复',
    '请说明：仓库下载到了哪里、TodoMVC 的经典示例在哪里、用户可以先打开哪些文件、是否遇到下载或目录冲突问题。',
  ].join('\n'),
} satisfies Omit<ProjectImportDemoState, 'active' | 'startedAt' | 'completedAt' | 'uploadSampleDownloadedAt' | 'uploadSampleUploadedAt' | 'uploadWalkthroughCompletedAt' | 'uploadSampleClearedAt' | 'projectId' | 'issueId' | 'sessionId'>

export function createProjectImportDemoState(): ProjectImportDemoState {
  return {
    active: true,
    startedAt: Date.now(),
    ...PROJECT_IMPORT_DEMO_DEFAULTS,
  }
}

function normalizeProjectImportDemoState(value: unknown): ProjectImportDemoState | null {
  if (!value || typeof value !== 'object') return null
  return {
    ...PROJECT_IMPORT_DEMO_DEFAULTS,
    ...(value as Partial<ProjectImportDemoState>),
  }
}

export function readProjectImportDemoState(): ProjectImportDemoState | null {
  try {
    const raw = sessionStorage.getItem(PROJECT_IMPORT_DEMO_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return normalizeProjectImportDemoState(parsed)
  } catch {
    return null
  }
}

export function writeProjectImportDemoState(state: ProjectImportDemoState) {
  try {
    sessionStorage.setItem(PROJECT_IMPORT_DEMO_STATE_KEY, JSON.stringify(state))
  } catch {}
}

export function patchProjectImportDemoState(patch: Partial<ProjectImportDemoState>) {
  const current = readProjectImportDemoState() || createProjectImportDemoState()
  writeProjectImportDemoState({ ...current, ...patch })
}

export function completeProjectImportDemoState() {
  patchProjectImportDemoState({ active: false, completedAt: Date.now() })
}

export function projectImportDemoIsActive() {
  return !!readProjectImportDemoState()?.active
}

export function isProjectImportDemoProject(projectId?: string) {
  const state = readProjectImportDemoState()
  return !!state?.active && !!projectId && state.projectId === projectId
}

export function isProjectImportDemoIssue(issueId?: string) {
  const state = readProjectImportDemoState()
  return !!state?.active && !!issueId && state.issueId === issueId
}

export function isProjectImportDemoSession(sessionId?: string) {
  const state = readProjectImportDemoState()
  return !!state?.active && !!sessionId && state.sessionId === sessionId
}
