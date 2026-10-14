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
await page.goto(BASE + '/u/fuqingxu/p/9a533442/i/7c79fc6c', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)
console.log('URL:', page.url())
await page.screenshot({ path: '/home/tianyi/imac-test/scratch/recent-row-merge/nav.png' })
console.log('session-list present:', await page.locator('#issue-sidebar-session-list').count())
console.log('texts w/ 近期会话:', await page.locator('text=近期会话').count())
await browser.close()
