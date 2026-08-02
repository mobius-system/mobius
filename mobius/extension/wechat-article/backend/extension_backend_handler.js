// wechat-article/backend/extension_backend_handler.js
// 公众号图文生成 handler。30s 内返回：配置/校验/轻 LLM(clarify/render)/文章 CRUD/状态查询 全同步；
// 长任务（生成正文、推送草稿）只 createJob + spawn(detached) article-worker 然后立即返回。
// 硬约束（SKILL + 方案 §14）：≤30s / ≤5MB 返回 / ≤1MB 入参 / stateless / 只写 ext_data_dir / 禁 chdir / logger.*。

const path = require("path"), fs = require("fs"), crypto = require("crypto");
const { spawn } = require("child_process");
const store = require("./lib/store");
const job = require("./lib/job-store");
const cfgStore = require("./lib/config-store");
const cryptoLib = require("./lib/crypto");
const llm = require("./lib/llm");
const claimsLib = require("./lib/claims");
const { render, validateWechatFields } = require("./lib/render");
const wechat = require("./lib/wechat");
const image = require("./lib/image");
const hotspotStore = require("./lib/hotspot-store");
const { buildArticlePackage } = require("./lib/export");
const { relativeToUser } = require("./lib/assets");

const VERSION = "0.4.2";
const WORKER = path.join(__dirname, "article-worker.js");
const HOTSPOT_WORKER = path.join(__dirname, "hotspot-worker.js");
const NODE_MODULES = path.resolve(__dirname, "../../../node_modules"); // mobius/node_modules
const FRAMEWORKS = new Set(["interpretation", "opinion", "list"]);

const txt = (s, n = 512) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
const ok = (o) => ({ ok: true, ...(o || {}) });
const fail = (e, extra) => ({ ok: false, error: String(e && (e.message || e)).slice(0, 300), ...(extra || {}) });
const ARTICLE_ACTIVE = job.ACTIVE_STATES;

// ---------- spawn detached worker ----------
function spawnWorker(extDataDir, jobId, workerPath = WORKER) {
  const dir = job.jobDir(extDataDir, jobId);
  const specPath = path.join(dir, "spec.json");
  const logFd = fs.openSync(path.join(dir, "worker.log"), "a");
  let child;
  try {
    child = spawn(process.execPath, [workerPath, specPath], {
      env: Object.assign({}, process.env, { NODE_PATH: NODE_MODULES }),
      detached: true, stdio: ["ignore", logFd, logFd],
    });
    fs.closeSync(logFd);
    child.unref();
  } catch (e) {
    try { fs.closeSync(logFd); } catch (_) {}
    job.updateStatus(extDataDir, jobId, { state: "failed", error: "启动失败: " + (e.message || e) });
    return fail(e);
  }
  job.writePid(extDataDir, jobId, child.pid);
  return { ok: true };
}

function anyActive(jobs) { return jobs.some((j) => ARTICLE_ACTIVE.has(j.state)); }

// ---------- handlers ----------
function handlePing(extDataDir) {
  let dbOk = false;
  try { const db = store.open(extDataDir); db.close(); dbOk = true; } catch (_) {}
  return ok({ service: "wechat-article", version: VERSION, time: new Date().toISOString(),
    crypto_available: cryptoLib.hasKey(), channels: llm.channelsOut().length, db_ok: dbOk });
}
function handleGetConfig(extDataDir) {
  return ok({ config: cfgStore.publicView(cfgStore.load(extDataDir)),
    channels: llm.channelsOut(), default_model: llm.defaultModelKey() });
}
function handleSaveConfig(p, extDataDir) {
  try { const next = cfgStore.mergeSave(extDataDir, p.config || {}); return ok({ config: cfgStore.publicView(next) }); }
  catch (e) { return fail(e); }
}
function handleSaveProfile(p, extDataDir) {
  const c = cfgStore.load(extDataDir);
  c.account_profile = Object.assign({}, c.account_profile, p.profile || {});
  cfgStore.save(extDataDir, c);
  try { const db = store.open(extDataDir); store.setProfile(db, c.account_profile); db.close(); } catch (_) {}
  return ok({ config: cfgStore.publicView(c) });
}
function handleSaveStyle(p, extDataDir) {
  const c = cfgStore.load(extDataDir);
  c.style = Object.assign({}, c.style, p.style || {});
  cfgStore.save(extDataDir, c);
  try { const db = store.open(extDataDir); store.setStyle(db, c.style); db.close(); } catch (_) {}
  return ok({ config: cfgStore.publicView(c) });
}
async function handleTestProvider(p) {
  try {
    const provider = llm.findProvider(p.model_key || null);
    const r = await llm.callModel({ provider, system: "只回 pong", user: "ping", maxTokens: 10, timeoutMs: 15_000 });
    return ok({ alive: !!r.text, text: (r.text || "").slice(0, 40), model: r.model });
  } catch (e) { return fail(e); }
}
async function handleClarify(p) {
  const title = txt(p.title, 200);
  if (!title) return fail("需要 title");
  try {
    const provider = llm.findProvider(p.model_key || null);
    const r = await llm.callJson({ provider, system: "只输出 JSON。", maxTokens: 900, timeoutMs: 26_000,
      user: `用户想写公众号文章，主题「${title}」。补全：1) core_claim 核心主张；2) audience 目标读者；3) framework 推荐(interpretation|opinion|list)；4) questions 需核实的 3-5 个问题(数组)。输出 {"core_claim":"","audience":"","framework":"interpretation","questions":[""]}` });
    return ok(r.json || {});
  } catch (e) { return fail(e); }
}
function handleRenderPreview(p) {
  const md = String(p.body_md || "").slice(0, 200000);
  return ok({ html: render(md), fields: validateWechatFields({ title: p.title, author: p.author, digest: p.digest, bodyHtml: render(md) }) });
}
async function handleGenerateCover(p, extDataDir) {
  try {
    const c = await image.generatePlaceholderCover({ extDataDir, title: txt(p.title, 40), subtitle: txt(p.subtitle, 60) });
    let dataUrl = "";
    try { const b = fs.readFileSync(c.path); dataUrl = "data:image/" + (c.type === "jpg" ? "jpeg" : c.type) + ";base64," + b.toString("base64"); } catch (_) {}
    return ok({ path: c.path, type: c.type, need_rasterize: !!c.need_rasterize, data_url: dataUrl });
  } catch (e) { return fail(e); }
}
function handleStartArticle(p, extDataDir, username) {
  const title = txt(p.title, 200);
  if (!title) return fail("需要 title");
  const framework = FRAMEWORKS.has(p.framework) ? p.framework : "interpretation";
  const referenceUrls = Array.isArray(p.referenceUrls) ? p.referenceUrls
    .filter((u) => /^https?:\/\//.test(String(u))).slice(0, 8).map((u) => txt(u, 1024)) : [];
  const topic = { id: txt(p.topic_id, 120), cluster_id: txt(p.hotspot_id || p.cluster_id, 120),
    title, angle: txt(p.angle, 600), framework, referenceUrls, questions: txt(p.questions, 1000), audience: txt(p.audience, 300) };
  const modelKey = txt(p.model_key, 160);
  const mode = p.mode === "auto_push" ? "auto_push" : "manual";
  const autoImages = p.auto_images !== false;
  const imageCount = Math.max(1, Math.min(Number(p.image_count) || 3, 6));
  const jobs = job.listJobs(extDataDir, 20);
  if (jobs.some((j) => ARTICLE_ACTIVE.has(j.state) && ["article", "images"].includes(j.kind)))
    return fail("已有文章任务在运行，请等待完成或取消");
  const jobId = job.createJob(extDataDir, { kind: "article", spec: { topic, mode, modelKey, username, autoImages, imageCount } });
  const r = spawnWorker(extDataDir, jobId);
  if (!r.ok) return r;
  return ok({ job_id: jobId, state: "queued" });
}

function handleStartImages(p, extDataDir, username) {
  const articleId = txt(p.article_id || p.articleId, 120);
  if (!articleId) return fail("需要 article_id");
  if (anyActive(job.listJobs(extDataDir, 30))) return fail("已有后台任务在运行");
  let article;
  try { const db = store.open(extDataDir); article = store.getArticle(db, articleId); db.close(); } catch (_) {}
  if (!article) return fail("文章不存在");
  const imageCount = Math.max(1, Math.min(Number(p.image_count) || 3, 6));
  const jobId = job.createJob(extDataDir, { kind: "images", spec: { mode: "images_only", articleId, username, imageCount } });
  const result = spawnWorker(extDataDir, jobId);
  if (!result.ok) return result;
  return ok({ job_id: jobId, state: "queued" });
}

// ---------- 热点检索（后台 Worker） ----------
const HOTSPOT_CATEGORIES = new Set(["大模型", "Agent", "AI 编程", "多模态", "机器人", "AI 应用", "开源模型", "论文研究", "算力与芯片", "融资与商业", "政策与监管"]);
function handleStartCollect(p, extDataDir) {
  const query = txt(p.query, 200);
  const windowHours = [24, 72, 168].includes(Number(p.window_hours || p.windowHours)) ? Number(p.window_hours || p.windowHours) : 72;
  const region = ["all", "domestic", "overseas"].includes(p.region) ? p.region : "all";
  const categories = Array.isArray(p.categories) ? p.categories.filter((x) => HOTSPOT_CATEGORIES.has(x)).slice(0, 12) : [];
  const active = job.listJobs(extDataDir, 30).find((j) => j.kind === "hotspot" && ARTICLE_ACTIVE.has(j.state));
  if (active) return fail("已有热点检索在运行", { job_id: active.jobId });
  let db, search;
  try {
    db = store.open(extDataDir);
    search = hotspotStore.createSearch(db, { query, window_hours: windowHours, region, categories });
    db.close(); db = null;
    const jobId = job.createJob(extDataDir, { kind: "hotspot", spec: { searchId: search.id, query, windowHours,
      region, categories, modelKey: txt(p.model_key, 120) } });
    const spawned = spawnWorker(extDataDir, jobId, HOTSPOT_WORKER);
    if (!spawned.ok) {
      db = store.open(extDataDir);
      hotspotStore.updateSearch(db, search.id, { status: "failed", error: spawned.error || "启动失败" });
      db.close(); db = null;
      return spawned;
    }
    return ok({ job_id: jobId, search_id: search.id, state: "queued" });
  } catch (e) { try { db && db.close(); } catch (_) {} return fail(e); }
}
function handleListHotspots(p, extDataDir) {
  let db;
  try {
    db = store.open(extDataDir);
    const result = hotspotStore.listHotspots(db, { searchId: txt(p.search_id, 120), category: txt(p.category, 80),
      sort: ["recommended", "latest", "fastest", "match"].includes(p.sort) ? p.sort : "recommended", limit: Math.min(Number(p.limit) || 30, 100) });
    db.close(); return ok(result);
  } catch (e) { try { db && db.close(); } catch (_) {} return fail(e); }
}
function handleGetHotspot(p, extDataDir) {
  let db;
  try {
    db = store.open(extDataDir); const hotspot = hotspotStore.getHotspot(db, txt(p.hotspot_id || p.id, 120)); db.close();
    return hotspot ? ok({ hotspot }) : fail("热点不存在");
  } catch (e) { try { db && db.close(); } catch (_) {} return fail(e); }
}
function handleCreateTopic(p, extDataDir) {
  let db;
  try {
    db = store.open(extDataDir); const hotspot = hotspotStore.getHotspot(db, txt(p.hotspot_id || p.id, 120));
    if (!hotspot) { db.close(); return fail("热点不存在"); }
    const profile = cfgStore.load(extDataDir).account_profile || {};
    const result = hotspotStore.createTopic(db, hotspot, { title: txt(p.title, 200), angle: txt(p.angle, 600),
      audience: txt(p.audience, 300), framework: p.framework }, profile);
    db.close(); return ok({ ...result, hotspot });
  } catch (e) { try { db && db.close(); } catch (_) {} return fail(e); }
}
function handleListTopics(p, extDataDir) {
  let db;
  try { db = store.open(extDataDir); const topics = hotspotStore.listTopics(db, p.limit); db.close(); return ok({ topics }); }
  catch (e) { try { db && db.close(); } catch (_) {} return fail(e); }
}
function handlePushDraft(p, extDataDir) {
  const articleId = txt(p.article_id || p.articleId, 120);
  if (!articleId) return fail("需要 article_id");
  const config = cfgStore.load(extDataDir);
  if (!config.wx || !config.wx.appid || !config.wx.secret) return fail("未配置微信凭据（设置页填 AppID/AppSecret）");
  if (anyActive(job.listJobs(extDataDir, 20))) return fail("已有任务在运行");
  let art;
  try { const db = store.open(extDataDir); art = store.getArticle(db, articleId); db.close(); } catch (_) {}
  if (!art) return fail("文章不存在");
  const jobId = job.createJob(extDataDir, { kind: "push", spec: { mode: "push_only", articleId } });
  const r = spawnWorker(extDataDir, jobId);
  if (!r.ok) return r;
  return ok({ job_id: jobId, state: "uploading" });
}
async function handleReconcile(p, extDataDir) {
  const config = cfgStore.load(extDataDir);
  if (!config.wx || !config.wx.appid) return fail("未配置微信凭据");
  try {
    const ctx = { extDataDir, appid: config.wx.appid, secret: config.wx.secret, logger: () => {} };
    const r = await wechat.reconcile(ctx, { title: txt(p.title, 40), digest: txt(p.digest, 120) });
    return ok(r);
  } catch (e) { return fail(e); }
}
function handleListArticles(p, extDataDir) {
  try { const db = store.open(extDataDir); const r = store.listArticles(db, Math.min(Number(p.limit) || 50, 500)); db.close(); return ok({ articles: r }); }
  catch (e) { return fail(e); }
}
function handleGetArticle(p, extDataDir, username) {
  const id = txt(p.article_id || p.id, 120);
  try {
    const db = store.open(extDataDir);
    const art = store.getArticle(db, id);
    if (!art) { db.close(); return fail("文章不存在"); }
    const evidence = db.prepare("SELECT id,source_url,source_name,author,published_at,excerpt,tier FROM evidence WHERE article_id=?").all(id);
    const claimsR = db.prepare("SELECT id,paragraph_idx,claim_text,risk,evidence_id,relation,resolved FROM claim WHERE article_id=?").all(id);
    const images = store.listArticleImages(db, id).map(({ file_path, metadata, ...item }) => ({ ...item,
      asset_rel: relativeToUser(extDataDir, username, file_path || "") }));
    db.close();
    let quality = null, outline = null;
    try { quality = JSON.parse(art.quality || "null"); } catch (_) {}
    try { outline = JSON.parse(art.outline || "null"); } catch (_) {}
    return ok({ article: Object.assign({}, art, { quality, outline }), evidence, claims: claimsR, images });
  } catch (e) { return fail(e); }
}
function handleSaveArticle(p, extDataDir) {
  const id = txt(p.article_id || p.id, 120);
  if (!id) return fail("需要 article_id");
  const title = p.title != null ? txt(p.title, 32) : undefined;
  const digest = p.digest != null ? txt(p.digest, 120) : undefined;
  const bodyMd = p.body_md != null ? String(p.body_md).slice(0, 200000) : undefined;
  try {
    const db = store.open(extDataDir);
    const prev = store.getArticle(db, id);
    store.upsertArticle(db, { id, title, digest, body_md: bodyMd, body_html: bodyMd != null ? render(bodyMd) : undefined,
      state: prev && prev.state === "pushed" ? "pushed" : "edited" });
    if (bodyMd != null && (!prev || prev.body_md !== bodyMd)) {
      const vno = db.prepare("SELECT COALESCE(MAX(version_no),0)+1 n FROM article_version WHERE article_id=?").get(id).n;
      db.prepare("INSERT INTO article_version (id,article_id,version_no,title,digest,body_md,note,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run("v_" + crypto.randomBytes(4).toString("hex"), id, vno, (prev && prev.title) || title || "", (prev && prev.digest) || digest || "", bodyMd, txt(p.note || "自动保存", 200), new Date().toISOString());
    }
    const art = store.getArticle(db, id); db.close();
    let quality = null, outline = null;
    try { quality = JSON.parse(art.quality || "null"); } catch (_) {}
    try { outline = JSON.parse(art.outline || "null"); } catch (_) {}
    return ok({ article: { ...art, quality, outline } });
  } catch (e) { return fail(e); }
}
function handleDeleteArticle(p, extDataDir) {
  const id = txt(p.article_id || p.id, 120);
  try {
    const db = store.open(extDataDir);
    db.prepare("DELETE FROM article WHERE id=?").run(id);
    db.prepare("DELETE FROM article_version WHERE article_id=?").run(id);
    db.prepare("DELETE FROM evidence WHERE article_id=?").run(id);
    db.prepare("DELETE FROM claim WHERE article_id=?").run(id);
    db.prepare("DELETE FROM article_image WHERE article_id=?").run(id);
    db.close(); return ok({});
  } catch (e) { return fail(e); }
}
function handleListVersions(p, extDataDir) {
  const id = txt(p.article_id || p.id, 120);
  try { const db = store.open(extDataDir);
    const r = db.prepare("SELECT id,version_no,title,digest,note,created_at FROM article_version WHERE article_id=? ORDER BY version_no DESC").all(id);
    db.close(); return ok({ versions: r }); }
  catch (e) { return fail(e); }
}
function handleRestoreVersion(p, extDataDir) {
  const vid = txt(p.version_id, 120);
  try {
    const db = store.open(extDataDir);
    const v = db.prepare("SELECT * FROM article_version WHERE id=?").get(vid);
    if (!v) { db.close(); return fail("版本不存在"); }
    store.upsertArticle(db, { id: v.article_id, title: v.title, digest: v.digest, body_md: v.body_md, state: "edited" });
    db.close(); return ok({});
  } catch (e) { return fail(e); }
}
function handleGetEvidence(p, extDataDir) {
  const id = txt(p.article_id || p.id, 120);
  try { const db = store.open(extDataDir); const r = db.prepare("SELECT * FROM evidence WHERE article_id=?").all(id); db.close(); return ok({ evidence: r }); }
  catch (e) { return fail(e); }
}
function handleGetClaims(p, extDataDir) {
  const id = txt(p.article_id || p.id, 120);
  try { const db = store.open(extDataDir); const r = db.prepare("SELECT * FROM claim WHERE article_id=?").all(id); db.close(); return ok({ claims: r }); }
  catch (e) { return fail(e); }
}
function handleResolveClaim(p, extDataDir) {
  const id = txt(p.claim_id || p.id, 120);
  try { const db = store.open(extDataDir); db.prepare("UPDATE claim SET resolved=1, note=? WHERE id=?").run(txt(p.note || "", 300), id); db.close(); return ok({}); }
  catch (e) { return fail(e); }
}
function handleExport(extDataDir) {
  try { const db = store.open(extDataDir); const arts = store.listArticles(db, 500); db.close();
    return ok({ db_path: path.join(extDataDir, "data.db"), ext_data_dir: extDataDir, articles: arts }); }
  catch (e) { return fail(e); }
}
function handlePrepareExport(p, extDataDir, username) {
  const articleId = txt(p.article_id || p.articleId, 120);
  if (!articleId) return fail("需要 article_id");
  let db;
  try {
    db = store.open(extDataDir);
    const article = store.getArticle(db, articleId);
    if (!article) { db.close(); return fail("文章不存在"); }
    const images = store.listArticleImages(db, articleId);
    db.close(); db = null;
    return ok({ package: buildArticlePackage({ extDataDir, username, article, images }) });
  } catch (e) { try { db && db.close(); } catch (_) {} return fail(e); }
}
function handlePurge(p, extDataDir) {
  if (p.confirm !== "DELETE_ALL") return fail("需要 confirm='DELETE_ALL' 才能清空");
  try {
    const db = store.open(extDataDir);
    for (const t of ["article", "article_version", "evidence", "claim", "topic", "hot_search_result", "hot_search", "hot_item", "hot_cluster", "operation", "published_history", "article_image"])
      try { db.prepare(`DELETE FROM ${t}`).run(); } catch (_) {}
    db.close();
    try { const jd = job.jobsDir(extDataDir); for (const d of fs.readdirSync(jd)) fs.rmSync(path.join(jd, d), { recursive: true, force: true }); } catch (_) {}
    return ok({});
  } catch (e) { return fail(e); }
}

module.exports = async function ({ username, display_name, ext_main_payload, ext_data_dir, extension_name, logger }) {
  const p = (ext_main_payload && typeof ext_main_payload === "object") ? ext_main_payload : {};
  const action = txt(p.action, 64) || "ping";
  const extDataDir = ext_data_dir;
  try {
    switch (action) {
      case "ping": case "diagnostics": return handlePing(extDataDir);
      case "get_config": return handleGetConfig(extDataDir);
      case "save_config": return handleSaveConfig(p, extDataDir);
      case "save_account_profile": return handleSaveProfile(p, extDataDir);
      case "save_style_profile": return handleSaveStyle(p, extDataDir);
      case "list_ai_channels": return ok({ channels: llm.channelsOut(), default_model: llm.defaultModelKey() });
      case "test_provider": return await handleTestProvider(p);
      case "clarify_topic": return await handleClarify(p);
      case "render_preview": return handleRenderPreview(p);
      case "generate_cover": return await handleGenerateCover(p, extDataDir);
      case "start_article": return handleStartArticle(p, extDataDir, username);
      case "start_images": return handleStartImages(p, extDataDir, username);
      case "push_draft": return handlePushDraft(p, extDataDir);
      case "job_status": { const s = job.readStatus(extDataDir, txt(p.job_id, 120)); return s ? ok({ status: s }) : fail("job 不存在"); }
      case "list_jobs": return ok({ jobs: job.listJobs(extDataDir, Math.min(Number(p.limit) || 50, 200)) });
      case "cancel_job": return ok(job.cancelJob(extDataDir, txt(p.job_id, 120)));
      case "start_collect": return handleStartCollect(p, extDataDir);
      case "collect_status": { const s = job.readStatus(extDataDir, txt(p.job_id, 120)); return s ? ok({ status: s }) : fail("热点检索任务不存在"); }
      case "stop_collect": return ok(job.cancelJob(extDataDir, txt(p.job_id, 120)));
      case "list_hotspots": return handleListHotspots(p, extDataDir);
      case "get_hotspot": return handleGetHotspot(p, extDataDir);
      case "create_topic_from_hotspot": return handleCreateTopic(p, extDataDir);
      case "list_topics": return handleListTopics(p, extDataDir);
      case "list_articles": return handleListArticles(p, extDataDir);
      case "get_article": return handleGetArticle(p, extDataDir, username);
      case "save_article": return handleSaveArticle(p, extDataDir);
      case "delete_article": return handleDeleteArticle(p, extDataDir);
      case "list_versions": return handleListVersions(p, extDataDir);
      case "restore_version": return handleRestoreVersion(p, extDataDir);
      case "get_evidence": return handleGetEvidence(p, extDataDir);
      case "get_claims": return handleGetClaims(p, extDataDir);
      case "resolve_claim": return handleResolveClaim(p, extDataDir);
      case "reconcile_draft": return await handleReconcile(p, extDataDir);
      case "export_data": return handleExport(extDataDir);
      case "prepare_export": return handlePrepareExport(p, extDataDir, username);
      case "purge_data": return handlePurge(p, extDataDir);
      default: return fail("未知 action: " + action);
    }
  } catch (e) {
    try { logger && logger.error && logger.error((e && e.stack) || String(e)); } catch (_) {}
    return fail(e);
  }
};
