/**
 * 跨设备面板 (issue 2026-10-27) 的契约测试.
 *
 * 锁住四件事:
 *   1. 面板真的能增删改查 —— 原来它只是一张只读列表, 设备的增删改规则在界面上没有答案;
 *   2. SSH 主机与协作设备分开列 —— 两者的增删改规则不同 (SSH 能删, 协作设备不能);
 *   3. 重命名走 per-user 别名 (remote_device_names), 不改路由;
 *   4. 面板把「设备能干什么」讲清楚, 而不是只列名字.
 *
 * 运行: node tests/easy-devices-panel.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSource = relativePath => fs.readFileSync(path.join(here, '..', relativePath), 'utf8')

const panelSource = readSource('src/components/easy-devices-panel.tsx')
const pageSource = readSource('src/pages/EasyModePage.tsx')
const cssSource = readSource('src/index.css')
const routeSource = readSource('../backend/routes/aimux.ts')
const serviceSource = readSource('../backend/services/aimux-remote.ts')

// ===== 1. 面板挂在原来的位置上, testid 不变 (外部脚本按它定位) =====
assert.match(
  pageSource,
  /<EasyDevicesPanel isDark=\{theme !== 'light'\} \/>/,
  '跨设备面板必须渲染新组件',
)
assert.match(
  panelSource,
  /data-testid="easy-devices-panel"/,
  '面板根节点必须保留 easy-devices-panel 这个 testid',
)

// ===== 2. 增: 面板里能添加 SSH 主机 =====
assert.match(
  panelSource,
  /api\('\/api\/aimux\/remotes', \{\s*method: 'POST'/,
  '面板必须能添加 SSH 主机 (POST /api/aimux/remotes)',
)
assert.match(
  panelSource,
  /data-testid="easy-devices-add-form"/,
  '添加表单必须可定位',
)
assert.match(
  panelSource,
  /主机/,
  '添加表单必须要求主机',
)
assert.match(
  panelSource,
  /用户名/,
  '添加表单必须要求用户名',
)
// 添加前先探测 —— aimux remote add 本身就会探测, 面板不该绕开它
assert.match(
  panelSource,
  /添加前会先探测连通性/,
  '面板必须说明添加前会先探测连通性 (不通就不写 SSH 配置)',
)

// ===== 3. 删: SSH 主机能移除, 且走的是新加的后端端点 =====
assert.match(
  panelSource,
  /api\(`\/api\/aimux\/remotes\/\$\{encodeURIComponent\(name\)\}`, \{ method: 'DELETE' \}\)/,
  '移除 SSH 主机必须走 DELETE /api/aimux/remotes/:name',
)
assert.match(
  routeSource,
  /router\.delete\('\/remotes\/:name', auth/,
  '后端必须有鉴权的删除端点 (auth 不可省)',
)
assert.match(
  serviceSource,
  /function removeRemote/,
  'service 必须实现 removeRemote',
)
// 删除只对「莫比乌斯添加」的主机开放, 手写配置一律拒绝 —— 不能替用户改 ssh 配置
assert.match(
  serviceSource,
  /不是通过莫比乌斯添加的, 请手动编辑 ~\/\.ssh\/config 处理/,
  'removeRemote 必须拒绝删除手写进 ssh config 的主机',
)

// ===== 4. 改: 重命名走 per-user 别名, 不碰路由 =====
assert.match(
  panelSource,
  /useRemoteDeviceNames\(\)/,
  '面板必须用 per-user 设备别名服务',
)
assert.match(
  panelSource,
  /await setName\(deviceId, next\)/,
  '重命名必须走 setName (per-user 别名)',
)
assert.match(
  panelSource,
  /startRename/,
  '面板必须提供重命名入口',
)
// 别名是纯展示层: 不允许借重命名去改会话绑定或设备标识
assert.doesNotMatch(
  panelSource,
  /aimux-device/,
  '重命名不得改动会话的设备绑定',
)

// ===== 5. 两类设备分组, 规则不同 =====
assert.match(
  panelSource,
  /SSH 主机 <span>\{sshRemotes\.length\}<\/span>/,
  'SSH 主机必须单独分组',
)
assert.match(
  panelSource,
  /协作设备 <span>\{bridgeRemotes\.length\}<\/span>/,
  '协作设备必须单独分组',
)
// SSH 主机从 aimux 那份列表取 (排除 bridge), 协作设备从 broker 那份取
assert.match(
  panelSource,
  /remote\.type === 'bridge'\) return/,
  'SSH 列表必须排除 bridge 类型 (协作设备从 broker 那侧单独取)',
)
assert.match(
  panelSource,
  /api\('\/aimux_bridge\/api\/remotes'/,
  '协作设备必须走 broker 的列表',
)
// 协作设备没有删除按钮 —— 它由客户端自己反连注册, 客户端退出即消失
const bridgeSection = panelSource.slice(
  panelSource.indexOf('协作设备 <span>'),
  panelSource.length,
)
assert.doesNotMatch(
  bridgeSection,
  /removeSsh\(/,
  '协作设备不得有移除按钮 (删不掉的东西别给按钮)',
)

// ===== 6. 状态区分: auth-required 不是「离线」 =====
assert.match(
  panelSource,
  /sshStatusLabel/,
  'SSH 状态必须有独立映射',
)
assert.match(
  panelSource,
  /auth-required[\s\S]*?需授权/,
  'SSH auth-required 必须显示为「需授权」, 不能混进离线',
)
assert.match(
  cssSource,
  /easy-device-row__status\.is-warn/,
  '「需授权」要有独立的颜色',
)

// ===== 7. 轮询节奏: bridge 与 ssh 代价不同, 不能一起 10 秒 =====
assert.match(
  panelSource,
  /window\.setTimeout\(tick, 60_000\)/,
  'SSH 主机列表必须低频轮询 (探测一次要真连远端)',
)
assert.match(
  panelSource,
  /window\.setTimeout\(tick, 10_000\)/,
  '协作设备状态必须保持 10 秒轮询',
)

// ===== 8. 首屏不能闪假空态 =====
// 扫 SSH 主机要真连一次远端 (~1s). 一次性端点要等整轮探测才返回, 期间面板
// 只能显示「暂无 SSH 主机」—— 一台都有的情况下说没有, 是假空态.
// 改用流式端点: 名字先落地 (状态 probing), 真状态后补.
assert.match(
  panelSource,
  /fetch\('\/api\/aimux\/remotes\/stream'/,
  'SSH 主机必须走流式端点, 让名字先落地',
)
// 列表不能再用一次性端点 (要等整轮探测, 首屏会闪假空态).
// 注意只查 loadSsh 这个函数体 —— 添加主机仍然走 POST /api/aimux/remotes, 那是另一回事.
const loadSshBody = panelSource.slice(
  panelSource.indexOf('const loadSsh = useCallback'),
  panelSource.indexOf('const load = useCallback'),
)
assert.doesNotMatch(
  loadSshBody,
  /api\('\/api\/aimux\/remotes'/,
  '列表不能再用一次性端点 (要等整轮探测, 首屏会闪假空态)',
)
assert.match(
  panelSource,
  /status === 'probing'/,
  '流式扫描的中间态 (probing) 必须被认出来',
)
assert.match(
  panelSource,
  /探测中/,
  '探测中必须有独立的文案',
)
// 加载中显示骨架, 而不是空态
assert.match(
  panelSource,
  /sshLoading && sshRemotes\.length === 0/,
  'SSH 组在扫描期间必须显示骨架, 不能显示「暂无」',
)
assert.match(
  panelSource,
  /bridgeLoading && bridgeRemotes\.length === 0/,
  '协作设备组在读取期间必须显示骨架',
)
assert.match(
  panelSource,
  /easy-device-row--skeleton/,
  '骨架必须有可辨识的类名',
)
assert.match(
  cssSource,
  /easy-device-skeleton__line/,
  '骨架要有样式',
)
// 空态只在真的扫完之后才出现
assert.match(
  panelSource,
  /const empty = totalCount === 0 && !anyLoading && !error/,
  '「一台都没有」必须在两边都扫完之后才成立',
)
// 探测中的样式类由状态名拼出来 (is-${status.tone}), 所以查 tone 与拼接两处.
assert.match(
  panelSource,
  /tone: 'pending'/,
  '探测中要有独立的状态 tone',
)
assert.match(
  panelSource,
  /is-\$\{status\.tone\}/,
  '状态类名必须由 tone 拼出来',
)
assert.match(
  cssSource,
  /easy-device-row__status\.is-pending/,
  '探测中要有样式',
)

// ===== 9. 流不能叠着开: 旧流不掐掉会同时打远端, 迟到事件还会盖掉新状态 =====
assert.match(
  panelSource,
  /streamAbortRef\.current\?\.abort\(\)/,
  '开新流之前必须掐掉上一条流',
)
assert.match(
  panelSource,
  /requestId !== streamRequestRef\.current/,
  '迟到的流事件必须被丢弃',
)

// ===== 10. 面板讲清楚设备能干什么 =====
assert.match(
  panelSource,
  /智能体可以直接在它上面执行命令、读写文件/,
  '面板必须说明设备的用途',
)
assert.match(
  panelSource,
  /easy-devices-toolbar__hint/,
  '用途说明必须真的渲染出来',
)
assert.match(
  cssSource,
  /easy-devices-toolbar__hint/,
  '用途说明要有样式',
)
assert.match(
  cssSource,
  /easy-devices-group__note/,
  '分组说明要有样式',
)
// 用途说明只能指向真实存在的入口. 会话工具里的「协作设备」已撤掉, 面板不能再引它.
assert.doesNotMatch(
  panelSource,
  /切换协作设备/,
  '面板不能指向已经撤掉的「切换协作设备」入口',
)
assert.match(
  panelSource,
  /新建会话时在「设备」里指定/,
  '用途说明要指向真实存在的入口 (新建会话时的设备下拉)',
)

console.log('跨设备面板契约测试通过')
