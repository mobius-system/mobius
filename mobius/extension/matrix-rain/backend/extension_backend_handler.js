// matrix-rain/backend/extension_backend_handler.js
//
// 数字雨主数据流是实时的 /api/token_stream (SSE), 必须由浏览器 EventSource 直连主后端
// (主项目联合修改, 见 mobius-extension SKILL §4). 本 handler 只承担"状态/控制"类调用,
// 因为拓展 handler 跑在 30s 超时、无状态的 worker_thread 里, 无法维持 SSE 长连接.
//
// 硬约束: stateless, 30s/5MB, 只读 process.env, 出站 fetch 探测 token-proxy 存活.

const PROXY_HOST = process.env.MOBIUS_TOKEN_PROXY_HOST || '127.0.0.1';
const PROXY_PORT = process.env.MOBIUS_TOKEN_PROXY_PORT || '45630';

module.exports = async function ({ username, display_name, ext_main_payload }) {
  const action = ext_main_payload && ext_main_payload.action;

  if (action === 'whoami' || !action) {
    return {
      ok: true,
      username,
      display_name: display_name || username || '',
      service: 'matrix-rain',
      feed_url: '/api/token_stream',
      desc: '黑客帝国数字雨 · 由实时 token 驱动',
    };
  }

  if (action === 'proxy_status') {
    // 探测 token-proxy 是否在线 (它持有 token 环形缓冲). 走本机 loopback.
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const r = await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/healthz`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return { ok: true, online: false, http_status: r.status };
      const data = await r.json().catch(() => ({}));
      return { ok: true, online: true, subscribers: data.subscribers ?? null, ts: data.ts ?? null };
    } catch (e) {
      return { ok: true, online: false, error: String((e && e.message) || e) };
    }
  }

  return { ok: false, error: 'unknown action' };
};
