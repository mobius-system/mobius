import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
const viewSource = read('../src/components/easy-jsonl/EasyJsonlView.tsx')
const cssSource = read('../src/components/easy-jsonl/easy-jsonl.css')

assert.match(viewSource, /splitEasyUserPrompt/, 'EasyJsonlView 必须先拆出用户自己输入再渲染')
assert.match(viewSource, /<JsonlCompactMarkdown text=\{visible\} \/>/, '用户自己输入必须用 JsonlCompactMarkdown 渲染')
assert.match(viewSource, /<JsonlCompactMarkdown text="继续处理当前任务" \/>/, '空用户任务必须保留占位文案')
assert.match(viewSource, /contextOpen \? <JsonlCompactMarkdown text=\{hidden\}/, '系统注入内容必须折叠，展开后才渲染')
assert.match(viewSource, /showTitle && \(/, '有输出的命令/搜索不得再渲染放大标题')
assert.match(viewSource, /showOutput && \(/, '空信封不得占位，有输出时用小字展示')
assert.match(viewSource, /aria-label="工具输出，可滚动查看"[\s\S]*tabIndex=\{0\}/, '工具输出区必须支持键盘聚焦和滚动')
assert.match(cssSource, /\.easy-jsonl-activity__output-tail\s*\{[^}]*max-height:\s*min\(320px,\s*42vh\)[^}]*overflow-y:\s*auto/, '长工具输出必须限高并在卡片内纵向滚动')
assert.match(cssSource, /\.easy-jsonl-activity__output-tail\s*\{[^}]*overscroll-behavior:\s*contain[^}]*-webkit-overflow-scrolling:\s*touch/, '工具输出滚动必须隔离外层并支持触控惯性')
assert.match(cssSource, /\.easy-jsonl-activity__output-tail\s*\{[^}]*font-size:\s*9px/, '命令输出必须用小字完整展示')

const promptMarkdownRule = cssSource.match(/\.easy-jsonl-prompt \.jsonl-compact-md\s*\{([^}]*)\}/)?.[1] || ''
assert.match(promptMarkdownRule, /padding:\s*0/, '用户任务 Markdown 不得增加内层内边距')
assert.match(promptMarkdownRule, /background:\s*transparent/, '用户任务 Markdown 必须使用透明背景')
assert.match(promptMarkdownRule, /font-size:\s*14px/, '用户任务 Markdown 必须保持 14px 正文')
assert.match(promptMarkdownRule, /max-height:\s*440px[\s\S]*overflow-y:\s*auto/, '长用户任务必须保持卡片内滚动')

console.log('easy jsonl markdown contract tests passed')
