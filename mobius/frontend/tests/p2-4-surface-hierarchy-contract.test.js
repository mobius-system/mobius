import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = relative => fs.readFileSync(path.resolve(here, '..', relative), 'utf8')

const app = read('src/App.tsx')
const navigation = read('src/services/workbench-navigation.ts')
const settings = read('src/components/settings-panel.tsx')
const research = read('src/pages/ResearchPage.tsx')
const overview = read('src/pages/MobiusOverviewPage.tsx')
const cluster = read('src/pages/MobiusOverviewClusterPage.tsx')
const assistant = read('src/components/assistant-chat.tsx')
const css = read('src/index.css')

assert.match(app, /path="\/u\/:user\/mobius_overview"[\s\S]*path="\/u\/:user\/mobius_overview_cluster"/, '两种系统图必须保留独立全页路由')
assert.doesNotMatch(app.match(/<Route path="\/u\/:user" element=\{<WorkbenchRouteLayout \/>\}>[\s\S]*?<\/Route>/)?.[0] || '', /mobius_overview/, '默认 Home / Session 路由不得挂载系统图')

assert.match(navigation, /systemVisualizationPath[\s\S]*returnTo: safeWorkbenchReturnTo/, '系统图 URL 必须携带已校验来源')
assert.match(settings, /systemVisualizationNavigation\(userId, 'cluster', \{ returnTo: currentReturnTo \}\)/, 'Settings 系统图入口必须记录当前来源')
assert.match(settings, /systemVisualizationNavigation\(userId, 'overview', \{ returnTo: currentReturnTo \}\)/, 'Settings 旧总览入口必须记录当前来源')

assert.match(research, /<AdvancedPageChrome[\s\S]*高级研究工作台[\s\S]*<ResearchGraph/, 'Research 必须保留完整高级页、团队和图谱能力')
for (const [label, source] of [['系统总览', overview], ['会话地图', cluster]]) {
  assert.match(source, /data-system-visualization="fullscreen"/, `${label} 必须声明按需全屏表面`)
  assert.match(source, /readWorkbenchReturnTo[\s\S]*<AdvancedPageChrome[\s\S]*returnTo=\{returnTo\}/, `${label} 必须使用显式来源返回`)
}
assert.doesNotMatch(cluster, /navigate\(-1\)|history\.back\(/, '会话地图返回不得依赖不稳定的浏览器 history')

assert.match(assistant, /data-assistant-role="cross-page-prompt"/, '助手气泡必须声明跨页提示角色')
assert.match(assistant, /ASSISTANT_PROTECTED_ACTION_SELECTOR = '[^']*workbench-composer[^']*session-stop-button[^']*workbench-status-danger'/, '助手气泡必须避让 Composer、Stop 和错误动作')
assert.match(assistant, /setAssistantBubbleEnabled\(false\)[\s\S]*关闭并隐藏快捷助手/, '移动宽度必须可隐藏快捷助手入口')
assert.match(assistant, /assistant-fab workbench-layer-popover[\s\S]*assistant-panel workbench-layer-popover/, '助手气泡和面板必须消费 popover layer token')
assert.doesNotMatch(assistant, /z-\[(?:60|70|80|90)\]/, '助手表面不得继续使用硬编码全局 z-index')
assert.match(css, /\.assistant-image-preview-modal \{[\s\S]{0,120}z-index: var\(--layer-modal\)/, '助手图片预览必须消费 modal layer token')
assert.match(css, /@media \(max-width: 720px\) \{[\s\S]{0,120}\.assistant-mobile-dismiss \{ display: inline-flex; \}/, '移动宽度必须显示隐藏入口动作')

console.log('P2-4 surface hierarchy contract test passed')
