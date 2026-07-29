import { useEffect, useState } from 'react'
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

// GitLab 风格"邀请成员": 选人 (UserPicker) + 批次角色 + 按员工群组一键加入;
// 下方待添加列表每人可单独改角色. 取代原先并排的"添加用户(allowlist)"+"项目组成员"两个框.
const ROLE_OPTIONS: Array<{ value: ProjectMemberRole; label: string; hint: string }> = [
  { value: 'member', label: '开发者', hint: '可读可写' },
  { value: 'manager', label: '项目管理员', hint: '可管理成员' },
  { value: 'viewer', label: '访客', hint: '只读' },
]
const DEFAULT_ROLE: ProjectMemberRole = 'member'

export function ProjectMemberInvite({ value, onChange, currentUserId, disabled }: ProjectMemberInviteProps) {
  const [pickerIds, setPickerIds] = useState<string[]>([])
  const [batchRole, setBatchRole] = useState<ProjectMemberRole>(DEFAULT_ROLE)
  const [nameMap, setNameMap] = useState<Record<string, string>>({})
  const [groups, setGroups] = useState<Array<{ id: string; name: string; active_user_count: number }>>([])
  const [groupOpen, setGroupOpen] = useState(false)

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

  return (
    <div className="space-y-2">
      <label className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>项目成员（可选）</label>
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

      <div className="relative">
        <button
          type="button"
          onClick={toggleGroups}
          disabled={disabled}
          className="text-[11px] px-2 py-1 rounded-md border"
          style={{ borderColor: 'var(--input-border)', color: 'var(--text-muted)', background: 'var(--input-bg)' }}
        >
          + 按员工群组加入
        </button>
        {groupOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setGroupOpen(false)} />
            <div
              className="absolute z-50 mt-1 w-64 max-h-60 overflow-auto rounded-lg border shadow-lg"
              style={{ background: 'var(--modal-bg)', borderColor: 'var(--input-border)' }}
            >
              {groups.length === 0 ? (
                <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无群组</div>
              ) : (
                groups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => addGroup(g.id)}
                    className="block w-full text-left px-3 py-2 text-[12px] hover:bg-[var(--bg-card-hover)] transition-colors"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {g.name} <span style={{ color: 'var(--text-muted)' }}>· {g.active_user_count} 位启用成员</span>
                  </button>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {value.length > 0 && (
        <div className="rounded-lg border divide-y" style={{ borderColor: 'var(--input-border)' }}>
          {value.map((m) => {
            const roleOpt = ROLE_OPTIONS.find((r) => r.value === m.role) || ROLE_OPTIONS[0]
            return (
              <div key={m.user_id} className="flex items-center gap-2 px-2.5 py-1.5" style={{ borderColor: 'var(--input-border)' }}>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>{nameMap[m.user_id] || m.user_id}</div>
                  <div className="text-[10px] font-mono truncate" style={{ color: 'var(--text-muted)' }}>{m.user_id}</div>
                </div>
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
                <button
                  type="button"
                  onClick={() => remove(m.user_id)}
                  disabled={disabled}
                  className="h-7 w-7 flex items-center justify-center rounded-md text-[12px]"
                  style={{ color: '#f87171' }}
                >✕</button>
              </div>
            )
          })}
        </div>
      )}
      <p className="text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>
        创建者自动成为项目负责人。开发者可读可写、项目管理员可管理成员、访客只读；创建后可在项目设置中调整。
      </p>
    </div>
  )
}
