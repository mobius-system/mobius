/**
 * viewer/LiveTailCard.tsx — 实时尾部卡.
 *
 * 从 jsonl-view.tsx 拆出. agent 进程活着但 jsonl 没新内容时显示, 计算沉默时长.
 * 也是用户判断 "agent 卡死了 vs 还在 thinking" 的唯一可信号.
 *   0~30s   绿  正常生成中
 *   30~120s 琥珀 沉默较久, API 可能长尾
 *   120s+   红  长时间没输出, 建议终止重试
 */
import { useEffect, useRef, useState } from 'react'
import { formatDuration } from './utils'

export function JsonlLiveTailCard({ lastTimestamp, pid, realTimeInfo }: { lastTimestamp: string | null | undefined; pid: number | null | undefined; realTimeInfo?: string | null }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  // realTimeInfo (来自 /status): agent TUI 当前状态行, 如 "✻ Propagating… (7m 44s · ↓ 24.1k tokens)".
  // 前端 TTL 5s: 每次轮询带回非空值就刷新计时并展示它; 后端连续 5s 不再给非空值 → fallback 回
  // 下面的 "生成中 · 距上条 entry Xs" / 沉默文案. ref 在 render 中更新是刻意的 —— 每次非空轮询
  // 都要刷新 TTL, 即便值相同 (claude 状态行的分秒/token 一直在变, 几乎不会连续 5s 完全相同).
  // ⚠ useRef 必须在下面的早返回之前无条件调用, 否则 hook 数量随 render 变化 → React #300 崩溃.
  const REALTIME_TTL_MS = 5000
  const liveTextRef = useRef('')
  const liveUntilRef = useRef(0)
  const rt = (realTimeInfo || '').trim()
  if (rt) {
    liveTextRef.current = rt
    liveUntilRef.current = Date.now() + REALTIME_TTL_MS
  }
  const lastMs = lastTimestamp ? new Date(lastTimestamp).getTime() : null
  const silenceSec = lastMs ? Math.max(0, Math.floor((now - lastMs) / 1000)) : null
  // 还没有任何 jsonl entry → 不出 LIVE 卡片 (不再显示 "等首条 entry..." 占位).
  if (silenceSec == null) return null
  const liveActive = !!liveTextRef.current && now <= liveUntilRef.current
  const sev: 'normal' | 'warn' | 'stale' =
    silenceSec < 30 ? 'normal'
    : silenceSec < 120 ? 'warn'
    : 'stale'
  const theme =
    sev === 'normal' ? { border: 'border-emerald-500/15', bg: 'bg-emerald-500/[0.05]', dot: 'bg-emerald-400', text: 'text-emerald-300' }
    : sev === 'warn'   ? { border: 'border-amber-500/15',   bg: 'bg-amber-500/[0.05]',   dot: 'bg-amber-400',   text: 'text-amber-300' }
    :                    { border: 'border-red-500/20',     bg: 'bg-red-500/[0.06]',     dot: 'bg-red-400',     text: 'text-red-300' }

  return (
    <div className={`mb-2 rounded-lg border card-enter ${theme.border} ${theme.bg} px-3 py-2 flex items-center gap-2 text-[12px]`}>
      <span className="relative inline-flex w-2 h-2 flex-shrink-0">
        <span className={`absolute inset-0 rounded-full ${theme.dot} animate-ping opacity-75`} />
        <span className={`relative inline-flex rounded-full w-2 h-2 ${theme.dot}`} />
      </span>
      <span className={`font-mono font-semibold ${theme.text} flex-shrink-0`}>LIVE</span>
      {pid != null && (
        <span className="text-[10px] text-[var(--text-muted)] font-mono flex-shrink-0">pid {pid}</span>
      )}
      <span className="flex-1 text-[11px] truncate" style={{ color: 'var(--text-muted)' }} title={liveActive ? liveTextRef.current : undefined}>
        {liveActive
          ? liveTextRef.current
          : sev === 'normal' ? `生成中 · 距上条 entry ${formatDuration(silenceSec)}`
          : sev === 'warn'   ? `沉默 ${formatDuration(silenceSec)} — API 可能长尾, 继续等等`
          :                    `⚠ 沉默 ${formatDuration(silenceSec)} — API 可能长尾, 请耐心等待`
        }
      </span>
    </div>
  )
}
