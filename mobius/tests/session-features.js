const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  allowlistedDiffFiles,
  featureJsonlPathOf,
  gitDiffForFiles,
  listBashCommands,
  normalizeDiffMode,
  normalizeFeaturePath,
  scanSessionFeatures,
  summarizeFileChanges,
} = require('../backend/services/session-features');

function appendJsonl(filePath, entry) {
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

function runGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-session-features-'));
const projectRoot = path.join(tmp, 'repo');
fs.mkdirSync(projectRoot, { recursive: true });
const jsonlPath = path.join(tmp, 'sample.jsonl');

appendJsonl(jsonlPath, {
  timestamp: '2026-06-14T00:00:00.000Z',
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'exec_command',
    arguments: JSON.stringify({
      cmd: 'npm run build',
      workdir: projectRoot,
      justification: 'Build frontend',
    }),
    call_id: 'call-1',
  },
});
appendJsonl(jsonlPath, {
  timestamp: '2026-06-14T00:00:01.000Z',
  type: 'event_msg',
  payload: {
    type: 'patch_apply_end',
    success: true,
    changes: {
      [path.join(projectRoot, 'src/app.ts')]: { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new\n' },
    },
  },
});
appendJsonl(jsonlPath, {
  timestamp: '2026-06-14T00:00:02.000Z',
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 'tool-bash',
        name: 'Bash',
        input: {
          command: 'node -c server.js',
          description: 'Syntax check backend',
        },
      },
      {
        type: 'tool_use',
        id: 'tool-edit',
        name: 'Edit',
        input: {
          file_path: path.join(projectRoot, 'server.js'),
          old_string: 'old',
          new_string: 'new',
        },
      },
    ],
  },
});

let scanned = scanSessionFeatures(jsonlPath);
assert.strictEqual(scanned.appended, 4);
assert.ok(fs.existsSync(featureJsonlPathOf(jsonlPath)));

let commands = listBashCommands(scanned.entries);
assert.deepStrictEqual(commands.map((cmd) => cmd.command), ['npm run build', 'node -c server.js']);
assert.strictEqual(commands[0].description, 'Build frontend');
assert.strictEqual(commands[1].description, 'Syntax check backend');

let files = summarizeFileChanges(scanned.entries, { workDir: projectRoot, gitRoot: projectRoot });
assert.deepStrictEqual(files.map((file) => file.display_path), ['server.js', 'src/app.ts']);

appendJsonl(jsonlPath, {
  timestamp: '2026-06-14T00:00:03.000Z',
  type: 'response_item',
  payload: {
    type: 'custom_tool_call',
    status: 'completed',
    name: 'apply_patch',
    input: `*** Begin Patch
*** Add File: ${path.join(projectRoot, 'README.md')}
+hello
*** End Patch
`,
  },
});

scanned = scanSessionFeatures(jsonlPath);
assert.strictEqual(scanned.appended, 1);
assert.ok(scanned.scanned_from_offset > 0);
files = summarizeFileChanges(scanned.entries, { workDir: projectRoot, gitRoot: projectRoot });
assert.deepStrictEqual(files.map((file) => file.display_path), ['README.md', 'server.js', 'src/app.ts']);

scanned = scanSessionFeatures(jsonlPath);
assert.strictEqual(scanned.appended, 0);

runGit(projectRoot, ['init']);
runGit(projectRoot, ['config', 'user.email', 'test@example.com']);
runGit(projectRoot, ['config', 'user.name', 'Mobius Test']);
fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'src/app.ts'), 'old\n');
runGit(projectRoot, ['add', 'src/app.ts']);
runGit(projectRoot, ['commit', '-m', 'init']);
fs.writeFileSync(path.join(projectRoot, 'src/app.ts'), 'committed\n');
runGit(projectRoot, ['add', 'src/app.ts']);
runGit(projectRoot, ['commit', '-m', 'change app']);
fs.writeFileSync(path.join(projectRoot, 'current-only.txt'), 'current\n');
runGit(projectRoot, ['add', 'current-only.txt']);
runGit(projectRoot, ['commit', '-m', 'add current-only']);
fs.writeFileSync(path.join(projectRoot, 'src/app.ts'), 'working\n');
runGit(projectRoot, ['add', 'src/app.ts']);
fs.writeFileSync(path.join(projectRoot, 'src/app.ts'), 'unstaged\n');

assert.strictEqual(normalizeDiffMode(undefined), 'unstaged');
assert.strictEqual(normalizeDiffMode('unstaged'), 'unstaged');
assert.strictEqual(normalizeDiffMode('staged'), 'staged');
for (const invalidMode of ['last_commit', 'last_two_commits', 'auto', 'STAGED']) {
  assert.throws(
    () => normalizeDiffMode(invalidMode),
    (error) => error && error.status === 400 && /非法 diff mode/.test(error.message),
    `mode ${invalidMode} must be rejected as HTTP 400`,
  );
}

const allowlist = [{
  path: 'src/app.ts',
  display_path: 'src/app.ts',
  original_paths: [path.join(projectRoot, 'src/app.ts')],
}];
assert.deepStrictEqual(allowlistedDiffFiles(allowlist, ['src/app.ts']), ['src/app.ts']);
assert.deepStrictEqual(allowlistedDiffFiles(allowlist, [path.join(projectRoot, 'src/app.ts')]), ['src/app.ts']);
assert.throws(
  () => allowlistedDiffFiles(allowlist, ['src/app.ts', '../outside.ts']),
  (error) => error && error.status === 400 && /不在当前 Session/.test(error.message),
  'one path outside the Session allowlist must reject the entire request as HTTP 400',
);

const statusBeforeReads = runGit(projectRoot, ['status', '--porcelain=v1']);
const headBeforeReads = runGit(projectRoot, ['rev-parse', 'HEAD']).trim();

const unstaged = gitDiffForFiles(projectRoot, ['src/app.ts'], 'unstaged');
assert.strictEqual(unstaged.diffs.length, 1);
assert.strictEqual(unstaged.mode, 'unstaged');
assert.ok(unstaged.diffs[0].diff.includes('+unstaged'));
assert.ok(!unstaged.diffs[0].diff.includes('+working'));

const staged = gitDiffForFiles(projectRoot, ['src/app.ts'], 'staged');
assert.strictEqual(staged.diffs.length, 1);
assert.strictEqual(staged.mode, 'staged');
assert.ok(staged.diffs[0].diff.includes('+working'));
assert.ok(!staged.diffs[0].diff.includes('+unstaged'));

const noCurrentDiff = gitDiffForFiles(projectRoot, ['current-only.txt'], 'unstaged');
assert.strictEqual(noCurrentDiff.diffs[0].mode, 'unstaged');
assert.strictEqual(noCurrentDiff.diffs[0].diff, null);
assert.strictEqual(noCurrentDiff.diffs[0].fallback_content, 'current\n');

assert.throws(
  () => gitDiffForFiles(projectRoot, ['src/app.ts'], 'last_commit'),
  (error) => error && error.status === 400,
  'commit history modes must not be accepted by the working-tree diff service',
);
assert.strictEqual(runGit(projectRoot, ['status', '--porcelain=v1']), statusBeforeReads, 'read-only diff calls must not modify worktree or index');
assert.strictEqual(runGit(projectRoot, ['rev-parse', 'HEAD']).trim(), headBeforeReads, 'read-only diff calls must not modify HEAD');

const nestedWorkDir = path.join(projectRoot, 'local_data', 'workspace', 'admin', 'garden');
fs.mkdirSync(nestedWorkDir, { recursive: true });
fs.writeFileSync(path.join(nestedWorkDir, 'note.md'), 'research note\n');
const duplicateChanges = Array.from({ length: 8 }, (_, index) => ({
  feature_type: 'file_change',
  file_path: 'note.md',
  timestamp: `2026-06-14T00:00:0${index}.000Z`,
  source: 'codex.patch_apply_end',
}));
const nestedFiles = summarizeFileChanges(duplicateChanges, { workDir: nestedWorkDir, gitRoot: projectRoot });
assert.strictEqual(nestedFiles[0].count, 8, 'same path must keep change count after existence cache');
assert.deepStrictEqual(nestedFiles.map((file) => file.display_path), ['local_data/workspace/admin/garden/note.md']);
const nestedDiff = gitDiffForFiles(nestedWorkDir, [nestedFiles[0].path], 'unstaged');
assert.strictEqual(nestedDiff.diffs.length, 1);
assert.strictEqual(nestedDiff.diffs[0].ok, true);
assert.strictEqual(nestedDiff.diffs[0].fallback_content, 'research note\n');
assert.strictEqual(nestedDiff.diffs[0].error, null);

const sandboxResolved = normalizeFeaturePath('/workspace/garden/note.md', {
  workDir: nestedWorkDir,
  gitRoot: projectRoot,
});
assert.strictEqual(sandboxResolved.absolute_path, path.join(nestedWorkDir, 'note.md'));
assert.strictEqual(sandboxResolved.display_path, 'local_data/workspace/admin/garden/note.md');
assert.strictEqual(sandboxResolved.outside_workspace, false);

const missingNested = gitDiffForFiles(nestedWorkDir, ['local_data/workspace/admin/garden/missing.md'], 'unstaged');
assert.strictEqual(missingNested.diffs[0].ok, false);
assert.match(missingNested.diffs[0].error, /当前工作区已找不到这个文件/);

const sessionsRouteSource = fs.readFileSync(path.join(__dirname, '../backend/routes/sessions.ts'), 'utf8');
const workspaceSource = fs.readFileSync(path.join(__dirname, '../backend/services/workspace.ts'), 'utf8');
const sessionFeaturesSource = fs.readFileSync(path.join(__dirname, '../backend/services/session-features.ts'), 'utf8');
assert.match(workspaceSource, /timeout:\s*5000/, 'gitTopLevel must time out instead of hanging spawnSync');
assert.match(workspaceSource, /GIT_TIMEOUT|检测 Git 仓库超时/, 'git probe timeout must become a retryable error');
assert.match(sessionFeaturesSource, /existsCache[\s\S]*normalizedCache/, 'summarizeFileChanges must cache path existence and normalization');
assert.doesNotMatch(sessionFeaturesSource, /highlightAuto|git status|git add|git commit/, 'feature summarize must not scan the whole repo or write git');

const filesRouteStart = sessionsRouteSource.indexOf("router.get('/:id/features/files'");
const filesRouteEnd = sessionsRouteSource.indexOf("\n});", filesRouteStart);
const filesRoute = sessionsRouteSource.slice(filesRouteStart, filesRouteEnd + 5);
assert.match(filesRoute, /scanSessionFeatures\(jsonlPath\)/, 'files feature route must scan Session JSONL only');
assert.match(filesRoute, /summarizeFileChanges\(scanned\.entries/, 'files feature route must summarize JSONL file features');
assert.doesNotMatch(filesRoute, /gitDiffForFiles|git status|git add|git commit/, 'files list must not run git status/diff or write git');
assert.match(
  sessionsRouteSource,
  /gitTopLevel\(workspace\.workDir\)[\s\S]*error: \(e as Error\)\.message/,
  'git probe timeout must surface as workspace_error, not be swallowed',
);

const gitDiffRouteStart = sessionsRouteSource.indexOf("router.get('/:id/features/git-diff'");
const gitDiffRouteEnd = sessionsRouteSource.indexOf("\n});", gitDiffRouteStart);
const gitDiffRoute = sessionsRouteSource.slice(gitDiffRouteStart, gitDiffRouteEnd + 5);
assert.match(gitDiffRoute, /normalizeDiffMode\(req\.query\.mode\)[\s\S]*res\.status\(400\)/, 'illegal route mode must return HTTP 400');
assert.match(gitDiffRoute, /allowlistedDiffFiles\(files, requested\)[\s\S]*res\.status\(400\)/, 'route must enforce the complete Session path allowlist');
assert.match(gitDiffRoute, /gitDiffForFiles\([\s\S]*targetFiles,[\s\S]*mode/, 'route must pass the explicit allowlisted mode to the read-only service');

console.log('session-features ok');
