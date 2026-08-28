# 08｜能力呈现：完整，但不同时出现

## 结论

让用户感觉 Mobius 能力完整，不等于把能力目录放在首屏。更有效的做法是让能力在“需要它的上下文”出现：Project 与 Conversation 构成默认主路径；状态、附件与引用贴近 Composer；文件、Diff、终端、Skill、Memory、Git 进入会话工具；Issue、Research、编辑器、系统可视化进入高级页；Admin 和客户端连接进入 Settings。每个二级入口都应说明“能做什么”，而不是靠一排图标证明产品强大。

位置定义：

- **默认主路径**：Home / Rail / Session 不展开工具即可完成开始、继续、发送、停止。
- **工具抽屉**：服务当前 Session，关闭后回同一上下文。
- **设置**：跨会话偏好、资源管理、连接与权限入口。
- **高级页**：完整对象生命周期、密集管理与专业工作面。
- **不要学**：CodexMonitor 有、但 Mobius 没有对等能力或不适合作默认呈现的部分。

## 1. 能力矩阵

| Mobius 现有能力（源码入口） | 现在默认怎么暴露 | CodexMonitor 对等物或“无对等物” | 建议的呈现位置 |
| --- | --- | --- | --- |
| **Project**：Home 加载并选择项目，首发把 Project 作为上下文（`mobius/frontend/src/pages/UserPage.tsx:319-395,424-445`）；Rail 按 Project 分组会话（`components/conversation-rail.tsx:170-220,279-333`）；高级 ProjectPage 管理任务、研究和设置（`pages/ProjectPage.tsx:758-930`） | Home Composer 下拉、Rail 文件夹、TopNav crumb 常见；“全部项目”和项目详情是二级路由 | Workspace：Sidebar 选择 workspace，Home 可 Add workspace；选择 workspace 会清 thread 并回工作区语义（`examples/CodexMonitor/src/features/app/components/Sidebar.tsx:866-1014`；`features/workspaces/hooks/useWorkspaceSelection.ts:32-38`） | **默认主路径**只显示当前 Project 与 Rail 分组；**高级页**保留完整 ProjectPage。必须学“上下文稳定”，不要把 Workspace 克隆/Worktree 语义移植到 Project |
| **Conversation / Session**：统一短路由 `/u/:user/s/:session`（`mobius/frontend/src/App.tsx:391-404`）；WorkPage 还原 Issue/Research 上下文（`pages/WorkPage.tsx:29-78`）；ChatArea 保留发送、Stop、SSE/JSONL（`components/chat.tsx:2550-2714,3839-3920,4055-4097`） | Home 首发、Rail、全局搜索、完成 Toast 都能进入短路由；Session 是默认工作中心 | Thread：Sidebar 选择 thread，中心 Messages + Composer；运行时 Composer 显示 Stop/Queue/Steer（`DesktopLayout.tsx:112-219`；`Composer.tsx:253-273,580-630`） | **默认主路径核心**。必须让所有“查看/继续”统一落短路由；Mobius 保持独立 Send/Stop，不复制 Codex 的 Queue/Steer 协议 |
| **Issue**：默认 IssuePage 无 Session 时直接 Composer，有 Session 时 ChatArea；旧任务概览仍在 `LegacyIssuePage`（`mobius/frontend/src/pages/IssuePage.tsx:73-158,180-270,273-953`）；ProjectPage 负责创建与生命周期（`ProjectPage.tsx:457-471,866-910,937-949`） | 默认 Home 不要求理解 Issue；Project 高级页与旧深链仍可达 | **无对等物**；CodexMonitor thread 不要求另一个任务容器 | **高级页**：Project → 任务列表 / 任务详情；Session 内只在“上下文详情”说明归属。不要删除 Issue，也不要把它恢复成默认导航层 |
| **Research**：ProjectPage 创建/进入 Research（`mobius/frontend/src/pages/ProjectPage.tsx:469-471,780-786,950-955`）；ResearchPage 有 Agent 团队、Blackboard、Graph、会话与编辑布局（`pages/ResearchPage.tsx:26-80,320-530`） | 从 Project 高级页进入；Research 会话在统一短路由中可工作，但 Graph 短路由跳转未闭环（`components/chat.tsx:4129-4137`；`pages/WorkPage.tsx:88-110`） | **无对等物** | **高级页**保留完整 Research；研究 Session 的 **工具抽屉**提供“Graph/Blackboard/团队”上下文入口。必须修跳转，不把研究语义压成普通工具，也不放回默认 Home |
| **Skill**：会话资源快照/添加在 `SessionSkillMemoryEditor/Modal`（`mobius/frontend/src/components/session-welcome.tsx:707-835,961-1034,1169-1222`）；Settings 跳个人 Skills 管理（`components/settings-panel.tsx:170-178`） | Session `工具 → Skill`；Settings → 项目与上下文 → Skills 管理 | Composer autocomplete 可选 skill（`examples/CodexMonitor/src/features/composer/components/Composer.tsx:304-353`），没有 Mobius 的资源管理体系 | 当前会话：**工具抽屉**显示“本会话 Skill 快照”；跨会话：**设置/高级页**管理。可学 autocomplete，不要暗示修改会回写已创建 Session 的快照 |
| **Memory**：与 Skill 共用会话编辑器/Modal；个人管理由 Settings 路由进入（`mobius/frontend/src/components/session-welcome.tsx:707-835,979-1034`；`settings-panel.tsx:176-177`）；另有知识查看与沉淀动作（`advanced-session-actions.tsx:164-184`） | Session `工具 → Memory/查看知识/知识沉淀`；Settings 管理 | **无对等物** | 当前快照与当前知识放 **工具抽屉**；增删改、作用域与权限放 **设置/高级页**。知识沉淀是会话动作，Memory 管理是资源动作，两者文案/位置要分开 |
| **模型 / Harness**：Project 默认模型（`mobius/frontend/src/components/project-page/ProjectSettingsPanel.tsx:778-782,1152-1158`）；会话“修改模型并继续”创建新 Session（`components/chat.tsx:3995-4006,5068-5081`）；Admin 管理 Claude/Codex/Harness 接入（`components/panels.tsx:3285-3308,3349-4076`） | Home 不再要求选模型；Session 工具可继续到新模型；Project/Admin 管理默认与接入 | Composer MetaBar 就近选 model/reasoning/access（`examples/CodexMonitor/src/features/composer/components/ComposerMetaBar.tsx:144-273`） | 普通用户：**工具抽屉**只显示当前模型摘要 +“修改模型并继续（新会话）”；Project 默认在 **高级页**；Harness 接入只在 **Admin**。不要复制 Codex sandbox/access 语义，不改 Harness |
| **文件 / 附件**：Composer 支持粘贴、拖放、上传、预览、按 Session 保存（`mobius/frontend/src/components/chat.tsx:160-324,2240-2251,2970-3069,4580-4636`）；`@` Drawer 浏览本地/远程文件并插路径（`chat.tsx:1706-2175,3111-3153`）；会话文件修改 Modal（`chat.tsx:704-888`） | 附件藏在 Composer `＋`；键入 `@` 自动出现；文件修改在 Tools；完整项目文件树不在默认 Session | Composer attachment；Files panel + preview + Mention in chat（`examples/CodexMonitor/src/features/composer/components/ComposerInput.tsx:248-258`；`features/files/components/FileTreePanel.tsx:522-541,583-643,766-802`） | 附件 paperclip 可进入 **默认 Composer**；项目文件 / 会话文件修改 / Diff 进入 **工具抽屉**；`@` 保持按输入出现。必须学“预览后引用回 Chat”，不要学整套 Git 文件工作流 |
| **编辑器**：Issue/Research 代码对话已实现 VSCode iframe 与原生 CodeConversation，并保活挂载（`mobius/frontend/src/pages/IssuePage.tsx:286-304,847-910`；`pages/ResearchPage.tsx:40-63,434-477`） | 默认 WorkPage/精简 TopNav 没有闭环入口；能力存在于旧/高级布局条件中 | 无完整编辑器；只有文件预览、Open App、Diff center | **工具抽屉 → 用原生编辑器 / VSCode 打开**，可用时才显示；大屏可进入明确的编辑 split 或外部应用，关闭回 `/s/:session`。**不要学** Cursor 常驻 IDE，也不要把“源码存在”当作“用户已可达” |
| **终端**：会话工具打开两种模式：当前目录或 attach Agent 后台；最终挂 `WebTerminalModal`（`mobius/frontend/src/components/advanced-session-actions.tsx:133-143`；`components/chat.tsx:5084-5154`） | `工具 → 打开终端 → 选择模式`，默认不常驻 | Workspace terminal dock（`examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:221-241`） | **工具抽屉 / Dock**；窄屏继续 Modal。可学“与 Session 共存”，不必复制底部常驻面板；失败留终端内重连 |
| **Git**：会话文件 diff、Bash 记录；`SessionSkillMemoryEditor` 扫描中枢/Electron/远程计算机 Git 状态（`mobius/frontend/src/components/chat.tsx:704-888,901-1033`；`session-welcome.tsx:725-782,996-1080`） | `工具 → 查看文件修改 / 查看运行命令 / Git`，分散成多个弹层 | 强对等：右栏 Git diff、per-file、log、issues、PR 与错误 action（`examples/CodexMonitor/src/features/git/components/GitDiffPanel.tsx:640-807`） | **工具抽屉**合并“文件修改 / 仓库状态 / 命令”入口；高级 Git 操作仍交外部编辑器或高级页。**不要学** Mobius 没有的 stage/revert/commit/push/PR |
| **Admin**：全局函数打开 Admin overlay，可指定 runtime tab（`mobius/frontend/src/components/shell.tsx:1673-1702`）；Settings 仅对 admin 显示入口（`components/settings-panel.tsx:77-83,208-213`） | Settings → 管理员；默认 TopNav 无 Admin | **无对等物** | **设置 → 管理员 → 全屏高级 Overlay**。只按权限呈现；关闭回原工作台/Settings。运行状态异常可以提示，但不把 Admin 监控常驻默认 Session |
| **AIMUX / 桌面 / CLI**：Settings 提供 AIMUX、桌面、CLI、移动端 Modal（`mobius/frontend/src/components/settings-panel.tsx:182-190,219-224`）；会话内可声明可合作计算机（`advanced-session-actions.tsx:144-153`）；App 桌面条件挂 DesktopTabBar（`App.tsx:378-419`） | 全局连接入口已退出 TopNav；会话工具只显示当前协作动作；AIMUX 链路动画仅特定桌面 Session（`index.css:6132-6169`） | **无对等物**；CodexMonitor 自身是桌面宿主，但其 titlebar/panel 是产品外壳 | 下载/连接：**设置**；当前会话协作：**工具抽屉**；宿主标签/窗口：**桌面端**。不要把 AIMUX 动画、下载、CLI 恢复为默认 chrome |
| **助手气泡**：`assistantBubbleEnabled` 时 App 懒挂 `AssistantChat`（`mobius/frontend/src/App.tsx:378-419`）；Settings 可切换且明确“不是当前项目会话”（`components/settings-panel.tsx:157-164`） | 新用户默认关闭；显式开启后成为全局浮动入口 | **无对等物** | **设置 → 通用 / 外观**显式启用。启用后保持视觉次级、文案区分“快捷助手”和当前 Session；**不要学**第二套主聊天，也不要让其抢 Composer 主动作 |
| **系统可视化**：Cluster / 旧 Overview 是独立路由（`mobius/frontend/src/App.tsx:399-400`）；Settings → 高级可达；完成/失败还有全局 Toast（`components/settings-panel.tsx:194-203`；`App.tsx:251-341`） | 不在默认 TopNav；高级设置入口和通知按需出现 | Home 有 Usage，右栏有 Plan/Git；不是 Mobius 全局图谱对等物（`examples/CodexMonitor/src/features/home/components/Home.tsx:68-83`） | 图谱/总览：**高级页**；完成/失败：**就近状态 + Toast**。不要因 CodexMonitor 有 Usage 就把系统仪表盘搬回 Home |

## 2. “完整感”的呈现方法

### 2.1 入口用任务语言，不用能力清单

工具第一层只需要 5 个任务组，每组进入后再看到具体能力：

| 第一层 | 第二层能力 | 默认是否可见 |
| --- | --- | --- |
| 查看改动 | 文件修改、Diff、运行命令、Git 状态 | 有 Session 时可见 |
| 使用项目 | 项目文件、项目端口、终端、编辑器 | 具备 Project / bind path 时可见 |
| 调整上下文 | `@` 引用、Skill 快照、Memory 快照、当前知识 | 有相应能力时可见 |
| 继续方式 | 修改模型并继续、压缩上文、输入回放 | 有 Session 时可见 |
| 研究工作 | Graph、Blackboard、团队 | 仅 Research Session 可见 |

这比当前 10+ 个同级按钮网格更能表达“能力多而有序”。现有动作定义已经集中在 `advanced-session-actions.tsx:72-249`，下一轮可重组入口而不碰底层回调。

### 2.2 用可用性渐进呈现

- **可立即用**：显示动作。
- **缺上下文但可解决**：用户主动打开 Tools 后显示禁用项 + 一句解决办法，例如“设置 bind path 后可用 VSCode”。
- **角色/设备不适用**：不渲染，例如非 admin 不出现 Admin、Web 不出现桌面宿主控件。
- **已有但只影响未来**：明确标注，例如“本会话 Skill 快照；管理变更用于后续会话”。
- **没有对等能力**：不要用空入口占位，更不要借 CodexMonitor UI 发明 stage/push/approval。

### 2.3 用三处“能力地图”建立信心

1. Home 只展示 Project、Conversation 和一句“文件、终端、研究等能力会在会话中按需出现”。
2. Session 的“工具”按上下文列出真实可用动作，并记住用户最后使用的工具。
3. Settings 用“项目与上下文 / 连接与客户端 / 高级 / 管理员”覆盖跨会话能力；当前分类已具备该骨架（`settings-panel.tsx:77-83,170-213`）。

除此之外不再加“全部功能”首页、功能宫格或彩色图标墙。

## 3. 分级决策

| 分级 | 能力 |
| --- | --- |
| **必须学 CodexMonitor 的呈现纪律** | Conversation、文件预览与引用、Diff 可返回层、终端按需、状态与错误就近、Settings 覆盖上下文 |
| **可学组织方式但保留 Mobius 语义** | Project、Skill、模型摘要、Git 状态、工具 Drawer |
| **不要学 / 无对等物** | Issue、Research、Memory、Harness、Admin、AIMUX、助手气泡、系统可视化的产品语义；它们应保留 Mobius 自己的入口和名称 |

后续任务与文件落点见 [09-implementation-backlog.md](./09-implementation-backlog.md)。
