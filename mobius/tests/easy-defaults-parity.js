/**
 * easy-defaults-parity.js — 简易模式兜底容器名 前端/TUI 双份常量一致性验证.
 *
 * TUI 是独立 npm 包, 不能 import 前端源码, tui/src/easy-mode-defaults.ts 是
 * frontend/src/services/easy-mode-defaults.ts 的手工镜像 (header 注释要求 keep in
 * sync)。两侧名字一旦漂移, 同一个兜底容器会被建成两份 (快捷任务 vs 旧名各一个),
 * 所以这里直接 require 两侧源文件, 对真正共享的常量逐一断言相等。
 *
 * 运行: node --require tsx/cjs tests/easy-defaults-parity.js
 */
const frontend = require('../frontend/src/services/easy-mode-defaults')
const tui = require('../tui/src/easy-mode-defaults')

const pairs = [
  ['EASY_DEFAULT_PROJECT_NAME', frontend.EASY_DEFAULT_PROJECT_NAME, tui.EASY_DEFAULT_PROJECT_NAME],
  ['EASY_DEFAULT_ISSUE_TITLE', frontend.EASY_DEFAULT_ISSUE_TITLE, tui.EASY_DEFAULT_ISSUE_TITLE],
]

let failed = false
for (const [name, webValue, tuiValue] of pairs) {
  if (webValue !== tuiValue) {
    failed = true
    console.error(`[MISMATCH] ${name}: frontend=${JSON.stringify(webValue)} tui=${JSON.stringify(tuiValue)}`)
  }
}

// 名字同时是新建项目的目录名, 追加约束: 不带空格和斜杠 (与 frontend 侧注释约定一致).
for (const [name, , tuiValue] of pairs.slice(0, 1)) {
  if (/[\s/]/.test(String(tuiValue))) {
    failed = true
    console.error(`[INVALID] ${name} 含空格或斜杠, 不能作为目录名: ${JSON.stringify(tuiValue)}`)
  }
}

if (failed) {
  console.error('easy-mode defaults 漂移: 请同时修改 frontend/src/services/easy-mode-defaults.ts 与 tui/src/easy-mode-defaults.ts')
  process.exit(1)
}
console.log(`easy-defaults-parity: ${pairs.length} constants in sync (frontend === tui)`)
