import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const FEATURE_SCHEMA_VERSION = 1;
const MAX_FEATURE_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_GIT_DIFF_BUFFER = 8 * 1024 * 1024;

function featureJsonlPathOf(jsonlPath: any): string | null {
  if (!jsonlPath || typeof jsonlPath !== 'string') return null;
  return jsonlPath.endsWith('.jsonl')
    ? jsonlPath.slice(0, -'.jsonl'.length) + '.feature.jsonl'
    : jsonlPath + '.feature.jsonl';
}

function parseJsonMaybe(raw: any): any {
  if (!raw || typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function timestampOf(entry: any): string | null {
  const candidates = [
    entry?.timestamp,
    entry?.created_at,
    entry?.payload?.timestamp,
    entry?.message?.created_at,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function timestampMs(value: any): number | null {
  const ms = new Date(value || '').getTime();
  return Number.isFinite(ms) ? ms : null;
}

function stringValue(value: any): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeToolName(value: any): string {
  return stringValue(value).toLowerCase();
}

function pushFileFeature(features: any[], entry: any, meta: any, source: string, filePath: any, extra: any = {}): void {
  const normalized = stringValue(filePath);
  if (!normalized) return;
  features.push({
    schema_version: FEATURE_SCHEMA_VERSION,
    feature_type: 'file_change',
    timestamp: timestampOf(entry),
    source,
    source_jsonl: meta.sourceJsonl,
    source_offset_start: meta.offsetStart,
    source_offset_end: meta.offsetEnd,
    source_line: meta.lineNo,
    item_index: features.length,
    file_path: normalized,
    ...extra,
  });
}

function pushBashFeature(features: any[], entry: any, meta: any, source: string, command: any, extra: any = {}): void {
  const normalized = typeof command === 'string' ? command : '';
  if (!normalized.trim()) return;
  features.push({
    schema_version: FEATURE_SCHEMA_VERSION,
    feature_type: 'bash_command',
    timestamp: timestampOf(entry),
    source,
    source_jsonl: meta.sourceJsonl,
    source_offset_start: meta.offsetStart,
    source_offset_end: meta.offsetEnd,
    source_line: meta.lineNo,
    item_index: features.length,
    command: normalized,
    ...extra,
  });
}

function filePathsFromPatchText(input: any): Array<{ filePath: string; change_type: string }> {
  if (typeof input !== 'string' || !input.includes('*** Begin Patch')) return [];
  const files: Array<{ filePath: string; change_type: string }> = [];
  for (const line of input.split('\n')) {
    const m = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+?)\s*$/);
    if (m) {
      files.push({ filePath: m[1], change_type: line.includes(' Add ') ? 'add' : line.includes(' Delete ') ? 'delete' : 'update' });
      continue;
    }
    const move = line.match(/^\*\*\* Move to: (.+?)\s*$/);
    if (move) files.push({ filePath: move[1], change_type: 'move' });
  }
  return files;
}

function extractCodexFunctionArgs(payload: any): any {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.arguments && typeof payload.arguments === 'string') return parseJsonMaybe(payload.arguments) || {};
  if (payload.input && typeof payload.input === 'string' && payload.input.trim().startsWith('{')) {
    return parseJsonMaybe(payload.input) || {};
  }
  if (payload.input && typeof payload.input === 'object') return payload.input;
  return {};
}

function extractFeaturesFromEntry(entry: any, meta: any): any[] {
  const features: any[] = [];

  if (entry?.type === 'event_msg' && entry?.payload?.type === 'patch_apply_end') {
    const changes = entry?.payload?.changes;
    if (entry?.payload?.success !== false && changes && typeof changes === 'object' && !Array.isArray(changes)) {
      for (const [filePath, change] of Object.entries(changes) as [string, any][]) {
        pushFileFeature(features, entry, meta, 'codex.patch_apply_end', filePath, {
          change_type: stringValue(change?.type) || null,
          move_path: stringValue(change?.move_path) || null,
        });
        if (stringValue(change?.move_path)) {
          pushFileFeature(features, entry, meta, 'codex.patch_apply_end.move_path', change.move_path, {
            change_type: 'move',
            move_path: null,
          });
        }
      }
    }
  }

  if (entry?.type === 'response_item' && entry?.payload && typeof entry.payload === 'object') {
    const payload = entry.payload;
    const toolName = normalizeToolName(payload.name);
    const args = extractCodexFunctionArgs(payload);

    if (toolName === 'exec_command' || toolName === 'shell_command' || toolName === 'run_terminal_cmd') {
      pushBashFeature(features, entry, meta, `codex.${toolName}`, args.cmd || args.command || args.script, {
        description: stringValue(args.description || args.justification || args.summary) || null,
        cwd: stringValue(args.workdir || args.cwd) || null,
        call_id: stringValue(payload.call_id) || null,
      });
    }

    if (toolName === 'apply_patch') {
      for (const item of filePathsFromPatchText(payload.input || args.patch || args.input)) {
        pushFileFeature(features, entry, meta, 'codex.apply_patch', item.filePath, {
          change_type: item.change_type,
        });
      }
    }
  }

  if (entry?.type === 'assistant' && Array.isArray(entry?.message?.content)) {
    for (const block of entry.message.content) {
      if (!block || block.type !== 'tool_use') continue;
      const name = normalizeToolName(block.name);
      const input = block.input && typeof block.input === 'object' ? block.input : {};

      if (name === 'bash') {
        pushBashFeature(features, entry, meta, 'claude.bash', input.command || input.cmd || input.script, {
          description: stringValue(input.description || input.summary) || null,
          cwd: stringValue(input.cwd || input.workdir) || stringValue(entry.cwd) || null,
          tool_use_id: stringValue(block.id) || null,
        });
        continue;
      }

      if (name === 'edit' || name === 'write' || name === 'multiedit' || name === 'notebookedit') {
        const filePath = input.file_path || input.path || input.notebook_path;
        pushFileFeature(features, entry, meta, `claude.${name}`, filePath, {
          change_type: name,
          tool_use_id: stringValue(block.id) || null,
        });
      }
    }
  }

  return features;
}

function featureKey(feature: any): string {
  const stable = [
    feature.feature_type,
    feature.source_jsonl,
    feature.source_offset_start,
    feature.item_index,
    feature.file_path || '',
    feature.command || '',
  ].join('');
  return stable;
}

function legacyFeatureKey(feature: any): string {
  return [
    feature.feature_type,
    feature.timestamp || '',
    feature.source || '',
    feature.file_path || '',
    feature.command || '',
  ].join('');
}

function readFeatureEntries(featurePath: any): any[] {
  if (!featurePath || !fs.existsSync(featurePath)) return [];
  const lines = fs.readFileSync(featurePath, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const parsed = parseJsonMaybe(line);
    if (parsed && typeof parsed === 'object') entries.push(parsed);
  }
  return entries;
}

function lastFeatureState(entries: any[]): { lastTimestamp: string | null; lastOffset: number } {
  let lastTimestamp = null;
  let lastOffset = 0;
  for (const entry of entries) {
    if (entry?.timestamp) lastTimestamp = entry.timestamp;
    const offset = Number(entry?.source_offset_end);
    if (Number.isFinite(offset) && offset > lastOffset) lastOffset = offset;
  }
  return { lastTimestamp, lastOffset };
}

function appendFeatureEntries(featurePath: string, entries: any[]): void {
  if (!entries.length) return;
  fs.mkdirSync(path.dirname(featurePath), { recursive: true });
  fs.appendFileSync(featurePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

function scanSourceBuffer(buffer: Buffer, sourceJsonl: string, startOffset: number, visitor: (entry: any, meta: any) => void): void {
  let lineStart = 0;
  let lineNo: number | null = startOffset === 0 ? 0 : null;
  for (let i = 0; i <= buffer.length; i++) {
    if (i < buffer.length && buffer[i] !== 10) continue;
    const raw = buffer.subarray(lineStart, i);
    const offsetStart = startOffset + lineStart;
    const offsetEnd = startOffset + Math.min(i + 1, buffer.length);
    lineStart = i + 1;
    if (raw.length === 0) continue;
    if (lineNo !== null) lineNo += 1;
    const entry = parseJsonMaybe(raw.toString('utf8'));
    if (!entry) continue;
    visitor(entry, {
      sourceJsonl,
      offsetStart,
      offsetEnd,
      lineNo,
    });
  }
}

function scanSessionFeatures(jsonlPath: any): any {
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    return {
      source_jsonl: jsonlPath || null,
      feature_jsonl: featureJsonlPathOf(jsonlPath),
      entries: [],
      appended: 0,
      scanned_from_offset: 0,
      reset: false,
    };
  }

  const featurePath = featureJsonlPathOf(jsonlPath);
  let existing = readFeatureEntries(featurePath);
  let { lastTimestamp, lastOffset } = lastFeatureState(existing);
  const stat = fs.statSync(jsonlPath);
  if (stat.size > MAX_FEATURE_SOURCE_BYTES) {
    throw new Error(`jsonl 文件超过特征扫描安全上限: ${stat.size} bytes`);
  }

  let reset = false;
  if (lastOffset > stat.size) {
    existing = [];
    lastTimestamp = null;
    lastOffset = 0;
    reset = true;
    if (featurePath) fs.writeFileSync(featurePath, '');
  }

  const startOffset = lastOffset > 0 ? lastOffset : 0;
  const length = Math.max(0, stat.size - startOffset);
  const fd = fs.openSync(jsonlPath, 'r');
  const buffer = Buffer.alloc(length);
  try {
    if (length > 0) fs.readSync(fd, buffer, 0, length, startOffset);
  } finally {
    try { fs.closeSync(fd); } catch {}
  }

  const known = new Set(existing.map(featureKey).concat(existing.map(legacyFeatureKey)));
  const lastMs = timestampMs(lastTimestamp);
  const appended: any[] = [];
  scanSourceBuffer(buffer, jsonlPath, startOffset, (entry, meta) => {
    const entryTs = timestampOf(entry);
    const entryMs = timestampMs(entryTs);
    const fallbackTimestampScan = startOffset === 0 && existing.length > 0 && lastMs !== null && entryMs !== null;
    if (fallbackTimestampScan && entryMs < lastMs) return;

    for (const feature of extractFeaturesFromEntry(entry, meta)) {
      const key = featureKey(feature);
      const legacyKey = legacyFeatureKey(feature);
      if (known.has(key) || known.has(legacyKey)) continue;
      feature.feature_key = key;
      known.add(key);
      known.add(legacyKey);
      appended.push(feature);
    }
  });

  appendFeatureEntries(featurePath || '', appended);
  return {
    source_jsonl: jsonlPath,
    feature_jsonl: featurePath,
    entries: existing.concat(appended),
    appended: appended.length,
    scanned_from_offset: startOffset,
    reset,
  };
}

function isWithinPath(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosix(value: any): string {
  return String(value || '').split(path.sep).join('/');
}

function normalizeFeaturePath(rawPath: any, workspace: any = {}): any {
  const original = stringValue(rawPath);
  if (!original) return null;
  const workDir = workspace.workDir ? path.resolve(workspace.workDir) : null;
  const gitRoot = workspace.gitRoot ? path.resolve(workspace.gitRoot) : null;
  const base = workDir || gitRoot || process.cwd();
  const abs = path.isAbsolute(original) ? path.resolve(original) : path.resolve(base, original);

  let rel = null;
  let outside = false;
  if (gitRoot && isWithinPath(gitRoot, abs)) {
    rel = path.relative(gitRoot, abs) || '.';
  } else if (workDir && isWithinPath(workDir, abs)) {
    rel = path.relative(workDir, abs) || '.';
  } else {
    outside = !!gitRoot || !!workDir;
    rel = path.isAbsolute(original) ? original : path.normalize(original);
  }

  return {
    original,
    absolute_path: abs,
    relative_path: toPosix(rel),
    display_path: toPosix(rel),
    outside_workspace: outside,
  };
}

function summarizeFileChanges(features: any[], workspace: any = {}): any[] {
  const byKey = new Map();
  for (const feature of features) {
    if (feature?.feature_type !== 'file_change') continue;
    const normalized = normalizeFeaturePath(feature.file_path, workspace);
    if (!normalized) continue;
    const key = normalized.relative_path || normalized.original;
    const current = byKey.get(key) || {
      path: key,
      display_path: normalized.display_path,
      original_paths: [],
      absolute_path: normalized.absolute_path,
      outside_workspace: normalized.outside_workspace,
      count: 0,
      first_timestamp: feature.timestamp || null,
      last_timestamp: feature.timestamp || null,
      sources: [],
    };
    current.count += 1;
    if (!current.original_paths.includes(normalized.original)) current.original_paths.push(normalized.original);
    if (feature.timestamp && (!current.first_timestamp || String(feature.timestamp) < String(current.first_timestamp))) current.first_timestamp = feature.timestamp;
    if (feature.timestamp && (!current.last_timestamp || String(feature.timestamp) > String(current.last_timestamp))) current.last_timestamp = feature.timestamp;
    if (feature.source && !current.sources.includes(feature.source)) current.sources.push(feature.source);
    current.outside_workspace = current.outside_workspace || normalized.outside_workspace;
    byKey.set(key, current);
  }
  return [...byKey.values()].sort((a, b) => String(a.display_path).localeCompare(String(b.display_path)));
}

function listBashCommands(features: any[]): any[] {
  return features
    .filter((feature) => feature?.feature_type === 'bash_command' && stringValue(feature.command))
    .map((feature, index) => ({
      id: feature.feature_key || `${feature.timestamp || 'command'}-${index}`,
      timestamp: feature.timestamp || null,
      command: feature.command || '',
      description: feature.description || null,
      cwd: feature.cwd || null,
      source: feature.source || null,
      source_line: feature.source_line || null,
    }))
    .sort((a, b) => {
      const at = timestampMs(a.timestamp);
      const bt = timestampMs(b.timestamp);
      if (at !== null && bt !== null && at !== bt) return at - bt;
      if (at !== null) return -1;
      if (bt !== null) return 1;
      return String(a.id).localeCompare(String(b.id));
    });
}

function normalizeDiffMode(mode: any): string {
  if (mode === 'staged') return 'staged';
  if (mode === 'last_commit') return 'last_commit';
  if (mode === 'last_two_commits') return 'last_two_commits';
  return 'unstaged';
}

function gitDiffArgsForMode(mode: any): string[] {
  const normalized = normalizeDiffMode(mode);
  if (normalized === 'staged') return ['diff', '--no-ext-diff', '--staged', '--'];
  if (normalized === 'last_commit') return ['show', '--format=', '--find-renames', '--find-copies', 'HEAD', '--'];
  if (normalized === 'last_two_commits') return ['diff', '--no-ext-diff', '--find-renames', 'HEAD~2', 'HEAD', '--'];
  return ['diff', '--no-ext-diff', '--'];
}

function runGit(cwd: string, args: string[], opts: any = {}): any {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: opts.timeout || 8000,
    maxBuffer: opts.maxBuffer || MAX_GIT_DIFF_BUFFER,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (result.error) return { ok: false, stdout, stderr, error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, stdout, stderr, status: result.status, error: stderr.trim() || `git exited with status ${result.status}` };
  }
  return { ok: true, stdout, stderr };
}

function gitTopLevel(abs: string): string | null {
  const result = runGit(abs, ['rev-parse', '--show-toplevel'], { timeout: 5000, maxBuffer: 1024 * 1024 });
  if (!result.ok) return null;
  const top = (result.stdout || '').trim();
  return top ? path.resolve(top) : null;
}

function gitDiffForFiles(workDir: any, files: any, mode: any): any {
  if (!workDir) throw new Error('缺少工作目录, 无法读取 git diff');
  const gitRoot = gitTopLevel(workDir);
  if (!gitRoot) throw new Error(`工作目录不是 Git 仓库: ${workDir}`);
  const normalizedMode = normalizeDiffMode(mode);
  const safeFiles = [];
  for (const file of files || []) {
    const normalized = normalizeFeaturePath(file, { workDir, gitRoot });
    if (!normalized || normalized.outside_workspace) continue;
    if (normalized.relative_path === '.') continue;
    safeFiles.push(normalized.relative_path);
  }
  const uniqueFiles = [...new Set(safeFiles)];
  const argsBase = gitDiffArgsForMode(normalizedMode);
  const diffs = uniqueFiles.map((filePath) => {
    const result = runGit(gitRoot, [...argsBase, filePath]);
    return {
      path: filePath,
      display_path: filePath,
      mode: normalizedMode,
      diff: result.ok ? result.stdout : '',
      ok: result.ok,
      error: result.ok ? null : result.error,
    };
  });
  return { git_root: gitRoot, mode: normalizedMode, diffs };
}

export {
  featureJsonlPathOf,
  scanSessionFeatures,
  summarizeFileChanges,
  listBashCommands,
  normalizeDiffMode,
  gitDiffForFiles,
  normalizeFeaturePath,
  extractFeaturesFromEntry,
};
