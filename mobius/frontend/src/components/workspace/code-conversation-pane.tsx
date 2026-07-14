import { useState, useEffect, useCallback, useMemo } from 'react'
import { FileCode2, Loader2, AlertTriangle, ExternalLink } from 'lucide-react'
import { api } from '../../store'
import { ResizablePanel } from '../resizable-panel'
import { FileTreeLevel, fileIcon, formatSize, buildVscodeUrl, type Entry, type DirState } from '../project-files'

// =====================================================================
// CodeConversationPane - 代码对话模式 v2 的主体 (左文件浏览器 + 中代码浏览).
// 右侧 AI 对话 (ChatArea) 由 IssuePage 渲染, 本组件只负责左+中两栏.
//
// 与 v1 (editor-chat: 左 code-server iframe + 右对话) 的区别:
//   v2 用原生文件树 + 原生只读代码预览, 不嵌 iframe, 更轻量、更像 Cursor.
//   文件树复用 ProjectFilesCard 的 FileTreeLevel 视觉 + /api/projects/:id/files API;
//   代码内容走新增的 /api/projects/:id/file?path=<rel> 端点 (只读, ≤1.5MB, 二进制不返内容).
//
// 本组件根用 className="contents", 让内部 [文件浏览器 ResizablePanel] + [代码浏览 flex-1]
// 直接成为 IssuePage flex row 的成员, 与右侧 ChatArea 平级 -> 三栏布局.
// =====================================================================
type CodeConversationPaneProps = {
  projectId: string
  bindPath: string
  vscodeWebUrl?: string
}

type FileContent = {
  path: string
  name: string
  abs_path: string
  size: number
  content: string
  truncated: boolean
  binary: boolean
}

export function CodeConversationPane({ projectId, bindPath, vscodeWebUrl }: CodeConversationPaneProps) {
  // ----- 文件树状态 (复用 ProjectFilesCard 的 loadDir/toggleDir 逻辑) -----
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']))
  const [rootLoaded, setRootLoaded] = useState(false)
  const [rootError, setRootError] = useState('')

  const loadDir = useCallback(async (relPath: string) => {
    setDirs(prev => ({ ...prev, [relPath]: { ...prev[relPath], loading: true, error: undefined } }))
    try {
      const data = await api(`/api/projects/${projectId}/files?path=${encodeURIComponent(relPath)}`)
      if (relPath === '/') {
        setRootLoaded(true)
        if (!data.bind_path) setRootError('项目未绑定路径')
      }
      setDirs(prev => ({ ...prev, [relPath]: { loading: false, entries: data.entries || [] } }))
    } catch (e: any) {
      setDirs(prev => ({ ...prev, [relPath]: { loading: false, error: e?.message || '加载失败' } }))
      if (relPath === '/') { setRootLoaded(true); setRootError(e?.message || '加载失败') }
    }
  }, [projectId])

  useEffect(() => { loadDir('/') }, [loadDir])

  const toggleDir = (relPath: string) => {
    const next = new Set(expanded)
    if (next.has(relPath)) next.delete(relPath)
    else { next.add(relPath); if (!dirs[relPath]) loadDir(relPath) }
    setExpanded(next)
  }

  // ----- 代码浏览状态 -----
  const [selected, setSelected] = useState<Entry | null>(null)
  const [fileData, setFileData] = useState<FileContent | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState('')

  const onSelectFile = useCallback(async (entry: Entry) => {
    if (entry.type !== 'file') return
    setSelected(entry)
    setFileError('')
    setFileLoading(true)
    setFileData(null)
    try {
      // entry.abs_path 是绝对路径; 后端 resolveProjectPath 以 bind_path 为根, 传 relPath.
      // 这里用 abs_path 相对 bindPath 算 relPath, 避免后端 path 解析歧义.
      const rel = relPathUnderBind(entry.abs_path, bindPath)
      const data = await api(`/api/projects/${projectId}/file?path=${encodeURIComponent(rel)}`)
      setFileData(data as FileContent)
    } catch (e: any) {
      setFileError(e?.message || '读取文件失败')
    } finally {
      setFileLoading(false)
    }
  }, [projectId, bindPath])

  const openInVscode = () => {
    if (!vscodeWebUrl || !bindPath || !selected) return
    const url = buildVscodeUrl(vscodeWebUrl, bindPath, selected.abs_path)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  // 文件浏览器默认宽度 ≈ 视口 18%, 留够空间给代码浏览 + 对话.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const filesDefaultWidth = Math.max(180, Math.min(320, Math.floor(vw * 0.18)))

  return (
    <div className="contents">
      {/* ===== 左: 文件浏览器 ===== */}
      <ResizablePanel
        storageKey={`mobius:ui:split:cc-files:${projectId}`}
        defaultWidth={filesDefaultWidth}
        minWidth={160}
        maxWidth={360}
        side="left"
        className="border-r flex flex-col"
        style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
        <div className="flex h-8 flex-shrink-0 items-center gap-1.5 border-b px-2.5" style={{ borderColor: 'var(--border-color)' }}>
          <FileCode2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
          <span className="truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }} title={bindPath}>文件浏览器</span>
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 py-1.5">
          {!rootLoaded ? (
            <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          ) : rootError ? (
            <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>{rootError}</div>
          ) : (
            <FileTreeLevel
              relPath="/"
              depth={0}
              dirs={dirs}
              expanded={expanded}
              onToggleDir={toggleDir}
              onOpenFile={onSelectFile}
              vscodeReady={true}
              selectedAbsPath={selected?.abs_path}
              fileActionLabel="预览文件"
            />
          )}
        </div>
      </ResizablePanel>

      {/* ===== 中: 代码浏览 (只读) ===== */}
      <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-primary)' }}>
        <div className="flex h-8 flex-shrink-0 items-center gap-1.5 border-b px-2.5" style={{ borderColor: 'var(--border-color)' }}>
          {selected ? (
            <>
              <span className="flex-shrink-0 text-[13px]">{fileIcon(selected.name, 'file')}</span>
              <span className="truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }} title={selected.abs_path}>{selected.name}</span>
              {fileData && (
                <span className="flex-shrink-0 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {formatSize(fileData.size)}{fileData.truncated ? ' · 已截断' : ''}
                </span>
              )}
              <div className="flex-1" />
              {vscodeWebUrl && (
                <button type="button" onClick={openInVscode} title="在 VSCode 中编辑"
                  className="inline-flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              )}
            </>
          ) : (
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>代码浏览</span>
          )}
        </div>

        <div className="relative flex-1 min-h-0 overflow-auto">
          {!selected ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" style={{ color: 'var(--text-muted)' }}>
              <FileCode2 className="w-8 h-8" />
              <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>从左侧选择一个文件预览</div>
              <div className="text-[11px]">只读预览，如需编辑请在 VSCode 中打开</div>
            </div>
          ) : fileLoading ? (
            <div className="flex h-full flex-col items-center justify-center gap-2" style={{ color: 'var(--text-muted)' }}>
              <Loader2 className="w-5 h-5 animate-spin" />
              <div className="text-[12px]">正在读取文件…</div>
            </div>
          ) : fileError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" style={{ color: 'var(--text-muted)' }}>
              <AlertTriangle className="w-6 h-6 text-amber-400" />
              <div className="text-[12px] text-red-400">{fileError}</div>
            </div>
          ) : fileData?.binary ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" style={{ color: 'var(--text-muted)' }}>
              <AlertTriangle className="w-6 h-6 text-amber-400" />
              <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>二进制文件，不提供预览</div>
              <div className="text-[11px]">{formatSize(fileData.size)}</div>
            </div>
          ) : fileData ? (
            <CodeView content={fileData.content} />
          ) : null}
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// CodeView - 纯文本只读代码预览 (行号 + 等宽). MVP 不做语法高亮, 后续可接
// highlight.js (rehype-highlight 已带该依赖). 截断/超长行靠容器滚动.
// =====================================================================
function CodeView({ content }: { content: string }) {
  const lines = useMemo(() => content.split('\n'), [content])
  return (
    <div className="flex min-h-full w-full text-[12px] leading-[1.55]" style={{ fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)' }}>
      {/* 行号列 */}
      <div className="flex-shrink-0 select-none border-r px-2 py-2 text-right" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)', background: 'var(--bg-secondary)' }}>
        {lines.map((_, i) => (
          <div key={i} className="tabular-nums">{i + 1}</div>
        ))}
      </div>
      {/* 代码列 */}
      <pre className="flex-1 overflow-x-auto px-3 py-2" style={{ color: 'var(--text-primary)', whiteSpace: 'pre' }}>
        {content}
      </pre>
    </div>
  )
}

// abs_path 是绝对路径, 后端 resolveProjectPath 以 bind_path 为根做 path.resolve.
// 为避免不同平台 path.resolve 歧义, 这里把 abs_path 转成相对 bindPath 的 posix 路径再传.
function relPathUnderBind(absPath: string, bindPath: string): string {
  const root = bindPath.replace(/\/+$/, '')
  if (absPath === root) return '/'
  if (absPath.startsWith(root + '/')) return '/' + absPath.slice(root.length + 1).replace(/\\/g, '/')
  // 兜底: 直接传 abs_path, 后端 resolveProjectPath 会校验是否落在 bind_path 子树.
  return absPath.replace(/\\/g, '/')
}
