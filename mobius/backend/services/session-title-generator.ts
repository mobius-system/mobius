/**
 * session-title-generator.ts
 *
 * 给「不会产出 Claude Code ai-title 事件的会话」兜底自动生成标题 —— 主要是 codex /
 * gpt-5.5 等 tmux-codex 后端(codex 不生成会话标题, 也无 Haiku 侧路)。
 *
 * 与 session-title-syncer 的分工:
 *   - claude-code 后端: agent 自身产出 type=ai-title, syncer 实时更新名(本生成器跳过)。
 *   - codex / 其它后端: agent 不产 ai-title, 由本生成器周期性扫描兜底。
 *
 * 受同一开关控制: admin-settings autoGenerateSessionTitle.enabled(默认 off)。
 *
 * 做法: 扫描「默认名(含时间戳) + 消息数≥2 + 非 claude-code 后端」的会话, 用该会话自身
 * 的 codex 通道(base_url + key + model, OpenAI 兼容 chat/completions)把首条用户消息
 * 浓缩成一个简短标题, 写回 sessions_v2.name。失败冷却避免反复打爆模型。
 */
import * as fs from 'fs';
import adminSettings from './admin-settings';
import { Sessions } from '../repositories/sessions';
import { Messages } from '../repositories/messages';
import * as modelAccess from './model-access';

const SCAN_INTERVAL_MS = 60 * 1000;
const BATCH_PER_SCAN = 3;            // 每轮最多生成几个, 避免短时大量模型调用
const CANDIDATE_POOL = BATCH_PER_SCAN * 5; // 多取一些, JS 层按默认名/冷却再筛
const MIN_MESSAGES = 2;
const TITLE_MAX_CHARS = 60;          // 期望标题长度上限
const DB_TITLE_MAX = 120;            // 与 session-title-syncer MAX_SESSION_TITLE_LENGTH 对齐
const ATTEMPT_COOLDOWN_MS = 2 * 60 * 1000; // 单会话生成失败后的冷却(短: 多为瞬态, 早重试)
const REQUEST_TIMEOUT_MS = 30 * 1000;
const FIRST_MSG_CHARS = 800;

// 默认会话名形如「<issue 标题> 2026-07-16 15:02」或纯时间戳 —— 末尾带时间戳即视为未命名。
const DEFAULT_NAME_RE = /\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s*$/;
// 注入上下文块的签名(🥊/🚁 等), 首条 user 若是它则取下一条真实提问。
const CONTEXT_BLOB_RE = /以下信息描述了你正在协助|以下信息描述了|Project.*Issue.*Research 与 Session/;

let timer: NodeJS.Timeout | null = null;
// sessionId -> 最近一次尝试时间戳(无论成败), 用于冷却去重。
const recentAttempts = new Map<string, number>();

function isDefaultName(name: string | null | undefined): boolean {
  return !!name && DEFAULT_NAME_RE.test(String(name).trim());
}

function claudeCodeBackend(model: string): boolean {
  const k = String(model || '');
  return k.startsWith('claude-code:') || k.startsWith('claude-') || k === 'opus';
}

interface Endpoint { baseUrl: string; apiKey: string; model: string }

// 把一个 codex 会话模型解析成可调用的 OpenAI 兼容 endpoint。
function resolveCodexEndpoint(sessionModel: string): Endpoint | null {
  let m: any;
  try { m = modelAccess.findCodexModel(sessionModel, { includeSecret: true }); } catch { return null; }
  if (!m || m.enabled === false || !m.config_path || !fs.existsSync(m.config_path)) return null;

  let toml = '';
  try { toml = fs.readFileSync(m.config_path, 'utf8'); } catch { return null; }
  const baseUrl = String(toml).match(/base_url\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const tomlApiKey = String(toml).match(/api_key\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const apiKey = m.secret_value || tomlApiKey;
  const model = m.codex_model;
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
}

function cleanTitle(raw: any): string | null {
  if (!raw) return null;
  let t = String(raw)
    .replace(/\s+/g, ' ')
    .trim()
    // 去掉首尾引号(中英文)与末尾标点。
    .replace(/^["'“”‘’《【\[]+/g, '')
    .replace(/["'“”‘’》】\]]+$/g, '')
    .replace(/[。.！!？?；;…]+$/g, '')
    .trim();
  if (!t) return null;
  if (t.length > TITLE_MAX_CHARS) t = t.slice(0, TITLE_MAX_CHARS).trim();
  return t;
}

async function generateTitle(endpoint: Endpoint, firstUserText: string): Promise<string | null> {
  const url = endpoint.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: endpoint.model,
        max_tokens: 48,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content:
              '你把一段用户提问浓缩成一个简短的会话标题。只输出标题本身: 不要引号、不要句末标点、不要解释、不要换行, 不超过 30 个字, 语言与用户提问一致, 直述主题。',
          },
          { role: 'user', content: String(firstUserText || '').slice(0, FIRST_MSG_CHARS) },
        ],
      }),
    });
    if (!resp.ok) {
      console.warn(`[session-title-generator] model HTTP ${resp.status} (${endpoint.model})`);
      return null;
    }
    const data: any = await resp.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content;
    const cleaned = cleanTitle(text);
    if (!cleaned) console.warn(`[session-title-generator] empty/uncleanable title (raw=${String(text).slice(0, 60)})`);
    return cleaned;
  } catch (e: any) {
    console.warn(`[session-title-generator] model call error: ${(e?.name === 'AbortError' ? 'timeout' : (e?.message || e))}`);
    return null;
  } finally {
    clearTimeout(to);
  }
}

function firstRealUserContent(sessionId: string): string | null {
  const inputs = Messages.userInputsForTask(sessionId) || [];
  for (const u of inputs) {
    const c = String(u?.content || '').trim();
    if (!c) continue;
    if (CONTEXT_BLOB_RE.test(c)) continue; // 跳过注入的上下文块, 取真实首问
    return c;
  }
  return null;
}

async function tryGenerateFor(row: { session_id: string; model: string }): Promise<boolean> {
  const endpoint = resolveCodexEndpoint(row.model);
  if (!endpoint) return false;
  const firstUser = firstRealUserContent(row.session_id);
  if (!firstUser) return false;
  const title = await generateTitle(endpoint, firstUser);
  if (!title) return false;
  Sessions.updateName(row.session_id, title.slice(0, DB_TITLE_MAX));
  console.log(`[session-title-generator] titled ${row.session_id} -> "${title.slice(0, DB_TITLE_MAX)}"`);
  return true;
}

async function scanOnce(): Promise<{ processed: number; attempted: number }> {
  if (!adminSettings.isAutoGenerateSessionTitleEnabled()) return { processed: 0, attempted: 0 };
  const now = Date.now();
  const candidates = Sessions.listTitleGenCandidates(MIN_MESSAGES, CANDIDATE_POOL);
  let processed = 0;
  let attempted = 0;
  for (const s of candidates) {
    if (processed >= BATCH_PER_SCAN) break;
    if (claudeCodeBackend(s.model)) continue;          // ai-title syncer 负责
    if (!isDefaultName(s.name)) continue;              // 已有自定义名, 不动
    const last = recentAttempts.get(s.session_id) || 0;
    if (now - last < ATTEMPT_COOLDOWN_MS) continue;    // 冷却中
    recentAttempts.set(s.session_id, now);
    attempted++;
    try {
      const ok = await tryGenerateFor({ session_id: s.session_id, model: s.model });
      if (ok) processed++;
    } catch (e: any) {
      console.warn(`[session-title-generator] ${s.session_id} 失败: ${(e?.message || e)}`);
    }
  }
  // 清理过期冷却记录, 防止 Map 无限增长。
  if (recentAttempts.size > 2000) {
    for (const [sid, ts] of recentAttempts) {
      if (now - ts > ATTEMPT_COOLDOWN_MS) recentAttempts.delete(sid);
    }
  }
  return { processed, attempted };
}

function startSessionTitleGenerator(): NodeJS.Timeout | null {
  if (timer) return timer;
  const safe = () => {
    scanOnce().catch((e) => console.warn(`[session-title-generator] scan error: ${(e as Error)?.message || e}`));
  };
  // 启动后先跑一次, 让已存在的无标题 codex 会话尽快被处理。
  setTimeout(safe, 5 * 1000);
  timer = setInterval(safe, SCAN_INTERVAL_MS);
  console.log('[session-title-generator] started (兜底 codex 等非 ai-title 后端, autoGenerateSessionTitle default off)');
  return timer;
}

export { startSessionTitleGenerator, scanOnce };
