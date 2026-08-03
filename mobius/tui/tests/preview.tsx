/**
 * 一次性预览: 把典型 jsonl entry 喂进新的 mergeToolCalls → viewsForBlock,
 * 按 Chat.tsx 的 ViewLine 格式打印, 直观验证"对齐 web"后的渲染效果.
 *  跑: npx tsx tests/preview.tsx   (看完可删)
 */
import { mergeToolCalls, viewsForBlock, toolLabel } from '../src/lib/entry-view.js'

// ── 典型 entry 构造 (Claude SDK 形态) ──────────────────────────────────────
const entries: any[] = [
  // 1. 用户提问
  { type: 'user', uuid: 'u1', message: { content: '帮我把 getData 改成 async 实现' } },

  // 2. assistant 文本回复 (full 完整展示)
  { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: '好的，改成 async/await 实现。\n\n主要改动：\n1. 加 async 关键字\n2. await 替换 .then()\n3. try/catch 错误处理' }] } },

  // 3. Read 命令 + 结果 (compact, 合并成一块, ≤2 行)
  { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/src/foo.ts' } }] } },
  { type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export function getData() {\n  return fetch(url);\n}\n\n// ... 还有 200 行省略' }] } },

  // 4. Edit 代码修改 (full: old−/new+ 完整展示)
  { type: 'assistant', uuid: 'a3', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/src/foo.ts', old_string: 'export function getData() {\n  return fetch(url);\n}', new_string: 'export async function getData() {\n  const res = await fetch(url);\n  return res.json();\n}' } }] } },
  { type: 'user', uuid: 'u3', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'The file /src/foo.ts has been updated.' }] } },

  // 5. Bash 命令 + 长结果 (compact, 合并, ≤2 行)
  { type: 'assistant', uuid: 'a4', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm run typecheck' } }] } },
  { type: 'user', uuid: 'u4', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: '> @mobius-os/mobius typecheck\n> tsc --noEmit\n\nAll good. 还有非常多非常多的编译输出行全部应该被压成一行省略号...' }] } },

  // 6. reasoning 思考 (compact, ≤2 行)
  { type: 'assistant', uuid: 'a5', message: { content: [{ type: 'thinking', thinking: '用户要改异步实现，先读代码理解同步逻辑，再用 async/await 重写。要注意错误处理和返回值结构。这段思考过程非常非常长，必须被 clampLines 硬截断到最多两行，超出部分末尾加省略号。' }] } },

  // 7. 噪声 (应被隐藏, 不显示)
  { type: 'event_msg', uuid: 'n1', payload: { type: 'token_count', input_tokens: 1234, output_tokens: 567 } },
  { type: 'session_meta', uuid: 'n2', payload: { cwd: '/repo', model: 'gpt-5' } },
  { type: 'turn_context', uuid: 'n4', payload: { turn_id: 't0' } },

  // 8. context_compacted (对齐 web: 不再隐藏, 显示成 system 行)
  { type: 'event_msg', uuid: 'n3', payload: { type: 'context_compacted' } },

  // 9. error (full 完整展示)
  { type: 'event_msg', uuid: 'e1', payload: { type: 'error', message: '模型连接超时，请检查网络后重试' } },
]

// ── 模拟 Chat.tsx ViewLine 的格式 (带 ANSI 颜色) ─────────────────────────
const WIDTH = 76
const C = { red: '\x1b[31m', green: '\x1b[32m', cyan: '\x1b[36m', magenta: '\x1b[35m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }

function clamp(text: string, width: number, max: number): string[] {
  if (!text) return ['']
  const paras = text.replace(/\r\n/g, '\n').split('\n')
  const wrapped: string[] = []
  for (const p of paras) {
    if (p === '') { wrapped.push(''); continue }
    for (let i = 0; i < p.length; i += width) wrapped.push(p.slice(i, i + width))
  }
  if (wrapped.length <= max) return wrapped
  const t = wrapped.slice(0, max)
  const last = t[max - 1]
  t[max - 1] = last.length >= width ? last.slice(0, width - 1) + '…' : last + '…'
  return t
}

console.log(`${C.dim}═══ 合并后渲染预览 (width=76, 对齐 web 过滤) ═══${C.reset}\n`)
const blocks = mergeToolCalls(entries)
console.log(`${C.dim}[原始 ${entries.length} 条 entry → 合并后 ${blocks.length} 个 block]${C.reset}\n`)

for (const block of blocks) {
  for (const view of viewsForBlock(block)) {
    switch (view.kind) {
      case 'skip':
        break
      case 'user':
        console.log(`\n${C.bold}› ${view.text}${C.reset}`)
        break
      case 'assistant':
        console.log(`${C.bold}•${C.reset} ${view.text}`)
        break
      case 'tool_call': {
        const head = clamp(`${toolLabel(view.toolName)} ${view.summary}`.trim(), WIDTH - 2, 1)[0]
        console.log(`${C.cyan}• ${head}${C.reset}`)
        if (view.result) console.log(`${C.dim}  └ ${clamp(view.result.text, WIDTH - 4, 1)[0] || '(无输出)'}${C.reset}`)
        break
      }
      case 'code_edit':
        console.log(`${C.magenta}✎ 编辑 ${view.filePath || '(未指定文件)'}${C.reset}`)
        for (const l of view.oldString.split('\n')) console.log(`  ${C.red}−${C.reset} ${l}`)
        for (const l of view.newString.split('\n')) console.log(`  ${C.green}+${C.reset} ${l}`)
        break
      case 'write_file':
        console.log(`${C.magenta}✎ 写入 ${view.filePath || '(未指定文件)'}${C.reset}`)
        for (const l of view.content.split('\n')) console.log(`  ${C.green}+${C.reset} ${l}`)
        break
      case 'reasoning':
        clamp(view.text, WIDTH - 4, 2).forEach((l, i) => console.log(`${C.dim}${C.magenta}  ◇ ${l}${C.reset}`))
        break
      case 'system':
        console.log(`${C.dim}${C.yellow}  ${clamp(view.text, WIDTH - 2, 2)[0]}${C.reset}`)
        break
      case 'error':
        console.log(`${C.red}⚠ ${view.text}${C.reset}`)
        break
    }
  }
}
console.log(`\n${C.dim}═══ 预览结束 ═══${C.reset}`)
