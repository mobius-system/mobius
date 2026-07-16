import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Brain, Puzzle, Rocket, X } from 'lucide-react'
import { api } from '../store'

const AUTO_CONFIRM_SECONDS = 4

// =====================================================================
// SessionStartModal — Session 还没有任何消息时, 进入对话界面就跳出
// 一个居中弹窗, 直接展示 Session 元数据中的 name / description 作为
// "目的 / 待解决的问题", 不需要用户再次输入:
//   - 「立即执行!」 -> 触发 onConfirm(), 由 ChatArea 把元数据拼成消息发出去
//   - 「暂不执行」 -> 触发 onDismiss(), 仅关闭弹窗, 保留欢迎屏供浏览
// =====================================================================
export function SessionStartModal({
  sessionName,
  sessionDescription,
  onConfirm,
  onDismiss,
  autoConfirm = true,
}: {
  sessionName?: string
  sessionDescription?: string
  onConfirm: () => Promise<void> | void
  onDismiss: () => void
  autoConfirm?: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [countdown, setCountdown] = useState(AUTO_CONFIRM_SECONDS)
  const [autoPending, setAutoPending] = useState(autoConfirm)
  const submittingRef = useRef(false)
  const onConfirmRef = useRef(onConfirm)
  onConfirmRef.current = onConfirm

  const handleConfirm = useCallback(async () => {
    if (submittingRef.current) return
    submittingRef.current = true
    setAutoPending(false)
    setLoading(true); setErr('')
    try {
      await onConfirmRef.current()
    } catch (e: any) {
      setErr(e?.message || '发送失败')
    } finally {
      submittingRef.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!autoConfirm) {
      setAutoPending(false)
      return
    }
    if (!autoPending) return
    setCountdown(AUTO_CONFIRM_SECONDS)
    const startedAt = Date.now()
    const interval = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
      setCountdown(Math.max(AUTO_CONFIRM_SECONDS - elapsedSeconds, 0))
    }, 250)
    const timer = setTimeout(() => {
      setAutoPending(false)
      void handleConfirm()
    }, AUTO_CONFIRM_SECONDS * 1000)

    return () => {
      clearInterval(interval)
      clearTimeout(timer)
    }
  }, [autoConfirm, autoPending, handleConfirm])

  const modalHint = loading
    ? '正在发送开始执行指令'
    : autoConfirm && autoPending
      ? `本次 Session 的目的 / 待解决的问题如下, ${countdown} 秒后自动执行`
      : '本次 Session 的目的 / 待解决的问题如下'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 msg-enter"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
    >
      <div
        data-tour="session-start-modal"
        className="rounded-2xl border max-w-md w-full p-6 shadow-2xl"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--bg-card-hover)', color: 'var(--text-primary)' }}>
            <Rocket className="w-5 h-5" strokeWidth={1.75} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>
              是否开始执行?
            </div>
            <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              {modalHint}
            </div>
          </div>
        </div>
        <div
          className="rounded-lg border p-3 mb-5 max-h-[40vh] overflow-auto"
          style={{ borderColor: 'var(--border-color)', background: 'rgba(255,255,255,0.02)' }}
        >
          {sessionName && (
            <div className="mb-2">
              <div
                className="text-[12px] font-medium mb-1"
                style={{ color: 'var(--text-muted)' }}
              >
                Session 目的
              </div>
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {sessionName}
              </div>
            </div>
          )}
          {sessionDescription ? (
            <div className={sessionName ? 'mt-2 pt-2 border-t' : ''} style={{ borderColor: 'var(--border-color)' }}>
              <div
                className="text-[12px] font-medium mb-1"
                style={{ color: 'var(--text-muted)' }}
              >
                待解决的问题
              </div>
              <div className="text-[12.5px] whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                {sessionDescription}
              </div>
            </div>
          ) : (
            !sessionName && (
              <div className="text-[12px] italic" style={{ color: 'var(--text-muted)' }}>
                当前 Session 暂未填写目的与描述
              </div>
            )
          )}
        </div>
        {err && (
          <div className="mb-3 text-[11.5px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {err}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            disabled={loading}
            className="px-4 py-2 text-[12.5px] rounded-lg border transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--border-color)' }}
          >
            暂不执行
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            data-tour="session-start-confirm"
            className="px-5 py-2 text-[12.5px] font-medium rounded-full btn-primary transition-colors shadow-sm disabled:opacity-60 disabled:cursor-wait"
          >
            {loading ? '发送中...' : autoConfirm && autoPending ? `立即执行 (${countdown}s)` : '立即执行!'}
          </button>
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// SessionWelcomeCards — Session 对话尚未开始时（无消息、未注入上下文）
// 的欢迎屏：展示当前 Session 范围内可用的 Memory / Skill 列表，
// 并标注每个条目属于 用户级、项目级还是内置。
//
// 数据来源:
//   - 用户级 memory : GET /api/memories
//   - 项目级 memory : GET /api/projects/<projectId>/memories
//   - 用户级 skill  : GET /api/skills
//   - 项目级 skill  : GET /api/projects/<projectId>/skills
// 后端返回的列表项里已带 scope/owner_id 字段, 这里前端为安全起见再次标注.
// =====================================================================

type Scope = 'user' | 'project' | 'builtin'

type Item = {
  id: string
  name: string
  description?: string
  scope?: Scope
}

const SCOPE_STYLE: Record<Scope, { label: string; color: string; bg: string; border: string }> = {
  project: { label: '项目级', color: '#22c55e', bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.25)' },
  user: { label: '用户级', color: '#60a5fa', bg: 'rgba(96,165,250,0.08)', border: 'rgba(96,165,250,0.25)' },
  builtin: { label: '内置', color: '#c084fc', bg: 'rgba(168,85,247,0.08)', border: 'rgba(168,85,247,0.25)' },
}

// 排序: 项目级 → 用户级 → 内置
const scopeOrder = (s?: Scope) => (s === 'project' ? 0 : (s === 'user' ? 1 : 2))

function ScopeBadge({ scope }: { scope: Scope }) {
  const s = SCOPE_STYLE[scope] || SCOPE_STYLE.user
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 border"
      style={{ color: s.color, background: s.bg, borderColor: s.border }}
    >
      {s.label}
    </span>
  )
}

function CardList({
  title,
  hint,
  loading,
  items,
  emptyText,
  icon,
}: {
  title: string
  hint: string
  loading: boolean
  items: Item[]
  emptyText: string
  icon: React.ReactNode
}) {
  return (
    <div
      className="flex flex-col rounded-xl border overflow-hidden"
      style={{ background: 'var(--bg-tertiary, rgba(255,255,255,0.02))', borderColor: 'var(--border-color)' }}
    >
      <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border-color)' }}>
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <div className="min-w-0">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</div>
            <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{hint}</div>
          </div>
        </div>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)' }}
        >
          {loading ? '...' : items.length}
        </span>
      </div>
      <div className="flex-1 max-h-72 overflow-auto p-2 space-y-1.5">
        {loading ? (
          <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
        ) : items.length === 0 ? (
          <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>{emptyText}</div>
        ) : (
          items.map((it) => (
            <div
              key={it.id}
              className="p-2 rounded-lg border"
              style={{ background: 'rgba(255,255,255,0.015)', borderColor: 'rgba(255,255,255,0.04)' }}
            >
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[12px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {it.name}
                </span>
                <ScopeBadge scope={it.scope ?? 'user'} />
              </div>
              {it.description && (
                <p className="text-[10.5px] line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                  {it.description}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// =====================================================================
// SessionSkillMemoryEditor — 右栏底部, 只读展示当前 session 创建时定型的
// skill / memory 选择快照. 创建后不再读取全局列表计算勾选状态, 避免全局
// Skill/Memory 后续变化导致本 Session 展示漂移.
// =====================================================================
type EditorItem = {
  id: string
  name: string
  description?: string
  scope: Scope
  enabled?: boolean
}

interface SelectionSnapshotResponse {
  snapshot: {
    skills?: EditorItem[]
    memories?: EditorItem[]
    all_skills?: EditorItem[]
    all_memories?: EditorItem[]
    totals?: { skills?: number; memories?: number }
  }
  snapshot_at?: string | null
  source?: 'created' | 'context' | 'live'
  legacy?: boolean
}

function formatSnapshotTime(iso?: string | null) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch { return iso }
}

export function SessionSkillMemoryEditor({
  sessionId,
}: {
  sessionId?: string
}) {
  const [memories, setMemories] = useState<EditorItem[]>([])
  const [skills, setSkills] = useState<EditorItem[]>([])
  const [totals, setTotals] = useState({ skills: 0, memories: 0 })
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null)
  const [source, setSource] = useState<string>('created')
  const [legacy, setLegacy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  // 按钮三态: idle / sending / done. key = `${kind}:${itemId}`
  const [emphasizeState, setEmphasizeState] = useState<Record<string, 'idle' | 'sending' | 'done'>>({})
  const [activePanel, setActivePanel] = useState<null | 'skill' | 'memory'>(null)

  useEffect(() => {
    let cancelled = false
    if (!sessionId) {
      setMemories([])
      setSkills([])
      setTotals({ skills: 0, memories: 0 })
      setSnapshotAt(null)
      setLoading(false)
      return () => { cancelled = true }
    }
    setLoading(true)
    setError('')
    api(`/api/sessions/${sessionId}/selection-snapshot`)
      .then((res: SelectionSnapshotResponse) => {
        if (cancelled) return
        const snap = res.snapshot || {}
        const skillItems = (snap.all_skills && snap.all_skills.length > 0 ? snap.all_skills : snap.skills || [])
          .map((it) => ({ ...it, enabled: it.enabled !== false }))
        const memoryItems = (snap.all_memories && snap.all_memories.length > 0 ? snap.all_memories : snap.memories || [])
          .map((it) => ({ ...it, enabled: it.enabled !== false }))
        const sortFn = (a: EditorItem, b: EditorItem) => {
          if (!!a.enabled !== !!b.enabled) return a.enabled ? -1 : 1
          if (a.scope !== b.scope) return scopeOrder(a.scope) - scopeOrder(b.scope)
          return (a.name || '').localeCompare(b.name || '')
        }
        setSkills(skillItems.sort(sortFn))
        setMemories(memoryItems.sort(sortFn))
        setTotals({
          skills: snap.totals?.skills ?? skillItems.length,
          memories: snap.totals?.memories ?? memoryItems.length,
        })
        setSnapshotAt(res.snapshot_at || null)
        setSource(res.source || 'created')
        setLegacy(!!res.legacy)
      })
      .catch((e: any) => {
        if (cancelled) return
        setError(e?.message || '加载失败')
        setSkills([])
        setMemories([])
        setTotals({ skills: 0, memories: 0 })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [sessionId])

  const handleEmphasize = useCallback(async (kind: 'skill' | 'memory', itemId: string) => {
    if (!sessionId) return
    const key = `${kind}:${itemId}`
    setEmphasizeState((prev) => ({ ...prev, [key]: 'sending' }))
    try {
      await api(`/api/sessions/${sessionId}/emphasize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, id: itemId }),
      })
      setEmphasizeState((prev) => ({ ...prev, [key]: 'done' }))
      setTimeout(() => {
        setEmphasizeState((prev) => {
          if (prev[key] !== 'done') return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
      }, 1500)
    } catch (e: any) {
      setEmphasizeState((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      // 简单的错误提示: 不阻断其他按钮, 用 alert 兜底
      window.alert?.(e?.message || '发送失败')
    }
  }, [sessionId])

  const renderList = (
    items: EditorItem[],
    emptyText: string,
    kind: 'skill' | 'memory',
  ) => {
    if (loading) return <div className="text-[11px] py-2 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
    if (error) return <div className="text-[11px] py-2 text-center text-red-400">{error}</div>
    if (items.length === 0) return <div className="text-[11px] py-2 text-center" style={{ color: 'var(--text-muted)' }}>{emptyText}</div>
    return (
      <div className="space-y-1">
        {items.map(it => {
          const enabled = it.enabled !== false
          const scopeStyle = SCOPE_STYLE[it.scope] || SCOPE_STYLE.user
          const stateKey = `${kind}:${it.id}`
          const btnState = emphasizeState[stateKey] || 'idle'
          const btnLabel = btnState === 'sending' ? '发送中...' : btnState === 'done' ? '✓' : (enabled ? '强调' : '追加')
          const btnDisabled = !sessionId || btnState === 'sending' || btnState === 'done'
          return (
            <div key={it.id}
              className={`flex items-start gap-2 px-2 py-1.5 rounded border text-[11px] ${enabled ? '' : 'opacity-50'}`}
              style={{
                borderColor: 'var(--border-color)',
                background: enabled ? 'rgba(255,255,255,0.02)' : 'transparent',
              }}>
              <input
                type="checkbox"
                checked={enabled}
                disabled
                readOnly
                className="mt-0.5 flex-shrink-0 accent-blue-500"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate" style={{ color: 'var(--text-primary)' }}>{it.name}</span>
                  <span
                    className="text-[9px] px-1 py-px rounded flex-shrink-0 border"
                    style={{
                      color: scopeStyle.color,
                      background: scopeStyle.bg,
                      borderColor: scopeStyle.border,
                    }}>
                    {scopeStyle.label}
                  </span>
                  {!enabled && (
                    <span className="text-[9px] px-1 py-px rounded flex-shrink-0 border" style={{
                      color: 'var(--text-muted)',
                      borderColor: 'var(--border-color)',
                      background: 'rgba(255,255,255,0.02)',
                    }}>
                      未启用
                    </span>
                  )}
                </div>
                {it.description && (
                  <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>{it.description}</div>
                )}
              </div>
              <button
                type="button"
                disabled={btnDisabled}
                onClick={() => handleEmphasize(kind, it.id)}
                className="flex-shrink-0 text-[10px] px-2 py-0.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-wait"
                style={{
                  color: btnState === 'done' ? '#22c55e' : 'var(--text-muted)',
                  borderColor: 'var(--border-color)',
                  background: btnState === 'done' ? 'rgba(34,197,94,0.08)' : 'rgba(255,255,255,0.02)',
                }}
              >
                {btnLabel}
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  const enabledSkills = skills.filter(it => it.enabled !== false).length
  const enabledMemories = memories.filter(it => it.enabled !== false).length
  const skillTotal = totals.skills || skills.length
  const memoryTotal = totals.memories || memories.length

  return (
    <>
      <button
        type="button"
        onClick={() => setActivePanel('skill')}
        className="min-h-9 h-full w-full rounded-lg border px-2 py-2 text-center text-[12px] leading-snug transition-colors hover:bg-blue-500/10 disabled:opacity-40 disabled:cursor-not-allowed inline-flex min-w-0 items-center justify-center gap-1.5 overflow-hidden"
        style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color-strong)' }}
        disabled={loading}
      >
        <Puzzle className="h-3.5 w-3.5 flex-shrink-0 text-blue-400" strokeWidth={1.9} />
        <span className="btn-label">Skill ({enabledSkills}/{skillTotal} 启用)</span>
      </button>
      <button
        type="button"
        onClick={() => setActivePanel('memory')}
        className="min-h-9 h-full w-full rounded-lg border px-2 py-2 text-center text-[12px] leading-snug transition-colors hover:bg-cyan-500/10 disabled:opacity-40 disabled:cursor-not-allowed inline-flex min-w-0 items-center justify-center gap-1.5 overflow-hidden"
        style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color-strong)' }}
        disabled={loading}
      >
        <Brain className="h-3.5 w-3.5 flex-shrink-0 text-cyan-400" strokeWidth={1.9} />
        <span className="btn-label">Memory ({enabledMemories}/{memoryTotal} 启用)</span>
      </button>

      {activePanel && (
        <div className="fixed inset-0 z-[95] flex items-center justify-center px-4" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            aria-label="关闭上下文快照"
            onClick={() => setActivePanel(null)}
          />
          <div
            className="relative flex w-full max-w-[760px] flex-col overflow-hidden rounded-2xl shadow-2xl"
            style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)', maxHeight: 'min(680px, calc(100vh - 48px))' }}
            onClick={e => e.stopPropagation()}
          >
            <header className="flex items-center justify-between gap-3 border-b px-5 py-3" style={{ borderColor: 'var(--border-color)' }}>
              <div className="flex min-w-0 items-center gap-2">
                {activePanel === 'skill'
                  ? <Puzzle className="h-4 w-4 flex-shrink-0 text-blue-400" strokeWidth={1.9} />
                  : <BookOpen className="h-4 w-4 flex-shrink-0 text-cyan-400" strokeWidth={1.9} />}
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {activePanel === 'skill'
                      ? `Skill (${enabledSkills}/${skillTotal} 启用)`
                      : `Memory (${enabledMemories}/${memoryTotal} 启用)`}
                  </div>
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    当前 Session 创建时固定的上下文快照
                    {snapshotAt ? ` · ${formatSnapshotTime(snapshotAt)}` : ''}
                    {legacy ? ' · 兼容模式' : source === 'live' ? ' · 实时来源' : ''}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActivePanel(null)}
                className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--bg-card-hover)]"
                style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {activePanel === 'skill'
                ? renderList(skills, '暂无 Skill', 'skill')
                : renderList(memories, '暂无 Memory', 'memory')}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export function SessionWelcomeCards({ projectId }: { projectId?: string }) {
  const [memories, setMemories] = useState<Item[]>([])
  const [skills, setSkills] = useState<Item[]>([])
  const [memLoading, setMemLoading] = useState(true)
  const [skillLoading, setSkillLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setMemLoading(true)
    const memReqs: Promise<Item[]>[] = [
      api('/api/memories').then((arr: any[]) =>
        (Array.isArray(arr) ? arr : []).map((x) => ({ ...x, scope: 'user' as const })),
      ).catch(() => []),
    ]
    if (projectId) {
      memReqs.push(
        api(`/api/projects/${projectId}/memories`).then((arr: any[]) =>
          (Array.isArray(arr) ? arr : []).map((x) => ({ ...x, scope: 'project' as const })),
        ).catch(() => []),
      )
    }
    Promise.all(memReqs).then((lists) => {
      if (cancelled) return
      const merged = lists.flat()
      merged.sort((a, b) => {
        if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
        return (a.name || '').localeCompare(b.name || '')
      })
      setMemories(merged)
      setMemLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    setSkillLoading(true)
    const skillReqs: Promise<Item[]>[] = [
      api('/api/skills').then((arr: any[]) =>
        (Array.isArray(arr) ? arr : []).map((x) => ({ ...x, scope: 'user' as const })),
      ).catch(() => []),
    ]
    if (projectId) {
      skillReqs.push(
        api(`/api/projects/${projectId}/skills`).then((arr: any[]) =>
          (Array.isArray(arr) ? arr : []).map((x) => ({ ...x, scope: 'project' as const })),
        ).catch(() => []),
      )
    }
    Promise.all(skillReqs).then((lists) => {
      if (cancelled) return
      const merged = lists.flat()
      merged.sort((a, b) => {
        if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
        return (a.name || '').localeCompare(b.name || '')
      })
      setSkills(merged)
      setSkillLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

  return (
    <div className="msg-enter">
      <div className="mb-4 text-center">
        <div className="text-[13px] font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
          Session 尚未开始
        </div>
        <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          发送第一条消息后, 以下 Memory 与 Skill 将随上下文一起注入到 prompt
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <CardList
          title="可用 Memory"
          hint="记忆片段 — 持久化的上下文与个人笔记"
          loading={memLoading}
          items={memories}
          emptyText="暂无 Memory"
          icon={
            <svg className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          }
        />
        <CardList
          title="可用 Skill"
          hint="技能包 — 注入 SKILL.md 供智能体调用"
          loading={skillLoading}
          items={skills}
          emptyText="暂无 Skill"
          icon={
            <svg className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          }
        />
      </div>
    </div>
  )
}
