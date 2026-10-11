import { useEffect, useMemo, useState } from 'react'
import { api, friendlyApiError } from '../../store'
import { UserPicker } from '../user-picker'

type Role = 'owner' | 'developer' | 'viewer' | 'none'

type Member = {
  user_id: string
  display_name: string
  role: Role
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
  owner: '项目所有者',
  developer: '项目开发者',
  viewer: '项目访客',
  none: '不显示',
}

// 可切换的角色顺序 (owner 放最后, 强调它是最高权).
const ROLE_OPTIONS: Role[] = ['developer', 'viewer', 'none']

const ROLE_BADGE_STYLE: Record<Role, React.CSSProperties> = {
  owner: { background: 'rgba(59,130,246,0.16)', color: '#60a5fa', borderColor: 'rgba(59,130,246,0.32)' },
  developer: { background: 'rgba(16,185,129,0.14)', color: '#34d399', borderColor: 'rgba(16,185,129,0.30)' },
  viewer: { background: 'rgba(148,163,184,0.10)', color: 'var(--text-muted)', borderColor: 'var(--input-border)' },
  none: { background: 'rgba(248,113,113,0.10)', color: '#f87171', borderColor: 'rgba(248,113,113,0.24)' },
}

// 顶部角色筛选 Tab: 全部 + 4 角色 (照 Aone 权限页左侧分类, 因 mobius 此处已是 Tab 内, 降级成顶部一行).
const FILTER_TABS: Array<{ key: 'all' | Role; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'owner', label: '所有者' },
  { key: 'developer', label: '开发者' },
  { key: 'viewer', label: '访客' },
  { key: 'none', label: '隐藏' },
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
  const [counts, setCounts] = useState<Record<string, number>>({ owner: 0, developer: 0, viewer: 0, none: 0 })
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [filterRole, setFilterRole] = useState<'all' | Role>('all')
  const [search, setSearch] = useState('')
  const [pendingIds, setPendingIds] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [addRole, setAddRole] = useState<Role>('developer')
  const [showAdd, setShowAdd] = useState(false)
  const [busyId, setBusyId] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api(`/api/projects/${projectId}/members`)
      .then((data: any) => {
        if (cancelled) return
        setMembers(Array.isArray(data?.members) ? data.members : [])
        setCounts(data?.counts || { owner: 0, developer: 0, viewer: 0, none: 0 })
        setErr('')
      })
      .catch((e: any) => { if (!cancelled) setErr(friendlyApiError(e, '加载项目成员失败')) })
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
      setErr(friendlyApiError(e, '添加项目成员失败'))
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
      setErr(friendlyApiError(e, '修改项目角色失败'))
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
      setErr(friendlyApiError(e, '移除项目成员失败'))
    } finally {
      setBusyId('')
    }
  }

  // 能否操作"所有者"行: 仅当前用户是项目所有者或管理员 (admin 的 actorRole 为 null 但 canManage=true).
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
    color: 'var(--text-muted)', fontWeight: 500, textAlign: 'left', padding: '8px 10px', fontSize: 'var(--fs-sm)',
  }
  const tdStyle: React.CSSProperties = { padding: '10px', verticalAlign: 'middle' }

  return (
    <div className="space-y-3">
      {/* 顶部角色筛选 Tab (全部 / 所有者 / 开发者 / 访客 / 不显示 · 计数, 可点选筛选) */}
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTER_TABS.map((tab) => {
          const active = filterRole === tab.key
          return (
            <button key={tab.key} type="button" onClick={() => setFilterRole(tab.key)}
              className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[length:var(--fs-sm)] border transition-colors"
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
          className="h-8 flex-1 min-w-[180px] rounded-md border px-3 text-[length:var(--fs-md)] outline-none focus:border-blue-500/50"
          style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}
        />
        {canManage && (
          <button type="button" onClick={() => setShowAdd((s) => !s)}
            className="h-8 px-3 rounded-md text-[length:var(--fs-md)] btn-primary transition-colors">
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
              className="h-9 px-2 rounded-lg text-[length:var(--fs-md)] border flex-shrink-0"
              style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
              <option value="developer">项目开发者</option>
              <option value="viewer">项目访客</option>
              <option value="none">不显示</option>
            </select>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={addMembers} disabled={!pendingIds.length || adding}
              className="h-8 px-3 rounded-lg text-[length:var(--fs-md)] btn-primary transition-colors disabled:opacity-50">
              {adding ? '添加中...' : '加入项目组'}
            </button>
            {pendingIds.length > 0 && (
              <span className="text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>已选 {pendingIds.length} 人</span>
            )}
          </div>
        </div>
      )}

      {err && (
        <div className="rounded-lg border px-3 py-2 text-[length:var(--fs-md)]" style={{ borderColor: 'rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.08)', color: '#f87171' }}>
          {err}
        </div>
      )}

      {/* 成员表格: 成员 / 角色 / 加入时间 / 操作 */}
      {loading ? (
        <div className="text-[length:var(--fs-md)] py-6 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : filteredMembers.length === 0 ? (
        <div className="text-[length:var(--fs-md)] py-6 text-center" style={{ color: 'var(--text-muted)' }}>
          {members.length === 0 ? '暂无项目成员' : '没有匹配的成员'}
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--input-border)' }}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[length:var(--fs-md)]">
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
                          <span className="text-[length:var(--fs-lg)] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{m.display_name}</span>
                          {!m.is_active && (
                            <span className="text-[length:var(--fs-xs)] px-1.5 py-0.5 rounded" style={{ background: 'rgba(148,163,184,0.16)', color: 'var(--text-muted)' }}>已停用</span>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[length:var(--fs-sm)] flex-wrap" style={{ color: 'var(--text-muted)' }}>
                          <span className="font-mono">{m.user_id}</span>
                        </div>
                      </td>
                      <td style={tdStyle}>
                        {canEditThis ? (
                          <select
                            value={m.role}
                            disabled={busyId === m.user_id}
                            onChange={(e) => changeRole(m.user_id, e.target.value as Role)}
                            className="h-7 px-1.5 rounded-md text-[length:var(--fs-sm)] border"
                            style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}
                          >
                            {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                          </select>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded border text-[length:var(--fs-xs)]" style={ROLE_BADGE_STYLE[m.role]}>{ROLE_LABELS[m.role]}</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--text-muted)' }}>{formatDate(m.created_at)}</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {canEditThis ? (
                          <button type="button" onClick={() => removeMember(m.user_id)} disabled={busyId === m.user_id}
                            className="h-7 px-2 rounded-md text-[length:var(--fs-sm)] border transition-colors"
                            style={{ borderColor: 'rgba(248,113,113,0.32)', color: '#f87171', background: 'rgba(248,113,113,0.06)' }}>
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
        <div className="rounded-lg border px-3 py-2 text-[length:var(--fs-sm)]" style={{ borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
          {actorRole === 'developer'
            ? '你当前是项目开发者，可以编辑项目内容，但只有项目所有者可以管理成员与角色。'
            : actorRole === 'viewer' || actorRole === 'none'
              ? '你当前是项目访客，只能查看项目内容，不能管理成员与角色。'
              : '只有项目所有者可以管理成员与角色。'}
        </div>
      )}
    </div>
  )
}
