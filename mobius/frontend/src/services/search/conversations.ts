export async function searchConversations(params: URLSearchParams, signal?: AbortSignal): Promise<any> {
  const token = localStorage.getItem('cc-token')
  const response = await fetch(`/api/search?${params}`, {
    signal,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || '搜索失败')
  return body
}
