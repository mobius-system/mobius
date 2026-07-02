/**
 * world-cup/backend/extension_backend_handler.js
 *
 * 世界杯内容聚合后端，职责：
 *   - 周期性抓取 RSS / feed（公开体育媒体 world-cup / football 频道）
 *   - 去重、清洗、本地 JSON 存储（不会清空旧数据）
 *   - 对前端提供 read（聚合内容）/ sync_now（强制刷新）/ whoami / sources_meta
 *
 * 全部外部内容视为不可信：长度截断、标签剥离、HTML 转义交给前端。
 *
 * 存储：ext_data_dir 是唯一可写区
 *   - news.json       抓回来的新闻条目（去重、按时间倒序、带来源/抓取时间/许可）
 *   - sync_state.json 最近一次同步状态（成功源数、失败源数、时间戳、degraded 标记）
 *   - sync_log.jsonl  最近 N 次同步日志（覆盖式 ring buffer）
 *
 * 数据流：cron（外部）→ sync_now → 写 news.json → 前端 read 只读 news.json。
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXTENSION_NAME = 'world-cup';
const MAX_NEWS_ITEMS = 200;       // 存储上限
const PER_SOURCE_LIMIT = 18;      // 每个 RSS 源最多保留条数
const SYNC_LOG_LIMIT = 80;        // 同步日志 ring buffer 上限
const FETCH_TIMEOUT_MS = 6000;
const FETCH_RETRIES = 1;
const NEWS_REFRESH_MS = 30 * 60 * 1000;
const FIXTURE_REFRESH_MS = 10 * 60 * 1000;
const SCORER_REFRESH_MS = 30 * 60 * 1000;
const ESPN_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard';
const ESPN_SCORING_STATS_URL = 'https://www.espn.com/soccer/stats/_/league/FIFA.WORLD/season/2026/view/scoring';
const AGENT_STATE_FILE = 'agent_state.json';
const EXTENSION_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// RSS / feed 来源 —— 公开频道，全部只读 GET。
// 来源说明与授权信息：BBC / Guardian / Sky Sports / ESPN 均提供公开 RSS，
// 仅供本站做"标题 + 摘要 + 链接"的导览，原文版权归原媒体所有。
const RSS_SOURCES = [
  {
    id: 'google-news-zh-worldcup',
    name: 'Google News 中文 · 2026 世界杯',
    url: 'https://news.google.com/rss/search?q=2026%E4%B8%96%E7%95%8C%E6%9D%AF%20OR%20%E7%BE%8E%E5%8A%A0%E5%A2%A8%E4%B8%96%E7%95%8C%E6%9D%AF&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    priority: 5,
  },
  {
    id: 'google-news-zh-fixtures',
    name: 'Google News 中文 · 世界杯赛程',
    url: 'https://news.google.com/rss/search?q=%E4%B8%96%E7%95%8C%E6%9D%AF%20%E8%B5%9B%E7%A8%8B%20%E5%B0%84%E6%89%8B%E6%A6%9C%20when%3A7d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    priority: 4,
  },
  {
    id: 'google-news-zh-hosts',
    name: 'Google News 中文 · 美加墨主办城市',
    url: 'https://news.google.com/rss/search?q=%E7%BE%8E%E5%8A%A0%E5%A2%A8%E4%B8%96%E7%95%8C%E6%9D%AF%20%E4%B8%BB%E5%8A%9E%E5%9F%8E%E5%B8%82%20when%3A14d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    priority: 4,
  },
  { id: 'bbc-football',    name: 'BBC Sport · Football',    url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
  { id: 'guardian-football', name: 'The Guardian · Football', url: 'https://www.theguardian.com/football/rss' },
  { id: 'sky-sports-football', name: 'Sky Sports · Football News', url: 'https://www.skysports.com/rss/12040' },
  { id: 'espn-soccer',     name: 'ESPN · Soccer',           url: 'https://www.espn.com/espn/rss/soccer/news' },
];

// 世界杯相关关键词：用于在抓回的 feed 里做相关性排序（不剔除其他条目）
const WORLD_CUP_KEYWORDS = [
  'world cup', 'wc26', 'wc2026', 'fifa', 'international duty',
  '世界杯', '世预赛', '国家队', '国际比赛', '美加墨', '美加墨世界杯',
  '赛程', '射手榜', '积分榜', '小组赛', '淘汰赛', '主办城市', '球场',
  // 常见强队英文名（用于把国家队新闻往上排）
  'argentina', 'brazil', 'france', 'england', 'spain', 'germany', 'portugal',
  'netherlands', 'italy', 'belgium', 'croatia', 'mexico', 'usa', 'japan', 'korea',
];

const TEAM_LABELS = {
  Argentina: ['阿根廷', 'ARG'],
  Australia: ['澳大利亚', 'AUS'],
  Belgium: ['比利时', 'BEL'],
  Brazil: ['巴西', 'BRA'],
  Canada: ['加拿大', 'CAN'],
  Colombia: ['哥伦比亚', 'COL'],
  'Congo DR': ['刚果（金）', 'COD'],
  Croatia: ['克罗地亚', 'CRO'],
  Ecuador: ['厄瓜多尔', 'ECU'],
  England: ['英格兰', 'ENG'],
  France: ['法国', 'FRA'],
  Germany: ['德国', 'GER'],
  Ghana: ['加纳', 'GHA'],
  'Ivory Coast': ['科特迪瓦', 'CIV'],
  Japan: ['日本', 'JPN'],
  Mexico: ['墨西哥', 'MEX'],
  Morocco: ['摩洛哥', 'MAR'],
  Netherlands: ['荷兰', 'NED'],
  'New Zealand': ['新西兰', 'NZL'],
  Norway: ['挪威', 'NOR'],
  Portugal: ['葡萄牙', 'POR'],
  Senegal: ['塞内加尔', 'SEN'],
  'South Korea': ['韩国', 'KOR'],
  Spain: ['西班牙', 'ESP'],
  Sweden: ['瑞典', 'SWE'],
  Switzerland: ['瑞士', 'SUI'],
  Uruguay: ['乌拉圭', 'URU'],
  'United States': ['美国', 'USA'],
};

// ----- 工具函数 -----

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function nowIso() { return new Date().toISOString(); }

function isFresh(iso, maxAgeMs) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) && (Date.now() - t) < maxAgeMs;
}

function normalizeYmd(value) {
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function addDaysYmd(ymd, delta) {
  const d = new Date(`${normalizeYmd(ymd)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function toEspnDate(ymd) {
  return normalizeYmd(ymd).replace(/-/g, '');
}

function clampInt(n, fallback, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function trimText(value, max = 500) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/<[^>]+>/g, ' ')   // 剥离描述里的标签
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block, tag) {
  const re = new RegExp(`<(?:[a-z0-9_-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z0-9_-]+:)?${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeHtml(m[1]) : '';
}

function extractAtomLink(block) {
  // 优先取 rel="alternate" 的 link
  const alt = block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i)
         || block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["']/i);
  if (alt) return decodeHtml(alt[1]);
  const any = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  return any ? decodeHtml(any[1]) : '';
}

function normalizeDate(value) {
  if (!value) return nowIso();
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : nowIso();
}

function normalizeUrl(value) {
  const s = trimText(value, 900);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return `https://www.espn.com${s}`;
  return '';
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MobiusWorldCupHub/0.1 (+local content aggregation; contact: admin)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MobiusWorldCupHub/0.1 (+local content aggregation; contact: admin)',
        'Accept': 'application/json, */*',
      },
      redirect: 'follow',
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtmlWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MobiusWorldCupHub/0.1 (+local content aggregation; contact: admin)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetries(url, logger) {
  let lastErr;
  for (let i = 0; i <= FETCH_RETRIES; i++) {
    try {
      return await fetchWithTimeout(url);
    } catch (e) {
      lastErr = e;
      if (i < FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, 600 * (i + 1)));
      }
    }
  }
  logger?.warn(`fetch failed: ${url} — ${lastErr?.message || lastErr}`);
  throw lastErr || new Error('fetch failed');
}

// 解析 RSS 2.0 / Atom 1.0
function parseFeed(raw, source) {
  const items = [];
  const blocks = raw.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link') || extractTag(block, 'guid');
    if (!title || !link) continue;
    const summary = extractTag(block, 'description') || extractTag(block, 'summary');
    // 媒体缩略图：media:thumbnail / enclosure / media:content
    let image = '';
    const mThumb = block.match(/<media:thumbnail\b[^>]*\burl=["']([^"']+)["']/i);
    const mContent = block.match(/<media:content\b[^>]*\burl=["']([^"']+)["']/i);
    const enc = block.match(/<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*\btype=["']image\//i);
    image = (mThumb && mThumb[1]) || (mContent && mContent[1]) || (enc && enc[1]) || '';
    items.push({
      source: source.name,
      source_id: source.id,
      source_priority: source.priority || 0,
      title,
      summary,
      url: link,
      image,
      image_license: '© ' + source.name,
      ts: normalizeDate(extractTag(block, 'pubDate') || extractTag(block, 'date')),
      raw_source: 'rss',
    });
  }
  const entries = raw.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of entries) {
    const title = extractTag(block, 'title');
    const url = extractAtomLink(block) || extractTag(block, 'id');
    if (!title || !url) continue;
    items.push({
      source: source.name,
      source_id: source.id,
      source_priority: source.priority || 0,
      title,
      summary: extractTag(block, 'summary') || extractTag(block, 'content'),
      url,
      image: '',
      image_license: '© ' + source.name,
      ts: normalizeDate(extractTag(block, 'updated') || extractTag(block, 'published')),
      raw_source: 'atom',
    });
  }
  return items;
}

function scoreRelevance(text) {
  const t = text.toLowerCase();
  let score = 0;
  for (const kw of WORLD_CUP_KEYWORDS) if (t.includes(kw)) score += 1;
  return score;
}

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ''));
}

function normalizeItem(raw) {
  const title = trimText(raw.title, 220);
  const url = trimText(raw.url, 900);
  const summary = trimText(raw.summary || '', 600);
  const image = trimText(raw.image || '', 900);
  const dedupeKey = sha1((url || title).toLowerCase());
  const sourcePriority = clampInt(raw.source_priority || raw.priority, 0, 0, 10);
  const chineseBoost = hasChinese(`${title} ${summary}`) ? 3 : 0;
  const relevance = scoreRelevance(`${title} ${summary}`) + sourcePriority + chineseBoost;
  return {
    id: sha1(`${dedupeKey}:${title}`).slice(0, 16),
    dedupe_key: dedupeKey,
    title,
    summary,
    url,
    image,
    image_license: trimText(raw.image_license || raw.source || '', 80),
    source: trimText(raw.source || '', 80),
    source_id: trimText(raw.source_id || '', 40),
    ts: normalizeDate(raw.ts),
    relevance,
    language: hasChinese(`${title} ${summary}`) ? 'zh' : 'auto',
    first_seen_at: nowIso(),
    fetched_at: nowIso(),
  };
}

function stageLabel(event) {
  const slug = event?.season?.slug || event?.season?.type?.name || '';
  const lower = String(slug).toLowerCase();
  if (lower.includes('group')) return '小组赛';
  if (lower.includes('round-of-32') || lower.includes('round of 32')) return '32 强';
  if (lower.includes('round-of-16') || lower.includes('rd of 16')) return '16 强';
  if (lower.includes('quarter')) return '1/4 决赛';
  if (lower.includes('semi')) return '半决赛';
  if (lower.includes('third') || lower.includes('3rd')) return '三四名决赛';
  if (lower.includes('final')) return '决赛';
  return '世界杯';
}

function espnTeamLogo(team) {
  const logos = Array.isArray(team?.logos) ? team.logos : [];
  const preferred = logos.find((logo) => logo?.href && /500|default|full/i.test(`${logo.rel || ''} ${logo.width || ''}`))
    || logos.find((logo) => logo?.href)
    || null;
  return normalizeUrl(preferred?.href || team?.logo || '');
}

function normalizeFixtureEvent(event) {
  const comp = event?.competitions?.[0] || {};
  const competitors = Array.isArray(comp.competitors) ? comp.competitors : [];
  const home = competitors.find((c) => c.homeAway === 'home') || competitors[0] || {};
  const away = competitors.find((c) => c.homeAway === 'away') || competitors[1] || {};
  const homeTeam = home.team || {};
  const awayTeam = away.team || {};
  if (!homeTeam.abbreviation || !awayTeam.abbreviation) return null;

  const statusType = comp.status?.type || {};
  const statusState = statusType.state || 'pre';
  const completed = !!statusType.completed;
  const kind = completed || statusState === 'post'
    ? 'done'
    : (statusState === 'in' ? 'live' : 'upcoming');
  const score = kind === 'upcoming'
    ? '— : —'
    : `${home.score ?? 0} : ${away.score ?? 0}`;
  const status = kind === 'done'
    ? 'FT'
    : (kind === 'live'
      ? (comp.status?.displayClock || statusType.shortDetail || 'LIVE')
      : '');
  const venue = comp.venue || {};
  const city = venue.address?.city || venue.address?.country || '';

  return {
    id: String(event.id || comp.id || `${event.date}-${homeTeam.abbreviation}-${awayTeam.abbreviation}`),
    date: normalizeDate(event.date || comp.date),
    stage: stageLabel(event),
    home: trimText(homeTeam.abbreviation, 8),
    homeName: trimText(homeTeam.displayName || homeTeam.shortDisplayName || homeTeam.name, 80),
    homeLogo: espnTeamLogo(homeTeam),
    away: trimText(awayTeam.abbreviation, 8),
    awayName: trimText(awayTeam.displayName || awayTeam.shortDisplayName || awayTeam.name, 80),
    awayLogo: espnTeamLogo(awayTeam),
    score,
    status,
    kind,
    venue: trimText(venue.fullName || '', 100),
    city: trimText(city, 100),
    source: 'ESPN Scoreboard',
  };
}

async function fetchScoreboardDay(ymd, logger) {
  const url = `${ESPN_SCOREBOARD_URL}?dates=${toEspnDate(ymd)}`;
  const json = await fetchJsonWithTimeout(url, FETCH_TIMEOUT_MS + 2000);
  const events = Array.isArray(json.events) ? json.events : [];
  const fixtures = events.map(normalizeFixtureEvent).filter(Boolean);
  logger?.info(`scoreboard ok: ${ymd} fixtures=${fixtures.length}`);
  return fixtures;
}

function fallbackFixtureForDay(ymd, idx) {
  const teams = [
    ['BRA', '巴西', 'JPN', '日本'],
    ['ENG', '英格兰', 'NED', '荷兰'],
    ['ARG', '阿根廷', 'POR', '葡萄牙'],
    ['ESP', '西班牙', 'GER', '德国'],
    ['FRA', '法国', 'MAR', '摩洛哥'],
    ['USA', '美国', 'MEX', '墨西哥'],
    ['KOR', '韩国', 'URU', '乌拉圭'],
  ];
  const pair = teams[idx % teams.length];
  const date = `${ymd}T20:00:00Z`;
  return {
    id: `fallback-${ymd}-${idx}`,
    date,
    stage: '赛程雷达',
    home: pair[0],
    homeName: pair[1],
    away: pair[2],
    awayName: pair[3],
    score: '— : —',
    status: '',
    kind: 'upcoming',
    venue: idx % 2 ? 'Host City Live' : 'World Cup Hub',
    city: idx % 2 ? '北美赛区' : '自动轮播',
    source: '动态示意',
    sample: true,
  };
}

function dynamicFallbackFixtures(baseDate) {
  const today = normalizeYmd(baseDate);
  const tomorrow = addDaysYmd(today, 1);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDaysYmd(today, i));
  return {
    today: [fallbackFixtureForDay(today, 0), fallbackFixtureForDay(today, 1), fallbackFixtureForDay(today, 2)],
    tomorrow: [fallbackFixtureForDay(tomorrow, 3), fallbackFixtureForDay(tomorrow, 4), fallbackFixtureForDay(tomorrow, 5)],
    week: weekDays.map((d, i) => fallbackFixtureForDay(d, i)),
  };
}

async function readFixtures({ ext_data_dir, logger, clientDate, force }) {
  const fixturesFile = path.join(ext_data_dir, 'fixtures.json');
  const stateFile = path.join(ext_data_dir, 'fixtures_state.json');
  const baseDate = normalizeYmd(clientDate);
  const existing = await readJson(fixturesFile, null);
  const existingState = await readJson(stateFile, null);

  if (!force && existing && existingState?.base_date === baseDate && isFresh(existingState.last_sync_at, FIXTURE_REFRESH_MS)) {
    return { fixtures: existing, state: existingState };
  }

  const days = Array.from(new Set([
    baseDate,
    addDaysYmd(baseDate, 1),
    ...Array.from({ length: 7 }, (_, i) => addDaysYmd(baseDate, i)),
  ]));
  const results = await Promise.allSettled(days.map((d) => fetchScoreboardDay(d, logger)));
  const byDay = new Map();
  let okDays = 0;
  let fetched = 0;
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const r = results[i];
    if (r.status === 'fulfilled') {
      okDays += 1;
      fetched += r.value.length;
      byDay.set(day, r.value);
    } else {
      logger?.warn(`scoreboard fail: ${day} — ${r.reason?.message || r.reason}`);
      byDay.set(day, []);
    }
  }

  const todayList = byDay.get(baseDate) || [];
  const tomorrowDate = addDaysYmd(baseDate, 1);
  const tomorrowList = byDay.get(tomorrowDate) || [];
  const weekList = days.slice(0, 7).flatMap((d) => byDay.get(d) || []);
  let fixtures = {
    today: todayList,
    tomorrow: tomorrowList,
    week: weekList,
  };
  const degraded = fetched === 0;
  if (degraded) {
    fixtures = existingState?.base_date === baseDate && existing
      ? existing
      : dynamicFallbackFixtures(baseDate);
  }

  const state = {
    base_date: baseDate,
    last_sync_at: nowIso(),
    source: 'ESPN Scoreboard',
    ok_days: okDays,
    total_days: days.length,
    fetched_items: fetched,
    degraded,
  };
  await writeJson(fixturesFile, fixtures);
  await writeJson(stateFile, state);
  return { fixtures, state };
}

function extractAttr(html, attr) {
  const re = new RegExp(`\\b${attr}=["']([^"']+)["']`, 'i');
  const m = String(html || '').match(re);
  return m ? decodeHtml(m[1]) : '';
}

function extractFirstAnchor(cell) {
  const m = String(cell || '').match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
  if (!m) return { name: decodeHtml(cell), href: '' };
  return {
    name: decodeHtml(m[2]),
    href: normalizeUrl(extractAttr(m[1], 'href')),
  };
}

function parseStatInt(value) {
  const n = Number(String(value || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseEspnStatsTable(html, className) {
  const tableIndex = String(html || '').indexOf(className);
  if (tableIndex < 0) return [];
  const tbodyStart = html.indexOf('<tbody', tableIndex);
  const tbodyEnd = html.indexOf('</tbody>', tbodyStart);
  if (tbodyStart < 0 || tbodyEnd < 0) return [];
  const tbody = html.slice(tbodyStart, tbodyEnd);
  const rows = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(tbody))) {
    const cells = Array.from(rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)).map((m) => m[1]);
    if (cells.length < 5) continue;
    const athlete = extractFirstAnchor(cells[1]);
    const team = extractFirstAnchor(cells[2]);
    if (!athlete.name || !team.name) continue;
    const rank = parseStatInt(decodeHtml(cells[0])) || rows.length + 1;
    rows.push({
      rank,
      name: trimText(athlete.name, 80),
      player_url: athlete.href,
      team: trimText(team.name, 80),
      team_url: team.href,
      appearances: parseStatInt(decodeHtml(cells[3])),
      value: parseStatInt(decodeHtml(cells[4])),
    });
  }
  return rows;
}

function teamCountryLabel(teamName) {
  const mapped = TEAM_LABELS[teamName];
  if (mapped) return `${mapped[0]} · ${mapped[1]}`;
  const code = String(teamName || '')
    .replace(/[^A-Za-z]/g, '')
    .slice(0, 3)
    .toUpperCase() || 'WC';
  return `${teamName || 'Unknown'} · ${code}`;
}

function espnHeadshotFromPlayerUrl(playerUrl) {
  const s = String(playerUrl || '');
  const m = s.match(/\/id\/(\d+)\b/) || s.match(/[?&]id=(\d+)\b/);
  if (!m) return '';
  return `https://a.espncdn.com/i/headshots/soccer/players/full/${m[1]}.png`;
}

function parseEspnScorers(html) {
  const scorers = parseEspnStatsTable(html, 'top-score-table');
  const assists = parseEspnStatsTable(html, 'top-assists-table');
  const assistMap = new Map();
  for (const row of assists) {
    const key = `${row.name}|${row.team}`;
    assistMap.set(key, row.value);
  }
  return scorers.slice(0, 12).map((row, index) => ({
    rank: index + 1,
    name: row.name,
    country: teamCountryLabel(row.team),
    teamName: row.team,
    appearances: row.appearances,
    goals: row.value,
    assists: assistMap.get(`${row.name}|${row.team}`) || 0,
    photo: espnHeadshotFromPlayerUrl(row.player_url),
    player_url: row.player_url,
    team_url: row.team_url,
    source: 'ESPN 2026 scoring stats',
  }));
}

async function readScorers({ ext_data_dir, logger, force }) {
  const scorersFile = path.join(ext_data_dir, 'scorers.json');
  const stateFile = path.join(ext_data_dir, 'scorers_state.json');
  const existing = await readJson(scorersFile, null);
  const existingState = await readJson(stateFile, null);
  if (!force && existing && isFresh(existingState?.last_sync_at, SCORER_REFRESH_MS)) {
    return { scorers: existing, state: existingState };
  }

  let scorers = [];
  let degraded = false;
  try {
    const html = await fetchHtmlWithTimeout(ESPN_SCORING_STATS_URL, FETCH_TIMEOUT_MS + 3000);
    scorers = parseEspnScorers(html);
    if (!scorers.length) throw new Error('empty scoring table');
    logger?.info(`scorers ok: items=${scorers.length}`);
  } catch (e) {
    degraded = true;
    logger?.warn(`scorers refresh failed: ${e.message || e}`);
    scorers = existing || [];
  }

  const state = {
    season: 2026,
    last_sync_at: nowIso(),
    source: 'ESPN 2026 scoring stats',
    fetched_items: scorers.length,
    degraded,
  };
  await writeJson(scorersFile, scorers);
  await writeJson(stateFile, state);
  return { scorers, state };
}

// ----- 持久化 -----

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function appendSyncLog(logFile, entry) {
  let list = [];
  try { list = JSON.parse(await fs.readFile(logFile, 'utf8')); } catch {}
  list.push(entry);
  if (list.length > SYNC_LOG_LIMIT) list = list.slice(-SYNC_LOG_LIMIT);
  await fs.writeFile(logFile, JSON.stringify(list, null, 2));
}

// ----- Mobius Agent 问答 / 插件维护 -----

function extensionBridge() {
  try {
    return require('../../../backend/services/extension-agent-bridge');
  } catch (firstErr) {
    try {
      return require('../../../backend/services/extension-agent-bridge.ts');
    } catch {
      throw firstErr;
    }
  }
}

function loadMessagesRepo() {
  try {
    return require('../../../backend/repositories/messages').Messages;
  } catch (firstErr) {
    try {
      return require('../../../backend/repositories/messages.ts').Messages;
    } catch {
      const direct = loadMessagesRepoFromSqlite();
      if (direct) return direct;
      throw firstErr;
    }
  }
}

function loadMessagesRepoFromSqlite() {
  try {
    const Database = require('better-sqlite3');
    const { DB_PATH } = require('../../../backend/config');
    const candidates = [
      DB_PATH,
      path.join(REPO_ROOT, '.deploy_data', 'data', 'mobuis.db'),
      path.join(REPO_ROOT, '.deploy_data', 'protected_data', 'mobuis.db'),
      path.join(REPO_ROOT, '.deploy_data', 'data', 'mobius.db'),
      path.join(REPO_ROOT, '.deploy_data', 'protected_data', 'mobius.db'),
    ].filter(Boolean);
    const dbPath = candidates.find((candidate) => fsSync.existsSync(candidate));
    if (!dbPath) return null;
    return {
      recentForTask(taskId, limit = 100) {
        const parsedLimit = clampInt(limit, 100, 1, 500);
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
          const total = db.prepare('SELECT COUNT(*) as c FROM messages_v2 WHERE task_id = ?').get(taskId);
          const rows = db.prepare(`
            SELECT id, role, content, tool_summary, raw_event, turn_summary, created_at
            FROM messages_v2
            WHERE task_id = ?
            ORDER BY id DESC
            LIMIT ?
          `).all(taskId, parsedLimit);
          return { messages: rows.reverse(), total: total?.c || 0 };
        } finally {
          db.close();
        }
      },
    };
  } catch {
    return null;
  }
}

function agentSessionUrl(user, created) {
  return `/u/${encodeURIComponent(user.id)}/p/${encodeURIComponent(created.project.id)}/i/${encodeURIComponent(created.issue.id)}?session=${encodeURIComponent(created.session.session_id)}`;
}

function extractTaggedAnswer(text) {
  const s = decodeHtml(String(text || ''));
  const m = s.match(/<further-answering>([\s\S]*?)<\/further-answering>/i)
    || s.match(/<further-answering>([\s\S]*?)<further-answering>/i)
    || s.match(/<world-cup-answer>([\s\S]*?)<\/world-cup-answer>/i);
  return m ? trimText(m[1], 2000) : '';
}

function worldCupAgentModel() {
  return trimText(process.env.WORLD_CUP_AGENT_MODEL, 120) || 'codex';
}

function compactForPrompt(value, max = 5000) {
  return trimText(JSON.stringify(value || null, null, 2), max);
}

function collectLatestWorldCupDocs() {
  const candidates = [
    path.join(REPO_ROOT, 'README.md'),
    path.join(REPO_ROOT, 'README.zh.md'),
    path.join(EXTENSION_DIR, 'README.md'),
    path.join(EXTENSION_DIR, 'SELF_COGNITION_OVERVIEW.md'),
    path.join(REPO_ROOT, '.mobius', 'project_knowledge.md'),
  ];
  const seen = new Set();
  const parts = [];
  for (const file of candidates) {
    const abs = path.resolve(file);
    if (seen.has(abs) || !abs.startsWith(REPO_ROOT + path.sep)) continue;
    seen.add(abs);
    try {
      if (!fsSync.existsSync(abs) || !fsSync.statSync(abs).isFile()) continue;
      const rel = abs.replace(REPO_ROOT + path.sep, '');
      const content = fsSync.readFileSync(abs, 'utf8').slice(0, 5000);
      parts.push(`## ${rel}\n\n${content}`);
    } catch {}
    if (parts.join('\n').length > 16000) break;
  }
  return parts.join('\n\n---\n\n').slice(0, 18000);
}

async function buildWorldCupDataSnapshot(ext_data_dir) {
  const [news, newsState, fixtures, fixturesState, scorers, scorerState] = await Promise.all([
    readJson(path.join(ext_data_dir, 'news.json'), []),
    readJson(path.join(ext_data_dir, 'sync_state.json'), null),
    readJson(path.join(ext_data_dir, 'fixtures.json'), null),
    readJson(path.join(ext_data_dir, 'fixtures_state.json'), null),
    readJson(path.join(ext_data_dir, 'scorers.json'), []),
    readJson(path.join(ext_data_dir, 'scorers_state.json'), null),
  ]);
  return {
    news_state: newsState,
    fixtures_state: fixturesState,
    scorers_state: scorerState,
    latest_news: Array.isArray(news) ? news.slice(0, 12).map((item) => ({
      title: item.title,
      source: item.source,
      ts: item.ts,
      url: item.url,
      language: item.language,
      relevance: item.relevance,
      sample: !!item.sample,
    })) : [],
    fixtures: fixtures ? {
      today: (fixtures.today || []).slice(0, 8),
      tomorrow: (fixtures.tomorrow || []).slice(0, 8),
      week: (fixtures.week || []).slice(0, 12),
    } : null,
    scorers: Array.isArray(scorers) ? scorers.slice(0, 12) : [],
  };
}

async function buildWorldCupAgentPrompt({ ext_data_dir, message, display_name, reuse }) {
  const snapshot = await buildWorldCupDataSnapshot(ext_data_dir);
  const mdContext = collectLatestWorldCupDocs();
  return [
    '# 世界杯插件问AI',
    '',
    `用户：${display_name || 'Mobius 用户'}`,
    `会话类型：${reuse ? '继续既有 World Cup Agent Session' : '新建 World Cup Agent Session'}`,
    '',
    '## 你的角色',
    '- 你是莫比乌斯 2026 世界杯插件的专属 Agent。',
    '- 你可以回答世界杯赛程、球队、球员、新闻、主办城市、页面数据来源等问题，默认用中文。',
    '- 如果用户要求修改这个世界杯插件，你可以直接检查并修改插件源码，不要只给建议。',
    '',
    '## 插件代码位置',
    `- 仓库根：${REPO_ROOT}`,
    `- 插件目录：${EXTENSION_DIR}`,
    `- 后端：${path.join(EXTENSION_DIR, 'backend', 'extension_backend_handler.js')}`,
    `- 前端：${path.join(EXTENSION_DIR, 'frontend', 'index.html')}`,
    `- 前端脚本：${path.join(EXTENSION_DIR, 'frontend', 'main.js')}`,
    `- 前端样式：${path.join(EXTENSION_DIR, 'frontend', 'styles.css')}`,
    `- 运行时静态目录：${path.join(EXTENSION_DIR, 'frontend', 'dist')}`,
    '',
    '## 修改插件时必须遵守',
    '- 只处理 world-cup 插件相关文件，不要动 self-cognition、README 主仓库等无关文件。',
    '- 前端源文件改完后，同步 index.html/main.js/styles.css 到 frontend/dist/。',
    '- 能跑校验时至少执行 node --check backend/extension_backend_handler.js、node --check frontend/main.js、git diff --check -- mobius/extension/world-cup。',
    '- 不要 revert/reset 用户或其它 Agent 的改动。',
    '',
    '## 网页内简短回显',
    '- 你的完整回答可以正常写在 Session 中。',
    '- 每次回复末尾必须额外输出一段可给插件网页聊天框展示的简短摘要，格式严格如下：',
    '<further-answering>',
    '用 3-6 句话中文概括直接答案、已做动作、验证方法或下一步；必须简短但不能遗漏关键结论；不能放 Markdown 表格、代码块或超长日志。',
    '</further-answering>',
    '- 如果用户只是问简单世界杯问题，further-answering 中直接给简明答案。',
    '- 如果用户要求改页面，further-answering 中必须包含“改了什么”和“如何验证”。',
    '',
    '## 当前缓存数据快照',
    compactForPrompt(snapshot, 12000),
    '',
    '## 近期项目文档摘录',
    mdContext || '(未找到可注入的 md 文档)',
    '',
    '## 用户问题 / 指令',
    trimText(message, 5000),
    '',
    '请先判断用户是在问世界杯信息、追问数据来源，还是要求修改插件。需要修改时直接执行并在最后说明改了什么、如何验证、还有什么风险。',
  ].join('\n');
}

async function loadAgentState(ext_data_dir) {
  return await readJson(path.join(ext_data_dir, AGENT_STATE_FILE), {});
}

async function saveAgentState(ext_data_dir, state) {
  await writeJson(path.join(ext_data_dir, AGENT_STATE_FILE), state || {});
}

function publicAgentState(state) {
  if (!state || !state.session_id) return null;
  return {
    session_id: state.session_id,
    project_id: state.project_id,
    issue_id: state.issue_id,
    session_url: state.session_url,
    model: state.model,
    updated_at: state.updated_at,
    created_at: state.created_at,
    latest_answer: state.latest_answer || '',
    latest_answer_at: state.latest_answer_at || '',
  };
}

async function startWorldCupAgentChat({ username, display_name, ext_data_dir, payload, logger }) {
  const message = trimText(payload.message || payload.prompt || '', 5000);
  if (!message) return { ok: false, error: 'message 不能为空' };

  const state = await loadAgentState(ext_data_dir);
  const reset = !!payload.new_session || !!payload.reset_session;
  let created = null;
  let user = null;
  let session = null;
  let sessionUrl = '';
  let reuse = !reset && !!state.session_id;

  if (reuse) {
    session = {
      session_id: state.session_id,
      project_id: state.project_id,
      issue_id: state.issue_id,
    };
    sessionUrl = state.session_url || '';
  } else {
    const { createExtensionAnalysisSession, loadUser } = extensionBridge();
    user = loadUser(username);
    const promptSeed = await buildWorldCupAgentPrompt({ ext_data_dir, message, display_name, reuse: false });
    created = createExtensionAnalysisSession({
      user,
      extensionName: EXTENSION_NAME,
      extensionDisplayName: '世界杯问AI',
      projectDescription: '2026 世界杯插件的 AI 问答与页面维护工作区。Agent 可以回答世界杯问题，也可以按用户要求修改 world-cup 插件。',
      issueTitle: '世界杯插件 AI 问答与维护',
      issueDescription: '接收世界赛事问答、素材更新、赛程新闻刷新、页面功能修改等任务。',
      sessionName: `世界杯问AI ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      sessionDescription: promptSeed,
      model: worldCupAgentModel(),
      language: 'zh',
    });
    session = created.session;
    sessionUrl = agentSessionUrl(user, created);
    await saveAgentState(ext_data_dir, {
      session_id: created.session.session_id,
      project_id: created.project.id,
      issue_id: created.issue.id,
      session_url: sessionUrl,
      model: created.session.model,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }

  const prompt = await buildWorldCupAgentPrompt({ ext_data_dir, message, display_name, reuse });
  const requestId = `world-cup-agent-${session.session_id}-${Date.now()}`;
  logger?.info?.(`world-cup agent queued: session=${session.session_id} request=${requestId}`);
  return {
    ok: true,
    async: true,
    status: 'queued',
    reply: '已发送到问AI。后台会在对应 Session 中回答；如果你要求修改插件，会直接处理 world-cup 插件文件。',
    session_id: session.session_id,
    project_id: session.project_id,
    issue_id: session.issue_id,
    session_url: sessionUrl,
    reused_session: reuse,
    agent_state: publicAgentState({
      session_id: session.session_id,
      project_id: session.project_id,
      issue_id: session.issue_id,
      session_url: sessionUrl,
      model: state.model,
      updated_at: nowIso(),
      created_at: state.created_at,
    }),
    __mobius_post_actions: [{
      type: 'session_message',
      session_id: session.session_id,
      project_id: session.project_id,
      content: prompt,
      input_text: message,
      request_id: requestId,
      source: 'extension.world-cup.agent_chat',
      result_key: 'backend_start',
    }],
  };
}

async function readWorldCupAgentStatus({ ext_data_dir }) {
  const state = await loadAgentState(ext_data_dir);
  if (!state?.session_id) {
    return { ok: true, has_session: false, status: 'idle', answer: '', agent_state: null };
  }
  let answer = '';
  let latest_at = '';
  try {
    const Messages = loadMessagesRepo();
    const recent = Messages.recentForTask(state.session_id, 100);
    const messages = Array.isArray(recent?.messages) ? recent.messages : [];
    latest_at = messages[messages.length - 1]?.created_at || '';
    for (const msg of messages.slice().reverse()) {
      answer = extractTaggedAnswer([
        msg.content,
        msg.tool_summary,
        msg.raw_event,
        msg.turn_summary,
        msg.text,
        msg.output_text,
        msg.summary,
      ].filter(Boolean).join('\n'));
      if (answer) break;
    }
    if (answer) {
      await saveAgentState(ext_data_dir, {
        ...state,
        latest_answer: answer,
        latest_answer_at: latest_at || nowIso(),
        updated_at: latest_at || nowIso(),
      });
    }
  } catch (e) {
    return {
      ok: true,
      has_session: true,
      status: 'unknown',
      answer: '',
      error: trimText(e.message || e, 300),
      agent_state: publicAgentState(state),
    };
  }
  return {
    ok: true,
    has_session: true,
    status: answer || state.latest_answer ? 'answered' : 'running',
    answer: answer || state.latest_answer || '',
    latest_at,
    agent_state: publicAgentState({
      ...state,
      latest_answer: answer || state.latest_answer || '',
      latest_answer_at: answer ? (latest_at || nowIso()) : (state.latest_answer_at || ''),
      updated_at: latest_at || state.updated_at,
    }),
  };
}

// ----- 占位 / 示例数据（兜底） -----

function placeholderContent() {
  // 仅在所有真实源失败、且没有任何旧数据时使用，每条都标 sample:true
  const ts = nowIso();
  return [
    {
      id: 'sample-1',
      dedupe_key: 'sample-fifa-overview',
      title: 'FIFA 世界杯概述（示例数据）',
      summary: 'FIFA 世界杯是全球国家队最高荣誉的足球赛事，每四年举办一次。2026 年由加拿大、墨西哥、美国联合主办，48 队参赛，赛程覆盖 6 月 11 日至 7 月 19 日。',
      url: 'https://www.fifa.com/fifaplus/en/tournaments/mens/worldcup/canadamexicousa2026',
      image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6e/FIFA_World_Cup_Trophy.jpg/1280px-FIFA_World_Cup_Trophy.jpg',
      image_license: '© FIFA / Wikimedia',
      source: '示例数据',
      source_id: 'sample',
      ts,
      relevance: 5,
      first_seen_at: ts,
      fetched_at: ts,
      sample: true,
    },
    {
      id: 'sample-2',
      dedupe_key: 'sample-host-cities',
      title: '2026 东道主：加拿大 · 墨西哥 · 美国（示例数据）',
      summary: '2026 世界杯为史上首次三国联办，比赛分布在 16 座城市：加拿大 2 城、墨西哥 3 城、美国 11 城。决赛将在纽约大都会体育场举行。',
      url: 'https://en.wikipedia.org/wiki/2026_FIFA_World_Cup',
      image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/MetLife_Stadium_%28cropped%29.jpg/1280px-MetLife_Stadium_%28cropped%29.jpg',
      image_license: '© Wikimedia Commons',
      source: '示例数据',
      source_id: 'sample',
      ts,
      relevance: 3,
      first_seen_at: ts,
      fetched_at: ts,
      sample: true,
    },
    {
      id: 'sample-3',
      dedupe_key: 'sample-format',
      title: '赛制：48 队 · 12 组 · 32 强淘汰（示例数据）',
      summary: '2026 起世界杯扩军至 48 支球队，分为 12 个小组每组 4 队。各组前 2 名 + 8 个成绩最佳的第 3 名晋级 32 强，淘汰赛轮次扩展为 5 轮。',
      url: 'https://en.wikipedia.org/wiki/2026_FIFA_World_Cup#Format',
      image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/42/Soccer_ball.svg/512px-Soccer_ball.svg.png',
      image_license: '© Wikimedia Commons / Public Domain',
      source: '示例数据',
      source_id: 'sample',
      ts,
      relevance: 2,
      first_seen_at: ts,
      fetched_at: ts,
      sample: true,
    },
  ];
}

// ----- 同步 -----

async function doSync({ ext_data_dir, logger, force }) {
  const newsFile = path.join(ext_data_dir, 'news.json');
  const stateFile = path.join(ext_data_dir, 'sync_state.json');
  const logFile = path.join(ext_data_dir, 'sync_log.jsonl');

  const existing = await readJson(newsFile, []);
  const existingMap = new Map();
  for (const item of existing) existingMap.set(item.dedupe_key, item);

  const fetchedRaw = [];
  const sourceResults = [];
  // 并发抓取（每源 4s × 2 尝试 = ≤8s；并发总时长受单源最大值约束）
  const results = await Promise.allSettled(
    RSS_SOURCES.map(async (source) => {
      const raw = await fetchWithRetries(source.url, logger);
      return { source, items: parseFeed(raw, source).slice(0, PER_SOURCE_LIMIT) };
    })
  );
  for (let i = 0; i < RSS_SOURCES.length; i++) {
    const source = RSS_SOURCES[i];
    const r = results[i];
    if (r.status === 'fulfilled') {
      for (const it of r.value.items) fetchedRaw.push(it);
      sourceResults.push({ id: source.id, name: source.name, ok: true, items: r.value.items.length });
      logger?.info(`rss ok: ${source.id} items=${r.value.items.length}`);
    } else {
      const msg = String(r.reason?.message || r.reason || 'unknown');
      sourceResults.push({ id: source.id, name: source.name, ok: false, error: msg.slice(0, 200) });
      logger?.warn(`rss fail: ${source.id} — ${msg}`);
    }
  }

  // 合并：新抓回的覆盖旧条目的 fetched_at；relevance 取最大；其余字段保留较新的 fetched
  for (const raw of fetchedRaw) {
    const norm = normalizeItem(raw);
    const prev = existingMap.get(norm.dedupe_key);
    if (prev) {
      existingMap.set(norm.dedupe_key, {
        ...prev,
        ...norm,
        relevance: Math.max(prev.relevance || 0, norm.relevance),
        first_seen_at: prev.first_seen_at,
        fetched_at: nowIso(),
        sample: false,
      });
    } else {
      existingMap.set(norm.dedupe_key, norm);
    }
  }

  let merged = Array.from(existingMap.values());
  // 排序：sample 沉到底部；其余优先中文/世界杯相关，再按时间倒序
  merged.sort((a, b) => {
    if (!!a.sample !== !!b.sample) return a.sample ? 1 : -1;
    const rel = (b.relevance || 0) - (a.relevance || 0);
    if (rel) return rel;
    return (b.ts || '').localeCompare(a.ts || '');
  });

  const okCount = sourceResults.filter((s) => s.ok).length;
  const degraded = okCount === 0;

  if (merged.length === 0) {
    // 全源失败且无历史 → 兜底占位
    merged = placeholderContent();
    logger?.warn('all sources failed AND no cached news; using placeholder seed');
  } else if (degraded) {
    // 全源失败但有旧数据 → 保留旧数据，标记 degraded
    logger?.warn('all sources failed; keeping cached news');
  }

  // 落地前裁剪到上限（保留 sample 兜底）
  const capped = merged.slice(0, MAX_NEWS_ITEMS);

  await writeJson(newsFile, capped);
  const state = {
    last_sync_at: nowIso(),
    last_sync_status: degraded ? 'degraded' : (okCount === RSS_SOURCES.length ? 'ok' : 'partial'),
    ok_sources: okCount,
    total_sources: RSS_SOURCES.length,
    cached_items: capped.length,
    degraded,
    sources: sourceResults,
  };
  await writeJson(stateFile, state);
  await appendSyncLog(logFile, {
    at: state.last_sync_at,
    status: state.last_sync_status,
    ok: okCount,
    total: RSS_SOURCES.length,
    fetched: fetchedRaw.length,
    kept: capped.length,
    forced: !!force,
  });
  return state;
}

// ----- 主 handler -----

module.exports = async function worldCupHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  logger,
}) {
  const action = ext_main_payload && ext_main_payload.action;

  try {
    if (action === 'whoami') {
      return { ok: true, username, display_name: display_name || username || '' };
    }

    if (action === 'sources_meta') {
      return {
        ok: true,
        sources: RSS_SOURCES.map((s) => ({
          id: s.id, name: s.name,
          // 不暴露 URL 到前端也没必要；这里给一份说明就够了
          kind: 'rss',
          license: '© ' + s.name + ' (公开 RSS，仅作标题/摘要导览，原文版权归原作者所有)',
        })),
      };
    }

    if (action === 'sync_now') {
      const state = await doSync({ ext_data_dir, logger, force: true });
      const [fixtureResult, scorerResult] = await Promise.all([
        readFixtures({
          ext_data_dir,
          logger,
          clientDate: ext_main_payload.client_date,
          force: true,
        }),
        readScorers({ ext_data_dir, logger, force: true }),
      ]);
      const newsFile = path.join(ext_data_dir, 'news.json');
      const news = await readJson(newsFile, []);
      const limit = clampInt(ext_main_payload.limit, 60, 1, 200);
      return {
        ok: true,
        news: Array.isArray(news) ? news.slice(0, limit) : [],
        total_cached: Array.isArray(news) ? news.length : 0,
        state,
        fixtures: fixtureResult.fixtures,
        fixtures_state: fixtureResult.state,
        scorers: scorerResult.scorers,
        scorers_state: scorerResult.state,
      };
    }

    if (action === 'ask_agent') {
      return await startWorldCupAgentChat({
        username,
        display_name,
        ext_data_dir,
        payload: ext_main_payload || {},
        logger,
      });
    }

    if (action === 'agent_status') {
      return await readWorldCupAgentStatus({ ext_data_dir });
    }

    if (action === 'read') {
      const newsFile = path.join(ext_data_dir, 'news.json');
      const stateFile = path.join(ext_data_dir, 'sync_state.json');
      let news = await readJson(newsFile, null);
      let state = await readJson(stateFile, null);
      if (news && state?.last_sync_at && !isFresh(state.last_sync_at, NEWS_REFRESH_MS)) {
        try {
          state = await doSync({ ext_data_dir, logger, force: false });
          news = await readJson(newsFile, []);
        } catch (e) {
          logger?.warn(`scheduled news refresh failed: ${e.message || e}`);
        }
      }
      if (!news || news.length === 0) {
        // 首次访问：先尝试同步，失败则用占位
        try {
          state = await doSync({ ext_data_dir, logger, force: false });
          news = await readJson(newsFile, []);
        } catch (e) {
          logger?.warn(`initial sync failed: ${e.message || e}`);
        }
        if (!news || news.length === 0) {
          news = placeholderContent();
          state = state || {
            last_sync_at: null,
            last_sync_status: 'never',
            degraded: true,
            ok_sources: 0,
            total_sources: RSS_SOURCES.length,
            cached_items: news.length,
            sources: [],
          };
        }
      }
      let fixtureResult;
      try {
        fixtureResult = await readFixtures({
          ext_data_dir,
          logger,
          clientDate: ext_main_payload.client_date,
          force: false,
        });
      } catch (e) {
        logger?.warn(`fixture read failed: ${e.message || e}`);
        fixtureResult = {
          fixtures: dynamicFallbackFixtures(ext_main_payload.client_date),
          state: {
            base_date: normalizeYmd(ext_main_payload.client_date),
            last_sync_at: null,
            source: '动态示意',
            ok_days: 0,
            total_days: 0,
            fetched_items: 0,
            degraded: true,
          },
        };
      }
      let scorerResult;
      try {
        scorerResult = await readScorers({
          ext_data_dir,
          logger,
          force: false,
        });
      } catch (e) {
        logger?.warn(`scorer read failed: ${e.message || e}`);
        scorerResult = {
          scorers: [],
          state: {
            season: 2026,
            last_sync_at: null,
            source: 'ESPN 2026 scoring stats',
            fetched_items: 0,
            degraded: true,
          },
        };
      }
      const limit = clampInt(ext_main_payload.limit, 60, 1, 200);
      const agentState = await loadAgentState(ext_data_dir);
      let publicAgent = publicAgentState(agentState);
      if (agentState?.session_id) {
        try {
          const status = await readWorldCupAgentStatus({ ext_data_dir });
          publicAgent = status.agent_state || publicAgent;
        } catch (e) {
          logger?.warn(`agent status scan during read failed: ${e.message || e}`);
        }
      }
      return {
        ok: true,
        news: news.slice(0, limit),
        total_cached: news.length,
        state,
        fixtures: fixtureResult.fixtures,
        fixtures_state: fixtureResult.state,
        scorers: scorerResult.scorers,
        scorers_state: scorerResult.state,
        agent_state: publicAgent,
        server_time: nowIso(),
      };
    }

    return { ok: false, error: 'unknown action' };
  } catch (e) {
    logger?.error(`handler error: ${e.stack || e.message || e}`);
    return { ok: false, error: 'internal error' };
  }
};
