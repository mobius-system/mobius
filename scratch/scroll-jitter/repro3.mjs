// 抓「谁在反复滚动」: patch scrollTo / scrollIntoView / scrollTop setter, 记录调用栈。
import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = process.env.BASE || 'http://127.0.0.1:45618'
const QUERY = process.env.QUERY || '字体'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
ctx.addInitScript(() => {
  const log = []
  window.__jitterLog = log
  const t0 = performance.now()
  const who = (el) => {
    if (!el) return 'null'
    if (el === window) return 'window'
    if (el === document.scrollingElement) return 'document'
    const c = (el.className || '').toString().split(' ').slice(0, 3).join('.')
    return `${el.tagName.toLowerCase()}.${c}`
  }
  const stack = () => (new Error().stack || '').split('\n').slice(2, 6).map(s => s.trim().replace(/^at\s+/, '').replace(/https?:\/\/[^ )]*\//g, '')).join(' <- ')
  const origScrollTo = Element.prototype.scrollTo
  Element.prototype.scrollTo = function (...args) {
    const a = args[0]
    const top = (a && typeof a === 'object') ? a.top : args[1]
    log.push({ t: Math.round(performance.now() - t0), api: 'scrollTo', who: who(this), top: Math.round(top ?? -1), stack: stack() })
    return origScrollTo.apply(this, args)
  }
  const origSIV = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (...args) {
    log.push({ t: Math.round(performance.now() - t0), api: 'scrollIntoView', who: who(this), arg: JSON.stringify(args[0] || null), stack: stack() })
    return origSIV.apply(this, args)
  }
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  Object.defineProperty(Element.prototype, 'scrollTop', {
    get() { return desc.get.call(this) },
    set(v) {
      log.push({ t: Math.round(performance.now() - t0), api: 'setScrollTop', who: who(this), top: Math.round(v), stack: stack() })
      return desc.set.call(this, v)
    },
    configurable: true,
  })
  window.__jitterState = () => {
    const scrollers = [...document.querySelectorAll('*')].filter(el => {
      const s = getComputedStyle(el)
      return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 8
    })
    return scrollers.map(el => ({ who: who(el), top: Math.round(el.scrollTop), h: Math.round(el.scrollHeight), ch: Math.round(el.clientHeight) }))
  }
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
const popup = await new Promise((res) => { if (opened[0]) return res(opened[0]); ctx.once('page', p => res(p)) })
await popup.waitForTimeout(15000)
const log = await popup.evaluate(() => window.__jitterLog || [])
console.log('调用总数:', log.length)
for (const e of log.slice(0, 40)) console.log(`${e.t}ms ${e.api} ${e.who} top=${e.top ?? e.arg}\n    ${e.stack}`)
console.log('--- 按 (api+who) 统计 ---')
const cnt = new Map()
for (const e of log) { const k = `${e.api} ${e.who}`; cnt.set(k, (cnt.get(k) || 0) + 1) }
for (const [k, v] of [...cnt].sort((a, b) => b[1] - a[1])) console.log(`  ${v}  ${k}`)
console.log('--- 末态 ---', JSON.stringify(await popup.evaluate(() => window.__jitterState())))
await browser.close()
