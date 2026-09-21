import fs from 'node:fs'
const f='/home/tianyi/.claude/projects/-home-tianyi-imac-test/fb072218-e2b3-41fc-b75c-57613204b118.jsonl'
const entries=[]
for (const line of fs.readFileSync(f,'utf8').split('\n')) { if(!line.trim()) continue; try{entries.push(JSON.parse(line))}catch{} }
const uuids=["eaf92f2f-6afd-4662-b96b-e20d88ccb202","f8c28303-953d-49d6-9db8-37d5d2bdd81f","f36b2fef-c580-409c-83b7-b36509f76377","4d7e3e6c-6ff9-4e8d-b11a-90f6ea4970c5","4196b087-2c0e-442b-ab6e-797cb22f79db","f5ba08df-3dc3-4e68-88d9-7e25de2730be","36f5daa6-977c-4780-82d3-0a63e56c98bb","93ef1829-d7bb-4ee9-beec-f9b5015c6134","7f9dcc0d-8f93-4ad3-8780-07911e260b2c","f935f94a-9f10-4e35-bd76-0c926225e2e9","8c396f57-3e98-4689-8d7a-09a4d12c236d","1e30c708-a4c3-4fc8-8a04-bd93114ca8ff","47484903-0aa8-4abc-bb58-e1066fc57c3a","831d3eb5-101d-4eb4-8d1c-941f885215a9","efb324b6-a23d-458f-8d37-23f87b83d7d4","c9a5dad4-a85b-423a-b6b3-684a945283e7","1f3310a9-6d12-433c-864e-55ca0b04973a","67495ea8-d305-4026-969a-972892b48600","6b6e95c2-0b62-469f-a8af-de876a1c22ca","87958e01-a30a-4983-8bb2-d43413e5b477","ca918541-7ffc-4953-abbb-8342abbf1fdf","4ab55dd0-6b93-4471-bbd2-add25c04bb2f"]
const idx=new Map(entries.map((e,i)=>[e.uuid,i]))
const n=entries.length
console.log('total', n)
console.log(uuids.map(u=>{const i=idx.get(u); return i==null?'?':(n-i)}).join(' '))
console.log('tail distance (from end) of last kept:', ["b2544f2f-38e1-4878-abd7-7754f8988d78","5aac0826-b351-4a05-8b2a-305efbc69bdc"].map(u=>n-idx.get(u)).join(' '))
