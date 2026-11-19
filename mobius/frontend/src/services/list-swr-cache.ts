// 列表级本地缓存 (stale-while-revalidate): 新标签页/整页刷新时先秒显本地缓存,
// 后台静默刷新。背景: /u/:user 与 /u/:user/p/:project 的数据此前只有 zustand 内存
// 缓存, 顶栏用户名面包屑 newTab 行为(期望行为)每次开新 JS 上下文, 内存缓存永远
// miss → 每次都白屏等 API 1-2s。本模块把「已排序的最终列表」落到 localStorage,
// 下次进入同页时立即渲染, 网络回来后无感更新。
//
// 与 shell.tsx 里 RecentSessionsPanel 的私有缓存同款模式, 抽出来给页面级列表复用:
//   - 按用户隔离 key (不同账号互不可见);
//   - 写入失败 (配额满/隐私模式) 静默忽略, 不影响主流程;
//   - 写入统一走 storage-budget 的 safeSetCacheItem: 配额满时先清理同类缓存再重试,
//     保证同源 code-server 始终有 localStorage 余量;
//   - 只缓存数组本体, 损坏/超限时读侧直接判 miss。
//
// 两个变体:
//   - readListCache / writeListCache: 整份列表 (项目列表 / 某项目下的 issues);
//   - readMapCache / writeMapCache: id -> 记录 的映射, 供「一批卡片各拉一份概览」的场景
//     (UserPage 项目卡片的研究/任务概览) 复用同一套 key 约定与失败策略。
import { safeSetCacheItem } from './storage-budget'

// 单列表缓存上限 (字符数): projects 全量 ~600KB. 同源 code-server 也要用 localStorage,
// 单条缓存不再允许吃满大半配额 (见 services/storage-budget.ts)。
const MAX_CACHE_CHARS = 800_000

// 映射缓存的键数上限: 卡片概览单条约 1.6KB, 96 条约 150KB, 避免长期浏览后无限增长。
const MAX_MAP_KEYS = 96

export interface ListCacheEntry<T> {
  ts: number
  list: T[]
}

export interface MapCacheEntry<T> {
  ts: number
  map: Record<string, T>
}

function cacheKey(scope: string, userId?: string): string {
  return userId ? `mobius:list-cache:${scope}:${userId}` : ''
}

export function readListCache<T>(scope: string, userId?: string): ListCacheEntry<T> | null {
  const key = cacheKey(scope, userId)
  if (!key || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.ts !== 'number' || !Array.isArray(parsed.list)) return null
    return { ts: parsed.ts, list: parsed.list as T[] }
  } catch {
    return null
  }
}

export function writeListCache<T>(scope: string, userId: string | undefined, list: T[]): void {
  const key = cacheKey(scope, userId)
  if (!key || typeof window === 'undefined') return
  try {
    const payload = JSON.stringify({ ts: Date.now(), list })
    if (payload.length > MAX_CACHE_CHARS) return
    safeSetCacheItem(key, payload)
  } catch {
    /* 配额满或隐私模式: 忽略 */
  }
}

export function readMapCache<T>(scope: string, userId?: string): MapCacheEntry<T> | null {
  const key = cacheKey(scope, userId)
  if (!key || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.ts !== 'number' || !parsed.map || typeof parsed.map !== 'object' || Array.isArray(parsed.map)) return null
    return { ts: parsed.ts, map: parsed.map as Record<string, T> }
  } catch {
    return null
  }
}

// fresh 中的键视为最近使用, 排在保留序列最前; 超出 MAX_MAP_KEYS 时丢弃最久未更新的键。
export function writeMapCache<T>(scope: string, userId: string | undefined, fresh: Record<string, T>): void {
  const key = cacheKey(scope, userId)
  if (!key || typeof window === 'undefined') return
  try {
    const prev = readMapCache<T>(scope, userId)?.map || {}
    const merged: Record<string, T> = { ...fresh }
    Object.keys(prev).forEach((id) => { if (!(id in merged)) merged[id] = prev[id] })
    const map: Record<string, T> = {}
    Object.keys(merged).slice(0, MAX_MAP_KEYS).forEach((id) => { map[id] = merged[id] })
    const payload = JSON.stringify({ ts: Date.now(), map })
    if (payload.length > MAX_CACHE_CHARS) return
    safeSetCacheItem(key, payload)
  } catch {
    /* 配额满或隐私模式: 忽略 */
  }
}
