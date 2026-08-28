import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSource = relativePath => fs.readFileSync(path.join(here, '..', relativePath), 'utf8')
const createSource = readSource('src/services/create-conversation.ts')
const sessionRouteSource = fs.readFileSync(path.join(here, '../../backend/routes/sessions.ts'), 'utf8')

assert.match(
  createSource,
  /initial_message: \{[\s\S]*content: prompt,[\s\S]*request_id: checkpoint\.requestId/,
  '首页创建 Session 时必须把首条消息交给后端一并接收',
)
assert.doesNotMatch(
  createSource,
  /await api\(`\/api\/sessions\/\$\{checkpoint\.sessionId\}\/messages`/,
  '首页导航不得等待 Agent 启动请求返回',
)
assert.match(
  sessionRouteSource,
  /safeWriteRunningFlag\(initialFlagRoot,[\s\S]*initialMessageAccepted = true;[\s\S]*void runSessionMessage\([\s\S]*source: 'http\.session\.create_initial_message'[\s\S]*\.catch\(\(e\) =>/,
  '后端必须预写运行标记并以 fire-and-forget 方式启动首条消息',
)
assert.match(
  sessionRouteSource,
  /initial message background start failed[\s\S]*safeRemoveRunningFlag\(initialFlagRoot,[\s\S]*safeWriteFailedFlag\(initialFlagRoot/,
  '后台启动失败必须清理运行标记并留下失败状态',
)
assert.match(
  sessionRouteSource,
  /initial_message_accepted: initialMessageAccepted/,
  'Session 创建响应必须声明首条消息已由后台接管',
)

console.log('home background start contract test passed')
