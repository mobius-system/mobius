import { memo } from 'react'

type SessionStatusChipProps = {
  connected: boolean
  failed: boolean
  pending: boolean
  working: boolean
  waiting: boolean
  done: boolean
}

function SessionStatusChipInner({
  connected,
  failed,
  pending,
  working,
  waiting,
  done,
}: SessionStatusChipProps) {
  type Tone = 'gray' | 'red' | 'amber' | 'green' | 'sky' | 'emerald'
  let label = '空闲'
  let tone: Tone = 'gray'
  let pulse = false

  if (!connected) { label = '已断开'; tone = 'gray' }
  else if (failed) { label = '失败'; tone = 'red' }
  else if (pending) { label = '启动中'; tone = 'amber'; pulse = true }
  else if (working) { label = '执行中'; tone = 'green'; pulse = true }
  else if (waiting) { label = '待命'; tone = 'sky' }
  else if (done) { label = '已结束'; tone = 'emerald' }

  const toneMap: Record<Tone, { text: string; hoverBg: string; hoverBorder: string; dot: string }> = {
    gray:    { text: 'text-gray-400',    hoverBg: 'hover:bg-gray-500/10',    hoverBorder: 'hover:border-gray-500/20',    dot: 'bg-gray-400' },
    red:     { text: 'text-red-400',     hoverBg: 'hover:bg-red-500/10',     hoverBorder: 'hover:border-red-500/20',     dot: 'bg-red-400' },
    amber:   { text: 'text-amber-400',   hoverBg: 'hover:bg-amber-500/10',   hoverBorder: 'hover:border-amber-500/20',   dot: 'bg-amber-400' },
    green:   { text: 'text-green-400',   hoverBg: 'hover:bg-green-500/10',   hoverBorder: 'hover:border-green-500/20',   dot: 'bg-green-400' },
    sky:     { text: 'text-sky-400',     hoverBg: 'hover:bg-sky-500/10',     hoverBorder: 'hover:border-sky-500/20',     dot: 'bg-sky-400' },
    emerald: { text: 'text-emerald-400', hoverBg: 'hover:bg-emerald-500/10', hoverBorder: 'hover:border-emerald-500/20', dot: 'bg-emerald-400' },
  }
  const t = toneMap[tone]

  return (
    <span
      data-tour="session-status"
      aria-label={`会话状态：${label}`}
      className={`group h-[22px] rounded-full flex-shrink-0 border border-transparent inline-flex items-center gap-0 px-0 transition-all duration-200 hover:gap-1.5 hover:px-2 ${t.text} ${t.hoverBg} ${t.hoverBorder}`}
    >
      <span className="relative inline-flex w-1.5 h-1.5 flex-shrink-0">
        {pulse && <span className={`absolute inset-0 rounded-full ${t.dot} animate-ping opacity-75`} />}
        <span className={`relative inline-flex rounded-full w-1.5 h-1.5 ${t.dot}`} />
      </span>
      <span className="max-w-0 overflow-hidden whitespace-nowrap text-[11px] opacity-0 transition-all duration-200 group-hover:max-w-16 group-hover:opacity-100">
        {label}
      </span>
    </span>
  )
}

export const SessionStatusChip = memo(SessionStatusChipInner)
