/**
 * mobius-agent-history-deprecated.ts — 已弃用兼容层 (旧读路径的库版替身).
 *
 * 这里只放 "旧语义" 的过渡函数: 名字带 deprecated 前缀, 各自有明确退场条件,
 * 退场后逐个删, 文件空了整删.
 *
 * (getHistorySnapshot 不在此列 — 平铺全量读法是正当内部 API, 已回归主模块.)
 *
 * 删除清单:
 *   - deprecatedMobiusJsonlPathOf
 *       调用方: services/time-consume-waterfall.js (旧双轨字节统计).
 *       退场条件: 统计迁移后删.
 *       备注: session-transfer.ts (会话导出读冻结文件) 与懒迁移模块
 *       mobius-agent-history-legacy.ts 各有独立副本, 退场时一并清理.
 */

/**
 * @deprecated 旧伴生文件 (.mobius.jsonl) 路径推导. 该文件已冻结不再写入,
 * 仅剩迁移/搜索/统计类过渡消费方还在读它.
 */
export function deprecatedMobiusJsonlPathOf(jsonlPath: string | null | undefined): string | null {
  if (!jsonlPath || typeof jsonlPath !== 'string') return null;
  return jsonlPath.endsWith('.jsonl')
    ? jsonlPath.slice(0, -'.jsonl'.length) + '.mobius.jsonl'
    : jsonlPath + '.mobius.jsonl';
}
