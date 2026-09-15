/**
 * JSONL response_item Markdown summary regression tests.
 *
 * `headerSummary.full` is the exact source passed to JsonlCompactMarkdown.
 * Keep protocol metadata out of that source so line-sensitive Markdown (most
 * importantly a table in the first line) remains parseable.
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(__dirname, '../src/components/viewer')

const result = await build({
  entryPoints: [path.join(sourceRoot, 'header-summary.ts')],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
const { buildHeaderSummary } = await import(dataUrl)

function responseItem(role, text) {
  return {
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: 'output_text', text }],
    },
  }
}

const table = '| 问题 | 修复方法 |\n|---|---|\n| 表格首行 | 必须保持行首 |'

// A response that starts with a table must remain a table after the exact
// production summary → ReactMarkdown path.
{
  const entry = responseItem('assistant', table)
  const summary = buildHeaderSummary(entry)
  assert.equal(summary.full, table)
  assert.equal(summary.full.startsWith('assistant · '), false)
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, summary.full))
  assert.match(html, /^<table>/)
  assert.match(html, /<th>问题<\/th>/)
  assert.match(html, /<td>表格首行<\/td>/)
}

// Ordinary assistant text keeps its content and no longer carries synthetic
// protocol metadata in either `full` or the one-line `short` preview.
{
  const text = '研究结论：CLI 是两个 Bash 命令。\n\n- 安装器只负责复制文件。'
  const summary = buildHeaderSummary(responseItem('assistant', text))
  assert.equal(summary.full, text)
  assert.equal(summary.short.startsWith('assistant · '), false)
  assert.match(summary.short, /^研究结论：CLI 是两个 Bash 命令。/)
}

// The same invariant applies to response_item user messages; role metadata is
// not part of the Markdown body for any message role.
{
  const text = '用户正文从这里开始。'
  const summary = buildHeaderSummary(responseItem('user', text))
  assert.equal(summary.full, text)
  assert.equal(summary.short, text)
  assert.equal(summary.short.startsWith('user · '), false)
}

console.log('jsonl-markdown-summary: 3 tests passed')
