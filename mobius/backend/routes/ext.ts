/**
 * routes/ext.ts — 拓展系统的三入口路由集合.
 *
 *   metaRouter   → /api/extensions           列表 / 单 manifest / build-status / admin reload
 *   invokeRouter → /api/ext                  统一调用入口 (POST), worker_thread 跑 handler
 *   staticRouter → /extension/<name>/*       前端资源 + 按需 vite build + loading 页 + 共用 SDK
 *
 * 三个 router 分挂在不同前缀, 但共享 extension-registry 单例. server.js:
 *   app.use('/api/extensions', ext.metaRouter);
 *   app.use('/api/ext',        ext.invokeRouter);
 *   app.use('/extension',      ext.staticRouter);
 */
import express from 'express';
// @ts-ignore — multer 无 @types
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { auth, adminAuth, authOrQuery } from '../middleware/auth';
import {
  EXTENSION_HANDLER_MAX_PAYLOAD_BYTES,
  EXTENSION_INVOKE_RATE_PER_SEC,
} from '../config';
// @ts-ignore — service 仍是 .js
import * as registry from '../services/extension-registry';
// @ts-ignore — service 仍是 .js
import { invokeHandler } from '../services/extension-invoker';
// @ts-ignore — service 仍是 .js
import * as buildPipeline from '../services/extension-build-pipeline';
// @ts-ignore — service 仍是 .js
import { runSessionMessage } from '../services/session-message-runner';

// ===== meta router =====
const metaRouter = express.Router();
const upload = multer({
  dest: path.join(os.tmpdir(), 'mobius-extension-upload'),
  limits: { fileSize: 50 * 1024 * 1024 },
});

function safeUserSegment(username: unknown): string {
  return String(username || 'unknown').replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 120) || 'unknown';
}

function safeFileName(name: unknown): string {
  const base = path.basename(String(name || 'source.bin')).replace(/[^\w一-鿿 .@()+,-]/g, '_').trim();
  return (base || 'source.bin').slice(0, 180);
}

function safeResolveUnder(root: string, ...parts: string[]): string | null {
  const base = path.resolve(root);
  const abs = path.resolve(base, ...parts);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

// 拓展列表 (公开给已登录用户; 拓展项目卡片在前端项目页就要它).
metaRouter.get('/', auth, (req: express.Request, res: express.Response) => {
  res.json({
    extensions: registry.getAll(),
    errors: registry.getLastReloadErrors(),
  });
});

// 单个拓展 manifest (前端 loading 页轮询会用)
metaRouter.get('/:name', auth, (req: express.Request, res: express.Response) => {
  const entry = registry.get(req.params.name);
  if (!entry) {
    res.status(404).json({ error: '未找到该拓展' });
    return;
  }
  res.json({
    name: entry.name,
    display_name: entry.display_name,
    description: entry.description,
    version: entry.version,
    icon_url: entry.icon_url,
    entry_url: `/extension/${entry.name}/`,
  });
});

// 编译状态 (loading 页轮询)
metaRouter.get('/:name/build-status', auth, (req: express.Request, res: express.Response) => {
  const entry = registry.get(req.params.name);
  if (!entry) {
    res.status(404).json({ error: '未找到该拓展' });
    return;
  }
  res.json(buildPipeline.getStatus(entry));
});

metaRouter.post('/:name/upload', auth, upload.single('file'), (req: express.Request, res: express.Response) => {
  const entry = registry.get(req.params.name);
  const file = (req as any).file as { path: string; originalname: string; size: number; mimetype?: string } | undefined;
  if (!entry) {
    if (file) try { fs.unlinkSync(file.path); } catch { /* noop */ }
    res.status(404).json({ ok: false, error: '未找到该拓展' });
    return;
  }
  if (!file) {
    res.status(400).json({ ok: false, error: 'No file' });
    return;
  }

  const user = (req as any).user as { id: string; [k: string]: any };
  const userSegment = safeUserSegment(user.id);
  const uploadDir = safeResolveUnder(entry.data_dir, 'users', userSegment, 'uploads');
  if (!uploadDir) {
    try { fs.unlinkSync(file.path); } catch { /* noop */ }
    res.status(400).json({ ok: false, error: 'bad upload path' });
    return;
  }
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
    const originalName = safeFileName(file.originalname);
    const stampedName = `${Date.now()}-${originalName}`;
    const dest = safeResolveUnder(uploadDir, stampedName);
    if (!dest) throw new Error('bad destination');
    fs.renameSync(file.path, dest);
    res.json({
      ok: true,
      file: {
        path: dest,
        name: originalName,
        stored_name: stampedName,
        size: file.size,
        mime_type: file.mimetype || '',
      },
    });
  } catch (e) {
    try { fs.unlinkSync(file.path); } catch { /* noop */ }
    const err = e as Error;
    res.status(500).json({ ok: false, error: err.message || 'upload failed' });
  }
});

// 登录用户读取某拓展自己的用户资产。给 <img>/<video>/<a download> 使用:
// /api/extensions/<name>/user-asset/<rel-under-ext-data/users/<user>>?token=<jwt>
// 只允许当前用户目录下的媒体文件, 并复用 Range/ETag/Cache-Control 流式发送。
metaRouter.get('/:name/user-asset/*', authOrQuery, (req: express.Request, res: express.Response) => {
  const entry = registry.get(req.params.name);
  if (!entry) {
    res.status(404).send('extension not found');
    return;
  }
  const user = (req as any).user as { id: string; [k: string]: any };
  const userSegment = safeUserSegment(user.id);
  const rel = String((req.params as any)[0] || '').replace(/^\/+/, '');
  if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '')) {
    res.status(400).send('bad path');
    return;
  }
  const root = safeResolveUnder(entry.data_dir, 'users', userSegment);
  const abs = root ? safeResolveUnder(root, rel) : null;
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.status(404).send('not found');
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov', '.m4v']);
  if (!allowed.has(ext)) {
    res.status(403).send('mime not allowed');
    return;
  }
  const mime = MIME[ext];
  if (!mime) {
    res.status(403).send('mime not allowed');
    return;
  }
  res.set('content-type', mime);
  streamAssetWithRange(req, res, abs, `user-asset/${rel}`, 'private, max-age=604800, immutable');
});

// 管理员: 列出所有"被某用户隐藏的拓展项目"对.
// 路径不与 GET /:name 冲突 (express 按注册顺序, /:name 只匹配单段;
// 但 "hidden" 万一被当成扩展名匹到 /:name 也会 404, 故为稳妥起见放在前面).
// 即:实际放置在 GET /:name 注册之前的位置, 见上方 staticRouter 之前的注册顺序补丁.
metaRouter.get('/_admin/hidden', adminAuth, (_req: express.Request, res: express.Response) => {
  // Projects 仓库按需 require, 避免顶层循环依赖. TS 下用 dynamic require.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Projects } = require('../repositories/projects');
  res.json({ hidden: Projects.listHidden() });
});

// 管理员: 撤销某用户对某拓展项目的隐藏. 可见性走 mute, 故除清 project_user_hidden 行外也要 unmute.
// 不恢复彻底删除已清掉的数据.
metaRouter.post('/_admin/hidden/:projectId/:userId/restore', adminAuth, (req: express.Request, res: express.Response) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Projects } = require('../repositories/projects');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { UserProjectView } = require('../repositories/user-project-view');
  const { projectId, userId } = req.params;
  const project = Projects.findById(projectId);
  if (!project || project.kind !== 'extension') {
    res.status(404).json({ error: '未找到拓展项目' });
    return;
  }
  Projects.setHidden(projectId, userId, false);
  UserProjectView.unmute(userId, projectId);
  res.json({ ok: true });
});

// 管理员: 彻底删除某用户在某拓展项目上的全部数据 (sessions/issues/stars/whitelist), 并保持隐藏.
// 不可逆. 与"撤销隐藏"并列: 撤销隐藏=恢复卡片(留数据); 彻底删除=清数据(卡片仍隐藏).
metaRouter.post('/_admin/hidden/:projectId/:userId/purge', adminAuth, (req: express.Request, res: express.Response) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Projects } = require('../repositories/projects');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { UserProjectView } = require('../repositories/user-project-view');
  const { projectId, userId } = req.params;
  const project = Projects.findById(projectId);
  if (!project || project.kind !== 'extension') {
    res.status(404).json({ error: '未找到拓展项目' });
    return;
  }
  try {
    Projects.purgeUserExtensionData(projectId, userId);
    UserProjectView.mute(userId, projectId); // 可见性走 mute: purge 后仍保持隐藏
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// 管理员: 强制重新扫描 mobius/extension/ 并 diff DB
metaRouter.post('/reload', adminAuth, (_req: express.Request, res: express.Response) => {
  const result = registry.reload();
  res.json(result);
});

// 管理员: 强制重新编译某个拓展前端 (清掉 dist 再 build)
metaRouter.post('/:name/rebuild', adminAuth, async (req: express.Request, res: express.Response) => {
  const entry = registry.get(req.params.name);
  if (!entry) {
    res.status(404).json({ error: '未找到该拓展' });
    return;
  }
  try {
    await buildPipeline.forceRebuild(entry);
    res.json({ ok: true });
  } catch (e) {
    const err = e as Error;
    res.status(500).json({ error: err.message });
  }
});

// ===== invoke router (statless POST /api/ext) =====
const invokeRouter = express.Router();
// 单独限制 payload 大小, 配合 worker 内部的返回值大小校验.
invokeRouter.use(express.json({ limit: EXTENSION_HANDLER_MAX_PAYLOAD_BYTES }));

const POST_ACTIONS_KEY = '__mobius_post_actions';
const POST_ACTION_RESULT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

// 每用户简单令牌桶速率限制 (每秒 N 次). 内存即可, 重启丢失无所谓.
const rateMap = new Map<string, { count: number; windowStartMs: number }>(); // user_id → { count, windowStartMs }
function rateAllow(userId: string): boolean {
  const now = Date.now();
  const rec = rateMap.get(userId);
  if (!rec || now - rec.windowStartMs >= 1000) {
    rateMap.set(userId, { count: 1, windowStartMs: now });
    return true;
  }
  if (rec.count >= EXTENSION_INVOKE_RATE_PER_SEC) return false;
  rec.count += 1;
  return true;
}

async function runPostActions(value: any, req: express.Request): Promise<any> {
  if (!value || typeof value !== 'object') return value;
  const actions = Array.isArray(value[POST_ACTIONS_KEY]) ? value[POST_ACTIONS_KEY] : [];
  delete value[POST_ACTIONS_KEY];
  if (!actions.length) return value;

  const results: any[] = [];
  for (const action of actions.slice(0, 5)) {
    if (!action || action.type !== 'session_message') continue;
    const requestedResultKey = typeof action.result_key === 'string' ? action.result_key.trim() : '';
    const resultKey = POST_ACTION_RESULT_KEY_RE.test(requestedResultKey)
      ? requestedResultKey
      : '';
    try {
      const hasInputText = Object.prototype.hasOwnProperty.call(action, 'input_text');
      const started = await runSessionMessage({
        user: (req as any).user,
        sessionId: String(action.session_id || ''),
        content: String(action.content || ''),
        inputText: hasInputText ? String(action.input_text || '') : '',
        hasInputText,
        requestId: typeof action.request_id === 'string' ? action.request_id : null,
        source: typeof action.source === 'string' ? action.source : 'extension.post_action.session_message',
        logger: console,
      } as any);
      const publicResult = {
        type: action.type,
        ok: true,
        session_id: started.session_id,
        turn_number: started.turn_number,
        request_id: started.request_id,
        backend: started.backend,
      };
      results.push(publicResult);
      if (resultKey) value[resultKey] = publicResult;
      if (value.session && value.session.session_id === started.session_id) {
        value.session.started = true;
        value.session.start_result = publicResult;
      }
    } catch (e) {
      const err = e as any;
      const publicResult = {
        type: action.type,
        ok: false,
        session_id: String(action.session_id || ''),
        error: err.message || '后端启动 Session 失败',
        status: err.status || 500,
        category: err.category || 'backend',
      };
      results.push(publicResult);
      if (resultKey) value[resultKey] = publicResult;
      value.error = value.error || publicResult.error;
      if (value.session && value.session.session_id === publicResult.session_id) {
        value.session.started = false;
        value.session.start_error = publicResult.error;
      }
      if (value.project && (!action.project_id || value.project.id === action.project_id)) {
        value.project.status = 'session_failed';
        value.project.error = publicResult.error;
      }
    }
  }
  if (results.length) value.post_actions = results;
  return value;
}

invokeRouter.post('/', auth, async (req: express.Request, res: express.Response) => {
  const { extension_name, ext_main_payload } = (req.body || {}) as {
    extension_name?: string;
    ext_main_payload?: any;
  };
  if (typeof extension_name !== 'string') {
    res.status(400).json({ ok: false, error: 'extension_name 必填且必须是字符串' });
    return;
  }
  if (!registry.EXT_NAME_RE.test(extension_name)) {
    res.status(400).json({ ok: false, error: 'extension_name 非法' });
    return;
  }
  const entry = registry.get(extension_name);
  if (!entry) {
    res.status(404).json({ ok: false, error: '未找到该拓展或已被禁用' });
    return;
  }
  const user = (req as any).user as { id: string; display_name?: string; [k: string]: any };
  if (!rateAllow(user.id)) {
    res.status(429).json({ ok: false, error: '调用频率超限, 请稍后重试' });
    return;
  }
  try {
    const result = await invokeHandler({
      entry,
      username: user.id,
      display_name: user.display_name,
      ext_main_payload: ext_main_payload === undefined ? {} : ext_main_payload,
    });
    if (result.__timeout) {
      res.status(504).json({ ok: false, error: 'handler timeout (>30s)' });
      return;
    }
    if (result.__oversize) {
      res.status(502).json({ ok: false, error: 'handler 返回值过大' });
      return;
    }
    if (result.__error) {
      res.status(500).json({ ok: false, error: result.__error });
      return;
    }
    res.json(await runPostActions(result.value, req));
  } catch (e) {
    const err = e as Error;
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== static router (/extension/<name>/*) =====
const staticRouter = express.Router();

// 共用 SDK: /extension/_sdk/ext.js
// 拓展前端 import 'window.__EXT_NAME__' 跟调用 /api/ext 的最小封装.
const SDK_JS = [
  '// auto-generated by mobius extension system',
  'export async function extCall(payload) {',
  '  const token = localStorage.getItem("cc-token") || "";',
  '  const r = await fetch("/api/ext", {',
  '    method: "POST",',
  '    credentials: "include",',
  '    headers: {',
  '      "content-type": "application/json",',
  '      "authorization": token ? ("Bearer " + token) : "",',
  '    },',
  '    body: JSON.stringify({',
  '      extension_name: window.__EXT_NAME__,',
  '      ext_main_payload: payload || {},',
  '    }),',
  '  });',
  '  let data; try { data = await r.json(); } catch { data = { ok: false, error: "bad json" }; }',
  '  if (!r.ok) throw Object.assign(new Error(data.error || ("ext_call " + r.status)), { status: r.status, data });',
  '  return data;',
  '}',
  '',
  'export function extName() { return window.__EXT_NAME__; }',
  '',
  'export async function extUpload(file, extra) {',
  '  const token = localStorage.getItem("cc-token") || "";',
  '  const form = new FormData();',
  '  form.append("file", file);',
  '  if (extra && typeof extra === "object") {',
  '    for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));',
  '  }',
  '  const r = await fetch("/api/extensions/" + encodeURIComponent(window.__EXT_NAME__) + "/upload", {',
  '    method: "POST",',
  '    credentials: "include",',
  '    headers: token ? { "authorization": "Bearer " + token } : {},',
  '    body: form,',
  '  });',
  '  let data; try { data = await r.json(); } catch { data = { ok: false, error: "bad json" }; }',
  '  if (!r.ok) throw Object.assign(new Error(data.error || ("ext_upload " + r.status)), { status: r.status, data });',
  '  return data;',
  '}',
  '',
].join('\n');

staticRouter.get('/_sdk/ext.js', (_req: express.Request, res: express.Response) => {
  res.set('content-type', 'application/javascript; charset=utf-8');
  // SDK 随 mobius 部署变更, 非哈希文件名 → 1h 缓存, 到期重验.
  res.set('cache-control', 'public, max-age=3600');
  res.send(SDK_JS);
});

// /extension/<name>/        → loading 或 index.html (注入 window.__EXT_NAME__)
// /extension/<name>/<asset> → dist/<asset> (mime 白名单)
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.woff2':'font/woff2',
  '.wasm': 'application/wasm',
  '.ico':  'image/x-icon',
  '.map':  'application/json; charset=utf-8',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  '.m4v':  'video/mp4',
  '.ogg':  'video/ogg',
};

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function desktopHostBarInjection(title: string): string {
  return `
<style id="mobius-desktop-hostbar-style">
  .mobius-desktop-hostbar {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    height: 48px !important;
    z-index: 2147483000 !important;
    display: flex !important;
    align-items: stretch !important;
    gap: 8px !important;
    box-sizing: border-box !important;
    padding: 0 20px !important;
    pointer-events: none !important;
    color: #e5e7eb !important;
    background: rgba(10, 14, 22, 0.82) !important;
    border-bottom: 1px solid rgba(148, 163, 184, 0.18) !important;
    box-shadow: 0 10px 32px rgba(2, 6, 23, 0.22) !important;
    backdrop-filter: blur(16px) saturate(1.12) !important;
    -webkit-backdrop-filter: blur(16px) saturate(1.12) !important;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
    user-select: none !important;
  }
  .mobius-desktop-hostbar--mac {
    padding-left: 78px !important;
  }
  .mobius-desktop-hostbar * {
    box-sizing: border-box !important;
  }
  .mobius-desktop-hostbar__back,
  .mobius-desktop-hostbar__button {
    all: unset !important;
    pointer-events: auto !important;
    height: 48px !important;
    min-width: 38px !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 6px !important;
    border-radius: 0 !important;
    color: inherit !important;
    cursor: pointer !important;
    transition: background 0.12s ease, color 0.12s ease !important;
  }
  .mobius-desktop-hostbar__back {
    min-width: 74px !important;
    padding: 0 10px !important;
    font-size: 12px !important;
    font-weight: 600 !important;
    letter-spacing: 0 !important;
  }
  .mobius-desktop-hostbar__button {
    width: 38px !important;
  }
  .mobius-desktop-hostbar__back:hover,
  .mobius-desktop-hostbar__button:hover {
    background: rgba(148, 163, 184, 0.15) !important;
  }
  .mobius-desktop-hostbar__button--close:hover {
    background: #e81123 !important;
    color: #fff !important;
  }
  .mobius-desktop-hostbar svg {
    width: 14px !important;
    height: 14px !important;
    flex: none !important;
  }
  .mobius-desktop-hostbar__title {
    pointer-events: none !important;
    min-width: 0 !important;
    max-width: min(360px, 42vw) !important;
    align-self: center !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    white-space: nowrap !important;
    color: rgba(226, 232, 240, 0.86) !important;
    font-size: 12px !important;
    font-weight: 600 !important;
    letter-spacing: 0 !important;
  }
  .mobius-desktop-hostbar__drag {
    pointer-events: auto !important;
    flex: 1 1 auto !important;
    min-width: 24px !important;
    height: 48px !important;
    cursor: grab !important;
  }
  .mobius-desktop-hostbar--mac .mobius-desktop-hostbar__drag {
    cursor: default !important;
  }
  .mobius-desktop-hostbar__controls {
    display: inline-flex !important;
    align-items: stretch !important;
    flex: none !important;
    pointer-events: auto !important;
    margin-right: -14px !important;
  }
  .mobius-desktop-hostbar--mac .mobius-desktop-hostbar__controls {
    display: none !important;
  }
  .mobius-desktop-hostbar__max-restore {
    display: none !important;
  }
  .mobius-desktop-hostbar--maximized .mobius-desktop-hostbar__max {
    display: none !important;
  }
  .mobius-desktop-hostbar--maximized .mobius-desktop-hostbar__max-restore {
    display: block !important;
  }
  @media (max-width: 640px) {
    .mobius-desktop-hostbar {
      padding-left: 12px !important;
      padding-right: 12px !important;
    }
    .mobius-desktop-hostbar--mac {
      padding-left: 78px !important;
    }
    .mobius-desktop-hostbar__title {
      display: none !important;
    }
    .mobius-desktop-hostbar__back {
      min-width: 42px !important;
      padding: 0 8px !important;
    }
    .mobius-desktop-hostbar__back-label {
      display: none !important;
    }
  }
</style>
<script>
(() => {
  const TITLE = ${scriptJson(title)};
  const FALLBACK = '/';
  const md = window.mobiusDesktop;
  if (!md || !md.isDesktop) return;
  const isMac = /Mac/i.test(navigator.platform || '');
  const ready = (fn) => {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  };
  ready(() => {
    if (document.querySelector('.mobius-desktop-hostbar')) return;
    const bar = document.createElement('div');
    bar.className = 'mobius-desktop-hostbar' + (isMac ? ' mobius-desktop-hostbar--mac' : '');
    bar.innerHTML = [
      '<button type="button" class="mobius-desktop-hostbar__back" data-action="back" title="返回上一页" aria-label="返回上一页">',
      '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>',
      '  <span class="mobius-desktop-hostbar__back-label">返回</span>',
      '</button>',
      '<div class="mobius-desktop-hostbar__title"></div>',
      '<div class="mobius-desktop-hostbar__drag" data-action="drag" aria-hidden="true"></div>',
      '<button type="button" class="mobius-desktop-hostbar__button" data-action="reload" title="刷新页面" aria-label="刷新页面">',
      '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v5h-5"/></svg>',
      '</button>',
      '<div class="mobius-desktop-hostbar__controls" aria-label="窗口控制">',
      '  <button type="button" class="mobius-desktop-hostbar__button" data-action="minimize" title="最小化" aria-label="最小化"><svg viewBox="0 0 11 11" aria-hidden="true"><rect y="4.6" width="11" height="1.8" fill="currentColor"/></svg></button>',
      '  <button type="button" class="mobius-desktop-hostbar__button" data-action="maximize" title="最大化" aria-label="最大化"><svg class="mobius-desktop-hostbar__max" viewBox="0 0 11 11" aria-hidden="true"><rect x="0.7" y="0.7" width="9.6" height="9.6" fill="none" stroke="currentColor" stroke-width="1"/></svg><svg class="mobius-desktop-hostbar__max-restore" viewBox="0 0 11 11" aria-hidden="true"><rect x="1" y="3.2" width="6.4" height="6.4" fill="none" stroke="currentColor" stroke-width="1"/><path d="M3.2 3.2 V1 H9.6 V7.4 H7.4" fill="none" stroke="currentColor" stroke-width="1"/></svg></button>',
      '  <button type="button" class="mobius-desktop-hostbar__button mobius-desktop-hostbar__button--close" data-action="close" title="关闭" aria-label="关闭"><svg viewBox="0 0 11 11" aria-hidden="true"><path d="M0.5 0.5 L10.5 10.5 M10.5 0.5 L0.5 10.5" stroke="currentColor" stroke-width="1.2"/></svg></button>',
      '</div>',
    ].join('');
    const titleEl = bar.querySelector('.mobius-desktop-hostbar__title');
    if (titleEl) titleEl.textContent = TITLE || document.title || 'Mobius';
    document.body.prepend(bar);

    const goBack = () => {
      const before = location.href;
      if (history.length > 1) {
        history.back();
        window.setTimeout(() => {
          if (location.href === before) location.assign(FALLBACK);
        }, 700);
      } else {
        location.assign(FALLBACK);
      }
    };
    const endDrag = () => { try { void md.windowEndDrag?.(); } catch (_) {} };
    const startDrag = (event) => {
      if (isMac) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) {}
      try { void md.windowStartDrag?.(); } catch (_) {}
      window.addEventListener('pointerup', endDrag, { once: true });
      window.addEventListener('blur', endDrag, { once: true });
    };
    const setMaximized = (maximized) => {
      bar.classList.toggle('mobius-desktop-hostbar--maximized', !!maximized);
      const btn = bar.querySelector('[data-action="maximize"]');
      if (btn) {
        btn.setAttribute('title', maximized ? '还原' : '最大化');
        btn.setAttribute('aria-label', maximized ? '还原' : '最大化');
      }
    };

    bar.querySelector('[data-action="back"]')?.addEventListener('click', goBack);
    bar.querySelector('[data-action="reload"]')?.addEventListener('click', () => location.reload());
    bar.querySelector('[data-action="minimize"]')?.addEventListener('click', () => { try { void md.windowMinimize?.(); } catch (_) {} });
    bar.querySelector('[data-action="maximize"]')?.addEventListener('click', () => {
      try {
        Promise.resolve(md.windowToggleMaximize?.()).then((r) => {
          if (r && typeof r === 'object' && 'maximized' in r) setMaximized(!!r.maximized);
        }).catch(() => {});
      } catch (_) {}
    });
    bar.querySelector('[data-action="close"]')?.addEventListener('click', () => { try { void md.windowClose?.(); } catch (_) {} });
    const drag = bar.querySelector('[data-action="drag"]');
    drag?.addEventListener('pointerdown', startDrag);
    drag?.addEventListener('pointerup', endDrag);
    drag?.addEventListener('pointercancel', endDrag);
    drag?.addEventListener('dblclick', () => { if (!isMac) { try { void md.windowToggleMaximize?.(); } catch (_) {} } });
    try { Promise.resolve(md.windowIsMaximized?.()).then(setMaximized).catch(() => {}); } catch (_) {}
    try { md.onMaximizeChange?.(setMaximized); } catch (_) {}
  });
})();
</script>`;
}

function injectDesktopHostBar(html: string, title: string): string {
  const injection = desktopHostBarInjection(title);
  if (/<head([^>]*)>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>\n${injection}`);
  }
  return `${injection}\n${html}`;
}

function buildLoadingHtml(entry: any): string {
  const safeName = String(entry.name).replace(/[^a-z0-9-]/g, '');
  return injectDesktopHostBar(`<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${entry.display_name} - 加载中</title>
<style>
  html,body{height:100%;margin:0;background:#0b0f17;color:#cbd5e1;font-family:system-ui,sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
  .title{font-size:16px;font-weight:600;color:#e2e8f0}
  .desc{font-size:13px;color:#94a3b8;max-width:480px;text-align:center;line-height:1.6}
  .spin{width:28px;height:28px;border:3px solid #1e293b;border-top-color:#60a5fa;border-radius:50%;animation:s 0.8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  .log{margin-top:12px;font-family:ui-monospace,monospace;font-size:11px;color:#64748b;max-width:560px;white-space:pre-wrap;text-align:left}
</style>
</head><body>
<div class="wrap">
  <div class="spin"></div>
  <div class="title">正在准备拓展: ${entry.display_name}</div>
  <div class="desc">首次访问需要编译前端代码, 通常需要 10-30 秒. 编译失败请联系管理员重试.</div>
  <div class="log" id="log"></div>
</div>
<script>
const NAME = ${JSON.stringify(safeName)};
let lastTail = '';
async function tick() {
  try {
    const token = localStorage.getItem('cc-token') || '';
    const r = await fetch('/api/extensions/' + NAME + '/build-status', {
      credentials: 'include',
      headers: token ? { 'authorization': 'Bearer ' + token } : {},
    });
    if (r.status === 401) { document.getElementById('log').textContent = '需要登录 (主前端登录后再访问)'; return; }
    const data = await r.json();
    if (data.state === 'ready') { location.reload(); return; }
    if (data.state === 'error') {
      document.getElementById('log').textContent = '编译失败:\\n' + (data.log_tail || '(无日志)');
      return;
    }
    if (data.log_tail && data.log_tail !== lastTail) {
      lastTail = data.log_tail;
      document.getElementById('log').textContent = data.log_tail;
    }
  } catch (e) { /* keep polling */ }
  setTimeout(tick, 1500);
}
tick();
</script>
</body></html>`, `${entry.display_name || entry.name} - 加载中`);
}

function safeResolveAsset(distDir: string, rel: string): string | null {
  const abs = path.resolve(distDir, rel.replace(/^\/+/, ''));
  if (abs !== distDir && !abs.startsWith(distDir + path.sep)) return null;
  return abs;
}

// 单一 handler 处理 /extension/<name> 和 /extension/<name>/<rel>...
// 区分:
//   - 无尾斜杠的 /<name>            → 301 → /<name>/
//   - 尾斜杠的 /<name>/             → 视为 index
//   - /<name>/<rel>                  → rel 资源
//
// 必须先注册 /:name/* 路由 (匹配 /<name>/...), 否则 /:name 会先吃掉 /<name>/.
staticRouter.get('/:name/*', async (req: express.Request, res: express.Response) => {
  // /<name>/<rel> 走资源/index 分支 (rel='' 即尾斜杠 → index)
  const rel = (req.params as any)[0] || '';
  await serveExtension(req, res, String(req.params.name), rel);
});

staticRouter.get('/:name', (req: express.Request, res: express.Response) => {
  // /<name> (无尾斜杠) → 301 到 /<name>/
  res.redirect(301, `/extension/${req.params.name}/`);
});

async function serveExtension(req: express.Request, res: express.Response, name: string, rel: string): Promise<void> {
  if (!registry.EXT_NAME_RE.test(name)) {
    res.status(400).send('bad extension name');
    return;
  }
  const entry = registry.get(name);
  if (!entry) {
    res.status(404).send('extension not found');
    return;
  }

  const distDir = path.join(entry.frontend_dir, 'dist');
  const isIndex = !rel || rel === '' || rel === '/' || rel.endsWith('/');

  // dist 不存在 → 入队编译并返回 loading 页
  const distExists = fs.existsSync(path.join(distDir, 'index.html'));
  if (!distExists) {
    buildPipeline.enqueue(entry);
    if (isIndex) {
      res.set('content-type', 'text/html; charset=utf-8');
      res.send(buildLoadingHtml(entry));
      return;
    }
    res.status(503).send('extension not built yet');
    return;
  }

  // index.html: 注入 window.__EXT_NAME__
  if (isIndex) {
    const indexPath = path.join(distDir, 'index.html');
    try {
      const html = fs.readFileSync(indexPath, 'utf8');
      const withExtName = html.replace(
        /<head([^>]*)>/i,
        `<head$1>\n<script>window.__EXT_NAME__=${JSON.stringify(name)};</script>`
      );
      const injected = injectDesktopHostBar(withExtName, entry.display_name || name);
      res.set('content-type', 'text/html; charset=utf-8');
      // 缓存安全: 用 no-store, 避免开发期 dist 重建后浏览器拿到老 html.
      res.set('cache-control', 'no-store');
      res.send(injected);
      return;
    } catch (e) {
      const err = e as Error;
      res.status(500).send('failed to read index.html: ' + err.message);
      return;
    }
  }

  // 普通静态资源
  let abs = safeResolveAsset(distDir, rel);
  if (!abs) {
    res.status(400).send('bad path');
    return;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    // Next.js 静态导出等 SPA 框架把 page 存为 <name>.html, 链接可能不带 .html 后缀.
    // 仅对"无扩展名"路径尝试补 .html, assets (.css/.js/.png 等) 不受影响.
    if (path.extname(rel) === '') {
      const withHtml = abs + '.html';
      if (fs.existsSync(withHtml) && fs.statSync(withHtml).isFile()) {
        abs = withHtml;
      } else {
        res.status(404).send('not found');
        return;
      }
    } else {
      res.status(404).send('not found');
      return;
    }
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    res.status(403).send('mime not allowed');
    return;
  }
  res.set('content-type', mime);
  // SVG 走严格 CSP, 防 svg xss
  if (ext === '.svg') res.set('content-security-policy', "default-src 'none'");
  streamAssetWithRange(req, res, abs, rel);
}

// 拓展静态资源 Cache-Control 分级:
//   - vite/Next 内容哈希产物 (dist/assets/*, dist/_next/static/*) → 1 年 immutable, 文件名变即内容变;
//   - 其他 (媒体 mp4/webm, SDK 等) → 1 小时缓存, 到期后靠 ETag 重验 (304).
function extensionAssetCacheControl(rel: string): string {
  const r = String(rel || '').replace(/^\/+/, '');
  if (r.startsWith('assets/') || r.startsWith('_next/static/') || r.startsWith('static/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}

// 静态资源带 HTTP Range 支持 — 浏览器 <video>/<audio> 必须靠 Range 分块流式播放,
// 否则会卡在缓冲(对大视频尤甚). 同时补 Content-Length / Accept-Ranges 头.
// rel (URL 相对路径) 用于判定内容哈希分级缓存.
function streamAssetWithRange(
  req: express.Request,
  res: express.Response,
  abs: string,
  rel: string = '',
  cacheControlOverride = ''
): void {
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); } catch {
    res.status(404).send('not found');
    return;
  }
  if (!stat.isFile()) {
    res.status(404).send('not found');
    return;
  }
  const total = stat.size;

  // ── 缓存: ETag (size+mtime 弱校验) + Last-Modified + 分级 Cache-Control ──
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  res.set('etag', etag);
  res.set('last-modified', stat.mtime.toUTCString());
  res.set('cache-control', cacheControlOverride || extensionAssetCacheControl(rel));
  // 条件 GET: If-None-Match 命中 → 304, 省整个响应体. 必须在 Range 处理之前.
  // 浏览器对 video Range 请求走 If-Range (而非 If-None-Match), 故此处 304 不影响 206 分片播放.
  const inm = req.headers['if-none-match'];
  if (inm && String(inm).split(',').some((v) => { const t = v.trim(); return t === etag || t === '*'; })) {
    res.status(304).end();
    return;
  }

  res.set('accept-ranges', 'bytes');

  const rangeHdr = (req.headers.range || (req.headers as any)['range']) as string | undefined;
  if (!rangeHdr) {
    res.set('content-length', String(total));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(abs).pipe(res);
    return;
  }
  // 解析 Range: bytes=start-end
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHdr).trim());
  if (!m) {
    res.set('content-range', `bytes */${total}`);
    res.status(416).end();
    return;
  }
  let start = m[1] === '' ? NaN : parseInt(m[1], 10);
  let end = m[2] === '' ? NaN : parseInt(m[2], 10);
  if (Number.isNaN(start) && Number.isNaN(end)) {
    res.set('content-range', `bytes */${total}`);
    res.status(416).end();
    return;
  }
  // 后缀式: bytes=-N → 最后 N 字节
  if (Number.isNaN(start)) {
    start = Math.max(0, total - (end as number));
    end = total - 1;
  }
  // 开放式: bytes=N- → 到末尾
  if (Number.isNaN(end)) end = total - 1;
  if (start > end || start < 0 || end >= total) {
    res.set('content-range', `bytes */${total}`);
    res.status(416).end();
    return;
  }
  const length = end - start + 1;
  res.status(206);
  res.set('content-range', `bytes ${start}-${end}/${total}`);
  res.set('content-length', String(length));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(abs, { start, end }).pipe(res);
}

// SPA 框架 (如 Next.js) 静态导出的 chunk/runtime 走根路径 /_next/static/...,
// 不带 /extension/<name>/ 前缀 — webpack/runtime 直接拼绝对路径, 跟它所挂的
// HTML 路径无关. 如果只走 /extension/<name>/ 路由, 浏览器在加载
// /extension/jsoncrack/editor 时会发起 /_next/static/chunks/2591.<hash>.js
// 这种 unprefixed 请求, 当前 mobius 路由不知道, 落到 catchall 被退回
// 主前端的 index.html (text/html), 浏览器拿不到 JS, 报
// "Loading chunk 2591 failed" 这类错.
//
// 兜底: 把 /_next/* 也接进 extension 注册中心, 遍历所有 extension 的
// frontend/dist/_next/<rel>, 第一个匹配的静态文件直接返回. 多 extension
// 同名文件按 registry 顺序, 通常不会冲突; 必要的时候再用 Referer 锁定.
const unprefixedNextRouter = express.Router();
unprefixedNextRouter.get('/*', (req: express.Request, res: express.Response) => {
  const rel = (String((req.params as any)[0] || '')).replace(/^\/+/, '');
  if (!rel) {
    res.status(404).send('not found');
    return;
  }
  // 防穿越: 只允许 _next/static, _next/data 这类合法子路径
  if (rel.split('/').some((seg) => seg === '..' || seg === '')) {
    res.status(400).send('bad path');
    return;
  }
  for (const entry of registry.getAll() as any[]) {
    if (!entry?.frontend_dir) continue;
    const distDir = path.join(entry.frontend_dir, 'dist');
    const nextRoot = path.resolve(distDir, '_next');
    const abs = path.resolve(nextRoot, rel);
    if (abs !== nextRoot && !abs.startsWith(nextRoot + path.sep)) continue;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const ext = path.extname(abs).toLowerCase();
      const mime = MIME[ext];
      if (!mime) {
        res.status(403).send('mime not allowed');
        return;
      }
      res.set('content-type', mime);
      // Next.js _next/static/* 为内容哈希产物 → immutable; 其余 _next/* → 1h 重验.
      res.set('cache-control', extensionAssetCacheControl('_next/' + rel));
      fs.createReadStream(abs).pipe(res);
      return;
    }
  }
  res.status(404).send('not found');
});

export { metaRouter, invokeRouter, staticRouter, unprefixedNextRouter };
