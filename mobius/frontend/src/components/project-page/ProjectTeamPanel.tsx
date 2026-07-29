import { useEffect, useState } from 'react'
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
  owner: { background: 'rgba(59,130,246,0.16)', color: '#60a5fa', borderColor: 'rgba(59,130,246,0.32)' },
  manager: { background: 'rgba(16,185,129,0.14)', color: '#34d399', borderColor: 'rgba(16,185,129,0.30)' },
  member: { background: 'rgba(148,163,184,0.14)', color: 'var(--text-secondary)', borderColor: 'var(--input-border)' },
  viewer: { background: 'rgba(148,163,184,0.10)', color: 'var(--text-muted)', borderColor: 'var(--input-border)' },
}

export function ProjectTeamPanel({ projectId, canManage, actorRole }: ProjectTeamPanelProps) {
  const [members, setMembers] = useState<Member[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({ owner: 0, manager: 0, member: 0, viewer: 0 })
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [pendingIds, setPendingIds] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
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
        body: JSON.stringify({ user_ids: pendingIds, role: 'member' }),
      })
      applyResult(data)
      setPendingIds([])
    } catch (e: any) {
      setErr(e?.message || '添加成员失败')
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span style={{ color: 'var(--text-secondary)' }}>项目组：</span>
        {(['owner', 'manager', 'member', 'viewer'] as Role[]).map((r) => (
          <span key={r} className="px-2 py-0.5 rounded-full border text-[11px]"
            style={ROLE_BADGE_STYLE[r]}>
            {ROLE_LABELS[r]} · {counts[r] || 0}
          </span>
        ))}
      </div>

      {canManage && (
        <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--input-border)', background: 'var(--input-bg)' }}>
          <div className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>添加项目组成员</div>
          <UserPicker
            selectedIds={pendingIds}
            onChange={setPendingIds}
            searchPath={`/api/projects/${projectId}/member-candidates`}
            placeholder="搜索员工账号或昵称..."
            emptyHint="输入账号或昵称搜索启用员工"
          />
          <div className="flex items-center gap-2">
            <button type="button" onClick={addMembers} disabled={!pendingIds.length || adding}
              className="h-8 px-3 rounded-lg text-[12px] btn-primary transition-colors disabled:opacity-50">
              {adding ? '添加中...' : '加入项目组'}
            </button>
            {pendingIds.length > 0 && (
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>已选 {pendingIds.length} 人（以「项目成员」加入）</span>
            )}
          </div>
        </div>
      )}

      {err && (
        <div className="rounded-lg border px-3 py-2 text-[12px]" style={{ borderColor: 'rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.08)', color: '#f87171' }}>
          {err}
        </div>
      )}

      {loading ? (
        <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : members.length === 0 ? (
        <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>暂无项目组成员</div>
      ) : (
        <div className="rounded-lg border divide-y" style={{ borderColor: 'var(--input-border)' }}>
          {members.map((m) => {
            const isOwner = m.role === 'owner'
            const canEditThis = canManage && (!isOwner || canTouchOwner)
            return (
              <div key={m.user_id} className="flex items-center gap-3 px-3 py-2.5" style={{ borderColor: 'var(--input-border)' }}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{m.display_name}</span>
                    {!m.is_active && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(148,163,184,0.16)', color: 'var(--text-muted)' }}>已停用</span>
                    )}
                    <span className="px-1.5 py-0.5 rounded border text-[10px]" style={ROLE_BADGE_STYLE[m.role]}>{ROLE_LABELS[m.role]}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] flex-wrap" style={{ color: 'var(--text-muted)' }}>
                    <span className="font-mono">{m.user_id}</span>
                    {m.groups.length > 0 && m.groups.map((g) => (
                      <span key={g.id} className="px-1.5 py-0 rounded border" style={{ borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
                        {g.name}{g.is_primary ? ' · 主' : ''}
                      </span>
                    ))}
                  </div>
                </div>
                {canEditThis ? (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <select
                      value={m.role}
                      disabled={busyId === m.user_id}
                      onChange={(e) => changeRole(m.user_id, e.target.value as Role)}
                      className="h-7 px-1.5 rounded-md text-[11px] border"
                      style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}
                    >
                      {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                    <button type="button" onClick={() => removeMember(m.user_id)} disabled={busyId === m.user_id}
                      className="h-7 px-2 rounded-md text-[11px] border transition-colors"
                      style={{ borderColor: 'rgba(248,113,113,0.32)', color: '#f87171', background: 'rgba(248,113,113,0.06)' }}>
                      移除
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}
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
