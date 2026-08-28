import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
const viewSource = read('../src/components/easy-jsonl/EasyJsonlView.tsx')
const cssSource = read('../src/components/easy-jsonl/easy-jsonl.css')

assert.match(viewSource, /splitEasyUserPrompt/, 'EasyJsonlView 必须先拆出用户自己输入再渲染')
assert.match(viewSource, /<JsonlCompactMarkdown text=\{visible\} \/>/, '用户自己输入必须用 JsonlCompactMarkdown 渲染')
assert.match(viewSource, /<JsonlCompactMarkdown text="继续处理当前任务" \/>/, '空用户任务必须保留占位文案')
assert.match(viewSource, /contextOpen \? <JsonlCompactMarkdown text=\{hidden\}/, '系统注入内容必须折叠，展开后才渲染')
assert.match(viewSource, /easy-jsonl-activity__command-text/, '命令行必须复用 CodexMonitor 的 fade/全文切换，而不是硬截断标题')
assert.match(viewSource, /showOutput && \(/, '命令输出必须在展开或失败后才渲染，空信封不得占位')

const promptMarkdownRule = cssSource.match(/\.easy-jsonl-prompt \.jsonl-compact-md\s*\{([^}]*)\}/)?.[1] || ''
assert.match(promptMarkdownRule, /padding:\s*0/, '用户任务 Markdown 不得增加内层内边距')
assert.match(promptMarkdownRule, /background:\s*transparent/, '用户任务 Markdown 必须使用透明背景')
assert.match(promptMarkdownRule, /font-size:\s*14px/, '用户任务 Markdown 必须保持 14px 正文')
assert.match(promptMarkdownRule, /max-height:\s*440px[\s\S]*overflow-y:\s*auto/, '长用户任务必须保持卡片内滚动')

console.log('easy jsonl markdown contract tests passed')
