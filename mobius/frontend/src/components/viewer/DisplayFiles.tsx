import { useContext, useEffect, useState } from 'react'
import { Download, FileCode2, FileText, FolderOpen, Loader2 } from 'lucide-react'
import { api } from '../../store'
import type { DisplayFileRef } from './entry-extract'
import { DisplayFileContext } from './DisplayFileContext'
import { fileDownloadUrl } from './JsonlDownloadButton'

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function isTextFile(path: string): boolean {
  return /(?:^|\/)(?:readme(?:\.[^/]*)?|[^/]+\.(?:txt|text|log|md|markdown|py|js|jsx|ts|tsx|json|ya?ml|toml|ini|conf|sh|bash|zsh|css|html?|sql|go|rs|java|c|h|cpp))$/i.test(path)
}

/**
 * 卡片对应的服务器绝对路径 (供 /api/download 取用)。
 * 远程文件落在别的机器上, 中继没有可直读的路径, 返回 null 表示不提供下载;
 * 绝对路径不在 bind_path 子树内 (越界) 同样返回 null。
 * Absolute path on the Mobius host, or null when it cannot be resolved in place
 * (remote file, or an absolute path outside the project's bind_path).
 */
function localAbsolutePath(file: DisplayFileRef, bindPath: string): string | null {
  if (file.remote) return null
  const root = bindPath.replace(/\/+$/, '')
  if (!root) return null
  if (file.path.startsWith('/')) {
    return file.path === root || file.path.startsWith(`${root}/`) ? file.path : null
  }
  return `${root}/${file.path}`
}

export function DisplayFilesCard({ files, projectId, sessionId, easyMode = false }: {
  files: DisplayFileRef[]
  projectId?: string
  sessionId?: string
  easyMode?: boolean
}) {
  const context = useContext(DisplayFileContext)
  projectId = projectId || context?.projectId
  sessionId = sessionId || context?.sessionId
  const bindPath = context?.bindPath || ''
  const [sizes, setSizes] = useState<Record<string, number | null>>({})
  const filesKey = files.map(file => `${file.remote || ''}\0${file.root || ''}\0${file.path}`).join('\n')
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    for (const keyValue of filesKey.split('\n').filter(Boolean)) {
      const [remoteValue, rootValue, ...pathParts] = keyValue.split('\0')
      const file = { remote: remoteValue || undefined, root: rootValue || undefined, path: pathParts.join('\0') }
      const key = `${file.remote || ''}\0${file.root || ''}\0${file.path}`
      const normalizedPath = file.remote
        ? file.path.replace(/^\/+/, '')
        : file.path.startsWith('/') && bindPath
          ? file.path.startsWith(`${bindPath.replace(/\/$/, '')}/`) ? file.path.slice(bindPath.replace(/\/$/, '').length + 1) : ''
          : file.path
      if (!normalizedPath || normalizedPath.split('/').some(part => part === '..')) {
        if (!cancelled) setSizes(previous => ({ ...previous, [key]: null }))
        continue
      }
      const parent = normalizedPath.includes('/') ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/')) || '/' : '/'
      const name = normalizedPath.split('/').filter(Boolean).pop() || normalizedPath
      const remoteQuery = file.remote
        ? `remote=${encodeURIComponent(file.remote)}&path=${encodeURIComponent(parent)}&root=${encodeURIComponent(file.root || '')}${sessionId ? `&session=${encodeURIComponent(sessionId)}` : ''}`
        : `path=${encodeURIComponent(parent)}`
      api(`/api/projects/${projectId}/${file.remote ? 'remote-files' : 'files'}?${remoteQuery}`)
        .then((data: any) => {
          const entry = (data?.entries || []).find((row: any) => row?.name === name && row?.type === 'file')
          if (!cancelled) setSizes(previous => ({ ...previous, [key]: typeof entry?.size === 'number' ? entry.size : null }))
        })
        .catch(() => { if (!cancelled) setSizes(previous => ({ ...previous, [key]: null })) })
    }
    return () => { cancelled = true }
  }, [filesKey, projectId, sessionId])

  return (
    <section className={`display-files-card${easyMode ? ' display-files-card--easy' : ''}`} aria-label="展示文件">
      {files.map(file => {
        const key = `${file.remote || ''}\0${file.root || ''}\0${file.path}`
        const size = sizes[key]
        const validRemotePath = !file.remote || (!file.path.startsWith('/') && !file.path.split(/[\\/]/).some(part => part === '..'))
        const supported = isTextFile(file.path) && validRemotePath
        const downloadPath = localAbsolutePath(file, bindPath)
        const Icon = /\.(?:py|js|jsx|ts|tsx|json|ya?ml|toml|sh|bash|html?|css|sql|go|rs|java|c|h|cpp)$/i.test(file.path) ? FileCode2 : FileText
        return (
          <div key={key} className="display-files-card__row">
            <button
              type="button"
              className="display-files-card__item"
              disabled={!projectId || !supported}
              title={supported ? '在文件浏览器中打开' : validRemotePath ? '暂不支持预览此文件类型' : '远程文件路径必须相对于根目录且不能包含 ..'}
              onClick={() => window.dispatchEvent(new CustomEvent('mobius:request-open-file-in-sidebar', {
              detail: { projectId, sessionId, ...file },
              }))}
            >
              <Icon size={17} aria-hidden="true" />
              <span className="display-files-card__meta">
                <strong>{file.path.split('/').filter(Boolean).pop() || file.path}</strong>
                <small>{file.path}{file.remote ? ` · 远程 ${file.remote}` : ''}</small>
              </span>
              <span className="display-files-card__size">{size === undefined ? <Loader2 size={13} className="animate-spin" /> : size === null ? '大小未知' : formatBytes(size)}</span>
              {supported && <FolderOpen size={15} aria-hidden="true" />}
            </button>
            {downloadPath && (
              <button
                type="button"
                className="display-files-card__download"
                title="下载文件"
                aria-label="下载文件"
                onClick={() => window.open(fileDownloadUrl(downloadPath), '_blank')}
              >
                <Download size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        )
      })}
    </section>
  )
}
