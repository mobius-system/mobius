# 简易模式（easy_mode）交互能力分析

> 生成时间：2026-07-28
> 分析对象：mobius 前端「简易模式 easy_mode」
> 方法：源码精读（精确到 file:line）+ 2026 年 AI coding 交互设计联网研究
> 目的：厘清简易模式当前功能边界，对照业界共识，列出缺失的必要交互能力与优先级建议

---

## 〇、执行摘要（TL;DR）

简易模式（`localStorage.layout_mode === 'easy_mode'`）当前的形态是：**「左栏跨项目近期会话 + 右栏聚合 JSONL + 悬浮输入框 + 紧凑三行图标面板」**。它把"看进度 + 继续对话 + 查变更"这条主链路做得相对顺，也做对了一件业界公认对的事——**把原始 JSONL 事件流聚合成人话活动卡**（A2UI 思路）。

但作为一个"让非技术用户独立完成一个 coding 任务"的工作台，它**不闭环**。核心结论：

1. **三个关键节点是断的**：① 新建任务/会话入口（全页面无任何"新建"按钮）；② 强终止/打断能力（顶栏整体被隐藏，发送键被硬约束不能变成停止键）；③ 结束/交付能力（无完成/归档/导出入口）。
2. **方向与 2026 业界共识相反**：业界（Hatchworks《Chat-First UX Fails》）的强共识是——纯聊天在 coding 场景是失败的，必须加「控制面」= **审批 + 回执 + 日志 + 撤销 + 安全恢复**。简易模式为了"简化"把顶栏（含终止、溢出菜单、连接状态）整个砍掉，等于把仅有的几个控制点也拿掉了。
3. **定位与实现存在撕裂**：首次选择弹窗说简易模式适合"专注处理一到两个项目""像传统 Agent 对话界面"，但传统对话界面都有"新对话"按钮——简易模式却没有。
4. **亮点**：`EasyJsonlView` 的轮次聚合视图（探索/命令/文件改动/计划/进度/错误/图片 7 类活动卡）正是业界呼吁的 A2UI 方向，应保留并强化。

> 一句话：简易模式现在更像一个**「只读 + 续聊」的轻量视图**，而不是**自洽的任务工作台**。

---

## 一、简易模式是什么（入口与路由）

| 维度 | 实现 | 位置 |
|---|---|---|
| 状态存储 | `localStorage['layout_mode']`，识别 `'easy_mode'` / `'normal_mode'`，跨标签同步（`storage` 事件 + 自定义事件） | `frontend/src/services/layout-mode.ts:3,11-13,18-33` |
| 首次进入 | `layout_mode` 未设置时弹 `LayoutModeChoiceModal`（两个大按钮） | `App.tsx:226-234`；`layout-mode-choice-modal.tsx:45-81` |
| 重定向门控 | 命中 `/u/:user` 或 `/u/:user/p/:project/i/:issue` 且 `easy_mode` → `<Navigate to="/u/:user/easy_mode" replace/>` | `App.tsx:204-237` |
| 路由注册 | `/u/:user/easy_mode` → `EasyModePage` | `App.tsx:246` |
| 切换开关 | TopNav 主题下拉菜单内 | `frontend/src/components/shell.tsx:1290-1333` |

布局：`EasyModePage` = 顶部 `TopNav` + **左栏（跨项目近期会话）+ 右栏（`ChatArea layout="easy"`）** 两栏。(`EasyModePage.tsx:171-300`)

---

## 二、当前功能全景（已有的）

### 2.1 左栏：跨项目近期会话列表

- 数据：`GET /api/tasks/recent?limit=50` + `GET /api/projects?all=true`，进入页面**只加载一次**（`useEffect` deps 仅 `[params.user]`）。(`EasyModePage.tsx:26,98-119`)
- 能力：可拖拽宽度、项目筛选 chip 行（仅 >1 项目时显示）、会话卡片（issue/research 图标区分、运行中橙点、相对时间 + 消息数）、点击切换、自动打开最近一条、空/错态。(`EasyModePage.tsx:175-283,121-169`)
- **注意：左栏没有任何"新建会话/新建任务"入口。**

### 2.2 右栏 JSONL：`EasyJsonlView`（聚合轮次视图）

把原始 entries 聚合成「用户任务卡 → 执行轨道（7 类活动）→ 智能体回复」的轮次结构：探索上下文 / 运行命令 / 修改文件 / 计划 / 进度 / 错误（默认展开）/ 图片。活动卡可展开看明细与图片画廊，进行中态有 spinner + liveText。(`EasyJsonlView.tsx:200-247`；`easy-jsonl-model.ts:142-260`)

> 这是简易模式**最大的亮点**，方向与业界 A2UI 共识一致（见 §三）。

### 2.3 右栏：悬浮输入框（复用完整版 `ChatArea`）

完整保留：附件拖拽/粘贴/上传、引用回复、编辑消息、IME 守卫、Enter 发送 / ArrowUp 召回历史、语音录入、加急发送（闪电，"打断当前输出并立即发送"）、普通发送、模型不可用横幅、长文本编辑弹窗。(`chat.tsx:3275-3518`)

**硬约束**：发送按钮永远只 send，不会变成停止键（注释 `chat.tsx:3468-3469`）。

### 2.4 输入框左侧：紧凑三行图标面板（简易模式独有）

`layout === 'easy' && !isPlanningSession` 时挂载 `renderAdvancedSessionActions('compact')`，容器宽 176px，三行 5+5+2 共 12 个按钮：

| 行 | 按钮 |
|---|---|
| 第一行 | 查看文件修改 / 查看运行命令 / 回放输入 / 显示时间序号 / 进入项目端口 |
| 第二行 | 打开终端 / 可合作计算机 / 查看当前知识 / 项目知识沉淀到记忆 / 修改模型并继续 |
| 第三行 | Skill / Memory（打开当前 Session 快照弹窗） |

位置：`advanced-session-actions.tsx:66-203`。**关键**：紧凑模式下每个按钮**只渲染图标，不渲染可见 label**（`advanced-interaction-btn.tsx:141-143`），文字仅 hover tooltip 可见。

### 2.5 仍保留的能力（与完整版一致）

输入框全部能力、SSE 流式、终止乐观更新抑制、错误横幅、12 个高级操作按钮的弹窗行为本身（文件改动、Bash、终端、知识、可合作计算机、修改模型、端口、Skill/Memory 弹窗）。

---

## 三、2026 业界交互设计共识（研究基线）

以下结论来自联网研究，是后文判断"缺什么"的标尺。

### 3.1 最强共识：纯聊天 UX 在 coding 场景失败，要上「控制面」

Hatchworks《Agent UX Patterns: Chat-First UX Fails》给出控制面五件套：

> **Approvals（审批）· Receipts（回执）· Logs（日志）· Undo（撤销）· Safe Recovery（安全恢复）**

核心论点：chat UI 模仿对话会引入大量"对话噪声"，应转向**意图驱动 + 后台执行 + 关键时刻才打断**。

### 3.2 Plan Mode 是 2026 的硬关卡标配

- **Cursor Plan Mode**：动代码前先出可交互计划，用户能直接改计划条目。
- **Claude Code Plan Mode**：派只读 Plan 子代理收集信息，**主动向用户提问澄清**模糊需求，再产出计划（`Ctrl+G` 编辑）。被形容为"看承包商画蓝图 vs. 看他砸墙"。
- **GitHub Copilot Coding Agent**：plan → spec → task → agent → PR，每一步都需用户审批。

### 3.3 Checkpoint 回滚 = 安全感来源

Cursor Agent Mode、Claude Code 均内置 checkpoint，让用户"搞砸了能安全退回已知好状态"。

### 3.4 渐进式披露（Progressive Disclosure）

2026 年被系统性搬进 AI 工具：初始只给最重要的，其余用到再揭示。"Agent Skills"是该原则在上下文管理上的首个主流实现——只在相关时才加载对应工具与指令。

### 3.5 A2UI：事件流 → 结构化卡片

把 agent 事件流**渲染成标准 UI 组件**（带图标/颜色/状态的面板），而非吐 JSON 行。这正是 `EasyJsonlView` 在做的事。

### 3.6 两个关键研究结论

- **Anthropic 40 万会话研究**：非编程者达到验证成功的比率与软件工程师几乎相当（非开发者 ~29% vs 专业 ~33%）；**领域专长比编程背景更决定成败**。→ 术语要对齐用户领域，别甩 git/CI/diff 行话。
- **Columbia DAP Lab 9 大失败模式**：vibe coding "出漂亮 demo 但生产里崩"，最严重的是**错误处理回避**和**业务逻辑错配**（agent 在模式匹配而非验证需求）。需在 agent 之上加**策略执行层**。

---

## 四、交互能力缺口分析（核心）

把「一个非技术用户跑完一次 需求→交付 所需的 12 项能力」逐项对照简易模式现状：

| # | 能力 | 业界标准 | 简易模式现状 | 缺口 | 优先级 |
|---|---|---|---|---|---|
| 1 | 需求表达 | 自然语言 + 附件/参考图 | ✅ 输入框完整（附件/语音/引用） | 基本无缺口 | — |
| 2 | **计划生成与确认/审批** | Plan Mode 硬关卡 | ❌ 无任何 Plan 关卡 UI | **动代码前无对齐**，方向跑偏只能事后返工 | **P0** |
| 3 | 计划可交互编辑 | Cursor/Claude 内联编辑计划 | ❌ 无 | 同上 | P1 |
| 4 | 澄清式追问 | Claude Plan 阶段主动提问 | ⚠️ 取决于 agent，UI 无显式承载 | UI 无追问承载 | P1 |
| 5 | 代码变更审查(diff) | editor-grade 多文件 diff | ⚠️ 有"查看文件修改"弹窗，但藏在小图标里，聚合视图只有计数摘要 | 入口隐蔽，非技术用户找不到 | P1 |
| 6 | **运行/实时预览** | v0/Lovable 命脉：所见即所得 | ⚠️ 有"进入项目端口"按钮，但多步、需 agent 配合、不直观 | **无并排 live preview 面板** | **P0/P1** |
| 7 | 错误反馈与自动修正 | Devin 2.2 自验证+自修复 | ⚠️ error 活动卡默认展开（被动展示），无"重试/反馈"按钮 | 无主动错误恢复入口 | P1 |
| 8 | 上下文/记忆管理 | 长会话必备 | ✅ Skill/Memory 弹窗 | 基本通 | — |
| 9 | 多轮迭代 | 零摩擦"再改一版" | ✅ 续聊顺畅 | 基本通 | — |
| 10 | **中途干预/打断** | 随时叫停、改方向 | ❌ **终止按钮随顶栏被砍，发送键不能变停止**，只剩加急发送（语义是"打断并继续"非"终止"） | **唯一硬干预手段缺失** | **P0** |
| 11 | **Checkpoint 回滚** | 安全退回已知好状态 | ❌ 无 | **无安全感来源** | **P1** |
| 12 | **收尾交付/部署** | 自动开 PR / Slack 交付 | ❌ 无完成/归档/导出入口 | **任务不闭环** | **P0** |

> 配套的链路问题：**新建任务/会话入口完全缺失**（`EasyModePage.tsx:289` 不传 `onNewSession`，左栏无创建按钮，空态文案反而把用户引向"先去别处创建"）。这是比上表 12 项更前置的断点——**用户连"开始一个新任务"都做不到**。

---

## 五、缺失功能与能力清单（按优先级）

### 🔴 P0：严重断链，不补无法闭环

#### P0-1　新建任务/会话入口
- **现状**：全页面无任何"新建"按钮。空态文案"创建会话后会自动显示在这里"暗示创建入口不在此页。(`EasyModePage.tsx:289,295`)
- **为什么是 P0**：用户进简易模式后想"做点新东西"，发现只能选已有会话续聊——首屏即卡死。这与弹窗宣传的"专注处理项目"定位直接矛盾。
- **业界做法**：Lovable/v0/ChatGPT 这类"聊天即应用"工具，首屏唯一主角就是"新对话"输入框。
- **建议**：左栏顶部加醒目"新建会话/任务"按钮（走与完整版一致的创建流，但用简易模式友好的单步表单）；或在右栏空态时直接把悬浮输入框升级为"首屏新建 + 描述需求"入口。

#### P0-2　强终止 / 打断能力
- **现状**：会话顶栏（含终止按钮、连接状态、溢出菜单）整体被 `layout !== 'easy'` 隐藏（`chat.tsx:3090`）；发送键被硬约束不能变停止键（`chat.tsx:3468-3469`）。唯一残留干预是加急发送（"打断并继续"，非"终止"）。
- **为什么是 P0**：业界把 Undo/Safe Recovery 列为控制面核心。非技术用户看到 AI "跑飞了"，没有任何可靠的"停下来"手段——只能刷新或切走。这是交互安全硬伤。
- **建议**：简易模式需要一个**始终可见的"停止/终止"控件**（运行中态自动浮现，可复用顶栏终止逻辑，只是换一个更轻量的悬浮呈现），不依赖被砍掉的顶栏。

#### P0-3　结束 / 交付能力
- **现状**：无完成、归档、导出、标记 done 等任何收尾入口。
- **为什么是 P0**：任务没有"完成态"，用户不知道什么时候算"做完了"，也无法把成果固化/交付。任务不闭环。
- **建议**：会话尾部加"标记完成 / 归档 / 导出成果"入口（对非技术用户用领域语言，如"完成这个任务"而非 PR/merge）。

#### P0-4　动代码前的 Plan 硬关卡（对齐意图）
- **现状**：无任何 Plan 审批 UI。
- **为什么是 P0**：业界（Cursor/Claude/Copilot）2026 年的标配。非技术用户最怕的就是"AI 理解错了直接改一堆"。Plan 关卡把"理解错"消灭在写码前。
- **建议**：动代码前先渲染一个**人话计划卡**（"我打算：1. 新建 X 页面 2. 改 Y 配置 3. 运行验证"），用户可改、可批、可拒。简易模式尤其需要——因为用户看不懂 diff，Plan 是他们唯一能把关的环节。

### 🟠 P1：安全感与可控性

#### P1-1　Checkpoint 回滚（Undo）
- 给每个有副作用的动作加"回退到上一步"。简易模式用户看不懂代码，回滚是他们敢于"让 AI 试"的前提。

#### P1-2　审批 / 回执
- 危险动作（写文件、部署、花钱）执行前给"先看再做"审批口；执行后给"刚干了什么"回执（控制面五件套之 Approvals/Receipts）。

#### P1-3　分层日志（人话摘要层）
- 当前 `EasyJsonlView` 已是聚合层，但缺一个更顶层的"现在在干什么 / 进度 / 是否阻塞"摘要条（渐进式披露的最顶层）。把 JSONL 原始流进一步折叠到"详情/高级"。

#### P1-4　实时预览面板（live preview）
- 与执行日志并排展示运行结果，让非技术用户靠"看"而非"读码"判断对错（v0/Lovable 命脉）。当前"进入项目端口"按钮太隐蔽、链路太长。

#### P1-5　diff 审查入口前移
- "查看文件修改"现在藏在紧凑面板第一个小图标里。对非技术用户应在 AI 完成一轮改动后**主动弹出/高亮**变更摘要（人话 + 视觉对比），而非等用户去翻图标。

### 🟡 P2：易用性与健壮性

#### P2-1　图标按钮加可见文字
- 紧凑面板 12 个按钮全是纯图标，文字仅 hover tooltip（`advanced-interaction-btn.tsx:141-143`）。非技术用户不认识 Network=可合作计算机、Archive=知识沉淀。至少在首次使用时给 label，或加 onboarding 引导。

#### P2-2　会话列表搜索 / 分页 / 刷新
- 当前硬截断 50 条（`EasyModePage.tsx:26`），进入页面只加载一次，新消息流入不刷新。需加文本搜索、滚动加载、定期轮询刷新。

#### P2-3　错误恢复按钮
- error 活动卡目前只是被动展示。应加"重试 / 告诉小莫哪里不对 / 反馈"按钮，把被动报错变主动恢复（呼应 Columbia 9 大失败模式的"错误处理回避"）。

#### P2-4　planning session 兜底
- 当 issue 是 planning 类型时，简易模式既不渲染紧凑面板也不渲染 PlanningEditor（`chat.tsx:3520,3524-3535`），只剩裸输入框，规划编辑能力完全丢失且无提示。需兜底渲染或给提示。

#### P2-5　澄清式追问的 UI 承载
- 即使 agent 会追问，UI 上也应把"小莫在等你确认"做成醒目交互（卡片 + 选项），而非埋在 JSONL 流里。

---

## 六、落地路线图建议

按"先补断链 → 再补安全感 → 最后打磨易用性"的顺序：

1. **第一阶段（让任务闭环）**：P0-1 新建入口、P0-2 终止能力、P0-3 交付收尾、P0-4 Plan 硬关卡。
   - 这四项补完，简易模式才从"只读+续聊视图"升级为"自洽任务工作台"。
2. **第二阶段（建立信任）**：P1-1 回滚、P1-2 审批/回执、P1-3 分层摘要、P1-4 实时预览、P1-5 diff 前移。
   - 对齐业界"控制面"共识，把"我不懂代码所以失控"的恐惧降下来。
3. **第三阶段（降低门槛）**：P2-1 ~ P2-5。
   - 对齐 Anthropic 40 万会话研究——领域知识 > 编程背景，所以术语、引导、容错都要对齐非技术用户的领域语言。

---

## 七、一句话总结

> 简易模式做对了"把 JSONL 聚合成人话活动卡"（A2UI），却在追求极简的过程中**砍掉了业界公认的核心控制点（终止、审批、回滚、交付）**，并且**连"新建任务"这个最基础的入口都缺失**。它的下一步不是继续做减法，而是**在保持视觉极简的同时，把任务闭环（新建→计划→执行→审查→交付→可终止可回滚）的控制能力以非技术用户能看懂的方式补回来**。

---

## 附：关键源码位置速查

| 关注点 | 文件 | 行 |
|---|---|---|
| 路由 + 重定向门控 | `frontend/src/App.tsx` | 204-237, 246 |
| layout_mode 服务 | `frontend/src/services/layout-mode.ts` | 全文件 |
| 首次选择弹窗 | `frontend/src/components/layout-mode-choice-modal.tsx` | 45-81 |
| 切换开关 | `frontend/src/components/shell.tsx` | 1290-1333 |
| easy_mode 页面 | `frontend/src/pages/EasyModePage.tsx` | 全文件 |
| 右栏 + 输入框 + 紧凑面板挂载 | `frontend/src/components/chat.tsx` | 3090, 3144-3155, 3468-3469, 3519-3535 |
| 紧凑三行高级操作 | `frontend/src/components/advanced-session-actions.tsx` | 66-203 |
| 图标按钮（为何无可见文字） | `frontend/src/components/advanced-interaction-btn.tsx` | 141-143 |
| 简易 JSONL 聚合视图（亮点） | `frontend/src/components/easy-jsonl/EasyJsonlView.tsx` | 全文件 |
| 简易 JSONL 聚合模型 | `frontend/src/components/easy-jsonl/easy-jsonl-model.ts` | 142-260 |

## 附：主要研究来源

- Hatchworks《Agent UX Patterns: Chat-First UX Fails》— https://hatchworks.com/blog/ai-agents/agent-ux-patterns/
- Cursor Plan Mode 官方博客 — https://cursor.com/blog/plan-mode
- Claude Code Plan Mode 指南 — https://claudedirectory.org/blog/claude-code-plan-mode-guide
- Anthropic 40 万会话研究 — https://www.anthropic.com/research/claude-code-expertise
- Columbia DAP Lab 9 大失败模式 — https://daplab.cs.columbia.edu/general/2026/01/08/9-critical-failure-patterns-of-coding-agents.html
- A2UI / Agent UI 圣杯 — https://home.mlops.community/public/blogs/finding-the-holy-grail-of-ai-agent-uis-from-ai-orchestrated-development-to-a2ui
- Progressive Disclosure (UX Tigers) — https://www.uxtigers.com/post/progressive-disclosure
- Beyond Chat (gadlet) — https://gadlet.com/posts/beyond-chat/
- GitHub Copilot Cloud Agent 文档 — https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent
- v0 by Vercel — https://v0.app/ ；Lovable — https://lovable.dev/blog
- 完整 62 条来源列表见联网研究原始报告
