import { useEffect, useState } from 'react'
import { Folder } from 'lucide-react'

/*
 * PC task mode block for the new-session wizard: desktop-only (Electron) control that reads
 * and writes the machine-local project path plus the hub/pc/dual work-mode preference through
 * the window.mobiusDesktop bridge.
 */
// PC 任务模式区块 — 仅 electron 桌面端渲染; 用 window.mobiusDesktop 读写本机绑定路径与工作模式偏好
// The PC task mode block, desktop-only: reads/writes the local project path and work mode via the desktop bridge

export function PcTaskModeSection({ projectId, isDark, onModeChange, onPathChange }: { projectId?: string; isDark: boolean; onModeChange?: (m: 'hub' | 'pc' | 'dual') => void; onPathChange?: (p: string) => void }) {
  type Mode = 'hub' | 'pc' | 'dual'
  const md: any = typeof window !== 'undefined' ? (window as any).mobiusDesktop : undefined
  // projectId 兜底从 URL 取: NewSessionModal 某些调用入口未传 projectId, 但用户在项目页时 URL 含 /u/:user/p/:projectId;
  // 与 main.ts handleProjectUrl 存路径用的 projectId 同源, 保证读写 key 一致 (否则读到 ::undefined 这种脏 key).
  const pid = projectId || (typeof window !== 'undefined' ? (window.location.pathname.match(/\/u\/[^/]+\/p\/([^/?#]+)/) || [])[1] : undefined)
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<Mode>('dual')
  // aimux 连接状态: 仅 state==='connected' 时 pc/dual 可用; 未连接 (starting/failed/stopped) 时 pc/dual 灰色禁用并回落 hub.
  const [aimuxConnected, setAimuxConnected] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!md) { setReady(true); return }
    if (!pid) { setReady(true); onModeChange?.('dual'); return }
    let cancelled = false
    // aimux 状态: 初始快照 + 实时订阅 (连接状态会动态变化)
    const unsubStatus = md.onAimuxStatus?.((s: { state?: string } | null | undefined) => {
      if (!cancelled) setAimuxConnected(!!s && s.state === 'connected')
    })
    Promise.all([
      md.getProjectLocalPath?.(pid).then((p: string | null | undefined) => { if (!cancelled) { setPath(p || ''); onPathChange?.(p || '') } }),
      md.getProjectWorkMode?.(pid).then((m: string | null | undefined) => {
        if (cancelled) return
        const valid: Mode = m === 'hub' || m === 'pc' || m === 'dual' ? m : 'dual'
        setMode(valid); onModeChange?.(valid)
      }),
      md.getAimuxStatus?.().then((s: { state?: string } | null | undefined) => { if (!cancelled) setAimuxConnected(!!s && s.state === 'connected') }),
    ]).finally(() => { if (!cancelled) setReady(true) })
    return () => { cancelled = true; unsubStatus?.() }
  }, [md, pid])
  // 不变式: aimux 未连接时 mode 强制回落 hub (pc/dual 不可用). 覆盖初值/用户偏好为 pc/dual 但 aimux 断开的情形.
  useEffect(() => {
    if (!ready) return
    if (!aimuxConnected && mode !== 'hub') {
      setMode('hub'); onModeChange?.('hub')
    }
  }, [aimuxConnected, mode, ready])
  const choosePath = async () => {
    if (!md || !pid) return
    const picked = await md.pickDirectory?.()
    if (!picked) return
    const r = await md.confirmProjectPath?.(pid, picked)
    if (r?.ok) { setPath(picked); onPathChange?.(picked) }
  }
  const chooseMode = (m: Mode) => {
    // aimux 未连接时 pc/dual 不可选 (按钮已 disabled, 此为双保险)
    if (m !== 'hub' && !aimuxConnected) return
    setMode(m); onModeChange?.(m); if (pid) md?.setProjectWorkMode?.(pid, m)
  }
  if (!ready) return null
  const MODES: Array<{ k: Mode; t: string; s: string }> = [
    { k: 'hub', t: '只在 Mobius 中枢工作', s: '会话在服务器跑' },
    { k: 'pc', t: '只在此电脑上工作', s: '调度本机 (aimux)' },
    { k: 'dual', t: '双侧工作', s: '中枢 + 本机 · 默认' },
  ]
  return (
    <div>
      <div className="text-[12px] mb-1.5" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>PC 任务模式</div>
      <div className="flex items-center gap-2 rounded-xl px-3 py-2 mb-2" style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}>
        <Folder className="w-4 h-4 shrink-0" style={{ color: isDark ? '#9ca3af' : '#64748b' }} />
        <div className="flex-1 min-w-0">
          <div className="text-[10px]" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>本机工作路径</div>
          <div className="text-[12px] truncate font-mono" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>{path || '未绑定'}</div>
        </div>
        <button type="button" onClick={choosePath} className="shrink-0 text-[11px] px-2 py-1 rounded border" style={{ borderColor: 'var(--input-border)', color: isDark ? '#93c5fd' : '#2563eb' }}>{path ? '更改' : '选择'}</button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {MODES.map(opt => {
          const active = mode === opt.k
          const disabled = opt.k !== 'hub' && !aimuxConnected
          return (
            <button key={opt.k} type="button" disabled={disabled} onClick={() => chooseMode(opt.k)} title={disabled ? 'aimux 未连接，此模式不可用' : undefined} className="min-h-14 rounded-xl text-left px-2.5 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed" style={{ background: active ? 'rgba(59,130,246,0.12)' : 'var(--input-bg)', border: `1px solid ${active ? '#3b82f6' : 'var(--input-border)'}`, color: isDark ? '#f1f5f9' : '#1e293b' }}>
              <div className="text-[12px] font-medium leading-snug">{opt.t}</div>
              <div className="text-[10px] mt-0.5" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>{opt.s}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
