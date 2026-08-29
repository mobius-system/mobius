import type { MouseEvent, ReactNode } from 'react'
import { FileCode2 } from 'lucide-react'
import { formatFileTarget, type CodeArtifactTarget } from './file-target'
import { useCodeArtifactOpen } from './CodeArtifactOpenContext'

export function FileReferenceLink({
  target,
  children: _children,
  showParent = false,
  className = '',
}: {
  target: CodeArtifactTarget
  children?: ReactNode
  showParent?: boolean
  className?: string
}) {
  const artifactOpen = useCodeArtifactOpen()
  const formatted = formatFileTarget(target)

  const open = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    artifactOpen?.openArtifact({ target, trigger: event.currentTarget })
  }

  return (
    <button
      type="button"
      className={`message-file-link ${className}`.trim()}
      onClick={open}
      title={artifactOpen ? formatted.title : `${formatted.title} · 当前表面没有可用的项目预览`}
      aria-label={`打开文件 ${formatted.title}`}
      aria-disabled={!artifactOpen || undefined}
      data-file-path={target.path}
      data-file-line={target.line ?? undefined}
      data-file-end-line={target.endLine ?? undefined}
    >
      <FileCode2 className="message-file-link__icon" aria-hidden="true" />
      {showParent && formatted.parentPath && (
        <span className="message-file-link__parent">{formatted.parentPath}/</span>
      )}
      <span className="message-file-link__basename">{formatted.basename}</span>
      {formatted.lineLabel && <span className="message-file-link__line">{formatted.lineLabel}</span>}
    </button>
  )
}
