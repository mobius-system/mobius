import { performance } from 'node:perf_hooks'
import { coalesceMouseEvents, parseMouseEvents } from '../src/components/primitives.js'
import {
  createRowAccess, moveAnchorByRows, sliceViewport, tailAnchor,
  type RowAnchor,
} from '../src/lib/transcript-viewport.js'

interface Entry { id: string; rows: number[] }

let passed = 0
let failed = 0
function ok(condition: boolean, message: string): void {
  if (condition) { passed += 1; console.log(`  ✓ ${message}`) }
  else { failed += 1; console.error(`  ✗ ${message}`) }
}

function access(entries: Entry[]) {
  return createRowAccess(entries, entry => entry.id, entry => entry.rows)
}

function sameAnchor(actual: RowAnchor | null, entryId: string, rowIndex: number): boolean {
  return actual?.entryId === entryId && actual.rowIndex === rowIndex
}

function main(): void {
  console.log('\n[VIEWPORT] exact row-level transcript navigation\n')

  const long = access([{ id: 'long', rows: Array.from({ length: 1000 }, (_, i) => i) }])
  const tail = tailAnchor(long, 24)
  ok(sameAnchor(tail, 'long', 976), '1000-row entry tails at row 976 in a 24-row viewport')
  const pageUp = moveAnchorByRows(long, tail, -23)
  ok(sameAnchor(pageUp, 'long', 953), 'PageUp moves exactly 23 rows inside one long entry')
  ok(sameAnchor(moveAnchorByRows(long, pageUp, 23), 'long', 976), 'PageDown exactly reverses PageUp')

  const mixed = access([
    { id: 'a', rows: [0, 1] },
    { id: 'b', rows: Array.from({ length: 50 }, (_, i) => i) },
    { id: 'c', rows: [0, 1, 2] },
    { id: 'd', rows: Array.from({ length: 1000 }, (_, i) => i) },
  ])
  const crossed = moveAnchorByRows(mixed, { entryId: 'd', entryIndex: 3, rowIndex: 0 }, -4)
  ok(sameAnchor(crossed, 'b', 49), 'row navigation crosses mixed-height entry boundaries exactly')
  const mixedUp = moveAnchorByRows(mixed, tailAnchor(mixed, 24), -777)
  ok(JSON.stringify(moveAnchorByRows(mixed, mixedUp, 777)) === JSON.stringify(tailAnchor(mixed, 24)), 'large mixed-height PageUp/PageDown movement is reversible')

  const startSlice = sliceViewport(long, { entryId: 'long', entryIndex: 0, rowIndex: 0 }, 24)
  const middleSlice = sliceViewport(long, { entryId: 'long', entryIndex: 0, rowIndex: 500 }, 24)
  const endSlice = sliceViewport(long, tail, 24)
  ok(startSlice.rows[0]?.row === 0, 'long entry start is directly accessible')
  ok(middleSlice.rows[0]?.row === 500, 'long entry middle is directly accessible')
  ok(endSlice.rows.at(-1)?.row === 999, 'long entry end is directly accessible')
  ok(startSlice.rows.length === 24 && middleSlice.rows.length === 24 && endSlice.rows.length === 24, 'only viewport-height rows are materialized in each slice')

  const resized = access([{ id: 'long', rows: Array.from({ length: 700 }, (_, i) => i) }])
  const restored = sliceViewport(resized, { entryId: 'long', entryIndex: 0, rowIndex: 500 }, 10).anchor
  ok(sameAnchor(restored, 'long', 500), 'resize preserves a historical entry/row anchor')
  ok(sameAnchor(tailAnchor(resized, 10), 'long', 690), 'tail-follow mode recomputes against the resized layout')

  const appended = access([
    { id: 'long', rows: Array.from({ length: 1000 }, (_, i) => i) },
    { id: 'new', rows: [0, 1, 2] },
  ])
  const held = sliceViewport(appended, pageUp, 24).anchor
  ok(sameAnchor(held, 'long', 953), 'new entries do not move a historical anchor')
  ok(sameAnchor(tailAnchor(appended, 24), 'long', 979), 'tail-follow mode automatically includes newly appended rows')

  const burst = '\x1b[<64;5;5M'.repeat(5)
  const coalesced = coalesceMouseEvents(parseMouseEvents(burst))
  ok(coalesced.length === 1 && coalesced[0]?.kind === 'wheel' && coalesced[0].delta === 5, 'five wheel events in one input chunk coalesce into one +5 action')
  ok(sameAnchor(moveAnchorByRows(long, tail, -3 * (coalesced[0]?.kind === 'wheel' ? coalesced[0].delta : 0)), 'long', 961), 'five wheel notches move exactly 15 rows')

  const thousand = access(Array.from({ length: 1000 }, (_, i) => ({ id: `e-${i}`, rows: [i] })))
  for (let i = 0; i < 100; i++) sliceViewport(thousand, moveAnchorByRows(thousand, tailAnchor(thousand, 24), -i), 24)
  const started = performance.now()
  for (let i = 0; i < 1000; i++) sliceViewport(thousand, moveAnchorByRows(thousand, tailAnchor(thousand, 24), -(i % 900)), 24)
  const averageMs = (performance.now() - started) / 1000
  ok(averageMs < 5, `1000-entry viewport navigation averages under 5ms (${averageMs.toFixed(3)}ms)`)

  console.log(`\n==== VIEWPORT RESULT: ${passed} passed, ${failed} failed ====\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
