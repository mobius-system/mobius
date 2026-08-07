/**
 * /model flow — pick a model, then create a brand-new session in the CURRENT
 * task (Issue) with that model. Launched from inside the chat; Esc at any point
 * before the session is created cancels back to the conversation untouched.
 *
 * The active Issue is intentionally NOT changed: /model only swaps the model and
 * starts a fresh session, keeping the current project/task context. Esc-cancel is
 * owned by ChatScreen (its useInput handles Esc while configOpen), so this
 * component only ever reports a completed pick via onDone.
 *
 * Preferences are stored inside the current Issue (same model as PrepScreen):
 *   updateIssuePreference — persist the chosen model on the active issue
 * The session body mirrors useChat.ensureSession() so the pc_client_metadata
 * (is_tui, aimux_id, local_path) matches lazily-created sessions exactly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * /config flow (ReconfigFlow) — full reconfiguration: (1) project → (2) issue →
 * (3) model, then create a brand-new session. Unlike /model, this CAN change the
 * active project and issue. Project/issue choices are persisted (bindCwdToProject,
 * setCwdIssue, updateIssuePreference) so they become the new defaults.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { Select, TextInput, Spinner, type SelectItem } from './primitives.js'
import { MobiusClient } from '../api.js'
import {
  bindCwdToProject, cwd, getCwdPreference, loadDir2Project, loadProjectsCache,
  saveProjectsCache, setCwdIssue, updateIssuePreference, type IssuePreference,
} from '../config.js'
import { tuiAimuxIdentifier } from '../aimux.js'
import type { Issue, Project, SessionModelOption } from '../types.js'

export interface ConfigResult {
  /** If set, the project was also changed (from /config full reflow). */
  project?: Project
  issue: Issue
  prefs: IssuePreference
  sessionId: string
}

export function ConfigFlow({ client, issue, onDone }: {
  client: MobiusClient
  issue: Issue
  onDone: (r: ConfigResult) => void
}) {
  const [step, setStep] = useState<'models' | 'creating'>('models')
  const [models, setModels] = useState<SessionModelOption[] | null>(null)
  const [defaultKey, setDefaultKey] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const doneRef = useRef(false)

  // Guard against a setState after App has already remounted Chat (onDone fires
  // a synchronous route change that unmounts us); also avoids double onDone.
  useEffect(() => () => { doneRef.current = true }, [])

  // Load the model list + default on mount (no issue step — the current Issue is used).
  useEffect(() => {
    Promise.all([
      client.modelOptions().catch(() => [] as SessionModelOption[]),
      client.defaultModel().then(r => r.model).catch(() => null),
    ]).then(([opts, def]) => {
      if (doneRef.current) return
      setModels(opts)
      setDefaultKey(def)
    })
  }, [client])

  async function pickModel(model: string) {
    setStep('creating')
    try {
      const prefs = await updateIssuePreference(cwd(), issue.id, { model })
      if (doneRef.current) return
      const s = await client.createSession(issue.id, {
        name: `TUI ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`,
        model,
        language: prefs.language,
        excluded_skill_ids: prefs.excluded_skill_ids,
        excluded_memory_ids: prefs.excluded_memory_ids,
        pc_client_metadata: {
          work_mode: 'pc',
          aimux_id: tuiAimuxIdentifier(),
          local_path: process.cwd(),
          is_tui: true,
          add_remote_aimux_mcp: true,
        },
      })
      if (doneRef.current) return
      onDone({ issue, prefs, sessionId: s.session_id })
    } catch (e: any) {
      if (doneRef.current) return
      setStatus(`创建新会话失败: ${e?.message ?? e}`)
      setStep('models')
    }
  }

  if (step === 'creating') {
    return (
      <Box paddingX={2} paddingY={1}>
        <Spinner label="正在创建新会话…" />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">更换模型</Text>
      <Text color="gray">当前任务: {issue.title}</Text>
      {status ? <Text color="yellow">{status}</Text> : null}

      <Box flexDirection="column">
        <Text bold color="cyan">选择模型</Text>
        <Text color="gray">确认后创建新会话（保留当前任务）</Text>
        <Box marginTop={1}>
          {models === null
            ? <Text color="cyan">加载模型列表…</Text>
            : models.length === 0
              ? <Text color="gray">（无可用模型）</Text>
              : <Select
                  items={models.map(o => ({
                    label: `${o.label}${o.key === defaultKey ? ' （默认）' : ''}`,
                    value: o.key,
                    desc: o.sub,
                  }))}
                  onSelect={key => void pickModel(key)}
                />}
        </Box>
        <Text color="gray">↑↓ 选择 · 回车确认 · Esc 取消</Text>
      </Box>
    </Box>
  )
}

// ── /config: full reconfigure (project → issue → model) ─────────────────────

type ReconfigStep = 'projects' | 'issues' | 'models' | 'creating'

export function ReconfigFlow({ client, onDone }: {
  client: MobiusClient
  onDone: (r: ConfigResult) => void
}) {
  const [step, setStep] = useState<ReconfigStep>('projects')
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [issues, setIssues] = useState<Issue[] | null>(null)
  const [issue, setIssue] = useState<Issue | null>(null)
  const [models, setModels] = useState<SessionModelOption[] | null>(null)
  const [defaultKey, setDefaultKey] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [createName, setCreateName] = useState('')
  const [createMode, setCreateMode] = useState<'project' | 'issue' | null>(null)
  const doneRef = useRef(false)
  const thisCwd = cwd()

  useEffect(() => () => { doneRef.current = true }, [])

  // Load projects on mount.
  useEffect(() => {
    ;(async () => {
      let list = await loadProjectsCache()
      try { list = await client.listProjects(); await saveProjectsCache(list) } catch { /* use cache */ }
      if (doneRef.current) return
      setProjects(list)
    })().catch(e => { if (!doneRef.current) setStatus(`加载项目失败: ${e?.message ?? e}`) })
  }, [client])

  // Load issues when a project is picked.
  useEffect(() => {
    if (!project || step !== 'issues') return
    ;(async () => {
      try {
        const iss = await client.listIssues(project.id, 'active')
        if (doneRef.current) return
        setIssues(iss)
      } catch (e: any) {
        if (!doneRef.current) setStatus(`加载任务失败: ${e?.message ?? e}`)
      }
    })()
  }, [project, step, client])

  // Load models when we reach the model step.
  useEffect(() => {
    if (step !== 'models') return
    Promise.all([
      client.modelOptions().catch(() => [] as SessionModelOption[]),
      client.defaultModel().then(r => r.model).catch(() => null),
    ]).then(([opts, def]) => {
      if (doneRef.current) return
      setModels(opts)
      setDefaultKey(def)
    })
  }, [step, client])

  // ── project ───────────────────────────────────────────────────────────────
  async function pickProject(p: Project) {
    await bindCwdToProject(thisCwd, p.id)
    if (doneRef.current) return
    setProject(p)
    setIssues(null)
    setStep('issues')
  }

  async function createProject(name: string) {
    setCreateMode(null)
    setStatus('创建项目…')
    try {
      const safeDir = '/' + (name || '未命名项目').replace(/[^a-zA-Z0-9一-鿿_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'project'
      const p = await client.createProject({ name: name || '未命名项目', description: '', bindPath: safeDir, defaultUseWorktree: false })
      const list = await client.listProjects(); await saveProjectsCache(list)
      if (doneRef.current) return
      setProjects(list)
      await bindCwdToProject(thisCwd, p.id)
      setProject(p)
      setIssues(null)
      setStep('issues')
      setStatus('')
    } catch (e: any) { if (!doneRef.current) setStatus(`创建项目失败: ${e?.message ?? e}`) }
  }

  // ── issue ─────────────────────────────────────────────────────────────────
  async function pickIssue(iss: Issue) {
    await setCwdIssue(thisCwd, iss.id, iss.title)
    if (doneRef.current) return
    setIssue(iss)
    setStep('models')
  }

  async function createIssue(name: string) {
    if (!project) return
    setCreateMode(null)
    setStatus('创建任务…')
    try {
      const iss = await client.createIssue(project.id, { title: name || '命令行任务', description: '由 TUI 创建', use_worktree: false })
      const refreshed = await client.listIssues(project.id, 'active')
      if (doneRef.current) return
      setIssues(refreshed)
      await pickIssue(iss)
      setStatus('')
    } catch (e: any) { if (!doneRef.current) setStatus(`创建任务失败: ${e?.message ?? e}`) }
  }

  // ── model → session ───────────────────────────────────────────────────────
  async function pickModel(model: string) {
    if (!project || !issue) return
    setStep('creating')
    try {
      const prefs = await updateIssuePreference(thisCwd, issue.id, { model })
      if (doneRef.current) return
      const s = await client.createSession(issue.id, {
        name: `TUI ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`,
        model,
        language: prefs.language,
        excluded_skill_ids: prefs.excluded_skill_ids,
        excluded_memory_ids: prefs.excluded_memory_ids,
        pc_client_metadata: {
          work_mode: 'pc',
          aimux_id: tuiAimuxIdentifier(),
          local_path: process.cwd(),
          is_tui: true,
          add_remote_aimux_mcp: true,
        },
      })
      if (doneRef.current) return
      onDone({ project, issue, prefs, sessionId: s.session_id })
    } catch (e: any) {
      if (doneRef.current) return
      setStatus(`创建新会话失败: ${e?.message ?? e}`)
      setStep('models')
    }
  }

  // ── render ────────────────────────────────────────────────────────────────
  if (step === 'creating') {
    return (
      <Box paddingX={2} paddingY={1}>
        <Spinner label="正在创建新会话…" />
      </Box>
    )
  }

  if (createMode === 'project') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">创建新项目</Text>
        <Text color="gray">{thisCwd}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan">项目名称 ←</Text>
          <TextInput value={createName} onChange={setCreateName} focused placeholder="未命名项目"
            onSubmit={() => createProject(createName)} onEscape={() => { setCreateMode(null); setCreateName('') }} />
        </Box>
        {status ? <Text color="yellow">{status}</Text> : null}
        <Text color="gray">回车创建 · Esc 返回</Text>
      </Box>
    )
  }

  if (createMode === 'issue') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">创建新任务</Text>
        <Text color="gray">项目: {project?.name}</Text>
        <TextInput value={createName} onChange={setCreateName} focused placeholder="命令行任务"
          onSubmit={() => createIssue(createName)} onEscape={() => { setCreateMode(null); setCreateName('') }} />
        {status ? <Text color="yellow">{status}</Text> : null}
        <Text color="gray">回车创建 · Esc 返回</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">重新配置</Text>
      {status ? <Text color="yellow">{status}</Text> : null}

      {step === 'projects' ? (
        <Box flexDirection="column">
          <Text bold color="cyan">选择项目</Text>
          <Box marginTop={1}>
            {projects === null
              ? <Text color="cyan">加载项目列表…</Text>
              : <Select
                  items={[
                    { label: '➕ 创建新项目', value: '__create__' },
                    ...projects.map(p => ({ label: p.name, value: p.id, desc: p.description })),
                  ]}
                  initialActive={projects.length > 0 ? 1 : 0}
                  onSelect={v => v === '__create__' ? setCreateMode('project') : pickProject(projects!.find(p => p.id === v)!)}
                />}
          </Box>
          <Text color="gray">↑↓ 选择 · 回车确认 · Esc 取消</Text>
        </Box>
      ) : null}

      {step === 'issues' ? (
        <Box flexDirection="column">
          <Text bold color="cyan">选择任务</Text>
          <Text color="gray">项目: {project?.name}</Text>
          <Box marginTop={1}>
            {issues === null
              ? <Text color="cyan">加载任务列表…</Text>
              : issues.length === 0
                ? <Select
                    items={[{ label: '➕ 创建新任务（尚无任务）', value: '__create__' }]}
                    onSelect={() => setCreateMode('issue')} />
                : <Select
                    items={[
                      { label: '➕ 创建新任务', value: '__create__' },
                      ...issues.map(i => ({ label: i.title, value: i.id, desc: i.description })),
                    ]}
                    initialActive={1}
                    onSelect={v => v === '__create__' ? setCreateMode('issue') : pickIssue(issues!.find(i => i.id === v)!)} />}
          </Box>
          <Text color="gray">↑↓ 选择 · 回车确认 · Esc 取消</Text>
        </Box>
      ) : null}

      {step === 'models' ? (
        <Box flexDirection="column">
          <Text bold color="cyan">选择模型</Text>
          <Text color="gray">项目: {project?.name} · 任务: {issue?.title}</Text>
          <Box marginTop={1}>
            {models === null
              ? <Text color="cyan">加载模型列表…</Text>
              : models.length === 0
                ? <Text color="gray">（无可用模型）</Text>
                : <Select
                    items={models.map(o => ({
                      label: `${o.label}${o.key === defaultKey ? ' （默认）' : ''}`,
                      value: o.key,
                      desc: o.sub,
                    }))}
                    onSelect={key => void pickModel(key)}
                  />}
          </Box>
          <Text color="gray">↑↓ 选择 · 回车确认 · Esc 取消</Text>
        </Box>
      ) : null}
    </Box>
  )
}
