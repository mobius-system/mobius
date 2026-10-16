// 验证「近期会话中点研究智能体 → 新开浏览器窗口; 任务会话仍原地跳转」。
// 桌面端 (Electron) 分支无法在浏览器里跑, 只能靠源码分支确认 (见报告)。
import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const BASE = 'http://127.0.0.1:45618'
const OUT = '/home/tianyi/imac-test/scratch/recent-research-newtab'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 200)) })
const opened = []
ctx.on('page', p => { opened.push(p); console.log('POPUP OPENED:', p.url()) })

// 登录
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[placeholder="账户"]', 'fuqingxu')
  await page.fill('input[placeholder="密码"]', 'fuqingxu')
  await page.locator('button:has-text("登录"), button[type="submit"]').first().click()
  await page.waitForTimeout(4000)
}

// 元素1 所在路由: 项目 13cb82f2 / issue 5e43e317 (页面标题 pawbench - ECONML)
await page.goto(BASE + '/u/fuqingxu/p/13cb82f2/i/5e43e317', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5000)
if (await page.locator('#layout-mode-choice-title').count()) {
  await page.locator('button:has-text("常规模式")').first().click()
  await page.waitForTimeout(2500)
}
console.log('URL:', page.url())

// 侧栏切到「近期会话」
await page.locator('[data-testid="issue-session-scope-switcher"] button:has-text("近期会话")').click()
await page.waitForTimeout(3000)
const tree = page.locator('[data-testid="issue-recent-session-tree"]')
console.log('tree visible:', await tree.count())
const groupInfo = await page.locator('[data-testid="issue-recent-session-group"]').evaluateAll(gs => gs.map(g => ({
  scope: g.getAttribute('data-scope-type'),
  text: (g.querySelector('button')?.textContent || '').slice(0, 60),
})))
console.log('groups:', JSON.stringify(groupInfo, null, 1))
await page.screenshot({ path: `${OUT}/01-recent-tree.png` })

// —— 研究组 (data-scope-type=research) 里的智能体行 ——
const researchGroup = page.locator('[data-testid="issue-recent-session-group"][data-scope-type="research"]').first()
console.log('research group found:', await researchGroup.count())
const researchRow = researchGroup.locator('button[data-session-id]').first()
const researchSessionId = await researchRow.getAttribute('data-session-id')
const researchUrlBefore = page.url()
await researchRow.scrollIntoViewIfNeeded()
await researchRow.hover()
await page.screenshot({ path: `${OUT}/02-research-row-hover.png` })
await researchRow.click()
await page.waitForTimeout(3000)
console.log('research session clicked:', researchSessionId)
console.log('main page url after research click:', page.url(), '| unchanged:', page.url() === researchUrlBefore)
console.log('popup count:', opened.length)
const popupUrl = opened[0] ? opened[0].url() : ''
console.log('popup url:', popupUrl)
console.log('popup has /r/ route:', /\/r\//.test(popupUrl), '| same session:', popupUrl.includes(String(researchSessionId)))
if (opened[0]) {
  await opened[0].waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForTimeout(3000)
  await opened[0].screenshot({ path: `${OUT}/03-popup-research-session.png` }).catch(e => console.log('popup shot failed', e.message))
  await opened[0].close()
}

// —— 任务组 (data-scope-type=issue) 里的会话行: 应仍原地跳转, 不开新窗口 ——
const issueGroup = page.locator('[data-testid="issue-recent-session-group"][data-scope-type="issue"]').first()
console.log('issue group found:', await issueGroup.count())
const openedBefore = opened.length
const issueRow = issueGroup.locator('button[data-session-id]').first()
const issueTarget = await issueRow.getAttribute('data-session-id')
await issueRow.scrollIntoViewIfNeeded()
await issueRow.click()
await page.waitForTimeout(3500)
console.log('issue session clicked:', issueTarget)
console.log('new popups during issue click:', opened.length - openedBefore)
console.log('main page url after issue click:', page.url())
await page.screenshot({ path: `${OUT}/04-issue-row-inplace.png` })

await browser.close()
console.log('DONE')
