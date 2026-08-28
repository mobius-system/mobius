import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
const viewSource = read('../src/components/easy-jsonl/EasyJsonlView.tsx')
const cssSource = read('../src/components/easy-jsonl/easy-jsonl.css')

assert.match(viewSource, /splitEasyUserPrompt/, 'EasyJsonlView 必须先拆出用户自己输入再渲染')
assert.match(viewSource, /<JsonlCompactMarkdown text=\{visible\} \/>/, '用户自己输入必须用 JsonlCompactMarkdown 渲染')
assert.match(viewSource, /<JsonlCompactMarkdown text="继续处理当前任务" \/>/, '空用户任务必须保留占位文案')
assert.match(viewSource, /contextOpen \? <JsonlCompactMarkdown text=\{hidden\}/, '系统注入内容必须折叠，展开后才渲染')
assert.doesNotMatch(viewSource, /showTitle && \(/, '工具标题必须始终保留，输出收进该行详情')
assert.match(viewSource, /const showOutput = !!activity\.outputTail && expanded/, '工具输出必须跟随该行展开状态')
assert.match(viewSource, /function EasyActivityItem[\s\S]*?useState\(false\)/, '单条工具调用必须默认折叠')
assert.match(viewSource, /function EasyBurstItem[\s\S]*?useState\(false\)/, '工具调用组必须默认折叠')
assert.doesNotMatch(viewSource, /planOutputSeenRef|activity\.defaultExpanded|burst\.defaultExpanded/, '工具结果到达后不得自行展开行或分组')
assert.match(viewSource, /const lockedOpen = forceExpanded/, '只有显式搜索定位可以锁定展开工具组')
assert.match(viewSource, /\|\| !!activity\.outputTail/, '只有输出的工具行也必须可以展开')
assert.match(viewSource, /aria-label="工具输出，可滚动查看"[\s\S]*tabIndex=\{0\}/, '工具输出区必须支持键盘聚焦和滚动')
assert.match(cssSource, /\.easy-jsonl-activity__output-tail\s*\{[^}]*max-height:\s*min\(320px,\s*42vh\)[^}]*overflow-y:\s*auto/, '长工具输出必须限高并在卡片内纵向滚动')
assert.match(cssSource, /\.easy-jsonl-activity__output-tail\s*\{[^}]*overscroll-behavior:\s*contain[^}]*-webkit-overflow-scrolling:\s*touch/, '工具输出滚动必须隔离外层并支持触控惯性')
assert.match(cssSource, /\.easy-jsonl-activity__output-tail\s*\{[^}]*font-size:\s*9px/, '命令输出必须用小字完整展示')
assert.match(cssSource, /\.easy-jsonl-activity__summary\s*\{[^}]*background:\s*transparent/, '工具标题行必须复刻 Codex 的无胶囊透明样式')
assert.match(cssSource, /\.easy-jsonl-burst__items\s*\{[^}]*padding:\s*3px 0 1px 24px/, '工具分组详情必须使用 Codex 式 24px 缩进')
assert.match(cssSource, /\.easy-jsonl-activity__chevron\s*\{[^}]*opacity:\s*0/, '桌面端展开箭头默认弱化隐藏')

const promptMarkdownRule = cssSource.match(/\.easy-jsonl-prompt \.jsonl-compact-md\s*\{([^}]*)\}/)?.[1] || ''
assert.match(promptMarkdownRule, /padding:\s*0/, '用户任务 Markdown 不得增加内层内边距')
assert.match(promptMarkdownRule, /background:\s*transparent/, '用户任务 Markdown 必须使用透明背景')
assert.match(promptMarkdownRule, /font-size:\s*14px/, '用户任务 Markdown 必须保持 14px 正文')
assert.match(promptMarkdownRule, /max-height:\s*440px[\s\S]*overflow-y:\s*auto/, '长用户任务必须保持卡片内滚动')

console.log('easy jsonl markdown contract tests passed')
