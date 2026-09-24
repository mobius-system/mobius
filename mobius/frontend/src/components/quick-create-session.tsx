// =====================================================================
// 新建快捷会话 — 从 global-create.tsx 独立出来的会话创建菜单.
//
// 与传统 NewSessionModal (modals.tsx) 各取所长:
//   - 表单主体 = 快捷新建 (项目/任务下拉 + 描述 + 收纳的更多设置), 「创建」即自动启动.
//   - 底部三键: 取消 / 预览 / 创建; 「预览」直入传统菜单的第 2 步 (Skill/Memory 勾选 + 完整注入文本),
//     由 modals.tsx 的 NewSessionModal 以 initialStep=2 复用渲染, 「上一步」带回勾选返回本表单.
//   - 模型选择下方用小字展示传统菜单的提示 (管理员限额 / 活跃后台窗口 / tmux 状态).
//
// NewSessionModal 走 lazy 加载: 静态 import 会把整个 modals 模块 (连同 markdown 渲染栈)
// 拖进引用本文件的页面, 而「预览」是低频入口, 按需加载即可.
// The preview step lazily loads NewSessionModal so the heavy modals chunk stays out of the hot path.
// =====================================================================
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore, api } from '../store'
import { draftLoad, draftSave, draftClear } from '../services/input-drafts'
import { PROJECTS_SCOPE, issuesScope } from '../services/warm-create-lists'
import { fetchGlobalDefaultModel, resolveDefaultModelKey } from '../services/global-default-model'
import { ErrBanner } from './error-banner'
import { PcTaskModeSection } from './pc-task-mode-section'
import { formatDefaultSessionName } from '../services/session-naming'
import { lazyWithRetry } from '../services/handle-stale-chunk'
import { type Attachment, appendAttachmentsToDesc } from './attachments'
import { useSessionModelOptions, promptBackendKeyForOption, PROMPT_BACKEND_LABEL, type SessionModelOption } from './session-model-picker'
import {
  SessionMentionPicker,
  sessionMentionPayload,
  type SessionMentionSelection,
} from './session-mention-picker'
import { CheckCircle2, ChevronDown, History, Loader2 } from 'lucide-react'
import {
  CreateModalShell, Footer, SectionLabel, TextInput, SelectShell, LabelWithRefresh,
  DropdownSelect, DescriptionWithAttachments, SkillMemoryPicker, LanguageSelect,
  useAsyncList, CreateIssueForm, type PickItem, type SessionLanguage, type DropdownOption,
} from './global-create'

// 「预览」按钮直入的传统第 2 步菜单, 按需加载 (见文件头注释)
const NewSessionModal = lazyWithRetry(() => import('./modals').then(module => ({ default: module.NewSessionModal })))

// 全局默认模型 (项目无 default_model 且用户未手动改时回落). 与 modals.tsx 的 DEFAULT_SESSION_MODEL 同值 'codex'.
const GLOBAL_DEFAULT_MODEL = 'codex'

const SESSION_NAME_PLACEHOLDER = '请填写会话名称'

// 顶栏快捷新建会话 · 「恢复上次选择」快照: 记录上次成功提交的项目/任务/语言/Skill·Memory 排除集.
// 与工作草稿 gc:new-session 区分 —— 草稿提交即清, 此快照持久保留, 仅作"一键回填上次"用途.
// 刻意不存 model: 模型由目标任务"上次所选"三级默认自动还原 (与 CreateSessionForm 模型隔离哲学一致, 不跨作用域泄漏).
const LAST_SELECTION_KEY = 'gc:last-session'
type LastSessionSelection = {
  projectId: string
  issueId: string
  projectName?: string
  issueTitle?: string
  language: SessionLanguage
  excluded_skills: string[]
  excluded_memories: string[]
  ts: number
}
function loadLastSelection(): LastSessionSelection | null {
  return draftLoad<LastSessionSelection>(LAST_SELECTION_KEY)
}
function saveLastSelection(snap: LastSessionSelection) {
  draftSave(LAST_SELECTION_KEY, snap, { minChars: 0 })
}

// 会话模型下拉 (紧凑形态): 与 grid 版 SessionModelPicker 共用同一份数据源, 配额信息内联进选项,
// 超额模型禁用; 选择模型后下方用小字展示传统 NewSessionModal 的提示 —— 管理员限额 + 渠道活跃窗口/tmux 状态.
// Compact model dropdown; quota details live inside the options, with the legacy hints below in small text.
export function SessionModelDropdown({ value, onChange, dark, quotaEnabled = true }: {
  value: string
  onChange: (key: string) => void
  dark: boolean
  quotaEnabled?: boolean
}) {
  const { options, stats } = useSessionModelOptions()
  const usageOf = (key: string) => stats?.model_usage_limits?.models?.[key] || null
  const items: DropdownOption[] = options.map(opt => {
    const usage = usageOf(opt.key)
    const blocked = quotaEnabled && !!usage?.blocked
    const tmux = usage?.usage?.tmuxWindows
    // 渠道/定位 + 管理员配额 + tmux 软提醒压进副标题, 避免在下拉外再占两行
    // Backend, quota and tmux hint are folded into the option description
    const desc = [
      opt.sub,
      usage?.limit != null ? `个人5h ${usage.count}/${usage.limit}` : '',
      tmux?.warning ? `tmux ${tmux.count}/${tmux.limit}` : '',
    ].filter(Boolean).join(' · ')
    return {
      value: opt.key,
      label: String(opt.title || opt.label || opt.key),
      description: desc || undefined,
      disabled: blocked,
      badge: blocked ? { text: '已达限额', color: '#ef4444', bg: 'rgba(239,68,68,0.15)' } : undefined,
    }
  })
  const usage = usageOf(value)
  const tmux = usage?.usage?.tmuxWindows
  const selectedOption: SessionModelOption | null = options.find(opt => opt.key === value) || null
  const selectedBackendLabel = PROMPT_BACKEND_LABEL[promptBackendKeyForOption(selectedOption)]
  const selectedActiveWindowCount = Number(stats?.active_windows_by_backend?.[promptBackendKeyForOption(selectedOption)] || 0)
  const selectedLabel = selectedOption?.title || selectedOption?.label || selectedBackendLabel
  return (
    <div>
      <DropdownSelect value={value} onChange={onChange} dark={dark} placeholder="— 选择模型 —" emptyText="暂无可用模型" options={items} />
      {/* 选择模型后的小字提示 — 与传统菜单同文案: 管理员限额 + 活跃后台窗口/tmux 状态 */}
      {usage?.limit != null && (
        <p className="mt-1 text-[length:var(--fs-xs)] leading-relaxed" style={{ color: usage.blocked ? '#ef4444' : (dark ? '#93c5fd' : '#2563eb') }}>
          管理员模型限额: 最近 {usage.window_hours} 小时单用户提问 {usage.count}/{usage.limit} 次{usage.blocked ? '，已达限制，请切换模型或稍后再创建。' : `，剩余 ${usage.remaining} 次。`}
        </p>
      )}
      {stats && (
        <p className="mt-1 text-[length:var(--fs-xs)] font-medium" style={{ color: tmux?.warning ? '#f59e0b' : '#16a34a' }}>
          {tmux?.limit != null
            ? tmux.warning
              ? `${selectedLabel} tmux 窗口达到软提醒阈值（当前 ${tmux.count} / ${tmux.limit}），仍可创建。`
              : `${selectedLabel} tmux 窗口正常（当前 ${tmux.count} / ${tmux.limit}）`
            : `${selectedBackendLabel} 活跃后台窗口 ${selectedActiveWindowCount}`}
        </p>
      )}
    </div>
  )
}

// 顶栏快捷新建会话: 创建成功弹窗 (查看 / 再创建一个 / 关闭).
// 与项目·任务的 CreateSuccessDialog 不同: 会话已自动启动, "查看"走 SPA 内导航 (onNavigate) 而非新开 Tab;
// 另提供"再创建一个"由父组件原地重置表单 (保留项目/任务, 仅重置名称/描述/附件).
function SessionCreateSuccess({ name, canView, onView, onCreateAnother, onClose, dark }: {
  name: string; canView: boolean; onView: () => void; onCreateAnother: () => void; onClose: () => void; dark: boolean
}) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
      <div className="relative w-[400px] max-w-[calc(100vw-32px)] rounded-2xl p-6 shadow-2xl flex flex-col items-center text-center"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="w-12 h-12 rounded-full flex items-center justify-center mb-3" style={{ background: 'rgba(34,197,94,0.15)' }}>
          <CheckCircle2 className="w-7 h-7" style={{ color: '#22c55e' }} />
        </div>
        <h3 className="text-[length:var(--fs-2xl)] font-semibold mb-1" style={{ color: dark ? '#f1f5f9' : '#1e293b' }}>创建成功</h3>
        <p className="text-[length:var(--fs-md)] mb-5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          会话「<span style={{ color: dark ? '#e2e8f0' : '#334155' }}>{name || '(未命名)'}</span>」已创建并开始执行。
        </p>
        <div className="flex flex-col gap-2 w-full">
          <button type="button" onClick={onView} disabled={!canView}
            className="h-9 rounded-xl text-[length:var(--fs-lg)] btn-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            查看
          </button>
          <div className="flex gap-2 w-full">
            <button type="button" onClick={onCreateAnother}
              className="flex-1 h-9 rounded-xl text-[length:var(--fs-lg)] border transition-colors hover:bg-[var(--bg-card-hover)]"
              style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>再创建一个</button>
            <button type="button" onClick={onClose}
              className="flex-1 h-9 rounded-xl text-[length:var(--fs-lg)] border transition-colors hover:bg-[var(--bg-card-hover)]"
              style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>关闭</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function CreateSessionForm({ onClose, onDone, onNavigate, defaultProjectId, defaultIssueId, initialPrompt = '', successMode = 'dialog', projectKind }: { onClose: () => void; onDone: (entity: any, detailUrl?: string) => void; onNavigate?: (path: string) => void; defaultProjectId?: string; defaultIssueId?: string; initialPrompt?: string; successMode?: 'dialog' | 'external'; projectKind?: string }) {
  const { theme, user } = useStore()
  const dark = theme !== 'light'
  const userParam = user?.id
  const DRAFT_KEY = 'gc:new-session'
  const d = draftLoad<any>(DRAFT_KEY) || {}
  const [projectId, setProjectId] = useState(defaultProjectId || d.projectId || '')
  const [issueId, setIssueId] = useState(defaultIssueId || d.issueId || '')
  const [name, setName] = useState(d.name || SESSION_NAME_PLACEHOLDER)
  // 会话名称是否被人类用户手动编辑过. false → 当前是占位/自动生成, 更换目标任务时跟随重生成; true → 用户权威, 不覆盖.
  const nameUserTouchedRef = useRef<boolean>(!!d.name_touched)
  const [desc, setDesc] = useState(d.desc || initialPrompt || '')
  const [selectedMentions, setSelectedMentions] = useState<SessionMentionSelection[]>(
    Array.isArray(d.mentions) ? d.mentions : [],
  )
  // 模型默认值: 仅由 (当前 issue 上次所选 > 项目默认 > 全局默认) 三级决定.
  // 不再从全局草稿 (gc:new-session) 读/写 model —— 那会把"上次所选"泄漏到其他 issue/项目/新项目.
  // "当前 issue 上次所选"取自该 issue 最近一次 Session 的 model (session-selection-defaults 回传),
  // 服务端按 issue 隔离, 不进任何跨作用域草稿.
  // 切换 issue 时重置 modelUserTouchedRef, 让模型回到该 issue 的三级默认; 用户手动点选则锁定到下次切 issue.
  const [model, setModel] = useState<string>(GLOBAL_DEFAULT_MODEL)
  const modelUserTouchedRef = useRef(false)
  const [scopeLastModel, setScopeLastModel] = useState('')
  const [language, setLanguage] = useState<SessionLanguage>(d.language || 'zh')
  const [excludedSkills, setExcludedSkills] = useState<Set<string>>(new Set(d.excluded_skills || []))
  const [excludedMemories, setExcludedMemories] = useState<Set<string>>(new Set(d.excluded_memories || []))
  // selectionReady: 用户是否手动改过 Skill/Memory 勾选. true → 重开沿用草稿勾选快照;
  // false → 沿用后端 session-selection-defaults (同 Issue 最新 Session 继承 + 内置 Skill 默认排除).
  // 与 NewSessionModal 的 initialDraft.selection_ready 语义对齐, 避免顶栏快捷菜单"全选/全不选"而忽略默认筛选.
  const [selectionReady, setSelectionReady] = useState<boolean>(!!d.selection_ready)
  const selectionReadyRef = useRef(selectionReady)
  selectionReadyRef.current = selectionReady
  // 「恢复上次选择」: 上次成功提交的会话配置快照 (项目/任务/语言/Skill·Memory). 仅当 localStorage 存在时标题栏才显示恢复按钮.
  const [lastSelection] = useState<LastSessionSelection | null>(() => loadLastSelection())
  // 恢复时若 issueId 变化, context-preview 会重拉全集并覆盖 Skill/Memory; 此 ref 让 effect 解析后优先套用快照排除集.
  const pendingRestoreRef = useRef<LastSessionSelection | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  // 创建成功弹窗 (查看 / 再创建一个 / 关闭). null = 不显示.
  const [success, setSuccess] = useState<{ sessionId?: string; detailUrl?: string; name: string } | null>(null)
  const [createIssueOpen, setCreateIssueOpen] = useState(false)
  // 「更多会话设置」折叠: 会话名称 / 模型 / 语言 / Skill·Memory 收纳其中, 默认收起 (快捷会话核心只需 项目+任务+描述).
  const [moreOpen, setMoreOpen] = useState(false)
  // 「预览」: 直入传统菜单第 2 步 (Skill/Memory 勾选 + 完整注入文本); 表单本体隐藏不卸载, state 全保留.
  const [previewOpen, setPreviewOpen] = useState(false)
  // PC 任务模式 (仅 electron 桌面端, 与 NewSessionModal 同源): work_mode/aimux_id/local_path
  // 经 pc_client_metadata 注入 session 提示词; pc/dual 时 mobius-aimux skill 强制必选.
  // web 端无 window.mobiusDesktop → workMode 恒 null → 不渲染区块、不附 body、不锁 skill, 行为完全不变.
  const isDesktop = typeof window !== 'undefined' && !!(window as any).mobiusDesktop?.isDesktop
  const [workMode, setWorkMode] = useState<'hub' | 'pc' | 'dual' | null>(isDesktop ? 'dual' : null)
  const [aimuxId, setAimuxId] = useState<string | null>(null)
  const [pcPath, setPcPath] = useState<string>('')
  // electron 桌面端: session 默认名追加本机标识后缀 [OS · hostname] + 顺带取 aimux_id.
  // 仅 mount 一次; bootData 异步取, 函数式 setName 不覆盖用户后续编辑; 草稿已带 tag 则不重复追加.
  useEffect(() => {
    const md: any = typeof window !== 'undefined' ? (window as any).mobiusDesktop : undefined
    if (!md?.isDesktop) return
    md.getBootData?.().then?.((b: any) => {
      if (!b?.hostname) return
      setAimuxId(b.aimuxIdentifier || null)
      const osName = b.platform === 'win32' ? 'Windows' : b.platform === 'darwin' ? 'macOS' : b.platform === 'linux' ? 'Linux' : (b.platform || 'PC')
      const tag = `[${osName} · ${b.hostname}]`
      setName((prev: string) => prev && prev !== SESSION_NAME_PLACEHOLDER && !prev.includes(tag) ? `${prev} ${tag}` : prev)
    })
  }, [])

  // 协作设备 (aimux bridge): 显式指定本会话绑定的设备, 覆盖桌面端 bootData 注入的本机标识.
  // null = 跟随本机 (与改动前完全一致); 哨兵值代表"跟随本机"这一项.
  // Explicit aimux bridge device for this session; null keeps the previous behaviour (follow the local identifier)
  const [deviceOverride, setDeviceOverride] = useState<string | null>(null)
  const [bridgeDevices, setBridgeDevices] = useState<Array<{ name: string; status?: string; platform?: string }>>([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [devicesLoaded, setDevicesLoaded] = useState(false)
  // 拉取 bridge 设备清单 (与会话头部切换设备同一数据源); 供展开「更多会话设置」与标题栏刷新按钮共用
  // Loads the bridge device list; shared by the section-expand effect and the label's refresh button
  const loadDevices = useCallback(() => {
    setDevicesLoading(true)
    api('/aimux_bridge/api/remotes')
      .then((data: any) => setBridgeDevices(Array.isArray(data?.remotes) ? data.remotes.filter((d: any) => d?.name) : []))
      .catch(() => setBridgeDevices([]))
      .finally(() => { setDevicesLoading(false); setDevicesLoaded(true) })
  }, [])
  // 展开时才首次拉取 (未展开不产生请求); 之后「更多会话设置」折叠再展开不会重复拉, 要新数据点标题栏刷新
  useEffect(() => { if (moreOpen && !devicesLoaded) loadDevices() }, [moreOpen, devicesLoaded, loadDevices])

  const projects = useAsyncList<any>(() => api('/api/projects').then((r: any) => Array.isArray(r) ? r : (r?.projects || [])), [], { scope: PROJECTS_SCOPE, userId: user?.id })
  // 二级联动: 选 project 后拉 issues. 缓存 scope 单列 (菜单只取 active, 与项目页的全量 issues 列表区分开)
  // Separate cache scope: this menu only lists active issues, unlike the project page's full list
  const issues = useAsyncList<any>(() => projectId ? api(`/api/projects/${projectId}/issues?status=active`).then((r: any) => Array.isArray(r) ? r : (r?.issues || [])) : Promise.resolve([]), [projectId], projectId ? { scope: issuesScope(projectId), userId: user?.id } : undefined)
  const selectedProject = projects.list.find((p: any) => p.id === projectId)
  const selectedIssue = issues.list.find((i: any) => i.id === issueId)

  // 选定/更换目标任务时, 若名称未被用户手动改过, 自动填"任务标题 + 时间戳" (复用 NewSessionModal 的格式).
  // 用户一旦手动编辑名称即视为权威 (nameUserTouchedRef=true), 后续换任务不再覆盖. 覆盖初始预选与切换两种情况.
  useEffect(() => {
    if (selectedIssue && !nameUserTouchedRef.current) {
      setName(formatDefaultSessionName(selectedIssue.title))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIssue])

  // 项目级默认模型偏好 (default_model): 项目无偏好时为 null/''.
  const projectDefaultModel = selectedProject?.default_model
  // 全局默认模型偏好 (管理中心-系统设置): 末级兜底之前的一级.
  const [globalDefaultModel, setGlobalDefaultModel] = useState('')
  useEffect(() => {
    let alive = true
    fetchGlobalDefaultModel().then(v => { if (alive) setGlobalDefaultModel(v) })
    return () => { alive = false }
  }, [])
  // 模型三级默认: 当前 issue 上次所选 > 项目默认 > 全局默认 > 内置 codex.
  // 用户本次未手动改过才回落; 手动点选后锁定到下次切换 issue.
  useEffect(() => {
    if (modelUserTouchedRef.current) return
    setModel(resolveDefaultModelKey({ scopeLastModel, projectDefaultModel, globalDefaultModel, fallback: GLOBAL_DEFAULT_MODEL }))
  }, [scopeLastModel, projectDefaultModel, globalDefaultModel])

  // Skill/Memory 全集: 选完 issue 后拉一次 context-preview (sources + defaults).
  // 默认排除集沿用后端"同 Issue 最新 Session 继承 + 内置 Skill 默认排除"机制, 与 NewSessionModal goPreview 一致,
  // 避免顶栏快捷菜单全选/全不选而忽略传统菜单的默认筛选.
  const [availSkills, setAvailSkills] = useState<PickItem[]>([])
  const [availMemories, setAvailMemories] = useState<PickItem[]>([])
  useEffect(() => {
    if (!issueId) { setAvailSkills([]); setAvailMemories([]); setScopeLastModel(''); return }
    let alive = true
    api(`/api/issues/${issueId}/context-preview`, {
      method: 'POST',
      body: JSON.stringify({ name: name || ' ', description: desc || ' ', excluded_skill_ids: [], excluded_memory_ids: [], include_defaults: true, include_body: false, include_item_bodies: false }),
    }).then((p: any) => {
      if (!alive) return
      const defaults = p?.defaults || null
      const skills = (p?.sources?.skills || []).map((s: any) => ({ id: s.id, name: s.name, description: s.description, scope: s.scope || 'project', dirName: s.dirName }))
      const memories = (p?.sources?.memories || []).map((m: any) => ({ id: m.id, name: m.name, description: m.description, scope: m.scope || 'project' }))
      setAvailSkills(skills)
      setAvailMemories(memories)
      // 当前 issue 上次所选模型 (该 issue 最近一次 Session 的 model); 无历史则为空 → 由三级默认回落.
      setScopeLastModel(typeof defaults?.model === 'string' ? defaults.model : '')
      const skillIds = new Set(skills.map((s: any) => s.id))
      const memIds = new Set(memories.map((m: any) => m.id))
      // 「恢复上次选择」优先: pendingRestoreRef 命中当前任务 → 套用快照的 Skill/Memory 排除集 (按当前可用 ID 过滤), 不走草稿/默认.
      const pr = pendingRestoreRef.current
      if (pr && pr.issueId === issueId) {
        pendingRestoreRef.current = null
        setExcludedSkills(new Set((pr.excluded_skills || []).filter((id: string) => skillIds.has(id))))
        setExcludedMemories(new Set((pr.excluded_memories || []).filter((id: string) => memIds.has(id))))
        setSelectionReady(true)
      } else if (selectionReadyRef.current && ((d.excluded_skills && d.excluded_skills.length) || (d.excluded_memories && d.excluded_memories.length))) {
        setExcludedSkills(new Set((d.excluded_skills || []).filter((id: string) => skillIds.has(id))))
        setExcludedMemories(new Set((d.excluded_memories || []).filter((id: string) => memIds.has(id))))
      } else {
        setExcludedSkills(new Set((defaults?.excluded_skill_ids || []).filter((id: string) => skillIds.has(id))))
        setExcludedMemories(new Set((defaults?.excluded_memory_ids || []).filter((id: string) => memIds.has(id))))
      }
    }).catch(() => { if (alive) { pendingRestoreRef.current = null; setAvailSkills([]); setAvailMemories([]); setScopeLastModel('') } })
    return () => { alive = false }
    // 仅在 issueId 变化时拉全集; 勾选/改名不重拉.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId])

  // 切换 issue: 清除用户上一次的手动模型选择, 让模型按该 issue 的三级默认重算.
  useEffect(() => { modelUserTouchedRef.current = false }, [issueId])

  useEffect(() => {
    // 注意: 刻意不持久化 model —— 顶栏草稿是全局的 (不绑 issue), 写入 model 会把"上次所选"泄漏到
    // 其他 issue/项目/新项目. 模型默认完全由 (当前 issue 上次所选 > 项目默认 > 全局默认) 即时计算.
    draftSave(DRAFT_KEY, { projectId, issueId, name, name_touched: nameUserTouchedRef.current, desc, mentions: selectedMentions, language, excluded_skills: Array.from(excludedSkills), excluded_memories: Array.from(excludedMemories), selection_ready: selectionReady }, { minChars: 0 })
  }, [projectId, issueId, name, desc, selectedMentions, language, excludedSkills, excludedMemories, selectionReady])

  const toggle = (set: Set<string>, id: string, setter: React.Dispatch<React.SetStateAction<Set<string>>>) => {
    const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); setter(n)
  }

  // 协作设备下拉里「跟随本机」那一项的哨兵值 (不会发给后端)
  // Sentinel value for the "follow the local identifier" option; never sent to the backend
  const DEVICE_AUTO = '__auto__'
  // 显式选中的协作设备优先, 未选时沿用本机标识 (桌面端 bootData 注入); 两者皆空则为空.
  // An explicitly picked device wins; otherwise the local identifier applies
  const effectiveAimuxId = deviceOverride ?? aimuxId
  // web 端显式指定设备时也走 PC 任务模式 (默认双侧): 后端提示词与 remote_* MCP 注入都依赖 work_mode, 缺失则设备选择失效.
  // Picking a device on web implies PC task mode — the backend prompt and MCP injection both need work_mode
  const effectiveWorkMode = workMode ?? (deviceOverride ? 'dual' : null)
  // 必选 skill 目录名集合: PC 任务模式 (pc/dual) 锁 mobius-aimux; 拓展项目锁 mobius-extension
  // (与 NewSessionModal 的 matchesRequiredSkill 同源, 任务页入口替换后拓展项目仍强制注入).
  const requiredSkillDirs = useMemo(() => {
    const dirs = new Set<string>()
    if (effectiveWorkMode === 'pc' || effectiveWorkMode === 'dual') dirs.add('mobius-aimux')
    if (projectKind === 'extension') dirs.add('mobius-extension')
    return dirs
  }, [effectiveWorkMode, projectKind])
  // SkillMemoryPicker 经 skillLockedOf 锁定必选 skill 不可取消.
  const skillLockedOf = useCallback((id: string) => {
    if (requiredSkillDirs.size === 0) return false
    const sk = availSkills.find(s => s.id === id)
    return requiredSkillDirs.has((sk?.dirName || '').replace(/_/g, '-'))
  }, [requiredSkillDirs, availSkills])

  const submit = async () => {
    if (!projectId) { setErr('请选择目标项目'); return }
    if (!issueId) { setErr('请选择目标任务'); return }
    if (!name.trim() || name === SESSION_NAME_PLACEHOLDER) { setErr('请填写会话名称'); return }
    setLoading(true); setErr('')
    try {
      const finalDesc = appendAttachmentsToDesc(desc.trim() || name, attachments)
      // 必选 skill 即便被排除过, 提交时也从排除集清理 (与 NewSessionModal normalizeSkillExclusions 同源).
      const excludedSkillIds = Array.from(excludedSkills).filter(id => {
        const sk = availSkills.find(s => s.id === id)
        return !requiredSkillDirs.has((sk?.dirName || '').replace(/_/g, '-'))
      })
      const s = await api(`/api/issues/${issueId}/sessions`, { method: 'POST', body: JSON.stringify({
        name, description: finalDesc, model, language,
        mentions: sessionMentionPayload(selectedMentions),
        excluded_skill_ids: excludedSkillIds, excluded_memory_ids: Array.from(excludedMemories),
        // 用户手填过名称 → 标记 name_touched, 后端置 name_human_edited=1, AI 标题生成器不再覆盖此名.
        name_touched: nameUserTouchedRef.current,
        // PC 任务模式: 桌面端恒有 workMode; web 端仅在用户显式选了协作设备时才附 (effectiveWorkMode 随之非空).
        // PC task mode: always on desktop, and on web once a collaboration device was explicitly picked
        ...(effectiveWorkMode ? { pc_client_metadata: { work_mode: effectiveWorkMode, aimux_id: effectiveAimuxId || undefined, local_path: pcPath || undefined, is_tui: false, add_remote_aimux_mcp: true } } : {}),
      }) })
      if (s?.error) { setErr(s.error); return }
      // 记录「恢复上次选择」快照 (项目/任务/语言/Skill·Memory), 下次新建可一键回填. 与工作草稿 (gc:new-session) 不同键, 提交清草稿不影响此快照.
      saveLastSelection({
        projectId, issueId,
        projectName: selectedProject?.name, issueTitle: selectedIssue?.title,
        language, excluded_skills: Array.from(excludedSkills), excluded_memories: Array.from(excludedMemories),
        ts: Date.now(),
      })
      draftClear(DRAFT_KEY)
      // 顶栏快捷菜单: 创建后立即发出启动请求 (把名称+描述作为首条消息), 不跳转会话页、不弹"是否开始执行"确认.
      // 与 ChatArea.startSession 同链路 (POST /api/sessions/:id/messages); fire-and-forget 后直接关闭菜单.
      const startContent = [name.trim(), finalDesc].filter(Boolean).join('\n\n')
      if (s?.session_id && startContent) {
        const requestId = `gc-start-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        api(`/api/sessions/${s.session_id}/messages`, { method: 'POST', body: JSON.stringify({
          content: startContent,
          request_id: requestId,
          mentions: sessionMentionPayload(selectedMentions),
        }) }).catch(() => {})
      }
      const detailUrl = s?.session_id && userParam ? `/u/${userParam}/p/${projectId}/i/${issueId}?session=${s.session_id}` : undefined
      // 简易模式由页面层用 Toast 反馈并刷新工作列表，创建层立即关闭；标准模式保留
      // “查看 / 再创建一个 / 关闭”弹窗，避免改变既有快捷创建流程。
      if (successMode === 'external') {
        onDone(s, detailUrl)
        return
      }
      setSuccess({ sessionId: s?.session_id, detailUrl, name: name.trim() })
    } catch (e: any) { setErr(e?.message || '创建失败') } finally { setLoading(false) }
  }

  // 创建成功弹窗: 已自动启动, 提供 查看(SPA 内进入会话) / 再创建一个(保留项目任务, 重置名称描述) / 关闭.
  if (success) {
    return (
      <SessionCreateSuccess
        name={success.name}
        canView={!!success.detailUrl && !!onNavigate}
        onView={() => { if (success.detailUrl && onNavigate) onNavigate(success.detailUrl); onClose() }}
        onCreateAnother={() => {
          // 重置为"未手动编辑", 让名称按当前目标任务重新自动生成 (带新时间戳); 保留项目/任务/模型/语言/Skill·Memory.
          nameUserTouchedRef.current = false
          setName(selectedIssue ? formatDefaultSessionName(selectedIssue.title) : SESSION_NAME_PLACEHOLDER)
          setDesc(''); setSelectedMentions([]); setAttachments([]); setErr(''); setSuccess(null)
        }}
        onClose={onClose}
        dark={dark}
      />
    )
  }

  // 一键回填上次成功提交的选择 (项目/任务/语言/Skill·Memory); 模型交由该任务"上次所选"三级默认自动还原.
  const restoreLastSelection = () => {
    if (!lastSelection) return
    const snap = lastSelection
    // issueId 不变 → context-preview 不会重跑: 直接按当前已加载全集套用; issueId 变化 → 挂 pending, 由 effect 解析后权威套用.
    if (issueId !== snap.issueId) pendingRestoreRef.current = snap
    const skillIds = new Set(availSkills.map(s => s.id))
    const memIds = new Set(availMemories.map(m => m.id))
    setExcludedSkills(new Set((snap.excluded_skills || []).filter(id => skillIds.has(id))))
    setExcludedMemories(new Set((snap.excluded_memories || []).filter(id => memIds.has(id))))
    setSelectionReady(true)
    setProjectId(snap.projectId)
    setIssueId(snap.issueId)
    setLanguage(snap.language)
    // 名称按恢复后的目标任务自动重生成 (沿用 selectedIssue → formatDefaultSessionName 既有 effect).
    nameUserTouchedRef.current = false
    setErr('')
  }

  // 「预览」: 基础字段校验后直入传统菜单第 2 步 (描述可空 → 第 2 步按"稍后再写"处理).
  const openPreview = () => {
    if (!projectId) { setErr('请选择目标项目'); return }
    if (!issueId) { setErr('请选择目标任务'); return }
    if (!name.trim() || name === SESSION_NAME_PLACEHOLDER) { setErr('请填写会话名称'); return }
    setErr('')
    setPreviewOpen(true)
  }

  // 第 2 步「上一步」: 带回预览页里改过的 Skill/Memory 勾选, 表单接管后续创建; 预览加载失败也走这里带回错误.
  const handleBackFromPreview = (payload?: { err?: string; excluded_skill_ids?: string[]; excluded_memory_ids?: string[] }) => {
    if (payload?.excluded_skill_ids) { setExcludedSkills(new Set(payload.excluded_skill_ids)); setSelectionReady(true) }
    if (payload?.excluded_memory_ids) { setExcludedMemories(new Set(payload.excluded_memory_ids)); setSelectionReady(true) }
    if (payload?.err) setErr(payload.err)
    setPreviewOpen(false)
  }

  // 第 2 步「确认并创建」: 与直连「创建」同链路 —— 发首条消息自动启动 + 记「恢复上次选择」快照 + 成功弹窗/外部回调.
  const handlePreviewCreated = (s: any, meta?: { excluded_skill_ids?: string[]; excluded_memory_ids?: string[] }) => {
    const finalSkills = meta?.excluded_skill_ids ?? Array.from(excludedSkills)
    const finalMemories = meta?.excluded_memory_ids ?? Array.from(excludedMemories)
    const finalDesc = appendAttachmentsToDesc(desc.trim() || name, attachments)
    const startContent = [name.trim(), finalDesc].filter(Boolean).join('\n\n')
    if (s?.session_id && startContent) {
      api(`/api/sessions/${s.session_id}/messages`, { method: 'POST', body: JSON.stringify({
        content: startContent,
        request_id: `gc-start-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mentions: sessionMentionPayload(selectedMentions),
      }) }).catch(() => {})
    }
    saveLastSelection({
      projectId, issueId,
      projectName: selectedProject?.name, issueTitle: selectedIssue?.title,
      language, excluded_skills: finalSkills, excluded_memories: finalMemories,
      ts: Date.now(),
    })
    draftClear(DRAFT_KEY)
    const detailUrl = s?.session_id && userParam ? `/u/${userParam}/p/${projectId}/i/${issueId}?session=${s.session_id}` : undefined
    if (successMode === 'external') {
      onDone(s, detailUrl)
      return
    }
    setSuccess({ sessionId: s?.session_id, detailUrl, name: name.trim() })
  }

  // 标题栏「恢复上次选择」按钮: 仅当 localStorage 存在上次成功提交的快照时才渲染 (需求: 仅在有相关存储时显示).
  const headerExtra = lastSelection ? (
    <button key="restore-last" type="button" onClick={restoreLastSelection}
      title={`恢复上次选择：${lastSelection.projectName || '项目'} / ${lastSelection.issueTitle || '任务'}`}
      className="h-7 px-2 rounded-lg flex items-center gap-1 text-[length:var(--fs-sm)] hover:bg-[var(--bg-card-hover)] transition-colors"
      style={{ color: 'var(--text-muted)' }}>
      <History className="w-3 h-3" />
      <span>恢复上次选择</span>
    </button>
  ) : null

  return (
    <>
      {/* 预览期间隐藏表单而不卸载: 项目/任务/名称/描述等 state 原样保留, 返回时无缝接续 */}
      <div style={previewOpen ? { display: 'none' } : undefined}>
        <CreateModalShell title="新建快捷会话" onClose={onClose} dark={dark} width={600} headerExtra={headerExtra}
          footer={<Footer loading={loading} submitText="创建" onClose={onClose} onSubmit={submit} disabled={!projectId || !issueId}
            preview={{ onClick: openPreview, disabled: !projectId || !issueId }} />}>
          {/* 目标项目 / 目标任务 并排一行省高度; 窄屏 (手机) 仍退回上下两行
              Project + task sit on one row to save vertical space; they stack again on narrow screens */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-3.5">
            <SelectShell label="目标项目" current={selectedProject?.name} loading={projects.loading} onRefresh={projects.refresh} dark={dark}>
              <DropdownSelect
                value={projectId}
                onChange={v => { setProjectId(v); setIssueId(''); setErr('') }}
                dark={dark}
                placeholder="— 选择项目 —"
                emptyText="暂无可用项目"
                options={[
                  { value: '', label: '— 选择项目 —', description: '取消选择' },
                  ...projects.list.map((p: any) => ({
                    value: String(p.id),
                    label: String(p.name),
                    description: p.description ? String(p.description) : undefined,
                    badge: p.research_enabled ? { text: '研究', color: '#10b981', bg: 'rgba(16,185,129,0.15)' } : undefined,
                  })),
                ]}
              />
            </SelectShell>
            <SelectShell label="目标任务" current={selectedIssue?.title} loading={issues.loading} onRefresh={issues.refresh} dark={dark} hint={projectId ? '' : '请先选择项目'}>
              <DropdownSelect
                value={issueId}
                onChange={v => { setIssueId(v); setSelectionReady(false); setErr('') }}
                disabled={!projectId}
                dark={dark}
                placeholder={projectId ? '— 选择任务 —' : '请先选择项目'}
                emptyText={projectId ? '该项目下暂无任务' : '请先选择项目'}
                panelAction={projectId ? {
                  label: '在当前项目新建任务',
                  onClick: () => setCreateIssueOpen(true),
                } : undefined}
                options={[
                  { value: '', label: projectId ? '— 选择任务 —' : '请先选择项目', description: '取消选择' },
                  ...issues.list.map((i: any) => ({
                    value: String(i.id),
                    label: String(i.title),
                    description: i.description ? String(i.description) : undefined,
                  })),
                ]}
              />
            </SelectShell>
          </div>
          <DescriptionWithAttachments value={desc} onValueChange={v => { setDesc(v); setErr('') }} placeholder="希望这个会话完成什么" attachments={attachments} setAttachments={setAttachments} projectId={projectId || undefined} dark={dark} />
          <SessionMentionPicker
            value={desc}
            onValueChange={v => { setDesc(v); setErr('') }}
            selected={selectedMentions}
            onSelectedChange={setSelectedMentions}
            projectId={projectId || undefined}
            issueId={issueId || undefined}
            disabled={!issueId}
          />
          {isDesktop && (
            <PcTaskModeSection projectId={projectId || undefined} isDark={dark} onModeChange={setWorkMode} onPathChange={setPcPath} />
          )}
          <button type="button" onClick={() => setMoreOpen(v => !v)}
            className="flex w-full items-center gap-1.5 py-1 text-[length:var(--fs-md)] font-medium rounded-lg transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{ color: 'var(--text-secondary)' }}>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${moreOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--text-muted)' }} />
            <span>更多会话设置</span>
          </button>
          {moreOpen && (
            <>
              {/* 会话名称 / 协作设备并排一行 (省高度); 窄屏退回上下两行
                  Session name + collaboration device share one row; they stack on narrow screens */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-3.5">
                <div>
                  <SectionLabel>会话名称</SectionLabel>
                  <TextInput value={name} onChange={v => { setName(v); nameUserTouchedRef.current = true; setErr('') }} placeholder="给这个会话起个名字" dark={dark} />
                </div>
                <div>
                  {/* 标签已自带说明, 不再挂 hint —— 半宽列里两者并排会挤爆 */}
                  <SectionLabel>
                    <LabelWithRefresh label="设备（令智能体在指定设备工作）" loading={devicesLoading} onRefresh={loadDevices} />
                  </SectionLabel>
                  <DropdownSelect
                    value={deviceOverride ?? DEVICE_AUTO}
                    onChange={v => setDeviceOverride(v === DEVICE_AUTO ? null : v)}
                    dark={dark}
                    placeholder="— 中枢 —"
                    emptyText="暂无可协作设备"
                    options={[
                      // 桌面端默认绑定的是本机标识, web 端没有"本机"概念 → 同一个默认项按平台措辞
                      { value: DEVICE_AUTO, label: isDesktop ? '跟随本机' : '中枢', description: aimuxId ? `当前: ${aimuxId}` : '只在莫比乌斯中枢上工作' },
                      // 离线设备仍可选 (与头部切换设备一致: 断开时仍可依托中枢继续执行任务), 只标状态不置灰
                      // Offline devices stay selectable — they are flagged, not disabled, matching the header switcher
                      ...bridgeDevices.map(d => ({
                        value: d.name,
                        label: d.name,
                        description: [d.platform, d.status === 'connected' ? '在线' : '离线'].filter(Boolean).join(' · '),
                        badge: d.status === 'connected' ? undefined : { text: '离线', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
                      })),
                    ]}
                  />
                  {devicesLoaded && bridgeDevices.length === 0 && (
                    <p className="mt-1 text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>暂无已连接的 bridge 设备</p>
                  )}
                </div>
              </div>
              {/* 模型 / 语言并排一行 (都为下拉, 省高度); 窄屏退回上下两行
                  Model + language share one row as dropdowns; they stack on narrow screens */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-3.5">
                <div>
                  <SectionLabel>模型</SectionLabel>
                  <SessionModelDropdown value={model} onChange={v => { setModel(v); modelUserTouchedRef.current = true }} dark={dark} />
                </div>
                <div>
                  <SectionLabel hint="注入上下文语言">语言</SectionLabel>
                  <LanguageSelect value={language} onChange={setLanguage} dark={dark} />
                </div>
              </div>
              <div>
                <SectionLabel hint={issueId ? '点击展开二级弹窗选择' : '选择任务后可配置'}>Skill / Memory</SectionLabel>
                <SkillMemoryPicker
                  skills={availSkills}
                  memories={availMemories}
                  excludedSkills={excludedSkills}
                  excludedMemories={excludedMemories}
                  onToggleSkill={id => { toggle(excludedSkills, id, setExcludedSkills); setSelectionReady(true) }}
                  onToggleMemory={id => { toggle(excludedMemories, id, setExcludedMemories); setSelectionReady(true) }}
                  skillLockedOf={skillLockedOf}
                  disabled={!issueId}
                  dark={dark}
                />
              </div>
            </>
          )}
          {createIssueOpen && (
            <CreateIssueForm
              defaultProjectId={projectId}
              onClose={() => setCreateIssueOpen(false)}
              onDone={(issue) => {
                setIssueId(String(issue.id))
                setSelectionReady(false)
                setErr('')
                setCreateIssueOpen(false)
                issues.refresh()
              }}
            />
          )}
          {err && <ErrBanner>{err}</ErrBanner>}
        </CreateModalShell>
      </div>
      {previewOpen && (
        <Suspense fallback={
          <div className="fixed inset-0 z-[60] flex items-center justify-center">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <Loader2 className="relative h-7 w-7 animate-spin" style={{ color: '#60a5fa' }} strokeWidth={1.8} />
          </div>
        }>
          <NewSessionModal
            issueId={issueId}
            projectId={projectId}
            modalTitle="新建快捷会话"
            initialStep={2}
            initialValues={{
              name, desc, model, language,
              // 描述为空 → 第 2 步按"稍后再写" (Fire & Forget) 处理, 与本表单创建时的 desc||name 回落一致
              defer_purpose: !desc.trim(),
              excluded_skill_ids: Array.from(excludedSkills),
              excluded_memory_ids: Array.from(excludedMemories),
              mentions: selectedMentions,
              attachments,
            }}
            defaultModel={selectedProject?.default_model ?? null}
            projectKind={selectedProject?.kind}
            onBack={handleBackFromPreview}
            onClose={onClose}
            onCreated={handlePreviewCreated}
          />
        </Suspense>
      )}
    </>
  )
}
