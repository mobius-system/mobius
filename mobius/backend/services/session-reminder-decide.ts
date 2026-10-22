/**
 * session-reminder-decide.ts — pure decision logic for session reminders.
 *
 * Kept free of database and HTTP concerns so the cooldown contract can be tested
 * in isolation:
 *   - at most one reminder per reminder type per rolling `cooldownMinutes`
 *   - when the decision is "do not remind", the caller returns `{}` and injects
 *     nothing at all (no placeholder text, no dummy context)
 */

export const DEFAULT_REMINDER_COOLDOWN_MINUTES = 60
export const DEFAULT_REMINDER_MESSAGE =
  'The target host is {{target}}; Bash/Edit/Write here act on the core host. ' +
  'Remote work goes through the remote_exec_command / remote_apply_patch MCP tools.'

export interface ReminderConfig {
  enabled: boolean
  cooldownMinutes: number
  message: string
}

export interface ReminderDecisionInput {
  /** Reminder kind, e.g. remote_target_local_tool. */
  reminderType: string
  /** Current time; injectable for tests. */
  now: Date | number
  /** Remote target host bound to the session, or null when there is none. */
  target: string | null
  /** ISO timestamp of the last shown reminder, or null when never shown. */
  lastShownAt: string | null
  /** Tool that triggered the hook, used only for {{tool}} in the message. */
  toolName?: string | null
  config: ReminderConfig
}

export type ReminderDecisionReason =
  | 'disabled'
  | 'no_remote_target'
  | 'cooling'
  | 'shown'

export interface ReminderDecision {
  show: boolean
  reason: ReminderDecisionReason
  /** Present only when show is true. */
  message?: string
  /** Present only when reason is cooling. */
  nextEligibleAt?: string
}

/**
 * Decide whether the reminder should be shown right now.
 *
 * Suppression returns no message on purpose: the transport turns it into `{}`,
 * which both agents treat as "no hook output".
 */
export function decideReminder(input: ReminderDecisionInput): ReminderDecision {
  const config = normalizeConfig(input.config)

  if (!config.enabled) return { show: false, reason: 'disabled' }

  const target = typeof input.target === 'string' ? input.target.trim() : ''
  if (!target) return { show: false, reason: 'no_remote_target' }

  const now = toMillis(input.now)
  const last = parseTimestamp(input.lastShownAt)
  if (last !== null) {
    const cooldownMs = config.cooldownMinutes * 60_000
    // 时钟回拨 (last 在未来) 按"刚提醒过"处理, 避免连发
    // A future timestamp means the clock moved backwards; treat it as just shown
    const elapsed = now - last
    if (elapsed < cooldownMs) {
      return {
        show: false,
        reason: 'cooling',
        nextEligibleAt: new Date(last + cooldownMs).toISOString(),
      }
    }
  }

  return {
    show: true,
    reason: 'shown',
    message: renderReminderMessage(config.message, { target, tool: input.toolName || '' }),
  }
}

/** Fill {{target}} / {{tool}}; unknown placeholders are left untouched. */
export function renderReminderMessage(
  template: string,
  vars: { target: string; tool?: string | null },
): string {
  return String(template || '')
    .replace(/\{\{\s*target\s*\}\}/g, vars.target)
    .replace(/\{\{\s*tool\s*\}\}/g, String(vars.tool || ''))
}

/** Merge partial config with defaults and clamp the cooldown to a sane range. */
export function normalizeConfig(config: Partial<ReminderConfig> | null | undefined): ReminderConfig {
  const enabled = config?.enabled !== false
  const raw = Number(config?.cooldownMinutes)
  // 允许小数便于测试与"半小时"档, 但必须为正
  // Fractional minutes are allowed (tests, half-hour tiers) but must be positive
  const cooldownMinutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REMINDER_COOLDOWN_MINUTES
  const message = typeof config?.message === 'string' && config.message.trim()
    ? config.message
    : DEFAULT_REMINDER_MESSAGE
  return { enabled, cooldownMinutes, message }
}

function toMillis(value: Date | number): number {
  if (value instanceof Date) return value.getTime()
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`invalid now value: ${value}`)
  return n
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}
