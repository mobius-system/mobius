import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type CSSProperties, type DragEvent, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Mic, Paperclip, RefreshCw, SendHorizontal, Sparkles, Square, Zap } from 'lucide-react'
import { AdvancedInteractionBtn } from './advanced-interaction-btn'
import type { VoiceInputState } from '../services/assistant-voice'
import type { Attachment } from './attachments'

/**
 * create_session_mode: 欢迎页还没有会话，输入框只负责收集任务描述，提交后进入完整的新建会话配置。
 * follow_session_mode: 会话内的持续对话，带语音输入与加急发送等完整交互。
 */
export type EasySessionChatInputMode = 'create_session_mode' | 'follow_session_mode'

type EasySessionChatInputCommonProps = {
  input: string
  inputPlaceholder: string
  theme: string
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
  /** create_session_mode 下只有普通发送，参数被忽略 */
  onSend: (urgent?: boolean) => void
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  /** 底部工具栏左侧的插槽: 欢迎页放 EasySessionConfigBar, 会话内放 EasySessionToolBar */
  toolbar?: ReactNode
}

type CreateSessionModeProps = EasySessionChatInputCommonProps & {
  mode: 'create_session_mode' // follow_session_mode
  /** 欢迎页在选齐项目和任务前不能提交 */
  submitDisabled?: boolean
  submitTooltip?: string
  attachments: Attachment[]
  anyUploading: boolean
  hasReadyAttachments: boolean
  onUpload: () => void
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onRemoveAttachment: (id: string) => void
}

type FollowSessionModeProps = EasySessionChatInputCommonProps & {
  mode: 'follow_session_mode' // create_session_mode
  inputRef: RefObject<HTMLTextAreaElement>
  inputFocused: boolean
  voiceState: VoiceInputState
  voiceTip: string
  voiceBusy: boolean
  messageSubmitting: boolean
  anyUploading: boolean
  hasReadyAttachments: boolean
  hasPendingSend: boolean
  modelAvailable: boolean
  /** 打开本地文件选择器上传附件 (与标准模式「更多输入功能 → 上传文件」同一动作) */
  onUpload: () => void
  /** 终止当前智能体正在执行的操作 (与标准模式标题栏的"终止"按钮同一动作) */
  onStop: () => void
  /** 终止指令已发出后的反馈态: 按钮转红并脉冲, 1.8s 后自动回落 */
  stopFeedbackActive?: boolean
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void
  onFocus: () => void
  onBlur: (event: FocusEvent<HTMLDivElement>) => void
  onToggleVoice: () => void
}

export type EasySessionChatInputProps = CreateSessionModeProps | FollowSessionModeProps

/** 欢迎页与会话内共用同一个输入框，只有 mode 决定哪些交互可用。 */
export function EasySessionChatInput(props: EasySessionChatInputProps) {
  const { input, inputPlaceholder, theme, onChange, onKeyDown, onSend } = props
  const standaloneInputRef = useRef<HTMLTextAreaElement>(null)
  // 欢迎页没有会话上下文，focus 状态留在组件内部，调用方只需要传 mode。
  const [standaloneFocused, setStandaloneFocused] = useState(false)
  const follow = props.mode === 'follow_session_mode' ? props : null
  const inputFocused = follow ? follow.inputFocused : standaloneFocused

  const submitBlocked = props.mode === 'create_session_mode' && !!props.submitDisabled
  const disabled = follow
    ? (!input.trim() && !follow.hasReadyAttachments) || follow.anyUploading || follow.hasPendingSend || follow.messageSubmitting || follow.voiceBusy || !follow.modelAvailable
    : (!input.trim() && !props.hasReadyAttachments) || props.anyUploading || submitBlocked
  const sendBg = disabled ? (theme !== 'light' ? '#374151' : '#e5e7eb') : (theme !== 'light' ? '#ffffff' : '#111827')
  const sendFg = disabled ? (theme !== 'light' ? '#6b7280' : '#9ca3af') : (theme !== 'light' ? '#111827' : '#ffffff')
  const border = theme !== 'light' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)'
  const sendTip = follow
    ? follow.voiceBusy ? follow.voiceTip : follow.hasPendingSend || follow.messageSubmitting ? '正在提交上一条消息...' : '发送 (Enter)'
    : (props.mode === 'create_session_mode' && props.submitTooltip) || '开始新会话'

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (onKeyDown) {
      onKeyDown(event)
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    onSend()
  }

  const hasCreateAttachments = props.mode === 'create_session_mode' && props.attachments.length > 0
  const baseInputHeight = hasCreateAttachments ? 132 : 96
  const maxInputHeight = baseInputHeight * 3
  const [textAreaHeight, setTextAreaHeight] = useState(42)
  const textAreaRef = follow?.inputRef ?? standaloneInputRef

  useEffect(() => {
    const textarea = textAreaRef.current
    if (!textarea) return
    // 先收回高度再测量内容，确保删除文本时输入框也能同步变矮
    // Reset before measuring so deleting text shrinks the input as well
    textarea.style.height = '42px'
    const maxTextAreaHeight = maxInputHeight - 54
    setTextAreaHeight(Math.min(Math.max(textarea.scrollHeight, 42), maxTextAreaHeight))
  }, [input, maxInputHeight, textAreaRef])

  const inputHeight = Math.min(maxInputHeight, Math.max(baseInputHeight, textAreaHeight + 54))

  return (
    <div
      data-tour="session-chat-input"
      data-mode={props.mode}
      className="easy-session-chat-input relative min-w-0 w-full overflow-hidden rounded-[22px] transition-all focus-within:ring-2 focus-within:ring-blue-500/15"
      style={{
        height: inputHeight,
        minHeight: 0,
        maxHeight: inputHeight,
        background: 'color-mix(in srgb, var(--bg-secondary) 94%, transparent)',
        border: `1px solid ${border}`,
        boxShadow: inputFocused
          ? '0 4px 20px rgba(0,0,0,0.28), 0 0 0 1px rgba(255,255,255,0.02) inset'
          : '0 2px 12px rgba(0,0,0,0.22), 0 0 0 1px rgba(255,255,255,0.02) inset',
        backdropFilter: 'blur(22px)',
        WebkitBackdropFilter: 'blur(22px)',
      } as CSSProperties}
      onPaste={follow ? follow.onPaste : props.onPaste}
      onDragOver={props.mode === 'create_session_mode' ? event => event.preventDefault() : undefined}
      onDrop={props.mode === 'create_session_mode' ? props.onDrop : undefined}
      onFocusCapture={follow ? follow.onFocus : () => setStandaloneFocused(true)}
      onBlurCapture={follow ? follow.onBlur : (event) => {
        const nextTarget = event.relatedTarget as Node | null
        if (nextTarget && event.currentTarget.contains(nextTarget)) return
        setStandaloneFocused(false)
      }}
    >
      {props.mode === 'create_session_mode' && props.attachments.length > 0 && (
        <div className="flex max-h-16 flex-wrap items-start gap-1.5 overflow-y-auto px-3 pt-2.5">
          {props.attachments.map(attachment => (
            <div key={attachment.id} className="group relative flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[10px]" style={{ borderColor: 'var(--input-border)', background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }} title={attachment.error || attachment.name}>
              {attachment.kind === 'image' && attachment.previewUrl ? <img src={attachment.previewUrl} alt={attachment.name} className="h-7 w-7 rounded object-cover" /> : <Paperclip className="h-3 w-3 flex-shrink-0" />}
              <span className="max-w-[150px] truncate">{attachment.name}</span>
              {attachment.status === 'uploading' ? <RefreshCw className="h-3 w-3 animate-spin" /> : attachment.status === 'error' ? <span className="text-red-400">失败</span> : null}
              <button type="button" onClick={() => props.onRemoveAttachment(attachment.id)} className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-[11px] opacity-70 hover:bg-red-500/20 hover:text-red-300" aria-label={`移除附件 ${attachment.name}`}>×</button>
            </div>
          ))}
        </div>
      )}
      <div className="px-3 pt-3 pb-2.5">
        {follow && !input && (
          <div className="pointer-events-none absolute inset-x-3 top-3 z-10 grid min-w-0 grid-cols-2 gap-x-3 text-[11px] leading-[1.35] ml-[1%] mr-[50%]" style={{ color: 'var(--placeholder-color)' }}>
            <span className="col-span-2 min-w-0 truncate">发送指令：</span>
            <span className="min-w-0 truncate">· Shift+Enter 换行</span>
            <span className="min-w-0 truncate">· Ctrl/⌘+V 粘贴文件/截图</span>
            <span className="min-w-0 truncate">· ↑键回溯</span>
            <span className="min-w-0 truncate">· @引用文件/智能体</span>
          </div>
        )}
        <textarea
          ref={textAreaRef}
          value={input}
          onChange={onChange}
          onKeyDown={handleKeyDown}
          placeholder={follow && !input ? undefined : inputPlaceholder}
          className="min-h-[42px] w-full resize-none overflow-y-auto border-0 bg-transparent px-0 pt-0 pb-1 text-[15px] leading-[1.6] focus:outline-none"
          style={{ color: 'var(--text-primary)', height: textAreaHeight, maxHeight: maxInputHeight - 54 }}
        />
      </div>
      <div className="absolute bottom-0 left-0 right-0 flex h-9 min-w-0 items-center justify-end gap-2 overflow-hidden px-3 pb-1">
        {props.toolbar ? (
          <div className={`mr-auto flex min-w-0 items-center gap-1.5 overflow-hidden ${follow ? 'easy-session-tool-bar' : 'easy-session-config-bar'}`}>{props.toolbar}</div>
        ) : !follow ? (
          <span className="mr-auto flex min-w-0 items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate">提交后可配置项目、任务、模型和上下文</span>
          </span>
        ) : null}
        {props.mode === 'create_session_mode' && (
          <AdvancedInteractionBtn
            onClick={props.onUpload}
            label="上传文件"
            tooltip="上传文件"
            accent="blue"
            motion="breathe"
            buttonClassName="h-7 w-7 flex-shrink-0 rounded-full"
            iconClassName="h-[17px] w-[17px]"
            style={{ color: '#d1d5db' }}
            icon={<Paperclip className="h-[17px] w-[17px]" />}
          />
        )}
        {/* 上传附件: 标准模式把它收在「更多输入功能」菜单里, 简易模式只留这一个入口, 直接放在行内.
            样式与同一行其它按钮一致 (无边框圆形, 见 Unify easy-mode chat input toolbar buttons). */}
        {follow && (
          <AdvancedInteractionBtn
            onClick={follow.onUpload}
            label="上传文件"
            tooltip="上传文件"
            accent="blue"
            motion="breathe"
            buttonClassName="h-7 w-7 flex-shrink-0 rounded-full"
            iconClassName="h-[17px] w-[17px]"
            style={{ color: '#d1d5db' }}
            icon={<Paperclip className="h-[17px] w-[17px]" />}
          />
        )}
        {follow && (
          <AdvancedInteractionBtn
            onClick={follow.onToggleVoice}
            disabled={follow.messageSubmitting || follow.voiceState === 'transcribing'}
            aria-pressed={follow.voiceState === 'recording'}
            label={follow.voiceTip}
            tooltip={follow.voiceTip}
            accent="cyan"
            motion="breathe"
            buttonClassName="h-7 w-7 flex-shrink-0 rounded-full"
            iconClassName="h-[17px] w-[17px]"
            style={{ color: follow.voiceState === 'recording' ? '#f87171' : '#d1d5db' }}
            icon={follow.voiceState === 'recording' ? <Square className="h-[17px] w-[17px]" fill="currentColor" /> : follow.voiceState === 'transcribing' ? <RefreshCw className="h-[17px] w-[17px] animate-spin" /> : <Mic className="h-[17px] w-[17px]" />}
          />
        )}
        {/* Stop: 终止当前智能体正在执行的操作 — 与标准模式标题栏的"终止"同源 (handleStopSession)。
            复用 .session-stop-button 系列样式, 保持两处终止按钮的配色与反馈动画一致。 */}
        {follow && (
          <AdvancedInteractionBtn
            onClick={follow.onStop}
            data-tour="session-chat-stop"
            label="终止"
            tooltip={follow.stopFeedbackActive ? '终止指令已发送' : '终止当前智能体正在执行的操作'}
            accent="red"
            motion="breathe"
            className={`session-stop-button ${follow.stopFeedbackActive ? 'session-stop-button--active' : ''}`}
            buttonClassName="h-7 w-7 flex-shrink-0 rounded-full"
            iconClassName="h-[17px] w-[17px]"
            icon={<Square className={`h-[10px] w-[10px] ${follow.stopFeedbackActive ? 'session-stop-button__square' : ''}`} fill="currentColor" />}
          />
        )}
        {follow && (
          <AdvancedInteractionBtn
            onClick={() => follow.onSend(true)}
            disabled={disabled}
            data-tour="session-chat-send-urgent"
            label="加急发送"
            tooltip="发送（加急）— 打断当前输出并立即发送"
            accent="amber"
            motion="breathe"
            buttonClassName="h-7 w-7 flex-shrink-0 rounded-full"
            iconClassName="h-[17px] w-[17px]"
            style={{ color: '#d1d5db' }}
            icon={<Zap className="h-[17px] w-[17px]" />}
          />
        )}
        <AdvancedInteractionBtn
          onClick={() => onSend()}
          disabled={disabled}
          data-tour="session-chat-send"
          label="发送"
          tooltip={sendTip}
          accent="emerald"
          motion="breathe"
          buttonClassName="h-7 w-7 flex-shrink-0 rounded-full"
          iconClassName="h-[18px] w-[18px]"
          style={{ background: sendBg, color: sendFg, cursor: disabled ? 'not-allowed' : 'pointer' }}
          icon={follow && (follow.anyUploading || follow.voiceState === 'transcribing') ? <RefreshCw className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-[18px] w-[18px]" strokeWidth={2.4} />}
        />
      </div>
    </div>
  )
}
