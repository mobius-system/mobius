import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE='http://127.0.0.1:45618'
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:1600,height:1000}})).newPage()
await p.goto(BASE+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(1500)
if(await p.locator('input[type="password"]').count()){await p.fill('input[placeholder="账户"]','fuqingxu');await p.fill('input[placeholder="密码"]','fuqingxu');await p.locator('button:has-text("登录"), button[type="submit"]').first().click();await p.waitForTimeout(4000)}
await p.goto(BASE+'/u/fuqingxu/p/9a533442/i/03120997',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(9000)
if(await p.locator('#layout-mode-choice-title').count()){await p.locator('button:has-text("常规模式")').first().click();await p.waitForTimeout(2500)}
await p.locator('[data-tour="top-search"]').click({timeout:60000}); await p.waitForTimeout(1500)
const out=await p.evaluate(()=>{
  const m=n=>{ if(!n) return 'missing'; const s=getComputedStyle(n), r=n.getBoundingClientRect()
    return `${s.fontSize}  y=${Math.round(r.y)} h=${Math.round(r.height)} w=${Math.round(r.width)}` }
  const g=s=>document.querySelector(s)
  return {
    caption: m([...document.querySelectorAll('span')].find(x=>x.textContent.trim()==='范围')),
    scopePill当前项目: m(g('[data-search-scope="project"]')),
    scopePill全部项目: m(g('[data-search-scope="all"]')),
    modeSeg深度搜索: m([...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='深度搜索')),
    modeSeg快速搜索: m([...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='快速搜索')),
    rangeSelect: m(g('select[title="时间范围"]')),
    input: m(g('input[placeholder*="搜索"]')),
    aaBtn: m([...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Aa')),
  }
})
for (const [k,v] of Object.entries(out)) console.log(k.padEnd(20), v)
await p.screenshot({path:'/home/tianyi/imac-test/scratch/search-modal-controls-row/10-fonts-bumped.png'})
await b.close()
