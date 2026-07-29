export type UserPickerAnchorRect = {
  top: number
  bottom: number
  left: number
  width: number
}

export type UserPickerViewport = {
  width: number
  height: number
}

export type UserPickerPlacement = {
  direction: 'up' | 'down'
  left: number
  top: number
  width: number
  maxHeight: number
}

export function computeUserPickerPlacement(
  anchor: UserPickerAnchorRect,
  viewport: UserPickerViewport,
  menuHeight = 224,
  gap = 4,
): UserPickerPlacement {
  const spaceBelow = viewport.height - anchor.bottom - gap
  const spaceAbove = anchor.top - gap
  const direction: UserPickerPlacement['direction'] =
    spaceBelow < Math.min(menuHeight, 120) && spaceAbove > spaceBelow ? 'up' : 'down'
  const available = Math.max(80, direction === 'down' ? spaceBelow : spaceAbove)
  const maxHeight = Math.min(menuHeight, available)
  const width = Math.min(anchor.width, Math.max(0, viewport.width - 16))
  const left = Math.min(
    Math.max(8, anchor.left),
    Math.max(8, viewport.width - width - 8),
  )
  const top = direction === 'down'
    ? anchor.bottom + gap
    : Math.max(8, anchor.top - gap - maxHeight)
  return { direction, left, top, width, maxHeight }
}
