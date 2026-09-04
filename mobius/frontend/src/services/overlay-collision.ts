export type OverlayCollisionItem = {
  id: string
  left: number
  top: number
  width: number
  height: number
  manual: boolean
}

export type OverlayCollisionBounds = {
  left: number
  top: number
  right: number
  bottom: number
}

export function clampOverlayToBounds(item: Pick<OverlayCollisionItem, 'left' | 'top' | 'width' | 'height'>, bounds: OverlayCollisionBounds) {
  return {
    left: Math.max(bounds.left, Math.min(Math.max(bounds.left, bounds.right - item.width), item.left)),
    top: Math.max(bounds.top, Math.min(Math.max(bounds.top, bounds.bottom - item.height), item.top)),
  }
}

/**
 * Resolve overlapping panels with a tunable, intentionally gentle push. A
 * strength below 1 leaves room for the next layout frame to settle, avoiding
 * the large instantaneous jumps that are especially noticeable in the
 * overview conversation overlays.
 */
export function resolveOverlayCollisions<T extends OverlayCollisionItem>(items: T[], bounds: OverlayCollisionBounds, gap: number, passes = 4, strength = 1): T[] {
  const pushStrength = Math.max(0, Math.min(1, strength))
  const next = items.map((item) => ({ ...item }))
  const clampAuto = (item: T) => {
    if (item.manual) return
    const clamped = clampOverlayToBounds(item, bounds)
    item.left = clamped.left
    item.top = clamped.top
  }

  next.forEach(clampAuto)
  for (let pass = 0; pass < passes; pass += 1) {
    let separated = false
    for (let i = 0; i < next.length; i += 1) {
      for (let j = i + 1; j < next.length; j += 1) {
        const a = next[i]
        const b = next[j]
        if (a.manual && b.manual) continue
        const centerAX = a.left + a.width / 2
        const centerBX = b.left + b.width / 2
        const centerAY = a.top + a.height / 2
        const centerBY = b.top + b.height / 2
        const overlapX = (a.width + b.width) / 2 + gap - Math.abs(centerAX - centerBX)
        const overlapY = (a.height + b.height) / 2 + gap - Math.abs(centerAY - centerBY)
        if (overlapX <= 0 || overlapY <= 0) continue

        const moveA = !a.manual
        const moveB = !b.manual
        const original = { aLeft: a.left, aTop: a.top, bLeft: b.left, bTop: b.top }
        const reset = () => {
          a.left = original.aLeft
          a.top = original.aTop
          b.left = original.bLeft
          b.top = original.bTop
        }
        const moveAlong = (axis: 'x' | 'y') => {
          if (axis === 'x') {
            const direction = centerAX < centerBX || (centerAX === centerBX && i < j) ? -1 : 1
            const share = (moveA && moveB ? overlapX / 2 : overlapX) * pushStrength
            if (moveA) a.left += direction * share
            if (moveB) b.left -= direction * share
          } else {
            const direction = centerAY < centerBY || (centerAY === centerBY && i < j) ? -1 : 1
            const share = (moveA && moveB ? overlapY / 2 : overlapY) * pushStrength
            if (moveA) a.top += direction * share
            if (moveB) b.top -= direction * share
          }
          clampAuto(a)
          clampAuto(b)
        }
        const collisionScore = () => {
          const remainingX = Math.max(0, (a.width + b.width) / 2 + gap - Math.abs((a.left + a.width / 2) - (b.left + b.width / 2)))
          const remainingY = Math.max(0, (a.height + b.height) / 2 + gap - Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)))
          return remainingX * remainingY
        }
        const primaryAxis = overlapX <= overlapY ? 'x' : 'y'
        moveAlong(primaryAxis)
        const primaryResult = { aLeft: a.left, aTop: a.top, bLeft: b.left, bTop: b.top, score: collisionScore() }
        if (primaryResult.score > 0) {
          reset()
          moveAlong(primaryAxis === 'x' ? 'y' : 'x')
          if (collisionScore() >= primaryResult.score) {
            a.left = primaryResult.aLeft
            a.top = primaryResult.aTop
            b.left = primaryResult.bLeft
            b.top = primaryResult.bTop
          }
        }
        separated = true
      }
    }
    if (!separated) break
  }
  return next
}
