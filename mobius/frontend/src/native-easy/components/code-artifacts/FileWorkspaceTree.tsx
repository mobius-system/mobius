import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../store'
import { FileTreeLevel, type DirState, type Entry } from '../project-files'
import { targetFromTrustedPath } from './file-target'
import type { CodeArtifactOpenRequest } from './file-target'

function ancestorDirs(projectPath: string) {
  const parts = projectPath.replace(/^\/+/, '').split('/').filter(Boolean)
  const dirs = ['/']
  let current = ''
  for (const part of parts.slice(0, -1)) {
    current += `/${part}`
    dirs.push(current)
  }
  return dirs
}

function projectPathFromEntry(entry: Entry, bindPath: string) {
  if (entry.rel_path) return entry.rel_path.replace(/^\/+/, '')
  const root = bindPath.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const abs = String(entry.abs_path || '').replace(/\\/g, '/')
  if (root && abs.startsWith(`${root}/`)) return abs.slice(root.length + 1)
  return entry.name
}

export function FileWorkspaceTree({
  projectId,
  activePath,
  activeAbsPath,
  revealDir = '',
  onOpenRequest,
}: {
  projectId: string
  activePath: string
  activeAbsPath?: string
  revealDir?: string
  onOpenRequest: (request: CodeArtifactOpenRequest) => void
}) {
  const [query, setQuery] = useState('')
  const [bindPath, setBindPath] = useState('')
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['/']))
  const loadedRef = useRef<Set<string>>(new Set())

  const loadDir = useCallback(async (relPath: string) => {
    if (loadedRef.current.has(relPath)) return
    loadedRef.current.add(relPath)
    setDirs(previous => ({ ...previous, [relPath]: { ...previous[relPath], loading: true, error: undefined } }))
    try {
      const data = await api(`/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(relPath)}`)
      if (relPath === '/') setBindPath(String(data?.bind_path || ''))
      setDirs(previous => ({ ...previous, [relPath]: { loading: false, entries: data.entries || [] } }))
    } catch (error: any) {
      loadedRef.current.delete(relPath)
      setDirs(previous => ({
        ...previous,
        [relPath]: { loading: false, error: error?.message || '加载失败' },
      }))
    }
  }, [projectId])

  useEffect(() => {
    loadedRef.current = new Set()
    setDirs({})
    setBindPath('')
    setExpanded(new Set(['/']))
    void loadDir('/')
  }, [loadDir, projectId])

  useEffect(() => {
    const folderPath = revealDir ? `/${revealDir.replace(/^\/+/, '')}/.` : activePath
    const nextDirs = ancestorDirs(folderPath)
    if (revealDir) nextDirs.push(`/${revealDir.replace(/^\/+/, '')}`)
    setExpanded(previous => {
      const next = new Set(previous)
      let changed = false
      nextDirs.forEach(path => {
        if (!next.has(path)) {
          next.add(path)
          changed = true
        }
      })
      return changed ? next : previous
    })
    nextDirs.forEach(path => { void loadDir(path) })
  }, [activePath, loadDir, revealDir])

  const toggleDir = (relPath: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(relPath)) next.delete(relPath)
      else {
        next.add(relPath)
        if (!dirs[relPath]) void loadDir(relPath)
      }
      return next
    })
  }

  const visibleDirs = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return dirs
    const next: Record<string, DirState> = {}
    for (const [path, state] of Object.entries(dirs)) {
      next[path] = {
        ...state,
        entries: state.entries?.filter(entry => entry.type === 'dir' || entry.name.toLowerCase().includes(needle)),
      }
    }
    return next
  }, [dirs, query])

  return (
    <aside className="code-artifact-preview__tree" data-code-artifact-tree aria-label="项目文件">
      <input
        type="search"
        className="code-artifact-preview__tree-filter"
        placeholder="筛选文件…"
        value={query}
        onChange={event => setQuery(event.target.value)}
        aria-label="筛选文件"
      />
      <div className="code-artifact-preview__tree-list">
        <FileTreeLevel
          relPath="/"
          depth={0}
          dirs={visibleDirs}
          expanded={expanded}
          onToggleDir={toggleDir}
          onOpenFile={entry => {
            const path = projectPathFromEntry(entry, bindPath)
            const target = targetFromTrustedPath(path, { intent: 'preview', source: 'message' })
            if (target) onOpenRequest({ target })
          }}
          vscodeReady
          selectedAbsPath={activeAbsPath}
          fileActionLabel="在工作区打开"
        />
      </div>
    </aside>
  )
}
