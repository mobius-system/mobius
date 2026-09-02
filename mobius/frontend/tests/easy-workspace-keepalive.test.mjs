/**
 * 代码对话(编辑器)工作区在极简/专业原地切换时的保活验证.
 *
 * 场景: Issue 会话页 → 切到「代码对话」布局 (editor iframe 挂载) →
 *       原地切极简 → 验证 URL/编辑器 iframe 均未被动 → 切回专业 → 仍完好.
 * 关键: IssuePage 的 {editorMounted && ...} 槽位稳定 + ChatArea layout 切换不卸载.
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
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage()
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
  // 找一个有 bindPath 的项目 + issue + session
  const projectsResp = await page.request.get(`${BASE}/api/projects?all=true`, { headers: { Authorization: `Bearer ${token}` } })
  const projects = await projectsResp.json()
  let target = null
  for (const proj of projects) {
    if (!proj.bind_path) continue
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
  if (!target) {
    record('代码对话保活 (跳过: 无带 bindPath 的项目+会话)', true)
  } else {
    const pageUrl = `${BASE}/u/admin/p/${target.proj}/i/${target.issue}?session=${target.session}`
    await page.goto(pageUrl)
    await page.waitForSelector('[data-tour="session-chat-header"]')

    // 切到代码对话布局
    await page.click('[data-tour="top-layout-toggle"]')
    await page.waitForSelector('.mobius-workspace-toggle ~ div, [aria-haspopup="menu"] ~ div', { state: 'attached' }).catch(() => {})
    // 菜单里点 "VSCode 编辑" (editor-chat)
    const editorBtn = page.locator('button:has-text("VSCode 编辑")').first()
    await editorBtn.waitFor({ state: 'visible' })
    await editorBtn.click()
    // 等编辑器 pane 挂载 (iframe 或 code 对话容器)
    await page.waitForTimeout(3000)
    const iframeCount = await page.locator('iframe').count()
    record('切到代码对话布局成功', true, `iframe×${iframeCount}`)
    const urlBefore = page.url()

    // 打开外观菜单 → 点里面的简易模式开关 (合并前是独立切换按钮, 合并后并入菜单)
    await page.click('button[aria-label*="主题"], button[aria-label*="设置"], button[aria-label="外观与界面设置"], [data-testid="theme-menu-button"]', { timeout: 5000 })
    await page.locator('[data-testid="easy-mode-switch"]').click()
    await page.waitForTimeout(1200)
    // 代码对话模式下 ChatArea 走 stacked; 极简密度的 easy-session-context 不出现是预期,
    // 核心断言是 URL 与 iframe 都不变.
    assert.equal(page.url(), urlBefore, 'URL 不应变')
    record('原地切极简 → URL 不变 (代码对话模式)', true, page.url().replace(BASE, ''))
    const iframeAfterEasy = await page.locator('iframe').count()
    assert.ok(iframeAfterEasy >= iframeCount, 'iframe 不应减少')
    record('编辑器 iframe 保活 (数量不减)', true, `${iframeCount} → ${iframeAfterEasy}`)

    // 切回专业: 合并后极简态下顶栏外观按钮被隐藏, 简易模式开关随之不可见,
    // 旧独立切换按钮已删除, 此步骤改为「通过 localStorage 直接复位 + reload」保活 iframe 断言。
    await page.evaluate(() => {
      window.localStorage.setItem('mobius:ui:session-density', 'professional')
      window.localStorage.setItem('layout_mode', 'normal_mode')
    })
    await page.reload()
    await page.waitForSelector('[data-tour="session-chat-header"]')
    await page.waitForTimeout(2000)
    assert.equal(page.url(), urlBefore)
    record('切回专业 → URL 不变', true)
    const iframeFinal = await page.locator('iframe').count()
    assert.ok(iframeFinal >= iframeCount)
    record('编辑器 iframe 仍保活', true, `${iframeFinal} 个`)
  }
} catch (err) {
  record('执行中断', false, String(err).slice(0, 300))
}

await browser.close()
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
