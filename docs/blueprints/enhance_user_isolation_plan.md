# 用户隔离增强方案（mobius 后端视角）

> 日期：2026-10-09 ｜ 范围：mobius 后端与全部 HTTP endpoint
>
> **沙盒部分不在本文展开** —— 机制选型、驱动实现与逐项实测见
> **[sandbox-plan.html](https://serve.nutshellai.cn/publish/auto/mobius-sandbox/sandbox-plan-v6.html)**
> （仓库副本 `docs/blueprints/sandbox-plan.html`）。本文只写后端侧要做什么。

---

## 1. 威胁模型与现状

**根本前提：mobius 后端、它 spawn 的所有 Agent、以及 code-server，全部运行在同一个 Linux 账号下。**
没有 uid 隔离、没有 namespace、没有容器内二次隔离。

推论：**应用层（HTTP 路由 + access-control）是租户之间唯一的防线。** 应用层被绕过的缺口，
等于直接拿到该 OS 账号能碰的一切 —— 包括其他用户的工作区、SSH 私钥、以及整机。

现状盘点（改前基线）：

| 层 | 现状 |
|---|---|
| 用户目录 | 约定式：`users.work_dir`（默认 `<WORKSPACE_ROOT>/<userId>`）。**仅应用层约束** |
| 项目根 | `projects.bind_path`。`resolveProjectPath` 做词法围栏 |
| 强制点 | **分散**：`project-path.ts`（穿越）、`project-file-ops.ts`（软链/文件名）、`workspace.ts`（会话 cwd）、`code-server-workspace.ts`（编辑器根）、`access-control.ts`（归属），外加各路由自行判断 |
| Agent 执行 | tmux 窗口内 `bash -lc`，与后端同 uid，`--dangerously-skip-permissions` |

---

## 2. 已确认的后端缺陷（按严重度）

> 全部经逐条读码核实，行号为改前状态。

### 🔴 P0-1 `bindPathManual` 无门禁 —— 单点废掉整套路径围栏

| 项 | 内容 |
|---|---|
| 位置 | 创建 `routes/projects.ts:2127`（**仅 `auth`**）、`:2133` 从 body 直读、`:2216-2218` 生效；改绑 `:2723-2726` |
| 旁路函数 | `routes/projects.ts:418-432` `resolveBindPathManual()`，注释自认"**不检查是否落在 work_dir 内**" |
| 对照 | 安全的兄弟函数 `resolveBindPath`（`:387-411`）有 `abs.startsWith(userRoot + path.sep)` 校验 |
| 攻击 | 任意登录用户 `POST /api/projects {"name":"x","bindPath":"/etc","bindPathManual":true}` → 该项目下**所有文件接口、code-server、以及 Agent 的 cwd** 全部以 `/etc` 为根 |

**后果面**：不只文件接口 —— `session-message-runner` 取的 `cwd` 就来自 `bind_path`，所以这条直接决定 Agent 在哪儿跑。

### 🔴 P1-2 code-server 工作区放行过宽

`services/code-server-workspace.ts`

```ts
:27   if (isWithinTmp(target)) return true;          // 任意 /tmp 路径
:31   return target === path.dirname(bindRoot);      // bind_path 的【父目录】
:99   if (isWithinTmp(target)) return { ok: true };  // openFile 载荷也放行 /tmp
```

无 realpath。第 31 行是硬伤：项目若绑定在 `work_dir` 本身（`resolveBindPath` 允许），
父目录即**全站工作区公共父目录** → `?folder=/data/workspace` 一览全站。

### 🔴 P1-3 只读成员可开研究会话

`services/access-control.ts:370-372` `canCreateSessionForResearch` **仅委托 `canReadResearch`**，无写闸。
issue 侧已有 v3 gate（`:362-368` 走 `projectAllowsReaderWrite`，已排除 viewer），**research 侧缺失**
→ viewer 能开研究会话让 AI 干活，与"只读"语义矛盾。

### 🟠 P2-4 文件写端点用读权限把关

`routes/projects.ts` 的文件写端点（`/:id/file`、`/files/{create,mkdir,move,copy,rename}`、`/import-zip`）
统一调 `loadReadableProject`（**37 处**），而管理类只有 7 处 `loadManageableProject`
→ **viewer（只读成员）可以改、删、搬文件**。

### 🟠 P2-5 读路径不查软链，写路径查

`assertNoSymlink` 只在 copy/move/mkdir/create/rename 上调用；
读路径 `routes/projects.ts:3442-3446`（`statSync` 跟随 + `readFileSync`）与
`:3605-3617`（`/file/download` **只 lstat 最后一段**）都不查
→ 在自己项目里建软链指向他人目录后可跨用户读。

### 🟠 P2-6 被移出项目者仍保有旧 issue / research 的读写

`services/access-control.ts` 的 `created_by` 短路无视当前成员身份：
`canReadIssue:317`、`canManageIssue:334`、`canReadResearch:342`、`canManageResearch:359`。

### 🟠 P2-7 `GET /api/research-graph/:researchId` 完全无鉴权

`routes/researches.ts:677` 无任何中间件（对照 `:658` 黑板有 `researchBlackboardUserAccess`、
`:688` 图片有 `downloadAuth`）；`server.js:127` 挂载，且 **server.js 无全局 auth**
→ 匿名可读任意 research 的图内容与服务器绝对路径。

### 🟡 P3 其余确认项

| # | 位置 | 问题 |
|---|---|---|
| a | `routes/files.ts:60-64, 80-89` | `/api/download`、`/api/files/download` 放行**任意 `/tmp`** 与**共享 upload 目录**；项目前缀为**纯词法**、无 realpath |
| b | `routes/skills.ts:309-317`（memories 同款） | `import-local` 接受任意服务器绝对路径 → 读进自己库 |
| c | `routes/sessions.ts:1860-1900` | `/emphasize` 只校验**会话**归属，`Skills.findById(id)`(`:1888`)/`Memories.findById(id)`(`:1896`) 的 id 来自 body，**无 `canReadContextItem`** → 读他人 memory 正文 / 复制他人 skill 目录 |
| d | `routes/conversations.ts:117-137, 197-247` | 任意群成员可加任意 agent（不校验邀请者是否拥有）；`:231` `user_id: ownerId`、`:239` 以 owner 身份 `runSessionMessage` → 可驱动他人 Agent |
| e | `routes/researches.ts:664-675` | 黑板 POST 信任客户端传的 `author` / `metadata.session_id` → 可冒名 |
| f | `routes/tasks.ts:167-172` | `GET /api/tasks/:id/risk` 无鉴权（注释自认 wrapper/hooks 用途） |

### 已正确守住（不需改动，供回归对照）

`services/project-path.ts` 词法围栏 + `..` 剥离 ·
`project-file-ops.ts` 的 `assertNoSymlink` / `validateNewName` ·
`access-control.ts` 的 `allowedByVisibility`（**无 default-allow 兜底**）·
扩展名 `EXT_NAME_RE` + `resolveUnder` + per-user ext data ·
`code-server-proxy.ts` 的 `<userId>__<projectId>` 键校验 + `jwt.id` 匹配 ·
`mention-context.ts` 门禁 · `research-graph.ts:133-157` `resolveGraphImage`（**唯一正确处理 symlink 处**）·
`routes/web-terminal.ts` 的 `findByIdForUser` + adhoc 仅管理员 ·
`routes/ext.ts` 的 `safeResolveUnder` / `safeResolveAsset`。

---

## 3. 已拍板的策略边界

| # | 决策 | 影响 |
|---|---|---|
| 1 | 项目创建者对项目内**所有**会话有全部权限（读+操作） | **保持现状**，不改 `canOperateSession` |
| 2 | 插件项目（`kind='extension'`）：管理员读写、普通用户只读 | **需新加规则**（access-control 现对 extension 零特殊处理） |
| 3 | 只读成员：**不能对话、不能改删文件** | 需修 P1-3、P2-4 |
| 4 | `bindPathManual` 普通用户**堵掉**，**仅管理员保留** | 需修 P0-1 |
| 5 | 公用 `/tmp`、`~/.claude` 的隔离**延后** | 已知风险，见 §6 |
| 6 | 被移出项目者：**断掉**其在项目内旧 issue/research 的访问 | 需修 P2-6 |
| 7 | 沙盒按「**会话归谁**」判定（会话归属者的角色），不按「谁在操作」 | 后端算 deny 列表时以 session owner 为准 |
| 8 | 管理员不套沙盒；普通用户**强制**套 | 见 §5 |
| 9 | 沙盒不可用 → 回退到「**不允许创建普通用户**」 | 见 §5 |

---

## 4. 后端修复清单

| # | 内容 | 位置 |
|---|---|---|
| **A** | `bindPathManual` 加角色判定（仅 `admin` 可命中） | `routes/projects.ts:2216-2218`、`:2723-2726` |
| **B** | 插件项目规则：管理员读写 / 普通用户只读 | `services/access-control.ts` 新增（覆盖 `canReadProject` / `canManageProject` / `projectAllowsReaderWrite` 及文件端点） |
| **C** | 研究会话加写闸 | `services/access-control.ts:370-372`（照抄 issue 侧 v3 gate） |
| **D** | 文件写端点改用写权限 gate | `routes/projects.ts` 37 处 `loadReadableProject` → 写权限版本 |
| **E** | 被踢成员断权 | `access-control.ts:317 / 334 / 342 / 359` 追加「**仍是项目成员**」条件 |
| **F** | 读路径补软链检查 | `routes/projects.ts:3442-3446`、`:3605-3617` 补 `assertNoSymlink` |
| **G** | 补鉴权 | `routes/researches.ts:677` 加 `downloadAuth` + `canReadResearch`；`routes/tasks.ts:167-172` 视需要加 token |
| **H** | 收窄 download 放行面 | `routes/files.ts:60-64, 80-89`：去掉 `/tmp` 全放行、去掉共享 upload 全放行；项目前缀补 realpath |
| **I** | `import-local` 加根约束 | `routes/skills.ts:309-317`、`routes/memories.ts` 同款 |
| **J** | `/emphasize` 的 item 加 `canReadContextItem` | `routes/sessions.ts:1888, 1896` |
| **K** | 群 `@agent` 加「邀请者须拥有该 agent」校验 | `routes/conversations.ts:117-137` |
| **L** | 黑板 POST 的 `author`/`session_id` 改由服务端注入 | `routes/researches.ts:664-675` |
| **M** | 存量扫描：列出 `bind_path` 不在其 owner `work_dir` 内的项目 | 一次性脚本 |

> **A 的兼容性**：后端内部自建的项目（assistant 项目、自迭代项目）走**内部构造**
> （`routes/assistant.ts`、`services/extension-agent-bridge.ts`）不经过 `bindPathManual` 分支，
> 因此不受影响。

---

## 5. 沙盒在后端侧的接入（详见 sandbox-plan.html）

后端只需做四件事：

1. **算 deny 列表**（每次 spawn 现算）：

   ```
   deny(U) = { 每个 V≠U 的 users.work_dir }
           ∪ { 每个 U 无写权限的 projects.bind_path }
   ```

   `U` = **会话归属者**（决策 7）。写成策略文件传给驱动（不走 argv，避免暴露在 `ps`）。

2. **三处注入点**包一层启动器：

   | 文件 | 行 | 改法 |
   |---|---|---|
   | `agents/tmux-claude-code.ts` | ~1867 | `bash -lc cmd` → `mobius-landlock --policy F -- bash -lc cmd` |
   | `agents/tmux-codex.ts` | ~1678 | 同上 |
   | `agents/deepseek-harness.ts` | ~257 | `spawn(cmd,…)` → `spawn(launcher,…)` |

3. **两个开关**（含本项目 env 三道闸：`boot_utils.py` 的 `RUNTIME_SETTINGS`、
   `ecosystem.config.js` 的 `envKeys`、`backend/config.js`）：

   | 配置 | 默认 | 语义 |
   |---|---|---|
   | `AGENT_SANDBOX_ENFORCE_USERS` | `true` | 普通用户 Agent **强制**套沙盒，无用户级关闭途径 |
   | `AGENT_SANDBOX_ADMIN` | `false` | 管理员 Agent 是否套沙盒 |

4. **启动自检 + fail-closed**：启动时跑 `mobius-landlock --check`（**必须 fork 子进程** ——
   `landlock_restrict_self` 永久自缚，在主进程调会锁死后端）。任一项失败即进入
   「**不允许创建普通用户**」状态：注册/开通普通用户的入口一律拒绝，日志写明原因。

---

## 6. 已知并接受的缺口（有意识延后）

| 缺口 | 后果 | 状态 |
|---|---|---|
| 公用 `/tmp` | Agent 可读 `/tmp/tmux-<uid>/` 插座；**且该插座还是"指挥沙盒外进程"的通道**（已实测逃逸） | **已升级为必须解决**，见 §8 |
| 公用 `~/.claude` | 任一 Agent 可读**全体用户的提问历史、会话转录、凭据** | 延后 |
| Agent 与后端同 uid | 应用层是唯一防线；无 OS 级兜底 | 延后 |
| Landlock 不可限制面 | `chmod` / `stat` / `chdir` 等（内核 man page CAVEATS 明载） | 已认可 |
| 无自定义错误话术 | 被拦时只有 `Permission denied`，无法从错误码区分沙盒 | 本次放弃 |

---

## 7. 分阶段实施

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P0** | 驱动入仓 + 启动器落地 | 可运行的 `mobius-landlock` |
| **P1** | 后端修复 A ~ M | 修复提交 + 存量扫描报告 |
| **P2** | 接入 3 个注入点 + 两个开关（三道闸）+ 启动自检与回退 | 沙盒生效 |
| **P3** | 打包进容器镜像 + 部署（`python3 start.py`） | 上线 |
| **P4** | 端到端验证 | 验证报告 |

**验证清单**（后端侧，沙盒侧见 sandbox-plan.html §8）：

1. 普通用户会话：Agent 读不到他人目录；管理员会话不受限
2. Agent 正常完成一次真实任务（编译 / 跑测试 / 联网），不被误伤
3. 新会话、续跑、`deepseek-harness` 三条路径都套上
4. `--check` 可用环境返回 0、不可用环境返回非 0；强制失败 → 普通用户创建入口被拒、管理员不受影响
5. 自检后 mobius 主进程仍能正常读写任意路径（**未被自缚**）
6. A ~ M 每项配一条针对性用例

---

## 8. 待决问题（阻塞项）

**Unix socket 连接不受 Landlock 管辖**（sandbox-plan.html §2 测试任务 VIII 已实测）：
socket 在被 deny 的目录内时 `open` 被拒、但 `connect` **成功**。

因此 **只给 pane 进程套 Landlock 关不住 Agent** —— 沙盒外的进程可被指挥着干活（tmux `run-shell`
已实测逃逸成功）。mobius 环境下至少三个通道：**tmux server**（正是 Agent 宿主）、
**code-server**（回环 + `--auth none`）、**docker.sock**（可达即等价 root）。
**把 socket 挪位置无效**，deny 列表也拦不住。

| 方向 | 说明 | 代价 |
|---|---|---|
| **不用 tmux 承载 Agent** | 去掉"沙盒外的代理进程"；`deepseek-harness` 已是直接 spawn 的先例 | 要动 Agent 管理架构 |
| **独立 OS 用户** | Agent 换 uid → socket（`srw-rw----` 属主为后端 uid）被普通 DAC 拦住；**也是唯一能顺带干掉 docker.sock 的途径** | 需要一次提权 |
| seccomp 拦 connect | 静态 BPF 只能整体禁（断网）；按 family 过滤需 unotify 监督进程，而它在容器内被 Docker 默认策略拦死 | ❌ 不可行 |

**此外待确认**：
- 修复 E 的边界：用户**自己创建的会话**是否也断？倾向**保留**（那是他自己的对话记录），只断项目内 issue/research。
- 修复 G 中 `GET /api/tasks/:id/risk` 是保持"有意无鉴权"还是补 token。
