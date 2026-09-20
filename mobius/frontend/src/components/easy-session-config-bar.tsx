// =====================================================================
// 简易模式欢迎页的会话配置条 — 挂在 EasySessionChatInput (create_session_mode) 的工具栏上.
//
// 五项配置全部来自既有链路, 不新造机制:
//   项目   : 商店里的全部项目 (父级传入)
//   任务   : 选了项目 → 该项目下的任务 (活跃的排在前面); 未选项目 → 近期活跃任务 (取自近期会话)
//   模型   : 任务上次所选 > 项目默认 > 全局默认 > 内置 codex (services/global-default-model)
//   语言   : 默认中文
//   记忆和技能: 复用 SkillMemoryPicker 的单入口弹窗形态, 默认排除集取任务级 context-preview
// =====================================================================
import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, CircleDot, FolderKanban, FolderOpen, Languages, Type } from 'lucide-react'
import { api } from '../store'
import { fetchGlobalDefaultModel, resolveDefaultModelKey } from '../services/global-default-model'
import {
  DropdownSelect,
  SkillMemoryPicker,
  type DropdownOption,
  type PickItem,
  type SessionLanguage,
} from './global-create'

/** 欢迎页提交时需要的全部选择 */
export type EasySessionSelection = {
  createProject: boolean
  projectId: string
  issueId: string
  /** 目标任务标题, 用于自动生成会话名; 未选任务时为空 */
  issueTitle: string
  model: string
  language: SessionLanguage
  excludedSkills: string[]
  excludedMemories: string[]
  projectPath: string
  projectName: string
}

export const EMPTY_EASY_SESSION_SELECTION: EasySessionSelection = {
  createProject: false,
  projectId: '',
  issueId: '',
  issueTitle: '',
  model: '',
  language: 'zh',
  excludedSkills: [],
  excludedMemories: [],
  projectPath: '',
  projectName: '',
}

type ProjectLite = { id: string; name?: string; default_model?: string | null }

/** 近期活跃任务的数据源: /api/tasks/recent 返回的会话行 */
type RecentSessionLite = {
  issue_id?: string | null
  issue_title?: string | null
  project_id?: string | null
  project_name?: string | null
}

type TaskOption = { id: string; title: string; projectId?: string; projectName?: string; active?: boolean }
type ModelOption = { key: string; label?: string; title?: string; sub?: string; is_default?: boolean }

const LANGUAGE_OPTIONS: DropdownOption[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

/** 活跃任务排在前面, 同组内保持接口返回的 last_active 倒序 */
function activeFirst(items: any[]): any[] {
  return [...items].sort((a, b) => (a?.status === 'active' ? 0 : 1) - (b?.status === 'active' ? 0 : 1))
}

/** 欢迎页输入框上方的创建方式 Tab，共用原有 selection。 */
export function EasySessionModeTabs({ selection, onChange }: {
  selection: EasySessionSelection
  onChange: (next: EasySessionSelection) => void
}) {
  const modes = [{ createProject: false, label: '新建会话' }, { createProject: true, label: '全新项目' }]
  const selectMode = (next: boolean) => {
    if (next === selection.createProject) return
    onChange({
      ...selection,
      createProject: next,
      projectId: '',
      issueId: '',
      issueTitle: '',
      projectPath: next ? selection.projectPath : '',
      projectName: next ? selection.projectName : '',
      excludedSkills: [],
      excludedMemories: [],
    })
  }
  return (
    <div className="easy-welcome-mode-tabs" role="tablist" aria-label="创建方式">
      {modes.map((mode, index) => (
        <button
          key={mode.label}
          id={`easy-welcome-mode-${index}`}
          type="button"
          role="tab"
          aria-label={mode.label}
          aria-selected={selection.createProject === mode.createProject}
          aria-controls="easy-welcome-composer"
          tabIndex={selection.createProject === mode.createProject ? 0 : -1}
          onClick={() => selectMode(mode.createProject)}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index
            selectMode(modes[nextIndex].createProject)
            document.getElementById(`easy-welcome-mode-${nextIndex}`)?.focus()
          }}
        >{mode.label}</button>
      ))}
    </div>
  )
}

export function EasySessionConfigBar({ selection, onChange, projects, recentSessions, dark }: {
  selection: EasySessionSelection
  onChange: (next: EasySessionSelection) => void
  projects: ProjectLite[]
  recentSessions: RecentSessionLite[]
  dark: boolean
}) {
  const [projectIssues, setProjectIssues] = useState<any[]>([])
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [globalDefaultModel, setGlobalDefaultModel] = useState('')
  const [scopeLastModel, setScopeLastModel] = useState('')
  const [availSkills, setAvailSkills] = useState<PickItem[]>([])
  const [availMemories, setAvailMemories] = useState<PickItem[]>([])
  // 用户手动点过模型后, 在切换任务前不再自动回落 (与新建快捷会话表单一致)
  const modelTouchedRef = useRef(false)
  // effect 里要读最新 selection / onChange, 但不能把它们放进依赖(会重复触发), 用 ref 兜住
  const latestRef = useRef({ selection, onChange })
  latestRef.current = { selection, onChange }

  const { createProject, projectId, issueId } = selection

  useEffect(() => {
    let alive = true
    api('/api/sessions/model-options')
      .then((arr: any) => { if (alive && Array.isArray(arr)) setModelOptions(arr) })
      .catch(() => { /* 拉不到就只显示当前值, 不阻塞创建 */ })
    fetchGlobalDefaultModel().then(v => { if (alive) setGlobalDefaultModel(v) })
    return () => { alive = false }
  }, [])

  // 二级联动: 选定项目后拉该项目全部任务 (不传 status → 活跃与已完成都可见)
  useEffect(() => {
    if (!projectId) { setProjectIssues([]); return }
    let alive = true
    api(`/api/projects/${projectId}/issues`)
      .then((r: any) => {
        if (!alive) return
        setProjectIssues(activeFirst(Array.isArray(r) ? r : (r?.issues || [])))
      })
      .catch(() => { if (alive) setProjectIssues([]) })
    return () => { alive = false }
  }, [projectId])

  // 任务变更 → 拉该任务的上下文预览: 可用 Skill/Memory、默认排除集、上次所选模型
  useEffect(() => {
    if (!issueId) {
      setAvailSkills([]); setAvailMemories([]); setScopeLastModel('')
      return
    }
    let alive = true
    modelTouchedRef.current = false
    api(`/api/issues/${issueId}/context-preview`, {
      method: 'POST',
      body: JSON.stringify({ name: ' ', description: ' ', excluded_skill_ids: [], excluded_memory_ids: [], include_defaults: true, include_body: false, include_item_bodies: false }),
    }).then((p: any) => {
      if (!alive) return
      const skills: PickItem[] = (p?.sources?.skills || []).map((s: any) => ({ id: s.id, name: s.name, description: s.description, scope: s.scope || 'project', dirName: s.dirName }))
      const memories: PickItem[] = (p?.sources?.memories || []).map((m: any) => ({ id: m.id, name: m.name, description: m.description, scope: m.scope || 'project' }))
      setAvailSkills(skills)
      setAvailMemories(memories)
      setScopeLastModel(typeof p?.defaults?.model === 'string' ? p.defaults.model : '')
      // 勾选随任务重置为该任务的默认排除集 (用户上一次的勾选只在那个任务内有效)
      const skillIds = new Set(skills.map(s => s.id))
      const memIds = new Set(memories.map(m => m.id))
      const { selection: latest, onChange: emit } = latestRef.current
      emit({
        ...latest,
        excludedSkills: (p?.defaults?.excluded_skill_ids || []).filter((id: string) => skillIds.has(id)),
        excludedMemories: (p?.defaults?.excluded_memory_ids || []).filter((id: string) => memIds.has(id)),
      })
    }).catch(() => {
      if (!alive) return
      setAvailSkills([]); setAvailMemories([]); setScopeLastModel('')
    })
    return () => { alive = false }
  }, [issueId])

  useEffect(() => {
    modelTouchedRef.current = false
  }, [createProject])

  const selectedProject = projects.find(p => p.id === projectId)
  // 模型三级默认: 任务上次所选 > 项目默认 > 全局默认 > 内置 codex
  useEffect(() => {
    if (modelTouchedRef.current) return
    let next = resolveDefaultModelKey({ scopeLastModel, projectDefaultModel: selectedProject?.default_model, globalDefaultModel })
    if (modelOptions.length > 0 && !modelOptions.some(o => o.key === next)) {
      next = modelOptions.find(o => o.is_default)?.key || modelOptions[0].key
    }
    if (next && next !== latestRef.current.selection.model) {
      latestRef.current.onChange({ ...latestRef.current.selection, model: next })
    }
  }, [createProject, scopeLastModel, selectedProject?.default_model, globalDefaultModel, modelOptions])

  // 未选项目时的任务候选: 近期会话里出现过的任务, 按最近活跃排序, 同一任务只留一条
  const recentTasks = useMemo<TaskOption[]>(() => {
    const seen = new Set<string>()
    const out: TaskOption[] = []
    for (const s of recentSessions) {
      const id = s.issue_id ? String(s.issue_id) : ''
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push({ id, title: s.issue_title || id, projectId: s.project_id || undefined, projectName: s.project_name || undefined })
      if (out.length >= 30) break
    }
    return out
  }, [recentSessions])

  const selectedProjectName = selectedProject?.name || ''
  const taskOptions: DropdownOption[] = useMemo(() => (
    projectId
      ? projectIssues.map((i: any) => ({
        value: String(i.id),
        label: String(i.title || i.id),
        description: i.status === 'active' ? selectedProjectName : `${selectedProjectName} · 已完成`,
      }))
      : recentTasks.map(t => ({
        value: t.id,
        label: t.title,
        description: t.projectName,
      }))
  ), [projectId, projectIssues, recentTasks, selectedProjectName])

  const projectOptions: DropdownOption[] = useMemo(() => projects.map(p => ({
    value: String(p.id),
    label: String(p.name || p.id),
    description: p.default_model ? `默认模型 ${p.default_model}` : undefined,
  })), [projects])

  const modelSelectOptions: DropdownOption[] = useMemo(() => modelOptions.map(o => ({
    value: o.key,
    label: String(o.title || o.label || o.key),
    description: o.sub ? String(o.sub) : undefined,
  })), [modelOptions])

  const toggleExcluded = (kind: 'skill' | 'memory', id: string) => {
    const { selection: latest, onChange: emit } = latestRef.current
    const key = kind === 'skill' ? 'excludedSkills' : 'excludedMemories'
    const list = latest[key]
    emit({ ...latest, [key]: list.includes(id) ? list.filter(x => x !== id) : [...list, id] })
  }

  return (
    <>
      {createProject ? (
        <>
          <label className="relative min-w-0 flex-1" title={selection.projectPath || '路径'}>
            <FolderOpen className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: selection.projectPath.trim() ? '#60a5fa' : 'var(--text-muted)' }} />
            <input
              value={selection.projectPath}
              onChange={event => onChange({ ...selection, projectPath: event.target.value })}
              aria-label="路径"
              placeholder="路径"
              className="h-7 w-full min-w-[116px] rounded-lg border bg-transparent pl-7 pr-2 text-[11px] outline-none transition-colors placeholder:!text-[var(--placeholder-color)] focus:border-blue-500/60"
              style={{ borderColor: selection.projectPath.trim() ? 'rgba(59,130,246,0.72)' : 'var(--input-border)', color: dark ? '#f1f5f9' : '#1e293b' }}
            />
          </label>
          <label className="relative min-w-0 flex-1" title={selection.projectName || '项目名'}>
            <Type className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: selection.projectName.trim() ? '#60a5fa' : 'var(--text-muted)' }} />
            <input
              value={selection.projectName}
              onChange={event => onChange({ ...selection, projectName: event.target.value })}
              aria-label="项目名"
              placeholder="项目名"
              className="h-7 w-full min-w-[96px] rounded-lg border bg-transparent pl-7 pr-2 text-[11px] outline-none transition-colors placeholder:!text-[var(--placeholder-color)] focus:border-blue-500/60"
              style={{ borderColor: selection.projectName.trim() ? 'rgba(59,130,246,0.72)' : 'var(--input-border)', color: dark ? '#f1f5f9' : '#1e293b' }}
            />
          </label>
        </>
      ) : (
        <>
          <DropdownSelect
            size="sm"
            iconOnly
            dark={dark}
            icon={<FolderKanban className="h-3.5 w-3.5" />}
            value={projectId}
            placeholder="项目"
            emptyText="暂无可用项目"
            options={projectOptions}
            onChange={v => {
              // 换项目 → 任务必然作废; 模型回到新项目的默认链路
              modelTouchedRef.current = false
              const { onChange: emit } = latestRef.current
              emit({ ...latestRef.current.selection, projectId: v, issueId: '', issueTitle: '', excludedSkills: [], excludedMemories: [] })
            }}
          />
          <DropdownSelect
            size="sm"
            iconOnly
            dark={dark}
            icon={<CircleDot className="h-3.5 w-3.5" />}
            value={issueId}
            placeholder="任务"
            emptyText={projectId ? '该项目下暂无任务' : '暂无近期任务'}
            options={taskOptions}
            onChange={v => {
              const { selection: latest, onChange: emit } = latestRef.current
              const picked = taskOptions.find(o => o.value === v)
              const recentTask = !latest.projectId ? recentTasks.find(task => task.id === v) : undefined
              emit({
                ...latest,
                projectId: latest.projectId || recentTask?.projectId || '',
                issueId: v,
                issueTitle: picked ? picked.label : '',
              })
            }}
          />
        </>
      )}
      <DropdownSelect
        size="sm"
        iconOnly
        dark={dark}
        icon={<Brain className="h-3.5 w-3.5" />}
        value={selection.model}
        placeholder="模型"
        emptyText="暂无可用模型"
        options={modelSelectOptions}
        onChange={v => {
          modelTouchedRef.current = true
          const { selection: latest, onChange: emit } = latestRef.current
          emit({ ...latest, model: v })
        }}
      />
      <DropdownSelect
        size="sm"
        iconOnly
        dark={dark}
        icon={<Languages className="h-3.5 w-3.5" />}
        value={selection.language}
        placeholder="语言"
        options={LANGUAGE_OPTIONS}
        onChange={v => {
          const { selection: latest, onChange: emit } = latestRef.current
          emit({ ...latest, language: v as SessionLanguage })
        }}
      />
      <SkillMemoryPicker
        singleTrigger
        iconOnlyTrigger
        dark={dark}
        skills={availSkills}
        memories={availMemories}
        excludedSkills={new Set(selection.excludedSkills)}
        excludedMemories={new Set(selection.excludedMemories)}
        onToggleSkill={id => toggleExcluded('skill', id)}
        onToggleMemory={id => toggleExcluded('memory', id)}
        disabled={createProject || !issueId}
      />
    </>
  )
}
