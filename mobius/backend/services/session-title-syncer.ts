import { Sessions } from '../repositories/sessions'
import adminSettings from './admin-settings'

// agents/events.js is intentionally CommonJS and has no Mobius business deps.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { onAgentRawEntry } = require('../agents/events')

const MAX_SESSION_TITLE_LENGTH = 120

type AgentRawEntryEvent = {
  backend?: string;
  sessionId?: string;
  entry?: unknown;
}

let unsubscribe: (() => void) | null = null

function parseEntry(entry: unknown): any | null {
  if (!entry) return null
  if (typeof entry === 'object') return entry
  if (typeof entry !== 'string') return null
  try {
    const parsed = JSON.parse(entry)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function normalizeSessionTitle(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const title = String(value)
    .replace(/\0/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title) return null
  return title.length > MAX_SESSION_TITLE_LENGTH
    ? title.slice(0, MAX_SESSION_TITLE_LENGTH).trim()
    : title
}

function extractSessionTitleFromEntry(entry: unknown): string | null {
  const obj = parseEntry(entry)
  if (!obj || obj.type !== 'ai-title') return null
  // For Claude Code, obj.sessionId is the agent's UUID (claude_session_id), not
  // Mobius sessions_v2.session_id. The agent watcher event is already scoped to
  // the Mobius session, so do not reject on this raw protocol field.
  return normalizeSessionTitle(obj.aiTitle ?? obj.ai_title ?? obj.title)
}

function handleAgentRawEntryForSessionTitle(event: AgentRawEntryEvent): { updated: boolean; title: string | null } {
  const sessionId = String(event?.sessionId || '').trim()
  if (!sessionId) return { updated: false, title: null }

  const title = extractSessionTitleFromEntry(event.entry)
  if (!title) return { updated: false, title: null }
  if (!adminSettings.isAutoGenerateSessionTitleEnabled()) return { updated: false, title }

  const current = Sessions.findNameById(sessionId)
  if (!current || current.name === title) return { updated: false, title }

  Sessions.updateName(sessionId, title)
  return { updated: true, title }
}

function startSessionTitleSyncer(): (() => void) | null {
  if (unsubscribe) return unsubscribe
  unsubscribe = onAgentRawEntry((event: AgentRawEntryEvent) => {
    try {
      handleAgentRawEntryForSessionTitle(event)
    } catch (e) {
      console.warn(`[session-title-syncer] failed: ${(e as Error).message}`)
    }
  })
  console.log('[session-title-syncer] started (source=agent raw_entry, autoGenerateSessionTitle default off)')
  return unsubscribe
}

function stopSessionTitleSyncer(): void {
  if (!unsubscribe) return
  try { unsubscribe() } catch {}
  unsubscribe = null
}

export {
  extractSessionTitleFromEntry,
  handleAgentRawEntryForSessionTitle,
  normalizeSessionTitle,
  startSessionTitleSyncer,
  stopSessionTitleSyncer,
}
