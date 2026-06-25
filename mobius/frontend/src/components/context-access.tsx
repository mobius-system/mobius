import { useEffect, useState } from 'react'
import { api } from '../store'
import { UserPicker } from './user-picker'

type ContextVisibility = 'inherit' | 'private' | 'team' | 'public' | 'allowlist'

const BASE_OPTIONS: Array<{ value: ContextVisibility; label: string; description: string }> = [
  { value: 'inherit', label: '继承项目', description: '跟随所属项目的可见性。' },
  { value: 'private', label: '仅自己', description: '只有创建者和管理员可见。' },
  { value: 'team', label: '同组', description: '同一群组用户可见。' },
  { value: 'public', label: '公开', description: '所有登录用户可见，可复制到自己的空间。' },
  { value: 'allowlist', label: '指定用户', description: '只有创建者、管理员和允许名单中的用户可见。' },
]

function normalizeVisibility(value: any, fallback: ContextVisibility): ContextVisibility {
  return ['inherit', 'private', 'team', 'public', 'allowlist'].includes(value) ? value : fallback
}

export function ContextAccessModal({
  baseUrl,
  item,
  kindLabel,
  onClose,
  onSaved,
}: {
  baseUrl: string
  item: any
  kindLabel: string
  onClose: () => void
  onSaved: () => void
}) {
  const fallbackVisibility: ContextVisibility = item?.scope === 'project' ? 'inherit' : 'private'
  const [visibility, setVisibility] = useState<ContextVisibility>(normalizeVisibility(item?.visibility, fallbackVisibility))
  const [allowUserIds, setAllowUserIds] = useState<string[]>(
    Array.isArray(item?.access?.allow_user_ids) ? item.access.allow_user_ids : [],
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const options = item?.scope === 'project'
    ? BASE_OPTIONS
    : BASE_OPTIONS.filter((option) => option.value !== 'inherit')

  useEffect(() => {
    let alive = true
    setLoading(true)
    api(`${baseUrl}/${item.id}/access`)
      .then((access: any) => {
        if (!alive) return
        const nextVisibility = normalizeVisibility(access?.visibility, fallbackVisibility)
        setVisibility(nextVisibility === 'inherit' && item?.scope !== 'project' ? 'private' : nextVisibility)
        setAllowUserIds(Array.isArray(access?.allow_user_ids) ? access.allow_user_ids : [])
      })
      .catch((e: any) => { if (alive) setErr(e?.message || '读取权限失败') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [baseUrl, item.id])

  const save = async () => {
    setSaving(true); setErr('')
    try {
      await api(`${baseUrl}/${item.id}/access`, {
        method: 'PATCH',
        body: JSON.stringify({
          visibility,
          allow_user_ids: allowUserIds,
        }),
      })
      onSaved()
    } catch (e: any) {
      setErr(e?.message || '保存权限失败')
    } finally {
      setSaving(false)
    }
  }

  const showAllowPicker = visibility === 'allowlist'

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-[560px] max-h-[84vh] rounded-2xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div className="min-w-0">
            <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {kindLabel} 权限
            </div>
            <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>{item?.name || item?.id}</div>
          </div>
          <button onClick={onClose} disabled={saving}
            className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-40"
            style={{ color: 'var(--text-muted)' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-auto">
          {loading ? (
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          ) : (
            <>
              <div>
                <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>可见性</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {options.map((option) => {
                    const active = visibility === option.value
                    return (
                      <button key={option.value} type="button" onClick={() => setVisibility(option.value)}
                        title={option.description}
                        className="h-8 rounded-lg border text-[12px] transition-colors"
                        style={active
                          ? { background: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.48)', color: '#60a5fa' }
                          : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
                        {option.label}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  {options.find(option => option.value === visibility)?.description}
                </p>
              </div>
              {showAllowPicker ? (
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
                    允许访问的用户
                  </label>
                  <UserPicker
                    selectedIds={allowUserIds}
                    onChange={setAllowUserIds}
                    placeholder="输入用户名或 ID 添加..."
                  />
                  <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                    创建者、管理员始终可见；这里的名单只追加额外允许的用户。
                  </p>
                </div>
              ) : (
                <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  当前可见性为「{options.find(o => o.value === visibility)?.label || visibility}」，不需要单独指定允许名单。
                </p>
              )}
              {err && <pre className="text-[11px] text-red-400 whitespace-pre-wrap break-all">{err}</pre>}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border-color)' }}>
          <button onClick={onClose} disabled={saving}
            className="h-8 px-3 text-[12px] rounded border disabled:opacity-40"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>取消</button>
          <button onClick={save} disabled={loading || saving}
            className="h-8 px-4 text-[12px] rounded btn-primary transition-colors disabled:opacity-40">
            {saving ? '保存中...' : '保存权限'}
          </button>
        </div>
      </div>
    </div>
  )
}
