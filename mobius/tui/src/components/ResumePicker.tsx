/**
 * /resume picker — list the ~32 most recently active sessions in the current
 * project (aggregated across its issues, ordered by last_active DESC), pick one
 * to reconnect its SSE stream.
 */
import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { Select } from './primitives.js'
import { MobiusClient } from '../api.js'
import type { Project, Session } from '../types.js'

function relativeTime(iso?: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const diff = Date.now() - then
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return new Date(iso).toISOString().slice(0, 10)
}

export function ResumePicker({ client, project, onPick, onBack }: {
  client: MobiusClient
  project: Project
  onPick: (sessionId: string) => void
  onBack: () => void
}) {
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    client.listProjectSessions(project.id, 32)
      .then(setSessions)
      .catch(e => setErr(e?.message ?? String(e)))
  }, [client, project.id])

  if (err) return <Box paddingX={2}><Text color="red">加载会话失败: {err}</Text></Box>
  if (sessions === null) return <Box paddingX={2}><Text color="cyan">加载历史会话…</Text></Box>

  const items = sessions.map(s => ({
    label: `${s.name}${s.issue_title ? ` · ${s.issue_title}` : ''}`,
    value: s.session_id,
    desc: `${relativeTime(s.last_active)} · ${s.message_count ?? 0} 条消息 · 模型 ${s.model ?? '?'}`,
  }))

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">恢复历史会话（{project.name}）</Text>
      <Text color="gray">按活跃时间排序，最近 32 个</Text>
      <Box marginTop={1}>
        {items.length === 0
          ? <Text color="gray">（暂无历史会话）</Text>
          : <Select items={items} onSelect={onPick} onBack={onBack} />}
      </Box>
      {items.length > 0 ? <Text color="gray">↑↓ 选择 · 回车确认 · Esc 返回</Text> : null}
    </Box>
  )
}
