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
 * Keeping it in one function means no CLI needs an "am I in docker?" branch:
 * identity comes from the token, the address comes from the environment.
 */

import * as path from 'path'
import jwt from 'jsonwebtoken'

import { APP_DIR, JWT_SECRET, PORT } from '../config'
import { reminderHookBaseUrl, reminderHookToken } from './session-reminder-hook'

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
 * The JWT is minted here so sandbox sessions never need JWT_SECRET; its claims
 * carry only the user id, and the auth middleware resolves the user from the
 * database, so the token cannot grant more than that user already has.
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
      // 与登录令牌同寿命 (7d); 长命会话不会在一天后突然失去 CLI 能力
      // Same lifetime as login tokens (7d), so long-lived sessions keep working
      MOBIUS_JWT: jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '7d' }),
      MOBIUS_HOOK_TOKEN: reminderHookToken(sessionId, JWT_SECRET),
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
