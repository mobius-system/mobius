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
const f = '/home/tianyi/.claude/projects/-home-tianyi-imac-test/fb072218-e2b3-41fc-b75c-57613204b118.jsonl'
const entries = []
for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line.trim()) continue; try { entries.push(JSON.parse(line)) } catch {} }
const items = entries.slice(-400).map((entry, i) => ({ entry, lineNo: i + 1 }))
const { plans } = taskProgress.buildTaskPlans(items)
const tools = items.filter(it => extractors.extractTaskToolCalls(it.entry).length > 0)
const stripped = tools.filter(it => !plans.has(it.entry.uuid)).map(it => it.entry.uuid)
const kept = tools.filter(it => plans.has(it.entry.uuid)).map(it => it.entry.uuid)
console.log('total entries', entries.length)
console.log('stripped', JSON.stringify(stripped))
console.log('kept', JSON.stringify(kept))
console.log('summary of first stripped:', JSON.stringify(extractors.extractTaskToolCalls(tools[0].entry)))
