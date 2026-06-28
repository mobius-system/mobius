import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import { ArrowLeft, Dices, FlaskConical, Folder, FolderOpen, FolderPlus, Pencil, Puzzle, AlertTriangle, Eye, Square, CheckSquare, X } from 'lucide-react'
import { useStore, api } from '../store'
import { timeAgo } from './shell'
import { SkillsManager } from './skills'
import { MemoriesManager } from './memories'
import { ProjectUserContextWhitelist } from './context-whitelist'
import { ToggleSwitch } from './toggle-switch'
import { ExpandableTextarea } from './expandable-textarea'
import { type Attachment, AttachmentComposer, appendAttachmentsToDesc } from './attachments'
import {
  completeGuidedDemoStateForProject,
  isGuidedDemoIssue,
  isGuidedDemoProject,
  patchGuidedDemoState,
  readActiveGuidedDemo,
} from '../services/guided-demo'
import {
  SELF_EVOLVE_GUIDE_STYLE_MEMORY_NAMES,
  SELF_EVOLVE_PROJECT_KNOWLEDGE_MEMORY_NAME,
  SELF_EVOLVE_REQUIRED_MEMORY_NAME,
  SELF_EVOLVE_REQUIRED_SKILL_NAME,
} from '../services/self-evolve-demo'
import { LOGO_REVIEW_PROJECT_ID, readLogoReviewDemoState } from '../services/logo-review-demo'
import { draftClear, draftLoad, draftSave } from '../services/input-drafts'
import { fetchGlobalDefaultModel } from '../services/global-default-model'
import {
  DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE,
  FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX,
  FORGOTTEN_FLAG_BACKOFF_MAX,
  FORGOTTEN_FLAG_PATIENCE_MAX,
  intervalInputValue,
  numberInputValue,
  parseIntervalInput,
  parseBackoffInput,
  parsePatienceInput,
} from './project-page/utils'
import { markFireAndForgetSession } from '../services/session-start-policy'

type ProjectVisibility = 'private' | 'team' | 'public' | 'allowlist'
type IssueVisibility = 'inherit' | ProjectVisibility
const PROJECT_VISIBILITY_OPTIONS: Array<{ value: ProjectVisibility; label: string; description: string }> = [
  { value: 'private', label: '仅自己', description: '只有项目创建者和管理员可见、可建任务单。' },
  { value: 'team', label: '同组', description: '同一群组的用户可见，并可创建任务单和执行会话。' },
  { value: 'public', label: '公开', description: '所有登录用户可见，可创建任务单、执行会话并打开文件。' },
  { value: 'allowlist', label: '指定用户', description: '只有项目创建者、管理员和允许名单中的用户可见。' },
]
const ISSUE_VISIBILITY_OPTIONS: Array<{ value: IssueVisibility; label: string; description: string }> = [
  { value: 'inherit', label: '继承项目', description: '跟随所属项目的可见性。' },
  { value: 'private', label: '仅自己', description: '只有任务单创建者、项目创建者和管理员可见。' },
  { value: 'team', label: '同组', description: '同一群组用户可见，前提是他们也能看到项目。' },
  { value: 'public', label: '项目可见者', description: '所有能看到项目的登录用户都可见。' },
  { value: 'allowlist', label: '指定用户', description: '只有任务单创建者、项目创建者、管理员和允许名单中的用户可见。' },
]
type NewProjectKind = 'default' | 'research' | 'extension'
const NEW_PROJECT_KIND_LABELS: Record<NewProjectKind, string> = {
  default: '经典项目',
  research: 'Research 项目',
  extension: '莫比乌斯拓展项目',
}
const RANDOM_PROJECT_ADJECTIVES = [
  'bright', 'calm', 'clever', 'cozy', 'cute', 'eager', 'fresh', 'gentle',
  'happy', 'kind', 'lively', 'lovely', 'lucky', 'merry', 'neat', 'nimble',
  'quiet', 'rapid', 'smart', 'sunny', 'tidy', 'warm', 'wise', 'young',
]
const RANDOM_PROJECT_NOUNS = [
  'bird', 'brook', 'cloud', 'field', 'forest', 'garden', 'harbor', 'lake',
  'leaf', 'light', 'meadow', 'moon', 'mountain', 'river', 'seed', 'snake',
  'spark', 'star', 'stone', 'sun', 'tree', 'valley', 'wave', 'wind',
]

function randomProjectWord(words: string[]) {
  return words[Math.floor(Math.random() * words.length)] || words[0]
}

function randomProjectSlug() {
  return `${randomProjectWord(RANDOM_PROJECT_ADJECTIVES)}_${randomProjectWord(RANDOM_PROJECT_NOUNS)}`
}

function randomProjectBindPath(workDir?: string | null) {
  const root = (workDir || '').trim().replace(/\/+$/, '')
  if (!root) return ''
  return `${root || '/'}/${randomProjectSlug()}`.replace(/\/{2,}/g, '/')
}

function middleEllipsisPath(value: string, maxLength = 64) {
  const text = String(value || '')
  if (text.length <= maxLength) return text
  const available = Math.max(8, maxLength - 3)
  const headLength = Math.max(4, Math.floor(available * 0.45))
  const tailLength = Math.max(4, available - headLength)
  return `${text.slice(0, headLength)}...${text.slice(-tailLength)}`
}

// 统一的错误横幅: 与 ChatArea 同款 rounded-xl 红色 banner.
// 用于替换散落在 modals 各处的裸 text-red-400 段.
export function ErrBanner({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  if (!children) return null
  return (
    <div className={`mb-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-[12px] text-red-300 bg-red-500/10 border-red-500/25 ${className}`}>
      <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={1.75} />
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{children}</div>
    </div>
  )
}


// =====================================================================
// 路径选择器（限定家目录）
// =====================================================================
export function PathPickerModal({ initialPath, onClose, onPick }: { initialPath?: string; onClose: () => void; onPick: (absPath: string, relPath: string, manual?: boolean) => void }) {
  const { theme, user, token, setAuth } = useStore()
  const isDark = theme !== 'light'
  const [userHome, setUserHome] = useState(user?.work_dir || '')
  const toRel = (p: string, home = userHome): string => {
    if (!p) return '/'
    if (p === home) return '/'
    if (home && p.startsWith(home + '/')) return p.slice(home.length)
    if (p.startsWith('/')) return p
    return '/' + p
  }
  const [currentPath, setCurrentPath] = useState<string>('/')
  const [entries, setEntries] = useState<{ name: string; type: 'dir' | 'file' }[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createErr, setCreateErr] = useState('')
  // 手动输入路径: 绕过浏览, 直接键入绝对路径, 后端不校验存在性/位置/是否目录
  const [manualMode, setManualMode] = useState(false)
  const [manualPath, setManualPath] = useState('')
  const [manualErr, setManualErr] = useState('')
  const submitManual = () => {
    const p = manualPath.trim()
    if (!p) { setManualErr('请输入路径'); return }
    onPick(p, p, true)
  }

  const loadDir = useCallback(async (p: string) => {
    setLoading(true); setErr('')
    try {
      const data = await api(`/api/files?path=${encodeURIComponent(p)}`)
      setEntries((data.entries || []).filter((e: any) => e.type === 'dir'))
      setCurrentPath(data.path || p)
    } catch {
      setErr('读取目录失败')
      setEntries([])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    let alive = true
    const boot = async () => {
      let home = user?.work_dir || ''
      if (!home && token) {
        try {
          const me = await api('/api/auth/me')
          if (alive) {
            setAuth(token, me)
            home = me?.work_dir || ''
            setUserHome(home)
          }
        } catch {
          // loadDir 会展示可见错误, 这里不额外打断路径选择器.
        }
      } else {
        setUserHome(home)
      }
      if (alive) loadDir(toRel(initialPath || '/', home))
    }
    boot()
    return () => { alive = false }
  }, [initialPath, loadDir, setAuth, token, user?.work_dir])

  const breadcrumbs = currentPath.split('/').filter(Boolean)
  const absPath = currentPath === '/' ? (userHome || '~') : (userHome + currentPath)
  const goUp = () => {
    if (currentPath === '/') return
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/'
    loadDir(parent)
  }
  const enter = (name: string) => {
    const next = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`
    loadDir(next)
  }
  const submitCreate = async () => {
    const n = newName.trim()
    if (!n) { setCreateErr('请输入目录名'); return }
    if (n.includes('/') || n === '.' || n === '..') { setCreateErr('目录名不能包含 / 或为 . / ..'); return }
    const target = currentPath === '/' ? `/${n}` : `${currentPath}/${n}`
    setCreateErr('')
    try {
      const r = await api('/api/files/mkdir', { method: 'POST', body: JSON.stringify({ path: target }) })
      if (r?.error) { setCreateErr(r.error); return }
      setCreating(false); setNewName('')
      await loadDir(currentPath)
    } catch {
      setCreateErr('创建失败')
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-[560px] max-h-[70vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="px-5 py-3 border-b flex items-center gap-3" style={{ borderColor: 'var(--border-color)' }}>
          <svg className="w-4 h-4 text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span className="text-[14px] font-semibold flex-shrink-0" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>选择绑定路径</span>
          <div className="flex items-center gap-1 text-[12px] min-w-0 flex-1 overflow-hidden" style={{ color: 'var(--text-muted)' }}>
            <button onClick={() => loadDir('/')} className="hover:text-blue-400 transition-colors">~</button>
            {breadcrumbs.map((seg, i) => (
              <span key={i} className="flex items-center gap-1 min-w-0">
                <span style={{ color: 'var(--text-muted)' }}>/</span>
                <button onClick={() => loadDir('/' + breadcrumbs.slice(0, i + 1).join('/'))}
                  className="hover:text-blue-400 transition-colors truncate max-w-[120px]">{seg}</button>
              </span>
            ))}
          </div>
          <button onClick={() => { setManualMode(m => !m); setManualErr(''); if (!manualMode && !manualPath) setManualPath(absPath) }}
            className="flex-shrink-0 h-7 px-2 inline-flex items-center gap-1 rounded-xl text-[12px] border transition-colors"
            style={{
              color: manualMode ? '#fff' : 'var(--text-secondary)',
              background: manualMode ? '#3b82f6' : 'var(--bg-card-hover)',
              borderColor: manualMode ? '#3b82f6' : 'var(--input-border)',
            }}>
            <Pencil className="w-3 h-3" strokeWidth={1.75} />
            手动输入
          </button>
          <button onClick={() => { setCreating(true); setNewName(''); setCreateErr('') }}
            className="flex-shrink-0 h-7 px-2 rounded-xl text-[12px] bg-[var(--bg-card-hover)] hover:bg-[var(--bg-hover)] border transition-colors"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--input-border)' }}>
            + 新建子目录
          </button>
        </div>

        {manualMode && (
          <div className="px-5 py-3 border-b" style={{ borderColor: 'var(--border-color)', background: 'var(--input-bg)' }}>
            <div className="flex items-center gap-2">
              <input autoFocus value={manualPath}
                onChange={e => { setManualPath(e.target.value); setManualErr('') }}
                onKeyDown={e => { if (e.key === 'Enter') submitManual(); if (e.key === 'Escape') setManualMode(false) }}
                placeholder="绝对路径，如 /data/repos/foo"
                className="flex-1 h-8 px-3 rounded-xl text-[13px] border outline-none focus:border-blue-400"
                style={{ background: 'var(--modal-bg)', color: 'var(--text-primary)', borderColor: 'var(--input-border)' }} />
              <button onClick={submitManual}
                className="flex-shrink-0 h-8 px-3 rounded-xl text-[12px] btn-primary transition-colors">使用此路径</button>
            </div>
            <p className="text-[11px] mt-2 flex items-start gap-1.5" style={{ color: 'var(--text-muted)' }}>
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px text-amber-400" strokeWidth={1.75} />
              <span>手动输入的路径<strong>不做任何校验</strong>（不检查是否存在 / 是否目录 / 是否在工作目录内），请自行确认无误。</span>
            </p>
            {manualErr && <span className="text-[11px] text-red-400">{manualErr}</span>}
          </div>
        )}

        {creating && (
          <div className="px-5 py-3 border-b flex items-center gap-2" style={{ borderColor: 'var(--border-color)', background: 'var(--input-bg)' }}>
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitCreate(); if (e.key === 'Escape') setCreating(false) }}
              placeholder="新目录名"
              className="flex-1 h-8 px-3 rounded-xl text-[13px] border outline-none focus:border-blue-400"
              style={{ background: 'var(--modal-bg)', color: 'var(--text-primary)', borderColor: 'var(--input-border)' }} />
            <button onClick={submitCreate}
              className="h-8 px-3 rounded-xl text-[12px] btn-primary transition-colors">创建</button>
            <button onClick={() => setCreating(false)}
              className="h-8 px-3 rounded-xl text-[12px] bg-[var(--bg-card-hover)] border"
              style={{ color: 'var(--text-secondary)', borderColor: 'var(--input-border)' }}>取消</button>
            {createErr && <span className="text-[11px] text-red-400 ml-1">{createErr}</span>}
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-[260px]">
          {currentPath !== '/' && (
            <button onClick={goUp} className="w-full flex items-center gap-3 px-5 py-2 hover:bg-[var(--bg-card-hover)] transition-colors text-left" style={{ color: 'var(--text-muted)' }}>
              <FolderOpen className="w-4 h-4 flex-shrink-0" strokeWidth={1.75} />
              <span className="text-[13px]">..</span>
            </button>
          )}
          {loading ? (
            <div className="text-center text-[13px] py-8" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          ) : err ? (
            <div className="text-center text-[13px] py-8 text-red-400">{err}</div>
          ) : entries.length === 0 ? (
            <div className="text-center text-[13px] py-8 px-6 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              此目录下没有子目录，可点击下方「选择此目录」绑定当前目录，或点上方「新建子目录」创建一个。
            </div>
          ) : entries.map(entry => (
            <button key={entry.name} onClick={() => enter(entry.name)}
              className="w-full flex items-center gap-3 px-5 py-2 hover:bg-[var(--bg-card-hover)] transition-colors text-left">
              <Folder className="w-4 h-4 flex-shrink-0" strokeWidth={1.75} style={{ color: 'var(--text-muted)' }} />
              <span className="text-[13px] truncate flex-1" style={{ color: isDark ? '#d1d5db' : '#374151' }}>{entry.name}</span>
            </button>
          ))}
        </div>

        <div className="px-5 py-3 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex-1 text-[11px] truncate" style={{ color: 'var(--text-muted)' }} title={absPath}>
            将选择：<span style={{ color: 'var(--text-primary)' }}>{absPath}</span>
          </div>
          <button onClick={onClose} className="h-8 px-3 rounded-xl text-[12px] bg-[var(--bg-card-hover)] border" style={{ color: 'var(--text-secondary)', borderColor: 'var(--input-border)' }}>取消</button>
          <button onClick={() => {
              const abs = currentPath === '/' ? userHome : (userHome + currentPath)
              onPick(abs, currentPath, false)
            }}
            className="h-8 px-3 rounded-xl text-[12px] btn-primary transition-colors">
            选择此目录
          </button>
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// 新建 Project
// =====================================================================
export function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (p: any) => void }) {
  const DRAFT_KEY = 'new-project'
  const { theme, user } = useStore()
  const initialDraft = draftLoad<{
    name?: string
    desc?: string
    bindPath?: string
    bindPathManual?: boolean
    defaultUseWorktree?: boolean
    researchEnabled?: boolean
    visibility?: ProjectVisibility
    projectKind?: NewProjectKind
    extensionName?: string
    canPostIssue?: boolean
    canRunSession?: boolean
  }>(DRAFT_KEY)
  const guidedDemo = readActiveGuidedDemo()
  const guidedDemoState = guidedDemo?.state
  const isGuidedDemo = !!guidedDemoState?.active && !guidedDemoState.projectId
  const [name, setName] = useState(isGuidedDemo ? (guidedDemoState?.projectName || '') : (initialDraft?.name || ''))
  const [desc, setDesc] = useState(isGuidedDemo ? (guidedDemoState?.projectDescription || '') : (initialDraft?.desc || ''))
  const initialBindPathFromDraft = !isGuidedDemo && initialDraft?.bindPath?.trim() ? (initialDraft.bindPath || '') : ''
  const [bindPath, setBindPath] = useState(
    isGuidedDemo
      ? (guidedDemoState?.projectRelPath || '')
      : (initialBindPathFromDraft || randomProjectBindPath(user?.work_dir))
  )
  const [bindPathSource, setBindPathSource] = useState<'auto' | 'custom'>(
    isGuidedDemo || initialBindPathFromDraft ? 'custom' : 'auto'
  )
  const [bindPathManual, setBindPathManual] = useState(isGuidedDemo ? false : !!initialDraft?.bindPathManual)
  const [defaultUseWorktree, setDefaultUseWorktree] = useState(isGuidedDemo ? false : (typeof initialDraft?.defaultUseWorktree === 'boolean' ? initialDraft.defaultUseWorktree : false))
  const [researchEnabled, setResearchEnabled] = useState(isGuidedDemo ? false : !!initialDraft?.researchEnabled)
  const [visibility, setVisibility] = useState<ProjectVisibility>(
    initialDraft?.visibility === 'team' || initialDraft?.visibility === 'public' || initialDraft?.visibility === 'allowlist'
      ? initialDraft.visibility
      : 'private'
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const initialKind = isGuidedDemo
    ? 'default'
    : (initialDraft?.projectKind === 'research' || initialDraft?.projectKind === 'extension' ? initialDraft.projectKind : 'default')
  const canCreateExtensionProject = user?.role === 'admin'
  const initialProjectKind: NewProjectKind = canCreateExtensionProject || initialKind !== 'extension' ? initialKind : 'default'
  const initialDraftHasContent = !!(
    initialDraft?.name?.trim()
    || initialDraft?.desc?.trim()
    || initialDraft?.bindPath?.trim()
    || initialDraft?.extensionName?.trim()
  )
  const [projectKind, setProjectKind] = useState<NewProjectKind>(initialProjectKind)
  const [step, setStep] = useState<'type' | 'details'>(isGuidedDemo || initialDraftHasContent ? 'details' : 'type')
  const [extensionName, setExtensionName] = useState(initialDraft?.extensionName || '')
  // v3 写权限: 默认关闭, 与后端 schema 默认一致; private 项目这两个开关无效, 但允许 owner 主动打开.
  const [canPostIssue, setCanPostIssue] = useState<boolean>(!!initialDraft?.canPostIssue)
  const [canRunSession, setCanRunSession] = useState<boolean>(!!initialDraft?.canRunSession)

  useEffect(() => {
    if (isGuidedDemo || projectKind === 'extension' || bindPathSource !== 'auto') return
    if (bindPath.trim() || !user?.work_dir) return
    setBindPath(randomProjectBindPath(user.work_dir))
    setBindPathManual(false)
  }, [bindPath, bindPathSource, isGuidedDemo, projectKind, user?.work_dir])

  useEffect(() => {
    if (isGuidedDemo) return
    const hasDraftContent = !!(name.trim() || desc.trim() || extensionName.trim() || (bindPath.trim() && bindPathSource === 'custom'))
    if (hasDraftContent) {
      draftSave(DRAFT_KEY, { name, desc, bindPath, bindPathManual, defaultUseWorktree, researchEnabled, visibility, projectKind, extensionName, canPostIssue, canRunSession }, { minChars: 0 })
    } else {
      draftClear(DRAFT_KEY)
    }
  }, [isGuidedDemo, name, desc, bindPath, bindPathSource, bindPathManual, defaultUseWorktree, researchEnabled, visibility, projectKind, extensionName, canPostIssue, canRunSession])

  const refreshRandomBindPath = () => {
    let next = randomProjectBindPath(user?.work_dir)
    if (!next) {
      setErr('当前用户尚未配置工作目录，无法生成随机绑定路径')
      return
    }
    for (let i = 0; i < 5 && next === bindPath; i += 1) next = randomProjectBindPath(user?.work_dir)
    setBindPath(next)
    setBindPathManual(false)
    setBindPathSource('auto')
    setErr('')
  }

  const chooseProjectKind = (kind: NewProjectKind) => {
    if (kind === 'extension' && !canCreateExtensionProject) return
    setProjectKind(kind)
    setErr('')
    if (kind === 'default') {
      setResearchEnabled(false)
      setDefaultUseWorktree(false)
      setExtensionName('')
    } else if (kind === 'research') {
      setResearchEnabled(true)
      setDefaultUseWorktree(false)
      setExtensionName('')
    }
    setStep('details')
  }

  const submit = async () => {
    if (!name.trim()) { setErr('请输入项目名称'); return }
    if (projectKind === 'extension') {
      if (!canCreateExtensionProject) { setErr('只有管理员可以创建莫比乌斯拓展项目'); return }
      if (!extensionName.trim()) { setErr('请输入拓展标识名'); return }
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(extensionName.trim())) { setErr('拓展标识名格式：以小写字母开头，可包含小写字母、数字和连字符，1-32字符'); return }
    } else {
      if (!bindPath.trim()) { setErr('请选择项目绑定路径 (必填)'); return }
    }
    setLoading(true); setErr('')
    try {
      const effectiveWt = researchEnabled ? false : defaultUseWorktree
      const body: any = {
        name,
        description: desc,
        visibility,
        guidedDemoKind: isGuidedDemo ? guidedDemo?.kind : undefined,
      }
      if (projectKind === 'extension') {
        body.kind = 'extension'
        body.extensionName = extensionName.trim()
      } else {
        body.can_post_issue = canPostIssue
        body.can_run_session = canRunSession
        body.bindPath = bindPath
        body.bindPathManual = bindPathManual
        body.defaultUseWorktree = effectiveWt
        body.researchEnabled = projectKind === 'research' ? true : researchEnabled
      }
      const p = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if ((p as any)?.error) { setErr((p as any).error); return }
      draftClear(DRAFT_KEY)
      if (isGuidedDemo && guidedDemo && p?.id) {
        const patch: any = { projectId: p.id }
        if (guidedDemo.kind === 'context-setup' && p?.guided_demo_assets?.ok) {
          patch.preparedAt = Date.now()
          if (p.guided_demo_assets.memory_material) patch.memoryMaterialRelPath = p.guided_demo_assets.memory_material
          if (p.guided_demo_assets.skill_material_file) patch.skillMaterialRelPath = p.guided_demo_assets.skill_material_file
          if (p.guided_demo_assets.materials_zip) patch.materialsZipRelPath = p.guided_demo_assets.materials_zip
        } else if (guidedDemo.kind === 'project-import' && p?.guided_demo_assets?.ok) {
          patch.preparedAt = Date.now()
          if (p.guided_demo_assets.upload_sample_dir) patch.uploadSampleDirRelPath = p.guided_demo_assets.upload_sample_dir
          if (p.guided_demo_assets.upload_sample_zip) patch.uploadSampleZipRelPath = p.guided_demo_assets.upload_sample_zip
        }
        patchGuidedDemoState(guidedDemo.kind, patch)
      }
      onCreated(p)
    } catch (e: any) { setErr(e?.message || '创建失败') } finally { setLoading(false) }
  }

  const visibilityOption = PROJECT_VISIBILITY_OPTIONS.find(option => option.value === visibility) || PROJECT_VISIBILITY_OPTIONS[0]
  const writablePermissions = Number(!!canPostIssue) + Number(!!canRunSession)
  const permissionDetail = projectKind === 'extension'
    ? '拓展项目仅设置可见范围'
    : visibility === 'private'
      ? '仅创建者可写'
      : writablePermissions === 2
        ? '读者可建任务单和执行会话'
        : canPostIssue
          ? '读者可建任务单'
          : canRunSession
            ? '读者可执行会话'
            : '读者不可写'
  const bindPathDisplay = middleEllipsisPath(bindPath, 70)

  const visibilityControl = (
    <div>
      <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>项目可见性</label>
      <div className="grid grid-cols-2 gap-1.5">
        {PROJECT_VISIBILITY_OPTIONS.map((option) => {
          const active = visibility === option.value
          return (
            <button key={option.value} type="button" onClick={() => setVisibility(option.value)}
              title={option.description}
              className="h-8 rounded-lg border text-[12px] transition-colors"
              style={active
                ? { background: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.48)', color: '#60a5fa' }
                : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
              {option.label}
            </button>
          )
        })}
      </div>
      <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
        {visibilityOption.description}
      </p>
      {projectKind === 'extension' ? (
        <p className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>
          拓展项目的写权限由系统管理；这里仅设置谁能看到这个项目。
        </p>
      ) : (
        <div className="mt-2 space-y-1.5">
          <ToggleSwitch
            checked={canPostIssue}
            onChange={v => { setCanPostIssue(v); setErr('') }}
            className="flex items-center gap-3 text-[12px]"
            style={{ color: 'var(--text-secondary)' }}>
            读者可创建任务单 (private 永远只允许 owner, 不受此开关影响)
          </ToggleSwitch>
          <ToggleSwitch
            checked={canRunSession}
            onChange={v => { setCanRunSession(v); setErr('') }}
            className="flex items-center gap-3 text-[12px]"
            style={{ color: 'var(--text-secondary)' }}>
            读者可启动执行会话 (同上, private 永远只允许 owner)
          </ToggleSwitch>
        </div>
      )}
    </div>
  )

  const permissionSettingsModal = permissionOpen ? (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={() => setPermissionOpen(false)} />
      <div className="relative w-[420px] max-w-[calc(100vw-32px)] rounded-2xl p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h4 className="text-[15px] font-semibold mb-1" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>修改项目权限</h4>
        <p className="mb-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>设置谁能看到项目，以及读者是否可以创建任务单或启动执行会话。</p>
        {visibilityControl}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={() => setPermissionOpen(false)}
            className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors">
            完成
          </button>
        </div>
      </div>
    </div>
  ) : null

  const projectKindOptions: Array<{
    kind: NewProjectKind
    label: string
    description: string
    note: string
    icon: React.ReactNode
  }> = [
    {
      kind: 'default',
      label: '经典项目（推荐）',
      description: '导入或新建一个项目，后续可以随时转化为 Research 项目。',
      note: '默认不启动 Research 系统',
      icon: <FolderPlus className="h-5 w-5" strokeWidth={1.8} />,
    },
    {
      kind: 'research',
      label: 'Research 项目',
      description: '通过多智能体协作完成需要持续整夜甚至数周的开放研究任务。',
      note: '自动启用 Research，并禁用 git worktree',
      icon: <FlaskConical className="h-5 w-5" strokeWidth={1.8} />,
    },
    {
      kind: 'extension',
      label: '莫比乌斯拓展项目',
      description: '创建一个有漂亮前端+后端的拓展项目，满足您的任何需求。',
      note: canCreateExtensionProject ? '能直接在本系统主页打开的特殊拓展项目，内嵌到本系统之中' : '仅管理员可创建',
      icon: <Puzzle className="h-5 w-5" strokeWidth={1.8} />,
    },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div data-tour="project-modal" className="relative w-[575px] max-w-[calc(100vw-32px)] rounded-2xl p-6 shadow-2xl" style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        {step === 'type' ? (
          <>
            <h3 className="text-[15px] font-semibold mb-1" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>选择项目类型</h3>
            <p className="mb-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>先选择本次要创建的项目类型，下一步再填写细节。</p>
            <div className="space-y-2.5">
              {projectKindOptions.map(opt => {
                const disabled = opt.kind === 'extension' && !canCreateExtensionProject
                return (
                  <button
                    key={opt.kind}
                    type="button"
                    disabled={disabled}
                    onClick={() => chooseProjectKind(opt.kind)}
                    data-tour={`project-kind-${opt.kind}`}
                    className="flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                    style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}>
                    <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border"
                      style={{ color: opt.kind === 'research' ? '#34d399' : opt.kind === 'extension' ? '#a78bfa' : '#60a5fa', borderColor: 'var(--input-border)', background: 'rgba(255,255,255,0.03)' }}>
                      {opt.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold">{opt.label}</span>
                      <span className="mt-0.5 block text-[12px] leading-5" style={{ color: 'var(--text-secondary)' }}>{opt.description}</span>
                      <span className="mt-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>{opt.note}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            {err && <ErrBanner className="mt-4">{err}</ErrBanner>}
            <div className="mt-5 flex gap-2">
              <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-2">
              {!isGuidedDemo && (
                <button type="button" onClick={() => { setErr(''); setStep('type') }}
                  title="返回选择项目类型"
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border bg-[var(--bg-card-hover)]"
                  style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                  <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
                </button>
              )}
              <div className="min-w-0">
                <h3 className="text-[15px] font-semibold" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>新建{NEW_PROJECT_KIND_LABELS[projectKind]}</h3>
                <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {projectKind === 'default'
                    ? '经典项目默认不启动 Research 系统。'
                    : projectKind === 'research'
                      ? 'Research 项目会自动启用 Research，并禁用 git worktree。'
                      : '拓展项目会创建 mobius/extension 下的可加载拓展骨架。'}
                </p>
              </div>
            </div>
            <div className="space-y-3 mb-4">
              <input autoFocus value={name} onChange={e => { setName(e.target.value); setErr('') }}
                data-tour="project-name-input"
                placeholder="项目名称" onKeyDown={e => e.key === 'Enter' && submit()}
                className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
              <ExpandableTextarea value={desc} onValueChange={setDesc}
                placeholder="项目描述（选填）"
                overlayTitle="编辑项目描述"
                className="w-full h-20 px-3 py-2 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30 resize-none"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
              {projectKind === 'extension' ? (
                <div>
                  <input value={extensionName} onChange={e => { setExtensionName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); setErr('') }}
                    placeholder="拓展标识名，如 my-awesome-ext"
                    maxLength={32}
                    className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
                  <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>小写字母开头，可含小写字母、数字和连字符，1-32字符。</p>
                </div>
              ) : (
                <>
                  <p className="text-[11px] -mt-1" style={{ color: 'var(--text-muted)' }}>
                    您希望把项目放置于什么位置？
                    {bindPathManual
                      ? <span className="text-amber-400"> · 手动输入路径</span>
                      : <span> · 自动创建目录</span>}
                  </p>
                  <div className="flex items-center gap-2">
                    <input value={bindPathDisplay} readOnly placeholder="绑定路径（必填，限家目录下）"
                      data-tour="project-path-input"
                      title={bindPath}
                      aria-label={bindPath ? `绑定路径：${bindPath}` : '绑定路径'}
                      className="flex-1 h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none cursor-pointer"
                      onClick={() => setPickerOpen(true)}
                      style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
                    <button type="button" onClick={() => setPickerOpen(true)}
                      data-tour="project-path-picker"
                      className="h-10 px-3 rounded-xl text-[12px] bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors border border-blue-500/20 flex items-center gap-1.5">
                      <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.8} />
                      选择路径
                    </button>
                    <button type="button" onClick={refreshRandomBindPath}
                      title="换一个随机路径名"
                      aria-label="换一个随机路径名"
                      className="h-10 w-10 flex-shrink-0 rounded-xl text-blue-400 bg-blue-500/15 hover:bg-blue-500/25 transition-colors border border-blue-500/20 inline-flex items-center justify-center">
                      <Dices className="h-4 w-4" strokeWidth={1.8} />
                    </button>
                  </div>

                  <ToggleSwitch
                    data-tour="project-worktree-toggle"
                    checked={!researchEnabled && defaultUseWorktree}
                    disabled={researchEnabled}
                    onChange={setDefaultUseWorktree}
                    className="flex items-center gap-3 text-[13px]"
                    style={{ color: theme !== 'light' ? '#cbd5e1' : '#334155' }}>
                    默认使用 git worktree（新建 Issue 时该选项默认打钩）
                  </ToggleSwitch>
                  {researchEnabled && (
                    <p className="text-[11px] -mt-1" style={{ color: 'var(--text-muted)' }}>已启用 Research 系统，本项目强制禁用 worktree</p>
                  )}
                  {projectKind === 'default' && (
                    <ToggleSwitch
                      data-tour="project-research-toggle"
                      checked={researchEnabled}
                      onChange={enabled => {
                        setResearchEnabled(enabled)
                        if (enabled) setDefaultUseWorktree(false)
                      }}
                      className="flex items-center gap-3 text-[13px]"
                      style={{ color: theme !== 'light' ? '#cbd5e1' : '#334155' }}>
                      启用 Research 系统（默认关闭，开启后自动禁用 git worktree）
                    </ToggleSwitch>
                  )}
                </>
              )}
              <button type="button" onClick={() => setPermissionOpen(true)}
                data-tour="project-visibility"
                className="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-card-hover)]"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)' }}>
                <Eye className="h-4 w-4 flex-shrink-0 text-blue-400" strokeWidth={1.75} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium" style={{ color: theme !== 'light' ? '#cbd5e1' : '#334155' }}>修改项目权限</span>
                  <span className="mt-0.5 block truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {visibilityOption.label} · {permissionDetail}
                  </span>
                </span>
                <span className="flex-shrink-0 text-[11px]" style={{ color: '#60a5fa' }}>修改</span>
              </button>
            </div>
            {err && <ErrBanner>{err}</ErrBanner>}
            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
              <button onClick={submit} disabled={loading}
                data-tour="project-submit"
                className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors disabled:opacity-40">
                {loading ? '创建中...' : '创建'}
              </button>
            </div>
          </>
        )}
      </div>
      {permissionSettingsModal}
      {pickerOpen && projectKind !== 'extension' && <PathPickerModal initialPath={bindPath} onClose={() => setPickerOpen(false)} onPick={(abs, _rel, manual) => { setBindPath(abs); setBindPathManual(!!manual); setBindPathSource('custom'); setPickerOpen(false) }} />}
    </div>
  )
}

// =====================================================================
// 项目设置（修改名称/描述/绑定路径）
// =====================================================================
export function ProjectSettingsModal({ project, onClose, onSaved }: { project: any; onClose: () => void; onSaved: (p: any) => void }) {
  const [name, setName] = useState(project.name)
  const [desc, setDesc] = useState(project.description || '')
  const [bindPath, setBindPath] = useState<string>(project.bind_path || '')
  // 从持久化标记还原: 若该路径当初是手动输入(不校验)的, 重开设置时仍按手动对待,
  // 否则一旦重新提交就会走严格校验把 work_dir 外的路径静默回撤.
  const [bindPathManual, setBindPathManual] = useState(!!project.bind_path_manual)
  const [defaultUseWorktree, setDefaultUseWorktree] = useState(!!project.default_use_worktree)
  const [researchEnabled, setResearchEnabled] = useState(!!project.research_enabled)
  const [visibility, setVisibility] = useState<ProjectVisibility>(
    project.visibility === 'team' || project.visibility === 'public' || project.visibility === 'allowlist' ? project.visibility : 'private'
  )
  // v3 写权限: 读权限打开的项目默认 false; 用户在设置里打开 can_post_issue / can_run_session 后,
  // 同组 (team) 或任意读者 (public) 才能创建任务单 / 触发 Session.
  const [canPostIssue, setCanPostIssue] = useState<boolean>(!!project.can_post_issue)
  const [canRunSession, setCanRunSession] = useState<boolean>(!!project.can_run_session)
  const [forgottenFlagMessage, setForgottenFlagMessage] = useState<string>(project.forgotten_flag_message_effective ?? (project.forgotten_flag_message || ''))
  const [forgottenFlagIssueInit, setForgottenFlagIssueInit] = useState<string>(
    intervalInputValue(project.forgotten_flag_issue_init_minutes ?? project.forgotten_flag_issue_interval_minutes, DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES)
  )
  const [forgottenFlagIssueBackoff, setForgottenFlagIssueBackoff] = useState<string>(
    numberInputValue(project.forgotten_flag_issue_backoff, DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF)
  )
  const [forgottenFlagIssuePatience, setForgottenFlagIssuePatience] = useState<string>(
    intervalInputValue(project.forgotten_flag_issue_patience, DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE)
  )
  const [forgottenFlagResearchInit, setForgottenFlagResearchInit] = useState<string>(
    intervalInputValue(project.forgotten_flag_research_init_minutes ?? project.forgotten_flag_research_interval_minutes, DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES)
  )
  const [forgottenFlagResearchBackoff, setForgottenFlagResearchBackoff] = useState<string>(
    numberInputValue(project.forgotten_flag_research_backoff, DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF)
  )
  const [forgottenFlagResearchPatience, setForgottenFlagResearchPatience] = useState<string>(
    intervalInputValue(project.forgotten_flag_research_patience, DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE)
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const { theme } = useStore()
  const submit = async () => {
    if (!name.trim()) { setErr('请输入项目名称'); return }
    if (!bindPath.trim()) { setErr('绑定路径不能为空 (必填)'); return }
    let issueInit: number
    let issueBackoff: number
    let issuePatience: number
    let researchInit: number
    let researchBackoff: number
    let researchPatience: number
    try {
      issueInit = parseIntervalInput(forgottenFlagIssueInit, 'Issue Session Init', 1)
      issueBackoff = parseBackoffInput(forgottenFlagIssueBackoff, 'Issue Session Backoff')
      issuePatience = parsePatienceInput(forgottenFlagIssuePatience, 'Issue Session Patience')
      researchInit = parseIntervalInput(forgottenFlagResearchInit, 'Research Agent Init', 30)
      researchBackoff = parseBackoffInput(forgottenFlagResearchBackoff, 'Research Agent Backoff')
      researchPatience = parsePatienceInput(forgottenFlagResearchPatience, 'Research Agent Patience')
    } catch (e: any) {
      setErr(e?.message || '提醒策略格式错误')
      return
    }
    setLoading(true); setErr('')
    try {
      const body: any = {
        name,
        description: desc,
        visibility,
        can_post_issue: canPostIssue,
        can_run_session: canRunSession,
        // 项目级规则: Research 启用时强制禁用 worktree (后端也会兜底强制)
        defaultUseWorktree: researchEnabled ? false : defaultUseWorktree,
        researchEnabled,
        forgottenFlagMessage,
        forgottenFlagIssueInitMinutes: issueInit,
        forgottenFlagIssueBackoff: issueBackoff,
        forgottenFlagIssuePatience: issuePatience,
        forgottenFlagResearchInitMinutes: researchInit,
        forgottenFlagResearchBackoff: researchBackoff,
        forgottenFlagResearchPatience: researchPatience,
      }
      // 仅在路径实际变化时提交, 避免对已存在的(可能是手动设定/work_dir 外)路径
      // 重新做严格校验, 把它静默回撤 (与 ProjectPage.saveMeta 行为一致).
      if (bindPath !== (project.bind_path || '')) {
        body.bindPath = bindPath
        body.bindPathManual = bindPathManual
      }
      const updated = await api(`/api/projects/${project.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      if ((updated as any)?.error) { setErr((updated as any).error); return }
      onSaved(updated)
    } catch { setErr('保存失败') } finally { setLoading(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-[640px] max-h-[85vh] rounded-2xl p-6 shadow-2xl flex flex-col" onClick={e => e.stopPropagation()} style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="text-[15px] font-semibold mb-5 flex-shrink-0" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>项目设置</h3>
        <div className="space-y-3 mb-4 overflow-y-auto pr-1 flex-1">
          <div>
            <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>项目名称</label>
            <input autoFocus value={name} onChange={e => { setName(e.target.value); setErr('') }}
              placeholder="项目名称" onKeyDown={e => e.key === 'Enter' && submit()}
              className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
          </div>
          <div>
            <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>项目描述</label>
            <ExpandableTextarea value={desc} onValueChange={setDesc}
              placeholder="项目描述（选填）"
              overlayTitle="编辑项目描述"
              className="w-full h-20 px-3 py-2 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30 resize-none"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
          </div>
          <div>
            <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>绑定路径</label>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>项目文件路径 & 工作目录</p>
            <div className="flex items-center gap-2">
              <input value={bindPath} readOnly placeholder="必填（限家目录下）"
                className="flex-1 h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none cursor-pointer"
                onClick={() => setPickerOpen(true)}
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
              <button type="button" onClick={() => setPickerOpen(true)}
                className="h-10 px-3 rounded-xl text-[12px] bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors border border-blue-500/20 flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                选择路径
              </button>
            </div>
          </div>
          <div>
            <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>项目可见性</label>
            <div className="grid grid-cols-2 gap-1.5">
              {PROJECT_VISIBILITY_OPTIONS.map((option) => {
                const active = visibility === option.value
                return (
                  <button key={option.value} type="button" onClick={() => { setVisibility(option.value); setErr('') }}
                    title={option.description}
                    className="h-8 rounded-lg border text-[12px] transition-colors"
                    style={active
                      ? { background: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.48)', color: '#60a5fa' }
                      : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
                    {option.label}
                  </button>
                )
              })}
            </div>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {PROJECT_VISIBILITY_OPTIONS.find(option => option.value === visibility)?.description}
            </p>
            <div className="mt-2 space-y-1.5">
              <ToggleSwitch
                checked={canPostIssue}
                onChange={v => { setCanPostIssue(v); setErr('') }}
                className="flex items-center gap-3 text-[12px]"
                style={{ color: 'var(--text-secondary)' }}>
                读者可创建任务单 (private 永远只允许 owner, 不受此开关影响)
              </ToggleSwitch>
              <ToggleSwitch
                checked={canRunSession}
                onChange={v => { setCanRunSession(v); setErr('') }}
                className="flex items-center gap-3 text-[12px]"
                style={{ color: 'var(--text-secondary)' }}>
                读者可启动执行会话 (同上, private 永远只允许 owner)
              </ToggleSwitch>
            </div>
          </div>
          <div>
            <ToggleSwitch
              checked={!researchEnabled && defaultUseWorktree}
              disabled={researchEnabled}
              onChange={v => { setDefaultUseWorktree(v); setErr('') }}
              className="flex items-center gap-3 text-[13px]"
              style={{ color: theme !== 'light' ? '#cbd5e1' : '#334155' }}>
              默认使用 git worktree
            </ToggleSwitch>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {researchEnabled
                ? '已启用 Research 系统，本项目强制禁用 worktree'
                : '开启后，本项目新建 Issue 时「使用 git worktree」默认打钩，否则默认不打钩'}
            </p>
          </div>
          <div>
            <ToggleSwitch
              checked={researchEnabled}
              onChange={v => { setResearchEnabled(v); setErr('') }}
              className="flex items-center gap-3 text-[13px]"
              style={{ color: theme !== 'light' ? '#cbd5e1' : '#334155' }}>
              启用 Research 系统
            </ToggleSwitch>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>开启后，本项目会显示 Research 入口；Research 与 Issues 并列管理。启用时会自动禁用 git worktree</p>
          </div>
          <div>
            <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>被遗忘 running.flag 提醒消息</label>
            <ExpandableTextarea value={forgottenFlagMessage} onValueChange={value => { setForgottenFlagMessage(value); setErr('') }}
              overlayTitle="编辑 running.flag 提醒消息"
              className="w-full h-28 px-3 py-2 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30 resize-none"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>后台每 60s 巡检，若某会话 agent 已停工但 running.flag 未删除，自动向该会话发送此消息。已自动填入系统默认文案，可直接修改保存；若清空保存则恢复使用系统默认文案</p>
          </div>
          <div>
            <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>被遗忘 running.flag 提醒策略</label>
            <div className="space-y-3">
              <div>
                <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>Issue Session</div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Init（分钟）</div>
                    <input type="number" min={1} max={FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX} step={1}
                      value={forgottenFlagIssueInit}
                      onChange={e => { setForgottenFlagIssueInit(e.target.value); setErr('') }}
                      className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                      style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
                  </div>
                  <div>
                    <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Backoff（倍数）</div>
                    <input type="number" min={1} max={FORGOTTEN_FLAG_BACKOFF_MAX} step={0.01}
                      value={forgottenFlagIssueBackoff}
                      onChange={e => { setForgottenFlagIssueBackoff(e.target.value); setErr('') }}
                      className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                      style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
                  </div>
                  <div>
                    <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Patience（次数）</div>
                    <input type="number" min={1} max={FORGOTTEN_FLAG_PATIENCE_MAX} step={1}
                      value={forgottenFlagIssuePatience}
                      onChange={e => { setForgottenFlagIssuePatience(e.target.value); setErr('') }}
                      className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                      style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
                  </div>
                </div>
              </div>
              <div>
                <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>Research Agent</div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Init（分钟）</div>
                    <input type="number" min={30} max={FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX} step={1}
                      value={forgottenFlagResearchInit}
                      onChange={e => { setForgottenFlagResearchInit(e.target.value); setErr('') }}
                      className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                      style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
                  </div>
                  <div>
                    <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Backoff（倍数）</div>
                    <input type="number" min={1} max={FORGOTTEN_FLAG_BACKOFF_MAX} step={0.01}
                      value={forgottenFlagResearchBackoff}
                      onChange={e => { setForgottenFlagResearchBackoff(e.target.value); setErr('') }}
                      className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                      style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
                  </div>
                  <div>
                    <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Patience（次数）</div>
                    <input type="number" min={1} max={FORGOTTEN_FLAG_PATIENCE_MAX} step={1}
                      value={forgottenFlagResearchPatience}
                      onChange={e => { setForgottenFlagResearchPatience(e.target.value); setErr('') }}
                      className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                      style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
                  </div>
                </div>
              </div>
            </div>
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>默认 Issue: 10 / 2 / 3；Research: 30 / 5 / 5。达到 Patience 后只记录日志，不改状态。</p>
          </div>

          <div className="pt-2">
            <ProjectUserContextWhitelist projectId={project.id} />
          </div>
          <div className="pt-2">
            <SkillsManager scope="project" projectId={project.id} />
          </div>
          <div className="pt-2">
            <MemoriesManager scope="project" projectId={project.id} />
          </div>
        </div>
        {err && <ErrBanner>{err}</ErrBanner>}
        <div className="flex gap-2 flex-shrink-0">
          <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
          <button onClick={submit} disabled={loading}
            className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors disabled:opacity-40">
            {loading ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
      {pickerOpen && <PathPickerModal initialPath={bindPath} onClose={() => setPickerOpen(false)} onPick={(abs, _rel, manual) => { setBindPath(abs); setBindPathManual(!!manual); setPickerOpen(false) }} />}
    </div>
  )
}

// =====================================================================
// 删除 Project（创建者 + 多重确认 + 密码）
// =====================================================================
export function DeleteProjectModal({ project, onClose, onDeleted }: { project: any; onClose: () => void; onDeleted: () => void }) {
  const [confirmName, setConfirmName] = useState('')
  const [dangerAcknowledged, setDangerAcknowledged] = useState(false)
  const [password, setPassword] = useState('')
  const [passwordRequired, setPasswordRequired] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const { theme } = useStore()
  const isFixedLogoReviewProject = project.id === LOGO_REVIEW_PROJECT_ID
  const accepted = new Set([project.name, project.id].filter(Boolean).map(String))
  const confirmValue = confirmName.trim()
  const canSubmit = !isFixedLogoReviewProject && accepted.has(confirmValue) && dangerAcknowledged && (!passwordRequired || !!password)

  useEffect(() => {
    let alive = true
    api('/api/auth/config')
      .then((cfg: any) => { if (alive) setPasswordRequired(!!cfg?.password_required) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const submit = async () => {
    if (isFixedLogoReviewProject) {
      setErr('这个项目是引导系统固定完成案例，用于“验收完成案例”路线，不能删除。其他同名临时演示项目仍可删除。')
      return
    }
    if (!accepted.has(confirmValue)) { setErr('请输入项目名或项目 ID 确认'); return }
    if (!dangerAcknowledged) { setErr('请勾选不可恢复确认'); return }
    if (passwordRequired && !password) { setErr('请输入密码'); return }
    setLoading(true); setErr('')
    try {
      const demo = readActiveGuidedDemo()
      const logoReviewDemo = demo?.kind === 'logo-review' ? readLogoReviewDemoState() : null
      const cleanupProjectId = logoReviewDemo?.cleanupProjectId || demo?.state.projectId
      const cleanupProjectRelPath = logoReviewDemo?.cleanupProjectRelPath || demo?.state.projectRelPath
      const cleanupDemoWorkspace = !!demo?.state.active
        && cleanupProjectId === project.id
        && (cleanupProjectRelPath || '').startsWith('/imac-demo/')
      await api(`/api/projects/${project.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: confirmValue, password, cleanup_demo_workspace: cleanupDemoWorkspace }),
      })
      completeGuidedDemoStateForProject(project.id)
      onDeleted()
    } catch (e: any) { setErr(e?.message || '确认信息错误或权限不足') } finally { setLoading(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div data-tour="delete-project-modal" className="relative w-[360px] max-w-[calc(100vw-32px)] rounded-2xl p-6 shadow-2xl" onClick={e => e.stopPropagation()} style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="text-[15px] font-semibold mb-2" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>删除项目</h3>
        <p className="text-[13px] mb-4" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b' }}>
          确定删除项目「<strong>{project.name}</strong>」？此操作不可恢复。请完成下面的多重确认。
        </p>
        <div className="mb-4 flex gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px]"
          style={{ color: theme !== 'light' ? '#fca5a5' : '#b91c1c' }}>
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.75} />
          <div className="min-w-0">
            {isFixedLogoReviewProject
              ? '这个项目是“验收完成案例”路线使用的固定完成案例，不能删除。其他同名临时演示项目仍可删除。'
              : '删除会移除该项目及其 Issue、Session 记录，删除后不能从回收站恢复。'}
          </div>
        </div>
        <div className="space-y-3 mb-4">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium" style={{ color: theme !== 'light' ? '#cbd5e1' : '#475569' }}>
              确认 1：输入项目名或项目 ID
            </span>
            <input autoFocus value={confirmName} onChange={e => { setConfirmName(e.target.value); setErr('') }}
              data-tour="delete-project-confirm-input"
              placeholder={project.name || project.id}
              onKeyDown={e => e.key === 'Enter' && submit()}
              className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
          </label>
          <label data-tour="delete-project-final-confirm" className="flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-[12px]"
            style={{ borderColor: dangerAcknowledged ? 'rgba(239,68,68,0.45)' : 'var(--input-border)', background: dangerAcknowledged ? 'rgba(239,68,68,0.08)' : 'var(--input-bg)', color: theme !== 'light' ? '#cbd5e1' : '#475569' }}>
            <input type="checkbox" checked={dangerAcknowledged}
              onChange={e => { setDangerAcknowledged(e.target.checked); setErr('') }}
              className="mt-0.5 h-4 w-4 accent-red-500" />
            <span className="min-w-0">
              确认 2：我理解删除项目不可恢复，并确认继续删除。
            </span>
          </label>
          {passwordRequired && (
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium" style={{ color: theme !== 'light' ? '#cbd5e1' : '#475569' }}>
                当前账号密码
              </span>
              <input type="password" value={password} onChange={e => { setPassword(e.target.value); setErr('') }}
                data-tour="delete-project-password-input"
                placeholder="输入当前账号密码"
                onKeyDown={e => e.key === 'Enter' && submit()}
                className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
            </label>
          )}
        </div>
        {err && <ErrBanner>{err}</ErrBanner>}
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
          <button onClick={submit} disabled={loading || !canSubmit}
            data-tour="delete-project-submit"
            className="flex-1 h-9 rounded-xl text-[13px] text-white bg-red-500 hover:bg-red-600 transition-colors disabled:opacity-40">
            {loading ? '删除中...' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// 拓展项目: 隐藏 / 彻底删除当前用户数据 (per-user)
// 拓展是全局共享卡片, 此模态只管理当前用户在该拓展上的显示和数据.
//   - 隐藏: 仅插 project_user_hidden 行, 管理员面板可恢复.
//   - 彻底删除: 事务删该用户 sessions/issues/stars/whitelist + 隐藏. 不可恢复数据.
// =====================================================================
export function ExtensionDeleteModal({ project, onClose, onDone }: { project: any; onClose: () => void; onDone: () => void }) {
  const { theme } = useStore()
  const isDark = theme !== 'light'
  const [mode, setMode] = useState<'choose' | 'confirm-purge'>('choose')
  const [confirmText, setConfirmText] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const accept = new Set([project.name, project.extension_name, project.id].filter(Boolean).map(String))

  const submitHide = async () => {
    setLoading(true); setErr('')
    try {
      await api(`/api/projects/${project.id}/hide`, { method: 'POST', body: JSON.stringify({}) })
      onDone()
    } catch (e: any) { setErr(e?.message || '隐藏失败') } finally { setLoading(false) }
  }
  const submitPurge = async () => {
    if (!accept.has(confirmText.trim())) { setErr('请输入拓展名以确认'); return }
    setLoading(true); setErr('')
    try {
      await api(`/api/projects/${project.id}/purge`, { method: 'POST', body: JSON.stringify({ confirm: confirmText.trim() }) })
      onDone()
    } catch (e: any) { setErr(e?.message || '彻底删除失败') } finally { setLoading(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[420px] rounded-2xl p-6 shadow-2xl" onClick={e => e.stopPropagation()} style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="text-[15px] font-semibold mb-2" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>
          管理拓展显示「{project.name}」
        </h3>
        {mode === 'choose' && (
          <>
            <p className="text-[12px] mb-4" style={{ color: isDark ? '#94a3b8' : '#64748b' }}>
              拓展应用是共享入口。这里的操作只影响你自己的项目列表和个人数据。
            </p>
            <div className="space-y-2 mb-4">
              <button onClick={submitHide} disabled={loading}
                className="w-full text-left rounded-xl p-3 transition-colors disabled:opacity-40 border"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)' }}>
                <div className="text-[13px] font-medium" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>隐藏卡片</div>
                <div className="text-[11px] mt-0.5" style={{ color: isDark ? '#94a3b8' : '#64748b' }}>
                  只从你的项目页隐藏入口，不删除任务单、执行会话或星标。可在已屏蔽项目中恢复。
                </div>
              </button>
              <button onClick={() => setMode('confirm-purge')} disabled={loading}
                className="w-full text-left rounded-xl p-3 transition-colors disabled:opacity-40 border"
                style={{ background: 'rgba(239,68,68,0.06)', borderColor: 'rgba(239,68,68,0.35)' }}>
                <div className="text-[13px] font-medium text-red-400">彻底删除我的拓展数据</div>
                <div className="text-[11px] mt-0.5" style={{ color: isDark ? '#fca5a5' : '#b91c1c' }}>
                  删除你在此拓展中的执行会话、自建任务单、星标和名单设置，并隐藏卡片。不可恢复。
                </div>
              </button>
            </div>
            {err && <ErrBanner>{err}</ErrBanner>}
            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: isDark ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
            </div>
          </>
        )}
        {mode === 'confirm-purge' && (
          <>
            <p className="text-[12px] mb-3" style={{ color: isDark ? '#fca5a5' : '#b91c1c' }}>
              这会删除你的个人拓展数据，不能恢复。请输入拓展名 <strong>{project.extension_name || project.name}</strong> 确认。
            </p>
            <input autoFocus value={confirmText} onChange={e => { setConfirmText(e.target.value); setErr('') }}
              placeholder={project.extension_name || project.name}
              onKeyDown={e => e.key === 'Enter' && submitPurge()}
              className="w-full h-10 px-3 mb-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-red-500/40"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: isDark ? '#f1f5f9' : '#1e293b' }} />
            {err && <ErrBanner>{err}</ErrBanner>}
            <div className="flex gap-2">
              <button onClick={() => { setMode('choose'); setErr('') }} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: isDark ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>返回</button>
              <button onClick={submitPurge} disabled={loading || !accept.has(confirmText.trim())}
                className="flex-1 h-9 rounded-xl text-[13px] text-white bg-red-500 hover:bg-red-600 transition-colors disabled:opacity-40">
                {loading ? '处理中...' : '删除我的数据'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// =====================================================================
// 新建 Issue
// =====================================================================
type NewIssueCreatedOptions = {
  createFirstSession: boolean
  planningSessionId?: string | null
}

export function NewIssueModal({ projectId, onClose, onCreated, defaultUseWorktree = true, forcePlanning = false }: { projectId: string; onClose: () => void; onCreated: (iss: any, options: NewIssueCreatedOptions) => void; defaultUseWorktree?: boolean; forcePlanning?: boolean }) {
  const DRAFT_KEY = `new-issue:${projectId}`
  const initialDraft = draftLoad<{
    title?: string
    desc?: string
    descTouched?: boolean
    useWorktree?: boolean
    createFirstSession?: boolean
    branch?: string
    visibility?: IssueVisibility
    isPlanning?: boolean
  }>(DRAFT_KEY)
  const guidedDemo = readActiveGuidedDemo()
  const guidedDemoState = guidedDemo?.state
  const isGuidedDemo = isGuidedDemoProject(projectId) && !guidedDemoState?.issueId
  const { theme, projects } = useStore()
  // 从 store 找父项目: 用来限制 issue 的可见性不能比 project 宽 (反向放大禁止).
  const parentProject: any = (projects || []).find((p: any) => p.id === projectId)
  const parentVisibility: 'private' | 'team' | 'public' | 'allowlist' =
    parentProject?.visibility === 'team' || parentProject?.visibility === 'public' || parentProject?.visibility === 'allowlist'
      ? parentProject.visibility
      : 'private'
  // 反向放大: 仅当父项目允许时才显示对应档位; inherit 也可选项, 默认值总是 inherit.
  const allowedVisibilities: IssueVisibility[] = ['inherit']
  if (parentVisibility === 'private') allowedVisibilities.push('private')
  if (parentVisibility === 'team') { allowedVisibilities.push('private', 'team') }
  if (parentVisibility === 'public') { allowedVisibilities.push('private', 'team', 'public') }
  if (parentVisibility === 'allowlist') { allowedVisibilities.push('private', 'allowlist') }
  const initialVisibility: IssueVisibility =
    (initialDraft?.visibility && allowedVisibilities.includes(initialDraft.visibility)) ? initialDraft.visibility : 'inherit'
  const [title, setTitle] = useState(isGuidedDemo ? guidedDemoState?.issueTitle || '' : (initialDraft?.title || ''))
  const [desc, setDesc] = useState(isGuidedDemo ? guidedDemoState?.issueDescription || '' : (initialDraft?.desc || ''))
  const [descTouched, setDescTouched] = useState(isGuidedDemo ? true : !!initialDraft?.descTouched)
  const [useWorktree, setUseWorktree] = useState(isGuidedDemo ? false : (typeof initialDraft?.useWorktree === 'boolean' ? initialDraft.useWorktree : defaultUseWorktree))
  const [createFirstSession, setCreateFirstSession] = useState(isGuidedDemo ? false : (typeof initialDraft?.createFirstSession === 'boolean' ? initialDraft.createFirstSession : true))
  const [isPlanning, setIsPlanning] = useState(forcePlanning || (typeof initialDraft?.isPlanning === 'boolean' ? initialDraft.isPlanning : false))
  const [branch, setBranch] = useState(isGuidedDemo ? '' : (initialDraft?.branch || ''))
  const [visibility, setVisibility] = useState<IssueVisibility>(initialVisibility)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const isDark = theme !== 'light'
  const effectiveDesc = descTouched ? desc : title
  const issueVisibilityOptions = ISSUE_VISIBILITY_OPTIONS.filter(opt => allowedVisibilities.includes(opt.value))
  const visibilityOption = issueVisibilityOptions.find(opt => opt.value === visibility) || ISSUE_VISIBILITY_OPTIONS[0]
  const parentVisibilityLabel = parentVisibility === 'private' ? '仅自己' : parentVisibility === 'team' ? '同组' : parentVisibility === 'public' ? '公开' : '指定用户'

  useEffect(() => {
    if (!isGuidedDemo) draftSave(DRAFT_KEY, { title, desc: descTouched ? desc : '', descTouched, useWorktree, createFirstSession, branch, visibility, isPlanning })
  }, [DRAFT_KEY, isGuidedDemo, title, desc, descTouched, useWorktree, createFirstSession, branch, visibility, isPlanning])
  const submit = async () => {
    if (!title.trim()) { setErr('请填写 Issue 标题'); return }
    if (!effectiveDesc.trim()) { setErr('请填写 Issue 描述'); return }
    setLoading(true); setErr('')
    try {
      const iss = await api(`/api/projects/${projectId}/issues`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          description: effectiveDesc,
          use_worktree: isPlanning ? false : useWorktree,
          worktree_branch: (!isPlanning && useWorktree) ? branch.trim() : '',
          visibility,
          is_planning: isPlanning,
        }),
      })
      draftClear(DRAFT_KEY)
      if (isGuidedDemo && guidedDemo && iss?.id) patchGuidedDemoState(guidedDemo.kind, { issueId: iss.id })
      onCreated(iss, { createFirstSession: isPlanning ? false : createFirstSession, planningSessionId: iss?.planning_session_id })
    } catch (e: any) { setErr(e?.message || '创建失败') } finally { setLoading(false) }
  }

  const issuePermissionControl = (
    <div>
      <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>任务单可见性（不能比项目可见性更宽）</label>
      <div className="grid grid-cols-2 gap-1.5">
        {issueVisibilityOptions.map((opt) => {
          const active = visibility === opt.value
          return (
            <button key={opt.value} type="button" onClick={() => { setVisibility(opt.value); setErr('') }}
              title={opt.description}
              className="h-8 rounded-lg border text-[12px] transition-colors"
              style={active
                ? { background: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.48)', color: '#60a5fa' }
                : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
              {opt.label}
            </button>
          )
        })}
      </div>
      <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
        父项目可见性为「{parentVisibilityLabel}」，本任务单可选范围已自动收窄。
      </p>
    </div>
  )

  const issuePermissionModal = permissionOpen ? (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={() => setPermissionOpen(false)} />
      <div className="relative w-[420px] max-w-[calc(100vw-32px)] rounded-2xl p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h4 className="text-[15px] font-semibold mb-1" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>修改 Issue 权限</h4>
        <p className="mb-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>设置谁能看到这个 Issue。可选范围会受所属项目权限限制。</p>
        {issuePermissionControl}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={() => setPermissionOpen(false)}
            className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors">
            完成
          </button>
        </div>
      </div>
    </div>
  ) : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div data-tour="issue-modal" className="relative w-[440px] rounded-2xl p-6 shadow-2xl" style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="text-[15px] font-semibold mb-5" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>新建 Issue</h3>
        <div className="space-y-3 mb-4">
          <input autoFocus value={title} onChange={e => { setTitle(e.target.value); setErr('') }}
            data-tour="issue-title-input"
            placeholder="Issue 标题" onKeyDown={e => e.key === 'Enter' && submit()}
            className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
          <ExpandableTextarea value={effectiveDesc} onValueChange={value => { setDesc(value); setDescTouched(true); setErr('') }}
            data-tour="issue-description-input"
            placeholder="Issue 描述（默认同标题）"
            overlayTitle="编辑 Issue 描述"
            className="w-full h-28 px-3 py-2 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30 resize-none"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />

          <button type="button" onClick={() => setPermissionOpen(true)}
            data-tour="issue-visibility"
            className="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)' }}>
            <Eye className="h-4 w-4 flex-shrink-0 text-blue-400" strokeWidth={1.75} />
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-medium" style={{ color: isDark ? '#cbd5e1' : '#334155' }}>修改 Issue 权限</span>
              <span className="mt-0.5 block truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {visibilityOption.label} · 项目为{parentVisibilityLabel}，可选范围已收窄
              </span>
            </span>
            <span className="flex-shrink-0 text-[11px]" style={{ color: '#60a5fa' }}>修改</span>
          </button>

          <ToggleSwitch
            data-tour="issue-worktree-toggle"
            checked={useWorktree}
            onChange={v => { setUseWorktree(v); setErr('') }}
            className="flex items-center gap-3 text-[13px]"
            style={{ color: isDark ? '#cbd5e1' : '#334155' }}>
            使用 git worktree（在绑定路径下为本 Issue 开独立工作区）
          </ToggleSwitch>
          {useWorktree && (
            <div className="space-y-1.5">
              <input value={branch} onChange={e => { setBranch(e.target.value); setErr('') }}
                data-tour="issue-branch-input"
                placeholder="分支名称（留空默认使用 Issue 标识）"
                onKeyDown={e => e.key === 'Enter' && submit()}
                className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: isDark ? '#f1f5f9' : '#1e293b' }} />
              <p className="text-[11px] px-1" style={{ color: isDark ? '#6b7280' : '#94a3b8' }}>
                工作区路径 = 绑定路径/分支名。若该路径已存在，创建会失败并提示重新输入。
              </p>
            </div>
          )}

          <ToggleSwitch
            checked={isPlanning}
            onChange={v => { setIsPlanning(v); setErr('') }}
            className="flex items-start gap-3 text-[13px] leading-5"
            style={{ color: isDark ? '#cbd5e1' : '#334155' }}>
            <span>
              <span className="font-medium">系统宏观规划模式</span>
            </span>
          </ToggleSwitch>

          {!isPlanning && (
            <ToggleSwitch
              checked={createFirstSession}
              onChange={v => { setCreateFirstSession(v); setErr('') }}
              className="flex items-start gap-3 text-[13px] leading-5"
              style={{ color: isDark ? '#cbd5e1' : '#334155' }}>
              <span>立即创建第一个 Session（创建后自动打开新 Session 菜单）</span>
            </ToggleSwitch>
          )}
        </div>
        {err && <ErrBanner>{err}</ErrBanner>}
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
          <button onClick={submit} disabled={loading}
            data-tour="issue-submit"
            className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors disabled:opacity-40">
            {loading ? '创建中...' : '创建'}
          </button>
        </div>
        {issuePermissionModal}
      </div>
    </div>
  )
}

// =====================================================================
// 重命名 / 编辑 Issue
// =====================================================================
export function RenameIssueModal({ issue, onClose, onRenamed }: { issue: any; onClose: () => void; onRenamed: (iss: any) => void }) {
  const [name, setName] = useState(issue.title)
  const [desc, setDesc] = useState(issue.description || '')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const { theme, projects } = useStore()
  // 反向放大禁止: 不能把 issue visibility 改成比父项目更宽.
  const parentProject: any = (projects || []).find((p: any) => p.id === issue.project_id)
  const parentVisibility: 'private' | 'team' | 'public' | 'allowlist' =
    parentProject?.visibility === 'team' || parentProject?.visibility === 'public' || parentProject?.visibility === 'allowlist'
      ? parentProject.visibility
      : 'private'
  const initialIssueVisibility: 'inherit' | 'private' | 'team' | 'public' | 'allowlist' = (() => {
    if (issue.visibility === 'private' || issue.visibility === 'team' || issue.visibility === 'public' || issue.visibility === 'allowlist') return issue.visibility
    return 'inherit'
  })()
  const [visibility, setVisibility] = useState<'inherit' | 'private' | 'team' | 'public' | 'allowlist'>(initialIssueVisibility)
  const allowedVisibilities: Array<'inherit' | 'private' | 'team' | 'public' | 'allowlist'> = ['inherit']
  if (parentVisibility === 'private') allowedVisibilities.push('private')
  if (parentVisibility === 'team') { allowedVisibilities.push('private', 'team') }
  if (parentVisibility === 'public') { allowedVisibilities.push('private', 'team', 'public') }
  if (parentVisibility === 'allowlist') { allowedVisibilities.push('private', 'allowlist') }
  const submit = async () => {
    if (!name.trim()) { setErr('请输入 Issue 标题'); return }
    setLoading(true); setErr('')
    try {
      const updated = await api(`/api/issues/${issue.id}`, { method: 'PATCH', body: JSON.stringify({ title: name, description: desc, visibility }) })
      onRenamed(updated)
    } catch { setErr('修改失败') } finally { setLoading(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-96 rounded-2xl p-6 shadow-2xl" onClick={e => e.stopPropagation()} style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="text-[15px] font-semibold mb-5" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>修改 Issue</h3>
        <div className="space-y-3 mb-4">
          <input autoFocus value={name} onChange={e => { setName(e.target.value); setErr('') }}
            placeholder="Issue 标题" onKeyDown={e => e.key === 'Enter' && submit()}
            className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
          <ExpandableTextarea value={desc} onValueChange={setDesc}
            placeholder="Issue 描述（选填）"
            overlayTitle="编辑 Issue 描述"
            className="w-full h-20 px-3 py-2 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30 resize-none"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
          <div>
            <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>任务单可见性（不能比项目可见性更宽）</label>
            <div className="grid grid-cols-2 gap-1.5">
              {[
                { value: 'inherit', label: '继承项目', desc: '跟随所属项目的可见性' },
                { value: 'private', label: '仅自己', desc: '只有任务单创建者、项目创建者和管理员可见' },
                { value: 'team', label: '同组', desc: '同一群组用户可见，前提是他们也能看到项目' },
                { value: 'public', label: '项目可见者', desc: '所有能看到项目的登录用户都可见' },
                { value: 'allowlist', label: '指定用户', desc: '只有任务单创建者、项目创建者、管理员和允许名单中的用户可见' },
              ].filter(opt => allowedVisibilities.includes(opt.value as any)).map((opt) => {
                const active = visibility === opt.value
                return (
                  <button key={opt.value} type="button" onClick={() => { setVisibility(opt.value as any); setErr('') }}
                    title={opt.desc}
                    className="h-8 rounded-lg border text-[12px] transition-colors"
                    style={active
                      ? { background: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.48)', color: '#60a5fa' }
                      : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        {err && <ErrBanner>{err}</ErrBanner>}
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
          <button onClick={submit} disabled={loading}
            className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors disabled:opacity-40">
            {loading ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// 新建 / 编辑 Research
// =====================================================================
export function NewResearchModal({ projectId, onClose, onCreated }: { projectId: string; onClose: () => void; onCreated: (research: any) => void }) {
  const DRAFT_KEY = `new-research:${projectId}`
  const initialDraft = draftLoad<{ title?: string; desc?: string; descTouched?: boolean }>(DRAFT_KEY)
  const [title, setTitle] = useState(initialDraft?.title || '')
  const [desc, setDesc] = useState(initialDraft?.desc || '')
  const [descTouched, setDescTouched] = useState(!!initialDraft?.descTouched)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const { theme } = useStore()
  const effectiveDesc = descTouched ? desc : title
  useEffect(() => {
    draftSave(DRAFT_KEY, { title, desc: descTouched ? desc : '', descTouched })
  }, [DRAFT_KEY, title, desc, descTouched])
  const submit = async () => {
    if (!title.trim()) { setErr('请填写 Research 标题'); return }
    if (!effectiveDesc.trim()) { setErr('请填写 Research 描述'); return }
    setLoading(true); setErr('')
    try {
      const research = await api(`/api/projects/${projectId}/researches`, {
        method: 'POST',
        body: JSON.stringify({ title, description: effectiveDesc }),
      })
      draftClear(DRAFT_KEY)
      onCreated(research)
    } catch (e: any) { setErr(e?.message || '创建失败') } finally { setLoading(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-[440px] rounded-2xl p-6 shadow-2xl" style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="text-[15px] font-semibold mb-5" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>新建 Research</h3>
        <div className="space-y-3 mb-4">
          <input autoFocus value={title} onChange={e => { setTitle(e.target.value); setErr('') }}
            placeholder="Research 标题" onKeyDown={e => e.key === 'Enter' && submit()}
            className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
          <ExpandableTextarea value={effectiveDesc} onValueChange={value => { setDesc(value); setDescTouched(true); setErr('') }}
            placeholder="Research 描述（默认同标题）"
            overlayTitle="编辑 Research 描述"
            className="w-full h-28 px-3 py-2 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30 resize-none"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
        </div>
        {err && <ErrBanner>{err}</ErrBanner>}
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
          <button onClick={submit} disabled={loading}
            className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors disabled:opacity-40">
            {loading ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function RenameResearchModal({ research, onClose, onRenamed }: { research: any; onClose: () => void; onRenamed: (research: any) => void }) {
  const [title, setTitle] = useState(research.title)
  const [desc, setDesc] = useState(research.description || '')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const { theme } = useStore()
  const submit = async () => {
    if (!title.trim()) { setErr('请输入 Research 标题'); return }
    setLoading(true); setErr('')
    try {
      const updated = await api(`/api/researches/${research.id}`, { method: 'PATCH', body: JSON.stringify({ title, description: desc }) })
      onRenamed(updated)
    } catch (e: any) { setErr(e?.message || '保存失败') } finally { setLoading(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-96 rounded-2xl p-6 shadow-2xl" onClick={e => e.stopPropagation()} style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="text-[15px] font-semibold mb-5" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>修改 Research</h3>
        <div className="space-y-3 mb-4">
          <input autoFocus value={title} onChange={e => { setTitle(e.target.value); setErr('') }}
            placeholder="Research 标题" onKeyDown={e => e.key === 'Enter' && submit()}
            className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
          <ExpandableTextarea value={desc} onValueChange={setDesc}
            placeholder="Research 描述（选填）"
            overlayTitle="编辑 Research 描述"
            className="w-full h-20 px-3 py-2 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30 resize-none"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
        </div>
        {err && <ErrBanner>{err}</ErrBanner>}
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
          <button onClick={submit} disabled={loading}
            className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors disabled:opacity-40">
            {loading ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// 默认会话名 = 可选所属标题 + 当前时间（YYYY-MM-DD HH:mm）
function formatNowForName(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDefaultSessionName(scopeTitle?: string): string {
  const time = formatNowForName()
  const title = (scopeTitle || '').replace(/\s+/g, ' ').trim()
  return title ? `${title} ${time}` : time
}

// =====================================================================
// 新建 Session Wizard — 两步:
//   Step 1: 填名称 / 描述
//   Step 2: 预览将注入的上下文 (skill/memory 列表 + 完整 body), 提示「之后不可改」
// 用户在 Step 2 才看到 [创建] 按钮; 想改 skill/memory 需要返回去用户中心改, 然后再走 wizard.
// =====================================================================
type WizardItem = {
  id: string
  name: string
  description?: string
  scope: string
  dirName?: string | null
  research_role?: string
  body?: string
}

interface WizardPreview {
  body: string
  sources: {
    skills?: WizardItem[]
    memories?: { id: string; name: string; description?: string; scope: string }[]
    forced_skill_conflicts?: { id: string; name: string }[]
  } | null
}
interface SelectionDefaults {
  inherited?: boolean
  source_session?: { session_id: string; name: string } | null
  excluded_skill_ids?: string[]
  excluded_memory_ids?: string[]
}
const SCOPE_LABEL_WIZ: Record<string, string> = { user: '用户级', project: '项目级', builtin: '内置' }

type ModelKey = string

function SessionSkillPreviewDialog({ skill, isDark, onClose }: { skill: WizardItem; isDark: boolean; onClose: () => void }) {
  const body = typeof skill.body === 'string' ? skill.body : ''
  const scopeLabel = SCOPE_LABEL_WIZ[skill.scope] || skill.scope
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative flex max-h-[86vh] w-[min(860px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl shadow-2xl"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--border-color)' }}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 text-[15px] font-semibold leading-6 break-words" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>
                {skill.name}
              </h3>
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ background: isDark ? 'rgba(168,85,247,0.15)' : 'rgba(168,85,247,0.1)', color: isDark ? '#c084fc' : '#7e22ce' }}>
                {scopeLabel}
              </span>
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ background: isDark ? 'rgba(59,130,246,0.12)' : 'rgba(59,130,246,0.08)', color: isDark ? '#93c5fd' : '#1d4ed8' }}>
                {body.length} 字
              </span>
            </div>
            {skill.description && (
              <p className="mt-1 text-[12px] leading-relaxed" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>
                {skill.description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{ color: isDark ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}
            aria-label="关闭 Skill 预览"
            title="关闭"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <pre
            className="m-0 min-h-[360px] whitespace-pre-wrap break-words rounded-xl border p-4 text-[12px] leading-relaxed"
            style={{
              background: isDark ? '#111827' : '#ffffff',
              borderColor: isDark ? '#374151' : '#e5e7eb',
              color: isDark ? '#f1f5f9' : '#1e293b',
              fontFamily: 'ui-monospace,SFMono-Regular,monospace',
            }}
          >
            {body || '未读取到 SKILL.md 正文。'}
          </pre>
        </div>
      </div>
    </div>
  )
}

function isSelfEvolveRequiredMemoryItem(item: { name?: string }) {
  return String(item.name || '') === SELF_EVOLVE_REQUIRED_MEMORY_NAME
}

function isSelfEvolveProjectMemoryItem(item: { name?: string; description?: string }) {
  const text = `${item.name || ''} ${item.description || ''}`
  return text.includes(SELF_EVOLVE_PROJECT_KNOWLEDGE_MEMORY_NAME)
    || (text.includes('项目知识') && (text.includes('MOBIUS') || text.includes('中台') || text.includes('莫比乌斯')))
}

function isSelfEvolveGuideMemoryItem(item: { id?: string; name?: string; description?: string }) {
  const text = `${item.id || ''} ${item.name || ''} ${item.description || ''}`
  return SELF_EVOLVE_GUIDE_STYLE_MEMORY_NAMES.some(name => text.includes(name))
    || (text.includes('引导') && text.includes('文案'))
}

function shouldKeepSelfEvolveMemory(item: { id?: string; name?: string; description?: string }) {
  return isSelfEvolveRequiredMemoryItem(item) || isSelfEvolveProjectMemoryItem(item) || isSelfEvolveGuideMemoryItem(item)
}

type SessionModelOption = {
  key: string
  value?: string
  model?: string
  label: string
  title: string
  sub: string
  backend: string
  imported?: boolean
  use_proxy?: 0 | 1 | boolean | null
}
const DEFAULT_SESSION_MODEL: ModelKey = 'codex'

const FALLBACK_SESSION_MODEL_CHOICES: SessionModelOption[] = [
]

const SESSION_MODEL_LABEL: Record<string, string> = {
  opus: 'Opus',
  codex: 'GPT-5.5 (Codex)',
}

// 模型 → 后端渠道
// 用来对照 /api/sessions/prompt-stats 中的渠道桶
type PromptBackendKey = 'codex' | 'claude_code'
function promptBackendKeyForOption(opt?: SessionModelOption | null): PromptBackendKey {
  return opt?.backend === 'tmux-codex' ? 'codex' : 'claude_code'
}
type ModelUsageLimit = {
  key: string
  model?: string
  label: string
  title?: string
  count: number
  limit: number | null
  remaining: number | null
  blocked: boolean
  blocked_by?: string | null
  window_hours: number
  window_minutes?: number
  since: string
  usage?: {
    allUsers5h?: LimitUsageState
    allUsers5m?: LimitUsageState
    perUser5h?: LimitUsageState
    perUser5m?: LimitUsageState
    tmuxWindows?: LimitUsageState & { warning?: boolean }
  }
}
type LimitUsageState = {
  count: number
  limit: number | null
  remaining: number | null
  blocked: boolean
}
type ModelUsageLimits = {
  window_hours: number
  window_minutes?: number
  since: string
  models: Record<string, ModelUsageLimit>
}
type PromptStats = {
  window_hours: number
  window_minutes?: number
  since: string
  codex: number
  claude_code: number
  codex_5min?: number
  claude_code_5min?: number
  codex_2min: number
  claude_code_2min: number
  total: number
  active_tmux_window_count?: number
  active_windows_by_backend?: Partial<Record<PromptBackendKey, number>>
  model_usage_limits?: ModelUsageLimits
}

const PROMPT_BACKEND_LABEL: Record<PromptBackendKey, string> = {
  codex: 'Codex',
  claude_code: 'Claude Code',
}

// 注入上下文语言: 决定首轮注入的「上下文」段落用中文还是英文. 默认中文.
export type SessionLanguage = 'zh' | 'en'
const DEFAULT_SESSION_LANGUAGE: SessionLanguage = 'zh'
const SESSION_LANGUAGE_CHOICES: { key: SessionLanguage; title: string; sub: string }[] = [
  { key: 'zh', title: '中文', sub: '注入上下文 · 默认' },
  { key: 'en', title: 'English', sub: 'Inject context in English' },
]
const SESSION_LANGUAGE_LABEL: Record<SessionLanguage, string> = {
  zh: '中文',
  en: 'English',
}

type AgentSkill = { id: string; name: string; description?: string; research_role: string; scope: string }

export type ExistingSessionAction = 'ignore' | 'block_new' | 'terminate_old' | 'delete_old'

export const EXISTING_SESSION_ACTION_OPTIONS: {
  key: ExistingSessionAction
  title: string
  sub: string
}[] = [
  { key: 'ignore', title: '无视', sub: '直接创建新的 Session' },
  { key: 'block_new', title: '阻止新session运行', sub: '存在旧 Session 时不创建新的 Session' },
  { key: 'terminate_old', title: '终止旧session', sub: '先终止旧 Session 的后台执行' },
  { key: 'delete_old', title: '删除旧session', sub: '先永久删除旧 Session' },
]

export const EXISTING_SESSION_ACTION_LABEL: Record<ExistingSessionAction, string> = {
  ignore: '无视',
  block_new: '阻止新session运行',
  terminate_old: '终止旧session',
  delete_old: '删除旧session',
}

export function normalizeExistingSessionAction(value: any): ExistingSessionAction {
  return value === 'block_new' || value === 'terminate_old' || value === 'delete_old' ? value : 'ignore'
}

export type SessionPresetConfig = {
  name: string
  description: string
  personality?: string
  model: string
  role?: 'chief_researcher' | 'research_assistant'
  language: SessionLanguage
  existing_session_action?: ExistingSessionAction
  excluded_skill_ids: string[]
  excluded_memory_ids: string[]
  required_skill_ids?: string[]
  saved_at?: string
}

export type SessionPersonalityOption = {
  key: string
  label: string
  description: string
}

type RequiredSessionSkill = {
  dirName: string
  name?: string
  label?: string
}

function agentSkillInstruction(sk: AgentSkill) {
  return `你的任务是按照 ${sk.name} skill 中的指示完成任务`
}

function removeAutoAgentSkillInstruction(desc: string, autoText: string) {
  if (!autoText) return desc
  const trimmed = desc.trimEnd()
  if (trimmed === autoText) return ''
  for (const suffix of [`\n\n${autoText}`, `\n${autoText}`]) {
    if (trimmed.endsWith(suffix)) {
      return trimmed.slice(0, -suffix.length).trimEnd()
    }
  }
  return desc
}

function appendAgentSkillInstruction(desc: string, autoText: string, nextText: string) {
  const base = removeAutoAgentSkillInstruction(desc, autoText).trimEnd()
  return base.trim() ? `${base}\n\n${nextText}` : nextText
}

export function NewSessionModal({
  issueId,
  researchId,
  projectId,
  existingSessions = [],
  onClose,
  onCreated,
  defaultName,
  defaultDescription,
  defaultNamePrefix,
  entityLabel,
  mode = 'create',
  initialPreset,
  requiredSkill,
  projectKind,
  personalityOptions = [],
  onPresetSaved,
  presetContextPreviewEndpoint,
  presetSelectionDefaultsEndpoint,
  showExistingSessionAction = true,
  modalZIndexClass = 'z-50',
  modalTitle,
  continueFromSessionId,
  defaultModel,
}: {
  issueId?: string; researchId?: string; projectId?: string; existingSessions?: any[];
  onClose: () => void; onCreated: (s: any) => void;
  defaultName?: string; defaultDescription?: string; defaultNamePrefix?: string
  entityLabel?: string
  mode?: 'create' | 'preset'
  initialPreset?: SessionPresetConfig | null
  requiredSkill?: RequiredSessionSkill
  projectKind?: string
  personalityOptions?: SessionPersonalityOption[]
  onPresetSaved?: (preset: SessionPresetConfig) => void
  presetContextPreviewEndpoint?: string
  presetSelectionDefaultsEndpoint?: string
  showExistingSessionAction?: boolean
  modalZIndexClass?: string
  modalTitle?: string
  continueFromSessionId?: string
  defaultModel?: string | null
}) {
  const isResearch = !!researchId
  const isPresetMode = mode === 'preset'
  const isProjectPreset = isPresetMode && !!projectId && !issueId && !researchId
  const displayEntityLabel = entityLabel || (isResearch ? 'Research Agent' : 'Session')
  const entityNameLabel = isResearch ? `${displayEntityLabel} 名称` : `${displayEntityLabel}名称`
  const entityPurposeLabel = isResearch ? `${displayEntityLabel} 目的/问题描述` : `${displayEntityLabel}目的/问题描述`
  const chiefExists = existingSessions.some((s: any) => s.research_role === 'chief_researcher')
  const DRAFT_KEY = isPresetMode ? `session-preset:${projectId || issueId || researchId || 'unknown'}`
    : continueFromSessionId
      ? `continue-session:${continueFromSessionId}`
      : `new-session:${isResearch ? `r:${researchId}` : `i:${issueId}`}`
  const initialDraft = isPresetMode ? null : draftLoad<{
    name?: string
    desc?: string
    model?: ModelKey
    // model 是否为用户"手动选过"的 deliberate 选择. 旧草稿无此字段 → 视为非手动, 不作为权威模型.
    model_touched?: boolean
    role?: 'chief_researcher' | 'research_assistant'
    language?: SessionLanguage
    excluded_skill_ids?: string[]
    excluded_memory_ids?: string[]
    chosen_agent_skill_id?: string
    selection_ready?: boolean
  }>(DRAFT_KEY)
  const guidedDemo = readActiveGuidedDemo()
  const guidedDemoState = guidedDemo?.state
  const isGuidedDemo = !isPresetMode && !!issueId && isGuidedDemoIssue(issueId) && !guidedDemoState?.sessionId
  const isSelfEvolveGuidedDemo = isGuidedDemo && guidedDemo?.kind === 'self-evolve'
  const isExtensionProject = projectKind === 'extension'
  const requiredSessionSkill = isSelfEvolveGuidedDemo
    ? { dirName: SELF_EVOLVE_REQUIRED_SKILL_NAME, name: SELF_EVOLVE_REQUIRED_SKILL_NAME, label: SELF_EVOLVE_REQUIRED_SKILL_NAME }
    : (isExtensionProject
      ? { dirName: 'mobius-extension', name: 'mobius-extension', label: 'mobius-extension' }
      : requiredSkill)
  const [step, setStep] = useState<1 | 2>(1)
  const [name, setName] = useState(() => isGuidedDemo
    ? (guidedDemoState?.sessionName || '')
    : (initialPreset?.name || initialDraft?.name || defaultName || formatDefaultSessionName(defaultNamePrefix)))
  const [desc, setDesc] = useState(isGuidedDemo
    ? (guidedDemoState?.sessionDescription || '')
    : (initialPreset?.description || initialDraft?.desc || defaultDescription || ''))
  const [deferPurpose, setDeferPurpose] = useState(false)
  const [role, setRole] = useState<'chief_researcher' | 'research_assistant'>(
    initialPreset?.role || initialDraft?.role || (isResearch && !chiefExists ? 'chief_researcher' : 'research_assistant')
  )
  // 模型在创建时定型, 之后不可改 (随会话生命周期).
  // 初始值优先级: preset > 用户"手动选过"的草稿模型 > 项目级默认模型偏好 > 全局默认 > 内置 codex.
  // 关键: 草稿里的 model 只有 model_touched=true (用户手动选过) 才视为权威; 否则它只是历次默认值
  // 的快照, 会把模型钉在过期值上 (管理员改了项目/全局默认也不生效). 旧草稿无 model_touched → 忽略.
  const draftModelDeliberate = initialDraft?.model_touched ? initialDraft?.model : undefined
  const initialModelKey: ModelKey = initialPreset?.model
    || draftModelDeliberate
    || (typeof defaultModel === 'string' && defaultModel.trim() ? defaultModel.trim() : '')
    || DEFAULT_SESSION_MODEL
  const [model, setModel] = useState<ModelKey>(initialModelKey)
  // 全局默认模型偏好 (管理中心-系统设置): 异步拉取. 项目默认 (defaultModel) 也可能因 project 异步
  // 加载而晚到. 二者到达后, 若用户未手动改过模型, 按完整链路重算 (同 initialModelKey, 但插入全局默认).
  // modelUserTouchedRef: 只记"用户本次是否手动改过模型", 避免异步值覆盖用户选择.
  const modelUserTouchedRef = useRef(false)
  const [globalDefaultModel, setGlobalDefaultModel] = useState('')
  useEffect(() => {
    let alive = true
    fetchGlobalDefaultModel().then(v => { if (alive) setGlobalDefaultModel(v) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (modelUserTouchedRef.current) return
    const next: ModelKey = initialPreset?.model
      || draftModelDeliberate
      || (typeof defaultModel === 'string' && defaultModel.trim() ? defaultModel.trim() : '')
      || globalDefaultModel
      || DEFAULT_SESSION_MODEL
    setModel(next)
  }, [defaultModel, globalDefaultModel])
  // 注入上下文语言, 创建时定型 (默认中文).
  const [language, setLanguage] = useState<SessionLanguage>(initialPreset?.language || initialDraft?.language || DEFAULT_SESSION_LANGUAGE)
  const [personality, setPersonality] = useState<string>(initialPreset?.personality || personalityOptions[0]?.key || 'balanced')
  const [existingSessionAction, setExistingSessionAction] = useState<ExistingSessionAction>(
    () => normalizeExistingSessionAction(initialPreset?.existing_session_action)
  )
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [preview, setPreview] = useState<WizardPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  // Issue 默认就有的全集 (从第一次 preview 拉到, 不随勾选变化)
  const [availableSkills, setAvailableSkills] = useState<WizardItem[]>([])
  const [availableMemories, setAvailableMemories] = useState<WizardItem[]>([])
  // 必选 skill 被项目/用户白名单过滤掉时, 后端返回的冲突列表; 用于在 skill 选择界面提示.
  const [forcedSkillConflicts, setForcedSkillConflicts] = useState<{ id: string; name: string }[]>([])
  // 用户取消勾选的 id 集合 (默认全勾)
  const [excludedSkills, setExcludedSkills] = useState<Set<string>>(new Set())
  const [excludedMemories, setExcludedMemories] = useState<Set<string>>(new Set())
  const [previewingSkill, setPreviewingSkill] = useState<WizardItem | null>(null)
  const { theme } = useStore()
  const isDark = theme !== 'light'
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const canDeferPurpose = !isPresetMode
  const submittedDescription = canDeferPurpose && deferPurpose ? '' : desc

  // research agent skill: 名字 research-* 且含 research_role 字段的特殊 skill.
  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>([])
  const [showAgentSkillModal, setShowAgentSkillModal] = useState(false)
  const [chosenAgentSkill, setChosenAgentSkill] = useState<AgentSkill | null>(null)
  // 全站 5h 提问量 (codex / claude_code) — 用于在模型按钮显示渠道负载与高负荷警告
  const [promptStats, setPromptStats] = useState<PromptStats | null>(null)
  const [modelOptions, setModelOptions] = useState<SessionModelOption[]>(FALLBACK_SESSION_MODEL_CHOICES)
  const selectedModelOption = useMemo(
    () => modelOptions.find(opt => opt.key === model) || modelOptions[0] || FALLBACK_SESSION_MODEL_CHOICES[0],
    [modelOptions, model],
  )
  const selectedPersonality = useMemo(
    () => personalityOptions.find(option => option.key === personality) || personalityOptions[0] || null,
    [personalityOptions, personality],
  )
  const selectedBackendKey = promptBackendKeyForOption(selectedModelOption)
  const selectedActiveWindowCount = Number(promptStats?.active_windows_by_backend?.[selectedBackendKey] || 0)
  const selectedBackendLabel = PROMPT_BACKEND_LABEL[selectedBackendKey]
  const selectedModelUsage = promptStats?.model_usage_limits?.models?.[model] || null
  const selectedTmuxUsage = selectedModelUsage?.usage?.tmuxWindows || null
  const selectedTmuxWarning = !!selectedTmuxUsage?.warning

  useEffect(() => {
    let alive = true
    api('/api/sessions/model-options')
      .then((arr: SessionModelOption[]) => {
        if (!alive) return
        const options = Array.isArray(arr) && arr.length > 0 ? arr : FALLBACK_SESSION_MODEL_CHOICES
        setModelOptions(options)
        if (!options.some(opt => opt.key === model)) {
          setModel(options[0]?.key || DEFAULT_SESSION_MODEL)
        }
      })
      .catch(() => { if (alive) setModelOptions(FALLBACK_SESSION_MODEL_CHOICES) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    let alive = true
    api('/api/sessions/prompt-stats')
      .then((s: PromptStats) => { if (alive) setPromptStats(s) })
      .catch(() => { /* 失败就不显示徽标, 不影响创建流程 */ })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!isGuidedDemo && !isPresetMode) {
      draftSave(DRAFT_KEY, {
        name,
        desc,
        // 仅当用户手动选过模型才把 model 持久化进草稿 (并标 model_touched=true);
        // 否则不写 model, 让下次重开时按项目/全局默认重新解析, 避免过期默认值钉死模型.
        model: modelUserTouchedRef.current ? model : undefined,
        model_touched: modelUserTouchedRef.current,
        role,
        language,
        excluded_skill_ids: Array.from(excludedSkills),
        excluded_memory_ids: Array.from(excludedMemories),
        chosen_agent_skill_id: chosenAgentSkill?.id || '',
        selection_ready: !!initialDraft?.selection_ready || step === 2 || !!preview,
      }, { minChars: 1 })
    }
  }, [DRAFT_KEY, isGuidedDemo, isPresetMode, name, desc, model, role, language, excludedSkills, excludedMemories, chosenAgentSkill?.id, step, preview, initialDraft?.selection_ready])

  const modelUsageFor = useCallback((modelKey: ModelKey) => {
    return promptStats?.model_usage_limits?.models?.[modelKey] || null
  }, [promptStats])

  const isModelQuotaBlocked = useCallback((modelKey: ModelKey) => {
    return !!modelUsageFor(modelKey)?.blocked
  }, [modelUsageFor])

  const modelQuotaError = useCallback((modelKey: ModelKey) => {
    const usage = modelUsageFor(modelKey)
    if (!usage || usage.limit == null) return '当前模型已达到管理员设置的使用限额, 请切换模型。'
    const label = usage.label || usage.title || modelKey
    const limitLabels: Record<string, string> = {
      allUsers5h: '所有用户 5 小时提问次数',
      allUsers5m: '所有用户 5 分钟提问次数',
      perUser5h: '单个用户 5 小时提问次数',
      perUser5m: '单个用户 5 分钟提问次数',
    }
    const blockedBy = usage.blocked_by || 'perUser5h'
    const state = usage.usage?.[blockedBy as keyof NonNullable<ModelUsageLimit['usage']>] || { count: usage.count, limit: usage.limit }
    return `${label} 的${limitLabels[blockedBy] || '管理员提问次数'}已达限制 (${state.count}/${state.limit}), 请切换模型或稍后再创建该模型的新 ${displayEntityLabel}。已有 ${displayEntityLabel} 可继续提问。`
  }, [modelUsageFor, displayEntityLabel])

  const isModelCreationBlocked = useCallback((modelKey: ModelKey) => {
    return !isPresetMode && isModelQuotaBlocked(modelKey)
  }, [isModelQuotaBlocked, isPresetMode])

  useEffect(() => {
    if (!promptStats || !isModelCreationBlocked(model)) return
    const fallback = modelOptions.find(opt => !isModelCreationBlocked(opt.key))
    if (fallback && fallback.key !== model) {
      setModel(fallback.key)
    }
  }, [promptStats, model, modelOptions, isModelCreationBlocked])

  useEffect(() => {
    if (personalityOptions.length === 0) return
    if (personalityOptions.some(option => option.key === personality)) return
    setPersonality(personalityOptions[0].key)
  }, [personalityOptions, personality])

  // 记录最近一次自动追加的目的文本, 切换或取消时只移除这段自动文本.
  const [autoFilledDesc, setAutoFilledDesc] = useState('')

  useEffect(() => {
    if (!isResearch || !researchId) return
    api(`/api/researches/${researchId}/research-agent-skills`)
      .then((arr: AgentSkill[]) => setAgentSkills(Array.isArray(arr) ? arr : []))
      .catch(() => {})
  }, [isResearch, researchId])

  useEffect(() => {
    if (isPresetMode || chosenAgentSkill || !initialDraft?.chosen_agent_skill_id || agentSkills.length === 0) return
    const sk = agentSkills.find(item => item.id === initialDraft.chosen_agent_skill_id)
    if (!sk) return
    setChosenAgentSkill(sk)
    setAutoFilledDesc(agentSkillInstruction(sk))
  }, [agentSkills, chosenAgentSkill, initialDraft?.chosen_agent_skill_id, isPresetMode])

  const chooseAgentSkill = (sk: AgentSkill | null) => {
    setChosenAgentSkill(sk)
    setShowAgentSkillModal(false)
    setErr('')
    if (sk) {
      const text = agentSkillInstruction(sk)
      setDesc(prev => appendAgentSkillInstruction(prev, autoFilledDesc, text))
      setAutoFilledDesc(text)
    } else {
      setDesc(prev => removeAutoAgentSkillInstruction(prev, autoFilledDesc))
      setAutoFilledDesc('')
    }
  }

  const chooseModel = (nextModel: ModelKey) => {
    setModel(nextModel)
    modelUserTouchedRef.current = true
    setErr('')
  }

  const isChosenAgentSkill = useCallback((id: string) => chosenAgentSkill?.id === id, [chosenAgentSkill])
  const isMutuallyExclusiveAgentSkill = useCallback((id: string) => {
    return !!chosenAgentSkill && agentSkills.some(sk => sk.id === id && sk.id !== chosenAgentSkill.id)
  }, [agentSkills, chosenAgentSkill])
  const matchesRequiredSkill = useCallback((sk: { id?: string; name?: string; dirName?: string | null }) => {
    if (!requiredSessionSkill) return false
    const dirName = requiredSessionSkill.dirName
    const normalizedName = (requiredSessionSkill.name || dirName).replace(/_/g, '-')
    const itemDir = (sk.dirName || '').replace(/_/g, '-')
    const itemName = (sk.name || '').replace(/_/g, '-')
    const itemId = (sk.id || '').replace(/_/g, '-')
    return itemDir === dirName
      || itemName === normalizedName
      || itemId === `builtin:${dirName}`
      || itemId.endsWith(`:${dirName}`)
  }, [requiredSessionSkill])

  const normalizeSkillExclusions = useCallback((skillEx: Set<string>, availableSkillIds?: Set<string>) => {
    const next = new Set(skillEx)
    if (chosenAgentSkill) {
      next.delete(chosenAgentSkill.id)
      agentSkills.forEach(sk => {
        if (sk.id !== chosenAgentSkill.id && (!availableSkillIds || availableSkillIds.has(sk.id))) {
          next.add(sk.id)
        }
      })
    }
    if (requiredSessionSkill) {
      availableSkills.forEach(sk => {
        if (matchesRequiredSkill(sk) && (!availableSkillIds || availableSkillIds.has(sk.id))) {
          next.delete(sk.id)
        }
      })
    }
    return next
  }, [agentSkills, availableSkills, chosenAgentSkill, matchesRequiredSkill, requiredSessionSkill])

  // Step 2 期间, 用户切换勾选 → 重拉 preview, 让"完整注入文本"和字数都跟着变.
  // 用 POST + body 提交: description 可能很长, 放 URL query 会撑爆请求头导致 fail to fetch.
  const fetchPreview = useCallback(async (skillEx: Set<string>, memEx: Set<string>) => {
    const endpoint = isResearch
      ? `/api/researches/${researchId}/context-preview`
      : presetContextPreviewEndpoint
        ? presetContextPreviewEndpoint
        : isProjectPreset
        ? `/api/projects/${projectId}/architecture-session-preset/context-preview`
        : `/api/issues/${issueId}/context-preview`
    return await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: submittedDescription,
        role,
        language,
        personality,
        excluded_skill_ids: Array.from(skillEx),
        excluded_memory_ids: Array.from(memEx),
      }),
    }) as WizardPreview
  }, [issueId, projectId, researchId, isResearch, isProjectPreset, presetContextPreviewEndpoint, name, submittedDescription, role, language, personality])

  const fetchSelectionDefaults = useCallback(async () => {
    const endpoint = isResearch
      ? `/api/researches/${researchId}/session-selection-defaults`
      : presetSelectionDefaultsEndpoint
        ? presetSelectionDefaultsEndpoint
        : isProjectPreset
        ? `/api/projects/${projectId}/architecture-session-preset/session-selection-defaults`
        : `/api/issues/${issueId}/session-selection-defaults`
    return await api(endpoint) as SelectionDefaults
  }, [issueId, projectId, researchId, isResearch, isProjectPreset, presetSelectionDefaultsEndpoint])

  const goPreview = async () => {
    if (!name.trim()) { setErr(`请填写${isResearch ? ' ' : ''}${entityNameLabel}`); return }
    if (!deferPurpose && !desc.trim()) { setErr(`请填写${isResearch ? ' ' : ''}${entityPurposeLabel}`); return }
    if (!isPresetMode && isModelQuotaBlocked(model)) {
      setErr(modelQuotaError(model))
      return
    }
    setErr('')
    setPreviewLoading(true)
    try {
      const [defaults, pAll] = await Promise.all([
        fetchSelectionDefaults(),
        fetchPreview(new Set(), new Set()),
      ])
      const availableSkillIds = new Set((pAll.sources?.skills || []).map(s => s.id))
      const availableMemoryIds = new Set((pAll.sources?.memories || []).map(m => m.id))
      const requiredSessionSkillIds = requiredSessionSkill
        ? (pAll.sources?.skills || []).filter(matchesRequiredSkill).map(s => s.id)
        : []
      if (requiredSessionSkill && requiredSessionSkillIds.length === 0) {
        throw new Error(`未找到必选内置 Skill: ${requiredSessionSkill.label || requiredSessionSkill.dirName}`)
      }
      let defaultSkillEx = new Set<string>(
        ((isPresetMode && initialPreset?.excluded_skill_ids)
          ? initialPreset.excluded_skill_ids
          : (defaults.excluded_skill_ids || [])
        ).filter(id => availableSkillIds.has(id))
      )
      if (!isPresetMode && initialDraft?.selection_ready && initialDraft.excluded_skill_ids) {
        defaultSkillEx = new Set(initialDraft.excluded_skill_ids.filter(id => availableSkillIds.has(id)))
      }
      requiredSessionSkillIds.forEach(id => defaultSkillEx.delete(id))
      // 选中的 research agent skill 强制注入; 其他 research agent skill 与它互斥, 必须排除.
      defaultSkillEx = normalizeSkillExclusions(defaultSkillEx, availableSkillIds)
      let defaultMemoryEx = new Set<string>(
        ((isPresetMode && initialPreset?.excluded_memory_ids)
          ? initialPreset.excluded_memory_ids
          : (defaults.excluded_memory_ids || [])
        ).filter(id => availableMemoryIds.has(id))
      )
      if (!isPresetMode && initialDraft?.selection_ready && initialDraft.excluded_memory_ids) {
        defaultMemoryEx = new Set(initialDraft.excluded_memory_ids.filter(id => availableMemoryIds.has(id)))
      }
      if (isSelfEvolveGuidedDemo) {
        defaultSkillEx = normalizeSkillExclusions(
          new Set(
            (pAll.sources?.skills || [])
              .filter(sk => !matchesRequiredSkill(sk))
              .map(sk => sk.id)
              .filter(id => availableSkillIds.has(id))
          ),
          availableSkillIds,
        )
        defaultMemoryEx = new Set(
          (pAll.sources?.memories || [])
            .filter(memory => !shouldKeepSelfEvolveMemory(memory))
            .map(memory => memory.id)
            .filter(id => availableMemoryIds.has(id))
        )
      }
      const hasInheritedExclusions = defaultSkillEx.size > 0 || defaultMemoryEx.size > 0
      const p0 = hasInheritedExclusions ? await fetchPreview(defaultSkillEx, defaultMemoryEx) : pAll
      setAvailableMemories((pAll.sources?.memories || []) as WizardItem[])
      setAvailableSkills((pAll.sources?.skills || []) as WizardItem[])
      setForcedSkillConflicts((pAll.sources?.forced_skill_conflicts || []) as { id: string; name: string }[])
      setExcludedSkills(defaultSkillEx)
      setExcludedMemories(defaultMemoryEx)
      setPreview(p0)
      setStep(2)
    } catch (e: any) {
      setErr(e?.message || '加载预览失败')
    } finally { setPreviewLoading(false) }
  }

  // Step 2 内勾选状态变更 → 即时拉新 preview, 不阻塞 UI (lastSent 防竞态)
  const toggleSkill = async (id: string) => {
    const item = availableSkills.find(sk => sk.id === id)
    if (isChosenAgentSkill(id) || isMutuallyExclusiveAgentSkill(id) || (item && matchesRequiredSkill(item))) return
    const next = new Set(excludedSkills)
    next.has(id) ? next.delete(id) : next.add(id)
    const normalized = normalizeSkillExclusions(next)
    setExcludedSkills(normalized)
    try { setPreview(await fetchPreview(normalized, excludedMemories)) } catch { /* 静默, 字数会过时但勾选状态本地是对的 */ }
  }
  const toggleMemory = async (id: string) => {
    const next = new Set(excludedMemories)
    next.has(id) ? next.delete(id) : next.add(id)
    setExcludedMemories(next)
    try { setPreview(await fetchPreview(excludedSkills, next)) } catch { /* 静默 */ }
  }

  const submit = async () => {
    if (!isPresetMode && isModelQuotaBlocked(model)) {
      setErr(modelQuotaError(model))
      return
    }
    if (isPresetMode) {
      const requiredSessionSkillIds = availableSkills.filter(matchesRequiredSkill).map(sk => sk.id)
      if (requiredSessionSkill && requiredSessionSkillIds.length === 0) {
        setErr(`未找到必选内置 Skill: ${requiredSessionSkill.label || requiredSessionSkill.dirName}`)
        return
      }
      const nextExcludedSkills = Array.from(normalizeSkillExclusions(excludedSkills))
        .filter(id => !requiredSessionSkillIds.includes(id))
      onPresetSaved?.({
        name: name.trim(),
        description: desc.trim(),
        personality,
        model,
        role,
        language,
        existing_session_action: existingSessionAction,
        excluded_skill_ids: nextExcludedSkills,
        excluded_memory_ids: Array.from(excludedMemories),
        required_skill_ids: requiredSessionSkillIds,
        saved_at: new Date().toISOString(),
      })
      return
    }
    setLoading(true); setErr('')
    try {
      const endpoint = isResearch ? `/api/researches/${researchId}/sessions` : `/api/issues/${issueId}/sessions`
      const s = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          name, description: appendAttachmentsToDesc(submittedDescription, attachments), model, role, language,
          excluded_skill_ids: Array.from(excludedSkills),
          excluded_memory_ids: Array.from(excludedMemories),
          continue_from_session_id: continueFromSessionId || undefined,
        }),
      })
      draftClear(DRAFT_KEY)
      if (deferPurpose) markFireAndForgetSession(s?.session_id)
      if (isGuidedDemo && guidedDemo && s?.session_id) patchGuidedDemoState(guidedDemo.kind, { sessionId: s.session_id })
      onCreated(s)
    } catch (e: any) { setErr(e?.message || '创建失败') } finally { setLoading(false) }
  }

  // 统计已勾选(未被排除)的条目数
  const skillCheckedCount = availableSkills.filter(s => matchesRequiredSkill(s) || isChosenAgentSkill(s.id) || (!isMutuallyExclusiveAgentSkill(s.id) && !excludedSkills.has(s.id))).length
  const memoryCheckedCount = availableMemories.filter(m => !excludedMemories.has(m.id)).length
  const projectSkillCount = availableSkills.filter(s => s.scope === 'project').length

  // 目的/描述输入框: preset 模板模式保留自带边框(裸); 正常创建模式下边框透明,
  // 交给 AttachmentComposer 的整合容器统一包边, 使附件芯片/上传按钮与输入框融为一体.
  const descTextarea = (
    <ExpandableTextarea value={desc} onValueChange={value => { setDesc(value); setErr('') }}
      data-tour="session-description-input"
      placeholder={`${isResearch ? `${displayEntityLabel} 目的` : 'Session目的'}/要解决的问题（必填）`}
      overlayTitle={`编辑 ${displayEntityLabel} 目的/问题描述`}
      expandButtonClassName="w-20"
      innerControl={canDeferPurpose ? (
        <button
          type="button"
          onClick={() => { setDeferPurpose(!deferPurpose); setErr('') }}
          className="inline-flex h-6 w-20 items-center gap-1 whitespace-nowrap rounded-lg border px-1.5 text-[10px] transition-colors hover:bg-blue-500/10"
          style={{
            color: 'var(--text-muted)',
            borderColor: 'var(--input-border)',
            background: 'var(--input-bg)',
          }}
        >
          {deferPurpose
            ? <CheckSquare className="h-3 w-3" strokeWidth={1.9} />
            : <Square className="h-3 w-3" strokeWidth={1.9} />}
          <span>稍后再写</span>
        </button>
      ) : undefined}
      className={`w-full h-28 px-3 py-2 text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none resize-none ${isPresetMode ? 'rounded-xl focus:border-blue-500/30' : 'border-0 bg-transparent'}`}
      style={isPresetMode
        ? { background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: isDark ? '#f1f5f9' : '#1e293b' }
        : { color: isDark ? '#f1f5f9' : '#1e293b' }} />
  )

  return (
    <div className={`fixed inset-0 ${modalZIndexClass} flex items-center justify-center`}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div data-tour="session-modal" className="relative rounded-2xl p-6 shadow-2xl flex flex-col" style={{
        width: step === 2 ? 'min(1120px, calc(100vw - 32px))' : 'min(560px, calc(100vw - 32px))',
        height: step === 2 ? 'min(760px, calc(100vh - 32px))' : undefined,
        maxHeight: 'calc(100vh - 32px)',
        background: 'var(--modal-bg)',
        border: '1px solid var(--border-color)',
      }}>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[15px] font-semibold" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>
            {modalTitle || (isPresetMode ? 'Session预设菜单' : `新建 ${displayEntityLabel}`)} · {step === 1 ? '第 1 步 / 共 2 步' : '第 2 步 / 共 2 步'}
          </h3>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex items-center gap-1.5">
              <div className="w-6 h-1 rounded" style={{ background: step >= 1 ? '#3b82f6' : (isDark ? '#374151' : '#e5e7eb') }} />
              <div className="w-6 h-1 rounded" style={{ background: step >= 2 ? '#3b82f6' : (isDark ? '#374151' : '#e5e7eb') }} />
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--bg-card-hover)]"
              style={{ color: isDark ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}
              aria-label="关闭"
              title="关闭"
            >
              <X className="h-4 w-4" strokeWidth={1.8} />
            </button>
          </div>
        </div>

        {step === 1 && (
          <>
            <p className="text-[12px] mb-3 leading-relaxed" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>
              {isPresetMode
                ? '这里只保存未来创建 Session 时要使用的参数，不会立即创建真正的 Session。'
                : `${displayEntityLabel} 创建后, 当前的 Skill 与 Memory 会作为快照定型, 之后修改不影响此 ${displayEntityLabel}.`}
              {requiredSessionSkill && <span className="block mt-1">必选 Skill: {requiredSessionSkill.label || requiredSessionSkill.dirName}</span>}
            </p>
            <div className="flex-1 min-h-0 space-y-3 mb-4 overflow-y-auto overscroll-contain pr-1">
              <input autoFocus value={name} onChange={e => { setName(e.target.value); setErr('') }}
                data-tour="session-name-input"
                placeholder={`${entityNameLabel}（如：修复登录 Bug）`}
                className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: isDark ? '#f1f5f9' : '#1e293b' }} />
              {canDeferPurpose && deferPurpose ? (
                <button
                  type="button"
                  data-tour="session-description-input"
                  onClick={() => { setDeferPurpose(false); setErr('') }}
                  className="w-full min-h-14 rounded-xl border px-3 py-2 text-left text-[13px] font-medium transition-colors hover:bg-blue-500/10"
                  style={{
                    background: isDark ? 'rgba(59,130,246,0.08)' : 'rgba(59,130,246,0.06)',
                    borderColor: isDark ? 'rgba(59,130,246,0.3)' : 'rgba(59,130,246,0.25)',
                    color: isDark ? '#bfdbfe' : '#1d4ed8',
                  }}
                >
                  恢复Session目输入框（Fire & Forget 模式）
                </button>
              ) : isPresetMode ? (
                descTextarea
              ) : (
                <AttachmentComposer attachments={attachments} setAttachments={setAttachments} projectId={projectId} dark={isDark}>
                  {descTextarea}
                </AttachmentComposer>
              )}
              {isResearch && (
                <div>
                  <div className="text-[12px] mb-1.5" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>Research Role（创建后不可更改）</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" disabled={chiefExists}
                      onClick={() => { setRole('chief_researcher'); setErr(''); if (agentSkills.length > 0) setShowAgentSkillModal(true) }}
                      className="min-h-14 rounded-xl text-left px-3 py-2 transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
                      style={{
                        background: role === 'chief_researcher' ? 'rgba(16,185,129,0.12)' : 'var(--input-bg)',
                        border: `1px solid ${role === 'chief_researcher' ? '#10b981' : 'var(--input-border)'}`,
                        color: isDark ? '#f1f5f9' : '#1e293b',
                      }}>
                      <div className="text-[13px] font-medium">chief_researcher</div>
                      <div className="text-[11px]" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>
                        {chiefExists ? '当前 Research 已存在' : '每个 Research 只能有一个'}
                      </div>
                    </button>
                    <button type="button"
                      onClick={() => { setRole('research_assistant'); setErr(''); if (agentSkills.length > 0) setShowAgentSkillModal(true) }}
                      className="min-h-14 rounded-xl text-left px-3 py-2 transition-colors"
                      style={{
                        background: role === 'research_assistant' ? 'rgba(59,130,246,0.12)' : 'var(--input-bg)',
                        border: `1px solid ${role === 'research_assistant' ? '#3b82f6' : 'var(--input-border)'}`,
                        color: isDark ? '#f1f5f9' : '#1e293b',
                      }}>
                      <div className="text-[13px] font-medium">research_assistant</div>
                      <div className="text-[11px]" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>数量不限</div>
                    </button>
                  </div>
                  {agentSkills.length > 0 && (
                    <div className="mt-2 flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-[12px]"
                      style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
                      <div className="min-w-0">
                        <span style={{ color: isDark ? '#9ca3af' : '#64748b' }}>Agent Main Skill: </span>
                        <strong style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>{chosenAgentSkill ? chosenAgentSkill.name : '完全自定义'}</strong>
                      </div>
                      <button type="button" onClick={() => setShowAgentSkillModal(true)}
                        className="shrink-0 text-[11px] px-2 py-0.5 rounded border text-blue-400" style={{ borderColor: 'var(--input-border)' }}>
                        选择 / 更改
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div>
                <div className="text-[12px] mb-1.5 flex items-center justify-between" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>
                  <span>模型（创建后不可更改）</span>
                </div>
                <div data-tour="session-model-picker" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {modelOptions.map(opt => {
                    const active = model === opt.key
                    const backendKey = promptBackendKeyForOption(opt)
                    const count5h = promptStats ? promptStats[backendKey] : null
                    const count5min = promptStats
                      ? (promptStats[`${backendKey}_5min` as `${PromptBackendKey}_5min`] ?? promptStats[`${backendKey}_2min` as `${PromptBackendKey}_2min`] ?? 0)
                      : null
                    const usage = promptStats?.model_usage_limits?.models?.[opt.key] || null
                    const quotaBlocked = !isPresetMode && !!usage?.blocked
                    const blocked = quotaBlocked
                    const tmuxUsage = usage?.usage?.tmuxWindows
                    const tmuxWarning = !!tmuxUsage?.warning
                    const quotaTitle = usage?.limit != null
                      ? `单用户 5 小时 ${usage.count}/${usage.limit} 次${usage.blocked ? ', 已达管理员限额' : `, 剩余 ${usage.remaining} 次`}`
                      : '提问硬限制按管理员配置检查，未配置项不限'
                    const tmuxTitle = tmuxUsage?.limit != null
                      ? `tmux 窗口 ${tmuxUsage.count}/${tmuxUsage.limit}${tmuxWarning ? ', 已达软提醒阈值' : ''}`
                      : 'tmux 窗口未配置限制'
                    const badgeTitle = quotaBlocked
                      ? `${opt.title} ${quotaTitle}, 暂不可选`
                      : `${opt.title} 渠道最近 5 小时 ${count5h} 次提问 / 5 分钟 ${count5min} 次; ${quotaTitle}; ${tmuxTitle}`
                    return (
                      <button key={opt.key} type="button" disabled={blocked} title={badgeTitle} onClick={() => chooseModel(opt.key)}
                        className="relative min-h-16 rounded-xl text-left px-3 py-2 transition-colors disabled:cursor-not-allowed"
                        style={{
                          background: active ? 'rgba(59,130,246,0.12)' : blocked ? 'rgba(239,68,68,0.08)' : 'var(--input-bg)',
                          border: `1px solid ${active ? '#3b82f6' : blocked ? 'rgba(239,68,68,0.32)' : 'var(--input-border)'}`,
                          color: isDark ? '#f1f5f9' : '#1e293b',
                          opacity: blocked ? 0.58 : 1,
                        }}>

                        <div className="text-[13px] font-medium truncate">{opt.title || opt.label}</div>
                        <div className="text-[11px] flex items-baseline gap-1.5 min-w-0" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>
                          <span className="truncate">{opt.sub}</span>
                          {!blocked && usage?.limit != null && (
                            <span className="font-medium whitespace-nowrap" style={{ color: quotaBlocked ? '#ef4444' : (isDark ? '#93c5fd' : '#2563eb') }}>
                              个人5h {usage.count}/{usage.limit} 次
                            </span>
                          )}
                          {!blocked && tmuxWarning && (
                            <span className="font-medium whitespace-nowrap" style={{ color: '#f59e0b' }}>
                              tmux {tmuxUsage?.count}/{tmuxUsage?.limit}
                            </span>
                          )}
                          {blocked && (
                            <span className="font-medium whitespace-nowrap" style={{ color: '#ef4444' }}>
                              已达限额 · 暂不可选
                            </span>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
                {selectedModelUsage?.limit != null && (
                  <div className="mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px]"
                    style={{
                      background: selectedModelUsage.blocked ? 'rgba(239,68,68,0.08)' : 'rgba(59,130,246,0.08)',
                      borderColor: selectedModelUsage.blocked ? 'rgba(239,68,68,0.32)' : 'rgba(59,130,246,0.25)',
                      color: selectedModelUsage.blocked ? '#ef4444' : (isDark ? '#93c5fd' : '#1d4ed8'),
                    }}>
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                    <span>
                      管理员模型限额: 最近 {selectedModelUsage.window_hours} 小时单用户提问 {selectedModelUsage.count}/{selectedModelUsage.limit} 次
                      {selectedModelUsage.blocked
                        ? '，已达限制，请切换模型或稍后再创建。'
                        : `，剩余 ${selectedModelUsage.remaining} 次。`}
                    </span>
                  </div>
                )}
                {promptStats && (
                  <div className="mt-2 text-[12px] font-medium" style={{ color: selectedTmuxWarning ? '#f59e0b' : '#16a34a' }}>
                    {selectedTmuxUsage?.limit != null
                      ? selectedTmuxWarning
                        ? `${selectedModelOption?.label || selectedBackendLabel} tmux 窗口达到软提醒阈值（当前 ${selectedTmuxUsage.count} / ${selectedTmuxUsage.limit}），仍可创建。`
                        : `${selectedModelOption?.label || selectedBackendLabel} tmux 窗口正常（当前 ${selectedTmuxUsage.count} / ${selectedTmuxUsage.limit}）`
                      : `${selectedBackendLabel} 活跃后台窗口 ${selectedActiveWindowCount}`}
                  </div>
                )}
              </div>
              <div>
                <div className="text-[12px] mb-1.5" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>语言（创建后不可更改）</div>
                <div className="grid grid-cols-2 gap-2">
                  {SESSION_LANGUAGE_CHOICES.map(opt => {
                    const active = language === opt.key
                    return (
                      <button key={opt.key} type="button" onClick={() => { setLanguage(opt.key); setErr('') }}
                        className="min-h-16 rounded-xl text-left px-3 py-2 transition-colors"
                        style={{
                          background: active ? 'rgba(59,130,246,0.12)' : 'var(--input-bg)',
                          border: `1px solid ${active ? '#3b82f6' : 'var(--input-border)'}`,
                          color: isDark ? '#f1f5f9' : '#1e293b',
                        }}>
                        <div className="text-[13px] font-medium">{opt.title}</div>
                        <div className="text-[11px]" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>{opt.sub}</div>
                      </button>
                    )
                  })}
                </div>
              </div>
              {isPresetMode && personalityOptions.length > 0 && (
                <div>
                  <div className="text-[12px] mb-1.5" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>性格预设</div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {personalityOptions.map(opt => {
                      const active = personality === opt.key
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => { setPersonality(opt.key); setErr('') }}
                          className="min-h-16 rounded-xl text-left px-3 py-2 transition-colors"
                          style={{
                            background: active ? 'rgba(59,130,246,0.12)' : 'var(--input-bg)',
                            border: `1px solid ${active ? '#3b82f6' : 'var(--input-border)'}`,
                            color: isDark ? '#f1f5f9' : '#1e293b',
                          }}
                        >
                          <div className="text-[13px] font-medium truncate">{opt.label}</div>
                          <div className="mt-0.5 text-[11px] leading-snug" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>{opt.description}</div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {isPresetMode && showExistingSessionAction && (
                <div>
                  <div className="text-[12px] mb-1.5" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>旧session存在时的动作</div>
                  <div className="grid grid-cols-2 gap-2">
                    {EXISTING_SESSION_ACTION_OPTIONS.map(opt => {
                      const active = existingSessionAction === opt.key
                      return (
                        <button key={opt.key} type="button" onClick={() => { setExistingSessionAction(opt.key); setErr('') }}
                          className="min-h-14 rounded-xl text-left px-3 py-2 transition-colors"
                          style={{
                            background: active ? 'rgba(59,130,246,0.12)' : 'var(--input-bg)',
                            border: `1px solid ${active ? '#3b82f6' : 'var(--input-border)'}`,
                            color: isDark ? '#f1f5f9' : '#1e293b',
                          }}>
                          <div className="text-[13px] font-medium">{opt.title}</div>
                          <div className="text-[11px]" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>{opt.sub}</div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
            {err && <ErrBanner>{err}</ErrBanner>}
            <div className="flex gap-2 mt-auto">
              <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: isDark ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
              <button onClick={goPreview} disabled={previewLoading}
                data-tour="session-preview-next"
                className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors disabled:opacity-40">
                {previewLoading ? '加载预览...' : '下一步 · 预览配置'}
              </button>
            </div>
          </>
        )}

        {step === 2 && preview && (
          <>
            <div data-tour="session-preview" className="flex-1 min-h-0 mb-4 overflow-y-auto lg:overflow-hidden pr-1 lg:pr-0">
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,0.92fr)_minmax(320px,1.08fr)] gap-4 lg:h-full lg:min-h-0 lg:overflow-hidden">
                <div className="space-y-3 min-h-0 lg:h-full lg:overflow-y-auto lg:overscroll-contain lg:pr-2">
                  <div className="rounded-lg p-3 text-[11px] leading-relaxed" style={{
                    background: isDark ? 'rgba(59,130,246,0.08)' : 'rgba(59,130,246,0.06)',
                    border: `1px solid ${isDark ? 'rgba(59,130,246,0.3)' : 'rgba(59,130,246,0.25)'}`,
                    color: isDark ? '#93c5fd' : '#1d4ed8',
                  }}>
                    勾选要在本 {displayEntityLabel} 启用的 Skill / Memory. <strong>{isPresetMode ? '保存预设时' : `创建 ${displayEntityLabel} 时`}</strong>会记录这份配置, 首次发消息按配置注入所选智能体, 修改全局 Skill/Memory 不再影响已创建的 {displayEntityLabel}.
                    {isResearch && <div className="mt-1.5">Research Role: <strong>{role}</strong>（创建后不可更改）</div>}
                    <div className="mt-1.5">模型: <strong>{selectedModelOption?.label || SESSION_MODEL_LABEL[model] || model}</strong>（创建后不可更改, 如需更换请返回上一步）</div>
                    <div className="mt-1">语言: <strong>{SESSION_LANGUAGE_LABEL[language]}</strong>（创建后不可更改）</div>
                    {selectedPersonality && <div className="mt-1">性格: <strong>{selectedPersonality?.label}</strong></div>}
                    {requiredSessionSkill && <div className="mt-1">必选 Skill: <strong>{requiredSessionSkill.label || requiredSessionSkill.dirName}</strong></div>}
                  </div>

                  <section data-tour="session-preview-skills">
                    {forcedSkillConflicts.length > 0 && (
                      <div className="mb-2 rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed"
                           style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.35)', color: isDark ? '#fca5a5' : '#b91c1c' }}>
                        <div className="font-medium">【必选skill与当前的skill白名单冲突】</div>
                        <div className="mt-0.5 opacity-90">
                          以下必选 Skill 被白名单过滤, 本次 Session 不会注入: {forcedSkillConflicts.map(s => s.name).join('、')}
                        </div>
                      </div>
                    )}
                    <div className="flex items-center justify-between mb-1.5">
                      <h4 className="text-[12px] font-semibold" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>
                        Skill ({skillCheckedCount}/{availableSkills.length})
                      </h4>
                      {availableSkills.length > 0 && (
                        <div className="flex gap-1.5">
                          <button onClick={() => { const none = normalizeSkillExclusions(new Set<string>()); setExcludedSkills(none); fetchPreview(none, excludedMemories).then(setPreview).catch(() => {}) }}
                            className="text-[10px] px-2 py-0.5 rounded border" style={{ color: isDark ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>全选</button>
                          <button onClick={() => { const all = normalizeSkillExclusions(new Set<string>(availableSkills.map(s => s.id))); setExcludedSkills(all); fetchPreview(all, excludedMemories).then(setPreview).catch(() => {}) }}
                            className="text-[10px] px-2 py-0.5 rounded border" style={{ color: isDark ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>全不选</button>
                        </div>
                      )}
                    </div>
                    <div className="rounded-lg p-2.5 space-y-1.5 text-[11px]" style={{ background: isDark ? '#1f2937' : '#f9fafb', border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}` }}>
                      {availableSkills.length === 0 && <p className="italic" style={{ color: isDark ? '#6b7280' : '#64748b' }}>无 (本 {isResearch ? 'Research' : 'Issue'} 未启用任何 Skill)</p>}
                      {availableSkills.map(sk => {
                        const required = matchesRequiredSkill(sk)
                        const locked = required || isChosenAgentSkill(sk.id)
                        const mutuallyExclusive = isMutuallyExclusiveAgentSkill(sk.id)
                        const checked = locked || (!mutuallyExclusive && !excludedSkills.has(sk.id))
                        return (
                          <div
                            key={sk.id}
                            data-tour={(sk.name === 'mobius-extension' || sk.dirName === 'mobius-extension') ? 'session-preview-mobius-extension-skill' : undefined}
                            className="flex items-start gap-2 hover:bg-[var(--bg-card)] -mx-1 px-1 py-0.5 rounded"
                          >
                            <label className={`flex min-w-0 flex-1 items-start gap-2 ${locked ? 'cursor-default' : mutuallyExclusive ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                              <input type="checkbox" checked={checked} disabled={locked || mutuallyExclusive} onChange={() => toggleSkill(sk.id)}
                                className="mt-0.5 accent-blue-500 cursor-pointer disabled:cursor-not-allowed" />
                              <div className="min-w-0 flex-1" style={{ opacity: mutuallyExclusive ? 0.38 : checked ? 1 : 0.45 }}>
                                <div className="truncate" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>{sk.name}</div>
                                {sk.description && <div className="text-[10px] truncate" style={{ color: isDark ? '#6b7280' : '#64748b' }}>{sk.description}</div>}
                              </div>
                            </label>
                            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                              {locked && <span className="px-1.5 py-0.5 rounded text-[10px] shrink-0" style={{ background: isDark ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.1)', color: isDark ? '#93c5fd' : '#1d4ed8' }}>{required ? '必选' : '主Skill'}</span>}
                              {mutuallyExclusive && <span className="px-1.5 py-0.5 rounded text-[10px] shrink-0" style={{ background: isDark ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.1)', color: isDark ? '#fca5a5' : '#dc2626' }}>互斥</span>}
                              <span className="px-1.5 py-0.5 rounded text-[10px] shrink-0" style={{ background: isDark ? 'rgba(168,85,247,0.15)' : 'rgba(168,85,247,0.1)', color: isDark ? '#c084fc' : '#7e22ce' }}>
                                {SCOPE_LABEL_WIZ[sk.scope] || sk.scope}
                              </span>
                              <button
                                type="button"
                                onClick={() => setPreviewingSkill(sk)}
                                className="inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[10px] transition-colors hover:bg-[var(--bg-card-hover)]"
                                style={{ color: isDark ? '#93c5fd' : '#1d4ed8', borderColor: 'var(--input-border)' }}
                                title={`预览 ${sk.name} 的完整 SKILL.md`}
                                aria-label={`预览 ${sk.name} 的完整 SKILL.md`}
                              >
                                <Eye className="h-3 w-3" strokeWidth={1.8} />
                                <span>预览</span>
                              </button>
                            </div>
                          </div>
                        )
                      })}
                      {availableSkills.length > 0 && !isResearch && (
                        <p className="pt-1 text-[10px] leading-relaxed" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>
                          {projectSkillCount > 0
                            ? `已读取当前项目的 ${projectSkillCount} 个项目级 Skill。创建后会固定为本 ${displayEntityLabel} 的快照。`
                            : `这里没有当前项目的项目级 Skill。其他项目里的 Skill 不会进入本 ${displayEntityLabel}；已有 ${displayEntityLabel} 也不会自动补入新添加的 Skill。`}
                        </p>
                      )}
                    </div>
                  </section>

                  <section data-tour="session-preview-memories">
                    <div className="flex items-center justify-between mb-1.5">
                      <h4 className="text-[12px] font-semibold" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>
                        Memory ({memoryCheckedCount}/{availableMemories.length})
                      </h4>
                      {availableMemories.length > 0 && (
                        <div className="flex gap-1.5">
                          <button onClick={() => { const none = new Set<string>(); setExcludedMemories(none); fetchPreview(excludedSkills, none).then(setPreview).catch(() => {}) }}
                            className="text-[10px] px-2 py-0.5 rounded border" style={{ color: isDark ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>全选</button>
                          <button onClick={() => { const all = new Set<string>(availableMemories.map(m => m.id)); setExcludedMemories(all); fetchPreview(excludedSkills, all).then(setPreview).catch(() => {}) }}
                            className="text-[10px] px-2 py-0.5 rounded border" style={{ color: isDark ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>全不选</button>
                        </div>
                      )}
                    </div>
                    <div className="rounded-lg p-2.5 space-y-1.5 text-[11px]" style={{ background: isDark ? '#1f2937' : '#f9fafb', border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}` }}>
                      {availableMemories.length === 0 && <p className="italic" style={{ color: isDark ? '#6b7280' : '#64748b' }}>无</p>}
                      {availableMemories.map(m => {
                        const checked = !excludedMemories.has(m.id)
                        const memoryTour = isSelfEvolveGuidedDemo
                          ? isSelfEvolveRequiredMemoryItem(m)
                            ? 'session-preview-self-evolve-required-memory'
                            : isSelfEvolveProjectMemoryItem(m)
                              ? 'session-preview-self-evolve-project-memory'
                              : isSelfEvolveGuideMemoryItem(m)
                                ? 'session-preview-self-evolve-guide-memory'
                                : undefined
                          : m.name.includes('莫比乌斯光点标志空间案例') || m.name.includes('莫比乌斯光点 Logo 空间案例')
                            ? 'session-preview-logo-memory'
                            : undefined
                        return (
                          <label
                            key={m.id}
                            data-tour={memoryTour}
                            className="flex items-start gap-2 cursor-pointer hover:bg-[var(--bg-card)] -mx-1 px-1 py-0.5 rounded"
                          >
                            <input type="checkbox" checked={checked} onChange={() => toggleMemory(m.id)}
                              className="mt-0.5 accent-blue-500 cursor-pointer" />
                            <div className="min-w-0 flex-1" style={{ opacity: checked ? 1 : 0.45 }}>
                              <div className="truncate" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>{m.name}</div>
                              {m.description && <div className="text-[10px] truncate" style={{ color: isDark ? '#6b7280' : '#64748b' }}>{m.description}</div>}
                            </div>
                            <span className="px-1.5 py-0.5 rounded text-[10px] shrink-0" style={{ background: isDark ? 'rgba(34,197,94,0.15)' : 'rgba(34,197,94,0.1)', color: isDark ? '#86efac' : '#15803d' }}>
                              {SCOPE_LABEL_WIZ[m.scope] || m.scope}
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </section>
                </div>

                <section className="min-h-[320px] lg:h-full lg:min-h-0 flex flex-col overflow-hidden rounded-lg p-3" style={{ background: isDark ? '#1f2937' : '#f9fafb', border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}` }}>
                  <h4 className="shrink-0 text-[12px] font-semibold mb-2" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>
                    完整注入文本 ({preview.body.length} 字)
                  </h4>
                  <pre className="m-0 flex-1 min-h-[260px] lg:min-h-0 max-h-[45vh] lg:max-h-none overflow-y-auto overscroll-contain text-[10px] leading-snug whitespace-pre-wrap break-words rounded-md p-2"
                    style={{ background: isDark ? '#111827' : '#ffffff', border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`, color: isDark ? '#f1f5f9' : '#1e293b', fontFamily: 'ui-monospace,SFMono-Regular,monospace' }}>
                    {preview.body}
                  </pre>
                </section>
              </div>
            </div>

            {err && <ErrBanner>{err}</ErrBanner>}
            <div className="flex gap-2">
              <button onClick={() => setStep(1)} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: isDark ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>上一步</button>
              <button onClick={submit} disabled={loading}
                data-tour="session-submit"
                className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors disabled:opacity-40">
                {loading ? (isPresetMode ? '保存中...' : '创建中...') : (isPresetMode ? '保存预设' : '确认并创建')}
              </button>
            </div>
          </>
        )}
      </div>

      {previewingSkill && (
        <SessionSkillPreviewDialog
          skill={previewingSkill}
          isDark={isDark}
          onClose={() => setPreviewingSkill(null)}
        />
      )}

      {showAgentSkillModal && (
        <div className="absolute inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowAgentSkillModal(false)} />
          <div className="relative rounded-2xl p-5 shadow-2xl flex flex-col" style={{
            width: 'min(560px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 64px)',
            background: 'var(--modal-bg)', border: '1px solid var(--border-color)',
          }}>
            <h3 className="text-[15px] font-semibold mb-1" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>选择 Research Agent Skill</h3>
            <p className="text-[12px] mb-3 leading-relaxed" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>
              选中后会把「按照该 skill 完成任务」追加到当前 {displayEntityLabel} 目的末尾，并确保该 skill 注入当前 {displayEntityLabel}（第二步不可取消）。
            </p>
            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {agentSkills.map(sk => {
                const active = chosenAgentSkill?.id === sk.id
                return (
                  <button key={sk.id} type="button" onClick={() => chooseAgentSkill(sk)}
                    className="w-full text-left rounded-xl px-3 py-2.5 transition-colors"
                    style={{ background: active ? 'rgba(59,130,246,0.12)' : 'var(--input-bg)', border: `1px solid ${active ? '#3b82f6' : 'var(--input-border)'}` }}>
                    <div className="flex items-center gap-2">
                      <div className="text-[13px] font-medium truncate" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>{sk.name}</div>
                      {sk.research_role && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] shrink-0" style={{ background: isDark ? 'rgba(16,185,129,0.15)' : 'rgba(16,185,129,0.1)', color: isDark ? '#34d399' : '#059669' }}>{sk.research_role}</span>
                      )}
                      <span className="px-1.5 py-0.5 rounded text-[10px] shrink-0 ml-auto" style={{ background: isDark ? 'rgba(168,85,247,0.15)' : 'rgba(168,85,247,0.1)', color: isDark ? '#c084fc' : '#7e22ce' }}>{SCOPE_LABEL_WIZ[sk.scope] || sk.scope}</span>
                    </div>
                    {sk.description && <div className="text-[11px] mt-1" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>{sk.description}</div>}
                  </button>
                )
              })}
              <button type="button" onClick={() => chooseAgentSkill(null)}
                className="w-full text-left rounded-xl px-3 py-2.5 transition-colors"
                style={{ background: !chosenAgentSkill ? 'rgba(59,130,246,0.12)' : 'var(--input-bg)', border: `1px dashed ${!chosenAgentSkill ? '#3b82f6' : 'var(--input-border)'}` }}>
                <div className="text-[13px] font-medium" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>不选择，完全自定义</div>
                <div className="text-[11px] mt-0.5" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>自行填写 {displayEntityLabel} 目的，不绑定任何 research agent skill</div>
              </button>
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => setShowAgentSkillModal(false)}
                className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: isDark ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// =====================================================================
// 重命名 Session
// =====================================================================
export function RenameSessionModal({ session, onClose, onRenamed, entityLabel = 'Session' }: {
  session: any
  onClose: () => void
  onRenamed: (s: any) => void
  entityLabel?: string
}) {
  const [name, setName] = useState(session.name)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const { theme } = useStore()
  const entityNameLabel = entityLabel === 'Session' ? 'Session名称' : `${entityLabel} 名称`
  const entityTitleLabel = entityLabel === 'Session' ? 'Session' : ` ${entityLabel}`
  const submit = async () => {
    if (!name.trim()) { setErr(`请输入${entityLabel === 'Session' ? '' : ' '}${entityNameLabel}`); return }
    setLoading(true); setErr('')
    try {
      const updated = await api(`/api/sessions/${session.session_id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
      onRenamed(updated)
    } catch { setErr('修改失败') } finally { setLoading(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-80 rounded-2xl p-6 shadow-2xl" onClick={e => e.stopPropagation()} style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="text-[15px] font-semibold mb-5" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>重命名{entityTitleLabel}</h3>
        <div className="mb-4">
          <input autoFocus value={name} onChange={e => { setName(e.target.value); setErr('') }}
            placeholder={entityNameLabel} onKeyDown={e => e.key === 'Enter' && submit()}
            className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
        </div>
        {err && <ErrBanner>{err}</ErrBanner>}
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
          <button onClick={submit} disabled={loading}
            className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors disabled:opacity-40">
            {loading ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// 通用确认弹窗
// =====================================================================
export function ConfirmModal({ title, message, onConfirm, onClose, confirmText = '确认', confirmClass = 'bg-red-500 hover:bg-red-600', dataTour, confirmDataTour }: {
  title: string; message: string; onConfirm: () => void | Promise<void>; onClose: () => void; confirmText?: string; confirmClass?: string; dataTour?: string; confirmDataTour?: string
}) {
  const { theme } = useStore()
  const [loading, setLoading] = useState(false)
  const handleConfirm = async () => {
    setLoading(true)
    try { await onConfirm() } finally { setLoading(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div data-tour={dataTour} className="relative w-80 rounded-2xl p-6 shadow-2xl" onClick={e => e.stopPropagation()} style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="text-[15px] font-semibold mb-2" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>{title}</h3>
        <p className="text-[13px] mb-5" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b' }}>{message}</p>
        <div className="flex gap-2">
          <button onClick={onClose} disabled={loading} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border disabled:opacity-40" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
          <button onClick={handleConfirm} disabled={loading}
            data-tour={confirmDataTour}
            className={`flex-1 h-9 rounded-xl text-[13px] text-white transition-colors disabled:opacity-40 ${confirmClass}`}>
            {loading ? '处理中...' : confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// Memory / Skill 跨 scope 移动: 选目标 (用户级 / 某个项目)
// 用户级条目调用时 lockToProject=true (只能选目标项目);
// 项目级条目则 user / project 二选一.
// =====================================================================
export function MoveScopeModal({
  title, currentScopeLabel, lockToProject = false, onClose, onMove,
}: {
  title: string
  currentScopeLabel: string
  lockToProject?: boolean
  onClose: () => void
  onMove: (target: { scope: 'user' | 'project'; projectId?: string }) => Promise<void>
}) {
  const { theme } = useStore()
  const isDark = theme !== 'light'
  const textPrimary = isDark ? '#f1f5f9' : '#1e293b'
  const textMuted = isDark ? '#9ca3af' : '#64748b'
  const [projects, setProjects] = useState<any[]>([])
  const [scope, setScope] = useState<'user' | 'project'>(lockToProject ? 'project' : 'user')
  const [projectId, setProjectId] = useState<string>('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api('/api/projects')
      .then((arr: any[]) => { setProjects(Array.isArray(arr) ? arr : []); setLoading(false) })
      .catch(() => { setProjects([]); setLoading(false) })
  }, [])

  const submit = async () => {
    if (scope === 'project' && !projectId) { setErr('请选择目标项目'); return }
    setErr(''); setSaving(true)
    try {
      await onMove({ scope, projectId: scope === 'project' ? projectId : undefined })
    } catch (e: any) {
      setErr(e?.message || '移动失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-[420px] rounded-2xl p-5 shadow-2xl" onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="text-[14px] font-semibold mb-1" style={{ color: textPrimary }}>{title}</h3>
        <p className="text-[11px] mb-4" style={{ color: textMuted }}>当前位置: {currentScopeLabel}</p>

        {!lockToProject && (
          <div className="mb-3">
            <label className="text-[11px] mb-1 block" style={{ color: textMuted }}>目标</label>
            <div className="flex gap-2">
              <button onClick={() => setScope('user')} disabled={saving}
                className={`flex-1 h-8 rounded text-[12px] border transition-colors ${scope === 'user' ? 'bg-blue-500/15 border-blue-500/40 text-blue-400' : ''}`}
                style={scope === 'user' ? {} : { color: textMuted, borderColor: 'var(--input-border)' }}>
                我的 (用户级)
              </button>
              <button onClick={() => setScope('project')} disabled={saving}
                className={`flex-1 h-8 rounded text-[12px] border transition-colors ${scope === 'project' ? 'bg-blue-500/15 border-blue-500/40 text-blue-400' : ''}`}
                style={scope === 'project' ? {} : { color: textMuted, borderColor: 'var(--input-border)' }}>
                项目级
              </button>
            </div>
          </div>
        )}

        {scope === 'project' && (
          <div className="mb-3">
            <label className="text-[11px] mb-1 block" style={{ color: textMuted }}>选择目标项目</label>
            {loading ? (
              <div className="text-[12px] py-1" style={{ color: textMuted }}>加载中...</div>
            ) : projects.length === 0 ? (
              <div className="text-[12px] py-1" style={{ color: textMuted }}>暂无可选项目</div>
            ) : (
              <select value={projectId} onChange={e => { setProjectId(e.target.value); setErr('') }}
                disabled={saving}
                className="w-full h-8 px-2 rounded text-[12px] focus:outline-none focus:border-blue-500/30"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}>
                <option value="">-- 请选择 --</option>
                {projects.map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {err && <pre className="text-[11px] text-red-400 mb-3 whitespace-pre-wrap break-all max-h-32 overflow-auto">{err}</pre>}

        <div className="flex gap-2">
          <button onClick={onClose} disabled={saving}
            className="flex-1 h-8 rounded text-[12px] border disabled:opacity-40"
            style={{ color: textMuted, borderColor: 'var(--input-border)' }}>取消</button>
          <button onClick={submit} disabled={saving || loading || (scope === 'project' && !projectId)}
            className="flex-1 h-8 rounded text-[12px] bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-40">
            {saving ? '移动中...' : '移动'}
          </button>
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// Turn 历史
// =====================================================================
export function TurnTree({ sessionId, onClose, onRefresh }: { sessionId: string; onClose: () => void; onRefresh?: (data: any[]) => void }) {
  const [turns, setTurns] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const { theme } = useStore()
  const isDark = theme !== 'light'
  const textPrimary = isDark ? '#f1f5f9' : '#1e293b'
  const textMuted = isDark ? '#6b7280' : '#94a3b8'

  useEffect(() => {
    api(`/api/sessions/${sessionId}/turns`).then(data => {
      setTurns(data); setLoading(false)
      onRefresh?.(data)
    }).catch(() => setLoading(false))
  }, [sessionId])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-[680px] max-h-[75vh] rounded-2xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()} style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            <h3 className="text-[14px] font-semibold" style={{ color: textPrimary }}>对话轮次历史</h3>
            <span className="text-[11px] px-2 py-0.5 rounded bg-[var(--bg-card-hover)]" style={{ color: textMuted }}>{turns.length} 轮</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-card-hover)] transition-colors" style={{ color: textMuted }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {loading && <div className="text-center py-8 text-[13px]" style={{ color: textMuted }}>加载中...</div>}
          {!loading && turns.length === 0 && <div className="text-center py-8 text-[13px]" style={{ color: textMuted }}>暂无对话记录</div>}
          {turns.map(t => (
            <details key={t.turn_number} className="group rounded-xl border overflow-hidden" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}>
              <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-[var(--bg-card)] transition-colors">
                <div className="w-7 h-7 rounded-full bg-blue-500/15 flex items-center justify-center text-[12px] font-semibold text-blue-400 flex-shrink-0">
                  {t.turn_number}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium truncate" style={{ color: textPrimary }}>
                    {t.user_input || '(用户输入)'}
                  </div>
                  <div className="text-[11px] mt-0.5 truncate" style={{ color: textMuted }}>
                    {t.agent_output || '(Agent 输出)'}
                  </div>
                </div>
                <div className="text-[10px] flex-shrink-0" style={{ color: textMuted }}>
                  {timeAgo(t.created_at)}
                </div>
                <svg className="w-3.5 h-3.5 flex-shrink-0 transition-transform group-open:rotate-90" style={{ color: textMuted }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
              </summary>
              <div className="border-t px-4 py-3 space-y-2" style={{ borderColor: 'var(--border-color)' }}>
                <div>
                  <div className="text-[12px] font-semibold mb-1" style={{ color: textMuted }}>用户输入</div>
                  <div className="text-[12px] px-3 py-2 rounded-lg" style={{ background: 'var(--input-bg)', color: textPrimary }}>
                    {t.user_input ? <ReactMarkdown className="prose-sm prose-invert">{t.user_input}</ReactMarkdown> : <span style={{ color: textMuted }}>(无)</span>}
                  </div>
                </div>
                <div>
                  <div className="text-[12px] font-semibold mb-1" style={{ color: textMuted }}>Agent 输出</div>
                  <div className="text-[12px] px-3 py-2 rounded-lg max-h-[300px] overflow-y-auto" style={{ background: 'var(--input-bg)', color: textPrimary }}>
                    {t.agent_output ? <ReactMarkdown className="prose-sm prose-invert">{t.agent_output}</ReactMarkdown> : <span style={{ color: textMuted }}>(无)</span>}
                  </div>
                </div>
              </div>
            </details>
          ))}
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// 修改密码
// =====================================================================
export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [err, setErr] = useState('')
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)
  const { theme } = useStore()

  const submit = async () => {
    if (!oldPw) { setErr('请输入原密码'); return }
    if (newPw.length < 6) { setErr('新密码至少 6 位'); return }
    if (newPw !== confirmPw) { setErr('两次输入的新密码不一致'); return }
    setLoading(true); setErr('')
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      })
      setSuccess(true)
      setTimeout(onClose, 1500)
    } catch {
      setErr('原密码错误')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-80 rounded-2xl p-6 shadow-2xl" onClick={e => e.stopPropagation()} style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="text-[15px] font-semibold mb-5" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>修改密码</h3>
        {success ? (
          <div className="text-center py-4">
            <div className="text-green-400 text-[14px] mb-1">密码修改成功</div>
            <div className="text-[12px]" style={{ color: theme !== 'light' ? '#6b7280' : '#94a3b8' }}>即将关闭...</div>
          </div>
        ) : (
          <>
            <div className="space-y-3 mb-4">
              <input type="password" placeholder="原密码" value={oldPw}
                onChange={e => { setOldPw(e.target.value); setErr('') }}
                className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
              <input type="password" placeholder="新密码（至少 6 位）" value={newPw}
                onChange={e => { setNewPw(e.target.value); setErr('') }}
                className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
              <input type="password" placeholder="确认新密码" value={confirmPw}
                onChange={e => { setConfirmPw(e.target.value); setErr('') }}
                onKeyDown={e => e.key === 'Enter' && submit()}
                className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
            </div>
            {err && <ErrBanner>{err}</ErrBanner>}
            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border transition-colors" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
              <button onClick={submit} disabled={loading}
                className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors disabled:opacity-40">
                {loading ? '提交中...' : '确认修改'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}


// =====================================================================
// AimuxGuideModal — 展示如何用 aimux bridge client 反向连接到当前 server
//   - 外部 aimux client 不直连 bridge (bridge 只 bind 127.0.0.1)
//   - 而是走 mobius 反代 /aimux_bridge/*, 用当前用户的 mobius JWT 作 --token
//   - mobius proxy 内部把 JWT 换成 bridge Bearer 再转发
// =====================================================================
const AIMUX_IDENTIFIER_STORAGE_KEY = 'mobius.aimux.guide.identifier'

export function AimuxGuideModal({ onClose }: { onClose: () => void }) {
  const { theme } = useStore()
  const [copied, setCopied] = useState<string>('')
  const [remotes, setRemotes] = useState<Array<{ name: string; status: string; platform: string; default_profile?: string; last_seen?: string }>>([])
  const [remotesErr, setRemotesErr] = useState('')
  // 默认 identifier 随机生成 (复用 randomProjectSlug → adjective_noun, 字符为字母+_, 符合 identifier 规则),
  // 避免多台外部机器都叫 my-windows-box 在 mobius 里重名; 用户可自行覆盖, 留空则回退到该随机值
  const defaultIdentifier = useMemo(() => randomProjectSlug(), [])
  const [identifier, setIdentifier] = useState<string>(() => {
    if (typeof window === 'undefined') return defaultIdentifier
    try {
      const saved = window.localStorage.getItem(AIMUX_IDENTIFIER_STORAGE_KEY)
      return saved && saved.trim() ? saved : defaultIdentifier
    } catch {
      return defaultIdentifier
    }
  })

  const handleIdentifierChange = (v: string) => {
    // identifier 仅用于命令行参数, 不接受空白; 其余字符交由 bridge 校验
    const cleaned = v.replace(/\s+/g, '')
    setIdentifier(cleaned)
    try {
      if (cleaned.trim()) {
        window.localStorage.setItem(AIMUX_IDENTIFIER_STORAGE_KEY, cleaned)
      } else {
        window.localStorage.removeItem(AIMUX_IDENTIFIER_STORAGE_KEY)
      }
    } catch {
      // localStorage 不可用时静默降级, 仅内存生效
    }
  }

  // 拼装外部可达的 base URL:
  //   - localhost / 127.0.0.1 / 192.168.* / 10.* / 172.16-31.* (内网/dev):
  //     直接用 window.location (含端口), 方便本机调试
  //   - 公网域名 (mobius.example.com 等):
  //     强制 https + 无 port (公网入口都走 443 反代; 即使浏览器通过 http://domain:45616 直连 mobius,
  //     外部 aimux client 也无法达到那个非标端口, 必须走 https 443).
  const browserHost = typeof window !== 'undefined' ? window.location.hostname : 'server-host'
  const browserPort = typeof window !== 'undefined' ? window.location.port : ''
  const isInternalHost = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(browserHost)
  const baseUrl = isInternalHost
    ? `${window.location.protocol}//${browserHost}${browserPort ? ':' + browserPort : ''}/aimux_bridge`
    : `https://${browserHost}/aimux_bridge`
  const displayProto = isInternalHost ? window.location.protocol.replace(/:$/, '') : 'https'
  const displayPort = isInternalHost
    ? (browserPort || (displayProto === 'https' ? '443' : '80'))
    : '443'
  const userJwt = typeof window !== 'undefined' ? (localStorage.getItem('cc-token') || '<未登录>') : '<JWT>'
  // 输入为空时回退到默认值, 避免生成 --identifier 空参数导致命令非法
  const effectiveIdentifier = identifier.trim() || defaultIdentifier

  const installCmd = 'pip install --force-reinstall aimux==0.1.7'
  const connectCmd = `aimux reverse connect ${baseUrl} --identifier ${effectiveIdentifier} --token ${userJwt}`

  const refreshRemotes = useCallback(() => {
    api('/aimux_bridge/api/remotes').then((data: any) => {
      const list = Array.isArray(data?.remotes) ? data.remotes : []
      setRemotes(list)
      setRemotesErr('')
    }).catch((e: any) => {
      setRemotesErr(e?.message || 'bridge 不可用')
      setRemotes([])
    })
  }, [])

  useEffect(() => {
    refreshRemotes()
    const id = setInterval(refreshRemotes, 3000)
    return () => clearInterval(id)
  }, [refreshRemotes])

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      setTimeout(() => setCopied(''), 1500)
    } catch {
      setCopied('')
    }
  }

  const SectionTitle = ({ children }: { children: any }) => (
    <div className="text-[12px] font-semibold mb-2 mt-4 first:mt-0" style={{ color: theme !== 'light' ? '#cbd5e1' : '#334155' }}>{children}</div>
  )

  const CodeBlock = ({ label, text }: { label: string; text: string }) => (
    <div className="relative">
      <pre className="text-[12px] rounded-lg p-3 pr-20 overflow-x-auto whitespace-pre-wrap break-all"
        style={{ background: theme !== 'light' ? '#0f172a' : '#f1f5f9', color: theme !== 'light' ? '#e2e8f0' : '#1e293b', border: '1px solid var(--border-color)' }}>
        {text}
      </pre>
      <button onClick={() => copy(label, text)}
        className="absolute top-1.5 right-1.5 px-2 h-7 rounded-md text-[11px] border transition-colors"
        style={{ background: 'var(--bg-card-hover)', borderColor: 'var(--border-color)', color: theme !== 'light' ? '#94a3b8' : '#475569' }}>
        {copied === label ? '已复制' : '复制'}
      </button>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[560px] max-w-[92vw] max-h-[85vh] overflow-y-auto rounded-2xl p-6 shadow-2xl"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-[15px] font-semibold" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>AIMUX 连接指引</h3>
            <div className="text-[11px] mt-0.5" style={{ color: theme !== 'light' ? '#6b7280' : '#94a3b8' }}>
              把外部机器 (Windows/Mac/Linux) 反向连到本 server, 即可在 mobius 里直接调度它
            </div>
          </div>
          <button onClick={onClose} className="text-[18px] leading-none opacity-60 hover:opacity-100" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b' }}>×</button>
        </div>

        <SectionTitle>1. 在外部机器上安装 aimux (Python 3.10+)</SectionTitle>
        <CodeBlock label="install" text={installCmd} />

        <SectionTitle>2. 启动反向连接 (走 mobius /aimux_bridge 反代)</SectionTitle>
        <div className="mb-2">
          <div className="text-[11px] mb-1" style={{ color: theme !== 'light' ? '#94a3b8' : '#64748b' }}>identifier ( mobius 以此名字显示该机器, 默认随机生成, 留空回退 {defaultIdentifier} )</div>
          <input
            value={identifier}
            onChange={e => handleIdentifierChange(e.target.value)}
            placeholder={defaultIdentifier}
            spellCheck={false}
            autoComplete="off"
            className="w-full h-8 px-3 rounded-xl text-[13px] font-mono border outline-none focus:border-blue-400"
            style={{ background: 'var(--modal-bg)', color: 'var(--text-primary)', borderColor: 'var(--input-border)' }} />
        </div>
        <div className="text-[11px] mb-2 space-y-1" style={{ color: theme !== 'light' ? '#6b7280' : '#94a3b8' }}>
          <div>
            <code className="px-1 rounded" style={{ background: 'var(--bg-card-hover)' }}>--identifier</code> 改成你想要的名字 (字母/数字/_.-), mobius 会以这个名字显示该机器
          </div>
          <div>
            <code className="px-1 rounded" style={{ background: 'var(--bg-card-hover)' }}>--token</code> 是你当前登录 mobius 的 JWT (上方已自动填入), 7 天有效
          </div>
        </div>
        <CodeBlock label="connect" text={connectCmd} />

        <SectionTitle>3. 在 mobius 中验证</SectionTitle>
        <div className="text-[12px] mb-2" style={{ color: theme !== 'light' ? '#cbd5e1' : '#334155' }}>
          连接成功后, 该机器会出现在下方列表 (每 3 秒刷新), 即可在 mobius 里向它发 <code className="px-1 rounded" style={{ background: 'var(--bg-card-hover)' }}>session.create</code> / <code className="px-1 rounded" style={{ background: 'var(--bg-card-hover)' }}>send-keys</code> / <code className="px-1 rounded" style={{ background: 'var(--bg-card-hover)' }}>capture</code> 等指令
        </div>

        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-color)' }}>
          <div className="flex items-center justify-between px-3 py-1.5 text-[11px]" style={{ background: 'var(--bg-card-hover)', color: theme !== 'light' ? '#94a3b8' : '#64748b' }}>
            <span>已连接的 bridge clients ({remotes.length})</span>
            <span>每 3 秒刷新</span>
          </div>
          {remotesErr ? (
            <div className="px-3 py-3 text-[12px]" style={{ color: '#ef4444' }}>{remotesErr}</div>
          ) : remotes.length === 0 ? (
            <div className="px-3 py-3 text-[12px]" style={{ color: theme !== 'light' ? '#6b7280' : '#94a3b8' }}>
              暂无 client 连接. 在外部机器上执行上面的命令, 几秒后这里会出现它
            </div>
          ) : (
            <div className="max-h-[180px] overflow-y-auto">
              {remotes.map((r, i) => (
                <div key={r.name + i} className="flex items-center gap-2 px-3 py-1.5 text-[12px]" style={{ borderTop: i > 0 ? '1px solid var(--border-color)' : 'none' }}>
                  <span className={r.status === 'connected' ? 'w-1.5 h-1.5 rounded-full bg-green-500' : 'w-1.5 h-1.5 rounded-full bg-gray-400'} />
                  <span className="font-mono" style={{ color: theme !== 'light' ? '#e2e8f0' : '#1e293b' }}>{r.name}</span>
                  <span className="opacity-50">·</span>
                  <span style={{ color: theme !== 'light' ? '#94a3b8' : '#64748b' }}>{r.platform || '?'}</span>
                  <span className="opacity-50">·</span>
                  <span style={{ color: theme !== 'light' ? '#94a3b8' : '#64748b' }}>{r.default_profile || '?'}</span>
                  <span className="ml-auto text-[10px]" style={{ color: r.status === 'connected' ? '#22c55e' : '#94a3b8' }}>{r.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 pt-3 border-t text-[11px] space-y-1" style={{ borderColor: 'var(--border-color)', color: theme !== 'light' ? '#6b7280' : '#94a3b8' }}>
          <div>endpoint: <code className="px-1 rounded" style={{ background: 'var(--bg-card-hover)' }}>{baseUrl}</code> ({displayProto.toUpperCase()} · host: {browserHost} · port: {displayPort})</div>
          <div>bridge broker 仅 bind 127.0.0.1, 外部不可达; 所有外部流量都经 mobius /aimux_bridge/* 反代</div>
          <div>JWT 透传给反代, 由 mobius 内部换成 bridge Bearer; bridge token 不暴露给客户端</div>
        </div>

        <div className="flex justify-end mt-5">
          <button onClick={onClose} className="h-9 px-5 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border transition-colors"
            style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>关闭</button>
        </div>
      </div>
    </div>
  )
}
//   - 拉 /api/sessions/:id/turns, 把每轮的 turn_summary 拼成草稿
//   - 用户改写名称 / 描述 / 正文, 选 scope (user/project)
//   - 提交时按 scope 走对应的 POST memory 接口
// =====================================================================
export function SinkAsMemoryModal({ sessionId, sessionName, projectId, onClose, onCreated }: {
  sessionId: string
  sessionName?: string
  projectId?: string | null
  onClose: () => void
  onCreated?: (m: any) => void
}) {
  const { theme } = useStore()
  const isDark = theme !== 'light'
  const textPrimary = isDark ? '#f1f5f9' : '#1e293b'
  const textMuted = isDark ? '#9ca3af' : '#64748b'

  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [body, setBody] = useState('')
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [turnsLoading, setTurnsLoading] = useState(true)
  const [turnsCount, setTurnsCount] = useState(0)
  const [summaryCount, setSummaryCount] = useState(0)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    const ymd = new Date().toISOString().slice(0, 10)
    setName(`沉淀自「${sessionName || '会话'}」@ ${ymd}`)
    setTurnsLoading(true); setErr('')
    api(`/api/sessions/${sessionId}/turns`).then((turns: any[]) => {
      // 把每轮的 user_input + agent_output 完整拼成 Markdown 草稿, 用户自己在 textarea 里裁剪.
      const rows = (turns || []).filter(t => t && t.turn_number != null)
      setTurnsCount(rows.length)
      setSummaryCount(rows.filter(t => (t.turn_summary || '').toString().trim()).length)
      const blocks: string[] = []
      for (const t of rows) {
        const userInput = (t.user_input || '').toString().trim()
        const agentOutput = (t.agent_output || '').toString().trim()
        const summary = (t.turn_summary || '').toString().trim()
        const parts: string[] = [`### 轮 ${t.turn_number}`]
        if (summary) parts.push(`> ${summary}`)
        if (userInput) parts.push(`**🧑 用户提问**\n\n${userInput}`)
        if (agentOutput) parts.push(`**🤖 Agent 回复**\n\n${agentOutput}`)
        blocks.push(parts.join('\n\n'))
      }
      const fallback = '<!-- 该会话还没有任何轮次, 请手写本条 Memory 的内容 -->'
      const header = `## 来自会话「${sessionName || ''}」的完整对话\n\n`
      setBody(blocks.length > 0 ? header + blocks.join('\n\n---\n\n') : fallback)
    }).catch(e => setErr(e?.message || '加载会话轮次失败')).finally(() => setTurnsLoading(false))
  }, [sessionId, sessionName])

  const submit = async () => {
    if (!name.trim()) { setErr('请填写 Memory 名称'); return }
    if (!body.trim()) { setErr('Memory 正文不能为空'); return }
    if (scope === 'project' && !projectId) { setErr('当前会话没有所属项目, 无法保存为项目级 Memory'); return }
    setSaving(true); setErr('')
    try {
      const payload = JSON.stringify({ name: name.trim(), description: desc.trim(), body: body.trim() })
      let url = '/api/memories'
      if (scope === 'project' && projectId) url = `/api/projects/${projectId}/memories`
      const m = await api(url, { method: 'POST', body: payload })
      onCreated?.(m)
      onClose()
    } catch (e: any) {
      setErr(e?.message || '保存失败')
    } finally { setSaving(false) }
  }

  const scopeButton = (s: 'user' | 'project', label: string, disabled = false) => (
    <button onClick={() => !disabled && setScope(s)} disabled={disabled}
      className={`flex-1 h-9 rounded-lg text-[12px] border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        scope === s
          ? (isDark ? 'bg-rose-500/15 text-rose-300 border-rose-500/30' : 'bg-rose-500/10 text-rose-700 border-rose-500/30')
          : 'bg-[var(--bg-card)] text-[var(--text-secondary)] border-[var(--border-color-strong)] hover:bg-[var(--bg-card-hover)]'
      }`}>
      {label}
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-[640px] max-h-[85vh] rounded-2xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()} style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-2">
            <span className="text-rose-400 text-[14px]">📌</span>
            <h3 className="text-[14px] font-semibold" style={{ color: textPrimary }}>沉淀为 Memory</h3>
            {!turnsLoading && (
              <span className="text-[10px] px-2 py-0.5 rounded border" style={{ borderColor: 'var(--input-border)', color: textMuted }}>
                {turnsCount === 0 ? '会话暂无轮次' :
                  `已拼入 ${turnsCount} 轮完整对话` + (summaryCount > 0 ? ` (含 ${summaryCount} 条 hook 摘要)` : '')}
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--bg-card-hover)] transition-colors" style={{ color: textMuted }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          <div className="rounded-lg p-3 text-[11px] leading-relaxed" style={{
            background: isDark ? 'rgba(244,63,94,0.06)' : 'rgba(244,63,94,0.04)',
            border: `1px solid ${isDark ? 'rgba(244,63,94,0.25)' : 'rgba(244,63,94,0.2)'}`,
            color: isDark ? '#fda4af' : '#9f1239',
          }}>
            保存后,本 Memory 会按所选 scope 自动注入到符合条件的<strong>新会话</strong>(用户级 → 你创建的所有 Issue;项目级 → 该项目下所有 Issue).
          </div>

          <div>
            <label className="text-[11px] mb-1 block" style={{ color: textMuted }}>Memory 名称 (必填)</label>
            <input value={name} onChange={e => { setName(e.target.value); setErr('') }}
              className="w-full px-3 py-2 rounded-lg text-[12px] focus:outline-none focus:border-blue-500/30"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: textPrimary }} />
          </div>

          <div>
            <label className="text-[11px] mb-1 block" style={{ color: textMuted }}>简介 (可选, 用于列表展示)</label>
            <input value={desc} onChange={e => { setDesc(e.target.value); setErr('') }}
              placeholder="例: 调试 SSO 重定向 loop 的根因和修复路径"
              className="w-full px-3 py-2 rounded-lg text-[12px] focus:outline-none focus:border-blue-500/30"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: textPrimary }} />
          </div>

          <div>
            <label className="text-[11px] mb-1 block" style={{ color: textMuted }}>正文 (草稿已预填,可任意改写)</label>
            <textarea value={body} onChange={e => { setBody(e.target.value); setErr('') }}
              disabled={turnsLoading}
              className="w-full px-3 py-2 rounded-lg text-[12px] font-mono leading-snug resize-y focus:outline-none focus:border-blue-500/30 disabled:opacity-50"
              rows={22}
              style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: textPrimary, maxHeight: '50vh' }} />
          </div>

          <div>
            <label className="text-[11px] mb-1.5 block" style={{ color: textMuted }}>保存到</label>
            <div className="flex gap-2">
              {scopeButton('user', '用户级 (仅我可见)')}
              {scopeButton('project', '项目级' + (projectId ? '' : ' (无项目)'), !projectId)}
            </div>
          </div>
        </div>

        {err && <div className="px-6 pb-2 text-[12px] text-red-400">{err}</div>}
        <div className="px-6 py-3 border-t flex justify-end gap-2 flex-shrink-0" style={{ borderColor: 'var(--border-color)' }}>
          <button onClick={onClose} className="h-9 px-4 rounded-lg text-[12px] border" style={{ borderColor: 'var(--input-border)', color: textMuted }}>
            取消
          </button>
          <button onClick={submit} disabled={saving || turnsLoading}
            className="h-9 px-4 rounded-lg text-[12px] text-white bg-rose-500 hover:bg-rose-600 transition-colors disabled:opacity-40">
            {saving ? '保存中...' : '沉淀'}
          </button>
        </div>
      </div>
    </div>
  )
}
