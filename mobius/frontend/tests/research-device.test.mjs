import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { chromium } from 'playwright'

const frontend = fileURLToPath(new URL('..', import.meta.url))
process.chdir(frontend)
const css = await postcss([tailwindcss({ config: path.join(frontend, 'tailwind.config.js') })])
  .process(await fs.readFile('src/index.css', 'utf8'), { from: 'src/index.css' })
const bundle = await build({
  stdin: { resolveDir: frontend, loader: 'tsx', contents: `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { MemoryRouter } from 'react-router-dom'
    import { useStore } from './src/store'
    import { NewSessionModal } from './src/components/modals'
    import { ResearchAgentTeamModal } from './src/components/research-agent-team-modal'
    import { RemoteAimuxMcpIndicator } from './src/components/aimux-link-indicator'
    import { SessionDevicePicker } from './src/components/session-device-picker'
    useStore.setState({ user: { id: 'fixture', role: 'admin' }, theme: 'dark' })
    const root = createRoot(document.getElementById('root'))
    function Header() {
      const [meta, setMeta] = useState(null)
      return <div className="chat-major-panel" style={{width: 360, padding: 20}}><div className="mobius-session-chat-header">
        <RemoteAimuxMcpIndicator session={{scope_type: 'issue', pc_client_metadata: meta}} sessionId="issue-session" showHub
          onSwitchDevice={async (id, old) => { window.switches.push([id, old]); setMeta({aimux_id: id, add_remote_aimux_mcp: !!id, initial_aimux_id: meta?.initial_aimux_id || old}) }} />
      </div></div>
    }
    window.switches = []
    window.render = kind => root.render(<MemoryRouter>{kind === 'single'
      ? <NewSessionModal researchId="research" projectId="project" existingSessions={[]} defaultName="设备验证" defaultDescription="验证研究设备" onClose={()=>{}} onCreated={s=>window.created=s} />
      : kind === 'team' ? <ResearchAgentTeamModal researchId="research" existingSessions={[]} onClose={()=>{}} onRefresh={()=>{}} onDone={s=>window.created=s} />
      : kind === 'locked' ? <SessionDevicePicker value={{aimuxId: 'missing-device', guiAuthorized: false}} onChange={()=>{throw Error('locked changed')}} dark disabled />
      : <Header />}</MemoryRouter>)
  ` },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  plugins: [{ name: 'skip-unrelated-team-scene', setup(b) {
    b.onResolve({filter: /research-agent-team-scene$/}, () => ({path:'scene', namespace:'fixture'}))
    b.onLoad({filter: /.*/, namespace:'fixture'}, () => ({contents: 'export function ResearchAgentTeamScene(){return null}'}))
  }}],
})
const browser = await chromium.launch({ headless: true })
const errors = []
const requests = []
const artifacts = path.join(os.tmpdir(), 'research-device-validation')
await fs.mkdir(artifacts, { recursive: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  page.on('pageerror', e => errors.push(e.message))
  await page.route('http://research.test/**', async route => {
    const url = new URL(route.request().url()), body = route.request().postDataJSON()
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/aimux_bridge/')) return route.fulfill({contentType:'text/html',body:'<html></html>'})
    requests.push({url:url.pathname, body})
    let data = []
    if (url.pathname.endsWith('/remotes')) data = {remotes:[{name:'online-device',status:'connected',platform:'Linux',gui:{available:true}},{name:'offline-device',status:'disconnected',platform:'Windows'}]}
    else if (url.pathname.endsWith('/connection')) data = {identifier:url.pathname.split('/').at(-2),event_stream_connected:url.pathname.includes('online-device')}
    else if (url.pathname.endsWith('/model-options')) data = [{key:'codex', label:'Codex', title:'Codex'}]
    else if (url.pathname.endsWith('/default-model')) data = {model:'codex'}
    else if (url.pathname.endsWith('/prompt-stats')) data = {}
    else if (url.pathname.endsWith('/context-preview')) data = {body:'研究设备预览', sources:{skills:[{id:'builtin:mobius-aimux',name:'mobius-aimux',dirName:'mobius-aimux',scope:'builtin'},{id:'builtin:mobius-gui-operation',name:'mobius-gui-operation',dirName:'mobius-gui-operation',scope:'builtin'}],memories:[]}, defaults:{excluded_skill_ids:['builtin:mobius-aimux','builtin:mobius-gui-operation'],excluded_memory_ids:[]}}
    else if (url.pathname === '/api/researches/research/sessions') data = {session_id:'created-'+requests.filter(r=>r.url===url.pathname).length}
    else if (url.pathname === '/api/projects/project') data = {id:'project',name:'Project'}
    else if (url.pathname === '/api/projects') data = [{id:'project',name:'Project'}]
    else if (route.request().method() !== 'GET') data = {ok:true}
    await route.fulfill({contentType:'application/json',body:JSON.stringify(data)})
  })
  await page.goto('http://research.test/')
  await page.setContent(`<html class="dark"><head><style>${css.css}</style></head><body><div id="root"></div></body></html>`)
  await page.addScriptTag({content:bundle.outputFiles[0].text})
  await page.evaluate(()=>window.render('single'))
  await page.getByRole('button', {name:'中枢',exact:true}).click()
  await page.getByRole('button', {name:/online-device \(授权操作图形界面\)/}).click()
  await page.screenshot({path:path.join(artifacts,'single.png')})
  await page.getByRole('button', {name:'下一步 · 预览配置',exact:true}).click()
  await page.getByText('研究设备预览', {exact:true}).waitFor()
  const preview = requests.filter(r=>r.url.endsWith('/context-preview')).at(-1).body
  assert.equal(preview.pc_client_metadata.aimux_id,'online-device')
  assert.equal(preview.pc_client_metadata.gui_authorized,true)
  await page.getByRole('button', {name:'确认并创建',exact:true}).click()
  await page.waitForFunction(()=>window.created)
  const single = requests.filter(r=>r.url==='/api/researches/research/sessions').at(-1).body
  assert.deepEqual(single.pc_client_metadata,preview.pc_client_metadata)
  assert(!single.excluded_skill_ids.includes('builtin:mobius-aimux'))
  assert(!single.excluded_skill_ids.includes('builtin:mobius-gui-operation'))
  console.log('PASS single Research form: GUI device, required skills, identical preview/create metadata')

  await page.evaluate(()=>window.render('team'))
  await page.getByRole('button', {name:'中枢',exact:true}).click()
  await page.getByRole('button', {name:/offline-device/}).click()
  await page.screenshot({path:path.join(artifacts,'team.png')})
  // Team tabs keep each agent's selection separately.
  await page.getByRole('button', {name:/创建.*启动/}).click()
  await page.waitForFunction(()=>document.body.textContent.includes('已写入团队 Blackboard 记录'))
  const team = requests.filter(r=>r.url==='/api/researches/research/sessions').slice(1).map(r=>r.body)
  assert.equal(team.length,3)
  assert.equal(team[0].pc_client_metadata.aimux_id,'offline-device')
  assert.equal(team[0].pc_client_metadata.work_mode,'dual')
  assert.equal(team[1].pc_client_metadata,undefined)
  assert.equal(team[2].pc_client_metadata,undefined)
  assert(!team[0].excluded_skill_ids.includes('builtin:mobius-aimux'))
  console.log('PASS team Research form: selected remote persisted per agent; other agents remain on hub')

  await page.evaluate(()=>window.render('header'))
  const indicator = page.getByTestId('remote-aimux-mcp-indicator')
  await indicator.click()
  await page.getByRole('menuitemradio', {name:/online-device/}).click()
  await page.waitForFunction(()=>document.querySelector('[data-testid="remote-aimux-mcp-indicator"]')?.getAttribute('data-connection-status')==='connected')
  await indicator.click()
  await page.getByRole('menuitemradio', {name:/offline-device/}).click()
  await page.waitForFunction(()=>document.querySelector('[data-testid="remote-aimux-mcp-indicator"]')?.getAttribute('data-connection-status')==='disconnected')
  assert.match(await indicator.getAttribute('aria-label'),/依托中枢继续执行任务/)
  await indicator.click()
  await page.getByRole('menuitem', {name:/撤回初始设备/}).click()
  await indicator.click()
  await page.getByRole('menuitem', {name:'回到中枢',exact:true}).click()
  assert.match(await indicator.getAttribute('aria-label'),/当前会话在中枢/)
  assert.deepEqual(await page.evaluate(()=>window.switches),[['online-device',''],['offline-device','online-device'],['online-device','offline-device'],['','online-device']])
  await page.screenshot({path:path.join(artifacts,'header.png')})
  await page.evaluate(()=>window.render('locked'))
  assert(await page.getByRole('button', {name:'missing-device',exact:true}).isDisabled())
  assert.deepEqual(errors,[])
  console.log('PASS classic Issue header: unbound hub icon, binding, connected/disconnected, original-device return, hub return; inherited missing device stays visible and locked')
  console.log('Screenshots:',artifacts)
} finally { await browser.close() }
