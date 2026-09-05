/**
 * initial-card-themes.js — 初始卡片明暗双主题截图。
 * 运行: node tests/initial-card-themes.js
 */
const { chromium } = require('/home/tianyi/imac-test/mobius/frontend/node_modules/playwright')

const BASE = 'http://localhost:45616'
const URL = `${BASE}/u/fuqingxu/p/9a533442/i/25eb1b82?session=c1524307`

;(async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'fuqingxu', password: 'fuqingxu' }),
  }).then((r) => r.json())
  const browser = await chromium.launch()
  for (const mode of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } })
    await page.goto(`${BASE}/login?_cb=${Date.now()}`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(({ t, m }) => {
      localStorage.setItem('cc-token', t)
      localStorage.setItem('layout_mode', 'normal_mode')
      if (m === 'light') document.documentElement.classList.add('light')
    }, { t: login.token, m: mode })
    await page.goto(`${URL}&_cb=${Date.now()}`, { waitUntil: 'domcontentloaded' })
    if (mode === 'light') await page.evaluate(() => document.documentElement.classList.add('light'))
    await page.waitForSelector('.jsonl-entry-card', { timeout: 30000 })
    await page.waitForTimeout(1500)
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('加载全部'))
      if (btn) btn.click()
    })
    await page.waitForTimeout(6000)
    const info = await page.evaluate(() => {
      const card = [...document.querySelectorAll('.jsonl-entry-card')].find(
        (c) => (c.querySelector('summary span.font-mono.font-semibold') || {}).textContent === '初始',
      )
      if (!card) return { found: false }
      const badge = card.querySelector('summary span.font-mono.font-semibold')
      const questionLabel = card.querySelector('.jsonl-initial-card > div > div > span')
      return {
        found: true,
        summary: (card.querySelector('summary')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        badgeColor: badge ? getComputedStyle(badge).color : null,
        questionLabelColor: questionLabel ? getComputedStyle(questionLabel).color : null,
        blockRowCount: card.querySelectorAll('details details').length,
        isLight: document.documentElement.classList.contains('light'),
      }
    })
    await page.evaluate(() => {
      const card = [...document.querySelectorAll('.jsonl-entry-card')].find(
        (c) => (c.querySelector('summary span.font-mono.font-semibold') || {}).textContent === '初始',
      )
      if (card) {
        card.scrollIntoView({ block: 'start' })
        const rows = [...card.querySelectorAll('details details summary')]
        if (rows[2]) rows[2].click()
      }
    })
    await page.waitForTimeout(1800)
    const shot = `/home/tianyi/imac-test/.imac/tmp/initial-card-${mode}.png`
    await page.screenshot({ path: shot })
    console.log(mode, JSON.stringify(info))
    await page.close()
  }
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
