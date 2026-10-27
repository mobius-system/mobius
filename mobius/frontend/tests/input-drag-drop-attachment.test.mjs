/**
 * 输入框拖拽文件/图片 → 直接上传为附件 (issue 2026-10-26) 的契约测试.
 *
 * 覆盖四个输入框入口:
 *   1. 简易模式欢迎页输入框 (EasyModePage, create_session_mode)
 *   2. 简易模式会话内输入框 (chat.tsx, follow_session_mode)
 *   3. 标准会话输入框 (chat.tsx, 默认布局)
 *   4. 总览页智能体对话浮窗输入框 (agent-conversation-overlays.tsx)
 *
 * 关键契约:
 *   - dragover 必须 preventDefault, 否则浏览器根本不派发 drop
 *   - 只拦「文件」拖拽 (dataTransfer.types 含 'Files'), 拖文字选区不受影响
 *   - drop 必须把文件交给既有的附件上传链路 (enqueueFiles / enqueueWelcomeFiles / uploadAttachmentFile)
 *   - 拖拽悬停要有可见反馈 (边框高亮 + 「松开以添加文件」遮罩)
 *
 * 运行: node tests/input-drag-drop-attachment.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSource = relativePath => fs.readFileSync(path.join(here, '..', relativePath), 'utf8')

const easyInputSource = readSource('src/components/easy-session-chat-input.tsx')
const chatSource = readSource('src/components/chat.tsx')
const easyPageSource = readSource('src/pages/EasyModePage.tsx')
const overlaySource = readSource('src/components/agent-conversation-overlays.tsx')
const cssSource = readSource('src/index.css')
const attachmentsSource = readSource('src/components/attachments.tsx')

// ===== 1. 简易模式输入框 (欢迎页 + 会话页共用同一组件) =====

assert.match(easyInputSource, /onDragEnter=\{handleDragEnter\}/, '简易输入框必须监听 dragenter')
assert.match(easyInputSource, /onDragOver=\{handleDragOver\}/, '简易输入框必须监听 dragover')
assert.match(easyInputSource, /onDragLeave=\{handleDragLeave\}/, '简易输入框必须监听 dragleave')
assert.match(easyInputSource, /onDrop=\{handleDrop\}/, '简易输入框必须监听 drop')

assert.match(
  easyInputSource,
  /const handleDragOver[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.dataTransfer\.dropEffect = 'copy'/,
  'dragover 必须 preventDefault (否则 drop 不触发) 并把光标设为 copy',
)
assert.match(
  easyInputSource,
  /dragHasFiles[\s\S]*?dataTransfer\?\.types\?\.includes\('Files'\)/,
  '只能拦文件拖拽, 拖文字选区必须保持浏览器默认行为',
)
assert.match(
  easyInputSource,
  /const handleDrop[\s\S]*?event\.preventDefault\(\)[\s\S]*?if \(follow\) follow\.onDrop\(event\)[\s\S]*?else if \(props\.mode === 'create_session_mode'\) props\.onDrop\(event\)/,
  'drop 必须分发给会话页 / 欢迎页各自的 onDrop',
)
assert.match(
  easyInputSource,
  /const handleDragLeave[\s\S]*?event\.currentTarget\.contains\(related\)/,
  'dragleave 必须用 relatedTarget 判断是否真的离开输入框 (否则高亮会闪)',
)
assert.match(easyInputSource, /松开以添加文件/, '拖拽悬停必须给出「松开以添加文件」的可见提示')
assert.match(
  easyInputSource,
  /border: `1px solid \$\{fileDragOver \? \(isDark \? '#60a5fa' : '#2563eb'\) : border\}`/,
  '拖拽悬停时输入框边框必须高亮',
)
assert.match(
  easyInputSource,
  /type FollowSessionModeProps[\s\S]*?onDrop: \(event: DragEvent<HTMLDivElement>\) => void/,
  '会话内模式必须声明 onDrop 回调',
)

// ===== 1b. 拖拽高亮必须真的看得见 =====
// 输入框的阴影/边框被 index.css 的 !important 规则接管, 只改内联 style 会被盖掉,
// 所以必须同时挂 data-drag-over 标记并补 CSS 规则.
assert.match(
  easyInputSource,
  /data-drag-over=\{fileDragOver \? 'true' : undefined\}/,
  '输入框必须挂 data-drag-over 标记, 供 CSS 规则识别拖拽态',
)
assert.match(
  cssSource,
  /\[data-tour="session-chat-input"\]\[data-drag-over="true"\][\s\S]*?box-shadow:[^;]*59, 130, 246[^;]*!important/,
  '拖拽态必须用 CSS 规则覆盖 !important 阴影, 否则蓝色光晕看不见',
)
assert.match(
  cssSource,
  /\[data-page="easy-mode"\] \.easy-welcome-card \[data-tour="session-chat-input"\]\[data-drag-over="true"\][\s\S]*?border-color/,
  '欢迎页输入框卡片的边框被 !important 接管, 拖拽高亮必须同时放开边框色',
)

// ===== 2. 会话内简易输入框 (chat.tsx 接线) =====

assert.match(
  chatSource,
  /mode="follow_session_mode"[\s\S]*?onDrop=\{handleDrop\}/,
  '会话内简易输入框必须把 handleDrop 传下去',
)
assert.match(
  chatSource,
  /const handleDrop = useCallback\([\s\S]*?enqueueFiles\(files\)/,
  '会话内 drop 必须走既有的附件上传链路 enqueueFiles',
)
assert.match(
  chatSource,
  /const handleDragOver = useCallback\([\s\S]*?setIsDraggingFile\(true\)/,
  '标准输入框的拖拽悬停态必须保留',
)

// ===== 3. 标准会话输入框 (拖拽上传不能被回退) =====

assert.match(
  chatSource,
  /onDragOver=\{handleDragOver\}[\s\S]*?onDragLeave=\{handleDragLeave\}[\s\S]*?onDrop=\{handleDrop\}/,
  '标准输入框必须继续支持拖拽上传',
)

// ===== 4. 欢迎页输入框 (EasyModePage 接线) =====

assert.match(
  easyPageSource,
  /mode="create_session_mode"[\s\S]*?onDrop=\{handleWelcomeDrop\}/,
  '欢迎页输入框必须把 handleWelcomeDrop 传下去',
)
assert.match(
  easyPageSource,
  /const handleWelcomeDrop = useCallback\([\s\S]*?enqueueWelcomeFiles\(event\.dataTransfer\.files\)/,
  '欢迎页 drop 必须走既有的附件上传链路 enqueueWelcomeFiles',
)

// ===== 4b. 附件芯片: 欢迎页与会话内都渲染在输入框内部 (issue 2026-10-26) =====
// 之前欢迎页在框内、会话内在框上方, 同一个附件两处位置/样式都不同.
// 统一: 芯片一律由输入框组件渲染在框内顶部, 两处共用 attachments.tsx 的 AttachmentChip.
assert.match(
  easyInputSource,
  /props\.attachments\.length > 0[\s\S]*?props\.attachments\.map\(att =>[\s\S]*?<AttachmentChip/,
  '附件芯片必须由输入框组件渲染在框内 (欢迎页与会话内同一位置)',
)
assert.match(
  easyInputSource,
  /const cardHeight = inputHeight \+ chipsHeight/,
  '框内有芯片时卡片高度必须跟着长高, 否则芯片会被 overflow-hidden 裁掉',
)
assert.doesNotMatch(
  easyPageSource,
  /welcomeAttachments\.map\(/,
  '欢迎页不得在输入框外渲染附件芯片 (统一由输入框组件渲染)',
)
// 会话内的简易输入框分支 (4372 起) 不得自己渲染芯片 —— 统一由输入框组件渲染在框内.
// (专业模式标准输入框的芯片在输入框上方, 那是另一套布局, 不在本次统一范围内)
const easyShellSource = chatSource.slice(
  chatSource.indexOf("{layout === 'easy' && (", chatSource.indexOf('mobius-chat-input')),
  chatSource.indexOf('标准模式输入区', chatSource.indexOf('mobius-chat-input')),
)
assert.ok(easyShellSource.length > 0, '必须能定位到会话内简易输入框分支')
assert.doesNotMatch(
  easyShellSource,
  /<AttachmentChip/,
  '会话内不得在输入框外渲染附件芯片 (统一由输入框组件渲染在框内)',
)
assert.match(
  easyPageSource,
  /attachments=\{welcomeAttachments\}[\s\S]*?onRemoveAttachment=\{removeWelcomeAttachment\}/,
  '欢迎页必须把附件与移除回调交给输入框组件',
)
assert.match(
  chatSource,
  /attachments=\{attachments\}[\s\S]*?onRemoveAttachment=\{removeAttachment\}/,
  '会话内必须把附件与移除回调交给输入框组件',
)
assert.match(
  attachmentsSource,
  /export function AttachmentChip/,
  '附件芯片必须放在共享模块 attachments.tsx, 两处共用同一个组件',
)

// ===== 4c. 执行页不再提供项目选择 (issue 2026-10-26) =====
// 执行页不支持项目切换, 输入框上方的项目选择 pill 与其死代码一并移除.
assert.doesNotMatch(
  chatSource,
  /EasySessionProjectSelector/,
  '执行页不得再渲染项目选择器',
)
assert.doesNotMatch(
  chatSource,
  /easyProjectControl/,
  '项目选择的 prop 链路必须整体移除',
)

// ===== 4d. 三个动作键 ⚡/■/↑ 的分工 (issue 2026-10-27, impeccable P0) =====
// 发送键位置与图标恒定 (运行中=排队), 停止独立成红色破坏键, 插队(⚡)只在运行中出现.
assert.match(
  easyInputSource,
  /const canStop = !!follow && !!follow\.agentWorking/,
  '停止键的显隐必须由 agentWorking 驱动',
)
assert.doesNotMatch(
  easyInputSource,
  /onClick=\{canStop \? follow!\.onStop : \(\) => onSend\(\)\}/,
  '发送与停止不得再合并成一个键 (运行时无法继续发送)',
)
assert.match(
  easyInputSource,
  /\{follow && canStop && \([\s\S]*?onClick=\{follow\.onStop\}[\s\S]*?\) \}/,
  '停止必须是独立按钮, 且只在运行中出现',
)
assert.match(
  easyInputSource,
  /排队发送 · 当前任务结束后执行/,
  '运行中发送必须说明是排队 (后端 queue 路径)',
)
assert.match(
  easyInputSource,
  /title="加急 · 打断当前任务并立即执行这句"/,
  '插队键必须说明与「排队发送」的区别',
)
assert.match(
  chatSource,
  /if \(!urgent && backendAlive && backendWorking\) setQueuedSentAt\(Date\.now\(\)\)/,
  '运行中发送必须写入排队时间戳, 给输入框「已排队」反馈',
)

// ===== 4e. 欢迎页同样遵守三键规则 (issue 2026-10-27) =====
// 欢迎页没有正在跑的任务 → 无 ⚡ 插队键、无 ■ 停止键; 且原 ⚡ 与 ↑ 完全同效, 属重复键, 一并去掉.
// 两页的发送键必须是同一把: 同尺寸圆钮 + 同 ↑ 图标 + 主色蓝.
assert.doesNotMatch(
  easyInputSource,
  /data-testid="easy-welcome-urgent"/,
  '欢迎页不得保留与发送键同效的重复键 (一个键一个语义)',
)
assert.match(
  easyInputSource,
  /!follow && \([\s\S]*?data-tour="session-chat-send"[\s\S]*?h-7 w-7[\s\S]*?<ArrowUp/,
  '欢迎页发送键必须与会话页同款 (28px 圆钮 + ↑ 图标)',
)
assert.match(
  easyInputSource,
  /\{follow && \([\s\S]*?data-tour="session-chat-send"[\s\S]*?<ArrowUp/,
  '会话页发送键必须用同一个 ↑ 图标, 两页完全一致',
)

// ===== 5. 智能体对话浮窗输入框 =====

assert.match(overlaySource, /onDrop=\{onDrop\}/, '智能体浮窗输入框必须监听 drop')
assert.match(
  overlaySource,
  /const onDrop = async \(event: React\.DragEvent<HTMLTextAreaElement>\)[\s\S]*?uploadAttachmentFile\(file, session\.projectId\)/,
  '智能体浮窗 drop 必须复用粘贴同一条上传链路',
)
assert.match(
  overlaySource,
  /onDragOver=\{event =>[\s\S]*?event\.preventDefault\(\)[\s\S]*?setDragOver\(true\)/,
  '智能体浮窗必须在 dragover 时 preventDefault 并高亮',
)

console.log('input drag & drop attachment contract test passed')
