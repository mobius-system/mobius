import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { Cable, ExternalLink, FilePlus2, FolderPlus, Loader2, MonitorUp, Play, RefreshCw } from 'lucide-react'
import { api, HIDDEN_FOLDER_NAME } from '../store'
import { AdvancedInteractionBtn } from './advanced-interaction-btn'

// =====================================================================
// ProjectFilesCard — 浏览项目 bind_path 下的文件树.
// IssuePage 右侧 SessionOverview 下方的卡片, 文件点击 → 新窗口打开 VSCode Web.
// VSCode Web URL 由后端 (config VSCODE_WEB_URL) 决定, 未配置则文件不可点击.
// =====================================================================
type Entry = {
  name: string
  type: 'dir' | 'file'
  size: number | null
  modified: string
  abs_path: string
}

export type { Entry }

// 右键菜单目标节点 (设计文档 §4.1)。relPath 以 / 开头相对项目根。
// 定义在此处以避免 project-files <-> file-tree-ops 循环依赖。
export type FileTreeTarget = {
  entry: Entry
  relPath: string
  parentRelPath: string
}

type CreateKind = 'file' | 'dir'

type FileTreeContextMenuState = {
  x: number
  y: number
  dirRelPath: string
  label: string
}

type FileTreeCreateDialogState = {
  kind: CreateKind
  dirRelPath: string
  name: string
  error: string
  loading: boolean
}

type DirState = {
  loading?: boolean
  error?: string
  entries?: Entry[]
}

export type { DirState }

function formatSize(n: number | null) {
  if (n === null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export { formatSize }

export function fileIcon(name: string, type: 'dir' | 'file') {
  if (type === 'dir') return '📁'
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const m: Record<string, string> = {
    ts: '🔷', tsx: '🔷', js: '🟡', jsx: '🟡', py: '🐍', go: '🔵', rs: '🦀',
    md: '📝', json: '📋', yaml: '📋', yml: '📋', toml: '📋',
    sh: '⚙️', bash: '⚙️', css: '🎨', html: '🌐', sql: '🗄️',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
    txt: '📄', log: '📄',
  }
  return m[ext] || '📄'
}

function fileTourTarget(name: string) {
  if (name === 'README.md') return 'project-file-readme'
  if (name === 'AGENT_OUTPUT_GUIDE.md') return 'project-file-agent-output-guide'
  if (name === 'extension.json') return 'project-file-extension-json'
  if (name === 'frontend') return 'project-folder-frontend'
  if (name === 'backend') return 'project-folder-backend'
  return undefined
}

function dirnamePosix(absPath: string) {
  const normalized = absPath.trim().replace(/\/+$/g, '') || '/'
  if (normalized === '/') return ''
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return '/'
  return normalized.slice(0, idx)
}

function basenamePosix(relPath: string) {
  const normalized = String(relPath || '/').replace(/\/+$/g, '') || '/'
  if (normalized === '/') return '项目根目录'
  return normalized.split('/').filter(Boolean).pop() || normalized
}

// 剥掉路径末尾的 `:line` 或 `:line:col` 后缀 (markdown 行号语法, 如 `/abs/file.md:1`).
// code-server 的 openFile payload 不会解析行号, 留着 `:1` 会被当成文件名一部分 → 找不到文件.
function stripLineColSuffix(absPath: string): string {
  if (!absPath.startsWith('/')) return absPath
  const m = absPath.match(/^(.+):([0-9]+)(?::[0-9]+)?$/)
  return m ? m[1] : absPath
}

// 构造 code-server URL.
// folder 模式: <base>/?folder=<bindPath>
// 文件模式: <base>/?folder=<bindPath>&payload=[["openFile","vscode-remote://<host>/<abs>"]]
// 注: payload 在 code-server 上是惯例参数, 不同版本兼容性一般; 失败时退回 folder.
// base 为相对反代路径 (/code-server/<u>__<p>) 时, 首次 navigate 必须带 ?_jwt=<token>
// (cs_url_token_required), 代理校验后写 cookie 再 302 去掉它. 故拼上当前登录 token.
export function buildVscodeUrl(base: string, bindPath: string, filePath?: string | null): string | null {
  if (!base || !bindPath) return null
  const trimmed = base.replace(/\/+$/, '')
  const folder = encodeURIComponent(bindPath)
  let url: string
  if (!filePath) {
    url = `${trimmed}/?folder=${folder}`
  } else {
    try {
      const browserOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
      const u = new URL(trimmed, browserOrigin)
      const authority = u.host
      const cleaned = stripLineColSuffix(filePath)
      const fp = cleaned.startsWith('/') ? cleaned : '/' + cleaned
      const payload = JSON.stringify([['openFile', `vscode-remote://${authority}${fp}`]])
      url = `${trimmed}/?folder=${folder}&payload=${encodeURIComponent(payload)}`
    } catch {
      url = `${trimmed}/?folder=${folder}`
    }
  }
  const token = (typeof localStorage !== 'undefined' && localStorage.getItem('cc-token')) || ''
  if (token && trimmed.startsWith('/code-server/')) {
    url += `&_jwt=${encodeURIComponent(token)}`
  }
  return url
}

export function buildCodeServerProxyUrl(base: string, port: number | string): string | null {
  const portText = String(port).trim()
  if (!/^[0-9]{1,5}$/.test(portText)) return null
  const portNumber = Number(portText)
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return null
  if (!base) return null
  const trimmed = base.replace(/\/+$/, '')
  let url = `${trimmed}/proxy/${portNumber}/`
  const token = (typeof localStorage !== 'undefined' && localStorage.getItem('cc-token')) || ''
  if (token && trimmed.startsWith('/code-server/')) {
    url += `?_jwt=${encodeURIComponent(token)}`
  }
  return url
}

// =====================================================================
// OpenInVSCodeButton — 给定 projectId, 在 VSCode Web 中打开项目 bind_path
// 或当前工作区路径. 加载所需元数据 (bind_path + VSCODE_WEB_URL)
// 复用 /api/projects/:id/files?path=/ 端点 (与 ProjectFilesCard 同源,
// 后端已实现). projectId 缺失 / 项目未绑定路径 / 后端未配置 VSCODE_WEB_URL
// 时按钮不渲染, 保持顶栏整洁.
// =====================================================================
// subPath — 可选, 相对 bind_path 的子目录 (如 git worktree 分支名). 给了就
// 把当前工作区路径视为 bind_path/subPath; 否则当前工作区就是 bind_path.
type OpenInVSCodeButtonProps = {
  projectId?: string | null
  subPath?: string | null
  className?: string
  mode?: 'picker' | 'direct'
  showWorktreeOption?: boolean
  iconOnly?: boolean
}

export function OpenInVSCodeButton({
  projectId,
  subPath,
  className,
  mode = 'picker',
  showWorktreeOption = true,
  iconOnly = false,
}: OpenInVSCodeButtonProps) {
  const [bindPath, setBindPath] = useState('')
  const [vscodeWorkspacePath, setVscodeWorkspacePath] = useState('')
  const [vscodeWebUrl, setVscodeWebUrl] = useState('')
  const [showPathPicker, setShowPathPicker] = useState(false)

  useEffect(() => {
    if (!projectId) {
      setBindPath('')
      setVscodeWorkspacePath('')
      setVscodeWebUrl('')
      setShowPathPicker(false)
      return
    }
    setBindPath('')
    setVscodeWorkspacePath('')
    setVscodeWebUrl('')
    setShowPathPicker(false)
    let cancelled = false
    api(`/api/projects/${projectId}/files?path=/`).then((data) => {
      if (cancelled) return
      setBindPath(data?.bind_path || '')
      setVscodeWorkspacePath(data?.vscode_workspace_path || data?.bind_path || '')
      setVscodeWebUrl(data?.vscode_web_url || '')
    }).catch(() => { /* 静默, 按钮自然不渲染 */ })
    return () => { cancelled = true }
  }, [projectId])

  useEffect(() => {
    setShowPathPicker(false)
  }, [projectId, subPath])

  useEffect(() => {
    if (!showPathPicker) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowPathPicker(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showPathPicker])

  const ready = !!bindPath && !!vscodeWebUrl
  const sub = (subPath || '').trim().replace(/^\/+|\/+$/g, '')
  const worktreeFolder = sub ? `${bindPath.replace(/\/+$/, '')}/${sub}` : bindPath
  const defaultFolder = vscodeWorkspacePath || bindPath
  const parentFolder = dirnamePosix(bindPath)
  const buttonClassName = className || 'h-7 px-2.5 text-[11px] border border-blue-500/20 text-blue-400 rounded-lg hover:bg-blue-500/10 transition-colors flex items-center gap-1.5'
  const effectiveClassName = iconOnly
    ? (buttonClassName.replace(/\s+px-2\.5\s+/g, " ").replace(/\s+px-3\s+/g, " ").replace(/\s+text-\[11px\]\s+/g, " ").replace(/\s+text-\[12px\]\s+/g, " ").trim() + " px-2 w-9 justify-center")
    : buttonClassName

  const openFolder = (folder: string) => {
    const url = buildVscodeUrl(vscodeWebUrl, folder)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
    setShowPathPicker(false)
  }

  if (!ready) return null

  return (
    <>
      <button
        type="button"
        onClick={() => mode === 'direct' ? openFolder(defaultFolder) : setShowPathPicker(true)}
        data-tour="vscode-open-button"
        title={mode === 'direct' ? '在 VSCode Web 打开项目目录' : '选择 VSCode Web 打开路径'}
        className={effectiveClassName}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
        {!iconOnly && <span>打开VSCode</span>}
      </button>

      {showPathPicker && mode !== 'direct' && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center px-4" onClick={() => setShowPathPicker(false)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="vscode-open-title"
            className="relative w-full max-w-[460px] rounded-2xl shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
          >
            <div className="px-5 py-3 border-b flex items-center gap-3" style={{ borderColor: 'var(--border-color)' }}>
              <svg className="w-4 h-4 text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              <div className="min-w-0">
                <div id="vscode-open-title" className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  在 VSCode 中打开
                </div>
                <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                  选择要前往的工作目录
                </div>
              </div>
            </div>
            <div className="p-3 space-y-2">
              <button
                type="button"
                onClick={() => openFolder(defaultFolder)}
                className="w-full min-h-[62px] px-3 py-2.5 rounded-lg border text-left bg-[var(--bg-primary)] transition-colors hover:bg-blue-500/10 hover:border-blue-500/30"
                style={{ borderColor: 'var(--border-color)' }}
              >
                <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  前往项目目录
                </div>
                <div className="mt-1 text-[11px] font-mono truncate" title={defaultFolder} style={{ color: 'var(--text-muted)' }}>
                  {defaultFolder}
                </div>
              </button>
              {parentFolder && parentFolder !== defaultFolder && (
                <button
                  type="button"
                  onClick={() => openFolder(parentFolder)}
                  className="w-full min-h-[62px] px-3 py-2.5 rounded-lg border text-left bg-[var(--bg-primary)] transition-colors hover:bg-blue-500/10 hover:border-blue-500/30"
                  style={{ borderColor: 'var(--border-color)' }}
                >
                  <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    前往项目目录的上一级
                  </div>
                  <div className="mt-1 text-[11px] font-mono truncate" title={parentFolder} style={{ color: 'var(--text-muted)' }}>
                    {parentFolder}
                  </div>
                </button>
              )}
              {showWorktreeOption && (
                <button
                  type="button"
                  onClick={() => openFolder(worktreeFolder)}
                  className="w-full min-h-[62px] px-3 py-2.5 rounded-lg border text-left bg-[var(--bg-primary)] transition-colors hover:bg-blue-500/10 hover:border-blue-500/30"
                  style={{ borderColor: 'var(--border-color)' }}
                >
                  <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    前往当前Git Worktree路径
                  </div>
                  <div className="mt-1 text-[11px] font-mono truncate" title={worktreeFolder} style={{ color: 'var(--text-muted)' }}>
                    {worktreeFolder}
                  </div>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

type ProjectPortEntryButtonProps = {
  projectId?: string | null
  subPath?: string | null
  className?: string
  label?: string
  triggerVariant?: 'default' | 'advanced'
  onRequestRunProject?: (mainProjectPortPath: string) => void
}

export function ProjectPortEntryButton({ projectId, subPath, className, label, triggerVariant = 'default', onRequestRunProject }: ProjectPortEntryButtonProps) {
  const [bindPath, setBindPath] = useState('')
  const [vscodeWebUrl, setVscodeWebUrl] = useState('')
  const [autoPort, setAutoPort] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [aimuxForwarding, setAimuxForwarding] = useState(false)
  const [showDialog, setShowDialog] = useState(false)
  const [error, setError] = useState('')
  const [manualPort, setManualPort] = useState('')
  const [showManualInput, setShowManualInput] = useState(false)

  const loadMetadata = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setError('')
    try {
      const [files, portInfo] = await Promise.all([
        api(`/api/projects/${projectId}/files?path=/`),
        api(`/api/projects/${projectId}/main-project-port`),
      ])
      setBindPath(files?.bind_path || '')
      setVscodeWebUrl(files?.vscode_web_url || '')
      setAutoPort(portInfo?.valid && typeof portInfo?.port === 'number' ? portInfo.port : null)
    } catch (e: any) {
      setError(e?.message || '加载项目端口失败')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (!projectId) {
      setBindPath('')
      setVscodeWebUrl('')
      setAutoPort(null)
      setShowDialog(false)
      return
    }
    loadMetadata()
  }, [projectId, loadMetadata])

  useEffect(() => {
    setError('')
  }, [projectId, subPath])

  useEffect(() => {
    if (!showDialog) {
      setShowManualInput(false)
      setManualPort('')
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowDialog(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showDialog])

  const ready = !!projectId && !!vscodeWebUrl && !!bindPath
  const desktopBridge: any = typeof window !== 'undefined' ? (window as any).mobiusDesktop : undefined
  const canUseAimuxPortForward = !!desktopBridge?.isDesktop && typeof desktopBridge?.startAimuxPortForward === 'function'
  const mainProjectPortPath = bindPath ? `${bindPath.replace(/\/+$/, '')}/${HIDDEN_FOLDER_NAME}/port_forward/main_project_port.txt` : ''
  const buttonClassName = className || 'h-7 px-2.5 text-[11px] border border-emerald-500/20 text-emerald-400 rounded-xl hover:bg-emerald-500/10 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-45 disabled:cursor-not-allowed'
  const buttonLabel = label || '进入项目端口'
  const renderAdvancedTrigger = (disabled: boolean, title: string, onClick?: () => void) => (
    <AdvancedInteractionBtn
      onClick={onClick}
      disabled={disabled}
      label={buttonLabel}
      tooltip={title}
      accent="emerald"
      className={className}
      icon={loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <MonitorUp className="h-4 w-4" />}
    />
  )

  const openProxyPort = (port: number) => {
    const url = buildCodeServerProxyUrl(vscodeWebUrl, port)
    if (!url) {
      setError('端口 URL 生成失败')
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
    setShowDialog(false)
  }

  const openAimuxPort = async (port: number) => {
    if (!canUseAimuxPortForward) {
      setError('当前不是支持 AIMUX port forward 的桌面端')
      return
    }
    setAimuxForwarding(true)
    setError('')
    try {
      const result = await desktopBridge.startAimuxPortForward(port)
      if (!result?.ok || !result?.url) {
        setError(result?.error || 'AIMUX port forward 启动失败')
        return
      }
      window.open(result.url, '_blank', 'noopener,noreferrer')
      setShowDialog(false)
      window.alert('请注意，Mobius桌面端退出时，端口映射会自动失效')
    } catch (e: any) {
      setError(e?.message || 'AIMUX port forward 启动失败')
    } finally {
      setAimuxForwarding(false)
    }
  }

  const submitManualAimuxPort = () => {
    const portText = manualPort.trim()
    if (!/^\d{1,5}$/.test(portText)) {
      setError('请输入 1-65535 的端口号')
      return
    }
    const port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('请输入 1-65535 的端口号')
      return
    }
    setShowManualInput(false)
    setManualPort('')
    void openAimuxPort(port)
  }

  if (!ready) {
    if (triggerVariant === 'advanced') {
      return renderAdvancedTrigger(true, projectId ? '正在加载项目端口' : '正在加载项目信息')
    }
    return (
      <button
        type="button"
        disabled
        title={projectId ? '正在加载项目端口' : '正在加载项目信息'}
        className={buttonClassName}
      >
        {projectId && loading
          ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          : <MonitorUp className="w-3.5 h-3.5 shrink-0" />}
        <span className="btn-label">{buttonLabel}</span>
      </button>
    )
  }

  return (
    <>
      {triggerVariant === 'advanced' ? renderAdvancedTrigger(loading, '进入项目端口', () => {
          setShowDialog(true)
          setError('')
          if (!loading) loadMetadata()
        }) : (
        <button
          type="button"
          onClick={() => {
            setShowDialog(true)
            setError('')
            if (!loading) loadMetadata()
          }}
          disabled={loading}
          title="进入项目端口"
          className={buttonClassName}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : <MonitorUp className="w-3.5 h-3.5 shrink-0" />}
          <span className="btn-label">{buttonLabel}</span>
        </button>
      )}

      {showDialog && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center px-4" onClick={() => {
          setShowDialog(false)
        }}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-port-title"
            className="relative w-full max-w-[460px] rounded-2xl shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
          >
            <div className="px-5 py-3 border-b flex items-center gap-3" style={{ borderColor: 'var(--border-color)' }}>
              <MonitorUp className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              <div className="min-w-0">
                <div id="project-port-title" className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  进入项目端口
                </div>
                <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                  打开 code-server 代理端口
                </div>
              </div>
            </div>
            <div className="p-3 space-y-2">
              <button
                type="button"
                onClick={() => autoPort !== null && openProxyPort(autoPort)}
                disabled={autoPort === null}
                className="w-full min-h-[58px] px-3 py-2.5 rounded-lg border text-left bg-[var(--bg-primary)] transition-colors hover:bg-emerald-500/10 hover:border-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-55"
                style={{ borderColor: 'var(--border-color)' }}
              >
                <div className="flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  <ExternalLink className="w-3.5 h-3.5 text-emerald-400" />
                  自动
                </div>
                <div className="mt-1 text-[11px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>
                  {autoPort !== null ? `proxy/${autoPort}/` : `${HIDDEN_FOLDER_NAME}/port_forward/main_project_port.txt 未检测到有效端口`}
                </div>
              </button>

              {canUseAimuxPortForward && (
                <>
                  {autoPort !== null && (
                    <button
                      type="button"
                      onClick={() => openAimuxPort(autoPort)}
                      disabled={aimuxForwarding}
                      className="w-full min-h-[58px] px-3 py-2.5 rounded-lg border text-left bg-[var(--bg-primary)] transition-colors hover:bg-sky-500/10 hover:border-sky-500/30 disabled:cursor-not-allowed disabled:opacity-55"
                      style={{ borderColor: 'var(--border-color)' }}
                    >
                      <div className="flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        {aimuxForwarding ? <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" /> : <Cable className="w-3.5 h-3.5 text-sky-400" />}
                        打开端口（AIMUX 自动）
                      </div>
                      <div className="mt-1 text-[11px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>
                        读取 main_project_port.txt：{autoPort}
                      </div>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setShowManualInput(prev => !prev)
                      setError('')
                    }}
                    disabled={aimuxForwarding}
                    className="w-full min-h-[58px] px-3 py-2.5 rounded-lg border text-left bg-[var(--bg-primary)] transition-colors hover:bg-sky-500/10 hover:border-sky-500/30 disabled:cursor-not-allowed disabled:opacity-55"
                    style={{ borderColor: showManualInput ? 'rgba(56,189,248,0.55)' : 'var(--border-color)' }}
                  >
                    <div className="flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {aimuxForwarding ? <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" /> : <Cable className="w-3.5 h-3.5 text-sky-400" />}
                      打开端口（AIMUX 手动）
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {showManualInput ? '在下方输入端口号' : '点击后输入端口号码'}
                    </div>
                  </button>

                  {showManualInput && (
                    <form
                      className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-2.5 space-y-2"
                      onSubmit={event => {
                        event.preventDefault()
                        submitManualAimuxPort()
                      }}
                    >
                      <input
                        autoFocus
                        inputMode="numeric"
                        value={manualPort}
                        disabled={aimuxForwarding}
                        onChange={event => {
                          setManualPort(event.target.value)
                          setError('')
                        }}
                        placeholder="端口号（1-65535）"
                        className="w-full h-8 px-2.5 rounded-md border bg-[var(--bg-primary)] text-[13px] font-mono outline-none focus:border-sky-500/60 disabled:opacity-60"
                        style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                      />
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={aimuxForwarding}
                          onClick={() => {
                            setShowManualInput(false)
                            setManualPort('')
                            setError('')
                          }}
                          className="h-7 px-2.5 rounded-md border text-[12px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-60"
                          style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
                        >
                          取消
                        </button>
                        <button
                          type="submit"
                          disabled={aimuxForwarding}
                          className="h-7 px-2.5 rounded-md bg-sky-500 text-white text-[12px] transition-colors hover:bg-sky-600 disabled:opacity-60 inline-flex items-center gap-1.5"
                        >
                          {aimuxForwarding && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          打开
                        </button>
                      </div>
                    </form>
                  )}
                </>
              )}

              {onRequestRunProject && (
                <button
                  type="button"
                  onClick={() => {
                    if (!mainProjectPortPath) {
                      setError('项目端口文件路径不可用')
                      return
                    }
                    setShowDialog(false)
                    onRequestRunProject(mainProjectPortPath)
                  }}
                  className="w-full min-h-[58px] px-3 py-2.5 rounded-lg border text-left bg-[var(--bg-primary)] transition-colors hover:bg-amber-500/10 hover:border-amber-500/30"
                  style={{ borderColor: 'var(--border-color)' }}
                >
                  <div className="flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    <Play className="w-3.5 h-3.5 text-amber-400" />
                    发送运行前端的命令
                  </div>
                  <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    让当前会话启动项目并写入端口文件
                  </div>
                </button>
              )}

              {error && (
                <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
                  {error}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </>
  )
}

export function ProjectFilesCard({ projectId }: { projectId: string }) {
  const [bindPath, setBindPath] = useState('')
  const [vscodeWorkspacePath, setVscodeWorkspacePath] = useState('')
  const [vscodeWebUrl, setVscodeWebUrl] = useState('')
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']))
  const [rootLoaded, setRootLoaded] = useState(false)
  const [rootError, setRootError] = useState('')
  const [contextMenu, setContextMenu] = useState<FileTreeContextMenuState | null>(null)
  const [createDialog, setCreateDialog] = useState<FileTreeCreateDialogState | null>(null)

  const loadDir = useCallback(async (relPath: string) => {
    setDirs(prev => ({ ...prev, [relPath]: { ...prev[relPath], loading: true, error: undefined } }))
    try {
      const data = await api(`/api/projects/${projectId}/files?path=${encodeURIComponent(relPath)}`)
      if (relPath === '/') {
        setBindPath(data.bind_path || '')
        setVscodeWorkspacePath(data.vscode_workspace_path || data.bind_path || '')
        setVscodeWebUrl(data.vscode_web_url || '')
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

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [contextMenu])

  const toggleDir = (relPath: string) => {
    const next = new Set(expanded)
    if (next.has(relPath)) next.delete(relPath)
    else { next.add(relPath); if (!dirs[relPath]) loadDir(relPath) }
    setExpanded(next)
  }

  const openFile = (entry: Entry) => {
    const url = buildVscodeUrl(vscodeWebUrl, bindPath, entry.abs_path)
    if (!url) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const openProject = () => {
    const url = buildVscodeUrl(vscodeWebUrl, vscodeWorkspacePath || bindPath)
    if (!url) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const refreshTree = useCallback(async () => {
    const paths = Array.from(expanded)
    if (!paths.includes('/')) paths.unshift('/')
    await Promise.all(paths.map((path) => loadDir(path)))
  }, [expanded, loadDir])

  const openDirMenu = (event: React.MouseEvent, dirRelPath: string) => {
    event.preventDefault()
    event.stopPropagation()
    if (!bindPath || rootError) return
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      dirRelPath,
      label: basenamePosix(dirRelPath),
    })
  }

  const openNodeMenu = (event: React.MouseEvent, target: FileTreeTarget) => {
    openDirMenu(event, target.entry.type === 'dir' ? target.relPath : target.parentRelPath)
  }

  const startCreate = (kind: CreateKind, dirRelPath: string) => {
    setContextMenu(null)
    setCreateDialog({ kind, dirRelPath, name: '', error: '', loading: false })
  }

  const submitCreate = async () => {
    if (!createDialog || createDialog.loading) return
    const name = createDialog.name.trim()
    if (!name) {
      setCreateDialog(prev => prev ? { ...prev, error: '请输入名称' } : prev)
      return
    }
    setCreateDialog(prev => prev ? { ...prev, error: '', loading: true } : prev)
    try {
      const endpoint = createDialog.kind === 'dir' ? 'mkdir' : 'create'
      await api(`/api/projects/${projectId}/files/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify({ parentPath: createDialog.dirRelPath, name }),
      })
      await loadDir(createDialog.dirRelPath)
      if (createDialog.kind === 'dir') {
        setExpanded(prev => new Set([...Array.from(prev), createDialog.dirRelPath]))
      }
      setCreateDialog(null)
    } catch (e: any) {
      setCreateDialog(prev => prev ? { ...prev, error: e?.message || '创建失败', loading: false } : prev)
    }
  }

  const vscodeReady = !!vscodeWebUrl && !!bindPath

  return (
    <div data-tour="project-files-card" className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}>
      {/* 头部 */}
      <div className="px-4 py-3 border-b flex items-center gap-2" style={{ borderColor: 'var(--border-color)' }}>
        <svg className="w-4 h-4 text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>项目文件</div>
          <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }} title={bindPath}>
            {bindPath || '(未绑定路径)'}
          </div>
        </div>
        <button
          type="button"
          onClick={refreshTree}
          disabled={!rootLoaded}
          title="刷新文件列表"
          aria-label="刷新文件列表"
          className="h-7 w-7 rounded border transition-colors inline-flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--bg-card-hover)]"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${dirs['/']?.loading ? 'animate-spin' : ''}`} strokeWidth={1.8} />
        </button>
        {vscodeReady && (
          <button onClick={openProject}
            data-tour="project-files-vscode-open"
            className="h-7 px-3 text-[11px] rounded bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border border-blue-500/20 transition-colors flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            在 VSCode 中打开
          </button>
        )}
      </div>

      {/* 提示: 未配置 VSCode Web URL */}
      {rootLoaded && bindPath && !vscodeWebUrl && (
        <div className="px-4 py-2 text-[11px] border-b" style={{ borderColor: 'var(--border-color)', background: 'rgba(245,158,11,0.06)', color: 'var(--text-muted)' }}>
          未配置 VSCode Web (设置 <code>VSCODE_WEB_URL</code> 环境变量后重启 Mobius), 文件仅可浏览不可一键打开
        </div>
      )}

      {/* 文件树 */}
      <div
        className="px-2 py-2 max-h-[420px] min-h-[120px] overflow-y-auto"
        onContextMenu={event => {
          if (event.target === event.currentTarget) openDirMenu(event, '/')
        }}
      >
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
            onOpenFile={openFile}
            vscodeReady={vscodeReady}
            onContextMenu={openNodeMenu}
            onBlankContextMenu={openDirMenu}
          />
        )}
      </div>

      {contextMenu && (
        <div
          role="menu"
          className="fixed z-[80] min-w-[172px] rounded-lg border p-1 shadow-xl"
          style={{
            left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 188)),
            top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 98)),
            background: 'var(--modal-bg)',
            borderColor: 'var(--border-color)',
          }}
          onClick={event => event.stopPropagation()}
        >
          <div className="px-2 py-1.5 text-[11px] truncate" title={contextMenu.dirRelPath} style={{ color: 'var(--text-muted)' }}>
            {contextMenu.label}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => startCreate('file', contextMenu.dirRelPath)}
            className="w-full px-2 py-1.5 rounded-md text-left text-[12px] inline-flex items-center gap-2 hover:bg-[var(--bg-card-hover)]"
            style={{ color: 'var(--text-primary)' }}
          >
            <FilePlus2 className="w-3.5 h-3.5 text-blue-400" strokeWidth={1.8} />
            新建文件
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => startCreate('dir', contextMenu.dirRelPath)}
            className="w-full px-2 py-1.5 rounded-md text-left text-[12px] inline-flex items-center gap-2 hover:bg-[var(--bg-card-hover)]"
            style={{ color: 'var(--text-primary)' }}
          >
            <FolderPlus className="w-3.5 h-3.5 text-emerald-400" strokeWidth={1.8} />
            新建目录
          </button>
        </div>
      )}

      {createDialog && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center px-4" onClick={() => !createDialog.loading && setCreateDialog(null)}>
          <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-[380px] rounded-xl border shadow-2xl overflow-hidden"
            style={{ background: 'var(--modal-bg)', borderColor: 'var(--border-color)' }}
            onClick={event => event.stopPropagation()}
          >
            <div className="px-4 py-3 border-b flex items-center gap-2" style={{ borderColor: 'var(--border-color)' }}>
              {createDialog.kind === 'dir'
                ? <FolderPlus className="w-4 h-4 text-emerald-400" strokeWidth={1.8} />
                : <FilePlus2 className="w-4 h-4 text-blue-400" strokeWidth={1.8} />}
              <div className="min-w-0">
                <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {createDialog.kind === 'dir' ? '新建目录' : '新建文件'}
                </div>
                <div className="text-[11px] truncate" title={createDialog.dirRelPath} style={{ color: 'var(--text-muted)' }}>
                  {basenamePosix(createDialog.dirRelPath)}
                </div>
              </div>
            </div>
            <form
              className="p-4 space-y-3"
              onSubmit={event => {
                event.preventDefault()
                submitCreate()
              }}
            >
              <input
                autoFocus
                value={createDialog.name}
                disabled={createDialog.loading}
                onChange={event => setCreateDialog(prev => prev ? { ...prev, name: event.target.value, error: '' } : prev)}
                placeholder={createDialog.kind === 'dir' ? '目录名' : '文件名'}
                className="w-full h-9 px-3 rounded-lg border bg-[var(--bg-primary)] text-[13px] outline-none focus:border-blue-500/60 disabled:opacity-60"
                style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
              />
              {createDialog.error && (
                <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
                  {createDialog.error}
                </div>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={createDialog.loading}
                  onClick={() => setCreateDialog(null)}
                  className="h-8 px-3 rounded-lg border text-[12px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-60"
                  style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={createDialog.loading}
                  className="h-8 px-3 rounded-lg bg-blue-500 text-white text-[12px] transition-colors hover:bg-blue-600 disabled:opacity-60 inline-flex items-center gap-1.5"
                >
                  {createDialog.loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  创建
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export function FileTreeLevel({ relPath, depth, dirs, expanded, onToggleDir, onOpenFile, vscodeReady, selectedAbsPath, fileActionLabel, onContextMenu, onBlankContextMenu, renamingRelPath, renderRenameInput }: {
  relPath: string
  depth: number
  dirs: Record<string, DirState>
  expanded: Set<string>
  onToggleDir: (relPath: string) => void
  onOpenFile: (entry: Entry) => void
  vscodeReady: boolean
  // v2 代码对话: 当前选中文件的 abs_path, 命中时文件行高亮. 不传则不高亮.
  selectedAbsPath?: string
  // v2 代码对话: 文件行 hover title (默认"在 VSCode Web 打开", v2 传"预览文件").
  fileActionLabel?: string
  // v2 右键菜单: 右键节点时回调 (阻止默认菜单由本组件完成)。不传则无右键菜单。
  onContextMenu?: (event: React.MouseEvent, target: FileTreeTarget) => void
  // 右键空目录占位行时回调。宿主决定该空白区域代表哪个目录。
  onBlankContextMenu?: (event: React.MouseEvent, relPath: string) => void
  // v2 内联重命名: 命中 relPath 的节点渲染为输入框。
  renamingRelPath?: string
  // v2 内联重命名: 输入框渲染器, 由宿主提供 (含提交/取消/loading)。
  renderRenameInput?: (target: FileTreeTarget) => ReactNode
}) {
  const state = dirs[relPath]
  if (!state) return null
  if (state.loading) return <div className="text-[11px] py-1 pl-4" style={{ color: 'var(--text-muted)' }}>加载中...</div>
  if (state.error) return <div className="text-[11px] py-1 pl-4 text-red-400">{state.error}</div>
  const entries = state.entries || []
  if (entries.length === 0) {
    return (
      <div
        className="text-[11px] py-1 pl-4"
        style={{ color: 'var(--text-muted)' }}
        onContextMenu={onBlankContextMenu ? (event) => onBlankContextMenu(event, relPath) : undefined}
      >
        (空目录)
      </div>
    )
  }
  const actionLabel = fileActionLabel || '在 VSCode Web 打开'
  const ctxHandler = (entry: Entry, childPath: string) => onContextMenu
    ? (e: React.MouseEvent) => {
        e.preventDefault()
        // 阻止冒泡, 否则根容器的 onContextMenu 也会触发 (重复打开菜单)。
        e.stopPropagation()
        onContextMenu(e, { entry, relPath: childPath, parentRelPath: relPath })
      }
    : undefined
  return (
    <div>
      {entries.map(entry => {
        const childPath = relPath === '/' ? `/${entry.name}` : `${relPath}/${entry.name}`
        const isOpen = expanded.has(childPath)
        const isRenaming = !!renamingRelPath && renamingRelPath === childPath
        if (entry.type === 'dir') {
          return (
            <div key={childPath}>
              {isRenaming ? (
                // 重命名时不能把 <input> 嵌进 <button>, 改渲染 div 行。
                <div
                  className="w-full text-left flex items-center gap-1.5 px-2 py-1 rounded text-[12px]"
                  style={{ paddingLeft: `${depth * 16 + 8}px`, color: 'var(--text-primary)' }}
                  onContextMenu={ctxHandler(entry, childPath)}
                >
                  <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="flex-shrink-0">{fileIcon(entry.name, 'dir')}</span>
                  {renderRenameInput?.({ entry, relPath: childPath, parentRelPath: relPath })}
                </div>
              ) : (
                <button
                  data-tour={fileTourTarget(entry.name)}
                  onClick={() => onToggleDir(childPath)}
                  onContextMenu={ctxHandler(entry, childPath)}
                  className="w-full text-left flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[var(--bg-card-hover)] transition-colors text-[12px]"
                  style={{ paddingLeft: `${depth * 16 + 8}px`, color: 'var(--text-primary)' }}>
                  <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="flex-shrink-0">{fileIcon(entry.name, 'dir')}</span>
                  <span className="truncate">{entry.name}</span>
                </button>
              )}
              {isOpen && (
                <FileTreeLevel
                  relPath={childPath}
                  depth={depth + 1}
                  dirs={dirs}
                  expanded={expanded}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                  vscodeReady={vscodeReady}
                  selectedAbsPath={selectedAbsPath}
                  fileActionLabel={fileActionLabel}
                  onContextMenu={onContextMenu}
                  onBlankContextMenu={onBlankContextMenu}
                  renamingRelPath={renamingRelPath}
                  renderRenameInput={renderRenameInput}
                />
              )}
            </div>
          )
        }
        const selected = !!selectedAbsPath && entry.abs_path === selectedAbsPath
        if (isRenaming) {
          return (
            <div
              key={childPath}
              className="w-full text-left flex items-center gap-1.5 px-2 py-1 rounded text-[12px]"
              style={{ paddingLeft: `${depth * 16 + 8 + 14}px`, color: 'var(--text-primary)' }}
              onContextMenu={ctxHandler(entry, childPath)}
            >
              <span className="flex-shrink-0">{fileIcon(entry.name, 'file')}</span>
              {renderRenameInput?.({ entry, relPath: childPath, parentRelPath: relPath })}
            </div>
          )
        }
        return (
          <button
            key={childPath}
            data-tour={fileTourTarget(entry.name)}
            onClick={() => vscodeReady && onOpenFile(entry)}
            onContextMenu={ctxHandler(entry, childPath)}
            disabled={!vscodeReady}
            title={vscodeReady ? actionLabel : '未配置 VSCode Web'}
            className={`w-full text-left flex items-center gap-1.5 px-2 py-1 rounded transition-colors text-[12px] disabled:cursor-default ${selected ? '' : 'hover:bg-[var(--bg-card-hover)]'}`}
            style={{ paddingLeft: `${depth * 16 + 8 + 14}px`, color: vscodeReady ? 'var(--text-primary)' : 'var(--text-muted)', background: selected ? 'color-mix(in srgb, var(--accent-primary) 16%, transparent)' : undefined }}>
            <span className="flex-shrink-0">{fileIcon(entry.name, 'file')}</span>
            <span className="truncate flex-1">{entry.name}</span>
            {entry.size !== null && (
              <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{formatSize(entry.size)}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
