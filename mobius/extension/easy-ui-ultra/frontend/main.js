const element = (id) => document.getElementById(id);
const storageKey = 'easy-ui-ultra-workbench-v3';
const demoMarkup = element('threadContent').innerHTML.replace('正在处理工作区', '工作区处理记录').replace('mini-spinner', 'completed-marker').replace('进行中', '已完成');
const seed = [
  { id: 'workbench', title: '重构三栏工作台', project: 'Mobius 前端', demo: true, messages: [] },
  { id: 'redaction', title: '修复输入框模糊', project: 'Mobius 前端', messages: [{ role: 'assistant', text: '这是一个独立的演示线程。拥有者编辑面应保持清晰，敏感字段使用单独的遮罩。' }] },
  { id: 'ports', title: '端口预览栏交互', project: '开发工具', messages: [{ role: 'assistant', text: '端口列表采用紧凑布局，区分前端、后端与 API。此预览不连接真实服务。' }] },
  { id: 'desktop', title: '桌面端顶栏拖拽', project: 'Mobius Desktop', messages: [{ role: 'assistant', text: '顶栏的交互按钮与拖拽区域需要分离。本扩展仅展示浏览器界面，不控制桌面窗口。' }] },
  { id: 'extension', title: '设计师之眼拓展', project: '实验项目', messages: [{ role: 'assistant', text: '可以在右侧文件面板中查看这次设计的示例代码。' }] },
];
let threads = structuredClone(seed);
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (Array.isArray(saved) && saved.length && saved.every((thread) => typeof thread.id === 'string' && typeof thread.title === 'string' && typeof thread.project === 'string' && Array.isArray(thread.messages) && thread.messages.every((message) => ['user', 'assistant'].includes(message.role) && typeof message.text === 'string'))) threads = saved;
} catch {}
const state = { active: threads[0].id, tab: 'review', file: 0, mode: '执行', environment: '本地环境', attachments: [] };
const files = [
  { name: 'index.html', type: 'html', add: 42, remove: 8, lines: ['<!doctype html>', '<html lang="zh-CN">', '  <body>', '-   <main class="app">', '+   <div class="workspace-shell">', '+     <aside class="left-sidebar"></aside>', '+     <main class="center-pane"></main>', '+     <aside class="right-sidebar"></aside>', '+   </div>', '  </body>', '</html>'] },
  { name: 'main.js', type: 'js', add: 58, remove: 10, lines: ['const state = {', '+  activeThread: "workbench",', '+  activeTab: "review",', '+  selectedFile: null,', '};', '', 'function selectThread(thread) {', '+  state.activeThread = thread.id;', '+  renderThread(thread);', '+  renderInspector();', '}'] },
  { name: 'styles.css', type: 'css', add: 28, remove: 6, lines: ['.workspace-shell {', '-  display: block;', '+  display: grid;', '+  grid-template-columns:', '+    248px minmax(0, 1fr) 340px;', '+  height: 100dvh;', '}', '', '.center-pane {', '+  min-width: 0;', '+  background: #fafaf9;', '}'] },
];
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character])); }
function current() { return threads.find((thread) => thread.id === state.active); }
function persist() { try { localStorage.setItem(storageKey, JSON.stringify(threads)); } catch { showToast('浏览器存储不可用，本次更改仅在当前页面保留'); } }
function showToast(text) { element('toast').textContent = text; element('toast').classList.add('visible'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => element('toast').classList.remove('visible'), 2400); }
function openDialog(markup) { element('dialogContent').innerHTML = markup; element('dialog').showModal(); }
function renderThreads(filter = '') {
  const visible = threads.filter((thread) => `${thread.title} ${thread.project}`.toLowerCase().includes(filter.toLowerCase()));
  element('threadList').innerHTML = visible.map((thread) => `<button class="thread-row ${thread.id === state.active ? 'active' : ''}" data-thread="${escapeHtml(thread.id)}"><span class="thread-mark"></span><span class="thread-copy"><strong>${escapeHtml(thread.title)}</strong><small>${escapeHtml(thread.project)}</small></span></button>`).join('') || '<p class="empty-list">未找到线程</p>';
  document.querySelector('.nav-count').textContent = threads.length;
}
function messageMarkup(message) { return `<article class="message"><div class="message-avatar ${message.role === 'user' ? 'user-avatar' : 'agent-avatar'}">${message.role === 'user' ? 'A' : '✦'}</div><div class="message-copy"><div class="message-label">${message.role === 'user' ? '你' : 'Codex · 本地演示'}</div><p>${escapeHtml(message.text).replace(/\n/g, '<br>')}</p></div></article>`; }
function renderThread() {
  const thread = current();
  element('threadTitle').textContent = thread.title;
  element('projectName').textContent = thread.project;
  element('threadContent').innerHTML = (thread.demo ? demoMarkup : thread.messages.length ? '<div class="thread-meta">本地演示线程 · 不连接模型</div>' : '<div class="new-welcome"><span class="welcome-symbol">⌘</span><h1>接下来，做点什么？</h1><p>描述你的想法，开始一个新线程。</p><span>Mobius 前端 <span aria-hidden="true">⌄</span></span></div>') + thread.messages.map(messageMarkup).join('');
  renderThreads(); renderInspector();
}
function selectThread(id) { if (!threads.some((thread) => thread.id === id)) return; state.active = id; renderThread(); element('leftSidebar').classList.remove('open'); }
function newThread() { const thread = { id: crypto.randomUUID(), title: '新线程', project: current().project, messages: [] }; threads.unshift(thread); state.active = thread.id; state.attachments = []; element('messageInput').value = ''; renderAttachments(); renderThread(); persist(); element('messageInput').focus(); }
function diffMarkup(file) { return `<div class="selected-file"><div class="selected-file-head"><span class="file-icon ${file.type}">${file.type === 'js' ? 'JS' : '#'}</span><strong>${file.name}</strong><span class="diff-add">+${file.add}</span><span class="diff-remove">−${file.remove}</span></div><div class="mini-diff">${file.lines.map((line, index) => `<div class="mini-line ${line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : ''}"><span>${index + 1}</span><b>${escapeHtml(line)}</b></div>`).join('')}</div></div>`; }
function renderInspector() {
  document.querySelectorAll('.inspector-tab').forEach((button) => { button.classList.toggle('active', button.dataset.tab === state.tab); button.setAttribute('aria-selected', String(button.dataset.tab === state.tab)); });
  const body = element('inspectorBody');
  if (state.tab === 'details') {
    body.innerHTML = `<h3>线程详情</h3><p class="inspector-description">当前工作区的本地预览信息</p><dl class="detail-list"><dt>线程</dt><dd>${escapeHtml(current().title)}</dd><dt>项目</dt><dd>${escapeHtml(current().project)}</dd><dt>运行位置</dt><dd>${state.environment}</dd><dt>模式</dt><dd>${state.mode}</dd><dt>模型连接</dt><dd>未连接 · 前端演示</dd><dt>分支</dt><dd>main（示例）</dd></dl><h3>活动记录</h3><ol class="activity-list"><li>创建本地工作区预览</li><li>载入三个演示文件</li><li>准备就绪，等待输入</li></ol><div class="demo-notice">所有文件、用量和状态均为演示数据。不会执行命令、提交 Git 或调用模型。</div>`;
    return;
  }
  const isReview = state.tab === 'review';
  body.innerHTML = `<div class="review-summary"><div><strong>${isReview ? '3 个文件已修改' : '工作区文件'}</strong><span>${isReview ? '未提交的变更 · 演示' : 'frontend /'}</span></div><button class="review-action" data-action="all-diffs">${isReview ? '展开全部' : '预览全部'}</button></div>${isReview ? '<div class="diff-stat"><span class="diff-add">+128</span><span class="diff-remove">−24</span><span class="diff-track"><i></i></span></div>' : '<div class="folder-label">⌄ &nbsp; frontend</div>'}<div class="file-tree">${files.map((file, index) => `<button class="file-row ${state.file === index ? 'selected' : ''}" data-file-index="${index}"><span class="file-icon ${file.type}">${file.type === 'js' ? 'JS' : '#'}</span><span class="file-name">${file.name}</span><span class="file-change">${isReview ? '+' + file.add : file.type.toUpperCase()}</span></button>`).join('')}</div>${isReview ? diffMarkup(files[state.file]) : `<div class="selected-file"><div class="selected-file-head"><strong>${files[state.file].name}</strong></div><pre class="file-source">${escapeHtml(files[state.file].lines.filter((line) => !line.startsWith('-')).map((line) => line.replace(/^\+ /, '')).join('\n'))}</pre></div>`}<div class="right-bottom"><div class="detail-row"><span>环境</span><strong>${state.environment} · 演示</strong></div><div class="detail-row"><span>分支</span><strong>main</strong></div><div class="detail-row"><span>状态</span><strong>预览就绪</strong></div></div>`;
}
function renderAttachments() {
  let tray = element('attachmentTray');
  if (!tray) { tray = document.createElement('div'); tray.id = 'attachmentTray'; element('composer').prepend(tray); }
  tray.innerHTML = state.attachments.map((name, index) => `<button class="attachment-pill" type="button" data-remove-attachment="${index}">${escapeHtml(name)} ×</button>`).join('');
}
function resizeInput() { const input = element('messageInput'); input.style.height = 'auto'; input.style.height = `${Math.min(148, Math.max(44, input.scrollHeight))}px`; }
function submit() {
  const text = element('messageInput').value.trim();
  if (!text && !state.attachments.length) return;
  const thread = current();
  const message = [text, state.attachments.length ? `附件（仅本地名称）：${state.attachments.join('、')}` : ''].filter(Boolean).join('\n');
  if (!thread.demo && !thread.messages.length) thread.title = (text || state.attachments[0]).slice(0, 28);
  thread.messages.push({ role: 'user', text: message }, { role: 'assistant', text: '已收到。这是纯前端演示，消息保存在当前浏览器中，不会调用模型或修改项目文件。你可以继续查看右侧的文件与 Review 示例。' });
  element('messageInput').value = ''; state.attachments = []; renderAttachments(); resizeInput(); renderThread(); persist();
  element('threadContent').scrollTop = element('threadContent').scrollHeight;
}
function chooseSetting(title, options, callback) { openDialog(`<h2>${title}</h2><div class="choice-list">${options.map((option, index) => `<button data-choice="${index}">${escapeHtml(option)}<span>›</span></button>`).join('')}</div>`); element('dialogContent').querySelectorAll('[data-choice]').forEach((button) => button.onclick = () => { callback(options[Number(button.dataset.choice)]); element('dialog').close(); }); }
element('threadList').onclick = (event) => { const button = event.target.closest('[data-thread]'); if (button) selectThread(button.dataset.thread); };
element('inspectorBody').onclick = (event) => {
  const file = event.target.closest('[data-file-index]');
  if (file) { state.file = Number(file.dataset.fileIndex); renderInspector(); }
  if (event.target.closest('[data-action="all-diffs"]')) openDialog('<h2>所有变更 <small>演示</small></h2>' + files.map(diffMarkup).join(''));
};
document.querySelectorAll('.inspector-tab').forEach((button) => button.onclick = () => { state.tab = button.dataset.tab; renderInspector(); });
document.querySelectorAll('[data-prompt]').forEach((button) => button.onclick = () => { element('messageInput').value = button.dataset.prompt; resizeInput(); element('messageInput').focus(); });
element('composer').onclick = (event) => { const button = event.target.closest('[data-remove-attachment]'); if (button) { state.attachments.splice(Number(button.dataset.removeAttachment), 1); renderAttachments(); } };
element('newThread').onclick = newThread;
element('searchThreads').onclick = () => {
  openDialog('<h2>搜索线程</h2><input class="search-input" id="threadSearch" placeholder="搜索标题或项目…" aria-label="搜索线程"><div id="searchResults" class="choice-list"></div>');
  const search = element('threadSearch');
  const renderResults = () => { element('searchResults').innerHTML = threads.filter((thread) => `${thread.title} ${thread.project}`.toLowerCase().includes(search.value.toLowerCase())).map((thread) => `<button data-search-id="${escapeHtml(thread.id)}">${escapeHtml(thread.title)}<small>${escapeHtml(thread.project)}</small></button>`).join('') || '<p>没有匹配的线程</p>'; };
  search.oninput = renderResults;
  element('searchResults').onclick = (event) => { const button = event.target.closest('[data-search-id]'); if (button) { selectThread(button.dataset.searchId); element('dialog').close(); } };
  renderResults(); search.focus();
};
document.querySelectorAll('[data-section]').forEach((button) => button.onclick = () => {
  if (button.dataset.section === 'threads') { renderThread(); return; }
  if (button.dataset.section === 'projects') chooseSetting('项目', [...new Set(threads.map((thread) => thread.project))], (project) => selectThread(threads.find((thread) => thread.project === project).id));
  else openDialog('<h2>自动化</h2><p class="inspector-description">本地 UI 演示，不创建真实定时任务。</p><div class="automation-card"><span>◷</span><div><strong>每日代码回顾</strong><p>每个工作日 · 上午 9:00</p></div><label><input type="checkbox" aria-label="启用演示自动化"> 启用</label></div><div class="automation-card"><span>◷</span><div><strong>整理本周变更</strong><p>每周五 · 下午 5:00</p></div><label><input type="checkbox" aria-label="启用每周演示自动化"> 启用</label></div>');
});
element('workspaceButton').onclick = () => chooseSetting('工作区', ['个人工作区', '设计工作区'], (workspace) => document.querySelector('.workspace-name').textContent = workspace);
element('modeButton').onclick = () => chooseSetting('工作模式', ['执行', '规划', '提问'], (mode) => { state.mode = mode; element('modeButton').querySelector('span').textContent = mode; renderInspector(); });
element('environmentButton').onclick = () => chooseSetting('环境 · 仅演示', ['本地环境', 'Worktree'], (environment) => { state.environment = environment; element('environmentButton').querySelector('span').textContent = environment; renderInspector(); });
element('settingsButton').onclick = () => {
  openDialog('<h2>设置</h2><p class="inspector-description">显示偏好 · 仅作用于此扩展</p><label class="setting-row">外观<select id="themeSelect"><option value="light">浅色</option><option value="dark">深色</option></select></label><label class="setting-row">文字大小<select id="fontSelect"><option value="14">标准 · 14px</option><option value="16">较大 · 16px</option></select></label>');
  element('themeSelect').value = document.documentElement.dataset.theme || 'light';
  element('themeSelect').onchange = (event) => document.documentElement.dataset.theme = event.target.value;
  element('fontSelect').onchange = (event) => document.documentElement.style.setProperty('--chat-font', event.target.value + 'px');
};
element('accountButton').onclick = () => openDialog('<h2>演示账户</h2><p>Alex Chen · Pro 方案（示例）</p><p class="inspector-description">本页面不读取登录身份、订阅或真实用量。</p>');
element('centerMore').onclick = () => chooseSetting('线程操作', ['重命名线程', '新建线程'], (action) => {
  if (action === '新建线程') { newThread(); return; }
  setTimeout(() => { openDialog(`<h2>重命名线程</h2><form id="renameForm"><input class="search-input" id="renameInput" aria-label="线程名称" maxlength="80" value="${escapeHtml(current().title)}" required><button class="primary-action">保存</button></form>`); element('renameForm').onsubmit = (event) => { event.preventDefault(); const title = element('renameInput').value.trim(); if (!title) return; current().title = title; persist(); renderThread(); element('dialog').close(); }; }, 0);
});
element('shareButton').onclick = () => {
  const thread = current();
  const text = `# ${thread.title}\n\n本地演示线程\n\n` + thread.messages.map((message) => `## ${message.role}\n${message.text}`).join('\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'codex-demo-thread.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function toggleInspector() { document.querySelector('.app-shell').classList.toggle('inspector-closed'); document.querySelector('.app-shell').classList.toggle('inspector-open-mobile'); }
element('closeInspector').onclick = () => { document.querySelector('.app-shell').classList.add('inspector-closed'); document.querySelector('.app-shell').classList.remove('inspector-open-mobile'); };
element('toggleInspector').onclick = toggleInspector;
element('openSidebar').onclick = () => element('leftSidebar').classList.add('open');
element('closeSidebar').onclick = () => element('leftSidebar').classList.remove('open');
element('attachButton').onclick = () => element('fileInput').click();
element('fileInput').onchange = () => { state.attachments.push(...Array.from(element('fileInput').files).map((file) => file.name)); element('fileInput').value = ''; renderAttachments(); };
element('composer').onsubmit = (event) => { event.preventDefault(); submit(); };
element('messageInput').oninput = resizeInput;
element('messageInput').onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); } };
document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (element('dialog').open) element('dialog').close(); newThread(); } if (event.key === 'Escape') { element('leftSidebar').classList.remove('open'); document.querySelector('.app-shell').classList.remove('inspector-open-mobile'); } });
document.querySelector('.usage-card').innerHTML = '<div class="usage-top"><span>工作区预览</span><span>DEMO</span></div><div class="usage-bar"><i></i></div><small>纯前端 · 不消耗模型用量</small>';
renderThread(); resizeInput();
