import { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { FileCode2, Loader2, AlertTriangle, ExternalLink, Save, Search, X, Sun, Moon, Laptop, Server, FolderOpen, Download, Copy, ClipboardPaste, Pencil, Link, FolderTree } from 'lucide-react'
import { api } from '../../store'
import { ResizablePanel } from '../resizable-panel'
import { FileTreeLevel, fileIcon, formatSize, buildVscodeUrl, type Entry, type DirState } from '../project-files'
import { FileTreeContextMenu, type ContextMenuItem } from './file-tree-context-menu'
import { InlineRenameInput } from './inline-rename-input'
import { HubProjectFileSource, LocalProjectFileSource, type ProjectFileSource, type DesktopFileBridge } from './project-file-source'
import {
  type FileTreeTarget,
  type FileClipboardItem,
  type FileOperationErrorCode,
  FileOperationError,
  targetDirForPaste,
  canPaste,
  errorCodeToMessage,
  isNameValidClient,
  migrateExpandedPaths,
} from './file-tree-ops'
import { copyTextToClipboard } from '../../utils/clipboard'
import type { CodeSkinKey } from './code-mirror-editor'

const LazyCodeMirrorEditor = lazy(() => import('./code-mirror-editor').then(module => ({ default: module.CodeMirrorEditor })))

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

type FileSource = 'hub' | 'local'

type DesktopBridge = {
  isDesktop?: boolean
  pickDirectory?: () => Promise<string | null>
  confirmProjectPath?: (projectId: string, path: string) => Promise<{ ok?: boolean; error?: string } | null>
  getProjectLocalPath?: (projectId: string) => Promise<string | null>
  listProjectLocalFiles?: (projectId: string, path: string) => Promise<{ ok?: boolean; error?: string; code?: string; bind_path?: string; entries?: Entry[] }>
  readProjectLocalFile?: (projectId: string, path: string) => Promise<({ ok?: boolean; error?: string } & Partial<FileContent>)>
  writeProjectLocalFile?: (projectId: string, path: string, content: string) => Promise<{ ok?: boolean; error?: string; saved?: boolean; size?: number }>
  // 右键菜单本机操作 (preload 已暴露)
  downloadProjectLocalFile?: (projectId: string, path: string) => Promise<{ ok?: boolean; error?: string; code?: string; savedTo?: string }>
  copyProjectLocalEntry?: (projectId: string, sourcePath: string, targetDir: string) => Promise<{ ok?: boolean; error?: string; code?: string; path?: string; type?: string }>
  renameProjectLocalEntry?: (projectId: string, path: string, newName: string) => Promise<{ ok?: boolean; error?: string; code?: string; oldPath?: string; path?: string; name?: string }>
}

function getDesktopBridge(): DesktopBridge | undefined {
  return typeof window !== 'undefined'
    ? (window as { mobiusDesktop?: DesktopBridge }).mobiusDesktop
    : undefined
}

function fileSourceStorageKey(projectId: string) {
  return `mobius:ui:cc-file-source:${projectId}`
}

function loadFileSource(projectId: string): FileSource {
  if (!getDesktopBridge()?.isDesktop) return 'hub'
  try {
    return localStorage.getItem(fileSourceStorageKey(projectId)) === 'local' ? 'local' : 'hub'
  } catch {
    return 'hub'
  }
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

// 中栏 (含头部工具栏) 的两套固定配色 — 与对应 CodeMirror 主题背景严格匹配, 独立于全局主题.
// dark 取 oneDark 背景的前景色族; light 取白底深字. 这样头部工具栏与编辑区视觉一体.
const main_text_color_dark = '#c9c9c9'
const CODE_SKINS: Record<CodeSkinKey, { bg: string; fg: string; muted: string; border: string; accent: string; hover: string }> = {
  dark: { bg: '#121419', fg: main_text_color_dark, muted: '#7d8799', border: '#1f222a', accent: main_text_color_dark, hover: 'hover:bg-white/10' },
  light: { bg: '#ffffff', fg: '#2c2c2c', muted: '#9a9a9a', border: '#e6e6e6', accent: '#2563eb', hover: 'hover:bg-black/5' },
}
const CODE_SKIN_STORAGE_KEY = 'mobius:ui:code-editor-skin'
function loadCodeSkin(): CodeSkinKey {
  try {
    const v = localStorage.getItem(CODE_SKIN_STORAGE_KEY)
    return v === 'light' ? 'light' : 'dark'
  } catch { return 'dark' }
}

export function CodeConversationPane({ projectId, bindPath, vscodeWebUrl }: CodeConversationPaneProps) {
  const desktop = getDesktopBridge()
  const isDesktop = !!desktop?.isDesktop
  const [source, setSourceState] = useState<FileSource>(() => loadFileSource(projectId))
  const [localBindPath, setLocalBindPath] = useState('')
  const [localPathBusy, setLocalPathBusy] = useState(false)

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
  // ----- 文件树状态 (复用 ProjectFilesCard 的 loadDir/toggleDir 逻辑) -----
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']))
  const [rootLoaded, setRootLoaded] = useState(false)
  const [rootError, setRootError] = useState('')
  const [filter, setFilter] = useState('')

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

  // ----- 右键菜单 / 文件操作状态 (设计文档 §9) -----
  // writable: 数据源是否可写 (hub 用 bind_path_writable; local 默认 true, 写权限由主进程 W_OK 兜底)。
  const [writable, setWritable] = useState(true)
  const [menu, setMenu] = useState<{ x: number; y: number; target: FileTreeTarget | null } | null>(null)
  // 应用内文件剪贴板 (页面生命周期内有效, 不写 localStorage; 切换项目/数据源清空)。
  const [clipboard, setClipboard] = useState<FileClipboardItem | null>(null)
  const [rename, setRename] = useState<{ target: FileTreeTarget; submitting?: boolean; error?: string } | null>(null)
  // 正在粘贴的目录集合, 同一目录禁止并发粘贴 (设计文档 §15)。
  const [pastingDirs, setPastingDirs] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'error' } | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  const loadDir = useCallback(async (relPath: string) => {
    setDirs(prev => ({ ...prev, [relPath]: { ...prev[relPath], loading: true, error: undefined } }))
    try {
      const data = source === 'local'
        ? await desktop?.listProjectLocalFiles?.(projectId, relPath)
        : await api(`/api/projects/${projectId}/files?path=${encodeURIComponent(relPath)}`)
      if (source === 'local' && !data?.ok) throw new Error(data?.error || '加载本机文件失败')
      if (relPath === '/') {
        setRootLoaded(true)
        if (source === 'local') {
          setLocalBindPath(data?.bind_path || '')
          // 本机数据源默认可写 (主进程 IPC 用 W_OK 兜底真实权限)。
          setWritable(!!data?.bind_path)
          if (!data?.bind_path) setRootError('未绑定本机工作路径')
        } else {
          // 中枢: 用后端返回的 bind_path_writable 决定粘贴/重命名是否可用。
          setWritable(!!data?.bind_path_writable)
          if (!data.bind_path) setRootError('项目未绑定路径')
        }
      }
      setDirs(prev => ({ ...prev, [relPath]: { loading: false, entries: data.entries || [] } }))
    } catch (e: any) {
      setDirs(prev => ({ ...prev, [relPath]: { loading: false, error: e?.message || '加载失败' } }))
      if (relPath === '/') { setRootLoaded(true); setRootError(e?.message || '加载失败') }
    }
  }, [desktop, projectId, source])

  useEffect(() => {
    let cancelled = false
    if (!isDesktop) { setSourceState('hub'); setLocalBindPath(''); return }
    desktop?.getProjectLocalPath?.(projectId)
      .then(path => { if (!cancelled) setLocalBindPath(path || '') })
      .catch(() => { if (!cancelled) setLocalBindPath('') })
    return () => { cancelled = true }
  }, [desktop, isDesktop, projectId])

  const clearEditorState = useCallback(() => {
    setSelected(null)
    setFileData(null)
    setFileLoading(false)
    setFileError('')
    setDoc('')
    setDirty(false)
    setSaving(false)
    setSaveError('')
    setSaveOk(false)
  }, [])

  useEffect(() => {
    setDirs({})
    setExpanded(new Set(['/']))
    setRootLoaded(false)
    setRootError('')
    setFilter('')
    clearEditorState()
    loadDir('/')
  }, [loadDir, clearEditorState])

  const toggleDir = (relPath: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else { next.add(relPath); if (!dirs[relPath]) loadDir(relPath) }
      return next
    })
  }

  const chooseSource = useCallback((next: FileSource) => {
    if (next === source) return
    if (next === 'local' && !isDesktop) return
    if (dirty && selected) {
      if (!window.confirm(`「${selected.name}」有未保存的修改，切换文件来源将丢弃。确定切换？`)) return
    }
    setSourceState(next)
    try { localStorage.setItem(fileSourceStorageKey(projectId), next) } catch { /* 静默 */ }
  }, [dirty, isDesktop, projectId, selected, source])

  const chooseLocalPath = useCallback(async () => {
    if (!desktop?.pickDirectory || !desktop.confirmProjectPath) return
    const picked = await desktop.pickDirectory()
    if (!picked) return
    setLocalPathBusy(true)
    setRootError('')
    try {
      const result = await desktop.confirmProjectPath(projectId, picked)
      if (!result?.ok) throw new Error(result?.error || '绑定本机路径失败')
      setLocalBindPath(picked)
      if (source === 'local') {
        setDirs({})
        setExpanded(new Set(['/']))
        setRootLoaded(false)
        clearEditorState()
        loadDir('/')
      }
    } catch (e: any) {
      setRootError(e?.message || '绑定本机路径失败')
    } finally {
      setLocalPathBusy(false)
    }
  }, [clearEditorState, desktop, loadDir, projectId, source])

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
      const root = source === 'local' ? localBindPath : bindPath
      const rel = relPathUnderBind(entry.abs_path, root)
      const data = source === 'local'
        ? await desktop?.readProjectLocalFile?.(projectId, rel)
        : await api(`/api/projects/${projectId}/file?path=${encodeURIComponent(rel)}`)
      if (source === 'local' && !data?.ok) throw new Error(data?.error || '读取本机文件失败')
      setFileData(data as FileContent)
      setDoc((data as FileContent).content || '')
    } catch (e: any) {
      setFileError(e?.message || '读取文件失败')
    } finally {
      setFileLoading(false)
    }
  }, [desktop, projectId, bindPath, localBindPath, source, dirty, selected])

  // 保存: 写回磁盘, 复位 dirty. 返回是否保存成功 (供重命名前确认使用)。
  const save = useCallback(async (): Promise<boolean> => {
    if (!selected || !fileData || !dirty || saving) return false
    setSaving(true)
    setSaveError('')
    setSaveOk(false)
    try {
      const root = source === 'local' ? localBindPath : bindPath
      const rel = relPathUnderBind(selected.abs_path, root)
      if (source === 'local') {
        const result = await desktop?.writeProjectLocalFile?.(projectId, rel, doc)
        if (!result?.ok) throw new Error(result?.error || '保存本机文件失败')
      } else {
        await api(`/api/projects/${projectId}/file`, {
          method: 'POST',
          body: JSON.stringify({ path: rel, content: doc }),
        })
      }
      setDirty(false)
      setSaveOk(true)
      setFileData(fd => fd ? { ...fd, content: doc, size: new Blob([doc]).size } : fd)
      window.setTimeout(() => setSaveOk(false), 1500)
      return true
    } catch (e: any) {
      setSaveError(e?.message || '保存失败')
      return false
    } finally {
      setSaving(false)
    }
  }, [desktop, selected, fileData, dirty, saving, projectId, bindPath, localBindPath, source, doc])

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
    if (source !== 'hub' || !vscodeWebUrl || !bindPath || !selected) return
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

  // ===== 右键菜单数据源 (统一 hub REST / local IPC, 设计文档 §10) =====
  const fileSource = useMemo<ProjectFileSource>(() => {
    const root = source === 'local' ? localBindPath : bindPath
    if (source === 'local' && desktop && desktop.copyProjectLocalEntry && desktop.downloadProjectLocalFile && desktop.renameProjectLocalEntry) {
      return new LocalProjectFileSource(projectId, root, writable, desktop as DesktopFileBridge)
    }
    return new HubProjectFileSource(projectId, root, writable)
  }, [source, localBindPath, bindPath, writable, projectId, desktop])

  const showToast = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    setToast({ text, kind })
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), kind === 'error' ? 5000 : 2400)
  }, [])
  useEffect(() => () => { if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current) }, [])

  // 异常归一成 { code, msg }。CANCELLED 静默 (保存对话框取消等)。
  function opErrorMessage(e: unknown): { code?: FileOperationErrorCode; msg: string } {
    if (e instanceof FileOperationError) return { code: e.code, msg: e.message || errorCodeToMessage(e.code) }
    return { msg: (e as Error)?.message || '操作失败' }
  }

  // 局部刷新某目录 (复用 loadDir, 保留 expanded/选中/滚动)。
  const refreshDir = useCallback(async (relPath: string) => { await loadDir(relPath) }, [loadDir])

  // 切换项目/数据源立即清空菜单/重命名/内部剪贴板 (设计文档 §9)。
  useEffect(() => {
    setMenu(null); setRename(null); setClipboard(null); setPastingDirs(new Set())
  }, [projectId, source])

  async function onCopyRel(target: FileTreeTarget) {
    const ok = await copyTextToClipboard(target.relPath)
    showToast(ok ? '已复制相对路径' : '浏览器未允许访问剪贴板，请手动复制', ok ? 'info' : 'error')
  }
  async function onCopyAbs(target: FileTreeTarget) {
    const ok = await copyTextToClipboard(target.entry.abs_path)
    const label = source === 'local' ? '本机' : '中枢'
    showToast(ok ? `已复制${label}绝对路径` : '浏览器未允许访问剪贴板，请手动复制', ok ? 'info' : 'error')
  }
  function onCopy(target: FileTreeTarget) {
    setClipboard({ projectId, source, relPath: target.relPath, type: target.entry.type, name: target.entry.name })
    showToast(`已复制「${target.entry.name}」，请选择目标目录粘贴`)
  }
  async function onDownload(target: FileTreeTarget) {
    // 大文件预警 (>100MB), 设计文档 §8.1/§15。
    const size = target.entry.size
    if (size !== null && size > 100 * 1024 * 1024) {
      if (!window.confirm(`文件较大（${formatSize(size)}），确认下载？`)) return
    }
    showToast(`正在下载「${target.entry.name}」`)
    try {
      await fileSource.downloadFile(target.relPath)
    } catch (e) {
      const { code, msg } = opErrorMessage(e)
      if (code === 'CANCELLED') return
      showToast(msg, 'error')
      if (code === 'NOT_FOUND') refreshDir(target.parentRelPath)
    }
  }
  async function onPaste(target: FileTreeTarget | null) {
    if (!clipboard) return
    const targetDir = targetDirForPaste(target)
    if (pastingDirs.has(targetDir)) return // 同一目录禁止并发粘贴
    setPastingDirs(prev => new Set(prev).add(targetDir))
    try {
      const res = await fileSource.copyEntry(clipboard.relPath, targetDir)
      await refreshDir(targetDir)
      showToast(`已复制到「${res.path || targetDir}」`)
    } catch (e) {
      const { code, msg } = opErrorMessage(e)
      if (code !== 'CANCELLED') showToast(msg, 'error')
      if (code === 'NOT_FOUND') refreshDir(targetDir)
      // 失败不清空剪贴板, 允许修正目标后重试 (设计文档 §9)。
    } finally {
      setPastingDirs(prev => { const n = new Set(prev); n.delete(targetDir); return n })
    }
  }
  function onStartRename(target: FileTreeTarget) {
    setRename({ target })
  }
  async function onSubmitRename(newNameRaw: string) {
    const target = rename?.target
    if (!target) return
    const newName = newNameRaw.trim()
    if (!isNameValidClient(newName)) { setRename(r => (r ? { ...r, error: '名称不合法' } : r)); return }
    if (newName === target.entry.name) { setRename(null); return }
    // 重命名当前编辑文件且有未保存改动: 先保存; 保存失败则中止 (设计文档 §18.3)。
    if (dirty && selected && selected.abs_path === target.entry.abs_path) {
      const saved = await save()
      if (!saved) {
        setRename(r => (r ? { ...r, submitting: false, error: '保存未完成，已取消重命名' } : r))
        showToast('保存未完成，已取消重命名', 'error')
        return
      }
    }
    setRename(r => (r ? { ...r, submitting: true, error: undefined } : r))
    try {
      const res = await fileSource.renameEntry(target.relPath, newName)
      await applyRename(target, res)
      setRename(null)
      showToast(`已重命名为「${res.name}」`)
    } catch (e) {
      const { code, msg } = opErrorMessage(e)
      if (code === 'CANCELLED') { setRename(null); return }
      setRename(r => (r ? { ...r, submitting: false, error: msg } : r))
      showToast(msg, 'error')
      if (code === 'NOT_FOUND') refreshDir(target.parentRelPath)
    }
  }
  // 重命名成功后同步状态: 刷新父目录; 目录迁移 expanded/dirs 缓存; 当前编辑文件更新路径 (保留撤销栈)。
  async function applyRename(target: FileTreeTarget, res: { path: string; name: string }) {
    const oldRel = target.relPath
    const newRel = res.path
    const isDir = target.entry.type === 'dir'
    await refreshDir(target.parentRelPath)
    if (isDir) {
      setExpanded(prev => migrateExpandedPaths(prev, oldRel, newRel))
      setDirs(prev => {
        const next: Record<string, DirState> = {}
        for (const [k, v] of Object.entries(prev)) {
          if (k === oldRel) next[newRel] = v
          else if (k.startsWith(oldRel + '/')) next[newRel + k.slice(oldRel.length)] = v
          else next[k] = v
        }
        return next
      })
    }
    // 当前编辑文件是被重命名节点本身, 或位于被重命名目录子树内 -> 迁移编辑器路径 (CodeMirror 文档不重建, 保留撤销栈)。
    if (selected) {
      const oldAbs = target.entry.abs_path
      const under = selected.abs_path === oldAbs
        || selected.abs_path.startsWith(oldAbs + '/')
        || selected.abs_path.startsWith(oldAbs + '\\')
      if (under) {
        const sepIdx = Math.max(oldAbs.lastIndexOf('/'), oldAbs.lastIndexOf('\\'))
        const nodeNewAbs = sepIdx >= 0 ? oldAbs.slice(0, sepIdx + 1) + res.name : res.name
        const suffix = selected.abs_path.slice(oldAbs.length) // '' (节点自身) 或 '/子路径'
        const newSelAbs = nodeNewAbs + suffix
        const isSelf = suffix === '' || suffix === '/'
        setSelected(s => (s ? { ...s, name: isSelf ? res.name : s.name, abs_path: newSelAbs } : s))
        setFileData(fd => {
          if (!fd) return fd
          const underRel = fd.path === oldRel || fd.path.startsWith(oldRel + '/')
          const newFdRel = underRel ? (fd.path === oldRel ? newRel : newRel + fd.path.slice(oldRel.length)) : fd.path
          return { ...fd, name: isSelf ? res.name : fd.name, path: newFdRel, abs_path: newSelAbs }
        })
      }
    }
  }

  // 内联重命名渲染器 (传给 FileTreeLevel)。
  const renderRenameInput = (target: FileTreeTarget) => (
    <InlineRenameInput
      defaultName={target.entry.name}
      submitting={rename?.target?.relPath === target.relPath ? rename.submitting : undefined}
      error={rename?.target?.relPath === target.relPath ? rename.error : undefined}
      onSubmit={(v: string) => onSubmitRename(v)}
      onCancel={() => setRename(null)}
    />
  )

  // 构建右键菜单项 (设计文档 §5.1, §5.3)。target=null 为根目录空白区域, 仅显示"粘贴"。
  function buildMenuItems(target: FileTreeTarget | null): ContextMenuItem[] {
    const iconCls = 'w-3.5 h-3.5 flex-shrink-0'
    if (!target) {
      const paste = canPaste(clipboard, null, projectId, source, writable)
      return [{
        type: 'item', key: 'paste', label: '粘贴', icon: <ClipboardPaste className={iconCls} />,
        disabled: !paste.ok || pastingDirs.has('/'),
        disabledReason: !paste.ok ? paste.reason : (pastingDirs.has('/') ? '正在粘贴…' : undefined),
        onRun: () => onPaste(null),
      }]
    }
    const type = target.entry.type
    const paste = canPaste(clipboard, target, projectId, source, writable)
    const targetDir = targetDirForPaste(target)
    return [
      { type: 'item', key: 'download', label: '下载', icon: <Download className={iconCls} />,
        disabled: type === 'dir', disabledReason: type === 'dir' ? '目录打包下载将在后续版本支持' : undefined,
        onRun: () => onDownload(target) },
      { type: 'separator' },
      { type: 'item', key: 'copy', label: '复制', icon: <Copy className={iconCls} />, onRun: () => onCopy(target) },
      { type: 'item', key: 'paste', label: '粘贴', icon: <ClipboardPaste className={iconCls} />,
        disabled: !paste.ok || pastingDirs.has(targetDir),
        disabledReason: !paste.ok ? paste.reason : (pastingDirs.has(targetDir) ? '正在粘贴…' : undefined),
        onRun: () => onPaste(target) },
      { type: 'separator' },
      { type: 'item', key: 'copyRel', label: '复制相对路径', icon: <Link className={iconCls} />, onRun: () => onCopyRel(target) },
      { type: 'item', key: 'copyAbs', label: '复制绝对路径', icon: <FolderTree className={iconCls} />, onRun: () => onCopyAbs(target) },
      { type: 'separator' },
      { type: 'item', key: 'rename', label: '重命名', icon: <Pencil className={iconCls} />,
        disabled: !writable, disabledReason: !writable ? '只读数据源' : undefined,
        onRun: () => onStartRename(target) },
    ]
  }

  function openTreeContextMenu(e: React.MouseEvent, target: FileTreeTarget | null) {
    // 节点右键阻止冒泡, 根空白区域在此打开 (target=null)。
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, target })
  }

  // 文件浏览器默认宽度 ≈ 视口 18%, 留够空间给代码编辑 + 对话.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const filesDefaultWidth = Math.max(180, Math.min(320, Math.floor(vw * 0.18)))
  const activeRootPath = source === 'local' ? localBindPath : bindPath

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
          <span className="truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }} title={activeRootPath}>
            {source === 'local' ? '本机文件' : '中枢文件'}
          </span>
        </div>
        {isDesktop && (
          <div className="flex-shrink-0 border-b px-2 py-1.5" style={{ borderColor: 'var(--border-color)' }}>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => chooseSource('hub')}
                className="inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded-md border px-1.5 text-[11px] transition-colors"
                style={{
                  borderColor: source === 'hub' ? 'var(--accent-primary)' : 'var(--input-border)',
                  background: source === 'hub' ? 'color-mix(in srgb, var(--accent-primary) 14%, transparent)' : 'var(--input-bg)',
                  color: source === 'hub' ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
                title="浏览 Mobius 中枢项目路径"
              >
                <Server className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">中枢</span>
              </button>
              <button
                type="button"
                onClick={() => chooseSource('local')}
                className="inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded-md border px-1.5 text-[11px] transition-colors"
                style={{
                  borderColor: source === 'local' ? 'var(--accent-primary)' : 'var(--input-border)',
                  background: source === 'local' ? 'color-mix(in srgb, var(--accent-primary) 14%, transparent)' : 'var(--input-bg)',
                  color: source === 'local' ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
                title="浏览这台电脑绑定的本机工作路径"
              >
                <Laptop className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">本机</span>
              </button>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <div className="min-w-0 flex-1 truncate font-mono text-[10px]" style={{ color: 'var(--text-muted)' }} title={activeRootPath || undefined}>
                {activeRootPath || (source === 'local' ? '未绑定本机工作路径' : '未绑定项目路径')}
              </div>
              {source === 'local' && (
                <button
                  type="button"
                  onClick={chooseLocalPath}
                  disabled={localPathBusy}
                  className="inline-flex h-6 flex-shrink-0 items-center gap-1 rounded-md border px-1.5 text-[10px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-50"
                  style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}
                  title={localBindPath ? '更改本机绑定路径' : '选择本机绑定路径'}
                >
                  {localPathBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
                  {localBindPath ? '更改' : '选择'}
                </button>
              )}
            </div>
          </div>
        )}
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
        <div
          className="flex-1 overflow-y-auto px-1.5 py-1.5"
          onContextMenu={(e) => openTreeContextMenu(e, null)}
        >
          {!rootLoaded ? (
            <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          ) : rootError ? (
            <div className="px-2 py-4 text-center">
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{rootError}</div>
              {source === 'local' && isDesktop && (
                <button
                  type="button"
                  onClick={chooseLocalPath}
                  disabled={localPathBusy}
                  className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-50"
                  style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}
                >
                  {localPathBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
                  选择本机路径
                </button>
              )}
            </div>
          ) : (
            <FilteredFileTree
              dirs={dirs}
              expanded={expanded}
              onToggleDir={toggleDir}
              onSelectFile={onSelectFile}
              selectedAbsPath={selected?.abs_path}
              filter={filter}
              onContextMenu={(e, target) => openTreeContextMenu(e, target)}
              renamingRelPath={rename?.target.relPath}
              renderRenameInput={renderRenameInput}
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
              {source === 'hub' && vscodeWebUrl && (
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
            <Suspense
              fallback={(
                <div className="flex h-full flex-col items-center justify-center gap-2" style={{ color: cc.muted }}>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <div className="text-[12px]">代码编辑器按需加载中…</div>
                </div>
              )}
            >
              <LazyCodeMirrorEditor
                fileName={selected?.name || ''}
                value={doc}
                skin={skin}
                onChange={onChange}
              />
            </Suspense>
          ) : null}
        </div>
      </div>

      {/* ===== 右键菜单浮层 (定位/键盘/关闭由组件自理) ===== */}
      {menu && (
        <FileTreeContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.target)}
          onClose={() => setMenu(null)}
        />
      )}

      {/* ===== 操作 Toast (设计文档 §7.4, §16) ===== */}
      {toast && (
        <div
          className="mobius-file-toast"
          role="status"
          aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
          style={{
            position: 'fixed',
            bottom: '24px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 55,
            padding: '8px 16px',
            borderRadius: '8px',
            fontSize: '12px',
            color: '#fff',
            background: toast.kind === 'error' ? 'rgba(239, 68, 68, 0.95)' : 'rgba(16, 185, 129, 0.95)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            maxWidth: '80vw',
            pointerEvents: 'none',
          }}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}

// =====================================================================
// FilteredFileTree - 文件名过滤包装. 无 filter 直接渲染 FileTreeLevel;
// 有 filter 时把已加载目录里命中过滤的文件扁平展示 (带相对路径前缀).
// 注意: 过滤只覆盖已加载进 dirs 的目录 (懒加载, 未展开过的目录不参与),
// 避免递归拉全树打爆大仓库; 用户先展开感兴趣的目录再过滤.
// =====================================================================
function FilteredFileTree({ dirs, expanded, onToggleDir, onSelectFile, selectedAbsPath, filter, onContextMenu, renamingRelPath, renderRenameInput }: {
  dirs: Record<string, DirState>
  expanded: Set<string>
  onToggleDir: (relPath: string) => void
  onSelectFile: (entry: Entry) => void
  selectedAbsPath?: string
  filter: string
  onContextMenu?: (event: React.MouseEvent, target: FileTreeTarget) => void
  renamingRelPath?: string
  renderRenameInput?: (target: FileTreeTarget) => React.ReactNode
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
        onContextMenu={onContextMenu}
        renamingRelPath={renamingRelPath}
        renderRenameInput={renderRenameInput}
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
