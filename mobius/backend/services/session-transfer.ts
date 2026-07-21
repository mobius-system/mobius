import * as fs from 'fs';
import * as path from 'path';
import { HIDDEN_FOLDER_NAME } from '../config';

const MAX_TEXT_CHARS = 20000;
const MAX_TOTAL_CHARS = 800000;

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

function mobiusJsonlPathOf(jsonlPath: any): string | null {
  if (!jsonlPath || typeof jsonlPath !== 'string') return null;
  return jsonlPath.endsWith('.jsonl')
    ? jsonlPath.slice(0, -'.jsonl'.length) + '.mobius.jsonl'
    : `${jsonlPath}.mobius.jsonl`;
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

function readJsonlRecords(filePath: any, source: string): any[] {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const records = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      records.push({ entry: JSON.parse(line), source, index: i });
    } catch {}
  }
  return records;
}

function readAllMergedJsonlRecords(jsonlPath: any): any[] {
  const primary = readJsonlRecords(jsonlPath, 'primary');
  const mobius = readJsonlRecords(mobiusJsonlPathOf(jsonlPath), 'mobius');
  const records = primary.concat(mobius);
  records.sort((a, b) => {
    const at = parseTimestampMs(a.entry);
    const bt = parseTimestampMs(b.entry);
    if (at != null && bt != null && at !== bt) return at - bt;
    if (at == null && bt != null) return -1;
    if (at != null && bt == null) return 1;
    if (a.source !== b.source) return a.source === 'primary' ? -1 : 1;
    return a.index - b.index;
  });
  return records;
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
  const text = String(body || '').trim();
  if (!text) return;
  const clipped = truncateText(text, maxTextChars);
  sections.push({ title, body: clipped.body, truncated: clipped.truncated });
}

function entrySections(entry: any, index: number, maxTextChars: number | null): TransferSection[] {
  const sections: TransferSection[] = [];
  const type = entry?.type;
  const payload = entry?.payload;
  const prefix = `#${index + 1}`;

  if (type === 'user') {
    addSection(sections, `${prefix} 用户输入`, contentText(entry?.message?.content), maxTextChars);
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
        addSection(sections, `${prefix} Bash 命令`, fence(block.input.command, 'bash'), maxTextChars);
      } else if (block.name === 'Write') {
        const write = normalizeWriteInput(block.input);
        if (write) addSection(sections, `${prefix} 写入文件 ${write.filePath}`, fence(write.content), maxTextChars);
      } else if (block.name === 'Edit') {
        const input = block.input || {};
        if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
          const filePath = typeof input.file_path === 'string' ? input.file_path : '(unknown file)';
          addSection(
            sections,
            `${prefix} 编辑文件 ${filePath}`,
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
          `${prefix} 工具调用 ${block.name || 'tool'}`,
          fence(JSON.stringify(block.input || {}, null, 2), 'json'),
          maxTextChars,
        );
      }
    }
    addSection(sections, `${prefix} 智能体回复`, textParts.join('\n\n'), maxTextChars);
    return sections;
  }

  if (type === 'response_item') {
    if (payload?.type === 'message') {
      addSection(
        sections,
        `${prefix} ${payload.role === 'assistant' ? '智能体回复' : payload.role === 'user' ? '用户消息' : '消息'}`,
        contentText(payload.content),
        maxTextChars,
      );
    } else if (payload?.type === 'function_call') {
      if (payload.name === 'Write') {
        const args = parseJsonMaybe(payload.arguments);
        const write = normalizeWriteInput(payload.input ?? args?.input ?? args);
        if (write) addSection(sections, `${prefix} 写入文件 ${write.filePath}`, fence(write.content), maxTextChars);
      } else {
        const cmd = functionCommand(payload);
        if (cmd) addSection(sections, `${prefix} Bash 命令`, fence(cmd, 'bash'), maxTextChars);
        else {
          addSection(
            sections,
            `${prefix} 工具调用 ${payload.name || 'function_call'}`,
            fence(payload.arguments || JSON.stringify(payload.input || {}, null, 2), 'json'),
            maxTextChars,
          );
        }
      }
    } else if (payload?.type === 'function_call_output') {
      addSection(sections, `${prefix} 工具结果`, fence(functionOutputBody(payload.output)), maxTextChars);
    }
    return sections;
  }

  if (type === 'event_msg') {
    if (payload?.type === 'agent_message' || payload?.type === 'user_message') {
      addSection(
        sections,
        `${prefix} ${payload.type === 'agent_message' ? '智能体消息' : '用户消息'}`,
        payload.message,
        maxTextChars,
      );
    } else if (payload?.type === 'patch_apply_end' && payload.changes && typeof payload.changes === 'object') {
      for (const [filePath, change] of Object.entries(payload.changes)) {
        const diff = (change as any)?.unified_diff;
        if (typeof diff === 'string' && diff.trim()) {
          addSection(sections, `${prefix} 补丁 ${filePath}`, fence(diff, 'diff'), maxTextChars);
        }
      }
    } else if (payload?.type === 'task_complete') {
      addSection(sections, `${prefix} 任务完成事件`, `duration_ms: ${payload.duration_ms || 0}`, maxTextChars);
    }
    return sections;
  }

  if (type === 'attachment') {
    const attachment = entry.attachment;
    if (typeof attachment === 'string') addSection(sections, `${prefix} 附件`, attachment, maxTextChars);
    else if (attachment?.content) {
      addSection(
        sections,
        `${prefix} 附件 ${attachment.type || ''}`,
        JSON.stringify(attachment.content, null, 2),
        maxTextChars,
      );
    }
  }

  return sections;
}

function userMessageBody(entry: any): string {
  if (entry?.type === 'user') return contentText(entry?.message?.content).trim();
  if (entry?.type === 'response_item' && entry?.payload?.type === 'message' && entry?.payload?.role === 'user') {
    return contentText(entry.payload.content).trim();
  }
  if (entry?.type === 'event_msg' && entry?.payload?.type === 'user_message') {
    return String(entry.payload.message || '').trim();
  }
  if (entry?.type === 'user_message') {
    return String(entry?.message ?? entry?.payload?.message ?? '').trim();
  }
  return '';
}

function extractSessionTransferData({ jsonlPath, maxTextChars = MAX_TEXT_CHARS }: any): any {
  const records = readAllMergedJsonlRecords(jsonlPath);
  const sections: TransferSection[] = [];
  const userMessages: TransferUserMessage[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const entry = records[i].entry;
    sections.push(...entrySections(entry, i, maxTextChars));
    const body = userMessageBody(entry);
    if (body) userMessages.push({ index: i + 1, timestamp: timestampIso(entry), body });
  }
  return { records, sections, userMessages };
}

function buildFullTransferMarkdown({
  sourceSession,
  targetSessionId,
  jsonlPath,
  sections,
  entryCount,
  generatedAt,
  maxTotalChars = MAX_TOTAL_CHARS,
}: any): any {
  const header = [
    `# Session 转接文档: ${sourceSession.name || sourceSession.session_id}`,
    '',
    `- 原 Session ID: ${sourceSession.session_id}`,
    `- 新 Session ID: ${targetSessionId || ''}`,
    `- 原 Session 标题: ${sourceSession.name || ''}`,
    `- 原 Session 目的: ${sourceSession.description || ''}`,
    `- 生成时间: ${generatedAt}`,
    `- 来源 JSONL: ${jsonlPath}`,
    '',
    '下面内容由旧 Session 的 JSONL 自动提取，包含前端精简模式和代码模式可展示的关键卡片，用于更换模型后继续上下文。',
  ].join('\n');

  let totalChars = header.length;
  let writtenSectionCount = 0;
  const bodyParts = [];
  for (const section of sections as TransferSection[]) {
    const part = `\n\n## ${section.title}\n\n${section.body}`;
    if (maxTotalChars != null && totalChars + part.length > maxTotalChars) {
      bodyParts.push(`\n\n## 已截断\n\n转接文档超过 ${maxTotalChars} 字，后续卡片未写入。`);
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
  const parts = userMessages.map((message: TransferUserMessage, index: number) => [
    `## 用户消息 #${index + 1}`,
    '',
    `- 原记录序号: ${message.index}`,
    ...(message.timestamp ? [`- 时间: ${message.timestamp}`] : []),
    '',
    message.body,
  ].join('\n'));
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
}: any): any {
  return {
    format_version: 1,
    generated_at: generatedAt,
    source_session: sourceSessionMetadata(sourceSession),
    target_session: { session_id: targetSessionId },
    source_records: {
      jsonl_path: path.resolve(jsonlPath),
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
  if (!jsonlPath) throw new Error('旧 Session 没有可读取的 JSONL 路径');
  const generatedAt = new Date().toISOString();
  const data = extractSessionTransferData({ jsonlPath, maxTextChars });
  return buildFullTransferMarkdown({
    sourceSession,
    targetSessionId,
    jsonlPath,
    sections: data.sections,
    entryCount: data.records.length,
    generatedAt,
    maxTotalChars,
  });
}

function writeSessionTransferBundle({ bindPath, sourceSession, targetSessionId, jsonlPath }: any): any {
  if (!bindPath || !sourceSession?.session_id || !targetSessionId) {
    throw new Error('创建 Session 转接文件缺少 bindPath、sourceSession 或 targetSessionId');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(String(targetSessionId))) {
    throw new Error('目标 Session ID 非法，无法创建转接文件');
  }
  if (!jsonlPath) throw new Error('旧 Session 没有可读取的 JSONL 路径');

  const generatedAt = new Date().toISOString();
  const data = extractSessionTransferData({ jsonlPath, maxTextChars: null });
  const dir = path.join(path.resolve(bindPath), HIDDEN_FOLDER_NAME, 'change_model', String(targetSessionId));
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

function transferReferencePrompt(paths: TransferPaths, content: any): string {
  const fullPath = typeof paths?.full === 'string' && paths.full.trim() ? path.resolve(paths.full) : null;
  const userMessagesPath = typeof paths?.user_messages === 'string' && paths.user_messages.trim()
    ? path.resolve(paths.user_messages)
    : null;
  const metadataPath = typeof paths?.metadata === 'string' && paths.metadata.trim()
    ? path.resolve(paths.metadata)
    : null;
  const pathLines = [
    fullPath ? `1. 完整记录：\`${fullPath}\`` : null,
    userMessagesPath ? `2. 仅用户消息：\`${userMessagesPath}\`` : null,
    metadataPath ? `3. 旧 Session 元数据：\`${metadataPath}\`` : null,
  ].filter(Boolean);
  if (pathLines.length === 0) return String(content || '');
  return [
    content,
    '',
    '---',
    '',
    '这是一个从旧 Session 转接而来的新 Session。',
    '',
    '旧 Session 的转接资料保存在以下文件：',
    '',
    ...pathLines,
    '',
    '开始执行前，请先读取旧 Session 元数据和用户消息，理解用户目标、后续补充及最后要求。',
    '需要了解之前 Agent 已完成的工作、工具调用、命令输出或文件修改时，再读取完整记录。',
    '完整记录较长时可以分段读取，并优先检查文件尾部的最新卡片。',
    '不要修改或删除以上转接文件。',
  ].join('\n');
}

export {
  buildSessionTransferMarkdown,
  writeSessionTransferBundle,
  transferReferencePrompt,
};
