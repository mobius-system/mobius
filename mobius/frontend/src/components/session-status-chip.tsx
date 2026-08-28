import { memo, type CSSProperties } from 'react'

type SessionStatusChipProps = {
  connected: boolean
  failed: boolean
  pending: boolean
  working: boolean
  waiting: boolean
  done: boolean
  alwaysShowLabel?: boolean
  onNextAction?: () => void
  nextActionLabel?: string
}

function SessionStatusChipInner({
  connected,
  failed,
  pending,
  working,
  waiting,
  done,
  alwaysShowLabel = false,
  onNextAction,
  nextActionLabel,
}: SessionStatusChipProps) {
  type Tone = 'unknown' | 'danger' | 'waiting' | 'running' | 'success'
  let label = '空闲'
  let tone: Tone = 'unknown'
  let pulse = false

  if (!connected) { label = '已断开'; tone = 'unknown' }
  else if (failed) { label = '失败'; tone = 'danger' }
  else if (pending) { label = '启动中'; tone = 'waiting'; pulse = true }
  else if (working) { label = '执行中'; tone = 'running'; pulse = true }
  else if (waiting) { label = '待命'; tone = 'waiting' }
  else if (done) { label = '已结束'; tone = 'success' }

  const toneMap: Record<Tone, string> = {
    unknown: 'var(--status-unknown)',
    danger: 'var(--status-danger)',
    waiting: 'var(--status-waiting)',
    running: 'var(--status-running)',
    success: 'var(--status-success)',
  }
  const toneColor = toneMap[tone]

  const content = (
    <>
      <span className="relative inline-flex w-1.5 h-1.5 flex-shrink-0">
        {pulse && <span className="absolute inset-0 rounded-full animate-ping opacity-75" style={{ background: toneColor }} />}
        <span className="relative inline-flex rounded-full w-1.5 h-1.5" style={{ background: toneColor }} />
      </span>
      <span className={`overflow-hidden whitespace-nowrap text-[11px] transition-all ${alwaysShowLabel ? 'max-w-16 opacity-100' : 'max-w-0 opacity-0 group-hover:max-w-16 group-hover:opacity-100'}`}>
        {label}
      </span>
    </>
  )

  const commonProps = {
    'data-tour': 'session-status',
    'aria-label': nextActionLabel ? `会话状态：${label}；${nextActionLabel}` : `会话状态：${label}`,
    className: `session-status-chip group h-[22px] rounded-full flex-shrink-0 border inline-flex items-center ${alwaysShowLabel ? 'gap-1.5 px-2 border-[var(--border-default)]' : 'gap-0 px-0 border-transparent hover:gap-1.5 hover:px-2'}`,
    style: { '--session-status-color': toneColor } as CSSProperties,
  }

  return onNextAction ? (
    <button
      type="button"
      {...commonProps}
      onClick={onNextAction}
      title={nextActionLabel}
    >
      {content}
    </button>
  ) : (
    <span
      {...commonProps}
    >
      {content}
    </span>
  )
}

export const SessionStatusChip = memo(SessionStatusChipInner)
