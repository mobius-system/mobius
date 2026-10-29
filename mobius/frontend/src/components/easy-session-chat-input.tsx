import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type CSSProperties, type DragEvent, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, ChevronDown, Clock, Mic, Paperclip, Plus, RefreshCw, Search, Square, Upload, Zap } from 'lucide-react'
import { SessionModelDropdown } from './quick-create-session'
import { useSessionModelOptions, promptBackendKeyForOption, PROMPT_BACKEND_LABEL } from './session-model-picker'
import { EasySessionToolMenu, type EasySessionLite } from './easy-session-tool-menu'
import { EasySessionDevicePill } from './easy-session-device-pill'
import { AttachmentChip, type Attachment, type AttachmentImagePreview } from './attachments'
import type { VoiceInputState } from '../services/assistant-voice'
import { useIsMobile } from './resizable-panel'

/**
 * create_session_mode: 欢迎页还没有会话，输入框只负责收集任务描述，提交后进入完整的新建会话配置。
 * follow_session_mode: 会话内的持续对话，带语音输入与加急发送等完整交互。
 *
 * UI 参考 issue 2026-10-13 用户截图 (MoneyPrinterTurbo) — 走扁平图标路线:
 *   左侧 = + (选择文件/图片入口)
 *   右侧 = 当前模型 (文字+chevron) | 语音输入 | 发送 (蓝色圆形)
 *   智能体运行时 → 同一个按钮变为停止 (保持圆形 + 红色填充)
 */
export type EasySessionChatInputMode = 'create_session_mode' | 'follow_session_mode'

type EasySessionChatInputCommonProps = {
  input: string
  inputPlaceholder: string
  theme: string
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
  /** create_session_mode 下只有普通发送，参数被忽略 */
  onSend: (urgent?: boolean) => void
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void
  /** 底部工具栏左侧的插槽: 欢迎页放 EasySessionConfigBar, 会话内放 EasySessionToolBar */
  toolbar?: ReactNode
  /** 附件列表: 渲染在输入框内部 (框内顶部), 欢迎页与会话内同一位置 (issue 2026-10-26) */
  attachments: Attachment[]
  /** 移除附件 */
  onRemoveAttachment: (id: string) => void
  /** 点击图片附件放大预览 (不传则点击无动作) */
  onPreviewAttachment?: (preview: AttachmentImagePreview) => void
}

type CreateSessionModeProps = EasySessionChatInputCommonProps & {
  mode: 'create_session_mode' // follow_session_mode
  /** 欢迎页在选齐项目和任务前不能提交 */
  submitDisabled?: boolean
  submitTooltip?: string
  anyUploading: boolean
  hasReadyAttachments: boolean
  onUpload: () => void
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  /** 欢迎页右下: 当前所选模型 key (来自 EasySessionConfigBar selection.model) */
  welcomeModelKey?: string
  /** 欢迎页右下: 切换模型回调 (写入 EasySessionConfigBar selection.model) */
  onChangeWelcomeModel?: (model: string) => void
  /** 欢迎页右下: 语音输入状态 (useVoiceInput) */
  welcomeVoiceState?: VoiceInputState
  /** 欢迎页右下: 语音按钮提示文案 */
  welcomeVoiceTip?: string
  /** 欢迎页右下: 切换语音录音 */
  onToggleWelcomeVoice?: () => void
  /** 欢迎页右下: 运行中枢 (新会话跑在哪台设备上, 空 = 中枢) */
  welcomeDeviceId?: string
  /** 欢迎页右下: 切换运行中枢 */
  onChangeWelcomeDevice?: (deviceId: string) => void
  /** 嵌入模式: 去掉自己的圆角+边框, 由外层容器统一 */
  embedded?: boolean
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
  /** 打开本地文件选择器上传附件 */
  onUpload: () => void
  /** 终止当前智能体正在执行的操作 */
  onStop: () => void
  /** 终止指令已发出后的反馈态 */
  stopFeedbackActive?: boolean
  /** 当前会话 id (供工具菜单高亮) */
  sessionId?: string
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void
  /** 拖拽文件到输入框直接上传为附件 (会话页同样支持, issue 2026-10-26) */
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onFocus: () => void
  onBlur: (event: FocusEvent<HTMLDivElement>) => void
  onToggleVoice: () => void
  /** 当前会话的模型 key, 用于在右侧展示当前模型 + 弹窗切换 */
  sessionModelKey?: string
  /** 当前会话的模型展示名 (例如 "DeepSeek V4.1 Flash · DeepSeek 高") */
  sessionModelLabel?: string
  /** 切换当前会话模型 (复用 PATCH /api/sessions/:id/model) */
  onChangeSessionModel?: (model: string) => Promise<void> | void
  /** 当前会话绑定的运行设备 id (空串 = 跑在中枢上) */
  sessionDeviceId?: string
  /** 切换运行设备 (复用 PATCH /api/sessions/:id/aimux-device); 传空串表示回到中枢 */
  onChangeSessionDevice?: (deviceId: string) => Promise<void> | void
  /** 智能体是否正在工作 (决定停止键是否出现, 以及发送是「排队」还是「立即」) */
  agentWorking?: boolean
  /** 运行中发送的时间戳: 变化时按钮闪「已排队」琥珀态 (由父级在发送时写入) */
  queuedAt?: number | null
  /** 工具菜单: 近期会话列表 (用于「切换会话」子菜单) */
  recentSessions?: EasySessionLite[]
  /** 当前会话所属项目 id (只用于「注入 Git / 项目知识」的可用性判断, 不提供项目切换) */
  currentProjectId?: string
  /** 工具菜单: 切换会话回调 */
  onSwitchSession?: (sessionId: string) => void
  /** 工具菜单: 当前语言 */
  language?: 'zh' | 'en'
  /** 工具菜单: 切换语言回调 */
  onChangeLanguage?: (next: 'zh' | 'en') => void
  /** 工具菜单: 注入 Skill 回调 */
  onInjectSkill?: () => void
  /** 工具菜单: 注入 Memory 回调 */
  onInjectMemory?: () => void
  /** 工具菜单: 注入 Git 回调 */
  onInjectGit?: () => void
  /** 工具菜单: 文件改动回调 */
  onOpenFileChanges?: () => void
  /** 工具菜单: Bash 命令回调 */
  onOpenBashCommands?: () => void
  /** 工具菜单: 输入回放回调 */
  onOpenInputReplay?: () => void
  /** 工具菜单: 终端回调 */
  onOpenTerminal?: () => void
  /** 工具菜单: 可合作计算机回调 */
  onOpenCooperablePc?: () => void
  /** 工具菜单: 知识回调 */
  onOpenKnowledge?: () => void
  /** 工具菜单: 切换 JSONL 时间与序号 */
  onToggleJsonlMeta?: () => void
  /** 工具菜单: 当前 JSONL 时间与序号状态 */
  showJsonlMeta?: boolean
  /** 工具菜单: 发送项目知识 */
  onSendProjectKnowledge?: () => void
  /** 工具菜单: 项目知识发送中状态 */
  projectKnowledgeSending?: boolean
  /** 工具菜单: 当前 jsonl 条目数 */
  jsonlEntryCount?: number
  /** 工具菜单: 当前是否已连接 */
  connectionReady?: boolean
  /** 工具菜单: 是否有当前会话 (用于禁用 Skill/Memory/Git 按钮) */
  hasSession?: boolean
  /** 工具菜单: 是否有当前项目 (用于禁用 Git 按钮) */
  hasProject?: boolean
}

export type EasySessionChatInputProps = CreateSessionModeProps | FollowSessionModeProps

/** 欢迎页与会话内共用同一个输入框，只有 mode 决定哪些交互可用。 */
export function EasySessionChatInput(props: EasySessionChatInputProps) {
  const { input, inputPlaceholder, theme, onChange, onKeyDown, onSend } = props
  // 欢迎页没有会话上下文，focus 状态留在组件内部，调用方只需要传 mode。
  const [standaloneFocused, setStandaloneFocused] = useState(false)
  // 拖拽文件悬停态: 输入框高亮提示可松手上传 (issue 2026-10-26)
  const [fileDragOver, setFileDragOver] = useState(false)
  // 排队反馈: 运行中发送后按钮短暂显示「已排队」(1.6s), 让用户立刻知道这条已入队
  const [queuedFlash, setQueuedFlash] = useState(false)
  const follow = props.mode === 'follow_session_mode' ? props : null
  const inputFocused = follow ? follow.inputFocused : standaloneFocused
  const isMobile = useIsMobile()

  const submitBlocked = props.mode === 'create_session_mode' && !!props.submitDisabled
  const disabled = follow
    ? (!input.trim() && !follow.hasReadyAttachments) || follow.anyUploading || follow.hasPendingSend || follow.messageSubmitting || follow.voiceBusy || !follow.modelAvailable
    : (!input.trim() && !props.hasReadyAttachments) || props.anyUploading || submitBlocked
  const isDark = theme !== 'light'
  const border = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)'
  // 停止是独立键 (只在运行中出现), 发送键恒定蓝 —— 红色只属于破坏性动作.
  const canStop = !!follow && !!follow.agentWorking
  // 蓝色 send 按钮: 不可用时灰底灰字; 可用时蓝底白字.
  const sendBg = disabled
    ? (isDark ? '#3f3f46' : '#cbd5e1')
    : '#2563eb'
  const sendFg = disabled
    ? (isDark ? '#71717a' : '#94a3b8')
    : '#ffffff'
  const sendTip = follow
    ? queuedFlash
      ? '已排队 · 当前任务结束后执行'
      : follow.voiceBusy
        ? follow.voiceTip
        : follow.hasPendingSend || follow.messageSubmitting
          ? '正在提交上一条消息...'
          : canStop
            ? '排队发送 · 当前任务结束后执行 (Enter)'
            : '发送 (Enter)'
    : (props.mode === 'create_session_mode' && props.submitTooltip) || '开始新会话'

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (onKeyDown) {
      onKeyDown(event)
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    onSend()
  }

  // 输入框随内容长高, 封顶 = 初始高度的 3 倍 (会话内 96→288, 欢迎页 144→432), 超出后 textarea 内部滚动
  const isCreateMode = props.mode === 'create_session_mode'
  // 欢迎页与会话页同一套尺寸 (issue 2026-10-17 用户要求两者一致)
  const baseInputHeight = 110
  const baseTextAreaHeight = 56
  // 移动端欢迎页底行换行成两行 (配置条一行 + 动作键一行), 非文本区高度要多出一行
  const mobileBottomRowExtra = isMobile && isCreateMode ? 40 : 0
  const chromeHeight = baseInputHeight - baseTextAreaHeight + mobileBottomRowExtra
  const maxInputHeight = baseInputHeight * 3
  const [textAreaHeight, setTextAreaHeight] = useState(baseTextAreaHeight)
  // 测高必须用组件私有 ref, 且绝不能再写回外部 inputRef:
  // chat.tsx 的标准输入框 auto-grow effect (上限 70vh) 通过 inputRef.current 找元素,
  // 若本组件渲染时把 inputRef.current 指到 easy textarea, 父 effect 会在子 effect 之后
  // 用 70vh 上限直接改写 DOM 高度 (React 察觉不到), 3x 封顶被击穿 → 文字溢出卡片。
  const measureRef = useRef<HTMLTextAreaElement | null>(null)

  useLayoutEffect(() => {
    const textarea = measureRef.current
    if (!textarea) return
    // 先收回高度让内容自然撑开再测量; 量完必须把目标值直接写回 DOM ——
    // 若只 setState, 当新值与旧 state 相同 (React bail out 不重渲染) 时,
    // 上面收回高度的 DOM 修改不会被 React 修正, textarea 会卡在 base 高度。
    textarea.style.height = 'auto'
    const next = Math.min(Math.max(textarea.scrollHeight, baseTextAreaHeight), maxInputHeight - chromeHeight)
    textarea.style.height = `${next}px`
    setTextAreaHeight(next)
  }, [input, baseTextAreaHeight, maxInputHeight, chromeHeight])

  const inputHeight = Math.min(maxInputHeight, Math.max(baseInputHeight, textAreaHeight + chromeHeight))

  // 附件芯片渲染在卡片内部 (框内顶部), 卡片高度必须跟着芯片行长高,
  // 否则会被 overflow-hidden 裁掉. 用 ResizeObserver 量真实高度 (芯片多行换行时高度会变).
  const chipsRef = useRef<HTMLDivElement | null>(null)
  const [chipsHeight, setChipsHeight] = useState(0)
  useLayoutEffect(() => {
    const el = chipsRef.current
    if (!el) {
      setChipsHeight(0)
      return
    }
    const update = () => setChipsHeight(el.offsetHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [props.attachments.length])
  // 卡片总高 = 内容高 (文本区 + 上下留白 + 工具栏) + 芯片行高
  const cardHeight = inputHeight + chipsHeight

  // 拖拽文件 → 直接上传为附件 (issue 2026-10-26)
  // 只有 dataTransfer.types 里有 'Files' 才当文件拖拽处理, 拖文字选区保持浏览器默认行为 (可直接放进输入框).
  const dragHasFiles = (event: DragEvent<HTMLDivElement>) => !!event.dataTransfer?.types?.includes('Files')
  // 「是否还在框内」用 relatedTarget 判定, 不用 currentTarget===target:
  // 指针从输入框空白处移到 textarea/按钮等子元素时, dragleave 的 target 仍是容器本身,
  // 用 target 判定会误判成「已离开」, 高亮刚亮起就灭掉.
  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    setFileDragOver(true)
  }
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(event)) return
    // 不 preventDefault 的话浏览器不会派发 drop 事件
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }
  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const related = event.relatedTarget as Node | null
    if (related && event.currentTarget.contains(related)) return // 还在框内 (只是移到了子元素上)
    setFileDragOver(false)
  }
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    setFileDragOver(false)
    if (!dragHasFiles(event)) return
    // 阻止浏览器直接把被拖入的文件当作导航打开
    event.preventDefault()
    if (follow) follow.onDrop(event)
    else if (props.mode === 'create_session_mode') props.onDrop(event)
    // 拖完就把焦点交回输入框, 用户可以直接接着打字
    measureRef.current?.focus()
  }
  // 排队反馈: 父级在「运行中发送」时给一个时间戳, 这里闪一下「已排队」琥珀态 (1.6s).
  // 由父级驱动而非组件内自造, 这样 Enter 键发送、按钮点击、语音发送三条路径都会走到.
  useEffect(() => {
    if (!follow?.queuedAt) return
    setQueuedFlash(true)
    const timer = window.setTimeout(() => setQueuedFlash(false), 1600)
    return () => window.clearTimeout(timer)
  }, [follow?.queuedAt])

  // 防呆: 拖拽被中途取消 (Esc) 或拖到窗口外结束时兜底清高亮, 免得遮罩卡住不消失
  useEffect(() => {
    if (!fileDragOver) return
    const clear = () => setFileDragOver(false)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [fileDragOver])

  return (
    <div
      data-tour="session-chat-input"
      data-mode={props.mode}
      data-drag-over={fileDragOver ? 'true' : undefined}
      className="easy-session-chat-input relative min-w-0 w-full overflow-hidden rounded-[18px] transition-all focus-within:ring-2 focus-within:ring-blue-500/15"
      style={{
        height: cardHeight,
        minHeight: 0,
        maxHeight: cardHeight,
        // 比外层页面背景略浅, 形成轻微抬升感 (issue 2026-10-13 参考图)
        // 浅色主题: 略暗于页面 (rgba 黑 0.04), 模拟 Codex 灰白卡片
        background: isDark ? 'rgba(45, 52, 64, 0.65)' : 'rgba(0, 0, 0, 0.04)',
        // 拖拽文件悬停: accent 边框 + 蓝色光晕, 明确「松手即上传」(issue 2026-10-26)
        // 边框宽度保持 1px 不变 —— 改成 2px 会让整块输入框在悬停瞬间跳动一下
        border: `1px solid ${fileDragOver ? (isDark ? '#60a5fa' : '#2563eb') : border}`,
        boxShadow: fileDragOver
          ? '0 0 0 4px rgba(59,130,246,0.15), 0 4px 20px rgba(0,0,0,0.28)'
          : inputFocused
            ? '0 4px 20px rgba(0,0,0,0.28), 0 0 0 1px rgba(255,255,255,0.02) inset'
            : '0 2px 12px rgba(0,0,0,0.22), 0 0 0 1px rgba(255,255,255,0.02) inset',
        backdropFilter: 'blur(22px)',
        WebkitBackdropFilter: 'blur(22px)',
      } as CSSProperties}
      onPaste={follow ? follow.onPaste : props.onPaste}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onFocusCapture={follow ? follow.onFocus : () => setStandaloneFocused(true)}
      onBlurCapture={follow ? follow.onBlur : (event) => {
        const nextTarget = event.relatedTarget as Node | null
        if (nextTarget && event.currentTarget.contains(nextTarget)) return
        setStandaloneFocused(false)
      }}
    >
      {/* 拖拽文件悬停遮罩: 与标准输入框同一套视觉语言 (虚线框 + 「松开以添加文件」),
          盖住整块输入框, 明确告诉用户松手就会变成附件 (issue 2026-10-26) */}
      {fileDragOver && (
        <div
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-1"
          style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.08), rgba(59,130,246,0.18))', borderRadius: 'inherit' }}
        >
          <div
            className="flex items-center gap-2 rounded-[14px] border border-dashed px-3 py-1.5 text-[length:var(--fs-md)] font-medium"
            style={{
              borderColor: isDark ? 'rgba(96,165,250,0.6)' : 'rgba(37,99,235,0.5)',
              color: isDark ? '#93c5fd' : '#2563eb',
            }}
          >
            <Upload className="h-4 w-4 flex-shrink-0" strokeWidth={2} />
            <span>松开以添加文件</span>
          </div>
        </div>
      )}
      {/* 附件芯片: 渲染在输入框内部 (框内顶部), 欢迎页与会话内同一位置同一组件
          (issue 2026-10-26: 上传的附件统一显示在输入框中) */}
      {props.attachments.length > 0 && (
        <div ref={chipsRef} className="flex max-h-16 flex-wrap items-start gap-1.5 overflow-y-auto px-3 pt-2.5">
          {props.attachments.map(att => (
            <AttachmentChip
              key={att.id}
              att={att}
              theme={isDark ? 'dark' : 'light'}
              onRemove={() => props.onRemoveAttachment(att.id)}
              onPreview={props.onPreviewAttachment}
            />
          ))}
        </div>
      )}
      <div className="px-3 pt-3 pb-2.5">
        {follow && !input && (
          // 提示行是浮在文本区上方的绝对定位层: 框内有附件芯片时要往下让出芯片行的高度, 否则会压在芯片上.
          // 移动端隐藏 (easy-session-input-hint): 这一串 Ctrl/⌘+V / ↑键回溯 是桌面快捷键,
          // 手机上既用不上又占一行还横向截断.
          <div className="easy-session-input-hint pointer-events-none absolute inset-x-3 z-10 flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-[length:var(--fs-sm)] leading-[1.35]" style={{ color: 'var(--placeholder-color)', top: chipsHeight + 12 }}>
            <span className="flex-shrink-0">发送指令：</span>
            <span className="flex min-w-0 items-center gap-2 truncate">
              <span className="flex-shrink-0">· Shift+Enter 换行</span>
              <span className="flex-shrink-0">· Ctrl/⌘+V 粘贴文件/截图</span>
              <span className="flex-shrink-0">· ↑键回溯</span>
              <span className="flex-shrink-0">· @引用文件/智能体</span>
            </span>
          </div>
        )}
        <textarea
          ref={measureRef}
          value={input}
          onChange={onChange}
          onKeyDown={handleKeyDown}
          placeholder={follow && !input ? undefined : inputPlaceholder}
          className="min-h-[56px] w-full resize-none overflow-y-auto border-0 bg-transparent px-0 pt-0 pb-1 leading-[1.6] focus:outline-none"
          style={{ color: 'var(--text-primary)', height: textAreaHeight, maxHeight: maxInputHeight - chromeHeight, fontSize: 'var(--fs-lg)' }}
        />
      </div>
      {/* 底部按钮行: 扁平图标路线 (issue 2026-10-13 用户截图, 与 Codex 一致)
            左侧: 选择文件
            右侧: 模型切换 (文字+chevron) | 语音 | 发送 (蓝色圆形, 运行时变红色停止)
            注意: 此行不能 overflow-hidden — 语音/终止按钮的脉冲光晕 (box-shadow) 需要溢出显示;
            长文案裁切由内部各子容器自身的 overflow-hidden 负责 (config-bar / hint 行)。 */}
      <div className="easy-session-input-row absolute bottom-0 left-0 right-0 flex h-10 min-w-0 items-center justify-between gap-2 px-3 pb-1.5">
        {/* 左侧: 配置条 (欢迎页: 项目/任务/Skill·Memory) — 设备中枢选择 + Skill/Memory 注入 */}
        <div className="easy-session-input-left flex min-w-0 items-center gap-3">
          {/* 欢迎页: 配置条 (项目下拉 = 设备中枢选择, + SkillMemoryPicker) */}
          {props.toolbar && props.mode === 'create_session_mode' && (
            <div className="flex min-w-0 items-center gap-1.5 overflow-hidden easy-session-config-bar">{props.toolbar}</div>
          )}
          {/* 会话内: 工具菜单按钮 (Plus 简化) - 用户参考图用 + 替代 Wrench, 后续在 EasyModePage 顶栏的会话工具展开完整 6 类 */}
          {/* 会话内: 工具菜单按钮 (Wrench) - 弹出 6 类小工具 (切换会话/项目/语言 + 注入 Skill/Memory/Git) */}
          {follow && (
            <EasySessionToolMenu
              isDark={isDark}
              recentSessions={follow.recentSessions}
              currentSessionId={follow.sessionId}
              onSwitchSession={follow.onSwitchSession}
              language={follow.language}
              onChangeLanguage={follow.onChangeLanguage}
              onInjectSkill={follow.onInjectSkill}
              onInjectMemory={follow.onInjectMemory}
              onInjectGit={follow.onInjectGit}
              onOpenFileChanges={follow.onOpenFileChanges}
              onOpenBashCommands={follow.onOpenBashCommands}
              onOpenInputReplay={follow.onOpenInputReplay}
              onOpenTerminal={follow.onOpenTerminal}
              onOpenCooperablePc={follow.onOpenCooperablePc}
              onOpenKnowledge={follow.onOpenKnowledge}
              onToggleJsonlMeta={follow.onToggleJsonlMeta}
              showJsonlMeta={follow.showJsonlMeta}
              onSendProjectKnowledge={follow.onSendProjectKnowledge}
              projectKnowledgeSending={follow.projectKnowledgeSending}
              jsonlEntryCount={follow.jsonlEntryCount}
              connectionReady={follow.connectionReady}
              hasSession={!!follow.sessionId}
              hasProject={!!follow.currentProjectId}
            />
          )}
        </div>
        {/* 右侧: 模型切换 | 附件上传 (Paperclip) | 语音 | 加急 | 发送/终止 (合并, 蓝色圆形 Codex 风格)
            欢迎页与会话页同一套顺序与样式 (issue 2026-10-17 用户要求) */}
        <div className="easy-session-input-right flex min-w-0 items-center gap-3">
          {follow && (
            <>
              <EasySessionModelPill
                isDark={isDark}
                modelLabel={follow.sessionModelLabel || ''}
                modelKey={follow.sessionModelKey || ''}
                onChange={async (model: string) => {
                  if (!follow.onChangeSessionModel) return
                  await follow.onChangeSessionModel(model)
                }}
                disabled={!follow.modelAvailable || follow.messageSubmitting || !!follow.hasPendingSend || !!follow.voiceBusy}
              />
              {/* 运行设备 pill: 只画图标, 名字留到展开后的列表里 —— 设备名又长又占宽度,
                  而这一行右边同时站着模型 pill 和四个动作键. */}
              {follow.onChangeSessionDevice && (
                <EasySessionDevicePill
                  isDark={isDark}
                  deviceId={follow.sessionDeviceId || ''}
                  onChange={async (deviceId: string) => {
                    if (!follow.onChangeSessionDevice) return
                    await follow.onChangeSessionDevice(deviceId)
                  }}
                  disabled={follow.messageSubmitting || !!follow.hasPendingSend || !!follow.voiceBusy}
                />
              )}
            </>
          )}
          {/* 欢迎页: 运行中枢 + 模型选型 (两个都是「这个会话是什么」的选择, 紧挨着放.
              设备用图标、模型用文字, 但两者之间收窄到 gap-1.5, 让它们读成一个整体,
              而不是两个散开的按钮. 名字留到展开后的列表里 —— 写名字会挤窄模型 pill.
              min-w-0 (而非 flex-shrink-0): 手机窄屏时这个分组要能收缩, 让模型 pill
              的 truncate 截断名称, 否则 195px 的模型名会把整组挤出屏幕. */}
          {props.mode === 'create_session_mode' && (
            <span className="flex min-w-0 items-center gap-1.5">
              {props.onChangeWelcomeDevice && (
                <EasySessionDevicePill
                  isDark={isDark}
                  deviceId={props.welcomeDeviceId || ''}
                  onChange={deviceId => props.onChangeWelcomeDevice?.(deviceId)}
                />
              )}
              {props.welcomeModelKey !== undefined && (
                <EasySessionModelPill
                  isDark={isDark}
                  modelLabel=""
                  modelKey={props.welcomeModelKey}
                  onChange={model => props.onChangeWelcomeModel?.(model)}
                />
              )}
            </span>
          )}
          {/* 欢迎页: 附件上传按钮 (Paperclip, 与会话页同款) */}
          {props.mode === 'create_session_mode' && (
            <button
              type="button"
              onClick={props.onUpload}
              aria-label="上传文件或图片"
              title="上传文件或图片"
              data-testid="easy-welcome-upload"
              className="easy-icon-btn inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--bg-card-hover)]"
              style={{ color: isDark ? '#d1d5db' : '#374151' }}
            >
              <Paperclip className="h-[18px] w-[18px]" strokeWidth={2} />
            </button>
          )}
          {/* 欢迎页: 语音输入按钮 (与会话页同款样式; 录音中红色脉冲) */}
          {props.mode === 'create_session_mode' && props.onToggleWelcomeVoice && (
            <button
              type="button"
              onClick={props.onToggleWelcomeVoice}
              disabled={props.welcomeVoiceState === 'transcribing'}
              aria-pressed={props.welcomeVoiceState === 'recording'}
              aria-label={props.welcomeVoiceTip || '语音输入'}
              title={props.welcomeVoiceTip || '语音输入'}
              data-testid="easy-welcome-voice"
              className={`easy-icon-btn easy-icon-btn--voice inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-colors ${props.welcomeVoiceState === 'recording' ? 'easy-icon-btn--voice-active' : ''}`}
              style={{
                color: props.welcomeVoiceState === 'recording' ? '#f87171' : (isDark ? '#e5e7eb' : '#1f2937'),
                background: props.welcomeVoiceState === 'recording' ? 'rgba(239,68,68,0.13)' : 'transparent',
              }}
            >
              {props.welcomeVoiceState === 'recording' ? <Square className="h-3.5 w-3.5" fill="currentColor" /> : props.welcomeVoiceState === 'transcribing' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Mic className="h-[18px] w-[18px]" strokeWidth={2} />}
            </button>
          )}
          {/* 欢迎页不设 ⚡ 插队键 (issue 2026-10-27, 三键规则):
              欢迎页没有正在跑的任务, ⚡ 无从"打断"; 而它与 ↑ 发送在欢迎页完全同效
              (submitWelcomePrompt 不接 urgent 参数) —— 两个键做同一件事是反模式, 删掉. */}
          {follow && (
            <button
              type="button"
              onClick={follow.onUpload}
              aria-label="上传文件或图片"
              title="上传文件或图片"
              data-testid="easy-session-upload"
              className="easy-icon-btn inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--bg-card-hover)]"
              style={{ color: isDark ? '#d1d5db' : '#374151' }}
            >
              <Paperclip className="h-[18px] w-[18px]" strokeWidth={2} />
            </button>
          )}
          {follow && (
            <button
              type="button"
              onClick={follow.onToggleVoice}
              disabled={follow.messageSubmitting || follow.voiceState === 'transcribing'}
              aria-pressed={follow.voiceState === 'recording'}
              aria-label={follow.voiceTip}
              title={follow.voiceTip}
              className={`easy-icon-btn easy-icon-btn--voice inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-colors ${follow.voiceState === 'recording' ? 'easy-icon-btn--voice-active' : ''}`}
              style={{
                color: follow.voiceState === 'recording' ? '#f87171' : (isDark ? '#e5e7eb' : '#1f2937'),
                background: follow.voiceState === 'recording' ? 'rgba(239,68,68,0.13)' : 'transparent',
              }}
            >
              {follow.voiceState === 'recording' ? <Square className="h-3.5 w-3.5" fill="currentColor" /> : follow.voiceState === 'transcribing' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Mic className="h-[18px] w-[18px]" strokeWidth={2} />}
            </button>
          )}
          {/* 欢迎页: 发送 = 圆形 ↑ 按钮 (参考千问办公 / Codex 的发送键形态, issue 2026-10-26).
              仍是首要动作 (impeccable P0): 强调色实心 + 禁用态灰, 位置固定在工具行最右. */}
          {!follow && (
            <button
              type="button"
              onClick={() => onSend()}
              disabled={disabled}
              aria-label="开始新会话"
              title={sendTip}
              data-tour="session-chat-send"
              className="easy-send-btn inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                background: sendBg,
                color: sendFg,
                cursor: disabled ? 'not-allowed' : 'pointer',
              }}
            >
              <ArrowUp className="h-[15px] w-[15px]" strokeWidth={2.4} />
            </button>
          )}
          {/* 会话内三个动作键 (issue 2026-10-27, impeccable P0 — 综合规划 ⚡/■/↑):
                ↑ 发送 = 主键, 位置与图标恒定; 空闲立即执行, 运行中排队 (后端 noPauseCurrentAndQueueQueryAtSession),
                  肌肉记忆不被"发送↔停止"的形态切换打断;
                ⚡ 插队 = 打断当前并立即执行这句 (仅运行时出现 —— 空闲时普通发送本就是立即的);
                ■ 停止 = 打断当前且不发新话 (仅运行时出现, 破坏性动作).
              布局: [⚡][↑] 紧邻成「发送组」(都是把话递出去), [■] 与发送组隔开独立成破坏键,
              避免误触 —— 红色只属于停止, 蓝色只属于发送. */}
          {follow && (
            <div className="flex flex-shrink-0 items-center gap-1">
              {canStop && (
                <button
                  type="button"
                  onClick={() => onSend(true)}
                  disabled={disabled}
                  data-tour="session-chat-send-urgent"
                  aria-label="加急发送"
                  title="加急 · 打断当前任务并立即执行这句"
                  className="easy-icon-btn inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--bg-card-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ color: '#f59e0b' }}
                >
                  <Zap className="h-[18px] w-[18px]" strokeWidth={2} fill="currentColor" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onSend()}
                disabled={disabled}
                aria-label="发送"
                title={sendTip}
                data-tour="session-chat-send"
                className="easy-send-btn inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-all active:scale-95 disabled:cursor-not-allowed"
                style={{
                  background: queuedFlash ? '#d97706' : sendBg,
                  color: queuedFlash ? '#ffffff' : sendFg,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                {queuedFlash ? (
                  <Clock className="h-3.5 w-3.5" strokeWidth={2.4} />
                ) : follow.anyUploading || follow.voiceState === 'transcribing' ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="h-[15px] w-[15px]" strokeWidth={2.4} />
                )}
              </button>
            </div>
          )}
          {follow && canStop && (
            <button
              type="button"
              onClick={follow.onStop}
              aria-label="终止当前任务"
              title="终止当前任务"
              data-tour="session-chat-stop"
              className={`easy-send-btn easy-send-btn--stop inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-all active:scale-95 ${follow.stopFeedbackActive ? 'easy-send-btn--active' : ''}`}
              style={{ background: '#ef4444', color: '#ffffff', cursor: 'pointer' }}
            >
              <Square className="h-3 w-3" fill="currentColor" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 会话内的"当前模型"显示按钮 (Codex 风格: 文字+下拉箭头, 点击弹 SessionModelDropdown).
 * 复用 SessionModelDropdown 的选项/配额数据, 选中后由 onChange 回调上行 ——
 * 父组件把新模型 POST 到 PATCH /api/sessions/:id/model, 这正是「修改模型并继续」的同一链路.
 *
 * 显示文案: 优先用服务端给的 label, 否则查 model-options 拿 title + sub (例如 "GLM-5.3 (最新) · DeepSeek 高").
 */
function EasySessionModelPill({ isDark, modelLabel, modelKey, onChange, disabled }: {
  isDark: boolean
  modelLabel: string
  modelKey: string
  onChange: (model: string) => void
  disabled?: boolean
}) {
  const { options, stats } = useSessionModelOptions()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  // 过滤: 按 title / label / sub 模糊匹配
  const filteredOptions = query.trim()
    ? options.filter(opt => {
        const q = query.trim().toLowerCase()
        return (opt.title || '').toLowerCase().includes(q)
          || (opt.label || '').toLowerCase().includes(q)
          || (opt.sub || '').toLowerCase().includes(q)
          || (opt.key || '').toLowerCase().includes(q)
      })
    : options

  // 弹窗打开时自动聚焦搜索框
  useLayoutEffect(() => {
    if (open) {
      requestAnimationFrame(() => searchRef.current?.focus())
    } else {
      setQuery('')
    }
  }, [open])

  // 派生"展示名": 1) 服务端给的 label; 2) options.title + options.sub 的前半截 (Codex 风格 "GLM-5.3 (最新) · DeepSeek 高");
  // 3) 渠道兜底; 4) 原始 key.
  const matched = options.find(opt => opt.key === modelKey)
  const friendlyTitle = matched?.title || matched?.label || modelLabel || PROMPT_BACKEND_LABEL[promptBackendKeyForOption(matched)] || modelKey
  // sub 通常是 "Codex · 强力" 这种, Codex 风格只取 · 前的渠道标签
  const subFirst = matched?.sub?.split('·')[0]?.trim()
  const displayText = subFirst && matched
    ? `${friendlyTitle} · ${subFirst}`
    : friendlyTitle

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const el = buttonRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const width = Math.min(300, Math.max(240, window.innerWidth - 16))
      setPos({
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
        width,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    const onClickOutside = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (buttonRef.current?.contains(target)) return
      if (popupRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClickOutside)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClickOutside)
    }
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="当前会话模型"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={disabled ? '当前不可切换模型' : `当前模型: ${displayText || modelKey || '(未设置)'}`}
        onClick={() => setOpen(v => !v)}
        className="easy-icon-btn easy-icon-btn--model inline-flex h-9 max-w-[280px] min-w-0 items-center gap-1.5 rounded-full px-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        style={{
          color: isDark ? '#e5e7eb' : '#1f2937',
          background: open ? 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' : 'transparent',
        }}
      >
        <span className="truncate text-[length:var(--fs-md)] font-medium">
          {friendlyTitle || '模型'}
          {/* 渠道副标签 (· Claude Code): 移动端隐藏, 只留模型名 —— 副标签是次要信息,
              手机上留着它会把 pill 撑宽, 挤掉右侧动作键 (issue 2026-10-29). */}
          {subFirst && matched && <span className="easy-model-sub"> · {subFirst}</span>}
        </span>
        <ChevronDown className={`h-4 w-4 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && pos && createPortal(
        <div
          ref={popupRef}
          role="menu"
          aria-label="切换会话模型"
          data-testid="easy-session-model-picker"
          className="easy-popover-in fixed z-[96] flex flex-col overflow-hidden rounded-2xl shadow-2xl"
          style={{
            left: pos.left,
            bottom: pos.bottom,
            width: pos.width,
            background: 'var(--modal-bg)',
            border: '1px solid var(--border-color)',
            boxShadow: '0 18px 48px -12px rgba(0,0,0,0.5)',
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          {/* 搜索框 */}
          <div className="flex flex-shrink-0 items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--border-color)' }}>
            <Search className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  if (query) setQuery('')
                  else setOpen(false)
                }
              }}
              placeholder="搜索模型..."
              className="min-w-0 flex-1 border-0 bg-transparent text-[length:var(--fs-sm)] outline-none placeholder:text-[length:var(--fs-xs)]"
              style={{ color: 'var(--text-primary)' }}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="清除搜索"
                className="flex-shrink-0 text-[length:var(--fs-xs)] px-1.5 py-0.5 rounded"
                style={{ color: 'var(--text-muted)' }}
              >
                清除
              </button>
            )}
          </div>
          {/* 模型列表 */}
          <div className="min-h-0 max-h-[360px] overflow-y-auto py-1">
            {filteredOptions.length === 0 ? (
              <div className="easy-list-empty">
                <Search className="h-5 w-5" strokeWidth={1.8} />
                <span>{query.trim() ? `未找到与「${query.trim()}」匹配的模型` : '暂无可用模型'}</span>
              </div>
            ) : (
              filteredOptions.map(opt => {
                const isSelected = opt.key === modelKey
                const usage = stats?.model_usage_limits?.models?.[opt.key]
                const blocked = !!usage?.blocked
                return (
                  <button
                    key={opt.key}
                    type="button"
                    role="menuitem"
                    disabled={blocked}
                    onClick={() => { setOpen(false); onChange(opt.key) }}
                    className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                    style={{
                      background: isSelected ? 'rgba(59,130,246,0.12)' : undefined,
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[length:var(--fs-md)] font-medium" style={{ color: isDark ? '#e5e7eb' : '#1f2937' }}>
                          {opt.title || opt.label || opt.key}
                        </span>
                        {isSelected && (
                          <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(59,130,246,0.18)', color: '#60a5fa' }}>当前</span>
                        )}
                      </div>
                      {opt.sub && (
                        <div className="mt-0.5 truncate text-[length:var(--fs-xs)]" style={{ color: 'var(--text-muted)' }}>
                          {opt.sub}
                        </div>
                      )}
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
