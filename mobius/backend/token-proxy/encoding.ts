/**
 * token-proxy/encoding.ts — 黑客帝国数字雨 · 中转代理凭证编码 (共享).
 *
 * 设计: cc/codex 用 .withproxy 变体配置, 其鉴权 token 被替换成
 *   "mpx1." + base64url( JSON.stringify(上游描述) )
 * server.ts 收到请求后解码 → 还原真实上游 (baseUrl/authToken/model) 与
 * session/agent 标识, 从而无状态转发并按 session 分桶缓存.
 *
 * 兼容两种载荷:
 *   - 新标准结构 UpstreamInfo { wire, baseUrl, authToken, model, sessionId, agent }
 *   - 旧结构 (整份 Anthropic settings JSON), 由 upstreamFromSettings 解析回落.
 *
 * 本模块被两处复用, 故单独抽出:
 *   - token-proxy/server.ts        (解码)
 *   - services/model-access.ts     (生成 .withproxy 变体时编码)
 *
 * 安全注记: token 内含真实 api key (base64 可逆). 仅落到 0600 的本机文件, 且只在
 * 127.0.0.1 loopback 上传输; 原始 settings 文件本就是明文 key, 不降低安全水位.
 */

export const PROXY_TOKEN_PREFIX = 'mpx1.'

/** 标准化上游描述: 编进 token 的载荷. wire 区分 Anthropic Messages 与 OpenAI Responses. */
export interface UpstreamInfo {
  wire: 'anthropic' | 'openai'
  baseUrl: string
  authToken: string
  model: string
  sessionId?: string | null
  agent?: string | null
}

/** 把任意对象编码成 mobius 代理 token: `mpx1.<base64url(json)>`. */
export function encodeProxyToken(obj: any): string {
  const json = JSON.stringify(obj ?? {})
  const b64 = Buffer.from(json, 'utf8').toString('base64url')
  return `${PROXY_TOKEN_PREFIX}${b64}`
}

/** 解码 mobius 代理 token, 还原对象. 非 mpx1 token 抛错. */
export function decodeProxyToken(token: any): any {
  const s = String(token || '').trim()
  if (!s.startsWith(PROXY_TOKEN_PREFIX)) {
    throw new Error('not a mobius proxy token (missing mpx1. prefix)')
  }
  const b64 = s.slice(PROXY_TOKEN_PREFIX.length)
  let json: string
  try {
    json = Buffer.from(b64, 'base64url').toString('utf8')
  } catch (e: any) {
    throw new Error(`proxy token base64 解码失败: ${e?.message || e}`)
  }
  try {
    return JSON.parse(json)
  } catch (e: any) {
    throw new Error(`proxy token JSON 解析失败: ${e?.message || e}`)
  }
}

/** 从原始 Anthropic settings 对象解析出真实上游信息 (旧格式回落用). */
export function upstreamFromSettings(parsedSettings: any): {
  baseUrl: string
  authToken: string
  model: string
} {
  const env = (parsedSettings && typeof parsedSettings === 'object' ? parsedSettings.env : null) || {}
  const baseUrl = String(env.ANTHROPIC_BASE_URL || '').trim().replace(/\/+$/, '') || 'https://api.anthropic.com'
  const authToken = String(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '').trim()
  const model = String(parsedSettings?.model || env.ANTHROPIC_MODEL || '').trim()
  return { baseUrl, authToken, model }
}

/** 统一解析 token 载荷: 兼容新标准结构 (含 baseUrl 字段) 与旧整份 settings 结构. */
export function resolveUpstream(decoded: any): UpstreamInfo {
  if (decoded && typeof decoded === 'object' && typeof decoded.baseUrl === 'string') {
    return {
      wire: decoded.wire === 'openai' ? 'openai' : 'anthropic',
      baseUrl: String(decoded.baseUrl || '').trim().replace(/\/+$/, '') || 'https://api.anthropic.com',
      authToken: String(decoded.authToken || decoded.auth_token || '').trim(),
      model: String(decoded.model || '').trim(),
      sessionId: decoded.sessionId ?? decoded.session_id ?? null,
      agent: decoded.agent ?? null,
    }
  }
  const u = upstreamFromSettings(decoded)
  return { wire: 'anthropic', baseUrl: u.baseUrl, authToken: u.authToken, model: u.model, sessionId: null, agent: null }
}
