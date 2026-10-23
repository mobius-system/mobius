/**
 * session-dispatch-identity.ts — fill session dispatch fields from the database.
 *
 * The agent drivers can be entered from several places (first message, queued
 * message, interrupt-and-resume, internal notifications). Some of those call
 * sites only forward a subset of the dispatch options, and the driver's internal
 * respawn then runs without `userId` or the aimux binding. That used to be
 * invisible; today it means no MCP config, no CLI environment, and — because
 * `prepareSpawn(undefined)` returns null — no sandbox container.
 *
 * Resolving the missing fields from the session row at spawn time keeps every
 * entry point correct without changing each caller.
 */

import { db } from '../../db';
import { aimuxRemoteNameFromMeta, aimuxGuiAuthorizedFromMeta } from './pc-client-context';

export interface DispatchIdentityInput {
  userId?: string | null;
  aimuxRemoteName?: string | null;
  aimuxGuiAuthorized?: boolean | null;
}

export interface DispatchIdentity extends DispatchIdentityInput {
  /** Role of the session owner, when it could be resolved. */
  role?: string | null;
  /** Project id the session belongs to, when it could be resolved. */
  projectId?: string | null;
}

/**
 * Return the dispatch fields, filling any missing value from `sessions_v2`.
 *
 * Values already provided by the caller always win; the database is only a
 * fallback. A missing session row leaves the input untouched.
 */
export function resolveDispatchIdentity(
  sessionId: string,
  current: DispatchIdentityInput = {},
): DispatchIdentity {
  const needsUser = !current.userId;
  const needsRemote = !current.aimuxRemoteName;
  if (!needsUser && !needsRemote) {
    return { ...current };
  }

  let row: any;
  try {
    row = db
      .prepare(`
        SELECT s.user_id, s.project_id, s.pc_client_metadata, u.role
        FROM sessions_v2 s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.session_id = ?
      `)
      .get(String(sessionId));
  } catch {
    return { ...current };
  }
  if (!row) return { ...current };

  return {
    userId: current.userId || row.user_id || undefined,
    aimuxRemoteName: current.aimuxRemoteName || aimuxRemoteNameFromMeta(row.pc_client_metadata) || undefined,
    aimuxGuiAuthorized: current.aimuxGuiAuthorized ?? aimuxGuiAuthorizedFromMeta(row.pc_client_metadata),
    role: row.role || null,
    projectId: row.project_id || null,
  };
}
