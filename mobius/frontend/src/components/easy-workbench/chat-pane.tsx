import { useLayoutEffect, type RefObject } from 'react'

export function useComposerOverlayHeight(
  paneRef: RefObject<HTMLElement | null>,
  composerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useLayoutEffect(() => {
    const pane = paneRef.current
    const composer = composerRef.current
    if (!enabled || !pane || !composer) return

    const update = () => {
      const height = Math.ceil(composer.getBoundingClientRect().height)
      pane.style.setProperty('--composer-overlay-height', `${height + 32}px`)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(composer)
    return () => {
      observer.disconnect()
      pane.style.removeProperty('--composer-overlay-height')
    }
  }, [composerRef, enabled, paneRef])
}

export function blurFocusInsideHiddenLayer(layer: HTMLElement | null) {
  const activeElement = document.activeElement
  if (activeElement instanceof HTMLElement && layer?.contains(activeElement)) activeElement.blur()
}
