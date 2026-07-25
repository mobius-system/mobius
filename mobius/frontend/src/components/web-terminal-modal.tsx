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

type Status = 'connecting' | 'connected' | 'closed' | 'error' | 'reconnecting'
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

    // xterm 只创建一次, 重连复用同一个实例 (不清屏, 保留 scrollback).
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

    // 心跳 + 重连状态 (闭包内, 卸载时统一清理).
    const PING_INTERVAL = 25_000        // 每 25s 发一次 ping (< nginx 默认 proxy_read_timeout 60s, 让链路持续有数据流穿越反代, 否则空闲 WS 被反代掐断 = "终端频繁断开").
    const PONG_TIMEOUT = 50_000         // 50s 没收到 pong → 判连接已死, 主动关闭触发重连.
    const MAX_RECONNECT_DELAY = 15_000  // 指数退避上限.
    const MAX_RECONNECT_ATTEMPTS = 8    // 超过则停止重连显示错误 (避免 token 过期等场景无限重连).
    let disposed = false
    let manualClose = false
    let pingTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempts = 0
    let lastPong = Date.now()
    wsRef.current = null

    // 输入 → 当前活动 ws; 窗口变化 → fit + 通知后端 resize. handler 只注册一次, 重连靠 wsRef 切换.
    const sendInput = (data: string) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    }
    const onDataDisp = term.onData(sendInput)
    const onResizeDisp = term.onResize(({ cols, rows }) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    })

    // 容器尺寸变化 → 重排 + 让 xterm 重算 cols/rows (会顺带 onResize 上报后端).
    const ro = new ResizeObserver(() => { try { fit.fit() } catch { /* ignore */ } })
    if (containerRef.current) ro.observe(containerRef.current)

    // 心跳循环: 自递归 setTimeout (非 setInterval — 避免慢网时 ping 包雪球堆积; 每发完一轮才排下一轮).
    const stopPing = () => { if (pingTimer) { clearTimeout(pingTimer); pingTimer = null } }
    const startPing = () => {
      stopPing()
      const tick = () => {
        if (disposed) return
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'ping' })) } catch { /* ignore */ }
        }
        if (Date.now() - lastPong > PONG_TIMEOUT) {
          // 久未收到 pong → 连接已死, 主动关闭触发 onclose → scheduleReconnect (不直接重连, 复用统一流程).
          if (ws) { try { ws.close() } catch { /* ignore */ } }
          return
        }
        pingTimer = setTimeout(tick, PING_INTERVAL)
      }
      pingTimer = setTimeout(tick, PING_INTERVAL)
    }

    const scheduleReconnect = () => {
      if (disposed || manualClose) return
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        setStatus('error'); setErrMsg('多次重连失败, 请关闭弹窗后重新打开'); return
      }
      const delay = Math.min(MAX_RECONNECT_DELAY, 1000 * 2 ** reconnectAttempts)
      reconnectAttempts += 1
      setStatus('reconnecting')
      reconnectTimer = setTimeout(() => { if (!disposed && !manualClose) connect() }, delay)
    }

    const connect = () => {
      if (disposed || manualClose) return
      setStatus(reconnectAttempts === 0 ? 'connecting' : 'reconnecting')
      let ws: WebSocket
      try { ws = new WebSocket(url) } catch { scheduleReconnect(); return }
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        reconnectAttempts = 0
        lastPong = Date.now()
        setErrMsg('')
        setStatus('connected')
        // 首连/重连都同步当前窗口尺寸给后端 pty, 避免错位.
        try { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })) } catch { /* ignore */ }
        startPing()
      }
      ws.onmessage = (ev) => {
        const d = ev.data
        if (d instanceof ArrayBuffer) { term.write(new Uint8Array(d)); return }
        if (typeof d !== 'string') return
        // 信封: {type:'data',data} (pty 输出) | {type:'pong'} (心跳回复). 解析失败兜底原样写 (兼容).
        let msg: any
        try { msg = JSON.parse(d) } catch { term.write(d); return }
        if (msg && msg.type === 'pong') { lastPong = Date.now(); return }
        if (msg && msg.type === 'data' && typeof msg.data === 'string') { term.write(msg.data); return }
        term.write(d)
      }
      ws.onclose = (ev) => {
        stopPing()
        wsRef.current = null
        if (manualClose || disposed) { setStatus('closed'); return }
        // code 1000 正常关闭 (如用户输入 exit → pty 退出) 不重连; 其余 (1006 网络断/4000 心跳超时/1011) 重连.
        if (ev.code === 1000) { setStatus('closed'); return }
        scheduleReconnect()
      }
      ws.onerror = () => {
        if (reconnectAttempts === 0) setErrMsg('连接出错 (可能未登录或会话无权限)')
      }
    }

    connect()

    return () => {
      disposed = true
      manualClose = true
      onDataDisp.dispose()
      onResizeDisp.dispose()
      ro.disconnect()
      stopPing()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      const ws = wsRef.current
      if (ws) { try { ws.close() } catch { /* ignore */ } }
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
    reconnecting: { label: '重连中', color: '#fbbf24' },
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
