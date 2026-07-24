/**
 * viewer/tool-status.ts — 工具调用状态 (running/success/error) 的纯推导逻辑.
 *
 * 复刻 Cursor 式 "工具调用先以 running 出现, 完成后原地更新为 success/error" 的过程感.
 * 设计要点:
 *  - 后端是纯透传管道 (tail jsonl → SSE), 不产单工具粒度的状态事件;
 *    因此状态完全由前端推导: 收到 tool_use 但尚未收到对应 tool_result = running.
 *  - 历史回放时 mergeBashToolResultItems 已一次性配对, tool_use 卡挂载时 result 已就位
 *    → 直接 success/error, 不会误显 running; 只有实时流式才会出现 running 窗口.
 *  - 复用 extractBashToolResultRecords 抽取 tool_result (覆盖 Claude tool_result block
 *    与 codex function_call_output), 不触碰 mergeBashToolResultItems 的微妙配对逻辑.
 */
import type { AnyEntry } from './types'
import { extractBashToolResultRecords, isFunctionCallPayload } from './entry-extract'
import { stringField } from './utils'

export type ToolStatus = 'running' | 'success' | 'error'

// 已落地结果的 callId → 结果摘要. isError/interrupted 取并集 (同一 call 多次结果时任一失败即记失败).
export type ResolvedCallInfo = { isError: boolean; interrupted: boolean }
export type ResolvedCallMap = Map<string, ResolvedCallInfo>

// 头部状态图标的视觉元数据 (图标组件映射在 EntryCard.tsx, 这里只放纯数据, 保持本文件无 React 依赖).
export const TOOL_STATUS_META: Record<ToolStatus, { iconClass: string; spin: boolean; label: string }> = {
  running: { iconClass: 'text-blue-400', spin: true, label: '执行中' },
  success: { iconClass: 'text-emerald-400', spin: false, label: '成功' },
  error: { iconClass: 'text-red-400', spin: false, label: '失败' },
}

// 抽出一条 entry 内所有 tool_use 的稳定 id (用于查 result 是否已到).
//  - Claude: assistant.message.content[] 里 type:tool_use 的 id (call_xxx).
//  - codex: response_item 的 function_call / custom_tool_call 的 call_id.
// 同一条 assistant entry 含多个 tool_use 时全部返回 (保序).
export function extractToolUseIds(entry: AnyEntry): string[] {
  const ids: string[] = []
  if (entry?.type === 'assistant') {
    const c = entry?.message?.content
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'tool_use' && typeof b.id === 'string' && b.id) ids.push(b.id)
      }
    }
  }
  if (entry?.type === 'response_item' && isFunctionCallPayload(entry?.payload)) {
    const callId = stringField(entry?.payload?.call_id)
    if (callId) ids.push(callId)
  }
  return ids
}

// 扫描全部 entries, 收集 "已有 tool_result 落地" 的 callId 及其错误标志.
// 复用 extractBashToolResultRecords: 它已统一处理两种协议的 tool_result, 这里只做聚合.
export function collectResolvedCallIds(entries: AnyEntry[]): ResolvedCallMap {
  const map: ResolvedCallMap = new Map()
  entries.forEach((entry, index) => {
    const records = extractBashToolResultRecords(entry, index + 1)
    for (const r of records) {
      if (!r.toolUseId) continue
      const prev = map.get(r.toolUseId)
      map.set(r.toolUseId, {
        isError: !!(prev?.isError || r.isError),
        interrupted: !!(prev?.interrupted || r.interrupted),
      })
    }
  })
  return map
}

// 由 entry 与已落地结果集合推导该卡片工具状态. 无 tool_use (非工具卡) 返回 null, 不显示图标.
// 聚合规则: 任一 call 失败 → error (最高优先, 折叠也不藏错误); 否则任一 call 未落地 → running; 否则 success.
export function deriveToolCallStatus(entry: AnyEntry, resolved: ResolvedCallMap | null | undefined): ToolStatus | null {
  if (!resolved) return null
  const ids = extractToolUseIds(entry)
  if (ids.length === 0) return null
  let anyRunning = false
  for (const id of ids) {
    const r = resolved.get(id)
    if (!r) { anyRunning = true; continue }
    if (r.isError || r.interrupted) return 'error'
  }
  return anyRunning ? 'running' : 'success'
}
