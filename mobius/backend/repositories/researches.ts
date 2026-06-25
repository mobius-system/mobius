import { db } from '../../db';
import type { ResearchRow } from '../types/rows';

type ResearchVisibility = 'inherit' | 'private' | 'team' | 'public' | 'allowlist';
type ResearchStatus = 'active' | 'completed';

interface ResearchWithProjectRow extends ResearchRow {
  project_name?: string;
  bind_path?: string;
  research_enabled?: number;
}

interface ResearchListRow extends ResearchRow {
  created_by_name?: string;
  session_count?: number;
  chief_count?: number;
}

interface InsertArgs {
  id: string;
  project_id: string;
  title: string;
  description?: string | null;
  created_by: string;
  visibility?: ResearchVisibility;
}

const Researches = {
  findById: (id: string): ResearchRow | undefined =>
    db.prepare('SELECT * FROM researches WHERE id = ?').get(id) as ResearchRow | undefined,

  findByIdWithProject: (id: string): ResearchWithProjectRow | undefined =>
    db.prepare(`
      SELECT r.*, p.name AS project_name, p.bind_path AS bind_path, p.research_enabled AS research_enabled
      FROM researches r
      LEFT JOIN projects p ON r.project_id = p.id
      WHERE r.id = ?
    `).get(id) as ResearchWithProjectRow | undefined,

  listForProject: (projectId: string, statusFilter?: ResearchStatus): ResearchListRow[] => {
    let where = 'r.project_id = ?';
    const params: Array<string> = [projectId];
    if (statusFilter === 'active' || statusFilter === 'completed') {
      where += ' AND r.status = ?';
      params.push(statusFilter);
    }
    return db.prepare(`
      SELECT r.*, u.display_name as created_by_name,
        (SELECT COUNT(*) FROM sessions_v2 WHERE research_id = r.id AND scope_type = 'research' AND status = 'active') as session_count,
        (SELECT COUNT(*) FROM sessions_v2 WHERE research_id = r.id AND scope_type = 'research' AND research_role = 'chief_researcher') as chief_count
      FROM researches r
      LEFT JOIN users u ON r.created_by = u.id
      WHERE ${where}
      ORDER BY r.last_active DESC
    `).all(...params) as ResearchListRow[];
  },

  insert: ({ id, project_id, title, description, created_by, visibility }: InsertArgs) =>
    db.prepare(
      'INSERT INTO researches (id, project_id, title, description, created_by, status, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, project_id, title, description || '', created_by, 'active', visibility || 'inherit'),

  updateTitle: (id: string, title: string) =>
    db.prepare('UPDATE researches SET title = ? WHERE id = ?').run(title, id),
  updateDescription: (id: string, desc: string) =>
    db.prepare('UPDATE researches SET description = ? WHERE id = ?').run(desc, id),
  updateStatus: (id: string, status: ResearchStatus) =>
    db.prepare('UPDATE researches SET status = ? WHERE id = ?').run(status, id),
  updatePinned: (id: string, pinned: boolean) =>
    db.prepare('UPDATE researches SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id),
  updateVisibility: (id: string, visibility: ResearchVisibility) =>
    db.prepare('UPDATE researches SET visibility = ? WHERE id = ?').run(visibility, id),

  markCompleted: (id: string) =>
    db.prepare("UPDATE researches SET status = 'completed' WHERE id = ?").run(id),

  touchActiveAndIncrement: (id: string) =>
    db.prepare(
      "UPDATE researches SET last_active = strftime('%Y-%m-%dT%H:%M:%fZ','now'), message_count = message_count + 1 WHERE id = ?"
    ).run(id),
};

export { Researches };
