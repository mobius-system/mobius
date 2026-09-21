import { build } from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'

const sourceRoot = '/home/tianyi/imac-test/mobius/frontend/src/components/viewer'
async function bundle(m) {
  const r = await build({ entryPoints: [path.join(sourceRoot, m)], bundle: true, format: 'esm', target: 'node18', write: false, logLevel: 'silent' })
  return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'))
}
const taskProgress = await bundle('task-progress.ts')
const extractors = await bundle('entry-extract.ts')

const files = JSON.parse(fs.readFileSync('/tmp/cand_files.json', 'utf8'))
const out = []
for (const f of files) {
  const entries = []
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line)) } catch {}
  }
  // 只取含 TaskCreate 的尾部窗口 (前端默认 200 条)
  const items = entries.slice(-400).map((entry, i) => ({ entry, lineNo: i + 1 }))
  const toolItems = items.filter(it => extractors.extractTaskToolCalls(it.entry).length > 0)
  if (toolItems.length < 2) continue
  const { plans, suppressed } = taskProgress.buildTaskPlans(items)
  const stripped = toolItems.filter(it => !plans.has(it.entry.uuid))
  if (stripped.length >= 1) out.push({ f, tool: toolItems.length, plans: plans.size, stripped: stripped.length, tail: toolItems.slice(-3).map(t => t.entry.uuid) })
}
out.sort((a, b) => (b.tool - b.plans) - (a.tool - a.plans))
for (const o of out.slice(0, 12)) console.log(o.stripped, 'stripped /', o.tool, 'tool cards,', o.plans, 'plans —', path.basename(o.f))
fs.writeFileSync('/tmp/scan-out.json', JSON.stringify(out, null, 1))
