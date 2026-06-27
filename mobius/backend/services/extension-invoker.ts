/**
 * extension-invoker.ts — /api/ext 的执行内核.
 *
 * 给定一个 registry entry 和调用上下文, 在隔离的 worker_thread 里跑
 *   mobius/extension/<name>/backend/extension_backend_handler.js
 *
 * 硬约束:
 *   - 30s 超时 → worker.terminate(), 返回 { __timeout: true }
 *   - 返回值序列化后 ≤ 5MB, 超出 → { __oversize: true }
 *   - 256MB old generation 内存上限 (worker_thread resourceLimits)
 *   - handler stateless: 每次新建 worker, 完全隔离的 require 缓存
 *   - 文件 IO: worker 启动时 chdir 到 ext_data_dir; 文档约束 handler 不能写别处.
 *     首版不在 worker 里 wrap fs (复杂度高/可绕过), 让 review 把关.
 *
 * 返回结构 (供 routes/ext.js invokeRouter 区分): {
 *   value?: <handler 返回的 JSON, 已序列化大小校验通过>,
 *   __timeout?: true,
 *   __oversize?: true,
 *   __error?: <handler 内抛错的 message>,
 * }
 *
 * 注: WORKER_BOOT_FILE 故意保持 .js — worker_thread 不继承主进程的 tsx 加载器,
 *     必须是 Node 能原生运行的 .js 引导脚本 (见 extension-invoker-worker.js).
 */
import * as path from 'path';
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import {
  EXTENSION_HANDLER_TIMEOUT_MS,
  EXTENSION_HANDLER_MAX_RESULT_BYTES,
} from '../config';

const WORKER_BOOT_FILE = path.join(__dirname, 'extension-invoker-worker.js');

function invokeHandler({ entry, username, display_name, ext_main_payload }: any): Promise<any> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout;

    // workerData 必须可结构化克隆, 已是 JSON 安全的对象
    const worker = new Worker(WORKER_BOOT_FILE, {
      workerData: {
        handler_path: entry.handler_path,
        ext_data_dir: entry.data_dir,
        ctx: {
          username,
          display_name: display_name || username,
          ext_main_payload,
          ext_data_dir: entry.data_dir,
          extension_name: entry.name,
        },
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        stackSizeMb: 4,
      },
      // worker 自己 stdout/stderr 透传到父进程, 方便排查
      stdout: false,
      stderr: false,
    });

    function done(payload: any): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { worker.terminate(); } catch { /* noop */ }
      resolve(payload);
    }

    worker.on('message', (msg: any) => {
      if (msg && msg.__kind === 'result') {
        // 大小校验: stringify 一次, 把序列化后字节数算清楚
        let serialized: string;
        try { serialized = JSON.stringify(msg.value); }
        catch (e) { return done({ __error: 'result not JSON-serializable: ' + e.message }); }
        if (Buffer.byteLength(serialized, 'utf8') > EXTENSION_HANDLER_MAX_RESULT_BYTES) {
          return done({ __oversize: true });
        }
        return done({ value: msg.value });
      }
      if (msg && msg.__kind === 'error') {
        return done({ __error: msg.message || 'handler error' });
      }
    });

    worker.on('error', (err: Error) => done({ __error: err.message }));
    worker.on('exit', (code: number) => {
      if (!settled) {
        // 没有 message 就退出 = handler 异常退出
        done({ __error: `worker exited with code ${code}` });
      }
    });

    timeout = setTimeout(() => done({ __timeout: true }), EXTENSION_HANDLER_TIMEOUT_MS);
  });
}

// 预跑期校验: handler 文件存在 (registry 阶段已校验, 这里二次保险, 防 race)
function preflight(entry: any): void {
  if (!fs.existsSync(entry.handler_path)) {
    throw new Error('handler 文件已消失: ' + entry.handler_path);
  }
}

export { invokeHandler, preflight };
