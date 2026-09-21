# Issue Knowledge

## 会话端口入口合并 (2026-09-21, commit 51ed34cc)

- 元素1 `button[aria-label="进入项目端口"]` 的源头是 `AdvancedSessionActions` 调用 `ProjectPortEntryButton`；元素2 `button[aria-label="端口"]` 是 `SessionSkillMemoryEditor` 的 `ResourceTabButton`，展开 `DevPortsBar`。
- 删除高级操作区独立入口及 `project-port` 显示设置项；将同一 `ProjectPortEntryButton` 放入端口面板头部，继续透传 `vscodeSubPath` 与 `onRequestRunProject`，端口对话框和“请求智能体启动服务”能力保持不变。
- `python3 start.py` 已完成前端构建、PM2 reload 与 `:45616/api/v2/health` 检查。

## 模型接入向导模式 (2026-08-29, commit e12f7a25)

- `panels.tsx` 模型接入改双一级 Tab: 向导模式(默认) | 文件配置(原有三通道 sub-tab 原样平移, `data-tour="admin-section-models"` 锚点保留)。向导组件 `ModelAccessWizard`, 辅助函数在 `defaultCodexToml` 之后。
- 隐藏 3.5 步在"下一步"(step3→4)时执行: `deriveModelKeyFromName` = 真名留字母截 24 + 4 位随机小写后缀; 空 prefix 纯随机 6 位兜底; 查重拉列表比对(含 mobiusdefault, POST 是 upsert 会静默覆盖), 撞则重摇最多 8 次。
- Codex 路径必须同时派生 `env_key` = 渠道大写 + `_API_KEY` (后端 assertConfigEnvKeyMatches 要求 TOML env_key 与 secret_env_key 一致, 无 env_key 则启动不 export 秘钥)。
- 用户输入拼 TOML 一律过 `escapeTomlString`(反斜杠/引号/换行); URL 用 `isValidHttpUrl` 前端校验(后端 claude/codex 不校验)。
- 向导建完的模型与文件配置模式完全同构, 文件配置 Tab 经 `FileModelsModeRenderer key={wizardRefreshNonce}` 强制重挂载刷新列表。
- 测试管理员账号: hutianyi/hutianyi (fuqingxu/fuqingxu), ENABLE_PASSWORD_LOGIN=true。
- wire_api 固定 "responses"; chat-completions 网关需创建后在文件配置改。

## 模型接入向导 · Codex 订阅分支 (2026-08-29, commit ff550e24)

- 第2步 Harness 增加第三选项 Codex订阅, 走完全独立路径: 3=配置代理网络(复用 proxy-files 端点 model 侧编辑器 `SubscriptionProxyStep`) → 4=内嵌 Web 终端跑 `codex login --device-auth` + 「我已登录」按钮 → 5=注册。
- 关键事实: `codex --profile X login` 是非法命令(login 不支持 --profile); 订阅凭据写 `~/.codex/auth.json` (全 CODEX_HOME 共享, 与 profile 无关); codex TUI 未登录时会显示三选一菜单(Sign in with ChatGPT / **Sign in with Device Code** / API key)。
- web-terminal.ts 新增 `mode=adhoc`: 仅 admin、无 session、cwd=$HOME、初始命令走服务端白名单 `ADHOC_COMMANDS` (key=codex-subscription-login → `codex login --device-auth`), 前端不可注入任意命令。
- WebTerminalModal 增 `inline` prop + `InlineWebTerminal` 导出(向导内嵌复用同一 WS+xterm 逻辑, 非全屏弹窗)。
- 后端新端点 `POST /api/admin/model-access/codex-subscription/prepare`: 确保 `~/.codex/mobiusopenaisubscription.config.toml` 存在(不覆盖已有)。
- 注册 payload 不带 config_toml → 后端 upsert 读取磁盘现有文件, 不会覆盖用户预设内容(如 cli_auth_credentials_store)。无 env_key/api_key 时 tmux-codex 不 export 任何秘钥, 走 auth.json 订阅认证。默认 codex_model=gpt-5.1-codex。
- 服务器 headless: keyring 通常不可用, 登录实际走 --device-auth(设备码), 文件存储回落。

## 初始卡片 + session-context 块目录 (2026-09-01, commit 2cce0b1a / 0f2276a8)

- 后端拼装重构: `backend/services/session-context-sections.ts` 零依赖块目录(前后端共用), 每块一个 defineSection const = zh/en 标题 + 由标题派生的整行正则 + md 模板构建器(f-string+dedent tagged template, 空插值整行折叠), 块间零引用; `SESSION_SECTIONS` 顺序数组; session-context.ts 只剩 gather + formatBody 编排(token 工厂/isGitRepoRoot/pcTaskModePrompt 预计算注入 ctx, build 纯函数)。
- 逐字节一致性: `tests/session-context-parity.js` (npm run test:session-context-parity) 24 例对照 `tests/session-context-legacy-baseline.ts`(旧实现逐字复制) + 每块 pattern 自洽断言。改任何块文案后必跑。
- 历史格式怪癖(复刻在编排层, 勿顺手修): completionFlag 与 Issue/Session 段之间零空行(tightNext); pcTaskMode 段前双空行(doubleGap); blackboard token 头是 冒号+空格+token; memory 段无 hints 时尾部只剥一个换行。
- 前端初始卡片: `viewer/initial-context.ts` 辨识(头部 400 字符含引导语 + 至少 2 个目录锚点行, 排除 mobius sidecar 裸输入卡与"问题里引用引导语"的误命中) + 有序锚点扫描切块(question 用 lastIndexOf, 未知 ## 归前块); EntryCard 新增 CardMode 'initial' + INITIAL_THEME(orange); easyUserText 只返回问题; rounds.ts isWrappedVariant 引用目录 QuestionTitle。
- 配色: `--initial-*` CSS 变量(index.css :root 暗 / .light 亮两套), 徽章 text-orange-300 亮色下由 `.light .jsonl-entry-card > summary .text-orange-300` 修正为深橙。
- 前端跨目录 import 后端零依赖模块可行: viewer -> `../../../../backend/services/session-context-sections`(vite/tsc 均解析, tsconfig include 不用改)。
- 验证脚本: `tests/initial-context-parse.js`(真实 27KB JSONL 断言), `tests/initial-card-visual.js` / `tests/initial-card-themes.js`(Playwright; 需 localStorage 设 cc-token + layout_mode=normal_mode; 长会话要点「加载全部」首卡才进视窗)。
## 下载桌面客户端双 Tab (2026-09-02, commit cc3cfc76)

- `modals.tsx` DesktopDownloadModal 双 Tab: 「GitHub 最新版（推荐）」(默认, 跳转 `https://github.com/mobius-system/mobius/releases/latest`, target=_blank, 卡片下方展示完整 URL) | 「本地服务器」(原 manifest 下载原样保留)。Tab 样式照抄 panels.tsx 模型接入一级 Tab。
- GithubIcon 从 shell.tsx export 复用 (原为模块私有 createLucideIcon)。
- manifest 改懒加载: 首次切到 local Tab 才 fetch。坑: 「已发起」标记若用 state 放 effect deps, setState 触发 cleanup 的 ctrl.abort() 立刻杀掉在途请求 (ERR_ABORTED→超时)。必须用 ref (`localRequestedRef`) + unmount-only abort (`localAbortRef`), fetch effect 不写 cleanup。
- 验证脚本 `/tmp/desktop-modal-e2e.mjs` (9 断言: 默认 Tab/懒加载/切 Tab fetch/切回); 用户菜单按钮选择器 `button[aria-haspopup="menu"][aria-label="用户菜单"]`。

## 模型接入三选项一级 Tab (2026-09-02, commit 67cf8bc0)

- `AdminModelsPanel` 一级 Tab 改全宽三卡片 (sm:grid-cols-3): 向导模式(默认)|文件配置|BestAPI 订阅, 各带图标+副标题, 激活态 border-blue-500/60 bg-blue-500/10; `data-tour="admin-models-mode-tabs"` 锚点保留。BestAPI 面板从常驻块移入第三 Tab, 但**常挂载仅 hidden** (保留 30s 静默轮询/目录版本变化自动刷新文件列表的原行为)。
- Playwright 打开管理中心: `waitForFunction(typeof window.openAdminOverlay==='function')` 后**再 sleep ~3s** 等 React 完全挂载才 evaluate `openAdminOverlay('models')`; 过早调用会静默无效 (pendingTab 机制), waitForSelector 15s 超时。tab 切换用 `[data-tour="admin-models-mode-tabs"] > button:nth-child(N)`。
- Tailwind 3.4 默认 spacing 无 `h-4.5` (layout-mode-choice-modal.tsx 里的 h-4.5 其实静默失效); 需要非标准尺寸用 `h-[18px]` 任意值语法。

## 原始 JSONL 弹窗恢复显示 jsonl 路径 (2026-09-10, commit 0e72a9fb)

- 根因: `8afb77df` (agent-history-store 迁移, 仅 stream_optimize 分支) 把旧的 `jsonl_meta` SSE 事件整条移除, 连带丢了 `jsonl_path` 状态 → "原始 JSONL 数据" 菜单弹窗标题不再显示文件路径。main 分支仍是旧架构(jsonl_meta), 无此 bug。
- 修法三处: ① 后端 `routes/sessions.ts` `GET /:id/groups` 响应加 `jsonl_path: primaryPath || null` (primaryPath 早已算好); ② 前端 `agent-history-store.ts` 给 `HistorySnapshot`/`SessionHistoryStore`/`CacheRecord` 加 `jsonlPath` 字段, `negotiate()` 采信 `data.jsonl_path`, 缓存读写都带它(304 温缓存 reload 也能显示), 新增 `useSessionJsonlPath(store)` selector; ③ `chat.tsx` 弹窗标题渲染 `{jsonlPath && <span title={jsonlPath}>...}`。
- 验证: `npx tsc --noEmit`(frontend) + `cd mobius && npx tsc --noEmit -p tsconfig.backend.json`(backend) 均 0 报错。

## 巨轮(>256条)开头用户卡片被尾部窗口切掉 (2026-09-16 诊断 + 修复 6184c320)

- 现象: 会话 83832a12(DLC_CREATE/ShanghaiDLC) 第17轮展开后没有"用户问题"卡片, 第一张卡是"智能体 排查清楚…", 却仍带 `u` 标签。
- 根因: `viewer/JsonlView.tsx` `GROUP_ENTRY_WINDOW = 256` + `buildRoundFromEntries` 的 `windowStart = Math.max(0, entries.length - GROUP_ENTRY_WINDOW)` 是**纯尾部窗口**。该轮 284 条 → 前 28 条(含开轮两张 user 卡: 边车原文卡 seq_in_group=0 + 原生卡 =1)整段被 slice 掉; 窗口内首条 assistant 卡得到 `relIdx=0` → 被 `isUserItem` 当成用户条渲染成 `u`。
- 判据: 轮条目数来自 `agent-history-store` 库 `rounds.entry_count`(groups 接口 `entry_count`, `listGroupEntries` 无上限)。同会话仅第17轮 284>256 中招, 12轮215/15轮120 等均正常显示用户卡。搜索跳转会把窗口平移到命中处, 所以只有显式搜索才可能看到被切的开头。
- 次生: 折叠态轮次头 `buildHeaderSummary(round.items[0])` 会把 AI 文本当成用户问题摘要。
- 旧普通视图(2026-09-08 组驱动重构 03d672fc 之前)有"加载全部"入口, 现在只剩简易模式(chat.tsx `加载全部对话`)有, 普通模式无任何途径看到巨轮开头。
- 复现(只读): 用 `.env` 的 JWT_SECRET 本地签 `{id:'fuqingxu',role:'admin',...}` 存 localStorage `cc-token`, 直开 `/u/fuqingxu/p/2a267b17/i/bcbff252?session=83832a12`, Playwright 取 `.round-group-trigger` → 该轮 `.jsonl-thread` 首卡的 `:scope > span` 标签与文本比对即可。
- 修复 (commit 6184c320): `JsonlView.tsx` 窗口改为**分段拼接** = 组头段 `GROUP_ENTRY_HEAD=8` 条 + 主窗口段(尾部 256 / 搜索命中居中), 两段重叠时合并; 行号按条目组内原始序号重编(item 与合并进来的 tool_result 都改), 编号同样留出空档; 跳过的中段插入占位条目 `{type:'system', subtype:'mobius-hidden-gap'}` 穿过流水线, 渲染前回收成 `Round.hiddenGaps=[{at,count}]`(count 只数非噪声条目, 全噪声则不插), 由 `RoundGroups.tsx` 的 `HiddenGapCard/HiddenGapRow` 在 `items[at]` 前渲染金色提示卡("结束"同款 system amber 主题): 「隐藏 / 本轮过长，此处隐藏了一些对话内容 / N 条」, 左侧行号槽用 `⋯`。提示卡游标随 `renderSeq` 顺序推进, 所以 explore 聚合组不会错位; at===items.length 的尾部 gap 兜底渲染在最后。
- 验证: 该会话第17轮(294 条)首卡恢复为「用户 gather all AP api vars…」, 第 6 行位置出现提示卡「23 条」(原始跳过 30 条, 7 条是 last-prompt/快照噪声); 16 轮(<256)行为不变。

## @ 引用抽屉: 去掉「相关智能体」Tab + 加会话搜索 (2026-09-17, commit a73d166b)

- 目标元素 = `mention-drawer.tsx` 智能体 Tab 面板 (`<div className="flex min-h-0 flex-1 flex-col">`), 不是 IssuePage 侧栏的「任务会话/近期会话」切换器 (那个在 `IssuePage.tsx`, 元素长得一样但 `data-testid="issue-session-scope-switcher"`, 勿改错)。
- 删除: 抽屉内 `mention-agent-scope-switcher` 范围切换 (近期会话/相关智能体) 及其整条「相关智能体」链路 (`/api/sessions/mention-targets`、`agentScopeUrl`/`loadAgentSessions`/`agentGroups`/`pickAgent`/`sessionModelLabel`)。
- 新增会话搜索: 复用全站层级搜索 `GET /api/projects/hierarchy-search?q=` (与 EasyModePage 工作导航 / SearchModal 快速搜索同一链路), 300ms 防抖 + AbortController; 只取 `kind=session|research_agent` 命中, 映射成 `RecentSession` 后走**同一套** `buildRecentSessionTreeGroups` + `SessionGroupTree` + `RecentSessionRow(variant=mention)` 渲染, 选中复用 `pickRecentSession` → 连接方式弹窗。
- 判据 `.query === 前端 trim().slice(0,200)`: 后端 `normalizeProjectHierarchyQuery` 同样是 trim+200, 与 EasyModePage 的 `activeHierarchySearch` 写法一致。
- 层级搜索只回会话元数据 (无 agent_status), 运行态圆点用已加载的 `/api/tasks/recent` 按 session_id 合并补充。
- 复现验证(只读): `.env` 的 JWT_SECRET 本地签 `{id:'fuqingxu',role:'admin'}` 存 localStorage `cc-token` + `layout_mode=normal_mode`(否则被首次模式选择弹窗挡住), 开 `/u/fuqingxu/p/b5d4b28d/i/709f063f?session=20ca7d70`, 在输入框打 `@` 开抽屉。

## LIVE 卡乐观响应窗口 (2026-09-18, commit e06051cb)

- 元素 = `viewer/LiveTailCard.tsx` 的 `JsonlLiveTailCard` (绿/琥珀/红三档沉默卡, 可见文字 `LIVE ◦ <agent状态行>`), 不是 `JsonlView.tsx:458` 的琥珀"排队"卡 (两者共用 `card-enter jsonl-live-sweep` 类名, 靠主题色和文字区分)。
- 挂载门槛有两层, 改"卡片不显示"必须两层都看: ① 父级 `session-jsonl-panel.tsx` 的 `liveCardVisible` (原 `variant==='standard' && backendAlive && backendWorking`, 来自 chat.tsx 的 2s `/status` 轮询); ② 组件内部 `silenceSec == null` (无任何带时间戳的 entry) 时静默 `return null`。
- 乐观窗口三态 `liveOverride: 'on'|'off'|null` (chat.tsx): `postSessionMessage` 是**所有**发送路径 (发送/加急/语音/权限按钮/compact/端口提示词) 的唯一漏斗, 起 `on` 5s; `handleStopSession` 起 `off` 10s。经 `liveCardMode` 透传给面板, 面板自己算最终门槛。切会话 (sessionId effect) 清窗。
- `off` 必须比 `stopSuppressedUntilRef` 的 3s 长: 3s 抑制窗只管 `setBackendAlive/Working(false)` 与 agent_status, 软停 (C-c × 3) 耗时更久, 窗口一过轮询仍报 working 卡片就弹回。
- `optimistic` 只影响**显示**: 刚提交时 lastTimestamp 还是上一条历史 entry, 照常渲染会闪一条"⚠ 沉默 20m"红卡, 故乐观窗内固定绿色 + `已提交 · 等待智能体响应…`; realTimeInfo 有值仍优先展示。
- 诊断入口: 会话页 console 里 `window.mobiusLiveDebug()` (chat.tsx 内, 快照含 `liveOverride` 与 parentGate)。
- 验证: react-dom/server 渲染断言 6 例 (auto 三档配色/文案不变、optimistic 不出红卡不出"沉默"、realTimeInfo 优先、无时间戳仍返回 null), 脚本 `/tmp/live-card-verify.mjs` (临时, 未入库)。

## 「对话没满却出现新消息按钮」(2026-09-18, commit 034df497)

- 元素 = `session-jsonl-panel.tsx` 底部居中蓝色圆角 `新消息` 按钮 (`div.mobius-chat-history` 第二个子 div 内的 button), 不是 `assistant-chat.tsx` / `session-jsonl-panel` 搜索命中条。
- 触发链: 新条目抵达 → `EntriesAutoScroll.onBlocked` / `message-effect` 读 `userScrolledUpRef` → true 就 `setHasNewMessages(true)` 亮按钮 (并停止追底)。所以按钮出现 = 接管态被 latch 过。
- 根因: wheel/touchmove/keydown(ArrowUp/PageUp/Home) 三个监听**无条件** latch 接管态; 容器没撑满时 latch 后再无 onScroll `dist<4` 可恢复 → 永久 true。另 `ChatArea` 切会话不重挂, `userScrolledUpRef` + `hasNewMessages` 会带到下一个会话 (切过去瞬间 count-effect/message-effect 就亮一下按钮)。
- 修法: ① 三个监听加 `scrollHeight - clientHeight > 4` 门槛 (没余量不 latch); ② 按钮渲染加 `hasScrollRoom` (ResizeObserver 盯容器 + 首个子元素, 面板内 state); ③ chat.tsx 会话加载 effect 里重置 ref/state。
- 只读复现: `.env` 的 JWT_SECRET 本地签 `{id:'fuqingxu',role:'admin'}` 存 `cc-token`, 开会话页后 `window.debug_scroll = true` 看 `[scroll] flag: false → true`; Playwright viewport 高度开到内容不溢出 (调 H 直到 `scrollHeight-clientHeight == 0`) 再 wheel 上滚即可复现/验证 A-B。

## BestAPI 一键删除全部模型 (2026-09-18, commit 50260691)

- 元素 = `panels.tsx` `BestApiSubscriptionPanel` 已连接视图右侧按钮组, 新 `删除全部模型`(红色边框 + Trash2) 排在 `立即同步全部模型` 之后; 仅 `connectedView` 分支渲染, 无模型时 disabled。
- 后端 `DELETE /api/admin/model-access/bestapi/models` → `bestapi-integration.removeAllBestApiModels()`: 遍历连接里记录的 `models[].backend/key` 调 `modelAccess.deleteCodexModel/deleteClaudeCodeModel/deleteHarnessModel`, 返回 `{...publicConnection(null), removed}`。
- **必须同时删连接文件** (`${MODEL_ACCESS_PATH}.bestapi-connection.json`, 新 `deleteStoredConnection()`): 只删模型的话, 每 60s 的 `runBestApiAutoSyncOnce` 会在下一个周期把全部模型原样写回, 按钮看起来"没生效"。连删后 auto_sync 走 `skipped: 'not_connected'` 分支, 前端 `setConnection({connected:false})` 回到填写 API Key 的视图。
- 只删连接里登记过的 ref, 手动建的模型(含 `mobiusdefault`)不动; 已被手动删过的模型 `delete*` 返回 false, 只少计 `removed` 不算错。
- 与 `connectBestApi`/`syncBestApi` 同样走 `serializeMutation` 串行队列, 避免和自动同步并发写 model-access。
- 验证: 隔离脚本(临时, `/tmp/bestapi-remove-test/run.ts`) —— `MODEL_ACCESS_PATH`/`MOBIUS_DATA_PATH` 指向 tmp, 造 3 个 BestAPI 模型 + 2 个手动模型, 断言 removed=3 / 连接文件消失 / 手动模型保留 / 二次调用报"尚未连接"。**未对线上真实模型做过删除验证**(破坏性), 走查靠该脚本。
- 安全色: 破坏性按钮走 `window.confirm`(Electron 支持 confirm, 不支持 prompt)。

## 简易模式顶栏会话状态 chip 去边框 (2026-09-19, commit f8e8db13)

- 元素 `span[aria-label="会话状态：…"]` = `components/session-status-chip.tsx`，全站唯一实例；简易模式在 `chat.tsx:4190` 以 `alwaysShowLabel` 渲染（普通模式 `chat.tsx:4224` 不传）。边框来自该分支的 `border-[var(--border-color)]`，与 `.easy-session-context` 的 CSS 无关。
- 改动: base 类固定 `border border-transparent`（保留 1px 占位，尺寸/内边距不变），`alwaysShowLabel` 分支不再给边框色也不再带 hover 边框色；普通模式的 hover 边框行为原样保留（`hoverBorder` 移入 else 分支）。

## LIVE 卡片在会话启动/发送阶段常显 (2026-09-20, commit 5d1a8faa)

- 现象: 乐观窗只有 5s (`LIVE_OPTIMISTIC_SHOW_MS`), 唤醒慢的会话里卡片先消失、左下角黄字 (`sendingHint`: 正在发送/正在唤醒中/唤醒时间长于预期) 还在 → 像消息丢了。
- 判据统一: 发送阶段 = `pendingSendAt !== null || messageSubmitting` (与黄字提示同源, 永远同步)。`chat.tsx` 新增 `liveMode` = 终止窗 `'off'` > 提交窗 `'on'` / 发送阶段 `'on'` > `null`(交后端 alive&&working); 渲染、诊断快照、理由文案全部改用 `liveMode`, 诊断新增 `sendingPhase`/`liveMode` 字段。
- 时间戳门槛: 强开窗 (`liveCardMode === 'on'`) 内不再要求已有 jsonl entry — `session-jsonl-panel.tsx` 的 `liveCardMounted` 与 `LiveTailCard` 的 `silenceSec == null` 早返回都开这个口子, 新会话首条 entry 未落盘时按"已提交 · 等待智能体响应…"渲染。
- 只点终止后仍隐藏 (`'off'` 优先级最高), 发送失败仍会 `holdLiveOverride(null)`。
- 验证: `/tmp/live-card-verify.mjs` (临时, 未入库) react-dom/server 7 例全过 — 前三档配色/文案不变, optimistic 无 entry 出新卡, auto 无 entry 仍早返回。
- 纯前端改动部署走 `python3 start.py --only-update-frontend` (编译+替换 public, 不重启后端, 不会打断正在跑的自迭代会话); 全量 `start.py` 会重启 mobius 本体。

## 会话头部 aimux 下拉菜单被左侧栏遮挡 (2026-09-20, commit b8ea52c9)

- 目标元素: `components/aimux-link-indicator.tsx` 顶部会话栏里的两个下拉 —— `RemoteAimuxMcpIndicator` 设备切换菜单 (min-w 288, aria-label「切换 aimux 协作设备」) 与 `AimuxLinkIndicator` 工作模式菜单 (min-w 224); 二者同款 `absolute right-0 top-full`, 固定向左展开。
- 根因: 触发器紧跟会话标题 (标题按自然宽度, 不撑满), 距 `.chat-major-panel` 左缘常常不足一个菜单宽 (1280×900 实测触发器右缘 531 = 面板左缘 + 243 < 288); 菜单左缘越过面板后被 `index.css` `@media(min-width:769px) .chat-major-panel:not(.mobius-chat-area--easy){overflow:hidden}` 裁掉, 看起来就是被左侧栏盖住一截。侧栏越宽 / 会话名越短, 遮挡比例越大 (报障截图里 288px 菜单被吃掉 216px)。
- 修法: 抽出 `useMenuAnchor(open, wrapRef, menuRef)`, useLayoutEffect 在绘制前量 `wrap.closest('.chat-major-panel')` 与触发器矩形: 右对齐放得下 → 保持原样 (老布局零回归); 放不下 → 翻到触发器右侧展开; 两侧都放不下 → 夹回面板内 (8px 留白)。返回内联 `{left}` / 未测量时 `{right:0}`, 类名相应去掉 `right-0`。
- 判据/复现: 登录 `POST /api/auth/login {fuqingxu/fuqingxu}` 取 token 写 localStorage `cc-token`, 并写 `layout_mode=normal_mode` (否则卡在「选择你的使用模式」弹窗); Playwright 开菜单后按 10×20 网格 `elementFromPoint` 统计被遮挡采样点 — 修前 24/24 命中左侧栏元素, 修后 850/901/1280/1600 四个宽度全 0。
- 用户实际拿的是 :45616 的静态产物, 不是本机 45618 的 vite dev; 纯前端改动按既有约定走 `python3 start.py --only-update-frontend`。

## 简易模式: 提交问题后延迟 1s 补拉近期会话 (2026-09-20, commit 3cad6239)

- 需求: 左栏(sidebar)已有 10s 定时拉 `/api/tasks/recent?limit=50`, 但发消息后要等下一轮才看到「执行中」; 改为提交问题后延后 1000ms 立刻补拉一次。
- 落点: `EasyModePage.tsx` 把原轮询里的拉取逻辑提成 `refreshRecentSessions(signal)` (保留「当前会话掉出近50条也留在列表」的合并), 10s 轮询改调它; 新增 `scheduleRefreshAfterSend()` = 单一定时器 ref (连续发送只保留最后一次) + 清理 effect。
- 触发点两个: ① `ChatArea` 新增可选 prop `onMessageSent`, 在 **唯一发送漏斗** `postSessionMessage` 的成功后调用 (发送/加急/语音/权限按钮/快捷指令全覆盖, 失败路径不调); ② 欢迎页 `submitWelcomePrompt` 新建会话后也调 (它在 1s 后正好能拉到 session 已变 running)。
- 验证: Playwright 用 `.env` 的 JWT_SECRET 签 fuqingxu/admin 写 `cc-token` + `layout_mode=easy_mode`, 开 `/u/fuqingxu/easy_mode?session=<id>`; **拦截并伪造** `POST /api/sessions/*/messages` 返回 200 (不触发真实 agent 执行), 断言 POST 后 0.5~2.5s 内出现一次 `/api/tasks/recent` — 实测 +1015ms 命中。脚本 `/tmp/dot-logo-pw/verify-send-refresh.mjs` (临时, 未入库)。
- 注意: 简易模式会话里的主输入框 textarea 无 placeholder (源码 `placeholder={input && inputPlaceholder}`, 输入为空时不渲染该属性), 自动化要按 `textarea:visible` 定位。

## Markdown Mermaid 按需渲染 (2026-09-21)

- 统一入口为 `frontend/src/components/markdown-components.tsx` 的 `MarkdownPre`: 仅识别 fenced code 的 `language-mermaid`, 命中后才 `React.lazy(import('./mermaid-diagram'))`; 普通代码块沿用 `<pre>`。聊天、JSONL、研究正文、小莫、Markdown 文件预览均已接入。
- `mermaid-diagram.tsx` 所在懒加载 chunk 才静态 import `mermaid@11.4.1`; 100ms 防抖流式输出、全局 Promise 队列隔离 Mermaid 全局配置、`securityLevel: strict`、明暗主题切换；语法错误回退显示错误与原始源码。
- Vite 构建产物 `mermaid-diagram-*.js` 与具体图类型均为独立 chunk。临时 Playwright harness 实测: 图表出现前无 Mermaid 请求，点击挂载后才加载且生成含 Start/Done 的 SVG；普通 JS code fence 保持 `<pre><code>`，0 pageerror。

## Issue 侧栏「近期会话」徽标跟随 /status 实时状态 (2026-09-21, commit 34e1fc0e)

- 两个元素定位: 元素1 = `chat.tsx` `.mobius-session-chat-header` 里的 `SessionStatusChip`(label 源 = `backendAlive && backendWorking`, 由 `GET /api/sessions/:id/status` 每 2s 轮询驱动, 同时把 `runtimeStatusForSessionList(r)` 写回 store 的 `currentSession` / `sessionsMap[issue_id]`); 元素2 = `recent-session-row.tsx` 末尾状态徽标, 数据源只有 `/api/tasks/recent?limit=50`。
- 根因: 「任务会话」模式(`SessionRow` + `sessionsMap`)早就拿到了 /status 的实时值, 但「近期会话」模式读的是 IssuePage 自己的 `recentSessions` state —— 该 effect 仅依赖 `[sessionListMode, userParam, recentReloadVersion]`, 没有周期刷新, 所以徽标只能停在拉取那一刻的库值(agent-status-syncer 还有 60s 延迟)。
- 修法: `IssuePage.tsx` 在 `buildRecentSessionTreeGroups` 之前加 `liveRecentSessions` memo, 把 `currentSession.agent_status`(由 ChatArea 2s 轮询维护)覆盖到同 id 的近期会话行(无变化时原样返回同一引用, 不触发重排)。顺带让分组头的「N 活跃」也实时。
- 验证(Playwright, 部署产物 :45616 上跑): 伪造 `/api/tasks/recent` 的 agent_status 与 `/status` 相反, 两个方向都断言 元素1 aria-label == 元素2 徽标文字 —— recent=idle + /status=alive&working → 两处均「执行中」; recent=running + /status 死 → 两处均「空闲」。脚本 `/tmp/verify-live-status-sync.mjs`(临时, 未入库)。
- 未做: `EasyModePage.tsx` 侧栏是同一款徽标 + 10s 轮询, 存在同类滞后, 本次未改(用户只报标准模式侧栏)。
