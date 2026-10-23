/**
 * session-hook-inject.ts — write a per-session copy of an agent config file with
 * the reminder hook installed.
 *
 * The model-level settings/profile files are shared by every session, so hooks
 * are never written there. Each spawn copies the effective config to the
 * session directory (bind-mounted into sandboxes) and adds one PreToolUse entry.
 */

import fs from 'fs'
import path from 'path'

import { HIDDEN_FOLDER_NAME } from '../config'

/** Marker used to detect an already-injected Codex hook block. */
const CODEX_HOOK_MARKER = '[[hooks.PreToolUse]]'

/** Directory name of the per-session agent config inside the project hidden folder. */
export const SESSION_SETTINGS_DIRNAME = 'mobius-session-settings'

export interface SessionSettingsPaths {
  dir: string
  /** Claude settings copy carrying the reminder hook. */
  settingsPath: string
  /** Reminder hook config (base url, session id, token). */
  hookConfigPath: string
  /** MCP server definitions passed to the agent via --mcp-config. */
  mcpConfigPath: string
}

/**
 * Paths for one session's agent config, rooted at the project bind path.
 *
 * The bind path is host-backed and bind-mounted into sandboxes at the same
 * path, so one string works for admins and sandboxed users alike.
 */
export function sessionSettingsPaths(bindRoot: string, sessionId: string): SessionSettingsPaths {
  // 每个会话一个目录: <bind>/<hidden>/mobius-session-settings/<sid>/
  // One directory per session; the directory survives terminate on purpose.
  const dir = path.join(String(bindRoot), HIDDEN_FOLDER_NAME, SESSION_SETTINGS_DIRNAME, String(sessionId))
  return {
    dir,
    settingsPath: path.join(dir, 'settings.json'),
    hookConfigPath: path.join(dir, 'hook.json'),
    mcpConfigPath: path.join(dir, 'mcp.json'),
  }
}

/**
 * Create the per-session settings directory. Git ignore policy is the project's
 * concern, not the backend's.
 */
export function ensureSessionSettingsDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export interface ClaudeHookInjectOptions {
  /** Effective settings file for this session (already proxy/container rewritten). */
  sourcePath: string
  /** Where to write the per-session copy. */
  destPath: string
  /** Command to run, usually the reminder CLI with its arguments. */
  command: string
  matcher: string
  timeoutSeconds?: number
}

export interface ReminderHookConfigFile {
  /** Backend origin reachable from where the agent runs. */
  base_url: string
  /** Mobius session id. */
  session_id: string
  /** Per-session hook token. */
  token: string
  /** Optional reminder type override. */
  reminder_type?: string
}

/**
 * Write the per-session hook config (base URL, session id, token).
 *
 * The hook command embeds this file's path, so the hook keeps working even when
 * an agent respawn loses the environment variables the launcher exported.
 */
export function writeReminderHookConfig(destPath: string, config: ReminderHookConfigFile): string {
  writeAtomic(destPath, JSON.stringify(config, null, 2))
  return destPath
}

export interface CodexHookInjectOptions {
  /** Effective profile config (plain profile or per-session withproxy file). */
  sourcePath: string
  /** New per-session profile file to create. */
  destPath: string
  /** TOML fragment produced by codexReminderHookToml(). */
  tomlBlock: string
}

/**
 * Copy Claude settings and ensure exactly one hook group runs `command`.
 * Returns the destination path.
 */
export function injectClaudeReminderHook(options: ClaudeHookInjectOptions): string {
  const raw = fs.existsSync(options.sourcePath)
    ? fs.readFileSync(options.sourcePath, 'utf8')
    : '{}'
  let settings: any
  try {
    settings = JSON.parse(raw || '{}')
  } catch {
    settings = {}
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {}

  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []

  // 先去掉本 CLI 的旧条目, 避免重复 spawn 叠出多条
  // Drop earlier copies of this CLI so respawns never stack duplicates
  const kept = existing.filter((group: any) => {
    const list = Array.isArray(group?.hooks) ? group.hooks : []
    return !list.some((handler: any) =>
      typeof handler?.command === 'string' && handler.command.includes(options.command.trim().split(' ')[0]),
    )
  })
  kept.push({
    matcher: options.matcher,
    hooks: [{
      type: 'command',
      command: options.command,
      timeout: Math.max(1, Math.floor(Number(options.timeoutSeconds) || 5)),
    }],
  })
  settings.hooks = { ...hooks, PreToolUse: kept }

  writeAtomic(options.destPath, JSON.stringify(settings, null, 2))
  return options.destPath
}

/**
 * Copy a Codex profile config and append the hook block once.
 * Returns the destination path.
 */
export function injectCodexReminderHook(options: CodexHookInjectOptions): string {
  const raw = fs.readFileSync(options.sourcePath, 'utf8')
  const block = String(options.tomlBlock || '').trim()
  const next = raw.includes(CODEX_HOOK_MARKER)
    ? raw
    : `${raw.replace(/\s*$/, '')}\n\n${block}\n`
  writeAtomic(options.destPath, next)
  return options.destPath
}

function writeAtomic(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, filePath)
  try { fs.chmodSync(filePath, 0o600) } catch { /* best-effort */ }
}
