import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSource = relativePath => fs.readFileSync(path.join(here, '..', relativePath), 'utf8')

const appSource = readSource('src/App.tsx')
const shellSource = readSource('src/components/shell.tsx')
const railSource = readSource('src/components/conversation-rail.tsx')
const searchSource = readSource('src/components/search-modal.tsx')
const settingsSource = readSource('src/components/settings-panel.tsx')
const chatSource = readSource('src/components/chat.tsx')
const chatPaneSource = readSource('src/components/chat-pane.tsx')
const composerInputLayoutSource = readSource('src/components/useComposerInputLayout.ts')
const workbenchShellSource = readSource('src/components/workbench-shell.tsx')
const layoutModeSwitchSource = readSource('src/components/layout-mode-switch.tsx')
const advancedPageChromeSource = readSource('src/components/advanced-page-chrome.tsx')
const sessionToolDrawerSource = readSource('src/components/session-tool-drawer.tsx')
const sessionToolContextSource = readSource('src/components/session-tool-context.ts')
const terminalSource = readSource('src/components/web-terminal-modal.tsx')
const filePreviewSource = readSource('src/components/code-artifacts/FilePreviewLayer.tsx')
const gitChangesViewerSource = readSource('src/components/code-git/GitChangesViewer.tsx')
const gitHistoryListSource = readSource('src/components/code-git/GitHistoryList.tsx')
const gitHistoryHookSource = readSource('src/components/code-git/useGitHistory.ts')
const advancedSessionActionsSource = readSource('src/components/advanced-session-actions.tsx')
const editorAvailabilitySource = readSource('src/components/workspace/use-editor-availability.ts')
const sessionWelcomeSource = readSource('src/components/session-welcome.tsx')
const projectSettingsSource = readSource('src/components/project-page/ProjectSettingsPanel.tsx')
const modalsSource = readSource('src/components/modals.tsx')
const desktopActionsSource = readSource('src/components/desktop-page-actions.tsx')
const windowControlsSource = readSource('src/components/window-controls.tsx')
const welcomeSource = readSource('src/pages/Welcome.tsx')
const userPageSource = readSource('src/pages/UserPage.tsx')
const workPageSource = readSource('src/pages/WorkPage.tsx')
const easyModePageSource = readSource('src/pages/EasyModePage.tsx')
const issuePageSource = readSource('src/pages/IssuePage.tsx')
const researchPageSource = readSource('src/pages/ResearchPage.tsx')
const projectPageSource = readSource('src/pages/ProjectPage.tsx')
const navigationSource = readSource('src/services/workbench-navigation.ts')
const layoutModeSource = readSource('src/services/layout-mode.ts')
const cssSource = readSource('src/index.css')
const easyJsonlCssSource = readSource('src/components/easy-jsonl/easy-jsonl.css')
const easyJsonlViewSource = readSource('src/components/easy-jsonl/EasyJsonlView.tsx')
const tasksRouteSource = readSource('../backend/routes/tasks.ts')

function sourceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert(start >= 0 && end > start, `${label} 源码边界必须存在`)
  return source.slice(start, end)
}

const workbenchTopNavSource = sourceBetween(
  shellSource,
  'export function WorkbenchTopNav',
  'export function TopNav',
  '简易模式 TopNav',
)
const normalTopNavSource = sourceBetween(
  shellSource,
  'export function TopNav',
  '// 简易"加载中"占位',
  '常规模式 TopNav',
)
const workbenchGlobalTopbarSource = sourceBetween(
  workbenchShellSource,
  'function WorkbenchGlobalTopbar',
  'export function WorkbenchShell',
  '简易工作台共享 Topbar',
)
const easyIssuePageSource = sourceBetween(
  issuePageSource,
  'function EasyIssuePage',
  'export function LegacyIssuePage',
  '简易 IssuePage',
)
const legacyIssuePageSource = sourceBetween(
  issuePageSource,
  'export function LegacyIssuePage',
  'function WorkspacePaneLoading',
  '常规 IssuePage',
)
const emptyIssueComposerSource = sourceBetween(
  issuePageSource,
  'function EmptyConversationComposer',
  '// 默认任务页只承担',
  'Issue 空态 Composer',
)
const easyCompatibilitySource = sourceBetween(
  appSource,
  'function EasyModeCompatibility',
  'function IssueRouteCompatibility',
  'easy_mode 兼容路由',
)
const workbenchRouteLayoutSource = sourceBetween(
  appSource,
  'function WorkbenchRouteLayout',
  'function EasyModeCompatibility',
  '共享工作台路由层',
)
const easyModeRoutesSource = sourceBetween(
  appSource,
  "layoutMode === 'easy_mode' ? (",
  '          ) : (',
  '简易模式路由',
)
const normalModeRoutesSource = sourceBetween(
  appSource,
  '          ) : (\n            <Routes>',
  '          )}\n        </Suspense>',
  '常规模式路由',
)
const issueCompatibilitySource = sourceBetween(
  appSource,
  'function IssueRouteCompatibility',
  'function AuthenticatedApp',
  'Issue 兼容路由',
)
const homeSurfaceSource = sourceBetween(
  userPageSource,
  'function HomeSurface',
  'function AllProjectsView',
  '默认 Home',
)
const homeAttachmentButtonSource = sourceBetween(
  homeSurfaceSource,
  '<button\n                      type="button"\n                      data-home-composer-attachment-button',
  '</button>',
  'Home Composer 附件按钮',
)
const homeSendButtonSource = sourceBetween(
  homeSurfaceSource,
  'className="home-composer-send',
  '</button>',
  'Home Composer 发送按钮',
)
const homeRecentProjectsSource = sourceBetween(
  homeSurfaceSource,
  '{usableProjects.slice(0, 3)',
  '</section>',
  'Home 最近项目',
)
const minimalProjectCreateSource = sourceBetween(
  userPageSource,
  'function MinimalProjectCreate',
  'function HomeSurface',
  '首页项目创建空态',
)
const easySessionChromeSource = sourceBetween(
  chatSource,
  '<div className="easy-session-context',
  '{/* 旧高级布局保留完整会话标题栏',
  '默认 Session chrome',
)
const rootThemeSource = sourceBetween(
  cssSource,
  ':root {',
  '\n}\n\n.purple {',
  'Dark / 默认主题 token',
)
const lightThemeSource = sourceBetween(
  cssSource,
  '.light {',
  '\n}\n\n/* ===== 默认工作台语义组件层',
  'Light 主题 token',
)
const editorToolSource = sourceBetween(
  advancedSessionActionsSource,
  '<ToolMenuGroup label="编辑器"',
  '<ToolMenuGroup label="本会话上下文"',
  'Tools 编辑器分组',
)
const overflowActionsSource = sourceBetween(
  advancedSessionActionsSource,
  'if (overflow) {',
  'if (menu) {',
  'Tool Drawer header overflow',
)
const menuActionsSource = sourceBetween(
  advancedSessionActionsSource,
  'if (menu) {',
  'className={`advanced-session-actions mobius-chat-input-actions',
  '窄屏完整 Tools menu',
)
const toolDrawerContentSource = sourceBetween(
  chatSource,
  'const toolDrawerContent = (() => {',
  '  return (\n    <div className="flex-1 flex flex-col h-full min-w-0"',
  'Tool Drawer 当前 tab 内容',
)
const sessionFilesDrawerSource = sourceBetween(
  chatSource,
  'function SessionFilesDrawerSurface(',
  'function SessionDiffCenterSurface(',
  'Tool Drawer 文件列表',
)
const filesToolContentSource = sourceBetween(
  toolDrawerContentSource,
  "if (activeToolTab === 'files')",
  "if (activeToolTab === 'diff')",
  'Tool Drawer Files tab',
)
const returnToChatSource = sourceBetween(
  chatSource,
  'const returnToChat = useCallback',
  'useEffect(() => {\n    if (centerMode',
  '中心 Diff 返回动作',
)

// 05 视觉语言：Dark / Light 都必须提供同一组 chrome surface 与状态语义，Light 次级文字不得与弱提示合层。
for (const token of ['surface-sidebar', 'surface-topbar', 'surface-messages', 'surface-composer']) {
  assert.match(rootThemeSource, new RegExp(`--${token}:\\s*[^;]+;`), `Dark 必须定义 --${token}`)
  assert.match(lightThemeSource, new RegExp(`--${token}:\\s*[^;]+;`), `Light 必须定义 --${token}`)
}
for (const token of ['status-running', 'status-waiting', 'status-danger', 'status-success', 'status-unknown']) {
  assert.match(rootThemeSource, new RegExp(`--${token}:\\s*[^;]+;`), `Dark 必须定义 --${token}`)
  assert.match(lightThemeSource, new RegExp(`--${token}:\\s*[^;]+;`), `Light 必须定义 --${token}`)
}
const lightTextSecondary = lightThemeSource.match(/--text-secondary:\s*([^;]+);/)?.[1].trim()
const lightTextMuted = lightThemeSource.match(/--text-muted:\s*([^;]+);/)?.[1].trim()
assert.ok(lightTextSecondary && lightTextMuted, 'Light 必须同时定义 --text-secondary 与 --text-muted')
assert.notEqual(lightTextSecondary, lightTextMuted, 'Light 的 --text-secondary 与 --text-muted 必须保持可见分层')

// Codex Desktop 消息 / Composer 纪律：白底悬浮胶囊、中性灰选中、用户气泡无硬边框。
const workbenchComposerRule = cssSource.match(/\.workbench-composer\s*\{([^}]*)\}/)?.[1] || ''
const workbenchComposerFocusRule = cssSource.match(/\.workbench-composer:focus-within\s*\{([^}]*)\}/)?.[1] || ''
const workbenchComposerTextareaRule = cssSource.match(/\.workbench-composer textarea\s*\{([^}]*)\}/)?.[1] || ''
const easyChatInputRule = cssSource.match(/\.mobius-chat-body\.mobius-chat-body--easy \.mobius-chat-input\s*\{([^}]*)\}/)?.[1] || ''
const easyChatInputOcclusionRule = cssSource.match(/\.mobius-chat-body\.mobius-chat-body--easy \.mobius-chat-input::before\s*\{([^}]*)\}/)?.[1] || ''
const homeComposerSendRule = cssSource.match(/\.mobius-workbench \.home-composer-send\s*\{([^}]*)\}/)?.[1] || ''
assert.match(workbenchComposerRule, /border:\s*1px solid var\(--border-strong\)/, '共享 Composer 必须使用 --border-strong')
assert.match(workbenchComposerRule, /border-radius:\s*var\(--radius-composer/, '共享 Composer 必须使用胶囊圆角 token')
assert.match(workbenchComposerRule, /box-shadow:\s*var\(--shadow-composer\)/, '共享 Composer 必须使用悬浮阴影 token')
assert.match(workbenchComposerRule, /background:\s*color-mix\([^;]*var\(--surface-composer\)[^;]*var\(--surface-card\)/, '共享 Composer 必须使用 composer / card surface token')
assert.doesNotMatch(workbenchComposerRule, /var\(--surface-card\)\s*78%/, '共享 Composer 不得再让透明 card surface 占混色多数')
assert.doesNotMatch(workbenchComposerRule, /#[0-9a-f]{3,8}\b|rgba?\(/i, '共享 Composer 不得回退到硬编码 slate / rgba 表面')
assert.match(workbenchComposerFocusRule, /border-color:\s*color-mix\([^;]*var\(--border-strong\)/, '共享 Composer 聚焦必须保持中性边界，不得换成整圈 accent')
assert.doesNotMatch(workbenchComposerFocusRule, /--accent-primary|--focus-ring-soft/, '共享 Composer 聚焦不得使用高饱和 accent 描边或外圈光晕')
assert.match(workbenchComposerTextareaRule, /background:\s*transparent[\s\S]*font-size:\s*14px[\s\S]*line-height:\s*1\.55/, 'Home 与 Session textarea 必须共享透明底和 14px / 1.55 排版')
assert.match(easyChatInputRule, /background:\s*var\(--surface-messages\)\s*!important/, 'Easy Composer wrapper 必须用不透明消息表面挡住下方内容')
assert.match(easyChatInputOcclusionRule, /width:\s*100vw[\s\S]*background:\s*linear-gradient\([\s\S]*var\(--surface-messages\)/, 'Easy Composer 必须提供整宽、以 --surface-messages 为实底的底部遮挡层')
assert.doesNotMatch(easyChatInputRule, /background:\s*transparent\s*!important/, 'Easy Composer wrapper 不得再只有透明背景')
assert.match(homeComposerSendRule, /color:\s*var\(--bg-primary\)[\s\S]*background:\s*var\(--text-primary\)/, 'Home 发送按钮必须使用主题文字/背景 token 反色，不得回退到天蓝底')
assert.doesNotMatch(homeComposerSendRule, /--accent-primary|--accent-border/, 'Home 发送按钮不得继承 accent 胶囊外观')
assert.match(cssSource, /\.mobius-workbench \.home-composer-project-select:focus-within,[\s\S]*?border-color:\s*var\(--border-strong\)\s*!important;/, 'Home 原生项目/模型选择器聚焦必须落在中性强边框')
assert.match(cssSource, /\[data-home-composer-expand-toggle\]:focus-visible,[\s\S]*?\.home-recent-project:focus-visible,[\s\S]*?outline-color:\s*var\(--border-strong\)/, 'Home 次级控件的键盘焦点不得恢复亮蓝外圈')

const easyPromptRule = easyJsonlCssSource.match(/\.easy-jsonl-prompt\s*\{([^}]*)\}/)?.[1] || ''
const easyPromptBubbleRule = easyJsonlCssSource.match(/\.easy-jsonl-prompt__bubble\s*\{([^}]*)\}/)?.[1] || ''
const easyPromptBodyRule = easyJsonlCssSource.match(/\.easy-jsonl-prompt \.jsonl-compact-md\s*\{([^}]*)\}/)?.[1] || ''
const easyResponseRule = easyJsonlCssSource.match(/\.easy-jsonl-response\s*\{([^}]*)\}/)?.[1] || ''
assert.match(easyPromptBubbleRule, /border:\s*1px solid transparent/, '用户任务气泡不得再用可见硬边框，只保留透明描边占位')
assert.doesNotMatch(easyPromptRule, /border-left:\s*(?:[23]px|[^;]*var\(--accent-primary\))/, '用户任务卡不得再使用 2–3px 或 accent-primary 左侧装饰条')
assert.match(easyPromptBubbleRule, /background:\s*var\(--surface-user-bubble/, '用户任务必须使用中性灰气泡表面')
assert.match(easyPromptBubbleRule, /border-radius:\s*var\(--radius-bubble/, '用户任务气泡必须使用 Codex 式大圆角')
assert.doesNotMatch(easyPromptBubbleRule, /box-shadow/, '用户任务气泡不得再使用 inset 高光或额外阴影')
assert.match(easyPromptRule, /width:\s*fit-content/, '短用户任务必须按内容收缩，而不是铺满整列')
assert.match(easyPromptRule, /margin-left:\s*auto/, '用户任务必须靠右，形成 Codex 式气泡')
assert.match(easyPromptRule, /max-width:\s*100%/, '长用户任务应对齐 880px 对话列，不得再被 560px 截成细长卡')
assert.doesNotMatch(easyPromptRule, /560px|min\(72%/, '用户任务气泡不得再使用 72% / 560px 窄上限')
assert.match(easyJsonlCssSource, /\.easy-jsonl-rounds \{ width: min\(880px, 100%\)/, '简易对话列必须对齐 Composer 的 880px 可读宽')
assert.match(easyPromptBubbleRule, /padding:\s*12px 16px/, '用户任务必须使用 Codex 式气泡内边距')
assert.doesNotMatch(easyJsonlCssSource, /easy-jsonl-prompt__avatar/, '用户任务不得再占用圆形头像列')
assert.doesNotMatch(easyJsonlViewSource, /你的任务<\/strong>/, '用户任务不得再渲染可见的「你的任务」标题行')
assert.match(easyJsonlViewSource, /aria-label="用户任务"/, '用户任务必须保留屏幕阅读器标签')
assert.match(easyJsonlViewSource, /splitEasyUserPrompt/, '用户任务必须拆出系统注入的上下文后再渲染')
const easyRoundsSource = readSource('src/components/viewer/rounds.ts')
assert.match(easyRoundsSource, /canonicalUserText/, '同一次提问的裸原文与 wrapUserMessage 框架必须按正文去重')
assert.match(easyRoundsSource, /isFramedUserText\(raw\) && !isFramedUserText\(prevRaw\)/, '去重后必须留下带系统上下文的那条，而不是先到的裸气泡')
assert.match(easyJsonlViewSource, /<span>系统上下文<\/span>/, '系统上下文按钮文案必须固定，展开后不得改成「收起系统上下文」把命中盒撑走')
assert.doesNotMatch(easyJsonlViewSource, /收起系统上下文<\/span>/, '系统上下文可见文案不得随展开变长')
assert.match(easyJsonlCssSource, /\.easy-jsonl-prompt__context-toggle \{[\s\S]*align-self:\s*flex-end/, '系统上下文按钮必须钉在靠右卡片的稳定右缘')
assert.doesNotMatch(easyJsonlCssSource, /\.easy-jsonl-prompt--system-only\.is-expanded \{[^}]*padding:/, '纯系统上下文展开不得改 padding 把按钮挪位')
assert.match(easyJsonlViewSource, /contextOpen \? <JsonlCompactMarkdown text=\{hidden\}/, '系统上下文默认不得展开渲染')
assert.match(easyPromptBodyRule, /font-size:\s*14px[\s\S]*line-height:\s*1\.55/, '用户任务正文必须保留 14px / 1.55 排版')
assert.match(easyResponseRule, /background:\s*transparent/, '助手回复必须落在页面背景上，而不是第二张卡片')
assert.match(easyResponseRule, /padding:\s*0/, '助手回复不得再包一层卡片内边距')
assert.match(easyResponseRule, /border:\s*0/, '助手回复不得再使用卡片边框')
assert.doesNotMatch(easyResponseRule, /margin-left|padding-left/, '助手回复不得再通过左侧头像偏移塑形')
assert.match(easyJsonlCssSource, /\.easy-jsonl-activity, \.easy-jsonl-live \{[^}]*min-height:\s*30px/, '折叠活动行高度必须压到 30px')
assert.match(easyJsonlCssSource, /\.easy-jsonl-activity__summary \{[\s\S]*padding:\s*5px 10px 5px 28px/, '折叠活动摘要必须使用 Codex 式芯片内边距')
assert.doesNotMatch(easyJsonlCssSource, /#22c55e|#4ade80/i, '简易时间线不得硬编码完成态绿色')

// 双模式入口：首次选择、简易工作台与常规工作台必须各走自己的渲染路径。
assert.match(appSource, /modeTarget && !layoutMode[\s\S]*<LayoutModeChoiceModal \/>/, '首页或 Issue 缺 layout_mode 时必须挂载布局模式选择弹窗')
assert.match(easyModeRoutesSource, /<Route path="\/u\/:user" element=\{<WorkbenchRouteLayout \/>\}>[\s\S]*<Route path="s\/:session" element=\{<WorkPage \/>\} \/>/, '简易模式必须在共享工作台路由层挂载会话短路由')
assert.match(easyModeRoutesSource, /<Route path="\/u\/:user\/easy_mode" element=\{<EasyModePage \/>\} \/>/, '简易模式必须把用户 easy_mode 路由挂到 EasyModePage')
assert.match(normalModeRoutesSource, /<Route path="\/u\/:user" element=\{<UserPage \/>\} \/>/, '常规模式用户首页必须直接渲染 UserPage')
assert.match(normalModeRoutesSource, /<Route path="\/u\/:user\/p\/:project\/i\/:issue" element=\{<IssuePage \/>\} \/>/, '常规模式 Issue 必须直接渲染模式感知的 IssuePage')
assert.match(normalModeRoutesSource, /<Route path="\/u\/:user\/s\/:session" element=\{<NormalSessionRedirect \/>\} \/>/, '常规模式短会话必须先还原到 Issue 或 Research URL')
assert.doesNotMatch(normalModeRoutesSource, /WorkbenchRouteLayout|WorkbenchShell|WorkPage|IssueRouteCompatibility/, '常规模式的 User、Issue、Session 不得进入精简工作台壳')
assert.match(appSource, /function NormalSessionRedirect\([\s\S]*buildNormalModeTargetUrl\([\s\S]*sessionId/, '常规短会话重定向必须使用 buildNormalModeTargetUrl 并保留 session')
assert.match(appSource, /<Route path="\/easy_mode" element=\{<EasyModeCompatibility \/>\} \/>/, 'App.tsx 必须保留根 easy_mode 兼容入口')
assert.match(easyCompatibilitySource, /\/u\/\$\{encodeURIComponent\(userId\)\}\/easy_mode\$\{location\.search\}\$\{location\.hash\}/, '根 easy_mode 必须兼容跳到用户 EasyModePage 并保留查询与 hash')
assert.match(issueCompatibilitySource, /legacySessionRedirect\(params\.user \|\| '', location\.search, location\.hash\)/, '简易 Issue 兼容路由必须把旧 session 参数转成会话短路由')
assert.match(issueCompatibilitySource, /return redirect \? <Navigate to=\{redirect\} replace \/> : <IssuePage \/>/, '简易 Issue 没有 session 时必须继续渲染模式感知的 IssuePage')

for (const exportedApi of ['LAYOUT_MODE_CHANGE_EVENT', 'setLayoutMode', 'useLayoutMode', 'buildNormalModeTargetUrl']) {
  assert.match(layoutModeSource, new RegExp(`export (?:const|function) ${exportedApi}`), `layout-mode.ts 必须导出 ${exportedApi}`)
}
assert.match(layoutModeSource, /LAYOUT_MODE_STORAGE_KEY = 'layout_mode'/, '布局模式存储 key 不得变化')
assert.match(issuePageSource, /export default function IssuePage\([\s\S]*layoutMode === 'easy_mode' \? <EasyIssuePage \/> : <LegacyIssuePage \/>/, 'IssuePage 必须按模式切换简易实现与 LegacyIssuePage')
assert.match(userPageSource, /layoutMode === 'easy_mode'[\s\S]*<HomeSurface \/>[\s\S]*<AllProjectsView \/>/, 'UserPage 必须让简易模式进入 HomeSurface、常规模式进入项目列表')

// Web 默认首页是当前用户主页；Welcome 只保留显式路由和设置中的连接/导入入口。
assert.match(appSource, /return <Navigate to=\{homePath\(user\.id\)\} replace \/>/, '根路径必须通过 canonical helper 跳转到当前用户主页')
assert.match(appSource, /<Route path="\/welcome"/, 'Welcome 兼容路由必须继续保留')
assert.doesNotMatch(appSource, /<Navigate to=[^>]*\/welcome/, '默认 Web 导航不得自动跳转到 Welcome')
assert.match(settingsSource, /label="连接 \/ 导入向导"[\s\S]*go\('\/welcome', true\)/, 'Welcome 必须从设置高级区作为连接/导入次级入口可达')

// 简易工作台使用 36–40px 单层 chrome，且变量不能污染常规页面。
for (const label of ['历史', '搜索', '新会话']) {
  assert.match(workbenchShellSource, new RegExp(`aria-label="${label}"`), `共享主壳必须提供「${label}」入口`)
}
const workbenchTopbarHeight = Number(cssSource.match(/--workbench-topbar-height:\s*(\d+)px;/)?.[1])
assert.ok(workbenchTopbarHeight >= 36 && workbenchTopbarHeight <= 40, '简易主壳顶栏必须保持在 36–40px')
assert.doesNotMatch(rootThemeSource, /--workbench-topbar-height/, '38px 工作台顶栏变量不得成为正常模式的全局默认')
assert.match(cssSource, /\.mobius-workbench,[\s\S]*\[data-page="easy-mode"\][\s\S]*--workbench-topbar-height:\s*38px/, '38px 顶栏变量必须只挂在简易工作台或 EasyModePage 作用域')
assert.match(cssSource, /--rail-width:\s*280px;/, '桌面 Rail 默认宽度必须是 280px')
assert.doesNotMatch(homeSurfaceSource, /<TopNav|<ConversationRail/, 'Home 不得再手写 TopNav + ConversationRail 外壳')
assert.doesNotMatch(workPageSource, /<TopNav|<ConversationRail/, 'Session 不得再手写 TopNav + ConversationRail 外壳')
for (const slot of ['header', 'search', 'body', 'bottom']) {
  assert.match(railSource, new RegExp(`data-rail-slot="${slot}"`), `ConversationRail 必须提供 ${slot} 槽`)
}
assert.match(railSource, /data-rail-slot="bottom"[\s\S]*aria-label="账户"[\s\S]*aria-label="设置"/, '账户与设置必须位于 Rail bottom')
assert.match(workbenchShellSource, /returnFocusRef=\{settingsReturnFocusRef\}/, 'Settings 关闭后必须恢复 Rail 触发焦点')
assert.match(workbenchGlobalTopbarSource, /<LayoutModeSwitch \/>/, '简易 WorkbenchGlobalTopbar 必须挂载共享模式分段控件')
assert.match(workbenchTopNavSource, /<LayoutModeSwitch \/>[\s\S]*ref=\{settingsButtonRef\}/, '简易 WorkbenchTopNav 必须把共享模式分段控件放在设置与账户之前')
assert.match(normalTopNavSource, /<LayoutModeSwitch \/>[\s\S]*data-tour="top-theme-toggle"[\s\S]*data-tour="top-user-menu"/, '常规 TopNav 必须把共享模式分段控件放在可见动作簇的外观与账户之前')
assert.match(layoutModeSwitchSource, /data-testid="layout-mode-switch"[\s\S]*MODE_OPTIONS\.map[\s\S]*aria-pressed=\{selected\}/, '共享模式控件必须用同一组简易/常规分段表达当前态')
assert.match(layoutModeSwitchSource, /if \(layoutMode === targetMode\) return[\s\S]*setLayoutMode\(targetMode\)/, '再次点击当前模式必须 no-op')
assert.match(layoutModeSwitchSource, /targetMode === 'normal_mode'[\s\S]*buildNormalModeTargetUrl\([\s\S]*sessionId/, '切到常规模式必须按当前对象与会话上下文构造目标 URL')
assert.match(layoutModeSwitchSource, /navigate\(sessionId \? sessionPath\(userId, sessionId\) : homePath\(userId\)\)/, '切到简易模式必须优先进入会话短路由，否则回工作台首页')
assert.doesNotMatch(shellSource, /data-testid="easy-mode-switch"/, '外观菜单不得保留旧简易模式开关')
assert.doesNotMatch(workbenchShellSource, /data-testid="workbench-normal-mode-switch"/, '简易工作台不得保留旧单向常规模式按钮')
assert.match(easyModePageSource, /<WorkbenchTopNav \/>/, 'EasyModePage 必须使用简易工作台 TopNav')

// 简易 Home / Session / Issue 必须是同一父路由下的 Main slot，页面自身不能重建壳。
assert.match(easyModeRoutesSource, /<Route path="\/u\/:user" element=\{<WorkbenchRouteLayout \/>\}>[\s\S]*<Route index element=\{<UserPage \/>\} \/>[\s\S]*<Route path="s\/:session" element=\{<WorkPage \/>\} \/>[\s\S]*<Route path="p\/:project\/i\/:issue" element=\{<IssueRouteCompatibility \/>\} \/>/, '简易 Home、Session、Issue 必须挂在同一个持久化父路由下')
assert.equal((workbenchRouteLayoutSource.match(/<WorkbenchShell\b/g) || []).length, 1, '共享路由层只能创建一个 WorkbenchShell 实例')
assert.match(workbenchRouteLayoutSource, /<WorkbenchShell[\s\S]*<Suspense fallback=\{<WorkbenchMainFallback \/>\}>[\s\S]*<Outlet \/>[\s\S]*<\/WorkbenchShell>/, 'WorkbenchShell 必须持有稳定 chrome，只由 Outlet 替换 Main slot')
assert.match(workbenchRouteLayoutSource, /<Suspense fallback=\{<WorkbenchMainFallback \/>\}>[\s\S]*<Outlet \/>/, '懒加载页面时必须保留主壳，只替换 Main slot fallback')
for (const [label, source] of [['Home', homeSurfaceSource], ['Session', workPageSource], ['Issue', easyIssuePageSource]]) {
  assert.doesNotMatch(source, /<WorkbenchShell/, `${label} 页面自身不得重建 WorkbenchShell`)
}
assert.match(workbenchShellSource, /<ConversationRail[\s\S]*workbench-shell__topbar[\s\S]*workbench-shell__main[\s\S]*workbench-shell__preview[\s\S]*workbench-shell__right[\s\S]*workbench-shell__dock/, 'WorkbenchShell 必须按 sidebar/topbar/main/preview/right/dock 组合')
assert.doesNotMatch(workbenchShellSource, /ref=\{element => setSlotTarget\(/, 'WorkbenchShell 槽位 callback ref 必须保持稳定，避免提交期 setState 无限重渲染')
for (const slot of ['Topbar', 'Preview', 'Right', 'Dock']) {
  assert.match(workbenchShellSource, new RegExp(`const set${slot}Target = useCallback`), `WorkbenchShell ${slot} 槽位必须使用稳定 callback ref`)
}
assert.match(workPageSource, /data-workbench-chat-host[\s\S]*data-workbench-editor-host[\s\S]*data-workbench-chat-instance="primary"[\s\S]*hidden=\{!activeSessionLoaded\}[\s\S]*<ChatArea[\s\S]*layout="easy"[\s\S]*chrome="shell"[\s\S]*shellChromeActive=\{activeSessionLoaded\}[\s\S]*workspaceEditor=/, '默认 Session 必须把按需编辑器宿主与唯一 easy ChatArea 放在稳定槽位，并在加载期隐藏 shell chrome')
assert.match(workPageSource, /hidden=\{!activeSessionLoaded\}[\s\S]*className="workbench-session-chat__surface flex/, '切换 Session 时保活的旧 Chat 必须使用不会参与加载期布局的专用 surface')
assert.match(cssSource, /\.workbench-session-chat__surface\[hidden\]\s*\{[\s\S]*?display:\s*none\s*!important;[\s\S]*?\}/, '隐藏的旧 Chat 必须强制退出 flex 布局，避免与加载占位并排后发生宽度跳变')
assert.match(chatSource, /if \(toolFilesReady \|\| toolFilesLoading\) return[\s\S]*?void loadToolFiles\(\)/, 'Session 文件抽屉必须把空结果视为已完成，避免无限重复扫描')
assert.match(easyModePageSource, /<ChatArea[\s\S]*layout="easy"/, 'EasyModePage 必须显式使用 easy ChatArea')
assert.match(easyIssuePageSource, /<ChatArea layout="easy"/, '简易 Issue 必须显式使用 easy ChatArea')
assert.match(legacyIssuePageSource, /layout=\{\(useEditorChat \|\| useCodeConversation\) \? 'stacked' : 'default'\}/, '常规 Issue 必须只使用 default / stacked ChatArea')
assert.match(chatSource, /export function ChatArea\(\{ layout = 'default'/, 'ChatArea 默认布局必须恢复为 default')
assert.match(chatSource, /variant=\{layout === 'easy' \? 'easy' : 'standard'\}/, '只有 easy ChatArea 可以使用 easy JSONL，常规布局必须使用 standard')
assert.match(chatSource, /layout === 'easy' && shellChromeActive[\s\S]*WorkbenchShellPortal slot="topbar"/, 'WorkbenchShellPortal 的薄会话顶栏必须受 layout === easy 门槛保护')
assert.match(easySessionChromeSource, /workbench-session-topbar[\s\S]*data-testid="easy-session-context"/, '默认 Session 会话头必须进入共享薄 shell topbar')
assert.match(easySessionChromeSource, /aria-label="工具"[\s\S]*aria-controls=\{chrome === 'shell' \? 'session-tool-drawer'[\s\S]*<Wrench/, '默认 Session 只保留一个无文字 Tool Drawer 控制器')
assert.match(easySessionChromeSource, /aria-label="当前会话标题"[\s\S]*currentSession\?\.name \|\| currentTask\?\.name \|\| sessionId/, '默认 Session 顶栏主信息只能是会话标题')
assert.doesNotMatch(easySessionChromeSource, /easy-session-summary|easyRoundCount\} 轮|alwaysShowLabel/, '项目面包屑、轮次摘要与常驻状态文案不得撑宽薄顶栏')
assert.match(sessionToolDrawerSource, /id="session-tool-drawer"/, 'Tool Drawer 控制器必须指向真实抽屉元素')
assert.match(easySessionChromeSource, /renderAdvancedSessionActions\('menu'\)/, '既有会话能力必须收进工具入口，不能被删除')
assert.match(chatSource, /const showEasyStop = Boolean\([\s\S]*backendAlive && backendWorking/, '停止动作必须由会话运行状态控制')
assert.match(easySessionChromeSource, /\{showEasyStop && \([\s\S]*handleStopSession/, '默认 Session 只在运行期显示停止动作')
assert.doesNotMatch(easySessionChromeSource, /OpenInVSCodeButton|AimuxLinkIndicator|AnnouncePcButton|WorkspaceLayoutToggle/, '默认 Session 会话头不得平铺高级工具')
assert.doesNotMatch(homeSurfaceSource, /WorkspaceLayoutToggle|GlobalCreateMenu|系统可视化|openAdminOverlay|CustomThemePalette|MemoryIndicator|assistantBubble/, '默认 Home 不得挂载退出默认表面的高级 chrome')
assert.match(settingsSource, /快捷助手[\s\S]*label="系统可视化"[\s\S]*label="旧项目总览"[\s\S]*label="主题工坊"[\s\S]*label="打开管理中心"/, '助手气泡、Overview、主题工坊与管理员入口必须保留在 Settings')

// P0-S3/S4：Composer 动态让底；Chat/Diff 切层只改 UI state，并在对象导航前清理旧选择。
assert.match(chatPaneSource, /ResizeObserver[\s\S]*--composer-overlay-height/, 'Composer 必须用 ResizeObserver 写入动态 overlay 高度')
assert.match(chatSource, /useComposerOverlayHeight\(chatBodyRef, chatInputRef, layout === 'easy'\)/, '唯一 easy ChatArea 必须接入动态 Composer 测高')
assert.match(composerInputLayoutSource, /desktop:\s*\{[\s\S]*collapsed:\s*\{ minHeight: 60, maxHeight: 120 \}[\s\S]*expanded:\s*\{ minHeight: 180, maxHeight: 320 \}/, '桌面 Composer 必须锁定折叠 60/120、展开 180/320')
assert.match(composerInputLayoutSource, /mobile:\s*\{[\s\S]*collapsed:\s*\{ minHeight: 52, maxHeight: 168 \}[\s\S]*expanded:\s*\{ minHeight: 152, maxHeight: 280 \}/, '移动 Composer 必须锁定折叠 52/168、展开 152/280')
assert.match(composerInputLayoutSource, /textarea\.style\.height = 'auto'[\s\S]*Math\.min\(Math\.max\(scrollHeight, minHeight\), maxHeight\)/, 'Composer 必须先解除高度再按 scrollHeight 自动 clamp')
assert.match(composerInputLayoutSource, /scrollHeight > maxHeight \? 'auto' : 'hidden'/, 'Composer 内容超过 max 前必须隐藏纵向滚动，超过后才启用 auto')
assert.match(chatSource, /useComposerInputLayout\(\{[\s\S]*textareaRef: inputRef,[\s\S]*value: input,[\s\S]*expanded: inputExpanded,[\s\S]*enabled: layout === 'easy'/, 'easy Session Composer 必须使用共享输入高度策略')
assert.match(chatSource, /data-composer-expand-toggle[\s\S]*inputExpanded \? <ChevronDown[\s\S]*<ChevronUp/, 'easy Session Composer 必须提供内联 chevron 展开/收起按钮')
assert.match(chatSource, /\{inputExpanded && layout !== 'easy' && \(/, '长文本 modal 只能保留给非 easy 布局')
assert.match(chatSource, /maxHeight: layout === 'easy' \? easyComposerLayout\.maxHeight : '70vh'/, 'easy Composer 必须使用动态高度，常规 Composer 必须保留原 70vh 上限')
assert.match(homeSurfaceSource, /useComposerInputLayout\(\{[\s\S]*textareaRef: composerRef,[\s\S]*value: prompt,[\s\S]*expanded: false,[\s\S]*isMobile: isComposerMobile/, 'Home Composer 必须复用共享输入高度策略并保持自动增长')
assert.doesNotMatch(homeSurfaceSource, /composerExpanded|data-home-composer-expand-toggle|ChevronDown|ChevronUp/, 'Home Composer 不得保留无意义的展开/收起按钮')
assert.match(homeSurfaceSource, /data-home-composer-attachment-button[\s\S]*aria-label="选择附件"[\s\S]*<Paperclip/, 'Home Composer 必须在发送按钮左侧提供通用附件入口')
assert.match(homeSurfaceSource, /overflowY: homeComposerLayout\.overflowY[\s\S]*color: 'var\(--text-primary\)'/, 'Home Composer 必须保留共享动态 overflow')
assert.match(homeAttachmentButtonSource, /onClick=\{openFilePicker\}[\s\S]*title="添加附件"/, 'Home 附件按钮必须打开通用文件选择器')
assert.match(homeSendButtonSource, /home-composer-send[\s\S]*rounded-full/, 'Home 发送必须使用专用的紧凑圆形主动作')
assert.doesNotMatch(homeSendButtonSource, /btn-primary|px-4/, 'Home 发送不得继续继承天蓝胶囊主按钮')
assert.match(homeRecentProjectsSource, /borderColor: project\.id === selectedProjectId \? 'var\(--border-strong\)'[\s\S]*background: project\.id === selectedProjectId \? 'var\(--surface-active\)'/, 'Home 最近项目选中态必须使用中性强边框与 active 表面')
assert.doesNotMatch(homeRecentProjectsSource, /--accent-primary|--accent-border/, 'Home 最近项目不得使用整圈 accent 边框')
assert.doesNotMatch(chatSource, /data-tour="session-chat-input"\s*className="workbench-composer[^"]*"\s*style=/, 'Session Composer 不得用内联表面覆盖共享 .workbench-composer')
assert.match(chatSource, /className=\{layout === 'easy'[\s\S]*\? 'workbench-composer[\s\S]*: 'relative rounded-lg[\s\S]*style=\{layout === 'easy' \? undefined/, '胶囊 workbench-composer 必须只作用于 easy，常规布局保留原输入框表面')
assert.doesNotMatch(cssSource, /\.mobius-chat-body\.mobius-chat-body--easy \.mobius-chat-input textarea \{[\s\S]*?min-height:\s*72px\s*!important;/, 'CSS 不得用 72px !important 覆盖 easy Composer 动态高度')
assert.match(chatSource, /inert[\s\S]*data-workbench-chat-layer/, '隐藏的 Chat layer 必须 inert')
assert.match(chatSource, /data-workbench-diff-layer[\s\S]*centerMode === 'diff'/, '选文件必须在中心切换 Diff layer')
assert.match(returnToChatSource, /setCenterDiffOpen\(false\)[\s\S]*restoreToolSourceFocus/, 'Back/Esc 必须关闭中心 Diff 并恢复来源焦点')
assert.doesNotMatch(returnToChatSource, /setSelectedToolFilePath\(''\)/, '回 Chat 时必须保留对象选择，供 Files / Diff / Git / Terminal 切换复用')
assert.match(chatSource, /useLayoutEffect\(\(\) => \{[\s\S]*setActiveToolTab\('files'\)[\s\S]*setCenterDiffOpen\(false\)[\s\S]*setTerminalDockOpen\(false\)[\s\S]*setSelectedToolFilePath\(''\)[\s\S]*\}, \[sessionId, toolOrigin\]\)/, 'Session 切换必须在绘制前清掉旧对象、Drawer tab 与 Terminal dock')
assert.match(navigationSource, /prepareWorkbenchObjectNavigation[\s\S]*exitWorkbenchCenterTool\(\)[\s\S]*clearWorkbenchObjectSelection\(\)/, '对象导航必须按 exitCenterTool → clearObjectSelection 顺序执行')
assert.match(userPageSource, /selectHomeProject[\s\S]*prepareWorkbenchObjectNavigation\(\)[\s\S]*requestAnimationFrame/, 'Home 选 Project 后必须回 Chat 语义并恢复焦点')
assert.doesNotMatch(workPageSource, /prepareWorkbenchObjectNavigation/, 'WorkPage 新会话不得与 WorkbenchShell 重复执行对象导航清理')
assert.doesNotMatch(easyIssuePageSource, /prepareWorkbenchObjectNavigation/, 'Issue 新会话不得与 WorkbenchShell 重复执行对象导航清理')
assert.doesNotMatch(homeSurfaceSource, /<main\b/, 'WorkbenchShell 内的 Home 不得嵌套 main landmark')
assert.doesNotMatch(minimalProjectCreateSource, /<main\b/, 'WorkbenchShell 内的项目创建空态不得嵌套 main landmark')
assert.doesNotMatch(workPageSource, /<main\b/, 'WorkbenchShell 内的 Session 不得嵌套 main landmark')
assert.doesNotMatch(emptyIssueComposerSource, /<main\b/, 'WorkbenchShell 内的 Issue Composer 不得嵌套 main landmark')
assert.match(chatSource, /headingRef\.current\?\.focus\(\{ preventScroll: true \}\)[\s\S]*data-workbench-diff-layer/, '进入中心 Diff 后必须把焦点移到 Diff 标题')
assert.match(chatSource, /event\.defaultPrevented \|\| document\.querySelector\('\[role="dialog"\],[\s\S]*returnToChat\(\)/, 'Diff Esc 必须先让最上层 dialog、menu 或 popover 响应')

// P1-S1~S5：按需 Tool Drawer、Files→Diff、终端、快照和只读 MetaBar。
for (const tab of ['files', 'diff', 'terminal', 'editor', 'skill', 'memory', 'git']) {
  assert.match(sessionToolDrawerSource, new RegExp(`id: '${tab}'`), `Tool Drawer 必须提供 ${tab} tab`)
}
assert.match(cssSource, /--tool-drawer-width:\s*230px;[\s\S]*data-session-tool-drawer.*data-open="true"/, '宽屏 Tool Drawer 必须是可折叠的 230px 列')
assert.doesNotMatch(sessionToolDrawerSource, /grid-cols-4|\{tab\.label\}<\/span>/, 'Tool Drawer 一级 tab 必须是单行 icon-only chrome，不能回到文字宫格')
assert.match(sessionToolDrawerSource, /aria-label="会话工具"[\s\S]*aria-orientation="horizontal"[\s\S]*aria-label=\{tab\.label\}[\s\S]*title=\{tab\.label\}/, 'icon-only tab 必须把中文名称保留在可访问标签和 title')
for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']) {
  assert.match(sessionToolDrawerSource, new RegExp(`event\\.key === '${key}'`), `Tool Drawer tab 必须支持 ${key} 键`)
}
assert.match(sessionToolDrawerSource, /tabIndex=\{index === focusableIndex \? 0 : -1\}/, 'Tool Drawer tab 必须使用 roving tabindex')
assert.match(chatSource, /SessionFilesDrawerSurface[\s\S]*setSelectedToolFilePath\(path\)[\s\S]*SessionDiffCenterSurface/, 'Drawer Files 选择必须驱动中心 Diff')
assert.match(sessionFilesDrawerSource, /FileText[\s\S]*\{basename\}[\s\S]*\{file\.count\}/, 'Tool Drawer 文件项必须保持 icon、basename 与 count 单行结构')
assert.match(sessionFilesDrawerSource, /title=\{`\$\{fullPath\} · \$\{timeLabel\}`\}/, '文件完整路径与时间只能进入 title，不占列表第二行')
assert.doesNotMatch(sessionFilesDrawerSource, /本次改动|>\{formatFeatureTime\(file\.last_timestamp\)\}</, 'Files / Diff 列表不得恢复大标题或可见时间戳行')
assert.match(sessionFilesDrawerSource, /点选后在中心看 Diff/, 'Diff tab 只保留短提示')
assert.match(sessionFilesDrawerSource, /surface-active[\s\S]*inset 2px 0 var\(--accent-primary\)/, '选中文件必须用 surface-active 与 inset accent，不得加厚边框')
assert.match(filesToolContentSource, /data-session-tool-object[\s\S]*\.split\('\/'\)[\s\S]*\.at\(-1\)[\s\S]*预览/, 'Files 当前对象必须收成 basename + 预览单行')
assert.match(filesToolContentSource, /浏览项目文件 \/ 引用/, 'Files 必须保留扁平的项目文件与引用入口')
assert.match(chatSource, /setToolFilesLoading\(false\)[\s\S]*setToolFilesError\(''\)/, '切 Session 必须复位扫描 loading，避免新会话卡在扫描中')
assert.match(chatSource, /toolFilesRequestTokenRef[\s\S]*toolFilesAbortRef[\s\S]*AbortController/, '文件扫描必须用请求序号取消旧请求')
assert.match(chatSource, /SESSION_FEATURE_FILES_TIMEOUT_MS[\s\S]*features\/files[\s\S]*扫描超时，请稍后重试/, '文件扫描超时后必须结束 spinner 并给出可重试错误')
assert.match(chatSource, /token !== toolFilesRequestTokenRef\.current[\s\S]*setToolFilesLoading\(false\)/, '迟到的旧扫描结果不得覆盖新 Session 状态')
assert.doesNotMatch(filesToolContentSource, /本次改动|showDiffHint|更多会话动作/, 'Files tab 不得显示 Diff 提示、改动标题或高级动作目录')
assert.doesNotMatch(sessionToolDrawerSource, /navigate\(|useNavigate|stage|unstage|commit|push/, 'Tool Drawer 不得改路由或新增 Git 写操作')
assert.match(chatSource, /openToolTab\('terminal'\)[\s\S]*WebTerminalSurface[\s\S]*terminalDockOpen/, 'Terminal 必须直接进入 Drawer，并可展开到底坞')
assert.doesNotMatch(terminalSource, /关闭弹窗后可重新打开/, '终端失败必须在原表面提供重试，不能要求先关闭')
assert.match(chatSource, /在设置中管理[\s\S]*snapshotOnly[\s\S]*gitOnly/, 'Skill / Memory / Git 必须在 Drawer 复用 Session 快照表面')
for (const label of ['文件', '改动', '终端', '编辑器', '技能', '记忆', 'Git']) {
  assert.match(sessionToolDrawerSource, new RegExp(`: '${label}'`), `Tool Drawer 必须提供中文主标签「${label}」`)
}
assert.doesNotMatch(easySessionChromeSource, />Tools<|\? activeToolTab/, 'Session Tool 控制器不得显示英文或原始 tab id')
assert.match(chatSource, /data-composer-metabar[\s\S]*currentModelLabel[\s\S]*projectForSession[\s\S]*修改模型并继续/, 'easy Composer MetaBar 只能就近展示模型、Project 与新 Session 入口')
assert.doesNotMatch(easySessionChromeSource, /Harness|harness/, 'Harness 不得进入默认 Session 首屏')
assert.equal((workPageSource.match(/<ChatArea\b/g) || []).length, 1, '默认 Session 不得创建第二套 ChatArea')
assert.match(chatSource, /硬约束: 发送按钮永远只执行 send[\s\S]*终止必须使用上方独立/, 'Send 与 Stop 必须继续保持独立语义')

// P2-2：编辑器只从 Tools 按需出现；Editor 与 Chat 都以稳定槽位保活。
assert.match(workPageSource, /const \[editorMounted, setEditorMounted\] = useState\(false\)[\s\S]*setEditorMounted\(true\)[\s\S]*setEditorOpen\(true\)/, '编辑器必须首次打开才挂载，不能进入 Session 就加载 IDE chrome')
assert.match(workPageSource, /hidden=\{!editorOpen\}[\s\S]*inert:[\s\S]*data-workbench-editor-host[\s\S]*editorMounted && editorAvailable[\s\S]*<EditorPane/, '编辑器关闭后必须 hidden + inert 保活现有 EditorPane')
assert.match(workPageSource, /data-workbench-editor-host[\s\S]*data-workbench-chat-instance="primary"[\s\S]*<ChatArea/, '编辑器宿主必须固定在唯一 Chat 实例之前，开关不得改变 Chat 兄弟槽位')
assert.match(workPageSource, /const closeEditor = useCallback\(\(\) => \{[\s\S]*setEditorOpen\(false\)[\s\S]*focusWorkbenchTarget\('composer'\)/, '关闭编辑器必须原地回到同一 Session composer')
assert.match(workPageSource, /!editorAvailability\.bindPath[\s\S]*bind path[\s\S]*!editorAvailability\.vscodeWebUrl[\s\S]*code-server/, '入口必须分别说明 bind path 与 code-server 前置条件')
assert.match(editorAvailabilitySource, /resolved\?\.key === key[\s\S]*cached \?\? null/, '切项目后的首帧不得复用上一项目的编辑器地址')
assert.match(cssSource, /\.workbench-session-editor\[data-open="true"\][\s\S]*width: clamp\(440px, 52%, 720px\)/, '宽屏编辑器必须使用按需 split，不能常驻固定三栏')
assert.match(cssSource, /@media \(max-width: 1100px\)[\s\S]*\.workbench-session-editor\[data-open="true"\][\s\S]*position: absolute[\s\S]*inset: 0[\s\S]*width: 100%/, '1024px 与更窄宽度必须使用工作区内全高 drawer')

// 08 / P1-1、P1-2、P1-4、P1-5、P1-6：能力只在需要时展开，并把失败后的下一步放回原位。
for (const group of ['文件', 'Diff / Git', '终端', '本会话上下文', '继续方式', 'Research']) {
  assert.match(menuActionsSource, new RegExp(`ToolMenuGroup label="${group.replace('/', '\\/')}"`), `variant="menu" 必须继续包含「${group}」任务组`)
}
assert.match(menuActionsSource, /\{editorMenuGroup\}/, 'variant="menu" 必须继续包含完整编辑器任务组')
assert.match(editorToolSource, /data-workbench-open-editor[\s\S]*OpenInVSCodeButton[\s\S]*mode="direct"/, 'Tools 必须先打开会话旁编辑器，再把 VSCode 保留为第二动作')
assert.match(editorToolSource, /data-workbench-editor-prerequisite[\s\S]*editorUnavailableReason/, '编辑器不可用时必须在入口处显示前置条件，不能打开空面板')
assert.match(chatSource, /activeToolTab === 'editor'[\s\S]*data-workbench-editor-tool[\s\S]*renderAdvancedSessionActions\('editor'\)/, 'Tools Drawer 必须把「编辑器」作为可见一级 tab，不能藏在更多动作里')
assert.doesNotMatch(toolDrawerContentSource, /<details|更多会话动作|renderAdvancedSessionActions\('menu'\)/, 'Files / Diff 与其他 tab 内容不得在底部倾倒完整会话动作目录')
assert.match(sessionToolDrawerSource, /aria-label="更多会话动作"[\s\S]*session-tool-drawer__overflow/, 'Tool Drawer 必须在 header 提供更多会话动作 overflow')
assert.match(chatSource, /overflow=\{renderAdvancedSessionActions\('overflow'\)\}/, 'Tool Drawer header 必须接入精简 overflow variant')
for (const group of ['继续方式', '运行与协作', '知识', 'Research']) {
  assert.match(overflowActionsSource, new RegExp(`ToolMenuGroup label="${group}"`), `overflow 必须包含「${group}」任务组`)
  assert.match(overflowActionsSource, new RegExp(`ToolMenuGroup label="${group}"[^>]* flat>`), `overflow 的「${group}」必须使用扁平分组`)
}
assert.doesNotMatch(overflowActionsSource, /label="(?:项目文件|会话文件修改|打开终端|打开编辑器|本会话 Skill 快照|本会话 Memory 快照|Git 仓库状态)"/, 'overflow 不得重复已有 Files / Diff / Terminal / Editor / Skill / Memory / Git 一级入口')
assert.doesNotMatch(overflowActionsSource, /onOpen(?:ProjectFiles|FileChanges|Terminal|Editor|Skill|Memory|Git)/, 'overflow 不得通过别名重复调用已有一级 tab 能力')
assert.match(chatSource, /onOpenProjectFiles=\{\(\) => \{[\s\S]*setRemoteFileDrawerOpen\(true\)/, 'Tools 的文件入口必须复用现有文件选择 Drawer')
assert.match(chatSource, /label="添加附件"[\s\S]*icon=\{<Paperclip/, 'Composer 必须直接显示纸夹附件入口')
assert.match(chatSource, /sourceFile\?: File[\s\S]*aria-label=\{`重试上传/, '附件上传失败必须在原附件旁显示重试动作')
assert.match(chatSource, /const retryAttachment[\s\S]*uploadAttachmentFile\(target\.sourceFile, currentProjectId\)/, '附件 Retry 必须复用当前页面保留的原 File')
assert.match(chatSource, /restoreSessionInputDraft\(sentSessionId, sentInput\)[\s\S]*setFailedSendAttempt/, '发送失败必须恢复原 Session 草稿并记录可重试请求')
assert.match(chatSource, /originalWasRecorded[\s\S]*请重试上一条未完成的请求[\s\S]*原请求未到达后端时复用 payload/, 'Retry 必须先判断原请求是否已记录，避免重复用户消息')
assert.match(chatSource, /lastSendError[\s\S]*failedSendAttempt\?\.sessionId === sessionId[\s\S]*aria-label="重试发送上一条消息"/, '发送失败的 Retry 必须与错误原位呈现')
assert.match(cssSource, /\.easy-session-context \.session-stop-button \{[\s\S]*min-height: var\(--control-height-md\)[\s\S]*background: var\(--status-danger-soft\)/, '运行中的 Stop 必须在 Session 头保持高可见')
assert.match(advancedSessionActionsSource, /全量管理在 Settings[\s\S]*本会话 Skill 快照[\s\S]*本会话 Memory 快照/, 'Tools 必须区分本会话 Skill/Memory 快照与全量管理')
assert.match(sessionWelcomeSource, /snapshotOnly[\s\S]*snap\.skills \|\| \[\][\s\S]*管理变更只用于后续新会话[\s\S]*在 Settings 管理/, 'Skill/Memory 快照弹层只能读取本会话选择，并把管理导向 Settings')
assert.match(sessionWelcomeSource, /gitOnly=\{initialPanel === 'git'\}[\s\S]*|gitOnly[\s\S]*!gitOnly/, '从 Tools 打开的 Git 弹层不得旁路进入 Skill/Memory 全量管理')
assert.match(sessionWelcomeSource, /gitOnly=\{initialPanel === 'git'\}/, 'Git 复用弹层必须限制为 Git 单面板，不能旁路进入 Skill/Memory 管理')
assert.match(workbenchShellSource, /mobius:open-settings[\s\S]*initialSection=\{settingsInitialSection\}/, '会话快照的管理动作必须能打开 Settings 对应分类')
assert.match(settingsSource, /Memory 管理[\s\S]*变更用于后续新会话，不改当前 Session 快照[\s\S]*Skills 管理[\s\S]*变更用于后续新会话，不改当前 Session 快照/, 'Settings 必须明确全量管理不回写当前 Session 快照')
assert.match(advancedSessionActionsSource, /不会热切模型[\s\S]*修改模型并继续（新会话）/, '模型入口必须先说明会新建 Session，不能暗示热切')
assert.match(modalsSource, /确认后会<strong>新建一个 Session<\/strong>[\s\S]*取消，留在原 Session[\s\S]*新建 Session 并继续/, '改模型确认层必须说明确认会新建 Session、取消留在原 Session')

// 三组统一快捷键由共享主壳提供，且基础任务也有可见按钮。
assert.match(workbenchShellSource, /event\.metaKey \|\| event\.ctrlKey/, '快捷键必须同时支持 Cmd 和 Ctrl')
assert.match(workbenchShellSource, /event\.isComposing \|\| event\.keyCode === 229/, '共享快捷键在 IME 组字期间不得触发')
assert.match(workbenchShellSource, /target\.matches\('input, textarea, select'\) \|\| target\.isContentEditable/, 'Cmd/Ctrl+N 在编辑控件内不得抢走输入')
assert.match(workbenchShellSource, /event\.key\.toLowerCase\(\) === 'k'[\s\S]*openSearch\(\)/, 'Cmd/Ctrl+K 必须打开搜索并记录触发焦点')
assert.match(workbenchShellSource, /event\.key\.toLowerCase\(\) === 'n'[\s\S]*startNewConversation\(\)/, 'Cmd/Ctrl+N 必须开始新会话')
assert.match(workbenchShellSource, /event\.key === ',' \|\| event\.code === 'Comma'/, 'Cmd/Ctrl+, 必须打开设置')

// 响应式静态布局回归（无需登录态或浏览器）。
assert.match(railSource, /window\.matchMedia\('\(min-width: 1280px\)'\)/, 'ConversationRail 必须以 1280px 作为常驻断点')
assert.match(railSource, /className="hidden h-full xl:block"/, '1280px 及以上必须直接显示历史轨')
assert.match(railSource, /xl:hidden" style=\{\{ top: 'var\(--workbench-topbar-height\)' \}\}/, '窄屏历史抽屉必须跟随共享 topbar 高度并在 xl 隐藏')
assert.match(workbenchShellSource, /xl:hidden[\s\S]*aria-label="历史"/, '窄屏必须从顶部「历史」按钮一次打开抽屉')
assert.match(workbenchShellSource, /\{topbar \?\? \([\s\S]*<WorkbenchGlobalTopbar/, 'Portal 尚未挂载时共享顶栏必须提供 fallback')
assert.match(cssSource, /workbench-shell__topbar:has\(\[data-workbench-session-topbar\]\)[\s\S]*workbench-global-topbar[\s\S]*display:\s*none/, 'Session Portal 挂载后必须隐藏 fallback，避免双顶栏内容')
assert.match(userPageSource, /max-w-\[880px\]/, '首页 Composer 上限必须是 880px')
assert.match(emptyIssueComposerSource, /max-w-\[880px\]/, 'Issue 空态 Composer 上限必须是 880px')
assert.match(cssSource, /\.mobius-chat-body\.mobius-chat-body--easy \.mobius-chat-input \{[\s\S]*?width: min\(880px, calc\(100% - 40px\)\) !important;/, '会话 Composer 上限必须是 880px')
assert.match(cssSource, /\.mobius-chat-input\.mobius-chat-input--with-actions \{[\s\S]*?width: min\(880px, calc\(100% - 32px\)\) !important;/, '带工具的会话 Composer 也不得超过 880px')

// P2-3：文件、Diff、Git、终端共享一个对象来源；失败在原工具内重试。
assert.match(chatSource, /rememberArtifactSource\(request\)[\s\S]*setSelectedToolFilePath\(request\.target\.path\)[\s\S]*openToolTab\('diff'\)/, '消息中的 Diff 目标必须直接定位当前对象，不能只打开空工具面')
assert.match(chatSource, /toolObjectContext[\s\S]*sourceLabel=\{toolSourceLabel\}[\s\S]*objectLabel=\{toolObjectLabel\}/, 'Tool Drawer 必须持续展示来源与当前对象')
assert.match(sessionToolDrawerSource, /data-session-tool-source/, 'Tool Drawer 必须持续展示来源和对象 meta')
assert.match(sessionToolDrawerSource, /onClick=\{onCollapse\}[\s\S]*关闭工具并返回来源/, '关闭 Tool Drawer 必须回来源消息或原页')
assert.match(chatSource, /activeToolTab !== 'files' && activeToolTab !== 'diff'[\s\S]*toolFiles\[0\][\s\S]*setSelectedToolFilePath\(next\.path\)/, '从 Issue / Research 打开 Files / Diff 时必须自动选中已有变更')
assert.match(chatSource, /terminalContextLoading[\s\S]*\/files\?path=\/[\s\S]*当前项目未绑定工作目录[\s\S]*重试终端/, '终端必须先定位会话项目工作目录，失败原地重试')
assert.match(terminalSource, /workingDirectoryLabel[\s\S]*data-terminal-working-directory[\s\S]*重试连接/, '现有终端必须显示安全工作目录标签并保留连接重试')
assert.match(chatSource, /本会话改过，但当前工作树无该 diff[\s\S]*onRetry[\s\S]*重试当前 Diff|重试当前 Diff[\s\S]*本会话改过，但当前工作树无该 diff/, '中心 Diff 的空态或错误态必须提供原地重试')
assert.match(gitChangesViewerSource, /重试当前 Diff[\s\S]*重试当前来源/, 'GitChangesViewer 的 Diff 错误与空态必须均可原地重试')
assert.match(filePreviewSource, /sanitizeToolError[\s\S]*safeToolPathLabel\(activeRequest\.target\.path\)/, '文件不存在或越权时只能显示安全路径标签并保留预览重试')
assert.match(filePreviewSource, /aria-modal="false"/, '文件预览不得再做成盖住对话的模态层')
assert.match(cssSource, /--file-preview-width:[\s\S]*workbench-shell__preview:has\(\[data-code-artifact-preview\]\)[\s\S]*flex: 0 0 var\(--file-preview-width\)/, '宽屏文件预览必须占用按需 preview 列，而不是全屏 overlay')
assert.doesNotMatch(filePreviewSource, /code-artifact-layer__backdrop/, '文件预览不得渲染模糊遮罩')
assert.doesNotMatch(cssSource, /code-artifact-layer__backdrop/, '文件预览样式不得保留全屏 blur backdrop')
assert.match(sessionToolContextSource, /isAbsoluteToolPath[\s\S]*return basename[\s\S]*sanitizeToolError/, '对象上下文必须在项目 API 确认前隐藏绝对路径')
assert.match(workPageSource, /readWorkbenchSourceSurface\(location\.state\) \|\| 'session'[\s\S]*toolOrigin=\{sessionToolOrigin\}/, '短 Session 路由必须继承 Issue / Research 来源语义')
assert.match(easyIssuePageSource, /sourceSurface: 'issue'[\s\S]*toolOrigin="issue"/, 'Issue 入口必须携带 Issue 来源上下文')
assert.match(researchPageSource, /sourceSurface: 'research'[\s\S]*toolOrigin="research"/, 'Research 入口必须携带 Research 来源上下文')
assert.match(gitChangesViewerSource, />变更<|\? '变更' : '历史'/, 'GitChangesViewer 左侧必须提供变更 / 历史切换')
assert.match(gitChangesViewerSource, /git-history\/\$\{selectedCommit\.hash\}\/diff[\s\S]*URLSearchParams\(\{ file: selectedCommitFile\.path \}\)/, 'commit 必须先加载文件列表，再请求单文件 diff')
assert.match(gitChangesViewerSource, /该文件历史[\s\S]*setHistoryFile/, '选中 commit 文件后必须能进入该文件历史')
assert.match(gitChangesViewerSource, /该 commit 没有可显示的文件 diff[\s\S]*该 commit 中没有这个文件的 diff/, 'commit 空 diff 与单文件空 diff 必须有原位态')
for (const field of ['subject', 'short_hash', 'author_name', 'relative_date', 'refs']) {
  assert.match(gitHistoryListSource, new RegExp(`commit\\.${field}`), `commit 行必须显示 ${field}`)
}
assert.match(gitHistoryListSource, /ArrowDown[\s\S]*ArrowUp[\s\S]*Home[\s\S]*End[\s\S]*Enter/, 'commit 历史必须支持方向键与 Enter 浏览')
assert.match(gitHistoryHookSource, /AbortController[\s\S]*requestTokenRef[\s\S]*controllerRef\.current\?\.abort/, '历史请求必须同时使用 abort 与 request token')
assert.match(gitChangesViewerSource, /commitRequestTokenRef[\s\S]*commitFileRequestTokenRef[\s\S]*AbortController/, '快速切 commit / 文件时旧 diff 请求不得覆盖新选择')
assert.match(gitChangesViewerSource, /filesRequestTokenRef[\s\S]*filesAbortRef[\s\S]*SESSION_FEATURE_FILES_TIMEOUT_MS/, 'GitChangesViewer 文件扫描必须取消旧请求并设超时')
assert.match(gitChangesViewerSource, /扫描超时，请稍后重试[\s\S]*token === filesRequestTokenRef\.current[\s\S]*setLoading\(false\)/, 'GitChangesViewer 超时后必须结束扫描并忽略迟到响应')
assert.match(sessionWelcomeSource, /选择 Git source[\s\S]*role="radiogroup"[\s\S]*source\.kind === 'hub' \? '变更与历史' : '仅状态'/, '会话 Git tab 必须先显示 source selector 与能力标签')
assert.match(sessionWelcomeSource, /source\.available && source\.kind === 'hub'[\s\S]*查看变更与历史[\s\S]*未提供 commit log\/diff API/, '只有中枢 source 可以进入完整 viewer，本地和 AIMUX 远端必须明确仅状态')
assert.match(projectSettingsSource, /只读查看[\s\S]*<GitChangesViewer[\s\S]*initialView="history"/, '项目设置版本追踪必须深链到同一只读 viewer')
assert.doesNotMatch(gitChangesViewerSource, /onStage|onCommit|onRollback|onPush|onPull|git-action|deploy-version|hard-reset/, '只读 viewer 不得加入 Git 写操作')

// 历史和复制链接统一生成 /u/:user/s/:session。
assert.match(railSource, /return sessionPath\(userId, item\.session_id\)/, 'ConversationRail 必须通过 canonical helper 生成会话短路由')
assert.match(chatSource, /const path = sessionPath\(user\.id, activeSessionId\)/, '复制会话链接必须通过 canonical helper 生成当前用户的会话短路由')

// 历史轨只保留「项目文件夹 → 会话」两层，projectId 仅用于焦点而不得过滤其他项目。
assert.match(railSource, /type ProjectFolder = \{[\s\S]*projectId: string[\s\S]*projectName: string[\s\S]*items: ConversationRailItem\[\][\s\S]*runningCount: number/, 'ConversationRail 必须建立项目文件夹结构')
assert.match(railSource, /const itemProjectId = item\.project_id \|\| ''/, '会话必须按 project_id 归入项目文件夹')
assert.match(railSource, /const itemProjectName = itemProjectId \? \(item\.project_name \|\| '未命名项目'\) : '未命名项目'/, '文件夹必须使用 project_name，无 project_id 时归入「未命名项目」')
assert.match(railSource, /aria-expanded=\{expanded\} aria-controls=\{folderPanelId\}/, '项目文件夹必须可展开和折叠')
assert.match(railSource, /mobius:ui:conversation-rail:collapsed/, '项目文件夹折叠状态必须持久化')
assert.match(railSource, /folder\.projectName\.toLowerCase\(\)\.includes\(normalizedQuery\)[\s\S]*item\.name/, '搜索必须同时匹配项目名和会话名')
assert.match(railSource, /item\.session_id[\s\S]*includes\(normalizedQuery\)/, '搜索必须支持直接匹配 session id')
assert.match(railSource, /function relativeActivityTime[\s\S]*lastActiveTime\(item\)/, '会话行必须显示相对活跃时间')
assert.match(railSource, /pollRecursive\([\s\S]*\/api\/tasks\/recent\?limit=100/, '会话轨必须轮询更新运行状态')
assert.match(railSource, /containsActiveSession \|\| folder\.runningCount > 0\) return true/, '活动或运行中的项目文件夹必须保持展开')
assert.doesNotMatch(railSource, /type (?:TimeBucket|ConversationTimeGroup)|group\w*ByTimeBucket/, '项目文件夹不得再额外套日期分组')
assert.doesNotMatch(railSource, /(?:items|projectFolders)\.filter\([\s\S]{0,180}item\.project_id\s*(?:===|!==)\s*projectId/, 'projectId 不得再过滤会话列表')
assert.doesNotMatch(railSource, /\{item\.project_name \|\| '未命名项目'\}/, '会话行不得重复显示项目副标题')
assert.match(tasksRouteSource, /req\.query\.limit \|\| 12[\s\S]*Math\.min\(100,/, '/api/tasks/recent 必须保留默认 12，并允许最多 100 条')

// 三个默认页面的新会话空态最终都汇入 create-conversation orchestration。
assert.match(userPageSource, /from '\.\.\/services\/create-conversation'/, 'UserPage 必须使用统一 create-conversation 服务')
assert.match(userPageSource, /createDefaultConversation\(\{[\s\S]{0,320}projectId: selectedProjectId,[\s\S]{0,320}prompt,[\s\S]{0,320}checkpoint/, '首页发送必须调用统一 create-conversation 服务')
assert.match(homeSurfaceSource, /<HomeModelHarnessSelect[\s\S]*value=\{selectedModel\}/, '默认 Home 必须提供模型与 Harness 组合选择')
assert.match(homeSurfaceSource, /createDefaultConversation\(\{[\s\S]*model: selectedModel/, '默认 Home 必须把所选组合传给会话创建服务')
assert.match(homeSurfaceSource, /usableProjects\.slice\(0, 3\)/, '默认 Home 最多展示 3 个最近项目')
assert.match(emptyIssueComposerSource, /createDefaultConversation\(\{ projectId, prompt, checkpoint: initialCheckpoint \}\)/, 'Issue 空态发送必须调用统一 create-conversation 服务')
assert.match(workbenchRouteLayoutSource, /navigate\(homePath\(userId, \{ projectId \}\)\)[\s\S]*mobius:new-conversation/, 'Session 新会话必须由共享壳带项目上下文回到统一首页 Composer')

// 07 / P0-4~6：canonical 导航、Research Graph 深链与 overlay 焦点契约。
assert.match(navigationSource, /export function sessionPath[\s\S]*\/s\/\$\{segment\(sessionId\)\}/, '导航 helper 必须定义统一 Session 短路由')
assert.match(navigationSource, /export function legacySessionRedirect[\s\S]*params\.get\('session'\)/, '导航 helper 必须兼容读取旧 ?session= 参数')
assert.match(navigationSource, /safeWorkbenchReturnTo[\s\S]*candidate\.startsWith\('\/\/'\)/, 'returnTo 必须拒绝站外或协议相对重定向')
assert.match(railSource, /navigateToWorkbenchObject\(navigate, sessionNavigation\(userId, item\.session_id\)\)/, 'Rail 必须先清工具状态，再通过 canonical helper 打开 Session')
assert.match(searchSource, /sessionNavigation\(user\?\.id \|\| '', verifiedSessionId,[\s\S]*onNavigate\(destination\.path, \{ state: destination\.state \}\)/, '全局搜索必须通过 canonical helper 打开后端确认的 Session')
assert.match(issuePageSource, /navigateToWorkbenchObject\(navigate, sessionNavigation\(userParam, sessionId, \{ sourceSurface: 'issue' \}\)\)/, 'Issue 必须通过 canonical helper 打开创建后的 Session 并携带来源')
assert.match(researchPageSource, /navigateToWorkbench\(navigate, sessionNavigation\(userParam, sid, \{ sourceSurface: 'research' \}\)\)/, 'Research 必须通过 canonical helper 打开 Session 并携带来源')
assert.match(projectPageSource, /sessionNavigation\(userParam, options\.planningSessionId\)[\s\S]*issueNavigation\(userParam, projectId, iss\.id,[\s\S]*researchNavigation\(userParam, projectId, research\.id,/, 'Project 必须通过 canonical helper 打开 Session、Issue 与 Research')
assert.match(chatSource, /onOpenResearchGraph=\{user\?\.id && currentProjectId && currentResearchId && sessionId[\s\S]*researchGraphNavigation/, 'Research Graph 只在完整研究上下文存在时显示并使用高级页深链')
assert.match(researchPageSource, /readWorkbenchReturnTo[\s\S]*<AdvancedPageChrome[\s\S]*returnTo=\{returnTo\}/, 'Research Graph 页面共享返回按钮必须消费已校验的 returnTo')
assert.match(advancedPageChromeSource, /data-workbench-main-heading/, '共享高级页 chrome 必须提供可聚焦主标题')
assert.match(chatSource, /data-workbench-composer/, 'Session Composer 必须提供统一焦点目标')
assert.match(workbenchShellSource, /returnFocusRef=\{searchReturnFocusRef\}[\s\S]*returnFocusRef=\{settingsReturnFocusRef\}/, 'Search 与 Settings 必须记录并恢复各自触发焦点')
assert.match(searchSource, /searchInputIntent\(value\)[\s\S]*intent\.kind === 'session'[\s\S]*openSessionId/, '全局搜索必须识别完整 Session ID 并优先精确查询')
assert.match(searchSource, /api\(`\/api\/tasks\/\$\{encodeURIComponent\(sessionId\)\}`[\s\S]*resolvedSessionId\(sessionId, session\)[\s\S]*setSelectedFragment\(null\)[\s\S]*setErr\(/, 'Session ID 必须以后端查询结果为准，失败留在 overlay')
assert.match(searchSource, /results\.length === 0[\s\S]*onClick=\{\(\) => runSearch\(q\)\}[\s\S]*重新搜索/, '搜索空结果必须保留 query 并可原地重试')
assert.match(searchSource, /setRetryAction\(\{ kind: 'keyword'[\s\S]*retryLastAction[\s\S]*重试打开'[\s\S]*'重试搜索'/, '搜索 API 与 Session 查询失败必须保留对应的原地重试动作')
assert.match(searchSource, /if \(selectedFragment\) closeFragmentPreview\(\)[\s\S]*else onClose\(\)/, '搜索 Esc 必须先关闭最上层命中预览')
assert.match(settingsSource, /if \(modal\) return[\s\S]*event\.stopPropagation\(\)[\s\S]*onClose\(\)/, 'Settings Esc 必须只关闭最上层 overlay')
assert.match(settingsSource, /if \(navigationSucceededRef\.current\) return[\s\S]*navigationSucceededRef\.current = true/, 'Settings 成功跳转后不得把焦点恢复到已卸载 trigger')
assert.match(workPageSource, /readWorkbenchFocusTarget\(location\.state\) \|\| 'composer'[\s\S]*focusWorkbenchTarget\(requestedFocus\)/, 'Session 跳转成功后必须聚焦 Composer')
assert.match(userPageSource, /addEventListener\('mobius:new-conversation', prepareNewConversation\)/, '首页 Composer 必须接收 WorkPage 的统一新会话事件')

// 默认 Issue 只呈现会话轨、时间线或 Composer；统计卡和项目文件只允许留在 Legacy 区域。
assert.doesNotMatch(easyIssuePageSource, /SessionOverview|OverviewStatCard|ProjectFilesCard/, '简易 IssuePage 不得渲染统计卡或 ProjectFilesCard')
assert.match(easyIssuePageSource, /<ChatArea layout="easy" chrome="shell" toolOrigin="issue" \/>[\s\S]*<EmptyConversationComposer/, '简易 IssuePage 必须保持共享 Main slot 下的简化会话面并标记 Issue 来源')

// 固定账号不能重新进入桌面或 Welcome 的系统可视化入口。
for (const [label, source] of [
  ['desktop-page-actions.tsx', desktopActionsSource],
  ['window-controls.tsx', windowControlsSource],
  ['Welcome.tsx', welcomeSource],
]) {
  assert.doesNotMatch(source, /fuqingxu/, `${label} 不得指向固定用户`)
}
assert.match(desktopActionsSource, /visualization-path=\{visualizationPath\}/, '桌面 Web Component 必须接收动态系统可视化路径')
assert.match(windowControlsSource, /encodeURIComponent\(userId\)[\s\S]*visualizationPath=\{visualizationPath\}/, '桌面系统可视化入口必须使用当前用户')
assert.match(welcomeSource, /encodeURIComponent\(user\.id\)[\s\S]*mobius_overview_cluster/, 'Welcome 次级系统可视化入口必须使用当前用户')

console.log('workbench simplification contract test passed')
