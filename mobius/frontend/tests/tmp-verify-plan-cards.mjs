/**
 * 临时验收脚本: 打开一条含"连发任务工具调用"的真实会话, 检查被摘走计划的卡片
 * 是折叠的精简摘要, 而不是展开的原始 JSON 字段树.
 * 用法: node tests/tmp-verify-plan-cards.mjs
 */
import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright/index.mjs'

const BASE = process.env.BASE || 'http://127.0.0.1:45618'
const SESSION_URL = `${BASE}/u/admin/p/9a533442/i/a2b72394?session=a382b3db`

// 由 tests/tmp-scan-one.mjs 从该会话 jsonl 现算得出 (task-progress 去重结果)
const STRIPPED = ['eaf92f2f-6afd-4662-b96b-e20d88ccb202', 'f8c28303-953d-49d6-9db8-37d5d2bdd81f', 'f36b2fef-c580-409c-83b7-b36509f76377', '4d7e3e6c-6ff9-4e8d-b11a-90f6ea4970c5', '4196b087-2c0e-442b-ab6e-797cb22f79db', 'f5ba08df-3dc3-4e68-88d9-7e25de2730be', '36f5daa6-977c-4780-82d3-0a63e56c98bb', '93ef1829-d7bb-4ee9-beec-f9b5015c6134', '7f9dcc0d-8f93-4ad3-8780-07911e260b2c', 'f935f94a-9f10-4e35-bd76-0c926225e2e9', '8c396f57-3e98-4689-8d7a-09a4d12c236d', '1e30c708-a4c3-4fc8-8a04-bd93114ca8ff', '47484903-0aa8-4abc-bb58-e1066fc57c3a', '831d3eb5-101d-4eb4-8d1c-941f885215a9', 'efb324b6-a23d-458f-8d37-23f87b83d7d4', 'c9a5dad4-a85b-423a-b6b3-684a945283e7', '1f3310a9-6d12-433c-864e-55ca0b04973a', '67495ea8-d305-4026-969a-972892b48600', '6b6e95c2-0b62-469f-a8af-de876a1c22ca', '87958e01-a30a-4983-8bb2-d43413e5b477', 'ca918541-7ffc-4953-abbb-8342abbf1fdf', '4ab55dd0-6b93-4471-bbd2-add25c04bb2f']
const KEPT = ['b2544f2f-38e1-4878-abd7-7754f8988d78', '38acd56c-e0e9-46c5-a049-be51abfbfea5', '9eba2144-55df-4bdb-9588-5e8920fe5fd6', '8ab396ed-04bc-48c7-bd76-30ae74a956b8', 'a86871f4-607e-4e6a-a99b-3d9724859228', '0d934052-092e-4f9f-a0b3-1ef22573ed1c', '9ebc46ba-29e8-4c94-b309-e92b25670408', '36219f3f-1cbd-4019-93b1-34c4303f7cb3', 'c1da8cea-a336-4a02-a25e-dc160f9172a0', 'eab35735-408e-47f8-9771-a8931deb272c', '8d1b5266-63c0-4160-82dc-f029ee73cb4b', '88c72314-671c-4b2c-9a72-7a05060a9716', 'f37dfb7c-393b-4dad-8253-d3e553c77839', 'a57cc6c0-ec63-4e96-b38c-d36e3459032d', '9f9affb9-060a-4628-a46f-74e703b2b02a', '45becc3d-74d0-49fd-a70d-64450ce95d72', 'a7ebb315-ebed-4deb-8a65-351bfaa481ac', '5aac0826-b351-4a05-8b2a-305efbc69bdc']

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
page.setDefaultTimeout(30000)

const { token } = await (await page.request.post(`${BASE}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).json()
await page.goto(`${BASE}/welcome`)
await page.evaluate(([t]) => { window.localStorage.setItem('cc-token', t); window.localStorage.setItem('layout_mode', 'normal_mode'); window.localStorage.removeItem('mobius:ui:session-density') }, [token])
await page.goto(SESSION_URL)
await page.waitForSelector('details.jsonl-entry-card', { timeout: 60000 })

// 逐轮展开 (只展开收着的), 把更多轮次的明细加载出来
for (let round = 0; round < 8; round++) {
  const opened = await page.evaluate(() => {
    const out = []
    for (const t of document.querySelectorAll('.round-group-trigger')) {
      const wrap = t.parentElement
      const thread = wrap?.querySelector('.jsonl-thread')
      const shown = !!(thread && thread.offsetParent !== null)
      if (!shown && !t.disabled) out.push(Array.prototype.indexOf.call(document.querySelectorAll('.round-group-trigger'), t))
    }
    return out
  })
  if (opened.length === 0) break
  const triggers = await page.$$('.round-group-trigger')
  for (const i of opened) { await triggers[i].click().catch(() => {}) }
  await page.waitForTimeout(2000)
}

const report = await page.evaluate(([stripped, kept]) => {
  // 卡片体分类: 计划卡片 (进度条 + 计划模式) / 原始 JSON 字段树 / 精简摘要文本
  function classify(el) {
    const body = el.querySelector('div.px-1.pb-1.pt-1')
    if (!el.open || !body) return 'collapsed'
    const text = body.innerText || ''
    if (/计划模式|计划已完成/.test(text) && text.includes('%')) return 'plan-card'
    if (text.includes('tool_use') || /^\s*type\s*:/m.test(text)) return 'raw-json-tree'
    return 'compact-summary'
  }
  const byId = new Map([...document.querySelectorAll('details.jsonl-entry-card[data-jsonl-entry-id]')].map((el) => [el.dataset.jsonlEntryId, el]))
  const summarize = (uuids, label) => {
    const stats = { [label]: uuids.length, rendered: 0, planCard: 0, rawJsonTree: 0, compactSummary: 0, collapsed: 0, sample: [] }
    for (const id of uuids) {
      const el = byId.get(id)
      if (!el) continue
      stats.rendered += 1
      const kind = classify(el)
      if (kind === 'plan-card') stats.planCard += 1
      else if (kind === 'raw-json-tree') { stats.rawJsonTree += 1; if (stats.sample.length < 3) stats.sample.push((el.querySelector('summary')?.innerText || '').replace(/\s+/g, ' ').slice(0, 90)) }
      else if (kind === 'compact-summary') stats.compactSummary += 1
      else stats.collapsed += 1
    }
    return stats
  }
  return { stripped: summarize(stripped, 'stripped'), kept: summarize(kept, 'kept') }
}, [STRIPPED, KEPT])

console.log(JSON.stringify(report, null, 1))

const census = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('details.jsonl-entry-card')]
  let taskTool = 0, taskToolOpen = 0, planCard = 0, rawJson = 0, compactOpen = 0
  const openTask = []
  for (const el of cards) {
    const summary = (el.querySelector('summary')?.innerText || '').replace(/\s+/g, ' ')
    const body = el.querySelector('div.px-1.pb-1.pt-1')
    const text = el.open && body ? (body.innerText || '') : ''
    if (/计划模式|计划已完成/.test(text) && text.includes('%')) planCard += 1
    if (text.includes('tool_use') || /^\s*type\s*:/m.test(text)) rawJson += 1
    if (/TaskCreate|TaskUpdate/.test(summary)) {
      taskTool += 1
      if (el.open) { taskToolOpen += 1; if (openTask.length < 5) openTask.push(summary.slice(0, 100)) }
    } else if (el.open && text) compactOpen += 1
  }
  return { cards: cards.length, taskTool, taskToolOpen, planCard, rawJson, compactOpen, openTask }
})
console.log('CENSUS', JSON.stringify(census, null, 1))
const probe = await page.evaluate(([ids]) => {
  const out = []
  for (const id of ids.slice(0, 4)) {
    const el = document.querySelector(`details.jsonl-entry-card[data-jsonl-entry-id="${id}"]`)
    if (!el) { out.push({ id, missing: true }); continue }
    const chain = []
    let n = el
    while (n && n !== document.body) { chain.push(n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ').slice(0, 2).join('.') : '') + '[open=' + (n.open === undefined ? '-' : n.open) + ']'); n = n.parentElement }
    out.push({ id, open: el.open, visible: el.checkVisibility ? el.checkVisibility() : null, textContent: (el.querySelector('summary')?.textContent || '').replace(/\s+/g, ' ').slice(0, 120), innerText: (el.querySelector('summary')?.innerText || '').replace(/\s+/g, ' ').slice(0, 60), chain: chain.slice(0, 12) })
  }
  return out
}, [STRIPPED])
console.log('PROBE', JSON.stringify(probe, null, 1))

await browser.close()
