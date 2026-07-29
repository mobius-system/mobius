import { UserPicker } from './user-picker'

type ProjectVisibility = 'private' | 'team' | 'public' | 'allowlist'

type ProjectAllowlistFieldProps = {
  visibility: ProjectVisibility
  selectedIds: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}

export function ProjectAllowlistField({
  visibility,
  selectedIds,
  onChange,
  disabled,
}: ProjectAllowlistFieldProps) {
  const active = visibility === 'allowlist'
  return (
    <div>
      <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
        添加用户
        {!active && (
          <span className="ml-1.5" style={{ color: 'var(--text-muted)' }}>
            （仅在「指定用户」可见性下生效）
          </span>
        )}
      </label>
      <UserPicker
        selectedIds={selectedIds}
        onChange={onChange}
        disabled={disabled}
        placeholder={active ? '输入用户名或 ID 添加...' : '允许名单已保留，切到「指定用户」后生效'}
        emptyHint={active ? '点击选择用户，或输入用户名搜索' : '允许名单当前不生效'}
      />
      {selectedIds.length > 0 && (
        <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
          在「指定用户」可见性下，项目创建者、管理员和名单中的用户可见。
        </p>
      )}
    </div>
  )
}
