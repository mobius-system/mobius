/**
 * agent-jsonl-path.ts — Resolve the transcript path a session's backend reports.
 *
 * Every caller (history sync, search, mention context, timing waterfall) only
 * needs "where is this session's jsonl", never how the backend finds it. The
 * lookup moved from a private method to a public one while the backend files
 * were split, so both names are accepted here and the rule lives in one place
 * instead of six `typeof backend._x === 'function'` copies.
 */
export function agentJsonlPathOf(backend: any, sessionId: string): string | null {
  if (!backend || !sessionId) return null
  // 公开方法优先; 旧名保留给 deepseek-harness 等尚未改名的后端
  // The public method wins; the old name stays for backends not yet renamed
  if (typeof backend.resolveJsonlPath === 'function') return backend.resolveJsonlPath(sessionId) || null
  if (typeof backend._resolveJsonlPath === 'function') return backend._resolveJsonlPath(sessionId) || null
  return null
}
