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
const DEFAULT_POINT_COUNT = 6500;
const PALETTE_MAX = 6;     // 着色器 uniform 数组最大长度
const PALETTE_DEFAULT = 'mobius-logo-soft';
const MAX_BACKGROUND_IMAGE_BYTES = 20 * 1024 * 1024;
const BACKGROUND_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const PALETTES = {
  aurora:    ['#22d3ee', '#7dd3fc', '#a78bfa', '#f472b6', '#34d399'],
  sunset:    ['#fef3c7', '#fb923c', '#f43f5e', '#7f1d1d'],
  galaxy:    ['#1e1b4b', '#4c1d95', '#7c3aed', '#ec4899', '#fde68a'],
  mono:      ['#94a3b8', '#cbd5e1', '#e2e8f0', '#ffffff'],
  'mobius-logo': ['#45d7e8', '#5bc0f2', '#6f7af3', '#9c59ee', '#ee52d7'],
  'mobius-logo-deep': ['#17b7d8', '#2c90f2', '#5d6bf4', '#8d4fec', '#e955d0'],
  'mobius-logo-soft': ['#83e3ee', '#98cef5', '#a8a0f5', '#c08eed', '#f292df'],
  'mobius-logo-bright': ['#1edcf0', '#39acf8', '#7377ff', '#b05cff', '#ff5acb'],
  cyxx:      ['#00b8d9', '#2f6df6', '#7c4dff', '#c026d3', '#ff3b8f'],
  cyanmagen: ['#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'],
  fire:      ['#fef3c7', '#fde047', '#f97316', '#dc2626', '#7f1d1d'],
  mint:      ['#022c22', '#10b981', '#5eead4', '#a7f3d0'],
  cyber:     ['#00ffd5', '#0095ff', '#7c3aed', '#ff2bd6'],
};

const LOGO_GRADIENT_PALETTES = new Set([
  'mobius-logo',
  'mobius-logo-deep',
  'mobius-logo-soft',
  'mobius-logo-bright',
]);

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
  radius: 8.5,
  width: 0.9,
  twist: 1,
  zScale: 1.0,
  // 密度
  pointCount: DEFAULT_POINT_COUNT,
  // 颜色
  palette: PALETTE_DEFAULT,
  customColors: ['#7dd3fc', '#a78bfa', '#f472b6'],
  // 动画
  flowSpeed: 0.03,
  breathSpeed: 1.0,
  breathStrength: 0.65,
  // 背景主题: dark / light / custom / image
  theme: 'image',
  bgColor: '#ffffff',      // 仅 custom 主题用
  bgBrightness: 0.04,      // 0..1, 控制星云光晕强度
  backgroundImageRel: 'builtin/default-mobius-ring-bg.jpg',
  backgroundImageName: '20260817-211011.jpg',
  backgroundFit: 'cover',
  backgroundImageBrightness: 0.91,
  backgroundImageBlur: 0,
  backgroundImageOverlay: 0,
  // 视图
  autoRotate: 'off',
  // 渲染
  dotSize: 0.2,
  glow: 0.5,
  background: 0.04,
  logoFlowParticles: true,
  svgTransparentBg: false,
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
const backgroundLayer = $('backgroundLayer');
const toastEl = $('toast');

let scene, camera, renderer, controls, clock;
let pointCloud, pointGeometry, pointMaterial;
let posAttr, uAttr, vAttr, phaseAttr, breathAttr, sizeAttr, colorTAttr;
let starField, nebulaMat;
let logoRibbon, logoRibbonGeometry, logoRibbonMaterial;
let logoFlowCloud, logoFlowGeometry, logoFlowMaterial;
let logoRibbonKey = '';
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
uniform float uLogoGradientMode;

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

  float logoGradientT = clamp(0.5 + 0.5 * (pos.x / max(0.1, uRadius + uWidth)), 0.0, 1.0);
  vColor = samplePalette(mix(aColorT, logoGradientT, uLogoGradientMode));

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
uniform float uReadableMode;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;

  // 核心 (实心圆) + 外晕
  float core = smoothstep(0.5, 0.18, d);
  float halo = pow(1.0 - d * 2.0, 2.5);

  float brightness = mix(vBrightness, 0.72 + 0.28 * vBrightness, uReadableMode);
  vec3 col = vColor * brightness * (core * 0.85 + uGlow * halo * 0.55);
  float alpha = core + uGlow * halo * 0.6;
  gl_FragColor = vec4(col, alpha);
}
`;

const LOGO_RIBBON_VERTEX = /* glsl */`
attribute vec3 color;
attribute float aLogoT;
attribute float aFlowT;
attribute float aRibbonEdge;

varying vec3 vColor;
varying float vLogoT;
varying float vFlowT;
varying float vRibbonEdge;
varying vec3 vNormal;
varying vec3 vViewDir;

void main() {
  vColor = color;
  vLogoT = aLogoT;
  vFlowT = aFlowT;
  vRibbonEdge = aRibbonEdge;
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vViewDir = normalize(-mvPos.xyz);
  gl_Position = projectionMatrix * mvPos;
}
`;

const LOGO_RIBBON_FRAGMENT = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uFlowSpeed;

varying vec3 vColor;
varying float vLogoT;
varying float vFlowT;
varying float vRibbonEdge;
varying vec3 vNormal;
varying vec3 vViewDir;

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vViewDir);
  vec3 lightDir = normalize(vec3(-0.35, 0.55, 0.76));
  float diffuse = max(dot(n, lightDir), 0.0);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.2);
  float edge = smoothstep(0.72, 1.0, vRibbonEdge);
  float sweep = fract(vFlowT - uTime * uFlowSpeed * 1.6);
  float head = smoothstep(0.02, 0.12, sweep) * (1.0 - smoothstep(0.12, 0.32, sweep));
  float breath = 0.92 + 0.08 * sin(uTime * 1.35 + vLogoT * 6.2831853);
  vec3 color = vColor * (0.56 + diffuse * 0.34 + rim * 0.16 + edge * 0.28 + head * 0.38) * breath;
  gl_FragColor = vec4(color, 1.0);
}
`;

const LOGO_FLOW_VERTEX = /* glsl */`
attribute float aBaseU;
attribute float aV;
attribute float aPhase;
attribute float aSize;

uniform float uTime;
uniform float uRadius;
uniform float uWidth;
uniform float uZScale;
uniform float uDotSize;
uniform float uFlowSpeed;
uniform vec3  uColors[${PALETTE_MAX}];
uniform int   uColorCount;

varying vec3 vColor;
varying float vAlpha;

vec3 infinityCenter(float u) {
  return vec3(
    uRadius * sin(u),
    0.52 * uRadius * sin(2.0 * u),
    0.22 * uRadius * uZScale * cos(u)
  );
}

vec3 infinityTangent(float u) {
  return normalize(vec3(
    uRadius * cos(u),
    1.04 * uRadius * cos(2.0 * u),
    -0.22 * uRadius * uZScale * sin(u)
  ));
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
  float u = aBaseU + uTime * uFlowSpeed * 6.8 + aPhase * 0.018;
  vec3 center = infinityCenter(u);
  vec3 tangent = infinityTangent(u);
  vec3 side = cross(vec3(0.0, 0.0, 1.0), tangent);
  if (dot(side, side) < 0.0001) side = vec3(1.0, 0.0, 0.0);
  side = normalize(side);
  vec3 lift = normalize(cross(tangent, side));
  vec3 pos = center + (side * aV + lift * sin(aPhase) * 0.18) * uWidth * 0.34;

  float logoT = clamp(0.5 + 0.5 * (pos.x / max(0.1, uRadius + uWidth)), 0.0, 1.0);
  vColor = samplePalette(logoT);
  vAlpha = 0.56 + 0.36 * sin(uTime * 2.6 + aPhase);

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPos;
  float dist = max(0.1, -mvPos.z);
  gl_PointSize = aSize * uDotSize * (460.0 / dist);
}
`;

const LOGO_FLOW_FRAGMENT = /* glsl */`
precision highp float;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;
  float core = smoothstep(0.5, 0.12, d);
  float halo = pow(max(0.0, 1.0 - d * 2.0), 2.0);
  gl_FragColor = vec4(vColor * (0.95 + halo * 0.4), (core * 0.62 + halo * 0.22) * vAlpha);
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
  $('exportSvgBtn')?.addEventListener('click', exportSvg);

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
      uReadableMode: { value: 0.0 },
      uLogoGradientMode: { value: 0.0 },
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
  syncParticleBlending();
  syncLogoRibbonVisibility();
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

function samplePaletteColor(colors, t) {
  const palette = colors && colors.length ? colors : PALETTES[PALETTE_DEFAULT];
  if (palette.length === 1) return new THREE.Color(palette[0]);
  const x = Math.max(0, Math.min(1, t)) * (palette.length - 1);
  const i = Math.max(0, Math.min(palette.length - 2, Math.floor(x)));
  const f = x - i;
  return new THREE.Color(palette[i]).lerp(new THREE.Color(palette[i + 1]), f);
}

function logoRibbonStateKey() {
  return [
    state.palette,
    state.radius.toFixed(3),
    state.width.toFixed(3),
    state.zScale.toFixed(3),
  ].join('|');
}

function disposeLogoRibbonMesh(mesh, geometry, material) {
  if (mesh) scene.remove(mesh);
  geometry && geometry.dispose();
  material && material.dispose();
}

function applyLogoRibbonColors(geometry) {
  const pos = geometry.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const logoT = new Float32Array(pos.count);
  const palette = currentPaletteColors();
  const denom = Math.max(0.1, state.radius + state.width);
  for (let i = 0; i < pos.count; i++) {
    const t = 0.5 + 0.5 * (pos.getX(i) / denom);
    const color = samplePaletteColor(palette, t);
    colors[i * 3 + 0] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
    logoT[i] = Math.max(0, Math.min(1, t));
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aLogoT', new THREE.BufferAttribute(logoT, 1));
}

function infinityCenterPoint(u) {
  return new THREE.Vector3(
    state.radius * Math.sin(u),
    0.52 * state.radius * Math.sin(2 * u),
    0.22 * state.radius * state.zScale * Math.cos(u),
  );
}

function infinityTangentPoint(u) {
  return new THREE.Vector3(
    state.radius * Math.cos(u),
    1.04 * state.radius * Math.cos(2 * u),
    -0.22 * state.radius * state.zScale * Math.sin(u),
  ).normalize();
}

function logoRibbonPoint(u, v) {
  const phi = Math.sin(u * 2.0) * 0.14;
  const center = infinityCenterPoint(u);
  const tangent = infinityTangentPoint(u);
  let side = new THREE.Vector3(0, 0, 1).cross(tangent);
  if (side.lengthSq() < 0.0001) side = new THREE.Vector3(1, 0, 0);
  side.normalize();
  const lift = new THREE.Vector3().crossVectors(tangent, side).normalize();
  const crossingPinch = THREE.MathUtils.lerp(0.78, 1.0, THREE.MathUtils.smoothstep(Math.abs(Math.sin(u)), 0.18, 0.62));
  const ribbonDir = side.multiplyScalar(Math.cos(phi)).add(lift.multiplyScalar(Math.sin(phi) * state.zScale)).normalize();
  return center.add(ribbonDir.multiplyScalar(v * state.width * crossingPinch));
}

function buildLogoRibbonGeometry() {
  const segmentsU = 420;
  const segmentsV = 14;
  const vertexCount = (segmentsU + 1) * (segmentsV + 1);
  const positions = new Float32Array(vertexCount * 3);
  const flowT = new Float32Array(vertexCount);
  const edge = new Float32Array(vertexCount);
  const indices = [];

  for (let i = 0; i <= segmentsU; i++) {
    const u = (i / segmentsU) * Math.PI * 2;
    for (let j = 0; j <= segmentsV; j++) {
      const v = -1 + (j / segmentsV) * 2;
      const idx = i * (segmentsV + 1) + j;
      const p = logoRibbonPoint(u, v);
      positions[idx * 3 + 0] = p.x;
      positions[idx * 3 + 1] = p.y;
      positions[idx * 3 + 2] = p.z;
      flowT[idx] = i / segmentsU;
      edge[idx] = Math.abs(v);
    }
  }

  for (let i = 0; i < segmentsU; i++) {
    for (let j = 0; j < segmentsV; j++) {
      const a = i * (segmentsV + 1) + j;
      const b = (i + 1) * (segmentsV + 1) + j;
      const c = (i + 1) * (segmentsV + 1) + j + 1;
      const d = i * (segmentsV + 1) + j + 1;
      indices.push(a, b, d, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aFlowT', new THREE.BufferAttribute(flowT, 1));
  geometry.setAttribute('aRibbonEdge', new THREE.BufferAttribute(edge, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function rebuildLogoRibbon() {
  disposeLogoRibbonMesh(logoRibbon, logoRibbonGeometry, logoRibbonMaterial);

  logoRibbonGeometry = buildLogoRibbonGeometry();
  applyLogoRibbonColors(logoRibbonGeometry);

  logoRibbonMaterial = new THREE.ShaderMaterial({
    vertexShader: LOGO_RIBBON_VERTEX,
    fragmentShader: LOGO_RIBBON_FRAGMENT,
    uniforms: {
      uTime: { value: state.time },
      uFlowSpeed: { value: state.flowSpeed },
    },
    transparent: false,
    depthWrite: true,
    side: THREE.DoubleSide,
  });

  logoRibbon = new THREE.Mesh(logoRibbonGeometry, logoRibbonMaterial);
  logoRibbon.frustumCulled = false;
  scene.add(logoRibbon);
  rebuildLogoFlowParticles();
  logoRibbonKey = logoRibbonStateKey();
}

function rebuildLogoFlowParticles() {
  disposeLogoRibbonMesh(logoFlowCloud, logoFlowGeometry, logoFlowMaterial);

  const count = 1100;
  const pos = new Float32Array(count * 3);
  const baseU = new Float32Array(count);
  const v = new Float32Array(count);
  const phase = new Float32Array(count);
  const size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3 + 0] = 0;
    pos[i * 3 + 1] = 0;
    pos[i * 3 + 2] = 0;
    baseU[i] = Math.random() * Math.PI * 2;
    v[i] = (Math.random() * 2 - 1) * Math.pow(Math.random(), 0.42);
    phase[i] = Math.random() * Math.PI * 2;
    size[i] = 0.72 + Math.random() * 0.85;
  }

  logoFlowGeometry = new THREE.BufferGeometry();
  logoFlowGeometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  logoFlowGeometry.setAttribute('aBaseU', new THREE.BufferAttribute(baseU, 1));
  logoFlowGeometry.setAttribute('aV', new THREE.BufferAttribute(v, 1));
  logoFlowGeometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  logoFlowGeometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

  const palette = currentPaletteColors().map(hexToVec3);
  logoFlowMaterial = new THREE.ShaderMaterial({
    vertexShader: LOGO_FLOW_VERTEX,
    fragmentShader: LOGO_FLOW_FRAGMENT,
    uniforms: {
      uTime: { value: state.time },
      uRadius: { value: state.radius },
      uWidth: { value: state.width },
      uZScale: { value: state.zScale },
      uDotSize: { value: state.dotSize },
      uFlowSpeed: { value: state.flowSpeed },
      uColors: { value: padColors(palette, PALETTE_MAX) },
      uColorCount: { value: palette.length },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  logoFlowCloud = new THREE.Points(logoFlowGeometry, logoFlowMaterial);
  logoFlowCloud.frustumCulled = false;
  scene.add(logoFlowCloud);
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
  syncParticleBlending();
  if (logoRibbonMaterial && logoRibbonMaterial.uniforms && logoRibbonMaterial.uniforms.uFlowSpeed) {
    logoRibbonMaterial.uniforms.uFlowSpeed.value = state.flowSpeed;
  }
  if (logoFlowMaterial && logoFlowMaterial.uniforms) {
    const flowPalette = currentPaletteColors().map(hexToVec3);
    const padded = padColors(flowPalette, PALETTE_MAX);
    logoFlowMaterial.uniforms.uRadius.value = state.radius;
    logoFlowMaterial.uniforms.uWidth.value = state.width;
    logoFlowMaterial.uniforms.uZScale.value = state.zScale;
    logoFlowMaterial.uniforms.uDotSize.value = state.dotSize;
    logoFlowMaterial.uniforms.uFlowSpeed.value = state.flowSpeed;
    for (let i = 0; i < PALETTE_MAX; i++) {
      logoFlowMaterial.uniforms.uColors.value[i] = padded[i];
    }
    logoFlowMaterial.uniforms.uColorCount.value = flowPalette.length;
  }
  syncLogoRibbonVisibility();
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
  if (logoRibbonMaterial && logoRibbonMaterial.uniforms && logoRibbonMaterial.uniforms.uTime) {
    logoRibbonMaterial.uniforms.uTime.value = state.time;
  }
  if (logoFlowMaterial && logoFlowMaterial.uniforms && logoFlowMaterial.uniforms.uTime) {
    logoFlowMaterial.uniforms.uTime.value = state.time;
  }

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

function extName() {
  return window.__EXT_NAME__ || 'dot-logo-3d';
}

function authToken() {
  return localStorage.getItem('cc-token') || '';
}

function assetUrl(rel) {
  const clean = String(rel || '').replace(/^\/+/, '');
  if (!clean) return '';
  const encoded = clean.split('/').map(encodeURIComponent).join('/');
  if (clean.startsWith('builtin/')) return `./${encoded}`;
  const token = authToken();
  return `/api/extensions/${encodeURIComponent(extName())}/user-asset/${encoded}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

function validateBackgroundImage(file) {
  if (!file) return '请选择图片';
  if (!BACKGROUND_IMAGE_TYPES.has(file.type)) return '只支持 PNG / JPG / WebP 图片';
  if (file.size > MAX_BACKGROUND_IMAGE_BYTES) return '图片不能超过 20MB';
  return '';
}

function uploadBackgroundImage(file) {
  return new Promise((resolve, reject) => {
    const invalid = validateBackgroundImage(file);
    if (invalid) {
      reject(new Error(invalid));
      return;
    }

    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file);
    xhr.open('POST', `/api/extensions/${encodeURIComponent(extName())}/upload`);
    const token = authToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        reject(new Error('上传响应解析失败'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok && data.file) {
        const storedName = data.file.stored_name || String(data.file.path || '').split('/').pop();
        if (!storedName) {
          reject(new Error('上传结果缺少文件名'));
          return;
        }
        resolve({
          rel: `uploads/${storedName}`,
          name: data.file.name || file.name,
        });
        return;
      }
      reject(new Error((data && data.error) || `上传失败 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(form);
  });
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
  const logoFlowParticlesInput = $('logoFlowParticlesInput');
  if (logoFlowParticlesInput) {
    logoFlowParticlesInput.checked = !!state.logoFlowParticles;
    logoFlowParticlesInput.addEventListener('change', () => {
      state.logoFlowParticles = !!logoFlowParticlesInput.checked;
      syncLogoRibbonVisibility();
    });
  }
  const svgTransparentBgInput = $('svgTransparentBgInput');
  if (svgTransparentBgInput) {
    svgTransparentBgInput.checked = !!state.svgTransparentBg;
    svgTransparentBgInput.addEventListener('change', () => {
      state.svgTransparentBg = !!svgTransparentBgInput.checked;
    });
  }
  // 背景亮度 (0..1, 替代旧的 0..0.3)
  bindRange('bgInput', 'bgBrightness', (v) => v.toFixed(2), { min: 0, max: 1, step: 0.01, extra: () => applyBackground() });
  // 主题下拉 (dark / light / custom)
  const themeSel = $('themeSelect');
  themeSel.value = state.theme;
  themeSel.addEventListener('change', () => {
    state.theme = themeSel.value;
    refreshBackgroundControls();
    applyBackground();
  });
  // 自定义背景色取色器
  const bgColorInp = $('bgColorInput');
  bgColorInp.value = state.bgColor;
  bgColorInp.addEventListener('input', () => {
    state.bgColor = bgColorInp.value;
    applyBackground();
  });
  bindImageBackgroundControls();
  refreshBackgroundControls();

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

function bindImageBackgroundControls() {
  const input = $('backgroundImageInput');
  $('selectBackgroundImageBtn')?.addEventListener('click', () => {
    input?.click();
  });
  input?.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const invalid = validateBackgroundImage(file);
    if (invalid) {
      showToast(invalid);
      input.value = '';
      return;
    }
    try {
      showToast('正在上传背景图片...');
      const uploaded = await uploadBackgroundImage(file);
      state.backgroundImageRel = uploaded.rel;
      state.backgroundImageName = uploaded.name;
      state.theme = 'image';
      const themeSel = $('themeSelect');
      if (themeSel) themeSel.value = state.theme;
      reflectImageBackgroundToUI();
      refreshBackgroundControls();
      applyBackground();
      showToast('背景图片已导入');
    } catch (e) {
      showToast('导入失败: ' + (e.message || e));
    } finally {
      input.value = '';
    }
  });

  const fit = $('backgroundFitInput');
  if (fit) {
    fit.value = state.backgroundFit;
    fit.addEventListener('change', () => {
      state.backgroundFit = fit.value;
      applyBackground();
    });
  }

  bindRange('backgroundImageBrightnessInput', 'backgroundImageBrightness', (v) => `${Math.round(v * 100)}%`, {
    min: 0.25,
    max: 1.2,
    step: 0.01,
    extra: () => applyBackground(),
  });
  bindRange('backgroundImageBlurInput', 'backgroundImageBlur', (v) => `${Math.round(v)}px`, {
    min: 0,
    max: 24,
    step: 1,
    extra: () => applyBackground(),
  });
  bindRange('backgroundImageOverlayInput', 'backgroundImageOverlay', (v) => `${Math.round(v * 100)}%`, {
    min: 0,
    max: 0.8,
    step: 0.01,
    extra: () => applyBackground(),
  });

  $('clearBackgroundImageBtn')?.addEventListener('click', () => {
    state.backgroundImageRel = '';
    state.backgroundImageName = '';
    if (state.theme === 'image') {
      state.theme = 'dark';
      const themeSel = $('themeSelect');
      if (themeSel) themeSel.value = state.theme;
    }
    reflectImageBackgroundToUI();
    refreshBackgroundControls();
    applyBackground();
    showToast('已清除背景图片');
  });
}

function refreshBackgroundControls() {
  const customRow = $('bgCustomColorRow');
  if (customRow) customRow.style.display = (state.theme === 'custom') ? 'flex' : 'none';
  const imageControls = $('backgroundImageControls');
  if (imageControls) imageControls.style.display = (state.theme === 'image') ? 'block' : 'none';
  reflectImageBackgroundToUI();
}

function reflectImageBackgroundToUI() {
  const name = $('backgroundImageName');
  if (name) name.textContent = state.backgroundImageName || (state.backgroundImageRel ? state.backgroundImageRel.split('/').pop() : '未选择');
  const fit = $('backgroundFitInput');
  if (fit) fit.value = state.backgroundFit;
  const brightness = $('backgroundImageBrightnessInput');
  if (brightness) brightness.value = String(state.backgroundImageBrightness);
  const brightnessVal = $('backgroundImageBrightnessInputVal');
  if (brightnessVal) brightnessVal.textContent = `${Math.round(state.backgroundImageBrightness * 100)}%`;
  const blur = $('backgroundImageBlurInput');
  if (blur) blur.value = String(state.backgroundImageBlur);
  const blurVal = $('backgroundImageBlurInputVal');
  if (blurVal) blurVal.textContent = `${Math.round(state.backgroundImageBlur)}px`;
  const overlay = $('backgroundImageOverlayInput');
  if (overlay) overlay.value = String(state.backgroundImageOverlay);
  const overlayVal = $('backgroundImageOverlayInputVal');
  if (overlayVal) overlayVal.textContent = `${Math.round(state.backgroundImageOverlay * 100)}%`;
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
    backgroundImageRel: state.backgroundImageRel,
    backgroundImageName: state.backgroundImageName,
    backgroundFit: state.backgroundFit,
    backgroundImageBrightness: state.backgroundImageBrightness,
    backgroundImageBlur: state.backgroundImageBlur,
    backgroundImageOverlay: state.backgroundImageOverlay,
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
    if ($('themeSelect')) $('themeSelect').value = state.theme;
    if ($('bgColorInput')) $('bgColorInput').value = state.bgColor;
    refreshBackgroundControls();
    applyBackground();
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
function imageBackgroundSize() {
  if (state.backgroundFit === 'contain') return 'contain';
  if (state.backgroundFit === 'stretch') return '100% 100%';
  return 'cover';
}

function applyImageBackground() {
  if (!backgroundLayer) return;
  if (state.theme !== 'image' || !state.backgroundImageRel) {
    backgroundLayer.classList.remove('is-active');
    backgroundLayer.style.removeProperty('--bg-image');
    return;
  }
  const url = assetUrl(state.backgroundImageRel);
  backgroundLayer.style.setProperty('--bg-image', `url("${url.replace(/"/g, '\\"')}")`);
  backgroundLayer.style.setProperty('--bg-image-fit', imageBackgroundSize());
  backgroundLayer.style.setProperty('--bg-image-brightness', String(state.backgroundImageBrightness));
  backgroundLayer.style.setProperty('--bg-image-blur', `${state.backgroundImageBlur}px`);
  backgroundLayer.style.setProperty('--bg-image-overlay', String(state.backgroundImageOverlay));
  backgroundLayer.style.setProperty('--bg-image-scale', state.backgroundImageBlur > 0 ? '1.045' : '1');
  backgroundLayer.classList.add('is-active');
}

function syncStarFieldVisibility() {
  if (!starField) return;
  starField.visible = !(state.theme === 'image' && state.backgroundImageRel);
}

function usesReadableParticleBlending() {
  return state.theme === 'light'
    || (state.theme === 'image' && state.backgroundImageRel)
    || (state.theme === 'custom' && state.bgBrightness > 0.45);
}

function usesLogoGradientPalette() {
  return LOGO_GRADIENT_PALETTES.has(state.palette);
}

function syncLogoRibbonVisibility() {
  if (!pointCloud) return;
  const logoMode = usesLogoGradientPalette();
  pointCloud.visible = !logoMode;
  if (!logoMode) {
    if (logoRibbon) logoRibbon.visible = false;
    if (logoFlowCloud) logoFlowCloud.visible = false;
    return;
  }
  if (!logoRibbon || logoRibbonKey !== logoRibbonStateKey()) {
    rebuildLogoRibbon();
  }
  if (logoRibbon) logoRibbon.visible = true;
  if (logoFlowCloud) logoFlowCloud.visible = logoMode && state.logoFlowParticles;
}

function syncParticleBlending() {
  if (!pointMaterial) return;
  const readable = usesReadableParticleBlending();
  pointMaterial.blending = readable ? THREE.NormalBlending : THREE.AdditiveBlending;
  if (currentUniforms && currentUniforms.uReadableMode) {
    currentUniforms.uReadableMode.value = readable ? 1.0 : 0.0;
  }
  if (currentUniforms && currentUniforms.uLogoGradientMode) {
    currentUniforms.uLogoGradientMode.value = usesLogoGradientPalette() ? 1.0 : 0.0;
  }
  pointMaterial.needsUpdate = true;
}

function applyBackground() {
  if (!renderer) return;
  syncStarFieldVisibility();
  syncParticleBlending();
  if (state.theme === 'image' && state.backgroundImageRel) {
    applyImageBackground();
    renderer.setClearColor(new THREE.Color(0, 0, 0), 0);
    if (typeof scene !== 'undefined' && scene) scene.background = null;
    document.documentElement.style.setProperty('--bg-0', 'transparent');
    document.body.style.setProperty('background', '#050c1c', 'important');
    const stageEl = document.getElementById('stage');
    if (stageEl) stageEl.style.setProperty('background', 'transparent', 'important');
    if (renderer.domElement) renderer.domElement.style.setProperty('background', 'transparent', 'important');
    if (nebulaMat) nebulaMat.uniforms.uBrightness.value = 0;
    if (typeof renderer.clear === 'function') {
      renderer.clear(true, true, true);
      if (typeof scene !== 'undefined' && scene && typeof camera !== 'undefined' && camera) {
        renderer.render(scene, camera);
      }
    }
    return;
  }
  applyImageBackground();
  // 根据 theme 计算 RGB (0-1)。图片模式未选图时用暗色兜底, 但保留图片控件。
  const renderTheme = state.theme === 'image' ? 'dark' : state.theme;
  let r, g, b;
  if (renderTheme === 'dark') {
    // 暗色: 深蓝 (0x000208 之类), 不受 bgBrightness 影响 (保留原观感)
    r = 0; g = 0.008; b = 0.032;
  } else if (renderTheme === 'light') {
    // 亮色: cyxx 冰雾蓝, 避免纯白冲淡青蓝紫粉光点。
    const t = Math.max(0, Math.min(1, state.bgBrightness));
    r = 0.88 + t * 0.08;
    g = 0.94 + t * 0.04;
    b = 1.00;
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
  const clearAlpha = (renderTheme === 'dark') ? 1 : 0;
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
  if (renderer.domElement) renderer.domElement.style.setProperty('background', cssHex, 'important');

  // 星云 uBrightness: 暗色主题才生效, 亮色/custom 给 0
  if (nebulaMat) {
    nebulaMat.uniforms.uBrightness.value = (renderTheme === 'dark') ? state.bgBrightness : 0;
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
  const logoFlowParticlesInput = $('logoFlowParticlesInput');
  if (logoFlowParticlesInput) logoFlowParticlesInput.checked = !!state.logoFlowParticles;
  const svgTransparentBgInput = $('svgTransparentBgInput');
  if (svgTransparentBgInput) svgTransparentBgInput.checked = !!state.svgTransparentBg;
  if ($('themeSelect')) $('themeSelect').value = state.theme;
  if ($('bgColorInput')) $('bgColorInput').value = state.bgColor;
  reflectImageBackgroundToUI();
  refreshBackgroundControls();
  refreshCustomRow();
}

// ============================================================
// SVG 导出
// ============================================================
function svgPointFromU(u, width, height, scale) {
  return {
    x: width * 0.5 + state.radius * Math.sin(u) * scale,
    y: height * 0.5 - 0.52 * state.radius * Math.sin(2 * u) * scale,
  };
}

function buildSvgLogoPath(width, height, scale, segments = 320) {
  const parts = [];
  for (let i = 0; i <= segments; i++) {
    const p = svgPointFromU((i / segments) * Math.PI * 2, width, height, scale);
    parts.push(`${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
  }
  return parts.join(' ') + ' Z';
}

function colorToHex(color) {
  return '#' + color.getHexString();
}

function buildSvgParticles(width, height, scale, count) {
  if (!state.logoFlowParticles) return '';
  const palette = currentPaletteColors();
  const maxParticles = Math.max(120, Math.min(420, Math.round(count)));
  const circles = [];
  for (let i = 0; i < maxParticles; i++) {
    const t = (i * 0.61803398875) % 1;
    const u = t * Math.PI * 2;
    const base = svgPointFromU(u, width, height, scale);
    const jitter = Math.sin(i * 12.9898) * 0.5 + 0.5;
    const angle = u + Math.PI * 0.5;
    const offset = (jitter - 0.5) * state.width * scale * 0.64;
    const x = base.x + Math.cos(angle) * offset;
    const y = base.y - Math.sin(angle) * offset;
    const color = colorToHex(samplePaletteColor(palette, 0.5 + 0.5 * (base.x - width * 0.5) / (state.radius * scale)));
    const r = 0.9 + ((i * 37) % 17) / 17;
    const opacity = 0.34 + (((i * 53) % 29) / 29) * 0.36;
    circles.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r.toFixed(2)}" fill="${color}" opacity="${opacity.toFixed(2)}"/>`);
  }
  return circles.join('\n    ');
}

function exportSvg() {
  const width = 1600;
  const height = 900;
  const scale = 72;
  const strokeWidth = Math.max(54, Math.min(132, state.width * scale * 1.48));
  const palette = currentPaletteColors();
  const stops = palette.map((color, idx) => {
    const pct = palette.length <= 1 ? 0 : (idx / (palette.length - 1)) * 100;
    return `<stop offset="${pct.toFixed(1)}%" stop-color="${escapeAttr(color)}"/>`;
  }).join('\n      ');
  const path = buildSvgLogoPath(width, height, scale);
  const particles = buildSvgParticles(width, height, scale, state.pointCount * 0.055);
  const backgroundRect = state.svgTransparentBg ? '' : '  <rect width="100%" height="100%" fill="url(#bgGlow)"/>';
  const title = 'Mobius Ring Logo';
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${title}</title>
  <desc id="desc">Exported from ${escapeHtml(location.href)} with the current Mobius ring palette and flow particles.</desc>
  <defs>
    <linearGradient id="mobiusGradient" x1="16%" y1="42%" x2="84%" y2="58%">
      ${stops}
    </linearGradient>
    <radialGradient id="bgGlow" cx="50%" cy="46%" r="62%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="58%" stop-color="#f1eff7"/>
      <stop offset="100%" stop-color="#dcd8ea"/>
    </radialGradient>
    <filter id="softShadow" x="-18%" y="-28%" width="136%" height="156%">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#6370a8" flood-opacity="0.22"/>
    </filter>
    <style>
      @keyframes mobiusDash {
        from { stroke-dashoffset: 0; }
        to { stroke-dashoffset: -1500; }
      }
      .flow-highlight {
        animation: mobiusDash 5s linear infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        .flow-highlight { animation: none; }
      }
    </style>
  </defs>
${backgroundRect}
  <g filter="url(#softShadow)">
    <path d="${path}" fill="none" stroke="url(#mobiusGradient)" stroke-width="${strokeWidth.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>
    <path class="flow-highlight" d="${path}" fill="none" stroke="url(#mobiusGradient)" stroke-width="${(strokeWidth * 0.42).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="210 1290" stroke-dashoffset="0" opacity="0.58">
      <animate attributeName="stroke-dashoffset" values="0;-1500" dur="5s" repeatCount="indefinite"/>
    </path>
    ${particles}
  </g>
</svg>
`;
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `mobius-ring-${stamp}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('已导出 SVG');
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
