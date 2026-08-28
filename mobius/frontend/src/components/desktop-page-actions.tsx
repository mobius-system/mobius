import { useEffect, useRef } from 'react'
import type { CSSProperties, DetailedHTMLProps, HTMLAttributes } from 'react'

export type DesktopPageAction = 'back' | 'reload' | 'zoom-in' | 'zoom-out' | 'welcome' | 'system-visualization'

type DesktopPageActionsProps = {
  onBack: () => void
  onReload: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onWelcome: () => void
  onSystemVisualization: () => void
}

export function DesktopPageActions({ onBack, onReload, onZoomIn, onZoomOut, onWelcome, onSystemVisualization }: DesktopPageActionsProps) {
  const elementRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (customElements.get('mobius-desktop-page-actions')) return
    const scriptId = 'mobius-desktop-page-actions-script'
    if (document.getElementById(scriptId)) return
    const script = document.createElement('script')
    script.id = scriptId
    script.src = '/extension/_sdk/desktop-page-actions.js'
    document.head.appendChild(script)
  }, [])

  useEffect(() => {
    const element = elementRef.current
    if (!element) return
    const handleAction = (event: Event) => {
      const actionEvent = event as CustomEvent<{ action?: DesktopPageAction }>
      actionEvent.preventDefault()
      if (actionEvent.detail?.action === 'back') onBack()
      else if (actionEvent.detail?.action === 'reload') onReload()
      else if (actionEvent.detail?.action === 'zoom-in') onZoomIn()
      else if (actionEvent.detail?.action === 'zoom-out') onZoomOut()
      else if (actionEvent.detail?.action === 'welcome') onWelcome()
      else if (actionEvent.detail?.action === 'system-visualization') onSystemVisualization()
    }
    element.addEventListener('mobius-page-action', handleAction)
    return () => element.removeEventListener('mobius-page-action', handleAction)
  }, [onBack, onReload, onSystemVisualization, onWelcome, onZoomIn, onZoomOut])

  const style = {
    '--mobius-page-actions-hover': 'var(--bg-hover)',
    '--mobius-page-actions-bg': 'var(--modal-bg)',
    '--mobius-page-actions-border': 'var(--border-color)',
    '--mobius-page-actions-color': 'var(--text-primary)',
  } as CSSProperties

  return <mobius-desktop-page-actions ref={elementRef} style={style} back-fallback="/" welcome-path="/welcome" visualization-path="/u/fuqingxu/mobius_overview_cluster" />
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'mobius-desktop-page-actions': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        'back-fallback'?: string
        'welcome-path'?: string
        'visualization-path'?: string
      }
    }
  }
}
