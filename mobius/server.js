/**
 * server.js — MOBIUS Mobius (主栈, 原 v2 实验栈接管生产)
 *
 * 架构 (v1.9 起):
 *   - 直接通过 tmux 启动 claude CLI 子进程, 输出靠 ~/.claude/projects/<cwd>/<sid>.jsonl 监听
 *   - 不依赖外部 Bridge 或 @anthropic-ai/claude-agent-sdk
 *   - 走 backend/agents/ 抽象层, 默认 backend = 'tmux-claude-code' (见 backend/agents/tmux-claude-code.js)
 *
 * 端口: 45614 (HTTP+WS)
 * 启动: python3 start.py (项目根目录) -> 调用 mobius/start_product.py
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const { AGENT_TMUX_SOCKET, PORT, PUBLIC_DIR, TEST_ROOT } = require('./backend/config');
const NODE_ENV = process.env.NODE_ENV || 'development';
const VERSION = require('./package.json').version;
const SERVER_STARTED_AT_MS = Date.now();

function readGitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: TEST_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch (_) {
    return null;
  }
}

const GIT_COMMIT = readGitCommit();
const CODE_VERSION = GIT_COMMIT ? `${VERSION}+${GIT_COMMIT}` : VERSION;

// preflight 已经在 agents/tmux-claude-code.js 模块加载时跑过 (proxy_envs.bash / proxy_claude.conf /
// tmux / proxychains / claude 缺一不可, 缺则 process.exit(1)). 这里不重复.
const { db } = require('./db');

// ===== Express =====
const app = express();
app.use(cors());
const defaultJsonParser = express.json({ limit: '10mb' });
const memoryJsonParser = express.json({ limit: '60mb' });
function isMemoryApiPath(req) {
  const p = req.path || '';
  return p === '/api/memories'
    || p.startsWith('/api/memories/')
    || /^\/api\/projects\/[^/]+\/memories(?:\/|$)/.test(p);
}
// /aimux_bridge/* 走原生反代, body 必须 byte-for-byte 透传给 bridge, 不能被 express.json() 消费.
function isAimuxBridgePath(req) {
  const p = req.path || '';
  return p === '/aimux_bridge' || p.startsWith('/aimux_bridge/');
}
function isMultipartPath(req) {
  const p = req.path || '';
  return p === '/api/upload'
    || p === '/api/assistant/transcribe'
    || p === '/api/voice/upload'
    || p.startsWith('/api/upload/')
    || p.startsWith('/api/files/upload');
}
app.use((req, res, next) => {
  if (isMemoryApiPath(req) || isAimuxBridgePath(req) || isMultipartPath(req)) return next();
  return defaultJsonParser(req, res, next);
});

// REST JSON 响应 gzip 压缩. 必须在路由之前挂载 (惰性拦截 res.end).
// 中间件内部显式跳过 text/event-stream / 已编码响应, 不影响 sessions.ts 的流式 SSE gzip.
const apiGzip = require('./backend/middleware/api-gzip').apiGzip;
app.use(apiGzip);

// ── mount v1 backend/routes (auth/projects/issues/skills/memories/files/health) ──
// 这些路由读 users/projects/issues 等共享表, 不动 sessions, 完全可复用.
const authRoutes = require('./backend/routes/auth');
const tasksRoutes = require('./backend/routes/tasks');
const messagesRoutes = require('./backend/routes/messages');
const projectsRoutes = require('./backend/routes/projects');
const { router: issuesRoutes, projectScoped: issuesUnderProject } = require('./backend/routes/issues');
const { router: sessionsRoutes, issueScoped: sessionsUnderIssue } = require('./backend/routes/sessions');
const { router: researchesRoutes, projectScoped: researchesUnderProject, researchScoped: sessionsUnderResearch, blackboardRouter, graphRouter } = require('./backend/routes/researches');
const { router: skillsRoutes, projectScoped: skillsUnderProject } = require('./backend/routes/skills');
const { router: memoriesRoutes, projectScoped: memoriesUnderProject } = require('./backend/routes/memories');
const searchRoutes = require('./backend/routes/search');
const filesRoutes = require('./backend/routes/files');
const healthRoutes = require('./backend/routes/health');
const assistantRoutes = require('./backend/routes/assistant');
// 用户个人维度偏好 (首登引导已看标记等), 普通 auth, 非 admin.
const profileRoutes = require('./backend/routes/profile');
const adminRoutes = require('./backend/routes/admin');
const extRoutes = require('./backend/routes/ext');
const aimuxRoutes = require('./backend/routes/aimux');
const aimuxBridgeProxy = require('./backend/routes/aimux-bridge-proxy');
// 黑客帝国数字雨: /api/token_stream 反代到本机 token-proxy (server.ts).
const { router: tokenStreamProxyRouter } = require('./backend/routes/token-stream-proxy');
const extensionRegistry = require('./backend/services/extension-registry');

app.use('/api/auth', authRoutes);
// 微信式群聊: 用户列表 + 群(conversations). tsx 即时转译 .ts, 无同名 .js 故 require 解析到 .ts.
app.use('/api/users', require('./backend/routes/users'));
app.use('/api/conversations', require('./backend/routes/conversations'));
app.use('/api/assistant', assistantRoutes);
// 用户个人维度偏好: GET/POST /api/profile/tour-first-login-seen (普通 auth, 跨设备生效).
app.use('/api/profile', profileRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/projects/:projectId/issues', issuesUnderProject);
app.use('/api/projects/:projectId/researches', researchesUnderProject);
app.use('/api/projects/:projectId/skills', skillsUnderProject);
app.use('/api/projects/:projectId/memories', memoryJsonParser, memoriesUnderProject);
app.use('/api/issues', issuesRoutes);
app.use('/api/issues/:issueId/sessions', sessionsUnderIssue);
app.use('/api/researches', researchesRoutes);
app.use('/api/researches/:researchId/sessions', sessionsUnderResearch);
app.use('/api/research-blackboard', blackboardRouter);
app.use('/api/research-graph', graphRouter);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/skills', skillsRoutes);
app.use('/api/memories', memoryJsonParser, memoriesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/aimux', aimuxRoutes);
// /api/token_stream → 本机 token-proxy (数字雨 token 环形缓冲, SSE live tail).
app.use('/api/token_stream', tokenStreamProxyRouter);
// /aimux_bridge/* → 内置 aimux bridge broker (127.0.0.1:AIMUX_BRIDGE_PORT).
//   外层走 mobius JWT auth; 转发时注入 bridge Bearer token.
//   支持 SSE 长连接 (client/events), 见 routes/aimux-bridge-proxy.js.
app.use('/aimux_bridge', aimuxBridgeProxy);
// 拓展系统:
//   /api/extensions/* 元信息 (列表 / manifest / build-status / admin reload)
//   /api/ext         统一调用入口 (POST, worker_thread 跑 handler)
//   /extension/*     拓展前端静态资源 (含按需编译 + loading 页 + 共用 SDK)
app.use('/api/extensions', extRoutes.metaRouter);
app.use('/api/ext', extRoutes.invokeRouter);
app.use('/extension', extRoutes.staticRouter);
// /_next/* (Next.js chunk/runtime 走绝对根路径, 不带 /extension/ 前缀).
// 见 routes/ext.js 里 unprefixedNextRouter 的注释, 要先于 catchall 之前.
app.use('/_next', extRoutes.unprefixedNextRouter);
// files.js 的路由名是相对 /api 写的 (/files, /files/mkdir, /files/read,
// /upload, /download) — 前端 PathPicker/FileManager/上传/下载 全
// 按 /api/files、/api/files/mkdir、/api/upload、/api/download 调. 故必须挂在
// /api 而非 /api/files (后者会变成 /api/files/files 一类, 全 404 → "读取目录失败").
// 放在所有 /api/<具体> 之后: 那些已先匹配响应, 不会落到这里.
app.use('/api', filesRoutes);
app.use('/api/health', healthRoutes);

// ===== code-server 反向代理(v1.9 主栈, 从旧 gateway 移植) =====
// /code-server/<userId>__<projectId>/* → per-(user, project) lazy spawn 的 code-server 进程
// JWT 鉴权 (cookie cc_cs_jwt 或 ?_jwt=token), 详见 backend/routes/code-server-proxy.js
const codeServerProxy = require('./backend/routes/code-server-proxy');
app.use('/code-server', codeServerProxy.router);
app.use('/api/admin/code-server', codeServerProxy.adminRouter);

// ===== Web 终端 (会话内弹窗) =====
// /api/terminal/ws?sid=<sessionId>&token=<jwt> → node-pty 鉴权 WS 终端.
// cwd 取 session 所属项目 bind_path. 详见 backend/routes/web-terminal.ts.
const webTerminal = require('./backend/routes/web-terminal');

// ===== Health =====
app.get('/api/v2/health', (req, res) => {
  const now = Date.now();
  res.json({
    service: 'mobius-system',
    version: VERSION,
    code_version: CODE_VERSION,
    git_commit: GIT_COMMIT,
    git_commit_short: GIT_COMMIT ? GIT_COMMIT.slice(0, 7) : null,
    started_at: new Date(SERVER_STARTED_AT_MS).toISOString(),
    started_at_ms: SERVER_STARTED_AT_MS,
    uptime_ms: now - SERVER_STARTED_AT_MS,
    env: NODE_ENV,
    port: PORT,
    backend: `agents/tmux + jsonl-watcher (socket=${AGENT_TMUX_SOCKET})`,
  });
});

app.get('/api/v2/hello', (req, res) => {
  res.json({ msg: 'hello from mobius 🧪', t: new Date().toISOString() });
});

// DB 体检: 列出 v2 表行数 + 共享表行数, 证明两边不串
app.get('/api/v2/db-check', (req, res) => {
  try {
    const result = {
      shared_tables: {
        users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
        projects: db.prepare('SELECT COUNT(*) as c FROM projects').get().c,
        issues: db.prepare('SELECT COUNT(*) as c FROM issues').get().c,
        researches: db.prepare('SELECT COUNT(*) as c FROM researches').get().c,
        sessions_v1: db.prepare('SELECT COUNT(*) as c FROM sessions').get().c,
        messages_v1: db.prepare('SELECT COUNT(*) as c FROM messages').get().c,
      },
      v2_tables: {
        sessions_v2: db.prepare('SELECT COUNT(*) as c FROM sessions_v2').get().c,
        messages_v2: db.prepare('SELECT COUNT(*) as c FROM messages_v2').get().c,
      },
    };
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Product frontend =====
// start_product.py runs `npm run build` first, which writes the SPA into
// mobius/public. Debug mode still uses the Vite dev server on VITE_PORT.
const PUBLIC_INDEX = path.join(PUBLIC_DIR, 'index.html');

// 静态资源缓存策略 (修复 logo.png / 哈希 chunk 等每次重新下载的问题).
// express.static 默认 Cache-Control: public, max-age=0 → 浏览器每次导航都要
// 重新验证 (即便 ETag 命中也得多一次往返; 清缓存/首进站后每次全量重下).
// 这里按文件类型分级 (setHeaders 在 express 默认头之后调用, res.setHeader 覆盖):
//   - assets/*   构建产物带内容哈希 (文件名变即内容变) → 1 年 immutable, 浏览器永不重验;
//   - index.html SPA 入口 (无哈希)                  → no-cache, 每次校验拿新部署 (ETag 不变则 304);
//   - 其他        logo.png / favicon 等公开文件      → 1 小时缓存, 到期后重验.
// ETag / Last-Modified 由 express.static 默认开启, 命中时仍走 304 省带宽.
function setStaticCacheHeaders(res, filePath) {
  const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
  if (rel.startsWith('assets/')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (rel === 'index.html') {
    res.setHeader('Cache-Control', 'no-cache');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}

app.use(express.static(PUBLIC_DIR, {
  etag: true,
  lastModified: true,
  setHeaders: setStaticCacheHeaders,
}));

// ===== 桌面客户端分发 =====
// build.py --build-electron 把三平台 zip 产到 mobius/desktop-builds/。故意不放 public:
// vite emptyOutDir:true 每次前端构建会清空 mobius/public, 放那里会被删。这里独立挂一条
// 静态路由, 同源供 "下载桌面客户端" 菜单 (/desktop-builds/<file>) 分发。
const DESKTOP_BUILDS_DIR = path.join(__dirname, 'desktop-builds');
app.use('/desktop-builds', express.static(DESKTOP_BUILDS_DIR, {
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=3600'),
}));

app.get('*', (req, res, next) => {
  const p = req.path || '';
  if (p.startsWith('/api') || p.startsWith('/code-server') || p.startsWith('/extension')) {
    return next();
  }
  if (!fs.existsSync(PUBLIC_INDEX)) return next();
  // SPA 路由回退到 index.html, 同样 no-cache 以便拿到新部署 (ETag 不变则 304).
  return res.sendFile(PUBLIC_INDEX, {
    lastModified: true,
    headers: { 'Cache-Control': 'no-cache' },
  });
});

// ===== 后台巡检: 被遗忘的 running.flag =====
const { startForgottenFlagScanner } = require('./backend/services/forgotten-flag-scanner');
const { startInactiveTmuxCleaner } = require('./backend/services/inactive-tmux-cleaner');
const { startResearchBlackboardDeliveryScanner } = require('./backend/services/research-blackboard');
const { startExtensionScheduler } = require('./backend/services/extension-scheduler');
const { startAgentStatusSyncer } = require('./backend/services/agent-status-syncer');
const { startSessionTitleSyncer } = require('./backend/services/session-title-syncer');
const { startSessionTitleGenerator } = require('./backend/services/session-title-generator');

// ===== 启动 =====
const server = http.createServer(app);

// code-server 需要 HTTP upgrade 反代; Web 终端需要 WS upgrade; Mobius session chat 改为 SSE + HTTP POST.
server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  if (p.startsWith('/code-server/')) {
    codeServerProxy.handleUpgrade(req, socket, head);
  } else if (p.startsWith('/api/terminal/')) {
    webTerminal.handleUpgrade(req, socket, head);
  } else if (p === '/aimux_bridge/api/forward') {
    aimuxBridgeProxy.handleUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[mobius] MOBIUS Mobius listening on http://0.0.0.0:${PORT}`);
  console.log(`[mobius] health: http://0.0.0.0:${PORT}/api/v2/health`);
  console.log(`[mobius] backend: tmux agents (socket=${AGENT_TMUX_SOCKET}, window-per-session) + jsonl-watcher`);
  // 拓展系统启动 diff: 扫描 mobius/extension/<name>/extension.json, 与 projects(kind=extension) 同步.
  try {
    const r = extensionRegistry.reload();
    console.log(`[mobius] extension registry: ${r.count} loaded, ${r.errors.length} errors`);
    for (const e of r.errors) console.warn(`[mobius/ext] ${e.name}: ${e.error}`);
  } catch (e) {
    console.warn('[mobius/ext] registry 初始化失败:', e.message);
  }
  // 每 60s 扫描所有 session: agent 已停工但 running.flag 未删除, 或 session
  // 完成/失败 flag 发生变化 → 写 backend_worker_log 并触发小莫回调.
  startForgottenFlagScanner();
  // 自动清理 24h 以上无活动的 tmux agent window, 防止后台 TUI 长期挂着占资源.
  startInactiveTmuxCleaner();
  // Research Blackboard 独立投递 worker: 扫描 blackboard.jsonl 中未投递记录,
  // 以纯后端方式批量投递到 research agents.
  startResearchBlackboardDeliveryScanner();
  // 拓展通用定时器: 扫描 protected_data/extension/<name>/schedules/*.json,
  // 到点后以对应用户身份触发该拓展 handler.
  startExtensionScheduler();
  // agent_status 单一真相源: 每 60s 用与 /api/sessions/:id/status 相同的判定重算
  // 活跃态 session 的 agent_status 并写回; 终态(failed/stale)每小时扫一次.
  startAgentStatusSyncer();
  // 自动生成 Session 标题: 订阅 agent shared watcher 的 raw_entry 事件; 功能默认关闭,
  // 开启后仅在 agent 明确产出 type=ai-title 时更新, 不走前端/SSE 回灌/状态轮询.
  startSessionTitleSyncer();
  // 兜底自动生成 Session 标题: codex / gpt-5.5 等 tmux-codex 后端不产 type=ai-title,
  // 由本生成器周期扫描, 用会话自身模型把首条提问浓缩成标题写回 name。受同一开关控制。
  startSessionTitleGenerator();
});

// 优雅退出
function shutdown(sig) {
  console.log(`[v2] received ${sig}, shutting down...`);
  server.close(() => {
    console.log('[v2] closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
