import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = process.env.BASE || 'http://127.0.0.1:45618'
const OUT = process.env.OUT || '/home/tianyi/imac-test/scratch/recent-row-merge/dev.png'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[placeholder="账户"]', 'fuqingxu')
  await page.fill('input[placeholder="密码"]', 'fuqingxu')
  await page.locator('button:has-text("登录"), button[type="submit"]').first().click()
  await page.waitForTimeout(4000)
}
// pick 常规模式 if the chooser shows
const std = page.locator('text=常规模式').first()
if (await std.count()) { await std.click(); await page.waitForTimeout(2500) }
await page.goto(BASE + '/u/fuqingxu/p/9a533442/i/7c79fc6c', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)
const std2 = page.locator('text=常规模式').first()
if (await std2.count()) { await std2.click(); await page.waitForTimeout(3000) }
console.log('URL:', page.url())
const tab = page.locator('button:has-text("近期会话")').first()
if (await tab.count()) { await tab.click(); await page.waitForTimeout(3000) } else { console.log('NO TAB; 会话 tabs:', await page.locator('button:has-text("会话")').count()) }
const list = page.locator('#issue-sidebar-session-list')
await list.waitFor({ state: 'visible', timeout: 20000 })
await page.waitForTimeout(1500)
await list.screenshot({ path: OUT })
console.log('PILL:', await page.locator('#issue-sidebar-session-list button[data-session-id] span.rounded-full').first().textContent().catch(()=>'ERR'))
console.log('ROWS:', await page.locator('#issue-sidebar-session-list button[data-session-id]').count())
await browser.close()
