const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto"), { execFileSync } = require("child_process"), Database = require("better-sqlite3"), DB_FILE = "self-cognition.db", FIRST_SCAN_KEY = "first_scan_v4", PAPER_PRIORITY_FORMULA_KEY = "paper_priority_formula_v2_smooth", REPO_ROOT = path.resolve(__dirname, "../../../.."), EXT_PATH = "mobius/extension/self-cognition", PROJECTS = {
  "imac-self-develop": {
    id: "imac-self-develop",
    repo: REPO_ROOT,
    pathspec: null
  },
  "9a533442": {
    id: "imac-self-develop",
    repo: REPO_ROOT,
    pathspec: null
  },
  "ext_self-cognition": {
    id: "ext_self-cognition",
    repo: REPO_ROOT,
    pathspec: EXT_PATH
  },
  "self-cognition": {
    id: "ext_self-cognition",
    repo: REPO_ROOT,
    pathspec: EXT_PATH
  }
}, PAPER_KWS = [ [ "自进化", '"self-evolution" OR "self-evolving agent"' ], [ "递归自指", '"recursive self-improvement" OR "self-referential agent"' ], [ "Agentic OS", '"agentic OS" OR "agent operating system"' ], [ "Agent Harness", '"agent harness" OR "LLM harness" OR "agent framework"' ], [ "哥德尔智能体", '"Gödel Agent" OR "Godel Agent" OR "Gödel machine"' ], [ "自我改进", '"self-improving agent" OR "self improvement"' ], [ "元学习", '"meta learning" OR "meta-learning"' ], [ "工具使用 agent", '"tool use" AND agent' ] ], PROD_KWS = [ "AI agent workspace", "autonomous task execution", "office agent", "coding agent", "workflow automation agent", "research agent", "multi-agent collaboration" ], SEEDS = [ [ "WorkBuddy", "https://www.tencentcloud.com/act/pro/workbuddy", "office-agent" ], [ "HappyCapy", "https://happycapy.ai/", "office-agent" ] ], CATALOG = [ [ "Devin", "https://devin.ai/", "coding-agent", [ "devin.ai", "cognition devin" ] ], [ "Manus", "https://manus.im/", "general-agent", [ "manus.im", "manus agent" ] ], [ "Genspark Super Agent", "https://www.genspark.ai/", "research-agent", [ "genspark", "genspark super agent" ] ], [ "Zapier Agents", "https://zapier.com/agents", "workflow-agent", [ "zapier agents" ] ], [ "Lindy", "https://www.lindy.ai/", "personal-agent", [ "lindy.ai", "lindy agent" ] ], [ "Cursor", "https://www.cursor.com/", "coding-agent", [ "cursor ai", "cursor.com" ] ], [ "Claude Code", "https://www.anthropic.com/claude-code", "coding-agent", [ "claude code" ] ], [ "OpenAI Codex", "https://openai.com/codex/", "coding-agent", [ "openai codex" ] ] ], now = () => (new Date).toISOString(), txt = (e, t = 1e3) => String(e || "").replace(/\s+/g, " ").trim().slice(0, t), long = (e, t = 8e3) => String(e || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().slice(0, t), id = (e, t) => `${e}_${crypto.createHash("sha1").update(String(t)).digest("hex").slice(0, 16)}`, int = (e, t, r, a) => Math.max(r, Math.min(a, Math.floor(Number.isFinite(Number(e)) ? Number(e) : t))), arr = e => {
  try {
    const t = JSON.parse(e || "[]");
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
}, j = e => JSON.stringify([ ...new Set((Array.isArray(e) ? e : String(e || "").split(/[,，;；\n]+/)).map(e => txt(e, 60)).filter(Boolean)) ].slice(0, 20));

function extensionBridge() {
  try {
    return require("../../../backend/services/extension-agent-bridge");
  } catch (firstErr) {
    try {
      return require("../../../backend/services/extension-agent-bridge.ts");
    } catch {
      throw firstErr;
    }
  }
}

function url(e) {
  const t = new URL(txt(e, 800));
  if (!/^https?:$/.test(t.protocol)) throw new Error("source_url 必须是 http(s) URL");
  return t.hash = "", t.toString();
}

function hostnameOf(e) {
  try {
    return new URL(e).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function productHostBrand(e) {
  const host = hostnameOf(e);
  if (!host) return "";
  const parts = host.split(".").filter(Boolean);
  let core = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  if ([ "app", "ai", "io", "dev", "co" ].includes(core) && parts.length >= 3) core = parts[parts.length - 3];
  return core.split(/[-_]+/).filter(Boolean).map(p => p ? p.charAt(0).toUpperCase() + p.slice(1) : "").join(" ");
}

function badProductName(e) {
  const s = txt(e, 260);
  if (!s) return true;
  if (/https?:\/\//i.test(s)) return true;
  if (/(^|\s)(const|let|var)\s+[\w$]+\s*=|domain\s*=|faviconurl|document\.|\$\{|\`|;\s*\/\/|=>|function\s*\(/i.test(s)) return true;
  if (/available in research preview|get on the list|benchmark evaluation set/i.test(s) && s.length > 28) return true;
  if (s.length > 96 && /[=;{}[\]`]|\/\/|\.html/i.test(s)) return true;
  return false;
}

function normalizeProductName(e, sourceUrl) {
  const raw = txt(e, 180).replace(/\s+/g, " ").trim();
  if (!badProductName(raw) && raw.length <= 96) return raw;
  return productHostBrand(sourceUrl) || raw.slice(0, 80);
}

function productSourceRejectReason(e) {
  let u;
  try {
    u = new URL(url(e));
  } catch {
    return "URL 非法";
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if ([ "investing.com", "finance.yahoo.com", "yahoo.com", "latimes.com", "deeplearning.ai", "medium.com", "substack.com", "techcrunch.com", "forbes.com", "bloomberg.com", "reuters.com", "theverge.com", "wired.com" ].some(h => host === h || host.endsWith("." + h))) return `非产品站点: ${host}`;
  if (/\/(news|article|articles|blog|blogs|short-courses|courses|course|learn|academy|press|press-release|podcast|video|events?)\b/i.test(u.pathname)) return `非产品页面: ${u.pathname}`;
  return "";
}

function strictProductCandidateRow(e) {
  if (!e || status(e.status) !== "candidate") return false;
  const logic = txt(e.discovery_logic, 120);
  return !!e.auto_discovered || /outbound_link|agent_session_discovery|llm_agent_discovery|manual_scan/.test(logic);
}

function productCandidateRejectReason(e, opts = {}) {
  if (!e) return "候选为空";
  if (opts.strict) {
    const sourceReason = productSourceRejectReason(e.source_url || e.normalized_url || "");
    if (sourceReason) return sourceReason;
  }
  const fixed = normalizeProductName(e.raw_name || e.name || e.fetched_title, e.source_url || e.normalized_url);
  if (!fixed || badProductName(fixed)) return "名称不是产品名";
  return "";
}

function candidateProductUrl(e) {
  const u = new URL(url(e));
  const keepPath = /^\/(agents?|agent|claude-code|codex|work|products?|platform|browser-agent)\b/i.test(u.pathname);
  if (!keepPath) return u.origin + "/";
  u.search = "";
  return u.toString();
}

function cleanXml(e) {
  return txt(String(e || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&#x([0-9a-f]+);/gi, (e, t) => String.fromCodePoint(parseInt(t, 16))).replace(/&#(\d+);/g, (e, t) => String.fromCodePoint(parseInt(t, 10))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<[^>]+>/g, " "), 2e4);
}

function first(e, t) {
  const r = new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`, "i").exec(e);
  return r ? cleanXml(r[1]) : "";
}

function all(e, t) {
  return [ ...e.matchAll(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`, "ig")) ].map(e => cleanXml(e[1]));
}

function init(e) {
  e.exec("\n    CREATE TABLE IF NOT EXISTS keywords (id TEXT PRIMARY KEY, scope TEXT NOT NULL, keyword TEXT NOT NULL, query TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(scope, keyword));\n    CREATE TABLE IF NOT EXISTS arxiv_items (id TEXT PRIMARY KEY, title TEXT NOT NULL, source_url TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT '', authors TEXT NOT NULL DEFAULT '', published_at TEXT, updated_arxiv_at TEXT, abstract TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', matched_keywords TEXT NOT NULL DEFAULT '[]', relevance INTEGER NOT NULL DEFAULT 0, cluster_label TEXT NOT NULL DEFAULT '', priority_score REAL NOT NULL DEFAULT 0, cluster_keywords TEXT NOT NULL DEFAULT '[]', citations INTEGER NOT NULL DEFAULT 0, mark TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', auto_fetched INTEGER NOT NULL DEFAULT 1, fetched_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);\n    CREATE UNIQUE INDEX IF NOT EXISTS idx_arxiv_source_id ON arxiv_items(source_id) WHERE source_id != '';\n    CREATE TABLE IF NOT EXISTS product_research (id TEXT PRIMARY KEY, name TEXT NOT NULL, source_url TEXT NOT NULL, normalized_url TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'candidate', category TEXT NOT NULL DEFAULT 'other', relevance INTEGER NOT NULL DEFAULT 3, tags TEXT NOT NULL DEFAULT '[]', aliases TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL DEFAULT '', discovery_logic TEXT NOT NULL DEFAULT '', discovered_from_url TEXT NOT NULL DEFAULT '', fetched_title TEXT NOT NULL DEFAULT '', fetched_description TEXT NOT NULL DEFAULT '', mark TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', last_scanned_at TEXT, auto_discovered INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);\n    CREATE TABLE IF NOT EXISTS scan_runs (id TEXT PRIMARY KEY, scan_type TEXT NOT NULL, query TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '', max_results INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, candidates_added INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL);\n    CREATE TABLE IF NOT EXISTS install_state (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);\n    CREATE TABLE IF NOT EXISTS user_feedback (id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('boost','neutral','exclude')), note TEXT, created_at TEXT NOT NULL, source_session TEXT);\n    CREATE TABLE IF NOT EXISTS keyword_weights (keyword TEXT PRIMARY KEY, weight REAL NOT NULL, updated_at TEXT NOT NULL);\n  ");
  e.exec("\n    CREATE TABLE IF NOT EXISTS evolution_events (id TEXT PRIMARY KEY, level TEXT NOT NULL CHECK(level IN ('L1','L2','L3')), source TEXT NOT NULL, status TEXT NOT NULL, project_id TEXT, issue_id TEXT, session_id TEXT, commit_sha TEXT, version TEXT, summary TEXT NOT NULL, diff_summary TEXT, files_changed TEXT, proposed_by TEXT, approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL, promoted_from TEXT);\n    CREATE INDEX IF NOT EXISTS idx_evolution_level_status ON evolution_events(level,status,created_at);\n    CREATE INDEX IF NOT EXISTS idx_evolution_project ON evolution_events(project_id,created_at);\n  ");
  e.exec("\n    CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('paper','product')), scope_ids TEXT NOT NULL DEFAULT '[]', model_key TEXT NOT NULL, model_label TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'running', summary TEXT NOT NULL DEFAULT '', prompt_for_xiaomo TEXT NOT NULL DEFAULT '', token_usage TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);\n    CREATE INDEX IF NOT EXISTS idx_agent_runs_kind_created ON agent_runs(kind, created_at);\n    CREATE TABLE IF NOT EXISTS agent_messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tool_calls TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);\n    CREATE INDEX IF NOT EXISTS idx_agent_messages_run ON agent_messages(run_id, created_at);\n  ");
  e.exec("\n    CREATE TABLE IF NOT EXISTS source_reviews (source_kind TEXT NOT NULL CHECK(source_kind IN ('paper','product')), source_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'deferred' CHECK(status IN ('resolved','deferred','excluded')), note TEXT NOT NULL DEFAULT '', decided_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(source_kind, source_id));\n    CREATE INDEX IF NOT EXISTS idx_source_reviews_status ON source_reviews(source_kind,status,updated_at);\n    CREATE TABLE IF NOT EXISTS inspiration_decisions (id TEXT PRIMARY KEY, source_kind TEXT NOT NULL CHECK(source_kind IN ('paper','product')), source_id TEXT NOT NULL, inspiration_index INTEGER NOT NULL DEFAULT 0, inspiration_key TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL DEFAULT '', mobius_use TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('candidate','accepted','rejected','deferred','queued_one_click','queued_plan','deleted')), source_snapshot TEXT NOT NULL DEFAULT '', chat_snapshot TEXT NOT NULL DEFAULT '', implementation_mode TEXT NOT NULL DEFAULT '', implementation_prompt TEXT NOT NULL DEFAULT '', implementation_session_id TEXT NOT NULL DEFAULT '', implementation_url TEXT NOT NULL DEFAULT '', decided_by TEXT NOT NULL DEFAULT '', decided_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source_kind, source_id, inspiration_key));\n    CREATE INDEX IF NOT EXISTS idx_inspiration_decisions_queue ON inspiration_decisions(status,updated_at);\n    CREATE INDEX IF NOT EXISTS idx_inspiration_decisions_source ON inspiration_decisions(source_kind,source_id);\n  ");
  for (const [t, r, a] of [ [ "arxiv_items", "mark", "TEXT NOT NULL DEFAULT ''" ], [ "arxiv_items", "note", "TEXT NOT NULL DEFAULT ''" ], [ "arxiv_items", "cluster_label", "TEXT NOT NULL DEFAULT ''" ], [ "arxiv_items", "priority_score", "REAL NOT NULL DEFAULT 0" ], [ "arxiv_items", "cluster_keywords", "TEXT NOT NULL DEFAULT '[]'" ], [ "arxiv_items", "citations", "INTEGER NOT NULL DEFAULT 0" ], [ "arxiv_items", "ai_inspiration", "TEXT NOT NULL DEFAULT ''" ], [ "arxiv_items", "read_at", "TEXT" ], [ "product_research", "normalized_url", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "aliases", "TEXT NOT NULL DEFAULT '[]'" ], [ "product_research", "reason", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "discovery_logic", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "discovered_from_url", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "mark", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "note", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "last_scanned_at", "TEXT" ], [ "product_research", "auto_discovered", "INTEGER NOT NULL DEFAULT 0" ], [ "product_research", "ai_inspiration", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "read_at", "TEXT" ], [ "scan_runs", "scan_type", "TEXT NOT NULL DEFAULT 'arxiv'" ], [ "scan_runs", "source_url", "TEXT NOT NULL DEFAULT ''" ], [ "scan_runs", "updated", "INTEGER NOT NULL DEFAULT 0" ], [ "scan_runs", "candidates_added", "INTEGER NOT NULL DEFAULT 0" ] ]) e.prepare(`PRAGMA table_info(${t})`).all().some(e => e.name === r) || e.exec(`ALTER TABLE ${t} ADD COLUMN ${r} ${a}`);
  for (const [t, r, a] of [ [ "agent_runs", "session_id", "TEXT NOT NULL DEFAULT ''" ], [ "agent_runs", "project_id", "TEXT NOT NULL DEFAULT ''" ], [ "agent_runs", "issue_id", "TEXT NOT NULL DEFAULT ''" ], [ "agent_runs", "session_url", "TEXT NOT NULL DEFAULT ''" ], [ "agent_runs", "web_reply", "TEXT NOT NULL DEFAULT ''" ] ]) e.prepare(`PRAGMA table_info(${t})`).all().some(e => e.name === r) || e.exec(`ALTER TABLE ${t} ADD COLUMN ${r} ${a}`);
  e.exec("UPDATE product_research SET normalized_url=source_url WHERE normalized_url=''; UPDATE product_research SET status='tracked' WHERE status='official'; UPDATE product_research SET status='candidate' WHERE status NOT IN ('tracked','candidate','archived'); CREATE UNIQUE INDEX IF NOT EXISTS idx_product_research_normalized_url ON product_research(normalized_url); CREATE UNIQUE INDEX IF NOT EXISTS idx_arxiv_source_id_full ON arxiv_items(source_id);");
  const t = now(), r = e.prepare("INSERT OR IGNORE INTO keywords VALUES (@id,@scope,@keyword,@query,1,@sort_order,@created_at,@updated_at)");
  PAPER_KWS.forEach((e, a) => r.run({
    id: id("kw_paper", e[0]),
    scope: "paper",
    keyword: e[0],
    query: e[1],
    sort_order: a,
    created_at: t,
    updated_at: t
  })), PROD_KWS.forEach((e, a) => r.run({
    id: id("kw_product", e),
    scope: "product",
    keyword: e,
    query: e,
    sort_order: a,
    created_at: t,
    updated_at: t
  })), SEEDS.forEach(t => upsertProduct(e, {
    name: t[0],
    source_url: t[1],
    status: "tracked",
    category: t[2],
    relevance: 8,
    tags: [ "预设竞品" ],
    aliases: [ t[0] ],
    reason: "预设正式竞品",
    discovery_logic: "seed",
    created_by: "system"
  })), seedL3Placeholders(e), ensurePaperPriorityFormula(e);
}

function evolutionRow(e) {
  if (!e) return null;
  const row = { ...e, files_changed: arr(e.files_changed) };
  row.actor = cleanAuthor(row.proposed_by) || txt(row.created_by, 60) || "Mobius";
  row.brief = evolutionBrief(row);
  return row;
}

// "Mobius OS <mobius_os@163.com>" → "Mobius OS"
function cleanAuthor(s) {
  return txt(String(s || "").replace(/\s*<[^>]*>\s*/g, " ").replace(/\s+/g, " ").trim(), 120) || "";
}

// mobius/extension/self-cognition/backend/x.js → self-cognition/backend ; README.md → README
function moduleOf(file) {
  const parts = String(file || "").split("/").filter(Boolean);
  if (!parts.length) return txt(String(file || ""), 40);
  let i = parts[0] === "mobius" ? 1 : 0;
  return parts.slice(i, i + 2).join("/") || parts[0];
}

// 结构化概括 (方案 A: 规则提炼, 不调 LLM)。
// commit 多为 "英文动作 (中文解释)" 格式 → what=英文动作, why=中文解释。
function evolutionBrief(row) {
  const raw = String(row.summary || row.title || "");
  const clean = raw.replace(/^[a-z]+(?:\([^)]*\))?(?:!)?:\s*/i, "").trim() || raw;
  let what = clean, why = "";
  const span = firstCjkParen(clean);
  if (span) {
    what = clean.slice(0, span.start).trim() || clean;
    why = clean.slice(span.start + 1, span.end - 1).trim();
  }
  const modules = [ ...new Set((row.files_changed || []).map(moduleOf)) ].slice(0, 5);
  return {
    what: txt(what, 100) || txt(raw, 100),
    why: txt(why, 220),
    who: cleanAuthor(row.proposed_by) || txt(row.created_by, 60) || "",
    modules
  };
}

// 找第一个含 CJK 的平衡括号段 (...) / （...） (允许嵌套), 返回 {start,end} 闭区间索引; 没有返回 null。
// 容忍截断: 若开括号到串尾都没闭合 (历史 summary 被 300 字截断), 取到串尾作为 why。
function firstCjkParen(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "(" && s[i] !== "（") continue;
    let depth = 0, closeAt = -1;
    for (let j = i; j < s.length; j++) {
      if (s[j] === "(" || s[j] === "（") depth++;
      else if (s[j] === ")" || s[j] === "）") { depth--; if (depth === 0) { closeAt = j; break; } }
    }
    const innerEnd = closeAt >= 0 ? closeAt : s.length;
    if (/[一-鿿]/.test(s.slice(i + 1, innerEnd))) return { start: i, end: innerEnd + (closeAt >= 0 ? 1 : 0) };
    if (closeAt < 0) return null;
  }
  return null;
}

function validEvolutionStatus(e, t) {
  return "L1" === e ? "merged" === t : "L2" === e ? [ "pending_review", "approved", "rejected", "promoted_to_L1" ].includes(t) : "L3" === e && "placeholder" === t;
}

function insertEvolutionEvent(e, t) {
  const r = txt(t.level, 2), a = txt(t.status, 40);
  if (![ "L1", "L2", "L3" ].includes(r)) throw new Error("level 必须是 L1/L2/L3");
  if (!validEvolutionStatus(r, a)) throw new Error(`${r} 不允许 status=${a}`);
  const s = {
    id: t.id || id(`evo_${r.toLowerCase()}`, `${t.project_id || ""}${t.commit_sha || ""}${t.summary || ""}${Date.now()}${Math.random()}`),
    level: r,
    source: txt(t.source || "placeholder", 40),
    status: a,
    project_id: txt(t.project_id, 120) || null,
    issue_id: txt(t.issue_id, 120) || null,
    session_id: txt(t.session_id, 120) || null,
    commit_sha: txt(t.commit_sha, 80) || null,
    version: txt(t.version, 80) || null,
    summary: txt(t.summary, 1500) || "自进化事件",
    diff_summary: txt(t.diff_summary, 200) || null,
    files_changed: JSON.stringify(Array.isArray(t.files_changed) ? [ ...new Set(t.files_changed.map(e => txt(e, 240)).filter(Boolean)) ].slice(0, 80) : []),
    proposed_by: txt(t.proposed_by, 120) || null,
    approved_by: txt(t.approved_by, 120) || null,
    approved_at: txt(t.approved_at, 80) || null,
    created_at: t.created_at || now(),
    promoted_from: txt(t.promoted_from, 120) || null
  };
  e.prepare("INSERT OR IGNORE INTO evolution_events (id,level,source,status,project_id,issue_id,session_id,commit_sha,version,summary,diff_summary,files_changed,proposed_by,approved_by,approved_at,created_at,promoted_from) VALUES (@id,@level,@source,@status,@project_id,@issue_id,@session_id,@commit_sha,@version,@summary,@diff_summary,@files_changed,@proposed_by,@approved_by,@approved_at,@created_at,@promoted_from)").run(s);
  return evolutionRow(e.prepare("SELECT * FROM evolution_events WHERE id=?").get(s.id));
}

function seedL3Placeholders(e) {
  const t = now();
  for (let r = 1; r <= 3; r++) insertEvolutionEvent(e, {
    id: `evo_l3_placeholder_${r}`,
    level: "L3",
    source: "placeholder",
    status: "placeholder",
    project_id: "ext_self-cognition",
    summary: "L3 自进化：莫比乌斯修改莫比乌斯 · 暂未启用",
    diff_summary: "L3 自主修改闭环占位，当前只展示概念层级，不触发真实代码变更。",
    files_changed: [],
    created_at: t
  });
}

function addL2Event(e, t) {
  return insertEvolutionEvent(e, {
    level: "L2",
    source: t.source || "auto_scan",
    status: "pending_review",
    project_id: t.project_id || "ext_self-cognition",
    issue_id: t.issue_id,
    session_id: t.session_id,
    summary: t.summary,
    diff_summary: t.diff_summary,
    files_changed: t.files_changed || [],
    proposed_by: t.proposed_by || "system"
  });
}

function projectList(e) {
  const t = txt(e.project_id, 120);
  return t ? [ PROJECTS[t] || {
    id: t,
    repo: REPO_ROOT,
    pathspec: t.includes("self-cognition") ? EXT_PATH : null
  } ] : [ PROJECTS["imac-self-develop"], PROJECTS["ext_self-cognition"] ];
}

function git(e, t) {
  return execFileSync("git", [ "-C", e, ...t ], {
    encoding: "utf8",
    stdio: [ "ignore", "pipe", "ignore" ],
    timeout: 12000,
    maxBuffer: 1024 * 1024
  });
}

function gitFiles(e, t, r) {
  const a = [ "show", "--name-only", "--pretty=format:", r ];
  t && a.push("--", t);
  return git(e, a).split(/\n+/).map(e => txt(e, 240)).filter(Boolean).filter(e => !/^\d+\s+files? changed/.test(e)).slice(0, 80);
}

function gitDiffSummary(e, t, r, a) {
  let s = "";
  try {
    s = git(e, [ "show", "--stat", "--oneline", "--no-renames", "--format=%s", r, ...(t ? [ "--", t ] : []) ]);
  } catch {}
  const o = s.split("\n").map(e => txt(e, 160)).filter(Boolean).slice(0, 5), c = a.slice(0, 6).join("、"), n = o[0] || "提交变更";
  return txt(`${n}${c ? `；涉及 ${c}${a.length > 6 ? ` 等 ${a.length} 个文件` : ""}` : ""}`, 200);
}

const EVOLUTION_SCAN_KEY = "last_evolution_scan_at";

function seedEvolutionFromGit(e, t = {}) {
  const r = int(t.limit, 80, 1, 300), a = [];
  let sinceArg = "";
  if ("auto" === String(t.since || "").trim()) {
    const prev = e.prepare("SELECT value FROM install_state WHERE key=?").get(EVOLUTION_SCAN_KEY)?.value;
    if (prev) sinceArg = txt(prev, 80);
  } else if (t.since) {
    sinceArg = txt(t.since, 80);
  }
  const newIds = [];
  for (const s of projectList(t)) {
    const o = [ "log", `--pretty=format:%H|%an|%ae|%at|%s`, `-${r}` ];
    sinceArg && o.push(`--since=${sinceArg}`);
    s.pathspec && o.push("--", s.pathspec);
    const c = git(s.repo, o).split("\n").map(e => e.trim()).filter(Boolean);
    let n = 0;
    for (const t of c) {
      const [r, o, c, d, ...i] = t.split("|"), u = i.join("|"), l = gitFiles(s.repo, s.pathspec, r);
      const evId = id("evo_l1_git", `${s.id}:${r}`), stamp = new Date(1e3 * Number(d)).toISOString();
      const fields = {
        summary: txt(u, 1500) || `Git commit ${r.slice(0, 8)}`,
        diff: gitDiffSummary(s.repo, s.pathspec, r, l),
        filesJson: JSON.stringify(l),
        proposedBy: txt(`${o} <${c}>`, 180),
        stamp
      };
      // 已存在的 L1 git 行也刷新 (旧行 summary 被旧版截断到 300, 重扫升级到 1500 让概括更完整)。
      e.prepare("UPDATE evolution_events SET summary=?, diff_summary=?, files_changed=?, proposed_by=?, approved_at=?, created_at=? WHERE id=? AND level='L1' AND source='git_commit'").run(fields.summary, fields.diff, fields.filesJson, fields.proposedBy, fields.stamp, fields.stamp, evId);
      const p = insertEvolutionEvent(e, {
        id: evId,
        level: "L1",
        source: "git_commit",
        status: "merged",
        project_id: s.id,
        commit_sha: r,
        summary: fields.summary,
        diff_summary: fields.diff,
        files_changed: l,
        proposed_by: fields.proposedBy,
        approved_by: "git",
        approved_at: fields.stamp,
        created_at: fields.stamp
      });
      if (p && p.commit_sha === r) {
        n++;
        p.created_at >= sinceArg && newIds.push(p.id);
      }
    }
    a.push({
      project_id: s.id,
      scanned: c.length,
      inserted_or_existing: n
    });
  }
  const stamp = now();
  e.prepare("INSERT INTO install_state VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(EVOLUTION_SCAN_KEY, stamp, stamp);
  return {
    projects: a,
    total_scanned: a.reduce((e, t) => e + t.scanned, 0),
    since: sinceArg || null,
    scanned_at: stamp,
    new_events: newIds.slice(0, 20).map(eid => evolutionRow(e.prepare("SELECT * FROM evolution_events WHERE id=?").get(eid))).filter(Boolean),
    new_count: newIds.length
  };
}

function getEvolutionFeed(e, t = {}) {
  const r = [], a = [], s = txt(t.level, 2), o = txt(t.project_id, 120), c = txt(t.status, 40);
  s && (r.push("level=?"), a.push(s));
  o && (r.push("project_id=?"), a.push(o));
  c && (r.push("status=?"), a.push(c));
  const n = r.length ? `WHERE ${r.join(" AND ")}` : "", d = int(t.limit, 20, 1, 100), i = int(t.offset, 0, 0, 1e5);
  return {
    items: e.prepare(`SELECT * FROM evolution_events ${n} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...a, d, i).map(evolutionRow),
    total: e.prepare(`SELECT COUNT(*) n FROM evolution_events ${n}`).get(...a).n,
    limit: d,
    offset: i
  };
}

function promoteL2ToL1(e, t, r) {
  const a = txt(t.event_id, 120), s = e.prepare("SELECT * FROM evolution_events WHERE id=?").get(a);
  if (!s) throw new Error("event_id 不存在");
  if ("L2" !== s.level) throw new Error("只能升级 L2 event");
  if ("promoted_to_L1" === s.status) throw new Error("该 L2 event 已升级");
  const o = now(), c = insertEvolutionEvent(e, {
    id: id("evo_l1_promoted", `${a}:${o}`),
    level: "L1",
    source: s.source,
    status: "merged",
    project_id: s.project_id,
    issue_id: s.issue_id,
    session_id: s.session_id,
    commit_sha: s.commit_sha,
    version: s.version,
    summary: s.summary,
    diff_summary: s.diff_summary,
    files_changed: arr(s.files_changed),
    proposed_by: s.proposed_by,
    approved_by: r,
    approved_at: o,
    created_at: o,
    promoted_from: a
  });
  e.prepare("UPDATE evolution_events SET status='promoted_to_L1',promoted_from=? WHERE id=?").run(a, a);
  return {
    l1_event: c,
    l2_event: evolutionRow(e.prepare("SELECT * FROM evolution_events WHERE id=?").get(a))
  };
}

function evolutionStats(e) {
  const t = e.prepare("SELECT level,status,COUNT(*) n FROM evolution_events GROUP BY level,status").all(), r = {
    L1: {
      total: 0
    },
    L2: {
      total: 0
    },
    L3: {
      total: 0
    }
  };
  for (const e of t) r[e.level] && (r[e.level].total += e.n, r[e.level][e.status] = e.n);
  return r;
}

function dbOpen(e) {
  fs.mkdirSync(e, {
    recursive: !0
  });
  const t = new Database(path.join(e, DB_FILE));
  return t.pragma("journal_mode=WAL"), init(t), t;
}

const DAILY_SCAN_HOUR_UTC = 17, DAILY_SCAN_MINUTE_UTC = 0, DAILY_SCAN_INTERVAL_MINUTES = 1440, SCHEDULE_IDS = [ "self-cognition-arxiv-1700", "self-cognition-products-1700", "self-cognition-evolution-1700" ], RETIRED_SCHEDULE_IDS = [ "self-cognition-arxiv-0900", "self-cognition-products-1000", "self-cognition-evolution-0030", "self-cognition-evolution-1100" ];

function nextAt(e, minute = 0) {
  const t = new Date;
  return t.setUTCHours(e, minute, 0, 0), t <= new Date && t.setUTCDate(t.getUTCDate() + 1),
  t.toISOString();
}

function syncSchedules(e, t) {
  const r = [ [ "self-cognition-arxiv-1700", {
    action: "scan_arxiv",
    scheduled_daily_scan: !0,
    auto_ai_read: !0,
    deep_read_backlog: !0,
    max_results: 100
  } ], [ "self-cognition-products-1700", {
    action: "scan_product_url",
    scheduled_daily_scan: !0,
    auto_ai_read: !0,
    deep_read_backlog: !0,
    all_tracked: !0,
    discover: !0
  } ], [ "self-cognition-evolution-1700", {
    action: "seed_evolution_from_git",
    since: "auto",
    limit: 80
  } ] ], a = path.join(e, "schedules");
  fs.mkdirSync(a, {
    recursive: !0
  });
  for (const e of RETIRED_SCHEDULE_IDS) if (!SCHEDULE_IDS.includes(e)) try {
    fs.unlinkSync(path.join(a, `${e}.json`));
  } catch {}
  for (const [e, o] of r) {
    const r = path.join(a, `${e}.json`);
    let c = {};
    try {
      c = JSON.parse(fs.readFileSync(r, "utf8"));
    } catch {}
    fs.writeFileSync(r, JSON.stringify({
      ...c,
      id: e,
      extension_name: "self-cognition",
      user_id: t || "admin",
      enabled: !0,
      interval_minutes: DAILY_SCAN_INTERVAL_MINUTES,
      next_run_at: c.next_run_at || nextAt(DAILY_SCAN_HOUR_UTC, DAILY_SCAN_MINUTE_UTC),
      payload: o,
      updated_at: now()
    }, null, 2));
  }
}

function rows(e, t) {
  return e.prepare("SELECT * FROM keywords WHERE scope=? ORDER BY enabled DESC, sort_order, keyword").all(t);
}

function kwQuery(e) {
  return rows(e, "paper").filter(e => e.enabled).map(e => `(${e.query || e.keyword})`).join(" OR ");
}

async function fetchText(e, t = 18e3) {
  const r = new AbortController, a = setTimeout(() => r.abort(), t);
  try {
    const t = await fetch(e, {
      signal: r.signal,
      headers: {
        "user-agent": "Mobius self-cognition/0.4"
      }
    });
    if (!t.ok) throw new Error(`HTTP ${t.status}`);
    return await t.text();
  } finally {
    clearTimeout(a);
  }
}

function parseArxiv(e) {
  return [ ...e.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi) ].map(e => {
    const t = e[1], r = first(t, "id"), a = (r.match(/\/abs\/([^/]+)$/) || [])[1] || r;
    return {
      title: first(t, "title"),
      source_url: r.replace(/^http:/, "https:"),
      source_id: a.replace(/v\d+$/, ""),
      authors: all(t, "name").join("; "),
      published_at: first(t, "published").slice(0, 10),
      updated_arxiv_at: first(t, "updated"),
      abstract: first(t, "summary"),
      tags: [ ...t.matchAll(/<category\b[^>]*term=["']([^"']+)["']/gi) ].map(e => cleanXml(e[1]))
    };
  }).filter(e => e.title && e.source_url);
}

function clusterDefs() {
  return [ [ "自进化", "self-modification", [ "self-evolution", "self-evolving", "self modification", "self-modification", "evolution" ] ], [ "递归自指", "recursive-self-reference", [ "recursive self-improvement", "self-referential", "self reference", "recursive" ] ], [ "Agentic OS", "agentic-os", [ "agentic os", "agent operating system", "operating system" ] ], [ "Agent Harness", "agent-harness", [ "agent harness", "llm harness", "agent framework", "harness" ] ], [ "哥德尔智能体", "godel-agents", [ "gödel agent", "godel agent", "gödel machine", "godel machine" ] ], [ "自我改进", "self-improvement", [ "self-improving", "self improvement", "self-improvement" ] ], [ "元学习", "meta-learning", [ "meta learning", "meta-learning", "metalearning" ] ], [ "工具使用 agent", "tool-use", [ "tool use", "tool-use", "tool using", "function calling" ] ] ];
}

function titleTokens(e) {
  return new Set(txt(e, 500).toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, " ").split(/\s+/).filter(e => e.length > 2));
}

function recalcKeywordWeights(e) {
  const t = Object.fromEntries(PAPER_KWS.map(e => [ e[0], 1 ]));
  for (const r of e.prepare("SELECT f.verdict,p.cluster_keywords,p.matched_keywords FROM user_feedback f JOIN arxiv_items p ON p.id=f.paper_id").all()) {
    const e = arr(r.cluster_keywords).length ? arr(r.cluster_keywords) : arr(r.matched_keywords);
    for (const a of e) t[a] == null || ("boost" === r.verdict ? t[a] *= 2 : "exclude" === r.verdict && (t[a] *= .05));
  }
  const r = now(), a = e.prepare("INSERT INTO keyword_weights (keyword,weight,updated_at) VALUES (?,?,?) ON CONFLICT(keyword) DO UPDATE SET weight=excluded.weight,updated_at=excluded.updated_at");
  e.transaction(() => Object.entries(t).forEach(([e, t]) => a.run(e, t, r)))();
  return t;
}

function scorePaper(e, t, r = {}) {
  const a = `${e.title} ${e.abstract} ${e.tags.join(" ")}`.toLowerCase(), s = titleTokens(e.title), o = [], c = {};
  for (const e of t.filter(e => e.enabled)) {
    const t = `${e.keyword} ${e.query}`.replace(/[()"']/g, " ").split(/\s+OR\s+|\s+AND\s+|\s+/i).map(e => e.toLowerCase()).filter(e => e.length > 2);
    t.some(e => a.includes(e)) && o.push(e.keyword);
  }
  for (const [e, t, r] of clusterDefs()) {
    let o = a.includes(e.toLowerCase()) ? 1 : 0;
    for (const e of r) a.includes(e) && (o += 2), e.split(/\s+/).some(e => s.has(e)) && o++;
    c[t] = o;
  }
  const n = Object.entries(c).sort((e, t) => t[1] - e[1])[0] || [ "other", 0 ], d = clusterDefs().filter(e => c[e[1]] > 0).map(e => e[0]), i = d.length ? d : o;
  const signals = [ ...new Set(i.map(e => txt(e, 80)).filter(Boolean)) ], signalCount = signals.length;
  const avgWeight = signalCount ? signals.reduce((e, t) => e + Math.max(0.05, Number(r[t] || 1)), 0) / signalCount : 1;
  const ageDays = e.published_at ? Math.max(0, (Date.now() - Date.parse(e.published_at)) / 864e5) : null;
  const coverageScore = signalCount ? Math.min(30, 10 + 3.5 * signalCount) : 6;
  const weightScore = Math.min(20, 8 + 12 * Math.log1p(avgWeight) / Math.log(9));
  const recencyScore = ageDays == null ? 12 : Math.max(10, 20 * Math.exp(-ageDays / 210));
  const breadthScore = Math.min(12, 1.2 * o.length);
  const clusterScore = n[1] > 0 && n[0] !== "other" ? 5 : 0;
  const citationScore = Math.min(6, Math.log10(1 + Math.max(0, Number(e.citations || 0))) * 3);
  const priorityScore = coverageScore + weightScore + recencyScore + breadthScore + clusterScore + citationScore;
  return {
    matched: o,
    relevance: 10 * o.length + (e.published_at ? Math.max(0, 5 - Math.floor((Date.now() - Date.parse(e.published_at)) / 31536e6)) : 0),
    cluster_label: n[1] > 0 ? n[0] : "other",
    cluster_keywords: i,
    priority_score: Math.max(0, Math.min(100, Math.round(priorityScore * 10) / 10))
  };
}

function ensurePaperPriorityFormula(e) {
  const version = "v2_smooth_2026_07_02";
  const current = e.prepare("SELECT value FROM install_state WHERE key=?").get(PAPER_PRIORITY_FORMULA_KEY)?.value || "";
  if (current === version) return;
  const papers = e.prepare("SELECT id,title,abstract,tags,published_at,citations FROM arxiv_items").all();
  const keywords = rows(e, "paper"), weights = recalcKeywordWeights(e), stamp = now();
  const update = e.prepare("UPDATE arxiv_items SET matched_keywords=?,relevance=?,cluster_label=?,priority_score=?,cluster_keywords=?,updated_at=? WHERE id=?");
  const state = e.prepare("INSERT INTO install_state (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at");
  e.transaction(() => {
    for (const paper of papers) {
      const scored = scorePaper({
        ...paper,
        tags: arr(paper.tags),
        citations: Number(paper.citations) || 0
      }, keywords, weights);
      update.run(j(scored.matched), scored.relevance, scored.cluster_label, scored.priority_score, j(scored.cluster_keywords), stamp, paper.id);
    }
    state.run(PAPER_PRIORITY_FORMULA_KEY, version, stamp);
  })();
}

async function scanArxiv(e, t, r) {
  const a = txt(t.query, 1500) || kwQuery(e), s = int(t.max_results, 100, 1, 500), o = id("scan", `${Date.now()}${Math.random()}`), c = now();
  let n = 0, d = 0, i = 0;
  const g = [];
  try {
    const p = recalcKeywordWeights(e), t = parseArxiv(await fetchText(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(a)}&start=0&max_results=${s}&sortBy=relevance&sortOrder=descending`, 22e3)), u = rows(e, "paper"), l = e.prepare("INSERT INTO arxiv_items (id,title,source_url,source_id,authors,published_at,updated_arxiv_at,abstract,tags,matched_keywords,relevance,cluster_label,priority_score,cluster_keywords,fetched_at,created_by,created_at,updated_at) VALUES (@id,@title,@source_url,@source_id,@authors,@published_at,@updated_arxiv_at,@abstract,@tags,@matched_keywords,@relevance,@cluster_label,@priority_score,@cluster_keywords,@fetched_at,@created_by,@created_at,@updated_at) ON CONFLICT(source_id) DO UPDATE SET title=excluded.title,source_url=excluded.source_url,authors=excluded.authors,published_at=excluded.published_at,updated_arxiv_at=excluded.updated_arxiv_at,abstract=excluded.abstract,tags=excluded.tags,matched_keywords=excluded.matched_keywords,relevance=excluded.relevance,cluster_label=excluded.cluster_label,priority_score=excluded.priority_score,cluster_keywords=excluded.cluster_keywords,fetched_at=excluded.fetched_at,updated_at=excluded.updated_at");
    e.transaction(() => t.forEach(t => {
      const a = scorePaper(t, u, p), s = e.prepare("SELECT id FROM arxiv_items WHERE source_id=?").get(t.source_id);
      const paperId = id("arxiv", t.source_id || t.source_url);
      l.run({
        id: paperId,
        title: txt(t.title, 300),
        source_url: url(t.source_url),
        source_id: txt(t.source_id, 120),
        authors: txt(t.authors, 800),
        published_at: t.published_at || null,
        updated_arxiv_at: t.updated_arxiv_at || null,
        abstract: long(t.abstract),
        tags: j([ "arXiv", ...t.tags ]),
        matched_keywords: j(a.matched),
        relevance: a.relevance,
        cluster_label: a.cluster_label,
        priority_score: a.priority_score,
        cluster_keywords: j(a.cluster_keywords),
        fetched_at: c,
        created_by: r,
        created_at: c,
        updated_at: c
      }), s ? d++ : (n++, g.push(paperId));
    }))();
    const discovery = discoverFromCorpus(e), i = discovery.count;
    return n > 5 && addL2Event(e, {
      source: "auto_scan",
      summary: `发现 ${n} 篇新论文`,
      diff_summary: `arXiv 扫描新增 ${n} 篇论文，查询条件: ${txt(a, 120)}`,
      files_changed: [ "arxiv_items", "scan_runs" ],
      proposed_by: r
    }), run(e, o, "arxiv", a, "", s, n, d, 0, i, "ok", "", r, c),
    {
      run_id: o,
      fetched: t.length,
      inserted: n,
      updated: d,
      skipped: 0,
      candidates_added: i,
      max_results: s,
      query: a,
      new_items: g.slice(0, 20).map(pid => paperOut(e.prepare("SELECT * FROM arxiv_items WHERE id=?").get(pid))).filter(Boolean),
      new_count: g.length,
      new_ids: g,
      discovered_product_ids: discovery.ids
    };
  } catch (t) {
    throw run(e, o, "arxiv", a, "", s, 0, 0, 0, 0, "error", t.message, r, c), new Error(`arXiv 扫描失败: ${txt(t.message, 180)}`);
  }
}

function meta(e) {
  const t = String(e || "").slice(0, 1e6), r = cleanXml((t.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ""), a = t.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]+content=["']([^"']+)["']/i) || t.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["']/i), s = cleanXml(t.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")), o = [ ...t.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi) ].slice(0, 200).map(e => ({
    href: cleanXml(e[1]),
    text: cleanXml(e[2])
  }));
  return {
    title: txt(r, 260),
    description: txt((a || [])[1] || "", 1e3),
    visible: long(s, 12e3),
    links: o
  };
}

function cat(e) {
  const t = e.toLowerCase();
  return /coding|developer|codebase|代码|编程/.test(t) ? "coding-agent" : /research|search|调研|搜索/.test(t) ? "research-agent" : /workflow|automation|自动化|流程/.test(t) ? "workflow-agent" : /office|document|ppt|meeting|办公|文档/.test(t) ? "office-agent" : /assistant|personal|日程|邮件|助理/.test(t) ? "personal-agent" : /agent|智能体|autonomous/.test(t) ? "general-agent" : "other";
}

function rel(e) {
  const t = e.toLowerCase();
  let r = /agent|智能体|autonomous|workflow|workspace|copilot|assistant|coding|research/i.test(e) ? 2 : 0;
  const a = PROD_KWS.filter(e => e.split(/\s+/).some(e => e.length > 2 && t.includes(e.toLowerCase())));
  return {
    score: r + a.length,
    matched: a
  };
}

function status(e) {
  return "official" === e ? "tracked" : [ "tracked", "candidate", "archived" ].includes(e) ? e : "candidate";
}

function prodRow(e) {
  return e ? {
    ...e,
    raw_name: e.name,
    name: normalizeProductName(e.name || e.fetched_title, e.source_url || e.normalized_url),
    status: "tracked" === e.status ? "official" : e.status,
    tracked_status: e.status,
    relevance: Number(e.relevance) || 0,
    tags: arr(e.tags),
    aliases: arr(e.aliases),
    auto_discovered: !!e.auto_discovered,
    read_at: e.read_at || null
  } : null;
}

function upsertProduct(e, t) {
  const r = url(t.source_url), a = now(), s = e.prepare("SELECT id,status FROM product_research WHERE normalized_url=?").get(r), nextStatus = "tracked" === s?.status ? "tracked" : status(t.status);
  if (nextStatus !== "tracked") {
    const rejectReason = productSourceRejectReason(r);
    if (rejectReason) throw new Error(`非产品候选，已跳过：${rejectReason}`);
  }
  const o = {
    id: s?.id || t.id || id("product", r),
    name: normalizeProductName(t.name || t.fetched_title, r) || new URL(r).hostname.replace(/^www\./, ""),
    source_url: r,
    normalized_url: r,
    status: nextStatus,
    category: txt(t.category || "other", 40),
    relevance: int(t.relevance, 3, 1, 10),
    tags: j(t.tags || []),
    aliases: j(t.aliases || [ t.name ]),
    reason: long(t.reason, 3e3),
    discovery_logic: long(t.discovery_logic, 2e3),
    discovered_from_url: t.discovered_from_url ? url(t.discovered_from_url) : "",
    fetched_title: txt(t.fetched_title, 260),
    fetched_description: txt(t.fetched_description, 1e3),
    mark: txt(t.mark, 40),
    note: long(t.note, 3e3),
    last_scanned_at: t.last_scanned_at || null,
    auto_discovered: t.auto_discovered ? 1 : 0,
    created_by: txt(t.created_by, 80) || "system",
    created_at: t.created_at || a,
    updated_at: a
  };
  return e.prepare("INSERT INTO product_research (id,name,source_url,normalized_url,status,category,relevance,tags,aliases,reason,discovery_logic,discovered_from_url,fetched_title,fetched_description,mark,note,last_scanned_at,auto_discovered,created_by,created_at,updated_at) VALUES (@id,@name,@source_url,@normalized_url,@status,@category,@relevance,@tags,@aliases,@reason,@discovery_logic,@discovered_from_url,@fetched_title,@fetched_description,@mark,@note,@last_scanned_at,@auto_discovered,@created_by,@created_at,@updated_at) ON CONFLICT(normalized_url) DO UPDATE SET name=excluded.name,status=CASE WHEN product_research.status='tracked' THEN 'tracked' WHEN excluded.status='tracked' THEN 'tracked' ELSE excluded.status END,category=excluded.category,relevance=max(product_research.relevance,excluded.relevance),tags=excluded.tags,aliases=excluded.aliases,reason=CASE WHEN excluded.reason!='' THEN excluded.reason ELSE product_research.reason END,discovery_logic=excluded.discovery_logic,discovered_from_url=excluded.discovered_from_url,fetched_title=excluded.fetched_title,fetched_description=excluded.fetched_description,last_scanned_at=COALESCE(excluded.last_scanned_at,product_research.last_scanned_at),auto_discovered=max(product_research.auto_discovered,excluded.auto_discovered),updated_at=excluded.updated_at").run(o),
  {
    item: prodRow(e.prepare("SELECT * FROM product_research WHERE normalized_url=?").get(r)),
    created: !s
  };
}

function addDiscoveryResult(e, t) {
  t?.created && (e.count++, t.item?.id && e.ids.push(t.item.id));
}

function discoverLinks(e, t, r) {
  const a = `${t.title}\n${t.description}\n${t.visible}\n${t.links.map(e => `${e.text} ${e.href}`).join("\n")}`.toLowerCase();
  const s = { count: 0, ids: [] };
  for (const t of CATALOG) t[3].some(e => a.includes(e.toLowerCase())) && addDiscoveryResult(s, upsertProduct(e, {
      name: t[0],
      source_url: t[1],
      status: "candidate",
      category: t[2],
      relevance: 6,
      tags: [ "自动发现", "候选竞品" ],
      aliases: [ t[0], ...t[3] ],
      reason: `扫描 ${r} 时命中同类产品线索`,
      discovery_logic: "catalog_alias_match",
      discovered_from_url: r,
      auto_discovered: !0,
      created_by: "system"
    }));
  for (const a of t.links) try {
    const rawUrl = url(a.href);
    const t = new URL(rawUrl);
    if (t.hostname === new URL(r).hostname) continue;
    const rejectReason = productSourceRejectReason(rawUrl);
    if (rejectReason) continue;
    const candidateUrl = candidateProductUrl(rawUrl);
    const o = rel(`${a.text} ${candidateUrl}`);
    o.score >= 3 && addDiscoveryResult(s, upsertProduct(e, {
        name: normalizeProductName(a.text, candidateUrl) || t.hostname,
        source_url: candidateUrl,
        status: "candidate",
        category: cat(`${a.text} ${a.href}`),
        relevance: Math.min(10, o.score + 2),
        tags: [ "自动发现", "外链线索", ...o.matched ],
        reason: `扫描 ${r} 时发现相关外链 ${t.hostname}`,
        discovery_logic: "outbound_link_keyword_score>=3",
        discovered_from_url: r,
        auto_discovered: !0,
        created_by: "system"
      }));
  } catch {}
  return s;
}

function discoverFromCorpus(e) {
  const t = e.prepare("SELECT title,abstract,tags FROM arxiv_items ORDER BY updated_at DESC LIMIT 300").all(), r = e.prepare("SELECT name,tags,aliases,category FROM product_research").all(), a = [ ...t.map(e => `${e.title} ${e.abstract} ${e.tags}`), ...r.map(e => `${e.name} ${e.tags} ${e.aliases} ${e.category}`) ].join("\n").toLowerCase();
  const s = { count: 0, ids: [] };
  for (const t of CATALOG) {
    const r = t[3].filter(e => a.includes(e.toLowerCase())).length;
    r && addDiscoveryResult(s, upsertProduct(e, {
        name: t[0],
        source_url: t[1],
        status: "candidate",
        category: t[2],
        relevance: Math.min(10, 5 + r),
        tags: [ "自动发现", "论文/产品库线索" ],
        aliases: [ t[0], ...t[3] ],
        reason: "论文与已有产品库中出现同类产品名称/别名/标签线索",
        discovery_logic: "paper_product_corpus_alias_or_tag_match",
        auto_discovered: !0,
        created_by: "system"
      }));
  }
  return s;
}

async function scanOneProduct(e, t, r) {
  recalcKeywordWeights(e);
  const a = url(t.source_url), s = id("pscan", `${Date.now()}${Math.random()}`), o = now();
  try {
    const c = meta(await fetchText(a)), n = rel(`${c.title}\n${c.description}\n${c.visible}`), d = e.prepare("SELECT id,status FROM product_research WHERE normalized_url=?").get(a), i = upsertProduct(e, {
      id: t.id,
      name: t.name || c.title,
      source_url: a,
      status: t.as_official ? "tracked" : t.status || d?.status || "candidate",
      category: t.category || cat(c.visible),
      relevance: t.relevance || Math.min(10, Math.max(3, n.score + 2)),
      tags: [ "扫描入库", ...n.matched ],
      aliases: [ t.name, c.title ].filter(Boolean),
      reason: t.reason || `扫描页面元信息入库。匹配关键词: ${n.matched.join("、") || "待复核"}`,
      discovery_logic: t.as_official ? "manual_or_scheduled_tracked_scan" : "manual_scan",
      fetched_title: c.title,
      fetched_description: c.description,
      last_scanned_at: now(),
      auto_discovered: !t.as_official && !d,
      created_by: r
    });
    const l = discoverLinks(e, c, a), p = discoverFromCorpus(e), u = l.count + p.count, m = [ ...new Set([ ...l.ids, ...p.ids ]) ];
    (i.created && "tracked" !== i.item?.tracked_status || u > 0) && addL2Event(e, {
      source: "auto_scan",
      summary: `发现新候选竞品 ${i.item?.name || new URL(a).hostname}`,
      diff_summary: `竞品扫描新增候选 ${i.item?.name || new URL(a).hostname}${u > 0 ? `，并从页面/语料发现 ${u} 条候选线索` : ""}`,
      files_changed: [ "product_research", "scan_runs" ],
      proposed_by: r
    });
    return run(e, s, "product", "", a, 0, i.created ? 1 : 0, i.created ? 0 : 1, 0, u, "ok", "", r, o),
    {
      run_id: s,
      competitor: i.item,
      candidates_added: u,
      touched_ids: [ ...new Set([ ...(i.item?.id ? [ i.item.id ] : []), ...m ]) ]
    };
  } catch (t) {
    throw run(e, s, "product", "", a, 0, 0, 0, 0, 0, "error", t.message, r, o), new Error(`竞品扫描失败: ${txt(t.message, 180)}`);
  }
}

async function scanProducts(e, t) {
  const r = e.prepare("SELECT * FROM product_research WHERE status='tracked' ORDER BY relevance DESC,name").all(), a = [];
  for (const s of r) try {
    a.push(await scanOneProduct(e, {
      source_url: s.source_url,
      name: s.name,
      category: s.category,
      status: "tracked",
      as_official: !0
    }, t));
  } catch (e) {
    a.push({
      source_url: s.source_url,
      ok: !1,
      error: e.message
    });
  }
  return a;
}

async function scanProductAction(e, t, r) {
  if (t.all_tracked) {
    const a = await scanProducts(e, r), o = discoverFromCorpus(e), s = o.count;
    s > 0 && addL2Event(e, {
      source: "auto_scan",
      summary: `发现新候选竞品 ${s} 条`,
      diff_summary: `全量竞品扫描后从论文/产品语料中新增 ${s} 条候选竞品线索`,
      files_changed: [ "product_research", "scan_runs" ],
      proposed_by: r
    });
    const touched = [ ...new Set([ ...a.flatMap(p => p.touched_ids || []), ...o.ids ].filter(Boolean)) ];
    const touched_items = touched.slice(0, 20).map(pid => prodRow(e.prepare("SELECT * FROM product_research WHERE id=?").get(pid))).filter(Boolean);
    return {
      products: a,
      candidates_added: s,
      touched_ids: touched,
      touched_items,
      touched_count: touched.length
    };
  }
  return scanOneProduct(e, t, r);
}

function run(e, ...t) {
  e.prepare("INSERT INTO scan_runs (id,scan_type,query,source_url,max_results,inserted,updated,skipped,candidates_added,status,error,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...t.map(e => "string" == typeof e ? txt(e, 2e3) : e));
}

function listPapers(e, t = {}) {
  const r = txt(t.q, 120), a = txt(t.keyword, 80), s = [], o = [];
  if (r) {
    const e = `%${r.replace(/[%_]/g, "\\$&")}%`;
    s.push("(title LIKE ? ESCAPE '\\' OR abstract LIKE ? ESCAPE '\\' OR authors LIKE ? ESCAPE '\\')"),
    o.push(e, e, e);
  }
  a && (s.push("matched_keywords LIKE ?"), o.push(`%"${a.replace(/"/g, "")}"%`));
  const c = s.length ? `WHERE ${s.join(" AND ")}` : "", n = int(t.limit, 200, 1, 1e3), d = int(t.offset, 0, 0, 1e5);
  return {
    items: e.prepare(`SELECT * FROM arxiv_items ${c} ORDER BY relevance DESC,COALESCE(published_at,created_at) DESC,title LIMIT ? OFFSET ?`).all(...o, n, d).map(e => ({
      ...e,
      tags: arr(e.tags),
      matched_keywords: arr(e.matched_keywords),
      cluster_keywords: arr(e.cluster_keywords),
      priority_score: Number(e.priority_score) || 0,
      read_at: e.read_at || null
    })),
    total: e.prepare(`SELECT COUNT(*) n FROM arxiv_items ${c}`).get(...o).n
  };
}

function paperOut(e) {
  return e ? {
    ...e,
    tags: arr(e.tags),
    matched_keywords: arr(e.matched_keywords),
    cluster_keywords: arr(e.cluster_keywords),
    priority_score: Number(e.priority_score) || 0,
    read_at: e.read_at || null
  } : null;
}

function markPaperRead(e, id, read) {
  const stamp = read ? now() : null;
  e.prepare("UPDATE arxiv_items SET read_at=?,updated_at=? WHERE id=?").run(stamp, stamp || now(), id);
}

function markProductRead(e, id, read) {
  const stamp = read ? now() : null;
  e.prepare("UPDATE product_research SET read_at=?,updated_at=? WHERE id=?").run(stamp, stamp || now(), id);
}

function sourceReviewRow(e, kind, sourceId) {
  return e.prepare("SELECT * FROM source_reviews WHERE source_kind=? AND source_id=?").get(kind, sourceId) || null;
}

function listSourceReviews(e) {
  return e.prepare("SELECT * FROM source_reviews ORDER BY updated_at DESC").all();
}

function sourceReviewStatus(e, kind, sourceId, row) {
  const review = sourceReviewRow(e, kind, sourceId);
  if (review?.status) return review.status;
  return row && isMarkExcluded(row.mark) ? "excluded" : "deferred";
}

function isMarkExcluded(mark) {
  return ["excluded", "exclude"].includes(txt(mark, 40));
}

function resolveSource(e, kind, sourceId) {
  if (kind === "paper") return e.prepare("SELECT * FROM arxiv_items WHERE id=? OR source_id=?").get(sourceId, sourceId) || null;
  return e.prepare("SELECT * FROM product_research WHERE id=?").get(sourceId) || null;
}

function sourceTitle(kind, row) {
  return txt(kind === "product" ? row?.name : row?.title, 240) || "未命名来源";
}

function sourceSnapshot(e, kind, sourceId) {
  const row = resolveSource(e, kind, sourceId);
  if (!row) return null;
  return kind === "product" ? prodRow(row) : paperOut(row);
}

function setSourceReview(e, t, r) {
  const kind = txt(t.kind || t.source_kind, 10) === "product" ? "product" : "paper";
  const sourceId = txt(t.source_id || t.id, 120);
  const status = txt(t.status, 20);
  if (!sourceId) throw new Error("source_id 必填");
  if (![ "resolved", "deferred", "excluded" ].includes(status)) throw new Error("status 必须是 resolved/deferred/excluded");
  const row = resolveSource(e, kind, sourceId);
  if (!row) throw new Error("来源不存在");
  const stamp = now();
  e.prepare("INSERT INTO source_reviews (source_kind,source_id,status,note,decided_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source_kind,source_id) DO UPDATE SET status=excluded.status,note=excluded.note,decided_by=excluded.decided_by,updated_at=excluded.updated_at").run(kind, row.id, status, long(t.note, 3e3), txt(r, 80), stamp, stamp);
  if (status === "excluded") {
    if (kind === "paper") e.prepare("UPDATE arxiv_items SET mark='excluded',note=?,updated_at=? WHERE id=?").run(long(t.note || "用户裁决排除，不进入自进化", 3e3), stamp, row.id);
    else e.prepare("UPDATE product_research SET mark='excluded',note=?,updated_at=? WHERE id=?").run(long(t.note || "用户裁决排除，不进入自进化", 3e3), stamp, row.id);
  } else if (isMarkExcluded(row.mark)) {
    if (kind === "paper") e.prepare("UPDATE arxiv_items SET mark='',note='',updated_at=? WHERE id=?").run(stamp, row.id);
    else e.prepare("UPDATE product_research SET mark='',note='',updated_at=? WHERE id=?").run(stamp, row.id);
  }
  if (status === "resolved") {
    addL2Event(e, {
      source: "human_source_review",
      summary: `资料已解决: ${sourceTitle(kind, row)}`,
      diff_summary: `用户将该${kind === "product" ? "产品" : "论文"}移入收藏/已解决状态，不再占用待处理队列`,
      files_changed: [ "source_reviews" ],
      proposed_by: r
    });
  }
  return sourceReviewRow(e, kind, row.id);
}

function inspirationKey(kind, sourceId, index, item) {
  return txt(item?.id || item?.inspiration_id || item?.key, 160) || `${kind}:${sourceId}:${index}`;
}

function chatSnapshotForSource(e, kind, sourceId) {
  const runs = e.prepare("SELECT * FROM agent_runs WHERE kind=? ORDER BY updated_at DESC,created_at DESC LIMIT 8").all(kind);
  let run = null;
  for (const candidate of runs) {
    const ids = arr(candidate.scope_ids);
    if (!ids.length || ids.includes(sourceId)) { run = candidate; break; }
  }
  run = run || runs[0] || null;
  if (!run) return JSON.stringify({ run: null, messages: [] });
  const messages = getAgentMessages(e, { run_id: run.id }).slice(-40);
  return JSON.stringify({
    run: {
      id: run.id,
      kind: run.kind,
      model_key: run.model_key,
      model_label: run.model_label,
      summary: run.summary,
      created_at: run.created_at,
      updated_at: run.updated_at
    },
    messages
  });
}

function sourceRowsForKind(e, kind) {
  return kind === "product"
    ? e.prepare("SELECT * FROM product_research").all().map(prodRow).filter(Boolean)
    : e.prepare("SELECT * FROM arxiv_items").all().map(paperOut).filter(Boolean);
}

function sourceMap(e, kind) {
  return new Map(sourceRowsForKind(e, kind).map(row => [ row.id, row ]));
}

function findInspirationForDecision(e, kind, sourceId, index, key) {
  const row = resolveSource(e, kind, sourceId);
  if (!row) throw new Error("来源不存在");
  const list = parseStoredInspiration(row.ai_inspiration);
  let idx = Number.isFinite(Number(index)) ? Number(index) : -1;
  if (idx < 0 && key) idx = list.findIndex((item, i) => inspirationKey(kind, row.id, i, item) === key);
  if (idx < 0 || idx >= list.length) throw new Error("启发点不存在或已变更");
  const item = list[idx];
  return { row, list, item, index: idx, key: inspirationKey(kind, row.id, idx, item) };
}

function upsertInspirationDecision(e, t, r) {
  const kind = txt(t.kind || t.source_kind, 10) === "product" ? "product" : "paper";
  const sourceId = txt(t.source_id || t.id, 120);
  const status = txt(t.status, 20);
  if (![ "accepted", "rejected" ].includes(status)) throw new Error("status 必须是 accepted/rejected");
  const found = findInspirationForDecision(e, kind, sourceId, t.index, txt(t.inspiration_key, 180));
  const stamp = now();
  const decisionId = id("insp", `${kind}:${found.row.id}:${found.key}`);
  const sourceJson = JSON.stringify(sourceSnapshot(e, kind, found.row.id) || {});
  const chatJson = chatSnapshotForSource(e, kind, found.row.id);
  const item = found.item;
  e.prepare("INSERT INTO inspiration_decisions (id,source_kind,source_id,inspiration_index,inspiration_key,title,direction,mobius_use,priority,status,source_snapshot,chat_snapshot,implementation_mode,implementation_prompt,implementation_session_id,implementation_url,decided_by,decided_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_kind,source_id,inspiration_key) DO UPDATE SET inspiration_index=excluded.inspiration_index,title=excluded.title,direction=excluded.direction,mobius_use=excluded.mobius_use,priority=excluded.priority,status=excluded.status,source_snapshot=excluded.source_snapshot,chat_snapshot=excluded.chat_snapshot,decided_by=excluded.decided_by,decided_at=excluded.decided_at,updated_at=excluded.updated_at").run(decisionId, kind, found.row.id, found.index, found.key, txt(item.title, 300), txt(item.direction, 1200), txt(item.mobius_use, 4000), txt(item.priority || "medium", 20), status, sourceJson, chatJson, "", "", "", "", txt(r, 80), stamp, stamp, stamp);
  if (status === "accepted") {
    addL2Event(e, {
      source: "accepted_inspiration",
      summary: `接受 L2 启发: ${txt(item.title || item.direction, 180)}`,
      diff_summary: `${sourceTitle(kind, found.row)} → ${txt(item.mobius_use || item.direction, 200)}`,
      files_changed: [ "inspiration_decisions" ],
      proposed_by: r
    });
  }
  return inspirationDecisionOut(e.prepare("SELECT * FROM inspiration_decisions WHERE id=?").get(decisionId), e);
}

function inspirationDecisionOut(row, e) {
  if (!row) return null;
  let source = null;
  try { source = row.source_snapshot ? JSON.parse(row.source_snapshot) : null; } catch {}
  let chat = null;
  try { chat = row.chat_snapshot ? JSON.parse(row.chat_snapshot) : null; } catch {}
  if (!source && e) source = sourceSnapshot(e, row.source_kind, row.source_id);
  return {
    ...row,
    source,
    chat,
    source_title: sourceTitle(row.source_kind, source),
    source_url: source?.source_url || "",
    source_cluster: source?.cluster_label || source?.category || "",
    priority: row.priority || "medium"
  };
}

function listInspirationDecisions(e, t = {}) {
  const rawStatus = txt(t.status || "", 120);
  const statuses = rawStatus ? rawStatus.split(/[,，\s]+/).filter(Boolean) : [ "accepted", "queued_one_click", "queued_plan", "deferred" ];
  const includeRejected = !!t.include_rejected;
  const params = [];
  let where = "";
  if (statuses.length) {
    where = `WHERE status IN (${statuses.map(() => "?").join(",")})`;
    params.push(...statuses);
  }
  if (includeRejected && !rawStatus) where = "";
  const rows = e.prepare(`SELECT * FROM inspiration_decisions ${where} ORDER BY CASE status WHEN 'accepted' THEN 1 WHEN 'queued_plan' THEN 2 WHEN 'queued_one_click' THEN 3 WHEN 'deferred' THEN 4 ELSE 9 END, updated_at DESC`).all(...params);
  return rows.map(row => inspirationDecisionOut(row, e));
}

function buildImplementationPrompt(decision, mode) {
  const source = decision.source || {};
  const chat = decision.chat || {};
  const modeLine = mode === "one_click"
    ? "请直接落实，不需要再向用户确认；完成后提交代码并说明验证结果。"
    : "请先进入 plan 模式，与用户确认方案、范围和风险，再在用户同意后落实。";
  return [
    "## 莫比乌斯 self-cognition L2 启发落实",
    "",
    modeLine,
    "",
    "### 启发点",
    `标题: ${decision.title}`,
    `优先级: ${decision.priority}`,
    "",
    "### 启发方向",
    decision.direction || "(无)",
    "",
    "### 具体落实",
    decision.mobius_use || "(无)",
    "",
    "### 来源资料",
    `类型: ${decision.source_kind === "product" ? "产品" : "论文"}`,
    `标题: ${decision.source_title}`,
    source.source_url ? `链接: ${source.source_url}` : "",
    source.abstract ? `摘要: ${txt(source.abstract, 1800)}` : "",
    source.fetched_description ? `产品快照: ${txt(source.fetched_description, 1800)}` : "",
    "",
    "### 当时的详细思考",
    JSON.stringify({
      source_snapshot: source,
      accepted_inspiration: {
        title: decision.title,
        direction: decision.direction,
        mobius_use: decision.mobius_use,
        priority: decision.priority
      }
    }, null, 2).slice(0, 6000),
    "",
    "### 用户与 L2 Agent 的聊天上下文",
    JSON.stringify(chat, null, 2).slice(0, 9000),
    "",
    "### 验收",
    "- 只改与该启发相关的最小文件范围。",
    "- 完成后运行必要的语法检查/构建检查。",
    "- 若修改 mobius 主代码，按自迭代规则提交并部署。"
  ].filter(Boolean).join("\n");
}

function implementInspiration(e, t, r) {
  const decisionId = txt(t.id || t.decision_id, 160);
  const mode = txt(t.mode, 20) === "plan" ? "plan" : "one_click";
  const row = e.prepare("SELECT * FROM inspiration_decisions WHERE id=?").get(decisionId);
  if (!row) throw new Error("启发点不存在");
  if (![ "accepted", "deferred", "queued_one_click", "queued_plan" ].includes(row.status)) throw new Error("该启发点当前状态不可落实");
  const decision = inspirationDecisionOut(row, e);
  const prompt = buildImplementationPrompt(decision, mode);
  const { createExtensionAnalysisSession, loadUser } = extensionBridge();
  const user = loadUser(r);
  const created = createExtensionAnalysisSession({
    user,
    extensionName: "self-cognition",
    extensionDisplayName: "Self-Cognition 启发落实",
    projectDescription: "Self-Cognition 接受的 L2 启发落实工作区。",
    issueTitle: `L2 启发落实：${txt(decision.title, 56)}`,
    issueDescription: `${decision.source_kind === "product" ? "产品" : "论文"}来源：${decision.source_title}\n\n${decision.direction}`,
    sessionName: `${mode === "one_click" ? "一键落实" : "修改后落实"}：${txt(decision.title, 44)}`,
    sessionDescription: prompt,
    model: t.model || "codex",
    language: "zh"
  });
  const url = `/u/${encodeURIComponent(user.id)}/p/${encodeURIComponent(created.project.id)}/i/${encodeURIComponent(created.issue.id)}?session=${encodeURIComponent(created.session.session_id)}`;
  const nextStatus = mode === "one_click" ? "queued_one_click" : "queued_plan";
  e.prepare("UPDATE inspiration_decisions SET status=?,implementation_mode=?,implementation_prompt=?,implementation_session_id=?,implementation_url=?,updated_at=? WHERE id=?").run(nextStatus, mode, txt(prompt, 2e5), created.session.session_id, url, now(), decisionId);
  return {
    decision: inspirationDecisionOut(e.prepare("SELECT * FROM inspiration_decisions WHERE id=?").get(decisionId), e),
    session: created.session,
    project: created.project,
    issue: created.issue,
    url,
    __mobius_post_actions: [ {
      type: "session_message",
      session_id: created.session.session_id,
      project_id: created.project.id,
      content: prompt,
      input_text: decision.title || "Self-Cognition L2 启发落实",
      request_id: `self-cognition-${decisionId}-${Date.now()}`,
      source: "extension.self-cognition.implement_inspiration",
      result_key: "backend_start"
    } ]
  };
}

function updateInspirationQueueStatus(e, t, r) {
  const decisionId = txt(t.id || t.decision_id, 160);
  const status = txt(t.status, 20);
  if (![ "deferred", "deleted" ].includes(status)) throw new Error("status 必须是 deferred/deleted");
  const row = e.prepare("SELECT * FROM inspiration_decisions WHERE id=?").get(decisionId);
  if (!row) throw new Error("启发点不存在");
  e.prepare("UPDATE inspiration_decisions SET status=?,decided_by=?,updated_at=? WHERE id=?").run(status, txt(r, 80), now(), decisionId);
  return inspirationDecisionOut(e.prepare("SELECT * FROM inspiration_decisions WHERE id=?").get(decisionId), e);
}

function submitFeedback(e, t) {
  const r = txt(t.paper_id, 120), a = txt(t.verdict, 20);
  if (![ "boost", "neutral", "exclude" ].includes(a)) throw new Error("verdict 必须是 boost/neutral/exclude");
  const s = e.prepare("SELECT id,matched_keywords,cluster_keywords FROM arxiv_items WHERE id=?").get(r);
  if (!s) throw new Error("paper_id 不存在");
  const o = Object.fromEntries(e.prepare("SELECT keyword,weight FROM keyword_weights").all().map(e => [ e.keyword, Number(e.weight) || 1 ]));
  e.prepare("INSERT INTO user_feedback (id,paper_id,verdict,note,created_at,source_session) VALUES (?,?,?,?,?,?)").run(id("feedback", `${Date.now()}${Math.random()}`), r, a, long(t.note, 2e3), now(), txt(t.source_session, 120));
  const c = recalcKeywordWeights(e), n = [ ...arr(s.cluster_keywords), ...arr(s.matched_keywords) ].find(e => c[e] != null) || Object.keys(c)[0] || "扫描关键词";
  addL2Event(e, {
    source: "human_feedback",
    session_id: t.source_session,
    summary: `调整关键词 ${n} 权重从 ${Number(o[n] ?? 1).toFixed(2)} 到 ${Number(c[n] ?? 1).toFixed(2)}`,
    diff_summary: "扫描权重自适应",
    files_changed: [ "keyword_weights", "user_feedback" ],
    proposed_by: txt(t.proposed_by || t.source_session || "user", 120)
  });
  return c;
}

function getPaperClusters(e) {
  const rows = e.prepare("SELECT id,cluster_label,priority_score FROM arxiv_items WHERE cluster_label!='' ORDER BY priority_score DESC").all(), m = new Map();
  for (const r of rows) {
    const a = m.get(r.cluster_label) || {
      label: r.cluster_label,
      count: 0,
      top_paper_id: r.id,
      max_score: Number(r.priority_score) || 0
    };
    a.count++, Number(r.priority_score) > a.max_score && (a.top_paper_id = r.id, a.max_score = Number(r.priority_score) || 0), m.set(r.cluster_label, a);
  }
  return [ ...m.values() ].sort((e, t) => t.max_score - e.max_score).slice(0, 6);
}

function getTopPicks(e, t = {}) {
  const r = int(t.limit, 5, 1, 50);
  return e.prepare("SELECT * FROM arxiv_items ORDER BY priority_score DESC,relevance DESC,COALESCE(published_at,created_at) DESC LIMIT ?").all(r).map(paperOut);
}

function getPapersByCluster(e, t = {}) {
  const r = txt(t.label, 80);
  if (!r) throw new Error("label 必填");
  const a = int(t.limit, 20, 1, 100), s = int(t.offset, 0, 0, 1e5);
  return {
    items: e.prepare("SELECT * FROM arxiv_items WHERE cluster_label=? ORDER BY priority_score DESC,relevance DESC LIMIT ? OFFSET ?").all(r, a, s).map(paperOut),
    total: e.prepare("SELECT COUNT(*) n FROM arxiv_items WHERE cluster_label=?").get(r).n
  };
}

function listProducts(e, t = {}) {
  const r = status(txt(t.status || "", 20)), a = [], s = [];
  if (t.status && (a.push("status=?"), s.push(r)), t.q) {
    const e = `%${txt(t.q).replace(/[%_]/g, "\\$&")}%`;
    a.push("(name LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\' OR fetched_description LIKE ? ESCAPE '\\')"),
    s.push(e, e, e);
  }
  const o = a.length ? `WHERE ${a.join(" AND ")}` : "", c = e.prepare(`SELECT * FROM product_research ${o} ORDER BY CASE status WHEN 'tracked' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END,relevance DESC,updated_at DESC`).all(...s).map(prodRow);
  return {
    items: c,
    total: c.length
  };
}

function groupedProducts(e) {
  return {
    official: listProducts(e, {
      status: "tracked"
    }).items,
    candidate: listProducts(e, {
      status: "candidate"
    }).items,
    archived: listProducts(e, {
      status: "archived"
    }).items
  };
}

function scans(e, t = {}) {
  const r = txt(t.scan_type, 20), a = int(t.limit, 50, 1, 200);
  return r ? e.prepare("SELECT * FROM scan_runs WHERE scan_type=? ORDER BY created_at DESC LIMIT ?").all(r, a) : e.prepare("SELECT * FROM scan_runs ORDER BY created_at DESC LIMIT ?").all(a);
}

function summary(e) {
  return {
    arxiv_total: e.prepare("SELECT COUNT(*) n FROM arxiv_items").get().n,
    official_competitors: e.prepare("SELECT COUNT(*) n FROM product_research WHERE status='tracked'").get().n,
    candidate_competitors: e.prepare("SELECT COUNT(*) n FROM product_research WHERE status='candidate'").get().n,
    last_arxiv: e.prepare("SELECT * FROM scan_runs WHERE scan_type='arxiv' ORDER BY created_at DESC LIMIT 1").get() || null,
    last_product: e.prepare("SELECT * FROM scan_runs WHERE scan_type='product' ORDER BY created_at DESC LIMIT 1").get() || null
  };
}

function keywords(e) {
  return {
    paper: rows(e, "paper"),
    product: rows(e, "product")
  };
}

function updateKeywords(e, t) {
  const r = txt(t.scope, 20);
  if (![ "paper", "product" ].includes(r) || !Array.isArray(t.keywords)) throw new Error("需要 scope=paper/product 和 keywords 数组");
  const a = now(), s = e.prepare("INSERT INTO keywords VALUES (@id,@scope,@keyword,@query,@enabled,@sort_order,@created_at,@updated_at)");
  return e.transaction(() => {
    e.prepare("DELETE FROM keywords WHERE scope=?").run(r), t.keywords.forEach((e, t) => {
      const o = txt("string" == typeof e ? e : e.keyword, 80);
      o && s.run({
        id: id(`kw_${r}`, o),
        scope: r,
        keyword: o,
        query: txt("string" == typeof e ? e : e.query || o, 240),
        enabled: !1 === e.enabled ? 0 : 1,
        sort_order: int(e.sort_order, t, 0, 1e4),
        created_at: a,
        updated_at: a
      });
    });
  })(), {
    [r]: rows(e, r)
  };
}

function updateProduct(e, t, r) {
  const a = txt(t.mode, 20), s = txt(t.id || t.promote_id || t.archive_id, 120);
  if ("promote" === a || t.promote_id) e.prepare("UPDATE product_research SET status='tracked',updated_at=? WHERE id=?").run(now(), s); else if ("archive" === a || t.archive_id) e.prepare("UPDATE product_research SET status='archived',updated_at=? WHERE id=?").run(now(), s); else if ("mark" === a) e.prepare("UPDATE product_research SET mark=?,note=?,updated_at=? WHERE id=?").run(txt(t.mark, 40), long(t.note, 3e3), now(), s); else {
    if (!t.source_url) throw new Error("update_competitors 需要 promote/archive/mark/upsert");
    upsertProduct(e, {
      ...t,
      status: t.status || "candidate",
      created_by: r
    });
  }
  return groupedProducts(e);
}

function chatItemRow(e, t) {
  return t ? {
    id: t.id,
    type: e,
    title: "product" === e ? t.name : t.title,
    authors: t.authors || "",
    published_at: t.published_at || "",
    priority_score: Number(t.priority_score) || 0,
    relevance: Number(t.relevance) || 0,
    abstract: t.abstract || "",
    fetched_title: t.fetched_title || "",
    fetched_description: t.fetched_description || "",
    reason: t.reason || "",
    discovery_logic: t.discovery_logic || "",
    source_url: t.source_url || "",
    category: t.category || "",
    status: t.status || "",
    tags: arr(t.tags),
    matched_keywords: arr(t.matched_keywords)
  } : null;
}

function chatContext(e) {
  if (!e) return "暂无上下文。";
  if ("product" === e.type) return [ "【类型】竞品", `【名称】${e.title || ""}`, `【类别】${e.category || ""}`, `【状态】${e.status || ""}`, `【相关度】${e.relevance || 0}/10`, `【页面标题】${e.fetched_title || ""}`, `【页面描述】${e.fetched_description || ""}`, `【入库理由】${e.reason || ""}`, `【发现逻辑】${e.discovery_logic || ""}`, e.source_url ? `【来源 URL】${e.source_url}` : "" ].filter(Boolean).join("\n");
  return [ "【类型】论文", `【标题】${e.title || ""}`, `【作者】${e.authors || ""}`, `【发表时间】${e.published_at || ""}`, `【Priority】${e.priority_score || 0}`, `【相关度】${e.relevance || 0}`, `【关键词】${[ ...new Set([ ...(e.matched_keywords || []), ...(e.tags || []) ]) ].join("、")}`, `【摘要】${e.abstract || ""}`, e.source_url ? `【来源 URL】${e.source_url}` : "" ].filter(Boolean).join("\n");
}

function chatHistoryText(e) {
  const items = Array.isArray(e) ? e : [];
  return items.slice(-8).map(t => {
    const r = txt(t.role, 20);
    const c = long(t.content, 1200);
    return `${"assistant" === r ? "AI" : "用户"}: ${c}`;
  }).join("\n");
}

function chatPrompt(e, t, r, a) {
  return [
    "你是 Mobius 里的单篇论文/竞品讲解助手。",
    "你必须严格基于给定的上下文回答；不要编造上下文里没有的信息。",
    "如果信息不足，要明确说不确定，并给出下一步应该看什么。",
    "回答必须使用中文，优先给出结论、依据、可执行建议。",
    "如果是论文，重点解释方法、实验、结果、局限和适合 Mobius 的借鉴点。",
    "如果是竞品，重点解释定位、能力、差异、可借鉴功能和风险。",
    "",
    "【上下文】",
    chatContext(e),
    "",
    a ? "【对话历史】\n" + chatHistoryText(a) : "【对话历史】\n无",
    "",
    "【用户问题】",
    long(r, 1600)
  ].join("\n");
}

function extractResponseText(e) {
  if (e && "string" == typeof e.output_text && txt(e.output_text, 2e4)) return txt(e.output_text, 2e4);
  const t = [];
  const r = e => {
    if (!e) return;
    if ("string" == typeof e) return void t.push(e);
    if (Array.isArray(e)) return void e.forEach(r);
    if ("object" == typeof e) {
      "string" == typeof e.text && t.push(e.text), "string" == typeof e.value && t.push(e.value), Array.isArray(e.content) && e.content.forEach(r), Array.isArray(e.output) && e.output.forEach(r), Array.isArray(e.parts) && e.parts.forEach(r), Array.isArray(e.items) && e.items.forEach(r), Array.isArray(e.annotations) && e.annotations.forEach(r);
    }
  };
  return r(e), txt(t.join("\n"), 2e4);
}

function parseSseResponse(e) {
  const t = [], r = [];
  for (const a of String(e || "").split(/\r?\n/)) {
    if (!a.startsWith("data:")) continue;
    const e = a.slice(5).trim();
    if (!e || "[DONE]" === e) continue;
    let s = null;
    try {
      s = JSON.parse(e);
    } catch {
      continue;
    }
    if ("response.output_text.delta" === s.type && "string" == typeof s.delta) t.push(s.delta);
    else if ("string" == typeof s.delta) t.push(s.delta);
    else if (!t.length && "string" == typeof s.text) t.push(s.text);
    if (s.response) r.push(s.response);
    r.push(s);
  }
  return t.length ? {
    output_text: t.join("")
  } : r.length ? r[r.length - 1] : null;
}

async function fetchJson(e, t, r = 1.25e4) {
  const a = new AbortController, s = setTimeout(() => a.abort(), r);
  try {
    const r = await fetch(e, {
      ...t,
      signal: a.signal
    }), o = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt(o, 500)}`);
    try {
      return JSON.parse(o);
    } catch {
      const e = parseSseResponse(o);
      if (e) return e;
      throw new Error(`非 JSON 响应: ${txt(o, 240)}`);
    }
  } catch (e) {
    throw "AbortError" === e?.name ? new Error("LLM 请求超时") : e;
  } finally {
    clearTimeout(s);
  }
}

function chatProviders() {
  const e = [];
  const accessPath = txt(process.env.MODEL_ACCESS_PATH || path.join(REPO_ROOT, ".deploy_data/data/model-access.json"), 512);
  try {
    if (fs.existsSync(accessPath)) {
      const access = JSON.parse(fs.readFileSync(accessPath, "utf8"));
      for (const m of access.claudeCodeModels || []) {
        if (!m.enabled || !m.imported) continue;
        const settingsFile = path.join(os.homedir(), ".claude", `settings-${m.key}.json`);
        if (!fs.existsSync(settingsFile)) continue;
        let settings;
        try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch { continue; }
        const env = settings.env || {};
        if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) continue;
        e.push({
          key: m.key,
          name: `anthropic:${m.key}`,
          label: m.label || m.key,
          type: "anthropic",
          baseUrl: env.ANTHROPIC_BASE_URL,
          authToken: env.ANTHROPIC_AUTH_TOKEN,
          model: settings.model || env.ANTHROPIC_DEFAULT_SONNET_MODEL || m.claude_model || "GLM-5.2"
        });
      }
    }
  } catch {}
  const t = txt(process.env.RCC2_API_KEY || process.env.RIGHTCODE_API_KEY || "", 512);
  t && e.push({
    key: "env:codex",
    name: "codex:subscription",
    label: "Codex (env)",
    type: "responses",
    baseUrl: "https://right.codes/codex/v1",
    apiKey: t,
    model: txt(process.env.SELF_COGNITION_LLM_MODEL || process.env.SELF_COGNITION_CHAT_MODEL || "gpt-5.5", 120)
  });
  return e;
}

function findProvider(modelKey) {
  const providers = chatProviders();
  if (!providers.length) throw new Error("没有可用的 AI 渠道 (检查 model-access.json)");
  if (!modelKey) return providers[0];
  return providers.find(p => p.key === modelKey || p.name === modelKey) || providers[0];
}

function sessionProviderInfo(modelKey) {
  try {
    return findProvider(modelKey);
  } catch {
    const key = txt(modelKey, 120) || "codex";
    return { key, label: key === "codex" ? "Codex Agent" : key, model: key, type: "session" };
  }
}

// 隐藏工作缓存目录名, 与 backend/config.js 的 HIDDEN_FOLDER_NAME 一致 (本机 .imac / 新装 .mobius).
const HIDDEN = process.env.MOBIUS_HIDDEN_FOLDER_NAME || ".mobius";

const READ_FILE_TOOL = {
  name: "read_file",
  description: `读取莫比乌斯项目仓库内的代码 / memory / 文档文件。path 必须是相对仓库根 (例如 mobius/extension/self-cognition/backend/self_cognition_core.js) 或 ${HIDDEN}/ / .deploy_data/ 开头的绝对相对路径。单次最多返回 8000 字符。`,
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对仓库根的路径" }
    },
    required: ["path"]
  }
};

const UPDATE_INSPIRATION_TOOL = {
  name: "update_inspiration",
  description: "修改指定论文/竞品的某条 ai_inspiration 启发。按 title 子串或 index 匹配 (二选一)。可改 priority (high/medium/low) / direction / mobius_use / title。修改后立即在数据库生效，前端聊天结束后会刷新。",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["paper", "product"], description: "目标类型" },
      scope_id: { type: "string", description: "论文/竞品 ID" },
      match: { type: "string", description: "匹配启发 title 的子串" },
      index: { type: "integer", minimum: 0, description: "匹配启发 index (0-based)，与 match 二选一" },
      priority: { type: "string", enum: ["high", "medium", "low"] },
      direction: { type: "string", description: "概括性方向描述, 一两句话娓娓道来, 不放具体文件名/接口名/库名等技术细节" },
      mobius_use: { type: "string", description: "具体落实到莫比乌斯的细节: 目标文件 / 模块 / 关键接口 / 可参考实现等技术细节都放这里" },
      title: { type: "string" }
    },
    required: ["kind", "scope_id"]
  }
};

const ADD_INSPIRATION_TOOL = {
  name: "add_inspiration",
  description: "为指定论文/竞品追加一条新启发到 ai_inspiration 数组末尾。返回追加后的总条数。前端聊天结束后会刷新。",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["paper", "product"] },
      scope_id: { type: "string" },
      title: { type: "string", description: "启发标题（一句话）" },
      direction: { type: "string", description: "概括性方向描述, 一两句话娓娓道来, 不放具体技术细节（可选）" },
      mobius_use: { type: "string", description: "具体落实到莫比乌斯的技术细节: 目标文件 / 模块 / 接口 / 参考实现（可选）" },
      priority: { type: "string", enum: ["high", "medium", "low"], description: "默认 medium" }
    },
    required: ["kind", "scope_id", "title"]
  }
};

const DELETE_INSPIRATION_TOOL = {
  name: "delete_inspiration",
  description: "删除指定论文/竞品的一条 ai_inspiration 启发。按 title 子串或 index 匹配 (二选一)。如果删除后数组为空，自动 mark='excluded'。前端聊天结束后会刷新。",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["paper", "product"] },
      scope_id: { type: "string" },
      match: { type: "string" },
      index: { type: "integer", minimum: 0 }
    },
    required: ["kind", "scope_id"]
  }
};

function resolveRepoPath(p) {
  const cleaned = txt(p, 400).replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("..")) return null;
  const candidates = [
    path.join(REPO_ROOT, cleaned),
    path.join(REPO_ROOT, HIDDEN, cleaned),
    path.join(REPO_ROOT, ".deploy_data", cleaned)
  ];
  for (const c of candidates) {
    const resolved = path.resolve(c);
    if (!resolved.startsWith(REPO_ROOT)) continue;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  return null;
}

function handleReadFile({ path: p }) {
  const resolved = resolveRepoPath(p);
  if (!resolved) return { error: `路径不可达或不存在: ${p}` };
  try {
    const content = fs.readFileSync(resolved, "utf8");
    const trimmed = content.length > 8000 ? `${content.slice(0, 8000)}\n\n[... 截断, 共 ${content.length} 字符]` : content;
    return { path: resolved.replace(REPO_ROOT + "/", ""), content: trimmed, size: content.length };
  } catch (e) {
    return { error: `读取失败: ${e.message}` };
  }
}

function getInspirationRow(e, kind, scopeId) {
  if (kind === "paper") {
    return e.prepare("SELECT id,ai_inspiration,mark FROM arxiv_items WHERE id=? OR source_id=?").get(scopeId, scopeId);
  }
  if (kind === "product") {
    return e.prepare("SELECT id,ai_inspiration,mark FROM product_research WHERE id=?").get(scopeId);
  }
  return null;
}

function parseStoredInspiration(raw) {
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(it => it && typeof it === "object").map(it => ({
      title: txt(it.title || it.direction || it.name || "", 200),
      direction: txt(it.direction || it.title || it.summary || "", 600),
      mobius_use: txt(it.mobius_use || it.use || it.application || "", 1200),
      priority: ["high", "medium", "low"].includes(it.priority) ? it.priority : "medium"
    }));
  } catch { return []; }
}

function findInspirationIndex(list, { match, index }) {
  if (typeof index === "number" && Number.isFinite(index)) {
    if (index < 0 || index >= list.length) return -1;
    return index;
  }
  if (typeof match === "string" && match.trim()) {
    const needle = match.toLowerCase();
    return list.findIndex(it => String(it.title || "").toLowerCase().includes(needle));
  }
  return -1;
}

function handleUpdateInspiration(input, e) {
  const kind = txt(input?.kind, 10) === "product" ? "product" : "paper";
  const scopeId = txt(input?.scope_id, 120);
  if (!scopeId) return { error: "scope_id 必填" };
  const row = getInspirationRow(e, kind, scopeId);
  if (!row) return { error: `找不到 ${kind} ${scopeId}` };
  const list = parseStoredInspiration(row.ai_inspiration);
  const idx = findInspirationIndex(list, { match: input?.match, index: input?.index });
  if (idx < 0) return { error: `未匹配到启发 (match=${input?.match || ""} index=${input?.index ?? ""})` };
  const before = { ...list[idx] };
  if (typeof input?.title === "string" && input.title.trim()) list[idx].title = txt(input.title, 200);
  if (typeof input?.direction === "string" && input.direction.trim()) list[idx].direction = txt(input.direction, 600);
  if (typeof input?.mobius_use === "string" && input.mobius_use.trim()) list[idx].mobius_use = txt(input.mobius_use, 1200);
  if (["high", "medium", "low"].includes(input?.priority)) list[idx].priority = input.priority;
  saveInspiration(e, kind === "paper" ? "arxiv_items" : "product_research", row.id, list);
  return { ok: true, action: "update_inspiration", index: idx, before, after: { ...list[idx] }, total: list.length };
}

function handleAddInspiration(input, e) {
  const kind = txt(input?.kind, 10) === "product" ? "product" : "paper";
  const scopeId = txt(input?.scope_id, 120);
  const title = txt(input?.title, 200);
  if (!scopeId) return { error: "scope_id 必填" };
  if (!title) return { error: "title 必填" };
  const row = getInspirationRow(e, kind, scopeId);
  if (!row) return { error: `找不到 ${kind} ${scopeId}` };
  const list = parseStoredInspiration(row.ai_inspiration);
  const item = {
    title,
    direction: txt(input?.direction, 600) || title,
    mobius_use: txt(input?.mobius_use, 1200) || "",
    priority: ["high", "medium", "low"].includes(input?.priority) ? input.priority : "medium"
  };
  list.push(item);
  saveInspiration(e, kind === "paper" ? "arxiv_items" : "product_research", row.id, list);
  return { ok: true, action: "add_inspiration", item, index: list.length - 1, total: list.length };
}

function handleDeleteInspiration(input, e) {
  const kind = txt(input?.kind, 10) === "product" ? "product" : "paper";
  const scopeId = txt(input?.scope_id, 120);
  if (!scopeId) return { error: "scope_id 必填" };
  const row = getInspirationRow(e, kind, scopeId);
  if (!row) return { error: `找不到 ${kind} ${scopeId}` };
  const list = parseStoredInspiration(row.ai_inspiration);
  const idx = findInspirationIndex(list, { match: input?.match, index: input?.index });
  if (idx < 0) return { error: `未匹配到启发 (match=${input?.match || ""} index=${input?.index ?? ""})` };
  const removed = list.splice(idx, 1)[0];
  saveInspiration(e, kind === "paper" ? "arxiv_items" : "product_research", row.id, list);
  return { ok: true, action: "delete_inspiration", index: idx, removed, total: list.length };
}

function buildMobiusMemoryContext() {
  const parts = [];
  const pkFile = path.join(REPO_ROOT, HIDDEN, "project_knowledge.md");
  try { parts.push(("# 莫比乌斯项目知识 (" + HIDDEN + "/project_knowledge.md)\n") + fs.readFileSync(pkFile, "utf8")); } catch {}
  const memIdx = path.join(os.homedir(), ".claude/projects/-home-user-imac-test/memory/MEMORY.md");
  try { parts.push("# Agent 长期 memory 索引 (~/.claude/.../memory/MEMORY.md)\n" + fs.readFileSync(memIdx, "utf8")); } catch {}
  return parts.join("\n\n---\n\n").slice(0, 24000);
}

async function callAnthropicMessages({ provider, system, messages, tools, maxTokens = 4096, maxRounds = 8, toolContext, roundTimeoutMs = 2e4 }) {
  const url = provider.baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const allMessages = [...messages];
  let totalInput = 0, totalOutput = 0;
  const toolResultsById = new Map();
  for (let round = 0; round < maxRounds; round++) {
    const body = {
      model: provider.model,
      max_tokens: maxTokens,
      system,
      messages: allMessages,
      tools: tools || undefined
    };
    let resp;
    try {
      resp = await fetchJson(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": provider.authToken,
          "anthropic-version": "2023-06-01",
          Authorization: `Bearer ${provider.authToken}`
        },
        body: JSON.stringify(body)
      }, roundTimeoutMs);
    } catch (err) {
      // 还没产生任何 tool_use 时切换渠道是安全的 (update/add/delete inspiration 有副作用, 不能重复执行)
      const hasToolUse = allMessages.some(m => Array.isArray(m.content) && m.content.some(b => b && b.type === "tool_use"));
      if (!hasToolUse && err && typeof err === "object") err.safeToFallback = true;
      throw err;
    }
    if (resp.usage) {
      totalInput += Number(resp.usage.input_tokens || 0);
      totalOutput += Number(resp.usage.output_tokens || 0);
    }
    const content = Array.isArray(resp.content) ? resp.content : [];
    allMessages.push({ role: "assistant", content });
    const toolUseBlocks = content.filter(b => b.type === "tool_use");
    if (resp.stop_reason !== "tool_use" || !toolUseBlocks.length) {
      return { content, stop_reason: resp.stop_reason, usage: { input_tokens: totalInput, output_tokens: totalOutput }, messages: allMessages, toolResultsById };
    }
    const toolResults = [];
    for (const tu of toolUseBlocks) {
      let result;
      if (tu.name === "read_file") {
        result = handleReadFile(tu.input || {});
      } else if (tu.name === "update_inspiration") {
        if (toolContext?.db && toolContext.scopeId && txt(tu.input?.scope_id, 120) !== toolContext.scopeId) {
          result = { error: "scope_id 与当前对话上下文不一致, 拒绝跨 scope 改启发" };
        } else {
          result = handleUpdateInspiration(tu.input || {}, toolContext?.db);
        }
      } else if (tu.name === "add_inspiration") {
        if (toolContext?.db && toolContext.scopeId && txt(tu.input?.scope_id, 120) !== toolContext.scopeId) {
          result = { error: "scope_id 与当前对话上下文不一致, 拒绝跨 scope 改启发" };
        } else {
          result = handleAddInspiration(tu.input || {}, toolContext?.db);
        }
      } else if (tu.name === "delete_inspiration") {
        if (toolContext?.db && toolContext.scopeId && txt(tu.input?.scope_id, 120) !== toolContext.scopeId) {
          result = { error: "scope_id 与当前对话上下文不一致, 拒绝跨 scope 改启发" };
        } else {
          result = handleDeleteInspiration(tu.input || {}, toolContext?.db);
        }
      } else {
        result = { error: `未知工具 ${tu.name}` };
      }
      toolResultsById.set(tu.id, result);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 8000) });
    }
    allMessages.push({ role: "user", content: toolResults });
  }
  return { content: [], stop_reason: "max_rounds", usage: { input_tokens: totalInput, output_tokens: totalOutput }, messages: allMessages, toolResultsById };
}

// 多渠道兜底: 主渠道首轮 (未产生 tool_use) 失败/超时自动切下一个 provider 重试。
// 已产生 tool_use 的轮失败不切 (inspiration 工具有副作用, 换渠道重来会重复执行)。
async function callAgentWithFallback({ providers, system, messages, tools, maxTokens, maxRounds, toolContext, roundTimeoutMs }) {
  if (!providers || !providers.length) throw new Error("没有可用的 AI 渠道 (检查 model-access.json)");
  let lastErr;
  for (const provider of providers) {
    try {
      return await callAnthropicMessages({ provider, system, messages, tools, maxTokens, maxRounds, toolContext, roundTimeoutMs });
    } catch (err) {
      lastErr = err;
      if (!err || !err.safeToFallback) throw err;
    }
  }
  throw lastErr || new Error("所有 AI 渠道都失败了");
}

function extractAgentText(content) {
  if (!Array.isArray(content)) return "";
  return content.filter(b => b.type === "text" && typeof b.text === "string").map(b => b.text).join("\n").trim();
}

async function callResponsesModel(e, t) {
  const r = e.baseUrl.replace(/\/+$/, "") + "/responses", a = await fetchJson(r, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${e.apiKey}`
    },
    body: JSON.stringify({
      model: e.model,
      input: [ {
        role: "user",
        content: t
      } ],
      max_output_tokens: 900,
      temperature: 0.2
    })
  });
  const s = extractResponseText(a);
  if (!s) throw new Error("模型未返回可用文本");
  return s;
}

async function callChatCompletionModel(e, t) {
  const r = e.baseUrl.replace(/\/+$/, "") + "/chat/completions", a = await fetchJson(r, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${e.apiKey}`
    },
    body: JSON.stringify({
      model: e.model,
      messages: [ {
        role: "system",
        content: "你是 Mobius 里的单篇竞品讲解助手，必须严格基于给定上下文回答，不能编造信息。"
      }, {
        role: "user",
        content: t
      } ],
      max_tokens: 900,
      temperature: 0.2
    })
  }), s = a?.choices?.[0]?.message, o = Array.isArray(s?.content) ? s.content.map(e => "string" == typeof e ? e : e?.text || e?.content || "").join("") : s?.content;
  if (!txt(o, 2e4)) throw new Error("模型未返回可用文本");
  return txt(o, 2e4);
}

const AGENT_RUN_KINDS = ["paper", "product"];

function createAgentRun(e, { kind, scopeIds, modelKey, modelLabel, createdBy, sessionId = "", projectId = "", issueId = "", sessionUrl = "" }) {
  const runId = id("agent_run", `${kind}:${scopeIds.join(",")}:${Date.now()}:${Math.random()}`);
  const stamp = now();
  e.prepare("INSERT INTO agent_runs (id,kind,scope_ids,model_key,model_label,status,summary,prompt_for_xiaomo,token_usage,error,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(runId, kind, JSON.stringify(scopeIds || []), modelKey, modelLabel || "", "running", "", "", "", "", createdBy || "system", stamp, stamp);
  e.prepare("UPDATE agent_runs SET session_id=?,project_id=?,issue_id=?,session_url=? WHERE id=?").run(txt(sessionId, 120), txt(projectId, 120), txt(issueId, 120), txt(sessionUrl, 500), runId);
  return runId;
}

function appendAgentMessage(e, { runId, role, content, toolCalls }) {
  const msgId = id("agent_msg", `${runId}:${role}:${Date.now()}:${Math.random()}`);
  e.prepare("INSERT INTO agent_messages (id,run_id,role,content,tool_calls,created_at) VALUES (?,?,?,?,?,?)").run(msgId, runId, role, typeof content === "string" ? content : JSON.stringify(content), typeof toolCalls === "string" ? toolCalls : JSON.stringify(toolCalls || []), now());
}

function finalizeAgentRun(e, { runId, status, summary, promptForXiaomo, tokenUsage, error }) {
  e.prepare("UPDATE agent_runs SET status=?,summary=?,prompt_for_xiaomo=?,token_usage=?,error=?,updated_at=? WHERE id=?").run(status, txt(summary, 6e4), txt(promptForXiaomo, 2e5), txt(tokenUsage, 200), txt(error, 2e3), now(), runId);
}

function latestAgentRun(e, kind) {
  return e.prepare("SELECT * FROM agent_runs WHERE kind=? ORDER BY created_at DESC,id DESC LIMIT 1").get(kind);
}

function latestAgentRunForScope(e, kind, scopeId) {
  const rows = e.prepare("SELECT * FROM agent_runs WHERE kind=? ORDER BY updated_at DESC,created_at DESC LIMIT 20").all(kind);
  if (scopeId) {
    const scoped = rows.find(row => arr(row.scope_ids).includes(scopeId) && row.session_id);
    if (scoped) return scoped;
  }
  return rows.find(row => row.session_id) || rows[0] || null;
}

function listAgentRuns(e, t = {}) {
  const kind = txt(t.kind, 10);
  const limit = int(t.limit, 20, 1, 100);
  return (kind ? e.prepare("SELECT * FROM agent_runs WHERE kind=? ORDER BY created_at DESC LIMIT ?").all(kind, limit) : e.prepare("SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?").all(limit)).map(r => ({ ...r, scope_ids: arr(r.scope_ids) }));
}

function getAgentMessages(e, { run_id }) {
  const runId = txt(run_id, 120);
  if (!runId) return [];
  return e.prepare("SELECT id,role,content,tool_calls,created_at FROM agent_messages WHERE run_id=? ORDER BY created_at,id").all(runId).map(m => ({ ...m, tool_calls: arr(m.tool_calls) }));
}

function parseInspirationJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < 0) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(it => it && typeof it === "object").slice(0, 8).map(it => ({
      title: txt(it.title || it.direction || it.name || "", 200),
      direction: txt(it.direction || it.title || it.summary || "", 600),
      mobius_use: txt(it.mobius_use || it.use || it.application || "", 1200),
      priority: txt(it.priority || "medium", 20)
    }));
  } catch { return null; }
}

function saveInspiration(e, table, id, inspiration) {
  // 启发和 mark / 已读状态是三个独立维度, 这里只动 ai_inspiration, 不要联动 mark='excluded'。
  const stamp = now();
  const json = inspiration && inspiration.length ? JSON.stringify(inspiration) : "";
  if (table === "arxiv_items") {
    e.prepare("UPDATE arxiv_items SET ai_inspiration=?,updated_at=? WHERE id=?").run(json, stamp, id);
  } else if (table === "product_research") {
    e.prepare("UPDATE product_research SET ai_inspiration=?,updated_at=? WHERE id=?").run(json, stamp, id);
  }
}

const INSPIRATION_REWRITE_KEY = "inspiration_rewrite_v1";

function parseRewriteBatchJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < 0) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(it => it && typeof it === "object" && typeof it.key === "string");
  } catch { return null; }
}

async function rewriteInspirationStyle(e, t) {
  const provider = findProvider(txt(t.model_key, 200));
  const force = !!t.force;
  if (!force && "done" === e.prepare("SELECT value FROM install_state WHERE key=?").get(INSPIRATION_REWRITE_KEY)?.value) {
    return { ok: true, skipped: true, reason: "已跑过, 传 force=true 可重跑" };
  }
  const sysPrompt = [
    "你是莫比乌斯写作助手, 任务是把每条 ai_inspiration 改写成新的两层写作风格。",
    "",
    "## 输入",
    "你会收到一个 JSON 数组, 每个元素形如 {\"key\": \"<rowId>#<idx>\", \"title\": ..., \"direction\": ..., \"mobius_use\": ..., \"priority\": ...}。",
    "",
    "## 改写规则",
    "1. **title 与 priority 字段必须原样保留, 一个字符都不能改**。",
    "2. **direction 改写**: 概括性方向描述, 一两句话娓娓道来。把原来 direction 里的具体文件名 / 模块路径 / 接口名 / 库或版本号 / API 名称剥离出来, 只保留方向感的叙事, 让人扫一眼就知道这条启发在讲什么、对莫比乌斯哪方面有借鉴意义。不要在 direction 里出现具体路径或技术名词。",
    "3. **mobius_use 改写**: 把从 direction 剥离出来的技术细节合并进去, 整理成 \"具体可在 ... 模块参考其 ..., 改动路径: ...\" 这种带文件 / 接口 / 实现细节的句子。mobius_use 原本就含的技术细节要保留, 不能丢失。",
    "4. 如果 direction 本来就够概括、没有具体技术细节, 不用强行改写; 但要保证 mobius_use 含足够细节。",
    "5. 不要新增或删除条目, 数量必须一致; 每条输出的 key 必须和输入完全一致。",
    "",
    "## 输出",
    "返回纯 JSON 数组 (可以包 ```json 代码块), 每个元素形如 {\"key\": \"<原 key>\", \"title\": ..., \"direction\": ..., \"mobius_use\": ..., \"priority\": ...}。"
  ].join("\n");
  const LIMIT = 5;
  const tables = [ { table: "arxiv_items", kind: "paper" }, { table: "product_research", kind: "product" } ];
  const samples = [];
  let totalRowsRewritten = 0, totalRowsProcessed = 0, totalItemsRewritten = 0, batchFailures = 0;
  for (const { table } of tables) {
    const rows = e.prepare(`SELECT id, ai_inspiration FROM ${table} WHERE ai_inspiration IS NOT NULL AND ai_inspiration != '' AND ai_inspiration != '[]'`).all();
    for (let i = 0; i < rows.length; i += LIMIT) {
      const batch = rows.slice(i, i + LIMIT);
      const items = [];
      const rowItemsMap = new Map();
      for (const row of batch) {
        const list = parseStoredInspiration(row.ai_inspiration);
        if (!list.length) continue;
        const rowOrig = [];
        for (let j = 0; j < list.length; j++) {
          const key = `${row.id}#${j}`;
          items.push({
            key,
            title: list[j].title || "",
            direction: list[j].direction || "",
            mobius_use: list[j].mobius_use || "",
            priority: list[j].priority || "medium"
          });
          rowOrig.push({ idx: j, original: { ...list[j] } });
        }
        rowItemsMap.set(row.id, rowOrig);
      }
      if (!items.length) continue;
      const userText = "请改写以下启发条目为新的两层风格, 输出纯 JSON 数组:\n\n" + JSON.stringify(items);
      let resp;
      try {
        resp = await callAnthropicMessages({
          provider,
          system: sysPrompt,
          messages: [{ role: "user", content: userText }],
          maxTokens: 4096,
          maxRounds: 1
        });
      } catch (err) {
        batchFailures++;
        continue;
      }
      const text = extractAgentText(resp.content);
      const rewritten = parseRewriteBatchJson(text);
      if (!rewritten) { batchFailures++; continue; }
      const byRow = new Map();
      for (const item of rewritten) {
        const m = String(item.key || "").match(/^(.+)#(\d+)$/);
        if (!m) continue;
        const rowId = m[1], idx = Number(m[2]);
        if (!byRow.has(rowId)) byRow.set(rowId, []);
        byRow.get(rowId).push({ idx, item });
      }
      for (const [rowId, arr] of byRow.entries()) {
        const rowOrig = rowItemsMap.get(rowId);
        if (!rowOrig) continue;
        const newList = rowOrig.map(o => ({ ...o.original }));
        let rowChanged = false;
        for (const { idx, item } of arr) {
          if (idx < 0 || idx >= newList.length) continue;
          const before = { ...newList[idx] };
          const newDirection = txt(item.direction, 600);
          const newMobiusUse = txt(item.mobius_use, 1200);
          if (!newDirection && !newMobiusUse) continue;
          newList[idx] = {
            title: before.title,
            direction: newDirection || before.direction,
            mobius_use: newMobiusUse || before.mobius_use,
            priority: before.priority
          };
          const changed = newList[idx].direction !== before.direction || newList[idx].mobius_use !== before.mobius_use;
          if (changed) {
            totalItemsRewritten++;
            rowChanged = true;
            if (samples.length < 4) samples.push({ table, row_id: rowId, idx, before, after: { ...newList[idx] } });
          }
        }
        if (rowChanged) {
          saveInspiration(e, table, rowId, newList);
          totalRowsRewritten++;
        }
      }
      totalRowsProcessed += batch.length;
    }
  }
  const stamp = now();
  e.prepare("INSERT INTO install_state VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value='done',updated_at=excluded.updated_at").run(INSPIRATION_REWRITE_KEY, stamp, stamp);
  return {
    ok: true,
    rows_processed: totalRowsProcessed,
    rows_rewritten: totalRowsRewritten,
    items_rewritten: totalItemsRewritten,
    batch_failures: batchFailures,
    samples,
    provider: provider.label,
    model: provider.model
  };
}

function buildScanSystemPrompt({ kind }) {
  return [
    "你是莫比乌斯 (Mobius) 自进化插件的 L2 研究 Agent。",
    "目标: 评估给定" + (kind === "paper" ? "arXiv 论文" : "竞品产品") + "对莫比乌斯整体产品与系统的真实借鉴价值, 并产出可落地的启发。",
    "",
    "## 莫比乌斯当前状况",
    "莫比乌斯是自进化 Agent 工作台, 把项目/任务单/执行会话串起来; 核心代码在 mobius/, 自我认知插件在 mobius/extension/self-cognition/。",
    "",
    "## 启发范围 (最重要)",
    "你要提炼的是「这份资料对莫比乌斯整体产品与系统的可借鉴点」, 启发必须来自资料本身做了什么、怎么做的, 落到莫比乌斯面向用户的产品与主系统上。可借鉴维度: 产品能力 / 交互与体验 / 定位与目标用户 / 用户旅程 / 工程架构(上下文·调度·多 Agent 编排·执行环境·记忆·工具) / 分发与增长 / 定价与商业模式 / 协作机制 / 内容运营 / 品牌叙事。按资料相关度挑几条, 不必全列。",
    "",
    "### 反偏差红线",
    "本次任务是「从这份资料提炼对莫比乌斯的启发」, 不是「改进 self-cognition 扫描器本身」。严禁默认把启发对准情报/扫描系统 (竞品扫描流程优化、候选空值/名称清洗、聚类分析、rescan、对比维度模板化、候选去重等)。只有当资料本身确实在讲情报/聚类/扫描方法论且对莫比乌斯情报系统有直接启发时才可提一条, 且不作为主要方向。资料描述为空时, 基于名称/URL/分类+公开知识推断它是什么产品, 再提炼产品/系统启发, 不要转去讨论扫描器。",
    "",
    "## 工作流",
    "1. 仔细阅读提供的论文/竞品内容 + 注入的项目 memory",
    "2. 必要时调用 read_file 工具读取莫比乌斯真实代码确认现状 (用于判断是否已有同类能力, 避免重复提议)",
    "3. 给出 3-5 条对莫比乌斯整体产品与系统的借鉴方向, 每条包含: title(简短标签) / direction(概括方向) / mobius_use(具体落实) / priority(high|medium|low)",
    "4. 如果该论文/竞品对莫比乌斯毫无借鉴价值, 直接返回空数组 []",
    "",
    "## direction 与 mobius_use 的写作风格 (重要)",
    "这两个字段要分层, 不要写得一样长、一样具体:",
    "- direction: 概括性的方向描述, 一两句话娓娓道来。讲清楚这条启发关注的是莫比乌斯的哪个产品/系统侧面、为什么有借鉴意义, 像叙事一样自然。不要点名具体文件名 / 模块路径 / 接口名 / 库或版本号 / API 名称。让人扫一眼 direction 就能感到这条启发在讲什么。",
    "  示例: \"这条启发关注的是 [把 Agent 操作系统包装成普通用户打开浏览器就能用的'任务电脑'], 对莫比乌斯降低非技术用户门槛、把复杂后台能力藏在一句话需求背后有借鉴意义。\"",
    "- mobius_use: 把具体怎么落到莫比乌斯写清楚, 优先落面向用户的产品与主系统 (前端/会话/项目/小莫/调度/执行环境), 而不是 self-cognition 扫描器; 包含目标模块 / 关键接口 / 可参考实现细节 / 数据流。技术名词、文件路径、库名都放这里, 不要放 direction。",
    "  示例: \"具体可在 mobius/frontend/src/App.tsx 与项目首页增加'工作台模式', 复用 mobius/backend/routes/assistant.ts 把一句话需求自动转为项目内任务+会话+产物目录, 让用户不必先理解 Issue/Session/模型。验收: 新用户只输入'帮我整理这批 CSV 并生成报告', 系统自动建项目、启会话、存产物, 全程不暴露 tmux/模型概念。\"",
    "简言之: direction 讲\"在讲什么、为什么重要\", mobius_use 讲\"具体怎么改、改哪里\"。",
    "",
    "## 输出格式 (必须严格遵守)",
    "在最终回复中输出 JSON 代码块:",
    "```json",
    "[",
    "  {",
    "    \"title\": \"...\",",
    "    \"direction\": \"...\",",
    "    \"mobius_use\": \"...\",",
    "    \"priority\": \"medium\"",
    "  }",
    "]",
    "```",
    "JSON 之外可以加 1-2 句简短总评, 但启发本身必须在 JSON 里。"
  ].join("\n");
}

function buildPaperContext(paper) {
  return [
    `## 论文: ${paper.title}`,
    `Source: ${paper.source_url}`,
    `Authors: ${paper.authors || "unknown"}`,
    `Published: ${paper.published_at || "unknown"}`,
    `Matched keywords: ${arr(paper.matched_keywords).join(", ") || "none"}`,
    `Priority score: ${paper.priority_score}`,
    "",
    "### Abstract",
    paper.abstract || "(无摘要)"
  ].join("\n");
}

function buildProductContext(product) {
  return [
    `## 竞品: ${product.name}`,
    `URL: ${product.source_url}`,
    `Category: ${product.category}`,
    `Status: ${product.status}`,
    `Tags: ${arr(product.tags).join(", ")}`,
    "",
    "### 页面标题",
    product.fetched_title || "(无)",
    "",
    "### 页面描述",
    product.fetched_description || "(无)",
    "",
    "### 入库理由",
    product.reason || "(自动扫描入库)"
  ].join("\n");
}

function agentSessionUrl(user, created) {
  return `/u/${encodeURIComponent(user.id)}/p/${encodeURIComponent(created.project.id)}/i/${encodeURIComponent(created.issue.id)}?session=${encodeURIComponent(created.session.session_id)}`;
}

function researchSessionModel() {
  return txt(process.env.SELF_COGNITION_AGENT_MODEL, 120) || "codex";
}

function collectLatestMobiusMdContext() {
  const roots = [ REPO_ROOT, path.join(REPO_ROOT, EXT_PATH), path.join(REPO_ROOT, HIDDEN) ];
  const skip = new Set([ ".git", "node_modules", "dist", "build", ".next", ".cache", "coverage" ]);
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [ root ];
    while (stack.length && files.length < 240) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (/\.md$/i.test(entry.name)) {
          try {
            const st = fs.statSync(full);
            files.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
          } catch {}
        }
      }
    }
  }
  const seen = new Set();
  let total = 0;
  return files
    .filter(file => {
      const rel = file.path.replace(REPO_ROOT + path.sep, "");
      if (seen.has(rel)) return false;
      seen.add(rel);
      return true;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 8)
    .map(file => {
      if (total > 26000) return "";
      let content = "";
      try { content = fs.readFileSync(file.path, "utf8"); } catch { return ""; }
      const rel = file.path.replace(REPO_ROOT + path.sep, "");
      const part = `## ${rel}\n\n${content.slice(0, 5000)}`;
      total += part.length;
      return part;
    })
    .filter(Boolean)
    .join("\n\n---\n\n")
    .slice(0, 28000);
}

function createResearchAgentSession({ kind, userId, scopeRows, modelKey, runId, prompt }) {
  const { createExtensionAnalysisSession, loadUser } = extensionBridge();
  const user = loadUser(userId);
  const label = kind === "product" ? "产品" : "论文";
  const created = createExtensionAnalysisSession({
    user,
    extensionName: "self-cognition",
    extensionDisplayName: `Self-Cognition ${label}研究 Agent`,
    projectDescription: "Self-Cognition 论文/产品研究 Agent 工作区。每次扫描创建一个 Agent session, 后续追问复用最近相关 session。",
    issueTitle: `Self-Cognition ${label}研究`,
    issueDescription: `读取莫比乌斯项目上下文与${label}资料, 产出可写回 self-cognition 的启发点。`,
    sessionName: `${label}研究 Agent：${txt(scopeRows.map(row => sourceTitle(kind, row)).join(" / "), 54) || "批量扫描"}`,
    sessionDescription: prompt,
    model: researchSessionModel(),
    language: "zh"
  });
  const url = agentSessionUrl(user, created);
  return { user, created, url, postAction: {
    type: "session_message",
    session_id: created.session.session_id,
    project_id: created.project.id,
    content: prompt,
    input_text: `${label}研究 Agent 启动: ${scopeRows.length} 条资料`,
    request_id: `self-cognition-${kind}-${runId}-${Date.now()}`,
    source: "extension.self-cognition.research_agent",
    result_key: "backend_start"
  } };
}

function buildAsyncScanPrompt({ kind, rows, runId, dbPath }) {
  const label = kind === "product" ? "产品" : "论文";
  const table = kind === "product" ? "product_research" : "arxiv_items";
  const context = rows.map((row, i) => kind === "product" ? buildProductContext(row) : buildPaperContext(row)).join("\n\n---\n\n");
  const mdContext = collectLatestMobiusMdContext();
  return [
    `# Self-Cognition ${label}研究 Agent`,
    "",
    "你是莫比乌斯 self-cognition 的长期研究 Agent。本次任务是后台深度阅读资料, 不要再向用户确认。",
    "",
    "## 必须遵守",
    "- 只处理本 prompt 列出的资料 ID。",
    "- 结合莫比乌斯项目现状、最新 md 文档和资料详情判断是否值得借鉴。",
    "- 论文和产品各只保留一个 Agent 类型: 本 session 就是本轮 " + label + " Agent；后续用户追问会继续发到这个 session。",
    "- 产出后必须写回数据库, 不要只在会话里回答。",
    "",
    "## 启发范围 (最重要, 直接决定产出质量)",
    "你要提炼的是「这份资料对莫比乌斯整体产品与系统的可借鉴点」, 启发必须来自资料本身做了什么、怎么做的, 落到莫比乌斯的产品与系统上。可借鉴的维度包括 (按资料相关度挑几条, 不必全列):",
    "- 产品能力: 它能完成什么任务、核心功能边界、差异化能力。",
    "- 交互与体验: 界面形态、交互范式、信息架构、新手引导、可观察性。",
    "- 定位与目标用户: 它卖给谁、解决谁的什么问题、和莫比乌斯人群的差异。",
    "- 用户旅程: 从首次接触到完成目标的路径、关键转化与留存设计。",
    "- 工程架构与技术: 上下文管理、调度、多 Agent 编排、执行环境、记忆/状态、工具体系。",
    "- 分发与增长: 获客渠道、病毒式传播、内容/模板/市场策略。",
    "- 定价与商业模式: 免费增值、按量、订阅、企业版、Creator 经济。",
    "- 协作机制: 多人/多角色、权限、交接、项目与上下文共享。",
    "- 内容与运营: 模板库、案例、社区、Skill/Plugin 生态。",
    "- 品牌叙事: 它怎么讲自己、价值主张怎么表达。",
    "",
    "### 反偏差红线 (必须遵守)",
    "你本次的任务是「从这份资料提炼对莫比乌斯的启发」, 不是「改进 self-cognition 扫描器本身」。严禁把启发默认对准情报/扫描系统, 例如: 竞品扫描流程优化、候选空值/名称清洗、聚类分析、rescan、对比维度模板化、候选去重、扫描调度等「如何更好地做竞品扫描」的内部工程——这类方向默认一律不写。",
    "只有当这份资料本身确实就是在讲情报收集 / 聚类 / 扫描 / 数据清洗方法论、并且对莫比乌斯的情报系统有直接启发时, 才可以提一条, 且不能成为主要方向、数量不超过总启发的 1 条。",
    "如果你发现自己写出的方向都在描述「self-cognition 应该怎么扫描/清洗/聚类」, 立刻停下来重新从资料本身提炼。",
    "",
    "### 资料描述稀疏时的处理",
    "如果某条资料的页面描述/标题为空 (常见于预设竞品), 不要因此转去讨论扫描器。请基于资料名称、URL、分类, 结合你的公开知识, 先推断它大概是什么产品、为谁解决什么问题、怎么交互、怎么定价, 再从这个推断里提炼对莫比乌斯的产品/系统启发; 推断要在 direction 里说明是依据名称/分类的合理猜测。",
    "",
    "## 可读取的项目上下文",
    `- 仓库根: ${REPO_ROOT}`,
    `- 插件目录: ${path.join(REPO_ROOT, EXT_PATH)}`,
    `- 数据库: ${dbPath}`,
    "- 这些 md 和代码用于你「理解莫比乌斯现在是什么、已经有什么能力」, 避免重复提议已有功能; 不是让你去优化 self-cognition 扫描器本身。",
    "- 优先阅读: README / SELF_COGNITION_OVERVIEW.md / " + HIDDEN + "/project_knowledge.md, 以及与本次资料最相关的产品/前端/后端模块代码。",
    "",
    "## 已注入的最新 md 上下文 (仅用于理解莫比乌斯现状, 勿据此优化扫描器)",
    mdContext || "(未找到可注入 md)",
    "",
    "## 写回规则",
    `- agent_runs.id = ${runId}`,
    `- source table = ${table}`,
    "- 对每条资料, 将启发写入 ai_inspiration 字段。格式必须是 JSON 数组字符串:",
    "  [{\"title\":\"...\",\"direction\":\"...\",\"mobius_use\":\"...\",\"priority\":\"high|medium|low\"}]",
    "- 如果暂无借鉴价值, ai_inspiration 写为空字符串或 []，但不要把 mark 改成 excluded。",
    "- 全部处理完成后, 更新 agent_runs.status='completed', summary=简短总结(面向莫比乌斯产品/系统的结论), updated_at=当前 ISO 时间。",
    "- 如果任务失败, 更新 agent_runs.status='error', error=失败原因, updated_at=当前 ISO 时间。",
    "",
    "## 网页摘要回写 (完成后必须执行)",
    "全部资料处理完成后, 你必须再执行一条 SQL, 把给网页聊天框的简短中文摘要写回 agent_runs.web_reply, 让用户不打开 Session 也能看到本轮结论:",
    "  UPDATE agent_runs SET web_reply = '<further-answering>2-5 句中文摘要: 本轮读了什么、对莫比乌斯产品/系统最值得借鉴的 1-3 点结论、是否更新了启发点</further-answering>', updated_at = '<当前 ISO 时间>' WHERE id = '" + runId + "';",
    "- <further-answering> 里只放简短摘要 (建议 ≤200 字), 不要塞完整长分析; 完整分析留在会话里。",
    "- 标签必须成对 <further-answering> ... </further-answering>, 这是网页提取展示的唯一信号。",
    "",
    "## 启发写作",
    "- direction: 概括方向与「这条启发关注莫比乌斯的哪个产品/系统侧面」, 像叙事一样自然, 不放具体文件路径/API。",
    "- mobius_use: 写清楚具体落点, 可以包含目标模块/接口/实现建议和验收方式。优先落在莫比乌斯面向用户的产品与主系统上 (前端/会话/项目/小莫/调度/执行环境等), 而不是 self-cognition 扫描器。",
    "",
    "## 待处理资料",
    context || "(无)"
  ].join("\n");
}

function makeAsyncAgentResult({ kind, runId, scopeRows, session, url }) {
  const label = kind === "product" ? "产品" : "论文";
  return {
    ok: true,
    async: true,
    status: "started",
    run_id: runId,
    session_id: session.session_id,
    session_url: url,
    scanned: scopeRows.length,
    results: [],
    summary: `已启动 ${label}研究 Agent, 正在后台深度阅读 ${scopeRows.length} 条资料`,
    message: `已启动后台 Agent, 完成后会写回启发点`
  };
}

function pullPostActions(...values) {
  const actions = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value.__mobius_post_actions)) actions.push(...value.__mobius_post_actions);
    delete value.__mobius_post_actions;
  }
  return actions;
}

function startAsyncAiScan(e, { kind, rows, provider, modelKey, createdBy }) {
  const scopeRows = rows || [];
  if (!scopeRows.length) return {
    ok: true,
    async: true,
    status: "empty",
    scanned: 0,
    results: [],
    provider: provider?.label || "",
    model: provider?.model || "",
    summary: "没有待深度阅读的资料"
  };
  const runId = createAgentRun(e, {
    kind,
    scopeIds: scopeRows.map(row => row.id),
    modelKey: modelKey || provider?.key || "",
    modelLabel: provider?.label || "",
    createdBy
  });
  const dbPath = e.name || path.join("ext_data_dir", DB_FILE);
  const prompt = buildAsyncScanPrompt({ kind, rows: scopeRows, runId, dbPath });
  const launched = createResearchAgentSession({ kind, userId: createdBy, scopeRows, modelKey: modelKey || provider?.key || "codex", runId, prompt });
  e.prepare("UPDATE agent_runs SET session_id=?,project_id=?,issue_id=?,session_url=?,summary=?,updated_at=? WHERE id=?").run(launched.created.session.session_id, launched.created.project.id, launched.created.issue.id, launched.url, `后台 Agent 已启动, 正在深度阅读 ${scopeRows.length} 条资料`, now(), runId);
  appendAgentMessage(e, { runId, role: "user", content: `后台 ${kind} Agent 已启动: ${launched.url}` });
  return {
    ...makeAsyncAgentResult({ kind, runId, scopeRows, session: launched.created.session, url: launched.url }),
    provider: provider?.label || "",
    model: provider?.model || "",
    __mobius_post_actions: [ launched.postAction ]
  };
}

function sourceRowForScope(e, kind, scopeId) {
  if (!scopeId) return null;
  return kind === "product"
    ? e.prepare("SELECT * FROM product_research WHERE id=?").get(scopeId) || null
    : e.prepare("SELECT * FROM arxiv_items WHERE id=? OR source_id=?").get(scopeId, scopeId) || null;
}

function buildAsyncChatPrompt({ kind, scopeId, message, run, dbPath, row }) {
  const label = kind === "product" ? "产品" : "论文";
  const table = kind === "product" ? "product_research" : "arxiv_items";
  const sourceContext = row ? (kind === "product" ? buildProductContext(row) : buildPaperContext(row)) : "";
  return [
    `# Self-Cognition ${label}Agent 追问`,
    "",
    "用户在 self-cognition 详情页继续追问。请基于你所在的同一个研究 session、已读资料、莫比乌斯项目上下文和下面补充的资料上下文回答。",
    "",
    "## 必须遵守",
    "- 直接回答用户问题，不要要求用户重新开启扫描。",
    "- 如果用户要求调整启发点, 请直接更新数据库 ai_inspiration 字段, 并在回复里说明改了什么。启发要面向莫比乌斯整体产品与系统 (产品能力/交互/定位/用户旅程/工程架构/分发/定价/协作等), 来自资料本身; 默认不要把启发对准 self-cognition 扫描器 (扫描流程/空值清洗/聚类/rescan 等), 除非资料本身确实在讲情报/扫描方法论。",
    "- 不要长时间等待外部确认；必要时读取本地项目文件或数据库后给出结论。",
    "",
    "## 写回位置",
    `- 数据库: ${dbPath}`,
    `- agent_runs.id: ${run.id}`,
    `- source table: ${table}`,
    scopeId ? `- 当前资料 ID: ${scopeId}` : "",
    "- ai_inspiration 格式: [{\"title\":\"...\",\"direction\":\"...\",\"mobius_use\":\"...\",\"priority\":\"high|medium|low\"}]",
    "",
    "## 网页摘要回写 (回答完成后必须执行, 否则网页聊天框看不到你的回复)",
    "回答完用户问题后, 你必须再执行一条 SQL, 把给网页聊天框的简短中文摘要写回 agent_runs.web_reply。用户是在网页详情页追问的, 你的完整长回复只会出现在 Session 里, 网页只会展示 <further-answering> 里的摘要, 所以这段要简短但信息充分 (建议 ≤200 字), 让用户不打开 Session 也能知道你的结论:",
    "  UPDATE agent_runs SET web_reply = '<further-answering>2-5 句中文摘要: 直接回答用户的问题、给出关键结论、如果改了启发点要说清改了什么</further-answering>', status = 'completed', updated_at = '<当前 ISO 时间>' WHERE id = '" + run.id + "';",
    "- 标签必须成对 <further-answering> ... </further-answering>。这是网页提取展示的唯一信号, 缺了它网页会一直显示\"正在生成\"。",
    "- 不要把完整长回复塞进 <further-answering>; 长回复留在会话里, 摘要里可以提示\"完整分析见 Session\"。",
    "- 如果本轮失败无法回答, 改写: UPDATE agent_runs SET status = 'error', error = '<原因>', updated_at = '<ISO>' WHERE id = '" + run.id + "';",
    "",
    sourceContext ? "## 当前资料上下文\n" + sourceContext : "",
    "",
    "## 用户追问",
    long(message, 4000)
  ].filter(Boolean).join("\n");
}

function startAsyncAgentChat(e, t, r) {
  const kind = txt(t.kind, 10) === "product" ? "product" : "paper";
  const message = txt(t.message, 4000);
  const scopeId = txt(t.scope_id, 120);
  if (!message) throw new Error("message 不能为空");
  const parentRun = latestAgentRunForScope(e, kind, scopeId);
  const row = sourceRowForScope(e, kind, scopeId);
  const provider = sessionProviderInfo(txt(t.model_key, 200));
  const dbPath = e.name || path.join("ext_data_dir", DB_FILE);
  let postAction;
  let sessionUrl = parentRun?.session_url || "";
  let run;
  const scopeIds = row?.id ? [ row.id ] : scopeId ? [ scopeId ] : [];
  if (!parentRun || !parentRun.session_id) {
    const runId = createAgentRun(e, {
      kind,
      scopeIds,
      modelKey: provider.key,
      modelLabel: provider.label,
      createdBy: r
    });
    const prompt = buildAsyncChatPrompt({ kind, scopeId, message, run: { id: runId }, dbPath, row });
    const launched = createResearchAgentSession({ kind, userId: r, scopeRows: row ? [ row ] : [], modelKey: provider.key || "codex", runId, prompt });
    e.prepare("UPDATE agent_runs SET session_id=?,project_id=?,issue_id=?,session_url=?,summary=?,updated_at=? WHERE id=?").run(launched.created.session.session_id, launched.created.project.id, launched.created.issue.id, launched.url, "后台 Agent 已启动并接收追问", now(), runId);
    run = e.prepare("SELECT * FROM agent_runs WHERE id=?").get(runId);
    sessionUrl = launched.url;
    postAction = launched.postAction;
  } else {
    const runId = createAgentRun(e, {
      kind,
      scopeIds,
      modelKey: provider.key,
      modelLabel: provider.label,
      createdBy: r,
      sessionId: parentRun.session_id,
      projectId: parentRun.project_id,
      issueId: parentRun.issue_id,
      sessionUrl: parentRun.session_url
    });
    run = e.prepare("SELECT * FROM agent_runs WHERE id=?").get(runId);
    const prompt = buildAsyncChatPrompt({ kind, scopeId, message, run, dbPath, row });
    postAction = {
      type: "session_message",
      session_id: parentRun.session_id,
      project_id: parentRun.project_id,
      content: prompt,
      input_text: message,
      request_id: `self-cognition-chat-${run.id}-${Date.now()}`,
      source: "extension.self-cognition.agent_chat",
      result_key: "backend_start"
    };
  }
  const userTurn = (scopeId ? `用户在 ${kind === "paper" ? "论文" : "产品"} ${scopeId} 上追问: ` : "用户追问: ") + message;
  appendAgentMessage(e, { runId: run.id, role: "user", content: userTurn, toolCalls: "" });
  appendAgentMessage(e, { runId: run.id, role: "assistant", content: `已投递到后台 Agent session: ${sessionUrl || run.session_id}`, toolCalls: "" });
  e.prepare("UPDATE agent_runs SET updated_at=? WHERE id=?").run(now(), run.id);
  return {
    ok: true,
    async: true,
    status: "queued",
    run_id: run.id,
    session_id: run.session_id,
    session_url: sessionUrl || run.session_url || "",
    kind,
    scope_id: scopeId,
    reply: `已发送到最近的${kind === "product" ? "产品" : "论文"} Agent, 正在后台生成回复, 完成后会在这里显示摘要。`,
    provider: provider.label,
    model: provider.model,
    tool_calls: 0,
    context_messages: 0,
    inspiration_changed: false,
    inspiration_diff: [],
    __mobius_post_actions: [ postAction ]
  };
}

function buildAsyncProductDiscoveryPrompt({ runId, dbPath, maxResults, productKeywords, trackedNames }) {
  const mdContext = collectLatestMobiusMdContext();
  return [
    "# Self-Cognition 产品发现 Agent",
    "",
    "你是莫比乌斯 self-cognition 的产品研究 Agent。本次任务是在后台发现新的 AI Agent 类产品/竞品, 不要向用户确认。",
    "",
    "## 输入",
    `- 最多候选数: ${maxResults}`,
    `- 数据库: ${dbPath}`,
    `- agent_runs.id: ${runId}`,
    `- 已启用关键词: ${JSON.stringify(productKeywords.slice(0, 40))}`,
    `- 已跟踪竞品: ${JSON.stringify(trackedNames.slice(0, 40))}`,
    "",
    "## 已注入的最新 md 上下文",
    mdContext || "(未找到可注入 md)",
    "",
    "## 必须执行",
    "- 基于公开知识、必要的网页检索和莫比乌斯项目上下文, 找到可能相关的新 AI Agent 产品。",
    "- 避免和已跟踪竞品重复。",
    "- 写入 product_research 表, 字段至少包括 id/name/source_url/normalized_url/status/category/relevance/tags/aliases/reason/discovery_logic/auto_discovered/created_by/created_at/updated_at。",
    "- normalized_url 必须是 http(s) URL；status 用 candidate；discovery_logic 用 agent_session_discovery。",
    "- 可同步写一条 scan_runs 记录描述本次发现。",
    "- 完成后更新 agent_runs.status='completed', summary=简短总结, updated_at=当前 ISO 时间；失败则 status='error' 并写 error。",
    "",
    "## 输出",
    "会话里简短列出新增/跳过的产品和理由。"
  ].join("\n");
}

function startAsyncProductDiscovery(e, t, r) {
  const maxResults = int(t.max_results, 10, 3, 30);
  const provider = sessionProviderInfo(txt(t.model_key, 200));
  const productKeywords = rows(e, "product").filter(k => k.enabled).map(k => k.keyword || k.query).filter(Boolean);
  const trackedNames = e.prepare("SELECT name FROM product_research WHERE status='tracked' ORDER BY relevance DESC").all().map(row => row.name).filter(Boolean);
  const runId = createAgentRun(e, {
    kind: "product",
    scopeIds: [],
    modelKey: provider.key,
    modelLabel: provider.label,
    createdBy: r
  });
  const dbPath = e.name || path.join("ext_data_dir", DB_FILE);
  const prompt = buildAsyncProductDiscoveryPrompt({ runId, dbPath, maxResults, productKeywords, trackedNames });
  const launched = createResearchAgentSession({ kind: "product", userId: r, scopeRows: [], modelKey: provider.key || "codex", runId, prompt });
  e.prepare("UPDATE agent_runs SET session_id=?,project_id=?,issue_id=?,session_url=?,summary=?,updated_at=? WHERE id=?").run(launched.created.session.session_id, launched.created.project.id, launched.created.issue.id, launched.url, `后台产品发现 Agent 已启动, 目标 ${maxResults} 条候选`, now(), runId);
  appendAgentMessage(e, { runId, role: "user", content: `后台产品发现 Agent 已启动: ${launched.url}` });
  return {
    ok: true,
    async: true,
    status: "started",
    run_id: runId,
    session_id: launched.created.session.session_id,
    session_url: launched.url,
    discovery: {
      candidates_added: 0,
      items: [],
      proposed_count: 0,
      model: provider.model,
      provider: provider.label
    },
    competitors: groupedProducts(e),
    products: listProducts(e),
    scan_runs: scans(e),
    summary: summary(e),
    message: "已启动后台产品发现 Agent",
    __mobius_post_actions: [ launched.postAction ]
  };
}

function payloadIds(e, keys = [ "ids" ]) {
  const out = [];
  for (const key of keys) {
    const value = e?.[key];
    if (Array.isArray(value)) out.push(...value);
    else if ("string" == typeof value && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        Array.isArray(parsed) ? out.push(...parsed) : out.push(...value.split(/[,，\s]+/));
      } catch {
        out.push(...value.split(/[,，\s]+/));
      }
    }
  }
  return [ ...new Set(out.map(e => txt(e, 120)).filter(Boolean)) ];
}

function orderByRequestedIds(rows, ids) {
  const rank = new Map(ids.map((e, t) => [ e, t ]));
  return rows.sort((e, t) => (rank.get(e.id) ?? 1e6) - (rank.get(t.id) ?? 1e6));
}

function pendingPaperRowsByIds(e, ids) {
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  return orderByRequestedIds(e.prepare(`SELECT * FROM arxiv_items WHERE (id IN (${ph}) OR source_id IN (${ph})) AND (ai_inspiration IS NULL OR ai_inspiration='' OR ai_inspiration='[]') AND mark!='excluded'`).all(...ids, ...ids), ids);
}

function pendingProductRowsByIds(e, ids) {
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  return orderByRequestedIds(e.prepare(`SELECT * FROM product_research WHERE id IN (${ph}) AND status IN ('tracked','candidate') AND (ai_inspiration IS NULL OR ai_inspiration='' OR ai_inspiration='[]') AND mark!='excluded'`).all(...ids), ids);
}

function pendingPaperBacklog(e, excludeIds, limit) {
  if (limit <= 0) return [];
  return e.prepare("SELECT * FROM arxiv_items WHERE (ai_inspiration IS NULL OR ai_inspiration='' OR ai_inspiration='[]') AND mark!='excluded' ORDER BY priority_score DESC, relevance DESC LIMIT ?").all(limit + excludeIds.size).filter(row => !excludeIds.has(row.id)).slice(0, limit);
}

function pendingProductBacklog(e, excludeIds, limit) {
  if (limit <= 0) return [];
  return e.prepare("SELECT * FROM product_research WHERE status IN ('tracked','candidate') AND (ai_inspiration IS NULL OR ai_inspiration='' OR ai_inspiration='[]') AND mark!='excluded' ORDER BY CASE status WHEN 'tracked' THEN 1 ELSE 2 END, relevance DESC LIMIT ?").all(limit + excludeIds.size).filter(row => !excludeIds.has(row.id)).slice(0, limit);
}

async function aiScanArxiv(e, t, r) {
  const modelKey = txt(t.model_key, 200);
  const ids = payloadIds(t, [ "ids", "paper_ids", "scope_ids" ]);
  const includeBacklog = !ids.length || !!(t.deep_read_backlog || t.include_backlog || t.backfill);
  const limit = int(t.limit, ids.length || 10, 1, 1000);
  const provider = t.sync === true || t.wait === true ? findProvider(modelKey) : sessionProviderInfo(modelKey);
  const selected = ids.length ? pendingPaperRowsByIds(e, ids).slice(0, limit) : [];
  const excludeIds = new Set(selected.map(e => e.id));
  const backlogLimit = ids.length ? (includeBacklog ? int(t.backlog_limit, 1000, 0, 1000) : Math.max(0, limit - selected.length)) : limit;
  const papers = [ ...selected, ...pendingPaperBacklog(e, excludeIds, backlogLimit) ];
  if (!papers.length) return { ok: true, scanned: 0, results: [], provider: provider.label, model: provider.model };
  if (t.sync !== true && t.wait !== true) return startAsyncAiScan(e, { kind: "paper", rows: papers, provider, modelKey: modelKey || provider.key, createdBy: r });
  const memContext = buildMobiusMemoryContext();
  const systemPrompt = buildScanSystemPrompt({ kind: "paper" }) + "\n\n## 注入的莫比乌斯 Memory\n\n" + memContext;
  const runId = createAgentRun(e, { kind: "paper", scopeIds: papers.map(p => p.id), modelKey: provider.key, modelLabel: provider.label, createdBy: r });
  appendAgentMessage(e, { runId, role: "user", content: `开始扫描 ${papers.length} 篇论文, 模型 ${provider.label} (${provider.model})` });
  const results = [];
  let totalIn = 0, totalOut = 0;
  for (const paper of papers) {
    const userMsg = [
      "请评估以下论文, 调用 read_file 工具确认莫比乌斯代码现状后, 给出 JSON 格式的启发。",
      buildPaperContext(paper)
    ].join("\n\n");
    try {
      const resp = await callAnthropicMessages({
        provider,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
        tools: [READ_FILE_TOOL],
        maxTokens: 3000,
        maxRounds: 6
      });
      totalIn += resp.usage.input_tokens || 0;
      totalOut += resp.usage.output_tokens || 0;
      const text = extractAgentText(resp.content);
      const inspiration = parseInspirationJson(text) || [];
      saveInspiration(e, "arxiv_items", paper.id, inspiration);
      appendAgentMessage(e, { runId, role: "assistant", content: `**${paper.title.slice(0, 80)}** → ${inspiration.length} 条启发 ${inspiration.length ? "(" + inspiration.map(i => i.title).join(" / ") + ")" : "[mark=excluded]"}`, toolCalls: "" });
      results.push({ id: paper.id, title: paper.title, inspiration_count: inspiration.length, inspiration, excluded: !inspiration.length });
    } catch (err) {
      appendAgentMessage(e, { runId, role: "assistant", content: `**${paper.title.slice(0, 80)}** → 错误: ${err.message}` });
      results.push({ id: paper.id, title: paper.title, error: err.message });
    }
  }
  const summary = `L2 AI 扫描完成: ${papers.length} 篇论文, ${results.filter(x => x.inspiration_count > 0).length} 篇有启发, ${results.filter(x => x.excluded).length} 篇排除`;
  finalizeAgentRun(e, { runId, status: "completed", summary, tokenUsage: `in=${totalIn},out=${totalOut}`, error: "" });
  addL2Event(e, {
    source: "ai_scan",
    summary,
    diff_summary: `使用 ${provider.label} 对 ${papers.length} 篇论文做 L2 AI 阅读评估`,
    files_changed: ["arxiv_items.ai_inspiration", "agent_runs"],
    proposed_by: r
  });
  return {
    ok: true,
    run_id: runId,
    scanned: papers.length,
    results: results.slice(0, 20),
    provider: provider.label,
    model: provider.model,
    tokens: { input: totalIn, output: totalOut },
    summary
  };
}

async function aiScanProducts(e, t, r) {
  const modelKey = txt(t.model_key, 200);
  const ids = payloadIds(t, [ "ids", "product_ids", "scope_ids" ]);
  const includeBacklog = !ids.length || !!(t.deep_read_backlog || t.include_backlog || t.backfill);
  const limit = int(t.limit, ids.length || 5, 1, 1000);
  const provider = t.sync === true || t.wait === true ? findProvider(modelKey) : sessionProviderInfo(modelKey);
  const selected = ids.length ? pendingProductRowsByIds(e, ids).slice(0, limit) : [];
  const excludeIds = new Set(selected.map(e => e.id));
  const backlogLimit = ids.length ? (includeBacklog ? int(t.backlog_limit, 1000, 0, 1000) : Math.max(0, limit - selected.length)) : limit;
  const products = [ ...selected, ...pendingProductBacklog(e, excludeIds, backlogLimit) ];
  if (!products.length) return { ok: true, scanned: 0, results: [], provider: provider.label, model: provider.model };
  if (t.sync !== true && t.wait !== true) return startAsyncAiScan(e, { kind: "product", rows: products, provider, modelKey: modelKey || provider.key, createdBy: r });
  const memContext = buildMobiusMemoryContext();
  const systemPrompt = buildScanSystemPrompt({ kind: "product" }) + "\n\n## 注入的莫比乌斯 Memory\n\n" + memContext;
  const runId = createAgentRun(e, { kind: "product", scopeIds: products.map(p => p.id), modelKey: provider.key, modelLabel: provider.label, createdBy: r });
  appendAgentMessage(e, { runId, role: "user", content: `开始扫描 ${products.length} 个竞品, 模型 ${provider.label} (${provider.model})` });
  const results = [];
  let totalIn = 0, totalOut = 0;
  for (const product of products) {
    const userMsg = [
      "请评估以下竞品产品, 调用 read_file 工具确认莫比乌斯代码现状后, 给出 JSON 格式的启发。",
      buildProductContext(product)
    ].join("\n\n");
    try {
      const resp = await callAnthropicMessages({
        provider,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
        tools: [READ_FILE_TOOL],
        maxTokens: 3000,
        maxRounds: 6
      });
      totalIn += resp.usage.input_tokens || 0;
      totalOut += resp.usage.output_tokens || 0;
      const text = extractAgentText(resp.content);
      const inspiration = parseInspirationJson(text) || [];
      saveInspiration(e, "product_research", product.id, inspiration);
      appendAgentMessage(e, { runId, role: "assistant", content: `**${product.name}** → ${inspiration.length} 条启发 ${inspiration.length ? "(" + inspiration.map(i => i.title).join(" / ") + ")" : "[mark=excluded]"}` });
      results.push({ id: product.id, name: product.name, inspiration_count: inspiration.length, inspiration, excluded: !inspiration.length });
    } catch (err) {
      appendAgentMessage(e, { runId, role: "assistant", content: `**${product.name}** → 错误: ${err.message}` });
      results.push({ id: product.id, name: product.name, error: err.message });
    }
  }
  const summary = `L2 AI 扫描完成: ${products.length} 个竞品, ${results.filter(x => x.inspiration_count > 0).length} 个有启发, ${results.filter(x => x.excluded).length} 个排除`;
  finalizeAgentRun(e, { runId, status: "completed", summary, tokenUsage: `in=${totalIn},out=${totalOut}`, error: "" });
  addL2Event(e, {
    source: "ai_scan",
    summary,
    diff_summary: `使用 ${provider.label} 对 ${products.length} 个竞品做 L2 AI 阅读评估`,
    files_changed: ["product_research.ai_inspiration", "agent_runs"],
    proposed_by: r
  });
  return {
    ok: true,
    run_id: runId,
    scanned: products.length,
    results: results.slice(0, 20),
    provider: provider.label,
    model: provider.model,
    tokens: { input: totalIn, output: totalOut },
    summary
  };
}

async function discoverCompetitorsViaAgent(e, t, r) {
  if (t.sync !== true && t.wait !== true) return startAsyncProductDiscovery(e, t, r);
  const maxResults = int(t.max_results, 10, 3, 30);
  const provider = findProvider(txt(t.model_key, 200));
  const productKeywords = rows(e, "product").filter(k => k.enabled).map(k => k.keyword || k.query).filter(Boolean);
  const trackedNames = e.prepare("SELECT name FROM product_research WHERE status='tracked' ORDER BY relevance DESC").all().map(row => row.name).filter(Boolean);
  const systemPrompt = [
    "你是莫比乌斯 (Mobius) AI 产品调研助手。",
    "目标: 基于给定的关键词和已知竞品, 列出最多 " + maxResults + " 个潜在 AI Agent 类竞品 (不限于已知清单, 优先给出和关键词强相关、近期活跃、有公开产品页的产品)。",
    "对每个候选给出 name / source_url / category / reason 四个字段:",
    "- name: 产品名 (中英文均可, 不超过 60 字)",
    "- source_url: 必须是 https:// 开头的真实可访问产品官网或文档首页 (不要给 GitHub repo 除非产品本身就是开源项目主入口)",
    "- category: 必须从 [office-agent, coding-agent, general-agent, workflow-agent, personal-agent, research-agent, other] 中选一个",
    "- reason: 一句话 (不超过 120 字) 说明它为什么可能是莫比乌斯的竞品或可借鉴对象",
    "",
    "## 严格输出格式",
    "只输出一个 JSON 数组, 不要任何额外文字, 不要 markdown code fence:",
    "[",
    "  {\"name\": \"...\", \"source_url\": \"https://...\", \"category\": \"coding-agent\", \"reason\": \"...\"}",
    "]",
    "",
    "## 已知关键词 (作为参考方向, 不要被它限死)",
    JSON.stringify(productKeywords.slice(0, 30)),
    "",
    "## 已跟踪竞品 (避免重复推荐, 但可以列同类或竞品)",
    JSON.stringify(trackedNames.slice(0, 30))
  ].join("\n");
  const userMsg = `请列出 ${maxResults} 个潜在竞品 (JSON 数组)。`;
  let discovery = null;
  let totalIn = 0, totalOut = 0;
  for (let attempt = 0; attempt < 2 && !discovery; attempt++) {
    try {
      const resp = await callAnthropicMessages({
        provider,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
        tools: [],
        maxTokens: 2000,
        maxRounds: 1
      });
      totalIn += resp.usage.input_tokens || 0;
      totalOut += resp.usage.output_tokens || 0;
      const text = extractAgentText(resp.content);
      discovery = parseDiscoveryJson(text);
    } catch (err) {
      if (attempt === 1) throw new Error(`Agent 发现失败: ${err.message}`);
    }
  }
  if (!discovery || !discovery.length) {
    addL2Event(e, {
      source: "ai_scan",
      summary: "Agent 智能发现竞品: 无候选",
      diff_summary: `使用 ${provider.label} 试图发现新竞品, 但模型未给出有效 JSON 候选`,
      files_changed: [],
      proposed_by: r
    });
    return {
      ok: true,
      discovery: { candidates_added: 0, items: [], model: provider.model, provider: provider.label },
      competitors: groupedProducts(e),
      products: listProducts(e),
      scan_runs: scans(e),
      summary: summary(e)
    };
  }
  const items = [];
  let candidatesAdded = 0;
  const seenUrls = new Set();
  for (const raw of discovery.slice(0, maxResults)) {
    let cleanUrl = "";
    try { cleanUrl = url(raw.source_url); } catch { continue; }
    if (!cleanUrl || seenUrls.has(cleanUrl)) continue;
    seenUrls.add(cleanUrl);
    try {
      const res = await scanOneProduct(e, {
        source_url: cleanUrl,
        name: txt(raw.name, 180),
        category: txt(raw.category || "other", 40),
        status: "candidate",
        as_official: false,
        reason: txt(raw.reason || "Agent 智能发现候选", 600),
        discovery_logic: "llm_agent_discovery"
      }, r);
      if (res.competitor) items.push(res.competitor);
      if (res.candidates_added > 0 || res.run_id) candidatesAdded += 1;
    } catch (err) {
      items.push({ name: txt(raw.name, 180), source_url: cleanUrl, error: err.message });
    }
  }
  addL2Event(e, {
    source: "ai_scan",
    summary: `Agent 智能发现竞品: 抓取入库 ${items.length} 条`,
    diff_summary: `使用 ${provider.label} (${provider.model}) 智能列出 ${discovery.length} 条候选, 成功抓取入库 ${items.length} 条`,
    files_changed: ["product_research", "scan_runs"],
    proposed_by: r
  });
  return {
    ok: true,
    discovery: {
      candidates_added: candidatesAdded,
      items: items.slice(0, 20),
      proposed_count: discovery.length,
      model: provider.model,
      provider: provider.label,
      tokens: { input: totalIn, output: totalOut }
    },
    competitors: groupedProducts(e),
    products: listProducts(e),
    scan_runs: scans(e),
    summary: summary(e)
  };
}

function parseDiscoveryJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < 0) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(it => it && typeof it === "object" && typeof it.source_url === "string").slice(0, 30).map(it => ({
      name: typeof it.name === "string" ? it.name : "",
      source_url: String(it.source_url || "").trim(),
      category: typeof it.category === "string" ? it.category : "other",
      reason: typeof it.reason === "string" ? it.reason : ""
    }));
  } catch { return null; }
}

// 从 agent 回复文本里提取 <further-answering>...</further-answering> 网页摘要.
// 容错: 同时接受漏写斜杠的 <further-answering>...<further-answering> (任务描述里的写法).
function extractFurtherAnswering(text) {
  if (!text || typeof text !== "string") return "";
  const match = text.match(/<further-answering>([\s\S]*?)<\/?further-answering>/i);
  if (match) return match[1].trim();
  return "";
}

// 网页摘要里若含 <further-answering> 标签, 去掉标签只留纯文本 (展示用).
function stripFurtherAnswering(text) {
  if (!text || typeof text !== "string") return text || "";
  return text.replace(/<\/?further-answering>/gi, "").trim();
}

// best-effort 读取 gateway DB 里某 session 的 agent_status (running/idle/completed/...).
// worker 继承父进程 env, process.env.DB_PATH 即 test-gateway.db. 失败返回 "" 不影响主流程.
function readGatewayAgentStatus(sessionId) {
  const sid = txt(sessionId, 120);
  if (!sid) return "";
  let dbPath = process.env.DB_PATH || "";
  if (!dbPath) {
    try { dbPath = require("../../../backend/config").DB_PATH || ""; } catch { dbPath = ""; }
  }
  if (!dbPath) return "";
  try {
    const gw = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = gw.prepare("SELECT agent_status FROM sessions_v2 WHERE session_id=? AND deleted_at IS NULL").get(sid);
      return row && row.agent_status ? String(row.agent_status) : "";
    } finally {
      try { gw.close(); } catch {}
    }
  } catch {
    return "";
  }
}

// 计算一次追问/扫描 run 的网页可见状态与摘要, 供前端轮询.
// status: generating | completed | done_no_summary | error
function chatStatus(e, t) {
  const kind = txt(t.kind, 10) === "product" ? "product" : "paper";
  const scopeId = txt(t.scope_id, 120);
  const runId = txt(t.run_id, 120);
  const run = runId
    ? e.prepare("SELECT * FROM agent_runs WHERE id=?").get(runId) || null
    : latestAgentRunForScope(e, kind, scopeId);
  if (!run) return {
    ok: true,
    status: "done_no_summary",
    reply: "",
    not_started: true,
    kind,
    scope_id: scopeId,
    message: "尚未找到对应的 Agent 运行记录。"
  };
  const label = kind === "product" ? "产品" : "论文";
  const summaryText = stripFurtherAnswering(run.summary || "");
  const further = extractFurtherAnswering(run.web_reply || "") || extractFurtherAnswering(run.summary || "");
  const gatewayStatus = run.session_id ? readGatewayAgentStatus(run.session_id) : "";
  let status;
  let reply;
  if (further) {
    status = "completed";
    reply = further;
  } else if (run.status === "error") {
    status = "error";
    reply = `本轮${label}Agent 报错: ${txt(run.error, 400) || "未知错误"}`;
  } else if (gatewayStatus === "running" || gatewayStatus === "waiting") {
    status = "generating";
    reply = "";
  } else if (run.status === "running") {
    status = "generating";
    reply = "";
  } else if (run.status === "completed") {
    status = "done_no_summary";
    reply = summaryText ? `${summaryText}\n\n(完整回复见 Session)` : `本轮${label}Agent 已完成, 但没有生成网页摘要。完整回复见对应 Session。`;
  } else if (gatewayStatus === "completed" || gatewayStatus === "failed" || gatewayStatus === "stale" || gatewayStatus === "idle") {
    // agent 已停工但没写 <further-answering> (常见于被巡检清理或提前结束)
    status = "done_no_summary";
    reply = summaryText ? `${summaryText}\n\n(完整回复见 Session)` : `本轮${label}Agent 可能已完成, 但没有生成网页摘要。完整回复见对应 Session。`;
  } else {
    status = "generating";
    reply = "";
  }
  return {
    ok: true,
    status,
    reply,
    run_id: run.id,
    session_id: run.session_id || "",
    session_url: run.session_url || "",
    agent_status: gatewayStatus || run.status || "",
    kind,
    scope_id: scopeId,
    updated_at: run.updated_at || ""
  };
}

async function chatWithAgent(e, t, r) {
  if (t.sync !== true && t.wait !== true) return startAsyncAgentChat(e, t, r);
  const kind = txt(t.kind, 10) === "product" ? "product" : "paper";
  const message = txt(t.message, 4000);
  const scopeId = txt(t.scope_id, 120);
  if (!message) throw new Error("message 不能为空");
  // 主渠道在前, 其余作为兜底顺序 (首轮失败自动切)。
  const preferredKey = txt(t.model_key, 200);
  const allProviders = chatProviders();
  if (!allProviders.length) throw new Error("没有可用的 AI 渠道 (检查 model-access.json)");
  const providers = preferredKey
    ? [...allProviders.filter(p => p.key === preferredKey || p.name === preferredKey), ...allProviders.filter(p => p.key !== preferredKey && p.name !== preferredKey)]
    : allProviders;
  const provider = providers[0];
  const run = latestAgentRun(e, kind);
  if (!run) throw new Error(`暂无 ${kind} 的 AI Agent run, 请先跑一次 ai_scan_${kind === "product" ? "products" : "arxiv"}`);
  const priorMessages = getAgentMessages(e, { run_id: run.id }).filter(m => m.role === "user" || m.role === "assistant").map(m => ({
    role: m.role,
    content: m.content
  })).slice(-20);
  let injection = "";
  if (scopeId) {
    const alreadyMentioned = priorMessages.some(m => String(m.content).includes(scopeId));
    if (!alreadyMentioned) {
      const item = kind === "paper" ? e.prepare("SELECT * FROM arxiv_items WHERE id=? OR source_id=?").get(scopeId, scopeId) : e.prepare("SELECT * FROM product_research WHERE id=?").get(scopeId);
      if (item) injection = (kind === "paper" ? buildPaperContext(item) : buildProductContext(item)) + "\n\n";
    }
  }
  const userTurn = injection + (scopeId ? `用户在 ${kind === "paper" ? "论文" : "竞品"} ${scopeId} 上追问: ` : "用户追问: ") + message;
  appendAgentMessage(e, { runId: run.id, role: "user", content: userTurn, toolCalls: "" });
  // 追问只针对具体 scope, 不再注入 24k 全量 memory (降 input token + 首 token 延迟, 减少 30s 超时)。
  const systemPrompt = buildScanSystemPrompt({ kind }) + "\n\n你现在正在和用户对话, 之前已经扫描过若干" + (kind === "paper" ? "论文" : "竞品") + ", 直接基于已有上下文回答, 不要再输出 JSON 启发格式, 用自然中文回答。如需确认莫比乌斯代码现状可调用 read_file 工具, 但简单问题不要为了读代码而读代码。\n\n## 启发管理工具\n除了 read_file, 你还拥有 update_inspiration / add_inspiration / delete_inspiration 三个工具, 用来在用户要求修改当前 " + (kind === "paper" ? "论文" : "竞品") + " 的 ai_inspiration 启发时直接落到数据库, 而不只是口头描述。工具入参 schema 已经给出, scope_id 必须用 `" + (scopeId || "") + "` (即当前对话上下文), 跨 scope 会被拒绝。用户如果说\"把第 N 条优先级改成 medium\"/\"加一条新启发: xxx\"/\"删掉第 N 条\", 你应该直接调用对应工具而不是只回复文字。调用后请用一句话告诉用户你做了什么。";
  const conversationMessages = priorMessages.concat([{ role: "user", content: userTurn }]);
  try {
    const resp = await callAgentWithFallback({
      providers,
      system: systemPrompt,
      messages: conversationMessages,
      tools: [READ_FILE_TOOL, UPDATE_INSPIRATION_TOOL, ADD_INSPIRATION_TOOL, DELETE_INSPIRATION_TOOL],
      maxTokens: 2000,
      maxRounds: 3,
      toolContext: { db: e, scopeId: scopeId || "" },
      roundTimeoutMs: 2e4
    });
    const text = extractAgentText(resp.content);
    const toolUseBlocks = (resp.content || []).filter(b => b && b.type === "tool_use");
    const allToolUseBlocks = [];
    for (const m of (resp.messages || [])) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const b of m.content) if (b && b.type === "tool_use") allToolUseBlocks.push(b);
    }
    const toolCallCount = allToolUseBlocks.length || toolUseBlocks.length;
    const inspirationBlocks = allToolUseBlocks.filter(b => ["update_inspiration", "add_inspiration", "delete_inspiration"].includes(b.name));
    const inspirationOps = inspirationBlocks
      .map(b => {
        const result = resp.toolResultsById?.get(b.id);
        const input = b.input || {};
        const title = result && (result.after?.title || result.item?.title || result.removed?.title) || input.title || input.match || "";
        const priority = result && (result.after?.priority || result.item?.priority) || input.priority || "";
        return { action: b.name, title, priority, ok: !!(result && result.ok), error: result?.error || "", result };
      });
    appendAgentMessage(e, { runId: run.id, role: "assistant", content: text, toolCalls: String(toolCallCount) });
    e.prepare("UPDATE agent_runs SET updated_at=? WHERE id=?").run(now(), run.id);
    return {
      ok: true,
      run_id: run.id,
      kind,
      scope_id: scopeId,
      reply: text,
      model: provider.model,
      provider: provider.label,
      tokens: { input: resp.usage.input_tokens || 0, output: resp.usage.output_tokens || 0 },
      tool_calls: toolCallCount,
      context_messages: priorMessages.length,
      inspiration_changed: inspirationOps.some(op => op.ok),
      inspiration_diff: inspirationOps
    };
  } catch (err) {
    appendAgentMessage(e, { runId: run.id, role: "assistant", content: `错误: ${err.message}` });
    throw err;
  }
}

async function exportAgentPrompt(e, t, r) {
  const runId = txt(t.run_id, 120);
  const run = runId ? e.prepare("SELECT * FROM agent_runs WHERE id=?").get(runId) : latestAgentRun(e, txt(t.kind, 10) === "product" ? "product" : "paper");
  if (!run) throw new Error("未找到 agent run");
  const provider = findProvider(txt(t.model_key, 200));
  const history = getAgentMessages(e, { run_id: run.id }).map(m => ({ role: m.role, content: m.content })).slice(-30);
  const summarizerSystem = [
    "你是莫比乌斯自进化助手的总结 Agent。",
    "用户和 L2 Agent 聊过之后, 你需要把达成的共识转成一段详细的执行指令, 让另一个执行 Agent (小莫) 可以照着做。",
    "",
    "## 输出要求",
    "- 用第二人称描述 (\"你需要...\"), 假设小莫是执行者",
    "- 含具体目标、文件范围、验收标准、禁止事项",
    "- 不要含代码片段, 但要含文件路径和模块名",
    "- 用 markdown 格式, 标题 \"## 执行指令\"",
    "- 长度控制在 400-1200 字"
  ].join("\n");
  const memContext = buildMobiusMemoryContext();
  const userTurn = [
    "下面是用户和 L2 Agent 关于 " + run.kind + " 的对话历史。请提炼出执行指令。",
    "",
    "## 莫比乌斯 Memory (供你确认现状)",
    memContext,
    "",
    "## 对话历史",
    JSON.stringify(history, null, 2)
  ].join("\n");
  try {
    const resp = await callAnthropicMessages({
      provider,
      system: summarizerSystem,
      messages: [{ role: "user", content: userTurn }],
      tools: [READ_FILE_TOOL],
      maxTokens: 2500,
      maxRounds: 5
    });
    const text = extractAgentText(resp.content) || "(Agent 未输出可执行的指令)";
    e.prepare("UPDATE agent_runs SET prompt_for_xiaomo=?,updated_at=? WHERE id=?").run(txt(text, 2e5), now(), run.id);
    return {
      ok: true,
      run_id: run.id,
      kind: run.kind,
      prompt: text,
      model: provider.model,
      provider: provider.label
    };
  } catch (err) {
    throw new Error(`导出执行指令失败: ${err.message}`);
  }
}

async function chatWithPaper(e, t, r) {
  const a = txt(t.paper_id || t.product_id || t.id, 120), s = txt(t.message, 1600);
  if (!a) throw new Error("paper_id 或 product_id 不能为空");
  if (!s) throw new Error("message 不能为空");
  const o = t.product_id || "product" === txt(t.item_type, 20), n = o ? chatItemRow("product", e.prepare("SELECT * FROM product_research WHERE id=?").get(a)) : chatItemRow("paper", e.prepare("SELECT * FROM arxiv_items WHERE id=? OR source_id=?").get(a, a));
  if (!n) throw new Error(o ? "product_id 不存在" : "paper_id 不存在");
  const i = chatPrompt(n, o ? "product" : "paper", s, Array.isArray(t.history) ? t.history : []);
  const c = chatProviders();
  if (!c.length) throw new Error("AI 暂不可用，请稍后再试");
  const l = [];
  for (const t of c) try {
    const r = "responses" === t.type ? await callResponsesModel(t, i) : await callChatCompletionModel(t, i);
    if (r) return {
      reply: r,
      model: t.model,
      provider: t.name
    };
  } catch (e) {
    l.push(`${t.name}: ${txt(e.message, 160)}`);
  }
  throw new Error(`AI 暂不可用，请稍后再试${l.length ? `（${l[0]}）` : ""}`);
}

async function firstScan(e, t, r) {
  if ("done" === e.prepare("SELECT value FROM install_state WHERE key=?").get(FIRST_SCAN_KEY)?.value) return null;
  const a = Date.now(), s = await scanArxiv(e, {
    max_results: 100
  }, r), o = await scanProducts(e, r);
  return e.prepare("INSERT INTO install_state VALUES (?,'done',?) ON CONFLICT(key) DO UPDATE SET value='done',updated_at=excluded.updated_at").run(FIRST_SCAN_KEY, now()),
  syncSchedules(t, r), {
    arxiv: s,
    products: o,
    elapsed_ms: Date.now() - a
  };
}

function shouldAutoDeepRead(e) {
  return !!(e?.auto_ai_read || e?.scheduled_daily_scan || e?.deep_read_after_scan);
}

async function autoDeepReadAfterScan(e, kind, ids, t, r) {
  if (!shouldAutoDeepRead(t)) return null;
  const cleanIds = [ ...new Set((Array.isArray(ids) ? ids : []).map(e => txt(e, 120)).filter(Boolean)) ];
  const includeBacklog = !1 !== t.deep_read_backlog;
  const backlogLimit = includeBacklog ? int(t.ai_backlog_limit ?? t.backlog_limit, 1000, 0, 1000) : 0;
  const payload = {
    model_key: t.model_key,
    ids: cleanIds,
    limit: cleanIds.length || Math.max(1, backlogLimit),
    deep_read_backlog: includeBacklog,
    backlog_limit: backlogLimit
  };
  try {
    const result = "product" === kind ? await aiScanProducts(e, payload, r) : await aiScanArxiv(e, payload, r);
    return {
      ok: !0,
      kind,
      requested_ids: cleanIds.length,
      backlog_limit: backlogLimit,
      ...result
    };
  } catch (err) {
    return {
      ok: !1,
      kind,
      requested_ids: cleanIds.length,
      backlog_limit: backlogLimit,
      error: txt(err.message, 500)
    };
  }
}

async function dispatch(e, t, r, a) {
  const s = txt(t.action || "bootstrap", 64);
  if (syncSchedules(a, r), "bootstrap" === s) {
    let s = null;
    if (!0 !== t.skip_first_scan) try {
      s = await firstScan(e, a, r);
    } catch (e) {
      s = {
        ok: !1,
        error: e.message
      };
    }
    return {
      ok: !0,
      first_scan: s,
      summary: summary(e),
      keywords: keywords(e),
      competitors: groupedProducts(e),
      source_reviews: listSourceReviews(e),
      inspiration_decisions: listInspirationDecisions(e, { status: "accepted,queued_one_click,queued_plan,deferred" }),
      arxiv: listPapers(e, t),
      products: listProducts(e),
      scan_runs: scans(e),
      constants: {
        retained_actions: [ "bootstrap", "list_arxiv_items", "get_paper", "mark_paper", "mark_paper_read", "export_papers", "scan_arxiv", "submit_feedback", "chat_with_paper", "get_paper_clusters", "get_top_picks", "get_papers_by_cluster", "list_product_items", "get_product", "mark_product", "mark_product_read", "export_products", "scan_product_url", "get_keywords", "update_keywords", "get_competitors", "update_competitors", "list_scan_runs", "get_evolution_feed", "promote_L2_to_L1", "seed_evolution_from_git", "get_L3_placeholder", "get_evolution_stats", "list_ai_channels", "ai_scan_arxiv", "ai_scan_products", "discover_competitors_via_agent", "chat_with_agent", "chat_status", "rewrite_inspiration_style", "export_agent_prompt", "list_agent_runs", "get_agent_messages", "set_source_review", "list_source_reviews", "decide_inspiration", "list_l2_inspirations", "implement_l2_inspiration", "update_l2_inspiration_status" ],
        schedule_ids: SCHEDULE_IDS,
        daily_scan_time: "17:00",
        daily_scan_timezone: "UTC",
        daily_interval_minutes: DAILY_SCAN_INTERVAL_MINUTES,
        product_table: "product_research",
        product_statuses: [ "tracked", "candidate", "archived" ]
      }
    };
  }
  if ("scan_arxiv" === s) {
    const scan = await scanArxiv(e, t, r);
    const autoAi = await autoDeepReadAfterScan(e, "paper", scan.new_ids || [], t, r);
    const autoProductAi = (scan.discovered_product_ids || []).length ? await autoDeepReadAfterScan(e, "product", scan.discovered_product_ids || [], {
      ...t,
      deep_read_backlog: !1
    }, r) : null;
    const postActions = pullPostActions(autoAi, autoProductAi);
    return {
      ok: !0,
      scan,
      auto_ai: autoAi,
      auto_product_ai: autoProductAi,
      summary: summary(e),
      arxiv: listPapers(e, t),
      scan_runs: scans(e),
      ...(postActions.length ? { __mobius_post_actions: postActions } : {})
    };
  }
  if ("scan_product_url" === s) {
    const productScan = await scanProductAction(e, t, r);
    const autoAi = await autoDeepReadAfterScan(e, "product", productScan.touched_ids || [], t, r);
    const postActions = pullPostActions(autoAi);
    return {
      ok: !0,
      product_scan: productScan,
      auto_ai: autoAi,
      competitors: groupedProducts(e),
      products: listProducts(e),
      scan_runs: scans(e),
      summary: summary(e),
      ...(postActions.length ? { __mobius_post_actions: postActions } : {})
    };
  }
  if ("submit_feedback" === s) return {
    ok: !0,
    keyword_weights: submitFeedback(e, t)
  };
  if ("chat_with_paper" === s) return {
    ok: !0,
    ...await chatWithPaper(e, t, r)
  };
  if ("list_ai_channels" === s) return {
    ok: !0,
    channels: chatProviders().map(p => ({
      key: p.key,
      label: p.label,
      model: p.model,
      type: p.type,
      is_default: p === chatProviders()[0]
    })),
    default_key: chatProviders()[0]?.key || null
  };
  if ("ai_scan_arxiv" === s) return {
    ok: !0,
    ...(await aiScanArxiv(e, t, r))
  };
  if ("ai_scan_products" === s) return {
    ok: !0,
    ...(await aiScanProducts(e, t, r))
  };
  if ("discover_competitors_via_agent" === s) return {
    ok: !0,
    ...(await discoverCompetitorsViaAgent(e, t, r))
  };
  if ("chat_with_agent" === s) return {
    ok: !0,
    ...(await chatWithAgent(e, t, r))
  };
  if ("chat_status" === s) return {
    ok: !0,
    ...chatStatus(e, t)
  };
  if ("rewrite_inspiration_style" === s) return {
    ok: !0,
    ...(await rewriteInspirationStyle(e, t))
  };
  if ("export_agent_prompt" === s) return {
    ok: !0,
    ...(await exportAgentPrompt(e, t, r))
  };
  if ("list_agent_runs" === s) return {
    ok: !0,
    runs: listAgentRuns(e, t)
  };
  if ("get_agent_messages" === s) return {
    ok: !0,
    messages: getAgentMessages(e, t)
  };
  if ("set_source_review" === s) return {
    ok: !0,
    review: setSourceReview(e, t, r),
    source_reviews: listSourceReviews(e),
    competitors: groupedProducts(e),
    arxiv: listPapers(e, t)
  };
  if ("list_source_reviews" === s) return {
    ok: !0,
    source_reviews: listSourceReviews(e)
  };
  if ("decide_inspiration" === s) return {
    ok: !0,
    decision: upsertInspirationDecision(e, t, r),
    inspiration_decisions: listInspirationDecisions(e, { status: "accepted,queued_one_click,queued_plan,deferred" })
  };
  if ("list_l2_inspirations" === s) return {
    ok: !0,
    items: listInspirationDecisions(e, t)
  };
  if ("implement_l2_inspiration" === s) {
    const impl = implementInspiration(e, t, r);
    return {
      ok: !0,
      ...impl,
      items: listInspirationDecisions(e, { status: "accepted,queued_one_click,queued_plan,deferred" })
    };
  }
  if ("update_l2_inspiration_status" === s) return {
    ok: !0,
    decision: updateInspirationQueueStatus(e, t, r),
    items: listInspirationDecisions(e, { status: "accepted,queued_one_click,queued_plan,deferred" })
  };
  if ("get_paper_clusters" === s) return {
    ok: !0,
    clusters: getPaperClusters(e)
  };
  if ("get_top_picks" === s) return {
    ok: !0,
    items: getTopPicks(e, t)
  };
  if ("get_papers_by_cluster" === s) return {
    ok: !0,
    ...getPapersByCluster(e, t)
  };
  if ("get_evolution_feed" === s) return {
    ok: !0,
    ...getEvolutionFeed(e, t)
  };
  if ("promote_L2_to_L1" === s) return {
    ok: !0,
    ...promoteL2ToL1(e, t, r)
  };
  if ("seed_evolution_from_git" === s) return {
    ok: !0,
    seed: seedEvolutionFromGit(e, t),
    stats: evolutionStats(e),
    feed: getEvolutionFeed(e, {
      level: "L1",
      limit: 20
    })
  };
  if ("get_L3_placeholder" === s) return {
    ok: !0,
    ...getEvolutionFeed(e, {
      level: "L3",
      limit: 10
    })
  };
  if ("get_evolution_stats" === s) return {
    ok: !0,
    stats: evolutionStats(e)
  };
  return "list_arxiv_items" === s || "list_papers" === s ? {
    ok: !0,
    ...listPapers(e, t)
  } : "list_product_items" === s || "list_products" === s ? {
    ok: !0,
    ...listProducts(e, t)
  } : "get_paper" === s ? (() => {
    const row = e.prepare("SELECT * FROM arxiv_items WHERE id=? OR source_id=?").get(txt(t.id, 120), txt(t.id, 120)) || null;
    if (row) markPaperRead(e, row.id, !0);
    const fresh = row ? e.prepare("SELECT * FROM arxiv_items WHERE id=?").get(row.id) : null;
    return { ok: !0, item: paperOut(fresh) };
  })() : "get_product" === s ? (() => {
    const row = e.prepare("SELECT * FROM product_research WHERE id=?").get(txt(t.id, 120)) || null;
    if (row) markProductRead(e, row.id, !0);
    const fresh = row ? e.prepare("SELECT * FROM product_research WHERE id=?").get(row.id) : null;
    return { ok: !0, item: prodRow(fresh) };
  })() : "mark_paper_read" === s ? (() => {
    const row = e.prepare("SELECT id FROM arxiv_items WHERE id=? OR source_id=?").get(txt(t.id, 120), txt(t.id, 120));
    if (!row) return { ok: !1, error: "未找到论文" };
    markPaperRead(e, row.id, !1 !== t.read);
    return { ok: !0, item: paperOut(e.prepare("SELECT * FROM arxiv_items WHERE id=?").get(row.id)) };
  })() : "mark_product_read" === s ? (() => {
    const row = e.prepare("SELECT id FROM product_research WHERE id=?").get(txt(t.id, 120));
    if (!row) return { ok: !1, error: "未找到产品" };
    markProductRead(e, row.id, !1 !== t.read);
    return { ok: !0, item: prodRow(e.prepare("SELECT * FROM product_research WHERE id=?").get(row.id)) };
  })() : "mark_paper" === s ? (e.prepare("UPDATE arxiv_items SET mark=?,note=?,updated_at=? WHERE id=?").run(txt(t.mark, 40), long(t.note, 3e3), now(), txt(t.id, 120)),
  {
    ok: !0
  }) : "mark_product" === s ? {
    ok: !0,
    competitors: updateProduct(e, {
      ...t,
      mode: "mark"
    }, r)
  } : "export_papers" === s ? {
    ok: !0,
    data: {
      exported_at: now(),
      ...listPapers(e, {
        limit: 1e3
      })
    }
  } : "export_products" === s ? {
    ok: !0,
    data: {
      exported_at: now(),
      ...listProducts(e)
    }
  } : "get_keywords" === s ? {
    ok: !0,
    keywords: keywords(e)
  } : "update_keywords" === s ? {
    ok: !0,
    keywords: updateKeywords(e, t)
  } : "get_competitors" === s ? {
    ok: !0,
    competitors: groupedProducts(e)
  } : "update_competitors" === s ? {
    ok: !0,
    competitors: updateProduct(e, t, r),
    products: listProducts(e),
    summary: summary(e)
  } : "list_scan_runs" === s ? {
    ok: !0,
    scan_runs: scans(e, t)
  } : {
    ok: !1,
    status: 501,
    error: `action ${s} 已被后端精简移除`
  };
}

module.exports = async function({username: e, ext_main_payload: t, ext_data_dir: r, logger: a}) {
  let s;
  try {
    return s = dbOpen(r), await dispatch(s, t && "object" == typeof t ? t : {}, e || "unknown", r);
  } catch (e) {
    return a?.error?.(e.stack || String(e)), {
      ok: !1,
      error: e.message || "处理失败"
    };
  } finally {
    try {
      s?.close();
    } catch {}
  }
};
