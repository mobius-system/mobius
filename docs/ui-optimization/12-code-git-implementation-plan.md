# 代码文件与 Git 查看：P0/P1/P2 实施计划

> 用途：直接交给下一轮 `codex exec`。本轮只产出计划，不改 Mobius 前端/后端，不改 `examples/CodexMonitor`，不 commit。源码行号以 2026-08-28 工作区快照为准。

## 0. 实施边界与完成定义

### 不变量

1. **JSONL 执行轨迹保留。** `JsonlView → EntryCard → Edit/Write/Read/Bash` 继续存在；Easy 可以摘要，但标准视图仍能核对工具证据（`mobius/frontend/src/components/viewer/EntryCard.tsx:201-215,257-309,449-475`）。
2. **不改 harness、SSE、消息协议。** 不改 provider CLI、流事件名、流式解析、JSONL 写入/持久化、Stop/Send、session 创建和模型选择。新功能只消费已有消息文本、JSONL、项目文件 API 和 Git 只读数据。
3. **内部查看优先，外部编辑增强。** 没有 VSCode Web 也必须能看项目内文本文件；`buildVscodeUrl` 仅作为显式“在编辑器打开”（现状限制见 `mobius/frontend/src/components/project-files.tsx:101-139,879-928`）。
4. **权限不扩大。** 项目文件预览继续走 `loadReadableProject + resolveProjectPath`（`mobius/backend/routes/projects.ts:3259-3288`）；会话 diff 继续限制在 session 文件特征清单（`mobius/backend/routes/sessions.ts:1183-1217`）。
5. **仓库事实与会话证据分开。** session JSONL 文件、当前 staged/unstaged、commit history 必须标来源，不合成一条伪时间线。
6. **不把 Mobius 做成 Git 客户端或 IDE。** P0–P2 默认只读；不新增 stage/unstage/discard/commit/push/pull/reset/rollback/PR。CodeMirror 和 VSCode 只复用，不重建编辑器。

### 完成定义

```text
模型回复里的 path[:line[-end]]
  → 可发现 file chip
  → 默认在当前会话内预览并定位
  → 若是会话改动，可进入对应单文件 diff
  → 可选引用片段回 Composer / 在编辑器打开
  → 可返回原消息与焦点
  → P2 可从同一 Git 查看面只读浏览 commit / 单文件历史
```

## 1. 建议的最小内部接口

不要让每个 renderer 各写一次 path regex 和 `window.open`。先落一个纯数据契约：

```ts
export type CodeArtifactTarget = {
  rawPath: string
  path: string
  line: number | null
  column: number | null
  endLine: number | null
  intent: 'preview' | 'diff' | 'history'
  source: 'message' | 'code-block' | 'jsonl-tool' | 'diff' | 'git-log'
  commitSha?: string | null
}

export type CodeArtifactOpenRequest = {
  target: CodeArtifactTarget
  trigger?: HTMLElement | null
}
```

纯函数至少包括：

- `parseFileTarget(raw)`：支持 POSIX、`~/`、`./`、`../`、Windows drive、UNC、`file://`、`:line[:column]`、`:start-end`、`#Lstart[-Lend]`、`#LlineCcol`；
- `isUnambiguousFileCandidate(raw, context)`：普通文本要防 `app/daemon` 误判，inline code/明确 href 可更宽容；
- `resolveProjectRelativePath(target, projectMeta)`：工作区内绝对路径、相对路径、`/workspace[/name]/...` 映射为项目相对路径；工作区外目标返回 typed error，不偷偷请求；
- `formatFileTarget(target)`：chip 的 basename、父路径、行标签和 title。

CodexMonitor 的 parser/测试可作为行为样本，但要修复它丢 `endLine` 的限制（`examples/CodexMonitor/src/features/messages/utils/messageFileLinks.ts:31-43,197-232,294-369`；`examples/CodexMonitor/src/utils/fileLinks.ts:118-163`）。

## 2. P0：先把回复与已有查看能力接通

P0 不做完美 Git 工作台；它必须让“回复路径 → 内部文件/行 → 现有 Diff → 返回回复”闭环。

| ID / 可直接执行的任务 | 改哪些文件 | 用户可感知结果 | 明确不改 | 验收方式 |
| --- | --- | --- | --- | --- |
| **P0-1 建立结构化文件目标 parser**：新增纯函数和 remark plugin；普通 text 自动 linkify，inline code 单独解析，fence/code 节点跳过。范围必须保留 endLine，明确排除 HTTP、站内 route 和自然语言 slash phrase。 | **新增** `mobius/frontend/src/components/code-artifacts/file-target.ts`、`remark-file-targets.ts`；修改 `mobius/frontend/src/services/markdown.ts` 注册 plugin；**新增** `mobius/frontend/tests/code-file-target.test.ts` | `src/a.ts:42`、`/workspace/repo/a.ts#L12-L30`、Windows/UNC/file URL 能成为同一 target；`app/daemon behavior` 不误链 | 不改 harness/SSE/JSONL；不请求文件；不改 VSCode URL；不 linkify fence 内容 | 单测命名至少覆盖 `parses colon line and column`、`preserves hash line range`、`does not resolve workspace paths before metadata`（解析阶段不做 IO）、`rejects natural-language slash phrases`、`rejects app routes`、`supports Windows and file URLs`。运行 `cd mobius && node --require tsx/cjs frontend/tests/code-file-target.test.ts` |
| **P0-2 在主要回复表面渲染 file chip**：共享 `FileReferenceLink`，接入 Easy/standard JSONL 的 `JsonlCompactMarkdown`；AssistantMarkdown 和 legacy ChatMessage 至少使用同一 anchor/code renderer。chip 显示 basename、`Lx`/`Lx–Ly`、可选父路径，完整 raw/normalized path 放 title。 | **新增** `mobius/frontend/src/components/code-artifacts/FileReferenceLink.tsx`、`CodeMarkdownComponents.tsx`；修改 `mobius/frontend/src/components/jsonl-compact-markdown.tsx`、`assistant-chat.tsx`、`chat.tsx`、`index.css` | 裸路径和 inline code 路径默认就像“可打开对象”，不同会话表面样式/行为一致；普通外链仍按外链处理 | 不改 harness/SSE/消息内容；不删除 hljs；不改 Easy round 聚合；不把普通单词或 fence 内路径变链接 | 静态/组件契约测试验证 `message-file-link`、行标签与外链保留；手测 Easy、标准 JSONL、assistant 浮层、legacy message 各一条。`npm --prefix mobius/frontend run build` 通过 |
| **P0-3 增加会话内只读预览层并定位行**：在 Chat 宿主持有 open target；JSONL provider 只分发 callback。预览调用现有 `GET /api/projects/:id/file?path=`，显示 loading/error/binary/truncated、行号、目标行/范围高亮和滚动。P0 可用 modal/sheet，组件必须不改 URL且不重挂消息列表。 | **新增** `mobius/frontend/src/components/code-artifacts/CodeArtifactOpenContext.tsx`、`FilePreviewLayer.tsx`；修改 `mobius/frontend/src/components/session-jsonl-panel.tsx`（当前 provider 在 `:71-129`）、`chat.tsx`（宿主状态/挂载）、必要时 `assistant-chat.tsx`；复用 `viewer/text-preview.tsx` 或抽只读 line rows；样式进 `index.css` | 点路径后在当前会话内看到文件；`:42` 滚到并高亮 42，范围高亮整段；关闭后草稿、消息滚动和 session 不丢 | 不改 harness/SSE；不调用 POST file；不进入 CodeConversation 编辑模式；不要求 VSCode；不放宽后端 readable-project/路径穿越校验 | 手测文本/二进制/不存在/1.5MB 截断/越界行/工作区外路径。开关 10 次，Chat DOM 不重挂，composer 值和 scrollTop 不变。错误层有 Retry/Copy path，Esc 关闭并恢复 trigger |
| **P0-4 从回复进入现有 Session Diff Modal**：把 `SessionFileChangesModal` props 扩为 `initialPath`、可选 `initialLine/endLine`；把 `fileChangesOpen:boolean` 升为 target。预览层提供“查看本会话修改”；JSONL Edit 文件头也可直接传 `intent=diff`。加载文件清单后精确选择 path/display/original path；不存在时原位说明并提供返回文件预览。 | 修改 `mobius/frontend/src/components/chat.tsx:190-220,699-898,5034-5039`；`mobius/frontend/src/components/viewer/CodeDiff.tsx:112-140`；必要时给 `EntryCard.tsx:449-475` 透传 `onOpenArtifact` | 模型说“见 chat.tsx”时，一次点击预览、一次显式动作到该文件 diff；Edit 卡文件名也能直达，不必再开工具后手找 | 不改 harness/SSE；不改 `/features/files` 和 `/features/git-diff` 语义；不自动执行 Git；P0 不重写 Diff renderer | 用 session 清单内/外各一条路径验收；内路径选中正确文件，外路径显示“不是本会话修改”并能回预览。关闭回原消息/卡片；重复快速切文件不会显示旧请求结果 |
| **P0-5 修正 P0 的焦点、失败和回归保护**：记录 trigger；overlay 标 `role=dialog`/`aria-modal`，打开聚焦标题或目标行，Esc 关闭，关闭恢复 trigger；trigger 被虚拟列表卸载则聚焦消息容器。避免 meta 未加载时执行默认 anchor。 | 修改 `CodeArtifactOpenContext.tsx`、`FileReferenceLink.tsx`、`FilePreviewLayer.tsx`、`jsonl-compact-markdown.tsx`、`session-jsonl-panel.tsx`；补 `mobius/frontend/tests/code-artifact-contract.test.js` 或项目可运行的等价测试 | 第一次点击也不会开浏览器 404；键盘完成打开/关闭；失败不丢目标 | 不改 harness/SSE；不改现有外链、图片代理、附件；不引入全局 toast 代替局部错误 | 键盘只用 Tab/Enter/Esc 走完整链；模拟 meta/file API 慢与失败；断言默认 navigation 被阻止、Retry 可用、关闭焦点恢复。跑现有 `easy-jsonl-model.test.ts` 确认摘要未丢 |

### P0 实现顺序

```text
P0-1 parser
  → P0-2 chip
  → P0-3 preview context/layer
  → P0-4 existing diff bridge
  → P0-5 focus/error/tests
```

不要先改 `jsonl-vscode-link.tsx` 让它识别更多路径，再继续把 VSCode 当默认目标；那会扩大错误路径而不解决“内部可看”。P0 后它只服务预览层里的“在编辑器打开”。

## 3. P1：统一预览、代码头和当前变更查看

P1 把 P0 的闭环做成一致组件，并修复 Diff 行号/来源语义。仍不做 commit 历史。

| ID / 可直接执行的任务 | 改哪些文件 | 用户可感知结果 | 明确不改 | 验收方式 |
| --- | --- | --- | --- | --- |
| **P1-1 把 P0 预览稳定为统一 responsive layer**：宽屏为右侧 drawer 或锚定 popover，窄屏为 sheet；统一 header（path、language、line range、truncated）、toolbar（引用、查看修改、编辑器打开、关闭）、滚动区。支持选择行并引用 Composer。 | 修改/拆分 `mobius/frontend/src/components/code-artifacts/FilePreviewLayer.tsx`、`CodeArtifactOpenContext.tsx`、`index.css`；复用 `mobius/frontend/src/components/viewer/text-preview.tsx`；必要时抽 `CodeLineRows.tsx` | 从消息、Read/Write、项目文件和 Diff 返回的预览长相/按键一致；可 Shift+click/拖选并插入 `path#Lx-Ly` + snippet | 不改 harness/SSE；不把编辑器常驻；不写文件；不删除 JSONL Read/Write 原卡 | 1024/1280/1440 与窄屏验收；长文件双向滚动、目标行不被 sticky header 遮挡；插入后 composer 聚焦且可撤销；`Esc` 层级正确 |
| **P1-2 统一代码块头部**：抽共享 `CodeBlockHeader`，展示语言、复制；仅当 renderer 拿到可信 target 时显示 file chip。Easy Markdown 补复制；Assistant/legacy 不再各维护一套。Write/Read/Edit header 复用 file chip，但保留各自 JSONL 状态。 | **新增** `mobius/frontend/src/components/code-artifacts/CodeBlock.tsx`；修改 `jsonl-compact-markdown.tsx`、`assistant-chat.tsx`、`chat.tsx`、`viewer/WritePreview.tsx`、`viewer/ReadCards.tsx`、`viewer/CodeDiff.tsx`、`index.css` | 所有 fence 都能复制、显示语言；已知文件的代码块头可预览；不再有“这个回复能复制、另一个不能”的差异 | 不改 harness/SSE；不猜文件名；不移除 `rehype-highlight`；不把每个 snippet 加行号 | 测试无 target 只出现语言/复制，有 target 出现 file chip；clipboard 失败有 fallback/提示；Easy/Assistant/JSONL 样式一致但执行状态仍保留 |
| **P1-3 抽出只读 Git Changes 查看组件**：把 `SessionFileChangesModal` 从 5k 行 `chat.tsx` 移到独立组件；左侧至少分“本会话文件 / 当前 diff source”，右侧单文件 diff。解析 unified hunk，显示真实 old/new line；文件头、hunk、行都使用 artifact target。 | **新增** `mobius/frontend/src/components/code-git/GitChangesViewer.tsx`、`DiffRows.tsx`、`types.ts`；修改 `chat.tsx`；重用/抽取 `viewer/CodeDiff.tsx:13-110` 的纯 parser；样式进 `index.css` | 文件列表 + 单文件 diff 成为稳定查看面；行号可定位/引用，raw diff index 不再冒充源码行 | 不改 harness/SSE；不新增 Git 写操作；不删除现有 Modal 入口，只替换内部实现；不引入 PR UI | 同一 patch 在 JSONL CodeDiff 与 GitChangesViewer 产生相同 old/new 行号；rename/new/delete/binary/无 hunk 有明确态；点文件只更新 viewer 不重挂 Chat |
| **P1-4 让 staged/unstaged 来源可选择，而非 fallback 黑盒**：给只读 diff service 接收受限 `mode=unstaged|staged`；保留 session 文件 allowlist。UI 显示来源 tab/badge，默认先工作树未暂存，再已暂存；历史模式留 P2。 | 修改 `mobius/backend/services/session-features.ts:409-423,448-510`（当前 `_mode` 未使用且按 AUTO 顺序首个返回）、`mobius/backend/routes/sessions.ts:1170-1224`；修改 `code-git/GitChangesViewer.tsx`；补 `mobius/tests/session-features*.js` 或现有相邻测试 | 用户知道看到的是未暂存还是已暂存，可主动切换；同一文件两处都有变更时不再只见第一处 | 不改 harness/SSE；不 stage/unstage；不允许请求 session 清单外路径；不把 last_commit 当工作树 fallback | 后端测试 mode allowlist、非法 mode 400、path allowlist；构造同文件 staged+unstaged，两个 tab 各显示正确 diff；`npm --prefix mobius run typecheck` 与前端 build 通过 |
| **P1-5 完成列表键盘模型和来源返回**：文件列表 roving tabindex，↑/↓/Home/End、Enter；Diff 行选区 Esc 优先清除；viewer 返回 Preview/Chat 时恢复来源。 | 修改 `code-git/GitChangesViewer.tsx`、`FilePreviewLayer.tsx`、`CodeArtifactOpenContext.tsx`；补可运行 DOM/contract 测试 | 键盘不需遍历几十个文件按钮；从预览进 Diff 再返回仍在同一文件/行 | 不改 harness/SSE；不劫持代码正文方向键；不依赖浏览器 Back 关闭 overlay | 键盘路径测试；选中项有 `aria-selected`/可见焦点；关闭后 trigger 恢复；虚拟化卸载有 fallback focus 和 live announcement |

### P1 数据边界

`/features/files` 是“本会话出现过的修改”；`mode=unstaged|staged` 是“当前仓库现在的状态”。UI 必须同时显示这两个标签。较早 session 的某文件当前无 diff 时，显示“本会话改过，但当前工作树无该 diff”，并允许看当前文件；不能自动退到最近两个 commit 冒充本次会话结果。

## 4. P2：只读 commit 历史、单文件历史与会话工具合流

P2 才增加历史 API。优先复用项目设置已有 commit 字段，不复制其 rollback/push/stage 操作。

| ID / 可直接执行的任务 | 改哪些文件 | 用户可感知结果 | 明确不改 | 验收方式 |
| --- | --- | --- | --- | --- |
| **P2-1 新增受限的只读 Git history API**：项目级 list 支持 limit/cursor 和可选 file；commit diff 支持 SHA + 可选 file。命令使用参数数组；SHA 校验 7–40 hex；file 必须经 `resolveProjectPath` 且落在 repo；单文件历史用 `git log --follow -- <path>`，diff 用 `git show --format= --find-renames <sha> -- <path?>`。 | 修改 `mobius/backend/routes/projects.ts`，复用 `readProjectGitTracking` 附近的 commit parser（`:1530-1619`）和 readable-project guard；可抽 **新增** `mobius/backend/services/git-readonly.ts`；补 `mobius/tests/project-git-history.js` | 能读取近期 commit、某文件 commit 历史、某 commit 全部/单文件 diff；字段结构稳定 | 不改 harness/SSE；不接受任意 git args；不执行 checkout/reset/stage/commit/push/pull；不暴露无权限 repo | 临时 repo 测试普通 commit、rename `--follow`、空 repo、bad SHA、路径穿越、仓库外文件、limit 上限；所有 API 只读后工作树保持 clean |
| **P2-2 在 GitChangesViewer 增加 commit log 与 commit diff**：左侧 tab `变更 / 历史`；commit 行显示 subject、short SHA、author、时间、refs。点 commit 后右侧显示该 commit 文件列表 + 单文件 diff；选中文件时可切“该文件历史”。请求要有 abort/request token，防快速切 commit 串数据。 | **新增** `mobius/frontend/src/components/code-git/GitHistoryList.tsx`、`useGitHistory.ts`；修改 `GitChangesViewer.tsx`、`types.ts`、`index.css` | 不离开会话即可回答“这个 commit 改了什么”“这个文件何时改过”；工作树与历史可切回 | 不改 harness/SSE；不加入 commit/rollback 按钮；不搬 CodexMonitor Issues/PRs；不把 Agent edits 命名为文件历史 | 点 10 个 commit 快速切换只显示最后选择；空历史/加载/错误/无该文件 diff 有原位态；Enter/↑/↓可浏览；返回工作树保留先前文件选择 |
| **P2-3 与会话 Git 工具合流，但保留多来源限制**：会话 Git tab 先显示 source selector；中枢 source 可进入完整 changes/history；Electron/远端若只具 status 就明确标“仅状态”。项目设置“版本追踪”可增加“只读查看”深链到同一组件，但现有高风险管理动作仍留项目管理上下文。 | 修改 `mobius/frontend/src/components/session-welcome.tsx:725-784,1042-1095,1169-1215`、`advanced-session-actions.tsx:198-249`、`chat.tsx:4229-4235`、`project-page/ProjectSettingsPanel.tsx:360-430`；复用 `code-git/GitChangesViewer.tsx` | “Git”不再只是仓库扫描；同一会话工具中能选仓库、看变更和中枢历史；不支持的来源不会显示空 viewer | 不改 harness/SSE；不删除 AIMUX/Electron source；不假装远端已有 commit API；不迁移/触发 rollback、stage、push | 中枢/本地/远端三类 source fixture；只有能力可用时显示 history；从项目设置与会话进入相同 commit 后内容一致，关闭各回自己的来源 |
| **P2-4 编辑器打开携带 line/range，仍为增强**：内部 CodeConversation 支持 initial file/line/range；CodeMirror 获得 view ref 后 dispatch selection/scrollIntoView。VSCode Web 若 payload 无可靠行定位，文案只承诺“打开文件”，不能假称跳行。 | 修改 `mobius/frontend/src/components/workspace/code-conversation-pane.tsx:372-403,1149-1156`、`workspace/code-mirror-editor.tsx:11-20,78-119`、`jsonl-vscode-link.tsx`、`project-files.tsx:101-139`；artifact open context 传 target | 已启用内部编辑器时可从预览显式打开到行；没有编辑器仍可在只读预览完成任务 | 不改 harness/SSE；不让编辑器成为默认路径；不自动保存/写文件；不声称 code-server 不支持的行跳转 | 打开 `path:42` 后 CodeMirror selection/viewport 正确；range 选区正确；关闭 editor 回同一会话/预览；VSCode 未配置时按钮 disabled 且内部预览可用 |
| **P2-5 清理重复 renderer 与补全回归矩阵**：删除已被共享组件替代的局部 MarkdownAnchor/CodePre/Diff row 实现，但不删功能。把 10/11 文档的点击表转为测试清单。 | 修改 `jsonl-compact-markdown.tsx`、`assistant-chat.tsx`、`chat.tsx`、`viewer/*`、`index.css`；扩展 `frontend/tests/code-file-target.test.ts`、`code-artifact-contract.test.js`、Git API 测试 | 所有入口遵循同一 chip/preview/diff/history 语法；维护时不再修四份代码 | 不改 harness/SSE；不删除 JSONL 详细视图；不做无关 chat.tsx 重构；不改 Home/Rail/Settings | 全量前端 build、后端 typecheck、相关 Node tests；按“回复/工具卡/Diff/commit × mouse/keyboard × success/error × desktop/narrow”回归 |

## 5. 文件级改动地图

### 5.1 新增文件建议

```text
mobius/frontend/src/components/code-artifacts/
├── file-target.ts                 # 纯 parser / formatter / workspace resolver
├── remark-file-targets.ts         # 只改 Markdown AST text node
├── CodeArtifactOpenContext.tsx    # 打开请求与来源/焦点栈
├── FileReferenceLink.tsx          # message-file-link chip
├── CodeMarkdownComponents.tsx     # shared a/code/pre renderers
├── CodeBlock.tsx                  # language/copy/optional file target
└── FilePreviewLayer.tsx           # read-only preview + line selection

mobius/frontend/src/components/code-git/
├── types.ts
├── DiffRows.tsx                   # true old/new lines
├── GitChangesViewer.tsx           # session files + working tree diff
├── GitHistoryList.tsx             # P2
└── useGitHistory.ts               # P2 request cancellation/cache
```

目录名可以调整，但 parser、open context、preview、Git viewer 不应继续塞回 `chat.tsx`。当前 `SessionFileChangesModal` 与 Bash/其他控制逻辑已经证明单文件耦合太高（`mobius/frontend/src/components/chat.tsx:699-1045`）。

### 5.2 现有文件职责变化

| 文件 | 后续职责 |
| --- | --- |
| `services/markdown.ts` | 注册共享 remark/rehype，不承载 UI 状态 |
| `jsonl-compact-markdown.tsx` | 使用共享 Markdown components；保留 table/image 特例 |
| `jsonl-vscode-link.tsx` | 退回“显式外部编辑器 URL”职责，不再决定默认点击 |
| `session-jsonl-panel.tsx` | 提供 artifact open context，不持有预览业务状态 |
| `chat.tsx` | 持有当前 session 的 layer target/开关；Modal 业务移出 |
| `viewer/CodeDiff.tsx` | JSONL 卡片展示；复用纯 Diff model 与 file chip |
| `workspace/code-conversation-pane.tsx` | P2 接收显式 file/line，仍是按需编辑器 |
| `backend/routes/sessions.ts` | session 文件 allowlist 下的只读 working-tree diff |
| `backend/routes/projects.ts` | P2 项目级只读 commit/file history；权限与参数校验 |

## 6. 验收矩阵

### 6.1 路径 parser

| 样本 | 期望 |
| --- | --- |
| `src/a.ts` | 相对路径 chip |
| `src/a.ts:42:7` | line 42, column 7 |
| `src/a.ts:12-30` | line 12, endLine 30 |
| `src/a.ts#L12-L30` | line 12, endLine 30 |
| `/workspace/repo/src/a.ts#L9` | 映射到当前 project `src/a.ts` |
| `/Users/u/repo/src/a.ts`（bind path 内） | 映射到相对路径 |
| `C:\repo\src\a.ts:42`、UNC | parser 保留；当前 Web workspace 无法解析时 typed failure，不生成浏览器链接 |
| `file:///repo/a%20b.ts#L3` | 解码路径，line 3 |
| `app/daemon behavior`、`https://x/a.ts`、`/api/issues` | 不误链 |

### 6.2 查看与返回

- 成功：路径 chip → 文件预览 → 目标行 → 查看修改 → 单文件 diff → 返回预览 → 关闭回 chip。
- 失败：文件不存在、项目无 bind path、工作区外、binary、truncated、Git 仓库不存在、diff 为空、commit 不存在。
- 状态保留：composer 草稿、附件、消息滚动、Easy/standard 选择、JSONL 展开状态不丢。
- 并发：快速点不同路径/commit，旧请求不能覆盖新 target。
- 键盘：Tab、Enter/Space、Esc、↑/↓、Home/End；focus ring 和 live error 可见。

### 6.3 Git 只读性

验收前后运行 `git status --porcelain`；使用查看面不应造成任何工作树/index/HEAD 变化。后端只允许 read-only 子命令与固定参数，不接受前端传入任意 args。

## 7. 下一轮 `codex exec` 建议拆单

不要一次把 P0–P2 全交给一个执行回合。建议按以下独立完成条件拆：

1. **执行 P0-1 + P0-2**：只交付 parser、chip、测试；没有预览也不改默认 browser navigation，chip click 可先触发明确的“预览即将支持”受控 callback，但不能落回 404。
2. **执行 P0-3 + P0-5**：只读预览、line/range、焦点/失败；复用现有 API。
3. **执行 P0-4**：现有 Diff Modal 接收 target，并让 JSONL Edit/回复预览进入。
4. **执行 P1-1 + P1-2**：统一预览与代码头，不碰 Git backend。
5. **执行 P1-3 + P1-4 + P1-5**：当前变更 viewer、真实行号、受限 staged/unstaged mode。
6. **执行 P2-1**：只读 Git API 与后端测试单独评审。
7. **执行 P2-2 + P2-3**：commit UI/工具合流；不夹带写操作。
8. **执行 P2-4 + P2-5**：编辑器增强与重复实现清理。

每个 `codex exec` 提示都应重复三条硬约束：**不改 harness/SSE；不删除 JSONL 轨迹；不新增 Git 写操作**。完成某一档后再进入下一档，避免在 `chat.tsx`、Markdown 和 Git 后端三处同时扩大故障面。
