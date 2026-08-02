// Best API 控制台 — 前端 (阶段A 只读 + 阶段B 写管理)
// Tab: 概览 / Key池(写) / 渠道(写) / 用量日志 / 计费 / 模型。
// 读: extCall({action,params}); 写: extCall({action,body})。经 handler → best-api /admin/api。
import { extCall } from '/extension/_sdk/ext.js';

const TABS = [
  { id: 'overview',  name: '概览',     ico: '📊' },
  { id: 'keypool',   name: 'Key 池',   ico: '🔑' },
  { id: 'channels',  name: '渠道',     ico: '🔌' },
  { id: 'calls',     name: '用量日志', ico: '📋' },
  { id: 'billing',   name: '计费',     ico: '💰' },
  { id: 'models',    name: '模型',     ico: '🧩' },
];

let currentTab = 'overview';
let autoTimer = null;

// ---------- 工具 ----------
const nf = new Intl.NumberFormat('zh-CN');
const fmtInt = v => (v == null || v === '' || isNaN(v)) ? '—' : nf.format(Number(v));
const fmtMoney = v => (v == null || isNaN(v)) ? '—' : '¥' + Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
const fmtPct = v => (v == null || isNaN(v)) ? '—' : Number(v).toFixed(2) + '%';
const fmtTime = s => { if (!s) return '—'; const d = new Date(String(s).endsWith('Z') ? s : s + 'Z'); return isNaN(d) ? s : d.toLocaleString('zh-CN', { hour12: false }); };
const fmtAgo = s => { if (!s) return '—'; const d = new Date(String(s).endsWith('Z') ? s : s + 'Z'); if (isNaN(d)) return '—'; const sec = Math.max(0, ((Date.now() - d) / 1000) | 0); if (sec < 60) return sec + 's'; if (sec < 3600) return (sec / 60 | 0) + 'm'; if (sec < 86400) return (sec / 3600 | 0) + 'h'; return (sec / 86400 | 0) + 'd'; };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);

async function api(action, params) {
  const r = await extCall({ action, params });
  if (!r || !r.ok) throw new Error((r && r.error) || '调用失败');
  return r.data;
}
async function apiWrite(action, body) {
  const r = await extCall({ action, body });
  if (!r || !r.ok) throw new Error((r && r.error) || '写操作失败');
  return r.data;
}
async function apiDel(action, body) { return apiWrite(action, body); }

// ---------- 框架 ----------
function renderShell() {
  $('app').innerHTML = `
    <aside class="sidebar">
      <div class="brand"><img src="./favicon.svg" alt=""/>
        <div><div class="name">Best API</div><div class="sub">控制台</div></div></div>
      ${TABS.map(t => `<div class="nav-item${t.id === currentTab ? ' active' : ''}" data-tab="${t.id}"><span class="ico">${t.ico}</span><span>${t.name}</span></div>`).join('')}
      <div class="nav-spacer"></div>
      <div class="nav-meta">best-api :39929<br/>${autoTimer ? '🔄 30s 自动刷新' : '已暂停刷新'}</div>
    </aside>
    <main class="main">
      <div class="topbar"><h1 id="tab-title">${esc(TABS.find(t => t.id === currentTab).name)}</h1>
        <span class="sub" id="tab-sub"></span><div class="spacer"></div>
        <span id="err"></span><button class="btn" id="refresh">刷新</button>
        <button class="btn primary" id="auto">${autoTimer ? '⏸ 暂停' : '▶ 自动'}</button></div>
      <div class="content" id="content"></div>
    </main>`;
  document.querySelectorAll('.nav-item').forEach(el => el.addEventListener('click', () => switchTab(el.dataset.tab)));
  $('refresh').addEventListener('click', () => loadTab(true));
  $('auto').addEventListener('click', toggleAuto);
}
function switchTab(id) { if (id !== currentTab) { currentTab = id; renderShell(); loadTab(true); } }
function toggleAuto() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } else { autoTimer = setInterval(() => loadTab(false), 30000); }
  renderShell(); loadTab(true);
}
function setSub(t) { $('tab-sub').textContent = t || ''; }
function setErr(e) { $('err').textContent = e ? ('⚠ ' + e) : ''; }
function showLoader() { $('content').innerHTML = '<div class="empty"><span class="loader"></span> 加载中…</div>'; }
async function loadTab(showLoad) {
  if (showLoad) { showLoader(); setErr(''); }
  try {
    const fn = { overview: renderOverview, keypool: renderKeyPool, channels: renderChannels,
                 calls: renderCalls, billing: renderBilling, models: renderModels }[currentTab];
    await fn(); setErr('');
  } catch (e) { $('content').innerHTML = `<div class="empty">⚠ ${esc(e.message)}</div>`; setErr(e.message); }
}

// ---------- Tab: 概览 ----------
async function renderOverview() {
  setSub('近 24 小时');
  const d = await api('overview', { window: '24h' });
  const k = d.kpi || {};
  const cards = [
    { k: '请求数', v: fmtInt(k.requests), c: 'acc', s: `成功 ${fmtInt(k.success)} · ${fmtPct(k.success_rate)}` },
    { k: '总 Tokens', v: fmtInt(k.total_tokens), c: 'grn', s: `入 ${fmtInt(k.prompt_tokens)} / 出 ${fmtInt(k.completion_tokens)}` },
    { k: '消耗', v: fmtMoney(k.cost), c: 'yel', s: d.bucket_label || '' },
    { k: '平均延迟', v: (k.avg_latency == null ? '—' : Number(k.avg_latency).toFixed(2) + 's'), c: '', s: `首 token ${k.avg_first_token == null ? '—' : Number(k.avg_first_token).toFixed(2) + 's'}` },
  ];
  const topM = (d.top_models || []).slice(0, 6), topP = (d.top_providers || []).slice(0, 6);
  $('content').innerHTML = `
    <div class="cards">${cards.map(c => `<div class="card ${c.c}"><div class="k">${c.k}</div><div class="v">${c.v}</div><div class="sub">${esc(c.s)}</div></div>`).join('')}</div>
    <div class="cards">
      <div class="panel" style="margin:0"><div class="hd"><h2>Top 模型</h2></div>
        <table><thead><tr><th>模型</th><th class="num">请求</th><th class="num">Tokens</th><th class="num">消耗</th></tr></thead>
        <tbody>${topM.length ? topM.map(m => `<tr><td class="mono">${esc(m.model)}</td><td class="num">${fmtInt(m.requests)}</td><td class="num">${fmtInt(m.tokens)}</td><td class="num">${fmtMoney(m.cost)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">无</td></tr>'}</tbody></table></div>
      <div class="panel" style="margin:0"><div class="hd"><h2>Top 渠道</h2></div>
        <table><thead><tr><th>渠道</th><th class="num">请求</th><th class="num">成功率</th></tr></thead>
        <tbody>${topP.length ? topP.map(p => `<tr><td class="mono">${esc(p.provider)}</td><td class="num">${fmtInt(p.requests)}</td><td class="num">${fmtPct(p.requests ? p.success / p.requests * 100 : null)}</td></tr>`).join('') : '<tr><td colspan="3" class="empty">无</td></tr>'}</tbody></table></div>
    </div>`;
}

// ---------- Tab: Key 池 (写: 加/启停/删/改rank) ----------
async function renderKeyPool() {
  setSub('上游 Key 池管理 (会话负载均衡)');
  const [stat, pool] = await Promise.all([api('glm_status'), api('list_keys')]);
  const c = stat.status_counts || {};
  const keys = (pool.keys || []);
  const providers = pool.providers || ['zhipu-codingplan'];
  $('content').innerHTML = `
    <div class="cards">
      ${[['可用','active','grn',c.active],['冷却','cooldown','yel',c.cooldown],['禁用','disabled','red',c.disabled],['累计请求','acc','',stat.totals?.requests]].map(x=>`<div class="card ${x[2]}"><div class="k">${x[0]}</div><div class="v">${fmtInt(x[3])}</div></div>`).join('')}
    </div>
    <div class="panel">
      <div class="hd"><h2>添加上游 Key</h2><span class="hint">写入 keys_status.json (走 LoadBalancer 事务)</span></div>
      <div style="padding:12px 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;align-items:end">
        <div><label class="hint">渠道 (provider)</label><select id="kp-prov" style="width:100%">${providers.map(p=>`<option value="${esc(p)}">${esc(p)}</option>`).join('')}</select></div>
        <div><label class="hint">Key (明文)</label><input id="kp-key" style="width:100%" placeholder="sk-... 或 xxx.yyy"/></div>
        <div><label class="hint">标签</label><input id="kp-label" style="width:100%" placeholder="如 pro月卡"/></div>
        <div><label class="hint">优先级 rank</label><input id="kp-rank" type="number" value="0" style="width:100%"/></div>
        <div><button class="btn primary" id="kp-add">+ 添加 Key</button></div>
      </div>
    </div>
    <div class="panel"><div class="hd"><h2>Key 列表</h2><span class="hint">${keys.length} 个</span></div>
      <div style="overflow-x:auto"><table><thead><tr><th>状态</th><th>Key</th><th>渠道</th><th class="num">rank</th><th class="num">会话</th><th class="num">请求</th><th class="num">成功率</th><th>最后使用</th><th>操作</th></tr></thead>
      <tbody>${keys.length ? keys.map(r => `<tr>
        <td>${kpStatusPill(r)}</td>
        <td class="mono"><strong>${esc(r.key_id||'—')}</strong><div class="faint">${esc(r.label||r.key_masked)}</div></td>
        <td><span class="pill provider">${esc(r.provider)}</span></td>
        <td class="num">${r.rank ?? 0}</td>
        <td class="num">${fmtInt(r.session_count)}</td>
        <td class="num">${fmtInt(r.total_requests)}</td>
        <td class="num">${fmtPct(r.success_rate ?? (r.total_requests ? r.success_requests/r.total_requests*100 : null))}</td>
        <td>${fmtAgo(r.last_used_at)}</td>
        <td><div style="display:flex;gap:4px;flex-wrap:wrap">
          ${r.group==='active' ? `<button class="btn" data-act="disable" data-id="${esc(r.key_id)}">禁用</button>` : `<button class="btn" data-act="enable" data-id="${esc(r.key_id)}">启用</button>`}
          <button class="btn" data-act="del" data-id="${esc(r.key_id)}" style="border-color:var(--red);color:var(--red)">删</button>
        </div></td>
      </tr>`).join('') : '<tr><td colspan="9" class="empty">无 Key</td></tr>'}</tbody></table></div></div>`;
  $('kp-add').addEventListener('click', kpAddKey);
  document.querySelectorAll('#content button[data-act]').forEach(b => b.addEventListener('click', () => kpKeyAction(b.dataset.act, b.dataset.id)));
}
function kpStatusPill(r) {
  const g = r.group;
  if (g === 'active') return '<span class="pill active"><span class="dot"></span>可用</span>';
  if (g === 'cooldown') return '<span class="pill cooldown"><span class="dot"></span>冷却</span>';
  if (g === 'disabled') return '<span class="pill disabled"><span class="dot"></span>禁用</span>';
  return `<span class="pill">${esc(g)}</span>`;
}
async function kpAddKey() {
  const body = { key: $('kp-key').value.trim(), provider: $('kp-prov').value, label: $('kp-label').value.trim() || 'added', rank: parseInt($('kp-rank').value || '0', 10) };
  if (!body.key) { setErr('Key 不能为空'); return; }
  try { await apiWrite('create_key', body); setErr(''); setSub('✓ 已添加'); renderKeyPool(); }
  catch (e) { setErr(e.message); }
}
async function kpKeyAction(act, keyId) {
  const verb = act === 'del' ? '删除' : (act === 'disable' ? '禁用' : '启用');
  if (!confirm(`${verb} key ${keyId} ?`)) return;
  try {
    if (act === 'del') await apiDel('delete_key', { key_id: keyId });
    else if (act === 'disable') await apiWrite('disable_key', { key_id: keyId });
    else await apiWrite('enable_key', { key_id: keyId });
    setSub(`✓ 已${verb}`); renderKeyPool();
  } catch (e) { setErr(e.message); }
}

// ---------- Tab: 渠道 (写: 增删渠道 + 模型路由) ----------
async function renderChannels() {
  setSub('渠道 (config.jsonc) + 模型路由');
  const [chs, routes] = await Promise.all([api('list_channels'), api('list_routes')]);
  const channels = chs.channels || [];
  const overrides = routes.MODEL_OVERRIDE || {};
  const rankDefault = (routes.MODEL_PROVIDER_RANK_DEFAULT || {}).default_rank || [];
  $('content').innerHTML = `
    <div class="panel"><div class="hd"><h2>默认路由 rank</h2><span class="hint">MODEL_PROVIDER_RANK_DEFAULT</span></div>
      <div style="padding:10px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="ch-rankdef" style="flex:1;min-width:300px" value="${esc(rankDefault.join(', '))}" placeholder="逗号分隔渠道名"/>
        <button class="btn primary" id="ch-rankdef-save">保存</button>
      </div></div>
    <div class="panel"><div class="hd"><h2>模型路由 (MODEL_OVERRIDE rank)</h2></div>
      <div style="overflow-x:auto"><table><thead><tr><th>模型</th><th>rank (逗号分隔)</th><th>操作</th></tr></thead>
      <tbody>${Object.keys(overrides).length ? Object.entries(overrides).map(([m, mo]) => `<tr>
        <td class="mono"><strong>${esc(m)}</strong></td>
        <td><input class="ch-rank-input" data-model="${esc(m)}" style="width:100%" value="${esc((mo.MODEL_PROVIDER_RANK_OVERRIDE||[]).join(', '))}"/></td>
        <td><button class="btn" data-saverank="${esc(m)}">保存</button></td>
      </tr>`).join('') : '<tr><td colspan="3" class="empty">无模型 override</td></tr>'}</tbody></table></div></div>
    <div class="panel"><div class="hd"><h2>渠道 (ENDPOINT_API_KEYS)</h2><span class="hint">${channels.length} 个 · 改动写 config.jsonc (~10s 生效)</span></div>
      <div style="overflow-x:auto"><table><thead><tr><th>渠道</th><th>URL</th><th>标志</th><th>Key</th><th>操作</th></tr></thead>
      <tbody>${channels.length ? channels.map(ch => `<tr>
        <td class="mono"><strong>${esc(ch.name)}</strong></td>
        <td class="mono faint" style="max-width:260px;overflow:hidden;text-overflow:ellipsis">${esc(ch.url||'—')}</td>
        <td>${[ch.anthropic_native?'原生':'',ch.use_session_identity_based_load_balance?'会话LB':'',ch.sse_jump_enable?'sse跳':''].filter(Boolean).map(x=>`<span class="pill provider">${x}</span>`).join(' ')||'—'}</td>
        <td class="mono">${ch.has_key?'✓ '+esc(ch.key_masked||''):'<span class="faint">无</span>'}</td>
        <td><button class="btn" data-delch="${esc(ch.name)}" style="border-color:var(--red);color:var(--red)">删</button></td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty">无渠道</td></tr>'}</tbody></table></div></div>
    <div class="panel"><div class="hd"><h2>+ 添加渠道</h2></div>
      <div style="padding:12px 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;align-items:end">
        <div><label class="hint">渠道名 (英文)</label><input id="ch-name" style="width:100%" placeholder="如 newchannel"/></div>
        <div><label class="hint">URL</label><input id="ch-url" style="width:100%" placeholder="https://.../v1"/></div>
        <div><label class="hint">Key</label><input id="ch-key" style="width:100%" placeholder="sk-..."/></div>
        <div><label class="hint">选项</label><select id="ch-native" style="width:100%"><option value="">普通</option><option value="1">anthropic_native</option></select></div>
        <div><button class="btn primary" id="ch-add">+ 添加</button></div>
      </div></div>`;
  $('ch-rankdef-save').addEventListener('click', async () => {
    try { await apiWrite('set_rank_default', { providers: $('ch-rankdef').value.split(',').map(s => s.trim()).filter(Boolean) }); setSub('✓ 默认 rank 已保存'); }
    catch (e) { setErr(e.message); }
  });
  document.querySelectorAll('#content button[data-saverank]').forEach(b => b.addEventListener('click', async () => {
    const m = b.dataset.saverank;
    const v = document.querySelector(`.ch-rank-input[data-model="${m}"]`).value.split(',').map(s => s.trim()).filter(Boolean);
    try { await apiWrite('set_model_rank', { model: m, providers: v }); setSub(`✓ ${m} rank 已保存`); }
    catch (e) { setErr(e.message); }
  }));
  document.querySelectorAll('#content button[data-delch]').forEach(b => b.addEventListener('click', async () => {
    const n = b.dataset.delch; if (!confirm(`删除渠道 ${n} ? (若被模型引用会拒绝)`)) return;
    try { await apiDel('delete_channel', { name: n }); setSub(`✓ 已删除 ${n}`); renderChannels(); }
    catch (e) { setErr(e.message); }
  }));
  $('ch-add').addEventListener('click', async () => {
    const body = { name: $('ch-name').value.trim(), url: $('ch-url').value.trim(), key: $('ch-key').value.trim() };
    if ($('ch-native').value) body.anthropic_native = true;
    if (!body.name || !body.url) { setErr('渠道名和 URL 必填'); return; }
    try { await apiWrite('create_channel', body); setSub(`✓ 已添加 ${body.name}`); renderChannels(); }
    catch (e) { setErr(e.message); }
  });
}

// ---------- Tab: 用量日志 ----------
let callsFilter = { status: '', q: '' };
async function renderCalls() {
  setSub('调用记录');
  const params = { limit: 50, window: '24h' };
  if (callsFilter.status) params.status = callsFilter.status;
  if (callsFilter.q) params.q = callsFilter.q;
  const d = await api('calls', params);
  const rows = d.rows || [];
  $('content').innerHTML = `<div class="panel"><div class="hd"><h2>请求流水</h2><span class="hint">共 ${fmtInt(d.total)} · 显示 ${rows.length}</span></div>
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <select id="cf-status"><option value="">全部</option><option value="ok"${callsFilter.status==='ok'?' selected':''}>成功</option><option value="err"${callsFilter.status==='err'?' selected':''}>失败</option></select>
      <input id="cf-q" style="background:var(--panel2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:12px;width:240px" placeholder="搜索 model/user/provider" value="${esc(callsFilter.q)}"/>
      <button class="btn" id="cf-go">筛选</button></div>
    <div style="overflow-x:auto"><table><thead><tr><th>时间</th><th>用户</th><th>模型</th><th>渠道</th><th>状态</th><th class="num">Tokens</th><th class="num">消耗</th><th class="num">延迟</th></tr></thead>
    <tbody>${rows.length ? rows.map(r => `<tr class="clickable" data-id="${esc(r.id)}"><td>${fmtAgo(r.created_at)}</td><td>${esc(r.user||'—')}</td><td class="mono">${esc(r.model||'—')}</td><td><span class="pill provider">${esc(r.provider||'—')}</span></td><td>${callStatusPill(r.status_code)}</td><td class="num">${fmtInt(r.tokens)}</td><td class="num">${fmtMoney(r.cost)}</td><td class="num">${r.latency==null?'—':Number(r.latency).toFixed(2)+'s'}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">无</td></tr>'}</tbody></table></div></div>`;
  $('cf-go').addEventListener('click', () => { callsFilter.status = $('cf-status').value; callsFilter.q = $('cf-q').value.trim(); renderCalls(); });
  $('cf-q').addEventListener('keydown', e => { if (e.key === 'Enter') $('cf-go').click(); });
  document.querySelectorAll('tr.clickable').forEach(tr => tr.addEventListener('click', () => showCallDetail(tr.dataset.id)));
}
function callStatusPill(code) { if (code == null) return '<span class="muted">—</span>'; const c = Number(code); if (c >= 200 && c < 300) return `<span class="pill active">${c}</span>`; if (c === 429) return `<span class="pill cooldown">${c}</span>`; if (c >= 400 && c < 500) return `<span class="pill disabled">${c}</span>`; return `<span class="pill ready">${c}</span>`; }
async function showCallDetail(id) {
  let d; try { d = await api('call_detail', { id }); } catch (e) { setErr(e.message); return; }
  const mask = document.createElement('div'); mask.className = 'drawer-mask';
  mask.innerHTML = `<div class="drawer"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h3>调用详情 #${esc(d.id)}</h3><button class="btn" id="d-close">✕</button></div>
    <dl class="kv"><dt>时间</dt><dd>${fmtTime(d.created_at)}</dd><dt>UUID</dt><dd class="mono">${esc(d.request_uuid)}</dd><dt>用户</dt><dd>${esc(d.user)}</dd><dt>模型</dt><dd class="mono">${esc(d.requested_model)}</dd><dt>渠道</dt><dd class="mono">${esc(d.provider)}</dd><dt>状态</dt><dd>${callStatusPill(d.status_code)} ${esc(d.finish_reason||'')}</dd><dt>用量</dt><dd>${fmtInt(d.usage_parsed?.prompt_tokens)} 入 / ${fmtInt(d.usage_parsed?.completion_tokens)} 出 · 消耗 ${fmtMoney(d.usage_parsed?.cost)}</dd></dl>
    <div class="codebox">${esc(JSON.stringify(d.model_parsed || d.routing_parsed || {}, null, 2))}</div></div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', e => { if (e.target === mask || e.target.id === 'd-close') document.body.removeChild(mask); });
}

// ---------- Tab: 计费 (用户/令牌管理, 阶段C 写) ----------
async function renderBilling() {
  setSub('用户 / 令牌 / 余额');
  const [u, s, lg, tk] = await Promise.all([api('users'), api('stats'), api('ledger', { limit: 15 }), api('list_tokens')]);
  const users = u.users || [], tokens = (tk.tokens || []), rows = lg.rows || [];
  $('content').innerHTML = `
    <div class="cards">${[['总消耗','yel',fmtMoney(s.total_cost)],['总请求','',fmtInt(s.total_requests)],['用户','',fmtInt(users.length)],['令牌','cyn',fmtInt(tokens.length)]].map(x=>`<div class="card ${x[1]}"><div class="k">${x[0]}</div><div class="v">${x[2]}</div></div>`).join('')}</div>
    <div class="panel"><div class="hd"><h2>+ 添加用户</h2></div>
      <div style="padding:12px 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;align-items:end">
        <div><label class="hint">用户名</label><input id="bl-newuser" style="width:100%"/></div>
        <div><label class="hint">初始余额</label><input id="bl-newbal" type="number" value="0" style="width:100%"/></div>
        <div><label class="hint">备注</label><input id="bl-newnote" style="width:100%"/></div>
        <div><button class="btn primary" id="bl-adduser">+ 添加用户</button></div>
      </div></div>
    <div class="panel"><div class="hd"><h2>用户</h2><span class="hint">${users.length} 个 · 改 user_billing.json (即时生效)</span></div>
      <div style="overflow-x:auto"><table><thead><tr><th>用户</th><th class="num">余额</th><th>状态</th><th class="num">充值(±)</th><th>操作</th></tr></thead>
      <tbody>${users.length ? users.map(x => `<tr>
        <td class="mono"><strong>${esc(x.user)}</strong><div class="faint">${esc(x.note||'')}</div></td>
        <td class="num">${fmtMoney(x.balance)}</td>
        <td>${x.status==='active'?'<span class="pill active">正常</span>':`<span class="pill disabled">${esc(x.status)}</span>`}</td>
        <td><input class="bl-rc" data-user="${esc(x.user)}" type="number" placeholder="±金额" style="width:90px"/></td>
        <td><div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn" data-rc="${esc(x.user)}">充值</button>
          <button class="btn" data-tg="${esc(x.user)}" data-cur="${esc(x.status)}">${x.status==='active'?'封禁':'启用'}</button>
          <button class="btn" data-ik="${esc(x.user)}">发key</button>
          <button class="btn" data-du="${esc(x.user)}" style="border-color:var(--red);color:var(--red)">删</button>
        </div></td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty">无用户</td></tr>'}</tbody></table></div></div>
    <div class="panel"><div class="hd"><h2>令牌 (客户端 API Key)</h2><span class="hint">${tokens.length} 个</span></div>
      <div style="overflow-x:auto"><table><thead><tr><th>Key</th><th>用户</th><th>角色</th><th>valid_keys</th><th>操作</th></tr></thead>
      <tbody>${tokens.length ? tokens.map(t => `<tr>
        <td class="mono">${esc(t.key_masked)} <span class="faint">…${esc(t.key_tail)}</span></td>
        <td>${esc(t.user)}</td>
        <td><span class="pill ${t.role==='admin'?'provider':'ready'}">${esc(t.role)}</span></td>
        <td>${t.in_valid_keys?'<span style="color:var(--green)">✓</span>':'<span style="color:var(--red)">✗</span>'}</td>
        <td><button class="btn" data-rv="${esc(t.key)}" style="border-color:var(--red);color:var(--red)">吊销</button></td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty">无令牌</td></tr>'}</tbody></table></div></div>
    <div class="panel"><div class="hd"><h2>近期流水</h2><span class="hint">${rows.length} 条</span></div>
      <table><thead><tr><th>时间</th><th>用户</th><th>模型</th><th class="num">消耗</th><th class="num">余额后</th></tr></thead>
      <tbody>${rows.length ? rows.map(r => `<tr><td>${fmtAgo(r.created_at)}</td><td>${esc(r.user)}</td><td class="mono">${esc(r.model)}</td><td class="num">${fmtMoney(r.cost)}</td><td class="num">${fmtMoney(r.balance_after)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">无</td></tr>'}</tbody></table></div>`;
  $('bl-adduser').addEventListener('click', async () => {
    try { await apiWrite('add_user', { user: $('bl-newuser').value.trim(), balance: parseFloat($('bl-newbal').value||'0'), note: $('bl-newnote').value.trim() }); setSub('✓ 用户已添加'); renderBilling(); } catch(e){ setErr(e.message); }
  });
  document.querySelectorAll('#content button[data-rc]').forEach(b => b.addEventListener('click', async () => {
    const u = b.dataset.rc, inp = document.querySelector(`.bl-rc[data-user="${u}"]`), amt = parseFloat(inp?.value||'0');
    if (isNaN(amt)) { setErr('充值金额无效'); return; }
    try { await apiWrite('set_balance', { user: u, balance: amt, delta_mode: true }); setSub(`✓ ${u} ${amt>0?'+':''}${amt}`); renderBilling(); } catch(e){ setErr(e.message); }
  }));
  document.querySelectorAll('#content button[data-tg]').forEach(b => b.addEventListener('click', async () => {
    const u = b.dataset.tg, ns = b.dataset.cur === 'active' ? 'banned' : 'active';
    if (!confirm(`${u} → ${ns}?`)) return;
    try { await apiWrite('set_status', { user: u, status: ns }); setSub(`✓ ${u} ${ns}`); renderBilling(); } catch(e){ setErr(e.message); }
  }));
  document.querySelectorAll('#content button[data-ik]').forEach(b => b.addEventListener('click', async () => {
    const u = b.dataset.ik, role = prompt(`为 ${u} 发新 key, 角色 (admin/user)`, 'user');
    if (!role) return;
    try { const r = await apiWrite('issue_key', { user: u, role }); prompt(`新 key 已生成 (仅此一次, 复制保存):`, r.key); setSub(`✓ 已为 ${u} 发 key`); renderBilling(); } catch(e){ setErr(e.message); }
  }));
  document.querySelectorAll('#content button[data-du]').forEach(b => b.addEventListener('click', async () => {
    const u = b.dataset.du; if (!confirm(`删除用户 ${u} 及其所有 key?`)) return;
    try { await apiDel('delete_user', { user: u }); setSub(`✓ 已删 ${u}`); renderBilling(); } catch(e){ setErr(e.message); }
  }));
  document.querySelectorAll('#content button[data-rv]').forEach(b => b.addEventListener('click', async () => {
    const key = b.dataset.rv; if (!confirm(`吊销 key …${key.slice(-8)}?`)) return;
    try { await apiDel('revoke_key', { key }); setSub('✓ 已吊销'); renderBilling(); } catch(e){ setErr(e.message); }
  }));
}

// ---------- Tab: 模型 ----------
async function renderModels() {
  setSub('可用模型');
  const d = await api('models');
  const list = d.data || [];
  $('content').innerHTML = `<div class="panel"><div class="hd"><h2>模型</h2><span class="hint">${list.length} 个</span></div>
    <table><thead><tr><th>模型 ID</th><th>归属</th></tr></thead><tbody>${list.length ? list.map(m => `<tr><td class="mono"><strong>${esc(m.id)}</strong></td><td class="faint">${esc(m.owned_by||'—')}</td></tr>`).join('') : '<tr><td colspan="2" class="empty">无</td></tr>'}</tbody></table></div>`;
}

// ---------- 启动 ----------
renderShell();
loadTab(true);
autoTimer = setInterval(() => loadTab(false), 30000);
