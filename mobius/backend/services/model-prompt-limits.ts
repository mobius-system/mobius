import { db } from '../../db'
import * as os from 'os'
import * as path from 'path'
import adminSettings from './admin-settings'
import modelRegistry from './model-registry'
import { DEFAULT_WINDOW_HOURS, normalizeHours } from './agent-prompt-events'
import agents from '../agents'

const WINDOW_HOURS = adminSettings.MODEL_PROMPT_LIMIT_WINDOW_HOURS || DEFAULT_WINDOW_HOURS
const WINDOW_MINUTES = adminSettings.MODEL_PROMPT_LIMIT_WINDOW_MINUTES || 5

function sinceForWindow(hours: any = WINDOW_HOURS): string {
  const h = normalizeHours(hours, WINDOW_HOURS)
  return (db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) AS since").get(`-${h} hours`) as { since: string }).since
}

function sinceForMinutes(minutes: any = WINDOW_MINUTES): string {
  const m = Math.max(1, Math.round(Number(minutes) || WINDOW_MINUTES))
  return (db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) AS since").get(`-${m} minutes`) as { since: string }).since
}

function optionFromResolved(resolved: any): any {
  return {
    key: resolved.key,
    value: resolved.value,
    model: resolved.model,
    label: resolved.label,
    title: resolved.title,
    sub: resolved.sub,
    backend: resolved.backend,
    imported: resolved.imported,
  }
}

function storageValuesForModel(modelOrKey: any): string[] {
  const resolved = modelRegistry.resolveSessionModel(modelOrKey)
  const values = new Set<string>()
  for (const value of [
    modelOrKey,
    resolved?.key,
    resolved?.value,
    resolved?.sessionModelValue,
    resolved?.model,
  ]) {
    if (typeof value === 'string' && value.trim()) values.add(value.trim())
  }
  return Array.from(values)
}

function countPromptsForModelSince(modelOrKey: any, modifier: string, userId: any = null): number {
  const values = storageValuesForModel(modelOrKey)
  if (values.length === 0) return 0
  const placeholders = values.map(() => '?').join(', ')
  const userClause = userId ? 'AND s.user_id = ?' : ''
  const params = userId ? [modifier, String(userId), ...values] : [modifier, ...values]
  return (db.prepare(`
    SELECT COUNT(*) AS c
    FROM agent_prompt_events e
    JOIN sessions_v2 s ON s.session_id = e.session_id
    WHERE e.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
      ${userClause}
      AND s.model IN (${placeholders})
  `).get(...params) as { c: number }).c || 0
}

function countUserPromptsForModelSince(userId: any, modelOrKey: any, hours: any = WINDOW_HOURS): number {
  if (!userId) return 0
  const h = normalizeHours(hours, WINDOW_HOURS)
  return countPromptsForModelSince(modelOrKey, `-${h} hours`, userId)
}

function countAllPromptsForModelSinceHours(modelOrKey: any, hours: any = WINDOW_HOURS): number {
  const h = normalizeHours(hours, WINDOW_HOURS)
  return countPromptsForModelSince(modelOrKey, `-${h} hours`)
}

function countUserPromptsForModelSinceMinutes(userId: any, modelOrKey: any, minutes: any = WINDOW_MINUTES): number {
  if (!userId) return 0
  const m = Math.max(1, Math.round(Number(minutes) || WINDOW_MINUTES))
  return countPromptsForModelSince(modelOrKey, `-${m} minutes`, userId)
}

function countAllPromptsForModelSinceMinutes(modelOrKey: any, minutes: any = WINDOW_MINUTES): number {
  const m = Math.max(1, Math.round(Number(minutes) || WINDOW_MINUTES))
  return countPromptsForModelSince(modelOrKey, `-${m} minutes`)
}

function modelLimitConfigForKey(modelKey: any): any {
  try {
    return adminSettings.getModelPromptLimitConfig(modelKey)
  } catch {
    return adminSettings.getModelPromptLimitConfig('__fallback__')
  }
}

function absoluteHomePath(value: any): string {
  const s = String(value || '').trim()
  if (!s) return ''
  if (s === '~') return os.homedir()
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2))
  return path.resolve(s)
}

function configPathForOption(opt: any): string {
  if (opt.backend === 'tmux-codex') {
    return absoluteHomePath(opt.codex_config_path || '')
  }
  if (opt.backend === 'tmux-claude-code') {
    return absoluteHomePath(opt.settings_path || '')
  }
  return ''
}

function pidExists(pid: any): boolean {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

function activeTmuxWindowCountForModel(modelOrKey: any): number {
  let resolved
  try {
    resolved = modelRegistry.resolveSessionModel(modelOrKey)
  } catch {
    return 0
  }
  if (!resolved?.backend) return 0
  let backend
  try {
    backend = agents.get(resolved.backend)
  } catch {
    return 0
  }
  let windows = []
  try {
    windows = backend.listSessions()
  } catch {
    return 0
  }
  const values = new Set<string>(storageValuesForModel(resolved.key))
  let count = 0
  for (const win of windows) {
    const sessionId = win?.sessionId
    if (!sessionId || sessionId === '_root' || win.paneDead) continue
    if (!pidExists(win.pid)) continue
    try {
      if (!backend.isAlive(sessionId)) continue
    } catch {
      continue
    }
    let row
    try {
      row = db.prepare('SELECT model FROM sessions_v2 WHERE session_id = ?').get(sessionId) as { model: string } | undefined
    } catch {
      row = undefined
    }
    if (row?.model && values.has(String(row.model))) count += 1
  }
  return count
}

function limitState(count: number, limit: any): any {
  const normalized = limit === null || limit === undefined ? null : Number(limit)
  const effectiveLimit = Number.isFinite(normalized) ? Math.max(0, Math.floor(normalized as number)) : null
  return {
    count,
    limit: effectiveLimit,
    remaining: effectiveLimit === null ? null : Math.max(0, effectiveLimit - count),
    blocked: effectiveLimit !== null && count >= effectiveLimit,
  }
}

function usageEntryForUserModel(userId: any, modelOrKey: any, hours: any = WINDOW_HOURS): any {
  const resolved = modelRegistry.resolveSessionModelForCreate(modelOrKey)
  const h = normalizeHours(hours, WINDOW_HOURS)
  const m = WINDOW_MINUTES
  const limits = modelLimitConfigForKey(resolved.key)
  const allUsers5h = limitState(countAllPromptsForModelSinceHours(resolved.key, h), limits.allUsers5h)
  const allUsers5m = limitState(countAllPromptsForModelSinceMinutes(resolved.key, m), limits.allUsers5m)
  const perUser5h = limitState(countUserPromptsForModelSince(userId, resolved.key, h), limits.perUser5h)
  const perUser5m = limitState(countUserPromptsForModelSinceMinutes(userId, resolved.key, m), limits.perUser5m)
  const tmuxWindows = limitState(activeTmuxWindowCountForModel(resolved.key), limits.tmuxWindows)
  const hardLimits = { allUsers5h, allUsers5m, perUser5h, perUser5m }
  const violated = Object.entries(hardLimits).find(([, state]) => state.blocked)?.[0] || null
  const blocked = !!violated
  return {
    ...optionFromResolved(resolved),
    count: perUser5h.count,
    limit: perUser5h.limit,
    remaining: perUser5h.remaining,
    blocked,
    blocked_by: violated,
    window_hours: h,
    window_minutes: m,
    since: sinceForWindow(h),
    since_minutes: sinceForMinutes(m),
    limits,
    usage: {
      allUsers5h,
      allUsers5m,
      perUser5h,
      perUser5m,
      tmuxWindows: {
        ...tmuxWindows,
        warning: tmuxWindows.limit !== null && tmuxWindows.count >= tmuxWindows.limit,
      },
    },
  }
}

function usageForUser(userId: any, hours: any = WINDOW_HOURS): any {
  const h = normalizeHours(hours, WINDOW_HOURS)
  const models: Record<string, any> = {}
  for (const opt of modelRegistry.listSessionModelOptions()) {
    models[opt.key] = usageEntryForUserModel(userId, opt.key, h)
  }
  return {
    window_hours: h,
    window_minutes: WINDOW_MINUTES,
    since: sinceForWindow(h),
    since_minutes: sinceForMinutes(WINDOW_MINUTES),
    models,
  }
}

function adminLimitsPayload(): any {
  const limits = adminSettings.getModelPromptLimits()
  return {
    window_hours: WINDOW_HOURS,
    window_minutes: WINDOW_MINUTES,
    models: modelRegistry.listSessionModelOptions().map((opt: any) => ({
      key: opt.key,
      value: opt.value,
      model: opt.model,
      label: opt.label,
      title: opt.title,
      sub: opt.sub,
      backend: opt.backend,
      imported: !!opt.imported,
      use_proxy: opt.use_proxy === true || opt.use_proxy === 1 ? 1 : 0,
      capture_stream: adminSettings.getModelCaptureStream(opt.key) ? 1 : 0,
      config_path: configPathForOption(opt),
      limits: Object.prototype.hasOwnProperty.call(limits.perModel, opt.key)
        ? limits.perModel[opt.key]
        : adminSettings.getModelPromptLimitConfig(opt.key),
    })),
  }
}

const LIMIT_LABELS: Record<string, string> = {
  allUsers5h: '所有用户 5 小时提问次数',
  allUsers5m: '所有用户 5 分钟提问次数',
  perUser5h: '单个用户 5 小时提问次数',
  perUser5m: '单个用户 5 分钟提问次数',
}

function checkCreateAllowed(userId: any, modelOrKey: any): any {
  const entry = usageEntryForUserModel(userId, modelOrKey, WINDOW_HOURS)
  if (!entry.blocked) return { allowed: true, usage: entry }
  const state = entry.usage?.[entry.blocked_by] || {}
  const label = LIMIT_LABELS[entry.blocked_by] || '管理员模型提问次数'
  return {
    allowed: false,
    usage: entry,
    status: 429,
    code: 'MODEL_PROMPT_LIMIT_EXCEEDED',
    error: `${entry.label || entry.title || entry.key} 的${label}已达管理员限制 (${state.count}/${state.limit}), 暂不能创建该模型的新 Session。已有 Session 可继续提问。`,
  }
}

const modelPromptLimits = {
  WINDOW_HOURS,
  WINDOW_MINUTES,
  adminLimitsPayload,
  checkCreateAllowed,
  countAllPromptsForModelSinceHours,
  countAllPromptsForModelSinceMinutes,
  countUserPromptsForModelSince,
  countUserPromptsForModelSinceMinutes,
  usageForUser,
  usageEntryForUserModel,
}

export {
  WINDOW_HOURS,
  WINDOW_MINUTES,
  adminLimitsPayload,
  checkCreateAllowed,
  countAllPromptsForModelSinceHours,
  countAllPromptsForModelSinceMinutes,
  countUserPromptsForModelSince,
  countUserPromptsForModelSinceMinutes,
  usageForUser,
  usageEntryForUserModel,
}

export default modelPromptLimits
