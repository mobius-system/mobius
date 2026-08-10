/**
 * Pure row-level transcript viewport.
 *
 * Entries are materialized lazily through RowAccess.rowsAt(). Navigation keeps
 * an entry/row anchor, so moving by N rows is exact even when one entry is much
 * taller than the terminal. No React or Ink dependency belongs in this file.
 */

export interface RowAnchor {
  entryId: string
  entryIndex: number
  rowIndex: number
}

export interface ViewportRow<T> {
  entryId: string
  entryIndex: number
  rowIndex: number
  row: T
}

export interface RowAccess<T> {
  length: number
  idAt: (index: number) => string
  indexOf: (entryId: string) => number
  rowsAt: (index: number) => readonly T[]
}

export interface ViewportSlice<T> {
  anchor: RowAnchor | null
  rows: ViewportRow<T>[]
  hasOlder: boolean
  hasNewer: boolean
}

export function createRowAccess<E, T>(
  entries: readonly E[],
  getId: (entry: E, index: number) => string,
  getRows: (entry: E, index: number) => readonly T[],
): RowAccess<T> {
  const ids = entries.map(getId)
  const indexById = new Map(ids.map((id, index) => [id, index]))
  return {
    length: entries.length,
    idAt: (index) => ids[index] ?? '',
    indexOf: (entryId) => indexById.get(entryId) ?? -1,
    rowsAt: (index) => index >= 0 && index < entries.length ? getRows(entries[index], index) : [],
  }
}

function previousNonEmpty<T>(access: RowAccess<T>, from: number): number {
  for (let index = from; index >= 0; index--) {
    if (access.rowsAt(index).length > 0) return index
  }
  return -1
}

function nextNonEmpty<T>(access: RowAccess<T>, from: number): number {
  for (let index = from; index < access.length; index++) {
    if (access.rowsAt(index).length > 0) return index
  }
  return -1
}

function resolveAnchor<T>(access: RowAccess<T>, anchor: RowAnchor | null): RowAnchor | null {
  if (!anchor || access.length === 0) return null
  let entryIndex = access.indexOf(anchor.entryId)
  if (entryIndex < 0) entryIndex = Math.max(0, Math.min(access.length - 1, anchor.entryIndex))

  let rows = access.rowsAt(entryIndex)
  if (rows.length === 0) {
    const next = nextNonEmpty(access, entryIndex + 1)
    const previous = previousNonEmpty(access, entryIndex - 1)
    entryIndex = next >= 0 ? next : previous
    if (entryIndex < 0) return null
    rows = access.rowsAt(entryIndex)
  }

  return {
    entryId: access.idAt(entryIndex),
    entryIndex,
    rowIndex: Math.max(0, Math.min(rows.length - 1, anchor.rowIndex)),
  }
}

export function tailAnchor<T>(access: RowAccess<T>, viewportRows: number): RowAnchor | null {
  let remaining = Math.max(1, Math.floor(viewportRows))
  let first: RowAnchor | null = null
  for (let entryIndex = access.length - 1; entryIndex >= 0; entryIndex--) {
    const rows = access.rowsAt(entryIndex)
    if (rows.length === 0) continue
    first = { entryId: access.idAt(entryIndex), entryIndex, rowIndex: 0 }
    if (rows.length >= remaining) {
      return { entryId: access.idAt(entryIndex), entryIndex, rowIndex: rows.length - remaining }
    }
    remaining -= rows.length
  }
  return first
}

/** Move the top-row anchor by an exact signed row delta. Positive means newer. */
export function moveAnchorByRows<T>(access: RowAccess<T>, anchor: RowAnchor | null, deltaRows: number): RowAnchor | null {
  const resolved = resolveAnchor(access, anchor)
  if (!resolved || deltaRows === 0) return resolved

  let entryIndex = resolved.entryIndex
  let rowIndex = resolved.rowIndex
  let remaining = Math.abs(Math.trunc(deltaRows))

  if (deltaRows > 0) {
    while (remaining > 0) {
      const rows = access.rowsAt(entryIndex)
      const within = rows.length - 1 - rowIndex
      if (remaining <= within) { rowIndex += remaining; remaining = 0; break }
      remaining -= within
      const next = nextNonEmpty(access, entryIndex + 1)
      if (next < 0) { rowIndex = rows.length - 1; break }
      entryIndex = next
      rowIndex = 0
      remaining -= 1
    }
  } else {
    while (remaining > 0) {
      if (remaining <= rowIndex) { rowIndex -= remaining; remaining = 0; break }
      remaining -= rowIndex
      const previous = previousNonEmpty(access, entryIndex - 1)
      if (previous < 0) { rowIndex = 0; break }
      entryIndex = previous
      rowIndex = access.rowsAt(entryIndex).length - 1
      remaining -= 1
    }
  }

  return { entryId: access.idAt(entryIndex), entryIndex, rowIndex }
}

export function sliceViewport<T>(access: RowAccess<T>, anchor: RowAnchor | null, viewportRows: number): ViewportSlice<T> {
  const resolved = resolveAnchor(access, anchor)
  const limit = Math.max(0, Math.floor(viewportRows))
  if (!resolved || limit === 0) return { anchor: resolved, rows: [], hasOlder: false, hasNewer: false }

  const visible: ViewportRow<T>[] = []
  let entryIndex = resolved.entryIndex
  let rowIndex = resolved.rowIndex
  while (entryIndex < access.length && visible.length < limit) {
    const rows = access.rowsAt(entryIndex)
    for (; rowIndex < rows.length && visible.length < limit; rowIndex++) {
      visible.push({ entryId: access.idAt(entryIndex), entryIndex, rowIndex, row: rows[rowIndex] })
    }
    entryIndex = nextNonEmpty(access, entryIndex + 1)
    rowIndex = 0
    if (entryIndex < 0) break
  }

  const hasOlder = resolved.rowIndex > 0 || previousNonEmpty(access, resolved.entryIndex - 1) >= 0
  const last = visible.at(-1)
  const hasNewer = !!last && (
    last.rowIndex < access.rowsAt(last.entryIndex).length - 1 ||
    nextNonEmpty(access, last.entryIndex + 1) >= 0
  )
  return { anchor: resolved, rows: visible, hasOlder, hasNewer }
}
