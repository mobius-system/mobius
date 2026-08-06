/**
 * /model (= /config) flow — pick a model, then create a brand-new session in the
 * CURRENT task (Issue) with that model. Launched from inside the chat; Esc at any
 * point before the session is created cancels back to the conversation untouched.
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
 */
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { Select, Spinner } from './primitives.js'
import { MobiusClient } from '../api.js'
import { cwd, updateIssuePreference, type IssuePreference } from '../config.js'
import { tuiAimuxIdentifier } from '../aimux.js'
import type { Issue, SessionModelOption } from '../types.js'

export interface ConfigResult {
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
