import { useEffect, useLayoutEffect, useRef, useState } from 'react'

type Lines = 1 | 2 | 3

interface TruncatedTextProps {
  text: string
  lines: Lines
  className?: string
  detailLabel?: string
  collapseLabel?: string
}

const CLAMP: Record<Lines, string> = {
  1: 'line-clamp-1',
  2: 'line-clamp-2',
  3: 'line-clamp-3',
}

export function TruncatedText({
  text,
  lines,
  className,
  detailLabel = '...查看详情...',
  collapseLabel = '收起',
}: TruncatedTextProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useLayoutEffect(() => {
    if (expanded) return
    const el = ref.current
    if (!el) {
      setTruncated(false)
      return
    }
    const measure = () => setTruncated(el.scrollHeight - el.clientHeight > 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, lines, expanded])

  useEffect(() => {
    setExpanded(false)
  }, [text])

  if (expanded) {
    return (
      <div className={className}>
        <div className="whitespace-pre-wrap break-words max-h-[220px] overflow-y-auto pr-1">{text}</div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded(false)
          }}
          className="text-[10px] mt-0.5 hover:text-blue-300 transition-colors"
          style={{ color: 'var(--text-muted)' }}
        >
          {collapseLabel}
        </button>
      </div>
    )
  }

  return (
    <div className={className}>
      <div ref={ref} className={CLAMP[lines]}>{text}</div>
      {truncated && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded(true)
          }}
          className="text-[10px] hover:text-blue-300 transition-colors"
          style={{ color: '#60a5fa' }}
        >
          {detailLabel}
        </button>
      )}
    </div>
  )
}
