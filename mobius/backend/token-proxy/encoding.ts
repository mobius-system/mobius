/**
 * token-proxy/encoding.ts — 黑客帝国数字雨 · 中转代理凭证编码 (共享).
 *
 * 设计: cc 用 .withproxy.json, 其 env.ANTHROPIC_AUTH_TOKEN 被替换成
 *   "mpx1." + base64url( JSON.stringify(原始 settings json) )
 * server.ts 收到请求后解码该 token → 还原原始 env (真实 ANTHROPIC_BASE_URL /
 * ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL), 从而无状态地转发到真正的目标.
 *
 * 本模块被两处复用, 故单独抽出:
 *   - token-proxy/server.ts        (解码)
 *   - services/model-access.ts     (生成 .withproxy.json 时编码)
 *
 * 安全注记: token 内含真实 api key (base64 可逆). 仅落到 0600 的本机文件, 且只在
 * 127.0.0.1 loopback 上传输; 原始 settings 文件本就是明文 key, 不降低安全水位.
 */

export const PROXY_TOKEN_PREFIX = 'mpx1.'

/** 把原始 settings 对象编码成 mobius 代理 token: `mpx1.<base64url(json)>`. */
export function encodeProxyToken(settingsObj: any): string {
  const json = JSON.stringify(settingsObj ?? {})
  const b64 = Buffer.from(json, 'utf8').toString('base64url')
  return `${PROXY_TOKEN_PREFIX}${b64}`
}

/** 解码 mobius 代理 token, 还原原始 settings 对象. 非 mpx1 token 抛错. */
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

/** 从原始 settings 对象解析出真实上游信息 (供 server.ts 转发用). */
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
