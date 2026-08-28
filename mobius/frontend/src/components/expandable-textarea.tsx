import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, TextareaHTMLAttributes } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'

type ExpandableTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
  expandTitle?: string
  overlayTitle?: string
  overlayClassName?: string
  overlayStyle?: CSSProperties
  innerControl?: ReactNode
  innerControlClassName?: string
  expandButtonClassName?: string
}

export function ExpandableTextarea({
  value,
  onValueChange,
  className = '',
  style,
  disabled,
  expandTitle = '展开编辑',
  overlayTitle = '长文本编辑',
  overlayClassName = '',
  overlayStyle,
  innerControl,
  innerControlClassName = '',
  expandButtonClassName = '',
  ...textareaProps
}: ExpandableTextareaProps) {
  const [expanded, setExpanded] = useState(false)
  const expandedRef = useRef<HTMLTextAreaElement | null>(null)
  const compact = typeof className === 'string' && /\bh-9\b/.test(className)

  useEffect(() => {
    if (!expanded) return
    const id = requestAnimationFrame(() => expandedRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(id)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [expanded])

  const textarea = (
    <textarea
      {...textareaProps}
      disabled={disabled}
      value={value}
      onChange={event => onValueChange(event.target.value)}
      className={`${className} ${innerControl ? 'pr-28' : 'pr-20'}`}
      style={style}
    />
  )

  return (
    <>
      <div className="relative">
        {textarea}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          disabled={disabled}
          title={expandTitle}
          className={`absolute right-2 inline-flex h-6 items-center gap-1 rounded-lg border px-1.5 text-[10px] transition-colors disabled:hidden hover:bg-blue-500/10 ${compact ? 'top-1.5' : 'top-2'} ${expandButtonClassName}`}
          style={{
            color: 'var(--text-muted)',
            borderColor: 'var(--input-border)',
            background: 'var(--input-bg)',
          }}
        >
          <Maximize2 className="h-3 w-3" strokeWidth={1.9} />
          <span>展开</span>
        </button>
        {innerControl && !disabled && (
          <div className={`absolute right-2 top-10 ${innerControlClassName}`}>
            {innerControl}
          </div>
        )}
      </div>
      {expanded && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            aria-label="关闭长文本编辑"
            onClick={() => setExpanded(false)}
          />
          <div
            className="relative flex h-[min(760px,calc(100vh-32px))] w-[min(920px,calc(100vw-32px))] flex-col rounded-2xl p-4 shadow-2xl"
            style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
            onClick={event => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{overlayTitle}</h3>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                title="收起编辑区"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition-colors hover:bg-[var(--bg-card-hover)]"
                style={{ color: 'var(--text-secondary)', borderColor: 'var(--input-border)' }}
              >
                <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                收起
              </button>
            </div>
            <textarea
              {...textareaProps}
              ref={expandedRef}
              disabled={disabled}
              value={value}
              onChange={event => onValueChange(event.target.value)}
              className={`min-h-0 flex-1 w-full resize-none rounded-xl px-3 py-2 text-[13px] leading-relaxed placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30 ${overlayClassName}`}
              style={{
                background: 'var(--input-bg)',
                border: '1px solid var(--input-border)',
                color: 'var(--text-primary)',
                ...overlayStyle,
              }}
            />
          </div>
        </div>
      )}
    </>
  )
}
