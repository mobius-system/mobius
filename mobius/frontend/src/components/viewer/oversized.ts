/**
 * viewer/oversized.ts — 超大卡片渲染保护 (纯函数, 无 React 依赖).
 *
 * 从 jsonl-view.tsx 拆出. 单张 jsonl 卡片渲染时的字符预算: 超过阈值的 entry / 工具结果
 * 内容会被截断后再交给卡片渲染, 避免 DOM 节点爆炸导致前端卡顿崩溃
 * (用户反馈: 某条 jsonl 卡片字符数过大时页面卡死).
 */
import type { BashToolResult } from './types'

// 单个字符串字段的上限: 防止"一行超长"(未换行的巨型 stdout / base64 / 压缩 JSON)绕过按行截断.
// 小于卡片总预算 (MAX_CARD_RENDER_CHARS, 定义在 EntryCard), 保证一张卡片里至少能完整显示几个正常大字段.
const MAX_FIELD_RENDER_CHARS = 30_000

// 估算把一个值铺到 DOM 上 roughly 要多少字符. 优先 JSON.stringify (V8 优化好),
// 失败 (循环引用 / BigInt / Symbol) 退回递归累加. 仅用于判断是否超预算, 不要求精确.
export function estimateRenderChars(node: any): number {
  try {
    const s = JSON.stringify(node)
    return s ? s.length : 0
  } catch {
    return estimateRenderCharsSlow(node, new WeakSet())
  }
}
function estimateRenderCharsSlow(node: any, seen: WeakSet<object>): number {
  if (node === null || node === undefined) return 4
  if (typeof node === 'string') return node.length
  if (typeof node === 'number' || typeof node === 'boolean') return String(node).length
  if (typeof node === 'object') {
    if (seen.has(node)) return 0
    seen.add(node)
    if (Array.isArray(node)) return node.reduce((s: number, x: any) => s + estimateRenderCharsSlow(x, seen), 4)
    return Object.keys(node).reduce((s: number, k: string) => s + k.length + estimateRenderCharsSlow((node as any)[k], seen), 4)
  }
  return 0
}

// 工具结果 (Bash/Read) 里文本字段的字符量, 直接用 .length (O(1), 比 stringify 快且准).
export function estimateToolResultsChars(results: BashToolResult[]): number {
  let s = 0
  for (const r of results) {
    s += (r.stdout?.length || 0) + (r.stderr?.length || 0) + (r.content?.length || 0) + (r.readFile?.content?.length || 0)
  }
  return s
}

// 占位文案: 预算耗尽后, 剩余节点用它替换 (不再渲染真实内容).
function placeholderForNode(node: any): string {
  if (Array.isArray(node)) return `… [数组已省略, 共 ${node.length} 项]`
  if (node && typeof node === 'object') return `… [对象已省略, 共 ${Object.keys(node).length} 字段]`
  return '… [已省略]'
}

// 流式预算截断: 深拷贝 node, 每个字符串字段最多消耗 min(remaining, MAX_FIELD_RENDER_CHARS) 字符;
// 总预算耗尽后剩余节点用占位替换. 保证渲染总量 <= MAX_CARD_RENDER_CHARS, 且单字段 <= MAX_FIELD_RENDER_CHARS.
// 未触达上限的字符串保持原引用 (浅路径不复制), 只有真正超限的分支才产生新对象.
export function clampNodeForRender(node: any, budget: { remaining: number }): any {
  if (budget.remaining <= 0) return placeholderForNode(node)
  if (typeof node === 'string') {
    if (node.length <= MAX_FIELD_RENDER_CHARS && node.length <= budget.remaining) {
      budget.remaining -= node.length
      return node
    }
    const keep = Math.min(MAX_FIELD_RENDER_CHARS, budget.remaining)
    budget.remaining = 0
    return node.slice(0, keep) + `\n… [内容过大, 已截断显示, 原始共 ${node.length} 字符]`
  }
  if (Array.isArray(node)) {
    const out: any[] = []
    for (const item of node) {
      if (budget.remaining <= 0) { out.push(placeholderForNode(item)); continue }
      out.push(clampNodeForRender(item, budget))
    }
    return out
  }
  if (node && typeof node === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(node)) {
      if (budget.remaining <= 0) { out[k] = placeholderForNode(v); continue }
      out[k] = clampNodeForRender(v, budget)
    }
    return out
  }
  // number / boolean / null / undefined / bigint 等: 体量小, 不计入预算
  return node
}

// 截断单个字符串字段 (用于工具结果里独立的 stdout/stderr/content).
// 始终返回 string (空输入 → ''), 与 BashToolResult 里这些字段的非空类型对齐.
export function clampStringForRender(s: string | undefined | null, budget: { remaining: number }): string {
  if (!s) return ''
  const text = typeof s === 'string' ? s : String(s)
  if (text.length <= MAX_FIELD_RENDER_CHARS && text.length <= budget.remaining) {
    budget.remaining -= text.length
    return text
  }
  const keep = Math.min(MAX_FIELD_RENDER_CHARS, budget.remaining)
  budget.remaining = 0
  return text.slice(0, keep) + `\n… [内容过大, 已截断显示, 原始共 ${text.length} 字符]`
}

// 截断 Bash/Read 工具结果里的文本字段. 这些字段由 mergeBashToolResultItems 注入,
// 独立于 entry, 是单卡片卡顿的另一大来源 (如巨型 stdout / 大文件 Read 结果).
export function clampToolResults(results: BashToolResult[], budget: { remaining: number }): BashToolResult[] {
  if (!Array.isArray(results) || results.length === 0) return results
  return results.map((r) => {
    if (budget.remaining <= 0) {
      return { ...r, stdout: '… [已省略]', stderr: '', content: '… [已省略]', readFile: undefined }
    }
    const readFile = r.readFile
      ? { ...r.readFile, content: clampStringForRender(r.readFile.content, budget) }
      : r.readFile
    return {
      ...r,
      stdout: clampStringForRender(r.stdout, budget),
      stderr: clampStringForRender(r.stderr, budget),
      content: clampStringForRender(r.content, budget),
      readFile,
    }
  })
}
