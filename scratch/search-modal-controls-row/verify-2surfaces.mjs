import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE=process.env.BASE || 'http://127.0.0.1:45618'
const OUT='/home/tianyi/imac-test/scratch/search-modal-controls-row'
const TAG=process.env.TAG || 'dev'
const b=await chromium.launch()
const p=await (await b.newContext({viewport:{width:1600,height:1000}})).newPage()
await p.goto(BASE+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2000)
if(await p.locator('input[type="password"]').count()){await p.fill('input[placeholder="账户"]','fuqingxu');await p.fill('input[placeholder="密码"]','fuqingxu');await p.locator('button:has-text("登录"), button[type="submit"]').first().click();await p.waitForTimeout(5000)}

// (1) 浮层搜索弹窗 (issue 页)
await p.goto(BASE+'/u/fuqingxu/p/9a533442/i/03120997',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(9000)
if(await p.locator('#layout-mode-choice-title').count()){await p.locator('button:has-text("常规模式")').first().click();await p.waitForTimeout(2500)}
await p.locator('[data-tour="top-search"]').click({timeout:60000}); await p.waitForTimeout(1500)
const dump = async (label) => {
  const rows = await p.evaluate(() => {
    const modal = document.querySelector('div.rounded-2xl.shadow-2xl')
    const box = modal.querySelector('div.shrink-0.border-b') || modal.firstElementChild
    return [...box.querySelectorAll('*')].filter(el => {
      const s=getComputedStyle(el)
      return (['INPUT','SELECT','BUTTON'].includes(el.tagName) || [...el.childNodes].some(n=>n.nodeType===3 && n.textContent.trim())) && s.display!=='none'
    }).map(el => `${getComputedStyle(el).fontSize.padStart(5)} | ${el.tagName.padEnd(6)} | ${((el.placeholder||el.textContent||'')+'').trim().slice(0,24).padEnd(24)} | ${(el.className||'').slice(0,55)}`)
  })
  console.log(`--- ${label} (搜索框区域) ---`); console.log(rows.join('\n'))
}
await dump('浮层弹窗')
await p.screenshot({path:`${OUT}/30-${TAG}-modal-header.png`, clip:{x:460,y:76,width:700,height:100}})
await p.keyboard.press('Escape'); await p.waitForTimeout(600)

// (2) 项目列表页 UserPage: 搜索工具栏 + 内嵌深度搜索控件行
await p.goto(BASE+'/u/fuqingxu',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(9000)
if(await p.locator('#layout-mode-choice-title').count()){await p.locator('button:has-text("常规模式")').first().click();await p.waitForTimeout(2500)}
const y = await p.evaluate(() => {
  const i = document.querySelector('[data-project-hierarchy-search]')
  const bar = i.closest('div.mt-4')
  return Math.round(bar.getBoundingClientRect().y)
})
const rows2 = await p.evaluate(() => {
  const i = document.querySelector('[data-project-hierarchy-search]')
  const bar = i.closest('div.mt-4')
  const container = bar.parentElement
  const cut = container.getBoundingClientRect().y + 200
  return [...container.querySelectorAll('*')].filter(el => {
    const s=getComputedStyle(el); const r=el.getBoundingClientRect()
    return r.y < cut && r.height>0 && (['INPUT','SELECT','BUTTON'].includes(el.tagName) || [...el.childNodes].some(n=>n.nodeType===3 && n.textContent.trim())) && s.display!=='none'
  }).map(el => { const r=el.getBoundingClientRect(); return `${getComputedStyle(el).fontSize.padStart(5)} | ${el.tagName.padEnd(6)} | ${((el.placeholder||el.textContent||'')+'').trim().slice(0,22).padEnd(22)} | y=${Math.round(r.y)}` })
})
console.log('--- 项目列表搜索框 ---'); console.log(rows2.join('\n'))
await p.screenshot({path:`${OUT}/31-${TAG}-userpage-bar.png`, clip:{x:0,y:Math.max(0,bar2y(rows2,y)),width:1600,height:230}})
function bar2y(){ return y-20 }
await b.close()
