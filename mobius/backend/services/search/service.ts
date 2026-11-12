import { fork, type ChildProcess } from 'child_process';
import path from 'path';
import { historyStorePath } from '../mobius-agent-history';
import type { IndexedSearchRequest } from './index';

type Source = { sessionId: string; path: string | null; backend: string };
let indexer: ChildProcess | null = null;
let reader: ChildProcess | null = null;
let sequence = 0;
let active: number | null = null;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
const requests = new Map<number, IndexedSearchRequest>();

function dispatch(): void {
  if (active != null || !requests.size) return;
  if (!reader?.connected) reader = spawn('reader');
  const [id, request] = requests.entries().next().value!;
  requests.delete(id);
  active = id;
  reader.send({ type: 'query', id, request });
}

function spawn(role: string): ChildProcess {
  const child = fork(path.join(__dirname, 'worker.ts'), [], {
    execArgv: ['--require', 'tsx/cjs'],
    env: { ...process.env, MOBIUS_AGENT_HISTORY_STORE_PATH: historyStorePath(), MOBIUS_SEARCH_WORKER: role },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.on('error', error => console.warn('[search] worker:', error.message));
  child.on('exit', () => {
    if (role === 'indexer') indexer = null;
    else {
      if (reader !== child) return;
      reader = null;
      if (active != null) {
        const item = pending.get(active);
        if (item) { clearTimeout(item.timer); item.reject(new Error('搜索进程已重启，请重试')); pending.delete(active); }
      }
      active = null;
      dispatch();
    }
  });
  child.on('message', (message: any) => {
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(message.id);
    active = null;
    if (message.error) item.reject(new Error(message.error));
    else item.resolve(message.result);
    dispatch();
  });
  return child;
}

export function refreshSearchSources(sources: Source[]): void {
  if (!indexer?.connected) indexer = spawn('indexer');
  indexer.send({ type: 'inventory', sources });
}

export function searchHistory(request: IndexedSearchRequest, signal: AbortSignal): Promise<any> {
  if (signal.aborted) return Promise.reject(new Error('搜索已取消'));
  if (pending.size >= 8) return Promise.reject(new Error('搜索繁忙，请稍后重试'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const cancel = () => {
      const item = pending.get(id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(id);
      requests.delete(id);
      signal.removeEventListener('abort', cancel);
      if (active === id) reader?.kill();
      reject(new Error(signal.aborted ? '搜索已取消' : '搜索超时，请缩小范围或增加关键词'));
    };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    const timer = setTimeout(cancel, 5000);
    pending.set(id, { timer, resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
    signal.addEventListener('abort', cancel, { once: true });
    requests.set(id, request);
    dispatch();
  });
}

export function stopSearchWorkers(): void {
  requests.clear();
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('搜索服务停止')); }
  pending.clear();
  indexer?.kill();
  reader?.kill();
}
