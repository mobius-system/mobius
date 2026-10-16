import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE='http://127.0.0.1:45616'
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:1600,height:1000}})).newPage()
await p.goto(BASE+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2000)
if(await p.locator('input[type="password"]').count()){await p.fill('input[placeholder="账户"]','fuqingxu');await p.fill('input[placeholder="密码"]','fuqingxu');await p.locator('button:has-text("登录"), button[type="submit"]').first().click();await p.waitForTimeout(5000)}
await p.goto(BASE+'/u/fuqingxu/p/9a533442/i/03120997',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(8000)
if(await p.locator('#layout-mode-choice-title').count()){await p.locator('button:has-text("常规模式")').first().click();await p.waitForTimeout(2500)}
await p.locator('[data-tour="top-search"]').click({timeout:60000}); await p.waitForTimeout(1500)
await p.keyboard.type('queue'); await p.waitForTimeout(3000)
const out = await p.evaluate(() => {
  const modal = document.querySelector('div.rounded-2xl.shadow-2xl') || document.querySelector('input[placeholder*="搜索"]').closest('div.rounded-2xl')
  const rows = []
  ;[...modal.querySelectorAll('*')].forEach(el => {
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('')
    const isCtl = ['INPUT','SELECT','BUTTON'].includes(el.tagName)
    if (!own && !isCtl) return
    const s = getComputedStyle(el)
    rows.push(`${s.fontSize.padStart(5)} | ${el.tagName.padEnd(6)} | ${(own || el.placeholder || '').slice(0,30).padEnd(30)} | ${(el.className||'').slice(0,70)}`)
  })
  return rows
})
console.log(out.join('\n'))
await p.screenshot({path:'/home/tianyi/imac-test/scratch/search-modal-controls-row/20-modal-with-results.png'})
await b.close()
