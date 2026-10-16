// 录制「点击搜索结果 → 新标签定位」过程的视频, 用于出 GIF 对照 (修前/修后)。
import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = process.env.BASE || 'http://127.0.0.1:45618'
const TAG = process.env.TAG || 'before'
const QUERY = process.env.QUERY || '字体'
const IDX = Number(process.env.IDX || 2)
const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 820 },
  recordVideo: { dir: `/home/tianyi/imac-test/scratch/scroll-jitter/video-${TAG}`, size: { width: 1280, height: 820 } },
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
if (await popup.locator('#layout-mode-choice-title').count()) { await popup.locator('button:has-text("常规模式")').first().click(); await popup.waitForTimeout(1500) }
await popup.waitForTimeout(12000)
const v = popup.video()
await popup.close()
if (v) { const path = await v.path(); console.log('VIDEO:', path); await ctx.close(); await browser.close(); console.log('SAVED', path) }
else { await browser.close(); console.log('no video') }
