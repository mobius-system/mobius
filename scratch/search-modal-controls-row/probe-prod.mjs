import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = 'http://127.0.0.1:45616'
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[placeholder="账户"]', 'fuqingxu')
  await page.fill('input[placeholder="密码"]', 'fuqingxu')
  await page.locator('button:has-text("登录"), button[type="submit"]').first().click()
  await page.waitForTimeout(5000)
}
await page.goto(BASE + '/u/fuqingxu/p/9a533442/i/03120997', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)
if (await page.locator('#layout-mode-choice-title').count()) { await page.locator('button:has-text("常规模式")').first().click(); await page.waitForTimeout(2500) }
await page.locator('[data-tour="top-search"]').click()
await page.waitForTimeout(1000)
const st = await page.evaluate(() => {
  const c = n => { const s = getComputedStyle(n); return { fontSize: s.fontSize, cls: n.className } }
  const sw = document.querySelector('[role="switch"]')
  const sel = document.querySelector('select[title="时间范围"]')
  const aa = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === 'Aa')
  const input = document.querySelector('input[placeholder*="搜索"]')
  return { switchEl: sw ? c(sw) : 'none', select: sel ? c(sel) : 'none', aa: aa ? c(aa) : 'none', input: input ? c(input) : 'none',
    rootVar: getComputedStyle(document.documentElement).getPropertyValue('--fs-sm') }
})
console.log('PROD 45616:', JSON.stringify(st, null, 1))
await browser.close()
