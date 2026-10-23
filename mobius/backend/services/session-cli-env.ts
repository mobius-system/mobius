/**
 * session-cli-env.ts — the environment every agent session gets so the Mobius
 * CLIs behave identically on the host and inside a Docker sandbox.
 *
 * Two decisions live here and nowhere else:
 *   - where the CLI scripts are (the same absolute path is bind-mounted into
 *     sandboxes, so one PATH string works in both places)
 *   - how a CLI reaches the backend (loopback on the host, the docker bridge
 *     gateway inside a sandbox) and what token it presents
 *
 * Every CLI authenticates with the same MOBIUS_CLI_JWT: a per-session JWT that
 * carries the owner's user id plus the session id and expires with the backend's
 * usual 7 day window. The existing auth middleware accepts it unchanged.
 *
 * Keeping it in one function means no CLI needs an "am I in docker?" branch:
 * identity comes from the token, the address comes from the environment.
 */

import * as path from 'path'
import jwt from 'jsonwebtoken'

import { APP_DIR, JWT_SECRET, PORT } from '../config'
import { reminderHookBaseUrl } from './session-reminder-hook'

export interface SessionCliEnvInput {
  userId: string
  sessionId: string
  /** True when the session runs inside a Docker sandbox container. */
  isolated: boolean
}

export interface SessionCliEnv {
  /** Directory holding every Mobius CLI script. */
  cliDir: string
  /** Variables exported into the session shell before the agent starts. */
  vars: Record<string, string>
}

/**
 * Build the CLI environment for one session.
 *
 * The JWT is minted here so sandbox sessions never need JWT_SECRET. Its claims
 * are the user id (the field auth middleware reads) and the session id (for
 * auditing / log correlation). 7 day lifetime: a long-lived session that
 * outlives it must be respawned to get a fresh one.
 */
export function buildSessionCliEnv(input: SessionCliEnvInput): SessionCliEnv {
  const userId = String(input.userId || '').trim()
  const sessionId = String(input.sessionId || '').trim()
  if (!userId) throw new Error('buildSessionCliEnv: userId is required')
  if (!sessionId) throw new Error('buildSessionCliEnv: sessionId is required')

  return {
    cliDir: path.join(APP_DIR, 'mobius', 'scripts', 'cli'),
    vars: {
      MOBIUS_BASE: reminderHookBaseUrl({ isolated: !!input.isolated, backendPort: PORT }),
      // 所有 CLI 共用一枚令牌: 中间件只读 id, session_id 仅用于审计与日志关联
      // One token for every CLI: the middleware reads id; session_id is for audit
      MOBIUS_CLI_JWT: jwt.sign({ id: userId, session_id: sessionId }, JWT_SECRET, { expiresIn: '7d' }),
    },
  }
}

/**
 * Render the environment as `export` fragments for a bash -lc chain.
 *
 * PATH is prepended rather than replaced so the session keeps the toolchain it
 * already had. Values are single-quoted; the callers pass the result through
 * their own shellQuote for the surrounding command.
 */
export function sessionCliEnvExports(env: SessionCliEnv): string[] {
  const lines = [`export PATH=${shellQuote(env.cliDir)}:"$PATH"`]
  for (const [key, value] of Object.entries(env.vars)) {
    lines.push(`export ${key}=${shellQuote(value)}`)
  }
  return lines
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
