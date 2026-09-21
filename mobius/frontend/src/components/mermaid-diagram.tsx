import { useEffect, useId, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { useStore } from '../store'

type RenderedDiagram = {
  svg: string
  bindFunctions?: ((element: Element) => void) | null
}

type MermaidTheme = 'light' | 'dark'
type RenderTask = {
  key: string
  cancelled: boolean
  run: (isCancelled: () => boolean) => Promise<RenderedDiagram>
  resolve: (value: RenderedDiagram | null) => void
  reject: (reason: unknown) => void
}

// Mermaid mutates one global renderer; serialize renders while retaining only the latest pending
// task for each component, so streaming updates cannot build an unbounded stale queue.
const pendingTasks = new Map<string, RenderTask>()
let renderWorkerActive = false
let activeTheme: MermaidTheme | null = null

function cancelRenderTask(task: RenderTask): void {
  if (task.cancelled) return
  task.cancelled = true
  if (pendingTasks.get(task.key) === task) pendingTasks.delete(task.key)
  task.resolve(null)
}

function pumpRenderQueue(): void {
  if (renderWorkerActive) return
  renderWorkerActive = true
  void (async () => {
    try {
      while (pendingTasks.size > 0) {
        const task = pendingTasks.values().next().value as RenderTask | undefined
        if (!task) break
        pendingTasks.delete(task.key)
        if (task.cancelled) continue
        try {
          // 任务出队后再检查一次，避免取消的旧任务触碰 Mermaid 全局状态。
          // Check after dequeue so a cancelled stale task never touches Mermaid global state.
          if (task.cancelled) {
            task.resolve(null)
            continue
          }
          const result = await task.run(() => task.cancelled)
          task.resolve(task.cancelled ? null : result)
        } catch (error) {
          if (task.cancelled) task.resolve(null)
          else task.reject(error)
        }
      }
    } finally {
      renderWorkerActive = false
      if (pendingTasks.size > 0) pumpRenderQueue()
    }
  })()
}

function enqueueRender(
  key: string,
  run: (isCancelled: () => boolean) => Promise<RenderedDiagram>,
): { promise: Promise<RenderedDiagram | null>; cancel: () => void } {
  const previous = pendingTasks.get(key)
  if (previous) cancelRenderTask(previous)

  let task!: RenderTask
  const promise = new Promise<RenderedDiagram | null>((resolve, reject) => {
    task = { key, cancelled: false, run, resolve, reject }
  })
  pendingTasks.set(key, task)
  pumpRenderQueue()
  return { promise, cancel: () => cancelRenderTask(task) }
}

function ensureMermaidTheme(theme: MermaidTheme): void {
  // 仅在主题真的变化时初始化；切回旧主题仍会恢复对应的全局配置。
  // Initialise only when the theme changes, while switching back restores its global config.
  if (activeTheme === theme) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: theme === 'light' ? 'neutral' : 'dark',
    fontFamily: 'Inter, "Noto Sans SC", system-ui, sans-serif',
  })
  activeTheme = theme
}

function readableMermaidError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '未知错误')
  return message.split('\n').find(Boolean)?.slice(0, 240) || '无法解析 Mermaid 图表'
}

/*
 * Render one Mermaid fence after its lazy chunk is requested by the Markdown pre renderer.
 */
export default function MermaidDiagram({ source }: { source: string }) {
  const theme = useStore(state => state.theme)
  const reactId = useId()
  const hostRef = useRef<HTMLDivElement>(null)
  const [rendered, setRendered] = useState<RenderedDiagram | null>(null)
  const [error, setError] = useState('')
  const diagramId = `mobius-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    let cancelled = false
    setRendered(null)
    setError('')

    // 流式回复会频繁改写代码块，短暂防抖避免为每个 token 排一次渲染
    // Streaming replies rewrite fences frequently; debounce to avoid queueing one render per token
    let cancelQueuedRender = () => {}
    const timer = window.setTimeout(() => {
      const queued = enqueueRender(diagramId, async isCancelled => {
        // 流式更新期间任务可能在排队时被替换，执行初始化和 render 前都要检查。
        // Streaming updates can replace a queued task; check before init and before render.
        if (isCancelled()) return Promise.reject(new Error('cancelled'))
        ensureMermaidTheme(theme === 'light' ? 'light' : 'dark')
        if (isCancelled()) return Promise.reject(new Error('cancelled'))
        return mermaid.render(diagramId, source)
      })
      cancelQueuedRender = queued.cancel
      queued.promise.then(result => {
        if (result && !cancelled) setRendered(result)
      }).catch(reason => {
        if (!cancelled) setError(readableMermaidError(reason))
      })
    }, 100)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      cancelQueuedRender()
    }
  }, [diagramId, source, theme])

  useEffect(() => {
    if (rendered?.bindFunctions && hostRef.current) rendered.bindFunctions(hostRef.current)
  }, [rendered])

  if (error) {
    return (
      <div className="mermaid-diagram mermaid-diagram--error" role="alert">
        <div className="mermaid-diagram__error-title">Mermaid 图表渲染失败</div>
        <div className="mermaid-diagram__error-message">{error}</div>
        <pre><code className="language-mermaid">{source}</code></pre>
      </div>
    )
  }

  if (!rendered) return <div className="mermaid-diagram mermaid-diagram--loading">正在渲染图表…</div>

  return (
    <div
      ref={hostRef}
      className="mermaid-diagram"
      role="img"
      aria-label="Mermaid 图表"
      dangerouslySetInnerHTML={{ __html: rendered.svg }}
    />
  )
}
