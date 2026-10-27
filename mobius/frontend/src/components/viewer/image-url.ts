export function authenticatedImageUrl(src: string): string {
  if (!/^\/access_base64_image(?:\?|$)/.test(src)) return src
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('cc-token') || '' : ''
  if (!token) return src
  const url = new URL(src, window.location.origin)
  url.searchParams.set('token', token)
  return `${url.pathname}${url.search}`
}
