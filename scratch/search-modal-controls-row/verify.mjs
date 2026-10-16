// 验证: 搜索弹窗「搜索模式」改成与「搜索范围」同款分段样式, 且模式/时间范围与范围同排。
import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = 'http://127.0.0.1:45618'
const OUT = '/home/tianyi/imac-test/scratch/search-modal-controls-row'

const browser = await chromium.launch()

async function login(ctx) {
  const page = await ctx.newPage()
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  if (await page.locator('input[type="password"]').count()) {
    await page.fill('input[placeholder="账户"]', 'fuqingxu')
    await page.fill('input[placeholder="密码"]', 'fuqingxu')
    await page.locator('button:has-text("登录"), button[type="submit"]').first().click()
    await page.waitForTimeout(4000)
  }
  return page
}

const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState: undefined })
const page = await login(ctx)
await page.goto(BASE + '/u/fuqingxu/p/9a533442/i/03120997', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(6000)
if (await page.locator('#layout-mode-choice-title').count()) {
  await page.locator('button:has-text("常规模式")').first().click()
  await page.waitForTimeout(2500)
}
await page.locator('[data-tour="top-search"]').click()
await page.waitForTimeout(1000)

// --- 几何 & 样式断言 ---
const st = await page.evaluate(() => {
  const rect = n => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const scope = document.querySelector('[data-search-scope="project"]')
  const scopeGroup = scope && scope.parentElement
  const modeBtns = [...document.querySelectorAll('button')].filter(b => ['快速搜索', '深度搜索'].includes((b.textContent || '').trim()))
  const modeGroup = modeBtns[0] && modeBtns[0].parentElement
  const sel = document.querySelector('select[title="时间范围"]')
  const input = document.querySelector('input[placeholder*="搜索"]')
  const cs = n => { if (!n) return null; const c = getComputedStyle(n); return { bg: c.backgroundColor, color: c.color, radius: c.borderRadius, fontSize: c.fontSize, padding: c.padding } }
  return {
    scopeGroup: rect(scopeGroup), modeGroup: rect(modeGroup), rangeSelect: rect(sel), inputRow: rect(input.parentElement),
    scopeGroupStyle: cs(scopeGroup), modeGroupStyle: cs(modeGroup),
    scopeActiveSegStyle: cs(scope),
    modeActiveSegStyle: cs(modeBtns.find(b => b.getAttribute('aria-pressed') === 'true')),
    modeInactiveSegStyle: cs(modeBtns.find(b => b.getAttribute('aria-pressed') === 'false')),
    labels: modeBtns.map(b => b.textContent.trim()),
    rowTops: [scopeGroup, modeGroup, sel, input && input.parentElement].map(n => n ? Math.round(n.getBoundingClientRect().y) : null),
  }
})
console.log(JSON.stringify(st, null, 1))
const [sy, my, ry, iy] = st.rowTops
console.log('CHECK same row (scope/mode/range):', sy === my && my === ry)
console.log('CHECK mode+range above input row:', ry < iy)
console.log('CHECK mode group style == scope group style:',
  st.modeGroupStyle.bg === st.scopeGroupStyle.bg && st.modeGroupStyle.radius === st.scopeGroupStyle.radius)
console.log('CHECK active seg style identical:',
  JSON.stringify(st.modeActiveSegStyle) === JSON.stringify(st.scopeActiveSegStyle))
await page.screenshot({ path: `${OUT}/01-deep-same-row.png` })

// 快速模式: 时间范围应隐藏, 模式切换仍生效
await page.locator('button:has-text("快速搜索")').first().click()
await page.waitForTimeout(800)
console.log('quick: range select =', await page.locator('select[title="时间范围"]').count(),
  '| placeholder ok =', await page.locator('input[placeholder^="快速搜索项目"]').count(),
  '| 快速搜索 aria-pressed =', await page.locator('button:has-text("快速搜索")').first().getAttribute('aria-pressed'))
await page.screenshot({ path: `${OUT}/02-quick-mode.png` })
await page.locator('button:has-text("深度搜索")').first().click()
await page.waitForTimeout(800)
console.log('back to deep: range select =', await page.locator('select[title="时间范围"]').count())
await ctx.close()

// 窄视口换行表现
const narrow = await browser.newContext({ viewport: { width: 560, height: 900 } })
const np = await login(narrow)
await np.goto(BASE + '/u/fuqingxu/p/9a533442/i/03120997', { waitUntil: 'domcontentloaded' })
await np.waitForTimeout(6000)
if (await np.locator('#layout-mode-choice-title').count()) { await np.locator('button:has-text("常规模式")').first().click(); await np.waitForTimeout(2500) }
await np.locator('[data-tour="top-search"]').click()
await np.waitForTimeout(1000)
await np.screenshot({ path: `${OUT}/03-narrow-560.png` })
const wrapped = await np.evaluate(() => {
  const b = n => { const r = n.getBoundingClientRect(); return Math.round(r.y) }
  const scope = document.querySelector('[data-search-scope="project"]')
  const mode = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '深度搜索')
  const sel = document.querySelector('select[title="时间范围"]')
  return { scopeY: scope && b(scope.parentElement), modeY: mode && b(mode.parentElement), selY: sel && b(sel) }
})
console.log('narrow rows:', JSON.stringify(wrapped))
await narrow.close()

// 共享组件另一处用法: UserPage 项目搜索框 (compact)
const ctx3 = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const p3 = await login(ctx3)
await p3.goto(BASE + '/u/fuqingxu/easy_mode?panel=', { waitUntil: 'domcontentloaded' }).catch(() => {})
await p3.waitForTimeout(6000)
if (await p3.locator('#layout-mode-choice-title').count()) { await p3.locator('button:has-text("极简模式")').first().click(); await p3.waitForTimeout(2500) }
await p3.goto(BASE + '/u/fuqingxu/p/9a533442', { waitUntil: 'domcontentloaded' })
await p3.waitForTimeout(6000)
console.log('UserPage mode buttons:', await p3.locator('button:has-text("深度搜索")').count())
await p3.screenshot({ path: `${OUT}/04-userpage-search-bar.png`, clip: { x: 0, y: 0, width: 1600, height: 420 } })
await ctx3.close()

await browser.close()
console.log('DONE')
