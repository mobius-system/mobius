import { UserPicker } from './user-picker'

type ProjectMembersFieldProps = {
  selectedIds: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}

// 创建项目时选择首批"项目组成员" (member 角色). 与 ProjectAllowlistField 区别:
// allowlist = 可见性读者 (只读共享); 项目组成员 = 协作层 (有角色, 可读可写可管理).
// 创建者本人无需在此选择 —— 他会自动成为项目负责人 (owner).
export function ProjectMembersField({ selectedIds, onChange, disabled }: ProjectMembersFieldProps) {
  return (
    <div>
      <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
        项目组成员（可选）
      </label>
      <UserPicker
        selectedIds={selectedIds}
        onChange={onChange}
        disabled={disabled}
        placeholder="输入用户名或 ID 添加成员..."
        emptyHint="可不选；创建者会自动成为项目负责人"
      />
      <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
        选中的员工将以「项目成员」身份加入，创建后可在项目设置中调整角色与成员。
      </p>
    </div>
  )
}
