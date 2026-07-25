/**
 * Server-Sent Events client for GET /api/sessions/:id/events.
 *
 * Node has no native EventSource, so we drive the same endpoint with a streaming
 * `fetch` and parse SSE frames ourselves (the same approach the web frontend's
 * search modal falls back to when EventSource can't carry the Authorization
 * header). The token rides in a `?token=` query param.
 *
 * Frame grammar: blocks separated by a blank line; within a block, `event:` sets
 * the name and one or more `data:` lines (joined with \n) carry the JSON payload.
 * Lines starting with `:` are keepalive comments and are ignored.
 */
import type { AnyEntry } from './types.js'

export interface SseHandlers {
  onOpen?: () => void
  onSubscribed?: (session: any) => void
  onHistoryEntries?: (entries: AnyEntry[], done: boolean) => void
  onEntry?: (entry: AnyEntry) => void
  onTyping?: (active: boolean) => void
  onError?: (message: string, category?: string) => void
  onClose?: () => void
}

export class SseConnection {
  private controller: AbortController | null = null
  private closed = false

  constructor(private url: string, private handlers: SseHandlers) {}

  isClosed(): boolean { return this.closed }

  async start(): Promise<void> {
    this.controller = new AbortController()
    try {
      const res = await fetch(this.url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        signal: this.controller.signal,
      })
      if (!res.ok || !res.body) {
        this.handlers.onError?.(`SSE 连接失败 (HTTP ${res.status})`)
        this.handlers.onClose?.()
        return
      }
      this.handlers.onOpen?.()
      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // Complete frames are separated by a blank line.
        const frames = buffer.split(/\r?\n\r?\n/)
        buffer = frames.pop() ?? ''
        for (const frame of frames) this.handleFrame(frame)
      }
      // flush any trailing frame
      if (buffer.trim()) this.handleFrame(buffer)
    } catch (e: any) {
      if (e?.name === 'AbortError') { /* intentional close */ }
      else this.handlers.onError?.(`SSE 读取错误: ${e?.message ?? String(e)}`)
    } finally {
      this.closed = true
      this.handlers.onClose?.()
    }
  }

  close(): void {
    this.closed = true
    try { this.controller?.abort() } catch { /* ignore */ }
  }

  private handleFrame(frame: string): void {
    let eventName = 'message'
    const dataLines: string[] = []
    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue // blank / keepalive comment
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^\s/, ''))
      }
    }
    if (dataLines.length === 0) return
    const raw = dataLines.join('\n')
    let payload: any
    try { payload = JSON.parse(raw) } catch { return }
    this.dispatch(eventName, payload)
  }

  private dispatch(eventName: string, p: any): void {
    const ev = p?.event ?? eventName
    switch (ev) {
      case 'subscribed': this.handlers.onSubscribed?.(p.session); break
      case 'jsonl_history':
        this.handlers.onHistoryEntries?.(p.entries ?? [], !!p.done)
        break
      case 'jsonl_entry':
        this.handlers.onEntry?.(p.entry)
        break
      case 'typing':
        this.handlers.onTyping?.(!!p.active)
        break
      case 'error':
      case 'server_error':
        this.handlers.onError?.(p.message ?? p.error ?? '未知错误', p.category)
        break
      default:
        // history / jsonl_meta / message / stream / etc. — currently unused by the TUI.
        break
    }
  }
}
