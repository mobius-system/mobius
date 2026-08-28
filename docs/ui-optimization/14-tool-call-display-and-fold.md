# 14. 工具调用显示与折叠：默认回复时间线规格

本文只讨论模型回复里的过程时间线：工具如何分组、默认展开什么、运行中如何反馈、命令输出露到哪一层。源码行号以 2026-08-28 工作区快照为准；不改 Harness、SSE 或 JSONL 协议。

## 0. 结论

- 默认聊天工作台应选 CodexMonitor 的时间线逻辑作为基线，不能继续沿用 Mobius Easy 的整轮 kind 桶。
- CodexMonitor 按相邻事件形成工具突发，普通消息会切断分组，所以用户看到的顺序仍是模型真正说话和执行的顺序。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:274-320）
- Mobius Easy 在整轮内用 Map 按 kind 汇总，后来发生的同类动作会被搬回该桶首次出现的位置，过程顺序因此失真。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:160-175,228-243）
- CodexMonitor 的组默认展开、单行细节默认折叠，比 Easy 的“每类一张折叠汇总”更容易扫到正在做什么，又不会把原始参数铺满页面。（examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:58-61；examples/CodexMonitor/src/features/messages/components/Messages.tsx:241-278）
- 它对 file edited、清洗后的 command、searching query 给出一行语义摘要，信息粒度更接近聊天，而不是日志卡。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:323-419；examples/CodexMonitor/src/features/messages/components/MessageRows.tsx:697-724）
- 它的 Working 使用本轮最新思考标题，并在遇到 assistant 消息后停止沿用旧标题，运行反馈比“正在继续处理”更有上下文。（examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:189-204；examples/CodexMonitor/src/features/messages/components/MessageRows.tsx:343-352）
- Mobius 应学连续工具加 reasoning 分组、行内摘要、当前思考标题和折叠行的命令尾部，不应照搬英文文案或其它产品控制项。
- Mobius 还应保留自己的失败自动展开：CodexMonitor 当前只给失败状态着色，并没有通用的失败行自动展开规则。（examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:58-61,224-246；mobius/frontend/src/components/viewer/EntryCard.tsx:123-149）
- 标准 JSONL 应继续作为逐条 entry、原始字段、完整命令结果和搜索定位的取证面，不宜再承担默认聊天 transcript。（mobius/frontend/src/components/viewer/EntryCard.tsx:340-478）
- 因而明确取舍是：默认 Easy 学 CodexMonitor 的时间线，错误展开学 Mobius 自己，标准 JSONL 保留但退到详细入口。

## 1. CodexMonitor 的回复时间线

### 1.1 条目类型与转换边界

CodexMonitor 先把线程条目转换成稳定的 ConversationItem：用户与 assistant 是 message，思考是 reasoning，计划、命令、文件修改、MCP、Web 搜索、图片查看和上下文压缩都变成 tool；命令同时保留 cwd、status、aggregatedOutput 和 durationMs。（examples/CodexMonitor/src/utils/threadItems.conversion.ts:44-98,100-196,209-245）这个中间层使渲染器可以按“消息是否打断工具过程”工作，而不必按原始协议字段分支。

### 1.2 探索合并是上游语义化，不是只改皮肤

prepareThreadItems 会识别 cat、sed、rg、grep、find 等只读、列举或搜索命令；它先去掉 shell -lc 与前置 cd，再把可完全识别且未失败的命令转换成 read、list、search 探索条目，无法完整识别或失败的命令仍保留原工具。（examples/CodexMonitor/src/utils/threadItems.explore.ts:12-33,84-120,199-220,254-338）相邻且状态相同的探索条目会合并并去重，普通工具或消息会保留原位置并终止这次合并。（examples/CodexMonitor/src/utils/threadItems.explore.ts:292-376）

渲染前还有第二层窄合并：tool group 内只有“连续 explore run”会合成一个 ExploreRow，中间插入 tool 或 reasoning 都会截断 run。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:231-272）测试确认两个纯 explore 会显示成一个 Explored 块而不是额外的 tool group，tool 或带正文的 reasoning 插入时仍保持先后顺序。（examples/CodexMonitor/src/features/messages/components/Messages.test.tsx:1023-1058,1095-1188）

### 1.3 toolGroup 的精确规则

buildToolGroups 只把相邻的 tool、reasoning、explore、已回答 userInput 放入缓冲；message、diff、review 等任何其它条目都会 flush，所以 assistant 文本天然打断工具突发且不会被吞掉。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:222-228,274-320）分组计数中，一个普通 tool 算一次，ExploreRow 按 entries 数量算步骤，reasoning 与 userInput 只算 messageCount；测试用两个普通工具加三个探索步骤得到 5 tool calls。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:282-305；examples/CodexMonitor/src/features/messages/components/Messages.test.tsx:1231-1281）

它不会为了单条工具再包一层：无工具或归一化后仅一个条目时直接输出 item。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:295-307）这避免“1 次工具调用”外面还有“工具组”的双重折叠。

### 1.4 默认展开与折叠

collapsedToolGroups 初始为空，因此工具组默认展开；expandedItems 初始为空，因此 ToolRow、ReasoningRow 和已回答输入的详细内容默认不展开。（examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:58-61；examples/CodexMonitor/src/features/messages/components/Messages.tsx:166-225,241-278）ReasoningRow 即使未展开也保留标题和截短正文，而工具参数、cwd、diff、非命令输出通常要展开行后才出现。（examples/CodexMonitor/src/features/messages/components/MessageRows.tsx:510-560,783-870）

唯一明确的自动展开特例是“最近一条已有 output 的 plan”，且用户手动切换过后不再接管。（examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:224-246）失败 tool 只有红色 tone，没有被加入 expandedItems；所以“失败行强制开”应由 Mobius 目标规格补上，而不是误写成 CodexMonitor 现状。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:429-458；examples/CodexMonitor/src/features/messages/components/MessageRows.tsx:697-725）

### 1.5 Working 跟随最新思考

parseReasoning 从 summary 或 content 的第一条非空行生成最多 80 字的标题，并把余下部分作为正文。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:151-203）视图从尾部反向找最新 reasoning，但遇到任一 message 就停止，因而不会把上一轮思考标题带到新一轮；只有标题没有正文的 reasoning 不渲染成行，却仍能驱动 Working。（examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:179-220）对应测试覆盖了“Scanning repository”成为 Working、标题行本身不重复渲染，以及 assistant 回复之后回退为 Working 的行为。（examples/CodexMonitor/src/features/messages/components/Messages.test.tsx:764-789,849-915）

Working 固定渲染在全部时间线条目之后，运行中显示计时器与最新 reasoningLabel，缺省才显示 Working…；停止后改为 Done in 时长。（examples/CodexMonitor/src/features/messages/components/Messages.tsx:284-294；examples/CodexMonitor/src/features/messages/components/MessageRows.tsx:301-366）

### 1.6 命令输出的 live tail

命令摘要会剥掉 shell -lc 包装和前置 cd，只把真正命令放在行内；文件修改显示 file edited 与 basename，搜索显示 searching 或 searched 与 query。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:323-419；examples/CodexMonitor/src/features/messages/components/MessageRows.tsx:697-724）工具摘要测试还明确覆盖了运行中的 Web Search、MCP search 和 camelCase inProgress，防止“正在搜索”被误判成完成态。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.test.ts:20-43）

命令正在运行超过 600ms 后，即使 ToolRow 未展开也可显示输出；已知 duration 至少 1200ms 的长命令也会露出输出。输出窗口只保留最后 200 行，并在用户仍贴近输出底部时持续钉到底部；用户上滚后停止抢动。（examples/CodexMonitor/src/features/messages/components/MessageRows.tsx:192-249,727-756,825-870；examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:41-42）这比“等命令完成后展开整张卡”更适合默认回复过程。

### 1.7 自动滚动

Messages 用 120px 作为“接近底部”阈值；只有用户仍在底部附近时，条目文本、reasoning 长度、探索步骤、工具 status 或 output 长度变化以及 thinking 状态变化才继续贴底。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:41,543-568；examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:54-111）切换 thread 会重新允许自动贴底，即便上一个 thread 曾被手动上滚；测试明确断言 scrollTop 被重置到新线程末尾。（examples/CodexMonitor/src/features/messages/components/Messages.test.tsx:1284-1337）

用户可见的回复流是：

    [用户气泡：请检查并修复]
              ↓
    [▼ 3 tool calls, 1 message]          ← 组默认展开
      ├─ file edited: Foo.tsx            ← 一行摘要，细节默认折叠
      ├─ rg "buildToolGroups" src/…      ← 清洗后的命令
      │    └─ …最后若干行输出             ← 运行较久时可直接露尾部
      └─ Scanning tests                  ← reasoning 标题
              ↓
    [助手气泡：已修复并通过测试]          ← 普通消息打断分组且始终保留
              ↓
    [◌ 0:18 Verifying the result]        ← 仍运行时的底部 Working

## 2. Mobius 当前两套回复面

### 2.1 标准 JSONL：轮次、卡片与原始证据

标准面先按每条 user entry 开新轮，后续 assistant 与工具条目归入该轮；同一次用户输入的重复协议形态会在尚无 assistant 输出时去重。（mobius/frontend/src/components/viewer/rounds.ts:47-74）RoundGroup 默认展开最新两轮，旧轮折叠；轮内仍逐条保留 entry 的原始顺序。（mobius/frontend/src/components/viewer/RoundGroups.tsx:148-177,217-255）

只读或搜索工具还有一层局部分组：仅连续 Read、Grep、Glob、WebFetch、WebSearch、LS 且至少两条时合成“探索”组；单条保持普通卡，非探索条目立即截断。（mobius/frontend/src/components/viewer/explore-group.ts:16-18,24-37,40-68）这个组默认折叠，包含失败或搜索命中时打开。（mobius/frontend/src/components/viewer/RoundGroups.tsx:49-94）

单卡是标准面的核心：搜索命中优先强制开，forgotten-flag 机械收尾可强制默认折，patch、计划、可精简文本、图片与错误会开，普通代码或命令卡默认折。（mobius/frontend/src/components/viewer/EntryCard.tsx:123-149,262-295）forgotten-flag 规则会向前检查 8 个 JSONL 条目，只有命中系统提示且当前卡含 running.flag 才下发默认折叠 lineNo。（mobius/frontend/src/components/viewer/fold-rules.ts:23-31,140-161）展开后可看原始 JSON 字段，或切到计划、代码、图片、精简模式；Bash 卡保留原命令、cwd 和完整结果。（mobius/frontend/src/components/viewer/EntryCard.tsx:340-478；mobius/frontend/src/components/viewer/BashCards.tsx:40-118,120-204）这套多层折叠适合取证，不适合默认聊天扫读。

运行态有两条线索：工具级状态由“tool_use 是否已有对应 result”推导 running、success、error；标准面底部另有 LIVE 卡，优先显示 realTimeInfo，否则显示距上一条 entry 的沉默时长与分级提示。（mobius/frontend/src/components/viewer/tool-status.ts:1-11,51-81；mobius/frontend/src/components/session-jsonl-panel.tsx:125-131；mobius/frontend/src/components/viewer/LiveTailCard.tsx:20-45,47-67）它能判断“尚未回结果”或“多久没新 entry”，但没有把最新 reasoning 转成聊天式 Working 标题。

### 2.2 Easy：整轮按 kind 汇总

默认工作台确实挂的是 Easy：ChatArea 在 layout 为 easy 时向 SessionJsonlPanel 传 variant="easy"，面板再懒加载 EasyJsonlView；standard 分支才渲染 JsonlView。（mobius/frontend/src/components/chat.tsx:4848-4883；mobius/frontend/src/components/session-jsonl-panel.tsx:67-68,87-124）

Easy 仍复用标准面的 user 轮次，但随后为整轮创建 Map<EasyActivityKind, ActivityBucket>。explore、command、file-change、plan、tool、progress、error、image 各自只有一个桶，最终按各桶第一次出现的 index 排序。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:14-46,160-175,228-243）这意味着“命令 A → assistant 进度 → 编辑 → 命令 B”会被显示成“命令桶（A+B）→ 进度桶 → 编辑桶”，不是发生顺序。

所有 assistant 文本先收集，最后一条成为 assistantResponse，之前的每一条都被塞进一个 progress 桶。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:177-182,225-257）现有测试只断言最终回复与四种 activity 存在，没有断言相邻顺序或消息边界，因此没有防住整轮重排。（mobius/frontend/tests/easy-jsonl-model.test.ts:6-24）

Easy 每个 activity 默认折叠，只有 error 桶 defaultExpanded；用户问题和最终回复始终直接显示。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:230-243；mobius/frontend/src/components/easy-jsonl/EasyJsonlView.tsx:57-97,210-241）运行中的最后一轮在底部显示“正在继续处理”，副文案直接用 liveText 或“智能体正在执行当前任务…”，没有提炼最新思考标题。（mobius/frontend/src/components/easy-jsonl/EasyJsonlView.tsx:200-229）顶部 SessionStatusChip 另显示启动中、执行中、待命或失败等会话级状态。（mobius/frontend/src/components/session-status-chip.tsx:26-36；mobius/frontend/src/components/chat.tsx:4383-4391）

Easy 的 command activity 只收命令文本；工具结果循环只把 isError 结果加入 error 桶，因此成功 stdout 没有进入 Easy 时间线，更没有折叠行 live tail。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:189-215）标准面则必须先打开命令 entry 才看到 BashResultPanel。（mobius/frontend/src/components/viewer/EntryCard.tsx:442-463；mobius/frontend/src/components/viewer/BashCards.tsx:109-118,120-204）

两套 Mobius 面共用外层滚动：距底部超过 200px 视作用户在读旧内容，此时不抢滚动并显示“新消息”；否则 jsonlEntries 数量变化会滚到底。（mobius/frontend/src/components/session-jsonl-panel.tsx:75-85,136-142；mobius/frontend/src/components/chat.tsx:3882-3913）Easy 的搜索定位会展开 200-entry 窗口并滚到命中轮次，但不会自动展开命中 activity 详情。（mobius/frontend/src/components/easy-jsonl/EasyJsonlView.tsx:148-185）

## 3. 差距表

| 维度 | CodexMonitor | Mobius 标准 JSONL | Mobius Easy | 谁更合理 | 默认工作台应采用 |
| --- | --- | --- | --- | --- | --- |
| 分组单位 | 相邻 tool、reasoning、explore、userInput 的突发；普通消息即截断。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:222-320） | user 开启整轮，轮内逐 entry；只读搜索另做连续子组。（mobius/frontend/src/components/viewer/rounds.ts:47-74；mobius/frontend/src/components/viewer/explore-group.ts:44-68） | 整轮按 kind 建一个桶。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:160-175） | CodexMonitor | 扫描原顺序形成连续突发，不跨普通 assistant 文本合并。 |
| 单独 1 条是否成组 | 不包 toolGroup。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:295-307） | 不包 ExploreGroup，但仍位于 RoundGroup 与 EntryCard 两层结构中。（mobius/frontend/src/components/viewer/explore-group.ts:48-55；mobius/frontend/src/components/viewer/RoundGroups.tsx:148-180） | 仍生成“运行了 1 条命令”等 kind activity。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:142-153,228-243） | CodexMonitor | 孤立工具直接显示一行摘要，不造冗余外组。 |
| 探索如何计入 | 上游把可识别只读命令语义化；混合组按 explore entries 数计真实步骤。（examples/CodexMonitor/src/utils/threadItems.explore.ts:307-376；examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:282-291） | 只按连续探索工具卡数量聚合，失败阻止语义转换的问题不存在，因为仍是原 entry。（mobius/frontend/src/components/viewer/explore-group.ts:45-67） | 标题按去重后的 details 数，重复同参调用可能少算。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:156-157,231-242） | CodexMonitor | 计实际 call/step；可去重展示文本，但不可用去重数冒充调用数。 |
| 中间 assistant 文本去哪 | 普通 message 终止当前组并原位显示；测试确认不丢消息。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:311-318；examples/CodexMonitor/src/features/messages/components/Messages.test.tsx:1191-1229） | 作为独立 entry 原位显示。（mobius/frontend/src/components/viewer/RoundGroups.tsx:217-255） | 除最后一条外全部进入全轮唯一 progress 桶。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:177-182,225-243） | CodexMonitor 与标准面 | 最终回复永远独立；仅短进度可在相邻突发内按原位显示。 |
| 单条摘要粒度 | file edited + basename、清洗 command、searching + query。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:323-419；examples/CodexMonitor/src/features/messages/components/MessageRows.tsx:710-724） | 类型主题、lineNo、时间和 header short，偏日志卡。（mobius/frontend/src/components/viewer/EntryCard.tsx:340-386） | kind 总数 + 该桶最后一个 detail。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:228-243） | CodexMonitor | 中文动词 + 最有辨识度的对象；命令保留可识别开头。 |
| 默认展开层 | tool group 开；ToolRow 细节关；有 output 的最新 plan 自动开。（examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:58-61,224-246） | 最新两轮开、旧轮关；探索组关；单卡按内容类型决定。（mobius/frontend/src/components/viewer/RoundGroups.tsx:148-177；mobius/frontend/src/components/viewer/EntryCard.tsx:123-149） | 所有轮平铺；activity 关，error 开。（mobius/frontend/src/components/easy-jsonl/EasyJsonlView.tsx:57-97,197-243） | CodexMonitor | 工具突发组默认开，行细节默认折；取消默认聊天里的“轮—组—卡”三层门。 |
| 失败是否强制开 | 否；失败只影响 tone，通用 expandedItems 仍为空。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:429-458；examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:58-61） | 是；失败探索组和失败工具卡默认开，forgotten-flag 特例除外。（mobius/frontend/src/components/viewer/RoundGroups.tsx:49-62；mobius/frontend/src/components/viewer/EntryCard.tsx:123-149） | 是；error activity 默认开。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:240-243） | Mobius | 失败行和包含失败的组强制展开，优先级仅低于显式搜索定位。 |
| 运行中文案 | 底部计时 + 本轮最新 reasoning 标题，旧轮标题不会串入。（examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:189-204；examples/CodexMonitor/src/features/messages/components/MessageRows.tsx:343-352） | LIVE 显示原始实时状态或沉默时长。（mobius/frontend/src/components/viewer/LiveTailCard.tsx:20-67） | “正在继续处理” + 原始 liveText/通用句。（mobius/frontend/src/components/easy-jsonl/EasyJsonlView.tsx:221-229） | CodexMonitor | 最新思考标题；取不到时显示“正在处理”。会话状态仍留在顶栏。 |
| 命令输出 | 清洗命令；运行 600ms 后或长命令可在折叠行露最后 200 行，并自行贴尾。（examples/CodexMonitor/src/features/messages/components/MessageRows.tsx:192-249,727-756） | 展开 entry 后看原命令与结果，适合完整取证但没有折叠行 tail。（mobius/frontend/src/components/viewer/EntryCard.tsx:442-463；mobius/frontend/src/components/viewer/BashCards.tsx:109-204） | 成功 stdout 不进入 activity。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:197-202） | CodexMonitor 用于默认；标准面用于详情 | 行内露有限 tail，完整 stdout 链到标准详细视图。 |
| 计划有 output | 自动展开最近一条 plan，尊重手动切换。（examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:224-246） | plan 属于本地自动展开条件。（mobius/frontend/src/components/viewer/EntryCard.tsx:123-149） | plan activity 默认折叠。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:230-243） | CodexMonitor 与标准面 | 计划产物首次完整到达时自动展开；用户手动折叠后不再抢。 |
| 自动滚动 | 以最后条目的文本、status、output 长度为 key；120px 内贴底，切线程重新贴底。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:543-568；examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:66-111） | 与 Easy 共用外层，仅按新 entry 等依赖贴底；超过 200px 显示新消息。（mobius/frontend/src/components/chat.tsx:3882-3913） | 同标准面；搜索只滚到轮，不打开 activity。（mobius/frontend/src/components/easy-jsonl/EasyJsonlView.tsx:166-185） | CodexMonitor 更精确，Mobius 的不抢滚动更完整 | 保留 200px 与“新消息”，补上同一命令 output 增长触发和切 Session 重新贴底。 |
| 与 Chat / Diff 壳的关系 | fileChange 用 ToolRow 行内摘要，diff item 仍在同一消息序列。（examples/CodexMonitor/src/features/messages/components/Messages.tsx:208-225） | JSONL 卡内可切代码/字段；属于 Chat 内容层。（mobius/frontend/src/components/viewer/EntryCard.tsx:442-478） | Chat 层在 centerMode=diff 时隐藏，另挂 Diff 中心层并提供返回对话。（mobius/frontend/src/components/chat.tsx:4373-4376,4848-4852,5320-5323） | 各自解决不同层级 | 时间线只放摘要；点详情可开 Diff/标准取证面，但返回后时间线顺序与滚动位置不变。 |

## 4. 必须学 / 可学 / 不要学

### 必须学

- 连续工具与 reasoning 形成一个真实时间顺序的突发组，assistant 普通文本是边界；对应 CodexMonitor 的 buffer/flush 规则。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:274-320）
- 组默认展开，组内 ToolRow 的参数、cwd、diff 和完整输出默认折叠；孤立单条不再套组。（examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:58-61；examples/CodexMonitor/src/features/messages/components/MessageRows.tsx:783-870）
- 一行摘要使用“已编辑 Foo.tsx”“rg …”“正在搜索 …”这类动作加对象，而不是只有“修改了 1 个文件”。（examples/CodexMonitor/src/features/messages/utils/messageRenderUtils.ts:339-419；examples/CodexMonitor/src/features/messages/components/MessageRows.tsx:710-724）
- 底部 Working 使用本轮最新 reasoning 标题；标题型 reasoning 不必在组内再重复一行。（examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:179-220）
- 长命令或正在运行的命令可在折叠行露有限尾部，用户上滚后停止追尾。（examples/CodexMonitor/src/features/messages/components/MessageRows.tsx:192-249,727-756）

### 可学

- 把 rg、grep、cat、sed 等纯探索命令在渲染上游语义化为 search/read/list，但识别失败或执行失败时保留原命令，避免错误归类。（examples/CodexMonitor/src/utils/threadItems.explore.ts:254-338）
- 计划一旦有 output 可自动展开一次，并尊重用户之后的手动折叠。（examples/CodexMonitor/src/features/messages/components/useMessagesViewState.ts:224-246）

### 不要学

- 不学 CodexMonitor 的英文皮肤；Mobius 目标文案应是“工具调用、已编辑、正在搜索、正在处理”。
- 不把 Send/Stop 合并、Queue/Steer 或其它 Composer 控制项带入本轮，它们不回答工具过程如何呈现。
- 不删除标准 JSONL；它保留原始 entry、完整结果、字段模式、搜索定位和问题取证职责。
- 不继续按整轮 kind 桶归档，因为它会把被中间回复分开的同类工具重新合并，并把中间回复收进一个 progress 桶。（mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts:160-175,225-243）

## 5. 目标 Easy 时间线规格

这是一份只改 easy renderer 的折叠契约；输入仍是当前 JSONL，SSE、Harness、backend 和 JSONL 形状均不变。

1. 用户消息始终直接可见，不受工具组、旧轮或 activity 折叠影响。
2. 按原始条目顺序扫描。连续 tool、可见 reasoning 与被明确识别为短进度的 assistant 文本形成一次工具突发；普通 assistant 文本、用户文本和最终回复都会 flush 当前突发。
3. 两条及以上工具过程显示“▼ N 次工具调用”组，组默认展开；孤立单工具不包外组，直接显示一行。N 统计实际调用或语义化探索步骤，不使用去重后的摘要数。
4. 组内每行默认只显示状态图标与摘要：已编辑 Foo.tsx、rg …、正在搜索 …。参数、cwd、diff、完整 stdout 和原始 JSON 默认折叠。
5. assistant 普通文本打断分组并原位显示；最后一条 assistant 回复始终作为独立回复可见。中间短进度可以成为相邻组内的一行，但不得跨后续 assistant 文本汇入全轮 progress 桶。
6. 运行中底部固定显示 Working：优先取本轮最后一个 reasoning 标题，取不到时显示“正在处理”。标题型 reasoning 若已用于 Working，不在时间线重复渲染空详情行。
7. 任一失败行默认展开；包含失败的工具组也保持展开并在组摘要显示“含失败”。搜索命中同样强制展开组与行。
8. 运行超过短延迟或已判定为长命令时，折叠行可露最后有限行输出；完整 stdout、stderr、原命令和原始字段从详细视图打开。
9. 计划首次收到非空 output 时自动展开一次；用户手动折叠后不再自动掀开。
10. 用户在底部附近时，新增条目和同一命令 output 增长继续贴底；用户上滚后保持阅读位置并显示“新消息”，切换 Session 时重新定位到该 Session 尾部。
11. 标准 JSONL / 详细视图保留在“工具”入口用于取证，不作为默认 transcript；从详情返回后保留 Easy 时间线的折叠态与滚动位置。

建议的最小状态层级是：

    Session
      ├─ 用户消息（始终可见）
      ├─ 工具突发组（默认开）
      │    ├─ 行摘要（始终可见）
      │    └─ 行详情（默认折；失败开）
      ├─ assistant 回复（原位；最终回复始终可见）
      └─ Working（仅运行中）

## 6. 下一轮文件级拆单（本轮不改代码）

### P0：把 Easy 从 kind 桶改为连续突发

- 文件：mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts、mobius/frontend/tests/easy-jsonl-model.test.ts。
- 用户结果：同类工具不再跨 assistant 文本或其它边界重排；孤立工具直接成行，多条相邻工具按真实顺序进入“N 次工具调用”；最终 assistant 回复仍始终可见。
- 测试必须补：tool → assistant → tool 产生两个突发；tool → reasoning → tool 保持一个组且顺序不变；单工具无外组；重复同参仍按两次计数；最后回复不进入 progress。
- 不改：viewer/rounds.ts 的 JSONL 用户轮次识别，不改协议、SSE、backend 或 Harness。

### P1：行内摘要、Working 与命令尾部

- 文件：mobius/frontend/src/components/easy-jsonl/easy-jsonl-model.ts、mobius/frontend/src/components/easy-jsonl/EasyJsonlView.tsx、mobius/frontend/src/components/easy-jsonl/easy-jsonl.css、mobius/frontend/tests/easy-jsonl-model.test.ts；如需复用纯摘要函数，可在 easy-jsonl 目录新增纯逻辑模块及对应测试。
- 用户结果：默认可扫到“已编辑 Foo.tsx / rg … / 正在搜索 …”；底部显示最新思考或“正在处理”；长命令在不展开详情时也能看到有限 tail，且不抢已上滚用户的滚动位置。
- 不改：mobius/frontend/src/components/viewer/BashCards.tsx 的标准面完整命令/结果取证行为，不把 SessionStatusChip 改成 Working，也不改变命令输出来源。

### P2：标准 JSONL 保持取证面，只收敛失败与搜索命中

- 文件：mobius/frontend/src/components/viewer/RoundGroups.tsx、mobius/frontend/src/components/viewer/EntryCard.tsx、mobius/frontend/src/components/viewer/fold-rules.ts、mobius/frontend/src/components/session-jsonl-panel.tsx，以及现有 viewer 搜索/折叠测试。
- 用户结果：从 Easy 进入标准详情时，失败或搜索命中的轮、探索组和 entry 一次性打开；其它原始卡仍按现有取证规则工作。
- 不改：标准 JSONL 的原始字段、lineNo、完整 stdout/stderr、代码/计划模式与 LiveTailCard；不把标准面重新设为默认聊天 transcript。
