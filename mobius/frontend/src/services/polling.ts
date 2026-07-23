/**
 * 自递归轮询：上一次任务完成（含超时放弃）后才排下一次。
 *
 * 替代 `setInterval(load, ms)` 在网络卡顿下的请求雪球堆积 ——
 * setInterval 与上次是否返回无关地硬发，慢网时未完成请求越积越多
 * （DevTools 里就是一堆同名 pending）。
 *
 * 三件事一次到位：
 *  1. 自递归循环：`await fn()` 完成后再 `setTimeout` 排下一次，
 *     进行中的请求天然不会被新的重叠 ⇒ in-flight 跳过。
 *  2. 超时主动放弃：单次超过 timeoutMs 即 `AbortController.abort()`，
 *     防止一个卡死的请求把整条轮询链无限堵住。fn 必须把 signal 透传给
 *     `api()` / `fetch()`，否则超时形同虚设（请求仍会一直挂着）。
 *  3. 清理：返回的 stop() 会停止调度并 abort 进行中的请求。
 *
 * @param fn        每轮异步任务，收到 signal 后透传给 api()/fetch。
 * @param intervalMs 上一次结束后等待多久再发下一次。
 * @param timeoutMs 单次超时（默认 10s），超时即 abort 这一轮并继续排下一轮。
 * @param opts.startImmediately true（默认）立即发起首轮；false 则先等一个 intervalMs。
 * @returns stop()：调用后停止轮询并 abort 进行中的请求。
 */
export function pollRecursive(
  fn: (signal: AbortSignal) => Promise<void> | void,
  intervalMs: number,
  timeoutMs = 10_000,
  opts: { startImmediately?: boolean } = {},
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null

  const tick = async () => {
    if (stopped) return
    controller = new AbortController()
    const to = setTimeout(() => controller?.abort(), timeoutMs)
    try {
      await fn(controller.signal)
    } catch {
      /* 单次失败或超时忽略，下一轮重试 */
    } finally {
      clearTimeout(to)
      controller = null
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs)
    }
  }

  if (opts.startImmediately === false) {
    timer = setTimeout(tick, intervalMs)
  } else {
    void tick()
  }

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    controller?.abort()
  }
}
