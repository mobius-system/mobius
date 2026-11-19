/*
 * localStorage budget guard shared by all regenerable front-end caches.
 *
 * Why this exists: code-server is proxied from the same origin (`/code-server/...`),
 * so its web workbench shares the browser's ~5MB localStorage quota with this app.
 * VS Code's saveStoredProfileAssociations() calls localStorage.setItem without any
 * try/catch, so once our caches fill the quota the code-server workbench throws
 * QuotaExceededError during initServices() and the editor never opens. Keep our own
 * caches inside a fixed budget and always leave a reserve for code-server.
 */

// 浏览器对同一 origin 的 localStorage 上限约 5MB (key+value 字符数总和).
// Chromium 实测可写 ~5.24M 字符, 取整留一点安全边界.
export const ORIGIN_STORAGE_LIMIT_CHARS = 5_200_000

// 预留给同源 code-server (workbench 的 profileAssociations 等写入无 try/catch).
const CODE_SERVER_RESERVE_CHARS = 2_000_000

// 打开 code-server 前用更宽松的余量, 给它写工作区状态留足空间.
const CODE_SERVER_OPEN_RESERVE_CHARS = 2_500_000

// 本前端所有可重建缓存的总预算.
const CACHE_BUDGET_CHARS = 1_500_000

// 只有「丢了能重建」的缓存才允许被清理; 草稿/自定义主题/令牌等用户数据永不清理.
const EVICTABLE_PREFIXES = [
  'mobius:list-cache:',
  'mobius:recent-sessions:',
  'mobius:session-input-history:',
]

type CacheEntry = { key: string; size: number; ts: number }

function isEvictableKey(key: string): boolean {
  return EVICTABLE_PREFIXES.some((prefix) => key.startsWith(prefix))
}

// 缓存负载里的 ts (毫秒) 决定淘汰顺序; 老格式 (裸数组) 没有 ts, 视为最老.
function readEntryTs(value: string): number {
  const match = /"ts"\s*:\s*(\d+)/.exec(value.slice(0, 160))
  return match ? Number(match[1]) : 0
}

/*
 * Scan localStorage once and report the total footprint plus evictable caches.
 */
function snapshotStorage(): { total: number; caches: CacheEntry[] } {
  const caches: CacheEntry[] = []
  let total = 0
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key) continue
    const value = localStorage.getItem(key) || ''
    const size = key.length + value.length
    total += size
    if (isEvictableKey(key)) caches.push({ key, size, ts: readEntryTs(value) })
  }
  return { total, caches }
}

export interface PruneOptions {
  cacheBudget?: number
  reserve?: number
}

/*
 * Evict the oldest caches until the cache budget and the code-server reserve
 * both hold. Safe to call at any time; a no-op when already inside budget.
 */
export function pruneStorageForQuota(options: PruneOptions = {}): { removed: number; freed: number } {
  if (typeof window === 'undefined') return { removed: 0, freed: 0 }
  try {
    const cacheBudget = options.cacheBudget ?? CACHE_BUDGET_CHARS
    const reserve = options.reserve ?? CODE_SERVER_RESERVE_CHARS
    const { total, caches } = snapshotStorage()
    let cacheTotal = caches.reduce((sum, entry) => sum + entry.size, 0)
    let usage = total
    if (cacheTotal <= cacheBudget && usage <= ORIGIN_STORAGE_LIMIT_CHARS - reserve) {
      return { removed: 0, freed: 0 }
    }
    caches.sort((a, b) => a.ts - b.ts)
    let removed = 0
    let freed = 0
    for (const entry of caches) {
      if (cacheTotal <= cacheBudget && usage <= ORIGIN_STORAGE_LIMIT_CHARS - reserve) break
      try {
        localStorage.removeItem(entry.key)
      } catch {
        continue
      }
      cacheTotal -= entry.size
      usage -= entry.size
      removed += 1
      freed += entry.size
    }
    return { removed, freed }
  } catch {
    return { removed: 0, freed: 0 }
  }
}

/*
 * Write path for regenerable caches: normal write, then one prune + retry when
 * the quota is already exhausted. Never throws.
 */
export function safeSetCacheItem(key: string, value: string): boolean {
  if (typeof window === 'undefined') return false
  if (value.length > CACHE_BUDGET_CHARS) return false
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    // 配额满: 先按预算清一轮再重试
    pruneStorageForQuota()
    try {
      localStorage.setItem(key, value)
      return true
    } catch {
      // 还不够: 把缓存压到刚写这条约两倍大小, 优先保证 code-server 能启动
      pruneStorageForQuota({ cacheBudget: Math.max(value.length * 2, 200_000), reserve: CODE_SERVER_RESERVE_CHARS })
      try {
        localStorage.setItem(key, value)
        return true
      } catch {
        return false
      }
    }
  }
}

let lastPrepareAt = 0

/*
 * Call right before handing a code-server URL to the browser: guarantees the
 * workbench has room to persist its own storage. Throttled because the URL
 * builders also run during React render.
 */
export function prepareStorageForCodeServer(): void {
  const now = Date.now()
  if (now - lastPrepareAt < 2000) return
  lastPrepareAt = now
  pruneStorageForQuota({ reserve: CODE_SERVER_OPEN_RESERVE_CHARS })
}
