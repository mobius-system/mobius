/**
 * viewer/explore-group.ts — 探索类工具调用聚合 (复刻 Cursor "Explored N tools" 折叠).
 *
 * 把连续的只读/搜索类工具调用 (Read/Grep/Glob/WebFetch/WebSearch/LS) 合并成一个虚拟组,
 * 默认折叠成一行摘要 "已探索 N 个工具", 点击展开看每一步. 设计要点 (对齐 agent_output_design §5.1):
 *  - 只聚合连续的 explore 类; 一旦被 text/edit/bash/event 等非探索类 entry 打断就结束当前分组.
 *  - ≥2 个才聚合 (单个 explore 保持原样, 不额外包一层).
 *  - 分组内任一步骤失败 → hasError=true, 摘要行必须显示错误标记 (折叠也不能藏起错误).
 * 纯逻辑无 React 依赖; 折叠容器组件在 RoundGroups.tsx 的 ExploreGroupCard.
 */
import type { AnyEntry, RoundItem } from './types'
import { isFunctionCallPayload } from './entry-extract'
import { deriveToolCallStatus } from './tool-status'
import type { ResolvedCallMap } from './tool-status'

// 探索类工具名 (只读/搜索): 默认聚合折叠. Edit/Write/Bash 等有副作用的工具不在其列.
// 统一小写并去掉 -/_ 让 WebFetch/web_fetch 都命中.
const EXPLORE_TOOL_NAMES = new Set(['read', 'grep', 'glob', 'webfetch', 'websearch', 'ls'])

function normalizeToolName(name: unknown): string {
  return typeof name === 'string' ? name.toLowerCase().replace(/[-_]/g, '') : ''
}

// entry 是否为探索类 tool_use (Claude assistant.content 的 tool_use 或 codex function_call).
export function isExploreToolUse(entry: AnyEntry): boolean {
  if (entry?.type === 'assistant') {
    const c = entry?.message?.content
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'tool_use' && EXPLORE_TOOL_NAMES.has(normalizeToolName(b.name))) return true
      }
    }
  }
  if (entry?.type === 'response_item' && isFunctionCallPayload(entry?.payload)) {
    if (EXPLORE_TOOL_NAMES.has(normalizeToolName(entry?.payload?.name))) return true
  }
  return false
}

export type ExploreRenderItem =
  | { kind: 'single'; item: RoundItem }
  | { kind: 'explore'; items: RoundItem[]; hasError: boolean }

// 把一轮内的 items 按连续 explore 类聚合成渲染节点序列.
export function groupExploreItems(items: RoundItem[], resolvedMap: ResolvedCallMap | null | undefined): ExploreRenderItem[] {
  const out: ExploreRenderItem[] = []
  let bucket: RoundItem[] = []
  const flush = () => {
    if (bucket.length === 0) return
    if (bucket.length === 1) {
      out.push({ kind: 'single', item: bucket[0] })
    } else {
      const hasError = bucket.some((it) => deriveToolCallStatus(it.entry, resolvedMap) === 'error')
      out.push({ kind: 'explore', items: bucket, hasError })
    }
    bucket = []
  }
  for (const it of items) {
    if (isExploreToolUse(it.entry)) {
      bucket.push(it)
    } else {
      flush()
      out.push({ kind: 'single', item: it })
    }
  }
  flush()
  return out
}
