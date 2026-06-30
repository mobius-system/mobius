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
  sourceReviews: {},
  inspirationDecisions: {},
  implementationItems: [],
  implementationFilter: '',
  selected: {
    paper: '',
    product: '',
    inspiration: { paper: '', product: '' },
  },
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
      id: String(it.id || it.inspiration_id || it.key || '').slice(0, 220),
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

function sourceHost(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return value || '未知来源';
  }
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

function compactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  if (Math.abs(number) >= 1000) return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(number);
  return String(Math.round(number * 10) / 10);
}

function markValue(item) {
  return String(item?.mark || '').trim();
}

function isExcludedItem(item) {
  return ['excluded', 'exclude'].includes(markValue(item));
}

function markLabel(mark) {
  const map = {
    excluded: 'AI 排除',
    exclude: '不重要',
    boost: '重要',
    fusion: '融合队列',
    read: '已读标记',
  };
  return map[mark] || mark || '';
}

function aiReadState(item) {
  if (isExcludedItem(item)) return { key: 'excluded', label: 'AI 已排除', detail: '深度阅读后暂无借鉴价值' };
  const count = parseInspiration(item?.ai_inspiration).length;
  if (count) return { key: 'ready', label: `AI 已读 ${count}`, detail: `${count} 条借鉴方向` };
  return { key: 'pending', label: '待 AI 深读', detail: '尚未产出借鉴方向' };
}

function renderChip(label, tone = 'muted', title = '') {
  if (!label) return '';
  return `<span class="state-chip" data-tone="${escapeHtml(tone)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`;
}

function renderStateChips(kind, item, local) {
  const ai = aiReadState(item);
  const mark = markValue(item);
  const chips = [
    renderChip(local.read ? '已读' : '未读', local.read ? 'read' : 'unread', local.read ? `阅读时间 ${formatTime(item.read_at)}` : '尚未打开或标记阅读'),
    renderChip(ai.label, ai.key, ai.detail),
  ];
  if (kind === 'paper') {
    if (local.favorite) chips.push(renderChip('收藏', 'favorite'));
    if (local.archived) chips.push(renderChip('归档', 'muted'));
    if (state.feedbacks[item.id]) chips.push(renderChip(`反馈 ${feedbackLabel(state.feedbacks[item.id])}`, state.feedbacks[item.id]));
  } else {
    chips.push(renderChip(labels.status[item.status] || item.status || '候选', item.status === 'official' ? 'tracked' : 'candidate'));
    if (item.auto_discovered) chips.push(renderChip('自动发现', 'source'));
  }
  if (mark) chips.push(renderChip(markLabel(mark), isExcludedItem(item) ? 'excluded' : mark));
  return `<div class="state-chip-row">${chips.filter(Boolean).join('')}</div>`;
}

function renderScoreRail({ label, score, sublabel = '', tone = 'paper' }) {
  return `
    <div class="score-rail" data-tone="${escapeHtml(tone)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(compactNumber(score))}</strong>
      ${sublabel ? `<em>${escapeHtml(sublabel)}</em>` : ''}
    </div>
  `;
}

function renderFactGrid(items, extraClass = '') {
  const rows = (items || []).filter((item) => item && item.value !== undefined && item.value !== null && String(item.value).trim() !== '');
  if (!rows.length) return '';
  return `
    <dl class="fact-grid ${escapeHtml(extraClass)}">
      ${rows.map((item) => `
        <div>
          <dt>${escapeHtml(item.label)}</dt>
          <dd>${escapeHtml(item.value)}</dd>
        </div>
      `).join('')}
    </dl>
  `;
}

function paperFacts(item) {
  return [
    { label: 'Cluster', value: item.cluster_label || '未聚类' },
    { label: '关键词', value: (item.matched_keywords || []).slice(0, 3).join(' / ') },
    { label: 'arXiv ID', value: item.source_id || item.paper_id || '' },
    { label: '发布时间', value: item.published_at || '日期未知' },
    { label: '抓取时间', value: formatTime(item.fetched_at || item.created_at) },
    { label: '引用', value: item.citations ? compactNumber(item.citations) : '' },
  ];
}

function productFacts(item) {
  return [
    { label: '类别', value: labels.category[item.category] || item.category || '其他' },
    { label: '状态', value: labels.status[item.status] || item.status || '' },
    { label: '来源', value: item.auto_discovered ? 'Agent 自动发现' : '手动/种子入库' },
    { label: '扫描时间', value: formatTime(item.last_scanned_at || item.updated_at || item.created_at) },
    { label: '发现逻辑', value: item.discovery_logic || 'manual' },
    { label: '别名', value: (item.aliases || []).slice(0, 3).join(' / ') },
  ];
}

function arxivIdFrom(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/(?:arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?/i);
  return match ? match[1] : '';
}

function paperAlphaXivUrl(item) {
  const source = String(item?.source_url || '').trim();
  if (source && /arxiv/i.test(source)) return source.replace(/arxiv/ig, 'alphaxiv');
  const id = arxivIdFrom(item?.source_id || item?.paper_id || item?.id || source);
  return id ? `https://www.alphaxiv.org/abs/${encodeURIComponent(id)}` : source;
}

function sourceUrlFor(kind, item) {
  if (!item) return '';
  if (kind === 'paper') return paperAlphaXivUrl(item);
  return item.source_url || item.discovered_from_url || '';
}

function sourceLinkLabel(kind) {
  return kind === 'paper' ? '打开 AlphaXiv' : '打开产品页';
}

function renderSourceLink(kind, item, extraClass = '') {
  const url = sourceUrlFor(kind, item);
  if (!url) return '';
  return `
    <a class="source-link ${escapeHtml(extraClass)}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
      <span>${escapeHtml(sourceLinkLabel(kind))}</span>
      <strong>${escapeHtml(sourceHost(url))}</strong>
    </a>
  `;
}

function splitAuthors(value) {
  return String(value || '')
    .split(';')
    .map((name) => name.trim())
    .filter(Boolean);
}

function compactAuthors(value, limit = 4) {
  const authors = splitAuthors(value);
  if (!authors.length) return '作者未知';
  const shown = authors.slice(0, limit).join(' / ');
  return authors.length > limit ? `${shown} 等 ${authors.length} 位作者` : shown;
}

function priorityWeight(priority) {
  return { high: 0, medium: 1, low: 2 }[priority] ?? 1;
}

function priorityText(priority) {
  return priority === 'high' ? '高优先' : priority === 'low' ? '低优先' : '中优先';
}

function sortedInspirations(raw) {
  return parseInspiration(raw).sort((a, b) => priorityWeight(a.priority) - priorityWeight(b.priority));
}

function sourceReviewKey(kind, id) {
  return `${kind}:${id}`;
}

function reviewStatus(kind, item) {
  const review = state.sourceReviews[sourceReviewKey(kind, item?.id || '')];
  if (review?.status) return review.status;
  return isExcludedItem(item) ? 'excluded' : 'deferred';
}

function reviewStatusLabel(status) {
  if (status === 'resolved') return '已解决';
  if (status === 'excluded') return '已排除';
  return '搁置';
}

function inspirationKey(kind, sourceId, index, item) {
  return item?.id || `${kind}:${sourceId}:${index}`;
}

function inspirationDecisionKey(kind, sourceId, index, item) {
  return `${kind}:${sourceId}:${inspirationKey(kind, sourceId, index, item)}`;
}

function inspirationDecision(kind, sourceId, index, item) {
  return state.inspirationDecisions[inspirationDecisionKey(kind, sourceId, index, item)] || null;
}

function decisionStatusLabel(status) {
  const map = {
    accepted: '已接受 L2',
    rejected: '已拒绝',
    deferred: '已搁置',
    queued_one_click: '一键落实中',
    queued_plan: '修改后落实中',
    deleted: '已删除',
    candidate: '待决策',
  };
  return map[status] || '待决策';
}

function normalizeSourceReviews(rows = []) {
  const out = {};
  for (const row of rows || []) {
    if (!row?.source_kind || !row?.source_id) continue;
    out[sourceReviewKey(row.source_kind, row.source_id)] = row;
  }
  return out;
}

function normalizeInspirationDecisions(rows = []) {
  const out = {};
  for (const row of rows || []) {
    if (!row?.source_kind || !row?.source_id || !row?.inspiration_key) continue;
    out[`${row.source_kind}:${row.source_id}:${row.inspiration_key}`] = row;
  }
  return out;
}

function applyDecisionPayload(data = {}) {
  if (Array.isArray(data.source_reviews)) state.sourceReviews = normalizeSourceReviews(data.source_reviews);
  if (Array.isArray(data.inspiration_decisions)) {
    state.implementationItems = data.inspiration_decisions;
    state.inspirationDecisions = normalizeInspirationDecisions(data.inspiration_decisions);
  }
}

function topKeywords(item, limit = 5) {
  return [...new Set([...(item.matched_keywords || []), ...(item.cluster_keywords || []), ...(item.tags || [])])]
    .filter(Boolean)
    .slice(0, limit);
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

function evolutionText(item) {
  return [
    item.summary,
    item.diff_summary,
    item.project_id,
    ...(item.files_changed || []),
  ].join(' ').toLowerCase();
}

function classifyL1Event(item) {
  const text = evolutionText(item);
  const files = (item.files_changed || []).join(' ').toLowerCase();
  const rules = [
    {
      id: 'self-cognition-system',
      title: 'Self-Cognition 调研系统',
      description: '论文/产品调研、自进化雷达、L2 启发处理和本插件自身体验。',
      order: 10,
      signals: [['self-cognition', 5], ['self_cognition', 5], ['arxiv', 3], ['paper research', 3], ['product research', 3], ['decision workflow', 3], ['research radar', 3], ['论文调研', 3], ['产品调研', 3], ['自进化历史', 3], ['调研', 2]],
    },
    {
      id: 'docs-learning',
      title: '教程、文档与知识迁移',
      description: '教程、README、MkDocs、模型配置说明、技能/记忆迁移和使用指南。',
      order: 20,
      signals: [['tutorial', 5], ['docs', 4], ['documentation', 4], ['mkdocs', 4], ['readme', 4], ['guide', 3], ['i18n', 2], ['skill/mem', 4], ['model config', 3], ['model limits', 3], ['教程', 5], ['文档', 4], ['指南', 3]],
    },
    {
      id: 'frontend-experience',
      title: '前端体验与可视化',
      description: '页面布局、设计画布、移动端适配、WebGL fallback、卡片和弹窗交互。',
      order: 30,
      signals: [['frontend', 3], ['mobius-deck', 5], ['ui', 2], ['ux', 2], ['webgl', 4], ['canvas', 3], ['card', 2], ['detail', 2], ['dialog', 2], ['styles', 2], ['index.html', 2], ['overlap', 3], ['clipping', 3], ['viewport', 3], ['页面', 2], ['卡片', 2], ['详情', 2], ['弹窗', 2], ['移动端', 3], ['重叠', 3], ['展示', 2]],
    },
    {
      id: 'agent-reading',
      title: 'L2 Agent 深读与启发',
      description: 'AI 深读、启发提炼、追问、导出给小莫和 Agent run 上下文。',
      order: 40,
      signals: [['l2 ai', 5], ['deep read', 5], ['deep reading', 5], ['inspiration', 4], ['ai_inspiration', 5], ['agent run', 3], ['chat_with_agent', 4], ['深度阅读', 5], ['启发', 4], ['追问', 3], ['导出给小莫', 4]],
    },
    {
      id: 'assistant-ops',
      title: '助手运行与协作管理',
      description: '分身小莫、会话、巡逻提醒、Agent 监控、管理员中心和协作流程。',
      order: 50,
      signals: [['assistant', 4], ['session', 4], ['agent', 2], ['admin center', 4], ['patrol', 4], ['nudge', 4], ['exclude skills', 3], ['memory', 2], ['分身', 4], ['小莫', 3], ['会话', 4], ['巡逻', 4], ['提醒', 3], ['管理员', 3]],
    },
    {
      id: 'compute-infra',
      title: '算力、远程执行与基础设施',
      description: '远程算力、GPU、容器、部署、运行时环境和工程基础设施。',
      order: 60,
      signals: [['remote compute', 5], ['compute', 4], ['gpu', 5], ['docker', 3], ['container', 3], ['deploy', 3], ['runtime', 3], ['算力', 5], ['远程', 3], ['容器', 3], ['部署', 3]],
    },
    {
      id: 'billing-permission',
      title: '计费、权限与账户',
      description: '计费、授权、角色、账户、权限边界和安全策略。',
      order: 70,
      signals: [['billing', 5], ['payment', 4], ['auth', 4], ['permission', 4], ['role', 3], ['account', 3], ['security', 3], ['计费', 5], ['权限', 4], ['账户', 3], ['授权', 3], ['安全', 3]],
    },
    {
      id: 'backend-data',
      title: '后端数据与接口',
      description: '数据库、接口、schema、状态写入和后端兼容逻辑。',
      order: 80,
      signals: [['backend', 4], ['api', 3], ['db', 3], ['database', 4], ['schema', 4], ['table', 3], ['sqlite', 4], ['route', 2], ['service', 2], ['后端', 4], ['数据库', 4], ['接口', 3]],
    },
    {
      id: 'engineering-maintenance',
      title: '工程同步与维护',
      description: '合并同步、配置整理、阶段性提交、构建修复和难以归入业务域的维护改动。',
      order: 90,
      signals: [['merge remote', 5], ['merge', 4], ['sync', 4], ['stage', 4], ['config', 3], ['cleanup', 3], ['fix', 1], ['update', 1], ['replace', 1], ['change', 1], ['合并', 4], ['同步', 4], ['配置', 3], ['维护', 3]],
    },
  ];
  const scored = rules.map((rule) => ({
    ...rule,
    score: rule.signals.reduce((sum, [signal, weight]) => sum + (text.includes(signal.toLowerCase()) ? weight : 0), 0),
  })).sort((a, b) => b.score - a.score || a.order - b.order);
  if (scored[0]?.score > 0) return scored[0];
  if (files.includes('/frontend/') || files.startsWith('frontend/')) return rules.find((rule) => rule.id === 'frontend-experience');
  if (files.includes('/backend/') || files.startsWith('backend/')) return rules.find((rule) => rule.id === 'backend-data');
  return {
    id: 'other',
    title: '其他系统改动',
    description: '暂时无法从标题、摘要和文件路径稳定判断的 L1 事件。',
    order: 100,
    signals: [],
  };
}

function mergeUniqueL1Items(items) {
  const map = new Map();
  for (const item of items || []) {
    const key = item.commit_sha ? `sha:${item.commit_sha}` : `event:${item.summary || item.id}:${item.created_at || ''}`;
    if (!map.has(key)) {
      map.set(key, {
        ...item,
        project_ids: item.project_id ? [item.project_id] : [],
        source_ids: [item.id].filter(Boolean),
        files_changed: [...(item.files_changed || [])],
      });
      continue;
    }
    const existing = map.get(key);
    if (item.project_id && !existing.project_ids.includes(item.project_id)) existing.project_ids.push(item.project_id);
    if (item.id && !existing.source_ids.includes(item.id)) existing.source_ids.push(item.id);
    existing.files_changed = [...new Set([...(existing.files_changed || []), ...(item.files_changed || [])])];
    if (!existing.diff_summary && item.diff_summary) existing.diff_summary = item.diff_summary;
    if (!existing.actor && item.actor) existing.actor = item.actor;
  }
  return [...map.values()];
}

function buildL1EvolutionTree(items) {
  const groups = new Map();
  for (const item of items) {
    const category = classifyL1Event(item);
    if (!groups.has(category.id)) {
      groups.set(category.id, {
        ...category,
        items: [],
        projects: new Set(),
      });
    }
    const group = groups.get(category.id);
    group.items.push(item);
    for (const project of item.project_ids || [item.project_id]) {
      if (project) group.projects.add(project);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      projects: [...group.projects],
      latest: group.items.reduce((latest, item) => Math.max(latest, new Date(item.created_at || 0).getTime() || 0), 0),
    }))
    .sort((a, b) => a.order - b.order || b.items.length - a.items.length || b.latest - a.latest || a.title.localeCompare(b.title, 'zh-CN'));
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
  const normalized = {
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
    read_at: item.read_at || null,
  };
  if (id && typeof item.read_at !== 'undefined') {
    const local = paperLocal(id);
    local.read = !!item.read_at;
  }
  return normalized;
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
  const scanTime = String(state.constants.daily_scan_time || '17:00');
  const [hourRaw, minuteRaw] = scanTime.split(':');
  const hour = Number.isFinite(Number(hourRaw)) ? Number(hourRaw) : 17;
  const minute = Number.isFinite(Number(minuteRaw)) ? Number(minuteRaw) : 0;
  const next = new Date();
  next.setUTCHours(hour, minute, 0, 0);
  if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

function dailyScanLabel() {
  const time = state.constants.daily_scan_time || '17:00';
  const timezone = state.constants.daily_scan_timezone || 'UTC';
  return `${timezone} ${time}`;
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
    applyDecisionPayload(data);
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
  renderImplementation();
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
  const scanLabel = dailyScanLabel();
  const statusText = scanning ? '扫描中' : '等待下一次定时扫描';
  const statusHtml = `
    <div class="schedule-card">
      <strong>${statusText}</strong>
      <span>定时扫描: 每天 ${escapeHtml(scanLabel)}</span>
      <span>上次论文扫描: ${escapeHtml(formatTime(lastArxiv?.created_at))}</span>
      <span>上次产品扫描: ${escapeHtml(formatTime(lastProduct?.created_at))}</span>
      <em>下次扫描时间: ${escapeHtml(formatTime(next))}</em>
    </div>
  `;
  $('scheduleStatus').innerHTML = statusHtml;
  $('paperScheduleMini').innerHTML = `
    <div>定时: 每天 ${escapeHtml(scanLabel)}</div>
    <div>上次: ${escapeHtml(formatTime(lastArxiv?.created_at))}</div>
    <div>下次: ${escapeHtml(formatTime(next))}</div>
  `;
  $('paperScanPill').textContent = state.scanning.paper ? '扫描中' : '空闲';
  $('productScheduleMini').innerHTML = `
    <div>定时: 每天 ${escapeHtml(scanLabel)}</div>
    <div>上次: ${escapeHtml(formatTime(lastProduct?.created_at))}</div>
    <div>下次: ${escapeHtml(formatTime(next))}</div>
  `;
  $('productScanPill').textContent = state.scanning.product ? '扫描中' : '空闲';
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
    if (isExcludedItem(item) && !state.showExcluded.paper) return false;
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

function renderInspirationBlock(rawInspiration, markExcluded, options = {}) {
  const kindLabel = options.kind === 'product' ? '产品' : '论文';
  if (markExcluded) {
    return `
      <div class="inspiration-block insight-panel is-excluded">
        <div class="insight-head">
          <span class="priority-tag muted">AI 已排除</span>
          <strong>暂不进入借鉴队列</strong>
        </div>
        <p>该${kindLabel}经 L2 Agent 阅读后判定对莫比乌斯暂无明确借鉴价值，可在详情中重新标记。</p>
      </div>
    `;
  }
  const items = parseInspiration(rawInspiration);
  if (!items.length) {
    return `
      <div class="inspiration-block insight-panel is-pending">
        <div class="insight-head">
          <span class="priority-tag pending">待阅读</span>
          <strong>还没有 AI 借鉴方向</strong>
        </div>
        <p>可批量运行 AI 深度阅读，或打开详情直接向 Agent 追问。</p>
      </div>
    `;
  }
  const counts = inspirationBadgeCount(items);
  const head = [
    counts.high ? `<span class="priority-tag high">高 ${counts.high}</span>` : '',
    counts.med ? `<span class="priority-tag medium">中 ${counts.med}</span>` : '',
    counts.low ? `<span class="priority-tag low">低 ${counts.low}</span>` : '',
  ].filter(Boolean).join('');
  const shown = options.preview === false ? items : items.slice(0, options.limit || 2);
  const rest = items.length - shown.length;
  const list = shown.map((it) => `
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
    <details class="inspiration-block insight-panel is-loaded" open>
      <summary class="inspiration-head insight-head">
        <span class="insight-title">借鉴方向 <span class="insight-count">${items.length}</span></span>
        <span class="insight-priorities">${head || '<span class="priority-tag pending">已读</span>'}</span>
      </summary>
      <ul class="inspiration-list">${list}</ul>
      ${rest > 0 ? `<div class="insight-more">还有 ${rest} 条，打开详情查看完整内容</div>` : ''}
    </details>
  `;
}

function renderPaperCard(item, options = {}) {
  const local = paperLocal(item.id);
  const tags = [...(item.matched_keywords || []), ...(item.tags || []).slice(0, 3)];
  const score = item.priority_score ?? item.relevance ?? 0;
  const isExcluded = isExcludedItem(item);
  const insp = parseInspiration(item.ai_inspiration);
  const hasInsp = insp.length > 0;
  const isRead = !!local.read;
  return `
    <article class="paper-card research-card ${options.compact ? 'is-compact' : ''} ${isExcluded ? 'is-excluded' : ''} ${hasInsp ? 'has-inspiration' : ''} ${isRead ? 'is-read' : 'is-unread'}" data-archived="${local.archived ? 'true' : 'false'}">
      <div class="research-card-main">
        ${renderScoreRail({ label: 'Priority', score, sublabel: `rel ${compactNumber(item.relevance ?? score)}`, tone: 'paper' })}
        <div class="research-card-body">
          <div class="research-card-top">
            ${renderStateChips('paper', item, local)}
            <span class="source-mini">${escapeHtml(item.source_id || 'arXiv')}</span>
          </div>
          <h3 class="${options.gradient ? 'gradient-text' : ''}">${escapeHtml(item.title)}</h3>
          ${renderFactGrid(paperFacts(item), 'compact-facts')}
          ${hasInsp ? renderInspirationBlock(item.ai_inspiration, false, { kind: 'paper' }) : (isExcluded ? renderInspirationBlock(null, true, { kind: 'paper' }) : renderInspirationBlock(null, false, { kind: 'paper' }))}
          <p class="research-summary">${escapeHtml(shortText(item.abstract, options.compact ? 150 : 280))}</p>
          <div class="tag-row">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
          <div class="paper-bottom-row">
            <div class="card-actions">
              <button type="button" data-paper-detail="${escapeHtml(item.id)}">详情</button>
              <button type="button" data-paper-read="${escapeHtml(item.id)}">${isRead ? '设为未读' : '标记已读'}</button>
              <button type="button" data-paper-favorite="${escapeHtml(item.id)}">${local.favorite ? '取消收藏' : '收藏'}</button>
              <button type="button" data-paper-archive="${escapeHtml(item.id)}">${local.archived ? '取消归档' : '归档'}</button>
              ${sourceUrlFor('paper', item) ? `<a href="${escapeHtml(sourceUrlFor('paper', item))}" target="_blank" rel="noopener noreferrer">AlphaXiv</a>` : ''}
            </div>
            ${feedbackButtons(item)}
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderTopPicks() {
  const picks = state.topPicks || [];
  if (!$('topPicksList')) return;
  $('topPicksList').innerHTML = picks.length
    ? picks.map((item, index) => `
      <article class="top-pick-card">
        <div class="top-rank">${String(index + 1).padStart(2, '0')}</div>
        <div class="top-pick-main">
          ${renderStateChips('paper', item, paperLocal(item.id))}
          <h3 class="gradient-text">${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(shortText(item.abstract, 150))}</p>
          ${renderFactGrid([
            { label: 'Priority', value: compactNumber(item.priority_score ?? item.relevance ?? 0) },
            { label: 'Cluster', value: item.cluster_label || '未聚类' },
            { label: '发布时间', value: item.published_at || '日期未知' },
          ], 'compact-facts')}
          <div class="tag-row">${[...(item.matched_keywords || []), ...(item.tags || []).slice(0, 2)].map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
        </div>
        <div class="top-pick-actions">
          <button type="button" class="see-all-button" data-paper-detail="${escapeHtml(item.id)}">详情</button>
          <button type="button" class="see-all-button" data-open-cluster="${escapeHtml(item.cluster_label || '')}">Cluster</button>
        </div>
      </article>
    `).join('')
    : '<div class="quiet-empty">暂无 Top Picks，等待 cluster 数据</div>';
}

function paperQueueItems() {
  const q = state.filters.paper.q.toLowerCase();
  return allPaperDiscoveries().filter((item) => {
    const local = paperLocal(item.id);
    const review = reviewStatus('paper', item);
    if (review === 'resolved') return false;
    if (review === 'excluded' && !state.showExcluded.paper) return false;
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
  }).sort((a, b) => {
    const reviewDelta = (reviewStatus('paper', a) === 'excluded' ? 1 : 0) - (reviewStatus('paper', b) === 'excluded' ? 1 : 0);
    if (reviewDelta) return reviewDelta;
    return (b.priority_score ?? b.relevance ?? 0) - (a.priority_score ?? a.relevance ?? 0);
  });
}

function productQueueItems() {
  const q = state.filters.competitor.q.toLowerCase();
  return allCompetitors().filter((item) => {
    const local = competitorLocal(item.id);
    const review = reviewStatus('product', item);
    if (review === 'resolved') return false;
    if (review === 'excluded' && !state.showExcluded.competitor) return false;
    if (state.filters.competitor.status && item.status !== state.filters.competitor.status) return false;
    if (state.filters.competitor.read === 'read' && !local.read) return false;
    if (state.filters.competitor.read === 'unread' && local.read) return false;
    if (q) {
      const haystack = `${item.name} ${item.reason} ${item.fetched_title} ${item.fetched_description}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    const reviewDelta = (reviewStatus('product', a) === 'excluded' ? 1 : 0) - (reviewStatus('product', b) === 'excluded' ? 1 : 0);
    if (reviewDelta) return reviewDelta;
    const trackedDelta = (a.status === 'official' ? 0 : 1) - (b.status === 'official' ? 0 : 1);
    if (trackedDelta) return trackedDelta;
    return (b.relevance ?? 0) - (a.relevance ?? 0);
  });
}

function renderDecisionQueueItem(kind, item, active) {
  const title = kind === 'product' ? item.name : item.title;
  const score = kind === 'product' ? `${compactNumber(item.relevance ?? 0)} / 10` : compactNumber(item.priority_score ?? item.relevance ?? 0);
  const type = kind === 'product'
    ? `Product / ${labels.status[item.status] || item.status || '候选'}`
    : `Paper / ${aiReadState(item).label}`;
  const inspirations = parseInspiration(item.ai_inspiration);
  const review = reviewStatus(kind, item);
  return `
    <article class="decision-queue-item ${active ? 'is-active' : ''} ${review === 'excluded' ? 'is-excluded' : ''}" data-select-source="${escapeHtml(kind)}" data-source-id="${escapeHtml(item.id)}">
      <div class="decision-queue-top">
        <span class="type">${escapeHtml(type)}</span>
        <strong>${escapeHtml(score)}</strong>
      </div>
      <h4>${escapeHtml(shortText(title, 96))}</h4>
      <div class="decision-queue-tags">
        ${renderChip(reviewStatusLabel(review), review === 'excluded' ? 'excluded' : 'pending')}
        ${renderChip(inspirations.length ? `${inspirations.length} 条启发` : '待启发', inspirations.length ? 'ready' : 'pending')}
        ${kind === 'paper' ? renderChip(item.cluster_label || '未聚类', 'source') : renderChip(labels.category[item.category] || item.category || '产品', 'source')}
      </div>
    </article>
  `;
}

function selectedSource(kind, items) {
  const selectedId = state.selected[kind];
  let item = items.find((entry) => entry.id === selectedId);
  if (!item) {
    item = items[0] || null;
    state.selected[kind] = item?.id || '';
  }
  return item;
}

function selectedInspiration(kind, item) {
  const inspirations = sortedInspirations(item?.ai_inspiration);
  const selected = state.selected.inspiration[kind];
  let index = inspirations.findIndex((insp, i) => inspirationKey(kind, item.id, i, insp) === selected);
  if (index < 0) index = inspirations.length ? 0 : -1;
  if (index >= 0) state.selected.inspiration[kind] = inspirationKey(kind, item.id, index, inspirations[index]);
  return { inspirations, index, item: index >= 0 ? inspirations[index] : null };
}

function renderDecisionDetail(kind, item) {
  if (!item) {
    return '<div class="decision-empty">暂无待处理内容</div>';
  }
  const title = kind === 'product' ? item.name : item.title;
  const summary = kind === 'product'
    ? (item.fetched_description || item.reason || '暂无产品快照')
    : (item.abstract || '暂无论文摘要');
  const facts = kind === 'product' ? productFacts(item) : paperFacts(item);
  const { inspirations, index: activeIndex } = selectedInspiration(kind, item);
  const review = reviewStatus(kind, item);
  return `
    <article class="decision-detail">
      <header class="decision-detail-hero">
        <div>
          <p class="eyebrow">${kind === 'product' ? 'Product Research' : 'Paper Research'} · ${escapeHtml(reviewStatusLabel(review))}</p>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(shortText(summary, 360))}</p>
        </div>
        <aside class="decision-score-card">
          <strong>${escapeHtml(kind === 'product' ? compactNumber(item.relevance ?? 0) : compactNumber(item.priority_score ?? item.relevance ?? 0))}</strong>
          <span>${kind === 'product' ? '相关性' : '优先级'}</span>
        </aside>
      </header>
      ${renderSourceLink(kind, item, 'decision-source-link')}
      ${renderFactGrid(facts, 'decision-facts')}
      <section class="decision-inspiration-section">
        <div class="detail-section-head">
          <div>
            <h3>启发点</h3>
            <p class="detail-section-subtitle">先选择一条启发，再在右侧接受或拒绝。</p>
          </div>
          <span>${inspirations.length || 0} 条</span>
        </div>
        <div class="decision-inspiration-list">
          ${inspirations.length ? inspirations.map((insp, i) => {
            const key = inspirationKey(kind, item.id, i, insp);
            const decision = inspirationDecision(kind, item.id, i, insp);
            return `
              <article class="decision-inspiration-card ${i === activeIndex ? 'is-active' : ''}" data-select-inspiration="${escapeHtml(kind)}" data-source-id="${escapeHtml(item.id)}" data-inspiration-index="${i}" data-inspiration-key="${escapeHtml(key)}">
                <div class="inspiration-item-head">
                  <span class="priority-tag ${escapeHtml(insp.priority)}">${escapeHtml(priorityText(insp.priority))}</span>
                  <strong>${escapeHtml(insp.title || insp.direction || '未命名启发')}</strong>
                </div>
                ${insp.direction ? `<p>${escapeHtml(insp.direction)}</p>` : ''}
                ${insp.mobius_use ? `<p class="muted">落实：${escapeHtml(shortText(insp.mobius_use, 180))}</p>` : ''}
                <span class="decision-state">${escapeHtml(decisionStatusLabel(decision?.status))}</span>
              </article>
            `;
          }).join('') : '<div class="quiet-empty">还没有启发点。请先点击下方 AI 深度分析，让 Agent 读取上下文后生成可处理结论。</div>'}
        </div>
      </section>
      ${renderDetailChatSection(kind, item.id, item)}
    </article>
  `;
}

function renderDecisionActions(kind, item) {
  if (!item) return '<div class="decision-empty">请选择左侧条目</div>';
  const { inspirations, index, item: insp } = selectedInspiration(kind, item);
  const decision = insp ? inspirationDecision(kind, item.id, index, insp) : null;
  const review = reviewStatus(kind, item);
  const sourceLabel = kind === 'product' ? '这个产品' : '这篇论文';
  return `
    <section class="human-decision-panel">
      <div class="decision-panel-head">
        <div>
          <p class="micro">Human Gate</p>
          <h3>人类决策</h3>
        </div>
        <span>${escapeHtml(reviewStatusLabel(review))}</span>
      </div>
      <div class="decision-action-group">
        <p class="section-title">绑定${kind === 'product' ? '产品' : '论文'}</p>
        <button type="button" class="btn primary" data-source-review="${escapeHtml(kind)}" data-source-id="${escapeHtml(item.id)}" data-status="resolved">解决，进入${kind === 'product' ? '产品' : '论文'}收藏中心</button>
        <button type="button" class="btn" data-source-review="${escapeHtml(kind)}" data-source-id="${escapeHtml(item.id)}" data-status="deferred">搁置，等待更多证据</button>
        <button type="button" class="btn red" data-source-review="${escapeHtml(kind)}" data-source-id="${escapeHtml(item.id)}" data-status="excluded">排除，不进入自进化</button>
      </div>
      <div class="decision-action-group">
        <p class="section-title">绑定启发点</p>
        ${insp ? `
          <div class="selected-inspiration-mini">
            <strong>${escapeHtml(insp.title || insp.direction || '未命名启发')}</strong>
            <span>${escapeHtml(decisionStatusLabel(decision?.status))}</span>
          </div>
          <button type="button" class="btn green" data-inspiration-decision="${escapeHtml(kind)}" data-source-id="${escapeHtml(item.id)}" data-inspiration-index="${index}" data-inspiration-key="${escapeHtml(inspirationKey(kind, item.id, index, insp))}" data-status="accepted">接受为 L2 启发</button>
          <button type="button" class="btn red" data-inspiration-decision="${escapeHtml(kind)}" data-source-id="${escapeHtml(item.id)}" data-inspiration-index="${index}" data-inspiration-key="${escapeHtml(inspirationKey(kind, item.id, index, insp))}" data-status="rejected">拒绝此启发点</button>
        ` : `
          <div class="quiet-empty">${sourceLabel}还没有启发点。和 Agent 交流后，新增启发会自动刷新到中间列表。</div>
        `}
      </div>
      <div class="audit">
        <div class="audit-row"><span>资料状态</span><strong>${escapeHtml(reviewStatusLabel(review))}</strong></div>
        <div class="audit-row"><span>启发数量</span><strong>${inspirations.length}</strong></div>
        <div class="audit-row"><span>AI 状态</span><strong>${escapeHtml(aiReadState(item).label)}</strong></div>
        <div class="audit-row"><span>外部链接</span><strong>${sourceUrlFor(kind, item) ? '可打开' : '无'}</strong></div>
      </div>
    </section>
  `;
}

function renderPapers() {
  // 后端 read_at 是已读状态的唯一真相源, 每次渲染前同步 local.read。
  for (const item of Object.values(state.clusterPapers).flat()) {
    if (item?.id && typeof item.read_at !== 'undefined') {
      paperLocal(item.id).read = !!item.read_at;
    }
  }
  for (const item of (state.papers.items || [])) {
    if (item?.id && typeof item.read_at !== 'undefined') {
      paperLocal(item.id).read = !!item.read_at;
    }
  }
  const items = paperQueueItems();
  const selected = selectedSource('paper', items);
  $('paperDecisionCount').textContent = items.length;
  $('paperDecisionQueue').innerHTML = items.length
    ? items.map((paper) => renderDecisionQueueItem('paper', paper, selected?.id === paper.id)).join('')
    : '<div class="quiet-empty">暂无待处理论文</div>';
  $('paperDecisionDetail').innerHTML = renderDecisionDetail('paper', selected);
  $('paperDecisionActions').innerHTML = renderDecisionActions('paper', selected);
  requestAnimationFrame(() => selected && refreshDetailChat('paper', selected.id));
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
    if (isExcludedItem(item) && !state.showExcluded.competitor) return false;
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
  const isExcluded = isExcludedItem(item);
  const insp = parseInspiration(item.ai_inspiration);
  const hasInsp = insp.length > 0;
  const isRead = !!local.read;
  return `
    <article class="product-card research-card ${isExcluded ? 'is-excluded' : ''} ${hasInsp ? 'has-inspiration' : ''} ${isRead ? 'is-read' : 'is-unread'}">
      <div class="research-card-main">
        ${renderScoreRail({ label: 'Fit', score: item.relevance ?? 0, sublabel: '/10', tone: 'product' })}
        <div class="research-card-body">
          <div class="research-card-top">
            ${renderStateChips('product', item, local)}
            <span class="source-mini">${escapeHtml(sourceHost(item.source_url))}</span>
          </div>
          <h3>${escapeHtml(item.name)}</h3>
          ${renderFactGrid(productFacts(item), 'compact-facts')}
          ${hasInsp ? renderInspirationBlock(item.ai_inspiration, false, { kind: 'product' }) : (isExcluded ? renderInspirationBlock(null, true, { kind: 'product' }) : renderInspirationBlock(null, false, { kind: 'product' }))}
          <p class="research-summary">${escapeHtml(shortText(snapshot, 240))}</p>
          ${item.reason ? `<p class="reason-line"><strong>入库理由</strong>${escapeHtml(shortText(item.reason, 160))}</p>` : ''}
          <div class="tag-row">${(item.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
          <div class="card-actions">
            ${item.status === 'candidate' ? `<button type="button" data-promote="${escapeHtml(item.id)}">晋升正式</button>` : ''}
            <button type="button" data-product-detail="${escapeHtml(item.id)}">详情 / 追问</button>
            <button type="button" data-product-read="${escapeHtml(item.id)}">${isRead ? '设为未读' : '标记已读'}</button>
            ${item.source_url ? `<a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">打开页面</a>` : ''}
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderCompetitors() {
  // 后端 read_at 是已读状态的唯一真相源, 每次渲染前同步 local.read。
  for (const item of allCompetitors()) {
    if (item?.id && typeof item.read_at !== 'undefined') {
      competitorLocal(item.id).read = !!item.read_at;
    }
  }
  const items = productQueueItems();
  const selected = selectedSource('product', items);
  const readCount = allCompetitors().filter((item) => competitorLocal(item.id).read).length;

  $('competitorMetrics').innerHTML = [
    ['已跟踪', state.competitors.official?.length || 0],
    ['候选', state.competitors.candidate?.length || 0],
    ['已读', readCount],
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');

  $('productDecisionCount').textContent = items.length;
  $('productDecisionQueue').innerHTML = items.length
    ? items.map((product) => renderDecisionQueueItem('product', product, selected?.id === product.id)).join('')
    : '<div class="quiet-empty">暂无待处理产品</div>';
  $('productDecisionDetail').innerHTML = renderDecisionDetail('product', selected);
  $('productDecisionActions').innerHTML = renderDecisionActions('product', selected);
  requestAnimationFrame(() => selected && refreshDetailChat('product', selected.id));
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
  const rawItems = evolutionItems('L1');
  const items = mergeUniqueL1Items(rawItems);
  const groups = buildL1EvolutionTree(items);
  const mergeText = rawItems.length > items.length ? ` · 合并 ${rawItems.length - items.length} 条重复扫描` : '';
  $('evolutionContent').innerHTML = items.length
    ? `
      <div class="l1-tree">
        <div class="l1-tree-summary">
          <div>
            <p class="micro">AI grouped tree</p>
            <h3>L1 真实改动分类树</h3>
          </div>
          <span>${escapeHtml(groups.length)} 类 · ${escapeHtml(items.length)} 条 L1${mergeText}</span>
        </div>
        ${groups.map((group, index) => renderL1TreeGroup(group, index)).join('')}
      </div>
    `
    : '<div class="quiet-empty">暂无 L1 实际修改</div>';
}

function renderL1TreeGroup(group, index = 0) {
  const key = `l1-group:${group.id}`;
  const expanded = typeof state.evolution.expanded[key] === 'boolean'
    ? state.evolution.expanded[key]
    : index === 0;
  const projects = group.projects.length ? group.projects.join(' / ') : '未绑定项目';
  return `
    <section class="l1-tree-group" data-expanded="${expanded ? 'true' : 'false'}">
      <button type="button" class="l1-tree-head" data-toggle-evolution-group="${escapeHtml(key)}">
        <span class="l1-tree-node" aria-hidden="true"></span>
        <span class="l1-tree-title">
          <strong>${escapeHtml(group.title)}</strong>
          <em>${escapeHtml(group.description)}</em>
        </span>
        <span class="l1-tree-meta">${escapeHtml(group.items.length)} 条 · ${escapeHtml(projects)}</span>
        <span class="evo-toggle-icon" aria-hidden="true">⌄</span>
      </button>
      <div class="l1-tree-children">
        <div class="evolution-list">${group.items.map((item) => renderL1Card(item)).join('')}</div>
      </div>
    </section>
  `;
}

function renderL1Card(item) {
  const expanded = !!state.evolution.expanded[item.id];
  const sha = item.commit_sha ? item.commit_sha.slice(0, 7) : 'pending';
  const brief = item.brief || {};
  const who = brief.who || item.actor || 'Mobius';
  const modules = Array.isArray(brief.modules) ? brief.modules : [];
  const category = classifyL1Event(item);
  const projectLabel = (item.project_ids?.length ? item.project_ids.join(' / ') : item.project_id) || '未绑定项目';
  const metaHtml = [escapeHtml(who), escapeHtml(formatTime(item.created_at)), escapeHtml(projectLabel)].join(' · ')
    + (modules.length ? ' · ' + modules.map((m) => `<span class="evo-module">${escapeHtml(m)}</span>`).join(' ') : '');
  return `
    <article class="evo-card l1-card" data-expanded="${expanded ? 'true' : 'false'}">
      <button type="button" class="evo-card-head" data-toggle-evolution="${escapeHtml(item.id)}">
        <span class="evo-sha">${escapeHtml(sha)}</span>
        <span class="evo-brief">
          <strong class="evo-what">${escapeHtml(brief.what || item.summary)}</strong>
          <em class="evo-why">${escapeHtml(shortText(brief.why || item.diff_summary || category.title, 140))}</em>
        </span>
        <span class="evo-toggle-icon" aria-hidden="true">⌄</span>
      </button>
      <div class="evo-meta">${metaHtml}</div>
      <div class="evo-expand">
        <div class="evo-detail-label">完整提交标题</div>
        <p class="evo-raw">${escapeHtml(item.summary)}</p>
        ${item.diff_summary ? `<div class="evo-detail-label">改动摘要</div><p>${escapeHtml(item.diff_summary)}</p>` : ''}
        <div class="evo-detail-label">改动文件 (${(item.files_changed || []).length})</div>
        <div class="tag-row">${(item.files_changed || []).map((file) => `<span>${escapeHtml(file)}</span>`).join('')}</div>
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
      applyDecisionPayload(fresh);
      await loadPaperClusters();
    } else {
      const fresh = await call({ action: 'bootstrap', skip_first_scan: true, limit: 200 });
      state.products = fresh.products || state.products;
      state.competitors = fresh.competitors || state.competitors;
      state.summary = fresh.summary || state.summary;
      applyDecisionPayload(fresh);
    }
    render();
    if (result.async) {
      renderLatestBatch(kind === 'paper' ? 'paper' : 'product', items, `后台 AI 阅读已启动 ${result.scanned || 0} 条`);
      showToast(result.session_url ? `AI 阅读已启动，后台 Agent 处理中` : (result.summary || 'AI 阅读已启动'));
    } else {
      renderLatestBatch(kind === 'paper' ? 'paper' : 'product', items, `本轮 AI 阅读 ${result.scanned} 条 · ${items.length} 条有启发`);
      showToast(`AI 阅读完成: ${result.summary || ''}`);
    }
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
      if (result.async) {
        renderLatestBatch('product', items, `后台产品发现已启动`);
        showToast('产品发现 Agent 已启动，后台处理中');
      } else {
        renderLatestBatch('product', items, `本轮 Agent 发现 ${items.length} 条 · 新候选 +${result.discovery?.candidates_added || 0}`);
        showToast(`Agent 智能发现 ${items.length} 条新候选 (model: ${result.discovery?.model || '?'})`);
      }
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

async function refreshDecisionState() {
  try {
    const [reviews, inspirations] = await Promise.all([
      call({ action: 'list_source_reviews' }),
      call({ action: 'list_l2_inspirations', status: 'accepted,queued_one_click,queued_plan,deferred' }),
    ]);
    state.sourceReviews = normalizeSourceReviews(reviews.source_reviews || []);
    state.implementationItems = inspirations.items || [];
    state.inspirationDecisions = normalizeInspirationDecisions(state.implementationItems);
  } catch (error) {
    showToast(error.message || '刷新决策状态失败', 'bad');
  }
}

async function setSourceReview(kind, id, status) {
  const label = status === 'resolved' ? '解决' : status === 'excluded' ? '排除' : '搁置';
  if (status === 'excluded') {
    const ok = await confirmDialog({
      title: `确认排除${kind === 'product' ? '产品' : '论文'}？`,
      body: '排除后不会进入自进化待处理队列；可通过“显示 AI 排除”重新查看。',
      confirmText: '确认排除',
    });
    if (!ok) return;
  }
  try {
    const result = await call({ action: 'set_source_review', kind, source_id: id, status });
    state.sourceReviews = normalizeSourceReviews(result.source_reviews || []);
    if (kind === 'paper' && result.arxiv) state.papers = result.arxiv;
    if (kind === 'product' && result.competitors) state.competitors = result.competitors;
    showToast(`${label}状态已保存`);
    if (kind === 'paper') renderPapers();
    else renderCompetitors();
    updateRadarDiscoveries();
  } catch (error) {
    showToast(error.message || '资料裁决失败', 'bad');
  }
}

async function decideInspiration(kind, sourceId, index, inspirationKeyValue, status) {
  try {
    const result = await call({
      action: 'decide_inspiration',
      kind,
      source_id: sourceId,
      index: Number(index),
      inspiration_key: inspirationKeyValue,
      status,
    });
    state.implementationItems = result.inspiration_decisions || state.implementationItems;
    state.inspirationDecisions = normalizeInspirationDecisions(state.implementationItems);
    showToast(status === 'accepted' ? '已接受为 L2 启发' : '已拒绝此启发点');
    renderPapers();
    renderCompetitors();
    renderImplementation();
  } catch (error) {
    showToast(error.message || '启发点裁决失败', 'bad');
  }
}

async function loadImplementationQueue() {
  try {
    const result = await call({ action: 'list_l2_inspirations', status: 'accepted,queued_one_click,queued_plan,deferred' });
    state.implementationItems = result.items || [];
    state.inspirationDecisions = normalizeInspirationDecisions(state.implementationItems);
    renderImplementation();
  } catch (error) {
    showToast(error.message || '落实队列加载失败', 'bad');
  }
}

function filteredImplementationItems() {
  const filter = state.implementationFilter;
  const items = state.implementationItems || [];
  if (!filter) return items;
  if (filter === 'queued') return items.filter((item) => item.status === 'queued_one_click' || item.status === 'queued_plan');
  return items.filter((item) => item.status === filter);
}

function renderImplementation() {
  const root = $('implementationList');
  if (!root) return;
  const items = filteredImplementationItems();
  root.innerHTML = items.length ? items.map((item) => `
    <article class="implementation-card" data-status="${escapeHtml(item.status)}">
      <div class="implementation-main">
        <div class="implementation-card-head">
          <span class="priority-tag ${escapeHtml(item.priority || 'medium')}">${escapeHtml(priorityText(item.priority || 'medium'))}</span>
          <span class="status-pill">${escapeHtml(decisionStatusLabel(item.status))}</span>
        </div>
        <h3>${escapeHtml(item.title || '未命名启发')}</h3>
        <p>${escapeHtml(shortText(item.direction || item.mobius_use, 220))}</p>
        <div class="implementation-meta">
          <span>${escapeHtml(item.source_kind === 'product' ? '产品' : '论文')}</span>
          <span>${escapeHtml(shortText(item.source_title, 54))}</span>
          ${item.source_cluster ? `<span>${escapeHtml(item.source_cluster)}</span>` : ''}
        </div>
        ${item.implementation_url ? `<a class="implementation-session-link" href="${escapeHtml(item.implementation_url)}" target="_blank" rel="noopener noreferrer">打开小莫落实 Session</a>` : ''}
      </div>
      <div class="implementation-actions">
        <button type="button" class="btn primary" data-implement-l2="${escapeHtml(item.id)}" data-mode="one_click">一键落实</button>
        <button type="button" class="btn green" data-implement-l2="${escapeHtml(item.id)}" data-mode="plan">修改后落实</button>
        <button type="button" class="btn" data-update-l2-status="${escapeHtml(item.id)}" data-status="deferred">搁置</button>
        <button type="button" class="btn red" data-update-l2-status="${escapeHtml(item.id)}" data-status="deleted">删除</button>
      </div>
    </article>
  `).join('') : '<div class="quiet-empty">暂无已接受的 L2 启发。先在论文/产品三栏工作台右侧接受一条启发。</div>';
}

async function implementL2Inspiration(id, mode) {
  const actionText = mode === 'plan' ? '修改后落实' : '一键落实';
  const ok = await confirmDialog({
    title: `${actionText}这条启发？`,
    body: mode === 'plan'
      ? '将创建小莫落实 Session，并要求小莫先进入 plan 模式与人交流。'
      : '将创建小莫落实 Session，并把完整上下文直接交给后台小莫执行。',
    confirmText: actionText,
  });
  if (!ok) return;
  try {
    const result = await call({ action: 'implement_l2_inspiration', id, mode });
    state.implementationItems = result.items || state.implementationItems;
    state.inspirationDecisions = normalizeInspirationDecisions(state.implementationItems);
    renderImplementation();
    renderPapers();
    renderCompetitors();
    showToast(result.backend_start?.ok ? '已交给后台小莫' : '落实 Session 已创建');
    if (result.url) window.open(result.url, '_blank', 'noopener');
  } catch (error) {
    showToast(error.message || '落实失败', 'bad');
  }
}

async function updateL2Status(id, status) {
  if (status === 'deleted') {
    const ok = await confirmDialog({
      title: '删除这条 L2 启发？',
      body: '删除只会从落实队列移除，不会删除原论文/产品里的 AI 启发文本。',
      confirmText: '确认删除',
    });
    if (!ok) return;
  }
  try {
    const result = await call({ action: 'update_l2_inspiration_status', id, status });
    state.implementationItems = result.items || state.implementationItems;
    state.inspirationDecisions = normalizeInspirationDecisions(state.implementationItems);
    renderImplementation();
    renderPapers();
    renderCompetitors();
    showToast(status === 'deleted' ? '启发已从队列删除' : '启发已搁置');
  } catch (error) {
    showToast(error.message || '更新落实状态失败', 'bad');
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
    const active = panel.id === `panel-${tab}`;
    panel.classList.toggle('is-active', active);
    if (active) panel.classList.add('is-visible');
  });
  if (shouldScroll && tab === 'papers') $('paper-section').scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (shouldScroll && tab === 'competitors') $('competitor-section').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function openScanTools(kind = 'paper') {
  const dialog = $('scanToolsDialog');
  if (!dialog) return;
  const isProduct = kind === 'product';
  $('scanToolsKicker').textContent = isProduct ? 'Product research tools' : 'Paper research tools';
  $('scanToolsTitle').textContent = isProduct ? '产品扫描与 AI 阅读' : '论文扫描与 AI 阅读';
  $('scanToolsDescription').textContent = isProduct
    ? '这里集中处理产品页扫描、已跟踪产品重扫、未读产品 AI 深度阅读和产品关键词。主页面继续保持为判断工作台。'
    : '这里集中处理 arXiv 手动扫描、未读论文 AI 深度阅读和论文关键词。主页面继续保持为判断工作台。';
  document.querySelectorAll('[data-scan-tools-kind]').forEach((pane) => {
    pane.hidden = pane.dataset.scanToolsKind !== kind;
  });
  if (!dialog.open) dialog.showModal();
}

function bindScanToolsDialog() {
  const dialog = $('scanToolsDialog');
  if (!dialog) return;
  document.querySelectorAll('[data-open-scan-tools]').forEach((button) => {
    button.addEventListener('click', () => openScanTools(button.dataset.openScanTools || 'paper'));
  });
  $('scanToolsClose')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

function detailChatKey(kind, id) {
  return `${kind}:${id}`;
}

function getDetailChat(kind, id) {
  const key = detailChatKey(kind, id);
  if (!detailChats.has(key)) {
    detailChats.set(key, {
      loading: false,
      messages: [],
    });
  }
  return detailChats.get(key);
}

function renderChatMessages(chat, emptyText = '') {
  const rows = chat.messages.map((message) => {
    const toneClass = message.tone === 'error' ? 'is-error' : (message.tone === 'warn' ? 'is-warn' : '');
    const pendingClass = message.pending ? ' is-loading' : '';
    const metaHtml = message.meta ? `<div class="detail-chat-meta">${escapeHtml(message.meta)}</div>` : '';
    const linkHtml = (message.sessionUrl && !message.pending)
      ? `<div class="detail-chat-link"><a href="${escapeHtml(message.sessionUrl)}" target="_blank" rel="noopener">查看完整 Session 回复 →</a></div>`
      : '';
    return `
    <div class="detail-chat-message ${message.role === 'user' ? 'is-user' : 'is-ai'} ${toneClass}${pendingClass}">
      <div class="detail-chat-bubble">${escapeHtml(message.content)}${metaHtml}${linkHtml}</div>
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
  if (!rows.length && emptyText) {
    rows.push(`<div class="detail-chat-placeholder">${escapeHtml(emptyText)}</div>`);
  }
  return rows.join('');
}

function renderDetailChatSection(kind, id, item = null) {
  const chat = getDetailChat(kind, id);
  const key = detailChatKey(kind, id);
  const sourceLabel = kind === 'product' ? '这个产品' : '这篇论文';
  const hasInspiration = sortedInspirations(item?.ai_inspiration).length > 0;
  const isExcluded = isExcludedItem(item);
  const shouldAnalyzeFirst = item && !hasInspiration && !isExcluded;
  if (shouldAnalyzeFirst) {
    const hasMessages = chat.messages.length > 0 || chat.loading;
    return `
      <section class="detail-chat detail-analysis-entry" aria-label="AI 深度分析">
        <div class="detail-section-head">
          <h3>让 AI 深度分析${sourceLabel}</h3>
          <span>${chat.loading ? '分析中' : '待深读'}</span>
        </div>
        <div class="detail-analysis-cta">
          <div>
            <strong>尚未生成启发点</strong>
            <p>先让 L2 Agent 阅读上下文、结合莫比乌斯代码现状判断可借鉴方向。分析完成后，这里会切换为追问入口。</p>
          </div>
          <button type="button" class="primary-button" data-detail-ai-analyze="${escapeHtml(kind)}" data-source-id="${escapeHtml(id)}" ${chat.loading ? 'disabled' : ''}>
            ${chat.loading ? 'AI 分析中...' : 'AI 深度分析'}
          </button>
        </div>
        ${hasMessages ? `<div class="detail-chat-messages" id="detailChatMessages" data-chat-messages="${escapeHtml(key)}" aria-live="polite">${renderChatMessages(chat)}</div>` : ''}
      </section>
    `;
  }
  return `
    <section class="detail-chat" aria-label="AI 聊天区">
      <div class="detail-section-head">
        <h3>向 AI 追问${sourceLabel}</h3>
        <span>${kind === 'product' ? 'Product context' : 'Paper context'}</span>
      </div>
      <div class="detail-chat-messages" id="detailChatMessages" data-chat-messages="${escapeHtml(key)}" aria-live="polite">
        ${renderChatMessages(chat, hasInspiration ? 'AI 深读已经生成启发点，可以继续追问定位、方法、实验、结论或可落地改造。' : '这条资料当前没有启发点。如果需要复核，可以先取消排除状态后重新分析。')}
      </div>
      <form class="detail-chat-form" data-chat-kind="${escapeHtml(kind)}" data-chat-id="${escapeHtml(id)}">
        <textarea id="detailChatInput" rows="3" maxlength="1200" placeholder="${kind === 'product' ? '输入你的问题，例如：这个产品最值得借鉴的交互是什么？' : '输入你的问题，例如：这篇论文的核心方法是什么？'}"></textarea>
        <button id="detailChatSubmit" data-chat-submit="${escapeHtml(key)}" class="primary-button" type="submit" ${chat.loading ? 'disabled' : ''}>${chat.loading ? '发送中' : '发送'}</button>
      </form>
    </section>
  `;
}

function refreshDetailChat(kind, id) {
  const chat = getDetailChat(kind, id);
  const key = detailChatKey(kind, id);
  document.querySelectorAll(`[data-chat-messages="${CSS.escape(key)}"]`).forEach((messages) => {
    messages.innerHTML = renderChatMessages(chat);
    messages.scrollTop = messages.scrollHeight;
  });
  document.querySelectorAll(`[data-chat-submit="${CSS.escape(key)}"]`).forEach((button) => {
    button.disabled = chat.loading;
    button.textContent = chat.loading ? '发送中' : '发送';
  });
  document.querySelectorAll(`[data-detail-ai-analyze="${CSS.escape(kind)}"][data-source-id="${CSS.escape(id)}"]`).forEach((button) => {
    button.disabled = chat.loading;
    button.textContent = chat.loading ? 'AI 分析中...' : 'AI 深度分析';
  });
}

// ===== Agent 异步回复轮询: 网页内"正在生成/完成摘要"反馈 =====
const AGENT_POLL_INTERVAL = 4000;
const AGENT_POLL_MAX = 45; // ~3 分钟上限, 避免无限轮询

function stopAgentPoll(chat) {
  if (!chat) return;
  if (chat.poll) chat.poll.cancelled = true;
  chat.poll = null;
}

// 把 chat_status 结果写回最近一条 pending assistant 消息; 返回 true 表示终态(应停止轮询).
async function applyAgentPollResult(kind, id, res, { isScan } = {}) {
  const chat = getDetailChat(kind, id);
  const msg = [...chat.messages].reverse().find((m) => m && m.role === 'assistant' && m.pending);
  if (!msg) return true;
  const sessionUrl = res && res.session_url ? res.session_url : msg.sessionUrl || '';
  const metaParts = [];
  if (msg.model) metaParts.push(msg.model);
  if (sessionUrl) metaParts.push(`Session: ${sessionUrl}`);
  const status = res && res.status ? res.status : 'generating';
  if (status === 'completed') {
    msg.pending = false;
    msg.content = (res.reply || '已完成。').trim();
    msg.sessionUrl = sessionUrl;
    msg.meta = metaParts.join(' · ');
    msg.tone = undefined;
    try { await refreshSourceItem(kind, id); } catch {}
    rerenderSourceViews(kind, id);
    showToast(isScan ? 'AI 深度分析完成' : 'Agent 回复已生成');
    return true;
  }
  if (status === 'done_no_summary') {
    msg.pending = false;
    msg.content = (res && res.reply ? res.reply : 'Agent 已完成，但未生成网页摘要。完整回复见对应 Session。').trim();
    msg.sessionUrl = sessionUrl;
    msg.meta = metaParts.join(' · ');
    msg.tone = 'warn';
    try { await refreshSourceItem(kind, id); } catch {}
    rerenderSourceViews(kind, id);
    return true;
  }
  if (status === 'error') {
    msg.pending = false;
    msg.content = (res && res.reply ? res.reply : 'Agent 处理失败，请稍后重试或在 Session 中查看。').trim();
    msg.sessionUrl = sessionUrl;
    msg.meta = metaParts.join(' · ');
    msg.tone = 'error';
    return true;
  }
  // generating: 保持 pending, 偶尔更新提示文案让用户感知仍在进行
  msg.content = attemptsToHint(chat.poll && chat.poll.attempts) || msg.content || '正在生成回复…';
  return false;
}

function attemptsToHint(n) {
  if (!n || n < 4) return '正在生成回复…';
  if (n < 10) return '仍在后台阅读资料并生成回复，请稍候…';
  return 'Agent 仍在工作（深度阅读较慢），完整回复也会出现在 Session 里…';
}

function markAgentPollTimeout(kind, id) {
  const chat = getDetailChat(kind, id);
  const msg = [...chat.messages].reverse().find((m) => m && m.role === 'assistant' && m.pending);
  if (msg) {
    msg.pending = false;
    msg.content = '等待回复超时。Agent 可能仍在后台运行，请稍后刷新或在对应 Session 中查看完整回复。';
    msg.tone = 'warn';
  }
}

// 启动轮询; 每次 chat 只保留一个活跃 poll, 新轮询会取消旧的.
function startAgentPoll(kind, id, { runId, scopeId, isScan = false }) {
  const chat = getDetailChat(kind, id);
  stopAgentPoll(chat);
  const token = { cancelled: false, attempts: 0 };
  chat.poll = token;
  const tick = async () => {
    if (token.cancelled || chat.poll !== token) return;
    token.attempts += 1;
    let res = null;
    try {
      res = await call({ action: 'chat_status', kind, scope_id: scopeId, run_id: runId });
    } catch (err) {
      res = { status: 'error', reply: `查询 Agent 状态失败: ${err.message || err}` };
    }
    if (token.cancelled || chat.poll !== token) return;
    let finished;
    try { finished = await applyAgentPollResult(kind, id, res, { isScan }); } catch { finished = true; }
    refreshDetailChat(kind, id);
    if (finished) { if (chat.poll === token) chat.poll = null; return; }
    if (token.attempts >= AGENT_POLL_MAX) {
      markAgentPollTimeout(kind, id);
      refreshDetailChat(kind, id);
      if (chat.poll === token) chat.poll = null;
      return;
    }
    setTimeout(tick, AGENT_POLL_INTERVAL);
  };
  setTimeout(tick, AGENT_POLL_INTERVAL);
  return token;
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

function renderDetailFocus(kind, item) {
  const items = sortedInspirations(item.ai_inspiration);
  const top = items[0];
  const score = kind === 'product' ? (item.relevance ?? 0) : (item.priority_score ?? item.relevance ?? 0);
  const scoreLabel = kind === 'product' ? `Fit ${compactNumber(score)}/10` : `Priority ${compactNumber(score)}`;
  const isExcluded = isExcludedItem(item);
  let title = '先补 AI 深度阅读';
  let body = kind === 'product'
    ? '当前产品还没有形成 AI 借鉴方向，只能看到页面快照和入库信息。'
    : '当前论文还没有形成 AI 借鉴方向，只能看到摘要、cluster 和关键词。';
  let next = '下一步：点击 AI 深度分析，让 Agent 阅读上下文并生成可处理的启发点。';
  let tone = 'pending';

  if (isExcluded) {
    title = '暂不建议投入';
    body = `L2 Agent 已判断这${kind === 'product' ? '个产品' : '篇论文'}暂无明确借鉴价值。`;
    next = '下一步：如果你认为判断偏保守，可以在右侧重新标记或向 Agent 追问复核。';
    tone = 'excluded';
  } else if (top) {
    title = top.title || top.direction || '已有可借鉴方向';
    body = top.direction ? shortText(top.direction, 180) : 'AI 已经完成深度阅读，并整理了可借鉴方向。';
    next = top.mobius_use ? `优先落地：${shortText(top.mobius_use, 96)}` : '下一步：打开下方借鉴方向，选择是否导出给小莫执行。';
    tone = top.priority;
  } else if (Number(score) >= (kind === 'product' ? 7 : 20)) {
    title = kind === 'product' ? '高匹配但待深读' : '高优先级但待深读';
    body = kind === 'product'
      ? '这个产品的匹配分较高，但还没有 AI 借鉴结论，需要先确认具体可学什么。'
      : '这篇论文的优先级较高，但还缺 L2 深读结论，需要先判断方法、系统设计或实验是否可迁移。';
  }

  const facts = kind === 'product'
    ? [
      { label: scoreLabel, value: labels.status[item.status] || item.status || '候选' },
      { label: '来源', value: item.auto_discovered ? 'Agent 自动发现' : '手动/种子入库' },
      { label: '最近扫描', value: formatTime(item.last_scanned_at || item.updated_at || item.created_at) },
    ]
    : [
      { label: scoreLabel, value: item.cluster_label || '未聚类' },
      { label: '发布时间', value: item.published_at || '日期未知' },
      { label: '关键词', value: topKeywords(item, 3).join(' / ') || '暂无关键词' },
    ];

  return `
    <section class="detail-focus-panel" data-tone="${escapeHtml(tone)}">
      <div class="detail-focus-copy">
        <span class="detail-kicker">重点判断</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(shortText(body, 190))}</p>
      </div>
      <div class="detail-next-step">${escapeHtml(next)}</div>
      <dl class="detail-mini-facts">
        ${facts.map((fact) => `
          <div>
            <dt>${escapeHtml(fact.label)}</dt>
            <dd>${escapeHtml(fact.value)}</dd>
          </div>
        `).join('')}
      </dl>
    </section>
  `;
}

function renderInspirationDetailBlock(rawInspiration, markExcluded, kind) {
  if (markExcluded) {
    return `<section class="detail-block detail-inspiration is-excluded">
      <div class="detail-section-head">
        <h3>AI 借鉴方向</h3>
        <span>已排除</span>
      </div>
      <div class="detail-empty-state">
        <strong>不进入当前借鉴队列</strong>
        <p>L2 Agent 阅读后判定该${kind === 'product' ? '产品' : '论文'}暂无借鉴价值，已自动标记为排除。</p>
      </div>
    </section>`;
  }
  const items = sortedInspirations(rawInspiration);
  if (!items.length) {
    return `<section class="detail-block detail-inspiration is-pending">
      <div class="detail-section-head">
        <h3>AI 借鉴方向</h3>
        <span>待深读</span>
      </div>
      <div class="detail-empty-state">
        <strong>还没有可执行结论</strong>
        <p>尚未经过 L2 Agent 深度阅读。可以点击 AI 深度分析，让 Agent 先生成可处理的启发点。</p>
      </div>
    </section>`;
  }
  const [lead, ...rest] = items;
  const counts = inspirationBadgeCount(items);
  const prioritySummary = [
    counts.high ? `高 ${counts.high}` : '',
    counts.med ? `中 ${counts.med}` : '',
    counts.low ? `低 ${counts.low}` : '',
  ].filter(Boolean).join(' / ');
  const leadTitle = lead.title || lead.direction.slice(0, 44) || '优先借鉴方向';
  const restList = rest.map((it, index) => `
    <article class="inspiration-compact-card priority-${it.priority}">
      <div class="inspiration-compact-index">${index + 2}</div>
      <div>
        <div class="inspiration-item-head">
          <span class="priority-tag ${it.priority}">${priorityText(it.priority)}</span>
          <strong>${escapeHtml(it.title || it.direction.slice(0, 44))}</strong>
        </div>
        ${it.direction ? `<p>${escapeHtml(shortText(it.direction, 180))}</p>` : ''}
        ${it.mobius_use ? `<p class="muted">落地：${escapeHtml(shortText(it.mobius_use, 180))}</p>` : ''}
      </div>
    </article>
  `).join('');
  return `<section class="detail-block detail-inspiration is-loaded">
    <div class="detail-section-head">
      <div>
        <h3>AI 借鉴方向</h3>
        <p class="detail-section-subtitle">先看最高优先级，再看其余补充。</p>
      </div>
      <span>L2 Agent · ${items.length} 条${prioritySummary ? ` · ${prioritySummary}` : ''}</span>
    </div>
    <article class="inspiration-lead-card priority-${lead.priority}">
      <div class="inspiration-lead-top">
        <span class="priority-tag ${lead.priority}">${priorityText(lead.priority)}</span>
        <strong>${escapeHtml(leadTitle)}</strong>
      </div>
      ${lead.direction ? `<p><span class="direction-label">启发方向</span>${escapeHtml(lead.direction)}</p>` : ''}
      ${lead.mobius_use ? `<p><span class="mobius-use-label">具体落实</span>${escapeHtml(lead.mobius_use)}</p>` : ''}
    </article>
    ${restList ? `<div class="inspiration-compact-list">${restList}</div>` : ''}
    <div class="detail-inspiration-actions">
      <button type="button" class="primary-button" data-export-prompt="${escapeHtml(kind)}">实际修改（导出给小莫）</button>
    </div>
  </section>`;
}

function renderDetailHero(kind, item, local) {
  const title = kind === 'product' ? item.name : item.title;
  const subtitle = kind === 'product'
    ? `${labels.category[item.category] || item.category || '其他'} · ${labels.status[item.status] || item.status || '候选'} · ${sourceHost(item.source_url)}`
    : `${compactAuthors(item.authors)} · ${item.published_at || '日期未知'}`;
  const score = kind === 'product'
    ? renderScoreRail({ label: 'Fit', score: item.relevance ?? 0, sublabel: '/10', tone: 'product' })
    : renderScoreRail({ label: 'Priority', score: item.priority_score ?? item.relevance ?? 0, sublabel: `rel ${compactNumber(item.relevance ?? 0)}`, tone: 'paper' });
  return `
    <header class="detail-hero detail-hero-${escapeHtml(kind)}">
      ${score}
      <div class="detail-hero-main">
        <p class="eyebrow">${kind === 'product' ? 'Product research' : 'Paper research'} · ${aiReadState(item).detail}</p>
        <h2>${escapeHtml(title)}</h2>
        <p class="detail-meta">${escapeHtml(subtitle)}</p>
        ${renderStateChips(kind, item, local)}
      </div>
    </header>
  `;
}

function renderDetailOverview(kind, item) {
  if (kind === 'product') {
    return `
      <section class="detail-block detail-overview">
        <div class="detail-section-head">
          <h3>产品快照</h3>
          <span>${escapeHtml(sourceHost(item.source_url))}</span>
        </div>
        <div class="detail-highlight-stack">
          <div>
            <span>页面标题</span>
            <strong>${escapeHtml(item.fetched_title || item.name || '暂无标题快照')}</strong>
          </div>
          <div>
            <span>页面描述</span>
            <p>${escapeHtml(item.fetched_description || '暂无描述快照，建议重扫产品页。')}</p>
          </div>
          <div>
            <span>入库理由</span>
            <p>${escapeHtml(item.reason || '暂无理由')}</p>
          </div>
        </div>
      </section>
    `;
  }
  const authors = splitAuthors(item.authors);
  return `
    <section class="detail-block detail-overview">
      <div class="detail-section-head">
        <h3>论文摘要</h3>
        <span>${escapeHtml(item.source_id || 'arXiv')}</span>
      </div>
      <p class="detail-readable-text">${escapeHtml(item.abstract || '暂无摘要')}</p>
      ${authors.length ? `<details class="detail-inline-details">
        <summary>作者列表 · ${authors.length} 位</summary>
        <p>${escapeHtml(authors.join(' / '))}</p>
      </details>` : ''}
    </section>
  `;
}

function renderDetailSourceBlock(kind, item) {
  if (kind === 'product') {
    const sourceUrl = sourceUrlFor('product', item);
    return `
      <details class="detail-block source-block detail-archive">
        <summary>
          <span>来源与字段档案</span>
          <em>${escapeHtml(item.auto_discovered ? 'Agent discovery' : 'Manual / seed')}</em>
        </summary>
        ${renderFactGrid(productFacts(item), 'detail-facts')}
        <div class="detail-field-list">
          <p><strong>URL</strong><br>${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceUrl)}</a>` : '无'}</p>
          ${item.discovered_from_url ? `<p><strong>发现来源</strong><br>${escapeHtml(item.discovered_from_url)}</p>` : ''}
          ${item.discovery_logic ? `<p><strong>发现逻辑</strong><br>${escapeHtml(item.discovery_logic)}</p>` : ''}
          ${item.note ? `<p><strong>标记备注</strong><br>${escapeHtml(item.note)}</p>` : ''}
        </div>
      </details>
    `;
  }
  const paperUrl = sourceUrlFor('paper', item);
  return `
    <details class="detail-block source-block detail-archive">
      <summary>
        <span>来源与字段档案</span>
        <em>${escapeHtml(item.source_id || 'arXiv')}</em>
      </summary>
      ${renderFactGrid([
        ...paperFacts(item),
        { label: '更新', value: item.updated_arxiv_at || '' },
        { label: '本地更新', value: formatTime(item.updated_at) },
      ], 'detail-facts')}
      ${(item.cluster_keywords || []).length ? `<div class="tag-row field-tags">${item.cluster_keywords.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
      <div class="detail-field-list">
        <p><strong>AlphaXiv 链接</strong><br>${paperUrl ? `<a href="${escapeHtml(paperUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(paperUrl)}</a>` : '无'}</p>
        ${item.note ? `<p><strong>标记备注</strong><br>${escapeHtml(item.note)}</p>` : ''}
      </div>
    </details>
  `;
}

function renderDetailQuickLinks(kind, item) {
  const url = sourceUrlFor(kind, item);
  const label = sourceLinkLabel(kind);
  return `
    <section class="detail-block detail-quick-links">
      <div class="detail-section-head">
        <h3>快速入口</h3>
        <span>${kind === 'product' ? 'Product' : 'Paper'}</span>
      </div>
      <div class="detail-link-list">
        ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>` : '<span class="muted">暂无外部链接</span>'}
        ${kind === 'product' && item.discovered_from_url ? `<a href="${escapeHtml(item.discovered_from_url)}" target="_blank" rel="noopener noreferrer">发现来源</a>` : ''}
      </div>
    </section>
  `;
}

function renderPaperDetail(id) {
  const item = findPaperById(id);
  if (!item) return false;
  $('dialogBody').dataset.detailKind = 'paper';
  $('dialogBody').dataset.detailId = id;
  const tags = [...new Set([...(item.matched_keywords || []), ...(item.tags || [])])].slice(0, 10);
  const isExcluded = isExcludedItem(item);
  const local = paperLocal(item.id);
  $('dialogBody').innerHTML = `
    <article class="detail-content detail-content-paper">
      ${renderDetailHero('paper', item, local)}
      <div class="tag-row">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="detail-layout">
        <main class="detail-main-column">
          ${renderDetailFocus('paper', item)}
          ${renderInspirationDetailBlock(item.ai_inspiration, isExcluded, 'paper')}
          ${renderDetailOverview('paper', item)}
          ${renderDetailSourceBlock('paper', item)}
        </main>
        <aside class="detail-side-column">
          ${renderPaperDetailActions(item)}
          ${renderDetailQuickLinks('paper', item)}
          ${renderDetailChatSection('paper', id, item)}
        </aside>
      </div>
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
  const isExcluded = isExcludedItem(item);
  const local = competitorLocal(item.id);
  $('dialogBody').innerHTML = `
    <article class="detail-content detail-content-product">
      ${renderDetailHero('product', item, local)}
      <div class="tag-row">${(item.tags || []).slice(0, 10).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="detail-layout">
        <main class="detail-main-column">
          ${renderDetailFocus('product', item)}
          ${renderInspirationDetailBlock(item.ai_inspiration, isExcluded, 'product')}
          ${renderDetailOverview('product', item)}
          ${renderDetailSourceBlock('product', item)}
        </main>
        <aside class="detail-side-column">
          ${renderProductDetailActions(item)}
          ${renderDetailQuickLinks('product', item)}
          ${renderDetailChatSection('product', id, item)}
        </aside>
      </div>
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
  // 走 read_at 通道, 不要再覆盖 mark 列。
  const action = kind === 'paper' ? 'mark_paper_read' : 'mark_product_read';
  call({ action, id, read: true }).then((result) => {
    if (result?.item) {
      if (kind === 'paper') {
        for (const clusterKey of Object.keys(state.clusterPapers || {})) {
          const arr = state.clusterPapers[clusterKey] || [];
          const idx = arr.findIndex((p) => p.id === id);
          if (idx >= 0) state.clusterPapers[clusterKey][idx] = { ...arr[idx], ...result.item };
        }
      } else {
        for (const bucket of ['official', 'candidate', 'archived']) {
          const arr = state.competitors[bucket] || [];
          const idx = arr.findIndex((p) => p.id === id);
          if (idx >= 0) state.competitors[bucket][idx] = { ...arr[idx], ...result.item };
        }
      }
      if (kind === 'paper') renderPapers(); else renderCompetitors();
      updateRadarDiscoveries();
    }
  }).catch(() => {});
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
      const result = await call({ action: 'mark_paper_read', id, read: true });
      if (result?.item) {
        for (const clusterKey of Object.keys(state.clusterPapers || {})) {
          const arr = state.clusterPapers[clusterKey] || [];
          const idx = arr.findIndex((p) => p.id === id);
          if (idx >= 0) state.clusterPapers[clusterKey][idx] = { ...arr[idx], ...result.item };
        }
      }
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
    if (action === 'read') {
      // read 走 read_at 通道, 不要覆盖 mark 列。
      const readResult = await call({ action: 'mark_product_read', id, read: true });
      if (readResult?.item) {
        for (const bucket of ['official', 'candidate', 'archived']) {
          const arr = state.competitors[bucket] || [];
          const idx = arr.findIndex((p) => p.id === id);
          if (idx >= 0) state.competitors[bucket][idx] = { ...arr[idx], ...readResult.item };
        }
      }
    } else {
      const result = await call({ action: 'mark_product', id, mark, note: `用户在详情页标记: ${action}` });
      state.competitors = result.competitors || state.competitors;
    }
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

function applyUpdatedPaper(updated) {
  if (!updated) return null;
  const normalized = normalizePaper(updated, updated.cluster_label || updated.cluster || '');
  const items = Array.isArray(state.papers.items) ? state.papers.items : [];
  const idx = items.findIndex((it) => it.id === normalized.id || it.source_id === normalized.id || it.source_id === normalized.source_id);
  if (idx >= 0) state.papers.items[idx] = { ...items[idx], ...normalized };
  else if (normalized.id) state.papers.items = [normalized, ...items];

  const radar = Array.isArray(state.radarTopPicks) ? state.radarTopPicks : [];
  const radarIdx = radar.findIndex((it) => it.id === normalized.id);
  if (radarIdx >= 0) state.radarTopPicks[radarIdx] = { ...radar[radarIdx], ...normalized };

  const top = Array.isArray(state.topPicks) ? state.topPicks : [];
  const topIdx = top.findIndex((it) => it.id === normalized.id);
  if (topIdx >= 0) state.topPicks[topIdx] = { ...top[topIdx], ...normalized };

  for (const clusterKey of Object.keys(state.clusterPapers || {})) {
    const arr = state.clusterPapers[clusterKey] || [];
    const clusterIdx = arr.findIndex((it) => it.id === normalized.id || it.source_id === normalized.source_id);
    if (clusterIdx >= 0) state.clusterPapers[clusterKey][clusterIdx] = { ...arr[clusterIdx], ...normalized };
  }
  return normalized;
}

function applyUpdatedProduct(updated) {
  if (!updated) return null;
  let replaced = false;
  for (const bucket of ['official', 'candidate', 'archived']) {
    const arr = state.competitors[bucket] || [];
    const idx = arr.findIndex((it) => it.id === updated.id);
    if (idx >= 0) {
      state.competitors[bucket][idx] = { ...arr[idx], ...updated };
      replaced = true;
    }
  }
  if (!replaced && updated.id) {
    const bucket = updated.status === 'official' ? 'official' : 'candidate';
    state.competitors[bucket] = [updated, ...(state.competitors[bucket] || [])];
  }
  if (Array.isArray(state.products.items)) {
    const idx = state.products.items.findIndex((it) => it.id === updated.id);
    if (idx >= 0) state.products.items[idx] = { ...state.products.items[idx], ...updated };
    else state.products.items = [updated, ...state.products.items];
  }
  return updated;
}

async function refreshSourceItem(kind, id) {
  if (kind === 'paper') {
    const fresh = await call({ action: 'get_paper', id });
    return applyUpdatedPaper(fresh?.item);
  }
  const fresh = await call({ action: 'get_product', id });
  return applyUpdatedProduct(fresh?.item);
}

function rerenderSourceViews(kind, id) {
  if (kind === 'paper') renderPapers();
  else renderCompetitors();
  updateRadarDiscoveries?.();
  rerenderOpenDetail(kind, id);
  refreshDetailChat(kind, id);
}

async function runDetailAiAnalysis(kind, id) {
  if (!['paper', 'product'].includes(kind) || !id) return;
  const chat = getDetailChat(kind, id);
  if (chat.loading) return;
  const item = kind === 'paper' ? findPaperById(id) : findProductById(id);
  if (isExcludedItem(item)) {
    showToast('这条资料已排除，如需重新分析请先取消排除状态', 'bad');
    return;
  }

  chat.loading = true;
  rerenderSourceViews(kind, id);
  try {
    const result = await call({
      action: kind === 'paper' ? 'ai_scan_arxiv' : 'ai_scan_products',
      model_key: state.aiChannel[kind],
      ids: [id],
      scope_ids: [id],
      limit: 1,
      deep_read_backlog: false,
      include_backlog: false,
      backfill: false,
    });
    if (result.async) {
      if (chat.poll) {
        const stale = [...chat.messages].reverse().find((m) => m && m.role === 'assistant' && m.pending);
        if (stale) { stale.pending = false; stale.content = `${stale.content}\n（已被新的分析打断，完整回复见 Session）`; stale.tone = 'warn'; }
        stopAgentPoll(chat);
      }
      const meta = [];
      if (result.provider) meta.push(result.provider);
      if (result.session_url) meta.push(`Session: ${result.session_url}`);
      chat.messages.push({
        role: 'assistant',
        pending: true,
        content: `AI 深度分析已启动，后台 ${kind === 'product' ? '产品' : '论文'} Agent 正在读取莫比乌斯上下文和资料详情，完成后会在这里显示摘要并写回启发点。`,
        meta: meta.join(' · '),
        time: new Date().toISOString(),
        model: result.model || '',
        runId: result.run_id || '',
        sessionUrl: result.session_url || '',
      });
      showToast('AI 深度分析已启动，后台处理中');
      startAgentPoll(kind, id, { runId: result.run_id, scopeId: id, isScan: true });
      return;
    }
    const updated = await refreshSourceItem(kind, id);
    const row = (result.results || []).find((entry) => entry.id === id) || (result.results || [])[0] || null;
    const inspirationCount = Number(row?.inspiration_count || sortedInspirations(updated?.ai_inspiration).length || 0);
    const meta = [];
    if (result.provider) meta.push(result.provider);
    if (result.tokens?.input || result.tokens?.output) meta.push(`tokens in/out=${result.tokens.input}/${result.tokens.output}`);
    let content = '';
    let tone;
    if (!Number(result.scanned || 0)) {
      content = `这${kind === 'product' ? '个产品' : '篇论文'}没有进入本轮深度分析，可能已经分析过、已被排除，或不在待分析队列。`;
      tone = 'warn';
    } else if (inspirationCount > 0) {
      content = `AI 深度分析完成，已生成 ${inspirationCount} 条启发点。现在可以继续追问细节，或在启发点列表里选择是否进入自进化。`;
    } else {
      content = `AI 已完成深度分析，但没有生成可落地启发点。可以换模型重试，或将这条资料手动排除。`;
      tone = 'warn';
    }
    chat.messages.push({
      role: 'assistant',
      content,
      meta: meta.join(' · '),
      tone,
      time: new Date().toISOString(),
      model: result.model || '',
    });
    showToast(inspirationCount > 0 ? `AI 深度分析完成: ${inspirationCount} 条启发` : 'AI 深度分析完成，未生成启发');
  } catch (error) {
    const reason = error.message || 'AI 深度分析失败，请稍后再试';
    chat.messages.push({
      role: 'assistant',
      content: `AI 深度分析失败：${reason}`,
      tone: 'error',
      time: new Date().toISOString(),
    });
    showToast(reason, 'bad');
  } finally {
    chat.loading = false;
    rerenderSourceViews(kind, id);
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
  // 若上一轮异步回复仍在轮询, 先终止并把占位消息标记为被打断
  if (chat.poll) {
    const stale = [...chat.messages].reverse().find((m) => m && m.role === 'assistant' && m.pending);
    if (stale) { stale.pending = false; stale.content = `${stale.content}\n（已被新的追问打断，完整回复见 Session）`; stale.tone = 'warn'; }
    stopAgentPoll(chat);
  }
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
    if (result.session_url) meta.push(`Session: ${result.session_url}`);
    if (result.async) {
      chat.messages.push({
        role: 'assistant',
        pending: true,
        content: '正在生成回复…',
        meta: meta.length ? meta.join(' · ') : '',
        time: new Date().toISOString(),
        model: result.model || '',
        runId: result.run_id || '',
        sessionUrl: result.session_url || '',
      });
      showToast('追问已发送到后台 Agent，正在生成回复');
      startAgentPoll(kind, id, { runId: result.run_id, scopeId: id, isScan: false });
      return;
    }
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
  $('refreshImplementationBtn')?.addEventListener('click', loadImplementationQueue);
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
  bindScanToolsDialog();
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
  document.querySelectorAll('[data-implementation-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.implementationFilter = button.dataset.implementationFilter || '';
      document.querySelectorAll('[data-implementation-filter]').forEach((item) => item.classList.toggle('is-active', item === button));
      renderImplementation();
    });
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
  document.addEventListener('submit', handleDetailChatSubmit);
  document.body.addEventListener('click', (event) => {
    const detailAnalyze = event.target.closest('[data-detail-ai-analyze]');
    if (detailAnalyze) {
      event.preventDefault();
      runDetailAiAnalysis(detailAnalyze.dataset.detailAiAnalyze, detailAnalyze.dataset.sourceId);
      return;
    }

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

    const evoGroupToggle = event.target.closest('[data-toggle-evolution-group]');
    if (evoGroupToggle) {
      const id = evoGroupToggle.dataset.toggleEvolutionGroup;
      const current = state.evolution.expanded[id] !== false;
      state.evolution.expanded[id] = !current;
      renderEvolution();
    }

    const promoteL2 = event.target.closest('[data-promote-l2]');
    if (promoteL2) promoteL2ToL1(promoteL2.dataset.promoteL2);

    const reject = event.target.closest('[data-reject-l2]');
    if (reject) rejectL2(reject.dataset.rejectL2);

    const paperDetail = event.target.closest('[data-paper-detail]');
    if (paperDetail) openPaperDetail(paperDetail.dataset.paperDetail);

    const sourceSelect = event.target.closest('[data-select-source]');
    if (sourceSelect) {
      const kind = sourceSelect.dataset.selectSource;
      state.selected[kind] = sourceSelect.dataset.sourceId || '';
      state.selected.inspiration[kind] = '';
      if (kind === 'paper') renderPapers();
      if (kind === 'product') renderCompetitors();
    }

    const inspirationSelect = event.target.closest('[data-select-inspiration]');
    if (inspirationSelect) {
      const kind = inspirationSelect.dataset.selectInspiration;
      state.selected[kind] = inspirationSelect.dataset.sourceId || state.selected[kind] || '';
      state.selected.inspiration[kind] = inspirationSelect.dataset.inspirationKey || '';
      if (kind === 'paper') renderPapers();
      if (kind === 'product') renderCompetitors();
    }

    const sourceReview = event.target.closest('[data-source-review]');
    if (sourceReview) {
      setSourceReview(sourceReview.dataset.sourceReview, sourceReview.dataset.sourceId, sourceReview.dataset.status);
    }

    const inspirationDecision = event.target.closest('[data-inspiration-decision]');
    if (inspirationDecision) {
      decideInspiration(
        inspirationDecision.dataset.inspirationDecision,
        inspirationDecision.dataset.sourceId,
        inspirationDecision.dataset.inspirationIndex,
        inspirationDecision.dataset.inspirationKey,
        inspirationDecision.dataset.status,
      );
    }

    const implement = event.target.closest('[data-implement-l2]');
    if (implement) implementL2Inspiration(implement.dataset.implementL2, implement.dataset.mode);

    const updateL2 = event.target.closest('[data-update-l2-status]');
    if (updateL2) updateL2Status(updateL2.dataset.updateL2Status, updateL2.dataset.status);

    const paperDetailAction = event.target.closest('[data-paper-detail-action]');
    if (paperDetailAction) handlePaperDetailAction(paperDetailAction.dataset.paperDetailAction, paperDetailAction.dataset.action);

    const paperRead = event.target.closest('[data-paper-read]');
    if (paperRead) {
      const id = paperRead.dataset.paperRead;
      const nextRead = !paperLocal(id).read;
      paperLocal(id).read = nextRead;
      saveLocalState();
      renderPapers();
      updateRadarDiscoveries();
      call({ action: 'mark_paper_read', id, read: nextRead }).then((result) => {
        if (result?.item) {
          for (const clusterKey of Object.keys(state.clusterPapers || {})) {
            const arr = state.clusterPapers[clusterKey] || [];
            const idx = arr.findIndex((p) => p.id === id);
            if (idx >= 0) state.clusterPapers[clusterKey][idx] = { ...arr[idx], ...result.item };
          }
          renderPapers();
          updateRadarDiscoveries();
        }
      }).catch(() => {});
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
      const id = productRead.dataset.productRead;
      const nextRead = !competitorLocal(id).read;
      competitorLocal(id).read = nextRead;
      saveLocalState();
      renderCompetitors();
      updateRadarDiscoveries();
      call({ action: 'mark_product_read', id, read: nextRead }).then((result) => {
        if (result?.item) {
          for (const bucket of ['official', 'candidate', 'archived']) {
            const arr = state.competitors[bucket] || [];
            const idx = arr.findIndex((p) => p.id === id);
            if (idx >= 0) state.competitors[bucket][idx] = { ...arr[idx], ...result.item };
          }
          renderCompetitors();
          updateRadarDiscoveries();
        }
      }).catch(() => {});
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
