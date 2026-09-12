const STORAGE_KEY = 'codex-desktop-replica-v1';
const $ = (id) => document.getElementById(id);
const els = { sidebar: $('sidebar'), workspace: $('workspace'), recentList: $('recentList'), welcome: $('welcome'), thread: $('messageThread'), contextTitle: $('contextTitle'), input: $('messageInput'), composer: $('composer'), send: $('sendButton'), toast: $('toast'), fileInput: $('fileInput') };
const seed = [{ id: 'welcome', title: 'Welcome to Codex', updated: 'Today', messages: [{ role: 'assistant', text: 'Hi Alex. What would you like to work on?' }] }, { id: 'design-system', title: 'Refine the design system', updated: 'Today', messages: [] }, { id: 'launch-notes', title: 'Draft launch notes', updated: 'Yesterday', messages: [] }];
let state = loadState();

function loadState() { try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (value?.chats) return value; } catch {} return { activeId: null, chats: seed }; }
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function activeChat() { return state.chats.find((chat) => chat.id === state.activeId); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
function iconMarkup(role) { return role === 'user' ? '<span class="message-avatar user-avatar">A</span>' : '<span class="message-avatar assistant-avatar">C</span>'; }
function renderRecents() {
  const groups = ['Today', 'Yesterday'];
  els.recentList.innerHTML = groups.map((group) => { const chats = state.chats.filter((chat) => chat.updated === group); if (!chats.length) return ''; return `<div class="recent-group"><div class="recent-label">${group}</div>${chats.map((chat) => `<button class="recent-chat ${chat.id === state.activeId ? 'selected' : ''}" data-chat-id="${chat.id}" type="button"><span class="chat-title">${escapeHtml(chat.title)}</span><span class="chat-more">•••</span></button>`).join('')}</div>`; }).join('');
  els.recentList.querySelectorAll('[data-chat-id]').forEach((button) => button.addEventListener('click', () => selectChat(button.dataset.chatId)));
}
function renderThread() {
  const chat = activeChat();
  els.contextTitle.textContent = chat?.title || 'New chat';
  if (!chat || !chat.messages.length) { els.welcome.hidden = false; els.thread.hidden = true; els.thread.innerHTML = ''; return; }
  els.welcome.hidden = true; els.thread.hidden = false;
  els.thread.innerHTML = chat.messages.map((message) => `<article class="message ${message.role}">${iconMarkup(message.role)}<div class="message-body"><div class="message-author">${message.role === 'user' ? 'You' : 'Codex'}</div><div class="message-text">${escapeHtml(message.text).replace(/\n/g, '<br>')}</div></div></article>`).join('');
  els.thread.scrollTop = els.thread.scrollHeight;
}
function render() { renderRecents(); renderThread(); }
function selectChat(id) { state.activeId = id; saveState(); render(); els.input.focus(); }
function createChat() { const id = `chat-${Date.now()}`; state.chats.unshift({ id, title: 'New chat', updated: 'Today', messages: [] }); state.activeId = id; saveState(); render(); els.input.focus(); }
function showToast(message) { els.toast.textContent = message; els.toast.classList.add('visible'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => els.toast.classList.remove('visible'), 2200); }
function resizeInput() { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(180, Math.max(48, els.input.scrollHeight))}px`; }
function assistantReply(text) { const lower = text.toLowerCase(); if (lower.includes('hello') || lower.includes('你好')) return 'Hello! I’m ready when you are. Tell me what you’re building.'; if (lower.includes('design') || lower.includes('设计')) return 'I can help shape the structure, visual language, and interaction details. What are we designing?'; return 'I’m in preview mode, so this response is local to the interface. Try asking me about a design, a code change, or a project idea.'; }
function submitMessage() { const text = els.input.value.trim(); if (!text) return; let chat = activeChat(); if (!chat) { createChat(); chat = activeChat(); } if (chat.title === 'New chat') chat.title = text.slice(0, 34); chat.messages.push({ role: 'user', text }); els.input.value = ''; resizeInput(); render(); saveState(); els.send.disabled = true; setTimeout(() => { chat.messages.push({ role: 'assistant', text: assistantReply(text) }); els.send.disabled = false; saveState(); render(); }, 520); }

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active')); button.classList.add('active'); showToast(`${button.textContent.trim()} is coming soon`); }));
$('newChat').addEventListener('click', createChat); $('brandButton').addEventListener('click', () => showToast('Personal workspace')); $('settingsButton').addEventListener('click', () => showToast('Settings is coming soon')); $('profileButton').addEventListener('click', () => showToast('Personal workspace')); $('shareButton').addEventListener('click', () => showToast('Share link copied')); $('moreButton').addEventListener('click', () => showToast('More options')); $('modeButton').addEventListener('click', () => showToast('Ask mode selected')); $('searchChats').addEventListener('click', () => showToast('Search is coming soon')); $('attachButton').addEventListener('click', () => els.fileInput.click()); els.fileInput.addEventListener('change', () => { if (els.fileInput.files.length) showToast(`${els.fileInput.files.length} file${els.fileInput.files.length > 1 ? 's' : ''} attached`); }); $('openSidebar').addEventListener('click', () => els.sidebar.classList.add('open')); $('closeSidebar').addEventListener('click', () => els.sidebar.classList.remove('open')); els.composer.addEventListener('submit', (event) => { event.preventDefault(); submitMessage(); }); els.input.addEventListener('input', resizeInput); els.input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitMessage(); } });
window.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); createChat(); } });
render(); resizeInput();
