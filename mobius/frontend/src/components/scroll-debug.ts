// scroll-debug.ts — 滚动/追底调试. 两条出口, 共用同一批调用点:
//   ① F12 控制台输入 `debug_scroll` 开启实时 console 日志 (输入 `debug_scroll = false` 关闭);
//   ② 无论 ① 是否开启, 日志都会进一个有界环形缓冲, 供 `debug_panel` 调试浮窗回看
//      "刚才为什么没追底" —— 原因往往在浮窗打开之前就已经过去了, 所以必须常驻记录.

const MAX_EVENTS = 300

export type ScrollDebugEvent = { at: number; text: string }

let enabled = false
const events: ScrollDebugEvent[] = []

// 参数可能是对象 (chase: lerp 的 metrics); 单行紧凑序列化, 便于浮窗里逐行读.
function formatArg(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try { return JSON.stringify(value) } catch { return '[unserializable]' }
}

export function scrollDebug(...args: unknown[]): void {
  const text = args.map(formatArg).join(' ')
  events.push({ at: Date.now(), text })
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
  if (!enabled) return
  // eslint-disable-next-line no-console
  console.log('[scroll]', ...args)
}

export function readScrollDebugEvents(): ScrollDebugEvent[] {
  return events
}

export function clearScrollDebugEvents(): void {
  events.length = 0
}

export function isScrollDebugEnabled(): boolean {
  return enabled
}

if (typeof window !== 'undefined') {
  try {
    Object.defineProperty(window, 'debug_scroll', {
      get() {
        enabled = true
        return '✓ scroll debug ON — 滚动/追底时看 console 里的 [scroll] 日志；浮窗用 debug_panel'
      },
      set(v: unknown) {
        enabled = Boolean(v)
      },
      configurable: true,
    })
  } catch {
    // 重复定义或不可配置时忽略
  }
}
