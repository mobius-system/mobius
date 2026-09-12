const $ = (id) => document.getElementById(id);
const state = { activeThread: 'workbench', activeTab: 'review', files: ['frontend/index.html', 'frontend/main.js', 'frontend/styles.css'] };
const threads = [
  { id: 'workbench', title: '重构三栏工作台', project: 'Mobius 前端', time: '刚刚', tone: 'blue' },
  { id: 'redaction', title: '修复输入框模糊', project: 'Mobius 前端', time: '今天', tone: 'violet' },
  { id: 'ports', title: '端口预览栏交互', project: '开发工具', time: '昨天', tone: 'orange' },
  { id: 'desktop', title: '桌面端顶栏拖拽', project: 'Mobius Desktop', time: '周二', tone: 'green' },
  { id: 'extension', title: '设计师之眼拓展', project: '实验项目', time: '周一', tone: 'pink' },
];
const fileContent = { 'frontend/index.html': ['18', '19', '20', '21'], 'frontend/main.js': ['42', '43', '44', '45'], 'frontend/styles.css': ['88', '89', '90', '91'] };
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
function renderThreads() { $('threadList').innerHTML = threads.map((thread) => `<button class="thread-row ${thread.id === state.activeThread ? 'active' : ''}" data-thread="${thread.id}" type="button"><span class="thread-mark ${thread.tone}"></span><span class="thread-copy"><strong>${escapeHtml(thread.title)}</strong><small>${escapeHtml(thread.project)}</small></span><time>${thread.time}</time></button>`).join(''); document.querySelectorAll('[data-thread]').forEach((button) => button.addEventListener('click', () => selectThread(button.dataset.thread))); }
function selectThread(id) { const thread = threads.find((item) => item.id === id); if (!thread) return; state.activeThread = id; $('threadTitle').textContent = thread.title; $('projectName').textContent = thread.project; renderThreads(); showToast(`已切换到「${thread.title}」`); }
function showToast(text) { const toast = $('toast'); toast.textContent = text; toast.classList.add('visible'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('visible'), 2200); }
function autoResize() { const input = $('messageInput'); input.style.height = 'auto'; input.style.height = `${Math.min(148, Math.max(44, input.scrollHeight))}px`; }
function appendMessage(text) { const content = $('threadContent'); const article = document.createElement('article'); article.className = 'message user-message'; article.innerHTML = `<div class="message-avatar user-avatar">A</div><div class="message-copy"><div class="message-label">你</div><p>${escapeHtml(text).replace(/\n/g, '<br>')}</p></div>`; content.insertBefore(article, $('composer').parentElement); $('threadView').scrollTop = $('threadView').scrollHeight; }
function updateInspector(tab) { state.activeTab = tab; document.querySelectorAll('.inspector-tab').forEach((item) => item.classList.toggle('active', item.dataset.tab === tab)); const body = $('inspectorBody'); if (tab === 'files') { body.querySelector('.review-summary').innerHTML = '<div><strong>工作区文件</strong><span>3 个前端文件</span></div><button class="review-action" type="button">刷新</button>'; body.querySelector('.diff-stat').style.display = 'none'; showToast('文件面板已打开'); } else if (tab === 'details') { body.querySelector('.review-summary').innerHTML = '<div><strong>线程详情</strong><span>本地演示数据</span></div><button class="review-action" type="button">复制</button>'; body.querySelector('.diff-stat').style.display = 'none'; showToast('详情面板已打开'); } else { body.querySelector('.review-summary').innerHTML = '<div><strong>3 个文件已修改</strong><span>工作区变更</span></div><button class="review-action" type="button">查看全部</button>'; body.querySelector('.diff-stat').style.display = 'flex'; } }
function selectFile(file) { document.querySelectorAll('.file-row').forEach((row) => row.classList.toggle('selected', row.dataset.file === file)); const selected = $('selectedFile'); selected.querySelector('strong').textContent = file.split('/').pop(); const lines = fileContent[file] || fileContent['frontend/index.html']; selected.querySelector('.mini-diff').innerHTML = lines.map((line, index) => `<div class="mini-line ${index === 1 || index === 2 ? 'add' : ''}"><span>${line}</span><b>${index === 1 || index === 2 ? '+ ' : ''}${index === 1 ? 'grid-template-columns: 248px 1fr 312px;' : index === 2 ? 'gap: 0;' : index === 0 ? 'const layout = createWorkspace();' : '}'}</b></div>`).join(''); }
document.addEventListener('click', (event) => { const prompt = event.target.closest('[data-prompt]'); if (prompt) { $('messageInput').value = prompt.dataset.prompt; autoResize(); $('messageInput').focus(); } });
document.querySelectorAll('.nav-row[data-section]').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.nav-row[data-section]').forEach((item) => item.classList.remove('active')); button.classList.add('active'); showToast(`${button.textContent.trim()}视图已切换`); }));
document.querySelectorAll('.inspector-tab').forEach((button) => button.addEventListener('click', () => updateInspector(button.dataset.tab)));
document.querySelectorAll('.file-row').forEach((button) => button.addEventListener('click', () => selectFile(button.dataset.file)));
$('newThread').addEventListener('click', () => { selectThread('workbench'); $('messageInput').value = ''; $('messageInput').focus(); showToast('已创建新线程'); });
$('workspaceButton').addEventListener('click', () => showToast('个人工作区'));
$('settingsButton').addEventListener('click', () => showToast('设置面板即将打开'));
$('accountButton').addEventListener('click', () => showToast('账户菜单'));
$('shareButton').addEventListener('click', () => showToast('分享链接已复制'));
$('centerMore').addEventListener('click', () => showToast('更多线程操作'));
$('reviewAction').addEventListener('click', () => showToast('已展示全部变更'));
$('searchThreads').addEventListener('click', () => showToast('搜索线程'));
$('modeButton').addEventListener('click', () => showToast('当前模式：执行'));
$('environmentButton').addEventListener('click', () => showToast('本地环境已连接'));
$('closeInspector').addEventListener('click', () => $('rightSidebar').classList.toggle('collapsed'));
$('openSidebar').addEventListener('click', () => $('leftSidebar').classList.add('open'));
$('closeSidebar').addEventListener('click', () => $('leftSidebar').classList.remove('open'));
$('attachButton').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => { if ($('fileInput').files.length) showToast(`已添加 ${$('fileInput').files.length} 个文件`); });
$('composer').addEventListener('submit', (event) => { event.preventDefault(); const input = $('messageInput'); const text = input.value.trim(); if (!text) return; appendMessage(text); input.value = ''; autoResize(); showToast('消息已加入线程'); });
$('messageInput').addEventListener('input', autoResize);
$('messageInput').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('composer').requestSubmit(); } });
window.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('newThread').click(); } });
renderThreads(); autoResize();
