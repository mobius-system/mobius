const path = require('path');

const mobiusDir = __dirname;
const entrypoint = process.env.MOBIUS_PM2_ENTRYPOINT || path.join(mobiusDir, 'pm2-entrypoint.js');
const instances = process.env.MOBIUS_PM2_INSTANCES || '1';
// v1.9 起数据层 (db.ts + backend/repositories/*.ts) 已迁移到 TypeScript, 后端运行时
// 通过 tsx/cjs 即时转译 .ts, 无需构建步骤. PM2 cluster 模式下 worker 会继承
// interpreter_args, 所以 --require tsx/cjs 在 master 和 worker 都生效.
// 不能直接把 interpreter 设为 tsx 二进制: PM2 cluster 模式不向 worker 传递自定义
// interpreter, 会导致 worker 仍用 node 加载 .ts 文件而失败.
const tsxHook = process.env.MOBIUS_TSX_HOOK || `tsx/cjs`;
// 集中日志目录: 默认 /data/logs, 被 docker-compose 挂载到宿主机 (./host-data/data/logs)。
// 所有 PM2 out/error_file 都落在这里, 宿主机可直接查看, 无需 docker exec。
const LOG_DIR = process.env.MOBIUS_LOG_DIR || '/data/logs';

const envKeys = [
  'APP_DIR',
  'MOBIUS_HIDDEN_FOLDER_NAME',
  'MOBIUS_PORT',
  'VITE_PORT',
  'VITE_HOST',
  'VITE_ALLOWED_HOSTS',
  'VITE_API_TARGET',
  'VITE_HMR_PROTOCOL',
  'VITE_HMR_CLIENT_PORT',
  'CODE_SERVER_PORT',
  'MOBIUS_SSH_PORT',
  'MOBIUS_SSH_URL',
  'MOBIUS_SSH_FORWARD_USER',
  'MOBIUS_SSH_FORWARD_DIR',
  'MOBIUS_SSH_PRIVATE_KEY_PATH',
  'MOBIUS_SSH_KEY_PATH',
  'CODE_SERVER_BIND',
  'CODE_SERVER_CWD',
  'VSCODE_WEB_URL',
  'CS_BIN',
  'CODE_SERVER_DATA_ROOT',
  'CS_DATA_ROOT',
  'CS_EXT_ROOT',
  'DB_PATH',
  'MOBIUS_DATA_PATH',
  'MODEL_ACCESS_PATH',
  'CORE_DATA_PATH',
  'JWT_SECRET',
  'ENABLE_PASSWORD_LOGIN',
  'WORKSPACE_ROOT',
  'HOME_WORKSPACE_ROOT',
  'LOCAL_WORKSPACE_ROOT',
  'TURNS_SUMMARY_DIR',
  'CODEX_HOME',
  'MOBIUS_DEBUG_ENV_FILE',
  'MOBIUS_SKILLS_PROXY',
  'MOBIUS_SKILLS_NO_PROXY',
  'MOBIUS_TMUX_AGENT_INACTIVE_MS',
  'MOBIUS_TMUX_AGENT_CLEANUP_INTERVAL_MS',
  'MOBIUS_TMUX_AGENT_CLEANUP_FIRST_DELAY_MS',
  'CS_PORT_BASE',
  'CS_POOL_MAX',
  'CS_IDLE_TIMEOUT_MIN',
  'CS_MAX_PER_USER',
  'CS_MAX_TOTAL',
  'CS_READY_TIMEOUT_MS',
  'MOBIUS_BOOTSTRAP_USERS',
  'NPM_REGISTRY',
  'MOBIUS_OTHER_VERSION_HASH',
  'MOBIUS_OTHER_VERSION_WORKTREE',
  'AIMUX_BRIDGE_HOST',
  'AIMUX_BRIDGE_PORT',
  'AIMUX_BRIDGE_RUNTIME',
  'MOBIUS_LOG_DIR',
  'MOBIUS_TOKEN_PROXY_HOST',
  'MOBIUS_TOKEN_PROXY_PORT',
];

const inheritedEnv = {};
for (const key of envKeys) {
  if (process.env[key] !== undefined) inheritedEnv[key] = process.env[key];
}

module.exports = {
  apps: [
    {
      name: 'imac-mobius',
      cwd: mobiusDir,
      script: entrypoint,
      interpreter_args: `--require ${tsxHook}`,
      exec_mode: 'cluster',
      instances,
      autorestart: true,
      kill_timeout: 8000,
      listen_timeout: 10000,
      max_memory_restart: process.env.MOBIUS_PM2_MAX_MEMORY || '1G',
      out_file: path.join(LOG_DIR, 'mobius-server.log'),
      error_file: path.join(LOG_DIR, 'mobius-server-error.log'),
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        ...inheritedEnv,
      },
    },
    {
      // aimux bridge broker: 反向 SSE broker, 客户端 (windows/外部机器) 反向连进来,
      // mobius 后端 /aimux_bridge/* 反代到本进程. runtime.json 由它自己写入 AIMUX_BRIDGE_RUNTIME.
      name: 'imac-mobius-bridge',
      cwd: mobiusDir,
      script: path.join(mobiusDir, '.venv-aimux', 'bin', 'aimux'),
      args: `bridge deploy --host ${process.env.AIMUX_BRIDGE_HOST || '127.0.0.1'} --port ${process.env.AIMUX_BRIDGE_PORT || '33315'}`,
      interpreter: 'none',
      exec_mode: 'fork',
      autorestart: true,
      kill_timeout: 5000,
      max_memory_restart: '256M',
      out_file: path.join(LOG_DIR, 'mobius-bridge.log'),
      error_file: path.join(LOG_DIR, 'mobius-bridge-error.log'),
      merge_logs: true,
      env: {
        ...inheritedEnv,
      },
    },
    {
      // 黑客帝国数字雨 · token 中转代理 (server.ts). cc 用 .withproxy.json 把请求发到
      // 127.0.0.1:MOBIUS_TOKEN_PROXY_PORT, 本进程解码 mpx1. token 后转发到真实模型上游,
      // 流式回传给 cc 的同时旁路抓取 text_delta 到环形缓冲, /token_stream 供数字雨消费.
      // 隔离为独立进程: 流式转发不压主后端单 worker 事件循环.
      name: 'imac-mobius-tokenproxy',
      cwd: mobiusDir,
      script: path.join(mobiusDir, 'backend', 'token-proxy', 'entry.js'),
      interpreter_args: `--require ${tsxHook}`,
      exec_mode: 'fork',
      instances: '1',
      autorestart: true,
      kill_timeout: 5000,
      max_memory_restart: '256M',
      out_file: path.join(LOG_DIR, 'mobius-token-proxy.log'),
      error_file: path.join(LOG_DIR, 'mobius-token-proxy-error.log'),
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        ...inheritedEnv,
      },
    },
  ],
};
