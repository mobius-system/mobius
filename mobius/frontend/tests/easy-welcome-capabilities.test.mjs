/**
 * 欢迎页的能力清单 (issue 2026-10-28) 的契约测试.
 *
 * 背景: 欢迎页只摆得出「项目 + 模型」, 任务下拉被撤了, 运行中枢压根没有, 记忆和技能
 * 还是个没字的光图标 —— 用户不知道这套系统能干什么, 也不知道自己在建一个什么样的会话.
 * 执行页 (会话内) 有完整的四项能力, 两边不一致.
 *
 * 锁住欢迎页必须把五项能力都摆出来, 且都能选:
 *   项目 / 任务(Issue) / skill&Memory / 运行中枢 / 模型选型
 *
 * 运行: node tests/easy-welcome-capabilities.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSource = relativePath => fs.readFileSync(path.join(here, '..', relativePath), 'utf8')

const barSource = readSource('src/components/easy-session-config-bar.tsx')
const pillSource = readSource('src/components/easy-session-device-pill.tsx')
const pageSource = readSource('src/pages/EasyModePage.tsx')
const inputSource = readSource('src/components/easy-session-chat-input.tsx')
const createSource = readSource('src/components/global-create.tsx')

// ===== 1. 五项能力都要在欢迎页露出来 =====

// ① 项目: 输入框下方的 EasySessionProjectSelector
assert.match(
  pageSource,
  /<EasySessionProjectSelector/,
  '欢迎页要有项目选择',
)
// ② 任务 (Issue): 下拉回来了, 且没项目时置灰并说明原因
assert.match(
  barSource,
  /<DropdownSelect[\s\S]*?options=\{taskOptions\}/,
  '欢迎页要有任务下拉 (Issue)',
)
assert.match(
  barSource,
  /disabled=\{taskOptions\.length === 0\}/,
  '没有可选任务时下拉要置灰 (而不是消失)',
)
assert.match(
  barSource,
  /先选项目, 这里会列出它的任务/,
  '置灰时要说清楚为什么',
)
// ③ skill & Memory: 不能是光图标, 得看得见是什么
assert.match(
  barSource,
  /<SkillMemoryPicker/,
  '欢迎页要有 skill & memory 选择',
)
assert.doesNotMatch(
  barSource,
  /iconOnlyTrigger/,
  'skill & memory 不能只留一个没字的光图标',
)
// ④ 运行中枢: 带文字的胶囊 (欢迎页是能力清单, 文字要说清楚这是啥)
assert.match(
  barSource,
  /<EasySessionDevicePill[\s\S]*?variant="chip"/,
  '欢迎页要有运行中枢选择, 且用带文字的形态',
)
assert.match(
  pillSource,
  /variant\?: 'icon' \| 'chip'/,
  '运行中枢控件要支持两种形态 (执行页图标 / 欢迎页文字)',
)
assert.match(
  pillSource,
  /运行中枢 /,
  '胶囊形态要写出「运行中枢」这几个字',
)
// ⑤ 模型选型: 欢迎页输入框右下角的模型 pill (与执行页同款)
assert.match(
  inputSource,
  /props\.mode === 'create_session_mode' && props\.welcomeModelKey !== undefined[\s\S]*?<EasySessionModelPill/,
  '欢迎页要有模型选型',
)

// ===== 2. 选了运行中枢, 建会话时要真的带上设备绑定 =====
// 后端靠 add_remote_aimux_mcp 决定要不要给 agent 注入 remote_* 工具, 缺了就是空绑定.
assert.match(
  pageSource,
  /pc_client_metadata: \{[\s\S]*?aimux_id: welcomeSelection\.deviceId[\s\S]*?add_remote_aimux_mcp: true/,
  '选了设备后建会话必须带 pc_client_metadata (含 MCP 旗标)',
)
assert.match(
  barSource,
  /deviceId: string/,
  '选择里要有设备字段',
)

// ===== 3. 任务选完, 模型与上下文要跟着变 (config bar 原有联动不能被破坏) =====
assert.match(
  barSource,
  /const taskOptions: DropdownOption\[\]/,
  '任务下拉的数据源要保留',
)

console.log('欢迎页能力清单契约测试通过')
