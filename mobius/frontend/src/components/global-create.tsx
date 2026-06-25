// =====================================================================
// 全局「+」统一新建菜单 — 顶栏入口直接复用系统已有标准弹窗 (modals.tsx),
// 与项目 / Issue / Research 页面内「新建」按钮打开的是同一套弹窗,
// 字段 / 交互 / 功能完全一致.
//
// 设计:
//   - 顶栏 [+] 下拉 4 入口: 项目 / Issue / Session / Research Agent.
//   - 命中当前页上下文 → 直接开对应标准弹窗;
//     否则先弹 TargetPicker 选目标 (项目 → Issue / Research) 再开同一个弹窗.
//   - 创建成功 → 同标签页 navigate 到新实体 (与页面内一致).
// =====================================================================
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore, api } from '../store'
import { useIsMobile } from './resizable-panel'
import { NewProjectModal, NewIssueModal, NewSessionModal } from './modals'
import { Plus, ChevronDown, X, FolderPlus, CircleDot, MessagesSquare, FlaskConical } from 'lucide-react'

export type CreateKind = 'project' | 'issue' | 'session' | 'research'

// ---------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------
// 通用异步列表 (动态刷新: 中途新建的 project/issue/research 可被重新读到).
function useAsyncList<T>(fetcher: () => Promise<T[]>, deps: any[]): { list: T[]; loading: boolean; refresh: () => void } {
  const [list, setList] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const load = useCallback(() => {
    setLoading(true)
    fetcher().then(setList).catch(() => setList([])).finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => { load() }, [load])
  return { list, loading, refresh: load }
}

function SectionLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between mb-1.5">
      <label className="block text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>{children}</label>
      {hint && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{hint}</span>}
    </div>
  )
}

// ---------------------------------------------------------------------
// 目标选择器 — 不在对应页面时, 先选项目 (→Issue/Research) 再打开系统标准弹窗.
// ---------------------------------------------------------------------
function TargetPicker({ need, onClose, onPicked }: {
  need: 'issue' | 'session' | 'research'
  onClose: () => void
  onPicked: (ids: { projectId: string; issueId?: string; researchId?: string }) => void
}) {
  const dark = useStore(s => s.theme) !== 'light'
  const [projectId, setProjectId] = useState('')
  const [issueId, setIssueId] = useState('')
  const [researchId, setResearchId] = useState('')
  const projects = useAsyncList<any>(() => api('/api/projects').then((r: any) => Array.isArray(r) ? r : (r?.projects || [])), [])
  const needIssue = need === 'session'
  const needResearch = need === 'research'
  const issues = useAsyncList<any>(() => (projectId && needIssue) ? api(`/api/projects/${projectId}/issues?status=active`).then((r: any) => Array.isArray(r) ? r : (r?.issues || [])) : Promise.resolve([]), [projectId])
  const researches = useAsyncList<any>(() => (projectId && needResearch) ? api(`/api/projects/${projectId}/researches?status=active`).then((r: any) => Array.isArray(r) ? r : (r?.researches || [])) : Promise.resolve([]), [projectId])
  const canConfirm = !!projectId && (!needIssue || !!issueId) && (!needResearch || !!researchId)
  const titleMap = { issue: '选择目标项目', session: '选择目标项目 / Issue', research: '选择目标项目 / Research' } as const
  const selectCls = 'w-full h-10 px-2.5 rounded-xl text-[13px] focus:outline-none focus:border-blue-500/40'
  const selectStyle = { background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: dark ? '#f1f5f9' : '#1e293b' } as React.CSSProperties
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[440px] max-w-[calc(100vw-24px)] rounded-2xl shadow-2xl flex flex-col" style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <h3 className="text-[15px] font-semibold" style={{ color: dark ? '#f1f5f9' : '#1e293b' }}>{titleMap[need]}</h3>
          <button type="button" onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3.5">
          <div>
            <SectionLabel>项目</SectionLabel>
            <select value={projectId} onChange={e => { setProjectId(e.target.value); setIssueId(''); setResearchId('') }} className={selectCls} style={selectStyle}>
              <option value="">— 选择项目 —</option>
              {projects.list.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {needIssue && (
            <div>
              <SectionLabel>Issue</SectionLabel>
              <select value={issueId} onChange={e => setIssueId(e.target.value)} className={selectCls} style={selectStyle}>
                <option value="">— 选择 Issue —</option>
                {issues.list.map((i: any) => <option key={i.id} value={i.id}>{i.title}</option>)}
              </select>
            </div>
          )}
          {needResearch && (
            <div>
              <SectionLabel>Research</SectionLabel>
              <select value={researchId} onChange={e => setResearchId(e.target.value)} className={selectCls} style={selectStyle}>
                <option value="">— 选择 Research —</option>
                {researches.list.map((r: any) => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t flex gap-2" style={{ borderColor: 'var(--border-color)' }}>
          <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] border transition-colors hover:bg-[var(--bg-card-hover)]" style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>取消</button>
          <button onClick={() => canConfirm && onPicked({ projectId, issueId: needIssue ? issueId : undefined, researchId: needResearch ? researchId : undefined })} disabled={!canConfirm} className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors disabled:opacity-40">下一步</button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// 顶栏触发器 + 下拉
// ---------------------------------------------------------------------
const MENU_ITEMS: { kind: CreateKind; label: string; icon: any }[] = [
  { kind: 'project', label: '新建项目', icon: FolderPlus },
  { kind: 'issue', label: '新建 Issue', icon: CircleDot },
  { kind: 'session', label: '新建 Session', icon: MessagesSquare },
  { kind: 'research', label: '新建 Research Agent', icon: FlaskConical },
]

export function GlobalCreateMenu({ open, onOpenChange, onPick, inProject, currentProject, researchEnabled }: {
  open: boolean; onOpenChange: (v: boolean) => void; onPick: (kind: CreateKind) => void
  inProject: boolean; currentProject: any; researchEnabled: boolean
}) {
  // 移动端 (≤ 断点): 触发按钮只留 [+] 图标, 隐藏「新建」文字与下拉箭头, 极简化顶栏.
  const isMobile = useIsMobile()
  useEffect(() => {
    if (!open) return
    const close = () => onOpenChange(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open, onOpenChange])

  const canPick = (kind: CreateKind): boolean => {
    if (kind === 'issue') return inProject ? currentProject?.can_create_issue !== false : true
    if (kind === 'research') return inProject ? (researchEnabled && currentProject?.can_create_research !== false) : true
    return true
  }
  const hintFor = (kind: CreateKind): string | undefined => {
    if (kind === 'research' && inProject && !researchEnabled) return '未启用 Research'
    return undefined
  }

  return (
    <div className="relative" data-tour="top-create">
      <button type="button"
        onClick={(e) => { e.stopPropagation(); onOpenChange(!open) }}
        title="新建" aria-label="新建" aria-haspopup="menu" aria-expanded={open}
        className="mobius-create-trigger h-8 flex items-center gap-1 rounded-lg pl-2 pr-2">
        <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
        {!isMobile && <span className="text-[12px] font-semibold">新建</span>}
        {!isMobile && <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-50 min-w-[200px] rounded-lg shadow-xl py-1"
          style={{ background: 'var(--menu-bg)', border: '1px solid var(--border-color)' }}
          onClick={e => e.stopPropagation()}>
          {MENU_ITEMS.map(item => {
            const Icon = item.icon
            const ok = canPick(item.kind)
            const hint = hintFor(item.kind)
            return (
              <button key={item.kind} type="button"
                disabled={!ok}
                onClick={() => { if (ok) { onOpenChange(false); onPick(item.kind) } }}
                className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--bg-hover)] flex items-center gap-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                style={{ color: 'var(--text-primary)' }}>
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{item.label}</span>
                {hint && <span className="ml-auto text-[10px]" style={{ color: 'var(--text-muted)' }}>{hint}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// 根调度: 复用系统已有标准弹窗 (modals.tsx 的 NewProjectModal/NewIssueModal/NewSessionModal),
// 与页面内「新建」完全一致. 有当前页上下文 → 直接开; 缺则先弹 TargetPicker 选目标, 再开同一个弹窗.
// ---------------------------------------------------------------------
export function GlobalCreateRoot({ kind, ctx, onClose }: {
  kind: CreateKind | null
  ctx: { projectId?: string; issueId?: string; researchId?: string }
  onClose: () => void
}) {
  const navigate = useNavigate()
  const user = useStore(s => s.user)
  const [target, setTarget] = useState<{ projectId?: string; issueId?: string; researchId?: string }>({})
  const projectId = target.projectId || ctx.projectId
  const issueId = target.issueId || ctx.issueId
  const researchId = target.researchId || ctx.researchId

  if (!kind) return null

  if (kind === 'project') {
    return <NewProjectModal onClose={onClose} onCreated={(p: any) => { onClose(); if (p?.id && p?.created_by) navigate(`/u/${p.created_by}/p/${p.id}`) }} />
  }
  if (kind === 'issue') {
    if (!projectId) return <TargetPicker need="issue" onClose={onClose} onPicked={setTarget} />
    return <NewIssueModal projectId={projectId} onClose={onClose} onCreated={(iss: any) => { onClose(); if (iss?.id) navigate(`/u/${user?.id}/p/${projectId}/i/${iss.id}`) }} />
  }
  if (kind === 'session') {
    if (!issueId) return <TargetPicker need="session" onClose={onClose} onPicked={setTarget} />
    return <NewSessionModal issueId={issueId} onClose={onClose} onCreated={(s: any) => { onClose(); if (s?.session_id) navigate(`/u/${user?.id}/p/${projectId}/i/${issueId}?session=${s.session_id}`) }} />
  }
  if (kind === 'research') {
    if (!researchId) return <TargetPicker need="research" onClose={onClose} onPicked={setTarget} />
    return <NewSessionModal researchId={researchId} entityLabel="Research Agent" onClose={onClose} onCreated={(s: any) => { onClose(); if (s?.session_id) navigate(`/u/${user?.id}/p/${projectId}/r/${researchId}`) }} />
  }
  return null
}
