/**
 * agent-jsonl-path.test — the backend transcript lookup must survive the
 * public/private method rename.
 *
 * Regression guard: the lookup used to be a private `_resolveJsonlPath`, and
 * six call sites duck-typed that exact name. When the backend was split, the
 * method disappeared from the class and every caller silently resolved null,
 * which blanked the chat history. These cases pin both the public method on
 * the class and the two-name fallback in the shared helper.
 */
const assert = require('assert')

const tempRoot = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mobius-agent-jsonl-'))
process.env.DB_PATH = require('path').join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.on('exit', () => { try { require('fs').rmSync(tempRoot, { recursive: true, force: true }) } catch {} })

const { agentJsonlPathOf } = require('../backend/services/agent-jsonl-path')
const { TmuxClaudeCodeBackend } = require('../backend/agents/tmux-claude-code')

// 公开方法优先: 后端拆分后新增的名字
// The public name wins; it is the one introduced by the backend split
assert.strictEqual(agentJsonlPathOf({ resolveJsonlPath: () => '/a/primary.jsonl' }, 's1'), '/a/primary.jsonl')

// 旧名兜底: deepseek-harness 等后端仍用私有名
// The old private name still works for backends not yet renamed
assert.strictEqual(agentJsonlPathOf({ _resolveJsonlPath: () => '/a/legacy.jsonl' }, 's1'), '/a/legacy.jsonl')

// 两个都有时公开名优先
// When both exist the public one wins
assert.strictEqual(
  agentJsonlPathOf({ resolveJsonlPath: () => '/a/new.jsonl', _resolveJsonlPath: () => '/a/old.jsonl' }, 's1'),
  '/a/new.jsonl',
)

// 未实现 / 空后端 / 空返回 一律 null, 调用方按"路径未绑定"处理
// Unimplemented backends and empty answers resolve to null
assert.strictEqual(agentJsonlPathOf({}, 's1'), null)
assert.strictEqual(agentJsonlPathOf(null, 's1'), null)
assert.strictEqual(agentJsonlPathOf({ resolveJsonlPath: () => null }, 's1'), null)

// 类上必须真的暴露公开方法 (拆分时最容易漏的一步)
// The class itself must expose the public method; this is the step that was missed
assert.strictEqual(typeof TmuxClaudeCodeBackend.prototype.resolveJsonlPath, 'function')

console.log('agent jsonl path: ok')
process.exit(0)
