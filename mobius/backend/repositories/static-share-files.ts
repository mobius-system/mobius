/*
 * static-share-files.ts — metadata repository for shared static pages / files.
 *
 * The bytes live under MOBIUS_DATA_PATH/static_share/<owner_dir>/..., the row is
 * the single source of truth for ownership, scope and expiry. Routes must always
 * resolve a request through this table, never by joining the URL onto disk.
 */
import { db } from '../../db';

export type StaticShareScope = 'private' | 'public';

export interface StaticShareFileRow {
  id: string;
  owner_id: string;
  owner_name: string;
  file_path: string;
  file_name: string;
  rel_path: string;
  storage_rel: string;
  size_bytes: number;
  mime_type: string;
  scope: StaticShareScope;
  expires_at: string;
  created_at: string;
}

export interface CreateStaticShareInput {
  id: string;
  ownerId: string;
  ownerName: string;
  filePath: string;
  fileName: string;
  relPath: string;
  storageRel: string;
  sizeBytes: number;
  mimeType: string;
  scope: StaticShareScope;
  expiresAt: string;
}

interface RepoError extends Error {
  status: number;
}

function repoError(message: string, status = 400): RepoError {
  const err = new Error(message) as RepoError;
  err.status = status;
  return err;
}

function isUniqueViolation(err: unknown): boolean {
  const code = String((err as { code?: string } | null)?.code || '');
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

export const StaticShareFiles = {
  /* Insert one row. Unique indexes turn duplicate path/name into a 409 instead of a race. */
  create(input: CreateStaticShareInput): StaticShareFileRow {
    try {
      // ✨ 唯一索引在这里兜底, 先查后写会有并发窗口
      // ✨ The unique indexes decide duplicates here; check-then-write would race
      db.prepare(`
        INSERT INTO static_share_files
          (id, owner_id, owner_name, file_path, file_name, rel_path, storage_rel,
           size_bytes, mime_type, scope, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id, input.ownerId, input.ownerName, input.filePath, input.fileName,
        input.relPath, input.storageRel, input.sizeBytes, input.mimeType,
        input.scope, input.expiresAt,
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw repoError('同名文件已存在, 请更换文件名或路径', 409);
      throw err;
    }
    const row = StaticShareFiles.findById(input.id);
    if (!row) throw repoError('写入分享记录失败', 500);
    return row;
  },

  findById(id: string): StaticShareFileRow | undefined {
    return db.prepare('SELECT * FROM static_share_files WHERE id = ?').get(id) as StaticShareFileRow | undefined;
  },

  /* Exact lookup inside one owner's namespace (used by upload pre-checks and private access). */
  findOwned(ownerId: string, filePath: string, fileName: string): StaticShareFileRow | undefined {
    return db.prepare(`
      SELECT * FROM static_share_files
      WHERE owner_id = ? AND file_path = ? AND file_name = ?
    `).get(ownerId, filePath, fileName) as StaticShareFileRow | undefined;
  },

  /* Public namespace is global: at most one public file per path/name across all users. */
  findPublic(filePath: string, fileName: string): StaticShareFileRow | undefined {
    return db.prepare(`
      SELECT * FROM static_share_files
      WHERE scope = 'public' AND file_path = ? AND file_name = ?
    `).get(filePath, fileName) as StaticShareFileRow | undefined;
  },

  listByOwner(ownerId: string): StaticShareFileRow[] {
    return db.prepare(`
      SELECT * FROM static_share_files WHERE owner_id = ?
      ORDER BY created_at DESC
    `).all(ownerId) as StaticShareFileRow[];
  },

  /* Owner-scoped delete: the WHERE clause is the authorization check. */
  deleteOwned(id: string, ownerId: string): StaticShareFileRow | undefined {
    const row = StaticShareFiles.findById(id);
    if (!row || row.owner_id !== ownerId) return undefined;
    db.prepare('DELETE FROM static_share_files WHERE id = ?').run(id);
    return row;
  },

  listExpired(nowIso: string): StaticShareFileRow[] {
    return db.prepare(`
      SELECT * FROM static_share_files WHERE expires_at <= ?
    `).all(nowIso) as StaticShareFileRow[];
  },

  deleteById(id: string): void {
    db.prepare('DELETE FROM static_share_files WHERE id = ?').run(id);
  },

  /* Quota accounting: rows already stored for one owner. */
  usage(ownerId: string): { files: number; bytes: number } {
    const row = db.prepare(`
      SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes
      FROM static_share_files WHERE owner_id = ?
    `).get(ownerId) as { files: number; bytes: number };
    return { files: Number(row.files) || 0, bytes: Number(row.bytes) || 0 };
  },
};
