/**
 * 临时验收脚本 (直播路径): 打开正在运行的会话页面, 轮询抓取任务工具卡的实时状态 —
 * 卡片挂载时若有计划应是计划卡, 计划被后一张卡摘走时应折叠回落, 而不是铺原始 JSON.
 * 用法: BASE=http://127.0.0.1:45616 OUT=/tmp/live-probe.log node tests/tmp-live-probe.mjs
 */
import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright/index.mjs'
import fs from 'node:fs'

const BASE = process.env.BASE || 'http://127.0.0.1:45616'
const OUT = process.env.OUT || '/tmp/live-probe.log'
const SESSION = process.env.SESSION || '66fc5bc6'
const PROJECT = process.env.PROJECT || '9a533442'
const ISSUE = process.env.ISSUE || '25eb1b82'
const SECONDS = Number(process.env.SECONDS || 120)

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
page.setDefaultTimeout(30000)

const { token } = await (await page.request.post(`${BASE}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).json()
await page.goto(`${BASE}/welcome`)
await page.evaluate(([t]) => { window.localStorage.setItem('cc-token', t); window.localStorage.setItem('layout_mode', 'normal_mode'); window.localStorage.removeItem('mobius:ui:session-density') }, [token])
await page.goto(`${BASE}/u/admin/p/${PROJECT}/i/${ISSUE}?session=${SESSION}`)
await page.waitForSelector('details.jsonl-entry-card', { timeout: 60000 })

const seen = new Map()
const deadline = Date.now() + SECONDS * 1000
while (Date.now() < deadline) {
  const snap = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('details.jsonl-entry-card')) {
      const summary = (el.querySelector('summary')?.textContent || '').replace(/\s+/g, ' ')
      if (!/TaskCreate|TaskUpdate/.test(summary) && !el.querySelector('[aria-label="计划模式"]')) continue
      const body = el.querySelector('div.px-1.pb-1.pt-1')
      const bodyText = body ? (body.textContent || '').replace(/\s+/g, ' ') : ''
      const kind = !el.open ? 'closed'
        : /计划模式|计划已完成/.test(bodyText) && bodyText.includes('%') ? 'plan'
        : /"tool_use"|type:/.test(bodyText) ? 'raw-json-tree'
        : 'compact-summary'
      out.push({ id: el.dataset.jsonlEntryId, open: el.open, kind, head: summary.slice(0, 70) })
    }
    return out
  })
  for (const card of snap) {
    const prev = seen.get(card.id) || []
    const last = prev[prev.length - 1]
    if (!last || last.open !== card.open || last.kind !== card.kind) {
      prev.push({ t: new Date().toISOString().slice(11, 19), ...card })
      seen.set(card.id, prev)
    }
  }
  await page.waitForTimeout(1000)
}

const lines = []
for (const [id, states] of seen) {
  lines.push(`# ${id}`)
  for (const s of states) lines.push(`  ${s.t}  open=${s.open}  ${s.kind}  | ${s.head}`)
}
fs.writeFileSync(OUT, lines.join('\n') + '\n')
console.log(lines.join('\n'))
await browser.close()
