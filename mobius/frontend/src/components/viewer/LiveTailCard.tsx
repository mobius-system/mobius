/**
 * viewer/LiveTailCard.tsx — 实时尾部卡.
 *
 * 从 jsonl-view.tsx 拆出. agent 进程活着但 jsonl 没新内容时显示, 计算沉默时长.
 * 也是用户判断 "agent 卡死了 vs 还在 thinking" 的唯一可信号.
 *   0~30s   绿  正常生成中
 *   30~120s 琥珀 沉默较久, API 可能长尾
 *   120s+   红  长时间没输出, 建议终止重试
 * optimistic=true 时 (刚提交问题, 后端还没报 working) 固定按绿色"等待响应"渲染, 不判沉默.
 * easyMode=true 时使用简易模式微缩步骤卡的紧凑外观.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { formatDuration } from './utils'

function VirtualLiveTextBox({ text, cursorClassName }: { text: string; cursorClassName: string }) {
  const viewportRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
  }, [text])

  return (
    <div
      ref={viewportRef}
      className="h-[1.3em] min-w-0 flex-1 overflow-hidden text-[11px] leading-[1.2]"
      style={{ color: 'var(--text-muted)' }}
      title={text}
    >
      <span className="block whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {text}
        <span aria-hidden="true" className={`font-mono text-[12px] leading-none ${cursorClassName} animate-pulse`}>
          ▍
        </span>
      </span>
    </div>
  )
}

function LegacyLiveText({ text }: { text: string }) {
  return (
    <span
      className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px]"
      style={{ color: 'var(--text-muted)' }}
      title={text}
    >
      {text}
    </span>
  )
}

export function JsonlLiveTailCard({ lastTimestamp, pid, realTimeInfo, liveTokenText, optimistic = false, easyMode = false }: { lastTimestamp: string | null | undefined; pid: number | null | undefined; realTimeInfo?: string | null; liveTokenText?: string | null; optimistic?: boolean; easyMode?: boolean }) {
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
  // 例外: 乐观窗 (刚提交 / 发送阶段, 会话正在启动) 内照常出卡, 按下面的"已提交 · 等待智能体响应…"
  // 渲染 — 此时无沉默时长可算, 但卡片本身就是"消息已发出、正在唤醒"的可视信号.
  if (silenceSec == null && !optimistic) return null
  const tokenText = liveTokenText || ''
  const liveActive = tokenText.length > 0
  // 乐观窗 (刚提交 / 发送阶段, 后端还没报 working) 内不按沉默时长判严重度: 此时 lastTimestamp 参照的
  // 还是上一条历史 entry, 照常渲染会闪一条"沉默 Xm"红卡, 与"刚提交"的动作相悖. 无 entry 时更是
  // 无处可算 (silenceSec=null), 一并归到同一分支.
  const silenceForSeverity = optimistic ? null : silenceSec
  const sev: 'normal' | 'warn' | 'stale' =
    silenceForSeverity == null ? 'normal'
    : silenceForSeverity < 30 ? 'normal'
    : silenceForSeverity < 120 ? 'warn'
    : 'stale'
  const fallbackText = silenceForSeverity == null ? '已提交 · 等待智能体响应…'
    : sev === 'normal' ? `生成中 · 距上条 entry ${formatDuration(silenceForSeverity)}`
    : sev === 'warn'   ? `沉默 ${formatDuration(silenceForSeverity)} — API 可能长尾, 继续等等`
    :                    `⚠ 沉默 ${formatDuration(silenceForSeverity)} — API 可能长尾, 请耐心等待`
  const legacyText = liveTextRef.current && now <= liveUntilRef.current
    ? liveTextRef.current
    : fallbackText
  const theme =
    sev === 'normal' ? { border: 'border-emerald-500/15', bg: 'bg-emerald-500/[0.05]', dot: 'bg-emerald-400', text: 'text-emerald-300', accent: '#34d399' }
    : sev === 'warn'   ? { border: 'border-amber-500/15',   bg: 'bg-amber-500/[0.05]',   dot: 'bg-amber-400',   text: 'text-amber-300',   accent: '#fbbf24' }
    :                    { border: 'border-red-500/20',     bg: 'bg-red-500/[0.06]',     dot: 'bg-red-400',     text: 'text-red-300',     accent: '#f87171' }

  return (
    <div
      // 简易模式 LIVE 卡左右内边距和图标间距各放宽一档，标准模式保持紧凑
      // Easy mode widens the LIVE card's horizontal padding and gap one step, standard stays compact
      className={`mb-2 rounded-lg border card-enter jsonl-live-sweep ${easyMode ? 'jsonl-live-tail-card--easy px-4 gap-3' : 'px-3 gap-2'} py-2 flex items-center text-[12px]`}
      style={{ ['--live-accent' as string]: theme.accent } as CSSProperties}>
      <span className="relative inline-flex w-2 h-2 flex-shrink-0">
        <span className={`absolute inset-0 rounded-full ${theme.dot} animate-ping opacity-75`} />
        <span className={`relative inline-flex rounded-full w-2 h-2 ${theme.dot}`} />
      </span>
      <span className={`font-mono font-semibold ${theme.text} flex-shrink-0`}>LIVE</span>
      {/* 用户要求移除 pid 显示，不再需要
      {pid != null && (
        <span className="text-[10px] text-[var(--text-muted)] font-mono flex-shrink-0">pid {pid}</span>
      )}
      */}
      {liveActive
        ? <VirtualLiveTextBox text={tokenText} cursorClassName={theme.text} />
        : <LegacyLiveText text={legacyText} />}
    </div>
  )
}
