import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSource = relativePath => fs.readFileSync(path.join(here, '..', relativePath), 'utf8')

const cssSource = readSource('src/index.css')
const themeSource = readSource('src/theme.ts')
const settingsSource = readSource('src/components/settings-panel.tsx')
const paletteSource = readSource('src/components/custom-theme-palette.tsx')
const modalSource = readSource('src/components/modals.tsx')
const attachmentsSource = readSource('src/components/attachments.tsx')
const researchTeamSource = readSource('src/components/research-agent-team-modal.tsx')
const globalCreateSource = readSource('src/components/global-create.tsx')
const homeSource = readSource('src/pages/UserPage.tsx')
const welcomeSource = readSource('src/pages/Welcome.tsx')
const issueSource = readSource('src/pages/IssuePage.tsx')
const researchSource = readSource('src/pages/ResearchPage.tsx')
const projectSource = readSource('src/pages/ProjectPage.tsx')
const adminSource = readSource('src/components/panels.tsx')
const advancedChromeSource = readSource('src/components/advanced-page-chrome.tsx')

const retainedThemes = ['dark', 'light', 'purple', 'ocean', 'forest', 'sunset', 'mono', 'autumn']
const surfaceTokens = [
  'surface-base',
  'surface-raised',
  'surface-content',
  'surface-overlay',
  'surface-control',
  'surface-control-hover',
  'surface-active',
  'surface-code',
  'surface-scrim',
]
const textTokens = ['text-primary', 'text-secondary', 'text-muted', 'text-dimmed', 'text-on-accent']
const statusTokens = ['status-running', 'status-waiting', 'status-danger', 'status-success']

function blocksFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matcher = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, 'g')
  return Array.from(cssSource.matchAll(matcher), match => match[1]).join('\n')
}

function declaration(source, token) {
  return source.match(new RegExp(`--${token}:\\s*([^;]+);`))?.[1].trim() || ''
}

// 主题选项必须原样保留；本任务不增加或删除品牌皮肤。
for (const theme of retainedThemes) {
  assert.match(themeSource, new RegExp(`name:\\s*'${theme}'`), `必须保留 ${theme} 主题选项`)
}
assert.equal((themeSource.match(/\bname:\s*'/g) || []).length, retainedThemes.length, 'P2-6 不得新增主题皮肤')
assert.match(settingsSource, /THEME_OPTIONS\.map\(option =>/, 'Settings 必须继续暴露全部既有主题选择')

const rootBlock = blocksFor(':root')
for (const theme of retainedThemes) {
  const themeBlock = theme === 'dark' ? `${rootBlock}\n${blocksFor('.dark')}` : blocksFor(`.${theme}`)
  for (const token of [...surfaceTokens, ...textTokens, ...statusTokens]) {
    assert.ok(declaration(themeBlock, token), `${theme} 必须显式提供 --${token}`)
  }
  const statusValues = statusTokens.map(token => declaration(themeBlock, token))
  assert.equal(new Set(statusValues).size, statusValues.length, `${theme} 的运行/等待/危险/成功颜色必须互不相同`)

  for (const token of surfaceTokens.filter(token => token !== 'surface-scrim')) {
    const value = declaration(themeBlock, token)
    assert.match(value, /var\(--[^,]+,\s*[^)]+\)/, `${theme} 的 --${token} 必须包含显式 fallback`)
  }
}

const sharedThemeContract = blocksFor(':where(.dark, .light, .purple, .ocean, .forest, .sunset, .mono, .autumn)')
for (const layer of ['layer-popover', 'layer-drawer', 'layer-modal', 'layer-toast']) {
  assert.ok(declaration(sharedThemeContract, layer), `所有主题必须共享 --${layer}`)
}

// JSONL 与高级页不得重新绕过语义色。index.css 不做全文件扫描：其中包含 token 本身、
// diff/syntax 阅读语义及本轮范围外的既有皮肤；下方只锁定本轮明确要求的 selector。
const semanticColorFiles = [
  'src/components/session-jsonl-panel.tsx',
  'src/components/viewer/themes.ts',
  'src/components/viewer/EntryCard.tsx',
  'src/components/viewer/tool-status.ts',
  'src/components/viewer/round-header-palette.ts',
  'src/components/viewer/LiveTailCard.tsx',
  'src/components/viewer/ReadCards.tsx',
  'src/components/viewer/BashCards.tsx',
  'src/components/viewer/RoundGroups.tsx',
  'src/components/viewer/PlanCard.tsx',
  'src/components/easy-jsonl/easy-jsonl.css',
  'src/pages/IssuePage.tsx',
  'src/pages/ProjectPage.tsx',
  'src/pages/FileManager.tsx',
  'src/pages/ContextPanel.tsx',
  'src/pages/MobiusOverviewPage.tsx',
  'src/pages/MobiusOverviewClusterPage.tsx',
  'src/pages/EasyModePage.tsx',
  'src/pages/UserPage.tsx',
  'src/components/project-page/IssueCard.tsx',
  'src/components/project-page/ProjectSidebar.tsx',
  'src/components/project-page/ProjectItemsPanel.tsx',
  'src/components/project-page/ProjectSettingsPanel.tsx',
  'src/components/project-page/ProjectArchitecturePanel.tsx',
  'src/components/project-page/ProjectTeamPanel.tsx',
  'src/components/project-page/ResearchCard.tsx',
  'src/components/project-page/ProjectTabs.tsx',
  'src/components/project-page/ProjectOverflowTabs.tsx',
  'src/components/project-page/ProjectTodosPanel.tsx',
  'src/components/project-page/ProjectPackagePanel.tsx',
  'src/components/project-page/ProjectAssistantPresetPanel.tsx',
  'src/components/expandable-textarea.tsx',
  'src/components/context-whitelist.tsx',
  'src/components/project-files.tsx',
  'src/components/skills.tsx',
  'src/components/memories.tsx',
  'src/components/context-access.tsx',
  'src/components/user-picker.tsx',
  'src/components/search-modal.tsx',
  'src/components/chat.tsx',
]
const forbiddenSemanticColor = /#f87171|#ef4444|text-red-400|bg-red-500|#60a5fa|text-blue-400|bg-blue-500\/15/
for (const file of semanticColorFiles) {
  assert.doesNotMatch(readSource(file), forbiddenSemanticColor, `${file} 不得保留硬编码状态红或强调蓝`)
}

const jsonlThemeSource = readSource('src/components/viewer/themes.ts')
const jsonlErrorTheme = jsonlThemeSource.match(/\berror:\s*\{[^}]+\}/)?.[0] || ''
assert.match(jsonlErrorTheme, /status-danger/, 'JSONL error theme 必须引用 --status-danger')
for (const kind of ['assistant', 'response_item']) {
  const entry = jsonlThemeSource.match(new RegExp(`\\b${kind}:\\s*\\{[^}]+\\}`))?.[0] || ''
  assert.match(entry, /accent-primary/, `JSONL ${kind} theme 必须引用 --accent-primary`)
}
assert.match(blocksFor('.prose-chat a'), /var\(--accent-primary\)/, '聊天正文链接必须使用 --accent-primary')
assert.match(blocksFor('.jsonl-compact-md a'), /var\(--accent-primary\)/, 'JSONL compact markdown 链接必须使用 --accent-primary')
const easyJsonlSource = readSource('src/components/easy-jsonl/easy-jsonl.css')
assert.match(easyJsonlSource, /easy-jsonl-activity--error[\s\S]*var\(--status-danger\)/, 'Easy JSONL error 必须使用 danger token')

// 高级页和 Settings overlay 不能再用 light/dark 二分硬编码反色。
const settingsModalSource = modalSource.slice(
  modalSource.indexOf('function DesktopDownloadRowItem'),
  modalSource.indexOf('export function SinkAsMemoryModal'),
)
const researchModalSource = modalSource.slice(
  modalSource.indexOf('export function NewResearchLeaderModal'),
  modalSource.indexOf('function SessionSkillPreviewDialog'),
)
const sessionOverlaySource = modalSource.slice(
  modalSource.indexOf('function SessionSkillPreviewDialog'),
  modalSource.indexOf('// 重命名 Session'),
)
for (const [label, source] of [
  ['Settings', settingsSource],
  ['主题工坊', paletteSource],
  ['Settings 子弹层', settingsModalSource],
  ['Research', researchSource],
  ['Research 共用弹层', researchModalSource],
  ['Research 团队弹层', researchTeamSource],
  ['Session overlay', sessionOverlaySource],
  ['Session 附件层', attachmentsSource],
  ['Home', homeSource],
  ['Issue', issueSource],
  ['Admin', adminSource],
  ['高级页 chrome', advancedChromeSource],
]) {
  assert.doesNotMatch(source, /theme\s*!==\s*['"]light|theme\s*===\s*['"]light|isDark\s*\?\s*['"]#/, `${label} 不得保留硬编码反色分支`)
}
for (const [label, source] of [
  ['Research 共用弹层', researchModalSource],
  ['Research 团队弹层', researchTeamSource],
  ['Session overlay', sessionOverlaySource],
  ['Session 附件层', attachmentsSource],
  ['全局创建 overlay', globalCreateSource],
  ['Home', homeSource],
  ['Welcome', welcomeSource],
  ['Issue', issueSource],
  ['Admin', adminSource],
]) {
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}|rgba\(|bg-black\/|var\(--modal-bg\)/, `${label} 的 surface/text/status 必须经语义 token`)
}
assert.match(settingsSource, /theme-overlay__scrim[\s\S]*theme-overlay__panel/, 'Settings 必须使用语义 scrim 与 overlay surface')
assert.match(paletteSource, /theme-overlay__scrim[\s\S]*theme-overlay__panel/, '主题工坊必须使用语义 scrim 与 overlay surface')
assert.match(researchSource, /advanced-page-surface[\s\S]*theme-overlay__scrim[\s\S]*theme-overlay__panel/, 'Research 高级页与弹层必须共享语义层级')
assert.match(researchTeamSource, /theme-overlay__scrim[\s\S]*theme-overlay__panel/, 'Research 团队弹层必须使用语义 scrim 与 overlay surface')
assert.match(sessionOverlaySource, /theme-overlay__scrim[\s\S]*theme-overlay__panel/, 'Session 弹层必须使用语义 scrim 与 overlay surface')
assert.match(projectSource, /advanced-page-surface/, 'Project 必须加入共享高级页语义表面')
assert.match(adminSource, /admin-panel advanced-page-surface/, 'Admin 必须加入共享高级页语义表面')

// 紧凑密度允许视觉收缩，但交互目标必须保持在约 32–40px。
const controlSizes = ['control-height-sm', 'control-height-md', 'control-height-lg'].map(token => Number.parseInt(declaration(rootBlock, token), 10))
assert.deepEqual(controlSizes, [32, 36, 40], '共享控件高度必须保持 32/36/40px 节奏')
assert.match(cssSource, /:where\(\.advanced-page-surface, \.admin-panel, \.theme-overlay\)[\s\S]*min-height:\s*var\(--control-height-sm, 32px\)/, '高级页与 overlay 必须保留 32px 点击下限')
assert.match(settingsSource, /settings-panel__target/, 'Settings 行级目标必须使用约 40px 点击高度')

console.log('P2-6 theme and density contract passed')
