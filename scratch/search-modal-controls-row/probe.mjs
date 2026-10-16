import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = 'http://127.0.0.1:45618'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[placeholder="账户"]', 'fuqingxu')
  await page.fill('input[placeholder="密码"]', 'fuqingxu')
  await page.locator('button:has-text("登录"), button[type="submit"]').first().click()
  await page.waitForTimeout(4000)
}
await page.goto(BASE + '/u/fuqingxu/p/9a533442/i/03120997', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5000)
if (await page.locator('#layout-mode-choice-title').count()) {
  await page.locator('button:has-text("常规模式")').first().click()
  await page.waitForTimeout(2500)
}
await page.locator('[data-tour="top-search"]').click()
await page.waitForTimeout(1000)

const info = await page.evaluate(() => {
  const dump = (n) => { const r = n.getBoundingClientRect(); return { tag: n.tagName, text: (n.textContent || '').trim().slice(0, 40), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const scope = document.querySelector('[data-search-scope]')
  const header = scope ? scope.closest('div.shrink-0') : null
  const out = { headerHTML: header ? header.innerHTML.slice(0, 1600) : 'NO HEADER', items: [] }
  if (header) {
    const row = scope.parentElement.parentElement
    out.rowChildren = [...row.children].map(dump)
    const right = row.lastElementChild
    out.rightChildren = right ? [...right.children].map(dump) : []
    out.rowHTML = row.outerHTML.slice(0, 1200)
  }
  const input = document.querySelector('input[placeholder*="搜索"]')
  out.inputPlaceholder = input ? input.getAttribute('placeholder') : 'NO INPUT'
  return out
})
console.log('input placeholder:', JSON.stringify(info.inputPlaceholder))
console.log('row children:', JSON.stringify(info.rowChildren, null, 1))
console.log('right children:', JSON.stringify(info.rightChildren, null, 1))
console.log('--- rowHTML ---\n', info.rowHTML)
await page.screenshot({ path: '/home/tianyi/imac-test/scratch/search-modal-controls-row/probe.png' })
await browser.close()
