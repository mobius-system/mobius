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
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Brain, FolderKanban, FolderOpen, Languages, ListChecks, Type } from 'lucide-react'
import { api } from '../store'
import { createPortal } from 'react-dom'
import { lazyWithRetry } from '../services/handle-stale-chunk'
import { fetchGlobalDefaultModel, resolveDefaultModelKey } from '../services/global-default-model'
import { EasySessionProjectSelector } from './easy-session-project-selector'

// 路径选择弹窗只有点"浏览"才出现, 按需加载 — 否则欢迎页配置条会把整个 modals 模块
// (连带 markdown 渲染栈)算进简易模式首屏.
// The path picker only appears after clicking "browse", so it loads on demand; a static
// import would make the welcome config bar pull the whole modals module into first paint.
const PathPickerModal = lazyWithRetry(() => import('./modals').then(module => ({ default: module.PathPickerModal })))
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
  projectPathManual?: boolean
  projectName: string
  /** 新会话跑在哪台设备上 (空 = 跑在中枢) */
  deviceId: string
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
  deviceId: '',
}

type ProjectLite = { id: string; name?: string; default_model?: string | null; can_create_session?: boolean }

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
      projectPathManual: next ? selection.projectPathManual : false,
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

export function EasySessionConfigBar({ selection, onChange, projects, recentSessions, dark, onCreateProject }: {
  selection: EasySessionSelection
  onChange: (next: EasySessionSelection) => void
  projects: ProjectLite[]
  recentSessions: RecentSessionLite[]
  dark: boolean
  /** 打开「新建项目」弹窗 (项目选择器的 + 入口) */
  onCreateProject: () => void
}) {
  const [pathPickerOpen, setPathPickerOpen] = useState(false)
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

  // 数据源: 选中任务 → 该任务级上下文预览; 未选任务 → 用户级 + 内置条目直通 (方案 B, 欢迎页零前置可用).
  // 勾选的默认排除集只在任务级预览里回填 (用户上一次的勾选保存在那个任务里).
  useEffect(() => {
    if (createProject || !issueId) {
      // 全新项目 / 未选任务: 拉用户级 + 内置清单, 选择器保持可用
      let alive = true
      setAvailSkills([]); setAvailMemories([]); setScopeLastModel('')
      Promise.all([api('/api/skills/creation-options'), api('/api/memories')]).then(([skills, memories]) => {
        if (!alive) return
        setAvailSkills((Array.isArray(skills) ? skills : []).filter((s: PickItem) => s.scope === 'user' || s.scope === 'builtin'))
        setAvailMemories((Array.isArray(memories) ? memories : []).filter((m: PickItem) => m.scope === 'user'))
      }).catch(() => { if (alive) { setAvailSkills([]); setAvailMemories([]) } })
      return () => { alive = false }
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
  }, [createProject, issueId])

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

  // 后端在每个项目上带 can_create_session (按项目成员角色判定): 只读项目选进去也建不了
  // 会话, 会在提交时拿到 403「无权在此 Issue 创建 Session」, 所以这里直接置灰并说明原因,
  // 让"能不能在这个项目里对话"在选之前就看得见.
  const projectOptions: DropdownOption[] = useMemo(() => projects.map(p => ({
    value: String(p.id),
    label: String(p.name || p.id),
    description: p.can_create_session === false
      ? '只读项目 · 无创建会话权限'
      : (p.default_model ? `默认模型 ${p.default_model}` : undefined),
    disabled: p.can_create_session === false,
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

  // 全选 / 全不选: 一次性 emit 整批, 循环里连调 toggleExcluded 会因 ref 未及时更新而互相覆盖.
  // Select-all / select-none emits the whole batch at once; a loop of toggleExcluded would
  // clobber itself because latestRef only refreshes on the next render.
  const bulkExcluded = (kind: 'skill' | 'memory', ids: string[], excluded: boolean) => {
    const { selection: latest, onChange: emit } = latestRef.current
    const key = kind === 'skill' ? 'excludedSkills' : 'excludedMemories'
    const next = new Set(latest[key])
    for (const id of ids) { if (excluded) next.add(id); else next.delete(id) }
    emit({ ...latest, [key]: Array.from(next) })
  }

  return (
    <>
      {createProject ? (
        <>
          <label className="relative min-w-0 flex-1" title={selection.projectName || '项目名'}>
            <Type className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: selection.projectName.trim() ? '#60a5fa' : 'var(--text-muted)' }} />
            <input
              value={selection.projectName}
              onChange={event => onChange({ ...selection, projectName: event.target.value })}
              aria-label="项目名"
              required
              aria-required="true"
              placeholder="项目名（必填）"
              className="h-7 w-full min-w-[96px] rounded-lg border bg-transparent pl-7 pr-2 text-[length:var(--fs-sm)] outline-none transition-colors placeholder:!text-[var(--placeholder-color)] focus:border-blue-500/60"
              style={{ borderColor: selection.projectName.trim() ? 'rgba(59,130,246,0.72)' : 'var(--input-border)', color: dark ? '#f1f5f9' : '#1e293b' }}
            />
          </label>
          <button type="button" aria-label="选择中枢路径"
            title={selection.projectPath || '选择中枢路径（未设置时自动生成）'}
            onClick={() => setPathPickerOpen(true)}
            className="h-7 w-7 shrink-0 rounded-lg border flex items-center justify-center hover:bg-[var(--bg-card-hover)]"
            style={{ borderColor: selection.projectPath ? 'rgba(59,130,246,0.72)' : 'var(--input-border)', color: selection.projectPath ? '#60a5fa' : 'var(--text-secondary)' }}>
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
          {pathPickerOpen && createPortal(
            <Suspense fallback={null}>
              <PathPickerModal initialPath={selection.projectPath || undefined}
                onClose={() => setPathPickerOpen(false)}
                onPick={(abs, _rel, manual) => {
                  const { selection: latest, onChange: emit } = latestRef.current
                  emit({ ...latest, projectPath: abs, projectPathManual: !!manual })
                  setPathPickerOpen(false)
                }} />
            </Suspense>, document.body)}
        </>
      ) : (
        <>
          {/* 项目选择移进了输入框左下角 (issue 2026-10-28): 它跟「选择任务」是连在一起的
              两步, 放在输入框下方那一行反而把它们拆散了. 这里用项目选择器把「选项目」摆出来,
              项目决定任务列表, 任务决定模型与上下文. */}
          <EasySessionProjectSelector
            isDark={dark}
            selectedProjectId={projectId || undefined}
            selectedProjectName={projects.find((p: any) => String(p.id) === projectId)?.name}
            projects={projects.map((p: any) => ({ id: String(p.id), name: String(p.name || p.id), kind: p.kind, default_model: p.default_model }))}
            onSelectProject={pid => onChange({ ...selection, projectId: pid || '', issueId: '', issueTitle: '', excludedSkills: [], excludedMemories: [] })}
            onCreateProject={onCreateProject}
          />
          {/* 任务下拉 (issue 2026-10-28): 欢迎页要和执行页一样把「有哪些能力」摆出来 ——
              任务不选也能建 (自动定位最近任务), 但用户得看得见这一项存在, 看得见才能挑.
              没有项目时置灰, 顺带把「先选项目」讲明白. */}
          <DropdownSelect
            value={issueId}
            onChange={v => {
              const issue = projectIssues.find((i: any) => String(i.id) === v)
              onChange({ ...selection, issueId: v, issueTitle: String(issue?.title || '') })
            }}
            options={taskOptions}
            dark={dark}
            size="sm"
            icon={<ListChecks className="h-3.5 w-3.5" strokeWidth={1.8} />}
            disabled={taskOptions.length === 0}
            placeholder="选择任务"
            emptyText={projectId ? '该项目下暂无任务' : '先选项目, 这里会列出它的任务'}
          />
        </>
      )}
      {/* 模型选择已移至输入框右下的模型 pill (EasySessionModelPill), 语言默认 zh 不再展示 */}
      <SkillMemoryPicker
        singleTrigger
        dark={dark}
        skills={availSkills}
        memories={availMemories}
        excludedSkills={new Set(selection.excludedSkills)}
        excludedMemories={new Set(selection.excludedMemories)}
        onToggleSkill={id => toggleExcluded('skill', id)}
        onToggleMemory={id => toggleExcluded('memory', id)}
        onBulkToggle={bulkExcluded}
        emptySkillText={issueId ? '该任务未启用 Skill' : '暂无用户级或内置 Skill'}
      />
    </>
  )
}
