# 07｜操作跳转与交互契约

## 结论

Mobius 的统一短会话地址已经成立，下一步应把它设为所有“继续工作”动作的唯一落点：`/u/:user/s/:session`。Project / Issue / Research 是上下文和高级管理目标，不应重新变成普通会话的必经路由。所有覆盖层必须保留当前 URL、关闭后恢复焦点；所有全页高级跳转必须能通过浏览器 Back 回到原 Session；所有失败必须在发生处恢复，而不是把用户赶回首页。

本文是本轮的交互真相源。布局位置见 [06-layout-and-chrome.md](./06-layout-and-chrome.md)，能力是否应出现见 [08-capability-presentation.md](./08-capability-presentation.md)。

## 1. 路由与状态不变量

1. **继续某个会话**永远落到 `/u/:user/s/:session`。当前 Conversation Rail、全局搜索和完成 Toast 已采用短地址（`mobius/frontend/src/components/conversation-rail.tsx:78-81,234-240`；`search-modal.tsx:224-237`；`App.tsx:324-341`）。
2. **更换 Project 不改写现有 Session 的归属**；它只筛选历史或决定下一段新会话的上下文。Home 已用 `?project=` 表达选择且不换页面（`UserPage.tsx:338-353,428-438`）。
3. **Overlay 不改 URL**：Search、Settings、会话工具、文件预览、终端选择都覆盖当前上下文。关闭要恢复触发器或 Composer。
4. **高级全页必须有 URL**：Project、Issue、Research、Graph、系统可视化可进入既有路由；Back 回原 `/s/:session`。不要用只存在于内存的“模式切换”替代可返回的跳转。
5. **失败原地处理**：加载失败重试加载，发送失败恢复草稿并重试发送，模型失效进入“修改模型并继续”；不能用一个“回到主页”覆盖所有失败。
6. **不改执行语义**：P0/P1 不改 Harness、SSE、Stop 和消息协议。CodexMonitor 的 Queue/Steer 只作为状态反馈参考，不移植为 Mobius 新协议（边界见 `MOBIUS_UI_SIMPLIFICATION_PLAN.md:4-7`）。

## 2. 用户动作 → 当前 Mobius → CodexMonitor → 建议跳转

### 2.1 开始、继续与切换

| 用户动作 | 当前 Mobius 路径 | CodexMonitor 路径 | 建议跳转 |
| --- | --- | --- | --- |
| 新用户第一次开始工作 | `/u/:user`；无项目时显示最小项目表单，名称输入 `autoFocus`，创建后回 Home Composer（`UserPage.tsx:250-277,355-360`）；发送串联创建并跳 `/u/:user/s/:session`（`UserPage.tsx:368-395`） | Home 显示 Latest / Add workspace；添加 workspace 是显式前置，Home 本身不是对话 Composer（`examples/CodexMonitor/src/features/home/components/Home.tsx:55-84`） | **保持 Mobius 自己的优势**：项目创建成功后焦点落 Composer；首次发送成功 `navigate('/s/:session')`。失败留在同一 Composer 下方，仅重试失败阶段。不要复制 Usage/Workspace 仪表盘 |
| 继续昨天的会话 | Rail 按项目分组；点行调用 `openConversation` 并导航到 `/u/:user/s/:session`；行内已有“昨天”等时间（`conversation-rail.tsx:65-81,234-240,307-325`） | Sidebar 可按 Yesterday 分桶，点 thread 进入对应 workspace/thread（`Sidebar.tsx:48-97,919-1014`） | **必须学稳定入口，不改组织方式**：继续沿用项目分组；点击整行直达短路由。导航后焦点进入会话主区，屏幕阅读器播报标题；Back 回先前 Home/Session |
| 在项目之间切换，但不离开会话语法 | Home 的 `<select>` 改 `?project=`；Session 顶栏项目名会跳 `/p/:project`，没有“把当前会话切到别的项目”的动作（`UserPage.tsx:428-438`；`shell.tsx:844-851`） | 选 workspace 会退出 diff、清选中 thread，回到 workspace 空态；选 thread 再进入会话（`useSidebarLayoutActions.ts:69-83,109-123`） | Project 文件夹只负责筛选/展开会话；点其中会话仍去 `/s/:session`。要在 Project B 新开工作，点“新会话”后去 `/u/:user?project=B` 并聚焦 Composer；**不迁移当前 Session** |
| 新开会话 | TopNav 在 Home 派发 `mobius:new-conversation`；其他页先去 `/u/:user?project=current`，80ms 后派发事件（`shell.tsx:776-786`）。Rail 也有“新会话”（`conversation-rail.tsx:258-263`） | Sidebar add thread / workspace；Composer 是创建后的输入核心（`Sidebar.tsx:866-894`；`Composer.tsx:392-421`） | 宽屏以 Rail“新会话”为首入口；TopNav 为跨页/窄屏兜底。落到 Home 空态，保留当前 Project，清输入错误与 checkpoint，焦点落 Composer（当前 `UserPage.tsx:307-317` 已做到） |
| 停止当前 turn | Easy 头部独立“停止”，只按 `sessionId` 禁用；点击立即乐观置 idle，POST `/stop`，成功刷新历史，失败显示 `lastSendError`（`chat.tsx:4055-4097,4326-4336`） | Composer action 在 `canStop` 时从 Send 切 Stop（`ComposerInput.tsx:160-166,326-335`） | **不要照搬切换按钮**：Mobius 保持 Send / Stop 分离。Stop 仅在 pending/running 时高可见；idle/waiting 时降级或隐藏。点击后焦点回 Composer；失败在会话头原位提供“再次停止”，不跳页 |

### 2.2 找回、设置与输入材料

| 用户动作 | 当前 Mobius 路径 | CodexMonitor 路径 | 建议跳转 |
| --- | --- | --- | --- |
| 搜索会话 | TopNav Search 打开全局内容搜索 Overlay；输入自动聚焦，结果先预览，再进入短路由并用 `match/ts` 滚到命中（`search-modal.tsx:103-133,224-237,244-309,399-409`） | Sidebar 内搜索按 150ms debounce 筛 workspace/thread，不离开侧栏（`Sidebar.tsx:220-323`） | 顶栏 Search 保留为“内容搜索”；Rail 搜索保留为“快速找会话”。两者文案区分，Cmd/Ctrl-K 打开前者并聚焦；Esc 回原触发器/原路由 |
| 按 Session ID 找回 | Rail filter 已把 `item.session_id` 纳入匹配（`conversation-rail.tsx:194-205`）；全局搜索要求至少 2 字且主要搜内容（`search-modal.tsx:135-205`） | 无 Mobius Session ID 对等物；Sidebar 搜 thread 标题/workspace | 在 Rail 输入完整或部分 ID，结果只显示匹配会话，Enter 打开第一项；若 Rail 折叠，TopNav Search 检测 `session=` / ID 形态并优先给“直接打开会话”结果。找不到时保持输入并给“未找到”，不清空 |
| 打开设置后回到原上下文 | TopNav 本地 state 打开 Settings，不改 URL；初始焦点到关闭按钮，Tab trap，Esc/背景/X 关闭并恢复原触发器（`shell.tsx:769-774,871-895`；`settings-panel.tsx:33-69,85-94`） | Settings Modal 覆盖工作区；背景/X/快捷键关闭（`SettingsView.tsx:141-167`） | **当前路径基本正确**。设置分类切换不写业务路由；关闭回原 Session/Home、原滚动和触发器。设置内进入全页高级路由时先关闭 overlay，再 SPA navigate；Back 回原页 |
| 附加文件 | Session Composer 的 `＋ → 上传文件` 打开 file input；粘贴/拖放同一上传链路；附件按 session 保留（`chat.tsx:2240-2251,2970-3069,4580-4636,4799-4833`） | Composer 有直接 attachment action（`ComposerInput.tsx:248-258`） | **可学一键可见**：Session Composer 把 paperclip 提升为 32px 直接入口，`＋` 保留压缩上文/展开输入。选完焦点回 textarea；上传失败保留 chip，并在 chip 上“重试/移除”，不阻塞其他已完成附件。Home 是否支持附件需等现有创建编排明确接收路径，P0 不伪造 |
| `@` 引用文件 / Agent | 输入 `@` 或 `session=` 自动开 Drawer；文件点击插绝对路径，Agent 形成 mention chip；插入后关闭并恢复 caret/focus（`chat.tsx:3111-3188`）；Drawer 提供 Files/Agents（`chat.tsx:1887-2175`） | Composer autocomplete 覆盖 files/skills/apps/prompts；文件面板也能 “Mention in chat”（`Composer.tsx:304-353`；`FileTreePanel.tsx:628-643`） | 保持键入触发，不再增加常驻按钮。Drawer 初始焦点留在搜索/结果导航；选择后回原 caret；加载错误就在 Drawer 内重试。Tool Drawer 的文件也提供“引用到对话”，统一调用现有插入逻辑 |

### 2.3 工作工具

| 用户动作 | 当前 Mobius 路径 | CodexMonitor 路径 | 建议跳转 |
| --- | --- | --- | --- |
| 查看会话文件修改 / Diff | `工具 → 查看文件修改` 打开 `SessionFileChangesModal`；左选文件、右看 Git diff/内容，错误留在 Modal（`advanced-session-actions.tsx:80-90`；`chat.tsx:704-888,5040-5045`） | 选 diff path 把 centerMode 设为 diff；Chat/Diff 同位切层，可 Back to chat（`useGitPanelController.ts:209-230`；`useMainAppLayoutSurfaces.ts:648-653`） | **必须学稳定切层**：短期仍用 Modal；P1 合并为 Tool Drawer 的 Files/Diff tab。打开不改 URL，焦点落文件列表；关闭回“工具”。不要移植 stage/revert/commit/push，因为 Mobius 当前没有对等默认工作流 |
| 浏览项目文件 / 预览 / 引用 | 默认 Session 工具只有“文件修改”，项目文件浏览器存在于高级/旧工作区和 `@` Drawer（`IssuePage.tsx:28-29,847-899`；`chat.tsx:1815-1832,2144-2175`） | Files panel 点目录展开，点文件开 640px preview；可选行加入 Chat，Esc 关（`FileTreePanel.tsx:291-303,522-541,583-643,766-802`） | Tool Drawer 增加“项目文件”tab，复用现有 API/树；点文件在 Drawer 内预览，`引用`后关闭预览、保留 Drawer、焦点回 Composer。读取失败原位重试 |
| 查看终端 | `工具 → 打开终端` 先选“当前目录 / Agent 后台”，再开 `WebTerminalModal`（`advanced-session-actions.tsx:133-143`；`chat.tsx:5084-5154`） | Terminal 是 workspace dock，和中心内容共存（`DesktopLayout.tsx:221-241`） | 首次仍显示两种现有模式；记住本 session 最近选择后可直接打开。桌面宽屏可进入 Tool Drawer/Dock，窄屏保持 Modal。关闭回工具按钮，不重建 Chat/SSE；连接失败在终端容器内重连 |
| 用编辑器打开 | 默认 WorkPage/Tools 没有 Editor 入口；`LegacyIssuePage` 与 ResearchPage 已有 VSCode / 原生 CodeConversation 条件布局（`IssuePage.tsx:286-304,847-910`；`ResearchPage.tsx:40-63,434-477`），但当前精简 TopNav 不提供切换 | 无完整 IDE；文件 preview 可 Open App，中心可切 Diff（`FileTreePanel.tsx:766-799`） | 工具菜单显示“用原生编辑器打开 / 用 VSCode 打开”仅在可用时。进入时保留 `/s/:session` 作为返回地址；P1 优先 Drawer/外部打开，P2 才评估 split。关闭后恢复同 Session/草稿；不可用时在入口处说明 bind path/code-server 前置条件，不展示空编辑器 |
| 查看 Git | `工具 → Git` 打开 `SessionSkillMemoryModal(initialPanel='git')`，展示当前项目/远程计算机仓库扫描（`chat.tsx:2476,4140-4143,4229-4234`；`session-welcome.tsx:725-782,979-1077`） | 右栏 Git panel 有 diff/per-file/log/issues/PR 多模式（`GitDiffPanel.tsx:640-807`） | 默认只呈现 Mobius 已有的“仓库状态 + 会话文件修改”。完整 Git 操作留高级页/外部工具；不要把 CodexMonitor 的 PR、stage、push 工作流写进默认 Tool Drawer |

### 2.4 配置与高级能力

| 用户动作 | 当前 Mobius 路径 | CodexMonitor 路径 | 建议跳转 |
| --- | --- | --- | --- |
| 改模型 / Harness | `工具 → 修改模型并继续` 打开 `NewSessionModal`，基于当前 Issue/Research 创建**新 Session**，成功跳新 `/s/:session`（`advanced-session-actions.tsx:185-193`；`chat.tsx:3995-4006,5068-5081`）。项目默认模型在高级项目设置，管理员管理接入（`ProjectSettingsPanel.tsx:778-782,1152-1158`；`panels.tsx:3285-3308,3862-4076`） | 模型/推理/access 在 Composer MetaBar 就近选择（`ComposerMetaBar.tsx:144-273`） | **不要伪装成原地换模型**。入口文案保持“修改模型并继续（新会话）”；焦点落模型选择；取消回当前会话，成功进入新短路由，Back 可看旧会话。Harness 接入仍只在 Admin，不进普通 Composer |
| 查看/管理 Skill | `工具 → Skill` 打开当前会话资源 Modal；Settings → 项目与上下文 → Skills 管理跳 `/u/:user?view=projects&panel=skills`（`advanced-session-actions.tsx:198-216`；`settings-panel.tsx:170-178`） | Composer autocomplete 有 skills；无 Mobius 的管理对等物（`Composer.tsx:304-353`） | 会话工具只显示“本会话 Skill 快照”，并提示新增/修改影响后续会话；管理从 Settings 进入高级表面。关闭 Modal 回工具触发器；加载失败原位刷新 |
| 查看/管理 Memory | 与 Skill 同级；会话 Modal + Settings 管理入口（`advanced-session-actions.tsx:217-230`；`settings-panel.tsx:176-177`） | **无对等物** | 保留 Mobius 语义，不模仿 CodexMonitor。默认只给快照摘要，完整增删改在 Settings/高级页；“知识沉淀”是单独会话动作，不能与 Memory 开关混为一谈（`advanced-session-actions.tsx:174-184`） |
| 进入项目详情 | Session 顶栏项目名直达 `/u/:user/p/:project`；Settings 也有当前项目设置（`shell.tsx:844-851`；`settings-panel.tsx:174-175`） | 选择 workspace 是主导航，无 Mobius 项目管理页对等物 | 顶栏项目 crumb 保持可点但低强调；打开高级 ProjectPage。浏览器 Back 回原 Session；ProjectPage 内新建规划 Session 成功仍统一跳 `/s/:session`（`ProjectPage.tsx:937-955`） |
| 进入 Issue 详情 | 默认不显示 Issue crumb；ProjectPage 任务列表可进入 `/p/:project/i/:issue`，该页无 Session 时是 Composer、有 Session 时仍为统一 Chat（`IssuePage.tsx:156-270`） | **无对等物** | Issue 只从 Project 高级页、搜索的高级对象结果或会话“上下文详情”进入。若目标是继续会话，直接 `/s/:session`；若目标是管理任务，才进 `/i/:issue` |
| 进入 Research / Graph / Blackboard | ProjectPage 研究列表去 `/p/:project/r/:research`（`ProjectPage.tsx:950-955`）；ResearchPage 用 `?view=graph/blackboard` 切主区（`ResearchPage.tsx:292-297,479-508`）。短路由 Chat 的 Graph 动作只写 `?view=graph`（`chat.tsx:4129-4137`），但 WorkPage 不消费该 query（`WorkPage.tsx:88-110`） | **无对等物** | 修复断点：从 `/s/:session` 点 Graph 应 navigate 到 `/p/:project/r/:research?session=:session&view=graph`；Back 回短路由。普通“进入研究”先到 Research 概览；焦点落 Graph/Blackboard 标题，错误在当前视图刷新 |
| 进入 Admin | Settings 的管理员项先关 Settings，再调用 `window.openAdminOverlay`（`settings-panel.tsx:208-213`）；Admin 是全屏 overlay（`shell.tsx:1673-1702`） | Settings 有 account/general 等，无 Mobius Admin 对等物 | 保持权限条件。打开 Admin 后焦点落 Admin 标题/所选 tab；关闭回 Settings 管理员项或原工作台。运行监控可直接传 `runtime`，不要把 Admin tab 重新塞回 TopNav |
| 系统可视化 | Settings → 高级 → `/mobius_overview_cluster` 或旧 Overview（`settings-panel.tsx:194-203`） | **无对等物** | 继续作为高级全页；从 Session 打开时浏览器 Back 回同 Session。不要因 CodexMonitor Home 有 Usage 就把可视化恢复到 Home |

### 2.5 桌面、AIMUX 与客户端

| 用户动作 | 当前 Mobius 路径 | CodexMonitor 路径 | 建议跳转 |
| --- | --- | --- | --- |
| AIMUX 指引 / 可合作计算机 | Settings → 连接与客户端 → AIMUX 打开 Modal（`settings-panel.tsx:182-190,219-225`）；会话工具“可合作计算机”生成声明发给当前 agent（`advanced-session-actions.tsx:144-153`；`chat.tsx:4237-4244`） | **无对等物** | 全局连接配置留 Settings；当前会话协作入口留 Tools。Modal 关闭回原分类/工具；连接失败显示状态与重试，不跳 Welcome；不要把 AIMUX 变成常驻品牌动画 |
| 桌面端下载 / CLI / 移动端 | Settings 各自打开现有 Modal（`settings-panel.tsx:182-190,219-224`） | **无对等物** | 保持二级入口。下载成功不离开工作台；CLI 提供复制后回焦点；错误在 Modal 内重试。TopNav 不恢复下载按钮 |
| 桌面多标签 / 外部编辑器 | DesktopTabBar 由 App 桌面条件挂载；会话旧高级布局支持 VSCode（`App.tsx:378-419`；`IssuePage.tsx:847-910`） | DesktopLayout 自带宿主 titlebar / collapsible panels（`base.css:93-188`） | 桌面宿主能力保留，但不占 Web 默认 chrome。外部打开后原 Session 不卸载；“回到 Mobius”回原短路由。不要复制 CodexMonitor 的窗口按钮皮肤 |

### 2.6 状态驱动的下一步

| 用户动作 / 状态 | 当前 Mobius 路径 | CodexMonitor 路径 | 建议跳转 |
| --- | --- | --- | --- |
| 运行中：用户下一步点哪 | Rail 点亮 running；Session Chip 显示执行中；Stop 常驻；普通发送在 pending 清除后仍可用（`conversation-rail.tsx:57-61,300-325`；`session-status-chip.tsx:27-32`；`chat.tsx:4877-4919`） | Composer 显示 processing；follow-up 明确 Queue/Steer，action 可 Stop（`Composer.tsx:253-273,580-630`） | 状态 Chip 旁只强化 Stop；Composer 保持可输入。若 Mobius 现有后端把消息排队，UI只描述真实返回，不新增 Queue/Steer 模式。点 Stop 不离开页面，成功后焦点回 Composer |
| 等待输入 / 待命：用户下一步点哪 | Chip 显示“待命”，Composer 仍在底部（`session-status-chip.tsx:31`；`chat.tsx:4249-4266,4511-4544`） | 状态与输入在同一 workspace，继续发消息 | 默认焦点/视觉导向 Composer，主动作“发送”；Stop 降级。需要权限确认时把确认卡放到对应消息附近，而不是只在全局 Toast |
| 发送失败：用户下一步点哪 | `postSessionMessage` 清 pending、显示 `lastSendError`、追加系统错误并重新加载；输入已在发送瞬间清空，catch 只恢复 focus（`chat.tsx:3213-3235,3893-3919,4468-4487`） | 工具/操作错误通常在所属 panel 内带 action/dismiss；Git conflict 可“Sync pull then push”（`GitDiffPanel.tsx:263-288,793-807`） | 保存本次发送快照；错误条提供“恢复到输入框 / 重试发送”，默认焦点落重试。重试复用 request id / 既有防重策略，具体实现不得改变消息协议；关闭错误不丢可恢复草稿 |
| Agent 失败：用户下一步点哪 | 持久失败横幅只有关闭；模型不可用时另有“修改模型并继续”（`chat.tsx:4489-4505,4613-4622`） | 错误就近显示，部分 panel 有 retry/dismiss | 横幅提供真实可行动作：一般失败“继续输入”，模型失效“修改模型并继续（新会话）”，连接断开“重新连接”。不提供虚假的“一键重跑整个 turn” |
| Session 加载失败 | WorkPage 只显示错误和“回到主页”（`WorkPage.tsx:98-105`） | Panel 错误多留在原位置并可重试 | 增加“重试加载”和“回到主页”两项；重试保持 `/s/:session`，焦点落重试按钮。只有确认 ID 不存在时才把“回主页”作为主建议 |
| Home 创建失败 | Home 显示 checkpoint 错误并“重试当前阶段”（`UserPage.tsx:368-395,447-451`） | 无同构创建链 | **当前机制应保留**；错误不清项目/输入/checkpoint，重试成功再跳短路由 |

## 3. 覆盖层的统一焦点与返回契约

| 表面 | 打开后焦点 | Esc / 背景 | 完成后焦点 | 错误恢复 |
| --- | --- | --- | --- | --- |
| Rail Drawer | 搜索框；当前已有（`conversation-rail.tsx:113-118`） | 关闭并回触发器；当前已有（`conversation-rail.tsx:108-133`） | 选会话后进入主标题/Composer | 列表内“重新加载”，不关 Drawer |
| Search | 搜索输入；当前已有（`search-modal.tsx:128-133`） | 关闭回 Search 按钮 | 预览 → 查看会话 → 命中卡片 | 保留 query，提供重试；当前错误仅展示（`search-modal.tsx:313-317`） |
| Settings | X；当前已有（`settings-panel.tsx:33-41`） | 关闭回触发器；当前已有 | 切分类聚焦分类标题；全页跳转由 Back 返回 | 分类内原地提示，不关闭 Settings |
| Tools Popover | 第一可用 action；当前已有（`chat.tsx:2273-2289`） | 关闭回 Tools 按钮 | 开工具后焦点到工具标题/首控件 | Popover 不承担错误；错误留在目标工具 |
| Tool Drawer / Modal | 工具标题或列表第一项 | 关闭回 Tools/对应入口 | “引用到 Chat”回 textarea；普通关闭回入口 | 工具内部刷新/重连，不把用户赶回 Home |
| 高级全页 | `<h1>` / 主区标题 | 浏览器 Back，不把 Esc 当全页返回 | Back 后恢复 session 滚动/草稿 | 页面内 retry；路由不丢失 |

## 4. 必须学 / 可学 / 不要学

| 分级 | 决策 |
| --- | --- |
| **必须学** | Sidebar/overlay 位置稳定；Chat/Diff/Files 是可返回的工作层；错误靠近所属动作；切层前正确处理焦点；设置关闭回原上下文 |
| **可学** | 文件预览选择片段后引用到 Composer；工具 Drawer 记住本 session 的最后 tab；搜索先预览再精确滚动 |
| **不要学** | Composer Send/Stop 合并；把 Codex Queue/Steer、Approval、Git push/review 语义移植到 Mobius；为对齐而删除 Issue/Research/Memory/AIMUX；把编辑器变成默认常驻中栏 |

## 5. 导航验收清单

- Rail、Search、Toast、任何完成通知点击同一 Session 都生成同一种短地址。
- 从 `/s/:session` 新建会话继承 Project，但不修改原 Session。
- Search、Settings、Tools、附件、`@` 关闭后焦点可预测，当前输入与滚动不丢。
- Research Graph 从短路由能真正进入 Graph；Back 回原短路由。
- 模型切换明确创建新 Session；Skill/Memory 明确区分“当前快照”和“未来管理”。
- Diff/Files/Terminal/Editor 打开与关闭不重挂 ChatArea，不触碰 SSE/Stop/Harness。
- Running / Waiting / Failed 每种状态都给一个真实下一步；没有“看见状态但不知道点哪”的死端。
