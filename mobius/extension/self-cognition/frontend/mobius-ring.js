import * as THREE from 'three';

const BRAND = ['#22d3ee', '#7dd3fc', '#a78bfa', '#f472b6', '#fde68a'];
const PALETTE_MAX = 6;
const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 0, 1);

const TYPE_META = {
  paper: { label: '论文', accent: '#3b82f6', colorT: 0.2 },
  product: { label: '竞品', accent: '#8b5cf6', colorT: 0.55 },
  evolution: { label: 'L1', accent: '#64748b', colorT: 0.9 },
};

const MARKER_LAYOUT = [
  { u: 0.04 * TAU, v: -0.76, dx: -66, dy: -41 },
  { u: 0.18 * TAU, v: 0.72, dx: 66, dy: -46 },
  { u: 0.31 * TAU, v: -0.46, dx: -74, dy: 35 },
  { u: 0.45 * TAU, v: 0.84, dx: 68, dy: -33 },
  { u: 0.58 * TAU, v: -0.66, dx: -60, dy: 41 },
  { u: 0.72 * TAU, v: 0.56, dx: 70, dy: 38 },
  { u: 0.86 * TAU, v: -0.82, dx: -70, dy: -27 },
  { u: 0.96 * TAU, v: 0.32, dx: 60, dy: 35 },
];

const VERTEX_SHADER = /* glsl */`
attribute float aU;
attribute float aV;
attribute float aPhase;
attribute float aSize;
attribute float aColorT;

uniform float uTime;
uniform float uRadius;
uniform float uWidth;
uniform float uDotSize;
uniform vec3 uColors[${PALETTE_MAX}];
uniform int uColorCount;

varying vec3 vColor;
varying float vPulse;

vec3 centerLine(float u) {
  float x = uRadius * sin(u);
  float y = 0.52 * uRadius * sin(2.0 * u);
  float z = 0.24 * uRadius * cos(u);
  return vec3(x, y, z);
}

vec3 tangentLine(float u) {
  float dx = uRadius * cos(u);
  float dy = 1.04 * uRadius * cos(2.0 * u);
  float dz = -0.24 * uRadius * sin(u);
  return normalize(vec3(dx, dy, dz));
}

vec3 mobiusPoint(float u, float v) {
  vec3 center = centerLine(u);
  vec3 tangent = tangentLine(u);
  vec3 side = cross(vec3(0.0, 0.0, 1.0), tangent);
  if (dot(side, side) < 0.0001) side = vec3(1.0, 0.0, 0.0);
  side = normalize(side);
  vec3 lift = normalize(cross(tangent, side));
  float twist = u * 0.5;
  float pinch = mix(0.78, 1.0, smoothstep(0.18, 0.62, abs(sin(u))));
  vec3 ribbon = cos(twist) * side + sin(twist) * lift;
  return center + ribbon * v * uWidth * pinch;
}

vec3 palette(float t) {
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
  float u = aU + uTime * 0.08;
  vec3 pos = mobiusPoint(u, aV);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float pulse = 0.72 + 0.28 * sin(uTime * 1.15 + aPhase);
  vPulse = pulse;
  vColor = palette(fract(aColorT + u * 0.04));

  float dist = max(0.1, -mv.z);
  gl_PointSize = aSize * uDotSize * (430.0 / dist) * (0.8 + pulse * 0.28);
}
`;

const FRAGMENT_SHADER = /* glsl */`
precision highp float;
varying vec3 vColor;
varying float vPulse;
uniform float uAlpha;
uniform float uGlow;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;
  float core = smoothstep(0.5, 0.16, d);
  float halo = pow(max(0.0, 1.0 - d * 2.0), 2.4);
  vec3 color = vColor * (core * 0.92 + halo * uGlow * 0.64) * (0.72 + vPulse * 0.72);
  float alpha = (core + halo * uGlow * 0.68) * uAlpha;
  gl_FragColor = vec4(color, alpha);
}
`;

const SWEEP_VERTEX_SHADER = /* glsl */`
attribute float aU;
attribute float aV;
attribute float aPhase;
attribute float aSize;
attribute float aColorT;

uniform float uTime;
uniform float uRadius;
uniform float uWidth;
uniform float uDotSize;
uniform float uSweep;
uniform vec3 uColors[${PALETTE_MAX}];
uniform int uColorCount;

varying vec3 vColor;
varying float vPulse;
varying float vSweep;

vec3 centerLine(float u) {
  float x = uRadius * sin(u);
  float y = 0.52 * uRadius * sin(2.0 * u);
  float z = 0.24 * uRadius * cos(u);
  return vec3(x, y, z);
}

vec3 tangentLine(float u) {
  float dx = uRadius * cos(u);
  float dy = 1.04 * uRadius * cos(2.0 * u);
  float dz = -0.24 * uRadius * sin(u);
  return normalize(vec3(dx, dy, dz));
}

vec3 mobiusPoint(float u, float v) {
  vec3 center = centerLine(u);
  vec3 tangent = tangentLine(u);
  vec3 side = cross(vec3(0.0, 0.0, 1.0), tangent);
  if (dot(side, side) < 0.0001) side = vec3(1.0, 0.0, 0.0);
  side = normalize(side);
  vec3 lift = normalize(cross(tangent, side));
  float twist = u * 0.5;
  float pinch = mix(0.78, 1.0, smoothstep(0.18, 0.62, abs(sin(u))));
  vec3 ribbon = cos(twist) * side + sin(twist) * lift;
  return center + ribbon * v * uWidth * pinch;
}

vec3 palette(float t) {
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
  float u = aU + uTime * 0.08;
  vec3 pos = mobiusPoint(u, aV);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float delta = abs(atan(sin(u - uSweep), cos(u - uSweep)));
  float wave = 0.5 + 0.5 * sin(u * 3.0 + uTime * 0.24);
  float sweep = smoothstep(0.5, 0.0, delta) * (0.62 + wave * 0.38);
  float pulse = 0.72 + 0.28 * sin(uTime * 1.15 + aPhase);

  vPulse = pulse;
  vSweep = sweep;
  vColor = palette(fract(aColorT + u * 0.04 + sweep * 0.12));

  float dist = max(0.1, -mv.z);
  gl_PointSize = aSize * uDotSize * (430.0 / dist) * (0.85 + pulse * 0.28 + sweep * 1.85);
}
`;

const SWEEP_FRAGMENT_SHADER = /* glsl */`
precision highp float;
varying vec3 vColor;
varying float vPulse;
varying float vSweep;
uniform float uAlpha;
uniform float uGlow;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;
  float core = smoothstep(0.5, 0.14, d);
  float halo = pow(max(0.0, 1.0 - d * 2.0), 2.0);
  vec3 color = vColor * (core * 0.9 + halo * uGlow) * (0.7 + vPulse * 0.72);
  float alpha = (core + halo * uGlow * 0.68) * uAlpha * vSweep;
  gl_FragColor = vec4(color, alpha);
}
`;

function colorVec(hex) {
  const color = new THREE.Color(hex);
  return new THREE.Vector3(color.r, color.g, color.b);
}

function padColors(colors) {
  const source = colors.map(colorVec);
  const padded = [];
  for (let i = 0; i < PALETTE_MAX; i += 1) {
    padded.push(source[Math.min(i, source.length - 1)]);
  }
  return padded;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function centerLine(u, radius) {
  return new THREE.Vector3(
    radius * Math.sin(u),
    0.52 * radius * Math.sin(2 * u),
    0.24 * radius * Math.cos(u)
  );
}

function tangentLine(u, radius) {
  return new THREE.Vector3(
    radius * Math.cos(u),
    1.04 * radius * Math.cos(2 * u),
    -0.24 * radius * Math.sin(u)
  ).normalize();
}

function mobiusPoint(u, v, radius = 10.4, width = 1.64) {
  const center = centerLine(u, radius);
  const tangent = tangentLine(u, radius);
  const side = new THREE.Vector3().crossVectors(UP, tangent);
  if (side.lengthSq() < 0.0001) side.set(1, 0, 0);
  side.normalize();
  const lift = new THREE.Vector3().crossVectors(tangent, side).normalize();
  const twist = u * 0.5;
  const pinch = THREE.MathUtils.lerp(0.78, 1, smoothstep(0.18, 0.62, Math.abs(Math.sin(u))));
  const ribbon = side.multiplyScalar(Math.cos(twist)).add(lift.multiplyScalar(Math.sin(twist)));
  return center.add(ribbon.multiplyScalar(v * width * pinch));
}

function createPointAttributes(count, mapper) {
  const positions = new Float32Array(count * 3);
  const aU = new Float32Array(count);
  const aV = new Float32Array(count);
  const aPhase = new Float32Array(count);
  const aSize = new Float32Array(count);
  const aColorT = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const data = mapper(i);
    aU[i] = data.u;
    aV[i] = data.v;
    aPhase[i] = data.phase;
    aSize[i] = data.size;
    aColorT[i] = data.colorT;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
  geometry.setAttribute('aV', new THREE.BufferAttribute(aV, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geometry.setAttribute('aColorT', new THREE.BufferAttribute(aColorT, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 120);
  return geometry;
}

function createMobiusGeometry(count) {
  return createPointAttributes(count, (i) => {
    const t = (i + Math.random() * 0.75) / count;
    const raw = Math.random() * 2 - 1;
    const edge = Math.random() < 0.22;
    return {
      u: t * TAU,
      v: edge
        ? Math.sign(raw || 1) * (0.72 + Math.random() * 0.28)
        : Math.sign(raw || 1) * Math.pow(Math.abs(raw), 0.72),
      phase: Math.random() * TAU,
      size: 0.72 + Math.random() * 0.72,
      colorT: Math.random(),
    };
  });
}

function createPointCloud(count, options = {}) {
  const material = new THREE.ShaderMaterial({
    vertexShader: options.vertexShader || VERTEX_SHADER,
    fragmentShader: options.fragmentShader || FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: options.radius ?? 8.32 },
      uWidth: { value: options.width ?? 1.312 },
      uDotSize: { value: options.dotSize ?? 0.72 },
      uAlpha: { value: options.alpha ?? 0.62 },
      uGlow: { value: options.glow ?? 0.9 },
      uSweep: { value: 0 },
      uColors: { value: padColors(options.colors || BRAND) },
      uColorCount: { value: Math.min(PALETTE_MAX, (options.colors || BRAND).length) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(options.geometry || createMobiusGeometry(count), material);
  points.frustumCulled = false;
  return { points, uniforms: material.uniforms };
}

function createStarField(count, spread = 15) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const r = Math.pow(Math.random(), 0.48) * spread;
    const theta = Math.random() * TAU;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.58;
    positions[i * 3 + 2] = r * Math.cos(phi) - spread * 0.15;
    const color = new THREE.Color(BRAND[(Math.random() * BRAND.length) | 0]);
    const dim = 0.28 + Math.random() * 0.38;
    colors[i * 3] = color.r * dim;
    colors[i * 3 + 1] = color.g * dim;
    colors[i * 3 + 2] = color.b * dim;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 0.016,
      vertexColors: true,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
}

function typeMeta(type) {
  return TYPE_META[type] || TYPE_META.paper;
}

function typeLabel(type) {
  return typeMeta(type).label;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function compact(value, max = 48) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function defaultItems() {
  return [
    {
      type: 'paper',
      keyword: '论文线索',
      title: '论文调研',
      summary: '等待高优先级论文线索。',
      meta: ['Top Picks', '未加载', 'Radar'],
    },
    {
      type: 'paper',
      keyword: 'Top Picks',
      title: '跨 cluster 优先调研',
      summary: '聚类完成后展示最需要优先阅读的论文。',
      meta: ['论文', 'cluster', 'priority'],
    },
    {
      type: 'product',
      keyword: '已跟踪竞品',
      title: '竞品调研',
      summary: '等待已跟踪竞品动态。',
      meta: ['竞品', 'official', 'snapshot'],
    },
    {
      type: 'product',
      keyword: '候选晋升',
      title: '竞品候选区',
      summary: '候选项可晋升为正式跟踪对象。',
      meta: ['竞品', 'candidate', 'review'],
    },
  ];
}

function markerTargetCount() {
  if (window.innerWidth < 720) return 5;
  if (window.innerWidth < 1080) return 6;
  return 7;
}

function normalizeItems(items) {
  const source = Array.isArray(items) && items.length ? items : defaultItems();
  const targetCount = markerTargetCount();
  const fallback = defaultItems();
  const out = [];
  for (let i = 0; i < targetCount; i += 1) {
    const item = source[i] || fallback[i % fallback.length] || source[i % source.length];
    const type = item.type === 'product' || item.type === 'evolution' ? item.type : 'paper';
    out.push({
      ...item,
      type,
      keyword: compact(item.keyword || item.title || typeLabel(type), 22),
      title: compact(item.title || item.keyword || '雷达发现', 72),
      summary: compact(item.summary || '暂无摘要。', 60),
      meta: Array.isArray(item.meta) ? item.meta.filter(Boolean).slice(0, 3) : [],
    });
  }
  return out;
}

function makeTooltip(container) {
  const tooltip = document.createElement('div');
  tooltip.className = 'ring-tooltip';
  tooltip.hidden = true;
  container.appendChild(tooltip);
  return tooltip;
}

function renderTooltip(tooltip, item) {
  const meta = typeMeta(item.type);
  tooltip.style.setProperty('--ring-accent', meta.accent);
  tooltip.innerHTML = `
    <div class="ring-card-chip">${escapeHtml(meta.label)}</div>
    <h3>${escapeHtml(item.title || item.keyword || '雷达发现')}</h3>
    <div class="ring-card-rule"></div>
    <p>${escapeHtml(item.summary || '暂无摘要。')}</p>
    <div class="ring-card-meta">
      ${(item.meta || []).slice(0, 3).map((value) => `<span>${escapeHtml(compact(value, 34))}</span>`).join('')}
    </div>
  `;
}

function createLabel(layer, item, index) {
  const meta = typeMeta(item.type);
  const label = document.createElement('div');
  label.className = 'ring-label';
  label.dataset.markerIndex = String(index);
  label.style.setProperty('--ring-accent', meta.accent);
  label.innerHTML = `
    <span class="ring-label-bar"></span>
    <span class="ring-label-text">${escapeHtml(item.keyword)}</span>
    <span class="ring-label-chip">${escapeHtml(meta.label)}</span>
  `;
  layer.appendChild(label);
  return label;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function initMobiusRing(canvas, options = {}) {
  if (!canvas) return null;
  const container = canvas.parentElement;
  if (!container) return null;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x02010a, 0.035);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(0, 2.04, 13.76);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.setClearColor(0x000000, 0);

  const stars = createStarField(window.innerWidth < 720 ? 520 : 780, 16);
  scene.add(stars);

  const ringGroup = new THREE.Group();
  ringGroup.rotation.x = -0.15;
  ringGroup.rotation.z = -0.04;
  scene.add(ringGroup);

  const baseCloud = createPointCloud(window.innerWidth < 720 ? 2800 : 4600, {
    dotSize: window.innerWidth < 720 ? 0.84 : 0.92,
    alpha: 0.6,
  });
  ringGroup.add(baseCloud.points);

  const sweepCloud = createPointCloud(window.innerWidth < 720 ? 900 : 1500, {
    vertexShader: SWEEP_VERTEX_SHADER,
    fragmentShader: SWEEP_FRAGMENT_SHADER,
    dotSize: window.innerWidth < 720 ? 1.16 : 1.32,
    alpha: 0.64,
    glow: 1.25,
  });
  ringGroup.add(sweepCloud.points);

  const labelLayer = document.createElement('div');
  labelLayer.className = 'ring-label-layer';
  container.appendChild(labelLayer);
  const tooltip = makeTooltip(container);

  let markerCloud = null;
  let discoveryItems = [];
  let markerItems = normalizeItems([]);
  let markerLabels = [];
  let markerPositions = [];
  let hoveredIndex = -1;
  let running = false;
  let frameId = 0;
  let lastTime = 0;
  let markerCount = 0;
  const pointer = { x: -10000, y: -10000, inside: false };
  const clock = new THREE.Clock();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const projected = new THREE.Vector3();
  const worldPoint = new THREE.Vector3();

  function createMarkerCloud(items) {
    const geometry = createPointAttributes(items.length, (index) => {
      const layout = MARKER_LAYOUT[index % MARKER_LAYOUT.length];
      const meta = typeMeta(items[index].type);
      return {
        u: layout.u,
        v: layout.v,
        phase: index * 1.37,
        size: 1.22 + (index % 3) * 0.14,
        colorT: meta.colorT,
      };
    });
    return createPointCloud(items.length, {
      geometry,
      dotSize: window.innerWidth < 720 ? 1.36 : 1.56,
      alpha: 0.92,
      glow: 1.52,
    });
  }

  function rebuildMarkers(items = discoveryItems) {
    markerItems = normalizeItems(items);
    markerCount = markerItems.length;
    markerLabels.forEach((label) => label.remove());
    markerLabels = markerItems.map((item, index) => createLabel(labelLayer, item, index));
    markerLabels.forEach((label, index) => {
      label.addEventListener('pointerenter', () => setHovered(index, markerPositions[index]));
      label.addEventListener('pointermove', () => positionTooltip(markerPositions[index]));
      label.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        setHovered(index, markerPositions[index]);
      });
      label.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectMarker(index);
      });
      label.addEventListener('pointerleave', () => {
        if (!pointer.inside) clearHovered();
      });
    });

    if (markerCloud) {
      ringGroup.remove(markerCloud.points);
      markerCloud.points.geometry.dispose();
      markerCloud.points.material.dispose();
    }
    markerCloud = createMarkerCloud(markerItems);
    ringGroup.add(markerCloud.points);
    updateLabels(lastTime);
  }

  function setHovered(index, anchor = null) {
    if (index < 0 || !markerItems[index]) {
      clearHovered();
      return;
    }
    hoveredIndex = index;
    markerLabels.forEach((label, labelIndex) => {
      label.classList.toggle('is-hovered', labelIndex === hoveredIndex);
    });
    renderTooltip(tooltip, markerItems[index]);
    tooltip.hidden = false;
    positionTooltip(anchor || markerPositions[index]);
  }

  function clearHovered() {
    hoveredIndex = -1;
    tooltip.hidden = true;
    markerLabels.forEach((label) => label.classList.remove('is-hovered'));
  }

  function positionTooltip(anchor) {
    if (tooltip.hidden || !anchor) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    const cardWidth = tooltip.offsetWidth || 268;
    const cardHeight = tooltip.offsetHeight || 148;
    const left = clamp(anchor.x + 18, 12, Math.max(12, width - cardWidth - 12));
    const top = clamp(anchor.y + 16, 12, Math.max(12, height - cardHeight - 12));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function resize() {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    camera.aspect = width / height;
    camera.position.z = width < 720 ? 19.6 : 17.2;
    camera.position.y = width < 720 ? 2.35 : 2.55;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    const nextCount = markerTargetCount();
    if (markerCount && nextCount !== markerCount) rebuildMarkers(discoveryItems);
    updateLabels(lastTime);
  }

  function markerWorldPosition(index, time) {
    const layout = MARKER_LAYOUT[index % MARKER_LAYOUT.length];
    const u = layout.u + time * 0.08;
    worldPoint.copy(mobiusPoint(u, layout.v));
    ringGroup.updateMatrixWorld();
    return worldPoint.applyMatrix4(ringGroup.matrixWorld);
  }

  function updateLabels(time) {
    const width = container.clientWidth || canvas.clientWidth || 1;
    const height = container.clientHeight || canvas.clientHeight || 1;
    markerPositions = markerItems.map((_, index) => {
      const layout = MARKER_LAYOUT[index % MARKER_LAYOUT.length];
      projected.copy(markerWorldPosition(index, time)).project(camera);
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;
      const labelX = clamp(x + layout.dx, 8, width - 8);
      const labelY = clamp(y + layout.dy, 8, height - 8);
      const label = markerLabels[index];
      if (label) {
        const hidden = projected.z < -1 || projected.z > 1;
        label.style.opacity = hidden ? '0' : '';
        label.style.transform = `translate3d(${labelX}px, ${labelY}px, 0) translate(-50%, -50%) scale(var(--label-scale, 1))`;
      }
      return { x: clamp(x, 10, width - 10), y: clamp(y, 10, height - 10), labelX, labelY };
    });
    if (hoveredIndex >= 0) positionTooltip(markerPositions[hoveredIndex]);
  }

  function updatePointerHover() {
    if (!pointer.inside) return;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    markerPositions.forEach((pos, index) => {
      const dx = pointer.x - pos.x;
      const dy = pointer.y - pos.y;
      const distance = Math.hypot(dx, dy);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0 && bestDistance < 46) {
      setHovered(bestIndex, markerPositions[bestIndex]);
    } else if (hoveredIndex >= 0 && bestDistance > 72) {
      clearHovered();
    }
  }

  function nearestMarker(maxDistance = 58) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    markerPositions.forEach((pos, index) => {
      const distance = Math.hypot(pointer.x - pos.x, pointer.y - pos.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestDistance <= maxDistance ? bestIndex : -1;
  }

  function selectMarker(index = hoveredIndex) {
    if (index < 0 || !markerItems[index]) return;
    const item = markerItems[index];
    setHovered(index, markerPositions[index]);
    if (typeof options.onSelect === 'function') options.onSelect(item);
    container.dispatchEvent(new CustomEvent('mobius-ring-select', { detail: { item } }));
  }

  function renderFrame() {
    if (!running) return;
    if (!reduced) frameId = requestAnimationFrame(renderFrame);
    const time = clock.getElapsedTime();
    lastTime = time;

    baseCloud.uniforms.uTime.value = time;
    sweepCloud.uniforms.uTime.value = time;
    sweepCloud.uniforms.uSweep.value = (time * 0.34) % TAU;
    if (markerCloud) markerCloud.uniforms.uTime.value = time;

    ringGroup.rotation.y = Math.sin(time * 0.11) * 0.14;
    stars.rotation.y = time * 0.012;
    stars.rotation.x = Math.sin(time * 0.08) * 0.04;
    updateLabels(time);
    updatePointerHover();
    renderer.render(scene, camera);
    if (reduced) running = false;
  }

  function onPointerMove(event) {
    const rect = container.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
    pointer.inside = true;
    const label = event.target.closest?.('.ring-label');
    if (label) {
      setHovered(Number(label.dataset.markerIndex), markerPositions[Number(label.dataset.markerIndex)]);
      return;
    }
    updatePointerHover();
  }

  function onClick(event) {
    const rect = container.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
    pointer.inside = true;
    const label = event.target.closest?.('.ring-label');
    const index = label ? Number(label.dataset.markerIndex) : nearestMarker();
    selectMarker(index);
  }

  function onPointerLeave() {
    pointer.inside = false;
    clearHovered();
  }

  rebuildMarkers(discoveryItems);
  resize();
  window.addEventListener('resize', resize);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('click', onClick);
  container.addEventListener('pointerleave', onPointerLeave);

  return {
    start() {
      if (running) return;
      running = true;
      clock.getDelta();
      renderFrame();
    },
    pause() {
      running = false;
      if (frameId) cancelAnimationFrame(frameId);
    },
    updateDiscoveries(items) {
      discoveryItems = Array.isArray(items) && items.length ? items : [];
      rebuildMarkers(discoveryItems);
      if (!running) {
        resize();
        renderer.render(scene, camera);
      }
    },
  };
}
