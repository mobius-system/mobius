# Self-Cognition 扩展现状说明

更新日期：2026-06-29

本文档记录 `extension/self-cognition/` 的设计初衷、当前能力、数据结构、运行链路和已知缺口。它不是用户手册，而是给后续维护者和主体小莫理解这个扩展的系统说明。

## 一句话定位

`self-cognition` 是莫比乌斯的“自我认知雷达”和“自我迭代输入层”。

它的目标不是做一个普通论文收藏夹，也不是做一个普通竞品库，而是持续替莫比乌斯观察外部研究、产品形态和内部演进，把这些信息转译成“对莫比乌斯可执行、可落地、可追问、可交给小莫继续执行”的启发。

## 最初目的

这个扩展最初要解决的是：莫比乌斯作为一个可自我修改、可持续进化的 AgenticOS，不能只等待用户提出零散需求，也不能只靠开发者临时记忆来决定下一步应该改什么。它需要一个长期运行的感知系统，持续回答几个问题：

1. 外部学术界在研究什么和“自我改进、哥德尔智能体、递归自指、多智能体科研、Agent Harness、Agentic OS、长期记忆、安全对齐”等方向有关的东西？
2. 外部产品界在做什么和“办公智能体、编码智能体、通用 Agent、科研 Agent、工作流 Agent、个人助理”等方向有关的东西？
3. 这些论文和产品里，哪些不是泛泛而谈，而是真的能转译成莫比乌斯的功能、架构、交互、调度、记忆、评估、审计、权限或自进化流程？
4. 莫比乌斯自己最近已经改了什么？哪些变化是 L1 已合入事实，哪些是 L2 候选启发，哪些属于还没有开放的 L3 自修改能力？
5. 用户或小莫在某篇论文、某个产品上产生的判断，如何回流到扫描权重、关键词、优先级和后续自进化建议里？

所以，`self-cognition` 的原始使命可以概括为：

> 给莫比乌斯建立一个持续运行的“研究雷达 + 产品雷达 + 自进化账本”，让系统能够看见外部世界、理解自身变化，并把两者转成下一步可执行的改进方向。

这个扩展的价值不在于“展示很多资料”，而在于形成一个闭环：

```text
外部论文 / 外部产品 / 内部 git 与会话事件
  -> 扫描入库
  -> 聚类、打分、筛选
  -> L2 Agent 深度阅读
  -> 提炼对莫比乌斯的借鉴方向
  -> 用户标记、追问、导出给小莫
  -> 进入后续自进化任务或人工决策
```

## 设计哲学

`self-cognition` 的界面设计不应该把论文、产品和自进化事件当成资料墙来陈列，而应该把它们组织成一个面向人类判断的决策工作台。L2 自进化的关键瓶颈不是“系统能不能找到更多信息”，而是“人能不能快速理解证据、看清启发、做出可追溯的取舍”。因此前端默认采用三栏式 decision inbox：左侧是仍需处理且会按优先级回流的队列，中间是足够完整但克制的证据和详情，右侧是明确的人类决策入口。决策对象必须分层：论文/产品本身可以被解决、搁置或排除，具体启发点则可以被接受为 L2 或拒绝。默认不操作就是搁置，避免系统用沉默冒充同意；所有接受的 L2 启发都必须保留来源、当时思考和人机对话上下文，方便后续落实、追责和复盘。视觉上保持接近苹果系统的克制、留白、玻璃感和清晰层级，但形式始终服务于判断效率：让人先看见最重要的问题、最可信的证据和下一步可执行动作，而不是被装饰、字段和信息密度淹没。

## 当前目录结构

```text
extension/self-cognition/
  extension.json
  SELF_COGNITION_OVERVIEW.md
  backend/
    extension_backend_handler.js
    self_cognition_core.js
  frontend/
    index.html
    main.js
    styles.css
    mobius3d.js
    mobius-ring.js
    favicon.svg
    mock_clusters.json
    mock_evolution.json
    package.json
    dist/
      ...
```

关键文件说明：

- `extension.json`：扩展元信息和定时任务配置。
- `backend/extension_backend_handler.js`：后端入口，实际转发到 `self_cognition_core.js`。
- `backend/self_cognition_core.js`：核心后端逻辑，包含数据库初始化、扫描、产品抓取、AI 深读、Agent 追问、自进化事件、调度同步。
- `frontend/index.html`：页面结构，包含 hero、论文调研、产品调研、自进化历史、尾页、详情弹窗和 prompt 导出弹窗。
- `frontend/main.js`：前端状态管理、数据加载、渲染、操作事件、AI 深读、详情页、Agent 追问。
- `frontend/styles.css`：整体视觉、响应式、论文/产品卡片、详情页、移动端适配。
- `frontend/mobius3d.js`：hero 和尾页 3D 背景。
- `frontend/mobius-ring.js`：Research Radar 环形可视化。
- `frontend/mock_clusters.json` / `mock_evolution.json`：后端缺失或降级时使用的演示数据。
- `frontend/dist/`：运行服务实际读取的前端静态副本；源码改动后通常需要同步到 dist。

## 定时任务

当前 `extension.json` 中配置了 3 个每日定时任务，全部为 UTC 17:00：

| Schedule ID | 动作 | 作用 |
|---|---|---|
| `self-cognition-arxiv-1700` | `scan_arxiv` | 每日扫描 arXiv 论文，并自动触发 AI 深读新增和 backlog |
| `self-cognition-products-1700` | `scan_product_url` | 每日重扫产品、发现产品，并自动触发 AI 深读 |
| `self-cognition-evolution-1700` | `seed_evolution_from_git` | 每日从 git log 同步自进化事件 |

前端展示的定时信息来自后端 bootstrap 返回的 constants：

- `daily_scan_time`: `17:00`
- `daily_scan_timezone`: `UTC`
- `daily_interval_minutes`: `1440`
- `schedule_ids`: 当前 3 个 schedule id

后端也保留了 retired schedule 清理逻辑，用于移除旧的 `0900 / 1000 / 0030 / 1100` 等历史调度。

## 后端能力概览

核心后端文件是 `backend/self_cognition_core.js`。它承担以下职责：

### 1. 数据库初始化

运行数据位于部署数据目录：

```text
.deploy_data/protected_data/extension/self-cognition/self-cognition.db
```

主要表：

| 表 | 作用 |
|---|---|
| `keywords` | 论文和产品扫描关键词 |
| `keyword_weights` | 关键词权重，受用户反馈影响 |
| `arxiv_items` | 论文库 |
| `product_research` | 产品研究库 |
| `scan_runs` | 扫描记录 |
| `install_state` | 安装状态和调度状态 |
| `user_feedback` | 用户对论文的 boost/neutral/exclude 反馈 |
| `evolution_events` | L1/L2/L3 自进化事件账本 |
| `agent_runs` | L2 Agent 深读运行记录 |
| `agent_messages` | Agent 深读和追问消息记录 |

当前数据库里还存在历史/预留表：

- `directives`
- `ideas`
- `product_scan_runs`

这些不是当前主 UI 的核心表，但保留在数据库中。

### 2. 论文扫描

相关函数：

- `scanArxiv`
- `parseArxiv`
- `scorePaper`
- `getPaperClusters`
- `getTopPicks`
- `getPapersByCluster`
- `listPapers`

论文扫描使用关键词和查询表达式拉取 arXiv 数据，入库字段包括：

- title
- source_url
- source_id
- authors
- published_at
- updated_arxiv_at
- abstract
- tags
- matched_keywords
- relevance
- cluster_label
- priority_score
- cluster_keywords
- citations
- mark / note
- read_at
- ai_inspiration

论文不是只按时间展示，而是会被打分、聚类，并在前端展示 Top Picks 和 cluster 面板。

### 3. 产品扫描和发现

相关函数：

- `scanOneProduct`
- `scanProducts`
- `scanProductAction`
- `discoverFromCorpus`
- `discoverCompetitorsViaAgent`
- `upsertProduct`
- `groupedProducts`
- `listProducts`

产品研究不是传统意义的“竞品分析”，现在前端文案已经统一为“产品调研”。数据库表名、变量名里仍有 `competitor` 遗留，这是兼容边界，后端 action 也保留 `get_competitors / update_competitors / discover_competitors_via_agent` 等名称。

产品字段包括：

- name
- source_url / normalized_url
- status: `candidate` 或 `tracked`
- category
- relevance
- tags
- aliases
- reason
- discovery_logic
- discovered_from_url
- fetched_title
- fetched_description
- mark / note
- read_at
- ai_inspiration
- auto_discovered
- last_scanned_at

产品可以来自：

- 手动 URL 扫描
- 已跟踪产品批量重扫
- arXiv 语料和产品语料的别名/标签发现
- Agent 智能发现

### 4. L2 Agent 深度阅读

相关函数：

- `aiScanArxiv`
- `aiScanProducts`
- `createAgentRun`
- `appendAgentMessage`
- `finalizeAgentRun`
- `buildPaperContext`
- `buildProductContext`
- `parseInspirationJson`
- `saveInspiration`

深度阅读的核心目标不是摘要，而是产出 `ai_inspiration`：对莫比乌斯可借鉴的方向。

每条启发通常包含：

- `title`
- `direction`
- `mobius_use`
- `priority`: `high / medium / low`

深度阅读后，前端详情页会把最高优先级启发放到“重点判断”和“AI 借鉴方向”主卡片里，其他启发作为补充条目。

### 5. 详情追问和启发修改

相关函数：

- `chatWithAgent`
- `handleReadFile`
- `handleUpdateInspiration`
- `handleAddInspiration`
- `handleDeleteInspiration`
- `exportAgentPrompt`

用户在论文或产品详情页可以直接向 AI 追问。Agent 可以读取相关上下文，并在授权工具范围内修改启发条目。

详情页也支持“实际修改（导出给小莫）”，把当前 Agent run 的结论整理成可交给主体小莫或后续 session 的执行指令。

### 6. 自进化历史

相关函数：

- `seedEvolutionFromGit`
- `getEvolutionFeed`
- `promoteL2ToL1`
- `seedL3Placeholders`
- `getEvolutionStats`

自进化分为三层：

| 层级 | 当前含义 |
|---|---|
| L1 | 已合入事实，通常来自 git log / merged commit |
| L2 | 待审候选启发，可由用户批准并升级 |
| L3 | 预留的系统级自修改能力，目前只是 placeholder |

当前前端支持 L1/L2/L3 tab：

- L1：展示已发生的自进化事件。
- L2：展示待审候选和已批准事件。
- L3：展示风险说明和预留入口。

## 前端页面结构

当前前端分为 5 个主要区域：

### 1. Hero / Research Radar

入口标题为 `Mobius Research Radar`，用于表达这个扩展的定位：持续追踪论文与产品。

包括：

- 下一次定时扫描时间
- 上次论文扫描
- 上次产品扫描
- 3D Radar 可视化
- 跳转论文调研 / 产品调研的入口

### 2. 论文调研

功能包括：

- 手动扫描 arXiv
- 扫描后同步 AI 阅读
- 论文关键词管理
- AI 渠道选择
- AI 深度阅读未读论文
- 按关键词、状态、收藏、搜索筛选
- 展示 Top Picks
- 展示 cluster 列表
- 论文卡片支持：
  - 详情
  - 已读/未读
  - 收藏
  - 归档
  - 原文链接
  - boost/neutral/exclude 反馈
  - AI 借鉴方向状态

### 3. 产品调研

功能包括：

- 手动输入产品 URL 扫描
- 留空 URL 走 Agent 智能发现
- 已跟踪产品批量重扫
- 产品关键词管理
- AI 渠道选择
- AI 深度阅读未读产品
- 按产品状态、阅读状态、搜索筛选
- 显示或隐藏 AI 排除项
- 已跟踪产品和候选产品分栏展示
- 产品卡片支持：
  - 晋升正式/已跟踪
  - 详情 / 追问
  - 已读/未读
  - 打开产品页
  - AI 借鉴方向状态

### 4. 论文/产品详情页

详情页最近已重做，核心原则是“抓重点，而不是堆字段”。

当前结构：

1. 顶部 Hero：分数、标题、作者/类别、状态 chip。
2. 重点判断：直接给出最高优先级结论、简短判断和下一步。
3. AI 借鉴方向：最高优先级主卡 + 其他启发条目。
4. 摘要/快照：论文摘要或产品页面快照。
5. 来源与字段档案：折叠展示 URL、扫描来源、发现逻辑、字段细节。
6. 右侧操作区：
   - 标记不重要
   - 标记重要
   - 已读
   - 标记需要直接融合
   - 外部链接
   - AI 追问

桌面端使用主内容 + 右侧操作栏；移动端改为单列。

### 5. 自进化历史

展示莫比乌斯自身演化事件：

- L1 已合入
- L2 待审
- L3 预留

可扫描 git log，同步自进化历史。

## 当前对外 action

后端 bootstrap 返回的 retained actions 当前包括：

```text
bootstrap
list_arxiv_items
get_paper
mark_paper
mark_paper_read
export_papers
scan_arxiv
submit_feedback
chat_with_paper
get_paper_clusters
get_top_picks
get_papers_by_cluster
list_product_items
get_product
mark_product
mark_product_read
export_products
scan_product_url
get_keywords
update_keywords
get_competitors
update_competitors
list_scan_runs
get_evolution_feed
promote_L2_to_L1
seed_evolution_from_git
get_L3_placeholder
get_evolution_stats
list_ai_channels
ai_scan_arxiv
ai_scan_products
discover_competitors_via_agent
chat_with_agent
rewrite_inspiration_style
export_agent_prompt
list_agent_runs
get_agent_messages
```

注意：前端历史上存在 `list_my_feedbacks` 调用，但当前 retained actions 中没有该 action。当前前端会 catch 失败并降级为空反馈。这是一个明确的后续修复点。

## 当前真实数据快照

以下数据来自 2026-06-28 当前本地 self-cognition 数据库：

### 表计数

| 表 | 数量 |
|---|---:|
| `arxiv_items` | 101 |
| `product_research` | 11 |
| `evolution_events` | 290 |
| `agent_runs` | 4 |
| `agent_messages` | 73 |
| `scan_runs` | 19 |
| `keywords` | 15 |
| `keyword_weights` | 8 |
| `user_feedback` | 5 |
| `ideas` | 8 |
| `directives` | 0 |
| `product_scan_runs` | 0 |
| `install_state` | 3 |

### 论文状态

| 指标 | 数量 |
|---|---:|
| 论文总数 | 101 |
| 已读论文 | 12 |
| 有 AI 启发的论文 | 3 |
| 未深读且未排除论文 | 97 |
| mark 为空 | 82 |
| mark = `read` | 18 |
| mark = `excluded` | 1 |

当前主要 cluster：

| Cluster | 数量 | 最高分 |
|---|---:|---:|
| `agent-harness` | 1 | 28 |
| `recursive-self-reference` | 4 | 20.43 |
| `meta-learning` | 94 | 8.2 |
| `self-improvement` | 1 | 0.4 |

### 产品状态

| 指标 | 数量 |
|---|---:|
| 产品总数 | 11 |
| tracked / 已跟踪 | 3 |
| candidate / 候选 | 8 |
| 已读产品 | 2 |
| 有 AI 启发的产品 | 3 |
| 未深读且未排除产品 | 0 |
| mark = `boost` | 3 |
| mark = `excluded` | 8 |

当前产品侧已经补齐深度阅读缺口；论文侧还有明显 backlog。

### Agent 深读运行

| kind | status | count |
|---|---|---:|
| paper | completed | 1 |
| product | completed | 3 |

最近运行：

- `agent_run_151c8c2e1a531a1a`：product，完成，1 个产品，0 个启发，1 个排除。
- `agent_run_208b80d73e1d7129`：product，完成，6 个产品，0 个启发，5 个排除。
- `agent_run_7595cb73db882902`：product，完成，5 个产品，3 个有启发，2 个排除。
- `agent_run_3c5c0155396c06d0`：paper，完成，10 篇论文，3 篇有启发，7 篇排除。

### 扫描记录

| scan_type | status | count | 最近时间 |
|---|---|---:|---|
| arxiv | ok | 8 | 2026-06-28T09:01:22.175Z |
| arxiv | error | 2 | 2026-06-25T14:21:42.989Z |
| product | ok | 9 | 2026-06-27T10:01:37.315Z |

### 自进化事件

| level | status | count |
|---|---|---:|
| L1 | merged | 282 |
| L2 | pending_review | 4 |
| L2 | promoted_to_L1 | 1 |
| L3 | placeholder | 3 |

## 当前完成度

已经比较成型的部分：

- 每日定时扫描框架。
- arXiv 论文入库、聚类、打分和 Top Picks。
- 产品入库、候选/已跟踪分组、批量重扫。
- 产品侧 backlog 深读已补齐。
- L2 Agent 深读和 AI 启发结构。
- 详情页重点化改造。
- 点开详情即标记已读，并使用 `read_at` 通道，不再覆盖 `mark`。
- 移动端论文/产品区域已能优先看到结果列表。
- 产品调研文案已从“竞品”改成“产品”，但内部变量/API 名仍兼容旧名。
- 自进化 L1/L2/L3 展示链路。
- prompt 导出给主体小莫的入口。

仍需要继续优化的部分：

1. 论文侧 backlog 很大：当前约 97 篇未深读且未排除。
2. `list_my_feedbacks` 前后端不一致：前端有调用，后端 action 列表没有。
3. `reject_L2` 当前前端有按钮倾向，但后端 retained actions 未列出对应 action，需要补齐或移除。
4. L3 仍是 placeholder，没有真正的权限、审计、回滚和沙箱执行。
5. 产品/论文的 AI 排除状态目前主要依赖 `mark='excluded'`，中长期最好拆出更明确的 AI 阅读状态字段。
6. 前端 dist 需要手动或构建流程同步，源码和 dist 同步容易遗漏。
7. 定时 UI 目前表达 UTC 17:00，如果用户语义是本地下午 5 点，需要进一步明确时区展示。
8. 论文 cluster 中 `meta-learning` 占比过高，说明聚类逻辑还需要更细分。

## 维护边界和注意事项

- `frontend/dist/` 是运行态静态文件副本，虽然通常不作为源码主入口，但当前服务会读取它；改前端后要同步。
- 产品调研内部仍保留 `competitor` 命名，不要为了文案一致强行全链路重命名，否则会牵动 DOM id、CSS class、后端 action、数据库兼容。
- `mark` 字段目前同时承载人工标记和 AI 排除含义，修改时要非常小心。
- `read_at` 是当前已读状态的后端真相源，前端 localStorage 只是 UI 缓存和乐观更新。
- AI 深读会真实消耗模型 token，不应在 UI 体检或 Playwright 检查中误触发。
- `chat_with_agent` 可能通过工具修改 inspiration，详情页刷新逻辑要保持和 `get_paper/get_product` 兼容。

## 未来推荐路线

短期优先级：

1. 修复 `list_my_feedbacks` action，恢复真实反馈计数和历史状态。
2. 对论文 backlog 做批量深读、失败重试和进度展示。
3. 明确 AI 阅读状态，不再只靠 `ai_inspiration` 和 `mark` 推断。
4. 补齐或移除 L2 reject 能力，避免 UI 和后端不一致。

中期优先级：

1. 将 cluster 从规则匹配升级为更细粒度聚类，减少 `meta-learning` 过度聚合。
2. 给每条 AI 启发增加状态：待评估、已采纳、已导出、已实现、已废弃。
3. 将 `export_agent_prompt` 和小莫 session 创建链路打通，让“实际修改”从导出文本升级为可控的任务创建流程。
4. 给每日扫描增加可视化 run history，包括新增、更新、排除、深读成功、深读失败。

长期方向：

1. 把 self-cognition 从“资料雷达”升级为“自进化提案系统”。
2. 把 L2 启发和 L1 已合入事件建立可追溯关系，能回答“这个改动来自哪篇论文/哪个产品的启发”。
3. 在 L3 能力具备安全边界后，引入自动生成改造计划、沙箱验证、审批合入和回滚审计。

## 当前一句话结论

`self-cognition` 已经从一个研究展示页演进成了莫比乌斯的外部研究/产品感知层和内部自进化账本。它现在最强的是“看见资料并形成启发”，下一步最关键的是“把大量论文 backlog 深读完，并把启发更可靠地转成可执行改造任务”。
