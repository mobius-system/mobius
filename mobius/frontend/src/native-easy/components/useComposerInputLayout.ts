import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react'

export const COMPOSER_INPUT_BOUNDS = {
  desktop: {
    collapsed: { minHeight: 60, maxHeight: 120 },
    expanded: { minHeight: 180, maxHeight: 320 },
  },
  mobile: {
    collapsed: { minHeight: 52, maxHeight: 168 },
    expanded: { minHeight: 152, maxHeight: 280 },
  },
} as const

type ComposerInputLayoutArgs = {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  value: string
  expanded: boolean
  isMobile: boolean
  enabled?: boolean
}

type ComposerOverflowY = 'hidden' | 'auto'

export function useComposerMobileLayout() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(max-width: 767px)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 767px)')
    const syncMobileLayout = () => setIsMobile(media.matches)
    syncMobileLayout()
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', syncMobileLayout)
      return () => media.removeEventListener('change', syncMobileLayout)
    }
    media.addListener(syncMobileLayout)
    return () => media.removeListener(syncMobileLayout)
  }, [])

  return isMobile
}

export function useComposerInputLayout({
  textareaRef,
  value,
  expanded,
  isMobile,
  enabled = true,
}: ComposerInputLayoutArgs) {
  const bounds = COMPOSER_INPUT_BOUNDS[isMobile ? 'mobile' : 'desktop'][expanded ? 'expanded' : 'collapsed']
  const { minHeight, maxHeight } = bounds
  const [measured, setMeasured] = useState<{ height: number; overflowY: ComposerOverflowY }>(() => ({
    height: minHeight,
    overflowY: 'hidden',
  }))

  const measure = useCallback(() => {
    if (!enabled) return
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    textarea.style.minHeight = `${minHeight}px`
    textarea.style.maxHeight = `${maxHeight}px`
    const scrollHeight = textarea.scrollHeight
    const height = Math.min(Math.max(scrollHeight, minHeight), maxHeight)
    const overflowY: ComposerOverflowY = scrollHeight > maxHeight ? 'auto' : 'hidden'

    // Apply before paint as well as returning the values so wrapped lines resize
    // immediately while the controlled textarea is being edited.
    textarea.style.height = `${height}px`
    textarea.style.overflowY = overflowY
    setMeasured(current => (
      current.height === height && current.overflowY === overflowY
        ? current
        : { height, overflowY }
    ))
  }, [enabled, maxHeight, minHeight, textareaRef])

  useLayoutEffect(() => {
    measure()
  }, [measure, value])

  useEffect(() => {
    if (!enabled) return
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [enabled, measure])

  return {
    height: measured.height,
    minHeight,
    maxHeight,
    overflowY: measured.overflowY,
  }
}
