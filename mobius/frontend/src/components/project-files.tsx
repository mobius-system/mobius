import { useState, useEffect, useCallback } from 'react'
import { Check, Copy, ExternalLink, KeyRound, Loader2, MonitorUp, Play, TerminalSquare } from 'lucide-react'
import { api, HIDDEN_FOLDER_NAME } from '../store'

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

type DirState = {
  loading?: boolean
  error?: string
  entries?: Entry[]
}

function formatSize(n: number | null) {
  if (n === null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fileIcon(name: string, type: 'dir' | 'file') {
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

function normalizePortInput(value: string): number | null {
  const text = value.trim()
  if (!/^[0-9]{1,5}$/.test(text)) return null
  const port = Number(text)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

async function copyTextToClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the textarea fallback below
  }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', 'true')
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    el.style.top = '0'
    document.body.appendChild(el)
    el.focus()
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

type SshForwardConfig = {
  enabled?: boolean
  ssh_url?: string
  host?: string
  port?: number | null
  mobius_ssh_port?: number | null
  user?: string
  private_key?: string
  private_key_path?: string
  private_key_exists?: boolean
  missing?: string[]
  error?: string
}

function sshHostTarget(host: string) {
  const text = String(host || '').trim()
  if (!text) return ''
  if (text.includes(':') && !text.startsWith('[')) return `[${text}]`
  return text
}

function buildSshForwardCommands(config: SshForwardConfig, remotePort: number, localPort: number) {
  const keyName = 'mobius-ssh-forward-ed25519'
  const host = sshHostTarget(config.host || '')
  const user = config.user || 'mobius-forward'
  const sshPort = config.port || config.mobius_ssh_port || 33318
  const privateKey = String(config.private_key || '').trimEnd()
  const target = `${user}@${host}`
  const linuxKeyPath = `~/.mobius/${keyName}`
  const linux = [
    'mkdir -p ~/.mobius',
    `cat > ${linuxKeyPath} <<'MOBIUS_SSH_KEY'`,
    privateKey,
    'MOBIUS_SSH_KEY',
    `chmod 600 ${linuxKeyPath}`,
    `ssh -N -L 127.0.0.1:${localPort}:127.0.0.1:${remotePort} -p ${sshPort} -i ${linuxKeyPath} -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new ${target}`,
  ].join('\n')

  const windows = [
    '$dir = Join-Path $env:USERPROFILE ".mobius"',
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    `$key = Join-Path $dir "${keyName}"`,
    "@'",
    privateKey,
    "'@ | Set-Content -NoNewline -Encoding ascii $key",
    'icacls $key /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null',
    `ssh -N -L 127.0.0.1:${localPort}:127.0.0.1:${remotePort} -p ${sshPort} -i $key -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new ${target}`,
  ].join('\n')

  return { linux, windows }
}

function sshForwardMissingLabel(key: string) {
  const labels: Record<string, string> = {
    MOBIUS_SSH_URL: 'MOBIUS_SSH_URL 未配置',
    MOBIUS_SSH_PORT: 'MOBIUS_SSH_PORT 未配置或不可用',
    MOBIUS_SSH_URL_port_must_not_be_443: 'MOBIUS_SSH_URL 不能使用 443 端口',
    ssh_private_key: 'SSH 私钥尚未生成',
    ssh_forward_config: 'SSH 映射配置接口不可用',
  }
  return labels[key] || key
}

function SshForwardModal({
  config,
  remotePort,
  localPort,
  onLocalPortChange,
  onClose,
  onOpenTarget,
}: {
  config: SshForwardConfig | null
  remotePort: number
  localPort: string
  onLocalPortChange: (value: string) => void
  onClose: () => void
  onOpenTarget: (port: number) => void
}) {
  const [copied, setCopied] = useState('')
  const [copyError, setCopyError] = useState('')
  const [openError, setOpenError] = useState('')
  const localPortNumber = normalizePortInput(localPort)
  const ready = !!config?.enabled && !!localPortNumber && !!config?.host && !!(config?.port || config?.mobius_ssh_port) && !!config?.private_key
  const commands = ready ? buildSshForwardCommands(config, remotePort, localPortNumber) : null
  const missing = config?.missing || []

  const copyBlock = async (key: string, text: string) => {
    const ok = await copyTextToClipboard(text)
    if (!ok) {
      setCopyError('复制失败，请手动选择文本复制')
      return
    }
    setCopyError('')
    setCopied(key)
    window.setTimeout(() => setCopied(''), 1500)
  }

  const openLocalTarget = () => {
    const port = normalizePortInput(localPort)
    if (port === null) {
      setOpenError('请输入 1-65535 的本地映射端口')
      return
    }
    setOpenError('')
    onOpenTarget(port)
  }

  const CodeBlock = ({ label, text }: { label: string; text: string }) => (
    <div className="relative rounded-lg border bg-[var(--bg-primary)]" style={{ borderColor: 'var(--border-color)' }}>
      <pre className="max-h-[230px] overflow-auto whitespace-pre-wrap break-words px-3 py-3 pr-20 text-[11px] leading-relaxed font-mono" style={{ color: 'var(--code-text)' }}>
        {text}
      </pre>
      <button
        type="button"
        onClick={() => copyBlock(label, text)}
        className="absolute right-2 top-2 h-7 px-2 rounded-md border text-[11px] inline-flex items-center gap-1.5 transition-colors hover:bg-[var(--bg-hover)]"
        style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }}
      >
        {copied === label ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
        {copied === label ? '已复制' : '复制'}
      </button>
    </div>
  )

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center px-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-forward-title"
        className="relative w-full max-w-[760px] max-h-[88vh] overflow-hidden rounded-2xl shadow-2xl"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
      >
        <div className="px-5 py-3 border-b flex items-center gap-3" style={{ borderColor: 'var(--border-color)' }}>
          <KeyRound className="w-4 h-4 text-cyan-400 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div id="ssh-forward-title" className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              映射端口访问（从个人PC）
            </div>
            <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
              SSH local forward 到当前项目活跃端口 {remotePort}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-7 px-2 rounded-md border text-[11px] hover:bg-[var(--bg-hover)]"
            style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
          >
            关闭
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto max-h-[calc(88vh-58px)]">
          <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
            <div className="rounded-lg border px-3 py-2 bg-[var(--bg-primary)]" style={{ borderColor: 'var(--border-color)' }}>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>SSH 入口</div>
              <div className="mt-1 text-[12px] font-mono break-all" style={{ color: 'var(--text-primary)' }}>
                {config?.ssh_url || '未配置 MOBIUS_SSH_URL'}
              </div>
              <div className="mt-1 text-[11px] font-mono break-all" style={{ color: 'var(--text-muted)' }}>
                {config?.user || 'mobius-forward'}@{config?.host || '-'}:{config?.port || config?.mobius_ssh_port || '-'}
              </div>
            </div>
            <label className="rounded-lg border px-3 py-2 bg-[var(--bg-primary)]" style={{ borderColor: 'var(--border-color)' }}>
              <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>本地映射端口</span>
              <input
                value={localPort}
                onChange={e => {
                  onLocalPortChange(e.target.value)
                  setOpenError('')
                }}
                inputMode="numeric"
                pattern="[0-9]*"
                className="mt-1 h-8 w-full rounded-md border bg-transparent px-2 text-[12px] outline-none focus:border-cyan-400"
                style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
              />
            </label>
          </div>

          {!ready && (
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
              {config?.error || (missing.length
                ? `SSH 映射配置未就绪：${missing.map(sshForwardMissingLabel).join('，')}`
                : 'SSH 映射配置未就绪')}
            </div>
          )}

          {ready && commands && (
            <>
              <div>
                <div className="mb-1.5 text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Linux / macOS
                </div>
                <CodeBlock label="linux" text={commands.linux} />
              </div>

              <div>
                <div className="mb-1.5 text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  Windows PowerShell
                </div>
                <CodeBlock label="windows" text={commands.windows} />
              </div>

              <div className="rounded-lg border px-3 py-2 text-[11px] bg-[var(--bg-primary)]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
                服务端私钥来源：<span className="font-mono break-all">{config?.private_key_path || '-'}</span>
              </div>
            </>
          )}

          {(copyError || openError) && (
            <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
              {copyError || openError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="h-8 px-3 rounded-md border text-[12px] hover:bg-[var(--bg-hover)]"
              style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
            >
              返回
            </button>
            <button
              type="button"
              onClick={openLocalTarget}
              className="h-8 px-3 rounded-md bg-cyan-500 text-white text-[12px] inline-flex items-center gap-1.5 disabled:opacity-55"
              disabled={!localPortNumber}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              我已运行，打开目标
            </button>
          </div>
        </div>
      </div>
    </div>
  )
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
  onRequestRunProject?: (mainProjectPortPath: string) => void
}

export function ProjectPortEntryButton({ projectId, subPath, className, label, onRequestRunProject }: ProjectPortEntryButtonProps) {
  const [bindPath, setBindPath] = useState('')
  const [vscodeWorkspacePath, setVscodeWorkspacePath] = useState('')
  const [vscodeWebUrl, setVscodeWebUrl] = useState('')
  const [autoPort, setAutoPort] = useState<number | null>(null)
  const [sshForwardConfig, setSshForwardConfig] = useState<SshForwardConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showDialog, setShowDialog] = useState(false)
  const [showSshForwardDialog, setShowSshForwardDialog] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualPort, setManualPort] = useState('')
  const [localForwardPort, setLocalForwardPort] = useState('')
  const [error, setError] = useState('')

  const loadMetadata = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setError('')
    try {
      const [files, portInfo, sshInfo] = await Promise.all([
        api(`/api/projects/${projectId}/files?path=/`),
        api(`/api/projects/${projectId}/main-project-port`),
        api(`/api/projects/${projectId}/ssh-forward-config`).catch((e: any) => ({
          enabled: false,
          error: e?.message || '加载 SSH 映射配置失败',
          missing: ['ssh_forward_config'],
        })),
      ])
      setBindPath(files?.bind_path || '')
      setVscodeWorkspacePath(files?.vscode_workspace_path || files?.bind_path || '')
      setVscodeWebUrl(files?.vscode_web_url || '')
      setAutoPort(portInfo?.valid && typeof portInfo?.port === 'number' ? portInfo.port : null)
      setSshForwardConfig(sshInfo || null)
    } catch (e: any) {
      setError(e?.message || '加载项目端口失败')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (!projectId) {
      setBindPath('')
      setVscodeWorkspacePath('')
      setVscodeWebUrl('')
      setAutoPort(null)
      setSshForwardConfig(null)
      setShowDialog(false)
      setShowSshForwardDialog(false)
      return
    }
    loadMetadata()
  }, [projectId, loadMetadata])

  useEffect(() => {
    setManualOpen(false)
    setManualPort('')
    setLocalForwardPort('')
    setShowSshForwardDialog(false)
    setError('')
  }, [projectId, subPath])

  useEffect(() => {
    if (!showDialog) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowDialog(false)
        setShowSshForwardDialog(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showDialog])

  const ready = !!projectId && !!vscodeWebUrl && !!bindPath
  const sub = (subPath || '').trim().replace(/^\/+|\/+$/g, '')
  const worktreeFolder = sub ? `${bindPath.replace(/\/+$/, '')}/${sub}` : (vscodeWorkspacePath || bindPath)
  const mainProjectPortPath = bindPath ? `${bindPath.replace(/\/+$/, '')}/${HIDDEN_FOLDER_NAME}/port_forward/main_project_port.txt` : ''
  const buttonClassName = className || 'h-7 px-2.5 text-[11px] border border-emerald-500/20 text-emerald-400 rounded-xl hover:bg-emerald-500/10 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-45 disabled:cursor-not-allowed'
  const buttonLabel = label || '进入项目端口'

  const openProxyPort = (port: number) => {
    const url = buildCodeServerProxyUrl(vscodeWebUrl, port)
    if (!url) {
      setError('端口 URL 生成失败')
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
    setShowDialog(false)
  }

  const openVscode = () => {
    const url = buildVscodeUrl(vscodeWebUrl, worktreeFolder)
    if (!url) {
      setError('VSCode URL 生成失败')
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
    setShowDialog(false)
  }

  const openSshForwardDialog = () => {
    if (autoPort === null) {
      setError('当前项目没有活跃端口，请先启动项目或手动写入端口')
      return
    }
    setLocalForwardPort(prev => normalizePortInput(prev) === null ? String(autoPort) : prev)
    setError('')
    setShowSshForwardDialog(true)
  }

  const openLocalForwardTarget = (port: number) => {
    window.open(`http://localhost:${port}/`, '_blank', 'noopener,noreferrer')
    setShowSshForwardDialog(false)
    setShowDialog(false)
  }

  const saveManualPort = async () => {
    const port = normalizePortInput(manualPort)
    if (port === null) {
      setError('请输入 1-65535 的整数端口')
      return
    }
    if (!projectId) return
    setSaving(true)
    setError('')
    try {
      await api(`/api/projects/${projectId}/main-project-port`, {
        method: 'POST',
        body: JSON.stringify({ port }),
      })
      setAutoPort(port)
      openProxyPort(port)
    } catch (e: any) {
      setError(e?.message || '保存项目端口失败')
    } finally {
      setSaving(false)
    }
  }

  if (!ready) return null

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setShowDialog(true)
          setShowSshForwardDialog(false)
          setManualOpen(false)
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

      {showDialog && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center px-4" onClick={() => {
          setShowDialog(false)
          setShowSshForwardDialog(false)
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
              {autoPort !== null && (
                <button
                  type="button"
                  onClick={() => openProxyPort(autoPort)}
                  className="w-full min-h-[58px] px-3 py-2.5 rounded-lg border text-left bg-[var(--bg-primary)] transition-colors hover:bg-emerald-500/10 hover:border-emerald-500/30"
                  style={{ borderColor: 'var(--border-color)' }}
                >
                  <div className="flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    <ExternalLink className="w-3.5 h-3.5 text-emerald-400" />
                    自动
                  </div>
                  <div className="mt-1 text-[11px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>
                    proxy/{autoPort}/
                  </div>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setManualOpen(v => !v)
                  setError('')
                }}
                className="w-full min-h-[58px] px-3 py-2.5 rounded-lg border text-left bg-[var(--bg-primary)] transition-colors hover:bg-blue-500/10 hover:border-blue-500/30"
                style={{ borderColor: 'var(--border-color)' }}
              >
                <div className="flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  <ExternalLink className="w-3.5 h-3.5 text-blue-400" />
                  手动输入端口
                </div>
                <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  保存到 {HIDDEN_FOLDER_NAME}/port_forward/main_project_port.txt 后打开
                </div>
              </button>

              {manualOpen && (
                <div className="rounded-lg border p-3 bg-[var(--bg-primary)]" style={{ borderColor: 'var(--border-color)' }}>
                  <div className="flex items-center gap-2">
                    <input
                      value={manualPort}
                      onChange={e => {
                        setManualPort(e.target.value)
                        setError('')
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter') saveManualPort()
                      }}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      placeholder="例如 9090"
                      className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-[12px] outline-none focus:border-blue-400"
                      style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                    />
                    <button
                      type="button"
                      onClick={saveManualPort}
                      disabled={saving}
                      className="h-8 px-3 rounded-md bg-blue-500 text-white text-[12px] inline-flex items-center gap-1.5 disabled:opacity-60"
                    >
                      {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      打开
                    </button>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={openSshForwardDialog}
                className="w-full min-h-[58px] px-3 py-2.5 rounded-lg border text-left bg-[var(--bg-primary)] transition-colors hover:bg-cyan-500/10 hover:border-cyan-500/30"
                style={{ borderColor: 'var(--border-color)' }}
              >
                <div className="flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  <KeyRound className="w-3.5 h-3.5 text-cyan-400" />
                  映射端口访问（从个人PC）
                </div>
                <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  复制 SSH local forward 命令后从本机 localhost 打开
                </div>
              </button>

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
                    发送运行前端的指令
                  </div>
                  <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    让当前 Session 启动项目并写入端口文件
                  </div>
                </button>
              )}

              <button
                type="button"
                onClick={openVscode}
                className="w-full min-h-[58px] px-3 py-2.5 rounded-lg border text-left bg-[var(--bg-primary)] transition-colors hover:bg-purple-500/10 hover:border-purple-500/30"
                style={{ borderColor: 'var(--border-color)' }}
              >
                <div className="flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  <TerminalSquare className="w-3.5 h-3.5 text-purple-400" />
                  高级
                </div>
                <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  打开 VSCode，自行创建多个端口 proxy
                </div>
              </button>

              {error && (
                <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
                  {error}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showSshForwardDialog && autoPort !== null && (
        <SshForwardModal
          config={sshForwardConfig}
          remotePort={autoPort}
          localPort={localForwardPort}
          onLocalPortChange={setLocalForwardPort}
          onClose={() => setShowSshForwardDialog(false)}
          onOpenTarget={openLocalForwardTarget}
        />
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
      <div className="px-2 py-2 max-h-[420px] overflow-y-auto">
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
          />
        )}
      </div>
    </div>
  )
}

function FileTreeLevel({ relPath, depth, dirs, expanded, onToggleDir, onOpenFile, vscodeReady }: {
  relPath: string
  depth: number
  dirs: Record<string, DirState>
  expanded: Set<string>
  onToggleDir: (relPath: string) => void
  onOpenFile: (entry: Entry) => void
  vscodeReady: boolean
}) {
  const state = dirs[relPath]
  if (!state) return null
  if (state.loading) return <div className="text-[11px] py-1 pl-4" style={{ color: 'var(--text-muted)' }}>加载中...</div>
  if (state.error) return <div className="text-[11px] py-1 pl-4 text-red-400">{state.error}</div>
  const entries = state.entries || []
  if (entries.length === 0) {
    return <div className="text-[11px] py-1 pl-4" style={{ color: 'var(--text-muted)' }}>(空目录)</div>
  }
  return (
    <div>
      {entries.map(entry => {
        const childPath = relPath === '/' ? `/${entry.name}` : `${relPath}/${entry.name}`
        const isOpen = expanded.has(childPath)
        if (entry.type === 'dir') {
          return (
            <div key={childPath}>
              <button
                data-tour={fileTourTarget(entry.name)}
                onClick={() => onToggleDir(childPath)}
                className="w-full text-left flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[var(--bg-card-hover)] transition-colors text-[12px]"
                style={{ paddingLeft: `${depth * 16 + 8}px`, color: 'var(--text-primary)' }}>
                <svg className={`w-3 h-3 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <span className="flex-shrink-0">{fileIcon(entry.name, 'dir')}</span>
                <span className="truncate">{entry.name}</span>
              </button>
              {isOpen && (
                <FileTreeLevel
                  relPath={childPath}
                  depth={depth + 1}
                  dirs={dirs}
                  expanded={expanded}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                  vscodeReady={vscodeReady}
                />
              )}
            </div>
          )
        }
        return (
          <button
            key={childPath}
            data-tour={fileTourTarget(entry.name)}
            onClick={() => vscodeReady && onOpenFile(entry)}
            disabled={!vscodeReady}
            title={vscodeReady ? '在 VSCode Web 打开' : '未配置 VSCode Web'}
            className="w-full text-left flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[var(--bg-card-hover)] transition-colors text-[12px] disabled:cursor-default"
            style={{ paddingLeft: `${depth * 16 + 8 + 14}px`, color: vscodeReady ? 'var(--text-primary)' : 'var(--text-muted)' }}>
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
