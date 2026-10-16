// 复现「点击搜索结果后页面无限滚动抽搐」。
// 流程: 登录 -> 常规模式 -> 顶部搜索 -> 深度搜索 -> 点结果 -> 在会话中查看 (新标签) -> 监听滚动抖动。
import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = process.env.BASE || 'http://127.0.0.1:45618'
const OUT = '/home/tianyi/imac-test/scratch/scroll-jitter'
const QUERY = process.env.QUERY || '字体'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 160)) })

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

await page.locator('[data-tour="top-search"]').click({ timeout: 60000 })
await page.waitForTimeout(1200)
await page.locator('button:has-text("深度搜索")').first().click()
await page.waitForTimeout(400)
await page.locator('input[placeholder*="搜索"]').first().fill(QUERY)
await page.waitForTimeout(7000)
await page.screenshot({ path: `${OUT}/01-results.png` })

const nResults = await page.locator('[data-search-result]').count()
console.log('结果会话数:', nResults)
if (nResults === 0) { console.log('无结果, 换关键词'); await browser.close(); process.exit(1) }

// 点第一条结果的第一个片段 → 片段预览浮层
await page.locator('[data-search-fragment]').first().click()
await page.waitForTimeout(1200)
await page.screenshot({ path: `${OUT}/02-fragment-preview.png` })

await page.locator('[data-search-view-session]').click()
await page.waitForTimeout(6000)

const popup = opened[0]
if (!popup) { console.log('没有新标签打开'); await browser.close(); process.exit(1) }
console.log('新标签 URL:', popup.url())
await popup.waitForLoadState('domcontentloaded').catch(() => {})
await popup.waitForTimeout(6000)
if (await popup.locator('#layout-mode-choice-title').count()) {
  await popup.locator('button:has-text("常规模式")').first().click()
  await popup.waitForTimeout(2500)
}
await popup.waitForTimeout(4000)
await popup.screenshot({ path: `${OUT}/03-popup.png` })

// 采样滚动位置: 找出所有可滚动容器 + 窗口, 每 100ms 记录一次
const samples = await popup.evaluate(async () => {
  const scrollers = []
  const push = (el, name) => scrollers.push({ el, name })
  push(document.scrollingElement, 'document')
  document.querySelectorAll('*').forEach((el, i) => {
    const s = getComputedStyle(el)
    if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 8) {
      push(el, `${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 40)}#${i}`)
    }
  })
  const out = []
  for (let t = 0; t < 80; t++) {
    out.push({
      t,
      vals: scrollers.map(s => ({ name: s.name, top: Math.round(s.el.scrollTop), h: Math.round(s.el.scrollHeight) })),
    })
    await new Promise(r => setTimeout(r, 100))
  }
  return { count: scrollers.length, out }
})
console.log('可滚动容器数:', samples.count)
// 统计每个容器 scrollTop 变化次数
const stats = new Map()
for (const s of samples.out) {
  for (const v of s.vals) {
    if (!stats.has(v.name)) stats.set(v.name, { changes: 0, prev: v.top, samples: [], hSet: new Set() })
    const st = stats.get(v.name)
    if (st.prev !== v.top) { st.changes++; st.prev = v.top }
    st.hSet.add(v.h)
  }
}
for (const [name, st] of stats) console.log(`  ${name}\n    变化 ${st.changes} 次 / 8s, scrollHeight 取值 ${[...st.hSet].join(',')}`)
await popup.screenshot({ path: `${OUT}/04-popup-after-sample.png` })
await browser.close()
