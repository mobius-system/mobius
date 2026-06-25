import { db } from '../../db';

function audit(
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  detail: string = '',
): void {
  try {
    db.prepare(
      'INSERT INTO integration_audit_logs (actor_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?)'
    ).run(actorId, action, entityType, entityId, detail);
  } catch {}
}

export { audit };
