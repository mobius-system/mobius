import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ExternalLink, Loader2, RotateCw, TerminalSquare } from 'lucide-react'
import { buildVscodeUrl } from '../project-files'

// =====================================================================
// EditorPane — 嵌入 code-server 的左侧编辑器面板.
// src 复用 buildVscodeUrl(vscodeWebUrl, bindPath); 只接受同源 /code-server/ URL,
// 不引入 Monaco/CodeMirror. 底部终端 / Problems / Output 全部由 code-server 原生提供,
// 本组件不操作 iframe 内部 DOM (依赖其内部结构会在 code-server 升级后失效).
//
// 状态: loading -> ready(onLoad) ; src 非法 -> 内联错误占位; >20s 未加载完 -> 慢加载提示.
// 工具栏只提供宿主层能力: 项目名 / leading 插槽 (IssuePage 用来放 Session 切换器) /
// 重新加载 / 新窗口打开 / 终端快捷键提示.
// =====================================================================
type EditorPaneProps = {
  projectName: string
  bindPath: string
  vscodeWebUrl: string
  className?: string
  leading?: ReactNode
}

export function EditorPane({ projectName, bindPath, vscodeWebUrl, className, leading }: EditorPaneProps) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [reloadKey, setReloadKey] = useState(0)
  const [slow, setSlow] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const src = buildVscodeUrl(vscodeWebUrl, bindPath)
  // 安全闸: 只允许同源相对 /code-server/ URL, 拒绝任意外部地址.
  const safe = !!src && src.startsWith('/code-server/')

  useEffect(() => {
    if (!safe) { setLoadState('error'); return }
    setLoadState('loading')
    setSlow(false)
    const t = window.setTimeout(() => setSlow(true), 20000)
    return () => window.clearTimeout(t)
  }, [src, safe, reloadKey])

  const reload = () => setReloadKey(k => k + 1)
  const openInNewWindow = () => { if (src) window.open(src, '_blank', 'noopener,noreferrer') }

  if (!safe) {
    return (
      <div className={`flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center ${className || ''}`} style={{ color: 'var(--text-muted)' }}>
        <TerminalSquare className="w-8 h-8" />
        <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>当前项目未配置 Web 编辑器</div>
        <div className="text-[11px]">需要后端配置 <code>VSCODE_WEB_URL</code> 并绑定项目路径</div>
        {bindPath && <div className="mt-1 text-[11px] font-mono break-all">{bindPath}</div>}
      </div>
    )
  }

  return (
    <div className={`flex h-full w-full flex-col ${className || ''}`} style={{ background: 'var(--bg-primary)' }}>
      {/* 工具栏 */}
      {/* <div className="flex h-8 flex-shrink-0 items-center gap-1 border-b px-2" style={{ borderColor: 'var(--border-color)' }}>
        {leading}
        <span className="truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }} title={projectName}>{projectName}</span>
        <div className="flex-1" />
        <span className="hidden text-[10px] lg:inline" style={{ color: 'var(--text-muted)' }} title="在编辑器中按 Ctrl+` 打开/收起集成终端">终端: Ctrl+`</span>
        <button type="button" onClick={reload} title="重新加载编辑器" aria-label="重新加载编辑器" className="inline-flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
          <RotateCw className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={openInNewWindow} title="在新窗口打开" aria-label="在新窗口打开编辑器" className="inline-flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div> */}

      {/* iframe 区 */}
      <div className="relative flex-1 min-h-0">
        {loadState !== 'ready' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }} data-tour="editor-pane-loading">
            <Loader2 className="w-5 h-5 animate-spin" />
            <div className="text-[12px]">{loadState === 'error' ? '编辑器加载失败' : slow ? '编辑器仍在启动，请稍候…' : '正在启动编辑器…'}</div>
            <div className="mt-1 flex items-center gap-2">
              {loadState === 'error' && (
                <button type="button" onClick={reload} className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] transition-colors hover:bg-[var(--bg-card-hover)]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
                  <RotateCw className="w-3 h-3" />重试
                </button>
              )}
              <button type="button" onClick={openInNewWindow} className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px] transition-colors hover:bg-[var(--bg-card-hover)]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
                <ExternalLink className="w-3 h-3" />在新窗口打开
              </button>
            </div>
          </div>
        )}
        <iframe
          key={reloadKey}
          ref={iframeRef}
          src={src || undefined}
          title={`${projectName} 代码编辑器`}
          onLoad={() => setLoadState('ready')}
          className="h-full w-full border-0"
          referrerPolicy="same-origin"
          allow="clipboard-read; clipboard-write; fullscreen"
        />
      </div>
    </div>
  )
}
