/**
 * claude-code-utils/runtime-store.ts — The in-process session map and the
 * three-level transcript lookup.
 *
 * The tmux windows outlive a backend restart, so the map is reloaded from
 * hub-runtime.json rather than rebuilt by spawning. Everything that answers
 * "where is this session's transcript" goes through resolveJsonlPath.
 */
import fs from 'fs'

import type { ClaudeBackendHost } from './types'
import { normalizeUseProxy } from './proxy'
import { watch as watchJsonlFile } from '../../services/jsonl-watcher'
const { log } = require('../tmux-operation-log')

/*
 * Attach the jsonl watcher that feeds this session's live output; new lines go to _emitRaw for all
 * subscribers. One watcher per session and never restarted while one is live.
 *
 * It starts at the current end of file on purpose: only the delta is pushed, because the history
 * store already holds the initial content and replaying the whole transcript would duplicate it.
 */
export function ensureWatcher(backend: ClaudeBackendHost, sessionId: string) {
  const entry = backend.runtime.get(sessionId)
  if (!entry?.jsonlPath || entry.watch) return
  // 取不到文件大小时从0开始，宁可重放也不要漏行
  // If the size cannot be read, start at 0 and replay rather than miss lines
  let startOffset = 0
  try { startOffset = fs.existsSync(entry.jsonlPath) ? fs.statSync(entry.jsonlPath).size : 0 } catch {}
  entry.watch = watchJsonlFile({
    path: entry.jsonlPath,
    startOffset,
    onEntry: (raw: any) => backend._emitRaw(sessionId, raw),
    onError: (e: unknown) => console.warn(`[tmux-claude-code/watch ${sessionId}] ${(e as Error)?.message || e}`),
  })
}

/*
 * Reload the sessionId → agentSessionId / jsonlPath map saved by the previous process, then attach
 * a watcher per surviving row.
 *
 * A row whose jsonl is already gone is dropped rather than resurrected: without the transcript the
 * session could never produce history, so it has to look brand new.
 */
export function restoreRuntime(backend: ClaudeBackendHost) {
  let total = 0
  for (const [sid, p] of Object.entries(backend.persisted) as Array<[string, any]>) {
    total++
    if (!p?.jsonlPath || !fs.existsSync(p.jsonlPath)) {
      log(`[tmux-claude-code] runtime 条目 ${sid} 被丢弃 (jsonl 缺失: ${p?.jsonlPath})`)
      continue
    }
    backend.runtime.set(sid, {
      agentSessionId: p.agentSessionId || null,
      cwd: p.cwd,
      flagRoot: p.flagRoot || p.cwd,
      model: p.model || null,
      // 老行没有规范化标记，缺省按"配了代理"处理
      // Old rows carry no normalized flag; absent means "proxy configured"
      useProxy: normalizeUseProxy(p.useProxy, true),
      settingsPath: p.settingsPath || null,
      forceNoProxy: !!p.forceNoProxy,
      displayName: p.displayName || null,
      jsonlPath: p.jsonlPath,
      startedAt: p.startedAt || 0,
      watch: null,
    })
    ensureWatcher(backend, sid)
  }
  log(`[tmux-claude-code] runtime 加载 ${backend.runtime.size}/${total} 条`)
}

/*
 * Three-level lookup for sessionId → jsonl file path:
 *   - runtime   the in-process Map, sessions currently alive
 *   - persisted hub-runtime.json, live rows, cleared on terminate
 *   - archive   hub-archive.json, every session ever started and kept past terminate, which is how
 *               history still resolves after an admin closes the window or a cleaner reaps it
 */
export function resolveJsonlPath(backend: ClaudeBackendHost, sessionId: string): string | null {
  return backend.runtime.get(sessionId)?.jsonlPath
      || backend._lookupPersistedJsonlPath(sessionId)
      || backend._lookupArchivedJsonlPath(sessionId)
      || null
}

/*
 * The text of every still-queued request, in enqueue order. Shared by getHistory and the round
 * writer so both see the same "open round" evidence.
 */
export function pendingInputTexts(backend: ClaudeBackendHost, sessionId: string): string[] {
  return backend.getPendingRequests(sessionId)
    .map((item: any) => typeof item === 'string' ? item : item?.content)
    .filter((item): item is string => typeof item === 'string')
}
