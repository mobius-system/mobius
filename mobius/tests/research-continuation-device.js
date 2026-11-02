const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const { pcClientMetadataForContinuation } = require('../backend/services/pc-client-context')
const source = fs.readFileSync(require.resolve('../backend/routes/researches.ts'), 'utf8')
const start = source.indexOf("  const sessionLanguage = language === 'en' ? 'en' : 'zh';")
const end = source.indexOf('\n  } catch (e) {\n    if (String((e as Error).message', start)
assert(start > 0 && end > start)
const code = ts.transpileModule(`(function create() { ${source.slice(start, end)}\n } catch(e) { throw e } })()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
for (const raw of [null, { work_mode: 'dual', aimux_id: 'current', initial_aimux_id: 'previous', local_path: '/work', gui_authorized: true }, JSON.stringify({ work_mode: 'pc', aimux_id: 'current', initial_aimux_id: 'previous' })]) {
 for (const continuation of [false, true]) {
  let inserted, snapshotMeta
  const from = { session_id: 'old', scope_type: 'research', research_id: 'research', pc_client_metadata: raw }
  const client = { work_mode: 'dual', aimux_id: 'client-default' }
  vm.runInNewContext(code, {
   language: 'zh', uuid: () => 'new-session', user: { id: 'user' }, excluded_skill_ids: [], excluded_memory_ids: [],
   sanitizeIds: x => x, req: { body: { pc_client_metadata: client }, params: { researchId: 'research' } },
   continueFromSessionId: continuation ? 'old' : '', findSessionOperable: () => from,
   research: { project_id: 'project' }, Projects: { findById: () => ({ bind_path: '/project' }) },
   sessionJsonlPath: () => '/fixture/history.jsonl', writeSessionTransferBundle: () => ({ ok: true }),
   pcClientMetadataForContinuation, buildResearchSessionSelectionSnapshot: (u,r,s,m,meta) => { snapshotMeta = meta.pc_client_metadata; return { fixture: true } },
   Sessions: { insert: row => { inserted = row } }, resolvedModel: { sessionModelValue: 'model' }, name: 'name', description: 'description', role: 'research_assistant',
   res: { status: n => { throw new Error(`unexpected ${n}`) } }, console,
  })
  const expected = continuation ? pcClientMetadataForContinuation(raw) : client
  assert.deepEqual(JSON.parse(JSON.stringify(inserted.pc_client_metadata)), expected)
  assert.deepEqual(JSON.parse(JSON.stringify(snapshotMeta)), expected)
 }
}
console.log('PASS research continuation: source device inherited in snapshot and inserted row; new session keeps selected device')
