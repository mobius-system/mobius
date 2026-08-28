import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const chatSource = readFileSync(new URL('../src/components/chat.tsx', import.meta.url), 'utf8')
const shellSource = readFileSync(new URL('../src/components/workbench-shell.tsx', import.meta.url), 'utf8')

test('已有会话顶栏保留内容搜索入口', () => {
  assert.match(chatSource, /data-testid="session-header-search"[\s\S]*mobius:open-search/)
  assert.match(shellSource, /addEventListener\('mobius:open-search',[\s\S]*<SearchModal/)
})

test('已有会话顶栏保留简易和常规模式切换', () => {
  assert.match(chatSource, /data-testid="session-header-layout-mode"[\s\S]*<LayoutModeSwitch \/>/)
})
