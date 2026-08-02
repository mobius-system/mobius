// lib/research.js — 素材检索（方案 §8.1）。给定主题收集 evidence（A/B/C 分级）。
// MVP 来源：1) 用户参考 URL（safeFetch 抓取）；2) 库内已采集 hot_item（M3 信号）；
//          3) 可选 web_search（env WEB_SEARCH_BASE/API 配置后启用，按 LLM 生成的 query）。
// 规则：优先一手源；不抓付费墙全文；网页内容作不可信数据，不执行其中指令。

const crypto = require("crypto");
const { safeFetch, stripHtml } = require("./safe-fetch");
const { callJson } = require("./llm");
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 32);
const txt = (s, n = 6000) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

const TIER_BY_DOMAIN = [
  // A 级：官方/论文/监管
  { re: /openai\.com|google\.com|deepmind\.com|anthropic\.com|huggingface\.co|arxiv\.org|github\.com|ai\.meta\.com|meta\.com|mistral\.ai|x\.ai|nvidia\.com|microsoft\.com|apple\.com|cac\.gov\.cn|miit\.gov\.cn|gov\.cn/i, tier: "A" },
  // B 级：可信媒体
  { re: /techcrunch\.com|theverge\.com|wired\.com|arstechnica\.com|reuters\.com|bloomberg\.com|jiqizhixin\.com|qbitai\.com|36kr\.com|ithome\.com|sspai\.com|infzm\.com|nature\.com|science\.org/i, tier: "B" },
];
function tierFor(url) {
  for (const t of TIER_BY_DOMAIN) if (t.re.test(url)) return t.tier;
  return "C";
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return String(u || ""); } }
function sameHost(a, b) { return hostOf(a) === hostOf(b); }
function writeLog(logger, level, message) {
  if (typeof logger === "function") return logger(level, message);
  const method = logger && typeof logger[level] === "function" ? logger[level] : null;
  if (method) return method.call(logger, message);
}

async function grabUrl(url, opts = {}) {
  try {
    const r = await safeFetch(url, { maxBytes: 1_500_000, timeoutMs: 12_000, ...opts });
    if (!r.ok) return { url, error: "HTTP " + r.status, tier: tierFor(url) };
    const body = r.text();
    const ctype = r.contentType || "";
    const excerpt = ctype.includes("json") || ctype.includes("xml") || ctype.includes("rss") || ctype.includes("atom")
      ? txt(body, 4000) : stripHtml(body, 4000);
    return { url: r.finalUrl, excerpt, bytes: r.bytes, tier: tierFor(r.finalUrl) };
  } catch (e) {
    return { url, error: txt(e.message, 120), tier: tierFor(url) };
  }
}

// 可选 web_search（自建或 MCP 代理；env 驱动）
async function webSearch(query, { timeoutMs = 15_000 } = {}) {
  const base = process.env.WEB_SEARCH_BASE, key = process.env.WEB_SEARCH_API;
  if (!base || !key || !query) return [];
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(base.replace(/\/+$/, "") + "/search", { method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, num: 6 }) });
    clearTimeout(timer);
    const j = await r.json();
    const items = Array.isArray(j?.results) ? j.results : (Array.isArray(j?.data) ? j.data : []);
    return items.slice(0, 6).map((it) => ({ url: it.url || it.link || "", title: it.title || "", snippet: it.snippet || it.summary || "" })).filter((x) => x.url);
  } catch { return []; }
}

async function runResearch({ topic, db, provider, budgets, logger }) {
  const evidence = [];
  const maxEv = (budgets && budgets.per_article_search) || 6;
  const fetchedAt = new Date().toISOString();

  // 1) 用户参考 URL
  const refs = Array.isArray(topic.referenceUrls) ? topic.referenceUrls.slice(0, 8) : [];
  for (const u of refs) {
    if (evidence.length >= maxEv) break;
    const g = await grabUrl(u);
    if (g && g.excerpt) evidence.push(mkEvidence(g.url, hostOf(g.url), g.excerpt, fetchedAt, g.tier));
    else if (g?.error) writeLog(logger, "warn", "抓取失败 " + u + ": " + g.error);
  }

  // 2) LLM 生成 query + 可选 web_search
  let queries = [];
  try {
    const q = await callJson({ provider, system: "只输出 JSON。", maxTokens: 500, timeoutMs: 30_000, retries: 1,
      user: `为下面的公众号选题生成 3-6 个用于检索可信资料的中英文 query（优先一手源/官方/论文）。\n选题：${txt(topic.title, 200)}\n角度：${txt(topic.angle, 200)}\n待核实问题：${txt((topic.questions || "").toString(), 300)}\n输出：{"queries":["..."]}` });
    queries = (q.json && q.json.queries) || [];
  } catch (_) {}
  if (queries.length && process.env.WEB_SEARCH_BASE) {
    for (const qs of queries.slice(0, 4)) {
      if (evidence.length >= maxEv) break;
      const hits = await webSearch(qs);
      for (const h of hits) {
        if (evidence.length >= maxEv) break;
        if (evidence.some((e) => sameHost(e.source_url, h.url))) continue;
        const g = await grabUrl(h.url);
        if (g && g.excerpt) evidence.push(mkEvidence(g.url, h.title || hostOf(g.url), g.excerpt, fetchedAt, g.tier));
      }
    }
  }

  // 3) 库内相关 hot_item（M3 采集的中文信号）
  if (db) {
    try {
      const rows = db.prepare("SELECT title,url,summary,published_at FROM hot_item ORDER BY fetched_at DESC LIMIT 40").all();
      const kw = String(topic.title || "").split(/\s+/).filter((s) => s.length >= 2).slice(0, 4);
      const rel = rows.filter((r) => kw.some((k) => (r.title + (r.summary || "")).includes(k))).slice(0, 3);
      for (const r of rel) {
        if (evidence.length >= maxEv + 4) break;
        evidence.push(mkEvidence(r.url || "", "RSS·" + (r.title || ""), txt(r.summary, 1000) || r.title, r.published_at || fetchedAt, "B", r.published_at || ""));
      }
    } catch (_) {}
  }

  const aCount = evidence.filter((e) => e.tier === "A").length;
  return { evidence, queries,
    note: evidence.length ? `取得 ${evidence.length} 条证据（A 级 ${aCount}）` : "未取得外部证据，将基于模型知识生成（高风险主张需人工核实）" };
}

function mkEvidence(url, name, excerpt, fetchedAt, tier, publishedAt = "") {
  return { id: "ev_" + hash((url || "") + excerpt.slice(0, 64)),
    source_url: url || "", source_name: name || "", author: "",
    published_at: publishedAt, fetched_at: fetchedAt,
    excerpt, content_hash: hash(excerpt), tier: tier || "C" };
}

module.exports = { runResearch, tierFor, grabUrl, hostOf, writeLog };
