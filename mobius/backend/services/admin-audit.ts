import { AdminAuditLog } from '../repositories/admin-audit-log';

function recordAdminAuditIfCrossUser(
  user: any,
  action: string,
  resourceType: string,
  resourceId: string | number | null,
  ownerId: string | number | null,
): any {
  if (!user || user.role !== 'admin') return null;
  const owner = String(ownerId || '').trim();
  if (owner && owner === user.id) return null;
  try {
    return AdminAuditLog.record({
      adminId: user.id,
      action,
      resourceType,
      resourceId: String(resourceId ?? ''),
    });
  } catch (e) {
    console.warn(`[admin-audit] record failed: ${e.message}`);
    return null;
  }
}

export { recordAdminAuditIfCrossUser };
