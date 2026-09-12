import { extCall, extName } from '/extension/_sdk/ext.js';

const identityEl = document.getElementById('identity');
const noteInput = document.getElementById('noteInput');
const saveBtn = document.getElementById('saveBtn');
const loadBtn = document.getElementById('loadBtn');
const statusEl = document.getElementById('status');

function setStatus(text, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

async function refreshIdentity() {
  try {
    const data = await extCall({ action: 'whoami' });
    identityEl.textContent = data.display_name || data.username || '-';
    document.getElementById('extensionName').textContent = extName();
  } catch (err) {
    setStatus(err.message || '加载用户信息失败', true);
  }
}

async function saveNote() {
  try {
    await extCall({ action: 'save_note', note: noteInput.value });
    setStatus('已保存');
  } catch (err) {
    setStatus(err.message || '保存失败', true);
  }
}

async function loadNote() {
  try {
    const data = await extCall({ action: 'load_note' });
    noteInput.value = data.note || '';
    setStatus('已读取');
  } catch (err) {
    setStatus(err.message || '读取失败', true);
  }
}

saveBtn.addEventListener('click', saveNote);
loadBtn.addEventListener('click', loadNote);
refreshIdentity();
