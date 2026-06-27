/**
 * jsonl-watcher.ts — tail 一个 JSONL 文件, 按行增量推 entry.
 *
 * 用法:
 *   const w = watch({ path, onEntry, onError })
 *   ...
 *   w.stop()
 *
 * 行为:
 *   - 文件初始不存在: 200ms 轮询等出现, 然后切 fs.watch
 *   - 文件被截断 (size 突然变小): 重置 offset 从头开始
 *   - 不完整行 (尾部无 \n): 保留为 buffer, 下次拼上
 *   - JSON.parse 失败: onError 抛出, 继续后面行
 */
import * as fs from 'fs'

const DEFAULT_TAIL_CHUNK_BYTES = 256 * 1024
const DEFAULT_TAIL_MAX_BYTES = 16 * 1024 * 1024
// count-then-tail: count 阶段允许扫到 64MB, 覆盖典型 jsonl 体积; 超过即标记 approximate.
const DEFAULT_COUNT_MAX_BYTES = 64 * 1024 * 1024

function positiveInt(value: any, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function watch(opts: any): { stop: () => void; state: () => any } {
  const { path: filePath, onEntry, onError = () => {}, startOffset = 0 } = opts
  if (!filePath || typeof onEntry !== 'function') {
    throw new Error('watch 需要 { path, onEntry }')
  }

  // startOffset: 上游若已经通过 readAll() 拿到了开头 N 字节, 应该把那 N 传进来,
  // 这样初始 readAvailable 只读 (N, ∞) 那段, 不会把已发过的历史再发一遍.
  let byteOffset: any = startOffset
  let lineNo = 0
  let buffer = ''
  let fileWatcher: fs.FSWatcher | null = null
  let pollHandle: NodeJS.Timeout | null = null
  let stopped = false

  function readAvailable(): void {
    if (stopped) return
    let stat
    try { stat = fs.statSync(filePath) } catch { return }

    if (stat.size < byteOffset) {
      // 截断 / 重建
      byteOffset = 0
      lineNo = 0
      buffer = ''
    }
    if (stat.size === byteOffset) return

    let fd
    try { fd = fs.openSync(filePath, 'r') } catch (e) { return onError(e) }
    try {
      const len = stat.size - byteOffset
      const buf = Buffer.alloc(len)
      const n = fs.readSync(fd, buf, 0, len, byteOffset)
      byteOffset += n
      buffer += buf.slice(0, n).toString('utf8')
    } finally {
      try { fs.closeSync(fd) } catch {}
    }

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line) continue
      lineNo += 1
      let entry
      try { entry = JSON.parse(line) }
      catch (e: any) {
        onError(new Error(`JSON.parse line ${lineNo}: ${e.message}; raw=${line.slice(0, 200)}`))
        continue
      }
      try { onEntry(entry, lineNo) } catch (e) { onError(e) }
    }
  }

  function startFileWatcher(): void {
    try {
      fileWatcher = fs.watch(filePath, () => readAvailable())
    } catch (e) {
      onError(e)
      return
    }
    readAvailable()  // 初始 catch up
  }

  if (fs.existsSync(filePath)) {
    startFileWatcher()
  } else {
    pollHandle = setInterval(() => {
      if (stopped) return
      if (fs.existsSync(filePath)) {
        if (pollHandle) { clearInterval(pollHandle); pollHandle = null }
        startFileWatcher()
      }
    }, 200)
  }

  return {
    stop() {
      stopped = true
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null }
      if (fileWatcher) { try { fileWatcher.close() } catch {} fileWatcher = null }
    },
    // 当前进度 (主要用于调试)
    state() { return { byteOffset, lineNo, hasFile: fs.existsSync(filePath) } },
  }
}

function countNewlines(buf: Buffer): number {
  let count = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) count += 1
  }
  return count
}

function parseLines(lines: string[]): any[] {
  const entries = []
  for (const line of lines) {
    try { entries.push(JSON.parse(line)) } catch {}
  }
  return entries
}

function readFull(filePath: string, maxLines: number, tailCount: number = 0): any {
  // 用 readFileSync 返回 Buffer (而非 utf8 字符串), 这样我们能拿到准确的字节数,
  // 作为后续 watch() 的 startOffset — 跟 history 范围无缝衔接, 既不重复也不漏行.
  const buf = fs.readFileSync(filePath)
  const size = buf.length
  const lines = buf.toString('utf8').split('\n').filter(Boolean)
  const total = lines.length
  // tailCount > 0 时优先按 tailCount 截尾, 否则沿用原 maxLines 行为. 两者都是硬上限,
  // 取交集 (即更小的那个) — 上层调用方拿到的 entries.length 一定不超过两者中的下限.
  const effectiveLimit = tailCount > 0
    ? (maxLines > 0 ? Math.min(maxLines, tailCount) : tailCount)
    : maxLines
  const slice = effectiveLimit > 0 ? lines.slice(-effectiveLimit) : []
  return {
    entries: parseLines(slice),
    total,
    totalApproximate: false,
    truncated: total > slice.length,
    size,
  }
}

function readTailWindow(filePath: string, maxLines: number, size: number, chunkSize: number, maxTailBytes: number, tailCount: number = 0): any {
  const effectiveLimit = tailCount > 0
    ? (maxLines > 0 ? Math.min(maxLines, tailCount) : tailCount)
    : maxLines
  if (effectiveLimit <= 0) {
    return { entries: [], total: 0, totalApproximate: size > 0, truncated: size > 0, size, scannedBytes: 0 }
  }

  const chunks: Buffer[] = []
  let position = size
  let scannedBytes = 0
  let newlineCount = 0
  let fd
  try { fd = fs.openSync(filePath, 'r') } catch { return { entries: [], total: 0, totalApproximate: false, truncated: false, size: 0, scannedBytes: 0 } }
  try {
    while (position > 0 && scannedBytes < maxTailBytes && newlineCount <= effectiveLimit) {
      const len = Math.min(chunkSize, position, maxTailBytes - scannedBytes)
      position -= len
      const buf = Buffer.allocUnsafe(len)
      const n = fs.readSync(fd, buf, 0, len, position)
      const readBuf = n === len ? buf : buf.slice(0, n)
      chunks.unshift(readBuf)
      scannedBytes += readBuf.length
      newlineCount += countNewlines(readBuf)
      if (n <= 0) break
    }
  } finally {
    try { fs.closeSync(fd) } catch {}
  }

  let text = Buffer.concat(chunks).toString('utf8')
  if (position > 0) {
    const firstNewline = text.indexOf('\n')
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
  }
  const parsedLines = text.split('\n').filter(Boolean)
  const lines = effectiveLimit > 0 ? parsedLines.slice(-effectiveLimit) : []
  const truncated = position > 0 || parsedLines.length > lines.length
  return {
    entries: parseLines(lines),
    // 大文件尾读时不再为了精确总行数扫描全文件。total 至少比已返回行数大,
    // 前端目前只使用 entries.length; truncated 标记表达"前面还有历史"。
    total: position > 0 ? Math.max(lines.length + 1, effectiveLimit + 1) : parsedLines.length,
    totalApproximate: position > 0,
    truncated,
    size,
    scannedBytes,
  }
}

/**
 * 读取 jsonl 历史尾部, 返回 entries 数组. 用于 stream subscribe 时回灌历史.
 * 小文件精确读取; 大文件从尾部反向扫描, 避免巨型 jsonl 阻塞后端和前端首包。
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.maxLines=10000] 防止巨型 jsonl 撑爆
 * @param {number} [opts.tailCount=0] count-then-tail 用: 只取末尾 N 条 (与 maxLines 取较小者).
 *                                   0 = 保留旧行为, 沿用 maxLines.
 * @param {number} [opts.chunkSize=262144] 大文件尾读块大小
 * @param {number} [opts.exactTotalMaxBytes=16777216] 小于该大小时保留精确 total
 * @param {number} [opts.maxTailBytes=16777216] 大文件最多扫描尾部字节数
 * @returns {{ entries: object[], total: number, totalApproximate: boolean, truncated: boolean, size: number }}
 */
function readAll(filePath: string, opts: any = {}): any {
  const maxLines = Math.max(0, Math.floor(Number.isFinite(Number(opts.maxLines)) ? Number(opts.maxLines) : 10000))
  const tailCount = Math.max(0, Math.floor(Number.isFinite(Number(opts.tailCount)) ? Number(opts.tailCount) : 0))
  const chunkSize = Math.max(16 * 1024, Math.floor(Number.isFinite(Number(opts.chunkSize)) ? Number(opts.chunkSize) : 256 * 1024))
  const exactTotalMaxBytes = Math.max(0, Math.floor(Number.isFinite(Number(opts.exactTotalMaxBytes)) ? Number(opts.exactTotalMaxBytes) : 16 * 1024 * 1024))
  const maxTailBytes = Math.max(chunkSize, Math.floor(Number.isFinite(Number(opts.maxTailBytes)) ? Number(opts.maxTailBytes) : 16 * 1024 * 1024))
  if (!fs.existsSync(filePath)) return { entries: [], total: 0, totalApproximate: false, truncated: false, size: 0 }

  let stat
  try { stat = fs.statSync(filePath) } catch { return { entries: [], total: 0, totalApproximate: false, truncated: false, size: 0 } }
  if (stat.size <= exactTotalMaxBytes) return readFull(filePath, maxLines, tailCount)
  return readTailWindow(filePath, maxLines, stat.size, chunkSize, maxTailBytes, tailCount)
}

/**
 * 从文件尾部倒读最近 maxLines 条 JSONL。保留给脚本/测试的公共 helper;
 * readAll() 在大文件场景下也走同一个尾读实现。
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.maxLines=10000]
 * @param {number} [opts.maxBytes=16777216] 最多扫描尾部字节数
 * @param {number} [opts.chunkBytes=262144]
 * @returns {{ entries: object[], total: number, truncated: boolean, size: number, totalApproximate: boolean, scannedBytes: number }}
 */
function readTail(filePath: string, opts: any = {}): any {
  const maxLines = positiveInt(opts.maxLines, 10000)
  const maxBytes = positiveInt(opts.maxBytes ?? opts.maxTailBytes, DEFAULT_TAIL_MAX_BYTES)
  const chunkBytes = positiveInt(opts.chunkBytes ?? opts.chunkSize, DEFAULT_TAIL_CHUNK_BYTES)
  if (!fs.existsSync(filePath)) {
    return { entries: [], total: 0, truncated: false, size: 0, totalApproximate: false, scannedBytes: 0 }
  }

  let stat
  try { stat = fs.statSync(filePath) }
  catch { return { entries: [], total: 0, truncated: false, size: 0, totalApproximate: false, scannedBytes: 0 } }

  if (stat.size <= 0) {
    return { entries: [], total: 0, truncated: false, size: stat.size || 0, totalApproximate: false, scannedBytes: 0 }
  }

  return readTailWindow(filePath, maxLines, stat.size, chunkBytes, maxBytes)
}

/**
 * 仅扫字节数 \n, 不调 JSON.parse — count-then-tail 的 count 阶段.
 * 对 8101 条 / 8MB 的典型 jsonl, 这一步应该 < 50ms.
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.chunkBytes=262144] 每次 read 块大小
 * @param {number} [opts.maxScanBytes=67108864] 最大扫描字节; 超过即 approximate
 * @returns {{ count: number, size: number, approximate: boolean, scannedBytes: number }}
 */
function countLines(filePath: string, opts: any = {}): any {
  const chunkBytes = positiveInt(opts.chunkBytes ?? opts.chunkSize, DEFAULT_TAIL_CHUNK_BYTES)
  const maxScanBytes = positiveInt(opts.maxScanBytes ?? opts.maxBytes, DEFAULT_COUNT_MAX_BYTES)
  if (!filePath || !fs.existsSync(filePath)) {
    return { count: 0, size: 0, approximate: false, scannedBytes: 0 }
  }
  let stat
  try { stat = fs.statSync(filePath) }
  catch { return { count: 0, size: 0, approximate: false, scannedBytes: 0 } }
  if (stat.size <= 0) return { count: 0, size: 0, approximate: false, scannedBytes: 0 }

  let fd
  try { fd = fs.openSync(filePath, 'r') }
  catch { return { count: 0, size: stat.size, approximate: false, scannedBytes: 0 } }

  let position = 0
  let scannedBytes = 0
  let count = 0
  let lastByte = -1
  const buf = Buffer.allocUnsafe(chunkBytes)
  try {
    while (position < stat.size && scannedBytes < maxScanBytes) {
      const len = Math.min(chunkBytes, stat.size - position, maxScanBytes - scannedBytes)
      const n = fs.readSync(fd, buf, 0, len, position)
      if (n <= 0) break
      for (let i = 0; i < n; i++) {
        if (buf[i] === 10) count += 1
      }
      lastByte = buf[n - 1]
      position += n
      scannedBytes += n
    }
  } finally {
    try { fs.closeSync(fd) } catch {}
  }

  // 文件不以 \n 结尾, 最后一行也算一条 (parseLines 也是这种语义).
  if (position >= stat.size && lastByte !== 10 && lastByte !== -1) {
    count += 1
  }
  const approximate = position < stat.size
  return { count, size: stat.size, approximate, scannedBytes }
}

/**
 * 读取指定区间的 entries: [fromIndex, fromIndex + limit). 用于前端 "展开全部" 的按需补齐.
 * 当前实现走全文件解析 (因为指定偏移需要从头数行). 对 8101 条 / 8MB 的典型 jsonl
 * 仍然是单次 readFileSync + split + parseLines, < 200ms.
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.fromIndex=0] 0-based 起始下标
 * @param {number} [opts.limit=200] 最多返回多少条
 * @param {number} [opts.maxBytes=67108864] 文件超过这个大小拒绝服务 (避免内存爆)
 * @returns {{ entries: object[], total: number, from: number, returned: number, size: number, exceeded: boolean }}
 */
function readSlice(filePath: string, opts: any = {}): any {
  const fromIndex = Math.max(0, Math.floor(Number.isFinite(Number(opts.fromIndex)) ? Number(opts.fromIndex) : 0))
  const limit = Math.max(0, Math.floor(Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 200))
  const maxBytes = positiveInt(opts.maxBytes, DEFAULT_COUNT_MAX_BYTES)
  if (!filePath || !fs.existsSync(filePath)) {
    return { entries: [], total: 0, from: fromIndex, returned: 0, size: 0, exceeded: false }
  }
  let stat
  try { stat = fs.statSync(filePath) }
  catch { return { entries: [], total: 0, from: fromIndex, returned: 0, size: 0, exceeded: false } }
  if (stat.size > maxBytes) {
    return { entries: [], total: 0, from: fromIndex, returned: 0, size: stat.size, exceeded: true }
  }
  const buf = fs.readFileSync(filePath)
  const lines = buf.toString('utf8').split('\n').filter(Boolean)
  const total = lines.length
  const slice = limit > 0 ? lines.slice(fromIndex, fromIndex + limit) : []
  return {
    entries: parseLines(slice),
    total,
    from: fromIndex,
    returned: slice.length,
    size: stat.size,
    exceeded: false,
  }
}

export { watch, readAll, readTail, countLines, readSlice }
