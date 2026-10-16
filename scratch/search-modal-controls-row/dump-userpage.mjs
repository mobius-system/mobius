import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE='http://127.0.0.1:45616'
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:1600,height:1000}})).newPage()
await p.goto(BASE+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2000)
if(await p.locator('input[type="password"]').count()){await p.fill('input[placeholder="账户"]','fuqingxu');await p.fill('input[placeholder="密码"]','fuqingxu');await p.locator('button:has-text("登录"), button[type="submit"]').first().click();await p.waitForTimeout(5000)}
await p.goto(BASE+'/u/fuqingxu',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(8000)
if(await p.locator('#layout-mode-choice-title').count()){await p.locator('button:has-text("常规模式")').first().click();await p.waitForTimeout(2500)}
const out = await p.evaluate(() => {
  const rows = []
  const walk = (root, depth, path) => {
    for (const el of root.children) {
      const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
      const isInput = ['INPUT','SELECT','TEXTAREA'].includes(el.tagName)
      if (hasText || isInput) {
        const s = getComputedStyle(el)
        rows.push({ path, tag: el.tagName, txt: (el.textContent||el.value||el.placeholder||'').trim().slice(0,28), font: s.fontSize, cls: (el.className||'').slice(0,60) })
      }
      if (depth < 4 && el.children.length) walk(el, depth+1, path + '>' + el.tagName + (hasText ? '[txt]' : ''))
    }
  }
  const input = document.querySelector('[data-project-hierarchy-search]')
  // 整条搜索工具栏
  const bar = input && input.closest('div.mt-4') || (input && input.parentElement.parentElement)
  if (bar) walk(bar, 0, 'BAR')
  const modal = document.querySelector('input[placeholder*="搜索"]')
  const emb = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim().startsWith('深度搜索会话内容'))
  const embRow = emb && emb.parentElement
  if (embRow) walk(embRow, 0, 'EMBEDDED-ROW')
  return rows
})
for (const r of out) console.log(`${r.font.padStart(5)} | ${r.tag.padEnd(6)} | ${r.txt.padEnd(28)} | ${r.path}`)
await b.close()
