import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const FEATURE_SCHEMA_VERSION = 1;
const SCAN_CHECKPOINT_FEATURE_TYPE = 'scan_checkpoint';
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

function lastFeatureState(entries: any[]): { lastTimestamp: string | null; lastOffset: number; hasCheckpoint: boolean } {
  let lastTimestamp = null;
  let lastOffset = 0;
  let hasCheckpoint = false;
  for (const entry of entries) {
    if (entry?.feature_type === SCAN_CHECKPOINT_FEATURE_TYPE) hasCheckpoint = true;
    else if (entry?.timestamp) lastTimestamp = entry.timestamp;
    const offset = Number(entry?.source_offset_end);
    if (Number.isFinite(offset) && offset > lastOffset) lastOffset = offset;
  }
  return { lastTimestamp, lastOffset, hasCheckpoint };
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

function completeJsonlBytes(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  if (buffer[buffer.length - 1] === 10) return buffer.length;
  const lastNewline = buffer.lastIndexOf(10);
  const tailStart = lastNewline >= 0 ? lastNewline + 1 : 0;
  // 已完整写入但没有末尾换行的最后一条仍可消费；正在写入的半条 JSON
  // 则停在上一条行边界，等下次补全后再解析。
  return parseJsonMaybe(buffer.subarray(tailStart).toString('utf8')) ? buffer.length : tailStart;
}

function scanCheckpoint(sourceJsonl: string, scannedOffset: number, sourceSize: number): any {
  return {
    schema_version: FEATURE_SCHEMA_VERSION,
    feature_type: SCAN_CHECKPOINT_FEATURE_TYPE,
    source_jsonl: sourceJsonl,
    source_offset_start: scannedOffset,
    source_offset_end: scannedOffset,
    source_size: sourceSize,
  };
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
  let { lastTimestamp, lastOffset, hasCheckpoint } = lastFeatureState(existing);
  const stat = fs.statSync(jsonlPath);
  if (stat.size > MAX_FEATURE_SOURCE_BYTES) {
    throw new Error(`jsonl 文件超过特征扫描安全上限: ${stat.size} bytes`);
  }

  let reset = false;
  if (lastOffset > stat.size) {
    existing = [];
    lastTimestamp = null;
    lastOffset = 0;
    hasCheckpoint = false;
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

  // Codex/Claude 正在追加 JSONL 时，尾行可能尚未写完。检查点只推进到最后一个
  // 换行符，避免把暂时无法解析的半行永久跳过。
  const completeLength = completeJsonlBytes(buffer);
  const scanBuffer = completeLength === buffer.length ? buffer : buffer.subarray(0, completeLength);
  const scannedToOffset = startOffset + completeLength;
  const existingFeatures = existing.filter((entry) => entry?.feature_type !== SCAN_CHECKPOINT_FEATURE_TYPE);
  const known = new Set(existingFeatures.map(featureKey).concat(existingFeatures.map(legacyFeatureKey)));
  const lastMs = timestampMs(lastTimestamp);
  const appended: any[] = [];
  scanSourceBuffer(scanBuffer, jsonlPath, startOffset, (entry, meta) => {
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

  // 扫描进度必须独立于是否识别到 feature。旧实现仅从最后一条 feature 推导 offset，
  // 无文件改动的会话会永远从 0 开始，而 feature 后的长尾也会被每次重复解析。
  const checkpointNeeded = !hasCheckpoint || scannedToOffset > startOffset;
  appendFeatureEntries(featurePath || '', checkpointNeeded
    ? [...appended, scanCheckpoint(jsonlPath, scannedToOffset, stat.size)]
    : appended);
  return {
    source_jsonl: jsonlPath,
    feature_jsonl: featurePath,
    entries: existingFeatures.concat(appended),
    appended: appended.length,
    scanned_from_offset: startOffset,
    scanned_to_offset: scannedToOffset,
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

function pathExists(abs: string | null, cache?: Map<string, boolean>): boolean {
  if (!abs) return false;
  const hit = cache?.get(abs);
  if (hit !== undefined) return hit;
  let exists = false;
  try { exists = fs.existsSync(abs); } catch { exists = false; }
  cache?.set(abs, exists);
  return exists;
}

// Codex / 沙箱常用 /workspace/<project>/file；映射回当前 workDir 或 gitRoot。
function remapSandboxAbsolutePath(original: string, workDir: string | null, gitRoot: string | null): string | null {
  const mounted = toPosix(original).match(/^\/workspaces?\/(.+)$/);
  if (!mounted) return null;
  const segments = mounted[1].split('/').filter(Boolean);
  for (const base of [workDir, gitRoot]) {
    if (!base) continue;
    const projectName = path.basename(base);
    const projectIndex = segments.indexOf(projectName);
    const relative = (projectIndex >= 0 ? segments.slice(projectIndex + 1) : segments).join('/');
    const abs = relative ? path.resolve(base, relative) : path.resolve(base);
    if (isWithinPath(base, abs)) return abs;
  }
  return null;
}

// summarize 会把嵌套工作区文件收成 gitRoot 相对路径；git-diff 再解析时必须仍对 gitRoot
// 拼接。若一律用 workDir 当 base，会出现 local_data/workspace/... 被叠两次后 ENOENT。
function resolveFeatureAbsolutePath(
  original: string,
  workDir: string | null,
  gitRoot: string | null,
  existsCache?: Map<string, boolean>,
): string {
  const sandbox = remapSandboxAbsolutePath(original, workDir, gitRoot);
  if (sandbox) return sandbox;
  if (path.isAbsolute(original)) return path.resolve(original);

  const workAbs = workDir ? path.resolve(workDir, original) : null;
  const gitAbs = gitRoot ? path.resolve(gitRoot, original) : null;
  const workOk = !!(workAbs && workDir && isWithinPath(workDir, workAbs) && pathExists(workAbs, existsCache));
  const gitOk = !!(gitAbs && gitRoot && isWithinPath(gitRoot, gitAbs) && pathExists(gitAbs, existsCache));
  if (gitOk && !workOk) return gitAbs as string;
  if (workOk) return workAbs as string;

  if (gitRoot && workDir && gitAbs && isWithinPath(gitRoot, workDir) && isWithinPath(gitRoot, gitAbs)) {
    const nestPrefix = toPosix(path.relative(gitRoot, workDir));
    const relative = toPosix(original);
    if (nestPrefix && (relative === nestPrefix || relative.startsWith(`${nestPrefix}/`))) return gitAbs;
  }
  return workAbs || gitAbs || path.resolve(original);
}

function normalizeFeaturePath(rawPath: any, workspace: any = {}, existsCache?: Map<string, boolean>): any {
  const original = stringValue(rawPath);
  if (!original) return null;
  const workDir = workspace.workDir ? path.resolve(workspace.workDir) : null;
  const gitRoot = workspace.gitRoot ? path.resolve(workspace.gitRoot) : null;
  const abs = resolveFeatureAbsolutePath(original, workDir, gitRoot, existsCache);

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
  const existsCache = new Map<string, boolean>();
  const normalizedCache = new Map<string, any>();
  const workspaceKey = `${workspace.workDir || ''}\0${workspace.gitRoot || ''}`;
  for (const feature of features) {
    if (feature?.feature_type !== 'file_change') continue;
    const original = stringValue(feature.file_path);
    const cacheKey = `${workspaceKey}\0${original}`;
    let normalized = normalizedCache.get(cacheKey);
    if (normalized === undefined) {
      normalized = normalizeFeaturePath(original, workspace, existsCache);
      normalizedCache.set(cacheKey, normalized);
    }
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

type WorkingTreeDiffMode = 'unstaged' | 'staged';

function diffRequestError(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

// 当前变更查看面只允许明确的 working-tree / index 来源。commit history 属于 P2，
// 不得在这里作为“无工作树 diff”时的隐式 fallback。
function normalizeDiffMode(mode: any): WorkingTreeDiffMode {
  if (mode === undefined || mode === null || mode === '' || mode === 'unstaged') return 'unstaged';
  if (mode === 'staged') return 'staged';
  throw diffRequestError('非法 diff mode，仅支持 unstaged 或 staged');
}

function gitDiffArgsForMode(mode: WorkingTreeDiffMode): string[] {
  const common = ['diff', '--no-ext-diff', '--no-textconv', '--find-renames'];
  return mode === 'staged' ? [...common, '--staged', '--'] : [...common, '--'];
}

function allowlistedDiffFiles(files: any[], requested: any[]): string[] {
  const allowed = new Map<string, string>();
  for (const file of files || []) {
    const canonical = stringValue(file?.path);
    if (!canonical) continue;
    allowed.set(canonical, canonical);
    const displayPath = stringValue(file?.display_path);
    if (displayPath) allowed.set(displayPath, canonical);
    for (const original of file?.original_paths || []) {
      const originalPath = stringValue(original);
      if (originalPath) allowed.set(originalPath, canonical);
    }
  }

  const requestedPaths = (requested || []).map((value) => stringValue(value)).filter(Boolean);
  if (!requestedPaths.length) return [...new Set((files || []).map((file) => stringValue(file?.path)).filter(Boolean))];

  const resolved: string[] = [];
  for (const requestedPath of requestedPaths) {
    const canonical = allowed.get(requestedPath);
    if (!canonical) throw diffRequestError('请求的文件不在当前 Session 文件修改清单中');
    resolved.push(canonical);
  }
  return [...new Set(resolved)];
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

function gitDiffForFiles(workDir: any, files: any, mode: any = 'unstaged'): any {
  if (!workDir) throw new Error('缺少工作目录, 无法读取 git diff');
  const normalizedMode = normalizeDiffMode(mode);
  const gitRoot = gitTopLevel(workDir);
  const safeFiles: any[] = [];
  for (const file of files || []) {
    const normalized = normalizeFeaturePath(file, { workDir, gitRoot });
    if (!normalized || normalized.relative_path === '.') continue;
    safeFiles.push(normalized);
  }
  const uniqueFiles = [...new Map(safeFiles.map((file) => [file.absolute_path, file])).values()];
  const diffs = uniqueFiles.map((file) => {
    let lastGitError: string | null = gitRoot ? null : `工作目录不是 Git 仓库: ${workDir}`;
    if (gitRoot && !file.outside_workspace) {
      const argsBase = gitDiffArgsForMode(normalizedMode);
      const result = runGit(gitRoot, [...argsBase, file.relative_path]);
      if (!result.ok) {
        lastGitError = result.error || null;
      } else if ((result.stdout || '').trim()) {
        return {
          path: file.relative_path,
          display_path: file.display_path,
          mode: normalizedMode,
          diff: result.stdout,
          fallback_content: null,
          fallback_error: null,
          ok: true,
          error: null,
        };
      }
    }

    let fallbackContent: string | null = null;
    let fallbackError: string | null = null;
    try {
      const stat = fs.statSync(file.absolute_path);
      if (!stat.isFile()) throw new Error('目标路径不是文件');
      fallbackContent = fs.readFileSync(file.absolute_path, 'utf8');
    } catch (e) {
      const raw = (e as Error).message || String(e);
      fallbackError = /ENOENT|no such file or directory/i.test(raw)
        ? '当前工作区已找不到这个文件，可能已被删除或路径已变化'
        : raw;
    }
    return {
      path: gitRoot && !file.outside_workspace ? file.relative_path : file.original,
      display_path: file.display_path,
      mode: normalizedMode,
      diff: null,
      fallback_content: fallbackContent,
      fallback_error: fallbackError,
      ok: fallbackError === null,
      error: fallbackError || lastGitError,
    };
  });
  const first = diffs[0] || null;
  return {
    git_root: gitRoot,
    mode: normalizedMode,
    diff: first?.diff ?? null,
    fallback_content: first?.fallback_content ?? null,
    diffs,
  };
}

export {
  featureJsonlPathOf,
  scanSessionFeatures,
  summarizeFileChanges,
  listBashCommands,
  normalizeDiffMode,
  allowlistedDiffFiles,
  gitDiffForFiles,
  normalizeFeaturePath,
  extractFeaturesFromEntry,
};
