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
await page.waitForTimeout(6000)
if (await page.locator('#layout-mode-choice-title').count()) {
  await page.locator('button:has-text("常规模式")').first().click()
  await page.waitForTimeout(2500)
}
console.log('top-search btn count:', await page.locator('[data-tour="top-search"]').count())
const btn = page.locator('[data-tour="top-search"]').first()
await btn.click()
await page.waitForTimeout(300)
console.log('t+300ms  modal placeholders:', await page.locator('input[placeholder*="搜索"]').count())
await page.waitForTimeout(1200)
const st = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input')].map(i => i.getAttribute('placeholder'))
  const hasRange = !!document.querySelector('select[title="时间范围"]')
  const scope = [...document.querySelectorAll('[data-search-scope]')].map(n => n.getAttribute('data-search-scope'))
  const modalRoot = !!document.querySelector('.rounded-2xl.shadow-2xl')
  const deepBtns = [...document.querySelectorAll('button')].filter(b => (b.textContent || '').trim() === '深度搜索').length
  return { inputs, hasRange, scope, modalRoot, deepBtns }
})
console.log(JSON.stringify(st, null, 1))
await page.screenshot({ path: '/home/tianyi/imac-test/scratch/search-modal-controls-row/probe2-after-click.png' })
// 再点一次
await btn.click()
await page.waitForTimeout(800)
console.log('after 2nd click modal:', await page.evaluate(() => !!document.querySelector('.rounded-2xl.shadow-2xl')))
await browser.close()
