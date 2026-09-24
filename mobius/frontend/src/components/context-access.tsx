import { useEffect, useMemo, useState } from 'react'
import { api } from '../store'
import { UserPicker } from './user-picker'

type ContextAccessModalProps = {
  baseUrl: string
  item: any
  kindLabel: string
  onClose: () => void
  onSaved: () => void
}

// 个人级 skill/memory 访客管理: 创建者(全权) + 访客(可读可用不可改).
// UI 对齐项目成员设置(ProjectTeamPanel): 角色筛选 Tab + 搜索 + 折叠添加 + 成员表格.
// 数据映射: 访客 = allow_user_ids (ACL allow); 保存时 visibility 自动 —— 有访客=allowlist, 无=private.
const FILTER_TABS = [
  { key: 'all', label: '全部' },
  { key: 'guest', label: '访客' },
] as const
type FilterKey = typeof FILTER_TABS[number]['key']

export function ContextAccessModal({ baseUrl, item, kindLabel, onClose, onSaved }: ContextAccessModalProps) {
  const [guests, setGuests] = useState<string[]>([])
  const [pickerIds, setPickerIds] = useState<string[]>([])
  const [nameMap, setNameMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [showAdd, setShowAdd] = useState(false)
  const [err, setErr] = useState('')

  const ownerId = item?.created_by || item?.owner_id

  const resolveNames = async (ids: string[]) => {
    const missing = Array.from(new Set(ids.filter((id) => id && !nameMap[id])))
    if (!missing.length) return
    try {
      const data: any = await api('/api/auth/users-by-id', { method: 'POST', body: JSON.stringify({ ids: missing }) })
      const list: any[] = Array.isArray(data) ? data : (data?.users || [])
      setNameMap((prev) => {
        const next = { ...prev }
        for (const u of list) if (u?.id) next[u.id] = u.display_name || u.id
        return next
      })
    } catch { /* 忽略, 表格回落显示 user_id */ }
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    api(`${baseUrl}/${item.id}/access`)
      .then((access: any) => {
        if (!alive) return
        const ids: string[] = Array.isArray(access?.allow_user_ids) ? access.allow_user_ids : []
        const list = ids.filter((id) => id && id !== ownerId)
        setGuests(list)
        if (ownerId) resolveNames([ownerId])
        if (list.length) resolveNames(list)
        setErr('')
      })
      .catch((e: any) => { if (alive) setErr(e?.message || '读取权限失败') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [baseUrl, item.id])

  const onPickerChange = (ids: string[]) => {
    const fresh = ids.filter((id) => id && id !== ownerId && !guests.includes(id))
    if (fresh.length) { resolveNames(fresh); setGuests((prev) => [...prev, ...fresh]) }
    setPickerIds([])
    setShowAdd(false)
  }
  const removeGuest = (id: string) => setGuests((prev) => prev.filter((x) => x !== id))

  const save = async () => {
    setSaving(true); setErr('')
    try {
      await api(`${baseUrl}/${item.id}/access`, {
        method: 'PATCH',
        body: JSON.stringify({
          visibility: guests.length ? 'allowlist' : 'private',
          allow_user_ids: guests,
        }),
      })
      onSaved()
    } catch (e: any) {
      setErr(e?.message || '保存权限失败')
    } finally {
      setSaving(false)
    }
  }

  const showOwner = filter === 'all'
  const filteredGuests = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return guests
    return guests.filter((id) =>
      (nameMap[id] || id).toLowerCase().includes(q) ||
      id.toLowerCase().includes(q),
    )
  }, [guests, search, nameMap])

  const thStyle: React.CSSProperties = { color: 'var(--text-muted)', fontWeight: 500, textAlign: 'left', padding: '8px 10px', fontSize: 'var(--fs-sm)' }
  const tdStyle: React.CSSProperties = { padding: '10px', verticalAlign: 'middle' }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-[560px] max-w-[calc(100vw-32px)] max-h-[84vh] rounded-2xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div className="min-w-0">
            <div className="text-[length:var(--fs-xl)] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{kindLabel} · 访客管理</div>
            <div className="text-[length:var(--fs-sm)] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>{item?.name || item?.id}</div>
          </div>
          <button onClick={onClose} disabled={saving}
            className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40"
            style={{ color: 'var(--text-muted)' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-5 space-y-3 overflow-auto">
          {loading ? (
            <div className="text-[length:var(--fs-md)]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          ) : (
            <>
              {/* 角色筛选 Tab (全部 / 访客 · 计数) */}
              <div className="flex flex-wrap items-center gap-1.5">
                {FILTER_TABS.map((tab) => {
                  const active = filter === tab.key
                  const count = tab.key === 'all' ? (guests.length + 1) : guests.length
                  return (
                    <button key={tab.key} type="button" onClick={() => setFilter(tab.key)}
                      className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[length:var(--fs-sm)] border transition-colors"
                      style={active
                        ? { background: 'rgba(59,130,246,0.16)', borderColor: 'rgba(59,130,246,0.40)', color: '#60a5fa' }
                        : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
                      {tab.label}
                      <span style={{ opacity: 0.7 }}>{count}</span>
                    </button>
                  )
                })}
              </div>

              {/* 工具栏: 搜索 + 添加访客 */}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索访客姓名或账号..."
                  className="h-8 flex-1 min-w-[140px] rounded-md border px-3 text-[length:var(--fs-md)] outline-none focus:border-blue-500/50"
                  style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}
                />
                <button type="button" onClick={() => setShowAdd((s) => !s)}
                  className="h-8 px-3 rounded-md text-[length:var(--fs-md)] btn-primary transition-colors">
                  {showAdd ? '收起' : '+ 添加访客'}
                </button>
              </div>

              {/* 添加访客区 (折叠) */}
              {showAdd && (
                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--input-border)', background: 'var(--input-bg)' }}>
                  <UserPicker
                    selectedIds={pickerIds}
                    onChange={onPickerChange}
                    placeholder="搜索员工账号或昵称..."
                    emptyHint="输入账号或昵称搜索启用员工"
                  />
                  <p className="text-[length:var(--fs-sm)] mt-1.5" style={{ color: 'var(--text-muted)' }}>选中即加入访客列表（可读可用，不可修改）。</p>
                </div>
              )}

              {/* 成员表格: 创建者 + 访客 */}
              <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--input-border)' }}>
                <table className="w-full border-collapse text-left text-[length:var(--fs-md)]">
                  <thead>
                    <tr className="border-b" style={{ borderColor: 'var(--input-border)', background: 'var(--input-bg)' }}>
                      <th style={thStyle}>成员</th>
                      <th style={thStyle}>角色</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {showOwner && (
                      <tr className="border-b" style={{ borderColor: 'var(--input-border)' }}>
                        <td style={tdStyle}>
                          <div className="text-[length:var(--fs-lg)] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{nameMap[ownerId] || ownerId}</div>
                          <div className="mt-0.5 text-[length:var(--fs-sm)] font-mono truncate" style={{ color: 'var(--text-muted)' }}>{ownerId}</div>
                        </td>
                        <td style={tdStyle}>
                          <span className="px-1.5 py-0.5 rounded border text-[length:var(--fs-xs)]" style={{ background: 'rgba(59,130,246,0.16)', color: '#60a5fa', borderColor: 'rgba(59,130,246,0.32)' }}>创建者 · 全权</span>
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>
                          <span className="text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>—</span>
                        </td>
                      </tr>
                    )}
                    {filteredGuests.map((id) => (
                      <tr key={id} className="border-b last:border-b-0" style={{ borderColor: 'var(--input-border)' }}>
                        <td style={tdStyle}>
                          <div className="text-[length:var(--fs-lg)] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{nameMap[id] || id}</div>
                          <div className="mt-0.5 text-[length:var(--fs-sm)] font-mono truncate" style={{ color: 'var(--text-muted)' }}>{id}</div>
                        </td>
                        <td style={tdStyle}>
                          <span className="px-1.5 py-0.5 rounded border text-[length:var(--fs-xs)]" style={{ background: 'rgba(148,163,184,0.14)', color: 'var(--text-secondary)', borderColor: 'var(--input-border)' }}>访客 · 可读可用</span>
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>
                          <button type="button" onClick={() => removeGuest(id)} disabled={saving}
                            className="h-7 px-2 rounded-md text-[length:var(--fs-sm)] border transition-colors"
                            style={{ borderColor: 'rgba(248,113,113,0.32)', color: '#f87171', background: 'rgba(248,113,113,0.06)' }}>
                            移除
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!showOwner && filteredGuests.length === 0 && (
                      <tr><td colSpan={3} className="text-[length:var(--fs-md)] py-4 text-center" style={{ color: 'var(--text-muted)' }}>暂无访客</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <p className="text-[length:var(--fs-sm)] leading-5" style={{ color: 'var(--text-muted)' }}>
                创建者全权；访客可阅读、可使用，但不能修改。无访客时仅创建者可见。
              </p>
              {err && <pre className="text-[length:var(--fs-sm)] text-red-400 whitespace-pre-wrap break-all">{err}</pre>}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border-color)' }}>
          <button onClick={onClose} disabled={saving}
            className="h-8 px-3 text-[length:var(--fs-md)] rounded border disabled:opacity-40"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>取消</button>
          <button onClick={save} disabled={loading || saving}
            className="h-8 px-4 text-[length:var(--fs-md)] rounded btn-primary transition-colors disabled:opacity-40">
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
