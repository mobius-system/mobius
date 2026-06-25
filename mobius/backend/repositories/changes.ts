import { db } from '../../db';
import type { ChangeRow } from '../types/rows';
import type * as BetterSqlite3 from 'better-sqlite3';

interface ChangePayloadRow extends ChangeRow {
  session_name: string;
  issue_title: string;
  project_name: string;
}

interface ChangeFileRow {
  id: number;
  change_id: string;
  file_path: string;
  change_type: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  symbols: string;
  risk_level: 'low' | 'medium' | 'high' | 'config' | 'schema';
}

interface ConflictRow {
  id: string;
  left_change_id: string;
  right_change_id: string;
  file_path: string;
  conflict_type: string;
  severity: 'info' | 'warn' | 'blocking';
  status: 'open' | 'resolved' | 'ignored';
  detail: string | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
  // JOIN 字段（可选）
  left_session_id?: string;
  right_session_id?: string;
  left_session_name?: string;
  right_session_name?: string;
  left_issue_id?: string;
  right_issue_id?: string;
  left_issue_title?: string;
  right_issue_title?: string;
  project_id?: string;
}

interface QueueRow {
  id: string;
  project_id: string;
  issue_id: string;
  priority: number;
  status: 'queued' | 'blocked' | 'integrating' | 'integrated' | 'skipped';
  reason: string | null;
  created_at: string;
  updated_at: string;
  // JOIN 字段
  title?: string;
  description?: string | null;
  integration_status?: string;
  acceptance_status?: string;
  internal_conflict_count?: number;
  external_conflict_count?: number;
  build_status?: string;
  release_note?: string | null;
}

const Changes = {
  findBySession: (sessionId: string): ChangeRow | undefined => db.prepare('SELECT * FROM session_changes WHERE session_id = ?').get(sessionId) as ChangeRow | undefined,
  findIdBySession: (sessionId: string): { id: string } | undefined => db.prepare('SELECT id FROM session_changes WHERE session_id = ?').get(sessionId) as { id: string } | undefined,

  // 主 payload(含 session/issue/project 名)
  payloadById: (changeId: string): ChangePayloadRow | undefined => db.prepare(`
    SELECT sc.*, s.name as session_name, i.title as issue_title, p.name as project_name
    FROM session_changes sc
    JOIN sessions s ON sc.session_id = s.session_id
    JOIN issues i ON sc.issue_id = i.id
    JOIN projects p ON sc.project_id = p.id
    WHERE sc.id = ?
  `).get(changeId) as ChangePayloadRow | undefined,

  filesByChange: (changeId: string): ChangeFileRow[] => db.prepare(
    'SELECT * FROM session_change_files WHERE change_id = ? ORDER BY risk_level DESC, file_path'
  ).all(changeId) as ChangeFileRow[],

  conflictsByChange: (changeId: string): ConflictRow[] => db.prepare(`
    SELECT c.*,
      ls.session_id as left_session_id, rs.session_id as right_session_id,
      lse.name as left_session_name, rse.name as right_session_name,
      li.title as left_issue_title, ri.title as right_issue_title
    FROM session_conflicts c
    JOIN session_changes ls ON c.left_change_id = ls.id
    JOIN session_changes rs ON c.right_change_id = rs.id
    JOIN sessions lse ON ls.session_id = lse.session_id
    JOIN sessions rse ON rs.session_id = rse.session_id
    JOIN issues li ON ls.issue_id = li.id
    JOIN issues ri ON rs.issue_id = ri.id
    WHERE (c.left_change_id = ? OR c.right_change_id = ?) AND c.status = 'open'
    ORDER BY c.severity DESC, c.created_at DESC
  `).all(changeId, changeId) as ConflictRow[],

  upsert: ({ id, session_id, issue_id, project_id, base_revision, summary }: {
    id: string;
    session_id: string;
    issue_id: string;
    project_id: string;
    base_revision: string | null;
    summary: string | null;
  }) => db.prepare(`
    INSERT INTO session_changes (id, session_id, issue_id, project_id, base_revision, status, summary, check_status, updated_at)
    VALUES (?, ?, ?, ?, ?, 'draft', ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(session_id) DO UPDATE SET
      issue_id = excluded.issue_id,
      project_id = excluded.project_id,
      status = 'draft',
      check_status = 'pending',
      summary = excluded.summary,
      updated_at = excluded.updated_at
  `).run(id, session_id, issue_id, project_id, base_revision, summary),

  deleteFiles: (changeId: string) => db.prepare('DELETE FROM session_change_files WHERE change_id = ?').run(changeId),

  insertFile: db.prepare(`
    INSERT OR REPLACE INTO session_change_files (change_id, file_path, change_type, additions, deletions, symbols, risk_level)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `) as BetterSqlite3.Statement,

  countOpenBlockingForChange: (changeId: string): number => (db.prepare(`
    SELECT COUNT(*) as c FROM session_conflicts
    WHERE status = 'open' AND severity = 'blocking' AND (left_change_id = ? OR right_change_id = ?)
  `).get(changeId, changeId) as { c: number }).c,

  setStatus: (id: string, status: string) => db.prepare(
    "UPDATE session_changes SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(status, id),

  setCheckResult: (id: string, checkStatus: string, detail: string, status: string) => db.prepare(
    "UPDATE session_changes SET check_status = ?, check_detail = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(checkStatus, detail, status, id),

  markIssueIntegrated: (issueId: string) => db.prepare(
    "UPDATE session_changes SET status = 'integrated', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE issue_id = ?"
  ).run(issueId),

  // 用于 recomputeProjectConflicts
  activeForProject: (projectId: string): Array<ChangeRow & { session_name: string; issue_title: string }> => db.prepare(`
    SELECT sc.*, s.name as session_name, i.title as issue_title
    FROM session_changes sc
    JOIN sessions s ON sc.session_id = s.session_id
    JOIN issues i ON sc.issue_id = i.id
    WHERE sc.project_id = ? AND sc.status NOT IN ('integrated','abandoned')
  `).all(projectId) as Array<ChangeRow & { session_name: string; issue_title: string }>,

  forIssueWithUser: (issueId: string): Array<ChangeRow & { session_name: string; user_id: string; user_display_name?: string }> => db.prepare(`
    SELECT sc.*, s.name as session_name, s.user_id, u.display_name as user_display_name
    FROM session_changes sc
    JOIN sessions s ON sc.session_id = s.session_id
    LEFT JOIN users u ON s.user_id = u.id
    WHERE sc.issue_id = ?
    ORDER BY sc.updated_at DESC
  `).all(issueId) as Array<ChangeRow & { session_name: string; user_id: string; user_display_name?: string }>,
};

const Conflicts = {
  resolveStaleByChangeIds: (changeIds: string[], activeIds: Set<string>): void => {
    const existing = db.prepare(`
      SELECT * FROM session_conflicts
      WHERE status = 'open' AND left_change_id IN (${changeIds.map(() => '?').join(',') || "''"})
         OR status = 'open' AND right_change_id IN (${changeIds.map(() => '?').join(',') || "''"})
    `).all(...changeIds, ...changeIds) as ConflictRow[];
    for (const c of existing) {
      if (!activeIds.has(c.left_change_id) || !activeIds.has(c.right_change_id)) {
        db.prepare(
          "UPDATE session_conflicts SET status = 'resolved', resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolution_note = '相关变更已集成或废弃' WHERE id = ?"
        ).run(c.id);
      }
    }
  },

  insertIfAbsent: db.prepare(`
    INSERT OR IGNORE INTO session_conflicts (id, left_change_id, right_change_id, file_path, conflict_type, severity, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `) as BetterSqlite3.Statement,

  countOpenBlockingForIssue: (issueId: string): number => (db.prepare(`
    SELECT COUNT(*) as c FROM session_conflicts c
    JOIN session_changes lc ON c.left_change_id = lc.id
    JOIN session_changes rc ON c.right_change_id = rc.id
    WHERE c.status = 'open' AND c.severity = 'blocking' AND (lc.issue_id = ? OR rc.issue_id = ?)
  `).get(issueId, issueId) as { c: number }).c,

  countConflictFilesForProject: (projectId: string): number => (db.prepare(`
    SELECT COUNT(DISTINCT file_path) as c FROM session_conflicts c
    JOIN session_changes lc ON c.left_change_id = lc.id
    WHERE lc.project_id = ? AND c.status = 'open'
  `).get(projectId) as { c: number }).c,

  listForProject: (projectId: string): ConflictRow[] => db.prepare(`
    SELECT c.*,
      lc.session_id as left_session_id, rc.session_id as right_session_id,
      ls.name as left_session_name, rs.name as right_session_name,
      li.id as left_issue_id, ri.id as right_issue_id,
      li.title as left_issue_title, ri.title as right_issue_title
    FROM session_conflicts c
    JOIN session_changes lc ON c.left_change_id = lc.id
    JOIN session_changes rc ON c.right_change_id = rc.id
    JOIN sessions ls ON lc.session_id = ls.session_id
    JOIN sessions rs ON rc.session_id = rs.session_id
    JOIN issues li ON lc.issue_id = li.id
    JOIN issues ri ON rc.issue_id = ri.id
    WHERE lc.project_id = ?
    ORDER BY CASE c.severity WHEN 'blocking' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, c.created_at DESC
  `).all(projectId) as ConflictRow[],

  findByIdJoined: (id: string): (ConflictRow & { project_id: string }) | undefined => db.prepare(`
    SELECT c.*, lc.project_id, lc.issue_id as left_issue_id, rc.issue_id as right_issue_id
    FROM session_conflicts c
    JOIN session_changes lc ON c.left_change_id = lc.id
    JOIN session_changes rc ON c.right_change_id = rc.id
    WHERE c.id = ?
  `).get(id) as (ConflictRow & { project_id: string }) | undefined,

  updateStatus: (id: string, status: string, note: string) => db.prepare(`
    UPDATE session_conflicts SET status = ?, resolution_note = ?, resolved_at = CASE WHEN ? = 'open' THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END WHERE id = ?
  `).run(status, note, status, id),

  findById: (id: string): ConflictRow | undefined => db.prepare('SELECT * FROM session_conflicts WHERE id = ?').get(id) as ConflictRow | undefined,
};

const Queue = {
  maxPriority: (projectId: string): number => (db.prepare(
    'SELECT COALESCE(MAX(priority), 0) as p FROM project_integration_queue WHERE project_id = ?'
  ).get(projectId) as { p: number }).p,

  upsert: ({ id, projectId, issueId, priority, status, reason }: {
    id: string;
    projectId: string;
    issueId: string;
    priority: number;
    status: string;
    reason: string | null;
  }) => db.prepare(`
    INSERT INTO project_integration_queue (id, project_id, issue_id, priority, status, reason)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, issue_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(id, projectId, issueId, priority, status, reason),

  setIntegratingFor: (projectId: string, issueId: string) => db.prepare(
    "UPDATE project_integration_queue SET status = 'integrating', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE project_id = ? AND issue_id = ?"
  ).run(projectId, issueId),

  markIntegrated: (projectId: string, issueId: string) => db.prepare(
    "UPDATE project_integration_queue SET status = 'integrated', reason = '', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE project_id = ? AND issue_id = ?"
  ).run(projectId, issueId),

  reorder: (projectId: string, issueIds: string[]): void => {
    const update = db.prepare(
      "UPDATE project_integration_queue SET priority = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE project_id = ? AND issue_id = ?"
    );
    issueIds.forEach((issueId, index) => update.run(index + 1, projectId, issueId));
  },

  listForProject: (projectId: string): QueueRow[] => db.prepare(`
    SELECT q.*, i.title, i.description, ii.status as integration_status, ii.acceptance_status,
      ii.internal_conflict_count, ii.external_conflict_count, ii.build_status, ii.release_note
    FROM project_integration_queue q
    JOIN issues i ON q.issue_id = i.id
    LEFT JOIN issue_integrations ii ON q.issue_id = ii.issue_id
    WHERE q.project_id = ?
    ORDER BY q.priority ASC, q.created_at ASC
  `).all(projectId) as QueueRow[],

  queuedIssueIds: (projectId: string): string[] => (db.prepare(`
    SELECT issue_id FROM project_integration_queue
    WHERE project_id = ? AND status = 'queued'
    ORDER BY priority ASC, created_at ASC
  `).all(projectId) as Array<{ issue_id: string }>).map(q => q.issue_id),

  // Project metrics + 全 issue 列表(供 integration-queue 视图)
  projectMetrics: (projectId: string): { active_sessions: number; pending_issues: number; ready_issues: number; conflict_files: number } => db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sessions WHERE project_id = ? AND status = 'active') as active_sessions,
      (SELECT COUNT(*) FROM issue_integrations WHERE project_id = ? AND acceptance_status = 'pending') as pending_issues,
      (SELECT COUNT(*) FROM issue_integrations WHERE project_id = ? AND status = 'ready') as ready_issues,
      (SELECT COUNT(DISTINCT file_path) FROM session_conflicts c
        JOIN session_changes lc ON c.left_change_id = lc.id
        WHERE lc.project_id = ? AND c.status = 'open') as conflict_files
  `).get(projectId, projectId, projectId, projectId) as { active_sessions: number; pending_issues: number; ready_issues: number; conflict_files: number },

  issuesWithIntegrationForProject: (projectId: string): Array<any> => db.prepare(`
    SELECT i.*, ii.status as integration_status, ii.acceptance_status, ii.internal_conflict_count, ii.external_conflict_count, ii.build_status,
      (SELECT COUNT(*) FROM session_changes WHERE issue_id = i.id) as change_count
    FROM issues i
    LEFT JOIN issue_integrations ii ON i.id = ii.issue_id
    WHERE i.project_id = ?
    ORDER BY i.last_active DESC
  `).all(projectId) as Array<any>,
};

export { Changes, Conflicts, Queue };
