# CodexMonitor 主壳复用规格：把 Mobius 能力放进同一张桌面工作台

> 本文是 2026-08-28 工作区快照上的只读源码审计与下一轮实现规格。本轮不修改前端、后端、Harness、SSE、Stop 或消息协议；“复用”指复用桌面主壳的槽位、几何关系、显隐和返回语法，不指复制 CodexMonitor 的产品对象或视觉皮肤。既有边界要求保留全部后端对象，并明确不得让工具切换重挂 `ChatArea`、SSE、草稿或 Session（`MOBIUS_UI_SIMPLIFICATION_PLAN.md:519-520,527-536`）。

## 0. 结论（先写）

1. Mobius 默认桌面工作台应改成一张稳定主壳：左侧 Project / Session 导航、中心 Home 或 Session 工作层、按需 Tool Drawer、44px 级薄顶栏和贴底 Composer；CodexMonitor 已把这些区域做成独立节点注入同一 `DesktopLayout`（`examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:57-82,142-244`）。
2. 左栏的 Header、内联搜索、Project 分组、Session 行、底部账户/设置应按 `1:1 复用结构`；只把 Workspace 改称 Project、Thread 改称 Session，并沿用 Mobius 已有轮询、状态和短路由数据（`examples/CodexMonitor/src/features/app/components/Sidebar.tsx:866-894,912-1049`；`mobius/frontend/src/components/conversation-rail.tsx:144-205,234-246`）。
3. Home 继续是 `/u/:user`，但内容必须是 Mobius 的“大 Composer + Project 上下文”，不能复制 CodexMonitor 的 Usage、Credits 或 Agent 运行仪表盘（`mobius/frontend/src/pages/UserPage.tsx:397-471`；`examples/CodexMonitor/src/features/home/components/Home.tsx:55-84`）。
4. Session 中心区应 `1:1` 复用 Chat / Diff 两层和可选 split 的结构；点 Files / Diff 只切中心层，不创建新路由，也不创建第二个 Chat（`examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:162-219`；`mobius/frontend/src/pages/IssuePage.tsx:286-304`）。
5. 贴底 Composer 的位置、最大内容宽度和“消息区为其动态留底”应 `1:1` 复用；内部继续使用 Mobius 的附件、`@`、Send、独立 Stop、草稿和发送协议（`examples/CodexMonitor/src/features/layout/components/ChatPane.tsx:13-55`；`mobius/frontend/src/components/chat.tsx:3065-3147,4581-4691,4872-4918`）。
6. CodexMonitor 右栏的位置和折叠机制应复用，但语义改为 Mobius Tool Drawer：Files、Diff、Terminal、Skill / Memory 快照、只读 Git 状态；没有活动工具时折叠，不能常驻 Git + Plan（`examples/CodexMonitor/src/styles/main.css:1031-1158`；`mobius/frontend/src/components/advanced-session-actions.tsx:80-249`）。
7. Workspace MainTopbar 的 44px 槽位应复用，但内容换成 `Project › Session`、状态、工具开关、独立 Stop 和返回对话；Branch、Worktree、Launch Script 不是默认 Mobius 顶栏语义（`examples/CodexMonitor/src/features/app/components/MainHeader.tsx:187-208,479-573`；`mobius/frontend/src/components/chat.tsx:4247-4340`）。
8. Composer MetaBar 只显示“当前模型摘要 + 当前 Project 上下文”；模型变更进入“创建新 Session 并继续”，Harness 选择不得成为首屏常驻控件（`examples/CodexMonitor/src/features/composer/components/ComposerMetaBar.tsx:144-200,242-296`；`mobius/frontend/src/components/chat.tsx:3992-4003,5064-5077`）。
9. Settings 继续是覆盖当前上下文的 master-detail overlay，并把入口从全局厚 TopNav 收到底部左栏；关闭后必须回到原触发控件（`examples/CodexMonitor/src/features/app/components/SidebarBottomRail.tsx:166-177`；`mobius/frontend/src/components/settings-panel.tsx:33-69,85-134`）。
10. 绝对不复用 CodexMonitor 的 worktree / clone daemon、Usage / Credits、stage / commit / push / PR、Send / Stop 合并、Queue / Steer 或常驻 IDE；Mobius 只借壳呈现已有能力，不改变执行模型（`examples/CodexMonitor/src/features/app/components/SidebarWorkspaceGroups.tsx:219-265`；`examples/CodexMonitor/src/features/git/components/GitDiffPanel.tsx:102-146`；`examples/CodexMonitor/src/features/composer/components/ComposerInput.tsx:160-166,325-352`）。

## 1. CodexMonitor 主壳拆解

### 1.1 稳定槽位

| 稳定槽位 | 职责 | 出现 / 消失条件 | 默认尺寸 | 内部主动作 | 源码证据 |
| --- | --- | --- | --- | --- | --- |
| Sidebar header | 主壳的全局起点，承载新增 Workspace、回 Home、排序、刷新、搜索 | Sidebar 展开时常驻；Sidebar 可独立持久化折叠 | Sidebar 默认 280px；Header 最小高 32px；新增按钮 30×30px | 新建 Workspace、回 Projects Home、切组织方式、刷新、开搜索 | `examples/CodexMonitor/src/styles/base.css:48-58,209-234`；`examples/CodexMonitor/src/styles/sidebar.css:97-205`；`examples/CodexMonitor/src/features/app/components/SidebarHeader.tsx:124-269` |
| Sidebar search | 在导航原位过滤 Workspace / Thread，不夺走整个主区 | 点搜索才展开；关闭时查询被清空 | 输入宽 100%，13px 字号，水平内边距 14/32px；占自身内容高 | 输入、清空；自动聚焦 | `examples/CodexMonitor/src/features/app/components/SidebarSearchBar.tsx:16-40`；`examples/CodexMonitor/src/features/app/components/Sidebar.tsx:220-266,860-894`；`examples/CodexMonitor/src/styles/sidebar.css:336-379` |
| Workspace / Thread 列表 | Workspace 卡内显示 Thread；也可切成纯 Thread 时间桶视图 | 有 Workspace 时显示；搜索时只保留匹配 Workspace / Thread；无数据显示空态 | 列表纵向间距 14px；Thread 行 12px 字号、约 38px 自然高、14px 圆角 | 选 Workspace、选 Thread、折叠、按项目新建 Thread；行支持 Enter / Space | `examples/CodexMonitor/src/features/app/components/SidebarWorkspaceGroups.tsx:148-218,352-412`；`examples/CodexMonitor/src/features/app/components/SidebarThreadsOnlySection.tsx:58-121`；`examples/CodexMonitor/src/features/app/components/ThreadRow.tsx:143-226`；`examples/CodexMonitor/src/styles/sidebar.css:513-518,1029-1157` |
| Sidebar bottom | 把账户、设置和低频全局动作固定在左栏底部 | Sidebar 展开时常驻；Usage 数据可有空值，但槽位仍在 | 顶部分隔，10px 上内边距；标注按钮高 34px | 账户切换、Settings、Debug | `examples/CodexMonitor/src/features/app/components/SidebarBottomRail.tsx:88-190`；`examples/CodexMonitor/src/styles/sidebar.css:1650-1658,1747-1783` |
| Home | 没有 active Workspace 时填满整个 Main，展示产品入口与跨项目概览 | `showHome` 为真，即 `!activeWorkspace` | Desktop 内容最大宽 720px；外边距 32px；顶部 36px；标题 44px | 选最近 Agent、加 Workspace、查看 Usage | `examples/CodexMonitor/src/features/app/components/MainApp.tsx:1041-1059`；`examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:153-158`；`examples/CodexMonitor/src/features/home/components/Home.tsx:55-84`；`examples/CodexMonitor/src/styles/home.css:1-46` |
| Workspace MainTopbar | Workspace 工作层唯一的横向 chrome；左边对象上下文，右边动作 | 只在 `showWorkspace` 时出现；Home 不渲染此节点 | CSS 变量高 44px；水平 24px，垂直 10/12px | Workspace / branch 上下文、Terminal、Copy、其他 Workspace 工具 | `examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:158-162`；`examples/CodexMonitor/src/features/app/components/MainTopbar.tsx:9-16`；`examples/CodexMonitor/src/features/app/components/MainHeader.tsx:187-208,479-573`；`examples/CodexMonitor/src/styles/main.css:355-370` |
| Chat layer | 保持消息树与 Composer 的主工作层 | Workspace 激活且中心模式为 `chat`；split 时与 Diff 同时显示 | 中心列占 `1fr`；正文 / Composer 内容列最大 900px | 阅读消息、输入、附件、发送 | `examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:162-218`；`examples/CodexMonitor/src/styles/main.css:1-13,907-981`；`examples/CodexMonitor/src/styles/messages.css:1-24` |
| Diff layer | 在同一中心位置查看选中文件或 commit diff | 选 diff、预加载或 split 开启时挂载；非活动层 hidden + inert | 单层占完整中心；split 默认按 50% 变量分隔，手柄命中宽 8px | 选文件后定位 Diff；Back to chat；可选拖动 split | `examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:7-17,121-140,162-219`；`examples/CodexMonitor/src/styles/main.css:953-1025`；`examples/CodexMonitor/src/features/app/hooks/useGitPanelController.ts:209-312` |
| Composer | 贴底覆盖消息区，集中输入、附件、提示、模型与上下文摘要 | 有活跃 Workspace / Thread 且允许输入时出现；Review 时可 disabled | 内容最大宽 900px；外层 `10px 24px 20px`；附件按钮 28px | 输入、附件、自动补全、发送 / Stop、MetaBar | `examples/CodexMonitor/src/features/composer/components/Composer.tsx:577-697`；`examples/CodexMonitor/src/features/composer/components/ComposerInput.tsx:229-352`；`examples/CodexMonitor/src/styles/composer.css:1-18,143-207` |
| Right Git / Files | 同一右栏顶区按 tab / mode 切换 Git、Files、Prompts，并驱动中心 Diff | Workspace 激活时有结构；右栏可独立持久化折叠；Files 与 Git 由 `filePanelMode` 切换 | 默认宽 230px；贯穿 Main 全高；左侧 8px resize 命中区 | 切 Files / Git 模式、选文件、预览、把路径 / 选区加入 Chat、驱动中心 Diff | `examples/CodexMonitor/src/styles/main.css:1-13,1031-1071,1121-1158`；`examples/CodexMonitor/src/features/git/components/GitDiffPanel.tsx:640-791`；`examples/CodexMonitor/src/features/files/components/FileTreePanel.tsx:522-550,583-654`；`examples/CodexMonitor/src/features/app/hooks/useMainAppLayoutSurfaces.ts:689-710,837-868` |
| Plan | 右栏下半部显示当前 Thread 的结构化计划，不与 Git 顶区混成一个组件 | 只有 active plan 有步骤或解释时展开，否则 `plan-collapsed` | 默认高 220px，最小 140px，最大 420px；分隔手柄 8px | 看进度；拖动高度 | `examples/CodexMonitor/src/features/app/components/MainApp.tsx:1090-1095`；`examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:228-239`；`examples/CodexMonitor/src/features/plan/components/PlanPanel.tsx:27-57`；`examples/CodexMonitor/src/styles/main.css:1073-1119` |
| Terminal dock | 中心列下方独立底坞，不占右栏；支持多个 Terminal tab | 默认为关；只有 active Workspace 才能开；关闭时组件返回 `null` | 默认高 220px；顶部 resize 命中区 6px | 开 / 关、切 tab、新建 terminal、拖高 | `examples/CodexMonitor/src/features/layout/hooks/usePanelVisibility.ts:16-42`；`examples/CodexMonitor/src/features/terminal/components/TerminalDock.tsx:15-80`；`examples/CodexMonitor/src/styles/terminal.css:1-18,39-55` |
| Settings overlay | 保持底层工作台不换路由，用 master-detail 覆盖层管理全局设置 | 左栏底部 Settings 打开；Esc、背景或 X 关闭 | `min(980px,94vw)` × `min(680px,88vh)`；左栏 200px | 切分类、编辑、关闭；移动端 master-detail 返回 | `examples/CodexMonitor/src/features/app/components/SidebarBottomRail.tsx:166-177`；`examples/CodexMonitor/src/features/settings/components/SettingsView.tsx:141-190`；`examples/CodexMonitor/src/styles/settings.css:1-15,41-90,1252-1301` |

两个实现细节是壳的一部分，不能只抄外观。第一，Chat / Diff 非活动层会被设为 `inert`，若焦点还在隐藏层会先失焦，避免键盘落入不可见内容（`examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:40-55,121-140`）。第二，Composer 高度不是常数：`ChatPane` 用 `ResizeObserver` 测量真实高度并写入 `--composer-overlay-height`，消息区把该值加到底部 padding，因而附件、队列或多行输入增高时仍不会盖住最后一条消息（`examples/CodexMonitor/src/features/layout/components/ChatPane.tsx:13-46`；`examples/CodexMonitor/src/styles/messages.css:9-24`）。

Desktop / Tablet / Phone 的产品断点是 1100px 和 520px；CSS 在 960px 下把桌面两列降成单列并隐藏 Sidebar resizer，因此本规格的“左 + 中 + 右”只定义 Desktop，窄屏必须转成 drawer / tab，而不是硬挤三列（`examples/CodexMonitor/src/features/layout/hooks/useLayoutMode.ts:5-20,52-59`；`examples/CodexMonitor/src/styles/base.css:237-255`）。

### 1.2 更细的主壳与交互热区

```text
┌────────────────────── 280px Sidebar ──────────────────────┬────────────── Main: 1fr ──────────────┬── 230px Right ──┐
│ [＋ Add Workspace] [Projects/Home] [排序][刷新][搜索]      │ [Workspace › branch]   [Terminal][…] │ [Git|Files|…]   │
│                     ↑新建/回 Home/开搜索                  │          44px MainTopbar             │  ↑切工具模式    │
│ [Search conversations____________________×]               ├───────────────────────────────────────┤                 │
│  ↑输入后原位过滤；关闭即清空                              │ [Chat layer] ⇄ [Diff layer]           │ 选文件 ───────┐ │
│                                                        │ │  ↑选会话默认回 Chat   ↑切 Diff/Back │              │ │
│ [Workspace A]  ← 选项目 / 折叠                           │ │                                       │              │ │
│   ● Thread 1                         2m ← 选会话          │ │             messages                  │              │ │
│   ● Thread 2                        now                   │ │                                       │              │ │
│ [Workspace B]                                           │ │                                       │              │ │
│   ＋ New thread in project                              │ │                                       │              │ │
│                                                        │ │ ┌──── Composer（真实高度动态测量）──┐ │              │ │
│ ────────────────────────────────────────────────────── │ │ │[附件] Ask…              [Send/Stop]│ │              │ │
│ Usage / Credits（Mobius 不复用）                         │ │ │Meta: model / context               │ │              │ │
│ [Account] [Settings] ← 打开设置 overlay                  │ │ └────────────────────────────────────┘ │              │ │
│                                                        │ ├───────────────────────────────────────┤ ┌─ Plan ─────┐ │
│                                                        │ │ Terminal dock：tabs / ＋ / close      │ │ active only│ │
└────────────────────────────────────────────────────────┴───────────────────────────────────────┴─────────────┘

Settings overlay：覆盖整壳但不换路由；背景 / Esc / X 关闭，回原触发点。
```

选 Workspace 或 Thread 不只是换数据：CodexMonitor 会先退出 Diff、清 PR / draft 选择，再写入 active Workspace / Thread；这说明“选 Project / Session 后回 Chat”应属于导航契约，而不是各面板自己猜（`examples/CodexMonitor/src/features/app/hooks/useSidebarLayoutActions.ts:63-84,109-124`）。从 Home 的最近运行点 Thread 也执行同样的退出 Diff、清草稿、选 Workspace / Thread 流程（`examples/CodexMonitor/src/features/app/hooks/useMainAppLayoutSurfaces.ts:600-608`）。

## 2. Mobius 当前主界面拆解

| 当前区域 | 当前职责与显隐 | 当前尺寸 / 动作 | 源码证据 |
| --- | --- | --- | --- |
| TopNav | Home、Session、Issue 都各自常驻；承载 Logo、用户、Project crumb、全局 Search、新 Session、Settings、账户 | 固定 52px；`⌘/Ctrl+K` 搜索、`⌘/Ctrl+N` 新会话、`⌘/Ctrl+,` 设置 | `mobius/frontend/src/components/shell.tsx:732-785,794-820,824-889`；`mobius/frontend/src/index.css:208-225` |
| ConversationRail | 轮询最近 100 条 Session，按 Project 分组，展示状态和相对时间；1280px 以下改成覆盖 drawer | 固定 272px；头部是整宽“新会话”按钮 + 常驻搜索框；搜索已匹配 Project 名、Session 标题和 Session ID | `mobius/frontend/src/components/conversation-rail.tsx:144-205,243-337,340-347`；`mobius/frontend/src/index.css:208-211` |
| Home Composer | `/u/:user` 清空当前 Issue / Research / Session；加载 Project 后居中展示大输入框、Project select、发送和最近三个 Project | 主内容最大 880px；textarea 5 行；发送成功创建默认对象并跳 `/u/:user/s/:session`；阶段失败可原地重试 | `mobius/frontend/src/pages/UserPage.tsx:281-395,397-471`；默认导出只有 `?view=projects` 才切高级项目总览（`mobius/frontend/src/pages/UserPage.tsx:1372-1375`） |
| Session easy header | `ChatArea layout="easy"` 内再放一层状态、`Project › Session`、轮数摘要、Tools 和运行时 Stop | 固定 40px，位于 52px TopNav 下方 | `mobius/frontend/src/pages/WorkPage.tsx:88-113`；`mobius/frontend/src/components/chat.tsx:4247-4340` |
| 时间线 | `SessionJsonlPanel` 是 easy 模式中心主内容，SSE / REST 还原消息与 JSONL，Session 切换时重建数据订阅状态 | 占 `mobius-chat-body--easy` 剩余空间；支持加载全部、滚底和搜索命中定位 | `mobius/frontend/src/components/chat.tsx:3561-3660,3692-3740,4510-4543`；`mobius/frontend/src/index.css:6074-6084` |
| Session Composer | easy 模式绝对定位在主区底部中央，继续承载附件、`@`、项目选择、输入扩展、Send | 底部 16px；宽 `min(880px,100%-40px)`；textarea 最小 72px | `mobius/frontend/src/components/chat.tsx:4581-4691,4795-4918`；`mobius/frontend/src/index.css:6085-6114` |
| Tools 菜单 / Modal | easy header 的“工具”打开 336px、两列按钮网格；Files changes、Bash、回放、Terminal、Skill / Memory / Git 等再各自打开 Modal | Popover 从 header 右侧展开；高级动作共 3 组网格；文件改动和终端都不是稳定侧栏 | `mobius/frontend/src/components/chat.tsx:4291-4324,5036-5150`；`mobius/frontend/src/components/advanced-session-actions.tsx:72-249`；`mobius/frontend/src/index.css:6136-6179` |
| Settings | TopNav 打开覆盖层；已有桌面 master-detail、移动 master-detail、Esc、focus trap 和关闭恢复 | `min(960px,100vw-24px)` × `min(640px,100vh-24px)`；左导航 160px | `mobius/frontend/src/components/settings-panel.tsx:18-75,85-134` |
| Search | TopNav 打开全局内容搜索 Modal；450ms 防抖、最少 2 字，SSE 流式返回；先预览命中再进 Session | 最大宽 680px，顶距 8vh；结果携带 `match/ts` 跳短路由 | `mobius/frontend/src/components/search-modal.tsx:103-205,224-248,311-410` |
| 高级页 / overlay | Project、Issue、Research 是独立路由；Admin 是全屏 overlay；默认 Issue 导出是 Rail + Chat / 空 Composer，复杂编辑器仍在未默认导出的 `LegacyIssuePage` | 路由包含 `/u/:user`、`/s/:session`、`/p/:project`、Issue、Research；Admin 覆盖全屏 | `mobius/frontend/src/App.tsx:377-405`；`mobius/frontend/src/pages/IssuePage.tsx:156-270,273-304`；`mobius/frontend/src/components/shell.tsx:1662-1695` |

### 2.1 与 CodexMonitor 主壳不对齐之处

1. **双层横向 chrome。** Session 页面先渲染 52px `TopNav`，`ChatArea easy` 再渲染 40px session context，所以对话上方是 92px 两层；CodexMonitor Workspace 只有一个 44px MainTopbar，Home 则不渲染 Workspace topbar（`mobius/frontend/src/pages/WorkPage.tsx:88-107`；`mobius/frontend/src/components/chat.tsx:4247-4340`；`examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:153-162`）。
2. **工具是菜单网格，不是可保持上下文的 Tool Drawer。** 当前 15 类动作在 336px 两列 popover 里展开，点 Files / Terminal / Skill / Memory 后又打开不同 Modal；CodexMonitor 的 Right panel 是可折叠、可调宽、与中心 Diff 有明确联动的稳定槽位（`mobius/frontend/src/components/advanced-session-actions.tsx:72-249`；`examples/CodexMonitor/src/styles/main.css:1031-1158`）。
3. **Home 与 Session 是两个页面组件，不是同一 main 槽位切换。** `/u/:user` 的 `HomeSurface` 和 `/u/:user/s/:session` 的 `WorkPage` 各自重新搭 `TopNav + ConversationRail + main`；CodexMonitor 在一个 `DesktopLayout` 内用 `showHome/showWorkspace` 切换节点（`mobius/frontend/src/pages/UserPage.tsx:397-476`；`mobius/frontend/src/pages/WorkPage.tsx:88-113`；`examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:153-244`）。路由可以保留两条，但外壳不应随路由复制。
4. **右栏缺失，能力只能跳 Modal 或高级页。** 当前 Files changes、Terminal、Skill / Memory 都由 `chat.tsx` 的 boolean state 控制 Modal，Research Graph 则改 query / 进入高级页（`mobius/frontend/src/components/chat.tsx:2464-2477,4106-4140,5036-5150`）。结果是工具无法在 Session 旁保持选中对象，也没有统一的关闭回 Chat 语法。
5. **Composer 只“绝对定位”，未见动态占位契约。** easy Composer 的 CSS 固定在 bottom 16px，但对应消息区规则只写 `flex:1`；CodexMonitor 会实测 Composer 高度并把它加到消息底部 padding（`mobius/frontend/src/index.css:6074-6114`；`examples/CodexMonitor/src/features/layout/components/ChatPane.tsx:13-46`；`examples/CodexMonitor/src/styles/messages.css:9-24`）。下一轮必须把“最后一条消息不被增长后的 Composer 遮住”作为壳验收，而不是只调 bottom 值。
6. **导航选择没有统一清工具层。** Mobius Rail 选 Session 只关闭移动 drawer并 `navigate(path)`；CodexMonitor 选 Workspace / Thread 会先退出 Diff 与清选择（`mobius/frontend/src/components/conversation-rail.tsx:234-241`；`examples/CodexMonitor/src/features/app/hooks/useSidebarLayoutActions.ts:69-84,109-124`）。复用后应明确 Project / Session 选择总是回中心 Chat，避免旧 Diff 泄漏到新 Session。

## 3. 槽位复用映射表（本文核心）

复用级别只描述壳，不描述业务代码复制。证据表明 Mobius 已有 Project 分组、Session 短路由、easy Chat、附件、Tools、Settings 和高级页，缺的是把它们装入同一稳定槽位，而不是重造能力（`mobius/frontend/src/components/conversation-rail.tsx:170-241`；`mobius/frontend/src/components/chat.tsx:4106-4140`；`mobius/frontend/src/App.tsx:392-405`）。

| CodexMonitor 槽位 | Mobius 应对等槽位 | 复用级别 | Mobius 填入的能力 | 不能填入的东西 |
| --- | --- | --- | --- | --- |
| App 两列根网格 | 共享 `WorkbenchShell`：Project rail + Main | `1:1 复用结构` | Home / Session / 高级页返回后的默认壳 | Tutti Dock、Cursor Activity Bar、第二套导航树 |
| Sidebar 可调宽 / 可折叠 | ConversationRail 桌面态 | `1:1 复用结构` | 现有 recent Session 轮询、Project 分组、运行状态、相对时间 | Issue / Research 作为默认必经层；常驻系统监控 |
| Sidebar header | Project header | `复用位置但换语义` | `＋ Project`、回 Home、分组 / 排序、刷新、内联搜索开关 | Add Workspace from URL、daemon 连接状态、worktree / clone agent |
| Sidebar search | Project / Session 标题与 Session ID 内联过滤 | `1:1 复用结构` | 复用当前 Rail 的 Project 名、Session 标题、Session ID 匹配 | 消息全文搜索结果；全文搜索仍进 `SearchModal` |
| Workspace group | Project group | `复用位置但换语义` | Project 名、Session 数、running 数、折叠状态 | Branch、worktree、clone 层级 |
| Thread row | Session row | `复用位置但换语义` | Session 标题、状态点、相对时间、active 态、键盘打开 | Codex args badge、sub-agent 树作为默认行层级 |
| Threads-only time buckets | “最近会话”视图 | `1:1 复用结构` | Now / Today / Yesterday / This week / Older 的 Session 时间桶 | 再造一个与 Project 分组并列的数据源 |
| Sidebar bottom | 账户 / Settings / 全局低频入口 | `复用位置但换语义` | 账户、Settings；必要时一个 Help | Usage、Credits、Debug log 常驻首屏 |
| Home main slot | `/u/:user` Composer 空态 | `复用位置但换语义` | “想让 Mobius 做什么”、大 Composer、Project 上下文、最近 Project | CodexMonitor Home 的 Usage、Credits、Agent 仪表盘；工具抽屉 |
| Workspace MainTopbar | Project / Session thin topbar | `复用位置但换语义` | 状态、`Project › Session`、Tool Drawer toggle、独立 Stop、Diff 时 Back to chat | Branch checkout、worktree rename、launch scripts、密集全局导航 |
| Chat layer | Session 时间线 + 单一 `ChatArea easy` | `1:1 复用结构` | JSONL / 消息、权限卡、运行状态、错误、原地重试 | 第二个 Chat、重写 SSE / 消息协议、常驻编辑器 |
| Diff layer | Session 中心 Files / Diff viewer | `1:1 复用结构` | 当前 Session 文件修改、只读 Diff、文件内容 fallback；与 Chat 原位切层 / 可选 split | 新路由、stage / unstage / revert、commit / push / PR review |
| ChatPane overlay contract | Mobius messages + Composer 容器 | `1:1 复用结构` | 测量 Composer 实际高度、给时间线动态底部留白、隐藏层 inert / focus 移交 | 复制 CodexMonitor 消息 renderer 或替换 Mobius草稿状态 |
| Composer input | Mobius easy Composer | `1:1 复用结构` | 贴底大输入、附件芯片、`@` 引用、输入扩展、Send | Send / Stop 合并；Queue / Steer；改写 IME / 上传 / 发送协议 |
| Composer MetaBar | 当前模型摘要 + Project 上下文 | `复用位置但换语义` | 只读模型标签、Project、必要时“修改模型并继续”入口 | Harness 首屏选择、Plan toggle、access mode、reasoning / args 全套常驻选择器 |
| Right panel top | 按需 Tool Drawer | `复用位置但换语义` | Files、Diff、Terminal、Skill、Memory、只读 Git 状态的 tab；折叠是一等状态 | 默认常驻 Git + Plan；Git 写操作；把高级管理页完整嵌进来 |
| Right panel Plan bottom | 无默认对等槽位 | `不复用` | 若将来有 Mobius 原生、当前 Session 的结构化计划，只能数据存在时临时出现 | 用空 Plan 占位；把 Issue / Research 当 Plan；复制 Codex 计划协议 |
| Terminal dock | Tool Drawer 的 Terminal tab；需要长输出时可展开底坞 | `复用位置但换语义` | 当前项目目录 / Agent 后台两种现有终端语义、tab、关闭与 resize | 自动运行命令、改变终端权限、默认占满底部 |
| Settings overlay | Mobius Settings overlay | `1:1 复用结构` | 通用、项目与上下文、连接与客户端、高级、Admin 入口；focus trap / restore | 独立全屏设置路由；把 Settings 填进右工具栏 |
| GitDiffPanel mode switch | Tool Drawer 的对象型 tab / mode 头 | `复用位置但换语义` | Files / Diff / Git status 的只读模式切换和空 / 错状态 | stage、commit、pull、push、sync、Issues / PRs 写工作流 |
| FileTree preview / Add to chat | Files 工具中的预览、引用 | `1:1 复用结构` | 选文件预览、选行、插入当前 Composer、Esc 返回文件树 | 直接复制 Tauri 文件权限或暴露无权限绝对路径 |

这里的关键不是名称替换，而是对象对应：CodexMonitor 的 Workspace 对应 Mobius Project，Thread 对应 Session；Mobius 的 Issue / Research 仍由后端创建并保留，但不插进左栏默认层级。Mobius 已能由 Session ID 反查并还原 Project、Issue / Research 上下文（`mobius/frontend/src/pages/WorkPage.tsx:29-77`），因此左栏不需要为了数据模型完整而再增加两级。

右栏采用“空则折叠、点工具则展开”的控制器。CodexMonitor 已把 Sidebar 与 Right panel 的 collapsed 状态分别持久化（`examples/CodexMonitor/src/features/layout/hooks/useSidebarToggles.tsx:3-37,39-70`）；Mobius 可复用这种状态模型，但不能复用其默认内容。点击右栏文件后，选中对象应驱动中心 `centerMode='diff'`；CodexMonitor 的 file / commit / per-file 选择都是这样集中控制，Back to chat 同时清选中文件（`examples/CodexMonitor/src/features/app/hooks/useGitPanelController.ts:209-289`；`examples/CodexMonitor/src/features/app/hooks/useMainAppLayoutSurfaces.ts:647-653`）。

## 4. 操作跳转对照（比 07 更贴主壳）

以下每条都以“同一主壳不卸载”为前提；路由只表达可刷新对象，Tool Drawer 和中心 Chat / Diff 切层属于 UI state。

### 4.1 新用户创建项目并发送第一句话

- **入口控件：** 左栏 Header 的 `＋ Project`；零 Project 时 Main 直接显示“创建第一个项目”。当前 Mobius 已有项目名、本地目录和原地错误表单（`mobius/frontend/src/pages/UserPage.tsx:211-278`）。
- **当前 Mobius 落点：** 创建成功后留在 Home，自动选中新 Project并聚焦 Home Composer；发送会创建默认对象并跳短 Session 路由（`mobius/frontend/src/pages/UserPage.tsx:355-395`）。
- **CodexMonitor 落点：** Sidebar `＋` 新增 Workspace，Home 也提供 Add Workspace（`examples/CodexMonitor/src/features/app/components/SidebarHeader.tsx:124-149`；`examples/CodexMonitor/src/features/home/components/Home.tsx:67-70`）。
- **复用后的目标落点：** 项目创建在 Main slot 内完成；成功后左栏出现并选中 Project，Main 切回同一壳的 Home 大 Composer，Project Meta 已绑定。
- **焦点 / 返回 / 失败恢复：** 成功聚焦 Composer；取消回 Home；失败留在创建表单并保留项目名 / 路径，发送阶段失败保留 checkpoint 并显示“重试当前阶段”（`mobius/frontend/src/pages/UserPage.tsx:219-247,368-451`）。

### 4.2 从左侧继续昨天的会话

- **入口控件：** Project 分组内的 Session 行，或“最近会话”时间桶里的 Yesterday 行；CodexMonitor 已定义 Yesterday 等五桶和键盘激活（`examples/CodexMonitor/src/features/app/components/Sidebar.tsx:48-97`；`examples/CodexMonitor/src/features/app/components/ThreadRow.tsx:143-164`）。
- **当前 Mobius 落点：** Rail 构造 `/u/:user/s/:session` 并导航，WorkPage 再反查完整上下文（`mobius/frontend/src/components/conversation-rail.tsx:78-81,234-241`；`mobius/frontend/src/pages/WorkPage.tsx:29-77`）。
- **CodexMonitor 落点：** 先退出 Diff / 清 draft，再选 Workspace 与 Thread（`examples/CodexMonitor/src/features/app/hooks/useSidebarLayoutActions.ts:109-124`）。
- **复用后的目标落点：** 左栏 active 行更新；中心总是先回 Chat layer，再加载对应 Session；Drawer 可保留“折叠”状态，但不能保留旧 Session 的选中文件。
- **焦点 / 返回 / 失败恢复：** 加载完成聚焦时间线主标题或 Composer；浏览器 Back 回上一个路由对象；加载失败留在壳内、保留 Rail并提供“重试 / 回 Home”，不只剩当前单一“回到主页”（当前失败态见 `mobius/frontend/src/pages/WorkPage.tsx:98-109`）。

### 4.3 在 Project A 的会话中点“新会话”

- **入口控件：** Project A 标题旁 `＋`、该组底部 `New Session`，以及薄顶栏 `New Session`；CodexMonitor 的纯 Thread 模式会先让用户选 Project再新建（`examples/CodexMonitor/src/features/app/components/SidebarThreadsOnlySection.tsx:58-72,94-120`）。
- **当前 Mobius 落点：** WorkPage 跳 `/u/:user?project=A`，80ms 后派发事件聚焦 Home（`mobius/frontend/src/pages/WorkPage.tsx:80-84`）；TopNav 也继承当前 Project（`mobius/frontend/src/components/shell.tsx:775-785`）。
- **CodexMonitor 落点：** 选 Workspace 后 active Thread 置空，Main 进入该 Workspace 的新 Agent / Composer 状态（`examples/CodexMonitor/src/features/app/hooks/useSidebarLayoutActions.ts:69-84`）。
- **复用后的目标落点：** 不重搭壳；左栏保持 Project A 展开，active Session 清空，Main slot 切 Home Composer 空态并锁定 Project A。
- **焦点 / 返回 / 失败恢复：** 聚焦 Composer；Back 回原 Session；创建失败继续留在这个空态并保留草稿 / Project A，不产生半选中的 Session 行。

### 4.4 搜索会话标题 / Session ID

- **入口控件：** 左栏 Header 的搜索图标；全文内容仍由 `⌘/Ctrl+K` 打开 Search overlay。
- **当前 Mobius 落点：** Rail 搜索框常驻，已同时匹配 Project 名、Session 标题与 `session_id`（`mobius/frontend/src/components/conversation-rail.tsx:194-205,258-270`）；全局 Search 搜消息内容并先开片段预览（`mobius/frontend/src/components/search-modal.tsx:224-242,330-410`）。
- **CodexMonitor 落点：** 搜索只在左栏按需展开、自动聚焦，150ms 后过滤 Workspace / Thread（`examples/CodexMonitor/src/features/app/components/SidebarSearchBar.tsx:17-39`；`examples/CodexMonitor/src/features/app/components/Sidebar.tsx:264-323`）。
- **复用后的目标落点：** 标题 / ID 走左栏原位过滤，点击结果进 Session Chat；消息全文走现有 SearchModal，不把两种搜索塞成一套。
- **焦点 / 返回 / 失败恢复：** 打开聚焦左栏输入；Esc 关闭并回搜索图标；无结果在左栏显示，ID 查询失败保留原 query；全文跳转成功聚焦命中卡 / Composer，当前短路由已支持 `match/ts`（`mobius/frontend/src/components/search-modal.tsx:224-237`）。

### 4.5 打开设置再关闭

- **入口控件：** 左栏底部 Settings；保留 `⌘/Ctrl+,` 快捷键。
- **当前 Mobius 落点：** TopNav state 打开 Settings overlay；Settings 记录触发点、聚焦关闭按钮、Tab trap、Esc 关闭并恢复焦点（`mobius/frontend/src/components/shell.tsx:768-773,794-808,864-887`；`mobius/frontend/src/components/settings-panel.tsx:33-69`）。
- **CodexMonitor 落点：** Sidebar bottom 触发 Settings；`ModalShell` 支持背景、快捷键和 X 关闭（`examples/CodexMonitor/src/features/app/components/SidebarBottomRail.tsx:166-177`；`examples/CodexMonitor/src/features/settings/components/SettingsView.tsx:141-167`）。
- **复用后的目标落点：** 继续挂载现有 `SettingsPanel`，只迁入口和外壳尺寸 / chrome；底层 Session、Drawer、草稿不变。
- **焦点 / 返回 / 失败恢复：** 关闭回左栏 Settings 按钮；嵌套 Modal 先关最上层；保存失败停在当前 Settings section 的错误处，不关闭 overlay。

### 4.6 附加文件 / `@` 引用文件

- **入口控件：** Composer 纸夹用于上传；在 textarea 输入 `@` 打开文件 / Agent 选择 Drawer。
- **当前 Mobius 落点：** `+` 菜单里的“上传文件”触发 file picker；`@` 检测会打开 `RemoteFileMentionDrawer`，选择后替换触发片段并把焦点放回 textarea（`mobius/frontend/src/components/chat.tsx:3076-3147,4795-4844`）。
- **CodexMonitor 落点：** Composer 自身有 28px 附件按钮；FileTree 行既可预览，也可“Mention in chat”，选中代码行后可插入带路径 / 行号的片段（`examples/CodexMonitor/src/features/composer/components/ComposerInput.tsx:239-254`；`examples/CodexMonitor/src/features/files/components/FileTreePanel.tsx:522-550,583-644`）。
- **复用后的目标落点：** 纸夹升为 Composer 一级图标；`@` 继续打开选择层；若 Tool Drawer 已在 Files，行尾 `＋` 直接插回同一 Composer，不打开第二输入框。
- **焦点 / 返回 / 失败恢复：** 选择后回 textarea 原 caret；Esc 回 Composer；上传失败只标红对应附件芯片并保留草稿 / 其他附件，不能整段清空（现有附件错误状态见 `mobius/frontend/src/components/chat.tsx:262-317`）。

### 4.7 查看本次改动 / Diff，再回到对话

- **入口控件：** 薄顶栏 Tools → Diff，或 Tool Drawer 的变更文件行。
- **当前 Mobius 落点：** `查看文件修改` 打开 `SessionFileChangesModal`；内部左侧文件清单、右侧 diff / 文件内容，但整体是 Modal（`mobius/frontend/src/components/advanced-session-actions.tsx:81-90`；`mobius/frontend/src/components/chat.tsx:697-881,5036-5041`）。
- **CodexMonitor 落点：** 右栏选文件设置 `centerMode='diff'`、选中路径和 diff source；MainTopbar 显示 Back to chat并清 selected path（`examples/CodexMonitor/src/features/app/hooks/useGitPanelController.ts:209-223`；`examples/CodexMonitor/src/features/app/hooks/useMainAppLayoutSurfaces.ts:647-653`）。
- **复用后的目标落点：** Drawer 展开到 Files / Diff；中心 Chat layer hidden + inert，Diff layer显示当前文件；URL仍是原 Session。
- **焦点 / 返回 / 失败恢复：** 进入后聚焦 Diff 标题；Back / Esc 回 Chat并聚焦触发文件行或 Composer；diff 为空或读取失败在 Diff layer 原地显示，并保留文件选择与 Back。

### 4.8 打开终端，再关闭

- **入口控件：** Tool Drawer → Terminal；可提供“在底部展开”作为长输出模式。
- **当前 Mobius 落点：** 先开 420px 选择 Modal，选择当前目录或 Agent 后台，再开 `WebTerminalModal`（`mobius/frontend/src/components/chat.tsx:5080-5150`）。
- **CodexMonitor 落点：** MainHeader toggle 直接控制只在 Workspace 存在时可开的 220px Terminal dock；关闭时 dock 不渲染（`examples/CodexMonitor/src/features/app/components/MainHeader.tsx:542-555`；`examples/CodexMonitor/src/features/layout/hooks/usePanelVisibility.ts:26-42`；`examples/CodexMonitor/src/features/terminal/components/TerminalDock.tsx:25-30`）。
- **复用后的目标落点：** 首次进入 Terminal tab 时在 Drawer 内选择两种已有模式；选定后在 Drawer 内呈现，用户主动“展开”时转到底坞，同一 terminal state 不重建。
- **焦点 / 返回 / 失败恢复：** 打开聚焦 Terminal；关闭回 Tool toggle且 Chat / Composer不卸载；不可用时在 Terminal tab 显示原因和重试，不跳空 Modal。

### 4.9 查看 Skill / Memory 快照，再去管理页

- **入口控件：** Tool Drawer 的 Skill / Memory tab；tab 内“管理 Skills / Memory”。
- **当前 Mobius 落点：** easy 模式从工具菜单打开 `SessionSkillMemoryModal`；全量管理入口在 Settings 的“项目与上下文”（`mobius/frontend/src/components/chat.tsx:4230-4236`；`mobius/frontend/src/components/settings-panel.tsx:170-178`）。
- **CodexMonitor 落点：** 没有等价业务能力，只有右栏稳定工具位置可复用，所以这里只复用位置、不复用语义。
- **复用后的目标落点：** Drawer 显示“本 Session 当前快照”；管理动作打开 Settings 对应 section 或用户高级页，并携带 `returnTo=/u/:user/s/:session`。
- **焦点 / 返回 / 失败恢复：** 关闭快照回 tab；管理页 Back 回原 Session并恢复 Drawer tab / 折叠状态；快照加载失败留在 tab，可重试，不误显示全局默认值。

### 4.10 修改模型并继续（必须仍是新 Session）

- **入口控件：** Composer MetaBar 的模型摘要或 Tool Drawer 的“修改模型并继续”。
- **当前 Mobius 落点：** 高级动作打开 `NewSessionModal`，标题就是“修改模型并继续”；成功把新 Session 插入列表、更新 store并导航新短路由（`mobius/frontend/src/components/advanced-session-actions.tsx:185-193`；`mobius/frontend/src/components/chat.tsx:3992-4003,5064-5077`）。
- **CodexMonitor 落点：** MetaBar 可直接改变当前 Composer 的 model selection（`examples/CodexMonitor/src/features/composer/components/ComposerMetaBar.tsx:144-200`）；这个行为不能照搬。
- **复用后的目标落点：** MetaBar 只显示摘要；点击进入确认层，文案明确“从当前 Session 创建新 Session”；成功后左栏新增并选中新行，旧 Session 保留。
- **焦点 / 返回 / 失败恢复：** 取消回原 Composer；成功聚焦新 Session Composer；失败留在确认层并保留原 Session、草稿和模型选项。Harness 也遵守同一新 Session 语义，不能运行中热切。

### 4.11 进入 Project 详情 / Issue / Research Graph，再 Back

- **入口控件：** Project 标题的详情动作、Tool Drawer 的 Research Graph、Settings 的高级入口。
- **当前 Mobius 落点：** App 保留 Project / Issue / Research 独立路由；默认 Issue 是 Rail + easy Chat，旧编辑器多栏只在 `LegacyIssuePage`（`mobius/frontend/src/App.tsx:395-404`；`mobius/frontend/src/pages/IssuePage.tsx:156-304`）。当前 Research Graph 动作只给当前 search params 写 `view=graph`（`mobius/frontend/src/components/chat.tsx:4126-4134`），WorkPage 本身不消费这个 view（`mobius/frontend/src/pages/WorkPage.tsx:17-113`）。
- **CodexMonitor 落点：** Home / Workspace / Thread 都留在同一应用 state，没有 Mobius 这组独立领域页可直接对应。
- **复用后的目标落点：** 高级页仍走原路由，并显式携带经过校验的 `returnTo`；Research Graph 必须去真实 Research 路由，不把 Graph 复制进 WorkPage。默认主壳可暂时退出，但高级页 chrome 显示“Back to Session / Project”。
- **焦点 / 返回 / 失败恢复：** Back 优先回 `returnTo`，深链无来源时回 Project；恢复原 Session并聚焦离开前动作；对象无权限 / 不存在时留在高级页错误态，Back 仍可用。

### 4.12 运行中停止，失败后原地重试

- **入口控件：** 薄顶栏独立 Stop；失败横幅的 Retry / Details；Send 始终只 Send。
- **当前 Mobius 落点：** easy header 只在 pending / working / stop feedback 时显示独立 Stop；Stop 乐观更新状态并调用原 `/stop` API，失败写回就地错误（`mobius/frontend/src/components/chat.tsx:4052-4094,4142-4144,4327-4338`）。Send 源码明确禁止随运行态变成 Stop（`mobius/frontend/src/components/chat.tsx:4872-4918`）；状态 chip 区分断开、失败、启动、执行、待命、结束（`mobius/frontend/src/components/session-status-chip.tsx:22-57`）。
- **CodexMonitor 落点：** Composer 把同一 action button在 Send / Stop 之间切换，并在运行时改成 Queue / Steer（`examples/CodexMonitor/src/features/composer/components/Composer.tsx:257-273`；`examples/CodexMonitor/src/features/composer/components/ComposerInput.tsx:160-166,325-352`）。
- **复用后的目标落点：** 只复用 Stop 的几何位置和运行反馈，不复用合并语义；失败横幅位于 topbar 下 / 时间线上方，Retry 在原 Session调用既有安全重试，Details 打开 Tool Drawer 日志 / 命令 tab。
- **焦点 / 返回 / 失败恢复：** Stop 后焦点回 Composer；Stop 失败不恢复成“仍在运行”的假象而应重新查询权威状态；Retry 失败保留用户原输入，且不能重复插入用户消息。现有发送错误条可关闭但尚无统一 Retry（`mobius/frontend/src/components/chat.tsx:4470-4508`），这是下一轮需要补的 UI 契约，不是协议重写。

## 5. “尽可能复用”的目标主界面规格

### 5.1 Home 目标骨架

```text
┌──────────────────── 280px Project / Session Sidebar ────────────────────┬──────────────── Main slot ─────────────────────────────┐
│ [＋ Project] [Mobius/Home]                 [排序][刷新][搜索]            │ [薄全局条：Home]                         [账户/窗口动作] │
│ [按需 Search Project / Session / ID__________________×]                 ├──────────────────────────────────────────────────────────┤
│                                                                        │                                                          │
│ Project A                                                              │                    想让 Mobius 做什么？                  │
│   ● Session yesterday                                                  │              ┌──────────────────────────────┐              │
│   ● Session running                                                    │              │ 描述任务……                  │              │
│ Project B                                                              │              │                              │              │
│                                                                        │              ├──────────────────────────────┤              │
│                                                                        │              │ Project A      model 摘要 [发送]│              │
│                                                                        │              └──────────────────────────────┘              │
│                                                                        │                    最近 Project（弱入口）                 │
│ ────────────────────────────────────────────────────────────────────── │                                                          │
│ [账户] [Settings]                                                      │         无 Tool Drawer、无 Usage、无第二套 Home 导航         │
└────────────────────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘
```

Home 与 CodexMonitor 主壳的差别只应在内容语义：仍由左栏 + Main slot 组成，但 Main 应比 CodexMonitor Home 更像“大 Composer”。Mobius 当前 Home 已有 880px Composer、Project 选择、创建后短路由和阶段重试，可保留这些能力（`mobius/frontend/src/pages/UserPage.tsx:368-471`）；CodexMonitor Home 的 Latest Agents / Add Workspace / Usage 三段不能整体移植（`examples/CodexMonitor/src/features/home/components/Home.tsx:62-84`）。Home 没有 active Session，因此 Tool Drawer 和 Session MainTopbar 都不出现；Web / Desktop 所需账户和窗口动作只占薄全局条，不再叠一层 52px 导航。

### 5.2 Session 目标骨架

```text
┌──────────────────── 280px Project / Session Sidebar ────────────────────┬──────────────────── Center 1fr ────────────────────┬── 230px Tool Drawer ──┐
│ [＋ Project] [Mobius/Home]                 [排序][刷新][搜索]            │ [状态] Project A › Session X  [Tools][Stop]       │ [Files|Diff|Term|…]   │
│ [按需 Search____________________________________________×]             │                 44px 单一 MainTopbar             │ [折叠 ×]              │
│ Project A（active）                                                     ├───────────────────────────────────────────────────┤                       │
│   ● Session X  running                                      now         │ [CHAT layer]                [DIFF layer hidden]  │ files / git status    │
│   ● Session Y  done                                           1h         │                                                   │ skill / memory snapshot│
│   ＋ New Session in Project A                                            │                  单一时间线                       │ terminal compact view │
│ Project B                                                              │                                                   │                       │
│                                                                        │                                                   │ 选文件→中心 DIFF      │
│                                                                        │     ┌──── Composer（动态测高，消息动态让底）────┐ │                       │
│                                                                        │     │ [附件] 输入 / @引用              [Send]  │ │                       │
│                                                                        │     │ model 摘要 · Project context             │ │                       │
│ ────────────────────────────────────────────────────────────────────── │     └────────────────────────────────────────┘ │                       │
│ [账户] [Settings]                                                      ├──────────────── Terminal dock（按需展开）────────┤                       │
└────────────────────────────────────────────────────────────────────────┴───────────────────────────────────────────────────┴───────────────────────┘

折叠态：右侧 230px 列宽归零，中心扩展；Tools toggle 保留 active-tool 提示。
Diff 态：同一路由内 Chat hidden+inert，Topbar 的第一动作变为 “Back to chat”。
```

目标尺寸优先复用 CodexMonitor 的壳实值：Sidebar 默认 280px、MainTopbar 44px、Right panel 默认 230px、对话内容 900px、Terminal dock 220px（`examples/CodexMonitor/src/styles/base.css:48-58`；`examples/CodexMonitor/src/styles/main.css:1-13,1096-1103`；`examples/CodexMonitor/src/styles/terminal.css:1-15`）。这不是像素级皮肤要求；颜色、字体和 Mobius 状态语义继续来自 Mobius token。Desktop 下 Tool Drawer 首次进入 Session 时若无活动工具保持折叠；点击工具、对象深链或失败 Details 时展开；用户主动折叠后必须是完整、可持久化、可键盘恢复的一等状态。

### 5.3 组件落点

**继续使用现有 Mobius 组件：**

- `ConversationRail` 继续拥有 `/api/tasks/recent` 轮询、Project 分组、Session 状态、ID 匹配和 canonical 短路由；只重排 DOM 成 CodexMonitor 的 Header / Search / Body / Bottom 四槽（`mobius/frontend/src/components/conversation-rail.tsx:144-205,234-337`）。
- `ChatArea layout="easy"` 继续是唯一 Chat 实例，保留消息 / JSONL、SSE、草稿、附件、`@`、权限、Stop、Send、错误和模型继续逻辑（`mobius/frontend/src/components/chat.tsx:2186-2209,3561-3660,4510-4918`）。
- `SettingsPanel` 继续承担设置内容、focus trap、移动 master-detail和高级页分发；只迁移入口与外壳尺度（`mobius/frontend/src/components/settings-panel.tsx:33-75,77-225`）。
- `SearchModal` 继续承担消息全文搜索、命中预览和跳转，不拿它替代左栏标题 / ID 过滤（`mobius/frontend/src/components/search-modal.tsx:103-205,224-248`）。

**改造成 CodexMonitor 槽位：**

- `shell.tsx` 的 52px `TopNav` 改为共享主壳控制器：全局动作分流到 Sidebar bottom或薄全局条；Session 的 easy header 合并进唯一 44px Workspace topbar，消除 52+40 双层（`mobius/frontend/src/components/shell.tsx:816-889`；`mobius/frontend/src/components/chat.tsx:4247-4340`）。
- `UserPage` 与 `WorkPage` 不再各自复制 `TopNav + ConversationRail`，只向同一 Main slot 注入 Home / Session surface；路由保持现状以支持刷新和深链（`mobius/frontend/src/pages/UserPage.tsx:397-476`；`mobius/frontend/src/pages/WorkPage.tsx:88-113`；`mobius/frontend/src/App.tsx:395-404`）。
- `advanced-session-actions.tsx` 从两列菜单网格改成 Tool Drawer tab 配置；每个 tab继续调用现有 Files / Terminal / Skill / Memory / Git 内容和状态，不能复制业务状态（`mobius/frontend/src/components/advanced-session-actions.tsx:72-249`）。
- `SessionFileChangesModal` 的“文件清单 / diff viewer”拆成 Drawer list + center Diff layer 的表面适配器；选择、错误、fallback 内容沿用现有接口（`mobius/frontend/src/components/chat.tsx:697-881`）。
- easy Composer 增加 `ChatPane` 等价的测高 / 底部避让层；不能通过写死更大 padding 掩盖附件、错误或大输入导致的高度变化（`examples/CodexMonitor/src/features/layout/components/ChatPane.tsx:13-55`；`mobius/frontend/src/index.css:6085-6114`）。

**不要新建：**

- 不要新建第二套 Chat / Message / Composer；`ChatArea` 的 sibling index 和实例稳定性是既有硬约束（`mobius/frontend/src/pages/IssuePage.tsx:286-304`）。
- 不要新建常驻 IDE 四栏、Cursor activity bar、第二个文件编辑器或默认 Terminal；高级编辑器继续按需挂载。
- 不要新建 Usage / Credits 仪表盘，也不要为了视觉相似复制 CodexMonitor 的 Home cards。
- 不要新建 Git 写入工作流；Mobius Drawer 只读地呈现 Session 改动和仓库状态。

## 6. 能力如何被看见

默认主路径只让用户先看见 **Project + Session + Composer**。其余能力分三层：当前对象相关的放 **右栏工具**，全局偏好和分发放 **Settings**，复杂对象管理放 **高级页**。Mobius 当前 Settings 已有“项目与上下文 / 连接与客户端 / 高级 / Admin”分组，现有工具也已区分 Session 与 Project 条件，足以承载这三层而不删能力（`mobius/frontend/src/components/settings-panel.tsx:77-83,170-214`；`mobius/frontend/src/components/advanced-session-actions.tsx:64-70`）。

| 能力 | 用户在主界面第一次看见它的时机 | 第一层落点 | 再深入的位置 | 证据 / 约束 |
| --- | --- | --- | --- | --- |
| Project | 首次进入 Home；左栏 Header 与 Home Composer 都可选 / 新建 | 左栏 + Home Composer Meta | Project 详情高级页 | 当前 Home 已自动选 Project并支持创建首 Project（`mobius/frontend/src/pages/UserPage.tsx:211-278,333-360`） |
| Session | Project 下已有历史，或第一句话创建成功 | 左栏 Session 行 | `/u/:user/s/:session` | Rail 已有 active、状态、相对时间和短路由（`mobius/frontend/src/components/conversation-rail.tsx:307-325`） |
| Composer | Home 首屏；Session 底部 | Main / Chat 的贴底 Composer | 大输入 overlay仍是同一草稿 | Home 发送与 Session 发送已有两套入口语义（`mobius/frontend/src/pages/UserPage.tsx:413-451`；`mobius/frontend/src/components/chat.tsx:4581-4918`） |
| 状态 / Stop / Retry | Session 运行、等待或失败时 | 单一 MainTopbar + 就地错误条 | Details 打开右栏相关 tab | 状态 chip和独立 Stop 已存在（`mobius/frontend/src/components/session-status-chip.tsx:22-57`；`mobius/frontend/src/components/chat.tsx:4327-4338`） |
| 附件 / `@` | 聚焦 Composer 后 | Composer 纸夹 / textarea 自动补全 | Files Drawer 可“加入对话” | 当前上传和 `@` 已有独立状态（`mobius/frontend/src/components/chat.tsx:2968-3068,3108-3147`） |
| Files | 用户打开 Tools 或在消息点文件 | 右栏 Files tab | 中心文件预览 / 高级编辑器 | 当前 File changes 已是 Session 级能力（`mobius/frontend/src/components/advanced-session-actions.tsx:81-90`） |
| Diff / 本次改动 | 用户点“本次改动”或某变更文件 | 右栏文件清单 + 中心 Diff layer | Project 高级页只读历史 | 当前 Modal 已提供 Session 文件清单 + Git diff fallback（`mobius/frontend/src/components/chat.tsx:697-881`） |
| Git 状态 | 打开 Tools → Git | 右栏只读 Git tab | Project 详情 / 外部 Git 客户端 | 当前动作已要求同时有 Session 和 Project（`mobius/frontend/src/components/advanced-session-actions.tsx:232-245`） |
| Terminal | 打开 Tools → Terminal | 右栏 Terminal tab | 用户主动展开底坞 | 当前有 cwd / Agent 两模式（`mobius/frontend/src/components/chat.tsx:5106-5138`） |
| Skill / Memory 快照 | 打开 Tools → Skill / Memory | 右栏当前 Session 快照 | Settings / 用户高级管理 | 当前 easy 模式已打开 Session 快照，Settings 已有管理入口（`mobius/frontend/src/components/chat.tsx:4230-4236`；`mobius/frontend/src/components/settings-panel.tsx:170-178`） |
| 模型 | Home / Session Composer MetaBar 的只读摘要 | Composer MetaBar | “修改模型并继续”确认层，新 Session | 当前已计算真实模型标签，成功后导航新 Session（`mobius/frontend/src/components/chat.tsx:2526-2534,3992-4003`） |
| Harness | 用户主动进入新 Session / 高级创建设置时 | 不在默认主壳常驻 | 新 Session 确认层或 Settings | 保留后端选择语义，不做当前 Session 热切（`MOBIUS_UI_SIMPLIFICATION_PLAN.md:5-7,519-520`） |
| Issue | Session 需要查看任务详情时 | 顶栏 / Tools 的“查看任务”弱入口 | Issue 高级页 | 默认 Issue 已被收敛，Legacy 仍保留（`mobius/frontend/src/pages/IssuePage.tsx:156-158,250-304`） |
| Research / Graph | 当前 Session 属于 Research 且用户打开 Tools | 右栏显示 Research Graph 入口 | Research 独立路由 / Graph | Research 动作已有 `researchId` 条件（`mobius/frontend/src/components/chat.tsx:4126-4134`） |
| Editor / 代码对话 | 用户在 Files tab选择“在编辑器打开” | Tool Drawer 的次级动作 | 现有按需 split / 高级页 | Legacy 已用保活避免 Chat remount（`mobius/frontend/src/pages/IssuePage.tsx:286-304`） |
| AIMUX / 可合作计算机 | 用户进入 Settings 连接，或 Session 主动声明 | Settings；Session Tools 的上下文动作 | 现有 AIMUX Modal / 客户端 | Settings 已分组，Session 动作已有禁用条件（`mobius/frontend/src/components/settings-panel.tsx:182-190`；`mobius/frontend/src/components/advanced-session-actions.tsx:144-153`） |
| Admin / 系统可视化 | Admin 用户进 Settings 高级 / 管理员 | Settings | 全屏 Admin overlay / 既有可视化路由 | Admin 仍是权限条件入口和全屏 overlay（`mobius/frontend/src/components/settings-panel.tsx:194-214`；`mobius/frontend/src/components/shell.tsx:1666-1695`） |

## 7. 明确不要抄的清单

- 不抄 Workspace daemon、Add from URL、worktree / clone agent 的对象层；Mobius 默认左栏只有 Project / Session（`examples/CodexMonitor/src/features/app/components/SidebarWorkspaceGroups.tsx:219-265`）。
- 不抄 Home / Sidebar 的 Usage、Credits、rate-limit 仪表盘（`examples/CodexMonitor/src/features/home/components/Home.tsx:71-84`；`examples/CodexMonitor/src/features/app/components/SidebarBottomRail.tsx:88-109`）。
- 不抄 stage / unstage / revert / commit / pull / push / sync / PR review；Tool Drawer只复用 panel / mode 结构（`examples/CodexMonitor/src/features/git/components/GitDiffPanel.tsx:102-146,699-791`）。
- 不抄 Send / Stop 合并按钮；Mobius 的 Send 永远发送，Stop 永远停止（`examples/CodexMonitor/src/features/composer/components/ComposerInput.tsx:160-166,325-352`；`mobius/frontend/src/components/chat.tsx:4872-4918`）。
- 不抄 Queue / Steer / follow-up 协议或文案（`examples/CodexMonitor/src/features/composer/components/Composer.tsx:257-273,585-602`）。
- 不抄 Plan toggle、Codex args、access mode、reasoning 等整排 MetaBar 控件；Mobius 首屏只保留模型摘要和 Project 上下文（`examples/CodexMonitor/src/features/composer/components/ComposerMetaBar.tsx:77-143,201-273`）。
- 不抄 Tutti OS 或 Cursor 常驻 IDE；不把文件树、编辑器、AI、Terminal 四栏同时设为默认（`MOBIUS_UI_SIMPLIFICATION_PLAN.md:118-120,527-536`）。

## 8. 给下一轮实现的拆单（只到文件级，不改代码）

以下只列“为了复用主壳”新增或需收紧的任务，不复述 09 的 token、全量路由或全部能力 backlog。

### P0：先让 Home / Session 共用一张壳

| 任务 | 改哪些文件 | 用户可感知结果 | 不改什么 / 与 09 的关系 |
| --- | --- | --- | --- |
| **P0-S1 建共享主壳与单一薄顶栏** | `mobius/frontend/src/App.tsx`、`pages/UserPage.tsx`、`pages/WorkPage.tsx`、`pages/IssuePage.tsx`、`components/shell.tsx`、`components/conversation-rail.tsx`、`index.css`；可新增一个只做 slot composition 的 `components/workbench-shell.tsx` | `/u/:user` 与 `/u/:user/s/:session` 的左栏、底栏和尺寸不重建；Session 顶部从 52+40px 收成单一 44px；路由刷新仍还原对象 | 不改 API、对象创建、Issue / Research 路由。收紧 09 `P0-3/P0-4`：不只统一 token / helper，还要求 Home / Session 共享同一壳实例和 `Home / Session` Main slot |
| **P0-S2 左栏按 CodexMonitor 四槽重排** | `components/conversation-rail.tsx`、`components/shell.tsx`、`index.css`、Rail 测试 | 新建 Project、Home、排序 / 刷新 / 搜索在 Header；搜索按需展开；Project / Session 居中滚动；账户 / Settings 固定底部；桌面默认 280px且可折叠 | 保留 `/api/tasks/recent`、10s 轮询、Project 分组、状态和 Session ID 匹配。升级 09 `P0-2/P0-3`，从“视觉收敛”增加“Header/Search/Body/Bottom 明确槽位” |
| **P0-S3 Composer 动态避让与中心层焦点契约** | `components/chat.tsx`、`index.css`、workbench / a11y 测试；若抽容器，只允许无业务状态的 `chat-pane` 布局组件 | Composer 加附件、错误、模型提示或多行输入时，最后一条消息始终可滚到 Composer 上方；隐藏 Diff / Chat 后键盘不进入不可见层 | 不重写 `ChatArea`、JSONL renderer、SSE、草稿、Send / Stop。收紧 09 `P0-3/P0-6`：新增 `ResizeObserver → bottom padding` 与 hidden layer `inert/focus` 验收 |
| **P0-S4 Project / Session 选择统一回 Chat** | `components/conversation-rail.tsx`、共享 shell state、`pages/UserPage.tsx`、`pages/WorkPage.tsx`、导航测试 | 从任何 Diff / Tool 状态点 Project 或 Session 都回对应 Chat；旧 Session 的文件 / Diff 选择不串到新 Session | 不改变 canonical 路由。扩展 09 `P0-4`：helper 除 URL 外还要定义 `exitCenterTool → clearObjectSelection → selectProject/Session → focus` 顺序 |

P0 验收必须覆盖 1440×900、1280×800 和 1024×768；CodexMonitor 在 1100 / 520 选择布局模式且 960px CSS 已取消桌面多列，Mobius 不应把 280+230px 侧栏硬塞进窄屏（`examples/CodexMonitor/src/features/layout/hooks/useLayoutMode.ts:5-20`；`examples/CodexMonitor/src/styles/base.css:237-255`）。

### P1：把工具菜单升级成按需 Tool Drawer

| 任务 | 改哪些文件 | 用户可感知结果 | 不改什么 / 与 09 的关系 |
| --- | --- | --- | --- |
| **P1-S1 建 Tool Drawer 控制器与折叠态** | `components/chat.tsx`、`components/advanced-session-actions.tsx`、`components/shell.tsx` / `workbench-shell.tsx`、`index.css`、工具状态测试；可新增纯壳 `components/session-tool-drawer.tsx` | Session 宽屏有可展开的 230px Drawer；无工具默认折叠；Files / Diff / Terminal / Skill / Memory / Git 有 active tab，用户折叠后中心立即扩展且可恢复 | 不复制工具实现，不把 Git + Plan 常驻。**收紧 09 `P1-1`：从“不要常驻右栏”升级为“Session Desktop 必须有可展开 Drawer；折叠、空、loading、error、active 都是一等状态”** |
| **P1-S2 Files list 驱动中心 Diff layer** | `components/chat.tsx` 中现有 `SessionFileChangesModal` 相关表面、`components/advanced-session-actions.tsx`、`index.css`、文件 / diff 测试；可抽无数据副作用的 viewer / list 子组件 | 点“本次改动”展开 Drawer，选文件在中心原位切 Diff；Topbar 提供 Back to chat；空 / 失败仍在壳内 | 不新增路由，不新增 Git 写操作，不复制 Chat。升级 09 `P2-3`：先落实 `drawer selection → centerMode → Back clears selection` 的对象状态机 |
| **P1-S3 终端先入 Drawer、可展开底坞** | `components/chat.tsx`、现有 `web-terminal-modal` 适配层、`components/session-tool-drawer.tsx`、`index.css`、终端生命周期测试 | Tools → Terminal 一跳可见；cwd / Agent 模式仍保留；长输出可展开 220px 底坞；关闭不丢 Chat 草稿或滚动 | 不自动执行命令，不改 Terminal API / 权限。细化 09 `P1-1/P2-3` 的终端落点，不再先弹模式 Modal再弹终端 Modal |
| **P1-S4 Skill / Memory 快照与管理跳转** | `components/chat.tsx`、`components/session-welcome.tsx`、`components/settings-panel.tsx`、Drawer、导航 helper / 测试 | Drawer 显示“本 Session”快照；管理进入 Settings / 高级页；Back 回原 Session和原 tab | 不改注入时机或存储。收紧 09 `P1-5`：快照不再是 Modal，管理页返回还原 Drawer state |
| **P1-S5 MetaBar 只读摘要与新 Session 语义** | `components/chat.tsx`、`components/advanced-session-actions.tsx`、现有 `NewSessionModal` 所在文件、Rail刷新 / 导航测试 | Composer 下只见模型摘要 + Project；点击“修改模型并继续”明确创建新 Session，成功后左栏新增 / 选中 | 不把 Harness放首屏，不热切当前 Session，不改后端创建参数。延续 09 `P1-6` 并把 MetaBar 内容上限写死 |

### P2：高级页、编辑器与响应式补齐返回

| 任务 | 改哪些文件 | 用户可感知结果 | 不改什么 / 与 09 的关系 |
| --- | --- | --- | --- |
| **P2-S1 高级页统一 Back to source** | `pages/ProjectPage.tsx`、`pages/IssuePage.tsx`、`pages/ResearchPage.tsx`、Research Graph、Admin chrome、导航 helper、测试 | 从 Session 进入 Project / Issue / Graph 后，页面按钮与浏览器 Back 都回来源 Session；深链无来源时回 Project | 不把高级页塞进 Tool Drawer，不删页面。收紧 09 `P0-5/P2-1`：所有高级入口必须携带校验过的 `returnTo` 与 focus target |
| **P2-S2 编辑器接入 Files 的次级动作** | `pages/IssuePage.tsx`、`pages/ResearchPage.tsx`、现有 workspace editor / code-conversation 组件、Drawer Files tab、布局测试 | 在 Files 中“打开编辑器”按需 split；反复开关不重载 Session，关闭回原文件 / 对话位置 | 不建第二 Chat，不默认三栏。沿用 09 `P2-2`，并明确入口只能来自 Drawer Files / 高级页 |
| **P2-S3 Tablet / Phone 改为 drawer / tab** | `components/workbench-shell.tsx`、`components/conversation-rail.tsx`、`components/session-tool-drawer.tsx`、`index.css`、响应式测试 | Desktop 是左中右；Tablet / Phone 的左栏和 Tools 变覆盖 drawer / tab，Composer与 Stop始终可见 | 不在窄屏保留 280+230 固定列，不改业务能力。新增主壳断点任务，参考 CodexMonitor `useLayoutMode` 而不复制其移动端产品 tab |

下一轮的退出门槛不是“看起来像截图”，而是十二条路径在同一壳内成立：左栏选择不串旧工具状态；Chat / Diff切层不改路由；Composer 增长不遮消息；Tool Drawer 折叠不丢对象；Settings / 高级页关闭后焦点和来源可恢复；Send / Stop、模型新 Session、Harness、SSE、消息协议全部保持 Mobius 原语义。
