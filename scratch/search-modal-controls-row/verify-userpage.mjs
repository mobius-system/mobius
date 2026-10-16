// 共享组件另一处用法: /u/fuqingxu (UserPage 项目列表) 的 compact 模式切换。
import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = 'http://127.0.0.1:45618'
const OUT = '/home/tianyi/imac-test/scratch/search-modal-controls-row'
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
await page.goto(BASE + '/u/fuqingxu', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)
if (await page.locator('#layout-mode-choice-title').count()) { await page.locator('button:has-text("常规模式")').first().click(); await page.waitForTimeout(2500) }
console.log('URL:', page.url())
const n = await page.locator('button:has-text("深度搜索")').count()
console.log('compact toggle buttons:', n)
if (n) {
  const box = await page.locator('button:has-text("深度搜索")').first().evaluate(el => { const r = el.parentElement.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), parent: el.parentElement.className } })
  console.log('compact group:', JSON.stringify(box))
  await page.screenshot({ path: `${OUT}/04-userpage-search-bar.png`, clip: { x: box.x - 320, y: box.y - 20, width: 700, height: 70 } })
  await page.locator('button:has-text("快速搜索")').first().click().catch(() => {})
  await page.waitForTimeout(800)
  console.log('after click quick, aria-pressed:', await page.locator('button:has-text("快速搜索")').first().getAttribute('aria-pressed').catch(() => 'n/a'))
  await page.screenshot({ path: `${OUT}/05-userpage-quick.png`, clip: { x: Math.max(0, box.x - 320), y: box.y - 20, width: 700, height: 70 } })
}
await browser.close()
console.log('DONE')
