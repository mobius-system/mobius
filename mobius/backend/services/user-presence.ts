/**
 * user-presence.ts — 用户"在线"状态(是否有活跃 SSE 连接)的内存追踪.
 *
 * 用途: 消息推送钩子据此判断目标用户是否在线. 在线 = 当前连着任意 session/conversation
 * 的 SSE 事件流 → 消息已由 SSE 实时送达, 不必再远程推送; 离线(进程被杀/切到后台/关页面)
 * 才走 JPush 远程推送兜底.
 *
 * 实现: 按 userId 引用计数. 每个 SSE 连接 open 时 track() → 计数+1, 返回 release();
 * 连接 close 时 release() → 计数-1, 减到 0 即"离线". 支持同一用户多端/多会话同时在线.
 *
 * 进程内 Map: Mobius 单进程, 重启即清空(可接受 — 重启后 SSE 会重连, 几秒内恢复在线).
 * 不落库: 在线是瞬时状态, 无需持久化.
 */
const onlineCount = new Map<string, number>();

/** 标记某用户有一个活跃 SSE 连接; 返回 release 函数, 在连接关闭时调用. */
function track(userId: string): () => void {
  const id = String(userId || '').trim();
  if (!id) return () => {};
  onlineCount.set(id, (onlineCount.get(id) || 0) + 1);
  return () => {
    const n = (onlineCount.get(id) || 0) - 1;
    if (n > 0) onlineCount.set(id, n);
    else onlineCount.delete(id);
  };
}

/** 该用户当前是否有至少一个活跃 SSE 连接. */
function isOnline(userId: string): boolean {
  const id = String(userId || '').trim();
  if (!id) return false;
  return (onlineCount.get(id) || 0) > 0;
}

export { track, isOnline };
