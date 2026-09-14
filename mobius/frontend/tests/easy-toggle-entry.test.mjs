/**
 * 顶栏在简易/普通模式下保持一致的验证.
 *
 * 合并改动 (2026-09-02):
 *   - 顶栏独立切换按钮 [data-testid="layout-mode-toggle"] 已删除;
 *   - 切换入口改为外观菜单内的简易模式开关 [data-testid="easy-mode-switch"]。
 *   - 顶栏独立帮助按钮 [data-tour="top-guide-help"] 已删除, 入口并入用户菜单「帮助与引导」。
 *
 * 断言:
 *   普通态: 顶栏外观按钮可见, 打开菜单 → 内含简易模式开关。
 *   点开关 → 会话内原地变为简易呈现，但顶栏的完整操作集不变。
 *   简易态仍可从同一「外观」菜单切回普通呈现，URL 和会话保活。
 */
import assert from 'node:assert/strict'
import { chromium } from '/app/mobius/frontend/node_modules/playwright/index.mjs'

const BASE = 'http://127.0.0.1:33316'
const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.setDefaultTimeout(20000)

const loginResp = await page.request.post(`${BASE}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })
const { token } = await loginResp.json()
await page.goto(`${BASE}/welcome`)
await page.evaluate(([t]) => {
  window.localStorage.setItem('cc-token', t)
  window.localStorage.setItem('layout_mode', 'normal_mode')
  window.localStorage.removeItem('mobius:ui:session-density')
}, [token])

try {
  const projectsResp = await page.request.get(`${BASE}/api/projects?all=true`, { headers: { Authorization: `Bearer ${token}` } })
  const projects = await projectsResp.json()
  let target = null
  for (const proj of projects) {
    const r = await page.request.get(`${BASE}/api/projects/${proj.id}/issues`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null)
    if (!r || !r.ok()) continue
    const issues = await r.json()
    if (!Array.isArray(issues) || !issues.length) continue
    const ir = await page.request.get(`${BASE}/api/issues/${issues[0].id}/sessions`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null)
    if (!ir || !ir.ok()) continue
    const sessions = await ir.json()
    if (Array.isArray(sessions) && sessions.length > 0) {
      target = { proj: proj.id, issue: issues[0].id, session: sessions[0].session_id }
      break
    }
  }
  assert.ok(target, '需要有会话的 Issue')

  const pageUrl = `${BASE}/u/admin/p/${target.proj}/i/${target.issue}?session=${target.session}`
  await page.goto(pageUrl)
  await page.waitForSelector('[data-tour="session-chat-header"]')

  // 专家态: 旧独立切换按钮已删除, 不应再出现
  const oldToggleCount = await page.locator('[data-testid="layout-mode-toggle"]').count()
  assert.equal(oldToggleCount, 0, '合并后顶栏独立切换按钮应已删除')
  record('专家态: 顶栏独立切换按钮已移除', true)

  // 专家态: 外观菜单内可见简易模式开关
  await page.click('button[aria-label*="主题"], button[aria-label*="设置"], button[aria-label="外观与界面设置"], [data-testid="theme-menu-button"]', { timeout: 5000 })
  const switchEl = page.locator('[data-testid="easy-mode-switch"]')
  await switchEl.waitFor({ state: 'visible' })
  record('专家态: 外观菜单内可见简易模式开关', true)
  const switchText = await switchEl.innerText()
  assert.match(switchText, /简易模式/, `菜单项应显示「简易模式」, 实际: ${switchText}`)
  record('菜单项显示「简易模式」', true, switchText.replace(/\n/g, ' '))

  // 关闭外观菜单, 验证专家态其它顶栏项齐全
  await page.keyboard.press('Escape')
  const hasAppearance = await page.locator('[data-tour="top-theme-toggle"]').isVisible()
  const hasUserMenu = await page.locator('[data-tour="top-user-menu"]').isVisible()
  const hasGithub = await page.locator('.mobius-topnav-github').count()
  record('专家态: 外观/用户菜单/GitHub 齐全', hasAppearance && hasUserMenu && hasGithub > 0)

  // 帮助入口已并入用户菜单: 顶栏无独立按钮, 菜单内有「帮助与引导」项
  const topGuideGone = (await page.locator('.mobius-topnav-actions > [data-tour="top-guide-help"]').count()) === 0
  record('专家态: 顶栏独立帮助按钮已移除', topGuideGone)
  await page.click('[data-tour="top-user-menu"] button[aria-haspopup="menu"]')
  const guideItem = page.locator('[data-tour="top-user-menu"] > div button', { hasText: '帮助与引导' })
  await guideItem.waitFor({ state: 'visible' })
  record('专家态: 用户菜单内含「帮助与引导」菜单项', true)
  await page.keyboard.press('Escape')
  await page.click('body', { position: { x: 5, y: 400 } })
  await page.waitForTimeout(300)

  // 打开外观菜单 → 点简易模式开关 → 原地切极简
  const urlBefore = page.url()
  await page.click('button[aria-label*="主题"], button[aria-label*="设置"], button[aria-label="外观与界面设置"], [data-testid="theme-menu-button"]', { timeout: 5000 })
  await page.locator('[data-testid="easy-mode-switch"]').click()
  await page.waitForSelector('[data-testid="easy-session-context"]', { state: 'attached' })
  assert.equal(page.url(), urlBefore, 'URL 不变')
  record('点击菜单内开关 → 原地切极简, URL 不变', true)

  // 简易态的顶栏与普通态保持同一操作集。
  const searchKept = await page.locator('[data-tour="top-search"]').isVisible()
  const appearanceKept = await page.locator('[data-tour="top-theme-toggle"]').isVisible()
  const userMenuKept = await page.locator('[data-tour="top-user-menu"]').isVisible()
  const githubKept = await page.locator('.mobius-topnav-github').isVisible()
  const createKept = await page.locator('[data-tour="top-create"]').isVisible()
  const overviewKept = await page.locator('[data-tour="top-overview-cluster"]').isVisible()
  record('简易态: 搜索保留', searchKept)
  record('简易态: 外观/用户菜单/GitHub 保留', appearanceKept && userMenuKept && githubKept)
  record('简易态: 新建/系统可视化保留', createKept && overviewKept)
  assert.equal(await page.locator('[data-testid="easy-admin-entry"]').count(), 0, '不再渲染简易模式专用管理入口')
  record('简易态: 不再渲染专用顶栏入口', true)

  // 从同一外观菜单切回普通呈现，不重载会话。
  await page.click('[data-tour="top-theme-toggle"] > button')
  await page.locator('[data-testid="easy-mode-switch"]').click()
  await page.waitForSelector('[data-tour="session-chat-header"]', { state: 'attached' })
  assert.equal(page.url(), urlBefore)
  record('菜单开关 → 原地切回普通呈现, URL 不变', true)
  const allBack = await page.locator('[data-tour="top-theme-toggle"]').isVisible()
    && await page.locator('[data-tour="top-user-menu"]').isVisible()
  record('普通态顶栏仍完整', allBack)
} catch (err) {
  record('执行中断', false, String(err).slice(0, 300))
}

await browser.close()
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
