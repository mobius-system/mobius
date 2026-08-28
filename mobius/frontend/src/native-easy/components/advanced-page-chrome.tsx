import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  advancedPageReturnNavigation,
  navigateToWorkbench,
  workbenchReturnLabel,
} from '../services/workbench-navigation'

export function AdvancedPageChrome({
  eyebrow,
  title,
  meta,
  returnTo,
  fallback,
  backLabel,
  onBack,
  actions,
  autoFocusHeading = false,
  dataTour,
}: {
  eyebrow: string
  title: ReactNode
  meta?: ReactNode
  returnTo?: string
  fallback?: string
  backLabel?: string
  onBack?: () => void
  actions?: ReactNode
  autoFocusHeading?: boolean
  dataTour?: string
}) {
  const navigate = useNavigate()
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const destination = useMemo(
    () => advancedPageReturnNavigation(returnTo, fallback),
    [fallback, returnTo],
  )
  const resolvedReturnTo = destination?.path || returnTo || fallback || ''
  const resolvedBackLabel = backLabel || workbenchReturnLabel(resolvedReturnTo)
  const canReturn = !!onBack || !!destination

  useEffect(() => {
    if (!autoFocusHeading) return
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [autoFocusHeading])

  const handleBack = () => {
    if (onBack) {
      onBack()
      return
    }
    if (destination) navigateToWorkbench(navigate, destination)
  }

  return (
    <div className="advanced-page-chrome" data-advanced-page-chrome data-tour={dataTour}>
      {canReturn && (
        <button
          type="button"
          onClick={handleBack}
          className="advanced-page-chrome__back workbench-control-md"
          aria-label={resolvedBackLabel}
          title={resolvedBackLabel}
          data-advanced-page-back
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{resolvedBackLabel}</span>
        </button>
      )}
      <div className="advanced-page-chrome__identity">
        <span className="advanced-page-chrome__eyebrow">{eyebrow}</span>
        <h1
          ref={headingRef}
          data-workbench-main-heading
          tabIndex={-1}
          className="advanced-page-chrome__title"
        >
          {title}
        </h1>
        {meta ? <span className="advanced-page-chrome__meta">{meta}</span> : null}
      </div>
      {actions ? <div className="advanced-page-chrome__actions">{actions}</div> : null}
    </div>
  )
}
