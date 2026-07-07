import { createContext, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../store'
import { buildVscodeUrl } from './project-files'

// =====================================================================
// VSCodeOpenContext — supplies projectId-aware "open this absolute path
// in code-server" to whatever markdown is rendered underneath. Lets the
// JSONL renderer reroute clicks on links like [foo](/home/.../file.pdf)
// so they open in VSCode Web instead of 404-ing against the current host.
// Outside the provider, openLocalPath returns null → renderer falls back
// to the default anchor behavior.
//
// Lives in its own file (not next to JsonlCompactMarkdown) so chat.tsx
// can import the provider without dragging react-markdown into the main
// chunk — the markdown renderer stays lazy-loaded.
// =====================================================================
export type VSCodeOpenContextValue = {
  openLocalPath: (absPath: string) => string | null
}

export const VSCodeOpenContext = createContext<VSCodeOpenContextValue | null>(null)

type ProjectMeta = { bind_path?: string; vscode_web_url?: string; vscode_workspace_path?: string }

function normalizeFsPath(value?: string): string {
  const trimmed = (value || '').trim()
  if (!trimmed.startsWith('/')) return ''
  const collapsed = trimmed.replace(/\/+/g, '/')
  return collapsed.replace(/\/+$/g, '') || '/'
}

function dirnameFsPath(absPath: string): string {
  const normalized = normalizeFsPath(absPath)
  if (!normalized || normalized === '/') return ''
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return '/'
  return normalized.slice(0, idx)
}

function isWithinFsPath(rootPath: string, targetPath: string): boolean {
  const root = normalizeFsPath(rootPath)
  const target = normalizeFsPath(targetPath)
  if (!root || !target) return false
  return target === root || target.startsWith(root + '/')
}

function workspaceForLocalPath(meta: ProjectMeta, absPath: string): string {
  const bindPath = normalizeFsPath(meta.bind_path)
  const targetPath = normalizeFsPath(absPath)
  const defaultWorkspace = normalizeFsPath(meta.vscode_workspace_path) || bindPath
  if (!bindPath || !targetPath) return defaultWorkspace
  if (defaultWorkspace && isWithinFsPath(defaultWorkspace, targetPath)) return defaultWorkspace
  const parentPath = dirnameFsPath(bindPath)
  if (parentPath && isWithinFsPath(parentPath, targetPath)) return parentPath
  return defaultWorkspace
}

export function VSCodeOpenProvider({ projectId, children }: { projectId?: string | null; children: ReactNode }) {
  // Cache the project meta + the in-flight fetch promise. The provider can
  // sit above many links; we want exactly one /api/projects/:id/files
  // request per projectId for the lifetime of the provider.
  const metaRef = useRef<ProjectMeta | null>(null)
  const pendingRef = useRef<Promise<ProjectMeta | null> | null>(null)
  const [, forceUpdate] = useState(0)

  const loadMeta = useCallback((): Promise<ProjectMeta | null> => {
    if (!projectId) return Promise.resolve(null)
    if (metaRef.current) return Promise.resolve(metaRef.current)
    if (pendingRef.current) return pendingRef.current
    const p = api(`/api/projects/${projectId}/files?path=/`)
      .then((data: any) => {
        const meta: ProjectMeta = {
          bind_path: data?.bind_path || '',
          vscode_web_url: data?.vscode_web_url || '',
          vscode_workspace_path: data?.vscode_workspace_path || data?.bind_path || '',
        }
        metaRef.current = meta
        pendingRef.current = null
        forceUpdate(n => n + 1)
        return meta
      })
      .catch(() => {
        pendingRef.current = null
        return null
      })
    pendingRef.current = p
    return p
  }, [projectId])

  // Synchronous resolver used by the click handler. If meta is already
  // cached, returns the VSCode URL immediately. Otherwise kicks off the
  // fetch and returns null — link click falls back to default this once;
  // next click on a sibling link benefits from the cache.
  const openLocalPath = useCallback((absPath: string): string | null => {
    if (!projectId) return null
    const meta = metaRef.current
    if (!meta) { loadMeta(); return null }
    if (!meta.bind_path || !meta.vscode_web_url) return null
    return buildVscodeUrl(meta.vscode_web_url, workspaceForLocalPath(meta, absPath), absPath)
  }, [projectId, loadMeta])

  // Warm the cache as soon as the provider mounts with a projectId, so
  // the very first link click resolves synchronously.
  if (projectId && !metaRef.current && !pendingRef.current) loadMeta()

  const value = useMemo(() => ({ openLocalPath }), [openLocalPath])
  return <VSCodeOpenContext.Provider value={value}>{children}</VSCodeOpenContext.Provider>
}

// Absolute filesystem path heuristic. We only intercept paths whose first
// segment is a well-known filesystem root — otherwise legitimate in-app
// links like "/api/..." or "/issues/..." would get hijacked. Extend the
// list cautiously: each prefix is a commitment that real paths under it
// are reachable by the same VSCode Web instance as the project bind path.
const FS_PATH_PREFIXES = ['/home/', '/root/', '/Users/', '/tmp/', '/var/', '/mnt/', '/opt/', '/srv/', '/data/']
export function isLikelyFilesystemPath(href: string): boolean {
  if (!href || href.startsWith('//')) return false
  if (!href.startsWith('/')) return false
  return FS_PATH_PREFIXES.some(p => href.startsWith(p))
}

// Rewrite a media src (markdown <img>, display_images card, ...) that points at
// an absolute server-side filesystem path into a backend-served URL. Mirrors how
// FileManager surfaces local files: route them through GET /api/download, which
// is gated by downloadAuth and only serves paths the user may read (work_dir,
// mobius upload dir, system temp, extension user-data). This is what makes an
// agent message like ![shot](/home/.../x.png) actually render — a raw filesystem
// path in <img src> 404s against the dev/prod host. http(s) / data: / blob: and
// already-API URLs pass through untouched; relative or in-app paths are left as
// they are (isLikelyFilesystemPath keeps us from hijacking those).
export function resolveMediaSrc(src: string): string {
  if (!src) return src
  if (/^https?:\/\//i.test(src)) return src
  if (src.startsWith('//') || src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('/api/')) return src
  if (!isLikelyFilesystemPath(src)) return src
  const token = typeof window !== 'undefined' ? (localStorage.getItem('cc-token') || '') : ''
  return `/api/download?path=${encodeURIComponent(src)}${token ? `&token=${encodeURIComponent(token)}` : ''}`
}
