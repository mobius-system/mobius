import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { Bot, Bookmark, Wrench, MoreHorizontal, History, Copy, Check, Replace, Archive, Maximize2, Minimize2, X, ZoomIn, FileDiff, Terminal, GitCompare, Loader2, Mic, RefreshCw, SendHorizontal, Square, Plus, Paperclip } from 'lucide-react'
import { useStore, api } from '../store'
import { timeAgo, isRecentlyActive } from './shell'
import { AgentStatusDot } from './AgentStatusDot'
import { SessionWelcomeCards, SessionStartModal, SessionSkillMemoryEditor } from './session-welcome'
import { NewSessionModal } from './modals'
import { OpenInVSCodeButton, ProjectPortEntryButton } from './project-files'
import { JsonlView, JsonlLiveTailCard, jsonlEntrySummaryKey } from './jsonl-view'
import { VSCodeOpenProvider } from './jsonl-vscode-link'
import { isGuidedDemoSession, patchGuidedDemoSessionCompleted } from '../services/guided-demo'
import { MobiusLogo } from './mobius-logo'
import { PlanningEditor } from './planning-editor'
import { draftClear, draftLoad, draftSave } from '../services/input-drafts'
import { isFireAndForgetSession } from '../services/session-start-policy'
import {
  formatVoiceSeconds,
  permissionErrorMessage,
  recordingFileExtension,
  supportedVoiceMimeType,
  type VoiceInputState,
  type VoiceTranscribeResponse,
  VOICE_RECORDING_MAX_MS,
} from '../services/assistant-voice'

const GUIDED_DEMO_TOUR_EVENT = 'imac:guided-demo-tour:start'

// "重要"的 JSONL 条目类型: 不在该集合内的一律视为次要条目, 默认隐藏.
// "隐藏次要条目" 的展示过滤不修改源数据.
const MAJOR_JSONL_TYPES = new Set([
  'user', 'assistant', 'attachment', 'system', 'queue-operation',
  'session_meta', 'turn_context', 'event_msg', 'response_item', 'error',
])
// 连续重复 entry 也按次要条目处理. 这里额外忽略可能由后端附加的顶层行号字段,
// 避免 "除了序号不同以外完全一致" 的卡片逃过合并.
const JSONL_SEQUENCE_KEYS = new Set(['line_no', 'lineNo', '_line_no', '_lineNo', '__line_no', '__lineNo'])
const JSONL_DUPLICATE_SIGNATURE_CACHE = new WeakMap<object, string>()

function normalizeJsonlForDuplicateCheck(value: any, depth = 0): any {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => normalizeJsonlForDuplicateCheck(item, depth + 1))

  const out: Record<string, any> = {}
  for (const key of Object.keys(value).sort()) {
    if (depth === 0 && JSONL_SEQUENCE_KEYS.has(key)) continue
    const child = value[key]
    if (typeof child !== 'undefined') out[key] = normalizeJsonlForDuplicateCheck(child, depth + 1)
  }
  return out
}

function jsonlDuplicateSignature(entry: any): string {
  if (entry && typeof entry === 'object') {
    const cached = JSONL_DUPLICATE_SIGNATURE_CACHE.get(entry)
    if (cached !== undefined) return cached
  }
  try {
    const encoded = JSON.stringify(normalizeJsonlForDuplicateCheck(entry))
    const signature = typeof encoded === 'string' ? encoded : String(entry)
    if (entry && typeof entry === 'object') JSONL_DUPLICATE_SIGNATURE_CACHE.set(entry, signature)
    return signature
  } catch {
    const signature = String(entry)
    if (entry && typeof entry === 'object') JSONL_DUPLICATE_SIGNATURE_CACHE.set(entry, signature)
    return signature
  }
}

function userMessageContentForEventMirror(entry: any): string | null {
  if (entry?.type !== 'user') return null
  const content = entry?.message?.content
  return typeof content === 'string' ? content : null
}

function entryHasMobiusField(entry: any): boolean {
  return Boolean(entry && Object.prototype.hasOwnProperty.call(entry, 'mobius') && entry.mobius)
}

function eventMsgMirrorsPreviousUser(entry: any, previousUserMessages: Set<string>): boolean {
  if (entry?.type !== 'event_msg') return false
  const message = entry?.payload?.message
  return typeof message === 'string' && previousUserMessages.has(message)
}

function sessionModelLabel(model?: string | null, explicitLabel?: string | null) {
  if (explicitLabel) return explicitLabel
  if (!model) return ''
  const labels: Record<string, string> = {
    opus: 'Opus',
    'opus-4.8': 'Opus',
    codex: 'GPT-5.5 Codex',
    'gpt-5.5': 'GPT-5.5 Codex',
  }
  return labels[model] || model
}

function sessionProxyUsesProxy(useProxy?: any) {
  return !(useProxy === 0 || useProxy === false || useProxy === '0' || useProxy === 'false')
}

function sessionProxyTitle(useProxy?: any, model?: string) {
  const on = sessionProxyUsesProxy(useProxy)
  const isCodex = model === 'codex' || model === 'gpt-5.5'
  if (isCodex) return on ? 'Plus 官方订阅（codex_fqx）' : 'Rightcode 国内中转（codex）'
  return on ? '使用代理网络' : '不使用代理网络'
}

function sessionProxyLabel(useProxy?: any, model?: string) {
  if (useProxy === undefined || useProxy === null) return ''
  const isCodex = model === 'codex' || model === 'gpt-5.5'
  if (isCodex) {
    return sessionProxyUsesProxy(useProxy) ? 'Plus' : 'Rightcode'
  }
  return sessionProxyUsesProxy(useProxy) ? '代理' : '直连'
}

function buildProjectKnowledgePrompt(knowledgePath: string) {
  const safePath = knowledgePath.replace(/`/g, '\\`')
  return `When you finish all the works, please update the knowledge about this project written in \`${safePath}\`, read and update this document, create it if it does not exist.`
}

function continueSessionName(session: any) {
  const base = String(session?.name || '').trim() || '未命名Session'
  return `${base} - 更换模型`
}

function makeSendRequestId() {
  return `send-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function permissionReplyText(value: string) {
  const normalized = String(value || '').trim()
  if (normalized === 'perm:allow' || normalized === 'allow') return 'allow'
  if (normalized === 'perm:deny' || normalized === 'deny') return 'deny'
  if (normalized === 'perm:allow_all' || normalized === 'allow_all' || normalized === 'allow all') return 'allow all'
  return ''
}

// =====================================================================
// 附件 (粘贴 / 拖放 / 上传按钮 三入口共用)
// =====================================================================
type AttachmentStatus = 'uploading' | 'done' | 'error'
type Attachment = {
  id: string
  name: string
  size: number
  kind: 'image' | 'file'
  previewUrl?: string      // 仅 image: 本地 ObjectURL, 用作缩略图
  status: AttachmentStatus
  remotePath?: string      // 上传成功后的服务端绝对路径 (用于 prompt 拼接)
  error?: string
}

type AttachmentImagePreview = {
  id: string
  name: string
  src: string
}

type SessionInputEntry = {
  id: string
  session_id?: string
  input_text?: string
  content?: string
  created_at?: string
  request_id?: string | null
  turn_number?: number | null
}

type SessionFileFeature = {
  path: string
  display_path: string
  original_paths?: string[]
  count: number
  first_timestamp?: string | null
  last_timestamp?: string | null
  outside_workspace?: boolean
}

type SessionBashCommand = {
  id: string
  timestamp?: string | null
  command: string
  description?: string | null
  cwd?: string | null
  source?: string | null
}

type SessionDiffMode = 'unstaged' | 'staged' | 'last_commit' | 'last_two_commits'

type SessionGitDiff = {
  path: string
  display_path: string
  mode: SessionDiffMode
  diff: string
  ok: boolean
  error?: string | null
}

function makeAttachmentId() {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function attachmentKindOf(file: File): 'image' | 'file' {
  return file.type.startsWith('image/') ? 'image' : 'file'
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

// 多种常见扩展名 → 简短分类标签 (用于无缩略图的文件芯片)
function fileExtBadge(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (!ext || ext === name.toLowerCase()) return 'FILE'
  return ext.slice(0, 4).toUpperCase()
}

// 上传单个文件到 /api/upload (multer 接收 field 名 'file').
// 不能复用 store 里的 api(), 它默认设了 Content-Type: application/json — FormData 必须留空 Content-Type.
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

// 输入框内的紧凑附件芯片. 图片缩略图 / 文件短标签 + 删除按钮 + 上传状态.
function AttachmentChip({ att, theme, onRemove, onPreview }: {
  att: Attachment
  theme: 'dark' | 'light' | 'purple'
  onRemove: () => void
  onPreview?: (preview: AttachmentImagePreview) => void
}) {
  const isImage = att.kind === 'image' && att.previewUrl
  const isDark = theme !== 'light'
  const baseStyle: React.CSSProperties = {
    background: isDark ? '#111827' : '#ffffff',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.10)'}`,
  }
  const fileLabel = fileExtBadge(att.name).slice(0, 2)
  return (
    <div className="relative group flex-shrink-0" title={`${att.name}${att.size ? ` · ${formatFileSize(att.size)}` : ''}`}>
      {isImage ? (
        <button
          type="button"
          onClick={() => onPreview?.({ id: att.id, name: att.name, src: att.previewUrl! })}
          className="w-6 h-6 rounded-md overflow-hidden relative block text-left focus:outline-none focus:ring-2 focus:ring-blue-500/35 cursor-zoom-in"
          style={baseStyle}
          title={`${att.name} · 点击预览`}
          aria-label={`预览图片 ${att.name}`}>
          <img src={att.previewUrl} alt={att.name} className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-black/35 text-white opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity inline-flex items-center justify-center">
            <ZoomIn className="w-3 h-3" strokeWidth={2.2} />
          </div>
          {att.status === 'uploading' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <svg className="w-3 h-3 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
              </svg>
            </div>
          )}
          {att.status === 'error' && (
            <div className="absolute inset-0 flex items-center justify-center bg-red-500/60 text-white text-[10px] font-semibold" title={att.error}>
              失败
            </div>
          )}
        </button>
      ) : (
        <div
          className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 relative text-[9px] font-semibold leading-none"
          style={{ ...baseStyle, color: isDark ? '#bfdbfe' : '#2563eb' }}>
          <span>{fileLabel}</span>
            {att.status === 'uploading' && (
              <div className="absolute inset-0 rounded-md flex items-center justify-center bg-black/50">
                <svg className="w-3 h-3 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
                </svg>
              </div>
            )}
            {att.status === 'error' && (
              <div className="absolute inset-0 rounded-md flex items-center justify-center bg-red-500/70 text-white text-[8px] font-semibold" title={att.error}>
                !
              </div>
            )}
        </div>
      )}
      <button type="button" onClick={(e) => { e.stopPropagation(); onRemove() }}
        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center text-white shadow opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
        style={{ background: '#1f2937' }}
        title="移除">
        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

function AttachmentImagePreviewModal({ preview, onClose }: {
  preview: AttachmentImagePreview
  onClose: () => void
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-black/80 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`图片预览 ${preview.name}`}>
      <button className="absolute inset-0 cursor-zoom-out" type="button" aria-label="关闭图片预览" onClick={onClose} />
      <div className="relative z-10 h-12 flex items-center justify-between gap-3 px-4 border-b border-white/10 text-white">
        <div className="min-w-0 text-[13px] font-medium truncate">{preview.name}</div>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
          className="h-8 w-8 rounded-full inline-flex items-center justify-center text-white/80 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0">
          <X className="w-4 h-4" strokeWidth={2} />
        </button>
      </div>
      <div className="relative z-10 flex-1 min-h-0 flex items-center justify-center p-4 sm:p-6 pointer-events-none">
        <img
          src={preview.src}
          alt={preview.name}
          className="max-w-full max-h-full object-contain rounded-lg shadow-2xl pointer-events-auto"
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    </div>
  )
}

const TUI_CONTACT_TIMEOUT_MESSAGE = '任务失败，与后台TUI联络超时，请尝试继续提问，或者重建session。'

function isTuiContactTimeoutText(text: string) {
  return text === TUI_CONTACT_TIMEOUT_MESSAGE || /TUI was not ready within \d+ms/i.test(text || '')
}

function normalizeTuiContactTimeoutMessage(text: string) {
  return isTuiContactTimeoutText(text) ? TUI_CONTACT_TIMEOUT_MESSAGE : text
}

function formatSendError(msg: any) {
  const body = normalizeTuiContactTimeoutMessage(msg?.message || '发送失败')
  return msg?.log_path ? `${body}\n日志: ${msg.log_path}` : body
}

function formatBackendFailureMessage(reason: string) {
  const body = normalizeTuiContactTimeoutMessage((reason || '').trim())
  if (!body) return ''
  return body.startsWith('任务失败') ? body : `任务失败：${body}`
}

function replayTextOf(entry: SessionInputEntry) {
  const typed = typeof entry.input_text === 'string' ? entry.input_text : ''
  return typed.trim() ? typed : (entry.content || '')
}

function previewTextOf(entry: SessionInputEntry) {
  const text = replayTextOf(entry).trim()
  return text || '(空输入)'
}

function formatFeatureTime(value?: string | null) {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

async function copyTextToClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the textarea fallback below
  }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', 'true')
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    el.style.top = '0'
    document.body.appendChild(el)
    el.focus()
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

// =====================================================================
// Avatar
// =====================================================================
export function Avatar({ role }: { role: string }) {
  if (role === 'user') return (
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500/30 to-blue-600/20 border border-blue-500/15 flex items-center justify-center flex-shrink-0">
      <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
    </div>
  )
  return (
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500/20 to-teal-500/10 border border-emerald-500/15 flex items-center justify-center flex-shrink-0">
      <Bot className="w-4 h-4 text-emerald-300" strokeWidth={1.75} />
    </div>
  )
}

// =====================================================================
// 消息工具按钮
// =====================================================================
export function ActionButton({ icon, label, onClick, active, color }: { icon: React.ReactNode; label: string; onClick: (e: React.MouseEvent) => void; active?: boolean; color?: string }) {
  return (
    <button onClick={onClick} title={label}
      className={`p-1.5 rounded-md transition-all ${active ? 'bg-yellow-500/15 text-yellow-400' : `hover:bg-[var(--bg-hover)] ${color || 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}`}>
      {icon}
    </button>
  )
}

function SessionInputReplayModal({ sessionId, onPick, onClose }: {
  sessionId: string
  onPick: (text: string) => void
  onClose: () => void
}) {
  const { theme } = useStore()
  const [entries, setEntries] = useState<SessionInputEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copyError, setCopyError] = useState('')
  const [query, setQuery] = useState('')
  const [copiedEntryKey, setCopiedEntryKey] = useState('')
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textMuted = theme !== 'light' ? '#94a3b8' : '#64748b'

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setCopyError('')
    setEntries([])
    api(`/api/sessions/${sessionId}/inputs`)
      .then((data: any) => {
        if (cancelled) return
        setEntries(Array.isArray(data?.entries) ? data.entries : [])
      })
      .catch((e: any) => {
        if (cancelled) return
        setError(e?.message || '读取输入回放失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [sessionId])

  useEffect(() => {
    return () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    }
  }, [])

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((entry) => replayTextOf(entry).toLowerCase().includes(q))
  }, [entries, query])

  const copyEntry = async (key: string, text: string) => {
    if (!text) return
    const ok = await copyTextToClipboard(text)
    if (!ok) {
      setCopyError('复制失败，请手动选择文本复制')
      return
    }
    setCopyError('')
    setCopiedEntryKey(key)
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    copyResetTimer.current = setTimeout(() => setCopiedEntryKey(''), 1500)
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[720px] max-w-[92vw] max-h-[78vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="px-5 py-3 border-b flex items-center gap-3 flex-shrink-0" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <History className="w-4 h-4 text-blue-400 flex-shrink-0" strokeWidth={1.8} />
            <span className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>回放输入</span>
            <span className="text-[11px] font-normal flex-shrink-0" style={{ color: 'var(--text-muted)' }}>· {entries.length} 条</span>
          </div>
          <button onClick={onClose}
            className="h-7 px-2.5 text-[11px] rounded-md border border-[var(--border-color-strong)] hover:bg-[var(--bg-card-hover)] transition-colors"
            style={{ color: 'var(--text-secondary)' }}>关闭</button>
        </div>

        <div className="px-5 py-3 border-b flex-shrink-0" style={{ borderColor: 'var(--border-color)' }}>
          <input value={query} onChange={e => setQuery(e.target.value)}
            placeholder="搜索输入内容"
            className="w-full h-9 px-3 rounded-lg text-[13px] focus:outline-none focus:border-blue-500/40"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
          {copyError && <div className="mt-2 text-[11px] text-red-400">{copyError}</div>}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="text-center py-10 text-[13px]" style={{ color: textMuted }}>加载中...</div>
          )}
          {!loading && error && (
            <pre className="text-[12px] text-red-400 whitespace-pre-wrap break-words rounded-lg p-3"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)' }}>{error}</pre>
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="text-center py-10 text-[13px]" style={{ color: textMuted }}>暂无可回放输入</div>
          )}
          {!loading && !error && entries.length > 0 && filteredEntries.length === 0 && (
            <div className="text-center py-10 text-[13px]" style={{ color: textMuted }}>没有匹配的输入</div>
          )}
          {!loading && !error && filteredEntries.length > 0 && (
            <div className="space-y-2">
              {filteredEntries.map((entry, index) => {
                const replayText = replayTextOf(entry)
                const entryKey = entry.id || `${entry.created_at || 'input'}-${index}`
                const copied = copiedEntryKey === entryKey
                return (
                  <div key={entryKey}
                    className="rounded-xl border px-3.5 py-3 transition-colors hover:bg-[var(--bg-card-hover)]"
                    style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}>
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-[11px] flex-1 min-w-0 truncate" style={{ color: textMuted }}>
                            {entry.created_at ? timeAgo(entry.created_at) : '未知时间'}
                          </span>
                          {entry.turn_number ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
                              style={{ color: textMuted, background: 'var(--bg-card-hover)' }}>
                              turn {entry.turn_number}
                            </span>
                          ) : null}
                        </div>
                        <div className="text-[13px] leading-relaxed max-h-36 overflow-y-auto whitespace-pre-wrap break-words select-text pr-1"
                          style={{ color: 'var(--text-primary)' }}>
                          {previewTextOf(entry)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => copyEntry(entryKey, replayText)}
                          disabled={!replayText}
                          title={copied ? '已复制' : '复制输入'}
                          aria-label={copied ? '已复制' : '复制输入'}
                          className="h-8 w-8 rounded-lg border inline-flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--bg-card-hover)]"
                          style={{ color: copied ? '#22c55e' : 'var(--text-secondary)', borderColor: 'var(--border-color-strong)' }}>
                          {copied ? <Check className="w-3.5 h-3.5" strokeWidth={2} /> : <Copy className="w-3.5 h-3.5" strokeWidth={1.9} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => onPick(replayText)}
                          disabled={!replayText}
                          title="替换当前输入"
                          aria-label="替换当前输入"
                          className="h-8 w-8 rounded-lg border inline-flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-500/10"
                          style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color-strong)' }}>
                          <Replace className="w-3.5 h-3.5" strokeWidth={1.9} />
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CompactContextConfirmModal({ onConfirm, onClose }: {
  onConfirm: () => void
  onClose: () => void
}) {
  const { theme } = useStore()
  const textPrimary = theme !== 'light' ? '#f1f5f9' : '#1e293b'
  const textMuted = theme !== 'light' ? '#9ca3af' : '#64748b'
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative w-[360px] max-w-[calc(100vw-32px)] rounded-2xl p-6 shadow-2xl"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="text-[15px] font-semibold mb-2" style={{ color: textPrimary }}>压缩上文</h3>
        <p className="text-[13px] leading-relaxed mb-5" style={{ color: textMuted }}>
          是否继续，将消耗一段时间压缩上文；压缩期间，您可以继续发送后续指令，但响应会延后。期间点击“终止”可以打断压缩。
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border"
            style={{ color: textMuted, borderColor: 'var(--input-border)' }}>
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 h-9 rounded-xl text-[13px] text-white bg-blue-500 hover:bg-blue-600 transition-colors">
            继续
          </button>
        </div>
      </div>
    </div>
  )
}

const DIFF_MODE_OPTIONS: { mode: SessionDiffMode; label: string }[] = [
  { mode: 'unstaged', label: '未Stage修改' },
  { mode: 'staged', label: '已Stage未提交' },
  { mode: 'last_commit', label: '最近一次 commit' },
  { mode: 'last_two_commits', label: '最近两次 commit' },
]

function diffLineClass(line: string) {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'code-diff-line--added'
  if (line.startsWith('-') && !line.startsWith('---')) return 'code-diff-line--removed'
  if (line.startsWith('@@')) return 'code-diff-line--hunk'
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
    return 'code-diff-line--meta'
  }
  return 'code-diff-line'
}

function GitDiffBlock({ diff }: { diff: string }) {
  const lines = diff ? diff.split('\n') : []
  return (
    <div className="min-w-max py-1 font-mono text-[11px] leading-[1.45]">
      {lines.map((line, index) => (
        <div key={`${index}-${line.slice(0, 24)}`} className={`grid grid-cols-[3.25rem_minmax(0,1fr)] ${diffLineClass(line)}`}>
          <span className="code-diff-line-number select-none border-r border-[var(--border-color)]/50 px-2 text-right">
            {index + 1}
          </span>
          <code className="whitespace-pre px-2 text-inherit">{line || ' '}</code>
        </div>
      ))}
    </div>
  )
}

function SessionFileChangesModal({ sessionId, onClose }: {
  sessionId: string
  onClose: () => void
}) {
  const [files, setFiles] = useState<SessionFileFeature[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [mode, setMode] = useState<SessionDiffMode>('unstaged')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [workspaceError, setWorkspaceError] = useState('')
  const [diff, setDiff] = useState<SessionGitDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState('')

  const selectedFile = useMemo(
    () => files.find(file => file.path === selectedPath || file.display_path === selectedPath) || null,
    [files, selectedPath],
  )

  const loadFiles = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api(`/api/sessions/${sessionId}/features/files`)
      const nextFiles = Array.isArray(data?.files) ? data.files : []
      setFiles(nextFiles)
      setWorkspaceError(typeof data?.workspace_error === 'string' ? data.workspace_error : '')
      setSelectedPath(prev => {
        if (prev && nextFiles.some((file: SessionFileFeature) => file.path === prev || file.display_path === prev)) return prev
        return nextFiles[0]?.path || ''
      })
    } catch (e: any) {
      setError(e?.message || '读取文件修改清单失败')
      setFiles([])
      setSelectedPath('')
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  useEffect(() => {
    if (!selectedPath) {
      setDiff(null)
      setDiffError('')
      setDiffLoading(false)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    setDiffError('')
    const url = `/api/sessions/${sessionId}/features/git-diff?mode=${encodeURIComponent(mode)}&file=${encodeURIComponent(selectedPath)}`
    api(url)
      .then((data: any) => {
        if (cancelled) return
        const first = Array.isArray(data?.diffs) ? data.diffs[0] : null
        setDiff(first || null)
        if (first && first.ok === false) setDiffError(first.error || '读取 diff 失败')
      })
      .catch((e: any) => {
        if (cancelled) return
        setDiff(null)
        setDiffError(e?.message || '读取 diff 失败')
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => { cancelled = true }
  }, [sessionId, selectedPath, mode])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex h-[82vh] w-[min(1180px,94vw)] flex-col overflow-hidden rounded-2xl shadow-2xl"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex flex-shrink-0 items-center gap-3 border-b px-5 py-3" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FileDiff className="h-4 w-4 flex-shrink-0 text-blue-400" strokeWidth={1.8} />
            <span className="truncate text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>文件修改清单</span>
            <span className="flex-shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>· {files.length} 个文件</span>
          </div>
          <button
            type="button"
            onClick={() => void loadFiles()}
            disabled={loading}
            title="重新扫描"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border-color-strong)] px-2.5 text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40"
            style={{ color: 'var(--text-secondary)' }}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCompare className="h-3.5 w-3.5" />}
            重新扫描
          </button>
          <button onClick={onClose}
            className="h-7 px-2.5 text-[11px] rounded-md border border-[var(--border-color-strong)] hover:bg-[var(--bg-card-hover)] transition-colors"
            style={{ color: 'var(--text-secondary)' }}>关闭</button>
        </div>

        {(error || workspaceError) && (
          <div className="mx-5 mt-3 rounded-lg border px-3 py-2 text-[12px] text-red-300 bg-red-500/10 border-red-500/25">
            {error || workspaceError}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <div className="flex w-[34%] min-w-[260px] flex-col border-r" style={{ borderColor: 'var(--border-color)' }}>
            <div className="border-b px-4 py-2 text-[11px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
              修改文件来自 session JSONL 特征，右侧 diff 来自当前 Git 仓库。
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {loading && (
                <div className="flex items-center justify-center gap-2 py-10 text-[13px]" style={{ color: 'var(--text-muted)' }}>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  扫描中...
                </div>
              )}
              {!loading && files.length === 0 && !error && (
                <div className="py-10 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>暂无文件修改记录</div>
              )}
              {!loading && files.length > 0 && (
                <div className="space-y-1">
                  {files.map(file => {
                    const active = file.path === selectedPath || file.display_path === selectedPath
                    return (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => setSelectedPath(file.path)}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${active ? 'border-blue-500/35 bg-blue-500/10' : 'border-transparent hover:bg-[var(--bg-card-hover)]'}`}>
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={file.display_path} style={{ color: 'var(--text-primary)' }}>
                            {file.display_path}
                          </span>
                          <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--text-muted)', background: 'var(--bg-card-hover)' }}>
                            {file.count}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {formatFeatureTime(file.last_timestamp)}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2" style={{ borderColor: 'var(--border-color)' }}>
              {DIFF_MODE_OPTIONS.map(option => {
                const active = mode === option.mode
                return (
                  <button
                    key={option.mode}
                    type="button"
                    onClick={() => setMode(option.mode)}
                    className={`h-8 rounded-lg border px-3 text-[12px] transition-colors ${active ? 'border-blue-500/35 bg-blue-500/10 text-blue-300' : 'border-[var(--border-color-strong)] hover:bg-[var(--bg-card-hover)]'}`}
                    style={{ color: active ? undefined : 'var(--text-secondary)' }}>
                    {option.label}
                  </button>
                )
              })}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {!selectedFile && !loading && (
                <div className="py-16 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>请选择一个文件</div>
              )}
              {selectedFile && (
                <div className="min-w-0">
                  <div className="sticky top-0 z-10 flex min-w-0 items-center gap-2 border-b px-4 py-2"
                    style={{ background: 'var(--modal-bg)', borderColor: 'var(--border-color)' }}>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={selectedFile.display_path} style={{ color: 'var(--text-primary)' }}>
                      {selectedFile.display_path}
                    </span>
                    {diffLoading && <Loader2 className="h-4 w-4 animate-spin text-blue-400" />}
                  </div>
                  {diffError && (
                    <pre className="m-4 whitespace-pre-wrap break-words rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-[12px] text-red-300">{diffError}</pre>
                  )}
                  {!diffLoading && !diffError && (!diff?.diff || diff.diff.trim() === '') && (
                    <div className="py-16 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>当前模式没有 diff</div>
                  )}
                  {!diffError && diff?.diff && diff.diff.trim() !== '' && (
                    <div className="overflow-auto">
                      <GitDiffBlock diff={diff.diff} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SessionBashCommandsModal({ sessionId, onClose }: {
  sessionId: string
  onClose: () => void
}) {
  const [commands, setCommands] = useState<SessionBashCommand[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [copiedId, setCopiedId] = useState('')
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadCommands = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api(`/api/sessions/${sessionId}/features/bash`)
      setCommands(Array.isArray(data?.commands) ? data.commands : [])
    } catch (e: any) {
      setError(e?.message || '读取 Bash 命令失败')
      setCommands([])
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void loadCommands()
  }, [loadCommands])

  useEffect(() => {
    return () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter(command => (
      command.command.toLowerCase().includes(q)
      || (command.description || '').toLowerCase().includes(q)
      || (command.cwd || '').toLowerCase().includes(q)
    ))
  }, [commands, query])

  const copyCommand = async (command: SessionBashCommand) => {
    const ok = await copyTextToClipboard(command.command)
    if (!ok) return
    setCopiedId(command.id)
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    copyResetTimer.current = setTimeout(() => setCopiedId(''), 1500)
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex h-[80vh] w-[min(920px,94vw)] flex-col overflow-hidden rounded-2xl shadow-2xl"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex flex-shrink-0 items-center gap-3 border-b px-5 py-3" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Terminal className="h-4 w-4 flex-shrink-0 text-emerald-400" strokeWidth={1.8} />
            <span className="truncate text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Session Bash 命令</span>
            <span className="flex-shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>· {commands.length} 条</span>
          </div>
          <button
            type="button"
            onClick={() => void loadCommands()}
            disabled={loading}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--border-color-strong)] px-2.5 text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40"
            style={{ color: 'var(--text-secondary)' }}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCompare className="h-3.5 w-3.5" />}
            重新扫描
          </button>
          <button onClick={onClose}
            className="h-7 px-2.5 text-[11px] rounded-md border border-[var(--border-color-strong)] hover:bg-[var(--bg-card-hover)] transition-colors"
            style={{ color: 'var(--text-secondary)' }}>关闭</button>
        </div>

        <div className="border-b px-5 py-3" style={{ borderColor: 'var(--border-color)' }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索命令、描述或工作目录"
            className="h-9 w-full rounded-lg px-3 text-[13px] focus:outline-none focus:border-blue-500/40"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-[13px]" style={{ color: 'var(--text-muted)' }}>
              <Loader2 className="h-4 w-4 animate-spin" />
              扫描中...
            </div>
          )}
          {!loading && error && (
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-[12px] text-red-300">{error}</pre>
          )}
          {!loading && !error && commands.length === 0 && (
            <div className="py-10 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>暂无 Bash 命令记录</div>
          )}
          {!loading && !error && commands.length > 0 && filtered.length === 0 && (
            <div className="py-10 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>没有匹配的命令</div>
          )}
          {!loading && !error && filtered.length > 0 && (
            <div className="space-y-3">
              {filtered.map((command, index) => {
                const copied = copiedId === command.id
                return (
                  <div key={command.id || index} className="rounded-xl border p-3.5" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}>
                    <div className="mb-2 flex min-w-0 items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          <span>{formatFeatureTime(command.timestamp)}</span>
                          {command.timestamp && <span>· {timeAgo(command.timestamp)}</span>}
                          {command.source && <span className="rounded px-1.5 py-0.5" style={{ background: 'var(--bg-card-hover)' }}>{command.source}</span>}
                        </div>
                        {command.description && (
                          <div className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{command.description}</div>
                        )}
                        {command.cwd && (
                          <div className="mt-1 truncate font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{command.cwd}</div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => void copyCommand(command)}
                        className="h-8 w-8 flex-shrink-0 rounded-lg border inline-flex items-center justify-center transition-colors hover:bg-[var(--bg-card-hover)]"
                        title={copied ? '已复制' : '复制命令'}
                        aria-label={copied ? '已复制' : '复制命令'}
                        style={{ color: copied ? '#22c55e' : 'var(--text-secondary)', borderColor: 'var(--border-color-strong)' }}>
                        {copied ? <Check className="h-3.5 w-3.5" strokeWidth={2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.9} />}
                      </button>
                    </div>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 font-mono text-[11px] leading-relaxed"
                      style={{ background: 'var(--prose-bg)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}>
                      {command.command}
                    </pre>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// ChatHeaderOverflowMenu — 把次要 chat 头部按钮收纳进 `…` 菜单
// (原始数据 / 隐藏次要 / 显示时间与序号 / 项目知识沉淀)
// =====================================================================
function ChatHeaderOverflowMenu({
  jsonlCount, minorCount, hideMinor, onToggleHideMinor, onOpenRaw,
  showJsonlMeta, onToggleShowJsonlMeta,
  onSendProjectKnowledge, projectKnowledgeSending, canSendProjectKnowledge,
  onContinueWithOtherModel, canContinueWithOtherModel,
  onStop, canStop,
}: {
  jsonlCount: number
  minorCount: number
  hideMinor: boolean
  onToggleHideMinor: () => void
  onOpenRaw: () => void
  showJsonlMeta: boolean
  onToggleShowJsonlMeta: () => void
  onSendProjectKnowledge: () => void
  projectKnowledgeSending: boolean
  canSendProjectKnowledge: boolean
  onContinueWithOtherModel: () => void
  canContinueWithOtherModel: boolean
  onStop: () => void
  canStop: boolean
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])
  const itemClass = "w-full px-3 py-2 text-left text-[12px] hover:bg-[var(--bg-card-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-between gap-3"
  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}
        title="更多操作"
        className="h-7 w-7 flex items-center justify-center rounded-xl border hover:bg-[var(--bg-card-hover)] transition-colors"
        style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
        <MoreHorizontal className="w-4 h-4" strokeWidth={1.75} />
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-9 z-50 min-w-[220px] rounded-xl border overflow-hidden"
          style={{
            background: 'var(--modal-bg)',
            borderColor: 'var(--border-color)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
            color: 'var(--text-primary)',
          }}>
          {/* 移动端: 顶栏终止按钮已隐藏, 终止收纳进此菜单 (md:hidden = 仅移动端显示) */}
          <button className={`${itemClass} md:hidden`} style={{ color: '#f87171' }}
            disabled={!canStop}
            onClick={() => { setOpen(false); onStop() }}>
            <span>终止当前操作</span>
          </button>
          <button className={itemClass} disabled={jsonlCount === 0}
            onClick={() => { setOpen(false); onOpenRaw() }}>
            <span>原始 JSONL 数据</span>
            {jsonlCount > 0 && <span className="text-[10px] text-[var(--text-muted)]">{jsonlCount}</span>}
          </button>
          <button className={itemClass} disabled={jsonlCount === 0}
            onClick={() => { setOpen(false); onToggleHideMinor() }}>
            <span>{hideMinor ? '显示次要条目' : '隐藏次要条目'}</span>
            {minorCount > 0 && <span className="text-[10px] text-[var(--text-muted)]">{minorCount}</span>}
          </button>
          <button className={itemClass} disabled={jsonlCount === 0}
            onClick={() => { setOpen(false); onToggleShowJsonlMeta() }}>
            <span>{showJsonlMeta ? '隐藏时间与序号' : '显示时间与序号'}</span>
          </button>
          {canSendProjectKnowledge && (
            <button className={itemClass} disabled={projectKnowledgeSending}
              onClick={() => { setOpen(false); onSendProjectKnowledge() }}>
              <span>{projectKnowledgeSending ? '发送中...' : '项目知识沉淀到记忆'}</span>
            </button>
          )}
          <button className={itemClass} disabled={!canContinueWithOtherModel}
            onClick={() => { setOpen(false); onContinueWithOtherModel() }}>
            <span>修改模型并继续</span>
          </button>
        </div>
      )}
    </div>
  )
}

// =====================================================================
// 消息气泡
// =====================================================================
export function MessageBubble({
  message: m,
  onQuote,
  onEdit,
  onBookmark,
  variant = 'default',
  assistantAvatar,
  assistantLabel = '助手',
}: {
  message: any
  onQuote?: (m: any) => void
  onEdit?: (m: any) => void
  onBookmark?: (m: any) => void
  variant?: 'default' | 'mo'
  assistantAvatar?: React.ReactNode
  assistantLabel?: string
}) {
  const [copied, setCopied] = useState(false)
  const { theme } = useStore()
  const isDark = theme !== 'light'
  const isMoVariant = variant === 'mo'
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(m.content || '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }

  if (m.role === 'system') return (
    <div className="msg-enter flex justify-center"><span className={`text-[11px] px-3 py-1 rounded-full border ${isDark ? 'text-gray-400 bg-white/[0.03] border-white/[0.05]' : 'text-gray-500 bg-black/[0.02] border-black/[0.06]'}`}>{m.content}</span></div>
  )
  // v2 兜底: 未知 SDK 事件(raw role). 不像 Claude 气泡, 折成一行紫色小标. 默认折叠.
  if (m.role === 'raw') {
    const sdkType = (() => {
      try { return JSON.parse(m.raw_event || '{}').type || 'unknown' } catch { return 'unknown' }
    })()
    return (
      <div className="msg-enter flex justify-center">
        <details className="group max-w-[78%]">
          <summary className="text-[11px] px-3 py-1 rounded-full border cursor-pointer flex items-center gap-1.5"
            style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.08)', borderColor: 'rgba(167,139,250,0.25)' }}>
            <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            🔬 SDK 事件 · {sdkType}
          </summary>
          <pre className="mt-1.5 px-3 py-2 rounded-lg text-[10px] font-mono overflow-x-auto max-h-48 leading-snug"
            style={{ background: 'var(--prose-bg)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
            {m.raw_event || m.content}
          </pre>
        </details>
      </div>
    )
  }
  if (m.role === 'thinking' && isMoVariant) {
    const thinkingContent = m.content?.slice(0, 1200) || '暂无思考内容。'
    return (
      <div className="msg-enter assistant-process-bubble-row assistant-process-bubble-row--thinking">
        <div className="assistant-process-bubble-avatar assistant-process-bubble-avatar--thinking" aria-hidden="true">
          {assistantAvatar || <Avatar role="assistant" />}
        </div>
        <details className="assistant-process-thinking-card group">
          <summary>
            <span className="assistant-process-thinking-card__dot" aria-hidden="true" />
            <span className="assistant-process-thinking-card__title">思考过程</span>
            <span className="assistant-process-thinking-card__hint">展开查看</span>
          </summary>
          <div className="assistant-process-thinking-card__body">{thinkingContent}</div>
        </details>
      </div>
    )
  }
  if (m.role === 'thinking') return (
    <div className="msg-enter ml-11">
      <details className="group">
        <summary className="text-[11px] text-indigo-400/60 cursor-pointer hover:text-indigo-400/80 flex items-center gap-1">
          <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          思考过程
        </summary>
        <div className={`border-l-2 border-indigo-500/20 rounded-r-lg px-4 py-2 mt-1 text-[12px] italic max-h-40 overflow-y-auto ${isDark ? 'bg-[#0d1117] text-gray-500' : 'bg-gray-100 text-gray-500'}`}>{m.content?.slice(0, 500)}</div>
      </details>
    </div>
  )
  if (m.role === 'tool') return (
    <div className="msg-enter ml-11 group/tool relative">
      <details className={`rounded-2xl overflow-hidden group ${isDark ? 'bg-white/[0.015] border border-white/[0.04]' : 'bg-gray-50 border border-black/[0.06]'}`}>
        <summary className={`px-3 py-1.5 cursor-pointer text-[12px] flex items-center gap-1.5 transition-colors ${isDark ? 'text-gray-500 hover:text-gray-400 hover:bg-white/[0.02]' : 'text-gray-500 hover:text-gray-600 hover:bg-black/[0.02]'}`}>
          <svg className="w-3 h-3 transition-transform group-open:rotate-90 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          <Wrench className="w-3 h-3 flex-shrink-0" strokeWidth={1.75} />
          <span className="truncate">{m.tool_summary || '工具调用'}</span>
        </summary>
        <pre className={`px-3 py-2 text-[10px] overflow-x-auto font-mono max-h-48 ${isDark ? 'text-gray-600 border-t border-white/[0.03] bg-[#0a0e14]' : 'text-gray-500 border-t border-black/[0.04] bg-gray-100'}`}>{m.content?.slice(0, 2000)}</pre>
      </details>
      <div className="absolute -right-10 top-0 opacity-0 group-hover/tool:opacity-100 transition-opacity">
        <ActionButton icon={copied
          ? <svg className="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
          : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
        } label="复制" onClick={copy} />
      </div>
    </div>
  )

  const isUser = m.role === 'user'
  const isMoAssistant = isMoVariant && !isUser
  const isBookmarked = m.bookmarked === 1
  // ChatGPT 风格: 用户用中性灰色 pill 气泡, assistant 完全无气泡 (纯文本流).
  // 气泡四角对称, 不再有指向头像的"尾巴"那一边变小的 rounded-tr-md / rounded-tl-md.
  const userBubbleClass = isDark
    ? 'bg-[#2f2f2f] text-gray-100'
    : 'bg-[#f4f4f4] text-gray-900'

  const renderContent = () => {
    const content = m.content || ''
    const quoteMatch = content.match(/^((?:> .*\n?)+)\n(.+)/s)
    if (quoteMatch && !isUser) {
      const quoted = quoteMatch[1].replace(/^> /gm, '')
      const rest = quoteMatch[2]
      return (
        <>
          <div className="border-l-2 border-[var(--text-dimmed)] pl-3 mb-2 text-[12px] italic line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{quoted}</div>
          <div className="prose-chat"><ReactMarkdown>{rest}</ReactMarkdown></div>
        </>
      )
    }
    if (isUser) {
      if (quoteMatch) {
        const quoted = quoteMatch[1].replace(/^> /gm, '')
        const rest = quoteMatch[2]
        return (
          <>
            <div className="border-l-2 pl-3 mb-2 text-[12px] italic line-clamp-2"
              style={{ borderColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)', color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)' }}>{quoted}</div>
            <p className="text-[15px] leading-[1.55] whitespace-pre-wrap">{rest}</p>
          </>
        )
      }
      return <p className="text-[15px] leading-[1.55] whitespace-pre-wrap">{content}</p>
    }
    return <div className="prose-chat"><ReactMarkdown>{content}</ReactMarkdown></div>
  }

  return (
    <div className={`msg-enter flex items-start gap-3 group/msg ${isUser ? 'flex-row-reverse' : ''}${isMoAssistant ? ' assistant-process-bubble-row assistant-process-bubble-row--assistant' : ''}`}>
      {isUser ? (
        <Avatar role={m.role} />
      ) : isMoAssistant ? (
        <div className="assistant-process-bubble-avatar assistant-process-bubble-avatar--mo" aria-hidden="true">
          {assistantAvatar || <Avatar role="assistant" />}
        </div>
      ) : (
        <div className="w-1 flex-shrink-0" />
      )}
      <div className={`relative ${isUser
        ? `max-w-[78%] rounded-2xl px-4 py-2.5 ${userBubbleClass}`
        : isMoAssistant
          ? 'assistant-process-assistant-bubble'
          : 'flex-1 min-w-0 py-1'}`}>
        {isMoAssistant && (
          <div className="assistant-process-assistant-bubble__meta">
            <span>{assistantLabel}</span>
            <small>回复</small>
          </div>
        )}
        {isBookmarked && (
          <div className={`absolute -top-1.5 ${isUser ? '-right-1.5' : '-left-1.5'}`}>
            <Bookmark className="w-3 h-3 fill-amber-400 text-amber-400" strokeWidth={1.5} />
          </div>
        )}
        {renderContent()}
      </div>
      <div className={`flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity self-start mt-1 rounded-xl px-1 py-0.5 ${isDark ? 'bg-[#1a1f2e] border border-white/[0.08]' : 'bg-white border border-black/10'}`}
        style={{ boxShadow: isDark ? '0 4px 16px rgba(0,0,0,0.4)' : '0 4px 16px rgba(0,0,0,0.08)' }}>
        {isUser && onEdit && (
          <ActionButton label="编辑" onClick={(e) => { e.stopPropagation(); onEdit(m) }}
            icon={<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>} />
        )}
        {!isUser && onQuote && (
          <ActionButton label="引用" onClick={(e) => { e.stopPropagation(); onQuote(m) }}
            icon={<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>} />
        )}
        <ActionButton label={copied ? '已复制' : '复制'} onClick={copy}
          icon={copied
            ? <svg className="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
          } />
        {onBookmark && (
          <ActionButton label={isBookmarked ? '取消书签' : '书签'} active={isBookmarked}
            onClick={(e) => { e.stopPropagation(); onBookmark(m) }}
            icon={<svg className="w-3.5 h-3.5" fill={isBookmarked ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>} />
        )}
      </div>
    </div>
  )
}

// =====================================================================
// Session 列表行
// =====================================================================
export function isSessionNameMuted(_agentStatus?: string | null) {
  return false
}

function runtimeStatusForSessionList(r: any) {
  if (r?.failed === true) return 'failed'
  if (r?.alive && r?.working) return 'running'
  if (r?.alive) return 'waiting'
  if (r?.job_accomplished === true) return 'completed'
  return 'idle'
}

export function SessionRow({ session, isSelected, onSelect, onEdit, onDelete, pinnedIds, onTogglePinned }: {
  session: any; isSelected: boolean; onSelect: (s: any) => void;
  onEdit?: (s: any) => void; onDelete?: (s: any) => void;
  pinnedIds?: Set<string>; onTogglePinned?: (s: any) => void
}) {
  const { theme } = useStore()
  const textPrimary = theme !== 'light' ? '#f1f5f9' : '#1e293b'
  const textMuted = theme !== 'light' ? '#6b7280' : '#94a3b8'
  const modelLabel = sessionModelLabel(session.model, session.model_label)
  const proxyLabel = sessionProxyLabel(session.use_proxy, session.model)
  const nameMuted = isSessionNameMuted(session.agent_status)

  return (
    <div onClick={() => onSelect(session)}
      className={`group flex h-[54px] items-center gap-1.5 overflow-hidden px-2 py-1.5 rounded-lg cursor-pointer mb-0.5 transition-colors ${
        isSelected ? 'bg-blue-500/10 border border-blue-500/20' : 'hover:bg-[var(--bg-card-hover)] border border-transparent'
      } ${nameMuted ? 'opacity-75' : ''}`}>
      <div className="flex-shrink-0">
        <AgentStatusDot agentStatus={session.agent_status} />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="text-[11px] font-medium leading-[13px] line-clamp-2 break-all" style={{ color: nameMuted ? textMuted : textPrimary }}>{session.name}</div>
        <div className="text-[10px] leading-[12px] mt-0.5 truncate" style={{ color: textMuted }}>{session.message_count} 消息 · {timeAgo(session.last_active)}</div>
      </div>
      <div className="relative h-6 w-[88px] flex-shrink-0 overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-end gap-1 overflow-hidden opacity-100 transition-opacity group-hover:opacity-0">
          {modelLabel && (
            <span className="min-w-0 max-w-[82px] truncate rounded px-1.5 py-[1px] text-[9px] leading-4 border"
              title={`模型: ${modelLabel}`}
              style={{
                color: theme !== 'light' ? '#93c5fd' : '#1d4ed8',
                background: theme !== 'light' ? 'rgba(59,130,246,0.10)' : 'rgba(59,130,246,0.07)',
                borderColor: theme !== 'light' ? 'rgba(147,197,253,0.22)' : 'rgba(37,99,235,0.16)',
              }}>
              {modelLabel}
            </span>
          )}
          {session.research_role && (
            <span className="flex-shrink-0 rounded px-1.5 py-[1px] text-[9px] leading-4 border"
              title={`Research Role: ${session.research_role}`}
              style={{
                color: session.research_role === 'chief_researcher' ? '#34d399' : '#a78bfa',
                background: session.research_role === 'chief_researcher' ? 'rgba(52,211,153,0.10)' : 'rgba(167,139,250,0.10)',
                borderColor: session.research_role === 'chief_researcher' ? 'rgba(52,211,153,0.24)' : 'rgba(167,139,250,0.24)',
              }}>
              {session.research_role === 'chief_researcher' ? 'chief' : 'assistant'}
            </span>
          )}
        </div>
        <div className="absolute inset-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100">
          {onEdit && <button onClick={e => { e.stopPropagation(); onEdit(session) }} className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-white/10" title="重命名">
            <svg className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
          </button>}
          {onDelete && <button onClick={e => { e.stopPropagation(); onDelete(session) }} className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-white/10" title="删除">
            <svg className="w-3 h-3 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>}
          {pinnedIds && onTogglePinned && <button onClick={e => { e.stopPropagation(); onTogglePinned(session) }} className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-white/10" title={pinnedIds.has(session.session_id) ? '取消置顶' : '置顶'}>
            <svg className="w-3 h-3" style={{ color: pinnedIds.has(session.session_id) ? '#f59e0b' : textMuted }} fill={pinnedIds.has(session.session_id) ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
          </button>}
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// 主对话区（基于 currentSession）
// =====================================================================
export function ChatArea() {
  const { currentSession, currentTask, currentIssue, currentProject, projects, setProjects, sessionsMap, setSessionsMap, setCurrentSession, setCurrentTask, messages, setMessages, addMessage, isTyping, setTyping, streamContent, setStreamContent, theme } = useStore()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [inputExpanded, setInputExpanded] = useState(false)
  const [inputMenuOpen, setInputMenuOpen] = useState(false)
  const [inputFocused, setInputFocused] = useState(false)
  // 每个 session 维持一份附件列表 (粘贴 / 拖放 / 上传按钮三路共用).
  // 切 session 时不清空, 让用户在哪儿留下就在哪儿见.
  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, Attachment[]>>({})
  const [attachmentImagePreview, setAttachmentImagePreview] = useState<AttachmentImagePreview | null>(null)
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const inputMenuRef = useRef<HTMLDivElement | null>(null)
  const inputMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 当组件卸载时回收所有 image preview ObjectURL, 防止内存泄漏.
  useEffect(() => {
    return () => {
      Object.values(attachmentsBySession).forEach(list => {
        list.forEach(a => { if (a.previewUrl) { try { URL.revokeObjectURL(a.previewUrl) } catch {} } })
      })
      if (voiceStopTimerRef.current !== null) window.clearTimeout(voiceStopTimerRef.current)
      if (voiceTickTimerRef.current !== null) window.clearInterval(voiceTickTimerRef.current)
      const recorder = mediaRecorderRef.current
      try {
        if (recorder && recorder.state !== 'inactive') recorder.stop()
      } catch {}
      const stream = mediaStreamRef.current
      if (stream) {
        stream.getTracks().forEach(track => {
          try { track.stop() } catch {}
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // JSONL 视图: 直接展示当前 backend 的原始 entries (Claude 或 Codex).
  // jsonl_history 覆盖, jsonl_entry 追加. 切 session 时 clear.
  const [jsonlEntries, setJsonlEntries] = useState<any[]>([])
  // count-then-tail: 后端先发 jsonl_meta {total}, 再回灌末尾 200 条. 这里存服务端 total,
  // 用作 "加载全部" 按钮的判断和标题显示, 不依赖 entries.length.
  const [jsonlTotal, setJsonlTotal] = useState<number>(0)
  // 后端在 jsonl_meta 里附带的真实 jsonl 文件绝对路径, 用于原始数据弹窗标题展示.
  const [jsonlPath, setJsonlPath] = useState<string | null>(null)
  const [jsonlLoadingMore, setJsonlLoadingMore] = useState<boolean>(false)
  const pendingJsonlEntriesRef = useRef<any[]>([])
  const pendingJsonlTotalIncrementRef = useRef(0)
  const pendingJsonlFlushTimerRef = useRef<number | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [inputReplayOpen, setInputReplayOpen] = useState(false)
  const [fileChangesOpen, setFileChangesOpen] = useState(false)
  const [bashCommandsOpen, setBashCommandsOpen] = useState(false)
  const [compactConfirmOpen, setCompactConfirmOpen] = useState(false)
  const [continueModalOpen, setContinueModalOpen] = useState(false)
  const [projectKnowledgeSending, setProjectKnowledgeSending] = useState(false)
  const [messageSubmitting, setMessageSubmitting] = useState(false)
  const [voiceState, setVoiceState] = useState<VoiceInputState>('idle')
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [stopFeedbackActive, setStopFeedbackActive] = useState(false)
  const stopFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceRecordFailedRef = useRef(false)
  const voiceStopTimerRef = useRef<number | null>(null)
  const voiceTickTimerRef = useRef<number | null>(null)
  // 默认隐藏次要条目 (last-prompt / title / agent-name / permission / 连续重复 entry / 连续等摘要 entry)
  const [hideMinorJsonl, setHideMinorJsonl] = useState(true)
  // 默认隐藏 jsonl 卡片标题里的"序号 + 时间"前缀; 开启后才显示 #序号 和 MM-DD HH:MM:SS.
  const [showJsonlMeta, setShowJsonlMeta] = useState(false)
  const sessionId = currentSession?.session_id || currentTask?.task_id || ''
  const currentProjectId = (currentIssue as any)?.project_id || (currentSession as any)?.project_id || (currentTask as any)?.project_id || ''
  const currentIssueId = (currentSession as any)?.issue_id || (currentIssue as any)?.id || ''
  // 规划模式: 当前 Issue 是 is_planning 时, 隐藏执行控件 + 嵌入规划编辑器.
  const isPlanningSession = !!(currentIssue as any)?.is_planning
  const projectForSession = currentProject?.id === currentProjectId
    ? currentProject
    : projects.find((p: any) => p.id === currentProjectId)
  const currentModelLabel = sessionModelLabel(
    (currentSession as any)?.model || (currentTask as any)?.model,
    (currentSession as any)?.model_label || (currentTask as any)?.model_label,
  )
  const currentProxyLabel = sessionProxyLabel((currentSession as any)?.use_proxy ?? (currentTask as any)?.use_proxy, (currentSession as any)?.model ?? (currentTask as any)?.model)
  const voiceBusy = voiceState === 'recording' || voiceState === 'transcribing'
  const voiceTip = voiceState === 'recording'
    ? `停止录音并发送 ${formatVoiceSeconds(recordingSeconds)}`
    : voiceState === 'transcribing'
      ? '正在转写并发送语音'
      : '语音输入'

  // 次要条目过滤: 隐藏时剔除不在 MAJOR_JSONL_TYPES 中的类型、连续重复 entry、
  // 连续等摘要 entry、以及重复前序 user.message.content 的 event_msg, 源数据 jsonlEntries 不动.
  const { visibleJsonl, minorCount } = useMemo(() => {
    const hiddenIndexes = new Set<number>()
    const visible: any[] = []
    let hiddenCount = 0

    let runStart = 0
    let previousEntrySignature: string | null = null
    let previousSummaryKey = ''

    const closeRun = (endExclusive: number) => {
      if (endExclusive - runStart <= 1) return
      for (let i = runStart; i < endExclusive - 1; i++) hiddenIndexes.add(i)
    }

    for (let i = 0; i < jsonlEntries.length; i++) {
      const entry = jsonlEntries[i]
      const signature = jsonlDuplicateSignature(entry)
      const summaryKey = jsonlEntrySummaryKey(entry)
      const sameAsPrevious = i > 0 && (
        signature === previousEntrySignature
        || (!!summaryKey && summaryKey === previousSummaryKey)
      )

      if (!sameAsPrevious) {
        closeRun(i)
        runStart = i
      }

      previousEntrySignature = signature
      previousSummaryKey = summaryKey
    }
    closeRun(jsonlEntries.length)

    // 先收集所有 "纯 user 卡" (没有 mobius 元数据字段) 的 content.
    // 当一条 user 卡同时存在带 mobius 和不带 mobius 两个版本时, 隐藏带 mobius 的那个.
    const plainUserContents = new Set<string>()
    for (const entry of jsonlEntries) {
      if (entry?.type !== 'user') continue
      const content = userMessageContentForEventMirror(entry)
      if (content === null) continue
      if (!entryHasMobiusField(entry)) plainUserContents.add(content)
    }

    const previousUserMessages = new Set<string>()
    for (let i = 0; i < jsonlEntries.length; i++) {
      const entry = jsonlEntries[i]
      const mirroredUserMessage = eventMsgMirrorsPreviousUser(entry, previousUserMessages)
      const duplicateMobiusCard =
        entry?.type === 'user' &&
        entryHasMobiusField(entry) &&
        plainUserContents.has(userMessageContentForEventMirror(entry) ?? '')
      const isMinor =
        !MAJOR_JSONL_TYPES.has(entry?.type) || hiddenIndexes.has(i) || mirroredUserMessage || duplicateMobiusCard

      if (isMinor) hiddenCount += 1
      if (!hideMinorJsonl || !isMinor) visible.push(entry)

      const userMessage = userMessageContentForEventMirror(entry)
      if (userMessage !== null) previousUserMessages.add(userMessage)
    }

    return { visibleJsonl: visible, minorCount: hiddenCount }
  }, [jsonlEntries, hideMinorJsonl])

  // 状态唯一真相源: 后端 GET /api/sessions/:id/status.
  //   alive   = hub.isAlive       — 进程存活 (TUI 可接收输入)
  //   working = hub.isWorking     — 智能体正在执行 (生成回复 / 跑工具调用 / 等首条输出)
  // 不再从 jsonl 前端派生, 不再读 sessions_v2.agent_status, 不再相信 stream 推的 typing.
  // 2s 轮询. 乐观 pending: send 出去到下次轮询前显示 "执行中 (待确认)".
  type AgentStatus = 'pending' | 'running' | 'waiting' | 'idle'
  const [backendAlive, setBackendAlive] = useState<boolean | null>(null)
  const [backendWorking, setBackendWorking] = useState<boolean | null>(null)
  // job_accomplished: running.flag 已被 agent 删 → true (任务已结束); flag 还在 → false (未完成).
  const [backendJobDone, setBackendJobDone] = useState<boolean | null>(null)
  // failed: failed.flag 存在 → true (任务失败). 与 job_accomplished 正交.
  const [backendJobFailed, setBackendJobFailed] = useState<boolean | null>(null)
  // 失败原因: 取自 failed.flag 的 reason 行 (经 /status 轮询返回). 持久, 刷新/切换会话后仍在.
  const [backendFailedReason, setBackendFailedReason] = useState('')
  const [backendFailedAt, setBackendFailedAt] = useState('')
  const [backendPid, setBackendPid] = useState<number | null>(null)
  const [pendingSendAt, setPendingSendAt] = useState<number | null>(null)
  const [backendWorktreeIgnored, setBackendWorktreeIgnored] = useState(false)
  const [lastSendError, setLastSendError] = useState('')
  const [dismissedBackendFailureKeys, setDismissedBackendFailureKeys] = useState<Record<string, string>>({})
  const [hiddenBackendFailureBefore, setHiddenBackendFailureBefore] = useState<Record<string, number>>({})
  const guidedCompletionNotifiedRef = useRef<Set<string>>(new Set())
  const backendFailureMessage = useMemo(() => formatBackendFailureMessage(backendFailedReason), [backendFailedReason])
  const backendFailureKey = backendJobFailed === true
    ? (backendFailedAt || backendFailedReason || backendFailureMessage || 'failed')
    : ''
  const backendFailureAtMs = backendFailedAt ? Date.parse(backendFailedAt) : NaN
  const backendFailureRef = useRef({ sessionId: '', key: '', failedAt: '' })

  useEffect(() => {
    backendFailureRef.current = { sessionId, key: backendFailureKey, failedAt: backendFailedAt }
  }, [sessionId, backendFailureKey, backendFailedAt])

  const hideBackendFailure = useCallback((targetSessionId?: string) => {
    const sid = targetSessionId || backendFailureRef.current.sessionId
    if (!sid) return
    const key = sid === backendFailureRef.current.sessionId ? backendFailureRef.current.key : ''
    const now = Date.now()
    if (key) {
      setDismissedBackendFailureKeys(prev => (
        prev[sid] === key ? prev : { ...prev, [sid]: key }
      ))
    }
    setHiddenBackendFailureBefore(prev => (
      prev[sid] && prev[sid] >= now ? prev : { ...prev, [sid]: now }
    ))
  }, [])

  useEffect(() => {
    if (!sessionId || backendJobFailed !== false) return
    setDismissedBackendFailureKeys(prev => {
      if (!prev[sessionId]) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    setHiddenBackendFailureBefore(prev => {
      if (!prev[sessionId]) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }, [sessionId, backendJobFailed])

  useEffect(() => {
    if (!sessionId) { setBackendAlive(null); setBackendWorking(null); setBackendJobDone(null); setBackendJobFailed(null); setBackendFailedReason(''); setBackendFailedAt(''); setBackendPid(null); setBackendWorktreeIgnored(false); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const scheduleNext = (delayMs: number) => {
      if (cancelled) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(poll, delayMs)
    }
    const nextDelayFor = (r: any) => {
      if (pendingSendAt) return 2000
      if (r?.alive && r?.working) return 2000
      if (r?.alive) return 5000
      return 15000
    }
    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      let nextDelay = 5000
      try {
        const r = await api(`/api/sessions/${sessionId}/status`)
        if (cancelled) return
        setBackendAlive(!!r?.alive)
        setBackendWorking(!!r?.working)
        setBackendJobDone(typeof r?.job_accomplished === 'boolean' ? r.job_accomplished : null)
        setBackendJobFailed(typeof r?.failed === 'boolean' ? r.failed : null)
        setBackendFailedReason(typeof r?.failed_reason === 'string' ? r.failed_reason : '')
        setBackendFailedAt(typeof r?.failed_at === 'string' ? r.failed_at : '')
        setBackendWorktreeIgnored(!!r?.worktree_ignored)
        setBackendPid(r?.pid ?? null)
        const liveAgentStatus = runtimeStatusForSessionList(r)
        const store = useStore.getState()
        const selectedSession = store.currentSession
        if (selectedSession?.session_id === sessionId && selectedSession.agent_status !== liveAgentStatus) {
          store.setCurrentSession({ ...selectedSession, agent_status: liveAgentStatus })
        }
        const selectedTask = store.currentTask as any
        if (selectedTask?.task_id === sessionId && selectedTask.agent_status !== liveAgentStatus) {
          store.setCurrentTask({ ...selectedTask, agent_status: liveAgentStatus })
        }
        const listKey = (selectedSession as any)?.issue_id || (selectedSession as any)?.research_id || currentIssueId
        if (listKey) {
          const list = store.sessionsMap[listKey] || []
          if (list.some((s: any) => s.session_id === sessionId && s.agent_status !== liveAgentStatus)) {
            store.setSessionsMap(listKey, list.map((s: any) => (
              s.session_id === sessionId ? { ...s, agent_status: liveAgentStatus } : s
            )))
          }
        }
        if (r?.job_accomplished === true && isGuidedDemoSession(sessionId) && !guidedCompletionNotifiedRef.current.has(sessionId)) {
          guidedCompletionNotifiedRef.current.add(sessionId)
          patchGuidedDemoSessionCompleted(sessionId)
          window.dispatchEvent(new CustomEvent(GUIDED_DEMO_TOUR_EVENT, { detail: { force: false } }))
        }
        // pending 清除条件 (任意一个满足):
        //   ① 后端确认 working=true   (agent 已开始干)
        //   ② 后端确认 alive=false    (进程死了, 早就不用等了)
        //   ③ pending 已超 8s         (agent 在 sub-2s 内跑完一整轮, 我们 poll 没赶上 — 兜底)
        if (pendingSendAt && (r?.working || !r?.alive || (Date.now() - pendingSendAt > 8000))) {
          setPendingSendAt(null)
        }
        nextDelay = nextDelayFor(r)
      } catch { /* 网络抖动忽略, 下次再来 */ }
      if (!cancelled) scheduleNext(nextDelay)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        if (timer) clearTimeout(timer)
        timer = null
        return
      }
      poll()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [sessionId, pendingSendAt])

  useEffect(() => {
    setStopFeedbackActive(false)
    if (stopFeedbackTimerRef.current) {
      clearTimeout(stopFeedbackTimerRef.current)
      stopFeedbackTimerRef.current = null
    }
    return () => {
      if (stopFeedbackTimerRef.current) {
        clearTimeout(stopFeedbackTimerRef.current)
        stopFeedbackTimerRef.current = null
      }
    }
  }, [sessionId])

  const derivedStatus: AgentStatus =
    pendingSendAt ? 'pending'
    : (backendAlive && backendWorking) ? 'running'
    : backendAlive ? 'waiting'
    : 'idle'
  const currentVscodeSubPath = (currentIssue as any)?.use_worktree && !backendWorktreeIgnored
    ? ((currentIssue as any)?.worktree_branch || (currentIssue as any)?.id)
    : null
  const jsonlEmptyLoadingText = jsonlEntries.length === 0 && derivedStatus === 'pending'
    ? (backendAlive ? '智能体进程已创建，联络中' : '正在创建智能体进程，请稍等')
    : ''
  const hiddenBackendFailureAt = sessionId ? hiddenBackendFailureBefore[sessionId] : 0
  const backendFailureHiddenByKey = !!(sessionId && backendFailureKey && dismissedBackendFailureKeys[sessionId] === backendFailureKey)
  const backendFailureHiddenByTime = !!(
    hiddenBackendFailureAt
    && (!Number.isFinite(backendFailureAtMs) || backendFailureAtMs <= hiddenBackendFailureAt)
  )
  const showBackendFailureBanner = !lastSendError
    && backendJobFailed === true
    && !!backendFailureMessage
    && !backendFailureHiddenByKey
    && !backendFailureHiddenByTime

  useEffect(() => {
    if (!sessionId) return
    setDrafts(prev => {
      if (Object.prototype.hasOwnProperty.call(prev, sessionId)) return prev
      const saved = draftLoad<{ input?: string }>(`session-input:${sessionId}`)
      if (!saved?.input) return prev
      return { ...prev, [sessionId]: saved.input }
    })
  }, [sessionId])

  const input = drafts[sessionId] || ''
  const setInput = (val: string | ((prev: string) => string)) => {
    if (!sessionId) return
    setDrafts(prev => {
      const next = typeof val === 'function' ? val(prev[sessionId] || '') : val
      draftSave(`session-input:${sessionId}`, { input: next }, { minChars: 1 })
      return {
        ...prev,
        [sessionId]: next,
      }
    })
  }

  useEffect(() => {
    if (!sessionId) return
    draftSave(`session-input:${sessionId}`, { input }, { minChars: 1 })
  }, [sessionId, input])

  // F6: 规划编辑器 3s 静止后, 预填一条"通知 Agent 已更新规划"的草稿, 避免用户来回切换.
  // 仅在事件 detail.sessionId === 当前 session 时生效, 防止跨 session 串扰.
  useEffect(() => {
    function onPrefill(e: Event) {
      const detail = (e as CustomEvent).detail || {}
      if (detail.sessionId !== sessionId) return
      const cur = drafts[sessionId] || ''
      const draft = '我刚更新了 project_knowledge.md 中的规划，请读取后据此调整你的工作计划。'
      if (cur.trim()) return
      setInput(draft)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        try { inputRef.current?.setSelectionRange(draft.length, draft.length) } catch {}
      })
    }
    window.addEventListener('mobius:planning-prefill', onPrefill as EventListener)
    return () => window.removeEventListener('mobius:planning-prefill', onPrefill as EventListener)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, drafts])

  // F7: "通知 Agent" 按钮同样预填草稿 (跳过 3s 静止等待, 立即触发).
  useEffect(() => {
    function onNotify(e: Event) {
      const detail = (e as CustomEvent).detail || {}
      if (detail.sessionId !== sessionId) return
      const draft = '请读取当前 project_knowledge.md，确认最新规划后开始执行。'
      setInput(draft)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        try { inputRef.current?.setSelectionRange(draft.length, draft.length) } catch {}
      })
    }
    window.addEventListener('mobius:planning-notify-agent', onNotify as EventListener)
    return () => window.removeEventListener('mobius:planning-notify-agent', onNotify as EventListener)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const clearSessionInputDraft = useCallback((sid: string, expectedInput?: string) => {
    if (!sid) return
    setDrafts(prev => {
      if (!Object.prototype.hasOwnProperty.call(prev, sid)) return prev
      if (typeof expectedInput === 'string' && (prev[sid] || '') !== expectedInput) return prev
      const next = { ...prev }
      delete next[sid]
      return next
    })
    const saved = draftLoad<{ input?: string }>(`session-input:${sid}`)
    if (typeof expectedInput !== 'string' || !saved?.input || saved.input === expectedInput) {
      draftClear(`session-input:${sid}`)
    }
  }, [])

  const applyReplayedInput = useCallback((text: string) => {
    setInput(text)
    setInputReplayOpen(false)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      try { inputRef.current?.setSelectionRange(text.length, text.length) } catch {}
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const attachments = attachmentsBySession[sessionId] || []
  const closeAttachmentImagePreview = useCallback(() => setAttachmentImagePreview(null), [])
  const openAttachmentImagePreview = useCallback((preview: AttachmentImagePreview) => {
    setAttachmentImagePreview(preview)
  }, [])
  useEffect(() => {
    if (!attachmentImagePreview) return
    const stillAvailable = attachments.some(a => a.id === attachmentImagePreview.id && a.previewUrl === attachmentImagePreview.src)
    if (!stillAvailable) setAttachmentImagePreview(null)
  }, [attachmentImagePreview, attachments])

  const setSessionAttachments = (
    sid: string,
    updater: Attachment[] | ((prev: Attachment[]) => Attachment[])
  ) => {
    setAttachmentsBySession(prev => {
      const cur = prev[sid] || []
      const next = typeof updater === 'function' ? (updater as any)(cur) : updater
      return { ...prev, [sid]: next }
    })
  }

  // 将一批 File 加入当前 session 的附件列表, 并触发上传.
  // 不去重 (同名文件可能内容不同, 让后端用 originalname 落盘即可).
  const enqueueFiles = useCallback((files: FileList | File[]) => {
    if (!sessionId) return
    const arr = Array.from(files || [])
    if (arr.length === 0) return
    const newAtts: Attachment[] = arr.map(f => ({
      id: makeAttachmentId(),
      name: f.name || 'file',
      size: f.size || 0,
      kind: attachmentKindOf(f),
      previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
      status: 'uploading',
    }))
    setSessionAttachments(sessionId, prev => [...prev, ...newAtts])
    newAtts.forEach((att, i) => {
      uploadAttachmentFile(arr[i], currentProjectId)
        .then(res => {
          setSessionAttachments(sessionId, prev => prev.map(a =>
            a.id === att.id ? { ...a, status: 'done', remotePath: res.path, size: res.size || a.size } : a
          ))
        })
        .catch(err => {
          setSessionAttachments(sessionId, prev => prev.map(a =>
            a.id === att.id ? { ...a, status: 'error', error: err?.message || '上传失败' } : a
          ))
        })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const removeAttachment = useCallback((id: string) => {
    if (!sessionId) return
    setAttachmentImagePreview(prev => prev?.id === id ? null : prev)
    setSessionAttachments(sessionId, prev => {
      const target = prev.find(a => a.id === id)
      if (target?.previewUrl) { try { URL.revokeObjectURL(target.previewUrl) } catch {} }
      return prev.filter(a => a.id !== id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const clearAttachments = useCallback(() => {
    if (!sessionId) return
    setAttachmentImagePreview(null)
    setSessionAttachments(sessionId, prev => {
      prev.forEach(a => { if (a.previewUrl) { try { URL.revokeObjectURL(a.previewUrl) } catch {} } })
      return []
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 容器级粘贴, 兼容 ChatGPT: 剪贴板里有文件就吃掉默认行为, 转成附件;
  // 否则让浏览器把文字正常粘进 textarea. 同时认 items + files 两条路,
  // 避免某些浏览器 (Chrome/Edge on macOS) 只把图片塞进 files 不进 items.
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLElement>) => {
    const cd = e.clipboardData
    if (!cd) return
    const files: File[] = []
    if (cd.files && cd.files.length > 0) {
      for (let i = 0; i < cd.files.length; i++) files.push(cd.files[i])
    } else if (cd.items && cd.items.length > 0) {
      for (let i = 0; i < cd.items.length; i++) {
        const it = cd.items[i]
        if (it.kind === 'file') {
          const f = it.getAsFile()
          if (f) files.push(f)
        }
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      enqueueFiles(files)
    }
  }, [enqueueFiles])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault()
      setIsDraggingFile(true)
    }
  }, [])
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) setIsDraggingFile(false)
  }, [])
  const handleDrop = useCallback((e: React.DragEvent) => {
    setIsDraggingFile(false)
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    e.preventDefault()
    enqueueFiles(files)
  }, [enqueueFiles])

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])
  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) enqueueFiles(files)
    // 同名文件再选一次也要触发 change
    e.target.value = ''
  }, [enqueueFiles])

  const anyUploading = attachments.some(a => a.status === 'uploading')
  const eventSourceRef = useRef<EventSource | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected')
  const endRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const [hasNewMessages, setHasNewMessages] = useState(false)
  const [replyTo, setReplyTo] = useState<any>(null)
  const [editingMsg, setEditingMsg] = useState<any>(null)
  const [runProjectPrompt, setRunProjectPrompt] = useState('')
  const [nextQuestionLoading, setNextQuestionLoading] = useState(false)
  const [nextQuestionCandidates, setNextQuestionCandidates] = useState<string[]>([])
  const [nextQuestionModalOpen, setNextQuestionModalOpen] = useState(false)
  const isNewConversation = messages.length === 0 && (((currentSession as any)?.message_count || 0) === 0)
  const inputPlaceholder = editingMsg
    ? '编辑消息后按 Enter 重新发送...'
    : isNewConversation
      ? '今天有什么计划？'
      : '发送指令...'
  const loadHistoryRef = useRef<() => void>(() => {})
  const postSessionMessage = useCallback(async ({
    content,
    inputText,
    requestId,
  }: {
    content: string
    inputText?: string
    requestId: string
  }) => {
    if (!sessionId) throw new Error('当前没有可发送消息的 Session')
    const payload: Record<string, any> = { content, request_id: requestId }
    if (typeof inputText === 'string') payload.input_text = inputText
    try {
      const resp = await api(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setLastSendError('')
      hideBackendFailure(sessionId)
      return resp
    } catch (e: any) {
      const text = e?.message || '发送失败'
      setTyping(false)
      setStreamContent('')
      setPendingSendAt(null)
      setLastSendError(text)
      addMessage({ role: 'system', content: `❌ ${text}` })
      setTimeout(() => loadHistoryRef.current(), 500)
      throw e
    }
  }, [sessionId, setTyping, setStreamContent, addMessage, hideBackendFailure])

  const clearVoiceTimers = useCallback(() => {
    if (voiceStopTimerRef.current !== null) {
      window.clearTimeout(voiceStopTimerRef.current)
      voiceStopTimerRef.current = null
    }
    if (voiceTickTimerRef.current !== null) {
      window.clearInterval(voiceTickTimerRef.current)
      voiceTickTimerRef.current = null
    }
  }, [])

  const stopVoiceStream = useCallback(() => {
    const stream = mediaStreamRef.current
    mediaStreamRef.current = null
    if (!stream) return
    stream.getTracks().forEach(track => {
      try { track.stop() } catch {}
    })
  }, [])

  const submitVoiceBlob = useCallback(async (blob: Blob) => {
    if (!blob || blob.size === 0) {
      setVoiceState('error')
      setLastSendError('录音内容为空，请重新录制一段清晰语音。')
      return
    }
    if (!sessionId || messageSubmitting) return

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 125_000)
    const mimeType = blob.type || 'audio/webm'
    const form = new FormData()
    form.append('audio', blob, `session-voice-${Date.now()}.${recordingFileExtension(mimeType)}`)

    setVoiceState('transcribing')
    setLastSendError('')
    try {
      const result = await api('/api/assistant/transcribe', {
        method: 'POST',
        body: form,
        signal: controller.signal,
      }) as VoiceTranscribeResponse
      const text = String(result.text || '').trim()
      if (!text) {
        setVoiceState('error')
        setLastSendError('没有识别到有效语音，请靠近麦克风并重新录制。')
        return
      }
      const requestId = makeSendRequestId()
      setVoiceState('idle')
      setLastSendError('')
      addMessage({ role: 'user', content: text })
      setPendingSendAt(Date.now())
      setMessageSubmitting(true)
      setTyping(true)
      await postSessionMessage({ content: text, inputText: text, requestId })
      clearSessionInputDraft(sessionId, text)
      inputRef.current?.focus()
      setTimeout(() => loadHistoryRef.current(), 500)
    } catch (error: any) {
      setVoiceState('error')
      setTyping(false)
      setStreamContent('')
      setPendingSendAt(null)
      setLastSendError(error?.name === 'AbortError'
        ? '语音转写网络超时，请稍后重试。'
        : (error?.message || '语音转写失败，请稍后重试。'))
    } finally {
      window.clearTimeout(timeout)
      setMessageSubmitting(false)
    }
  }, [addMessage, clearSessionInputDraft, messageSubmitting, postSessionMessage, sessionId, setStreamContent, setTyping])

  const stopVoiceRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    try { recorder.requestData() } catch {}
    try { recorder.stop() } catch {}
  }, [])

  const startVoiceRecording = useCallback(async () => {
    if (messageSubmitting || voiceState === 'transcribing') return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceState('error')
      setLastSendError('当前浏览器不支持录音，请换用支持 MediaRecorder 的浏览器。')
      return
    }

    setLastSendError('')
    setRecordingSeconds(0)
    voiceChunksRef.current = []
    voiceRecordFailedRef.current = false

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      const mimeType = supportedVoiceMimeType()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      mediaStreamRef.current = stream
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) voiceChunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        voiceRecordFailedRef.current = true
        clearVoiceTimers()
        stopVoiceStream()
        setVoiceState('error')
        setLastSendError('浏览器录音失败，请重新录制。')
        try {
          if (recorder.state !== 'inactive') recorder.stop()
        } catch {}
      }
      recorder.onstop = () => {
        clearVoiceTimers()
        stopVoiceStream()
        mediaRecorderRef.current = null
        if (voiceRecordFailedRef.current) return
        const type = recorder.mimeType || mimeType || 'audio/webm'
        const blob = new Blob(voiceChunksRef.current, { type })
        voiceChunksRef.current = []
        void submitVoiceBlob(blob)
      }

      recorder.start(250)
      setVoiceState('recording')
      voiceTickTimerRef.current = window.setInterval(() => {
        setRecordingSeconds(value => value + 1)
      }, 1000)
      voiceStopTimerRef.current = window.setTimeout(() => {
        stopVoiceRecording()
      }, VOICE_RECORDING_MAX_MS)
    } catch (error: any) {
      clearVoiceTimers()
      stopVoiceStream()
      mediaRecorderRef.current = null
      setVoiceState('error')
      setLastSendError(permissionErrorMessage(error, 'Session 输入'))
    }
  }, [clearVoiceTimers, messageSubmitting, stopVoiceRecording, stopVoiceStream, submitVoiceBlob, voiceState])

  const toggleVoiceRecording = useCallback(() => {
    if (voiceState === 'recording') {
      stopVoiceRecording()
      return
    }
    void startVoiceRecording()
  }, [startVoiceRecording, stopVoiceRecording, voiceState])

  // 每个 turn 的折叠状态. undefined/true = 展开(默认全展开), false = 折叠.
  // 折叠时只显示该 turn 最后一条 assistant; 展开时显示该 turn 全部 non-user segment.
  const [turnExpanded, setTurnExpanded] = useState<Record<number, boolean>>({})
  const toggleTurn = useCallback((tn: number) => {
    setTurnExpanded(prev => {
      const currentExpanded = prev[tn] !== false
      return { ...prev, [tn]: !currentExpanded }
    })
  }, [])
  // 权限请求卡片: 用户点过按钮后乐观 dismiss(等服务端 turn 继续就会被自然过滤掉)
  const [dismissedPermId, setDismissedPermId] = useState<number | null>(null)
  // 计算当前待响应的 permission(最后一条 system+buttons, 其后无 assistant/tool, 且未被本地 dismiss).
  // 返回索引(用于主流过滤) + 消息对象(用于底部卡片).
  const { idx: pendingPermIdx, msg: pendingPermissionMsg } = useMemo(() => {
    let idx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const m: any = messages[i]
      if (m.role === 'system' && Array.isArray(m.buttons) && m.buttons.length > 0) {
        idx = i
        break
      }
    }
    if (idx < 0) return { idx: -1, msg: null }
    for (let i = idx + 1; i < messages.length; i++) {
      if (messages[i].role === 'assistant' || messages[i].role === 'tool') {
        return { idx: -1, msg: null }
      }
    }
    const m: any = messages[idx]
    if (m.id && m.id === dismissedPermId) return { idx: -1, msg: null }
    return { idx, msg: m }
  }, [messages, dismissedPermId])
  // 用户点权限按钮: 乐观 dismiss 当前卡片, 同时按普通消息发送选择.
  const handlePermissionClick = useCallback((value: string) => {
    if (pendingPermissionMsg?.id) setDismissedPermId(pendingPermissionMsg.id)
    const content = permissionReplyText(value)
    if (!content || !sessionId) return
    const requestId = makeSendRequestId()
    setLastSendError('')
    addMessage({ role: 'user', content })
    setPendingSendAt(Date.now())
    setTyping(true)
    postSessionMessage({ content, inputText: content, requestId }).catch(() => {})
  }, [pendingPermissionMsg, sessionId, addMessage, setTyping, postSessionMessage])
  const [inputHeight, setInputHeight] = useState(60)
  const toggleInputExpanded = useCallback(() => {
    setInputExpanded(prev => !prev)
  }, [])
  const toggleInputMenu = useCallback(() => {
    setInputMenuOpen(prev => !prev)
  }, [])
  const expandedInputRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (!inputExpanded) return
    const id = requestAnimationFrame(() => expandedInputRef.current?.focus())
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setInputExpanded(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(id)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [inputExpanded])

  useEffect(() => {
    if (!inputMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (inputMenuRef.current?.contains(target)) return
      if (inputMenuButtonRef.current?.contains(target)) return
      setInputMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInputMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [inputMenuOpen])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const syncHeight = () => {
      const minHeight = 60
      const maxHeight = Math.floor(window.innerHeight * 0.7)
      el.style.height = 'auto'
      el.style.maxHeight = `${maxHeight}px`
      const nextHeight = Math.max(minHeight, Math.min(el.scrollHeight, maxHeight))
      el.style.height = `${nextHeight}px`
      setInputHeight(prev => prev === nextHeight ? prev : nextHeight)
    }
    syncHeight()
    window.addEventListener('resize', syncHeight)
    return () => window.removeEventListener('resize', syncHeight)
  }, [input, sessionId])

  const resolveProjectBindPath = useCallback(async () => {
    if (!currentProjectId) throw new Error('当前会话没有所属项目, 无法写入项目知识沉淀')
    const cached = (projectForSession?.bind_path || '').trim()
    if (cached) return cached

    const arr = await api('/api/projects')
    if (Array.isArray(arr)) {
      setProjects(arr)
      const p = arr.find((item: any) => item.id === currentProjectId)
      const bindPath = (p?.bind_path || '').trim()
      if (bindPath) return bindPath
    }
    throw new Error('当前项目未绑定路径, 无法定位 .imac/project_knowledge.md')
  }, [currentProjectId, projectForSession?.bind_path, setProjects])

  const messageSignature = (items: any[]) => items.map(m => [
    m.id ?? 'local',
    m.role,
    m.bookmarked ?? 0,
    m.content?.length ?? 0,
    JSON.stringify(m.buttons || []),
    (m.content || '').slice(-48),
  ].join(':')).join('|')

  const normalizeMessages = (items: any[]) => items.map((m: any) => {
    if (m.buttons || !m.metadata) return m
    try {
      const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata
      return meta?.buttons ? { ...m, buttons: meta.buttons } : m
    } catch {
      return m
    }
  })

  const flushPendingJsonlEntries = useCallback(() => {
    if (pendingJsonlFlushTimerRef.current !== null) {
      window.clearTimeout(pendingJsonlFlushTimerRef.current)
      pendingJsonlFlushTimerRef.current = null
    }
    if (pendingJsonlEntriesRef.current.length === 0) return
    const batch = pendingJsonlEntriesRef.current
    const totalIncrement = pendingJsonlTotalIncrementRef.current
    pendingJsonlEntriesRef.current = []
    pendingJsonlTotalIncrementRef.current = 0
    setJsonlEntries(prev => prev.concat(batch))
    if (totalIncrement > 0) setJsonlTotal(prev => prev + totalIncrement)
  }, [])

  const clearPendingJsonlEntries = useCallback(() => {
    if (pendingJsonlFlushTimerRef.current !== null) {
      window.clearTimeout(pendingJsonlFlushTimerRef.current)
      pendingJsonlFlushTimerRef.current = null
    }
    pendingJsonlEntriesRef.current = []
    pendingJsonlTotalIncrementRef.current = 0
  }, [])

  const enqueueJsonlEntry = useCallback((entry: any) => {
    pendingJsonlEntriesRef.current.push(entry)
    pendingJsonlTotalIncrementRef.current += 1
    if (pendingJsonlFlushTimerRef.current !== null) return
    pendingJsonlFlushTimerRef.current = window.setTimeout(flushPendingJsonlEntries, 50)
  }, [flushPendingJsonlEntries])

  const connectEventStream = useCallback((sid: string) => {
    // sid 必须有效: 防止 subscribe {task_id: undefined} 触发后端 "session undefined 不存在或不属于你".
    if (!sid) return
    const token = localStorage.getItem('cc-token')
    if (!token) return
    // 开新连接前先关掉可能残留的旧连接, 避免两个 stream 并存把别的 session 数据混进来.
    if (eventSourceRef.current) { try { eventSourceRef.current.close() } catch {} eventSourceRef.current = null }
    const source = new EventSource(`/api/sessions/${encodeURIComponent(sid)}/events?token=${encodeURIComponent(token)}`)
    eventSourceRef.current = source
    setConnectionStatus('connecting')
    source.onopen = () => {
      // 期间已被切到别的 session → 这条 socket 作废, 不再 subscribe.
      if (source !== eventSourceRef.current) { try { source.close() } catch {} ; return }
      setConnectionStatus('connected')
    }

    const handleStreamMessage = (e: MessageEvent) => {
      // 切换 session 后, 旧 stream 仍可能投递缓冲消息. 非当前 stream 的消息一律丢弃,
      // 否则旁边 session 的 jsonl_history / jsonl_entry / history 会污染当前视图.
      if (source !== eventSourceRef.current) return
      try {
        const msg = JSON.parse(e.data)
        if (msg.event === 'message' || msg.event === 'card' || msg.event === 'update') {
          setTyping(false); setStreamContent('')
          loadHistoryRef.current()
        }
        else if (msg.event === 'typing') { setTyping(msg.active) }
        else if (msg.event === 'subscribed') { /* 不再读 msg.agent_status — 由 jsonl 派生 */ }
        else if (msg.event === 'history') {
          const history = normalizeMessages(msg.messages || [])
          // 不再截断: 主对话框展示全部 segment (按 turn 分组 + 折叠/展开).
          setMessages(history)
          setHistoryLoaded(true)
        }
        else if (msg.event === 'stream') setStreamContent(msg.content || '')
        else if (msg.event === 'buttons') {
          addMessage({ role: 'system', content: msg.text || '权限请求', buttons: msg.buttons || [] } as any)
          loadHistoryRef.current()
        }
        else if (msg.event === 'stopped') { setTyping(false); setStreamContent(''); loadHistoryRef.current() }
        else if (msg.event === 'jsonl_meta') {
          // count-then-tail: 后端 cheap count, 优先显示这个 total.
          if (msg.session_id && msg.session_id !== sid) return
          const total = Number(msg.total)
          if (Number.isFinite(total)) setJsonlTotal(total)
          if (typeof msg.jsonl_path === 'string') setJsonlPath(msg.jsonl_path)
        }
        else if (msg.event === 'jsonl_history') {
          // SSE 建连时分块回灌 jsonl 历史: reset=true 的第一块覆盖, 后续块追加.
          // 兼容旧后端: 没有 reset/chunk_index 时仍按一次性回灌覆盖处理.
          if (msg.session_id && msg.session_id !== sid) return
          const entries = Array.isArray(msg.entries) ? msg.entries : []
          const isChunked = typeof msg.chunk_index === 'number' || typeof msg.done === 'boolean'
          if (!isChunked) {
            clearPendingJsonlEntries()
            setJsonlEntries(entries)
          } else if (msg.reset) {
            clearPendingJsonlEntries()
            setJsonlEntries(entries)
          } else if (entries.length > 0) {
            setJsonlEntries(prev => prev.concat(entries))
          }
          // 兼容老后端: 没有先发 jsonl_meta 时, 用 msg.total / entries.length 回退.
          const fallbackTotal = Number(msg.total)
          if (Number.isFinite(fallbackTotal) && fallbackTotal > 0) {
            setJsonlTotal(prev => (fallbackTotal > prev ? fallbackTotal : prev))
          }
        }
        else if (msg.event === 'jsonl_entry') {
          // backend 写入新 entry, 追加. 后端带 session_id, 与本 stream 订阅的 sid 不符则丢弃 (双保险).
          if (msg.session_id && msg.session_id !== sid) return
          if (typeof msg.entry === 'undefined') return
          // live 增量合批写入 state: 高频工具输出时避免一条 entry 触发一次 React render.
          enqueueJsonlEntry(msg.entry)
        }
        else if (msg.event === 'error') {
          const text = formatSendError(msg)
          setLastSendError(text)
          addMessage({ role: 'system', content: `❌ ${text}` })
        }
      } catch {}
    }

    ;['subscribed', 'history', 'stream', 'buttons', 'stopped', 'jsonl_meta', 'jsonl_history', 'jsonl_entry', 'typing', 'server_error']
      .forEach(eventName => source.addEventListener(eventName, handleStreamMessage as EventListener))

    source.onerror = () => {
      if (source !== eventSourceRef.current) return
      setTyping(false)
      setConnectionStatus('disconnected')
    }
  }, [addMessage, clearPendingJsonlEntries, enqueueJsonlEntry])

  // 标记当前 session 的历史消息是否已成功从后端取回过 (至少一次).
  // 用来防止 SessionStartModal 在切换 session / 首次进入的清空-加载窗口期
  // 误判 "messages 为空 -> 弹窗", 造成闪烁体验.
  const [historyLoaded, setHistoryLoaded] = useState(false)

  const loadHistory = useCallback(() => {
    const sid = currentSession?.session_id || currentTask?.task_id
    if (!sid) return
    // 不带 limit -> 后端返回全部 messages (按 id ASC).
    api(`/api/tasks/${sid}/messages`).then(data => {
      // 切换 session 后, 旧 session 的请求可能晚于切换才返回. 若已不是当前 session, 丢弃,
      // 否则会把旧 session 的消息覆盖到新 session 的视图.
      const activeSid = useStore.getState().currentSession?.session_id || useStore.getState().currentTask?.task_id
      if (sid !== activeSid) return
      const msgs = normalizeMessages(Array.isArray(data) ? data : (data.messages || []))
      const current = useStore.getState().messages
      const displayMsgs = msgs
      const pendingLocal = current.filter((m: any) =>
        !m.id && m.role === 'user' && !displayMsgs.some((dbMsg: any) => dbMsg.role === 'user' && dbMsg.content === m.content)
      )
      const nextMsgs = [...displayMsgs, ...pendingLocal]
      if (messageSignature(nextMsgs) !== messageSignature(current)) {
        setMessages(nextMsgs)
      }
      setHistoryLoaded(true)
    }).catch(() => {})
  }, [currentSession?.session_id, currentTask?.task_id])

  useEffect(() => { loadHistoryRef.current = loadHistory }, [loadHistory])

  // count-then-tail: "加载全部" 时, 用 REST 拉缺失的头部 entries 并 prepend.
  // 服务端按 0..total 排好序; 当前 entries 已经是末尾 N 条, 我们拉 [0, total - entries.length)
  // 然后 prepend 到本地 entries. 全部加载完后 hasRemoteMore 自动变 false (entries.length 追上 total).
  const handleLoadAllJsonl = useCallback(async () => {
    const sid = currentSession?.session_id || currentTask?.task_id
    if (!sid) return
    flushPendingJsonlEntries()
    if (jsonlLoadingMore) return
    if (jsonlTotal <= jsonlEntries.length) return
    setJsonlLoadingMore(true)
    try {
      const missing = jsonlTotal - jsonlEntries.length
      // 限制单次请求 ≤ 5000; 超过的会被后端 clip, 但我们就拿到能拿的部分.
      const data = await api(`/api/sessions/${sid}/jsonl-history?from=0&limit=${Math.max(missing, 1)}`)
      const head = Array.isArray(data?.entries) ? data.entries : []
      if (!head.length) return
      // 切换 session 防御: 加载期间用户切了 session, 丢弃结果.
      const activeSid = useStore.getState().currentSession?.session_id || useStore.getState().currentTask?.task_id
      if (sid !== activeSid) return
      setJsonlEntries(prev => head.concat(prev))
      if (Number.isFinite(Number(data?.total))) setJsonlTotal(Number(data.total))
    } catch (e) {
      console.warn('[jsonl] load all failed:', e)
    } finally {
      setJsonlLoadingMore(false)
    }
  }, [currentSession?.session_id, currentTask?.task_id, flushPendingJsonlEntries, jsonlLoadingMore, jsonlTotal, jsonlEntries.length])

  useEffect(() => {
    const sid = currentSession?.session_id || currentTask?.task_id
    if (!sid) return
    clearPendingJsonlEntries()
    setStreamContent('')
    setTyping(false)
    setMessages([])
    setJsonlEntries([])
    setJsonlTotal(0)
    setJsonlPath(null)
    setJsonlLoadingMore(false)
    setHistoryLoaded(false)
    loadHistory()
    connectEventStream(sid)
    return () => {
      clearPendingJsonlEntries()
      eventSourceRef.current?.close(); eventSourceRef.current = null; setConnectionStatus('disconnected')
    }
  }, [currentSession?.session_id, currentTask?.task_id, clearPendingJsonlEntries, loadHistory, connectEventStream])

  // 卡片数量变化 (jsonlEntries.length) 时自动滚到末尾, 同时也覆盖原有 messages/stream/typing 触发.
  // userScrolledUp=true 时不抢滚条, 改在顶部显示"新消息"按钮.
  // 用 instant scroll (而非 smooth) + RAF: smooth 期间会持续触发 onScroll, 中间帧 distFromBottom>200
  // 会误把 userScrolledUp 翻成 true, 导致下一次 entry 抵达时不再自动滚.
  useEffect(() => {
    if (userScrolledUp) {
      setHasNewMessages(true)
    } else {
      requestAnimationFrame(() => {
        const el = chatContainerRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
    }
  }, [messages, streamContent, isTyping, jsonlEntries.length])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      // 用当前真实选中的 session id. 注意: currentTask 可能被赋值为 Session 对象,
      // 其 task_id 为 undefined, 直接用它重连会发出 subscribe {task_id: undefined},
      // 触发后端 "session undefined 不存在或不属于你".
      const sid = currentSession?.session_id || currentTask?.task_id
      if (!sid) return
      loadHistory()
      if (!eventSourceRef.current || eventSourceRef.current.readyState === EventSource.CLOSED) {
        connectEventStream(sid)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [currentSession?.session_id, currentTask?.task_id, loadHistory, connectEventStream])

  const sendCompactCommand = useCallback(() => {
    const content = '/compact'
    setCompactConfirmOpen(false)
    if (!sessionId) {
      setLastSendError('当前没有可发送指令的 Session')
      return
    }

    const requestId = makeSendRequestId()
    setLastSendError('')
    addMessage({ role: 'user', content })
    setPendingSendAt(Date.now())
    setTyping(true)
    postSessionMessage({ content, inputText: content, requestId })
      .then(() => setTimeout(() => loadHistoryRef.current(), 500))
      .catch(() => {})
  }, [sessionId, addMessage, setTyping, postSessionMessage])

  const send = useCallback(() => {
    const text = input.trim()
    const readyAtts = attachments.filter(a => a.status === 'done' && a.remotePath)
    // 必须有文本或至少一个已上传完成的附件
    if (!text && readyAtts.length === 0) return
    if (voiceState === 'recording' || voiceState === 'transcribing') return
    if (messageSubmitting) return
    if (anyUploading) {
      // 还在上传, 给用户一个非阻塞提示
      setLastSendError('附件仍在上传, 请稍候...')
      return
    }
    // 把附件路径作为前缀拼到消息里, 让 agent 能直接读到绝对路径.
    // 格式参照常见做法: [附件] 块在最前, 用户文本在后.
    const attachLines = readyAtts.map(a =>
      a.kind === 'image' ? `- [图片] ${a.remotePath}` : `- [文件] ${a.remotePath}`
    )
    const attachBlock = attachLines.length > 0 ? `[附件]\n${attachLines.join('\n')}` : ''
    let content = [attachBlock, text].filter(Boolean).join('\n\n')
    if (replyTo) {
      const quoted = (replyTo.content || '').split('\n').slice(0, 3).map((l: string) => `> ${l}`).join('\n')
      content = `${quoted}\n\n${content}`
      setReplyTo(null)
    }
    const sentSessionId = sessionId
    const sentInput = input
    const requestId = makeSendRequestId()
    setLastSendError('')
    addMessage({ role: 'user', content })
    setPendingSendAt(Date.now())
    setMessageSubmitting(true)
    setTyping(true)
    postSessionMessage({ content, inputText: text, requestId })
      .then(() => {
        clearSessionInputDraft(sentSessionId, sentInput)
        setEditingMsg(null)
        clearAttachments()
        inputRef.current?.focus()
        setTimeout(() => loadHistoryRef.current(), 500)
      })
      .catch(() => { inputRef.current?.focus() })
      .finally(() => setMessageSubmitting(false))
  }, [input, replyTo, sessionId, addMessage, attachments, anyUploading, messageSubmitting, clearAttachments, postSessionMessage, clearSessionInputDraft, voiceState])

  const sendProjectKnowledgePrompt = useCallback(async () => {
    if (!sessionId || projectKnowledgeSending) return
    setProjectKnowledgeSending(true)
    try {
      const bindPath = await resolveProjectBindPath()
      const normalizedBindPath = bindPath.replace(/\/+$/, '') || '/'
      const knowledgePath = normalizedBindPath === '/'
        ? '/.imac/project_knowledge.md'
        : `${normalizedBindPath}/.imac/project_knowledge.md`
      const content = buildProjectKnowledgePrompt(knowledgePath)

      const requestId = makeSendRequestId()
      setLastSendError('')
      addMessage({ role: 'user', content })
      setPendingSendAt(Date.now())
      setTyping(true)
      await postSessionMessage({ content, requestId })
      setTimeout(() => loadHistoryRef.current(), 500)
    } catch (e: any) {
      alert(e?.message || '发送项目知识沉淀指令失败')
    } finally {
      setProjectKnowledgeSending(false)
    }
  }, [sessionId, projectKnowledgeSending, resolveProjectBindPath, addMessage, setTyping, postSessionMessage])

  const sendRunProjectPortPrompt = useCallback((mainProjectPortPath: string) => {
    if (!sessionId) {
      setLastSendError('当前没有可发送指令的 Session')
      return
    }
    const hostname = typeof window !== 'undefined' ? window.location.hostname : ''
    const hostHint = hostname
      ? `如果是 Vite 项目，你需要向 server.allowedHosts 中添加 ${hostname}；如果是其他更新颖的前端框架，如果有必要，也需要将 ${hostname} 加白。`
      : '如果是 Vite 项目，你需要向 server.allowedHosts 中添加当前前端访问 hostname；如果是其他更新颖的前端框架，如果有必要，也需要将当前 hostname 加白。'
    const content = `[这条消息来自系统而不是用户] 如果当前项目是一个有对外端口服务的项目，请现在开始在合适的端口运行项目（自行选择合适运行模式），等待运行成功后，将端口号码写入 ${mainProjectPortPath}。${hostHint}`
    setRunProjectPrompt(content)
  }, [sessionId])

  const confirmSendRunProjectPortPrompt = useCallback(() => {
    const content = runProjectPrompt.trim()
    if (!content) return
    const requestId = makeSendRequestId()
    setLastSendError('')
    setRunProjectPrompt('')
    addMessage({ role: 'system', content })
    setPendingSendAt(Date.now())
    setTyping(true)
    postSessionMessage({ content, inputText: content, requestId })
      .then(() => setTimeout(() => loadHistoryRef.current(), 500))
      .catch(() => {})
  }, [runProjectPrompt, addMessage, setTyping, postSessionMessage])

  const requestPredictedNextQuestions = useCallback(async () => {
    if (!sessionId || nextQuestionLoading) return
    setNextQuestionLoading(true)
    setLastSendError('')
    try {
      const result = await api(`/api/sessions/${sessionId}/predicted-next-questions`, {
        method: 'POST',
      }) as { questions?: string[] }
      const questions = Array.isArray(result?.questions)
        ? result.questions.map(q => String(q || '').trim()).filter(Boolean)
        : []
      if (questions.length === 0) {
        setLastSendError('智能下一个用户提问没有返回可用候选')
        return
      }
      setNextQuestionCandidates(questions)
      setNextQuestionModalOpen(true)
    } catch (e: any) {
      setLastSendError(e?.message || '生成智能下一个用户提问失败')
    } finally {
      setNextQuestionLoading(false)
    }
  }, [sessionId, nextQuestionLoading])

  const sendPredictedNextQuestion = useCallback((value: string) => {
    const content = String(value || '').trim()
    if (!content) return
    if (!sessionId) {
      setLastSendError('当前没有可发送指令的 Session')
      return
    }
    if (pendingSendAt || messageSubmitting) {
      setLastSendError('上一条消息仍在提交，请稍后再发送')
      return
    }
    const requestId = makeSendRequestId()
    setNextQuestionModalOpen(false)
    setNextQuestionCandidates([])
    setLastSendError('')
    addMessage({ role: 'user', content })
    setPendingSendAt(Date.now())
    setMessageSubmitting(true)
    setTyping(true)
    postSessionMessage({ content, inputText: content, requestId })
      .then(() => {
        inputRef.current?.focus()
        setTimeout(() => loadHistoryRef.current(), 500)
      })
      .catch(() => { inputRef.current?.focus() })
      .finally(() => setMessageSubmitting(false))
  }, [sessionId, pendingSendAt, messageSubmitting, addMessage, setTyping, postSessionMessage])

  const handleContinueSessionCreated = useCallback((created: any) => {
    setContinueModalOpen(false)
    if (!created?.session_id) return
    if (currentIssueId) {
      const currentList = sessionsMap[currentIssueId] || []
      const withoutDup = currentList.filter((s: any) => s.session_id !== created.session_id)
      setSessionsMap(currentIssueId, [created, ...withoutDup])
    }
    setCurrentSession(created)
    setCurrentTask(created as any)
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('session', created.session_id)
      window.history.pushState({}, '', url)
    } catch {}
  }, [currentIssueId, sessionsMap, setCurrentSession, setCurrentTask, setSessionsMap])

  // 由"开始执行?"弹窗的「立即执行!」按钮触发: 自动用 Session 元数据
  // (name / description) 拼成第一条消息发出去, 不需要用户再输入.
  const startSession = useCallback(async (): Promise<void> => {
    if (!currentSession) throw new Error('当前 Session 未加载')
    const name = (currentSession.name || '').trim()
    const description = ((currentSession as any).description || '').trim()
    const content = [name, description].filter(Boolean).join('\n\n')
    if (!content) throw new Error('Session 名称和描述都为空, 无内容可发送')

    const requestId = makeSendRequestId()
    setLastSendError('')
    addMessage({ role: 'user', content })
    setPendingSendAt(Date.now())
    setTyping(true)
    setTimeout(() => loadHistoryRef.current(), 500)
    await postSessionMessage({ content, requestId })
  }, [currentSession, addMessage, setTyping, postSessionMessage])

  // 哪些 session 的"开始执行?"弹窗已被本地 dismiss(立即执行/暂不执行均算).
  // 用 Set<sessionId> 保证切换其它 session 时不会重复弹, 同一 session 内
  // 操作过后也不再弹.
  const [startDismissed, setStartDismissed] = useState<Set<string>>(new Set())
  const dismissStartModal = useCallback((sid: string) => {
    setStartDismissed(prev => {
      if (prev.has(sid)) return prev
      const next = new Set(prev)
      next.add(sid)
      return next
    })
  }, [])

  const handleQuote = useCallback((m: any) => {
    setReplyTo(m); setEditingMsg(null); inputRef.current?.focus()
  }, [])

  const handleEdit = useCallback((m: any) => {
    setEditingMsg(m); setReplyTo(null); setInput(m.content || ''); inputRef.current?.focus()
  }, [])

  const handleBookmark = useCallback(async (m: any) => {
    if (!m.id) return
    try {
      const res = await api(`/api/messages/${m.id}/bookmark`, { method: 'PATCH' })
      setMessages(messages.map(msg => msg.id === m.id ? { ...msg, bookmarked: res.bookmarked } : msg))
    } catch {}
  }, [messages])

  const handleStopSession = useCallback(() => {
    if (!sessionId) return
    setStopFeedbackActive(true)
    if (stopFeedbackTimerRef.current) clearTimeout(stopFeedbackTimerRef.current)
    stopFeedbackTimerRef.current = setTimeout(() => {
      setStopFeedbackActive(false)
      stopFeedbackTimerRef.current = null
    }, 1800)
    setPendingSendAt(null)
    api(`/api/sessions/${sessionId}/stop`, { method: 'POST' })
      .then(() => {
        setTyping(false)
        setStreamContent('')
        loadHistoryRef.current()
      })
      .catch((e: any) => {
        setLastSendError(e?.message || '终止失败')
        setStopFeedbackActive(false)
      })
  }, [sessionId, setTyping, setStreamContent])

  if (!currentSession && !currentTask) return (
    <div className="flex-1 flex items-center justify-center" style={{ background: 'var(--bg-secondary)' }}>
      <div className="text-center max-w-md">
        <MobiusLogo size={72} className="mx-auto mb-6" />
        <h2 className="text-2xl font-bold mb-2" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>Mobius 莫比乌斯</h2>
        <p className="text-[14px] leading-relaxed" style={{ color: theme !== 'light' ? '#6b7280' : '#64748b' }}>从左侧选择Session或新建Session开始对话</p>
      </div>
    </div>
  )

  return (
    <div className="flex-1 flex flex-col h-full min-w-0" style={{ background: 'var(--bg-secondary)' }}>
      {attachmentImagePreview && (
        <AttachmentImagePreviewModal preview={attachmentImagePreview} onClose={closeAttachmentImagePreview} />
      )}
      {runProjectPrompt && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center px-4" role="dialog" aria-modal="true" aria-labelledby="run-project-port-title">
          <button
            type="button"
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            aria-label="取消发送运行项目指令"
            onClick={() => setRunProjectPrompt('')}
          />
          <div
            className="relative w-full max-w-[640px] overflow-hidden rounded-2xl shadow-2xl"
            style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b px-5 py-3" style={{ borderColor: 'var(--border-color)' }}>
              <div className="min-w-0">
                <div id="run-project-port-title" className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  确认发送运行项目指令
                </div>
                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  下面的消息将发送给当前 Session
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRunProjectPrompt('')}
                className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--bg-card-hover)]"
                style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4">
              <div
                className="max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words rounded-xl border p-3 text-[12px] leading-relaxed"
                style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}
              >
                {runProjectPrompt}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRunProjectPrompt('')}
                  className="h-9 rounded-xl border px-4 text-[13px] transition-colors hover:bg-[var(--bg-card-hover)]"
                  style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={confirmSendRunProjectPortPrompt}
                  className="h-9 rounded-xl bg-emerald-500 px-4 text-[13px] font-medium text-white transition-colors hover:bg-emerald-600"
                >
                  确认发送
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {nextQuestionModalOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center px-4" role="dialog" aria-modal="true" aria-labelledby="next-question-title">
          <button
            type="button"
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            aria-label="关闭智能下一个用户提问"
            onClick={() => setNextQuestionModalOpen(false)}
          />
          <div
            className="relative w-full max-w-[620px] overflow-hidden rounded-2xl shadow-2xl"
            style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b px-5 py-3" style={{ borderColor: 'var(--border-color)' }}>
              <div className="min-w-0">
                <div id="next-question-title" className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  智能下一个用户提问
                </div>
                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  选择一条指令发送给当前 Session
                </div>
              </div>
              <button
                type="button"
                onClick={() => setNextQuestionModalOpen(false)}
                className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--bg-card-hover)]"
                style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[420px] overflow-y-auto p-3">
              <div className="space-y-2">
                {nextQuestionCandidates.map((question, index) => (
                  <button
                    key={`${index}-${question}`}
                    type="button"
                    onClick={() => sendPredictedNextQuestion(question)}
                    disabled={messageSubmitting || !!pendingSendAt}
                    className="w-full rounded-xl border px-3 py-2.5 text-left text-[13px] leading-relaxed transition-colors hover:bg-blue-500/10 hover:border-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)', background: 'var(--bg-primary)' }}
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* 顶栏（会话标题 + 单一状态 chip + Stop + VSCode + 溢出菜单） */}
      <div data-tour="session-chat-header" className="h-12 border-b flex items-center justify-between px-5 flex-shrink-0" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="min-w-0 flex items-center gap-2">
            <h2 className="min-w-0 font-semibold text-[14px] truncate" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>
              {currentSession?.name || currentTask?.name}
            </h2>
            {currentModelLabel && (
              <span className="text-[10px] px-2 py-0.5 rounded-md flex-shrink-0 hidden md:inline-flex"
                title={`模型: ${currentModelLabel}`}
                style={{ color: 'var(--text-muted)', background: 'var(--bg-card-hover)' }}>
                {currentModelLabel}
              </span>
            )}
            {/* 单一统一状态 chip — 优先级: 断开 > 失败 > pending > working > waiting > done > idle */}
            {(() => {
              const disconnected = connectionStatus !== 'connected'
              const failed = backendJobFailed === true
              const pending = !!pendingSendAt
              const working = !!(backendAlive && backendWorking)
              const waiting = !!(backendAlive && !backendWorking)
              const done = backendJobDone === true && !backendAlive
              type Tone = 'gray' | 'red' | 'amber' | 'green' | 'sky' | 'emerald'
              let label = '空闲', tone: Tone = 'gray', pulse = false
              if (disconnected) { label = '已断开'; tone = 'gray' }
              else if (failed) { label = '失败'; tone = 'red' }
              else if (pending) { label = '启动中'; tone = 'amber'; pulse = true }
              else if (working) { label = '执行中'; tone = 'green'; pulse = true }
              else if (waiting) { label = '待命'; tone = 'sky' }
              else if (done) { label = '已结束'; tone = 'emerald' }
              const toneMap: Record<Tone, { text: string; bg: string; border: string; dot: string }> = {
                gray:    { text: 'text-gray-400',    bg: 'bg-gray-500/10',    border: 'border-gray-500/20',    dot: 'bg-gray-400' },
                red:     { text: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/20',     dot: 'bg-red-400' },
                amber:   { text: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   dot: 'bg-amber-400' },
                green:   { text: 'text-green-400',   bg: 'bg-green-500/10',   border: 'border-green-500/20',   dot: 'bg-green-400' },
                sky:     { text: 'text-sky-400',     bg: 'bg-sky-500/10',     border: 'border-sky-500/20',     dot: 'bg-sky-400' },
                emerald: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', dot: 'bg-emerald-400' },
              }
              const t = toneMap[tone]
              return (
                <span data-tour="session-status" className={`text-[11px] px-2 py-0.5 rounded-full flex-shrink-0 border inline-flex items-center gap-1.5 ${t.text} ${t.bg} ${t.border}`}>
                  <span className="relative inline-flex w-1.5 h-1.5">
                    {pulse && <span className={`absolute inset-0 rounded-full ${t.dot} animate-ping opacity-75`} />}
                    <span className={`relative inline-flex rounded-full w-1.5 h-1.5 ${t.dot}`} />
                  </span>
                  {label}
                </span>
              )
            })()}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Stop: 终止当前 turn — 独立于发送按钮, 保持常驻可见. */}
          <button
            type="button"
            onClick={handleStopSession}
            disabled={!sessionId}
            aria-live="polite"
            title="终止当前智能体正在执行的操作"
            className={`session-stop-button h-7 px-2.5 text-[11px] border border-red-500/25 text-red-300 rounded-xl hover:bg-red-500/15 hover:text-red-100 transition-all hidden md:inline-flex items-center justify-center gap-1 disabled:opacity-45 disabled:cursor-not-allowed ${stopFeedbackActive ? 'session-stop-button--active' : ''}`}>
            {stopFeedbackActive && (
              <>
                <span className="session-stop-button__shock" />
                <span className="session-stop-button__ring session-stop-button__ring--one" />
                <span className="session-stop-button__ring session-stop-button__ring--two" />
              </>
            )}
            <span className="session-stop-button__square inline-block w-1.5 h-1.5 rounded-sm bg-current opacity-90" />
            <span className="relative z-10 whitespace-nowrap">{stopFeedbackActive ? '已触发' : '终止'}</span>
          </button>
          {currentProjectId && (
            <OpenInVSCodeButton
              projectId={currentProjectId}
              subPath={currentVscodeSubPath}
              showWorktreeOption={!!currentVscodeSubPath}
              className="h-7 px-2.5 text-[11px] border border-blue-500/20 text-blue-400 rounded-xl hover:bg-blue-500/10 transition-colors hidden md:inline-flex items-center gap-1.5 whitespace-nowrap"
            />
          )}
          {/* … 溢出菜单: 把 "原始数据 / 隐藏次要条目 / 项目知识沉淀" 收纳进来 */}
          <ChatHeaderOverflowMenu
            jsonlCount={jsonlEntries.length}
            minorCount={minorCount}
            hideMinor={hideMinorJsonl}
            onToggleHideMinor={() => setHideMinorJsonl(v => !v)}
            onOpenRaw={() => setShowRaw(true)}
            showJsonlMeta={showJsonlMeta}
            onToggleShowJsonlMeta={() => setShowJsonlMeta(v => !v)}
            onSendProjectKnowledge={sendProjectKnowledgePrompt}
            projectKnowledgeSending={projectKnowledgeSending}
            canSendProjectKnowledge={jsonlEntries.length > 0 && !!currentProjectId && connectionStatus === 'connected'}
            onContinueWithOtherModel={() => setContinueModalOpen(true)}
            canContinueWithOtherModel={!!currentSession?.session_id && (!!currentIssueId || !!(currentSession as any)?.research_id)}
            onStop={handleStopSession}
            canStop={!!sessionId}
          />
        </div>
      </div>

      {stopFeedbackActive && (
        <div className="pointer-events-none fixed left-1/2 top-16 z-[80] -translate-x-1/2">
          <div className="session-stop-toast flex items-center gap-2 rounded-xl border border-red-300/45 bg-red-600 px-4 py-2 text-[13px] font-semibold text-white shadow-2xl shadow-red-950/40">
            <span className="session-stop-toast__icon inline-flex h-5 w-5 items-center justify-center rounded-md bg-white/18">
              <span className="h-2.5 w-2.5 rounded-sm bg-white" />
            </span>
            终止指令已发送
          </div>
        </div>
      )}

      {lastSendError && (
        <div className="mx-5 mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] text-red-300 bg-red-500/10 border-red-500/25 flex-shrink-0">
          <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{lastSendError}</div>
          <button
            type="button"
            onClick={() => {
              if (backendJobFailed === true || isTuiContactTimeoutText(lastSendError)) hideBackendFailure()
              setLastSendError('')
            }}
            className="text-red-300/70 hover:text-red-200 transition-colors flex-shrink-0"
            title="关闭错误提示">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* 持久失败横幅: 取自 failed.flag 的 reason, 可手动关闭; 成功继续对话后也会隐藏. */}
      {showBackendFailureBanner && (
        <div className="mx-5 mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] text-red-300 bg-red-500/10 border-red-500/25 flex-shrink-0">
          <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{backendFailureMessage}</div>
          <button
            type="button"
            onClick={() => hideBackendFailure()}
            className="text-red-300/70 hover:text-red-200 transition-colors flex-shrink-0"
            title="关闭错误提示">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* body: 横向分 68% JsonlView + 32% (输入 + skill/memory 编辑). 窄屏改纵向堆叠 (见 index.css .mobius-chat-body). */}
      <div className="mobius-chat-body flex-1 flex min-h-0">
        {/* 左 68%: JSONL 视图 */}
        <div data-tour="session-jsonl-view" className="mobius-chat-history flex flex-col min-w-0" style={{ width: '68%' }}>
          <div className="flex-1 overflow-y-auto relative" ref={chatContainerRef}
            onScroll={(e) => {
              const el = e.currentTarget
              const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
              if (distFromBottom > 200) setUserScrolledUp(true)
              else { setUserScrolledUp(false); setHasNewMessages(false) }
            }}>
            <div className="px-6 py-6">
              <VSCodeOpenProvider projectId={currentProjectId}>
                <JsonlView
                  entries={visibleJsonl}
                  title=""
                  emptyLoadingText={jsonlEmptyLoadingText}
                  total={jsonlTotal > jsonlEntries.length ? jsonlTotal - (jsonlEntries.length - visibleJsonl.length) : undefined}
                  onLoadMore={handleLoadAllJsonl}
                  loadingMore={jsonlLoadingMore}
                  showMeta={showJsonlMeta}
                />
              {/* live tail: 只在真正 working 时挂, alive 但不 working (待命) 时不出 — 否则
                  会一直累计沉默时长造成误读. */}
              {backendAlive && backendWorking && (
                <JsonlLiveTailCard
                  lastTimestamp={jsonlEntries[jsonlEntries.length - 1]?.timestamp}
                  pid={backendPid}
                />
              )}
              <div ref={endRef} />
              </VSCodeOpenProvider>
            </div>
          </div>
          {hasNewMessages && (
            <div className="flex justify-center py-1 flex-shrink-0">
              <button onClick={() => {
                const el = chatContainerRef.current
                if (el) el.scrollTop = el.scrollHeight
                setUserScrolledUp(false)
                setHasNewMessages(false)
              }} className="px-4 py-1.5 text-[12px] bg-blue-500/90 text-white rounded-full hover:bg-blue-500 transition-colors shadow-md flex items-center gap-1.5">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 14l-7 7m0 0l-7-7m7 7V3" /></svg>
                新消息
              </button>
            </div>
          )}
        </div>

        {/* 右 32%: 输入区 (顶) + skill/memory editor (底). 整列竖向滚动. 窄屏整宽 (见 index.css .mobius-chat-input). */}
        <div className="mobius-chat-input flex flex-col border-l flex-shrink-0" style={{ width: '32%', borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
          {/* 输入区 */}
          <div className="border-b p-3 flex-shrink-0" style={{ borderColor: 'var(--border-color)' }}>
            <div>
          {replyTo && (
            <div className="flex items-center gap-2 mb-2 px-4 py-2 bg-blue-500/5 border border-blue-500/15 rounded-xl">
              <svg className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
              <div className="flex-1 min-w-0 text-[12px] text-[var(--text-secondary)] truncate">
                引用 {replyTo.role === 'assistant' ? '智能体' : '你'}: {(replyTo.content || '').slice(0, 100)}
              </div>
              <button onClick={() => setReplyTo(null)} className="text-[var(--text-dimmed)] hover:text-[var(--text-secondary)] transition-colors flex-shrink-0">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          )}
          {editingMsg && (
            <div className="flex items-center gap-2 mb-2 px-4 py-2 bg-yellow-500/5 border border-yellow-500/15 rounded-xl">
              <svg className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
              <div className="flex-1 min-w-0 text-[12px] text-yellow-400/80">编辑消息 (将作为新消息重新发送)</div>
              <button onClick={() => { setEditingMsg(null); setInput('') }} className="text-[var(--text-dimmed)] hover:text-[var(--text-secondary)] transition-colors flex-shrink-0">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          )}
          <div
            data-tour="session-chat-input"
            className="relative rounded-2xl transition-all focus-within:ring-2 focus-within:ring-blue-500/15"
            style={{
              background: 'var(--input-bg)',
              border: `1px solid ${theme !== 'light' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)'}`,
              boxShadow: inputFocused
                ? (theme !== 'light'
                  ? '0 4px 20px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02) inset'
                  : '0 4px 20px rgba(0,0,0,0.08), 0 0 0 1px rgba(255,255,255,0.6) inset')
                : (theme !== 'light'
                  ? '0 2px 12px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.02) inset'
                  : '0 2px 12px rgba(0,0,0,0.06), 0 0 0 1px rgba(255,255,255,0.6) inset'),
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onPaste={handlePaste}
            onFocusCapture={() => setInputFocused(true)}
            onBlurCapture={(event) => {
              const nextTarget = event.relatedTarget as Node | null
              if (nextTarget && event.currentTarget.contains(nextTarget)) return
              setInputFocused(false)
            }}>
            {isDraggingFile && (
              <div className="absolute inset-0 z-20 p-1 pointer-events-none" style={{ background: 'var(--input-bg)', borderRadius: 14 }}>
                <div className="flex h-full items-center justify-center rounded-[14px] border border-dashed border-blue-500/55"
                  style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.08), rgba(59,130,246,0.18))' }}>
                  <div className="text-[12px] font-medium text-blue-400">松开以添加文件</div>
                </div>
              </div>
            )}
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInputChange} />
            <div className="px-3 pt-3 pb-2.5">
              {attachments.length > 0 && (
                <div className="mb-2 flex max-h-20 flex-wrap items-start gap-1.5 overflow-y-auto pr-1">
                  {attachments.map(att => (
                    <AttachmentChip
                      key={att.id}
                      att={att}
                      theme={theme as 'dark' | 'light' | 'purple'}
                      onRemove={() => removeAttachment(att.id)}
                      onPreview={openAttachmentImagePreview}
                    />
                  ))}
                </div>
              )}
              <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
                placeholder={inputPlaceholder}
                className="w-full bg-transparent resize-none border-0 px-0 pt-0 pb-1 text-[16px] leading-[1.55] placeholder:!text-[var(--placeholder-color)] focus:outline-none overflow-y-auto"
                style={{ height: inputHeight, minHeight: 60, maxHeight: '70vh', color: 'var(--text-primary)' }}
              />
            </div>
            <div className="relative flex items-end gap-2 px-3 pb-3 pt-0">
              <div className="relative">
                <button
                  ref={inputMenuButtonRef}
                  type="button"
                  onClick={toggleInputMenu}
                  aria-haspopup="menu"
                  aria-expanded={inputMenuOpen}
                  aria-label="更多输入功能"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors"
                  style={{
                    color: theme !== 'light' ? '#d1d5db' : '#374151',
                    border: `1px solid ${inputMenuOpen ? 'rgba(96,165,250,0.38)' : (theme !== 'light' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)')}`,
                    background: inputMenuOpen ? 'rgba(59,130,246,0.12)' : 'transparent',
                  }}
                >
                  <Plus className="h-[17px] w-[17px]" strokeWidth={2.2} />
                </button>
                {inputMenuOpen && (
                  <div
                    ref={inputMenuRef}
                    role="menu"
                    className="absolute bottom-11 left-0 z-30 min-w-44 overflow-hidden rounded-xl border p-1 shadow-xl backdrop-blur-sm"
                    style={{
                      background: theme !== 'light' ? 'rgba(15, 23, 42, 0.96)' : 'rgba(255, 255, 255, 0.98)',
                      borderColor: theme !== 'light' ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.10)',
                    }}
                  >
                    <button type="button" role="menuitem" onClick={() => { setInputMenuOpen(false); openFilePicker() }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--bg-card-hover)]"
                      style={{ color: 'var(--text-primary)' }}>
                      <Paperclip className="h-3.5 w-3.5" strokeWidth={2} />
                      <span>上传文件</span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => { setInputMenuOpen(false); setCompactConfirmOpen(true) }}
                      disabled={!sessionId}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{ color: 'var(--text-primary)' }}>
                      <Archive className="h-3.5 w-3.5" strokeWidth={2} />
                      <span>压缩上文</span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => { setInputMenuOpen(false); toggleInputExpanded() }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--bg-card-hover)]"
                      style={{ color: 'var(--text-primary)' }}>
                      {inputExpanded ? <Minimize2 className="h-3.5 w-3.5" strokeWidth={2} /> : <Maximize2 className="h-3.5 w-3.5" strokeWidth={2} />}
                      <span>{inputExpanded ? '收起大输入' : '展开大输入'}</span>
                    </button>
                  </div>
                )}
              </div>
              <button type="button"
                onClick={() => setInputReplayOpen(true)}
                disabled={!sessionId}
                title="回放输入"
                aria-label="回放输入"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  color: theme !== 'light' ? '#d1d5db' : '#374151',
                  border: `1px solid ${theme !== 'light' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`,
                  background: 'transparent',
                }}
              >
                <History className="w-[17px] h-[17px]" strokeWidth={2} />
              </button>
              <button type="button"
                onClick={toggleVoiceRecording}
                disabled={messageSubmitting || voiceState === 'transcribing'}
                title={voiceTip}
                aria-label={voiceTip}
                aria-pressed={voiceState === 'recording'}
                className={`inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors assistant-session-input__voice assistant-session-input__voice--${voiceState} disabled:opacity-40 disabled:cursor-not-allowed`}
                style={{
                  color: voiceState === 'recording' ? '#f87171' : (voiceState === 'transcribing' ? '#38bdf8' : (theme !== 'light' ? '#d1d5db' : '#374151')),
                  border: `1px solid ${voiceState === 'recording' ? 'rgba(248,113,113,0.34)' : (voiceState === 'transcribing' ? 'rgba(56,189,248,0.34)' : (theme !== 'light' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'))}`,
                  background: voiceState === 'recording' ? 'rgba(239,68,68,0.13)' : (voiceState === 'transcribing' ? 'rgba(14,165,233,0.12)' : 'transparent'),
                }}
              >
                {voiceState === 'recording' ? (
                  <Square className="w-[17px] h-[17px]" fill="currentColor" />
                ) : voiceState === 'transcribing' ? (
                  <RefreshCw className="w-[17px] h-[17px] animate-spin" />
                ) : (
                  <Mic className="w-[17px] h-[17px]" />
                )}
              </button>
              {(() => {
                // 硬约束: 发送按钮永远只执行 send, 不允许根据 agentActive / running / pending
                // 切换成 "停止生成" 或任何终止语义. 终止必须使用上方独立的 "终止" 按钮.
                const sendDisabled = (!input.trim() && attachments.filter(a => a.status === 'done').length === 0) || anyUploading || !!pendingSendAt || messageSubmitting || voiceBusy
                const sendBg = sendDisabled
                  ? (theme !== 'light' ? '#374151' : '#e5e7eb')
                  : (theme !== 'light' ? '#ffffff' : '#111827')
                const sendFg = sendDisabled
                  ? (theme !== 'light' ? '#6b7280' : '#9ca3af')
                  : (theme !== 'light' ? '#111827' : '#ffffff')
                return (
                  <button onClick={send} disabled={sendDisabled}
                    data-tour="session-chat-send"
                    title={voiceBusy ? voiceTip : anyUploading ? '附件仍在上传...' : (pendingSendAt || messageSubmitting) ? '正在提交上一条消息...' : '发送 (Enter)'}
                    className="w-10 h-10 flex items-center justify-center rounded-full transition-all active:scale-95"
                    style={{ background: sendBg, color: sendFg, cursor: sendDisabled ? 'not-allowed' : 'pointer' }}>
                    {anyUploading || voiceState === 'transcribing' ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <SendHorizontal className="w-[18px] h-[18px]" strokeWidth={2.4} />
                    )}
                  </button>
                )
              })()}
            </div>
            <div className="px-3 pb-3 pt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
              草稿自动保存 · Enter 发送 · Shift+Enter 换行 · Ctrl/⌘+V 粘贴文件
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 items-stretch gap-1.5 px-1">
            {isPlanningSession ? null : (
              <>
                <button
                  type="button"
                  onClick={() => setFileChangesOpen(true)}
                  disabled={!sessionId}
                  title="查看当前session所有文件修改"
                  className="min-h-9 h-full w-full rounded-lg border px-2 py-2 text-center text-[12px] leading-snug transition-colors hover:bg-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
                  style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color-strong)' }}>
                  <FileDiff className="h-3.5 w-3.5 flex-shrink-0 text-blue-400" strokeWidth={1.9} />
                  <span className="min-w-0 whitespace-nowrap">查看文件修改</span>
                </button>
                <button
                  type="button"
                  onClick={() => setBashCommandsOpen(true)}
                  disabled={!sessionId}
                  title="查看当前session运行的所有Bash命令"
                  className="min-h-9 h-full w-full rounded-lg border px-2 py-2 text-center text-[12px] leading-snug transition-colors hover:bg-emerald-500/10 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
                  style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color-strong)' }}>
                  <Terminal className="h-3.5 w-3.5 flex-shrink-0 text-emerald-400" strokeWidth={1.9} />
                  <span className="min-w-0 whitespace-nowrap">查看运行命令</span>
                </button>
                {currentProjectId && (
                  <ProjectPortEntryButton
                    projectId={currentProjectId}
                    subPath={currentVscodeSubPath}
                    label="进入项目端口"
                    className="min-h-9 h-full w-full rounded-lg border border-[var(--border-color-strong)] px-2 py-2 text-center text-[12px] leading-snug text-[var(--text-secondary)] transition-colors hover:bg-emerald-500/10 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                    onRequestRunProject={sendRunProjectPortPrompt}
                  />
                )}
                <button
                  type="button"
                  onClick={requestPredictedNextQuestions}
                  disabled={!sessionId || nextQuestionLoading}
                  title="智能下一个用户提问"
                  className="min-h-9 h-full w-full rounded-lg border border-[var(--border-color-strong)] px-2 py-2 text-center text-[12px] leading-snug text-[var(--text-secondary)] transition-colors hover:bg-cyan-500/10 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
                >
                  {nextQuestionLoading ? (
                    <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-cyan-400" strokeWidth={1.9} />
                  ) : (
                    <Bot className="h-3.5 w-3.5 flex-shrink-0 text-cyan-400" strokeWidth={1.9} />
                  )}
                  <span className="min-w-0 whitespace-nowrap">智能下个提问</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
          {/* Skill / Memory 编辑区: 滚动. 同 SessionStartModal 判定: message_count>0 或 已有 ui 消息 → 锁定.
              规划模式下用 PlanningEditor 替代 SkillMemoryEditor, 直接编辑 project_knowledge.md. */}
          <div className="flex-1 overflow-y-auto p-3">
            {isPlanningSession && currentProjectId ? (
              <PlanningEditor projectId={currentProjectId} sessionId={sessionId} />
            ) : (
              <SessionSkillMemoryEditor
                sessionId={currentSession?.session_id || sessionId}
              />
            )}
          </div>
        </div>
      </div>

      {inputExpanded && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            aria-label="关闭长文本编辑"
            onClick={() => setInputExpanded(false)}
          />
          <div
            className="relative flex h-[min(760px,calc(100vh-32px))] w-[min(920px,calc(100vw-32px))] flex-col rounded-2xl p-4 shadow-2xl"
            style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
            onClick={event => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>长文本编辑</h3>
              <button
                type="button"
                onClick={() => setInputExpanded(false)}
                title="收起编辑区"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition-colors hover:bg-[var(--bg-card-hover)]"
                style={{ color: 'var(--text-secondary)', borderColor: 'var(--input-border)' }}
              >
                <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                收起
              </button>
            </div>
            <textarea
              ref={expandedInputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  setInputExpanded(false)
                  send()
                }
              }}
              onPaste={handlePaste}
              placeholder={inputPlaceholder}
              className="min-h-0 flex-1 w-full resize-none rounded-xl px-3 py-2 text-[13px] leading-relaxed placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
              style={{
                background: 'var(--input-bg)',
                border: '1px solid var(--input-border)',
                color: 'var(--text-primary)',
              }}
            />
	            <div className="mt-2 flex items-center justify-between gap-2">
	              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
	                Enter 发送 · Shift+Enter 换行 · Esc 收起
	              </span>
	              <div className="flex items-center gap-1.5">
	                <button
	                  type="button"
	                  onClick={toggleVoiceRecording}
	                  disabled={messageSubmitting || voiceState === 'transcribing'}
	                  title={voiceTip}
	                  aria-label={voiceTip}
	                  aria-pressed={voiceState === 'recording'}
	                  className={`assistant-session-input__utility assistant-session-input__voice assistant-session-input__voice--${voiceState} disabled:opacity-40 disabled:cursor-not-allowed`}
	                >
	                  {voiceState === 'recording' ? (
	                    <Square className="w-[17px] h-[17px]" fill="currentColor" />
	                  ) : voiceState === 'transcribing' ? (
	                    <RefreshCw className="w-[17px] h-[17px] animate-spin" />
	                  ) : (
	                    <Mic className="w-[17px] h-[17px]" />
	                  )}
	                </button>
	                <button
	                  type="button"
	                  onClick={() => {
	                    setInputExpanded(false)
	                    send()
	                  }}
	                  disabled={(!input.trim() && attachments.filter(a => a.status === 'done').length === 0) || anyUploading || !!pendingSendAt || messageSubmitting || voiceBusy}
	                  title={voiceBusy ? voiceTip : '发送'}
	                  aria-label="发送"
	                  className="assistant-session-input__send disabled:opacity-40 disabled:cursor-not-allowed"
	                >
	                  {anyUploading || voiceState === 'transcribing' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <SendHorizontal className="w-4 h-4" />}
	                </button>
	              </div>
	            </div>
          </div>
        </div>
      )}

      {inputReplayOpen && sessionId && (
        <SessionInputReplayModal
          sessionId={sessionId}
          onPick={applyReplayedInput}
          onClose={() => setInputReplayOpen(false)}
        />
      )}

      {fileChangesOpen && sessionId && (
        <SessionFileChangesModal
          sessionId={sessionId}
          onClose={() => setFileChangesOpen(false)}
        />
      )}

      {bashCommandsOpen && sessionId && (
        <SessionBashCommandsModal
          sessionId={sessionId}
          onClose={() => setBashCommandsOpen(false)}
        />
      )}

      {compactConfirmOpen && (
        <CompactContextConfirmModal
          onConfirm={sendCompactCommand}
          onClose={() => setCompactConfirmOpen(false)}
        />
      )}

      {continueModalOpen && currentSession?.session_id && (currentIssueId || !!(currentSession as any)?.research_id) && (
        <NewSessionModal
          issueId={currentIssueId || undefined}
          researchId={(currentSession as any)?.research_id || undefined}
          onClose={() => setContinueModalOpen(false)}
          onCreated={handleContinueSessionCreated}
          defaultName={continueSessionName(currentSession)}
          defaultDescription={(currentSession as any).description || ''}
          defaultModel={projectForSession?.default_model ?? null}
          projectKind={projectForSession?.kind}
          modalTitle="修改模型并继续"
          continueFromSessionId={currentSession.session_id}
          modalZIndexClass="z-[70]"
        />
      )}

      {showRaw && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-[90vw] max-w-[1100px] h-[85vh] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
            <div className="px-5 py-3 border-b flex items-center gap-3 flex-shrink-0" style={{ borderColor: 'var(--border-color)' }}>
              <span className="text-[14px] font-semibold flex-1 min-w-0 flex items-baseline gap-2" style={{ color: 'var(--text-primary)' }}>
                <span className="flex-shrink-0">原始 JSONL <span className="text-[11px] font-normal ml-1" style={{ color: 'var(--text-muted)' }}>· {jsonlEntries.length} 条</span></span>
                {jsonlPath && (
                  <span className="text-[11px] font-mono truncate" style={{ color: 'var(--text-muted)' }} title={jsonlPath}>{jsonlPath}</span>
                )}
              </span>
              <button onClick={async () => {
                  // 复制全部前必须确保拿到完整 entries: 后端 SSE 默认只回灌末尾 200 条,
                  // 且 REST 单次最多 5000 条. 这里分页拉满全量, 不省略不截断.
                  try {
                    const sid = currentSession?.session_id || currentTask?.task_id
                    let entriesToCopy = jsonlEntries
                    if (sid && jsonlTotal > jsonlEntries.length) {
                      const collected: any[] = []
                      let from = 0
                      const pageSize = 5000
                      let total = jsonlTotal
                      while (from < total) {
                        const data = await api(`/api/sessions/${sid}/jsonl-history?from=${from}&limit=${pageSize}`)
                        const slice = Array.isArray(data?.entries) ? data.entries : []
                        if (slice.length === 0) break
                        collected.push(...slice)
                        from += slice.length
                        if (Number.isFinite(Number(data?.total))) total = Number(data.total)
                        if (slice.length < pageSize) break
                      }
                      if (collected.length > 0) {
                        const activeSid = useStore.getState().currentSession?.session_id || useStore.getState().currentTask?.task_id
                        if (sid === activeSid) {
                          entriesToCopy = collected
                          setJsonlEntries(collected)
                          if (collected.length === total) setJsonlTotal(total)
                        }
                      }
                    }
                    await navigator.clipboard.writeText(entriesToCopy.map(e => JSON.stringify(e)).join('\n'))
                  } catch {}
                }}
                className="h-7 px-2.5 text-[11px] rounded-md border border-[var(--border-color-strong)] hover:bg-[var(--bg-card-hover)] transition-colors"
                style={{ color: 'var(--text-secondary)' }}
                title="复制全部 JSONL 到剪贴板">复制全部</button>
              <button onClick={() => setShowRaw(false)}
                className="h-7 px-2.5 text-[11px] rounded-md border border-[var(--border-color-strong)] hover:bg-[var(--bg-card-hover)] transition-colors"
                style={{ color: 'var(--text-secondary)' }}>关闭</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {jsonlEntries.length === 0 ? (
                <div className="text-center text-[13px] py-8" style={{ color: 'var(--text-muted)' }}>暂无 JSONL 数据 (session 尚未产生输出)</div>
              ) : (
                <pre className="text-[11px] leading-relaxed p-5 m-0 whitespace-pre font-mono select-text"
                  style={{ color: 'var(--text-secondary)' }}>
                  {jsonlEntries.map((e, i) => `// #${i + 1}\n${JSON.stringify(e, null, 2)}`).join('\n\n')}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Session 尚未开始时弹出的"是否开始执行?"确认窗.
          多重门禁防止打开瞬间闪烁:
            1. historyLoaded=true: 必须等 bootstrap history 或 SSE history 至少成功返回一次, 否则连"是否为空"都还不知道.
            2. message_count===0: 元数据上确认这个 session 从未产生过消息.
            3. messages.length===0 && !typing && !stream: 本地视图当下也确实是空白态.
            4. 用户尚未在本次浏览中 dismiss 过. */}
      {currentSession
        && historyLoaded
        && ((currentSession as any).message_count || 0) === 0
        && messages.length === 0
        && !streamContent && !isTyping
        && !isFireAndForgetSession(sessionId)
        && sessionId && !startDismissed.has(sessionId) && (
        <SessionStartModal
          sessionName={currentSession.name}
          sessionDescription={(currentSession as any).description || ''}
          autoConfirm={!isGuidedDemoSession(sessionId)}
          onConfirm={async () => {
            // 抛错由 modal 内部 catch 后显示, 这里只在成功时 dismiss
            await startSession()
            dismissStartModal(sessionId)
          }}
          onDismiss={() => dismissStartModal(sessionId)}
        />
      )}
    </div>
  )
}
