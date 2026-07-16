// =====================================================================
// Electron 启动欢迎向导 (/welcome) -- 多步向导
//
// 桌面端 bootDesktop() 登录后统一 loadURL(${server}/welcome) 进此页 (electron 特殊机制)。
// 浏览器端也可访问 /welcome, 桌面端独有字段 (本地路径 / 本机信息 / continue-from-last) 优雅降级隐藏。
//
// 页面 1 (menu): 欢迎语 + 5 个去向 + 本机信息 & mobius 连接信息小字。
//   - 从上次结束处继续: 跳上次退出页 (首次运行隐藏)
//   - 接入已有项目 / 创建全新项目 -> 页面 2 (项目创建菜单) -> 页面 3 (创建第一个任务)
//   - 导入零散文件随便聊聊 -> 检查 let-us-chat 项目: 无则页面 2, 有则直进页面 3 (导入文件随便聊聊)
//   - 进入已创建项目 -> 项目列表 (星标 + 最近 session 排序), 选定进项目页
//
// 页面 2 (project): 项目创建菜单。【下一步】= 同名项目检查 (有则跳项目页结束) -> 建项目 -> 绑本地路径 ->
//   自动建 issue ([demo issue] / [a random chat]) -> 页面 3。
//   接入模式: 本地路径可见必填; 创建/导入模式: 本地路径折叠在高级选项。
//
// 页面 3 (session): 创建第一个任务 / 导入文件随便聊聊。session 目的复用新建 session 的附件上传/粘贴能力。
//   【提交】= 建 session -> 10s 固定进度条 -> 跳转 session 页。
//
// 本地路径 = 用户本机工作目录 (桌面端 project-paths.json, 不上传), 默认 ~/Desktop/MobiusOS/<项目名>
//   (对齐 mobius/desktop main.ts project:bind-status 的 defaultPath)。
// 绑定路径 = mobius 中枢 agent 工作目录 (服务器侧 user.work_dir/<随机 slug>)。
// =====================================================================
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  History, FolderInput, Plus, FileText, FolderOpen, ChevronLeft, ChevronDown,
  ChevronRight, FolderOpen as FolderBrowse, Dices, Loader2, Sparkles, Star, Search,
  RefreshCw, LogOut, Trash2,
} from 'lucide-react'
import { useStore, api } from '../store'
import { MobiusLogo } from '../components/mobius-logo'
import { ErrBanner, PathPickerModal, PcTaskModeSection } from '../components/modals'
import { ToggleSwitch } from '../components/toggle-switch'
import { ExpandableTextarea } from '../components/expandable-textarea'
import { SessionModelPicker } from '../components/session-model-picker'
import {
  DescriptionWithAttachments, SkillMemoryPicker, LanguageSelect, useAsyncList,
  type PickItem, type SessionLanguage,
} from '../components/global-create'
import { type Attachment, appendAttachmentsToDesc } from '../components/attachments'
import { fetchGlobalDefaultModel, resolveDefaultModelKey } from '../services/global-default-model'

// --- 桌面端 bridge (preload 注入 window.mobiusDesktop) ---
interface BootData {
  platform?: string
  hostname?: string
  ips?: string[]
  cpuModel?: string
  cpuCount?: number
  totalMemGB?: number
  aimuxIdentifier?: string
  serverOrigin?: string
  appVersion?: string
  desktopPath?: string
}
interface DesktopBridge {
  isDesktop?: boolean
  getBootData?: () => Promise<BootData>
  getLastRoute?: () => Promise<string | null>
  pickDirectory?: () => Promise<string | null>
  confirmProjectPath?: (projectId: string, path: string) => Promise<{ ok?: boolean; error?: string } | null>
  logout?: () => Promise<{ ok?: boolean }>
  clearCache?: () => Promise<{ ok?: boolean }>
}
function getDesktopBridge(): DesktopBridge | undefined {
  return typeof window !== 'undefined'
    ? (window as { mobiusDesktop?: DesktopBridge }).mobiusDesktop
    : undefined
}

// --- 可见性选项 (对齐 global-create.tsx) ---
type Visibility = 'private' | 'team' | 'public' | 'allowlist'
const VISIBILITY_OPTIONS: { value: Visibility; label: string; desc: string }[] = [
  { value: 'private', label: '仅自己', desc: '仅创建者可见' },
  { value: 'team', label: '同组', desc: '同一用户组可见' },
  { value: 'public', label: '公开', desc: '所有登录用户可见' },
  { value: 'allowlist', label: '指定用户', desc: '仅指定用户/组可见' },
]

// --- 随机绑定路径 (中枢 agent 工作目录, 对齐 global-create.tsx) ---
const RANDOM_ADJECTIVES = ['bright', 'calm', 'clever', 'cozy', 'fresh', 'gentle', 'lively', 'lovely', 'lucky', 'merry', 'neat', 'quiet', 'rapid', 'smart', 'sunny', 'tidy', 'warm', 'wise']
const RANDOM_NOUNS = ['bird', 'brook', 'cloud', 'field', 'forest', 'garden', 'harbor', 'lake', 'leaf', 'meadow', 'moon', 'mountain', 'river', 'seed', 'snake', 'spark', 'star', 'stone', 'sun', 'tree', 'valley', 'wave', 'wind']
function randomSlug(): string {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)] || arr[0]
  return `${pick(RANDOM_ADJECTIVES)}_${pick(RANDOM_NOUNS)}`
}
function randomBindPath(workDir?: string | null): string {
  const root = (workDir || '').trim().replace(/\/+$/, '')
  if (!root) return ''
  return `${root}/${randomSlug()}`.replace(/\/{2,}/g, '/')
}

function sanitizeName(name: string): string {
  const s = name.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim()
  return s || 'project'
}
function defaultLocalPath(desktopPath: string | undefined, name: string): string {
  if (!desktopPath) return ''
  return `${desktopPath}/MobiusOS/${sanitizeName(name)}`
}

const LET_US_CHAT = 'let-us-chat'
const RANDOM_CHAT = 'a random chat'
const DEMO_ISSUE = 'demo issue'
const NO_DESC = 'no description'

// --- 流程配置: 三种模式共用页面 2/3, 仅标题/默认值/issue 标题不同 ---
type FlowMode = 'connect' | 'new' | 'import'
interface FlowConfig {
  mode: FlowMode
  page2Title: string
  page3Title: string
  purposeDefault: string
  issueTitle: string
  nameDefault: string
  localPathVisible: boolean
}
const FLOW: Record<FlowMode, FlowConfig> = {
  connect: {
    mode: 'connect', page2Title: '接入一个已有项目', page3Title: '创建第一个任务',
    purposeDefault: '等待您的指令，请输入您的第一个任务，例如：扫描项目代码中的潜在 Bug。',
    issueTitle: DEMO_ISSUE, nameDefault: '', localPathVisible: true,
  },
  new: {
    mode: 'new', page2Title: '创建一个全新项目', page3Title: '创建第一个任务',
    purposeDefault: '等待您的指令，请输入您的第一个任务，例如：扫描项目代码中的潜在 Bug。',
    issueTitle: DEMO_ISSUE, nameDefault: '', localPathVisible: false,
  },
  import: {
    mode: 'import', page2Title: '创建 let-us-chat 项目', page3Title: '导入一些文件，然后随便聊聊',
    purposeDefault: '等待您的指令和附件',
    issueTitle: RANDOM_CHAT, nameDefault: LET_US_CHAT, localPathVisible: false,
  },
}

// 页面 3 上下文: 从页面 2 / 菜单 (import 直进) 传入
interface SessionCtx {
  projectId: string
  issueId: string
  projectDefaultModel?: string | null
}

type Step = 'menu' | 'project' | 'session' | 'projectList'

export default function Welcome() {
  const { user, theme } = useStore()
  const navigate = useNavigate()
  const dark = theme !== 'light'

  const md = getDesktopBridge()
  const isDesktop = !!md?.isDesktop

  const [step, setStep] = useState<Step>('menu')
  const [boot, setBoot] = useState<BootData | null>(null)
  const [lastRoute, setLastRoute] = useState<string | null>(null)
  const [flow, setFlow] = useState<FlowConfig | null>(null)
  const [sessionCtx, setSessionCtx] = useState<SessionCtx | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkErr, setCheckErr] = useState('')

  useEffect(() => {
    md?.getBootData?.().then(b => setBoot(b || null)).catch(() => {})
    md?.getLastRoute?.().then(r => setLastRoute(r || null)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!user) return null

  // ---- 菜单选项 ----
  const startFlow = (mode: FlowMode) => { setFlow(FLOW[mode]); setStep('project'); setCheckErr('') }

  // import: 菜单点击时检查 let-us-chat 是否已存在
  const startImport = async () => {
    setChecking(true); setCheckErr('')
    try {
      const r = await api('/api/projects') as any
      const list: any[] = Array.isArray(r) ? r : (r?.projects || [])
      const existing = list.find(p => p?.created_by === user.id && String(p?.name || '').toLowerCase() === LET_US_CHAT)
      if (existing) {
        // 直进页面 3: 先确保有 [a random chat] issue
        const issueId = await ensureIssue(existing.id, RANDOM_CHAT)
        if (!issueId) { setCheckErr('无法获取/创建会话任务'); setChecking(false); return }
        setSessionCtx({ projectId: existing.id, issueId, projectDefaultModel: existing.default_model })
        setFlow(FLOW.import)
        setStep('session')
      } else {
        setFlow(FLOW.import)
        setStep('project')
      }
    } catch (e) {
      setCheckErr((e as Error)?.message || '检查失败')
    } finally {
      setChecking(false)
    }
  }

  if (step === 'project' && flow) {
    return (
      <WelcomeProject
        flow={flow} dark={dark} isDesktop={isDesktop} desktopPath={boot?.desktopPath}
        onBack={() => { setStep('menu'); setCheckErr('') }}
        onIntoSession={(ctx) => { setSessionCtx(ctx); setStep('session') }}
      />
    )
  }
  if (step === 'session' && flow && sessionCtx) {
    return (
      <WelcomeSession
        flow={flow} dark={dark} isDesktop={isDesktop} ctx={sessionCtx}
        onBack={() => setStep('menu')}
      />
    )
  }
  if (step === 'projectList') {
    return <WelcomeProjectList dark={dark} onBack={() => setStep('menu')} onPick={p => navigate(`/u/${p.created_by || user.id}/p/${p.id}`)} />
  }

  // ---- 页面 1: 欢迎菜单 ----
  const options: Array<{ key: string; icon: typeof History; title: string; desc: string; onClick: () => void; hidden?: boolean; disabled?: boolean; badge?: string; busy?: boolean }> = [
    { key: 'resume', icon: History, title: '从上次结束处继续', desc: '回到您上次退出时所在的页面', onClick: () => { if (lastRoute) navigate(lastRoute) }, hidden: !lastRoute },
    { key: 'connect', icon: FolderInput, title: '接入一个您计算机中的已有项目', desc: '指定本地路径, 把磁盘上已有的项目接入 Mobius', onClick: () => startFlow('connect') },
    { key: 'new', icon: Plus, title: '创建一个全新项目', desc: '从零开始一个新项目, 本地路径自动生成', onClick: () => startFlow('new') },
    { key: 'import', icon: FileText, title: '导入一些零散文件，随便聊聊', desc: '丢几个文件进来, 和小莫自由对话', onClick: () => void startImport(), busy: checking },
    { key: 'enter', icon: FolderOpen, title: '进入已创建的 Mobius 项目', desc: '浏览我已有的项目列表', onClick: () => setStep('projectList') },
  ]

  const machineLines: string[] = []
  if (boot) {
    const platformLabel = boot.platform === 'win32' ? 'Windows' : boot.platform === 'darwin' ? 'macOS' : boot.platform === 'linux' ? 'Linux' : (boot.platform || '')
    const parts = [platformLabel, boot.hostname].filter(Boolean)
    if (parts.length) machineLines.push(parts.join(' · '))
    if (boot.cpuModel) machineLines.push(`${boot.cpuCount || 0} 核 · ${boot.cpuModel}`)
    if (typeof boot.totalMemGB === 'number') machineLines.push(`${boot.totalMemGB} GB 内存`)
    if (boot.ips && boot.ips.length) machineLines.push(`IP: ${boot.ips.join(', ')}`)
    if (boot.appVersion) machineLines.push(`Mobius Desktop v${boot.appVersion}`)
  }
  const mobiusUrl = boot?.serverOrigin || (typeof window !== 'undefined' ? window.location.origin : '')
  const connectLine = mobiusUrl ? `${mobiusUrl} · ${user.display_name || user.id}` : (user.display_name || user.id)

  return (
    <div className="min-h-screen w-full flex items-center justify-center relative overflow-hidden select-none px-4 py-10"
      style={{ background: 'var(--bg-secondary)' }}>
      <div className="w-full max-w-[640px] relative z-10">
        <div className="text-center mb-8">
          <div className="inline-block mb-5"><MobiusLogo size={56} /></div>
          <h1 className="text-[26px] font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>欢迎使用 Mobius</h1>
          <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>链接一切的自进化 Agent 操作系统</p>
        </div>

        {checkErr && (
          <div className="mb-3 rounded-xl px-3 py-2 text-[12px]" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444' }}>{checkErr}</div>
        )}

        <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
          {options.filter(o => !o.hidden).map((o, i) => {
            const Icon = o.icon
            return (
              <button
                key={o.key} type="button" disabled={o.disabled || o.busy} onClick={o.onClick}
                className={`group flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors ${o.disabled ? 'cursor-not-allowed opacity-55' : 'hover:bg-[var(--bg-hover)]'} ${i > 0 ? 'border-t' : ''}`}
                style={i > 0 ? { borderColor: 'var(--border-color)' } : undefined}
              >
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                  {o.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" strokeWidth={1.9} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="block text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>{o.title}</span>
                    {o.badge && <span className="rounded-full px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>{o.badge}</span>}
                  </span>
                  <span className="mt-0.5 block text-[12px]" style={{ color: 'var(--text-muted)' }}>{o.desc}</span>
                </span>
                {!o.disabled && !o.busy && <ChevronRight className="h-4 w-4 flex-shrink-0 opacity-40 transition-transform group-hover:translate-x-0.5" style={{ color: 'var(--text-muted)' }} />}
              </button>
            )
          })}
        </div>

        {machineLines.length > 0 && (
          <div className="mt-5 px-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {machineLines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
        <div className="mt-1.5 px-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>{connectLine}</div>

        {/* 桌面端连接管理: 更换服务器 / 退出登录 / 清除缓存。
            更换服务器 & 退出登录 均回到本地登录页 (在那里可改 URL 或重新登录);
            清除缓存 = 清远程前端 HTTP/SW 缓存后刷新本页 (保留登录态)。web 端隐藏。 */}
        {isDesktop && (md?.logout || md?.clearCache) && (
          <div className="mt-3 flex items-center justify-center gap-3 text-[11px]">
            {md?.logout && (
              <button type="button"
                onClick={() => { try { void md.logout?.() } catch { /* 主进程会切到登录页, 本页随之销毁 */ } }}
                className="inline-flex items-center gap-1 transition-colors hover:text-[var(--text-primary)]"
                style={{ color: 'var(--text-muted)' }}
                title="返回本地登录页, 重新输入服务器地址">
                <RefreshCw className="h-3 w-3" />更换服务器
              </button>
            )}
            {md?.logout && md?.clearCache && <span style={{ color: 'var(--text-muted)' }}>·</span>}
            {md?.logout && (
              <button type="button"
                onClick={() => { try { void md.logout?.() } catch { /* ignore */ } }}
                className="inline-flex items-center gap-1 transition-colors hover:text-[var(--text-primary)]"
                style={{ color: 'var(--text-muted)' }}
                title="退出当前账号, 返回登录页">
                <LogOut className="h-3 w-3" />退出登录
              </button>
            )}
            {md?.logout && md?.clearCache && <span style={{ color: 'var(--text-muted)' }}>·</span>}
            {md?.clearCache && (
              <button type="button"
                onClick={() => { try { void md.clearCache?.() } catch { /* ignore */ } }}
                className="inline-flex items-center gap-1 transition-colors hover:text-[var(--text-primary)]"
                style={{ color: 'var(--text-muted)' }}
                title="清空本机缓存的页面资源并刷新">
                <Trash2 className="h-3 w-3" />清除缓存
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// =====================================================================
// 工具: 确保某项目下有指定标题的 issue (有则复用, 无则建), 返回 issueId
// =====================================================================
async function ensureIssue(projectId: string, title: string): Promise<string | null> {
  try {
    const r = await api(`/api/projects/${projectId}/issues?status=active`) as any
    const list: any[] = Array.isArray(r) ? r : (r?.issues || [])
    const found = list.find(i => String(i?.title || '') === title)
    if (found) return found.id
  } catch { /* ignore, try create */ }
  try {
    const iss = await api(`/api/projects/${projectId}/issues`, { method: 'POST', body: JSON.stringify({ title, description: NO_DESC, use_worktree: false, worktree_branch: '', visibility: 'private', is_planning: false }) })
    if (iss?.id) return iss.id
    return null
  } catch { return null }
}

// =====================================================================
// 页面 2: 项目创建菜单 (接入/创建/导入共用, 【下一步】)
// =====================================================================
function WelcomeProject({ flow, dark, isDesktop, desktopPath, onBack, onIntoSession }: {
  flow: FlowConfig
  dark: boolean
  isDesktop: boolean
  desktopPath?: string
  onBack: () => void
  onIntoSession: (ctx: SessionCtx) => void
}) {
  const { user } = useStore()

  const [name, setName] = useState(flow.nameDefault)
  const [localPath, setLocalPath] = useState('')
  const [localPathTouched, setLocalPathTouched] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [desc, setDesc] = useState('一个新项目')
  const [bindPath, setBindPath] = useState(() => randomBindPath(user?.work_dir))
  const [bindPathManual, setBindPathManual] = useState(false)
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [researchEnabled, setResearchEnabled] = useState(false)
  const [defaultUseWorktree, setDefaultUseWorktree] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  // 本地路径默认值随项目名联动 (未手动改过时)
  useEffect(() => {
    if (!isDesktop) return
    if (localPathTouched) return
    setLocalPath(defaultLocalPath(desktopPath, name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, desktopPath, isDesktop, localPathTouched])

  const refreshBindPath = () => {
    const next = randomBindPath(user?.work_dir)
    if (!next) { setErr('当前用户尚未配置工作目录，无法生成随机绑定路径'); return }
    setBindPath(next); setBindPathManual(false); setErr('')
  }
  const browseLocal = async () => {
    const md = getDesktopBridge()
    if (!md?.pickDirectory) return
    const picked = await md.pickDirectory()
    if (picked) { setLocalPath(picked); setLocalPathTouched(true); setErr('') }
  }

  const next = async () => {
    if (!name.trim()) { setErr('请输入项目名称'); return }
    if (isDesktop && flow.localPathVisible && !localPath.trim()) { setErr('请选择本地路径'); return }
    if (!bindPath.trim()) { setErr('绑定路径生成失败，请在高级选项中手动填写'); return }
    setLoading(true); setErr('')
    try {
      // (2) 同名项目检查 (connect/new): 有则跳项目页结束。import 不查 (菜单已查过)。
      if (flow.mode !== 'import') {
        const r = await api('/api/projects') as any
        const list: any[] = Array.isArray(r) ? r : (r?.projects || [])
        const same = list.find(p => p?.created_by === user?.id && String(p?.name || '').toLowerCase() === name.trim().toLowerCase())
        if (same) {
          window.location.assign(`/u/${same.created_by || user?.id}/p/${same.id}`)
          return
        }
      }
      // 建项目
      const body: Record<string, unknown> = {
        name: name.trim(), description: desc || '一个新项目', visibility,
        bindPath, bindPathManual,
        defaultUseWorktree: researchEnabled ? false : defaultUseWorktree,
        researchEnabled, can_post_issue: false, can_run_session: false,
      }
      const p = await api('/api/projects', { method: 'POST', body: JSON.stringify(body) })
      if (p?.error) { setErr(p.error); return }
      // 绑定本地路径 (桌面端, 不上传)
      if (isDesktop && localPath.trim() && p?.id) {
        const md = getDesktopBridge()
        try { await md?.confirmProjectPath?.(p.id, localPath.trim()) } catch { /* 不阻断 */ }
      }
      // (3) 自动建 issue
      const issueId = await ensureIssue(p.id, flow.issueTitle)
      if (!issueId) { setErr('项目已创建，但任务单创建失败'); setLoading(false); return }
      // (4) 进页面 3
      onIntoSession({ projectId: p.id, issueId, projectDefaultModel: p?.default_model })
    } catch (e) {
      setErr((e as Error)?.message || '创建失败')
    } finally {
      setLoading(false)
    }
  }

  const visibilityOption = VISIBILITY_OPTIONS.find(o => o.value === visibility) || VISIBILITY_OPTIONS[0]
  const inputStyle = { background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: dark ? '#f1f5f9' : '#1e293b' }
  const inputCls = 'w-full h-10 px-3 rounded-xl text-[13px] outline-none focus:border-blue-500/40 transition-colors'

  // 注意: 这里用 render function (renderLocalPathField()) 而非内部组件 (<LocalPathField/>).
  // 若写成组件内组件, 每次父组件按键重渲染都会让它是新组件类型 -> unmount/remount -> input 失焦.
  const renderLocalPathField = () => (
    <div>
      <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
        本地路径{flow.localPathVisible ? <> <span style={{ color: '#ef4444' }}>*</span></> : null}
        <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>· 本机工作目录, 不上传服务器</span>
      </label>
      <div className="flex gap-2">
        <input type="text" value={localPath}
          onChange={e => { setLocalPath(e.target.value); setLocalPathTouched(true); setErr('') }}
          placeholder="选择或输入本机绝对路径"
          className={`${inputCls} font-mono`} style={inputStyle} />
        <button type="button" onClick={browseLocal} title="浏览…"
          className="h-10 px-3 rounded-xl border flex items-center gap-1 text-[12px] shrink-0 hover:bg-[var(--bg-card-hover)]"
          style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
          <FolderBrowse className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen w-full flex items-center justify-center relative overflow-hidden select-none px-4 py-10"
      style={{ background: 'var(--bg-secondary)' }}>
      <div className="w-full max-w-[560px] relative z-10">
        <div className="flex items-center gap-2 mb-5">
          <button type="button" onClick={onBack}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-muted)' }} title="返回">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>{flow.page2Title}</h1>
        </div>

        <div className="rounded-2xl p-5" style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
          <div className="space-y-4">
            <div>
              <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>项目名称 <span style={{ color: '#ef4444' }}>*</span></label>
              <input type="text" value={name} autoFocus
                onChange={e => { setName(e.target.value); setErr('') }}
                placeholder="例如：强化学习最新进展调研" className={inputCls} style={inputStyle} />
            </div>

            {isDesktop && flow.localPathVisible && renderLocalPathField()}

            {/* 高级选项 (折叠) */}
            <div className="rounded-xl" style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
              <button type="button" onClick={() => setAdvancedOpen(v => !v)}
                className="flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px] font-medium"
                style={{ color: 'var(--text-secondary)' }}>
                <span className="flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />高级选项</span>
                <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? '' : '-rotate-90'}`} style={{ color: 'var(--text-muted)' }} />
              </button>
              {advancedOpen && (
                <div className="px-3 pb-3 pt-1 space-y-4 border-t" style={{ borderColor: 'var(--border-color)' }}>
                  {isDesktop && !flow.localPathVisible && renderLocalPathField()}
                  <div>
                    <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>项目描述</label>
                    <ExpandableTextarea value={desc} onValueChange={setDesc} placeholder="一句话描述这个项目" overlayTitle="编辑项目描述"
                      className="w-full h-20 px-3 py-2 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/40 resize-none" style={inputStyle} />
                  </div>
                  <div>
                    <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
                      绑定路径<span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>· Mobius 中枢 agent 工作目录</span>
                    </label>
                    <div className="flex gap-2">
                      <input type="text" value={bindPath}
                        onChange={e => { setBindPath(e.target.value); setBindPathManual(true); setErr('') }}
                        placeholder="点击右侧选择, 或手动输入" className={`${inputCls} font-mono`} style={inputStyle} />
                      <button type="button" onClick={() => setPickerOpen(true)} title="选择路径"
                        className="h-10 px-3 rounded-xl border flex items-center gap-1 text-[12px] shrink-0 hover:bg-[var(--bg-card-hover)]"
                        style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
                        <FolderBrowse className="w-3.5 h-3.5" />
                      </button>
                      <button type="button" onClick={refreshBindPath} title="换一个随机路径"
                        className="h-10 w-10 shrink-0 rounded-xl border flex items-center justify-center hover:bg-[var(--bg-card-hover)]"
                        style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
                        <Dices className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>可见性</label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {VISIBILITY_OPTIONS.map(opt => {
                        const active = visibility === opt.value
                        return (
                          <button key={opt.value} type="button" onClick={() => { setVisibility(opt.value); setErr('') }} title={opt.desc}
                            className="h-9 rounded-lg border text-[12px] transition-colors"
                            style={active ? { background: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.48)', color: '#60a5fa' } : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
                            {opt.label}
                          </button>
                        )
                      })}
                    </div>
                    <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>{visibilityOption.desc}</p>
                  </div>
                  <ToggleSwitch checked={researchEnabled}
                    onChange={enabled => { setResearchEnabled(enabled); if (enabled) setDefaultUseWorktree(false) }}
                    className="flex items-start gap-3 text-[13px]" style={{ color: dark ? '#cbd5e1' : '#334155' }}>
                    <span><span className="font-medium">启动 Research 系统</span><span className="block text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>开启后可在本项目中创建 Research Agent 团队</span></span>
                  </ToggleSwitch>
                  {!researchEnabled && (
                    <ToggleSwitch checked={defaultUseWorktree} onChange={setDefaultUseWorktree}
                      className="flex items-center gap-3 text-[13px]" style={{ color: dark ? '#cbd5e1' : '#334155' }}>
                      <span>默认使用 git worktree（新建 Issue 时开独立工作区）</span>
                    </ToggleSwitch>
                  )}
                </div>
              )}
            </div>

            {err && <ErrBanner>{err}</ErrBanner>}
          </div>

          <div className="flex justify-end gap-2 mt-5 pt-4 border-t" style={{ borderColor: 'var(--border-color)' }}>
            <button type="button" onClick={onBack}
              className="h-9 px-4 rounded-xl text-[13px] transition-colors hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-secondary)' }}>返回</button>
            <button type="button" onClick={next} disabled={loading}
              className="h-9 px-5 rounded-xl text-[13px] font-semibold text-white disabled:opacity-60 flex items-center gap-1.5 transition-colors" style={{ background: '#3b82f6' }}>
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {loading ? '处理中…' : '下一步'}
            </button>
          </div>
        </div>

        {pickerOpen && (
          <PathPickerModal initialPath={user?.work_dir} onClose={() => setPickerOpen(false)}
            onPick={(_abs, rel, manual) => { setBindPath(rel || _abs); setBindPathManual(!!manual); setPickerOpen(false) }} />
        )}
      </div>
    </div>
  )
}

// =====================================================================
// 页面 3: 创建第一个任务 / 导入文件随便聊聊 (session 创建 + 10s 进度)
// =====================================================================
function WelcomeSession({ flow, dark, isDesktop, ctx, onBack }: {
  flow: FlowConfig
  dark: boolean
  isDesktop: boolean
  ctx: SessionCtx
  onBack: () => void
}) {
  const { user } = useStore()
  const navigate = useNavigate()
  const { projectId, issueId, projectDefaultModel } = ctx

  const [name, setName] = useState(RANDOM_CHAT)
  const [desc, setDesc] = useState(flow.purposeDefault)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [model, setModel] = useState<string>('codex')
  const modelUserTouchedRef = useRef(false)
  const [language, setLanguage] = useState<SessionLanguage>('zh')
  const [excludedSkills, setExcludedSkills] = useState<Set<string>>(new Set())
  const [excludedMemories, setExcludedMemories] = useState<Set<string>>(new Set())
  const [availSkills, setAvailSkills] = useState<PickItem[]>([])
  const [availMemories, setAvailMemories] = useState<PickItem[]>([])
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [globalDefaultModel, setGlobalDefaultModel] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [err, setErr] = useState('')
  // PC 任务模式 (仅 electron 桌面端, 与 global-create/NewSessionModal 同源): work_mode/aimux_id/local_path.
  // 经 pc_client_metadata 注入 session 提示词; pc/dual 时 mobius-aimux skill 强制必选.
  // web 端 isDesktop=false → workMode 恒 null → 不渲染区块、不附 body、不锁 skill, 行为完全不变.
  const [workMode, setWorkMode] = useState<'hub' | 'pc' | 'dual' | null>(isDesktop ? 'dual' : null)
  const [aimuxId, setAimuxId] = useState<string | null>(null)
  const [pcPath, setPcPath] = useState<string>('')

  // 模型默认: 项目默认 > 全局默认 > codex (用户未手动改时回落)
  useEffect(() => {
    let alive = true
    fetchGlobalDefaultModel().then(v => { if (alive) setGlobalDefaultModel(v) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (modelUserTouchedRef.current) return
    setModel(resolveDefaultModelKey({ projectDefaultModel: projectDefaultModel || null, globalDefaultModel: globalDefaultModel || null, fallback: 'codex' }))
  }, [projectDefaultModel, globalDefaultModel])

  // Skill/Memory 全集 (选完 issue 后拉一次 context-preview: sources + defaults)
  useEffect(() => {
    if (!issueId) { setAvailSkills([]); setAvailMemories([]); return }
    let alive = true
    api(`/api/issues/${issueId}/context-preview`, {
      method: 'POST',
      body: JSON.stringify({ name: name || ' ', description: desc || ' ', excluded_skill_ids: [], excluded_memory_ids: [], include_defaults: true, include_body: false, include_item_bodies: false }),
    }).then((p: any) => {
      if (!alive) return
      const defaults = p?.defaults || null
      setAvailSkills((p?.sources?.skills || []).map((s: any) => ({ id: s.id, name: s.name, description: s.description, scope: s.scope || 'project', dirName: s.dirName })))
      setAvailMemories((p?.sources?.memories || []).map((m: any) => ({ id: m.id, name: m.name, description: m.description, scope: m.scope || 'project' })))
      const skillIds = new Set((p?.sources?.skills || []).map((s: any) => s.id))
      const memIds = new Set((p?.sources?.memories || []).map((m: any) => m.id))
      setExcludedSkills(new Set((defaults?.excluded_skill_ids || []).filter((id: string) => skillIds.has(id))))
      setExcludedMemories(new Set((defaults?.excluded_memory_ids || []).filter((id: string) => memIds.has(id))))
    }).catch(() => { if (alive) { setAvailSkills([]); setAvailMemories([]) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId])

  // 桌面端: 取 aimux_id (注入 pc_client_metadata) + 本项目绑定的本机工作路径.
  // PcTaskModeSection 挂在高级选项里, 用户不展开时它不挂载; 此处保证 local_path 已就绪, 双侧/本机模式仍能正确注入.
  useEffect(() => {
    const md = getDesktopBridge()
    if (!md?.isDesktop) return
    md.getBootData?.().then?.(b => { if (b?.aimuxIdentifier) setAimuxId(b.aimuxIdentifier) }).catch(() => {})
    const anyMd = md as any
    anyMd.getProjectLocalPath?.(projectId).then?.((p: string | null | undefined) => { if (p) setPcPath(p) }).catch(() => {})
  }, [projectId])

  // PC 任务模式 (仅桌面端 pc/dual): mobius-aimux skill 强制必选, SkillMemoryPicker 经 skillLockedOf 锁定不可取消.
  const isPcTaskMode = workMode === 'pc' || workMode === 'dual'
  const skillLockedOf = useCallback((id: string) => {
    if (!isPcTaskMode) return false
    const sk = availSkills.find(s => s.id === id)
    return (sk?.dirName || '').replace(/_/g, '-') === 'mobius-aimux'
  }, [isPcTaskMode, availSkills])

  const toggle = (set: Set<string>, id: string, setter: React.Dispatch<React.SetStateAction<Set<string>>>) => {
    const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); setter(n)
  }

  const submit = async () => {
    if (!name.trim()) { setErr('请填写 Session 名称'); return }
    setSubmitting(true); setErr(''); setProgress(0)
    const startTs = Date.now()
    // 进度条 5s 动画
    const time_max = 5000;
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - startTs
      setProgress(Math.min(100, (elapsed / time_max) * 100))
    }, 100)
    try {
      const finalDesc = appendAttachmentsToDesc(desc.trim() || name, attachments)
      // pc/dual 时 mobius-aimux 必选: 即便用户此前排除过, 提交时也从排除集清理 (与 global-create/NewSessionModal 同源).
      const excludedSkillIds = isPcTaskMode
        ? Array.from(excludedSkills).filter(id => {
          const sk = availSkills.find(s => s.id === id)
          return (sk?.dirName || '').replace(/_/g, '-') !== 'mobius-aimux'
        })
        : Array.from(excludedSkills)
      const s = await api(`/api/issues/${issueId}/sessions`, { method: 'POST', body: JSON.stringify({
        name, description: finalDesc, model, language,
        excluded_skill_ids: excludedSkillIds, excluded_memory_ids: Array.from(excludedMemories),
        // PC 任务模式 (仅桌面端): workMode 非空才附 pc_client_metadata; web 端恒 null → body 完全不变.
        ...(workMode ? { pc_client_metadata: { work_mode: workMode, aimux_id: aimuxId, local_path: pcPath || undefined } } : {}),
      }) })
      if (s?.error) { window.clearInterval(timer); setSubmitting(false); setErr(s.error); return }
      // 等进度条走完
      const remaining = time_max - (Date.now() - startTs)
      if (remaining > 0) await new Promise(r => window.setTimeout(r, remaining))
      window.clearInterval(timer); setProgress(100)
      const sid = s?.session_id
      navigate(`/u/${user?.id}/p/${projectId}/i/${issueId}${sid ? `?session=${sid}` : ''}`)
    } catch (e) {
      window.clearInterval(timer); setSubmitting(false); setErr((e as Error)?.message || '创建失败')
    }
  }

  const inputStyle = { background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: dark ? '#f1f5f9' : '#1e293b' }
  const inputCls = 'w-full h-10 px-3 rounded-xl text-[13px] outline-none focus:border-blue-500/40 transition-colors'

  // 提交进度态: 全屏进度条
  if (submitting) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center relative overflow-hidden select-none px-4"
        style={{ background: 'var(--bg-secondary)' }}>
        <div className="w-full max-w-[420px] text-center">
          <div className="inline-block mb-5"><MobiusLogo size={48} /></div>
          <h2 className="text-[18px] font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>正在创建会话…</h2>
          <p className="text-[12px] mb-6" style={{ color: 'var(--text-muted)' }}>小莫正在准备您的工作区</p>
          <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'var(--input-bg)' }}>
            <div className="h-full rounded-full transition-[width] duration-150 ease-linear" style={{ width: `${progress}%`, background: '#3b82f6' }} />
          </div>
          <p className="text-[11px] mt-2 tabular-nums" style={{ color: 'var(--text-muted)' }}>{Math.floor(progress)}%</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center relative overflow-hidden select-none px-4 py-10"
      style={{ background: 'var(--bg-secondary)' }}>
      <div className="w-full max-w-[600px] relative z-10">
        <div className="flex items-center gap-2 mb-5">
          <button type="button" onClick={onBack}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-muted)' }} title="返回">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>{flow.page3Title}</h1>
        </div>

        <div className="rounded-2xl p-5" style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
          <div className="space-y-4">
            {/* session 目的: 可见, 必填, 复用附件上传/粘贴能力 */}
            <DescriptionWithAttachments value={desc} onValueChange={v => { setDesc(v); setErr('') }}
              placeholder={flow.purposeDefault} attachments={attachments} setAttachments={setAttachments}
              projectId={projectId} dark={dark} />

            {/* 模型: 可见, 必选 */}
            <SessionModelPicker value={model} onChange={v => { setModel(v); modelUserTouchedRef.current = true }} dark={dark} />

            {/* 高级选项 (折叠): session 名称 / 语言 / Skill / Memory / PC 任务模式 */}
            <div className="rounded-xl" style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
              <button type="button" onClick={() => setAdvancedOpen(v => !v)}
                className="flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px] font-medium"
                style={{ color: 'var(--text-secondary)' }}>
                <span className="flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />高级选项</span>
                <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? '' : '-rotate-90'}`} style={{ color: 'var(--text-muted)' }} />
              </button>
              {advancedOpen && (
                <div className="px-3 pb-3 pt-1 space-y-4 border-t" style={{ borderColor: 'var(--border-color)' }}>
                  <div>
                    <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>Session 名称</label>
                    <input type="text" value={name} onChange={e => { setName(e.target.value); setErr('') }} className={inputCls} style={inputStyle} />
                  </div>
                  <div>
                    <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>语言</label>
                    <LanguageSelect value={language} onChange={setLanguage} />
                  </div>
                  <div>
                    <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>Skill / Memory</label>
                    <SkillMemoryPicker skills={availSkills} memories={availMemories}
                      excludedSkills={excludedSkills} excludedMemories={excludedMemories}
                      onToggleSkill={id => toggle(excludedSkills, id, setExcludedSkills)}
                      onToggleMemory={id => toggle(excludedMemories, id, setExcludedMemories)}
                      skillLockedOf={skillLockedOf}
                      disabled={!issueId} dark={dark} />
                  </div>
                  {isDesktop && (
                    <PcTaskModeSection projectId={projectId} isDark={dark} onModeChange={setWorkMode} onPathChange={setPcPath} />
                  )}
                </div>
              )}
            </div>

            {err && <ErrBanner>{err}</ErrBanner>}
          </div>

          <div className="flex justify-end gap-2 mt-5 pt-4 border-t" style={{ borderColor: 'var(--border-color)' }}>
            <button type="button" onClick={onBack}
              className="h-9 px-4 rounded-xl text-[13px] transition-colors hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-secondary)' }}>返回</button>
            <button type="button" onClick={submit}
              className="h-9 px-5 rounded-xl text-[13px] font-semibold text-white flex items-center gap-1.5 transition-colors" style={{ background: '#3b82f6' }}>
              提交
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// 页面: 进入已创建项目 (项目列表, 星标 + 最近 session 排序)
// =====================================================================
function WelcomeProjectList({ dark, onBack, onPick }: {
  dark: boolean
  onBack: () => void
  onPick: (p: any) => void
}) {
  const projects = useAsyncList<any>(() => api('/api/projects').then((r: any) => Array.isArray(r) ? r : (r?.projects || [])), [])
  const [q, setQ] = useState('')

  const sorted = [...projects.list].sort((a, b) => {
    const starDiff = Number(!!b.starred) - Number(!!a.starred)
    if (starDiff !== 0) return starDiff
    const actA = a.last_session_activity_at ? Date.parse(a.last_session_activity_at) : -Infinity
    const actB = b.last_session_activity_at ? Date.parse(b.last_session_activity_at) : -Infinity
    if (actA !== actB) return actB - actA
    const activeDiff = new Date(b.last_active || 0).getTime() - new Date(a.last_active || 0).getTime()
    if (activeDiff !== 0) return activeDiff
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
  })
  const filtered = sorted.filter(p => {
    const kw = q.trim().toLowerCase()
    if (!kw) return true
    return String(p?.name || '').toLowerCase().includes(kw) || String(p?.description || '').toLowerCase().includes(kw)
  })

  return (
    <div className="min-h-screen w-full flex items-center justify-center relative overflow-hidden select-none px-4 py-10"
      style={{ background: 'var(--bg-secondary)' }}>
      <div className="w-full max-w-[640px] relative z-10">
        <div className="flex items-center gap-2 mb-5">
          <button type="button" onClick={onBack}
            className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-muted)' }} title="返回">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>进入已创建的项目</h1>
        </div>

        <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
          <div className="px-3 py-2.5 border-b" style={{ borderColor: 'var(--border-color)' }}>
            <div className="flex items-center gap-1.5 rounded-lg px-2 h-8" style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
              <Search className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索项目名称或描述…" autoFocus
                className="flex-1 bg-transparent text-[12px] focus:outline-none" style={{ color: dark ? '#f1f5f9' : '#1e293b' }} />
            </div>
          </div>
          {projects.loading && <div className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中…</div>}
          {!projects.loading && filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>{q.trim() ? '没有匹配的项目' : '暂无项目'}</div>
          )}
          <div className="max-h-[52vh] overflow-y-auto">
            {filtered.map((p, i) => (
              <button key={p.id} type="button" onClick={() => onPick(p)}
                className={`group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)] ${i > 0 ? 'border-t' : ''}`}
                style={i > 0 ? { borderColor: 'var(--border-color)' } : undefined}>
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg" style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}>
                  <FolderOpen className="h-4 w-4" strokeWidth={1.9} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    {p.starred && <Star className="h-3 w-3 flex-shrink-0 fill-current" style={{ color: '#f59e0b' }} />}
                    <span className="block text-[14px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{p.name}</span>
                    {p.research_enabled && <span className="rounded-full px-1.5 py-0.5 text-[10px] flex-shrink-0" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>Research</span>}
                  </span>
                  <span className="mt-0.5 block text-[12px] truncate" style={{ color: 'var(--text-muted)' }}>{p.description || '无描述'}</span>
                </span>
                <ChevronRight className="h-4 w-4 flex-shrink-0 opacity-40 transition-transform group-hover:translate-x-0.5" style={{ color: 'var(--text-muted)' }} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
