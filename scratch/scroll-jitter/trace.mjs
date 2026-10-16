// 打印单个结果的完整滚动轨迹 (定位是否单调 + 何时回退)
import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = process.env.BASE || 'http://127.0.0.1:45618'
const QUERY = process.env.QUERY || '字体'
const IDX = Number(process.env.IDX || 2)
const OUT = '/home/tianyi/imac-test/scratch/scroll-jitter'
const TAG = process.env.TAG || 'dev'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
ctx.addInitScript(() => {
  const log = []; window.__jitter = log; const t0 = performance.now()
  document.addEventListener('scroll', (e) => {
    const el = e.target === document ? document.scrollingElement : e.target
    if (!el || !el.scrollHeight) return
    if (!(el.className || '').toString().includes('overflow-y-auto')) return
    log.push({ t: Math.round(performance.now() - t0), top: Math.round(el.scrollTop), h: Math.round(el.scrollHeight) })
  }, true)
})
const page = await ctx.newPage()
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000)
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[placeholder="账户"]', 'fuqingxu'); await page.fill('input[placeholder="密码"]', 'fuqingxu')
  await page.locator('button:has-text("登录"), button[type="submit"]').first().click(); await page.waitForTimeout(5000)
}
await page.goto(BASE + '/u/fuqingxu/p/9a533442/i/03120997', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000)
if (await page.locator('#layout-mode-choice-title').count()) { await page.locator('button:has-text("常规模式")').first().click(); await page.waitForTimeout(2500) }
const opened = []; ctx.on('page', p => opened.push(p))
await page.locator('[data-tour="top-search"]').click({ timeout: 60000 }); await page.waitForTimeout(1200)
await page.locator('button:has-text("深度搜索")').first().click(); await page.waitForTimeout(400)
await page.locator('input[placeholder*="搜索"]').first().fill(QUERY); await page.waitForTimeout(8000)
await page.locator('[data-search-result]').nth(IDX).locator('[data-search-fragment]').first().click(); await page.waitForTimeout(900)
await page.locator('[data-search-view-session]').click()
const popup = await new Promise((res) => { if (opened[0]) return res(opened[0]); ctx.once('page', p => res(p)) })
await popup.waitForLoadState('domcontentloaded').catch(() => {})
await popup.waitForTimeout(1000)
if (await popup.locator('#layout-mode-choice-title').count()) { await popup.locator('button:has-text("常规模式")').first().click(); await popup.waitForTimeout(2000) }
// 定位刚开始就抓一次中途截图
await popup.waitForTimeout(400)
await popup.screenshot({ path: `${OUT}/${TAG}-idx${IDX}-mid-nav.png` })
await popup.waitForTimeout(12000)
const log = await popup.evaluate(() => window.__jitter || [])
console.log(`轨迹 ${log.length} 个采样:`)
console.log(log.map(e => `${e.t}:${e.top}(h${e.h})`).join('  '))
await popup.screenshot({ path: `${OUT}/${TAG}-idx${IDX}-settled.png` })
await browser.close()
