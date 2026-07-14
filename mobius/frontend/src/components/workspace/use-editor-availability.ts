import { useEffect, useState } from 'react'
import { api } from '../../store'

// =====================================================================
// useEditorAvailability — 查询某项目是否具备 "左代码" 能力 (bind_path + VSCODE_WEB_URL).
// 复用 /api/projects/:id/files?path=/ (与 OpenInVSCodeButton / ProjectFilesCard 同源).
// 模块级缓存 (Map) + 并发去重 (Set): 顶栏按钮 / EditorPane / IssuePage 三处共用,
// 同一项目只发一次请求, 结果跨组件共享.
//
// enabled 为 false 时完全不拉取 (避免在 UserPage/ProjectPage 等无关页面发请求);
// 典型用法: enabled = 在 issue/research 路由 && 已有 currentSession.
// =====================================================================
export type EditorAvailability = {
  bindPath: string
  vscodeWebUrl: string
  loading: boolean
}

type EditorMeta = { bindPath: string; vscodeWebUrl: string }
const metaCache = new Map<string, EditorMeta>()
const inflight = new Map<string, Promise<EditorMeta>>()

function fetchEditorMeta(projectId: string): Promise<EditorMeta> {
  const cached = metaCache.get(projectId)
  if (cached) return Promise.resolve(cached)

  const existing = inflight.get(projectId)
  if (existing) return existing

  const promise = api(`/api/projects/${projectId}/files?path=/`)
    .then((data: any) => {
      const meta: EditorMeta = { bindPath: data?.bind_path || '', vscodeWebUrl: data?.vscode_web_url || '' }
      metaCache.set(projectId, meta)
      return meta
    })
    .finally(() => {
      inflight.delete(projectId)
    })

  inflight.set(projectId, promise)
  return promise
}

export function useEditorAvailability(projectId: string | undefined | null, enabled: boolean): EditorAvailability {
  const key = projectId || ''
  const cached = key ? metaCache.get(key) : undefined
  const [meta, setMeta] = useState<EditorMeta | null>(cached ?? null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !key) return
    if (metaCache.has(key)) { setMeta(metaCache.get(key) ?? null); return }
    let cancelled = false
    setLoading(true)
    fetchEditorMeta(key).then((m) => {
      if (!cancelled) setMeta(m)
    }).catch(() => {
      // 保持旧行为: 查询失败时只结束 loading, 不写入空缓存, 允许后续重试.
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [key, enabled])

  return {
    bindPath: meta?.bindPath || '',
    vscodeWebUrl: meta?.vscodeWebUrl || '',
    loading,
  }
}
