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

  const toneMap: Record<Tone, { text: string; bg: string; border: string; dot: string }> = {
    gray:    { text: 'text-gray-400',    bg: 'bg-gray-500/10',    border: 'border-gray-500/20',    dot: 'bg-gray-400' },
    red:     { text: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/20',     dot: 'bg-red-400' },
    amber:   { text: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   dot: 'bg-amber-400' },
    green:   { text: 'text-green-400',   bg: 'bg-green-500/10',   border: 'border-green-500/20',   dot: 'bg-green-400' },
    sky:     { text: 'text-sky-400',     bg: 'bg-sky-500/10',     border: 'border-sky-500/20',     dot: 'bg-sky-400' },
    emerald: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', dot: 'bg-emerald-400' },
  }
  const t = toneMap[tone]

  return (
    <span data-tour="session-status" className={`text-[11px] px-2 py-0.5 rounded-full flex-shrink-0 border inline-flex items-center gap-1.5 ${t.text} ${t.bg} ${t.border}`}>
      <span className="relative inline-flex w-1.5 h-1.5">
        {pulse && <span className={`absolute inset-0 rounded-full ${t.dot} animate-ping opacity-75`} />}
        <span className={`relative inline-flex rounded-full w-1.5 h-1.5 ${t.dot}`} />
      </span>
      {label}
    </span>
  )
}

export const SessionStatusChip = memo(SessionStatusChipInner)
