/**
 * claude-code-utils/types.ts — Shared shapes for the Claude Code tmux backend.
 *
 * Two contracts live here and nowhere else: the runtime entry, which is the
 * live state of one tmux window plus its claude TUI, and the dispatch options
 * shared by the create / queue / pause entry points.
 */
import type { MobiusPromptRecord } from '../../services/mobius-agent-history'

/** Runtime entry: the live state of one tmux window + claude TUI per mobius session. */
export interface ClaudeRuntimeEntry {
  agentSessionId: string
  cwd: string
  flagRoot: string
  model: string | null
  useProxy: boolean
  proxyMode?: string
  settingsPath: string | null
  withProxyPath?: string | null
  captureStream?: boolean
  forceNoProxy: boolean
  displayName: string | null
  jsonlPath: string
  startedAt: number
  watch: { stop?: () => void } | null
}

/**
 * The slice of the backend the helper modules are allowed to touch.
 *
 * Declared structurally on purpose: the helpers must not import the backend
 * class, or the class's import of the helpers would become a runtime cycle.
 * Only what the moved code actually needs appears here.
 */
export interface ClaudeBackendHost {
  name: string
  runtime: Map<string, ClaudeRuntimeEntry>
  persisted: Record<string, any>
  _emitRaw(sessionId: string, raw: unknown): void
  _persistEntry(sessionId: string, partial: Record<string, any>): void
  _forgetPersisted(sessionId: string): void
  _lookupPersistedJsonlPath(sessionId: string): string | null
  _lookupArchivedJsonlPath(sessionId: string): string | null
  harnessWriteMobiusCoreEntry(sessionId: string, record: MobiusPromptRecord | null | undefined, cwdHint?: string): any
  getPendingRequests(sessionId: string): any[]
  isWorking(sessionId: string): boolean
  pauseCurrentAndResumeFromSession(opts: ClaudeDispatchOpts): any
}

/** Dispatch contract: the arg shape shared by createNewSession / queue / pause. */
export interface ClaudeDispatchOpts {
  sessionId: string
  userId?: string
  prompt?: string
  initialPrompt?: string
  cwd?: string
  flagRoot?: string
  displayName?: string
  agentSessionId?: string | null
  isInitialContextPrompt?: boolean
  mobiusPromptRecord?: MobiusPromptRecord | null
  suppressRunningFlag?: boolean
  urgent?: boolean
  aimuxRemoteName?: string
  /** GUI(computer-use) authorization for the bound remote — adds the remote_gui_* toolset. */
  aimuxGuiAuthorized?: boolean
  modelLaunchOptions?: Record<string, unknown>
  model?: string | null
  useProxy?: boolean
  proxyMode?: string
  settingsPath?: string | null
  forceNoProxy?: boolean
  /** Digital-rain mode: capture the live output stream through a per-session proxy file. */
  captureStream?: boolean
  sandboxPolicy?: string | null
  [key: string]: unknown
}
