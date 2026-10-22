/**
 * session-reminder-hook.ts — builders for the session reminder hook shared by
 * Claude Code and Codex.
 *
 * Both agents receive the same shell command: curl forwards the hook's stdin JSON
 * to the Mobius backend and echoes the response body back as the hook output.
 * Claude Code consumes it as a `command` handler in its settings file; Codex
 * consumes it as a `command` handler in its profile config. Everything that
 * decides whether a reminder is shown lives in the backend, so these builders
 * only produce transport config and must stay pure.
 */

import * as crypto from 'crypto'

/** Reminder kind written to the rate-limit cache and used in the endpoint path. */
export const REMINDER_TYPE_REMOTE_TARGET_LOCAL_TOOL = 'remote_target_local_tool'

/** PreToolUse handler timeout in seconds (both agents support the field). */
export const DEFAULT_REMINDER_HOOK_TIMEOUT_SECONDS = 5

/** curl gives up before the handler timeout so a slow backend still returns cleanly. */
export const DEFAULT_REMINDER_CURL_MAX_TIME_SECONDS = 3

/** Claude Code tool names that act on the core host. */
export const CLAUDE_REMINDER_MATCHER = 'Bash|Edit|Write'

/** Codex canonical names; Write/Edit are accepted aliases of apply_patch. */
export const CODEX_REMINDER_MATCHER = 'Bash|apply_patch'

export interface ReminderHookCommandOptions {
  /** Backend origin, e.g. http://127.0.0.1:45616 or the sandbox gateway origin. */
  baseUrl: string
  /** Defaults to REMINDER_TYPE_REMOTE_TARGET_LOCAL_TOOL. */
  reminderType?: string
  /** Defaults to DEFAULT_REMINDER_CURL_MAX_TIME_SECONDS. */
  maxTimeSeconds?: number
}

export interface ReminderHookHandlerOptions {
  /** Defaults to CLAUDE_REMINDER_MATCHER. */
  matcher?: string
  /** Defaults to DEFAULT_REMINDER_HOOK_TIMEOUT_SECONDS. */
  timeoutSeconds?: number
}

/**
 * Build the decide endpoint URL and reject anything that could break out of the
 * shell-quoted command or the JSON/TOML config.
 */
export function reminderHookUrl({ baseUrl, reminderType }: ReminderHookCommandOptions): string {
  const type = String(reminderType || REMINDER_TYPE_REMOTE_TARGET_LOCAL_TOOL)
  if (!/^[A-Za-z0-9_-]+$/.test(type)) {
    throw new Error(`invalid reminder type: ${type}`)
  }
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s'"]+$/.test(base)) {
    throw new Error(`invalid reminder hook base url: ${baseUrl}`)
  }
  return `${base}/api/internal/session-reminders/${type}/decide`
}

/**
 * Shell command shared by both agents.
 *
 * It reads the hook JSON from stdin and prints the backend response verbatim, so
 * the backend's `hookSpecificOutput.additionalContext` becomes the hook output.
 * The token is expanded by the shell from MOBIUS_HOOK_TOKEN, keeping the session
 * secret out of the generated config file.
 */
export function buildReminderHookCommand(options: ReminderHookCommandOptions): string {
  const url = reminderHookUrl(options)
  const maxTime = Number(options.maxTimeSeconds ?? DEFAULT_REMINDER_CURL_MAX_TIME_SECONDS)
  if (!Number.isFinite(maxTime) || maxTime <= 0 || maxTime > 60) {
    throw new Error(`invalid curl max-time: ${options.maxTimeSeconds}`)
  }
  // 只使用单引号，配置写进 JSON/TOML 都不需要额外转义
  // Single quotes only, so the command needs no extra escaping in JSON or TOML
  return `curl -sS --max-time ${Math.floor(maxTime)} -X POST '${url}' -H 'content-type: application/json' -H 'x-mobius-hook-token: '$MOBIUS_HOOK_TOKEN --data-binary @-`
}

/** Claude Code settings fragment: a PreToolUse command hook group. */
export function claudeReminderHookSettings(
  command: string,
  options: ReminderHookHandlerOptions = {},
): Record<string, any> {
  const timeout = boundedTimeout(options.timeoutSeconds)
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: options.matcher || CLAUDE_REMINDER_MATCHER,
          hooks: [{ type: 'command', command, timeout }],
        },
      ],
    },
  }
}

/** Codex profile config fragment (TOML). */
export function codexReminderHookToml(
  command: string,
  options: ReminderHookHandlerOptions = {},
): string {
  const timeout = boundedTimeout(options.timeoutSeconds)
  const matcher = options.matcher || CODEX_REMINDER_MATCHER
  // 命令里没有双引号，只有防御性转义；TOML 基本字符串能原样承载
  // The command has no double quotes; escaping is defensive only
  const escaped = String(command).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  // Codex 的 profile 文件被当作「用户级 config.toml」加载, 所以事件挂在顶层 hooks 下;
  // 形如 [[PreToolUse.hooks]] 的是 requirements.toml 的写法, 在 config 里不生效.
  // The profile file is loaded as a user config.toml layer, so events live under
  // top-level `hooks`; `[[PreToolUse.hooks]]` is the requirements.toml shape and is
  // ignored here.
  return [
    '[[hooks.PreToolUse]]',
    `matcher = "${matcher.replace(/"/g, '\\"')}"`,
    '',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    `timeout = ${timeout}`,
    `command = "${escaped}"`,
    '',
  ].join('\n')
}

/** Session-scoped hook token: HMAC over the agent session id. */
export function reminderHookToken(sessionId: string, secret: string): string {
  const sid = String(sessionId || '')
  const key = String(secret || '')
  if (!sid) throw new Error('sessionId is required')
  if (!key) throw new Error('secret is required')
  return crypto.createHmac('sha256', key).update(`reminder:${sid}`).digest('base64url')
}

function boundedTimeout(value: number | undefined): number {
  const timeout = Number(value ?? DEFAULT_REMINDER_HOOK_TIMEOUT_SECONDS)
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60) {
    throw new Error(`invalid hook timeout: ${value}`)
  }
  return Math.floor(timeout)
}
