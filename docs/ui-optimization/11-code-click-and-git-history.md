# 代码文件点击契约与 Git 历史查看面

> 范围：定义“点了以后发生什么”，并审计 Git 查看链路。只读查看是目标；不把 stage、commit、push、rollback、PR 工作流列为 Mobius 默认实现要求。源码行号以 2026-08-28 工作区快照为准。

## 0. 先纠正两个容易误判的事实

1. **CodexMonitor 的消息文件 chip 不是内部预览入口。** 点击后由 `useFileLinkOpener` 默认用 VS Code 打开；Files panel 的 `FilePreviewPopover` 是另一条链（`examples/CodexMonitor/src/features/messages/hooks/useFileLinkOpener.ts:32-39,121-175`；`examples/CodexMonitor/src/features/files/components/FileTreePanel.tsx:351-415`）。Mobius 应学结构化 target 和可返回层，不应复制“外部编辑器优先”。
2. **CodexMonitor 的 `Agent edits` 不是 Git 单文件历史。** 数据从当前 thread 的 `activeItems` 构造；空态直接写 `No agent edits in this thread yet`（`examples/CodexMonitor/src/features/app/hooks/useGitPanelController.ts:62-65`；`features/git/components/GitDiffPanelListModes.tsx:63-129`；测试 `useGitPanelController preload behavior > derives per-file diffs from active thread fileChange items`）。真正的 `git log --follow -- file` 在两个产品里都没有现成 UI。

## 1. 统一目标模型

所有入口先解析为同一种只读目标，再决定打开哪一层。后续实现至少需要：

```ts
type CodeArtifactTarget = {
  projectId: string
  sessionId?: string
  path: string                  // 规范化后的 workspace-relative path
  rawPath: string               // 回复里的原值，供失败态与复制
  line?: number
  column?: number
  endLine?: number
  intent: 'preview' | 'diff' | 'history'
  source: 'message' | 'code-block' | 'jsonl-tool' | 'diff' | 'git-log'
  commitSha?: string
}
```

CodexMonitor 已证明 `{path,line,column}` 能把 parser 与 opener 解耦（`examples/CodexMonitor/src/utils/fileLinks.ts:1-5,118-175`），但只把 `:12-30` 降级为起点，`#L12-L30` 根本不在 suffix 规则中（`utils/fileLinks.ts:7-13,146-157`）。Mobius 应从第一版就保留 `endLine`，避免范围在解析阶段不可逆丢失。

## 2. 点击契约总表

表中“建议”是 Mobius 目标契约。默认层级原则：

```text
轻量查看：消息 → popover / 右侧预览
变更查看：消息或工具卡 → 现有 Diff Modal，P1 后为同一查看面
历史查看：工具 → Git 查看面；选 commit 后仍留在会话壳内
外部编辑：预览层显式二级动作，不是默认落点
```

| 用户动作 | CodexMonitor 现在 | Mobius 现在 | Mobius 建议：入口、层、焦点、返回、失败 |
| --- | --- | --- | --- |
| **点击回复中的文件路径** | 裸文本/inline code/`codex-file:` 可变 `message-file-link` chip，文件名、行 pill、可选父路径都可见；显式文件 href 保留普通 anchor 外观但走同一 opener（`Markdown.tsx:319-349,506-549,580-600`；`messages.css:1146-1195`）。点击默认外部编辑器（`useFileLinkOpener.ts:121-175`） | 裸路径是纯文本；只有显式绝对 href 才由 Easy JSONL 尝试 VSCode，新窗口打开（`jsonl-compact-markdown.tsx:6-16`）；AssistantMarkdown href 只是浏览器新窗口（`assistant-chat.tsx:257-267`） | **入口**统一为 inline file chip，hover/title 显示规范路径；**默认层**在宽屏开右侧预览、窄屏开不换路由的全高 sheet。焦点移到预览标题或目标行，Chat DOM、滚动与草稿不重挂。关闭恢复触发 chip；读取失败在预览内显示 raw path、原因、重试、复制路径，不跳浏览器 404 |
| **点击 `file.ts:42` / `#L12-L30`** | `:line[:column]`、`#LlineCcolumn` 可保留行列并传外部 opener；只有冒号范围 `:12-30` 被识别且只取起点，`#L12-L30` 不识别（`utils/fileLinks.ts:7-13,118-163`；测试 `preserves file link line and column metadata...`、`normalizes line ranges to the starting line...`） | `isLikelyFilesystemPath` 无结构化解析；`buildVscodeUrl` 主动剥掉 `:line[:col]`，不传定位（`jsonl-vscode-link.tsx:110-120`；`project-files.tsx:101-130`） | chip 额外显示 `L42` 或 `L12–L30`。预览加载后滚到该行；单行高亮一行，范围高亮整段，`aria-current="location"` 放起始行。焦点落起始行。关闭回原 chip；越界则 clamp 到最后一行并原位提示“请求 L120，文件仅 80 行”，不能静默跳到首行 |
| **点击代码块头部文件名** | 头部只有 language/Code 和 Copy，没有文件名（`Markdown.tsx:352-403`） | AssistantMarkdown 只有悬浮复制；Easy fence 连头部都没有（`assistant-chat.tsx:270-307`；`jsonl-compact-markdown.tsx:58-73`） | 只有获得**可信文件元数据**时才显示 file chip：结构化 tool output、明确 fence info `file=...`，或 renderer 已知的 Write/Read path。不能从 `typescript` 猜文件。点击走同一 preview target；复制仍独立按钮。缺元数据时只显示语言，不制造假路径 |
| **点击 JSONL Edit/Write/Read 的文件头** | 不属于消息 markdown；参考价值在 Files/Git 的统一 selection | Edit/Write/Read 已显示路径，但 header 是 span；Read 只提供复制（`viewer/CodeDiff.tsx:121-140`；`WritePreview.tsx:16-44`；`ReadCards.tsx:42-73`） | 文件名变同款 chip。Edit 默认 `intent=diff` 打开该工具对应的差异或会话 Diff；Write/Read 默认 `intent=preview`，Read 带 offset 作为 line。焦点和返回均按触发卡片保存；失败不得折叠/丢失原 JSONL 卡片 |
| **点击 Diff 文件名** | 右栏 staged/unstaged 文件行是 `role=button`，Enter/Space 可选，选择后中心切 diff 并滚到文件（`GitDiffPanelShared.tsx:141-205,420-438`；`useGitPanelController.ts:209-223,291-312`）；中心 viewer 的文件头本身是 span（`GitDiffViewerDiffCard.tsx:197-225`） | 会话 Modal 左侧文件按钮可选并拉单文件 diff（`chat.tsx:742-769,819-845`）；JSONL `CodeDiff` 文件头不可点（`viewer/CodeDiff.tsx:121-140`） | 所有 Diff 文件头和列表行共用 `intent=diff`。若当前已在 Diff 面，只选择/滚动，不叠第二个 Modal；从回复/工具卡进入 P0 先打开现有 Modal 并传 `initialPath`。焦点落选中文件行，随后可 Tab 到 diff；关闭回来源 chip/card |
| **点击 Diff hunk / 行** | hunk separator 仅是 diff 渲染信息；统一模式下 hover `+` 可把一行引用插入 composer，viewer 文件头不导航（`GitDiffViewerDiffCard.tsx:162-188,258-295`；`GitDiffViewer.tsx:274-287`） | JSONL `CodeDiff` 有真实 old/new 行但无事件；Modal 的“行号”只是 raw diff 行下标（`viewer/CodeDiff.tsx:32-105`；`chat.tsx:683-695`） | hunk header 可聚焦，Enter 展开/收起上下文；行号点击选定真实 old/new line，不能用 raw diff index。默认只定位，不自动改 composer；选择后出现“引用到对话”。`Esc` 清选区，第二次 `Esc` 关闭查看层。解析失败显示 raw diff 但禁用行引用，并说明“无法解析源码行号” |
| **预览后点“引用回对话”** | 选行后生成 `path:Lstart-Lend` + fenced snippet，插入 chat 并关闭预览（`FileTreePanel.tsx:522-541`）；测试 `FilePreviewPopover > disables add-to-chat when insertion is not allowed` | `@` Drawer 能插路径，Read 卡能复制；没有从回复预览选择片段回 composer 的公共动作 | 仅在有 session/composer 且可发送时可用。插入 `path#Lstart-Lend` 与 fenced snippet；**保留当前回复、JSONL 和预览来源**。P0 插入后关闭预览并聚焦 composer；P1 可让用户设置“插入后保持打开”。失败保留选区并在按钮旁报错 |
| **预览后点“在编辑器打开”** | `OpenAppMenu` 提供所选 app；消息 chip 自身也默认外部打开（`FilePreviewPopover.tsx:130-169`；`useFileLinkOpener.ts:121-175`） | 依赖 bind path + `vscode_web_url`；ProjectFilesCard 没配置时禁用并警告（`project-files.tsx:879-928`） | 这是预览层的二级动作。可用时带 path/line；不可用时按钮保持可发现但 disabled，并说明“未配置 VSCode Web”，不关闭内部预览。新窗口被拦截或 URL 构造失败，错误留在按钮旁；内部内容仍可看 |
| **预览后点“关闭”或返回 Chat** | Files preview 有 X/Esc；Add to chat 关闭；中心 Diff 顶栏有 Back to chat（`FileTreePanel.tsx:278-303,522-541`；`useMainAppLayoutSurfaces.ts:647-653`） | Modal 有 overlay/关闭按钮，但 `SessionFileChangesModal` 没有 Esc listener 或焦点恢复（`chat.tsx:771-796`）；CodeConversation 是另一布局 | popover/sheet：X、Esc、再次点当前 chip 均关闭；Diff 查看面：固定“返回对话”。恢复原 trigger；若 trigger 因虚拟列表卸载，则聚焦消息容器并播报“已关闭预览”。不得靠浏览器 Back 关闭无 URL 的 overlay |
| **键盘 Enter / Space** | Git file/log row支持 Enter/Space；file preview 每行是 button（`GitDiffPanelShared.tsx:175-185,461-472`；`FilePreviewPopover.tsx:170-199`） | 文件列表多为原生 button，Enter 可触发；消息路径不是 button，Git commit 卡片只是 div/code（`ProjectSettingsPanel.tsx:375-430`） | chip、文件行、commit 行均 Enter 打开，Space 只在 `role=button` 时等价。按钮必须有可见 focus ring。打开后焦点按层级规则移动，不能留在 `inert`/隐藏 Chat 层 |
| **键盘 Esc** | Files preview 全局监听 Esc 关闭；中心层切换会 blur 隐藏层内焦点，但未显式恢复（`FileTreePanel.tsx:291-303`；`DesktopLayout.tsx:121-140`） | 文件修改、Bash、Git modal 主要靠 overlay/关闭按钮，没有统一 Esc（`chat.tsx:771-796,953-977`；`session-welcome.tsx:1182-1213`） | Esc 优先级：清 Diff 行选区 → 关闭内层菜单 → 关闭 preview → 关闭 Git 查看面。每层只消费一次，恢复打开它的元素。外部编辑器窗口不拦截 Esc |
| **方向键** | Git 列表没有 roving tabindex；靠 Tab，preview 行也是每行 button | 当前列表同样没有统一方向键 | 文件列表/commit list 采用 roving tabindex：↑/↓移动，Home/End首尾，Enter打开；代码正文保留浏览器/CodeMirror方向键，不劫持；左右键只用于树目录或收起/展开 hunk |

## 3. 焦点与返回状态机

实现时不要把“打开组件”当作完整契约。建议状态机：

```text
[Chat: trigger focused]
       │ Enter/click
       ▼
[Preview loading: heading focused]
       ├─ success + line → scroll/highlight/focus target line
       ├─ success no line → focus first toolbar action, content可继续Tab
       └─ error → focus inline error; Retry/Copy path 可操作
       │
       ├─ 查看修改 → [Diff layer: matching file selected]
       │                 └─ 返回 → Preview（仍保留 path/line）
       ├─ 引用 → Composer focused（插入内容可撤销）
       ├─ 编辑器打开 → Preview 保持；当前窗口焦点不强制改变
       └─ Esc/Close → trigger；trigger不存在则 message container
```

必须保存 `{target, triggerRef/fallbackMessageId, scrollTop, selection}`。CodexMonitor 切 Chat/Diff 时隐藏层设为 inert 并 blur 隐藏焦点（`examples/CodexMonitor/src/features/layout/components/DesktopLayout.tsx:121-140,162-218`），这比 Mobius 当前 Modal 更安全；Mobius 还需要补“恢复到哪里”。

## 4. CodexMonitor 的 Git 查看链

### 4.1 右栏信息结构

Git panel 有 `Diff / Agent edits / Log / Issues / PRs` 模式（`examples/CodexMonitor/src/features/git/components/GitDiffPanel.tsx:640-665`）。本任务只取前三者的只读查看逻辑：

- `Diff`：把当前仓库状态拆成 staged/unstaged 文件；文件行显示 status、basename/dir、`+/-` 数字。组件也带 stage/unstage/discard actions，但这些是**不要学的写操作**（`GitDiffPanel.tsx:699-756`；`GitDiffPanelShared.tsx:141-255,258-443`）。
- `Agent edits`：按当前 thread 的文件路径分组，每组列 Edit 1/2、状态与增删数；它是会话内工具轨迹，不是 commit history（`GitDiffPanelListModes.tsx:12-129`）。
- `Log`：分 `To push`、`To pull`、`Recent commits`；每行字段为 summary、7 位 SHA、author、相对时间（`GitDiffPanelListModes.tsx:131-227`；`GitDiffPanelShared.tsx:445-483`）。`useGitLog` 还维护 total/ahead/behind/upstream，并在启用时每 10 秒刷新（`useGitLog.ts:5-29,39-109`）。

### 4.2 点 commit 后发生什么

`handleSelectCommit` 设置 `selectedCommitSha`、清文件路径、将中心切到 `diff`、右栏保持 `log`、diff source 改成 `commit`（`examples/CodexMonitor/src/features/app/hooks/useGitPanelController.ts:225-239`）。`useGitCommitDiffs` 再按 workspace + SHA 读整个 commit diff，并用 request id 防止旧请求覆盖新选择（`features/git/hooks/useGitCommitDiffs.ts:17-64,67-97`）。

中心 `GitDiffViewer` 显示该 commit 的多文件 diff，虚拟化列表会按选中文件滚动；滚动时右栏选中路径可同步（`GitDiffViewer.tsx:334-436,547-617`）。返回 Chat 的明确动作由 topbar 提供（`useMainAppLayoutSurfaces.ts:647-653`）。Chat 层没有销毁，只在非 split 模式被隐藏/inert（`DesktopLayout.tsx:162-218`）。

### 4.3 与 thread 的关系

| 数据 | 归属 | 是否随 thread 切换 |
| --- | --- | --- |
| staged / unstaged | 当前 workspace 仓库 | 不属于某条 thread |
| commit log / commit diff | 当前 workspace 仓库 | 不属于某条 thread |
| Agent edits / per-file diff | 当前 thread `activeItems` | **属于当前 thread**（`useGitPanelController.ts:62-65`） |
| 从 Diff 行引用到 composer | 当前可写 composer | 写回当前 thread（`GitDiffViewer.tsx:274-287`） |

这个区分值得 Mobius 学：仓库事实与会话证据可以同面查看，但标签必须写清来源，不能把“本会话改过”与“工作树当前状态”混为同一时间线。

## 5. Mobius 现在的三套 Git/文件查看面

### 5.1 会话“文件修改” Modal

入口是 `查看文件修改`，与 `查看运行命令` 并列（`mobius/frontend/src/components/advanced-session-actions.tsx:80-99`）。Modal：

- 从 `/api/sessions/:id/features/files` 扫 session JSONL，得到 path、次数、首尾时间（`mobius/frontend/src/components/chat.tsx:699-736`；后端 `mobius/backend/routes/sessions.ts:1079-1126`）；
- 选文件后请求 `/features/git-diff?file=...`（`chat.tsx:742-769`）；后端只允许 session 文件清单内路径，避免任意文件 diff（`sessions.ts:1183-1217`）；
- 服务端依次尝试 unstaged、staged、last commit、last two commits，遇到第一份非空 diff 就返回，否则回退当前文件内容（`mobius/backend/services/session-features.ts:409-423,448-510`）。

问题是这四种来源被当成 fallback 顺序，不是可浏览时间线。用户不能同时看 staged 与 unstaged，也不能选“哪个 commit”；Modal 仅用 mode badge 告知最终命中的来源（`chat.tsx:855-888`）。

### 5.2 会话“运行命令” Modal

它单独请求 session Bash 特征，支持按命令/描述/cwd 搜索、显示时间与来源、复制命令（`mobius/frontend/src/components/chat.tsx:900-1044`）。这是一份有价值的 JSONL 审计面，**不要删除或硬塞进 commit log**。难用之处只是它与文件/Diff/Git 不能共享当前文件、工作目录或返回来源。

### 5.3 会话“Git”弹层

Easy 会话的 Git 动作打开 `SessionSkillMemoryModal(initialPanel='git')`（`mobius/frontend/src/components/chat.tsx:4141-4142,4229-4235`）。它请求 `/api/projects/:id/git-sources`，合并中枢、Electron 本机与登记远程机器，显示可用性、branch/HEAD、path 和近期 dirty 数（`mobius/frontend/src/components/session-welcome.tsx:725-784,1042-1095`；后端 `mobius/backend/routes/projects.ts:2663-2806`）。

它**不显示 commit，也不能点文件或 diff**。因此“Git”这个标签实际含义是“仓库来源扫描”，与用户预期的历史/变更查看不一致。

### 5.4 项目设置“版本追踪”

另一个项目级界面请求 `/api/projects/:id/git-tracking?limit=12`（`mobius/frontend/src/components/project-page/ProjectSettingsPanel.tsx:652-666`），有：

- repo path、branch、HEAD、remote、dirty/staged/unstaged/untracked counts（`ProjectSettingsPanel.tsx:112-128,208-227,329-351`）；
- 近期 commit 的 short hash、subject、author、绝对/相对时间、refs（`ProjectSettingsPanel.tsx:360-430`；后端字段来源 `mobius/backend/routes/projects.ts:1530-1619`）。

但 commit 卡片是普通 `<div>`，SHA 是 `<code>`，没有 `onClick`、`role` 或 diff 请求（`ProjectSettingsPanel.tsx:375-430`）。自迭代项目反而突出“回退到此版本 / 硬回退”等高风险动作（`ProjectSettingsPanel.tsx:396-413`）；这不是普通用户需要的只读历史浏览。

## 6. 为什么当前 Mobius 链路难用

| 断点 | 源码证据 | 用户后果 |
| --- | --- | --- |
| 入口按能力拆成三个弹层 | 文件修改/运行命令在第一组，Git 在 condensed 会话配置组（`advanced-session-actions.tsx:80-99,198-249`） | 用户不知道“Git”里没有 diff，也不知道 commit 在项目设置 |
| “Git”只列仓库来源 | `GitSource` 无 commit/file 字段，view 只渲染 source card（`session-welcome.tsx:564-578,1070-1093`） | 选不中文件、commit 或历史 |
| commit 只可读字段，不可展开 | commit card 无点击 handler（`ProjectSettingsPanel.tsx:375-430`） | 知道有提交，却看不到提交改了什么 |
| session 文件与当前 Git 混合 | UI 明示左侧来自 JSONL、右侧来自当前仓库（`chat.tsx:804-808`） | 较早会话可能看到今天的工作树 diff，时间语义漂移 |
| diff 模式是“首个非空 fallback” | `AUTO_DIFF_MODES` 循环首个命中即 return（`session-features.ts:416-423,458-479`） | staged/unstaged/历史不能并列比较 |
| 回复与 Diff 不连通 | 回复 renderer 没有 artifact click，Modal 只接受 sessionId/onClose（`jsonl-compact-markdown.tsx:58-73`；`chat.tsx:699-702`） | 模型说“见 foo.ts:42”时还要手工打开工具、再找文件 |
| 行号语义错误 | Modal 显示 raw diff index（`chat.tsx:683-695`） | 无法从 hunk 跳源码，也无法可靠引用 |
| 返回/焦点未定义 | 三个 modal 有 overlay/关闭按钮，但无统一 Esc/trigger restore（`chat.tsx:771-796,953-977`；`session-welcome.tsx:1182-1213`） | 键盘用户关闭后丢位置；工具之间切换反复开关弹层 |

## 7. Mobius 目标 Git 查看面（只读）

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Git 查看  · repo-name / main @ a1b2c3d     来源：中枢     [刷新] [返回对话] │
├──────────────────────────────┬───────────────────────────────────────────────┤
│ [变更] [历史]                │ src/components/chat.tsx                      │
│                              │ 工作树 · 未暂存    +28 -6                    │
│ 本会话改动  4                │ [预览文件] [引用到对话] [在编辑器打开]       │
│  M chat.tsx          +28 -6  ├───────────────────────────────────────────────┤
│  M index.css          +8 -2  │  683  683 │ function GitDiffBlock...          │
│                              │  689    · │ - rawIndex                         │
│ 工作树                      7 │    ·  689 │ + newLine                          │
│  未暂存 5                    │             @@ -683,12 +683,18 @@             │
│  已暂存 2                    │                                               │
│                              │ 只读 Diff；点击行号选择真实 old/new line      │
│ ───────────────────────────  │                                               │
│ 可选：该文件历史             │                                               │
│ ● a1b2c3d  修复 Diff 行号    │                                               │
│   boyin · 2 小时前           │                                               │
│ ○ 98ef765  增加文件弹层      │                                               │
└──────────────────────────────┴───────────────────────────────────────────────┘
```

行为要求：

- 默认 `变更` 显示“本会话改动”和“当前工作树”两组，标签明确；不要合并成一个虚构清单。
- 点文件只更新右侧单文件 diff；不换路由、不重挂 Chat。点 `历史` 或“该文件历史”才请求 commit log。
- 点 commit 后右侧显示该 commit 的文件清单/选中文件 diff，并在标题显示 SHA + subject；再次点工作树回当前 diff。
- staging 状态可以读、可以分组，但 P0–P2 默认界面**不提供 stage/unstage/discard/commit/push/reset**。
- Bash 审计保留独立数据与卡片，可在同一会话工具容器切换；不把命令伪造成 Git 时间线。
- 仓库有多个来源时先选来源；只有中枢当前已有完整 log API。Electron/远端没有 commit diff 能力时明确显示“仅状态”，不拼假数据。

## 8. 单文件历史的正确边界

目标中的“该文件历史”应是可选 P2：

```text
selected repository + selected path
  → git log --follow --format=<structured> -- <path>
  → commit rows
  → select sha
  → git show <sha> -- <path>
```

它不等于：

- CodexMonitor 的 Agent edits（当前 thread 工具记录）；
- Mobius 的 session file feature（JSONL 中出现过几次）；
- `last_commit / last_two_commits` fallback（固定 HEAD 窗口）。

UI 可以把三者放在同一查看面，但必须分别标为“本会话证据 / 工作树 / 提交历史”。

## 9. 取舍：必须学 / 可学 / 不要学

| 级别 | 内容 |
| --- | --- |
| **必须学** | file/log row 可键盘选择；点 commit 在会话壳内看 diff；Chat/Diff 可明确返回；仓库状态、commit、thread edits 标清归属；失败留在所属层 |
| **可学** | 右栏列表 + 中心 viewer 的主从结构；To push/To pull 作为已有 upstream 数据的只读分组；Diff 行选择后引用 Composer |
| **不要学** | CodexMonitor 的 stage/unstage/discard/commit/pull/push/PR/review；消息文件默认外部打开；把 `Agent edits` 冒充单文件 commit 历史；删除 Mobius JSONL/Bash 审计 |

最小成功标准不是“做出一个 Git 客户端”，而是用户能从一句模型回复到具体文件/行/差异，再回到同一会话；需要追溯时，能只读查看 commit 改了什么。
