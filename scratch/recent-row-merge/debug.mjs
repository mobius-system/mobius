import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = 'http://127.0.0.1:45618'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
page.on('console', m => console.log('CONSOLE:', m.type(), m.text().slice(0,200)))
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
console.log('URL:', page.url())
console.log('inputs:', await page.locator('input').count())
for (const el of await page.locator('input').all()) console.log('  in:', await el.getAttribute('placeholder'), await el.getAttribute('name'), await el.getAttribute('type'))
await page.screenshot({ path: '/home/tianyi/imac-test/scratch/recent-row-merge/step1.png', fullPage: false })
await browser.close()
