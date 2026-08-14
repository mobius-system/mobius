// 莫比乌斯宣传页 3D 动画
// 视觉基底仿照 dot-logo-3d：Gerono ∞ 中心线 + 莫比乌斯半扭 + 呼吸光点。
import * as THREE from 'three';

const PALETTE_MAX = 6;
const LIGHT_MODE = Boolean(window.__MOBIUS_LIGHT__) || document.documentElement.classList.contains('mobius-light');
const BRAND = LIGHT_MODE
  ? ['#008aa4', '#2563eb', '#4f46e5', '#7c3aed', '#c0266d', '#e11d74']
  : ['#22d3ee', '#7dd3fc', '#8b5cf6', '#a78bfa', '#ec4899', '#f472b6'];
const MUTED = LIGHT_MODE
  ? ['#64748b', '#7c8ca1', '#94a3b8', '#2879c7', '#635bdb', '#b42362']
  : ['#64748b', '#94a3b8', '#cbd5e1', '#7dd3fc', '#a78bfa', '#f472b6'];
const PARTICLE_BLEND = LIGHT_MODE ? THREE.NormalBlending : THREE.AdditiveBlending;

const LOGO_VERTEX = /* glsl */`
attribute float aU;
attribute float aV;
attribute float aPhase;
attribute float aBreathRate;
attribute float aSize;
attribute float aColorT;
attribute float aTwinkleMask;

uniform float uTime;
uniform float uRadius;
uniform float uWidth;
uniform float uTwist;
uniform float uZScale;
uniform float uDotSize;
uniform float uFlowSpeed;
uniform float uBreathSpeed;
uniform float uBreathStrength;
uniform float uFigureScale;
uniform float uTwinkle;
uniform vec3  uColors[${PALETTE_MAX}];
uniform int   uColorCount;

varying vec3  vColor;
varying float vBrightness;

vec3 infinityCenter(float u) {
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
  float phi = uTwist * u * 0.5;
  vec3 center = infinityCenter(u);
  vec3 tangent = infinityTangent(u);
  vec3 side = cross(vec3(0.0, 0.0, 1.0), tangent);
  if (dot(side, side) < 0.0001) side = vec3(1.0, 0.0, 0.0);
  side = normalize(side);
  vec3 lift = normalize(cross(tangent, side));
  float crossingPinch = mix(0.78, 1.0, smoothstep(0.18, 0.62, abs(sin(u))));
  vec3 ribbonDir = cos(phi) * side + sin(phi) * lift * uZScale;
  return (center + v * uWidth * crossingPinch * ribbonDir) * uFigureScale;
}

vec3 samplePalette(float t) {
  float scaled = clamp(t, 0.0, 0.999) * float(uColorCount - 1);
  int idx = int(floor(scaled));
  float f = fract(scaled);
  if (idx <= 0) return mix(uColors[0], uColors[1], f);
  if (idx == 1) return mix(uColors[1], uColors[2], f);
  if (idx == 2) return mix(uColors[2], uColors[3], f);
  if (idx == 3) return mix(uColors[3], uColors[4], f);
  return mix(uColors[4], uColors[5], f);
}

void main() {
  float u = aU + uTime * uFlowSpeed;
  vec3 pos = mobiusPos(u, aV);
  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPos;

  float breath = sin(uTime * uBreathSpeed * aBreathRate + aPhase);
  float bright = (1.0 - uBreathStrength) + uBreathStrength * (0.5 + 0.5 * breath);

  // 闪烁：仅对 aTwinkleMask = 1 的点生效；用尖锐脉冲叠加在基础亮度上。
  float pulseRaw = max(0.0, sin(uTime * (uBreathSpeed + 0.6) + aPhase * 2.3));
  float sharp = pow(pulseRaw, 8.0);
  bright += uTwinkle * aTwinkleMask * sharp * 0.95;

  vBrightness = bright;
  vColor = samplePalette(fract(aColorT + u * 0.035));

  float dist = max(0.1, -mvPos.z);
  float distScale = 380.0 / dist;
  gl_PointSize = aSize * uDotSize * distScale * (0.72 + 0.3 * min(bright, 1.8));
}
`;

const LOGO_FRAGMENT = /* glsl */`
precision highp float;
varying vec3  vColor;
varying float vBrightness;
uniform float uGlow;
uniform float uAlpha;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;

  float core = smoothstep(0.5, 0.18, d);
  float halo = pow(max(0.0, 1.0 - d * 2.0), 2.45);
  vec3 col = vColor * vBrightness * (core * 0.86 + uGlow * halo * 0.58);
  float alpha = (core + uGlow * halo * 0.62) * uAlpha;
  gl_FragColor = vec4(col, alpha);
}
`;

const AURA_VERTEX = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const AURA_FRAGMENT = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uStrength;

void main() {
  vec2 p = vUv - 0.5;
  float r = length(p);
  float angle = atan(p.y, p.x);
  float wave = 0.5 + 0.5 * sin(angle * 3.0 + uTime * 0.25);
  vec3 a = vec3(0.03, 0.75, 0.88);
  vec3 b = vec3(0.58, 0.36, 0.94);
  vec3 c = vec3(0.93, 0.28, 0.68);
  vec3 col = mix(mix(a, b, wave), c, smoothstep(0.25, 0.9, p.x + 0.5));
  float alpha = smoothstep(0.72, 0.05, r) * uStrength;
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

function colorVec(hex) {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

function padColors(colors) {
  const src = colors.map(colorVec);
  const out = [];
  for (let i = 0; i < PALETTE_MAX; i++) out.push(src[Math.min(i, src.length - 1)]);
  return out;
}

function makeLogoPointCloud(count, opts = {}) {
  const geometry = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const aU = new Float32Array(count);
  const aV = new Float32Array(count);
  const aPhase = new Float32Array(count);
  const aBreathRate = new Float32Array(count);
  const aSize = new Float32Array(count);
  const aColorT = new Float32Array(count);
  const aTwinkleMask = new Float32Array(count);

  const twinkleFraction = opts.twinkleFraction ?? 0.32;
  for (let i = 0; i < count; i++) {
    const t = (i + Math.random() * 0.65) / count;
    const s = Math.random() * 2 - 1;
    const edge = Math.random() < (opts.edgeBias ?? 0.18);
    aU[i] = t * Math.PI * 2;
    aV[i] = edge
      ? Math.sign(s || 1) * (0.72 + Math.random() * 0.28)
      : Math.sign(s || 1) * Math.pow(Math.abs(s), opts.vPower ?? 0.72);
    aPhase[i] = Math.random() * Math.PI * 2;
    aBreathRate[i] = 0.72 + Math.random() * 0.7;
    aSize[i] = (opts.minSize ?? 0.72) + Math.random() * (opts.sizeRange ?? 0.7);
    aColorT[i] = Math.random();
    aTwinkleMask[i] = Math.random() < twinkleFraction ? 1.0 : 0.0;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
  geometry.setAttribute('aV', new THREE.BufferAttribute(aV, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  geometry.setAttribute('aBreathRate', new THREE.BufferAttribute(aBreathRate, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geometry.setAttribute('aColorT', new THREE.BufferAttribute(aColorT, 1));
  geometry.setAttribute('aTwinkleMask', new THREE.BufferAttribute(aTwinkleMask, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);

  const colors = opts.colors || BRAND;
  const material = new THREE.ShaderMaterial({
    vertexShader: LOGO_VERTEX,
    fragmentShader: LOGO_FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: opts.radius ?? 1.45 },
      uWidth: { value: opts.width ?? 0.34 },
      uTwist: { value: opts.twist ?? 1 },
      uZScale: { value: opts.zScale ?? 1 },
      uDotSize: { value: opts.dotSize ?? 0.065 },
      uFlowSpeed: { value: opts.flowSpeed ?? 0.14 },
      uBreathSpeed: { value: opts.breathSpeed ?? 1.0 },
      uBreathStrength: { value: opts.breathStrength ?? 0.62 },
      uFigureScale: { value: opts.figureScale ?? 1 },
      uGlow: { value: opts.glow ?? 0.86 },
      uAlpha: { value: opts.alpha ?? 0.95 },
      uTwinkle: { value: opts.twinkle ?? 0 },
      uColors: { value: padColors(colors) },
      uColorCount: { value: Math.min(PALETTE_MAX, colors.length) },
    },
    transparent: true,
    depthWrite: false,
    blending: PARTICLE_BLEND,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, uniforms: material.uniforms };
}

function infinityPoint(u, v, opts = {}) {
  const radius = opts.radius ?? 1.45;
  const width = opts.width ?? 0.34;
  const twist = opts.twist ?? 1;
  const zScale = opts.zScale ?? 1;
  const figureScale = opts.figureScale ?? 1;

  const center = new THREE.Vector3(
    radius * Math.sin(u),
    0.52 * radius * Math.sin(2 * u),
    0.22 * radius * zScale * Math.cos(u)
  );
  const tangent = new THREE.Vector3(
    radius * Math.cos(u),
    1.04 * radius * Math.cos(2 * u),
    -0.22 * radius * zScale * Math.sin(u)
  ).normalize();
  let side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 0, 1), tangent);
  if (side.lengthSq() < 0.0001) side = new THREE.Vector3(1, 0, 0);
  side.normalize();
  const lift = new THREE.Vector3().crossVectors(tangent, side).normalize();
  const phi = twist * u * 0.5;
  const crossingPinch = THREE.MathUtils.lerp(0.78, 1.0, smoothstep(0.18, 0.62, Math.abs(Math.sin(u))));
  const ribbonDir = side.multiplyScalar(Math.cos(phi)).add(lift.multiplyScalar(Math.sin(phi) * zScale));
  return center.add(ribbonDir.multiplyScalar(v * width * crossingPinch)).multiplyScalar(figureScale);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function makeLine(count, color, opacity = 0.7) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: PARTICLE_BLEND,
  });
  return new THREE.Line(geometry, material);
}

function updateInfinityLine(line, opts = {}) {
  const attr = line.geometry.attributes.position;
  const count = attr.count;
  const start = opts.start ?? 0;
  const span = opts.span ?? Math.PI * 2;
  const v = opts.v ?? 0.55;
  for (let i = 0; i < count; i++) {
    const u = start + (i / Math.max(1, count - 1)) * span;
    const p = infinityPoint(u, v, opts);
    attr.setXYZ(i, p.x, p.y, p.z);
  }
  attr.needsUpdate = true;
}

function makeTraveler(color = 0xfde047, radius = 0.055) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 24, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 })
  );
}

function createStarField(count, spread = 8, colors = BRAND) {
  const geometry = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = Math.pow(Math.random(), 0.45) * spread;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.58;
    pos[i * 3 + 2] = r * Math.cos(phi) - spread * 0.12;
    const c = new THREE.Color(colors[(Math.random() * colors.length) | 0]);
    const dim = 0.45 + Math.random() * 0.55;
    col[i * 3] = c.r * dim;
    col[i * 3 + 1] = c.g * dim;
    col[i * 3 + 2] = c.b * dim;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 0.018,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: PARTICLE_BLEND,
    })
  );
}

function addAura(scene, scale = 4.5, strength = 0.22) {
  const aura = new THREE.Mesh(
    new THREE.PlaneGeometry(scale, scale * 0.68),
    new THREE.ShaderMaterial({
      vertexShader: AURA_VERTEX,
      fragmentShader: AURA_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uStrength: { value: strength },
      },
      transparent: true,
      depthWrite: false,
      blending: PARTICLE_BLEND,
    })
  );
  aura.position.z = -0.9;
  scene.add(aura);
  return aura;
}

export class MiniScene {
  constructor(container, opts = {}) {
    this.container = container;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(opts.fog ?? (LIGHT_MODE ? 0xffffff : 0x05030f), opts.fogDensity ?? (LIGHT_MODE ? 0.018 : 0.05));
    this.camera = new THREE.PerspectiveCamera(opts.fov ?? 42, width / height, 0.1, 100);
    this.camera.position.set(...(opts.cameraPos ?? [0, 0.2, 5.2]));
    this.camera.lookAt(...(opts.lookAt ?? [0, 0, 0]));

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = LIGHT_MODE ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = opts.exposure ?? (LIGHT_MODE ? 1 : 1.15);
    container.appendChild(this.renderer.domElement);

    this.callbacks = [];
    this.running = false;
    this.clock = new THREE.Clock();
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.tick = this.tick.bind(this);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
  }

  add(callback) {
    this.callbacks.push(callback);
    return this;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.getDelta();
    if (!this.reduced) requestAnimationFrame(this.tick);
    else this.renderOnce();
  }

  pause() {
    this.running = false;
  }

  tick() {
    if (!this.running) return;
    requestAnimationFrame(this.tick);
    const t = this.clock.getElapsedTime();
    for (const callback of this.callbacks) callback(t);
    this.renderer.render(this.scene, this.camera);
  }

  renderOnce() {
    const t = this.clock.getElapsedTime();
    for (const callback of this.callbacks) callback(t);
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  dispose() {
    this.running = false;
    try { this.resizeObserver.disconnect(); } catch {}
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

export function initLogoBackdrop(canvas, variant = 'hero') {
  if (!canvas) return null;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(LIGHT_MODE ? 0xffffff : 0x02010a, LIGHT_MODE ? 0.012 : 0.035);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(0, 2.6, variant === 'finale' ? 18 : 17);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = LIGHT_MODE ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = LIGHT_MODE ? 1 : 1.08;

  const aura = addAura(scene, 16, LIGHT_MODE ? 0.035 : (variant === 'finale' ? 0.10 : 0.12));
  const stars = createStarField(variant === 'finale' ? 900 : 1100, 16, BRAND);
  scene.add(stars);
  const cloud = makeLogoPointCloud(variant === 'finale' ? 3600 : 4200, {
    radius: 5.2,
    width: 0.78,
    dotSize: variant === 'finale' ? 0.42 : 0.46,
    flowSpeed: variant === 'finale' ? 0.08 : 0.1,
    breathSpeed: 0.9,
    breathStrength: 0.7,
    glow: 0.95,
    alpha: LIGHT_MODE ? 0.82 : 0.5,
    edgeBias: 0.24,
    figureScale: 1,
    colors: BRAND,
  });
  cloud.points.rotation.x = -0.16;
  cloud.points.rotation.z = -0.04;
  scene.add(cloud.points);

  let width = 1;
  let height = 1;
  let running = false;
  let raf = 0;
  const clock = new THREE.Clock();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    width = Math.max(1, canvas.clientWidth);
    height = Math.max(1, canvas.clientHeight);
    canvas.width = width * Math.min(window.devicePixelRatio || 1, 2);
    canvas.height = height * Math.min(window.devicePixelRatio || 1, 2);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function frame() {
    if (!running) return;
    if (!reduced) raf = requestAnimationFrame(frame);
    const t = clock.getElapsedTime();
    cloud.uniforms.uTime.value = t;
    aura.material.uniforms.uTime.value = t;
    cloud.points.rotation.y = Math.sin(t * 0.11) * 0.14;
    stars.rotation.y = t * 0.012;
    stars.rotation.x = Math.sin(t * 0.08) * 0.04;
    renderer.render(scene, camera);
    if (reduced) running = false;
  }

  resize();
  window.addEventListener('resize', resize);

  const api = {
    start() {
      if (running) return;
      running = true;
      clock.getDelta();
      frame();
    },
    pause() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
    },
  };
  api.start();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) api.pause();
    else api.start();
  });
  return api;
}

export function initTorusOnly(container) {
  // 普通圆环：真正的环面 (R, r)，明显体现"内外两面"——
  // 外圈（cos(v) > 0）用品牌亮色，内圈（cos(v) < 0）用低饱和暗色。
  const mini = new MiniScene(container, { cameraPos: [0, 0.32, 4.9], exposure: 1.16 });
  const group = new THREE.Group();
  group.rotation.x = -0.32;
  mini.scene.add(group);

  const R_MAJOR = 1.0;
  const R_MINOR = 0.36;

  function makeTorusCloud(count, isOuter) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const palette = isOuter ? BRAND : MUTED;
    for (let i = 0; i < count; i++) {
      const u = Math.random() * Math.PI * 2;
      const vBase = isOuter ? 0 : Math.PI;
      const v = vBase + (Math.random() - 0.5) * Math.PI * 0.92;
      const cr = R_MAJOR + R_MINOR * Math.cos(v);
      pos[i * 3] = cr * Math.cos(u);
      pos[i * 3 + 1] = R_MINOR * Math.sin(v);
      pos[i * 3 + 2] = cr * Math.sin(u);
      const c = new THREE.Color(palette[Math.floor(Math.random() * palette.length)]);
      const dim = isOuter ? 0.72 + Math.random() * 0.28 : 0.32 + Math.random() * 0.22;
      col[i * 3] = c.r * dim;
      col[i * 3 + 1] = c.g * dim;
      col[i * 3 + 2] = c.b * dim;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: isOuter ? 0.052 : 0.04,
      vertexColors: true,
      transparent: true,
      opacity: isOuter ? 0.96 : 0.78,
      depthWrite: false,
      blending: PARTICLE_BLEND,
    });
    return new THREE.Points(geo, mat);
  }

  const outerCloud = makeTorusCloud(1300, true);
  const innerCloud = makeTorusCloud(1100, false);
  group.add(outerCloud, innerCloud);

  // 旅行点：在外圈表面循环，体现"有尽头、回到原点"
  const traveler = makeTraveler(LIGHT_MODE ? 0xd97706 : 0xfde047, 0.062);
  group.add(traveler);

  const aura = addAura(mini.scene, 3.6, LIGHT_MODE ? 0.035 : 0.14);

  mini.add((t) => {
    aura.material.uniforms.uTime.value = t;
    group.rotation.y = t * 0.22;
    const u = (t * 0.6) % (Math.PI * 2);
    const cr = R_MAJOR + R_MINOR;
    traveler.position.set(cr * Math.cos(u), 0, cr * Math.sin(u));
  });
  return mini;
}

export function initMobiusOnly(container) {
  // 莫比乌斯环：唯一的单面带，没有内外之分——
  // 用更宽的莫比乌斯光带 + 沿边沿走完一整圈才"翻面"的旅行点。
  const mini = new MiniScene(container, { cameraPos: [0, 0.32, 4.9], exposure: 1.16 });
  const group = new THREE.Group();
  group.rotation.x = -0.32;
  mini.scene.add(group);

  const cloud = makeLogoPointCloud(2600, {
    radius: 1.05,
    width: 0.46,
    dotSize: 0.062,
    flowSpeed: 0.22,
    breathSpeed: 1.1,
    breathStrength: 0.72,
    glow: 1.0,
    edgeBias: 0.32,
    colors: BRAND,
  });
  group.add(cloud.points);

  // 旅行点：走完 4π 才回到原位（"没有尽头"的视觉隐喻）
  const path = makeLine(96, LIGHT_MODE ? 0xd97706 : 0xfde047, 0.85);
  const traveler = makeTraveler(LIGHT_MODE ? 0xd97706 : 0xfde047, 0.058);
  group.add(path, traveler);

  const aura = addAura(mini.scene, 3.6, LIGHT_MODE ? 0.04 : 0.16);

  mini.add((t) => {
    cloud.uniforms.uTime.value = t;
    aura.material.uniforms.uTime.value = t;
    group.rotation.y = t * 0.22;
    // 旅行点走完 4π 才回到原位（"没有尽头"的视觉隐喻）
    const u = (t * 0.42) % (Math.PI * 4);
    traveler.position.copy(infinityPoint(u, 0.85, { radius: 1.05, width: 0.46 }));
    updateInfinityLine(path, {
      radius: 1.05,
      width: 0.46,
      v: 0.85,
      start: u - 0.6,
      span: 0.6,
    });
  });
  return mini;
}

export function initTrinityMobius(container, mode) {
  const mini = new MiniScene(container, { cameraPos: [0, 0.32, 4.9], exposure: 1.16 });
  const group = new THREE.Group();
  group.rotation.x = -0.16;
  mini.scene.add(group);

  const isStars = mode === 'stars';
  const isDimension = mode === 'dimension';
  const isLoop = mode === 'loop';

  // 点云本体：实线轮廓已移除，仅靠光点表达形态。
  const cloud = makeLogoPointCloud(isStars ? 2400 : (isDimension ? 1900 : 1550), {
    radius: 1.32,
    width: isStars ? 0.3 : 0.32,
    dotSize: isStars ? 0.06 : 0.065,
    flowSpeed: isLoop ? 0.25 : (isDimension ? 0.16 : 0.12),
    breathSpeed: isStars ? 1.4 : 1.05,
    breathStrength: isStars ? 0.55 : 0.68,
    glow: isStars ? 1.1 : 0.95,
    edgeBias: isLoop ? 0.34 : 0.2,
    twinkle: isStars ? 0.85 : 0,
    twinkleFraction: isStars ? 0.28 : 0,
    colors: BRAND,
  });
  group.add(cloud.points);

  const aura = addAura(mini.scene, 3.2, LIGHT_MODE ? 0.035 : (isStars ? 0.1 : 0.12));

  // 仅 loop 模式保留旅行小球；dimension / stars 不要小球。
  let traveler = null;
  if (isLoop) {
    traveler = makeTraveler(LIGHT_MODE ? 0xd97706 : 0xfde047, 0.05);
    group.add(traveler);
  }

  let stars = null;
  if (isStars) {
    stars = createStarField(900, 3.8, BRAND);
    stars.material.size = 0.012;
    stars.material.opacity = LIGHT_MODE ? 0.26 : 0.42;
    mini.scene.add(stars);
  }

  mini.add((t) => {
    // dimension 模式：从 2D 圆环（twist≈0）平滑旋转粘贴到 3D 莫比乌斯环（twist=1）。
    let twist = 1;
    let zScale = 1;
    if (isDimension) {
      // 0→π：从 0 渐升到 1（粘贴形成）；π→2π：从 1 回到 0（展开复位）。
      const cycle = (t * 0.55) % (Math.PI * 2);
      const morph = 0.5 - 0.5 * Math.cos(cycle);
      twist = THREE.MathUtils.lerp(0.02, 1.15, morph);
      zScale = THREE.MathUtils.lerp(0.18, 1.1, morph);
    }
    cloud.uniforms.uTime.value = t;
    cloud.uniforms.uTwist.value = twist;
    cloud.uniforms.uZScale.value = zScale;
    aura.material.uniforms.uTime.value = t;
    group.rotation.y = t * (isLoop ? 0.2 : 0.13);
    group.rotation.z = isDimension ? Math.sin(t * 0.45) * 0.08 : 0;

    // loop 模式：旅行小球沿莫比乌斯带表面环行。
    if (traveler) {
      const u = (t * 0.92) % (Math.PI * 2);
      traveler.position.copy(infinityPoint(u, 0.74, { radius: 1.32, width: 0.32, twist, zScale }));
    }

    if (stars) {
      stars.rotation.y = t * 0.05;
      stars.rotation.x = Math.sin(t * 0.2) * 0.08;
      stars.material.opacity = (LIGHT_MODE ? 0.18 : 0.34) + (LIGHT_MODE ? 0.07 : 0.12) * Math.sin(t * 0.9);
    }
  });
  return mini;
}
