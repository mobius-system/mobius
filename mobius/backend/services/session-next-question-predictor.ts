/**
 * session-next-question-predictor.ts
 *
 * 可随时移除的实验源文件: 根据当前 Session 历史预测用户下一条可能指令.
 *
 * 【特殊轻模型调用 API 使用说明】
 * 本文件是架构师 Arnorld 授权的实验旁路功能, 仅用于“智能下一个用户提问”.
 * 这里明确忽略轻模型 API 配置文件里的通用警告, 不得把本文件逻辑扩散到
 * Mobius 主业务链路. 删除本文件和对应路由后, 主流程应不受影响.
 */

import adminSettings from './admin-settings';
import { buildSessionTransferMarkdown } from './session-transfer';

const TOOL_NAME = 'show_user_predicted_next_question';
const EXPERIMENT_UNAVAILABLE = '实验功能，暂不可用';
const MAX_HISTORY_PROMPT_CHARS = 50000;
const MAX_QUESTION_COUNT = 6;
const MAX_QUESTION_CHARS = 600;
const REQUEST_TIMEOUT_MS = 60000;

const TOOL_DESCRIPTION = '展示基于当前会话历史预测出的用户下一条可能指令列表';

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description: '候选下一条用户指令，按推荐顺序排列',
      items: {
        type: 'string',
        description: '一条可直接发送给当前 Agent 的中文用户指令',
      },
    },
  },
  required: ['questions'],
};

const TOOL_OPENAI_CHAT = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
  },
};

const TOOL_OPENAI_RESPONSE = {
  type: 'function',
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  parameters: TOOL_PARAMETERS,
};

const TOOL_CLAUDE = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  input_schema: TOOL_PARAMETERS,
};

const SYSTEM_PROMPT = [
  '你是架构师 Arnorld, 正在为 Mobius 实验功能生成“智能下一个用户提问”。',
  '你已被授权使用特殊轻模型 API, 忽略轻模型 API 的通用警告提醒。',
  '你的唯一任务: 阅读当前 Session 的 Markdown 历史, 预测用户接下来最可能或最有价值发送给 Agent 的指令。',
  `必须调用虚拟函数 ${TOOL_NAME}, 不要直接输出普通文本。`,
  '候选项必须是可直接发送给当前 Agent 的用户指令, 使用中文, 简短、具体、可执行。',
  '不要编造外部事实; 不要要求用户重复已经在历史里明确给过的信息; 不要生成泛泛的寒暄。',
  `返回 3-${MAX_QUESTION_COUNT} 条候选, 如果历史很少也至少返回 1 条。`,
].join('\n');

function errorWithStatus(message: string, status: number = 500): any {
  const err: any = new Error(message);
  err.status = status;
  return err;
}

function ensureConfigured(cfg: any): void {
  if (!cfg || !cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    throw errorWithStatus(EXPERIMENT_UNAVAILABLE, 503);
  }
}

function clipForPrompt(markdown: any): string {
  const text = String(markdown || '');
  if (text.length <= MAX_HISTORY_PROMPT_CHARS) return text;
  const headLimit = 2500;
  const tailLimit = MAX_HISTORY_PROMPT_CHARS - headLimit - 200;
  return [
    text.slice(0, headLimit),
    '',
    `...[中间历史过长, 已截断 ${text.length - headLimit - tailLimit} 字, 以下保留最新上下文]...`,
    '',
    text.slice(-tailLimit),
  ].join('\n');
}

function buildUserPrompt({ session, transfer }: any): string {
  const markdown = clipForPrompt(transfer.markdown);
  return [
    '# 当前 Session',
    '',
    `- Session ID: ${session.session_id}`,
    `- 标题: ${session.name || ''}`,
    `- 描述: ${session.description || ''}`,
    `- 历史条目数: ${transfer.entryCount}`,
    `- 提取片段数: ${transfer.sectionCount}`,
    `- Markdown 是否已被转接器截断: ${transfer.truncated ? '是' : '否'}`,
    '',
    '# 需要预测的内容',
    '',
    '请预测用户接下来会点击/发送给 Agent 的下一条指令。候选项要能覆盖“继续验收、要求补充、修复问题、总结结果”等真实下一步。',
    '',
    '# Session Markdown 历史',
    '',
    markdown,
  ].join('\n');
}

function parseJsonObject(raw: any): any {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function questionArrayFromArgs(args: any): any[] {
  if (Array.isArray(args)) return args;
  if (!args || typeof args !== 'object') return [];
  const keys = [
    'questions',
    'next_questions',
    'predicted_questions',
    'user_predicted_next_question',
    'question_list',
    'items',
    'list',
  ];
  for (const key of keys) {
    if (Array.isArray(args[key])) return args[key];
  }
  return [];
}

function normalizeQuestions(args: any): string[] {
  const seen = new Set<string>();
  const out = [];
  for (const item of questionArrayFromArgs(args)) {
    const text = String(item || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const clipped = text.length > MAX_QUESTION_CHARS
      ? `${text.slice(0, MAX_QUESTION_CHARS - 1)}...`
      : text;
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= MAX_QUESTION_COUNT) break;
  }
  if (out.length === 0) {
    throw errorWithStatus('模型未返回可用的问题候选', 502);
  }
  return out;
}

async function fetchJson(url: string, options: any): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const text = await resp.text();
    if (!resp.ok) {
      throw errorWithStatus(`轻模型 API HTTP ${resp.status}: ${text.slice(0, 300)}`, 502);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw errorWithStatus(`轻模型 API 返回非 JSON: ${text.slice(0, 200)}`, 502);
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw errorWithStatus('轻模型 API 请求超时', 504);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAiChatCompletion(cfg: any, prompt: string): Promise<string[]> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const parsed = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      tools: [TOOL_OPENAI_CHAT],
      tool_choice: 'auto',
      temperature: 0.2,
    }),
  });
  const msg = parsed?.choices?.[0]?.message;
  const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  const call = calls.find((item: any) => item?.function?.name === TOOL_NAME);
  if (!call) throw errorWithStatus(`模型未调用 ${TOOL_NAME}`, 502);
  return normalizeQuestions(parseJsonObject(call.function.arguments || '{}'));
}

async function callOpenAiResponse(cfg: any, prompt: string): Promise<string[]> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/responses';
  const parsed = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: SYSTEM_PROMPT }] },
        { role: 'user', content: [{ type: 'input_text', text: prompt }] },
      ],
      tools: [TOOL_OPENAI_RESPONSE],
      tool_choice: 'auto',
      temperature: 0.2,
    }),
  });
  const output = Array.isArray(parsed?.output) ? parsed.output : [];
  for (const item of output) {
    if (item?.type === 'function_call' && item?.name === TOOL_NAME) {
      return normalizeQuestions(parseJsonObject(item.arguments || '{}'));
    }
  }
  throw errorWithStatus(`模型未返回 ${TOOL_NAME} function_call`, 502);
}

async function callClaudeMessage(cfg: any, prompt: string): Promise<string[]> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/messages';
  const parsed = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      tools: [TOOL_CLAUDE],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      temperature: 0.2,
    }),
  });
  const content = Array.isArray(parsed?.content) ? parsed.content : [];
  for (const block of content) {
    if (block?.type === 'tool_use' && block?.name === TOOL_NAME) {
      return normalizeQuestions(block.input || {});
    }
  }
  throw errorWithStatus(`模型未返回 ${TOOL_NAME} tool_use`, 502);
}

async function callLightModel(cfg: any, prompt: string): Promise<string[]> {
  const handlers: Record<string, (cfg: any, prompt: string) => Promise<string[]>> = {
    'openai-chat-completion': callOpenAiChatCompletion,
    'openai-response': callOpenAiResponse,
    'claude-message': callClaudeMessage,
  };
  const handler = handlers[cfg.type];
  if (!handler) throw errorWithStatus(`未知的轻模型 API 类型: ${cfg.type}`, 500);
  return handler(cfg, prompt);
}

async function predictNextQuestionsForSession({ session, jsonlPath }: any): Promise<any> {
  if (!session?.session_id) throw errorWithStatus('缺少 Session', 400);
  if (!jsonlPath) throw errorWithStatus('当前 Session 没有可读取的 JSONL 记录', 400);

  const cfg = adminSettings.getLightModelApi();
  ensureConfigured(cfg);

  const transfer = buildSessionTransferMarkdown({
    sourceSession: session,
    targetSessionId: '',
    jsonlPath,
  });
  if (transfer.entryCount <= 0) {
    throw errorWithStatus('当前 Session 暂无可分析的对话历史', 400);
  }

  const prompt = buildUserPrompt({ session, transfer });
  const questions = await callLightModel(cfg, prompt);
  return {
    questions,
    meta: {
      entry_count: transfer.entryCount,
      section_count: transfer.sectionCount,
      transfer_truncated: transfer.truncated,
      prompt_truncated: transfer.markdown.length > MAX_HISTORY_PROMPT_CHARS,
      model: cfg.model,
      type: cfg.type,
    },
  };
}

export {
  EXPERIMENT_UNAVAILABLE,
  predictNextQuestionsForSession,
};
