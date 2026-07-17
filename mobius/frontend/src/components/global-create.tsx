// =====================================================================
// 全局「+」统一新建菜单 — 4 类创建单页弹窗 (Project / Issue / Session / Research Agent)
//
// 设计目标 (需求任务1):
//   - 顶栏 [+] 下拉 4 入口; 每类创建均为**单页弹窗**, 无分步跳转.
//   - Skill / Memory 用**二级浮层 (popover)** 选择, 不新开页面.
//   - Session / Research Agent 弹窗内置附件上传 (拖拽 / Ctrl+V 粘贴 / 按钮).
//   - 表单记忆持久化 (localStorage 草稿, 关闭后回填).
//   - 动态数据刷新: 中途新建的 project/issue/research 可被下拉重新读到.
//   - Research Agent: 前置 research_enabled 校验 + 主 Skill 关联锁定 / 冲突互斥禁用.
//   - 创建成功 → 次级确认弹窗, 「跳转详情」新开浏览器 Tab.
//
// 不改动 modals.tsx 现有组件 (页面内创建流程零风险), 仅复用其底层 export.
// =====================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore, api } from '../store'
import { useIsMobile } from './resizable-panel'
import { draftLoad, draftSave, draftClear } from '../services/input-drafts'
import { fetchGlobalDefaultModel, resolveDefaultModelKey } from '../services/global-default-model'
import { ErrBanner, PathPickerModal, PcTaskModeSection } from './modals'
import { ToggleSwitch } from './toggle-switch'
import { SessionModelPicker } from './session-model-picker'
import { ExpandableTextarea } from './expandable-textarea'
import { type Attachment, newAttId, formatFileSize, uploadAttachmentFile, appendAttachmentsToDesc } from './attachments'
import {
  Plus, ChevronDown, FolderPlus, CircleDot, MessagesSquare, FlaskConical,
  X, Eye, RefreshCw, Paperclip, Image as ImageIcon, Trash2,
  CheckCircle2, ExternalLink, Lock, Ban, Search, Dices, FolderOpen,
} from 'lucide-react'

// ---------------------------------------------------------------------
// 类型 & 常量
// ---------------------------------------------------------------------
export type CreateKind = 'project' | 'issue' | 'session' | 'research'

type Visibility = 'private' | 'team' | 'public' | 'allowlist'
const VISIBILITY_OPTIONS: { value: Visibility; label: string; desc: string }[] = [
  { value: 'private', label: '仅自己', desc: '仅创建者可见' },
  { value: 'team', label: '同组', desc: '同一用户组可见' },
  { value: 'public', label: '公开', desc: '所有登录用户可见' },
  { value: 'allowlist', label: '指定用户', desc: '仅指定用户/组可见' },
]

// Issue 可见性: inherit 跟随项目, 其余档位不能比父项目更宽 (反向放大禁止)
type IssueVisibility = 'inherit' | Visibility
const ISSUE_VISIBILITY_OPTIONS: { value: IssueVisibility; label: string; desc: string }[] = [
  { value: 'inherit', label: '继承项目', desc: '跟随所属项目的可见性' },
  { value: 'private', label: '仅自己', desc: '仅创建者与项目 owner / 管理员可见' },
  { value: 'team', label: '同组', desc: '同一群组用户可见（前提是能看到项目）' },
  { value: 'public', label: '项目可见者', desc: '所有能看到项目的登录用户都可见' },
  { value: 'allowlist', label: '指定用户', desc: '仅允许名单中的用户可见' },
]

// 项目类型预设: 顶栏单页新建项目, 用下拉选择类型, 选定后下方字段联动
type ProjectKind = 'default' | 'research' | 'extension'
const PROJECT_KIND_PRESETS: Array<{
  kind: ProjectKind
  label: string
  desc: string
  note: string
}> = [
  {
    kind: 'default',
    label: '经典项目',
    desc: '导入或新建项目，后续可转研究',
    note: '默认不开研究',
  },
  {
    kind: 'research',
    label: '研究项目',
    desc: '多智能体长周期开放研究',
    note: '自动启用研究',
  },
  {
    kind: 'extension',
    label: '拓展项目',
    desc: '有前端 + 后端的莫比乌斯拓展',
    note: '仅管理员可创建',
  },
]

// 项目随机绑定路径生成器 (对齐 modals.tsx 行为)
const RANDOM_PROJECT_ADJECTIVES = ['bright', 'calm', 'clever', 'cozy', 'fresh', 'gentle', 'lively', 'lovely', 'lucky', 'merry', 'neat', 'quiet', 'rapid', 'smart', 'sunny', 'tidy', 'warm', 'wise']
const RANDOM_PROJECT_NOUNS = ['bird', 'brook', 'cloud', 'field', 'forest', 'garden', 'harbor', 'lake', 'leaf', 'meadow', 'moon', 'mountain', 'river', 'seed', 'snake', 'spark', 'star', 'stone', 'sun', 'tree', 'valley', 'wave', 'wind']
function randomProjectSlug() {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)] || arr[0]
  return `${pick(RANDOM_PROJECT_ADJECTIVES)}_${pick(RANDOM_PROJECT_NOUNS)}`
}
function randomProjectBindPath(workDir?: string | null) {
  const root = (workDir || '').trim().replace(/\/+$/, '')
  if (!root) return ''
  return `${root}/${randomProjectSlug()}`.replace(/\/{2,}/g, '/')
}

type SessionLanguage = 'zh' | 'en'
const LANGUAGE_CHOICES: { key: SessionLanguage; title: string }[] = [
  { key: 'zh', title: '中文' },
  { key: 'en', title: 'English' },
]

// 全局默认模型 (项目无 default_model 且用户未手动改时回落). 与 modals.tsx 的 DEFAULT_SESSION_MODEL 同值 'codex'.
// 模型选择 UI + 配额/超额禁用统一走共享组件 SessionModelPicker (复刻 NewSessionModal 的 grid 卡片).
const GLOBAL_DEFAULT_MODEL = 'codex'

type PickItem = {
  id: string
  name: string
  description?: string
  scope: string
  research_role?: string
  dirName?: string | null
}
export type { PickItem, SessionLanguage }
const SCOPE_LABEL: Record<string, string> = { user: '用户级', project: '项目级', builtin: '内置', issue: '任务级' }

// ---------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------
function modalShellStyle(isDark: boolean): React.CSSProperties {
  return { background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }
}

// ---------------------------------------------------------------------
// 通用小组件
// ---------------------------------------------------------------------
function SectionLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between mb-1.5">
      <label className="block text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>{children}</label>
      {hint && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{hint}</span>}
    </div>
  )
}

function TextInput(props: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; onEnter?: () => void; dark: boolean }) {
  const { value, onChange, placeholder, autoFocus, onEnter, dark } = props
  return (
    <input
      value={value}
      autoFocus={autoFocus}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && onEnter) onEnter() }}
      placeholder={placeholder}
      className="w-full h-10 px-3 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/40"
      style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: dark ? '#f1f5f9' : '#1e293b' }}
    />
  )
}

export function LanguageSelect({ value, onChange }: { value: SessionLanguage; onChange: (v: SessionLanguage) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {LANGUAGE_CHOICES.map(opt => {
        const active = opt.key === value
        return (
          <button key={opt.key} type="button" onClick={() => onChange(opt.key)}
            className="h-9 rounded-lg border text-[12px] transition-colors"
            style={active
              ? { background: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.48)', color: '#60a5fa' }
              : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
            {opt.title}
          </button>
        )
      })}
    </div>
  )
}

// 通用项目/issue/research 下拉选择 — 支持动态刷新 (需求: 中途新建的数据可被读到)
export function useAsyncList<T>(fetcher: () => Promise<T[]>, deps: any[]): { list: T[]; loading: boolean; refresh: () => void } {
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

function SelectShell({ label, hint, current, placeholder, loading, onRefresh, children, dark }: {
  label: string; hint?: string; current?: string; placeholder?: string; loading?: boolean
  onRefresh?: () => void; children: React.ReactNode; dark: boolean
}) {
  return (
    <div>
      <SectionLabel hint={hint}>
        <span className="flex items-center gap-1.5">
          {label}
          {onRefresh && (
            <button type="button" onClick={onRefresh} title="刷新列表" className="inline-flex items-center justify-center rounded hover:bg-[var(--bg-card-hover)]">
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} style={{ color: 'var(--text-muted)' }} />
            </button>
          )}
        </span>
      </SectionLabel>
      {children}
      {current && <p className="mt-1 text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>当前: {current}</p>}
    </div>
  )
}

// 自定义下拉 (portal) — 替代 native <select>, 解决:
//   1. native 下拉被 modal overflow-y-auto 裁切 (portal 渲染到 body, 逃出裁切)
//   2. 长列表无搜索 (内置 Search 过滤, 列表 ≥ 7 项自动出现搜索框)
//   3. native 下拉用 OS 主题, dark 下变白底 (本组件完全跟随主题)
//   4. 列表项只能纯文本 (本组件支持 description / badge / disabled)
// 自动反向展开: 若下方空间不足且上方足够, 自动向上展开.
type DropdownOption = {
  value: string
  label: string
  description?: string
  disabled?: boolean
  badge?: { text: string; color: string; bg: string }
}
function DropdownSelect({
  value, onChange, options, placeholder, dark, disabled, emptyText, forceSearch,
}: {
  value: string
  onChange: (v: string) => void
  options: DropdownOption[]
  placeholder?: string
  dark: boolean
  disabled?: boolean
  emptyText?: string
  forceSearch?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)

  const selected = options.find(o => o.value === value)
  const showSearch = !!forceSearch || options.length > 6

  // 计算 panel 位置 (开/关/滚动/resize 时刷新), 自动判断反向展开
  useEffect(() => {
    if (!open) return
    const update = () => {
      const el = triggerRef.current; if (!el) return
      const r = el.getBoundingClientRect()
      const panelH = Math.min(340, options.length * 48 + (showSearch ? 56 : 0) + 16)
      const openUp = r.bottom + panelH + 12 > window.innerHeight && r.top - panelH > 8
      setPos({ top: openUp ? Math.max(8, r.top - panelH - 4) : r.bottom + 4, left: r.left, width: r.width })
    }
    update()
    const onScroll = () => update()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, options.length, showSearch])

  // 外部点击 / Escape 关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => { if (!open) setQ('') }, [open])

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return options
    return options.filter(o => `${o.label} ${o.description || ''}`.toLowerCase().includes(kw))
  }, [options, q])

  const onPick = (opt: DropdownOption) => {
    if (opt.disabled) return
    onChange(opt.value); setOpen(false)
  }

  return (
    <>
      <button ref={triggerRef} type="button" disabled={disabled} onClick={() => setOpen(v => !v)}
        className="w-full h-10 px-2.5 rounded-xl text-[13px] text-left flex items-center justify-between gap-2 focus:outline-none focus:border-blue-500/40 disabled:opacity-50 disabled:cursor-not-allowed transition-colors hover:border-[var(--border-color-strong,#475569)]"
        style={{ background: 'var(--input-bg)', border: open ? '1px solid rgba(59,130,246,0.55)' : '1px solid var(--input-border)', color: dark ? '#f1f5f9' : '#1e293b' }}>
        <span className={`truncate ${selected ? '' : 'opacity-60'}`}>
          {selected ? selected.label : (placeholder || '— 请选择 —')}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} style={{ color: 'var(--text-muted)' }} />
      </button>
      {open && pos && createPortal(
        <div ref={panelRef} className="fixed z-[100]" style={{ top: pos.top, left: pos.left, width: pos.width }}>
          <div className="rounded-xl shadow-2xl overflow-hidden flex flex-col"
            style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)', maxHeight: 340, boxShadow: '0 12px 32px -8px rgba(0,0,0,0.45)' }}>
            {showSearch && (
              <div className="p-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
                <div className="flex items-center gap-1.5 rounded-lg px-2 h-8" style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
                  <Search className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                  <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索…" autoFocus
                    className="flex-1 bg-transparent text-[12px] focus:outline-none placeholder:!text-[var(--placeholder-color)]"
                    style={{ color: dark ? '#f1f5f9' : '#1e293b' }} />
                  {q && (
                    <button type="button" onClick={() => setQ('')} className="flex-shrink-0 rounded hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <p className="text-[11px] italic px-3 py-4 text-center" style={{ color: 'var(--text-muted)' }}>{emptyText || '无匹配项'}</p>
              ) : filtered.map(opt => {
                const active = opt.value === value
                return (
                  <button key={opt.value} type="button" disabled={opt.disabled} onClick={() => onPick(opt)}
                    className="w-full px-2.5 py-1.5 text-left flex items-start gap-2 transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    style={{ background: active ? 'rgba(59,130,246,0.10)' : 'transparent' }}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="truncate text-[12px]" style={{ color: dark ? '#f1f5f9' : '#1e293b' }}>{opt.label}</span>
                        {opt.badge && (
                          <span className="text-[9px] px-1 py-0.5 rounded shrink-0" style={{ background: opt.badge.bg, color: opt.badge.color }}>{opt.badge.text}</span>
                        )}
                      </div>
                      {opt.description && <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>{opt.description}</div>}
                    </div>
                    {active && <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#60a5fa' }} />}
                  </button>
                )
              })}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

// 目的/描述 + 附件 融合输入框 — 对标系统原生 chat composer (单一边框容器内:
// 附件芯片 + textarea + 上传工具条), 附件不再单独成块, 视觉与交互统一.
export function DescriptionWithAttachments({ value, onValueChange, placeholder, attachments, setAttachments, projectId, dark }: {
  value: string
  onValueChange: (v: string) => void
  placeholder?: string
  attachments: Attachment[]
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>
  projectId?: string
  dark: boolean
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files)
    arr.forEach(file => {
      const isImg = file.type.startsWith('image/')
      const att: Attachment = {
        id: newAttId(), name: file.name, size: file.size,
        previewUrl: isImg ? URL.createObjectURL(file) : undefined,
        kind: isImg ? 'image' : 'file', status: 'uploading',
      }
      setAttachments(prev => [...prev, att])
      uploadAttachmentFile(file, projectId)
        .then(res => setAttachments(prev => prev.map(a => a.id === att.id ? { ...a, status: 'done', path: res.path } : a)))
        .catch(e => setAttachments(prev => prev.map(a => a.id === att.id ? { ...a, status: 'error', error: e?.message || '上传失败' } : a)))
    })
  }, [projectId, setAttachments])

  // 全局粘贴: 仅图片 (与 attachments.tsx 的 AttachmentComposer 行为一致)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const imgs: File[] = []
      for (let i = 0; i < items.length; i += 1) {
        const f = items[i].getAsFile()
        if (f && f.type.startsWith('image/')) imgs.push(f)
      }
      if (imgs.length > 0) { e.preventDefault(); addFiles(imgs) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFiles])

  const remove = (id: string) => setAttachments(prev => {
    const target = prev.find(a => a.id === id)
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
    return prev.filter(a => a.id !== id)
  })

  return (
    <div>
      <SectionLabel hint="Ctrl+V 粘贴 / 拖拽 / 点附件">目的 / 问题描述</SectionLabel>
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files) }}
        className="relative rounded-xl transition-colors focus-within:border-blue-500/40"
        style={{ background: 'var(--input-bg)', border: `1px solid ${dragOver ? 'rgba(59,130,246,0.6)' : 'var(--input-border)'}` }}>
        <input ref={fileRef} type="file" multiple className="hidden" onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = '' }} />
        {attachments.length > 0 && (
          <div className="flex flex-wrap items-start gap-1.5 px-3 pt-2.5">
            {attachments.map(a => (
              <div key={a.id} className="relative group flex-shrink-0" title={`${a.name}${a.size ? ` · ${formatFileSize(a.size)}` : ''}`}>
                {a.kind === 'image' && a.previewUrl ? (
                  <div className="w-9 h-9 rounded-md overflow-hidden relative" style={{ background: dark ? '#111827' : '#fff', border: '1px solid var(--input-border)' }}>
                    <img src={a.previewUrl} alt={a.name} className="w-full h-full object-cover" />
                    {a.status === 'uploading' && <div className="absolute inset-0 bg-black/40" />}
                    {a.status === 'error' && <div className="absolute inset-0 bg-red-500/60 text-white text-[9px] flex items-center justify-center">失败</div>}
                  </div>
                ) : (
                  <div className="h-9 px-2 rounded-md flex items-center gap-1 text-[10px]"
                    style={{ background: dark ? '#111827' : '#fff', border: '1px solid var(--input-border)', color: 'var(--text-secondary)' }}>
                    <Paperclip className="w-3 h-3" /><span className="max-w-[80px] truncate">{a.name}</span>
                  </div>
                )}
                <button type="button" onClick={() => remove(a.id)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <X className="w-2.5 h-2.5" strokeWidth={3} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea value={value} onChange={e => onValueChange(e.target.value)} placeholder={placeholder}
          className="w-full bg-transparent resize-none border-0 px-3 py-2 text-[13px] leading-relaxed placeholder:!text-[var(--placeholder-color)] focus:outline-none"
          style={{ minHeight: 72, color: dark ? '#f1f5f9' : '#1e293b' }} />
        <div className="flex items-center gap-2 px-3 pb-2">
          <button type="button" onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 h-7 px-2 rounded-lg text-[12px] transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{ color: 'var(--text-secondary)' }}>
            <Paperclip className="w-3.5 h-3.5" /> 附件
          </button>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{attachments.length > 0 ? `${attachments.filter(a => a.status === 'done').length}/${attachments.length} 已上传` : '可粘贴截图或拖入文件'}</span>
        </div>
      </div>
    </div>
  )
}

// Skill / Memory 选择器 (学习 research-agent-team-modal 的 selectionPanel 模式):
// 主表单内只放 2 个紧凑按钮 (Skill N/M / Memory N/M), 点击打开二级 modal;
// modal 内是滚动 checkbox 列表 + 搜索 + 主Skill/互斥角标. 默认全集启用, 取消勾选 = excluded.
//
// lockedOf(id) → 主Skill 关联锁定, 强制勾选不可取消
// mutexOf(id)  → 冲突类, 置灰不可选 (互斥禁用)
// accentOf(id) → 返回 '主Skill' | '互斥' 等角标文字 (仅 Research 用, Session 不传)
export function SkillMemoryPicker({
  skills, memories,
  excludedSkills, excludedMemories,
  onToggleSkill, onToggleMemory,
  skillLockedOf, skillMutexOf, skillAccentOf,
  disabled, dark,
  emptySkillText = '该任务未启用 Skill',
  emptyMemoryText = '无可用 Memory',
}: {
  skills: PickItem[]
  memories: PickItem[]
  excludedSkills: Set<string>
  excludedMemories: Set<string>
  onToggleSkill: (id: string) => void
  onToggleMemory: (id: string) => void
  skillLockedOf?: (id: string) => boolean
  skillMutexOf?: (id: string) => boolean
  skillAccentOf?: (id: string) => string | undefined
  disabled?: boolean
  dark: boolean
  emptySkillText?: string
  emptyMemoryText?: string
}) {
  const [panel, setPanel] = useState<null | 'skill' | 'memory'>(null)
  const [q, setQ] = useState('')

  const enabledSkillCount = skills.filter(it => (skillLockedOf?.(it.id) || (!skillMutexOf?.(it.id) && !excludedSkills.has(it.id)))).length
  const enabledMemoryCount = memories.filter(it => !excludedMemories.has(it.id)).length

  const items = panel === 'skill' ? skills : memories
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return items
    return items.filter(it => `${it.name} ${it.description || ''}`.toLowerCase().includes(kw))
  }, [items, q])

  const close = () => { setPanel(null); setQ('') }

  const btnCls = "h-9 min-w-0 rounded-lg border px-2 text-[12px] flex items-center justify-between gap-2 transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-50 disabled:cursor-not-allowed"

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setPanel('skill')} disabled={disabled} className={btnCls}
          style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
          <span className="flex items-center gap-1.5 truncate">
            <span style={{ color: '#60a5fa' }}><Lock className="w-3 h-3" /></span>
            Skill
          </span>
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{enabledSkillCount}/{skills.length}</span>
        </button>
        <button type="button" onClick={() => setPanel('memory')} disabled={disabled} className={btnCls}
          style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
          <span className="flex items-center gap-1.5 truncate">
            <span style={{ color: '#a855f7' }}><Eye className="w-3 h-3" /></span>
            Memory
          </span>
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{enabledMemoryCount}/{memories.length}</span>
        </button>
      </div>

      {panel && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={close}>
          <div className="flex max-h-[min(600px,calc(100vh-64px))] w-[min(520px,calc(100vw-32px))] flex-col rounded-2xl shadow-2xl"
            onClick={e => e.stopPropagation()} style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
            <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
              <div className="min-w-0">
                <div className="text-[14px] font-semibold" style={{ color: dark ? '#f1f5f9' : '#1e293b' }}>
                  {panel === 'skill' ? 'Skill 选择' : 'Memory 选择'}
                </div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {panel === 'skill' ? `${enabledSkillCount}/${skills.length} 已启用 · 取消勾选的将不注入 Agent 上下文` : `${enabledMemoryCount}/${memories.length} 已启用 · 取消勾选的将不注入 Agent 上下文`}
                </div>
              </div>
              <button type="button" onClick={close} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-3 pt-3">
              <div className="flex items-center gap-1.5 rounded-lg px-2 h-8" style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
                <Search className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索名称或描述…" autoFocus
                  className="flex-1 bg-transparent text-[12px] focus:outline-none" style={{ color: dark ? '#f1f5f9' : '#1e293b' }} />
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-2.5">
              {filtered.length === 0 ? (
                <p className="text-[11px] italic px-2 py-6 text-center" style={{ color: 'var(--text-muted)' }}>
                  {panel === 'skill' ? emptySkillText : emptyMemoryText}
                </p>
              ) : filtered.map(it => {
                const isSkill = panel === 'skill'
                const locked = isSkill && !!skillLockedOf?.(it.id)
                const mutex = isSkill && !!skillMutexOf?.(it.id)
                const checked = isSkill ? (locked || (!mutex && !excludedSkills.has(it.id))) : !excludedMemories.has(it.id)
                const accent = isSkill ? skillAccentOf?.(it.id) : undefined
                const onToggle = isSkill ? onToggleSkill : onToggleMemory
                return (
                  <div key={it.id} className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--bg-card-hover)]">
                    <label className={`flex min-w-0 flex-1 items-start gap-2 ${locked ? 'cursor-default' : mutex ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                      <input type="checkbox" checked={checked} disabled={locked || mutex}
                        onChange={() => !locked && !mutex && onToggle(it.id)} className="mt-0.5 accent-blue-500" />
                      <div className="min-w-0 flex-1" style={{ opacity: mutex ? 0.4 : checked ? 1 : 0.5 }}>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="truncate text-[12px]" style={{ color: dark ? '#f1f5f9' : '#1e293b' }}>{it.name}</span>
                          {it.research_role && <span className="px-1 py-0.5 rounded text-[9px] shrink-0" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>{it.research_role}</span>}
                          <span className="px-1 py-0.5 rounded text-[9px] shrink-0" style={{ background: 'rgba(168,85,247,0.15)', color: '#a855f7' }}>{SCOPE_LABEL[it.scope] || it.scope}</span>
                        </div>
                        {it.description && <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{it.description}</div>}
                      </div>
                    </label>
                    {accent && (
                      <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px]"
                        style={{ background: 'rgba(59,130,246,0.15)', color: '#60a5fa' }}>
                        {accent === '互斥' ? <Ban className="w-2.5 h-2.5" /> : <Lock className="w-2.5 h-2.5" />}{accent}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="px-4 py-2.5 border-t flex justify-end" style={{ borderColor: 'var(--border-color)' }}>
              <button type="button" onClick={close} className="h-8 px-4 rounded-lg text-[12px] btn-primary">完成</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// 创建成功 — 次级确认弹窗 (需求: 跳转详情 → 新开 Tab; 否 → 仅关闭)
function CreateSuccessDialog({ kind, name, detailUrl, onClose }: { kind: CreateKind; name: string; detailUrl?: string; onClose: () => void }) {
  const isDark = useStore(s => s.theme) !== 'light'
  const labelMap: Record<CreateKind, string> = { project: '项目', issue: '任务', session: '会话', research: '研究智能体' }
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
      <div className="relative w-[400px] max-w-[calc(100vw-32px)] rounded-2xl p-6 shadow-2xl flex flex-col items-center text-center"
        style={modalShellStyle(isDark)}>
        <div className="w-12 h-12 rounded-full flex items-center justify-center mb-3" style={{ background: 'rgba(34,197,94,0.15)' }}>
          <CheckCircle2 className="w-7 h-7" style={{ color: '#22c55e' }} />
        </div>
        <h3 className="text-[15px] font-semibold mb-1" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>创建成功</h3>
        <p className="text-[12px] mb-5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {labelMap[kind]}「<span style={{ color: isDark ? '#e2e8f0' : '#334155' }}>{name || '(未命名)'}</span>」已创建。是否跳转详情？
        </p>
        <div className="flex gap-2 w-full">
          <button type="button" onClick={onClose}
            className="flex-1 h-9 rounded-xl text-[13px] border transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>留在当前页</button>
          <button type="button"
            onClick={() => { if (detailUrl) window.open(detailUrl, '_blank', 'noopener,noreferrer'); onClose() }}
            className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors flex items-center justify-center gap-1.5">
            <ExternalLink className="w-3.5 h-3.5" /> 跳转详情
          </button>
        </div>
      </div>
    </div>
  )
}

// 弹窗外壳 — 统一容器 (响应式: 窄屏顶部对齐可滚动)
function CreateModalShell({ title, onClose, children, footer, dark, width = 560 }: {
  title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode; dark: boolean; width?: number
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="global-create-modal relative w-full flex flex-col rounded-2xl shadow-2xl max-h-[calc(100vh-24px)]"
        style={{ ...modalShellStyle(dark), maxWidth: `min(${width}px, calc(100vw - 24px))` }}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b shrink-0" style={{ borderColor: 'var(--border-color)' }}>
          <h3 className="text-[15px] font-semibold" style={{ color: dark ? '#f1f5f9' : '#1e293b' }}>{title}</h3>
          <button type="button" onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3.5">{children}</div>
        <div className="gc-modal-footer shrink-0 px-5 py-3 border-t" style={{ borderColor: 'var(--border-color)' }}>{footer}</div>
      </div>
    </div>
  )
}

function Footer({ loading, submitText, onClose, onSubmit, disabled }: { loading: boolean; submitText: string; onClose: () => void; onSubmit: () => void; disabled?: boolean }) {
  return (
    <div className="flex gap-2">
      <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[13px] border transition-colors hover:bg-[var(--bg-card-hover)]"
        style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>取消</button>
      <button onClick={onSubmit} disabled={loading || disabled}
        className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors disabled:opacity-40">
        {loading ? '创建中...' : submitText}
      </button>
    </div>
  )
}

// =====================================================================
// 表单 1: 创建 Project (单页 + 3 类项目类型横向卡片)
// =====================================================================
export function CreateProjectForm({ onClose, onDone }: { onClose: () => void; onDone: (entity: any, detailUrl?: string) => void }) {
  const { theme, user } = useStore()
  const dark = theme !== 'light'
  const canCreateExtension = user?.role === 'admin'
  const DRAFT_KEY = 'gc:new-project'
  const d = draftLoad<any>(DRAFT_KEY) || {}
  const initialKind: ProjectKind = (d.projectKind === 'research' || (d.projectKind === 'extension' && canCreateExtension)) ? d.projectKind : 'default'
  const [projectKind, setProjectKind] = useState<ProjectKind>(initialKind)
  const [name, setName] = useState(d.name || '')
  const [desc, setDesc] = useState(d.desc || '')
  const [bindPath, setBindPath] = useState(d.bindPath || randomProjectBindPath(user?.work_dir))
  const [bindPathManual, setBindPathManual] = useState(!!d.bindPathManual)
  const [researchEnabled, setResearchEnabled] = useState(projectKind === 'research' || !!d.researchEnabled)
  const [defaultUseWorktree, setDefaultUseWorktree] = useState(!!d.defaultUseWorktree)
  const [visibility, setVisibility] = useState<Visibility>(d.visibility || 'private')
  const [extensionName, setExtensionName] = useState(d.extensionName || '')
  // 读者写权限 (对齐 NewProjectModal): owner/admin 永远可写, 此开关只对"非 owner 读者"生效. 默认 false (安全默认).
  const [canPostIssue, setCanPostIssue] = useState(!!d.canPostIssue)
  const [canRunSession, setCanRunSession] = useState(!!d.canRunSession)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  // 切换项目类型时联动 research / worktree / extensionName, 但不动 name/desc 等输入
  const chooseKind = (kind: ProjectKind) => {
    if (kind === 'extension' && !canCreateExtension) return
    setProjectKind(kind)
    setErr('')
    if (kind === 'default') {
      setResearchEnabled(false); setDefaultUseWorktree(false); setExtensionName('')
    } else if (kind === 'research') {
      setResearchEnabled(true); setDefaultUseWorktree(false); setExtensionName('')
    }
  }

  useEffect(() => {
    draftSave(DRAFT_KEY, { projectKind, name, desc, bindPath, bindPathManual, researchEnabled, defaultUseWorktree, visibility, extensionName, canPostIssue, canRunSession }, { minChars: 0 })
  }, [projectKind, name, desc, bindPath, bindPathManual, researchEnabled, defaultUseWorktree, visibility, extensionName, canPostIssue, canRunSession])

  // 自动随机路径未填则补上 (extension 不需要 bindPath)
  useEffect(() => {
    if (projectKind === 'extension') return
    if (bindPath.trim() || !user?.work_dir) return
    setBindPath(randomProjectBindPath(user.work_dir))
    setBindPathManual(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKind])

  const refreshRandomBindPath = () => {
    const next = randomProjectBindPath(user?.work_dir)
    if (!next) { setErr('当前用户尚未配置工作目录，无法生成随机绑定路径'); return }
    setBindPath(next); setBindPathManual(false); setErr('')
  }

  const submit = async () => {
    if (!name.trim()) { setErr('请输入项目名称'); return }
    if (projectKind === 'extension') {
      if (!canCreateExtension) { setErr('只有管理员可以创建莫比乌斯拓展项目'); return }
      if (!extensionName.trim()) { setErr('请输入拓展标识名'); return }
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(extensionName.trim())) { setErr('拓展标识名: 小写字母开头, 含小写字母/数字/连字符, 1-32 字符'); return }
    } else if (!bindPath.trim()) { setErr('请选择项目绑定路径'); return }
    setLoading(true); setErr('')
    try {
      const body: any = { name, description: desc, visibility }
      if (projectKind === 'extension') {
        body.kind = 'extension'
        body.extensionName = extensionName.trim()
      } else {
        body.bindPath = bindPath
        body.bindPathManual = bindPathManual
        body.defaultUseWorktree = researchEnabled ? false : defaultUseWorktree
        body.researchEnabled = projectKind === 'research' ? true : researchEnabled
        body.can_post_issue = canPostIssue
        body.can_run_session = canRunSession
      }
      const p = await api('/api/projects', { method: 'POST', body: JSON.stringify(body) })
      if (p?.error) { setErr(p.error); return }
      draftClear(DRAFT_KEY)
      onDone(p, p?.id && p?.created_by ? `/u/${p.created_by}/p/${p.id}` : undefined)
    } catch (e: any) { setErr(e?.message || '创建失败') } finally { setLoading(false) }
  }

  const visibilityOption = VISIBILITY_OPTIONS.find(o => o.value === visibility) || VISIBILITY_OPTIONS[0]

  const permissionSettingsModal = permissionOpen ? (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={() => setPermissionOpen(false)} />
      <div className="relative w-[440px] max-w-[calc(100vw-32px)] rounded-2xl p-5 shadow-2xl"
        onClick={e => e.stopPropagation()} style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h4 className="text-[15px] font-semibold mb-1" style={{ color: dark ? '#f1f5f9' : '#1e293b' }}>修改项目权限</h4>
        <p className="mb-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>设置谁能看到这个项目，以及读者是否可创建任务单 / 启动会话。</p>
        <div>
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
        {/* 读者写权限: owner/admin 永远可写, 此开关仅对非 owner 读者生效 (private 永远只允许 owner). */}
        <div className="mt-4 space-y-2">
          <ToggleSwitch
            checked={canPostIssue}
            onChange={setCanPostIssue}
            className="flex items-start gap-3 text-[12px]"
            style={{ color: dark ? '#cbd5e1' : '#334155' }}>
            <span>读者可创建任务单<span className="block text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>仅影响非 owner 读者；private 永远只允许 owner</span></span>
          </ToggleSwitch>
          <ToggleSwitch
            checked={canRunSession}
            onChange={setCanRunSession}
            className="flex items-start gap-3 text-[12px]"
            style={{ color: dark ? '#cbd5e1' : '#334155' }}>
            <span>读者可启动执行会话<span className="block text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>同上，仅影响非 owner 读者</span></span>
          </ToggleSwitch>
        </div>
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={() => setPermissionOpen(false)} className="h-9 px-5 rounded-xl text-[13px] btn-primary transition-colors">完成</button>
        </div>
      </div>
    </div>
  ) : null

  return (
    <CreateModalShell title={projectKind === 'extension' ? '新建拓展项目' : projectKind === 'research' ? '新建研究项目' : '新建项目'} onClose={onClose} dark={dark} width={600}
      footer={<Footer loading={loading} submitText="创建" onClose={onClose} onSubmit={submit} />}>
      {/* 项目类型: 下拉菜单, 选定后下方字段自动联动 */}
      <div>
        <SectionLabel hint="选定后下方字段自动联动">项目类型</SectionLabel>
        <DropdownSelect
          value={projectKind}
          onChange={v => chooseKind(v as ProjectKind)}
          dark={dark}
          options={PROJECT_KIND_PRESETS.map(opt => {
            const disabled = opt.kind === 'extension' && !canCreateExtension
            return {
              value: opt.kind,
              label: opt.label,
              description: `${opt.desc} · ${disabled ? '仅管理员' : opt.note}`,
              disabled,
              badge: opt.kind === 'research'
                ? { text: '自动', color: '#10b981', bg: 'rgba(16,185,129,0.15)' }
                : opt.kind === 'extension'
                ? { text: '管理员', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' }
                : undefined,
            }
          })}
        />
        <p className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>{PROJECT_KIND_PRESETS.find(p => p.kind === projectKind)?.desc}</p>
      </div>
      <div>
        <SectionLabel>项目名称</SectionLabel>
        <TextInput value={name} onChange={v => { setName(v); setErr('') }} placeholder="例如：强化学习最新进展调研" autoFocus dark={dark} />
      </div>
      {projectKind === 'extension' ? (
        <div>
          <SectionLabel hint="小写字母开头, 1-32 字符">拓展标识名</SectionLabel>
          <TextInput value={extensionName} onChange={v => { setExtensionName(v.toLowerCase().replace(/[^a-z0-9-]/g, '')); setErr('') }} placeholder="例如：my-awesome-ext" dark={dark} />
          <p className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>创建后在 mobius/extension/ 下生成拓展骨架，可在主页直接打开</p>
        </div>
      ) : (
        <>
          <div>
            <SectionLabel hint="选填">项目描述</SectionLabel>
            <ExpandableTextarea value={desc} onValueChange={setDesc} placeholder="一句话描述这个项目" overlayTitle="编辑项目描述"
              className="w-full h-20 px-3 py-2 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/40 resize-none"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: dark ? '#f1f5f9' : '#1e293b' }} />
          </div>
          <div>
            <SectionLabel hint="agent 的工作目录">绑定路径</SectionLabel>
            <div className="flex gap-2">
              <TextInput value={bindPath} onChange={v => { setBindPath(v); setBindPathManual(true); setErr('') }} placeholder="点击右侧选择，或手动输入绝对路径" dark={dark} />
              <button type="button" onClick={() => setPickerOpen(true)} title="选择路径"
                className="h-10 px-3 rounded-xl border flex items-center gap-1 text-[12px] shrink-0 hover:bg-[var(--bg-card-hover)]"
                style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
              <button type="button" onClick={refreshRandomBindPath} title="换一个随机路径"
                className="h-10 w-10 shrink-0 rounded-xl border flex items-center justify-center hover:bg-[var(--bg-card-hover)]"
                style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
                <Dices className="w-4 h-4" />
              </button>
            </div>
          </div>
          {/* 可见性: 学习 modals.tsx NewProjectModal 模式 → 单行按钮触发二级 modal */}
          <div>
            <SectionLabel hint="谁能看到这个项目">可见性</SectionLabel>
            <button type="button" onClick={() => setPermissionOpen(true)}
              className="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-card-hover)]"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)' }}>
              <Eye className="w-4 h-4 flex-shrink-0 text-blue-400" strokeWidth={1.75} />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-medium" style={{ color: dark ? '#cbd5e1' : '#334155' }}>修改项目权限</span>
                <span className="mt-0.5 block truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{visibilityOption.label} · {visibilityOption.desc}</span>
              </span>
              <span className="flex-shrink-0 text-[11px]" style={{ color: '#60a5fa' }}>修改</span>
            </button>
          </div>
          {projectKind === 'default' && (
            <ToggleSwitch
              checked={researchEnabled}
              onChange={enabled => { setResearchEnabled(enabled); if (enabled) setDefaultUseWorktree(false) }}
              className="flex items-start gap-3 text-[13px]"
              style={{ color: dark ? '#cbd5e1' : '#334155' }}>
              <span><span className="font-medium">启用研究系统</span><span className="block text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>开启后可在本项目中创建研究智能体团队</span></span>
            </ToggleSwitch>
          )}
          {projectKind === 'research' && (
            <div className="rounded-xl px-3 py-2 text-[11px] flex items-center gap-2" style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.3)', color: '#10b981' }}>
              <FlaskConical className="w-3.5 h-3.5" /> 研究项目已自动启用研究系统并禁用 git worktree
            </div>
          )}
          {!researchEnabled && (
            <ToggleSwitch
              checked={defaultUseWorktree}
              onChange={setDefaultUseWorktree}
              className="flex items-center gap-3 text-[13px]"
              style={{ color: dark ? '#cbd5e1' : '#334155' }}>
              默认使用 git worktree（新建任务时在绑定路径下开独立工作区）
            </ToggleSwitch>
          )}
        </>
      )}
      {err && <ErrBanner>{err}</ErrBanner>}
      {pickerOpen && (
        <PathPickerModal initialPath={user?.work_dir} onClose={() => setPickerOpen(false)}
          onPick={(_abs, rel, manual) => { setBindPath(rel || _abs); setBindPathManual(!!manual); setPickerOpen(false) }} />
      )}
      {permissionSettingsModal}
    </CreateModalShell>
  )
}

// =====================================================================
// 表单 2: 创建 Issue (单页: 目标项目 + 标题 + 描述 + 可见性 + worktree + 规划)
// 替代旧 TargetPicker(选项目) → NewIssueModal(填字段) 两步流程.
// =====================================================================
export function CreateIssueForm({ onClose, onDone, defaultProjectId }: { onClose: () => void; onDone: (entity: any, detailUrl?: string) => void; defaultProjectId?: string }) {
  const { theme, user, projects: storeProjects } = useStore()
  const dark = theme !== 'light'
  const userParam = user?.id
  const DRAFT_KEY = 'gc:new-issue'
  const d = draftLoad<any>(DRAFT_KEY) || {}
  const [projectId, setProjectId] = useState(defaultProjectId || d.projectId || '')
  const [title, setTitle] = useState(d.title || '')
  const [desc, setDesc] = useState(d.desc || '')
  const [descTouched, setDescTouched] = useState(!!d.descTouched)
  const [useWorktree, setUseWorktree] = useState(typeof d.useWorktree === 'boolean' ? d.useWorktree : true)
  const [branch, setBranch] = useState(d.branch || '')
  const [isPlanning, setIsPlanning] = useState(!!d.isPlanning)
  const [visibility, setVisibility] = useState<IssueVisibility>(d.visibility || 'inherit')
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const projects = useAsyncList<any>(() => api('/api/projects').then((r: any) => Array.isArray(r) ? r : (r?.projects || [])), [])
  const selectedProject = projects.list.find((p: any) => p.id === projectId) || (storeProjects || []).find((p: any) => p.id === projectId)
  const parentVisibility: Visibility =
    selectedProject?.visibility === 'team' || selectedProject?.visibility === 'public' || selectedProject?.visibility === 'allowlist'
      ? selectedProject.visibility
      : 'private'
  // 反向放大: 仅当父项目允许时才显示对应档位
  const allowedVisibilities: IssueVisibility[] = ['inherit']
  if (parentVisibility === 'private') allowedVisibilities.push('private')
  if (parentVisibility === 'team') allowedVisibilities.push('private', 'team')
  if (parentVisibility === 'public') allowedVisibilities.push('private', 'team', 'public')
  if (parentVisibility === 'allowlist') allowedVisibilities.push('private', 'allowlist')

  // 切换项目时: 重置 visibility 到 inherit (新项目可能档位不同), 重置 worktree 默认值跟随项目
  useEffect(() => {
    if (!selectedProject) return
    if (!allowedVisibilities.includes(visibility)) setVisibility('inherit')
    if (typeof d.useWorktree !== 'boolean') setUseWorktree(!!selectedProject.default_use_worktree)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => {
    draftSave(DRAFT_KEY, { projectId, title, desc: descTouched ? desc : '', descTouched, useWorktree, branch, isPlanning, visibility }, { minChars: 0 })
  }, [projectId, title, desc, descTouched, useWorktree, branch, isPlanning, visibility])

  const effectiveDesc = descTouched ? desc : title
  const issueVisibilityOptions = ISSUE_VISIBILITY_OPTIONS.filter(opt => allowedVisibilities.includes(opt.value))
  const visibilityOption = issueVisibilityOptions.find(opt => opt.value === visibility) || ISSUE_VISIBILITY_OPTIONS[0]
  const parentVisibilityLabel = parentVisibility === 'private' ? '仅自己' : parentVisibility === 'team' ? '同组' : parentVisibility === 'public' ? '公开' : '指定用户'

  const submit = async () => {
    if (!projectId) { setErr('请选择目标项目'); return }
    if (!title.trim()) { setErr('请填写任务标题'); return }
    if (!effectiveDesc.trim()) { setErr('请填写任务描述'); return }
    setLoading(true); setErr('')
    try {
      const iss = await api(`/api/projects/${projectId}/issues`, { method: 'POST', body: JSON.stringify({
        title, description: effectiveDesc,
        use_worktree: isPlanning ? false : useWorktree,
        worktree_branch: (!isPlanning && useWorktree) ? branch.trim() : '',
        visibility, is_planning: isPlanning,
      }) })
      if (iss?.error) { setErr(iss.error); return }
      draftClear(DRAFT_KEY)
      onDone(iss, iss?.id && userParam ? `/u/${userParam}/p/${projectId}/i/${iss.id}` : undefined)
    } catch (e: any) { setErr(e?.message || '创建失败') } finally { setLoading(false) }
  }

  const issuePermissionModal = permissionOpen ? (
    <div className="fixed inset-0 z-[80] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={() => setPermissionOpen(false)} />
      <div className="relative w-[420px] max-w-[calc(100vw-32px)] rounded-2xl p-5 shadow-2xl"
        onClick={e => e.stopPropagation()} style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h4 className="text-[15px] font-semibold mb-1" style={{ color: dark ? '#f1f5f9' : '#1e293b' }}>修改任务权限</h4>
        <p className="mb-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>设置谁能看到这个任务。可选范围受所属项目权限限制。</p>
        <div>
          <div className="grid grid-cols-2 gap-1.5">
            {issueVisibilityOptions.map(opt => {
              const active = visibility === opt.value
              return (
                <button key={opt.value} type="button" onClick={() => { setVisibility(opt.value); setErr('') }} title={opt.desc}
                  className="h-8 rounded-lg border text-[12px] transition-colors"
                  style={active ? { background: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.48)', color: '#60a5fa' } : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
                  {opt.label}
                </button>
              )
            })}
          </div>
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>父项目可见性为「{parentVisibilityLabel}」，本任务单可选范围已自动收窄。</p>
        </div>
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={() => setPermissionOpen(false)} className="flex-1 h-9 rounded-xl text-[13px] btn-primary transition-colors">完成</button>
        </div>
      </div>
    </div>
  ) : null

  return (
    <CreateModalShell title="新建任务" onClose={onClose} dark={dark} width={600}
      footer={<Footer loading={loading} submitText="创建" onClose={onClose} onSubmit={submit} disabled={!projectId} />}>
      <SelectShell label="目标项目" current={selectedProject?.name} loading={projects.loading} onRefresh={projects.refresh} dark={dark}
        hint={!defaultProjectId ? '可在任意项目下创建' : undefined}>
        <DropdownSelect
          value={projectId}
          onChange={v => { setProjectId(v); setErr('') }}
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
      <div>
        <SectionLabel>任务标题</SectionLabel>
        <TextInput value={title} onChange={v => { setTitle(v); setErr('') }} placeholder="一句话说清这次任务" autoFocus dark={dark} />
      </div>
      <div>
        <SectionLabel hint="默认同标题, 选填">任务描述</SectionLabel>
        <ExpandableTextarea value={effectiveDesc} onValueChange={v => { setDesc(v); setDescTouched(true); setErr('') }} placeholder="详细说明任务目标与约束" overlayTitle="编辑任务描述"
          className="w-full h-24 px-3 py-2 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/40 resize-none"
          style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: dark ? '#f1f5f9' : '#1e293b' }} />
      </div>
      <button type="button" onClick={() => projectId && setPermissionOpen(true)} disabled={!projectId}
        className="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)' }}>
        <Eye className="w-4 h-4 flex-shrink-0 text-blue-400" strokeWidth={1.75} />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium" style={{ color: dark ? '#cbd5e1' : '#334155' }}>修改任务权限</span>
          <span className="mt-0.5 block truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {visibilityOption.label} · 项目为{parentVisibilityLabel}，可选范围已收窄
          </span>
        </span>
        <span className="flex-shrink-0 text-[11px]" style={{ color: '#60a5fa' }}>修改</span>
      </button>
      <ToggleSwitch
        checked={isPlanning}
        onChange={v => { setIsPlanning(v); setErr('') }}
        className="flex items-start gap-3 text-[13px]"
        style={{ color: dark ? '#cbd5e1' : '#334155' }}>
        <span>
          <span className="font-medium">系统宏观规划模式</span>
        </span>
      </ToggleSwitch>
      {!isPlanning && (
        <>
          <ToggleSwitch
            checked={useWorktree}
            onChange={v => { setUseWorktree(v); setErr('') }}
            className="flex items-center gap-3 text-[13px]"
            style={{ color: dark ? '#cbd5e1' : '#334155' }}>
            使用 git worktree（在绑定路径下为本任务开独立工作区）
          </ToggleSwitch>
          {useWorktree && (
            <div>
              <SectionLabel hint="留空则用任务标识">分支名称</SectionLabel>
              <TextInput value={branch} onChange={v => { setBranch(v); setErr('') }} placeholder="例如：feature/login" dark={dark} />
            </div>
          )}
        </>
      )}
      {err && <ErrBanner>{err}</ErrBanner>}
      {issuePermissionModal}
    </CreateModalShell>
  )
}

// =====================================================================
// 表单 3: 创建 Session (两级联动 Project→Issue + 单页 + Skill/Memory 浮层 + 附件)
// =====================================================================
export function CreateSessionForm({ onClose, onDone, defaultProjectId, defaultIssueId }: { onClose: () => void; onDone: (entity: any, detailUrl?: string) => void; defaultProjectId?: string; defaultIssueId?: string }) {
  const { theme, user } = useStore()
  const dark = theme !== 'light'
  const userParam = user?.id
  const DRAFT_KEY = 'gc:new-session'
  const d = draftLoad<any>(DRAFT_KEY) || {}
  const [projectId, setProjectId] = useState(defaultProjectId || d.projectId || '')
  const [issueId, setIssueId] = useState(defaultIssueId || d.issueId || '')
  const [name, setName] = useState(d.name || '')
  const [desc, setDesc] = useState(d.desc || '')
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
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
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
      setName((prev: string) => prev && !prev.includes(tag) ? `${prev} ${tag}` : prev)
    })
  }, [])

  const projects = useAsyncList<any>(() => api('/api/projects').then((r: any) => Array.isArray(r) ? r : (r?.projects || [])), [])
  // 二级联动: 选 project 后拉 issues
  const issues = useAsyncList<any>(() => projectId ? api(`/api/projects/${projectId}/issues?status=active`).then((r: any) => Array.isArray(r) ? r : (r?.issues || [])) : Promise.resolve([]), [projectId])
  const selectedProject = projects.list.find((p: any) => p.id === projectId)
  const selectedIssue = issues.list.find((i: any) => i.id === issueId)

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
      // 重开且用户此前已定稿勾选 → 沿用草稿快照; 否则 → 沿用后端默认选择机制.
      if (selectionReadyRef.current && ((d.excluded_skills && d.excluded_skills.length) || (d.excluded_memories && d.excluded_memories.length))) {
        setExcludedSkills(new Set((d.excluded_skills || []).filter((id: string) => skillIds.has(id))))
        setExcludedMemories(new Set((d.excluded_memories || []).filter((id: string) => memIds.has(id))))
      } else {
        setExcludedSkills(new Set((defaults?.excluded_skill_ids || []).filter((id: string) => skillIds.has(id))))
        setExcludedMemories(new Set((defaults?.excluded_memory_ids || []).filter((id: string) => memIds.has(id))))
      }
    }).catch(() => { if (alive) { setAvailSkills([]); setAvailMemories([]); setScopeLastModel('') } })
    return () => { alive = false }
    // 仅在 issueId 变化时拉全集; 勾选/改名不重拉.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId])

  // 切换 issue: 清除用户上一次的手动模型选择, 让模型按该 issue 的三级默认重算.
  useEffect(() => { modelUserTouchedRef.current = false }, [issueId])

  useEffect(() => {
    // 注意: 刻意不持久化 model —— 顶栏草稿是全局的 (不绑 issue), 写入 model 会把"上次所选"泄漏到
    // 其他 issue/项目/新项目. 模型默认完全由 (当前 issue 上次所选 > 项目默认 > 全局默认) 即时计算.
    draftSave(DRAFT_KEY, { projectId, issueId, name, desc, language, excluded_skills: Array.from(excludedSkills), excluded_memories: Array.from(excludedMemories), selection_ready: selectionReady }, { minChars: 0 })
  }, [projectId, issueId, name, desc, language, excludedSkills, excludedMemories, selectionReady])

  const toggle = (set: Set<string>, id: string, setter: React.Dispatch<React.SetStateAction<Set<string>>>) => {
    const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); setter(n)
  }

  // PC 任务模式 (仅桌面端 pc/dual): mobius-aimux skill 强制必选, SkillMemoryPicker 经 skillLockedOf 锁定不可取消.
  // web 端 workMode 恒 null → 永远 false, 不影响 skill 行为. 与 NewSessionModal matchesRequiredSkill 同源.
  const isPcTaskMode = workMode === 'pc' || workMode === 'dual'
  const skillLockedOf = useCallback((id: string) => {
    if (!isPcTaskMode) return false
    const sk = availSkills.find(s => s.id === id)
    return (sk?.dirName || '').replace(/_/g, '-') === 'mobius-aimux'
  }, [isPcTaskMode, availSkills])

  const submit = async () => {
    if (!projectId) { setErr('请选择目标项目'); return }
    if (!issueId) { setErr('请选择目标任务'); return }
    if (!name.trim()) { setErr('请填写会话名称'); return }
    setLoading(true); setErr('')
    try {
      const finalDesc = appendAttachmentsToDesc(desc.trim() || name, attachments)
      // pc/dual 时 mobius-aimux 必选: 即便用户此前排除过, 提交时也从排除集清理 (与 NewSessionModal normalizeSkillExclusions 同源).
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
      if (s?.error) { setErr(s.error); return }
      draftClear(DRAFT_KEY)
      onDone(s, s?.session_id && userParam ? `/u/${userParam}/p/${projectId}/i/${issueId}?session=${s.session_id}` : undefined)
    } catch (e: any) { setErr(e?.message || '创建失败') } finally { setLoading(false) }
  }

  return (
    <CreateModalShell title="新建会话" onClose={onClose} dark={dark} width={600}
      footer={<Footer loading={loading} submitText="创建" onClose={onClose} onSubmit={submit} disabled={!projectId || !issueId} />}>
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
      <div>
        <SectionLabel>会话名称</SectionLabel>
        <TextInput value={name} onChange={v => { setName(v); setErr('') }} placeholder="给这个会话起个名字" autoFocus dark={dark} />
      </div>
      <DescriptionWithAttachments value={desc} onValueChange={v => { setDesc(v); setErr('') }} placeholder="希望这个会话完成什么" attachments={attachments} setAttachments={setAttachments} projectId={projectId || undefined} dark={dark} />
      {isDesktop && (
        <PcTaskModeSection projectId={projectId || undefined} isDark={dark} onModeChange={setWorkMode} onPathChange={setPcPath} />
      )}
      <SessionModelPicker value={model} onChange={v => { setModel(v); modelUserTouchedRef.current = true }} dark={dark} />
      <div>
        <SectionLabel hint="注入上下文语言">语言</SectionLabel>
        <LanguageSelect value={language} onChange={setLanguage} />
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
      {err && <ErrBanner>{err}</ErrBanner>}
    </CreateModalShell>
  )
}

// =====================================================================
// 表单 4: 创建 Research Agent (前置校验 + Project→Research 联动 + 主Skill强制联动 + Memory + 附件)
// =====================================================================
export function CreateResearchForm({ onClose, onDone, defaultProjectId }: { onClose: () => void; onDone: (entity: any, detailUrl?: string) => void; defaultProjectId?: string }) {
  const { theme, user } = useStore()
  const dark = theme !== 'light'
  const userParam = user?.id
  const DRAFT_KEY = 'gc:new-research-agent'
  const d = draftLoad<any>(DRAFT_KEY) || {}
  const [projectId, setProjectId] = useState(defaultProjectId || d.projectId || '')
  const [researchId, setResearchId] = useState(d.researchId || '')
  const [name, setName] = useState(d.name || '')
  const [desc, setDesc] = useState(d.desc || '')
  const [role, setRole] = useState<'chief_researcher' | 'research_assistant'>(d.role || 'research_assistant')
  // 角色默认值 (对齐 NewSessionModal): 若该 Research 尚无 chief_researcher 且用户未手动选过角色(也无草稿) → 默认首席.
  const roleUserTouchedRef = useRef(!!d.role)
  // 模型默认值: 仅由 (当前 research 上次所选 > 项目默认 > 全局默认) 三级决定 (同 CreateSessionForm).
  // 不从全局草稿 (gc:new-research-agent) 读/写 model, 避免泄漏到其他 research/项目/新项目.
  const [model, setModel] = useState<string>(GLOBAL_DEFAULT_MODEL)
  const modelUserTouchedRef = useRef(false)
  const [scopeLastModel, setScopeLastModel] = useState('')
  const [language, setLanguage] = useState<SessionLanguage>(d.language || 'zh')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  // 主 Skill 强制联动
  const [agentSkills, setAgentSkills] = useState<PickItem[]>([])         // research-agent-skills (可作主skill)
  const [chosenMainSkill, setChosenMainSkill] = useState<PickItem | null>(null)
  const [availSkills, setAvailSkills] = useState<PickItem[]>([])         // context-preview 全集
  const [availMemories, setAvailMemories] = useState<PickItem[]>([])
  const [excludedSkills, setExcludedSkills] = useState<Set<string>>(new Set())
  const [excludedMemories, setExcludedMemories] = useState<Set<string>>(new Set())

  const projects = useAsyncList<any>(() => api('/api/projects').then((r: any) => Array.isArray(r) ? r : (r?.projects || [])), [])
  const selectedProject = projects.list.find((p: any) => p.id === projectId)
  const researchEnabled = !!selectedProject?.research_enabled
  // 项目级默认模型偏好 (default_model).
  const projectDefaultModel = selectedProject?.default_model
  // 全局默认模型偏好 (管理中心-系统设置): 末级兜底之前的一级.
  const [globalDefaultModel, setGlobalDefaultModel] = useState('')
  useEffect(() => {
    let alive = true
    fetchGlobalDefaultModel().then(v => { if (alive) setGlobalDefaultModel(v) })
    return () => { alive = false }
  }, [])
  // 模型三级默认: 当前 research 上次所选 > 项目默认 > 全局默认 > 内置 codex.
  useEffect(() => {
    if (modelUserTouchedRef.current) return
    setModel(resolveDefaultModelKey({ scopeLastModel, projectDefaultModel, globalDefaultModel, fallback: GLOBAL_DEFAULT_MODEL }))
  }, [scopeLastModel, projectDefaultModel, globalDefaultModel])
  const researches = useAsyncList<any>(() => projectId ? api(`/api/projects/${projectId}/researches?status=active`).then((r: any) => Array.isArray(r) ? r : (r?.researches || [])) : Promise.resolve([]), [projectId])
  const selectedResearch = researches.list.find((r: any) => r.id === researchId)

  // 选 project 后, 若未启用 Research → 置灰提交 + 提示
  useEffect(() => {
    if (projectId && selectedProject && !researchEnabled) {
      // 保留选择, 仅靠 disabled + hint 拦截
    }
  }, [projectId, selectedProject, researchEnabled])

  // 选 research 后拉 agent-skills + 一次 context-preview 全集 (sources + defaults).
  // 默认排除集沿用后端"同 Research 最新 Session 继承 + 内置 Skill 默认排除"机制, 与 NewSessionModal 一致.
  useEffect(() => {
    if (!researchId) { setAgentSkills([]); setAvailSkills([]); setAvailMemories([]); setChosenMainSkill(null); setExcludedSkills(new Set()); setExcludedMemories(new Set()); setScopeLastModel(''); return }
    let alive = true
    Promise.all([
      api(`/api/researches/${researchId}/research-agent-skills`).catch(() => []),
      api(`/api/researches/${researchId}/context-preview`, { method: 'POST', body: JSON.stringify({ name: name || ' ', description: desc || ' ', role, excluded_skill_ids: [], excluded_memory_ids: [], include_defaults: true, include_body: false, include_item_bodies: false }) }).catch(() => null),
    ]).then(([ask, prev]: any) => {
      if (!alive) return
      const defaults = prev?.defaults || null
      const agentSkillList = (Array.isArray(ask) ? ask : []).map((s: any) => ({ id: s.id, name: s.name, description: s.description, scope: s.scope || 'project', research_role: s.research_role }))
      const previewSkills = (prev?.sources?.skills || []).map((s: any) => ({ id: s.id, name: s.name, description: s.description, scope: s.scope || 'project', research_role: s.research_role }))
      const previewMemories = (prev?.sources?.memories || []).map((m: any) => ({ id: m.id, name: m.name, description: m.description, scope: m.scope || 'project' }))
      setAgentSkills(agentSkillList)
      setAvailSkills(previewSkills)
      setAvailMemories(previewMemories)
      // 当前 research 上次所选模型 (该 research 最近一次 Session 的 model); 无历史则空 → 三级默认回落.
      setScopeLastModel(typeof defaults?.model === 'string' ? defaults.model : '')
      const skillIds = new Set(previewSkills.map((s: any) => s.id))
      const memIds = new Set(previewMemories.map((m: any) => m.id))
      setExcludedSkills(new Set((defaults?.excluded_skill_ids || []).filter((id: string) => skillIds.has(id))))
      setExcludedMemories(new Set((defaults?.excluded_memory_ids || []).filter((id: string) => memIds.has(id))))
      setChosenMainSkill(null)
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchId, role])

  // 切换 research: 清除用户上一次的手动模型选择, 让模型按该 research 的三级默认重算.
  useEffect(() => { modelUserTouchedRef.current = false }, [researchId])

  // 选 research 后: 拉现有 sessions 判断是否已有 chief_researcher, 若无且用户未手动选过角色 → 默认首席 (对齐 NewSessionModal).
  // 后端创建时若已有 chief 会 409; 这里前端预判, 避免提交才报错. 不依赖 role, 避免与上面 effect 循环.
  useEffect(() => {
    if (!researchId) return
    let alive = true
    api(`/api/researches/${researchId}/sessions`).then((list: any) => {
      if (!alive || roleUserTouchedRef.current) return
      const chiefExists = Array.isArray(list) && list.some((s: any) => s.research_role === 'chief_researcher')
      setRole(chiefExists ? 'research_assistant' : 'chief_researcher')
    }).catch(() => {})
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchId])

  useEffect(() => {
    // 刻意不持久化 model (全局草稿会泄漏, 详见 CreateSessionForm). 模型默认即时按三级链路计算.
    draftSave(DRAFT_KEY, { projectId, researchId, name, desc, role, language }, { minChars: 0 })
  }, [projectId, researchId, name, desc, role, language])

  // 主 Skill 关联锁定 / 冲突互斥 (复用 NewSessionModal 的 normalizeSkillExclusions 思路)
  const isMainSkill = useCallback((id: string) => !!chosenMainSkill && chosenMainSkill.id === id, [chosenMainSkill])
  const isMutexSkill = useCallback((id: string) => !!chosenMainSkill && agentSkills.some(sk => sk.id === id && sk.id !== chosenMainSkill.id), [chosenMainSkill, agentSkills])
  // 选中主 Skill → 其他 agent skill 自动 excluded; 取消主 skill → 释放
  const chooseMainSkill = (sk: PickItem | null) => {
    setChosenMainSkill(sk)
    setExcludedSkills(prev => {
      const next = new Set(prev)
      if (sk) {
        agentSkills.forEach(s => { if (s.id !== sk.id) next.add(s.id) })
        next.delete(sk.id)
      }
      return next
    })
  }
  const toggleSkill = (id: string) => {
    if (isMainSkill(id) || isMutexSkill(id)) return
    setExcludedSkills(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  const toggleMemory = (id: string) => setExcludedMemories(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const accentSkill = useCallback((id: string) => {
    if (isMainSkill(id)) return '主Skill'
    if (isMutexSkill(id)) return '互斥'
    return undefined
  }, [isMainSkill, isMutexSkill])

  const blockedReason = !projectId ? null : !researchEnabled ? '当前项目未启用研究系统，请前往项目设置开启' : null

  const submit = async () => {
    if (blockedReason) { setErr(blockedReason); return }
    if (!researchId) { setErr('请选择目标研究'); return }
    if (!name.trim()) { setErr('请填写 Agent 名称'); return }
    setLoading(true); setErr('')
    try {
      const finalDesc = appendAttachmentsToDesc(desc.trim() || name, attachments)
      const s = await api(`/api/researches/${researchId}/sessions`, { method: 'POST', body: JSON.stringify({
        name, description: finalDesc, role, model, language,
        excluded_skill_ids: Array.from(excludedSkills), excluded_memory_ids: Array.from(excludedMemories),
        suppress_join_notice: true,
      }) })
      if (s?.error) { setErr(s.error); return }
      draftClear(DRAFT_KEY)
      onDone(s, s?.session_id && userParam ? `/u/${userParam}/p/${projectId}/r/${researchId}?session=${s.session_id}` : undefined)
    } catch (e: any) { setErr(e?.message || '创建失败') } finally { setLoading(false) }
  }

  return (
    <CreateModalShell title="新建研究智能体" onClose={onClose} dark={dark} width={600}
      footer={<Footer loading={loading} submitText="创建" onClose={onClose} onSubmit={submit} disabled={!!blockedReason || !researchId} />}>
      <SelectShell label="目标项目" current={selectedProject?.name} loading={projects.loading} onRefresh={projects.refresh} dark={dark}>
        <DropdownSelect
          value={projectId}
          onChange={v => { setProjectId(v); setResearchId(''); setErr('') }}
          dark={dark}
          placeholder="— 选择项目 —"
          emptyText="暂无可用项目"
          options={[
            { value: '', label: '— 选择项目 —', description: '取消选择' },
            ...projects.list.map((p: any) => ({
              value: String(p.id),
              label: String(p.name),
              description: p.research_enabled
                ? (p.description ? String(p.description) : undefined)
                : (p.description ? `${String(p.description)} · 未启用研究` : '未启用研究'),
              badge: p.research_enabled ? { text: '研究', color: '#10b981', bg: 'rgba(16,185,129,0.15)' } : { text: '未启用', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
            })),
          ]}
        />
      </SelectShell>
      {projectId && !researchEnabled && (
        <div className="rounded-xl px-3 py-2 text-[12px] flex items-center gap-2" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444' }}>
          <Ban className="w-3.5 h-3.5" /> 当前项目未启用研究系统，请前往项目设置开启后再创建研究智能体。
        </div>
      )}
      <SelectShell label="目标研究" current={selectedResearch?.title} loading={researches.loading} onRefresh={researches.refresh} dark={dark} hint={researchEnabled ? '已激活的研究' : ''}>
        <DropdownSelect
          value={researchId}
          onChange={v => { setResearchId(v); setErr('') }}
          disabled={!researchEnabled}
          dark={dark}
          placeholder={researchEnabled ? '— 选择研究 —' : '请先选择已启用研究的项目'}
          emptyText={researchEnabled ? '该项目下暂无激活的研究' : '请先选择已启用研究的项目'}
          options={[
            { value: '', label: researchEnabled ? '— 选择研究 —' : '请先选择已启用研究的项目', description: '取消选择' },
            ...researches.list.map((r: any) => ({
              value: String(r.id),
              label: String(r.title),
              description: r.description ? String(r.description) : undefined,
            })),
          ]}
        />
      </SelectShell>
      <div>
        <SectionLabel>Agent 名称</SectionLabel>
        <TextInput value={name} onChange={v => { setName(v); setErr('') }} placeholder="给这个 Agent 起个名字" autoFocus dark={dark} />
      </div>
      <DescriptionWithAttachments value={desc} onValueChange={v => { setDesc(v); setErr('') }} placeholder="希望这个 Agent 研究什么" attachments={attachments} setAttachments={setAttachments} projectId={projectId || undefined} dark={dark} />
      <SessionModelPicker value={model} onChange={v => { setModel(v); modelUserTouchedRef.current = true }} dark={dark} />
      <div>
        <SectionLabel hint="注入上下文语言">语言</SectionLabel>
        <LanguageSelect value={language} onChange={setLanguage} />
      </div>
      <div>
        <SectionLabel hint="创建后不可更改">角色</SectionLabel>
        <DropdownSelect
          value={role}
          onChange={v => { setRole(v as 'research_assistant' | 'chief_researcher'); roleUserTouchedRef.current = true }}
          disabled={!researchId}
          dark={dark}
          options={[
            { value: 'research_assistant', label: '研究助理' },
            { value: 'chief_researcher', label: '首席研究员' },
          ]}
        />
      </div>
      <div>
        <SectionLabel hint={researchId ? '选定后关联 Skill 自动锁定、冲突 Skill 自动互斥' : '选择研究后可配置'}>主 Skill</SectionLabel>
        <DropdownSelect
          value={chosenMainSkill?.id || ''}
          onChange={v => {
            const sk = agentSkills.find(s => s.id === v) || null
            chooseMainSkill(sk)
          }}
          disabled={!researchId || agentSkills.length === 0}
          dark={dark}
          placeholder={agentSkills.length === 0 ? '该研究无可用 Agent Skill' : '不选择主 Skill（完全自定义）'}
          emptyText="该研究无可用 Agent Skill"
          options={[
            { value: '', label: agentSkills.length === 0 ? '该研究无可用 Agent Skill' : '不选择主 Skill（完全自定义）', description: '完全自定义' },
            ...agentSkills.map(sk => ({
              value: String(sk.id),
              label: String(sk.name),
              description: sk.description ? String(sk.description) : undefined,
              badge: sk.research_role ? { text: sk.research_role, color: '#10b981', bg: 'rgba(16,185,129,0.15)' } : undefined,
            })),
          ]}
        />
      </div>
      <div>
        <SectionLabel hint={researchId ? '主 Skill 关联锁定 / 冲突互斥, 点击展开选择' : '选择研究后可配置'}>Skill / Memory</SectionLabel>
        <SkillMemoryPicker
          skills={availSkills}
          memories={availMemories}
          excludedSkills={excludedSkills}
          excludedMemories={excludedMemories}
          onToggleSkill={toggleSkill}
          onToggleMemory={toggleMemory}
          skillLockedOf={isMainSkill}
          skillMutexOf={isMutexSkill}
          skillAccentOf={accentSkill}
          disabled={!researchId}
          dark={dark}
        />
      </div>
      {err && <ErrBanner>{err}</ErrBanner>}
    </CreateModalShell>
  )
}

// =====================================================================
// 顶栏触发器 + 根调度
// =====================================================================
const MENU_ITEMS: { kind: CreateKind; label: string; icon: any }[] = [
  { kind: 'project', label: '新建项目', icon: FolderPlus },
  { kind: 'issue', label: '新建任务', icon: CircleDot },
  { kind: 'session', label: '新建会话', icon: MessagesSquare },
  { kind: 'research', label: '新建研究智能体', icon: FlaskConical },
]

export function GlobalCreateMenu({ open, onOpenChange, onPick, inProject, currentProject }: {
  open: boolean; onOpenChange: (v: boolean) => void; onPick: (kind: CreateKind) => void
  inProject: boolean; currentProject: any
}) {
  // 移动端 (≤ 断点): 触发按钮只留 [+] 图标, 隐藏「新建」文字与下拉箭头, 极简化顶栏.
  const isMobile = useIsMobile()
  useEffect(() => {
    if (!open) return
    const close = () => onOpenChange(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open, onOpenChange])

  // Research Agent 入口始终可点 — 表单内由用户自行选择 Project + Research,
  // 即使当前所在项目未启用 Research, 也可在表单里切换到其他项目.
  const canPick = (kind: CreateKind): boolean => {
    if (kind === 'issue') return inProject ? currentProject?.can_create_issue !== false : true
    return true
  }

  return (
    <div className="relative" data-tour="top-create">
      <button type="button"
        onClick={(e) => { e.stopPropagation(); onOpenChange(!open) }}
        title="新建" aria-label="新建" aria-haspopup="menu" aria-expanded={open}
        className="mobius-create-trigger h-8 flex items-center gap-1 rounded-lg pl-2 pr-2 border hover:bg-[var(--bg-card-hover)] transition-colors"
        style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color)' }}>
        <Plus className="w-3.5 h-3.5" strokeWidth={2} />
        {/* {!isMobile && <span className="text-[12px] font-medium">新建</span>} */}
        {!isMobile && <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-50 min-w-[200px] rounded-lg shadow-xl py-1"
          style={{ background: 'var(--menu-bg)', border: '1px solid var(--border-color)' }}
          onClick={e => e.stopPropagation()}>
          {MENU_ITEMS.map(item => {
            const Icon = item.icon
            const ok = canPick(item.kind)
            return (
              <button key={item.kind} type="button"
                disabled={!ok}
                onClick={() => { if (ok) { onOpenChange(false); onPick(item.kind) } }}
                className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--bg-hover)] flex items-center gap-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                style={{ color: 'var(--text-primary)' }}>
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 根调度: 4 类创建均走自定义单页表单 (CreateProjectForm / CreateIssueForm / CreateSessionForm / CreateResearchForm).
// session / research agent 创建成功 → 经 onNavigate 在 SPA 内直接进入该 Session, 触发 ChatArea 的
//   SessionStartModal 自动启动 (4s 倒计时自动执行), 不再走"成功弹窗 + 新开 Tab".
// project / issue 创建成功 → 仍走次级确认弹窗, 「跳转详情」新开浏览器 Tab.
// 传统「新建 Session · 第 1 步 / 共 2 步」菜单 (modals.tsx) 走自己的 onCreated/goToSession, 不受此处影响.
export function GlobalCreateRoot({ kind, ctx, onClose, onNavigate }: {
  kind: CreateKind | null
  ctx: { projectId?: string; issueId?: string; researchId?: string }
  onClose: () => void
  onNavigate?: (path: string) => void
}) {
  const [success, setSuccess] = useState<{ entity: any; detailUrl?: string; name: string } | null>(null)

  if (success) {
    return <CreateSuccessDialog kind={kind || 'project'} name={success.name} detailUrl={success.detailUrl} onClose={() => { setSuccess(null); onClose() }} />
  }
  const handleDone = (entity: any, detailUrl?: string) => {
    // session / research agent: SPA 内进入新建的 Session, 让既有自动启动机制接管 (跳过成功弹窗 + 新开 Tab).
    if ((kind === 'session' || kind === 'research') && detailUrl && onNavigate) {
      onNavigate(detailUrl)
      onClose()
      return
    }
    setSuccess({ entity, detailUrl, name: entity?.name || entity?.title || '' })
  }

  if (kind === 'project') return <CreateProjectForm onClose={onClose} onDone={handleDone} />
  if (kind === 'issue') return <CreateIssueForm onClose={onClose} onDone={handleDone} defaultProjectId={ctx.projectId} />
  if (kind === 'session') return <CreateSessionForm onClose={onClose} onDone={handleDone} defaultProjectId={ctx.projectId} defaultIssueId={ctx.issueId} />
  if (kind === 'research') return <CreateResearchForm onClose={onClose} onDone={handleDone} defaultProjectId={ctx.projectId} />
  return null
}
