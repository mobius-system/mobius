import * as fs from 'fs';
import * as path from 'path';

const MAX_TEXT_CHARS = 20000;
const MAX_TOTAL_CHARS = 800000;

function fence(text: any, language: string = ''): string {
  const body = String(text || '').replace(/\s+$/, '');
  const ticks = body.match(/`{3,}/g);
  const longest = ticks ? Math.max(...ticks.map((s) => s.length)) : 2;
  const mark = '`'.repeat(Math.max(3, longest + 1));
  return `${mark}${language || ''}\n${body}\n${mark}`;
}

function truncateText(text: any, limit: number = MAX_TEXT_CHARS): string {
  const body = String(text || '');
  if (body.length <= limit) return body;
  return `${body.slice(0, limit)}\n\n...[已截断 ${body.length - limit} 字]`;
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

function addSection(sections: any[], title: string, body: any): void {
  const text = String(body || '').trim();
  if (!text) return;
  sections.push({ title, body: truncateText(text) });
}

function entrySections(entry: any, index: number): any[] {
  const sections: any[] = [];
  const type = entry?.type;
  const payload = entry?.payload;
  const prefix = `#${index + 1}`;

  if (type === 'user') {
    const text = contentText(entry?.message?.content);
    addSection(sections, `${prefix} 用户输入`, text);
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
        addSection(sections, `${prefix} Bash 命令`, fence(block.input.command, 'bash'));
      } else if (block.name === 'Write') {
        const write = normalizeWriteInput(block.input);
        if (write) addSection(sections, `${prefix} 写入文件 ${write.filePath}`, fence(write.content));
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
          );
        }
      } else {
        addSection(sections, `${prefix} 工具调用 ${block.name || 'tool'}`, fence(JSON.stringify(block.input || {}, null, 2), 'json'));
      }
    }
    addSection(sections, `${prefix} 智能体回复`, textParts.join('\n\n'));
    return sections;
  }

  if (type === 'response_item') {
    if (payload?.type === 'message') {
      addSection(sections, `${prefix} ${payload.role === 'assistant' ? '智能体回复' : '消息'}`, contentText(payload.content));
    } else if (payload?.type === 'function_call') {
      if (payload.name === 'Write') {
        const args = parseJsonMaybe(payload.arguments);
        const write = normalizeWriteInput(payload.input ?? args?.input ?? args);
        if (write) addSection(sections, `${prefix} 写入文件 ${write.filePath}`, fence(write.content));
      } else {
        const cmd = functionCommand(payload);
        if (cmd) addSection(sections, `${prefix} Bash 命令`, fence(cmd, 'bash'));
        else addSection(sections, `${prefix} 工具调用 ${payload.name || 'function_call'}`, fence(payload.arguments || JSON.stringify(payload.input || {}, null, 2), 'json'));
      }
    } else if (payload?.type === 'function_call_output') {
      addSection(sections, `${prefix} 工具结果`, fence(functionOutputBody(payload.output)));
    }
    return sections;
  }

  if (type === 'event_msg') {
    if (payload?.type === 'agent_message' || payload?.type === 'user_message') {
      addSection(sections, `${prefix} ${payload.type === 'agent_message' ? '智能体消息' : '用户消息'}`, payload.message);
    } else if (payload?.type === 'patch_apply_end' && payload.changes && typeof payload.changes === 'object') {
      for (const [filePath, change] of Object.entries(payload.changes)) {
        const diff = (change as any)?.unified_diff;
        if (typeof diff === 'string' && diff.trim()) {
          addSection(sections, `${prefix} 补丁 ${filePath}`, fence(diff, 'diff'));
        }
      }
    } else if (payload?.type === 'task_complete') {
      addSection(sections, `${prefix} 任务完成事件`, `duration_ms: ${payload.duration_ms || 0}`);
    }
    return sections;
  }

  if (type === 'attachment') {
    const attachment = entry.attachment;
    if (typeof attachment === 'string') addSection(sections, `${prefix} 附件`, attachment);
    else if (attachment?.content) addSection(sections, `${prefix} 附件 ${attachment.type || ''}`, JSON.stringify(attachment.content, null, 2));
  }

  return sections;
}

function buildSessionTransferMarkdown({ sourceSession, targetSessionId, jsonlPath }: any): any {
  if (!sourceSession?.session_id) {
    throw new Error('创建 Session 转接文档缺少 sourceSession');
  }
  if (!jsonlPath) throw new Error('旧 Session 没有可读取的 JSONL 路径');

  const records = readAllMergedJsonlRecords(jsonlPath);
  const entries = records.map((record) => record.entry);
  const sections = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (const section of entrySections(entries[i], i)) {
      sections.push(section);
    }
  }

  const header = [
    `# Session 转接文档: ${sourceSession.name || sourceSession.session_id}`,
    '',
    `- 原 Session ID: ${sourceSession.session_id}`,
    `- 新 Session ID: ${targetSessionId || ''}`,
    `- 原 Session 标题: ${sourceSession.name || ''}`,
    `- 原 Session 目的: ${sourceSession.description || ''}`,
    `- 生成时间: ${new Date().toISOString()}`,
    `- 来源 JSONL: ${jsonlPath}`,
    '',
    '下面内容由旧 Session 的 JSONL 自动提取，包含前端精简模式和代码模式可展示的关键卡片，用于更换模型后继续上下文。',
  ].join('\n');

  let totalChars = header.length;
  const bodyParts = [];
  for (const section of sections) {
    const part = `\n\n## ${section.title}\n\n${section.body}`;
    totalChars += part.length;
    if (totalChars > MAX_TOTAL_CHARS) {
      bodyParts.push(`\n\n## 已截断\n\n转接文档超过 ${MAX_TOTAL_CHARS} 字，后续卡片未写入。`);
      break;
    }
    bodyParts.push(part);
  }
  if (sections.length === 0) {
    bodyParts.push('\n\n## 空记录\n\n旧 Session 暂未提取到可转接的精简/代码卡片。');
  }

  return {
    markdown: `${header}${bodyParts.join('')}\n`,
    sectionCount: sections.length,
    entryCount: entries.length,
    truncated: totalChars > MAX_TOTAL_CHARS,
  };
}

function writeSessionTransferDocument({ bindPath, sourceSession, targetSessionId, jsonlPath }: any): any {
  if (!bindPath || !sourceSession?.session_id) {
    throw new Error('创建 Session 转接文档缺少 bindPath 或 sourceSession');
  }
  const result = buildSessionTransferMarkdown({ sourceSession, targetSessionId, jsonlPath });
  const dir = path.join(path.resolve(bindPath), '.imac', 'session_transfer');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sourceSession.session_id}.md`);
  fs.writeFileSync(filePath, result.markdown, 'utf8');
  return {
    filePath,
    sectionCount: result.sectionCount,
    entryCount: result.entryCount,
    truncated: result.truncated,
  };
}

function transferAppendPrompt(filePath: any, content: any): string {
  const transfer = fs.readFileSync(filePath, 'utf8');
  return [
    content,
    '',
    '---',
    '',
    '以下是旧 Session 的转接上下文。你必须先阅读并延续这些信息，再继续完成本次 Session 的目标。',
    '',
    transfer,
  ].join('\n');
}

export {
  buildSessionTransferMarkdown,
  writeSessionTransferDocument,
  transferAppendPrompt,
};
