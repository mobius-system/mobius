import { useState, useEffect, useCallback, useMemo } from 'react'
import { FileCode2, Loader2, AlertTriangle, ExternalLink, Save, Search, X, Sun, Moon } from 'lucide-react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import type { Extension } from '@codemirror/state'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { syntaxHighlighting } from '@codemirror/language'
import { api } from '../../store'
import { ResizablePanel } from '../resizable-panel'
import { FileTreeLevel, fileIcon, formatSize, buildVscodeUrl, type Entry, type DirState } from '../project-files'

// =====================================================================
// CodeConversationPane - 代码对话模式 v2 的主体 (左文件浏览器 + 中代码编辑器).
// 右侧 AI 对话 (ChatArea) 由 IssuePage 渲染, 本组件只负责左+中两栏.
//
// 与 v1 (editor-chat: 左 code-server iframe + 右对话) 的区别:
//   v2 用原生文件树 + CodeMirror 嵌入式编辑器 (高亮+编辑+搜索+撤销+括号匹配),
//   轻量、更像 Cursor. 文件树复用 ProjectFilesCard 的 FileTreeLevel;
//   读 /api/projects/:id/file, 保存 POST /api/projects/:id/file.
//
// ★ 代码编辑区明暗独立于全局主题: 只用 CodeMirror 自带两套标准主题
//   (dark=oneDark / light=默认), 背景与高亮配套, 不跟随 var(--bg-*),
//   避免为每种全局主题适配代码配色的麻烦. 由中栏右上角按钮独立切换, localStorage 持久化.
//
// 根 className="contents", 让内部 [文件浏览器 ResizablePanel] + [代码编辑器 flex-1]
// 直接成为 IssuePage flex row 成员, 与右侧 ChatArea 平级 -> 三栏布局.
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

type CodeSkinKey = 'dark' | 'light'
// 中栏 (含头部工具栏) 的两套固定配色 — 与对应 CodeMirror 主题背景严格匹配, 独立于全局主题.
// dark 取 oneDark 背景的前景色族; light 取白底深字. 这样头部工具栏与编辑区视觉一体.
const CODE_SKINS: Record<CodeSkinKey, { bg: string; fg: string; muted: string; border: string; accent: string; hover: string }> = {
  dark: { bg: '#121419', fg: '#9ea1ff', muted: '#7d8799', border: '#1f222a', accent: '#9ea1ff', hover: 'hover:bg-white/10' },
  light: { bg: '#ffffff', fg: '#2c2c2c', muted: '#9a9a9a', border: '#e6e6e6', accent: '#2563eb', hover: 'hover:bg-black/5' },
}
const CODE_SKIN_STORAGE_KEY = 'mobius:ui:code-editor-skin'
function loadCodeSkin(): CodeSkinKey {
  try {
    const v = localStorage.getItem(CODE_SKIN_STORAGE_KEY)
    return v === 'light' ? 'light' : 'dark'
  } catch { return 'dark' }
}

// light 模式的编辑器主题: 背景与 cc.bg(#ffffff) 严格匹配, 语法高亮由 basicSetup 的
// defaultHighlightStyle (深色 token, 为白底设计) 提供. 与 oneDark (dark 模式) 对称.
const lightEditorTheme = EditorView.theme({
  '&': { backgroundColor: '#ffffff', color: '#2c2c2c', height: '100%' },
  '.cm-gutters': { backgroundColor: '#ffffff', color: '#9a9a9a', border: 'none', borderRight: '1px solid #e6e6e6' },
  '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,0.04)' },
  '.cm-activeLineGutter': { backgroundColor: '#ffffff', color: '#2c2c2c' },
  '.cm-selectionBackground': { backgroundColor: 'rgba(37,99,235,0.2)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(37,99,235,0.2)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-foldPlaceholder': { backgroundColor: '#f0f0f0', border: '1px solid #e6e6e6', color: '#9a9a9a' },
})

// dark 模式的背景/前景覆盖层: oneDark 提供语法 token 配色 (深色背景专用, 好看),
// 本覆盖层把编辑器/gutter 的背景与默认前景改成用户指定值 (#121419 / #9ea1ff / #7d8799),
// token 高亮仍由 oneDark 提供. 必须放在 oneDark 之后 (extensions 末尾) 才能覆盖.
const darkSkinOverride = EditorView.theme({
  '&': { backgroundColor: '#121419', color: '#9ea1ff' },
  '.cm-gutters': { backgroundColor: '#121419', color: '#7d8799', border: 'none' },
  '.cm-activeLine': { backgroundColor: '#ffffff08' },
  '.cm-activeLineGutter': { backgroundColor: '#121419', color: '#9ea1ff' },
  '.cm-content': { caretColor: '#9ea1ff' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#9ea1ff' },
  '.cm-selectionBackground': { backgroundColor: '#3a3d5a' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: '#3a3d5a' },
  '.cm-foldPlaceholder': { backgroundColor: '#1a1c22', border: '1px solid #2a2d3e', color: '#7d8799' },
  '.cm-panels': { backgroundColor: '#121419', color: '#9ea1ff' },
  '.cm-tooltip': { backgroundColor: '#1f222a', color: '#9ea1ff' },
}, { dark: true })

// 按扩展名映射到语言加载键. 命中即按需动态导入对应 CodeMirror 语言包 (含 @lezer 文法),
// 未命中走纯文本. 语言包体积大 (尤其 @lezer/javascript / markdown), 若静态全量打入会让
// code-conversation chunk 超 600kB; 改为打开某类型文件时才加载该语言, 各语言独立成小 chunk.
function langKeyForFile(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'js'
  if (['ts', 'tsx'].includes(ext)) return 'ts'
  if (ext === 'py') return 'py'
  if (['md', 'markdown'].includes(ext)) return 'md'
  if (ext === 'json') return 'json'
  if (['css', 'scss', 'less'].includes(ext)) return 'css'
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) return 'html'
  if (ext === 'sql') return 'sql'
  return null
}

// 各语言的动态加载器: import() 让 Rollup 把每个语言包 (+ 其 @lezer 文法) 切成独立 lazy chunk,
// 只有真正打开该类型文件时才下载. js/ts 共享 @codemirror/lang-javascript (同 chunk).
const LANG_LOADERS: Record<string, () => Promise<Extension>> = {
  js: () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true })),
  ts: () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true, typescript: true })),
  py: () => import('@codemirror/lang-python').then(m => m.python()),
  md: () => import('@codemirror/lang-markdown').then(m => m.markdown()),
  json: () => import('@codemirror/lang-json').then(m => m.json()),
  css: () => import('@codemirror/lang-css').then(m => m.css()),
  html: () => import('@codemirror/lang-html').then(m => m.html()),
  sql: () => import('@codemirror/lang-sql').then(m => m.sql()),
}

export function CodeConversationPane({ projectId, bindPath, vscodeWebUrl }: CodeConversationPaneProps) {
  // ★ 代码区明暗: 独立于全局主题, 自带持久化.
  const [skin, setSkin] = useState<CodeSkinKey>(() => loadCodeSkin())
  const toggleSkin = useCallback(() => {
    setSkin(prev => {
      const next = prev === 'dark' ? 'light' : 'dark'
      try { localStorage.setItem(CODE_SKIN_STORAGE_KEY, next) } catch { /* 静默 */ }
      return next
    })
  }, [])
  const cc = CODE_SKINS[skin]
  // dark: theme='none' (不注入 @uiw 默认主题), 改由 extensions 里的 [oneDark, darkSkinOverride] 组合 —
  //       oneDark 出 token 高亮, darkSkinOverride 在其后覆盖背景/前景为用户指定 #121419/#9ea1ff.
  // light: theme=lightEditorTheme (背景 #fff).
  const cmTheme: 'none' | typeof lightEditorTheme = skin === 'dark' ? 'none' : lightEditorTheme

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

  // 当前文件的语言扩展 (按需动态加载). 加载完成前为 null (纯文本无高亮), 到货后自动应用.
  // 切换文件时 cleanup 置 cancelled, 避免旧文件的迟到加载覆盖新选择.
  const [langExt, setLangExt] = useState<Extension | null>(null)
  useEffect(() => {
    const key = selected ? langKeyForFile(selected.name) : null
    if (!key) { setLangExt(null); return }
    let cancelled = false
    LANG_LOADERS[key]()
      .then(ext => { if (!cancelled) setLangExt(ext) })
      .catch(() => { if (!cancelled) setLangExt(null) })
    return () => { cancelled = true }
  }, [selected])

  // extensions: basicSetup 默认提供行号/高亮/撤销/括号/折叠/搜索/补全等; 这里补 indentWithTab + 换行 + 语言包.
  // dark 模式额外追加 oneDark(token 高亮) + darkSkinOverride(覆盖背景/前景为 #121419/#9ea1ff, 必须在 oneDark 后).
  const extensions = useMemo(() => {
    const base = [
      keymap.of([indentWithTab]),
      EditorView.lineWrapping,
      ...(langExt ? [langExt] : []),
    ]
    // dark: darkSkinOverride 独占背景/前景/gutter (#121419/#9ea1ff/#7d8799), 不用 oneDark 主题
    // (它自带 #282c34 背景会竞争覆盖); token 高亮用 oneDarkHighlightStyle (syntaxHighlighting 包一层).
    return skin === 'dark' ? [...base, darkSkinOverride, syntaxHighlighting(oneDarkHighlightStyle)] : base
  }, [langExt, skin])

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

      {/* ===== 中: 代码编辑器 (明暗独立于全局主题, 用 cc 固定配色) ===== */}
      <div className="flex min-w-0 flex-1 flex-col" style={{ background: cc.bg, color: cc.fg }}>
        {/* 头部工具栏 */}
        <div className="flex h-8 flex-shrink-0 items-center gap-1.5 border-b px-2.5" style={{ borderColor: cc.border }}>
          {selected ? (
            <>
              {dirty && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: cc.accent }} title="已修改未保存" />}
              <span className="flex-shrink-0 text-[13px]">{fileIcon(selected.name, 'file')}</span>
              <span className="truncate text-[12px] font-medium" style={{ color: cc.fg }} title={selected.abs_path}>{selected.name}</span>
              {fileData && (
                <span className="flex-shrink-0 text-[10px]" style={{ color: cc.muted }}>
                  {formatSize(fileData.size)}{fileData.truncated ? ' · 截断' : ''}
                </span>
              )}
              <div className="flex-1" />
              {saveOk && <span className="flex-shrink-0 text-[10px] text-emerald-400">已保存</span>}
              {saveError && <span className="flex-shrink-0 text-[10px] text-red-400" title={saveError}>保存失败</span>}
              {fileData && !fileData.binary && !fileData.truncated && (
                <button type="button" onClick={save} disabled={!dirty || saving} title="保存 (Ctrl+S)"
                  className={`inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${cc.hover}`}
                  style={{ color: dirty ? cc.accent : cc.muted }}>
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  保存
                </button>
              )}
              {/* ★ 代码区独立明暗切换 (不随全局主题) */}
              <button type="button" onClick={toggleSkin} title={skin === 'dark' ? '切换为浅色代码区' : '切换为深色代码区'}
                className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors ${cc.hover}`}
                style={{ color: cc.muted }}>
                {skin === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              </button>
              {vscodeWebUrl && (
                <button type="button" onClick={openInVscode} title="在 VSCode 中打开"
                  className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors ${cc.hover}`}
                  style={{ color: cc.muted }}>
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              )}
            </>
          ) : (
            <span className="text-[12px]" style={{ color: cc.muted }}>代码浏览</span>
          )}
        </div>

        {/* 编辑器/占位区 */}
        <div className="relative flex-1 min-h-0 overflow-hidden" style={{ background: cc.bg }}>
          {!selected ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" style={{ color: cc.muted }}>
              <FileCode2 className="w-8 h-8" />
              <div className="text-[13px]" style={{ color: cc.fg }}>从左侧选择一个文件</div>
              <div className="text-[11px]">语法高亮 + 可编辑，Ctrl+S 保存</div>
            </div>
          ) : fileLoading ? (
            <div className="flex h-full flex-col items-center justify-center gap-2" style={{ color: cc.muted }}>
              <Loader2 className="w-5 h-5 animate-spin" />
              <div className="text-[12px]">正在读取文件…</div>
            </div>
          ) : fileError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" style={{ color: cc.muted }}>
              <AlertTriangle className="w-6 h-6 text-amber-400" />
              <div className="text-[12px] text-red-400">{fileError}</div>
            </div>
          ) : fileData?.binary ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" style={{ color: cc.muted }}>
              <AlertTriangle className="w-6 h-6 text-amber-400" />
              <div className="text-[13px]" style={{ color: cc.fg }}>二进制文件，不提供预览</div>
              <div className="text-[11px]">{formatSize(fileData.size)}</div>
            </div>
          ) : fileData?.truncated ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" style={{ color: cc.muted }}>
              <AlertTriangle className="w-6 h-6 text-amber-400" />
              <div className="text-[13px]" style={{ color: cc.fg }}>文件过大（&gt; 1.5MB），已截断不提供编辑</div>
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
