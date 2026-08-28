# Mobius 界面简化设计（对标 Tutti）

> 文档状态：实现与评审稿
> 适用范围：Mobius Web/桌面端的默认前端体验
> 核心约束：本轮不删除后端能力，不改 harness 后端，不把 Mobius 重做成 Tutti OS，也不照搬 Cursor 的 IDE 布局。

本文所说的“对标 Tutti”，指的是对齐其工作台纪律：空态直接开始、会话是主表面、工具按需出现、视觉层级克制。不是复制 Tutti 的 Dock、Launchpad、窗口系统或 Agent Provider 体系。

## 1. 问题：现在为什么上手不了

当前问题不是“功能不够清楚”，而是用户在完成第一件事之前，被要求理解过多产品概念和界面模式。

### 1.1 新用户先做产品配置，后做自己的任务

`mobius/frontend/src/App.tsx:355-388` 会在 `/u/:user` 和 Issue 路由首次进入时读取 `layout_mode`；没有本地记录就渲染 `LayoutModeChoiceModal`。该弹窗要求用户先理解“常规模式”和“简易模式”的能力差异。`mobius/frontend/src/services/layout-mode.ts:3-20` 又把这个选择持久化为浏览器级设置。

这一步发生得太早。尚未发出第一条消息的用户，不可能根据“层次化管理”“智能体群体技能和记忆”等描述做出有根据的选择。模式选择不是帮助，而是入场考试。

### 1.2 默认路径同时暴露四层业务对象和两套模式

当前可见对象链大致是：

```text
用户主页 User
  └─ 项目 Project
      ├─ 任务 Issue
      │   └─ 会话 Session
      └─ 研究 Research
          └─ 研究智能体 Session
```

对象链之外还有两层界面模式：

- 全局布局模式：`easy_mode` / `normal_mode`，由 `layout-mode.ts` 和 `LayoutModeChoiceModal` 控制。
- 会话工作区模式：`session` / `editor-chat` / `code-conversation`，由 `WorkspaceLayoutToggle` 控制；组件说明和选项见 `mobius/frontend/src/components/workspace/workspace-layout-toggle.tsx:9-83`。

也就是说，新用户不是在回答“我要做什么”，而是在回答“我应该在哪个对象、哪种模式、哪种布局里做”。

### 1.3 首页是管理总览，不是开始工作的地方

登录后的 `/u/:user` 由 `UserPage` 渲染。`mobius/frontend/src/pages/UserPage.tsx:204` 定义了 `projects / memory / skills / data / monitor / config` 六种视图；桌面左栏又直接放出项目、Memory、Skills、数据、监控、配置等入口。项目主区还有全部/我的/星标/扩展等筛选、卡片元数据、任务与研究子列表、分页和多个卡片操作。

这些能力对熟练用户有价值，但首页缺少一个无需导航就能开始的主动作。用户看到的是“管理 Mobius”，不是“让 Mobius 干活”。

### 1.4 创建与进入会话的分支过多

`Welcome.tsx` 的步骤类型包含 `menu / pathChoice / project / session / projectList / pathProjectList`（`mobius/frontend/src/pages/Welcome.tsx:146`）。入口同时提供继续上次工作、接入本机项目、新建项目、导入资料、进入已有项目、系统可视化等选择。项目和 Session 表单虽已折叠部分高级字段，但仍在第一次开始前出现模型、语言、Skill、Memory、PC 任务模式、研究系统、worktree 等概念。

顶栏的 `GlobalCreateMenu` 又同时提供“新建项目、任务、快捷会话、研究智能体”四类创建（`mobius/frontend/src/components/global-create.tsx:1893-1898`）。同一目标可以从 Welcome、顶栏、项目页、Issue 页和 EasyMode 页发起，入口多但主路径不明确。

### 1.5 导航和历史记录重复实现，且组织方式不同

- `shell.tsx` 有 `RecentSessionsPanel`，按项目和 Issue/Research 展开。
- `IssuePage.tsx:455-642` 在左栏提供“任务会话 / 近期会话”两个标签，并再次构建项目层级树。
- `EasyModePage.tsx:498-812` 再实现一套“工作导航”、项目筛选、层级搜索和会话树。
- `ResearchPage.tsx` 又把研究智能体列表、Blackboard、Research Graph 和团队操作放进同一侧栏。

这造成两个问题：用户每换一页都要重新理解导航；实现侧也很难保证“当前会话、搜索、最近记录”的行为一致。

### 1.6 顶栏承担了过多产品面板的职责

`mobius/frontend/src/components/shell.tsx:1169-1537` 的右侧区域同时容纳 AIMUX 状态、路径绑定、四类新建、工作区布局、全局搜索、系统可视化、帮助、GitHub、资源指标、主题与背景流、助手气泡、简易/常规模式、主题工坊，以及包含管理中心、下载、CLI、移动端、密码等入口的用户菜单。

顶栏中的每个按钮单独看都合理，合在默认工作台中却没有主次。高频的“开始/继续会话”与低频的“主题工坊/系统状态”竞争同一层级。

### 1.7 关键决策

| 决策 | 为什么 Tutti 这样 | Mobius 现在怎样 | 我们改成怎样 |
|---|---|---|---|
| 不让新用户先选模式 | Tutti 的模式由宿主设置拥有，AgentGUI 本身不承担模式判断；用户进入 Agent 表面后直接工作 | 首次访问关键路由被 `LayoutModeChoiceModal` 阻断 | 默认进入唯一工作路径；旧 `layout_mode` 只用于迁移，不再阻断渲染 |
| 首页先给输入，不先给管理树 | Tutti 的无会话空态直接渲染主 Composer 和建议项 | `/u/:user` 首屏是项目管理与六类导航 | `/u/:user` 改为“开始任务 + 最近会话 + 最近项目”；完整管理入口后置 |
| 默认只让用户理解 Project 和 Conversation | Tutti 主工作面围绕会话展开，宿主工具不改写核心会话模型 | Project、Issue、Research、Session 同时成为导航节点 | User 隐式化；Issue/Research 在默认 UI 中不作为必经层，后端对象继续保留 |

## 2. Tutti 为什么显得简单（带源码证据，不要空泛）

Tutti 并不缺少能力。`examples/tutti/README.zh-CN.md` 描述了 Agent、应用、任务、文件和协作等完整系统。它显得简单，主要因为能力没有同时争夺默认表面。

### 2.1 空态的第一个完整控件就是输入框

`examples/tutti/packages/agent/gui/agent-gui/agentGuiNode/view/AgentGUIDetailPane.tsx:680-707` 在没有活动会话时渲染 `AgentGUIEmptyHomePane`；`AgentGUIEmptyState.tsx:284-340` 的核心顺序是身份提示、必要状态、`AgentComposer`、建议项。用户无需先新建“任务对象”或选择 UI 模式，便能表达意图。

会话开始后，同一 Detail Pane 变成时间线和底部 Composer：`AgentGUIDetailPane.tsx:710-797` 渲染 `AgentGUIDetailTimeline`，并只在有活动会话时挂载 `AgentGUIBottomDockPane`。空态和工作态共用一个中心，不需要在“首页、概览、会话页”之间学习三种主区。

| 决策 | 为什么 Tutti 这样 | Mobius 现在怎样 | 我们改成怎样 |
|---|---|---|---|
| 空态和会话态共用主区 | 输入意图是开始工作的最短路径，会话创建只是其结果 | Mobius 常先展示项目卡片或 SessionOverview，再由用户点“新建会话” | 首页放主输入；会话页保留同一输入位置。首次发送可串联创建默认 Issue 和 Session |

### 2.2 结构稳定：窄轨、会话轨、详情区

`AgentGUINodeView.tsx:537-744` 将界面稳定分为 Provider Rail、Conversation Rail 和 Detail Pane；会话轨可折叠、可调整宽度，详情区始终是主要工作面。这里的重点不是照搬 Provider Rail，而是：导航只有一个固定位置，中心工作面不会因对象类型改变布局语法。

Mobius 应借用这个稳定性，但不复制 Provider Rail。默认只需要一条可折叠的 Conversation Rail；Project 作为筛选/上下文，不再额外占一条对象树。

### 2.3 高级能力通过展开层和工具侧栏出现

`AgentComposerDisclosureCard.tsx:44-103` 把扩展内容放在可展开面板中，收起时只保留一条摘要 Banner。桌面宿主的 `StandaloneAgentWindow.tsx:816-991` 将 AgentGUI 作为主体包在 `StandaloneAgentToolSidebar` 内；`StandaloneAgentToolSidebar.tsx:650-700` 的 Browser、Tasks、Apps、Messages 等面板由快速动作按需打开，不常驻挤压会话。

| 决策 | 为什么 Tutti 这样 | Mobius 现在怎样 | 我们改成怎样 |
|---|---|---|---|
| 工具按需出现 | 工具服务于当前任务，不与会话争夺首屏 | 编辑布局、文件、研究图、黑板、系统状态、助手气泡有多个常驻或顶栏入口 | 默认不渲染右侧工具区；从“更多”按需打开文件/编辑器/运行详情抽屉 |
| 高级参数默认摘要化 | Tutti 用 Disclosure Card 保留能力但降低首屏密度 | 创建表单虽有“高级选项”，主入口仍先要求选择创建对象类型 | 默认创建只收集必要字段；模型、Skill、Memory、worktree 等放“高级设置”并继承项目默认值 |

### 2.4 Agent 模式与 OS 模式分路，但不把选择塞进 AgentGUI

`examples/tutti/docs/plans/2026-07-13-workspace-ui-mode-design.md:10-33` 规定 Agent 模式由宿主设置 `workspace.standaloneAgentMode` 拥有；AgentGUI 不接收模式状态，OS workbench 的代码路径保持完整。实际渲染也在 `examples/tutti/apps/desktop/src/renderer/src/app/windows/workspace/WorkspaceWindow.tsx:21-54` 根据 `view=agent` 选择独立 Agent 窗口或默认 Workspace 窗口。

这给 Mobius 的启示不是保留两个默认模式，而是把高级工作台当作明确的次级入口。核心会话组件不应同时知道“简易/常规”两套产品身份。

### 2.5 视觉层级来自间距、边界和文字，不来自装饰

`examples/tutti/docs/conventions/desktop-visual-language.md` 明确区分 Launcher 的轻盈与 Workspace 的克制；工作台使用低饱和表面、细边界和排版建立层级，高饱和颜色只用于焦点、状态和少量主动作。它还规定共享工作台头部约 `52px`、常规按钮与输入约 `32px` 高、`6px` 圆角，并要求设置使用紧凑双栏覆盖层，而非整页卡片堆叠（同文档 `Workspace`, `Settings Dialogs`, `Anti-Patterns` 段落）。

| 决策 | 为什么 Tutti 这样 | Mobius 现在怎样 | 我们改成怎样 |
|---|---|---|---|
| 工作台只保留一个视觉主动作 | 高饱和色只标识真正向前的动作 | 顶栏、卡片、Chip、状态和入口同时强调 | 每屏最多一个实心主按钮；其余使用文字、图标或中性描边 |
| 设置用紧凑覆盖层 | 设置是偶发任务，完成后应回到原上下文 | 相关入口散在主题菜单、用户菜单、项目页和管理 Overlay | 合并为统一“设置/更多”覆盖层，记住返回位置 |

### 2.6 不采用 Cursor 的结构作为目标

`Cursor界面详解.md` 中的 Activity Bar、资源管理器、编辑器、AI 侧栏、底部面板和状态栏，服务的是高密度 IDE 工作流。Mobius 可以借鉴快捷搜索和可折叠面板，但默认用户不是先来管理文件与面板，而是来委派任务。因此不复制 Cursor 的“左活动栏 + 中编辑器 + 右 AI + 底部终端”，编辑器只作为会话中的按需工具。

## 3. 目标体验：新用户 60 秒路径

目标不是让用户在 60 秒内理解 Mobius，而是让用户在 60 秒内完成一次真实委派，并能知道结果会在哪里继续。

### 3.1 首次登录路径

```text
登录成功
  ↓ 自动进入 /u/:user，无模式弹窗
首页空态：创建第一个项目
  ↓ 只填项目名；本地目录可选
创建成功并进入统一工作页
  ↓ 输入“帮我检查这个项目并告诉我从哪里开始”
发送
  ↓ 前端沿用现有接口创建默认 Issue + Session，并提交消息
会话时间线开始更新；左侧“最近会话”出现该条记录
```

目标时限和操作数：

- 从登录成功到看到可行动界面：2 秒内，不出现模式选择。
- 创建第一个项目：一个表单、一个必填字段、最多两次点击。
- 项目创建后：焦点自动进入 Composer；输入并发送即开始，不再弹模型或 Session 配置。
- 从登录成功到发出第一条消息：正常网络下 60 秒内，且不要求理解 Issue、Research、Skill、Memory、worktree。

### 3.2 已有项目用户路径

```text
/u/:user
  ├─ 直接在主 Composer 输入 → 使用“最近使用项目”上下文
  ├─ 从项目选择器换项目 → 输入并发送
  └─ 从左侧最近会话点一条 → /u/:user/s/:session
```

首页不自动打开上次会话，避免用户一登录就落入未知运行现场；但主 Composer 默认带上“最近使用项目”，并允许一键切换。

### 3.3 决策说明

| 决策 | 为什么 Tutti 这样 | Mobius 现在怎样 | 我们改成怎样 |
|---|---|---|---|
| 登录后直接到可输入空态 | Tutti 的空态 Composer 本身就是开始入口 | `/u/:user` 先进入项目管理；首次还可能被模式弹窗拦截 | `/u/:user` 主区直接展示项目上下文和 Composer |
| 创建 Session 不再是独立向导 | Tutti 以提交意图创建/激活会话 | Mobius 可先建项目、再建 Issue、再开 Session、再发消息 | “发送第一条消息”串联内部对象创建；失败时在原地分步骤报错并可重试 |
| 项目仍是默认可见对象 | Mobius 的路径、权限、Memory/Skill 默认值都以项目为重要边界，不能完全隐藏 | 项目既是权限边界，又被做成重型管理首页 | 项目只作为 Composer 上下文和最近项目；管理细节放项目设置 |

## 4. 目标信息架构（比现在少几层对象/模式）

### 4.1 默认信息架构

```text
Mobius
├─ 首页 /u/:user
│  ├─ 开始新任务（Composer）
│  ├─ 最近会话
│  └─ 最近项目 / 全部项目
├─ 会话 /u/:user/s/:session
│  ├─ 时间线
│  ├─ Composer
│  └─ 按需工具：文件、编辑器、运行详情
└─ 设置/更多
   ├─ 通用与外观
   ├─ 项目与上下文
   ├─ 连接与客户端
   └─ 高级能力
```

默认可见对象从“User → Project → Issue/Research → Session”四层，缩成“Project → Conversation”两层：

- User 仍存在于鉴权和 URL 中，但不作为一个需要操作的界面层。
- Project 仍是权限、路径和默认上下文边界。
- Conversation 是用户真正继续工作的单位，对应现有 Session。
- Issue 继续作为后端任务容器和高级项目管理对象，但默认导航不要求先进入它。
- Research 及其团队语义保持不变，只从默认路径移到高级入口。

### 4.2 路由策略

| 路由 | 目标角色 | 迁移处理 |
|---|---|---|
| `/u/:user` | 唯一默认首页 | `UserPage` 改为轻量 Home；不再因 `layout_mode` 重定向 |
| `/u/:user/s/:session` | P1 新增的默认会话地址 | 前端用现有 `/api/tasks/:id` 等接口还原 Project、Issue/Research 上下文；不要求后端新增实体 |
| `/u/:user/easy_mode` | 兼容地址 | P0 保留；P1 根据 `session` 跳到 `/s/:session`，否则跳 `/u/:user` |
| `/u/:user/p/:project` | 高级“项目详情” | 保留，入口从首页“全部项目/项目设置”进入，不是首条消息必经页 |
| `/u/:user/p/:project/i/:issue?session=:session` | 旧深链与高级任务页 | 有 `session` 时逐步规范化到 `/s/:session`；无 `session` 时保留任务管理语义 |
| `/u/:user/p/:project/r/:research?session=:session` | 研究高级页/旧深链 | Research 页面保留；默认不展示。研究 Session 可按产品验证结果决定是否规范化到统一会话页 |
| `/u/:user/mobius_overview`、`/mobius_overview_cluster` | 系统可视化 | 保留直达能力，移动到“更多 → 高级 → 系统可视化” |
| `/welcome` | 连接本机、导入和迁移向导 | 不再作为普通首次使用入口；从“新建项目 → 导入/连接已有项目”进入 |

P0 不必等待 `/s/:session`。可先在旧 Issue 路由内完成视觉简化，并保证旧收藏链接继续工作；P1 再建立短路由和兼容重定向。

### 4.3 决策说明

| 决策 | 为什么 Tutti 这样 | Mobius 现在怎样 | 我们改成怎样 |
|---|---|---|---|
| 会话获得稳定短地址 | Tutti 的中心是 active conversation，宿主细节不进入用户心智 | Session 依赖 Project + Issue/Research 路径和 query 参数才能表达 | 新增 `/u/:user/s/:session` 作为默认深链；旧路由继续兼容 |
| 后端对象不随 UI 简化而删除 | Tutti 将宿主模式和 AgentGUI 状态分开拥有 | Mobius 的 Issue/Research 已承载权限、执行和生命周期 | 只减少默认呈现层级，继续创建和维护原对象，不改 harness 后端 |
| 高级页面继续可达但退出主导航 | Tutti 的 OS workbench 保留完整代码路径 | Mobius 把高级总览、研究、管理与日常会话并列 | 设置/更多提供二级入口；直接 URL 与权限逻辑保持 |

## 5. 目标布局 ASCII

以下布局描述的是信息优先级，不是像素级线框。桌面宽度小于可容纳左栏时，Conversation Rail 收起为顶部“历史”按钮；不增加底部第三导航体系。

### 5.1 默认首页（登录后）

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Mobius                     搜索                         设置  ···  头像 │ 48–52
├──────────────────┬───────────────────────────────────────────────────────┤
│ + 新会话         │                                                       │
│ 搜索会话         │                    想让 Mobius 做什么？               │
│                  │                                                       │
│ 今天             │   ┌───────────────────────────────────────────────┐   │
│  会话标题        │   │ 描述你的任务…                                 │   │
│  项目名 · 状态   │   │                                               │   │
│ 昨天             │   │  项目：最近使用项目 ▾      附件          发送 │   │
│  会话标题        │   └───────────────────────────────────────────────┘   │
│                  │                                                       │
│                  │   最近项目                                            │
│                  │   项目 A        项目 B        全部项目 →              │
│                  │                                                       │
│                  │   [无项目时仅显示：创建第一个项目]                    │
├──────────────────┴───────────────────────────────────────────────────────┤
│ 左栏底部：设置。桌面客户端特有状态不常驻，只在异常时显示单条提示。       │
└──────────────────────────────────────────────────────────────────────────┘
```

布局规则：

- 页面只允许一个实心主动作：无项目时是“创建第一个项目”，有项目时是 Composer 的“发送”。
- 最近项目最多显示 3 个，不在首页展开 Issue/Research/Session 子树。
- 左栏的会话按时间分组，行内只显示会话标题、项目名和必要状态；对象类型不做一级分组。
- 搜索结果仍可命中 Project、Issue、Research 和 Session，但结果统一以“可继续的会话”或“可打开的高级对象”呈现。

### 5.2 默认会话页（干活页）

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Mobius  /  项目 A ▾  /  会话标题                     工具  设置  ···   │ 48–52
├──────────────────┬───────────────────────────────────────────────────────┤
│ + 新会话         │  用户消息                                             │
│ 搜索会话         │  Agent 回复                                            │
│                  │  工具调用摘要（默认折叠，可展开）                      │
│ 今天             │  Agent 回复                                            │
│ ● 当前会话       │                                                       │
│   运行中         │                                                       │
│  其他会话        │                                                       │
│                  │  ┌─────────────────────────────────────────────────┐  │
│                  │  │ 继续输入…                                      │  │
│                  │  │ +附件   @上下文   高级设置 ▾              发送 │  │
│                  │  └─────────────────────────────────────────────────┘  │
└──────────────────┴───────────────────────────────────────────────────────┘
                                      ┌───────────────────────┐
按“工具”后才出现，可关闭：             │ 文件 / 编辑 / 运行详情 │
                                      └───────────────────────┘
```

布局规则：

- 默认没有右栏，没有 SessionOverview 统计卡，也不先展示项目文件卡。
- Composer 在空态和有消息状态中保持同一水平位置；切换会话不改变操作语法。
- 工具调用详情、模型、Skill/Memory、编辑器布局均按需展开；当前状态用一行摘要表达。
- 新会话默认继承当前项目。切换项目是上下文变化，不是切换整套页面模式。

### 5.3 设置/更多（所有被拿掉的入口去哪）

```text
                         ┌────────────────────────────────────────────┐
                         │ 设置                                  ×  │
                         ├──────────────┬─────────────────────────────┤
                         │ 通用         │ 语言、启动行为、通知         │
                         │ 外观         │ 明/暗主题、密度、背景效果     │
                         │ 项目与上下文 │ 路径、Memory、Skills、成员    │
                         │ 连接         │ AIMUX、桌面端、CLI、移动端    │
                         │ 高级         │ Research、编辑布局、系统总览  │
                         │ 管理员*      │ 运行监控、用户与系统配置       │
                         ├──────────────┴─────────────────────────────┤
                         │ 帮助 · GitHub · 版本与资源状态             │
                         └────────────────────────────────────────────┘
                         * 仅管理员可见
```

“更多”是当前上下文动作，不是第二套设置中心：

- 会话更多：重命名、复制链接、归档、删除、打开任务详情。
- 项目更多：全部项目、项目设置、成员、版本、系统剖析、待办、打包。
- 高级工具：用编辑器打开、文件浏览、Research、系统可视化。

| 决策 | 为什么 Tutti 这样 | Mobius 现在怎样 | 我们改成怎样 |
|---|---|---|---|
| 只保留一条历史轨 | Tutti 的 Conversation Rail 位置稳定且可折叠 | Shell、Issue、Easy 各自实现历史树 | 抽成唯一 `ConversationRail`，首页与会话页复用 |
| 默认不常驻工具面板 | Tutti 工具侧栏按需打开，详情区保持主位 | Mobius 通过三种工作区模式改变主布局 | 默认固定“历史 + 会话”；文件/编辑器在右侧抽屉临时出现 |
| 设置收敛为一个覆盖层 | Tutti 将设置做成紧凑 workbench overlay | Mobius 设置散落在主题菜单、用户菜单、项目页和 Admin Overlay | 一个设置入口，按权限和上下文展示分类；关闭后回原会话 |

## 6. 默认主路径只保留什么

默认 UI 只保留下列六项能力：

1. **选择或创建项目**：项目是必要上下文，但只要求名称；本地目录可选。
2. **输入并发送任务**：首页和会话页的中心动作。
3. **查看并继续会话**：统一 Conversation Rail，按时间排列。
4. **查看必要执行状态**：运行中、等待输入、完成、失败；状态就近显示，不做独立仪表盘。
5. **搜索**：默认搜会话；“全部结果”才扩展到项目、Issue、Research 和内容。
6. **设置/更多**：承接低频与高级能力，任何默认页面最多两次点击可达。

默认主路径的产品用词统一为：

| 现有词 | 默认 UI 用词 | 说明 |
|---|---|---|
| Session | 会话 | 用户继续工作的最小单位 |
| Issue | 任务详情（高级） | 不在新手路径要求理解；默认新建时内部自动创建 |
| Research / Research Agent | 研究 / 研究智能体（高级） | 保留原语义，只退出默认创建和导航 |
| Easy Mode / Normal Mode | 不显示 | 统一为一套默认工作台 |
| Session / Editor Chat / Code Conversation | 会话；“用编辑器打开” | 从模式选择改为当前会话的工具动作 |

| 决策 | 为什么 Tutti 这样 | Mobius 现在怎样 | 我们改成怎样 |
|---|---|---|---|
| 状态就近而非单独总览 | Tutti 会话轨和会话详情直接表达活动状态 | 首页与会话页都有总览、卡片和系统可视化入口 | 默认只在会话行和时间线顶部显示必要状态；完整监控后置 |
| 搜索先服务于继续工作 | Tutti 的会话轨围绕 conversation 选择 | Mobius 层级搜索覆盖项目/任务/会话并直接展示树 | 输入时先返回会话；高级对象结果放“更多结果”并标注类型 |
| 编辑器是动作，不是持久模式 | Tutti 的宿主工具可打开，不改变 AgentGUI 的主语义 | `WorkspaceLayoutToggle` 暴露三种布局模式 | “工具 → 用编辑器打开”，关闭后回到同一会话和草稿 |

## 7. 从默认 UI 拿掉什么（按钮/模式/页面），以及藏到哪里

这里的“拿掉”默认指“不在默认表面渲染”，不是删除组件、接口或数据。

| 当前入口/能力 | 默认 UI 处理 | 新位置或兼容方式 |
|---|---|---|
| 首次 `LayoutModeChoiceModal` | 不渲染 | 无替代；直接使用统一默认工作台 |
| 主题菜单内“简易/常规模式” | P0 隐藏，P1 删除用户可见概念 | 迁移期可放“设置 → 高级 → 使用旧版项目视图”，只给回退，不作为模式教育 |
| `/u/:user/easy_mode` 独立页面身份 | P1 取消 | 作为兼容路由跳转到首页或 `/s/:session` |
| `GlobalCreateMenu` 四类创建 | 顶栏只保留“新会话” | 新项目在首页项目选择器；Issue 在项目详情；Research Agent 在 Research 高级页 |
| Welcome 六类入口与多步主流程 | 不作为默认首次页 | “新建项目”提供“空项目 / 连接本地 / 导入资料”三个次级选项；复杂流程继续由 `/welcome` 承载 |
| TopNav 多层面包屑下拉 | 缩为 Logo、项目上下文、会话标题 | 完整 User/Project/Issue/Research 层级放“更多 → 打开详情” |
| Shell 系统可视化按钮 | 不渲染 | “设置/更多 → 高级 → 系统可视化”，保留现有两条路由 |
| 顶栏 GitHub、帮助 | 不渲染 | 设置页底部“帮助与反馈” |
| 磁盘、内存、版本常驻指标 | 正常时不渲染；异常时显示一个状态提示 | “设置 → 系统状态”；管理员可进入运行监控 |
| 大型主题下拉、背景流、主题工坊 | 顶栏不渲染 | “设置 → 外观”；主题工坊归“高级外观” |
| 助手气泡 `AssistantChat` | 新用户默认关闭，不与主会话形成第二个聊天入口 | “设置 → 通用 → 快捷助手”；保留用户已开启的迁移值需单独评审 |
| `WorkspaceLayoutToggle` | 默认不渲染 | “工具 → 用 VSCode 打开 / 用原生编辑器打开”；不可用时不给占位按钮 |
| UserPage 左栏 Memory、Skills、数据、监控、配置 | 首页不渲染 | Memory/Skills 到“设置 → 项目与上下文”；数据/监控/配置按权限放“高级/管理员” |
| 项目卡片上的全部 Badge、状态与嵌套任务列表 | 首页只显示最近项目名称和最近活动 | `/u/:user/p/:project` 的“项目详情”保留完整信息 |
| ProjectPage 左栏任务、研究、设置七类 Tab | 退出默认路径 | 项目更多菜单进入高级项目详情；页面本身保留 |
| IssuePage “任务会话 / 近期会话”双标签 | 合并 | 使用全局 Conversation Rail；当前项目作为筛选 Chip 而非独立树 |
| `SessionOverview` 的统计卡、创建卡和 `ProjectFilesCard` | 默认不渲染 | 无会话时直接显示 Composer；文件在“工具 → 文件” |
| ResearchPage 的 Blackboard、Graph、团队管理 | 默认不渲染 | “更多 → 高级 → Research”或项目详情的“研究”区；原路由保留 |
| `TourController` 全局巡游 | 不自动进行全界面导览 | 只在用户第一次触发“工具/Research”等高级动作时显示一条上下文提示 |
| `DesktopTabBar` | 默认会话表面不主动占据一层导航 | 桌面端多窗口/多标签能力保留在桌面菜单或“在新窗口打开”；需先验证桌面依赖再调整 |

### 决策说明

| 决策 | 为什么 Tutti 这样 | Mobius 现在怎样 | 我们改成怎样 |
|---|---|---|---|
| 低频入口不是删掉，而是分层 | Tutti 保留完整 OS 路径和工具宿主，但 Agent 主表面不同时展示 | Mobius 的低频入口大多与会话主动作同级 | 后端和高级页面保留，通过设置/更多二级可达；默认 DOM 尽量不渲染 |
| 不再提供两个聊天入口 | Tutti 的主 AgentGUI 是唯一对话中心 | `ChatArea` 与全局 `AssistantChat` 气泡可同时出现 | `ChatArea`/统一 WorkPage 是默认中心；助手气泡为显式启用的快捷能力 |
| 不显示不可用的高级按钮 | Tutti 侧栏按能力和激活状态打开 | 编辑布局按钮可出现后再解释缺路径、缺服务 | 默认隐藏；用户从工具菜单请求时再说明前置条件和解决办法 |

## 8. 组件映射：现有文件 → 新表面（保留改 / 降级 / 默认不渲染）

状态定义：

- **保留改**：继续承担默认路径，需要改造结构或职责。
- **降级**：能力与路由保留，但退出默认入口。
- **默认不渲染**：默认工作台 DOM 中不挂载；通过设置、更多、权限或兼容链接进入。

| 现有文件/组件 | 状态 | 新表面与改造要求 |
|---|---|---|
| `mobius/frontend/src/App.tsx` | 保留改 | 去掉 `layoutModeTargetPath` 对默认路径的阻断；新增 `/u/:user/s/:session`；高级页继续懒加载；全局 Overlay 仅按需要挂载 |
| `components/layout-mode-choice-modal.tsx` | 默认不渲染 | P0 停止调用；保留一个版本周期用于回滚，P1 删除或仅留迁移测试 |
| `services/layout-mode.ts` | 降级 | P0 只读旧值做兼容分析，不控制默认路由；P1 提供一次性 URL/偏好迁移后移除模式语义 |
| `components/shell.tsx` / `TopNav` | 保留改 | 拆成紧凑 `WorkbenchHeader`、统一 `ConversationRail` 和 `SettingsPanel`；顶栏只保留项目上下文、搜索、工具、设置/更多 |
| `components/shell.tsx` / `RecentSessionsPanel` | 保留改 | 提取为唯一会话轨；去掉默认的 Project → Issue/Research → Session 展开树，改为时间分组和项目副标题 |
| `pages/UserPage.tsx` | 保留改 | 从项目管理总览改为默认 Home：主 Composer、最近会话、最近项目、无项目空态；完整项目列表放二级“全部项目” |
| `pages/EasyModePage.tsx` | 保留改后取消模式身份 | P0 可作为统一工作页原型，复用其最近会话加载和 `ChatArea layout="easy"`；P1 抽成 `WorkPage` 或重命名，移除 mode 跳转和 easy 专属 query 语义 |
| `pages/Welcome.tsx` | 降级 | 保留连接本机、导入和路径复用流程；不承担普通首次登录。项目/Session 高级字段继续折叠 |
| `pages/ProjectPage.tsx` | 降级 | 定位为“项目详情/管理”；Issue、Research、成员、版本、架构、待办、打包入口保留，但不出现在默认首页左栏 |
| `components/project-page/ProjectItemsPanel.tsx`、`ProjectSettingsPanel.tsx` | 降级 | 仅在高级项目详情加载；设置可从统一 SettingsPanel 深链到对应 Pane |
| `pages/IssuePage.tsx` | 保留改/兼容 | P0 先简化为统一会话布局；P1 有 Session 时跳短路由，无 Session 时作为高级任务详情。移除默认双会话标签和 `SessionOverview` 卡片 |
| `pages/ResearchPage.tsx` | 默认不渲染 | 原路由与团队/Blackboard/Graph 功能保留；只能从项目详情、更多或直达链接进入 |
| `components/chat.tsx` / `ChatArea` | 保留改 | 以现有 `layout="easy"` 的低干扰 Composer 为基础统一默认样式；移除 easy/standard 产品分叉，只保留必要的紧凑/工具嵌入差异 |
| `components/global-create.tsx` | 保留改 | 复用现有四类表单和接口；默认入口只暴露 Project/Conversation，Issue/Research 创建器由高级页面调用 |
| `components/workspace/workspace-layout-toggle.tsx` | 默认不渲染 | 逻辑转成会话“工具”菜单动作；`editor-chat` 与 `code-conversation` 状态仍可复用，不能成为新手必须选择的模式 |
| `components/assistant-chat.tsx` | 默认不渲染 | 仅用户显式开启后懒加载；文案需说明它是快捷助手，不是当前项目会话 |
| `TourController` | 降级 | 改为事件触发的单点提示，不在登录后自动串行介绍所有区域 |
| `DesktopTabBar` | 降级 | 桌面端能力保留；默认工作面只在存在多个显式打开的标签时显示，避免空占一层 |
| `MobiusOverviewPage`、`MobiusOverviewClusterPage`、`AdminPanel` | 默认不渲染 | 从高级/管理员入口按权限懒加载，保留旧 URL 和 `window.openAdminOverlay` 兼容 |

### 组件边界建议

新增或抽取前端组件时，职责保持单一：

```text
WorkbenchShell
├─ WorkbenchHeader          只处理全局上下文与少量动作
├─ ConversationRail        唯一历史列表、搜索、选择、新会话
├─ HomeSurface             首页空态、最近项目、首页 Composer
├─ ConversationSurface     时间线、Composer、状态摘要
├─ ToolDrawer              文件/编辑器/运行详情，默认关闭
└─ SettingsPanel           统一设置覆盖层
```

不要让 `WorkbenchShell` 再次吸收创建表单、主题编辑器、Admin 内容和业务树。Shell 只负责组合与显隐，各能力按需懒加载。

| 决策 | 为什么 Tutti 这样 | Mobius 现在怎样 | 我们改成怎样 |
|---|---|---|---|
| 一个事实一个 UI 所有者 | Tutti 的架构把 AgentGUI、宿主工具和偏好所有权分开 | 最近会话、模式和创建逻辑分散在多个页面 | 会话轨归 `ConversationRail`，设置归 `SettingsPanel`，会话详情归 `ConversationSurface` |
| 复用现有能力，不做大爆炸重写 | Tutti 的 Agent/OS 两条路径通过宿主边界组合 | Mobius 已有稳定的 API、`ChatArea`、表单和高级页面 | P0 以重组和默认不渲染为主；P1 才统一路由与组件身份 |

## 9. 分阶段落地

### P0 先让首页和会话页变简单（不删后端）

目标：不等待数据模型或 harness 变更，先让首次登录、首页和 Issue 会话页形成一条可用主路径。

1. `App.tsx` 不再因为缺少 `layout_mode` 渲染 `LayoutModeChoiceModal`；默认进入 `/u/:user`。
2. `UserPage` 首屏改为 HomeSurface：无项目时只显示最小项目创建，有项目时显示 Composer、最近会话和最多 3 个最近项目。
3. `shell.tsx` 精简默认顶栏；系统可视化、GitHub、资源指标、主题工坊、管理和下载入口移进统一设置/更多。
4. 从 `EasyModePage` 和 `RecentSessionsPanel` 复用加载逻辑，先建立一条统一的时间型会话列表；IssuePage 不再另设“任务会话/近期会话”双标签。
5. `IssuePage` 有 `?session` 时直接显示 ChatArea；无 Session 时显示带 Composer 的会话空态，不展示统计卡和 `ProjectFilesCard`。
6. 顶栏默认只提供“新会话”；项目、Issue、Research 的原创建表单和接口全部保留，高级页面仍可调用。
7. `WorkspaceLayoutToggle`、Research、Overview、Cluster、Admin、主题工坊默认不渲染，但旧路由与直接入口保持可用。
8. 增加最小埋点/日志：到达 Home、创建项目、首次发送、打开历史、打开设置、打开高级入口；用来验证删入口后是否造成任务不可达。

P0 的退出标准：新账号不选模式即可创建项目并发出消息；旧 Issue/Research 深链可打开；后端 API、对象和执行流程没有删除。

### P1 统一 easy/normal，减少对象层级

目标：从“两个页面看起来相似”变成“一套工作台组件和一套默认路由”。

1. 新增 `/u/:user/s/:session`，用 Session ID 还原所属 Project、Issue 或 Research 上下文。
2. 将 `EasyModePage` 的会话加载、IssuePage 的深链恢复、Shell 的历史搜索合并到 `WorkPage + ConversationRail`；删除 easy/normal 的渲染分叉。
3. `/easy_mode` 和带 `?session` 的旧 Issue 路由进行前端兼容跳转；复制链接默认生成短路由。
4. 默认创建流程变为 Project → Conversation；前端继续使用现有接口创建默认 Issue 和 Session。Issue ID 可在更多/详情中查看，不进入主标题和主导航。
5. 统一 Session 创建：首页发送、新会话按钮、项目内新会话调用同一 orchestration，继承项目默认模型、语言、Skill/Memory 和 worktree 策略。
6. ProjectPage 明确改名/定位为“项目详情”，ResearchPage 明确标为“高级研究工作台”。
7. `layout-mode.ts` 完成一次性迁移后退出产品状态；不得继续新增 mode 专属逻辑。

P1 的退出标准：默认路径只出现 Project 和 Conversation；同一 Session 从首页、历史、搜索、旧链接进入后得到同一工作面和同一 URL。

### P2 视觉语言与 Tutti workbench 纪律对齐

目标：在结构简化稳定后统一密度和层级，避免只做“隐藏按钮”却保留杂乱视觉。

1. Workbench Header 高度统一到 48–52px；常规控件 32px、6px 左右圆角；只为主动作使用高饱和填充。
2. 左栏、主区、抽屉通过细边界和轻微表面差建立层级，取消大面积重阴影、渐变和过度卡片化。
3. 首页可以比会话页更轻，但二者使用同一字体、控件和 Composer 语言；不能每个高级模块建立自己的视觉方言。
4. 设置改为紧凑双栏 Overlay；桌面建议左侧分类约 160px，移动端改为列表钻取。
5. 状态色只表达运行、等待、完成、失败；项目类型、普通按钮和装饰不占用状态色。
6. 对 1280px、1440px、窄桌面和移动端做截图回归；Conversation Rail 的折叠不改变 Composer 宽度上限和焦点顺序。
7. 统一键盘行为：`Cmd/Ctrl+K` 搜索、`Cmd/Ctrl+N` 新会话、`Cmd/Ctrl+,` 设置；快捷键不可成为完成基本任务的唯一方式。

P2 的退出标准：默认首页和会话页在无说明截图中能一眼识别唯一主动作；设置和高级工具关闭后不会遗留空栏、模式提示或重复导航。

### 分期决策说明

| 决策 | 为什么 Tutti 这样 | Mobius 现在怎样 | 我们改成怎样 |
|---|---|---|---|
| 先改默认呈现，再统一数据与路由 | Tutti 用宿主边界保留完整能力路径 | Mobius 的前后端对象已被多处依赖，直接删风险高 | P0 只重组和隐藏；P1 合并页面/路由；P2 收视觉规范 |
| 兼容旧深链 | Tutti 的 OS/Agent 路径并存且有明确路由归属 | Mobius 的收藏和通知可能指向长 Issue/Research URL | 旧 URL 可继续打开，默认复制与新导航逐步使用短路由 |
| 视觉改造放在结构之后 | Tutti 视觉规则依赖清晰的 Launcher/Workspace 角色 | Mobius 当前同一页面承担太多角色，先换皮仍会复杂 | 先决定“什么不出现”，再调整间距、颜色、圆角与动效 |

## 10. 验收标准（新用户任务：创建项目、发第一条消息、找到历史会话、找到设置）

以下任务必须用未写入 `layout_mode`、没有项目的新账号测试；另用已有项目和旧深链账号做回归。

### 10.1 创建项目

- 登录后直接到 `/u/:user`，不出现“选择简易/常规模式”。
- 首屏无需滚动即可看到“创建第一个项目”。
- 默认表单只有项目名称必填，本地目录可选；Research、成员、模型、Skill/Memory、worktree 不在默认展开区。
- 从点击创建到进入可输入状态最多一个表单和一次确认；成功后 Composer 自动获得焦点。
- “连接本地项目/导入资料”仍可在新建项目的次级入口找到，不与空项目创建并列成六个大卡片。

### 10.2 发第一条消息

- 项目创建完成后无需再创建或选择 Issue、Session、模型或布局模式。
- 输入消息并按 Enter/发送后，界面立即进入会话时间线；慢请求显示单一进度，不连续弹出多个成功 Dialog。
- 前端内部创建的 Issue 和 Session 可在后续项目详情中找到，执行状态和后端行为不变。
- 创建任一中间对象失败时，保留用户原始输入和已创建对象；错误信息说明失败阶段并提供原地重试，不能让用户从头填表。
- 正常网络下，从登录成功到首次消息提交不超过 60 秒。

### 10.3 找到历史会话

- 1280px 及以上宽度，历史会话在首页和会话页左侧直接可见；无需先进入项目或 Issue。
- 左栏折叠或窄屏时，从顶部“历史”一次点击打开。
- 新发出的会话在列表中 2 秒内出现，显示会话标题、项目副标题和必要状态。
- 点击会话只更新中心工作面和 URL，不切换 easy/normal，不重复挂载两套侧栏。
- 搜索会话标题、Session ID 或项目名能定位该会话；Issue/Research 命中作为带类型的高级结果，不重新展开整棵树。

### 10.4 找到设置

- 任一默认页面从齿轮或头像最多两次点击进入设置。
- 外观、项目上下文、AIMUX/客户端、系统状态各有唯一归属，不同时出现在主题菜单和用户菜单。
- 关闭设置回到原会话、原滚动位置和未发送草稿。
- 管理员入口只对管理员显示；Research、系统总览、集群监控、主题工坊均可从“高级”找到，但不出现在新手主路径。

### 10.5 结构、可访问性和回归

- 默认首页和默认会话页各只有一个视觉主动作。
- 只用键盘可以依次到达历史、新会话、Composer、工具和设置；Overlay 打开后正确圈定焦点，Escape 关闭并回到触发器。
- 旧 `/u/:user/p/:project/i/:issue?session=...`、Research、Overview、Cluster 和 `/welcome` 链接仍可工作或得到明确兼容跳转。
- 切换/打开编辑器工具时，当前 ChatArea、SSE、草稿和 Session 不重挂；沿用 IssuePage 当前“保持 ChatArea 兄弟索引稳定”的约束。
- 后端 Project、Issue、Research、Session 接口及 harness 行为没有因界面简化而删除或改义。

| 决策 | 为什么 Tutti 这样 | Mobius 现在怎样 | 我们改成怎样 |
|---|---|---|---|
| 用任务完成验证，不以按钮数量验收 | Tutti 的简单来自清晰主路径，不只是少控件 | 仅数隐藏按钮可能把必要能力一起藏丢 | 四个新手任务都设可达性、操作数和状态保持标准 |
| 兼顾熟练用户回归 | Tutti 保留宿主工具和 OS 路径 | Mobius 高级能力已有实际使用者 | 高级能力两级内可达、旧链接兼容、权限与执行语义不变 |

## 11. 明确不做：不要重做成 Tutti OS/Dock/Launchpad；不要在本轮改 harness 后端

本方案明确不包含：

- 不实现 Tutti 的 OS 桌面、Dock、Launchpad、窗口管理、Provider Rail 或应用中心。
- 不把 Mobius 改成 Tutti 的信息模型；Project、Issue、Research、Session 仍由 Mobius 现有领域模型负责。
- 不复制 Cursor 的 Activity Bar、资源管理器、编辑器中心、AI 右栏、底部终端和状态栏组合。
- 不在本轮删除 Project/Issue/Research/Session 接口，不修改 harness 调度、执行、权限、Research 团队或持久化语义。
- 不为“看起来简单”制造第三套新版/旧版切换；迁移开关只允许短期回退，不进入长期产品概念。
- 不在 P0 重写 `ChatArea` 的消息协议、SSE、工具执行或 Agent 状态同步。
- 不把高级能力永久埋藏。它们应有可搜索、可深链、按权限展示的明确二级入口。
- 不以大面积换色、加动画或重做品牌视觉代替信息架构简化。

| 决策 | 为什么 Tutti 这样 | Mobius 现在怎样 | 我们改成怎样 |
|---|---|---|---|
| 借工作台纪律，不借 OS 外壳 | Tutti 的 OS 能力由自己的宿主架构支撑 | Mobius 已有 Web/桌面 Shell 和领域路由 | 只采用空态、会话中心、按需工具、克制视觉四条原则 |
| 前端简化不牵动 harness | Tutti 的模式方案也强调所有权边界 | Mobius harness 已承担执行和对象语义 | 本轮把变化限制在前端路由、组合、默认显隐和文案 |

### 下一步实现任务

以下任务按文件拆分，建议按顺序开工；每项单独提交和评审，避免把结构、路由和视觉混成一次大改。

1. **取消首次模式阻断**：修改 `mobius/frontend/src/App.tsx`，停止默认渲染 `LayoutModeChoiceModal`；为 `/u/:user` 和旧深链补路由测试。`services/layout-mode.ts` 暂保留为迁移读取，不删除用户数据。
2. **建立轻量首页**：改 `mobius/frontend/src/pages/UserPage.tsx`，首屏替换为 HomeSurface；把现有完整项目列表封装成“全部项目”二级区，保留项目卡片逻辑。
3. **收敛 Shell**：拆改 `mobius/frontend/src/components/shell.tsx`，形成紧凑 Header、统一设置入口和高级“更多”；默认移出可视化、资源指标、GitHub、主题工坊、下载和管理按钮。
4. **统一历史轨**：从 `shell.tsx` 的 `RecentSessionsPanel`、`EasyModePage.tsx` 和 `IssuePage.tsx` 提取 `ConversationRail`；统一时间分组、搜索、当前项和项目副标题，删除三套重复树形渲染。
5. **简化默认会话页**：修改 `mobius/frontend/src/pages/IssuePage.tsx`，有 Session 直接进 ChatArea，无 Session 显示 Composer 空态；默认不渲染双标签、统计卡和 `ProjectFilesCard`。
6. **统一 Composer 视觉和行为**：修改 `mobius/frontend/src/components/chat.tsx`，把 `layout="easy"` 的低干扰形态提升为默认；保证切换会话/工具不丢草稿、不重挂 SSE。
7. **简化创建动作**：修改 `mobius/frontend/src/components/global-create.tsx`，默认只暴露项目和会话；新增复用现有接口的“项目 → 默认 Issue → Session → 首条消息”编排，并实现分阶段重试。
8. **降级 Welcome**：修改 `mobius/frontend/src/pages/Welcome.tsx`，保留连接本地、导入和复用路径能力，但移出普通首次登录；默认项目表单只要求名称。
9. **新增统一会话路由**：在 `App.tsx` 增加 `/u/:user/s/:session`，将 `EasyModePage.tsx` 重构为无模式身份的 WorkPage；在 `services/layout-mode.ts` 或独立迁移服务中实现 `/easy_mode` 与旧 Issue Session URL 的兼容跳转。
10. **工具动作代替布局模式**：修改 `components/workspace/workspace-layout-toggle.tsx` 及相关 workspace 组件，把三模式入口改为 ToolDrawer 中的“用编辑器打开”，保留现有 availability 判断和状态保持。
11. **高级页重新定位**：修改 `pages/ProjectPage.tsx`、`pages/ResearchPage.tsx` 及 Overview 入口文案，把它们标为项目详情/高级研究/系统可视化；验证旧 URL、权限和创建流程不变。
12. **设置与视觉验收**：抽取统一 `SettingsPanel`，迁移 `shell.tsx` 中外观、连接、系统状态和管理员入口；按 `desktop-visual-language.md` 的工作台规则调整 Header、控件和 Overlay，并补首页/会话页的桌面、窄屏、移动端截图与四项新手任务端到端测试。
