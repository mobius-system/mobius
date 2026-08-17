// dot-logo-3d/frontend/main.js
// 莫比乌斯光点 Logo 空间 — 基于 threejs 的点云 + 自定义着色器.
//   - 光点沿扭成 ∞ 形的莫比乌斯光带滑动 (u 方向);
//   - 明暗按呼吸节奏变化 (每个光点独立相位 + 微小频率抖动);
//   - 用户可调: 形状(∞ 跨度 / width / twist / zScale) · 光点密度 · 调色盘 · 视角 · 流速 / 呼吸.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { extCall } from '/extension/_sdk/ext.js';

// ============================================================
// 常量
// ============================================================
const MAX_POINTS = 30000;
const MIN_POINTS = 200;
const DEFAULT_POINT_COUNT = 4500;
const PALETTE_MAX = 6;     // 着色器 uniform 数组最大长度
const PALETTE_DEFAULT = 'cyxx';

const PALETTES = {
  aurora:    ['#22d3ee', '#7dd3fc', '#a78bfa', '#f472b6', '#34d399'],
  sunset:    ['#fef3c7', '#fb923c', '#f43f5e', '#7f1d1d'],
  galaxy:    ['#1e1b4b', '#4c1d95', '#7c3aed', '#ec4899', '#fde68a'],
  mono:      ['#94a3b8', '#cbd5e1', '#e2e8f0', '#ffffff'],
  cyxx:      ['#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'],
  cyanmagen: ['#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'],
  fire:      ['#fef3c7', '#fde047', '#f97316', '#dc2626', '#7f1d1d'],
  mint:      ['#022c22', '#10b981', '#5eead4', '#a7f3d0'],
  cyber:     ['#00ffd5', '#0095ff', '#7c3aed', '#ff2bd6'],
};

const TWIST_CHOICES = [
  { value: 1, label: '单扭 (经典莫比乌斯)' },
  { value: 2, label: '双扭' },
  { value: 3, label: '三扭' },
];

// ============================================================
// 状态
// ============================================================
const state = {
  // 形状
  radius: 8.0,
  width: 0.9,
  twist: 1,
  zScale: 1.0,
  // 密度
  pointCount: DEFAULT_POINT_COUNT,
  // 颜色
  palette: PALETTE_DEFAULT,
  customColors: ['#7dd3fc', '#a78bfa', '#f472b6'],
  // 动画
  flowSpeed: 0.10,
  breathSpeed: 1.0,
  breathStrength: 0.65,
  // 背景主题: dark / light / custom (C 选项: 主题 + 亮度 + 自定义取色器)
  theme: 'dark',            // 'dark' | 'light' | 'custom'
  bgColor: '#ffffff',      // 仅 custom 主题用
  bgBrightness: 0.04,      // 0..1, 控制星云光晕强度
  // 视图
  autoRotate: 'off',
  // 渲染
  dotSize: 0.3,
  glow: 0.85,
  background: 0.04,
  // 内部
  time: 0,
  paused: false,
  identity: '',
  displayName: '',
};

// ============================================================
// DOM
// ============================================================
const $ = (id) => document.getElementById(id);
const stage = $('stage');
const toastEl = $('toast');

let scene, camera, renderer, controls, clock;
let pointCloud, pointGeometry, pointMaterial;
let posAttr, uAttr, vAttr, phaseAttr, breathAttr, sizeAttr, colorTAttr;
let starField, nebulaMat;
let currentUniforms;
let lastInteractAt = 0;
let fpsAcc = 0, fpsFrames = 0, fpsLastT = 0;
let currentFps = 0;

// ============================================================
// 着色器
// ============================================================
const VERTEX_SHADER = /* glsl */`
attribute float aU;
attribute float aV;
attribute float aPhase;
attribute float aBreathRate;
attribute float aSize;
attribute float aColorT;

uniform float uTime;
uniform float uRadius;
uniform float uWidth;
uniform float uTwist;
uniform float uZScale;
uniform float uDotSize;
uniform float uFlowSpeed;
uniform float uBreathSpeed;
uniform float uBreathStrength;

uniform vec3  uColors[${PALETTE_MAX}];
uniform int   uColorCount;

varying vec3  vColor;
varying float vBrightness;

vec3 infinityCenter(float u) {
  // Gerono 双纽线中心线: 屏幕正面看是横向 ∞。
  // z 方向在交叉点做上下分层, 让中心交叉处有明确的穿插关系。
  float x = uRadius * sin(u);
  float y = 0.52 * uRadius * sin(2.0 * u);
  float z = 0.22 * uRadius * uZScale * cos(u);
  return vec3(x, y, z);
}

vec3 infinityTangent(float u) {
  float dx = uRadius * cos(u);
  float dy = 1.04 * uRadius * cos(2.0 * u);
  float dz = -0.22 * uRadius * uZScale * sin(u);
  return normalize(vec3(dx, dy, dz));
}

vec3 mobiusPos(float u, float v) {
  // u ∈ ℝ (周期性 2π), v ∈ [-1, 1]
  // 先沿 ∞ 中心线建立局部坐标架, 再让带面绕中心线完成莫比乌斯半扭。
  float phi = uTwist * u * 0.5;
  vec3 center = infinityCenter(u);
  vec3 tangent = infinityTangent(u);

  vec3 side = cross(vec3(0.0, 0.0, 1.0), tangent);
  if (dot(side, side) < 0.0001) side = vec3(1.0, 0.0, 0.0);
  side = normalize(side);
  vec3 lift = normalize(cross(tangent, side));

  float crossingPinch = mix(0.78, 1.0, smoothstep(0.18, 0.62, abs(sin(u))));
  vec3 ribbonDir = cos(phi) * side + sin(phi) * lift * uZScale;
  return center + v * uWidth * crossingPinch * ribbonDir;
}

vec3 samplePalette(float t) {
  float scaled = t * float(uColorCount - 1);
  int idx = int(floor(scaled));
  float f = fract(scaled);
  if (idx < 0) idx = 0;
  if (idx >= uColorCount - 1) return uColors[uColorCount - 1];
  return mix(uColors[idx], uColors[idx + 1], f);
}

void main() {
  // 沿环流动: 每个光点的 u 偏移随时间线性增长
  float u = aU + uTime * uFlowSpeed;
  // v 在一些形状下也可微微变化, 此处保持不变
  vec3 pos = mobiusPos(u, aV);

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPos;

  // 呼吸: 每个光点独立相位与微小频率抖动, 避免整齐脉冲
  float breath = sin(uTime * uBreathSpeed * aBreathRate + aPhase);
  float bright = (1.0 - uBreathStrength) + uBreathStrength * (0.5 + 0.5 * breath);
  vBrightness = bright;

  vColor = samplePalette(aColorT);

  // 屏幕空间尺寸: 远小近大, 叠加呼吸缩放
  float dist = max(0.1, -mvPos.z);
  float distScale = 380.0 / dist;
  gl_PointSize = aSize * uDotSize * distScale * (0.7 + 0.3 * bright);
}
`;

const FRAGMENT_SHADER = /* glsl */`
precision highp float;

varying vec3  vColor;
varying float vBrightness;

uniform float uGlow;
uniform float uAdditive;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;

  // 核心 (实心圆) + 外晕
  float core = smoothstep(0.5, 0.18, d);
  float halo = pow(1.0 - d * 2.0, 2.5);

  vec3 col = vColor * vBrightness * (core * 0.85 + uGlow * halo * 0.55);
  float alpha = core + uGlow * halo * 0.6;
  gl_FragColor = vec4(col, alpha);
}
`;

const NEBULA_VERT = /* glsl */`
varying vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const NEBULA_FRAG = /* glsl */`
precision highp float;
varying vec3 vPos;
uniform float uTime;
uniform float uBrightness;

// 简单 3D 噪声 (hash) — 用于星云
float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 dir = normalize(vPos);
  float n = 0.0;
  float a = 1.0;
  for (int i = 0; i < 3; i++) {
    n += a * hash(floor(dir * 60.0 + uTime * 0.02));
    a *= 0.5;
    dir *= 2.0;
  }
  vec3 c1 = vec3(0.04, 0.03, 0.10);
  vec3 c2 = vec3(0.10, 0.05, 0.20);
  vec3 col = mix(c1, c2, n);
  gl_FragColor = vec4(col * uBrightness, uBrightness);
}
`;

// ============================================================
// 初始化
// ============================================================
function init() {
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000208, 0.012);
  // 背景色: 跟着主题 (dark 用深蓝, light/custom 用浅灰白)
  // 关键: 把背景画在 scene 里 (而不是 setClearColor), 保证画布**有内容**
  // 这样即使 alpha:8 / 画布强制不透明, 背景也始终在
  const initBg = state.theme === 'dark' ? new THREE.Color(0, 0.008, 0.032) : new THREE.Color(0.952, 0.952, 0.952);
  scene.background = initBg;

  const w = window.innerWidth, h = window.innerHeight;
  camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 5000);
  camera.position.set(0, 4.8, 25);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    alpha: true,           // canvas 透明 (透出 body 背景)
    premultipliedAlpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  stage.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 5;
  controls.maxDistance = 80;
  controls.target.set(0, 0, 0);

  // 星云背景球 (从内表面看)
  const nebulaGeo = new THREE.SphereGeometry(800, 32, 24);
  nebulaMat = new THREE.ShaderMaterial({
    vertexShader: NEBULA_VERT,
    fragmentShader: NEBULA_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uBrightness: { value: state.background },
    },
    side: THREE.BackSide,
    depthWrite: false,
  });
  const nebula = new THREE.Mesh(nebulaGeo, nebulaMat);
  scene.add(nebula);

  // 静态星空 (稀疏)
  starField = createStarField(1800);
  scene.add(starField);

  // 光点云
  rebuildPointCloud();

  // 全局拖尾 / 暗背景
  // alpha=0 让 canvas 完全透明, 透出 body 颜色
  // 暗色主题 body 黑底, 亮色主题 body 浅灰白, 走 body 背景而不是 WebGL clear
  renderer.setClearColor(0x000000, 0);

  // 视角重置按钮
  $('resetViewBtn').addEventListener('click', resetView);
  $('pauseBtn').addEventListener('click', togglePause);

  // 参数面板折叠
  $('togglePanelBtn').addEventListener('click', togglePanel);

  // 键盘快捷键: Space 暂停, R 重置视角
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePause(); }
    if (e.key === 'r' || e.key === 'R') resetView();
  });

  window.addEventListener('resize', onResize);
  onResize();
}

function createStarField(count) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // 球壳分布
    const r = 400 + Math.random() * 300;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    pos[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    pos[i * 3 + 2] = r * Math.cos(phi);
    // 微弱颜色变化
    const c = 0.6 + Math.random() * 0.4;
    const tint = Math.random();
    if (tint < 0.7) {
      col[i * 3 + 0] = c; col[i * 3 + 1] = c; col[i * 3 + 2] = c;
    } else if (tint < 0.85) {
      col[i * 3 + 0] = c * 0.8; col[i * 3 + 1] = c * 0.9; col[i * 3 + 2] = c;
    } else {
      col[i * 3 + 0] = c; col[i * 3 + 1] = c * 0.85; col[i * 3 + 2] = c * 0.7;
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.6,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

// ============================================================
// 光点云 (重建)
// ============================================================
function rebuildPointCloud() {
  if (pointCloud) {
    scene.remove(pointCloud);
    pointGeometry && pointGeometry.dispose();
    pointMaterial && pointMaterial.dispose();
  }
  pointGeometry = new THREE.BufferGeometry();

  const n = Math.max(MIN_POINTS, Math.min(MAX_POINTS, Math.floor(state.pointCount)));
  const pos   = new Float32Array(n * 3);  // 占位, 真实位置在 shader 中计算
  const aU    = new Float32Array(n);
  const aV    = new Float32Array(n);
  const aPh   = new Float32Array(n);
  const aBR   = new Float32Array(n);
  const aS    = new Float32Array(n);
  const aCT   = new Float32Array(n);

  // ∞ 莫比乌斯: u 均匀分布, v 在 [-1, 1] 中间稍密 (中心密, 边缘稀 → 视觉上更柔和)
  for (let i = 0; i < n; i++) {
    const t = (i + Math.random() * 0.5) / n; // 半步抖动, 避免规则条纹
    aU[i] = t * Math.PI * 2;
    // 平方根分布让 v 偏向 0, 制造柔和的厚度感
    const s = Math.random() * 2 - 1;
    aV[i] = Math.sign(s) * Math.pow(Math.abs(s), 0.7);
    aPh[i] = Math.random() * Math.PI * 2;
    aBR[i] = 0.7 + Math.random() * 0.6;     // 0.7..1.3 倍基础呼吸频率
    aS[i]  = 0.75 + Math.random() * 0.6;    // 0.75..1.35 倍基础尺寸
    aCT[i] = Math.random();                 // 颜色采样位置
    pos[i * 3 + 0] = 0; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = 0;
  }

  pointGeometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pointGeometry.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
  pointGeometry.setAttribute('aV', new THREE.BufferAttribute(aV, 1));
  pointGeometry.setAttribute('aPhase', new THREE.BufferAttribute(aPh, 1));
  pointGeometry.setAttribute('aBreathRate', new THREE.BufferAttribute(aBR, 1));
  pointGeometry.setAttribute('aSize', new THREE.BufferAttribute(aS, 1));
  pointGeometry.setAttribute('aColorT', new THREE.BufferAttribute(aCT, 1));
  pointGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), state.radius * 1.8 + state.width * 4);

  const palette = currentPaletteColors();
  const colorVec3 = palette.map(hexToVec3);

  pointMaterial = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: state.radius },
      uWidth: { value: state.width },
      uTwist: { value: state.twist },
      uZScale: { value: state.zScale },
      uDotSize: { value: state.dotSize },
      uFlowSpeed: { value: state.flowSpeed },
      uBreathSpeed: { value: state.breathSpeed },
      uBreathStrength: { value: state.breathStrength },
      uGlow: { value: state.glow },
      uAdditive: { value: 1.0 },
      uColors: { value: padColors(colorVec3, PALETTE_MAX) },
      uColorCount: { value: colorVec3.length },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  pointCloud = new THREE.Points(pointGeometry, pointMaterial);
  pointCloud.frustumCulled = false;
  scene.add(pointCloud);
  currentUniforms = pointMaterial.uniforms;
}

function padColors(arr, len) {
  const out = [];
  for (let i = 0; i < len; i++) {
    out.push(arr[Math.min(i, arr.length - 1)] || new THREE.Vector3(0, 0, 0));
  }
  return out;
}

function hexToVec3(hex) {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

function currentPaletteColors() {
  if (state.palette === 'custom') {
    return (state.customColors || []).filter(Boolean).slice(0, PALETTE_MAX);
  }
  return PALETTES[state.palette] || PALETTES.aurora;
}

// ============================================================
// 状态 → uniform 同步
// ============================================================
function syncUniforms() {
  if (!currentUniforms) return;
  currentUniforms.uRadius.value = state.radius;
  currentUniforms.uWidth.value = state.width;
  currentUniforms.uTwist.value = state.twist;
  currentUniforms.uZScale.value = state.zScale;
  currentUniforms.uDotSize.value = state.dotSize;
  currentUniforms.uFlowSpeed.value = state.paused ? 0 : state.flowSpeed;
  currentUniforms.uBreathSpeed.value = state.breathSpeed;
  currentUniforms.uBreathStrength.value = state.breathStrength;
  currentUniforms.uGlow.value = state.glow;

  if (state.palette === 'custom') {
    const vec3 = currentPaletteColors().map(hexToVec3);
    const padded = padColors(vec3, PALETTE_MAX);
    for (let i = 0; i < PALETTE_MAX; i++) {
      currentUniforms.uColors.value[i] = padded[i];
    }
    currentUniforms.uColorCount.value = vec3.length;
  } else {
    const vec3 = currentPaletteColors().map(hexToVec3);
    const padded = padColors(vec3, PALETTE_MAX);
    for (let i = 0; i < PALETTE_MAX; i++) {
      currentUniforms.uColors.value[i] = padded[i];
    }
    currentUniforms.uColorCount.value = vec3.length;
  }
  if (nebulaMat) nebulaMat.uniforms.uBrightness.value = state.background;
}

// ============================================================
// 动画循环
// ============================================================
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = clock ? Math.min(0.05, (now - clock) / 1000) : 0.016;
  clock = now;

  if (!state.paused) state.time += dt;

  // 自动旋转
  let rotateSpeed = 0;
  if (state.autoRotate === 'slow') rotateSpeed = 0.15;
  else if (state.autoRotate === 'normal') rotateSpeed = 0.4;
  else if (state.autoRotate === 'fast') rotateSpeed = 0.9;
  if (rotateSpeed > 0) {
    const a = rotateSpeed * dt;
    const x = camera.position.x, z = camera.position.z;
    camera.position.x = x * Math.cos(a) - z * Math.sin(a);
    camera.position.z = x * Math.sin(a) + z * Math.cos(a);
  }

  controls.update();

  if (currentUniforms) currentUniforms.uTime.value = state.time;
  if (nebulaMat) nebulaMat.uniforms.uTime.value = state.time;

  renderer.render(scene, camera);

  // FPS
  fpsAcc += dt; fpsFrames++;
  if (now - fpsLastT > 500) {
    currentFps = fpsFrames / fpsAcc;
    fpsAcc = 0; fpsFrames = 0; fpsLastT = now;
    const fpsEl = $('fpsValue');
    if (fpsEl) fpsEl.textContent = currentFps.toFixed(0);
  }
}

// ============================================================
// 视图 / 事件
// ============================================================
function resetView() {
  camera.position.set(0, 4.8, 25);
  controls.target.set(0, 0, 0);
  controls.update();
  showToast('视角已重置');
}

function togglePause() {
  state.paused = !state.paused;
  const btn = $('pauseBtn');
  if (btn) btn.textContent = state.paused ? '继续' : '暂停';
  showToast(state.paused ? '已暂停' : '继续播放');
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

let toastTimer = null;

function togglePanel() {
  const panel = $('controlPanel');
  const btn = $('togglePanelBtn');
  const collapsed = panel.classList.toggle('collapsed');
  btn.textContent = collapsed ? '+' : '−';
  localStorage.setItem('dot3d-panel-collapsed', collapsed ? '1' : '0');
}

function restorePanelState() {
  const collapsed = localStorage.getItem('dot3d-panel-collapsed') === '1';
  const panel = $('controlPanel');
  const btn = $('togglePanelBtn');
  if (collapsed) {
    panel.classList.add('collapsed');
    btn.textContent = '+';
  }
}
function showToast(text) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

// ============================================================
// UI 绑定
// ============================================================
function bindControls() {
  // 形状 sliders
  bindRange('radiusInput', 'radius', (v) => `R = ${v.toFixed(1)}`, { min: 3, max: 15, step: 0.1 });
  bindRange('widthInput', 'width', (v) => `w = ${v.toFixed(2)}`, { min: 0.2, max: 3.0, step: 0.05 });
  bindRange('zScaleInput', 'zScale', (v) => `z = ${v.toFixed(2)}`, { min: 0.4, max: 2.5, step: 0.05 });

  // twist 整数选择
  const twistSel = $('twistInput');
  twistSel.innerHTML = TWIST_CHOICES.map(t => `<option value="${t.value}">${t.label}</option>`).join('');
  twistSel.value = String(state.twist);
  twistSel.addEventListener('change', () => {
    state.twist = parseInt(twistSel.value, 10) || 1;
    syncUniforms();
  });

  // 密度
  bindRange('pointCountInput', 'pointCount', (v) => `${Math.round(v)} 点`, { min: 200, max: 30000, step: 100, integer: true, rebuild: true });

  // 调色板
  const palSel = $('paletteInput');
  const palKeys = Object.keys(PALETTES);
  palSel.innerHTML = palKeys.map(k => `<option value="${k}">${k}</option>`).join('') + '<option value="custom">custom</option>';
  palSel.value = state.palette;
  palSel.addEventListener('change', () => {
    state.palette = palSel.value;
    refreshCustomRow();
    syncUniforms();
  });
  $('addColorBtn').addEventListener('click', () => {
    if (state.customColors.length >= PALETTE_MAX) return showToast(`最多 ${PALETTE_MAX} 个颜色`);
    state.customColors.push('#ffffff');
    state.palette = 'custom';
    palSel.value = 'custom';
    refreshCustomRow();
    syncUniforms();
  });
  $('removeColorBtn').addEventListener('click', () => {
    if (state.customColors.length <= 2) return showToast('至少保留 2 个颜色');
    state.customColors.pop();
    state.palette = 'custom';
    palSel.value = 'custom';
    refreshCustomRow();
    syncUniforms();
  });

  // 动画
  bindRange('flowSpeedInput', 'flowSpeed', (v) => v.toFixed(2), { min: -1.0, max: 1.0, step: 0.01 });
  bindRange('breathSpeedInput', 'breathSpeed', (v) => v.toFixed(2), { min: 0, max: 5, step: 0.05 });
  bindRange('breathStrengthInput', 'breathStrength', (v) => `${Math.round(v * 100)}%`, { min: 0, max: 1, step: 0.01 });

  // 视图
  const rotSel = $('autoRotateInput');
  rotSel.value = state.autoRotate;
  rotSel.addEventListener('change', () => { state.autoRotate = rotSel.value; });

  // 渲染
  bindRange('dotSizeInput', 'dotSize', (v) => v.toFixed(2), { min: 0.2, max: 4.0, step: 0.05 });
  bindRange('glowInput', 'glow', (v) => v.toFixed(2), { min: 0, max: 2.0, step: 0.05 });
  // 背景亮度 (0..1, 替代旧的 0..0.3)
  bindRange('bgInput', 'bgBrightness', (v) => v.toFixed(2), { min: 0, max: 1, step: 0.01, extra: () => applyBackground() });
  // 主题下拉 (dark / light / custom)
  const themeSel = $('themeSelect');
  themeSel.value = state.theme;
  themeSel.addEventListener('change', () => {
    state.theme = themeSel.value;
    $('bgCustomColorRow').style.display = (state.theme === 'custom') ? 'flex' : 'none';
    applyBackground();
  });
  // 自定义背景色取色器
  const bgColorInp = $('bgColorInput');
  bgColorInp.value = state.bgColor;
  bgColorInp.addEventListener('input', () => {
    state.bgColor = bgColorInp.value;
    applyBackground();
  });
  // 初始化时按主题显示/隐藏取色器行
  $('bgCustomColorRow').style.display = (state.theme === 'custom') ? 'flex' : 'none';

  // 预设
  $('savePresetBtn').addEventListener('click', onSavePreset);
  $('deletePresetBtn').addEventListener('click', onDeletePreset);
  $('presetSelect').addEventListener('change', () => {
    // 选中改变不自动加载, 避免误操作
  });
  $('loadPresetBtn').addEventListener('click', onLoadPreset);
  // inline 输入框 (避免 prompt 弹窗被拒)
  $('presetSaveConfirm')?.addEventListener('click', onSavePresetConfirm);
  $('presetSaveCancel')?.addEventListener('click', hidePresetNameInput);
  $('presetNameInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSavePresetConfirm();
    else if (e.key === 'Escape') hidePresetNameInput();
  });

  refreshCustomRow();
}

function bindRange(inputId, stateKey, format, opts) {
  const el = $(inputId);
  if (!el) return;
  const out = $(inputId + 'Val');
  el.min = String(opts.min); el.max = String(opts.max); el.step = String(opts.step);
  el.value = String(state[stateKey]);
  if (out) out.textContent = format(state[stateKey]);
  el.addEventListener('input', () => {
    const v = opts.integer ? parseInt(el.value, 10) : parseFloat(el.value);
    state[stateKey] = v;
    if (out) out.textContent = format(v);
    if (opts.extra) opts.extra(v);
    if (opts.rebuild) {
      debouncedRebuild();
    } else {
      syncUniforms();
    }
  });
}

let rebuildTimer = null;
function debouncedRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildPointCloud();
  }, 80);
}

function refreshCustomRow() {
  const row = $('customColorsRow');
  if (!row) return;
  if (state.palette !== 'custom') {
    row.style.display = 'none';
    return;
  }
  row.style.display = 'flex';
  row.innerHTML = state.customColors.map((c, i) =>
    `<input type="color" class="color-swatch" data-idx="${i}" value="${c}">`
  ).join('');
  row.querySelectorAll('input.color-swatch').forEach(sw => {
    sw.addEventListener('input', () => {
      const idx = parseInt(sw.dataset.idx, 10);
      state.customColors[idx] = sw.value;
      syncUniforms();
    });
  });
}

// ============================================================
// 预设 (后端持久化)
// ============================================================
async function listPresets() {
  try {
    const data = await extCall({ action: 'list_presets' });
    if (!data || !data.ok) throw new Error((data && data.error) || 'list failed');
    const sel = $('presetSelect');
    const opts = ['<option value="">— 选择预设 —</option>']
      .concat((data.presets || []).map(p =>
        `<option value="${escapeAttr(p.name)}">${escapeHtml(p.name)} (${p.point_count || 0} 点)</option>`
      ));
    sel.innerHTML = opts.join('');
  } catch (e) {
    console.warn('list_presets failed', e);
  }
}

function showPresetNameInput() {
  const row = $('presetSaveRow');
  if (!row) return;
  row.style.display = 'flex';
  const input = $('presetNameInput');
  if (input) {
    input.value = `${state.palette}-${state.twist}x`;
    setTimeout(() => input.focus(), 30);
  }
}
function hidePresetNameInput() {
  const row = $('presetSaveRow');
  if (row) row.style.display = 'none';
  const input = $('presetNameInput');
  if (input) input.value = '';
}
async function onSavePresetConfirm() {
  const input = $('presetNameInput');
  const name = (input && input.value || '').trim();
  if (!name) return showToast('名称不能为空');
  if (!/^[\w一-鿿\-\. ]{1,64}$/u.test(name)) {
    return showToast('名称只能含字母/数字/_/-/. /中文, ≤64 字符');
  }
  const data = {
    ...state,
    pointCount: state.pointCount,
  };
  delete data.identity;
  delete data.displayName;
  delete data.time;
  delete data.paused;
  try {
    const resp = await extCall({ action: 'save_preset', name, data });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'save failed');
    showToast(`已保存预设「${name}」`);
    hidePresetNameInput();
    await listPresets();
    // 选中新保存的预设
    const sel = $('presetSelect');
    if (sel) sel.value = name;
  } catch (e) {
    showToast('保存失败: ' + (e.message || e));
  }
}

async function onSavePreset() {
  // 第一步: 显示 inline 输入框, 不依赖浏览器原生 prompt (某些场景会拒弹窗)
  showPresetNameInput();
}

async function onLoadPreset() {
  const sel = $('presetSelect');
  const name = sel.value;
  if (!name) return showToast('请先选择预设');
  try {
    const resp = await extCall({ action: 'load_preset', name });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'load failed');
    const data = resp.data || {};
    // 校验
    for (const k of Object.keys(state)) {
      if (data[k] !== undefined) state[k] = data[k];
    }
    // 同步 UI
    reflectStateToUI();
    syncUniforms();
    rebuildPointCloud();
    applyBackground();
    // 主题下拉同步 (从保存里恢复)
    if ($('themeSelect')) $('themeSelect').value = state.theme;
    if ($('bgColorInput')) $('bgColorInput').value = state.bgColor;
    if ($('bgCustomColorRow')) {
      $('bgCustomColorRow').style.display = (state.theme === 'custom') ? 'flex' : 'none';
    }
    showToast(`已加载「${name}」`);
  } catch (e) {
    showToast('加载失败: ' + (e.message || e));
  }
}

async function onDeletePreset() {
  const sel = $('presetSelect');
  const name = sel.value;
  if (!name) return showToast('请先选择预设');
  if (!confirm(`删除预设「${name}」?`)) return;
  try {
    const resp = await extCall({ action: 'delete_preset', name });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'delete failed');
    showToast(`已删除「${name}」`);
    await listPresets();
  } catch (e) {
    showToast('删除失败: ' + (e.message || e));
  }
}

// ============== 背景主题应用 (C 选项: dark/light/custom + 亮度) ==============
function applyBackground() {
  if (!renderer) return;
  // 根据 theme 计算 RGB (0-1)
  let r, g, b;
  if (state.theme === 'dark') {
    // 暗色: 深蓝 (0x000208 之类), 不受 bgBrightness 影响 (保留原观感)
    r = 0; g = 0.008; b = 0.032;
  } else if (state.theme === 'light') {
    // 亮色: 接近白, bgBrightness 控制从灰到纯白
    const v = 0.95 + state.bgBrightness * 0.05; // 0.95..1.0
    r = g = b = v;
  } else {
    // custom: 直接 hex 解析 RGB, bgBrightness 作为"亮度"覆盖
    const hex = state.bgColor.replace('#', '');
    r = parseInt(hex.slice(0, 2), 16) / 255;
    g = parseInt(hex.slice(2, 4), 16) / 255;
    b = parseInt(hex.slice(4, 6), 16) / 255;
    // bgBrightness 0 → 黑色, 1 → 保持原色
    r *= state.bgBrightness;
    g *= state.bgBrightness;
    b *= state.bgBrightness;
  }
  // WebGL clear:
  //  - 暗色 → 实心黑 (alpha=1) 由 canvas 自身画背景
  //  - 亮色/custom → 透明 (alpha=0) 让 body 颜色透出
  const clearAlpha = (state.theme === 'dark') ? 1 : 0;
  renderer.setClearColor(new THREE.Color(r, g, b), clearAlpha);
  // 关键: scene.background 也跟着改 (Three.js 每帧先画这个做底色)
  // 这是最稳的方案: 不依赖 WebGL clear 行为, 也不依赖 alpha buffer
  if (typeof scene !== 'undefined' && scene) {
    scene.background = new THREE.Color(r, g, b);
  }

  // CSS body 背景同步 (WebGL canvas 透明, 暗色 canvas 画黑, 亮色 body 画背景)
  // 亮色/custom 用实色; 暗色 body 也是黑, 但 canvas 已画黑, 二选一都行
  const cssHex = '#' + new THREE.Color(r, g, b).getHexString();
  document.documentElement.style.setProperty('--bg-0', cssHex);
  // 双保险: 直接给 body + #stage + canvas 设 inline style (有些 CSS 优先级可能盖过变量)
  document.body.style.setProperty('background', cssHex, 'important');
  const stageEl = document.getElementById('stage');
  if (stageEl) stageEl.style.setProperty('background', cssHex, 'important');
  // 三保险: 直接给 canvas 本身设 background-color (canvas 是 WebGL, inline background 在 clear 透出时透出)
  if (renderer && renderer.domElement) {
    if (renderer && renderer.domElement) { renderer.domElement.style.setProperty('background', cssHex, 'important'); } else if (renderer.domElement) { renderer.domElement.style.setProperty('background', cssHex, 'important'); }
  }

  console.log('[bg]', state.theme, 'r='+r.toFixed(3), 'g='+g.toFixed(3), 'b='+b.toFixed(3),
              'clearAlpha='+clearAlpha,
              'bodyBg='+getComputedStyle(document.body).backgroundColor,
              'stageBg='+(stageEl ? getComputedStyle(stageEl).backgroundColor : 'n/a'),
              'canvasW='+renderer.domElement.width,
              'canvasH='+renderer.domElement.height);
  // 星云 uBrightness: 暗色主题才生效, 亮色/custom 给 0
  if (nebulaMat) {
    nebulaMat.uniforms.uBrightness.value = (state.theme === 'dark') ? state.bgBrightness : 0;
  }
  // 主动 clear 一次让新背景立即生效 (WebGL 状态只在 clear 时才用)
  // 同时清深度缓冲, 避免切换主题后粒子残影
  if (typeof renderer.clear === 'function') {
    renderer.clear(true, true, true);
    // 立即渲染一帧让新背景显示出来, 不必等下一帧
    if (typeof scene !== 'undefined' && scene && typeof camera !== 'undefined' && camera) {
      renderer.render(scene, camera);
    }
  }
}

function reflectStateToUI() {
  $('radiusInput').value = String(state.radius);
  $('radiusInputVal').textContent = `R = ${(+state.radius).toFixed(1)}`;
  $('widthInput').value = String(state.width);
  $('widthInputVal').textContent = `w = ${(+state.width).toFixed(2)}`;
  $('zScaleInput').value = String(state.zScale);
  $('zScaleInputVal').textContent = `z = ${(+state.zScale).toFixed(2)}`;
  $('twistInput').value = String(state.twist);
  $('pointCountInput').value = String(state.pointCount);
  $('pointCountInputVal').textContent = `${Math.round(state.pointCount)} 点`;
  $('flowSpeedInput').value = String(state.flowSpeed);
  $('flowSpeedInputVal').textContent = (+state.flowSpeed).toFixed(2);
  $('breathSpeedInput').value = String(state.breathSpeed);
  $('breathSpeedInputVal').textContent = (+state.breathSpeed).toFixed(2);
  $('breathStrengthInput').value = String(state.breathStrength);
  $('breathStrengthInputVal').textContent = `${Math.round(state.breathStrength * 100)}%`;
  $('dotSizeInput').value = String(state.dotSize);
  $('dotSizeInputVal').textContent = (+state.dotSize).toFixed(2);
  $('glowInput').value = String(state.glow);
  $('glowInputVal').textContent = (+state.glow).toFixed(2);
  $('bgInput').value = String(state.bgBrightness);
  $('bgInputVal').textContent = (+state.bgBrightness).toFixed(2);
  $('paletteInput').value = state.palette;
  $('autoRotateInput').value = state.autoRotate;
  renderer.setClearColor(new THREE.Color(state.background, state.background, state.background * 1.4), 1);
  refreshCustomRow();
}

// ============================================================
// 工具
// ============================================================
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ============================================================
// 身份
// ============================================================
async function loadIdentity() {
  try {
    const data = await extCall({ action: 'whoami' });
    if (data && data.ok) {
      state.identity = data.username || '';
      state.displayName = data.display_name || '';
      $('identity').textContent = state.displayName
        ? `${state.displayName} · ${state.identity}`
        : state.identity;
    }
  } catch {}
}

// ============================================================
// 启动
// ============================================================
clock = performance.now();
init();
bindControls();
loadIdentity();
applyBackground();   // 主题初始化: dark/light/custom + 亮度
listPresets();
syncUniforms();
restorePanelState();
animate();
