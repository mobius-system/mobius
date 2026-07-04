// recording-studio/backend/recorder.js
//
// 独立录制子进程, 由 handler spawn(detached, unref) 启动, 不受 30s worker_thread 约束.
// 读 spec.json (argv[2]), 驱动真实莫比乌斯页面录制, 产物:
//   ext_data_dir/jobs/<id>/{status.json, events.jsonl, script.md}   (handler 可读)
//   <frontend>/dist/media/<id>/{video.webm, video.mp4, thumb-*.png} (静态可播)
//
// recipe:
//   self-cognition — 已验证的 self-cognition 插件电影感巡览 (固定 storyboard).
//   generic        — 任意站内页面; 提供 steps 则逐镜头 zoom, 否则自动发现 section 做滚动巡览.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const SPEC_PATH = process.argv[2];
if (!SPEC_PATH) { console.error('no spec path'); process.exit(2); }
const SPEC = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));

const JOB_DIR = path.join(SPEC.extDataDir, 'jobs', SPEC.jobId);
const MEDIA_DIR = path.join(SPEC.frontendDir, 'dist', SPEC.mediaRelDir);
const STATUS_PATH = path.join(JOB_DIR, 'status.json');
const EVENTS_PATH = path.join(JOB_DIR, 'events.jsonl');
const SCRIPT_PATH = path.join(JOB_DIR, 'script.md');

fs.mkdirSync(JOB_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const OPT = SPEC.options || {};
const PACE = OPT.pace === 'slow' ? 1.5 : OPT.pace === 'fast' ? 0.6 : 1.0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
let startTs = 0;
function elapsed() { return Number(((Date.now() - startTs) / 1000).toFixed(2)); }

// ---------- status ----------
function updateStatus(patch) {
  try {
    const cur = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8') || '{}');
    const next = Object.assign({}, cur, patch, { updatedAt: new Date().toISOString() });
    if (patch.state === 'done' && startTs) next.durationSec = elapsed();
    fs.writeFileSync(STATUS_PATH, JSON.stringify(next, null, 2));
  } catch (e) { /* best-effort */ }
}
// 心跳: 防止 handler 的 stale 检测误杀长录制
const heartbeat = setInterval(() => {
  try {
    const cur = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8') || '{}');
    if (cur.state === 'running') { cur.updatedAt = new Date().toISOString(); fs.writeFileSync(STATUS_PATH, JSON.stringify(cur, null, 2)); }
  } catch {}
}, 10000);

// ---------- login ----------
async function loginToken(page) {
  const resp = await fetch(`${SPEC.base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: SPEC.username }),
  });
  if (!resp.ok) throw new Error(`login failed: ${resp.status}`);
  const data = await resp.json();
  await page.evaluate((t) => {
    localStorage.setItem('cc-token', t);
    try { localStorage.setItem(`imac:first-login-tour-seen:v1:${window.__REC_USER__ || ''}`, String(Date.now())); } catch {}
  }, data.token);
  return data.token;
}

// ---------- 录制 UI 注入 (移植自已验证脚本) ----------
async function injectRecordingUi(page, hudTitle, hudBody) {
  await page.addStyleTag({ content: `
    html { scroll-behavior: smooth !important; }
    body.recording-mode * { animation-duration: 1.1s !important; }
    .rec-hud { position: fixed; z-index: 2147483000; top: 22px; left: 24px; width: 430px; padding: 16px 18px;
      border: 1px solid rgba(255,255,255,.18); border-radius: 18px; background: rgba(6,12,18,.76);
      backdrop-filter: blur(18px); color: white; box-shadow: 0 22px 70px rgba(0,0,0,.34);
      font-family: Inter, "Noto Sans CJK SC", system-ui, sans-serif; pointer-events: none; }
    .rec-hud .kicker { color: #7dd3fc; font-size: 12px; letter-spacing: .16em; text-transform: uppercase; margin-bottom: 6px; }
    .rec-hud .title { font-size: 22px; font-weight: 760; line-height: 1.2; }
    .rec-hud .body { margin-top: 8px; color: rgba(255,255,255,.78); font-size: 14px; line-height: 1.55; }
    .rec-caption { position: fixed; z-index: 2147483000; left: 50%; bottom: 30px; transform: translateX(-50%);
      max-width: min(980px, calc(100vw - 80px)); padding: 14px 20px; border-radius: 999px;
      background: rgba(5,10,15,.72); border: 1px solid rgba(255,255,255,.16); color: white;
      font: 600 20px/1.42 Inter, "Noto Sans CJK SC", system-ui, sans-serif; text-align: center;
      box-shadow: 0 18px 50px rgba(0,0,0,.28); pointer-events: none; }
    .rec-focus { position: fixed; z-index: 2147482999; border: 3px solid #38bdf8; border-radius: 18px;
      box-shadow: 0 0 0 9999px rgba(0,0,0,.18), 0 0 0 8px rgba(56,189,248,.16), 0 18px 50px rgba(8,47,73,.32);
      transition: all .42s cubic-bezier(.2,.8,.2,1); pointer-events: none; }
    .rec-pointer { position: fixed; z-index: 2147483001; width: 26px; height: 26px; border-radius: 999px;
      background: radial-gradient(circle at 35% 35%, white 0 20%, #38bdf8 21% 52%, rgba(56,189,248,.24) 53% 100%);
      box-shadow: 0 0 0 8px rgba(56,189,248,.16), 0 10px 30px rgba(0,0,0,.35);
      transform: translate(-50%, -50%);
      transition: left .38s cubic-bezier(.2,.8,.2,1), top .38s cubic-bezier(.2,.8,.2,1), opacity .2s;
      pointer-events: none; opacity: 0; }
    .rec-title-card { position: fixed; z-index: 2147483002; inset: 0; display: grid; place-items: center; padding: 80px;
      color: white;
      background: radial-gradient(circle at 28% 34%, rgba(34,211,238,.18), transparent 32%),
        radial-gradient(circle at 74% 58%, rgba(52,211,153,.14), transparent 30%), rgba(2,6,10,.76);
      backdrop-filter: blur(10px); pointer-events: none; opacity: 0; transition: opacity .35s ease; }
    .rec-title-card.is-visible { opacity: 1; }
    .rec-title-inner { max-width: 920px; text-align: center; }
    .rec-title-inner .eyebrow { color: #7dd3fc; text-transform: uppercase; letter-spacing: .18em; font: 700 14px/1.2 Inter, system-ui, sans-serif; }
    .rec-title-inner h2 { margin: 14px 0 12px; font: 760 58px/1.05 Inter, "Noto Sans CJK SC", system-ui, sans-serif; }
    .rec-title-inner p { margin: 0 auto; color: rgba(255,255,255,.76); font: 500 22px/1.55 Inter, "Noto Sans CJK SC", system-ui, sans-serif; }
  `});
  await page.evaluate(([hudTitle, hudBody, user]) => {
    window.__REC_USER__ = user;
    document.body.classList.add('recording-mode');
    const hud = document.createElement('div'); hud.className = 'rec-hud';
    hud.innerHTML = `<div class="kicker">Mobius Recording</div><div class="title"></div><div class="body"></div>`;
    hud.querySelector('.title').textContent = hudTitle;
    hud.querySelector('.body').textContent = hudBody;
    const caption = document.createElement('div'); caption.className = 'rec-caption'; caption.textContent = '准备开始录制';
    const focus = document.createElement('div'); focus.className = 'rec-focus'; focus.style.opacity = '0';
    const pointer = document.createElement('div'); pointer.className = 'rec-pointer';
    const titleCard = document.createElement('div'); titleCard.className = 'rec-title-card';
    titleCard.innerHTML = '<div class="rec-title-inner"><div class="eyebrow"></div><h2></h2><p></p></div>';
    document.body.append(hud, caption, focus, pointer, titleCard);
    window.__rec = {
      hud, caption, focus, pointer, titleCard,
      setHud(t, b) { hud.querySelector('.title').textContent = t; hud.querySelector('.body').textContent = b; },
      setCaption(t) { caption.textContent = t; },
      setFocus(box) {
        if (!box) { focus.style.opacity = '0'; pointer.style.opacity = '0'; return; }
        const pad = 8;
        focus.style.opacity = '1';
        focus.style.left = `${Math.max(8, box.x - pad)}px`;
        focus.style.top = `${Math.max(8, box.y - pad)}px`;
        focus.style.width = `${Math.max(24, box.width + pad * 2)}px`;
        focus.style.height = `${Math.max(24, box.height + pad * 2)}px`;
        pointer.style.opacity = '1';
        pointer.style.left = `${box.x + box.width / 2}px`;
        pointer.style.top = `${box.y + box.height / 2}px`;
      },
      showTitle(eb, t, b) { titleCard.querySelector('.eyebrow').textContent = eb; titleCard.querySelector('h2').textContent = t; titleCard.querySelector('p').textContent = b; titleCard.classList.add('is-visible'); },
      hideTitle() { titleCard.classList.remove('is-visible'); },
    };
  }, [hudTitle, hudBody, SPEC.username]);
}

async function annotate(page, title, body, caption) {
  if (OPT.captions === false) return;
  await page.evaluate(({ title, body, caption }) => { window.__rec.setHud(title, body); window.__rec.setCaption(caption || body); }, { title, body, caption });
}
async function titleCard(page, eyebrow, title, body, duration = 2600) {
  events.push({ t: elapsed(), type: 'title', eyebrow, title, body });
  if (OPT.captions !== false) {
    await page.evaluate(({ eb, t, b }) => window.__rec.showTitle(eb, t, b), { eb: eyebrow, t: title, b: body });
    await sleep(duration * PACE);
    await page.evaluate(() => window.__rec.hideTitle());
    await sleep(450);
  } else { await sleep(1200 * PACE); }
}
async function focusLocator(page, locator, label, caption, options = {}) {
  await locator.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
  await sleep((options.before || 550) * PACE);
  const box = await locator.boundingBox().catch(() => null);
  await annotate(page, label, caption, options.shortCaption || caption);
  await page.evaluate((b) => window.__rec.setFocus(b), box);
  events.push({ t: elapsed(), type: 'focus', label, caption, bbox: box });
  await sleep((options.hold || 1900) * PACE);
  return box;
}
async function focusSelector(page, selector, label, caption, options = {}) {
  return focusLocator(page, page.locator(selector).first(), label, caption, options);
}
async function clickLocator(page, locator, label, caption) {
  const box = await focusLocator(page, locator, label, caption, { hold: 900 });
  events.push({ t: elapsed(), type: 'click', label, caption, bbox: box });
  await locator.click({ timeout: 8000 });
  await sleep(900 * PACE);
}
async function shot(page, idx, label) {
  const name = `thumb-${String(idx).padStart(2, '0')}.png`;
  await page.screenshot({ path: path.join(MEDIA_DIR, name), fullPage: false });
  events.push({ t: elapsed(), type: 'screenshot', name, label });
  return name;
}

// ---------- recipe: self-cognition (移植已验证 storyboard) ----------
async function recipeSelfCognition(page) {
  const g = SPEC.selfCognition || {};
  await page.goto(`${SPEC.base}/extension/self-cognition/`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await sleep(8500 * PACE);
  await injectRecordingUi(page, g.hudTitle, g.hudBody);

  await titleCard(page, 'SELF-COGNITION', '莫比乌斯如何看见自己的进化',
    '这段样片自动录制 self-cognition 插件：论文雷达、产品调研、L2 启发和自进化历史。');
  let n = 0;
  await focusSelector(page, '#hero h1', 'Research Radar 首页',
    '插件把论文、产品和系统改动组织成一个自我认知雷达，而不是一面静态资料墙。', { hold: 2300 });
  await shot(page, ++n, 'hero');
  await focusSelector(page, '#scheduleStatus', '雷达状态概览',
    '首屏直接显示论文线索、产品线索、L2 启发和自进化事件，适合宣传片开场快速建立可信度。', { hold: 2200 });
  await clickLocator(page, page.getByRole('link', { name: '进入论文调研' }), '进入论文调研',
    '先看论文调研：从外部研究资料里提炼对莫比乌斯有用的系统启发。');
  await sleep(1000 * PACE);
  await focusSelector(page, '#panel-papers .workflow-toolbar', '论文处理台',
    '主界面把"待判断论文、证据阅读、人工决策"放在同一个工作台，减少在资料和判断之间来回切换。', { hold: 2400 });
  await focusSelector(page, '#panel-papers .decision-workbench', 'Decision Inbox',
    '左侧是待处理线索，中间是证据和摘要，右侧是接受、收藏、归档等决策动作。', { hold: 2300 });
  await clickLocator(page, page.locator('button[data-open-scan-tools="paper"]').first(), '论文扫描与 AI 深读入口',
    '扫描、关键词和 AI 深度阅读收进工具弹窗，主工作台保持专注。');
  await focusSelector(page, '.scan-tools-dialog .scan-tools-shell', '论文 Research Tools',
    '这里可以触发 arXiv 扫描，也可以只对未读论文做 AI 深度阅读。样片只展示入口，不启动真实扫描。', { hold: 2800 });
  await shot(page, ++n, 'paper-tools');
  await page.locator('.scan-tools-dialog .dialog-close').click(); await sleep(800 * PACE);

  await clickLocator(page, page.locator('a[href="#competitor-section"]').first(), '切到产品调研',
    '第二条能力线是产品调研：把竞品、相似产品和可借鉴功能转成莫比乌斯自己的产品判断。');
  await sleep(1000 * PACE);
  await focusSelector(page, '#panel-competitors .workflow-toolbar', '产品处理台',
    '产品调研和论文调研共用一套判断流程：先看来源和证据，再决定是否值得吸收。', { hold: 2300 });
  await focusSelector(page, '#panel-competitors .decision-workbench', '候选产品与已跟踪产品',
    '插件会区分已跟踪产品、候选产品、未读线索和 AI 排除项，方便持续维护研究库。', { hold: 2300 });
  await clickLocator(page, page.locator('button[data-open-scan-tools="product"]').first(), '产品扫描与 AI 阅读',
    '产品页也有独立扫描入口，可以把 URL、产品描述和 AI 启发沉淀进自我认知库。');
  await focusSelector(page, '.scan-tools-dialog .scan-tools-shell', 'Product Research Tools',
    '这里适合录"从一个竞品 URL 到一组可执行启发"的素材。当前样片只展示能力边界。', { hold: 2700 });
  await shot(page, ++n, 'product-tools');
  await page.locator('.scan-tools-dialog .dialog-close').click(); await sleep(800 * PACE);

  await clickLocator(page, page.locator('a[href="#implementation-section"]').first(), '进入 L2 启发落实',
    '调研不是终点，真正有价值的是把启发交给小莫或 Agent，变成可执行的系统迭代。');
  await sleep(1000 * PACE);
  await focusSelector(page, '#implementation-section .section-heading', '启发点落实队列',
    '这里汇总已接受的 L2 启发，记录来源、判断过程和后续落实入口。', { hold: 2300 });
  await focusSelector(page, '#implementationList', '从洞察到行动',
    '每条启发都可以保留上下文，后续交给小莫继续拆解，形成真实迭代任务。', { hold: 2600 });
  await shot(page, ++n, 'implementation');

  await clickLocator(page, page.locator('a[href="#evolution-section"]').first(), '进入自进化历史',
    '最后看自进化历史：系统如何把已经发生的改动重新组织成可理解的成长脉络。');
  await sleep(1400 * PACE);
  await focusSelector(page, '#evolution-section .section-heading', '三层反馈结构',
    'L1 是已经发生的真实修改，L2 是待审批的升级候选，L3 预留给更高阶的自我修改。', { hold: 2600 });
  await focusSelector(page, '#evolution-section .evolution-controls', '按层级和项目查看演化',
    '录制自进化素材时，可以从这里筛选项目、扫描最新改动，并展示莫比乌斯如何复盘自己。', { hold: 2400 });
  await focusSelector(page, '#evolutionContent', '真实改动聚类',
    '历史提交被整理成产品能力、Agent 协作、工程维护等类别，形成可解释的进化轨迹。', { hold: 3400 });
  await shot(page, ++n, 'evolution');

  await titleCard(page, 'MATERIAL PACKAGE', '一条可复用的自动录制路径',
    '这次输出包括原始视频、关键帧截图和 events.jsonl。后续可以据此继续接 Screen Studio 或自动剪辑。');
  return n;
}

// ---------- recipe: generic ----------
async function recipeGeneric(page) {
  const g = SPEC.generic;
  await page.goto(`${SPEC.base}${g.url}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await sleep(4000 * PACE);
  await injectRecordingUi(page, g.hudTitle, g.hudBody);

  await titleCard(page, g.eyebrow || 'MOBIUS', g.title || '莫比乌斯演示',
    g.description || `${g.hudTitle} 的自动演示录制。`);

  let steps = g.steps;
  if (!steps || !steps.length) {
    // 自动发现 section
    steps = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      document.querySelectorAll('h1, h2, h3, section, .hero, .section-heading, [class*="section-inner"], header').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 240 || r.height < 80) return;
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70);
        if (!text) return;
        const top = Math.round((r.top + window.scrollY) / 60);
        if (seen.has(top)) return;
        seen.add(top);
        el.setAttribute('data-rec-target', String(out.length));
        out.push({ caption: text, selector: `[data-rec-target="${out.length}"]` });
      });
      return out.slice(0, 9);
    });
  }

  let n = 0;
  // 先建立全局观: 缓慢滚到底再回顶
  await annotate(page, g.hudTitle, g.description || '先整体浏览页面', g.description || '先整体看一遍页面结构');
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(900 * PACE);

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    updateStatus({ phase: 'recording', progress: Math.min(0.95, (i + 1) / (steps.length + 1)), message: `镜头 ${i + 1}/${steps.length}` });
    const label = `镜头 ${i + 1}`;
    try {
      if (s.selector) {
        await focusSelector(page, s.selector, label, s.caption, { hold: 2200 });
      } else {
        await annotate(page, label, s.caption, s.caption);
        await sleep(2200 * PACE);
      }
    } catch { /* 单镜头失败不中断整段 */ }
    if (i % 2 === 0 || i === steps.length - 1) await shot(page, ++n, s.caption);
  }

  await page.evaluate(() => window.__rec.setFocus(null));
  await titleCard(page, g.eyebrow || 'MOBIUS', g.title || '莫比乌斯演示', g.description || '自动录制完成。');
  return n;
}

// ---------- mp4 转码 ----------
function convertMp4(webmPath, mp4Path, ffmpegPath) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false);
    const args = ['-hide_banner', '-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-crf', '22', mp4Path];
    const p = spawn(ffmpegPath, args, { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0 && fs.existsSync(mp4Path)));
  });
}

// ---------- main ----------
async function main() {
  const [w, h] = OPT.viewport || [1440, 900];
  updateStatus({ state: 'running', phase: 'login', progress: 0.02, message: '登录演示账号…' });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: OPT.deviceScaleFactor || 1,
    recordVideo: { dir: MEDIA_DIR, size: { width: w, height: h } },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  await page.goto(SPEC.base, { waitUntil: 'domcontentloaded' });
  await loginToken(page);

  updateStatus({ phase: 'recording', progress: 0.05, message: '开始录制…' });
  startTs = Date.now();
  events.push({ t: elapsed(), type: 'start', recipe: SPEC.recipe, base: SPEC.base });

  const thumbCount = SPEC.recipe === 'self-cognition'
    ? await recipeSelfCognition(page)
    : await recipeGeneric(page);

  events.push({ t: elapsed(), type: 'end' });
  await page.evaluate(() => window.__rec && window.__rec.setFocus(null));
  await sleep(900 * PACE);

  updateStatus({ phase: 'finalizing', progress: 0.97, message: '收尾导出视频…' });
  const video = page.video();
  await context.close();
  await browser.close();

  const webmSrc = await video.path();
  const webmPath = path.join(MEDIA_DIR, 'video.webm');
  fs.copyFileSync(webmSrc, webmPath);
  try { fs.unlinkSync(webmSrc); } catch {} // 删 Playwright 原始 page@<hash>.webm

  updateStatus({ phase: 'converting', progress: 0.99, message: SPEC.ffmpegPath ? '转码 mp4…' : '无 ffmpeg, 保留 webm' });
  let mp4Ok = false;
  if (SPEC.ffmpegPath) {
    const mp4Path = path.join(MEDIA_DIR, 'video.mp4');
    mp4Ok = await convertMp4(webmPath, mp4Path, SPEC.ffmpegPath);
  }

  // 枚举产物
  const thumbs = fs.readdirSync(MEDIA_DIR).filter((f) => /^thumb-\d+\.png$/.test(f)).sort();

  fs.writeFileSync(EVENTS_PATH, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(SCRIPT_PATH, buildScript());

  const artifacts = {
    videoWebm: 'video.webm',
    videoMp4: mp4Ok ? 'video.mp4' : null,
    thumbs,
  };
  updateStatus({
    state: 'done',
    phase: 'done',
    progress: 1,
    message: '录制完成',
    artifacts,
    durationSec: elapsed(),
  });
  clearInterval(heartbeat);
}

function buildScript() {
  const lines = ['# 自动录制口播稿', ''];
  for (const e of events) {
    if (e.type === 'title') lines.push(`- ${e.title}：${e.body}`);
    else if (e.type === 'focus' || e.type === 'click') lines.push(`- ${e.label}：${e.caption}`);
  }
  lines.push('');
  return lines.join('\n');
}

main().catch((e) => {
  clearInterval(heartbeat);
  try { updateStatus({ state: 'error', error: String(e && e.message || e).slice(0, 300), phase: 'error', message: '录制失败' }); } catch {}
  console.error(String(e && e.stack || e));
  process.exit(1);
});
