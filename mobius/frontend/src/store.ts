import { create } from 'zustand'
import { type ThemeName, nextThemeName, normalizeTheme } from './theme'

const BACKGROUND_FLOW_STORAGE_KEY = 'cc-background-flow'
const ASSISTANT_BUBBLE_STORAGE_KEY = 'mobius:ui:assistant-bubble'

function loadBackgroundFlowEnabled() {
  // 默认关闭; localStorage 中未存储过 (新用户) 时不开启背景光流.
  const stored = localStorage.getItem(BACKGROUND_FLOW_STORAGE_KEY)
  return stored == null ? false : stored === '1'
}

function loadAssistantBubbleEnabled() {
  const stored = localStorage.getItem(ASSISTANT_BUBBLE_STORAGE_KEY)
  return stored == null ? true : stored !== '0'
}

// 工作区布局模式:
//   'session'           - 现有会话监督布局 (左 Issue/sessions 侧栏 + 右 ChatArea)
//   'editor-chat'       - 代码对话 v1: 左 code-server iframe 编辑器 + 右 Session 对话
//   'code-conversation' - 代码对话 v2: 左原生文件浏览器 + 中代码浏览 + 右 Session 对话
// 布局按「会话」独立保存: 每个 session 记住自己的布局模式, 切换会话时恢复对应模式,
// 从未设置过的会话回落默认 'session'. 持久化到 localStorage 的一张 {sessionId: mode} 映射表.
// 非法值一律回落 'session'.
const WORKSPACE_LAYOUT_BY_SESSION_KEY = 'mobius:ui:workspace-layout-by-session'
const WORKSPACE_LAYOUT_DEFAULT: WorkspaceLayoutMode = 'session'
export type WorkspaceLayoutMode = 'session' | 'editor-chat' | 'code-conversation'
const WORKSPACE_LAYOUT_MODES: WorkspaceLayoutMode[] = ['session', 'editor-chat', 'code-conversation']
function normalizeLayoutMode(v: unknown): WorkspaceLayoutMode {
  return (WORKSPACE_LAYOUT_MODES as string[]).includes((v as string) || '') ? (v as WorkspaceLayoutMode) : WORKSPACE_LAYOUT_DEFAULT
}
function loadLayoutMap(): Record<string, WorkspaceLayoutMode> {
  try {
    const raw = localStorage.getItem(WORKSPACE_LAYOUT_BY_SESSION_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? (obj as Record<string, WorkspaceLayoutMode>) : {}
  } catch {
    return {}
  }
}
// 读取某会话已保存的布局; 无会话或未保存过 -> 默认 'session'.
function loadSessionLayoutMode(sessionId: string | null | undefined): WorkspaceLayoutMode {
  if (!sessionId) return WORKSPACE_LAYOUT_DEFAULT
  return normalizeLayoutMode(loadLayoutMap()[sessionId])
}
// 把某会话的布局写回映射表 (default 视为清除, 保持表精简).
function saveSessionLayoutMode(sessionId: string | null | undefined, mode: WorkspaceLayoutMode) {
  if (!sessionId) return
  try {
    const map = loadLayoutMap()
    if (mode === WORKSPACE_LAYOUT_DEFAULT) delete map[sessionId]
    else map[sessionId] = mode
    localStorage.setItem(WORKSPACE_LAYOUT_BY_SESSION_KEY, JSON.stringify(map))
  } catch { /* localStorage 不可用时静默 */ }
}

// Branding: 由 index.html 头部同步阻塞 script 注入到 window.__BRANDING__,
// React 启动前已经定型, 不需要异步 fetch, 避免首屏闪烁.
interface Branding {
  hideLogo: boolean
  systemNameZh: string
  systemNameEn: string
  hiddenFolderName: string
  appDir: string
}

declare global {
  interface Window {
    __BRANDING__?: Branding
    // 全局打开管理中心 overlay (shell.tsx 注册). 引导系统「重温管理中心」按钮先打开 overlay 再启动引导.
    openAdminOverlay?: () => void
  }
}

const DEFAULT_BRANDING: Branding = {
  hideLogo: false,
  systemNameZh: '莫比乌斯AI',
  systemNameEn: 'Mobius',
  hiddenFolderName: '.mobius',
  appDir: '',
}

function loadInitialBranding(): Branding {
  const injected = typeof window !== 'undefined' ? window.__BRANDING__ : undefined
  if (!injected) return DEFAULT_BRANDING
  return {
    hideLogo: !!injected.hideLogo,
    systemNameZh: typeof injected.systemNameZh === 'string' ? injected.systemNameZh : DEFAULT_BRANDING.systemNameZh,
    systemNameEn: typeof injected.systemNameEn === 'string' ? injected.systemNameEn : DEFAULT_BRANDING.systemNameEn,
    hiddenFolderName: typeof injected.hiddenFolderName === 'string' && injected.hiddenFolderName ? injected.hiddenFolderName : DEFAULT_BRANDING.hiddenFolderName,
    appDir: typeof injected.appDir === 'string' ? injected.appDir : DEFAULT_BRANDING.appDir,
  }
}

// 隐藏工作缓存目录名 (.imac / .mobius): 由 index.html 同步注入 window.__BRANDING__, 启动时定型,
// 运行期不再变化, 故作为模块级常量导出; 组件拼 <bindPath>/<HIDDEN_FOLDER_NAME>/... 路径时直接 import 使用.
export const HIDDEN_FOLDER_NAME = loadInitialBranding().hiddenFolderName

// 仓库根绝对路径 (APP_DIR): 同样由 index.html 同步注入, 启动时定型. 用于给 agent 展示 skill 绝对路径等,
// 避免前端硬编码部署路径. 空字符串表示后端未下发 (旧版), 调用方需自行回退.
export const APP_DIR = loadInitialBranding().appDir

interface User {
  id: string
  display_name: string
  role: string
  work_dir?: string
}

interface GitRepo {
  url: string
  name?: string
}

type ResourceVisibility = 'inherit' | 'private' | 'team' | 'public' | 'allowlist'

interface ResourceAccess {
  visibility: ResourceVisibility
  allow_user_ids?: string[]
  allow_group_ids?: string[]
}

interface Project {
  id: string
  name: string
  description: string
  created_by: string
  created_at: string
  last_active: string
  issue_count?: number
  starred?: boolean
  bind_path?: string
  bind_path_manual?: boolean
  git_repos?: GitRepo[]
  default_use_worktree?: boolean
  research_enabled?: boolean
  visibility?: Exclude<ResourceVisibility, 'inherit'>
  access?: ResourceAccess
  can_manage?: boolean
  can_create_issue?: boolean
  can_create_research?: boolean
  can_create_session?: boolean
  can_post_issue?: boolean
  can_run_session?: boolean
  research_count?: number
  // 用户隔离 v3: 当前用户是否已屏蔽该项目 (屏蔽名单永远隐藏, 搜索时带"已屏蔽"角标).
  muted?: boolean
  muted_label?: string | null
  // 被遗忘 running.flag 提醒消息: 项目配置的原始值 (未配置则 null/缺省)
  forgotten_flag_message?: string | null
  // 实际生效值 (配置了用配置, 否则系统默认) — 后端 hydrate 注入, 前端预填用
  forgotten_flag_message_effective?: string
  forgotten_flag_issue_interval_minutes?: number
  forgotten_flag_research_interval_minutes?: number
  forgotten_flag_issue_init_minutes?: number
  forgotten_flag_issue_backoff?: number
  forgotten_flag_issue_patience?: number
  forgotten_flag_research_init_minutes?: number
  forgotten_flag_research_backoff?: number
  forgotten_flag_research_patience?: number
  // 拓展系统: 'normal' (默认) | 'extension' (由 mobius/extension/<name>/ 同步出来的特殊项目)
  kind?: 'normal' | 'extension'
  extension_name?: string | null
  disabled?: boolean
  // 拓展项目: 当前用户是否把它隐藏了 (仅 kind='extension' 真正用到, 普通项目恒 false).
  hidden?: boolean
  // Mobius 自我迭代项目: 后端判定 bind_path 是否等于 APP_DIR.
  is_self_develop?: boolean
  // 项目级默认模型偏好: 新建 Session 时模型下拉的初始值. null/缺省 = 未指定 (跟系统全局默认).
  // 存的是 model-registry 暴露的短键 (opus / codex / 管理员导入模型的 key).
  default_model?: string | null
  // 项目主页卡片边框主题: auto/neutral/dark-gold/...
  card_border_theme?: string | null
}

interface Issue {
  id: string
  project_id: string
  title: string
  description: string
  status: string
  created_by: string
  pinned?: number
  created_at: string
  last_active: string
  message_count?: number
  session_count?: number
  visibility?: ResourceVisibility
  access?: ResourceAccess
  can_manage?: boolean
}

interface Research {
  id: string
  project_id: string
  title: string
  description: string
  status: string
  created_by: string
  pinned?: number
  created_at: string
  last_active: string
  message_count?: number
  session_count?: number
  chief_count?: number
  visibility?: ResourceVisibility
  access?: ResourceAccess
  can_manage?: boolean
}

interface Session {
  session_id: string
  issue_id?: string | null
  project_id?: string | null
  scope_type?: 'issue' | 'research'
  research_id?: string | null
  research_role?: 'chief_researcher' | 'research_assistant' | null
  user_id: string
  name: string
  description: string
  session_key: string
  status: string
  agent_status: string
  model?: string
  model_label?: string
  use_proxy?: boolean | number
  language?: 'zh' | 'en'
  risk_level: string
  message_count: number
  turn_count: number
  // 原始数据条目计数 (messages_v2 行数). 取代恒为 0 的 turn_count 在 IssuePage 展示.
  raw_entry_count?: number
  created_at: string
  last_active: string
  // PC client 创建标记 (仅桌面端建 session 时附带); 后端返回为 JSON 字符串, null = web 端建。
  pc_client_metadata?: { work_mode?: string; aimux_id?: string; local_path?: string } | string | null
  // joined fields
  issue_title?: string
  project_name?: string
  user_display_name?: string
}

// 兼容旧 Task 字段（由 session_id 替代 task_id）
interface Task {
  task_id: string
  session_id: string
  user_id: string
  name: string
  description: string
  session_key: string
  status: string
  agent_status?: string
  model?: string
  model_label?: string
  use_proxy?: boolean | number
  risk_level?: string
  message_count: number
  turn_count?: number
  created_at: string
  last_active: string
  issue_title?: string
  project_name?: string
}

interface Message {
  id?: number
  role: 'user' | 'assistant' | 'tool' | 'system' | 'thinking'
  content: string
  tool_name?: string
  tool_summary?: string
  turn_number?: number
  turn_summary?: string
  created_at?: string
}

interface Turn {
  turn_number: number
  turn_summary: string
  user_input: string
  agent_output: string
  created_at: string
}

interface AppState {
  token: string | null
  user: User | null
  // 会话引导态: localStorage 有 token 但 user 尚未拉取/校验完成时为 true.
  // 期间 App 显示加载态而非登录页, 消除弱网/慢请求下"闪现登录页"的问题.
  authChecking: boolean
  // Project / Issue / Session 三层结构
  projects: Project[]
  currentProject: Project | null
  issues: Issue[]
  issuesMap: Record<string, Issue[]>  // 按projectId索引的issues
  currentIssue: Issue | null
  researches: Research[]
  researchesMap: Record<string, Research[]>  // 按projectId索引的researches
  currentResearch: Research | null
  sessions: Session[]
  sessionsMap: Record<string, Session[]>  // 按issueId索引的sessions
  currentSession: Session | null
  turns: Turn[]
  // 兼容旧 tasks（API 返回字段兼容）
  tasks: Task[]
  currentTask: Task | null
  // Chat 状态
  messages: Message[]
  isTyping: boolean
  streamContent: string
  agentStatus: 'idle' | 'running' | 'stale'
  theme: ThemeName
  backgroundFlowEnabled: boolean
  assistantBubbleEnabled: boolean
  // 用户隔离 v3: 全局视图偏好 (hide_others_projects)
  hideOthersProjects: boolean
  // 用户隔离 v3: 当前用户已 mute 的项目 ID 集合
  mutedProjectIds: string[]
  // Branding: logo/系统名/Tab 标题. 来自 .env, 前端只读不可改.
  branding: Branding
  // 移动端侧栏抽屉开关 (TopNav 汉堡按钮触发, ResizablePanel 抽屉态读取)
  mobileNavOpen: boolean
  // 移动端断点(px): 由当前页面设置 (内容密集页可调大, 如 ProjectPage=1024);
  // TopNav 汉堡按钮的显隐与 ResizablePanel 抽屉态都读它, 保证两者始终同步.
  mobileNavBreakpoint: number
  // 工作区布局模式 (session | editor-chat | code-conversation). 按会话独立保存.
  workspaceLayoutMode: WorkspaceLayoutMode
  // Actions
  setAuth: (token: string, user: User) => void
  logout: () => void
  setProjects: (projects: Project[]) => void
  setCurrentProject: (project: Project | null) => void
  setHideOthersProjects: (hide: boolean) => void
  setMutedProjectIds: (ids: string[]) => void
  setMobileNavOpen: (open: boolean) => void
  setMobileNavBreakpoint: (px: number) => void
  setWorkspaceLayoutMode: (mode: WorkspaceLayoutMode) => void
  toggleWorkspaceLayoutMode: () => void
  // 切换到某会话时调用: 恢复该会话保存的布局, 未保存过则回落默认 (不写回).
  applySessionWorkspaceLayout: (sessionId: string | null | undefined) => void
  setIssues: (issues: Issue[]) => void
  setIssuesMap: (projectId: string, issues: Issue[]) => void
  setCurrentIssue: (issue: Issue | null) => void
  setResearches: (researches: Research[]) => void
  setResearchesMap: (projectId: string, researches: Research[]) => void
  setCurrentResearch: (research: Research | null) => void
  setSessions: (sessions: Session[]) => void
  setSessionsMap: (issueId: string, sessions: Session[]) => void
  setSessionsMapBatch: (entries: Record<string, Session[]>) => void
  setCurrentSession: (session: Session | null) => void
  setTurns: (turns: Turn[]) => void
  setTasks: (tasks: Task[]) => void
  setCurrentTask: (task: Task | null) => void
  setMessages: (messages: Message[]) => void
  addMessage: (message: Message) => void
  setTyping: (v: boolean) => void
  setStreamContent: (v: string) => void
  setAgentStatus: (v: 'idle' | 'running' | 'stale') => void
  setTheme: (theme: ThemeName) => void
  toggleTheme: () => void
  setBackgroundFlowEnabled: (enabled: boolean) => void
  toggleBackgroundFlow: () => void
  setAssistantBubbleEnabled: (enabled: boolean) => void
  toggleAssistantBubble: () => void
}

export const useStore = create<AppState>((set) => ({
  token: localStorage.getItem('cc-token'),
  user: null,
  // 启动时若 localStorage 已有 token, 先进入"会话校验中", 等 /api/auth/me 返回再翻 false.
  authChecking: !!localStorage.getItem('cc-token'),
  // Project / Issue / Session
  projects: [],
  currentProject: null,
  issues: [],
  issuesMap: {},
  currentIssue: null,
  researches: [],
  researchesMap: {},
  currentResearch: null,
  sessions: [],
  sessionsMap: {},
  currentSession: null,
  turns: [],
  // 兼容
  tasks: [],
  currentTask: null,
  // Chat
  messages: [],
  isTyping: false,
  streamContent: '',
  agentStatus: 'idle' as const,
  theme: normalizeTheme(localStorage.getItem('cc-theme')),
  backgroundFlowEnabled: loadBackgroundFlowEnabled(),
  assistantBubbleEnabled: loadAssistantBubbleEnabled(),
  hideOthersProjects: false,
  mutedProjectIds: [],
  branding: loadInitialBranding(),
  mobileNavOpen: false,
  mobileNavBreakpoint: 900,
  // 启动默认值; 进入会话后由 applySessionWorkspaceLayout 按会话校正.
  workspaceLayoutMode: WORKSPACE_LAYOUT_DEFAULT,
  setAuth: (token, user) => {
    localStorage.setItem('cc-token', token)
    set({ token, user, authChecking: false })
  },
  logout: () => {
    localStorage.removeItem('cc-token')
    set({ token: null, user: null, authChecking: false, projects: [], currentProject: null, issues: [], issuesMap: {}, currentIssue: null, researches: [], researchesMap: {}, currentResearch: null, sessions: [], sessionsMap: {}, currentSession: null, turns: [], tasks: [], currentTask: null, messages: [] })
  },
  setProjects: (projects) => set({ projects }),
  setCurrentProject: (project) => set({ currentProject: project }),
  setHideOthersProjects: (hide) => set({ hideOthersProjects: !!hide }),
  setMutedProjectIds: (ids) => set({ mutedProjectIds: Array.isArray(ids) ? ids : [] }),
  setMobileNavOpen: (open) => set({ mobileNavOpen: !!open }),
  setMobileNavBreakpoint: (px) => set({ mobileNavBreakpoint: Number.isFinite(px) && px > 0 ? Math.round(px) : 900 }),
  setWorkspaceLayoutMode: (mode) => {
    const next = normalizeLayoutMode(mode)
    // 写回当前会话的布局记忆 (无当前会话则不持久化, 仅改内存态).
    saveSessionLayoutMode(useStore.getState().currentSession?.session_id, next)
    set({ workspaceLayoutMode: next })
  },
  toggleWorkspaceLayoutMode: () => set((s) => {
    // 兼容旧调用: 仅在 session <-> editor-chat 间切换 (不引入 v2, v2 走弹窗显式选择).
    const next: WorkspaceLayoutMode = s.workspaceLayoutMode === 'editor-chat' ? 'session' : 'editor-chat'
    saveSessionLayoutMode(useStore.getState().currentSession?.session_id, next)
    return { workspaceLayoutMode: next }
  }),
  applySessionWorkspaceLayout: (sessionId) => {
    const next = loadSessionLayoutMode(sessionId)
    set((s) => (s.workspaceLayoutMode === next ? s : { workspaceLayoutMode: next }))
  },
  setIssues: (issues) => set({ issues }),
  setIssuesMap: (projectId, issues) => set((s) => ({ issuesMap: { ...s.issuesMap, [projectId]: issues } })),
  setCurrentIssue: (issue) => set({ currentIssue: issue }),
  setResearches: (researches) => set({ researches }),
  setResearchesMap: (projectId, researches) => set((s) => ({ researchesMap: { ...s.researchesMap, [projectId]: researches } })),
  setCurrentResearch: (research) => set({ currentResearch: research }),
  setSessions: (sessions) => set({ sessions }),
  setSessionsMap: (issueId, sessions) => set((s) => ({ sessionsMap: { ...s.sessionsMap, [issueId]: sessions } })),
  setSessionsMapBatch: (entries) => set((s) => ({ sessionsMap: { ...s.sessionsMap, ...entries } })),
  setCurrentSession: (session) => set({ currentSession: session }),
  setTurns: (turns) => set({ turns }),
  setTasks: (tasks) => set({ tasks }),
  setCurrentTask: (task) => set({ currentTask: task }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  setTyping: (v) => set({ isTyping: v }),
  setStreamContent: (v) => set({ streamContent: v }),
  setAgentStatus: (v) => set({ agentStatus: v }),
  setTheme: (theme) => {
    localStorage.setItem('cc-theme', theme)
    set({ theme })
  },
  toggleTheme: () => set((s) => {
    const newTheme = nextThemeName(s.theme)
    localStorage.setItem('cc-theme', newTheme)
    return { theme: newTheme }
  }),
  setBackgroundFlowEnabled: (enabled) => {
    localStorage.setItem(BACKGROUND_FLOW_STORAGE_KEY, enabled ? '1' : '0')
    set({ backgroundFlowEnabled: enabled })
  },
  toggleBackgroundFlow: () => set((s) => {
    const next = !s.backgroundFlowEnabled
    localStorage.setItem(BACKGROUND_FLOW_STORAGE_KEY, next ? '1' : '0')
    return { backgroundFlowEnabled: next }
  }),
  setAssistantBubbleEnabled: (enabled) => {
    localStorage.setItem(ASSISTANT_BUBBLE_STORAGE_KEY, enabled ? '1' : '0')
    set({ assistantBubbleEnabled: enabled })
  },
  toggleAssistantBubble: () => set((s) => {
    const next = !s.assistantBubbleEnabled
    localStorage.setItem(ASSISTANT_BUBBLE_STORAGE_KEY, next ? '1' : '0')
    return { assistantBubbleEnabled: next }
  }),
}))

// API helper
const API = ''
export async function api(path: string, options?: RequestInit) {
  const token = localStorage.getItem('cc-token')
  const isFormData = options?.body instanceof FormData
  const headers = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options?.headers,
  }
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers,
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && path !== '/api/auth/login') {
    localStorage.removeItem('cc-token')
    window.location.href = '/'
    throw new Error(data?.error || 'Unauthorized')
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}
