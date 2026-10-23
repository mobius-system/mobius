/**
 * claude-code-utils/session-paths.ts — Where a session's claude state lives,
 * and the shell quoting used to name those paths on a command line.
 *
 * Every path here is derived from the effective HOME of the session owner:
 * the service user for admins, the sandbox .sbx-home for isolated users.
 * The container mounts that directory at the same absolute path, so one
 * string works on both sides of the boundary.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

import { CLAUDE_CONFIG } from './constants'
import { claudeHomeFor } from '../../services/user-isolation'
const { log } = require('../tmux-operation-log')

/*
 * Map a cwd to the directory name claude uses under ~/.claude/projects/:
 * every character outside [a-zA-Z0-9] becomes '-', so the mapping is lossy
 * and the name cannot be turned back into a path.
 * e.g. /home/u/cc-workspace/foo_bar → -home-u-cc-workspace-foo-bar
 */
export function encodeCwd(cwd: string) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/*
 * Absolute path of the transcript claude writes for one session:
 * ~/.claude/projects/<encoded cwd>/<claude session uuid>.jsonl.
 * Derived, never probed: callers run fs.existsSync themselves when they
 * must know whether the file is there (a resume whose jsonl is missing
 * degrades to a fresh session, see _spawnWindow).
 */
export function jsonlPathOf(cwd: string, claudeSessionId: string, userId?: string | null) {
  // 隔离用户的 transcript 在容器 HOME (.sbx-home) 下, 后端按用户取基准目录
  // An isolated user's transcript sits under the container HOME (.sbx-home)
  return path.join(claudeHomeFor(userId), '.claude', 'projects', encodeCwd(cwd), `${claudeSessionId}.jsonl`)
}

/*
 * Quote one value for the bash -lc command line, escaping embedded single
 * quotes the '\'' way (close quote, escaped quote, reopen).
 * Needed because the claude arguments are joined into a single shell
 * string: a model id or a path with a space would otherwise split into two
 * arguments.
 */
export function shellQuote(s: string) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/*
 * Pre-mark the project directory as trusted in the session owner's
 * .claude.json, so claude's first-run "Do you trust the files in this
 * folder?" dialog never appears in the TUI. Done this way because no
 * official CLI sets that flag (`claude project` only purges) and
 * --dangerously-skip-permissions does not skip the trust dialog either;
 * -p/--bare is incompatible with the interactive TUI.
 *
 * Idempotent: an entry already marked trusted is left untouched, and the
 * key is only ADDed for an entry that is missing or untrusted — an
 * existing entry belongs to the claude processes running there, so
 * overwriting it could drop their state. tmp file + atomic rename keeps
 * the shared config readable at all times.
 *
 * Returns false on any failure and never throws: startup must not be
 * blocked by this, because the ready poll's screenshot auto-confirm with
 * Enter is the fallback (belt and braces).
 */
export function ensureProjectTrusted(cwd: string, userId?: string | null) {
  try {
    // 信任按绝对路径记账，先归一化再查表
    // Trust is keyed by absolute path, normalize before looking it up
    const abs = path.resolve(cwd)
    // 隔离用户的信任写在容器 HOME (.sbx-home) 下; 文件不存在则造一个空表
    // (容器 HOME 可写, claude 首跑前由后端预置信任, 不依赖截屏兜底)
    const configFile = userId ? path.join(claudeHomeFor(userId), '.claude.json') : CLAUDE_CONFIG
    if (!fs.existsSync(configFile)) {
      if (!userId) return false
      fs.mkdirSync(path.dirname(configFile), { recursive: true })
      fs.writeFileSync(configFile, JSON.stringify({ projects: {} }, null, 2))
    }
    const j = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    if (!j.projects || typeof j.projects !== 'object') j.projects = {}
    const cur = j.projects[abs]
    // 已经信任过就直接返回，不动别人的状态
    // Already trusted, return without touching anyone else's state
    if (cur && cur.hasTrustDialogAccepted === true) return true
    // 保留原字段只置信任位，整条覆盖会丢状态
    // Keep existing keys, set only the trust bit; a full overwrite loses state
    j.projects[abs] = { ...(cur || {}), hasTrustDialogAccepted: true }
    // 先写临时文件再原子改名，配置不会被读到一半
    // Write tmp then rename atomically, the config is never read half-written
    const tmp = `${configFile}.imac-tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2))
    fs.renameSync(tmp, configFile)
    log(`[tmux-claude-code] 预置目录信任: ${abs} → ${configFile}`)
    return true
  } catch (e: any) {
    // 失败只告警不抛出，启动照常走截屏自动确认
    // Warn instead of throwing, startup still has the screenshot auto-confirm
    console.warn(`[tmux-claude-code] 预置目录信任失败 (走截屏兜底): ${e.message}`)
    return false
  }
}

/*
 * Resolve the aimux binary that gets spawned as a stdio MCP server for
 * desktop/TUI sessions which opted into add_remote_aimux_mcp: an explicit
 * AIMUX_BIN wins, then the user-local install, then the repo's own
 * .venv-aimux, and finally the bare name so PATH gets a chance. Mirrors the
 * sibling tmux-codex.ts and backend/services/aimux-remote.ts candidate list,
 * kept inline rather than imported to avoid crossing the .js/.ts boundary
 * from this CommonJS backend. The probe only checks existence, so a stale
 * non-executable file at a preferred location still shadows a working
 * binary further down the list.
 */
export function resolveAimuxBin() {
  const candidates = [
    process.env.AIMUX_BIN,
    path.join(os.homedir(), '.local', 'bin', 'aimux'),
    path.join(__dirname, '..', '..', '..', '.venv-aimux', 'bin', 'aimux'),
  ]
  // 取第一个存在的候选，都没有则退回裸名字
  // Take the first existing candidate, else fall back to the bare name
  for (const c of candidates) { if (c && fs.existsSync(c)) return c }
  return 'aimux'
}
