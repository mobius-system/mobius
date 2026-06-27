import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../store'
import { ToggleSwitch } from './toggle-switch'

type ContextItem = {
  id: string
  name: string
  description?: string
  scope?: string
}

type WhitelistPayload = {
  skill_whitelist_enabled?: boolean
  builtin_skill_whitelist_enabled?: boolean
  memory_whitelist_enabled?: boolean
  skill_ids?: string[]
  builtin_skill_ids?: string[]
  memory_ids?: string[]
  available_skills?: ContextItem[]
  available_builtin_skills?: ContextItem[]
  available_memories?: ContextItem[]
  updated_at?: string | null
}

function idsInAvailableOrder(items: ContextItem[], selected: Set<string>) {
  return items.filter(item => selected.has(item.id)).map(item => item.id)
}

function stateKey(
  skillEnabled: boolean,
  builtinSkillEnabled: boolean,
  memoryEnabled: boolean,
  skillIds: string[],
  builtinSkillIds: string[],
  memoryIds: string[],
) {
  return JSON.stringify({
    skillEnabled,
    builtinSkillEnabled,
    memoryEnabled,
    skillIds: [...skillIds].sort(),
    builtinSkillIds: [...builtinSkillIds].sort(),
    memoryIds: [...memoryIds].sort(),
  })
}

function WhitelistGroup({
  title,
  enabled,
  items,
  selected,
  onEnabledChange,
  onSelectedChange,
  emptyText = '暂无用户级条目',
}: {
  title: string
  enabled: boolean
  items: ContextItem[]
  selected: Set<string>
  onEnabledChange: (enabled: boolean) => void
  onSelectedChange: (ids: Set<string>) => void
  emptyText?: string
}) {
  const selectedCount = items.filter(item => selected.has(item.id)).length

  const setAll = () => onSelectedChange(new Set(items.map(item => item.id)))
  const setNone = () => onSelectedChange(new Set())
  const toggle = (id: string) => {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    onSelectedChange(next)
  }

  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--input-border)', background: 'var(--bg-primary)' }}>
      <div className="flex items-center gap-2 mb-2">
        <ToggleSwitch
          checked={enabled}
          onChange={nextEnabled => {
            onEnabledChange(nextEnabled)
            if (nextEnabled && selected.size === 0) setAll()
          }}
          className="flex items-center gap-3 text-[13px]"
          style={{ color: 'var(--text-primary)' }}>
          {title}
        </ToggleSwitch>
        <span className="ml-auto text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {enabled ? `${selectedCount}/${items.length}` : '未启用'}
        </span>
      </div>

      {enabled && (
        <>
          <div className="flex gap-1.5 mb-2">
            <button type="button" onClick={setAll}
              className="text-[10px] px-2 py-0.5 rounded border"
              style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>全选</button>
            <button type="button" onClick={setNone}
              className="text-[10px] px-2 py-0.5 rounded border"
              style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>全不选</button>
          </div>

          {items.length === 0 ? (
            <div className="text-[12px] py-3 text-center" style={{ color: 'var(--text-muted)' }}>{emptyText}</div>
          ) : (
            <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
              {items.map(item => {
                const checked = selected.has(item.id)
                return (
                  <label key={item.id}
                    className="flex items-start gap-2 -mx-1 px-1 py-1 rounded cursor-pointer hover:bg-[var(--bg-card-hover)]">
                    <input type="checkbox" checked={checked} onChange={() => toggle(item.id)}
                      className="mt-0.5 accent-blue-500 cursor-pointer" />
                    <div className="min-w-0 flex-1" style={{ opacity: checked ? 1 : 0.45 }}>
                      <div className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>{item.name}</div>
                      {item.description && (
                        <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{item.description}</div>
                      )}
                    </div>
                  </label>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function ProjectUserContextWhitelist({ projectId }: { projectId: string }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [info, setInfo] = useState('')
  const [availableSkills, setAvailableSkills] = useState<ContextItem[]>([])
  const [availableBuiltinSkills, setAvailableBuiltinSkills] = useState<ContextItem[]>([])
  const [availableMemories, setAvailableMemories] = useState<ContextItem[]>([])
  const [skillEnabled, setSkillEnabled] = useState(false)
  const [builtinSkillEnabled, setBuiltinSkillEnabled] = useState(false)
  const [memoryEnabled, setMemoryEnabled] = useState(false)
  const [skillIds, setSkillIds] = useState<Set<string>>(new Set())
  const [builtinSkillIds, setBuiltinSkillIds] = useState<Set<string>>(new Set())
  const [memoryIds, setMemoryIds] = useState<Set<string>>(new Set())
  const [initialKey, setInitialKey] = useState('')

  const applyPayload = useCallback((data: WhitelistPayload) => {
    const skills = Array.isArray(data.available_skills) ? data.available_skills : []
    const builtinSkills = Array.isArray(data.available_builtin_skills) ? data.available_builtin_skills : []
    const memories = Array.isArray(data.available_memories) ? data.available_memories : []
    const nextSkillIds = new Set((data.skill_ids || []).filter(id => skills.some(item => item.id === id)))
    const nextBuiltinSkillIds = new Set((data.builtin_skill_ids || []).filter(id => builtinSkills.some(item => item.id === id)))
    const nextMemoryIds = new Set((data.memory_ids || []).filter(id => memories.some(item => item.id === id)))
    const nextSkillEnabled = !!data.skill_whitelist_enabled
    const nextBuiltinSkillEnabled = !!data.builtin_skill_whitelist_enabled
    const nextMemoryEnabled = !!data.memory_whitelist_enabled

    setAvailableSkills(skills)
    setAvailableBuiltinSkills(builtinSkills)
    setAvailableMemories(memories)
    setSkillEnabled(nextSkillEnabled)
    setBuiltinSkillEnabled(nextBuiltinSkillEnabled)
    setMemoryEnabled(nextMemoryEnabled)
    setSkillIds(nextSkillIds)
    setBuiltinSkillIds(nextBuiltinSkillIds)
    setMemoryIds(nextMemoryIds)
    setInitialKey(stateKey(
      nextSkillEnabled,
      nextBuiltinSkillEnabled,
      nextMemoryEnabled,
      idsInAvailableOrder(skills, nextSkillIds),
      idsInAvailableOrder(builtinSkills, nextBuiltinSkillIds),
      idsInAvailableOrder(memories, nextMemoryIds),
    ))
  }, [])

  const refresh = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setErr('')
    setInfo('')
    try {
      const data: WhitelistPayload = await api(`/api/projects/${projectId}/user-context-whitelist`)
      applyPayload(data)
    } catch (e: any) {
      setErr(e?.message || '加载白名单失败')
    } finally {
      setLoading(false)
    }
  }, [applyPayload, projectId])

  useEffect(() => { refresh() }, [refresh])

  const selectedSkillIds = useMemo(() => idsInAvailableOrder(availableSkills, skillIds), [availableSkills, skillIds])
  const selectedBuiltinSkillIds = useMemo(() => idsInAvailableOrder(availableBuiltinSkills, builtinSkillIds), [availableBuiltinSkills, builtinSkillIds])
  const selectedMemoryIds = useMemo(() => idsInAvailableOrder(availableMemories, memoryIds), [availableMemories, memoryIds])
  const currentKey = useMemo(() => stateKey(skillEnabled, builtinSkillEnabled, memoryEnabled, selectedSkillIds, selectedBuiltinSkillIds, selectedMemoryIds),
    [skillEnabled, builtinSkillEnabled, memoryEnabled, selectedSkillIds, selectedBuiltinSkillIds, selectedMemoryIds])
  const dirty = currentKey !== initialKey

  const save = async () => {
    setSaving(true)
    setErr('')
    setInfo('')
    try {
      const data: WhitelistPayload = await api(`/api/projects/${projectId}/user-context-whitelist`, {
        method: 'PATCH',
        body: JSON.stringify({
          skill_whitelist_enabled: skillEnabled,
          builtin_skill_whitelist_enabled: builtinSkillEnabled,
          memory_whitelist_enabled: memoryEnabled,
          skill_ids: selectedSkillIds,
          builtin_skill_ids: selectedBuiltinSkillIds,
          memory_ids: selectedMemoryIds,
        }),
      })
      applyPayload(data)
      setInfo('已保存')
    } catch (e: any) {
      setErr(e?.message || '保存白名单失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-tour="project-context-whitelist" className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Skill与Memory过滤</h3>
          <p className="text-[12px] mt-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            通过白名单，屏蔽与本项目无关的全局Skill与Memory（用户级 & Mobius内置），不让它们出现在本项目Session创建菜单中。
          </p>
        </div>
        <button type="button" onClick={refresh} disabled={loading || saving}
          className="h-7 px-2.5 rounded text-[11px] border hover:bg-[var(--bg-card-hover)] transition-colors disabled:opacity-40"
          style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>刷新</button>
      </div>

      {loading ? (
        <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : (
        <div className="space-y-3">
          <WhitelistGroup
            title="启用用户级 Skill 白名单"
            enabled={skillEnabled}
            items={availableSkills}
            selected={skillIds}
            onEnabledChange={setSkillEnabled}
            onSelectedChange={setSkillIds}
          />
          <WhitelistGroup
            title="启用内置 Skill 白名单"
            enabled={builtinSkillEnabled}
            items={availableBuiltinSkills}
            selected={builtinSkillIds}
            onEnabledChange={setBuiltinSkillEnabled}
            onSelectedChange={setBuiltinSkillIds}
            emptyText="暂无内置 Skill"
          />
          <WhitelistGroup
            title="启用用户级 Memory 白名单"
            enabled={memoryEnabled}
            items={availableMemories}
            selected={memoryIds}
            onEnabledChange={setMemoryEnabled}
            onSelectedChange={setMemoryIds}
          />

          {err && <div className="text-[12px] text-red-400">{err}</div>}
          {info && <div className="text-[12px] text-emerald-400">{info}</div>}

          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => {
              setSkillEnabled(false)
              setBuiltinSkillEnabled(false)
              setMemoryEnabled(false)
              setSkillIds(new Set())
              setBuiltinSkillIds(new Set())
              setMemoryIds(new Set())
            }}
              disabled={saving || (!skillEnabled && !builtinSkillEnabled && !memoryEnabled && skillIds.size === 0 && builtinSkillIds.size === 0 && memoryIds.size === 0)}
              className="h-8 px-3 rounded-lg text-[12px] border hover:bg-[var(--bg-card-hover)] transition-colors disabled:opacity-40"
              style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>恢复默认</button>
            <button type="button" onClick={save} disabled={saving || !dirty}
              className="h-8 px-3 rounded-lg text-[12px] btn-primary transition-colors disabled:opacity-40">
              {saving ? '保存中...' : '保存白名单'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
