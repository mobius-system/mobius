/**
 * /resume picker — list the ~32 most recently active sessions in the current
 * project (aggregated across its issues), sorted local-first then by last_active
 * DESC. Sessions created on the current machine are visually marked.
 */
import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { Select } from './primitives.js'
import { MobiusClient } from '../api.js'
import { tuiAimuxIdentifier } from '../aimux.js'
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

/** Extract aimux_id from pc_client_metadata (object or JSON string). */
function sessionAimuxId(meta: unknown): string | null {
  if (!meta) return null
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta) } catch { return null }
  }
  if (typeof meta === 'object' && meta !== null && typeof (meta as any).aimux_id === 'string') {
    return (meta as any).aimux_id.trim() || null
  }
  return null
}

/** Optional: extract hostname hint from aimux_id (tui-<hostname> or desktop-<hostname>). */
function hostHint(aimuxId: string): string {
  const m = aimuxId.match(/^(?:tui|desktop)-(.+)/)
  return m ? m[1] : aimuxId
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
    client.listProjectSessions(project.id, 64)
      .then(setSessions)
      .catch(e => setErr(e?.message ?? String(e)))
  }, [client, project.id])

  if (err) return <Box paddingX={2}><Text color="red">加载会话失败: {err}</Text></Box>
  if (sessions === null) return <Box paddingX={2}><Text color="cyan">加载历史会话…</Text></Box>

  const myId = tuiAimuxIdentifier()

  // Sort: local sessions first, then remote; each group by last_active DESC.
  const sorted = [...sessions].sort((a, b) => {
    const aLocal = sessionAimuxId(a.pc_client_metadata) === myId ? 0 : 1
    const bLocal = sessionAimuxId(b.pc_client_metadata) === myId ? 0 : 1
    if (aLocal !== bLocal) return aLocal - bLocal
    return (b.last_active || '').localeCompare(a.last_active || '')
  })

  const localCount = sorted.filter(s => sessionAimuxId(s.pc_client_metadata) === myId).length

  const items = sorted.map(s => {
    const aid = sessionAimuxId(s.pc_client_metadata)
    const isLocal = aid === myId
    const host = aid ? hostHint(aid) : null
    const marker = isLocal ? '💻 ' : host ? `🌐 ${host} ` : '🌐 ? '
    const label = `${marker}${s.name}${s.issue_title ? ` · ${s.issue_title}` : ''}`
    const time = relativeTime(s.last_active)
    const desc = `${time} · ${s.message_count ?? 0} 条消息 · ${s.model ?? '?'}`
    return { label, value: s.session_id, desc }
  })

  const hint = localCount > 0
    ? `本机 ${localCount} 个 · 远程 ${sorted.length - localCount} 个，共 ${sorted.length} 个`
    : `全部 ${sorted.length} 个（无本机会话）`

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">恢复历史会话（{project.name}）</Text>
      <Text color="gray">{hint}</Text>
      <Box marginTop={1}>
        {items.length === 0
          ? <Text color="gray">（暂无历史会话）</Text>
          : <Select items={items} onSelect={onPick} onBack={onBack} />}
      </Box>
      {items.length > 0 ? <Text color="gray">↑↓ 选择 · 回车确认 · Esc 返回</Text> : null}
    </Box>
  )
}
