/**
 * initial-card-visual.js — Playwright 视检: 本会话首卡应渲染为「初始卡片」。
 * 运行: node tests/initial-card-visual.js
 */
const { chromium } = require('/home/tianyi/imac-test/mobius/frontend/node_modules/playwright')

const BASE = 'http://localhost:45616'
const SESSION_URL = `${BASE}/u/fuqingxu/p/9a533442/i/25eb1b82?session=c1524307`

;(async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fuqingxu', password: 'fuqingxu' }),
  }).then((r) => r.json())
  const token = login.token || login.data?.token || login.access_token
  if (!token) { console.error('login failed:', JSON.stringify(login).slice(0, 300)); process.exit(1) }

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } })
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate((t) => localStorage.setItem('cc-token', t), token)
  await page.goto(SESSION_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.jsonl-entry-card', { timeout: 30000 })
  // 等初始卡 (orange 主题徽章「初始」) 出现
  await page.waitForSelector('text=注入上下文', { timeout: 15000 }).catch(() => {})

  const result = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.jsonl-entry-card')]
    const initialCards = cards.filter((c) => {
      const badge = c.querySelector('summary span.font-mono.font-semibold')
      return badge && badge.textContent.trim() === '初始'
    })
    const first = initialCards[0]
    if (!first) return { found: false, totalCards: cards.length }
    const summaryText = first.querySelector('summary')?.textContent || ''
    const questionHeading = !!first.textContent.includes('用户的问题')
    const blocks = [...first.querySelectorAll('details summary')].map((s) => s.textContent.trim().slice(0, 40))
    return {
      found: true,
      totalCards: cards.length,
      summaryText: summaryText.replace(/\s+/g, ' ').trim().slice(0, 160),
      questionHeading,
      blockRows: blocks.slice(0, 12),
    }
  })

  console.log(JSON.stringify(result, null, 2))

  // 展开一个上下文块 (memory) 看分块正文渲染
  const first = await page.$('text=注入上下文')
  if (first) {
    await page.evaluate(() => {
      const card = [...document.querySelectorAll('.jsonl-entry-card')].find((c) => c.textContent.includes('注入上下文'))
      const row = card && [...card.querySelectorAll('details details summary')][0]
      if (row) row.click()
    })
    await page.waitForTimeout(1200)
  }
  await page.screenshot({ path: '/home/tianyi/imac-test/.imac/tmp/initial-card-check.png', fullPage: false })
  await browser.close()

  if (!result.found) { console.error('初始卡片未找到'); process.exit(1) }
  if (!result.questionHeading) { console.error('初始卡片缺少「用户的问题」区'); process.exit(1) }
  console.log('visual check passed, screenshot: /home/tianyi/imac-test/.imac/tmp/initial-card-check.png')
})().catch((e) => { console.error(e); process.exit(1) })
