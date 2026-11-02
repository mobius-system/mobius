const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-file-sources-'));
process.env.DB_PATH = path.join(temp, 'db.sqlite');
process.env.MOBIUS_DATA_PATH = process.env.CORE_DATA_PATH = temp;
process.env.MODEL_ACCESS_PATH = path.join(temp, 'models.json');
process.env.WORKSPACE_ROOT = temp;
process.env.JWT_SECRET = 'bridge-files-test';
const fake = path.join(temp, 'aimux');
fs.writeFileSync(fake, `#!/usr/bin/env node
const a=process.argv.slice(2),remote=a[2];
if(remote==='old-device'){console.error("error: host 'old-device' not found in ~/.ssh/config or bridge registry");process.exit(1)}
if(a[1]==='list') console.log(JSON.stringify({entries:[{name:'hello.txt',path:'hello.txt',type:'file',size:5}]}));
else if(a[1]==='stat') console.log(JSON.stringify({exists:true,type:'file',size:5}));
else if(a[1]==='read') console.log(Buffer.from('hello').toString('base64'));
`,{mode:0o755});
process.env.AIMUX_BIN = fake;
const express=require('express'),jwt=require('jsonwebtoken');
const {db}=require('../db');
const {Projects}=require('../backend/repositories/projects');
const {Researches}=require('../backend/repositories/researches');
const {Sessions}=require('../backend/repositories/sessions');
let remotes=[{name:'new-device',status:'connected'}];
const broker=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer fixture');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({remotes}));});
const app=express();app.use(express.json());app.use('/api/projects',require('../backend/routes/projects'));
const server=http.createServer(app);
async function main(){
 await new Promise(r=>broker.listen(0,'127.0.0.1',r));
 process.env.AIMUX_BRIDGE_RUNTIME=path.join(temp,'runtime.json');
 fs.writeFileSync(process.env.AIMUX_BRIDGE_RUNTIME,JSON.stringify({url:`http://127.0.0.1:${broker.address().port}`,token:'fixture'}));
 for(const [id,role] of [['admin','admin'],['reader','user']]) db.prepare('INSERT INTO users (id,display_name,password_hash,role,work_dir,group_id) VALUES (?,?,?,?,?,?)').run(id,id,'hash',role,temp,'default');
 Projects.insert({id:'p',name:'P',createdBy:'reader',researchEnabled:true});
 db.prepare("INSERT INTO project_memberships (project_id,user_id,role) VALUES ('p','admin','developer')").run();
 db.prepare('UPDATE projects SET aimux_remote_inventory=? WHERE id=?').run(JSON.stringify([{name:'old-device',status:'connected',remote_path:''},{name:'old-device',status:'connected'}]),'p');
 Researches.insert({id:'r',project_id:'p',title:'R',description:'',created_by:'reader'});
 Sessions.insert({session_id:'s',scope_type:'research',research_id:'r',project_id:'p',user_id:'reader',name:'S',session_key:'web:reader:s',pc_client_metadata:{aimux_id:'bound-device',add_remote_aimux_mcp:true,local_path:'/work'}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}/api/projects/p`;
 async function request(url,user='admin'){const response=await fetch(base+url,{headers:{authorization:`Bearer ${jwt.sign({id:user,role:user==='admin'?'admin':'user'},process.env.JWT_SECRET)}`}});return {status:response.status,body:await response.json()};}
 let r=await request('/remote-file-sources');assert.equal(r.status,200);assert.equal(r.body.remotes.length,2);assert.equal(r.body.remotes.find(x=>x.name==='old-device').status,'offline');assert.equal(r.body.remotes.find(x=>x.name==='new-device').status,'connected');
 r=await request('/remote-file-sources','reader');assert.deepEqual(r.body.remotes.map(x=>x.name),['old-device']);
 r=await request('/remote-files?remote=new-device');assert.equal(r.status,200);assert.equal(r.body.entries[0].name,'hello.txt');
 r=await request('/remote-file?remote=new-device&path=/hello.txt');assert.equal(r.body.content,'hello');
 r=await request('/remote-files?remote=old-device');assert.equal(r.status,400);assert.match(r.body.error,/连接已失效/);
 r=await request('/remote-files?remote=new-device','reader');assert.equal(r.status,400);
 r=await request('/remote-files?session=s&remote=bound-device','reader');assert.equal(r.status,200);assert.equal(r.body.root_path,'/work');
 r=await request('/remote-files?remote=unknown-device');assert.equal(r.status,400);
 remotes.push({name:'second-device',status:'connected'});r=await request('/remote-file-sources');assert(r.body.remotes.some(x=>x.name==='second-device'));
 remotes=[];r=await request('/remote-files?remote=new-device');assert.equal(r.status,400);
 console.log('PASS real routes + bridge registry + CLI: discovery, dedup, stale status, browse/read, refresh, session scope and unauthorized device rejection');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{server.closeAllConnections?.();await new Promise(r=>server.close(r));await new Promise(r=>broker.close(r));db.close();fs.rmSync(temp,{recursive:true,force:true});});
