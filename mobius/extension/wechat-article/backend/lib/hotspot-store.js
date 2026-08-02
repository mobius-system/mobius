// 热点检索持久层。只接收已由 store.open(ext_data_dir) 打开的 SQLite 连接。
// 搜索执行态仍写 jobs/，这里保存可恢复的检索快照、事件聚类、来源与选题。

const crypto = require("crypto");

const now = () => new Date().toISOString();
const txt = (s, n = 1000) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
const json = (value, fallback = null) => {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};
const makeId = (prefix, seed = "") => `${prefix}_${crypto.createHash("sha1").update(String(seed || now()) + Math.random()).digest("hex").slice(0, 18)}`;

function seedSources(db, sources) {
  const stmt = db.prepare(`INSERT INTO source
    (id,name,kind,url,tier,weight,enabled,success_count,fail_count,consec_fail,last_check,created_at,region,category,updated_at)
    VALUES (@id,@name,@kind,@url,@tier,@weight,1,0,0,0,NULL,@created_at,@region,@category,@updated_at)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,url=excluded.url,tier=excluded.tier,
      weight=excluded.weight,region=excluded.region,category=excluded.category,updated_at=excluded.updated_at`);
  const ts = now();
  const tx = db.transaction((rows) => rows.forEach((s) => stmt.run({ ...s, created_at: ts, updated_at: ts })));
  tx(sources);
}

function listSources(db, { enabledOnly = false } = {}) {
  return db.prepare(`SELECT * FROM source ${enabledOnly ? "WHERE enabled=1" : ""} ORDER BY weight DESC,name`).all();
}

function recordSourceResult(db, sourceId, ok) {
  db.prepare(`UPDATE source SET success_count=success_count+@success,fail_count=fail_count+@fail,
    consec_fail=CASE WHEN @success=1 THEN 0 ELSE consec_fail+1 END,last_check=@ts,updated_at=@ts WHERE id=@id`)
    .run({ id: sourceId, success: ok ? 1 : 0, fail: ok ? 0 : 1, ts: now() });
}

function createSearch(db, spec) {
  const id = spec.id || makeId("hs", `${spec.query}|${spec.window_hours}|${Date.now()}`);
  const ts = now();
  db.prepare(`INSERT INTO hot_search
    (id,query,window_hours,region,categories,status,coverage,result_count,error,created_at,updated_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, txt(spec.query, 200), spec.window_hours || 72,
      txt(spec.region || "all", 20), JSON.stringify(spec.categories || []), "queued", "{}", 0, "", ts, ts,
      new Date(Date.now() + 6 * 3600_000).toISOString());
  return getSearch(db, id);
}

function updateSearch(db, id, patch = {}) {
  const prev = getSearchRaw(db, id);
  if (!prev) return null;
  const next = {
    status: patch.status ?? prev.status,
    coverage: patch.coverage != null ? JSON.stringify(patch.coverage) : prev.coverage,
    result_count: patch.result_count ?? prev.result_count,
    error: patch.error != null ? txt(patch.error, 500) : prev.error,
    completed_at: patch.completed_at ?? prev.completed_at,
    updated_at: now(), id,
  };
  db.prepare(`UPDATE hot_search SET status=@status,coverage=@coverage,result_count=@result_count,error=@error,
    completed_at=@completed_at,updated_at=@updated_at WHERE id=@id`).run(next);
  return getSearch(db, id);
}

function getSearchRaw(db, id) { return db.prepare("SELECT * FROM hot_search WHERE id=?").get(id) || null; }
function hydrateSearch(row) {
  if (!row) return null;
  return { ...row, categories: json(row.categories, []), coverage: json(row.coverage, {}) };
}
function getSearch(db, id) { return hydrateSearch(getSearchRaw(db, id)); }
function latestSearch(db) {
  return hydrateSearch(db.prepare("SELECT * FROM hot_search WHERE status='done' ORDER BY completed_at DESC,updated_at DESC LIMIT 1").get() || null);
}

function upsertItems(db, items) {
  const stmt = db.prepare(`INSERT INTO hot_item
    (id,source_id,title,url,summary,published_at,fetched_at,content_hash,raw_excerpt,created_at,language,official,date_confidence,metadata)
    VALUES (@id,@source_id,@title,@url,@summary,@published_at,@fetched_at,@content_hash,@raw_excerpt,@created_at,@language,@official,@date_confidence,@metadata)
    ON CONFLICT(content_hash) DO UPDATE SET title=excluded.title,url=excluded.url,summary=excluded.summary,
      published_at=COALESCE(excluded.published_at,hot_item.published_at),fetched_at=excluded.fetched_at,
      raw_excerpt=excluded.raw_excerpt,language=excluded.language,official=excluded.official,
      date_confidence=excluded.date_confidence,metadata=excluded.metadata`);
  const tx = db.transaction((rows) => rows.forEach((item) => stmt.run({
    ...item, metadata: JSON.stringify(item.metadata || {}), created_at: item.created_at || now(),
  })));
  tx(items);
}

function replaceClusters(db, searchId, clusters) {
  const old = db.prepare("SELECT cluster_id FROM hot_search_result WHERE search_id=?").all(searchId).map((r) => r.cluster_id);
  const del = db.transaction(() => {
    db.prepare("DELETE FROM hot_search_result WHERE search_id=?").run(searchId);
    if (old.length) {
      const q = old.map(() => "?").join(",");
      db.prepare(`DELETE FROM hot_cluster WHERE id IN (${q})`).run(...old);
    }
  });
  del();
  const insCluster = db.prepare(`INSERT INTO hot_cluster
    (id,canonical_title,entities,item_ids,source_count,spread_speed,cn_heat,account_match,evidence_strength,total_score,risk,created_at,
     search_id,summary,category,first_seen,latest_at,official_count,score_breakdown,status_tags,angles,title_candidates,sources_json,questions,updated_at)
    VALUES (@id,@canonical_title,@entities,@item_ids,@source_count,@spread_speed,@cn_heat,@account_match,@evidence_strength,@total_score,@risk,@created_at,
     @search_id,@summary,@category,@first_seen,@latest_at,@official_count,@score_breakdown,@status_tags,@angles,@title_candidates,@sources_json,@questions,@updated_at)`);
  const insRank = db.prepare("INSERT INTO hot_search_result (search_id,cluster_id,rank) VALUES (?,?,?)");
  const ts = now();
  const tx = db.transaction((rows) => rows.forEach((c, index) => {
    insCluster.run({
      id: c.id, canonical_title: txt(c.title, 300), entities: JSON.stringify(c.entities || []), item_ids: JSON.stringify(c.item_ids || []),
      source_count: c.source_count || 0, spread_speed: c.spread_speed || 0, cn_heat: c.heat_score || 0,
      account_match: c.account_match || 0, evidence_strength: c.evidence_strength || 0, total_score: c.total_score || 0,
      risk: c.risk || "single_source", created_at: ts, search_id: searchId, summary: txt(c.summary, 1200),
      category: txt(c.category || "AI 动态", 80), first_seen: c.first_seen || null, latest_at: c.latest_at || null,
      official_count: c.official_count || 0, score_breakdown: JSON.stringify(c.score_breakdown || {}),
      status_tags: JSON.stringify(c.status_tags || []), angles: JSON.stringify(c.angles || []),
      title_candidates: JSON.stringify(c.title_candidates || []), sources_json: JSON.stringify(c.sources || []),
      questions: JSON.stringify(c.questions || []), updated_at: ts,
    });
    insRank.run(searchId, c.id, index + 1);
  }));
  tx(clusters);
}

function hydrateCluster(row) {
  if (!row) return null;
  return {
    id: row.id, search_id: row.search_id, rank: row.rank || 0,
    title: row.canonical_title, summary: row.summary || "", category: row.category || "AI 动态",
    item_ids: json(row.item_ids, []), entities: json(row.entities, []), source_count: row.source_count || 0,
    official_count: row.official_count || 0, first_seen: row.first_seen, latest_at: row.latest_at,
    spread_speed: row.spread_speed || 0, heat_score: row.cn_heat || 0, account_match: row.account_match || 0,
    evidence_strength: row.evidence_strength || 0, total_score: row.total_score || 0, risk: row.risk || "single_source",
    score_breakdown: json(row.score_breakdown, {}), status_tags: json(row.status_tags, []),
    angles: json(row.angles, []), title_candidates: json(row.title_candidates, []), sources: json(row.sources_json, []),
    questions: json(row.questions, []), created_at: row.created_at, updated_at: row.updated_at,
  };
}

function listHotspots(db, { searchId, category = "", sort = "recommended", limit = 30 } = {}) {
  const search = searchId ? getSearch(db, searchId) : latestSearch(db);
  if (!search) return { search: null, hotspots: [] };
  const order = sort === "latest" ? "c.latest_at DESC" : sort === "fastest" ? "c.spread_speed DESC,c.total_score DESC"
    : sort === "match" ? "c.account_match DESC,c.total_score DESC" : "r.rank ASC";
  const params = [search.id];
  let where = "r.search_id=?";
  if (category) { where += " AND c.category=?"; params.push(category); }
  params.push(Math.max(1, Math.min(Number(limit) || 30, 100)));
  const rows = db.prepare(`SELECT c.*,r.rank FROM hot_search_result r JOIN hot_cluster c ON c.id=r.cluster_id
    WHERE ${where} ORDER BY ${order} LIMIT ?`).all(...params);
  return { search, hotspots: rows.map(hydrateCluster) };
}

function getHotspot(db, id) { return hydrateCluster(db.prepare("SELECT * FROM hot_cluster WHERE id=?").get(id) || null); }

function createTopic(db, hotspot, input = {}, profile = {}) {
  if (!hotspot) return null;
  const angle = txt(input.angle || hotspot.angles?.[0]?.text || hotspot.angles?.[0] || `解读 ${hotspot.title} 的事实、影响与边界`, 600);
  const title = txt(input.title || hotspot.title_candidates?.[0] || hotspot.title, 200);
  const framework = ["interpretation", "opinion", "list"].includes(input.framework) ? input.framework : "interpretation";
  const id = makeId("topic", `${hotspot.id}|${title}`);
  const questions = Array.isArray(hotspot.questions) ? hotspot.questions : [];
  db.prepare(`INSERT INTO topic (id,origin,cluster_id,title,angle,audience,framework,score,questions,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, "hotspot", hotspot.id, title, angle,
      txt(input.audience || profile.audience || "关注 AI 发展的科技从业者与深度读者", 300),
      framework,
      hotspot.total_score || 0, JSON.stringify(questions), now());
  const sourceUrls = (hotspot.sources || []).filter((s) => /^https?:\/\//.test(String(s.url || "")))
    .sort((a, b) => Number(b.official || 0) - Number(a.official || 0) || String(a.tier).localeCompare(String(b.tier)))
    .map((s) => s.url).filter((u, i, a) => a.indexOf(u) === i).slice(0, 8);
  return {
    topic_id: id, cluster_id: hotspot.id,
    prefill: {
      title, angle, framework,
      audience: txt(input.audience || profile.audience || "关注 AI 发展的科技从业者与深度读者", 300),
      referenceUrls: sourceUrls,
      questions: questions.map((q) => `- ${q}`).join("\n"),
    },
  };
}

function listTopics(db, limit = 50) {
  return db.prepare("SELECT * FROM topic ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(Number(limit) || 50, 200)))
    .map((row) => ({ ...row, questions: json(row.questions, []) }));
}

module.exports = {
  now, txt, json, makeId,
  seedSources, listSources, recordSourceResult,
  createSearch, updateSearch, getSearch, latestSearch,
  upsertItems, replaceClusters, listHotspots, getHotspot,
  createTopic, listTopics,
};
