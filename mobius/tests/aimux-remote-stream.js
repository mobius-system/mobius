const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-aimux-stream-'));
  const fakeAimux = path.join(tempDir, 'aimux');
  fs.writeFileSync(fakeAimux, `#!/usr/bin/env node
const events = [
  { event: 'start', ssh_count: 1 },
  { event: 'remote', phase: 'discovered', remote: { name: 'worker-1', type: 'ssh', user: 'root', hostname: '10.0.0.2', port: 2222, status: 'probing', rtt_ms: null } },
  { event: 'remote', phase: 'result', remote: { name: 'worker-1', type: 'ssh', user: 'root', hostname: '10.0.0.2', port: 2222, status: 'reachable', rtt_ms: 12 } },
  { event: 'done', count: 1 },
];
let index = 0;
const emit = () => {
  if (index >= events.length) return;
  process.stdout.write(JSON.stringify(events[index++]) + '\\n');
  if (index < events.length) setTimeout(emit, 5);
};
emit();
`, { mode: 0o755 });

  process.env.AIMUX_BIN = fakeAimux;
  const aimuxRemote = require('../backend/services/aimux-remote');
  const events = [];
  await aimuxRemote.streamRemotes((event) => events.push(event));

  assert.deepStrictEqual(events.map((event) => event.event), ['start', 'remote', 'remote', 'done']);
  assert.strictEqual(events[1].phase, 'discovered');
  assert.strictEqual(events[1].remote.status, 'probing');
  assert.strictEqual(events[2].phase, 'result');
  assert.strictEqual(events[2].remote.status, 'reachable');
  assert.strictEqual(events[2].remote.rtt_ms, 12);
  assert.strictEqual(events[2].remote.port, 2222);

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('aimux remote stream service: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
