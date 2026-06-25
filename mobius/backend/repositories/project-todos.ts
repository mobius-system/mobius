import { db } from '../../db';
import type { ProjectTodoRow } from '../types/rows';

interface ProjectTodoWithNamesRow extends ProjectTodoRow {
  created_by_name?: string;
  updated_by_name?: string | null;
}

function hydrate(row: ProjectTodoWithNamesRow | undefined): ProjectTodoWithNamesRow | undefined {
  if (!row) return row;
  return {
    ...row,
    completed: !!row.completed,
  };
}

function normalizeIds(ids: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

interface InsertArgs {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  completed?: boolean;
  sortOrder?: number;
  createdBy: string;
}

interface UpdatePatch {
  title?: string;
  description?: string;
  completed?: boolean;
  sortOrder?: number;
}

const ProjectTodos = {
  findByIdForProject: (projectId: string, id: string): ProjectTodoWithNamesRow | undefined => hydrate(db.prepare(`
    SELECT pt.*, u.display_name as created_by_name, uu.display_name as updated_by_name
    FROM project_todos pt
    LEFT JOIN users u ON pt.created_by = u.id
    LEFT JOIN users uu ON pt.updated_by = uu.id
    WHERE pt.project_id = ? AND pt.id = ?
  `).get(projectId, id) as ProjectTodoWithNamesRow | undefined),

  listForProject: (projectId: string): ProjectTodoWithNamesRow[] => (db.prepare(`
    SELECT pt.*, u.display_name as created_by_name, uu.display_name as updated_by_name
    FROM project_todos pt
    LEFT JOIN users u ON pt.created_by = u.id
    LEFT JOIN users uu ON pt.updated_by = uu.id
    WHERE pt.project_id = ?
    ORDER BY pt.completed ASC, pt.sort_order ASC, pt.created_at ASC
  `).all(projectId) as ProjectTodoWithNamesRow[]).map(hydrate) as ProjectTodoWithNamesRow[],

  nextSortOrder: (projectId: string): number => {
    const row = db.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) + 1000 AS next_sort_order
      FROM project_todos
      WHERE project_id = ?
    `).get(projectId) as { next_sort_order: number } | undefined;
    return row?.next_sort_order || 1000;
  },

  insert: ({ id, projectId, title, description = '', completed = false, sortOrder, createdBy }: InsertArgs): ProjectTodoWithNamesRow | undefined => {
    const order = Number.isInteger(sortOrder) ? sortOrder! : ProjectTodos.nextSortOrder(projectId);
    db.prepare(`
      INSERT INTO project_todos (
        id, project_id, title, description, completed, sort_order,
        created_by, updated_by, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END)
    `).run(
      id,
      projectId,
      title,
      description || '',
      completed ? 1 : 0,
      order,
      createdBy,
      createdBy,
      completed ? 1 : 0,
    );
    return ProjectTodos.findByIdForProject(projectId, id);
  },

  update: (projectId: string, id: string, patch: UpdatePatch, updatedBy: string): ProjectTodoWithNamesRow | null => {
    const existing = ProjectTodos.findByIdForProject(projectId, id);
    if (!existing) return null;

    const fields: string[] = [];
    const params: Array<string | number> = [];
    if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
      fields.push('title = ?');
      params.push(patch.title!);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'description')) {
      fields.push('description = ?');
      params.push(patch.description || '');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'completed')) {
      fields.push('completed = ?');
      params.push(patch.completed ? 1 : 0);
      fields.push("completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE NULL END");
      params.push(patch.completed ? 1 : 0);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'sortOrder')) {
      fields.push('sort_order = ?');
      params.push(patch.sortOrder!);
    }

    if (fields.length === 0) return existing as ProjectTodoWithNamesRow;
    fields.push('updated_by = ?');
    params.push(updatedBy);
    fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    params.push(projectId, id);

    db.prepare(`
      UPDATE project_todos
      SET ${fields.join(', ')}
      WHERE project_id = ? AND id = ?
    `).run(...params);
    return ProjectTodos.findByIdForProject(projectId, id) ?? null;
  },

  delete: (projectId: string, id: string) => db.prepare(
    'DELETE FROM project_todos WHERE project_id = ? AND id = ?'
  ).run(projectId, id),

  reorder: (projectId: string, ids: unknown): ProjectTodoWithNamesRow[] => {
    const orderedIds = normalizeIds(ids);
    const existing = ProjectTodos.listForProject(projectId);
    const existingIds = new Set(existing.map((todo) => todo.id));
    const missing = orderedIds.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      throw new Error('待办排序包含不存在的项目');
    }

    const tx = db.transaction(() => {
      orderedIds.forEach((id, index) => {
        db.prepare(`
          UPDATE project_todos
          SET sort_order = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE project_id = ? AND id = ?
        `).run((index + 1) * 1000, projectId, id);
      });
    });
    tx();
    return ProjectTodos.listForProject(projectId);
  },
};

export { ProjectTodos };
