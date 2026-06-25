import * as THREE from 'three';

const COLORS = {
  paper: '#3b82f6',
  product: '#8b5cf6',
  evolution: '#f59e0b',
};

function mobiusPoint(u, v, radius = 3.2, width = 0.72) {
  const half = u * 0.5;
  const x = (radius + v * width * Math.cos(half)) * Math.cos(u);
  const y = (radius + v * width * Math.cos(half)) * Math.sin(u) * 0.58;
  const z = v * width * Math.sin(half);
  return new THREE.Vector3(x, y, z);
}

function makeMobiusMesh() {
  const uSegments = 128;
  const vSegments = 10;
  const positions = [];
  const indices = [];
  for (let i = 0; i <= uSegments; i += 1) {
    const u = (i / uSegments) * Math.PI * 2;
    for (let j = 0; j <= vSegments; j += 1) {
      const v = (j / vSegments) * 2 - 1;
      const p = mobiusPoint(u, v);
      positions.push(p.x, p.y, p.z);
    }
  }
  const row = vSegments + 1;
  for (let i = 0; i < uSegments; i += 1) {
    for (let j = 0; j < vSegments; j += 1) {
      const a = i * row + j;
      const b = (i + 1) * row + j;
      const c = (i + 1) * row + j + 1;
      const d = i * row + j + 1;
      indices.push(a, b, d, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: 0x1d4ed8,
      wireframe: true,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
}

function makeGlowLine() {
  const points = [];
  for (let i = 0; i <= 240; i += 1) {
    points.push(mobiusPoint((i / 240) * Math.PI * 2, 0.88));
  }
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color: 0x3b82f6,
      transparent: true,
      opacity: 0.56,
      blending: THREE.AdditiveBlending,
    })
  );
}

function makePoint(type, shining = false) {
  const color = new THREE.Color(COLORS[type] || COLORS.paper);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(shining ? 0.07 : 0.038, 16, 16),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: shining ? 0.96 : 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  mesh.userData.baseScale = shining ? 1.25 : 0.82;
  mesh.userData.color = color;
  return mesh;
}

function defaultItems() {
  return [
    { type: 'paper', keyword: 'Top paper', title: '论文调研', summary: '等待高优先级论文线索。' },
    { type: 'product', keyword: 'Tracked', title: '竞品调研', summary: '等待已跟踪竞品动态。' },
    { type: 'evolution', keyword: 'L1', title: '自进化历史', summary: '等待 L1 改动记录。' },
  ];
}

function makeTooltip(container) {
  const tooltip = document.createElement('div');
  tooltip.className = 'ring-tooltip';
  tooltip.hidden = true;
  container.parentElement.appendChild(tooltip);
  return tooltip;
}

function renderTooltip(tooltip, item) {
  const title = item.title || item.keyword || '发现';
  const summary = item.summary || '';
  tooltip.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(summary)}</p>
    <span>${escapeHtml(item.keyword || item.type || 'Radar')}</span>
  `;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function initMobiusRing(canvas) {
  if (!canvas) return null;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0a0f, 0.035);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0.35, 9.8);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const group = new THREE.Group();
  group.rotation.x = -0.22;
  group.rotation.z = -0.08;
  scene.add(group);
  group.add(makeMobiusMesh());
  group.add(makeGlowLine());

  const sweep = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(4.5, 0, 0)]),
    new THREE.LineBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending })
  );
  sweep.position.z = 0.05;
  group.add(sweep);

  const flowCount = window.innerWidth < 720 ? 28 : 42;
  const shineCount = window.innerWidth < 720 ? 5 : 8;
  const flowPoints = [];
  const shinePoints = [];
  let discoveries = defaultItems();
  for (let i = 0; i < flowCount; i += 1) {
    const mesh = makePoint(i % 3 === 0 ? 'paper' : i % 3 === 1 ? 'product' : 'evolution');
    mesh.userData.u = (i / flowCount) * Math.PI * 2;
    mesh.userData.v = Math.sin(i * 2.1) * 0.72;
    mesh.userData.speed = 0.18 + (i % 5) * 0.018;
    flowPoints.push(mesh);
    group.add(mesh);
  }
  for (let i = 0; i < shineCount; i += 1) {
    const item = discoveries[i % discoveries.length];
    const mesh = makePoint(item.type, true);
    mesh.userData.u = (i / shineCount) * Math.PI * 2;
    mesh.userData.v = i % 2 ? 0.82 : -0.68;
    mesh.userData.speed = 0.08 + i * 0.006;
    mesh.userData.discovery = item;
    shinePoints.push(mesh);
    group.add(mesh);
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(-10, -10);
  const tooltip = makeTooltip(canvas);
  let running = false;
  let frameId = 0;
  let hovered = null;
  const clock = new THREE.Clock();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function updatePoint(mesh, time, shining = false) {
    const u = mesh.userData.u + time * mesh.userData.speed;
    const p = mobiusPoint(u, mesh.userData.v);
    mesh.position.copy(p);
    const pulse = shining ? 0.7 + Math.sin(time * 2.2 + mesh.userData.u * 3.0) * 0.35 : 0.32;
    const angleDelta = Math.abs(Math.atan2(Math.sin(u - sweep.rotation.z), Math.cos(u - sweep.rotation.z)));
    const sweepBoost = Math.max(0, 1 - angleDelta * 2.7);
    const scale = mesh.userData.baseScale * (1 + pulse + sweepBoost * 1.4);
    mesh.scale.setScalar(scale);
    mesh.material.opacity = shining ? Math.min(1, 0.62 + pulse * 0.28 + sweepBoost * 0.45) : 0.42 + sweepBoost * 0.35;
  }

  function frame() {
    if (!running) return;
    if (!reduced) frameId = requestAnimationFrame(frame);
    const time = clock.getElapsedTime();
    sweep.rotation.z = (time / 8) * Math.PI * 2;
    group.rotation.y = Math.sin(time * 0.08) * 0.18;
    flowPoints.forEach((mesh) => updatePoint(mesh, time, false));
    shinePoints.forEach((mesh) => updatePoint(mesh, time, true));

    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(shinePoints, false)[0]?.object || null;
    if (hit !== hovered) {
      hovered = hit;
      if (hovered) {
        renderTooltip(tooltip, hovered.userData.discovery || {});
        tooltip.hidden = false;
      } else {
        tooltip.hidden = true;
      }
    }
    renderer.render(scene, camera);
    if (reduced) running = false;
  }

  function onPointerMove(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    tooltip.style.left = `${event.clientX + 18}px`;
    tooltip.style.top = `${event.clientY + 16}px`;
  }

  function onPointerLeave() {
    pointer.set(-10, -10);
    hovered = null;
    tooltip.hidden = true;
  }

  resize();
  window.addEventListener('resize', resize);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);

  return {
    start() {
      if (running) return;
      running = true;
      clock.getDelta();
      frame();
    },
    pause() {
      running = false;
      if (frameId) cancelAnimationFrame(frameId);
    },
    updateDiscoveries(items) {
      discoveries = items?.length ? items : defaultItems();
      shinePoints.forEach((mesh, index) => {
        const item = discoveries[index % discoveries.length];
        mesh.userData.discovery = item;
        const color = new THREE.Color(COLORS[item.type] || COLORS.paper);
        mesh.material.color.copy(color);
      });
    },
  };
}
