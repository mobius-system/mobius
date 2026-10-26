const assert = require('assert');
const Database = require('better-sqlite3');
const { createRemoteDeviceNamesStore, remoteDeviceNameKey } = require('../backend/services/remote-device-name-store');

const database = new Database(':memory:');
database.exec(`
  CREATE TABLE remote_device_names (
    user_id TEXT NOT NULL,
    device_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (user_id, device_key)
  );
`);
const names = createRemoteDeviceNamesStore(database);

assert.strictEqual(
  remoteDeviceNameKey('tui-dsw-881751-7944cb9d5-s8mpw-d342490fcc'),
  'host:dsw-881751-7944cb9d5-s8mpw',
);
assert.strictEqual(
  remoteDeviceNameKey('gui-dsw-881751-7944cb9d5-s8mpw-112233aabb'),
  'host:dsw-881751-7944cb9d5-s8mpw',
);
assert.strictEqual(remoteDeviceNameKey('remote-worker'), 'id:remote-worker');

const tuiId = 'tui-dsw-881751-7944cb9d5-s8mpw-d342490fcc';
const guiId = 'gui-dsw-881751-7944cb9d5-s8mpw-112233aabb';
assert.deepStrictEqual(names.setForUser('user-a', tuiId, 'DSW任务机'), {
  'host:dsw-881751-7944cb9d5-s8mpw': 'DSW任务机',
});
assert.strictEqual(names.listForUser('user-b')['host:dsw-881751-7944cb9d5-s8mpw'], undefined);
assert.strictEqual(names.setForUser('user-a', guiId, 'DSW算力机')['host:dsw-881751-7944cb9d5-s8mpw'], 'DSW算力机');
assert.strictEqual(names.setForUser('user-a', guiId, '')['host:dsw-881751-7944cb9d5-s8mpw'], undefined);
assert.strictEqual(names.listForUser('user-b')['host:dsw-881751-7944cb9d5-s8mpw'], undefined);

database.close();
console.log('ok - TUI/GUI identifiers share per-user hostname aliases; ordinary remotes remain ID-scoped');
