const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-aimux-test-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/*
 * Bundle production modules with only Electron's userData path substituted.
 * The supervisor still launches real detached processes and reads real files.
 */
function load(source) {
  const target = path.join(temp, path.basename(source) + '.cjs');
  const bundled = buildSync({ entryPoints: [path.resolve(__dirname, '../electron/lib', source)], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false });
  fs.writeFileSync(target, bundled.outputFiles[0].text.replace(/require\("electron"\)/g, `({app:{getPath:()=>${JSON.stringify(temp)}}})`));
  return require(target);
}
const { AimuxSupervisor } = load('aimux-supervisor.ts');
const runtime = path.join(temp, 'runtime', 'test.json');
const mock = path.join(temp, 'aimux');
const starts = path.join(temp, 'starts.jsonl');
fs.writeFileSync(mock, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--silent-v2 --watchdog-timeout --enable-gui --gui-no-elevate'); process.exit(0); }
const file = args[args.indexOf('--runtime') + 1];
fs.appendFileSync(${JSON.stringify(starts)}, JSON.stringify({pid:process.pid,args})+'\\n');
setTimeout(() => { const state=JSON.parse(fs.readFileSync(file)); fs.writeFileSync(file,JSON.stringify({...state,pid:process.pid})); }, 150);
setInterval(() => {}, 1000);
`, { mode: 0o700 });
let connected = false;
let authError = false;
let refreshes = 0;
const statuses = [];
const options = {
  aimuxExe: mock, bridgeUrl: 'https://test.invalid/aimux_bridge', identifier: 'desktop-test', token: 'old-token', runtimePath: runtime,
  onStatus: s => statuses.push(s), probeBridgeConnection: async () => ({ connected, authError }),
  onTokenExpired: async () => { refreshes++; authError = false; return 'new-token'; },
  heartbeatIntervalMs: 30, spawnGraceMs: 50,
};
const readStarts = () => fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').trim().split('\n').map(JSON.parse) : [];
async function until(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await delay(25);
  assert.ok(predicate(), 'condition reached before timeout');
}

(async () => {
  let first, second;
  try {
    first = new AimuxSupervisor(options);
    await first.start();
    await until(() => readStarts().length === 1 && JSON.parse(fs.readFileSync(runtime)).pid);
    const initialPid = readStarts()[0].pid;
    const initialFeed = JSON.parse(fs.readFileSync(runtime)).last_feed_watchdog;
    await delay(5200);
    assert.equal(readStarts().length, 1, 'bridge outage and delayed runtime do not duplicate a live daemon');
    assert.ok(JSON.parse(fs.readFileSync(runtime)).last_feed_watchdog > initialFeed, 'watchdog keeps feeding after bridge probes');
    connected = true;
    await until(() => statuses.at(-1)?.state === 'connected');
    await first.stop(false);
    assert.ok(alive(initialPid), 'normal app exit leaves daemon to watchdog');
    const stoppedFeed = JSON.parse(fs.readFileSync(runtime)).last_feed_watchdog;
    await delay(100);
    assert.equal(JSON.parse(fs.readFileSync(runtime)).last_feed_watchdog, stoppedFeed, 'stop cancels future writes');
    second = new AimuxSupervisor(options);
    await second.start();
    assert.equal(readStarts().length, 1, 'new supervisor adopts existing daemon');
    connected = false;
    authError = true;
    await until(() => readStarts().length === 2);
    assert.equal(refreshes, 1, '401 refreshes credentials once');
    assert.ok(!alive(initialPid), 'old daemon exits before refreshed daemon starts');
    assert.ok(readStarts()[1].args.includes('new-token'), 'refreshed token reaches new daemon');
    await until(() => JSON.parse(fs.readFileSync(runtime)).pid === readStarts()[1].pid);
    await second.stop();
    assert.ok(!alive(readStarts()[1].pid), 'explicit disable stops daemon');
    assert.ok(!fs.existsSync(runtime), 'explicit stop removes stale runtime');
    const log = fs.readFileSync(path.join(temp, 'logs', 'aimux.log'), 'utf8');
    assert.ok(!log.includes('old-token') && !log.includes('new-token'), 'logs exclude credentials');
    console.log('PASS: detached startup, delayed runtime, watchdog renewal, live-daemon preservation, reuse, auth refresh, explicit stop');

    const crashing = path.join(temp, 'crashing-aimux');
    const crashStarts = path.join(temp, 'crashes');
    fs.writeFileSync(crashing, `#!${process.execPath}\nconst fs=require('node:fs'); if(!process.argv.includes('--help')) fs.appendFileSync(${JSON.stringify(crashStarts)},'attempt\\n');`, {mode:0o700});
    const failed = new AimuxSupervisor({...options, aimuxExe:crashing, heartbeatIntervalMs:25, spawnGraceMs:100});
    try {
      await failed.start();
      await until(() => statuses.at(-1)?.state === 'failed');
      await delay(250);
      assert.equal(fs.readFileSync(crashStarts,'utf8').trim().split('\n').length, 3, 'failed launches stop after three attempts');
    } finally { await failed.stop(); }
    console.log('PASS: repeated failed launches have a bounded retry budget');

    const python = load('python-runtime.ts');
    const venv = path.join(temp, 'aimux-venv');
    fs.mkdirSync(path.join(venv, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(venv, 'bin', 'aimux'), '');
    const versionFile = path.join(temp, 'version');
    const calls = path.join(temp, 'pip-calls');
    fs.writeFileSync(versionFile, '0.3.99');
    fs.writeFileSync(path.join(venv, 'bin', 'python'), `#!${process.execPath}
const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args.includes('--version')) console.log('Python 3.11');
else if(args.includes('-c')) console.log(fs.readFileSync(${JSON.stringify(versionFile)},'utf8'));
else if(args.includes('install')) { const pkg=args.find(a=>a.startsWith('aimux==')); fs.writeFileSync(${JSON.stringify(versionFile)},pkg ? pkg.slice(7) : '0.4.0'); }
`, { mode: 0o700 });
    let ready = await python.ensureAimux(undefined, undefined, '0.3.75');
    assert.equal(ready.version, '0.3.75', 'newer local version downgrades to broker');
    ready = await python.ensureAimux(undefined, undefined, '0.3.80');
    assert.equal(ready.version, '0.3.80', 'older local version upgrades to broker');
    const before = fs.readFileSync(calls, 'utf8').split('\n').filter(l => l.includes('install')).length;
    await python.ensureAimux(undefined, undefined, '0.3.80');
    assert.equal(fs.readFileSync(calls, 'utf8').split('\n').filter(l => l.includes('install')).length, before, 'matching version avoids pip');
    assert.equal((await python.upgradeAimux()).version, '0.4.0');
    assert.match(fs.readFileSync(calls, 'utf8'), /--no-cache-dir.*--index-url.*https:\/\/pypi.org\/simple/, 'manual update uses uncached official index');
    const realFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({version:'0.3.75'}));
    assert.equal(await python.fetchAimuxTarget('https://test.invalid', 'token'), '0.3.75');
    global.fetch = async () => { throw new Error('offline'); };
    assert.equal(await python.fetchAimuxTarget('https://test.invalid', 'token'), '0.3.72');
    global.fetch = realFetch;
    console.log('PASS: broker alignment upgrades/downgrades, idempotent install, explicit latest update, offline pin');
  } finally {
    await first?.stop();
    await second?.stop();
    for (const record of readStarts()) if (alive(record.pid)) process.kill(record.pid, 'SIGKILL');
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
