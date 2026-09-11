import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Code2,
  Eye,
  FileText,
  FileType2,
  Loader2,
  PanelRightClose,
  Save,
  Search,
  TriangleAlert,
} from 'lucide-react'
import { api } from '../../store'
import { useEditorAvailability } from '../workspace/use-editor-availability'
import { EditorPane } from '../workspace/editor-pane'
import { MarkdownWysiwygEditor } from '../workspace/markdown-wysiwyg-editor'
import { CodeMirrorEditor, type CodeSkinKey } from '../workspace/code-mirror-editor'
import { fileIcon } from './project-files'

// =====================================================================
// RightWorkspacePanel — 极简模式右栏的常驻工作区面板 (VSCode / 原生文档编辑器)。
//
// 由 workbench-panes 统一调度 (rightPane === 'vscode' | 'editor'), 与工具抽屉 /
// 扩展浏览器面板互斥但都保持挂载。遵循右栏 CSS 契约:
//   根元素带 data-right-workspace-panel + data-open, 关闭态 display:none。
//
// VSCode: 复用专家模式 EditorPane (code-server iframe, 同源 /code-server/ 反代),
//   底部终端 / Problems 全部由 code-server 原生提供。
// 文档编辑器 (对标飞书文档的单人编辑体验):
//   - 左侧文件树 (复用 /api/projects/:id/files 列目录)
//   - Markdown (.md/.markdown) → tiptap WYSIWYG 所见即所得 + 源码双模式
//   - 代码/文 → CodeMirror (语法高亮, 与专家模式同一编辑器)
//   - 保存 POST /api/projects/:id/file (last-write-wins)
//   - 图片 / PDF / 音视频 / JSON / CSV 等附件 → 内置只读预览器
// =====================================================================

const RIGHT_PANEL_OPEN_EVENT = 'mobius:open-right-workspace'
const RIGHT_PANEL_CLOSE_EVENT = 'mobius:close-right-workspace'

type RightWorkspaceKind = 'vscode' | 'editor'

type FileContentState = {
  path: string
  content: string
  binary: boolean
  truncated: boolean
}

// 内置预览器支持的附件类型 (右栏只读呈现, 不做高阶编辑)。
const IMAGE_EXT = new Set(['apng', 'avif', 'bmp', 'gif', 'ico', 'jfif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
const AUDIO_EXT = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav'])
const VIDEO_EXT = new Set(['m4v', 'mkv', 'mov', 'mp4', 'webm'])
const PDF_EXT = new Set(['pdf'])
// 结构化文本: 用 CodeMirror 展示 (带语法高亮) 但不提供保存 (避免误改坏结构)。
const DATA_EXT = new Set(['csv', 'json', 'ndjson', 'jsonl'])

function extOf(path: string) {
  const clean = String(path || '').split(/[?#]/, 1)[0]
  return clean.includes('.') ? clean.split('.').pop()?.toLowerCase() || '' : ''
}

function isMarkdownPath(path: string) {
  const ext = extOf(path)
  return ext === 'md' || ext === 'markdown'
}

type PreviewKind = 'image' | 'audio' | 'video' | 'pdf' | 'data' | 'binary' | 'none'

function previewKindOf(path: string, binary: boolean): PreviewKind {
  const ext = extOf(path)
  if (IMAGE_EXT.has(ext)) return 'image'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (PDF_EXT.has(ext)) return 'pdf'
  if (DATA_EXT.has(ext)) return 'data'
  if (binary) return 'binary'
  return 'none'
}

function inlineDownloadUrl(projectId: string, path: string) {
  const query = new URLSearchParams({ path, inline: '1' })
  const token = typeof window !== 'undefined' ? localStorage.getItem('cc-token') : ''
  if (token) query.set('token', token)
  return `/api/projects/${encodeURIComponent(projectId)}/file/download?${query.toString()}`
}

// ── VSCode 面板 ──────────────────────────────────────────────────────────

function VscodePanel({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const { bindPath, vscodeWebUrl, loading } = useEditorAvailability(projectId, true)
  const projectName = useProjectName(projectId)

  return (
    <div
      className="right-workspace-panel"
      data-right-workspace-panel
      data-kind="vscode"
      data-open={open ? 'true' : 'false'}
      aria-hidden={!open}
      {...((!open ? { inert: '' } : {}) as any)}
    >
      <div className="right-workspace-panel__header">
        <Code2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <strong className="min-w-0 flex-1 truncate text-[12px]" title={projectName}>VSCode · {projectName}</strong>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent(RIGHT_PANEL_OPEN_EVENT, { detail: { kind: 'editor' } }))}
          className="workbench-icon-btn"
          aria-label="切换到文档编辑器"
          title="切换到文档编辑器"
          data-testid="switch-to-editor"
        >
          <FileText className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onClose} className="workbench-icon-btn" aria-label="收起 VSCode 面板" title="收起">
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="right-workspace-panel__body">
        {loading && !bindPath ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            <Loader2 className="h-4 w-4 animate-spin" />正在检查编辑器可用性…
          </div>
        ) : (
          <EditorPane projectName={projectName} bindPath={bindPath} vscodeWebUrl={vscodeWebUrl} />
        )}
      </div>
    </div>
  )
}

function useProjectName(projectId: string) {
  const [name, setName] = useState(projectId)
  useEffect(() => {
    let cancelled = false
    api(`/api/projects/${encodeURIComponent(projectId)}`)
      .then((data: any) => { if (!cancelled && data?.name) setName(String(data.name)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId])
  return name
}

// ── 文件树 (极简版: 列目录 + 过滤, 点击打开) ────────────────────────────────

type TreeEntry = { name: string; type: 'dir' | 'file'; size: number | null; modified: string; abs_path: string }

function DocFileTree({
  projectId,
  activePath,
  onOpenFile,
}: {
  projectId: string
  activePath: string
  onOpenFile: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [dirs, setDirs] = useState<Record<string, { loading: boolean; entries: TreeEntry[]; error?: string }>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['/']))
  const loadedRef = useRef<Set<string>>(new Set())

  const loadDir = useCallback(async (relPath: string) => {
    if (loadedRef.current.has(relPath)) return
    loadedRef.current.add(relPath)
    setDirs(previous => ({ ...previous, [relPath]: { loading: true, entries: [] } }))
    try {
      const data = await api(`/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(relPath)}`)
      setDirs(previous => ({ ...previous, [relPath]: { loading: false, entries: data?.entries || [] } }))
    } catch (error: any) {
      loadedRef.current.delete(relPath)
      setDirs(previous => ({ ...previous, [relPath]: { loading: false, entries: [], error: error?.message || '加载失败' } }))
    }
  }, [projectId])

  useEffect(() => {
    loadedRef.current = new Set()
    setDirs({})
    setExpanded(new Set(['/']))
    void loadDir('/')
  }, [loadDir, projectId])

  const toggleDir = (relPath: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(relPath)) next.delete(relPath)
      else {
        next.add(relPath)
        void loadDir(relPath)
      }
      return next
    })
  }

  const matchesQuery = (name: string) => !query || name.toLowerCase().includes(query.toLowerCase())

  const renderLevel = (relPath: string, depth: number): React.ReactNode => {
    const state = dirs[relPath]
    if (!state && relPath !== '/') return null
    const entries = state?.entries || []
    const visible = entries.filter(entry => matchesQuery(entry.name))
    return (
      <div role="group" data-dir={relPath}>
        {state?.loading && <div className="doc-file-tree__hint">加载中…</div>}
        {state?.error && <div className="doc-file-tree__hint" style={{ color: 'var(--status-danger)' }}>{state.error}</div>}
        {visible.map(entry => {
          const childRel = `${relPath === '/' ? '' : relPath}/${entry.name}`
          if (entry.type === 'dir') {
            const open = expanded.has(childRel)
            return (
              <div key={childRel}>
                <button
                  type="button"
                  className="doc-file-tree__row"
                  style={{ paddingLeft: 6 + depth * 12 }}
                  onClick={() => toggleDir(childRel)}
                  data-expanded={open ? 'true' : 'false'}
                >
                  <span className="doc-file-tree__caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                  <span className="doc-file-tree__name truncate">{entry.name}</span>
                </button>
                {open && renderLevel(childRel, depth + 1)}
              </div>
            )
          }
          return (
            <button
              key={childRel}
              type="button"
              className={`doc-file-tree__row doc-file-tree__row--file${activePath === childRel ? ' is-active' : ''}`}
              style={{ paddingLeft: 6 + depth * 12 }}
              onClick={() => onOpenFile(childRel)}
              title={childRel}
            >
              <span className="doc-file-tree__file-icon">{fileIcon(entry.name, entry.type)}</span>
              <span className="doc-file-tree__name truncate">{entry.name}</span>
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="doc-file-tree" data-doc-file-tree>
      <div className="doc-file-tree__search">
        <Search className="h-3 w-3 shrink-0" aria-hidden="true" />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="过滤文件"
          className="w-full bg-transparent text-[11px] outline-none"
          style={{ color: 'var(--text-primary)' }}
        />
      </div>
      <div className="doc-file-tree__scroll">{renderLevel('/', 0)}</div>
    </div>
  )
}

// ── 只读附件预览器 (图片/音频/视频/PDF/JSON/CSV) ────────────────────────────

function AttachmentPreview({ projectId, path }: { projectId: string; path: string }) {
  const kind = previewKindOf(path, false)
  const [dataText, setDataText] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const url = inlineDownloadUrl(projectId, path)
  const name = path.split('/').filter(Boolean).pop() || path

  useEffect(() => {
    if (kind !== 'data') return
    let cancelled = false
    setLoadError('')
    api(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`)
      .then((data: any) => { if (!cancelled) setDataText(String(data?.content || '')) })
      .catch((error: any) => { if (!cancelled) setLoadError(error?.message || '读取失败') })
    return () => { cancelled = true }
  }, [kind, projectId, path])

  if (kind === 'image') {
    return (
      <div className="attachment-preview attachment-preview--media">
        <img src={url} alt={name} loading="lazy" onError={event => { (event.target as HTMLImageElement).style.display = 'none' }} />
      </div>
    )
  }
  if (kind === 'audio') {
    return <div className="attachment-preview attachment-preview--media"><audio controls src={url} preload="metadata" /></div>
  }
  if (kind === 'video') {
    return <div className="attachment-preview attachment-preview--media"><video controls src={url} preload="metadata" /></div>
  }
  if (kind === 'pdf') {
    return <div className="attachment-preview attachment-preview--pdf"><iframe src={url} title={name} /></div>
  }
  if (kind === 'data') {
    if (loadError) return <div className="attachment-preview__error">{loadError}</div>
    if (dataText == null) return <div className="attachment-preview__hint">正在读取…</div>
    return (
      <div className="attachment-preview attachment-preview--data">
        <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-5">{dataText}</pre>
      </div>
    )
  }
  return (
    <div className="attachment-preview__hint">
      该文件为二进制格式，暂不支持在右栏预览。
      <a href={url} target="_blank" rel="noreferrer" className="ml-1 underline">下载查看</a>
    </div>
  )
}

// ── 文档编辑器面板 ────────────────────────────────────────────────────────

function DocPanel({
  projectId,
  path,
  onPathChange,
  onClose,
  open,
}: {
  projectId: string
  path: string
  onPathChange: (path: string) => void
  onClose: () => void
  open: boolean
}) {
  const [file, setFile] = useState<FileContentState | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [doc, setDoc] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveOk, setSaveOk] = useState(false)
  const [sourceMode, setSourceMode] = useState(false)
  const [treeOpen, setTreeOpen] = useState(true)
  const fileRef = useRef<FileContentState | null>(null)

  const isMarkdown = isMarkdownPath(path)
  const previewable = previewKindOf(path, file?.binary ?? false)
  const skin: CodeSkinKey = document.documentElement.classList.contains('light') ? 'light' : 'dark'

  // 读文件
  useEffect(() => {
    if (!path) { setFile(null); setDoc(''); setDirty(false); setError(''); return }
    let cancelled = false
    setLoading(true)
    setError('')
    setSaveError('')
    api(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`)
      .then((data: any) => {
        if (cancelled) return
        const next: FileContentState = {
          path,
          content: String(data?.content || ''),
          binary: !!data?.binary,
          truncated: !!data?.truncated,
        }
        fileRef.current = next
        setFile(next)
        setDoc(next.content)
        setDirty(false)
        setSourceMode(false)
      })
      .catch((reason: any) => { if (!cancelled) setError(reason?.message || '读取文件失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId, path])

  // 保存 (Cmd/Ctrl+S 或按钮)
  const save = useCallback(async (): Promise<boolean> => {
    if (!file || !dirty || saving) return false
    setSaving(true)
    setSaveError('')
    setSaveOk(false)
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/file`, {
        method: 'POST',
        body: JSON.stringify({ path, content: doc }),
      })
      setDirty(false)
      setSaveOk(true)
      fileRef.current = { ...file, content: doc }
      window.setTimeout(() => setSaveOk(false), 1500)
      return true
    } catch (reason: any) {
      setSaveError(reason?.message || '保存失败')
      return false
    } finally {
      setSaving(false)
    }
  }, [dirty, doc, file, path, projectId, saving])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void save()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save])

  const name = path.split('/').filter(Boolean).pop() || '未选择文件'

  const editorArea = useMemo(() => {
    if (!path || loading) {
      return (
        <div className="flex flex-1 items-center justify-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {loading ? (<><Loader2 className="h-4 w-4 animate-spin" />正在读取 {name}…</>) : (<><FileText className="h-5 w-5" />从左侧选择一个文件</>)}
        </div>
      )
    }
    if (error) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center" style={{ color: 'var(--status-danger)' }}>
          <TriangleAlert className="h-5 w-5" />
          <div className="text-[12px]">{error}</div>
          <button type="button" className="workbench-control-md border px-3 text-[11px]" onClick={() => onPathChange(path)}>重试</button>
        </div>
      )
    }
    if (!file) return null

    // 附件预览器: 非文本文件走只读呈现
    if (previewable === 'image' || previewable === 'audio' || previewable === 'video' || previewable === 'pdf') {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="px-2 py-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>只读预览 · {name}</div>
          <AttachmentPreview projectId={projectId} path={path} />
        </div>
      )
    }
    if (previewable === 'binary') {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="px-2 py-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>二进制文件 · {name}</div>
          <AttachmentPreview projectId={projectId} path={path} />
        </div>
      )
    }
    if (file.truncated) {
      return <div className="px-2 py-1 text-[10px]" style={{ color: 'var(--status-danger)' }}>文件超过 1.5MB，仅加载前段内容，保存会截断文件 — 请勿编辑。</div>
    }
    // JSON/CSV: 只读 CodeMirror (带高亮)
    if (previewable === 'data') {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="px-2 py-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>结构化数据 · 只读</div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <CodeMirrorEditor fileName={name} value={doc} skin={skin} onChange={() => {}} wrap />
          </div>
        </div>
      )
    }
    // Markdown: WYSIWYG ↔ 源码 双模式
    if (isMarkdown) {
      return sourceMode ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <CodeMirrorEditor fileName={name} value={doc} skin={skin} onChange={value => { setDoc(value); setDirty(value !== (fileRef.current?.content || '')) }} wrap />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <MarkdownWysiwygEditor value={doc} skin={skin} onChange={value => { setDoc(value); setDirty(value !== (fileRef.current?.content || '')) }} />
        </div>
      )
    }
    // 代码/纯文本: CodeMirror
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeMirrorEditor fileName={name} value={doc} skin={skin} onChange={value => { setDoc(value); setDirty(value !== (fileRef.current?.content || '')) }} />
      </div>
    )
  }, [path, loading, error, file, previewable, isMarkdown, sourceMode, doc, skin, name, projectId, onPathChange])

  return (
    <div
      className="right-workspace-panel"
      data-right-workspace-panel
      data-kind="editor"
      data-open={open ? 'true' : 'false'}
      aria-hidden={!open}
      {...((!open ? { inert: '' } : {}) as any)}
    >
      <div className="right-workspace-panel__header">
        <button
          type="button"
          className="workbench-icon-btn"
          onClick={() => setTreeOpen(value => !value)}
          aria-label={treeOpen ? '收起文件树' : '展开文件树'}
          title={treeOpen ? '收起文件树' : '展开文件树'}
        >
          <FileType2 className="h-3.5 w-3.5" />
        </button>
        <strong className="min-w-0 flex-1 truncate text-[12px]" title={path || '选择文件'}>{name}</strong>
        {isMarkdown && (
          <button
            type="button"
            className="workbench-icon-btn"
            onClick={() => setSourceMode(value => !value)}
            aria-pressed={sourceMode}
            title={sourceMode ? '切换到富文本' : '查看 Markdown 源码'}
          >
            {sourceMode ? <Eye className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
          </button>
        )}
        <button
          type="button"
          className="workbench-icon-btn"
          onClick={() => void save()}
          disabled={!dirty || saving}
          aria-label="保存"
          title="保存 ⌘S"
          data-save-state={saveOk ? 'ok' : saveError ? 'error' : dirty ? 'dirty' : 'clean'}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          className="workbench-icon-btn"
          onClick={() => window.dispatchEvent(new CustomEvent(RIGHT_PANEL_OPEN_EVENT, { detail: { kind: 'vscode' } }))}
          aria-label="切换到 VSCode 工作区"
          title="切换到 VSCode 工作区"
          data-testid="switch-to-vscode"
        >
          <Code2 className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="workbench-icon-btn" onClick={onClose} aria-label="收起编辑器面板" title="收起">
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      </div>
      {(saveError || saveOk) && (
        <div className="right-workspace-panel__notice" role="status" data-tone={saveError ? 'error' : 'ok'}>
          {saveError || '已保存'}
        </div>
      )}
      <div className="right-workspace-panel__body right-workspace-panel__body--editor" data-tree-open={treeOpen ? 'true' : 'false'}>
        {treeOpen && (
          <div className="right-workspace-panel__tree">
            <DocFileTree projectId={projectId} activePath={path} onOpenFile={onPathChange} />
          </div>
        )}
        <div className="right-workspace-panel__editor">{editorArea}</div>
      </div>
    </div>
  )
}

// ── 容器: workbench-panes 调度 ────────────────────────────────────────────

export function RightWorkspacePanel({
  kind,
  projectId,
  editorPath,
  onEditorPathChange,
  open,
  onClose,
}: {
  kind: RightWorkspaceKind
  projectId: string
  editorPath: string
  onEditorPathChange: (path: string) => void
  open: boolean
  onClose: () => void
}) {
  if (kind === 'vscode') {
    return <VscodePanel projectId={projectId} open={open} onClose={onClose} />
  }
  return <DocPanel projectId={projectId} path={editorPath} onPathChange={onEditorPathChange} onClose={onClose} open={open} />
}

export { RIGHT_PANEL_OPEN_EVENT, RIGHT_PANEL_CLOSE_EVENT }
