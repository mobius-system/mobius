// 验证「点击搜索结果 → 新标签定位」时不再抽搐。
// 指标: 定位过程中 scrollTop 的"回退抖动"(连续下降 >300px)次数 + 落点是否命中卡片并可见。
// 对前 N 条搜索结果各跑一次。
import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = process.env.BASE || 'http://127.0.0.1:45618'
const OUT = '/home/tianyi/imac-test/scratch/scroll-jitter'
const TAG = process.env.TAG || 'dev'
const QUERY = process.env.QUERY || '字体'
const N = Number(process.env.N || 3)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
ctx.addInitScript(() => {
  const log = []
  window.__jitter = log
  window.__jitterMark = () => { log.length = 0 }
  const t0 = performance.now()
  document.addEventListener('scroll', (e) => {
    const el = e.target === document ? document.scrollingElement : e.target
    if (!el || !el.scrollHeight) return
    const c = (el.className || '').toString()
    if (!c.includes('overflow-y-auto')) return
    log.push({ t: Math.round(performance.now() - t0), top: Math.round(el.scrollTop) })
  }, true)
})
const page = await ctx.newPage()
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
if (await page.locator('#layout-mode-choice-title').count()) {
  await page.locator('button:has-text("常规模式")').first().click()
  await page.waitForTimeout(2500)
}
const opened = []
ctx.on('page', p => opened.push(p))
// 结果页点击后会关闭弹窗, 每次抽查都要重新打开并重搜
const openSearch = async () => {
  await page.locator('[data-tour="top-search"]').click({ timeout: 60000 })
  await page.waitForTimeout(1200)
  await page.locator('button:has-text("深度搜索")').first().click()
  await page.waitForTimeout(400)
  await page.locator('input[placeholder*="搜索"]').first().fill(QUERY)
  await page.waitForTimeout(8000)
}
await openSearch()

const total = await page.locator('[data-search-result]').count()
console.log(`查询「${QUERY}」命中 ${total} 个会话, 抽查前 ${Math.min(N, total)} 个\n`)

for (let i = 0; i < Math.min(N, total); i++) {
  if (i > 0) await openSearch()
  const row = page.locator('[data-search-result]').nth(i)
  const label = (await row.textContent() || '').replace(/\s+/g, ' ').slice(0, 70)
  await row.locator('[data-search-fragment]').first().click()
  await page.waitForTimeout(900)
  const before = opened.length
  await page.locator('[data-search-view-session]').click()
  const popup = await new Promise((res) => {
    if (opened.length > before) return res(opened[opened.length - 1])
    ctx.once('page', p => res(p))
  })
  await popup.waitForLoadState('domcontentloaded').catch(() => {})
  await popup.waitForTimeout(1000)
  if (await popup.locator('#layout-mode-choice-title').count()) {
    await popup.locator('button:has-text("常规模式")').first().click()
    await popup.waitForTimeout(2000)
  }
  // 记录定位过程中的滚动轨迹
  await popup.waitForTimeout(9000)
  const log = await popup.evaluate(() => window.__jitter || [])
  let backward = 0, backwardMax = 0, prev = null
  for (const e of log) {
    if (prev !== null && e.top < prev - 300) { backward++; backwardMax = Math.max(backwardMax, prev - e.top) }
    prev = e.top
  }
  const land = await popup.evaluate(() => {
    const hit = document.querySelector('[data-search-hit="true"]')
    if (!hit) return { found: false }
    const scroller = [...document.querySelectorAll('div')].find(el => (el.className || '').toString().includes('overflow-y-auto overflow-x-clip'))
    const r = hit.getBoundingClientRect(), s = scroller.getBoundingClientRect()
    return {
      found: true,
      visible: r.top < s.bottom && r.bottom > s.top,
      centerOffset: Math.round(r.top + r.height / 2 - (s.top + s.height / 2)),
      hitLine: hit.getAttribute('data-jsonl-line-no'),
      hitCount: document.querySelectorAll('[data-search-hit="true"]').length,
    }
  })
  console.log(`#${i + 1} ${label}`)
  console.log(`   滚动事件 ${log.length} 次 | 回退抖动(>300px) ${backward} 次 (最大回退 ${backwardMax}px) | 单调下降段: ${log.length ? `${log[0].top}→${log[log.length - 1].top}` : 'n/a'}`)
  console.log(`   落点: 命中卡片 ${land.found ? `line=${land.hitLine} 可见=${land.visible} 距视口中心 ${land.centerOffset}px (高亮卡片数 ${land.hitCount})` : '未找到高亮卡片'}`)
  await popup.screenshot({ path: `${OUT}/${TAG}-result${i + 1}-settled.png` })
  await popup.close()
  await page.bringToFront()
  await page.waitForTimeout(800)
}
console.log('\n(截图已存 scratch/scroll-jitter/)')
await browser.close()
