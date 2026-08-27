import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSource = relativePath => fs.readFileSync(path.join(here, '..', relativePath), 'utf8')

const appSource = readSource('src/App.tsx')
const shellSource = readSource('src/components/shell.tsx')
const railSource = readSource('src/components/conversation-rail.tsx')
const settingsSource = readSource('src/components/settings-panel.tsx')
const chatSource = readSource('src/components/chat.tsx')
const desktopActionsSource = readSource('src/components/desktop-page-actions.tsx')
const windowControlsSource = readSource('src/components/window-controls.tsx')
const welcomeSource = readSource('src/pages/Welcome.tsx')
const userPageSource = readSource('src/pages/UserPage.tsx')
const workPageSource = readSource('src/pages/WorkPage.tsx')
const issuePageSource = readSource('src/pages/IssuePage.tsx')
const cssSource = readSource('src/index.css')

function sourceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert(start >= 0 && end > start, `${label} 源码边界必须存在`)
  return source.slice(start, end)
}

const defaultTopNavSource = sourceBetween(
  shellSource,
  'export function TopNav',
  'function LegacyTopNav',
  '默认 TopNav',
)
const defaultIssuePageSource = sourceBetween(
  issuePageSource,
  'export default function IssuePage',
  'function LegacyIssuePage',
  '默认 IssuePage',
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
const issueCompatibilitySource = sourceBetween(
  appSource,
  'function IssueRouteCompatibility',
  'function AuthenticatedApp',
  'Issue 兼容路由',
)

// P0/P1：默认入口与短路由，不再要求用户选择布局模式。
assert.doesNotMatch(appSource, /LayoutModeChoiceModal/, 'App.tsx 不得再调用或挂载布局模式选择弹窗')
assert.match(appSource, /<Route path="\/u\/:user\/s\/:session" element=\{<WorkPage \/>\} \/>/, 'App.tsx 必须挂载统一会话短路由')
assert.match(appSource, /<Route path="\/easy_mode" element=\{<EasyModeCompatibility \/>\} \/>/, 'App.tsx 必须保留根 easy_mode 兼容入口')
assert.match(appSource, /<Route path="\/u\/:user\/easy_mode" element=\{<EasyModeCompatibility \/>\} \/>/, 'App.tsx 必须保留用户 easy_mode 兼容入口')
assert.match(easyCompatibilitySource, /sessionId[\s\S]*<Navigate to=\{`\/u\/\$\{userId\}\/s\/\$\{encodeURIComponent\(sessionId\)\}/, 'easy_mode 的 session 参数必须跳转到统一短路由')
assert.match(issueCompatibilitySource, /if \(!sessionId\) return <IssuePage \/>/, '没有 session 的旧 Issue 路由必须继续渲染默认 IssuePage')
assert.match(issueCompatibilitySource, /<Navigate to=\{`\/u\/\$\{params\.user \|\| ''\}\/s\/\$\{encodeURIComponent\(sessionId\)\}/, '带 session 的旧 Issue 路由必须跳转到统一短路由')
assert.doesNotMatch(appSource, /EasyModePage/, 'App.tsx 不得重新引用 EasyModePage')
assert.doesNotMatch(appSource, /LegacyIssuePage/, 'App.tsx 不得把 LegacyIssuePage 挂回默认路由')

// Web 默认首页是当前用户主页；Welcome 只保留显式路由和设置中的连接/导入入口。
assert.match(appSource, /return <Navigate to=\{`\/u\/\$\{user\.id\}`\} replace \/>/, '根路径必须跳转到当前用户主页')
assert.match(appSource, /<Route path="\/welcome"/, 'Welcome 兼容路由必须继续保留')
assert.doesNotMatch(appSource, /<Navigate to=[^>]*\/welcome/, '默认 Web 导航不得自动跳转到 Welcome')
assert.match(settingsSource, /label="连接 \/ 导入向导"[\s\S]*go\('\/welcome', true\)/, 'Welcome 必须从设置高级区作为连接/导入次级入口可达')

// 默认 TopNav：锁定四个基本动作，并隔离 LegacyTopNav 的高级入口。
for (const label of ['历史', '搜索', '新会话', '设置/更多']) {
  assert.match(defaultTopNavSource, new RegExp(`aria-label="${label.replace('/', '\\/')}"`), `默认 TopNav 必须提供「${label}」按钮`)
}
assert.match(defaultTopNavSource, /h-\[52px\]/, '默认 Header 高度必须保持 52px')
assert.doesNotMatch(defaultTopNavSource, /系统可视化|GlobalCreateMenu|WorkspaceLayoutToggle/, '默认 TopNav 不得出现系统可视化、工作区模式切换或四类创建菜单')
assert.equal((shellSource.match(/<LegacyTopNav\b/g) || []).length, 0, 'LegacyTopNav 可以保留定义，但不得被任何默认表面挂载')

// P2：三组统一快捷键必须由默认 TopNav 提供，且基础任务也有可见按钮。
assert.match(defaultTopNavSource, /event\.metaKey \|\| event\.ctrlKey/, '快捷键必须同时支持 Cmd 和 Ctrl')
assert.match(defaultTopNavSource, /event\.key\.toLowerCase\(\) === 'k'[\s\S]*setShowSearch\(true\)/, 'Cmd/Ctrl+K 必须打开搜索')
assert.match(defaultTopNavSource, /event\.key\.toLowerCase\(\) === 'n'[\s\S]*startNewConversation\(\)/, 'Cmd/Ctrl+N 必须开始新会话')
assert.match(defaultTopNavSource, /event\.key === ',' \|\| event\.code === 'Comma'/, 'Cmd/Ctrl+, 必须打开设置')

// 响应式静态布局回归（无需登录态或浏览器）。
assert.match(railSource, /window\.matchMedia\('\(min-width: 1280px\)'\)/, 'ConversationRail 必须以 1280px 作为常驻断点')
assert.match(railSource, /className="hidden h-full xl:block"/, '1280px 及以上必须直接显示历史轨')
assert.match(railSource, /top-\[52px\][^"`]*xl:hidden/, '窄屏历史抽屉必须位于 52px Header 下并在 xl 隐藏')
assert.match(defaultTopNavSource, /aria-label="历史"[\s\S]*xl:hidden/, '窄屏必须从顶部「历史」按钮一次打开抽屉')
assert.match(userPageSource, /max-w-\[880px\]/, '首页 Composer 上限必须是 880px')
assert.match(emptyIssueComposerSource, /max-w-\[880px\]/, 'Issue 空态 Composer 上限必须是 880px')
assert.match(cssSource, /\.mobius-chat-body\.mobius-chat-body--easy \.mobius-chat-input \{[\s\S]*?width: min\(880px, calc\(100% - 40px\)\) !important;/, '会话 Composer 上限必须是 880px')
assert.match(cssSource, /\.mobius-chat-input\.mobius-chat-input--with-actions \{[\s\S]*?width: min\(880px, calc\(100% - 32px\)\) !important;/, '带工具的会话 Composer 也不得超过 880px')

// 历史和复制链接统一生成 /u/:user/s/:session。
assert.match(railSource, /return `\/u\/\$\{userId\}\/s\/\$\{encodeURIComponent\(item\.session_id\)\}`/, 'ConversationRail 必须生成会话短路由')
assert.match(chatSource, /const path = `\/u\/\$\{encodeURIComponent\(user\.id\)\}\/s\/\$\{encodeURIComponent\(activeSessionId\)\}`/, '复制会话链接必须生成当前用户的会话短路由')

// 三个默认页面的新会话空态最终都汇入 create-conversation orchestration。
assert.match(userPageSource, /from '\.\.\/services\/create-conversation'/, 'UserPage 必须使用统一 create-conversation 服务')
assert.match(userPageSource, /createDefaultConversation\(\{[\s\S]{0,320}projectId: selectedProjectId,[\s\S]{0,320}prompt,[\s\S]{0,320}checkpoint/, '首页发送必须调用统一 create-conversation 服务')
assert.match(emptyIssueComposerSource, /createDefaultConversation\(\{ projectId, prompt, checkpoint: initialCheckpoint \}\)/, 'Issue 空态发送必须调用统一 create-conversation 服务')
assert.match(workPageSource, /navigate\(`\/u\/\$\{userId\}\$\{projectQuery\}`\)[\s\S]*mobius:new-conversation/, 'WorkPage 新会话必须带项目上下文回到统一首页 Composer')
assert.match(userPageSource, /addEventListener\('mobius:new-conversation', prepareNewConversation\)/, '首页 Composer 必须接收 WorkPage 的统一新会话事件')

// 默认 Issue 只呈现会话轨、时间线或 Composer；统计卡和项目文件只允许留在 Legacy 区域。
assert.doesNotMatch(defaultIssuePageSource, /SessionOverview|OverviewStatCard|ProjectFilesCard/, '默认 IssuePage 不得渲染统计卡或 ProjectFilesCard')
assert.match(defaultIssuePageSource, /<ConversationRail[\s\S]*<ChatArea layout="easy" \/>[\s\S]*<EmptyConversationComposer/, '默认 IssuePage 必须保持简化会话面')

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
