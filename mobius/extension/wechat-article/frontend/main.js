// wechat-article 前端主逻辑（零编译原生 ESM）。仅通过 extCall SDK 调后端。
// 三 tab：选题/写作（自填主题→生成→编辑→预览→推送）、我的文章、设置。
// 轮询用自递归 setTimeout（pollRecursive），仅 running 时轮询；UI tick 用 setInterval 不受约束。

import { extCall } from "/extension/_sdk/ext.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const app = $("#app");

const state = {
  config: null, channels: [], default_model: "",
  articles: [], current: null, tab: "write", pollStop: null, pollJobId: "",
  activeJob: null, completedJob: null,
  writeMode: localStorage.getItem("wechat-article-write-mode") || "hotspot",
  formDraft: { title: "", angle: "", framework: "interpretation", audience: "", refs: "", questions: "", model: "", autoImages: true, imageCount: 3 },
  selectedTopic: null,
  hotspot: {
    query: "", windowHours: 72, region: "all", categories: [], sort: "recommended",
    search: null, results: [], detail: null, selectedAngle: 0, selectedTitle: 0,
    activeJob: null, pollStop: null, pollJobId: "",
  },
};

const ACTIVE_JOB_STATES = new Set(["queued", "running", "researching", "outlining", "writing", "reviewing", "rendering", "uploading",
  "illustrating", "exporting", "collecting", "filtering", "clustering", "verifying", "ranking"]);
const TERMINAL_JOB_STATES = new Set(["done", "waiting_user", "failed", "cancelled", "unknown_external_result"]);
const ACTIVE_JOB_STORAGE_KEY = "wechat-article-active-job";
const HOTSPOT_JOB_STORAGE_KEY = "wechat-article-hotspot-job";

async function api(action, payload = {}) {
  try { return await extCall({ action, ...payload }); }
  catch (e) { toast((e.data && e.data.error) || e.message || "调用失败"); throw e; }
}
function toast(msg) {
  let t = $("#toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show"); clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove("show"), 3000);
}
// 自递归轮询（拓展自包含，不依赖主前端 polling.ts；天然不重叠）
function pollRecursive(fn, intervalMs) {
  let stop = false;
  (async () => { while (!stop) { try { await fn(); } catch (_) {} if (stop) return; await new Promise((r) => setTimeout(r, intervalMs)); } })();
  return () => { stop = true; };
}
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const safeUrl = (s) => /^https?:\/\//i.test(String(s || "")) ? String(s) : "#";
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function privateAssetUrl(rel) {
  if (!rel) return "";
  const token = localStorage.getItem("cc-token") || "";
  const encoded = String(rel).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/api/extensions/wechat-article/user-asset/${encoded}?token=${encodeURIComponent(token)}`;
}

function articleImageUrl(articleId, source) {
  const filename = String(source || "").replace(/^\.\//, "").replace(/^images\//, "");
  const item = (state.current?.images || []).find((image) => image.filename === filename);
  return item?.asset_rel ? privateAssetUrl(item.asset_rel) : source;
}

// 前端轻量 Markdown → HTML（实时预览用；推送前以后端 render_preview 为准）
function mdToHtml(md, articleId = "") {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const inline = (s) => esc(s)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, a, u) => `<img src="${esc(articleImageUrl(articleId, u))}" alt="${a}" style="max-width:100%"/>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\s*\[事实\d+\]/g, "");
  while (i < lines.length) {
    const l = lines[i];
    if (/^<!--\s*mobius-image:(start|end)\s*-->$/.test(l.trim())) { i++; continue; }
    if (/^```/.test(l)) { const b = []; i++; while (i < lines.length && !/^```/.test(lines[i])) b.push(lines[i++]); i++; out.push(`<pre>${esc(b.join("\n"))}</pre>`); continue; }
    if (/^#\s+/.test(l)) { out.push(`<h1>${inline(l.replace(/^#\s+/, ""))}</h1>`); i++; continue; }
    if (/^##\s+/.test(l)) { out.push(`<h2>${inline(l.replace(/^##\s+/, ""))}</h2>`); i++; continue; }
    if (/^###\s+/.test(l)) { out.push(`<h3>${inline(l.replace(/^###\s+/, ""))}</h3>`); i++; continue; }
    if (/^>\s?/.test(l)) { out.push(`<blockquote>${inline(l.replace(/^>\s?/, ""))}</blockquote>`); i++; continue; }
    if (/^[-*+]\s+/.test(l)) { const it = []; while (i < lines.length && /^[-*+]\s+/.test(lines[i])) it.push(`<li>${inline(lines[i++].replace(/^[-*+]\s+/, ""))}</li>`); out.push(`<ul>${it.join("")}</ul>`); continue; }
    if (/^\d+\.\s+/.test(l)) { const it = []; while (i < lines.length && /^\d+\.\s+/.test(lines[i])) it.push(`<li>${inline(lines[i++].replace(/^\d+\.\s+/, ""))}</li>`); out.push(`<ol>${it.join("")}</ol>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(l.trim())) { out.push("<hr/>"); i++; continue; }
    if (l.trim() === "") { i++; continue; }
    out.push(`<p>${inline(l)}</p>`); i++;
  }
  return out.join("\n");
}

async function bootstrap() {
  try {
    const r = await api("get_config");
    state.config = r.config; state.channels = r.channels || []; state.default_model = r.default_model || "";
    state.formDraft.autoImages = r.config?.inline_images !== false;
    state.formDraft.imageCount = Math.max(1, Math.min(Number(r.config?.budgets?.per_article_images) || 3, 6));
    const la = await api("list_articles");
    state.articles = la.articles || [];
    const lj = await api("list_jobs", { limit: 20 });
    const active = (lj.jobs || []).find((j) => ["article", "images"].includes(j.kind) && ACTIVE_JOB_STATES.has(j.state));
    const activeHotspot = (lj.jobs || []).find((j) => j.kind === "hotspot" && ACTIVE_JOB_STATES.has(j.state));
    const savedJobId = localStorage.getItem(ACTIVE_JOB_STORAGE_KEY) || "";
    if (active) state.activeJob = active;
    else if (savedJobId) state.activeJob = { jobId: savedJobId, state: "queued", phase: "init", progress: 0, message: "正在恢复后台任务状态" };
    const savedHotspotJobId = localStorage.getItem(HOTSPOT_JOB_STORAGE_KEY) || "";
    if (activeHotspot) state.hotspot.activeJob = activeHotspot;
    else if (savedHotspotJobId) state.hotspot.activeJob = { jobId: savedHotspotJobId, state: "queued", phase: "collect", progress: 0, message: "正在恢复热点检索" };
    const hs = await api("list_hotspots", { limit: 30 });
    if (hs.ok) { state.hotspot.search = hs.search || null; state.hotspot.results = hs.hotspots || []; state.hotspot.detail = state.hotspot.results[0] || null; }
  } catch (_) {}
  render();
  if (state.activeJob?.jobId) runJobPoll(state.activeJob.jobId, { resumed: true });
  if (state.hotspot.activeJob?.jobId) runHotspotPoll(state.hotspot.activeJob.jobId, { resumed: true });
}

function render() {
  const cfg = state.config || {};
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">公众号图文生成</div>
      <nav class="tabs">
        <button id="tab-write" class="${state.tab === "write" ? "active" : ""}">选题 / 写作</button>
        <button id="tab-list" class="${state.tab === "list" ? "active" : ""}">我的文章</button>
        <button id="tab-settings" class="${state.tab === "settings" ? "active" : ""}">设置</button>
      </nav>
      <div class="spacer"></div>
      <button id="job-indicator" class="job-indicator" hidden></button>
      <div class="pill">${cfg.wx_configured ? "微信已配置" : "微信未配置"} · ${cfg.crypto_available ? "加密就绪" : "缺主密钥"}</div>
    </header>
    <main id="view"></main>`;
  $("#tab-write").onclick = () => { state.tab = "write"; render(); };
  $("#tab-list").onclick = () => { state.tab = "list"; render(); };
  $("#tab-settings").onclick = () => { state.tab = "settings"; render(); };
  $("#job-indicator").onclick = onJobIndicatorClick;
  if (state.tab === "write") renderWrite();
  else if (state.tab === "list") renderList();
  else renderSettings();
  paintJobStatus();
}

// ---------- 选题 / 写作 ----------
function renderWrite() {
  if (state.current) { renderEditor(); return; }
  const discovering = state.writeMode === "hotspot" && !state.selectedTopic;
  $("#view").innerHTML = `
    <section class="card compose-shell">
      <div class="compose-head">
        <div><h2>新建一篇图文</h2><div class="stepper"><span class="active">1 发现热点</span><i></i><span class="${discovering ? "" : "active"}">2 确定角度</span><i></i><span>3 生成文章</span></div></div>
        <div class="mode-switch" role="tablist">
          <button id="mode-hotspot" class="${state.writeMode === "hotspot" ? "active" : ""}">从热点开始</button>
          <button id="mode-manual" class="${state.writeMode === "manual" ? "active" : ""}">自定义主题</button>
        </div>
      </div>
      <div id="compose-body"></div>
    </section>`;
  $("#mode-hotspot").onclick = () => { captureFormDraft(); state.writeMode = "hotspot"; state.selectedTopic = null; localStorage.setItem("wechat-article-write-mode", "hotspot"); render(); };
  $("#mode-manual").onclick = () => { captureFormDraft(); state.writeMode = "manual"; state.selectedTopic = null; localStorage.setItem("wechat-article-write-mode", "manual"); render(); };
  if (discovering) renderHotspotDiscovery(); else renderWriteForm();
}

const HOTSPOT_CATEGORIES = ["大模型", "Agent", "AI 编程", "多模态", "机器人", "AI 应用", "开源模型", "论文研究", "算力与芯片", "政策与监管"];
function fmtTime(value) {
  const ts = Date.parse(value); if (!Number.isFinite(ts)) return "时间未知";
  const diff = Date.now() - ts, hours = Math.floor(diff / 3600_000);
  if (hours < 1) return "刚刚更新"; if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
function hotspotCoverageHtml(search, status) {
  const c = status?.coverage || search?.coverage || {};
  if (!search && !status) return '<div class="coverage-bar muted">尚未检索。可留空查看全部 AI 热点，也可输入关注方向。</div>';
  const finished = c.completed_at || search?.completed_at || search?.updated_at;
  const sourceRows = Array.isArray(c.sources) ? c.sources : [];
  const hasQuery = Boolean(String(search?.query || state.hotspot.query || "").trim());
  const candidateSummary = hasQuery
    ? `近时段候选 ${c.recent_items ?? 0} 篇 · 直接命中 ${c.direct_matches ?? 0} 篇 · 扩展候选 ${c.expanded_candidates ?? 0} 篇`
    : `近时段候选 ${c.recent_items ?? 0} 篇`;
  return `<div class="coverage-bar">
    <div><b>检索覆盖</b> ${c.succeeded ?? 0}/${c.attempted ?? 0} 个来源 · ${candidateSummary} · 归并 ${c.clusters ?? search?.result_count ?? 0} 个事件 · 一手源热点 ${c.official_clusters ?? 0} 个</div>
    <div class="coverage-actions"><span>${finished ? `截止 ${esc(new Date(finished).toLocaleString("zh-CN", { hour12: false }))}` : "检索中"}</span>
      ${sourceRows.length ? `<details><summary>查看来源明细</summary><div class="source-popover">${sourceRows.map((s) => `<div><span class="source-dot ${s.ok ? "ok" : "bad"}"></span>${esc(s.name)}<em>${s.ok ? `${s.count || 0} 篇` : esc(s.error || "失败")}</em></div>`).join("")}</div></details>` : ""}
    </div></div>`;
}
function hotspotProgressHtml() {
  const st = state.hotspot.activeJob; if (!st) return "";
  const pct = Math.max(4, Math.round((st.progress || 0) * 100));
  const stages = [
    ["collect", "扫描官方、媒体与公众号来源"], ["filter", "筛选近时段内容并去重"], ["cluster", "跨来源归并同一事件"], ["verify", "核验一手来源、时间与可信度"], ["done", "计算热度和账号匹配度"],
  ];
  const index = Math.max(0, stages.findIndex((x) => x[0] === st.phase));
  return `<div class="hotspot-progress"><div class="progress"><div class="bar"><i style="width:${pct}%"></i></div><div class="msg">${esc(st.message || "正在检索")}</div></div>
    <div class="stage-list">${stages.map((x, i) => `<span class="${i < index ? "done" : i === index ? "active" : ""}">${i < index ? "✓" : i === index ? "●" : "○"} ${x[1]}</span>`).join("")}</div>
    <button id="btn-stop-hotspot" class="btn compact">取消检索</button></div>`;
}
function hotspotTagHtml(tag) {
  const kind = tag === "高度相关" ? "high" : tag === "扩展相关" ? "extended" : tag === "同期热点" ? "current" : "";
  return `<span class="${kind ? `relevance-${kind}` : ""}">${esc(tag)}</span>`;
}
function hotspotCardHtml(h) {
  const relevance = h.score_breakdown?.query_relevance;
  return `<article class="hotspot-card ${state.hotspot.detail?.id === h.id ? "selected" : ""}" data-hotspot-id="${esc(h.id)}">
    <div class="hotspot-rank">#${h.rank || "—"}</div><div class="hotspot-card-body">
      <div class="hotspot-title-row"><h3>${esc(h.title)}</h3><span class="category-tag">${esc(h.category)}</span></div>
      <p>${esc(h.summary || "")}</p>
      <div class="hotspot-tags">${(h.status_tags || []).map(hotspotTagHtml).join("")}</div>
      <div class="hotspot-meta"><span>${fmtTime(h.latest_at)}</span><span>${h.source_count || 0} 个独立来源</span><span>${h.official_count || 0} 个一手来源</span></div>
      <div class="score-row"><span>热度 <b>${h.heat_score || 0}</b></span>${Number.isFinite(relevance) ? `<span>相关 <b>${relevance}</b></span>` : ""}<span>匹配 <b>${h.account_match || 0}</b></span><span>证据 <b>${h.evidence_strength || 0}</b></span></div>
    </div><button class="choose-mini" data-choose-id="${esc(h.id)}">选为主题</button>
  </article>`;
}
function hotspotDetailHtml(h) {
  if (!h) return `<div class="hotspot-detail empty-detail"><div class="radar-mark">◎</div><h3>选择一个热点查看详情</h3><p>这里会展示事件时间、来源证据、写作角度与待核实问题。</p></div>`;
  const angles = h.angles || [], titles = h.title_candidates || [];
  return `<aside class="hotspot-detail">
    <div class="detail-head"><div><span class="category-tag">${esc(h.category)}</span><h3>${esc(h.title)}</h3></div><strong>${h.total_score || 0}<small>综合分</small></strong></div>
    <p class="detail-summary">${esc(h.summary || "")}</p>
    <section><h4>为什么值得写</h4><div class="why-box">近 ${state.hotspot.windowHours} 小时有 ${h.source_count || 0} 个独立来源，${h.official_count ? `包含 ${h.official_count} 个一手来源` : "尚缺一手来源"}；${Number.isFinite(h.score_breakdown?.query_relevance) ? `与检索方向相关度 ${h.score_breakdown.query_relevance}，` : ""}与当前账号匹配度 ${h.account_match || 0}，证据完整度 ${h.evidence_strength || 0}。</div></section>
    <section><h4>推荐标题</h4><div class="title-options">${titles.map((x, i) => `<button data-title-index="${i}" class="${i === state.hotspot.selectedTitle ? "active" : ""}">${esc(x)}</button>`).join("") || `<button class="active">${esc(h.title)}</button>`}</div></section>
    <section><h4>选择写作角度</h4><div class="angle-options">${angles.map((a, i) => `<button data-angle-index="${i}" class="${i === state.hotspot.selectedAngle ? "active" : ""}"><b>${esc(a.title || `角度 ${i + 1}`)}</b><span>${esc(a.text || a)}</span></button>`).join("")}</div></section>
    <section><h4>来源与证据</h4><div class="evidence-list">${(h.sources || []).map((s) => `<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noreferrer"><span class="tag ${esc(s.tier)}">${esc(s.tier)}</span><div><b>${esc(s.name)}</b><small>${s.official ? "一手来源" : "可信来源"} · ${fmtTime(s.published_at)}</small><em>${esc(s.title)}</em></div></a>`).join("") || '<div class="muted">暂无可展示来源</div>'}</div></section>
    ${h.questions?.length ? `<section><h4>需要核实</h4><ul class="question-list">${h.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></section>` : ""}
    <div class="detail-sticky"><button id="btn-select-hotspot" class="primary">选择此热点和角度</button></div>
  </aside>`;
}

function renderHotspotDiscovery() {
  const hs = state.hotspot;
  const modelOpts = state.channels.map((c) => `<option value="${esc(c.key)}" ${c.key === (state.formDraft.model || state.default_model) ? "selected" : ""}>${esc(c.label)} · ${esc(c.model)}</option>`).join("");
  $("#compose-body").innerHTML = `<div class="hotspot-search">
    <div class="search-line"><div><label><span>关注方向（可留空查看全部 AI 热点）</span><input id="hotspot-query" type="text" value="${esc(hs.query)}" placeholder="例如：Agent、AI 编程、多模态、OpenAI"/></label></div>
      <label class="search-model"><span>分析模型</span><select id="hotspot-model"><option value="">默认</option>${modelOpts}</select></label>
      <button id="btn-search-hotspot" class="primary" ${hs.activeJob ? "disabled" : ""}>${hs.activeJob ? "深度检索中…" : "开始深度检索"}</button></div>
    <div class="filter-row"><b>时间</b>${[[24,"24 小时"],[72,"近 3 天"],[168,"近 7 天"]].map(([v,l]) => `<button data-hours="${v}" class="chip ${hs.windowHours === v ? "active" : ""}">${l}</button>`).join("")}
      <b>范围</b>${[["all","全部"],["domestic","国内"],["overseas","海外"]].map(([v,l]) => `<button data-region="${v}" class="chip ${hs.region === v ? "active" : ""}">${l}</button>`).join("")}</div>
    <div class="filter-row categories"><b>分类</b>${HOTSPOT_CATEGORIES.map((c) => `<button data-category="${esc(c)}" class="chip ${hs.categories.includes(c) ? "active" : ""}">${esc(c)}</button>`).join("")}</div>
    ${hotspotProgressHtml()}${hotspotCoverageHtml(hs.search, hs.activeJob)}
  </div>
  <div class="hotspot-toolbar"><div><b>相关热点</b><span>${hs.results.length ? `共 ${hs.results.length} 个独立事件` : "等待检索"}</span></div>
    <select id="hotspot-sort"><option value="recommended">综合推荐</option><option value="latest">最新发生</option><option value="fastest">传播最快</option><option value="match">最适合本账号</option></select></div>
  <div class="hotspot-workspace"><div class="hotspot-list">${hs.results.length ? hs.results.map(hotspotCardHtml).join("") : `<div class="hotspot-empty"><div class="radar-mark">◎</div><h3>${hs.search ? "当前条件下没有发现热点" : "检索近 3 天 AI 最新热点"}</h3><p>${hs.search ? "可放宽分类、切换近 7 天或直接自定义主题。" : "将扫描官方、一手来源、中英文媒体与公众号，去重后归并为独立事件。"}</p></div>`}</div>${hotspotDetailHtml(hs.detail)}</div>`;
  $("#hotspot-sort").value = hs.sort;
  $("#hotspot-query").oninput = (e) => { hs.query = e.target.value; };
  $$('[data-hours]').forEach((b) => b.onclick = () => { hs.windowHours = Number(b.dataset.hours); render(); });
  $$('[data-region]').forEach((b) => b.onclick = () => { hs.region = b.dataset.region; render(); });
  $$('[data-category]').forEach((b) => b.onclick = () => { const c = b.dataset.category; hs.categories = hs.categories.includes(c) ? hs.categories.filter((x) => x !== c) : [...hs.categories, c]; render(); });
  $("#btn-search-hotspot").onclick = onHotspotSearch;
  $("#hotspot-sort").onchange = async (e) => { hs.sort = e.target.value; await loadHotspots(hs.search?.id); };
  $$('[data-hotspot-id]').forEach((card) => card.onclick = (e) => { if (e.target.closest('[data-choose-id]')) return; hs.detail = hs.results.find((x) => x.id === card.dataset.hotspotId) || null; hs.selectedAngle = 0; hs.selectedTitle = 0; render(); });
  $$('[data-choose-id]').forEach((b) => b.onclick = () => { hs.detail = hs.results.find((x) => x.id === b.dataset.chooseId) || null; hs.selectedAngle = 0; hs.selectedTitle = 0; render(); });
  $$('[data-angle-index]').forEach((b) => b.onclick = () => { hs.selectedAngle = Number(b.dataset.angleIndex); render(); });
  $$('[data-title-index]').forEach((b) => b.onclick = () => { hs.selectedTitle = Number(b.dataset.titleIndex); render(); });
  if ($("#btn-select-hotspot")) $("#btn-select-hotspot").onclick = onSelectHotspot;
  if ($("#btn-stop-hotspot")) $("#btn-stop-hotspot").onclick = onStopHotspot;
}

function captureFormDraft() {
  if (!$("#f-title")) return;
  state.formDraft = { title: $("#f-title").value, angle: $("#f-angle").value, framework: $("#f-framework").value,
    audience: $("#f-audience").value, refs: $("#f-refs").value, questions: $("#f-questions").value, model: $("#f-model").value,
    autoImages: $("#f-auto-images") ? $("#f-auto-images").checked : true,
    imageCount: $("#f-image-count") ? Number($("#f-image-count").value) || 3 : 3 };
}
function openEvidenceModal(h) {
  $("#hotspot-evidence-modal")?.remove();
  const modal = document.createElement("div"); modal.id = "hotspot-evidence-modal"; modal.className = "modal-backdrop";
  modal.innerHTML = `<div class="evidence-modal"><div class="modal-head"><div><span class="category-tag">${esc(h.category)}</span><h3>${esc(h.title)}</h3></div><button id="close-evidence-modal" aria-label="关闭">×</button></div>
    <p>${esc(h.summary || "")}</p><h4>来源与证据</h4><div class="evidence-list">${(h.sources || []).map((s) => `<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noreferrer"><span class="tag ${esc(s.tier)}">${esc(s.tier)}</span><div><b>${esc(s.name)}</b><small>${s.official ? "一手来源" : "可信来源"} · ${fmtTime(s.published_at)}</small><em>${esc(s.title)}</em></div></a>`).join("")}</div>
    ${h.questions?.length ? `<h4>需要核实</h4><ul class="question-list">${h.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}</div>`;
  document.body.appendChild(modal);
  $("#close-evidence-modal").onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}
function renderWriteForm() {
  const hasActiveJob = !!state.activeJob, d = state.formDraft;
  const chOpts = state.channels.map((c) => `<option value="${esc(c.key)}" ${c.key === (d.model || state.default_model) ? "selected" : ""}>${esc(c.label)} · ${esc(c.model)}</option>`).join("");
  const selected = state.selectedTopic;
  $("#compose-body").innerHTML = `${selected ? `<div class="selected-hotspot"><div><span>已选择热点</span><b>${esc(selected.hotspot.title)}</b><small>${(selected.hotspot.status_tags || []).join(" · ")} · ${selected.hotspot.source_count || 0} 个独立来源 · ${fmtTime(selected.hotspot.latest_at)}</small></div><div><button id="btn-view-selected" class="btn">查看证据</button><button id="btn-change-hotspot" class="btn">更换热点</button></div></div>` : ""}
    <div class="write-form">
      ${selected?.hotspot?.title_candidates?.length ? `<div class="candidate-strip"><span>推荐标题</span>${selected.hotspot.title_candidates.map((x) => `<button data-fill-title="${esc(x)}">${esc(x)}</button>`).join("")}</div>` : ""}
      <label><span>主题 / 标题 *</span><input id="f-title" type="text" value="${esc(d.title)}" placeholder="例：OpenAI 发布新模型，多模态能力升级"/></label>
      <div class="row" style="margin:8px 0"><button id="btn-clarify" class="btn">${selected ? "AI 重新生成角度与核实问题" : "AI 补全角度与待核实问题"}</button><span class="muted">标题、角度和资料都可以继续手动调整</span></div>
      <div class="grid2"><label><span>角度 / 切入点</span><textarea id="f-angle" placeholder="为什么现在写、给读者什么增量信息">${esc(d.angle)}</textarea></label><div>
        <label><span>框架</span><select id="f-framework"><option value="interpretation">热点解读</option><option value="opinion">观点文章</option><option value="list">实用清单</option></select></label>
        <label><span>目标读者</span><input id="f-audience" type="text" value="${esc(d.audience)}" placeholder="AI 从业者 / 产品经理 / 普通读者"/></label></div></div>
      <label><span>参考链接（可信源，每行一条；优先一手源）</span><textarea id="f-refs" placeholder="https://openai.com/blog/...">${esc(d.refs)}</textarea></label>
      <label><span>需核实的问题（可选）</span><textarea id="f-questions" placeholder="哪些数字/日期/能力描述必须查证">${esc(d.questions)}</textarea></label>
      <div class="illustration-options"><label class="check-row"><input id="f-auto-images" type="checkbox" ${d.autoImages !== false ? "checked" : ""}/><span><b>自动检索正文配图</b><small>使用 Wikimedia Commons 开放许可图片，自动插入图注、作者、许可和来源</small></span></label>
        <label class="image-count"><span>配图数量</span><select id="f-image-count">${[1,2,3,4,5,6].map((n) => `<option value="${n}" ${Number(d.imageCount || 3) === n ? "selected" : ""}>${n} 张</option>`).join("")}</select></label></div>
      <div class="row"><label style="margin:0; min-width:240px"><span>生成模型</span><select id="f-model"><option value="">默认</option>${chOpts}</select></label>
        <button id="btn-start" class="primary" ${hasActiveJob ? "disabled" : ""}>${hasActiveJob ? "后台生成中…" : "开始生成图文初稿"}</button><span class="muted">约 2–5 分钟（资料→大纲→正文→去AI味→配图→打包）</span></div><div id="progress"></div>
    </div>`;
  $("#f-framework").value = d.framework || "interpretation";
  $("#btn-clarify").onclick = onClarify; $("#btn-start").onclick = onStart;
  $$('[data-fill-title]').forEach((b) => b.onclick = () => { $("#f-title").value = b.dataset.fillTitle; state.formDraft.title = b.dataset.fillTitle; });
  if ($("#btn-change-hotspot")) $("#btn-change-hotspot").onclick = () => { captureFormDraft(); state.selectedTopic = null; state.writeMode = "hotspot"; render(); };
  if ($("#btn-view-selected")) $("#btn-view-selected").onclick = () => { captureFormDraft(); openEvidenceModal(selected.hotspot); };
  paintJobStatus();
}

async function onHotspotSearch() {
  const hs = state.hotspot;
  hs.query = $("#hotspot-query").value.trim();
  state.formDraft.model = $("#hotspot-model").value;
  const btn = $("#btn-search-hotspot"); btn.disabled = true; btn.textContent = "正在启动检索…";
  try {
    const r = await api("start_collect", { query: hs.query, window_hours: hs.windowHours, region: hs.region,
      categories: hs.categories, model_key: state.formDraft.model });
    if (!r.ok && !r.job_id) { toast(r.error || "启动检索失败"); btn.disabled = false; btn.textContent = "开始深度检索"; return; }
    hs.search = { id: r.search_id || hs.search?.id, query: hs.query, window_hours: hs.windowHours, region: hs.region, categories: hs.categories, status: "queued", coverage: {} };
    hs.results = []; hs.detail = null;
    hs.activeJob = { jobId: r.job_id, state: "queued", phase: "collect", progress: 0, message: "热点检索已转入后台" };
    localStorage.setItem(HOTSPOT_JOB_STORAGE_KEY, r.job_id);
    render(); runHotspotPoll(r.job_id);
  } catch (_) { btn.disabled = false; btn.textContent = "开始深度检索"; }
}

function runHotspotPoll(jobId, { resumed = false } = {}) {
  const hs = state.hotspot;
  if (hs.pollStop && hs.pollJobId === jobId) return;
  if (hs.pollStop) hs.pollStop();
  hs.pollJobId = jobId; localStorage.setItem(HOTSPOT_JOB_STORAGE_KEY, jobId);
  if (resumed) toast("已恢复热点检索，继续同步覆盖进度");
  hs.pollStop = pollRecursive(async () => {
    const r = await api("collect_status", { job_id: jobId });
    if (!r.ok || !r.status) {
      hs.pollStop?.(); hs.pollStop = null; hs.pollJobId = ""; hs.activeJob = null; localStorage.removeItem(HOTSPOT_JOB_STORAGE_KEY);
      toast(r.error || "热点检索任务无法恢复"); render(); return;
    }
    const st = r.status; hs.activeJob = { ...st, jobId };
    if (state.tab === "write" && state.writeMode === "hotspot" && !state.selectedTopic) render();
    if (["done", "failed", "cancelled"].includes(st.state)) {
      hs.pollStop?.(); hs.pollStop = null; hs.pollJobId = ""; hs.activeJob = null; localStorage.removeItem(HOTSPOT_JOB_STORAGE_KEY);
      if (st.state === "done") { await loadHotspots(st.searchId || hs.search?.id); toast(`检索完成：得到 ${st.resultCount || 0} 个独立热点`); }
      else { toast(st.state === "cancelled" ? "已取消热点检索" : `热点检索失败：${st.error || st.message || "未知错误"}`); render(); }
    }
  }, 2200);
}

async function loadHotspots(searchId) {
  const hs = state.hotspot;
  const r = await api("list_hotspots", { search_id: searchId || "", sort: hs.sort, limit: 30 });
  if (!r.ok) return toast(r.error || "热点加载失败");
  hs.search = r.search || hs.search; hs.results = r.hotspots || [];
  hs.detail = hs.results.find((x) => x.id === hs.detail?.id) || hs.results[0] || null;
  hs.selectedAngle = 0; hs.selectedTitle = 0; render();
}

async function onStopHotspot() {
  const hs = state.hotspot; if (!hs.activeJob?.jobId) return;
  const r = await api("stop_collect", { job_id: hs.activeJob.jobId });
  if (r.ok) { hs.pollStop?.(); hs.pollStop = null; hs.activeJob = null; hs.pollJobId = ""; localStorage.removeItem(HOTSPOT_JOB_STORAGE_KEY); toast("已取消热点检索"); render(); }
}

async function onSelectHotspot() {
  const hs = state.hotspot, h = hs.detail; if (!h) return;
  const angle = h.angles?.[hs.selectedAngle] || h.angles?.[0] || {};
  const title = h.title_candidates?.[hs.selectedTitle] || h.title;
  const btn = $("#btn-select-hotspot"); btn.disabled = true; btn.textContent = "正在生成选题…";
  const r = await api("create_topic_from_hotspot", { hotspot_id: h.id, title,
    angle: angle.text || angle, framework: angle.framework || "interpretation" });
  if (!r.ok) { btn.disabled = false; btn.textContent = "选择此热点和角度"; return toast(r.error || "创建选题失败"); }
  const p = r.prefill || {};
  state.selectedTopic = { topic_id: r.topic_id, cluster_id: r.cluster_id, hotspot: r.hotspot || h };
  state.formDraft = { title: p.title || title, angle: p.angle || angle.text || "", framework: p.framework || angle.framework || "interpretation",
    audience: p.audience || "", refs: (p.referenceUrls || []).join("\n"), questions: p.questions || "", model: state.formDraft.model || "",
    autoImages: state.formDraft.autoImages !== false, imageCount: state.formDraft.imageCount || 3 };
  state.writeMode = "hotspot"; localStorage.setItem("wechat-article-write-mode", "hotspot"); render();
  toast("已带入热点、写作角度和可信来源，可继续调整");
}

async function onClarify() {
  const title = $("#f-title").value.trim();
  if (!title) return toast("先填主题");
  const btn = $("#btn-clarify"); btn.disabled = true; btn.textContent = "AI 思考中…";
  try {
    const r = await api("clarify_topic", { title, model_key: $("#f-model").value });
    if (r.ok) {
      if (r.core_claim) $("#f-angle").value = (r.core_claim || "") + ($("#f-angle").value ? "\n" + $("#f-angle").value : "");
      if (r.audience) $("#f-audience").value = r.audience;
      if (r.framework && ["interpretation", "opinion", "list"].includes(r.framework)) $("#f-framework").value = r.framework;
      if (Array.isArray(r.questions)) $("#f-questions").value = r.questions.map((q) => "- " + q).join("\n");
      toast("已补全，可再手动调整");
    } else toast(r.error || "补全失败");
  } finally { btn.disabled = false; btn.textContent = state.selectedTopic ? "AI 重新生成角度与核实问题" : "AI 补全角度与待核实问题"; }
}

async function onStart() {
  const title = $("#f-title").value.trim();
  if (!title) return toast("先填主题");
  const btn = $("#btn-start"); btn.disabled = true;
  const params = {
    topic_id: state.selectedTopic?.topic_id || "",
    hotspot_id: state.selectedTopic?.cluster_id || "",
    title,
    angle: $("#f-angle").value.trim(),
    framework: $("#f-framework").value,
    audience: $("#f-audience").value.trim(),
    referenceUrls: $("#f-refs").value.split("\n").map((s) => s.trim()).filter(Boolean),
    questions: $("#f-questions").value.trim(),
    model_key: $("#f-model").value,
    auto_images: $("#f-auto-images").checked,
    image_count: Number($("#f-image-count").value) || 3,
  };
  captureFormDraft();
  try {
    const r = await api("start_article", params);
    if (!r.ok) { toast(r.error || "启动失败"); btn.disabled = false; return; }
    state.completedJob = null;
    state.activeJob = { jobId: r.job_id, state: "queued", phase: "init", progress: 0, message: "已转入后台队列" };
    localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, r.job_id);
    btn.textContent = "后台生成中…";
    paintJobStatus();
    toast("已在后台生成，可安全切换页面；回来后会自动恢复进度");
    runJobPoll(r.job_id);
  } catch (_) { btn.disabled = false; }
}

function runJobPoll(jobId, { resumed = false } = {}) {
  if (state.pollStop && state.pollJobId === jobId) return;
  if (state.pollStop) state.pollStop();
  state.pollJobId = jobId;
  localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, jobId);
  if (resumed) toast("已恢复后台生成任务，继续同步进度");
  state.pollStop = pollRecursive(async () => {
    const s = await api("job_status", { job_id: jobId });
    if (!s.ok) {
      state.pollStop && state.pollStop(); state.pollStop = null; state.pollJobId = "";
      state.activeJob = null;
      state.completedJob = { jobId, state: "failed", phase: "error", progress: 0, error: s.error || "后台任务不存在或无法恢复" };
      localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
      paintJobStatus();
      return;
    }
    const st = s.status;
    if (!st) return;
    state.activeJob = { ...st, jobId };
    paintJobStatus();
    if (TERMINAL_JOB_STATES.has(st.state)) {
      state.pollStop && state.pollStop(); state.pollStop = null;
      state.pollJobId = "";
      state.activeJob = null;
      state.completedJob = { ...st, jobId };
      localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
      if (st.articleId) {
        await refreshArticles();
        if (state.tab === "write" && (!state.current || state.current.article?.id === st.articleId)) await loadArticle(st.articleId);
        else toast("✅ 初稿已在后台生成，点击顶部状态可打开");
      } else if (st.state === "failed") {
        toast("生成失败：" + (st.error || st.message || "未知错误"));
        const btn = $("#btn-start"); if (btn) { btn.disabled = false; btn.textContent = "重新生成初稿"; }
      } else if (st.state === "unknown_external_result") toast("推送超时，结果未知，请到公众号后台核对");
      paintJobStatus();
    }
  }, 2500);
}

const phases = { init: "排队", research: "检索资料", outline: "拟定大纲", write: "撰写正文", review: "去 AI 味 + 主张账本",
  images: "检索配图与标注", export: "整理图文压缩包", render: "渲染", upload: "推送到草稿箱", done: "已完成", error: "生成失败" };

function paintJobStatus() {
  const current = state.activeJob || state.completedJob;
  const indicator = $("#job-indicator");
  if (indicator) {
    indicator.hidden = !current;
    if (current) {
      const pct = Math.round((current.progress || 0) * 100);
      indicator.classList.toggle("failed", current.state === "failed");
      indicator.classList.toggle("ready", !!current.articleId);
      indicator.textContent = current.articleId ? "初稿已生成 · 点击打开"
        : current.state === "failed" ? "生成失败 · 点击查看"
        : `后台生成 ${pct}% · ${phases[current.phase] || current.state}`;
    }
  }
  const box = $("#progress");
  if (!box) return;
  if (!current) { box.innerHTML = ""; return; }
  const pct = Math.max(5, Math.round((current.progress || 0) * 100));
  const failed = current.state === "failed";
  box.innerHTML = `<div class="progress ${failed ? "failed" : ""}">
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="msg">${esc(phases[current.phase] || current.state)} · ${esc(current.error || current.message || "")}</div>
    ${state.activeJob ? '<div class="background-note">任务正在服务器后台运行，可以切换 Tab、离开或关闭当前页面。</div>' : ""}
  </div>`;
}

async function onJobIndicatorClick() {
  const job = state.completedJob;
  if (job?.articleId) { state.tab = "write"; await loadArticle(job.articleId); return; }
  state.tab = "write"; render();
}

async function refreshArticles() {
  try { const r = await api("list_articles"); state.articles = r.articles || []; } catch (_) {}
}

async function loadArticle(id) {
  const r = await api("get_article", { article_id: id });
  if (!r.ok) return toast(r.error || "加载失败");
  state.current = { article: r.article, evidence: r.evidence || [], claims: r.claims || [], images: r.images || [] };
  if (state.completedJob?.articleId === id) state.completedJob = null;
  render();
  renderEditor();
}

function renderEditor() {
  const a = state.current.article;
  const lint = a.quality && a.quality.lint;
  const imageHtml = (state.current.images || []).map((image) => `<div class="article-image-card">
    <img src="${esc(privateAssetUrl(image.asset_rel))}" alt="${esc(image.alt_text || image.caption)}"/>
    <div><b>图${image.position} · ${esc(image.caption || image.filename)}</b><small>${esc(image.filename)} · ${Math.round((image.bytes || 0) / 1024)} KB</small>
      <span>${esc(image.author || "未知作者")} · ${esc(image.license || "许可未知")}</span>
      <a href="${esc(safeUrl(image.source_page_url || image.source_url))}" target="_blank" rel="noreferrer">查看图片来源与许可</a></div></div>`).join("") || '<div class="muted" style="padding:10px">当前没有正文配图，可点击“自动检索配图”。</div>';
  const evHtml = state.current.evidence.map((e) => `<div class="item"><div class="src"><span class="tag ${e.tier}">${e.tier}</span> ${esc(e.source_name)}</div><div class="ex">${esc((e.excerpt || "").slice(0, 140))}</div></div>`).join("") || '<div class="muted" style="padding:10px">无证据</div>';
  const claimsHtml = state.current.claims.map((c) => `<div class="claim"><div class="row"><span class="tag ${c.risk}">${c.risk}</span><span class="tag">${c.relation}</span>${c.resolved ? '<span class="tag">已处理</span>' : ""}</div><div class="tx">${esc(c.claim_text)}</div>${c.resolved ? "" : `<button data-cid="${c.id}">标记已核实</button>`}</div>`).join("") || '<div class="muted" style="padding:10px">无主张</div>';
  $("#view").innerHTML = `
    <section class="card">
      <div class="editor-meta">
        <input id="e-title" type="text" value="${esc(a.title)}" placeholder="标题（≤32 字）"/>
        <input id="e-digest" type="text" value="${esc(a.digest)}" placeholder="摘要（≤120 字）"/>
      </div>
      <div class="editor-body">
        <div class="pane"><div class="head">Markdown 正文</div><textarea id="e-md">${esc(a.body_md)}</textarea></div>
        <div class="pane"><div class="head">375px 微信预览</div><div class="phone"><div class="preview-content" id="e-prev"></div></div></div>
        <div class="pane aside evidence"><div class="head">正文配图 / 证据 / 主张账本</div><div class="article-images">${imageHtml}</div>${evHtml}${claimsHtml}</div>
      </div>
      <div class="editor-actions">
        <button id="btn-save" class="primary">保存</button>
        <button id="btn-versions" class="btn">历史版本</button>
        <button id="btn-regen-cover" class="btn">生成封面</button>
        <button id="btn-images" class="btn">${state.current.images?.length ? "重新检索配图" : "自动检索配图"}</button>
        <button id="btn-download" class="primary">下载图文包 ZIP</button>
        <button id="btn-push" class="btn">推送到草稿箱</button>
        <span id="lint-sum" class="lint-summary"></span>
        <div class="spacer" style="flex:1"></div>
        <button id="btn-back" class="btn">返回新建</button>
      </div>
      <div id="versions" style="margin-top:12px"></div>
    </section>`;
  const md = $("#e-md"), prev = $("#e-prev");
  const refresh = () => { prev.innerHTML = mdToHtml(md.value, a.id); updateLint(); };
  md.oninput = debounce(refresh, 250);
  refresh();
  updateLint();
  $("#btn-save").onclick = onSave;
  $("#btn-back").onclick = () => { state.current = null; render(); };
  $("#btn-versions").onclick = onVersions;
  $("#btn-regen-cover").onclick = onCover;
  $("#btn-images").onclick = onImages;
  $("#btn-download").onclick = onDownloadPackage;
  $("#btn-push").onclick = onPush;
  $$("[data-cid]").forEach((b) => b.onclick = async () => {
    const r = await api("resolve_claim", { claim_id: b.dataset.cid });
    if (r.ok) { const c = state.current.claims.find((x) => x.id === b.dataset.cid); if (c) c.resolved = 1; renderEditor(); }
  });
}
function updateLint() {
  const el = $("#lint-sum"); if (!el) return;
  const lint = state.current.article.quality && state.current.article.quality.lint;
  if (!lint) { el.className = "lint-summary"; el.textContent = ""; return; }
  if (lint.ok) { el.className = "lint-summary ok"; el.textContent = `主张账本通过（${lint.stats.claims} 条，高风险 ${lint.stats.high_risk}）`; }
  else { el.className = "lint-summary block"; el.textContent = `${lint.blockers.length} 项阻断：` + lint.blockers.slice(0, 2).join("；"); }
}
async function onSave() {
  const a = state.current.article;
  const r = await api("save_article", { article_id: a.id, title: $("#e-title").value, digest: $("#e-digest").value, body_md: $("#e-md").value });
  if (r.ok) { state.current.article = r.article; toast("已保存（含历史版本）"); return true; }
  return false;
}
async function onVersions() {
  const r = await api("list_versions", { article_id: state.current.article.id });
  const box = $("#versions");
  if (!r.ok) return toast(r.error);
  box.innerHTML = '<div class="muted" style="margin:6px 0">历史版本（点击恢复）</div>' + r.versions.map((v) => `<div class="list-item" data-vid="${v.id}"><div class="t">v${v.version_no} · ${esc(v.title)}</div><div class="d">${esc(v.created_at)} ${esc(v.note||"")}</div></div>`).join("");
  $$("[data-vid]").forEach((el) => el.onclick = async () => {
    const rr = await api("restore_version", { version_id: el.dataset.vid });
    if (rr.ok) { await loadArticle(state.current.article.id); toast("已恢复"); }
  });
}
async function onCover() {
  const r = await api("generate_cover", { title: $("#e-title").value, subtitle: $("#e-digest").value });
  if (r.ok) { toast(r.need_rasterize ? "生成 SVG 占位封面（无 sharp，需手动栅格化）" : "封面已生成"); }
  else toast(r.error || "失败");
}
async function onImages() {
  if (!await onSave()) return;
  const btn = $("#btn-images"); btn.disabled = true; btn.textContent = "正在启动配图检索…";
  const imageCount = Math.max(1, Math.min(Number(state.config?.budgets?.per_article_images) || state.current.images?.length || 3, 6));
  try {
    const r = await api("start_images", { article_id: state.current.article.id, image_count: imageCount });
    if (!r.ok) { btn.disabled = false; btn.textContent = "重新检索配图"; return toast(r.error || "启动失败"); }
    state.completedJob = null;
    state.activeJob = { jobId: r.job_id, state: "queued", phase: "images", progress: 0, message: "配图检索已转入后台" };
    localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, r.job_id);
    paintJobStatus();
    toast("正在后台检索并标注配图，可安全离开页面");
    runJobPoll(r.job_id);
  } catch (_) { btn.disabled = false; btn.textContent = "重新检索配图"; }
}
async function onDownloadPackage() {
  if (!await onSave()) return;
  const btn = $("#btn-download"); btn.disabled = true; btn.textContent = "正在整理图文包…";
  try {
    const r = await api("prepare_export", { article_id: state.current.article.id });
    if (!r.ok || !r.package?.download_path) return toast(r.error || "图文包生成失败");
    const link = document.createElement("a");
    link.href = privateAssetUrl(r.package.download_path);
    link.download = r.package.filename || "公众号图文包.zip";
    document.body.appendChild(link); link.click(); link.remove();
    toast(`已打包文档和 ${r.package.image_count || 0} 张图片`);
  } finally { btn.disabled = false; btn.textContent = "下载图文包 ZIP"; }
}
async function onPush() {
  if (!(state.config && state.config.wx_configured)) return toast("请先在设置页配置微信 AppID/AppSecret");
  await onSave();
  const r = await api("push_draft", { article_id: state.current.article.id });
  if (!r.ok) return toast(r.error || "推送失败");
  toast("正在推送…");
  state.pollStop = pollRecursive(async () => {
    const s = await api("job_status", { job_id: r.job_id });
    const st = s.status; if (!st) return;
    if (st.state === "done") { state.pollStop && state.pollStop(); state.pollStop = null; toast("✅ 已推送至公众号草稿箱，请到后台预览与发布"); }
    else if (st.state === "unknown_external_result") { state.pollStop && state.pollStop(); state.pollStop = null; toast("推送超时，结果未知，请到后台核对"); }
    else if (st.state === "failed") { state.pollStop && state.pollStop(); state.pollStop = null; toast("推送失败：" + (st.error || "")); }
  }, 2500);
}

// ---------- 文章列表 ----------
function renderList() {
  $("#view").innerHTML = `<section class="card"><h2>我的文章（${state.articles.length}）</h2>
    <div id="alist"></div></section>`;
  const box = $("#alist");
  if (!state.articles.length) { box.innerHTML = '<p class="muted">还没有文章，去「选题/写作」生成第一篇。</p>'; return; }
  box.innerHTML = state.articles.map((a) => `<div class="list-item" data-id="${a.id}"><div class="t">${esc(a.title||"未命名")}</div><span class="tag">${esc(a.state||"")}</span><div class="d">${esc(a.updated_at||"")}</div></div>`).join("");
  $$("[data-id]").forEach((el) => el.onclick = async () => { state.tab = "write"; await loadArticle(el.dataset.id); });
}

// ---------- 设置 ----------
function renderSettings() {
  const c = state.config || {};
  const p = c.account_profile || {}, st = c.style || {}, b = c.budgets || {};
  const chOpts = state.channels.map((x) => `<option value="${x.key}" ${x.key === c.model_key ? "selected" : ""}>${esc(x.label)} · ${esc(x.model)}</option>`).join("");
  $("#view").innerHTML = `
    <section class="card"><h2>账号画像</h2>
      <div class="grid2">
        <label><span>账号定位</span><input id="p-pos" type="text" value="${esc(p.positioning)}"/></label>
        <label><span>目标读者</span><input id="p-aud" type="text" value="${esc(p.audience)}"/></label>
        <label><span>语气</span><input id="p-tone" type="text" value="${esc(p.tone)}"/></label>
        <label><span>商业目标</span><input id="p-goal" type="text" value="${esc(p.goals)}"/></label>
      </div>
      <label><span>禁写范围</span><input id="p-forbid" type="text" value="${esc(p.forbidden)}"/></label>
      <button id="btn-save-profile" class="primary">保存画像</button>
    </section>
    <section class="card"><h2>风格档案</h2>
      <div class="grid2">
        <label><span>语气倾向</span><input id="s-tone" type="text" value="${esc(st.tone)}"/></label>
        <label><span>观点强度</span><input id="s-op" type="text" value="${esc(st.opinion_strength)}"/></label>
      </div>
      <label><span>禁用表达（逗号分隔）</span><input id="s-ban" type="text" value="${esc(st.banned_phrases)}"/></label>
      <button id="btn-save-style" class="primary">保存风格</button>
    </section>
    <section class="card"><h2>微信草稿箱凭据</h2>
      <div class="muted">当前：${c.wx_configured ? "已配置（" + esc(c.wx_appid_masked) + "）" : "未配置"}。需公众号拥有草稿接口权限，且服务器出口 IP 在白名单。</div>
      <div class="grid2">
        <label><span>AppID</span><input id="wx-appid" type="text" placeholder="${c.wx_appid_masked || "wx..."}"/></label>
        <label><span>AppSecret</span><input id="wx-secret" type="password" placeholder="${c.wx_configured ? "已保存（留空不改）" : ""}"/></label>
      </div>
      <button id="btn-save-wx" class="primary">保存凭据</button>
    </section>
    <section class="card"><h2>生成与预算</h2>
      <div class="grid2">
        <label><span>默认模型</span><select id="cfg-model"><option value="">默认</option>${chOpts}</select></label>
        <label><span>AI 辅助声明（文末）</span><input id="cfg-decl" type="text" value="${esc(c.ai_declaration)}"/></label>
        <label><span>每篇搜索次数</span><input id="b-search" type="text" value="${b.per_article_search ?? 6}"/></label>
        <label><span>每篇正文配图数（1–6）</span><input id="b-images" type="text" value="${b.per_article_images ?? 3}"/></label>
        <label><span>每篇 Token 上限</span><input id="b-tok" type="text" value="${b.per_article_tokens ?? 20000}"/></label>
        <label><span>每篇金额上限（元）</span><input id="b-amt" type="text" value="${b.per_article_amount ?? 2}"/></label>
        <label><span>每日金额上限（元）</span><input id="b-day" type="text" value="${b.daily_amount ?? 20}"/></label>
      </div>
      <label class="check-row settings-check"><input id="cfg-inline-images" type="checkbox" ${c.inline_images !== false ? "checked" : ""}/><span><b>新文章默认自动检索配图</b><small>图片会自动编号、写入图注并随文档一起打包下载</small></span></label>
      <div class="row">
        <button id="btn-save-cfg" class="primary">保存配置</button>
        <button id="btn-test" class="btn">测试模型连通</button>
        <span class="muted">${c.crypto_available ? "" : "⚠ 缺主密钥，凭据无法加密保存"}</span>
      </div>
    </section>`;
  $("#btn-save-profile").onclick = async () => {
    const r = await api("save_account_profile", { profile: { positioning: $("#p-pos").value, audience: $("#p-aud").value, tone: $("#p-tone").value, goals: $("#p-goal").value, forbidden: $("#p-forbid").value } });
    if (r.ok) { state.config = r.config; toast("画像已保存"); }
  };
  $("#btn-save-style").onclick = async () => {
    const r = await api("save_style_profile", { style: { tone: $("#s-tone").value, opinion_strength: $("#s-op").value, banned_phrases: $("#s-ban").value } });
    if (r.ok) { state.config = r.config; toast("风格已保存"); }
  };
  $("#btn-save-wx").onclick = async () => {
    const wx = {};
    if ($("#wx-appid").value) wx.appid = $("#wx-appid").value.trim();
    if ($("#wx-secret").value) wx.secret = $("#wx-secret").value.trim();
    const r = await api("save_config", { config: { wx } });
    if (r.ok) { state.config = r.config; toast("凭据已加密保存"); render(); }
  };
  $("#btn-save-cfg").onclick = async () => {
    const r = await api("save_config", { config: { model_key: $("#cfg-model").value, ai_declaration: $("#cfg-decl").value,
      inline_images: $("#cfg-inline-images").checked,
      budgets: { per_article_search: Number($("#b-search").value) || 6, per_article_tokens: Number($("#b-tok").value) || 20000,
        per_article_images: Math.max(1, Math.min(Number($("#b-images").value) || 3, 6)),
        per_article_amount: Number($("#b-amt").value) || 2, daily_amount: Number($("#b-day").value) || 20 } } });
    if (r.ok) { state.config = r.config; state.formDraft.autoImages = r.config.inline_images !== false;
      state.formDraft.imageCount = r.config.budgets?.per_article_images || 3; toast("配置已保存"); }
  };
  $("#btn-test").onclick = async () => {
    const btn = $("#btn-test"); btn.disabled = true; btn.textContent = "测试中…";
    const r = await api("test_provider", { model_key: $("#cfg-model").value });
    btn.disabled = false; btn.textContent = "测试模型连通";
    toast(r.ok && r.alive ? "✅ 连通：" + r.model : "❌ " + (r.error || "无响应"));
  };
}

bootstrap();
