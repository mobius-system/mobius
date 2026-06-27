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
import { useNavigate } from 'react-router-dom'
import { useStore, api } from '../store'
import { useIsMobile } from './resizable-panel'
import { draftLoad, draftSave, draftClear } from '../services/input-drafts'
import { ErrBanner, PathPickerModal, NewIssueModal } from './modals'
import { ExpandableTextarea } from './expandable-textarea'
import {
  Plus, ChevronDown, FolderPlus, CircleDot, MessagesSquare, FlaskConical,
  X, Eye, RefreshCw, Paperclip, Image as ImageIcon, Upload, Trash2,
  CheckCircle2, ExternalLink, Lock, Ban, Search,
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

type SessionLanguage = 'zh' | 'en'
const LANGUAGE_CHOICES: { key: SessionLanguage; title: string }[] = [
  { key: 'zh', title: '中文' },
  { key: 'en', title: 'English' },
]

// 模型兜底 (与需求列出的 5 个模型一致; 优先用后端 /api/sessions/model-options)
type ModelOption = { key: string; label: string; title?: string; sub?: string; backend?: string }
const FALLBACK_MODELS: ModelOption[] = [
  { key: 'codex', label: 'GPT-5.5', title: 'GPT-5.5 (Codex)', backend: 'tmux-codex' },
  { key: 'gpt55-backup', label: 'GPT55-BackUp', title: 'GPT55-BackUp', backend: 'tmux-codex' },
  { key: 'glm-5.2', label: 'GLM-5.2', title: 'GLM-5.2', backend: 'claude_code' },
  { key: 'minimax-m27-high', label: 'MiniMax-M2.7-high', title: 'MiniMax-M2.7-high', backend: 'claude_code' },
  { key: 'minimax-m3', label: 'MiniMax-M3', title: 'MiniMax-M3', backend: 'claude_code' },
]

type PickItem = {
  id: string
  name: string
  description?: string
  scope: string
  research_role?: string
}
const SCOPE_LABEL: Record<string, string> = { user: '用户级', project: '项目级', builtin: '内置' }

type Attachment = {
  id: string
  name: string
  size: number
  path?: string
  previewUrl?: string
  kind: 'image' | 'file'
  status: 'uploading' | 'done' | 'error'
  error?: string
}

// ---------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------
let _attSeq = 0
function newAttId() { _attSeq += 1; return `att-${Date.now()}-${_attSeq}` }

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 上传单文件到 /api/upload (FormData field 'file'); 不能复用 store.api (它默认 JSON header).
async function uploadAttachmentFile(file: File, projectId?: string): Promise<{ path: string; name: string; size: number }> {
  const token = localStorage.getItem('cc-token') || ''
  const form = new FormData()
  form.append('file', file, file.name)
  const url = projectId ? `/api/upload?project_id=${encodeURIComponent(projectId)}` : '/api/upload'
  const res = await fetch(url, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  })
  const data = await res.json().catch(() => ({} as any))
  if (!res.ok) throw new Error(data?.error || `上传失败 (HTTP ${res.status})`)
  return { path: data.path, name: data.name, size: data.size }
}

// 把附件以 markdown 追加到描述末尾, 供后端 agent 在服务器侧访问.
function appendAttachmentsToDesc(desc: string, atts: Attachment[]): string {
  const done = atts.filter(a => a.status === 'done' && a.path)
  if (done.length === 0) return desc
  const lines = done.map(a => a.kind === 'image' ? `![${a.name}](${a.path})` : `📎 [${a.name}](${a.path})`)
  return `${desc.replace(/\s+$/, '')}\n\n--- 附件 ---\n${lines.join('\n')}`
}

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

// 模型选择 (动态拉 /api/sessions/model-options, 兜底 FALLBACK_MODELS)
function ModelSelect({ value, onChange, dark }: { value: string; onChange: (v: string) => void; dark: boolean }) {
  const [options, setOptions] = useState<ModelOption[]>(FALLBACK_MODELS)
  useEffect(() => {
    let alive = true
    api('/api/sessions/model-options').then((arr: any[]) => {
      if (!alive || !Array.isArray(arr) || arr.length === 0) return
      const mapped: ModelOption[] = arr.map((m: any) => ({ key: m.key, label: m.label || m.title || m.key, title: m.title || m.label, sub: m.sub, backend: m.backend }))
      setOptions(mapped)
      if (!mapped.some(m => m.key === value)) onChange(mapped[0]?.key || value)
    }).catch(() => {})
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <NativeSelect value={value} onChange={onChange} dark={dark}>
      {options.map(opt => (
        <option key={opt.key} value={opt.key} title={opt.title || opt.label}>
          {opt.label}{opt.sub ? `（${opt.sub}）` : ''}
        </option>
      ))}
    </NativeSelect>
  )
}

function LanguageSelect({ value, onChange }: { value: SessionLanguage; onChange: (v: SessionLanguage) => void }) {
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

function NativeSelect({ value, onChange, children, dark }: { value: string; onChange: (v: string) => void; children: React.ReactNode; dark: boolean }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full h-10 px-2.5 rounded-xl text-[13px] focus:outline-none focus:border-blue-500/40"
      style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: dark ? '#f1f5f9' : '#1e293b' }}>
      {children}
    </select>
  )
}

// 附件上传区 — 拖拽 / Ctrl+V 粘贴 / 按钮 (仅 Session / Research Agent 用)
function AttachmentZone({ attachments, setAttachments, projectId, dark }: {
  attachments: Attachment[]; setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>; projectId?: string; dark: boolean
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

  // 全局粘贴监听 (弹窗挂载期间): 仅处理图片.
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
      <SectionLabel hint="Ctrl+V 粘贴 / 拖拽 / 点击">附件</SectionLabel>
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files) }}
        className="rounded-xl border border-dashed p-2.5 transition-colors"
        style={{ borderColor: dragOver ? 'rgba(59,130,246,0.6)' : 'var(--input-border)', background: dragOver ? 'rgba(59,130,246,0.06)' : 'transparent' }}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-[12px] transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
            <Upload className="w-3.5 h-3.5" /> 添加文件
          </button>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>可粘贴截图或拖入文件</span>
        </div>
        {attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
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
        <input ref={fileRef} type="file" multiple className="hidden" onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = '' }} />
      </div>
    </div>
  )
}

// 目的/描述 + 附件 融合输入框 — 对标系统原生 chat composer (单一边框容器内:
// 附件芯片 + textarea + 上传工具条), 附件不再单独成块, 视觉与交互统一.
function DescriptionWithAttachments({ value, onValueChange, placeholder, attachments, setAttachments, projectId, dark }: {
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

  // 全局粘贴: 仅图片 (与 AttachmentZone 一致)
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

// Skill / Memory 二级浮层选择器 (通用). 默认全集启用, 取消勾选 = excluded.
// locked(id)  → 必选/主Skill, 强制勾选不可取消 (关联锁定)
// mutex(id)   → 冲突类, 置灰不可选 (互斥禁用)
function PickerPopover({ title, items, excluded, onToggle, lockedOf, mutexOf, accentLabelOf, emptyText, dark }: {
  title: string
  items: PickItem[]
  excluded: Set<string>
  onToggle: (id: string) => void
  lockedOf?: (id: string) => boolean
  mutexOf?: (id: string) => boolean
  accentLabelOf?: (id: string) => string | undefined   // 返回 '主Skill' | '必选' 等角标
  emptyText: string
  dark: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return items
    return items.filter(it => `${it.name} ${it.description || ''}`.toLowerCase().includes(kw))
  }, [items, q])
  const enabledCount = items.filter(it => (lockedOf?.(it.id) || (!mutexOf?.(it.id) && !excluded.has(it.id))) ).length

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(v => !v)}
        className="w-full h-10 rounded-xl border flex items-center justify-between px-3 text-[12px] transition-colors hover:bg-[var(--bg-card-hover)]"
        style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: dark ? '#e2e8f0' : '#334155' }}>
        <span className="truncate">{title}（已启用 {enabledCount}/{items.length}）</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} style={{ color: 'var(--text-muted)' }} />
      </button>
      {open && (
        <div className="absolute z-[80] mt-1 left-0 right-0 rounded-xl shadow-2xl flex flex-col overflow-hidden"
          style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)', maxHeight: '320px' }}
          onClick={e => e.stopPropagation()}>
          <div className="p-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
            <div className="flex items-center gap-1.5 rounded-lg px-2 h-7" style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
              <Search className="w-3 h-3" style={{ color: 'var(--text-muted)' }} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索…" autoFocus
                className="flex-1 bg-transparent text-[12px] focus:outline-none" style={{ color: dark ? '#f1f5f9' : '#1e293b' }} />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5">
            {filtered.length === 0 && <p className="text-[11px] italic px-2 py-3 text-center" style={{ color: 'var(--text-muted)' }}>{emptyText}</p>}
            {filtered.map(it => {
              const locked = !!lockedOf?.(it.id)
              const mutex = !!mutexOf?.(it.id)
              const checked = locked || (!mutex && !excluded.has(it.id))
              const accent = accentLabelOf?.(it.id)
              return (
                <div key={it.id} className="flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--bg-card-hover)]">
                  <label className={`flex min-w-0 flex-1 items-start gap-2 ${locked ? 'cursor-default' : mutex ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                    <input type="checkbox" checked={checked} disabled={locked || mutex}
                      onChange={() => !locked && !mutex && onToggle(it.id)} className="mt-0.5 accent-blue-500" />
                    <div className="min-w-0 flex-1" style={{ opacity: mutex ? 0.4 : checked ? 1 : 0.5 }}>
                      <div className="flex items-center gap-1.5">
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
        </div>
      )}
    </div>
  )
}

// 创建成功 — 次级确认弹窗 (需求: 跳转详情 → 新开 Tab; 否 → 仅关闭)
function CreateSuccessDialog({ kind, name, detailUrl, onClose }: { kind: CreateKind; name: string; detailUrl?: string; onClose: () => void }) {
  const isDark = useStore(s => s.theme) !== 'light'
  const labelMap: Record<CreateKind, string> = { project: '项目', issue: 'Issue', session: 'Session', research: 'Research Agent' }
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
// 表单 1: 创建 Project (无上下文限制, 无 Skill/Memory)
// =====================================================================
export function CreateProjectForm({ onClose, onDone }: { onClose: () => void; onDone: (entity: any, detailUrl?: string) => void }) {
  const { theme, user } = useStore()
  const dark = theme !== 'light'
  const DRAFT_KEY = 'gc:new-project'
  const d = draftLoad<any>(DRAFT_KEY) || {}
  const [name, setName] = useState(d.name || '')
  const [desc, setDesc] = useState(d.desc || '')
  const [bindPath, setBindPath] = useState(d.bindPath || '')
  const [bindPathManual, setBindPathManual] = useState(!!d.bindPathManual)
  const [researchEnabled, setResearchEnabled] = useState(!!d.researchEnabled)
  const [defaultUseWorktree, setDefaultUseWorktree] = useState(!!d.defaultUseWorktree)
  const [visibility, setVisibility] = useState<Visibility>(d.visibility || 'private')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    draftSave(DRAFT_KEY, { name, desc, bindPath, bindPathManual, researchEnabled, defaultUseWorktree, visibility }, { minChars: 0 })
  }, [name, desc, bindPath, bindPathManual, researchEnabled, defaultUseWorktree, visibility])

  const submit = async () => {
    if (!name.trim()) { setErr('请输入项目名称'); return }
    if (!bindPath.trim()) { setErr('请选择项目绑定路径'); return }
    setLoading(true); setErr('')
    try {
      const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({
        name, description: desc, visibility, bindPath, bindPathManual,
        defaultUseWorktree: researchEnabled ? false : defaultUseWorktree,
        researchEnabled, can_post_issue: false, can_run_session: false,
      }) })
      if (p?.error) { setErr(p.error); return }
      draftClear(DRAFT_KEY)
      onDone(p, p?.id && p?.created_by ? `/u/${p.created_by}/p/${p.id}` : undefined)
    } catch (e: any) { setErr(e?.message || '创建失败') } finally { setLoading(false) }
  }

  return (
    <CreateModalShell title="新建项目" onClose={onClose} dark={dark}
      footer={<Footer loading={loading} submitText="创建" onClose={onClose} onSubmit={submit} />}>
      <div>
        <SectionLabel>项目名称</SectionLabel>
        <TextInput value={name} onChange={v => { setName(v); setErr('') }} placeholder="例如：营销活动策划" autoFocus dark={dark} />
      </div>
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
          <button type="button" onClick={() => setPickerOpen(true)}
            className="h-10 px-3 rounded-xl border flex items-center gap-1 text-[12px] shrink-0 hover:bg-[var(--bg-card-hover)]"
            style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
            <FolderPlus className="w-3.5 h-3.5" /> 选择
          </button>
        </div>
      </div>
      <div>
        <SectionLabel hint="谁能看到这个项目">可见性</SectionLabel>
        <div className="grid grid-cols-4 gap-1.5">
          {VISIBILITY_OPTIONS.map(opt => {
            const active = visibility === opt.value
            return (
              <button key={opt.value} type="button" title={opt.desc} onClick={() => setVisibility(opt.value)}
                className="h-8 rounded-lg border text-[12px] transition-colors"
                style={active ? { background: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.48)', color: '#60a5fa' } : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>
      <label className="flex items-start gap-2 text-[13px] cursor-pointer select-none" style={{ color: dark ? '#cbd5e1' : '#334155' }}>
        <input type="checkbox" checked={researchEnabled} onChange={e => setResearchEnabled(e.target.checked)} className="w-4 h-4 mt-0.5 accent-blue-500" />
        <span><span className="font-medium">启用 Research 系统</span><span className="block text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>开启后可在本项目中创建 Research Agent 团队</span></span>
      </label>
      {!researchEnabled && (
        <label className="flex items-center gap-2 text-[13px] cursor-pointer select-none" style={{ color: dark ? '#cbd5e1' : '#334155' }}>
          <input type="checkbox" checked={defaultUseWorktree} onChange={e => setDefaultUseWorktree(e.target.checked)} className="w-4 h-4 accent-blue-500" />
          默认使用 git worktree（新建 Issue 时在绑定路径下开独立工作区）
        </label>
      )}
      {err && <ErrBanner>{err}</ErrBanner>}
      {pickerOpen && (
        <PathPickerModal initialPath={user?.work_dir} onClose={() => setPickerOpen(false)}
          onPick={(_abs, rel, manual) => { setBindPath(rel || _abs); setBindPathManual(!!manual); setPickerOpen(false) }} />
      )}
    </CreateModalShell>
  )
}

// 表单 2 (创建 Issue) 已移除: 顶栏新建 Issue 改为复用 modals.tsx 的标准 NewIssueModal (见 GlobalCreateRoot 的 issue 分支).

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
  const [model, setModel] = useState(d.model || 'codex')
  const [language, setLanguage] = useState<SessionLanguage>(d.language || 'zh')
  const [excludedSkills, setExcludedSkills] = useState<Set<string>>(new Set(d.excluded_skills || []))
  const [excludedMemories, setExcludedMemories] = useState<Set<string>>(new Set(d.excluded_memories || []))
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const projects = useAsyncList<any>(() => api('/api/projects').then((r: any) => Array.isArray(r) ? r : (r?.projects || [])), [])
  // 二级联动: 选 project 后拉 issues
  const issues = useAsyncList<any>(() => projectId ? api(`/api/projects/${projectId}/issues?status=active`).then((r: any) => Array.isArray(r) ? r : (r?.issues || [])) : Promise.resolve([]), [projectId])
  const selectedProject = projects.list.find((p: any) => p.id === projectId)
  const selectedIssue = issues.list.find((i: any) => i.id === issueId)

  // Skill/Memory 全集: 选完 issue 后拉 context-preview (POST, 拿 sources)
  const [availSkills, setAvailSkills] = useState<PickItem[]>([])
  const [availMemories, setAvailMemories] = useState<PickItem[]>([])
  useEffect(() => {
    if (!issueId) { setAvailSkills([]); setAvailMemories([]); return }
    let alive = true
    api(`/api/issues/${issueId}/context-preview`, { method: 'POST', body: JSON.stringify({ name: name || ' ', description: desc || ' ', excluded_skill_ids: [], excluded_memory_ids: [] }) })
      .then((p: any) => {
        if (!alive) return
        setAvailSkills((p?.sources?.skills || []).map((s: any) => ({ id: s.id, name: s.name, description: s.description, scope: s.scope || 'project' })))
        setAvailMemories((p?.sources?.memories || []).map((m: any) => ({ id: m.id, name: m.name, description: m.description, scope: m.scope || 'project' })))
      }).catch(() => { if (alive) { setAvailSkills([]); setAvailMemories([]) } })
    return () => { alive = false }
    // 仅在 issueId 变化时拉全集; 勾选/改名不重拉.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueId])

  useEffect(() => {
    draftSave(DRAFT_KEY, { projectId, issueId, name, desc, model, language, excluded_skills: Array.from(excludedSkills), excluded_memories: Array.from(excludedMemories) }, { minChars: 0 })
  }, [projectId, issueId, name, desc, model, language, excludedSkills, excludedMemories])

  const toggle = (set: Set<string>, id: string, setter: React.Dispatch<React.SetStateAction<Set<string>>>) => {
    const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); setter(n)
  }

  const submit = async () => {
    if (!projectId) { setErr('请选择目标项目'); return }
    if (!issueId) { setErr('请选择目标 Issue'); return }
    if (!name.trim()) { setErr('请填写 Session 名称'); return }
    setLoading(true); setErr('')
    try {
      const finalDesc = appendAttachmentsToDesc(desc.trim() || name, attachments)
      const s = await api(`/api/issues/${issueId}/sessions`, { method: 'POST', body: JSON.stringify({
        name, description: finalDesc, model, language,
        excluded_skill_ids: Array.from(excludedSkills), excluded_memory_ids: Array.from(excludedMemories),
      }) })
      if (s?.error) { setErr(s.error); return }
      draftClear(DRAFT_KEY)
      onDone(s, s?.session_id && userParam ? `/u/${userParam}/p/${projectId}/i/${issueId}?session=${s.session_id}` : undefined)
    } catch (e: any) { setErr(e?.message || '创建失败') } finally { setLoading(false) }
  }

  return (
    <CreateModalShell title="新建 Session" onClose={onClose} dark={dark} width={600}
      footer={<Footer loading={loading} submitText="创建" onClose={onClose} onSubmit={submit} disabled={!projectId || !issueId} />}>
      <SelectShell label="目标项目" current={selectedProject?.name} loading={projects.loading} onRefresh={projects.refresh} dark={dark}>
        <NativeSelect value={projectId} onChange={v => { setProjectId(v); setIssueId(''); setErr('') }} dark={dark}>
          <option value="">— 选择项目 —</option>
          {projects.list.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </NativeSelect>
      </SelectShell>
      <SelectShell label="目标 Issue" current={selectedIssue?.title} loading={issues.loading} onRefresh={issues.refresh} dark={dark} hint={projectId ? '' : '请先选择项目'}>
        <NativeSelect value={issueId} onChange={v => { setIssueId(v); setErr('') }} disabled={!projectId} dark={dark}>
          <option value="">— 选择 Issue —</option>
          {issues.list.map((i: any) => <option key={i.id} value={i.id}>{i.title}</option>)}
        </NativeSelect>
      </SelectShell>
      <div>
        <SectionLabel>Session 名称</SectionLabel>
        <TextInput value={name} onChange={v => { setName(v); setErr('') }} placeholder="给这个会话起个名字" autoFocus dark={dark} />
      </div>
      <div>
        <SectionLabel hint="选填">目的 / 问题描述</SectionLabel>
        <ExpandableTextarea value={desc} onValueChange={v => { setDesc(v); setErr('') }} placeholder="希望这个会话完成什么" overlayTitle="编辑 Session 目的"
          className="w-full h-24 px-3 py-2 rounded-xl text-[13px] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/40 resize-none"
          style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: dark ? '#f1f5f9' : '#1e293b' }} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <SectionLabel hint="创建后不可更改">模型</SectionLabel>
          <ModelSelect value={model} onChange={setModel} dark={dark} />
        </div>
        <div>
          <SectionLabel hint="注入上下文语言">语言</SectionLabel>
          <LanguageSelect value={language} onChange={setLanguage} />
        </div>
      </div>
      <div className="space-y-2 rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--input-border)' }}>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{issueId ? 'Skill / Memory（点击展开选择）' : '选择 Issue 后可配置 Skill / Memory'}</p>
        <PickerPopover title="Skill" items={availSkills} excluded={excludedSkills} onToggle={id => toggle(excludedSkills, id, setExcludedSkills)} emptyText="该 Issue 未启用 Skill" dark={dark} />
        <PickerPopover title="Memory" items={availMemories} excluded={excludedMemories} onToggle={id => toggle(excludedMemories, id, setExcludedMemories)} emptyText="无可用 Memory" dark={dark} />
      </div>
      <AttachmentZone attachments={attachments} setAttachments={setAttachments} projectId={projectId || undefined} dark={dark} />
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
  const [model, setModel] = useState(d.model || 'codex')
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
  const [mainSkillOpen, setMainSkillOpen] = useState(false)

  const projects = useAsyncList<any>(() => api('/api/projects').then((r: any) => Array.isArray(r) ? r : (r?.projects || [])), [])
  const selectedProject = projects.list.find((p: any) => p.id === projectId)
  const researchEnabled = !!selectedProject?.research_enabled
  const researches = useAsyncList<any>(() => projectId ? api(`/api/projects/${projectId}/researches?status=active`).then((r: any) => Array.isArray(r) ? r : (r?.researches || [])) : Promise.resolve([]), [projectId])
  const selectedResearch = researches.list.find((r: any) => r.id === researchId)

  // 选 project 后, 若未启用 Research → 置灰提交 + 提示
  useEffect(() => {
    if (projectId && selectedProject && !researchEnabled) {
      // 保留选择, 仅靠 disabled + hint 拦截
    }
  }, [projectId, selectedProject, researchEnabled])

  // 选 research 后拉 agent-skills + context-preview 全集
  useEffect(() => {
    if (!researchId) { setAgentSkills([]); setAvailSkills([]); setAvailMemories([]); setChosenMainSkill(null); return }
    let alive = true
    Promise.all([
      api(`/api/researches/${researchId}/research-agent-skills`).catch(() => []),
      api(`/api/researches/${researchId}/context-preview`, { method: 'POST', body: JSON.stringify({ name: name || ' ', description: desc || ' ', role, excluded_skill_ids: [], excluded_memory_ids: [] }) }).catch(() => null),
    ]).then(([ask, prev]: any) => {
      if (!alive) return
      const skills = (Array.isArray(ask) ? ask : []).map((s: any) => ({ id: s.id, name: s.name, description: s.description, scope: s.scope || 'project', research_role: s.research_role }))
      setAgentSkills(skills)
      setAvailSkills((prev?.sources?.skills || []).map((s: any) => ({ id: s.id, name: s.name, description: s.description, scope: s.scope || 'project', research_role: s.research_role })))
      setAvailMemories((prev?.sources?.memories || []).map((m: any) => ({ id: m.id, name: m.name, description: m.description, scope: m.scope || 'project' })))
      setExcludedSkills(new Set()); setExcludedMemories(new Set())
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchId, role])

  useEffect(() => {
    draftSave(DRAFT_KEY, { projectId, researchId, name, desc, role, model, language }, { minChars: 0 })
  }, [projectId, researchId, name, desc, role, model, language])

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
    setMainSkillOpen(false)
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

  const blockedReason = !projectId ? null : !researchEnabled ? '当前项目未启用 Research 系统，请前往项目设置开启' : null

  const submit = async () => {
    if (blockedReason) { setErr(blockedReason); return }
    if (!researchId) { setErr('请选择目标 Research'); return }
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
      onDone(s, s?.session_id && userParam ? `/u/${userParam}/p/${projectId}/r/${researchId}` : undefined)
    } catch (e: any) { setErr(e?.message || '创建失败') } finally { setLoading(false) }
  }

  const mainSkillRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!mainSkillOpen) return
    const close = (e: MouseEvent) => { if (mainSkillRef.current && !mainSkillRef.current.contains(e.target as Node)) setMainSkillOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [mainSkillOpen])

  return (
    <CreateModalShell title="新建 Research Agent" onClose={onClose} dark={dark} width={600}
      footer={<Footer loading={loading} submitText="创建" onClose={onClose} onSubmit={submit} disabled={!!blockedReason || !researchId} />}>
      <SelectShell label="目标项目" current={selectedProject?.name} loading={projects.loading} onRefresh={projects.refresh} dark={dark}>
        <NativeSelect value={projectId} onChange={v => { setProjectId(v); setResearchId(''); setErr('') }} dark={dark}>
          <option value="">— 选择项目 —</option>
          {projects.list.map((p: any) => <option key={p.id} value={p.id}>{p.name}{p.research_enabled ? '' : '（未启用 Research）'}</option>)}
        </NativeSelect>
      </SelectShell>
      {projectId && !researchEnabled && (
        <div className="rounded-xl px-3 py-2 text-[12px] flex items-center gap-2" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444' }}>
          <Ban className="w-3.5 h-3.5" /> 当前项目未启用 Research 系统，请前往项目设置开启后再创建 Research Agent。
        </div>
      )}
      <SelectShell label="目标 Research" current={selectedResearch?.title} loading={researches.loading} onRefresh={researches.refresh} dark={dark} hint={researchEnabled ? '已激活的 Research' : ''}>
        <NativeSelect value={researchId} onChange={v => { setResearchId(v); setErr('') }} disabled={!researchEnabled} dark={dark}>
          <option value="">— 选择 Research —</option>
          {researches.list.map((r: any) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </NativeSelect>
      </SelectShell>
      <div>
        <SectionLabel>Agent 名称</SectionLabel>
        <TextInput value={name} onChange={v => { setName(v); setErr('') }} placeholder="给这个 Agent 起个名字" autoFocus dark={dark} />
      </div>
      <DescriptionWithAttachments value={desc} onValueChange={v => { setDesc(v); setErr('') }} placeholder="希望这个 Agent 研究什么" attachments={attachments} setAttachments={setAttachments} projectId={projectId || undefined} dark={dark} />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <SectionLabel hint="创建后不可更改">模型</SectionLabel>
          <ModelSelect value={model} onChange={setModel} dark={dark} />
        </div>
        <div>
          <SectionLabel hint="注入上下文语言">语言</SectionLabel>
          <LanguageSelect value={language} onChange={setLanguage} />
        </div>
      </div>
      <div>
        <SectionLabel>角色</SectionLabel>
        <div className="grid grid-cols-2 gap-1.5">
          {([['research_assistant', '研究助理'], ['chief_researcher', '首席研究员']] as const).map(([k, label]) => {
            const active = role === k
            return (
              <button key={k} type="button" onClick={() => setRole(k)} disabled={!researchId}
                className="h-9 rounded-lg border text-[12px] transition-colors disabled:opacity-40"
                style={active ? { background: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.48)', color: '#60a5fa' } : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
                {label}
              </button>
            )
          })}
        </div>
      </div>
      {/* 主 Skill 强制联动: 选定主 → 关联自动勾选锁定, 冲突类置灰互斥 */}
      <div className="space-y-2 rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--input-border)' }}>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{researchId ? '主 Skill（选定后关联 Skill 自动锁定、冲突 Skill 自动互斥）' : '选择 Research 后可配置主 Skill'}</p>
        <div className="relative" ref={mainSkillRef}>
          <button type="button" onClick={() => researchId && setMainSkillOpen(v => !v)} disabled={!researchId}
            className="w-full h-10 rounded-xl border flex items-center justify-between px-3 text-[12px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-50"
            style={{ background: 'var(--input-bg)', borderColor: chosenMainSkill ? 'rgba(59,130,246,0.48)' : 'var(--input-border)', color: dark ? '#e2e8f0' : '#334155' }}>
            <span className="truncate flex items-center gap-1.5">
              {chosenMainSkill ? <><Lock className="w-3 h-3" style={{ color: '#60a5fa' }} />{chosenMainSkill.name}</> : '选择主 Skill（可选）'}
            </span>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${mainSkillOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--text-muted)' }} />
          </button>
          {mainSkillOpen && (
            <div className="absolute z-[80] mt-1 left-0 right-0 rounded-xl shadow-2xl overflow-hidden"
              style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)', maxHeight: '260px', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
              <button type="button" onClick={() => chooseMainSkill(null)} className="w-full text-left px-3 py-2 text-[12px] hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>不选择主 Skill（完全自定义）</button>
              {agentSkills.length === 0 && <p className="px-3 py-2 text-[11px] italic" style={{ color: 'var(--text-muted)' }}>该 Research 无可用 Agent Skill</p>}
              {agentSkills.map(sk => (
                <button key={sk.id} type="button" onClick={() => chooseMainSkill(sk)} className="w-full text-left px-3 py-2 hover:bg-[var(--bg-card-hover)]"
                  style={{ background: chosenMainSkill?.id === sk.id ? 'rgba(59,130,246,0.12)' : 'transparent' }}>
                  <div className="text-[12px] truncate" style={{ color: dark ? '#f1f5f9' : '#1e293b' }}>{sk.name}</div>
                  {sk.research_role && <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{sk.research_role}</div>}
                </button>
              ))}
            </div>
          )}
        </div>
        <PickerPopover title="Skill（关联已锁定 / 冲突已禁用）" items={availSkills} excluded={excludedSkills} onToggle={toggleSkill}
          lockedOf={isMainSkill} mutexOf={isMutexSkill} accentLabelOf={accentSkill} emptyText="无可用 Skill" dark={dark} />
        <PickerPopover title="Memory" items={availMemories} excluded={excludedMemories} onToggle={toggleMemory} emptyText="无可用 Memory" dark={dark} />
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
        className="mobius-create-trigger h-8 flex items-center gap-1 rounded-lg pl-2 pr-2 border hover:bg-[var(--bg-card-hover)] transition-colors"
        style={{ color: 'var(--text-primary)', borderColor: 'var(--border-color)' }}>
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

// 目标选择器: 顶栏全局新建 Issue 时若无当前项目上下文, 先选目标项目再开 NewIssueModal.
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

// 根调度: 根据 kind 渲染对应表单; issue 复用系统标准 NewIssueModal, 其余用自定义表单; 创建成功 → 次级确认弹窗
export function GlobalCreateRoot({ kind, ctx, onClose }: {
  kind: CreateKind | null
  ctx: { projectId?: string; issueId?: string }
  onClose: () => void
}) {
  const navigate = useNavigate()
  const user = useStore(s => s.user)
  const [target, setTarget] = useState<{ projectId?: string }>({})
  const projectId = target.projectId || ctx.projectId
  const [success, setSuccess] = useState<{ entity: any; detailUrl?: string; name: string } | null>(null)
  const dark = useStore(s => s.theme) !== 'light'

  if (success) {
    return <CreateSuccessDialog kind={kind || 'project'} name={success.name} detailUrl={success.detailUrl} onClose={() => { setSuccess(null); onClose() }} />
  }
  const handleDone = (entity: any, detailUrl?: string) => {
    setSuccess({ entity, detailUrl, name: entity?.name || entity?.title || '' })
  }

  if (kind === 'project') return <CreateProjectForm onClose={onClose} onDone={handleDone} />
  if (kind === 'issue') {
    // issue 复用系统标准 NewIssueModal (与页面内「新建 Issue」一致); 无当前项目 → 先弹 TargetPicker 选项目.
    if (!projectId) return <TargetPicker need="issue" onClose={onClose} onPicked={t => setTarget({ projectId: t.projectId })} />
    return <NewIssueModal projectId={projectId} onClose={onClose} onCreated={(iss: any) => { onClose(); if (iss?.id) navigate(`/u/${user?.id}/p/${projectId}/i/${iss.id}`) }} />
  }
  if (kind === 'session') return <CreateSessionForm onClose={onClose} onDone={handleDone} defaultProjectId={ctx.projectId} defaultIssueId={ctx.issueId} />
  if (kind === 'research') return <CreateResearchForm onClose={onClose} onDone={handleDone} defaultProjectId={ctx.projectId} />
  return null
}
