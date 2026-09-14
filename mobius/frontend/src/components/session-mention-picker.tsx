import { useEffect, useRef, useState } from 'react'
import { Bot, X } from 'lucide-react'
import { RemoteFileMentionDrawer, type AgentMentionMode, type MentionAgentSession } from './mention-drawer'

export type SessionMentionMode = 'read_only' | 'bidirectional'

export type SessionMentionSelection = {
  sessionId: string
  name: string
  mode: SessionMentionMode
  projectName?: string
  scopeType?: 'issue' | 'research' | null
  scopeTitle?: string
  contextAt?: string | null
}

// 与 ChatArea 的 @ 触发同一语义: 光标前刚键入 @ (不限前面是空白还是中文/字母)即弹抽屉,
// 继续输入任何字符即收起, 再键入下一个 @ 才重新打开。
function trailingMention(value: string): { start: number } | null {
  if (!String(value || '').endsWith('@')) return null
  return { start: String(value).length - 1 }
}

export function sessionMentionPayload(items: SessionMentionSelection[]) {
  return items.map((item) => ({
    kind: 'agent',
    session_id: item.sessionId,
    mode: item.mode,
  }))
}

// 新建会话/研究智能体表单里的 @ 引用选择器。
// 旧版是 fixed 浮动候选面板(残留菜单), 现与 ChatArea 共用同一个左侧抽屉
// (RemoteFileMentionDrawer): 描述框输入 @ 弹出抽屉, 选中智能体后回填标签文本。
// 这里只保留「已选 chips 行 + @ 触发检测 + 抽屉挂载」。
export function SessionMentionPicker({
  value,
  onValueChange,
  selected,
  onSelectedChange,
  currentSessionId,
  projectId,
  issueId,
  researchId,
  disabled = false,
}: {
  value: string
  onValueChange: (value: string) => void
  selected: SessionMentionSelection[]
  onSelectedChange: (items: SessionMentionSelection[]) => void
  currentSessionId?: string
  projectId?: string
  issueId?: string
  researchId?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const typedMentionRef = useRef<{ start: number } | null>(null)
  const suppressValueRef = useRef('')
  const hasScope = !!(currentSessionId || issueId || researchId)

  useEffect(() => {
    if (disabled || !hasScope) {
      setOpen(false)
      return
    }
    if (suppressValueRef.current === value) {
      suppressValueRef.current = ''
      return
    }
    const mention = trailingMention(value)
    if (!mention) {
      // 输入偏离 @ 触发态 (继续打了字 / 删掉 @): 收起抽屉, 与 ChatArea 行为一致。
      typedMentionRef.current = null
      setOpen(false)
      return
    }
    typedMentionRef.current = mention
    setOpen(true)
  }, [disabled, hasScope, value])

  const pickAgent = (agent: MentionAgentSession, mode: AgentMentionMode) => {
    const effectiveMode: SessionMentionMode = mode === 'bidirectional' && agent.can_communicate === false
      ? 'read_only'
      : mode
    const nextSelection: SessionMentionSelection = {
      sessionId: agent.session_id,
      name: agent.name || agent.session_id,
      mode: effectiveMode,
      projectName: agent.project_name,
      scopeType: agent.scope_type || null,
      scopeTitle: agent.scope_type === 'research' ? agent.research_title : agent.issue_title,
      contextAt: agent.last_active || null,
    }
    const existingIndex = selected.findIndex((item) => item.sessionId === agent.session_id)
    onSelectedChange(existingIndex < 0
      ? [...selected, nextSelection]
      : selected.map((item, index) => index === existingIndex ? nextSelection : item))

    const label = `@${agent.name || agent.session_id}`
    const typed = typedMentionRef.current
    const nextValue = typed
      ? `${value.slice(0, typed.start)}${label} `
      : `${value}${value && !/\s$/.test(value) ? ' ' : ''}${label} `
    suppressValueRef.current = nextValue
    typedMentionRef.current = null
    onValueChange(nextValue)
    setOpen(false)
  }

  const remove = (sessionId: string) => {
    onSelectedChange(selected.filter((item) => item.sessionId !== sessionId))
  }

  return (
    <div data-testid="session-mention-picker">
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {selected.map((item) => (
            <div
              key={item.sessionId}
              className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]"
              style={{ borderColor: 'rgba(59,130,246,0.26)', background: 'rgba(59,130,246,0.08)', color: 'var(--text-primary)' }}
            >
              <Bot className="h-3 w-3 flex-shrink-0 text-blue-400" strokeWidth={1.8} />
              <span className="max-w-44 truncate">@{item.name}</span>
              <span className="rounded border px-1 py-0.5 text-[9px]" style={{ borderColor: 'rgba(59,130,246,0.22)', color: 'var(--text-muted)' }}>
                {item.mode === 'bidirectional' ? '双向' : '只读'}
              </span>
              <button type="button" onClick={() => remove(item.sessionId)} aria-label={`移除 Session ${item.name}`}
                className="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {(projectId || hasScope) && (
        <RemoteFileMentionDrawer
          projectId={projectId || ''}
          issueId={issueId}
          researchId={researchId}
          currentSessionId={currentSessionId}
          open={open}
          onClose={() => { typedMentionRef.current = null; setOpen(false) }}
          initialTab="agents"
          onPickAgent={pickAgent}
        />
      )}
    </div>
  )
}
