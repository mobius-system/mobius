const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto"), { execFileSync } = require("child_process"), Database = require("better-sqlite3"), DB_FILE = "self-cognition.db", FIRST_SCAN_KEY = "first_scan_v4", REPO_ROOT = path.resolve(__dirname, "../../../.."), EXT_PATH = "mobius/extension/self-cognition", PROJECTS = {
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

function url(e) {
  const t = new URL(txt(e, 800));
  if (!/^https?:$/.test(t.protocol)) throw new Error("source_url 必须是 http(s) URL");
  return t.hash = "", t.toString();
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
  for (const [t, r, a] of [ [ "arxiv_items", "mark", "TEXT NOT NULL DEFAULT ''" ], [ "arxiv_items", "note", "TEXT NOT NULL DEFAULT ''" ], [ "arxiv_items", "cluster_label", "TEXT NOT NULL DEFAULT ''" ], [ "arxiv_items", "priority_score", "REAL NOT NULL DEFAULT 0" ], [ "arxiv_items", "cluster_keywords", "TEXT NOT NULL DEFAULT '[]'" ], [ "arxiv_items", "citations", "INTEGER NOT NULL DEFAULT 0" ], [ "arxiv_items", "ai_inspiration", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "normalized_url", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "aliases", "TEXT NOT NULL DEFAULT '[]'" ], [ "product_research", "reason", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "discovery_logic", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "discovered_from_url", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "mark", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "note", "TEXT NOT NULL DEFAULT ''" ], [ "product_research", "last_scanned_at", "TEXT" ], [ "product_research", "auto_discovered", "INTEGER NOT NULL DEFAULT 0" ], [ "product_research", "ai_inspiration", "TEXT NOT NULL DEFAULT ''" ], [ "scan_runs", "scan_type", "TEXT NOT NULL DEFAULT 'arxiv'" ], [ "scan_runs", "source_url", "TEXT NOT NULL DEFAULT ''" ], [ "scan_runs", "updated", "INTEGER NOT NULL DEFAULT 0" ], [ "scan_runs", "candidates_added", "INTEGER NOT NULL DEFAULT 0" ] ]) e.prepare(`PRAGMA table_info(${t})`).all().some(e => e.name === r) || e.exec(`ALTER TABLE ${t} ADD COLUMN ${r} ${a}`);
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
  })), seedL3Placeholders(e);
}

function evolutionRow(e) {
  return e ? {
    ...e,
    files_changed: arr(e.files_changed)
  } : null;
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
    summary: txt(t.summary, 300) || "自进化事件",
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
      const [r, o, c, d, ...i] = t.split("|"), u = i.join("|"), l = gitFiles(s.repo, s.pathspec, r), p = insertEvolutionEvent(e, {
        id: id("evo_l1_git", `${s.id}:${r}`),
        level: "L1",
        source: "git_commit",
        status: "merged",
        project_id: s.id,
        commit_sha: r,
        summary: txt(u, 300) || `Git commit ${r.slice(0, 8)}`,
        diff_summary: gitDiffSummary(s.repo, s.pathspec, r, l),
        files_changed: l,
        proposed_by: txt(`${o} <${c}>`, 180),
        approved_by: "git",
        approved_at: new Date(1e3 * Number(d)).toISOString(),
        created_at: new Date(1e3 * Number(d)).toISOString()
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

function nextAt(e) {
  const t = new Date;
  return t.setUTCHours(e, 0, 0, 0), t <= new Date && t.setUTCDate(t.getUTCDate() + 1),
  t.toISOString();
}

function syncSchedules(e, t) {
  const r = [ [ "self-cognition-arxiv-0900", 9, {
    action: "scan_arxiv",
    scheduled_daily_scan: !0,
    max_results: 100
  } ], [ "self-cognition-products-1000", 10, {
    action: "scan_product_url",
    all_tracked: !0,
    discover: !0
  } ], [ "self-cognition-evolution-1100", 11, {
    action: "seed_evolution_from_git"
  } ] ], a = path.join(e, "schedules");
  fs.mkdirSync(a, {
    recursive: !0
  });
  for (const [e, s, o] of r) {
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
      interval_minutes: 1440,
      next_run_at: c.next_run_at || nextAt(s),
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
  const u = Math.min(100, 20 * Math.max(1, i.length)), l = i.length ? i.reduce((e, t) => e + (r[t] || 1), 0) / i.length : 1, p = e.published_at ? Math.max(.05, Math.pow(.5, Math.max(0, (Date.now() - Date.parse(e.published_at)) / 864e5) / 7)) : 1, m = Number(e.citations || 0), h = m > 0 ? Math.log(1 + m) / Math.log(101) : 1;
  return {
    matched: o,
    relevance: 10 * o.length + (e.published_at ? Math.max(0, 5 - Math.floor((Date.now() - Date.parse(e.published_at)) / 31536e6)) : 0),
    cluster_label: n[1] > 0 ? n[0] : "other",
    cluster_keywords: i,
    priority_score: Math.max(0, Math.min(100, u * l * p * h))
  };
}

async function scanArxiv(e, t, r) {
  const a = txt(t.query, 1500) || kwQuery(e), s = int(t.max_results, 100, 1, 500), o = id("scan", `${Date.now()}${Math.random()}`), c = now();
  let n = 0, d = 0, i = 0;
  const g = [];
  try {
    const p = recalcKeywordWeights(e), t = parseArxiv(await fetchText(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(a)}&start=0&max_results=${s}&sortBy=relevance&sortOrder=descending`, 22e3)), u = rows(e, "paper"), l = e.prepare("INSERT INTO arxiv_items (id,title,source_url,source_id,authors,published_at,updated_arxiv_at,abstract,tags,matched_keywords,relevance,cluster_label,priority_score,cluster_keywords,fetched_at,created_by,created_at,updated_at) VALUES (@id,@title,@source_url,@source_id,@authors,@published_at,@updated_arxiv_at,@abstract,@tags,@matched_keywords,@relevance,@cluster_label,@priority_score,@cluster_keywords,@fetched_at,@created_by,@created_at,@updated_at) ON CONFLICT(source_id) DO UPDATE SET title=excluded.title,source_url=excluded.source_url,authors=excluded.authors,published_at=excluded.published_at,updated_arxiv_at=excluded.updated_arxiv_at,abstract=excluded.abstract,tags=excluded.tags,matched_keywords=excluded.matched_keywords,relevance=excluded.relevance,cluster_label=excluded.cluster_label,priority_score=excluded.priority_score,cluster_keywords=excluded.cluster_keywords,fetched_at=excluded.fetched_at,updated_at=excluded.updated_at");
    return e.transaction(() => t.forEach(t => {
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
    }))(), i = discoverFromCorpus(e), n > 5 && addL2Event(e, {
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
      new_count: g.length
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
    status: "tracked" === e.status ? "official" : e.status,
    tracked_status: e.status,
    relevance: Number(e.relevance) || 0,
    tags: arr(e.tags),
    aliases: arr(e.aliases),
    auto_discovered: !!e.auto_discovered
  } : null;
}

function upsertProduct(e, t) {
  const r = url(t.source_url), a = now(), s = e.prepare("SELECT id,status FROM product_research WHERE normalized_url=?").get(r), o = {
    id: s?.id || t.id || id("product", r),
    name: txt(t.name, 180) || new URL(r).hostname.replace(/^www\./, ""),
    source_url: r,
    normalized_url: r,
    status: "tracked" === s?.status ? "tracked" : status(t.status),
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

function discoverLinks(e, t, r) {
  const a = `${t.title}\n${t.description}\n${t.visible}\n${t.links.map(e => `${e.text} ${e.href}`).join("\n")}`.toLowerCase();
  let s = 0;
  for (const t of CATALOG) t[3].some(e => a.includes(e.toLowerCase())) && (s += upsertProduct(e, {
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
  }).created ? 1 : 0);
  for (const a of t.links) try {
    const t = new URL(a.href);
    if (t.hostname === new URL(r).hostname) continue;
    const o = rel(`${a.text} ${a.href}`);
    o.score >= 3 && (s += upsertProduct(e, {
      name: a.text || t.hostname,
      source_url: t.origin + "/",
      status: "candidate",
      category: cat(`${a.text} ${a.href}`),
      relevance: Math.min(10, o.score + 2),
      tags: [ "自动发现", "外链线索", ...o.matched ],
      reason: `扫描 ${r} 时发现相关外链 ${t.hostname}`,
      discovery_logic: "outbound_link_keyword_score>=3",
      discovered_from_url: r,
      auto_discovered: !0,
      created_by: "system"
    }).created ? 1 : 0);
  } catch {}
  return s;
}

function discoverFromCorpus(e) {
  const t = e.prepare("SELECT title,abstract,tags FROM arxiv_items ORDER BY updated_at DESC LIMIT 300").all(), r = e.prepare("SELECT name,tags,aliases,category FROM product_research").all(), a = [ ...t.map(e => `${e.title} ${e.abstract} ${e.tags}`), ...r.map(e => `${e.name} ${e.tags} ${e.aliases} ${e.category}`) ].join("\n").toLowerCase();
  let s = 0;
  for (const t of CATALOG) {
    const r = t[3].filter(e => a.includes(e.toLowerCase())).length;
    r && (s += upsertProduct(e, {
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
    }).created ? 1 : 0);
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
    }), u = discoverLinks(e, c, a) + discoverFromCorpus(e);
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
      touched_ids: i.item?.id ? [ i.item.id ] : []
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
    const a = await scanProducts(e, r), s = discoverFromCorpus(e);
    s > 0 && addL2Event(e, {
      source: "auto_scan",
      summary: `发现新候选竞品 ${s} 条`,
      diff_summary: `全量竞品扫描后从论文/产品语料中新增 ${s} 条候选竞品线索`,
      files_changed: [ "product_research", "scan_runs" ],
      proposed_by: r
    });
    const touched = [ ...new Set(a.flatMap(p => p.touched_ids || []).filter(Boolean)) ];
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
      priority_score: Number(e.priority_score) || 0
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
    priority_score: Number(e.priority_score) || 0
  } : null;
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

const READ_FILE_TOOL = {
  name: "read_file",
  description: "读取莫比乌斯项目仓库内的代码 / memory / 文档文件。path 必须是相对仓库根 (例如 mobius/extension/self-cognition/backend/self_cognition_core.js) 或 .imac/ / .deploy_data/ 开头的绝对相对路径。单次最多返回 8000 字符。",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对仓库根的路径" }
    },
    required: ["path"]
  }
};

function resolveRepoPath(p) {
  const cleaned = txt(p, 400).replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("..")) return null;
  const candidates = [
    path.join(REPO_ROOT, cleaned),
    path.join(REPO_ROOT, ".imac", cleaned),
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

function buildMobiusMemoryContext() {
  const parts = [];
  const pkFile = path.join(REPO_ROOT, ".imac/project_knowledge.md");
  try { parts.push("# 莫比乌斯项目知识 (.imac/project_knowledge.md)\n" + fs.readFileSync(pkFile, "utf8")); } catch {}
  const memIdx = path.join(os.homedir(), ".claude/projects/-home-user-imac-test/memory/MEMORY.md");
  try { parts.push("# Agent 长期 memory 索引 (~/.claude/.../memory/MEMORY.md)\n" + fs.readFileSync(memIdx, "utf8")); } catch {}
  return parts.join("\n\n---\n\n").slice(0, 24000);
}

async function callAnthropicMessages({ provider, system, messages, tools, maxTokens = 4096, maxRounds = 8 }) {
  const url = provider.baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const allMessages = [...messages];
  let totalInput = 0, totalOutput = 0;
  for (let round = 0; round < maxRounds; round++) {
    const body = {
      model: provider.model,
      max_tokens: maxTokens,
      system,
      messages: allMessages,
      tools: tools || undefined
    };
    const resp = await fetchJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": provider.authToken,
        "anthropic-version": "2023-06-01",
        Authorization: `Bearer ${provider.authToken}`
      },
      body: JSON.stringify(body)
    }, 9e4);
    if (resp.usage) {
      totalInput += Number(resp.usage.input_tokens || 0);
      totalOutput += Number(resp.usage.output_tokens || 0);
    }
    const content = Array.isArray(resp.content) ? resp.content : [];
    allMessages.push({ role: "assistant", content });
    const toolUseBlocks = content.filter(b => b.type === "tool_use");
    if (resp.stop_reason !== "tool_use" || !toolUseBlocks.length) {
      return { content, stop_reason: resp.stop_reason, usage: { input_tokens: totalInput, output_tokens: totalOutput }, messages: allMessages };
    }
    const toolResults = [];
    for (const tu of toolUseBlocks) {
      const result = tu.name === "read_file" ? handleReadFile(tu.input || {}) : { error: `未知工具 ${tu.name}` };
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 8000) });
    }
    allMessages.push({ role: "user", content: toolResults });
  }
  return { content: [], stop_reason: "max_rounds", usage: { input_tokens: totalInput, output_tokens: totalOutput }, messages: allMessages };
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

function createAgentRun(e, { kind, scopeIds, modelKey, modelLabel, createdBy }) {
  const runId = id("agent_run", `${kind}:${scopeIds.join(",")}:${Date.now()}:${Math.random()}`);
  const stamp = now();
  e.prepare("INSERT INTO agent_runs (id,kind,scope_ids,model_key,model_label,status,summary,prompt_for_xiaomo,token_usage,error,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(runId, kind, JSON.stringify(scopeIds || []), modelKey, modelLabel || "", "running", "", "", "", "", createdBy || "system", stamp, stamp);
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
  const stamp = now();
  const json = JSON.stringify(inspiration);
  if (table === "arxiv_items") {
    if (inspiration && inspiration.length) {
      e.prepare("UPDATE arxiv_items SET ai_inspiration=?,updated_at=? WHERE id=?").run(json, stamp, id);
    } else {
      e.prepare("UPDATE arxiv_items SET ai_inspiration='',mark='excluded',updated_at=? WHERE id=?").run(stamp, id);
    }
  } else if (table === "product_research") {
    if (inspiration && inspiration.length) {
      e.prepare("UPDATE product_research SET ai_inspiration=?,updated_at=? WHERE id=?").run(json, stamp, id);
    } else {
      e.prepare("UPDATE product_research SET ai_inspiration='',mark='excluded',updated_at=? WHERE id=?").run(stamp, id);
    }
  }
}

function buildScanSystemPrompt({ kind }) {
  return [
    "你是莫比乌斯 (Mobius) 自进化插件的 L2 研究 Agent。",
    "目标: 评估给定" + (kind === "paper" ? "arXiv 论文" : "竞品产品") + "对莫比乌斯的真实借鉴价值, 并产出可直接落实到莫比乌斯代码的启发。",
    "",
    "## 莫比乌斯当前状况",
    "莫比乌斯是自进化 Agent 工作台, 把项目/任务单/执行会话串起来; 核心代码在 mobius/, 自我认知插件在 mobius/extension/self-cognition/。",
    "",
    "## 工作流",
    "1. 仔细阅读提供的论文/竞品内容 + 注入的项目 memory",
    "2. 必要时调用 read_file 工具读取莫比乌斯真实代码确认现状",
    "3. 给出 3-5 条对莫比乌斯的借鉴方向, 每条包含: title(简短标签) / direction(方向描述) / mobius_use(具体怎么用到莫比乌斯, 含目标文件或模块) / priority(high|medium|low)",
    "4. 如果该论文/竞品对莫比乌斯毫无借鉴价值, 直接返回空数组 []",
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

async function aiScanArxiv(e, t, r) {
  const modelKey = txt(t.model_key, 200);
  const limit = int(t.limit, 10, 1, 50);
  const provider = findProvider(modelKey);
  const papers = e.prepare("SELECT * FROM arxiv_items WHERE (ai_inspiration IS NULL OR ai_inspiration='' OR ai_inspiration='[]') AND mark!='excluded' ORDER BY priority_score DESC, relevance DESC LIMIT ?").all(limit);
  if (!papers.length) return { ok: true, scanned: 0, results: [], provider: provider.label, model: provider.model };
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
  const limit = int(t.limit, 5, 1, 30);
  const provider = findProvider(modelKey);
  const products = e.prepare("SELECT * FROM product_research WHERE status IN ('tracked','candidate') AND (ai_inspiration IS NULL OR ai_inspiration='' OR ai_inspiration='[]') AND mark!='excluded' ORDER BY CASE status WHEN 'tracked' THEN 1 ELSE 2 END, relevance DESC LIMIT ?").all(limit);
  if (!products.length) return { ok: true, scanned: 0, results: [], provider: provider.label, model: provider.model };
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

async function chatWithAgent(e, t, r) {
  const kind = txt(t.kind, 10) === "product" ? "product" : "paper";
  const message = txt(t.message, 4000);
  const scopeId = txt(t.scope_id, 120);
  if (!message) throw new Error("message 不能为空");
  const provider = findProvider(txt(t.model_key, 200));
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
  const memContext = buildMobiusMemoryContext();
  const systemPrompt = buildScanSystemPrompt({ kind }) + "\n\n## 注入的莫比乌斯 Memory\n\n" + memContext + "\n\n你现在正在和用户对话, 之前已经扫描过若干" + (kind === "paper" ? "论文" : "竞品") + ", 直接基于已有上下文回答, 不要再输出 JSON 启发格式, 用自然中文回答。如果用户问到的内容你之前没扫过, 再调用 read_file 工具或基于已有 memory 回答。";
  const conversationMessages = priorMessages.concat([{ role: "user", content: userTurn }]);
  try {
    const resp = await callAnthropicMessages({
      provider,
      system: systemPrompt,
      messages: conversationMessages,
      tools: [READ_FILE_TOOL],
      maxTokens: 2000,
      maxRounds: 5
    });
    const text = extractAgentText(resp.content);
    const toolCallCount = (resp.content || []).filter(b => b && b.type === "tool_use").length;
    appendAgentMessage(e, { runId: run.id, role: "assistant", content: text, toolCalls: String(toolCallCount) });
    e.prepare("UPDATE agent_runs SET updated_at=? WHERE id=?").run(now(), run.id);
    return {
      ok: true,
      run_id: run.id,
      kind,
      reply: text,
      model: provider.model,
      provider: provider.label,
      tokens: { input: resp.usage.input_tokens || 0, output: resp.usage.output_tokens || 0 },
      tool_calls: toolCallCount,
      context_messages: priorMessages.length
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
      arxiv: listPapers(e, t),
      products: listProducts(e),
      scan_runs: scans(e),
      constants: {
        retained_actions: [ "bootstrap", "list_arxiv_items", "get_paper", "mark_paper", "export_papers", "scan_arxiv", "submit_feedback", "chat_with_paper", "get_paper_clusters", "get_top_picks", "get_papers_by_cluster", "list_product_items", "get_product", "mark_product", "export_products", "scan_product_url", "get_keywords", "update_keywords", "get_competitors", "update_competitors", "list_scan_runs", "get_evolution_feed", "promote_L2_to_L1", "seed_evolution_from_git", "get_L3_placeholder", "get_evolution_stats", "list_ai_channels", "ai_scan_arxiv", "ai_scan_products", "chat_with_agent", "export_agent_prompt", "list_agent_runs", "get_agent_messages" ],
        schedule_ids: [ "self-cognition-arxiv-0900", "self-cognition-products-1000", "self-cognition-evolution-1100" ],
        product_table: "product_research",
        product_statuses: [ "tracked", "candidate", "archived" ]
      }
    };
  }
  if ("scan_arxiv" === s) {
    return {
      ok: !0,
      scan: await scanArxiv(e, t, r),
      summary: summary(e),
      arxiv: listPapers(e, t),
      scan_runs: scans(e)
    };
  }
  if ("scan_product_url" === s) {
    return {
      ok: !0,
      product_scan: await scanProductAction(e, t, r),
      competitors: groupedProducts(e),
      products: listProducts(e),
      scan_runs: scans(e),
      summary: summary(e)
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
  if ("chat_with_agent" === s) return {
    ok: !0,
    ...(await chatWithAgent(e, t, r))
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
  } : "get_paper" === s ? {
    ok: !0,
    item: paperOut(e.prepare("SELECT * FROM arxiv_items WHERE id=? OR source_id=?").get(txt(t.id, 120), txt(t.id, 120)) || null)
  } : "get_product" === s ? {
    ok: !0,
    item: prodRow(e.prepare("SELECT * FROM product_research WHERE id=?").get(txt(t.id, 120)))
  } : "mark_paper" === s ? (e.prepare("UPDATE arxiv_items SET mark=?,note=?,updated_at=? WHERE id=?").run(txt(t.mark, 40), long(t.note, 3e3), now(), txt(t.id, 120)),
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
