/**
 * extension-invoker-worker.js — worker_thread 引导脚本.
 *
 * 在隔离的 worker 内:
 *   1. mkdir -p ext_data_dir (handler 第一次跑时即可写)
 *   2. require handler 模块
 *   3. 调用 handler(ctx), 把 promise 解析结果回传父线程
 *
 * 注意: 不在 worker 里 chdir(ext_data_dir) -- worker_thread 禁用 process.chdir.
 * handler 拿到的 ctx.ext_data_dir 就是绝对路径, 必须用 path.join(ext_data_dir, ...) 拼.
 *
 * 任何抛错或 reject → postMessage({__kind:'error', message})
 * 正常返回 → postMessage({__kind:'result', value})
 *
 * 注意: handler 是 require 进来的, worker 内的 require 缓存与主进程隔离.
 * worker 一次性使用, 不复用; handler 必须 stateless.
 */
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

// handler (拓展后端脚本) 可能 require 仓库内的 .ts 模块 (agents 层已迁 TS). worker 不经
// pm2 的 tsx --require 链启动, 这里自行挂 tsx 转译 hook; 装了就能 require .ts, 没装则维持
// 纯 JS 行为 (拓展 handler 只要不引用 .ts 就不受影响).
try { require('tsx/cjs'); } catch (_) { /* tsx 不可用 → handler 需自保证纯 JS */ }

async function main() {
  const { handler_path, ext_data_dir, ctx } = workerData;

  // mkdir -p (registry 已经建过, 兜底); 不 chdir (worker_thread 禁用)
  try { fs.mkdirSync(ext_data_dir, { recursive: true }); } catch { /* noop */ }

  let handlerFn;
  try {
    // 清理 require 缓存以确保拿最新代码 (registry 那边也按 mtime 失效, 双保险)
    delete require.cache[require.resolve(handler_path)];
    handlerFn = require(handler_path);
  } catch (e) {
    parentPort.postMessage({ __kind: 'error', message: 'require handler 失败: ' + e.message });
    return;
  }
  if (typeof handlerFn !== 'function') {
    parentPort.postMessage({ __kind: 'error', message: 'handler 必须 module.exports 一个函数' });
    return;
  }

  // 给 handler 注入 logger, 写到 _handler.log (在 ext_data_dir 下)
  const logFile = path.join(ext_data_dir, '_handler.log');
  function logLine(level, args) {
    try {
      const line = `[${new Date().toISOString()}] [${level}] ` + args.map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ') + '\n';
      fs.appendFileSync(logFile, line);
    } catch { /* noop */ }
  }
  const logger = {
    info:  (...a) => logLine('info', a),
    warn:  (...a) => logLine('warn', a),
    error: (...a) => logLine('error', a),
  };

  try {
    const value = await handlerFn({ ...ctx, logger });
    parentPort.postMessage({ __kind: 'result', value });
  } catch (e) {
    parentPort.postMessage({ __kind: 'error', message: e && e.message ? e.message : String(e) });
  }
}

main();
