import * as fs from 'fs';
import * as path from 'path';
import { HIDDEN_FOLDER_NAME } from '../config';
import { db } from '../../db';
import { syncAndIterateStoredEntries } from './mobius-agent-history';

const MAX_TEXT_CHARS = 20000;
const MAX_TOTAL_CHARS = 800000;
// 单条 jsonl 记录的超长保护与全文兜底上限 — V8 单字符串上限约 536M 字符
// (0x1fffffe8), 不设防的整文件读取/拼接会直接抛 "Cannot create a string
// longer than 0x1fffffe8 characters" (2026-11-17 实测 1.4GB rollout)。
// Per-record and whole-document guards — V8 caps one string at ~536M chars,
// so unbounded whole-file reads/joins throw hard on giant rollouts.
const MAX_JSONL_LINE_CHARS = 32_000_000;
const HARD_TOTAL_CHARS = 200_000_000;
// ≥512 连续 base64 字符在正文里只可能是内嵌二进制(图片), 转接文档一律换成占位符。
// 注意不能用正则 replace: V8 在匹配数百万字符的超长 run 时会抛
// "Maximum call stack size exceeded" (实测 8M 字符即炸), 这里用手动线性扫描。
// A 512+ contiguous base64 run in prose is always embedded binary (images) and
// becomes a placeholder. Regex replace is unusable here — V8 throws
// "Maximum call stack size exceeded" matching multi-million-char runs — so this
// is a manual linear scan (iterative, no recursion).
function isB64CharCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    || (code >= 48 && code <= 57) || code === 43 || code === 47;
}

function stripBinaryHunks(text: string): string {
  const n = text.length;
  if (n < 512) return text;
  let out = '';
  let copied = 0;
  let runStart = -1;
  let changed = false;
  for (let i = 0; i <= n; i += 1) {
    if (i < n && isB64CharCode(text.charCodeAt(i))) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart < 0) continue;
    const runLen = i - runStart;
    if (runLen >= 512) {
      out += `${text.slice(copied, runStart)}[已省略内嵌数据 ${runLen} 字符]`;
      copied = i;
      changed = true;
    }
    runStart = -1;
  }
  if (!changed) return text;
  return out + text.slice(copied);
}

interface TransferSection {
  title: string;
  body: string;
  truncated: boolean;
}

interface TransferUserMessage {
  index: number;
  timestamp: string | null;
  body: string;
}

interface TransferPaths {
  full: string | null;
  user_messages: string | null;
  metadata: string | null;
}

function fence(text: any, language: string = ''): string {
  const body = String(text || '').replace(/\s+$/, '');
  const ticks = body.match(/`{3,}/g);
  const longest = ticks ? Math.max(...ticks.map((s) => s.length)) : 2;
  const mark = '`'.repeat(Math.max(3, longest + 1));
  return `${mark}${language || ''}\n${body}\n${mark}`;
}

function truncateText(text: any, limit: number | null = MAX_TEXT_CHARS): { body: string; truncated: boolean } {
  const body = String(text || '');
  if (limit == null || body.length <= limit) return { body, truncated: false };
  return {
    body: `${body.slice(0, limit)}\n\n...[已截断 ${body.length - limit} 字]`,
    truncated: true,
  };
}

function parseJsonMaybe(value: any): any {
  if (!value || typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function parseTimestampMs(entry: any): number | null {
  const candidates = [
    entry?.timestamp,
    entry?.created_at,
    entry?.payload?.timestamp,
    entry?.message?.created_at,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const ms = new Date(raw).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function timestampIso(entry: any): string | null {
  const ms = parseTimestampMs(entry);
  return ms == null ? null : new Date(ms).toISOString();
}

function contentText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      if (typeof block.text === 'string') return block.text;
      if (typeof block.input_text === 'string') return block.input_text;
      if (typeof block.output_text === 'string') return block.output_text;
      if (typeof block.thinking === 'string') return block.thinking;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeWriteInput(input: any): { filePath: string; content: string } | null {
  if (!input || typeof input !== 'object') return null;
  const filePath = input.file_path ?? input.filePath ?? input.path;
  const content = input.content;
  if (typeof filePath !== 'string' || !filePath.trim() || typeof content !== 'string') return null;
  return { filePath: filePath.trim(), content };
}

function functionOutputBody(output: any): string {
  const text = String(output ?? '');
  const marker = 'Output:';
  const idx = text.indexOf(marker);
  return idx >= 0 ? text.slice(idx + marker.length).trimStart() : text;
}

/*
 * custom_tool_call_output (aimux MCP 工具) 的输出是 content block 数组, 其中
 * input_image 携带整张图的 base64 — 转接文档只保留文字, 图片换成占位符,
 * 否则一次 36 张图的标注结果就能把文档撑爆。
 * custom_tool_call_output (aimux MCP tools) returns a content-block array whose
 * input_image blocks carry whole base64 images — the transfer digest keeps only
 * the text and replaces each image with a placeholder.
 */
function customToolOutputBody(output: any): string {
  if (!Array.isArray(output)) return functionOutputBody(output);
  const parts = output.map((block: any) => {
    if (!block || typeof block !== 'object') return '';
    if (typeof block.text === 'string') return block.text;
    if (typeof block.input_text === 'string') return block.input_text;
    if (block.type === 'input_image' || typeof block.image_url === 'string') {
      const url = typeof block.image_url === 'string' ? block.image_url : '';
      // 估算大小走下标运算不用正则 — 超长 base64 上正则会栈溢出
      // size estimate via index math, not regex — regex overflows on giant runs
      const marker = url.indexOf('base64,');
      const b64Chars = marker >= 0 ? Math.max(0, url.length - marker - 7) : 0;
      const kb = Math.round((b64Chars * 3 / 4) / 1024);
      return `[图片已屏蔽${b64Chars ? ` 约${kb}KB` : ''}]`;
    }
    return '';
  }).filter(Boolean);
  return parts.join('\n');
}

function functionCommand(payload: any): string | null {
  const args = parseJsonMaybe(payload?.arguments);
  const cmd = args?.cmd ?? args?.command ?? args?.input?.cmd ?? args?.input?.command;
  return typeof cmd === 'string' && cmd.trim() ? cmd.trim() : null;
}

function extractAssistantBlocks(entry: any): any[] {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content : [];
}

function addSection(sections: TransferSection[], title: string, body: any, maxTextChars: number | null): void {
  // ✨ 图片/base64 屏蔽的唯一入口 — 所有进入转接文档的正文都在这里过一遍
  // ✨ the single choke point where every body is stripped of embedded binary
  const text = stripBinaryHunks(String(body || '')).trim();
  if (!text) return;
  const clipped = truncateText(text, maxTextChars);
  sections.push({ title, body: clipped.body, truncated: clipped.truncated });
}

function entrySections(entry: any, maxTextChars: number | null): TransferSection[] {
  const sections: TransferSection[] = [];
  const type = entry?.type;
  const payload = entry?.payload;

  if (type === 'user') {
    addSection(sections, `用户输入`, contentText(entry?.message?.content), maxTextChars);
    return sections;
  }

  if (type === 'assistant') {
    const blocks = extractAssistantBlocks(entry);
    const textParts = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
        continue;
      }
      if (block.type !== 'tool_use') continue;
      if (block.name === 'Bash' && typeof block.input?.command === 'string') {
        addSection(sections, `Bash 命令`, fence(block.input.command, 'bash'), maxTextChars);
      } else if (block.name === 'Write') {
        const write = normalizeWriteInput(block.input);
        if (write) addSection(sections, `写入文件 ${write.filePath}`, fence(write.content), maxTextChars);
      } else if (block.name === 'Edit') {
        const input = block.input || {};
        if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
          const filePath = typeof input.file_path === 'string' ? input.file_path : '(unknown file)';
          addSection(
            sections,
            `编辑文件 ${filePath}`,
            [
              'old_string:',
              fence(input.old_string || ''),
              '',
              'new_string:',
              fence(input.new_string || ''),
            ].join('\n'),
            maxTextChars,
          );
        }
      } else {
        addSection(
          sections,
          `工具调用 ${block.name || 'tool'}`,
          fence(JSON.stringify(block.input || {}, null, 2), 'json'),
          maxTextChars,
        );
      }
    }
    addSection(sections, `智能体回复`, textParts.join('\n\n'), maxTextChars);
    return sections;
  }

  if (type === 'response_item') {
    if (payload?.type === 'message') {
      addSection(
        sections,
        `${payload.role === 'assistant' ? '智能体回复' : payload.role === 'user' ? '用户消息' : '消息'}`,
        contentText(payload.content),
        maxTextChars,
      );
    } else if (payload?.type === 'function_call') {
      if (payload.name === 'Write') {
        const args = parseJsonMaybe(payload.arguments);
        const write = normalizeWriteInput(payload.input ?? args?.input ?? args);
        if (write) addSection(sections, `写入文件 ${write.filePath}`, fence(write.content), maxTextChars);
      } else {
        const cmd = functionCommand(payload);
        if (cmd) addSection(sections, `Bash 命令`, fence(cmd, 'bash'), maxTextChars);
        else {
          addSection(
            sections,
            `工具调用 ${payload.name || 'function_call'}`,
            fence(payload.arguments || JSON.stringify(payload.input || {}, null, 2), 'json'),
            maxTextChars,
          );
        }
      }
    } else if (payload?.type === 'function_call_output') {
      addSection(sections, `工具结果`, fence(functionOutputBody(payload.output)), maxTextChars);
    } else if (payload?.type === 'custom_tool_call_output') {
      // aimux MCP 工具结果: 文字进文档, 内嵌图片换占位符
      // aimux MCP tool result: text goes in, inline images become placeholders
      addSection(sections, `工具结果`, fence(customToolOutputBody(payload.output)), maxTextChars);
    }
    return sections;
  }

  if (type === 'event_msg') {
    if (payload?.type === 'agent_message' || payload?.type === 'user_message') {
      addSection(
        sections,
        `${payload.type === 'agent_message' ? '智能体消息' : '用户消息'}`,
        payload.message,
        maxTextChars,
      );
    } else if (payload?.type === 'patch_apply_end' && payload.changes && typeof payload.changes === 'object') {
      for (const [filePath, change] of Object.entries(payload.changes)) {
        const diff = (change as any)?.unified_diff;
        if (typeof diff === 'string' && diff.trim()) {
          addSection(sections, `补丁 ${filePath}`, fence(diff, 'diff'), maxTextChars);
        }
      }
    } else if (payload?.type === 'task_complete') {
      addSection(sections, `任务完成事件`, `duration_ms: ${payload.duration_ms || 0}`, maxTextChars);
    }
    return sections;
  }

  if (type === 'attachment') {
    const attachment = entry.attachment;
    if (typeof attachment === 'string') addSection(sections, `附件`, attachment, maxTextChars);
    else if (attachment?.content) {
      addSection(
        sections,
        `附件 ${attachment.type || ''}`,
        JSON.stringify(attachment.content, null, 2),
        maxTextChars,
      );
    }
  }

  return sections;
}

function userMessageBody(entry: any): string {
  if (entry?.type === 'user') return stripBinaryHunks(contentText(entry?.message?.content)).trim();
  if (entry?.type === 'response_item' && entry?.payload?.type === 'message' && entry?.payload?.role === 'user') {
    return stripBinaryHunks(contentText(entry.payload.content)).trim();
  }
  if (entry?.type === 'event_msg' && entry?.payload?.type === 'user_message') {
    return stripBinaryHunks(String(entry.payload.message || '')).trim();
  }
  if (entry?.type === 'user_message') {
    return stripBinaryHunks(String(entry?.message ?? entry?.payload?.message ?? '')).trim();
  }
  return '';
}

/*
 * 从会话历史库提取转接数据 (唯一数据源, 不读任何 jsonl 文件):
 * syncAndIterateStoredEntries 先把原生轨增量同步进库, 再按 seq 流式回调整条
 * 会话; 这里只保留轻量元组 (时间戳 + 已截断/已屏蔽的 section + 用户消息),
 * 排序后统一编号。原生文件不在也能完整出文档 (2026-11-24 事故的场景)。
 * Extract the digest purely from the session history store — no jsonl file is
 * ever read here. syncAndIterateStoredEntries first brings the store up to date
 * from the native track, then streams the whole session by seq; only lightweight
 * tuples (timestamp + stripped sections + user message) are kept, sorted and
 * numbered afterwards. A missing native file changes nothing.
 */
function extractSessionTransferData({ sessionId, jsonlPath, maxTextChars = MAX_TEXT_CHARS }: any): any {
  const collected: Array<{
    tsMs: number | null;
    index: number;
    sections: TransferSection[];
    userMessage: { timestamp: string | null; body: string } | null;
  }> = [];
  let skippedOversized = 0;
  const ingest = (entry: any, index: number) => {
    const sections = entrySections(entry, maxTextChars);
    const body = userMessageBody(entry);
    collected.push({
      tsMs: parseTimestampMs(entry),
      index,
      sections,
      userMessage: body ? { timestamp: timestampIso(entry), body } : null,
    });
  };
  const stats = syncAndIterateStoredEntries(String(sessionId || ''), jsonlPath || null, ingest, {
    maxRowChars: MAX_JSONL_LINE_CHARS,
  });
  skippedOversized += stats.skippedOversized;

  collected.sort((a, b) => {
    if (a.tsMs != null && b.tsMs != null && a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
    if (a.tsMs == null && b.tsMs != null) return -1;
    if (a.tsMs != null && b.tsMs == null) return 1;
    return a.index - b.index;
  });

  const sections: TransferSection[] = [];
  const userMessages: TransferUserMessage[] = [];
  for (let i = 0; i < collected.length; i += 1) {
    const record = collected[i];
    const prefix = `#${i + 1}`;
    for (const section of record.sections) {
      sections.push({ title: `${prefix} ${section.title}`, body: section.body, truncated: section.truncated });
    }
    if (record.userMessage) {
      userMessages.push({ index: i + 1, timestamp: record.userMessage.timestamp, body: record.userMessage.body });
    }
  }
  if (skippedOversized > 0) {
    sections.push({
      title: `#${collected.length + 1} 转接提取说明`,
      body: `有 ${skippedOversized} 条超过 ${MAX_JSONL_LINE_CHARS} 字符的单行记录被跳过（通常是内嵌图片等二进制数据）。`,
      truncated: false,
    });
  }
  return {
    records: collected,
    sections,
    userMessages,
    entryCount: collected.length,
    skippedOversized,
    sync: stats,
  };
}

function buildFullTransferMarkdown({
  sourceSession,
  targetSessionId,
  jsonlPath,
  sections,
  entryCount,
  generatedAt,
  maxTotalChars = MAX_TOTAL_CHARS,
  sync = null,
}: any): any {
  const header = [
    `# Session 转接文档: ${sourceSession.name || sourceSession.session_id}`,
    '',
    `- 原 Session ID: ${sourceSession.session_id}`,
    `- 新 Session ID: ${targetSessionId || ''}`,
    `- 原 Session 标题: ${sourceSession.name || ''}`,
    `- 原 Session 目的: ${sourceSession.description || ''}`,
    `- 生成时间: ${generatedAt}`,
    ...(jsonlPath ? [`- 原生 JSONL: ${jsonlPath}`] : []),
    '- 记录来源: 会话历史数据库 (agent-history-store)',
    `- 记录同步截至: ${sync?.lastSyncedAt || '未知'} (共 ${entryCount} 条记录)`,
    '',
    '下面内容由旧 Session 的历史库记录自动提取，包含前端精简模式和代码模式可展示的关键卡片，用于更换模型后继续上下文。',
  ].join('\n');

  let totalChars = header.length;
  let writtenSectionCount = 0;
  // change_model 路径 maxTotalChars=null (不主动截断), 但仍要有 V8 硬上限兜底
  // change_model passes maxTotalChars=null (no eager truncation); the hard cap
  // below still guards the final join against V8's ~536M-char string limit.
  const effectiveTotalLimit = maxTotalChars ?? HARD_TOTAL_CHARS;
  const bodyParts = [];
  // 同步异常 → 文档最前放警示卡: 内容来自库里已入库的部分, 可能缺最近更新;
  // 绝不回退去读文件 (无回退是本方案的设计决策)。
  // Sync failure → a leading warning card: content covers only what was ingested
  // and may miss the latest turns; we never fall back to reading files.
  if (sync?.syncError) {
    const warning = `\n\n## ⚠️ 同步异常\n\n原生会话记录同步到历史库时报错（${sync.syncError}），以下内容可能不含最后一次同步之后的最新进展。`;
    bodyParts.push(warning);
    totalChars += warning.length;
  }
  for (const section of sections as TransferSection[]) {
    const part = `\n\n## ${section.title}\n\n${section.body}`;
    if (totalChars + part.length > effectiveTotalLimit) {
      bodyParts.push(`\n\n## 已截断\n\n转接文档超过 ${effectiveTotalLimit} 字，后续卡片未写入。`);
      break;
    }
    totalChars += part.length;
    writtenSectionCount += 1;
    bodyParts.push(part);
  }
  if (sections.length === 0) {
    bodyParts.push('\n\n## 空记录\n\n旧 Session 暂未提取到可转接的精简/代码卡片。');
  }

  const cardsOmitted = writtenSectionCount < sections.length;
  const individualCardsTruncated = (sections as TransferSection[]).some((section) => section.truncated);
  return {
    markdown: `${header}${bodyParts.join('')}\n`,
    sectionCount: sections.length,
    writtenSectionCount,
    entryCount,
    cardsOmitted,
    individualCardsTruncated,
    truncated: cardsOmitted || individualCardsTruncated,
  };
}

function buildUserMessagesMarkdown({ sourceSession, targetSessionId, userMessages, generatedAt }: any): string {
  const header = [
    `# 旧 Session 用户消息: ${sourceSession.name || sourceSession.session_id}`,
    '',
    `- 原 Session ID: ${sourceSession.session_id}`,
    `- 新 Session ID: ${targetSessionId || ''}`,
    `- 用户消息数量: ${userMessages.length}`,
    `- 生成时间: ${generatedAt}`,
  ].join('\n');
  if (userMessages.length === 0) return `${header}\n\n## 空记录\n\n旧 Session 暂未提取到用户消息。\n`;
  const parts: string[] = [];
  let totalChars = header.length;
  for (let index = 0; index < userMessages.length; index += 1) {
    const message = userMessages[index];
    const part = [
      `## 用户消息 #${index + 1}`,
      '',
      `- 原记录序号: ${message.index}`,
      ...(message.timestamp ? [`- 时间: ${message.timestamp}`] : []),
      '',
      message.body,
    ].join('\n');
    if (totalChars + part.length > HARD_TOTAL_CHARS) {
      parts.push(`## 已截断\n\n用户消息超过 ${HARD_TOTAL_CHARS} 字，后续消息未写入。`);
      break;
    }
    totalChars += part.length;
    parts.push(part);
  }
  return `${header}\n\n${parts.join('\n\n')}\n`;
}

function sourceSessionMetadata(sourceSession: any): any {
  const fields = [
    'session_id',
    'issue_id',
    'project_id',
    'scope_type',
    'research_id',
    'research_role',
    'name',
    'description',
    'model',
    'language',
    'status',
    'agent_status',
    'created_at',
    'last_active',
    'completed_at',
    'message_count',
    'turn_count',
  ];
  const metadata: any = {};
  for (const field of fields) {
    if (sourceSession?.[field] !== undefined) metadata[field] = sourceSession[field];
  }
  return metadata;
}

function buildSessionMetadata({
  sourceSession,
  targetSessionId,
  jsonlPath,
  paths,
  generatedAt,
  entryCount,
  sectionCount,
  userMessageCount,
  individualCardsTruncated,
  sync = null,
}: any): any {
  return {
    format_version: 1,
    generated_at: generatedAt,
    source_session: sourceSessionMetadata(sourceSession),
    target_session: { session_id: targetSessionId },
    source_records: {
      records_source: 'history_store',
      native_jsonl_path: jsonlPath ? path.resolve(jsonlPath) : null,
      sync_ok: sync ? sync.syncOk === true : null,
      sync_error: sync?.syncError || null,
      synced_at: sync?.lastSyncedAt || null,
      skipped_oversized: sync?.skippedOversized || 0,
      entry_count: entryCount,
      section_count: sectionCount,
      user_message_count: userMessageCount,
    },
    transfer_files: {
      full: paths.full,
      user_messages: paths.user_messages,
      metadata: paths.metadata,
    },
    truncation: {
      cards_omitted: false,
      individual_cards_truncated: individualCardsTruncated,
    },
  };
}

function writeFileAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}

function buildSessionTransferMarkdown({
  sourceSession,
  targetSessionId,
  jsonlPath,
  maxTextChars = MAX_TEXT_CHARS,
  maxTotalChars = MAX_TOTAL_CHARS,
}: any): any {
  if (!sourceSession?.session_id) throw new Error('创建 Session 转接文档缺少 sourceSession');
  const generatedAt = new Date().toISOString();
  const data = extractSessionTransferData({ sessionId: sourceSession.session_id, jsonlPath, maxTextChars });
  return buildFullTransferMarkdown({
    sourceSession,
    targetSessionId,
    jsonlPath,
    sections: data.sections,
    entryCount: data.records.length,
    generatedAt,
    maxTotalChars,
    sync: data.sync,
  });
}

function safePathSegment(value: any, fallback: string): string {
  const normalized = String(value || '').trim();
  return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : fallback;
}

function writeSessionTransferBundle({
  bindPath,
  sourceSession,
  targetSessionId,
  jsonlPath,
  directoryName = 'change_model',
}: any): any {
  if (!bindPath || !sourceSession?.session_id || !targetSessionId) {
    throw new Error('创建 Session 转接文件缺少 bindPath、sourceSession 或 targetSessionId');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(String(targetSessionId))) {
    throw new Error('目标 Session ID 非法，无法创建转接文件');
  }

  const generatedAt = new Date().toISOString();
  const data = extractSessionTransferData({ sessionId: sourceSession.session_id, jsonlPath, maxTextChars: null });
  // 历史库里一条记录都没有 → 显式失败, 绝不生成空转接文档, 也绝不回退读文件
  // (2026-11-24 事故: 静默空文档让新会话零上下文冷启动).
  // Nothing in the history store → fail loudly; no silent empty digest and no
  // file-reading fallback (fallback-free is a deliberate design decision).
  if (data.records.length === 0) {
    throw new Error('旧 Session 在历史库中没有可读取的会话记录, 无法生成转接文档, 已取消接续');
  }
  const transferDir = safePathSegment(directoryName, 'change_model');
  // 更换模型继续沿用历史路径；跨 Agent 引用按 source/target 分目录，避免
  // 同一目标 Session 连续 @ 多个来源时相互覆盖转接文件。
  const dir = transferDir === 'change_model'
    ? path.join(path.resolve(bindPath), HIDDEN_FOLDER_NAME, transferDir, String(targetSessionId))
    : path.join(
      path.resolve(bindPath),
      HIDDEN_FOLDER_NAME,
      transferDir,
      safePathSegment(sourceSession.session_id, 'source'),
      safePathSegment(targetSessionId, 'target'),
    );
  fs.mkdirSync(dir, { recursive: true });
  const paths: TransferPaths = {
    full: path.join(dir, 'full.md'),
    user_messages: path.join(dir, 'user_messages.md'),
    metadata: path.join(dir, 'session_metadata.json'),
  };
  const full = buildFullTransferMarkdown({
    sourceSession,
    targetSessionId,
    jsonlPath,
    sections: data.sections,
    entryCount: data.records.length,
    generatedAt,
    maxTotalChars: null,
    sync: data.sync,
  });
  const userMessagesMarkdown = buildUserMessagesMarkdown({
    sourceSession,
    targetSessionId,
    userMessages: data.userMessages,
    generatedAt,
  });
  const metadata = buildSessionMetadata({
    sourceSession,
    targetSessionId,
    jsonlPath,
    paths,
    generatedAt,
    entryCount: data.records.length,
    sectionCount: data.sections.length,
    userMessageCount: data.userMessages.length,
    individualCardsTruncated: full.individualCardsTruncated,
    sync: data.sync,
  });

  writeFileAtomic(paths.full as string, full.markdown);
  writeFileAtomic(paths.user_messages as string, userMessagesMarkdown);
  writeFileAtomic(paths.metadata as string, `${JSON.stringify(metadata, null, 2)}\n`);
  return {
    paths,
    filePath: paths.full,
    sectionCount: data.sections.length,
    entryCount: data.records.length,
    userMessageCount: data.userMessages.length,
    cardsOmitted: false,
    individualCardsTruncated: full.individualCardsTruncated,
    truncated: full.individualCardsTruncated,
  };
}

/*
 * Latest session_transfer bundle paths recorded for a session (messages_v2
 * system row), resolved to absolute paths — or null when there is none. This
 * feeds the 旧会话转接 section via gatherSources; transferReferencePrompt uses
 * it only to decide whether the separator wrap applies.
 */
export function pendingTransferPaths(sessionId: any): { full: string | null; user_messages: string | null; metadata: string | null } | null {
  try {
    const row = db.prepare(`
      SELECT content
      FROM messages_v2
      WHERE task_id = ? AND role = 'system' AND turn_summary = 'session_transfer'
      ORDER BY id DESC
      LIMIT 1
    `).get(sessionId) as { content?: string } | undefined;
    if (!row?.content) return null;
    const parsed = JSON.parse(row.content);
    const resolveOr = (v: any) => (typeof v === 'string' && v.trim() ? path.resolve(v.trim()) : null);
    const full = resolveOr(parsed?.paths?.full);
    const userMessages = resolveOr(parsed?.paths?.user_messages);
    const metadata = resolveOr(parsed?.paths?.metadata);
    return full || userMessages || metadata ? { full, user_messages: userMessages, metadata } : null;
  } catch {
    return null;
  }
}

/*
 * Wrap the assembled first message with the transfer separator when this
 * session was transferred: the preamble itself (notice + paths + reading
 * instructions) lives in the 旧会话转接 section (session-context-sections.ts)
 * and is hoisted with the other context sections; the message keeps only the
 * "--- latest instruction ---" separator, the content and the tail rule.
 */
function transferReferencePrompt(paths: TransferPaths, content: any): string {
  const hasPaths = Boolean(paths && (paths.full || paths.user_messages || paths.metadata));
  if (!hasPaths) return String(content || '');
  return [
    '--- 下面是用户的最新指令，请在理解前文的基础上，执行最新指令 ---',
    '',
    content,
    '',
    '------',
  ].join('\n');
}

export {
  buildSessionTransferMarkdown,
  writeSessionTransferBundle,
  transferReferencePrompt,
};
