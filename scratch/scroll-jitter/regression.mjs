// 回归: 命中间跳转 (上一个/下一个命中) 仍要平滑落点; 侧栏跳会话不受影响。
import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = process.env.BASE || 'http://127.0.0.1:45618'
const OUT = '/home/tianyi/imac-test/scratch/scroll-jitter'
const TAG = process.env.TAG || 'fix'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
ctx.addInitScript(() => {
  const log = []; window.__jitter = log
  window.__mark = () => { log.length = 0 }
  const t0 = performance.now()
  document.addEventListener('scroll', (e) => {
    const el = e.target === document ? document.scrollingElement : e.target
    if (!el || !el.scrollHeight) return
    if (!(el.className || '').toString().includes('overflow-y-auto')) return
    log.push({ t: Math.round(performance.now() - t0), top: Math.round(el.scrollTop) })
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
await page.locator('input[placeholder*="搜索"]').first().fill('字体'); await page.waitForTimeout(8000)
// 选一个多命中的结果 (第 3 条, 片段多)
await page.locator('[data-search-result]').nth(2).locator('[data-search-fragment]').first().click(); await page.waitForTimeout(900)
await page.locator('[data-search-view-session]').click()
const popup = await new Promise((res) => { if (opened[0]) return res(opened[0]); ctx.once('page', p => res(p)) })
await popup.waitForLoadState('domcontentloaded').catch(() => {})
await popup.waitForTimeout(1000)
if (await popup.locator('#layout-mode-choice-title').count()) { await popup.locator('button:has-text("常规模式")').first().click(); await popup.waitForTimeout(2000) }
await popup.waitForTimeout(10000)
await popup.screenshot({ path: `${OUT}/${TAG}-reg-0-landed.png` })

const state = async (label) => {
  const r = await popup.evaluate(() => {
    const hit = document.querySelector('[data-search-hit="true"]')
    const sc = [...document.querySelectorAll('div')].find(el => (el.className || '').toString().includes('overflow-y-auto overflow-x-clip'))
    if (!hit) return { found: false }
    const a = hit.getBoundingClientRect(), b = sc.getBoundingClientRect()
    return { found: true, line: hit.getAttribute('data-jsonl-line-no'), visible: a.top < b.bottom && a.bottom > b.top, center: Math.round(a.top + a.height / 2 - (b.top + b.height / 2)) }
  })
  console.log(`  ${label}: 高亮 ${r.found ? `line=${r.line} 可见=${r.visible} 距中心 ${r.center}px` : '无'}`)
}
await state('初始落点')

for (const n of [1, 2, 3]) {
  await popup.evaluate(() => window.__mark())
  const btn = popup.locator('button:has-text("下一个命中")')
  if (!(await btn.count())) { console.log('  无「下一个命中」按钮'); break }
  await btn.first().click()
  await popup.waitForTimeout(6000)
  const log = await popup.evaluate(() => window.__jitter || [])
  let back = 0, maxBack = 0, prev = null
  for (const e of log) { if (prev !== null && e.top < prev - 300) { back++; maxBack = Math.max(maxBack, prev - e.top) } prev = e.top }
  console.log(`  第 ${n} 次「下一个命中」: 滚动 ${log.length} 次, 回退抖动 ${back} 次 (最大 ${maxBack}px)`)
  console.log(`    轨迹: ${log.map(e => `${e.t}:${e.top}`).join(' ')}`)
  await state(`  跳转后`)
}
await popup.screenshot({ path: `${OUT}/${TAG}-reg-1-next-hits.png` })

// 侧栏跳会话 (无 match 参数) 不应有定位滚动
await page.bringToFront()
await popup.close()
await page.waitForTimeout(1500)
const urlBefore = page.url()
await popup.close().catch(() => {})
console.log('侧栏跳转前 URL:', urlBefore)
await browser.close()
