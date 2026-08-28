const assert = require('assert')
const { createCodexUpdatePromptGuard } = require('../backend/agents/codex-startup-prompts')

const prompt = [
  'Update available!',
  '1. Update now',
  '2. Skip until next version',
].join('\n')

const shouldSkip = createCodexUpdatePromptGuard()
assert.strictEqual(shouldSkip('Codex is starting'), false, '普通启动画面不能触发数字按键')
assert.strictEqual(shouldSkip(prompt), true, '完整更新提示应处理一次')
assert.strictEqual(shouldSkip(prompt), false, '滚动历史残留同一提示时不得再次发送数字按键')
assert.strictEqual(shouldSkip(`${prompt}\n› normal composer`), false, '进入正常输入框后仍命中历史提示也不得重发')

const freshWindow = createCodexUpdatePromptGuard()
assert.strictEqual(freshWindow('Update available!'), false, '缺少跳过选项时不能误判更新提示')
assert.strictEqual(freshWindow('Skip until next version'), false, '缺少更新标题时不能误判更新提示')
assert.strictEqual(freshWindow(prompt), true, '每个新窗口拥有独立的一次处理机会')

console.log('codex update prompt guard: ok')
