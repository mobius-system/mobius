const LOCATE_TIMEOUT_MS = 3000

export async function locateSource(snapshot) {
  const token = localStorage.getItem('cc-token') || ''
  if (!token) return { candidates: [], unavailable: '当前页面未登录，未调用管理员源码定位接口。' }

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), LOCATE_TIMEOUT_MS)
  try {
    const response = await fetch('/api/admin/designer-eye/locate', {
      method: 'POST',
      credentials: 'include',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        page: snapshot.page,
        signals: snapshot.signals,
      }),
    })
    let data = null
    try { data = await response.json() } catch { data = null }
    if (!response.ok) {
      const message = response.status === 403
        ? '当前账号不是管理员，已使用本地 DOM 指纹生成提示词。'
        : (data?.error || `源码定位接口返回 ${response.status}`)
      return { candidates: [], unavailable: message }
    }
    return {
      scope: data?.scope || '',
      candidates: Array.isArray(data?.candidates) ? data.candidates : [],
      unavailable: '',
    }
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? '源码定位超过 3 秒，已使用本地 DOM 指纹生成提示词。'
      : `源码定位暂不可用：${error?.message || '未知错误'}`
    return { candidates: [], unavailable: message }
  } finally {
    window.clearTimeout(timer)
  }
}
