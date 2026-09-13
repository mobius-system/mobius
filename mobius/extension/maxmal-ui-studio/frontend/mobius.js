'use strict';
// UI vocabulary is mapped to existing backend entities in README.md.
// This adapter deliberately keeps all data and interactions inside this browser.
const DEMO_KEY = 'maxmal-ui-studio-content-v1';
const seed = {
  issues: [
    { id: 'issue-1', title: '个人主页', description: '做一个简洁、温暖的个人主页，记录作品和想法。', sessions: [{ id: 'session-1', title: '首页布局与视觉', messages: [] }, { id: 'session-2', title: '作品列表设计', messages: [] }] },
    { id: 'issue-2', title: '阅读笔记工具', description: '把阅读中的灵感收集起来，让每一条笔记都容易找到。', sessions: [{ id: 'session-3', title: '梳理功能与交互', messages: [] }] }
  ],
  research: [{ id: 'research-1', title: '下一代知识工作台', description: '研究知识整理的工作流，并完成一个可以体验的产品原型。', chief: 'Chief', model: 'GPT-6 高', sessions: [{ id: 'chief-1', title: 'Chief', role: 'chief', messages: [] }], planned: false }],
  works: [
    { id: 'work-1', title: '每日清单', description: '留一点空间，把今天真正重要的事做好。', kind: 'todo', version: '0.1.0', items: [{ text: '整理今天的灵感', done: false }, { text: '完成一个小小的作品', done: true }] },
    { id: 'work-2', title: '灵感便签', description: '随手记录，慢慢生长。', kind: 'notes', version: '0.1.0', notes: '一个好的界面，让复杂的事情变得简单。' }
  ],
  worlds: [
    { id: 'world-1', title: '我的电脑', kind: '本地设备', address: 'localhost', status: 'connected', folder: '/workspace', ports: [{ port: 3000, label: '作品预览' }] },
    { id: 'world-2', title: '云端工作站', kind: 'SSH', address: 'workspace.example.com', status: 'offline', folder: '/workspace', ports: [] }
  ]
};
let content = structuredClone(seed);
try { const saved = JSON.parse(localStorage.getItem(DEMO_KEY)); if (saved && ['issues', 'research', 'works', 'worlds'].every(k => Array.isArray(saved[k]))) content = saved; } catch {}
const persist = () => { try { localStorage.setItem(DEMO_KEY, JSON.stringify(content)); } catch { toast('本次演示可继续，浏览器未能保存数据'); } };
const uid = prefix => prefix + '-' + crypto.randomUUID();
const groups = {
  projects: { label: '项目', icon: 'folder', heading: '我们要构建什么？', description: '一个项目，一段创造的旅程。', cards: ['从一个想法开始', '构建新功能、应用或工具', '探索并理解代码', '继续最近的项目'], icons: ['edit', 'hammer', 'telescope', 'clock'] },
  professional: { label: '专业项目', icon: 'branch', heading: '把大想法交给 Chief', description: '你确定目标，Chief 组织团队，推动每一步。', cards: ['启动一个专业项目', '深入研究一个问题', '从研究到产品原型', '继续与 Chief 协作'], icons: ['branch', 'telescope', 'hammer', 'review'] },
  works: { label: '我的作品', icon: 'grid', heading: '让想法成为作品', description: '你创造的应用和工具，都在这里。', cards: ['制作一个小工具', '构建个人应用', '从灵感开始创造', '打开最近的作品'], icons: ['hammer', 'grid', 'edit', 'folder'] },
  world: { label: '我的世界', icon: 'globe', heading: '连接你的创造空间', description: '从眼前的电脑，到远方的工作站。', cards: ['连接我的电脑', '添加 SSH 工作站', '连接远程设备', '查看已连接设备'], icons: ['panel', 'terminal', 'globe', 'folder'] }
};
let route = { group: 'projects', kind: 'welcome' };
let historyStack = [], historyPosition = -1;
const expanded = new Set();
const RECENT_PAGE_SIZE = 10;
const SESSION_PAGE_SIZE = 5;
let recentLimit = RECENT_PAGE_SIZE;
let recentFilter = 'all';
const sessionLimits = new Map();
let revealRecent = false;
const main = $('.main');
const topbar = document.createElement('div'); topbar.className = 'page-top'; main.prepend(topbar);
const workspace = document.createElement('section'); workspace.className = 'workspace-view'; workspace.hidden = true; main.append(workspace);
const description = document.createElement('p'); description.className = 'welcome-description'; $('h1').after(description);
const welcomeList = document.createElement('div'); welcomeList.className = 'welcome-list'; $('.welcome').append(welcomeList);
const context = document.createElement('div'); context.className = 'context-panel'; $('.rightbar').append(context);
$('.project-section').remove(); $('.recent-section').remove();
const sidebarBody = document.createElement('div'); sidebarBody.className = 'sidebar-body'; $('.sidebar footer').before(sidebarBody);
$('nav').replaceChildren();
const navNew = document.createElement('button'); navNew.innerHTML = svg('edit') + '<span>新对话</span><span class="nav-end">' + svg('circle-plus') + '</span>'; navNew.onclick = () => newSessionDialog(); $('nav').append(navNew);
for (const [key, group] of Object.entries(groups)) {
  const button = document.createElement('button'); button.dataset.group = key; button.innerHTML = svg(group.icon); button.append(copy('nav-' + key, group.label)); button.onclick = () => { if (!editing) go({ group: key, kind: 'welcome' }); }; $('nav').append(button);
}
function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function copy(key, text, tag = 'span') { initialCopies[key] = text; const el = node(tag, '', state.copies[key] ?? text); el.dataset.copy = key; el.contentEditable = String(editing); return el; }
function button(text, fn, className = 'quiet-button', icon) { const el = node('button', className); el.type = 'button'; if (icon) el.innerHTML = svg(icon); el.append(node('span', '', text)); el.onclick = fn; return el; }
function pill(text, online = false) { const el = node('span', 'pill'); if (online) el.append(node('i', 'status-dot')); el.append(document.createTextNode(text)); return el; }
function getRecord() { return ({ projects: content.issues, professional: content.research, works: content.works, world: content.worlds }[route.group] || []).find(x => x.id === route.id); }
function go(next, replace = false) {
  route = { ...next };
  const opened = getRecord();
  if (opened && ['projects', 'professional'].includes(route.group)) {
    opened.lastOpenedAt = Date.now();
    if (recentFilter !== 'all' && recentFilter !== route.group) recentFilter = 'all';
    if (route.session) {
      expanded.clear(); expanded.add(opened.id);
      const session = opened.sessions.find(s => s.id === route.session);
      if (session) session.lastOpenedAt = Date.now();
    }
    revealRecent = true;
    persist();
  }
  if (!replace) { historyStack = historyStack.slice(0, historyPosition + 1); historyStack.push({ ...route }); historyPosition++; }
  location.hash = new URLSearchParams(Object.entries(route).filter(([, v]) => v !== undefined)).toString();
  render();
}
function recentRecords() {
  return [
    ...content.issues.map(record => ({ record, group: 'projects' })),
    ...content.research.map(record => ({ record, group: 'professional' }))
  ].sort((a, b) => (b.record.lastOpenedAt || 0) - (a.record.lastOpenedAt || 0));
}
function renderSidebar() {
  const scrollTop = sidebarBody.scrollTop;
  const focusKey = sidebarBody.contains(document.activeElement) ? document.activeElement.dataset.sidebarKey : null;
  sidebarBody.replaceChildren();
  const heading = node('div', 'recent-heading');
  const filterNames = { all: '最近', projects: '项目', professional: '专业项目' };
  const filter = button(filterNames[recentFilter], () => {
    const existing = heading.querySelector('.recent-filter-menu');
    if (existing) { existing.remove(); filter.setAttribute('aria-expanded', 'false'); return; }
    const menu = node('div', 'recent-filter-menu'); menu.setAttribute('role', 'menu');
    for (const [key, title] of [['all', '全部'], ['projects', '项目'], ['professional', '专业项目']]) {
      const option = button(title, () => { recentFilter = key; recentLimit = RECENT_PAGE_SIZE; sidebarBody.scrollTop = 0; renderSidebar(); }, '');
      option.setAttribute('role', 'menuitemradio'); option.setAttribute('aria-checked', String(key === recentFilter));
      menu.append(option);
    }
    menu.onkeydown = event => {
      const options = [...menu.querySelectorAll('button')]; const i = options.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.stopPropagation(); menu.remove(); filter.setAttribute('aria-expanded', 'false'); filter.focus(); }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); options[(i + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus(); }
    };
    menu.addEventListener('focusout', event => {
      if (!heading.contains(event.relatedTarget)) { menu.remove(); filter.setAttribute('aria-expanded', 'false'); }
    });
    heading.append(menu); filter.setAttribute('aria-expanded', 'true'); menu.querySelector('button').focus();
  }, 'recent-filter');
  filter.append(node('span', '')); filter.lastChild.innerHTML = svg('chevron');
  filter.setAttribute('aria-label', '筛选最近项目'); filter.setAttribute('aria-haspopup', 'menu'); filter.setAttribute('aria-expanded', 'false'); filter.dataset.sidebarKey = 'filter';
  heading.append(filter); sidebarBody.append(heading);
  const list = node('div', 'recent-list'); list.setAttribute('aria-label', '最近的项目');
  const records = recentRecords().filter(item => recentFilter === 'all' || item.group === recentFilter);
  for (const { record, group } of records.slice(0, recentLimit)) {
    const row = node('div', 'recent-row' + (route.id === record.id ? ' current' : ''));
    const open = button(record.title, () => go({ group, kind: 'detail', id: record.id }), 'recent-title');
    open.title = record.title + ' · ' + groups[group].label; open.dataset.sidebarKey = record.id;
    if (route.id === record.id && !route.session) open.setAttribute('aria-current', 'page');
    row.append(open);
    if (record.sessions.length) {
      const toggle = button('', () => {
        const closing = expanded.has(record.id); expanded.clear();
        if (!closing) expanded.add(record.id);
        renderSidebar();
      }, 'recent-disclosure', 'chevron');
      toggle.setAttribute('aria-label', '展开或折叠 ' + record.title); toggle.setAttribute('aria-expanded', String(expanded.has(record.id))); toggle.dataset.sidebarKey = 'toggle-' + record.id;
      row.append(toggle);
    }
    list.append(row);
    if (expanded.has(record.id) && record.sessions.length) {
      const children = node('div', 'recent-sessions'); children.setAttribute('aria-label', record.title + '的对话');
      const sessions = [...record.sessions].sort((a, b) => (b.id === route.session ? 1 : 0) - (a.id === route.session ? 1 : 0) || (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
      const limit = sessionLimits.get(record.id) || SESSION_PAGE_SIZE;
      sessions.slice(0, limit).forEach(session => {
        const child = button(session.title, () => go({ group, kind: 'session', id: record.id, session: session.id }), 'recent-session' + (route.session === session.id ? ' current' : ''));
        child.title = session.title; child.dataset.sidebarKey = session.id;
        if (route.session === session.id) child.setAttribute('aria-current', 'page');
        children.append(child);
      });
      if (sessions.length > limit) {
        const more = button('显示更多对话', () => { sessionLimits.set(record.id, limit + SESSION_PAGE_SIZE); renderSidebar(); }, 'recent-more');
        more.dataset.sidebarKey = 'sessions-more-' + record.id; children.append(more);
      }
      list.append(children);
    }
  }
  sidebarBody.append(list);
  if (!records.length) sidebarBody.append(node('p', 'recent-empty', '暂无项目'));
  if (records.length > recentLimit) {
    const more = button('显示更多', () => { recentLimit += RECENT_PAGE_SIZE; renderSidebar(); }, 'recent-more');
    more.dataset.sidebarKey = 'more'; sidebarBody.append(more);
  }
  $('nav').querySelectorAll('[data-group]').forEach(b => b.classList.toggle('selected', b.dataset.group === route.group));
  sidebarBody.scrollTop = revealRecent ? 0 : scrollTop; revealRecent = false;
  if (focusKey) [...sidebarBody.querySelectorAll('[data-sidebar-key]')].find(el => el.dataset.sidebarKey === focusKey)?.focus({ preventScroll: true });
}

function renderTop() {
  topbar.replaceChildren(); const crumbs = node('div', 'breadcrumbs'); crumbs.append(button(groups[route.group].label, () => go({ group: route.group, kind: 'welcome' }), ''));
  const record = getRecord(); if (record) { crumbs.append(node('span', '', '/')); const b = button(record.title, () => go({ group: route.group, kind: 'detail', id: record.id }), 'crumb-title'); crumbs.append(b); }
  if (route.kind === 'session') { crumbs.append(node('span', '', '/'), node('span', 'crumb-title', record?.sessions.find(s => s.id === route.session)?.title || '对话')); }
  topbar.append(crumbs, node('span', 'demo-label', '界面演示'));
}
function render() {
  if (!groups[route.group]) route = { group: 'projects', kind: 'welcome' };
  if (!['welcome', 'collection'].includes(route.kind) && !getRecord()) route = { group: route.group, kind: 'welcome' };
  renderTop(); renderSidebar(); workspace.replaceChildren(); workspace.hidden = route.kind === 'welcome' || route.kind === 'session'; $('.welcome').hidden = route.kind !== 'welcome'; $('#conversation').hidden = route.kind !== 'session'; $('#conversation').replaceChildren();
  $('.tool-preview').hidden = true; $('.tool-shortcuts').hidden = false;
  $('.composer-wrap').hidden = route.kind === 'detail' && ['works', 'world'].includes(route.group); main.classList.toggle('no-composer', $('.composer-wrap').hidden);
  $('#attachments').replaceChildren(); $('#prompt').value = '';
  const record = getRecord(); $('#selected-project').textContent = record?.title || ({ projects: '选择项目', professional: '由 Chief 主导', works: '创造新作品', world: '选择设备' }[route.group]);
  $('#prompt').placeholder = ({ projects: '随心输入', professional: '告诉 Chief 你的目标', works: '描述你想创造的作品', world: '你想连接怎样的工作空间？' }[route.group]);
  if (route.kind === 'welcome') renderWelcome(); else if (route.kind === 'collection') renderCollection(); else if (route.kind === 'session') renderSession(); else ({ projects: renderProject, professional: renderProfessional, works: renderWork, world: renderWorld }[route.group])();
  renderContext(); $('#app').classList.remove('mobile-left');
}
function renderWelcome() {
  const g = groups[route.group]; $('.welcome').classList.add('has-description'); const h = $('.welcome h1'); const k = route.group + '-heading'; h.dataset.copy = k; initialCopies[k] = g.heading; h.textContent = state.copies[k] ?? g.heading; h.contentEditable = String(editing);
  const dk = route.group + '-description'; description.dataset.copy = dk; initialCopies[dk] = g.description; description.textContent = state.copies[dk] ?? g.description; description.contentEditable = String(editing);
  $('#cards').replaceChildren(); g.cards.forEach((title, i) => { const b = node('button', 'suggestion'); b.innerHTML = svg(g.icons[i]); b.append(copy(route.group + '-card-' + i, title)); b.onclick = () => { if (editing) return; welcomeAction(i); }; $('#cards').append(b); });
  welcomeList.replaceChildren(); welcomeList.append(node('div', 'list-heading', ({ projects: '最近的项目', professional: '最近的专业项目', works: '最近的作品', world: '我的设备 · 演示' }[route.group])));
  const listHeading = welcomeList.querySelector('.list-heading'); listHeading.append(button('查看全部', () => go({group:route.group,kind:'collection'}), 'view-all'));
  const records = { projects: content.issues, professional: content.research, works: content.works, world: content.worlds }[route.group];
  if (!records.length) welcomeList.append(node('p', 'subtle', '从上面的入口开始，创造你的第一个空间。'));
  records.slice(0, 2).forEach(r => { const b = node('button', 'compact-item'); b.innerHTML = svg(g.icon); b.append(node('span', 'item-name', r.title)); b.append(node('span', 'item-meta', r.sessions ? r.sessions.length + (route.group === 'professional' ? ' 位智能体' : ' 段对话') : route.group === 'world' ? r.status === 'connected' ? '已连接 · 演示' : '未连接' : 'v' + r.version)); b.onclick = () => go({ group: route.group, kind: 'detail', id: r.id }); welcomeList.append(b); });
}
function welcomeAction(i) {
  const first = { projects: content.issues, professional: content.research, works: content.works, world: content.worlds }[route.group][0];
  if (i === 3 && first) return go({ group: route.group, kind: 'detail', id: first.id });
  if (route.group === 'projects') createProject(i === 1 ? '新应用' : '');
  if (route.group === 'professional') createProfessional(i === 1 ? '专题研究' : i === 2 ? '产品原型' : '');
  if (route.group === 'works') createWork(i === 2 ? 'notes' : 'todo');
  if (route.group === 'world') connectWorld(['本地设备', 'SSH', '反向连接'][i] || '本地设备');
}
function heading(eyebrow, title, subtitle, action) {
  const header = node('div', 'view-heading'); header.append(node('div', 'eyebrow', eyebrow)); const row = node('div', 'view-heading-row'); row.append(node('h1', '', title)); if (action) row.append(action); header.append(row, node('p', 'subtle', subtitle)); workspace.append(header);
}
function tabs(options, selected, onChange) { const root = node('div', 'view-tabs'); options.forEach(([key, title]) => root.append(button(title, () => onChange(key), key === selected ? 'selected' : ''))); workspace.append(root); }
function detailRow(root, title, subtitle, action, icon = 'folder', meta) { const row = node('div', 'detail-row'); const symbol = node('div', 'row-icon'); symbol.innerHTML = svg(icon); const body = node('div', 'row-main'); body.append(button(title, action, '')); if (subtitle) body.append(node('p', '', subtitle)); row.append(symbol, body); if (meta) row.append(meta); root.append(row); }
function editRecord(record) { form('编辑名称与目标', [{ key: 'title', label: '名称', value: record.title }, { key: 'description', label: '目标', type: 'textarea', value: record.description }], values => { Object.assign(record, values); persist(); render(); }, '保存'); }
function renderProject() {
  const record = getRecord(); heading('项目', record.title, record.description, button('新对话', () => newSessionDialog(record.id), 'quiet-button', 'plus'));
  tabs([['sessions', '对话'], ['overview', '项目目标']], route.tab || 'sessions', tab => go({ ...route, tab }));
  if (route.tab === 'overview') { workspace.append(node('p', 'subtle', record.description), button('编辑项目', () => editRecord(record), 'quiet-button')); return; }
  const list = node('div', 'detail-list'); record.sessions.forEach(s => detailRow(list, s.title, s.messages.length ? s.messages.length + ' 条消息 · 保存在当前浏览器' : '准备好，从一个想法开始', () => go({ ...route, kind: 'session', session: s.id }), 'edit', pill('对话'))); workspace.append(list);
}
function renderProfessional() {
  const r = getRecord(); heading('专业项目', r.title, r.description, button('与 Chief 对话', () => go({ ...route, kind: 'session', session: r.sessions[0].id }), 'quiet-button', 'edit'));
  tabs([['overview', '概览'], ['team', '团队'], ['progress', '进展']], route.tab || 'overview', tab => go({ ...route, tab }));
  if (route.tab === 'team') { const list = node('div', 'detail-list'); r.sessions.forEach(s => detailRow(list, s.title, s.role === 'chief' ? '负责理解目标、拆分工作和协调团队' : '由 Chief 按当前任务安排', () => go({ ...route, kind: 'session', session: s.id }), s.role === 'chief' ? 'branch' : 'edit', pill(s.role === 'chief' ? 'Chief' : '协作成员'))); workspace.append(list); if (!r.planned) workspace.append(node('p', 'empty-state', '现在只有 Chief。其他成员将由 Chief 在需要时组建。')); return; }
  if (route.tab === 'progress') { const list = node('div', 'step-list'); [['目标已确定', r.description], ['Chief 已就位', r.model], [r.planned ? '团队分工已生成 · 演示' : '等待 Chief 制定计划', r.planned ? '研究与实现分别开展，由 Chief 汇总结果。' : '先与 Chief 沟通，再逐步展开工作。']].forEach(([a,b]) => { const p = node('p','',a); p.append(node('small','',b)); list.append(p); }); workspace.append(list); return; }
  const chief = node('div', 'chief-card'); const avatar = node('div', 'chief-avatar'); avatar.innerHTML = svg('branch'); const body = node('div', 'row-main'); body.append(node('h3', '', r.chief), node('p', '', r.model + ' · 主导整个项目'), node('p', '', '理解目标、规划步骤、按需组建团队，并向你汇报。')); chief.append(avatar, body, pill('Chief')); workspace.append(chief);
  workspace.append(node('p', 'subtle', '你只需要与 Chief 沟通。团队的组建和任务安排，由 Chief 负责。'));
  const controls = node('div', 'inline-actions'); controls.append(button('编辑项目目标', () => editRecord(r))); if (!r.planned) controls.append(button('预览 Chief 分工', () => planTeam(r), 'quiet-button')); else controls.append(button('查看团队', () => go({ ...route, tab: 'team' }))); workspace.append(controls);
}
function planTeam(r) {
  if (!r.planned) { r.planned = true; r.sessions.push({ id: uid('agent'), title: '研究助手', role: 'assistant', messages: [] }, { id: uid('agent'), title: '实现助手', role: 'assistant', messages: [] }); r.sessions[0].messages.push({ role: 'assistant', text: '分工预览：我会先明确目标与验收方式，再安排研究助手梳理资料、实现助手搭建原型。最终由我汇总和检查。' }); persist(); }
  go({ group: 'professional', kind: 'detail', id: r.id, tab: 'team' });
}
function renderSession() {
  const r = getRecord(); const s = r.sessions.find(x => x.id === route.session); if (!s) { route.kind = 'detail'; delete route.session; return render(); }
  const root = $('#conversation'); root.replaceChildren(); if (!s.messages.length) { root.append(node('div', 'assistant-name', route.group === 'professional' ? s.title : 'Mobius')); root.append(node('p', 'subtle', route.group === 'professional' ? (s.role === 'chief' ? '我会先理解你的目标，再决定工作步骤和需要的团队。我们从哪里开始？' : '这里是由 Chief 安排的协作对话。') : '这里保存「' + s.title + '」的思考与进展。告诉我，你想先做什么？')); }
  s.messages.forEach(m => { const el = node('div', 'message ' + m.role); if (m.role === 'assistant') el.append(node('small', '', route.group === 'professional' ? s.title + ' · 演示回复' : 'Mobius · 演示回复')); el.append(document.createTextNode(m.text)); root.append(el); });
  root.scrollTop = root.scrollHeight;
}
function sendMessage(text) {
  const r = getRecord(); if (route.kind !== 'session') {
    if (route.group === 'professional') { if (!r) return createProfessional('', text); return go({ ...route, kind: 'session', session: r.sessions[0].id }), sendMessage(text); }
    if (route.group === 'projects') { if (!r) return createProject('', text); const s = { id: uid('session'), title: text.slice(0, 28), messages: [] }; r.sessions.push(s); persist(); go({ ...route, kind: 'session', session: s.id }); return sendMessage(text); }
    return route.group === 'works' ? createWork('todo', text) : connectWorld('SSH');
  }
  const s = r.sessions.find(x => x.id === route.session); s.messages.push({ role: 'user', text }, { role: 'assistant', text: route.group === 'professional' ? '收到。我会围绕这个目标梳理步骤，并在需要时安排协作成员。\n\n这是 Chief 对话的前端演示。你可以返回项目概览，预览团队分工。' : '我们可以围绕这个想法继续展开。\n\n这段演示对话会保留在当前项目中，你也可以新开一段对话，探索另一种方向。' }); persist(); renderSession(); $('#prompt').value = ''; $('#attachments').replaceChildren(); renderSidebar();
}
function renderWork() {
  const r = getRecord(); heading('我的作品', r.title, r.description, button('编辑作品', () => editRecord(r), 'quiet-button', 'edit'));
  tabs([['preview', '预览'], ['about', '关于作品']], route.tab || 'preview', tab => go({ ...route, tab }));
  if (route.tab === 'about') { workspace.append(node('p', 'subtle', '版本 ' + r.version + ' · 独立扩展作品'), node('p', 'subtle', '此处展示作品的打开状态。预览内的数据只保存在当前浏览器。')); return; }
  const frame = node('div', 'preview-surface'); frame.append(node('div', 'preview-toolbar', '○  ○  ○    / ' + r.title)); const view = node('div', 'preview-content'); view.append(node('h2', '', r.kind === 'todo' ? '今天，专注一点' : '留住一个灵感'));
  if (r.kind === 'notes') { const area = node('textarea'); area.value = r.notes || ''; area.setAttribute('aria-label', '灵感便签'); area.style.cssText = 'width:100%;min-height:200px;border:0;resize:vertical;background:transparent;color:inherit;font:inherit;line-height:1.9'; area.oninput = () => { r.notes = area.value; persist(); }; view.append(area); }
  else { const inputRow = node('form', 'todo-input'); const input = node('input'); input.placeholder = '添加一件想做的事'; input.setAttribute('aria-label', '新的待办'); inputRow.append(input, button('添加', () => inputRow.requestSubmit())); inputRow.onsubmit = e => { e.preventDefault(); if (!input.value.trim()) return; r.items.push({ text: input.value.trim(), done: false }); persist(); renderWorkPreview(); }; view.append(inputRow); r.items.forEach((item,i) => { const row = node('div','todo-row' + (item.done ? ' done' : '')); const check = node('input'); check.type = 'checkbox'; check.checked = item.done; check.setAttribute('aria-label', item.text); check.onchange = () => { item.done = check.checked; persist(); renderWorkPreview(); }; row.append(check,node('span','',item.text),button('×',()=>{r.items.splice(i,1);persist();renderWorkPreview();},'')); view.append(row); }); }
  frame.append(view); workspace.append(frame);
}
function renderWorkPreview() { workspace.replaceChildren(); renderWork(); }
function renderWorld() {
  const r = getRecord(); heading('我的世界', r.title, r.kind + ' · ' + r.address, button(r.status === 'connected' ? '断开演示连接' : '模拟连接', () => { r.status = r.status === 'connected' ? 'offline' : 'connected'; persist(); render(); }));
  tabs([['overview','概览'],['files','文件'],['terminal','终端'],['ports','端口']],route.tab || 'overview',tab=>go({...route,tab}));
  if (r.status !== 'connected' && route.tab && route.tab !== 'overview') { workspace.append(node('p','empty-state','设备尚未连接。点击「模拟连接」后查看文件、终端和端口。')); return; }
  if (route.tab === 'files') { const path = route.folder ? r.folder + '/src' : r.folder; workspace.append(node('p','file-path',path)); const list = node('div','detail-list'); if (route.folder) detailRow(list,'..','返回工作目录',()=>go({...route,folder:undefined}),'folder'); for (const f of route.folder ? ['index.html','main.js','style.css'] : ['src','README.md','package.json']) detailRow(list,f,f === 'src' ? '文件夹' : '演示文件',()=>{if(f === 'src')return go({...route,folder:'src'});modal(f,root=>{const pre=node('pre','terminal-surface', f==='README.md'?'# 我的工作空间\n\n在这里开始创造。':f==='package.json'?'{}':'// 文件内容预览\n// 此处不会读取真实设备文件。');root.append(pre);});},f==='src'?'folder':'terminal'); workspace.append(list); return; }
  if (route.tab === 'terminal') { const output = node('div','terminal-surface','AIMUX · 终端演示\n\n'+r.folder+' › 准备就绪\n这里展示输入与输出，不执行真实命令。'); const formEl = node('form','terminal-input'); const input = node('input'); input.placeholder = '输入演示命令'; input.setAttribute('aria-label','设备终端命令'); formEl.append(node('span','subtle','›'),input,button('运行',()=>formEl.requestSubmit())); formEl.onsubmit=e=>{e.preventDefault();const command=input.value.trim();if(!command)return;output.textContent+='\n\n› '+command+'\n'+(command==='pwd'?r.folder:command==='ls'?'src  README.md  package.json':'已接收演示输入，未执行命令。');input.value='';}; workspace.append(output,formEl); return; }
  if (route.tab === 'ports') { workspace.append(node('p','subtle','把设备上的应用带到眼前。以下为本地演示端口。')); const list=node('div','detail-list');r.ports.forEach(p=>detailRow(list,p.label,'127.0.0.1:'+p.port,()=>modal('端口预览',root=>{note(root,'演示端口 '+p.port+' · 未建立真实端口转发');choice(root,'打开作品演示',()=>{$('#dialog').close();go({group:'works',kind:'detail',id:content.works[0]?.id});});}),'globe',pill('演示')));workspace.append(list,button('添加演示端口',()=>form('添加端口',[{key:'label',label:'名称'},{key:'port',label:'端口',value:'3000'}],values=>{const port=Number(values.port);if(!Number.isInteger(port)||port<1||port>65535)throw Error('请输入 1–65535 的整数端口');if(r.ports.some(p=>p.port===port))throw Error('该端口已存在');r.ports.push({label:values.label,port});persist();render();})));return; }
  const summary=node('div','device-summary');[['连接方式',r.kind],['设备状态',r.status==='connected'?'已连接 · 演示':'未连接'],['工作目录',r.folder]].forEach(([k,v])=>{const el=node('div');el.append(node('span','',k),node('strong','',v));summary.append(el);});workspace.append(summary,node('p','subtle','通过 AIMUX 连接设备后，可以在同一处查看文件、打开终端并预览服务。此页面展示连接后的使用方式。'));
  const controls=node('div','inline-actions');controls.append(button('打开文件',()=>go({...route,tab:'files'}),'quiet-button','folder'),button('打开终端',()=>go({...route,tab:'terminal'}),'quiet-button','terminal'));workspace.append(controls);
}
function renderContext() {
  context.replaceChildren(); const r = getRecord(); context.hidden = !r; $('.rightbar').classList.toggle('has-context',!!r); if (!r) return;
  context.append(node('h3','',({projects:'项目空间',professional:'项目团队',works:'作品信息',world:'连接信息'}[route.group])),node('h4','',r.title));
  function kv(k,v){const row=node('div','kv');row.append(node('span','',k),node('span','',v));context.append(row);}
  if(route.group==='projects'){kv('对话',String(r.sessions.length));kv('状态','进行中');context.append(node('p','','每段对话保留自己的上下文，一起围绕同一个项目目标。'));}
  if(route.group==='professional'){kv('负责人',r.chief);kv('模型',r.model);kv('团队',r.sessions.length+' 位智能体');const section=node('div','context-section');r.sessions.forEach(s=>section.append(button(s.title,()=>go({group:'professional',kind:'session',id:r.id,session:s.id}),'compact-item',s.role==='chief'?'branch':'edit')));context.append(section,node('p','','成员由 Chief 按任务需要安排。'));}
  if(route.group==='works'){kv('类型','扩展作品');kv('版本',r.version);kv('存储','当前浏览器');context.append(node('p','','应用以独立页面呈现，保持自己的交互和数据。'));}
  if(route.group==='world'){kv('方式',r.kind);kv('状态',r.status==='connected'?'已连接 · 演示':'未连接');kv('地址',r.address);kv('端口',String(r.ports.length));context.append(node('p','','文件、终端和端口共享同一个设备连接。'));}
}
function form(title, fields, submit, submitText='创建') {
  modal(title, root=>{const el=node('form');const inputs={};fields.forEach(f=>{const label=node('label','form-field');label.append(node('span','',f.label));const input=node(f.type==='textarea'?'textarea':f.options?'select':'input');input.name=f.key;input.setAttribute('aria-label',f.label);if(f.options)f.options.forEach(v=>{const opt=node('option','',v);opt.value=v;input.append(opt);});input.value=f.value||'';input.required=f.required!==false;label.append(input);inputs[f.key]=input;el.append(label);});const err=node('p','form-error');const footer=node('div','actions');const send=button(submitText,()=>el.requestSubmit(),'quiet-button primary');footer.append(send,button('取消',()=>$('#dialog').close(),'quiet-button'));el.append(err,footer);el.onsubmit=e=>{e.preventDefault();err.textContent='';const values=Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.value.trim()]));if(fields.some(f=>f.required!==false&&!values[f.key])){err.textContent='请填写必填内容';return;}try{submit(values);$('#dialog').close();}catch(error){err.textContent=error.message;}};root.append(el);note(root,'仅保存前端演示数据，不会创建真实任务或连接设备。');});
}
function createProject(title='', goal='') { form('新建项目',[{key:'title',label:'项目名称',value:title},{key:'description',label:'想做什么？',type:'textarea',value:goal}],v=>{const record={id:uid('issue'),...v,sessions:[]};content.issues.unshift(record);persist();go({group:'projects',kind:'detail',id:record.id});}); }
function newSessionDialog(id) { const target=content.issues.find(r=>r.id===id) || (route.group==='projects'?getRecord():null); if(!target){chooseProject('在哪里开始新对话？', record => newSessionDialog(record.id));return;} form('新对话',[{key:'title',label:'对话名称',value:'新的想法'}],v=>{const s={id:uid('session'),title:v.title,messages:[]};target.sessions.push(s);expanded.add(target.id);persist();go({group:'projects',kind:'session',id:target.id,session:s.id});},'开始对话'); }
function createProfessional(title='',goal='') { form('启动专业项目',[{key:'title',label:'项目名称',value:title},{key:'description',label:'交给 Chief 的目标',type:'textarea',value:goal},{key:'chief',label:'Chief 名称',value:'Chief'},{key:'model',label:'Chief 模型',value:'GPT-6 高',options:['GPT-6 高','5.6 Sol 高','5.6 Sol 中']}],v=>{const r={id:uid('research'),...v,planned:false,sessions:[{id:uid('chief'),title:v.chief,role:'chief',messages:[]}]};content.research.unshift(r);persist();go({group:'professional',kind:'detail',id:r.id});},'交给 Chief'); }
function createWork(kind='todo',goal='') { form('创造新作品',[{key:'title',label:'作品名称',value:kind==='notes'?'新的灵感便签':'我的小工具'},{key:'description',label:'作品介绍',type:'textarea',value:goal},{key:'template',label:'起点',value:kind==='notes'?'灵感便签':'每日清单',options:['每日清单','灵感便签']}],v=>{const r={id:uid('work'),title:v.title,description:v.description,kind:v.template==='灵感便签'?'notes':'todo',items:[],notes:'',version:'0.1.0'};content.works.unshift(r);persist();go({group:'works',kind:'detail',id:r.id});},'创建作品'); }
function connectWorld(kind='本地设备') { form('连接你的世界',[{key:'title',label:'设备名称',value:kind==='本地设备'?'我的新设备':'远程工作站'},{key:'kind',label:'连接方式',value:kind,options:['本地设备','SSH','反向连接']},{key:'address',label:'设备地址',value:kind==='本地设备'?'localhost':'workspace.example.com'},{key:'folder',label:'工作目录',value:'/workspace'}],v=>{const r={id:uid('world'),...v,status:'connected',ports:[]};content.worlds.unshift(r);persist();go({group:'world',kind:'detail',id:r.id});},'预览连接'); }
actions.new=()=>newSessionDialog();
actions.project=()=>{if(route.group==='projects')chooseProject('选择项目', record => { $('#dialog').close(); go({group:'projects',kind:'detail',id:record.id}); });else if(route.group==='professional')createProfessional();else if(route.group==='works')createWork();else connectWorld();};
actions.back=()=>{if(historyPosition>0){historyPosition--;go(historyStack[historyPosition],true);}};
actions.forward=()=>{if(historyPosition<historyStack.length-1){historyPosition++;go(historyStack[historyPosition],true);}};
actions.search = () => modal('搜索你的空间', root => {
  const input = node('input'); input.placeholder = '项目、对话、作品或设备'; input.setAttribute('aria-label', '搜索你的空间'); input.style.width = '100%';
  const results = node('div', 'space-search-results'); root.append(input, results);
  const entries = [];
  for (const [group, records] of [['projects', content.issues], ['professional', content.research], ['works', content.works], ['world', content.worlds]]) {
    records.forEach(r => {
      entries.push({ title: r.title, group, kind: 'detail', id: r.id });
      r.sessions?.forEach(session => entries.push({ title: r.title + ' / ' + session.title, group, kind: 'session', id: r.id, session: session.id }));
    });
  }
  let limit = 30;
  const update = () => {
    results.replaceChildren();
    const query = input.value.normalize('NFKC').toLowerCase().trim();
    const matches = entries.filter(x => x.title.normalize('NFKC').toLowerCase().includes(query));
    matches.slice(0, limit).forEach(x => {
      const result = choice(results, x.title, () => { $('#dialog').close(); go({ group: x.group, kind: x.kind, id: x.id, ...(x.session ? { session: x.session } : {}) }); });
      result.title = x.title + ' · ' + groups[x.group].label;
    });
    if (matches.length > limit) choice(results, '显示更多结果', () => { limit += 30; update(); });
    if (!matches.length) note(results, '没有匹配的内容');
  };
  input.oninput = () => { limit = 30; update(); }; update(); input.focus();
});
$('#composer').onsubmit=e=>{e.preventDefault();const text=$('#prompt').value.trim();if(text)sendMessage(text);else toast('写下你的想法，从这里开始');};
renderRecent = () => renderSidebar();
renderProjects = () => {};
const originalSettings=actions.settings;
actions.settings=()=>{originalSettings();const irrelevant=[...$('#dialog-body').querySelectorAll('button')].find(b=>b.textContent==='编辑最近对话');irrelevant?.remove();const originalReset=[...$('#dialog-body').querySelectorAll('button')].find(b=>b.textContent==='恢复参考布局');if(originalReset){const reset=originalReset.onclick;originalReset.onclick=()=>{reset();render();};}const extra=node('div','actions');extra.append(button('恢复演示内容',()=>{content=structuredClone(seed);persist();$('#dialog').close();go({group:'projects',kind:'welcome'});toast('已恢复演示内容');}));$('#dialog-body').append(extra);};
actions.profile=actions.settings;
settings=actions.settings;
window.addEventListener('hashchange',()=>{const next=Object.fromEntries(new URLSearchParams(location.hash.slice(1)));if(JSON.stringify(next)!==JSON.stringify(route)&&groups[next.group]){go(next,true);}});
const initialRoute=Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
go(groups[initialRoute.group]?initialRoute:{group:'projects',kind:'welcome'});

function renderCollection() {
  const group = route.group;
  const create = { projects: () => createProject(), professional: () => createProfessional(), works: () => createWork(), world: () => connectWorld() }[group];
  const records = { projects: content.issues, professional: content.research, works: content.works, world: content.worlds }[group];
  heading('你的空间', groups[group].label, groups[group].description, button(group === 'world' ? '连接设备' : group === 'works' ? '创造作品' : '新建项目', create, 'quiet-button', 'plus'));
  const list = node('div', 'detail-list');
  records.forEach(r => detailRow(list, r.title, r.description || r.kind + ' · ' + r.address, () => go({group,kind:'detail',id:r.id}), groups[group].icon, pill(r.sessions ? r.sessions.length + (group === 'professional' ? ' 位智能体' : ' 段对话') : group === 'works' ? 'v' + r.version : r.status === 'connected' ? '已连接 · 演示' : '未连接')));
  workspace.append(list);
  if (!records.length) workspace.append(node('p', 'empty-state', '这里还没有内容，开始创建你的第一个空间。'));
}

function chooseProject(title, onChoose) {
  modal(title, root => {
    const input = node('input'); input.placeholder = '搜索项目'; input.setAttribute('aria-label', '搜索项目'); input.style.width = '100%';
    const results = node('div', 'space-search-results'); root.append(input, results);
    let limit = 30;
    const update = () => {
      results.replaceChildren();
      const query = input.value.trim().toLowerCase();
      const records = content.issues.filter(r => r.title.toLowerCase().includes(query));
      records.slice(0, limit).forEach(r => { const item = choice(results, r.title, () => onChoose(r)); item.title = r.title; });
      if (records.length > limit) choice(results, '显示更多结果', () => { limit += 30; update(); });
      if (!records.length) note(results, '没有匹配的项目');
    };
    input.oninput = () => { limit = 30; update(); }; update();
    choice(root, '＋ 新建项目', () => createProject()); input.focus();
  });
}
