import { useEffect, useMemo, useState } from 'react'
import { api } from '../store'
import { UserPicker } from './user-picker'

export type ProjectMemberRole = 'viewer' | 'member' | 'manager'

export type MemberInput = { user_id: string; role: string }

type ProjectMemberInviteProps = {
  value: MemberInput[]
  onChange: (next: MemberInput[]) => void
  currentUserId?: string
  disabled?: boolean
}

const ROLE_OPTIONS: Array<{ value: ProjectMemberRole; label: string; hint: string }> = [
  { value: 'member', label: '项目成员', hint: '可读可写' },
  { value: 'manager', label: '项目管理员', hint: '可管理成员' },
  { value: 'viewer', label: '项目访客', hint: '只读' },
]
const DEFAULT_ROLE: ProjectMemberRole = 'member'

// 角色筛选 Tab (对齐 ProjectTeamPanel; 创建时邀请列表不含 owner, 故无"项目负责人"档).
const FILTER_TABS: Array<{ key: 'all' | ProjectMemberRole; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'manager', label: '管理员' },
  { key: 'member', label: '成员' },
  { key: 'viewer', label: '访客' },
]

// 创建项目时的"成员邀请": 布局与项目成员设置 Tab(ProjectTeamPanel) 一致 ——
// 顶部角色筛选 Tab + 搜索框 + 折叠添加区 + 待添加表格. 区别: 创建时尚无 projectId,
// 列表是"待邀请成员"(无加入时间, 无 owner 档), 选人直接并入列表随项目一起创建.
export function ProjectMemberInvite({ value, onChange, currentUserId, disabled }: ProjectMemberInviteProps) {
  const [pickerIds, setPickerIds] = useState<string[]>([])
  const [batchRole, setBatchRole] = useState<ProjectMemberRole>(DEFAULT_ROLE)
  const [nameMap, setNameMap] = useState<Record<string, string>>({})
  const [groups, setGroups] = useState<Array<{ id: string; name: string; active_user_count: number }>>([])
  const [groupOpen, setGroupOpen] = useState(false)
  const [filterRole, setFilterRole] = useState<'all' | ProjectMemberRole>('all')
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)

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
    } catch { /* 忽略, 列表回落显示 user_id */ }
  }

  useEffect(() => {
    const ids = value.map((v) => v.user_id)
    if (ids.length) resolveNames(ids)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const addIds = (ids: string[], role: string) => {
    const existing = new Set(value.map((v) => v.user_id))
    const fresh = Array.from(new Set(ids)).filter((id) => id && id !== currentUserId && !existing.has(id))
    if (!fresh.length) return
    resolveNames(fresh)
    onChange([...value, ...fresh.map((id) => ({ user_id: id, role }))])
  }

  // UserPicker 作为"输入器": 新选的立刻并入列表 (用批次角色), 随后清空 picker.
  const onPickerChange = (ids: string[]) => {
    const fresh = ids.filter((id) => !value.some((v) => v.user_id === id) && id !== currentUserId)
    if (fresh.length) addIds(fresh, batchRole)
    setPickerIds([])
  }

  const toggleGroups = async () => {
    if (groups.length) { setGroupOpen((o) => !o); return }
    try {
      const list = await api('/api/user-groups')
      setGroups(Array.isArray(list) ? list : [])
      setGroupOpen(true)
    } catch { setGroupOpen((o) => !o) }
  }

  const addGroup = async (groupId: string) => {
    setGroupOpen(false)
    if (!groupId) return
    try {
      const data: any = await api(`/api/user-groups/${groupId}/members`)
      const members: any[] = Array.isArray(data?.members) ? data.members : []
      setNameMap((prev) => {
        const next = { ...prev }
        for (const m of members) if (m?.id) next[m.id] = m.display_name || m.id
        return next
      })
      addIds(members.map((m) => m.id), batchRole)
    } catch { /* 忽略 */ }
  }

  const setRole = (userId: string, role: string) =>
    onChange(value.map((v) => (v.user_id === userId ? { ...v, role } : v)))
  const remove = (userId: string) => onChange(value.filter((v) => v.user_id !== userId))

  const counts = useMemo(() => {
    const c: Record<string, number> = { manager: 0, member: 0, viewer: 0 }
    for (const v of value) if (v.role in c) c[v.role] += 1
    return c
  }, [value])

  const filtered = useMemo(() => {
    let list = value
    if (filterRole !== 'all') list = list.filter((v) => v.role === filterRole)
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter((v) =>
        (nameMap[v.user_id] || v.user_id).toLowerCase().includes(q) ||
        v.user_id.toLowerCase().includes(q),
      )
    }
    return list
  }, [value, filterRole, search, nameMap])

  const countFor = (key: 'all' | ProjectMemberRole): number => (key === 'all' ? value.length : counts[key] || 0)

  const thStyle: React.CSSProperties = { color: 'var(--text-muted)', fontWeight: 500, textAlign: 'left', padding: '8px 10px', fontSize: 11 }
  const tdStyle: React.CSSProperties = { padding: '10px', verticalAlign: 'middle' }

  return (
    <div className="space-y-3">
      {/* 顶部角色筛选 Tab (全部 / 管理员 / 成员 / 访客 · 计数, 可点选筛选) */}
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTER_TABS.map((tab) => {
          const active = filterRole === tab.key
          return (
            <button key={tab.key} type="button" onClick={() => setFilterRole(tab.key)} disabled={disabled}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[11px] border transition-colors disabled:opacity-50"
              style={active
                ? { background: 'rgba(59,130,246,0.16)', borderColor: 'rgba(59,130,246,0.40)', color: '#60a5fa' }
                : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
              {tab.label}
              <span style={{ opacity: 0.7 }}>{countFor(tab.key)}</span>
            </button>
          )
        })}
      </div>

      {/* 工具栏: 搜索 + 添加成员 */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索成员姓名或账号..."
          className="h-8 flex-1 min-w-[180px] rounded-md border px-3 text-[12px] outline-none focus:border-blue-500/50"
          style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}
        />
        <button type="button" onClick={() => setShowAdd((s) => !s)} disabled={disabled}
          className="h-8 px-3 rounded-md text-[12px] btn-primary transition-colors disabled:opacity-50">
          {showAdd ? '收起添加' : '+ 添加成员'}
        </button>
      </div>

      {/* 添加成员区 (折叠) */}
      {showAdd && (
        <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--input-border)', background: 'var(--input-bg)' }}>
          <div className="flex items-center gap-1.5">
            <div className="flex-1 min-w-0">
              <UserPicker
                selectedIds={pickerIds}
                onChange={onPickerChange}
                disabled={disabled}
                placeholder="搜索员工账号或昵称..."
                emptyHint="输入账号或昵称搜索启用员工"
              />
            </div>
            <select
              value={batchRole}
              onChange={(e) => setBatchRole(e.target.value as ProjectMemberRole)}
              disabled={disabled}
              title="新加入成员的默认角色"
              className="h-9 px-2 rounded-lg text-[12px] border flex-shrink-0"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}
            >
              {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <button type="button" onClick={toggleGroups} disabled={disabled}
                className="h-8 px-3 rounded-lg text-[12px] border transition-colors"
                style={{ borderColor: 'var(--input-border)', color: 'var(--text-muted)', background: 'var(--modal-bg)' }}>
                + 按员工群组加入
              </button>
              {groupOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setGroupOpen(false)} />
                  <div className="absolute z-50 mt-1 w-64 max-h-60 overflow-auto rounded-lg border shadow-lg"
                    style={{ background: 'var(--modal-bg)', borderColor: 'var(--input-border)' }}>
                    {groups.length === 0 ? (
                      <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无群组</div>
                    ) : groups.map((g) => (
                      <button key={g.id} type="button" onClick={() => addGroup(g.id)}
                        className="block w-full text-left px-3 py-2 text-[12px] hover:bg-[var(--bg-card-hover)] transition-colors"
                        style={{ color: 'var(--text-secondary)' }}>
                        {g.name} <span style={{ color: 'var(--text-muted)' }}>· {g.active_user_count} 位启用成员</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>选中即加入下方列表</span>
          </div>
        </div>
      )}

      {/* 待添加成员表格: 成员 / 角色 / 操作 */}
      {filtered.length === 0 ? (
        <div className="text-[12px] py-6 text-center" style={{ color: 'var(--text-muted)' }}>
          {value.length === 0 ? '暂未添加成员（创建者自动成为项目负责人）' : '没有匹配的成员'}
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--input-border)' }}>
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b" style={{ borderColor: 'var(--input-border)', background: 'var(--input-bg)' }}>
                <th style={thStyle}>成员</th>
                <th style={thStyle}>角色</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => {
                const roleOpt = ROLE_OPTIONS.find((r) => r.value === m.role) || ROLE_OPTIONS[0]
                return (
                  <tr key={m.user_id} className="border-b last:border-b-0" style={{ borderColor: 'var(--input-border)' }}>
                    <td style={tdStyle}>
                      <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{nameMap[m.user_id] || m.user_id}</div>
                      <div className="mt-0.5 text-[11px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>{m.user_id}</div>
                    </td>
                    <td style={tdStyle}>
                      <select
                        value={m.role}
                        onChange={(e) => setRole(m.user_id, e.target.value)}
                        disabled={disabled}
                        title={roleOpt.hint}
                        className="h-7 px-1.5 rounded-md text-[11px] border"
                        style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}
                      >
                        {ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <button type="button" onClick={() => remove(m.user_id)} disabled={disabled}
                        className="h-7 px-2 rounded-md text-[11px] border transition-colors"
                        style={{ borderColor: 'rgba(248,113,113,0.32)', color: '#f87171', background: 'rgba(248,113,113,0.06)' }}>
                        移除
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>
        创建者自动成为项目负责人。项目成员可读可写、项目管理员可管理成员、项目访客只读；创建后可在项目设置中调整。
      </p>
    </div>
  )
}
