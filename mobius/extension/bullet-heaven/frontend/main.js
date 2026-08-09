import { extCall } from '/extension/_sdk/ext.js';
import { createMusicEngine } from './music-engine.js?v=0.3.0';

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
const DIRECTOR_COOLDOWNS = Object.freeze({ horde: 22, overdrive: 20, elite: 26, nuke: 34, ironCurtain: 30, tesla: 28, supply: 32, freeze: 30 });
const COOLDOWN_KEYS = Object.freeze(Object.keys(DIRECTOR_COOLDOWNS));
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
  ironCurtainBtn: document.getElementById('ironCurtainBtn'),
  teslaBtn: document.getElementById('teslaBtn'),
  supplyBtn: document.getElementById('supplyBtn'),
  freezeBtn: document.getElementById('freezeBtn'),
  autoPick: document.getElementById('autoPickInput'),
  bossHud: document.getElementById('bossHud'),
  bossName: document.getElementById('bossName'),
  bossHpText: document.getElementById('bossHpText'),
  bossHpFill: document.getElementById('bossHpFill'),
  toast: document.getElementById('toast'),
  banner: document.getElementById('banner'),
  damageFlash: document.getElementById('damageFlash'),
  upgradeFlash: document.getElementById('upgradeFlash'),
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
let musicBus = null;
let audioMaster = null;
let audioCompressor = null;
let muted = localStorage.getItem('bullet-heaven-muted') === '1';
let lastRenderTs = 0;
const audioLastPlayed = new Map();
const noiseBufferCache = new Map();

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
  infiniteRayHits: 0,
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
  ironCurtainUntil: 0,
  freezeUntil: 0,
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
  cooldowns: Object.fromEntries(COOLDOWN_KEYS.map((key) => [key, 0])),
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
  pulseRings: [],
  afterimages: [],
  scorches: [],
  xpChain: { count: 0, at: 0 },
  heartbeatAt: 0,
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
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioMaster = audioCtx.createGain();
      audioMaster.gain.value = 0.72;
      audioCompressor = audioCtx.createDynamicsCompressor();
      audioCompressor.threshold.value = -18;
      audioCompressor.knee.value = 12;
      audioCompressor.ratio.value = 5;
      audioCompressor.attack.value = 0.004;
      audioCompressor.release.value = 0.16;
      audioMaster.connect(audioCompressor).connect(audioCtx.destination);
      // BGM rides its own bus into the compressor so director events can duck
      // it independently of the SFX master.
      musicBus = audioCtx.createGain();
      musicBus.gain.value = 1;
      musicBus.connect(audioCompressor);
    } catch { audioCtx = null; audioMaster = null; audioCompressor = null; musicBus = null; }
  }
  if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

const music = createMusicEngine({
  getContext: () => (muted ? null : ensureAudio()),
  getOutput: () => (ensureAudio() ? musicBus : null),
  masterVolume: 0.4,
});
let musicMode = 'off'; // off | menu | battle | boss
let musicDuck = { amount: 1, until: 0 };

function duckMusic(amount = 0.3, seconds = 0.8) {
  musicDuck = { amount, until: performance.now() + seconds * 1000 };
  if (musicBus && audioCtx) {
    const now = audioCtx.currentTime;
    musicBus.gain.cancelScheduledValues(now);
    musicBus.gain.setValueAtTime(musicBus.gain.value, now);
    musicBus.gain.linearRampToValueAtTime(amount, now + 0.05);
    musicBus.gain.linearRampToValueAtTime(1, now + seconds);
  }
}

function musicIntensity() {
  const threat = Math.min(1, state.enemies.length / 520);
  const timeRamp = Math.min(1, state.elapsed / 100) * 0.35;
  const overdrive = state.elapsed < state.overdriveUntil ? 0.12 : 0;
  return clamp(0.3 + threat * 0.5 + timeRamp + overdrive, 0, 1);
}

function syncMusic() {
  if (muted) return;
  if (state.mode === 'running') {
    const boss = Boolean(state.boss && !state.boss.dead);
    const target = boss ? 'boss' : 'battle';
    if (musicMode !== target) {
      musicMode = target;
      music.start({ theme: 'synthwave', intensity: musicIntensity(), boss });
    }
    music.setBossMode(boss);
    music.setIntensity(musicIntensity());
  } else if (state.mode === 'menu' || state.mode === 'result') {
    if (musicMode !== 'menu') {
      musicMode = 'menu';
      music.start({ theme: 'synthwave', intensity: 0.16, boss: false });
    }
    music.setBossMode(false);
    music.setIntensity(0.16);
  } else {
    // upgrade / paused: keep the sequencer running but pull layers down.
    music.setIntensity(0.12);
  }
}

function audioReady(tag, minGap) {
  if (!minGap) return true;
  const now = performance.now();
  const last = audioLastPlayed.get(tag) || -Infinity;
  if (now - last < minGap) return false;
  audioLastPlayed.set(tag, now);
  return true;
}

function tone(freq, duration = 0.06, type = 'square', gain = 0.025, slide = 0, tag = 'tone', minGap = 0) {
  const audio = ensureAudio();
  if (!audio || !audioReady(tag, minGap)) return;
  const now = audio.currentTime;
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), now + duration);
  amp.gain.setValueAtTime(gain, now);
  amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(amp).connect(audioMaster || audio.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

function getNoiseBuffer(duration) {
  const audio = audioCtx;
  if (!audio) return null;
  const length = Math.max(1, Math.round(audio.sampleRate * duration));
  const cached = noiseBufferCache.get(length);
  if (cached) return cached;
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) {
    const hashed = Math.sin(index * 12.9898 + length * 0.017) * 43758.5453;
    const noise = (hashed - Math.floor(hashed)) * 2 - 1;
    data[index] = noise * (1 - index / data.length * 0.35);
  }
  noiseBufferCache.set(length, buffer);
  return buffer;
}

function noiseBurst(duration = 0.08, gain = 0.03, filterFrequency = 1800, tag = 'noise', minGap = 0) {
  const audio = ensureAudio();
  if (!audio || !audioReady(tag, minGap)) return;
  const source = audio.createBufferSource();
  const filter = audio.createBiquadFilter();
  const amp = audio.createGain();
  source.buffer = getNoiseBuffer(duration);
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(filterFrequency, audio.currentTime);
  filter.Q.value = 0.65;
  const now = audio.currentTime;
  amp.gain.setValueAtTime(gain, now);
  amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  source.connect(filter).connect(amp).connect(audioMaster || audio.destination);
  source.start(now);
  source.stop(now + duration + 0.015);
}

function playPickupSound(type) {
  if (type === 'xp') {
    tone(760, 0.025, 'triangle', 0.008, 80, 'pickup-xp', 70);
    return;
  }
  const profiles = {
    heal: [520, 360, '#69ff9a'],
    overdrive: [420, 650, '#70fff1'],
    magnet: [620, 240, '#76d9ff'],
    nuke: [180, 820, '#ffe45c'],
  };
  const [frequency, slide, color] = profiles[type] || [520, 220, '#70fff1'];
  tone(frequency, 0.12, 'triangle', 0.04, slide, `pickup-${type}`, 80);
  noiseBurst(0.07, 0.022, frequency * 2.2, `pickup-noise-${type}`, 80);
  showBanner(type === 'heal' ? 'FIELD REPAIR' : type === 'overdrive' ? 'OVERDRIVE CORE' : type === 'magnet' ? 'GRAVITY WELL' : 'ORBITAL CHARGE', color);
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
  vignetteSprite = makeVignetteSprite(canvas.width, canvas.height);
  state.player.x = clamp(state.player.x || width * 0.5, 35, width - 35);
  state.player.y = clamp(state.player.y || height * 0.55, 105, height - 35);
  if (!state.stars.length) {
    for (let i = 0; i < 120; i += 1) state.stars.push({ x: Math.random(), y: Math.random(), size: rand(0.5, 1.8), phase: rand(0, Math.PI * 2) });
  }
}

// Pre-rendered radial glow discs: drawing light with drawImage + 'lighter' is
// far cheaper than shadowBlur or per-frame gradients on the software raster.
const glowSpriteCache = new Map();
let vignetteSprite = null;

function makeGlowSprite(color, size = 64) {
  const key = `${color}:${size}`;
  if (glowSpriteCache.has(key)) return glowSpriteCache.get(key);
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const g = sprite.getContext('2d');
  const gradient = g.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(0.22, color);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, size, size);
  glowSpriteCache.set(key, sprite);
  return sprite;
}

function drawGlow(x, y, color, radius, alpha = 1) {
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.drawImage(makeGlowSprite(color), x - radius, y - radius, radius * 2, radius * 2);
}

function makeVignetteSprite(w, h) {
  const sprite = document.createElement('canvas');
  sprite.width = Math.max(1, w);
  sprite.height = Math.max(1, h);
  const g = sprite.getContext('2d');
  const radius = Math.hypot(w, h) * 0.62;
  const gradient = g.createRadialGradient(w / 2, h / 2, radius * 0.42, w / 2, h / 2, radius);
  gradient.addColorStop(0, 'rgba(2,4,10,0)');
  gradient.addColorStop(0.72, 'rgba(2,4,10,0.18)');
  gradient.addColorStop(1, 'rgba(1,2,7,0.55)');
  g.fillStyle = gradient;
  g.fillRect(0, 0, w, h);
  return sprite;
}

// Scorch marks left by explosions: pooled, fading ground decals.
const MAX_SCORCHES = 40;
function addScorch(x, y, radius) {
  if (state.scorches.length >= MAX_SCORCHES) state.scorches.shift();
  state.scorches.push({ x, y, radius, life: 4.5, maxLife: 4.5 });
}

function drawScorches() {
  if (!state.scorches.length) return;
  ctx.save();
  for (const mark of state.scorches) {
    const t = clamp(mark.life / mark.maxLife, 0, 1);
    ctx.globalAlpha = 0.34 * t;
    ctx.fillStyle = '#04070d';
    ctx.beginPath();
    ctx.arc(mark.x, mark.y, mark.radius * (1 + (1 - t) * 0.12), 0, Math.PI * 2);
    ctx.fill();
    if (t > 0.55) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (t - 0.55) * 0.5;
      ctx.strokeStyle = '#ff9d4d';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(mark.x, mark.y, mark.radius * 0.92, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  ctx.restore();
}

// Dash afterimages: simplified tank silhouettes fading behind the player.
function pushAfterimage() {
  if (state.afterimages.length >= 8) state.afterimages.shift();
  state.afterimages.push({ x: state.player.x, y: state.player.y, angle: state.player.angle, life: 0.3, maxLife: 0.3 });
}

function drawAfterimages() {
  if (!state.afterimages.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const ghost of state.afterimages) {
    const t = clamp(ghost.life / ghost.maxLife, 0, 1);
    ctx.save();
    ctx.translate(ghost.x, ghost.y);
    ctx.rotate(ghost.angle);
    ctx.globalAlpha = t * 0.34;
    ctx.fillStyle = '#70fff1';
    ctx.fillRect(-16, -11, 30, 22);
    ctx.fillRect(10, -3, 16, 6);
    ctx.restore();
  }
  ctx.restore();
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
  { id: 'heal', icon: '✚', name: '战地急救', color: '#7affac', max: 99, desc: '立即恢复 42% 最大生命，并短暂无敌。', apply: () => { state.hp = Math.min(state.maxHp, state.hp + state.maxHp * 0.42); state.invulnerableUntil = Math.max(state.invulnerableUntil, state.elapsed + 1.2); } },
];

const UPGRADE_MAP = new Map(UPGRADES.map((upgrade) => [upgrade.id, upgrade]));

function upgradeLevel(id) { return state.upgradeLevels[id] || 0; }

function percent(value, digits = 0) { return `${(value * 100).toFixed(digits)}%`; }

function upgradePreview(upgrade) {
  const level = upgradeLevel(upgrade.id);
  const nextLevel = level + 1;
  switch (upgrade.id) {
    case 'damage': return { primary: `单发伤害 ${state.damage.toFixed(1)} → ${(state.damage * 1.32).toFixed(1)}`, secondary: '本级 +32% · 所有武器同步', badge: '+32% 伤害' };
    case 'rate': return { primary: `射速 ${state.fireRate.toFixed(1)} → ${(state.fireRate * 1.24).toFixed(1)}/秒`, secondary: '本级 +24% 射速', badge: '+24% 射速' };
    case 'multishot': return { primary: `齐射弹丸 ${state.multishot} → ${Math.min(9, state.multishot + 1)} 发`, secondary: `覆盖角度同步扩展 · 第 ${nextLevel} 级`, badge: '+1 发弹丸' };
    case 'pierce': return { primary: `额外穿透 ${state.pierce} → ${state.pierce + 1} 个目标`, secondary: '射程始终无限 · 本级 +1 穿透', badge: '+1 穿透' };
    case 'crit': return { primary: `暴击率 ${percent(state.critChance)} → ${percent(state.critChance + 0.09)}`, secondary: `暴击倍率 ${state.critDamage.toFixed(2)}× → ${(state.critDamage + 0.08).toFixed(2)}×`, badge: '+9% 暴击率' };
    case 'explosion': return { primary: `爆炸半径 ${level ? 28 + level * 11 : 0} → ${28 + nextLevel * 11}px`, secondary: `范围伤害系数 ${level ? Math.round((0.32 + level * 0.035) * 100) : 0}% → ${Math.round((0.32 + nextLevel * 0.035) * 100)}%`, badge: `爆炸 Lv.${nextLevel}` };
    case 'chain': return { primary: `触发率 ${Math.round(Math.min(0.86, 0.16 + level * 0.11) * 100)}% → ${Math.round(Math.min(0.86, 0.16 + nextLevel * 0.11) * 100)}%`, secondary: `最大跳跃 ${level ? Math.min(7, level + 1) : 0} → ${Math.min(7, nextLevel + 1)} 个`, badge: '+11% 闪电触发' };
    case 'frost': return { primary: `冻结率 ${Math.round(Math.min(0.74, 0.12 + level * 0.1) * 100)}% → ${Math.round(Math.min(0.74, 0.12 + nextLevel * 0.1) * 100)}%`, secondary: `冻结时长 ${(0.65 + level * 0.18).toFixed(2)} → ${(0.65 + nextLevel * 0.18).toFixed(2)} 秒`, badge: '+10% 冻结率' };
    case 'ricochet': return { primary: `弹射率 ${Math.round(Math.min(0.92, 0.25 + level * 0.13) * 100)}% → ${Math.round(Math.min(0.92, 0.25 + nextLevel * 0.13) * 100)}%`, secondary: '每级 +13% · 280px 智能索敌', badge: '+13% 弹射率' };
    case 'drone': return { primary: `护航无人机 ${state.drones} → ${state.drones + 1} 架`, secondary: `独立射击间隔约 ${Math.max(0.13, 0.56 - (state.drones + 1) * 0.045).toFixed(2)} 秒`, badge: '+1 无人机' };
    case 'orbit': return { primary: `旋转环刃 ${state.orbit} → ${state.orbit + 1} 枚`, secondary: `单次伤害系数 ${Math.round((0.62 + state.orbit * 0.12) * 100)}% → ${Math.round((0.62 + (state.orbit + 1) * 0.12) * 100)}%`, badge: '+1 环刃' };
    case 'missile': return { primary: `导弹等级 ${state.missile} → ${state.missile + 1}`, secondary: `单发伤害系数 ${Math.round((3.8 + state.missile * 0.65) * 100)}% → ${Math.round((3.8 + (state.missile + 1) * 0.65) * 100)}%`, badge: `导弹 Lv.${nextLevel}` };
    case 'bulletSize': return { primary: `弹丸直径 ${(state.bulletSize * 2).toFixed(1)} → ${(state.bulletSize * 2 * 1.19).toFixed(1)}px`, secondary: '弹丸 +19% · 伤害 +10%', badge: '+19% 弹丸' };
    case 'speed': return { primary: `移动速度 ${Math.round(state.moveSpeed)} → ${Math.round(state.moveSpeed * 1.14)}`, secondary: '本级 +14% · 冲刺冷却同步缩短', badge: '+14% 移速' };
    case 'maxHp': return { primary: `最大生命 ${state.maxHp} → ${state.maxHp + 25}`, secondary: `立即回复 25 · 增幅 ${Math.round(25 / state.maxHp * 100)}%`, badge: '+25 最大生命' };
    case 'armor': return { primary: `伤害减免 ${percent(state.armor)} → ${percent(state.armor + 0.08)}`, secondary: '本级 +8% · 同步增强冲刺撞击', badge: '+8% 减伤' };
    case 'regen': return { primary: `每秒回复 ${state.regen.toFixed(1)} → ${(state.regen + 0.8).toFixed(1)} HP`, secondary: '每分钟额外恢复 48 HP', badge: '+0.8 HP/秒' };
    case 'magnet': return { primary: `拾取半径 ${Math.round(state.pickupRange)} → ${Math.round(state.pickupRange + 75)}px`, secondary: `本级范围 +${Math.round(75 / state.pickupRange * 100)}%`, badge: '+75px 拾取范围' };
    case 'lifesteal': return { primary: `击杀吸血率 ${percent(state.lifesteal, 1)} → ${percent(state.lifesteal + 0.035, 1)}`, secondary: '本级 +3.5% · 精英/Boss 倍率更高', badge: '+3.5% 吸血' };
    case 'critPower': return { primary: `暴击倍率 ${state.critDamage.toFixed(2)}× → ${(state.critDamage + 0.45).toFixed(2)}×`, secondary: '本级倍率 +0.45×', badge: '+0.45× 暴伤' };
    case 'velocity': return { primary: `弹速 ${Math.round(state.bulletSpeed)} → ${Math.round(state.bulletSpeed * 1.22)}`, secondary: '弹速 +22% · 射速 +5%', badge: '+22% 弹速' };
    case 'spread': return { primary: `散射角 ${(state.spread * 180 / Math.PI).toFixed(1)}° → ${(state.spread * 0.78 * 180 / Math.PI).toFixed(1)}°`, secondary: '散射 -22% · 全武器伤害 +12%', badge: '-22% 散射' };
    case 'overclock': return { primary: '永久伤害 +15% · 射速 +10%', secondary: '立即获得 6 秒：射速 ×3、伤害 ×2', badge: '6秒过载核心' };
    case 'heal': return { primary: '立即恢复最大生命的 42%', secondary: '同时获得 1.2 秒完全免伤', badge: '+42% 生命' };
    default: return { primary: `Lv.${level} → Lv.${nextLevel}`, secondary: upgrade.desc, badge: `Lv.${nextLevel}` };
  }
}

function resetRun() {
  Object.assign(state, {
    elapsed: 0, score: 0, kills: 0, combo: 0, maxCombo: 0, comboTimer: 0, infiniteRayHits: 0,
    level: 1, xp: 0, nextXp: 14, pendingLevelUps: 0,
    hp: 100, maxHp: 100, armor: 0, regen: 0,
    damage: 18, fireRate: 12, bulletSpeed: 760, bulletSize: 4.2, moveSpeed: 260,
    multishot: 1, spread: 0.105, pierce: 0, critChance: 0.06, critDamage: 2,
    explosion: 0, chain: 0, frost: 0, ricochet: 0, drones: 0, orbit: 0,
    missile: 0, lifesteal: 0, pickupRange: 90,
    overdriveUntil: 0, hordeUntil: 0, ironCurtainUntil: 0, freezeUntil: 0, invulnerableUntil: 1.2,
    fireAccumulator: 0, spawnAccumulator: 0, droneAccumulator: 0, missileAccumulator: 0,
    healAccumulator: 0, supplyAt: 15, bossSpawned: false, bossKilled: false, boss: null,
    shake: 0, flash: 0, hitStop: 0, uiAccumulator: 0,
    cooldowns: Object.fromEntries(COOLDOWN_KEYS.map((key) => [key, 0])),
    upgradeLevels: {}, enemies: [], bullets: [], hostileBullets: [], pickups: [], particles: [], shockwaves: [], beams: [], floaters: [],
    pulseRings: [], afterimages: [], scorches: [],
  });
  state.xpChain.count = 0;
  state.xpChain.at = 0;
  state.heartbeatAt = 0;
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
  tone(460, 0.08, 'triangle', 0.045, 180, 'run-start');
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
    const preview = upgradePreview(upgrade);
    return `<button class="upgrade-option" type="button" data-upgrade="${upgrade.id}" style="--upgrade-color:${upgrade.color}">
      <kbd>${index + 1}</kbd><i>${upgrade.icon}</i><h3>${upgrade.name}</h3><p>${upgrade.desc}</p>
      <div class="upgrade-values"><b>${preview.primary}</b><span>${preview.secondary}</span></div>
      <small>${upgrade.max >= 90 ? '即时强化' : `Lv.${level} → Lv.${level + 1} / ${upgrade.max}`}</small>
    </button>`;
  }).join('');
  els.upgradeCountdown.textContent = els.autoPick.checked ? '挂机模式：2.5 秒后自动选择' : '选择后立刻恢复战斗';
  els.upgradeOptions.querySelectorAll('.upgrade-option').forEach((button) => {
    button.addEventListener('click', () => selectUpgrade(button.dataset.upgrade));
  });
  clearTimeout(autoPickTimer);
  if (els.autoPick.checked) autoPickTimer = window.setTimeout(() => selectUpgrade(pick(options).id), 2500);
  tone(680, 0.12, 'triangle', 0.045, 280, 'upgrade-open');
}

function selectUpgrade(id) {
  if (state.mode !== 'upgrade') return;
  const upgrade = UPGRADE_MAP.get(id);
  if (!upgrade) return;
  clearTimeout(autoPickTimer);
  const preview = upgradePreview(upgrade);
  upgrade.apply();
  if (upgrade.max < 90) state.upgradeLevels[id] = upgradeLevel(id) + 1;
  state.pendingLevelUps = Math.max(0, state.pendingLevelUps - 1);
  burst(state.player.x, state.player.y, upgrade.color, 68, 320);
  addShockwave(state.player.x, state.player.y, '#ffffff', 8, 95, 0.38, 3);
  addShockwave(state.player.x, state.player.y, upgrade.color, 18, 190, 0.72, 7);
  addShockwave(state.player.x, state.player.y, upgrade.color, 30, 320, 1.05, 3);
  for (let index = 0; index < 12; index += 1) {
    const angle = index * Math.PI * 2 / 12;
    addBeam(state.player.x, state.player.y, state.player.x + Math.cos(angle) * Math.max(width, height) * 0.42, state.player.y + Math.sin(angle) * Math.max(width, height) * 0.42, upgrade.color, 2.5, 0.36);
  }
  state.shake = Math.max(state.shake, 0.62);
  els.upgradeFlash.style.setProperty('--upgrade-flash-color', upgrade.color);
  els.upgradeFlash.classList.remove('active');
  void els.upgradeFlash.offsetWidth;
  els.upgradeFlash.classList.add('active');
  showBanner(`${upgrade.name} · ${preview.badge}`, upgrade.color);
  addFloater(state.player.x, state.player.y - 52, preview.badge, upgrade.color, 18, 1.15);
  updateArsenal();
  syncHud(true);
  tone(820, 0.16, 'triangle', 0.055, 420, 'upgrade-select');
  noiseBurst(0.14, 0.032, 1500, 'upgrade-select-noise');
  // Major-triad resolution on top of the whoosh.
  [523, 659, 784].forEach((freq, index) => window.setTimeout(() => tone(freq, 0.14, 'triangle', 0.032, 30, 'upgrade-chord'), 60 + index * 70));
  duckMusic(0.4, 0.7);
  if (state.pendingLevelUps > 0) window.setTimeout(openUpgrade, 180);
  else { setMode('running'); state.lastTs = performance.now(); }
}

function updateArsenal() {
  const items = [
    { icon: '▰', name: '脉冲步枪', detail: `${state.multishot} 发 · ${state.pierce} 穿透 · 伤害 ${formatCompact(state.damage)}`, level: `Lv.${Math.max(1, upgradeLevel('damage') + upgradeLevel('rate') + 1)}`, color: '#ffe45c', active: true },
    { icon: '✺', name: '高爆弹头', detail: `半径 ${state.explosion ? 28 + state.explosion * 11 : 0}px · ${Math.round((0.32 + state.explosion * 0.035) * 100)}% 范围伤害`, level: `Lv.${state.explosion}`, color: '#ff9d4d', active: state.explosion > 0 },
    { icon: 'ϟ', name: '连锁闪电', detail: `${Math.round(Math.min(0.86, 0.16 + state.chain * 0.11) * 100)}% 触发 · ${Math.min(7, state.chain + 1)} 跳`, level: `Lv.${state.chain}`, color: '#c977ff', active: state.chain > 0 },
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
    state.hitStop = Math.max(state.hitStop, 0.16);
    addShockwave(enemy.x, enemy.y, '#ff365f', 30, 360, 1.25);
    addShockwave(enemy.x, enemy.y, '#ffffff', 12, 220, 0.7);
    tone(82, 0.7, 'sawtooth', 0.08, -25, 'boss-spawn');
    tone(41, 1.1, 'sine', 0.12, 12, 'boss-spawn-sub');
    noiseBurst(0.28, 0.045, 160, 'boss-spawn-noise');
    duckMusic(0.3, 1.1);
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
  state.pickups.push({ x, y, type, value, color: colors[type], radius: type === 'xp' ? 5 : 12, phase: rand(0, Math.PI * 2), life: type === 'xp' ? 28 : 20, vx: 0, vy: 0 });
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
  if (state.floaters.length > 120) {
    // Under heavy load, only critical/announced floaters survive the cap.
    if (size < 14) return;
    state.floaters.shift();
  }
  // Damage numbers get tossed with a horizontal impulse + gravity instead of
  // drifting straight up — reads far more physical in a crowd.
  state.floaters.push({ x, y, text, color, size, life, maxLife: life, vx: rand(-46, 46), vy: rand(-118, -78), gravity: 210 });
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
  if (audioReady('primary-fire', 48)) {
    tone(180 + Math.random() * 35, 0.025, 'square', 0.009, -35, 'primary-fire');
    if (Math.random() < 0.4) noiseBurst(0.014, 0.006, 2600, 'primary-fire-crack');
  }
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
  tone(110, 0.09, 'sawtooth', 0.025, 90, 'missile-launch', 90);
  noiseBurst(0.06, 0.018, 520, 'missile-launch-noise', 90);
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
  if (!enemy.boss && (options.exploded || enemy.killedByExplosion || enemy.elite || enemy.type === 'tank')) addScorch(enemy.x, enemy.y, enemy.radius * (enemy.elite ? 2.6 : 1.9));
  if (!enemy.boss && !enemy.elite && audioReady('grind-kill', 90)) {
    // Regular kills finally make a sound — a tiny layered crunch.
    noiseBurst(0.05, 0.02, 950 + Math.random() * 700, 'grind-kill-noise');
    tone(150 + Math.random() * 40, 0.05, 'sine', 0.018, -70, 'grind-kill-thump');
  }
  if (enemy.boss) {
    state.bossKilled = true;
    state.boss = null;
    els.bossHud.classList.add('hidden');
    state.shake = 2.6;
    state.hitStop = 0.18;
    showBanner('OMEGA ANNIHILATED', '#ffe45c');
    tone(65, 0.8, 'sawtooth', 0.1, 360, 'boss-kill');
    noiseBurst(0.42, 0.065, 110, 'boss-kill-noise');
    duckMusic(0.22, 1.6);
    window.setTimeout(() => finishRun(true), 1200);
  } else if (enemy.elite) {
    state.shake = Math.max(state.shake, 0.45);
    state.hitStop = Math.max(state.hitStop, 0.025);
    tone(120, 0.07, 'sawtooth', 0.025, -30, 'elite-kill', 110);
  }
  if (state.combo > 0 && state.combo % 100 === 0) {
    showBanner(`${state.combo} KILL RAMPAGE`, '#ffe45c');
    state.overdriveUntil = Math.max(state.overdriveUntil, state.elapsed + 3);
    state.hitStop = Math.max(state.hitStop, 0.08);
    // Pentatonic rampage arpeggio.
    [523, 659, 784, 1047].forEach((freq, index) => {
      window.setTimeout(() => tone(freq, 0.11, 'triangle', 0.045, 40, 'rampage'), index * 62);
    });
  }
}

function explode(x, y, radius, damage, color, grid, excludeId = null) {
  addShockwave(x, y, color, 6, radius, 0.32 + radius / 600, Math.max(3, radius / 24));
  burst(x, y, color, Math.min(36, Math.round(radius / 4)), radius * 1.7);
  if (radius >= 34) addScorch(x, y, radius * 0.72);
  if (audioReady('blast-boom', 70)) {
    noiseBurst(0.24, 0.05, 300 + radius * 4, 'blast-boom-noise');
    tone(120 + radius, 0.18, 'sine', 0.05, -(60 + radius * 0.5), 'blast-boom-sub');
  }
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
    if ((player.dashGhostAt || 0) <= state.elapsed) { player.dashGhostAt = state.elapsed + 0.03; pushAfterimage(); }
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
  state.invulnerableUntil = Math.max(state.invulnerableUntil, state.elapsed + 0.28);
  addShockwave(player.x, player.y, '#70fff1', 8, 75, 0.32, 4);
  tone(260, 0.08, 'sawtooth', 0.035, 280, 'dash', 120);
  noiseBurst(0.055, 0.022, 1100, 'dash-noise', 120);
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
  state.hitStop = Math.max(state.hitStop, 0.05);
  els.damageFlash.classList.add('active');
  window.setTimeout(() => els.damageFlash.classList.remove('active'), 80);
  addFloater(state.player.x, state.player.y - 25, `-${Math.ceil(reduced)}`, '#ff526f', 18, 0.8);
  const angle = Math.atan2(state.player.y - sourceY, state.player.x - sourceX);
  state.player.vx += Math.cos(angle) * 180;
  state.player.vy += Math.sin(angle) * 180;
  burst(state.player.x, state.player.y, '#ff526f', 22, 230);
  tone(95, 0.16, 'sawtooth', 0.07, -45, 'player-hit', 90);
  tone(1150, 0.05, 'square', 0.02, -300, 'player-hit-pain', 90);
  noiseBurst(0.09, 0.032, 240, 'player-hit-noise', 90);
  if (state.hp <= 0) finishRun(false);
}

function resolveInfiniteRay(bullet, grid) {
  if (bullet.kind === 'missile' || bullet.pierce < 0) return 0;
  const speed = Math.hypot(bullet.vx, bullet.vy) || 1;
  const directionX = bullet.vx / speed;
  const directionY = bullet.vy / speed;
  const candidates = [];
  for (const enemy of state.enemies) {
    if (enemy.dead || bullet.hitIds.includes(enemy.id)) continue;
    const relativeX = enemy.x - bullet.x;
    const relativeY = enemy.y - bullet.y;
    const projection = relativeX * directionX + relativeY * directionY;
    if (projection <= 0) continue;
    const perpendicular = Math.abs(relativeX * directionY - relativeY * directionX);
    if (perpendicular > bullet.radius + enemy.radius * 0.72) continue;
    candidates.push({ enemy, projection });
  }
  if (!candidates.length) return 0;
  candidates.sort((left, right) => left.projection - right.projection);
  let hitCount = 0;
  let originX = bullet.x;
  let originY = bullet.y;
  for (const candidate of candidates) {
    if (bullet.pierce < 0) break;
    if (candidate.enemy.dead) continue;
    const impactX = bullet.x + directionX * candidate.projection;
    const impactY = bullet.y + directionY * candidate.projection;
    bullet.hitIds.push(candidate.enemy.id);
    const critical = Math.random() < state.critChance;
    damageEnemy(candidate.enemy, bullet.damage, { critical, color: bullet.color, frost: bullet.frost });
    addBeam(originX, originY, impactX, impactY, bullet.color, Math.max(1.5, bullet.radius * 0.72), 0.12);
    burst(impactX, impactY, bullet.color, 5, 75);
    if (bullet.explosive > 0) {
      const radius = 28 + bullet.explosive * 11;
      explode(impactX, impactY, radius, bullet.damage * (0.32 + bullet.explosive * 0.035), bullet.color, grid, candidate.enemy.id);
      if (candidate.enemy.dead) candidate.enemy.killedByExplosion = true;
    }
    if (bullet.chain > 0 && Math.random() < Math.min(0.86, 0.16 + bullet.chain * 0.11)) {
      chainLightning(candidate.enemy, Math.min(7, bullet.chain + 1), bullet.damage * 0.75, grid, bullet.hitIds);
    }
    bullet.pierce -= 1;
    hitCount += 1;
    state.infiniteRayHits += 1;
    originX = impactX;
    originY = impactY;
  }
  return hitCount;
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
      resolveInfiniteRay(bullet, grid);
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
      if (hit.dead) hit.killedByExplosion = true;
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
      // Spiral vacuum: tangential wobble + exponential pull reads as suction.
      const pull = 190 + Math.pow(range - Math.min(distance, range), 1.35) * 6;
      const spiral = Math.sin(state.elapsed * 9 + pickup.phase) * 0.55;
      const dirX = dx / distance;
      const dirY = dy / distance;
      pickup.vx = (dirX - dirY * spiral) * pull;
      pickup.vy = (dirY + dirX * spiral) * pull;
      pickup.x += pickup.vx * dt;
      pickup.y += pickup.vy * dt;
    } else {
      pickup.vx = 0;
      pickup.vy = 0;
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
    // Vampire-Survivors-style pickup ladder: chained pickups climb a
    // pentatonic scale so vacuuming a field sounds rewarding.
    const chain = state.elapsed - state.xpChain.at < 1.1 ? state.xpChain.count + 1 : 0;
    state.xpChain.count = chain;
    state.xpChain.at = state.elapsed;
    const PENTA = [660, 742.5, 880, 990, 1173.3, 1320, 1485, 1760];
    tone(PENTA[Math.min(chain, PENTA.length - 1)], 0.045, 'triangle', 0.016, 30, 'pickup-xp', 46);
  } else if (pickup.type === 'heal') {
    state.hp = Math.min(state.maxHp, state.hp + state.maxHp * 0.32);
    showToast('急救包：恢复 32% 最大生命');
    addFloater(state.player.x, state.player.y - 30, '+HEAL', '#69ff9a', 16, 0.8);
    playPickupSound('heal');
  } else if (pickup.type === 'overdrive') {
    state.overdriveUntil = Math.max(state.overdriveUntil, state.elapsed + 9);
    showBanner('INFINITE MAGAZINE', '#ffe45c');
    showToast('无限弹匣：9 秒射速 ×3、伤害 ×2');
    playPickupSound('overdrive');
  } else if (pickup.type === 'magnet') {
    for (const item of state.pickups) if (item.type === 'xp') { item.x = state.player.x + rand(-45, 45); item.y = state.player.y + rand(-45, 45); }
    showBanner('VACUUM FIELD', '#73b7ff');
    showToast('引力爆发：全场经验正在被吸入');
    playPickupSound('magnet');
  } else if (pickup.type === 'nuke') {
    triggerNuke(false);
    playPickupSound('nuke');
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
    floater.life -= dt;
    floater.vy += (floater.gravity || 0) * dt;
    floater.x += floater.vx * dt;
    floater.y += floater.vy * dt;
    floater.vx *= Math.pow(0.3, dt);
  }
  compactInPlace(state.floaters, (floater) => floater.life > 0);
  for (let index = state.pulseRings.length - 1; index >= 0; index -= 1) state.pulseRings[index].life -= dt;
  compactInPlace(state.pulseRings, (ring) => ring.life > 0);
  for (let index = state.afterimages.length - 1; index >= 0; index -= 1) state.afterimages[index].life -= dt;
  compactInPlace(state.afterimages, (ghost) => ghost.life > 0);
  for (let index = state.scorches.length - 1; index >= 0; index -= 1) state.scorches[index].life -= dt;
  compactInPlace(state.scorches, (mark) => mark.life > 0);
  state.shake *= Math.pow(0.035, dt);
  state.flash = Math.max(0, state.flash - dt * 3);
  // Ambient ground energy ripple keeps the battlefield alive between events.
  state.pulseTimer = (state.pulseTimer || 0) - dt;
  if (state.pulseTimer <= 0 && state.mode === 'running') {
    state.pulseTimer = 1.7;
    if (state.pulseRings.length < 4) state.pulseRings.push({ x: state.player.x, y: state.player.y, radius: 30, speed: 130, life: 1.4, maxLife: 1.4 });
  }
  // Low-HP heartbeat warning.
  if (state.mode === 'running' && state.hp < state.maxHp * 0.3 && state.hp > 0) {
    if (state.elapsed >= state.heartbeatAt) {
      state.heartbeatAt = state.elapsed + 1.05;
      tone(58, 0.09, 'sine', 0.09, -18, 'heartbeat-a', 200);
      tone(52, 0.11, 'sine', 0.075, -14, 'heartbeat-b', 420);
    }
  }
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

function directorReady(key) {
  if (state.mode !== 'running') return false;
  if (state.cooldowns[key] > 0) { showToast(`导演指令冷却中：${Math.ceil(state.cooldowns[key])} 秒`); return false; }
  state.cooldowns[key] = DIRECTOR_COOLDOWNS[key];
  return true;
}

function triggerHorde() {
  if (!directorReady('horde')) return;
  state.hordeUntil = state.elapsed + 7;
  spawnHorde(120);
  showBanner('EIGHTFOLD HORDE', '#ff526f');
  showToast('八倍围城：7 秒生成 ×8，已有 120 只怪贴进屏幕边缘', 3000);
  state.shake = Math.max(state.shake, 0.75);
}

function triggerOverdrive() {
  if (!directorReady('overdrive')) return;
  state.overdriveUntil = state.elapsed + 10;
  showBanner('BULLET OVERDRIVE', '#70fff1');
  showToast('无限弹匣：10 秒射速 ×3、伤害 ×2', 2800);
  tone(420, 0.18, 'sawtooth', 0.045, 650, 'director-overdrive');
  noiseBurst(0.12, 0.03, 900, 'director-overdrive-noise');
}

function triggerElite() {
  if (!directorReady('elite')) return;
  for (let index = 0; index < 8; index += 1) spawnEnemy('elite', { side: index % 4, margin: 30 + index * 6, eliteScale: 0.9 });
  showBanner('ELITE AIRDROP ×8', '#c977ff');
  showToast('八名精英已空投：全部击杀会掉落强化补给', 3000);
  state.shake = Math.max(state.shake, 0.55);
}

function triggerNuke(checkCooldown = true) {
  if (checkCooldown && !directorReady('nuke')) return;
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
  tone(55, 0.9, 'sawtooth', 0.11, 520, 'director-nuke');
  noiseBurst(0.5, 0.075, 90, 'director-nuke-noise');
  state.hitStop = Math.max(state.hitStop, 0.1);
  duckMusic(0.25, 1.2);
}

function triggerIronCurtain() {
  if (!directorReady('ironCurtain')) return;
  state.ironCurtainUntil = state.elapsed + 7;
  state.invulnerableUntil = Math.max(state.invulnerableUntil, state.ironCurtainUntil);
  showBanner('IRON CURTAIN ONLINE', '#ff435f');
  showToast('核心铁幕：7 秒完全免伤，履带可以直接碾入尸潮', 3000);
  addShockwave(state.player.x, state.player.y, '#ff435f', 25, 230, 0.9, 8);
  addShockwave(state.player.x, state.player.y, '#ffffff', 12, 130, 0.58, 2);
  burst(state.player.x, state.player.y, '#ff435f', 55, 260);
  state.shake = Math.max(state.shake, 0.72);
  tone(125, 0.42, 'sawtooth', 0.07, 240, 'director-curtain');
  noiseBurst(0.18, 0.045, 280, 'director-curtain-noise');
}

function triggerTeslaStorm() {
  if (!directorReady('tesla')) return;
  const targets = state.enemies.filter((enemy) => !enemy.dead).sort((left, right) => {
    const threatLeft = (left.boss ? 100000 : left.elite ? 10000 : left.type === 'shooter' ? 1000 : 0) + left.hp;
    const threatRight = (right.boss ? 100000 : right.elite ? 10000 : right.type === 'shooter' ? 1000 : 0) + right.hp;
    return threatRight - threatLeft;
  }).slice(0, 36);
  for (const [index, enemy] of targets.entries()) {
    const originX = index % 2 ? state.player.x : clamp(enemy.x + rand(-160, 160), 0, width);
    const originY = index % 2 ? state.player.y : 85;
    addBeam(originX, originY, enemy.x, enemy.y, index % 3 ? '#a96cff' : '#f0d2ff', 3.2, 0.34);
    damageEnemy(enemy, state.damage * (enemy.boss ? 10 : 7), { color: '#c977ff', critical: false, frost: 1 });
  }
  showBanner(`TESLA STORM ×${targets.length}`, '#c977ff');
  showToast(`磁暴风暴：已锁定 ${targets.length} 个高威胁目标`, 3000);
  state.shake = Math.max(state.shake, 1.15);
  tone(92, 0.55, 'sawtooth', 0.07, 620, 'director-tesla');
  noiseBurst(0.28, 0.05, 720, 'director-tesla-noise');
}

function triggerSupplyDrop() {
  if (!directorReady('supply')) return;
  const types = ['heal', 'overdrive', 'magnet', 'nuke', 'heal', 'overdrive', 'magnet', 'nuke'];
  for (const [index, type] of types.entries()) {
    const angle = index * Math.PI * 2 / types.length;
    const radius = 92 + (index % 2) * 48;
    const x = clamp(state.player.x + Math.cos(angle) * radius, 38, width - 38);
    const y = clamp(state.player.y + Math.sin(angle) * radius, 112, height - 38);
    spawnPickup(x, y, type, 1);
    addBeam(x, 80, x, y, type === 'nuke' ? '#ff6d8f' : type === 'heal' ? '#69ff9a' : type === 'magnet' ? '#73b7ff' : '#ffe45c', 3, 0.48);
    addShockwave(x, y, '#ffffff', 6, 42, 0.42, 2);
  }
  for (const pickup of state.pickups) {
    if (pickup.type === 'xp' && distanceSq(pickup.x, pickup.y, state.player.x, state.player.y) < 520 * 520) {
      pickup.x = state.player.x + rand(-42, 42);
      pickup.y = state.player.y + rand(-42, 42);
    }
  }
  showBanner('WAR FACTORY DELIVERY', '#66f5a2');
  showToast('战地工厂：八件补给已装配完成，附近经验同步回收', 3200);
  tone(310, 0.24, 'square', 0.045, 260, 'director-supply');
  noiseBurst(0.16, 0.035, 950, 'director-supply-noise');
}

function triggerFreeze() {
  if (!directorReady('freeze')) return;
  state.freezeUntil = state.elapsed + 5.5;
  for (const enemy of state.enemies) {
    if (enemy.dead) continue;
    const duration = enemy.boss ? 2 : 5.5;
    enemy.frozenUntil = Math.max(enemy.frozenUntil, state.elapsed + duration);
  }
  showBanner('CHRONO FREEZE', '#69d9ff');
  showToast('时空冻结：普通怪冻结 5.5 秒，Boss 冻结 2 秒', 3000);
  addShockwave(state.player.x, state.player.y, '#69d9ff', 20, Math.hypot(width, height), 1.25, 9);
  state.shake = Math.max(state.shake, 0.62);
  tone(720, 0.48, 'triangle', 0.055, -540, 'director-freeze');
  noiseBurst(0.2, 0.035, 1800, 'director-freeze-noise');
  tone(1750, 0.5, 'sine', 0.03, -700, 'director-freeze-glass');
  duckMusic(0.45, 0.9);
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
  els.ironCurtainBtn.classList.toggle('active', state.elapsed < state.ironCurtainUntil);
  els.freezeBtn.classList.toggle('active', state.elapsed < state.freezeUntil);
  const directorButtons = [
    ['horde', els.hordeBtn], ['overdrive', els.overdriveBtn], ['elite', els.eliteBtn], ['nuke', els.nukeBtn],
    ['ironCurtain', els.ironCurtainBtn], ['tesla', els.teslaBtn], ['supply', els.supplyBtn], ['freeze', els.freezeBtn],
  ];
  for (const [key, button] of directorButtons) {
    const remaining = state.cooldowns[key];
    const cooling = remaining > 0;
    const progress = cooling ? 1 - remaining / DIRECTOR_COOLDOWNS[key] : 1;
    button.disabled = state.mode === 'running' && cooling;
    button.classList.toggle('cooling', cooling);
    button.style.setProperty('--cooldown-progress', clamp(progress, 0, 1));
    const icon = button.querySelector('i');
    if (icon) icon.dataset.cooldown = cooling ? `${Math.ceil(remaining)}` : '';
    const status = button.querySelector('em');
    if (status) status.textContent = cooling ? `生产中 ${remaining.toFixed(1)}s` : 'READY';
  }
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

  // Pre-rendered vignette darkens the frame edges — one drawImage, no per-frame gradient work.
  if (vignetteSprite) ctx.drawImage(vignetteSprite, 0, 0);

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

  // Breathing pulse points on a sparse grid subset keep the floor alive while
  // the iteration stays cheap: step 4 covers ~1/16 of intersections.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let gx = offsetX, column = 0; gx < width; gx += gridSize, column += 1) {
    if (column % 4 !== 0) continue;
    for (let gy = offsetY, row = 0; gy < height; gy += gridSize, row += 1) {
      if (row % 4 !== (column / 4) % 4) continue;
      const pulse = Math.sin(state.elapsed * 2.1 + gx * 0.011 + gy * 0.013);
      if (pulse < 0.35) continue;
      ctx.globalAlpha = (pulse - 0.35) * 0.16;
      ctx.fillStyle = '#70fff1';
      ctx.fillRect(gx - 1.5, gy - 1.5, 3, 3);
    }
  }
  ctx.restore();

  ctx.strokeStyle = 'rgba(112,255,241,0.075)';
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 92, width - 32, height - 110);
}

function drawPickup(pickup) {
  const pulse = 1 + Math.sin(pickup.phase) * 0.18;
  const special = pickup.type !== 'xp';
  ctx.save();
  ctx.translate(pickup.x, pickup.y);
  ctx.rotate(pickup.phase * 0.18);
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowColor = pickup.color;
  ctx.shadowBlur = 0;
  // Vacuum trail: being sucked toward the player leaves a light streak.
  if (pickup.vx || pickup.vy) {
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = pickup.color;
    ctx.lineWidth = pickup.radius * 0.9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-pickup.vx * 0.05, -pickup.vy * 0.05);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  drawGlow(0, 0, pickup.color, pickup.radius * (special ? 3.4 : 2.4), special ? 0.5 : 0.32);
  ctx.fillStyle = pickup.color;
  if (pickup.type === 'xp') {
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-pickup.radius * pulse, -pickup.radius * pulse, pickup.radius * 2 * pulse, pickup.radius * 2 * pulse);
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.fillRect(-pickup.radius * 0.28, -pickup.radius * 0.28, pickup.radius * 0.56, pickup.radius * 0.56);
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
  if (special) {
    ctx.globalAlpha = 0.38 + Math.sin(pickup.phase * 1.7) * 0.12;
    ctx.strokeStyle = pickup.color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, pickup.radius * (1.65 + Math.sin(pickup.phase) * 0.12), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.arc(0, 0, pickup.radius * 2.05, pickup.phase * 0.6, pickup.phase * 0.6 + Math.PI * 0.72);
    ctx.stroke();
  }
  ctx.restore();
}

function drawEnemyMark(enemy) {
  if (enemy.type === 'grunt' || enemy.type === 'runner' || enemy.type === 'splitter') return;
  const radius = enemy.radius;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = enemy.boss ? 0.84 : enemy.elite ? 0.72 : 0.58;
  ctx.strokeStyle = enemy.color;
  ctx.fillStyle = enemy.color;
  ctx.lineWidth = enemy.boss ? 2.5 : 1.6;
  if (enemy.type === 'runner') {
    ctx.beginPath();
    ctx.moveTo(-radius * 0.72, -radius * 0.24); ctx.lineTo(-radius * 0.18, 0); ctx.lineTo(-radius * 0.72, radius * 0.24);
    ctx.moveTo(-radius * 0.28, -radius * 0.24); ctx.lineTo(radius * 0.26, 0); ctx.lineTo(-radius * 0.28, radius * 0.24);
    ctx.stroke();
  } else if (enemy.type === 'tank') {
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.77, -Math.PI * 0.72, Math.PI * 0.72);
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-radius * 0.52, radius * 0.32); ctx.lineTo(0, radius * 0.68); ctx.lineTo(radius * 0.52, radius * 0.32); ctx.stroke();
  } else if (enemy.type === 'splitter') {
    ctx.beginPath();
    ctx.moveTo(-radius * 0.5, radius * 0.42); ctx.lineTo(0, -radius * 0.45); ctx.lineTo(radius * 0.5, radius * 0.42);
    ctx.moveTo(0, -radius * 0.45); ctx.lineTo(0, radius * 0.48); ctx.stroke();
  } else if (enemy.type === 'shooter') {
    ctx.beginPath(); ctx.arc(0, 0, radius * 0.62, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-radius * 0.88, 0); ctx.lineTo(-radius * 0.46, 0); ctx.moveTo(radius * 0.46, 0); ctx.lineTo(radius * 0.88, 0); ctx.moveTo(0, -radius * 0.88); ctx.lineTo(0, -radius * 0.46); ctx.moveTo(0, radius * 0.46); ctx.lineTo(0, radius * 0.88); ctx.stroke();
  } else if (enemy.elite) {
    ctx.save(); ctx.rotate(Math.PI / 4);
    ctx.strokeRect(-radius * 0.58, -radius * 0.58, radius * 1.16, radius * 1.16);
    ctx.restore();
  } else if (enemy.boss) {
    ctx.beginPath(); ctx.arc(0, 0, radius * 0.55, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, radius * 0.83, -0.35, 1.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, radius * 0.83, 2.8, 4.35); ctx.stroke();
  }
  ctx.restore();
}

function drawEnemy(enemy) {
  const frozen = state.elapsed < enemy.frozenUntil;
  const bob = Math.sin(state.elapsed * (enemy.type === 'runner' ? 11 : 5) + enemy.phase) * Math.min(4, enemy.radius * 0.12);
  const scale = enemy.radius / ENEMY_TYPES[enemy.type].radius;
  ctx.save();
  ctx.translate(enemy.x, enemy.y + bob);
  ctx.globalAlpha = enemy.hitFlash > 0 ? 1 : 1;
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
  // Hit flash: additive white burst reads as an actual impact, unlike the old
  // alpha dip which was nearly invisible in a crowd.
  if (enemy.hitFlash > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(enemy.hitFlash / 0.08, 0, 1) * 0.85;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, -enemy.radius * 0.18, enemy.radius * 1.02, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  drawEnemyMark(enemy);
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
  const ironCurtain = state.elapsed < state.ironCurtainUntil;
  const firingPulse = 0.5 + Math.sin(state.elapsed * Math.max(8, state.fireRate * 1.8)) * 0.5;
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.angle);
  ctx.scale(1.22, 1.22);
  ctx.globalAlpha = !ironCurtain && invulnerable && Math.floor(state.elapsed * 20) % 2 ? 0.55 : 1;
  ctx.shadowColor = ironCurtain ? '#ff435f' : state.elapsed < state.overdriveUntil ? '#70fff1' : '#65a8ff';
  ctx.shadowBlur = ironCurtain ? 16 : state.elapsed < state.overdriveUntil ? 10 : 5;
  ctx.fillStyle = 'rgba(2,5,12,0.5)';
  ctx.beginPath(); ctx.ellipse(-4, 13, 30, 15, 0, 0, Math.PI * 2); ctx.fill();
  // Original retro-RTS tank silhouette: tracks, sloped hull, turret and a readable forward barrel.
  ctx.fillStyle = '#202d29';
  ctx.strokeStyle = '#9bb69d';
  ctx.lineWidth = 1.8;
  for (const y of [-12, 12]) {
    ctx.fillRect(-25, y - 5, 42, 10);
    ctx.strokeRect(-25, y - 5, 42, 10);
    ctx.fillStyle = '#536b54';
    for (let tread = -20; tread <= 12; tread += 8) ctx.fillRect(tread, y - 3.5, 4, 7);
    ctx.fillStyle = '#202d29';
  }
  ctx.fillStyle = ironCurtain ? '#6f252e' : '#556b4c';
  ctx.strokeStyle = ironCurtain ? '#ff8a98' : '#c7e1b5';
  ctx.beginPath();
  ctx.moveTo(22, 0); ctx.lineTo(12, -12); ctx.lineTo(-17, -11); ctx.lineTo(-23, -5); ctx.lineTo(-23, 5); ctx.lineTo(-17, 11); ctx.lineTo(12, 12); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#758d61';
  ctx.fillRect(-13, -8, 22, 16);
  ctx.strokeStyle = 'rgba(11,22,16,0.7)';
  ctx.strokeRect(-13, -8, 22, 16);
  ctx.fillStyle = '#41543e';
  ctx.beginPath(); ctx.arc(-1, 0, 10, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = ironCurtain ? '#ff526f' : '#c9e8a2';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(-1, 0, 9 + firingPulse * 1.5, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#9fc67e';
  ctx.fillRect(4, -3, 27, 6);
  ctx.fillStyle = '#ffe45c';
  ctx.beginPath(); ctx.arc(-1, 0, 4.5 + firingPulse * 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#b8d6a6';
  ctx.fillRect(-4, -17, 3, 7);
  ctx.strokeStyle = '#ff526f';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-18, 0); ctx.lineTo(-10, 0); ctx.moveTo(-14, -4); ctx.lineTo(-14, 4); ctx.stroke();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = ironCurtain ? 'rgba(255,67,95,0.95)' : state.elapsed < state.overdriveUntil ? 'rgba(112,255,241,0.9)' : 'rgba(101,168,255,0.72)';
  ctx.beginPath();
  ctx.moveTo(-22, -5); ctx.lineTo(-38 - Math.sin(state.elapsed * 32) * 4, 0); ctx.lineTo(-22, 5); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,244,161,0.9)';
  ctx.beginPath(); ctx.arc(32, 0, state.elapsed < state.overdriveUntil ? 3.2 : 2.2, 0, Math.PI * 2); ctx.fill();
  if (ironCurtain) {
    ctx.strokeStyle = 'rgba(255,67,95,0.78)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 34 + Math.sin(state.elapsed * 8) * 3, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = state.elapsed < state.overdriveUntil ? 'rgba(112,255,241,0.7)' : 'rgba(255,228,92,0.28)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 9]);
  ctx.beginPath(); ctx.moveTo(player.x + input.aimX * 28, player.y + input.aimY * 28); ctx.lineTo(player.x + input.aimX * 115, player.y + input.aimY * 115); ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.62;
  ctx.beginPath(); ctx.arc(player.x + input.aimX * 115, player.y + input.aimY * 115, 3.5, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  // Combo rune ring: sustained kill streaks spin up under the tank.
  if (state.combo >= 25 && state.mode === 'running') {
    const tier = Math.min(4, Math.floor(state.combo / 50));
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(state.elapsed * (0.8 + tier * 0.35));
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(0.42, 0.14 + tier * 0.08);
    ctx.strokeStyle = state.combo >= 100 ? '#ffe45c' : '#70fff1';
    ctx.lineWidth = 2;
    const segments = Math.min(12, 3 + Math.floor(state.combo / 25));
    const ringRadius = 30 + tier * 3;
    for (let index = 0; index < segments; index += 1) {
      const start = index * Math.PI * 2 / segments;
      ctx.beginPath();
      ctx.arc(0, 0, ringRadius, start, start + Math.PI / segments * 0.9);
      ctx.stroke();
    }
    ctx.restore();
  }
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

function queueProjectileSegment(x1, y1, x2, y2, color, lineWidth, halo = 0) {
  const roundedWidth = Math.round(lineWidth * 10) / 10;
  const key = `${color}:${roundedWidth}:${halo ? 1 : 0}`;
  let batch = projectileDrawBatches.get(key);
  if (!batch) {
    batch = { color, lineWidth: roundedWidth, halo: Boolean(halo), segments: [] };
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
  const haloEnabled = state.bullets.length + state.hostileBullets.length < 800;
  for (const bullet of state.bullets) {
    queueProjectileSegment(bullet.px, bullet.py, bullet.x, bullet.y, bullet.color, bullet.radius * (bullet.kind === 'missile' ? 1.2 : 1.55));
    if (haloEnabled) queueProjectileSegment(bullet.px, bullet.py, bullet.x, bullet.y, bullet.color, bullet.radius * (bullet.kind === 'missile' ? 1.2 : 1.55) * 2.6, 1);
  }
  for (const bullet of state.hostileBullets) {
    queueProjectileSegment(bullet.px, bullet.py, bullet.x, bullet.y, bullet.color, bullet.radius * 1.6);
    if (haloEnabled) queueProjectileSegment(bullet.px, bullet.py, bullet.x, bullet.y, bullet.color, bullet.radius * 4.2, 1);
  }
  // Halo pass first: wide, dim strokes under the bright cores.
  for (const pass of [1, 0]) {
    for (const batch of activeProjectileDrawBatches) {
      if ((batch.halo ? 1 : 0) !== pass) continue;
      ctx.strokeStyle = batch.color;
      ctx.lineWidth = batch.lineWidth;
      ctx.globalAlpha = pass === 1 ? 0.22 : 1;
      ctx.beginPath();
      for (let index = 0; index < batch.segments.length; index += 4) {
        ctx.moveTo(batch.segments[index], batch.segments[index + 1]);
        ctx.lineTo(batch.segments[index + 2], batch.segments[index + 3]);
      }
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  for (const batch of activeProjectileDrawBatches) batch.segments.length = 0;
  // Soft light bloom on bullet heads — capped so 800-bullet storms stay cheap.
  let glowBudget = 130;
  for (const bullet of state.bullets) {
    if (glowBudget <= 0) break;
    glowBudget -= 1;
    drawGlow(bullet.x, bullet.y, bullet.color, bullet.radius * 3.1, 0.4);
  }
  for (const bullet of state.hostileBullets) {
    if (glowBudget <= 0) break;
    glowBudget -= 1;
    drawGlow(bullet.x, bullet.y, bullet.color, bullet.radius * 2.8, 0.42);
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
  let floaterFont = '';
  for (const floater of state.floaters) {
    const lifeT = clamp(floater.life / floater.maxLife, 0, 1);
    ctx.globalAlpha = lifeT;
    // Set the font string only when the size actually changes.
    const font = `950 ${floater.size}px system-ui, sans-serif`;
    if (font !== floaterFont) { floaterFont = font; ctx.font = font; }
    if (floater.size >= 15) {
      // Big crit/announce numbers pop with a scale punch and a dark outline.
      const punch = 1 + Math.max(0, lifeT - 0.82) * 3.2;
      ctx.save();
      ctx.translate(floater.x, floater.y);
      ctx.scale(punch, punch);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(4,8,16,0.85)';
      ctx.strokeText(floater.text, 0, 0);
      ctx.fillStyle = floater.color;
      ctx.fillText(floater.text, 0, 0);
      ctx.restore();
    } else {
      ctx.fillStyle = floater.color;
      ctx.fillText(floater.text, floater.x, floater.y);
    }
  }
  ctx.restore();
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground();
  drawScorches();
  // Ambient energy ripples expand from the player position.
  if (state.pulseRings.length) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const ring of state.pulseRings) {
      ring.radius += ring.speed * 0.025;
      const t = clamp(ring.life / ring.maxLife, 0, 1);
      ctx.globalAlpha = t * 0.12;
      ctx.strokeStyle = '#70fff1';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  const shakeAmount = state.shake * 8;
  ctx.save();
  ctx.translate(rand(-shakeAmount, shakeAmount), rand(-shakeAmount, shakeAmount));
  for (const pickup of state.pickups) drawPickup(pickup);
  for (const enemy of state.enemies) drawEnemy(enemy);
  drawDronesAndOrbit();
  drawAfterimages();
  drawProjectiles();
  drawPlayer();
  drawEffects();
  ctx.restore();
  if (state.elapsed < state.overdriveUntil && state.mode === 'running') {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.035 + Math.sin(state.elapsed * 18) * 0.015; ctx.fillStyle = '#70fff1'; ctx.fillRect(0, 0, width, height); ctx.restore();
  }
  // Iron curtain edge tint: full-screen flood was invisible, edge glow is not.
  if (state.elapsed < state.ironCurtainUntil && state.mode === 'running') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pulse = 0.16 + Math.sin(state.elapsed * 10) * 0.07;
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = '#ff435f';
    ctx.lineWidth = 22;
    ctx.strokeRect(8, 88, width - 16, height - 102);
    ctx.restore();
  }
  // Low HP: pulsing red vignette corners.
  if (state.mode === 'running' && state.hp < state.maxHp * 0.3) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    const pulse = 0.1 + Math.max(0, Math.sin(state.elapsed * 5.2)) * 0.12;
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = '#ff2233';
    ctx.lineWidth = 46;
    ctx.strokeRect(-12, 76, width + 24, height - 62);
    ctx.restore();
  }
}

function loop(timestamp) {
  const rawDt = state.lastTs ? (timestamp - state.lastTs) / 1000 : 0;
  state.lastTs = timestamp;
  const dt = Math.min(0.05, Math.max(0, rawDt));
  update(dt);
  syncMusic();
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
  tone(victory ? 520 : 90, victory ? 0.5 : 0.7, victory ? 'triangle' : 'sawtooth', 0.075, victory ? 520 : -40, victory ? 'run-victory' : 'run-defeat');
  noiseBurst(victory ? 0.18 : 0.26, victory ? 0.025 : 0.04, victory ? 1200 : 150, victory ? 'run-victory-noise' : 'run-defeat-noise');
  if (victory) {
    // I-V-vi-IV pad stinger over the win jingle.
    [262, 330, 392, 523].forEach((freq, index) => window.setTimeout(() => tone(freq, 0.6, 'triangle', 0.04, 6, 'victory-chord'), 120 + index * 140));
  }
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
// First pointer interaction anywhere unlocks the menu ambience.
window.addEventListener('pointerdown', () => { ensureAudio(); syncMusic(); }, { once: true });
els.resumeBtn.addEventListener('click', pauseGame);
els.pauseBtn.addEventListener('click', pauseGame);
els.restartBtn.addEventListener('click', startRun);
els.againBtn.addEventListener('click', startRun);
els.menuBtn.addEventListener('click', returnToMenu);
els.soundBtn.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('bullet-heaven-muted', muted ? '1' : '0');
  els.soundBtn.textContent = muted ? '声音 OFF' : '声音 ON';
  if (muted) {
    music.stop();
    musicMode = 'off';
  } else {
    musicMode = 'off'; // force syncMusic to re-enter the right state
    syncMusic();
    tone(620, 0.08, 'triangle', 0.04, 120, 'sound-toggle');
  }
});
els.directorToggle.addEventListener('click', () => {
  const collapsed = els.directorPanel.classList.toggle('collapsed');
  els.directorToggle.textContent = collapsed ? '+' : '−';
});
els.hordeBtn.addEventListener('click', triggerHorde);
els.overdriveBtn.addEventListener('click', triggerOverdrive);
els.eliteBtn.addEventListener('click', triggerElite);
els.nukeBtn.addEventListener('click', () => triggerNuke(true));
els.ironCurtainBtn.addEventListener('click', triggerIronCurtain);
els.teslaBtn.addEventListener('click', triggerTeslaStorm);
els.supplyBtn.addEventListener('click', triggerSupplyDrop);
els.freezeBtn.addEventListener('click', triggerFreeze);

setupStick(els.moveStick, 'move');
setupStick(els.aimStick, 'aim');

window.__bulletHeavenDebug = Object.freeze({
  snapshot: () => ({ mode: state.mode, elapsed: state.elapsed, enemies: state.enemies.length, bullets: state.bullets.length, hostileBullets: state.hostileBullets.length, pickups: state.pickups.length, particles: state.particles.length, kills: state.kills, level: state.level, hp: state.hp, bossSpawned: state.bossSpawned, bossHp: state.boss?.hp || 0, infiniteRayHits: state.infiniteRayHits, cooldowns: { ...state.cooldowns }, upgrades: { ...state.upgradeLevels } }),
  start: startRun,
  grantUpgrade(id, count = 1) { const upgrade = UPGRADE_MAP.get(id); if (!upgrade) return false; for (let index = 0; index < count; index += 1) { upgrade.apply(); if (upgrade.max < 90) state.upgradeLevels[id] = Math.min(upgrade.max, upgradeLevel(id) + 1); } updateArsenal(); syncHud(true); return true; },
  grantXp,
  triggerHorde,
  triggerOverdrive,
  triggerElite,
  triggerNuke: () => triggerNuke(false),
  triggerIronCurtain,
  triggerTeslaStorm,
  triggerSupplyDrop,
  triggerFreeze,
  spawnBoss,
  spawnEnemyAt(type, x, y, hp = 500) { const enemy = spawnEnemy(type || 'tank', { side: 0, margin: 0 }); if (!enemy) return null; enemy.x = Number(x); enemy.y = Number(y); enemy.hp = Number(hp); enemy.maxHp = Number(hp); enemy.speed = 0; return enemy.id; },
  fireBulletAt(angle, options = {}) { const bullet = fireBullet(state.player.x, state.player.y, Number(angle) || 0, options); if (bullet) bullet.life = Math.min(bullet.life, 0.02); return Boolean(bullet); },
  enemyState(id) { const enemy = state.enemies.find((item) => item.id === id); return enemy ? { id: enemy.id, hp: enemy.hp, dead: enemy.dead, x: enemy.x, y: enemy.y } : null; },
  setHealth(value) { state.hp = clamp(Number(value) || 0, 0, state.maxHp); syncHud(); },
  music: () => music.snapshot(),
});

resize();
resetRun();
setMode('menu');
els.soundBtn.textContent = muted ? '声音 OFF' : '声音 ON';
loadProfile();
rafId = requestAnimationFrame(loop);
