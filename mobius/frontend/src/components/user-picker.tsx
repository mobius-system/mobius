import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../store'

type UserOption = {
  id: string
  display_name: string
  role?: string
}

const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  user: '用户',
}

function labelFor(user: UserOption | undefined) {
  if (!user) return ''
  return user.display_name && user.display_name !== user.id
    ? `${user.display_name} (${user.id})`
    : user.id
}

function roleLabel(user: UserOption | undefined) {
  if (!user?.role) return ''
  return ROLE_LABEL[user.role] || user.role
}

export type UserPickerProps = {
  selectedIds: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  disabled?: boolean
  emptyHint?: string
  // 自定义请求地址, 默认 /api/auth/user-search.
  searchPath?: string
}

export function UserPicker({
  selectedIds,
  onChange,
  placeholder = '输入用户名或 ID 搜索...',
  disabled,
  emptyHint = '还没有添加任何用户',
  searchPath = '/api/auth/user-search',
}: UserPickerProps) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<UserOption[]>([])
  const [resolved, setResolved] = useState<Record<string, UserOption>>({})
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const uniqueSelected = useMemo(
    () => Array.from(new Set((selectedIds || []).filter(Boolean))),
    [selectedIds],
  )

  // 解析已选 ID 的展示信息: 通过批量接口一次性拿到所有已选 ID 的昵称.
  useEffect(() => {
    if (!uniqueSelected.length) {
      setResolved({})
      return
    }
    const missing = uniqueSelected.filter((id) => !resolved[id])
    if (!missing.length) return
    let alive = true
    api('/api/auth/users-by-id', {
      method: 'POST',
      body: JSON.stringify({ ids: missing }),
    })
      .then((rows: any) => {
        if (!alive || !Array.isArray(rows)) return
        setResolved((prev) => {
          const next = { ...prev }
          for (const u of rows) {
            if (u?.id) next[u.id] = { id: u.id, display_name: u.display_name, role: u.role }
          }
          return next
        })
      })
      .catch(() => { /* 用户可能被删, 仍然显示 ID 即可 */ })
    return () => { alive = false }
  }, [uniqueSelected.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  // 自动补全: 输入时拉取候选.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setOptions([])
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    setErr('')
    const timer = window.setTimeout(() => {
      api(`${searchPath}?q=${encodeURIComponent(q)}`)
        .then((rows: any) => {
          if (!alive) return
          setOptions(Array.isArray(rows) ? rows : [])
          setHighlight(0)
        })
        .catch((e: any) => { if (alive) { setErr(e?.message || '搜索失败'); setOptions([]) } })
        .finally(() => { if (alive) setLoading(false) })
    }, 180)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [query, searchPath])

  // 外部点击关闭候选列表.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const addUser = (user: UserOption) => {
    if (uniqueSelected.includes(user.id)) {
      setQuery('')
      setOptions([])
      setOpen(false)
      return
    }
    onChange([...uniqueSelected, user.id])
    setResolved((prev) => ({ ...prev, [user.id]: user }))
    setQuery('')
    setOptions([])
    setHighlight(0)
    setOpen(false)
    inputRef.current?.focus()
  }

  const removeUser = (id: string) => {
    if (disabled) return
    onChange(uniqueSelected.filter((x) => x !== id))
    setResolved((prev) => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(options.length - 1, h + 1))
      setOpen(true)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(0, h - 1))
      setOpen(true)
    } else if (e.key === 'Enter') {
      if (!open || !options.length) return
      e.preventDefault()
      const pick = options[highlight]
      if (pick) addUser(pick)
    } else if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'Backspace' && !query && uniqueSelected.length) {
      // 在输入框空时按退格删除最后一个 chip, 与通用多选组件一致.
      onChange(uniqueSelected.slice(0, -1))
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <div
        className={`flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-lg ${disabled ? 'opacity-60' : ''}`}
        style={{
          background: 'var(--input-bg)',
          border: '1px solid var(--input-border)',
          minHeight: 36,
        }}
        onClick={() => { if (!disabled) { inputRef.current?.focus(); setOpen(true) } }}
      >
        {uniqueSelected.length === 0 && !query && (
          <span className="text-[12px] px-1" style={{ color: 'var(--placeholder-color)' }}>
            {emptyHint}
          </span>
        )}
        {uniqueSelected.map((id) => {
          const user = resolved[id]
          const text = labelFor(user) || id
          const sub = roleLabel(user)
          return (
            <span key={id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] font-mono"
              style={{ background: 'rgba(59,130,246,0.18)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.35)' }}
              title={text}>
              <span className="max-w-[180px] truncate">{text}</span>
              {sub && <span className="text-[10px]" style={{ color: 'rgba(96,165,250,0.7)' }}>· {sub}</span>}
              {!disabled && (
                <button type="button" onClick={(e) => { e.stopPropagation(); removeUser(id) }}
                  className="ml-0.5 -mr-1 inline-flex items-center justify-center w-4 h-4 rounded hover:bg-blue-500/30"
                  aria-label={`移除 ${text}`}>
                  <X className="w-3 h-3" strokeWidth={2.4} />
                </button>
              )}
            </span>
          )
        })}
        <input
          ref={inputRef}
          value={query}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="flex-1 min-w-[120px] px-1 py-0.5 text-[12px] font-mono focus:outline-none disabled:cursor-not-allowed"
          style={{ background: 'transparent', color: 'var(--text-primary)' }}
        />
      </div>

      {open && (query.trim() || loading) && (
        <div
          className="absolute z-30 mt-1 w-full max-h-56 overflow-auto rounded-lg border shadow-xl"
          style={{ background: 'var(--modal-bg)', borderColor: 'var(--border-color)' }}
        >
          {loading && (
            <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>搜索中...</div>
          )}
          {err && !loading && (
            <div className="px-3 py-2 text-[12px] text-red-400">{err}</div>
          )}
          {!loading && !err && options.length === 0 && (
            <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>没有匹配的用户</div>
          )}
          {!loading && options.map((opt, idx) => {
            const picked = uniqueSelected.includes(opt.id)
            return (
              <button
                key={opt.id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); addUser(opt) }}
                onMouseEnter={() => setHighlight(idx)}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-[12px] font-mono transition-colors"
                style={{
                  background: idx === highlight ? 'rgba(59,130,246,0.16)' : 'transparent',
                  color: 'var(--text-primary)',
                  opacity: picked ? 0.5 : 1,
                }}
                disabled={picked}
              >
                <span className="truncate flex-1">{labelFor(opt)}</span>
                {opt.role && (
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{roleLabel(opt)}</span>
                )}
                {picked && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>已添加</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
