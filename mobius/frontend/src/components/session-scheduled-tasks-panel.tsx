import { useCallback, useEffect, useState } from 'react'
import { Clock, Loader2, Plus } from 'lucide-react'
import { api } from '../store'

/*
 * Parse the compact s/m/h/d duration accepted by both the wake-up CLI and this panel.
 */
function parseScheduledWakeupDuration(value: string): number | null {
  const match = value.trim().match(/^([1-9][0-9]*)([smhd])$/)
  if (!match) return null
  const scale: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }
  const seconds = Number(match[1]) * scale[match[2]]
  return Number.isSafeInteger(seconds) && seconds <= 365 * 24 * 60 * 60 ? seconds : null
}

function formatScheduledTime(value?: string | null) {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

/*
 * Session scheduled-task panel: list, create and cancel durable Mobius backend wake-ups.
 * Inline content only — it is embedded inside the session resource sidebar panel.
 */
export function SessionScheduledTasksPanel({ sessionId, refreshKey = 0 }: {
  sessionId?: string
  refreshKey?: number
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mobiusWakeups, setMobiusWakeups] = useState<any[]>([])
  const [wakeupMode, setWakeupMode] = useState<'once' | 'interval'>('once')
  const [wakeupDuration, setWakeupDuration] = useState('30m')
  const [wakeupReminder, setWakeupReminder] = useState('')
  const [wakeupSaving, setWakeupSaving] = useState(false)
  const [wakeupError, setWakeupError] = useState('')

  const load = useCallback(async () => {
    if (!sessionId) {
      setLoading(false)
      setMobiusWakeups([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const wakeupData = await api(`/api/scheduled-wake-ups?session_id=${encodeURIComponent(sessionId)}`)
      setMobiusWakeups(Array.isArray(wakeupData?.wakeups) ? wakeupData.wakeups : [])
    } catch (e: any) {
      setError(e?.message || '读取定时任务失败')
      setMobiusWakeups([])
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => { void load() }, [load, refreshKey])

  const createWakeup = useCallback(async () => {
    const seconds = parseScheduledWakeupDuration(wakeupDuration)
    if (seconds == null) {
      setWakeupError('时长格式必须为正整数 + s/m/h/d，且不超过 365d')
      return
    }
    if (wakeupMode === 'interval' && seconds < 600) {
      setWakeupError('周期唤醒最短间隔为 10m')
      return
    }
    const reminder = wakeupReminder.trim()
    if (!reminder) {
      setWakeupError('请填写唤醒后要执行的提醒内容')
      return
    }
    setWakeupSaving(true)
    setWakeupError('')
    try {
      await api('/api/scheduled-wake-ups', {
        method: 'POST',
        body: JSON.stringify({
          session_id: sessionId,
          mode: wakeupMode,
          ...(wakeupMode === 'once' ? { after_seconds: seconds } : { interval_seconds: seconds }),
          reminder,
        }),
      })
      setWakeupReminder('')
      await load()
    } catch (e: any) {
      setWakeupError(e?.message || '创建定时唤醒失败')
    } finally {
      setWakeupSaving(false)
    }
  }, [load, sessionId, wakeupDuration, wakeupMode, wakeupReminder])

  const cancelAllWakeups = useCallback(async () => {
    if (!window.confirm(`确定取消本 Session 的 ${mobiusWakeups.length} 个 Mobius 定时唤醒吗？`)) return
    setWakeupSaving(true)
    setWakeupError('')
    try {
      await api(`/api/scheduled-wake-ups?session_id=${encodeURIComponent(sessionId || '')}`, { method: 'DELETE' })
      await load()
    } catch (e: any) {
      setWakeupError(e?.message || '取消定时唤醒失败')
    } finally {
      setWakeupSaving(false)
    }
  }, [load, mobiusWakeups.length, sessionId])

  if (loading && !mobiusWakeups.length) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> 读取中...
      </div>
    )
  }

  if (error) {
    // 读取失败按空列表处理，用户可点右上角刷新重试
    // A failed read falls back to an empty list; the refresh button retries
    return (
      <pre className="whitespace-pre-wrap break-words rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-[length:var(--fs-sm)] text-red-300">{error}</pre>
    )
  }

  return (
    <section data-testid="mobius-scheduled-wakeups-section" className="rounded-xl border p-3" style={{ borderColor: 'rgba(96,165,250,0.3)', background: 'rgba(59,130,246,0.05)' }}>
      <div className="flex items-start gap-2">
        <Clock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-400" strokeWidth={1.9} />
        <div className="min-w-0 flex-1">
          <div className="text-[length:var(--fs-md)] font-semibold" style={{ color: 'var(--text-primary)' }}>Mobius 定时任务</div>
        </div>
        {mobiusWakeups.length > 0 && (
          <button type="button" onClick={() => void cancelAllWakeups()} disabled={wakeupSaving}
            className="flex-shrink-0 rounded-md border border-red-500/30 px-2 py-1 text-[length:var(--fs-xs)] text-red-300 transition-colors hover:bg-red-500/10 disabled:opacity-40">
            全部取消
          </button>
        )}
      </div>

      {/* <div className="mt-3 space-y-2">
        <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2">
          <select value={wakeupMode} onChange={e => {
            const next = e.target.value === 'interval' ? 'interval' : 'once'
            setWakeupMode(next)
            setWakeupDuration(next === 'interval' ? '1h' : '30m')
            setWakeupError('')
          }} aria-label="唤醒模式"
            className="h-8 rounded-md border px-2 text-[length:var(--fs-sm)] outline-none"
            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color-strong)', color: 'var(--text-primary)' }}>
            <option value="once">单次</option>
            <option value="interval">周期</option>
          </select>
          <input value={wakeupDuration} onChange={e => { setWakeupDuration(e.target.value); setWakeupError('') }}
            aria-label={wakeupMode === 'once' ? '多久后唤醒' : '唤醒间隔'} placeholder={wakeupMode === 'once' ? '30m' : '1h'}
            className="h-8 min-w-0 rounded-md border px-2 font-mono text-[length:var(--fs-sm)] outline-none"
            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color-strong)', color: 'var(--text-primary)' }} />
        </div>
        <input value={wakeupReminder} onChange={e => { setWakeupReminder(e.target.value); setWakeupError('') }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void createWakeup() }}
          aria-label="唤醒提醒" placeholder="唤醒后要执行的工作"
          className="h-8 w-full rounded-md border px-2 text-[length:var(--fs-sm)] outline-none"
          style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color-strong)', color: 'var(--text-primary)' }} />
        <button type="button" data-testid="create-mobius-wakeup" onClick={() => void createWakeup()} disabled={wakeupSaving}
          className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-blue-400/30 bg-blue-500/10 px-3 text-[length:var(--fs-sm)] text-blue-300 transition-colors hover:bg-blue-500/20 disabled:opacity-40">
          {wakeupSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          创建
        </button>
      </div>
      <div className="mt-1.5 text-[length:var(--fs-2xs)]" style={{ color: 'var(--text-muted)' }}>时长格式：30s、10m、2h、1d；周期唤醒最短 10m</div> */}
      {wakeupError && <div className="mt-2 text-[length:var(--fs-xs)] text-red-300">{wakeupError}</div>}

      {mobiusWakeups.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed py-4 text-center text-[length:var(--fs-sm)]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>暂无 Mobius 后台定时唤醒</div>
      ) : (
        <div className="mt-3 space-y-2">
          {mobiusWakeups.map((item: any) => (
            <div key={item.id} data-testid="mobius-wakeup-card" className="rounded-lg border px-2.5 py-2" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fs-xs)]">
                <span className="rounded px-1.5 py-0.5" style={{ background: item.mode === 'interval' ? 'rgba(139,92,246,0.14)' : 'rgba(34,197,94,0.12)', color: item.mode === 'interval' ? '#c4b5fd' : '#86efac' }}>
                  {item.mode === 'interval' ? '周期' : '单次'}
                </span>
                <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{item.schedule_seconds % 86400 === 0 ? `${item.schedule_seconds / 86400}d` : item.schedule_seconds % 3600 === 0 ? `${item.schedule_seconds / 3600}h` : item.schedule_seconds % 60 === 0 ? `${item.schedule_seconds / 60}m` : `${item.schedule_seconds}s`}</span>
                <span style={{ color: 'var(--text-muted)' }}>下次 {item.next_run_at ? formatScheduledTime(item.next_run_at) : '-'}</span>
                <span className="ml-auto truncate font-mono text-[length:var(--fs-2xs)]" style={{ color: 'var(--text-muted)' }} title={item.id}>{String(item.id).slice(0, 8)}</span>
              </div>
              <div className="mt-1.5 whitespace-pre-wrap break-words text-[length:var(--fs-sm)] leading-relaxed" style={{ color: 'var(--text-primary)' }}>{item.reminder}</div>
              {item.last_status === 'error' && item.last_error && <div className="mt-1 text-[length:var(--fs-2xs)] text-red-300">上次触发失败：{item.last_error}</div>}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
