/**
 * /model (= /config) flow — swap the active task (Issue) and model, then create
 * a brand-new session in that task. Launched from inside the chat; Esc anywhere
 * before the session is created cancels back to the conversation untouched.
 *
 * Steps: ① pick an Issue in the current project  → ② pick a model  → ③ create a
 * new session eagerly and hand it to App, which remounts Chat on it (so the
 * status bar shows the fresh session id immediately).
 *
 * Preferences are stored inside the chosen Issue (same model as PrepScreen):
 *   setCwdIssue(...)      — persist the new active issue for this cwd
 *   updateIssuePreference — persist the chosen model on that issue
 * The session body mirrors useChat.ensureSession() so the pc_client_metadata
 * (is_tui, aimux_id, local_path) matches lazily-created sessions exactly.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { Select, Spinner, isEscapeKeypress } from './primitives.js'
import { MobiusClient } from '../api.js'
import { cwd, setCwdIssue, updateIssuePreference, type IssuePreference } from '../config.js'
import { tuiAimuxIdentifier } from '../aimux.js'
import type { Issue, Project, SessionModelOption } from '../types.js'

export interface ConfigResult {
  issue: Issue
  prefs: IssuePreference
  sessionId: string
}

export function ConfigFlow({ client, project, onDone, onCancel }: {
  client: MobiusClient
  project: Project
  onDone: (r: ConfigResult) => void
  onCancel: () => void
}) {
  const [step, setStep] = useState<'issues' | 'models' | 'creating'>('issues')
  const [issues, setIssues] = useState<Issue[] | null>(null)
  const [models, setModels] = useState<SessionModelOption[] | null>(null)
  const [defaultKey, setDefaultKey] = useState<string | null>(null)
  const [picked, setPicked] = useState<{ issue: Issue; prefs: IssuePreference } | null>(null)
  const [status, setStatus] = useState('')
  const doneRef = useRef(false)

  // Guard against a setState after App has already remounted Chat (onDone fires
  // a synchronous route change that unmounts us); also avoids double onDone.
  useEffect(() => () => { doneRef.current = true }, [])

  // Step ① load the project's active issues on mount.
  useEffect(() => {
    client.listIssues(project.id, 'active')
      .then(setIssues)
      .catch((e: any) => setStatus(`加载任务失败: ${e?.message ?? e}`))
  }, [client, project.id])

  async function pickIssue(issue: Issue) {
    const prefs = await setCwdIssue(cwd(), issue.id, issue.title)
    setPicked({ issue, prefs })
    setStatus('')
    setStep('models')
    const [opts, def] = await Promise.all([
      client.modelOptions().catch(() => [] as SessionModelOption[]),
      client.defaultModel().then(r => r.model).catch(() => null),
    ])
    if (doneRef.current) return
    setModels(opts)
    setDefaultKey(def)
  }

  async function pickModel(model: string) {
    if (!picked) return
    setStep('creating')
    try {
      const prefs = await updateIssuePreference(cwd(), picked.issue.id, { model })
      if (doneRef.current) return
      const s = await client.createSession(picked.issue.id, {
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
      onDone({ issue: picked.issue, prefs, sessionId: s.session_id })
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
      <Text bold color="cyan">更换任务与模型</Text>
      <Text color="gray">项目: {project.name}</Text>
      {status ? <Text color="yellow">{status}</Text> : null}

      {step === 'issues'
        ? <Box flexDirection="column">
            <Text bold color="cyan">选择任务（Issue）</Text>
            <Text color="gray">偏好设置将保存在所选任务内部</Text>
            <Box marginTop={1}>
              {issues === null
                ? <><Text color="cyan">加载任务列表…</Text><EscToCancel onCancel={onCancel} /></>
                : issues.length === 0
                  ? <Text color="gray">（该项目暂无任务）</Text>
                  : <Select
                      items={issues.map(i => ({ label: i.title, value: i.id, desc: i.description }))}
                      onSelect={id => { const it = issues.find(i => i.id === id); if (it) void pickIssue(it) }}
                      onBack={onCancel}
                    />}
            </Box>
            <Text color="gray">↑↓ 选择 · 回车确认 · Esc 取消</Text>
          </Box>
        : null}

      {step === 'models'
        ? <Box flexDirection="column">
            <Text bold color="cyan">选择模型</Text>
            <Text color="gray">已选任务: {picked?.issue.title} · 确认后创建新会话</Text>
            <Box marginTop={1}>
              {models === null
                ? <><Text color="cyan">加载模型列表…</Text><EscToCancel onBack={() => { setStep('issues'); setModels(null) }} /></>
                : models.length === 0
                  ? <Text color="gray">（无可用模型）</Text>
                  : <Select
                      items={models.map(o => ({
                        label: `${o.label}${o.key === defaultKey ? ' （默认）' : ''}`,
                        value: o.key,
                        desc: o.sub,
                      }))}
                      onSelect={key => void pickModel(key)}
                      onBack={() => { setStep('issues'); setModels(null) }}
                    />}
            </Box>
            <Text color="gray">↑↓ 选择 · 回车确认 · Esc 返回上一步</Text>
          </Box>
        : null}
    </Box>
  )
}

// Esc must also work while a list is still loading (no Select mounted yet, so
// there is nothing to forward Esc to). Render this only alongside the loading
// text; once the Select appears it owns Esc itself.
function EscToCancel({ onCancel, onBack }: { onCancel?: () => void; onBack?: () => void }) {
  useInput((input, key) => {
    if (isEscapeKeypress(input, key)) (onBack ?? onCancel)?.()
  })
  return null
}
