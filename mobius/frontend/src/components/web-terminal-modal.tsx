// web-terminal-modal.tsx — 会话内 Web 终端弹窗 (xterm.js + 鉴权 WS).
//
// 由 ChatArea 在 terminalOpen 时条件渲染: 挂载即建连 + 起 xterm, 卸载即断连 + dispose.
// 后端 /api/terminal/ws?sid=&token= → node-pty, cwd 取 session 所属项目 bind_path.
// 消息协议见 backend/routes/web-terminal.ts 注释 (FE→BE JSON 信封, BE→FE 原样 pty 输出).
import { useEffect, useRef, useState } from 'react'
import { Terminal, X } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store'

type Status = 'connecting' | 'connected' | 'closed' | 'error'
export type WebTerminalMode = 'cwd' | 'agent'

export function WebTerminalModal({ sessionId, mode = 'cwd', onClose }: { sessionId: string | undefined; mode?: WebTerminalMode; onClose: () => void }) {
  const { theme, token } = useStore()
  const isDark = theme !== 'light'
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    if (!sessionId) { setErrMsg('当前没有活动会话, 无法打开终端'); setStatus('error'); return }
    if (!token) { setErrMsg('未登录, 无法打开终端'); setStatus('error'); return }

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Noto Sans SC", monospace',
      fontSize: 13,
      theme: isDark
        ? { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3', selectionBackground: 'rgba(255,255,255,0.22)' }
        : { background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', selectionBackground: 'rgba(0,0,0,0.18)' },
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current!)
    termRef.current = term
    fitRef.current = fit
    try { fit.fit() } catch { /* 容器还没尺寸, 忽略, RO 会重试 */ }
    term.focus()

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/api/terminal/ws?sid=${encodeURIComponent(sessionId)}&mode=${encodeURIComponent(mode)}&token=${encodeURIComponent(token)}`
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (e) {
      setErrMsg('建立 WebSocket 失败'); setStatus('error'); return
    }
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('connected')
      // 同步初始窗口大小给后端 pty, 避免前几行错位.
      try { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })) } catch { /* ignore */ }
    }
    ws.onmessage = (ev) => {
      const d = ev.data
      if (typeof d === 'string') term.write(d)
      else if (d instanceof ArrayBuffer) term.write(new Uint8Array(d))
    }
    ws.onclose = () => setStatus(s => (s === 'error' ? s : 'closed'))
    ws.onerror = () => { setErrMsg('连接出错 (可能未登录或会话无权限)'); setStatus('error') }

    // 输入 → 后端; 窗口变化 → fit + 通知后端 resize (fit 改 dims 会触发 onResize).
    const sendInput = (data: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data })) }
    const onDataDisp = term.onData(sendInput)
    const onResizeDisp = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    })

    // 容器尺寸变化 → 重排 + 让 xterm 重算 cols/rows (会顺带 onResize 上报后端).
    const ro = new ResizeObserver(() => { try { fit.fit() } catch { /* ignore */ } })
    if (containerRef.current) ro.observe(containerRef.current)

    return () => {
      onDataDisp.dispose()
      onResizeDisp.dispose()
      ro.disconnect()
      try { ws.close() } catch { /* ignore */ }
      wsRef.current = null
      try { term.dispose() } catch { /* ignore */ }
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const statusMeta: Record<Status, { label: string; color: string }> = {
    connecting: { label: '连接中', color: '#fbbf24' },
    connected: { label: '已连接', color: '#34d399' },
    closed: { label: '已断开', color: '#94a3b8' },
    error: { label: '错误', color: '#f87171' },
  }
  const sm = statusMeta[status]

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative flex flex-col overflow-hidden rounded-2xl shadow-2xl"
        style={{ width: 'min(92vw, 1100px)', height: 'min(82vh, 720px)', background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: 'var(--border-color)' }}>
          <Terminal className="h-4 w-4 flex-shrink-0" strokeWidth={1.75} style={{ color: 'var(--text-secondary)' }} />
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {mode === 'agent' ? 'Agent 后台终端' : 'Web 终端'}
          </span>
          {sessionId && (
            <span className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
              sid: {sessionId.slice(0, 8)}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5 text-[11px]" style={{ color: sm.color }}>
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: sm.color }} />
            {sm.label}
          </span>
          <button
            onClick={onClose}
            title="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-xl border transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* 终端主体 (padding 框颜色与 xterm 背景一致, 避免亮色主题出现暗框) */}
        <div className="relative min-h-0 flex-1 p-2" style={{ background: isDark ? '#0d1117' : '#ffffff' }}>
          <div ref={containerRef} className="h-full w-full" />
          {(status === 'error' || status === 'closed') && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 backdrop-blur-sm">
              <span className="text-[13px]" style={{ color: status === 'error' ? '#f87171' : '#cbd5e1' }}>
                {errMsg || (status === 'closed' ? '终端连接已断开' : '')}
              </span>
              <span className="text-[11px]" style={{ color: '#94a3b8' }}>关闭弹窗后可重新打开</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
