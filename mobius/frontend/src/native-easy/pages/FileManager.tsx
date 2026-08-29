import { useState, useEffect, useCallback } from 'react'
import { api, useStore } from '../store'
import { ArrowLeft, Code2, File, FileCode2, FileImage, FileJson2, FileText, Folder, FolderOpen, Home, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { MARKDOWN_REMARK_PLUGINS, MARKDOWN_REHYPE_PLUGINS } from '../services/markdown'

interface FileEntry {
  name: string
  type: 'dir' | 'file'
  size: number | null
  modified: string
}

function formatSize(bytes: number | null) {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function getFileIcon(name: string, type: string) {
  if (type === 'dir') return <Folder className="h-4 w-4" aria-hidden />
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) return <FileImage className="h-4 w-4" aria-hidden />
  if (ext === 'json' || ext === 'yaml' || ext === 'yml' || ext === 'toml') return <FileJson2 className="h-4 w-4" aria-hidden />
  if (ext === 'md' || ext === 'txt' || ext === 'log') return <FileText className="h-4 w-4" aria-hidden />
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'sh', 'bash', 'css', 'html', 'sql'].includes(ext)) return <FileCode2 className="h-4 w-4" aria-hidden />
  return <File className="h-4 w-4" aria-hidden />
}

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp',
  }
  return map[ext.toLowerCase()] || 'image/png'
}

function extToLang(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python', '.go': 'go', '.rs': 'rust', '.sh': 'bash', '.bash': 'bash',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
    '.css': 'css', '.html': 'html', '.sql': 'sql', '.md': 'markdown',
  }
  return map[ext] || 'text'
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp']
const RENDERABLE_EXTENSIONS = [...IMAGE_EXTENSIONS, '.md', '.html']

function isRenderable(ext: string) {
  return RENDERABLE_EXTENSIONS.includes(ext.toLowerCase())
}

export default function FileManager({ onClose, onSendToChat }: {
  onClose: () => void
  onSendToChat: (content: string) => void
}) {
  const { theme, token } = useStore()
  const isDark = theme !== 'light'
  const [currentPath, setCurrentPath] = useState('/')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [viewFile, setViewFile] = useState<{ path: string; content: string; ext: string; size: number; url?: string } | null>(null)
  const [viewLoading, setViewLoading] = useState(false)
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview')

  const loadDir = useCallback(async (dirPath: string) => {
    setLoading(true)
    try {
      const data = await api(`/api/files?path=${encodeURIComponent(dirPath)}`)
      setEntries(data.entries || [])
      setCurrentPath(data.path || dirPath)
    } catch { setEntries([]) }
    setLoading(false)
  }, [])

  useEffect(() => { loadDir('/') }, [])

  // Esc to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const openEntry = async (entry: FileEntry) => {
    const newPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`
    if (entry.type === 'dir') {
      setViewFile(null)
      loadDir(newPath)
    } else {
      setViewLoading(true)
      try {
        const data = await api(`/api/files/read?path=${encodeURIComponent(newPath)}`)
        if (data.type === 'text') {
          setViewFile({ path: newPath, content: data.content, ext: data.ext, size: data.size })
          setViewMode(isRenderable(String(data.ext || '')) ? 'preview' : 'source')
        } else if (data.type === 'image') {
          setViewFile({ path: newPath, content: data.url || '', ext: data.ext || '', size: data.size, url: data.url })
          setViewMode('preview')
        }
      } catch { setViewFile(null) }
      setViewLoading(false)
    }
  }

  const goUp = () => {
    if (currentPath === '/') return
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/'
    setViewFile(null)
    loadDir(parent)
  }

  const breadcrumbs = currentPath.split('/').filter(Boolean)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-[1040px] h-[78vh] rounded-xl shadow-2xl shadow-black/40 overflow-hidden flex flex-col"
        style={{ background: isDark ? '#141820' : '#ffffff', border: `1px solid ${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}` }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)' }}>
          <div className="flex items-center gap-3 min-w-0">
            <FolderOpen className="h-5 w-5 flex-shrink-0 text-[var(--accent-primary)]" />
            <span className="text-[14px] font-semibold" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>文件浏览器</span>
            {/* Breadcrumb */}
            <div className="flex items-center gap-1 text-[12px] min-w-0" style={{ color: isDark ? '#6b7280' : '#94a3b8' }}>
              <button onClick={() => { setViewFile(null); loadDir('/') }} className="inline-flex items-center gap-1 hover:opacity-80 transition-colors"><Home className="h-3 w-3" />项目</button>
              {breadcrumbs.map((seg, i) => (
                <span key={i} className="flex items-center gap-1">
                  <span style={{ color: isDark ? '#374151' : '#d1d5db' }}>/</span>
                  <button onClick={() => { setViewFile(null); loadDir('/' + breadcrumbs.slice(0, i + 1).join('/')) }}
                    className="hover:opacity-80 transition-colors truncate max-w-[120px]">{seg}</button>
                </span>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {viewFile && (
              <button onClick={() => onSendToChat(`请查看文件 ${viewFile.path} 的内容:\n\`\`\`${extToLang(viewFile.ext)}\n${viewFile.content.slice(0, 2000)}\n\`\`\``)}
                className="h-7 px-3 text-[11px] bg-[var(--surface-active)] text-[var(--accent-primary)] rounded-lg hover:bg-[var(--accent-soft)] transition-colors border border-[var(--accent-border)] flex items-center gap-1.5">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                发送给 Claude
              </button>
            )}
            <button onClick={onClose} className="transition-colors p-1" style={{ color: isDark ? '#6b7280' : '#94a3b8' }}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 flex min-h-0">
          {/* File list */}
          <div className={`${viewFile ? 'w-[280px]' : 'flex-1'} overflow-y-auto`} style={{ borderRight: `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)'}` }}>
            {/* Go up */}
            {currentPath !== '/' && (
              <button onClick={goUp} className="w-full flex items-center gap-3 px-4 py-2 hover:bg-[var(--bg-card-hover)] transition-colors text-left" style={{ color: isDark ? '#6b7280' : '#94a3b8' }}>
                <ArrowLeft className="h-3.5 w-3.5" />
                <span className="text-[13px]">..</span>
              </button>
            )}
            {loading ? (
              <div className="text-center text-[13px] py-8" style={{ color: isDark ? '#6b7280' : '#94a3b8' }}>加载中...</div>
            ) : entries.length === 0 ? (
              <div className="text-center text-[13px] py-8" style={{ color: isDark ? '#6b7280' : '#94a3b8' }}>空目录</div>
            ) : entries.map(entry => (
              <button key={entry.name} onClick={() => openEntry(entry)}
                className={`w-full flex items-center gap-3 px-4 py-2 hover:bg-[var(--bg-card-hover)] transition-colors text-left ${
                  viewFile?.path?.endsWith('/' + entry.name) ? 'bg-[var(--surface-active)] border-l-2 border-[var(--accent-primary)]' : ''
                }`}>
                  <span className="flex-shrink-0 text-[var(--text-muted)]">{getFileIcon(entry.name, entry.type)}</span>
                <span className="text-[13px] truncate flex-1" style={{ color: isDark ? '#d1d5db' : '#374151' }}>{entry.name}</span>
                {entry.type === 'file' && entry.size !== null && (
                  <span className="text-[10px] flex-shrink-0" style={{ color: isDark ? '#374151' : '#9ca3af' }}>{formatSize(entry.size)}</span>
                )}
              </button>
            ))}
          </div>

          {/* File viewer */}
          {viewFile && (
            <div className="flex-1 flex flex-col min-w-0">
              <div className="flex items-center justify-between px-4 py-2 border-b" style={{ borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)', background: isDark ? '#0d1117' : '#f9fafb' }}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[var(--text-muted)]">{getFileIcon(viewFile.path.split('/').pop() || '', 'file')}</span>
                  <span className="text-[12px] truncate" style={{ color: isDark ? '#d1d5db' : '#374151' }}>{viewFile.path.split('/').pop()}</span>
                  <span className="text-[10px]" style={{ color: isDark ? '#374151' : '#9ca3af' }}>{formatSize(viewFile.size)}</span>
                </div>
                <div className="flex items-center gap-1">
                  {isRenderable(viewFile.ext) && (
                    <div className="flex items-center rounded-md border p-0.5" style={{ borderColor: isDark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)' }}>
                      <button type="button" onClick={() => setViewMode('preview')} className={`rounded px-2 py-1 text-[10px] ${viewMode === 'preview' ? 'bg-[var(--surface-active)] text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>预览</button>
                      <button type="button" onClick={() => setViewMode('source')} className={`rounded px-2 py-1 text-[10px] ${viewMode === 'source' ? 'bg-[var(--surface-active)] text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}><Code2 className="mr-1 inline h-3 w-3" />源代码</button>
                    </div>
                  )}
                  <button onClick={() => setViewFile(null)} className="transition-colors p-1" style={{ color: isDark ? '#6b7280' : '#94a3b8' }} aria-label="关闭预览"><X className="h-4 w-4" /></button>
                </div>
              </div>
              <div className="flex-1 overflow-auto" style={{ background: isDark ? '#0a0e14' : '#ffffff' }}>
                {viewLoading ? (
                  <div className="text-center text-[13px] py-8" style={{ color: isDark ? '#6b7280' : '#94a3b8' }}>加载中...</div>
                ) : (
                  viewFile.ext === '.md' && viewMode === 'preview' ? (
                    <div className="px-6 py-4 max-w-none" style={{ color: isDark ? '#e2e8f0' : '#1e293b', fontSize: '13px', lineHeight: '1.6' }}>
                      {viewFile.content
                        ? (() => {
                            try {
                              return <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} rehypePlugins={MARKDOWN_REHYPE_PLUGINS}>{viewFile.content}</ReactMarkdown>
                            } catch {
                              return <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{viewFile.content}</pre>
                            }
                          })()
                        : <span style={{ color: isDark ? '#6b7280' : '#9ca3af' }}>（文件内容为空）</span>
                      }
                    </div>
                  ) : viewFile.ext === '.html' && viewMode === 'preview' ? (
                    <iframe
                      title={viewFile.path.split('/').pop() || 'HTML 预览'}
                      sandbox="allow-scripts"
                      srcDoc={viewFile.content}
                      className="h-full min-h-[320px] w-full border-0 bg-white"
                    />
                  ) : viewFile.ext && IMAGE_EXTENSIONS.includes(viewFile.ext.toLowerCase()) && viewMode === 'preview' ? (
                    <div className="flex items-center justify-center p-4" style={{ minHeight: '200px' }}>
                      <img src={viewFile.ext.toLowerCase() === '.svg' && !viewFile.url
                        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(viewFile.content)}`
                        : `${viewFile.url || viewFile.content}${viewFile.url?.includes('?') ? '&' : '?'}token=${encodeURIComponent(token || '')}`}
                        alt={viewFile.path.split('/').pop()}
                        className="max-w-full max-h-full object-contain rounded-lg shadow-lg" />
                    </div>
                  ) : (
                    <pre className="px-4 py-3 text-[12px] font-mono leading-relaxed whitespace-pre" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>{viewFile.content}</pre>
                  )
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2 border-t flex items-center gap-4 text-[10px]" style={{ borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)', color: isDark ? '#374151' : '#9ca3af' }}>
          <span>{entries.length} 项</span>
          <span>点击文件预览 · 点击文件夹进入</span>
          <span className="flex items-center gap-1 ml-auto">
            <kbd className="px-1 py-0.5 rounded border" style={{ background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)', borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)' }}>Esc</kbd>
            关闭
          </span>
        </div>
      </div>
    </div>
  )
}
