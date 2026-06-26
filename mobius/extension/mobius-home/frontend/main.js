// 莫比乌斯宣传页交互
// 包含：滚动揭示 / 顶部导航明暗切换 / Hero 与 Finale 的莫比乌斯环粒子背景
//       概念对比与三重特性的 Three.js 3D 场景

import { initLogoBackdrop, initTorusOnly, initMobiusOnly, initTrinityMobius } from './mobius3d.js';

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

/* ---------- 2. 顶部导航根据当前 section 切换明暗 ---------- */
const topnav = document.getElementById('topnav');
const lightSections = document.querySelectorAll(
  '.section-light, .section-light-2, .hero'
);
const navObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && e.intersectionRatio > 0.4) {
      const isHero = e.target.classList.contains('hero');
      topnav.classList.toggle('on-light', !isHero && e.target.classList.contains('section-light'));
    }
  }
}, { threshold: [0.4, 0.6] });
lightSections.forEach((s) => navObserver.observe(s));

/* ---------- 3. dot-logo 风格莫比乌斯光点背景（Hero & Finale） ---------- */
initLogoBackdrop(document.getElementById('hero-canvas'), 'hero');
initLogoBackdrop(document.getElementById('finale-canvas'), 'finale');

/* ---------- 5. 概念对比 + 三重特性的 3D 场景 ---------- */
// 5 个 Three.js 场景：用 IntersectionObserver 仅在可见时 RAF，避免空耗 GPU
const sceneRegistry = [];

function registerScene(el, factory) {
  if (!el) return;
  const scene = factory(el);
  sceneRegistry.push({ el, scene });
  scene.pause();
}

registerScene(document.getElementById('concept-torus'), initTorusOnly);
registerScene(document.getElementById('concept-mobius'), initMobiusOnly);
registerScene(document.getElementById('trinity-1'), (el) => initTrinityMobius(el, 'loop'));
registerScene(document.getElementById('trinity-2'), (el) => initTrinityMobius(el, 'dimension'));
registerScene(document.getElementById('trinity-3'), (el) => initTrinityMobius(el, 'stars'));

const sceneObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const found = sceneRegistry.find((s) => s.el === e.target);
    if (!found) continue;
    if (e.isIntersecting) found.scene.start();
    else found.scene.pause();
  }
}, { threshold: 0.05 });
sceneRegistry.forEach((s) => sceneObserver.observe(s.el));

/* ---------- 6. 7×24 项目运行热力图 ---------- */
// 7 天 × 24 小时 = 168 格，工作时段（9-22）密集，凌晨稀疏；4 个项目循环占用，部分格子空置
(function buildHeatmap() {
  const grid = document.getElementById('heatmap-grid');
  if (!grid) return;

  // 一个伪随机但稳定的密度函数，让每天的活跃时段略有起伏
  function density(day, hour) {
    if (hour >= 9 && hour <= 22) {
      const peak = 1 - Math.abs(hour - 14) / 10;
      const weekend = day >= 5 ? 0.55 : 1.0;
      return Math.max(0.18, peak * weekend);
    }
    if (hour >= 7 && hour <= 23) return 0.18;
    return 0.06;
  }

  const projects = ['p1', 'p2', 'p3', 'p4'];
  const frag = document.createDocumentFragment();
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const d = density(day, hour);
      const r = Math.random();
      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      if (r < d) {
        const proj = projects[(day * 7 + hour * 3 + Math.floor(r * 13)) % 4];
        cell.classList.add(proj);
        if (Math.random() < 0.12) cell.classList.add('breathe');
      } else {
        cell.classList.add('empty');
      }
      frag.appendChild(cell);
    }
  }
  grid.appendChild(frag);
})();

/* ---------- 7. 视频展示页：等用户给路径后接入 ---------- */
// 用法：window.setShowcaseVideo('json-track', '/path/to/video.mp4')
//      或直接在 index.html 的 <video> 上写 src，并去掉父节点 .placeholder 类。
window.setShowcaseVideo = function (slot, url) {
  const wrap = document.querySelector(`.showcase-video[data-video-slot="${slot}"]`);
  if (!wrap) return false;
  const video = wrap.querySelector('video');
  if (!video) return false;
  video.src = url;
  wrap.classList.remove('placeholder');
  return true;
};

/* ---------- 8. 右侧 Apple 风滚动目录（scroll-spy TOC） ---------- */
(function buildPageToc() {
  const toc = document.getElementById('pageToc');
  if (!toc) return;

  // 显式 section → TOC 显示文字映射表（按指定顺序）
  const TOC_LABELS = {
    'hero': '概览',
    'prologue': '时代之问',
    'synergy': '人机物智算协同',
    'features': '七大亮点',
    'feat-1': '自生长',
    'feat-2': 'Agent集群协作',
    'feat-3': '人类团队协作',
    'feat-4': '深度科研系统',
    'feat-5': '自孵化拓展系统',
    'feat-6': '智能小莫',
    'feat-7': '兼容性',
    'feat-showcase': '真实案例',
    'finale': '莫比乌斯环'
  };

  // 仅收集出现在映射表中的元素，按 TOC_LABELS 定义的顺序输出
  const targets = [];
  for (const id of Object.keys(TOC_LABELS)) {
    const el = document.getElementById(id);
    if (el) targets.push({ el, label: TOC_LABELS[id] });
  }

  // 生成 DOM
  for (const t of targets) {
    const a = document.createElement('a');
    a.className = 'page-toc-item';
    a.href = '#' + t.el.id;
    a.dataset.target = t.el.id;
    a.textContent = t.label;
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      t.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    toc.appendChild(a);
  }

  const items = Array.from(toc.querySelectorAll('.page-toc-item'));

  // 高亮当前 section + 同步明暗主题
  let activeId = null;
  const spy = new IntersectionObserver((entries) => {
    // 找出当前视口中占比最大、且 intersectionRatio >= 0.4 的那个
    let best = null;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      if (e.intersectionRatio < 0.4) continue;
      if (!best || e.intersectionRatio > best.intersectionRatio) best = e;
    }
    if (!best) return;
    const id = best.target.id;
    if (id === activeId) return;
    activeId = id;
    items.forEach((it) => it.classList.toggle('is-active', it.dataset.target === id));
    // 同步 TOC 的明暗主题
    const onLight = best.target.classList.contains('section-light')
                 || best.target.classList.contains('section-light-2');
    toc.classList.toggle('on-light', onLight);
  }, { threshold: [0.4, 0.6, 0.8] });
  targets.forEach((t) => spy.observe(t.el));

  // 初始默认高亮 hero
  if (items.length) items[0].classList.add('is-active');
})();
