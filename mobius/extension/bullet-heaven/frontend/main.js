import { extCall } from '/extension/_sdk/ext.js';

const CONFIG = Object.freeze({
  duration: 150,
  bossAt: 112,
  maxEnemies: 900,
  maxBullets: 1600,
  maxHostiles: 520,
  maxParticles: 2200,
  maxPickups: 420,
  cellSize: 76,
});
const COOLDOWN_KEYS = Object.freeze(['horde', 'overdrive', 'elite', 'nuke']);
const MAX_SHOCKWAVES = 192;
const MAX_BEAMS = 384;

const ENEMY_TYPES = Object.freeze({
  grunt: { frame: 0, hp: 1, speed: 1, radius: 16, damage: 9, score: 11, xp: 1, color: '#85ef72' },
  runner: { frame: 1, hp: 0.56, speed: 1.9, radius: 13, damage: 8, score: 15, xp: 1, color: '#ff9e42' },
  tank: { frame: 2, hp: 4.8, speed: 0.56, radius: 24, damage: 17, score: 32, xp: 3, color: '#a984ff' },
  splitter: { frame: 0, hp: 2.2, speed: 0.92, radius: 20, damage: 12, score: 24, xp: 2, color: '#4cf1c5' },
  shooter: { frame: 3, hp: 3.2, speed: 0.68, radius: 20, damage: 11, score: 38, xp: 3, color: '#e96cff' },
  elite: { frame: 3, hp: 13, speed: 0.8, radius: 31, damage: 24, score: 180, xp: 12, color: '#ff5fa0' },
  boss: { frame: 4, hp: 1, speed: 0.43, radius: 74, damage: 38, score: 20000, xp: 80, color: '#ff3d60' },
});

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const els = {
  shell: document.getElementById('gameShell'),
  level: document.getElementById('levelValue'),
  kills: document.getElementById('killsValue'),
  combo: document.getElementById('comboValue'),
  time: document.getElementById('timeValue'),
  score: document.getElementById('scoreValue'),
  hpFill: document.getElementById('hpFill'),
  hpText: document.getElementById('hpText'),
  xpFill: document.getElementById('xpFill'),
  xpText: document.getElementById('xpText'),
  arsenalList: document.getElementById('arsenalList'),
  damageStat: document.getElementById('damageStat'),
  rateStat: document.getElementById('rateStat'),
  shotStat: document.getElementById('shotStat'),
  speedStat: document.getElementById('speedStat'),
  soundBtn: document.getElementById('soundBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  directorPanel: document.getElementById('directorPanel'),
  directorToggle: document.getElementById('directorToggle'),
  hordeBtn: document.getElementById('hordeBtn'),
  overdriveBtn: document.getElementById('overdriveBtn'),
  eliteBtn: document.getElementById('eliteBtn'),
  nukeBtn: document.getElementById('nukeBtn'),
  autoPick: document.getElementById('autoPickInput'),
  bossHud: document.getElementById('bossHud'),
  bossName: document.getElementById('bossName'),
  bossHpText: document.getElementById('bossHpText'),
  bossHpFill: document.getElementById('bossHpFill'),
  toast: document.getElementById('toast'),
  banner: document.getElementById('banner'),
  damageFlash: document.getElementById('damageFlash'),
  startOverlay: document.getElementById('startOverlay'),
  upgradeOverlay: document.getElementById('upgradeOverlay'),
  pauseOverlay: document.getElementById('pauseOverlay'),
  resultOverlay: document.getElementById('resultOverlay'),
  startBtn: document.getElementById('startBtn'),
  resumeBtn: document.getElementById('resumeBtn'),
  restartBtn: document.getElementById('restartBtn'),
  againBtn: document.getElementById('againBtn'),
  menuBtn: document.getElementById('menuBtn'),
  upgradeOptions: document.getElementById('upgradeOptions'),
  upgradeCountdown: document.getElementById('upgradeCountdown'),
  leaderboardList: document.getElementById('leaderboardList'),
  identityValue: document.getElementById('identityValue'),
  resultEyebrow: document.getElementById('resultEyebrow'),
  resultTitle: document.getElementById('resultTitle'),
  resultDescription: document.getElementById('resultDescription'),
  finalScore: document.getElementById('finalScore'),
  finalKills: document.getElementById('finalKills'),
  finalLevel: document.getElementById('finalLevel'),
  finalRank: document.getElementById('finalRank'),
  newBest: document.getElementById('newBestBadge'),
  moveStick: document.getElementById('moveStick'),
  aimStick: document.getElementById('aimStick'),
};

let width = 1280;
let height = 720;
let dpr = 1;
let nextEnemyId = 1;
let rafId = 0;
let autoPickTimer = 0;
let toastTimer = 0;
let audioCtx = null;
let muted = localStorage.getItem('bullet-heaven-muted') === '1';
let lastRenderTs = 0;

const spriteFrames = [];
const atlas = new Image();
atlas.decoding = 'async';
atlas.addEventListener('load', () => {
  for (let frame = 0; frame < 5; frame += 1) {
    const raster = document.createElement('canvas');
    raster.width = 224;
    raster.height = 288;
    const rasterCtx = raster.getContext('2d');
    rasterCtx.imageSmoothingEnabled = true;
    rasterCtx.imageSmoothingQuality = 'high';
    rasterCtx.drawImage(atlas, frame * 280, 0, 280, 360, 0, 0, raster.width, raster.height);
    spriteFrames[frame] = raster;
  }
});
atlas.src = '/extension/toy-toy-toy/assets/characters/zombie-atlas.svg?v=0.8.2';

const input = {
  keys: new Set(),
  pointerX: width * 0.7,
  pointerY: height * 0.5,
  pointerActive: false,
  moveX: 0,
  moveY: 0,
  aimX: 1,
  aimY: 0,
};

const state = {
  mode: 'menu',
  elapsed: 0,
  score: 0,
  kills: 0,
  combo: 0,
  maxCombo: 0,
  comboTimer: 0,
  level: 1,
  xp: 0,
  nextXp: 14,
  pendingLevelUps: 0,
  hp: 100,
  maxHp: 100,
  armor: 0,
  regen: 0,
  damage: 18,
  fireRate: 12,
  bulletSpeed: 760,
  bulletSize: 4.2,
  moveSpeed: 260,
  multishot: 1,
  spread: 0.105,
  pierce: 0,
  critChance: 0.06,
  critDamage: 2,
  explosion: 0,
  chain: 0,
  frost: 0,
  ricochet: 0,
  drones: 0,
  orbit: 0,
  missile: 0,
  lifesteal: 0,
  pickupRange: 90,
  overdriveUntil: 0,
  hordeUntil: 0,
  invulnerableUntil: 0,
  fireAccumulator: 0,
  spawnAccumulator: 0,
  droneAccumulator: 0,
  missileAccumulator: 0,
  healAccumulator: 0,
  supplyAt: 16,
  bossSpawned: false,
  bossKilled: false,
  boss: null,
  shake: 0,
  flash: 0,
  hitStop: 0,
  lastTs: 0,
  uiAccumulator: 0,
  cooldowns: { horde: 0, overdrive: 0, elite: 0, nuke: 0 },
  upgradeLevels: {},
  enemies: [],
  bullets: [],
  hostileBullets: [],
  pickups: [],
  particles: [],
  shockwaves: [],
  beams: [],
  floaters: [],
  stars: [],
  player: { x: width * 0.5, y: height * 0.55, vx: 0, vy: 0, angle: 0, radius: 16, dashTime: 0, dashCooldown: 0, dashX: 1, dashY: 0 },
};

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function rand(min, max) { return min + Math.random() * (max - min); }
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
function distanceSq(ax, ay, bx, by) { const dx = ax - bx; const dy = ay - by; return dx * dx + dy * dy; }
function formatNumber(value) { return Math.round(value).toLocaleString('zh-CN'); }
function formatCompact(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return Math.round(value).toString();
}

function compactInPlace(list, keep) {
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < list.length; readIndex += 1) {
    const item = list[readIndex];
    if (!keep(item)) continue;
    if (writeIndex !== readIndex) list[writeIndex] = item;
    writeIndex += 1;
  }
  list.length = writeIndex;
}

class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
    this.activeKeys = [];
  }

  key(cellX, cellY) {
    return (cellX << 16) ^ (cellY & 0xffff);
  }

  clear() {
    for (const key of this.activeKeys) this.cells.get(key).length = 0;
    this.activeKeys.length = 0;
  }

  rebuild(enemies) {
    this.clear();
    for (const enemy of enemies) {
      if (enemy.dead) continue;
      const cellX = Math.floor(enemy.x / this.cellSize);
      const cellY = Math.floor(enemy.y / this.cellSize);
      const key = this.key(cellX, cellY);
      let cell = this.cells.get(key);
      if (!cell) {
        cell = [];
        this.cells.set(key, cell);
      }
      if (cell.length === 0) this.activeKeys.push(key);
      cell.push(enemy);
    }
  }

  visit(x, y, radius, visitor) {
    const range = Math.ceil(radius / this.cellSize);
    const cellX = Math.floor(x / this.cellSize);
    const cellY = Math.floor(y / this.cellSize);
    for (let dx = -range; dx <= range; dx += 1) {
      for (let dy = -range; dy <= range; dy += 1) {
        const cell = this.cells.get(this.key(cellX + dx, cellY + dy));
        if (!cell) continue;
        for (const enemy of cell) {
          if (visitor(enemy) === false) return false;
        }
      }
    }
    return true;
  }
}

const enemyGrid = new SpatialGrid(CONFIG.cellSize);
const projectileDrawBatches = new Map();
const activeProjectileDrawBatches = [];

function ensureAudio() {
  if (muted) return null;
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { audioCtx = null; }
  }
  if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function tone(freq, duration = 0.06, type = 'square', gain = 0.025, slide = 0) {
  const audio = ensureAudio();
  if (!audio) return;
  const now = audio.currentTime;
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), now + duration);
  amp.gain.setValueAtTime(gain, now);
  amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(amp).connect(audio.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

function showToast(message, duration = 2500) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('visible');
  toastTimer = window.setTimeout(() => els.toast.classList.remove('visible'), duration);
}

function showBanner(message, color = '#ffe45c') {
  els.banner.textContent = message;
  els.banner.style.color = color;
  els.banner.classList.remove('visible');
  void els.banner.offsetWidth;
  els.banner.classList.add('visible');
}

function setMode(mode) {
  state.mode = mode;
  els.shell.dataset.state = mode;
  els.startOverlay.classList.toggle('visible', mode === 'menu');
  els.upgradeOverlay.classList.toggle('visible', mode === 'upgrade');
  els.pauseOverlay.classList.toggle('visible', mode === 'paused');
  els.resultOverlay.classList.toggle('visible', mode === 'result');
  els.pauseBtn.textContent = mode === 'paused' ? '继续' : '暂停';
}

function resize() {
  width = Math.max(320, window.innerWidth);
  height = Math.max(520, window.innerHeight);
  // 高密度弹幕的清晰度主要来自亮线叠加，1× 内部分辨率能显著降低低端 GPU / 软件栅格压力。
  dpr = 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.player.x = clamp(state.player.x || width * 0.5, 35, width - 35);
  state.player.y = clamp(state.player.y || height * 0.55, 105, height - 35);
  if (!state.stars.length) {
    for (let i = 0; i < 120; i += 1) state.stars.push({ x: Math.random(), y: Math.random(), size: rand(0.5, 1.8), phase: rand(0, Math.PI * 2) });
  }
}

const UPGRADES = [
  { id: 'damage', icon: '▰', name: '口径膨胀', color: '#ffe45c', max: 8, desc: '每一发子弹伤害提高 32%，所有副武器也会一起变凶。', apply: () => { state.damage *= 1.32; } },
  { id: 'rate', icon: '»', name: '射速失控', color: '#70fff1', max: 8, desc: '基础射速提高 24%，弹道开始连成一条发光长河。', apply: () => { state.fireRate *= 1.24; } },
  { id: 'multishot', icon: '⑶', name: '扇形齐射', color: '#ff8ccf', max: 8, desc: '每次开火额外增加一枚弹丸，最多形成九重弹幕。', apply: () => { state.multishot += 1; } },
  { id: 'pierce', icon: '⇥', name: '无限穿透', color: '#7df6a5', max: 6, desc: '子弹可以继续贯穿一名敌人，专治扎堆尸潮。', apply: () => { state.pierce += 1; } },
  { id: 'crit', icon: '※', name: '红字暴击', color: '#ff5d79', max: 6, desc: '暴击率提高 9%，暴击倍率也会逐级上涨。', apply: () => { state.critChance += 0.09; state.critDamage += 0.08; } },
  { id: 'explosion', icon: '✺', name: '高爆弹头', color: '#ff9d4d', max: 6, desc: '命中产生范围爆炸，等级越高，冲击圈越大。', apply: () => { state.explosion += 1; } },
  { id: 'chain', icon: 'ϟ', name: '连锁闪电', color: '#c977ff', max: 6, desc: '命中时跳向附近更多目标，屏幕被闪电链切开。', apply: () => { state.chain += 1; } },
  { id: 'frost', icon: '❄', name: '绝对零度', color: '#6ecbff', max: 5, desc: '子弹有概率冻结敌人，给整片敌潮覆盖冰霜。', apply: () => { state.frost += 1; } },
  { id: 'ricochet', icon: '⌁', name: '智能弹射', color: '#ffca70', max: 5, desc: '命中后自动拐弯追击附近目标，一发子弹来回收割。', apply: () => { state.ricochet += 1; } },
  { id: 'drone', icon: '◇', name: '护航无人机', color: '#69b8ff', max: 6, desc: '增加一架环绕无人机，自动寻找最近敌人独立开火。', apply: () => { state.drones += 1; } },
  { id: 'orbit', icon: '◉', name: '旋转环刃', color: '#aaff75', max: 6, desc: '增加高速旋转的能量刃，贴身怪物会被持续切碎。', apply: () => { state.orbit += 1; } },
  { id: 'missile', icon: '➤', name: '追踪导弹', color: '#ff6f91', max: 6, desc: '定期发射自动追踪导弹，命中后制造大范围爆炸。', apply: () => { state.missile += 1; } },
  { id: 'bulletSize', icon: '●', name: '巨型弹丸', color: '#ffd66b', max: 5, desc: '弹丸体积与伤害同步增长，视觉密度更加离谱。', apply: () => { state.bulletSize *= 1.19; state.damage *= 1.1; } },
  { id: 'speed', icon: '↯', name: '动力外骨骼', color: '#78f5e7', max: 5, desc: '移动速度提高 14%，冲刺冷却也会略微缩短。', apply: () => { state.moveSpeed *= 1.14; } },
  { id: 'maxHp', icon: '♥', name: '生命扩容', color: '#ff7189', max: 5, desc: '最大生命提高 25，并立即回满新增部分生命。', apply: () => { state.maxHp += 25; state.hp += 25; } },
  { id: 'armor', icon: '⬡', name: '反应装甲', color: '#94a9c8', max: 5, desc: '每次受到的伤害降低，并增强冲刺时的撞击伤害。', apply: () => { state.armor += 0.08; } },
  { id: 'regen', icon: '✚', name: '纳米修复', color: '#66f5a2', max: 5, desc: '每秒自动恢复生命，击杀越密集越不怕贴脸。', apply: () => { state.regen += 0.8; } },
  { id: 'magnet', icon: '∪', name: '引力磁场', color: '#76d9ff', max: 5, desc: '扩大经验和强化拾取范围，远处掉落会主动飞过来。', apply: () => { state.pickupRange += 75; } },
  { id: 'lifesteal', icon: '♨', name: '收割吸血', color: '#ff4f75', max: 5, desc: '击杀有概率恢复生命，精英与 Boss 提供更多治疗。', apply: () => { state.lifesteal += 0.035; } },
  { id: 'critPower', icon: '‼', name: '弱点放大', color: '#ffba5d', max: 5, desc: '暴击倍率提高 45%，高密度红字会铺满战场。', apply: () => { state.critDamage += 0.45; } },
  { id: 'velocity', icon: '➟', name: '磁轨加速', color: '#84f4ff', max: 5, desc: '弹速提高 22%，并额外增加少量射速。', apply: () => { state.bulletSpeed *= 1.22; state.fireRate *= 1.05; } },
  { id: 'spread', icon: '⌇', name: '弹幕收束', color: '#d5a2ff', max: 4, desc: '多重射击更加集中，同时所有弹丸额外增伤。', apply: () => { state.spread *= 0.78; state.damage *= 1.12; } },
  { id: 'overclock', icon: '∞', name: '过载核心', color: '#fff173', max: 4, desc: '立即获得 6 秒无限弹匣，并永久提高伤害与射速。', apply: () => { state.damage *= 1.15; state.fireRate *= 1.1; state.overdriveUntil = Math.max(state.overdriveUntil, state.elapsed + 6); } },
  { id: 'heal', icon: '✚', name: '战地急救', color: '#7affac', max: 99, desc: '立即恢复 42% 最大生命，并短暂无敌。', apply: () => { state.hp = Math.min(state.maxHp, state.hp + state.maxHp * 0.42); state.invulnerableUntil = state.elapsed + 1.2; } },
];

const UPGRADE_MAP = new Map(UPGRADES.map((upgrade) => [upgrade.id, upgrade]));

function upgradeLevel(id) { return state.upgradeLevels[id] || 0; }

function resetRun() {
  Object.assign(state, {
    elapsed: 0, score: 0, kills: 0, combo: 0, maxCombo: 0, comboTimer: 0,
    level: 1, xp: 0, nextXp: 14, pendingLevelUps: 0,
    hp: 100, maxHp: 100, armor: 0, regen: 0,
    damage: 18, fireRate: 12, bulletSpeed: 760, bulletSize: 4.2, moveSpeed: 260,
    multishot: 1, spread: 0.105, pierce: 0, critChance: 0.06, critDamage: 2,
    explosion: 0, chain: 0, frost: 0, ricochet: 0, drones: 0, orbit: 0,
    missile: 0, lifesteal: 0, pickupRange: 90,
    overdriveUntil: 0, hordeUntil: 0, invulnerableUntil: 1.2,
    fireAccumulator: 0, spawnAccumulator: 0, droneAccumulator: 0, missileAccumulator: 0,
    healAccumulator: 0, supplyAt: 15, bossSpawned: false, bossKilled: false, boss: null,
    shake: 0, flash: 0, hitStop: 0, uiAccumulator: 0,
    cooldowns: { horde: 0, overdrive: 0, elite: 0, nuke: 0 },
    upgradeLevels: {}, enemies: [], bullets: [], hostileBullets: [], pickups: [], particles: [], shockwaves: [], beams: [], floaters: [],
  });
  nextEnemyId = 1;
  enemyGrid.clear();
  state.player = { x: width * 0.5, y: height * 0.57, vx: 0, vy: 0, angle: -Math.PI / 2, radius: 16, dashTime: 0, dashCooldown: 0, dashX: 1, dashY: 0 };
  input.pointerX = state.player.x + 180;
  input.pointerY = state.player.y;
  input.aimX = 1;
  input.aimY = 0;
  updateArsenal();
  syncHud(true);
}

function startRun() {
  ensureAudio();
  clearTimeout(autoPickTimer);
  resetRun();
  setMode('running');
  state.lastTs = performance.now();
  showToast('枪口跟随鼠标自动开火；WASD 移动，Shift 冲刺撞开包围圈', 3600);
  showBanner('SURVIVE THE SWARM', '#70fff1');
  tone(460, 0.08, 'triangle', 0.045, 180);
}

function returnToMenu() {
  clearTimeout(autoPickTimer);
  setMode('menu');
  state.enemies.length = 0;
  state.bullets.length = 0;
  state.hostileBullets.length = 0;
  state.pickups.length = 0;
  state.particles.length = 0;
  state.boss = null;
  els.bossHud.classList.add('hidden');
  loadProfile();
}

function pauseGame() {
  if (state.mode === 'running') setMode('paused');
  else if (state.mode === 'paused') { setMode('running'); state.lastTs = performance.now(); }
}

function grantXp(amount) {
  state.xp += amount;
  while (state.xp >= state.nextXp) {
    state.xp -= state.nextXp;
    state.level += 1;
    state.pendingLevelUps += 1;
    state.nextXp = Math.round(12 + 7 * Math.pow(state.level, 1.12));
  }
  if (state.pendingLevelUps > 0 && state.mode === 'running') openUpgrade();
}

function availableUpgrades() {
  return UPGRADES.filter((upgrade) => upgradeLevel(upgrade.id) < upgrade.max);
}

function chooseUpgradeOptions() {
  const available = [...availableUpgrades()];
  for (let index = available.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [available[index], available[swap]] = [available[swap], available[index]];
  }
  const result = available.slice(0, 3);
  if (result.length < 3) result.push(...UPGRADES.filter((upgrade) => upgrade.id === 'heal').slice(0, 3 - result.length));
  return result;
}

function openUpgrade() {
  if (state.pendingLevelUps <= 0) return;
  setMode('upgrade');
  const options = chooseUpgradeOptions();
  els.upgradeOptions.innerHTML = options.map((upgrade, index) => {
    const level = upgradeLevel(upgrade.id);
    return `<button class="upgrade-option" type="button" data-upgrade="${upgrade.id}" style="--upgrade-color:${upgrade.color}">
      <kbd>${index + 1}</kbd><i>${upgrade.icon}</i><h3>${upgrade.name}</h3><p>${upgrade.desc}</p><small>${upgrade.max >= 90 ? '即时强化' : `Lv.${level} → Lv.${level + 1} / ${upgrade.max}`}</small>
    </button>`;
  }).join('');
  els.upgradeCountdown.textContent = els.autoPick.checked ? '挂机模式：2.5 秒后自动选择' : '选择后立刻恢复战斗';
  els.upgradeOptions.querySelectorAll('.upgrade-option').forEach((button) => {
    button.addEventListener('click', () => selectUpgrade(button.dataset.upgrade));
  });
  clearTimeout(autoPickTimer);
  if (els.autoPick.checked) autoPickTimer = window.setTimeout(() => selectUpgrade(pick(options).id), 2500);
  tone(680, 0.12, 'triangle', 0.045, 280);
}

function selectUpgrade(id) {
  if (state.mode !== 'upgrade') return;
  const upgrade = UPGRADE_MAP.get(id);
  if (!upgrade) return;
  clearTimeout(autoPickTimer);
  upgrade.apply();
  if (upgrade.max < 90) state.upgradeLevels[id] = upgradeLevel(id) + 1;
  state.pendingLevelUps = Math.max(0, state.pendingLevelUps - 1);
  burst(state.player.x, state.player.y, upgrade.color, 34, 220);
  addShockwave(state.player.x, state.player.y, upgrade.color, 12, 150, 0.55);
  showBanner(upgrade.name, upgrade.color);
  updateArsenal();
  syncHud(true);
  tone(820, 0.1, 'triangle', 0.05, 330);
  if (state.pendingLevelUps > 0) window.setTimeout(openUpgrade, 180);
  else { setMode('running'); state.lastTs = performance.now(); }
}

function updateArsenal() {
  const items = [
    { icon: '▰', name: '脉冲步枪', detail: `${state.multishot} 发 · ${state.pierce} 穿透`, level: `Lv.${Math.max(1, upgradeLevel('damage') + upgradeLevel('rate') + 1)}`, color: '#ffe45c', active: true },
    { icon: '✺', name: '高爆弹头', detail: '范围冲击波', level: `Lv.${state.explosion}`, color: '#ff9d4d', active: state.explosion > 0 },
    { icon: 'ϟ', name: '连锁闪电', detail: '自动跳跃目标', level: `Lv.${state.chain}`, color: '#c977ff', active: state.chain > 0 },
    { icon: '◇', name: '护航无人机', detail: `${state.drones} 架独立射击`, level: `Lv.${state.drones}`, color: '#69b8ff', active: state.drones > 0 },
    { icon: '◉', name: '旋转环刃', detail: `${state.orbit} 枚近身切割`, level: `Lv.${state.orbit}`, color: '#aaff75', active: state.orbit > 0 },
    { icon: '➤', name: '追踪导弹', detail: '自动索敌爆炸', level: `Lv.${state.missile}`, color: '#ff6f91', active: state.missile > 0 },
  ].filter((item) => item.active);
  els.arsenalList.innerHTML = items.map((item) => `<div class="arsenal-item" style="--item-color:${item.color}"><i>${item.icon}</i><span><b>${item.name}</b><small>${item.detail}</small></span><b>${item.level}</b></div>`).join('');
}

function chooseEnemyType() {
  const t = state.elapsed;
  const roll = Math.random();
  if (t > 66 && roll < 0.045) return 'elite';
  if (t > 52 && roll < 0.14) return 'shooter';
  if (t > 38 && roll < 0.23) return 'splitter';
  if (t > 24 && roll < 0.36) return 'tank';
  if (t > 10 && roll < 0.57) return 'runner';
  return 'grunt';
}

function spawnEnemy(type = chooseEnemyType(), options = {}) {
  if (state.enemies.length >= CONFIG.maxEnemies) return null;
  const definition = ENEMY_TYPES[type];
  const margin = options.margin ?? rand(28, 75);
  const side = options.side ?? Math.floor(Math.random() * 4);
  let x;
  let y;
  if (side === 0) { x = rand(-margin, width + margin); y = -margin; }
  else if (side === 1) { x = width + margin; y = rand(80, height + margin); }
  else if (side === 2) { x = rand(-margin, width + margin); y = height + margin; }
  else { x = -margin; y = rand(80, height + margin); }
  const progression = 1 + state.elapsed * 0.014 + Math.pow(state.elapsed / CONFIG.duration, 2) * 1.1;
  const eliteScale = options.eliteScale || 1;
  const hp = type === 'boss' ? 92000 * (1 + state.level * 0.055) : 24 * definition.hp * progression * eliteScale;
  const enemy = {
    id: nextEnemyId++, type, x, y, vx: 0, vy: 0, radius: definition.radius * (options.scale || 1),
    hp, maxHp: hp, speed: (78 + state.elapsed * 0.13) * definition.speed * (options.speed || 1),
    damage: definition.damage, score: definition.score, xp: definition.xp,
    frame: definition.frame, color: definition.color, phase: rand(0, Math.PI * 2),
    hitFlash: 0, frozenUntil: 0, shootAt: state.elapsed + rand(1, 2.4), touchAt: 0,
    dead: false, boss: type === 'boss', elite: type === 'elite', splitDepth: options.splitDepth || 0,
    orbitHitAt: 0,
  };
  state.enemies.push(enemy);
  if (enemy.boss) {
    state.boss = enemy;
    state.bossSpawned = true;
    els.bossHud.classList.remove('hidden');
    els.bossName.textContent = '吞城者 · OMEGA';
    showBanner('OMEGA ABOMINATION', '#ff526f');
    showToast('终局 Boss 从尸潮里挤进来了：继续移动，所有火力会自动锁定它附近的敌人', 3800);
    state.shake = Math.max(state.shake, 1.5);
    addShockwave(enemy.x, enemy.y, '#ff365f', 30, 360, 1.25);
    tone(82, 0.7, 'sawtooth', 0.08, -25);
  }
  return enemy;
}

function spawnBoss() {
  if (state.bossSpawned) return state.boss;
  return spawnEnemy('boss', { side: 0, margin: 110 });
}

function spawnHorde(amount) {
  for (let i = 0; i < amount && state.enemies.length < CONFIG.maxEnemies; i += 1) {
    const type = i % 19 === 0 && state.elapsed > 40 ? 'elite' : chooseEnemyType();
    spawnEnemy(type, { margin: rand(5, 110) });
  }
}

function spawnPickup(x, y, type = 'xp', value = 1) {
  if (state.pickups.length >= CONFIG.maxPickups) {
    const existing = state.pickups.find((pickup) => pickup.type === 'xp');
    if (existing) existing.value += value;
    return;
  }
  const colors = { xp: '#70fff1', heal: '#69ff9a', overdrive: '#ffe45c', magnet: '#73b7ff', nuke: '#ff6d8f' };
  state.pickups.push({ x, y, type, value, color: colors[type], radius: type === 'xp' ? 5 : 12, phase: rand(0, Math.PI * 2), life: type === 'xp' ? 28 : 20 });
}

function spawnPowerup(x = rand(100, width - 100), y = rand(130, height - 100), forcedType) {
  spawnPickup(x, y, forcedType || pick(['heal', 'overdrive', 'magnet', 'nuke']), 1);
}

function addParticle(x, y, color, speed = 100, life = 0.5, size = 3, angle = rand(0, Math.PI * 2)) {
  if (state.particles.length >= CONFIG.maxParticles) return;
  state.particles.push({ x, y, px: x, py: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, color, life, maxLife: life, size, gravity: 0 });
}

function burst(x, y, color, count = 16, speed = 150) {
  for (let i = 0; i < count; i += 1) addParticle(x, y, color, rand(speed * 0.25, speed), rand(0.24, 0.72), rand(1.5, 4.5));
}

function addShockwave(x, y, color, start = 5, end = 90, life = 0.45, widthValue = 4) {
  if (state.shockwaves.length >= MAX_SHOCKWAVES) return;
  state.shockwaves.push({ x, y, color, radius: start, start, end, life, maxLife: life, width: widthValue });
}

function addFloater(x, y, text, color = '#ffffff', size = 12, life = 0.65) {
  if (state.floaters.length > 180) state.floaters.shift();
  state.floaters.push({ x, y, text, color, size, life, maxLife: life, vx: rand(-16, 16), vy: rand(-80, -50) });
}

function addBeam(x1, y1, x2, y2, color = '#c977ff', widthValue = 3, life = 0.14) {
  if (state.beams.length >= MAX_BEAMS) return;
  state.beams.push({ x1, y1, x2, y2, color, width: widthValue, life, maxLife: life });
}

function fireBullet(x, y, angle, options = {}) {
  if (state.bullets.length >= CONFIG.maxBullets) return null;
  const speed = options.speed || state.bulletSpeed;
  const bullet = {
    x, y, px: x, py: y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    angle,
    radius: options.radius || state.bulletSize,
    damage: options.damage || state.damage,
    life: options.life || 1.25,
    pierce: options.pierce ?? state.pierce,
    color: options.color || '#ffe45c',
    kind: options.kind || 'primary',
    explosive: options.explosive ?? state.explosion,
    chain: options.chain ?? state.chain,
    frost: options.frost ?? state.frost,
    ricochet: options.ricochet ?? state.ricochet,
    homing: options.homing || 0,
    target: options.target || null,
    hitIds: [],
    dead: false,
  };
  state.bullets.push(bullet);
  return bullet;
}

function firePrimary(dt) {
  const multiplier = state.elapsed < state.overdriveUntil ? 3 : 1;
  state.fireAccumulator += dt * state.fireRate * multiplier;
  const shots = Math.min(8, Math.floor(state.fireAccumulator));
  if (shots <= 0) return;
  state.fireAccumulator -= shots;
  for (let shot = 0; shot < shots; shot += 1) {
    const count = Math.min(9, state.multishot);
    const baseAngle = state.player.angle;
    for (let index = 0; index < count; index += 1) {
      const offset = (index - (count - 1) / 2) * state.spread;
      const jitter = count <= 2 ? rand(-0.012, 0.012) : rand(-0.007, 0.007);
      const angle = baseAngle + offset + jitter;
      const muzzle = 22;
      fireBullet(state.player.x + Math.cos(angle) * muzzle, state.player.y + Math.sin(angle) * muzzle, angle, {
        damage: state.damage * (state.elapsed < state.overdriveUntil ? 2 : 1),
        radius: state.bulletSize * (state.elapsed < state.overdriveUntil ? 1.18 : 1),
        color: state.elapsed < state.overdriveUntil ? '#70fff1' : '#ffe45c',
      });
    }
    if (shot === 0) {
      state.player.vx -= Math.cos(baseAngle) * 2.1;
      state.player.vy -= Math.sin(baseAngle) * 2.1;
      addParticle(state.player.x + Math.cos(baseAngle) * 24, state.player.y + Math.sin(baseAngle) * 24, '#fff3a1', rand(40, 90), 0.11, rand(2, 5), baseAngle + Math.PI + rand(-0.5, 0.5));
    }
  }
  if (Math.random() < 0.22) tone(180 + Math.random() * 35, 0.025, 'square', 0.009, -35);
}

function nearestEnemy(x, y, maxDistance = Infinity, excludeIds = null, grid = null) {
  let best = null;
  let bestDistance = maxDistance * maxDistance;
  const consider = (enemy) => {
    if (enemy.dead || (excludeIds && excludeIds.includes(enemy.id))) return;
    const d2 = distanceSq(x, y, enemy.x, enemy.y);
    if (d2 < bestDistance) { bestDistance = d2; best = enemy; }
  };
  if (grid && Number.isFinite(maxDistance)) {
    grid.visit(x, y, maxDistance, consider);
  } else {
    for (const enemy of state.enemies) consider(enemy);
  }
  return best;
}

function fireDrones(dt, grid) {
  if (!state.drones) return;
  state.droneAccumulator += dt;
  const interval = Math.max(0.13, 0.56 - state.drones * 0.045);
  if (state.droneAccumulator < interval) return;
  state.droneAccumulator %= interval;
  for (let index = 0; index < state.drones; index += 1) {
    const angle = state.elapsed * 1.35 + index * Math.PI * 2 / state.drones;
    const x = state.player.x + Math.cos(angle) * (48 + state.drones * 2.5);
    const y = state.player.y + Math.sin(angle) * (48 + state.drones * 2.5);
    const target = nearestEnemy(x, y, 440, null, grid);
    if (!target) continue;
    const aim = Math.atan2(target.y - y, target.x - x);
    fireBullet(x, y, aim, { damage: state.damage * (0.42 + state.drones * 0.025), radius: 3.4, speed: state.bulletSpeed * 0.88, color: '#69b8ff', pierce: Math.floor(state.pierce / 2), explosive: 0, chain: 0, frost: 0, ricochet: 0, kind: 'drone' });
    addBeam(x, y, x + Math.cos(aim) * 18, y + Math.sin(aim) * 18, '#69b8ff', 2, 0.07);
  }
}

function fireMissiles(dt, grid) {
  if (!state.missile) return;
  state.missileAccumulator += dt;
  const interval = Math.max(0.42, 2.2 - state.missile * 0.25);
  if (state.missileAccumulator < interval) return;
  state.missileAccumulator %= interval;
  const count = 1 + Math.floor((state.missile - 1) / 2);
  for (let index = 0; index < count; index += 1) {
    const target = nearestEnemy(state.player.x, state.player.y, Infinity, null, grid);
    if (!target) break;
    const angle = state.player.angle + (index - (count - 1) / 2) * 0.3;
    fireBullet(state.player.x, state.player.y, angle, { damage: state.damage * (3.8 + state.missile * 0.65), radius: 7, speed: 330, color: '#ff6f91', pierce: 0, explosive: 2 + state.missile, chain: 0, frost: 0, ricochet: 0, homing: 4.2, target, life: 3.2, kind: 'missile' });
  }
  tone(110, 0.09, 'sawtooth', 0.025, 90);
}

function fireHostile(enemy) {
  if (state.hostileBullets.length >= CONFIG.maxHostiles) return;
  const angle = Math.atan2(state.player.y - enemy.y, state.player.x - enemy.x);
  const count = enemy.boss ? 18 : 3;
  const spread = enemy.boss ? Math.PI * 2 / count : 0.14;
  for (let index = 0; index < count; index += 1) {
    const a = enemy.boss ? index * spread + state.elapsed * 0.35 : angle + (index - 1) * spread;
    const speed = enemy.boss ? 155 : 220;
    state.hostileBullets.push({ x: enemy.x, y: enemy.y, px: enemy.x, py: enemy.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, radius: enemy.boss ? 7 : 5, damage: enemy.boss ? 14 : 7, life: enemy.boss ? 5.5 : 3.2, color: enemy.boss ? '#ff3d60' : '#df70ff' });
  }
  addShockwave(enemy.x, enemy.y, enemy.color, 5, enemy.radius * 1.4, 0.24, 2);
}

function damageEnemy(enemy, amount, options = {}) {
  if (!enemy || enemy.dead) return false;
  const critical = options.critical ?? (Math.random() < state.critChance);
  const finalDamage = amount * (critical ? state.critDamage : 1);
  enemy.hp -= finalDamage;
  enemy.hitFlash = 0.08;
  if (options.frost && Math.random() < Math.min(0.74, 0.12 + options.frost * 0.1)) enemy.frozenUntil = Math.max(enemy.frozenUntil, state.elapsed + 0.65 + options.frost * 0.18);
  if (critical || enemy.boss || Math.random() < 0.14) addFloater(enemy.x, enemy.y - enemy.radius, `${critical ? '暴击 ' : ''}${formatCompact(finalDamage)}`, critical ? '#ffdc5e' : options.color || '#e7fbff', critical ? 15 : 11, critical ? 0.72 : 0.48);
  if (enemy.hp <= 0) killEnemy(enemy, options);
  return true;
}

function killEnemy(enemy, options = {}) {
  if (enemy.dead) return;
  enemy.dead = true;
  state.kills += 1;
  state.combo += 1;
  state.maxCombo = Math.max(state.maxCombo, state.combo);
  state.comboTimer = 2.2;
  const multiplier = 1 + Math.min(8, Math.floor(state.combo / 25)) * 0.25;
  state.score += Math.round(enemy.score * multiplier * (enemy.boss ? 1 : 1 + state.elapsed / 280));
  if (state.lifesteal > 0 && Math.random() < state.lifesteal * (enemy.elite ? 3 : enemy.boss ? 8 : 1)) state.hp = Math.min(state.maxHp, state.hp + (enemy.boss ? 25 : enemy.elite ? 7 : 2));
  const xpCount = enemy.boss ? 14 : enemy.elite ? 5 : enemy.xp >= 3 ? 2 : 1;
  for (let index = 0; index < xpCount; index += 1) spawnPickup(enemy.x + rand(-enemy.radius, enemy.radius), enemy.y + rand(-enemy.radius, enemy.radius), 'xp', Math.max(1, Math.ceil(enemy.xp / xpCount)));
  if (enemy.elite) spawnPowerup(enemy.x, enemy.y);
  if (enemy.type === 'splitter' && enemy.splitDepth < 1) {
    for (let index = 0; index < 2; index += 1) spawnEnemy('runner', { side: 0, margin: 0, scale: 0.74, speed: 1.12, splitDepth: 1 });
    const spawned = state.enemies.slice(-2);
    spawned.forEach((child, index) => { child.x = enemy.x + (index ? 15 : -15); child.y = enemy.y; child.hp *= 0.55; child.maxHp = child.hp; });
  }
  const color = enemy.color;
  burst(enemy.x, enemy.y, color, enemy.boss ? 150 : enemy.elite ? 42 : Math.min(24, 9 + enemy.radius / 2), enemy.boss ? 420 : 180);
  addShockwave(enemy.x, enemy.y, color, enemy.radius * 0.3, enemy.radius * (enemy.boss ? 5 : 2.5), enemy.boss ? 1.2 : 0.38, enemy.boss ? 8 : 3);
  if (enemy.boss) {
    state.bossKilled = true;
    state.boss = null;
    els.bossHud.classList.add('hidden');
    state.shake = 2.6;
    state.hitStop = 0.18;
    showBanner('OMEGA ANNIHILATED', '#ffe45c');
    tone(65, 0.8, 'sawtooth', 0.1, 360);
    window.setTimeout(() => finishRun(true), 1200);
  } else if (enemy.elite) {
    state.shake = Math.max(state.shake, 0.45);
    state.hitStop = Math.max(state.hitStop, 0.025);
    tone(120, 0.07, 'sawtooth', 0.025, -30);
  }
  if (state.combo > 0 && state.combo % 100 === 0) {
    showBanner(`${state.combo} KILL RAMPAGE`, '#ffe45c');
    state.overdriveUntil = Math.max(state.overdriveUntil, state.elapsed + 3);
  }
}

function explode(x, y, radius, damage, color, grid, excludeId = null) {
  addShockwave(x, y, color, 6, radius, 0.32 + radius / 600, Math.max(3, radius / 24));
  burst(x, y, color, Math.min(36, Math.round(radius / 4)), radius * 1.7);
  const radiusSq = radius * radius;
  grid.visit(x, y, radius, (target) => {
    if (target.dead || target.id === excludeId || distanceSq(x, y, target.x, target.y) > radiusSq) return;
    damageEnemy(target, damage * (1 - Math.sqrt(distanceSq(x, y, target.x, target.y)) / radius * 0.45), { color, critical: false });
  });
}

function chainLightning(source, count, damage, grid, excluded = []) {
  let current = source;
  const seen = [...excluded, source.id];
  for (let index = 0; index < count; index += 1) {
    let target = null;
    let best = 185 * 185;
    grid.visit(current.x, current.y, 185, (enemy) => {
      if (enemy.dead || seen.includes(enemy.id)) return;
      const d2 = distanceSq(current.x, current.y, enemy.x, enemy.y);
      if (d2 < best) { best = d2; target = enemy; }
    });
    if (!target) break;
    addBeam(current.x, current.y, target.x, target.y, '#c977ff', 2.5 + count * 0.2, 0.17);
    damageEnemy(target, damage * Math.pow(0.76, index + 1), { color: '#d9a6ff', critical: false });
    seen.push(target.id);
    current = target;
  }
}

function updatePlayer(dt, grid) {
  const player = state.player;
  player.dashCooldown = Math.max(0, player.dashCooldown - dt);
  const keyboardX = (input.keys.has('d') || input.keys.has('arrowright') ? 1 : 0) - (input.keys.has('a') || input.keys.has('arrowleft') ? 1 : 0);
  const keyboardY = (input.keys.has('s') || input.keys.has('arrowdown') ? 1 : 0) - (input.keys.has('w') || input.keys.has('arrowup') ? 1 : 0);
  let moveX = keyboardX + input.moveX;
  let moveY = keyboardY + input.moveY;
  const moveLength = Math.hypot(moveX, moveY);
  if (moveLength > 1) { moveX /= moveLength; moveY /= moveLength; }

  if (input.pointerActive) {
    const dx = input.pointerX - player.x;
    const dy = input.pointerY - player.y;
    const length = Math.hypot(dx, dy) || 1;
    input.aimX = dx / length;
    input.aimY = dy / length;
  }
  player.angle = Math.atan2(input.aimY, input.aimX);

  if (player.dashTime > 0) {
    player.dashTime -= dt;
    player.vx = player.dashX * state.moveSpeed * 3.8;
    player.vy = player.dashY * state.moveSpeed * 3.8;
    state.invulnerableUntil = Math.max(state.invulnerableUntil, state.elapsed + 0.08);
    addParticle(player.x, player.y, '#70fff1', rand(15, 70), rand(0.18, 0.35), rand(4, 9), player.angle + Math.PI + rand(-0.8, 0.8));
    grid.visit(player.x, player.y, 42, (enemy) => {
      if (!enemy.dead && distanceSq(player.x, player.y, enemy.x, enemy.y) < Math.pow(player.radius + enemy.radius + 12, 2)) damageEnemy(enemy, state.damage * (4 + state.armor * 10), { color: '#70fff1', critical: false });
    });
  } else {
    const response = 1 - Math.exp(-dt * 13);
    player.vx += (moveX * state.moveSpeed - player.vx) * response;
    player.vy += (moveY * state.moveSpeed - player.vy) * response;
    if (!moveLength) { player.vx *= Math.pow(0.1, dt); player.vy *= Math.pow(0.1, dt); }
  }
  player.x = clamp(player.x + player.vx * dt, 28, width - 28);
  player.y = clamp(player.y + player.vy * dt, 105, height - 28);
}

function startDash() {
  const player = state.player;
  if (state.mode !== 'running' || player.dashCooldown > 0) return;
  const keyboardX = (input.keys.has('d') || input.keys.has('arrowright') ? 1 : 0) - (input.keys.has('a') || input.keys.has('arrowleft') ? 1 : 0) + input.moveX;
  const keyboardY = (input.keys.has('s') || input.keys.has('arrowdown') ? 1 : 0) - (input.keys.has('w') || input.keys.has('arrowup') ? 1 : 0) + input.moveY;
  const length = Math.hypot(keyboardX, keyboardY);
  player.dashX = length > 0.2 ? keyboardX / length : input.aimX;
  player.dashY = length > 0.2 ? keyboardY / length : input.aimY;
  player.dashTime = 0.2;
  player.dashCooldown = Math.max(0.75, 2.15 - upgradeLevel('speed') * 0.12);
  state.invulnerableUntil = state.elapsed + 0.28;
  addShockwave(player.x, player.y, '#70fff1', 8, 75, 0.32, 4);
  tone(260, 0.08, 'sawtooth', 0.035, 280);
}

function updateEnemyMotion(dt) {
  const player = state.player;
  for (const enemy of state.enemies) {
    if (enemy.dead) continue;
    enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);
    const dx = player.x - enemy.x;
    const dy = player.y - enemy.y;
    const distance = Math.hypot(dx, dy) || 1;
    let directionX = dx / distance;
    let directionY = dy / distance;
    let speed = enemy.speed * (state.elapsed < enemy.frozenUntil ? 0.35 : 1);
    if (enemy.type === 'shooter' && distance < 280) { directionX *= -0.45; directionY *= -0.45; speed *= 0.8; }
    if (enemy.boss) {
      const orbit = Math.sin(state.elapsed * 0.8) * 0.22;
      const ox = directionX * Math.cos(orbit) - directionY * Math.sin(orbit);
      const oy = directionX * Math.sin(orbit) + directionY * Math.cos(orbit);
      directionX = ox; directionY = oy;
    } else {
      const wobble = Math.sin(state.elapsed * (enemy.type === 'runner' ? 8 : 3) + enemy.phase) * 0.12;
      const ox = directionX - directionY * wobble;
      const oy = directionY + directionX * wobble;
      directionX = ox; directionY = oy;
    }
    enemy.vx += (directionX * speed - enemy.vx) * Math.min(1, dt * 5.5);
    enemy.vy += (directionY * speed - enemy.vy) * Math.min(1, dt * 5.5);
    enemy.x += enemy.vx * dt;
    enemy.y += enemy.vy * dt;
    if ((enemy.type === 'shooter' || enemy.boss) && state.elapsed >= enemy.shootAt) {
      fireHostile(enemy);
      enemy.shootAt = state.elapsed + (enemy.boss ? rand(0.62, 1.05) : rand(1.8, 3.2));
    }
    const touchDistance = player.radius + enemy.radius * 0.72;
    if (distance < touchDistance && state.elapsed >= enemy.touchAt) {
      enemy.touchAt = state.elapsed + 0.62;
      hitPlayer(enemy.damage, enemy.x, enemy.y);
      enemy.x -= directionX * 14;
      enemy.y -= directionY * 14;
    }
  }

}

function updateOrbit(grid) {
  if (state.orbit <= 0) return;
  const player = state.player;
  const count = state.orbit;
  const orbitRadius = 64 + count * 4;
  for (let index = 0; index < count; index += 1) {
    const angle = state.elapsed * (2.4 + count * 0.08) + index * Math.PI * 2 / count;
    const x = player.x + Math.cos(angle) * orbitRadius;
    const y = player.y + Math.sin(angle) * orbitRadius;
    grid.visit(x, y, 38, (enemy) => {
      if (enemy.dead || state.elapsed < enemy.orbitHitAt || distanceSq(x, y, enemy.x, enemy.y) > Math.pow(enemy.radius + 16, 2)) return;
      enemy.orbitHitAt = state.elapsed + 0.18;
      damageEnemy(enemy, state.damage * (0.62 + state.orbit * 0.12), { color: '#aaff75', critical: false, frost: Math.floor(state.frost / 2) });
      addBeam(x - Math.cos(angle) * 15, y - Math.sin(angle) * 15, x + Math.cos(angle) * 15, y + Math.sin(angle) * 15, '#aaff75', 3, 0.08);
    });
  }
}

function hitPlayer(amount, sourceX, sourceY) {
  if (state.elapsed < state.invulnerableUntil || state.mode !== 'running') return;
  const reduced = Math.max(1, amount * (1 - Math.min(0.62, state.armor)));
  state.hp = Math.max(0, state.hp - reduced);
  state.invulnerableUntil = state.elapsed + 0.52;
  state.combo = Math.floor(state.combo * 0.55);
  state.comboTimer = 0.8;
  state.shake = Math.max(state.shake, 0.8);
  state.flash = 1;
  els.damageFlash.classList.add('active');
  window.setTimeout(() => els.damageFlash.classList.remove('active'), 80);
  addFloater(state.player.x, state.player.y - 25, `-${Math.ceil(reduced)}`, '#ff526f', 18, 0.8);
  const angle = Math.atan2(state.player.y - sourceY, state.player.x - sourceX);
  state.player.vx += Math.cos(angle) * 180;
  state.player.vy += Math.sin(angle) * 180;
  burst(state.player.x, state.player.y, '#ff526f', 22, 230);
  tone(95, 0.16, 'sawtooth', 0.07, -45);
  if (state.hp <= 0) finishRun(false);
}

function updateBullets(dt, grid) {
  for (let index = state.bullets.length - 1; index >= 0; index -= 1) {
    const bullet = state.bullets[index];
    if (bullet.dead) continue;
    bullet.life -= dt;
    if (bullet.homing && bullet.target && !bullet.target.dead) {
      const targetAngle = Math.atan2(bullet.target.y - bullet.y, bullet.target.x - bullet.x);
      let delta = ((targetAngle - bullet.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      bullet.angle += clamp(delta, -bullet.homing * dt, bullet.homing * dt);
      const speed = Math.hypot(bullet.vx, bullet.vy);
      bullet.vx = Math.cos(bullet.angle) * speed;
      bullet.vy = Math.sin(bullet.angle) * speed;
    }
    bullet.px = bullet.x;
    bullet.py = bullet.y;
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
    if (bullet.kind === 'missile' && Math.random() < 0.85) addParticle(bullet.x, bullet.y, '#ff8a68', rand(5, 28), rand(0.2, 0.45), rand(2, 5), bullet.angle + Math.PI + rand(-0.4, 0.4));
    if (bullet.life <= 0 || bullet.x < -120 || bullet.x > width + 120 || bullet.y < -120 || bullet.y > height + 120) {
      bullet.dead = true;
      continue;
    }
    let hit = null;
    grid.visit(bullet.x, bullet.y, bullet.radius + 48, (enemy) => {
      if (enemy.dead || bullet.hitIds.includes(enemy.id)) return;
      if (distanceSq(bullet.x, bullet.y, enemy.x, enemy.y) <= Math.pow(bullet.radius + enemy.radius * 0.72, 2)) {
        hit = enemy;
        return false;
      }
    });
    if (!hit) continue;
    bullet.hitIds.push(hit.id);
    const critical = Math.random() < state.critChance;
    damageEnemy(hit, bullet.damage, { critical, color: bullet.color, frost: bullet.frost });
    burst(bullet.x, bullet.y, bullet.color, bullet.kind === 'missile' ? 24 : 4, bullet.kind === 'missile' ? 180 : 65);
    if (bullet.explosive > 0) {
      const radius = bullet.kind === 'missile' ? 88 + bullet.explosive * 10 : 28 + bullet.explosive * 11;
      explode(bullet.x, bullet.y, radius, bullet.damage * (bullet.kind === 'missile' ? 1.15 : 0.32 + bullet.explosive * 0.035), bullet.color, grid, hit.id);
    }
    if (bullet.chain > 0 && Math.random() < Math.min(0.86, 0.16 + bullet.chain * 0.11)) chainLightning(hit, Math.min(7, bullet.chain + 1), bullet.damage * 0.75, grid, bullet.hitIds);
    if (bullet.ricochet > 0 && Math.random() < Math.min(0.92, 0.25 + bullet.ricochet * 0.13)) {
      const target = nearestEnemy(bullet.x, bullet.y, 280, bullet.hitIds, grid);
      if (target) {
        bullet.angle = Math.atan2(target.y - bullet.y, target.x - bullet.x);
        const speed = Math.hypot(bullet.vx, bullet.vy) * 0.94;
        bullet.vx = Math.cos(bullet.angle) * speed;
        bullet.vy = Math.sin(bullet.angle) * speed;
        bullet.life += 0.18;
        addBeam(bullet.x, bullet.y, bullet.x + Math.cos(bullet.angle) * 26, bullet.y + Math.sin(bullet.angle) * 26, '#ffca70', 2, 0.09);
        continue;
      }
    }
    bullet.pierce -= 1;
    if (bullet.pierce < 0) bullet.dead = true;
  }
  compactInPlace(state.bullets, (bullet) => !bullet.dead);
}

function updateHostileBullets(dt) {
  const player = state.player;
  for (let index = state.hostileBullets.length - 1; index >= 0; index -= 1) {
    const bullet = state.hostileBullets[index];
    bullet.life -= dt;
    bullet.px = bullet.x; bullet.py = bullet.y;
    bullet.x += bullet.vx * dt; bullet.y += bullet.vy * dt;
    if (bullet.life <= 0 || bullet.x < -50 || bullet.x > width + 50 || bullet.y < -50 || bullet.y > height + 50) { bullet.dead = true; continue; }
    if (distanceSq(bullet.x, bullet.y, player.x, player.y) < Math.pow(bullet.radius + player.radius, 2)) {
      hitPlayer(bullet.damage, bullet.x - bullet.vx, bullet.y - bullet.vy);
      bullet.dead = true;
    }
  }
  compactInPlace(state.hostileBullets, (bullet) => !bullet.dead);
}

function updatePickups(dt) {
  const player = state.player;
  for (let index = state.pickups.length - 1; index >= 0; index -= 1) {
    const pickup = state.pickups[index];
    pickup.life -= dt;
    pickup.phase += dt * 5;
    const dx = player.x - pickup.x;
    const dy = player.y - pickup.y;
    const distance = Math.hypot(dx, dy) || 1;
    const range = pickup.type === 'xp' ? state.pickupRange : state.pickupRange * 1.25;
    if (distance < range) {
      const speed = 180 + (range - distance) * 5;
      pickup.x += dx / distance * speed * dt;
      pickup.y += dy / distance * speed * dt;
    }
    if (distance < player.radius + pickup.radius + 8) {
      collectPickup(pickup);
      pickup.dead = true;
      continue;
    }
    if (pickup.life <= 0) pickup.dead = true;
  }
  compactInPlace(state.pickups, (pickup) => !pickup.dead);
}

function collectPickup(pickup) {
  if (pickup.type === 'xp') {
    grantXp(pickup.value);
    if (Math.random() < 0.08) tone(760, 0.025, 'triangle', 0.008, 80);
  } else if (pickup.type === 'heal') {
    state.hp = Math.min(state.maxHp, state.hp + state.maxHp * 0.32);
    showToast('急救包：恢复 32% 最大生命');
    addFloater(state.player.x, state.player.y - 30, '+HEAL', '#69ff9a', 16, 0.8);
    tone(520, 0.12, 'triangle', 0.04, 360);
  } else if (pickup.type === 'overdrive') {
    state.overdriveUntil = Math.max(state.overdriveUntil, state.elapsed + 9);
    showBanner('INFINITE MAGAZINE', '#ffe45c');
    showToast('无限弹匣：9 秒射速 ×3、伤害 ×2');
  } else if (pickup.type === 'magnet') {
    for (const item of state.pickups) if (item.type === 'xp') { item.x = state.player.x + rand(-45, 45); item.y = state.player.y + rand(-45, 45); }
    showBanner('VACUUM FIELD', '#73b7ff');
    showToast('引力爆发：全场经验正在被吸入');
  } else if (pickup.type === 'nuke') {
    triggerNuke(false);
  }
  burst(pickup.x, pickup.y, pickup.color, 28, 190);
}

function updateEffects(dt) {
  for (let index = state.particles.length - 1; index >= 0; index -= 1) {
    const particle = state.particles[index];
    particle.life -= dt;
    particle.px = particle.x; particle.py = particle.y;
    particle.vy += particle.gravity * dt;
    particle.x += particle.vx * dt; particle.y += particle.vy * dt;
    particle.vx *= Math.pow(0.12, dt); particle.vy *= Math.pow(0.12, dt);
  }
  compactInPlace(state.particles, (particle) => particle.life > 0);
  for (let index = state.shockwaves.length - 1; index >= 0; index -= 1) {
    const wave = state.shockwaves[index];
    wave.life -= dt;
    const progress = 1 - wave.life / wave.maxLife;
    wave.radius = wave.start + (wave.end - wave.start) * (1 - Math.pow(1 - progress, 2));
  }
  compactInPlace(state.shockwaves, (wave) => wave.life > 0);
  for (let index = state.beams.length - 1; index >= 0; index -= 1) state.beams[index].life -= dt;
  compactInPlace(state.beams, (beam) => beam.life > 0);
  for (let index = state.floaters.length - 1; index >= 0; index -= 1) {
    const floater = state.floaters[index];
    floater.life -= dt; floater.x += floater.vx * dt; floater.y += floater.vy * dt; floater.vy *= Math.pow(0.25, dt);
  }
  compactInPlace(state.floaters, (floater) => floater.life > 0);
  state.shake *= Math.pow(0.035, dt);
  state.flash = Math.max(0, state.flash - dt * 3);
}

function updateSpawner(dt) {
  const hordeMultiplier = state.elapsed < state.hordeUntil ? 8 : 1;
  const baseRate = 7.5 + state.elapsed * 0.16 + Math.pow(state.elapsed / CONFIG.duration, 2) * 12;
  state.spawnAccumulator += dt * baseRate * hordeMultiplier;
  const count = Math.min(70, Math.floor(state.spawnAccumulator));
  state.spawnAccumulator -= count;
  for (let index = 0; index < count; index += 1) spawnEnemy();
  if (!state.bossSpawned && state.elapsed >= CONFIG.bossAt) spawnBoss();
  if (state.elapsed >= state.supplyAt) {
    state.supplyAt += rand(14, 19);
    spawnPowerup();
    showToast('强化补给已落在战场上：靠近即可拾取', 1900);
  }
}

function update(dt) {
  if (state.mode !== 'running') return;
  if (state.hitStop > 0) { state.hitStop -= dt; updateEffects(dt * 0.35); return; }
  state.elapsed += dt;
  state.comboTimer -= dt;
  if (state.comboTimer <= 0 && state.combo > 0) state.combo = Math.max(0, state.combo - Math.ceil(dt * 30));
  if (state.regen > 0) state.hp = Math.min(state.maxHp, state.hp + state.regen * dt);
  for (const key of COOLDOWN_KEYS) state.cooldowns[key] = Math.max(0, state.cooldowns[key] - dt);
  updatePlayer(dt, enemyGrid);
  updateSpawner(dt);
  firePrimary(dt);
  fireDrones(dt, enemyGrid);
  fireMissiles(dt, enemyGrid);
  updateEnemyMotion(dt);
  enemyGrid.rebuild(state.enemies);
  updateOrbit(enemyGrid);
  updateBullets(dt, enemyGrid);
  updateHostileBullets(dt);
  updatePickups(dt);
  updateEffects(dt);
  compactInPlace(state.enemies, (enemy) => !enemy.dead);
  state.uiAccumulator += dt;
  if (state.uiAccumulator > 0.08) { state.uiAccumulator = 0; syncHud(); }
  if (state.elapsed >= CONFIG.duration && !state.bossSpawned) spawnBoss();
}

function directorReady(key, cooldown) {
  if (state.mode !== 'running') return false;
  if (state.cooldowns[key] > 0) { showToast(`导演指令冷却中：${Math.ceil(state.cooldowns[key])} 秒`); return false; }
  state.cooldowns[key] = cooldown;
  return true;
}

function triggerHorde() {
  if (!directorReady('horde', 18)) return;
  state.hordeUntil = state.elapsed + 7;
  spawnHorde(120);
  showBanner('EIGHTFOLD HORDE', '#ff526f');
  showToast('八倍围城：7 秒生成 ×8，已有 120 只怪贴进屏幕边缘', 3000);
  state.shake = Math.max(state.shake, 0.75);
}

function triggerOverdrive() {
  if (!directorReady('overdrive', 17)) return;
  state.overdriveUntil = state.elapsed + 10;
  showBanner('BULLET OVERDRIVE', '#70fff1');
  showToast('无限弹匣：10 秒射速 ×3、伤害 ×2', 2800);
  tone(420, 0.18, 'sawtooth', 0.045, 650);
}

function triggerElite() {
  if (!directorReady('elite', 20)) return;
  for (let index = 0; index < 8; index += 1) spawnEnemy('elite', { side: index % 4, margin: 30 + index * 6, eliteScale: 0.9 });
  showBanner('ELITE AIRDROP ×8', '#c977ff');
  showToast('八名精英已空投：全部击杀会掉落强化补给', 3000);
  state.shake = Math.max(state.shake, 0.55);
}

function triggerNuke(checkCooldown = true) {
  if (checkCooldown && !directorReady('nuke', 24)) return;
  showBanner('ORBITAL PURGE', '#ffe45c');
  showToast('轨道清场：普通敌人全部蒸发，Boss 不会被秒杀', 2800);
  state.shake = 2.1;
  state.flash = 1;
  addShockwave(state.player.x, state.player.y, '#ffe45c', 20, Math.hypot(width, height), 1.1, 13);
  for (const enemy of state.enemies) {
    if (enemy.dead) continue;
    if (enemy.boss) damageEnemy(enemy, enemy.maxHp * 0.04, { critical: false, color: '#ffe45c' });
    else killEnemy(enemy, { color: '#ffe45c' });
  }
  for (let index = 0; index < 170; index += 1) addParticle(state.player.x, state.player.y, index % 2 ? '#ffe45c' : '#ffffff', rand(150, 780), rand(0.4, 1.2), rand(2, 8));
  tone(55, 0.9, 'sawtooth', 0.11, 520);
}

function syncHud(force = false) {
  els.level.textContent = state.level;
  els.kills.textContent = formatNumber(state.kills);
  els.combo.textContent = `×${Math.max(1, state.combo)}`;
  const remaining = Math.max(0, CONFIG.duration - state.elapsed);
  els.time.textContent = remaining > 0 ? Math.ceil(remaining) : state.bossKilled ? 'CLEAR' : 'BOSS';
  els.score.textContent = formatNumber(state.score);
  els.hpFill.style.width = `${clamp(state.hp / state.maxHp * 100, 0, 100)}%`;
  els.hpText.textContent = `${Math.ceil(state.hp)} / ${state.maxHp}`;
  els.xpFill.style.width = `${clamp(state.xp / state.nextXp * 100, 0, 100)}%`;
  els.xpText.textContent = `${state.xp} / ${state.nextXp}`;
  els.damageStat.textContent = formatCompact(state.damage * (state.elapsed < state.overdriveUntil ? 2 : 1));
  els.rateStat.textContent = `${(state.fireRate * (state.elapsed < state.overdriveUntil ? 3 : 1)).toFixed(1)}/s`;
  els.shotStat.textContent = state.multishot;
  els.speedStat.textContent = Math.round(state.moveSpeed);
  els.hordeBtn.classList.toggle('active', state.elapsed < state.hordeUntil);
  els.overdriveBtn.classList.toggle('active', state.elapsed < state.overdriveUntil);
  const directorButtons = [['horde', els.hordeBtn], ['overdrive', els.overdriveBtn], ['elite', els.eliteBtn], ['nuke', els.nukeBtn]];
  for (const [key, button] of directorButtons) button.disabled = state.mode === 'running' && state.cooldowns[key] > 0;
  if (state.boss && !state.boss.dead) {
    els.bossHpFill.style.width = `${clamp(state.boss.hp / state.boss.maxHp * 100, 0, 100)}%`;
    els.bossHpText.textContent = `${Math.ceil(state.boss.hp / state.boss.maxHp * 100)}% · ${formatCompact(state.boss.hp)} HP`;
  }
  if (force) updateArsenal();
}

function drawBackground() {
  const gradient = ctx.createRadialGradient(state.player.x, state.player.y, 20, width * 0.5, height * 0.5, Math.max(width, height));
  gradient.addColorStop(0, state.elapsed < state.overdriveUntil ? '#102c38' : '#10203a');
  gradient.addColorStop(0.48, '#0a1326');
  gradient.addColorStop(1, '#050812');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalAlpha = 0.35;
  for (const star of state.stars) {
    const glow = 0.35 + Math.sin(state.elapsed * 1.5 + star.phase) * 0.25;
    ctx.fillStyle = `rgba(127,220,255,${glow})`;
    ctx.fillRect(star.x * width, star.y * height, star.size, star.size);
  }
  ctx.restore();

  const gridSize = 62;
  const offsetX = ((-state.player.x * 0.05) % gridSize + gridSize) % gridSize;
  const offsetY = ((-state.player.y * 0.05 + state.elapsed * 3) % gridSize + gridSize) % gridSize;
  ctx.strokeStyle = 'rgba(91,158,196,0.085)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = offsetX; x < width; x += gridSize) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
  for (let y = offsetY; y < height; y += gridSize) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(112,255,241,0.075)';
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 92, width - 32, height - 110);
}

function drawPickup(pickup) {
  const pulse = 1 + Math.sin(pickup.phase) * 0.18;
  ctx.save();
  ctx.translate(pickup.x, pickup.y);
  ctx.rotate(pickup.phase * 0.18);
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowColor = pickup.color;
  ctx.shadowBlur = 0;
  ctx.fillStyle = pickup.color;
  if (pickup.type === 'xp') {
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-pickup.radius * pulse, -pickup.radius * pulse, pickup.radius * 2 * pulse, pickup.radius * 2 * pulse);
  } else {
    ctx.beginPath();
    for (let index = 0; index < 8; index += 1) {
      const angle = index * Math.PI / 4;
      const radius = index % 2 ? pickup.radius * 0.55 : pickup.radius * pulse;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (!index) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 10px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText({ heal: '+', overdrive: '∞', magnet: 'U', nuke: '✺' }[pickup.type], 0, 0);
  }
  ctx.restore();
}

function drawEnemy(enemy) {
  const frozen = state.elapsed < enemy.frozenUntil;
  const bob = Math.sin(state.elapsed * (enemy.type === 'runner' ? 11 : 5) + enemy.phase) * Math.min(4, enemy.radius * 0.12);
  const scale = enemy.radius / ENEMY_TYPES[enemy.type].radius;
  ctx.save();
  ctx.translate(enemy.x, enemy.y + bob);
  ctx.globalAlpha = enemy.hitFlash > 0 ? 0.58 : 1;
  ctx.shadowColor = frozen ? '#6edbff' : enemy.color;
  ctx.shadowBlur = enemy.boss ? 8 : enemy.elite ? 4 : 0;
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.beginPath();
  ctx.ellipse(0, enemy.radius * 0.68, enemy.radius * 0.76, enemy.radius * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  if (spriteFrames[enemy.frame]) {
    const sprite = spriteFrames[enemy.frame];
    const drawHeight = enemy.radius * (enemy.boss ? 3.3 : 3.05);
    const drawWidth = drawHeight * (sprite.width / sprite.height);
    ctx.drawImage(sprite, -drawWidth / 2, -drawHeight * 0.68, drawWidth, drawHeight);
  } else {
    ctx.fillStyle = enemy.color;
    ctx.beginPath(); ctx.arc(0, 0, enemy.radius, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#101522'; ctx.beginPath(); ctx.arc(-enemy.radius * 0.3, -enemy.radius * 0.15, enemy.radius * 0.12, 0, Math.PI * 2); ctx.arc(enemy.radius * 0.3, -enemy.radius * 0.15, enemy.radius * 0.12, 0, Math.PI * 2); ctx.fill();
  }
  if (frozen) {
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = '#63d9ff';
    ctx.beginPath(); ctx.arc(0, 0, enemy.radius * 1.1, 0, Math.PI * 2); ctx.fill();
  }
  if (enemy.elite || enemy.boss) {
    ctx.globalAlpha = 0.92;
    ctx.strokeStyle = enemy.color;
    ctx.lineWidth = enemy.boss ? 4 : 2;
    ctx.beginPath(); ctx.arc(0, 0, enemy.radius * (1.05 + Math.sin(state.elapsed * 3 + enemy.phase) * 0.05), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
  if ((enemy.elite || enemy.boss || enemy.hp < enemy.maxHp) && !enemy.dead) {
    const barWidth = enemy.radius * (enemy.boss ? 1.9 : 1.5);
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(enemy.x - barWidth / 2, enemy.y - enemy.radius * 1.35, barWidth, 4);
    ctx.fillStyle = enemy.color;
    ctx.fillRect(enemy.x - barWidth / 2, enemy.y - enemy.radius * 1.35, barWidth * clamp(enemy.hp / enemy.maxHp, 0, 1), 4);
  }
}

function drawPlayer() {
  const player = state.player;
  const invulnerable = state.elapsed < state.invulnerableUntil;
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.angle);
  ctx.globalAlpha = invulnerable && Math.floor(state.elapsed * 20) % 2 ? 0.55 : 1;
  ctx.shadowColor = state.elapsed < state.overdriveUntil ? '#70fff1' : '#65a8ff';
  ctx.shadowBlur = state.elapsed < state.overdriveUntil ? 10 : 5;
  ctx.fillStyle = 'rgba(2,5,12,0.5)';
  ctx.beginPath(); ctx.ellipse(-3, 10, 22, 12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#162c49';
  ctx.strokeStyle = '#d8f8ff';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(23, 0); ctx.lineTo(8, -15); ctx.lineTo(-16, -12); ctx.lineTo(-21, 0); ctx.lineTo(-16, 12); ctx.lineTo(8, 15); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#70fff1';
  ctx.fillRect(4, -4, 27, 8);
  ctx.fillStyle = '#ffe45c';
  ctx.beginPath(); ctx.arc(-3, 0, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#65a8ff';
  ctx.fillRect(-17, -15, 7, 6); ctx.fillRect(-17, 9, 7, 6);
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = state.elapsed < state.overdriveUntil ? 'rgba(112,255,241,0.7)' : 'rgba(255,228,92,0.28)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 9]);
  ctx.beginPath(); ctx.moveTo(player.x + input.aimX * 28, player.y + input.aimY * 28); ctx.lineTo(player.x + input.aimX * 115, player.y + input.aimY * 115); ctx.stroke();
  ctx.restore();
}

function drawDronesAndOrbit() {
  if (state.drones) {
    for (let index = 0; index < state.drones; index += 1) {
      const angle = state.elapsed * 1.35 + index * Math.PI * 2 / state.drones;
      const x = state.player.x + Math.cos(angle) * (48 + state.drones * 2.5);
      const y = state.player.y + Math.sin(angle) * (48 + state.drones * 2.5);
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle + Math.PI / 2); ctx.fillStyle = '#69b8ff'; ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(7, 6); ctx.lineTo(0, 3); ctx.lineTo(-7, 6); ctx.closePath(); ctx.fill(); ctx.restore();
    }
  }
  if (state.orbit) {
    const radius = 64 + state.orbit * 4;
    ctx.save(); ctx.strokeStyle = 'rgba(170,255,117,0.12)'; ctx.beginPath(); ctx.arc(state.player.x, state.player.y, radius, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    for (let index = 0; index < state.orbit; index += 1) {
      const angle = state.elapsed * (2.4 + state.orbit * 0.08) + index * Math.PI * 2 / state.orbit;
      const x = state.player.x + Math.cos(angle) * radius;
      const y = state.player.y + Math.sin(angle) * radius;
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle + state.elapsed * 8); ctx.fillStyle = '#e6ffc7'; ctx.beginPath(); ctx.moveTo(17, 0); ctx.lineTo(-8, -6); ctx.lineTo(-3, 0); ctx.lineTo(-8, 6); ctx.closePath(); ctx.fill(); ctx.restore();
    }
  }
}

function queueProjectileSegment(x1, y1, x2, y2, color, lineWidth) {
  const roundedWidth = Math.round(lineWidth * 10) / 10;
  const key = `${color}:${roundedWidth}`;
  let batch = projectileDrawBatches.get(key);
  if (!batch) {
    batch = { color, lineWidth: roundedWidth, segments: [] };
    projectileDrawBatches.set(key, batch);
  }
  if (batch.segments.length === 0) activeProjectileDrawBatches.push(batch);
  batch.segments.push(x1, y1, x2, y2);
}

function drawProjectiles() {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  activeProjectileDrawBatches.length = 0;
  for (const bullet of state.bullets) {
    queueProjectileSegment(bullet.px, bullet.py, bullet.x, bullet.y, bullet.color, bullet.radius * (bullet.kind === 'missile' ? 1.2 : 1.55));
  }
  for (const bullet of state.hostileBullets) {
    queueProjectileSegment(bullet.px, bullet.py, bullet.x, bullet.y, bullet.color, bullet.radius * 1.6);
  }
  for (const batch of activeProjectileDrawBatches) {
    ctx.strokeStyle = batch.color;
    ctx.lineWidth = batch.lineWidth;
    ctx.beginPath();
    for (let index = 0; index < batch.segments.length; index += 4) {
      ctx.moveTo(batch.segments[index], batch.segments[index + 1]);
      ctx.lineTo(batch.segments[index + 2], batch.segments[index + 3]);
    }
    ctx.stroke();
    batch.segments.length = 0;
  }
  for (const bullet of state.bullets) {
    if (bullet.kind !== 'missile') continue;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(bullet.x, bullet.y, bullet.radius * 0.75, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const beam of state.beams) {
    ctx.globalAlpha = clamp(beam.life / beam.maxLife, 0, 1);
    ctx.strokeStyle = beam.color; ctx.lineWidth = beam.width * 2.5; ctx.shadowColor = beam.color; ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.moveTo(beam.x1, beam.y1); ctx.lineTo(beam.x2, beam.y2); ctx.stroke();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1, beam.width * 0.55); ctx.beginPath(); ctx.moveTo(beam.x1, beam.y1); ctx.lineTo(beam.x2, beam.y2); ctx.stroke();
  }
  ctx.restore();
}

function drawEffects() {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (const particle of state.particles) {
    ctx.globalAlpha = clamp(particle.life / particle.maxLife, 0, 1);
    ctx.strokeStyle = particle.color; ctx.lineWidth = particle.size; ctx.shadowColor = particle.color; ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.moveTo(particle.px, particle.py); ctx.lineTo(particle.x, particle.y); ctx.stroke();
  }
  for (const wave of state.shockwaves) {
    ctx.globalAlpha = clamp(wave.life / wave.maxLife, 0, 1);
    ctx.strokeStyle = wave.color; ctx.lineWidth = wave.width * (wave.life / wave.maxLife); ctx.shadowColor = wave.color; ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.arc(wave.x, wave.y, wave.radius, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const floater of state.floaters) {
    ctx.globalAlpha = clamp(floater.life / floater.maxLife, 0, 1);
    ctx.fillStyle = floater.color; ctx.shadowColor = floater.color; ctx.shadowBlur = 0;
    ctx.font = `950 ${floater.size}px system-ui, sans-serif`;
    ctx.fillText(floater.text, floater.x, floater.y);
  }
  ctx.restore();
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground();
  const shakeAmount = state.shake * 8;
  ctx.save();
  ctx.translate(rand(-shakeAmount, shakeAmount), rand(-shakeAmount, shakeAmount));
  for (const pickup of state.pickups) drawPickup(pickup);
  for (const enemy of state.enemies) drawEnemy(enemy);
  drawDronesAndOrbit();
  drawProjectiles();
  drawPlayer();
  drawEffects();
  ctx.restore();
  if (state.elapsed < state.overdriveUntil && state.mode === 'running') {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.035 + Math.sin(state.elapsed * 18) * 0.015; ctx.fillStyle = '#70fff1'; ctx.fillRect(0, 0, width, height); ctx.restore();
  }
}

function loop(timestamp) {
  const rawDt = state.lastTs ? (timestamp - state.lastTs) / 1000 : 0;
  state.lastTs = timestamp;
  const dt = Math.min(0.05, Math.max(0, rawDt));
  update(dt);
  if (timestamp - lastRenderTs >= 25) {
    lastRenderTs = timestamp;
    render();
  }
  rafId = requestAnimationFrame(loop);
}

async function finishRun(victory) {
  if (state.mode === 'result') return;
  setMode('result');
  clearTimeout(autoPickTimer);
  els.resultEyebrow.textContent = victory ? 'OMEGA ELIMINATED' : 'RUN TERMINATED';
  els.resultTitle.textContent = victory ? '尸潮被彻底打穿了' : '你被尸潮埋住了';
  els.resultDescription.textContent = victory ? '这次广告没有在最爽的时候切走，终局怪物也真的能被打死。' : '所有强化都会重新洗牌。下一局先叠移动、穿透或爆炸，更容易冲出包围。';
  els.finalScore.textContent = formatNumber(state.score);
  els.finalKills.textContent = formatNumber(state.kills);
  els.finalLevel.textContent = state.level;
  els.finalRank.textContent = '—';
  els.newBest.classList.add('hidden');
  tone(victory ? 520 : 90, victory ? 0.5 : 0.7, victory ? 'triangle' : 'sawtooth', 0.075, victory ? 520 : -40);
  try {
    const result = await extCall({ action: 'submit_run', score: Math.round(state.score), kills: state.kills, duration: Math.round(state.elapsed), level: state.level, victory });
    if (result?.ok) {
      els.finalRank.textContent = result.rank ? `#${result.rank}` : '—';
      els.newBest.classList.toggle('hidden', !result.is_best);
      renderLeaderboard(result.leaderboard || []);
    }
  } catch {
    // 离线时不阻塞结算，本局仍完整可玩。
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function renderLeaderboard(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    els.leaderboardList.innerHTML = '<li class="empty">还没有战绩，第一局由你来开榜。</li>';
    return;
  }
  els.leaderboardList.innerHTML = rows.slice(0, 10).map((row) => `<li><span>${escapeHtml(row.display_name || row.username)}</span><b>${formatCompact(row.score || 0)}</b><small>Lv.${row.level || 1} · ${formatCompact(row.kills || 0)} 杀</small></li>`).join('');
}

async function loadProfile() {
  try {
    const [identity, profile] = await Promise.all([extCall({ action: 'whoami' }), extCall({ action: 'get_profile' })]);
    if (identity?.ok) els.identityValue.textContent = identity.display_name || identity.username || '玩家';
    if (profile?.ok) renderLeaderboard(profile.leaderboard || []);
  } catch {
    els.identityValue.textContent = '离线玩家';
    els.leaderboardList.innerHTML = '<li class="empty">排行榜暂时离线，不影响游戏。</li>';
  }
}

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  input.pointerX = event.clientX - rect.left;
  input.pointerY = event.clientY - rect.top;
  input.pointerActive = true;
}

function setupStick(element, kind) {
  let pointerId = null;
  const knob = element.querySelector('i');
  const updateStick = (event) => {
    const rect = element.getBoundingClientRect();
    let x = event.clientX - (rect.left + rect.width / 2);
    let y = event.clientY - (rect.top + rect.height / 2);
    const max = rect.width * 0.34;
    const length = Math.hypot(x, y);
    if (length > max) { x = x / length * max; y = y / length * max; }
    knob.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    const normalizedX = x / max;
    const normalizedY = y / max;
    if (kind === 'move') { input.moveX = normalizedX; input.moveY = normalizedY; }
    else if (Math.hypot(normalizedX, normalizedY) > 0.12) { const aimLength = Math.hypot(normalizedX, normalizedY); input.aimX = normalizedX / aimLength; input.aimY = normalizedY / aimLength; input.pointerActive = false; }
  };
  const release = (event) => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    knob.style.transform = 'translate(-50%, -50%)';
    if (kind === 'move') { input.moveX = 0; input.moveY = 0; }
    element.releasePointerCapture?.(event.pointerId);
  };
  element.addEventListener('pointerdown', (event) => { pointerId = event.pointerId; element.setPointerCapture?.(event.pointerId); updateStick(event); event.preventDefault(); });
  element.addEventListener('pointermove', (event) => { if (pointerId === event.pointerId) { updateStick(event); event.preventDefault(); } });
  element.addEventListener('pointerup', release);
  element.addEventListener('pointercancel', release);
}

window.addEventListener('resize', resize);
canvas.addEventListener('pointermove', pointerPosition);
canvas.addEventListener('pointerdown', (event) => { pointerPosition(event); ensureAudio(); });
window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', 'p', 'escape', '1', '2', '3'].includes(key)) event.preventDefault();
  input.keys.add(key);
  if (key === 'shift' && !event.repeat) startDash();
  if ((key === 'p' || key === 'escape') && !event.repeat && ['running', 'paused'].includes(state.mode)) pauseGame();
  if (state.mode === 'upgrade' && ['1', '2', '3'].includes(key)) els.upgradeOptions.querySelectorAll('.upgrade-option')[Number(key) - 1]?.click();
});
window.addEventListener('keyup', (event) => input.keys.delete(event.key.toLowerCase()));
window.addEventListener('blur', () => { input.keys.clear(); if (state.mode === 'running') pauseGame(); });

els.startBtn.addEventListener('click', startRun);
els.resumeBtn.addEventListener('click', pauseGame);
els.pauseBtn.addEventListener('click', pauseGame);
els.restartBtn.addEventListener('click', startRun);
els.againBtn.addEventListener('click', startRun);
els.menuBtn.addEventListener('click', returnToMenu);
els.soundBtn.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('bullet-heaven-muted', muted ? '1' : '0');
  els.soundBtn.textContent = muted ? '声音 OFF' : '声音 ON';
  if (!muted) tone(620, 0.08, 'triangle', 0.04, 120);
});
els.directorToggle.addEventListener('click', () => {
  const collapsed = els.directorPanel.classList.toggle('collapsed');
  els.directorToggle.textContent = collapsed ? '+' : '−';
});
els.hordeBtn.addEventListener('click', triggerHorde);
els.overdriveBtn.addEventListener('click', triggerOverdrive);
els.eliteBtn.addEventListener('click', triggerElite);
els.nukeBtn.addEventListener('click', () => triggerNuke(true));

setupStick(els.moveStick, 'move');
setupStick(els.aimStick, 'aim');

window.__bulletHeavenDebug = Object.freeze({
  snapshot: () => ({ mode: state.mode, elapsed: state.elapsed, enemies: state.enemies.length, bullets: state.bullets.length, hostileBullets: state.hostileBullets.length, pickups: state.pickups.length, particles: state.particles.length, kills: state.kills, level: state.level, hp: state.hp, bossSpawned: state.bossSpawned, bossHp: state.boss?.hp || 0, upgrades: { ...state.upgradeLevels } }),
  start: startRun,
  grantUpgrade(id, count = 1) { const upgrade = UPGRADE_MAP.get(id); if (!upgrade) return false; for (let index = 0; index < count; index += 1) { upgrade.apply(); if (upgrade.max < 90) state.upgradeLevels[id] = Math.min(upgrade.max, upgradeLevel(id) + 1); } updateArsenal(); syncHud(true); return true; },
  grantXp,
  triggerHorde,
  triggerOverdrive,
  triggerElite,
  triggerNuke: () => triggerNuke(false),
  spawnBoss,
  setHealth(value) { state.hp = clamp(Number(value) || 0, 0, state.maxHp); syncHud(); },
});

resize();
resetRun();
setMode('menu');
els.soundBtn.textContent = muted ? '声音 OFF' : '声音 ON';
loadProfile();
rafId = requestAnimationFrame(loop);
