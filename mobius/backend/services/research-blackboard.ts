import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';

import { db } from '../../db';
import { Researches } from '../repositories/researches';
import { Sessions } from '../repositories/sessions';
import { Messages } from '../repositories/messages';
import { BACKEND_WORKER_LOG_DIR, PORT } from '../config';
import modelRegistry from './model-registry';
import { resolveSessionWorkspace } from './workspace';
import agents from '../agents';

const DEFAULT_PORT = PORT;
const MAX_AUTHOR_LEN = 300;
const MAX_CONTENT_LEN = 50000;
const DELIVERY_SCAN_INTERVAL_MS = 3000;
const DELIVERY_FIRST_RUN_DELAY_MS = 1000;
const DELIVERY_LOG_DIR = BACKEND_WORKER_LOG_DIR;
const DELIVERY_LOG_FILE = path.join(DELIVERY_LOG_DIR, 'scan_research_blackboard_delivery.log');

function blackboardUrl(researchId: string): string {
  return `http://localhost:${DEFAULT_PORT}/api/research-blackboard/${researchId}`;
}

function resolveBlackboardFile(researchId: string): any {
  const research = Researches.findByIdWithProject(researchId);
  if (!research) return { error: 'Research 未找到' };
  const bindPath = (research.bind_path || '').trim();
  if (!bindPath) return { error: `Research 所属项目「${research.project_name || research.project_id}」尚未配置绑定路径` };
  const root = path.resolve(bindPath);
  return {
    research,
    root,
    dir: path.join(root, '.imac', 'blackboard', researchId),
    file: path.join(root, '.imac', 'blackboard', researchId, 'blackboard.jsonl'),
  };
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readBlackboard(researchId: string): any {
  const resolved = resolveBlackboardFile(researchId);
  if (resolved.error) return resolved;
  try {
    if (!fs.existsSync(resolved.file)) return { content: '', file: resolved.file, research: resolved.research };
    return { content: fs.readFileSync(resolved.file, 'utf8'), file: resolved.file, research: resolved.research };
  } catch (e) {
    return { error: `读取 Blackboard 失败: ${e.message}` };
  }
}

function parseBlackboardEntries(rawContent: any): any[] {
  const lines = String(rawContent || '').split('\n');
  const entries = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx];
    if (!rawLine || !rawLine.trim()) continue;
    try {
      const record = JSON.parse(rawLine);
      if (record && typeof record === 'object') {
        entries.push({ lineNo: idx + 1, rawLine, record });
      } else {
        entries.push({ lineNo: idx + 1, rawLine, error: 'not_object' });
      }
    } catch (e) {
      entries.push({ lineNo: idx + 1, rawLine, error: e.message });
    }
  }
  return entries;
}

function readBlackboardEntries(researchId: string): any {
  const resolved = resolveBlackboardFile(researchId);
  if (resolved.error) return resolved;
  try {
    const content = fs.existsSync(resolved.file) ? fs.readFileSync(resolved.file, 'utf8') : '';
    return {
      file: resolved.file,
      dir: resolved.dir,
      research: resolved.research,
      content,
      entries: parseBlackboardEntries(content),
    };
  } catch (e) {
    return { error: `读取 Blackboard 失败: ${e.message}` };
  }
}

function normalizeWriteInput(input: any = {}): any {
  const author = String(input.author || 'anonymous').slice(0, MAX_AUTHOR_LEN);
  const rawContent = input.content;
  const content = typeof rawContent === 'string'
    ? rawContent
    : (rawContent == null ? '' : JSON.stringify(rawContent));
  if (!content.trim()) return { error: 'content 不能为空' };
  if (content.length > MAX_CONTENT_LEN) return { error: `content 过长 (上限 ${MAX_CONTENT_LEN} 字符)` };
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : undefined;
  const legacySessionId = typeof input.session_id === 'string' && input.session_id.trim()
    ? input.session_id.trim()
    : null;
  return { author, legacySessionId, content, metadata };
}

function defaultDeliveryState(): any {
  return {
    delivered: false,
    delivered_at: null,
    delivery: {
      status: 'pending',
      target_session_ids: [],
      delivered_to_session_ids: [],
      attempt_count: 0,
      last_attempt_at: null,
      last_error: null,
    },
  };
}

function normalizeDeliveryState(record: any): any {
  const state = defaultDeliveryState();
  const rawDelivery = record && record.delivery && typeof record.delivery === 'object' && !Array.isArray(record.delivery)
    ? record.delivery
    : {};
  const topDelivered = typeof record.delivered === 'boolean' ? record.delivered : null;
  const topDeliveredAt = typeof record.delivered_at === 'string' ? record.delivered_at : null;
  const targetSessionIds = Array.isArray(rawDelivery.target_session_ids)
    ? rawDelivery.target_session_ids.filter((id: any) => typeof id === 'string' && id.trim()).map((id: any) => id.trim())
    : [];
  const deliveredToSessionIds = Array.isArray(rawDelivery.delivered_to_session_ids)
    ? rawDelivery.delivered_to_session_ids.filter((id: any) => typeof id === 'string' && id.trim()).map((id: any) => id.trim())
    : [];
  state.delivered = topDelivered !== null
    ? topDelivered
    : (typeof rawDelivery.delivered === 'boolean' ? rawDelivery.delivered : false);
  state.delivered_at = topDeliveredAt || (typeof rawDelivery.delivered_at === 'string' ? rawDelivery.delivered_at : null);
  state.delivery = {
    status: typeof rawDelivery.status === 'string' ? rawDelivery.status : 'pending',
    target_session_ids: targetSessionIds,
    delivered_to_session_ids: deliveredToSessionIds,
    attempt_count: Number.isFinite(Number(rawDelivery.attempt_count)) ? Number(rawDelivery.attempt_count) : 0,
    last_attempt_at: typeof rawDelivery.last_attempt_at === 'string' ? rawDelivery.last_attempt_at : null,
    last_error: typeof rawDelivery.last_error === 'string' ? rawDelivery.last_error : null,
  };
  return state;
}

function serializeRecord(record: any): string {
  const normalized = normalizeDeliveryState(record);
  return JSON.stringify({
    ...record,
    delivered: normalized.delivered,
    delivered_at: normalized.delivered_at,
    delivery: normalized.delivery,
  });
}

function appendBlackboardRecord({ researchId, author, content, metadata }: any): any {
  const resolved = resolveBlackboardFile(researchId);
  if (resolved.error) return resolved;
  const safeAuthor = String(author || 'anonymous').slice(0, MAX_AUTHOR_LEN);
  const safeContent = typeof content === 'string' ? content : '';
  if (!safeContent.trim()) return { error: 'content 不能为空' };
  if (safeContent.length > MAX_CONTENT_LEN) return { error: `content 过长 (上限 ${MAX_CONTENT_LEN} 字符)` };
  const record: any = {
    id: uuid().slice(0, 12),
    research_id: researchId,
    author: safeAuthor,
    content: safeContent,
    created_at: new Date().toISOString(),
    delivered: false,
    delivered_at: null,
    delivery: defaultDeliveryState().delivery,
  };
  if (metadata) record.metadata = metadata;
  try {
    ensureParentDir(resolved.file);
    fs.appendFileSync(resolved.file, `${serializeRecord(record)}\n`);
    Researches.touchActiveAndIncrement(researchId);
    requestBlackboardDeliveryScan();
    return { record, file: resolved.file, research: resolved.research };
  } catch (e) {
    return { error: `写入 Blackboard 失败: ${e.message}` };
  }
}

function extractAuthorSessionId(record: any): string {
  const metaSessionId = typeof record?.metadata?.session_id === 'string' ? record.metadata.session_id.trim() : '';
  if (metaSessionId) return metaSessionId;
  return '';
}

function authorMentionsSession(author: any, sessionId: any): boolean {
  if (!(author && sessionId)) return false;
  const escaped = String(sessionId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`).test(String(author));
}

function buildNotifyPrompt(records: any): string {
  const rows = Array.isArray(records) ? records : [records];
  const first = rows[0];
  const url = blackboardUrl(first.research_id);
  const parts = [
    '[Research Blackboard 更新提醒]',
    `research_id: ${first.research_id}`,
    `待投递条数: ${rows.length}`,
    '',
  ];
  rows.forEach((record, idx) => {
    parts.push(`--- 第 ${idx + 1} 条 ---`);
    parts.push(`id: ${record.id}`);
    parts.push(`写入者: ${record.author}`);
    parts.push(`时间: ${record.created_at}`);
    parts.push('内容:');
    parts.push(record.content);
    if (record.metadata && Object.keys(record.metadata).length > 0) {
      parts.push(`metadata: ${JSON.stringify(record.metadata)}`);
    }
    parts.push('');
  });
  parts.push('你可以读取完整 Research Blackboard:');
  parts.push(`curl ${url}`);
  return parts.join('\n').trimEnd();
}

function resolveDeliveryWorkspace(session: any, researchId: string): any {
  let cwd;
  let flagRoot;
  try {
    const workspace = resolveSessionWorkspace({ id: session.user_id }, session.session_id);
    if (!workspace.error) {
      cwd = workspace.workDir;
      flagRoot = workspace.projectRoot || workspace.workDir;
    }
  } catch {}

  if (!cwd) {
    const research = Researches.findByIdWithProject(researchId);
    const bindPath = (research?.bind_path || '').trim();
    if (bindPath) {
      cwd = path.resolve(bindPath);
      flagRoot = cwd;
    }
  }

  return { cwd, flagRoot: flagRoot || cwd };
}

async function deliverBlackboardBatchToSession({ researchId, session, records }: any): Promise<void> {
  const launch = modelRegistry.launchOptionsForSession(session);
  const backend = agents.get(launch.backend);
  const prompt = buildNotifyPrompt(records);
  const { cwd, flagRoot } = resolveDeliveryWorkspace(session, researchId);

  await backend.noPauseCurrentAndQueueQueryAtSession({
    sessionId: session.session_id,
    prompt,
    cwd,
    flagRoot,
    model: launch.model || undefined,
    settingsPath: launch.settingsPath,
    forceNoProxy: launch.forceNoProxy,
    useProxy: launch.forceNoProxy ? false : launch.useProxy === true,
    codexProfileKey: launch.codexProfileKey || undefined,
    codexChannel: launch.codexChannel || undefined,
    codexConfigPath: launch.codexConfigPath || undefined,
    codexSecretEnvKey: launch.codexSecretEnvKey || undefined,
    codexSecretValue: launch.codexSecretValue || undefined,
    displayName: session.name || undefined,
    agentSessionId: session.claude_session_id || undefined,
  });

  try {
    const turnNum = (Messages.maxTurnFor(session.session_id) || 0) + 1;
    Messages.insertSystem(
      session.session_id,
      `[Research Blackboard 更新提醒] 已自动向本会话发送提醒消息:\n\n${prompt}`,
      turnNum,
      'Research Blackboard 更新提醒',
    );
  } catch (e) {
    console.warn(`[research-blackboard] 写 system 消息失败 (${session.session_id}): ${e.message}`);
  }
}

function markRecordPendingTargets(record: any, activeSessions: any): any {
  const normalized = normalizeDeliveryState(record);
  if (normalized.delivery.target_session_ids.length > 0 || normalized.delivered) return { ...record, ...normalized };
  const authorSessionId = extractAuthorSessionId(record);
  const targetSessionIds = (Array.isArray(activeSessions) ? activeSessions : [])
    .filter((session: any) => session
      && session.session_id
      && session.session_id !== authorSessionId
      && !authorMentionsSession(record.author, session.session_id))
    .map((session: any) => session.session_id);
  const completed = targetSessionIds.length === 0;
  return {
    ...record,
    ...normalized,
    delivered: completed,
    delivered_at: completed ? (normalized.delivered_at || new Date().toISOString()) : normalized.delivered_at,
    delivery: {
      ...normalized.delivery,
      status: completed ? 'delivered' : 'pending',
      target_session_ids: targetSessionIds,
      delivered_to_session_ids: normalized.delivery.delivered_to_session_ids,
    },
  };
}

function applySessionDeliveryProgress(record: any, sessionId: string, errorMessage: any): any {
  const normalized = normalizeDeliveryState(record);
  const targetIds = new Set(normalized.delivery.target_session_ids);
  const deliveredTo = new Set(normalized.delivery.delivered_to_session_ids);
  if (sessionId) deliveredTo.add(sessionId);
  const next: any = {
    ...record,
    delivered: false,
    delivered_at: normalized.delivered_at,
    delivery: {
      ...normalized.delivery,
      target_session_ids: Array.from(targetIds),
      delivered_to_session_ids: Array.from(deliveredTo),
      attempt_count: normalized.delivery.attempt_count + 1,
      last_attempt_at: new Date().toISOString(),
      last_error: errorMessage ? String(errorMessage).slice(0, 2000) : null,
      status: 'pending',
    },
  };
  const completed = next.delivery.target_session_ids.length === 0
    || next.delivery.target_session_ids.every((id: string) => next.delivery.delivered_to_session_ids.includes(id));
  if (completed) {
    next.delivered = true;
    next.delivered_at = next.delivered_at || new Date().toISOString();
    next.delivery.status = 'delivered';
  }
  return next;
}

function rewriteBlackboardEntries(filePath: string, entries: any[]): void {
  ensureParentDir(filePath);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const body = entries.map((entry) => {
    if (!entry || entry.error || !entry.record) return entry.rawLine || '';
    return serializeRecord(entry.record);
  }).filter(Boolean).join('\n');
  fs.writeFileSync(tmp, body ? `${body}\n` : '');
  fs.renameSync(tmp, filePath);
}

function appendDeliveryLog(text: string): void {
  try {
    fs.mkdirSync(DELIVERY_LOG_DIR, { recursive: true });
    fs.appendFileSync(DELIVERY_LOG_FILE, text);
  } catch (e) {
    console.warn(`[research-blackboard] 写投递日志失败: ${e.message}`);
  }
}

let deliveryScanning = false;
let deliveryIntervalHandle: NodeJS.Timeout | null = null;
let deliveryKickTimer: NodeJS.Timeout | null = null;
let deliveryStarting = false;

function requestBlackboardDeliveryScan(): NodeJS.Timeout | null {
  if (deliveryKickTimer) return deliveryKickTimer;
  deliveryKickTimer = setTimeout(() => {
    deliveryKickTimer = null;
    safeScanBlackboardDelivery();
  }, 0);
  return deliveryKickTimer;
}

async function scanBlackboardDeliveryOnce(): Promise<void> {
  if (deliveryScanning) return;
  deliveryScanning = true;
  const startedAt = new Date().toISOString();
  try {
    const researches = db.prepare(`
      SELECT r.id AS research_id
      FROM researches r
      INNER JOIN projects p ON p.id = r.project_id
      WHERE p.research_enabled = 1
        AND r.status IN ('active', 'completed')
      ORDER BY r.last_active DESC
    `).all() as Array<{ research_id: string }>;

    for (const researchRow of researches) {
      const researchId = researchRow.research_id;
      const activeSessions = Sessions.listActiveByResearch(researchId);
      const collected = readBlackboardEntries(researchId);
      if (collected.error) {
        appendDeliveryLog(`[${startedAt}] research=${researchId} read_error=${collected.error}\n`);
        continue;
      }

      const entries = collected.entries || [];
      let changed = false;
      for (const entry of entries) {
        if (!entry.record || entry.error) continue;
        const nextRecord = markRecordPendingTargets(entry.record, activeSessions);
        if (JSON.stringify(nextRecord.delivery) !== JSON.stringify(entry.record.delivery)
          || nextRecord.delivered !== entry.record.delivered
          || nextRecord.delivered_at !== entry.record.delivered_at) {
          entry.record = nextRecord;
          changed = true;
        }
      }

      const pendingEntries = entries.filter((entry: any) => entry.record && !normalizeDeliveryState(entry.record).delivered);
      if (pendingEntries.length === 0) {
        if (changed) rewriteBlackboardEntries(collected.file, entries);
        continue;
      }

      const sessionBatchMap = new Map();
      for (const entry of pendingEntries) {
        const normalized = normalizeDeliveryState(entry.record);
        const targets = normalized.delivery.target_session_ids || [];
        for (const sessionId of targets) {
          if (normalized.delivery.delivered_to_session_ids.includes(sessionId)) continue;
          if (!sessionBatchMap.has(sessionId)) sessionBatchMap.set(sessionId, []);
          sessionBatchMap.get(sessionId).push(entry);
        }
      }

      const batchResults = [];
      for (const [sessionId, batchEntries] of sessionBatchMap.entries()) {
        const session = activeSessions.find((s: any) => s.session_id === sessionId);
        if (!session) continue;
        const batchRecords = batchEntries.map((entry: any) => entry.record);
        try {
          await deliverBlackboardBatchToSession({ researchId, session, records: batchRecords });
          for (const entry of batchEntries) {
            entry.record = applySessionDeliveryProgress(entry.record, sessionId, null);
          }
          changed = true;
          batchResults.push(`${sessionId}:ok(${batchRecords.length})`);
        } catch (e) {
          for (const entry of batchEntries) {
            entry.record = applySessionDeliveryProgress(entry.record, sessionId, e.message);
          }
          changed = true;
          batchResults.push(`${sessionId}:fail(${batchRecords.length})`);
          console.warn(`[research-blackboard] 投递失败 research=${researchId} session=${sessionId}: ${e.message}`);
        }
      }

      if (changed) rewriteBlackboardEntries(collected.file, entries);
      appendDeliveryLog(`[${startedAt}] research=${researchId} batches=${batchResults.join(',')} pending=${pendingEntries.length}\n`);
    }
  } catch (e) {
    appendDeliveryLog(`[${new Date().toISOString()}] scan_error=${e && e.stack ? e.stack : e}\n`);
  } finally {
    deliveryScanning = false;
  }
}

function safeScanBlackboardDelivery(): void {
  Promise.resolve().then(scanBlackboardDeliveryOnce).catch((e) => {
    appendDeliveryLog(`[${new Date().toISOString()}] scan_error=${e && e.stack ? e.stack : e}\n`);
  });
}

function startResearchBlackboardDeliveryScanner(): NodeJS.Timeout | null {
  if (deliveryIntervalHandle || deliveryStarting) return deliveryIntervalHandle;
  deliveryStarting = true;
  appendDeliveryLog(
    `\n[${new Date().toISOString()}] ===== research-blackboard-delivery-scanner 启动 ` +
    `(interval=${DELIVERY_SCAN_INTERVAL_MS}ms, first_run_in=${DELIVERY_FIRST_RUN_DELAY_MS}ms) =====\n`
  );
  setTimeout(() => {
    safeScanBlackboardDelivery();
    deliveryIntervalHandle = setInterval(safeScanBlackboardDelivery, DELIVERY_SCAN_INTERVAL_MS);
    deliveryStarting = false;
  }, DELIVERY_FIRST_RUN_DELAY_MS);
  console.log(`[research-blackboard] delivery scanner 已启动, 每 ${DELIVERY_SCAN_INTERVAL_MS / 1000}s 扫描一次 → ${DELIVERY_LOG_FILE}`);
  return deliveryIntervalHandle;
}

export {
  blackboardUrl,
  resolveBlackboardFile,
  readBlackboard,
  readBlackboardEntries,
  appendBlackboardRecord,
  requestBlackboardDeliveryScan,
  startResearchBlackboardDeliveryScanner,
  scanBlackboardDeliveryOnce,
  buildNotifyPrompt,
  normalizeWriteInput,
};
