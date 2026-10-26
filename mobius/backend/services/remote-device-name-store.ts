import type * as BetterSqlite3 from 'better-sqlite3';

export function remoteDeviceNameKey(deviceId: string): string {
  const normalizedId = deviceId.trim();
  const match = /^(?:tui|gui)-(.+)-[a-f0-9]{10}$/i.exec(normalizedId);
  return match ? `host:${match[1].toLowerCase()}` : `id:${normalizedId}`;
}

export function createRemoteDeviceNamesStore(database: Pick<BetterSqlite3.Database, 'prepare'>) {
  function listForUser(userId: string): Record<string, string> {
    const rows = database.prepare(`
      SELECT device_key, display_name
      FROM remote_device_names
      WHERE user_id = ?
      ORDER BY device_key
    `).all(userId) as Array<{ device_key: string; display_name: string }>;
    return Object.fromEntries(rows.map(row => [row.device_key, row.display_name]));
  }

  function setForUser(userId: string, deviceId: string, displayName: string): Record<string, string> {
    const deviceKey = remoteDeviceNameKey(deviceId);
    if (!displayName) {
      database.prepare('DELETE FROM remote_device_names WHERE user_id = ? AND device_key = ?').run(userId, deviceKey);
      return listForUser(userId);
    }
    database.prepare(`
      INSERT INTO remote_device_names (user_id, device_key, display_name)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, device_key) DO UPDATE SET
        display_name = excluded.display_name,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(userId, deviceKey, displayName);
    return listForUser(userId);
  }

  return { listForUser, setForUser };
}
