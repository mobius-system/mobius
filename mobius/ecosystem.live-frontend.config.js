//
//
const path = require('path');

const mobiusDir = __dirname;
const LOG_DIR = process.env.MOBIUS_LOG_DIR || '/data/logs';

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
        ...inheritedEnv,
        NODE_ENV: 'development',
      },
    },
  ],
};
