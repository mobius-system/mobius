import { Check, Copy } from 'lucide-react'
import type { MouseEvent } from 'react'

type JsonlCopyButtonProps = {
  copied: boolean
  title: string
  copiedTitle?: string
  disabled?: boolean
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
}

export function JsonlCopyButton({ copied, title, copiedTitle = '已复制', disabled = false, onClick }: JsonlCopyButtonProps) {
  const label = copied ? copiedTitle : title

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`jsonl-icon-button ${copied ? 'jsonl-icon-button--copied' : ''}`}
      title={label}
      aria-label={label}
    >
      {copied
        ? <Check className="h-2.5 w-2.5" strokeWidth={2.2} aria-hidden="true" />
        : <Copy className="h-2.5 w-2.5" strokeWidth={1.9} aria-hidden="true" />}
    </button>
  )
}
