const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const os = require('node:os')
const path = require('node:path')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-device-db-'))
process.env.DB_PATH = path.join(root, 'test.db')
process.env.MOBIUS_DATA_PATH = root
process.env.CORE_DATA_PATH = root
process.env.MOBIUS_SELF_TEST_ON_BOOT = '0'
const { db } = require('../db')
const { Sessions } = require('../backend/repositories/sessions')
db.prepare("INSERT INTO users (id, display_name, password_hash, role, work_dir) VALUES ('owner', 'Owner', 'x', 'admin', ?)").run(root)
db.prepare("INSERT INTO projects (id, name, created_by, research_enabled) VALUES ('p', 'P', 'owner', 1)").run()
db.prepare("INSERT INTO researches (id, project_id, title, created_by) VALUES ('r', 'p', 'R', 'owner')").run()
Sessions.insert({session_id:'research-agent', project_id:'p', scope_type:'research', research_id:'r', research_role:'research_assistant', user_id:'owner', name:'Device test', session_key:'test:device', pc_client_metadata:null})
const { parsePcClientMetadata, pcTaskModePrompt, aimuxRemoteNameFromMeta } = require('../backend/services/pc-client-context')
const source = fs.readFileSync(require.resolve('../backend/routes/sessions.ts'), 'utf8')
const start = source.indexOf("router.patch('/:id/aimux-device'")
const end = source.indexOf('\n});', start) + 4
let handler, stored = null, response, status
vm.runInNewContext(ts.transpileModule(source.slice(start,end), { compilerOptions:{target:ts.ScriptTarget.ES2022} }).outputText, {
 router:{patch:(url,auth,fn)=>handler=fn}, auth:()=>{}, userOf:()=>({id:'owner'}),
 findSessionOperable:()=>Sessions.findById('research-agent'),
 parsePcClientMetadata, Sessions,auditSessionAccess:()=>{},
})
for (const id of ['remote-a','remote-b','remote-a','','remote-b']) {
 handler({params:{id:'research-agent'},body:{aimux_id:id}}, {status:n=>{status=n},json:value=>{response=JSON.parse(JSON.stringify(value))}})
 stored = Sessions.findById('research-agent').pc_client_metadata
 assert.equal(Sessions.listForResearch('r')[0].pc_client_metadata,stored)
 assert.equal(status,undefined)
 assert.equal(response.pc_client_metadata.aimux_id,id)
 assert.equal(response.pc_client_metadata.work_mode,id?'dual':'hub')
 assert.equal(aimuxRemoteNameFromMeta(stored),id||undefined)
 if(id) assert.match(pcTaskModePrompt(stored,'zh'),new RegExp(id))
}
assert.equal(response.pc_client_metadata.initial_aimux_id,'remote-a')
console.log('PASS Research device route: bind/switch/revert/unbind/rebind, MCP remote and prompt remain consistent')

db.close()
fs.rmSync(root,{recursive:true,force:true})
