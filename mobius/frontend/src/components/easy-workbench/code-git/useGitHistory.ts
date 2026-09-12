import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../../store'
import { sanitizeToolError } from '../session-tool-context'
import type { GitCommit, GitHistoryResponse } from './types'

const HISTORY_PAGE_SIZE = 30

export function useGitHistory({
  projectId,
  file,
  enabled,
}: {
  projectId?: string | null
  file?: string | null
  enabled: boolean
}) {
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [response, setResponse] = useState<GitHistoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)
  const requestTokenRef = useRef(0)

  const load = useCallback(async (cursor = '') => {
    if (!projectId || !enabled) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    const requestToken = ++requestTokenRef.current
    controllerRef.current = controller
    if (cursor) setLoadingMore(true)
    else setLoading(true)
    setError('')

    const query = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) })
    if (cursor) query.set('cursor', cursor)
    if (file) query.set('file', file)
    try {
      const data = await api(`/api/projects/${projectId}/git-history?${query.toString()}`, { signal: controller.signal }) as GitHistoryResponse
      if (controller.signal.aborted || requestToken !== requestTokenRef.current) return
      const nextCommits = Array.isArray(data?.commits) ? data.commits : []
      setResponse(data)
      setCommits(previous => {
        if (!cursor) return nextCommits
        const known = new Set(previous.map(commit => commit.hash))
        return [...previous, ...nextCommits.filter(commit => !known.has(commit.hash))]
      })
    } catch (reason: any) {
      if (controller.signal.aborted || requestToken !== requestTokenRef.current) return
      if (!cursor) {
        setCommits([])
        setResponse(null)
      }
      setError(sanitizeToolError(reason, file ? '读取该文件历史失败' : '读取提交历史失败'))
    } finally {
      if (!controller.signal.aborted && requestToken === requestTokenRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [enabled, file, projectId])

  useEffect(() => {
    if (!enabled || !projectId) {
      controllerRef.current?.abort()
      setLoading(false)
      setLoadingMore(false)
      return
    }
    setCommits([])
    setResponse(null)
    void load()
    return () => controllerRef.current?.abort()
  }, [enabled, file, load, projectId, reloadKey])

  return {
    commits,
    repoName: response?.repo_name || '',
    loading,
    loadingMore,
    error,
    hasMore: !!response?.has_more,
    reload: () => setReloadKey(key => key + 1),
    loadMore: () => {
      if (!loading && !loadingMore && response?.has_more && response.next_cursor) {
        void load(response.next_cursor)
      }
    },
  }
}
