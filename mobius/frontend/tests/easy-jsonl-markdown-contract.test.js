import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
const viewSource = read('../src/components/easy-jsonl/EasyJsonlView.tsx')
const cssSource = read('../src/components/easy-jsonl/easy-jsonl.css')

assert.match(
  viewSource,
  /<JsonlCompactMarkdown text=\{round\.userPrompt \|\| '继续处理当前任务'\} \/>/,
  'EasyJsonlView 必须用 JsonlCompactMarkdown 渲染 userPrompt',
)

const promptMarkdownRule = cssSource.match(/\.easy-jsonl-prompt \.jsonl-compact-md\s*\{([^}]*)\}/)?.[1] || ''
assert.match(promptMarkdownRule, /padding:\s*0/, '用户任务 Markdown 不得增加内层内边距')
assert.match(promptMarkdownRule, /background:\s*transparent/, '用户任务 Markdown 必须使用透明背景')
assert.match(promptMarkdownRule, /font-size:\s*14px/, '用户任务 Markdown 必须保持 14px 正文')
assert.match(promptMarkdownRule, /max-height:\s*440px[\s\S]*overflow-y:\s*auto/, '长用户任务必须保持卡片内滚动')

console.log('easy jsonl markdown contract tests passed')
