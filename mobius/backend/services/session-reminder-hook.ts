/**
 * session-reminder-hook.ts — builders for the session reminder hook shared by
 * Claude Code and Codex.
 *
 * Both agents run the same command: the `mobius_session_reminder` CLI forwards
 * the hook's stdin JSON to the Mobius backend and echoes the response body back
 * as the hook output. Claude Code consumes it as a `command` handler in its
 * settings file; Codex consumes it as a `command` handler in its profile config.
 * Everything that decides whether a reminder is shown lives in the backend, so
 * these builders only produce transport config and must stay pure.
 */

/** Reminder kind written to the rate-limit cache and used in the endpoint path. */
export const REMINDER_TYPE_REMOTE_TARGET_LOCAL_TOOL = 'remote_target_local_tool'

/** PreToolUse handler timeout in seconds (both agents support the field). */
export const DEFAULT_REMINDER_HOOK_TIMEOUT_SECONDS = 5

/** Claude Code tool names that act on the core host. */
export const CLAUDE_REMINDER_MATCHER = 'Bash|Edit|Write'

/** Codex canonical names; Write/Edit are accepted aliases of apply_patch. */
export const CODEX_REMINDER_MATCHER = 'Bash|apply_patch'

/**
 * Docker sandbox bridge gateway on the host. Inside a sandbox container
 * 127.0.0.1 is the container itself, so isolated sessions must call the backend
 * through this address (same convention as token-proxy and
 * materializeSettingsForSbx).
 */
export const SANDBOX_GATEWAY_IP = '172.28.0.1'

export interface ReminderHookBaseUrlOptions {
  /** True when the session runs inside a Docker sandbox container. */
  isolated: boolean
  /** Port the Mobius backend is reachable on from the caller's network. */
  backendPort: number
  /** Override for tests / non-default docker networks. */
  gatewayIp?: string
}

/**
 * Pick the base URL the hook must use for this session.
 *
 * Host sessions talk to loopback; sandbox sessions talk to the host bridge
 * gateway, because their loopback is the container itself.
 */
export function reminderHookBaseUrl(options: ReminderHookBaseUrlOptions): string {
  const port = Number(options.backendPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid backend port: ${options.backendPort}`)
  }
  const host = options.isolated
    ? String(options.gatewayIp || SANDBOX_GATEWAY_IP).trim()
    : '127.0.0.1'
  if (!/^[0-9.]+$|^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error(`invalid hook host: ${host}`)
  }
  return `http://${host}:${port}`
}

export interface ReminderHookCommandOptions {
  /** Absolute path to the mobius_session_reminder CLI (same path host and sandbox). */
  cliPath: string
  /** Defaults to REMINDER_TYPE_REMOTE_TARGET_LOCAL_TOOL. */
  reminderType?: string
}

export interface ReminderHookHandlerOptions {
  /** Defaults to CLAUDE_REMINDER_MATCHER. */
  matcher?: string
  /** Defaults to DEFAULT_REMINDER_HOOK_TIMEOUT_SECONDS. */
  timeoutSeconds?: number
}

/**
 * Command shared by both agents: invoke the CLI with nothing but its type.
 *
 * The CLI reads the hook JSON from stdin and takes the backend address, session
 * id and token from the session environment (MOBIUS_BASE / MOBIUS_SESSION_ID /
 * MOBIUS_CLI_JWT) that the launcher exports before the agent starts; the window
 * re-exports them on every respawn, so no per-session config file is needed.
 */
export function buildReminderHookCommand(options: ReminderHookCommandOptions): string {
  const type = String(options.reminderType || REMINDER_TYPE_REMOTE_TARGET_LOCAL_TOOL)
  if (!/^[A-Za-z0-9_-]+$/.test(type)) {
    throw new Error(`invalid reminder type: ${type}`)
  }
  const cliPath = String(options.cliPath || '').trim()
  // 只允许安全字符: 这个值会被原样写进 shell / JSON / TOML
  // Restrict to shell-safe characters; the path is embedded in shell, JSON and TOML
  if (!/^\/[A-Za-z0-9._/-]+$/.test(cliPath)) {
    throw new Error(`invalid reminder hook cli path: ${options.cliPath}`)
  }
  return `${cliPath} --type ${type}`
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

function boundedTimeout(value: number | undefined): number {
  const timeout = Number(value ?? DEFAULT_REMINDER_HOOK_TIMEOUT_SECONDS)
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60) {
    throw new Error(`invalid hook timeout: ${value}`)
  }
  return Math.floor(timeout)
}
