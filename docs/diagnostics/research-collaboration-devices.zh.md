# 研究系统协作设备接入与验证

## 元素定位

1. 协作链路图标：`mobius/frontend/src/components/aimux-link-indicator.tsx` 的 `RemoteAimuxMcpIndicatorInner`。动态拼接的 ARIA 文案、title 的“点击切换协作设备”、`span.group > span[role=button]` 与用户提供的元素一致。`chat.tsx` 在 `.mobius-session-chat-header` 中挂载；`IssuePage` 与 `ResearchPage` 都使用 `ChatArea`。另一个 `AimuxLinkIndicator` 是桌面本机工作模式指示器，文案及图形不同，不是本次元素。
2. 创建设备下拉：原位于 `quick-create-session.tsx` 的 `CreateSessionForm`，“设备（令智能体在指定设备工作）”文本唯一命中；外层 `CreateModalShell` 来自 `global-create.tsx`，包含 `.global-create-modal`，与提供的祖先上下文一致。现抽为 `session-device-picker.tsx` 的 `SessionDevicePicker`，原 Issue 快捷入口继续使用同一组件。

## 改动

- 研究会话标题栏在中枢模式也保留协作设备入口，可绑定设备；已绑定时可切换、撤回初始设备或回到中枢。在线/断开提示继续使用现有 bridge 连接查询。
- `NewSessionModal` 的研究创建流程增加设备选择并按研究草稿保存；预览和创建复用 `session-device.ts` 生成元数据，显式远端不会继承其他本机的工作路径。
- `ResearchAgentTeamModal` 为每个待创建 Agent 独立保存和提交设备，可分别留在中枢或绑定设备。已创建成员显示当前绑定并保持锁定。
- 复用在线/离线、手动刷新、GUI 授权选项。设备相关必选技能在选择界面锁定，提交时从排除项清理。
- 后端 `PATCH /api/sessions/:id/aimux-device` 修复从中枢重新绑定设备时仍保留 `hub` 的问题，绑定后恢复 `dual`，已有 `pc` / `dual` 模式保留。

## 验证方式

- `node mobius/frontend/tests/research-device.test.mjs`：真实 React 组件和 Chromium 交互，API 使用固定测试数据。验证单个研究智能体的 GUI 设备预览/提交一致、必选技能、团队独立设备提交、中枢绑定、在线/断开、撤回与解绑，以及未在线上列表里的继承设备仍显示且不可改。团队 3D 场景与本次设备功能无关，在测试中替换为空组件。
- `cd mobius && node --require tsx/cjs tests/research-device-switch.js`：临时 SQLite 中创建研究会话，执行实际切换路由处理函数；检查详情/研究列表读回一致、初始设备保留、解绑后重绑恢复 dual、MCP 目标及提示词一致。
- `cd mobius && node --require tsx/cjs tests/research-continuation-device.js`：验证研究新建使用客户端设备、续接继承来源当前设备，选择快照和插入参数一致。
- `cd mobius && node --require tsx/cjs tests/pc-client-context.js`：既有设备上下文与 MCP 注入条件回归。
- `cd mobius/frontend && npx tsc --noEmit`；`cd mobius && npm run typecheck`：前端、后端、agent 类型检查。

测试不向用户真实设备派发命令；真实 bridge 网络连通性和远端命令执行不在本轮自动化验证范围内。
