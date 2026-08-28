# 06｜布局骨架与 Chrome

## 结论

Mobius 当前默认 Home / Session 骨架已经接近正确，下一步不是再造一种布局，而是明确每块 chrome 的生命周期：TopNav 与 Conversation Rail 稳定；Composer 和当前会话状态就近；搜索、工具、设置覆盖当前上下文；Project / Research / Admin / 编辑器仍是完整高级表面，但不常驻默认工作台。此处只讨论区域职责，视觉数值见 [05-visual-language.md](./05-visual-language.md)。

## 1. CodexMonitor 的布局职责

### 1.1 三栏与可折叠右栏

```text
┌──────────── Sidebar 280px ────────────┬──────────── Main / Center ────────────┬──── Right 230px ────┐
│ Home / 新建 / 搜索                    │ MainTopbar 44px                       │ Git / Files / PR     │
│ Workspace / Thread 分组               ├───────────────────────────────────────┤                     │
│ Thread 状态                           │ Chat layer  ⇄  Diff layer             ├─ 可拖分隔 ──────────┤
│                                       │ （单层、预载隐藏或 split）             │ Plan                │
│ 底部：Settings / Debug / Account      │ Messages                              │                     │
│                                       │ Composer 贴底覆盖                      │ 右栏可整体折叠       │
└───────────────────────────────────────┴───────────────────────────────────────┴─────────────────────┘
                                             Terminal / Debug dock（工作期按需）
```

事实依据：

- App 外层固定两列，Sidebar 默认 280px，主区占剩余空间（`examples/CodexMonitor/src/styles/base.css:48-58`）。
- Main 内部是中心 `1fr` + 右栏 230px（`examples/CodexMonitor/src/styles/main.css:1-13`）。
- `DesktopLayout` 始终渲染 sidebar 与 resizer；主区才二选一显示 Home 或 Workspace（`DesktopLayout.tsx:142-160`）。
- Workspace 的 Chat 与 Diff 是同一中心位置的 layer，不是再加一列；隐藏层设置 `inert`，切层时先移走焦点（`DesktopLayout.tsx:121-140,162-219`）。
- Right panel 才承载 Git/Diff 与 Plan；Terminal 是另一个工作期 dock（`DesktopLayout.tsx:221-241`）。右栏收起时用 opacity/translate/pointer-events，不影响中心主语义（`main.css:1031-1158`）。

### 1.2 每个区域何时出现

| 区域 | 出现条件 | 退出条件 / 返回 | 证据 |
| --- | --- | --- | --- |
| Sidebar | 桌面布局常驻；窄屏改为单列 | 可折叠；不因 Home/Thread 切换换位置 | `DesktopLayout.tsx:142-151`；`base.css:238-252` |
| Home | `showHome` 为真，未进入 workspace | 选择 workspace/thread 后进入 Workspace | `DesktopLayout.tsx:153-157`；`Home.tsx:55-84` |
| Thread / Messages | workspace 存在且 center 为 chat | 切到 diff 时隐藏但可预载；返回 chat 恢复 | `DesktopLayout.tsx:158-219` |
| Composer | Thread 的 ChatPane 内持续存在 | 仅离开 workspace；运行中 action 可切 Stop | `DesktopLayout.tsx:112-113`；`ComposerInput.tsx:160-166,326-335` |
| Right panel | workspace 工具可用且未折叠 | 折叠后中心扩展；Plan 无活动时底区折叠 | `DesktopLayout.tsx:221-239`；`main.css:1031-1158` |
| Files preview | 在 Files panel 点文件后出现 popover | Esc、关闭、把选区加入 Chat 后关闭 | `FileTreePanel.tsx:291-303,522-541,583-643,766-802` |
| Settings overlay | 从 Sidebar 底部 Settings 打开 | 背景、X、Esc / Cmd/Ctrl-W 关闭，回原 workspace | `Sidebar.tsx:1030-1048`；`SettingsView.tsx:141-167` |

**必须学**的是生命周期与位置稳定；**不要学**的是它把 Git/Diff/Plan 做成固定右栏的产品结构。Mobius 的工具更多、能力边界不同，默认应使用一个按需工具容器，而不是常驻“Git 上 + Plan 下”。

## 2. Mobius 当前默认骨架

### 2.1 当前 Home（`UserPage + shell + ConversationRail`）

```text
┌──────────────────────────── TopNav 52px ────────────────────────────────────────────┐
│ Logo / 用户 /（项目）                              历史*  搜索  新会话  设置  账户 │
├──── ConversationRail 272px ────┬──────────────── HomeSurface ──────────────────────┤
│ 新会话                          │                 想让 Mobius 做什么？               │
│ 搜索会话                        │                 [ 主 Composer ]                    │
│ 项目文件夹                      │                 [项目选择]              [发送]     │
│   会话 · 状态 · 相对时间       │                 最近项目（最多 3 个）              │
└─────────────────────────────────┴───────────────────────────────────────────────────┘
* 宽度 < xl 时 Rail 不常驻，由顶栏“历史”打开抽屉。
```

- TopNav 当前 52px，动作是搜索、新会话、设置/更多、账户；历史只在 Rail 隐藏时出现（`mobius/frontend/src/components/shell.tsx:817-894`）。
- Home 和 WorkPage 都复用 272px Conversation Rail（`conversation-rail.tsx:243-270,340-347`；`UserPage.tsx:397-475`；`WorkPage.tsx:88-110`）。
- Home 主区宽 880px，第一屏只有提问、项目选择、发送和最多 3 个最近项目（`UserPage.tsx:407-470`）。
- 无项目时先出现最小项目表单，首个输入自动聚焦（`UserPage.tsx:250-277`）。

### 2.2 当前 Session（`WorkPage + shell + ConversationRail + ChatArea easy`）

```text
┌──────────────────────────── TopNav 52px ────────────────────────────────────────────┐
├──── ConversationRail 272px ────┬──────── Easy session context 44px ────────────────┤
│ 新会话 / 搜索                   │ 状态  Project > Session     轮次摘要    工具  停止 │
│ 项目文件夹 / 会话               ├──────────────────────────────────────────────────┤
│                                 │ JSONL / 对话时间线                                │
│                                 │                                                  │
│                                 │           [ Composer，底部悬浮，≤880px ]         │
└─────────────────────────────────┴──────────────────────────────────────────────────┘
```

- `/u/:user/s/:session` 由 `WorkPage` 还原 Project + Issue/Research 上下文，但呈现统一 `ChatArea layout="easy"`（`WorkPage.tsx:29-78,88-110`）。
- Easy 头是 44px：状态、Project、Session、摘要、工具与停止（`chat.tsx:4246-4338`）。
- 时间线占满主区，Composer 在底部绝对定位、最大 880px（`index.css:5882-5918`）。
- 工具菜单已有文件修改、命令、终端、Skill、Memory、Git、知识、Research Graph 等动作，默认关闭（`chat.tsx:4291-4323`；`advanced-session-actions.tsx:80-249`）。

### 2.3 当前结构的剩余冲突

| 冲突 | 源码证据 | 判断 | 影响 |
| --- | --- | --- | --- |
| 两层横向 chrome 叠加 | TopNav 52px + Easy context 44px（`shell.tsx:819-821`；`chat.tsx:4246-4247`） | **可学** Codex 的薄 workspace topbar：两层可各自存在，但 Session context 应降到 36–40px，避免成为第二顶栏 | Chat |
| 顶栏与 Rail 都有“新会话” | `shell.tsx:866-870`；`conversation-rail.tsx:258-263` | **可保留但明确主次**：Rail 为主要入口；顶栏在窄屏和跨页时兜底，视觉用中性描边 | Home / Rail / Chat |
| 工具是菜单中的网格按钮 | `advanced-session-actions.tsx:72-249` | **必须学按需，需改容器**：入口正确，打开后的 Modal/弹层各自为政 | Chat / 高级页 |
| 层级互相穿透风险 | Settings z70、工具 menu z50、Chat toast z80、mention z90、移动 drawer 8999/9000（`settings-panel.tsx:85-90`；`chat.tsx:4304,4448-4465`；`index.css:5692-5724`） | **必须统一 layer token** | Rail / Chat / Settings |
| 高级页另有重型侧栏 | Project 184px nav + 大主区（`ProjectPage.tsx:758-807`）；Research 288px resizable rail（`ResearchPage.tsx:320-431`） | **不要删除**，但它们是高级页 chrome，不能回流默认工作台 | 高级页 |

## 3. Chrome 去留表

### 3.1 常驻

| Chrome | Home | Session | 高级页 | 理由 |
| --- | --- | --- | --- | --- |
| TopNav | 常驻 | 常驻 | 常驻 | 提供全局返回、搜索、新会话、设置与账户；当前事件已统一（`shell.tsx:769-810,817-897`） |
| Conversation Rail（宽屏） | 常驻 | 常驻 | 不强制 | 默认工作台的唯一恢复入口；高级 Project/Research 有自己的对象侧栏 |
| 当前会话状态 | 无 | 常驻，贴近会话标题 | 按对象保留 | “执行中/待命/失败”必须靠近当前工作（`chat.tsx:4249-4266`） |
| Composer | Home 主体 | Session 贴底 | 对话型高级页保留 | 位置与发送语义稳定；工具打开不应重挂它 |

### 3.2 按需出现

| Chrome | 触发 | 容器建议 | 关闭后恢复 |
| --- | --- | --- | --- |
| 会话搜索 | TopNav `搜索` / Cmd/Ctrl-K | 中央 overlay；默认输入聚焦 | 原路由、原滚动、原触发器 |
| 窄屏 Rail | TopNav `历史` | 左 Drawer | 原触发器聚焦；当前已实现（`conversation-rail.tsx:108-133,340-347`） |
| 会话工具 | Session context `工具` | 第一层 Popover 选工具；复杂工具进入统一 Drawer/Modal | 当前 session、草稿、时间线位置不变 |
| Settings | TopNav sliders / Cmd/Ctrl-, | 单一 Overlay | 原触发器聚焦；当前已实现（`settings-panel.tsx:33-69`） |
| Diff / Files / Terminal | `工具` 内动作 | 右侧 Tool Drawer；终端若需大面积可升为 Dock/Modal | 关闭回 Session，焦点回工具按钮或 Composer |
| 编辑器 | `工具 → 编辑器` | 宽屏 split 或明确高级表面 | 关闭/返回到同一 `/s/:session`，草稿保留 |
| Research Graph / Blackboard | 研究会话工具或高级 Research 页 | 高级全主区，不挤进普通 Session | Query 返回同一 agent（`ResearchPage.tsx:292-297,479-508`） |
| Admin | Settings → 管理员 | 全屏 overlay | 关闭回 Settings 的管理员项或原工作台 |

### 3.3 彻底退出默认表面

“退出”只指默认 DOM / chrome，不是删除能力。

| 项目 | 新位置 | 依据 / 边界 |
| --- | --- | --- |
| 四类全局创建菜单 | 默认只留新会话；Project/Issue/Research 在各高级页 | `GlobalCreateMenu` 已只调用 `onPick('session')`（`global-create.tsx:1900-1923`） |
| Project 设置七类导航 | 高级 ProjectPage | 当前 184px 项目详情侧栏继续存在（`ProjectPage.tsx:758-801`） |
| Research 团队 / Graph / Blackboard 常驻入口 | Project 研究列表、研究会话工具、ResearchPage | 当前功能完整，路由保持（`ResearchPage.tsx:320-530`） |
| 系统可视化与运行监控 | Settings → 高级 / 管理员 | `settings-panel.tsx:194-213` 已有入口 |
| AIMUX / 桌面下载 / CLI / 移动端 | Settings → 连接与客户端 | `settings-panel.tsx:182-190` 已有入口 |
| 助手气泡 | Settings 显式开启，默认关闭 | `settings-panel.tsx:157-164`；挂载条件 `App.tsx:378-419` |
| 主题工坊与背景流 | Settings → 高级 | 不与明/暗主题切换竞争常驻 chrome |

## 4. Mobius 目标默认布局

### 4.1 Home

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Mobius / 当前项目（可空）                         搜索  新会话  设置  账户  │ 48–52
├─────────────── 272px ───────────────┬───────────────────────────────────────┤
│ [+ 新会话]                          │                                       │
│ [搜索会话 / Session ID]             │           想让 Mobius 做什么？         │
│ 项目 A                              │    ┌───────────────────────────────┐  │
│   会话 1                  12 分钟前 │    │ 描述目标…                      │  │
│   会话 2  ● 运行中             刚刚│    │                               │  │
│ 项目 B                              │    ├ 项目 A ─────────── [发送] ───┤  │
│   会话 3                      昨天  │    └───────────────────────────────┘  │
│                                    │           最近项目（最多 3）           │
└────────────────────────────────────┴───────────────────────────────────────┘
                                             唯一主动作：发送 / 开始
```

要求：项目选择是上下文，不是页面模式；失败信息固定在 Composer 下方并提供原地重试；Rail 不再增加 Project/Issue/Research 四层树。Home 当前发送成功已经直达短会话地址（`UserPage.tsx:368-395`），应保留。

### 4.2 Session

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Mobius / Project A                              搜索  新会话  设置  账户   │ 48–52
├─────────────── 272px ───────────────┬───────────────────────────────────────┤
│ [+ 新会话]                          │ [执行中] Session 标题          工具  ■停止│ 36–40（停止仅运行期强调）
│ [搜索会话 / Session ID]             ├───────────────────────────────────────┤
│ Project A                           │ 时间线：消息、工具摘要、就近错误        │
│   当前会话 ●               刚刚     │                                       │
│ Project B                           │                                       │
│   其他会话                  昨天     │     ┌─────────────────────────────┐   │
│                                    │     │ 继续输入；@ 引用；附件       │   │
│                                    │     ├ [＋]                   [发送]┤   │
└────────────────────────────────────┴─────┴─────────────────────────────┴───┘
                                             唯一常规主动作：发送

工具打开时：
┌──────── Rail ────────┬──── Thread（不重挂）─────┬── Tool Drawer（按需）──┐
│                      │                           │ Files / Diff / Terminal │
└──────────────────────┴───────────────────────────┴────────────────────────┘
```

运行时“停止”是条件性安全动作，不与“发送”共享同一按钮。CodexMonitor 会把 Composer action 在 `canStop` 时切成 Stop（`ComposerInput.tsx:160-166,326-335`），Mobius 已明确保持独立 Stop 与 Send（`chat.tsx:4326-4336,4877-4919`）；**不要照搬切换按钮**，只学习状态就近和运行期可见。

## 5. 布局验收准则

- 任意默认页面都只能看到一条全局顶栏和一条会话轨；窄屏会话轨只有一个 Drawer。
- Home 首屏唯一高强调动作是“发送/开始”；Session 常规态唯一高强调动作是“发送”。
- 打开 Settings、Search、Tool Drawer 不改变 `/s/:session`，不重挂 ChatArea，不清草稿。
- 从 Tool Drawer 进入高级全页时，URL 能表达目标；浏览器 Back 必须回同一 session。
- Project / Research / Admin 页面可更密，但仍使用 05 的 token、控件尺度和层级表。
- 不新增 Tutti OS / Cursor 常驻 IDE chrome；不复制 CodexMonitor 的固定 Git+Plan 右栏。

逐动作的入口、焦点、返回与失败恢复见 [07-interaction-and-navigation.md](./07-interaction-and-navigation.md)。
