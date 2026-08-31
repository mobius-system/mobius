const readline = require('readline')

class HarnessProtocolError extends Error {
  code: any
  data: any
}

class HarnessJsonRpcPeer {
  // constructor 裸赋值属性的字段声明 (TS2339), any 保持迁移前动态性.
  child: any
  requestTimeoutMs: any
  onNotification: any
  onProtocolError: any
  nextId: any
  pending: any
  closed: any
  reader: any

  constructor(child, { requestTimeoutMs = 30000, onNotification = () => {}, onProtocolError = () => {} } = {}) {
    this.child = child
    this.requestTimeoutMs = requestTimeoutMs
    this.onNotification = onNotification
    this.onProtocolError = onProtocolError
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    this.reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.reader.on('line', (line) => this._onLine(line))
    child.once('exit', (code, signal) => this.close(new HarnessProtocolError(`runtime exited (code=${code}, signal=${signal || 'none'})`)))
    child.once('error', (error) => this.close(error))
  }

  _onLine(line) {
    if (!line.trim()) return
    let frame
    try { frame = JSON.parse(line) }
    catch {
      this.onProtocolError(new HarnessProtocolError(`non-JSON runtime stdout: ${line.slice(0, 500)}`))
      return
    }
    if (frame.id != null) {
      const pending = this.pending.get(String(frame.id))
      if (!pending) return
      this.pending.delete(String(frame.id))
      clearTimeout(pending.timer)
      if (frame.error) {
        const error = new HarnessProtocolError(frame.error.message || 'DeepSeek Harness JSON-RPC error')
        error.code = frame.error.code
        error.data = frame.error.data
        pending.reject(error)
      } else pending.resolve(frame.result)
      return
    }
    if (typeof frame.method === 'string') this.onNotification(frame.method, frame.params || {})
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (this.closed || !this.child.stdin?.writable) return Promise.reject(new HarnessProtocolError('runtime transport is closed'))
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HarnessProtocolError(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`, (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  close(reason = new HarnessProtocolError('runtime transport closed')) {
    if (this.closed) return
    this.closed = true
    try { this.reader.close() } catch {}
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pending.clear()
  }
}

export { HarnessJsonRpcPeer, HarnessProtocolError }
module.exports = { HarnessJsonRpcPeer, HarnessProtocolError }
