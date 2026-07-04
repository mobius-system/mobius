// recording-studio/backend/extension_backend_handler.js
//
// 录制导演后端. handler 跑在 30s 无状态 worker_thread 里, 但录制要好几分钟且 chromium
// 吃内存远超 256MB —— 所以录制**不能**在 handler 内同步跑. 模式:
//   start   → 校验 spec → 写 jobs/<id>/{spec,status,pid} → spawn(detached, unref) recorder.js
//             (NODE_PATH 指向 playwright) → 立即返回 jobId. recorder 是独立进程, 不受 worker 生命周期约束.
//   status  → 读 jobs/<id>/status.json + pid 存活检测 (recorder 崩了就标 error).
//   list    → 列出 jobs (轻量 status).
//   detail  → 读 events.jsonl + script.md 内容 + artifacts 清单.
//   cancel  → kill pid (best-effort) + 写 cancelled.
//
// 硬约束遵守: 只写 ext_data_dir; 不 process.chdir; 不顶层持连接/定时器; 校验 payload.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const JOBS_DIRNAME = 'jobs';
const STALE_MS = 180000; // 状态 running 且 180s 无心跳 → 视为崩溃

// ---------- 路径推导 ----------
// 关键: handler 被 require(handler_path) 加载, __dirname 就是本扩展的 backend/ 目录.
// recorder.js 在同目录, frontend/ 在上一层. 这样定位与 APP_DIR / 部署布局无关
// (本机数据目录 .deploy_data/protected_data/... 与源码目录 mobius/extension/... 是不同根).
const HANDLER_DIR = __dirname;                   // <EXTENSION_ROOT>/<name>/backend
const SRC_DIR = path.resolve(HANDLER_DIR, '..'); // <EXTENSION_ROOT>/<name>
const RECORDER_SCRIPT = path.join(HANDLER_DIR, 'recorder.js');
const FRONTEND_DIR = path.join(SRC_DIR, 'frontend');

function jobsDir(extDataDir) {
  return path.join(extDataDir, JOBS_DIRNAME);
}
function jobDir(extDataDir, jobId) {
  return path.join(jobsDir(extDataDir), jobId);
}

// ---------- 依赖发现 ----------
const NPX_ROOT = path.join(os.homedir(), '.npm', '_npx');
const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH,
  path.join(os.homedir(), '.local', 'bin', 'ffmpeg'),
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
].filter(Boolean);

function discoverPlaywright() {
  // 优先 1.60.x (与本机 chromium 匹配), 其次任意版本. 全部 fs.existsSync, 很快.
  let entries = [];
  try { entries = fs.readdirSync(NPX_ROOT, { withFileTypes: true }); } catch { return null; }
  const dirs = entries.filter((d) => d.isDirectory()).map((d) => path.join(NPX_ROOT, d.name, 'node_modules'));
  const has = (nm) => {
    try { return fs.existsSync(path.join(nm, 'playwright', 'package.json')); } catch { return false; }
  };
  const withVer = (nm) => {
    try { return require(path.join(nm, 'playwright', 'package.json')).version || ''; } catch { return ''; }
  };
  const candidates = dirs.filter(has);
  // 1.60.x 优先
  candidates.sort((a, b) => {
    const av = withVer(a).startsWith('1.60') ? 0 : 1;
    const bv = withVer(b).startsWith('1.60') ? 0 : 1;
    return av - bv;
  });
  return candidates[0] || null;
}

function discoverFfmpeg() {
  for (const c of FFMPEG_CANDIDATES) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

// ---------- status 读写 + pid 存活 ----------
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch {}
}

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// 读 status, 并对 running 态做存活性修正 (recorder 崩溃 / 服务器重启后留僵尸).
function readStatus(extDataDir, jobId) {
  const dir = jobDir(extDataDir, jobId);
  const status = readJson(path.join(dir, 'status.json'), null);
  if (!status) return null;
  if (status.state === 'running') {
    const pid = readJson(path.join(dir, 'pid.json'), null);
    const pidNum = pid && pid.pid;
    const updated = status.updatedAt ? Date.parse(status.updatedAt) : 0;
    const stale = updated && (Date.now() - updated) > STALE_MS;
    if (!pidAlive(pidNum) || stale) {
      status.state = 'error';
      status.error = stale ? '录制心跳超时 (recorder 可能被杀)' : '录制进程异常退出';
      status.fixedAt = new Date().toISOString();
      writeJson(path.join(dir, 'status.json'), status); // 落盘修正, 前端不再卡 running
    }
  }
  return status;
}

// ---------- action: start ----------
function isValidRecipe(r) { return r === 'self-cognition' || r === 'generic'; }
function isValidUrl(u) { return typeof u === 'string' && /^\/[^?#]*$/.test(u) && !u.includes('..'); }

function handleStart({ ext_data_dir, extension_name, username, ext_main_payload, logger }) {
  const p = ext_main_payload || {};
  const recipe = p.recipe;
  if (!isValidRecipe(recipe)) return { ok: false, error: 'recipe 必须是 self-cognition 或 generic' };

  const options = Object.assign({}, p.options || {});
  // 选项校验 + 边界
  const vp = Array.isArray(options.viewport) && options.viewport.length === 2
    ? [Math.min(2400, Math.max(800, Number(options.viewport[0]) || 1440)),
       Math.min(2000, Math.max(600, Number(options.viewport[1]) || 900))]
    : [1440, 900];
  const pace = ['slow', 'normal', 'fast'].includes(options.pace) ? options.pace : 'normal';

  const spec = {
    recipe,
    options: {
      viewport: vp,
      deviceScaleFactor: 1,
      captions: options.captions !== false,
      pace,
      convertMp4: options.convertMp4 !== false,
    },
    username: String(username || 'fuqingxu'),
  };

  if (recipe === 'self-cognition') {
    spec.selfCognition = {
      hudTitle: String((p.selfCognition && p.selfCognition.hudTitle) || 'Self-Cognition 插件演示').slice(0, 80),
      hudBody: String((p.selfCognition && p.selfCognition.hudBody) || '自动录制样片：雷达、调研、启发落实、自进化历史。').slice(0, 200),
    };
  } else {
    // generic
    const g = p.generic || {};
    const url = String(g.url || '/').trim();
    if (!isValidUrl(url)) return { ok: false, error: 'generic.url 必须是站内绝对路径, 如 /extension/mobius-home/' };
    let steps = Array.isArray(g.steps) ? g.steps : null;
    if (steps) {
      steps = steps.slice(0, 24).map((s) => ({
        caption: String((s && s.caption) || '').slice(0, 200),
        selector: s && s.selector ? String(s.selector).slice(0, 300) : '',
      })).filter((s) => s.caption);
    }
    spec.generic = {
      url,
      eyebrow: String(g.eyebrow || 'MOBIUS').slice(0, 40),
      title: String(g.title || '莫比乌斯演示').slice(0, 120),
      description: String(g.description || '').slice(0, 400),
      hudTitle: String(g.hudTitle || g.title || '莫比乌斯演示').slice(0, 80),
      hudBody: String(g.hudBody || g.description || '').slice(0, 200),
      autoDiscover: !!g.autoDiscover,
      steps,
    };
  }

  // 依赖前置检查 (不启动 chromium, 只查模块/二进制存在)
  const pwPath = discoverPlaywright();
  if (!pwPath) return { ok: false, error: '未找到 playwright 模块 (需要 npx playwright 已缓存)' };
  const ffmpegPath = discoverFfmpeg();

  // jobId + 目录
  const jobId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const dir = jobDir(ext_data_dir, jobId);

  if (!fs.existsSync(RECORDER_SCRIPT)) {
    return { ok: false, error: 'recorder.js 缺失: ' + RECORDER_SCRIPT };
  }
  fs.mkdirSync(dir, { recursive: true });

  const base = process.env.MOBIUS_BASE || `http://127.0.0.1:${process.env.VITE_PORT || '45616'}`;

  const fullSpec = Object.assign({
    jobId,
    extDataDir: ext_data_dir,
    frontendDir: FRONTEND_DIR,
    mediaRelDir: `media/${jobId}`,            // 相对 dist 的目录, 也即 URL 子路径
    extName: extension_name,
    base,
    ffmpegPath,
  }, spec);

  const specPath = path.join(dir, 'spec.json');
  const statusPath = path.join(dir, 'status.json');
  const pidPath = path.join(dir, 'pid.json');
  const logPath = path.join(dir, 'recorder.log');
  fs.writeFileSync(specPath, JSON.stringify(fullSpec, null, 2));
  writeJson(statusPath, {
    state: 'running', phase: 'init', progress: 0,
    message: '正在启动录制子进程…',
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    recipe: spec.recipe, title: recipe === 'self-cognition' ? spec.selfCognition.hudTitle : spec.generic.title,
    artifacts: null, durationSec: null, error: null,
  });

  // spawn detached recorder
  const env = Object.assign({}, process.env, {
    NODE_PATH: pwPath,
    MOBIUS_RECORDER_JOB: jobId,
  });
  let child;
  try {
    const logFd = fs.openSync(logPath, 'a');
    child = spawn(process.execPath, [RECORDER_SCRIPT, specPath], {
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    fs.closeSync(logFd);
    child.unref();
  } catch (e) {
    writeJson(statusPath, {
      state: 'error', phase: 'init', progress: 0,
      message: '启动录制子进程失败', error: String(e && e.message || e),
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      recipe: spec.recipe, artifacts: null,
    });
    return { ok: false, error: '启动录制子进程失败' };
  }
  writeJson(pidPath, { pid: child.pid, startedAt: new Date().toISOString() });
  if (logger) logger.info(`[recording-studio] started job ${jobId} pid ${child.pid} recipe ${recipe}`);

  return {
    ok: true,
    job: {
      id: jobId, state: 'running', phase: 'init', recipe: spec.recipe,
      title: spec.recipe === 'self-cognition' ? spec.selfCognition.hudTitle : spec.generic.title,
    },
  };
}

// ---------- action: list ----------
function handleList({ ext_data_dir }) {
  const root = jobsDir(ext_data_dir);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { ok: true, jobs: [] }; }
  const jobs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const status = readStatus(ext_data_dir, e.name);
    if (!status) continue;
    jobs.push({
      id: e.name,
      state: status.state,
      phase: status.phase,
      progress: status.progress,
      recipe: status.recipe,
      title: status.title,
      updatedAt: status.updatedAt,
      durationSec: status.durationSec,
      hasVideo: !!(status.artifacts && (status.artifacts.videoMp4 || status.artifacts.videoWebm)),
    });
  }
  jobs.sort((a, b) => (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
  return { ok: true, jobs };
}

// ---------- action: status ----------
function handleStatus({ ext_data_dir, ext_main_payload }) {
  const id = String((ext_main_payload && ext_main_payload.id) || '');
  if (!/^[a-z0-9]+$/i.test(id)) return { ok: false, error: 'bad id' };
  const status = readStatus(ext_data_dir, id);
  if (!status) return { ok: false, error: '未找到该任务' };
  return { ok: true, status };
}

// ---------- action: detail ----------
function handleDetail({ ext_data_dir, extension_name, ext_main_payload }) {
  const id = String((ext_main_payload && ext_main_payload.id) || '');
  if (!/^[a-z0-9]+$/i.test(id)) return { ok: false, error: 'bad id' };
  const dir = jobDir(ext_data_dir, id);
  const status = readStatus(ext_data_dir, id);
  if (!status) return { ok: false, error: '未找到该任务' };
  let events = '';
  try { events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'); } catch {}
  let script = '';
  try { script = fs.readFileSync(path.join(dir, 'script.md'), 'utf8'); } catch {}
  // media URL 前缀: /extension/<name>/media/<id>/<file>
  const mediaBase = `/extension/${extension_name}/media/${id}`;
  return {
    ok: true,
    status,
    mediaBase,
    events,
    script,
    artifacts: status.artifacts || null,
  };
}

// ---------- action: cancel ----------
function handleCancel({ ext_data_dir, ext_main_payload }) {
  const id = String((ext_main_payload && ext_main_payload.id) || '');
  if (!/^[a-z0-9]+$/i.test(id)) return { ok: false, error: 'bad id' };
  const dir = jobDir(ext_data_dir, id);
  const status = readJson(path.join(dir, 'status.json'), null);
  if (!status) return { ok: false, error: '未找到该任务' };
  if (status.state !== 'running') return { ok: true, status, note: '非运行中, 无需取消' };
  const pid = readJson(path.join(dir, 'pid.json'), null);
  if (pid && pidAlive(pid.pid)) {
    try { process.kill(-pid.pid); } catch { try { process.kill(pid.pid); } catch {} } // 杀进程组, 兜底单 pid
  }
  status.state = 'cancelled';
  status.error = '用户取消';
  status.updatedAt = new Date().toISOString();
  writeJson(path.join(dir, 'status.json'), status);
  return { ok: true, status };
}

// ---------- 入口 ----------
module.exports = async function ({ username, display_name, ext_main_payload, ext_data_dir, extension_name, logger }) {
  const action = ext_main_payload && ext_main_payload.action;
  try {
    if (!action || action === 'whoami') {
      const pw = discoverPlaywright();
      const ff = discoverFfmpeg();
      return {
        ok: true,
        service: 'recording-studio',
        username,
        display_name: display_name || username || '',
        deps: { playwright: !!pw, ffmpeg: !!ff, playwrightPath: pw || null, ffmpegPath: ff || null },
        desc: '录制导演 · 描述要展示的内容, 自动产出视频素材',
      };
    }
    if (action === 'start') return handleStart({ ext_data_dir, extension_name, username, ext_main_payload, logger });
    if (action === 'list') return handleList({ ext_data_dir });
    if (action === 'status') return handleStatus({ ext_data_dir, ext_main_payload });
    if (action === 'detail') return handleDetail({ ext_data_dir, extension_name, ext_main_payload });
    if (action === 'cancel') return handleCancel({ ext_data_dir, ext_main_payload });
    return { ok: false, error: 'unknown action' };
  } catch (e) {
    if (logger) logger.error(`[recording-studio] action=${action} error: ${e && e.message}`);
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
};
