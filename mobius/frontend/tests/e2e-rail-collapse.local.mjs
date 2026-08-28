// One-off e2e: conversation rail project folder collapse toggle works even when
// the folder contains the active session (regression: toggleFolder used to no-op
// for folders holding the active session or any running session).
import { chromium } from 'playwright'
const BASE = 'http://127.0.0.1:45616'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const loginRes = await page.request.post(`${BASE}/api/auth/login`, { data: { username: 'admin' } })
const { token } = await loginRes.json()
await page.goto(BASE)
await page.evaluate(t => {
  localStorage.setItem('cc-token', t)
  localStorage.setItem('layout_mode', 'normal_mode')
  localStorage.removeItem('mobius:ui:conversation-rail:collapsed')
}, token)

// Navigate into a session inside the biggest project so the rail folder both
// contains the active session and is the focused folder — the exact case that
// used to be un-toggleable.
const recent = await page.evaluate(async t => {
  const res = await fetch('/api/tasks/recent?limit=100', { headers: { Authorization: `Bearer ${t}` } })
  return res.json()
}, token)
const target = recent.find(it => it.project_name && it.project_name.includes('self-develop') && it.session_id)
if (!target) { console.error('FAIL: no self-develop session found'); process.exit(1) }
await page.goto(`${BASE}/u/admin/p/any/i/any?session=${target.session_id}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.conversation-rail section button[aria-controls]', { timeout: 15000 })

const folderBtn = page.locator('.conversation-rail section button[aria-controls]', { hasText: 'self-develop' }).first()
await folderBtn.waitFor({ timeout: 10000 })
const panelId = await folderBtn.getAttribute('aria-controls')
const panel = page.locator(`#${panelId}`)
const expandedBefore = await folderBtn.getAttribute('aria-expanded')
console.log('before click: aria-expanded =', expandedBefore)

await folderBtn.click()
await page.waitForTimeout(300)
const expandedAfter1 = await folderBtn.getAttribute('aria-expanded')
const panelVisibleAfter1 = await panel.count() > 0 ? await panel.isVisible() : false
console.log('after click 1: aria-expanded =', expandedAfter1, '| panel visible =', panelVisibleAfter1)
if (expandedAfter1 === expandedBefore) {
  console.error('FAIL: folder did not toggle (aria-expanded unchanged)')
  await browser.close()
  process.exit(1)
}
if (expandedAfter1 === 'true' && panelVisibleAfter1 === false) {
  console.error('FAIL: expanded but panel not visible')
  await browser.close()
  process.exit(1)
}

await folderBtn.click()
await page.waitForTimeout(300)
const expandedAfter2 = await folderBtn.getAttribute('aria-expanded')
console.log('after click 2 (toggle back): aria-expanded =', expandedAfter2)
if (expandedAfter2 !== expandedBefore) {
  console.error('FAIL: folder did not toggle back')
  await browser.close()
  process.exit(1)
}

// persisted?
const stored = await page.evaluate(() => localStorage.getItem('mobius:ui:conversation-rail:collapsed'))
console.log('persisted collapse state:', stored)

console.log('PASS: folder collapse toggles even with active session inside')
await browser.close()
