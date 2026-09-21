import { useEffect, useId, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { useStore } from '../store'

type RenderedDiagram = {
  svg: string
  bindFunctions?: ((element: Element) => void) | null
}

let renderQueue: Promise<unknown> = Promise.resolve()

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
    const timer = window.setTimeout(() => {
      const task = renderQueue.catch(() => undefined).then(async () => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: theme === 'light' ? 'neutral' : 'dark',
          fontFamily: 'Inter, "Noto Sans SC", system-ui, sans-serif',
        })
        return mermaid.render(diagramId, source)
      })
      renderQueue = task
      task.then(result => {
        if (!cancelled) setRendered(result)
      }).catch(reason => {
        if (!cancelled) setError(readableMermaidError(reason))
      })
    }, 100)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
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
