// 简易模式 / 桌面欢迎页共用的「兜底容器」名字.
//
// 用户在简易模式里不选项目直接对话时, 会话落到这个容器里 (项目 + 任务都按需自动创建).
// 名字会露脸在很多地方, 换名字必须两边一起改:
//   - EasyModePage.tsx (简易模式欢迎页的兜底分支)
//   - Welcome.tsx (桌面端欢迎页「导入一些文件, 随便聊聊」)
// 项目名同时是新建项目的目录名 (bind_path = <工作目录>/快捷任务), 所以别带空格和斜杠.
export const EASY_DEFAULT_PROJECT_NAME = '快捷任务'
export const EASY_DEFAULT_ISSUE_TITLE = '日常会话'
// 「全新项目」这条档新建项目时用的第一个任务名 (与兜底容器无关).
export const EASY_NEW_PROJECT_ISSUE_TITLE = 'demo issue'
export const EASY_DEFAULT_DESCRIPTION = 'no description'

// 历史名字: 改名之前已经建出来的容器还叫这些名字.
// 后端 repositories/projects.ts 顶部有一次幂等改名把它们迁到新名字; 这里再认一次旧名字,
// 是为了兜住改名之后又被建出来的旧容器 (老客户端 / 老缓存), 避免同一个兜底容器建出两份.
const LEGACY_PROJECT_NAMES = ['let-us-chat']
const LEGACY_ISSUE_TITLES: Record<string, string[]> = {
  [EASY_DEFAULT_ISSUE_TITLE]: ['a random chat'],
}

export function isEasyDefaultProjectName(name: unknown): boolean {
  const normalized = String(name ?? '').trim().toLowerCase()
  if (!normalized) return false
  return normalized === EASY_DEFAULT_PROJECT_NAME.toLowerCase() || LEGACY_PROJECT_NAMES.includes(normalized)
}

/** 复用任务时的候选标题: 当前标题 + 它的历史别名 */
export function easyIssueTitleAliases(title: string): string[] {
  return [title, ...(LEGACY_ISSUE_TITLES[title] || [])]
}
