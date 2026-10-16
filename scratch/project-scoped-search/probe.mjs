import { chromium } from '/home/tianyi/imac-test/mobius/frontend/node_modules/playwright-core/index.mjs'
const browser = await chromium.launch()
const page = await (await browser.newContext()).newPage()
page.on('console', m => console.log('CONSOLE:', m.type(), m.text().slice(0, 150)))
const resp = await page.goto('http://127.0.0.1:45618/', { waitUntil: 'domcontentloaded', timeout: 15000 })
// dev 进程带了 VITE_HMR_PROTOCOL=wss / CLIENT_PORT=443 (给 cloud 域名反代用的),
// 本机 127 直连没有 https 服务 → HMR ws 必失败。HTTP 页面本身可用, 只是断线重连噪音。
// 验证 HMR 是否吃到新代码: 直接拿源码模块确认。
console.log('status:', resp.status())
await page.waitForTimeout(2000)
console.log('title:', await page.title())
await page.screenshot({ path: '/home/tianyi/imac-test/scratch/project-scoped-search/00-landing.png' })
await browser.close()
