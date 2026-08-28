import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { composeConversationPrompt } from '../src/services/conversation-prompt.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const createSource = fs.readFileSync(path.join(here, '../src/services/create-conversation.ts'), 'utf8')

test('有图片附件时拼出与会话输入框一致的附件块', () => {
  assert.equal(
    composeConversationPrompt('检查截图', [{ kind: 'image', path: '/uploads/screenshot.png' }]),
    '[附件]\n- [图片] /uploads/screenshot.png\n\n检查截图',
  )
  assert.equal(
    composeConversationPrompt('', [{ kind: 'image', path: '/uploads/only-image.webp' }]),
    '[附件]\n- [图片] /uploads/only-image.webp',
  )
  assert.equal(
    composeConversationPrompt('分析文档', [{ kind: 'file', path: '/uploads/spec.pdf' }]),
    '[附件]\n- [文件] /uploads/spec.pdf\n\n分析文档',
  )
})

test('无附件时 prompt 行为不变', () => {
  assert.equal(composeConversationPrompt('  保持原样  '), '保持原样')
  assert.equal(composeConversationPrompt('任务', [{ kind: 'image', path: '  ' }]), '任务')
})

test('createDefaultConversation 的任务、会话描述和首条消息共用拼装 prompt，标题只用用户文字', () => {
  assert.match(createSource, /const userPrompt = args\.prompt\.trim\(\)[\s\S]*const prompt = composeConversationPrompt\(userPrompt, args\.attachments\)/)
  assert.match(createSource, /const title = conciseTitle\(userPrompt\)/)
  assert.equal((createSource.match(/description: prompt/g) || []).length, 3)
  assert.match(createSource, /initial_message: \{[\s\S]*content: prompt,[\s\S]*request_id: checkpoint\.requestId/)
  assert.doesNotMatch(createSource, /\/api\/sessions\/\$\{checkpoint\.sessionId\}\/messages/, '首条消息必须由 Session 创建接口后台接管，前端不得等待单独的消息请求')
})
