/**
 * 会话工具 → 协作设备 (issue 2026-10-27) 的契约测试.
 *
 * 背景: 面板上写着「会话里用「切换协作设备」指定在哪台机器上工作」, 但
 * 「切换协作设备」这个入口此前只存在于会话顶栏的那个设备图标上, 而那个图标
 * 只在会话**已经**绑定了设备时才渲染 (aimux-link-indicator 里 if (!aimuxId) return null).
 * 于是网页创建的会话 (没有绑定) 在哪儿都找不到这个入口 —— 面板在指一个够不着的东西.
 *
 * 锁住:
 *   1. 会话工具菜单里必须有「协作设备」入口, 且列出 broker 里的设备;
 *   2. 绑定设备必须真的给 agent 装上 remote_* 工具 (add_remote_aimux_mcp),
 *      否则「绑了设备但 agent 手里没有工具」是空转;
 *   3. 没有会话时不能绑 (与注入 Skill/Memory/Git 的禁用规则一致);
 *   4. 换设备的老路径 (顶栏图标) 不能被这次改动弄坏.
 *
 * 运行: node tests/easy-device-switch.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSource = relativePath => fs.readFileSync(path.join(here, '..', relativePath), 'utf8')

const menuSource = readSource('src/components/easy-session-tool-menu.tsx')
const chatSource = readSource('src/components/chat.tsx')
const inputSource = readSource('src/components/easy-session-chat-input.tsx')
const sessionsRouteSource = readSource('../backend/routes/sessions.ts')

// ===== 1. 会话工具菜单里的「协作设备」入口 =====
assert.match(
  menuSource,
  /label=\{?['"]协作设备|协作设备/,
  '会话工具菜单必须有「协作设备」入口',
)
assert.match(
  menuSource,
  /api\('\/aimux_bridge\/api\/remotes'/,
  '设备列表必须走 broker 的 live 列表',
)
assert.match(
  menuSource,
  /onSwitchDevice\?: \(deviceId: string\) => Promise<void>/,
  '菜单必须接受切换设备的回调',
)
assert.match(
  menuSource,
  /currentDeviceId\?: string \| null/,
  '菜单必须知道当前绑的是哪台设备 (要标「当前」)',
)
assert.match(
  menuSource,
  /aria-checked=\{isCurrent\}/,
  '当前设备必须被标出来',
)
// 没有会话时不能绑
assert.match(
  menuSource,
  /disabled=\{!!switchingTo \|\| !props\.hasSession\}/,
  '没有会话时设备不可选 (与注入 Skill/Memory 同规则)',
)

// ===== 2. 绑定要真的生效 =====
// 只写 aimux_id 不写 add_remote_aimux_mcp 的话, aimuxRemoteNameFromMeta 不会给
// agent 注入 remote_* 工具 —— 会话显示"绑了设备"但 agent 手里是空的.
assert.match(
  sessionsRouteSource,
  /add_remote_aimux_mcp: true/,
  '绑定设备必须同时置 add_remote_aimux_mcp, 否则不会注入 remote_* 工具',
)
assert.match(
  sessionsRouteSource,
  /if \(!updated\.work_mode\) updated\.work_mode = 'pc'/,
  '没有工作模式的会话要补成 pc (在设备上干活), 已有模式的不能被改',
)
// 换设备的既有路径保留
assert.match(
  sessionsRouteSource,
  /initial_aimux_id: initialAimuxId/,
  '首次切换的锚点必须保留 (可撤回)',
)

// ===== 3. 接线: 菜单 → 会话输入框 → 会话页 =====
assert.match(
  inputSource,
  /onSwitchDevice=\{follow\.onSwitchDevice\}/,
  '会话输入框必须把切换设备回调传给工具菜单',
)
assert.match(
  inputSource,
  /currentDeviceId=\{follow\.currentDeviceId\}/,
  '会话输入框必须把当前设备传给工具菜单',
)
assert.match(
  chatSource,
  /onSwitchDevice=\{\(deviceId: string\) => handleSwitchAimuxDevice/,
  '会话页必须把切换设备接到已有的切换逻辑上',
)
assert.match(
  chatSource,
  /currentDeviceId=\{boundAimuxDeviceId\(/,
  '会话页必须告诉菜单当前绑的是哪台设备',
)
// 首次绑定与换设备的话术不同
assert.match(
  chatSource,
  /用户把mcp连接的设备设定为\$\{newId\}/,
  '首次绑定要有一套自己的唤醒话术 (「从空变成X」读着别扭)',
)
assert.match(
  chatSource,
  /用户更新了mcp连接的设备（从\$\{oldId\}变成\$\{newId\}/,
  '换设备的老话术必须保留',
)

console.log('协作设备切换契约测试通过')
