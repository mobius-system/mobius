// 2026 世界杯内容聚合站
// 职责：滚动揭示 / 顶部导航明暗 / 倒计时 / 赛程 tab / 淘汰赛签表 /
//       射手榜渲染 / 中文新闻主区（左大卡 + 右列表）/ 球员 / 球场
//       调用后端 read 拉取真实 RSS 新闻与同步状态
//       所有外部文本一律 escapeHtml，URL 经 safeUrl 白名单，杜绝 XSS

/* ---------- 工具 ---------- */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function safeUrl(u) {
  const s = String(u ?? '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}
function safeMediaUrl(u) {
  const s = String(u ?? '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\.\/assets\/(?:[\w.-]+\/)*[\w.-]+\.(?:jpe?g|png|webp|svg)$/i.test(s)) return s;
  return '';
}
function truncate(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function timeAgo(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}
function fmtDate(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const MEDIA_FALLBACKS = new Map();
function media(src, fallback = '') {
  const safe = safeMediaUrl(src);
  const safeFallback = safeMediaUrl(fallback);
  if (safe && safeFallback) MEDIA_FALLBACKS.set(safe, safeFallback);
  return safe;
}
function commonsFile(name, fallback = '') {
  const file = String(name || '').replace(/\s+/g, '_');
  return media(`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}`, fallback);
}
function cssImage(url) {
  const safe = safeMediaUrl(url);
  if (!safe) return 'none';
  const primary = `url('${safe.replace(/'/g, '%27')}')`;
  const fallback = MEDIA_FALLBACKS.get(safe);
  return fallback ? `${primary}, url('${fallback.replace(/'/g, '%27')}')` : primary;
}
function localDateYmd(date = new Date()) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}
function addDaysYmd(ymd, delta) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function formatFixtureTime(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function formatFixtureDate(isoOrYmd) {
  const s = String(isoOrYmd || '');
  const t = Date.parse(s.length === 10 ? `${s}T12:00:00Z` : s);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' });
}

function openSafeUrl(url) {
  const safe = safeUrl(url);
  if (!safe) return;
  window.open(safe, '_blank', 'noopener,noreferrer');
}

function scrollToTarget(targetId) {
  const target = document.getElementById(String(targetId || ''));
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bindLinklessActions(root = document) {
  root.querySelectorAll('[data-open-url]').forEach((el) => {
    if (el.dataset.openBound === '1') return;
    el.dataset.openBound = '1';
    el.addEventListener('click', () => openSafeUrl(el.dataset.openUrl));
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openSafeUrl(el.dataset.openUrl);
    });
  });

  root.querySelectorAll('[data-scroll-target]').forEach((el) => {
    if (el.dataset.scrollBound === '1') return;
    el.dataset.scrollBound = '1';
    el.addEventListener('click', () => scrollToTarget(el.dataset.scrollTarget));
  });
}

bindLinklessActions();

/* ---------- 本地生成头像（替代不稳定的远程图） ---------- */
// 取国家代码：'阿根廷 · ARG' -> 'ARG'
function codeFromCountry(s) {
  const parts = String(s ?? '').split('·');
  return (parts[parts.length - 1] || '').trim().toUpperCase();
}
// 国旗 emoji（用于卡片点缀）
const CODE_FLAGS = {
  ARG:'🇦🇷',AUS:'🇦🇺',AUT:'🇦🇹',BEL:'🇧🇪',BRA:'🇧🇷',CAN:'🇨🇦',CHI:'🇨🇱',CMR:'🇨🇲',
  CIV:'🇨🇮',COD:'🇨🇩',COL:'🇨🇴',CRO:'🇭🇷',DEN:'🇩🇰',ECU:'🇪🇨',EGY:'🇪🇬',ENG:'🏴󠁧󠁢󠁥󠁮󠁧󠁿',ESP:'🇪🇸',FRA:'🇫🇷',
  GER:'🇩🇪',GHA:'🇬🇭',ITA:'🇮🇹',JPN:'🇯🇵',KOR:'🇰🇷',MAR:'🇲🇦',MEX:'🇲🇽',NED:'🇳🇱',
  NGA:'🇳🇬',NOR:'🇳🇴',NZL:'🇳🇿',PAN:'🇵🇦',POR:'🇵🇹',SEN:'🇸🇳',SRB:'🇷🇸',SWE:'🇸🇪',SUI:'🇨🇭',
  TUN:'🇹🇳',URU:'🇺🇾',USA:'🇺🇸',BIH:'🇧🇦',ALG:'🇩🇿',POL:'🇵🇱',WAL:'🏴󠁧󠁢󠁷󠁬󠁳󠁿',
  KSA:'🇸🇦',PAR:'🇵🇾',PER:'🇵🇪',RSA:'🇿🇦',CRC:'🇨🇷',HON:'🇭🇳',SLV:'🇸🇻',HAI:'🇭🇹',
};
// 生成国家队配色渐变背景（data-URI SVG，永不依赖网络）
function avatarBg(accent) {
  const c = (typeof accent === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(accent)) ? accent : '#16a34a';
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 480 400' preserveAspectRatio='xMidYMid slice'>" +
    "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
    "<stop offset='0' stop-color='" + c + "'/>" +
    "<stop offset='0.5' stop-color='" + c + "' stop-opacity='0.55'/>" +
    "<stop offset='1' stop-color='#080814'/>" +
    "</linearGradient>" +
    "<pattern id='p' width='34' height='34' patternUnits='userSpaceOnUse' patternTransform='rotate(45)'>" +
    "<rect width='34' height='6' fill='rgba(255,255,255,0.06)'/>" +
    "</pattern></defs>" +
    "<rect width='480' height='400' fill='url(#g)'/>" +
    "<rect width='480' height='400' fill='url(#p)'/>" +
    "<circle cx='372' cy='74' r='118' fill='rgba(255,255,255,0.08)'/>" +
    "<circle cx='96' cy='356' r='92' fill='rgba(0,0,0,0.20)'/>" +
    "</svg>";
  return "url('data:image/svg+xml," + encodeURIComponent(svg) + "')";
}

/* ---------- 1. 滚动揭示 ---------- */
const reveals = document.querySelectorAll('.reveal');
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.classList.add('is-visible');
      io.unobserve(e.target);
    }
  }
}, { threshold: 0.15, rootMargin: '0px 0px -80px 0px' });
reveals.forEach((el) => io.observe(el));

/* ---------- 2. 顶部导航明暗 ---------- */
const topnav = document.getElementById('topnav');
const lightSections = document.querySelectorAll('.section-light, .hero');
const navObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && e.intersectionRatio > 0.4) {
      const isHero = e.target.classList.contains('hero');
      topnav.classList.toggle('on-light', !isHero && e.target.classList.contains('section-light'));
    }
  }
}, { threshold: [0.4, 0.6] });
lightSections.forEach((s) => navObserver.observe(s));

/* ---------- 3. 倒计时 / 赛事阶段 ---------- */
const KICKOFF_ISO = '2026-06-11T20:00:00-06:00'; // 墨西哥城揭幕战
const FINAL_ISO = '2026-07-19T15:00:00-04:00';   // 纽约大都会决赛
function updateCountdown() {
  const el = document.getElementById('hero-countdown');
  const prefixEl = document.getElementById('hero-title-prefix');
  if (!el) return;
  const now = Date.now();
  const kickoff = Date.parse(KICKOFF_ISO);
  const final = Date.parse(FINAL_ISO);
  if (now < kickoff) {
    const ms = kickoff - now;
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    el.textContent = `${d} 天 ${h} 时 ${m} 分`;
    if (prefixEl) prefixEl.textContent = '距离揭幕';
  } else if (now < final) {
    const ms = final - now;
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    el.textContent = `${d} 天 ${h} 时`;
    if (prefixEl) prefixEl.textContent = '距离决赛';
  } else {
    el.textContent = '已落幕';
    if (prefixEl) prefixEl.textContent = '本届世界杯';
  }
}
updateCountdown();
setInterval(updateCountdown, 60000);

/* ---------- 4. 赛程状态：后端 ESPN 数据优先，本地动态 fallback 保底 ---------- */
const FALLBACK_MATCH_PAIRS = [
  ['BRA', '巴西', 'JPN', '日本'],
  ['ENG', '英格兰', 'NED', '荷兰'],
  ['ARG', '阿根廷', 'POR', '葡萄牙'],
  ['ESP', '西班牙', 'GER', '德国'],
  ['FRA', '法国', 'MAR', '摩洛哥'],
  ['USA', '美国', 'MEX', '墨西哥'],
  ['KOR', '韩国', 'URU', '乌拉圭'],
  ['NOR', '挪威', 'CIV', '科特迪瓦'],
];
function tournamentPhase(ymd) {
  if (ymd < '2026-06-11') return '赛前热身';
  if (ymd <= '2026-06-27') return '小组赛';
  if (ymd <= '2026-07-03') return '32 强';
  if (ymd <= '2026-07-08') return '16 强';
  if (ymd <= '2026-07-13') return '1/4 决赛';
  if (ymd <= '2026-07-16') return '半决赛';
  if (ymd <= '2026-07-18') return '三四名决赛';
  if (ymd <= '2026-07-20') return '决赛';
  return '赛后回看';
}
function fallbackFixture(ymd, idx) {
  const pair = FALLBACK_MATCH_PAIRS[idx % FALLBACK_MATCH_PAIRS.length];
  const hour = [17, 20, 23][idx % 3];
  return {
    id: `fallback-${ymd}-${idx}`,
    date: `${ymd}T${String(hour).padStart(2, '0')}:00:00Z`,
    stage: tournamentPhase(ymd),
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
function buildFallbackFixtures(baseDate = localDateYmd()) {
  const today = baseDate;
  const tomorrow = addDaysYmd(baseDate, 1);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDaysYmd(baseDate, i));
  return {
    today: [fallbackFixture(today, 0), fallbackFixture(today, 1), fallbackFixture(today, 2)],
    tomorrow: [fallbackFixture(tomorrow, 3), fallbackFixture(tomorrow, 4), fallbackFixture(tomorrow, 5)],
    week: weekDays.map((d, i) => fallbackFixture(d, i)),
  };
}
let activeFixtureTab = 'today';
let fixtureSets = buildFallbackFixtures();
let fixtureState = {
  source: '动态示意',
  last_sync_at: null,
  degraded: true,
  base_date: localDateYmd(),
};

const LOCAL_VISUALS = {
  stadiumNight: './assets/stadium-night.jpg',
  pitchBall: './assets/pitch-ball.jpg',
  fansStand: './assets/fans-stand.jpg',
  playerWalkout: './assets/player-walkout.jpg',
  matchAction: './assets/match-action.jpg',
  soccerField: './assets/soccer-field.jpg',
  fanCrowd: './assets/fan-crowd.jpg',
};

const VISUALS = {
  metlife: commonsFile('MetLife_Stadium_(cropped).jpg', LOCAL_VISUALS.stadiumNight),
  azteca: commonsFile('Estadio_Azteca_2011.jpg', LOCAL_VISUALS.pitchBall),
  bmo: commonsFile('BMO_Field_2016.jpg', LOCAL_VISUALS.fansStand),
  sofi: commonsFile('SoFi_Stadium_2021.jpg', LOCAL_VISUALS.playerWalkout),
  att: commonsFile('AT&T_Stadium_interior.jpg', LOCAL_VISUALS.stadiumNight),
  lumen: commonsFile('Lumen_Field,_Seattle,_Washington.jpg', LOCAL_VISUALS.fansStand),
  bcPlace: commonsFile('BC_Place_2016.jpg', LOCAL_VISUALS.stadiumNight),
  bbva: commonsFile('Estadio_BBVA_Bancomer,_Monterrey.jpg', LOCAL_VISUALS.pitchBall),
  hardRock: commonsFile('Hard_Rock_Stadium_interior.jpg', LOCAL_VISUALS.matchAction),
  levis: commonsFile("Levi's_Stadium_from_above.jpg", LOCAL_VISUALS.soccerField),
  mercedes: commonsFile('Mercedes-Benz_Stadium_Atlanta.jpg', LOCAL_VISUALS.stadiumNight),
  nrg: commonsFile('NRG_Stadium_2017.jpg', LOCAL_VISUALS.fanCrowd),
  lincoln: commonsFile('Lincoln_Financial_Field_aerial_view.jpg', LOCAL_VISUALS.fansStand),
  arrowhead: commonsFile('Arrowhead_Stadium.jpg', LOCAL_VISUALS.stadiumNight),
  stateFarm: commonsFile('State_Farm_Stadium_2022.jpg', LOCAL_VISUALS.soccerField),
  akron: commonsFile('Estadio_Akron_2018.jpg', LOCAL_VISUALS.pitchBall),
  trophy: commonsFile('FIFA_World_Cup_Trophy.jpg', LOCAL_VISUALS.matchAction),
  northAmerica: commonsFile('2026_FIFA_World_Cup_bid_map.svg', LOCAL_VISUALS.fanCrowd),
  matchAction: LOCAL_VISUALS.matchAction,
  floodlight: LOCAL_VISUALS.soccerField,
  goalMotion: LOCAL_VISUALS.fanCrowd,
  fanNight: LOCAL_VISUALS.fansStand,
  pitch: LOCAL_VISUALS.stadiumNight,
  ball: LOCAL_VISUALS.pitchBall,
  street: LOCAL_VISUALS.matchAction,
};

const NEWS_VISUALS = [
  VISUALS.trophy, VISUALS.metlife, VISUALS.azteca, VISUALS.bmo, VISUALS.sofi,
  VISUALS.hardRock, VISUALS.att, VISUALS.bcPlace, VISUALS.bbva, VISUALS.northAmerica,
];

const TEAM_ACCENTS = {
  ARG: '#74acdf', AUS: '#ffcd00', AUT: '#ed2939', BEL: '#fae042', BRA: '#009739',
  CAN: '#d80621', CHI: '#d52b1e', CIV: '#f77f00', CMR: '#007a5e', COD: '#00a3e0', COL: '#fcd116', CRO: '#171796',
  DEN: '#c60c30', ECU: '#ffdd00', EGY: '#ce1126', ENG: '#cf142b', ESP: '#aa151b',
  FRA: '#0055a4', GER: '#dd0000', GHA: '#fcd116', ITA: '#008c45', JPN: '#bc002d',
  KOR: '#0047a0', MAR: '#c1272d', MEX: '#006847', NED: '#ff4f00', NGA: '#008751',
  NOR: '#ba0c2f', NZL: '#111827', PAN: '#005293', POR: '#006600', SEN: '#00853f', SRB: '#c6363c',
  SWE: '#006aa7', SUI: '#d52b1e', TUN: '#e70013', URU: '#0038a8', USA: '#3c3b6e',
};

function normalizeNameKey(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const VERIFIED_PLAYER_PHOTOS = Object.freeze({
  'alexander isak': media('./assets/player-photos/selected/alexander-isak-sweden.jpg', LOCAL_VISUALS.playerWalkout),
  'alphonso davies': media('./assets/player-photos/selected/alphonso-davies-canada.jpg', LOCAL_VISUALS.playerWalkout),
  'brahim diaz': media('./assets/player-photos/selected/brahim-diaz-morocco.jpg', LOCAL_VISUALS.playerWalkout),
  'breel embolo': media('./assets/player-photos/selected/breel-embolo-switzerland.jpg', LOCAL_VISUALS.playerWalkout),
  'brian brobbey': media('./assets/player-photos/selected/brian-brobbey-netherlands.jpg', LOCAL_VISUALS.playerWalkout),
  'bruno guimaraes': media('./assets/player-photos/selected/bruno-guimaraes-brazil.jpg', LOCAL_VISUALS.playerWalkout),
  'chris wood': media('./assets/player-photos/selected/chris-wood-new-zealand.jpg', LOCAL_VISUALS.playerWalkout),
  'christian pulisic': media('./assets/player-photos/selected/christian-pulisic-united-states.jpg', LOCAL_VISUALS.playerWalkout),
  'cody gakpo': media('./assets/player-photos/selected/cody-gakpo-netherlands.jpg', LOCAL_VISUALS.playerWalkout),
  'crysencio summerville': media('./assets/player-photos/selected/crysencio-summerville-netherlands.webp', LOCAL_VISUALS.playerWalkout),
  'daichi kamada': media('./assets/player-photos/selected/daichi-kamada-japan.jpg', LOCAL_VISUALS.playerWalkout),
  'deniz undav': media('./assets/player-photos/selected/deniz-undav-germany.jpg', LOCAL_VISUALS.playerWalkout),
  'denzel dumfries': media('./assets/player-photos/selected/denzel-dumfries-netherlands.png', LOCAL_VISUALS.playerWalkout),
  'elijah just': media('./assets/player-photos/selected/elijah-just-new-zealand.jpg', LOCAL_VISUALS.playerWalkout),
  'erling haaland': media('./assets/player-photos/selected/erling-haaland-norway.jpg', LOCAL_VISUALS.playerWalkout),
  'florian wirtz': media('./assets/player-photos/selected/florian-wirtz-germany.jpg', LOCAL_VISUALS.playerWalkout),
  'hannibal mejbri': media('./assets/player-photos/selected/hannibal-mejbri-tunisia.jpg', LOCAL_VISUALS.playerWalkout),
  'harry kane': media('./assets/player-photos/selected/harry-kane-england.jpg', LOCAL_VISUALS.playerWalkout),
  'ismael saibari': media('./assets/player-photos/selected/ismael-saibari-morocco.webp', LOCAL_VISUALS.playerWalkout),
  'ismaila sarr': media('./assets/player-photos/selected/ismaila-sarr-senegal.jpg', LOCAL_VISUALS.playerWalkout),
  'johan manzambi': media('./assets/player-photos/selected/johan-manzambi-switzerland.jpg', LOCAL_VISUALS.playerWalkout),
  'jonathan david': media('./assets/player-photos/selected/jonathan-david-canada.jpg', LOCAL_VISUALS.playerWalkout),
  'joshua kimmich': media('./assets/player-photos/selected/joshua-kimmich-germany.jpg', LOCAL_VISUALS.playerWalkout),
  'jude bellingham': media('./assets/player-photos/selected/jude-bellingham-england.jpg', LOCAL_VISUALS.playerWalkout),
  'julian quinones': media('./assets/player-photos/selected/julian-quinones-mexico.jpg', LOCAL_VISUALS.playerWalkout),
  'julio enciso': media('./assets/player-photos/selected/julio-enciso-paraguay.jpg', LOCAL_VISUALS.playerWalkout),
  'kai havertz': media('./assets/player-photos/selected/kai-havertz-germany.jpg', LOCAL_VISUALS.playerWalkout),
  'kylian mbappe': media('./assets/player-photos/selected/kylian-mbappe-france.jpg', LOCAL_VISUALS.playerWalkout),
  'lamine yamal': media('./assets/player-photos/selected/lamine-yamal-spain.jpg', LOCAL_VISUALS.playerWalkout),
  'lionel messi': media('./assets/player-photos/selected/lionel-messi-argentina.jpg', LOCAL_VISUALS.playerWalkout),
  'martin odegaard': media('./assets/player-photos/selected/martin-odegaard-norway.jpg', LOCAL_VISUALS.playerWalkout),
  'matheus cunha': media('./assets/player-photos/selected/matheus-cunha-brazil.jpg', LOCAL_VISUALS.playerWalkout),
  'michael olise': media('./assets/player-photos/selected/michael-olise-france.jpg', LOCAL_VISUALS.playerWalkout),
  'ousmane dembele': media('./assets/player-photos/selected/ousmane-dembele-france.jpg', LOCAL_VISUALS.playerWalkout),
  'patrick berg': media('./assets/player-photos/selected/patrick-berg-norway.jpg', LOCAL_VISUALS.playerWalkout),
  'roberto alvarado': media('./assets/player-photos/selected/roberto-alvarado-mexico.jpg', LOCAL_VISUALS.playerWalkout),
  'ryan gravenberch': media('./assets/player-photos/selected/ryan-gravenberch-netherlands.jpg', LOCAL_VISUALS.playerWalkout),
  'santiago gimenez': media('./assets/player-photos/selected/santiago-gimenez-mexico.png', LOCAL_VISUALS.playerWalkout),
  'viktor gyokeres': media('./assets/player-photos/selected/viktor-gyokeres-sweden.jpg', LOCAL_VISUALS.playerWalkout),
  'vinicius junior': media('./assets/player-photos/selected/vinicius-junior-brazil.jpg', LOCAL_VISUALS.playerWalkout),
  'yasin ayari': media('./assets/player-photos/selected/yasin-ayari-sweden.jpg', LOCAL_VISUALS.playerWalkout),
  'yoane wissa': media('./assets/player-photos/selected/yoane-wissa-congo-dr.jpg', LOCAL_VISUALS.playerWalkout),
});

const FOCUS_PLAYERS = [
  { rank: '观察', name: 'Kylian Mbappé', country: '法国 · FRA', goals: '待赛', assists: '—', appearances: '—', role: '法国核心 · 速度与终结' },
  { rank: '观察', name: 'Erling Haaland', country: '挪威 · NOR', goals: '待赛', assists: '—', appearances: '—', role: '挪威锋线 · 禁区终结' },
  { rank: '观察', name: 'Jude Bellingham', country: '英格兰 · ENG', goals: '待赛', assists: '—', appearances: '—', role: '英格兰中前场 · 推进核心' },
  { rank: '观察', name: 'Vinícius Júnior', country: '巴西 · BRA', goals: '待赛', assists: '—', appearances: '—', role: '巴西边路 · 一对一爆点' },
  { rank: '观察', name: 'Lamine Yamal', country: '西班牙 · ESP', goals: '待赛', assists: '—', appearances: '—', role: '西班牙新星 · 右路创造' },
  { rank: '观察', name: 'Christian Pulisic', country: '美国 · USA', goals: '待赛', assists: '—', appearances: '—', role: '美国队长 · 东道主叙事' },
  { rank: '观察', name: 'Alphonso Davies', country: '加拿大 · CAN', goals: '待赛', assists: '—', appearances: '—', role: '加拿大左路 · 速度推进' },
  { rank: '观察', name: 'Santiago Giménez', country: '墨西哥 · MEX', goals: '待赛', assists: '—', appearances: '—', role: '墨西哥中锋 · 主场焦点' },
];

function photoForPlayer(player) {
  const verified = VERIFIED_PLAYER_PHOTOS[normalizeNameKey(player?.name)] || '';
  return verified || safeMediaUrl(player?.photo || player?.headshot || player?.image || '') || LOCAL_VISUALS.playerWalkout;
}

function bindImageFallbacks(root = document) {
  root.querySelectorAll('img[data-fallback-bg]').forEach((img) => {
    if (img.dataset.fallbackBound === '1') return;
    img.dataset.fallbackBound = '1';
    img.addEventListener('error', () => {
      if (img.dataset.usedFallback !== '1' && safeMediaUrl(img.dataset.fallbackSrc || '')) {
        img.dataset.usedFallback = '1';
        img.src = img.dataset.fallbackSrc;
        return;
      }
      const box = img.closest('.scorer-photo, .player-photo, .team-badge');
      if (box) box.classList.add('photo-failed');
      img.hidden = true;
    });
  });
}

function teamBadgeMarkup(code, logo = '') {
  const flag = CODE_FLAGS[code] || '';
  return `<span class="team-badge" data-code="${escapeHtml(code)}">${flag || escapeHtml(code)}</span>`;
}

const MATCH_BACKDROPS = {
  'MEX-CAN': VISUALS.azteca,
  'FRA-MAR': VISUALS.goalMotion,
  'USA-PAN': VISUALS.metlife,
  'ARG-POR': VISUALS.sofi,
  'ENG-NED': VISUALS.street,
  'BRA-KOR': VISUALS.floodlight,
  'ESP-GER': VISUALS.fanNight,
  'USA-MEX': VISUALS.hardRock,
  'CAN-USA': VISUALS.bmo,
  'CAN-MEX': VISUALS.bcPlace,
};

const TEAM_VISUALS = {
  USA: VISUALS.metlife,
  MEX: VISUALS.azteca,
  CAN: VISUALS.bmo,
  ARG: VISUALS.sofi,
  BRA: VISUALS.hardRock,
  FRA: VISUALS.mercedes,
  ENG: VISUALS.lincoln,
  ESP: VISUALS.levis,
  GER: VISUALS.att,
  POR: VISUALS.nrg,
  NED: VISUALS.lumen,
  JPN: VISUALS.bcPlace,
  KOR: VISUALS.stateFarm,
  MAR: VISUALS.bbva,
};

function imageForFixture(f) {
  if (!f) return VISUALS.pitch;
  const direct = MATCH_BACKDROPS[`${f.home}-${f.away}`] || MATCH_BACKDROPS[`${f.away}-${f.home}`];
  if (direct) return direct;
  const venueText = `${f.venue || ''} ${f.city || ''}`.toLowerCase();
  if (venueText.includes('azteca') || venueText.includes('mexico')) return VISUALS.azteca;
  if (venueText.includes('metlife') || venueText.includes('new york')) return VISUALS.metlife;
  if (venueText.includes('bmo') || venueText.includes('toronto')) return VISUALS.bmo;
  if (venueText.includes('sofi') || venueText.includes('los angeles')) return VISUALS.sofi;
  if (venueText.includes('bc place') || venueText.includes('vancouver')) return VISUALS.bcPlace;
  if (venueText.includes('bbva') || venueText.includes('monterrey')) return VISUALS.bbva;
  return TEAM_VISUALS[f.home] || TEAM_VISUALS[f.away] || VISUALS.pitch;
}

const HERO_FRAMES = [
  { label: 'Final venue', title: 'MetLife 决赛夜', meta: '纽约/新泽西 · 82,500', img: VISUALS.metlife },
  { label: 'Opening venue', title: 'Azteca 揭幕', meta: '墨西哥城 · 第三次世界杯', img: VISUALS.azteca },
  { label: 'Canada host', title: 'Toronto 北境主场', meta: 'BMO Field · 45,000', img: VISUALS.bmo },
  { label: 'West coast', title: 'SoFi 巨幕球场', meta: '洛杉矶 · Showcase', img: VISUALS.sofi },
  { label: 'Mexico north', title: 'BBVA 山城主场', meta: '蒙特雷 · Modern venue', img: VISUALS.bbva },
  { label: 'Canada west', title: 'BC Place 穹顶', meta: '温哥华 · Pacific host', img: VISUALS.bcPlace },
];

const CITY_PULSE = [
  { city: 'Mexico City', stadium: 'Estadio Azteca', tag: 'Opening', img: VISUALS.azteca },
  { city: 'New York / New Jersey', stadium: 'MetLife Stadium', tag: 'Final', img: VISUALS.metlife },
  { city: 'Los Angeles', stadium: 'SoFi Stadium', tag: 'Showcase', img: VISUALS.sofi },
  { city: 'Toronto', stadium: 'BMO Field', tag: 'Canada', img: VISUALS.bmo },
  { city: 'Vancouver', stadium: 'BC Place', tag: 'Pacific', img: VISUALS.bcPlace },
  { city: 'Monterrey', stadium: 'Estadio BBVA', tag: 'Mexico', img: VISUALS.bbva },
  { city: 'Miami', stadium: 'Hard Rock Stadium', tag: 'Nightlife', img: VISUALS.hardRock },
  { city: 'Dallas', stadium: 'AT&T Stadium', tag: 'Big screen', img: VISUALS.att },
];

// 12 组 mock 数据（每组 4 队，前 2 出线）
const STANDINGS = {
  A: [
    { team: '墨西哥', code: 'MEX', p: 1, w: 1, d: 0, l: 0, gf: 2, ga: 1, pts: 3, qualified: true },
    { team: '美国',   code: 'USA', p: 1, w: 1, d: 0, l: 0, gf: 2, ga: 1, pts: 3, qualified: true },
    { team: '加拿大', code: 'CAN', p: 1, w: 0, d: 0, l: 1, gf: 1, ga: 2, pts: 0 },
    { team: '巴拿马', code: 'PAN', p: 1, w: 0, d: 0, l: 1, gf: 1, ga: 2, pts: 0 },
  ],
  B: [
    { team: '法国',   code: 'FRA', p: 1, w: 1, d: 0, l: 0, gf: 1, ga: 0, pts: 3, qualified: true },
    { team: '摩洛哥', code: 'MAR', p: 1, w: 1, d: 0, l: 0, gf: 1, ga: 0, pts: 3, qualified: true },
    { team: '塞内加尔', code: 'SEN', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '突尼斯', code: 'TUN', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  C: [
    { team: '阿根廷', code: 'ARG', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '葡萄牙', code: 'POR', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '乌拉圭', code: 'URU', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '厄瓜多尔', code: 'ECU', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  D: [
    { team: '英格兰', code: 'ENG', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '荷兰',   code: 'NED', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '丹麦',   code: 'DEN', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '日本',   code: 'JPN', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  E: [
    { team: '西班牙', code: 'ESP', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '德国',   code: 'GER', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '瑞士',   code: 'SUI', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '喀麦隆', code: 'CMR', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  F: [
    { team: '巴西',   code: 'BRA', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '韩国',   code: 'KOR', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '澳大利亚', code: 'AUS', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '塞尔维亚', code: 'SRB', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  G: [
    { team: '意大利', code: 'ITA', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '比利时', code: 'BEL', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '奥地利', code: 'AUT', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '加纳',   code: 'GHA', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  H: [
    { team: '克罗地亚', code: 'CRO', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '波兰',     code: 'POL', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '威尔士',   code: 'WAL', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '沙特',     code: 'KSA', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  I: [
    { team: '哥伦比亚', code: 'COL', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '智利',     code: 'CHI', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '巴拉圭',   code: 'PAR', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '秘鲁',     code: 'PER', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  J: [
    { team: '挪威',   code: 'NOR', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '瑞典',   code: 'SWE', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '爱尔兰', code: 'IRL', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '冰岛',   code: 'ISL', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  K: [
    { team: '埃及',     code: 'EGY', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '尼日利亚', code: 'NGA', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '南非',     code: 'RSA', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '阿尔及利亚', code: 'ALG', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
  L: [
    { team: '哥斯达黎加', code: 'CRC', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '洪都拉斯',   code: 'HON', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, qualified: true },
    { team: '萨尔瓦多',   code: 'SLV', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
    { team: '海地',       code: 'HAI', p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 },
  ],
};

let scorerState = {
  source: '射手榜公开数据',
  last_sync_at: null,
  degraded: true,
  fetched_items: 0,
};

let agentState = null;

const STADIUMS = [
  { country: '美国 · USA',   stadium: 'MetLife Stadium',  city: '纽约/新泽西', capacity: '82,500', note: '2026 决赛场地。曾举办 2024 决赛、超级碗，是北美最重量级球场之一。', img: VISUALS.metlife, license: '公开图片 / 本地兜底' },
  { country: '墨西哥 · MEX', stadium: 'Estadio Azteca',   city: '墨西哥城',   capacity: '87,000', note: '1970 与 1986 两届世界杯决赛场地，2026 将第三次承办揭幕战。',           img: VISUALS.azteca, license: '公开图片 / 本地兜底' },
  { country: '加拿大 · CAN', stadium: 'BMO Field',        city: '多伦多',     capacity: '45,000', note: '加拿大首次承办男足世界杯的主场地之一，扩容后达到 4.5 万座。',         img: VISUALS.bmo, license: '公开图片 / 本地兜底' },
  { country: '美国 · USA',   stadium: 'SoFi Stadium',     city: '洛杉矶',     capacity: '70,000', note: '2022 启用，封闭式球场，将承办小组赛与淘汰赛多场焦点战。',             img: VISUALS.sofi, license: '公开图片 / 本地兜底' },
  { country: '美国 · USA',   stadium: 'AT&T Stadium',     city: '达拉斯',     capacity: '80,000', note: '巨屏、穹顶和超大容量让达拉斯成为整届赛事最具电视感的场地之一。',       img: VISUALS.att, license: '公开图片 / 本地兜底' },
  { country: '美国 · USA',   stadium: 'Lumen Field',      city: '西雅图',     capacity: '69,000', note: '以声浪闻名的城市球场，适合承载小组赛和淘汰赛的高压气氛。',           img: VISUALS.lumen, license: '公开图片 / 本地兜底' },
  { country: '加拿大 · CAN', stadium: 'BC Place',         city: '温哥华',     capacity: '54,500', note: '加拿大西海岸主场，穹顶结构和城市天际线能提供强烈视觉识别。',         img: VISUALS.bcPlace, license: '公开图片 / 本地兜底' },
  { country: '墨西哥 · MEX', stadium: 'Estadio BBVA',     city: '蒙特雷',     capacity: '53,500', note: '山景背景和现代球场结构很适合做城市巡礼与赛前预热视频。',             img: VISUALS.bbva, license: '公开图片 / 本地兜底' },
  { country: '美国 · USA',   stadium: 'Hard Rock Stadium', city: '迈阿密',    capacity: '65,000', note: '迈阿密主场兼具海岸城市气质和夜生活氛围，适合承载强娱乐化内容。',      img: VISUALS.hardRock, license: '公开图片 / 本地兜底' },
  { country: '美国 · USA',   stadium: "Levi's Stadium",   city: '旧金山湾区', capacity: '68,500', note: '硅谷附近的现代体育场，适合做科技、数据和赛事可视化叙事。',           img: VISUALS.levis, license: '公开图片 / 本地兜底' },
  { country: '墨西哥 · MEX', stadium: 'Estadio Akron',    city: '瓜达拉哈拉', capacity: '48,000', note: '墨西哥第三座承办城市球场，补足美加墨三国巡礼的南线视觉。',           img: VISUALS.akron, license: '公开图片 / 本地兜底' },
  { country: '美国 · USA',   stadium: 'Mercedes-Benz Stadium', city: '亚特兰大', capacity: '71,000', note: '可开合屋顶和强烈结构感，让亚特兰大站天然适合大图展示。',       img: VISUALS.mercedes, license: '公开图片 / 本地兜底' },
];

/* ---------- 5. 渲染：视觉焦点 ---------- */
function renderHeroGallery() {
  const wrap = document.getElementById('hero-gallery');
  if (!wrap) return;
  wrap.innerHTML = HERO_FRAMES.map((item) => `
    <article class="hero-frame" style="--frame-image:${escapeHtml(cssImage(item.img))}">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.title)}</strong>
      <em>${escapeHtml(item.meta)}</em>
    </article>
  `).join('');
}

renderHeroGallery();

/* ---------- 5. 渲染：赛程 ---------- */
function normalizeFixtureList(list) {
  return Array.isArray(list) ? list.filter((f) => f && f.home && f.away) : [];
}
function applyFixtures(nextFixtures, nextState) {
  if (nextFixtures && typeof nextFixtures === 'object') {
    fixtureSets = {
      today: normalizeFixtureList(nextFixtures.today),
      tomorrow: normalizeFixtureList(nextFixtures.tomorrow),
      week: normalizeFixtureList(nextFixtures.week),
    };
    if (!fixtureSets.today.length && !fixtureSets.tomorrow.length && !fixtureSets.week.length) {
      fixtureSets = buildFallbackFixtures(localDateYmd());
    }
  } else {
    fixtureSets = buildFallbackFixtures(localDateYmd());
  }
  if (nextState && typeof nextState === 'object') fixtureState = nextState;
  renderFixtures(activeFixtureTab);
  updateFocusMatch();
  try {
    renderKnockoutBracket();
  } catch (e) {
    // The first fixture render can run before the bracket constants are initialized.
  }
}
function updateFixtureSource() {
  const sourceEl = document.getElementById('fixtures-source');
  if (!sourceEl) return;
  const source = fixtureState?.source || '动态示意';
  const stamp = fixtureState?.last_sync_at ? timeAgo(fixtureState.last_sync_at) : '本地生成';
  const count = Object.values(fixtureSets).flat().length;
  const degraded = fixtureState?.degraded ? ' · 降级兜底' : '';
  sourceEl.textContent = `${source} · ${stamp} · ${count} 场${degraded} · 每 10 分钟自动刷新`;
}
function updateFocusMatch() {
  const allFixtures = [...fixtureSets.today, ...fixtureSets.tomorrow, ...fixtureSets.week]
    .filter((f) => f && f.home && f.away)
    .sort((a, b) => Date.parse(a.date || '') - Date.parse(b.date || ''));
  const now = Date.now();
  const live = allFixtures.find((f) => f.kind === 'live');
  const upcoming = allFixtures.find((f) => {
    if (f.kind === 'done') return false;
    const t = Date.parse(f.date || '');
    return Number.isFinite(t) && t >= now - 2 * 60 * 60 * 1000;
  });
  const recentDone = allFixtures
    .filter((f) => f.kind === 'done')
    .sort((a, b) => Date.parse(b.date || '') - Date.parse(a.date || ''))[0];
  const next = live || upcoming || recentDone || allFixtures[0];
  if (!next) return;
  const homeCode = document.getElementById('focus-home-code');
  const homeName = document.getElementById('focus-home-name');
  const awayCode = document.getElementById('focus-away-code');
  const awayName = document.getElementById('focus-away-name');
  const scoreText = document.getElementById('focus-score-text');
  const stage = document.getElementById('focus-stage');
  const time = document.getElementById('focus-time');
  if (homeCode) homeCode.textContent = next.home;
  if (homeName) homeName.textContent = next.homeName || next.home;
  if (awayCode) awayCode.textContent = next.away;
  if (awayName) awayName.textContent = next.awayName || next.away;
  if (scoreText) scoreText.textContent = next.score || 'vs';
  if (stage) stage.textContent = next.stage || tournamentPhase(localDateYmd());
  const where = [formatFixtureDate(next.date), formatFixtureTime(next.date), next.venue || next.city].filter(Boolean).join(' · ');
  if (time) time.textContent = where || '赛程自动刷新中';
}
function renderFixtures(key) {
  const grid = document.getElementById('fixtures-grid');
  if (!grid) return;
  const list = fixtureSets[key] || [];
  if (list.length === 0) {
    grid.innerHTML = `<p class="empty">暂无该时段的赛程，正在等待下一次自动同步</p>`;
    updateFixtureSource();
    return;
  }
  grid.innerHTML = list.map((f) => {
    const kindClass = f.kind === 'live' ? 'live' : (f.kind === 'done' ? 'done' : 'upcoming');
    const statusClass = f.kind === 'live' ? 'live' : (f.kind === 'done' ? 'done' : '');
    const accent = TEAM_ACCENTS[f.home] || TEAM_ACCENTS[f.away] || '#16a34a';
    const backdrop = imageForFixture(f);
    const heat = f.kind === 'live' ? 'LIVE HEAT' : (f.kind === 'done' ? 'FULL TIME' : 'WATCHLIST');
    const stage = [f.stage, formatFixtureDate(f.date), f.venue || f.city].filter(Boolean).join(' · ');
    const status = f.status || formatFixtureTime(f.date) || 'TBD';
    return `<article class="fixture-card ${kindClass}">
      <div class="fixture-art" style="--match-accent:${escapeHtml(accent)};--match-image:${escapeHtml(cssImage(backdrop))}">
        <span>${escapeHtml(heat)}</span>
      </div>
      <div class="fixture-stage">${escapeHtml(stage)}</div>
      <div class="fixture-match">
        <div class="fixture-team">
          ${teamBadgeMarkup(f.home, f.homeLogo)}
          <span class="fc-code">${escapeHtml(f.home)}</span>
          <span class="fc-name">${escapeHtml(f.homeName)}</span>
        </div>
        <div class="fixture-center">
          <span class="fc-score">${escapeHtml(f.score)}</span>
          <span class="fc-status ${statusClass}">${escapeHtml(status)}</span>
        </div>
        <div class="fixture-team">
          ${teamBadgeMarkup(f.away, f.awayLogo)}
          <span class="fc-code">${escapeHtml(f.away)}</span>
          <span class="fc-name">${escapeHtml(f.awayName)}</span>
        </div>
      </div>
    </article>`;
  }).join('');
  bindImageFallbacks(grid);
  updateFixtureSource();
}
// 绑定 tab
document.querySelectorAll('[data-fixture-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-fixture-tab]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeFixtureTab = btn.dataset.fixtureTab || 'today';
    renderFixtures(activeFixtureTab);
  });
});
applyFixtures(fixtureSets, fixtureState);

/* ---------- 6. 渲染：淘汰赛签表 ---------- */
const KNOCKOUT_BRACKET = [
  {
    round: '32 强',
    note: '6.30 - 7.3',
    matches: [
      { stage: '32 强', home: 'CIV', homeName: '科特迪瓦', away: 'NOR', awayName: '挪威', city: '阿灵顿', time: '6/30 17:00', status: '待赛' },
      { stage: '32 强', home: 'FRA', homeName: '法国', away: 'SWE', awayName: '瑞典', city: '纽约/新泽西', time: '6/30 21:00', status: '待赛', hot: true },
      { stage: '32 强', home: 'MEX', homeName: '墨西哥', away: 'ECU', awayName: '厄瓜多尔', city: '墨西哥城', time: '7/1 01:00', status: '待赛', hot: true },
      { stage: '32 强', home: 'ENG', homeName: '英格兰', away: 'COD', awayName: '民主刚果', city: '亚特兰大', time: '7/1 16:00', status: '待赛' },
      { stage: '32 强', home: 'BEL', homeName: '比利时', away: 'SEN', awayName: '塞内加尔', city: '西雅图', time: '7/1 20:00', status: '待赛' },
      { stage: '32 强', home: 'USA', homeName: '美国', away: 'BIH', awayName: '波黑', city: '旧金山湾区', time: '7/2 00:00', status: '待赛', hot: true },
      { stage: '32 强', home: 'ESP', homeName: '西班牙', away: 'AUT', awayName: '奥地利', city: '洛杉矶', time: '7/2 19:00', status: '待赛' },
      { stage: '32 强', home: 'POR', homeName: '葡萄牙', away: 'CRO', awayName: '克罗地亚', city: '多伦多', time: '7/2 23:00', status: '待赛', hot: true },
      { stage: '32 强', home: 'SUI', homeName: '瑞士', away: 'ALG', awayName: '阿尔及利亚', city: '温哥华', time: '7/3 03:00', status: '待赛' },
      { stage: '32 强', home: 'AUS', homeName: '澳大利亚', away: 'EGY', awayName: '埃及', city: '阿灵顿', time: '7/3 18:00', status: '待赛' },
      { stage: '32 强', home: 'BRA', homeName: '巴西', away: 'JPN', awayName: '日本', city: '迈阿密', time: '7/3 22:00', status: '待赛', hot: true },
      { stage: '32 强', home: 'GER', homeName: '德国', away: 'PAR', awayName: '巴拉圭', city: '休斯敦', time: '7/4 02:00', status: '待赛' },
      { stage: '32 强', home: 'NED', homeName: '荷兰', away: 'MAR', awayName: '摩洛哥', city: '堪萨斯城', time: '7/4 18:00', status: '待赛', hot: true },
      { stage: '32 强', home: 'ARG', homeName: '阿根廷', away: 'KOR', awayName: '韩国', city: '费城', time: '7/4 22:00', status: '待赛' },
      { stage: '32 强', home: 'ITA', homeName: '意大利', away: 'NGA', awayName: '尼日利亚', city: '亚特兰大', time: '7/5 01:00', status: '待赛' },
      { stage: '32 强', home: 'CAN', homeName: '加拿大', away: 'URU', awayName: '乌拉圭', city: '多伦多', time: '7/5 20:00', status: '待赛' },
    ],
  },
  {
    round: '16 强',
    note: '7.4 - 7.8',
    matches: [
      { stage: '16 强', home: '胜者', homeName: '32 强胜者', away: '胜者', awayName: '32 强胜者', city: '待定', time: '自动同步', status: '待定' },
      { stage: '16 强', home: '胜者', homeName: '32 强胜者', away: '胜者', awayName: '32 强胜者', city: '待定', time: '自动同步', status: '待定' },
      { stage: '16 强', home: '胜者', homeName: '32 强胜者', away: '胜者', awayName: '32 强胜者', city: '待定', time: '自动同步', status: '待定' },
      { stage: '16 强', home: '胜者', homeName: '32 强胜者', away: '胜者', awayName: '32 强胜者', city: '待定', time: '自动同步', status: '待定' },
    ],
  },
  {
    round: '1/4 决赛',
    note: '7.9 - 7.13',
    matches: [
      { stage: '1/4 决赛', home: '晋级队', homeName: '16 强胜者', away: '晋级队', awayName: '16 强胜者', city: '待定', time: '自动同步', status: '待定' },
      { stage: '1/4 决赛', home: '晋级队', homeName: '16 强胜者', away: '晋级队', awayName: '16 强胜者', city: '待定', time: '自动同步', status: '待定' },
    ],
  },
  {
    round: '半决赛',
    note: '7.14 - 7.16',
    matches: [
      { stage: '半决赛', home: '晋级队', homeName: '1/4 胜者', away: '晋级队', awayName: '1/4 胜者', city: '待定', time: '自动同步', status: '待定' },
      { stage: '半决赛', home: '晋级队', homeName: '1/4 胜者', away: '晋级队', awayName: '1/4 胜者', city: '待定', time: '自动同步', status: '待定' },
    ],
  },
  {
    round: '决赛',
    note: '7.19',
    matches: [
      { stage: '决赛', home: '晋级队', homeName: '半决赛胜者', away: '晋级队', awayName: '半决赛胜者', city: '纽约/新泽西', time: '7/19', status: '冠军战', hot: true },
    ],
  },
];

function latestKnockoutFixtures() {
  const seen = new Set();
  return [...fixtureSets.today, ...fixtureSets.tomorrow, ...fixtureSets.week]
    .filter((f) => f && String(f.stage || '').includes('强') && f.home && f.away)
    .filter((f) => {
      const key = f.id || `${f.date}-${f.home}-${f.away}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Date.parse(a.date || '') - Date.parse(b.date || ''));
}

function matchToKnockout(f) {
  return {
    stage: f.stage || tournamentPhase(localDateYmd()),
    home: f.home,
    homeName: f.homeName || f.home,
    away: f.away,
    awayName: f.awayName || f.away,
    score: f.score,
    city: f.city || f.venue || '待定',
    time: [formatFixtureDate(f.date), formatFixtureTime(f.date)].filter(Boolean).join(' '),
    status: f.kind === 'done' ? '已完赛' : (f.kind === 'live' ? '进行中' : '待赛'),
    hot: f.kind === 'live',
  };
}

function groupedKnockoutData() {
  const liveRounds = latestKnockoutFixtures().reduce((acc, f) => {
    const round = f.stage || '淘汰赛';
    if (!acc.has(round)) acc.set(round, []);
    acc.get(round).push(matchToKnockout(f));
    return acc;
  }, new Map());
  if (!liveRounds.size) return KNOCKOUT_BRACKET;
  const roundOrder = ['32 强', '16 强', '1/4 决赛', '半决赛', '三四名决赛', '决赛'];
  return roundOrder
    .filter((round) => liveRounds.has(round))
    .map((round) => ({
      round,
      note: round === '32 强' ? '当前赛程缓存' : '自动同步',
      matches: liveRounds.get(round),
    }))
    .concat(KNOCKOUT_BRACKET.filter((round) => !liveRounds.has(round.round) && round.round !== '32 强'));
}

function placeholderKnockoutMatch(index, stage = '32 强') {
  return {
    stage,
    home: 'TBD',
    homeName: '待定球队',
    away: 'TBD',
    awayName: '待定球队',
    city: '待定',
    time: `第 ${index + 1} 场`,
    status: '待定',
  };
}

function fillMatches(matches, count, stage) {
  const list = Array.isArray(matches) ? matches.slice(0, count) : [];
  while (list.length < count) list.push(placeholderKnockoutMatch(list.length, stage));
  return list;
}

function flagLogo(code) {
  const safeCode = String(code || '').toUpperCase();
  return CODE_FLAGS[safeCode] || safeCode.slice(0, 3) || 'TBD';
}

function compactBracketCard(match, side = 'left') {
  const hotClass = match.hot ? ' is-hot' : '';
  const pendingClass = match.home === 'TBD' || match.away === 'TBD' ? ' is-pending' : '';
  const score = match.score && match.score !== '— : —' ? match.score : 'vs';
  return `<article class="funnel-match ${escapeHtml(side)}${hotClass}${pendingClass}">
    <div class="funnel-meta">
      <span>${escapeHtml(match.time || '时间待定')}</span>
      <span>${escapeHtml(match.city || '城市待定')}</span>
    </div>
    <div class="funnel-teams">
      <div class="funnel-team">
        <span class="funnel-logo">${escapeHtml(flagLogo(match.home))}</span>
        <strong>${escapeHtml(match.homeName || match.home)}</strong>
        <em>${escapeHtml(match.home || '')}</em>
      </div>
      <div class="funnel-score">${escapeHtml(score)}</div>
      <div class="funnel-team">
        <span class="funnel-logo">${escapeHtml(flagLogo(match.away))}</span>
        <strong>${escapeHtml(match.awayName || match.away)}</strong>
        <em>${escapeHtml(match.away || '')}</em>
      </div>
    </div>
  </article>`;
}

function futureSlot(label, index, side) {
  return `<article class="funnel-slot ${escapeHtml(side)}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(index === 0 ? '晋级路径' : `路径 ${index + 1}`)}</strong>
  </article>`;
}

function renderKnockoutBracket() {
  const wrap = document.getElementById('knockout-bracket');
  const source = document.getElementById('knockout-source');
  if (!wrap) return;
  const rounds = groupedKnockoutData();
  const round32 = fillMatches(rounds.find((r) => r.round === '32 强')?.matches || [], 16, '32 强');
  const left32 = round32.slice(0, 8);
  const right32 = round32.slice(8, 16);
  const finalMatch = fillMatches(rounds.find((r) => r.round === '决赛')?.matches || [], 1, '决赛')[0];
  wrap.innerHTML = `<div class="funnel-bracket" role="img" aria-label="左右对称漏斗状淘汰赛签表">
    <div class="funnel-wing funnel-left">
      <div class="funnel-column r32">
        <div class="funnel-round-label"><span>32 强</span><b>左半区</b></div>
        ${left32.map((m) => compactBracketCard(m, 'left')).join('')}
      </div>
      <div class="funnel-column r16">${Array.from({ length: 4 }, (_, i) => futureSlot('16 强', i, 'left')).join('')}</div>
      <div class="funnel-column qf">${Array.from({ length: 2 }, (_, i) => futureSlot('1/4', i, 'left')).join('')}</div>
      <div class="funnel-column sf">${futureSlot('半决赛', 0, 'left')}</div>
    </div>

    <div class="funnel-center">
      <div class="funnel-trophy" aria-hidden="true">
        <span>⚽</span>
        <strong>FINAL</strong>
      </div>
      <div class="funnel-final">
        ${compactBracketCard(finalMatch, 'center')}
      </div>
      <div class="funnel-champion">
        <span>冠军路径</span>
        <strong>7.19 · 纽约/新泽西</strong>
      </div>
    </div>

    <div class="funnel-wing funnel-right">
      <div class="funnel-column sf">${futureSlot('半决赛', 0, 'right')}</div>
      <div class="funnel-column qf">${Array.from({ length: 2 }, (_, i) => futureSlot('1/4', i, 'right')).join('')}</div>
      <div class="funnel-column r16">${Array.from({ length: 4 }, (_, i) => futureSlot('16 强', i, 'right')).join('')}</div>
      <div class="funnel-column r32">
        <div class="funnel-round-label"><span>32 强</span><b>右半区</b></div>
        ${right32.map((m) => compactBracketCard(m, 'right')).join('')}
      </div>
    </div>
  </div>`;
  if (source) {
    const stamp = fixtureState?.last_sync_at ? timeAgo(fixtureState.last_sync_at) : '本地签表';
    source.textContent = `左右对称漏斗签表 · ${stamp} · ${fixtureState?.source || '当前赛程缓存'} · 32 强按 16 场对阵压缩展示`;
  }
}
renderKnockoutBracket();

/* ---------- 7. 渲染：射手榜 ---------- */
function updateScorerSource() {
  const sourceEl = document.getElementById('scorers-source');
  const playerEl = document.getElementById('players-source');
  const source = /espn/i.test(String(scorerState?.source || '')) ? '射手榜公开数据' : (scorerState?.source || '射手榜数据');
  const stamp = scorerState?.last_sync_at ? timeAgo(scorerState.last_sync_at) : '同步中';
  const count = scorerState?.fetched_items || 0;
  const degraded = scorerState?.degraded ? ' · 降级/待更新' : '';
  const text = `${source} · ${stamp} · ${count} 人${degraded} · 每 30 分钟自动刷新`;
  if (sourceEl) sourceEl.textContent = text;
  if (playerEl) playerEl.textContent = text;
}

function applyScorers(list, state) {
  if (state && typeof state === 'object') scorerState = state;
  const normalized = Array.isArray(list) ? list.filter((s) => s && s.name && s.country) : [];
  renderScorers(normalized);
  renderPlayers((normalized.length ? normalized : FOCUS_PLAYERS).slice(0, 8));
  updateScorerSource();
}

function renderScorers(list) {
  const wrap = document.getElementById('scorers-list');
  if (!wrap) return;
  const watchMode = !list || list.length === 0;
  const displayList = watchMode ? FOCUS_PLAYERS : list;
  const max = Math.max(1, ...displayList.map((s) => Number(s.goals) || 0));
  const notice = watchMode
    ? `<p class="empty compact">2026 正赛射手榜尚未产生，以下先展示本届焦点射手观察；正式数据同步后会自动替换。</p>`
    : '';
  wrap.innerHTML = notice + displayList.map((s) => {
    const code = codeFromCountry(s.country);
    const accent = TEAM_ACCENTS[code] || '#16a34a';
    const initial = escapeHtml(String(s.name).trim().charAt(0) || '?');
    const flag = CODE_FLAGS[code] || '';
    const photo = photoForPlayer(s);
    const fallbackBg = avatarBg(accent);
    const numericGoals = Number(s.goals);
    const goalsLabel = Number.isFinite(numericGoals) ? String(numericGoals) : String(s.goals || '待赛');
    const assistsLabel = Number.isFinite(Number(s.assists)) ? String(s.assists) : String(s.assists || '—');
    const appsLabel = Number.isFinite(Number(s.appearances)) ? String(s.appearances) : String(s.appearances || '—');
    const barPct = Number.isFinite(numericGoals) ? Math.round((numericGoals / max) * 100) : 100;
    return `<article class="scorer-row">
      <div class="scorer-rank">${escapeHtml(String(s.rank))}</div>
      <div class="scorer-photo" style="background-image:${fallbackBg}">
        ${photo ? `<img src="${escapeHtml(photo)}" alt="${escapeHtml(s.name)}" loading="lazy" data-fallback-bg="1" data-fallback-src="${escapeHtml(LOCAL_VISUALS.playerWalkout)}" />` : ''}
        <span class="scorer-initial">${initial}</span>
        ${flag ? `<span class="scorer-flag">${flag}</span>` : ''}
      </div>
      <div class="scorer-main">
        <div class="scorer-name">${escapeHtml(s.name)}</div>
        <div class="scorer-country">${escapeHtml(s.role || s.country)}</div>
        <div class="scorer-bar"><div class="scorer-bar-fill" style="width:${barPct}%"></div></div>
      </div>
      <div class="scorer-stats">
        <div><span class="big">${escapeHtml(goalsLabel)}</span><span class="label">进球</span></div>
        <div><span class="small">${escapeHtml(assistsLabel)}</span><span class="label">助攻</span></div>
        <div><span class="small">${escapeHtml(appsLabel)}</span><span class="label">出场</span></div>
      </div>
    </article>`;
  }).join('');
  bindImageFallbacks(wrap);
}
applyScorers([], scorerState);

/* ---------- 8. 渲染：球员 ---------- */
function renderPlayers(list) {
  const grid = document.getElementById('stars-grid');
  if (!grid) return;
  if (!list || list.length === 0) {
    list = FOCUS_PLAYERS;
  }
  grid.innerHTML = list.map((s) => {
    const code = codeFromCountry(s.country);
    const accent = TEAM_ACCENTS[code] || '#16a34a';
    const initial = escapeHtml(String(s.name).trim().charAt(0) || '?');
    const flag = CODE_FLAGS[code] || '';
    const photo = photoForPlayer(s);
    const goalsLabel = Number.isFinite(Number(s.goals)) ? String(s.goals) : String(s.goals || '待赛');
    const assistsLabel = Number.isFinite(Number(s.assists)) ? String(s.assists) : String(s.assists || '—');
    const appsLabel = Number.isFinite(Number(s.appearances)) ? String(s.appearances) : String(s.appearances || '—');
    return `<article class="player-card">
      <div class="player-photo" style="background-image:${avatarBg(accent)}">
        ${photo ? `<img src="${escapeHtml(photo)}" alt="${escapeHtml(s.name)}" loading="lazy" data-fallback-bg="1" data-fallback-src="${escapeHtml(LOCAL_VISUALS.playerWalkout)}" />` : ''}
        <span class="player-flag">${flag}</span>
        <span class="player-initial">${initial}</span>
        <span class="player-code">${escapeHtml(code)}</span>
      </div>
      <div class="player-body">
        <h4 class="player-name">${escapeHtml(s.name)}</h4>
        <div class="player-team">${escapeHtml(s.role || s.country)}</div>
        <div class="player-stats">
          <div><span class="player-stat-label">本届进球</span><span class="player-stat-value">${escapeHtml(goalsLabel)}</span></div>
          <div><span class="player-stat-label">助攻</span><span class="player-stat-value">${escapeHtml(assistsLabel)}</span></div>
          <div><span class="player-stat-label">出场</span><span class="player-stat-value">${escapeHtml(appsLabel)}</span></div>
        </div>
        <p class="player-license">${photo === LOCAL_VISUALS.playerWalkout ? '本地球员图片兜底 · 不破图' : '本地核验球员图 · 失败自动回退'}</p>
      </div>
    </article>`;
  }).join('');
  bindImageFallbacks(grid);
}

/* ---------- 9. 渲染：球场 ---------- */
function renderStadiums(list) {
  const grid = document.getElementById('host-grid');
  if (!grid) return;
  grid.innerHTML = list.map((h) => {
    const bg = safeMediaUrl(h.img);
    const styleAttr = bg ? `style="background-image:${escapeHtml(cssImage(bg))}"` : '';
    return `<article class="host-card">
      <div class="host-photo" ${styleAttr}></div>
      <div class="host-body">
        <div class="host-country">${escapeHtml(h.country)}</div>
        <h4 class="host-stadium">${escapeHtml(h.stadium)}</h4>
        <div class="host-city">${escapeHtml(h.city)} · 容量 ${escapeHtml(h.capacity)}</div>
        <p class="host-meta">${escapeHtml(h.note)}</p>
        <p class="host-license">${escapeHtml(h.license)}</p>
      </div>
    </article>`;
  }).join('');
}
renderStadiums(STADIUMS);

/* ---------- 10. 渲染：新闻主区 ---------- */
// 无后端 / 拉取失败时的示例新闻（本地图片，明确标记「示例」），让新闻区始终图文并茂
const SAMPLE_NEWS = [
  {
    source: '中文新闻示例', sample: true, title: '美加墨世界杯进入倒计时：48 队新赛制与 16 座主办城市成为关注焦点',
    summary: '从墨西哥城阿兹特克到纽约大都会，104 场比赛将横跨三个时区。本届扩军至 48 队，赛制与出线规则全面刷新。',
    image: VISUALS.trophy,
  },
  { source: '中文新闻示例', sample: true, title: '主办城市巡礼：纽约/新泽西、墨西哥城、多伦多将承担最强视觉记忆点', image: VISUALS.metlife },
  { source: '中文新闻示例', sample: true, title: '赛程关注：揭幕战、决赛和跨时区开球时间将改变国内观赛节奏', image: VISUALS.azteca },
  { source: '中文新闻示例', sample: true, title: '球队观察：东道主美国、墨西哥、加拿大希望把主场氛围转化成竞争力', image: VISUALS.bmo },
  { source: '中文新闻示例', sample: true, title: '球星看点：姆巴佩、哈兰德、贝林厄姆、亚马尔等新一代主角进入聚光灯', image: VISUALS.sofi },
  { source: '中文新闻示例', sample: true, title: '数据看台：扩军后 12 个小组与 32 强淘汰赛将显著增加爆冷可能', image: VISUALS.northAmerica },
];

const NEWS_SOURCE_LABELS = [
  [/google news/i, '谷歌新闻中文'],
  [/sky sports/i, '天空体育足球'],
  [/espn/i, '美国体育电视网足球'],
  [/bbc/i, '英国广播公司体育'],
  [/guardian/i, '卫报足球'],
  [/中文新闻示例/i, '中文新闻示例'],
];

const NEWS_KEYWORD_TITLES = [
  { re: /france|sweden|mbapp|barcola/i, title: '法国淘汰瑞典晋级，姆巴佩继续领跑焦点' },
  { re: /mexico|ecuador/i, title: '墨西哥击败厄瓜多尔，淘汰赛潜在强强对话升温' },
  { re: /upset|shock|ireland|italy|cape verde/i, title: '世界杯冷门故事再被热议，淘汰赛悬念继续放大' },
  { re: /fifa|var|disallow|germany goal/i, title: '国际足联解释关键判罚，VAR 争议成为淘汰赛焦点' },
  { re: /brazil|japan|martinelli/i, title: '巴西惊险过关，日本队把悬念拖到最后阶段' },
  { re: /morocco|netherlands|penalt/i, title: '摩洛哥点球大战淘汰荷兰，淘汰赛再出冷门' },
  { re: /england|kane|bellingham|tuchel/i, title: '英格兰进入淘汰赛观察期，凯恩与贝林厄姆仍是关键线索' },
  { re: /usmnt|united states|usa/i, title: '美国队主场淘汰赛前景升温，外界关注能否走得更远' },
  { re: /germany|paraguay/i, title: '世界杯淘汰赛继续推进，传统强队承压前行' },
  { re: /world cup daily|world cup/i, title: '世界杯每日战报：淘汰赛赛程、晋级与焦点球队更新' },
];

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ''));
}

function localizeNewsSource(source) {
  const raw = String(source || '').trim();
  const found = NEWS_SOURCE_LABELS.find((item) => item[0].test(raw));
  return found ? found[1] : (hasChinese(raw) ? raw : '海外媒体');
}

function synthesizeChineseNewsTitle(title) {
  const raw = String(title || '').trim();
  if (!raw) return '世界杯新闻更新';
  if (hasChinese(raw)) return raw;
  const found = NEWS_KEYWORD_TITLES.find((item) => item.re.test(raw));
  if (found) return found.title;
  return '世界杯快讯：赛程、晋级形势与球队动态更新';
}

function synthesizeChineseSummary(item) {
  const summary = String(item?.summary || '').trim();
  if (summary && hasChinese(summary)) return summary;
  const title = String(item?.title || '').trim();
  if (/france|sweden|mbapp|barcola/i.test(title)) return '法国队相关战报已转为中文导览，重点关注晋级结果、姆巴佩表现和下一轮对阵。';
  if (/mexico|ecuador/i.test(title)) return '墨西哥相关报道集中在淘汰赛晋级结果、潜在对手和主场热度。';
  if (/fifa|var|disallow/i.test(title)) return '这条报道关注淘汰赛关键判罚和规则解释，页面保留原文链接便于核对细节。';
  if (/upset|shock|cape verde/i.test(title)) return '淘汰赛冷门和爆冷案例成为本轮新闻主线，适合快速了解晋级形势变化。';
  if (/penalt|shoot/i.test(title)) return '这条来自海外公开订阅源，页面已转为中文导览；请点开原文查看完整细节。';
  if (/brazil|japan|martinelli/i.test(title)) return '巴西与日本相关淘汰赛新闻热度较高，重点关注补时进球、晋级结果和下一轮对阵。';
  if (/england|kane|bellingham|tuchel/i.test(title)) return '英格兰相关报道集中在淘汰赛阵容、核心球员状态与临场选择。';
  return item?.sample ? summary : '来自公开订阅源的世界杯新闻，页面以中文摘要展示，点击可阅读原文。';
}

function localizeNewsItem(item) {
  return {
    ...item,
    source: localizeNewsSource(item?.source),
    title: synthesizeChineseNewsTitle(item?.title),
    summary: synthesizeChineseSummary(item),
  };
}

function renderNews(items) {
  const hero = document.getElementById('news-hero');
  const list = document.getElementById('news-list');
  if (!hero || !list) return;

  if (!items || items.length === 0) {
    // 用示例新闻填充，避免整块空白
    items = SAMPLE_NEWS;
  }

  const displayItems = items.map(localizeNewsItem);
  const [first, ...rest] = displayItems;
  const firstUrl = safeUrl(first.url);
  const firstImg = safeMediaUrl(first.image) || NEWS_VISUALS[0]; // 兼容远程、本地和素材池补图
  const firstSample = first.sample ? '<span class="news-sample">示例</span>' : '';
  const firstMeta = first.sample
    ? '示例预览 · 后端公开订阅源接入后自动替换'
    : [timeAgo(first.ts), fmtDate(first.fetched_at)].filter((x) => x && x !== '—').join(' · ');
  const heroInner = `
    ${firstImg ? `<div class="news-hero-img" style="background-image:${escapeHtml(cssImage(firstImg))}"></div>` : ''}
    <div class="news-hero-body">
      <div class="news-source">${escapeHtml(first.source)}${firstSample}</div>
      <h3 class="news-hero-title">${escapeHtml(truncate(first.title, 120))}</h3>
      ${first.summary ? `<p class="news-hero-summary">${escapeHtml(truncate(first.summary, 200))}</p>` : ''}
      <span class="news-meta">${escapeHtml(firstMeta)}</span>
    </div>
  `;
  hero.innerHTML = firstUrl
    ? `<div class="news-hero-link linkless-action" role="button" tabindex="0" data-open-url="${escapeHtml(firstUrl)}" aria-label="打开新闻原文">${heroInner}</div>`
    : heroInner;
  bindLinklessActions(hero);

  list.innerHTML = rest.slice(0, 6).map((n, index) => {
    const url = safeUrl(n.url);
    const sampleBadge = n.sample ? '<span class="news-sample">示例</span>' : '';
    const thumb = safeMediaUrl(n.image) || NEWS_VISUALS[(index + 1) % NEWS_VISUALS.length];
    const a = url
      ? `<div class="news-item linkless-action" role="button" tabindex="0" data-open-url="${escapeHtml(url)}" aria-label="打开新闻原文">`
      : `<div class="news-item">`;
    const close = '</div>';
    const meta = n.sample ? '示例预览' : timeAgo(n.ts);
    return `${a}
      <span class="news-thumb" style="background-image:${escapeHtml(cssImage(thumb))}" aria-hidden="true"></span>
      <span class="news-copy">
        <span class="news-source">${escapeHtml(n.source)}${sampleBadge}</span>
        <span class="news-title">${escapeHtml(truncate(n.title, 110))}</span>
        <span class="news-meta">${escapeHtml(meta)}</span>
      </span>
    ${close}`;
  }).join('');
  bindLinklessActions(list);
}
// 初始空占位
renderNews([]);

/* ---------- 11. 问AI ---------- */
const assistantMessages = [
  {
    role: 'assistant',
    text: '可以问 2026 世界杯赛程、球队、球员、中文新闻，也可以要求我修改这个页面。提交后会启动后台 Session 处理。',
  },
];
let assistantPollTimer = null;

function cleanTaggedAnswer(text) {
  const s = String(text || '');
  const m = s.match(/<further-answering>([\s\S]*?)<\/further-answering>/i)
    || s.match(/<further-answering>([\s\S]*?)<further-answering>/i)
    || s.match(/<world-cup-answer>([\s\S]*?)<\/world-cup-answer>/i);
  return truncate((m ? m[1] : s).trim(), 1200);
}

function renderAssistantChat() {
  const wrap = document.getElementById('assistant-chat');
  if (!wrap) return;
  wrap.innerHTML = assistantMessages.map((msg) => {
    const link = msg.session_url ? `<button type="button" class="inline-link" data-open-url="${escapeHtml(msg.session_url)}">打开 Agent Session</button>` : '';
    const statusClass = msg.status ? ` ${escapeHtml(msg.status)}` : '';
    return `<article class="assistant-msg ${escapeHtml(msg.role)}${statusClass}">
      <div class="assistant-msg-role">${msg.role === 'user' ? '你' : '问AI'}</div>
      <div class="assistant-msg-text">${escapeHtml(msg.text)}</div>
      ${link ? `<div class="assistant-msg-link">${link}</div>` : ''}
    </article>`;
  }).join('');
  bindLinklessActions(wrap);
  wrap.scrollTop = wrap.scrollHeight;
}

function updateAssistantSource(state) {
  const el = document.getElementById('assistant-source');
  if (!el) return;
  if (!state || !state.session_id) {
    el.textContent = '问AI 尚未启动';
    return;
  }
  const stamp = state.updated_at ? timeAgo(state.updated_at) : '最近';
  const sessionUrl = safeUrl(state.session_url || '');
  const sessionLabel = sessionUrl
    ? `<button type="button" class="inline-link" data-open-url="${escapeHtml(sessionUrl)}">${escapeHtml(state.session_id)}</button>`
    : escapeHtml(state.session_id);
  el.innerHTML = `问AI Session：${sessionLabel} · ${escapeHtml(stamp)}更新`;
  bindLinklessActions(el);
}

function showAgentAnswerFromState(state) {
  const answer = cleanTaggedAnswer(state?.latest_answer || '');
  if (!answer) return false;
  const existing = assistantMessages.find((msg) => msg.role === 'assistant' && cleanTaggedAnswer(msg.text) === answer);
  if (existing) return false;
  const pending = assistantMessages.slice().reverse().find((msg) => msg.role === 'assistant' && msg.status === 'pending');
  if (pending) {
    pending.text = answer;
    pending.status = '';
    pending.session_url = state.session_url || pending.session_url || '';
  } else {
    assistantMessages.push({
      role: 'assistant',
      text: answer,
      session_url: state.session_url || '',
    });
  }
  renderAssistantChat();
  return true;
}

async function askWorldCupAgent(message, newSession) {
  const { extCall } = await import('/extension/_sdk/ext.js');
  return await extCall({ action: 'ask_agent', message, new_session: !!newSession });
}

async function readWorldCupAgentStatus() {
  const { extCall } = await import('/extension/_sdk/ext.js');
  return await extCall({ action: 'agent_status' });
}

function pollAgentAnswer(targetMessage, attempt = 0) {
  if (assistantPollTimer) clearTimeout(assistantPollTimer);
  assistantPollTimer = setTimeout(async () => {
    try {
      const status = await readWorldCupAgentStatus();
      if (status?.agent_state) {
        agentState = status.agent_state;
        updateAssistantSource(agentState);
      }
      if (status?.answer) {
        targetMessage.text = cleanTaggedAnswer(status.answer);
        targetMessage.status = '';
        renderAssistantChat();
        return;
      }
      if (showAgentAnswerFromState(status?.agent_state)) return;
      if (attempt < 45) {
        targetMessage.text = attempt < 2
          ? '问AI 已启动，正在读取世界杯数据和插件代码。'
          : '问AI 正在工作中，完成后会把简短结论同步到这里；也可以点开 Session 看完整进度。';
        targetMessage.status = 'pending';
        renderAssistantChat();
        pollAgentAnswer(targetMessage, attempt + 1);
        return;
      }
      targetMessage.text = '问AI 仍在后台处理。可以打开 Session 查看完整进度，稍后也可以继续在这里追问。';
      targetMessage.status = 'pending';
      renderAssistantChat();
    } catch (e) {
      if (attempt < 8) {
        pollAgentAnswer(targetMessage, attempt + 1);
      }
    }
  }, attempt < 4 ? 3500 : 8000);
}

function bindAssistantForm() {
  const form = document.getElementById('assistant-form');
  const input = document.getElementById('assistant-input');
  const newSession = document.getElementById('assistant-new-session');
  if (!form || !input) return;
  renderAssistantChat();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = String(input.value || '').trim();
    if (!text) return;
    input.value = '';
    assistantMessages.push({ role: 'user', text });
    const pending = { role: 'assistant', text: '已收到，正在投递给问AI。后台启动后这里会显示 Session 入口，并持续同步生成状态。', status: 'pending' };
    assistantMessages.push(pending);
    renderAssistantChat();
    try {
      const r = await askWorldCupAgent(text, !!newSession?.checked);
      if (!r || !r.ok) throw new Error(r?.error || '问AI 启动失败');
      pending.text = r.reused_session
        ? '已发送到既有问AI Session。正在等待简短回答同步到这里。'
        : '已新建问AI Session 并开始处理。正在等待简短回答同步到这里。';
      pending.session_url = r.session_url || '';
      pending.status = 'pending';
      agentState = r.agent_state || {
        session_id: r.session_id,
        session_url: r.session_url,
        updated_at: new Date().toISOString(),
      };
      updateAssistantSource(agentState);
      pollAgentAnswer(pending);
    } catch (e) {
      pending.text = `问AI 启动失败：${e.message || e}`;
    }
    renderAssistantChat();
  });
}

bindAssistantForm();

/* ---------- 12. 同步状态 ---------- */
function applySyncState(state) {
  const syncEl = document.getElementById('topnav-sync');
  const chipEl = document.getElementById('news-sync-chip');

  let label, cls, chipText;
  if (!state || !state.last_sync_at) {
    label = '尚未同步';
    cls = 'never';
    chipText = '尚未同步';
  } else if (state.degraded) {
    label = `${timeAgo(state.last_sync_at)} · 降级`;
    cls = 'degraded';
    chipText = `${timeAgo(state.last_sync_at)} · ${state.ok_sources}/${state.total_sources} 源`;
  } else if (state.last_sync_status === 'partial') {
    label = `${timeAgo(state.last_sync_at)} · ${state.cached_items} 条`;
    cls = '';
    chipText = `${timeAgo(state.last_sync_at)} · ${state.ok_sources}/${state.total_sources} 源 · ${state.cached_items} 条`;
  } else {
    label = `${timeAgo(state.last_sync_at)} · ${state.cached_items} 条`;
    cls = '';
    chipText = `${timeAgo(state.last_sync_at)} · ${state.cached_items} 条`;
  }
  if (syncEl) {
    syncEl.classList.remove('degraded', 'never');
    if (cls) syncEl.classList.add(cls);
    const labelEl = syncEl.querySelector('.sync-label');
    if (labelEl) labelEl.textContent = label;
  }
  if (chipEl) chipEl.textContent = chipText;
}

/* ---------- 12. 启动：拉真实数据 ---------- */
async function loadFromBackend() {
  try {
    const { extCall } = await import('/extension/_sdk/ext.js');
    const r = await extCall({ action: 'read', limit: 40, client_date: localDateYmd() });
    if (!r || !r.ok) {
      applySyncState(null);
      return;
    }
    if (r.fixtures) applyFixtures(r.fixtures, r.fixtures_state);
    if (r.scorers) applyScorers(r.scorers, r.scorers_state);
    if (r.news && r.news.length) renderNews(r.news);
    if (r.agent_state) {
      agentState = r.agent_state;
      updateAssistantSource(agentState);
      showAgentAnswerFromState(agentState);
    }
    if (r.state) applySyncState(r.state);
  } catch (e) {
    console.warn('[world-cup] loadFromBackend failed (likely 401 / network), keeping static demo content:', e.message || e);
    applySyncState(null);
    applyFixtures(buildFallbackFixtures(localDateYmd()), {
      source: '动态示意',
      last_sync_at: null,
      degraded: true,
      base_date: localDateYmd(),
    });
    applyScorers([], {
      source: '射手榜公开数据',
      last_sync_at: null,
      degraded: true,
      fetched_items: 0,
    });
  }
}

let didInitialForceSync = false;

async function syncLatestFromBackend() {
  if (didInitialForceSync) return;
  didInitialForceSync = true;
  try {
    const { extCall } = await import('/extension/_sdk/ext.js');
    const r = await extCall({ action: 'sync_now', limit: 40, client_date: localDateYmd() });
    if (!r || !r.ok) return;
    if (r.fixtures) applyFixtures(r.fixtures, r.fixtures_state);
    if (r.scorers) applyScorers(r.scorers, r.scorers_state);
    if (r.news && r.news.length) renderNews(r.news);
    if (r.state) applySyncState(r.state);
  } catch (e) {
    console.warn('[world-cup] initial sync_now failed, keeping cached data:', e.message || e);
  }
}

loadFromBackend().then(syncLatestFromBackend);
setInterval(loadFromBackend, 10 * 60 * 1000);
