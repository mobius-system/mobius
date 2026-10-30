/**
 * Installer + CLI contract tests.
 *
 * Every Mobius CLI is HTTP-only and takes its address and credential from the
 * session environment (MOBIUS_BASE / MOBIUS_CLI_JWT). There is no .env lookup,
 * no local database path and no JWT helper any more, so this test pins:
 *   - what the installer puts on disk
 *   - that every command answers -h/--help
 *   - that HTTP commands refuse to run without the session environment
 *   - that display_files / display_images stay no-ops that need nothing
 *
 * Per-command HTTP behaviour is covered by session-jobs-cli.js and
 * session-reminder-hook.js.
 *
 * Run: node tests/mobius-cli.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const mobiusRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(mobiusRoot, 'scripts');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-cli-test-'));
const binDir = path.join(tempRoot, 'bin');

function run(command, args = [], options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    cwd: options.cwd || tempRoot,
  });
}

const CLEAN_ENV = {
  MOBIUS_BASE: '',
  MOBIUS_CLI_JWT: '',
  MOBIUS_SESSION_ID: '',
  MOBIUS_USER_ID: '',
  MOBIUS_APP_DIR: '',
  MOBIUS_ROOT: '',
  DB_PATH: '',
  MOBIUS_JWT_HELPER: '',
};

function main() {
  const install = run('bash', [path.join(sourceRoot, 'install-mobius-cli.bash')], { env: { PREFIX: binDir } });
  assert.strictEqual(install.status, 0, install.stderr);

  const installed = [
    'multiagent_send', 'declare_job_done', 'declare_job_failed',
    'research_blackboard_read', 'research_blackboard_write',
    'display_files', 'display_images', 'mobius_session_reminder',
    'mobius_schedule_wake_me_up', 'mobius_schedule_list', 'mobius_schedule_cancel_all',
    'make_file_public_access',
    '.research_blackboard_cli', '.mobius_schedule_cli', '.make_file_public_access_cli',
  ];
  for (const name of installed) {
    assert.strictEqual(fs.statSync(path.join(binDir, name)).mode & 0o777, 0o755, `${name} must be executable`);
  }
  assert.strictEqual(fs.existsSync(path.join(binDir, 'generate_localhost_jwt')), false,
    'the JWT helper is gone: every CLI uses the session token');
  assert.strictEqual(fs.existsSync(path.join(binDir, '.mobius-cli-app-dir')), false,
    'no APP_DIR marker is installed any more');

  for (const name of installed.filter((n) => !n.startsWith('.'))) {
    for (const flag of ['-h', '--help']) {
      const help = run(path.join(binDir, name), [flag]);
      assert.strictEqual(help.status, 0, `${name} ${flag}: ${help.stderr}`);
      assert.match(help.stdout, /Usage:/, `${name} ${flag} prints usage`);
      assert.match(help.stdout, /-h, --help/, `${name} ${flag} lists -h, --help`);
    }
  }

  // 无会话环境时 HTTP CLI 明确失败; 两个 DUMMY 命令照常工作
  const httpCommands = [
    ['declare_job_done', ['session-1']],
    ['declare_job_failed', ['session-1', 'reason']],
    ['mobius_schedule_list', []],
    ['mobius_schedule_cancel_all', ['--session-id', 'session-1']],
    ['multiagent_send', ['self', 'target', 'hello']],
    ['research_blackboard_read', ['--from=a', '--research=b']],
    ['research_blackboard_write', ['--from=a', '--research=b', 'content']],
    ['mobius_session_reminder', []],
  ];
  for (const [name, args] of httpCommands) {
    const result = run(path.join(binDir, name), args, { env: CLEAN_ENV });
    assert.strictEqual(result.status, 3, `${name} must exit 3 without the session environment: ${result.stderr}`);
    assert.match(result.stderr, /MOBIUS_BASE and MOBIUS_CLI_JWT|MOBIUS_BASE is unset|MOBIUS_CLI_JWT is unset/,
      `${name} names the missing variable`);
  }

  assert.strictEqual(run(path.join(binDir, 'display_files'), ['/tmp/a.py'], { env: CLEAN_ENV }).status, 0);
  assert.strictEqual(run(path.join(binDir, 'display_files'), [], { env: CLEAN_ENV }).status, 2);
  assert.strictEqual(run(path.join(binDir, 'display_images'), ['/tmp/a.png'], { env: CLEAN_ENV }).status, 0);
  assert.strictEqual(run(path.join(binDir, 'display_images'), ['relative.png'], { env: CLEAN_ENV }).status, 2);

  // 参数校验仍然在发请求之前拦下
  for (const bad of ['../escape', 'a/b', '']) {
    const result = run(path.join(binDir, 'declare_job_done'), [bad].filter(Boolean), { env: CLEAN_ENV });
    assert.ok(result.status === 2 || result.status === 3, `bad id ${JSON.stringify(bad)} rejected before any request`);
  }

  const scheduleHelp = run(path.join(binDir, 'mobius_schedule_wake_me_up'), ['--help']);
  assert.match(scheduleHelp.stdout, /--interval-time/);
  assert.match(run(path.join(binDir, 'mobius_schedule_list'), ['--help']).stdout, /--json/);
  assert.match(run(path.join(binDir, 'mobius_schedule_cancel_all'), ['--help']).stdout, /--session-id/);
  assert.match(run(path.join(binDir, 'declare_job_failed'), ['--help']).stdout, /failure_reason/);

  // 静态分享 CLI: 参数齐全但没有会话环境时必须先失败在配置上, 不能发请求
  const shareHelp = run(path.join(binDir, 'make_file_public_access'), ['--help']);
  assert.match(shareHelp.stdout, /--at-dir/);
  assert.match(shareHelp.stdout, /--file-name/);
  assert.match(shareHelp.stdout, /--expire/);
  const sampleFile = path.join(tempRoot, 'sample.txt');
  fs.writeFileSync(sampleFile, 'hello');
  const shareNoEnv = run(path.join(binDir, 'make_file_public_access'), ['--path', sampleFile], { env: CLEAN_ENV });
  assert.strictEqual(shareNoEnv.status, 3, `make_file_public_access must exit 3 without the session environment: ${shareNoEnv.stderr}`);
  assert.match(shareNoEnv.stderr, /MOBIUS_BASE is unset|MOBIUS_CLI_JWT is unset/);
  const shareMissingFile = run(path.join(binDir, 'make_file_public_access'), ['--path', path.join(tempRoot, 'nope.txt')], { env: CLEAN_ENV });
  assert.strictEqual(shareMissingFile.status, 2);
  const shareBadName = run(path.join(binDir, 'make_file_public_access'), ['--path', sampleFile, '--file-name', 'a..b'], { env: CLEAN_ENV });
  assert.strictEqual(shareBadName.status, 2);

  console.log('mobius cli contract: ok');
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

main();
