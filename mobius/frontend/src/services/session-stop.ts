type StopOptions = {
  sessionId: string
  request: (url: string, options?: RequestInit) => Promise<any>
  confirm: (message: string) => boolean
  onStopped: () => void
  onDisabledChanged: (disabled: boolean) => void
}

// Keep both confirmation steps ordered for every chat layout using the stop button.
export async function stopSessionWithFollowup({ sessionId, request, confirm, onStopped, onDisabledChanged }: StopOptions) {
  const result = await request(`/api/sessions/${sessionId}/stop`, { method: 'POST' })
  if (!result.ok) throw new Error('终止执行失败，请重试')
  onStopped()

  if (typeof result.research_agent_disabled === 'boolean') {
    onDisabledChanged(result.research_agent_disabled)
    if (!result.research_agent_disabled && confirm('是否同时禁用这个 Research Agent？禁用后不再接收黑板信号，可在会话中重新启用。定时任务将在下一步单独确认。')) {
      try {
        await request(`/api/sessions/${sessionId}`, {
          method: 'PATCH', body: JSON.stringify({ research_agent_disabled: true }),
        })
        onDisabledChanged(true)
      } catch (error: any) {
        throw new Error(`已终止执行，但禁用 Research Agent 失败；尚未检查定时任务：${error?.message || '请重试'}`)
      }
    }
  }

  const wakeupUrl = `/api/scheduled-wake-ups?session_id=${encodeURIComponent(sessionId)}`
  try {
    const data = await request(wakeupUrl)
    const count = Array.isArray(data?.wakeups) ? data.wakeups.length : 0
    if (count && confirm(`本会话还有 ${count} 个 Mobius 定时任务，是否一并取消？禁用期间不会唤醒，保留的任务会在解禁后继续执行。`)) {
      await request(wakeupUrl, { method: 'DELETE' })
    }
  } catch (error: any) {
    throw new Error(`已终止执行，但处理定时任务失败：${error?.message || '请重试'}`)
  }
}

export async function postMessageWithResearchGuard({ sessionId, isResearch, payload, request, confirm, onDisabledChanged }: {
  sessionId: string
  isResearch: boolean
  payload: Record<string, any>
  request: StopOptions['request']
  confirm: StopOptions['confirm']
  onDisabledChanged: StopOptions['onDisabledChanged']
}) {
  const enable = async () => {
    if (!confirm('当前研究智能体处于禁用状态，是否解禁？')) {
      throw new Error('已取消发送，研究智能体仍处于禁用状态')
    }
    await request(`/api/sessions/${sessionId}/research-agent/enable`, { method: 'POST' })
    onDisabledChanged(false)
  }
  if (isResearch) {
    const state = await request(`/api/sessions/${sessionId}/research-agent-state`)
    onDisabledChanged(!!state.research_agent_disabled)
    if (state.research_agent_disabled) await enable()
  }
  const send = () => request(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify(payload) })
  try {
    return await send()
  } catch (error: any) {
    // Also handle stale UI state or a disable between preflight and dispatch.
    if (error?.code !== 'research_agent_disabled') throw error
    onDisabledChanged(true)
    await enable()
    return send()
  }
}
