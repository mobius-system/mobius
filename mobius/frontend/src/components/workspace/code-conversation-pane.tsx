import { useState, useEffect, useCallback, useMemo } from 'react'
import { FileCode2, Loader2, AlertTriangle, ExternalLink, Save, Search, X } from 'lucide-react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { api, useStore } from '../../store'
import { ResizablePanel } from '../resizable-panel'
import { FileTreeLevel, fileIcon, formatSize, buildVscodeUrl, type Entry, type DirState } from '../project-files'

// =====================================================================
// CodeConversationPane - 代码对话模式 v2 的主体 (左文件浏览器 + 中代码浏览/编辑).
// 右侧 AI 对话 (ChatArea) 由 IssuePage 渲染, 本组件只负责左+中两栏.
//
// 与 v1 (editor-chat: 左 code-server iframe + 右对话) 的区别:
//   v2 用原生文件树 + CodeMirror 嵌入式编辑器 (高亮+编辑+搜索+撤销+括号匹配),
//   不嵌 iframe, 轻量、更像 Cursor. 文件树复用 ProjectFilesCard 的 FileTreeLevel;
//   读 /api/projects/:id/file, 保存 POST /api/projects/:id/file.
//
// 根 className="contents", 让内部 [文件浏览器 ResizablePanel] + [代码编辑器 flex-1]
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

// 按扩展名选 CodeMirror 语言包. 命中即给高亮 + 语言感知 (括号/注释/缩进); 未命中走纯文本.
function languageForFile(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return javascript({ jsx: true })
  if (['ts', 'tsx'].includes(ext)) return javascript({ jsx: true, typescript: true })
  if (ext === 'py') return python()
  if (['md', 'markdown'].includes(ext)) return markdown()
  if (ext === 'json') return json()
  if (['css', 'scss', 'less'].includes(ext)) return css()
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) return html()
  if (ext === 'sql') return sql()
  return undefined
}

export function CodeConversationPane({ projectId, bindPath, vscodeWebUrl }: CodeConversationPaneProps) {
  const theme = useStore(s => s.theme)
  // ----- 文件树状态 (复用 ProjectFilesCard 的 loadDir/toggleDir 逻辑) -----
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']))
  const [rootLoaded, setRootLoaded] = useState(false)
  const [rootError, setRootError] = useState('')
  const [filter, setFilter] = useState('')

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
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else { next.add(relPath); if (!dirs[relPath]) loadDir(relPath) }
      return next
    })
  }

  // ----- 代码浏览/编辑状态 -----
  const [selected, setSelected] = useState<Entry | null>(null)
  const [fileData, setFileData] = useState<FileContent | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState('')
  // 编辑: doc = 编辑器当前内容; dirty = doc 与磁盘 content 不一致. 保存成功复位 dirty.
  const [doc, setDoc] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveOk, setSaveOk] = useState(false)

  const onSelectFile = useCallback(async (entry: Entry) => {
    if (entry.type !== 'file') return
    // 切换前若有未保存改动, 提示确认 (避免静默丢失编辑).
    if (dirty && selected && selected.abs_path !== entry.abs_path) {
      if (!window.confirm(`「${selected.name}」有未保存的修改，切换文件将丢弃。确定切换？`)) return
    }
    setSelected(entry)
    setFileError('')
    setFileLoading(true)
    setFileData(null)
    setDirty(false)
    setDoc('')
    setSaveError('')
    setSaveOk(false)
    try {
      const rel = relPathUnderBind(entry.abs_path, bindPath)
      const data = await api(`/api/projects/${projectId}/file?path=${encodeURIComponent(rel)}`)
      setFileData(data as FileContent)
      setDoc((data as FileContent).content || '')
    } catch (e: any) {
      setFileError(e?.message || '读取文件失败')
    } finally {
      setFileLoading(false)
    }
  }, [projectId, bindPath, dirty, selected])

  // 保存: 写回磁盘, 复位 dirty.
  const save = useCallback(async () => {
    if (!selected || !fileData || !dirty || saving) return
    setSaving(true)
    setSaveError('')
    setSaveOk(false)
    try {
      const rel = relPathUnderBind(selected.abs_path, bindPath)
      await api(`/api/projects/${projectId}/file`, {
        method: 'POST',
        body: JSON.stringify({ path: rel, content: doc }),
      })
      setDirty(false)
      setSaveOk(true)
      setFileData(fd => fd ? { ...fd, content: doc, size: new Blob([doc]).size } : fd)
      window.setTimeout(() => setSaveOk(false), 1500)
    } catch (e: any) {
      setSaveError(e?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }, [selected, fileData, dirty, saving, projectId, bindPath, doc])

  // Ctrl/Cmd+S 拦截: 触发保存, 阻止浏览器默认另存对话框.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        e.stopPropagation()
        if (dirty && !saving) save()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dirty, saving, save])

  const openInVscode = () => {
    if (!vscodeWebUrl || !bindPath || !selected) return
    const url = buildVscodeUrl(vscodeWebUrl, bindPath, selected.abs_path)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  // 离开页面 (关闭/路由切换) 时若有未保存改动, 浏览器原生提示.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const onChange = useCallback((val: string) => {
    setDoc(val)
    setDirty(val !== (fileData?.content || ''))
    setSaveOk(false)
  }, [fileData])

  // 文件浏览器默认宽度 ≈ 视口 18%, 留够空间给代码编辑 + 对话.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const filesDefaultWidth = Math.max(180, Math.min(320, Math.floor(vw * 0.18)))

  // CodeMirror 主题: dark -> oneDark (自带高质量深色); light -> CodeMirror 默认浅色.
  const cmTheme = theme === 'dark' ? oneDark : 'light'
  // extensions 只加 basicSetup 默认不含的 (indentWithTab) + 换行 + 语言高亮.
  // 其余 (行号/当前行高亮/括号匹配/自动闭合/折叠/搜索/撤销/补全/多光标) 全由 basicSetup 默认提供.
  const extensions = useMemo(() => {
    const lang = selected ? languageForFile(selected.name) : undefined
    return [
      keymap.of([indentWithTab]),
      EditorView.lineWrapping,
      ...(lang ? [lang] : []),
    ]
  }, [selected])

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
        {/* 文件名搜索过滤 (仅覆盖已展开加载过的目录) */}
        <div className="flex-shrink-0 border-b px-2 py-1.5" style={{ borderColor: 'var(--border-color)' }}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="过滤文件名…"
              className="h-7 w-full rounded-md border pl-7 pr-6 text-[12px] focus:outline-none"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}
            />
            {filter && (
              <button type="button" onClick={() => setFilter('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 py-1.5">
          {!rootLoaded ? (
            <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          ) : rootError ? (
            <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>{rootError}</div>
          ) : (
            <FilteredFileTree
              dirs={dirs}
              expanded={expanded}
              onToggleDir={toggleDir}
              onSelectFile={onSelectFile}
              selectedAbsPath={selected?.abs_path}
              filter={filter}
            />
          )}
        </div>
      </ResizablePanel>

      {/* ===== 中: 代码浏览/编辑 ===== */}
      <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-primary)' }}>
        <div className="flex h-8 flex-shrink-0 items-center gap-1.5 border-b px-2.5" style={{ borderColor: 'var(--border-color)' }}>
          {selected ? (
            <>
              {dirty && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: 'var(--accent-primary)' }} title="已修改未保存" />}
              <span className="flex-shrink-0 text-[13px]">{fileIcon(selected.name, 'file')}</span>
              <span className="truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }} title={selected.abs_path}>{selected.name}</span>
              {fileData && (
                <span className="flex-shrink-0 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {formatSize(fileData.size)}{fileData.truncated ? ' · 截断' : ''}
                </span>
              )}
              <div className="flex-1" />
              {saveOk && <span className="flex-shrink-0 text-[10px] text-emerald-400">已保存</span>}
              {saveError && <span className="flex-shrink-0 text-[10px] text-red-400" title={saveError}>保存失败</span>}
              {fileData && !fileData.binary && !fileData.truncated && (
                <button type="button" onClick={save} disabled={!dirty || saving} title="保存 (Ctrl+S)"
                  className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ color: dirty ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  保存
                </button>
              )}
              {vscodeWebUrl && (
                <button type="button" onClick={openInVscode} title="在 VSCode 中打开"
                  className="inline-flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              )}
            </>
          ) : (
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>代码浏览</span>
          )}
        </div>

        <div className="relative flex-1 min-h-0 overflow-hidden">
          {!selected ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" style={{ color: 'var(--text-muted)' }}>
              <FileCode2 className="w-8 h-8" />
              <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>从左侧选择一个文件</div>
              <div className="text-[11px]">语法高亮 + 可编辑，Ctrl+S 保存</div>
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
          ) : fileData?.truncated ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" style={{ color: 'var(--text-muted)' }}>
              <AlertTriangle className="w-6 h-6 text-amber-400" />
              <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>文件过大（&gt; 1.5MB），已截断不提供编辑</div>
              <div className="text-[11px]">如需编辑请在 VSCode 中打开</div>
            </div>
          ) : fileData ? (
            <CodeMirror
              value={doc}
              onChange={onChange}
              theme={cmTheme}
              extensions={extensions}
              height="100%"
              style={{ height: '100%', fontSize: '12.5px' }}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// FilteredFileTree - 文件名过滤包装. 无 filter 直接渲染 FileTreeLevel;
// 有 filter 时把已加载目录里命中过滤的文件扁平展示 (带相对路径前缀).
// 注意: 过滤只覆盖已加载进 dirs 的目录 (懒加载, 未展开过的目录不参与),
// 避免递归拉全树打爆大仓库; 用户先展开感兴趣的目录再过滤.
// =====================================================================
function FilteredFileTree({ dirs, expanded, onToggleDir, onSelectFile, selectedAbsPath, filter }: {
  dirs: Record<string, DirState>
  expanded: Set<string>
  onToggleDir: (relPath: string) => void
  onSelectFile: (entry: Entry) => void
  selectedAbsPath?: string
  filter: string
}) {
  const q = filter.trim().toLowerCase()
  if (!q) {
    return (
      <FileTreeLevel
        relPath="/"
        depth={0}
        dirs={dirs}
        expanded={expanded}
        onToggleDir={onToggleDir}
        onOpenFile={onSelectFile}
        vscodeReady={true}
        selectedAbsPath={selectedAbsPath}
        fileActionLabel="预览/编辑文件"
      />
    )
  }
  // 收集所有已加载目录里命中过滤的文件, 扁平展示 (带相对路径).
  const hits: Entry[] = []
  for (const [relPath, state] of Object.entries(dirs)) {
    if (!state.entries) continue
    for (const e of state.entries) {
      if (e.type === 'file' && e.name.toLowerCase().includes(q)) {
        hits.push({ ...e, name: `${relPath === '/' ? '' : relPath}/${e.name}`.replace(/^\//, '') })
      }
    }
  }
  hits.sort((a, b) => a.name.localeCompare(b.name))
  if (hits.length === 0) {
    return <div className="text-[11px] py-3 text-center" style={{ color: 'var(--text-muted)' }}>无匹配文件</div>
  }
  return (
    <div>
      {hits.slice(0, 200).map((e, i) => {
        const sel = selectedAbsPath === e.abs_path
        return (
          <button
            key={`${e.abs_path}-${i}`}
            type="button"
            onClick={() => onSelectFile(e)}
            title={e.abs_path}
            className={`w-full text-left flex items-center gap-1.5 px-2 py-1 rounded transition-colors text-[12px] ${sel ? '' : 'hover:bg-[var(--bg-card-hover)]'}`}
            style={{ paddingLeft: '8px', color: 'var(--text-primary)', background: sel ? 'color-mix(in srgb, var(--accent-primary) 16%, transparent)' : undefined }}>
            <span className="flex-shrink-0">{fileIcon(e.name, 'file')}</span>
            <span className="truncate flex-1">{e.name}</span>
          </button>
        )
      })}
      {hits.length > 200 && <div className="text-[10px] py-1 text-center" style={{ color: 'var(--text-muted)' }}>仅显示前 200 个，请细化过滤…</div>}
    </div>
  )
}

// abs_path 是绝对路径, 后端 resolveProjectPath 以 bind_path 为根做 path.resolve.
// 为避免不同平台 path.resolve 歧义, 这里把 abs_path 转成相对 bindPath 的 posix 路径再传.
function relPathUnderBind(absPath: string, bindPath: string): string {
  const root = bindPath.replace(/\/+$/, '')
  if (absPath === root) return '/'
  if (absPath.startsWith(root + '/')) return '/' + absPath.slice(root.length + 1).replace(/\\/g, '/')
  return absPath.replace(/\\/g, '/')
}
