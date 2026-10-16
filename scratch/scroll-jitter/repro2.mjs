// 从第 0 帧开始记录所有 scroll 事件, 定位「点击搜索结果后页面无限滚动抽搐」。
import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = process.env.BASE || 'http://127.0.0.1:45618'
const QUERY = process.env.QUERY || '字体'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
ctx.addInitScript(() => {
  const log = []
  window.__scrollLog = log
  const t0 = performance.now()
  const tag = (el) => {
    if (el === document || el === document.scrollingElement) return 'document'
    const c = (el.className || '').toString().split(' ').slice(0, 3).join('.')
    return `${el.tagName.toLowerCase()}.${c}`
  }
  document.addEventListener('scroll', (e) => {
    const el = e.target
    const node = el === document ? document.scrollingElement : el
    log.push({ t: Math.round(performance.now() - t0), kind: 'scroll', who: tag(el), top: Math.round(node.scrollTop), h: Math.round(node.scrollHeight) })
  }, true)
  const mo = new MutationObserver(() => { log.push({ t: Math.round(performance.now() - t0), kind: 'mut' }) })
  addEventListener('DOMContentLoaded', () => {
    mo.observe(document.body, { childList: true, subtree: true, characterData: true })
  })
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
await page.locator('[data-tour="top-search"]').click({ timeout: 60000 })
await page.waitForTimeout(1200)
await page.locator('button:has-text("深度搜索")').first().click()
await page.waitForTimeout(400)
await page.locator('input[placeholder*="搜索"]').first().fill(QUERY)
await page.waitForTimeout(7000)
await page.locator('[data-search-fragment]').first().click()
await page.waitForTimeout(1000)
await page.locator('[data-search-view-session]').click()

const popup = await new Promise((res) => {
  if (opened[0]) return res(opened[0])
  ctx.once('page', p => res(p))
})
console.log('popup:', popup.url())
await popup.waitForTimeout(20000)
const log = await popup.evaluate(() => window.__scrollLog || [])
console.log('事件总数:', log.length)
const scrolls = log.filter(e => e.kind === 'scroll')
console.log('scroll 事件数:', scrolls.length, '| mutation 数:', log.length - scrolls.length)
// 按目标聚合
const byWho = new Map()
for (const s of scrolls) {
  if (!byWho.has(s.who)) byWho.set(s.who, [])
  byWho.get(s.who).push(s)
}
for (const [who, arr] of byWho) {
  const tops = arr.map(a => a.top)
  const hs = [...new Set(arr.map(a => a.h))]
  const span = Math.max(...tops) - Math.min(...tops)
  console.log(`  ${who}: ${arr.length} 次 scroll, scrollTop 区间 ${Math.min(...tops)}~${Math.max(...tops)} (振幅 ${span}), 首末 t=${arr[0].t}~${arr[arr.length - 1].t}ms, scrollHeight 取值 ${hs.slice(0, 8).join(',')}${hs.length > 8 ? `…(${hs.length}种)` : ''}`)
  if (span > 50 && arr.length > 4) {
    console.log('    前 20 次:', arr.slice(0, 20).map(a => `${a.t}:${a.top}`).join(' '))
    console.log('    末 10 次:', arr.slice(-10).map(a => `${a.t}:${a.top}`).join(' '))
  }
}
// 事件时间轴 (前 60 条)
console.log('--- 时间轴(前 60) ---')
console.log(log.slice(0, 60).map(e => e.kind === 'mut' ? `${e.t}:mut` : `${e.t}:scroll[${e.who.slice(0, 20)}]=${e.top}`).join('\n'))
await popup.screenshot({ path: '/home/tianyi/imac-test/scratch/scroll-jitter/10-popup-final.png' })
let popup2 = null
await browser.close()
