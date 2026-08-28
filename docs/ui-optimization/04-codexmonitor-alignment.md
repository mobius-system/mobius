# Mobius 与 CodexMonitor / Codex Desktop 的工作台对齐

## 1. 结论

本轮不把 Mobius 改造成 CodexMonitor，也不复制 Codex Desktop 的产品能力。对齐目标是它们的工作台纪律：左侧稳定找会话，中间持续完成工作，右侧工具按需出现，设置覆盖当前上下文。Mobius 原有的 Project / Issue / Research / Session 数据模型、Harness、Skill、Memory、文件与编辑器能力继续存在；默认入口只降低信息密度和路径层级。

默认主路径固定为：

1. `/u/:user`：选择或最小创建项目，直接输入目标，查看最近会话与最多 3 个最近项目。
2. 首次发送：沿用现有默认会话创建服务，自动建立必要的 Issue 与 Session，不让 Issue 成为新手前置步骤。
3. `/u/:user/s/:session`：直接恢复会话上下文，进入时间线与同一位置的 Composer。
4. 搜索、会话工具、设置/更多：都从当前工作台就近打开；高级页面保留显式入口。

## 2. 参考产品的默认工作流和布局职责

### 2.1 CodexMonitor

CodexMonitor 的桌面布局把侧栏作为稳定导航层，把 Home 或 Workspace 放在同一个主区域；进入 Workspace 后才渲染薄顶栏、消息/Composer、可切换的 diff 层、右侧 diff/plan 和终端。源码证据是：

- `examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:57-108` 明确定义 sidebar、home、messages、composer、diff、plan、terminal 等槽位。
- `examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:142-162` 始终保留 sidebar，在主区域二选一渲染 Home 或 Workspace。
- `examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:162-219` 把 chat/diff 作为中心工作层，而不是首页并排堆叠。
- `examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:221-241` 才挂接右侧 diff/plan 和 terminal；它们是工作期工具，不承担全局导航。

它的各区域分工如下：

| 区域 | 职责 | 对 Mobius 的启发 |
| --- | --- | --- |
| 左会话轨 | 新建、搜索、工作区/项目分组、会话列表、运行状态、设置入口 | 会话必须稳定可见，不能让项目卡、Issue 树和统计卡替代会话导航 |
| Home | 工作区入口、最近运行、添加工作区；CodexMonitor 自身还展示 usage | 只借鉴“快速进入工作”的秩序，不复制 usage 仪表盘 |
| Thread | 消息时间线、运行反馈、继续输入 | 进入 session 后中间只保留当前工作 |
| Composer | 输入、附件、必要的上下文/运行控制；复杂选项收在次级控件 | Home 和 Thread 应共享“输入即开始/继续”的心智模型 |
| 右栏工具 | diff、plan、terminal/debug 等按工作需要展开 | Mobius 的文件、编辑器、计划和高级会话动作默认关闭，从工具入口调用 |

会话组织的具体证据是 `examples/CodexMonitor/src/features/app/components/Sidebar.tsx:48-97`：线程可按 Now、Earlier today、Yesterday、This week、Older 分桶；`Sidebar.tsx:99-130` 则把搜索、活动 thread、状态和设置作为侧栏一等输入。Composer 的输入和元控件是一个连续区域（`examples/CodexMonitor/src/features/composer/components/Composer.tsx:600-701`），不要求用户先经过另一层任务表单。

需要注意：CodexMonitor 的 `Home.tsx:55-84` 还把 Latest Agents、添加工作区和 Usage 铺在首页。这是监控器产品自身的定位，不应照搬到 Mobius；Mobius 首页应该比它更轻，以大 Composer 为主。

### 2.2 官方 Codex Desktop / ChatGPT Desktop 中的 Codex

官方文档把桌面 Codex 描述为围绕 project chats 的工作区，并明确支持从侧栏搜索、固定、重命名、归档和继续 chats；新 chat 与项目上下文是主路径。参考：

- [Projects：选择项目、组织 chats、从 Recent chats 继续工作](https://learn.chatgpt.com/docs/projects)
- [Code review：diff/review pane 是可打开的审阅工具](https://learn.chatgpt.com/docs/code-review?surface=app)
- [Prompting：运行中的 steering 与 queued follow-up](https://learn.chatgpt.com/docs/prompting#steering-and-queuing)
- [Codex app 发布说明](https://learn.chatgpt.com/docs/changelog#codex-2026-02-02)

由这些交互可以抽象出本轮采用的默认纪律：

- 左侧是 project/chat 的稳定入口，不是功能大全。
- Home 的关键动作是选上下文并开始 chat；进入 thread 后中间仍是 transcript + composer。
- diff/review、计划、终端等是按需工作面，不与默认对话争夺首屏。
- 运行状态、待用户输入和队列应靠近对应 chat/composer，而不是集中到全局仪表盘。
- 设置承接低频配置，关闭后回到原 chat 或 Home。

这里对齐的是信息架构，不是官方 Codex 的账号、配额、Git 或云端执行能力。

## 3. Mobius 现状与剩余缺口（改造前审计快照）

仓库已经有一部分正确的 P0/P1 骨架，不能推倒重来：

- `mobius/frontend/src/App.tsx:352-375` 已把 `/easy_mode` 和 Issue `?session=` 深链兼容到短会话地址；`App.tsx:395-403` 已注册 `/u/:user/s/:session`。
- `mobius/frontend/src/pages/WorkPage.tsx:29-78` 已按 session 恢复 project / issue / research 上下文，`WorkPage.tsx:88-110` 已使用 `ConversationRail + ChatArea layout="easy"`。
- `mobius/frontend/src/pages/UserPage.tsx:469-570` 已具备 Home Composer、共用会话轨和最多 3 个最近项目；无项目时的最小创建表单位于 `UserPage.tsx:233-300`。
- `mobius/frontend/src/pages/IssuePage.tsx:156-270` 的默认导出已经只保留会话轨、空态 Composer 或 ChatArea；SessionOverview、ProjectFilesCard 和旧双树只留在 `LegacyIssuePage`，不进入默认路由。
- `mobius/frontend/src/components/shell.tsx:813-893` 的默认 `TopNav` 已收敛为上下文、历史、搜索、新会话、设置/更多和账户；旧 GlobalCreateMenu、WorkspaceLayoutToggle 等只存在于未挂载的 `LegacyTopNav`。
- `mobius/frontend/src/components/settings-panel.tsx:85-228` 已是统一覆盖层，Memory / Skills、AIMUX、桌面端、CLI、移动端、Overview、Welcome、主题工坊和 Admin 都有可达入口；`settings-panel.tsx:33-41` 会在关闭后恢复焦点。
- `LayoutModeChoiceModal` 已不在 `AuthenticatedApp` 的默认渲染树内；`TourController` 也只响应用户显式发起的导览事件，不会自动遮挡工作台。

以下行号记录本轮动手前的审计快照，用来说明为什么要改；第 7、8 节记录落地后的文件和验收结果。剩余缺口有明确代码落点：

1. **Home 仍把模型/Harness 当首屏决策。** `mobius/frontend/src/pages/UserPage.tsx:361-419` 为首页单独加载并选择模型组合，`UserPage.tsx:512-542` 将其与项目选择并排展示，发送还被模型加载状态阻断（`UserPage.tsx:434-454`）。默认会话服务本来能继承项目/全局默认，因此这里应删除首屏选择，继续保留后端默认解析和高级页配置。
2. **会话轨在 Home 默认折叠。** `mobius/frontend/src/components/conversation-rail.tsx:182-190` 只自动展开当前 project；Home 没有 `projectId` 时新用户看到的是项目文件夹而不是会话。运行中会话也可能被手动折叠隐藏。
3. **会话状态会陈旧。** `conversation-rail.tsx:130-144` 只在首次加载或 refreshKey 变化时请求一次，长任务开始后侧栏的运行/等待/失败状态不会就近更新。
4. **会话行缺少相对时间，搜索范围也不完整。** `conversation-rail.tsx:170-180` 只搜项目名和展示名；`conversation-rail.tsx:282-298` 只显示标题和状态，不显示相对时间，也不能按 session id 找回会话。
5. **短会话地址的顶栏丢失项目身份。** `mobius/frontend/src/components/shell.tsx:746-749` 和 `shell.tsx:840-849` 只依赖 `:project` 路由参数；`/u/:user/s/:session` 虽已在 store 中还原项目，顶栏仍不显示项目。
6. **默认会话头仍暴露 Issue/Research 中间层。** `mobius/frontend/src/components/chat.tsx:4258-4269` 显示“项目 > 任务 > 会话”，与“Issue 不作为新手必经层”冲突。默认 easy 布局应只显示项目、会话和运行状态；旧高级布局可以保留完整上下文。
7. **默认 Composer 仍暴露语音和紧急发送。** 现有发送协议不能动，但 easy 布局无需把 dictation 和执行优先级并列为常驻主动作；这些控件应仅在旧高级布局保留。

## 4. 必须学习的交互

### 会话轨

- 左侧位置稳定，顶部只有“新会话 + 搜索”。
- 允许按项目或时间组织；本轮沿用 Mobius 已实现的项目分组，避免同时引入另一套分组模式。
- 新用户默认展开项目，运行中项目强制保持展开；用户仍可折叠没有活动会话的项目。
- 会话行保持单行：标题、相对时间、运行/等待/失败状态点。项目身份由紧邻的项目分组标题承担。
- 搜索覆盖标题、session id 和项目；运行状态短轮询更新。

### Home 空态 Composer 与新会话

- 无项目时只询问项目名和可选路径；不先展示 Memory、Skills、Research、监控或模型配置。
- 有项目时大 Composer 是主视觉，项目选择是唯一必要上下文控件；Harness/model 继承既有默认。
- 顶栏主动作固定为“新会话”。项目、Issue、Research 创建能力保留在旧项目页/高级入口，不再以四类创建菜单占据默认顶栏。

### Thread、按需工具与状态

- 有 session 直接显示时间线；无 session 显示同位置 Composer 空态。
- 状态靠近会话行和当前会话上下文；停止仍是运行期就近动作。
- 文件、diff、计划、编辑器、Skill/Memory 会话动作从“工具”按需打开，默认关闭，不复制 Cursor 的常驻 IDE 四栏。

### 设置覆盖层

- 设置继续覆盖 Home/Thread，而不是跳成独立门户。
- Escape、背景或关闭按钮回到原上下文并恢复焦点。
- Core/advanced 能力都保持可达，但不再同时占用首页与顶栏。

## 5. 绝对不要学习的能力

以下功能属于 CodexMonitor / 官方 Codex 自身的执行架构或商业产品能力，不是本轮 UI 重组目标：

- CodexMonitor 的 worktree agent、clone workspace、daemon 管理和多 Codex 进程编排。
- CodexMonitor / 官方 Codex 的 dictation 作为新增默认能力；Mobius 现有语音控件只从默认 easy Composer 退到旧高级布局，不新增协议。
- GitHub PR 上下文、review 自动化、stage / revert / commit / push 工作流。
- 官方账号切换、额度环、rate limit、usage 仪表盘和云端任务体系。
- Codex 的 sandbox、approval、模型档位或配置文件语义。
- Tutti Dock、Launchpad、窗口系统，或 Cursor 式 Explorer / Editor / Chat / Terminal 常驻四栏。

只有当 Mobius 已经有对等能力时，才允许把入口移入“工具”或“设置/更多”；不得借 UI 对齐新增后端执行语义。

## 6. 与既有简化计划的对齐

本轮严格沿用 `MOBIUS_UI_SIMPLIFICATION_PLAN.md` 的边界：

- 不删后端能力或 Project / Issue / Research / Session 接口。
- 不修改 Harness、模型选择链、SSE、Stop、消息协议和执行语义。
- 不把 Mobius 做成 Tutti OS，也不复制 Cursor IDE。
- 不新增 easy / normal 产品模式；`layout_mode` 和 `/easy_mode` 仅做兼容。
- `Session` 在默认文案中统一为“会话”，Issue 退到自动创建/高级管理层。
- 采用“重组入口、默认不渲染、按需覆盖”的方式，而不是大爆炸重写 `chat.tsx`。

因此，本轮把已经达标的骨架保留原状，只修复第 3 节列出的默认表面缺口。

## 7. 本轮实际修改范围

实际修改并验收以下文件：

| 文件 | 修改内容 | 验收点 |
| --- | --- | --- |
| `.gitignore` | 仅放行本轮指定的 `04-codexmonitor-alignment.md` | 其他 `docs/ui-optimization` 本地文件仍保持原忽略策略 |
| `docs/ui-optimization/04-codexmonitor-alignment.md` | 本对照分析 | 包含参考职责、源码缺口、学/不学、计划边界、文件与验收 |
| `mobius/frontend/src/pages/UserPage.tsx` | Home 移除模型/Harness 首屏选择，继承默认模型链 | 有项目时只需选项目、输入、发送；最近项目不超过 3 个 |
| `mobius/frontend/src/components/conversation-rail.tsx` | 默认展开、运行中强制可见、状态轮询、相对时间、扩展搜索 | Home/会话页共用；标题/时间/状态清晰；短地址跳转 |
| `mobius/frontend/src/components/shell.tsx` | 从当前 session/project store 推导顶栏项目上下文 | `/u/:user/s/:session` 仍显示当前项目；顶栏动作保持精简 |
| `mobius/frontend/src/components/chat.tsx` | easy 头部隐藏 Issue/Research 层；低频输入动作退出默认布局 | 默认只见项目/会话/状态/工具/停止；SSE 与发送函数不改 |
| `mobius/frontend/tests/workbench-simplification-contract.test.js` | 更新并补强 UI contract | 锁定 Home 无模型前置、最近项目上限、会话搜索/时间/轮询/运行可见 |

以下文件以复核为主，除非检查暴露回归，不做无意义改写：

- `mobius/frontend/src/App.tsx`：模式选择已不渲染，短地址与兼容跳转已存在。
- `mobius/frontend/src/pages/WorkPage.tsx`：已经是无 mode 的默认会话工作台。
- `mobius/frontend/src/pages/IssuePage.tsx`：默认分支已移除 SessionOverview / ProjectFilesCard 和双树。
- `mobius/frontend/src/components/settings-panel.tsx`：已经是统一覆盖层并保留高级入口。
- `mobius/frontend/src/components/global-create.tsx`：创建表单继续保留，但默认 TopNav 不挂载四类菜单。

## 8. 本轮验收清单

- 登录后不出现模式选择；旧 `/easy_mode` 链接仍能无损跳转。
- `/u/:user` 无项目时只有最小项目创建；有项目时以 Composer 为主，模型/Harness 不在首屏。
- Home 和 `/u/:user/s/:session` 使用同一个 `ConversationRail`；项目默认展开，运行中会话不会因折叠而消失，状态会刷新。
- 会话行显示标题、相对时间和必要状态，并可按标题、session id、项目搜索。
- 点击会话进入 `/u/:user/s/:session`；Issue `?session=` 继续兼容跳转。
- session 加载后立即显示 easy ChatArea；没有 session 时显示 Composer，不出现统计概览和项目文件卡。
- 默认顶栏只有项目上下文、搜索、新会话、设置/更多与账户；短会话地址不丢项目名。
- 默认 easy 会话头不显示 Issue/Research 中间层；右侧/高级工具保持按需打开。
- SettingsPanel 仍是覆盖层，关闭后回到原上下文；Project、Research、Skill/Memory、编辑器/文件、Admin、桌面端、AIMUX、下载/CLI 仍可通过显式入口到达。
- 前端 TypeScript 检查、相关单测和生产构建通过；不修改 backend/harness，不改 CodexMonitor 源码。

## 9. 落地后源码复核

- Home 当前只保留项目、输入和发送：`mobius/frontend/src/pages/UserPage.tsx:368-445`；创建调用未传显式 model，继续走 `createDefaultConversation` 的项目/系统默认链。最近项目上限见 `UserPage.tsx:453-470`。
- Home 和会话页共用会话轨；会话状态每 10 秒更新见 `mobius/frontend/src/components/conversation-rail.tsx:142-168`，搜索覆盖 session id 见 `conversation-rail.tsx:194-205`，活动/运行项目强制展开见 `conversation-rail.tsx:207-220`，单行标题/状态点/相对时间见 `conversation-rail.tsx:307-325`。
- 短会话地址从已恢复的 session 推导项目身份，见 `mobius/frontend/src/components/shell.tsx:746-752`；项目上下文与精简动作渲染见 `shell.tsx:817-896`。
- easy 会话头只显示状态、项目与会话，见 `mobius/frontend/src/components/chat.tsx:4246-4266`；工具仍按需打开见 `chat.tsx:4290-4324`。语音和加急发送只在旧高级布局常驻，默认 easy Composer 只保留普通发送。
- 静态契约在 `mobius/frontend/tests/workbench-simplification-contract.test.js:108-139` 锁定短路由、两层项目会话轨、轮询/相对时间、Home 无模型前置和默认 Issue 简化面。

验证结果：`npm run build` 通过（包含 `tsc --noEmit` 与 Vite production build）；`mobius/frontend/tests` 下 9 个现有测试全部通过；`git diff --check` 通过。构建只出现既有的非 module loader 和大 chunk 警告，没有新增编译错误。
