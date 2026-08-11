// paper-reader — AlphaXiv 风格论文精读器。
// 渲染 arXiv 全文，段落锚定笔记，就文与 mobius Agent 对话（模型可选）。
// 用 source_id (= arxiv id) 与 tianyi-radar 互链。
// 复用 self-cognition/tianyi-radar 同构的宿主契约：createExtensionAnalysisSession + __mobius_post_actions。

const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto"),
  Database = require("better-sqlite3"),
  EXT_NAME = "paper-reader",
  DB_FILE = "paper-reader.db",
  REPO_ROOT = path.resolve(__dirname, "../../../.."),
  HIDDEN = process.env.MOBIUS_HIDDEN_FOLDER_NAME || ".imac",
  FULLTEXT_TTL_DAYS = 7,
  now = () => new Date().toISOString(),
  txt = (e, t = 1e3) => String(e || "").replace(/\s+/g, " ").trim().slice(0, t),
  long = (e, t = 8e3) => String(e || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().slice(0, t),
  id = (e, t) => `${e}_${crypto.createHash("sha1").update(String(t)).digest("hex").slice(0, 16)}`,
  int = (e, t, r, a) => Math.max(r, Math.min(a, Math.floor(Number.isFinite(Number(e)) ? Number(e) : t))),
  arr = e => { try { const t = JSON.parse(e || "[]"); return Array.isArray(t) ? t : []; } catch { return []; } };

function extensionBridge() {
  try { return require("../../../backend/services/extension-agent-bridge"); }
  catch (e1) { try { return require("../../../backend/services/extension-agent-bridge.ts"); } catch { throw e1; } }
}

// SeeUPO 锚点（与 tianyi-radar 一致；让 Agent 就文回答时挂在研究者坐标系上）
const SEEUPO_ANCHOR = [
  "# 研究者坐标系（Tianyi Hu）",
  "你是 Tianyi Hu 的科研协作者。就文回答时，尽量把论文的贡献挂在下列张力轴上：",
  "1. critic-free vs 收敛保证；2. 单轮 vs 多轮；3. 序列级 vs token 级；4. 优势估计方式。",
  "见 SeeUPO (arXiv:2602.06554)。若与轴线无关，正常解释论文即可，不必强行挂钩。"
].join("\n");

// ============ DB ============
function dbOpen(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, DB_FILE));
  db.pragma("journal_mode = WAL");
  db.exec(`
CREATE TABLE IF NOT EXISTS paper_fulltext (
  source_id TEXT PRIMARY KEY, arxiv_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
  authors TEXT NOT NULL DEFAULT '', abstract TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '', text_excerpt TEXT NOT NULL DEFAULT '',
  fetched_at TEXT, expires_at TEXT
);
CREATE TABLE IF NOT EXISTS anchored_notes (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, section TEXT NOT NULL DEFAULT '',
  quote TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_source ON anchored_notes(source_id);
CREATE TABLE IF NOT EXISTS paragraph_comments (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, pid TEXT NOT NULL,
  content TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pcomments ON paragraph_comments(source_id, pid);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'chat',
  model_key TEXT NOT NULL, model_label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running', summary TEXT NOT NULL DEFAULT '', web_reply TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
  issue_id TEXT NOT NULL DEFAULT '', session_url TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_source ON agent_runs(source_id);
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_run ON agent_messages(run_id);
CREATE TABLE IF NOT EXISTS install_state (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
`);
  return db;
}

// ============ IO ============
async function fetchText(urlStr, { timeoutMs = 25e3, headers = {} } = {}) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(urlStr, { headers: { "user-agent": `Mobius ${EXT_NAME}/0.1`, ...headers }, signal: ctrl.signal, redirect: "follow" });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } finally { clearTimeout(timer); }
}
async function fetchBinary(urlStr, { timeoutMs = 30e3 } = {}) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(urlStr, { headers: { "user-agent": `Mobius ${EXT_NAME}/0.1` }, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  } finally { clearTimeout(timer); }
}
function cleanXml(e) { return String(e || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function firstTag(xml, tag) { const m = String(xml || "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i")); return m ? cleanXml(m[1]) : ""; }
function allTags(xml, tag) { return [...String(xml || "").matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))].map(m => cleanXml(m[1])); }

// 从 arxiv API 取元数据
async function fetchArxivMeta(aid) {
  const r = await fetchText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(aid)}`, { timeoutMs: 15e3 });
  if (!r.ok) return null;
  const entry = String(r.text).match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/i);
  if (!entry) return null;
  const t = entry[1];
  return {
    title: firstTag(t, "title"),
    authors: allTags(t, "name").join("; "),
    abstract: firstTag(t, "summary"),
    published: firstTag(t, "published").slice(0, 10)
  };
}

// 取 arxiv 全文 HTML：arxiv.org/html 优先，ar5iv 兜底
async function fetchPaperHtml(aid) {
  const candidates = [
    `https://arxiv.org/html/${aid}`,
    `https://ar5iv.labs.arxiv.org/html/${aid}`,
    `https://ar5iv.org/abs/${aid}`
  ];
  for (const u of candidates) {
    try {
      const r = await fetchText(u, { timeoutMs: 25e3 });
      if (r.ok && r.text && r.text.length > 2000 && /<\w+[^>]*>/.test(r.text)) return { html: r.text, url: u };
    } catch {}
  }
  return null;
}
// 清洗 HTML 供阅读器渲染：去掉脚本/样式/导航等，保留正文
function cleanHtmlForReader(html) {
  let h = String(html || "");
  h = h.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "");
  h = h.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");
  h = h.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "");
  h = h.replace(/<!--[\s\S]*?-->/g, "");
  // 去 arxiv 顶/底导航与一些已知 chrome
  h = h.replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi, "");
  // 提取 <body> 或 <article> 优先
  const body = h.match(/<body\b[\s\S]*?<\/body>/i);
  if (body) h = body[0].replace(/<body\b[^>]*>/i, "").replace(/<\/body>/i, "");
  const article = h.match(/<article\b[\s\S]*?<\/article>/i);
  if (article) h = article[0];
  return h;
}
function htmlToExcerpt(html, max = 12e4) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|figcaption|blockquote|tr)>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.slice(0, max);
}
function relevantPaperContext(text, message, anchor, max = 24000) {
  const source = String(text || "").trim();
  if (!source) return "";
  if (source.length <= max) return source;
  const query = `${message || ""} ${anchor || ""}`.toLowerCase();
  const terms = [...new Set([
    ...(query.match(/[a-z][a-z0-9_-]{2,}/g) || []),
    ...(query.match(/[\u3400-\u9fff]{2,6}/g) || [])
  ])].filter(x => !["this", "that", "with", "from", "what", "which", "论文", "这个", "如何", "哪些"].includes(x)).slice(0, 40);
  const paragraphs = source.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length > 1800) { chunks.push(current); current = ""; }
    current += (current ? "\n" : "") + p;
  }
  if (current) chunks.push(current);
  if (!chunks.length) return source.slice(0, max);
  const anchorText = String(anchor || "").toLowerCase().slice(0, 300);
  const ranked = chunks.map((chunk, index) => {
    const lower = chunk.toLowerCase();
    let score = index === 0 ? 8 : 0;
    if (anchorText && lower.includes(anchorText.slice(0, 80))) score += 100;
    for (const term of terms) if (lower.includes(term)) score += term.length > 5 ? 4 : 2;
    return { chunk, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = [];
  let used = 0;
  for (const item of ranked) {
    if (selected.some(x => x.index === item.index)) continue;
    if (used + item.chunk.length > max && selected.length >= 3) continue;
    selected.push(item); used += item.chunk.length;
    if (used >= max) break;
  }
  return selected.sort((a, b) => a.index - b.index).map(x => x.chunk).join("\n\n").slice(0, max);
}

// ============ open/get paper ============
function resolveArxivId(input) {
  const s = txt(input, 300);
  let m = s.match(/(?:abs\/|pdf\/|html\/|^)([0-9]{4}\.[0-9]{4,5}(?:v\d+)?|[a-z\-]+\/[0-9]{7})/i);
  if (m) return m[1].replace(/v\d+$/, "");
  if (/^[0-9]{4}\.[0-9]{4,5}$/.test(s) || /^[a-z\-]+\/[0-9]{7}$/i.test(s)) return s;
  return s; // 当作字面 id
}

async function openPaper(e, t, user) {
  const aid = resolveArxivId(t.arxiv_id || t.source_id || t.id || t.url);
  if (!aid) return { ok: false, error: "需要 arxiv_id / source_id / url" };
  const sid = aid;
  // 缓存命中且未过期
  const cached = e.prepare("SELECT * FROM paper_fulltext WHERE source_id=?").get(sid);
  const fresh = cached && cached.expires_at && Date.parse(cached.expires_at) > Date.now();
  if (cached && fresh && !t.force) {
    if ((cached.text_excerpt || "").length < 2e4 && (cached.html || "").length > 2e4) {
      e.prepare("UPDATE paper_fulltext SET text_excerpt=? WHERE source_id=?").run(htmlToExcerpt(cached.html), sid);
      return { ok: true, paper: paperOut(e.prepare("SELECT * FROM paper_fulltext WHERE source_id=?").get(sid)), from_cache: true };
    }
    return { ok: true, paper: paperOut(cached), from_cache: true };
  }
  // 抓元数据
  let meta = cached ? { title: cached.title, authors: cached.authors, abstract: cached.abstract } : null;
  if (!meta) { try { meta = await fetchArxivMeta(aid); } catch {} meta = meta || {}; }
  // 抓全文 HTML
  let html = cached ? cached.html : "";
  if (!html || t.force || !fresh) {
    const got = await fetchPaperHtml(aid);
    html = got ? cleanHtmlForReader(got.html) : "";
  }
  const excerpt = htmlToExcerpt(html);
  const expires = new Date(Date.now() + FULLTEXT_TTL_DAYS * 864e5).toISOString();
  e.prepare(`INSERT INTO paper_fulltext (source_id,arxiv_id,title,authors,abstract,html,text_excerpt,fetched_at,expires_at) VALUES (@source_id,@arxiv_id,@title,@authors,@abstract,@html,@text_excerpt,@fetched_at,@expires_at)
    ON CONFLICT(source_id) DO UPDATE SET arxiv_id=excluded.arxiv_id,title=excluded.title,authors=excluded.authors,abstract=excluded.abstract,html=excluded.html,text_excerpt=excluded.text_excerpt,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at`)
    .run({ source_id: sid, arxiv_id: aid, title: txt(meta.title, 600), authors: txt(meta.authors, 600), abstract: long(meta.abstract, 8000), html, text_excerpt: excerpt, fetched_at: now(), expires_at: expires });
  const row = e.prepare("SELECT * FROM paper_fulltext WHERE source_id=?").get(sid);
  return { ok: true, paper: paperOut(row), from_cache: false };
}
function paperOut(r) {
  if (!r) return null;
  return { source_id: r.source_id, arxiv_id: r.arxiv_id, title: r.title, authors: r.authors, abstract: r.abstract, html: r.html, has_fulltext: !!(r.html && r.html.length > 500), fetched_at: r.fetched_at, expires_at: r.expires_at };
}
function getPaper(e, t) {
  const sid = txt(t.source_id || t.arxiv_id || t.id, 200);
  const row = e.prepare("SELECT * FROM paper_fulltext WHERE source_id=?").get(sid);
  return { item: row ? paperOut(row) : null };
}
// 取论文 PDF：优先复用 tianyi-radar 已下载的（跨 extension ../tianyi-radar/papers/），否则从 arxiv 下；
// ≤3.2MB 返回 base64（前端 blob 渲染），超限返回 too_large + arxiv 链接兜底（extCall 返回 ≤5MB）
async function getPaperPdf(e, t, dir) {
  const sid = txt(t.source_id || t.arxiv_id || t.id, 200);
  if (!sid) return { ok: false, error: "需要 source_id" };
  const candidates = [path.join(dir, "..", "tianyi-radar", "papers", sid + ".pdf"), path.join(dir, "papers", sid + ".pdf")];
  let file = candidates.find(p => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } });
  if (!file) {
    try {
      const r = await fetchBinary(`https://arxiv.org/pdf/${sid}`, { timeoutMs: 30e3 });
      if (r.ok && r.buf && r.buf.length > 1000) {
        fs.mkdirSync(path.join(dir, "papers"), { recursive: true });
        file = path.join(dir, "papers", sid + ".pdf");
        fs.writeFileSync(file, r.buf);
      }
    } catch {}
  }
  if (!file) return { ok: false, error: "PDF 不可用（无 arxiv id 或下载失败）" };
  const buf = fs.readFileSync(file);
  const MAX = 3.2e6;
  const isArxiv = /[0-9]{4}\.[0-9]{4,5}/.test(sid);
  if (buf.length > MAX) return { ok: true, too_large: true, bytes: buf.length, url: isArxiv ? `https://arxiv.org/pdf/${sid}` : "" };
  return { ok: true, pdf_base64: buf.toString("base64"), bytes: buf.length, mime: "application/pdf" };
}
function listRecentPapers(e) {
  return { items: e.prepare("SELECT source_id,arxiv_id,title,authors,fetched_at FROM paper_fulltext ORDER BY fetched_at DESC LIMIT 50").all() };
}

// ============ AI 渠道（模型可选）============
function chatProviders() {
  const out = [];
  const accessPath = txt(process.env.MODEL_ACCESS_PATH || path.join(REPO_ROOT, ".deploy_data/data/model-access.json"), 512);
  try {
    if (fs.existsSync(accessPath)) {
      const access = JSON.parse(fs.readFileSync(accessPath, "utf8"));
      for (const m of access.claudeCodeModels || []) {
        if (!m.enabled || !m.imported) continue;
        const sf = path.join(os.homedir(), ".claude", `settings-${m.key}.json`);
        if (!fs.existsSync(sf)) continue;
        let s; try { s = JSON.parse(fs.readFileSync(sf, "utf8")); } catch { continue; }
        const env = s.env || {};
        if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) continue;
        out.push({ key: m.key, name: `anthropic:${m.key}`, label: m.label || m.key, type: "anthropic",
          baseUrl: env.ANTHROPIC_BASE_URL, authToken: env.ANTHROPIC_AUTH_TOKEN,
          model: s.model || env.ANTHROPIC_DEFAULT_SONNET_MODEL || m.claude_model || "GLM-5.2" });
      }
    }
  } catch {}
  const ck = txt(process.env.RCC2_API_KEY || process.env.RIGHTCODE_API_KEY || "", 512);
  if (ck) out.push({ key: "env:codex", name: "codex:subscription", label: "Codex (env)", type: "responses",
    baseUrl: "https://right.codes/codex/v1", apiKey: ck,
    model: txt(process.env.PAPER_READER_LLM_MODEL || process.env.RESEARCH_RADAR_LLM_MODEL || "gpt-5.5", 120) });
  return out;
}
function findProvider(modelKey) {
  const ps = chatProviders();
  if (!ps.length) throw new Error("没有可用的 AI 渠道");
  if (!modelKey) return ps[0];
  return ps.find(p => p.key === modelKey || p.name === modelKey || p.model === modelKey) || ps[0];
}
function sessionModel(modelKey) {
  // env:codex 是 chatProviders 的合成 key，session 注册表认的是 "codex"；其余 anthropic key(model-access 导入)直接可用
  const k = txt(modelKey, 120);
  if (k === "env:codex") return "codex";
  return k || txt(process.env.PAPER_READER_AGENT_MODEL, 120) || "codex";
}

// ============ Agent session（异步，接 mobius Agent）============
function conversationAnswer(e, run) {
  const direct = extractFurther(run.web_reply) || long(run.web_reply, 16000);
  if (direct) return direct;
  if (run.status !== "completed") return "";
  const row = e.prepare("SELECT content FROM agent_messages WHERE run_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1").get(run.id);
  return long(row?.content, 16000);
}
function conversationQuestion(e, run) {
  const row = e.prepare("SELECT content FROM agent_messages WHERE run_id=? AND role='user' ORDER BY created_at ASC LIMIT 1").get(run.id);
  return long(row?.content, 8000);
}
function recentConversationContext(e, sourceId, { excludeRunId = '', maxTurns = 5, maxChars = 14000 } = {}) {
  const rows = e.prepare("SELECT * FROM agent_runs WHERE source_id=? AND kind='chat' AND status='completed' ORDER BY created_at DESC LIMIT 30").all(txt(sourceId, 200));
  const turns = [];
  for (const run of rows) {
    if (excludeRunId && run.id === excludeRunId) continue;
    const question = conversationQuestion(e, run);
    const answer = conversationAnswer(e, run);
    if (!question || !answer) continue;
    turns.push({ run_id: run.id, question, answer, created_at: run.created_at, model: run.model_label });
    if (turns.length >= maxTurns) break;
  }
  turns.reverse();
  let used = 0;
  const kept = [];
  for (const turn of turns) {
    const block = `用户：${turn.question}\nAssistant：${turn.answer}`;
    if (kept.length && used + block.length > maxChars) continue;
    kept.push(turn); used += block.length;
  }
  return kept;
}
function buildConversationPromptSection(turns) {
  if (!turns?.length) return "";
  return [
    "## 此前对话（仅用户输入与最终回答）",
    "以下内容只用于保持这篇论文讨论的连续性，不是论文证据；若与当前问题无关，不要强行引用。不要复述 thinking、工具调用或运行过程。",
    ...turns.map((turn, index) => `### 第 ${index + 1} 轮\n用户：${turn.question}\nAssistant：${turn.answer}`),
    ""
  ].join("\n");
}
function buildChatPrompt({ paper, message, anchor, runId, dbPath, priorConversation }) {
  const relevantContext = relevantPaperContext(paper.text_excerpt || paper.excerpt, message, anchor);
  const ctx = [
    "# Paper Reader · 就文对话",
    "你是 Tianyi Hu 的科研精读助手。基于下面这篇论文回答用户问题。",
    "",
    SEEUPO_ANCHOR,
    "",
    "## 论文",
    `- 标题: ${paper.title || "(未知)"}`,
    `- arxiv id: ${paper.arxiv_id || paper.source_id}`,
    `- 作者: ${paper.authors || "(未知)"}`,
    "",
    "### 摘要",
    long(paper.abstract, 4000) || "(无摘要)",
    "",
    "### 按问题召回的全文相关章节",
    long(relevantContext, 26000) || "(未取到全文，依摘要回答)",
    "",
    buildConversationPromptSection(priorConversation),
    anchor ? `## 用户锚定的段落\n${long(anchor, 2000)}` : "",
    "",
    "## 用户问题",
    long(message, 8000),
    "",
    "## 写回规则",
    `- agent_runs.id = ${runId}`,
    "- 回答要就文、准确、有细节；必要时引用论文具体段落/公式/图表。",
    "- 输出使用 GitHub Flavored Markdown；表格必须使用 Markdown 表格语法。",
    "- 所有数学内容必须使用标准 LaTeX 定界：行内公式写作 $...$，独立公式写作 $$...$$；禁止输出没有定界符的裸 LaTeX。",
    "- 复杂推导可使用 \\begin{aligned}...\\end{aligned}，但必须放在 $$...$$ 内；代码使用 fenced code block。",
    "- 完成后必须执行：UPDATE agent_runs SET status='completed', summary=简短中文要点, updated_at=当前ISO WHERE id='" + runId + "';",
    "- 并把给聊天框的简明中文回答写回：UPDATE agent_runs SET web_reply='<further-answering>你的回答（可分段，必要时带公式/要点）</further-answering>', updated_at=当前ISO WHERE id='" + runId + "';",
    "- 若失败：UPDATE agent_runs SET status='error', error=原因, updated_at=当前ISO WHERE id='" + runId + "';"
  ].filter(Boolean).join("\n");
  return ctx;
}
function createReaderSession({ userId, paper, runId, modelKey, prompt }) {
  const { createExtensionAnalysisSession, loadUser } = extensionBridge();
  const user = loadUser(userId);
  const created = createExtensionAnalysisSession({
    user,
    extensionName: EXT_NAME,
    extensionDisplayName: "Paper Reader 精读 Agent",
    projectDescription: "Paper Reader 就文对话 Agent。每次提问建一个 session。",
    issueTitle: `精读: ${txt(paper.title, 80)}`,
    issueDescription: "就论文全文回答用户问题，挂在 SeeUPO 坐标系上。",
    sessionName: `精读 ${txt(paper.arxiv_id || paper.source_id, 30)}: ${txt(paper.title, 40)}`,
    sessionDescription: prompt,
    model: sessionModel(modelKey),
    language: "zh"
  });
  const url = created?.session?.session_url || created?.project?.url || "";
  return { user, created, url, postAction: {
    type: "session_message", session_id: created.session.session_id, project_id: created.project.id,
    content: prompt, input_text: `精读提问: ${txt(paper.title, 50)}`,
    request_id: `${EXT_NAME}-${runId}-${Date.now()}`, source: `extension.${EXT_NAME}.chat`, result_key: "backend_start"
  } };
}
function startChat(e, { paper, message, anchor, modelKey, provider, createdBy, dir }) {
  const runId = id("run", now() + Math.random());
  const priorConversation = recentConversationContext(e, paper.source_id, { excludeRunId: runId });
  e.prepare(`INSERT INTO agent_runs (id,source_id,kind,model_key,model_label,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'running',?,?,?)`)
    .run(runId, paper.source_id, "chat", txt(modelKey || provider?.key || "", 200), txt(provider?.label || "", 200), createdBy, now(), now());
  const dbPath = e.name || path.join(dir, DB_FILE);
  const prompt = buildChatPrompt({ paper, message, anchor, runId, dbPath, priorConversation });
  const launched = createReaderSession({ userId: createdBy, paper, runId, modelKey: modelKey || provider?.key, prompt });
  e.prepare("UPDATE agent_runs SET session_id=?,project_id=?,issue_id=?,session_url=?,summary=?,updated_at=? WHERE id=?")
    .run(launched.created.session.session_id, launched.created.project.id, launched.created.issue.id, launched.url, "已启动精读 Agent", now(), runId);
  appendMessage(e, runId, "user", message + (anchor ? `\n[锚定段落] ${anchor}` : ""));
  return { ok: true, async: true, status: "started", run_id: runId, session_id: launched.created.session.session_id, session_url: launched.url,
    model: provider?.label || sessionModel(modelKey), __mobius_post_actions: [launched.postAction] };
}
function buildNoteDistillPrompt({ paper, question, answer, runId, dbPath }) {
  return [
    "# Paper Reader · 对话沉淀为研究笔记",
    "你是科研笔记编辑。请把下面一轮论文问答提炼成一条可长期复用的研究笔记。",
    "",
    SEEUPO_ANCHOR,
    "",
    `## 论文\n- 标题: ${paper.title || "(未知)"}\n- arxiv id: ${paper.arxiv_id || paper.source_id}`,
    `## 用户问题\n${long(question, 5000)}`,
    `## Assistant 回答\n${long(answer, 14000)}`,
    "",
    "## 笔记要求",
    "- 只保留有研究价值的机制、公式、证据、限制和可执行启发；删除寒暄、过程描述和重复表述。",
    "- 不得补写原对话或论文中没有的事实。结论与证据要区分，未验证内容明确标为待验证。",
    "- 输出一条自包含的中文 Markdown 笔记，可使用小标题、列表和 Markdown 表格。",
    "- 所有数学内容必须使用标准 LaTeX 定界：行内 $...$，独立公式 $$...$$；禁止裸 LaTeX。",
    "- 不要输出“已沉淀”等说明，不要使用 JSON，不要包裹代码围栏。",
    "",
    "## 写回规则",
    `- 数据库路径: ${dbPath}`,
    `- agent_runs.id = ${runId}`,
    "- 不要直接修改 anchored_notes；插件会在轮询完成后确定性写入笔记。",
    "- 使用参数化 SQL 把完整笔记写入 agent_runs.web_reply，格式为 <further-answering>完整 Markdown 笔记</further-answering>。",
    "- 同时把 status 设为 completed、summary 设为“对话已提炼为研究笔记”、updated_at 设为当前 ISO 时间。",
    "- 若失败，把 status 设为 error 并写入 error 字段。"
  ].join("\n");
}
function startNoteDistill(e, { paper, sourceRun, question, answer, modelKey, provider, createdBy, dir }) {
  const runId = id("run", now() + Math.random());
  const noteId = id("note", `conversation:${sourceRun.id}`);
  const section = `conversation:${sourceRun.id}`;
  e.prepare(`INSERT INTO agent_runs (id,source_id,kind,model_key,model_label,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'running',?,?,?)`)
    .run(runId, paper.source_id, "note_distill", txt(modelKey || provider?.key || "", 200), txt(provider?.label || "", 200), createdBy, now(), now());
  const dbPath = e.name || path.join(dir, DB_FILE);
  const prompt = buildNoteDistillPrompt({ paper, question, answer, runId, dbPath });
  const launched = createReaderSession({ userId: createdBy, paper, runId, modelKey: modelKey || provider?.key, prompt });
  e.prepare("UPDATE agent_runs SET session_id=?,project_id=?,issue_id=?,session_url=?,summary=?,updated_at=? WHERE id=?")
    .run(launched.created.session.session_id, launched.created.project.id, launched.created.issue.id, launched.url, "正在提炼对话笔记", now(), runId);
  appendMessage(e, runId, "system", JSON.stringify({ source_run_id: sourceRun.id, note_id: noteId, section }));
  return { ok: true, async: true, status: "started", run_id: runId, session_id: launched.created.session.session_id,
    session_url: launched.url, model: provider?.label || sessionModel(modelKey), __mobius_post_actions: [launched.postAction] };
}
function distillChatToNote(e, t, user, dir) {
  const sourceRunId = txt(t.run_id || t.source_run_id, 120);
  const sourceRun = e.prepare("SELECT * FROM agent_runs WHERE id=? AND kind='chat'").get(sourceRunId);
  if (!sourceRun) return { ok: false, error: "找不到可沉淀的对话" };
  const noteId = id("note", `conversation:${sourceRun.id}`);
  const existing = e.prepare("SELECT * FROM anchored_notes WHERE id=?").get(noteId);
  if (existing) return { ok: true, async: false, already_saved: true, note: existing };
  const answer = extractFurther(sourceRun.web_reply) || long(sourceRun.web_reply, 14000)
    || e.prepare("SELECT content FROM agent_messages WHERE run_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1").get(sourceRun.id)?.content || "";
  const question = e.prepare("SELECT content FROM agent_messages WHERE run_id=? AND role='user' ORDER BY created_at ASC LIMIT 1").get(sourceRun.id)?.content || "";
  if (!answer) return { ok: false, error: "该轮回答尚未完成" };
  const row = e.prepare("SELECT * FROM paper_fulltext WHERE source_id=?").get(sourceRun.source_id);
  if (!row) return { ok: false, error: "论文全文不存在" };
  const paper = { ...paperOut(row), text_excerpt: row.text_excerpt };
  const modelKey = txt(t.model_key || sourceRun.model_key, 200);
  const provider = findProvider(modelKey);
  return startNoteDistill(e, { paper, sourceRun, question, answer, modelKey, provider, createdBy: user, dir });
}
function pullPostActions(...values) {
  const a = []; for (const v of values) { if (v && typeof v === "object" && Array.isArray(v.__mobius_post_actions)) a.push(...v.__mobius_post_actions); if (v) delete v.__mobius_post_actions; } return a;
}
async function chatWithPaper(e, t, user, dir) {
  const sid = txt(t.source_id || t.arxiv_id || t.id, 200);
  const message = long(t.message, 8000);
  if (!message) return { ok: false, error: "需要 message" };
  const row = e.prepare("SELECT * FROM paper_fulltext WHERE source_id=?").get(sid);
  if (!row) return { ok: false, error: "论文未打开，请先 open_paper" };
  const paper = { ...paperOut(row), text_excerpt: row.text_excerpt };
  const modelKey = txt(t.model_key, 200);
  const provider = findProvider(modelKey);
  const priorConversation = recentConversationContext(e, sid, { maxTurns: 5 });
  // 默认异步接 Agent；sync=true 时直接调 LLM
  if (t.sync === true || t.wait === true) {
    const resp = await callMessages({ provider, paper, message, anchor: t.anchor, priorConversation });
    const runId = id("run", now() + Math.random());
    e.prepare(`INSERT INTO agent_runs (id,source_id,kind,model_key,model_label,status,summary,web_reply,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'completed',?,?,?,?,?)`)
      .run(runId, sid, "chat", txt(modelKey || provider.key, 200), txt(provider.label, 200), long(resp.text, 6000), long(resp.text, 16000), user, now(), now());
    appendMessage(e, runId, "user", message);
    appendMessage(e, runId, "assistant", resp.text);
    return { ok: true, run_id: runId, reply: resp.text, model: provider.label, tokens: resp.usage };
  }
  return startChat(e, { paper, message, anchor: t.anchor, modelKey, provider, createdBy: user, dir });
}
async function fetchJson(urlStr, opts, timeoutMs = 3e4) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(urlStr, { ...opts, signal: ctrl.signal }); const tx = await r.text(); if (!r.ok) throw new Error(`HTTP ${r.status}: ${tx.slice(0, 300)}`); return JSON.parse(tx); } finally { clearTimeout(timer); }
}
async function callMessages({ provider, paper, message, anchor, priorConversation }) {
  const urlStr = provider.baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const relevantContext = relevantPaperContext(paper.text_excerpt || "", message, anchor);
  const system = SEEUPO_ANCHOR + "\n\n论文: " + txt(paper.title, 300) + "\n摘要: " + long(paper.abstract, 3000) + "\n按问题召回的全文相关章节:\n" + long(relevantContext, 26000) + "\n\n" + buildConversationPromptSection(priorConversation);
  const resp = await fetchJson(urlStr, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": provider.authToken, "anthropic-version": "2023-06-01", Authorization: `Bearer ${provider.authToken}` },
    body: JSON.stringify({ model: provider.model, max_tokens: 3000, system, messages: [{ role: "user", content: (anchor ? "[锚定] " + long(anchor, 2000) + "\n" : "") + message }] }) }, 4e4);
  const content = Array.isArray(resp.content) ? resp.content : [];
  const text = content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  return { text, usage: resp.usage || {} };
}

// agent messages / status
function appendMessage(e, runId, role, content) {
  e.prepare("INSERT INTO agent_messages (id,run_id,role,content,created_at) VALUES (?,?,?,?,?)").run(id("msg", now() + Math.random()), runId, role, long(content, 2e4), now());
}
function extractFurther(text) { const m = String(text || "").match(/<further-answering>([\s\S]*?)<\/further-answering>/i); return m ? m[1].trim() : ""; }
function materializeDistilledNote(e, run, reply) {
  if (run.kind !== "note_distill" || run.status !== "completed" || !reply) return null;
  const metaRow = e.prepare("SELECT content FROM agent_messages WHERE run_id=? AND role='system' ORDER BY created_at ASC LIMIT 1").get(run.id);
  let meta = null;
  try { meta = JSON.parse(metaRow?.content || ""); } catch {}
  if (!meta?.note_id) return null;
  const existing = e.prepare("SELECT * FROM anchored_notes WHERE id=?").get(txt(meta.note_id, 120));
  if (existing) return existing;
  return saveNote(e, { id: meta.note_id, source_id: run.source_id, section: meta.section || "AI 对话沉淀", quote: "", note: reply, color: "insight" }, run.created_by).note;
}
function pollRun(e, t) {
  const run = e.prepare("SELECT * FROM agent_runs WHERE id=?").get(txt(t.run_id || t.id, 120));
  if (!run) return { ok: false, error: "run 不存在" };
  let reply = run.web_reply || "";
  const faHead = extractFurther(reply); if (faHead) reply = faHead; // 剥 <further-answering> 标签
  if (!reply) {
    const msgs = e.prepare("SELECT content FROM agent_messages WHERE run_id=? ORDER BY created_at DESC LIMIT 6").all(run.id);
    for (const m of msgs) { const fa = extractFurther(m.content); if (fa) { reply = fa; break; } }
  }
  const note = materializeDistilledNote(e, run, reply);
  return { ok: true, run: { id: run.id, source_id: run.source_id, kind: run.kind, status: run.status, model: run.model_label,
    summary: run.summary, web_reply: reply, session_url: run.session_url, updated_at: run.updated_at, note } };
}
function listRuns(e, t) {
  const lim = int(t?.limit, 30, 1, 200);
  const rows = t.source_id ? e.prepare("SELECT * FROM agent_runs WHERE source_id=? AND kind='chat' ORDER BY created_at DESC LIMIT ?").all(txt(t.source_id, 200), lim) : e.prepare("SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?").all(lim);
  return { items: rows };
}
function getRunMessages(e, t) { return { items: e.prepare("SELECT * FROM agent_messages WHERE run_id=? ORDER BY created_at ASC").all(txt(t.run_id || t.id, 120)) }; }
function listConversation(e, t) {
  const lim = int(t?.limit, 30, 1, 100);
  const rows = e.prepare("SELECT * FROM agent_runs WHERE source_id=? AND kind='chat' ORDER BY created_at DESC LIMIT ?").all(txt(t?.source_id, 200), lim + 1);
  const items = [];
  for (const run of rows) {
    const question = conversationQuestion(e, run);
    const answer = conversationAnswer(e, run);
    if (!question || !answer) continue;
    items.push({ run_id: run.id, status: run.status, model: run.model_label, question, answer,
      created_at: run.created_at, updated_at: run.updated_at, summary: run.summary || "" });
  }
  const hasMore = items.length > lim;
  return { items: items.slice(0, lim).reverse(), has_more: hasMore };
}

// ============ 锚定笔记 ============
function listNotes(e, t) { return { items: e.prepare("SELECT * FROM anchored_notes WHERE source_id=? ORDER BY created_at DESC").all(txt(t.source_id, 200)) }; }
function saveNote(e, t, user) {
  const sid = txt(t.source_id, 200);
  const nid = t.id || id("note", sid + (t.quote || "") + now());
  e.prepare(`INSERT INTO anchored_notes (id,source_id,section,quote,note,color,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET section=excluded.section,quote=excluded.quote,note=excluded.note,color=excluded.color,updated_at=excluded.updated_at`)
    .run(nid, sid, txt(t.section, 200), long(t.quote, 2000), long(t.note, 2e4), txt(t.color, 20), user, now(), now());
  return { ok: true, note: e.prepare("SELECT * FROM anchored_notes WHERE id=?").get(nid) };
}
function deleteNote(e, t) { e.prepare("DELETE FROM anchored_notes WHERE id=?").run(txt(t.id, 120)); return { ok: true }; }

// 段落锚定评论（AlphaXiv 风格 per-paragraph discussion）
function listComments(e, t) {
  const rows = e.prepare("SELECT * FROM paragraph_comments WHERE source_id=? ORDER BY created_at ASC").all(txt(t.source_id, 200));
  const counts = {};
  rows.forEach(r => { counts[r.pid] = (counts[r.pid] || 0) + 1; });
  return { items: rows, counts };
}
function addComment(e, t, user) {
  const cid = id("cmt", now() + Math.random());
  e.prepare("INSERT INTO paragraph_comments (id,source_id,pid,content,created_by,created_at) VALUES (?,?,?,?,?,?)")
    .run(cid, txt(t.source_id, 200), txt(t.pid, 40), long(t.content, 8000), user, now());
  return { ok: true, comment: e.prepare("SELECT * FROM paragraph_comments WHERE id=?").get(cid) };
}
function deleteComment(e, t) { e.prepare("DELETE FROM paragraph_comments WHERE id=?").run(txt(t.id, 120)); return { ok: true }; }

function listAiChannels() {
  const ps = chatProviders();
  return { channels: ps.map(p => ({ key: p.key, label: p.label, model: p.model, type: p.type, is_default: p === ps[0] })), default_key: ps[0]?.key || null };
}

function bootstrapData(e) {
  return { papers: listRecentPapers(e).items, channels: listAiChannels().channels, default_model: listAiChannels().default_key };
}

// ============ dispatch ============
const RETAINED_ACTIONS = ["current_user", "bootstrap", "list_ai_channels", "open_paper", "get_paper", "get_paper_pdf", "list_recent_papers",
  "chat_with_paper", "distill_chat_to_note", "poll_run", "list_runs", "list_conversation", "get_run_messages",
  "list_notes", "save_note", "delete_note",
  "list_comments", "add_comment", "delete_comment"];

async function dispatch(e, t, r, a) {
  const s = txt(t.action || "bootstrap", 64);
  if ("current_user" === s) return { ok: true, user: txt(r, 120) };
  if ("bootstrap" === s) return { ok: true, ...bootstrapData(e), constants: { retained_actions: RETAINED_ACTIONS } };
  if ("list_ai_channels" === s) return { ok: true, ...listAiChannels() };
  if ("open_paper" === s) return { ok: true, ...(await openPaper(e, t, r)) };
  if ("get_paper" === s) return { ok: true, ...getPaper(e, t) };
  if ("get_paper_pdf" === s) return { ok: true, ...(await getPaperPdf(e, t, a)) };
  if ("list_recent_papers" === s) return { ok: true, ...listRecentPapers(e) };
  if ("chat_with_paper" === s) { const res = await chatWithPaper(e, t, r, a); const post = pullPostActions(res); return { ok: true, ...res, ...(post.length ? { __mobius_post_actions: post } : {}) }; }
  if ("distill_chat_to_note" === s) { const res = distillChatToNote(e, t, r, a); const post = pullPostActions(res); return { ok: true, ...res, ...(post.length ? { __mobius_post_actions: post } : {}) }; }
  if ("poll_run" === s) return { ok: true, ...pollRun(e, t) };
  if ("list_runs" === s) return { ok: true, ...listRuns(e, t) };
  if ("list_conversation" === s) return { ok: true, ...listConversation(e, t) };
  if ("get_run_messages" === s) return { ok: true, ...getRunMessages(e, t) };
  if ("list_notes" === s) return { ok: true, ...listNotes(e, t) };
  if ("save_note" === s) return { ok: true, ...saveNote(e, t, r) };
  if ("delete_note" === s) return { ok: true, ...deleteNote(e, t) };
  if ("list_comments" === s) return { ok: true, ...listComments(e, t) };
  if ("add_comment" === s) return { ok: true, ...addComment(e, t, r) };
  if ("delete_comment" === s) return { ok: true, ...deleteComment(e, t) };
  return { ok: false, status: 501, error: `action ${s} 未实现` };
}

module.exports = async function ({ username: e, ext_main_payload: t, ext_data_dir: r, logger: a }) {
  let db;
  try {
    db = dbOpen(r);
    return await dispatch(db, t && typeof t === "object" ? t : {}, e || "unknown", r);
  } catch (err) {
    try { a?.error?.(err.stack || String(err)); } catch {}
    return { ok: false, error: err.message || "处理失败" };
  } finally {
    try { db?.close(); } catch {}
  }
};
