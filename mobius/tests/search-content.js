const assert = require('assert')

const {
  is_mobius_attached_content,
  is_mobius_attached_content_zh,
  is_mobius_attached_content_en,
} = require('../backend/services/search-content')

function indexOf(text, value) {
  const index = text.indexOf(value)
  assert.ok(index >= 0, `fixture is missing ${value}`)
  return index
}

function main() {
  const zh = '【以下信息描述了你正在协助的用户】\n项目名: target-keyword\n\n## 用户的问题\n请处理 target-keyword'
  assert.strictEqual(is_mobius_attached_content_zh(zh, indexOf(zh, 'target-keyword'), 'target-keyword'.length), true)
  assert.strictEqual(is_mobius_attached_content_zh(zh, zh.lastIndexOf('target-keyword'), 'target-keyword'.length), false)
  assert.strictEqual(is_mobius_attached_content(zh, indexOf(zh, 'target-keyword'), 'target-keyword'.length), true)

  const zhBracketQuestion = '以下信息描述了你正在协助的用户\nsecret-key\n【用户的问题】\nreal question'
  assert.strictEqual(is_mobius_attached_content_zh(zhBracketQuestion, indexOf(zhBracketQuestion, 'secret-key'), 10), true)
  assert.strictEqual(is_mobius_attached_content_zh(zhBracketQuestion, indexOf(zhBracketQuestion, 'real question'), 12), false)

  const en = "The following describes the user you are assisting, and the Project, Issue/Research, and Session this work belongs to.\n\nProject: target-keyword\n\n## User's Question\nPlease inspect target-keyword"
  assert.strictEqual(is_mobius_attached_content_en(en, indexOf(en, 'target-keyword'), 'target-keyword'.length), true)
  assert.strictEqual(is_mobius_attached_content_en(en, en.lastIndexOf('target-keyword'), 'target-keyword'.length), false)
  assert.strictEqual(is_mobius_attached_content_zh(en, indexOf(en, 'target-keyword'), 'target-keyword'.length), false)

  console.log('search-content: ok')
}

main()
