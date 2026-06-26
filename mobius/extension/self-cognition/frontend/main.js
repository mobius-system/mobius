import { extCall } from '/extension/_sdk/ext.js';
import { initLogoBackdrop } from './mobius3d.js';
import { initMobiusRing } from './mobius-ring.js';

const labels = {
  category: {
    'office-agent': '办公智能体',
    'coding-agent': '编码智能体',
    'general-agent': '通用智能体',
    'workflow-agent': '工作流智能体',
    'personal-agent': '个人助理',
    'research-agent': '研究智能体',
    other: '其他',
  },
  status: {
    official: '已跟踪',
    candidate: '候选',
  },
};

const localKey = 'mobius-self-cognition-ui-state-v2';

const state = {
  summary: {},
  keywords: { paper: [], product: [] },
  competitors: { official: [], candidate: [] },
  papers: { items: [], total: 0 },
  paperClusters: [],
  clusterPapers: {},
  topPicks: [],
  radarTopPicks: [],
  feedbacks: {},
  feedbackPending: {},
  mockClusters: null,
  mockEvolution: null,
  backendStatus: { clusters: 'unknown', feedbacks: 'unknown' },
  evolution: {
    level: 'L1',
    projectId: '',
    source: 'unknown',
    feeds: { L1: [], L2: [], L3: [] },
    offsets: { L1: 0, L2: 0, L3: 0 },
    totals: { L1: 0, L2: 0, L3: 0 },
    expanded: {},
    pending: {},
  },
  products: { items: [], total: 0 },
  scanRuns: [],
  constants: {},
  tab: 'papers',
  scanning: { paper: false, product: false },
  filters: {
    paper: { q: '', keyword: '', status: '', favorite: '' },
    competitor: { q: '', status: '', read: '' },
  },
  aiChannels: [],
  aiChannel: { paper: '', product: '' },
  aiScanning: { paper: false, product: false },
  showExcluded: { paper: false, competitor: false },
  local: loadLocalState(),
};

const $ = (id) => document.getElementById(id);
document.documentElement.dataset.section = 'paper';
let heroRing = null;
const detailChats = new Map();
const detailPending = {};

const DEFAULT_CHANNEL_LABEL_FALLBACK = 'GLM-5.2';

function parseInspiration(raw) {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((it) => it && typeof it === 'object').map((it) => ({
      title: String(it.title || it.direction || '').slice(0, 200),
      direction: String(it.direction || it.title || '').slice(0, 600),
      mobius_use: String(it.mobius_use || it.use || it.application || '').slice(0, 1200),
      priority: ['high', 'medium', 'low'].includes(it.priority) ? it.priority : 'medium',
    }));
  } catch {
    return [];
  }
}

function inspirationBadgeCount(items) {
  const high = items.filter((i) => i.priority === 'high').length;
  const med = items.filter((i) => i.priority === 'medium').length;
  const low = items.filter((i) => i.priority === 'low').length;
  return { high, med, low, total: items.length };
}

function loadLocalState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(localKey) || '{}');
    return {
      papers: parsed.papers && typeof parsed.papers === 'object' ? parsed.papers : {},
      competitors: parsed.competitors && typeof parsed.competitors === 'object' ? parsed.competitors : {},
    };
  } catch {
    return { papers: {}, competitors: {} };
  }
}

function saveLocalState() {
  localStorage.setItem(localKey, JSON.stringify(state.local));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function shortText(value, max = 260) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatTime(value) {
  if (!value) return '尚未运行';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatChatTime(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function timeValue(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function showToast(message, tone = 'ok') {
  const toast = $('toast');
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add('is-visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
}

function confirmDialog({ title, body, confirmText = '确认', cancelText = '取消' }) {
  const dialog = $('confirmDialog');
  $('confirmTitle').textContent = title || '请确认';
  $('confirmBody').textContent = body || '';
  $('confirmOk').textContent = confirmText;
  $('confirmCancel').textContent = cancelText;
  return new Promise((resolve) => {
    const cleanup = () => {
      dialog.removeEventListener('close', onClose);
      dialog.removeEventListener('cancel', onClose);
      $('confirmForm').removeEventListener('submit', onSubmit);
      $('confirmCancel').removeEventListener('click', onCancel);
    };
    const onClose = () => { cleanup(); resolve(dialog.returnValue === 'ok'); };
    const onSubmit = (event) => {
      event.preventDefault();
      dialog.close($('confirmOk').value || 'ok');
    };
    const onCancel = () => dialog.close('cancel');
    dialog.addEventListener('close', onClose);
    dialog.addEventListener('cancel', onClose);
    $('confirmForm').addEventListener('submit', onSubmit);
    $('confirmCancel').addEventListener('click', onCancel);
    dialog.showModal();
  });
}

const LATEST_BATCH_LIMIT = 5;
function renderLatestBatch(kind, items, title) {
  const root = $(`latestBatch${kind.charAt(0).toUpperCase() + kind.slice(1)}`);
  const list = $(`latestBatch${kind.charAt(0).toUpperCase() + kind.slice(1)}List`);
  const titleEl = $(`latestBatch${kind.charAt(0).toUpperCase() + kind.slice(1)}Title`);
  if (!root || !list) return;
  if (!Array.isArray(items) || !items.length) { root.hidden = true; return; }
  titleEl.textContent = title || '本轮新增';
  const shown = items.slice(0, LATEST_BATCH_LIMIT);
  const rest = items.length - shown.length;
  list.innerHTML = shown.map((item) => {
    if (kind === 'paper') {
      return `<article class="latest-batch-item" data-paper-detail="${escapeHtml(item.id)}">${escapeHtml(shortText(item.title, 90))}</article>`;
    }
    if (kind === 'product') {
      return `<article class="latest-batch-item" data-product-detail="${escapeHtml(item.id)}">${escapeHtml(shortText(item.name || item.source_url, 60))}</article>`;
    }
    return `<article class="latest-batch-item">${escapeHtml(shortText(item.summary, 90))}</article>`;
  }).join('') + (rest > 0 ? `<div class="latest-batch-more">+${rest}</div>` : '');
  root.hidden = false;
  root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closeLatestBatch(kind) {
  const root = $(`latestBatch${kind.charAt(0).toUpperCase() + kind.slice(1)}`);
  if (root) root.hidden = true;
}

async function call(payload) {
  const result = await extCall(payload);
  if (!result.ok) throw new Error(result.error || '调用失败');
  return result;
}

async function loadAiChannels() {
  try {
    const result = await call({ action: 'list_ai_channels' });
    state.aiChannels = Array.isArray(result.channels) ? result.channels : [];
    if (!state.aiChannel.paper) state.aiChannel.paper = result.default_key || state.aiChannels[0]?.key || '';
    if (!state.aiChannel.product) state.aiChannel.product = result.default_key || state.aiChannels[0]?.key || '';
  } catch {
    state.aiChannels = [];
  }
  renderAiChannelSelectors();
}

function renderAiChannelSelectors() {
  for (const kind of ['paper', 'product']) {
    const select = $(`${kind}AiChannel`);
    if (!select) continue;
    const current = state.aiChannel[kind];
    select.innerHTML = state.aiChannels.length
      ? state.aiChannels.map((c) => `<option value="${escapeHtml(c.key)}"${c.key === current ? ' selected' : ''}>${escapeHtml(c.label || c.key)}</option>`).join('')
      : '<option value="">无可用渠道</option>';
    if (current) select.value = current;
  }
}

function estimateAiCost({ kind, count }) {
  const perItem = kind === 'paper' ? 18 : 32;
  const seconds = Math.max(8, Math.round(count * perItem));
  const inTokens = count * 17000;
  const outTokens = count * 480;
  return { seconds, inTokens, outTokens };
}

function formatAiCost({ seconds, inTokens, outTokens }) {
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  const time = min > 0 ? `${min}分${sec.toString().padStart(2, '0')}秒` : `${sec}秒`;
  const inK = Math.round(inTokens / 1000);
  const outK = Math.round(outTokens / 1000);
  return `${time} · 输入 ~${inK}k · 输出 ~${outK}k tokens`;
}

async function loadMockClusters() {
  if (state.mockClusters) return state.mockClusters;
  const response = await fetch('mock_clusters.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`mock_clusters.json HTTP ${response.status}`);
  state.mockClusters = await response.json();
  return state.mockClusters;
}

async function loadMockEvolution() {
  if (state.mockEvolution) return state.mockEvolution;
  const response = await fetch('mock_evolution.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`mock_evolution.json HTTP ${response.status}`);
  state.mockEvolution = await response.json();
  return state.mockEvolution;
}

function eventId(item, fallback = '') {
  return item?.id || item?.event_id || item?.commit_sha || fallback;
}

function normalizeEvolutionEvent(item, level, index = 0) {
  const id = eventId(item, `${level}-${index}`);
  return {
    ...item,
    id,
    level,
    commit_sha: item.commit_sha || item.sha || '',
    summary: item.summary || item.title || '未命名自进化事件',
    diff_summary: item.diff_summary || item.description || '',
    created_at: item.created_at || item.timestamp || item.time || '',
    project_id: item.project_id || item.project || 'self-cognition',
    actor: item.actor || item.operator || item.created_by || 'Mobius',
    files_changed: Array.isArray(item.files_changed) ? item.files_changed : [],
    status: item.status || (level === 'L2' ? 'pending' : 'recorded'),
  };
}

function paperId(item) {
  return item?.paper_id || item?.id || item?.source_id || item?.source_url || '';
}

function scoreOf(item) {
  return Number(item?.priority_score ?? item?.relevance ?? item?.score ?? 0) || 0;
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return String(value).split(/[,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
}

function normalizePaper(item, clusterLabel = '') {
  const id = paperId(item);
  return {
    ...item,
    id,
    paper_id: id,
    cluster_label: item.cluster_label || item.cluster || clusterLabel,
    title: item.title || 'Untitled paper',
    abstract: item.abstract || item.summary || '',
    priority_score: scoreOf(item),
    relevance: Number(item.relevance ?? item.priority_score ?? 0) || 0,
    matched_keywords: normalizeKeywords(item.matched_keywords || item.keywords || item.cluster_keywords),
    tags: normalizeKeywords(item.tags),
  };
}

function clusterTitle(label) {
  const known = {
    'agent-harness': 'Agent Harness 与执行框架',
    'recursive-self-reference': '递归自指与自我改进',
    'godel-agents': '哥德尔智能体',
    'self-evolution': '自进化系统',
  };
  if (known[label]) return known[label];
  return String(label || '未命名 cluster')
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function normalizeCluster(item) {
  const label = item.label || item.cluster_label || item.title || '未命名 cluster';
  return {
    ...item,
    label,
    title: item.title || clusterTitle(label),
    keywords: normalizeKeywords(item.keywords || item.cluster_keywords || item.matched_keywords),
    paper_count: Number(item.paper_count ?? item.count ?? 0) || 0,
    max_score: Number(item.max_score ?? item.priority_score ?? item.score ?? 0) || 0,
    loaded: false,
    expanded: !!item.expanded,
    offset: 0,
    has_more: true,
  };
}

function feedbackFromRows(rows) {
  const out = {};
  for (const row of rows || []) {
    const id = row.paper_id || row.id;
    const verdict = row.verdict || row.feedback;
    if (id && verdict) out[id] = verdict;
  }
  return out;
}

function clusterDomId(label) {
  return `cluster-${encodeURIComponent(label).replace(/%/g, '')}`;
}

function paperLocal(id) {
  if (!state.local.papers[id]) state.local.papers[id] = { read: false, favorite: false, archived: false };
  return state.local.papers[id];
}

function competitorLocal(id) {
  if (!state.local.competitors[id]) state.local.competitors[id] = { read: false };
  return state.local.competitors[id];
}

function keywordLine(item) {
  return item.query && item.query !== item.keyword ? `${item.keyword} | ${item.query}` : item.keyword;
}

function parseKeywordTextarea(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [keyword, ...rest] = line.split('|');
      const cleanKeyword = keyword.trim();
      return {
        keyword: cleanKeyword,
        query: rest.join('|').trim() || cleanKeyword,
        enabled: true,
        sort_order: index,
      };
    });
}

function allCompetitors() {
  return [
    ...(state.competitors.official || []),
    ...(state.competitors.candidate || []),
  ];
}

function findPaperById(id) {
  const item = Object.values(state.clusterPapers).flat().find((paper) => paper.id === id)
    || (state.papers.items || []).find((paper) => paper.id === id || paper.paper_id === id || paper.source_id === id)
    || (state.radarTopPicks || []).find((paper) => paper.id === id)
    || (state.topPicks || []).find((paper) => paper.id === id);
  return item ? normalizePaper(item, item.cluster_label || item.cluster || '') : null;
}

function findProductById(id) {
  return allCompetitors().find((product) => product.id === id) || null;
}

function allPaperDiscoveries() {
  const byId = new Map();
  const add = (item, clusterLabel = '') => {
    if (!item) return;
    const paper = normalizePaper(item, item.cluster_label || item.cluster || clusterLabel);
    if (!paper.id) return;
    const existing = byId.get(paper.id);
    if (!existing || scoreOf(paper) > scoreOf(existing)) byId.set(paper.id, paper);
  };
  (state.papers.items || []).forEach((item) => add(item));
  Object.entries(state.clusterPapers || {}).forEach(([clusterLabel, papers]) => {
    (papers || []).forEach((item) => add(item, clusterLabel));
  });
  (state.radarTopPicks || []).forEach((item) => add(item));
  (state.topPicks || []).forEach((item) => add(item));
  return [...byId.values()];
}

function isPaperUnprocessed(item) {
  const local = paperLocal(item.id);
  return !local.read
    && !local.favorite
    && !local.archived
    && !local.reviewed
    && !state.feedbacks[item.id];
}

function isProductUnprocessed(item) {
  const local = competitorLocal(item.id);
  return !local.read && !local.reviewed && item.status !== 'archived';
}

function discoverySort(a, b) {
  const byWeight = (b.weight || 0) - (a.weight || 0);
  if (byWeight) return byWeight;
  const byTime = (b.timestamp || 0) - (a.timestamp || 0);
  if (byTime) return byTime;
  return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
}

function latestRun(scanType) {
  return (state.scanRuns || []).find((run) => run.scan_type === scanType) || null;
}

function nextScanTime() {
  const interval = Number(state.constants.daily_interval_minutes || 1440);
  const latest = latestRun('arxiv') || latestRun('product');
  const base = latest?.created_at ? new Date(latest.created_at).getTime() : Date.now();
  return new Date(base + interval * 60_000).toISOString();
}

async function loadMyFeedbacks() {
  try {
    const result = await call({ action: 'list_my_feedbacks' });
    state.feedbacks = feedbackFromRows(result.feedbacks || result.items || []);
    state.backendStatus.feedbacks = 'connected';
  } catch {
    state.feedbacks = {};
    state.backendStatus.feedbacks = 'missing';
  }
}

async function loadPaperClusters() {
  try {
    const result = await call({ action: 'get_paper_clusters' });
    const clusters = result.clusters || result.items || [];
    state.paperClusters = clusters.map(normalizeCluster).sort((a, b) => b.max_score - a.max_score);
    state.clusterPapers = {};
    state.backendStatus.clusters = 'connected';
    await preloadClusterLeaders();
  } catch {
    const mock = await loadMockClusters();
    state.paperClusters = (mock.clusters || []).map(normalizeCluster).sort((a, b) => b.max_score - a.max_score);
    state.clusterPapers = {};
    for (const [label, papers] of Object.entries(mock.papers_by_cluster || {})) {
      state.clusterPapers[label] = papers.map((item) => normalizePaper(item, label)).sort((a, b) => b.priority_score - a.priority_score);
    }
    state.feedbacks = { ...feedbackFromRows(mock.feedbacks || []), ...state.feedbacks };
    state.backendStatus.clusters = 'mock';
    await preloadClusterLeaders();
  }
  await loadRadarTopPicks();
}

async function loadRadarTopPicks() {
  try {
    const result = await call({ action: 'get_top_picks', limit: 6 });
    state.radarTopPicks = (result.items || result.papers || []).map((item) => normalizePaper(item, item.cluster_label || item.cluster || ''));
  } catch {
    state.radarTopPicks = [];
  }
}

async function preloadClusterLeaders() {
  const leaders = state.paperClusters.slice(0, 12);
  for (const cluster of leaders) {
    if (!state.clusterPapers[cluster.label]?.length) {
      await ensureClusterPapers(cluster.label, { silent: true });
    }
  }
  computeTopPicks();
}

async function ensureClusterPapers(label, options = {}) {
  const cluster = state.paperClusters.find((item) => item.label === label);
  if (!cluster) return [];
  if (state.clusterPapers[label]?.length && !options.force) return state.clusterPapers[label];

  if (state.backendStatus.clusters === 'mock') {
    const mock = await loadMockClusters();
    const papers = (mock.papers_by_cluster?.[label] || [])
      .map((item) => normalizePaper(item, label))
      .sort((a, b) => b.priority_score - a.priority_score);
    state.clusterPapers[label] = papers;
    cluster.loaded = true;
    cluster.offset = papers.length;
    cluster.has_more = false;
    return papers;
  }

  try {
    const result = await call({
      action: 'get_papers_by_cluster',
      label,
      limit: options.limit || 20,
      offset: options.offset || 0,
    });
    const papers = (result.papers || result.items || [])
      .map((item) => normalizePaper(item, label))
      .sort((a, b) => b.priority_score - a.priority_score);
    const existing = options.offset ? (state.clusterPapers[label] || []) : [];
    state.clusterPapers[label] = [...existing, ...papers].sort((a, b) => b.priority_score - a.priority_score);
    if (!cluster.keywords.length && state.clusterPapers[label][0]?.cluster_keywords) {
      cluster.keywords = normalizeKeywords(state.clusterPapers[label][0].cluster_keywords);
    }
    cluster.loaded = true;
    cluster.offset = state.clusterPapers[label].length;
    cluster.has_more = papers.length >= (options.limit || 20);
    return state.clusterPapers[label];
  } catch (error) {
    if (!options.silent) showToast(error.message || 'cluster 论文加载失败', 'bad');
    return state.clusterPapers[label] || [];
  }
}

function computeTopPicks() {
  const seen = new Set();
  const papers = [];
  for (const cluster of state.paperClusters) {
    for (const paper of state.clusterPapers[cluster.label] || []) {
      const id = paperId(paper);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      papers.push({ ...paper, cluster_label: paper.cluster_label || cluster.label });
    }
  }
  state.topPicks = papers.sort((a, b) => b.priority_score - a.priority_score).slice(0, 5);
}

async function loadEvolutionLevel(level, options = {}) {
  if (level === 'L3') return loadL3Placeholder();
  try {
    const result = await call({
      action: 'get_evolution_feed',
      level,
      limit: options.limit || 20,
      offset: options.offset || 0,
      project_id: state.evolution.projectId || undefined,
    });
    const items = (result.items || result.events || result.feed || [])
      .map((item, index) => normalizeEvolutionEvent(item, level, index));
    state.evolution.feeds[level] = options.offset
      ? [...state.evolution.feeds[level], ...items]
      : items;
    state.evolution.offsets[level] = state.evolution.feeds[level].length;
    state.evolution.totals[level] = Number.isFinite(result.total) ? result.total : state.evolution.feeds[level].length;
    state.evolution.source = 'backend';
  } catch {
    const mock = await loadMockEvolution();
    const source = level === 'L1' ? mock.L1 : mock.L2;
    state.evolution.feeds[level] = (source || []).map((item, index) => normalizeEvolutionEvent(item, level, index));
    state.evolution.offsets[level] = state.evolution.feeds[level].length;
    state.evolution.source = 'mock';
  }
}

async function loadL3Placeholder() {
  try {
    const result = await call({ action: 'get_L3_placeholder' });
    const items = result.items || result.placeholders || [result.placeholder].filter(Boolean);
    state.evolution.feeds.L3 = items.map((item, index) => normalizeEvolutionEvent(item, 'L3', index));
    state.evolution.source = 'backend';
  } catch {
    const mock = await loadMockEvolution();
    state.evolution.feeds.L3 = (mock.L3 || []).map((item, index) => normalizeEvolutionEvent(item, 'L3', index));
    state.evolution.source = 'mock';
  }
}

async function loadEvolutionAll() {
  await loadEvolutionLevel('L1');
  await loadEvolutionLevel('L2');
  await loadEvolutionLevel('L3');
}

function evolutionProjects() {
  const ids = new Set();
  for (const item of [...state.evolution.feeds.L1, ...state.evolution.feeds.L2]) {
    if (item.project_id) ids.add(item.project_id);
  }
  return [...ids].sort();
}

function radarSummary(item, fallback = '') {
  return shortText(item.abstract || item.fetched_description || item.reason || item.diff_summary || item.summary || fallback, 60);
}

function radarAuthors(authors) {
  if (Array.isArray(authors)) return shortText(authors.slice(0, 2).join(', '), 34);
  return shortText(authors || '', 34);
}

function buildRadarDiscoveries() {
  const paperItems = allPaperDiscoveries()
    .filter(isPaperUnprocessed)
    .map((item) => ({
      id: item.id,
      type: 'paper',
      title: item.title,
      summary: radarSummary(item, '高优先级论文线索'),
      keyword: (item.matched_keywords || item.tags || ['论文'])[0] || '论文',
      weight: Number(item.priority_score ?? item.relevance ?? 0) || 0,
      timestamp: timeValue(item.published_at || item.updated_arxiv_at || item.created_at),
      meta: [
        radarAuthors(item.authors) || '作者未知',
        item.cluster_label || item.cluster || 'cluster 未知',
        `Priority ${item.priority_score ?? item.relevance ?? 0}`,
      ],
    }))
    .sort(discoverySort)
    .slice(0, 5);

  const productItems = (state.competitors.official || [])
    .filter(isProductUnprocessed)
    .map((item) => ({
      id: item.id,
      type: 'product',
      title: item.name,
      summary: radarSummary(item, '正在跟踪的产品'),
      keyword: (item.tags || [labels.category[item.category] || '产品'])[0] || '产品',
      weight: Number(item.priority_score ?? item.relevance ?? 0) || 0,
      timestamp: timeValue(item.last_scanned_at || item.updated_at || item.created_at),
      meta: [
        labels.category[item.category] || item.category || '其他',
        labels.status[item.status] || item.status || '已跟踪',
        `相关度 ${item.relevance ?? 0}/10`,
      ],
    }))
    .sort(discoverySort)
    .slice(0, 4);

  return [...paperItems, ...productItems]
    .sort(discoverySort)
    .slice(0, 8)
    .map(({ weight, timestamp, ...item }) => item);
}

function updateRadarDiscoveries() {
  if (heroRing?.updateDiscoveries) heroRing.updateDiscoveries(buildRadarDiscoveries());
}

async function loadAll() {
  const overlay = ensureLoadingOverlay();
  overlay.start('莫比乌斯正在苏醒', '初始化 Research Radar 数据通道…');
  overlay.activate('papers');
  try {
    const data = await call({ action: 'bootstrap', skip_first_scan: true, limit: 200 });
    state.summary = data.summary || {};
    state.keywords = data.keywords || state.keywords;
    state.competitors = data.competitors || state.competitors;
    state.papers = data.arxiv || { items: [], total: 0 };
    state.products = data.products || { items: [], total: 0 };
    state.scanRuns = data.scan_runs || [];
    state.constants = data.constants || {};
    overlay.done('papers');
    overlay.activate('products');
    await loadMyFeedbacks();
    overlay.done('products');
    overlay.activate('evolution');
    await loadPaperClusters();
    await loadEvolutionAll();
    overlay.done('evolution');
    overlay.activate('ai');
    await loadAiChannels();
    overlay.done('ai');
    overlay.finish('L2 Agent 就绪，可以开聊');
    render();
  } catch (error) {
    overlay.error(error.message || '加载失败');
    showToast(error.message || '加载失败', 'bad');
  }
}

function ensureLoadingOverlay() {
  if (state.loadingOverlay) return state.loadingOverlay;
  const el = $('appLoadingOverlay');
  if (!el) return { start() {}, activate() {}, done() {}, finish() {}, error() {} };
  const titleEl = $('appLoadingTitle');
  const hintEl = $('appLoadingHint');
  const stepEls = {};
  el.querySelectorAll('[data-step]').forEach((li) => { stepEls[li.dataset.step] = li; });
  document.body.classList.add('is-app-loading');
  const overlay = {
    start(title, hint) {
      if (titleEl) titleEl.textContent = title || '莫比乌斯正在苏醒';
      if (hintEl) hintEl.textContent = hint || '初始化 Research Radar 数据通道…';
      Object.values(stepEls).forEach((li) => li.classList.remove('is-active', 'is-done'));
      el.classList.remove('is-hiding');
      el.setAttribute('aria-hidden', 'false');
    },
    activate(step) {
      Object.values(stepEls).forEach((li) => li.classList.remove('is-active'));
      const target = stepEls[step];
      if (target) target.classList.add('is-active');
    },
    done(step) {
      const target = stepEls[step];
      if (!target) return;
      target.classList.remove('is-active');
      target.classList.add('is-done');
    },
    finish(hint) {
      if (hintEl) hintEl.textContent = hint || '已就绪';
      Object.values(stepEls).forEach((li) => li.classList.remove('is-active'));
      Object.values(stepEls).forEach((li) => li.classList.add('is-done'));
      setTimeout(() => {
        el.classList.add('is-hiding');
        el.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('is-app-loading');
      }, 360);
    },
    error(msg) {
      if (hintEl) hintEl.textContent = msg || '加载出错，请刷新重试';
      Object.values(stepEls).forEach((li) => li.classList.remove('is-active'));
    },
  };
  state.loadingOverlay = overlay;
  return overlay;
}

function render() {
  renderSchedule();
  renderKeywordControls();
  renderPapers();
  renderCompetitors();
  renderEvolution();
  renderTail();
  updateRadarDiscoveries();
  setTab(state.tab);
}

function renderSchedule() {
  const lastArxiv = latestRun('arxiv') || state.summary.last_arxiv;
  const lastProduct = latestRun('product') || state.summary.last_product;
  const scanning = state.scanning.paper || state.scanning.product;
  const next = nextScanTime();
  const statusText = scanning ? '扫描中' : '等待下一次定时扫描';
  const statusHtml = `
    <div class="schedule-card">
      <strong>${statusText}</strong>
      <span>上次论文扫描: ${escapeHtml(formatTime(lastArxiv?.created_at))}</span>
      <span>上次产品扫描: ${escapeHtml(formatTime(lastProduct?.created_at))}</span>
      <em>下次扫描时间: ${escapeHtml(formatTime(next))}</em>
    </div>
  `;
  $('scheduleStatus').innerHTML = statusHtml;
  $('paperScheduleMini').innerHTML = `
    <div>上次: ${escapeHtml(formatTime(lastArxiv?.created_at))}</div>
    <div>下次: ${escapeHtml(formatTime(next))}</div>
  `;
  $('paperScanPill').textContent = scanning ? '扫描中' : '空闲';
}

function renderKeywordControls() {
  $('paperKeywords').value = (state.keywords.paper || []).map(keywordLine).join('\n');
  $('productKeywords').value = (state.keywords.product || []).map(keywordLine).join('\n');
  const current = state.filters.paper.keyword;
  $('paperKeyword').innerHTML = [
    '<option value="">全部关键词</option>',
    ...(state.keywords.paper || []).map((item) => `<option value="${escapeHtml(item.keyword)}">${escapeHtml(item.keyword)}</option>`),
  ].join('');
  $('paperKeyword').value = current;
}

function filteredPapers() {
  const q = state.filters.paper.q.toLowerCase();
  const papers = Object.values(state.clusterPapers).flat();
  return papers.filter((item) => {
    const local = paperLocal(item.id);
    if (item.mark === 'excluded' && !state.showExcluded.paper) return false;
    if (state.filters.paper.status === 'read' && !local.read) return false;
    if (state.filters.paper.status === 'unread' && local.read) return false;
    if (state.filters.paper.status === 'archived' && !local.archived) return false;
    if (state.filters.paper.status !== 'archived' && local.archived) return false;
    if (state.filters.paper.favorite === 'favorite' && !local.favorite) return false;
    if (state.filters.paper.keyword) {
      const needle = state.filters.paper.keyword;
      const tags = [...(item.matched_keywords || []), ...(item.tags || [])];
      if (!tags.includes(needle)) return false;
    }
    if (q) {
      const haystack = `${item.title} ${item.authors} ${item.abstract}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function feedbackLabel(verdict) {
  if (verdict === 'boost') return '加紧调研';
  if (verdict === 'neutral') return '中立';
  if (verdict === 'exclude') return '以后排除';
  return '';
}

function feedbackButtons(item) {
  const id = paperId(item);
  const selected = state.feedbacks[id] || '';
  const pending = !!state.feedbackPending[id];
  const options = [
    ['boost', '加紧调研'],
    ['neutral', '中立'],
    ['exclude', '以后排除'],
  ];
  return `
    <div class="feedback-actions" aria-label="论文反馈">
      ${options.map(([verdict, label]) => {
        const active = selected === verdict;
        const disabled = pending || (!!selected && !active);
        return `<button type="button" data-feedback="${verdict}" data-paper-feedback="${escapeHtml(id)}" class="feedback-button ${active ? 'is-active' : ''}" data-verdict="${verdict}" ${disabled ? 'disabled' : ''}>${label}</button>`;
      }).join('')}
      ${selected ? `<span class="feedback-note">${pending ? '提交中' : `已反馈: ${feedbackLabel(selected)}`}</span>` : ''}
    </div>
  `;
}

function renderInspirationBlock(rawInspiration, markExcluded) {
  if (markExcluded) {
    return `<div class="inspiration-block is-excluded"><p class="inspiration-head"><span class="priority-tag muted">AI 已排除</span> <span>该条目经 L2 Agent 阅读后判定对莫比乌斯暂无借鉴价值。</span></p></div>`;
  }
  const items = parseInspiration(rawInspiration);
  if (!items.length) {
    return `<div class="inspiration-block is-pending"><p class="inspiration-head"><span class="priority-tag pending">未读</span> <span>尚未经过 L2 Agent 深度阅读。</span></p></div>`;
  }
  const counts = inspirationBadgeCount(items);
  const head = [
    counts.high ? `<span class="priority-tag high">高 ${counts.high}</span>` : '',
    counts.med ? `<span class="priority-tag medium">中 ${counts.med}</span>` : '',
    counts.low ? `<span class="priority-tag low">低 ${counts.low}</span>` : '',
  ].filter(Boolean).join('');
  const list = items.map((it) => `
    <li class="inspiration-item priority-${it.priority}">
      <div class="inspiration-item-head">
        <span class="priority-tag ${it.priority}">${it.priority === 'high' ? '高' : it.priority === 'medium' ? '中' : '低'}</span>
        <strong>${escapeHtml(it.title || it.direction.slice(0, 40))}</strong>
      </div>
      ${it.direction ? `<p class="inspiration-direction"><span class="direction-label">启发方向</span> ${escapeHtml(it.direction)}</p>` : ''}
      ${it.mobius_use ? `<p class="inspiration-mobius-use"><span class="mobius-use-label">具体落实</span> ${escapeHtml(it.mobius_use)}</p>` : ''}
    </li>
  `).join('');
  return `
    <details class="inspiration-block is-loaded">
      <summary class="inspiration-head">
        <span>${head || '<span class="priority-tag pending">已读</span>'}</span>
        <span class="inspiration-toggle">查看对莫比乌斯的借鉴方向 ›</span>
      </summary>
      <ul class="inspiration-list">${list}</ul>
    </details>
  `;
}

function renderPaperCard(item, options = {}) {
  const local = paperLocal(item.id);
  const tags = [...(item.matched_keywords || []), ...(item.tags || []).slice(0, 3)];
  const score = item.priority_score ?? item.relevance ?? 0;
  const clusterLine = item.cluster_label ? ` · ${item.cluster_label}` : '';
  const isExcluded = item.mark === 'excluded';
  const insp = parseInspiration(item.ai_inspiration);
  const hasInsp = insp.length > 0;
  return `
    <article class="paper-card ${options.compact ? 'is-compact' : ''} ${isExcluded ? 'is-excluded' : ''} ${hasInsp ? 'has-inspiration' : ''}" data-archived="${local.archived ? 'true' : 'false'}">
      <div class="card-head">
        <div>
          <div class="card-meta">Priority ${escapeHtml(score)} · ${escapeHtml(item.published_at || '日期未知')}${clusterLine} · ${local.read ? '已读' : '未读'}${local.favorite ? ' · 已收藏' : ''}${isExcluded ? ' · AI 排除' : ''}</div>
          <h3 class="${options.gradient ? 'gradient-text' : ''}">${escapeHtml(item.title)}</h3>
        </div>
        <span class="status-pill">${isExcluded ? 'AI 排除' : (local.archived ? '归档' : (local.read ? '已读' : '未读'))}</span>
      </div>
      ${hasInsp ? renderInspirationBlock(item.ai_inspiration, false) : (isExcluded ? renderInspirationBlock(null, true) : '')}
      <p>${escapeHtml(shortText(item.abstract, options.compact ? 150 : 280))}</p>
      <div class="tag-row">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="paper-bottom-row">
        <div class="card-actions">
          <button type="button" data-paper-detail="${escapeHtml(item.id)}">查看详情</button>
          <button type="button" data-paper-read="${escapeHtml(item.id)}">${local.read ? '标记未读' : '标记已读'}</button>
          <button type="button" data-paper-favorite="${escapeHtml(item.id)}">${local.favorite ? '取消收藏' : '收藏'}</button>
          <button type="button" data-paper-archive="${escapeHtml(item.id)}">${local.archived ? '取消归档' : '归档'}</button>
          ${item.source_url ? `<a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">原文</a>` : ''}
        </div>
        ${feedbackButtons(item)}
      </div>
    </article>
  `;
}

function renderTopPicks() {
  const picks = state.topPicks || [];
  $('topPicksList').innerHTML = picks.length
    ? picks.map((item, index) => `
      <article class="top-pick-card">
        <div class="top-rank">${String(index + 1).padStart(2, '0')}</div>
        <div class="top-pick-main">
          <h3 class="gradient-text">${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(shortText(item.abstract, 150))}</p>
          <div class="tag-row">${[...(item.matched_keywords || []), ...(item.tags || []).slice(0, 2)].map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
        </div>
        <button type="button" class="see-all-button" data-open-cluster="${escapeHtml(item.cluster_label || '')}">See all →</button>
      </article>
    `).join('')
    : '<div class="quiet-empty">暂无 Top Picks，等待 cluster 数据</div>';
}

function renderPapers() {
  computeTopPicks();
  renderTopPicks();
  const all = Object.values(state.clusterPapers).flat();
  const items = filteredPapers();
  const readCount = all.filter((item) => paperLocal(item.id).read).length;
  const favoriteCount = all.filter((item) => paperLocal(item.id).favorite).length;
  const archivedCount = all.filter((item) => paperLocal(item.id).archived).length;
  const feedbackCount = Object.keys(state.feedbacks).length;
  const totalPapers = state.paperClusters.reduce((sum, item) => sum + (item.paper_count || 0), 0) || all.length || state.papers.total || 0;
  $('paperClusterPill').textContent = state.backendStatus.clusters === 'connected'
    ? '后端 cluster'
    : state.backendStatus.clusters === 'mock'
      ? 'Mock cluster'
      : '聚类加载中';
  $('paperMetrics').innerHTML = [
    ['Cluster', state.paperClusters.length],
    ['论文总数', totalPapers],
    ['已读', readCount],
    ['反馈', feedbackCount || favoriteCount],
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');

  if (!state.paperClusters.length) {
    $('clusterList').innerHTML = '<div class="quiet-empty">暂无 cluster 数据</div>';
    return;
  }

  $('clusterList').innerHTML = state.paperClusters.map((cluster) => {
    const papers = filteredClusterPapers(cluster.label);
    const expanded = !!cluster.expanded;
    const keywords = cluster.keywords || [];
    return `
      <article class="cluster-card" id="${escapeHtml(clusterDomId(cluster.label))}" data-expanded="${expanded ? 'true' : 'false'}">
        <button type="button" class="cluster-head" data-toggle-cluster="${escapeHtml(cluster.label)}" aria-expanded="${expanded ? 'true' : 'false'}">
          <div>
            <h3>${escapeHtml(cluster.title)}</h3>
            <div class="tag-row">${keywords.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
          </div>
          <span class="cluster-stats">${escapeHtml(cluster.paper_count)} papers · max ${escapeHtml(cluster.max_score)}</span>
        </button>
        <div class="cluster-body">
          <div class="cluster-body-inner">
            ${expanded
              ? (papers.length ? papers.map((paper) => renderPaperCard(paper)).join('') : `<div class="quiet-empty">暂无匹配论文${archivedCount ? `，已归档 ${archivedCount} 篇` : ''}</div>`)
              : ''}
            ${expanded && cluster.has_more ? `<button type="button" class="glass-button" data-load-more-cluster="${escapeHtml(cluster.label)}">加载更多</button>` : ''}
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function filteredClusterPapers(label) {
  return (state.clusterPapers[label] || [])
    .filter((item) => filteredPapers().some((paper) => paper.id === item.id))
    .sort((a, b) => b.priority_score - a.priority_score);
}

function filteredCompetitors() {
  const q = state.filters.competitor.q.toLowerCase();
  return allCompetitors().filter((item) => {
    const local = competitorLocal(item.id);
    if (item.mark === 'excluded' && !state.showExcluded.competitor) return false;
    if (state.filters.competitor.status && item.status !== state.filters.competitor.status) return false;
    if (state.filters.competitor.read === 'read' && !local.read) return false;
    if (state.filters.competitor.read === 'unread' && local.read) return false;
    if (q) {
      const haystack = `${item.name} ${item.reason} ${item.fetched_title} ${item.fetched_description}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function productCard(item) {
  const local = competitorLocal(item.id);
  const snapshot = item.fetched_description || item.reason || '暂无产品页摘要，建议重扫产品页。';
  const isExcluded = item.mark === 'excluded';
  const insp = parseInspiration(item.ai_inspiration);
  const hasInsp = insp.length > 0;
  return `
    <article class="product-card ${isExcluded ? 'is-excluded' : ''} ${hasInsp ? 'has-inspiration' : ''}">
      <div class="card-head">
        <div>
          <div class="card-meta">${escapeHtml(labels.category[item.category] || item.category || '其他')} · ${escapeHtml(labels.status[item.status] || item.status)} · 相关度 ${escapeHtml(item.relevance)}/10 · ${local.read ? '已读' : '未读'}${isExcluded ? ' · AI 排除' : ''}</div>
          <h3>${escapeHtml(item.name)}</h3>
        </div>
        <span class="status-pill">${isExcluded ? 'AI 排除' : escapeHtml(labels.status[item.status] || item.status)}</span>
      </div>
      ${hasInsp ? renderInspirationBlock(item.ai_inspiration, false) : (isExcluded ? renderInspirationBlock(null, true) : '')}
      <p>${escapeHtml(shortText(snapshot, 240))}</p>
      <div class="tag-row">${(item.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="card-actions">
        ${item.status === 'candidate' ? `<button type="button" data-promote="${escapeHtml(item.id)}">一键晋升为正式</button>` : ''}
        <button type="button" data-product-detail="${escapeHtml(item.id)}">查看详情 / 追问</button>
        <button type="button" data-product-read="${escapeHtml(item.id)}">${local.read ? '标记未读' : '标记已读'}</button>
        <a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">打开页面</a>
      </div>
    </article>
  `;
}

function renderCompetitors() {
  const filtered = filteredCompetitors();
  const official = filtered.filter((item) => item.status === 'official');
  const candidate = filtered.filter((item) => item.status === 'candidate');
  const readCount = allCompetitors().filter((item) => competitorLocal(item.id).read).length;

  $('competitorMetrics').innerHTML = [
    ['已跟踪', state.competitors.official?.length || 0],
    ['候选', state.competitors.candidate?.length || 0],
    ['已读', readCount],
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');

  $('officialCount').textContent = official.length;
  $('candidateCount').textContent = candidate.length;
  $('officialCompetitors').innerHTML = official.length
    ? official.map(productCard).join('')
    : '<div class="quiet-empty">暂无匹配的已跟踪产品</div>';
  $('candidateCompetitors').innerHTML = candidate.length
    ? candidate.map(productCard).join('')
    : '<div class="quiet-empty">暂无匹配候选</div>';
}

function renderEvolution() {
  const active = state.evolution.level;
  document.querySelectorAll('.evo-tab').forEach((button) => {
    const isActive = button.dataset.evoLevel === active;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  $('evolutionPanel').dataset.level = active;
  $('evolutionSourcePill').textContent = state.evolution.source === 'backend' ? '真后端' : 'Mock feed';
  renderEvolutionProjectFilter();
  if (active === 'L1') renderEvolutionL1();
  if (active === 'L2') renderEvolutionL2();
  if (active === 'L3') renderEvolutionL3();
}

function renderTail() {
  const papers = state.papers.total || Object.values(state.clusterPapers).flat().length || 0;
  const tracked = state.competitors.official?.length || 0;
  const l1 = state.evolution.totals.L1 || 0;
  $('finaleStatus').innerHTML = [
    ['当前时间', formatNow()],
    ['论文线索', papers],
    ['跟踪产品', tracked],
    ['L1 改动', l1],
  ].map(([label, value]) => `
    <div class="finale-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join('');
}

function formatNow() {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());
}

setInterval(() => {
  if (document.hidden) return;
  const node = document.querySelector('#finaleStatus .finale-metric:first-child strong');
  if (node) node.textContent = formatNow();
}, 30_000);

function renderEvolutionProjectFilter() {
  const projects = evolutionProjects();
  const current = state.evolution.projectId;
  $('evolutionProjectFilter').innerHTML = [
    '<option value="">全部项目</option>',
    ...projects.map((project) => `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`),
  ].join('');
  $('evolutionProjectFilter').value = current;
  $('evolutionProjectFilterWrap').style.display = state.evolution.level === 'L1' ? 'grid' : 'none';
}

function evolutionItems(level) {
  const items = state.evolution.feeds[level] || [];
  if (level !== 'L1' || !state.evolution.projectId) return items;
  return items.filter((item) => item.project_id === state.evolution.projectId);
}

function renderEvolutionL1() {
  const items = evolutionItems('L1');
  $('evolutionContent').innerHTML = items.length
    ? `<div class="evolution-list">${items.map((item) => renderL1Card(item)).join('')}</div>`
    : '<div class="quiet-empty">暂无 L1 实际修改</div>';
}

function renderL1Card(item) {
  const expanded = !!state.evolution.expanded[item.id];
  const sha = item.commit_sha ? item.commit_sha.slice(0, 7) : 'pending';
  return `
    <article class="evo-card l1-card" data-expanded="${expanded ? 'true' : 'false'}">
      <button type="button" class="evo-card-head" data-toggle-evolution="${escapeHtml(item.id)}">
        <span class="evo-sha">${escapeHtml(sha)}</span>
        <span>
          <strong>${escapeHtml(item.summary)}</strong>
          <em>${escapeHtml(shortText(item.diff_summary, 180))}</em>
        </span>
      </button>
      <div class="evo-meta">${escapeHtml(formatTime(item.created_at))} · ${escapeHtml(item.project_id)} · ${escapeHtml(item.actor)}</div>
      <div class="evo-expand">
        <div class="tag-row">${(item.files_changed || []).map((file) => `<span>${escapeHtml(file)}</span>`).join('')}</div>
        <p>${escapeHtml(item.diff_summary || '暂无 diff 摘要')}</p>
      </div>
    </article>
  `;
}

function renderEvolutionL2() {
  const items = evolutionItems('L2');
  const pending = items.filter((item) => !['approved', 'promoted_to_L1', 'rejected'].includes(item.status));
  const approved = items.filter((item) => ['approved', 'promoted_to_L1'].includes(item.status));
  $('evolutionContent').innerHTML = `
    <div class="evolution-columns">
      <section>
        <div class="column-head"><h3>待审</h3><span>${pending.length}</span></div>
        <div class="evolution-list">${pending.length ? pending.map((item) => renderL2Card(item, false)).join('') : '<div class="quiet-empty">暂无待审候选</div>'}</div>
      </section>
      <section>
        <div class="column-head"><h3>已批准</h3><span>${approved.length}</span></div>
        <div class="evolution-list">${approved.length ? approved.map((item) => renderL2Card(item, true)).join('') : '<div class="quiet-empty">暂无已批准事件</div>'}</div>
      </section>
    </div>
  `;
}

function renderL2Card(item, approved) {
  const pending = !!state.evolution.pending[item.id];
  return `
    <article class="evo-card l2-card">
      <div class="card-head">
        <div>
          <div class="card-meta">${escapeHtml(formatTime(item.created_at))} · ${escapeHtml(item.project_id)} · ${escapeHtml(item.actor)}</div>
          <h3>${escapeHtml(item.summary)}</h3>
        </div>
        <span class="status-pill">${escapeHtml(item.status)}</span>
      </div>
      <p>${escapeHtml(shortText(item.diff_summary, 260))}</p>
      ${approved ? '' : `
        <div class="card-actions">
          <button type="button" class="promote-button" data-promote-l2="${escapeHtml(item.id)}" ${pending ? 'disabled' : ''}>批准并升级 L1</button>
          <button type="button" data-reject-l2="${escapeHtml(item.id)}" ${pending ? 'disabled' : ''}>拒绝</button>
        </div>
      `}
    </article>
  `;
}

function renderEvolutionL3() {
  const item = (state.evolution.feeds.L3 || [])[0] || {
    summary: 'L3 自进化：莫比乌斯修改莫比乌斯 · 暂未启用 · 预留接口',
    diff_summary: '接口预留中，等待后端开放。',
  };
  $('evolutionContent').innerHTML = `
    <article class="evo-card l3-placeholder" aria-disabled="true">
      <div class="disabled-icon" aria-hidden="true">L3</div>
      <h3>${escapeHtml(item.summary || 'L3 自进化：莫比乌斯修改莫比乌斯 · 暂未启用 · 预留接口')}</h3>
      <p>${escapeHtml(item.diff_summary || '预留接口')}</p>
      <span class="status-pill">disabled</span>
    </article>
  `;
}

async function refreshPapersFromServer() {
  if (!state.paperClusters.length) await loadPaperClusters();
  renderPapers();
}

async function runArxivScan(event) {
  event.preventDefault();
  const button = event.submitter;
  const query = $('arxivQuery').value;
  const max = Number($('arxivMax').value || 100);
  const withAi = $('arxivScanWithAi').checked;
  const aiCost = withAi ? estimateAiCost({ kind: 'paper', count: Math.min(max, 50) }) : null;
  const body = withAi
    ? `将以已启用关键词真实拉取 arXiv（最多 ${max} 条，~10 秒），随后用 ${channelLabel('paper')} 对新增论文做深度阅读并产出对莫比乌斯的借鉴方向。AI 阶段预计 ${aiCost ? formatAiCost(aiCost) : '20-90 秒'}。`
    : `将以已启用关键词真实拉取 arXiv，最多 ${max} 条，预计 5-15 秒（不做 AI 阅读）。`;
  const ok = await confirmDialog({
    title: withAi ? '扫描 + AI 深度阅读论文？' : '立即扫描论文？',
    body,
    confirmText: '确认扫描',
  });
  if (!ok) return;
  await doArxivScan({ button, query, max });
  if (withAi) await doAiScan('paper', { button });
}

function channelLabel(kind) {
  const key = state.aiChannel[kind];
  const found = state.aiChannels.find((c) => c.key === key);
  return found?.label || DEFAULT_CHANNEL_LABEL_FALLBACK;
}

async function doAiScan(kind, { button } = {}) {
  if (state.aiScanning[kind]) return;
  const action = kind === 'paper' ? 'ai_scan_arxiv' : 'ai_scan_products';
  const defaultN = kind === 'paper' ? 10 : 5;
  const n = Number($(`${kind}AiN`)?.value || defaultN);
  const btn = button || $(`${kind}AiScanBtn`);
  state.aiScanning[kind] = true;
  if (btn) {
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent;
    btn.textContent = 'AI 阅读中...';
  }
  try {
    const result = await call({
      action,
      model_key: state.aiChannel[kind],
      limit: n,
    });
    const items = (result.results || []).filter((r) => r.inspiration_count > 0).map((r) => ({
      id: r.id,
      title: r.title || r.name || '',
      inspiration: r.inspiration || [],
      inspiration_count: r.inspiration_count,
      excluded: r.excluded,
    }));
    if (kind === 'paper') {
      const fresh = await call({ action: 'bootstrap', skip_first_scan: true, limit: 200 });
      state.papers = fresh.arxiv || state.papers;
      state.summary = fresh.summary || state.summary;
      await loadPaperClusters();
    } else {
      const fresh = await call({ action: 'bootstrap', skip_first_scan: true, limit: 200 });
      state.products = fresh.products || state.products;
      state.competitors = fresh.competitors || state.competitors;
      state.summary = fresh.summary || state.summary;
    }
    render();
    renderLatestBatch(kind === 'paper' ? 'paper' : 'product', items, `本轮 AI 阅读 ${result.scanned} 条 · ${items.length} 条有启发`);
    showToast(`AI 阅读完成: ${result.summary || ''}`);
    return { ok: true, scanned: result.scanned };
  } catch (error) {
    showToast(error.message || 'AI 阅读失败', 'bad');
    return { ok: false, error: error.message };
  } finally {
    state.aiScanning[kind] = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.originalText || 'AI 深度阅读';
    }
  }
}

async function runAiScan(kind) {
  if (state.aiScanning[kind]) return;
  const n = Number($(`${kind}AiN`)?.value || (kind === 'paper' ? 10 : 5));
  const cost = estimateAiCost({ kind, count: n });
  const ok = await confirmDialog({
    title: kind === 'paper' ? 'AI 深度阅读论文？' : 'AI 深度阅读产品？',
    body: `将用 ${channelLabel(kind)} 对 ${n} 个未读 ${kind === 'paper' ? '论文' : '产品'} 做完整阅读，注入莫比乌斯 Memory 后产出"对莫比乌斯的借鉴方向"。预计 ${formatAiCost(cost)}。无借鉴价值的会标记为排除。`,
    confirmText: '确认 AI 阅读',
  });
  if (!ok) return;
  await doAiScan(kind, {});
}

async function doArxivScan({ button, query, max } = {}) {
  const btn = button || $('arxivScanForm').querySelector('button[type="submit"]');
  query = query ?? $('arxivQuery').value;
  max = max ?? Number($('arxivMax').value || 100);
  state.scanning.paper = true;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '扫描中...';
  renderSchedule();
  try {
    const result = await call({
      action: 'scan_arxiv',
      query,
      max_results: max,
      scan_competitors: $('scanCompetitorsAfterArxiv').checked,
    });
    state.summary = result.summary || state.summary;
    state.papers = result.arxiv || state.papers;
    state.scanRuns = result.scan_runs || state.scanRuns;
    await loadMyFeedbacks();
    await loadPaperClusters();
    if (result.product_scans?.length) {
      const competitors = await call({ action: 'get_competitors' });
      state.competitors = competitors.competitors || state.competitors;
    }
    render();
    renderLatestBatch('paper', result.scan?.new_items || [], `本轮新增 ${result.scan?.new_count ?? result.scan?.inserted ?? 0} 条`);
    showToast(`论文扫描完成: 新增 ${result.scan.inserted}, 更新 ${result.scan.updated}`);
    return { ok: true, inserted: result.scan?.inserted ?? 0 };
  } catch (error) {
    showToast(error.message || '扫描失败', 'bad');
    return { ok: false, error: error.message };
  } finally {
    state.scanning.paper = false;
    btn.disabled = false;
    btn.textContent = originalText || '立即扫描论文';
    renderSchedule();
  }
}

async function runProductScan(event) {
  event.preventDefault();
  const button = event.submitter;
  const url = $('productUrl').value;
  const name = $('productName').value;
  const category = $('productCategory').value;
  const statusValue = $('productStatus').value;
  const hasUrl = Boolean(url && url.trim());
  const ok = await confirmDialog({
    title: hasUrl ? '立即扫描该产品？' : '立即扫描产品？',
    body: hasUrl
      ? `将真实抓取 ${url} 的产品页元信息并入库。`
      : '将让 AI Agent 基于关键词和已跟踪产品，从自身知识里捞出潜在新产品并抓取入库。预计 30 秒到几分钟。',
    confirmText: '确认扫描',
  });
  if (!ok) return;
  state.scanning.product = true;
  button.disabled = true;
  button.textContent = '扫描中...';
  renderSchedule();
  try {
    if (hasUrl) {
      const result = await call({
        action: 'scan_product_url',
        source_url: url,
        name,
        category,
        status: statusValue,
        as_official: statusValue === 'official',
      });
      state.competitors = result.competitors || state.competitors;
      state.products = result.products || state.products;
      state.scanRuns = result.scan_runs || state.scanRuns;
      state.summary = result.summary || state.summary;
      $('productUrl').value = '';
      $('productName').value = '';
      render();
      const touched = result.product_scan?.touched_ids || [];
      const items = touched.length
        ? (state.competitors.official || []).concat(state.competitors.candidate || []).filter((p) => touched.includes(p.id))
        : (result.product_scan?.competitor ? [result.product_scan.competitor] : []);
      renderLatestBatch('product', items, '本轮入库');
      showToast(`产品扫描完成: 新候选 ${result.product_scan.candidates_added || 0}`);
    } else {
      const result = await call({
        action: 'discover_competitors_via_agent',
        max_results: Number($('productAiN')?.value) || 10,
      });
      state.competitors = result.competitors || state.competitors;
      state.products = result.products || state.products;
      state.scanRuns = result.scan_runs || state.scanRuns;
      state.summary = result.summary || state.summary;
      render();
      const items = Array.isArray(result.discovery?.items) ? result.discovery.items : [];
      renderLatestBatch('product', items, `本轮 Agent 发现 ${items.length} 条 · 新候选 +${result.discovery?.candidates_added || 0}`);
      showToast(`Agent 智能发现 ${items.length} 条新候选 (model: ${result.discovery?.model || '?'})`);
    }
  } catch (error) {
    showToast(error.message || '扫描失败', 'bad');
  } finally {
    state.scanning.product = false;
    button.disabled = false;
    button.textContent = '立即扫描产品';
    renderSchedule();
  }
}

async function runProductBulkScan() {
  const button = $('productBulkScanBtn');
  const tracked = (state.competitors?.official || []).length;
  const withAi = $('productScanWithAi').checked;
  const aiCost = withAi ? estimateAiCost({ kind: 'product', count: Math.min(tracked || 5, 10) }) : null;
  const body = withAi
    ? `将真实抓取所有 ${tracked} 个已跟踪产品的页面快照（${Math.max(5, tracked * 3)} 秒），随后用 ${channelLabel('product')} 对重扫产品做深度阅读。AI 阶段预计 ${aiCost ? formatAiCost(aiCost) : '60-180 秒'}。`
    : `将真实抓取所有 ${tracked} 个已跟踪产品的页面快照，可能耗时 ${Math.max(5, tracked * 3)} 秒（不做 AI 阅读）。`;
  const ok = await confirmDialog({
    title: withAi ? '重扫 + AI 深度阅读产品？' : '重扫所有已跟踪产品？',
    body,
    confirmText: '确认重扫',
  });
  if (!ok) return;
  await doProductBulkScan({ button });
  if (withAi) await doAiScan('product', { button: $('productAiScanBtn') });
}

async function doProductBulkScan({ button } = {}) {
  const btn = button || $('productBulkScanBtn');
  state.scanning.product = true;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '扫描中...';
  renderSchedule();
  try {
    const result = await call({
      action: 'scan_product_url',
      all_tracked: true,
      discover: true,
    });
    state.competitors = result.competitors || state.competitors;
    state.products = result.products || state.products;
    state.scanRuns = result.scan_runs || state.scanRuns;
    state.summary = result.summary || state.summary;
    render();
    renderLatestBatch('product', result.product_scan?.touched_items || [], `本轮重扫 ${result.product_scan?.touched_count ?? 0} 条`);
    showToast(`产品重扫完成: 涉及 ${result.product_scan?.touched_count ?? 0} 条, 新候选 +${result.product_scan?.candidates_added || 0}`);
    return { ok: true, touched: result.product_scan?.touched_count ?? 0 };
  } catch (error) {
    showToast(error.message || '批量重扫失败', 'bad');
    return { ok: false, error: error.message };
  } finally {
    state.scanning.product = false;
    btn.disabled = false;
    btn.textContent = originalText || '重扫所有已跟踪产品';
    renderSchedule();
  }
}

async function runEvolutionScan() {
  const button = $('evolutionScanBtn');
  const ok = await confirmDialog({
    title: '扫描最新自进化？',
    body: '将从 git log 读取最新提交（自上次扫描以来）并同步为 L1 自进化事件。',
    confirmText: '确认扫描',
  });
  if (!ok) return;
  await doEvolutionScan({ button });
}

async function doEvolutionScan({ button } = {}) {
  const btn = button || $('evolutionScanBtn');
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '扫描中...';
  try {
    const result = await call({
      action: 'seed_evolution_from_git',
      since: 'auto',
      limit: 80,
    });
    if (Array.isArray(result.feed?.items)) {
      state.evolution.feeds.L1 = result.feed.items.map((item, index) => normalizeEvolutionEvent(item, 'L1', index));
      state.evolution.offsets.L1 = state.evolution.feeds.L1.length;
      state.evolution.totals.L1 = Number.isFinite(result.feed?.total) ? result.feed.total : state.evolution.feeds.L1.length;
      state.evolution.source = 'backend';
    }
    renderEvolution();
    renderLatestBatch('evolution', result.seed?.new_events || [], `本轮新增 ${result.seed?.new_count ?? 0} 条`);
    showToast(`自进化扫描完成: 新增 ${result.seed?.new_count ?? 0} / 读取 ${result.seed?.total_scanned ?? 0}`);
    return { ok: true, newCount: result.seed?.new_count ?? 0 };
  } catch (error) {
    showToast(error.message || '自进化扫描失败', 'bad');
    return { ok: false, error: error.message };
  } finally {
    btn.disabled = false;
    btn.textContent = originalText || '扫描最新自进化';
  }
}

async function runOneClickScan() {
  const button = $('finaleRefreshBtn');
  const tracked = (state.competitors?.official || []).length;
  const paperN = 10;
  const productN = Math.min(tracked || 5, 5);
  const aiOn = $('oneClickAiAlso')?.checked !== false;
  const aiCostPaper = aiOn ? estimateAiCost({ kind: 'paper', count: paperN }) : null;
  const aiCostProd = aiOn ? estimateAiCost({ kind: 'product', count: productN }) : null;
  const aiTotalSec = aiOn ? (aiCostPaper.seconds + aiCostProd.seconds) : 0;
  const totalSec = 15 + Math.max(5, tracked * 3) + 5 + aiTotalSec;
  const aiLine = aiOn ? `；④ 论文+产品 AI 深度阅读（${channelLabel('paper')}，~${Math.round(aiTotalSec / 60)} 分钟）` : '';
  const ok = await confirmDialog({
    title: aiOn ? '一键扫描 + AI 阅读？' : '一键扫描全部？',
    body: `将依次执行：① 论文 arXiv 拉取；② ${tracked} 个已跟踪产品的页面抓取；③ git log 同步自进化${aiLine}。预计共 ${Math.round(totalSec / 60)} 分钟，会真实发起外部网络请求与 AI 调用。`,
    confirmText: '确认一键扫描',
  });
  if (!ok) return;
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = '扫描中...';
  closeLatestBatch('paper');
  closeLatestBatch('product');
  closeLatestBatch('evolution');
  try {
    const results = [];
    results.push(['论文', await doArxivScan({ button: $('arxivScanForm').querySelector('button[type="submit"]') })]);
    if (aiOn) results.push(['论文 AI', await doAiScan('paper', { button: $('paperAiScanBtn') })]);
    results.push(['产品', await doProductBulkScan({ button: $('productBulkScanBtn') })]);
    if (aiOn) results.push(['产品 AI', await doAiScan('product', { button: $('productAiScanBtn') })]);
    results.push(['自进化', await doEvolutionScan({ button: $('evolutionScanBtn') })]);
    const failed = results.filter(([, r]) => !r?.ok);
    if (failed.length) {
      showToast(`一键扫描完成，${failed.length} 项失败: ${failed.map(([n]) => n).join('、')}`, 'bad');
    } else {
      showToast('一键扫描完成');
    }
  } finally {
    button.disabled = false;
    button.textContent = originalText || '一键扫描';
  }
}

async function saveKeywords(scope, textareaId) {
  try {
    const keywords = parseKeywordTextarea($(textareaId).value);
    const result = await call({ action: 'update_keywords', scope, keywords });
    state.keywords[scope] = result.keywords[scope] || [];
    renderKeywordControls();
    showToast('关键词已保存');
  } catch (error) {
    showToast(error.message || '保存失败', 'bad');
  }
}

async function updateCompetitor(payload) {
  try {
    const result = await call({ action: 'update_competitors', ...payload });
    state.competitors = result.competitors || state.competitors;
    state.products = result.products || state.products;
    state.summary = result.summary || state.summary;
    renderCompetitors();
    showToast('产品状态已更新');
  } catch (error) {
    showToast(error.message || '更新失败', 'bad');
  }
}

function setTab(tab, shouldScroll = false) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.id === `panel-${tab}`);
  });
  if (shouldScroll && tab === 'papers') $('paper-section').scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (shouldScroll && tab === 'competitors') $('competitor-section').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function detailChatKey(kind, id) {
  return `${kind}:${id}`;
}

function getDetailChat(kind, id) {
  const key = detailChatKey(kind, id);
  if (!detailChats.has(key)) {
    detailChats.set(key, {
      loading: false,
      messages: [{
        role: 'assistant',
        content: kind === 'product'
          ? '我已读完这个产品的页面快照，可以问我关于定位、差异、可借鉴点等任何问题。'
          : '我已读完这篇论文的摘要，可以问我关于方法、实验、结论等任何问题。',
        time: new Date().toISOString(),
      }],
    });
  }
  return detailChats.get(key);
}

function renderChatMessages(chat) {
  const rows = chat.messages.map((message) => {
    const toneClass = message.tone === 'error' ? 'is-error' : (message.tone === 'warn' ? 'is-warn' : '');
    const metaHtml = message.meta ? `<div class="detail-chat-meta">${escapeHtml(message.meta)}</div>` : '';
    return `
    <div class="detail-chat-message ${message.role === 'user' ? 'is-user' : 'is-ai'} ${toneClass}">
      <div class="detail-chat-bubble">${escapeHtml(message.content)}${metaHtml}</div>
      <time>${escapeHtml(formatChatTime(message.time))}</time>
    </div>
  `;
  });
  if (chat.loading) {
    rows.push(`
      <div class="detail-chat-message is-ai is-loading">
        <div class="detail-chat-bubble">AI 正在阅读上下文...</div>
        <time>${escapeHtml(formatChatTime(new Date().toISOString()))}</time>
      </div>
    `);
  }
  return rows.join('');
}

function renderDetailChatSection(kind, id) {
  const chat = getDetailChat(kind, id);
  return `
    <section class="detail-chat" aria-label="AI 聊天区">
      <div class="detail-section-head">
        <h3>向 AI 请教这${kind === 'product' ? '个产品' : '篇论文'}</h3>
        <span>${kind === 'product' ? 'Product context' : 'Paper context'}</span>
      </div>
      <div class="detail-chat-messages" id="detailChatMessages" aria-live="polite">
        ${renderChatMessages(chat)}
      </div>
      <form class="detail-chat-form" data-chat-kind="${escapeHtml(kind)}" data-chat-id="${escapeHtml(id)}">
        <textarea id="detailChatInput" rows="3" maxlength="1200" placeholder="输入你的问题，例如：这篇论文的核心方法是什么？"></textarea>
        <button id="detailChatSubmit" class="primary-button" type="submit" ${chat.loading ? 'disabled' : ''}>${chat.loading ? '发送中' : '发送'}</button>
      </form>
    </section>
  `;
}

function refreshDetailChat(kind, id) {
  const chat = getDetailChat(kind, id);
  const messages = $('detailChatMessages');
  const button = $('detailChatSubmit');
  if (!messages || !button) return;
  messages.innerHTML = renderChatMessages(chat);
  messages.scrollTop = messages.scrollHeight;
  button.disabled = chat.loading;
  button.textContent = chat.loading ? '发送中' : '发送';
}

function renderDetailActionButton(kind, id, action, label, tone, active, disabled = false) {
  const attr = kind === 'product' ? 'data-product-detail-action' : 'data-paper-detail-action';
  const pending = detailPending[detailChatKey(kind, id)];
  return `
    <button
      type="button"
      class="detail-action-button ${active ? 'is-active' : ''}"
      data-tone="${escapeHtml(tone)}"
      ${attr}="${escapeHtml(id)}"
      data-action="${escapeHtml(action)}"
      ${pending || disabled || active ? 'disabled' : ''}
    >${escapeHtml(label)}</button>
  `;
}

function renderPaperDetailActions(item) {
  const local = paperLocal(item.id);
  const verdict = state.feedbacks[item.id] || '';
  const mark = item.mark || '';
  const excludeActive = verdict === 'exclude' || !!local.excluded;
  const boostActive = verdict === 'boost' || !!local.boost;
  const readActive = !!local.read || mark === 'read';
  const fusionActive = !!local.fusion || mark === 'fusion';
  return `
    <section class="detail-actions" aria-label="论文处理动作">
      <div class="detail-section-head">
        <h3>处理这篇论文</h3>
        <span>${detailPending[detailChatKey('paper', item.id)] ? '提交中' : '本地状态实时同步雷达'}</span>
      </div>
      <div class="detail-action-row">
        ${renderDetailActionButton('paper', item.id, 'exclude', excludeActive ? '不重要 ✓' : '标记不重要', 'danger', excludeActive)}
        ${renderDetailActionButton('paper', item.id, 'boost', boostActive ? '重要 ✓' : '标记重要', 'blue', boostActive)}
        ${renderDetailActionButton('paper', item.id, 'read', readActive ? '已读 ✓' : '标记已读', 'muted', readActive)}
        ${renderDetailActionButton('paper', item.id, 'fusion', fusionActive ? '融合队列 ✓' : '标记需要直接融合', 'purple', fusionActive)}
      </div>
    </section>
  `;
}

function renderProductDetailActions(item) {
  const local = competitorLocal(item.id);
  const mark = item.mark || '';
  const excludeActive = mark === 'exclude' || !!local.excluded;
  const boostActive = mark === 'boost' || !!local.boost;
  const readActive = !!local.read || mark === 'read';
  const fusionActive = mark === 'fusion' || !!local.fusion;
  return `
    <section class="detail-actions" aria-label="产品处理动作">
      <div class="detail-section-head">
        <h3>处理这个产品</h3>
        <span>${detailPending[detailChatKey('product', item.id)] ? '提交中' : '动作会同步到产品标记'}</span>
      </div>
      <div class="detail-action-row">
        ${renderDetailActionButton('product', item.id, 'exclude', excludeActive ? '不重要 ✓' : '标记不重要', 'danger', excludeActive)}
        ${renderDetailActionButton('product', item.id, 'boost', boostActive ? '重要 ✓' : '标记重要', 'blue', boostActive)}
        ${renderDetailActionButton('product', item.id, 'read', readActive ? '已读 ✓' : '标记已读', 'muted', readActive)}
        ${renderDetailActionButton('product', item.id, 'fusion', fusionActive ? '融合队列 ✓' : '标记需要直接融合', 'purple', fusionActive)}
      </div>
    </section>
  `;
}

function renderInspirationDetailBlock(rawInspiration, markExcluded, kind) {
  if (markExcluded) {
    return `<section class="detail-block detail-inspiration is-excluded">
      <h3>对莫比乌斯的借鉴方向</h3>
      <p class="muted">L2 Agent 阅读后判定该${kind === 'product' ? '产品' : '论文'}暂无借鉴价值，已自动标记为排除。</p>
    </section>`;
  }
  const items = parseInspiration(rawInspiration);
  if (!items.length) {
    return `<section class="detail-block detail-inspiration is-pending">
      <h3>对莫比乌斯的借鉴方向</h3>
      <p class="muted">尚未经过 L2 Agent 深度阅读。可以在追问区直接提问，或回到列表点 "AI 深度阅读"。</p>
    </section>`;
  }
  const list = items.map((it) => `
    <li class="inspiration-item priority-${it.priority}">
      <div class="inspiration-item-head">
        <span class="priority-tag ${it.priority}">${it.priority === 'high' ? '高优先' : it.priority === 'medium' ? '中优先' : '低优先'}</span>
        <strong>${escapeHtml(it.title || it.direction.slice(0, 40))}</strong>
      </div>
      ${it.direction ? `<p class="inspiration-direction"><span class="direction-label">启发方向</span> ${escapeHtml(it.direction)}</p>` : ''}
      ${it.mobius_use ? `<p class="inspiration-mobius-use"><span class="mobius-use-label">具体落实</span> ${escapeHtml(it.mobius_use)}</p>` : ''}
    </li>
  `).join('');
  return `<section class="detail-block detail-inspiration is-loaded">
    <div class="detail-section-head">
      <h3>对莫比乌斯的借鉴方向</h3>
      <span>L2 Agent · ${items.length} 条</span>
    </div>
    <ul class="inspiration-list">${list}</ul>
    <div class="detail-inspiration-actions">
      <button type="button" class="primary-button" data-export-prompt="${escapeHtml(kind)}">实际修改（导出给小莫）</button>
    </div>
  </section>`;
}

function renderPaperDetail(id) {
  const item = findPaperById(id);
  if (!item) return false;
  $('dialogBody').dataset.detailKind = 'paper';
  $('dialogBody').dataset.detailId = id;
  const tags = [...new Set([...(item.matched_keywords || []), ...(item.tags || [])])].slice(0, 10);
  const isExcluded = item.mark === 'excluded';
  $('dialogBody').innerHTML = `
    <article class="detail-content">
      <p class="eyebrow">Paper detail · L2 Agent 已${isExcluded ? '排除' : (item.ai_inspiration ? '阅读' : '未读')}</p>
      <h2>${escapeHtml(item.title)}</h2>
      <p class="detail-meta">${escapeHtml(item.authors || '作者未知')} · ${escapeHtml(item.published_at || '日期未知')} · Priority ${escapeHtml(item.priority_score ?? item.relevance ?? 0)} · 相关度 ${escapeHtml(item.relevance ?? '')}</p>
      <div class="tag-row">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      ${renderInspirationDetailBlock(item.ai_inspiration, isExcluded, 'paper')}
      <section class="detail-block">
        <h3>摘要</h3>
        <p>${escapeHtml(item.abstract || '暂无摘要')}</p>
      </section>
      ${renderPaperDetailActions(item)}
      ${renderDetailChatSection('paper', id)}
      <div class="card-actions">${item.source_url ? `<a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">打开 arXiv</a>` : ''}</div>
    </article>
  `;
  requestAnimationFrame(() => refreshDetailChat('paper', id));
  return true;
}

function renderProductDetail(id) {
  const item = findProductById(id);
  if (!item) return false;
  $('dialogBody').dataset.detailKind = 'product';
  $('dialogBody').dataset.detailId = id;
  const isExcluded = item.mark === 'excluded';
  $('dialogBody').innerHTML = `
    <article class="detail-content">
      <p class="eyebrow">Product snapshot · L2 Agent 已${isExcluded ? '排除' : (item.ai_inspiration ? '阅读' : '未读')}</p>
      <h2>${escapeHtml(item.name)}</h2>
      <p class="detail-meta">${escapeHtml(labels.category[item.category] || item.category || '其他')} · ${escapeHtml(labels.status[item.status] || item.status)} · 相关度 ${escapeHtml(item.relevance ?? 0)}/10 · last scanned ${escapeHtml(formatTime(item.last_scanned_at))}</p>
      <div class="tag-row">${(item.tags || []).slice(0, 10).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      ${renderInspirationDetailBlock(item.ai_inspiration, isExcluded, 'product')}
      <section class="detail-block">
        <h3>页面快照</h3>
        <p><strong>页面标题</strong><br>${escapeHtml(item.fetched_title || '暂无标题快照')}</p>
        <p><strong>页面描述</strong><br>${escapeHtml(item.fetched_description || '暂无描述快照')}</p>
        <p><strong>入库理由</strong><br>${escapeHtml(item.reason || '暂无理由')}</p>
        <p class="muted">发现逻辑: ${escapeHtml(item.discovery_logic || 'manual')}${item.discovered_from_url ? ` · 来源 ${escapeHtml(item.discovered_from_url)}` : ''}</p>
      </section>
      ${renderProductDetailActions(item)}
      ${renderDetailChatSection('product', id)}
      <div class="card-actions">${item.source_url ? `<a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">打开产品页</a>` : ''}</div>
    </article>
  `;
  requestAnimationFrame(() => refreshDetailChat('product', id));
  return true;
}

function shouldSyncReadMark(mark) {
  return !['boost', 'exclude', 'fusion'].includes(mark || '');
}

function syncOpenedRead(kind, id, mark = '') {
  if (!shouldSyncReadMark(mark)) return;
  if (kind === 'paper') {
    call({ action: 'mark_paper', id, mark: 'read', note: '用户打开详情页自动标记已读' }).catch(() => {});
    return;
  }
  call({ action: 'mark_product', id, mark: 'read', note: '用户打开详情页自动标记已读' })
    .then((result) => {
      state.competitors = result.competitors || state.competitors;
    })
    .catch(() => {});
}

function openPaperDetail(id) {
  const item = findPaperById(id);
  if (!item) return;
  const local = paperLocal(id);
  local.read = true;
  saveLocalState();
  if (renderPaperDetail(id) && !$('detailDialog').open) $('detailDialog').showModal();
  syncOpenedRead('paper', id, item.mark || '');
  renderPapers();
  updateRadarDiscoveries();
}

function openProductDetail(id) {
  const item = findProductById(id);
  if (!item) return;
  const local = competitorLocal(id);
  local.read = true;
  saveLocalState();
  if (renderProductDetail(id) && !$('detailDialog').open) $('detailDialog').showModal();
  syncOpenedRead('product', id, item.mark || '');
  renderCompetitors();
  updateRadarDiscoveries();
}

function rerenderOpenDetail(kind, id) {
  if (!$('detailDialog').open || $('dialogBody').dataset.detailKind !== kind || $('dialogBody').dataset.detailId !== id) return;
  if (kind === 'paper') renderPaperDetail(id);
  if (kind === 'product') renderProductDetail(id);
}

async function handlePaperDetailAction(id, action) {
  const item = findPaperById(id);
  if (!item) return;
  const key = detailChatKey('paper', id);
  if (detailPending[key]) return;
  const previousLocal = { ...paperLocal(id) };
  const previousFeedback = state.feedbacks[id];
  detailPending[key] = action;

  try {
    const local = paperLocal(id);
    if (action === 'exclude' || action === 'boost') {
      const verdict = action === 'exclude' ? 'exclude' : 'boost';
      local.reviewed = true;
      local.excluded = verdict === 'exclude';
      local.boost = verdict === 'boost';
      state.feedbacks[id] = verdict;
      saveLocalState();
      renderPapers();
      updateRadarDiscoveries();
      rerenderOpenDetail('paper', id);
      await call({ action: 'submit_feedback', paper_id: id, verdict });
      showToast(verdict === 'exclude' ? '已标记不重要' : '已标记重要');
    } else if (action === 'read') {
      local.read = true;
      saveLocalState();
      renderPapers();
      updateRadarDiscoveries();
      rerenderOpenDetail('paper', id);
      await call({ action: 'mark_paper', id, mark: 'read', note: '用户在详情页标记已读' });
      showToast('已标记已读');
    } else if (action === 'fusion') {
      local.reviewed = true;
      local.fusion = true;
      saveLocalState();
      renderPapers();
      updateRadarDiscoveries();
      rerenderOpenDetail('paper', id);
      await call({ action: 'mark_paper', id, mark: 'fusion', note: '用户在详情页标记需要直接融合' });
      showToast('已加入融合队列');
    }
  } catch (error) {
    state.local.papers[id] = previousLocal;
    if (previousFeedback) state.feedbacks[id] = previousFeedback;
    else delete state.feedbacks[id];
    saveLocalState();
    showToast(error.message || '操作失败，已回滚', 'bad');
  } finally {
    delete detailPending[key];
    renderPapers();
    updateRadarDiscoveries();
    rerenderOpenDetail('paper', id);
  }
}

async function handleProductDetailAction(id, action) {
  const item = findProductById(id);
  if (!item) return;
  const key = detailChatKey('product', id);
  if (detailPending[key]) return;
  const previousLocal = { ...competitorLocal(id) };
  const previousCompetitors = state.competitors;
  detailPending[key] = action;

  try {
    const local = competitorLocal(id);
    const mark = action === 'boost' ? 'boost' : action;
    if (action === 'read') local.read = true;
    if (action === 'exclude') {
      local.reviewed = true;
      local.excluded = true;
    }
    if (action === 'boost') {
      local.reviewed = true;
      local.boost = true;
    }
    if (action === 'fusion') {
      local.reviewed = true;
      local.fusion = true;
    }
    saveLocalState();
    renderCompetitors();
    updateRadarDiscoveries();
    rerenderOpenDetail('product', id);
    const result = await call({ action: 'mark_product', id, mark, note: `用户在详情页标记: ${action}` });
    state.competitors = result.competitors || state.competitors;
    showToast(action === 'fusion' ? '已加入融合队列' : '产品标记已更新');
  } catch (error) {
    state.local.competitors[id] = previousLocal;
    state.competitors = previousCompetitors;
    saveLocalState();
    showToast(error.message || '产品操作失败，已回滚', 'bad');
  } finally {
    delete detailPending[key];
    renderCompetitors();
    updateRadarDiscoveries();
    rerenderOpenDetail('product', id);
  }
}

async function handleDetailChatSubmit(event) {
  const form = event.target.closest?.('.detail-chat-form');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.chatKind;
  const id = form.dataset.chatId;
  const input = form.querySelector('textarea');
  const message = input?.value.trim();
  if (!message || !kind || !id) return;

  const chat = getDetailChat(kind, id);
  if (chat.loading) return;
  chat.messages.push({ role: 'user', content: message, time: new Date().toISOString() });
  chat.loading = true;
  input.value = '';
  refreshDetailChat(kind, id);

  try {
    const result = await call({
      action: 'chat_with_agent',
      kind,
      scope_id: id,
      message,
      model_key: state.aiChannel[kind],
    });
    let reply = (result.reply || '').trim();
    const toolCalls = Number(result.tool_calls || 0);
    if (!reply) {
      reply = toolCalls > 0
        ? `（Agent 已调用 ${toolCalls} 次工具查阅代码 / 修改启发，但本轮没有输出文字回答。可以换个具体问题，例如：它具体做了什么 / 跟莫比乌斯对标的字段在哪 / 实现成本估算。）`
        : '（Agent 本轮没有生成可用回复。可以换个更具体的问法，或在 AI 渠道下拉换一个模型再试。）';
    }
    const meta = [];
    if (result.provider) meta.push(result.provider);
    if (result.context_messages) meta.push(`已带上下文 ${result.context_messages} 条`);
    if (result.tokens?.input || result.tokens?.output) meta.push(`tokens in/out=${result.tokens.input}/${result.tokens.output}`);
    const inspirationDiff = Array.isArray(result.inspiration_diff) ? result.inspiration_diff : [];
    const okOps = inspirationDiff.filter((op) => op.ok);
    for (const op of inspirationDiff) {
      const verb = op.action === 'update_inspiration' ? '修改' : op.action === 'add_inspiration' ? '新增' : '删除';
      const title = op.title || '';
      const tail = op.action === 'delete_inspiration' ? '' : ` → ${op.priority || ''}`;
      const flag = op.ok ? '' : ' (失败)';
      meta.push(`已${verb}启发${title ? '：' + title : ''}${tail}${flag}`);
    }
    if (result.inspiration_changed && okOps.length) {
      try {
        if (kind === 'paper') {
          const fresh = await call({ action: 'get_paper', id });
          const updated = fresh?.item;
          if (updated) {
            const items = Array.isArray(state.papers.items) ? state.papers.items : [];
            const idx = items.findIndex((it) => it.id === updated.id || it.source_id === updated.id);
            if (idx >= 0) state.papers.items[idx] = { ...items[idx], ...updated };
            const radar = Array.isArray(state.radarTopPicks) ? state.radarTopPicks : [];
            const rIdx = radar.findIndex((it) => it.id === updated.id);
            if (rIdx >= 0) state.radarTopPicks[rIdx] = { ...radar[rIdx], ...updated };
            for (const clusterKey of Object.keys(state.clusterPapers || {})) {
              const arr2 = state.clusterPapers[clusterKey] || [];
              const cIdx = arr2.findIndex((it) => it.id === updated.id);
              if (cIdx >= 0) state.clusterPapers[clusterKey][cIdx] = { ...arr2[cIdx], ...updated };
            }
            renderPapers();
            rerenderOpenDetail('paper', id);
            updateRadarDiscoveries?.();
          }
        } else if (kind === 'product') {
          const fresh = await call({ action: 'get_product', id });
          const updated = fresh?.item;
          if (updated) {
            const normalizedStatus = updated.tracked_status === 'tracked' ? 'official' : updated.tracked_status;
            const bucketKey = normalizedStatus === 'official' ? 'official' : 'candidate';
            const bucket = Array.isArray(state.competitors?.[bucketKey]) ? state.competitors[bucketKey] : [];
            const idx = bucket.findIndex((it) => it.id === updated.id);
            if (idx >= 0) state.competitors[bucketKey][idx] = { ...bucket[idx], ...updated };
            renderCompetitors();
            rerenderOpenDetail('product', id);
            updateRadarDiscoveries?.();
          }
        }
        showToast(`已更新 ${okOps.length} 条启发`);
      } catch (refreshErr) {
        showToast(`启发已写入但刷新失败: ${refreshErr.message || ''}`, 'bad');
      }
    }
    chat.messages.push({
      role: 'assistant',
      content: reply,
      meta: meta.length ? meta.join(' · ') : '',
      time: new Date().toISOString(),
      model: result.model || '',
      tone: !result.reply ? 'warn' : undefined,
    });
  } catch (error) {
    const reason = (error.message || '').toLowerCase().includes('agent run')
      ? '尚未跑过 AI Agent 扫描，请先点 "AI 深度阅读" 按钮。'
      : (error.message || 'AI 暂不可用，请稍后再试');
    chat.messages.push({
      role: 'assistant',
      content: `AI 暂不可用：${reason}`,
      tone: 'error',
      time: new Date().toISOString(),
    });
    showToast(reason, 'bad');
  } finally {
    chat.loading = false;
    refreshDetailChat(kind, id);
  }
}

async function handleExportPrompt(kind) {
  const dialog = $('promptExportDialog');
  const body = $('promptExportBody');
  const copyBtn = $('promptExportCopy');
  if (!dialog || !body) return;
  body.innerHTML = '<p class="muted">小莫总结 Agent 正在提炼执行指令...</p>';
  copyBtn.disabled = true;
  if (!dialog.open) dialog.showModal();
  try {
    const result = await call({
      action: 'export_agent_prompt',
      kind,
      model_key: state.aiChannel[kind],
    });
    const prompt = result.prompt || '(Agent 未输出可执行的指令)';
    body.dataset.prompt = prompt;
    body.innerHTML = `<pre class="prompt-export-pre">${escapeHtml(prompt)}</pre>`;
    copyBtn.disabled = false;
    showToast(`执行指令已生成 (${prompt.length} 字)`);
  } catch (error) {
    body.innerHTML = `<p class="muted">生成失败: ${escapeHtml(error.message || '未知错误')}</p>`;
    showToast(error.message || '生成执行指令失败', 'bad');
  }
}

function bindPromptExportDialog() {
  const dialog = $('promptExportDialog');
  const copyBtn = $('promptExportCopy');
  $('promptExportClose')?.addEventListener('click', () => dialog.close());
  $('promptExportCancel')?.addEventListener('click', () => dialog.close());
  copyBtn?.addEventListener('click', async () => {
    const text = $('promptExportBody').dataset.prompt || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast('已复制到剪贴板，可粘贴到小莫');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); showToast('已复制'); } catch { showToast('复制失败', 'bad'); }
      ta.remove();
    }
  });
  if (dialog) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
}

async function toggleCluster(label) {
  const cluster = state.paperClusters.find((item) => item.label === label);
  if (!cluster) return;
  cluster.expanded = !cluster.expanded;
  if (cluster.expanded) await ensureClusterPapers(label);
  renderPapers();
  if (cluster.expanded) {
    requestAnimationFrame(() => document.getElementById(clusterDomId(label))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
}

async function loadMoreCluster(label) {
  const cluster = state.paperClusters.find((item) => item.label === label);
  if (!cluster) return;
  await ensureClusterPapers(label, { offset: cluster.offset || 0, limit: 20, force: true });
  renderPapers();
}

async function submitPaperFeedback(paperIdValue, verdict) {
  const previous = state.feedbacks[paperIdValue];
  state.feedbacks[paperIdValue] = verdict;
  state.feedbackPending[paperIdValue] = verdict;
  renderPapers();
  try {
    await call({ action: 'submit_feedback', paper_id: paperIdValue, verdict });
    delete state.feedbackPending[paperIdValue];
    state.backendStatus.feedbacks = 'connected';
    renderPapers();
    showToast(`反馈已提交: ${feedbackLabel(verdict)}`);
  } catch (error) {
    if (previous) state.feedbacks[paperIdValue] = previous;
    else delete state.feedbacks[paperIdValue];
    delete state.feedbackPending[paperIdValue];
    state.backendStatus.feedbacks = 'missing';
    renderPapers();
    showToast(error.message || '反馈提交失败，已回滚', 'bad');
  }
}

async function setEvolutionLevel(level) {
  state.evolution.level = level;
  if (!state.evolution.feeds[level]?.length) await loadEvolutionLevel(level);
  renderEvolution();
}

async function promoteL2ToL1(id) {
  const item = state.evolution.feeds.L2.find((event) => event.id === id);
  if (!item) return;
  const previous = item.status;
  item.status = 'promoted_to_L1';
  state.evolution.pending[id] = true;
  renderEvolution();
  try {
    await call({ action: 'promote_L2_to_L1', id, event_id: id });
    delete state.evolution.pending[id];
    showToast('L2 已批准并升级 L1');
    await loadEvolutionLevel('L1');
    renderEvolution();
  } catch (error) {
    item.status = previous;
    delete state.evolution.pending[id];
    renderEvolution();
    showToast(error.message || 'promote 失败，已回滚', 'bad');
  }
}

async function rejectL2(id) {
  const item = state.evolution.feeds.L2.find((event) => event.id === id);
  if (!item) return;
  const previous = item.status;
  item.status = 'rejected';
  state.evolution.pending[id] = true;
  renderEvolution();
  try {
    await call({ action: 'reject_L2', id, event_id: id });
    delete state.evolution.pending[id];
    showToast('L2 已拒绝');
  } catch {
    item.status = previous;
    delete state.evolution.pending[id];
    renderEvolution();
    showToast('拒绝接口未连通，已回滚', 'bad');
  }
}

function bindScrollEffects() {
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) entry.target.classList.add('is-visible');
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -80px 0px' });
  document.querySelectorAll('.reveal').forEach((node) => revealObserver.observe(node));

  const nav = $('topNav');
  const sectionLinks = [...document.querySelectorAll('.section-link')];
  const trackedSections = [...document.querySelectorAll('main > section[id]')];
  let ticking = false;
  const updateActiveSection = () => {
    ticking = false;
    const viewportAnchor = window.innerHeight * 0.42;
    let active = trackedSections[0];
    let best = Number.POSITIVE_INFINITY;
    for (const section of trackedSections) {
      const rect = section.getBoundingClientRect();
      const topDistance = Math.abs(rect.top - viewportAnchor);
      const centerDistance = Math.abs((rect.top + rect.bottom) / 2 - window.innerHeight / 2);
      const distance = rect.top <= viewportAnchor && rect.bottom >= viewportAnchor
        ? topDistance * 0.35
        : centerDistance;
      if (distance < best) {
        best = distance;
        active = section;
      }
    }
    nav.dataset.theme = active.dataset.navTheme || 'dark';
    document.documentElement.dataset.section = active.dataset.section || 'paper';
    sectionLinks.forEach((link) => {
      link.classList.toggle('is-active', link.dataset.sectionTarget === active.id);
    });
  };
  const requestActiveSectionUpdate = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateActiveSection);
  };
  window.addEventListener('scroll', requestActiveSectionUpdate, { passive: true });
  window.addEventListener('resize', requestActiveSectionUpdate);
  updateActiveSection();

  heroRing = initMobiusRing($('heroCanvas'), {
    onSelect(item) {
      if (!item?.id) return;
      if (item.type === 'product') openProductDetail(item.id);
      else openPaperDetail(item.id);
    },
  });
  const finale = initLogoBackdrop($('finaleCanvas'), 'finale');
  const sceneObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const api = entry.target.id === 'heroCanvas' ? heroRing : finale;
      if (!api) return;
      if (entry.isIntersecting) api.start();
      else api.pause();
    });
  }, { threshold: 0.05 });
  sceneObserver.observe($('heroCanvas'));
  sceneObserver.observe($('finaleCanvas'));
}

function bindEvents() {
  $('refreshBtn').addEventListener('click', loadAll);
  $('finaleRefreshBtn').addEventListener('click', runOneClickScan);
  $('arxivScanForm').addEventListener('submit', runArxivScan);
  $('productScanForm').addEventListener('submit', runProductScan);
  $('productBulkScanBtn').addEventListener('click', runProductBulkScan);
  $('evolutionScanBtn').addEventListener('click', runEvolutionScan);
  $('paperAiScanBtn')?.addEventListener('click', () => runAiScan('paper'));
  $('productAiScanBtn')?.addEventListener('click', () => runAiScan('product'));
  $('paperAiChannel')?.addEventListener('change', (e) => { state.aiChannel.paper = e.target.value; });
  $('productAiChannel')?.addEventListener('change', (e) => { state.aiChannel.product = e.target.value; });
  $('paperShowExcluded')?.addEventListener('change', (e) => { state.showExcluded.paper = e.target.checked; renderPapers(); });
  $('competitorShowExcluded')?.addEventListener('change', (e) => { state.showExcluded.competitor = e.target.checked; renderCompetitors(); });
  bindPromptExportDialog();
  document.querySelectorAll('[data-close-latest]').forEach((btn) => {
    btn.addEventListener('click', () => closeLatestBatch(btn.dataset.closeLatest));
  });
  $('paperKeywordsForm').addEventListener('submit', (event) => {
    event.preventDefault();
    saveKeywords('paper', 'paperKeywords');
  });
  $('productKeywordsForm').addEventListener('submit', (event) => {
    event.preventDefault();
    saveKeywords('product', 'productKeywords');
  });
  $('refreshCompetitorsBtn').addEventListener('click', async () => {
    const result = await call({ action: 'get_competitors' });
    state.competitors = result.competitors || state.competitors;
    renderCompetitors();
    showToast('产品清单已刷新');
  });
  $('paperSearch').addEventListener('input', (event) => {
    state.filters.paper.q = event.target.value.trim();
    clearTimeout(bindEvents.paperTimer);
    bindEvents.paperTimer = setTimeout(() => refreshPapersFromServer().catch((error) => showToast(error.message, 'bad')), 220);
  });
  $('paperKeyword').addEventListener('change', (event) => {
    state.filters.paper.keyword = event.target.value;
    refreshPapersFromServer().catch((error) => showToast(error.message, 'bad'));
  });
  $('paperStatusFilter').addEventListener('change', (event) => {
    state.filters.paper.status = event.target.value;
    renderPapers();
  });
  $('paperFavoriteFilter').addEventListener('change', (event) => {
    state.filters.paper.favorite = event.target.value;
    renderPapers();
  });
  $('competitorStatusFilter').addEventListener('change', (event) => {
    state.filters.competitor.status = event.target.value;
    renderCompetitors();
  });
  $('competitorReadFilter').addEventListener('change', (event) => {
    state.filters.competitor.read = event.target.value;
    renderCompetitors();
  });
  $('competitorSearch').addEventListener('input', (event) => {
    state.filters.competitor.q = event.target.value.trim();
    renderCompetitors();
  });
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => setTab(button.dataset.tab, true));
  });
  document.querySelectorAll('.evo-tab').forEach((button) => {
    button.addEventListener('click', () => setEvolutionLevel(button.dataset.evoLevel));
  });
  $('evolutionProjectFilter').addEventListener('change', async (event) => {
    state.evolution.projectId = event.target.value;
    await loadEvolutionLevel('L1');
    renderEvolution();
  });
  $('dialogClose').addEventListener('click', () => $('detailDialog').close());
  $('detailDialog').addEventListener('click', (event) => {
    if (event.target === $('detailDialog')) $('detailDialog').close();
  });
  $('detailDialog').addEventListener('submit', handleDetailChatSubmit);
  document.body.addEventListener('click', (event) => {
    const openCluster = event.target.closest('[data-open-cluster]');
    if (openCluster) {
      const label = openCluster.dataset.openCluster;
      const cluster = state.paperClusters.find((item) => item.label === label);
      if (cluster && !cluster.expanded) toggleCluster(label);
      document.getElementById(clusterDomId(label))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    const toggle = event.target.closest('[data-toggle-cluster]');
    if (toggle) toggleCluster(toggle.dataset.toggleCluster);

    const loadMore = event.target.closest('[data-load-more-cluster]');
    if (loadMore) loadMoreCluster(loadMore.dataset.loadMoreCluster);

    const feedback = event.target.closest('[data-paper-feedback]');
    if (feedback) submitPaperFeedback(feedback.dataset.paperFeedback, feedback.dataset.feedback);

    const evoToggle = event.target.closest('[data-toggle-evolution]');
    if (evoToggle) {
      const id = evoToggle.dataset.toggleEvolution;
      state.evolution.expanded[id] = !state.evolution.expanded[id];
      renderEvolution();
    }

    const promoteL2 = event.target.closest('[data-promote-l2]');
    if (promoteL2) promoteL2ToL1(promoteL2.dataset.promoteL2);

    const reject = event.target.closest('[data-reject-l2]');
    if (reject) rejectL2(reject.dataset.rejectL2);

    const paperDetail = event.target.closest('[data-paper-detail]');
    if (paperDetail) openPaperDetail(paperDetail.dataset.paperDetail);

    const paperDetailAction = event.target.closest('[data-paper-detail-action]');
    if (paperDetailAction) handlePaperDetailAction(paperDetailAction.dataset.paperDetailAction, paperDetailAction.dataset.action);

    const paperRead = event.target.closest('[data-paper-read]');
    if (paperRead) {
      const local = paperLocal(paperRead.dataset.paperRead);
      local.read = !local.read;
      saveLocalState();
      renderPapers();
      updateRadarDiscoveries();
    }

    const paperFavorite = event.target.closest('[data-paper-favorite]');
    if (paperFavorite) {
      const local = paperLocal(paperFavorite.dataset.paperFavorite);
      local.favorite = !local.favorite;
      saveLocalState();
      renderPapers();
      updateRadarDiscoveries();
    }

    const paperArchive = event.target.closest('[data-paper-archive]');
    if (paperArchive) {
      const local = paperLocal(paperArchive.dataset.paperArchive);
      local.archived = !local.archived;
      saveLocalState();
      renderPapers();
      updateRadarDiscoveries();
    }

    const productDetail = event.target.closest('[data-product-detail]');
    if (productDetail) openProductDetail(productDetail.dataset.productDetail);

    const productDetailAction = event.target.closest('[data-product-detail-action]');
    if (productDetailAction) handleProductDetailAction(productDetailAction.dataset.productDetailAction, productDetailAction.dataset.action);

    const productRead = event.target.closest('[data-product-read]');
    if (productRead) {
      const local = competitorLocal(productRead.dataset.productRead);
      local.read = !local.read;
      saveLocalState();
      renderCompetitors();
      updateRadarDiscoveries();
    }

    const promote = event.target.closest('[data-promote]');
    if (promote) updateCompetitor({ mode: 'promote', id: promote.dataset.promote });

    const exportPrompt = event.target.closest('[data-export-prompt]');
    if (exportPrompt) handleExportPrompt(exportPrompt.dataset.exportPrompt);
  });
}

window.openPaperDetail = openPaperDetail;
window.openProductDetail = openProductDetail;

bindScrollEffects();
bindEvents();
loadAll();
