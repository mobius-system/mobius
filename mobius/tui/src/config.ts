/**
 * Local persistence for the Mobius terminal client under ~/.mobius/.
 *
 * Files (per the TUI spec):
 *   login.json                     — { server, username, password?, token, user }
 *   projects.json                  — cached list of known projects
 *   dir2project.json               — { [cwd]: projectId }
 *   dir2project_preference.json    — { [cwd]: CwdPreference }
 *
 * "Preferences are saved inside the task (Issue)": each cwd remembers the
 * currently-selected issueId plus a per-issue preference store, so switching
 * issues restores that issue's model / language / skill / memory choices.
 *
 * The base directory is resolved lazily so tests can redirect it via the
 * MOBIUS_TUI_HOME env var (or setMobiusHome()) without touching the real home.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Project, User } from './types.js'

let _homeOverride: string | null = null
export function setMobiusHome(p: string): void { _homeOverride = p }
export function mobiusHome(): string {
  return _homeOverride ?? process.env.MOBIUS_TUI_HOME ?? path.join(os.homedir(), '.mobius')
}
const LOGIN_FILE = () => path.join(mobiusHome(), 'login.json')
const PROJECTS_FILE = () => path.join(mobiusHome(), 'projects.json')
const DIR2PROJECT_FILE = () => path.join(mobiusHome(), 'dir2project.json')
const PREFERENCE_FILE = () => path.join(mobiusHome(), 'dir2project_preference.json')

export const MOBIUS_DIR = mobiusHome() // back-compat for any importer

export interface LoginRecord {
  server: string
  username: string
  password?: string
  token: string
  user: User
}

/** Preferences bound to a single Issue (task). */
export interface IssuePreference {
  model?: string
  language?: 'zh' | 'en'
  excluded_skill_ids: string[]
  excluded_memory_ids: string[]
  /** completed wizard step keys: 'model' | 'language' | 'skills' | 'memories' */
  done?: string[]
}

/** Per-cwd preference state: which issue is active + each issue's saved prefs. */
export interface CwdPreference {
  issueId?: string
  issueTitle?: string
  prefs: { [issueId: string]: IssuePreference }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(mobiusHome(), { recursive: true })
  await fs.writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 })
}

// ── login.json ───────────────────────────────────────────────────────────────
export async function loadLogin(): Promise<LoginRecord | null> {
  const rec = await readJson<LoginRecord | null>(LOGIN_FILE(), null)
  if (!rec || !rec.token || !rec.server) return null
  return rec
}

export async function saveLogin(rec: LoginRecord): Promise<void> {
  await writeJson(LOGIN_FILE(), rec)
}

export async function clearLogin(): Promise<void> {
  try { await fs.unlink(LOGIN_FILE()) } catch { /* ignore */ }
}

// ── projects.json (cache) ────────────────────────────────────────────────────
export async function loadProjectsCache(): Promise<Project[]> {
  const data = await readJson<{ projects?: Project[] } | Project[]>(PROJECTS_FILE(), [])
  return Array.isArray(data) ? data : (data.projects ?? [])
}

export async function saveProjectsCache(projects: Project[]): Promise<void> {
  await writeJson(PROJECTS_FILE(), { projects })
}

// ── dir2project.json ─────────────────────────────────────────────────────────
export async function loadDir2Project(): Promise<Record<string, string>> {
  return readJson<Record<string, string>>(DIR2PROJECT_FILE(), {})
}

export async function saveDir2Project(map: Record<string, string>): Promise<void> {
  await writeJson(DIR2PROJECT_FILE(), map)
}

export async function bindCwdToProject(cwd: string, projectId: string): Promise<void> {
  const map = await loadDir2Project()
  map[cwd] = projectId
  await saveDir2Project(map)
}

// ── dir2project_preference.json ──────────────────────────────────────────────
export async function loadPreferences(): Promise<Record<string, CwdPreference>> {
  return readJson<Record<string, CwdPreference>>(PREFERENCE_FILE(), {})
}

export async function savePreferences(map: Record<string, CwdPreference>): Promise<void> {
  await writeJson(PREFERENCE_FILE(), map)
}

export async function getCwdPreference(cwd: string): Promise<CwdPreference> {
  const map = await loadPreferences()
  return map[cwd] ?? { prefs: {} }
}

/** Persist the active issue for a cwd. */
export async function setCwdIssue(cwd: string, issueId: string, issueTitle?: string): Promise<IssuePreference> {
  const map = await loadPreferences()
  const cur = map[cwd] ?? { prefs: {} }
  cur.issueId = issueId
  cur.issueTitle = issueTitle
  if (!cur.prefs[issueId]) {
    cur.prefs[issueId] = { excluded_skill_ids: [], excluded_memory_ids: [] }
  }
  map[cwd] = cur
  await savePreferences(map)
  return cur.prefs[issueId]
}

/** Update one issue's preference fields for the cwd (merges into stored). */
export async function updateIssuePreference(
  cwd: string,
  issueId: string,
  patch: Partial<IssuePreference>,
): Promise<IssuePreference> {
  const map = await loadPreferences()
  const cur = map[cwd] ?? { prefs: {} }
  const base: IssuePreference = cur.prefs[issueId] ?? { excluded_skill_ids: [], excluded_memory_ids: [] }
  const merged: IssuePreference = { ...base, ...patch }
  cur.prefs[issueId] = merged
  map[cwd] = cur
  await savePreferences(map)
  return merged
}

export function cwd(): string {
  return process.cwd()
}
