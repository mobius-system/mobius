# 用户隔离增强方案（mobius 后端视角）

> 日期：2026-10-09 ｜ 范围：mobius 后端与全部 HTTP endpoint
>
> **沙盒机制**（选型、驱动源码、逐项实测）见配套文档
> **[sandbox-plan.html](https://serve.nutshellai.cn/publish/auto/mobius-sandbox/sandbox-plan-v6.html)**
> （仓库副本 `docs/blueprints/sandbox-plan.html`）。本文只写后端侧。
>
> 本文按**功能模块**组织：先讲权限模型，再逐模块给出「现状 → 问题 → 整改」。

---

## 1. 背景与威胁模型

**根本前提：mobius 后端、它 spawn 的 Agent、以及 code-server，全部运行在同一个 Linux 账号下。**
没有 uid 隔离、没有 namespace、没有容器内二次隔离。

**推论：应用层（HTTP 路由 + access-control）是租户之间唯一的防线。**
应用层被绕过的缺口 = 直接拿到该 OS 账号能碰的一切（他人工作区、SSH 私钥、整机）。

现状：用户目录是**约定式**的（`users.work_dir`），项目根是 `projects.bind_path`，
强制点**分散**在 `project-path.ts` / `project-file-ops.ts` / `workspace.ts` /
`code-server-workspace.ts` / `access-control.ts` 以及各路由自身的判断里。

---

## 2. 权限模型

### 2.1 两类角色

| 维度 | 取值 | 说明 |
|---|---|---|
| 系统角色 | `admin` / `developer` / `user` | `admin` 全局可见可管；`developer` 可建扩展项目 |
| 项目内角色 | `owner` / `manager` / `member` / `viewer` | `viewer` = 只读成员 |

### 2.2 三条归属关系

- **项目创建者**（`projects.created_by`）—— 对项目**及其内部所有会话**有全部权限（含操作他人会话）
- **会话归属者**（`sessions_v2.user_id`）—— 决定 Agent 以谁的身份、在谁的沙盒里运行
- **资源创建者**（`issue.created_by` / `research.created_by`）—— 见 §3.4

### 2.3 目标状态：谁能对什么做什么

| 对象 | admin | 项目创建者 | owner/manager | member | viewer | 非成员 |
|---|---|---|---|---|---|---|
| 项目本身 | 全权 | 全权 | 管理 | 读 | 读 | 不可见 |
| 项目内**他人**会话 | 全权 | **全权**（含下发指令） | 读 | 读 | 读 | 不可见 |
| 项目文件 —— 读 | ✔ | ✔ | ✔ | ✔ | ✔ | ✖ |
| 项目文件 —— **写** | ✔ | ✔ | ✔ | ✔ | **✖** | ✖ |
| 建任务单 / 跑会话 | ✔ | ✔ | ✔ | ✔ | **✖** | ✖ |
| 插件项目（`kind='extension'`） | 读写 | — | — | **只读** | **只读** | **只读** |

### 2.4 三条原则

1. **无 default-allow**：鉴权失败即拒绝，不设"兜底放行"。
2. **先鉴权、后业务**：每个入口先定"调用者是谁、能碰什么"，再进业务逻辑。
3. **归属即边界**：资源归属者与项目成员身份共同决定可见性；**脱离项目即失效**（§3.4）。

---

## 3. 按功能分区的现状与整改

> 行号为改前状态。🔴 严重 / 🟠 中等 / 🟡 待定

### 3.1 项目（projects）

**现状**：`bind_path` 由 `resolveBindPath` 做词法围栏（`abs.startsWith(userRoot + path.sep)`）；
成员/可见性/删除各自有 gate（`canManageProject`、`ProjectMemberships.canManage`、
删除策略 + 二次密码校验）。

**问题**

| # | 问题 | 位置 |
|---|---|---|
| 🔴 | **`bindPathManual` 无门禁**：`POST /api/projects` **仅挂 `auth`**，该标志从 body 直读，命中即走 `resolveBindPathManual()` —— 该函数注释自认"**不检查是否落在 work_dir 内**"。任意登录用户可把项目绑到 `/etc`、他人工作区等任意绝对路径 | 创建 `routes/projects.ts:2127`（仅 auth）、`:2133`、`:2216-2218`；改绑 `:2723-2726`；旁路函数 `:418-432` |
| 🟠 | 后果面**不止文件接口**：`session-message-runner` 取的 `cwd` 就来自 `bind_path` —— 这条直接决定 **Agent 在哪儿跑** | `services/session-message-runner.ts` → `services/workspace.ts` |

**整改**

| 编号 | 内容 |
|---|---|
| **A** | `bindPathManual` 加角色判定：**仅 `admin` 可命中**（`:2216-2218`、`:2723-2726`） |
| **M** | 存量扫描：列出 `bind_path` 不在其 owner `work_dir` 内的项目 |

> **A 的兼容性**：后端内部自建的项目（assistant 项目、自迭代项目）走**内部构造**
> （`routes/assistant.ts`、`services/extension-agent-bridge.ts`），不经过该分支，**不受影响**。

### 3.2 会话（sessions）

**现状**：核心下发路径 `runSessionMessage` 会重新校验归属
（`findSessionOperable` = `canOperateSession`），`routes/sessions.ts` 的绝大多数端点走
`findSessionReadable` / `findSessionOperable`。

**问题**

| # | 问题 | 位置 |
|---|---|---|
| 🟠 | **只读成员可开研究会话**：`canCreateSessionForResearch` **仅委托 `canReadResearch`**，无写闸。issue 侧已有 v3 gate（走 `projectAllowsReaderWrite`，已排除 viewer），**research 侧缺失** | `services/access-control.ts:370-372` |
| 🟡 | `/emphasize` 只校验**会话**归属，但 `Skills.findById(id)` / `Memories.findById(id)` 的 id 来自 body，**无 `canReadContextItem`** → 读他人 memory 正文 / 复制他人 skill 目录 | `routes/sessions.ts:1860-1900`（`:1888`、`:1896`） |

**整改**

| 编号 | 内容 |
|---|---|
| **C** | 研究会话加写闸（照抄 issue 侧 v3 gate） |
| **J** | `/emphasize` 的 item 加 `canReadContextItem` |

### 3.3 文件访问（file APIs / 下载 / code-server / 终端）

**现状**：项目内路径由 `resolveProjectPath` 做词法围栏；**写**操作另调 `assertNoSymlink`。

**问题**

| # | 问题 | 位置 |
|---|---|---|
| 🟠 | **文件写端点用读权限把关**：`/:id/file`、`/files/{create,mkdir,move,copy,rename}`、`/import-zip` 统一调 `loadReadableProject`（**37 处**），管理类只有 7 处 → **viewer 可改/删/搬文件** | `routes/projects.ts` 各文件端点 |
| 🟠 | **读路径不查软链**（写路径查）：读用 `statSync`（跟随）+ `readFileSync`；下载**只 lstat 最后一段** → 在自己项目建软链指向他人目录即可跨用户读 | `routes/projects.ts:3442-3446`、`:3605-3617` |
| 🟠 | **code-server 工作区放行过宽**：放行**任意 `/tmp`**、放行 **`bind_path` 的父目录**（项目若绑在 `work_dir` 本身，父目录＝全站公共父目录）；无 realpath | `services/code-server-workspace.ts:27`、`:31`、`:99` |
| 🟡 | **下载接口放行面过宽**：放行**任意 `/tmp`** 与**共享 upload 目录**；项目前缀为**纯词法**、无 realpath | `routes/files.ts:60-64`、`:80-89` |

**整改**

| 编号 | 内容 |
|---|---|
| **D** | 文件写端点改用**写权限 gate**（37 处 `loadReadableProject` → 写权限版本） |
| **F** | 读路径补 `assertNoSymlink`（`:3442-3446`、`:3605-3617`） |
| **H** | 收窄 download 放行面：去掉 `/tmp` 与共享 upload 全放行；项目前缀补 realpath |

> 已守住的对照：`project-path.ts` 词法围栏 + `..` 剥离、`project-file-ops.ts` 的
> `assertNoSymlink`/`validateNewName`、`code-server-proxy.ts` 的 `<userId>__<projectId>` 键校验 +
> `jwt.id` 匹配、`routes/web-terminal.ts` 的 `findByIdForUser` + adhoc 仅管理员。

### 3.4 研究（research / 图 / 黑板）

**现状**：`research-graph.ts:133-157` 的 `resolveGraphImage` 是**全仓唯一正确处理软链**的地方
（root 前缀 + 双重 realpath），黑板读写有 `canReadResearch` / `researchBlackboardUserAccess`。

**问题**

| # | 问题 | 位置 |
|---|---|---|
| 🟠 | **`GET /api/research-graph/:researchId` 完全无鉴权**（对照 `:658` 黑板有中间件、`:688` 图片有 `downloadAuth`）；`server.js` **无全局 auth** → 匿名可读任意 research 的图内容与服务器绝对路径 | `routes/researches.ts:677`；`server.js:127` |
| 🟡 | 黑板 POST **信任客户端传的 `author` / `metadata.session_id`** → 可冒名他人会话 | `routes/researches.ts:664-675` |
| 🟠 | **被移出项目者仍保有旧 issue / research 的读写**：`created_by` 短路无视当前成员身份 | `access-control.ts:317`、`:334`、`:342`、`:359` |

**整改**

| 编号 | 内容 |
|---|---|
| **G-1** | 给 `graphRouter.get('/:researchId')` 加 `downloadAuth` + `canReadResearch` |
| **L** | 黑板 POST 的 `author` / `session_id` 改由**服务端注入**（不信任客户端） |
| **E** | `created_by` 短路追加「**仍是项目成员**」条件 —— **包括用户自己创建的会话也一并断绝**（已定：彻底断） |

### 3.5 上下文项（skill / memory）

**现状**：scope 由**路由决定**（`/api/skills` 恒建 `user` scope；`/api/projects/:id/skills` 建 `project` scope），
**不接受请求传 scope**；读路径绝大多数经 `filterReadableContextItems`；`allowedByVisibility`
**无 default-allow 兜底**。

**问题**

| # | 问题 | 位置 |
|---|---|---|
| 🟡 | `import-local` 接受**任意服务器绝对路径** → 读进自己库 | `routes/skills.ts:309-317`（memories 同款） |
| 🟡 | `/emphasize` 不校验 item 归属（同 §3.2） | `routes/sessions.ts:1888, 1896` |

**整改**

| 编号 | 内容 |
|---|---|
| **I** | `import-local` 加根约束 |
| **J** | 同 §3.2 |

### 3.6 群聊（conversations）

**现状**：群成员校验存在（`Conversations.findMember`），移除他人成员需群主。

**问题**

| # | 问题 | 位置 |
|---|---|---|
| 🟡 | **任意群成员可加任意 agent**（不校验邀请者是否**拥有**该 agent）；触发时以 `agent_owner_id` 身份建会话并 `runSessionMessage` → **可驱动他人 Agent** | `routes/conversations.ts:117-137`；`:231`、`:239-247` |

**整改**

| 编号 | 内容 |
|---|---|
| **K** | 加「邀请者须拥有该 agent」校验 |

### 3.7 扩展（extensions）

**现状**：**已守住** —— 扩展名 `EXT_NAME_RE` 白名单、`safeResolveUnder` / `safeResolveAsset`、
per-user 扩展数据目录（`users/<safeUserSegment(userId)>`）、注册/编译仅管理员、
项目创建仅 admin/developer。**本模块无待修项。**

**新增需求**：插件项目（`kind='extension'`）的**读权限**要放开给普通用户（只读），当前完全没有这条规则。

**整改**

| 编号 | 内容 |
|---|---|
| **B** | 新增规则：插件项目 管理员读写 / **普通用户只读**。覆盖 `canReadProject` / `canManageProject` / `projectAllowsReaderWrite` 及文件端点 |

### 3.8 Agent 执行与沙盒

**现状**：三处 spawn（`tmux-claude-code.ts` ~1867、`tmux-codex.ts` ~1678、
`deepseek-harness.ts` ~257），与后端同 uid、无沙盒。

**整改**（细节见 sandbox-plan.html，此处只列后端要做的）

| 编号 | 内容 |
|---|---|
| **N** | 每次 spawn 现算 deny 列表：`deny(U) = {每个 V≠U 的 users.work_dir} ∪ {U 无写权限的 projects.bind_path}`，`U` = **会话归属者**；写成策略文件传给驱动 |
| **O** | 三处注入点包一层启动器 `mobius-landlock --policy F -- <原命令>` |
| **P** | 两个开关：`AGENT_SANDBOX_ENFORCE_USERS`（默认 true，普通用户强制）、`AGENT_SANDBOX_ADMIN`（默认 false）。**含 env 三道闸**：`boot_utils.py` 的 `RUNTIME_SETTINGS`、`ecosystem.config.js` 的 `envKeys`、`backend/config.js` |
| **Q** | 启动自检：跑 `mobius-landlock --check`（**必须 fork 子进程** —— `landlock_restrict_self` 永久自缚）。失败即进入「**不允许创建普通用户**」状态，入口拒绝 + 日志写明原因 |

---

## 4. 整改清单（汇总）

| 编号 | 功能区 | 内容 | 类型 |
|---|---|---|---|
| **A** | 项目 | `bindPathManual` 仅管理员 | 🔴 安全 |
| **B** | 扩展 | 插件项目：管理员读写 / 普通用户只读 | 功能 |
| **C** | 会话 | 研究会话加写闸（禁止 viewer 开研究） | 🟠 安全 |
| **D** | 文件 | 文件写端点改用写权限 gate（37 处） | 🟠 安全 |
| **E** | 研究 | 被移出项目者彻底断权（**含自己创建的会话**） | 🟠 安全 |
| **F** | 文件 | 读路径补软链检查 | 🟠 安全 |
| **G-1** | 研究 | `research-graph` 端点补鉴权 | 🟠 安全 |
| **G-2** | 任务 | `tasks/:id/risk` 是否补 token —— **待定**（见 §7.2） | 🟡 待定 |
| **H** | 文件 | 收窄 download 放行面 | 🟡 加固 |
| **I** | 上下文 | `import-local` 加根约束 | 🟡 加固 |
| **J** | 会话/上下文 | `/emphasize` 的 item 加归属校验 | 🟡 加固 |
| **K** | 群聊 | 加「邀请者须拥有该 agent」校验 | 🟡 加固 |
| **L** | 研究 | 黑板 `author`/`session_id` 改服务端注入 | 🟡 加固 |
| **M** | 项目 | 存量 `bind_path` 扫描 | 运维 |
| **N~Q** | Agent | 沙盒接入（deny 列表 / 注入点 / 开关 / 自检） | 功能 |

---

## 5. 已拍板的策略边界

| # | 决策 | 影响 |
|---|---|---|
| 1 | 项目创建者对项目内**所有**会话有全部权限 | **保持现状**，不改 `canOperateSession` |
| 2 | 插件项目：管理员读写、普通用户只读 | 见 B |
| 3 | 只读成员：**不能对话、不能改删文件** | 见 C、D |
| 4 | `bindPathManual` 普通用户堵掉、仅管理员保留 | 见 A |
| 5 | 公用 `/tmp`、`~/.claude` 隔离**延后** | 见 §6 |
| 6 | 被移出项目者：彻底断权（**含自己创建的会话**） | 见 E |
| 7 | 沙盒按「**会话归谁**」判定 | 见 N |
| 8 | 管理员不套沙盒；普通用户强制套 | 见 P |
| 9 | 沙盒不可用 → 回退「不允许创建普通用户」 | 见 Q |

---

## 6. 已知并接受的缺口（延后，不阻塞本轮）

| 缺口 | 后果 |
|---|---|
| 公用 `/tmp` | Agent 可读 `/tmp/tmux-<uid>/` 插座（跨用户偷看 AI 面板）；该插座同时是"指挥沙盒外进程"的通道 |
| 公用 `~/.claude` | 任一 Agent 可读**全体用户的提问历史、会话转录、凭据** |
| Agent 与后端同 uid | 应用层是唯一防线，无 OS 级兜底 |
| Landlock 不可限制面 | `chmod` / `stat` / `chdir` 等（内核 man page CAVEATS 明载） |
| 无自定义错误话术 | 被拦时只有 `Permission denied`，无法从错误码区分沙盒 |

---

## 7. 分阶段与验收

### 7.1 阶段

| 阶段 | 内容 |
|---|---|
| **P0** | 驱动入仓 + 启动器落地 |
| **P1** | 后端整改 A ~ M |
| **P2** | 沙盒接入 N ~ Q |
| **P3** | 打包进容器镜像 + 部署 |
| **P4** | 端到端验证 |

### 7.2 验收清单（后端侧）

1. 普通用户会话：Agent 读不到他人目录；管理员会话不受限
2. Agent 正常完成一次真实任务，不被误伤
3. 新会话、续跑、`deepseek-harness` 三条路径都套上沙盒
4. `--check` 可用/不可用环境返回值正确；强制失败 → 普通用户创建入口被拒、管理员不受影响
5. 自检后 mobius 主进程仍能正常读写任意路径（未被自缚）
6. A ~ Q 每项配一条针对性用例

### 7.3 待定项

- **G-2**：`GET /api/tasks/:id/risk` 保持"有意无鉴权"还是补 token。
  仓库内**无调用方**（调用者来自仓库外），只返回一个风险等级。
  **建议先不动**，待确认调用方后再定。
