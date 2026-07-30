/**
 * Screen / picker residue regression — "选择项目/Issue/会话时屏幕不残留其他东西".
 *
 * Root cause: Ink renders inline and, per frame, erases only as many lines as the
 * previous frame occupied. A frame taller than the terminal window scrolls, so
 * Ink can no longer reach the real top of that frame to erase it — stale lines
 * from the previous screen stay behind as residue (worst when a tall list picker
 * gives way to a shorter screen).
 *
 * The fix has two halves, both asserted here:
 *   1. <Screen> pins every route to exactly the terminal height (overflow:hidden)
 *      so no frame ever scrolls → no residue on any transition.
 *   2. Select reserves enough chrome rows that a long list window never exceeds
 *      the terminal, so nothing is clipped/garbled at the bottom.
 *
 * Run:  npm run test:screen
 */
import React from 'react'
import { Box, Text } from 'ink'
import { render } from 'ink-testing-library'
import { Screen } from '../src/components/Screen.js'
import { Select } from '../src/components/primitives.js'

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
const lineCount = (s: string) => s.split('\n').length

let pass = 0, fail = 0
function ok(c: boolean, m: string) { c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.error(`  ✗ ${m}`)) }

// ink-testing-library's stdout reports no `rows`, so Screen falls back to 24.
const ROWS = 24

async function main() {
  console.log('\n[SCREEN] no-residue picker transitions\n')

  // ── 1. Without Screen, a tall frame overflows the terminal (the bug). ───────
  const tall = render(
    <Box flexDirection="column">
      {Array.from({ length: 40 }, (_, i) => <Text key={i}>item {i}</Text>)}
    </Box>,
  )
  await delay(30)
  const tallLines = lineCount(tall.lastFrame() ?? '')
  ok(tallLines > ROWS, `uncapped tall frame overflows terminal (rendered ${tallLines} > ${ROWS})`)

  // ── 2. Screen caps the same tall content to exactly the terminal height. ───
  const capped = render(
    <Screen>
      <Box flexDirection="column">
        {Array.from({ length: 40 }, (_, i) => <Text key={i}>item {i}</Text>)}
      </Box>
    </Screen>,
  )
  await delay(30)
  const capFrame = capped.lastFrame() ?? ''
  ok(lineCount(capFrame) === ROWS, `Screen caps frame to terminal height (${lineCount(capFrame)} === ${ROWS})`)

  // ── 3. Realistic picker: AIMUX line + header + a 40-item Select + footer,
  //       wrapped in Screen, must fit within the terminal with the footer
  //       visible and the list windowed (overflow items hidden, not spilled). ─
  const items = Array.from({ length: 40 }, (_, i) => ({ label: `项目 ${i}`, value: `p${i}`, desc: `desc ${i}` }))
  const picker = render(
    <Screen>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text dimColor>AIMUX · 已连接</Text>
        <Text bold color="cyan">选择当前路径的绑定项目</Text>
        <Text color="gray">/some/path</Text>
        <Box marginTop={1}>
          <Select items={items} />
        </Box>
        <Text color="gray">↑↓ 选择 · 回车确认 · Esc 退出</Text>
      </Box>
    </Screen>,
  )
  await delay(30)
  const pf = strip(picker.lastFrame() ?? '')
  ok(lineCount(picker.lastFrame() ?? '') === ROWS, `picker frame pinned to terminal height (${lineCount(picker.lastFrame() ?? '')} === ${ROWS})`)
  ok(pf.includes('Esc 退出'), 'picker footer visible (list did not push it off / clip it)')
  ok(!pf.includes('项目 39'), 'list is windowed — tail item not spilled onto screen')
  ok(/还有 \d+ 项/.test(pf), 'windowed overflow shows a "还有 N 项" hint')

  // ── 4. Transition tall-picker → short screen leaves no residue: the new frame
  //       is still exactly terminal height (constant → Ink erase realigns) and
  //       contains none of the old picker's lines. ─────────────────────────────
  picker.rerender(
    <Screen>
      <Box paddingX={2} paddingY={1}>
        <Text color="green">准备就绪，进入对话…</Text>
      </Box>
    </Screen>,
  )
  await delay(30)
  const after = strip(picker.lastFrame() ?? '')
  ok(lineCount(picker.lastFrame() ?? '') === ROWS, `post-transition frame still terminal height (${lineCount(picker.lastFrame() ?? '')} === ${ROWS})`)
  ok(!after.includes('选择当前路径'), 'previous picker heading gone after transition (no residue)')
  ok(after.includes('准备就绪'), 'new screen content rendered')

  console.log(`\n==== SCREEN RESULT: ${pass} passed, ${fail} failed ====\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error('FATAL', e); process.exit(2) })
