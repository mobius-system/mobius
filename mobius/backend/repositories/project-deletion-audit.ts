import { db } from '../../db';
import type { ProjectDeleteMode } from '../services/project-deletion-policy';

export type ProjectDeletionAuditOutcome = 'pending' | 'succeeded' | 'denied' | 'failed';

export interface ProjectDeletionImpact {
  issue_count: number;
  research_count: number;
  session_count: number;
  running_session_count: number;
}

interface AuditRecordArgs {
  actorId: string;
  actorSystemRole: string;
  projectId: string;
  projectName: string;
  projectCreator: string;
  deletionMode: ProjectDeleteMode | null;
  reason?: string;
  outcome: ProjectDeletionAuditOutcome;
  failureCode?: string;
  impact: ProjectDeletionImpact;
  requestIp?: string;
}

function clipped(value: unknown, max: number): string {
  return String(value || '').trim().slice(0, max);
}

const insertAudit = db.prepare(`
  INSERT INTO project_deletion_audit_log (
    actor_id, actor_system_role, project_id, project_name_snapshot,
    project_creator_snapshot, deletion_mode, reason, auth_method,
    outcome, failure_code, issue_count, research_count, session_count,
    running_session_count, request_ip, occurred_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'password', ?, ?, ?, ?, ?, ?, ?,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
`);

export const ProjectDeletionAudit = {
  impact(projectId: string): ProjectDeletionImpact {
    return db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM issues WHERE project_id = ?) AS issue_count,
        (SELECT COUNT(*) FROM researches WHERE project_id = ?) AS research_count,
        (SELECT COUNT(*) FROM sessions_v2 WHERE project_id = ? AND deleted_at IS NULL) AS session_count,
        (SELECT COUNT(*) FROM sessions_v2
          WHERE project_id = ? AND deleted_at IS NULL
            AND status = 'active' AND agent_status = 'running') AS running_session_count
    `).get(projectId, projectId, projectId, projectId) as ProjectDeletionImpact;
  },

  record(args: AuditRecordArgs): number {
    const info = insertAudit.run(
      clipped(args.actorId, 200),
      clipped(args.actorSystemRole, 40),
      clipped(args.projectId, 200),
      clipped(args.projectName, 500),
      clipped(args.projectCreator, 200),
      args.deletionMode,
      clipped(args.reason, 1000),
      args.outcome,
      clipped(args.failureCode, 100),
      args.impact.issue_count || 0,
      args.impact.research_count || 0,
      args.impact.session_count || 0,
      args.impact.running_session_count || 0,
      clipped(args.requestIp, 200),
    );
    return Number(info.lastInsertRowid);
  },

  complete(id: number, outcome: 'succeeded' | 'failed', failureCode = ''): void {
    db.prepare(`
      UPDATE project_deletion_audit_log
      SET outcome = ?, failure_code = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(outcome, clipped(failureCode, 100), id);
  },
};
