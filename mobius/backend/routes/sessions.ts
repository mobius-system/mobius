import express from 'express';
import { v4 as uuid } from 'uuid';
import path from 'path';
import { auth, authOrQuery } from '../middleware/auth';
import { Sessions } from '../repositories/sessions';
import { Issues } from '../repositories/issues';
import { Messages } from '../repositories/messages';
// @ts-ignore — bridge instance 仍是 .js
import { bridge } from '../bridge/instance';
// @ts-ignore — service 仍是 .js
import { buildSessionContext, buildSessionSelectionSnapshot } from '../services/session-context';
// @ts-ignore — repository 仍是 .js
import { audit } from '../repositories/audit';
// @ts-ignore — service 仍是 .js
import * as modelRegistry from '../services/model-registry';
// @ts-ignore — service 仍是 .js
import { useProxyForSession, withSessionProxyState } from '../services/session-proxy-state';
// @ts-ignore — service 仍是 .js
import * as agents from '../agents';
import { computeSessionRuntimeStatus, syncAgentStatusIfChanged } from '../utils/session-runtime-status';
// @ts-ignore — repository 仍是 .js
import { Projects } from '../repositories/projects';
// @ts-ignore — repository 仍是 .js (通过 skills-fs / memories-fs 兼容层)
import { Skills } from '../repositories/skills';
// @ts-ignore — repository 仍是 .js
import { Memories } from '../repositories/memories';
// @ts-ignore — service 仍是 .js
import { syncSkillsToWorkspace } from '../services/session-skills-sync';
// @ts-ignore — service 仍是 .js
import { recordAdminAuditIfCrossUser } from '../services/admin-audit';
// @ts-ignore — service 仍是 .js
import { gitTopLevel, isGitRepoRoot, resolveSessionWorkspace } from '../services/workspace';
// @ts-ignore — service 仍是 .js
import {
  countMergedJsonl,
  readMergedJsonlSlice,
  appendMobiusErrorEntry,
  readLastMobiusEntryType,
  DEFAULT_HISTORY_TAIL,
  MAX_HISTORY_FETCH,
} from '../services/mobius-jsonl';
// @ts-ignore — service 仍是 .js
import { readSessionInputs } from '../services/session-inputs';
// @ts-ignore — service 仍是 .js
import * as sessionFeatures from '../services/session-features';
// @ts-ignore — service 仍是 .js
import { runSessionMessage } from '../services/session-message-runner';
// @ts-ignore — service 仍是 .js
import { writeSessionTransferDocument } from '../services/session-transfer';
// @ts-ignore — service 仍是 .js
import { predictNextQuestionsForSession } from '../services/session-next-question-predictor';
// @ts-ignore — service 仍是 .js
import { appendBlackboardRecord } from '../services/research-blackboard';
// @ts-ignore — db 仍是 .js (顶层 tsconfig 已 allowJs, 但 import 路径走 require 兼容)
import { db } from '../../db';
// @ts-ignore — service 仍是 .js
import {
  canCreateSessionForIssue,
  canOperateSession,
  canReadIssue,
  canReadSession,
} from '../services/access-control';
// flag 路径约定单一来源 (与 backend / scanner 一致): <仓库根>/.imac/flags/<sid>/{running,failed}.flag
// readJobFlagState / safeRemoveRunningFlag 均来自 utils/session-flags (已 TS 化).
import {
  readJobFlagState,
  safeRemoveRunningFlag,
} from '../utils/session-flags';
// @ts-ignore — service 仍是 .js
import { DEFAULT_WINDOW_HOURS, statsSince, statsSinceMinutes } from '../services/agent-prompt-events';
// @ts-ignore — service 仍是 .js
import * as modelPromptLimits from '../services/model-prompt-limits';

const router = express.Router();

// ── 类型别名 ────────────────────────────────────────────────────────────────
// Express 4 的 Request 默认不带 user, 用 cast 兜底, 与其他 route 保持一致.
type AnyUser = { id: string; role?: string; [k: string]: any };
export type AnySession = { [k: string]: any };
type AnyBackend = { [k: string]: any };

function userOf(req: express.Request): AnyUser {
  return (req as any).user as AnyUser;
}

const PROMPT_STATS_BACKENDS = [
  { key: 'codex', backendName: 'tmux-codex' },
  { key: 'claude_code', backendName: 'tmux-claude-code' },
];

function pidExists(pid: unknown): boolean {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function activeWindowCountForBackend(backendName: string): number {
  let backend: AnyBackend;
  try {
    backend = agents.get(backendName);
  } catch {
    return 0;
  }
  let windows: any[] = [];
  try {
    windows = backend.listSessions();
  } catch {
    return 0;
  }
  return windows.filter((w: any) => {
    if (!w?.sessionId || w.sessionId === '_root') return false;
    if (w.paneDead) return false;
    if (!pidExists(w.pid)) return false;
    try { return !!backend.isAlive(w.sessionId); }
    catch { return false; }
  }).length;
}

function activeWindowsByPromptBackend(): Record<string, number> {
  return Object.fromEntries(
    PROMPT_STATS_BACKENDS.map((def) => [def.key, activeWindowCountForBackend(def.backendName)]),
  );
}

// 全站 codex / claude-code 最近提问聚合 — 给 NewSessionModal 用.
// 真正阻止创建的限制由 modelPromptLimits.checkCreateAllowed 统一判定.
router.get('/prompt-stats', auth, (req: express.Request, res: express.Response) => {
  const s = statsSince(DEFAULT_WINDOW_HOURS);
  const s5 = statsSinceMinutes(modelPromptLimits.WINDOW_MINUTES);
  const activeWindows = activeWindowsByPromptBackend();
  const byBackend: Record<string, any> = s.by_backend;
  const byBackend5: Record<string, any> = s5.by_backend;
  res.json({
    window_hours: s.window_hours,
    window_minutes: modelPromptLimits.WINDOW_MINUTES,
    since: s.since,
    codex: byBackend['tmux-codex'] || 0,
    claude_code: byBackend['tmux-claude-code'] || 0,
    codex_5min: byBackend5['tmux-codex'] || 0,
    claude_code_5min: byBackend5['tmux-claude-code'] || 0,
    // Backward-compatible aliases for older frontends.
    codex_2min: byBackend5['tmux-codex'] || 0,
    claude_code_2min: byBackend5['tmux-claude-code'] || 0,
    total: s.total,
    active_tmux_window_count: Object.values(activeWindows).reduce((sum, count) => sum + count, 0),
    active_windows_by_backend: activeWindows,
    model_usage_limits: modelPromptLimits.usageForUser(userOf(req).id),
  });
});

router.get('/model-options', auth, (_req: express.Request, res: express.Response) => {
  res.json(modelRegistry.listSessionModelOptions());
});

function findSessionReadable(id: string, user: AnyUser): AnySession | null {
  const session = Sessions.findById(id) as AnySession | undefined;
  return session && canReadSession(user, session) ? session : null;
}

export function findSessionOperable(id: string, user: AnyUser): AnySession | null {
  const session = Sessions.findById(id) as AnySession | undefined;
  return session && canOperateSession(user, session) ? session : null;
}

function auditSessionAccess(user: AnyUser, action: string, session: AnySession | null | undefined): void {
  if (!session) return;
  recordAdminAuditIfCrossUser(user, action, 'session', session.session_id, session.user_id);
}

function backendForSession(session: AnySession | null | undefined): AnyBackend {
  return agents.get(modelRegistry.backendNameForSessionModel(session?.model));
}

function isTurnCompleteEntry(entry: any): boolean {
  const sr = entry?.message?.stop_reason;
  if (entry?.type === 'assistant' && sr && sr !== 'tool_use') return true;
  if (entry?.type === 'event_msg' && entry?.payload?.type === 'task_complete') return true;
  return false;
}

function shapeSessionForStream(s: AnySession): Record<string, any> {
  const backend = backendForSession(s);
  return {
    session_id: s.session_id,
    name: s.name,
    description: s.description,
    status: s.status,
    agent_status: s.agent_status,
    issue_id: s.issue_id,
    project_id: s.project_id,
    scope_type: s.scope_type,
    research_id: s.research_id,
    research_role: s.research_role,
    message_count: s.message_count,
    turn_count: s.turn_count,
    last_active: s.last_active,
    created_at: s.created_at,
    model: s.model,
    total_cost_usd: s.total_cost_usd,
    use_proxy: useProxyForSession(s, backend as any),
    model_label: modelRegistry.labelForSessionModel(s.model),
    claude_session_id: s.claude_session_id,
    agent_backend: modelRegistry.backendNameForSessionModel(s.model),
  };
}

function sseDataLine(payload: any): string {
  return JSON.stringify(payload).replace(/\r?\n/g, '\ndata: ');
}

async function writeSse(res: express.Response | null, event: string, payload: any): Promise<boolean> {
  if (!res || res.writableEnded || res.destroyed) return false;
  const frame = `event: ${event}\ndata: ${sseDataLine(payload)}\n\n`;
  if (res.write(frame)) return true;
  await new Promise<void>((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
  return !(res.writableEnded || res.destroyed);
}

function writeSseComment(res: express.Response | null, text: string): boolean {
  if (!res || res.writableEnded || res.destroyed) return false;
  return res.write(`: ${text}\n\n`);
}

interface JsonlHistory {
  entries?: any[];
  total?: number;
  totalApproximate?: boolean;
  truncated?: boolean;
  sentinel?: any;
}

async function sendSseJsonlHistory(
  res: express.Response,
  sessionId: string,
  hist: JsonlHistory,
): Promise<boolean> {
  const entries = Array.isArray(hist?.entries) ? hist.entries! : [];
  const baseMeta = {
    event: 'jsonl_history',
    session_id: sessionId,
    total: hist?.total ?? entries.length,
    total_approximate: !!hist?.totalApproximate,
    truncated: !!hist?.truncated,
  };

  if (entries.length === 0) {
    return writeSse(res, 'jsonl_history', { ...baseMeta, reset: true, done: true, chunk_index: 0, entries: [] });
  }

  const maxEntries = 250;
  const maxBytes = 512 * 1024;
  let chunkIndex = 0;
  let chunkBytes = 0;
  let chunk: any[] = [];

  const flush = async (done: boolean): Promise<boolean> => {
    if (!chunk.length && !done) return true;
    const payload = {
      ...baseMeta,
      reset: chunkIndex === 0,
      done: !!done,
      chunk_index: chunkIndex,
      count: chunk.length,
      entries: chunk,
    };
    chunkIndex += 1;
    chunkBytes = 0;
    chunk = [];
    return writeSse(res, 'jsonl_history', payload);
  };

  for (const entry of entries) {
    let encoded: string;
    try { encoded = JSON.stringify(entry); } catch { continue; }
    const entryBytes = Buffer.byteLength(encoded);
    if (chunk.length > 0 && (chunk.length >= maxEntries || chunkBytes + entryBytes > maxBytes)) {
      const ok = await flush(false);
      if (!ok) return false;
    }
    chunk.push(entry);
    chunkBytes += entryBytes + 1;
  }

  return flush(true);
}


router.patch('/:id', auth, (req: express.Request, res: express.Response) => {
  const id = String(req.params.id);
  const user = userOf(req);
  const session = findSessionOperable(id, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'write_session', session);
  const { name, status } = (req.body || {}) as { name?: string; status?: string };
  if (name) Sessions.updateName(id, name);
  if (status !== undefined) {
    if (!['active', 'completed', 'archived'].includes(status)) {
      res.status(400).json({ error: '状态无效' });
      return;
    }
    Sessions.updateStatus(id, status as any);
  }
  res.json(Sessions.findById(id));
});

interface BackgroundCloseResult {
  wasAlive: boolean;
  wasWorking: boolean;
  terminated: boolean;
  message: string | null;
}

async function closeBackgroundForDelete(
  session: AnySession,
  sid: string,
  label: string,
): Promise<BackgroundCloseResult> {
  const backend = backendForSession(session);
  const wasAlive = backend.isAlive(sid);
  const wasWorking = wasAlive && backend.isWorking(sid);

  // 删除前先关掉后台 agent (tmux window + TUI). closeSessionAsync 内部归一
  // session_key -> 裸 sessionId, 故传 session_key 或 sid 都能命中.
  let terminated = false;
  try {
    const r = await bridge.closeSessionAsync(session.session_key || sid, session.model);
    terminated = !!r?.killed;
  } catch (e) {
    console.warn(`[sessions] ${label}时关闭后台 agent 失败 (${sid}): ${(e as Error).message}`);
  }

  const message = wasAlive
    ? (wasWorking
      ? `会话已永久删除; 检测到后台 agent 仍在执行任务, 已强制终止该进程 (window=${sid})。`
      : `会话已永久删除; 已清理其后台 agent 进程 (window=${sid})。`)
    : null;

  return { wasAlive, wasWorking, terminated, message };
}

export async function terminateBackgroundSession(session: AnySession, sid: string): Promise<BackgroundCloseResult> {
  const backend = backendForSession(session);
  let wasAlive = false;
  let wasWorking = false;
  try {
    wasAlive = backend.isAlive(sid);
    wasWorking = wasAlive && backend.isWorking(sid);
  } catch {}

  let terminated = false;
  try {
    const r = await bridge.closeSessionAsync(session.session_key || sid, session.model);
    terminated = !!r?.killed;
  } catch (e) {
    console.warn(`[sessions] 终止后台 agent 失败 (${sid}): ${(e as Error).message}`);
  }

  const message = wasAlive
    ? (wasWorking
      ? `已终止旧 Session 的后台执行 (window=${sid})。`
      : `已关闭旧 Session 的后台 agent (window=${sid})。`)
    : '旧 Session 没有正在运行的后台 agent。';

  return { wasAlive, wasWorking, terminated, message };
}

function shouldNotifyResearchPeers(req: express.Request): boolean {
  return req.body?.notify_others === true || req.body?.notifyOthers === true;
}

function researchSessionLeftContent(session: AnySession): string {
  const role = session.research_role === 'chief_researcher' ? 'chief_researcher' : 'research_assistant';
  return `Research Agent「${session.name || session.session_id}」已离开团队。session_id=${session.session_id}, role=${role}`;
}

function appendResearchSessionLeftNotice(session: AnySession, userId: string): any {
  if (session.scope_type !== 'research' || !session.research_id) return null;
  const role = session.research_role === 'chief_researcher' ? 'chief_researcher' : 'research_assistant';
  return appendBlackboardRecord({
    researchId: session.research_id,
    author: 'HR',
    content: researchSessionLeftContent(session),
    metadata: {
      event: 'session_left',
      session_id: session.session_id,
      role,
      name: session.name || '',
      deleted_by: userId || null,
    },
  });
}

// 删除 Session = 直接永久删除, 不再进入项目回收站.
router.delete('/:id', auth, async (req: express.Request, res: express.Response) => {
  const id = String(req.params.id);
  const user = userOf(req);
  const session = findSessionOperable(id, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'delete_session', session);

  const sid = id;
  let noticeResult: any = null;
  if (session.scope_type === 'research' && shouldNotifyResearchPeers(req)) {
    noticeResult = appendResearchSessionLeftNotice(session, user.id);
    if (noticeResult?.error) { res.status(500).json({ error: noticeResult.error }); return; }
  }

  const closed = await closeBackgroundForDelete(session, sid, '删除');
  audit(user.id, 'session.delete', 'session', sid,
    JSON.stringify({
      scope_type: session.scope_type || 'issue',
      research_id: session.research_id || null,
      notify_others: !!noticeResult,
      was_alive: closed.wasAlive,
      was_working: closed.wasWorking,
      terminated: closed.terminated,
    }));

  Sessions.permanentDelete(sid);
  const noticeMessage = noticeResult ? '已由 HR 在 Blackboard 写入该 Research Agent 已离开团队。' : null;
  res.json({
    ok: true,
    notified_others: !!noticeResult,
    blackboard_record_id: noticeResult?.record?.id || null,
    background_was_alive: closed.wasAlive,
    background_was_working: closed.wasWorking,
    background_terminated: closed.terminated,
    message: [noticeMessage, closed.message].filter(Boolean).join('\n') || null,
  });
});

// 兼容旧调用: /permanent 仍然执行同一套硬删除逻辑.
router.delete('/:id/permanent', auth, async (req: express.Request, res: express.Response) => {
  const id = String(req.params.id);
  const user = userOf(req);
  const session = findSessionOperable(id, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'delete_session_permanent', session);
  let noticeResult: any = null;
  if (session.scope_type === 'research' && shouldNotifyResearchPeers(req)) {
    noticeResult = appendResearchSessionLeftNotice(session, user.id);
    if (noticeResult?.error) { res.status(500).json({ error: noticeResult.error }); return; }
  }
  const closed = await closeBackgroundForDelete(session, id, '永久删除');
  audit(user.id, 'session.permanent_delete', 'session', id,
    JSON.stringify({
      scope_type: session.scope_type || 'issue',
      research_id: session.research_id || null,
      notify_others: !!noticeResult,
      terminated: closed.terminated,
    }));
  Sessions.permanentDelete(id);
  const noticeMessage = noticeResult ? '已由 HR 在 Blackboard 写入该 Research Agent 已离开团队。' : null;
  res.json({
    ok: true,
    notified_others: !!noticeResult,
    blackboard_record_id: noticeResult?.record?.id || null,
    background_was_alive: closed.wasAlive,
    background_was_working: closed.wasWorking,
    background_terminated: closed.terminated,
    message: [noticeMessage, closed.message].filter(Boolean).join('\n') || null,
  });
});

router.post('/:id/terminate', auth, async (req: express.Request, res: express.Response) => {
  const id = String(req.params.id);
  const user = userOf(req);
  const session = findSessionOperable(id, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'terminate_session', session);

  const sid = id;
  const closed = await terminateBackgroundSession(session, sid);
  try { Sessions.setIdle(sid, session.user_id || user.id); } catch {}
  try {
    Messages.insertSystem(
      sid,
      closed.message as any,
      null as any,
      '终止执行',
    );
  } catch {}
  audit(user.id, 'session.terminate', 'session', sid,
    JSON.stringify({
      was_alive: closed.wasAlive,
      was_working: closed.wasWorking,
      terminated: closed.terminated,
    }));

  res.json({
    ok: true,
    background_was_alive: closed.wasAlive,
    background_was_working: closed.wasWorking,
    background_terminated: closed.terminated,
    message: closed.message,
  });
});

router.post('/:id/stop', auth, async (req: express.Request, res: express.Response) => {
  const id = String(req.params.id);
  const user = userOf(req);
  const session = findSessionOperable(id, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'stop_session', session);

  const sessionId = id;
  const backend = backendForSession(session);
  let workDir: string | undefined;
  let flagRoot: string | undefined;
  try {
    const workspace = resolveSessionWorkspace(user, sessionId);
    if (!workspace.error) {
      workDir = workspace.workDir;
      flagRoot = workspace.projectRoot || workspace.workDir;
    }
  } catch {}

  let ok = true;
  try {
    await backend.pauseCurrentAndResumeFromSession({
      sessionId,
      prompt: '',
      cwd: workDir || undefined,
      flagRoot: flagRoot || workDir || undefined,
    });
  } catch (e) {
    ok = false;
    console.warn('[sessions/stop] stop failed:', (e as Error).message);
  }

  try { Sessions.setIdle(sessionId, session.user_id || user.id); } catch {}
  try {
    Messages.insertSystem(
      sessionId,
      ok ? '已发 C-c × 3 给后台智能体 (软停).' : 'Stop 失败.',
      null as any,
      '终止执行',
    );
  } catch {}

  res.json({ ok, task_id: sessionId });
});

router.get('/:id/events', authOrQuery, async (req: express.Request, res: express.Response) => {
  const sessionId = String(req.params.id);
  const user = userOf(req);
  const session = findSessionReadable(sessionId, user);
  if (!session) { res.status(404).json({ error: `session ${sessionId} 不存在或不属于你` }); return; }
  auditSessionAccess(user, 'read_session_events', session);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 告诉 nginx 不要缓冲本响应, 否则 SSE 实时性会被毁

  // 注意: SSE (text/event-stream) 绝不能套 Content-Encoding: gzip. 浏览器对 EventSource 的
  // gzip 解压是按块缓冲的——即便后端每帧 Z_SYNC_FLUSH, 浏览器仍会攒到连接关闭才把解压后的事件
  // 交给 onmessage, 导致实时 jsonl_entry 永远到不了前端 (只有手动刷新网页, 重开连接拿到初始
  // jsonl_history 才看得到更新). 这是浏览器层的行为, 后端 flush 无解. REST JSON 的 gzip
  // (见 middleware/api-gzip.ts, 已显式跳过 text/event-stream) 不受影响, 继续保留.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (req.socket) req.socket.setTimeout(0);

  let closed = false;
  let unsub: (() => void) | null = null;
  const keepalive = setInterval(() => writeSseComment(res, 'keepalive'), 25000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    if (unsub) { try { unsub(); } catch {} }
    unsub = null;
  };
  const endStream = () => {
    cleanup();
    if (!res.writableEnded && !res.destroyed) {
      try { res.end(); } catch {}
    }
  };

  res.on('close', cleanup);

  try {
    const backend = backendForSession(session);
    const workspace = resolveSessionWorkspace(user, sessionId);

    if (!writeSseComment(res, 'connected')) { endStream(); return; }

    const subscribed = await writeSse(res, 'subscribed', {
      event: 'subscribed',
      session: shapeSessionForStream(session),
    });
    if (!subscribed || closed) { endStream(); return; }

    const history = Messages.listForTask(sessionId, 200);
    const historySent = await writeSse(res, 'history', {
      event: 'history',
      messages: history,
      total: history.length,
    });
    if (!historySent || closed) { endStream(); return; }

    if (workspace.error) {
      await writeSse(res, 'server_error', {
        event: 'error',
        message: workspace.error,
        category: 'workspace',
      });
      endStream();
      return;
    }

    // count-then-tail: 先发 cheap total (不 parse, 只数 \n), 让前端立刻显示 "N entries / X 轮".
    // 然后只回灌末尾 DEFAULT_HISTORY_TAIL 条; 用户点 "展开全部" 时再走 REST 补齐.
    // 默认 full=0; ?full=1 走旧路径 (一次性回灌全部, 最多 maxLines).
    const fullHistory = String(req.query.full || '') === '1';
    let metaTotal = 0;
    let metaApproximate = false;
    if (!fullHistory) {
      try {
        const histPath = typeof backend._resolveJsonlPath === 'function'
          ? backend._resolveJsonlPath(sessionId)
          : null;
        if (histPath) {
          const counted = countMergedJsonl(histPath);
          metaTotal = counted.total;
          metaApproximate = counted.totalApproximate;
          const metaSent = await writeSse(res, 'jsonl_meta', {
            event: 'jsonl_meta',
            session_id: sessionId,
            total: metaTotal,
            total_approximate: metaApproximate,
            tail_count: DEFAULT_HISTORY_TAIL,
            jsonl_path: counted?.paths?.primary || histPath || null,
          });
          if (!metaSent || closed) { endStream(); return; }
        }
      } catch (e) {
        console.warn(`[sessions/events] jsonl_meta count failed (${sessionId}): ${(e as Error).message}`);
      }
    }

    const histOpts = fullHistory ? {} : { tailCount: DEFAULT_HISTORY_TAIL };
    const hist = backend.getHistory(sessionId, histOpts) as JsonlHistory;
    // 把 cheap total 覆盖回 hist.total, 让 sendSseJsonlHistory 的 baseMeta.total 跟 jsonl_meta 一致.
    if (!fullHistory && metaTotal > 0) {
      hist.total = metaTotal;
      hist.totalApproximate = metaApproximate;
      hist.truncated = metaTotal > (hist.entries?.length || 0);
    }
    const jsonlHistorySent = await sendSseJsonlHistory(res,sessionId, hist);
    if (!jsonlHistorySent || closed) { endStream(); return; }

    unsub = backend.getAgentRawThoughtStream(
      sessionId,
      (entry: any) => {
        writeSse(res, 'jsonl_entry', { event: 'jsonl_entry', session_id: sessionId, entry }).catch(() => cleanup());
        if (isTurnCompleteEntry(entry)) {
          writeSse(res, 'typing', { event: 'typing', active: false }).catch(() => cleanup());
          try {
            // agent_status 现由 agent-status-syncer 统一管; turn 完成只刷新 last_agent_event 留痕.
            db.prepare('UPDATE sessions_v2 SET last_agent_event=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE session_id=?')
              .run(sessionId);
          } catch {}
        }
      },
      { fromSentinel: hist.sentinel },
    );
  } catch (e) {
    console.warn(`[sessions/events] stream failed (${sessionId}): ${(e as Error).message}`);
    try { await writeSse(res, 'server_error', { event: 'error', message: (e as Error).message || String(e) }); } catch {}
    endStream();
  }
});

// jsonl-history REST — "展开全部" 时按需补齐. SSE 默认只回灌末尾 DEFAULT_HISTORY_TAIL,
// 前端要看完整历史时调用这个端点拉指定窗口 [from, from+limit).
router.get('/:id/jsonl-history', auth, (req: express.Request, res: express.Response) => {
  const id = String(req.params.id);
  const user = userOf(req);
  const session = findSessionReadable(id, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'read_session_jsonl_history', session);

  const backend = backendForSession(session);
  const histPath = typeof backend._resolveJsonlPath === 'function'
    ? backend._resolveJsonlPath(id)
    : null;
  if (!histPath) {
    res.json({ entries: [], total: 0, from: 0, returned: 0, has_more: false });
    return;
  }

  const fromIndex = Math.max(0, Math.floor(Number(req.query.from) || 0));
  const requestedLimit = Math.floor(Number(req.query.limit) || DEFAULT_HISTORY_TAIL);
  const limit = Math.max(0, Math.min(MAX_HISTORY_FETCH, requestedLimit));

  try {
    const slice = readMergedJsonlSlice(histPath, { fromIndex, limit });
    if (slice.exceeded) {
      res.status(413).json({
        error: 'jsonl 文件超过安全上限, 无法整文件解析. 请联系管理员或缩小窗口.',
        total: slice.total,
      });
      return;
    }
    res.json({
      session_id: id,
      entries: slice.entries,
      total: slice.total,
      from: slice.from,
      returned: slice.returned,
      has_more: slice.from + slice.returned < slice.total,
    });
    return;
  } catch (e) {
    console.warn(`[sessions/jsonl-history] failed (${id}): ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message || String(e) });
    return;
  }
});

export function sessionJsonlPath(session: AnySession, sessionId: string): string | null {
  const backend = backendForSession(session);
  return typeof backend._resolveJsonlPath === 'function'
    ? backend._resolveJsonlPath(sessionId)
    : null;
}

router.post('/:id/predicted-next-questions', auth, async (req: express.Request, res: express.Response) => {
  const sessionId = String(req.params.id);
  const user = userOf(req);
  const session = findSessionOperable(sessionId, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'predict_next_questions', session);

  const jsonlPath = sessionJsonlPath(session, sessionId);
  try {
    const result = await predictNextQuestionsForSession({ session, jsonlPath });
    res.json({
      session_id: sessionId,
      questions: result.questions,
      meta: result.meta,
    });
    return;
  } catch (e) {
    const err = e as any;
    const status = Number(err?.status) || 500;
    res.status(status).json({ error: err?.message || String(e) });
    return;
  }
});

function featureWorkspaceForSession(user: AnyUser, sessionId: string): {
  workspace: any;
  workDir: string | null;
  gitRoot: string | null;
  error: string | null;
} {
  const workspace = resolveSessionWorkspace(user, sessionId);
  if (workspace.error) return { workspace, workDir: null, gitRoot: null, error: workspace.error };
  let gitRoot: string | null = null;
  try { gitRoot = gitTopLevel(workspace.workDir) as any; } catch {}
  return { workspace, workDir: workspace.workDir as any, gitRoot, error: null };
}

function queryFiles(value: any): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v || '')).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

// 从当前 session 的 codex / claude-code JSONL 中抽取文件修改特征.
// 特征缓存写入同目录同名 .feature.jsonl; diff 内容不写缓存, 由 /features/git-diff 实时问 git.
router.get('/:id/features/files', auth, (req: express.Request, res: express.Response) => {
  const sessionId = String(req.params.id);
  const user = userOf(req);
  const session = findSessionReadable(sessionId, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'read_session_file_features', session);

  const jsonlPath = sessionJsonlPath(session, sessionId);
  if (!jsonlPath) {
    res.json({
      session_id: sessionId,
      files: [],
      total: 0,
      appended: 0,
      source_jsonl: null,
      feature_jsonl: null,
      workspace_error: null,
    });
    return;
  }

  try {
    const scanned = sessionFeatures.scanSessionFeatures(jsonlPath);
    const workspace = featureWorkspaceForSession(user, sessionId);
    const files = sessionFeatures.summarizeFileChanges(scanned.entries, {
      workDir: workspace.workDir,
      gitRoot: workspace.gitRoot,
    });
    res.json({
      session_id: sessionId,
      files,
      total: files.length,
      appended: scanned.appended,
      scanned_from_offset: scanned.scanned_from_offset,
      source_jsonl: scanned.source_jsonl,
      feature_jsonl: scanned.feature_jsonl,
      git_root: workspace.gitRoot,
      workspace_error: workspace.error,
    });
    return;
  } catch (e) {
    console.warn(`[sessions/features/files] failed (${sessionId}): ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message || String(e) });
    return;
  }
});

// 从当前 session JSONL 中抽取 Bash / shell 命令特征, 按时间顺序返回.
router.get('/:id/features/bash', auth, (req: express.Request, res: express.Response) => {
  const sessionId = String(req.params.id);
  const user = userOf(req);
  const session = findSessionReadable(sessionId, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'read_session_bash_features', session);

  const jsonlPath = sessionJsonlPath(session, sessionId);
  if (!jsonlPath) {
    res.json({
      session_id: sessionId,
      commands: [],
      total: 0,
      appended: 0,
      source_jsonl: null,
      feature_jsonl: null,
    });
    return;
  }

  try {
    const scanned = sessionFeatures.scanSessionFeatures(jsonlPath);
    const commands = sessionFeatures.listBashCommands(scanned.entries);
    res.json({
      session_id: sessionId,
      commands,
      total: commands.length,
      appended: scanned.appended,
      scanned_from_offset: scanned.scanned_from_offset,
      source_jsonl: scanned.source_jsonl,
      feature_jsonl: scanned.feature_jsonl,
    });
    return;
  } catch (e) {
    console.warn(`[sessions/features/bash] failed (${sessionId}): ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message || String(e) });
    return;
  }
});

// 按文件修改特征清单限定路径, 实时读取 git diff.
// mode: unstaged | staged | last_commit | last_two_commits
router.get('/:id/features/git-diff', auth, (req: express.Request, res: express.Response) => {
  const sessionId = String(req.params.id);
  const user = userOf(req);
  const session = findSessionReadable(sessionId, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'read_session_feature_git_diff', session);

  const jsonlPath = sessionJsonlPath(session, sessionId);
  if (!jsonlPath) {
    res.json({ session_id: sessionId, mode: sessionFeatures.normalizeDiffMode(req.query.mode), diffs: [], files: [] });
    return;
  }

  try {
    const scanned = sessionFeatures.scanSessionFeatures(jsonlPath);
    const workspace = featureWorkspaceForSession(user, sessionId);
    if (workspace.error) { res.status(400).json({ error: workspace.error }); return; }

    const files = sessionFeatures.summarizeFileChanges(scanned.entries, {
      workDir: workspace.workDir,
      gitRoot: workspace.gitRoot,
    });
    const allowed = new Map<string, string>();
    for (const file of files) {
      allowed.set(file.path, file.path);
      allowed.set(file.display_path, file.path);
      for (const original of file.original_paths || []) allowed.set(original, file.path);
    }

    const requested = queryFiles(req.query.file);
    const targetFiles = requested.length
      ? requested.map((file) => allowed.get(file)).filter(Boolean)
      : files.map((file: any) => file.path);
    if (requested.length && targetFiles.length === 0) {
      res.status(400).json({ error: '请求的文件不在当前 Session 文件修改清单中' });
      return;
    }

    const result = sessionFeatures.gitDiffForFiles(
      workspace.workDir,
      [...new Set(targetFiles)],
      req.query.mode,
    );
    res.json({
      session_id: sessionId,
      files,
      ...result,
    });
    return;
  } catch (e) {
    console.warn(`[sessions/features/git-diff] failed (${sessionId}): ${(e as Error).message}`);
    res.status(500).json({ error: (e as Error).message || String(e) });
    return;
  }
});

// 进程存活 + PID — 前端轮询此接口作为"是否执行中"的唯一真相源.
// 不读 sessions_v2.agent_status (那个不可靠), 直接问 agent backend.
// (agents/backend 已在文件顶部 require, 删除路由也用到.)
router.get('/:id/status', auth, (req: express.Request, res: express.Response) => {
  const id = String(req.params.id);
  const user = userOf(req);
  const session = findSessionReadable(id, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'read_session_status', session);
  const proj = session.project_id ? (Projects.findById(session.project_id) as any) : null;
  const root = (proj && proj.bind_path) ? path.resolve(proj.bind_path) : null;
  // 真相源: 与 agent-status-syncer 共用 computeSessionRuntimeStatus, 保证 sessions_v2
  // .agent_status 字段与本接口返回一致. 详情见 backend/utils/session-runtime-status.ts.
  // 显式取 session_id / model 构造入参, 与 agent-status-syncer 一致: AnySession 是索引
  // 签名类型, 直接整体传入会被 TS 拒绝 (不保证 session_id 存在, TS2345).
  const st = computeSessionRuntimeStatus({ session_id: session.session_id, model: session.model }, root);
  // 顺便写回 agent_status: 前端打开会话时每 ~2s 调本接口, 借此让被查看 session 的
  // agent_status 近乎实时更新 (列表小圆点读 DB, 不再只靠 syncer 60s 兜底). 仅变化时写.
  syncAgentStatusIfChanged(id, session.agent_status, st);
  const backend = backendForSession(session);
  const alive = st.alive;
  const working = st.working;
  const jobAccomplished = st.jobAccomplished;
  const jobFailed = st.failed;
  const failedReason = st.failedReason;
  const failedAt = st.failedAt;
  let pid: number | null = null;
  if (alive) {
    const found = backend.listSessions().find((s: any) => s.sessionId === id);
    pid = found?.pid ?? null;
  }
  const issue = session.issue_id ? (Issues.findById(session.issue_id) as any) : null;
  const worktreeIgnored = !!(issue?.use_worktree && root && !isGitRepoRoot(root));

  // 错误扫描: agent 进程在但当前不在 turn 中 (isWorking=false), 且 .mobius.jsonl
  // 末条不是 error (去重) 时, 调 backend.getRecentError 扫 TUI 屏幕.
  // 命中则追加一条 type:'error' 到 .mobius.jsonl, 前端经 SSE 自然收到并以红色卡片渲染.
  // tmux-claude-code 的 getRecentError 恒 null, 整段自动跳过.
  if (alive && !working) {
    try {
      const jsonlPath = backend._lookupPersistedJsonlPath(id);
      if (jsonlPath && readLastMobiusEntryType(jsonlPath) !== 'error') {
        const err = backend.getRecentError(id);
        if (err) {
          const p = backend._lookupPersistedEntry(id) || {};
          appendMobiusErrorEntry({
            jsonlPath,
            sessionId: id,
            agentSessionId: p.agentSessionId || null,
            cwd: p.cwd || null,
            backendName: backend.name,
            error: err,
          });
          console.log(`[sessions/status] error_scan hit sid=${id} backend=${backend.name} msg="${String(err.message).slice(0, 120)}"`);
        }
      }
    } catch (e) {
      console.warn(`[sessions/status] error_scan failed sid=${id}: ${(e as Error).message}`);
    }
  }

  res.json({
    session_id: id,
    alive,
    working,
    job_accomplished: jobAccomplished,
    failed: jobFailed,
    failed_reason: failedReason || null,
    failed_at: failedAt || null,
    pid,
    agent_backend: backend.name,
    use_proxy: useProxyForSession(session, backend as any),
    claude_session_id: session.claude_session_id || null,
    worktree_ignored: worktreeIgnored,
  });
});

router.get('/:id/turns', auth, (req: express.Request, res: express.Response) => {
  const id = String(req.params.id);
  const user = userOf(req);
  const session = findSessionReadable(id, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'read_session_turns', session);
  res.json(Messages.turnsForSession(id));
});

router.get('/:id/inputs', auth, (req: express.Request, res: express.Response) => {
  const id = String(req.params.id);
  const user = userOf(req);
  const session = findSessionReadable(id, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'read_session_inputs', session);
  if (!session.project_id) { res.status(400).json({ error: '当前 Session 未关联项目, 无法读取输入回放' }); return; }

  const project = Projects.findById(session.project_id) as any;
  const bindPath = (project?.bind_path || '').trim();
  if (!bindPath) { res.status(400).json({ error: '当前 Session 所属项目未配置 bind_path, 无法读取输入回放' }); return; }

  try {
    const { entries, filePath } = readSessionInputs(bindPath, id);
    const fileTurns = new Set<number>(
      entries
        .map((entry: any) => Number(entry?.turn_number))
        .filter((turn: number) => Number.isFinite(turn) && turn > 0),
    );
    const fileTextKeys = new Set<string>(
      entries
        .map((entry: any) => String(entry?.input_text || entry?.content || '').trim())
        .filter(Boolean),
    );
    const dbEntries = Messages.userInputsForTask(id)
      .filter((row: any) => {
        const turn = Number(row?.turn_number);
        if (Number.isFinite(turn) && turn > 0 && fileTurns.has(turn)) return false;
        const text = String(row?.content || '').trim();
        return text && !fileTextKeys.has(text);
      })
      .map((row: any) => ({
        id: `message-${row.id}`,
        session_id: id,
        input_text: '',
        content: row.content || '',
        created_at: row.created_at || '',
        request_id: null,
        turn_number: Number.isFinite(Number(row.turn_number)) ? Number(row.turn_number) : null,
      }));
    const newestFirst = entries.concat(dbEntries).sort((a: any, b: any) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    res.json({ entries: newestFirst, file_path: filePath });
  } catch (e) {
    const err = e as any;
    res.status(500).json({ error: err.message || '读取输入回放失败', file_path: err.filePath || null });
  }
});

// 注入预览/快照:
//   - 已写过快照 (首轮发过消息): 返回快照本体, applied=true
//   - 未写过快照 (从未发消息): 按 Session 创建时保存的选择快照构建, applied=false
router.get('/:id/context-preview', auth, (req: express.Request, res: express.Response) => {
  const id = String(req.params.id);
  const user = userOf(req);
  const session = findSessionReadable(id, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'read_session_context_preview', session);

  const userMsgCount = Messages.countUserMessagesFor(id);
  const snap = Sessions.getContextSnapshot(id) as any;
  if (snap && snap.context_snapshot_at) {
    let sources: any = null;
    try { sources = snap.context_snapshot_sources ? JSON.parse(snap.context_snapshot_sources) : null; } catch {}
    res.json({
      body: snap.context_snapshot_body || '',
      sources,
      applied: true,
      pending: false,
      snapshot_at: snap.context_snapshot_at,
      user_message_count: userMsgCount,
    });
    return;
  }

  const ctx = buildSessionContext(user, id);
  res.json({
    body: ctx.body,
    sources: ctx.sources,
    applied: false,
    pending: userMsgCount === 0,
    snapshot_at: null,
    user_message_count: userMsgCount,
  });
});

// Session 右栏 Skill / Memory 只读快照:
// 新 Session 直接读创建时写入的 session_selection_snapshot.
// 老 Session 没有该字段时, 优先回退到首轮 context 快照; 再没有才实时构建一次作为兼容展示.
router.get('/:id/selection-snapshot', auth, (req: express.Request, res: express.Response) => {
  const id = String(req.params.id);
  const user = userOf(req);
  const session = findSessionReadable(id, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'read_session_selection_snapshot', session);

  const stripBodies = (snapshot: any) => {
    const src = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const skills = Array.isArray(src.skills) ? src.skills : [];
    const memories = Array.isArray(src.memories) ? src.memories : [];
    const allSkills = Array.isArray(src.all_skills) ? src.all_skills : skills.map((s: any) => ({ ...s, enabled: true }));
    const allMemories = Array.isArray(src.all_memories) ? src.all_memories : memories.map((m: any) => ({ ...m, enabled: true }));
    const totals = src.totals && typeof src.totals === 'object' ? src.totals : {};
    const mapSkill = (s: any) => ({
      id: s.id,
      scope: s.scope,
      name: s.name,
      description: s.description || '',
      dirName: s.dirName || null,
      enabled: s.enabled !== false,
    });
    const mapMemory = (m: any) => ({
      id: m.id,
      scope: m.scope,
      name: m.name,
      description: m.description || '',
      enabled: m.enabled !== false,
    });
    return {
      version: src.version || 1,
      skills: skills.map((s: any) => mapSkill({ ...s, enabled: true })).filter((s: any) => s.id && s.name),
      memories: memories.map((m: any) => mapMemory({ ...m, enabled: true })).filter((m: any) => m.id && m.name),
      all_skills: allSkills.map(mapSkill).filter((s: any) => s.id && s.name),
      all_memories: allMemories.map(mapMemory).filter((m: any) => m.id && m.name),
      totals: {
        skills: Number.isFinite(Number(totals.skills)) ? Number(totals.skills) : allSkills.length,
        memories: Number.isFinite(Number(totals.memories)) ? Number(totals.memories) : allMemories.length,
      },
    };
  };

  const stored = Sessions.getSelectionSnapshot(id) as any;
  if (stored?.session_selection_snapshot) {
    try {
      res.json({
        snapshot: stripBodies(JSON.parse(stored.session_selection_snapshot)),
        snapshot_at: stored.session_selection_snapshot_at || null,
        source: 'created',
        legacy: false,
      });
      return;
    } catch (e) {
      console.warn(`[sessions] selection snapshot parse failed (${id}): ${(e as Error).message}`);
    }
  }

  const snap = Sessions.getContextSnapshot(id) as any;
  if (snap?.context_snapshot_sources) {
    try {
      const sources = JSON.parse(snap.context_snapshot_sources);
      res.json({
        snapshot: stripBodies({
          skills: sources?.skills || [],
          memories: sources?.memories || [],
          totals: { skills: (sources?.skills || []).length, memories: (sources?.memories || []).length },
        }),
        snapshot_at: snap.context_snapshot_at || null,
        source: 'context',
        legacy: true,
      });
      return;
    } catch (e) {
      console.warn(`[sessions] context snapshot sources parse failed (${id}): ${(e as Error).message}`);
    }
  }

  const ctx = buildSessionContext(user, id);
  res.json({
    snapshot: stripBodies({
      skills: ctx.sources?.skills || [],
      memories: ctx.sources?.memories || [],
      totals: {
        skills: (ctx.sources as any)?.selection_totals?.skills ?? (ctx.sources?.skills || []).length,
        memories: (ctx.sources as any)?.selection_totals?.memories ?? (ctx.sources?.memories || []).length,
      },
    }),
    snapshot_at: null,
    source: 'live',
    legacy: true,
  });
});

// 向 Session 提交一条用户消息.
// 行为与旧 chat socket handleSend 保持一致:
//   1) 鉴权 + 解析 workspace
//   2) Messages.insertUser + 分配 turn_number
//   3) appendSessionInput (input_text 落盘, 可选)
//   4) 首轮注入 context (skill + memory) → wrapUserMessage
//   5) backend.noPauseCurrentAndQueueQueryAtSession 推到 TUI
//   6) 同步 backend 内部 agent session id 回 DB
// 不做流式响应 — 请求成功即表示后端已接收; 后续 jsonl 由 /api/sessions/:id/events SSE 推送.
// Body: { content: string, input_text?: string, request_id?: string, attachments?: Array }
router.post('/:id/messages', auth, async (req: express.Request, res: express.Response) => {
  const sessionId = String(req.params.id);
  const user = userOf(req);
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const requestId = typeof req.body?.request_id === 'string' ? req.body.request_id : null;
  const hasInputText = Object.prototype.hasOwnProperty.call(req.body || {}, 'input_text');
  const inputText = hasInputText ? String(req.body.input_text || '') : '';

  try {
    const result = await runSessionMessage({
      user,
      sessionId,
      content,
      inputText,
      hasInputText,
      requestId,
      attachments: req.body?.attachments,
      source: 'http.session.messages',
      logger: console,
    } as any);
    auditSessionAccess(user, 'send_session_message', Sessions.findById(sessionId) as any);
    res.json(result);
    return;
  } catch (e) {
    const err = e as any;
    res.status(err.status || 500).json({ error: err.message || '启动失败', category: err.category || undefined });
    return;
  }
});

// Session 进行中临时把某个 skill / memory "再喂一遍" 给 agent.
// 已启用 = "强调", 未启用 = "追加", 两者后端行为一致:
//   - skill: 复制源目录到 <workDir>/.imac/skills/<dirName>/, 消息正文带相对路径
//   - memory: 不写文件, 消息正文直接含 memory body
// 消息发送交给 runSessionMessage 复用同一套 (turn 分配 / context wrap / backend dispatch).
router.post('/:id/emphasize', auth, async (req: express.Request, res: express.Response) => {
  const sessionId = String(req.params.id);
  const user = userOf(req);
  const session = findSessionOperable(sessionId, user);
  if (!session) { res.status(404).json({ error: '未找到' }); return; }
  auditSessionAccess(user, 'emphasize_session_skill_memory', session);

  const kind = String(req.body?.kind || '').trim();
  const id = String(req.body?.id || '').trim();
  if (!kind || !id) { res.status(400).json({ error: 'kind 与 id 必填' }); return; }
  if (kind !== 'skill' && kind !== 'memory') {
    res.status(400).json({ error: 'kind 只能是 skill / memory' });
    return;
  }

  let workDir: string | null = null;
  try {
    const workspace = resolveSessionWorkspace(user, sessionId);
    if (!workspace.error) workDir = workspace.workDir || null;
  } catch {}
  if (kind === 'skill' && !workDir) {
    res.status(500).json({ error: '工作目录不可用, 无法复制 skill' });
    return;
  }

  let messageContent: string;
  let relPath: string | null = null;
  if (kind === 'skill') {
    const skill = Skills.findById(id) as any;
    if (!skill) { res.status(400).json({ error: 'skill 不存在' }); return; }
    const syncResults = syncSkillsToWorkspace(workDir as string, [{ id: skill.id }]);
    const hit = syncResults.find((r: any) => r.id === skill.id && r.ok);
    if (!hit) { res.status(500).json({ error: '复制 skill 到 session 工作目录失败' }); return; }
    relPath = hit.relPath;
    messageContent = `用户要求你重视 ${relPath} 文件中的 skill`;
  } else {
    const memory = Memories.findById(id) as any;
    if (!memory) { res.status(400).json({ error: 'memory 不存在' }); return; }
    const memoryBody = typeof memory.body === 'string' ? memory.body : '';
    messageContent = `用户要求你重视一下记忆：\n\n${memoryBody}`;
  }

  try {
    const result = await runSessionMessage({
      user,
      sessionId,
      content: messageContent,
      hasInputText: false,
      requestId: `emphasize-${kind}-${id}-${Date.now()}` as any,
      source: 'http.session.emphasize',
      logger: console,
    } as any);
    res.json({
      ok: true,
      kind,
      id,
      rel_path: relPath,
      turn_number: result?.turn_number ?? null,
      request_id: result?.request_id ?? null,
      backend: result?.backend ?? null,
    });
    return;
  } catch (e) {
    const err = e as any;
    res.status(err.status || 500).json({
      error: err.message || '启动失败',
      category: err.category || undefined,
    });
    return;
  }
});

// 嵌在 /api/issues/:issueId/sessions 下
const issueScoped = express.Router({ mergeParams: true });

issueScoped.get('/', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const issueId = String(req.params.issueId);
  const issue = Issues.findById(issueId) as any;
  if (!issue) { res.status(404).json({ error: '未找到' }); return; }
  if (!canReadIssue(user, issue)) { res.status(404).json({ error: '未找到' }); return; }
  const list = (Sessions.listForIssue(issueId) as any[]).filter((session) => canReadSession(user, session));
  // 列表里的 session 多数已不在后端 runtime (历史会话), 故不走 backend.isXxx
  // (那依赖 runtime map), 直接按项目 bind_path 仓库根看 flag 文件 — 运行时无关,
  // 历史会话也能正确反映最终态. running.flag 在=未结束; 不在=已结束; failed.flag 在=失败.
  // 无 bind_path → 两字段给 null, 前端回退到原 agent_status 显示 (不破坏现状).
  const proj = issue.project_id ? (Projects.findById(issue.project_id) as any) : null;
  const root = (proj && proj.bind_path) ? path.resolve(proj.bind_path) : null;
  const enriched = list.map((s) => {
    let job_accomplished: boolean | null = null;
    let job_failed: boolean | null = null;
    if (root) {
      try {
        job_accomplished = readJobFlagState(root, s.session_id).accomplished;
      } catch {}
      try {
        job_failed = readJobFlagState(root, s.session_id).failed;
      } catch {}
    }
    return { ...withSessionProxyState(s), job_accomplished, job_failed };
  });
  res.json(enriched);
});

issueScoped.post('/', auth, async (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const issueId = String(req.params.issueId);
  const issue = Issues.findById(issueId) as any;
  if (!issue) { res.status(404).json({ error: '未找到' }); return; }
  if (!canCreateSessionForIssue(user, issue)) { res.status(403).json({ error: '无权在此 Issue 创建 Session' }); return; }

  const { name, description, excluded_skill_ids, excluded_memory_ids, model, language } = (req.body || {}) as {
    name?: string;
    description?: string;
    excluded_skill_ids?: any;
    excluded_memory_ids?: any;
    model?: any;
    language?: string;
  };
  if (!name) { res.status(400).json({ error: '请填写会话名称' }); return; }

  // 前端传内置短键或管理员导入模型 key; 非法/缺省回退默认模型.
  // 导入模型仍来自管理员白名单, 不直接把用户串塞进 --model.
  const resolvedModel = modelRegistry.resolveSessionModelForCreate(model);
  if (!resolvedModel) {
    res.status(503).json({ error: '没有可用的模型，请先在管理后台配置模型（或检查 ~/.claude/mobiusdefault.settings.json 是否存在）' });
    return;
  }
  const limitCheck = modelPromptLimits.checkCreateAllowed(user.id, resolvedModel.key);
  if (!limitCheck.allowed) {
    res.status(limitCheck.status as any).json({
      error: limitCheck.error,
      code: limitCheck.code,
      usage: limitCheck.usage,
    });
    return;
  }
  // 注入上下文语言: 仅 zh/en, 缺省中文.
  const sessionLanguage = language === 'en' ? 'en' : 'zh';

  const sessionId = uuid().slice(0, 8);
  const sessionKey = `web:${user.id}:${sessionId}`;

  // Wizard 勾选状态: 用户在 Issue 默认集合上取消勾选的 skill/memory id 列表.
  // 留空 = 全部启用 (兼容现有调用方).
  const sanitizeIds = (arr: any): string[] => Array.isArray(arr) ? arr.filter((x: any) => typeof x === 'string' && x.length > 0) : [];
  const excludedSkillIds = sanitizeIds(excluded_skill_ids);
  const excludedMemoryIds = sanitizeIds(excluded_memory_ids);
  const selectionSnapshot = buildSessionSelectionSnapshot(user, issueId, excludedSkillIds, excludedMemoryIds);
  const continueFromSessionId = typeof req.body?.continue_from_session_id === 'string'
    ? req.body.continue_from_session_id.trim()
    : '';
  let sourceSession: AnySession | null = null;
  let transferResult: any = null;
  if (continueFromSessionId) {
    sourceSession = findSessionOperable(continueFromSessionId, user);
    if (!sourceSession) { res.status(404).json({ error: '旧 Session 不存在或无权操作' }); return; }
    if (sourceSession.issue_id !== issueId || sourceSession.scope_type !== 'issue') {
      res.status(400).json({ error: '只能从当前 Issue 下的旧 Session 继续' });
      return;
    }
    const project = Projects.findById(issue.project_id) as any;
    const bindPath = (project?.bind_path || '').trim();
    if (!bindPath) { res.status(400).json({ error: '当前项目未绑定路径, 无法创建 Session 转接文档' }); return; }
    const jsonlPath = sessionJsonlPath(sourceSession, continueFromSessionId);
    if (!jsonlPath) { res.status(400).json({ error: '旧 Session 没有可读取的 JSONL 记录' }); return; }
    try {
      transferResult = writeSessionTransferDocument({
        bindPath,
        sourceSession,
        targetSessionId: sessionId,
        jsonlPath,
      });
    } catch (e) {
      console.warn(`[sessions] create transfer document failed (${continueFromSessionId}): ${(e as Error).message}`);
      res.status(500).json({ error: (e as Error).message || '创建 Session 转接文档失败' });
      return;
    }
  }

  Sessions.insert({
    session_id: sessionId,
    issue_id: issueId,
    project_id: issue.project_id,
    user_id: user.id,
    name,
    description,
    session_key: sessionKey,
    excluded_skill_ids: excludedSkillIds,
    excluded_memory_ids: excludedMemoryIds,
    selection_snapshot: selectionSnapshot,
    model: resolvedModel.sessionModelValue,
    language: sessionLanguage,
  } as any);
  if (sourceSession && transferResult?.filePath) {
    try {
      Messages.insertSystem(
        sessionId,
        JSON.stringify({
          type: 'session_transfer',
          from_session_id: sourceSession.session_id,
          path: transferResult.filePath,
          section_count: transferResult.sectionCount,
          entry_count: transferResult.entryCount,
          truncated: transferResult.truncated,
        }),
        null as any,
        'session_transfer',
      );
    } catch (e) {
      console.warn(`[sessions] save transfer marker failed (${sessionId}): ${(e as Error).message}`);
    }
    const closed = await terminateBackgroundSession(sourceSession, sourceSession.session_id);
    try {
      const project = Projects.findById(issue.project_id) as any;
      if (project?.bind_path) safeRemoveRunningFlag(path.resolve(project.bind_path), sourceSession.session_id, 'session-transfer');
    } catch {}
    try { Sessions.setIdle(sourceSession.session_id, sourceSession.user_id || user.id); } catch {}
    try {
      Messages.insertSystem(
        sourceSession.session_id,
        `${closed.message}\n已创建更换模型继续的转接文档: ${transferResult.filePath}`,
        null as any,
        '修改模型并继续',
      );
    } catch {}
    audit(user.id, 'session.continue_with_model', 'session', sessionId,
      JSON.stringify({
        from_session_id: sourceSession.session_id,
        transfer_path: transferResult.filePath,
        background_was_alive: closed.wasAlive,
        background_was_working: closed.wasWorking,
        background_terminated: closed.terminated,
      }));
    const startContent = [name, description].map((part) => String(part || '').trim()).filter(Boolean).join('\n\n');
    if (startContent) {
      try {
        await runSessionMessage({
          user,
          sessionId,
          content: startContent,
          inputText: startContent,
          hasInputText: true,
          requestId: `continue-${sourceSession.session_id}-${Date.now()}` as any,
          source: 'http.session.continue_with_model',
          logger: console,
        } as any);
      } catch (e) {
        const err = e as any;
        console.warn(`[sessions] auto start continued session failed (${sessionId}): ${(e as Error).message}`);
        res.status(err.status || 500).json({ error: err.message || '启动新 Session 失败', category: err.category || undefined });
        return;
      }
    }
  }
  recordAdminAuditIfCrossUser(user, 'create_session', 'issue', issue.id, issue.created_by);
  Issues.touchActiveAndIncrement(issueId);
  res.json({
    ...(withSessionProxyState(Sessions.findById(sessionId)) as any),
    continue_from_session_id: sourceSession?.session_id || null,
    transfer_path: transferResult?.filePath || null,
  });
});

export { router, issueScoped };
