import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const shellSource = fs.readFileSync(path.join(here, '../src/components/shell.tsx'), 'utf8')

const classIndex = shellSource.indexOf('className="mobius-topnav-userlink')
const buttonStart = shellSource.lastIndexOf('<LinklessRouteButton', classIndex)
const buttonEnd = shellSource.indexOf('>', classIndex)

assert(classIndex >= 0 && buttonStart >= 0 && buttonEnd >= 0, '顶栏用户名按钮必须由 shell.tsx 的 mobius-topnav-userlink 渲染')

const buttonMarkup = shellSource.slice(buttonStart, buttonEnd + 1)
const userHomeTarget = buttonMarkup.match(/to=\{(userParam\s*\?\s*`\/u\/\$\{userParam\}`\s*:\s*'\/')\}/)
assert(userHomeTarget, '顶栏用户名按钮必须声明主页导航目标')
assert.equal(
  userHomeTarget[1].replace(/\s+/g, ''),
  "userParam?`/u/${userParam}`:'/'",
  '顶栏用户名按钮必须导航到当前用户主页，并在用户参数缺失时回退根路径',
)

assert.match(buttonMarkup, /aria-label="回到主页"/, '顶栏用户名按钮必须提供回到主页的可访问名称')
assert.match(buttonMarkup, /title="回到主页"/, '顶栏用户名按钮必须提供回到主页的悬浮提示')

console.log('user home link contract test passed')
