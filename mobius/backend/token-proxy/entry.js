/**
 * token-proxy/entry.js — pm2 入口 (CommonJS).
 * 主后端通过 pm2-entrypoint.js → server.js → require('.ts') 加载 TS 路由;
 * 这里沿用同一套路: pm2 用 `node --require tsx/cjs entry.js` 启动,
 * 由 tsx/cjs 的 require hook 解析 server.ts.
 */
require('./server.ts')
