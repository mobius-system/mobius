/**
 * Screen — the full-terminal root every route renders into.
 *
 * Why this exists: Ink renders inline in the terminal and, on each render,
 * erases only as many lines as the PREVIOUS frame occupied. If a frame is ever
 * taller than the terminal window it scrolls, Ink can no longer move the cursor
 * back to the real top of that frame, and stale lines from the old screen stay
 * on screen as "residue" (most visible when a tall picker — project / issue /
 * session list — gives way to a shorter one). Pinning the root to exactly the
 * terminal height with `overflow="hidden"` makes every frame the same height,
 * so Ink's erase always realigns and transitions stay clean.
 *
 * Pickers below still budget their own height (Select `reserveRows`) so nothing
 * meaningful gets clipped; this box is the hard guarantee that nothing scrolls.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Box, useStdout } from 'ink'

export function Screen({ children }: { children: React.ReactNode }) {
  const { stdout } = useStdout()
  const read = useCallback(() => Math.max(8, stdout.rows ?? 24), [stdout])
  const [rows, setRows] = useState(read)

  useEffect(() => {
    const onResize = () => setRows(read())
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout, read])

  return (
    <Box height={rows} flexDirection="column" overflow="hidden">
      {children}
    </Box>
  )
}
