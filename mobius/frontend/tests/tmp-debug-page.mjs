import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright/index.mjs'
const BASE=process.env.BASE || 'http://127.0.0.1:45618'
const browser = await chromium.launch()
const page = await (await browser.newContext({viewport:{width:1600,height:1000}})).newPage()
page.on('console', m => { if (m.type()==='error') console.log('[console]', m.text().slice(0,200)) })
const {token} = await (await page.request.post(`${BASE}/api/auth/login`, {data:{username:'admin',password:'admin'}})).json()
await page.goto(`${BASE}/welcome`)
await page.evaluate(([t])=>{window.localStorage.setItem('cc-token',t);window.localStorage.setItem('layout_mode','normal_mode');window.localStorage.removeItem('mobius:ui:session-density')}, [token])
await page.goto(`${BASE}/u/admin/p/9a533442/i/a2b72394?session=a382b3db`)
await page.waitForTimeout(8000)
console.log('url:', page.url())
console.log('title:', await page.title())
console.log('body head:', (await page.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ').slice(0,600))
console.log('counts:', await page.evaluate(()=>({
  entryCard: document.querySelectorAll('.jsonl-entry-card').length,
  details: document.querySelectorAll('details').length,
  triggers: document.querySelectorAll('.round-group-trigger').length,
  uuidCards: document.querySelectorAll('[data-jsonl-entry-id]').length,
})))
await page.screenshot({path:'/tmp/verify-page.png', fullPage:false})
await browser.close()
