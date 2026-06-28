const path = require('path');

const TEST_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_MODEL_KEY = 'codex';
const DEFAULT_AGENT_BACKEND = 'tmux-codex';

// 工作区根: 每个用户的 work_dir = WORKSPACE_ROOT/<userId>,
// 新建项目的 bind_path 必须落在该用户 work_dir 之内 (见 routes/projects.js resolveBindPath)。
// 容器默认把持久化工作区放在 /data/workspace; 现有部署通过 .env 显式覆盖旧路径以免迁移。
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/data/workspace';
function workDirFor(userId) {
  return path.join(WORKSPACE_ROOT, String(userId));
}

// 员工账号默认工作区父目录。容器默认仍在 /data/workspace 下; 当前本机部署
// 通过 .env 覆盖为 /home, 保留 /home/<userId>/cc-workspace 语义。
const HOME_WORKSPACE_ROOT = process.env.HOME_WORKSPACE_ROOT || path.join(WORKSPACE_ROOT, 'home');
function homeWorkDirFor(userId) {
  return path.join(HOME_WORKSPACE_ROOT, String(userId), 'cc-workspace');
}

function defaultLocalWorkspaceRoot() {
  return path.join(WORKSPACE_ROOT, '_employees');
}

const LOCAL_WORKSPACE_ROOT = process.env.LOCAL_WORKSPACE_ROOT || defaultLocalWorkspaceRoot();
function fallbackWorkDirFor(userId) {
  return path.join(LOCAL_WORKSPACE_ROOT, String(userId));
}
const LEGACY_LOCAL_WORKSPACE_ROOT = path.join(TEST_ROOT, 'workspace');
function legacyFallbackWorkDirFor(userId) {
  return path.join(LEGACY_LOCAL_WORKSPACE_ROOT, String(userId));
}

const MOBIUS_DATA_PATH = process.env.MOBIUS_DATA_PATH || '/data';

// 莫比乌斯在项目仓库根 / 工作目录下使用的"隐藏工作缓存目录"名 (.imac / .mobius ...).
// 单一真相源: 后端所有 path.join(root, '.imac', ...) 都应使用本常量, 不要再硬编码 '.imac'.
// 由 .env 注入: 新装默认 .mobius (.env.default), 旧部署可保留 .imac (.env) 以免数据迁移.
const HIDDEN_FOLDER_NAME = process.env.MOBIUS_HIDDEN_FOLDER_NAME || '.mobius';

// Branding: 顶部 Logo / 系统名称 / Tab 标题显示控制, 由 .env 注入, 不进管理面板.
//   hideLogo:        直接控制 Logo 图片是否渲染
//   systemNameZh:    若 REPLACE_SYSTEM_NAME=true 用 env 值, 否则用硬编码默认; 同时用作 Tab 标题
//   systemNameEn:    若 REPLACE_SYSTEM_NAME=true 用 env 值, 否则用硬编码默认
// 替换模式下留空字符串即可"隐藏"对应位置的文字.
const DEFAULT_BRANDING_ZH = '莫比乌斯AI';
const DEFAULT_BRANDING_EN = 'Mobius';
const BRANDING_REPLACE_SYSTEM_NAME = process.env.MOBIUS_ADVANCED_REPLACE_SYSTEM_NAME === 'true';
const BRANDING = Object.freeze({
  hideLogo: process.env.MOBIUS_ADVANCED_HIDE_LOGO === 'true',
  systemNameZh: BRANDING_REPLACE_SYSTEM_NAME
    ? String(process.env.MOBIUS_ADVANCED_REPLACE_SYSTEM_NAME_ZH ?? '')
    : DEFAULT_BRANDING_ZH,
  systemNameEn: BRANDING_REPLACE_SYSTEM_NAME
    ? String(process.env.MOBIUS_ADVANCED_REPLACE_SYSTEM_NAME_EN ?? '')
    : DEFAULT_BRANDING_EN,
});
const CORE_DATA_PATH = process.env.CORE_DATA_PATH || '/data/protected_data';
const MODEL_ACCESS_PATH = process.env.MODEL_ACCESS_PATH || path.join(MOBIUS_DATA_PATH, 'model-access.json');
const BACKEND_WORKER_LOG_DIR = path.join(CORE_DATA_PATH, 'backend_worker_log');

// 黑客帝国数字雨 · token 中转代理监听地址 (独立 pm2 进程 mobius-system-tokenproxy).
// .withproxy.json 会把 ANTHROPIC_BASE_URL 指向这里, server.ts 解码后转发到真实上游.
// 仅 127.0.0.1 loopback. 三道闸: boot_utils RUNTIME_SETTINGS + ecosystem envKeys + 本处.
const TOKEN_PROXY_HOST = process.env.MOBIUS_TOKEN_PROXY_HOST || '127.0.0.1';
const TOKEN_PROXY_PORT = parseInt(process.env.MOBIUS_TOKEN_PROXY_PORT || '45630', 10);
const TOKEN_PROXY_BASE_URL = `http://${TOKEN_PROXY_HOST}:${TOKEN_PROXY_PORT}`;

function parseMobiusSshPort(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (!/^[0-9]{1,5}$/.test(text)) return null;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 443) return null;
  return port;
}

const MOBIUS_SSH_FORWARD_USER = String(process.env.MOBIUS_SSH_FORWARD_USER || 'mobius-forward').trim() || 'mobius-forward';
const MOBIUS_SSH_PORT = parseMobiusSshPort(process.env.MOBIUS_SSH_PORT || '33318');
const MOBIUS_SSH_URL = String(process.env.MOBIUS_SSH_URL || (MOBIUS_SSH_PORT ? `localhost:${MOBIUS_SSH_PORT}` : '')).trim();
const MOBIUS_SSH_FORWARD_DIR = process.env.MOBIUS_SSH_FORWARD_DIR || path.join(CORE_DATA_PATH, 'ssh-forward');
const MOBIUS_SSH_PRIVATE_KEY_PATH = process.env.MOBIUS_SSH_PRIVATE_KEY_PATH
  || process.env.MOBIUS_SSH_KEY_PATH
  || path.join(MOBIUS_SSH_FORWARD_DIR, 'mobius-forward-ed25519');
const MODEL_OPTIONS = {
  opus: {
    id: 'opus-4.8',
    backend: 'tmux-claude-code',
    label: 'Opus',
  },
  codex: {
    id: 'gpt-5.5',
    // Codex 渠道必须是纯英文字母; 配套 TOML: ~/.codex/mobiusdefault.config.toml.
    profileKey: 'mobiusdefault',
    secretEnvKey: 'RIGHTCODE_API_KEY',
    backend: 'tmux-codex',
    label: 'GPT-5.5 (Codex)',
  },
};
const MODELS = Object.fromEntries(Object.entries(MODEL_OPTIONS).map(([key, value]) => [key, value.id]));
const LEGACY_MODEL_KEY_ALIASES = Object.freeze({
  'codex:gpt-5.5': 'codex',
  'claude-opus-4-7': 'opus',
});

function modelKeyFor(modelOrKey) {
  const raw = String(modelOrKey || '').trim();
  const normalized = LEGACY_MODEL_KEY_ALIASES[raw] || raw;
  if (MODEL_OPTIONS[normalized]) return normalized;
  return Object.keys(MODEL_OPTIONS).find((key) => MODEL_OPTIONS[key].id === normalized) || null;
}

function backendNameForModel(modelOrKey) {
  const key = modelKeyFor(modelOrKey);
  return key ? MODEL_OPTIONS[key].backend : DEFAULT_AGENT_BACKEND;
}

module.exports = {
  PORT: parseInt(process.env.MOBIUS_PORT || '45614', 10),
  MOBIUS_DATA_PATH,
  DB_PATH: process.env.DB_PATH || path.join(MOBIUS_DATA_PATH, 'mobuis.db'),
  MODEL_ACCESS_PATH,
  CORE_DATA_PATH,
  BACKEND_WORKER_LOG_DIR,
  // JWT_SECRET 必须通过环境变量设置，禁止使用默认值以防 token 伪造。
  // 在 .env 中设置：JWT_SECRET=<随机生成的长字符串>
  // 生成命令：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  JWT_SECRET: (() => {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.startsWith('change-me')) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('[config] JWT_SECRET 未设置或仍为占位符，生产环境拒绝启动。请在 .env 中配置随机强密钥。');
      }
      console.warn('[config] ⚠️  JWT_SECRET 未设置，将使用临时随机值（每次重启会失效，请尽快在 .env 中配置）。');
      return require('crypto').randomBytes(32).toString('hex');
    }
    return secret;
  })(),
  // 默认关闭密码校验; 设为 'true' 可重新启用密码登录
  ENABLE_PASSWORD_LOGIN: process.env.ENABLE_PASSWORD_LOGIN === 'true',
  // VSCode Web (code-server) 基础 URL, 例: http://localhost:8443. 留空则前端不展示"在 VSCode 打开"按钮.
  VSCODE_WEB_URL: process.env.VSCODE_WEB_URL || '',
  // SSH local-forward 入口: MOBIUS_SSH_URL 是用户 PC 可访问的 host:port, MOBIUS_SSH_PORT 是服务端监听端口。
  // 443 被显式禁用, 避免和 HTTPS 网关语义混淆。
  MOBIUS_SSH_PORT,
  MOBIUS_SSH_URL,
  MOBIUS_SSH_FORWARD_USER,
  MOBIUS_SSH_FORWARD_DIR,
  MOBIUS_SSH_PRIVATE_KEY_PATH,
  parseMobiusSshPort,
  UPLOAD_DIR: path.join(__dirname, '..', 'uploads'),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
  TURNS_SUMMARY_DIR: process.env.TURNS_SUMMARY_DIR || path.join(MOBIUS_DATA_PATH, 'turn-summaries'),

  // Branding: 顶部 Logo / 系统名称 / Tab 标题. 由 .env 控制, 不可前端修改.
  BRANDING,

  // 新建 Session 可选模型: 前端传短键(opus/codex), 后端映射到完整 model id.
  // backend 由 model id 派生, 旧 Claude session 不需要改 DB schema.
  MODEL_OPTIONS,
  MODELS,
  LEGACY_MODEL_KEY_ALIASES,
  DEFAULT_MODEL_KEY,
  DEFAULT_AGENT_BACKEND,
  modelKeyFor,
  backendNameForModel,

  WORKSPACE_ROOT,
  workDirFor,
  HOME_WORKSPACE_ROOT,
  homeWorkDirFor,
  LOCAL_WORKSPACE_ROOT,
  fallbackWorkDirFor,
  LEGACY_LOCAL_WORKSPACE_ROOT,
  legacyFallbackWorkDirFor,

  // 拓展系统: APP_DIR = TEST_ROOT (mobius 源码所在仓库根). 特殊拓展项目的 bind_path
  // 锁死指向这里, 不启用 worktree / research. 拓展代码扫描 mobius/extension/*/,
  // 拓展数据落到 CORE_DATA_PATH/extension/<name>/ (handler 唯一可写区).
  APP_DIR: TEST_ROOT,
  // 隐藏工作缓存目录名 (.imac / .mobius). 后端组装 <root>/<HIDDEN_FOLDER_NAME>/... 路径时统一用它.
  HIDDEN_FOLDER_NAME,
  EXTENSION_ROOT: path.join(TEST_ROOT, 'mobius', 'extension'),
  EXTENSION_DATA_ROOT: path.join(CORE_DATA_PATH, 'extension'),
  // upsert 拓展项目时挂的"系统"用户; 由 extension-registry 在启动时 INSERT OR IGNORE.
  EXTENSION_SYSTEM_USER_ID: 'system',
  // /api/ext 调用限制
  EXTENSION_HANDLER_TIMEOUT_MS: 30_000,
  EXTENSION_HANDLER_MAX_RESULT_BYTES: 5 * 1024 * 1024,
  EXTENSION_HANDLER_MAX_PAYLOAD_BYTES: 1 * 1024 * 1024,
  EXTENSION_INVOKE_RATE_PER_SEC: 5,

  // forgotten-flag-scanner 检测到 "agent 停工但 running.flag 未删" 时, 自动发给
  // 该 session 的默认提醒文案 (单一真相源). 项目可在设置里用 forgotten_flag_message
  // 覆盖; 前端把本文案预填进输入框, 清空保存 → 存 NULL → scanner 仍回退到这里.
  DEFAULT_FORGOTTEN_FLAG_MESSAGE:
    '[A message that comes from the system, not the user]: ' +
    'It seems that the running flag is still present, did you encounter any problems? ' +
    '(1) If you cannot solve the problem, please delete `running.flag` and add a `failed.flag`. ' +
    '(2) If you have already finished the job and forgot about the flag, delete it. ' +
    '(3) If you are waiting for some callback or schedule, just state what you are waiting for and keep waiting.',
  DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES: 10,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES: 30,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF: 2,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF: 5,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE: 3,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE: 5,
  FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES_MIN: 1,
  FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES_MIN: 30,
  FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX: 7 * 24 * 60,
  FORGOTTEN_FLAG_BACKOFF_MIN: 1,
  FORGOTTEN_FLAG_BACKOFF_MAX: 100,
  FORGOTTEN_FLAG_PATIENCE_MIN: 1,
  FORGOTTEN_FLAG_PATIENCE_MAX: 1000,

  // 黑客帝国数字雨 · token 中转代理 (mobius-system-tokenproxy).
  TOKEN_PROXY_HOST,
  TOKEN_PROXY_PORT,
  TOKEN_PROXY_BASE_URL,

  TEST_ROOT,
};
