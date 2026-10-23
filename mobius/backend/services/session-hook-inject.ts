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

/** Marker used to detect an already-injected Codex hook block. */
const CODEX_HOOK_MARKER = '[[hooks.PreToolUse]]'

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
