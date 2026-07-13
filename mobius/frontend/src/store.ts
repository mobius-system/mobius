import { create } from 'zustand'
import { type ThemeName, nextThemeName, normalizeTheme } from './theme'

const BACKGROUND_FLOW_STORAGE_KEY = 'cc-background-flow'

function loadBackgroundFlowEnabled() {
  // 默认关闭; localStorage 中未存储过 (新用户) 时不开启背景光流.
  const stored = localStorage.getItem(BACKGROUND_FLOW_STORAGE_KEY)
  return stored == null ? false : stored === '1'
}

// 工作区布局模式: 'session' (现有会话监督布局) | 'editor-chat' (左 code-server 编辑器 + 右 Session 对话).
// 属于用户全局偏好, 持久化到 localStorage; 非法值一律回落 'session'.
const WORKSPACE_LAYOUT_STORAGE_KEY = 'mobius:ui:workspace-layout'
export type WorkspaceLayoutMode = 'session' | 'editor-chat'
function loadWorkspaceLayoutMode(): WorkspaceLayoutMode {
  try {
    return localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY) === 'editor-chat' ? 'editor-chat' : 'session'
  } catch {
    return 'session'
  }
}

// Branding: 由 index.html 头部同步阻塞 script 注入到 window.__BRANDING__,
// React 启动前已经定型, 不需要异步 fetch, 避免首屏闪烁.
interface Branding {
  hideLogo: boolean
  systemNameZh: string
  systemNameEn: string
  hiddenFolderName: string
}

declare global {
  interface Window {
    __BRANDING__?: Branding
  }
}

const DEFAULT_BRANDING: Branding = {
  hideLogo: false,
  systemNameZh: '莫比乌斯AI',
  systemNameEn: 'Mobius',
  hiddenFolderName: '.mobius',
}

function loadInitialBranding(): Branding {
  const injected = typeof window !== 'undefined' ? window.__BRANDING__ : undefined
  if (!injected) return DEFAULT_BRANDING
  return {
    hideLogo: !!injected.hideLogo,
    systemNameZh: typeof injected.systemNameZh === 'string' ? injected.systemNameZh : DEFAULT_BRANDING.systemNameZh,
    systemNameEn: typeof injected.systemNameEn === 'string' ? injected.systemNameEn : DEFAULT_BRANDING.systemNameEn,
    hiddenFolderName: typeof injected.hiddenFolderName === 'string' && injected.hiddenFolderName ? injected.hiddenFolderName : DEFAULT_BRANDING.hiddenFolderName,
  }
}

// 隐藏工作缓存目录名 (.imac / .mobius): 由 index.html 同步注入 window.__BRANDING__, 启动时定型,
// 运行期不再变化, 故作为模块级常量导出; 组件拼 <bindPath>/<HIDDEN_FOLDER_NAME>/... 路径时直接 import 使用.
export const HIDDEN_FOLDER_NAME = loadInitialBranding().hiddenFolderName

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
  // 工作区布局模式 (session | editor-chat). 用户全局偏好, 持久化.
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
  setIssues: (issues: Issue[]) => void
  setIssuesMap: (projectId: string, issues: Issue[]) => void
  setCurrentIssue: (issue: Issue | null) => void
  setResearches: (researches: Research[]) => void
  setResearchesMap: (projectId: string, researches: Research[]) => void
  setCurrentResearch: (research: Research | null) => void
  setSessions: (sessions: Session[]) => void
  setSessionsMap: (issueId: string, sessions: Session[]) => void
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
  hideOthersProjects: false,
  mutedProjectIds: [],
  branding: loadInitialBranding(),
  mobileNavOpen: false,
  mobileNavBreakpoint: 900,
  workspaceLayoutMode: loadWorkspaceLayoutMode(),
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
    const next: WorkspaceLayoutMode = mode === 'editor-chat' ? 'editor-chat' : 'session'
    try { localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, next) } catch { /* localStorage 不可用时静默 */ }
    set({ workspaceLayoutMode: next })
  },
  toggleWorkspaceLayoutMode: () => set((s) => {
    const next: WorkspaceLayoutMode = s.workspaceLayoutMode === 'editor-chat' ? 'session' : 'editor-chat'
    try { localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, next) } catch { /* localStorage 不可用时静默 */ }
    return { workspaceLayoutMode: next }
  }),
  setIssues: (issues) => set({ issues }),
  setIssuesMap: (projectId, issues) => set((s) => ({ issuesMap: { ...s.issuesMap, [projectId]: issues } })),
  setCurrentIssue: (issue) => set({ currentIssue: issue }),
  setResearches: (researches) => set({ researches }),
  setResearchesMap: (projectId, researches) => set((s) => ({ researchesMap: { ...s.researchesMap, [projectId]: researches } })),
  setCurrentResearch: (research) => set({ currentResearch: research }),
  setSessions: (sessions) => set({ sessions }),
  setSessionsMap: (issueId, sessions) => set((s) => ({ sessionsMap: { ...s.sessionsMap, [issueId]: sessions } })),
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
