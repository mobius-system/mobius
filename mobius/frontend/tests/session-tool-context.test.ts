import assert from 'node:assert/strict'

import {
  isAbsoluteToolPath,
  safeToolDirectoryLabel,
  safeToolPathLabel,
  sanitizeToolError,
  sessionToolOriginLabel,
} from '../src/components/session-tool-context.ts'
import { targetFromTrustedPath } from '../src/components/code-artifacts/file-target.ts'

assert.equal(safeToolPathLabel('src/components/chat.tsx'), 'src/components/chat.tsx')
assert.equal(safeToolPathLabel('/Users/alice/private/repo/src/secret.ts'), 'secret.ts')
assert.equal(safeToolPathLabel('C:\\Users\\alice\\repo\\secret.ts'), 'secret.ts')
assert.equal(safeToolPathLabel('../outside/secret.ts'), 'secret.ts')
assert.equal(isAbsoluteToolPath('//server/share/private.ts'), true)

const relativeTarget = targetFromTrustedPath('src/components/chat.tsx')
const absoluteTarget = targetFromTrustedPath('/Users/alice/repo/src/chat.tsx')
assert.equal(safeToolDirectoryLabel(relativeTarget), 'src/components')
assert.equal(safeToolDirectoryLabel(absoluteTarget), '')

assert.equal(
  sanitizeToolError('无法读取 /Users/alice/private/repo/secret.ts', '读取失败'),
  '无法读取 受限路径',
)
assert.equal(
  sanitizeToolError('failed C:\\Users\\alice\\repo\\secret.ts', '读取失败'),
  'failed 受限路径',
)
assert.equal(
  sanitizeToolError("ENOENT: no such file or directory, stat '/Users/alice/local_data/workspace/admin/note.md'", '读取失败'),
  '当前工作区已找不到这个文件，可能已被删除或路径已变化',
)
assert.equal(
  sanitizeToolError('git failed on local_data/workspace/admin/note.md', '读取失败'),
  'git failed on local_data/workspace/admin/note.md',
)
assert.equal(sessionToolOriginLabel('issue', '修复登录'), 'Issue · 修复登录')
assert.equal(sessionToolOriginLabel('research', '性能研究'), 'Research · 性能研究')
assert.equal(sessionToolOriginLabel('message'), '来源消息')

console.log('session tool context tests passed')
