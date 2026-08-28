# 09｜实施 Backlog：把视觉纪律与稳定跳转落到 Mobius

> 本文只定义后续实现任务，本轮不修改前端。任务依据见 [05｜视觉语言](./05-visual-language.md)、[06｜布局与 Chrome](./06-layout-and-chrome.md)、[07｜交互与跳转](./07-interaction-and-navigation.md)、[08｜能力呈现](./08-capability-presentation.md)。边界仍是：保留 Mobius 的完整能力，不重写 Tutti OS，也不把产品改成 CodexMonitor。

## 1. 执行边界与优先级

| 优先级 | 目标 | 允许改动 | 明确不做 |
|---|---|---|---|
| P0 | 让默认工作台颜色、密度、焦点与跳转先稳定 | CSS token、既有组件样式、路由参数、导航 helper、焦点恢复、契约测试 | 不改 harness 选择语义，不改 SSE/JSONL 协议，不重做 Chat，不新增主导航，不删除能力 |
| P1 | 把已有工具与状态收进按需表面 | 工具抽屉、搜索与附件入口、状态就近动作、Skill/Memory 管理跳转 | 不合并后端能力，不把高级页复制进默认工作台，不做 IDE 全量重构 |
| P2 | 统一高级页与桌面能力的视觉/返回语法 | 编辑器分栏、Research/Project/Admin chrome、AIMUX/桌面入口、非默认主题清理 | 不照搬 CodexMonitor 的 Git Plan，不弱化 Mobius 独有能力 |

依赖记法：`A → B` 表示 B 必须等 A 的接口或 token 稳定后再做。每个任务都可以原样交给下一轮 `codex exec`；执行前仍须重新确认工作树，保留用户已有修改。

## 2. P0：视觉 token 收敛 + 跳转一致性

P0 的完成标准不是“看起来更像 CodexMonitor”，而是同一语义只有一个 token、同一对象只有一条 canonical 跳转路径。当前 Dark/Light token 在 `mobius/frontend/src/index.css:121-213,659-709`，默认 Home / Session 骨架分别在 `mobius/frontend/src/pages/UserPage.tsx:281-477` 与 `mobius/frontend/src/pages/WorkPage.tsx:17-113`。

| ID / 可直接执行的任务 | 要改的文件 | 用户可感知结果 | 明确不改什么 | 验收方式 | 依赖 / 风险 |
|---|---|---|---|---|---|
| **P0-1 建立工作台语义 token**：按 05 的建议值补齐 `surface/base/raised/overlay`、`text/primary/secondary/muted`、`border/default/strong`、`accent/success/warning/danger/running/waiting`，并提供对现有变量的兼容映射。 | `mobius/frontend/src/index.css`；必要时只更新引用 token 的 `mobius/frontend/src/components/ui/*` | Light/Dark 下背景、边框、文字和状态色不再各组件自行猜色；原有品牌色只留在主动作和选中态。 | 不删除 `--background/--foreground/--primary` 等现有变量；不改主题存储格式；不改业务 JSX。 | 运行前端 build；用计算样式确认新旧变量都有值；Light/Dark 各截 Home、Session、Settings；正文/背景和 muted 文本对比度达到 WCAG AA。 | 无前置。风险：一次替换旧变量会波及高级页；本任务只新增语义层和兼容映射。 |
| **P0-2 收敛默认工作台表面**：将 Home、Rail、Chat、Settings 的硬编码 slate/blue/red/amber 类与内联色，映射到 P0-1 token；统一 1px 边框、hover/active、焦点环。 | `mobius/frontend/src/pages/UserPage.tsx`；`mobius/frontend/src/components/conversation-rail.tsx`；`mobius/frontend/src/components/chat.tsx`；`mobius/frontend/src/components/settings-panel.tsx`；`mobius/frontend/src/components/shell.tsx`；`mobius/frontend/src/index.css` | 四个核心表面在 Light/Dark 下有一致层级；hover 不再比选中态更抢眼；危险色只出现在删除/失败。 | 不移动控件，不改文案，不改 send/stop 行为，不碰 API、harness 或 SSE。 | 在 `/u/:user`、`/u/:user/s/:session`、Settings overlay 做视觉回归；键盘 Tab 时焦点环可见；`rg` 检查上述文件不再新增未解释的业务语义色。 | `P0-1 → P0-2`。风险：`chat.tsx` 体量大；按 Home header、composer、tool buttons、status 四个局部执行单元实现。 |
| **P0-3 固化尺度、层级和动效 token**：补 `chrome-height`、`rail-width`、`control-height-sm/md`、`radius-control/panel/modal`、`shadow-overlay`、`motion-fast/normal`；只让默认表面消费。 | `mobius/frontend/src/index.css`；`mobius/frontend/src/components/shell.tsx`；`mobius/frontend/src/components/conversation-rail.tsx`；`mobius/frontend/src/components/settings-panel.tsx`；`mobius/frontend/src/components/chat.tsx` | 顶栏、Rail 行、按钮、输入框和 overlay 的尺度有明确节奏；弹层高于面板但不靠厚重阴影。 | 不改变桌面端窗口尺寸，不压缩消息正文，不引入新的动画库。 | 1440×900、1280×800、1024×768 三档无控件裁切；`prefers-reduced-motion` 下过渡可关闭；Settings/搜索/菜单 z-index 不互相穿透。 | `P0-1 → P0-3`。风险：现有局部高度可能承担布局计算；先以 CSS 变量兼容当前值，再逐点收敛。 |
| **P0-4 建立 canonical 工作台导航 helper**：统一“打开 Session / 打开项目上下文 / 回 Home / 打开高级页”的 path、query、state 生成；替换 Rail、搜索、Issue、Research、Project 中手写的同义 URL。 | 新建 `mobius/frontend/src/services/workbench-navigation.ts`；`mobius/frontend/src/App.tsx:352-404`；`mobius/frontend/src/components/conversation-rail.tsx:78-80,234-240`；`mobius/frontend/src/components/search-modal.tsx:224-237`；`mobius/frontend/src/pages/IssuePage.tsx:238-248,494-503`；`mobius/frontend/src/pages/ResearchPage.tsx:239-250`；`mobius/frontend/src/pages/ProjectPage.tsx:937-955`；新增导航契约测试。 | 从任何入口打开同一 Session 都进入 `/u/:user/s/:session`；高级页返回时能保留来源 Session / Project。 | 不改变 App 的路由信息架构，不把高级页嵌进 Chat，不改 Session 创建 API。 | 单测覆盖 path/query/state 组合；从 Rail、搜索、Issue、Research、Project 各走一遍，目标 URL 与返回位置一致；未知 ID 留在当前上下文显示错误。 | 无视觉依赖，可与 P0-1 并行。风险：`App.tsx:352-375` 仍承接旧 query 链接；helper 必须兼容读取旧参数，不能一次性移除。 |
| **P0-5 修复 Research Graph 上下文断链**：`chat.tsx:4129-4137` 当前只给 WorkPage 所在 URL 写 `view=graph`，而 `WorkPage.tsx:17-113` 不消费该 query；改为 `/u/:user/p/:project/r/:research?session=:session&view=graph`，并携带可编码的来源短路由。 | `mobius/frontend/src/components/chat.tsx:4109-4143`；`mobius/frontend/src/pages/ResearchPage.tsx:239-250,292-297,479-508`；P0-4 helper 与测试；`WorkPage.tsx` 只作为“不消费 `view`”的契约证据，不应为此复制 Graph | 点 “Research Graph” 后一定看到对应研究，而不是 URL 变了、画面没变；返回仍是原会话。 | 不重写 ResearchGraph，不改研究数据模型，不在 WorkPage 复制一套研究页。 | 从有/无 `researchId` 的会话点击；有 ID 打开正确对象，无 ID 不显示该动作；浏览器 Back 和页面返回按钮都回 `/u/:user/s/:session`。 | `P0-4 → P0-5`。风险：`returnTo` 必须编码并校验为站内路由，避免开放重定向。 |
| **P0-6 统一 overlay 的焦点与返回契约**：Settings、全局搜索、确认弹层打开时记录触发控件，关闭后恢复；路由跳转成功后焦点落到主标题或 composer，失败则留在原 overlay 的错误区。 | `mobius/frontend/src/components/settings-panel.tsx:18-69,85-94`；`mobius/frontend/src/components/search-modal.tsx:103-133,224-248`；`mobius/frontend/src/components/shell.tsx:769-806,871-895`；`mobius/frontend/src/pages/UserPage.tsx:307-317,355-360,397-451`；`mobius/frontend/src/pages/WorkPage.tsx:88-110`；相关可访问性测试 | 用户打开设置再返回，不会丢失原上下文和键盘位置；搜索打开 Session 后可直接继续输入；失败时不会被抛到空白页。 | 不改变 Settings 分类，不新增全屏设置路由，不改聊天发送协议。 | 纯键盘完成“打开→操作→关闭”；Esc 只关最上层 overlay；焦点不落到已卸载节点；axe/现有 a11y 测试无新增严重问题。 | `P0-4` 提供跳转后的统一焦点钩子；与 P0-2 有样式交叉。风险：嵌套 modal 焦点竞争。 |

### P0 建议执行顺序

```text
P0-1 ─┬─> P0-2
      └─> P0-3

P0-4 ─┬─> P0-5
      └─> P0-6

最后：P0-2 + P0-3 + P0-6 联合做 Light/Dark、鼠标/键盘回归
```

P0 合并门槛：不得修改任何 harness 默认值或模型选择语义；不得修改 `EventSource`、SSE 事件解析、JSONL 持久化与消息恢复逻辑。若实现触及这些区域，应退出 P0 并重新拆任务。

## 3. P1：按需工具、就近状态与能力可发现性

| ID / 可直接执行的任务 | 要改的文件 | 用户可感知结果 | 明确不改什么 | 验收方式 | 依赖 / 风险 |
|---|---|---|---|---|---|
| **P1-1 建立单一 Tools 抽屉**：把 Files、Diff/Git、Terminal、Editor、Research Graph 作为一组按需入口；沿用现有 modal / workspace 能力，不在头部平铺按钮。 | `mobius/frontend/src/components/chat.tsx:4109-4144,4229-4244,5040-5154`；`mobius/frontend/src/components/advanced-session-actions.tsx:72-249`；现有文件/终端/编辑器组件；`index.css` | Session 默认只保留状态、上下文与 Send/Stop；需要工具时从一个入口展开，当前工具有选中态。 | 不复制工具实现，不新增第二个 Chat，不照搬 CodexMonitor 的 Git Plan，不默认常驻右栏。 | Home 不出现工具抽屉；Session 一次点击可达每项工具；关闭后 composer 草稿和滚动位置保留；1024px 下不遮住主动作。 | 依赖 P0-1/P0-3/P0-4。高风险：`chat.tsx` 中工具状态分散，先抽入口配置，不搬业务状态。 |
| **P1-2 补齐附件与 `@` 引用的双入口**：纸夹负责系统文件选择，`@` 继续路径补全；上传/解析失败在 composer 附近重试。 | `mobius/frontend/src/components/chat.tsx:1706-2175,2240-2251,2970-3188,4580-4636,4799-4833`；现有附件 API；相关测试 | 新用户能发现“附文件”，熟练用户仍可键盘 `@`；失败不会清空草稿或已选附件。 | 不把 `@` 改成装饰按钮，不引入新的文件存储协议，不默认上传整个目录。 | 鼠标和键盘分别完成附件；重复/超限/网络错误有就地提示与重试；发送成功后才清理附件状态。 | 依赖 P0-2。风险：浏览器与桌面文件权限差异，需分别验收。 |
| **P1-3 搜索支持精确 Session ID 与原地重试**：在现有搜索结果上增加 ID 形态识别、直接打开和失败态。 | `mobius/frontend/src/components/search-modal.tsx:103-205,224-237`；Session 查询 API；P0-4 helper；测试 | 粘贴 Session ID 可找回会话；普通关键词搜索不受影响；不存在/无权限时仍留在搜索框。 | 不新增第二套搜索页，不在前端扫描所有 JSONL，不改变权限模型；尤其不顺手改 `search-modal.tsx:135-205` 的 SSE 解析。 | 有效 ID、无效 ID、关键词、空结果、API 失败五类测试；失败后输入和 query 保留；成功焦点落 composer。 | 依赖 P0-4/P0-6。风险：ID 格式可能不唯一，应以后端查询结果为准。 |
| **P1-4 给运行、等待、失败状态绑定唯一下一步动作**：运行中显示 Stop；等待输入时聚焦 composer；发送失败恢复草稿并 Retry；agent 失败提供 Retry/Details。 | `mobius/frontend/src/components/chat.tsx:2559-2775,4055-4097,4247-4353,4468-4505,4879-4919`；`mobius/frontend/src/components/session-status-chip.tsx:27-54`；`index.css`；测试 | 状态不再只是颜色标签；用户在状态发生处就知道下一步点哪。 | 不更改 SSE 事件协议，不自动重跑失败任务，不把错误详情常驻首屏。 | 模拟 running/waiting/send error/agent error；每态只有一个高优先级动作；Retry 不重复用户消息，Stop 不误发 Send。 | 依赖 P0-1/P0-2。高风险：重试幂等性；实现前先确认现有发送函数是否可安全复用。 |
| **P1-5 区分 Skill/Memory 当前快照与管理入口**：composer 旁只显示当前 Session 快照；编辑和全量管理进入 Settings / 用户高级页，并提供清晰返回。 | `mobius/frontend/src/components/chat.tsx:4109-4143,4229-4235,4930-4947`；`mobius/frontend/src/components/session-welcome.tsx:707-1034,1169-1222`；`mobius/frontend/src/components/settings-panel.tsx:170-178`；`mobius/frontend/src/pages/UserPage.tsx:493-501,1308-1324` | 用户能看到当前会话用了什么，也知道去哪管理；默认表面不展示全量列表。 | 不改变 Skill/Memory 注入时机和存储结构，不在 Chat 中复制管理器。 | 当前快照、空状态、进入管理、保存、取消、回到会话五条路径；取消不改变 Session 配置。 | 依赖 P0-4/P0-6。风险：当前值与全局值语义混淆，文案必须写“本会话/管理”。 |
| **P1-6 让模型/Harness 入口表达真实语义**：当前“修改模型并继续”会新建 Session，控件和确认层必须明确说明，并把新 Session 放进同一 Rail 上下文。 | `mobius/frontend/src/components/advanced-session-actions.tsx:185-193`；`mobius/frontend/src/components/chat.tsx:3995-4006,4109-4143,5068-5081`；`mobius/frontend/src/components/modals.tsx:2212-2253,3027`；Rail 刷新逻辑；测试 | 用户不会误以为在原会话热切模型；确认后进入新 Session，取消留在原会话。 | 不改变 harness 枚举、默认选择、后端创建参数，不实现运行中热切。 | 改模型/改 harness/取消/创建失败/创建成功五类；失败保留原 Session 与草稿；成功 URL、Rail 选中项一致。 | 依赖 P0-4。风险：这是语义澄清，不得顺手重构 harness 或流式链路。 |

## 4. P2：高级表面、编辑器与桌面能力

| ID / 可直接执行的任务 | 要改的文件 | 用户可感知结果 | 明确不改什么 | 验收方式 | 依赖 / 风险 |
|---|---|---|---|---|---|
| **P2-1 统一高级页 chrome 与返回语法**：Project、Issue、Research、Admin 共享紧凑标题栏、语义 token、来源上下文返回按钮。 | `mobius/frontend/src/pages/ProjectPage.tsx`；`IssuePage.tsx`；`ResearchPage.tsx`；Admin 相关页面；共享 page chrome；`index.css` | 高级页仍是独立空间，但看起来属于同一产品；返回明确回到来源 session/project，而非总回 Home。 | 不塞回默认工作台，不删高级能力，不重写各页数据加载。 | 从 Home/Session/Project 三种来源进入并返回；深链接刷新仍可用；Light/Dark 无旧主题色孤岛。 | 依赖 P0-1/P0-4/P0-6。风险：Admin 权限和深链接不能依赖前端 history 才成立。 |
| **P2-2 将编辑器稳定为按需 split/drawer**：复用现有 workspace editor，统一从 Tools 打开；会话、文件选中与编辑器状态在开关面板时保持。 | `mobius/frontend/src/pages/IssuePage.tsx:279-304,847-910`；`mobius/frontend/src/pages/ResearchPage.tsx:31-58,434-477`；`mobius/frontend/src/components/workspace/editor-pane.tsx`；`mobius/frontend/src/components/workspace/code-conversation-pane.tsx`；布局样式 | 用户可在会话旁查看/编辑文件，又不会让 IDE chrome 常驻首屏；关闭后仍回原对话位置。 | 不创建第二个 Chat 实例，不重建编辑内核，不默认三栏常驻。 | 开/关 10 次无 Session 重载；草稿、消息滚动、文件 tab 保持；1024/1280/1440 宽度均可操作。 | 依赖 P1-1。最高风险：组件 remount 可能丢 Chat 状态；先复用 Issue/Research 已有“首次挂载、随后 hidden 保活”方式。 |
| **P2-3 衔接文件、Diff、Git、终端的对象上下文**：从消息引用、Issue 或 Research 打开工具时，自动定位已有文件/变更/工作目录；关闭回来源。 | 现有 files/git/terminal 组件；`chat.tsx` 工具入口；`IssuePage.tsx`；`ResearchPage.tsx`；P0-4 helper | “查看这个文件/差异/终端”落到具体对象，不只是打开空面板；工具之间切换不丢来源。 | 不实现新的 Git 工作流，不自动执行终端命令，不扩大文件权限。 | 文件不存在、diff 为空、终端不可用均有原地错误；成功时选中对象正确；返回来源稳定。 | 依赖 P1-1/P2-2。风险：路径规范化与权限边界；不得把绝对路径暴露给无权限表面。 |
| **P2-4 收敛 Research、系统可视化和助手气泡的层级**：Research 保持高级页；系统图按需全屏；助手气泡只做跨页提示，不与 composer 争主动作。 | `mobius/frontend/src/pages/ResearchPage.tsx:320-530`；`mobius/frontend/src/pages/MobiusOverviewPage.tsx:695-881`；`mobius/frontend/src/pages/MobiusOverviewClusterPage.tsx:2438-2636`；`mobius/frontend/src/components/assistant-chat.tsx`；挂载与入口 `App.tsx:399-419`、`settings-panel.tsx:157-164,194-203`；`index.css` | 能力仍完整可见，但不会同时以浮层、页签和主按钮争夺注意力。 | 不删除可视化，不把 Research 降级成聊天附件，不让助手气泡代替错误/状态反馈。 | 默认 Home/Session 无遮挡；可视化一跳可达并可返回；气泡出现时不盖 composer/Stop/错误动作；移动宽度可关闭。 | 依赖 P0-1/P0-3/P0-4。风险：浮层 z-index 和持久化状态冲突。 |
| **P2-5 统一 AIMUX / 桌面 / 下载 / CLI 的分发入口**：Settings 的“连接与客户端”提供分组入口；桌面运行态只显示环境相关动作。 | `mobius/frontend/src/components/settings-panel.tsx:182-190,219-225`；下载/桌面/AIMUX/CLI 现有 Modal；桌面挂载 `mobius/frontend/src/App.tsx:413-420`；环境检测封装 | 用户知道这些能力存在，但首屏不出现一排平台按钮；Web 与桌面只看到可用动作。 | 不下载或安装任何东西，不改 AIMUX/CLI 协议，不把平台入口设为主动作。 | Web、Desktop、能力不可用三种环境快照；链接/命令可复制；关闭 Settings 回原上下文；失败提示留在入口附近。 | 依赖 P0-6。风险：环境检测必须来自现有可信信号，不能用脆弱 UA 猜测。 |
| **P2-6 完成非默认主题与密度回归**：在 Light/Dark 稳定后处理既有 dim/其他主题映射，确保高级页和 overlay 没有硬编码反色。 | `mobius/frontend/src/index.css`；主题设置相关组件；全局视觉回归用例 | 切换主题后所有核心与高级表面仍保持同一语义层级；密度变化不破坏点击目标。 | 不新增品牌皮肤，不删除用户已有主题选择，不追求与 CodexMonitor 色值逐像素一致。 | 每个保留主题覆盖 Home/Session/Settings/Project/Research/Admin；正文对比度、状态可辨性、焦点环和 40px 左右点击目标通过。 | 依赖 P0-1/P2-1。风险：历史主题变量缺失；必须显式 fallback，不能静默回到错误色。 |

## 5. 跨任务验收清单

### 5.1 自动检查

后续实现至少应运行仓库现有前端 build/test 命令，并扩展 `mobius/frontend/tests/workbench-simplification-contract.test.js` 或增加专门的 navigation contract。需要覆盖：

- 同一 Session 从 Rail、搜索、Issue、Research 打开时生成相同 canonical URL；依据现状入口 `conversation-rail.tsx:78-80,234-240`、`search-modal.tsx:224-237`、`IssuePage.tsx:238-248,494-503`、`ResearchPage.tsx:239-250`。
- Settings/搜索关闭后恢复触发焦点，成功跳转后焦点落主标题或 composer。
- Light/Dark 下语义 token 均有值，危险、等待、运行、成功不共用同一颜色。
- P0 的 diff 不包含 harness 默认值、SSE 事件名、流式解析、JSONL 持久化改动。

### 5.2 人工路径

| 场景 | 必须看到的结果 |
|---|---|
| 首次进入 `/user` | 项目上下文 + 一个主输入；“开始工作”是唯一主动作，管理入口不抢首屏。 |
| 从 Rail 继续会话 | URL、选中态、消息区一致，焦点可继续输入；加载失败仍留在原上下文重试。 |
| Session 打开 Tools | 按需出现文件/Diff/终端/编辑器；关闭不丢草稿、滚动或 session。 |
| 打开 Settings 再关闭 | 原页面、项目、session、滚动与触发焦点保持。 |
| 运行 / 等待 / 失败 | 分别只有 Stop、继续输入、Retry 一个显著下一步动作。 |
| 进入 Project / Research / Admin | 高级能力完整，返回明确，默认工作台没有因此增加常驻 chrome。 |

### 5.3 视觉基线

- 视口：1440×900、1280×800、1024×768；桌面壳另测其最小窗口。
- 主题：P0 至少 Light/Dark；P2 再覆盖所有保留主题。
- 输入：鼠标、纯键盘、IME 中文输入、`prefers-reduced-motion`。
- 表面：Home、Session、Rail、composer、Settings、搜索、错误态、至少一个高级页。

## 6. 风险登记与停止条件

| 风险 | 预警信号 | 处理方式 / 停止条件 |
|---|---|---|
| `chat.tsx` 单文件状态耦合 | 样式改动导致 send/stop、草稿或流式状态变化 | 立即停止扩大重构；只抽纯展示配置并补回归。P0 不得触及流式逻辑。 |
| 同义路由历史兼容 | 旧书签或深链接打开空页面 | canonical helper 先兼容读取旧参数，再统一新写入；无迁移验证不得删除旧解析。 |
| 工具面板导致 Chat remount | 打开编辑器后消息重载、草稿消失 | 停止分栏实现，先证明单 Chat 实例与保活；这也是 P2-2 的硬门槛。 |
| 语义色与品牌色混用 | primary 蓝同时代表运行、链接、成功和选中 | 回到 P0-1 token 表；每个状态用独立变量，品牌色只服务主动作/选中。 |
| “能力完整”变成入口堆叠 | Home 或 session header 又出现五个以上并列工具按钮 | 停止增加常驻入口；按 08 的五层模型归位到 Tools、Settings 或高级页。 |
| 桌面/Web 行为分叉 | Web 出现不可用 AIMUX 动作或桌面出现下载自身按钮 | 使用现有环境能力信号；无法可靠判断时只给文档入口，不执行动作。 |

## 7. Definition of Done

整个 backlog 的完成状态应满足：

1. 用户在 Home 看见一个开始入口，在 Session 看见一个 Send/Stop 主动作；能力通过 Rail、Tools、Settings、高级页逐层展开。
2. 同一对象从任何入口打开，URL、焦点、返回和失败重试语法一致；Research Graph 不再出现“地址变了、内容没变”。
3. 颜色、密度、圆角、阴影和动效来自语义 token；Light/Dark 与高级页共享纪律，但 Mobius 的品牌和能力边界不被 CodexMonitor 皮肤替代。
