import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const VISUAL_MODES = Object.freeze(['final', 'noPost', 'silhouette', 'material', 'emissive', 'vfx', 'bounds']);
const QUALITY_PRESETS = Object.freeze({
  low: { maxDpr: 1.25, pixelBudget: 1100000, bloom: false, roleProps: true, vfxScale: 0.62 },
  balanced: { maxDpr: 1.5, pixelBudget: 2200000, bloom: true, roleProps: true, vfxScale: 0.82 },
  high: { maxDpr: 2, pixelBudget: 4200000, bloom: true, roleProps: true, vfxScale: 1 },
});

const ROLE_PROPS = Object.freeze({
  shambler: { glyph: '骨', label: '断臂', color: '#b9d881', side: -1, lift: 1.54, spin: 0.7 },
  crawler: { glyph: '爪', label: '贴地', color: '#9cff75', side: 1, lift: 0.94, spin: 1.3 },
  sprinter: { glyph: '»', label: '狂奔', color: '#ff9f43', side: 1, lift: 1.62, spin: 2.2 },
  spitter: { glyph: '酸', label: '喷吐', color: '#87ff57', side: -1, lift: 1.48, spin: 1.1 },
  bloater: { glyph: '肉', label: '胖尸', color: '#c799ff', side: 1, lift: 1.38, spin: 0.55 },
  armored: { glyph: '盾', label: '装甲', color: '#b7d6e5', side: -1, lift: 1.52, spin: 0.35 },
  mutant: { glyph: '爪爪', label: '变异', color: '#ff668a', side: 1, lift: 1.62, spin: 1.25 },
  screamer: { glyph: '啊', label: '尖啸', color: '#ff82e7', side: -1, lift: 1.72, spin: 1.8 },
  nestGuard: { glyph: '巢', label: '守卫', color: '#e776ff', side: 1, lift: 1.58, spin: 0.48 },
  alpha: { glyph: '♛', label: '尸将', color: '#ff536d', side: 0, lift: 1.94, spin: 0.65 },
  bug: { glyph: 'BUG', label: '线上', color: '#ff5c6c', side: -1, lift: 1.55, spin: 0.8 },
  intern: { glyph: '↯', label: '直推', color: '#ffca5c', side: 1, lift: 1.64, spin: 2.2 },
  qa: { glyph: '⌕', label: '测试', color: '#85e9ff', side: -1, lift: 1.58, spin: 0.9 },
  product: { glyph: '+1', label: '需求', color: '#ff77ba', side: 1, lift: 1.46, spin: 0.6 },
  ops: { glyph: '99+', label: '报警', color: '#ff9b5f', side: -1, lift: 1.62, spin: 1.65 },
  architect: { glyph: '⌘', label: '重构', color: '#76bbff', side: 1, lift: 1.58, spin: 0.45 },
  security: { glyph: '锁', label: '安全', color: '#ca8cff', side: -1, lift: 1.64, spin: 0.58 },
  leader: { glyph: '!', label: '今晚', color: '#ff6fae', side: 1, lift: 1.78, spin: 1.4 },
  clientRep: { glyph: '改', label: '甲方', color: '#ff7292', side: -1, lift: 1.68, spin: 0.75 },
  executive: { glyph: '全球', label: '明早', color: '#ff4f7e', side: 0, lift: 1.96, spin: 0.5 },
  boss: { glyph: 'BOSS', label: '终局', color: '#ff3d68', side: 0, lift: 1.94, spin: 0.4 },
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function stableHash(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function makeChamferedPanelGeometry(width, height, depth, cut = 0.16) {
  const x = width / 2;
  const y = height / 2;
  const c = Math.min(cut, x * 0.42, y * 0.42);
  const shape = new THREE.Shape();
  shape.moveTo(-x + c, -y);
  shape.lineTo(x - c, -y);
  shape.lineTo(x, -y + c);
  shape.lineTo(x, y - c);
  shape.lineTo(x - c, y);
  shape.lineTo(-x + c, y);
  shape.lineTo(-x, y - c);
  shape.lineTo(-x, -y + c);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeRoleTexture(config, themeId = 'zombie') {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.scale(1.6, 1.6);
  const isDeadline = themeId === 'deadline';
  const accent = config.color;
  const panel = isDeadline ? '#122343' : '#112922';
  const panelDeep = isDeadline ? '#071326' : '#071914';
  const secondary = isDeadline ? '#8fdcff' : '#baff8b';
  const gradient = ctx.createRadialGradient(160, 136, 8, 160, 136, 142);
  gradient.addColorStop(0, isDeadline ? 'rgba(159,222,255,.28)' : 'rgba(204,255,151,.25)');
  gradient.addColorStop(0.56, `${accent}45`);
  gradient.addColorStop(1, 'rgba(3,8,15,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 320, 320);

  // A sticker-like identity plate survives the tiny in-game scale better than
  // a floating text label. The face/expression stays comic, while the accent
  // and footer remain semantic for the role.
  const plate = new Path2D();
  plate.moveTo(36, 28);
  plate.lineTo(284, 28);
  plate.quadraticCurveTo(300, 28, 300, 44);
  plate.lineTo(300, 252);
  plate.quadraticCurveTo(300, 270, 282, 270);
  plate.lineTo(38, 270);
  plate.quadraticCurveTo(20, 270, 20, 252);
  plate.lineTo(20, 46);
  plate.quadraticCurveTo(20, 28, 36, 28);
  plate.closePath();
  ctx.fillStyle = panel;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 6;
  ctx.shadowColor = `${accent}99`;
  ctx.shadowBlur = 18;
  ctx.fill(plate);
  ctx.stroke(plate);
  ctx.shadowBlur = 0;

  ctx.fillStyle = panelDeep;
  ctx.beginPath();
  ctx.arc(160, 132, 84, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = `${accent}bb`;
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect(102, 42, 116, 42, 13);
  ctx.fill();
  ctx.fillStyle = '#07111f';
  ctx.textAlign = 'center';
  ctx.font = `1000 ${config.glyph.length >= 3 ? 22 : 28}px system-ui, "PingFang SC", sans-serif`;
  ctx.fillText(config.glyph, 160, 72);

  const expression = config.glyph === '啊' || config.glyph === '99+' || config.glyph === '!' ? 'surprised' : config.glyph === '⌕' || config.glyph === '锁' ? 'focused' : config.glyph === '肉' || config.glyph === '改' ? 'smug' : 'goofy';
  ctx.fillStyle = '#f7fbff';
  ctx.strokeStyle = '#09121a';
  ctx.lineWidth = 5;
  if (expression === 'surprised') {
    ctx.beginPath(); ctx.ellipse(125, 122, 13, 21, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(195, 122, 13, 21, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#101923'; ctx.beginPath(); ctx.arc(128, 125, 5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(192, 125, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff7891'; ctx.beginPath(); ctx.ellipse(160, 174, 15, 21, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else if (expression === 'focused') {
    ctx.fillStyle = secondary;
    ctx.fillRect(104, 112, 42, 21); ctx.fillRect(174, 112, 42, 21);
    ctx.strokeRect(104, 112, 42, 21); ctx.strokeRect(174, 112, 42, 21);
    ctx.beginPath(); ctx.moveTo(146, 121); ctx.lineTo(174, 121); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(128, 165); ctx.quadraticCurveTo(160, 181, 192, 165); ctx.stroke();
  } else if (expression === 'smug') {
    ctx.fillStyle = '#f7fbff';
    ctx.beginPath(); ctx.arc(125, 121, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(195, 121, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#111b25'; ctx.beginPath(); ctx.arc(130, 119, 5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(190, 119, 5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(132, 171); ctx.quadraticCurveTo(164, 185, 198, 161); ctx.stroke();
  } else {
    ctx.fillStyle = '#f7fbff';
    ctx.beginPath(); ctx.ellipse(124, 122, 18, 14, -0.18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(196, 122, 18, 14, 0.18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#111b25'; ctx.beginPath(); ctx.arc(128, 124, 6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(192, 124, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = secondary; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(160, 145, 36, 0.18, Math.PI - 0.18); ctx.stroke();
  }

  ctx.strokeStyle = accent;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(56, 58); ctx.lineTo(82, 45);
  ctx.moveTo(264, 58); ctx.lineTo(238, 45);
  ctx.stroke();
  ctx.fillStyle = isDeadline ? '#71d9ff' : '#b8ff7f';
  ctx.font = '1000 18px system-ui, "PingFang SC", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(isDeadline ? 'LIVE / 需求流' : 'LIVE / 尸潮流', 42, 298);
  ctx.textAlign = 'right';
  ctx.fillText(isDeadline ? '工单处理中' : '正在觅食', 278, 298);

  ctx.fillStyle = accent;
  ctx.fillRect(48, 214, 224, 40);
  ctx.fillStyle = '#07111f';
  ctx.textAlign = 'center';
  const compact = config.glyph.length >= 3;
  ctx.font = `1000 ${compact ? 26 : 29}px system-ui, "PingFang SC", sans-serif`;
  ctx.fillText(config.label, 160, 242);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function makePbr(color, roughness, metalness, emissive = 0x000000, emissiveIntensity = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });
}

function buildZombieBase() {
  const group = new THREE.Group();
  group.name = 'visual-zombie-base';
  const concrete = makePbr(0x304653, 0.78, 0.28, 0x07161c, 0.35);
  const armor = makePbr(0x19323d, 0.34, 0.82, 0x0b2f31, 0.56);
  const rust = makePbr(0x75442c, 0.64, 0.5, 0x2a0c06, 0.28);
  const glow = new THREE.MeshBasicMaterial({ color: 0x4fffd2, transparent: true, opacity: 0.9, toneMapped: false });
  const danger = new THREE.MeshBasicMaterial({ color: 0xff5f57, transparent: true, opacity: 0.8, toneMapped: false });
  const panels = [];
  for (let index = 0; index < 9; index += 1) {
    const panel = new THREE.Mesh(makeChamferedPanelGeometry(2.18, 1.62, 0.72, 0.24), index % 2 ? concrete : armor);
    panel.position.set((index - 4) * 2.25, 0.82, 11.42 + Math.abs(index - 4) * 0.025);
    panel.rotation.y = (index - 4) * -0.008;
    group.add(panel);
    const slit = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.1, 0.055), index % 3 === 0 ? danger : glow);
    slit.position.set(panel.position.x, 1.18, 11.02);
    group.add(slit);
    panels.push(panel);
  }
  const core = new THREE.Group();
  core.position.set(0, 1.6, 13.22);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.18, 1.55, 2.72, 28, 3), armor);
  core.add(tower);
  const reactor = new THREE.Mesh(new THREE.IcosahedronGeometry(0.68, 2), makePbr(0xcffff3, 0.18, 0.08, 0x28b89b, 1.85));
  reactor.position.y = 0.24;
  core.add(reactor);
  const rings = [0, 1, 2].map((index) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.9 + index * 0.16, 0.045, 12, 64), glow.clone());
    ring.rotation.x = Math.PI / 2 + (index - 1) * 0.35;
    ring.position.y = 0.24;
    core.add(ring);
    return ring;
  });
  group.add(core);
  const spotlights = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 8.75, 0, 11.45);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 3.7, 20), rust);
    mast.position.y = 1.85;
    pivot.add(mast);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.38, 0.62, 24, 2), armor);
    head.rotation.x = Math.PI / 2;
    head.position.set(0, 3.65, -0.2);
    pivot.add(head);
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(1.25, 5.8, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xbfffea, transparent: true, opacity: 0.075, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    cone.rotation.x = -Math.PI / 2;
    cone.position.set(0, 3.15, -3.1);
    pivot.add(cone);
    group.add(pivot);
    spotlights.push(pivot);
  }
  for (const side of [-1, 1]) {
    for (let index = 0; index < 6; index += 1) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 1.35, 12), rust);
      post.position.set(side * (10.15 + (index % 2) * 0.18), 0.65, 8.6 - index * 2.4);
      post.rotation.z = side * 0.05;
      group.add(post);
    }
  }
  return { group, panels, core, reactor, rings, spotlights, glowMaterials: [glow, danger] };
}

function buildDeadlineBase() {
  const group = new THREE.Group();
  group.name = 'visual-deadline-base';
  const chassis = makePbr(0x172b55, 0.33, 0.76, 0x061532, 0.75);
  const trim = makePbr(0x5b7eb8, 0.21, 0.84, 0x143b7a, 0.58);
  const glass = makePbr(0x79d8ff, 0.14, 0.22, 0x2388d4, 2.2);
  const ledGreen = new THREE.MeshBasicMaterial({ color: 0x45f0d0, toneMapped: false });
  const ledRed = new THREE.MeshBasicMaterial({ color: 0xff526a, toneMapped: false });
  const racks = [];
  for (let index = 0; index < 7; index += 1) {
    const rack = new THREE.Group();
    rack.position.set((index - 3) * 2.7, 0, 12.15 + Math.abs(index - 3) * 0.08);
    const body = new THREE.Mesh(makeChamferedPanelGeometry(2.28, 2.25, 0.72, 0.18), index % 2 ? chassis : trim);
    body.position.y = 1.12;
    rack.add(body);
    for (let row = 0; row < 5; row += 1) {
      const slot = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.18, 0.055), row === 0 ? glass : makePbr(0x09152b, 0.38, 0.6));
      slot.position.set(0, 0.45 + row * 0.34, -0.39);
      rack.add(slot);
      for (let lightIndex = 0; lightIndex < 3; lightIndex += 1) {
        const light = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.055, 0.02), (row + lightIndex + index) % 5 === 0 ? ledRed : ledGreen);
        light.position.set(-0.58 + lightIndex * 0.18, slot.position.y, -0.425);
        rack.add(light);
      }
    }
    group.add(rack);
    racks.push(rack);
  }
  const portal = new THREE.Group();
  portal.position.set(0, 2.2, 13.65);
  const uprightGeometry = makeChamferedPanelGeometry(0.48, 4.1, 0.62, 0.12);
  for (const side of [-1, 1]) {
    const upright = new THREE.Mesh(uprightGeometry, trim);
    upright.position.x = side * 1.82;
    portal.add(upright);
  }
  const header = new THREE.Mesh(makeChamferedPanelGeometry(4.12, 0.58, 0.62, 0.12), trim);
  header.position.y = 1.78;
  portal.add(header);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.76), glass);
  screen.position.set(0, 1.72, -0.34);
  portal.add(screen);
  const deployRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.32, 0.055, 10, 52),
    new THREE.MeshBasicMaterial({ color: 0x62a8ff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  deployRing.position.z = -0.45;
  portal.add(deployRing);
  group.add(portal);
  const cables = [];
  for (let lane = 0; lane < 3; lane += 1) {
    const x = [-6, 0, 6][lane];
    const points = [
      new THREE.Vector3(x - 0.36, 0.015, 10.7),
      new THREE.Vector3(x + 0.28, 0.02, 5.5),
      new THREE.Vector3(x - 0.18, 0.02, 0.5),
      new THREE.Vector3(x + 0.24, 0.02, -7.5),
    ];
    const curve = new THREE.CatmullRomCurve3(points);
    const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.045, 6, false), lane === 1 ? ledGreen : glass);
    group.add(cable);
    cables.push(cable);
  }
  return { group, racks, portal, deployRing, cables, glass };
}

function createRolePropSystem(worldGroup) {
  const geometry = new THREE.PlaneGeometry(0.78, 0.78);
  const meshes = new Map();
  for (const [roleId, config] of Object.entries(ROLE_PROPS)) {
    const materials = Object.fromEntries(['zombie', 'deadline'].map((themeId) => [themeId, new THREE.MeshBasicMaterial({
      map: makeRoleTexture(config, themeId),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      alphaTest: 0.03,
      fog: true,
      toneMapped: false,
      side: THREE.DoubleSide,
    })]));
    const capacity = roleId === 'boss' ? 8 : 110;
    const mesh = new THREE.InstancedMesh(geometry, materials.zombie, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    worldGroup.add(mesh);
    mesh.material = materials.zombie;
    meshes.set(roleId, { mesh, materials, config, capacity });
  }
  const dummy = new THREE.Object3D();
  return {
    meshes,
    update(enemies, elapsed, enabled = true) {
      const counts = new Map();
      if (enabled) {
        for (const enemy of enemies) {
          if (!enemy.active) continue;
          const entry = meshes.get(enemy.roleId) || meshes.get(enemy.type === 'boss' ? 'boss' : '');
          if (!entry) continue;
          const important = enemy.type === 'boss' || enemy.type === 'elite' || enemy.type === 'tank';
          // Keep enough ordinary badges to make the crowd funny and readable,
          // while still leaving silhouettes and projectiles visible.
          if (!important && stableHash(enemy.id) % 2 !== 0) continue;
          const index = counts.get(enemy.roleId) || 0;
          if (index < entry.capacity) {
            const impact = clamp(enemy.impactPulse || 0, 0, 1);
            const slowed = elapsed < enemy.slowUntil;
            const stride = Math.sin(enemy.wobble * 2.15);
            const orbit = Math.sin(elapsed * entry.config.spin + enemy.wobble) * 0.08;
            dummy.position.set(
              enemy.x + entry.config.side * enemy.scale * (0.62 + orbit),
              Math.max(0.66, enemy.scale * entry.config.lift) + Math.abs(stride) * 0.04,
              enemy.z - 0.08 - impact * 0.24,
            );
            dummy.rotation.set(-0.72, 0, stride * 0.08 + Math.sin(elapsed * entry.config.spin + enemy.wobble) * 0.08);
            const baseScale = enemy.scale * (enemy.type === 'boss' ? 0.52 : 0.4) * (slowed ? 0.94 : 1) * (1 + impact * 0.18);
            dummy.scale.set(baseScale, baseScale, 1);
            dummy.updateMatrix();
            entry.mesh.setMatrixAt(index, dummy.matrix);
            counts.set(enemy.roleId, index + 1);
          }
        }
      }
      for (const [roleId, entry] of meshes) {
        entry.mesh.count = counts.get(roleId) || 0;
        entry.mesh.instanceMatrix.needsUpdate = true;
      }
    },
    setVisible(visible) {
      for (const entry of meshes.values()) entry.mesh.visible = visible;
    },
    setTheme(themeId) {
      const activeTheme = themeId === 'deadline' ? 'deadline' : 'zombie';
      for (const entry of meshes.values()) entry.mesh.material = entry.materials[activeTheme];
    },
    drawCalls() {
      return [...meshes.values()].filter((entry) => entry.mesh.visible && entry.mesh.count > 0).length;
    },
    instanceCount() {
      return [...meshes.values()].reduce((sum, entry) => sum + entry.mesh.count, 0);
    },
  };
}

function createBurstPool(worldGroup, capacity = 24) {
  const pool = [];
  const coreGeometry = new THREE.IcosahedronGeometry(0.42, 2);
  const ringGeometry = new THREE.TorusGeometry(0.36, 0.055, 12, 48);
  const flashGeometry = new THREE.SphereGeometry(0.3, 18, 12);
  const shardGeometry = new THREE.ConeGeometry(0.08, 0.62, 7);
  const shardDummy = new THREE.Object3D();
  for (let index = 0; index < capacity; index += 1) {
    const group = new THREE.Group();
    const coreMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const shellMaterial = coreMaterial.clone();
    const flashMaterial = coreMaterial.clone();
    const core = new THREE.Mesh(coreGeometry, coreMaterial);
    const ring = new THREE.Mesh(ringGeometry, shellMaterial);
    const flash = new THREE.Mesh(flashGeometry, flashMaterial);
    ring.rotation.x = Math.PI / 2;
    group.add(flash, core, ring);
    const shards = new THREE.InstancedMesh(shardGeometry, shellMaterial, 7);
    shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shards.count = 7;
    group.add(shards);
    group.visible = false;
    worldGroup.add(group);
    pool.push({ group, core, ring, flash, shards, coreMaterial, shellMaterial, flashMaterial, active: false, age: 0, life: 0.5, power: 1, style: 'energy', critical: false, heavy: false, sequence: index });
  }
  let cursor = 0;
  return {
    pool,
    spawn({ x, y, z, color, power = 1, style = 'energy', critical = false, heavy = false }) {
      const item = pool[cursor % pool.length];
      cursor += 1;
      item.active = true;
      item.age = 0;
      item.life = 0.42 + power * 0.11;
      item.power = power;
      item.style = style;
      item.critical = critical;
      item.heavy = heavy;
      item.group.visible = true;
      item.group.position.set(x, y, z);
      item.group.rotation.set(item.sequence * 0.61, item.sequence * 0.37, item.sequence * 0.23);
      item.coreMaterial.color.set(color);
      item.shellMaterial.color.set(style === 'digital' ? 0x62a8ff : color);
      item.flashMaterial.color.set(critical ? 0xffffff : color);
      item.core.material.wireframe = style === 'digital';
      return item;
    },
    update(dt, vfxScale = 1) {
      let active = 0;
      for (const item of pool) {
        if (!item.active) continue;
        active += 1;
        item.age += dt;
        const t = clamp(item.age / item.life, 0, 1);
        const envelope = Math.sin(t * Math.PI);
        const scale = (0.24 + envelope * (1.15 + item.power * 0.72)) * vfxScale;
        const flashEnvelope = Math.max(0, 1 - clamp(item.age / Math.min(0.16, item.life * 0.34), 0, 1));
        item.flash.scale.setScalar((0.42 + flashEnvelope * (0.72 + item.power * 0.58)) * vfxScale);
        item.flashMaterial.opacity = flashEnvelope * (item.critical ? 1.1 : item.heavy ? 0.78 : 0.5);
        item.core.scale.setScalar(scale);
        item.ring.scale.setScalar(0.5 + t * (2.2 + item.power * 1.12));
        item.ring.rotation.z += dt * (item.style === 'digital' ? 9 : 5);
        item.core.rotation.x += dt * 5;
        item.core.rotation.y += dt * 7;
        item.coreMaterial.opacity = (1 - t) * 0.88;
        item.shellMaterial.opacity = (1 - t) * (item.style === 'digital' ? 0.62 : 0.82);
        for (let index = 0; index < item.shards.count; index += 1) {
          const angle = index / item.shards.count * Math.PI * 2;
          shardDummy.position.set(Math.cos(angle) * t * item.power * 1.3, (0.15 + Math.sin(angle * 2) * 0.3) * t * item.power, Math.sin(angle) * t * item.power * 1.3);
          shardDummy.rotation.set(angle * 0.7, angle, angle + t * 4);
          shardDummy.scale.setScalar((1 - t) * (0.7 + item.power * 0.25));
          shardDummy.updateMatrix();
          item.shards.setMatrixAt(index, shardDummy.matrix);
        }
        item.shards.instanceMatrix.needsUpdate = true;
        if (t >= 1) {
          item.active = false;
          item.group.visible = false;
        }
      }
      return active;
    },
    reset() {
      pool.forEach((item) => { item.active = false; item.group.visible = false; });
    },
  };
}

function createShockwavePool(worldGroup, capacity = 36) {
  const pool = [];
  const geometry = new THREE.RingGeometry(0.26, 0.34, 64);
  const innerGeometry = new THREE.RingGeometry(0.1, 0.14, 36);
  for (let index = 0; index < capacity; index += 1) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    const innerMaterial = material.clone();
    const inner = new THREE.Mesh(innerGeometry, innerMaterial);
    mesh.rotation.x = -Math.PI / 2;
    inner.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    inner.visible = false;
    worldGroup.add(mesh, inner);
    pool.push({ mesh, inner, material, innerMaterial, active: false, age: 0, life: 0.42, maxScale: 1, critical: false, variant: 'normal', sequence: index });
  }
  let cursor = 0;
  return {
    pool,
    spawn({ x, z, color, maxScale = 1, critical = false, heavy = false, variant = 'normal' }) {
      const item = pool[cursor % pool.length];
      cursor += 1;
      item.active = true;
      item.age = 0;
      item.life = 0.34 + Math.min(0.24, maxScale * 0.04);
      item.maxScale = maxScale;
      item.critical = critical;
      item.variant = variant;
      item.mesh.visible = true;
      item.inner.visible = true;
      item.mesh.position.set(x, 0.035 + (item.sequence % 3) * 0.003, z);
      item.inner.position.set(x, 0.039 + (item.sequence % 3) * 0.003, z);
      item.mesh.scale.setScalar(0.28);
      item.inner.scale.setScalar(0.22);
      item.material.color.set(color);
      item.innerMaterial.color.set(critical ? 0xffffff : color);
      item.material.opacity = 0.82;
      item.innerMaterial.opacity = heavy ? 0.64 : 0.42;
    },
    update(dt, vfxScale = 1) {
      let active = 0;
      for (const item of pool) {
        if (!item.active) continue;
        active += 1;
        item.age += dt;
        const t = clamp(item.age / item.life, 0, 1);
        item.mesh.scale.setScalar((0.28 + t * item.maxScale) * vfxScale);
        item.inner.scale.setScalar((0.22 + t * item.maxScale * (item.critical ? 0.65 : 0.42)) * vfxScale);
        item.material.opacity = (1 - t) * (item.critical ? 0.95 : 0.82);
        item.innerMaterial.opacity = (1 - t) * (item.critical ? 0.72 : 0.42);
        item.inner.rotation.z += dt * (item.variant === 'chain' ? 11 : 5);
        if (t >= 1) {
          item.active = false;
          item.mesh.visible = false;
          item.inner.visible = false;
        }
      }
      return active;
    },
    reset() {
      pool.forEach((item) => { item.active = false; item.mesh.visible = false; item.inner.visible = false; });
    },
  };
}

function decorateTurrets(turrets) {
  const zombieArmor = makePbr(0x193b48, 0.24, 0.88, 0x0a3d38, 0.6);
  const zombieTrim = makePbr(0xa8c9cd, 0.12, 0.92, 0x143b3b, 0.24);
  const deadlineArmor = makePbr(0x203f78, 0.22, 0.78, 0x0b2b68, 0.86);
  return turrets.map((turret, index) => {
    const cannonDress = new THREE.Group();
    const hood = new THREE.Mesh(makeChamferedPanelGeometry(1.7, 0.72, 0.86, 0.16), zombieArmor);
    hood.position.set(0, 1.03, 0.05);
    hood.rotation.x = -0.1;
    cannonDress.add(hood);
    const rails = [-1, 1].map((side) => {
      const rail = new THREE.Mesh(makeChamferedPanelGeometry(0.18, 0.24, 2.35, 0.06), zombieTrim);
      rail.position.set(side * 0.62, 1.02, -0.72);
      cannonDress.add(rail);
      return rail;
    });
    const reactorCage = new THREE.Group();
    reactorCage.position.set(0, 1.32, 0.52);
    for (let ringIndex = 0; ringIndex < 3; ringIndex += 1) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.38 + ringIndex * 0.08, 0.026, 6, 24),
        new THREE.MeshBasicMaterial({ color: ringIndex === 1 ? 0xffd84f : 0x4fffd2, transparent: true, opacity: 0.58, toneMapped: false }),
      );
      ring.rotation.set(Math.PI / 2 + ringIndex * 0.42, ringIndex * 0.31, 0);
      reactorCage.add(ring);
    }
    cannonDress.add(reactorCage);
    turret.cannonModel.add(cannonDress);

    const deadlineDress = new THREE.Group();
    const projector = new THREE.Mesh(
      new THREE.TorusGeometry(0.56, 0.035, 8, 34),
      new THREE.MeshBasicMaterial({ color: 0x62a8ff, transparent: true, opacity: 0.64, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    projector.position.set(0, 1.82, -0.1);
    projector.rotation.x = Math.PI / 2;
    deadlineDress.add(projector);
    const printerChute = new THREE.Mesh(makeChamferedPanelGeometry(0.72, 0.38, 0.54, 0.09), deadlineArmor);
    printerChute.position.set(0.72, 0.86, -0.12);
    printerChute.rotation.z = -0.18;
    deadlineDress.add(printerChute);
    const ticket = new THREE.Mesh(
      new THREE.PlaneGeometry(0.52, 0.34),
      new THREE.MeshBasicMaterial({ color: 0xf4fbff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, toneMapped: false }),
    );
    ticket.position.set(0.84, 0.85, -0.44);
    ticket.rotation.set(-0.72, 0, -0.16);
    deadlineDress.add(ticket);
    turret.workbenchModel.add(deadlineDress);
    return { turret, cannonDress, hood, rails, reactorCage, deadlineDress, projector, printerChute, ticket, phase: index * 0.7 };
  });
}

export function createToyVisualSystem({ renderer, scene, camera, worldGroup, wall, core, grid, turretGroups, groundMaterial = null }) {
  const visualRoot = new THREE.Group();
  visualRoot.name = 'cinematic-visual-root';
  worldGroup.add(visualRoot);
  const zombieBase = buildZombieBase();
  const deadlineBase = buildDeadlineBase();
  visualRoot.add(zombieBase.group, deadlineBase.group);
  wall.visible = false;
  core.visible = false;
  grid.material.opacity = 0.18;

  const roleProps = createRolePropSystem(worldGroup);
  const bursts = createBurstPool(worldGroup, 24);
  const shockwaves = createShockwavePool(worldGroup, 36);
  const turretDresses = decorateTurrets(turretGroups);

  const renderPass = new RenderPass(scene, camera);
  const composer = new EffectComposer(renderer);
  // Bloom is what sells the energy-weapon fantasy: a low threshold catches
  // every neon accent, a moderate radius keeps sprites crisp.
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.45, 0.72);
  const outputPass = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);

  const originalBackground = new THREE.Color().copy(scene.background);
  const silhouetteMaterial = new THREE.MeshBasicMaterial({ color: 0x07090d, side: THREE.DoubleSide });
  const materialMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  const emissiveMaterial = new THREE.MeshBasicMaterial({ color: 0x0b1018, side: THREE.DoubleSide });
  const boundsHelper = new THREE.Box3Helper(new THREE.Box3(), 0xffd84f);
  boundsHelper.visible = false;
  scene.add(boundsHelper);

  let mode = 'final';
  let themeId = 'zombie';
  let bloomBoost = 0;
  let baseBloomStrength = 0.58;
  let qualityTier = window.matchMedia('(max-width: 760px)').matches ? 'low' : 'high';
  let width = 1;
  let height = 1;
  let dpr = 1;
  let seedValue = 0;
  let activeBursts = 0;
  let activeShockwaves = 0;
  let lastFrameMs = 0;
  let cameraBookmark = 'design';
  const cameraBookmarks = Object.freeze({
    near: { zoom: 1.24, y: 21.2, z: 23.2 },
    design: { zoom: 1, y: 23, z: 25 },
    far: { zoom: 0.82, y: 25.4, z: 28.2 },
  });

  function setTheme(nextTheme) {
    themeId = nextTheme === 'deadline' ? 'deadline' : 'zombie';
    roleProps.setTheme(themeId);
    originalBackground.setHex(themeId === 'deadline' ? 0x071022 : 0x07111f);
    if (!['silhouette', 'material', 'emissive'].includes(mode)) scene.background.copy(originalBackground);
    zombieBase.group.visible = themeId === 'zombie';
    deadlineBase.group.visible = themeId === 'deadline';
    bloomPass.strength = themeId === 'deadline' ? 0.5 : 0.58;
    bloomPass.radius = themeId === 'deadline' ? 0.42 : 0.48;
    bloomPass.threshold = themeId === 'deadline' ? 0.74 : 0.7;
    baseBloomStrength = bloomPass.strength;
    bloomBoost = 0;
  }

  function applyQuality() {
    const preset = QUALITY_PRESETS[qualityTier];
    const cssPixels = Math.max(1, width * height);
    const budgetDpr = Math.sqrt(preset.pixelBudget / cssPixels);
    dpr = clamp(Math.min(window.devicePixelRatio || 1, preset.maxDpr, budgetDpr), 0.75, preset.maxDpr);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(dpr);
    composer.setSize(width, height);
    bloomPass.enabled = preset.bloom && mode !== 'noPost';
  }

  function resize(nextWidth, nextHeight) {
    width = Math.max(1, nextWidth);
    height = Math.max(1, nextHeight);
    applyQuality();
  }

  function setMode(nextMode) {
    mode = VISUAL_MODES.includes(nextMode) ? nextMode : 'final';
    scene.overrideMaterial = null;
    scene.background.copy(originalBackground);
    boundsHelper.visible = false;
    roleProps.setVisible(mode !== 'vfx');
    if (mode === 'silhouette') {
      scene.overrideMaterial = silhouetteMaterial;
      scene.background.setHex(0xe9f2f3);
    } else if (mode === 'material') {
      scene.overrideMaterial = materialMaterial;
      scene.background.setHex(0x121722);
    } else if (mode === 'emissive') {
      scene.overrideMaterial = emissiveMaterial;
      scene.background.setHex(0x020305);
    } else if (mode === 'bounds') {
      boundsHelper.visible = true;
    }
    bloomPass.enabled = QUALITY_PRESETS[qualityTier].bloom && mode === 'final';
    return mode;
  }

  function setQuality(nextTier) {
    qualityTier = QUALITY_PRESETS[nextTier] ? nextTier : qualityTier;
    applyQuality();
    return qualityTier;
  }

  function setCameraBookmark(name) {
    const bookmark = cameraBookmarks[name] || cameraBookmarks.design;
    cameraBookmark = cameraBookmarks[name] ? name : 'design';
    camera.zoom = bookmark.zoom;
    camera.position.y = bookmark.y;
    camera.position.z = bookmark.z;
    camera.lookAt(0, 0, 1.5);
    camera.updateProjectionMatrix();
    return cameraBookmark;
  }

  function update({ dt, elapsed, enemies, baseHp, levels, overdriveUntil, seed }) {
    const startedAt = performance.now();
    if (seedValue !== seed) seedValue = seed >>> 0;
    // Decay any transient bloom surge back to the theme baseline.
    if (bloomBoost > 0.001) {
      bloomBoost = Math.max(0, bloomBoost - dt * 1.6);
      bloomPass.strength = baseBloomStrength + bloomBoost;
    }
    roleProps.update(enemies, elapsed, QUALITY_PRESETS[qualityTier].roleProps && mode !== 'vfx');
    activeBursts = bursts.update(dt, QUALITY_PRESETS[qualityTier].vfxScale);
    activeShockwaves = shockwaves.update(dt, QUALITY_PRESETS[qualityTier].vfxScale);
    const damage = clamp((100 - baseHp) / 100, 0, 1);
    // Ground emissive surges while overdrive burns: the whole floor breathes.
    if (groundMaterial) {
      const overdrive = elapsed < overdriveUntil;
      const pulse = overdrive ? 0.34 + Math.sin(elapsed * 9) * 0.16 : Math.max(0, Math.sin(elapsed * 1.6) - 0.86) * 0.5;
      groundMaterial.emissive.setHex(themeId === 'deadline' ? 0x123a6e : 0x0c3a34);
      groundMaterial.emissiveIntensity = 0.12 + pulse + clamp(damage * 0.25, 0, 0.2);
    }
    zombieBase.panels.forEach((panel, index) => {
      const severity = clamp(damage * 1.6 - index * 0.025, 0, 1);
      panel.rotation.z = (index % 2 ? -1 : 1) * severity * 0.045;
      panel.position.y = 0.82 - severity * 0.08;
    });
    zombieBase.rings.forEach((ring, index) => {
      ring.rotation.z += dt * (0.8 + index * 0.42) * (index % 2 ? -1 : 1);
      ring.material.opacity = 0.34 + Math.sin(elapsed * 4 + index) * 0.12 + (elapsed < overdriveUntil ? 0.34 : 0);
    });
    zombieBase.reactor.scale.setScalar(1 + Math.sin(elapsed * (elapsed < overdriveUntil ? 12 : 4)) * 0.09);
    zombieBase.spotlights.forEach((light, index) => { light.rotation.y = Math.sin(elapsed * 0.38 + index * 2.3) * 0.22; });
    deadlineBase.deployRing.rotation.z += dt * (1.6 + levels.rate * 0.14);
    deadlineBase.deployRing.scale.setScalar(1 + Math.sin(elapsed * 5) * 0.04 + (elapsed < overdriveUntil ? 0.16 : 0));
    deadlineBase.racks.forEach((rack, index) => {
      rack.rotation.z = Math.sin(elapsed * 0.7 + index) * 0.003 + (index % 2 ? 1 : -1) * damage * 0.012;
    });
    turretDresses.forEach((dress) => {
      const stage = dress.turret.evolutionStage || 0;
      const overdrive = elapsed < overdriveUntil;
      dress.hood.scale.set(1 + stage * 0.05, 1 + stage * 0.035, 1 + stage * 0.08);
      dress.rails.forEach((rail, index) => {
        rail.position.x = (index ? 1 : -1) * (0.62 + stage * 0.045);
        rail.scale.z = 1 + stage * 0.12;
      });
      dress.reactorCage.rotation.y += dt * (1.2 + levels.rate * 0.28) * (dress.phase % 1 > 0.5 ? -1 : 1);
      dress.reactorCage.scale.setScalar(1 + stage * 0.08 + (overdrive ? Math.sin(elapsed * 11 + dress.phase) * 0.13 : 0));
      dress.projector.rotation.z += dt * (1.4 + levels.rate * 0.24);
      dress.projector.scale.setScalar(1 + stage * 0.09 + (overdrive ? 0.18 : 0));
      dress.ticket.position.z = -0.44 - Math.sin(elapsed * 6 + dress.phase) * 0.09;
      dress.ticket.rotation.z = -0.16 + Math.sin(elapsed * 8 + dress.phase) * 0.08;
    });
    if (boundsHelper.visible) {
      boundsHelper.box.setFromObject(themeId === 'deadline' ? deadlineBase.group : zombieBase.group);
    }
    lastFrameMs = performance.now() - startedAt;
  }

  function render() {
    if (mode === 'noPost' || mode === 'silhouette' || mode === 'material' || mode === 'emissive' || mode === 'bounds') {
      renderer.render(scene, camera);
    } else {
      composer.render();
    }
  }

  function spawnImpact(payload) {
    return bursts.spawn(payload);
  }

  function spawnShockwave(payload) {
    return shockwaves.spawn(payload);
  }

  function spawnDefeat(payload) {
    const count = payload.boss ? 5 : payload.elite ? 2 : 1;
    const rng = seeded((seedValue ^ Math.floor(payload.x * 1009) ^ Math.floor(payload.z * 9176)) >>> 0);
    for (let index = 0; index < count; index += 1) {
      const angle = index / count * Math.PI * 2 + rng() * 0.6;
      bursts.spawn({
        ...payload,
        x: payload.x + Math.cos(angle) * (payload.boss ? 1.2 : 0.28) * (0.7 + rng()),
        y: payload.y + rng() * (payload.boss ? 2.1 : 0.55),
        z: payload.z + Math.sin(angle) * (payload.boss ? 0.8 : 0.22),
        power: payload.power * (0.82 + rng() * 0.35),
      });
    }
  }

  function spawnUpgrade({ x, z, color }) {
    bursts.spawn({ x, y: 1.1, z, color, power: 1.45, style: themeId === 'deadline' ? 'digital' : 'energy' });
    window.setTimeout(() => bursts.spawn({ x, y: 1.7, z, color: '#ffffff', power: 0.9, style: themeId === 'deadline' ? 'digital' : 'energy' }), 70);
  }

  function reset(seed = 0) {
    seedValue = seed >>> 0;
    bursts.reset();
    shockwaves.reset();
  }

  function snapshot() {
    const preset = QUALITY_PRESETS[qualityTier];
    return {
      contract: {
        camera: 'fixed orthographic 2.5D',
        subjectWidthRatio: '12%-16% single hero, independent silhouettes in formation',
        readableWithoutPost: true,
        toneMapOwner: 'OutputPass using renderer ACES configuration',
        deterministicSeed: seedValue,
      },
      mode,
      qualityTier,
      post: { composer: true, bloomEnabled: bloomPass.enabled, strength: bloomPass.strength, radius: bloomPass.radius, threshold: bloomPass.threshold },
      renderSize: { cssWidth: width, cssHeight: height, dpr, pixelWidth: Math.round(width * dpr), pixelHeight: Math.round(height * dpr), pixelBudget: preset.pixelBudget },
      cameraBookmark,
      roleProps: { instances: roleProps.instanceCount(), drawCalls: roleProps.drawCalls() },
      vfx: {
        burstPoolCapacity: bursts.pool.length,
        shockwavePoolCapacity: shockwaves.pool.length,
        activeBursts,
        activeShockwaves,
        active: activeBursts + activeShockwaves,
        allocationPolicy: 'fixed reusable pools',
      },
      environment: { theme: themeId, zombiePanels: zombieBase.panels.length, deadlineRacks: deadlineBase.racks.length },
      cpuVisualUpdateMs: Number(lastFrameMs.toFixed(3)),
      renderer: { drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, points: renderer.info.render.points, lines: renderer.info.render.lines },
    };
  }

  setTheme(themeId);
  setCameraBookmark('design');
  function pulseBloom(amount = 0.35) {
    bloomBoost = Math.max(bloomBoost, amount);
  }
  return { setTheme, resize, setMode, setQuality, setCameraBookmark, update, render, spawnImpact, spawnShockwave, spawnDefeat, spawnUpgrade, pulseBloom, reset, snapshot, visualModes: VISUAL_MODES, qualityPresets: Object.keys(QUALITY_PRESETS) };
}
