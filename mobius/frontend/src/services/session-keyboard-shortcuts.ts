/** Session navigation uses fixed distances, independent of viewport size. */
export function installSessionKeyboardShortcuts(options: {
  getList: () => HTMLElement | null
  getInput: () => HTMLTextAreaElement | null
  onListScroll: (awayFromBottom: boolean, reason: string) => void
}) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    if (!['Insert', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) return
    const list = options.getList()
    if (!list || !list.getClientRects().length) return
    const target = event.target instanceof Element ? event.target : null
    // Modal controls and embedded editors retain their own keyboard navigation.
    if (target?.closest('[role="dialog"], [aria-modal="true"]')) return
    if (event.key === 'Insert') {
      const input = options.getInput()
      if (!input || input.disabled || !input.getClientRects().length) return
      event.preventDefault()
      event.stopPropagation()
      // One physical press toggles once, even when Insert is held down.
      if (event.repeat) return
      if (document.activeElement === input) input.blur()
      else input.focus({ preventScroll: true })
      return
    }
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .cm-editor, .monaco-editor, .xterm')) return

    event.preventDefault()
    // Capture before the list's legacy key listener can mark an inner-card scroll
    // as a request to stop following the conversation.
    event.stopPropagation()
    if (event.key === 'Home' || event.key === 'End') {
      const next = Math.max(0, Math.min(list.scrollHeight - list.clientHeight,
        list.scrollTop + (event.key === 'Home' ? -400 : 400)))
      options.onListScroll(list.scrollHeight - list.clientHeight - next > 4, `shortcut ${event.key}`)
      list.scrollTo({ top: next, behavior: 'instant' })
      return
    }

    const cards = list.querySelectorAll<HTMLElement>('.jsonl-entry-card')
    const card = cards[cards.length - 1]
    if (!card) return
    // Do not fall back to an earlier card or the outer list at a scroll boundary.
    const scroller = [card, ...card.querySelectorAll<HTMLElement>('*')].find(node => {
      const overflow = getComputedStyle(node).overflowY
      return node.getClientRects().length > 0 && (overflow === 'auto' || overflow === 'scroll')
        && node.scrollHeight > node.clientHeight
    })
    scroller?.scrollBy({ top: event.key === 'PageUp' ? -200 : 200, behavior: 'instant' })
  }
  document.addEventListener('keydown', onKeyDown, true)
  return () => document.removeEventListener('keydown', onKeyDown, true)
}
