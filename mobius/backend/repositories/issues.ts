import { db } from '../../db';
import type { IssueRow } from '../types/rows';

type IssueStatus = 'active' | 'completed';
type IssueVisibility = 'inherit' | 'private' | 'team' | 'public' | 'allowlist';

interface IssueListRow extends IssueRow {
  created_by_name?: string;
  session_count?: number;
}

interface IssueInsertArgs {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  created_by: string;
  use_worktree: boolean;
  worktree_branch: string;
  visibility?: IssueVisibility;
  is_planning?: boolean;
}

interface IssueIntegrationRow {
  id: string;
  issue_id: string;
  project_id: string;
  status: string;
  internal_conflict_count: number;
  external_conflict_count: number;
  build_status: string;
  acceptance_status: string;
  release_note: string | null;
  integrated_at: string | null;
  created_at: string;
  updated_at: string;
}

const Issues = {
  findById: (id: string, userId?: string | null): IssueRow | undefined => {
    if (!userId) {
      return db.prepare('SELECT *, 0 AS starred FROM issues WHERE id = ?').get(id) as IssueRow | undefined;
    }
    return db.prepare(`
      SELECT i.*, CASE WHEN ius.user_id IS NULL THEN 0 ELSE 1 END AS starred
      FROM issues i
      LEFT JOIN issue_user_stars ius ON ius.issue_id = i.id AND ius.user_id = ?
      WHERE i.id = ?
    `).get(userId, id) as IssueRow | undefined;
  },
  findByProjectAndTitle: (projectId: string, title: string): IssueRow | undefined => db.prepare(
    'SELECT * FROM issues WHERE project_id = ? AND title = ? ORDER BY created_at ASC LIMIT 1'
  ).get(projectId, title) as IssueRow | undefined,

  listForProject: (projectId: string, statusFilter: IssueStatus | undefined, userId?: string | null): IssueListRow[] => {
    if (userId) {
      let where = 'i.project_id = ?';
      const params: Array<string> = [userId, projectId];
      if (statusFilter === 'active' || statusFilter === 'completed') {
        where += ' AND i.status = ?';
        params.push(statusFilter);
      }
      return db.prepare(`
        SELECT i.*, u.display_name as created_by_name,
          CASE WHEN ius.user_id IS NULL THEN 0 ELSE 1 END AS starred,
          (SELECT COUNT(*) FROM sessions_v2 WHERE issue_id = i.id AND scope_type = 'issue' AND status = 'active') as session_count
        FROM issues i
        LEFT JOIN users u ON i.created_by = u.id
        LEFT JOIN issue_user_stars ius ON ius.issue_id = i.id AND ius.user_id = ?
        WHERE ${where}
        ORDER BY i.last_active DESC
      `).all(...params) as IssueListRow[];
    }
    let where = 'i.project_id = ?';
    const params: Array<string> = [projectId];
    if (statusFilter === 'active' || statusFilter === 'completed') {
      where += ' AND i.status = ?';
      params.push(statusFilter);
    }
    return db.prepare(`
      SELECT i.*, u.display_name as created_by_name, 0 AS starred,
        (SELECT COUNT(*) FROM sessions_v2 WHERE issue_id = i.id AND scope_type = 'issue' AND status = 'active') as session_count
      FROM issues i
      LEFT JOIN users u ON i.created_by = u.id
      WHERE ${where}
      ORDER BY i.last_active DESC
    `).all(...params) as IssueListRow[];
  },

  insert: ({ id, project_id, title, description, created_by, use_worktree, worktree_branch, visibility, is_planning }: IssueInsertArgs) => db.prepare(
    'INSERT INTO issues (id, project_id, title, description, created_by, status, use_worktree, worktree_branch, visibility, is_planning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, project_id, title, description, created_by, 'active',
    use_worktree ? 1 : 0, worktree_branch || '', visibility || 'inherit', is_planning ? 1 : 0),

  updateTitle: (id: string, title: string) => db.prepare('UPDATE issues SET title = ? WHERE id = ?').run(title, id),
  updateDescription: (id: string, desc: string) => db.prepare('UPDATE issues SET description = ? WHERE id = ?').run(desc, id),
  updateStatus: (id: string, status: IssueStatus) => db.prepare('UPDATE issues SET status = ? WHERE id = ?').run(status, id),
  updatePinned: (id: string, pinned: boolean) => db.prepare('UPDATE issues SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id),
  setStarred: (id: string, userId: string, starred: boolean): boolean => {
    const uid = String(userId || '').trim();
    if (!uid) return false;
    if (starred) {
      db.prepare(`
        INSERT INTO issue_user_stars (issue_id, user_id)
        VALUES (?, ?)
        ON CONFLICT(issue_id, user_id) DO NOTHING
      `).run(id, uid);
    } else {
      db.prepare(`
        DELETE FROM issue_user_stars
        WHERE issue_id = ? AND user_id = ?
      `).run(id, uid);
    }
    return true;
  },
  updateVisibility: (id: string, visibility: IssueVisibility) => db.prepare('UPDATE issues SET visibility = ? WHERE id = ?').run(visibility, id),
  markCompleted: (id: string) => db.prepare(
    "UPDATE issues SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(id),
  delete: (id: string) => db.prepare('DELETE FROM issues WHERE id = ?').run(id),

  updateSkillOverrides: (id: string, { selected, excluded }: { selected?: string[]; excluded?: string[] }) => db.prepare(
    'UPDATE issues SET selected_skills = ?, excluded_skills = ? WHERE id = ?'
  ).run(JSON.stringify(selected || []), JSON.stringify(excluded || []), id),

  touchActiveAndIncrement: (id: string) => db.prepare(
    "UPDATE issues SET last_active = strftime('%Y-%m-%dT%H:%M:%fZ','now'), message_count = message_count + 1 WHERE id = ?"
  ).run(id),

  listIdsForProject: (projectId: string): Array<{ id: string }> => db.prepare('SELECT id FROM issues WHERE project_id = ?').all(projectId) as Array<{ id: string }>,
};

const IssueIntegrations = {
  findByIssue: (issueId: string): IssueIntegrationRow | undefined => db.prepare('SELECT * FROM issue_integrations WHERE issue_id = ?').get(issueId) as IssueIntegrationRow | undefined,

  conflictCounts: (issueId: string): { internal_count: number; external_count: number; blocking_count: number } | undefined => db.prepare(`
    SELECT
      SUM(CASE WHEN lc.issue_id = rc.issue_id THEN 1 ELSE 0 END) as internal_count,
      SUM(CASE WHEN lc.issue_id != rc.issue_id THEN 1 ELSE 0 END) as external_count,
      SUM(CASE WHEN c.severity = 'blocking' THEN 1 ELSE 0 END) as blocking_count
    FROM session_conflicts c
    JOIN session_changes lc ON c.left_change_id = lc.id
    JOIN session_changes rc ON c.right_change_id = rc.id
    WHERE c.status = 'open' AND (lc.issue_id = ? OR rc.issue_id = ?)
  `).get(issueId, issueId) as { internal_count: number; external_count: number; blocking_count: number } | undefined,

  changeStats: (issueId: string): { total: number; ready_count: number; conflict_count: number; failed_count: number } | undefined => db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready_count,
      SUM(CASE WHEN status = 'conflict' THEN 1 ELSE 0 END) as conflict_count,
      SUM(CASE WHEN check_status = 'failed' THEN 1 ELSE 0 END) as failed_count
    FROM session_changes WHERE issue_id = ?
  `).get(issueId) as { total: number; ready_count: number; conflict_count: number; failed_count: number } | undefined,

  upsert: ({ id, issueId, projectId, status, internal, external, buildStatus }: {
    id: string;
    issueId: string;
    projectId: string;
    status: string;
    internal: number;
    external: number;
    buildStatus: string;
  }) => db.prepare(`
    INSERT INTO issue_integrations (id, issue_id, project_id, status, internal_conflict_count, external_conflict_count, build_status, acceptance_status, release_note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(issue_id) DO UPDATE SET
      status = excluded.status,
      internal_conflict_count = excluded.internal_conflict_count,
      external_conflict_count = excluded.external_conflict_count,
      build_status = excluded.build_status,
      updated_at = excluded.updated_at
  `).run(id, issueId, projectId, status, internal, external, buildStatus),

  setAcceptance: (issueId: string, acceptance: string, status: string, releaseNote: string | null) => db.prepare(`
    UPDATE issue_integrations SET acceptance_status = ?, status = ?, release_note = COALESCE(?, release_note), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE issue_id = ?
  `).run(acceptance, status, releaseNote, issueId),

  markIntegrated: (issueId: string) => db.prepare(
    "UPDATE issue_integrations SET status = 'integrated', integrated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE issue_id = ?"
  ).run(issueId),

  countAcceptancePending: (projectId: string): number => (db.prepare(
    "SELECT COUNT(*) AS c FROM issue_integrations WHERE project_id = ? AND acceptance_status = 'pending'"
  ).get(projectId) as { c: number }).c,

  countReady: (projectId: string): number => (db.prepare(
    "SELECT COUNT(*) AS c FROM issue_integrations WHERE project_id = ? AND status = 'ready'"
  ).get(projectId) as { c: number }).c,

  integratedListForProject: (projectId: string): Array<{ title: string; release_note: string | null; integrated_at: string | null; summary: string | null; change_id: string }> => db.prepare(`
    SELECT i.title, ii.release_note, ii.integrated_at, sc.summary, sc.id as change_id
    FROM issue_integrations ii
    JOIN issues i ON ii.issue_id = i.id
    LEFT JOIN session_changes sc ON sc.issue_id = i.id
    WHERE ii.project_id = ? AND ii.status = 'integrated'
    ORDER BY ii.integrated_at DESC
  `).all(projectId) as Array<{ title: string; release_note: string | null; integrated_at: string | null; summary: string | null; change_id: string }>,

  integratedFilesForProject: (projectId: string): Array<{ file_path: string; risk_level: string }> => db.prepare(`
    SELECT DISTINCT f.file_path, f.risk_level
    FROM session_change_files f
    JOIN session_changes sc ON f.change_id = sc.id
    JOIN issue_integrations ii ON sc.issue_id = ii.issue_id
    WHERE ii.project_id = ? AND ii.status = 'integrated'
    ORDER BY f.file_path
  `).all(projectId) as Array<{ file_path: string; risk_level: string }>,
};

export { Issues, IssueIntegrations };
