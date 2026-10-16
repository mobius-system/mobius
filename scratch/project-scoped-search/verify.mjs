// 验证「在项目内搜索」: 项目内页打开顶栏搜索弹窗 → 默认限定当前项目 → 切换范围 pill。
import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = 'http://127.0.0.1:45618'
const OUT = '/home/tianyi/imac-test/scratch/project-scoped-search'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
page.on('console', m => { const t = m.text(); if (t.includes('search') || m.type() === 'error') console.log('CONSOLE:', m.type(), t.slice(0, 200)) })

// 登录
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[placeholder="账户"]', 'fuqingxu')
  await page.fill('input[placeholder="密码"]', 'fuqingxu')
  await page.locator('button:has-text("登录"), button[type="submit"]').first().click()
  await page.waitForTimeout(4000)
}

// 进入项目内 issue 页 (元素1 截图所在路由: 项目 13cb82f2)
await page.goto(BASE + '/u/fuqingxu/p/13cb82f2/i/5e43e317', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5000)
// 登录后可能弹「选择你的使用模式」遮罩, 先选常规模式才会渲染顶栏
if (await page.locator('#layout-mode-choice-title').count()) {
  await page.locator('button:has-text("常规模式")').first().click()
  await page.waitForTimeout(2500)
}
console.log('URL:', page.url())

// 打开顶栏搜索弹窗
await page.locator('[data-tour="top-search"]').click()
await page.waitForTimeout(800)
console.log('modal open:', await page.locator('input[placeholder="深度搜索所有会话内容…"]').count())

// 断言: 范围 pill 出现且默认选中「当前项目」
const scopeProject = page.locator('[data-search-scope="project"]')
const scopeAll = page.locator('[data-search-scope="all"]')
console.log('scope pills:', await scopeProject.count(), await scopeAll.count())
console.log('project pill text:', (await scopeProject.textContent())?.trim())
console.log('project pill pressed:', await scopeProject.getAttribute('aria-pressed'))
await page.screenshot({ path: `${OUT}/01-modal-default-scoped.png` })

// 输入关键词, 观察请求是否带 project_id
let scopedUrl = '', globalUrl = ''
page.on('request', r => { const u = r.url(); if (u.includes('/api/search?') || u.includes('/hierarchy-search')) { if (u.includes('project_id')) scopedUrl = u; else globalUrl = u } })
await page.fill('input[placeholder="深度搜索所有会话内容…"]', 'queue')
await page.waitForTimeout(2500)
console.log('scoped request url:', scopedUrl)
console.log('global request url:', globalUrl)
await page.screenshot({ path: `${OUT}/02-scoped-results.png` })
const hitProjects = await page.locator('[data-search-result] .truncate.max-w-\\[160px\\]').allTextContents()
console.log('hit project names:', [...new Set(hitProjects)].slice(0, 10))

// 切换到全部项目
await scopeAll.click()
await page.waitForTimeout(2500)
console.log('after switch, project pill pressed:', await scopeProject.getAttribute('aria-pressed'))
await page.screenshot({ path: `${OUT}/03-global-results.png` })
const hitProjects2 = await page.locator('[data-search-result] .truncate.max-w-\\[160px\\]').allTextContents()
console.log('global hit project names:', [...new Set(hitProjects2)].slice(0, 10))

// 切回项目内
await scopeProject.click()
await page.waitForTimeout(2000)
await page.screenshot({ path: `${OUT}/04-back-to-scoped.png` })

// 快速模式也应带 project_id
await page.locator('button[aria-label="搜索模式：深度搜索"]').click().catch(() => {})
await page.waitForTimeout(500)
let quickUrl = ''
page.on('request', r => { const u = r.url(); if (u.includes('/hierarchy-search') && u.includes('project_id')) quickUrl = u })
await page.waitForTimeout(2000)
console.log('quick scoped url:', quickUrl)
await page.screenshot({ path: `${OUT}/05-quick-mode.png` })

await browser.close()
console.log('DONE')
