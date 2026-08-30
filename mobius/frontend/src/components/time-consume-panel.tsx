import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, Clock3, PieChart, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '../store'
import { pollRecursive } from '../services/polling'

type TimeConsumeSegment = {
  kind: string
  label: string
  start_at: string
  end_at: string
  start_offset_ms: number
  duration_ms: number
  line_no?: number | null
  source?: string | null
  open?: boolean
}

type TimeConsumeWaterfallResponse = {
  session_id?: string | null
  jsonl_path?: string | null
  start_at?: string | null
  updated_at?: string | null
  ignored_under_ms?: number
  total_ms?: number
  line_count?: number
  segments?: TimeConsumeSegment[]
  cache?: {
    version?: number
    line_count?: number
    start_at?: string | null
    updated_at?: string | null
    source_sizes?: { primary?: number; mobius?: number }
    mutated?: boolean
  } | null
}

type TimeConsumeView = 'waterfall' | 'pie'

const KIND_LABELS: Record<string, string> = {
  model: '模型推理',
  tool: '工具调用',
  assistant: '智能体',
  user: '用户',
  tool_use: '工具调用',
  tool_result: '工具结果',
  thinking: '思考',
  system: '系统',
  error: '错误',
  attachment: '附件',
  other: '其他',
}

const KIND_COLORS: Record<string, string> = {
  model: '#38bdf8',
  tool: '#a78bfa',
  assistant: '#38bdf8',
  user: '#f59e0b',
  tool_use: '#a78bfa',
  tool_result: '#22c55e',
  thinking: '#fb7185',
  system: '#94a3b8',
  error: '#ef4444',
  attachment: '#14b8a6',
  other: '#64748b',
}

function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.round(ms || 0))
  const totalSeconds = Math.floor(safe / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

function formatClock(value?: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}

function describeArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(cx, cy, radius, endAngle)
  const end = polarToCartesian(cx, cy, radius, startAngle)
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1'
  return [
    'M', cx, cy,
    'L', start.x, start.y,
    'A', radius, radius, 0, largeArcFlag, 0, end.x, end.y,
    'Z',
  ].join(' ')
}

function polarToCartesian(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  const rad = (angle - 90) * Math.PI / 180.0
  return {
    x: cx + (radius * Math.cos(rad)),
    y: cy + (radius * Math.sin(rad)),
  }
}

export default function TimeConsumePanel({ sessionId }: { sessionId?: string }) {
  const [data, setData] = useState<TimeConsumeWaterfallResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<TimeConsumeView>('waterfall')
  const [timelineZoom, setTimelineZoom] = useState(1)
  const [timelinePosition, setTimelinePosition] = useState(1000)

  const load = useCallback(async (signal?: AbortSignal, showSpinner = false) => {
    if (!sessionId) {
      setData(null)
      setLoading(false)
      setRefreshing(false)
      setError('')
      return
    }
    if (showSpinner) setRefreshing(true)
    setError('')
    try {
      const result = await api(`/api/sessions/${sessionId}/time-consume-waterfall`, signal ? { signal } : undefined)
      if (signal?.aborted) return
      setData(result as TimeConsumeWaterfallResponse)
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      if (!signal?.aborted) setError(e?.message || '加载耗时统计失败')
    } finally {
      if (!signal?.aborted) {
        setLoading(false)
        if (showSpinner) setRefreshing(false)
      }
    }
  }, [sessionId])

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setTimelineZoom(1)
    setTimelinePosition(1000)
    void load(undefined, false)
    const stop = pollRecursive((signal) => {
      if (disposed) return
      return load(signal, false)
    }, 12_000, 10_000, { startImmediately: false })
    return () => {
      disposed = true
      stop()
    }
  }, [load])

  const segments = data?.segments || []
  const totalMs = useMemo(() => {
    const fromData = Number(data?.total_ms) || 0
    if (fromData > 0) return fromData
    return segments.reduce((max, segment) => {
      const end = Math.max(0, Number(segment.start_offset_ms) || 0) + Math.max(0, Number(segment.duration_ms) || 0)
      return Math.max(max, end)
    }, 0)
  }, [data?.total_ms, segments])

  const pieSlices = useMemo(() => {
    const map = new Map<string, { key: string; label: string; color: string; duration: number; count: number }>()
    for (const segment of segments) {
      const key = segment.kind || 'other'
      const duration = Math.max(0, Number(segment.duration_ms) || 0)
      const prev = map.get(key)
      if (prev) {
        prev.duration += duration
        prev.count += 1
      } else {
        map.set(key, {
          key,
          label: KIND_LABELS[key] || segment.label || '其他',
          color: KIND_COLORS[key] || KIND_COLORS.other,
          duration,
          count: 1,
        })
      }
    }
    return [...map.values()].sort((a, b) => b.duration - a.duration)
  }, [segments])

  const timelineSegments = useMemo(() => {
    if (!totalMs) return []
    const visibleDuration = totalMs / timelineZoom
    const maxWindowStart = Math.max(0, totalMs - visibleDuration)
    const windowStart = maxWindowStart * timelinePosition / 1000
    const windowEnd = windowStart + visibleDuration
    return segments
      .map((segment) => {
        const segmentStart = Math.max(0, Number(segment.start_offset_ms) || 0)
        const segmentEnd = segmentStart + Math.max(0, Number(segment.duration_ms) || 0)
        const clippedStart = Math.max(segmentStart, windowStart)
        const clippedEnd = Math.min(segmentEnd, windowEnd)
        return {
          ...segment,
          startPercent: (clippedStart - windowStart) / visibleDuration * 100,
          widthPercent: Math.max(0, clippedEnd - clippedStart) / visibleDuration * 100,
        }
      })
      .filter((segment) => segment.widthPercent > 0)
  }, [segments, timelinePosition, timelineZoom, totalMs])

  const timelineWindow = useMemo(() => {
    if (!totalMs) return { start: 0, end: 0 }
    const duration = totalMs / timelineZoom
    const maxStart = Math.max(0, totalMs - duration)
    const start = maxStart * timelinePosition / 1000
    return { start, end: Math.min(totalMs, start + duration) }
  }, [timelinePosition, timelineZoom, totalMs])

  const handleClear = useCallback(async () => {
    if (!sessionId || refreshing) return
    setRefreshing(true)
    setError('')
    try {
      await api(`/api/sessions/${sessionId}/time-consume-waterfall/clear`, {
        method: 'POST',
        body: '{}',
      })
      await load(undefined, false)
    } catch (e: any) {
      setError(e?.message || '清空耗时统计失败')
    } finally {
      setRefreshing(false)
    }
  }, [load, refreshing, sessionId])

  const pieTotal = pieSlices.reduce((sum, slice) => sum + slice.duration, 0)
  const pieRadius = 44
  const pieCenter = 60
  let pieCursor = 0

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
            <Clock3 className="h-3.5 w-3.5 text-sky-400" strokeWidth={1.9} />
            <span>耗时</span>
          </div>
          <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {data?.updated_at ? `更新于 ${formatClock(data.updated_at)}` : '等待统计数据'}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void load(undefined, true)}
            disabled={loading || refreshing}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors hover:bg-[var(--bg-card-hover)] disabled:cursor-wait disabled:opacity-50"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color)' }}
            title="刷新"
            aria-label="刷新耗时统计"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading || refreshing ? 'animate-spin' : ''}`} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            onClick={() => void handleClear()}
            disabled={loading || refreshing || !sessionId}
            className="inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[10.5px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:cursor-wait disabled:opacity-50"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color)' }}
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
            清空
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border px-3 py-2 text-[11px] text-red-400" style={{ borderColor: 'rgba(248,113,113,0.28)', background: 'rgba(248,113,113,0.06)' }}>
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="rounded-lg border px-3 py-8 text-center text-[11px]" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-color)', background: 'rgba(255,255,255,0.02)' }}>
          正在加载耗时统计...
        </div>
      ) : !segments.length ? (
        <div className="rounded-lg border px-3 py-8 text-center text-[11px]" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-color)', background: 'rgba(255,255,255,0.02)' }}>
          暂无可统计的耗时段
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex h-7 rounded-md border p-0.5" style={{ borderColor: 'var(--border-color)', background: 'rgba(255,255,255,0.025)' }}>
              {([
                { key: 'waterfall' as const, label: '瀑布', icon: BarChart3 },
                { key: 'pie' as const, label: '占比', icon: PieChart },
              ]).map((item) => {
                const Icon = item.icon
                const active = view === item.key
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setView(item.key)}
                    aria-pressed={active}
                    className="inline-flex min-w-[62px] items-center justify-center gap-1 rounded px-2 text-[10.5px] transition-colors"
                    style={{
                      color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                      background: active ? 'rgba(56,189,248,0.14)' : 'transparent',
                    }}
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.9} />
                    {item.label}
                  </button>
                )
              })}
            </div>
            <div className="text-right text-[10px]" style={{ color: 'var(--text-muted)' }}>
              <div>总计 {formatDuration(totalMs)}</div>
              <div>{segments.length} 段 · {data?.line_count || 0} 行</div>
            </div>
          </div>

          {view === 'waterfall' ? (
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'rgba(255,255,255,0.02)' }}>
              <div className="mb-2 min-w-0">
                <div className="flex items-center gap-2 text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  <BarChart3 className="h-3.5 w-3.5 text-sky-400" strokeWidth={1.9} />
                  <span>瀑布</span>
                </div>
                <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {data?.start_at ? `起点 ${formatClock(data.start_at)}` : '未设置起点'}
                </div>
              </div>
              <div className="mt-1.5 flex items-center gap-3 text-[9.5px]" style={{ color: 'var(--text-muted)' }}>
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: KIND_COLORS.model }} />
                  模型推理 · 上轨
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: KIND_COLORS.tool }} />
                  工具调用 · 下轨
                </span>
              </div>
              <div className="relative h-28 overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-color)', background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015))' }}>
                <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed" style={{ borderColor: 'rgba(255,255,255,0.10)' }} />
                <div className="absolute inset-x-0 top-0 h-full">
                  {timelineSegments.map((segment) => {
                    const onModelTrack = segment.kind === 'model'
                    return (
                      <div
                        key={`${segment.start_at}-${segment.line_no ?? 'n'}-${segment.kind}`}
                        className="absolute overflow-hidden rounded-sm border"
                        title={`${segment.label} · ${formatDuration(segment.duration_ms)} · ${segment.start_at} → ${segment.end_at}`}
                        style={{
                          left: `${segment.startPercent}%`,
                          top: onModelTrack ? 'calc(25% - 10px)' : 'calc(75% - 10px)',
                          height: 'calc(25% - 4px)',
                          width: `${Math.max(segment.widthPercent, 0.45)}%`,
                          minWidth: 4,
                          borderColor: onModelTrack ? 'rgba(125,211,252,0.24)' : 'rgba(196,181,253,0.24)',
                          background: onModelTrack
                            ? 'linear-gradient(180deg, rgba(56,189,248,0.88) 0%, rgba(2,132,199,0.74) 100%)'
                            : 'linear-gradient(180deg, rgba(167,139,250,0.88) 0%, rgba(124,58,237,0.74) 100%)',
                          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.14)',
                        }}
                      />
                    )
                  })}
                </div>
              </div>
              <div className="mt-1 flex items-center justify-between text-[9px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                <span>+{formatDuration(timelineWindow.start)}</span>
                <span>+{formatDuration(timelineWindow.end)}</span>
              </div>

              <div
                className="mt-3 space-y-2.5 border-t pt-2.5"
                style={{ borderColor: 'var(--border-color)' }}
                data-design-id="time-window-controls"
              >
                <label className="grid grid-cols-[68px_minmax(0,1fr)_38px] items-center gap-2">
                  <span className="text-[10.5px]" style={{ color: 'var(--text-secondary)' }}>时间缩放</span>
                  <input
                    type="range"
                    min="1"
                    max="16"
                    step="0.5"
                    value={timelineZoom}
                    onChange={(event) => setTimelineZoom(Number(event.target.value))}
                    className="h-4 w-full cursor-pointer accent-sky-400"
                    aria-label="时间缩放"
                    aria-valuetext={`${timelineZoom.toFixed(timelineZoom % 1 === 0 ? 0 : 1)} 倍`}
                  />
                  <output className="text-right text-[10px] tabular-nums" style={{ color: 'var(--text-primary)' }}>
                    {timelineZoom.toFixed(timelineZoom % 1 === 0 ? 0 : 1)}×
                  </output>
                </label>
                <label className="grid grid-cols-[68px_minmax(0,1fr)_38px] items-center gap-2">
                  <span className="text-[10.5px]" style={{ color: 'var(--text-secondary)' }}>时间定位</span>
                  <input
                    type="range"
                    min="0"
                    max="1000"
                    step="1"
                    value={timelinePosition}
                    onChange={(event) => setTimelinePosition(Number(event.target.value))}
                    disabled={timelineZoom === 1}
                    className="h-4 w-full cursor-pointer accent-violet-400 disabled:cursor-not-allowed disabled:opacity-35"
                    aria-label="时间定位"
                    aria-valuetext={`当前窗口从会话开始后 ${formatDuration(timelineWindow.start)} 到 ${formatDuration(timelineWindow.end)}`}
                  />
                  <output className="text-right text-[10px] tabular-nums" style={{ color: timelineZoom === 1 ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                    {timelineZoom === 1 ? '全段' : `${Math.round(timelinePosition / 10)}%`}
                  </output>
                </label>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'rgba(255,255,255,0.02)' }}>
              <div className="mb-2 flex items-center gap-2 text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>
                <PieChart className="h-3.5 w-3.5 text-sky-400" strokeWidth={1.9} />
                <span>占比</span>
              </div>
              <div className="flex items-center justify-center">
                <svg viewBox="0 0 120 120" className="h-44 w-44" aria-label="耗时占比图">
                  <circle cx={pieCenter} cy={pieCenter} r={pieRadius} fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
                  {pieSlices.length === 0 ? (
                    <circle cx={pieCenter} cy={pieCenter} r={pieRadius} fill="rgba(255,255,255,0.05)" />
                  ) : pieSlices.map((slice, index) => {
                    const start = pieCursor
                    const sweep = pieTotal > 0 ? (slice.duration / pieTotal) * 360 : 0
                    const end = index === pieSlices.length - 1 ? 360 : pieCursor + sweep
                    pieCursor = end
                    return (
                      <path
                        key={slice.key}
                        d={describeArc(pieCenter, pieCenter, pieRadius, start, end)}
                        fill={slice.color}
                        opacity={0.9}
                      />
                    )
                  })}
                  <circle cx={pieCenter} cy={pieCenter} r="24" fill="var(--bg-primary)" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
                  <text x={pieCenter} y={57} textAnchor="middle" className="fill-[var(--text-primary)]" style={{ fontSize: 11, fontWeight: 600 }}>
                    {formatDuration(totalMs)}
                  </text>
                  <text x={pieCenter} y={70} textAnchor="middle" className="fill-[var(--text-muted)]" style={{ fontSize: 8 }}>
                    {segments.length} 段
                  </text>
                </svg>
              </div>
              <div className="mt-2 space-y-1.5">
                {pieSlices.map((slice) => (
                  <div key={slice.key} className="flex items-center gap-2 rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--border-color)', background: 'rgba(255,255,255,0.02)' }}>
                    <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: slice.color }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="truncate" style={{ color: 'var(--text-primary)' }}>{slice.label}</span>
                        <span className="flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{formatDuration(slice.duration)}</span>
                      </div>
                      <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {slice.count} 段 · {pieTotal > 0 ? `${Math.round(slice.duration / pieTotal * 100)}%` : '0%'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
