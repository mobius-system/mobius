import { build } from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
const sourceRoot = '/home/tianyi/imac-test/mobius/frontend/src/components/viewer'
async function bundle(m) {
  const r = await build({ entryPoints: [path.join(sourceRoot, m)], bundle: true, format: 'esm', target: 'node18', write: false, logLevel: 'silent' })
  return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'))
}
const summaries = await bundle('header-summary.ts')
const f = '/home/tianyi/.claude/projects/-home-tianyi-imac-test/fb072218-e2b3-41fc-b75c-57613204b118.jsonl'
const entries = []
for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line.trim()) continue; try { entries.push(JSON.parse(line)) } catch {} }
const byId = new Map(entries.map(e => [e.uuid, e]))
const ids = ['eaf92f2f-6afd-4662-b96b-e20d88ccb202','f8c28303-953d-49d6-9db8-37d5d2bdd81f','f36b2fef-c580-409c-83b7-b36509f76377','4d7e3e6c-6ff9-4e8d-b11a-90f6ea4970c5']
for (const id of ids) {
  const e = byId.get(id)
  const hs = summaries.buildHeaderSummary(e)
  console.log(id.slice(0,8), 'canCompact=', hs.canCompact, 'len=', hs.full.length, 'nlines=', (hs.full.match(/\n/g)||[]).length, '|', hs.short.slice(0,60))
}
