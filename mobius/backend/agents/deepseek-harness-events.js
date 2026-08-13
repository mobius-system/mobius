const crypto = require('crypto')

function timestampOf(event) {
  const raw = event?.time ?? event?.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return new Date(raw < 1e12 ? raw * 1000 : raw).toISOString()
  }
  if (typeof raw === 'string' && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString()
  return new Date().toISOString()
}

function contentBlocks(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.content)) return value.content
  if (Array.isArray(value?.message?.content)) return value.message.content
  return []
}

function textFromBlocks(blocks) {
  return blocks
    .filter((block) => block?.type === 'text' || block?.type === 'reasoning' || block?.type === 'thinking')
    .map((block) => String(block.text ?? block.reasoning ?? block.thinking ?? ''))
    .join('')
}

function toolUseBlock(block) {
  const id = String(block?.id || block?.callId || block?.toolCallId || crypto.randomUUID())
  const name = String(block?.name || block?.toolName || block?.function?.name || 'tool')
  const rawInput = block?.input ?? block?.arguments ?? block?.function?.arguments ?? {}
  let input = rawInput
  if (typeof rawInput === 'string') {
    try {
      input = JSON.parse(rawInput)
    } catch {
      input = { raw: rawInput }
    }
  }
  return { type: 'tool_use', id, name, input }
}

function assistantBlocks(event) {
  const blocks = contentBlocks(event?.data)
  const result = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') result.push({ type: 'text', text: String(block.text || '') })
    else if (block.type === 'reasoning' || block.type === 'thinking') {
      result.push({ type: 'thinking', thinking: String(block.text ?? block.reasoning ?? block.thinking ?? '') })
    }
  }
  return result
}

function resultContentText(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return value == null ? '' : JSON.stringify(value)
  return value.map((block) => {
    if (typeof block === 'string') return block
    if (block?.type === 'text' || block?.type === 'reasoning' || block?.type === 'thinking') {
      return String(block.text ?? block.reasoning ?? block.thinking ?? '')
    }
    return JSON.stringify(block)
  }).join('')
}

function errorText(reason) {
  if (!reason) return ''
  if (typeof reason === 'string') return reason
  const kind = String(reason.kind || '')
  if (kind === 'completed') return ''
  if (kind === 'error') return String(reason.error?.message || reason.message || 'DeepSeek Harness turn failed')
  if (kind === 'aborted') return 'DeepSeek Harness turn aborted'
  if (kind === 'blocked') return 'DeepSeek Harness turn blocked'
  if (kind === 'interrupted') return 'DeepSeek Harness turn interrupted'
  if (kind === 'max-tokens') return 'DeepSeek Harness reached the maximum output token limit'
  return kind ? `DeepSeek Harness turn ended: ${kind}` : ''
}

function baseEntry(event, context) {
  return {
    uuid: `deepseek-harness:${context.sessionId}:${event?.seq ?? crypto.randomUUID()}`,
    timestamp: timestampOf(event),
    cwd: context.cwd || null,
    sessionId: context.agentSessionId || context.sessionId,
    version: `deepseek-harness/${context.runtimeVersion || 'unknown'}`,
    mobius: {
      schema_version: 1,
      source: 'deepseek-harness',
      backend: 'deepseek-harness',
      session_id: context.sessionId,
      agent_session_id: context.agentSessionId || context.sessionId,
      harness_event_type: event?.type || null,
      harness_seq: event?.seq ?? null,
    },
  }
}

function projectHarnessEvent(event, context) {
  if (!event || typeof event !== 'object' || !event.type) return []
  const base = baseEntry(event, context)
  // Mobius writes accepted user prompts before dispatching them to the runtime.
  // Re-projecting Harness' durable user event would render every prompt twice.
  if (event.type === 'user/message' || event.type === 'steering/message') return []
  if (event.type === 'assistant/message') {
    const content = assistantBlocks(event)
    if (!content.length) return []
    return [{
      ...base,
      type: 'assistant',
      message: { role: 'assistant', content },
    }]
  }
  if (event.type === 'tool/call') {
    return [{
      ...base,
      type: 'assistant',
      message: { role: 'assistant', content: [toolUseBlock(event.data || {})] },
    }]
  }
  if (event.type === 'tool/result') {
    const resultBlock = event.data?.message?.content?.find?.((block) => block?.type === 'tool-result')
    const callId = String(resultBlock?.toolCallId || event.data?.id || event.data?.callId || event.data?.toolCallId || '')
    const value = resultBlock?.content ?? event.data?.result ?? event.data?.output ?? event.data?.content ?? ''
    return [{
      ...base,
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: callId,
          content: resultContentText(value),
          is_error: !!(resultBlock?.isError || event.data?.isError || event.data?.is_error || event.data?.error),
        }],
      },
    }]
  }
  if (event.type === 'turn/end') {
    const message = errorText(event.data?.reason)
    if (!message) return []
    return [{
      ...base,
      type: 'error',
      message: { role: 'error', content: message },
    }]
  }
  if (event.type === 'todo/write' || event.type === 'approval/asked' || event.type === 'approval/requested') {
    return [{
      ...base,
      type: 'system',
      message: { role: 'system', content: JSON.stringify({ type: event.type, data: event.data }) },
    }]
  }
  return []
}

module.exports = { projectHarnessEvent, textFromBlocks, errorText }
