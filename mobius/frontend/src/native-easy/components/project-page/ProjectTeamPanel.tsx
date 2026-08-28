import { useEffect, useMemo, useState } from 'react'
import { api } from '../../store'
import { UserPicker } from '../user-picker'

type Role = 'owner' | 'manager' | 'member' | 'viewer'

type MemberGroup = { id: string; name: string; is_primary: boolean }

type Member = {
  user_id: string
  display_name: string
  role: Role
  groups: MemberGroup[]
  is_active: boolean
  created_at: string
  updated_at: string
}

type ProjectTeamPanelProps = {
  projectId: string
  canManage: boolean
  actorRole: Role | null
}

const ROLE_LABELS: Record<Role, string> = {
  owner: '项目负责人',
  manager: '项目管理员',
  member: '项目成员',
  viewer: '项目访客',
}

// 可切换的角色顺序 (owner 放最后, 强调它是最高权).
const ROLE_OPTIONS: Role[] = ['member', 'manager', 'viewer', 'owner']

const ROLE_BADGE_STYLE: Record<Role, React.CSSProperties> = {
  owner: { background: 'var(--accent-soft)', color: 'var(--accent-primary)', borderColor: 'var(--accent-border)' },
  manager: { background: 'rgba(16,185,129,0.14)', color: '#34d399', borderColor: 'rgba(16,185,129,0.30)' },
  member: { background: 'rgba(148,163,184,0.14)', color: 'var(--text-secondary)', borderColor: 'var(--input-border)' },
  viewer: { background: 'rgba(148,163,184,0.10)', color: 'var(--text-muted)', borderColor: 'var(--input-border)' },
}

// 顶部角色筛选 Tab: 全部 + 4 角色 (照 Aone 权限页左侧分类, 因 mobius 此处已是 Tab 内, 降级成顶部一行).
const FILTER_TABS: Array<{ key: 'all' | Role; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'owner', label: '负责人' },
  { key: 'manager', label: '管理员' },
  { key: 'member', label: '成员' },
  { key: 'viewer', label: '访客' },
]

function formatDate(value?: string): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function ProjectTeamPanel({ projectId, canManage, actorRole }: ProjectTeamPanelProps) {
  const [members, setMembers] = useState<Member[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({ owner: 0, manager: 0, member: 0, viewer: 0 })
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [filterRole, setFilterRole] = useState<'all' | Role>('all')
  const [search, setSearch] = useState('')
  const [pendingIds, setPendingIds] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [addRole, setAddRole] = useState<Role>('member')
  const [showAdd, setShowAdd] = useState(false)
  const [groups, setGroups] = useState<Array<{ id: string; name: string; active_user_count: number }>>([])
  const [groupOpen, setGroupOpen] = useState(false)
  const [busyId, setBusyId] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api(`/api/projects/${projectId}/members`)
      .then((data: any) => {
        if (cancelled) return
        setMembers(Array.isArray(data?.members) ? data.members : [])
        setCounts(data?.counts || { owner: 0, manager: 0, member: 0, viewer: 0 })
        setErr('')
      })
      .catch((e: any) => { if (!cancelled) setErr(e?.message || '加载成员失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectId])

  const applyResult = (data: any) => {
    setMembers(Array.isArray(data?.members) ? data.members : [])
    setCounts(data?.counts || counts)
  }

  const addMembers = async () => {
    if (!pendingIds.length) return
    setAdding(true); setErr('')
    try {
      const data = await api(`/api/projects/${projectId}/members`, {
        method: 'POST',
        body: JSON.stringify({ user_ids: pendingIds, role: addRole }),
      })
      applyResult(data)
      setPendingIds([])
      setShowAdd(false)
    } catch (e: any) {
      setErr(e?.message || '添加成员失败')
    } finally {
      setAdding(false)
    }
  }

  const toggleGroups = async () => {
    if (groups.length) { setGroupOpen((o) => !o); return }
    try {
      const list = await api('/api/user-groups')
      setGroups(Array.isArray(list) ? list : [])
      setGroupOpen(true)
    } catch (e: any) {
      setErr(e?.message || '读取群组失败')
    }
  }

  const addGroup = async (groupId: string) => {
    setGroupOpen(false)
    if (!groupId) return
    setAdding(true); setErr('')
    try {
      const data: any = await api(`/api/user-groups/${groupId}/members`)
      const ids = (Array.isArray(data?.members) ? data.members : []).map((m: any) => m.id).filter(Boolean)
      if (!ids.length) { setErr('该群组当前没有启用成员'); return }
      const res = await api(`/api/projects/${projectId}/members`, {
        method: 'POST',
        body: JSON.stringify({ user_ids: ids, role: addRole }),
      })
      applyResult(res)
      setShowAdd(false)
    } catch (e: any) {
      setErr(e?.message || '按群组加入失败')
    } finally {
      setAdding(false)
    }
  }

  const changeRole = async (userId: string, role: Role) => {
    setBusyId(userId); setErr('')
    try {
      const data = await api(`/api/projects/${projectId}/members/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      })
      applyResult(data)
    } catch (e: any) {
      setErr(e?.message || '修改角色失败')
    } finally {
      setBusyId('')
    }
  }

  const removeMember = async (userId: string) => {
    setBusyId(userId); setErr('')
    try {
      const data = await api(`/api/projects/${projectId}/members/${userId}`, { method: 'DELETE' })
      applyResult(data)
    } catch (e: any) {
      setErr(e?.message || '移除成员失败')
    } finally {
      setBusyId('')
    }
  }

  // 能否操作"负责人"行: 仅当前用户是项目负责人或管理员 (admin 的 actorRole 为 null 但 canManage=true).
  const canTouchOwner = canManage && (actorRole === 'owner' || !actorRole)

  const filteredMembers = useMemo(() => {
    let list = members
    if (filterRole !== 'all') list = list.filter((m) => m.role === filterRole)
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter((m) =>
        (m.display_name || '').toLowerCase().includes(q) ||
        (m.user_id || '').toLowerCase().includes(q),
      )
    }
    return list
  }, [members, filterRole, search])

  const countFor = (key: 'all' | Role): number => (key === 'all' ? members.length : counts[key] || 0)

  const thStyle: React.CSSProperties = {
    color: 'var(--text-muted)', fontWeight: 500, textAlign: 'left', padding: '8px 10px', fontSize: 11,
  }
  const tdStyle: React.CSSProperties = { padding: '10px', verticalAlign: 'middle' }

  return (
    <div className="space-y-3">
      {/* 顶部角色筛选 Tab (全部 / 负责人 / 管理员 / 成员 / 访客 · 计数, 可点选筛选) */}
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTER_TABS.map((tab) => {
          const active = filterRole === tab.key
          return (
            <button key={tab.key} type="button" onClick={() => setFilterRole(tab.key)}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[11px] border transition-colors"
              style={active
                ? { background: 'var(--surface-active)', borderColor: 'var(--accent-border)', color: 'var(--accent-primary)' }
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
          className="h-8 flex-1 min-w-[180px] rounded-md border px-3 text-[12px] outline-none focus:border-[var(--accent-border)]"
          style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}
        />
        {canManage && (
          <button type="button" onClick={() => setShowAdd((s) => !s)}
            className="h-8 px-3 rounded-md text-[12px] btn-primary transition-colors">
            {showAdd ? '收起添加' : '+ 添加成员'}
          </button>
        )}
      </div>

      {/* 添加成员区 (折叠) */}
      {canManage && showAdd && (
        <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--input-border)', background: 'var(--input-bg)' }}>
          <div className="flex items-center gap-1.5">
            <div className="flex-1 min-w-0">
              <UserPicker
                selectedIds={pendingIds}
                onChange={setPendingIds}
                searchPath={`/api/projects/${projectId}/member-candidates`}
                placeholder="搜索员工账号或昵称..."
                emptyHint="输入账号或昵称搜索启用员工"
              />
            </div>
            <select value={addRole} onChange={(e) => setAddRole(e.target.value as Role)} disabled={adding}
              className="h-9 px-2 rounded-lg text-[12px] border flex-shrink-0"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
              <option value="member">项目成员</option>
              <option value="manager">项目管理员</option>
              <option value="viewer">项目访客</option>
            </select>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={addMembers} disabled={!pendingIds.length || adding}
              className="h-8 px-3 rounded-lg text-[12px] btn-primary transition-colors disabled:opacity-50">
              {adding ? '添加中...' : '加入项目组'}
            </button>
            <div className="relative">
              <button type="button" onClick={toggleGroups} disabled={adding}
                className="h-8 px-3 rounded-lg text-[12px] border transition-colors"
                style={{ borderColor: 'var(--input-border)', color: 'var(--text-muted)', background: 'var(--modal-bg)' }}>
                + 按群组加入
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
            {pendingIds.length > 0 && (
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>已选 {pendingIds.length} 人</span>
            )}
          </div>
        </div>
      )}

      {err && (
        <div className="workbench-status-danger rounded-lg border px-3 py-2 text-[12px]">
          {err}
        </div>
      )}

      {/* 成员表格: 成员 / 角色 / 加入时间 / 操作 */}
      {loading ? (
        <div className="text-[12px] py-6 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : filteredMembers.length === 0 ? (
        <div className="text-[12px] py-6 text-center" style={{ color: 'var(--text-muted)' }}>
          {members.length === 0 ? '暂无项目组成员' : '没有匹配的成员'}
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--input-border)' }}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[12px]">
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--input-border)', background: 'var(--input-bg)' }}>
                  <th style={thStyle}>成员</th>
                  <th style={thStyle}>角色</th>
                  <th style={thStyle}>加入时间</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredMembers.map((m) => {
                  const isOwner = m.role === 'owner'
                  const canEditThis = canManage && (!isOwner || canTouchOwner)
                  return (
                    <tr key={m.user_id} className="border-b last:border-b-0" style={{ borderColor: 'var(--input-border)' }}>
                      <td style={tdStyle}>
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{m.display_name}</span>
                          {!m.is_active && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(148,163,184,0.16)', color: 'var(--text-muted)' }}>已停用</span>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] flex-wrap" style={{ color: 'var(--text-muted)' }}>
                          <span className="font-mono">{m.user_id}</span>
                          {m.groups.length > 0 && m.groups.map((g) => (
                            <span key={g.id} className="px-1.5 py-0 rounded border" style={{ borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
                              {g.name}{g.is_primary ? ' · 主' : ''}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td style={tdStyle}>
                        {canEditThis ? (
                          <select
                            value={m.role}
                            disabled={busyId === m.user_id}
                            onChange={(e) => changeRole(m.user_id, e.target.value as Role)}
                            className="h-7 px-1.5 rounded-md text-[11px] border"
                            style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}
                          >
                            {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                          </select>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded border text-[10px]" style={ROLE_BADGE_STYLE[m.role]}>{ROLE_LABELS[m.role]}</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--text-muted)' }}>{formatDate(m.created_at)}</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {canEditThis ? (
                          <button type="button" onClick={() => removeMember(m.user_id)} disabled={busyId === m.user_id}
                            className="h-7 px-2 rounded-md text-[11px] border transition-colors"
                            style={{ borderColor: 'var(--status-danger-border)', color: 'var(--status-danger)', background: 'var(--status-danger-soft)' }}>
                            移除
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!canManage && (
        <div className="rounded-lg border px-3 py-2 text-[11px]" style={{ borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
          仅项目负责人 / 项目管理员可以管理成员与角色。
        </div>
      )}
    </div>
  )
}
