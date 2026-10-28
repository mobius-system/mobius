/**
 * 输入框「运行设备」切换 + 文件树与运行设备强绑定 (issue 2026-10-28) 的契约测试.
 *
 * 背景: 会话跑在哪台机器上 (中枢 / 某台本地设备) 此前没有入口 —— 简易模式根本不渲染
 * 会话顶栏, 而顶栏那个设备图标又只在会话已绑定设备时才出现, 于是网页创建的会话
 * 无从切换. 而「文件树跟着运行设备走」这条链, 后端早就支持 (会话绑定的设备会被注入
 * 远程文件源首位), 前端却没在设备切换后重拉 —— 文件树会停在上一台设备的目录上.
 *
 * 锁住:
 *   1. 输入框里有「运行设备」pill, 触发器只画图标 (名字留到展开后的列表);
 *   2. 弹窗里列的是「中枢 + 各台设备」, 中枢是可选的运行位置;
 *   3. 切换走 PATCH /api/sessions/:id/aimux-device, 且后端绑定时要给
 *      add_remote_aimux_mcp (不然 agent 拿不到 remote_* 工具, 绑定是空转);
 *   4. 文件树在运行设备变化后必须重拉远程文件源, 并跟着切到对应来源.
 *
 * 运行: node tests/easy-runtime-device.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSource = relativePath => fs.readFileSync(path.join(here, '..', relativePath), 'utf8')

const pillSource = readSource('src/components/easy-session-device-pill.tsx')
const inputSource = readSource('src/components/easy-session-chat-input.tsx')
const chatSource = readSource('src/components/chat.tsx')
const paneSource = readSource('src/components/workspace/code-conversation-pane.tsx')
const sessionsRouteSource = readSource('../backend/routes/sessions.ts')

// ===== 1. 输入框里的运行设备 pill =====
assert.match(
  inputSource,
  /<EasySessionDevicePill/,
  '输入框必须渲染运行设备 pill',
)
assert.match(
  inputSource,
  /deviceId=\{follow\.sessionDeviceId \|\| ''\}/,
  '运行设备 pill 必须拿到当前绑定的设备',
)
assert.match(
  inputSource,
  /onChange=\{async \(deviceId: string\)/,
  '运行设备 pill 必须把切换回调接上',
)
// 触发器只画图标: 设备名又长又占宽度, 这一行右边同时站着模型 pill 和四个动作键
assert.match(
  pillSource,
  /aria-label="切换运行设备"/,
  'pill 触发器必须有 aria-label',
)
assert.match(
  pillSource,
  /<DeviceIcon platform=\{currentPlatform\}/,
  '触发器要按平台画设备图标',
)
assert.doesNotMatch(
  pillSource,
  /\{displayText \|\| '模型'\}/,
  'pill 触发器不能像模型 pill 那样写名字',
)
// 平台 → 图标
assert.match(
  pillSource,
  /'darwin'\) return <Laptop/,
  'mac 要用笔记本图标',
)
assert.match(
  pillSource,
  /'win32' \|\| platform === 'windows'\) return <Monitor/,
  'windows 要用显示器图标',
)
assert.match(
  pillSource,
  /'android' \|\| platform === 'ios'\) return <Smartphone/,
  '手机端要有自己的图标',
)

// ===== 2. 弹窗: 中枢 + 各台设备 =====
assert.match(
  pillSource,
  /api\('\/aimux_bridge\/api\/remotes'/,
  '设备列表必须走 broker 的 live 列表',
)
assert.match(
  pillSource,
  />中枢</,
  '中枢必须是一个可选的运行位置 (会话可以只跑在云端)',
)
assert.match(
  pillSource,
  /莫比乌斯自己的云端/,
  '中枢要有说明',
)
assert.match(
  pillSource,
  /formatName\(device\.name\)/,
  '设备名要用 per-user 别名显示',
)

// ===== 3. 切换走后端端点 =====
assert.match(
  chatSource,
  /api\(\`\/api\/sessions\/\$\{sessionId\}\/aimux-device\`/,
  '切换必须走 PATCH /api/sessions/:id/aimux-device',
)
// 绑定时必须给 add_remote_aimux_mcp: aimuxRemoteNameFromMeta 靠它决定要不要注入
// remote_* 工具, 只写 aimux_id 的话绑定是空转
assert.match(
  sessionsRouteSource,
  /add_remote_aimux_mcp: true/,
  '绑定设备必须同时置 add_remote_aimux_mcp',
)
// 解绑回中枢: 收回旗标 + 工作模式回中枢
assert.match(
  sessionsRouteSource,
  /add_remote_aimux_mcp: false, work_mode: 'hub'/,
  '解绑必须收回旗标并把工作模式回中枢',
)
// 前端把空串当作「回到中枢」
assert.match(
  chatSource,
  /onChangeSessionDevice=\{async \(deviceId: string\)/,
  '会话页必须把切换回调接进输入框',
)
assert.match(
  pillSource,
  /onChange\(nextId\)/,
  'pill 必须把选中的设备回调出去',
)

// ===== 4. 文件树跟着运行设备走 =====
assert.match(
  paneSource,
  /sessionDeviceId\?: string/,
  '文件面板必须能拿到当前运行设备',
)
assert.match(
  paneSource,
  /\[projectId, remoteSourcesVersion, sessionId, sessionDeviceId, blueprint\]/,
  '运行设备一换, 远程文件源必须重拉 (否则文件树停在上一台设备)',
)
// 设备变了, 文件源跟着走: 绑了设备落到「远程」, 解绑回中枢落到「中枢」
assert.match(
  paneSource,
  /const next: FileSource = sessionDeviceId \? 'remote' : 'hub'/,
  '文件源必须跟着运行设备走',
)
assert.match(
  paneSource,
  /prevDeviceIdRef/,
  '要记住上一台设备才能发现"变了"',
)
// 会话页把设备 id 传进文件面板
assert.match(
  chatSource,
  /sessionDeviceId=\{boundAimuxDeviceId\(currentSession \?\? currentTask\)\}/,
  '会话页必须把运行设备传给文件面板',
)

console.log('运行设备切换契约测试通过')
