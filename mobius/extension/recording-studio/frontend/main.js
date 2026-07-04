import { extCall } from '/extension/_sdk/ext.js';

const EXT = window.__EXT_NAME__;
const $ = (id) => document.getElementById(id);
const mediaUrl = (id, file) => `/extension/${EXT}/media/${id}/${file}`;

let selectedId = null;
let listTimer = null;
let statusTimer = null;
let currentRecipe = 'self-cognition';

// ---------- deps ----------
async function checkDeps() {
  try {
    const r = await extCall({ action: 'whoami' });
    const d = r.deps || {};
    const badge = $('depBadge');
    if (d.playwright && d.ffmpeg) {
      badge.textContent = '✓ 录制环境就绪';
      badge.className = 'dep-badge ok';
    } else if (d.playwright) {
      badge.textContent = '✓ Playwright (无 ffmpeg, 仅 webm)';
      badge.className = 'dep-badge warn';
    } else {
      badge.textContent = '✗ 缺少 Playwright, 录制不可用';
      badge.className = 'dep-badge warn';
    }
  } catch (e) {
    $('depBadge').textContent = '依赖检查失败';
  }
}

// ---------- recipe switch ----------
document.querySelectorAll('.recipe-card').forEach((card) => {
  card.addEventListener('click', () => {
    currentRecipe = card.dataset.recipe;
    document.querySelectorAll('.recipe-card').forEach((c) => c.classList.toggle('is-active', c === card));
    $('fields-self-cognition').hidden = currentRecipe !== 'self-cognition';
    $('fields-generic').hidden = currentRecipe !== 'generic';
  });
});

// ---------- parse generic steps textarea ----------
function parseSteps(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf('|');
    if (idx < 0) out.push({ caption: line, selector: '' });
    else out.push({ caption: line.slice(0, idx).trim(), selector: line.slice(idx + 1).trim() });
  }
  return out;
}

// ---------- start ----------
$('startBtn').addEventListener('click', async () => {
  const err = $('formError'); err.hidden = true;
  const btn = $('startBtn'); btn.disabled = true; btn.textContent = '提交中…';
  const pace = $('opt_pace').value;
  const [vw, vh] = $('opt_viewport').value.split('x').map(Number);
  const captions = $('opt_captions').value === 'true';
  const options = { pace, viewport: [vw, vh], captions, convertMp4: true };
  let payload = { action: 'start', recipe: currentRecipe, options };
  if (currentRecipe === 'self-cognition') {
    payload.selfCognition = { hudTitle: $('sc_hudTitle').value, hudBody: $('sc_hudBody').value };
  } else {
    const stepsText = $('g_steps').value.trim();
    payload.generic = {
      url: $('g_url').value.trim() || '/',
      title: $('g_title').value.trim(),
      eyebrow: $('g_eyebrow').value.trim(),
      description: $('g_description').value.trim(),
      hudTitle: $('g_title').value.trim() || '莫比乌斯演示',
      hudBody: $('g_description').value.trim(),
      autoDiscover: !stepsText,
      steps: stepsText ? parseSteps(stepsText) : null,
    };
  }
  try {
    const r = await extCall(payload);
    if (!r.ok) throw new Error(r.error || '启动失败');
    selectedId = r.job.id;
    await refreshList();
    openDrawer(r.job.id, r.job);
    startListPoll();
  } catch (e) {
    err.textContent = e.message || '启动失败';
    err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = '开始录制';
  }
});

// ---------- list ----------
async function refreshList() {
  try {
    const r = await extCall({ action: 'list' });
    if (!r.ok) return;
    renderList(r.jobs || []);
    const anyRunning = (r.jobs || []).some((j) => j.state === 'running');
    if (anyRunning) startListPoll(); else stopListPoll();
  } catch {}
}
function startListPoll() {
  if (listTimer) return;
  listTimer = setInterval(refreshList, 3000);
}
function stopListPoll() { if (listTimer) { clearInterval(listTimer); listTimer = null; } }

function stateLabel(s) { return ({ running: '录制中', done: '已完成', error: '失败', cancelled: '已取消' })[s] || s; }
function fmtTime(iso) { try { return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }

function renderList(jobs) {
  $('jobCount').textContent = String(jobs.length);
  const root = $('jobList');
  if (!jobs.length) { root.innerHTML = '<div class="empty">暂无任务</div>'; return; }
  root.innerHTML = jobs.map((j) => {
    const pct = Math.round((j.progress || 0) * 100);
    const sel = j.id === selectedId ? ' is-selected' : '';
    const dur = j.durationSec ? ` · ${Math.round(j.durationSec)}s` : '';
    return `<div class="job-card${sel}" data-id="${j.id}">
      <div class="job-row1">
        <div class="job-title">${escapeHtml(j.title || j.recipe)}</div>
        <span class="badge ${j.state}">${stateLabel(j.state)}</span>
      </div>
      <div class="job-meta">
        <span>${({ 'self-cognition': 'Self-Cognition', generic: '自定义页面' })[j.recipe] || j.recipe}</span>
        <span>${fmtTime(j.updatedAt)}</span>${dur}
      </div>
      ${j.state === 'running' ? `<div class="progress"><div style="width:${pct}%"></div></div>` : ''}
    </div>`;
  }).join('');
  root.querySelectorAll('.job-card').forEach((el) => {
    el.addEventListener('click', () => openDrawer(el.dataset.id));
  });
}

// ---------- drawer ----------
async function openDrawer(id, jobHint) {
  selectedId = id;
  document.querySelectorAll('.job-card').forEach((el) => el.classList.toggle('is-selected', el.dataset.id === id));
  $('drawerBackdrop').hidden = false;
  $('detailDrawer').hidden = false;
  $('detailState').innerHTML = `<span class="badge running">加载中…</span>`;
  $('detailBody').innerHTML = '';
  await loadDetail(id);
}

$('detailClose').addEventListener('click', closeDrawer);
$('drawerBackdrop').addEventListener('click', closeDrawer);
function closeDrawer() {
  $('detailDrawer').hidden = true; $('drawerBackdrop').hidden = true;
  stopStatusPoll();
}

async function loadDetail(id) {
  try {
    const r = await extCall({ action: 'detail', id });
    if (!r.ok) throw new Error(r.error);
    renderDetail(id, r);
    if (r.status && r.status.state === 'running') startStatusPoll(id);
    else stopStatusPoll();
  } catch (e) {
    $('detailState').innerHTML = `<span class="badge error">加载失败</span>`;
    $('detailBody').textContent = e.message || '';
  }
}

function startStatusPoll(id) {
  stopStatusPoll();
  statusTimer = setInterval(async () => {
    try {
      const r = await extCall({ action: 'detail', id });
      if (r.ok) {
        renderDetail(id, r);
        if (r.status && r.status.state !== 'running') stopStatusPoll();
      }
    } catch {}
  }, 2500);
}
function stopStatusPoll() { if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } }

function renderDetail(id, r) {
  const s = r.status || {};
  $('detailTitle').textContent = s.title || r.recipe || '任务详情';
  const stateHtml = `<span class="badge ${s.state}">${stateLabel(s.state)}</span>
    <span style="color:var(--muted);font-size:12px;margin-left:10px">${escapeHtml(s.message || '')}</span>`;
  $('detailState').innerHTML = stateHtml;

  const a = s.artifacts;
  let html = '';
  if (s.state === 'done' && a) {
    const videoFile = a.videoMp4 || a.videoWebm;
    if (videoFile) {
      html += `<div class="video-wrap"><video src="${mediaUrl(id, videoFile)}" controls preload="metadata"></video></div>`;
      html += `<div class="detail-links">
        <a class="btn ghost small" href="${mediaUrl(id, a.videoMp4 || a.videoWebm)}" target="_blank" download>下载 ${a.videoMp4 ? 'MP4' : 'WEBM'}</a>
        ${a.videoMp4 && a.videoWebm ? `<a class="btn ghost small" href="${mediaUrl(id, a.videoWebm)}" target="_blank" download>下载 WEBM</a>` : ''}
      </div>`;
    }
    if (a.thumbs && a.thumbs.length) {
      html += `<div class="detail-section"><h4>关键帧 (${a.thumbs.length})</h4><div class="thumbs">`;
      html += a.thumbs.map((t) => `<img loading="lazy" src="${mediaUrl(id, t)}" alt="${t}">`).join('');
      html += `</div></div>`;
    }
    if (r.script) {
      html += `<div class="detail-section"><h4>口播稿 / 镜头脚本</h4><div class="script-body">${escapeHtml(r.script).replace(/\n/g, '<br>')}</div></div>`;
    }
    if (r.events) {
      html += `<details class="detail-section"><summary style="cursor:pointer;color:var(--muted);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em">镜头事件日志 (${r.events.split('\n').filter(Boolean).length})</summary><pre>${escapeHtml(r.events)}</pre></details>`;
    }
  } else if (s.state === 'running') {
    const pct = Math.round((s.progress || 0) * 100);
    html = `<div style="text-align:center;padding:30px 10px;color:var(--muted)">
      <div class="spin-inline" style="width:28px;height:28px;border-width:3px;display:block;margin:0 auto 14px"></div>
      <div style="font-size:15px;color:var(--text);font-weight:650">${escapeHtml(s.message || '录制中…')}</div>
      <div class="progress" style="margin-top:14px"><div style="width:${pct}%"></div></div>
      <div style="margin-top:10px;font-size:12px">${pct}%</div>
      <button id="cancelBtn" class="btn danger" style="margin-top:18px" type="button">取消录制</button>
    </div>`;
  } else if (s.state === 'error' || s.state === 'cancelled') {
    html = `<div class="detail-section"><h4>${s.state === 'error' ? '错误信息' : '已取消'}</h4>
      <pre>${escapeHtml(s.error || '无详细信息')}</pre></div>`;
  }
  $('detailBody').innerHTML = html;
  const cancelBtn = $('cancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', async () => {
    cancelBtn.disabled = true; cancelBtn.textContent = '取消中…';
    try { await extCall({ action: 'cancel', id }); } catch {}
    await loadDetail(id);
    refreshList();
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- boot ----------
$('refreshList').addEventListener('click', refreshList);
checkDeps();
refreshList();
// 后台有任务时持续轮询; 切回标签页也刷新
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshList(); });
