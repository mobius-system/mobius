/**
 * Prep flow: bind the current cwd to a project, then walk through the
 * preference wizard (Issue → model → language → skills → memories).
 *
 * Local-state sources (per the TUI spec):
 *   ~/.mobius/dir2project.json            — cwd → projectId
 *   ~/.mobius/projects.json               — cached project list
 *   ~/.mobius/dir2project_preference.json — cwd → active issue + per-issue prefs
 *
 * Preferences are stored INSIDE the selected Issue (switching issues restores
 * that issue's saved model/language/skill/memory choices).
 */
import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { Select, TextInput, type SelectItem } from './primitives.js'
import { MobiusClient } from '../api.js'
import {
  bindCwdToProject, cwd, getCwdPreference, loadDir2Project, loadProjectsCache,
  saveProjectsCache, setCwdIssue, updateIssuePreference, type IssuePreference,
} from '../config.js'
import type { Issue, Memory, Project, SessionModelOption, Skill } from '../types.js'

type PrefStep = 'issue' | 'model' | 'language' | 'skills' | 'memories'
const STEP_ORDER: PrefStep[] = ['model', 'language', 'skills', 'memories']

export interface ReadyState {
  project: Project
  issue: Issue
  prefs: IssuePreference
}

export function PrepScreen({ client, onReady, onQuit }: {
  client: MobiusClient
  onReady: (st: ReadyState) => void
  onQuit?: () => void
}) {
  const [phase, setPhase] = useState<'loading' | 'project' | 'pref' | 'done'>('loading')
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [issues, setIssues] = useState<Issue[]>([])
  const [issueId, setIssueId] = useState<string | undefined>()
  const [issue, setIssue] = useState<Issue | null>(null)
  const [prefs, setPrefs] = useState<IssuePreference>({ excluded_skill_ids: [], excluded_memory_ids: [] })
  const [step, setStep] = useState<PrefStep | null>(null)
  const [modelOpts, setModelOpts] = useState<SessionModelOption[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [memories, setMemories] = useState<Memory[]>([])
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string>('')
  const thisCwd = cwd()

  // ── bootstrap ────────────────────────────────────────────────────────────
  useEffect(() => { (async () => {
    setStatusMsg('加载项目列表…')
    let list = await loadProjectsCache()
    try { list = await client.listProjects(); await saveProjectsCache(list) } catch { /* use cache */ }
    setProjects(list)
    const d2p = await loadDir2Project()
    const boundId = d2p[thisCwd]
    if (boundId) {
      const p = list.find(x => x.id === boundId) ?? { id: boundId, name: boundId } as Project
      await enterProject(p, list)
    } else {
      setPhase('project')
    }
  })().catch(e => setStatusMsg(`初始化失败: ${e?.message ?? e}`)) }, [])

  async function enterProject(p: Project, list?: Project[]) {
    setProject(p)
    if (list) setProjects(list)
    setStatusMsg(`加载任务列表…`)
    let iss: Issue[] = []
    try { iss = await client.listIssues(p.id, 'active') } catch { /* empty */ }
    setIssues(iss)
    const cwdPref = await getCwdPreference(thisCwd)
    let curPrefs: IssuePreference = { excluded_skill_ids: [], excluded_memory_ids: [] }
    if (cwdPref.issueId && iss.some(i => i.id === cwdPref.issueId)) {
      const foundIssue = iss.find(i => i.id === cwdPref.issueId) as Issue
      curPrefs = cwdPref.prefs[cwdPref.issueId] ?? curPrefs
      setIssue(foundIssue)
      setIssueId(cwdPref.issueId)
      setPrefs(curPrefs)
      const next = computeStep(curPrefs)
      if (next === null) {
        // all preferences already configured for this issue → go straight to chat.
        // (Call onReady directly: finish() reads `project` from closure, which hasn't
        // committed yet at bootstrap, so we pass the project we have in hand.)
        setPhase('done')
        onReady({ project: p, issue: foundIssue, prefs: curPrefs })
        return
      }
      setPhase('pref')
      setStep(next)
    } else {
      setIssueId(undefined)
      setIssue(null)
      setPrefs(curPrefs)
      setPhase('pref')
      setStep('issue')
    }
    setStatusMsg('')
  }

  function computeStep(p: IssuePreference): PrefStep | null {
    const done = new Set(p.done ?? [])
    for (const s of STEP_ORDER) if (!done.has(s)) return s
    return null
  }

  // ── project picker / creation ────────────────────────────────────────────
  async function pickProject(p: Project) {
    await bindCwdToProject(thisCwd, p.id)
    await enterProject(p)
  }
  async function createProject(name: string, description: string) {
    setStatusMsg('创建项目…')
    try {
      const p = await client.createProject({ name: name || '未命名项目', description, bindPath: thisCwd, defaultUseWorktree: false })
      const list = await client.listProjects(); await saveProjectsCache(list); setProjects(list)
      await bindCwdToProject(thisCwd, p.id)
      await enterProject(p, list)
    } catch (e: any) { setStatusMsg(`创建项目失败: ${e?.message ?? e}`) }
  }

  // ── issue picker / creation ──────────────────────────────────────────────
  async function pickIssue(iss: Issue) {
    const p = await setCwdIssue(thisCwd, iss.id, iss.title)
    setIssue(iss); setIssueId(iss.id); setPrefs(p)
    const next = computeStep(p)
    setStep(next)
    if (!next) finish(iss, p)
  }
  async function createIssue(name: string, useWt: boolean) {
    if (!project) return
    setStatusMsg('创建任务…')
    try {
      const iss = await client.createIssue(project.id, { title: name || '命令行任务', description: '由 TUI 创建', use_worktree: useWt })
      setIssues(await client.listIssues(project.id, 'active'))
      await pickIssue(iss)
    } catch (e: any) { setStatusMsg(`创建任务失败: ${e?.message ?? e}`) }
  }

  // ── preference step completions ─────────────────────────────────────────
  async function completeStep(stepKey: PrefStep, patch: Partial<IssuePreference>) {
    if (!issueId) return
    const merged = await updateIssuePreference(thisCwd, issueId, { ...patch, done: Array.from(new Set([...(prefs.done ?? []), stepKey])) })
    setPrefs(merged)
    const next = computeStep(merged)
    setStep(next)
    if (!next && issue) {
      finish(issue, merged)
    }
  }

  function finish(iss: Issue, p: IssuePreference) {
    if (!project) return
    setPhase('done')
    onReady({ project, issue: iss, prefs: p })
  }

  // ── lazy-load lists for the active step ──────────────────────────────────
  useEffect(() => {
    if (phase !== 'pref' || !step) return
    if (step === 'model' && !modelOpts.length) {
      client.modelOptions().then(setModelOpts).catch(() => {})
      client.defaultModel().then(r => setDefaultModel(r.model)).catch(() => {})
    }
    if (step === 'skills' && !skills.length && project) {
      client.listSkills(project.id).then(setSkills).catch(() => {})
    }
    if (step === 'memories' && !memories.length && project) {
      client.listMemories(project.id).then(setMemories).catch(() => {})
    }
  }, [phase, step, project])

  // ── render ───────────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return <Box paddingX={2} paddingY={1}><Text color="cyan">{statusMsg || '加载中…'}</Text></Box>
  }
  if (phase === 'project') {
    return <ProjectPicker
      cwd={thisCwd} projects={projects} statusMsg={statusMsg}
      onPick={pickProject} onCreate={createProject} onQuit={onQuit} />
  }
  if (phase === 'done') {
    return <Box paddingX={2}><Text color="green">准备就绪，进入对话…</Text></Box>
  }
  // phase === 'pref'
  return <Box flexDirection="column" paddingX={2} paddingY={1}>
    <Text color="gray">项目: <Text bold>{project?.name}</Text>  ·  当前路径: {thisCwd}</Text>
    {statusMsg ? <Text color="yellow">{statusMsg}</Text> : null}
    {step === 'issue'
      ? <IssuePicker issues={issues} onPick={pickIssue} onCreate={createIssue} />
      : null}
    {step === 'model'
      ? <ModelPicker options={modelOpts} defaultKey={defaultModel ?? prefs.model}
          onSelect={key => completeStep('model', { model: key })} />
      : null}
    {step === 'language'
      ? <Select
          title="选择回复语言"
          items={[{ label: '中文', value: 'zh' }, { label: 'English', value: 'en' }]}
          onSelect={v => completeStep('language', { language: v as 'zh' | 'en' })} />
      : null}
    {step === 'skills'
      ? <MultiPicker title={`选择启用的 Skill（默认全部启用，空格取消）`} items={toItems(skills)}
          excluded={prefs.excluded_skill_ids}
          onConfirm={excluded => completeStep('skills', { excluded_skill_ids: excluded })} />
      : null}
    {step === 'memories'
      ? <MultiPicker title={`选择启用的 Memory（默认全部启用，空格取消）`} items={toItems(memories)}
          excluded={prefs.excluded_memory_ids}
          onConfirm={excluded => completeStep('memories', { excluded_memory_ids: excluded })} />
      : null}
  </Box>
}

function toItems(arr: { id: string; name: string; description?: string }[]): SelectItem[] {
  return arr.map(s => ({ label: s.name, value: s.id, desc: s.description }))
}

// 把可能含换行的描述压成单行：换行 → 可见符号 ⏎，避免列表项跨行。
function flattenDesc(s?: string): string {
  if (!s) return ''
  return s.replace(/\s*\n\s*/g, ' ⏎ ').replace(/[ \t]+/g, ' ').trim()
}

// ── Project picker ───────────────────────────────────────────────────────────
function ProjectPicker({ cwd, projects, statusMsg, onPick, onCreate, onQuit }: {
  cwd: string
  projects: Project[]
  statusMsg: string
  onPick: (p: Project) => void
  onCreate: (name: string, description: string) => void
  onQuit?: () => void
}) {
  const [mode, setMode] = useState<'list' | 'create'>('list')
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [field, setField] = useState<'name' | 'desc'>('name')

  if (mode === 'create') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">创建新项目（绑定到当前路径）</Text>
        <Text color="gray">{cwd}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={field === 'name' ? 'cyan' : 'gray'}>项目名称{field === 'name' ? ' ←' : ''}</Text>
          <TextInput value={name} onChange={setName} focused={field === 'name'} placeholder="未命名项目"
            onSubmit={() => setField('desc')} onEscape={() => setMode('list')} />
          <Box marginTop={1}><Text color={field === 'desc' ? 'cyan' : 'gray'}>描述（可空）{field === 'desc' ? ' ←' : ''}</Text></Box>
          <TextInput value={desc} onChange={setDesc} focused={field === 'desc'} placeholder=""
            onSubmit={() => onCreate(name, desc)} onTab={() => setField(field === 'name' ? 'desc' : 'name')} onEscape={() => setMode('list')} />
        </Box>
        {statusMsg ? <Text color="yellow">{statusMsg}</Text> : null}
        <Text color="gray">回车提交 · Esc 返回</Text>
      </Box>
    )
  }

  const items: SelectItem[] = [
    { label: '➕ 创建新项目', value: '__create__', desc: '绑定到当前路径' },
    ...projects.map(p => {
      const desc = flattenDesc(p.description)
      return { label: desc ? `${p.name} — ${desc}` : p.name, value: p.id }
    }),
  ]
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">选择当前路径的绑定项目</Text>
      <Text color="gray">{cwd}</Text>
      <Box marginTop={1}>
        <Select items={items} onBack={onQuit} onSelect={v => v === '__create__' ? setMode('create') : onPick(projects.find(p => p.id === v)!)} />
      </Box>
      {statusMsg ? <Text color="yellow">{statusMsg}</Text> : null}
      <Text color="gray">↑↓ 选择 · 回车确认 · Esc 退出</Text>
    </Box>
  )
}

// ── Issue picker ─────────────────────────────────────────────────────────────
function IssuePicker({ issues, onPick, onCreate }: {
  issues: Issue[]
  onPick: (i: Issue) => void
  onCreate: (name: string, useWt: boolean) => void
}) {
  const [mode, setMode] = useState<'list' | 'create-name' | 'create-wt'>('list')
  const [name, setName] = useState('')

  if (mode === 'create-name') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold color="cyan">创建新任务 · 第 1 步：名称</Text>
        <TextInput value={name} onChange={setName} focused placeholder="命令行任务"
          onSubmit={() => setMode('create-wt')} />
        <Text color="gray">回车继续 · Esc 返回</Text>
      </Box>
    )
  }
  if (mode === 'create-wt') {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold color="cyan">创建新任务 · 第 2 步：是否使用 git worktree？</Text>
        <Select
          items={[{ label: '否（默认）', value: 'no' }, { label: '是', value: 'yes' }]}
          onSelect={v => onCreate(name, v === 'yes')} />
        <Text color="gray">回车确认 · Esc 返回</Text>
      </Box>
    )
  }
  const items: SelectItem[] = [
    { label: '➕ 创建新任务', value: '__create__' },
    ...issues.map(i => ({ label: i.title, value: i.id, desc: i.description })),
  ]
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">选择任务（Issue）</Text>
      <Text color="gray">偏好设置将保存在所选任务内部</Text>
      <Box marginTop={1}>
        {issues.length === 0 && mode === 'list'
          ? <Select items={[{ label: '➕ 创建新任务（尚无任务）', value: '__create__' }]} onSelect={() => setMode('create-name')} />
          : <Select items={items} onSelect={v => v === '__create__' ? setMode('create-name') : onPick(issues.find(i => i.id === v)!)} />}
      </Box>
    </Box>
  )
}

// ── Model picker ─────────────────────────────────────────────────────────────
function ModelPicker({ options, defaultKey, onSelect }: {
  options: SessionModelOption[]
  defaultKey?: string | null
  onSelect: (key: string) => void
}) {
  if (!options.length) return <Text color="gray">加载模型列表…</Text>
  const items: SelectItem[] = options.map(o => ({
    label: `${o.label}${o.key === defaultKey ? ' （默认）' : ''}`,
    value: o.key,
    desc: o.sub,
  }))
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">选择模型</Text>
      <Select items={items} onSelect={onSelect} />
    </Box>
  )
}

// ── Multi picker (skills / memories, exclusion model) ────────────────────────
function MultiPicker({ title, items, excluded, onConfirm }: {
  title: string
  items: SelectItem[]
  excluded: string[]
  onConfirm: (excluded: string[]) => void
}) {
  const [excl, setExcl] = useState<Set<string>>(new Set(excluded))
  // Hooks must be called unconditionally — auto-confirm empty lists here.
  useEffect(() => { if (items.length === 0) onConfirm([]) }, [items.length])
  if (!items.length) return <Text color="gray">（无可用项，自动跳过…）</Text>
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">{title}</Text>
      <Select
        mode="multi"
        items={items}
        selected={items.filter(i => !excl.has(i.value)).map(i => i.value)}
        onToggle={(v) => setExcl(prev => { const n = new Set(prev); n.has(v) ? n.delete(v) : n.add(v); return n })}
        onConfirm={() => onConfirm(Array.from(excl))}
      />
      <Text color="gray">↑↓ 移动 · 空格 切换 · 回车 确认</Text>
    </Box>
  )
}
