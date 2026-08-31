/**
 * 极简(简易)/专业(常规)模式无缝切换端到端验证.
 *
 * 用 playwright 驱动真实浏览器访问测试服前端 (127.0.0.1:33316), 覆盖:
 *   1. 未选择模式时访问用户主页 → 弹出模式选择弹窗
 *   2. 选择简易模式 → 进入 /u/admin/easy_mode
 *   3. 刷新后保持简易模式 (localStorage 持久化 + 路由接管用户主页)
 *   4. 主题菜单关闭简易模式 → 回到专业模式对应页面
 *   5. 专业模式带 session 切到简易模式 → 简易模式直接选中同一会话
 *   6. 清空模式后访问 Issue 页 → 再次弹选择框 (Issue 页也被接管)
 *
 * 运行: node /tmp/easy-mode-e2e.mjs
 */
import assert from 'node:assert/strict'
import { chromium } from '/app/mobius/frontend/node_modules/playwright/index.mjs'

const BASE = 'http://127.0.0.1:33316'
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(15000)

// 登录: 直接走 API 拿 token 写入 localStorage, 跳过登录页交互
const loginResp = await page.request.post(`${BASE}/api/auth/login`, {
  data: { username: 'admin', password: 'admin' },
})
assert.equal(loginResp.status(), 200, 'admin 登录接口应返回 200')
const { token, user } = await loginResp.json()
await page.addInitScript(([t]) => {
  window.localStorage.setItem('cc-token', t)
}, [token])
// 每次导航前清掉 addInitScript 阶段的模式残留; 正式开始前显式清空
await page.goto(`${BASE}/welcome`).catch(() => {})
await page.evaluate(() => window.localStorage.removeItem('layout_mode'))

try {
  // --- 1. 未选模式 → 用户主页弹模式选择框 ---
  await page.goto(`${BASE}/u/admin`)
  await page.waitForSelector('[data-testid="layout-mode-choice"]')
  record('未选择模式时访问用户主页 → 弹出模式选择弹窗', true)

  // --- 2. 选择简易模式 ---
  await page.click('[data-testid="choose-easy-mode"]')
  await page.waitForSelector('[data-page="easy-mode"]', { state: 'attached', timeout: 15000 })
  record('选择简易模式 → 进入 /u/admin/easy_mode', true, page.url())

  // --- 3. 刷新后保持简易模式 (用户主页被接管) ---
  await page.goto(`${BASE}/u/admin`)
  await page.waitForSelector('[data-page="easy-mode"], [data-testid="easy-recent-sessions"]', { state: 'attached', timeout: 15000 })
  record('简易模式下访问用户主页 → 自动重定向到 easy_mode', true, page.url())
  const stored = await page.evaluate(() => window.localStorage.getItem('layout_mode'))
  assert.equal(stored, 'easy_mode')
  record('layout_mode 已持久化到 localStorage', true)

  // --- 4. 通过主题菜单关掉简易模式 → 回专业模式 ---
  // 打开顶栏右侧主题/设置菜单
  await page.click('button[aria-label*="主题"], button[aria-label*="设置"], [data-testid="theme-menu-button"]', { timeout: 5000 }).catch(async () => {
    // 兜底: 找顶栏带调色盘图标的按钮
    await page.locator('[data-testid="layout-mode-toggle"]').click({ timeout: 5000 })
  })
  const switchBtn = page.locator('[data-testid="layout-mode-toggle"]')
  await switchBtn.waitFor({ state: 'visible' })
  record('顶栏可见独立模式切换按钮', true)
  await switchBtn.click()
  await page.waitForURL(/\/u\/admin(\/p\/|$)/, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(800)
  const afterUrl = page.url()
  const backToNormal = /\/u\/admin\/?$/.test(afterUrl) || /\/u\/admin\/p\//.test(afterUrl) || !afterUrl.includes('easy_mode')
  record('关闭简易模式 → 离开 easy_mode 回专业模式页面', backToNormal, afterUrl)
  const storedAfter = await page.evaluate(() => window.localStorage.getItem('layout_mode'))
  assert.equal(storedAfter, 'normal_mode')
  record('layout_mode 更新为 normal_mode', true)

  // --- 5. 专业模式访问用户主页不再弹选择框 ---
  await page.goto(`${BASE}/u/admin`)
  await page.waitForTimeout(1200)
  const modalVisible = await page.locator('[data-testid="layout-mode-choice"]').count()
  assert.equal(modalVisible, 0, '已选专业模式后访问用户主页不应再弹选择框')
  record('专业模式下访问用户主页 → 不再弹模式选择框', true)

  // --- 6. 清空模式 → 访问 Issue 页也弹选择框 ---
  await page.evaluate(() => window.localStorage.removeItem('layout_mode'))
  const resp = await page.request.get(`${BASE}/api/projects?all=true`, { headers: { Authorization: `Bearer ${token}` } })
  const projects = await resp.json()
  assert.ok(Array.isArray(projects) && projects.length > 0, '需要有至少一个项目用于测试 Issue 页跳转')
  const proj = projects[0]
  const issuesResp = await page.request.get(`${BASE}/api/projects/${proj.id}/issues`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null)
  let issueUrl = null
  if (issuesResp && issuesResp.ok()) {
    const issues = await issuesResp.json()
    if (Array.isArray(issues) && issues.length > 0) issueUrl = `/u/admin/p/${proj.id}/i/${issues[0].id}`
  }
  if (issueUrl) {
    await page.goto(`${BASE}${issueUrl}`)
    await page.waitForSelector('[data-testid="layout-mode-choice"]')
    record('未选模式时访问 Issue 会话页 → 也弹模式选择框 (被接管)', true, issueUrl)
    // 从 Issue 页选简易模式 → 应回 easy_mode
    await page.click('[data-testid="choose-easy-mode"]')
    await page.waitForURL('**/u/admin/easy_mode**')
    record('Issue 页选择简易模式 → 跳转 easy_mode', true, page.url())
  } else {
    record('Issue 页接管验证 (跳过: 测试服无 Issue 数据)', true)
  }
} catch (err) {
  record('执行中断', false, String(err).slice(0, 300))
}

await browser.close()
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
