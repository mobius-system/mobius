import fs from 'fs';
import path from 'path';

function flagDirOf(root: string, sessionId: string): string {
  return path.join(path.resolve(root), '.imac', 'flags', sessionId);
}

function runningFlagPathOf(root: string, sessionId: string): string {
  return path.join(flagDirOf(root, sessionId), 'running.flag');
}

function failedFlagPathOf(root: string, sessionId: string): string {
  return path.join(flagDirOf(root, sessionId), 'failed.flag');
}

function encodeFlagValue(value: unknown): string {
  return String(value ?? '')
    .replace(/\r?\n/g, '\\n')
    .slice(0, 2000);
}

function decodeFlagValue(value: unknown): string {
  return String(value ?? '').replace(/\\n/g, '\n');
}

type FlagBody = Record<string, string>;

function parseFlagBody(body: unknown): FlagBody {
  const out: FlagBody = {};
  for (const line of String(body || '').split('\n')) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i)] = decodeFlagValue(line.slice(i + 1));
  }
  return out;
}

// 解析 running.flag 为 { session, runId, startedAt, backend, ... }; 不存在/读失败返回 null.
function readRunningFlag(root: string | null | undefined, sessionId: string | null | undefined): FlagBody | null {
  if (!root || !sessionId) return null;
  try {
    return parseFlagBody(fs.readFileSync(runningFlagPathOf(root, sessionId), 'utf8'));
  } catch {
    return null;
  }
}

// 解析 failed.flag 为 { session, failedAt, backend, reason, ... }; 不存在/读失败返回 null.
function readFailedFlag(root: string | null | undefined, sessionId: string | null | undefined): FlagBody | null {
  if (!root || !sessionId) return null;
  try {
    return parseFlagBody(fs.readFileSync(failedFlagPathOf(root, sessionId), 'utf8'));
  } catch {
    return null;
  }
}

function writeRunningFlag(root: string | null | undefined, sessionId: string | null | undefined, fields: FlagBody = {}): boolean {
  if (!root || !sessionId) return false;
  fs.mkdirSync(flagDirOf(root, sessionId), { recursive: true });
  const existing = readRunningFlag(root, sessionId);
  const startedAt = (existing && existing.startedAt) || new Date().toISOString();
  const runId = (existing && existing.runId) || `${sessionId}:${startedAt}`;
  const body: FlagBody = {
    session: sessionId,
    runId,
    pid: String(process.pid),
    startedAt,
    ...Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v === undefined || v === null ? '' : String(v)]),
    ),
  };
  fs.writeFileSync(
    runningFlagPathOf(root, sessionId),
    Object.entries(body)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeFlagValue(v)}`)
      .join('\n') + '\n',
  );
  try { removeFailedFlag(root, sessionId); }
  catch (e) { console.warn(`[session-flags] remove stale failed.flag failed (${sessionId}): ${(e as Error).message}`); }
  return true;
}

function safeWriteRunningFlag(root: string | null | undefined, sessionId: string | null | undefined, fields: FlagBody = {}, label = 'session-flags'): boolean {
  try { return writeRunningFlag(root, sessionId, fields); }
  catch (e) {
    console.warn(`[${label}] write running.flag failed (${sessionId}): ${(e as Error).message}`);
    return false;
  }
}

function removeRunningFlag(root: string | null | undefined, sessionId: string | null | undefined): boolean {
  if (!root || !sessionId) return false;
  fs.rmSync(runningFlagPathOf(root, sessionId), { force: true });
  return true;
}

function safeRemoveRunningFlag(root: string | null | undefined, sessionId: string | null | undefined, label = 'session-flags'): boolean {
  try { return removeRunningFlag(root, sessionId); }
  catch (e) {
    console.warn(`[${label}] remove running.flag failed (${sessionId}): ${(e as Error).message}`);
    return false;
  }
}

function removeFailedFlag(root: string | null | undefined, sessionId: string | null | undefined): boolean {
  if (!root || !sessionId) return false;
  fs.rmSync(failedFlagPathOf(root, sessionId), { force: true });
  return true;
}

function safeRemoveFailedFlag(root: string | null | undefined, sessionId: string | null | undefined, label = 'session-flags'): boolean {
  try { return removeFailedFlag(root, sessionId); }
  catch (e) {
    console.warn(`[${label}] remove failed.flag failed (${sessionId}): ${(e as Error).message}`);
    return false;
  }
}

function writeFailedFlag(root: string | null | undefined, sessionId: string | null | undefined, fields: FlagBody = {}): boolean {
  if (!root || !sessionId) return false;
  fs.mkdirSync(flagDirOf(root, sessionId), { recursive: true });
  const body: FlagBody = {
    session: sessionId,
    failedAt: new Date().toISOString(),
    ...Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v === undefined || v === null ? '' : String(v)]),
    ),
  };
  fs.writeFileSync(
    failedFlagPathOf(root, sessionId),
    Object.entries(body)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeFlagValue(v)}`)
      .join('\n') + '\n',
  );
  return true;
}

function safeWriteFailedFlag(root: string | null | undefined, sessionId: string | null | undefined, fields: FlagBody = {}, label = 'session-flags'): boolean {
  try { return writeFailedFlag(root, sessionId, fields); }
  catch (e) {
    console.warn(`[${label}] write failed.flag failed (${sessionId}): ${(e as Error).message}`);
    return false;
  }
}

function safeRemoveFlagDir(root: string | null | undefined, sessionId: string | null | undefined, label = 'session-flags'): boolean {
  if (!root || !sessionId) return false;
  try {
    fs.rmSync(flagDirOf(root, sessionId), { recursive: true, force: true });
    return true;
  } catch (e) {
    console.warn(`[${label}] remove flag dir failed (${sessionId}): ${(e as Error).message}`);
    return false;
  }
}

// 项目绑定路径配置类失败 (非任务失败)，不计入 failed/accomplished。
function isWorkspaceConfigFailureFlag(root: string | null | undefined, sessionId: string | null | undefined): boolean {
  try {
    const p = failedFlagPathOf(root || '', sessionId || '');
    if (!fs.existsSync(p)) return false;
    const body = fs.readFileSync(p, 'utf8');
    return body.includes('项目绑定路径不是 Git 仓库根')
      || body.includes('项目绑定路径当前还不是可用于 worktree 的 Git 仓库根')
      || body.includes('请把项目移动到对应位置')
      || body.includes('工作目录不可用')
      || body.includes('workspace unavailable');
  } catch {
    return false;
  }
}

interface JobFlagState {
  accomplished: boolean;
  failed: boolean;
  failedReason: string;
  failedAt: string | null;
}

// 权威任务状态：flag 目录存在 + 无 running.flag = 已完成；failed.flag 在 = 失败；
// workspace 配置类失败不算业务结果，两字段都返回 false。
function readJobFlagState(root: string | null | undefined, sessionId: string | null | undefined): JobFlagState {
  const hasFlagDir = !!(root && sessionId) && fs.existsSync(flagDirOf(root, sessionId));
  const workspaceConfigFailure = isWorkspaceConfigFailureFlag(root, sessionId);
  const failed = hasFlagDir && !workspaceConfigFailure
    ? fs.existsSync(failedFlagPathOf(root || '', sessionId || ''))
    : false;
  const failedInfo = failed ? readFailedFlag(root, sessionId) : null;
  return {
    accomplished: hasFlagDir && !workspaceConfigFailure
      ? !fs.existsSync(runningFlagPathOf(root || '', sessionId || ''))
      : false,
    failed,
    failedReason: (failedInfo && failedInfo.reason) || '',
    failedAt: (failedInfo && failedInfo.failedAt) || null,
  };
}

export {
  flagDirOf,
  runningFlagPathOf,
  failedFlagPathOf,
  writeRunningFlag,
  safeWriteRunningFlag,
  readRunningFlag,
  removeRunningFlag,
  safeRemoveRunningFlag,
  removeFailedFlag,
  safeRemoveFailedFlag,
  writeFailedFlag,
  safeWriteFailedFlag,
  readFailedFlag,
  safeRemoveFlagDir,
  isWorkspaceConfigFailureFlag,
  readJobFlagState,
};

export type { FlagBody, JobFlagState };
