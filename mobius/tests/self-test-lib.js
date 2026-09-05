'use strict';
const crypto = require('crypto');

function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mintSystemToken() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('mintSystemToken: env JWT_SECRET 未设置');
  const now = Math.floor(Date.now() / 1000);
  const payload = { id: 'system', display_name: 'Self-Test', role: 'admin', work_dir: '/__extension_system__', iat: now, exp: now + 600 };
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64u(sig)}`;
}

function request(method, url, { token, timeoutMs, body } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers, signal: ctrl.signal };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  return fetch(url, init).finally(() => clearTimeout(to));
}

async function getJson(base, path, { token, ok, timeoutMs }) {
  const r = await request('GET', `${base}${path}`, { token, timeoutMs });
  if (ok !== undefined && r.status !== ok) throw new Error(`HTTP ${r.status} (期望 ${ok})`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

async function runSelfTest(opts = {}) {
  const base = opts.base || `http://127.0.0.1:${process.env.MOBIUS_PORT || '33316'}`;
  const token = opts.token || mintSystemToken();
  const doWrite = !!opts.doWrite;
  const timeoutMs = opts.timeoutMs || 8000;
  const onCheck = typeof opts.onCheck === 'function' ? opts.onCheck : null;
  const t0 = Date.now();

  let pass = 0, fail = 0, skipped = 0;
  const results = [];

  async function check(name, fn) {
    const s = Date.now();
    try { await fn(); pass++; results.push({ name, ok: true, ms: Date.now() - s }); if (onCheck) onCheck(name, true, Date.now() - s, null, false); }
    catch (e) { fail++; const err = (e && e.message) ? e.message : String(e); results.push({ name, ok: false, ms: Date.now() - s, error: err }); if (onCheck) onCheck(name, false, Date.now() - s, err, false); }
  }
  function skip(name, reason) { skipped++; results.push({ name, ok: null, skipped: true, reason }); if (onCheck) onCheck(name, null, 0, null, true, reason); }
  const G = (path, o = {}) => getJson(base, path, { token, ok: 200, timeoutMs, ...o });

  // —— 健康 ——
  await check('健康 GET /api/health', async () => { const d = await G('/api/health', { token: false }); if (!d || d.status !== 'ok') throw new Error('status!=ok'); });
  await check('健康 GET /api/v2/health', async () => { const d = await G('/api/v2/health', { token: false }); if (!d.version) throw new Error('无 version'); });

  // —— 鉴权 ——
  await check('鉴权 GET /api/auth/config', async () => { const d = await G('/api/auth/config', { token: false }); if (!('password_required' in d)) throw new Error('无 password_required'); });
  await check('鉴权 GET /api/auth/me', async () => { const d = await G('/api/auth/me'); if (d.id !== 'system') throw new Error(`id=${d.id} != system`); });

  // —— 核心读 ——
  await check('读 GET /api/projects', async () => { const d = await G('/api/projects'); if (!Array.isArray(d)) throw new Error('非数组'); });
  await check('读 GET /api/sessions/model-options', async () => { const d = await G('/api/sessions/model-options'); if (!Array.isArray(d) || d.length === 0) throw new Error('模型列表空'); });
  await check('读 GET /api/tasks/recent', async () => { const d = await G('/api/tasks/recent?limit=10'); if (!Array.isArray(d)) throw new Error('非数组'); });
  await check('读 GET /api/extensions', async () => { const d = await G('/api/extensions'); if (!d || !Array.isArray(d.extensions)) throw new Error('无 extensions[]'); });

  // —— 搜索 ——
  await check('搜索 GET /api/search?q=test', async () => {
    const d = await G('/api/search?q=test&limit=5');
    if (typeof d !== 'object' || !d) throw new Error('非对象');
    if (!Array.isArray(d.results)) throw new Error('无 results[]');
  });

  // —— 群聊/会话 ——
  await check('群聊 GET /api/conversations', async () => {
    const d = await G('/api/conversations');
    if (!d || !Array.isArray(d.conversations)) throw new Error('无 conversations[]');
  });

  // —— 语音 ——
  await check('语音 GET /api/assistant/tts/voices', async () => { const d = await G('/api/assistant/tts/voices'); if (typeof d.configured !== 'boolean') throw new Error('无 configured'); });

  // —— 文件上传 (轻量 text/plain) ——
  if (doWrite) {
    await check('上传 POST /api/upload (text/plain)', async () => {
      const boundary = `--selftest-${Date.now()}`;
      const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="selftest.txt"',
        'Content-Type: text/plain',
        '', 'mobius-self-test',
        `--${boundary}--`, ''
      ].join('\r\n');
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(`${base}/api/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body,
          signal: ctrl.signal,
        });
        if (r.status !== 200 && r.status !== 201) throw new Error(`HTTP ${r.status}`);
        const d = await r.json().catch(() => ({}));
        if (!d.file && !d.url && !d.path && !d.id) throw new Error('响应无 file/url/path');
      } finally { clearTimeout(to); }
    });
  }

  // —— 2026-08-25 新增端点冒烟(只读) ——
  await check('会话 GET /api/tasks/recent', async () => {
    const r = await G('/api/tasks/recent?limit=5');
    if (!Array.isArray(r)) throw new Error('非数组');
  });
  await check('耗时 GET /api/sessions/:id/turns', async () => {
    const projects = await G('/api/projects');
    const pid = (Array.isArray(projects) && projects.length > 0 && projects[0].id) ? projects[0].id : null;
    if (!pid) throw new Error('无可用 project');
    const issues = await G(`/api/projects/${pid}/issues`);
    const iid = (Array.isArray(issues) && issues.length > 0 && issues[0].id) ? issues[0].id : null;
    if (!iid) throw new Error('无可用 issue');
    const sessions = await G(`/api/issues/${iid}/sessions/`);
    const sid = (Array.isArray(sessions) && sessions.length > 0 && sessions[0].session_id) ? sessions[0].session_id : null;
    if (!sid) throw new Error('无可用 session');
    await G(`/api/sessions/${sid}/turns`);
    await G(`/api/sessions/${sid}/time-consume-waterfall`);
  });
  // —— SSE 流 (连接到第一个事件) ——
  await check('SSE GET /api/sessions/:id/events (首事件)', async () => {
    // 先获取任意 sessionId: projects → issues → sessions
    const projects = await G('/api/projects');
    const pid = (Array.isArray(projects) && projects.length > 0 && projects[0].id) ? projects[0].id : null;
    if (!pid) throw new Error('无可用 project');
    const issues = await G(`/api/projects/${pid}/issues`);
    const iid = (Array.isArray(issues) && issues.length > 0 && issues[0].id) ? issues[0].id : null;
    if (!iid) throw new Error('无可用 issue');
    const issueSessions = await G(`/api/issues/${iid}/sessions`);
    const sid = (Array.isArray(issueSessions) && issueSessions.length > 0 && issueSessions[0].session_id)
      ? issueSessions[0].session_id : null;
    if (!sid) throw new Error('无可用 session');
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs + 5000);
    try {
      const r = await fetch(`${base}/api/sessions/${sid}/events?token=${encodeURIComponent(token)}`, {
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal,
      });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('text/event-stream')) throw new Error(`非 SSE: ${ct}`);
      // 读取第一个非注释事件
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', events = 0;
      while (events < 2) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('event:') || line.startsWith('data:')) events++;
        }
        if (events > 0) break;
      }
      reader.cancel();
      if (events === 0) throw new Error('无 SSE 事件');
    } finally { clearTimeout(to); }
  });

  if (doWrite) {
    let mid = null;
    await check('写 POST /api/memories (建临时)', async () => { const r = await request('POST', `${base}/api/memories`, { token, timeoutMs, body: { name: `__selftest_${Date.now()}__`, body: '自检临时, 即删' } }); const d = await r.json(); mid = d.id || (d.memory && d.memory.id); if (!mid) throw new Error('无 id'); });
    if (mid) { await check('写 DELETE /api/memories/:id', async () => { await request('DELETE', `${base}/api/memories/${mid}`, { token, timeoutMs }); }); }
  } else { skip('写往返(建/列/删 memory)', 'MOBIUS_SELF_TEST_WRITE 未开'); }

  return { startedAt: new Date().toISOString(), durationMs: Date.now() - t0, base, pass, fail, skipped, results };
}
module.exports = { mintSystemToken, runSelfTest };
