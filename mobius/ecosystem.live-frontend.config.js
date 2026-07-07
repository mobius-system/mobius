// 仅 `python3 start.py --live-frontend-debug` 加载本文件, 启动一个 Vite dev server (HMR),
// 让 mobius/frontend/src/** 的改动在浏览器里实时生效, 无需重新 `npm run build`。
//
// 生产部署 (start_product.py) 永远只 startOrReload 主 ecosystem.config.js, 不会触碰本文件,
// 所以线上不会多出一个 vite dev 进程。
//
// 与主 ecosystem.config.js 同构: 从 process.env 继承一组白名单键, 让 start.py 在
// `pm2 start ... --update-env` 前把 VITE_PORT / VITE_API_TARGET 等设进环境即可生效。
// 日志同样落在集中日志目录 (MOBIUS_LOG_DIR), 用 `pm2 logs mobius-system-vite-dev` 统一查看。
const path = require('path');

const mobiusDir = __dirname;
const LOG_DIR = process.env.MOBIUS_LOG_DIR || '/data/logs';

// 显式列出 vite dev 进程需要的键。故意不含 VITE_HMR_PROTOCOL / VITE_HMR_CLIENT_PORT:
// 直连访问 (http://host:<vite_port>) 时应让 vite 用默认 HMR (ws 同端口); 若继承 .env.default
// 的 wss:443, HMR 会去连一个不存在的 wss 端口导致热更新失效。
const envKeys = [
  'VITE_PORT',
  'VITE_HOST',
  'VITE_API_TARGET',
  'VITE_ALLOWED_HOSTS',
  'MOBIUS_PORT',
  'MOBIUS_LOG_DIR',
];

const inheritedEnv = {};
for (const key of envKeys) {
  if (process.env[key] !== undefined) inheritedEnv[key] = process.env[key];
}

module.exports = {
  apps: [
    {
      // Vite dev server (HMR)。直接跑 vite 的 ESM 入口, 不走 `npm run dev` 这一层,
      // 让 PM2 直接管理 vite 进程本身 (重启/停止/日志都更干净)。
      name: 'mobius-system-vite-dev',
      cwd: path.join(mobiusDir, 'frontend'),
      script: path.join(mobiusDir, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'),
      exec_mode: 'fork',
      instances: '1',
      autorestart: true,
      kill_timeout: 5000,
      max_memory_restart: '1G',
      out_file: path.join(LOG_DIR, 'mobius-vite-dev.log'),
      error_file: path.join(LOG_DIR, 'mobius-vite-dev-error.log'),
      merge_logs: true,
      env: {
        // NODE_ENV 放在 spread 之后, 确保始终是 development (不被继承值覆盖)。
        ...inheritedEnv,
        NODE_ENV: 'development',
      },
    },
  ],
};
