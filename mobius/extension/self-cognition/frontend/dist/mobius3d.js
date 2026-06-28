import * as THREE from 'three';

const BRAND = ['#22d3ee', '#7dd3fc', '#a78bfa', '#f472b6', '#fde68a'];
const PALETTE_MAX = 6;

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
  float wave = 0.5 + 0.5 * sin(angle * 3.0 + uTime * 0.24);
  vec3 a = vec3(0.03, 0.83, 0.91);
  vec3 b = vec3(0.63, 0.55, 0.96);
  vec3 c = vec3(0.96, 0.45, 0.62);
  vec3 color = mix(mix(a, b, wave), c, smoothstep(0.25, 0.9, p.x + 0.5));
  float alpha = smoothstep(0.72, 0.04, r) * uStrength;
  gl_FragColor = vec4(color * alpha, alpha);
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

function createPointCloud(count, options = {}) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const aU = new Float32Array(count);
  const aV = new Float32Array(count);
  const aPhase = new Float32Array(count);
  const aSize = new Float32Array(count);
  const aColorT = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const t = (i + Math.random() * 0.75) / count;
    const raw = Math.random() * 2 - 1;
    const edge = Math.random() < 0.22;
    aU[i] = t * Math.PI * 2;
    aV[i] = edge
      ? Math.sign(raw || 1) * (0.72 + Math.random() * 0.28)
      : Math.sign(raw || 1) * Math.pow(Math.abs(raw), 0.72);
    aPhase[i] = Math.random() * Math.PI * 2;
    aSize[i] = 0.72 + Math.random() * 0.72;
    aColorT[i] = Math.random();
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
  geometry.setAttribute('aV', new THREE.BufferAttribute(aV, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geometry.setAttribute('aColorT', new THREE.BufferAttribute(aColorT, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 120);

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: options.radius ?? 5.2 },
      uWidth: { value: options.width ?? 0.82 },
      uDotSize: { value: options.dotSize ?? 0.45 },
      uAlpha: { value: options.alpha ?? 0.62 },
      uGlow: { value: options.glow ?? 0.9 },
      uColors: { value: padColors(options.colors || BRAND) },
      uColorCount: { value: Math.min(PALETTE_MAX, (options.colors || BRAND).length) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, uniforms: material.uniforms };
}

function createStarField(count, spread = 15) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const r = Math.pow(Math.random(), 0.48) * spread;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.58;
    positions[i * 3 + 2] = r * Math.cos(phi) - spread * 0.15;
    const color = new THREE.Color(BRAND[(Math.random() * BRAND.length) | 0]);
    const dim = 0.42 + Math.random() * 0.54;
    colors[i * 3] = color.r * dim;
    colors[i * 3 + 1] = color.g * dim;
    colors[i * 3 + 2] = color.b * dim;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 0.018,
      vertexColors: true,
      transparent: true,
      opacity: 0.56,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
}

function addAura(scene, scale, strength) {
  const mesh = new THREE.Mesh(
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
      blending: THREE.AdditiveBlending,
    })
  );
  mesh.position.z = -1.2;
  scene.add(mesh);
  return mesh;
}

function createFallbackApi(canvas) {
  canvas.classList.add('is-webgl-unavailable');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.parentElement?.classList.add('is-webgl-unavailable');
  return {
    start() {},
    pause() {},
    dispose() {},
  };
}

export function initLogoBackdrop(canvas, variant = 'hero') {
  if (!canvas) return null;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x02010a, 0.035);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  camera.position.set(0, variant === 'finale' ? 2.4 : 2.8, variant === 'finale' ? 18 : 17);
  camera.lookAt(0, 0, 0);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch (error) {
    console.warn('[self-cognition] WebGL backdrop unavailable; continuing without 3D scene.', error);
    return createFallbackApi(canvas);
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const aura = addAura(scene, 16, variant === 'finale' ? 0.1 : 0.13);
  const stars = createStarField(variant === 'finale' ? 780 : 1050, 16);
  scene.add(stars);
  const cloud = createPointCloud(variant === 'finale' ? 3000 : 4200, {
    dotSize: variant === 'finale' ? 0.4 : 0.46,
    alpha: variant === 'finale' ? 0.5 : 0.62,
  });
  cloud.points.rotation.x = -0.15;
  cloud.points.rotation.z = -0.04;
  scene.add(cloud.points);

  let running = false;
  let frameId = 0;
  const clock = new THREE.Clock();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function renderFrame() {
    if (!running) return;
    if (!reduced) frameId = requestAnimationFrame(renderFrame);
    const time = clock.getElapsedTime();
    cloud.uniforms.uTime.value = time;
    aura.material.uniforms.uTime.value = time;
    cloud.points.rotation.y = Math.sin(time * 0.11) * 0.14;
    stars.rotation.y = time * 0.012;
    stars.rotation.x = Math.sin(time * 0.08) * 0.04;
    renderer.render(scene, camera);
    if (reduced) running = false;
  }

  resize();
  window.addEventListener('resize', resize);

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
    dispose() {
      running = false;
      if (frameId) cancelAnimationFrame(frameId);
      window.removeEventListener('resize', resize);
      renderer.dispose();
    },
  };
}
