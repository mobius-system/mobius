'use strict';
/**
 * pm2-entrypoint.js — PM2 cluster-mode 启动包装器 (MOBIUS_PM2_ENTRYPOINT 指向这里)。
 *
 * 为什么需要它: PM2 cluster 模式下, worker 在 require() 阶段同步抛错时 (典型例子是
 * backend/config.js 的生产环境配置守卫, 例如 JWT_SECRET 仍是 change-me 占位符),
 * 错误往往来不及经 cluster IPC 写进 error_file —— 表现为 error log 0 字节、
 * PM2 面板 status=errored 却没有任何线索, 后端陷入静默崩溃循环, 极难排查。
 *
 * 本包装器在 require('./server.js') 外层兜底: 任何启动期同步错误都会被
 * 同步 (appendFileSync) 追加写进集中日志目录的 mobius-server-error.log, 并打到 stderr。
 * 同步写保证即使 PM2 的 stderr 管道没接好, 文件里也一定留得下根因。
 * 该日志目录默认 /data/logs, 被 docker-compose 挂载到宿主机, 宿主机可直接查看。
 *
 * 运行正常时本包装器对行为无影响: require 成功后 server.js 调用 listen 进入事件循环,
 * 脚本顶层同步执行结束, 进程靠监听的 server 保持存活。
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.MOBIUS_LOG_DIR || '/data/logs';
const ERROR_LOG = path.join(LOG_DIR, 'mobius-server-error.log');

function recordBootFailure(err) {
  const detail = (err && (err.stack || err.message)) || String(err);
  const msg = `[pm2-entrypoint][${new Date().toISOString()}] BOOT_FAILURE: ${detail}\n`;
  // 同步写: 即使下面 process.exit(1) 之前 PM2 管道没刷新, 文件里也一定有这条。
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(ERROR_LOG, msg);
  } catch (_) {
    // 日志写不动也不能挡住退出; stderr 再兜一次底。
  }
  try {
    process.stderr.write(msg);
  } catch (_) {
    /* ignore */
  }
}

// 启动前清理: IDE (tsserver) 偶发自动 emit 的 .js 会遮蔽 .ts 源码 ——
// 在 tsx 运行时下, CommonJS require('./x') 优先解析到 x.js, 而 .ts 文件里的
// import 会解析到 x.ts, 于是同一逻辑模块被加载成两个独立实例 (各自内存状态不共享).
// 典型后果: extension-registry 双实例 → server.js 的 reload() 填了 .js 实例,
// 而 ext.ts 的 serveExtension 读的是空的 .ts 实例 → 所有拓展 "extension not found".
// 这些 .ts 模块的 .js 产物在 .gitignore 中本就被忽略, 启动时幂等清理以防复发.
function clearEmittedTsShadows() {
  const dirs = ['backend/services', 'backend/repositories', 'backend/types'];
  for (const rel of dirs) {
    const dir = path.join(__dirname, rel);
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names) {
      if (!name.endsWith('.js')) continue;
      const jsPath = path.join(dir, name);
      const tsPath = jsPath.slice(0, -3) + '.ts';
      try { if (fs.existsSync(tsPath)) fs.unlinkSync(jsPath); } catch (_) { /* noop */ }
    }
  }
  const dbJs = path.join(__dirname, 'db.js');
  const dbTs = path.join(__dirname, 'db.ts');
  try { if (fs.existsSync(dbJs) && fs.existsSync(dbTs)) fs.unlinkSync(dbJs); } catch (_) { /* noop */ }
}
clearEmittedTsShadows();

// 运行期兜底: 异步路由 / 后台任务里未捕获的 Promise rejection 默认会让 Node 18 直接终止
// worker 进程, PM2 随即重启 —— 这会瞬间杀掉所有正在进行的 SSE 长连接
// (GET /api/sessions/:id/events), 浏览器侧表现为 ERR_HTTP2_PROTOCOL_ERROR
// (nginx 侧日志: "upstream prematurely closed connection while reading upstream").
// 这里统一记录后吞掉, 避免单个请求的异常拖垮全局长连接; 真正的 bug 仍写进错误日志可见,
// 不会静默丢失. 进程真到内存上限时由 PM2 max_memory_restart 兜底重启.
function recordRuntimeError(tag, reason) {
  const detail = (reason && (reason.stack || reason.message)) || String(reason);
  const msg = `[${new Date().toISOString()}] ${tag}(swallowed): ${detail}\n`;
  try { fs.appendFileSync(ERROR_LOG, msg); } catch (_) { /* ignore */ }
  try { process.stderr.write(msg); } catch (_) { /* ignore */ }
}
process.on('unhandledRejection', (reason) => recordRuntimeError('unhandledRejection', reason));
process.on('uncaughtException', (err) => recordRuntimeError('uncaughtException', err));

try {
  require('./server.js');
} catch (err) {
  recordBootFailure(err);
  process.exit(1);
}
