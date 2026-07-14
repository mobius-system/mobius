import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, ComponentPropsWithoutRef, CSSProperties, DragEvent as ReactDragEvent, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, Archive, BookOpen, ChevronsLeft, ChevronsRight, Eraser, ExternalLink, FilePlus2, Maximize2, Mic, Minimize2, RefreshCw, SendHorizontal, Settings, Square, Trash2, UserPlus, Volume2, VolumeX, X } from 'lucide-react'
import { api, useStore } from '../store'
import { AssistantPresetModal } from './assistant-preset-modal'
import { draftClear, draftLoad, draftSave } from '../services/input-drafts'
import {
  hasVoiceCommand,
  formatVoiceSeconds,
  permissionErrorMessage,
  recordingFileExtension,
  supportedVoiceMimeType,
  splitVoiceTextForSpeech,
  stripVoiceCommands,
  voiceTextForMessage,
  type VoiceInputState,
  type VoicePlaybackMode,
  type VoiceTranscribeResponse,
  VOICE_RECORDING_MAX_MS,
} from '../services/assistant-voice'

// =====================================================================
// AssistantChat — 小莫轻量助手
// 首次提问创建用户的小莫 Session；追问沿用该 Session。界面只展示
// 用户输入和该 Session jsonl 中的 assistant response 文本。
// =====================================================================

const ASSISTANT_NAME = '小莫'
const MO_PARTICLES = Array.from({ length: 18 }, (_, i) => i + 1)
const MIN_PANEL_WIDTH = 320
const MIN_PANEL_HEIGHT = 280
const HISTORY_LIMIT = 80
const ASSISTANT_CLEAR_STORAGE_PREFIX = 'assistant-clear-cutoffs'
const ASSISTANT_FAB_VOICE_HOLD_MS = 1500
// 小莫 FAB 可拖动 + 吸附到视口角落
const ASSISTANT_FAB_SIZE = 56 // w-14 h-14
const ASSISTANT_FAB_EDGE_MARGIN = 20 // 与视口边缘留白 (1.25rem)
const ASSISTANT_FAB_DRAG_THRESHOLD = 6 // 超过该位移视为拖动而非点击
const ASSISTANT_FAB_POS_STORAGE_KEY = 'mobius-assistant-fab-pos'
const AUTO_VOICE_CURSOR_STORAGE_PREFIX = 'assistant-auto-voice-cursor'
const SHARED_VOICE_PLAYBACK_LOCK_PREFIX = 'assistant-voice-playback-lock'
const SHARED_VOICE_PLAYBACK_CHANNEL_PREFIX = 'assistant-voice-playback'
const VOICE_PLAYBACK_MODE_STORAGE_PREFIX = 'assistant-tts-playback-mode'
const SHARED_VOICE_PLAYBACK_LOCK_TTL_MS = 180_000
const SHARED_VOICE_PLAYBACK_LOCK_REFRESH_MS = 20_000
const MAIN_ASSISTANT_SESSION_NAME = '我的主小莫'
const ASSISTANT_CLONE_SESSION_PREFIX = '分身小莫 #'
const ASSISTANT_ATTACHMENT_MAX_COUNT = 6
const ASSISTANT_FILE_MAX_BYTES = 25 * 1024 * 1024
const ASSISTANT_IMAGE_MAX_BYTES = 10 * 1024 * 1024
const ASSISTANT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const ASSISTANT_INPUT_DRAFT_SAVE_DELAY_MS = 300
const ASSISTANT_INTERNAL_NOTIFICATION_PROMPT_PREFIX = '[[mobius:assistant-internal-notification-prompt]]'
const LEGACY_ASSISTANT_INTERNAL_NOTIFICATION_MARKERS = [
  '请你撰写消息通知用户',
  '请你撰写消息通知当前管理员',
]

type PanelInteraction = {
  type: 'drag' | 'resize'
  startX: number
  startY: number
  startLeft: number
  startTop: number
  startWidth: number
  startHeight: number
  edges: { n: boolean; s: boolean; e: boolean; w: boolean }
}

type AssistantPanelSize = 'compact' | 'expanded' | 'fullscreen'

function nextAssistantPanelSize(size: AssistantPanelSize): AssistantPanelSize {
  if (size === 'compact') return 'expanded'
  if (size === 'expanded') return 'fullscreen'
  return 'compact'
}

type AssistantResponse = {
  id: string
  content: string
  created_at?: string | null
  source_type?: string
}

type AssistantConversationMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at?: string | null
  turn_number?: number | null
  response_index?: number
}

type RenderedAssistantConversationMessage = AssistantConversationMessage & {
  render_id: string
}

type PendingAssistantTurn = {
  id: string
  request_id: string
  content: string
  created_at: string
  session_id: string | null
  baseline_response_count: number
  show_user: boolean
  failed?: boolean
}

type SendContentOptions = {
  showUser?: boolean
  attachments?: AssistantPromptAttachment[]
}

type AssistantAttachmentStatus = 'uploading' | 'done' | 'error'

type AssistantAttachment = {
  id: string
  name: string
  size: number
  kind: 'image' | 'file'
  type: string
  previewUrl: string
  status: AssistantAttachmentStatus
  remotePath?: string
  error?: string
}

type AssistantImagePreview = {
  id: string
  name: string
  src: string
}

type AssistantPromptAttachment = {
  type: 'image' | 'file'
  path: string
  name?: string
  size?: number
  mime_type?: string
}
type VoicePlaybackState = 'idle' | 'loading' | 'playing' | 'error'
type CollapsedVoiceHoldState = 'idle' | 'holding' | 'recording'

type AutoVoiceCandidate = {
  id: string
  sessionId: string
  text: string
  createdAt: string
  createdMs: number
}

type AutoVoiceCursorEntry = {
  lastSpokenAt: string
  lastSpokenMs: number
  lastSpokenId: string
}

type SharedVoicePlaybackLock = {
  ownerId: string
  messageId: string
  updatedAt: number
  expiresAt: number
}

type SharedVoicePlaybackEvent = {
  type: 'started' | 'stopped'
  ownerId: string
  messageId: string
  at: number
}

type AssistantVoiceOption = {
  id: string
  label: string
  language?: string
  gender?: string
  category?: string
  description?: string
  default?: boolean
}

type SessionModelOption = {
  key: string
  value?: string
  model?: string
  label: string
  title?: string
  sub?: string
  backend?: string
  imported?: boolean
}

type CloneDraft = {
  task: string
  model: string
  language: 'zh' | 'en'
}

type AssistantSnapshot = {
  ok?: boolean
  request_id?: string
  project?: any
  issue?: any
  session: {
    session_id: string
    name: string
    project_id?: string | null
    issue_id?: string | null
    assistant_role?: 'main' | 'clone' | string
    model?: string
    model_label?: string
    created_at?: string
    last_active?: string
  }
  question: {
    content: string
    created_at?: string | null
  }
  messages?: AssistantConversationMessage[]
  responses: AssistantResponse[]
  status?: {
    alive?: boolean
    working?: boolean
    failed?: boolean
    agent_status?: string
  }
  job_accomplished?: boolean | null
  jsonl?: {
    total?: number
    total_approximate?: boolean
    truncated?: boolean
    response_count?: number
  }
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm]
const MARKDOWN_REHYPE_PLUGINS = [rehypeHighlight as any]
const DEFAULT_ASSISTANT_TTS_VOICE = 'zh_female_vv_uranus_bigtts'
const ASSISTANT_TTS_VOICE_FALLBACK: AssistantVoiceOption[] = [
  { id: 'zh_female_vv_uranus_bigtts', label: 'vivi 2.0', language: 'zh-CN', gender: 'female', category: 'general', description: '自然清亮的通用女声', default: true },
  { id: 'zh_female_xiaohe_uranus_bigtts', label: '小何', language: 'zh-CN', gender: 'female', category: 'general', description: '温和耐听的通用女声' },
  { id: 'zh_male_m191_uranus_bigtts', label: '云舟', language: 'zh-CN', gender: 'male', category: 'general', description: '稳重清晰的通用男声' },
  { id: 'zh_male_taocheng_uranus_bigtts', label: '小天', language: 'zh-CN', gender: 'male', category: 'general', description: '明快自然的通用男声' },
  { id: 'saturn_zh_female_cancan_tob', label: '知性灿灿', language: 'zh-CN', gender: 'female', category: 'role', description: '偏知性表达的角色女声' },
  { id: 'saturn_zh_female_keainvsheng_tob', label: '可爱女生', language: 'zh-CN', gender: 'female', category: 'role', description: '轻快活泼的角色女声' },
  { id: 'saturn_zh_female_tiaopigongzhu_tob', label: '调皮公主', language: 'zh-CN', gender: 'female', category: 'role', description: '更有角色感的俏皮女声' },
  { id: 'saturn_zh_male_shuanglangshaonian_tob', label: '爽朗少年', language: 'zh-CN', gender: 'male', category: 'role', description: '明亮爽朗的少年音色' },
  { id: 'saturn_zh_male_tiancaitongzhuo_tob', label: '天才同桌', language: 'zh-CN', gender: 'male', category: 'role', description: '偏年轻化的角色男声' },
  { id: 'en_male_tim_uranus_bigtts', label: 'Tim', language: 'en-US', gender: 'male', category: 'general', description: '英文通用男声' },
]

const FALLBACK_CLONE_MODEL_OPTIONS: SessionModelOption[] = [
  { key: 'codex', label: 'GPT-5.5 (Codex)', title: 'GPT-5.5 (Codex)', sub: '默认代码任务模型', backend: 'tmux-codex' },
]

function MarkdownAnchor({ href, children, node: _node, ...props }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  return (
    <a
      {...props}
      href={href}
      target={href ? '_blank' : undefined}
      rel={href ? 'noreferrer' : undefined}
    >
      {children}
    </a>
  )
}

const AssistantMarkdown = memo(function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="assistant-session-message__content prose-chat">
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS as any}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={{ a: MarkdownAnchor as any }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})

function visibleContentForMessage(content: string) {
  const stripped = stripVoiceCommands(content)
  return stripped
}

function stableVoiceHash(raw: string) {
  let hash = 0x811c9dc5
  const text = String(raw || '')
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

function autoVoiceMessageKey(sessionId: string, message: AssistantConversationMessage, voiceText = voiceTextForMessage(message.content)) {
  const fallbackOrder = [
    typeof message.response_index === 'number' ? `r${message.response_index}` : '',
    typeof message.turn_number === 'number' ? `t${message.turn_number}` : '',
    message.id,
  ].filter(Boolean).join(':')
  const identity = [
    sessionId,
    message.created_at || '',
    fallbackOrder,
    voiceText || message.content,
  ].join('\n')
  return `${sessionId}:voice:${stableVoiceHash(identity)}`
}

function normalizeVoiceOptions(value: unknown) {
  const arr = Array.isArray(value) ? value : []
  const options = arr
    .map((item: any) => ({
      id: String(item?.id || '').trim(),
      label: String(item?.label || item?.id || '').trim(),
      language: typeof item?.language === 'string' ? item.language : undefined,
      gender: typeof item?.gender === 'string' ? item.gender : undefined,
      category: typeof item?.category === 'string' ? item.category : undefined,
      description: typeof item?.description === 'string' ? item.description : undefined,
      default: !!item?.default,
    }))
    .filter(option => option.id && option.label)
  return options.length > 0 ? options : ASSISTANT_TTS_VOICE_FALLBACK
}

function voiceOptionTitle(option: AssistantVoiceOption) {
  return [option.label, option.description].filter(Boolean).join(' - ')
}

function makeAssistantAttachmentId() {
  return `assistant-att-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function formatAssistantFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isSupportedAssistantImage(file: File) {
  const type = String(file.type || '').toLowerCase()
  if (ASSISTANT_IMAGE_MIME_TYPES.has(type)) return true
  const name = String(file.name || '').toLowerCase()
  return /\.(png|jpe?g|webp|gif)$/.test(name)
}

function assistantAttachmentKindOf(file: File): 'image' | 'file' {
  return isSupportedAssistantImage(file) ? 'image' : 'file'
}

function assistantAttachmentUploadError(file: File) {
  const kind = assistantAttachmentKindOf(file)
  if (kind === 'image' && file.size > ASSISTANT_IMAGE_MAX_BYTES) return '图片不能超过 10MB'
  if (kind === 'file' && file.size > ASSISTANT_FILE_MAX_BYTES) return '文件不能超过 25MB'
  return ''
}

function assistantFileExtBadge(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (!ext || ext === name.toLowerCase()) return 'FILE'
  return ext.slice(0, 5).toUpperCase()
}

async function uploadAssistantAttachment(file: File, projectId?: string): Promise<{ path: string; name: string; size: number }> {
  const form = new FormData()
  form.append('file', file, file.name || 'file')
  const url = projectId ? `/api/upload?project_id=${encodeURIComponent(projectId)}` : '/api/upload'
  const data = await api(url, {
    method: 'POST',
    body: form,
  }) as { path?: string; name?: string; size?: number }
  const remotePath = String(data?.path || '').trim()
  if (!remotePath) throw new Error('附件上传失败：后端未返回路径')
  return {
    path: remotePath,
    name: String(data?.name || file.name || 'file'),
    size: Number(data?.size) || file.size || 0,
  }
}

function AssistantAttachmentChip({
  attachment,
  onRemove,
  onPreview,
}: {
  attachment: AssistantAttachment
  onRemove: () => void
  onPreview: (preview: AssistantImagePreview) => void
}) {
  const uploading = attachment.status === 'uploading'
  const failed = attachment.status === 'error'
  const isImage = attachment.kind === 'image' && attachment.previewUrl
  return (
    <div className="assistant-attachment-chip" title={failed ? attachment.error || attachment.name : attachment.name}>
      {isImage ? (
        <button
          type="button"
          className="assistant-attachment-chip__preview"
          aria-label={`预览图片 ${attachment.name}`}
          onClick={() => onPreview({ id: attachment.id, name: attachment.name, src: attachment.previewUrl })}
        >
          <img src={attachment.previewUrl} alt={attachment.name} />
          {uploading ? (
            <span className="assistant-attachment-chip__overlay">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            </span>
          ) : null}
          {failed ? <span className="assistant-attachment-chip__error">失败</span> : null}
        </button>
      ) : (
        <div className="assistant-attachment-chip__preview assistant-attachment-chip__preview--file" aria-hidden="true">
          <span>{assistantFileExtBadge(attachment.name)}</span>
          {uploading ? (
            <span className="assistant-attachment-chip__overlay">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            </span>
          ) : null}
          {failed ? <span className="assistant-attachment-chip__error">失败</span> : null}
        </div>
      )}
      <div className="assistant-attachment-chip__meta">
        <span className="assistant-attachment-chip__name">{attachment.name}</span>
        <span className="assistant-attachment-chip__size">
          {failed ? attachment.error || '上传失败' : formatAssistantFileSize(attachment.size)}
        </span>
      </div>
      <button
        type="button"
        className="assistant-attachment-chip__remove"
        aria-label={`移除附件 ${attachment.name}`}
        onClick={onRemove}
      >
        <X className="h-3 w-3" strokeWidth={2.4} />
      </button>
    </div>
  )
}

function AssistantImagePreviewModal({ preview, onClose }: { preview: AssistantImagePreview; onClose: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="assistant-image-preview-modal" role="dialog" aria-modal="true" aria-label={`图片预览 ${preview.name}`}>
      <button type="button" className="assistant-image-preview-modal__backdrop" aria-label="关闭图片预览" onClick={onClose} />
      <div className="assistant-image-preview-modal__header">
        <span>{preview.name}</span>
        <button type="button" aria-label="关闭" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="assistant-image-preview-modal__body">
        <img src={preview.src} alt={preview.name} />
      </div>
    </div>
  )
}

function readStoredVoicePlaybackEnabled(storageKey: string) {
  try {
    const raw = localStorage.getItem(storageKey)
    return raw === '1' || raw === 'true'
  } catch {
    return false
  }
}

function writeStoredVoicePlaybackEnabled(storageKey: string, enabled: boolean) {
  try {
    localStorage.setItem(storageKey, enabled ? '1' : '0')
  } catch {
    /* Browser preference persistence should not block voice playback. */
  }
}

function normalizeVoicePlaybackMode(value: unknown): VoicePlaybackMode {
  return String(value || '').trim() === 'all' ? 'all' : 'selected'
}

function readStoredVoicePlaybackMode(storageKey: string): VoicePlaybackMode {
  try {
    return normalizeVoicePlaybackMode(localStorage.getItem(storageKey))
  } catch {
    return 'selected'
  }
}

function writeStoredVoicePlaybackMode(storageKey: string, mode: VoicePlaybackMode) {
  try {
    localStorage.setItem(storageKey, mode)
  } catch {
    /* Browser preference persistence should not block voice playback. */
  }
}

function readStoredAutoVoiceCursors(storageKey: string): Record<string, AutoVoiceCursorEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([sessionId, raw]) => {
          const item = raw && typeof raw === 'object' ? raw as any : {}
          const lastSpokenMs = Number(item.lastSpokenMs)
          const lastSpokenAt = typeof item.lastSpokenAt === 'string' ? item.lastSpokenAt : ''
          const lastSpokenId = typeof item.lastSpokenId === 'string' ? item.lastSpokenId : ''
          if (!sessionId || !Number.isFinite(lastSpokenMs) || lastSpokenMs <= 0 || !lastSpokenAt) return null
          return [sessionId, { lastSpokenAt, lastSpokenMs, lastSpokenId }] as const
        })
        .filter((entry): entry is readonly [string, AutoVoiceCursorEntry] => !!entry),
    )
  } catch {
    return {}
  }
}

function writeStoredAutoVoiceCursors(storageKey: string, cursors: Record<string, AutoVoiceCursorEntry>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(cursors))
  } catch {
    /* Best-effort cursor persistence; playback should continue if storage is full. */
  }
}

function assistantAutoVoiceCursorStorageKey(userId?: string | null) {
  return userId ? `${AUTO_VOICE_CURSOR_STORAGE_PREFIX}:${userId}` : AUTO_VOICE_CURSOR_STORAGE_PREFIX
}

function assistantSharedVoiceLockStorageKey(userId?: string | null) {
  return userId ? `${SHARED_VOICE_PLAYBACK_LOCK_PREFIX}:${userId}` : SHARED_VOICE_PLAYBACK_LOCK_PREFIX
}

function assistantSharedVoiceChannelName(userId?: string | null) {
  return userId ? `${SHARED_VOICE_PLAYBACK_CHANNEL_PREFIX}:${userId}` : SHARED_VOICE_PLAYBACK_CHANNEL_PREFIX
}

function assistantVoicePlaybackModeStorageKey(userId?: string | null) {
  return userId ? `${VOICE_PLAYBACK_MODE_STORAGE_PREFIX}:${userId}` : VOICE_PLAYBACK_MODE_STORAGE_PREFIX
}

function createAssistantTabId() {
  try {
    const cryptoApi = globalThis.crypto
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  } catch {
    /* Fall back to timestamp + Math.random below. */
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function readSharedVoicePlaybackLock(storageKey: string): SharedVoicePlaybackLock | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || 'null')
    if (!parsed || typeof parsed !== 'object') return null
    const ownerId = typeof parsed.ownerId === 'string' ? parsed.ownerId : ''
    const messageId = typeof parsed.messageId === 'string' ? parsed.messageId : ''
    const updatedAt = Number(parsed.updatedAt)
    const expiresAt = Number(parsed.expiresAt)
    if (!ownerId || !messageId || !Number.isFinite(updatedAt) || !Number.isFinite(expiresAt)) return null
    return { ownerId, messageId, updatedAt, expiresAt }
  } catch {
    return null
  }
}

function writeSharedVoicePlaybackLock(storageKey: string, lock: SharedVoicePlaybackLock) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(lock))
  } catch {
    /* Cross-tab coordination is best effort; local playback can still work. */
  }
}

function removeSharedVoicePlaybackLock(storageKey: string, ownerId?: string, messageId?: string) {
  try {
    const existing = readSharedVoicePlaybackLock(storageKey)
    if (ownerId && existing && existing.ownerId !== ownerId) return
    if (messageId && existing && existing.messageId !== messageId) return
    localStorage.removeItem(storageKey)
  } catch {
    /* Ignore storage cleanup errors. */
  }
}

async function fetchAssistantSpeech(text: string, voice: string, signal?: AbortSignal) {
  const token = localStorage.getItem('cc-token') || ''
  const res = await fetch('/api/assistant/speak', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text, voice }),
  })
  if (res.status === 401) {
    localStorage.removeItem('cc-token')
    window.location.href = '/'
    throw new Error('Unauthorized')
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.error || `HTTP ${res.status}`)
  }
  return res.blob()
}

function MoAvatar({ size = 'lg', active = false, lite = false }: { size?: 'sm' | 'lg'; active?: boolean; lite?: boolean }) {
  // lite 版用于消息列表：每条消息一个头像，若保留 18 个无限动画粒子 + filter/box-shadow
  // 关键帧动画会持续触发重绘，在长会话滚动时严重掉帧。lite 只渲染静态渐变球。
  if (lite) {
    return (
      <span className={`mo-avatar mo-avatar--${size} mo-avatar--lite`} aria-hidden="true">
        <span className="mo-avatar__field" />
        <span className="mo-avatar__core" />
      </span>
    )
  }
  return (
    <span
      className={`mo-avatar mo-avatar--${size}${active ? ' mo-avatar--active' : ''}`}
      aria-hidden="true"
    >
      <span className="mo-avatar__field" />
      <span className="mo-avatar__ring mo-avatar__ring--outer" />
      <span className="mo-avatar__ring mo-avatar__ring--inner" />
      <span className="mo-avatar__core" />
      {MO_PARTICLES.map(n => (
        <span key={n} className={`mo-avatar__particle mo-avatar__particle--${n}`} />
      ))}
    </span>
  )
}

function AssistantTooltip({
  label,
  align = 'center',
  side = 'bottom',
  children,
}: {
  label: string
  align?: 'left' | 'center' | 'right'
  side?: 'top' | 'bottom'
  children: ReactNode
}) {
  const tooltipRef = useRef<HTMLSpanElement | null>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [visible, setVisible] = useState(false)

  const updatePosition = useCallback(() => {
    const node = tooltipRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const x = align === 'left'
      ? rect.left
      : align === 'right'
        ? rect.right
        : rect.left + rect.width / 2
    const y = side === 'top' ? rect.top - 8 : rect.bottom + 8
    setPosition({ x, y })
  }, [align, side])

  useEffect(() => {
    if (!visible) return
    updatePosition()
    const handleUpdate = () => updatePosition()
    window.addEventListener('resize', handleUpdate)
    window.addEventListener('scroll', handleUpdate, true)
    return () => {
      window.removeEventListener('resize', handleUpdate)
      window.removeEventListener('scroll', handleUpdate, true)
    }
  }, [visible, updatePosition])

  const tooltipStyle = position
    ? ({
        '--assistant-tooltip-x': `${position.x}px`,
        '--assistant-tooltip-y': `${position.y}px`,
      } as CSSProperties)
    : undefined

  return (
    <span
      ref={tooltipRef}
      className="assistant-tooltip"
      data-align={align}
      data-side={side}
      data-visible={visible ? 'true' : 'false'}
      onMouseEnter={() => {
        updatePosition()
        setVisible(true)
      }}
      onMouseLeave={() => setVisible(false)}
      onFocusCapture={() => {
        updatePosition()
        setVisible(true)
      }}
      onBlurCapture={() => setVisible(false)}
    >
      {children}
      {typeof document === 'undefined'
        ? null
        : createPortal(
            <span
              className="assistant-tooltip__bubble"
              role="tooltip"
              data-align={align}
              data-side={side}
              data-visible={visible ? 'true' : 'false'}
              style={tooltipStyle}
            >
              {label}
            </span>,
            document.body,
          )}
    </span>
  )
}

function clampPanelRect(left: number, top: number, width: number, height: number) {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const nextWidth = Math.max(MIN_PANEL_WIDTH, Math.min(width, viewportWidth))
  const nextHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(height, viewportHeight))
  return {
    left: Math.max(0, Math.min(viewportWidth - nextWidth, left)),
    top: Math.max(0, Math.min(viewportHeight - nextHeight, top)),
    width: nextWidth,
    height: nextHeight,
  }
}

function assistantFabMinTop() {
  const isDesktop = typeof window !== 'undefined' && !!(window as { mobiusDesktop?: { isDesktop?: boolean } }).mobiusDesktop?.isDesktop
  return isDesktop ? 64 : ASSISTANT_FAB_EDGE_MARGIN
}

// 把 FAB 吸附到左/右边缘, 纵向保留拖动落点。桌面端保留标题栏点击区, 不允许吸到顶角盖住窗口按钮。
function snapFabToEdge(left: number, top: number) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const margin = ASSISTANT_FAB_EDGE_MARGIN
  const size = ASSISTANT_FAB_SIZE
  const cx = left + size / 2
  const finalLeft = cx <= vw - cx ? margin : vw - size - margin
  const minTop = assistantFabMinTop()
  const maxTop = Math.max(minTop, vh - size - margin)
  return { left: finalLeft, top: Math.max(minTop, Math.min(maxTop, top)) }
}

function readFabPos(): { left: number; top: number } | null {
  try {
    const raw = window.localStorage.getItem(ASSISTANT_FAB_POS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { left?: unknown; top?: unknown }
    const left = Number(parsed.left)
    const top = Number(parsed.top)
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null
    return { left, top }
  } catch {
    return null
  }
}

function writeFabPos(pos: { left: number; top: number } | null) {
  try {
    if (pos) window.localStorage.setItem(ASSISTANT_FAB_POS_STORAGE_KEY, JSON.stringify(pos))
    else window.localStorage.removeItem(ASSISTANT_FAB_POS_STORAGE_KEY)
  } catch {
    /* localStorage 不可用时静默退化到默认位置 */
  }
}

function mergeSnapshot(items: AssistantSnapshot[], snapshot: AssistantSnapshot) {
  const sessionId = snapshot?.session?.session_id
  if (!sessionId) return items
  const index = items.findIndex(item => item.session?.session_id === sessionId)
  if (index < 0) return sortAssistantSnapshots([...items, snapshot])
  const next = items.slice()
  next[index] = snapshot
  return sortAssistantSnapshots(next)
}

function assistantSnapshotRole(snapshot?: AssistantSnapshot | null) {
  const session = snapshot?.session
  if (!session) return 'clone'
  if (session.assistant_role === 'main' || session.name === MAIN_ASSISTANT_SESSION_NAME) return 'main'
  if (session.assistant_role === 'clone' || session.name.startsWith(ASSISTANT_CLONE_SESSION_PREFIX)) return 'clone'
  return 'main'
}

function assistantSnapshotOrder(snapshot: AssistantSnapshot) {
  if (assistantSnapshotRole(snapshot) === 'main') return 0
  const match = snapshot.session.name.match(/^分身小莫 #(\d+)/)
  if (match) return 100 + Number(match[1])
  const createdMs = Date.parse(snapshot.session.created_at || '')
  return 10_000 + (Number.isFinite(createdMs) ? createdMs : 0)
}

function sortAssistantSnapshots(items: AssistantSnapshot[]) {
  return items.slice().sort((a, b) => {
    const ao = assistantSnapshotOrder(a)
    const bo = assistantSnapshotOrder(b)
    if (ao !== bo) return ao - bo
    const at = Date.parse(a.session.created_at || '')
    const bt = Date.parse(b.session.created_at || '')
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt
    return a.session.session_id.localeCompare(b.session.session_id)
  })
}

function nextAssistantCloneNumber(snapshots: AssistantSnapshot[]) {
  const max = snapshots.reduce((value, snapshot) => {
    const match = snapshot.session.name.match(/^分身小莫 #(\d+)/)
    return match ? Math.max(value, Number(match[1]) || 0) : value
  }, 0)
  return max + 1
}

function summarizeCloneTask(text: string) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim()
  if (!compact) return '新任务'
  return compact.length > 18 ? `${compact.slice(0, 18)}...` : compact
}

function isCloneCompletionCandidate(snapshot: AssistantSnapshot) {
  if (assistantSnapshotRole(snapshot) !== 'clone') return false
  if (snapshot.status?.failed) return true
  if (snapshot.status?.working) return false
  return (snapshot.responses || []).length > 0
}

function latestAssistantVisibleText(snapshot: AssistantSnapshot) {
  const messages = messagesForSnapshot(snapshot).filter(message => message.role === 'assistant')
  const latest = messages[messages.length - 1]
  return latest ? visibleContentForMessage(latest.content).trim() : ''
}

function cloneReportStorageKey(userId?: string | null) {
  return userId ? `assistant-clone-report-cursors:${userId}` : 'assistant-clone-report-cursors'
}

function readCloneReportCursors(storageKey: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => (
        typeof entry[0] === 'string' && typeof entry[1] === 'string'
      )),
    )
  } catch {
    return {}
  }
}

function writeCloneReportCursors(storageKey: string, cursors: Record<string, string>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(cursors))
  } catch {
    /* Clone report dedupe is best effort. */
  }
}

function assistantClearCutoffStorageKey(userId?: string | null) {
  return userId ? `${ASSISTANT_CLEAR_STORAGE_PREFIX}:${userId}` : ''
}

function readAssistantClearCutoffs(storageKey: string): Record<string, string> {
  if (!storageKey) return {}
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

function writeAssistantClearCutoffs(storageKey: string, cutoffs: Record<string, string>) {
  if (!storageKey) return
  try {
    localStorage.setItem(storageKey, JSON.stringify(cutoffs))
  } catch {
    /* Frontend-only cleanup should never block the chat UI. */
  }
}

function isCompactControlMessage(message: { content?: string | null }) {
  return String(message.content || '').trim().startsWith('/compact')
}

function isAssistantInternalUserMessage(message: { role?: string | null, content?: string | null }) {
  if (message.role !== 'user') return false
  const content = String(message.content || '').trim()
  if (!content) return false
  return content.startsWith(ASSISTANT_INTERNAL_NOTIFICATION_PROMPT_PREFIX)
    || LEGACY_ASSISTANT_INTERNAL_NOTIFICATION_MARKERS.some(marker => content.includes(marker))
}

function isAfterClearCutoff(createdAt: string | null | undefined, cutoff: string) {
  if (!cutoff) return true
  if (!createdAt) return false
  const createdMs = Date.parse(createdAt)
  const cutoffMs = Date.parse(cutoff)
  if (!Number.isFinite(createdMs) || !Number.isFinite(cutoffMs)) return false
  return createdMs > cutoffMs
}

function shouldShowConversationMessage(
  message: Pick<AssistantConversationMessage, 'content' | 'created_at'> & { role?: string | null },
  cutoff: string,
) {
  if (isCompactControlMessage(message)) return false
  if (isAssistantInternalUserMessage(message)) return false
  return isAfterClearCutoff(message.created_at, cutoff)
}

function contentBlocksText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block: any) => {
    if (!block || typeof block !== 'object') return String(block ?? '')
    if (block.type && block.type !== 'text' && block.type !== 'output_text') return ''
    if (typeof block.text === 'string') return block.text
    if (typeof block.output_text === 'string') return block.output_text
    return ''
  }).filter(Boolean).join('\n')
}

function assistantTextsFromJsonlEntry(entry: any): string[] {
  if (!entry || typeof entry !== 'object') return []

  if (entry.type === 'assistant') {
    const message = entry.message || {}
    if (message.role && message.role !== 'assistant') return []
    const text = contentBlocksText(message.content).trim()
    return text ? [text] : []
  }

  if (entry.type === 'response_item') {
    const payload = entry.payload || {}
    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = contentBlocksText(payload.content).trim()
      return text ? [text] : []
    }
    if ((payload.type === 'output_text' || payload.type === 'text') && typeof payload.text === 'string') {
      const text = payload.text.trim()
      return text ? [text] : []
    }
  }

  if (entry.role === 'assistant' && typeof entry.content === 'string') {
    const text = entry.content.trim()
    return text ? [text] : []
  }

  return []
}

function assistantResponsesFromJsonlEntries(entries: any[]): AssistantResponse[] {
  const responses: AssistantResponse[] = []
  let previous = ''

  entries.forEach((entry, index) => {
    const texts = assistantTextsFromJsonlEntry(entry)
    texts.forEach(text => {
      const normalized = text.replace(/\s+/g, ' ').trim()
      if (!normalized || normalized === previous) return
      previous = normalized
      responses.push({
        id: `${index}:${responses.length}`,
        content: text,
        created_at: entry?.timestamp || entry?.created_at || entry?.payload?.timestamp || null,
        source_type: entry?.type || 'assistant',
      })
    })
  })

  return responses
}

function conversationMessagesFromResponses(
  snapshot: AssistantSnapshot,
  responses: AssistantResponse[],
): AssistantConversationMessage[] {
  const existingUsers = (snapshot.messages || []).filter(message => message.role === 'user')
  const users = existingUsers.length > 0
    ? existingUsers
    : (snapshot.question.content
        ? [{
            id: `user:${snapshot.session.session_id}:question`,
            role: 'user' as const,
            content: snapshot.question.content,
            created_at: snapshot.question.created_at || snapshot.session.created_at || null,
            turn_number: null,
          }]
        : [])
  const assistant = responses.map((response, index) => ({
    id: `assistant:${response.id}`,
    role: 'assistant' as const,
    content: response.content,
    created_at: response.created_at || null,
    response_index: index,
  }))

  return users.concat(assistant).sort((a, b) => {
    const at = a.created_at ? Date.parse(a.created_at) : NaN
    const bt = b.created_at ? Date.parse(b.created_at) : NaN
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt
    if (a.role !== b.role) return a.role === 'user' ? -1 : 1
    return String(a.id).localeCompare(String(b.id))
  })
}

function isTurnCompleteEntry(entry: any) {
  const stopReason = entry?.message?.stop_reason
  if (entry?.type === 'assistant' && stopReason && stopReason !== 'tool_use') return true
  if (entry?.type === 'event_msg' && entry?.payload?.type === 'task_complete') return true
  return false
}

function isAssistantActivityEntry(entry: any) {
  if (!entry || typeof entry !== 'object' || isTurnCompleteEntry(entry)) return false
  if (entry.type === 'user') return true
  if (entry.type === 'assistant') return true
  if (entry.type === 'event_msg') {
    return ['task_started', 'user_message', 'agent_message'].includes(entry.payload?.type)
  }
  if (entry.type === 'response_item') {
    return ['message', 'function_call', 'function_call_output', 'reasoning', 'output_text', 'text']
      .includes(entry.payload?.type)
  }
  return false
}

function workingStateFromEntries(entries: any[]): boolean | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (isTurnCompleteEntry(entry)) return false
    if (isAssistantActivityEntry(entry)) return true
  }
  return null
}

function mergeJsonlEntriesIntoSnapshot(
  snapshot: AssistantSnapshot,
  entries: any[],
  meta: Partial<AssistantSnapshot['jsonl']> = {},
  statusPatch: Partial<NonNullable<AssistantSnapshot['status']>> = {},
): AssistantSnapshot {
  const responses = assistantResponsesFromJsonlEntries(entries)
  const derivedWorking = Object.prototype.hasOwnProperty.call(statusPatch, 'working')
    ? statusPatch.working
    : workingStateFromEntries(entries)
  const status = {
    ...(snapshot.status || {}),
    ...statusPatch,
    ...(typeof derivedWorking === 'boolean'
      ? { working: derivedWorking, agent_status: derivedWorking ? 'running' : 'idle' }
      : {}),
  }

  return {
    ...snapshot,
    responses,
    messages: conversationMessagesFromResponses(snapshot, responses),
    status,
    jsonl: {
      ...(snapshot.jsonl || {}),
      ...meta,
      total: meta.total ?? entries.length,
      response_count: responses.length,
    },
  }
}

function needsPolling(snapshot: AssistantSnapshot) {
  if (snapshot.status?.failed) return false
  if (snapshot.status?.working) return true
  return (snapshot.responses || []).length === 0
}

function sessionPageUrl(userId?: string, snapshot?: AssistantSnapshot | null) {
  const session = snapshot?.session
  if (!userId || !session?.session_id || !session.project_id || !session.issue_id) return ''
  return `/u/${encodeURIComponent(userId)}/p/${encodeURIComponent(session.project_id)}/i/${encodeURIComponent(session.issue_id)}/?session=${encodeURIComponent(session.session_id)}`
}

function formatTime(raw?: string | null) {
  if (!raw) return ''
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}分钟前`
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))}小时前`
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function UserAvatar() {
  return <span className="assistant-msg-avatar assistant-msg-avatar--user" aria-hidden="true" />
}

function AssistantMessage({ response, index }: { response: AssistantResponse; index: number }) {
  return (
    <div className="assistant-session-message assistant-session-message--assistant">
      <div className="assistant-session-message__meta">
        <span className="assistant-msg-avatar assistant-msg-avatar--mo"><MoAvatar size="sm" lite /></span>
        <span className="assistant-msg-name">{ASSISTANT_NAME}</span>
        <span className="assistant-msg-turn">response {index + 1}</span>
        {response.created_at ? <span>{formatTime(response.created_at)}</span> : null}
      </div>
      <AssistantMarkdown content={response.content} />
    </div>
  )
}

function QuestionMessage({ snapshot }: { snapshot: AssistantSnapshot }) {
  return (
    <div className="assistant-session-message assistant-session-message--user">
      <div className="assistant-session-message__meta">
        <span>{formatTime(snapshot.question.created_at || snapshot.session.created_at)}</span>
        <span className="assistant-msg-name">我</span>
        <UserAvatar />
      </div>
      <div className="assistant-session-message__content">{snapshot.question.content}</div>
    </div>
  )
}

const PendingMessage = memo(function PendingMessage({ failed }: { failed?: boolean }) {
  return (
    <div className={`assistant-session-message ${failed ? 'assistant-session-message--system' : 'assistant-session-message--assistant'} assistant-session-message--pending`}>
      <div className="assistant-session-message__meta">
        <span className="assistant-msg-avatar assistant-msg-avatar--mo"><MoAvatar size="sm" active={!failed} /></span>
        <span className="assistant-msg-name">{ASSISTANT_NAME}</span>
      </div>
      <div className="assistant-session-message__content">
        {failed ? '这次小莫 Session 启动或执行失败。' : '小莫思考中…'}
      </div>
    </div>
  )
})

function buildAssistantClientContext(user: any) {
  const token = localStorage.getItem('cc-token') || ''
  return {
    current_url: window.location.href,
    origin: window.location.origin,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    auth: {
      token,
      authorization: token ? `Bearer ${token}` : '',
      user_id: user?.id || '',
      display_name: user?.display_name || '',
      role: user?.role || '',
    },
  }
}

function messagesForSnapshot(snapshot: AssistantSnapshot): AssistantConversationMessage[] {
  return snapshot.messages && snapshot.messages.length > 0
    ? snapshot.messages
    : [
        { id: `${snapshot.session.session_id}:question`, role: 'user' as const, content: snapshot.question.content, created_at: snapshot.question.created_at || snapshot.session.created_at },
        ...(snapshot.responses || []).map((response, index) => ({
          id: `${snapshot.session.session_id}:${response.id}`,
          role: 'assistant' as const,
          content: response.content,
          created_at: response.created_at,
          response_index: index,
        })),
      ]
}

function autoVoiceCandidatesFromSnapshots(
  snapshots: AssistantSnapshot[],
  clearCutoffs: Record<string, string>,
  voicePlaybackMode: VoicePlaybackMode,
): AutoVoiceCandidate[] {
  return snapshots.flatMap(snapshot => {
    const sessionId = snapshot.session.session_id
    return messagesForSnapshot(snapshot)
      .filter(message => (
        message.role === 'assistant'
        && shouldShowConversationMessage(message, clearCutoffs[sessionId] || '')
      ))
      .map(message => {
        const text = voiceTextForMessage(message.content, voicePlaybackMode)
        if (!text) return null
        const createdAt = message.created_at || ''
        const createdMs = Date.parse(createdAt)
        if (!Number.isFinite(createdMs) || createdMs <= 0) return null
        return {
          id: autoVoiceMessageKey(sessionId, message, text),
          sessionId,
          text,
          createdAt,
          createdMs,
        }
      })
      .filter((candidate): candidate is AutoVoiceCandidate => !!candidate && !!candidate.text)
  }).sort((a, b) => {
    if (a.createdMs !== b.createdMs) return a.createdMs - b.createdMs
    return a.id.localeCompare(b.id)
  })
}

const ConversationMessage = memo(function ConversationMessage({
  message,
  voicePlaybackMode,
  onSpeak,
  activeVoiceMessageId = '',
  voicePlaybackState = 'idle',
}: {
  message: AssistantConversationMessage
  voicePlaybackMode: VoicePlaybackMode
  onSpeak?: (text: string, messageId: string) => void
  activeVoiceMessageId?: string
  voicePlaybackState?: VoicePlaybackState
}) {
  const isUser = message.role === 'user'
  const voiceText = isUser ? '' : voiceTextForMessage(message.content, voicePlaybackMode)
  const commandVoice = !isUser && voicePlaybackMode === 'selected' && hasVoiceCommand(message.content)
  const visibleContent = isUser ? message.content : visibleContentForMessage(message.content)
  const isActiveVoice = !isUser && activeVoiceMessageId === message.id
  const voiceBusy = isActiveVoice && (voicePlaybackState === 'loading' || voicePlaybackState === 'playing')
  const voiceTip = voiceBusy
    ? (voicePlaybackState === 'loading' ? '正在生成播报' : '正在播报')
    : (commandVoice ? '播报指令文本' : '播报这条回复')
  return (
    <div className={`assistant-session-message ${isUser ? 'assistant-session-message--user' : 'assistant-session-message--assistant'}`}>
      <div className="assistant-session-message__meta">
        {isUser ? (
          <>
            {message.created_at ? <span>{formatTime(message.created_at)}</span> : null}
            <span className="assistant-msg-name">我</span>
            <UserAvatar />
          </>
        ) : (
          <>
            <span className="assistant-msg-avatar assistant-msg-avatar--mo"><MoAvatar size="sm" lite /></span>
            <span className="assistant-msg-name">{ASSISTANT_NAME}</span>
            <span className="assistant-msg-turn">response {(message.response_index ?? 0) + 1}</span>
            {message.created_at ? <span>{formatTime(message.created_at)}</span> : null}
            {voiceText ? (
              <AssistantTooltip label={voiceTip}>
                <button
                  type="button"
                  className={`assistant-message-voice${isActiveVoice ? ' assistant-message-voice--active' : ''}${commandVoice ? ' assistant-message-voice--command' : ''}`}
                  aria-label={voiceTip}
                  data-testid="assistant-message-speak"
                  disabled={voicePlaybackState === 'loading' && !isActiveVoice}
                  onClick={() => onSpeak?.(voiceText, message.id)}
                >
                  {voicePlaybackState === 'loading' && isActiveVoice ? (
                    <RefreshCw className="h-3 w-3 animate-spin" />
                  ) : (
                    <Volume2 className="h-3 w-3" />
                  )}
                </button>
              </AssistantTooltip>
            ) : null}
          </>
        )}
      </div>
      {isUser ? (
        <div className="assistant-session-message__content">{visibleContent}</div>
      ) : (
        <AssistantMarkdown content={visibleContent} />
      )}
    </div>
  )
})

const PendingTurnMessages = memo(function PendingTurnMessages({
  turn,
  showPending = true,
}: {
  turn: PendingAssistantTurn
  showPending?: boolean
}) {
  return (
    <>
      {turn.show_user ? (
        <ConversationMessage
          message={{
            id: `${turn.id}:user`,
            role: 'user',
            content: turn.content,
            created_at: turn.created_at,
          }}
          voicePlaybackMode="all"
        />
      ) : null}
      {showPending ? <PendingMessage failed={turn.failed} /> : null}
    </>
  )
})

function assistantSessionStatus(snapshot: AssistantSnapshot | null | undefined) {
  if (!snapshot) return { label: '未创建', className: 'assistant-session-status--muted' }
  if (snapshot.status?.failed) return { label: '失败', className: 'assistant-session-status--danger' }
  if (snapshot.status?.working || needsPolling(snapshot)) return { label: '运行中', className: 'assistant-session-status--active' }
  if ((snapshot.responses || []).length > 0) return { label: '已完成', className: 'assistant-session-status--done' }
  return { label: '就绪', className: 'assistant-session-status--idle' }
}

function clonePromptTemplate(task: string, cloneName: string) {
  return [
    `你是${cloneName}。`,
    '你是主体小莫派出的分身小莫，只处理本次收到的单项任务。',
    '边界：不能创建新的分身；不能输出 PushVoiceToUser(...)；不能要求其它小莫继续转派。',
    '完成时请给出简洁结果，包含：已完成内容、关键结论、文件或操作位置、风险或下一步建议。这个结果会回传给主体小莫统一收尾。',
    '',
    '本次分身任务：',
    task,
  ].join('\n')
}

function normalizedPendingContent(content: string) {
  return content.replace(/\s+/g, ' ').trim()
}

function snapshotContainsPendingTurnUser(snapshot: AssistantSnapshot, turn: PendingAssistantTurn) {
  const expected = normalizedPendingContent(turn.content)
  if (!expected) return false

  const turnMs = Date.parse(turn.created_at)
  return messagesForSnapshot(snapshot).some(message => {
    if (message.role !== 'user') return false
    if (normalizedPendingContent(message.content) !== expected) return false

    const messageMs = message.created_at ? Date.parse(message.created_at) : NaN
    if (!Number.isFinite(turnMs) || !Number.isFinite(messageMs)) return true

    // The optimistic message is created just before the backend stores the user
    // message. A timestamp guard avoids hiding a repeated question from an
    // older turn with the same text.
    return messageMs >= turnMs - 10_000
  })
}

function pendingTurnBelongsToSnapshot(turn: PendingAssistantTurn, snapshot: AssistantSnapshot, fallbackSessionId = '') {
  const snapshotSessionId = snapshot.session.session_id
  const turnSessionId = turn.session_id || fallbackSessionId
  return !!snapshotSessionId && !!turnSessionId && turnSessionId === snapshotSessionId
}

function CompactContextConfirmModal({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center">
      <button type="button" className="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-label="关闭压缩确认" onClick={onClose} />
      <div
        className="relative w-[360px] max-w-[calc(100vw-32px)] rounded-2xl p-6 shadow-2xl"
        onClick={event => event.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
      >
        <h3 className="mb-2 text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>压缩上文</h3>
        <p className="mb-5 text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          是否继续，将消耗一段时间压缩上文；压缩期间可以继续发送后续指令，但响应会延后。
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 flex-1 rounded-xl border text-[13px]"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)', background: 'var(--bg-card-hover)' }}
          >
            取消
          </button>
          <button type="button" onClick={onConfirm} className="btn-primary h-9 flex-1 rounded-xl text-[13px]">
            压缩上文
          </button>
        </div>
      </div>
    </div>
  )
}

function DeleteCurrentSessionConfirmModal({
  sessionName,
  deleting,
  error,
  onConfirm,
  onClose,
}: {
  sessionName: string
  deleting: boolean
  error: string
  onConfirm: () => void
  onClose: () => void
}) {
  const name = sessionName.trim() || '当前小莫 Session'
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        aria-label="取消删除当前小莫 Session"
        onClick={deleting ? undefined : onClose}
      />
      <div
        className="relative w-[420px] max-w-[calc(100vw-32px)] rounded-2xl p-6 shadow-2xl"
        onClick={event => event.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
      >
        <div className="mb-3 flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>删除当前小莫 Session</h3>
            <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              确认后会关闭后台执行，并永久删除 Session「{name}」。删除后不会保留在回收站；下一次向小莫提问时会创建新的小莫 Session。
            </p>
          </div>
        </div>
        {error ? (
          <div className="mb-3 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
            {error}
          </div>
        ) : null}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="h-9 flex-1 rounded-xl border text-[13px] disabled:opacity-40"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)', background: 'var(--bg-card-hover)' }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="h-9 flex-1 rounded-xl bg-red-500 text-[13px] text-white transition-colors hover:bg-red-600 disabled:opacity-40"
          >
            {deleting ? '删除中...' : '删除 Session'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CreateCloneSessionModal({
  draft,
  modelOptions,
  creating,
  error,
  onChange,
  onConfirm,
  onClose,
}: {
  draft: CloneDraft
  modelOptions: SessionModelOption[]
  creating: boolean
  error: string
  onChange: (patch: Partial<CloneDraft>) => void
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        aria-label="关闭分身小莫配置"
        onClick={creating ? undefined : onClose}
      />
      <div
        className="relative flex max-h-[86vh] w-[520px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl p-6 shadow-2xl"
        onClick={event => event.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
      >
        <div className="mb-4">
          <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>开一个分身小莫</h3>
          <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            分身只处理一个独立任务，不能再开分身，也不能语音播报。完成后会把结果回传给主体小莫统一收尾。
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto">
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>任务说明</span>
            <textarea
              value={draft.task}
              onChange={event => onChange({ task: event.target.value })}
              rows={5}
              className="w-full resize-none rounded-xl border px-3 py-2 text-[13px] leading-relaxed outline-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}
              placeholder="写清楚这个分身要单独完成什么..."
              disabled={creating}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>模型</span>
              <select
                value={draft.model}
                onChange={event => onChange({ model: event.target.value })}
                className="h-10 w-full rounded-xl border px-3 text-[12px] outline-none"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}
                disabled={creating}
              >
                {modelOptions.map(option => (
                  <option key={option.key} value={option.key}>
                    {option.title || option.label || option.key}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>语言</span>
              <select
                value={draft.language}
                onChange={event => onChange({ language: event.target.value === 'en' ? 'en' : 'zh' })}
                className="h-10 w-full rounded-xl border px-3 text-[12px] outline-none"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}
                disabled={creating}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
            </label>
          </div>

          <div className="rounded-xl border px-3 py-2 text-[12px] leading-relaxed" style={{ borderColor: 'rgba(14,165,233,.22)', color: 'var(--text-muted)', background: 'rgba(14,165,233,.08)' }}>
            分身参数会写入该分身 Session。主体小莫仍负责分发、汇总和必要的语音播报。
          </div>

          {error ? (
            <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
              {error}
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            className="h-9 flex-1 rounded-xl border text-[13px] disabled:opacity-40"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)', background: 'var(--bg-card-hover)' }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={creating || !draft.task.trim()}
            className="btn-primary h-9 flex-1 rounded-xl text-[13px] disabled:opacity-40"
          >
            {creating ? '创建中...' : '创建并启动'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function AssistantChat() {
  const [open, setOpen] = useState(false)
  // 缩小态时任务完成未读计数；点击 FAB 展开时清零。
  const [unreadCompletion, setUnreadCompletion] = useState(0)
  const openRef = useRef(open)
  openRef.current = open
  const [panelSize, setPanelSize] = useState<AssistantPanelSize>('compact')
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({})
  // 小莫 FAB 自定义位置: null=默认右下角 (CSS), 否则用 inline left/top 定位
  // 懒初始化从 localStorage 恢复 (并吸附), 避免首屏从默认位闪烁到记忆位
  const [fabPos, setFabPos] = useState<{ left: number; top: number } | null>(() => {
    const restored = readFabPos()
    return restored ? snapFabToEdge(restored.left, restored.top) : null
  })
  const [fabDragging, setFabDragging] = useState(false)
  const [input, setInputState] = useState('')
  const [inputExpanded, setInputExpanded] = useState(false)
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([])
  const [imagePreview, setImagePreview] = useState<AssistantImagePreview | null>(null)
  const [sessions, setSessions] = useState<AssistantSnapshot[]>([])
  const [activeSessionId, setActiveSessionId] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('mobius:ui:sidebar:assistant-sessions')
      if (raw) {
        const v = Number(raw)
        if (Number.isFinite(v)) return Math.max(140, Math.min(280, Math.round(v)))
      }
    } catch {}
    return 176
  })
  const sidebarDragRef = useRef<{ startX: number; startWidth: number; raf: number | null } | null>(null)
  const onSidebarResizeStart = useCallback((event: React.MouseEvent) => {
    if (sidebarCollapsed) return
    if (event.button !== 0) return
    event.preventDefault()
    const startWidth = sidebarWidth
    sidebarDragRef.current = { startX: event.clientX, startWidth, raf: null }
    document.body.classList.add('mobius-resizing')
    const onMove = (e: globalThis.MouseEvent) => {
      const drag = sidebarDragRef.current
      if (!drag) return
      e.preventDefault()
      const delta = e.clientX - drag.startX
      const next = Math.max(140, Math.min(280, drag.startWidth + delta))
      if (drag.raf !== null) cancelAnimationFrame(drag.raf)
      drag.raf = requestAnimationFrame(() => { setSidebarWidth(next) })
    }
    const onUp = () => {
      const drag = sidebarDragRef.current
      if (drag && drag.raf !== null) cancelAnimationFrame(drag.raf)
      sidebarDragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('mobius-resizing')
      setSidebarWidth((w) => {
        try { localStorage.setItem('mobius:ui:sidebar:assistant-sessions', String(w)) } catch {}
        return w
      })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [sidebarCollapsed, sidebarWidth])
  const onSidebarResizeReset = useCallback(() => {
    setSidebarWidth(176)
    try { localStorage.setItem('mobius:ui:sidebar:assistant-sessions', '176') } catch {}
  }, [])
  const [creatingClone, setCreatingClone] = useState(false)
  const [cloneModalOpen, setCloneModalOpen] = useState(false)
  const [cloneDraft, setCloneDraft] = useState<CloneDraft>({ task: '', model: 'codex', language: 'zh' })
  const [cloneModelOptions, setCloneModelOptions] = useState<SessionModelOption[]>(FALLBACK_CLONE_MODEL_OPTIONS)
  const [cloneCreateErr, setCloneCreateErr] = useState('')
  const [pendingTurns, setPendingTurns] = useState<PendingAssistantTurn[]>([])
  const [clearCutoffs, setClearCutoffs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [compactConfirmOpen, setCompactConfirmOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deletingSession, setDeletingSession] = useState(false)
  const [deleteErr, setDeleteErr] = useState('')
  const [err, setErr] = useState('')
  const [voiceState, setVoiceState] = useState<VoiceInputState>('idle')
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [voicePlaybackEnabled, setVoicePlaybackEnabled] = useState(false)
  const [voicePlaybackMode, setVoicePlaybackMode] = useState<VoicePlaybackMode>('selected')
  const [voiceOptions, setVoiceOptions] = useState<AssistantVoiceOption[]>(ASSISTANT_TTS_VOICE_FALLBACK)
  const [selectedVoice, setSelectedVoice] = useState(DEFAULT_ASSISTANT_TTS_VOICE)
  const [voicePlaybackState, setVoicePlaybackState] = useState<VoicePlaybackState>('idle')
  const [voicePlaybackMessage, setVoicePlaybackMessage] = useState('')
  const [activeVoiceMessageId, setActiveVoiceMessageId] = useState('')
  const [collapsedVoiceHoldState, setCollapsedVoiceHoldState] = useState<CollapsedVoiceHoldState>('idle')
  const user = useStore(state => state.user)
  const setProjects = useStore(state => state.setProjects)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const [submitNonce, setSubmitNonce] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  const interactionRef = useRef<PanelInteraction | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const jsonlEntriesRef = useRef<Record<string, any[]>>({})
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceRecordFailedRef = useRef(false)
  const voiceStopTimerRef = useRef<number | null>(null)
  const voiceTickTimerRef = useRef<number | null>(null)
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null)
  const voiceAudioUrlRef = useRef('')
  const voicePlaybackAbortRef = useRef<AbortController | null>(null)
  const voicePlaybackRunRef = useRef(0)
  const voicePlaybackStateRef = useRef<VoicePlaybackState>('idle')
  const voiceStateRef = useRef<VoiceInputState>('idle')
  const assistantTabIdRef = useRef('')
  const sharedVoiceLockRefreshRef = useRef<number | null>(null)
  const sharedVoiceChannelRef = useRef<BroadcastChannel | null>(null)
  const sharedVoiceMessageIdRef = useRef('')
  const sendingRef = useRef(false)
  const activeVoiceMessageIdRef = useRef('')
  const autoVoiceBootstrapPendingRef = useRef(false)
  const autoVoiceCursorsRef = useRef<Record<string, AutoVoiceCursorEntry>>({})
  const cloneReportCursorsRef = useRef<Record<string, string>>({})
  const assistantWorkspaceProjectIdRef = useRef('')
  const attachmentsRef = useRef<AssistantAttachment[]>([])
  const collapsedVoiceHoldTimerRef = useRef<number | null>(null)
  const collapsedVoicePointerIdRef = useRef<number | null>(null)
  const collapsedVoiceStartedRef = useRef(false)
  const stopCollapsedVoiceAfterStartRef = useRef(false)
  const suppressNextFabClickRef = useRef(false)
  // FAB 拖动会话状态: pointerdown 记录起点, pointermove 越阈值进入拖动, pointerup 吸附
  const fabDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startLeft: number
    startTop: number
    moved: boolean
    dragging: boolean
  } | null>(null)
  const inputDraftSaveTimerRef = useRef<number | null>(null)
  const pendingInputDraftRef = useRef('')
  const inputValueRef = useRef('')
  const sendContentRef = useRef<((content: string, restoreOnError?: boolean, options?: SendContentOptions) => Promise<void>) | null>(null)
  const [streamSessionId, setStreamSessionId] = useState('')
  const inputDraftKey = user?.id ? `assistant-input:${user.id}` : ''
  const isPanelFullscreen = panelSize === 'fullscreen'
  const panelSizeClass = `assistant-panel--${panelSize}`
  const voicePreferenceKey = user?.id ? `assistant-tts-voice:${user.id}` : 'assistant-tts-voice'
  const voicePlaybackPreferenceKey = user?.id ? `assistant-tts-playback-enabled:${user.id}` : 'assistant-tts-playback-enabled'
  const voicePlaybackModePreferenceKey = assistantVoicePlaybackModeStorageKey(user?.id)
  const autoVoiceCursorStorageKey = assistantAutoVoiceCursorStorageKey(user?.id)
  const sharedVoiceLockStorageKey = assistantSharedVoiceLockStorageKey(user?.id)
  const sharedVoiceChannelName = assistantSharedVoiceChannelName(user?.id)
  const clearCutoffStorageKey = assistantClearCutoffStorageKey(user?.id)
  const cloneReportCursorStorageKey = cloneReportStorageKey(user?.id)
  if (!assistantTabIdRef.current) assistantTabIdRef.current = createAssistantTabId()

  const persistInputDraft = useCallback((value: string) => {
    if (!inputDraftKey) return
    draftSave(inputDraftKey, { input: value }, { minChars: 1 })
  }, [inputDraftKey])

  const scheduleInputDraftSave = useCallback((value: string) => {
    if (!inputDraftKey) return
    pendingInputDraftRef.current = value
    if (inputDraftSaveTimerRef.current !== null) {
      window.clearTimeout(inputDraftSaveTimerRef.current)
    }
    inputDraftSaveTimerRef.current = window.setTimeout(() => {
      inputDraftSaveTimerRef.current = null
      persistInputDraft(pendingInputDraftRef.current)
    }, ASSISTANT_INPUT_DRAFT_SAVE_DELAY_MS)
  }, [inputDraftKey, persistInputDraft])

  const flushInputDraftSave = useCallback(() => {
    if (inputDraftSaveTimerRef.current !== null) {
      window.clearTimeout(inputDraftSaveTimerRef.current)
      inputDraftSaveTimerRef.current = null
    }
    if (!inputDraftKey) return
    persistInputDraft(pendingInputDraftRef.current)
  }, [inputDraftKey, persistInputDraft])

  const setInput = useCallback((value: string | ((current: string) => string), options: { persist?: boolean } = {}) => {
    setInputState(current => {
      const next = typeof value === 'function' ? value(current) : value
      inputValueRef.current = next
      if (options.persist !== false && inputDraftKey) {
        scheduleInputDraftSave(next)
      }
      return next
    })
  }, [inputDraftKey, scheduleInputDraftSave])

  useEffect(() => {
    if (!inputDraftKey) return
    const saved = draftLoad<{ input?: string }>(inputDraftKey)
    if (!saved?.input) return
    setInputState(current => {
      const next = current.trim() ? current : saved.input || ''
      inputValueRef.current = next
      return next
    })
  }, [inputDraftKey])

  useEffect(() => {
    setClearCutoffs(readAssistantClearCutoffs(clearCutoffStorageKey))
  }, [clearCutoffStorageKey])

  // 任务完成上升沿检测:任意 session 的 job_accomplished 从 false 变 true,
  // 且当前是缩小态,就累加未读计数 (同一轮里 N 个 session 同时完成 → +N)。
  // 首次见到的 session 跳过,避免页面加载误报。
  const prevAccomplishedRef = useRef<Record<string, boolean>>({})
  useEffect(() => {
    const next: Record<string, boolean> = {}
    let newCompletions = 0
    for (const snap of sessions) {
      const sid = snap.session?.session_id
      if (!sid) continue
      const acc = snap.job_accomplished === true
      next[sid] = acc
      if (prevAccomplishedRef.current[sid] === undefined) continue
      if (!prevAccomplishedRef.current[sid] && acc && !openRef.current) {
        newCompletions += 1
      }
    }
    if (newCompletions > 0) setUnreadCompletion(c => c + newCompletions)
    prevAccomplishedRef.current = next
  }, [sessions])

  useEffect(() => {
    cloneReportCursorsRef.current = readCloneReportCursors(cloneReportCursorStorageKey)
  }, [cloneReportCursorStorageKey])

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(attachment => {
        if (attachment.previewUrl) {
          try { URL.revokeObjectURL(attachment.previewUrl) } catch {}
        }
      })
    }
  }, [])

  const resolveAssistantWorkspaceProjectId = useCallback(async () => {
    if (assistantWorkspaceProjectIdRef.current) return assistantWorkspaceProjectIdRef.current
    const workspace = await api('/api/assistant/workspace') as { project?: { id?: string } }
    const projectId = String(workspace?.project?.id || '').trim()
    if (!projectId) throw new Error('未找到小莫项目，无法上传图片')
    assistantWorkspaceProjectIdRef.current = projectId
    return projectId
  }, [])

  const enqueueAttachmentFiles = useCallback((files: FileList | File[]) => {
    const candidates = Array.from(files || []).filter(Boolean)
    if (candidates.length === 0) return

    setErr('')
    setAttachments(current => {
      const remainingSlots = Math.max(0, ASSISTANT_ATTACHMENT_MAX_COUNT - current.length)
      const accepted = candidates.slice(0, remainingSlots)
      const rejectedCount = candidates.length - accepted.length
      const next = current.concat(accepted.map(file => {
        const kind = assistantAttachmentKindOf(file)
        const validationError = assistantAttachmentUploadError(file)
        return {
          id: makeAssistantAttachmentId(),
          name: file.name || (kind === 'image' ? 'image' : 'file'),
          size: file.size || 0,
          kind,
          type: file.type || 'image/*',
          previewUrl: kind === 'image' ? URL.createObjectURL(file) : '',
          status: validationError ? 'error' : 'uploading',
          error: validationError || undefined,
        } satisfies AssistantAttachment
      }))
      if (rejectedCount > 0) {
        setErr(`最多一次发送 ${ASSISTANT_ATTACHMENT_MAX_COUNT} 个附件，已忽略 ${rejectedCount} 个。`)
      }

      accepted.forEach((file, index) => {
        const target = next[current.length + index]
        if (!target || target.status === 'error') return
        resolveAssistantWorkspaceProjectId()
          .then(projectId => uploadAssistantAttachment(file, projectId))
          .then(result => {
            setAttachments(prev => prev.map(attachment => (
              attachment.id === target.id
                ? { ...attachment, status: 'done', remotePath: result.path, size: result.size || attachment.size }
                : attachment
            )))
          })
          .catch(error => {
            setAttachments(prev => prev.map(attachment => (
              attachment.id === target.id
                ? { ...attachment, status: 'error', error: error?.message || '上传失败' }
                : attachment
            )))
          })
      })

      return next
    })
  }, [resolveAssistantWorkspaceProjectId])

  const removeAttachment = useCallback((id: string) => {
    setImagePreview(current => current?.id === id ? null : current)
    setAttachments(current => {
      const target = current.find(attachment => attachment.id === id)
      if (target?.previewUrl) {
        try { URL.revokeObjectURL(target.previewUrl) } catch {}
      }
      return current.filter(attachment => attachment.id !== id)
    })
  }, [])

  const clearAttachments = useCallback(() => {
    setImagePreview(null)
    setAttachments(current => {
      current.forEach(attachment => {
        if (attachment.previewUrl) {
          try { URL.revokeObjectURL(attachment.previewUrl) } catch {}
        }
      })
      return []
    })
  }, [])

  const handleAttachmentPaste = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items
    if (!items || items.length === 0) return
    const files: File[] = []
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) files.push(file)
    }
    if (files.length === 0) return
    event.preventDefault()
    enqueueAttachmentFiles(files)
  }, [enqueueAttachmentFiles])

  const handleAttachmentDrop = useCallback((event: ReactDragEvent<HTMLFormElement>) => {
    const files = event.dataTransfer?.files
    if (!files || files.length === 0) return
    event.preventDefault()
    enqueueAttachmentFiles(files)
  }, [enqueueAttachmentFiles])

  const handleAttachmentDragOver = useCallback((event: ReactDragEvent<HTMLFormElement>) => {
    if (!event.dataTransfer?.types?.includes('Files')) return
    event.preventDefault()
  }, [])

  const handleAttachmentInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (files && files.length > 0) enqueueAttachmentFiles(files)
    event.target.value = ''
  }, [enqueueAttachmentFiles])

  const clearInputDraft = useCallback((expectedInput?: string) => {
    if (!inputDraftKey) return
    if (typeof expectedInput === 'string' && inputValueRef.current && inputValueRef.current !== expectedInput) return
    inputValueRef.current = ''
    setInputState('')
    if (inputDraftSaveTimerRef.current !== null) {
      window.clearTimeout(inputDraftSaveTimerRef.current)
      inputDraftSaveTimerRef.current = null
    }
    pendingInputDraftRef.current = ''
    const saved = draftLoad<{ input?: string }>(inputDraftKey)
    if (typeof expectedInput !== 'string' || !saved?.input || saved.input === expectedInput) {
      draftClear(inputDraftKey)
    }
  }, [inputDraftKey])

  useEffect(() => {
    return () => {
      if (inputDraftSaveTimerRef.current !== null) {
        window.clearTimeout(inputDraftSaveTimerRef.current)
        inputDraftSaveTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    if (!open) return
    const el = textareaRef.current
    if (!el) return
    // 用 rAF 节流自适应高度：每次按键直接读 scrollHeight 会强制同步回流，
    // 叠加面板里大量正在跑动画的元素后会让打字明显发卡。改到下一帧统一测量。
    const raf = window.requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      const maxHeight = Math.max(120, Math.floor(window.innerHeight * (inputExpanded ? 0.50 : 0.30)))
      const minHeight = inputExpanded ? 180 : 62
      node.style.height = 'auto'
      node.style.height = `${Math.min(Math.max(node.scrollHeight, minHeight), maxHeight)}px`
    })
    return () => window.cancelAnimationFrame(raf)
  }, [input, inputExpanded, open])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      api('/api/assistant/tts/voices').catch(() => null),
      api('/api/sessions/model-options').catch(() => FALLBACK_CLONE_MODEL_OPTIONS),
    ]).then(([voices, models]) => {
      if (cancelled) return
      setVoiceOptions(normalizeVoiceOptions((voices as any)?.voices))
      const nextModels = Array.isArray(models) && models.length > 0 ? models as SessionModelOption[] : FALLBACK_CLONE_MODEL_OPTIONS
      setCloneModelOptions(nextModels)
      setCloneDraft(current => ({
        ...current,
        model: nextModels.some(option => option.key === current.model)
          ? current.model
          : (nextModels[0]?.key || 'codex'),
      }))
    }).catch(() => {
      if (cancelled) return
      setVoiceOptions(ASSISTANT_TTS_VOICE_FALLBACK)
      setCloneModelOptions(FALLBACK_CLONE_MODEL_OPTIONS)
    })
    return () => {
      cancelled = true
    }
  }, [user?.id])

  useEffect(() => {
    const defaultVoice = voiceOptions.find(option => option.default)?.id || DEFAULT_ASSISTANT_TTS_VOICE
    const savedVoice = localStorage.getItem(voicePreferenceKey) || localStorage.getItem('assistant-tts-voice') || ''
    const nextVoice = voiceOptions.some(option => option.id === savedVoice) ? savedVoice : defaultVoice
    setSelectedVoice(nextVoice)
  }, [voiceOptions, voicePreferenceKey])

  const selectedVoiceOption = useMemo(
    () => voiceOptions.find(option => option.id === selectedVoice) || voiceOptions.find(option => option.default) || voiceOptions[0] || ASSISTANT_TTS_VOICE_FALLBACK[0],
    [selectedVoice, voiceOptions],
  )
  const selectedVoiceLabel = selectedVoiceOption?.label || 'vivi 2.0'

  const handleVoiceOptionChange = useCallback((voice: string) => {
    const defaultVoice = voiceOptions.find(option => option.default)?.id || DEFAULT_ASSISTANT_TTS_VOICE
    const nextVoice = voiceOptions.some(option => option.id === voice) ? voice : defaultVoice
    setSelectedVoice(nextVoice)
    localStorage.setItem(voicePreferenceKey, nextVoice)
  }, [voiceOptions, voicePreferenceKey])

  useEffect(() => {
    setVoicePlaybackMode(readStoredVoicePlaybackMode(voicePlaybackModePreferenceKey))
  }, [voicePlaybackModePreferenceKey])

  const handleVoicePlaybackModeChange = useCallback((mode: VoicePlaybackMode) => {
    const nextMode = normalizeVoicePlaybackMode(mode)
    setVoicePlaybackMode(nextMode)
    writeStoredVoicePlaybackMode(voicePlaybackModePreferenceKey, nextMode)
  }, [voicePlaybackModePreferenceKey])

  useEffect(() => {
    voicePlaybackStateRef.current = voicePlaybackState
  }, [voicePlaybackState])

  useEffect(() => {
    activeVoiceMessageIdRef.current = activeVoiceMessageId
  }, [activeVoiceMessageId])

  useEffect(() => {
    autoVoiceCursorsRef.current = readStoredAutoVoiceCursors(autoVoiceCursorStorageKey)
    autoVoiceBootstrapPendingRef.current = false
  }, [autoVoiceCursorStorageKey])

  useEffect(() => {
    voiceStateRef.current = voiceState
  }, [voiceState])

  useEffect(() => {
    sendingRef.current = sending
  }, [sending])

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
      setErr('录音内容为空，请重新录制一段清晰语音。')
      return
    }

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 125_000)
    const mimeType = blob.type || 'audio/webm'
    const form = new FormData()
    form.append('audio', blob, `assistant-voice-${Date.now()}.${recordingFileExtension(mimeType)}`)

    setVoiceState('transcribing')
    setErr('')
    try {
      const result = await api('/api/assistant/transcribe', {
        method: 'POST',
        body: form,
        signal: controller.signal,
      }) as VoiceTranscribeResponse
      const text = String(result.text || '').trim()
      if (!text) {
        setVoiceState('error')
        setErr('没有识别到有效语音，请靠近麦克风并重新录制。')
        return
      }
      const sendVoiceContent = sendContentRef.current
      if (!sendVoiceContent) {
        setVoiceState('error')
        setErr('语音已识别，但小莫发送器尚未就绪，请稍后重试。')
        return
      }
      setVoiceState('idle')
      await sendVoiceContent(text, false)
    } catch (error: any) {
      setVoiceState('error')
      setErr(error?.name === 'AbortError'
        ? '语音转写网络超时，请稍后重试。'
        : (error?.message || '语音转写失败，请稍后重试。'))
    } finally {
      window.clearTimeout(timeout)
    }
  }, [])

  const stopVoiceRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    try { recorder.requestData() } catch {}
    try { recorder.stop() } catch {}
  }, [])

  const startVoiceRecording = useCallback(async () => {
    if (sending || voiceState === 'transcribing') return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceState('error')
      setErr('当前浏览器不支持录音，请换用支持 MediaRecorder 的浏览器。')
      return
    }

    setErr('')
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
        setErr('浏览器录音失败，请重新录制。')
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
      setErr(permissionErrorMessage(error, '小莫'))
    }
  }, [clearVoiceTimers, sending, stopVoiceRecording, stopVoiceStream, submitVoiceBlob, voiceState])

  const toggleVoiceRecording = useCallback(() => {
    if (voiceState === 'recording') {
      stopVoiceRecording()
      return
    }
    void startVoiceRecording()
  }, [startVoiceRecording, stopVoiceRecording, voiceState])

  const clearCollapsedVoiceHoldTimer = useCallback(() => {
    if (collapsedVoiceHoldTimerRef.current !== null) {
      window.clearTimeout(collapsedVoiceHoldTimerRef.current)
      collapsedVoiceHoldTimerRef.current = null
    }
  }, [])

  const handleFabPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return

    // 记录拖动起点 (打开/收起态都允许拖动 FAB)
    const rect = event.currentTarget.getBoundingClientRect()
    fabDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      moved: false,
      dragging: false,
    }
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}

    // 语音长按仅在收起态 + 空闲时启用
    if (open) return
    if (sendingRef.current || voiceStateRef.current === 'recording' || voiceStateRef.current === 'transcribing') return

    clearCollapsedVoiceHoldTimer()
    collapsedVoicePointerIdRef.current = event.pointerId
    collapsedVoiceStartedRef.current = false
    stopCollapsedVoiceAfterStartRef.current = false
    setCollapsedVoiceHoldState('holding')

    collapsedVoiceHoldTimerRef.current = window.setTimeout(() => {
      collapsedVoiceHoldTimerRef.current = null
      collapsedVoiceStartedRef.current = true
      suppressNextFabClickRef.current = true
      setCollapsedVoiceHoldState('recording')
      void startVoiceRecording().finally(() => {
        if (!stopCollapsedVoiceAfterStartRef.current) return
        stopCollapsedVoiceAfterStartRef.current = false
        stopVoiceRecording()
      })
    }, ASSISTANT_FAB_VOICE_HOLD_MS)
  }, [clearCollapsedVoiceHoldTimer, open, startVoiceRecording, stopVoiceRecording])

  const handleFabPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = fabDragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return

    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY

    if (!drag.dragging) {
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < ASSISTANT_FAB_DRAG_THRESHOLD) return
        drag.moved = true
      }
      // 语音录制一旦启动就不再切入拖动 (语音优先)
      if (collapsedVoiceStartedRef.current) return
      drag.dragging = true
      // 取消挂起的语音长按, 让位给拖动
      clearCollapsedVoiceHoldTimer()
      collapsedVoicePointerIdRef.current = null
      setCollapsedVoiceHoldState('idle')
      suppressNextFabClickRef.current = true
      setFabDragging(true)
    }

    const size = ASSISTANT_FAB_SIZE
    const vw = window.innerWidth
    const vh = window.innerHeight
    const nextLeft = Math.max(0, Math.min(vw - size, drag.startLeft + dx))
    const nextTop = Math.max(0, Math.min(vh - size, drag.startTop + dy))
    setFabPos({ left: nextLeft, top: nextTop })
  }, [clearCollapsedVoiceHoldTimer])

  const finishCollapsedVoiceHold = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = fabDragRef.current
    if (drag && event.pointerId === drag.pointerId) {
      fabDragRef.current = null
      // 拖动收尾: 吸附到左/右边缘 + 持久化 + 吃掉 click
      if (drag.dragging) {
        try { event.currentTarget.releasePointerCapture(drag.pointerId) } catch {}
        const snapped = snapFabToEdge(
          drag.startLeft + (event.clientX - drag.startX),
          drag.startTop + (event.clientY - drag.startY),
        )
        setFabPos(snapped)
        writeFabPos(snapped)
        suppressNextFabClickRef.current = true
        setFabDragging(false)
        clearCollapsedVoiceHoldTimer()
        collapsedVoicePointerIdRef.current = null
        collapsedVoiceStartedRef.current = false
        setCollapsedVoiceHoldState('idle')
        return
      }
    }

    const pointerId = collapsedVoicePointerIdRef.current
    if (pointerId !== null && event.pointerId !== pointerId) return

    clearCollapsedVoiceHoldTimer()
    try {
      if (pointerId !== null && event.currentTarget.hasPointerCapture(pointerId)) {
        event.currentTarget.releasePointerCapture(pointerId)
      }
    } catch {}

    collapsedVoicePointerIdRef.current = null
    setCollapsedVoiceHoldState('idle')

    if (!collapsedVoiceStartedRef.current) return

    suppressNextFabClickRef.current = true
    collapsedVoiceStartedRef.current = false
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      stopVoiceRecording()
      return
    }
    stopCollapsedVoiceAfterStartRef.current = true
  }, [clearCollapsedVoiceHoldTimer, stopVoiceRecording])

  const handleFabClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (suppressNextFabClickRef.current) {
      suppressNextFabClickRef.current = false
      event.preventDefault()
      event.stopPropagation()
      return
    }
    setOpen(value => !value)
    setUnreadCompletion(0)
  }, [])

  const cleanupSpeechAudio = useCallback(() => {
    const audio = voiceAudioRef.current
    voiceAudioRef.current = null
    if (audio) {
      try { audio.pause() } catch {}
      audio.removeAttribute('src')
    }
    if (voiceAudioUrlRef.current) {
      URL.revokeObjectURL(voiceAudioUrlRef.current)
      voiceAudioUrlRef.current = ''
    }
  }, [])

  const clearSharedVoiceLockRefresh = useCallback(() => {
    if (sharedVoiceLockRefreshRef.current !== null) {
      window.clearInterval(sharedVoiceLockRefreshRef.current)
      sharedVoiceLockRefreshRef.current = null
    }
  }, [])

  const publishSharedVoiceEvent = useCallback((event: Omit<SharedVoicePlaybackEvent, 'ownerId' | 'at'>) => {
    const payload: SharedVoicePlaybackEvent = {
      ...event,
      ownerId: assistantTabIdRef.current,
      at: Date.now(),
    }
    try {
      sharedVoiceChannelRef.current?.postMessage(payload)
    } catch {
      /* BroadcastChannel is only an accelerator; storage events are the fallback. */
    }
  }, [])

  const releaseSharedVoicePlaybackLock = useCallback((messageId = sharedVoiceMessageIdRef.current) => {
    clearSharedVoiceLockRefresh()
    if (messageId && sharedVoiceMessageIdRef.current === messageId) {
      sharedVoiceMessageIdRef.current = ''
    }
    removeSharedVoicePlaybackLock(sharedVoiceLockStorageKey, assistantTabIdRef.current, messageId)
    if (messageId) publishSharedVoiceEvent({ type: 'stopped', messageId })
  }, [clearSharedVoiceLockRefresh, publishSharedVoiceEvent, sharedVoiceLockStorageKey])

  const claimSharedVoicePlaybackLock = useCallback((messageId: string) => {
    if (!messageId) return true
    const ownerId = assistantTabIdRef.current
    const now = Date.now()
    const existing = readSharedVoicePlaybackLock(sharedVoiceLockStorageKey)
    if (existing && existing.ownerId !== ownerId && existing.expiresAt > now) return false

    const lock = {
      ownerId,
      messageId,
      updatedAt: now,
      expiresAt: now + SHARED_VOICE_PLAYBACK_LOCK_TTL_MS,
    }
    writeSharedVoicePlaybackLock(sharedVoiceLockStorageKey, lock)
    const written = readSharedVoicePlaybackLock(sharedVoiceLockStorageKey)
    if (!written || written.ownerId !== ownerId || written.messageId !== messageId) return false

    sharedVoiceMessageIdRef.current = messageId
    clearSharedVoiceLockRefresh()
    sharedVoiceLockRefreshRef.current = window.setInterval(() => {
      const current = readSharedVoicePlaybackLock(sharedVoiceLockStorageKey)
      if (!current || current.ownerId !== ownerId || current.messageId !== messageId) {
        clearSharedVoiceLockRefresh()
        return
      }
      const refreshedAt = Date.now()
      writeSharedVoicePlaybackLock(sharedVoiceLockStorageKey, {
        ownerId,
        messageId,
        updatedAt: refreshedAt,
        expiresAt: refreshedAt + SHARED_VOICE_PLAYBACK_LOCK_TTL_MS,
      })
    }, SHARED_VOICE_PLAYBACK_LOCK_REFRESH_MS)
    publishSharedVoiceEvent({ type: 'started', messageId })
    return true
  }, [clearSharedVoiceLockRefresh, publishSharedVoiceEvent, sharedVoiceLockStorageKey])

  const stopSpeechPlayback = useCallback(() => {
    const lockedMessageId = sharedVoiceMessageIdRef.current
    voicePlaybackRunRef.current += 1
    if (voicePlaybackAbortRef.current) {
      try { voicePlaybackAbortRef.current.abort() } catch {}
      voicePlaybackAbortRef.current = null
    }
    cleanupSpeechAudio()
    voicePlaybackStateRef.current = 'idle'
    activeVoiceMessageIdRef.current = ''
    setVoicePlaybackState('idle')
    setVoicePlaybackMessage('')
    setActiveVoiceMessageId('')
    if (lockedMessageId) releaseSharedVoicePlaybackLock(lockedMessageId)
  }, [cleanupSpeechAudio, releaseSharedVoicePlaybackLock])

  useEffect(() => {
    const stopIfAnotherTabOwnsPlayback = (lock: SharedVoicePlaybackLock | null) => {
      if (!lock || lock.ownerId === assistantTabIdRef.current || lock.expiresAt <= Date.now()) return
      const playbackState = voicePlaybackStateRef.current
      if (playbackState === 'loading' || playbackState === 'playing') stopSpeechPlayback()
    }

    let channel: BroadcastChannel | null = null
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(sharedVoiceChannelName)
      sharedVoiceChannelRef.current = channel
      channel.onmessage = event => {
        const payload = event.data as Partial<SharedVoicePlaybackEvent> | null
        if (!payload || payload.type !== 'started' || payload.ownerId === assistantTabIdRef.current) return
        if (typeof payload.ownerId !== 'string' || !payload.ownerId) return
        if (typeof payload.messageId !== 'string' || !payload.messageId) return
        stopIfAnotherTabOwnsPlayback({
          ownerId: payload.ownerId,
          messageId: payload.messageId,
          updatedAt: Number(payload.at) || Date.now(),
          expiresAt: Date.now() + SHARED_VOICE_PLAYBACK_LOCK_TTL_MS,
        })
      }
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key === sharedVoiceLockStorageKey) {
        stopIfAnotherTabOwnsPlayback(readSharedVoicePlaybackLock(sharedVoiceLockStorageKey))
      } else if (event.key === autoVoiceCursorStorageKey) {
        autoVoiceCursorsRef.current = readStoredAutoVoiceCursors(autoVoiceCursorStorageKey)
      } else if (event.key === voicePlaybackModePreferenceKey) {
        setVoicePlaybackMode(readStoredVoicePlaybackMode(voicePlaybackModePreferenceKey))
        autoVoiceBootstrapPendingRef.current = true
      } else if (event.key === voicePlaybackPreferenceKey) {
        const enabled = readStoredVoicePlaybackEnabled(voicePlaybackPreferenceKey)
        if (enabled) {
          autoVoiceBootstrapPendingRef.current = true
          setVoicePlaybackEnabled(true)
        } else {
          autoVoiceBootstrapPendingRef.current = false
          stopSpeechPlayback()
          setVoicePlaybackEnabled(false)
        }
      }
    }

    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener('storage', handleStorage)
      if (channel) {
        try { channel.close() } catch {}
      }
      if (sharedVoiceChannelRef.current === channel) sharedVoiceChannelRef.current = null
    }
  }, [autoVoiceCursorStorageKey, sharedVoiceChannelName, sharedVoiceLockStorageKey, stopSpeechPlayback, voicePlaybackModePreferenceKey, voicePlaybackPreferenceKey])

  useEffect(() => {
    const enabled = readStoredVoicePlaybackEnabled(voicePlaybackPreferenceKey)
    if (enabled) {
      autoVoiceBootstrapPendingRef.current = true
      setVoicePlaybackEnabled(true)
      return
    }
    autoVoiceBootstrapPendingRef.current = false
    stopSpeechPlayback()
    setVoicePlaybackEnabled(false)
  }, [stopSpeechPlayback, voicePlaybackPreferenceKey])

  useEffect(() => {
    const handlePageHide = () => {
      stopSpeechPlayback()
    }
    window.addEventListener('pagehide', handlePageHide)
    return () => window.removeEventListener('pagehide', handlePageHide)
  }, [stopSpeechPlayback])

  const advanceAutoVoiceCursor = useCallback((candidates: AutoVoiceCandidate[]) => {
    if (candidates.length === 0) return
    const next = { ...autoVoiceCursorsRef.current }
    let changed = false
    candidates.forEach(candidate => {
      const existing = next[candidate.sessionId]
      if (existing && existing.lastSpokenMs >= candidate.createdMs) return
      next[candidate.sessionId] = {
        lastSpokenAt: candidate.createdAt,
        lastSpokenMs: candidate.createdMs,
        lastSpokenId: candidate.id,
      }
      changed = true
    })
    if (!changed) return
    autoVoiceCursorsRef.current = next
    writeStoredAutoVoiceCursors(autoVoiceCursorStorageKey, next)
  }, [autoVoiceCursorStorageKey])

  const isAutoVoiceCandidateAfterCursor = useCallback((candidate: AutoVoiceCandidate) => {
    const cursor = autoVoiceCursorsRef.current[candidate.sessionId]
    return !cursor || candidate.createdMs > cursor.lastSpokenMs
  }, [])

  const markCurrentVoiceCommandsSpoken = useCallback(() => {
    const mainOnly = sessions.filter(snapshot => assistantSnapshotRole(snapshot) === 'main').slice(0, 1)
    advanceAutoVoiceCursor(autoVoiceCandidatesFromSnapshots(mainOnly, clearCutoffs, voicePlaybackMode))
  }, [advanceAutoVoiceCursor, clearCutoffs, sessions, voicePlaybackMode])

  const speakText = useCallback(async (text: string, messageId = '') => {
    const content = String(text || '').trim()
    const chunks = splitVoiceTextForSpeech(content)
    if (chunks.length === 0) return
    const playbackLockMessageId = messageId || `manual:${stableVoiceHash(content)}`
    const playbackState = voicePlaybackStateRef.current
    const activeMessageId = activeVoiceMessageIdRef.current
    if (
      messageId
      && activeMessageId === messageId
      && (playbackState === 'loading' || playbackState === 'playing')
    ) {
      stopSpeechPlayback()
      return
    }

    if (voicePlaybackAbortRef.current || voiceAudioRef.current) stopSpeechPlayback()
    if (!claimSharedVoicePlaybackLock(playbackLockMessageId)) return

    const runId = voicePlaybackRunRef.current + 1
    voicePlaybackRunRef.current = runId
    const controller = new AbortController()
    voicePlaybackAbortRef.current = controller
    const isCurrentRun = () => (
      voicePlaybackRunRef.current === runId
      && voicePlaybackAbortRef.current === controller
      && !controller.signal.aborted
    )
    activeVoiceMessageIdRef.current = messageId
    voicePlaybackStateRef.current = 'loading'
    setActiveVoiceMessageId(messageId)
    setVoicePlaybackState('loading')

    const finishPlayback = () => {
      releaseSharedVoicePlaybackLock(playbackLockMessageId)
      cleanupSpeechAudio()
      voicePlaybackAbortRef.current = null
      voicePlaybackStateRef.current = 'idle'
      activeVoiceMessageIdRef.current = ''
      setVoicePlaybackState('idle')
      setVoicePlaybackMessage('')
      setActiveVoiceMessageId('')
    }

    const playAudioBlob = (blob: Blob, index: number, total: number) => new Promise<void>((resolve, reject) => {
      if (!isCurrentRun()) {
        resolve()
        return
      }
      cleanupSpeechAudio()
      const url = URL.createObjectURL(blob)
      voiceAudioUrlRef.current = url
      const audio = new Audio(url)
      voiceAudioRef.current = audio
      let settled = false
      const settle = (callback: () => void) => {
        if (settled) return
        settled = true
        controller.signal.removeEventListener('abort', handleAbort)
        callback()
      }
      const handleAbort = () => {
        settle(() => {
          cleanupSpeechAudio()
          resolve()
        })
      }
      controller.signal.addEventListener('abort', handleAbort, { once: true })
      audio.onplay = () => {
        if (!isCurrentRun() || voiceAudioRef.current !== audio) return
        voicePlaybackStateRef.current = 'playing'
        setVoicePlaybackState('playing')
        setVoicePlaybackMessage(total > 1 ? `正在播报小莫回复 ${index + 1}/${total}。` : '正在播报小莫回复。')
      }
      audio.onended = () => {
        if (!isCurrentRun() || voiceAudioRef.current !== audio) return
        settle(() => {
          cleanupSpeechAudio()
          resolve()
        })
      }
      audio.onerror = () => {
        if (!isCurrentRun() || voiceAudioRef.current !== audio) {
          settle(() => resolve())
          return
        }
        settle(() => {
          cleanupSpeechAudio()
          reject(new Error('音频播放失败，请稍后重试。'))
        })
      }
      audio.play().catch((error) => {
        if (!isCurrentRun() || controller.signal.aborted) {
          settle(() => resolve())
          return
        }
        settle(() => {
          cleanupSpeechAudio()
          reject(error)
        })
      })
    })

    try {
      for (let i = 0; i < chunks.length; i += 1) {
        if (!isCurrentRun()) return
        voicePlaybackStateRef.current = 'loading'
        setVoicePlaybackState('loading')
        setVoicePlaybackMessage(chunks.length > 1
          ? `正在生成${selectedVoiceLabel}播报 ${i + 1}/${chunks.length}...`
          : `正在生成${selectedVoiceLabel}播报...`)
        const blob = await fetchAssistantSpeech(chunks[i], selectedVoice, controller.signal)
        if (!isCurrentRun()) return
        await playAudioBlob(blob, i, chunks.length)
      }
      if (isCurrentRun()) finishPlayback()
    } catch (error: any) {
      if (!isCurrentRun() || controller.signal.aborted || error?.name === 'AbortError') {
        releaseSharedVoicePlaybackLock(playbackLockMessageId)
        return
      }
      releaseSharedVoicePlaybackLock(playbackLockMessageId)
      cleanupSpeechAudio()
      voicePlaybackAbortRef.current = null
      voicePlaybackStateRef.current = 'error'
      activeVoiceMessageIdRef.current = ''
      setVoicePlaybackState('error')
      setVoicePlaybackMessage(error?.message || '语音播报失败，请稍后重试。')
      setActiveVoiceMessageId('')
    }
  }, [claimSharedVoicePlaybackLock, cleanupSpeechAudio, releaseSharedVoicePlaybackLock, selectedVoice, selectedVoiceLabel, stopSpeechPlayback])

  const toggleVoicePlayback = useCallback(() => {
    setVoicePlaybackEnabled(value => {
      const next = !value
      writeStoredVoicePlaybackEnabled(voicePlaybackPreferenceKey, next)
      if (next) {
        autoVoiceBootstrapPendingRef.current = false
        markCurrentVoiceCommandsSpoken()
      } else {
        autoVoiceBootstrapPendingRef.current = false
        stopSpeechPlayback()
      }
      return next
    })
  }, [markCurrentVoiceCommandsSpoken, stopSpeechPlayback, voicePlaybackPreferenceKey])

  useEffect(() => {
    return () => {
      clearCollapsedVoiceHoldTimer()
      collapsedVoicePointerIdRef.current = null
      collapsedVoiceStartedRef.current = false
      stopCollapsedVoiceAfterStartRef.current = false
      clearVoiceTimers()
      voiceRecordFailedRef.current = true
      try {
        const recorder = mediaRecorderRef.current
        if (recorder && recorder.state !== 'inactive') recorder.stop()
      } catch {}
      stopVoiceStream()
      stopSpeechPlayback()
    }
  }, [clearCollapsedVoiceHoldTimer, clearVoiceTimers, stopSpeechPlayback, stopVoiceStream])

  const activeCount = useMemo(() => sessions.filter(needsPolling).length, [sessions])
  const pendingActiveCount = useMemo(() => pendingTurns.filter(turn => !turn.failed).length, [pendingTurns])
  const mainSnapshot = useMemo(
    () => sessions.find(snapshot => assistantSnapshotRole(snapshot) === 'main') || null,
    [sessions],
  )
  const currentSnapshot = useMemo(() => {
    if (activeSessionId) {
      const selected = sessions.find(snapshot => snapshot.session.session_id === activeSessionId)
      if (selected) return selected
    }
    return mainSnapshot || sessions[0] || null
  }, [activeSessionId, mainSnapshot, sessions])
  const currentSessionId = currentSnapshot?.session?.session_id || ''
  const currentSessionName = currentSnapshot?.session?.name || currentSessionId
  const currentSessionRole = assistantSnapshotRole(currentSnapshot)
  const currentSessionUrl = useMemo(
    () => sessionPageUrl(user?.id, currentSnapshot),
    [currentSnapshot, user?.id],
  )
  const currentStreamConnected = !!currentSessionId && streamSessionId === currentSessionId
  const hasLoadedRef = useRef(false)
  const currentClearCutoff = currentSessionId ? clearCutoffs[currentSessionId] || '' : ''

  useEffect(() => {
    if (activeSessionId && sessions.some(snapshot => snapshot.session.session_id === activeSessionId)) return
    const mainId = mainSnapshot?.session.session_id || sessions[0]?.session.session_id || ''
    if (mainId !== activeSessionId) setActiveSessionId(mainId)
  }, [activeSessionId, mainSnapshot, sessions])

  const persistClearCutoffs = useCallback((updater: (current: Record<string, string>) => Record<string, string>) => {
    setClearCutoffs(current => {
      const next = updater(current)
      writeAssistantClearCutoffs(clearCutoffStorageKey, next)
      return next
    })
  }, [clearCutoffStorageKey])

  const visibleMessagesForSnapshot = useCallback((snapshot: AssistantSnapshot) => {
    const cutoff = clearCutoffs[snapshot.session.session_id] || ''
    return messagesForSnapshot(snapshot).filter(message => shouldShowConversationMessage(message, cutoff))
  }, [clearCutoffs])

  const visiblePendingTurns = useMemo(() => pendingTurns.filter(turn => {
    const sid = turn.session_id || currentSessionId
    const cutoff = sid ? clearCutoffs[sid] || '' : ''
    if (currentSessionId && sid && sid !== currentSessionId) return false
    return shouldShowConversationMessage({
      role: 'user',
      content: turn.content,
      created_at: turn.created_at,
    }, cutoff)
  }), [clearCutoffs, currentSessionId, pendingTurns])
  const latestActivePendingTurnId = useMemo(() => {
    for (let i = visiblePendingTurns.length - 1; i >= 0; i -= 1) {
      if (!visiblePendingTurns[i].failed) return visiblePendingTurns[i].id
    }
    return ''
  }, [visiblePendingTurns])

  const currentVisibleMessages = useMemo(
    () => currentSnapshot ? visibleMessagesForSnapshot(currentSnapshot) : [],
    [currentSnapshot, visibleMessagesForSnapshot],
  )
  const renderedCurrentVisibleMessages = useMemo<RenderedAssistantConversationMessage[]>(
    () => currentVisibleMessages.map(message => ({
      ...message,
      render_id: currentSessionId ? `${currentSessionId}:${message.id}` : message.id,
    })),
    [currentSessionId, currentVisibleMessages],
  )
  const visibleMessageCount = currentVisibleMessages.length

  const startDrag = useCallback((event: MouseEvent) => {
    if (isPanelFullscreen) return
    if ((event.target as Element).closest('button, a, input, select, textarea')) return
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    event.preventDefault()
    interactionRef.current = {
      type: 'drag',
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      startWidth: rect.width,
      startHeight: rect.height,
      edges: { n: false, s: false, e: false, w: false },
    }
  }, [isPanelFullscreen])

  const startResize = useCallback((event: MouseEvent, edges: PanelInteraction['edges']) => {
    if (isPanelFullscreen) return
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    event.preventDefault()
    event.stopPropagation()
    interactionRef.current = {
      type: 'resize',
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      startWidth: rect.width,
      startHeight: rect.height,
      edges,
    }
  }, [isPanelFullscreen])

  useEffect(() => {
    const onMove = (event: globalThis.MouseEvent) => {
      const interaction = interactionRef.current
      if (!interaction) return

      const dx = event.clientX - interaction.startX
      const dy = event.clientY - interaction.startY

      if (interaction.type === 'drag') {
        const next = clampPanelRect(
          interaction.startLeft + dx,
          interaction.startTop + dy,
          interaction.startWidth,
          interaction.startHeight,
        )
        setPanelStyle({ left: next.left, top: next.top, right: 'auto', bottom: 'auto', width: next.width, height: next.height })
        return
      }

      const { edges } = interaction
      let left = interaction.startLeft
      let top = interaction.startTop
      let width = interaction.startWidth
      let height = interaction.startHeight

      if (edges.e) width = interaction.startWidth + dx
      if (edges.s) height = interaction.startHeight + dy
      if (edges.w) {
        left = interaction.startLeft + dx
        width = interaction.startWidth - dx
      }
      if (edges.n) {
        top = interaction.startTop + dy
        height = interaction.startHeight - dy
      }

      const next = clampPanelRect(left, top, width, height)
      setPanelStyle({ left: next.left, top: next.top, right: 'auto', bottom: 'auto', width: next.width, height: next.height })
    }

    const onUp = () => {
      interactionRef.current = null
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  useEffect(() => {
    interactionRef.current = null
    setPanelStyle({})
  }, [panelSize])

  // 视口尺寸变化时把 FAB 拉回可视区 (重新吸附到左/右边缘)
  useEffect(() => {
    const onResize = () => {
      setFabPos(prev => (prev ? snapFabToEdge(prev.left, prev.top) : prev))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const refreshProjects = useCallback(() => {
    api('/api/projects').then((arr: any[]) => setProjects(arr || [])).catch(() => {})
  }, [setProjects])

  const loadHistory = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      await api('/api/assistant/workspace').catch(() => null)
      const data = await api(`/api/assistant/sessions?limit=${HISTORY_LIMIT}`) as { sessions?: AssistantSnapshot[] }
      const next = sortAssistantSnapshots(Array.isArray(data.sessions) ? data.sessions : [])
      setSessions(next)
      setActiveSessionId(current => {
        if (current && next.some(snapshot => snapshot.session.session_id === current)) return current
        return next.find(snapshot => assistantSnapshotRole(snapshot) === 'main')?.session.session_id
          || next[0]?.session.session_id
          || ''
      })
      refreshProjects()
      hasLoadedRef.current = true
    } catch (e: any) {
      setErr(e?.message || '读取小莫历史失败')
    } finally {
      setLoading(false)
    }
  }, [refreshProjects])

  useEffect(() => {
    if ((!open && !voicePlaybackEnabled) || hasLoadedRef.current) return
    void loadHistory()
  }, [loadHistory, open, voicePlaybackEnabled])

  const refreshSnapshot = useCallback(async (sessionId: string) => {
    if (!sessionId) return
    try {
      const snapshot = await api(`/api/assistant/sessions/${encodeURIComponent(sessionId)}`) as AssistantSnapshot
      setSessions(prev => mergeSnapshot(prev, snapshot))
    } catch {
      /* Polling should not make the panel noisy. */
    }
  }, [])

  const applyJsonlEntries = useCallback((
    sessionId: string,
    entries: any[],
    mode: 'replace' | 'append',
    meta: Partial<AssistantSnapshot['jsonl']> = {},
    statusPatch: Partial<NonNullable<AssistantSnapshot['status']>> = {},
  ) => {
    if (!sessionId) return
    const previous = jsonlEntriesRef.current[sessionId] || []
    const nextEntries = mode === 'replace' ? entries : previous.concat(entries)
    jsonlEntriesRef.current = {
      ...jsonlEntriesRef.current,
      [sessionId]: nextEntries,
    }
    setSessions(prev => prev.map(snapshot => (
      snapshot.session.session_id === sessionId
        ? mergeJsonlEntriesIntoSnapshot(snapshot, nextEntries, meta, statusPatch)
        : snapshot
    )))
  }, [])

  useEffect(() => {
    if ((!open && !voicePlaybackEnabled) || !currentSessionId) {
      if (eventSourceRef.current) {
        try { eventSourceRef.current.close() } catch {}
        eventSourceRef.current = null
      }
      setStreamSessionId('')
      return undefined
    }

    const token = localStorage.getItem('cc-token') || ''
    if (!token) return undefined

    if (eventSourceRef.current) {
      try { eventSourceRef.current.close() } catch {}
      eventSourceRef.current = null
    }

    const sid = currentSessionId
    const source = new EventSource(`/api/sessions/${encodeURIComponent(sid)}/events?token=${encodeURIComponent(token)}`)
    eventSourceRef.current = source
    setStreamSessionId('')

    source.onopen = () => {
      if (source !== eventSourceRef.current) return
      setStreamSessionId(sid)
    }

    source.onerror = () => {
      if (source !== eventSourceRef.current) return
      setStreamSessionId('')
    }

    const handleStreamMessage = (event: MessageEvent) => {
      if (source !== eventSourceRef.current) return
      try {
        const msg = JSON.parse(event.data)
        if (msg.session_id && msg.session_id !== sid) return

        if (msg.event === 'jsonl_history') {
          const entries = Array.isArray(msg.entries) ? msg.entries : []
          const isChunked = typeof msg.chunk_index === 'number' || typeof msg.done === 'boolean'
          const meta = {
            total: typeof msg.total === 'number' ? msg.total : undefined,
            total_approximate: !!msg.total_approximate,
            truncated: !!msg.truncated,
          }
          if (!isChunked || msg.reset) {
            applyJsonlEntries(sid, entries, 'replace', meta)
          } else if (entries.length > 0) {
            applyJsonlEntries(sid, entries, 'append', meta)
          } else if (msg.done) {
            applyJsonlEntries(sid, [], 'append', meta)
          }
        } else if (msg.event === 'jsonl_entry') {
          if (typeof msg.entry === 'undefined') return
          const statusPatch = isTurnCompleteEntry(msg.entry)
            ? { working: false, agent_status: 'idle' as const }
            : (isAssistantActivityEntry(msg.entry)
                ? { working: true, agent_status: 'running' as const }
                : {})
          applyJsonlEntries(sid, [msg.entry], 'append', {}, statusPatch)
          if (isTurnCompleteEntry(msg.entry)) {
            window.setTimeout(() => { void refreshSnapshot(sid) }, 300)
            refreshProjects()
          }
        } else if (msg.event === 'typing' && msg.active === false) {
          setSessions(prev => prev.map(snapshot => (
            snapshot.session.session_id === sid
              ? {
                  ...snapshot,
                  status: { ...(snapshot.status || {}), working: false, agent_status: 'idle' },
                }
              : snapshot
          )))
        } else if (msg.event === 'error' && typeof msg.message === 'string') {
          setErr(msg.message)
        }
      } catch {
        /* Ignore malformed event frames from a reconnecting stream. */
      }
    }

    ;['jsonl_history', 'jsonl_entry', 'typing', 'server_error']
      .forEach(eventName => source.addEventListener(eventName, handleStreamMessage as EventListener))

    return () => {
      if (source === eventSourceRef.current) {
        try { source.close() } catch {}
        eventSourceRef.current = null
      } else {
        try { source.close() } catch {}
      }
      setStreamSessionId('')
    }
  }, [applyJsonlEntries, currentSessionId, open, refreshProjects, refreshSnapshot, voicePlaybackEnabled])

  useEffect(() => {
    if (!open && !voicePlaybackEnabled) return undefined
    const targets = sessions.filter(needsPolling).map(item => item.session.session_id)
    if (targets.length === 0) return undefined
    const timer = window.setInterval(() => {
      targets.forEach(sessionId => { void refreshSnapshot(sessionId) })
    }, currentStreamConnected ? 10_000 : (open ? 2500 : 3500))
    return () => window.clearInterval(timer)
  }, [currentStreamConnected, open, refreshSnapshot, sessions, voicePlaybackEnabled])

  // 用户在日志区内滚动时,实时记录是否吸附在底部;
  // 离底部超过阈值视为"在阅读历史",新消息不再打断滚动。
  useEffect(() => {
    if (!open) return
    const el = logRef.current
    if (!el) return
    const handleScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottomRef.current = distanceFromBottom <= 80
    }
    handleScroll()
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [open])

  // 强制吸附底部:打开面板、切换 Session、用户主动发送消息时,
  // 用 useLayoutEffect 在浏览器绘制前完成滚动,避免顶→底闪屏。
  useLayoutEffect(() => {
    if (!open) return
    const el = logRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickToBottomRef.current = true
  }, [open, currentSessionId, submitNonce])

  // 流式新内容到达时,只在用户已经吸附底部的情况下跟随滚动。
  useLayoutEffect(() => {
    if (!open) return
    if (!stickToBottomRef.current) return
    const el = logRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [sessions, pendingTurns])

  useEffect(() => {
    setPendingTurns(prev => {
      let changed = false
      const next = prev.flatMap(turn => {
        if (turn.failed || !turn.session_id) return [turn]
        const snapshot = sessions.find(item => item.session.session_id === turn.session_id)
        if (!snapshot) return [turn]
        if (snapshot.status?.failed) {
          changed = true
          return []
        }
        if ((snapshot.responses || []).length > turn.baseline_response_count) {
          changed = true
          return []
        }
        if (turn.show_user && snapshotContainsPendingTurnUser(snapshot, turn)) {
          changed = true
          return [{ ...turn, show_user: false }]
        }
        return [turn]
      })
      return changed ? next : prev
    })
  }, [sessions])

  const autoVoiceCandidates = useMemo(
    () => autoVoiceCandidatesFromSnapshots(mainSnapshot ? [mainSnapshot] : [], clearCutoffs, voicePlaybackMode),
    [clearCutoffs, mainSnapshot, voicePlaybackMode],
  )

  useEffect(() => {
    if (!voicePlaybackEnabled) return
    if (autoVoiceBootstrapPendingRef.current && (hasLoadedRef.current || sessions.length > 0)) {
      const candidatesForNewSessionCursors = autoVoiceCandidates
        .filter(candidate => !autoVoiceCursorsRef.current[candidate.sessionId])
      advanceAutoVoiceCursor(candidatesForNewSessionCursors)
      autoVoiceBootstrapPendingRef.current = false
    }
  }, [advanceAutoVoiceCursor, autoVoiceCandidates, sessions.length, voicePlaybackEnabled])

  useEffect(() => {
    if (!voicePlaybackEnabled) return
    if (voicePlaybackState !== 'idle') return
    const playable = autoVoiceCandidates.filter(isAutoVoiceCandidateAfterCursor)
    if (playable.length === 0) return

    const next = playable[playable.length - 1]
    if (!next) return
    advanceAutoVoiceCursor(playable)
    void speakText(next.text, next.id)
  }, [advanceAutoVoiceCursor, autoVoiceCandidates, isAutoVoiceCandidateAfterCursor, speakText, voicePlaybackEnabled, voicePlaybackState])

  useEffect(() => {
    if (!mainSnapshot?.session?.session_id) return
    const mainSessionId = mainSnapshot.session.session_id
    const cursors = cloneReportCursorsRef.current
    const nextCursors = { ...cursors }
    let changed = false

    sessions.forEach(snapshot => {
      if (!isCloneCompletionCandidate(snapshot)) return
      const text = latestAssistantVisibleText(snapshot)
      if (!text) return
      const key = `${snapshot.session.session_id}:${stableVoiceHash(text)}`
      if (cursors[snapshot.session.session_id] === key) return
      nextCursors[snapshot.session.session_id] = key
      changed = true
      const report = [
        `【分身完成回传】${snapshot.session.name}`,
        `Session ID: ${snapshot.session.session_id}`,
        '',
        text,
        '',
        '请主体小莫把这条分身结果整合到当前对话。需要提醒用户时，只能由主体小莫输出 PushVoiceToUser("播报文本")。',
      ].join('\n')
      void api(`/api/sessions/${encodeURIComponent(mainSessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: report,
          input_text: report,
          request_id: `assistant-clone-report-${snapshot.session.session_id}-${Date.now()}`,
        }),
      })
        .then(() => refreshSnapshot(mainSessionId))
        .catch(() => {
          delete nextCursors[snapshot.session.session_id]
          cloneReportCursorsRef.current = { ...nextCursors }
          writeCloneReportCursors(cloneReportCursorStorageKey, cloneReportCursorsRef.current)
        })
    })

    if (!changed) return
    cloneReportCursorsRef.current = nextCursors
    writeCloneReportCursors(cloneReportCursorStorageKey, nextCursors)
  }, [cloneReportCursorStorageKey, mainSnapshot, refreshSnapshot, sessions])

  const sendContent = useCallback(async (content: string, restoreOnError = false, options: SendContentOptions = {}) => {
    const text = content.trim()
    const promptAttachments = Array.isArray(options.attachments) ? options.attachments : []
    if (sending) return
    if (!text && promptAttachments.length === 0) return
    if (attachments.some(attachment => attachment.status === 'uploading')) {
      setErr('附件仍在上传，请稍候再发送')
      return
    }
    const showUser = options.showUser !== false
    const submittedDraft = text
    const requestId = `assistant-panel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const baselineSnapshot = currentSnapshot
    const attachmentBlock = promptAttachments.length > 0
      ? ['[图片附件]', ...promptAttachments.map(image => `- ${image.path}`)].join('\n')
      : ''
    const outboundContent = [attachmentBlock, text].filter(Boolean).join('\n\n')
    const optimisticTurn: PendingAssistantTurn = {
      id: `pending:${requestId}`,
      request_id: requestId,
      content: outboundContent,
      created_at: new Date().toISOString(),
      session_id: baselineSnapshot?.session?.session_id || null,
      baseline_response_count: (baselineSnapshot?.responses || []).length,
      show_user: showUser,
    }
    if (restoreOnError) setInput('', { persist: false })
    setPendingTurns(prev => prev.concat(optimisticTurn))
    setSubmitNonce(n => n + 1)
    setSending(true)
    setErr('')
    try {
      let snapshot: AssistantSnapshot
      if (baselineSnapshot?.session?.session_id && assistantSnapshotRole(baselineSnapshot) === 'clone') {
        await api(`/api/sessions/${encodeURIComponent(baselineSnapshot.session.session_id)}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            content: outboundContent,
            input_text: text,
            request_id: requestId,
            attachments: promptAttachments,
          }),
        })
        snapshot = await api(`/api/assistant/sessions/${encodeURIComponent(baselineSnapshot.session.session_id)}`) as AssistantSnapshot
      } else {
        snapshot = await api('/api/assistant/messages', {
          method: 'POST',
          body: JSON.stringify({
            content: outboundContent,
            input_text: text,
            client_context: buildAssistantClientContext(user),
            request_id: requestId,
            attachments: promptAttachments,
          }),
        }) as AssistantSnapshot
      }
      setSessions(prev => mergeSnapshot(prev, snapshot))
      setActiveSessionId(snapshot.session.session_id)
      if (restoreOnError) clearInputDraft(submittedDraft)
      setPendingTurns(prev => prev.flatMap(turn => {
        if (turn.request_id !== requestId) return [turn]
        const responseCount = (snapshot.responses || []).length
        if (snapshot.status?.failed || responseCount > turn.baseline_response_count) return []
        return [{
          ...turn,
          session_id: snapshot.session.session_id,
          show_user: !snapshotContainsPendingTurnUser(snapshot, turn),
        }]
      }))
      refreshProjects()
      if (promptAttachments.length > 0) clearAttachments()
    } catch (e: any) {
      setErr(e?.message || '发送小莫消息失败')
      setPendingTurns(prev => prev.map(turn => (
        turn.request_id === requestId ? { ...turn, failed: true } : turn
      )))
      if (restoreOnError) setInput(current => (current.trim() ? current : text))
    } finally {
      setSending(false)
    }
  }, [attachments, clearAttachments, clearInputDraft, currentSnapshot, refreshProjects, sending, setInput, user])
  sendContentRef.current = sendContent

  const send = useCallback(async () => {
    flushInputDraftSave()
    const readyAttachments = attachments.filter(attachment => attachment.status === 'done' && attachment.remotePath)
    const promptAttachments: AssistantPromptAttachment[] = readyAttachments.map(attachment => ({
      type: attachment.kind,
      path: attachment.remotePath!,
      name: attachment.name,
      size: attachment.size,
      mime_type: attachment.type,
    }))
    await sendContent(input, true, { attachments: promptAttachments })
  }, [attachments, flushInputDraftSave, input, sendContent])

  const sendCompactCommand = useCallback(() => {
    setCompactConfirmOpen(false)
    if (!currentSessionId) {
      setErr('请先发送一条小莫消息，再压缩上文')
      return
    }
    void sendContent('/compact', false, { showUser: false })
  }, [currentSessionId, sendContent])

  const clearVisibleConversation = useCallback(() => {
    if (!currentSessionId) {
      setErr('请先发送一条小莫消息，再清空前端对话')
      return
    }
    if (sending) return
    const sid = currentSessionId
    const cutoff = new Date().toISOString()
    setErr('')
    persistClearCutoffs(current => ({
      ...current,
      [sid]: cutoff,
    }))
    void sendContent('/compact', false, { showUser: false })
  }, [currentSessionId, persistClearCutoffs, sendContent, sending])

  const openCloneModal = useCallback(() => {
    setCloneCreateErr('')
    const currentSessionModel = currentSnapshot?.session.model || ''
    const fallbackModel = cloneModelOptions[0]?.key || 'codex'
    setCloneDraft(current => ({
      ...current,
      task: input.trim() || current.task,
      model: cloneModelOptions.some(option => option.key === current.model)
        ? current.model
        : (currentSessionModel && cloneModelOptions.some(option => option.key === currentSessionModel)
          ? currentSessionModel
          : fallbackModel),
      language: 'zh',
    }))
    setCloneModalOpen(true)
  }, [cloneModelOptions, currentSnapshot?.session.model, input])

  const createCloneSession = useCallback(async () => {
    if (creatingClone || sending) return
    const task = cloneDraft.task.trim()
    if (!task) {
      setCloneCreateErr('请先填写分身任务。')
      return
    }
    const cloneNo = nextAssistantCloneNumber(sessions)
    const cloneName = `${ASSISTANT_CLONE_SESSION_PREFIX}${cloneNo} - ${summarizeCloneTask(task)}`
    const requestId = `assistant-clone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    setCreatingClone(true)
    setCloneCreateErr('')
    setErr('')
    try {
      const workspace = await api('/api/assistant/workspace') as { issue?: { id?: string }, project?: { id?: string } }
      const issueId = workspace?.issue?.id
      if (!issueId) throw new Error('未找到小莫 Issue，无法创建分身')
      const created = await api(`/api/issues/${encodeURIComponent(issueId)}/sessions/`, {
        method: 'POST',
        body: JSON.stringify({
          name: cloneName,
          description: [
            '分身小莫模板：只处理主体小莫或用户交给它的单项任务。',
            '禁止递归创建分身，禁止输出 PushVoiceToUser，完成后给出可回传主体小莫的简洁结果。',
            `模型参数：model=${cloneDraft.model}, language=${cloneDraft.language}`,
          ].join('\n'),
          model: cloneDraft.model || currentSnapshot?.session.model || undefined,
          language: cloneDraft.language,
        }),
      }) as { session_id?: string }
      const sessionId = created?.session_id
      if (!sessionId) throw new Error('分身 Session 创建失败')
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: clonePromptTemplate(task, cloneName),
          input_text: task,
          request_id: requestId,
        }),
      })
      const snapshot = await api(`/api/assistant/sessions/${encodeURIComponent(sessionId)}`) as AssistantSnapshot
      setSessions(prev => mergeSnapshot(prev, snapshot))
      setActiveSessionId(sessionId)
      setCloneModalOpen(false)
      setCloneDraft(current => ({ ...current, task: '' }))
      if (input.trim() && input.trim() === task) clearInputDraft(input)
      refreshProjects()
    } catch (e: any) {
      setCloneCreateErr(e?.message || '创建分身小莫失败')
    } finally {
      setCreatingClone(false)
    }
  }, [clearInputDraft, cloneDraft, creatingClone, currentSnapshot?.session.model, input, refreshProjects, sending, sessions])

  const openCurrentSession = useCallback(() => {
    if (!currentSessionUrl) return
    window.open(currentSessionUrl, '_blank', 'noopener,noreferrer')
  }, [currentSessionUrl])

  const openSkillEditor = useCallback(() => {
    if (user?.role !== 'admin' || !user?.id) return
    const token = (typeof localStorage !== 'undefined' && localStorage.getItem('cc-token')) || ''
    if (!token) return
    const url = `/code-server/${encodeURIComponent(user.id)}__xm-skills/?_jwt=${encodeURIComponent(token)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [user?.id, user?.role])

  const removeSessionFromPanel = useCallback((sid: string) => {
    jsonlEntriesRef.current = Object.fromEntries(
      Object.entries(jsonlEntriesRef.current).filter(([sessionId]) => sessionId !== sid),
    )
    setSessions(prev => prev.filter(snapshot => snapshot.session.session_id !== sid))
    setPendingTurns(prev => prev.filter(turn => !turn.session_id || turn.session_id !== sid))
    setClearCutoffs(current => {
      if (!Object.prototype.hasOwnProperty.call(current, sid)) return current
      const next = { ...current }
      delete next[sid]
      writeAssistantClearCutoffs(clearCutoffStorageKey, next)
      return next
    })
  }, [clearCutoffStorageKey])

  const deleteAssistantSessionById = useCallback(async (sid: string) => {
    await api(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' })
    removeSessionFromPanel(sid)
  }, [removeSessionFromPanel])

  const deleteCloneSession = useCallback(async (sid: string) => {
    if (!sid || deletingSession) return
    setDeletingSession(true)
    setDeleteErr('')
    setErr('')
    try {
      await deleteAssistantSessionById(sid)
      if (activeSessionId === sid) {
        const fallbackId = mainSnapshot?.session.session_id || ''
        setActiveSessionId(fallbackId)
      }
      refreshProjects()
    } catch (e: any) {
      setErr(e?.message || '删除分身小莫失败')
    } finally {
      setDeletingSession(false)
    }
  }, [activeSessionId, deleteAssistantSessionById, deletingSession, mainSnapshot?.session.session_id, refreshProjects])

  const deleteCurrentSession = useCallback(async () => {
    if (!currentSessionId || deletingSession) return
    const sid = currentSessionId
    setDeletingSession(true)
    setDeleteErr('')
    setErr('')
    try {
      const deleteIds = assistantSnapshotRole(currentSnapshot) === 'main'
        ? sessions
            .filter(snapshot => snapshot.session.session_id !== sid && assistantSnapshotRole(snapshot) === 'clone')
            .map(snapshot => snapshot.session.session_id)
            .concat(sid)
        : [sid]
      for (const id of deleteIds) {
        await deleteAssistantSessionById(id)
      }
      if (eventSourceRef.current) {
        try { eventSourceRef.current.close() } catch {}
        eventSourceRef.current = null
      }
      setStreamSessionId('')
      setActiveSessionId('')
      hasLoadedRef.current = false
      refreshProjects()
      setDeleteConfirmOpen(false)
    } catch (e: any) {
      setDeleteErr(e?.message || '删除当前小莫 Session 失败')
    } finally {
      setDeletingSession(false)
    }
  }, [currentSessionId, currentSnapshot, deleteAssistantSessionById, deletingSession, refreshProjects, sessions])

  const headerSubtitle = sending
    ? (currentSessionId ? '正在发送到当前 Session' : '正在创建主小莫')
    : activeCount > 0 || pendingActiveCount > 0
      ? '小莫 Session 正在回复'
      : currentSessionId
        ? (currentSessionRole === 'main' ? '主体负责分发、汇总和播报' : '分身只处理当前单项任务')
        : '首次提问会创建主小莫'
  const openSessionTip = currentSessionUrl ? '在新窗口打开当前 Session' : '小莫 Session 创建后可跳转'
  const deleteSessionTip = currentSessionId ? '删除当前小莫 Session' : '小莫 Session 创建后可删除'
  const clearConversationTip = currentSessionId
    ? '清空前端对话并压缩上文'
    : '小莫 Session 创建后可清空前端对话'
  const resizeTip = panelSize === 'compact'
    ? '放大查看'
    : panelSize === 'expanded'
      ? '全屏查看'
      : '还原窗口'
  const voiceBusy = voiceState === 'recording' || voiceState === 'transcribing'
  const attachmentUploading = attachments.some(attachment => attachment.status === 'uploading')
  const readyAttachmentCount = attachments.filter(attachment => attachment.status === 'done' && attachment.remotePath).length
  const canSendAssistantMessage = !!input.trim() || readyAttachmentCount > 0
  const attachmentButtonTip = attachments.length >= ASSISTANT_ATTACHMENT_MAX_COUNT
    ? `最多添加 ${ASSISTANT_ATTACHMENT_MAX_COUNT} 个附件`
    : '添加附件，也可粘贴截图或拖放文件'
  const voiceTip = voiceState === 'recording'
    ? `停止录音并发送 ${formatVoiceSeconds(recordingSeconds)}`
    : voiceState === 'transcribing'
      ? '正在转写并发送语音'
      : '语音输入'
  const voicePlaybackModeLabel = voicePlaybackMode === 'selected' ? '播报精选' : '播报全部'
  const voicePlaybackModeTip = voicePlaybackMode === 'selected'
    ? '播报精选：只播 PushVoiceToUser 中的精选文本'
    : '播报全部：播完整可见回复'
  const voicePlaybackTip = voicePlaybackEnabled ? `关闭回复语音播报 · ${voicePlaybackModeLabel}` : `开启回复语音播报 · ${voicePlaybackModeLabel}`
  const voicePlaybackStatusText = voicePlaybackMessage
    ? voicePlaybackMessage
    : voicePlaybackEnabled
      ? `已开启${voicePlaybackModeLabel} · ${selectedVoiceLabel}`
      : ''
  const toolbarAuxText = voicePlaybackStatusText
    || (currentClearCutoff ? `已隐藏 ${formatTime(currentClearCutoff)} 前端消息` : '')
  const currentSessionDisplayName = currentSessionName || '我的主小莫（待创建）'
  const currentSessionDetailText = currentSessionId ? `ID: ${currentSessionId}` : '首次提问会创建我的主小莫'
  const fabSpeaking = voicePlaybackState === 'playing'
  const fabVoiceHolding = !open && collapsedVoiceHoldState === 'holding'
  const fabVoiceRecording = !open && collapsedVoiceHoldState === 'recording'
  const fabVoiceTranscribing = !open && voiceState === 'transcribing'
  const fabVoiceActive = fabVoiceHolding || fabVoiceRecording || fabVoiceTranscribing
  const fabTitle = fabVoiceRecording
    ? '松开结束录音'
    : fabVoiceTranscribing
      ? '正在转写语音'
      : fabVoiceHolding
        ? '继续长按进入语音输入'
        : fabSpeaking
          ? `${ASSISTANT_NAME}正在说话`
          : (open ? `收起${ASSISTANT_NAME}` : `打开${ASSISTANT_NAME}`)
  const fabClassName = [
    'assistant-fab fixed z-[60] w-14 h-14 rounded-full flex items-center justify-center',
    // 有自定义位置时用 inline left/top, 否则回落到默认右下角
    fabPos ? '' : 'bottom-5 right-5',
    // 拖动进行中关掉过渡 (跟随指针不拖尾), 释放后恢复过渡以平滑吸附
    fabDragging ? 'assistant-fab--dragging' : 'transition-all hover:scale-105',
    fabSpeaking ? 'assistant-fab--speaking' : '',
    fabVoiceHolding ? 'assistant-fab--voice-holding' : '',
    fabVoiceRecording ? 'assistant-fab--voice-recording' : '',
    fabVoiceTranscribing ? 'assistant-fab--voice-transcribing' : '',
  ].filter(Boolean).join(' ')

  return (
    <>
      <button
        data-testid="assistant-bubble"
        data-tour="assistant-bubble"
        onPointerDown={handleFabPointerDown}
        onPointerMove={handleFabPointerMove}
        onPointerUp={finishCollapsedVoiceHold}
        onPointerCancel={finishCollapsedVoiceHold}
        onClick={handleFabClick}
        onContextMenu={event => {
          if (collapsedVoiceHoldState !== 'idle') event.preventDefault()
        }}
        title={fabTitle}
        className={fabClassName}
        style={fabPos ? { left: fabPos.left, top: fabPos.top, right: 'auto', bottom: 'auto' } : undefined}
      >
        <MoAvatar size="lg" active={open || sending || activeCount > 0 || pendingActiveCount > 0 || fabSpeaking || fabVoiceActive} />
        {fabSpeaking ? (
          <span className="assistant-fab__speaking-waves" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        ) : null}
        {fabVoiceHolding ? <span className="assistant-fab__hold-ring" aria-hidden="true" /> : null}
        {fabVoiceRecording || fabVoiceTranscribing ? (
          <span className="assistant-fab__voice-badge" aria-hidden="true">
            {fabVoiceTranscribing ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Mic className="h-3.5 w-3.5" />
            )}
          </span>
        ) : null}
        {open ? (
          <span className="assistant-fab__close">
            <X className="h-4 w-4" strokeWidth={2.2} />
          </span>
        ) : null}
        {!open && unreadCompletion > 0 ? (
          <span className="assistant-fab__completion-badge" aria-hidden="true">
            {unreadCompletion === 1 ? '任务已完成' : `${unreadCompletion} 项任务完成`}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          ref={panelRef}
          data-testid="assistant-panel"
          className={`assistant-panel fixed z-[60] rounded-2xl shadow-2xl overflow-hidden ${panelSizeClass}`}
          style={panelStyle}
        >
          {!isPanelFullscreen ? (
            <>
              <div className="assistant-resize-handle assistant-resize-n" onMouseDown={event => startResize(event, { n: true, s: false, e: false, w: false })} />
              <div className="assistant-resize-handle assistant-resize-s" onMouseDown={event => startResize(event, { n: false, s: true, e: false, w: false })} />
              <div className="assistant-resize-handle assistant-resize-e" onMouseDown={event => startResize(event, { n: false, s: false, e: true, w: false })} />
              <div className="assistant-resize-handle assistant-resize-w" onMouseDown={event => startResize(event, { n: false, s: false, e: false, w: true })} />
              <div className="assistant-resize-handle assistant-resize-ne" onMouseDown={event => startResize(event, { n: true, s: false, e: true, w: false })} />
              <div className="assistant-resize-handle assistant-resize-nw" onMouseDown={event => startResize(event, { n: true, s: false, e: false, w: true })} />
              <div className="assistant-resize-handle assistant-resize-se" onMouseDown={event => startResize(event, { n: false, s: true, e: true, w: false })} />
              <div className="assistant-resize-handle assistant-resize-sw" onMouseDown={event => startResize(event, { n: false, s: true, e: false, w: true })} />
            </>
          ) : null}

          <div className="assistant-chat-shell">
            <aside
              className={`assistant-session-sidebar${sidebarCollapsed ? ' assistant-session-sidebar--collapsed' : ''}`}
              style={sidebarCollapsed ? undefined : { width: sidebarWidth, minWidth: sidebarWidth }}
            >
              {!sidebarCollapsed && (
                <div
                  className="mobius-resizable-handle assistant-session-sidebar__resize"
                  onMouseDown={onSidebarResizeStart}
                  onDoubleClick={onSidebarResizeReset}
                  title="拖拽调整宽度 · 双击恢复默认"
                />
              )}
              <div className="assistant-session-sidebar__header">
                {!sidebarCollapsed ? (
                  <div>
                    <div className="assistant-session-sidebar__title">小莫列表</div>
                    <div className="assistant-session-sidebar__meta">{sessions.length} 个 Session</div>
                  </div>
                ) : null}
                <AssistantTooltip label={sidebarCollapsed ? '展开列表' : '折叠列表'} side="top">
                  <button
                    type="button"
                    className="assistant-icon-button"
                    aria-label={sidebarCollapsed ? '展开小莫列表' : '折叠小莫列表'}
                    onClick={() => setSidebarCollapsed(value => !value)}
                  >
                    {sidebarCollapsed ? <ChevronsRight className="h-3.5 w-3.5" /> : <ChevronsLeft className="h-3.5 w-3.5" />}
                  </button>
                </AssistantTooltip>
              </div>
              <div className="assistant-session-sidebar__list" role="list">
                {sessions.length === 0 ? (
                  <button
                    type="button"
                    className="assistant-session-list-item assistant-session-list-item--empty"
                    onClick={() => setActiveSessionId('')}
                  >
                    <span className="assistant-session-list-item__dot assistant-session-list-item__dot--idle" />
                    {!sidebarCollapsed ? <span>我的主小莫</span> : null}
                  </button>
                ) : sessions.map(snapshot => {
                  const role = assistantSnapshotRole(snapshot)
                  const status = assistantSessionStatus(snapshot)
                  const active = snapshot.session.session_id === currentSessionId
                  return (
                    <div
                      key={snapshot.session.session_id}
                      role="listitem"
                      className={`assistant-session-list-item${active ? ' assistant-session-list-item--active' : ''}`}
                    >
                      <button
                        type="button"
                        className="assistant-session-list-item__select"
                        title={snapshot.session.name}
                        onClick={() => setActiveSessionId(snapshot.session.session_id)}
                      >
                        <span className={`assistant-session-list-item__dot ${role === 'main' ? 'assistant-session-list-item__dot--main' : status.className}`} />
                        {!sidebarCollapsed ? (
                          <>
                            <span className="assistant-session-list-item__copy">
                              <span className="assistant-session-list-item__name">{snapshot.session.name}</span>
                              <span className="assistant-session-list-item__status">{status.label}</span>
                            </span>
                            {role === 'main' ? <span className="assistant-session-list-item__badge">主体</span> : null}
                          </>
                        ) : null}
                      </button>
                      {role === 'clone' ? (
                        <AssistantTooltip label={`删除 ${snapshot.session.name}`} align="right" side="top">
                          <button
                            type="button"
                            className="assistant-session-list-item__delete disabled:opacity-40"
                            aria-label={`删除 ${snapshot.session.name}`}
                            disabled={deletingSession}
                            onClick={(event) => {
                              event.stopPropagation()
                              void deleteCloneSession(snapshot.session.session_id)
                            }}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </AssistantTooltip>
                      ) : null}
                    </div>
                  )
                })}
              </div>
              <button
                type="button"
                className="assistant-session-clone-button disabled:opacity-40"
                disabled={creatingClone || sending}
                title="开分身"
                onClick={openCloneModal}
              >
                {creatingClone ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                {!sidebarCollapsed ? <span>{creatingClone ? '创建中...' : '开分身'}</span> : null}
              </button>
            </aside>

          <div className="assistant-chat-main">
            <div className="assistant-header assistant-header--draggable" onMouseDown={startDrag}>
              <div className="assistant-header__avatar">
                <MoAvatar size="sm" active={open || sending || activeCount > 0 || pendingActiveCount > 0} />
              </div>
              <div className="assistant-header__copy">
                <div className="assistant-header__title">{ASSISTANT_NAME}</div>
                <div className="assistant-header__subtitle" title={headerSubtitle}>
                  {headerSubtitle}
                </div>
              </div>
              <div className="assistant-header__actions">
                <AssistantTooltip label={openSessionTip} align="left" side="top">
                  <button
                    type="button"
                    onClick={openCurrentSession}
                    aria-label={openSessionTip}
                    data-testid="assistant-open-session"
                    className="assistant-text-action assistant-session-link-action disabled:opacity-40"
                    disabled={!currentSessionUrl}
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>当前 Session</span>
                  </button>
                </AssistantTooltip>
                {user?.role === 'admin' ? (
                  <AssistantTooltip label="用 VSCode 打开小莫的技能（mobius-assistant）" align="left" side="top">
                    <button
                      type="button"
                      onClick={openSkillEditor}
                      aria-label="用 VSCode 打开小莫的技能"
                      data-testid="assistant-open-skill"
                      className="assistant-text-action"
                    >
                      <BookOpen className="w-3.5 h-3.5" />
                      <span>Skill</span>
                    </button>
                  </AssistantTooltip>
                ) : null}
                <AssistantTooltip label="预设配置" side="top">
                  <button
                    type="button"
                    onClick={() => setPresetOpen(true)}
                    aria-label="预设配置"
                    data-testid="assistant-preset"
                    className="assistant-text-action"
                  >
                    <Settings className="w-3.5 h-3.5" />
                    <span>预设配置</span>
                  </button>
                </AssistantTooltip>
                <AssistantTooltip label="压缩上文" side="top">
                  <button
                    type="button"
                    onClick={() => setCompactConfirmOpen(true)}
                    aria-label="压缩上文"
                    data-testid="assistant-compact"
                    className="assistant-text-action disabled:opacity-40"
                    disabled={!currentSessionId || sending}
                  >
                    <Archive className="w-3.5 h-3.5" />
                    <span>压缩上文</span>
                  </button>
                </AssistantTooltip>
                <AssistantTooltip label={deleteSessionTip} side="top">
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteErr('')
                      setDeleteConfirmOpen(true)
                    }}
                    aria-label={deleteSessionTip}
                    data-testid="assistant-delete-session"
                    className="assistant-text-action assistant-text-action--danger disabled:opacity-40"
                    disabled={!currentSessionId || sending || deletingSession}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>删除</span>
                  </button>
                </AssistantTooltip>
                <AssistantTooltip label="刷新" align="right" side="top">
                  <button
                    type="button"
                    onClick={() => void loadHistory()}
                    aria-label="刷新"
                    data-testid="assistant-refresh"
                    className="assistant-icon-button disabled:opacity-40"
                    disabled={loading}
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                  </button>
                </AssistantTooltip>
                <AssistantTooltip label={resizeTip} align="right" side="top">
                  <button
                    type="button"
                    onClick={() => setPanelSize(value => nextAssistantPanelSize(value))}
                    aria-label={resizeTip}
                    data-testid="assistant-expand"
                    className="assistant-icon-button"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {panelSize === 'fullscreen' ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                  </button>
                </AssistantTooltip>
                <AssistantTooltip label="关闭" align="right" side="top">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="关闭"
                    data-testid="assistant-close"
                    className="assistant-icon-button"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </AssistantTooltip>
              </div>
            </div>

            <div className="assistant-session-body">
              <div className="assistant-session-toolbar">
                <div className="assistant-session-toolbar__copy">
                  <div className="assistant-session-toolbar__title">当前 Session</div>
                  <div className="assistant-session-toolbar__name" title={currentSessionDisplayName}>
                    {currentSessionDisplayName}
                  </div>
                  <div className="assistant-session-toolbar__meta" title={toolbarAuxText ? `${currentSessionDetailText} · ${toolbarAuxText}` : currentSessionDetailText}>
                    <span className={currentSessionId ? 'assistant-session-toolbar__id' : 'assistant-session-toolbar__hint'}>
                      {currentSessionDetailText}
                    </span>
                    {toolbarAuxText ? <span className="assistant-session-toolbar__aux">{toolbarAuxText}</span> : null}
                  </div>
                </div>
                <AssistantTooltip label={clearConversationTip} side="top">
                  <button
                    type="button"
                    className="assistant-session-clear-action disabled:opacity-40"
                    aria-label={clearConversationTip}
                    data-testid="assistant-clear-conversation"
                    disabled={!currentSessionId || sending}
                    onClick={clearVisibleConversation}
                  >
                    <Eraser className="h-3.5 w-3.5" />
                  </button>
                </AssistantTooltip>
                <label className="assistant-session-voice-mode" title={voicePlaybackModeTip}>
                  <span className="sr-only">播报模式</span>
                  <select
                    aria-label="播报模式"
                    value={voicePlaybackMode}
                    onChange={event => handleVoicePlaybackModeChange(normalizeVoicePlaybackMode(event.target.value))}
                  >
                    <option value="selected">播报精选</option>
                    <option value="all">播报全部</option>
                  </select>
                </label>
                <label className="assistant-session-voice-select" title="选择播报音色">
                  <span className="sr-only">播报音色</span>
                  <select
                    aria-label="播报音色"
                    value={selectedVoice}
                    onChange={event => handleVoiceOptionChange(event.target.value)}
                  >
                    {voiceOptions.map(option => (
                      <option key={option.id} value={option.id} title={voiceOptionTitle(option)}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <AssistantTooltip label={voicePlaybackTip} side="top">
                  <button
                    type="button"
                    className={`assistant-session-voice-toggle${voicePlaybackEnabled ? ' assistant-session-voice-toggle--active' : ''}${voicePlaybackState === 'playing' ? ' assistant-session-voice-toggle--playing' : ''}`}
                    aria-label={voicePlaybackTip}
                    aria-pressed={voicePlaybackEnabled}
                    data-testid="assistant-voice-playback-toggle"
                    onClick={toggleVoicePlayback}
                  >
                    {voicePlaybackEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
                  </button>
                </AssistantTooltip>
                <span className={`assistant-session-status ${activeCount > 0 || pendingActiveCount > 0 || sending ? 'assistant-session-status--active' : 'assistant-session-status--idle'}`}>
                  {activeCount > 0 || pendingActiveCount > 0 || sending ? '执行中' : '就绪'}
                </span>
              </div>

              <div ref={logRef} className="assistant-session-log">
                {loading && sessions.length === 0 && visiblePendingTurns.length === 0 ? (
                  <div className="assistant-session-placeholder">正在读取小莫 Session...</div>
                ) : sessions.length === 0 && visiblePendingTurns.length === 0 ? (
                  <div className="assistant-session-placeholder">还没有小莫提问。首次发送会创建“我的主小莫”。</div>
                ) : visibleMessageCount === 0 && visiblePendingTurns.length === 0 && currentClearCutoff ? (
                  <div className="assistant-session-placeholder">前端对话已清空，新消息会继续显示。</div>
                ) : (
                  <>
                    {currentSnapshot ? (() => {
                      const snapshot = currentSnapshot
                      const visibleMessages = renderedCurrentVisibleMessages
                      const hasVisiblePendingTurn = visiblePendingTurns.some(turn => (
                        pendingTurnBelongsToSnapshot(turn, snapshot, currentSessionId)
                      ))
                      const showPending = snapshot.status?.failed
                        || snapshot.status?.working
                        || ((snapshot.responses || []).length === 0 && visibleMessages.length > 0)
                      return (
                        <div key={snapshot.session.session_id} className="contents">
                          {visibleMessages.map(message => (
                            <ConversationMessage
                              key={message.render_id}
                              message={message}
                              onSpeak={speakText}
                              voicePlaybackMode={voicePlaybackMode}
                              activeVoiceMessageId={activeVoiceMessageId}
                              voicePlaybackState={voicePlaybackState}
                            />
                          ))}
                          {showPending && !hasVisiblePendingTurn ? (
                            <PendingMessage failed={snapshot.status?.failed} />
                          ) : null}
                        </div>
                      )
                    })() : null}
                    {visiblePendingTurns.map(turn => (
                      <PendingTurnMessages
                        key={turn.id}
                        turn={turn}
                        showPending={!!turn.failed || turn.id === latestActivePendingTurnId}
                      />
                    ))}
                  </>
                )}
                {err ? <div className="assistant-session-error assistant-session-error--inline">{err}</div> : null}
              </div>

              <form
                className={`assistant-session-input${inputExpanded ? ' assistant-session-input--expanded' : ''}`}
                onSubmit={event => { event.preventDefault(); void send() }}
                onDrop={handleAttachmentDrop}
                onDragOver={handleAttachmentDragOver}
              >
                <div className="assistant-session-input__stack">
                  {attachments.length > 0 ? (
                    <div className="assistant-session-input__attachments">
                      {attachments.map(attachment => (
                        <AssistantAttachmentChip
                          key={attachment.id}
                          attachment={attachment}
                          onRemove={() => removeAttachment(attachment.id)}
                          onPreview={setImagePreview}
                        />
                      ))}
                    </div>
                  ) : null}
                  <textarea
                    ref={textareaRef}
                    className="assistant-session-input__textarea"
                    aria-label="发送给小莫"
                    data-testid="assistant-input"
                    placeholder="发送给小莫..."
                    value={input}
                    rows={inputExpanded ? 10 : 3}
                    onChange={event => setInput(event.target.value)}
                    onPaste={handleAttachmentPaste}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        const nativeEvent = event.nativeEvent as KeyboardEvent
                        if ((event as any).isComposing || nativeEvent.isComposing || nativeEvent.keyCode === 229) return
                        event.preventDefault()
                        void send()
                      }
                    }}
                  />
                  <input
                    ref={attachmentInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleAttachmentInputChange}
                  />
                  <div className="assistant-session-input__actions" aria-label="小莫输入操作">
                    <AssistantTooltip label={attachmentButtonTip} side="top">
                      <button
                        type="button"
                        className="assistant-session-input__utility"
                        aria-label={attachmentButtonTip}
                        data-testid="assistant-attachment-input"
                        disabled={sending || attachments.length >= ASSISTANT_ATTACHMENT_MAX_COUNT}
                        onClick={() => attachmentInputRef.current?.click()}
                      >
                        <FilePlus2 className="w-4 h-4" />
                      </button>
                    </AssistantTooltip>
                    <AssistantTooltip label={voiceTip} side="top">
                      <button
                        type="button"
                        className={`assistant-session-input__utility assistant-session-input__voice assistant-session-input__voice--${voiceState}`}
                        aria-label={voiceTip}
                        aria-pressed={voiceState === 'recording'}
                        data-testid="assistant-voice-input"
                        disabled={sending || voiceState === 'transcribing'}
                        onClick={toggleVoiceRecording}
                      >
                        {voiceState === 'recording' ? (
                          <Square className="w-4 h-4" fill="currentColor" />
                        ) : voiceState === 'transcribing' ? (
                          <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : (
                          <Mic className="w-4 h-4" />
                        )}
                      </button>
                    </AssistantTooltip>
                    <AssistantTooltip label={inputExpanded ? '收起大输入' : '展开大输入'} side="top">
                      <button
                        type="button"
                        className="assistant-session-input__utility"
                        aria-label={inputExpanded ? '收起大输入' : '展开大输入'}
                        onClick={() => setInputExpanded(value => !value)}
                      >
                        {inputExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                      </button>
                    </AssistantTooltip>
                    <AssistantTooltip label="发送" align="right" side="top">
                      <button
                        type="submit"
                        className="assistant-session-input__send disabled:opacity-40"
                        aria-label="发送"
                        disabled={sending || voiceBusy || attachmentUploading || !canSendAssistantMessage}
                      >
                        {sending || attachmentUploading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <SendHorizontal className="w-4 h-4" />}
                      </button>
                    </AssistantTooltip>
                  </div>
                </div>
              </form>
            </div>
          </div>
          </div>
        </div>
      ) : null}
      {imagePreview ? (
        <AssistantImagePreviewModal preview={imagePreview} onClose={() => setImagePreview(null)} />
      ) : null}
      {compactConfirmOpen ? (
        <CompactContextConfirmModal
          onConfirm={sendCompactCommand}
          onClose={() => setCompactConfirmOpen(false)}
        />
      ) : null}
      {deleteConfirmOpen ? (
        <DeleteCurrentSessionConfirmModal
          sessionName={currentSessionName}
          deleting={deletingSession}
          error={deleteErr}
          onConfirm={() => void deleteCurrentSession()}
          onClose={() => {
            if (deletingSession) return
            setDeleteConfirmOpen(false)
            setDeleteErr('')
          }}
        />
      ) : null}
      {cloneModalOpen ? (
        <CreateCloneSessionModal
          draft={cloneDraft}
          modelOptions={cloneModelOptions}
          creating={creatingClone}
          error={cloneCreateErr}
          onChange={(patch) => setCloneDraft(current => ({ ...current, ...patch }))}
          onConfirm={() => void createCloneSession()}
          onClose={() => {
            if (creatingClone) return
            setCloneModalOpen(false)
            setCloneCreateErr('')
          }}
        />
      ) : null}
      {presetOpen ? (
        <AssistantPresetModal
          onClose={() => setPresetOpen(false)}
          onSaved={(payload) => {
            if (payload.deleted_session) {
              setSessions([])
              setPendingTurns([])
            }
            hasLoadedRef.current = false
            void loadHistory()
          }}
        />
      ) : null}
    </>
  )
}
