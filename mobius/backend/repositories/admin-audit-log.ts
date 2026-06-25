import { db } from '../../db';
import type { AdminAuditLogRow } from '../types/rows';

function clampLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return 100;
  return Math.min(n, 500);
}

function clampOffset(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

interface RecordArgs {
  adminId: string;
  action: string;
  resourceType: string;
  resourceId: string;
}

interface ListArgs {
  limit?: unknown;
  offset?: unknown;
}

const AdminAuditLog = {
  record: ({ adminId, action, resourceType, resourceId }: RecordArgs): number | null => {
    const admin = String(adminId || '').trim();
    const act = String(action || '').trim();
    const type = String(resourceType || '').trim();
    const id = String(resourceId || '').trim();
    if (!admin || !act || !type || !id) return null;
    const info = db.prepare(`
      INSERT INTO admin_audit_log (admin_id, action, resource_type, resource_id, occurred_at)
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(admin, act, type, id);
    return info.lastInsertRowid as number;
  },

  list: ({ limit, offset }: ListArgs = {}): AdminAuditLogRow[] => db.prepare(`
    SELECT id, admin_id, action, resource_type, resource_id, occurred_at
    FROM admin_audit_log
    ORDER BY occurred_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(clampLimit(limit), clampOffset(offset)) as AdminAuditLogRow[],

  count: (): number => (db.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').get() as { count: number } | undefined)?.count || 0,
};

export { AdminAuditLog };
