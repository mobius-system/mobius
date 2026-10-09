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

### 2.1 角色

| 维度 | 取值 | 说明 |
|---|---|---|
| 系统角色 | **`admin` / `user`** | **取消 `developer`** |
| 项目内角色 | **`owner` / `developer` / `viewer`** | **取消 `manager` / `member`** |
| 非成员 | 不是角色，是「**没有显式记录**」时的默认态 | 见 §2.3 |

### 2.2 默认权限规则（无显式记录时）

| 项目类型 | 创建者 | 其他人 | 效果 |
|---|---|---|---|
| **扩展项目**（`kind='extension'`） | `owner` | **`viewer`** | 创建后**其他人可见**（只读） |
| **普通项目** | `owner` | **非成员** | 创建后**其他人不可见 —— 包括 `admin`** |

**owner 三条硬规则**：**唯一**（一个项目只能有一个 owner）· **不可退出** · **不可变更**（谁都不能改 owner）。

> ⚠️ **本次反转**：此前定的「`admin` 对所有项目拥有 `owner` 同等权限」**已作废**。
> 新规则：`admin` 也走默认规则（普通项目里 = 非成员 → 不可见）；但 `admin` 多一项特权 ——
> **可随时去管理中心给自己加权限**。影响：`access-control.ts` 里 `if (role === 'admin') return true` 短路要删掉。

### 2.3 显式记录 vs 默认规则

项目里存「**显式权限记录**」；**某用户没有记录 → 按 §2.2 默认规则判断**。

| 情况 | 判定 |
|---|---|
| 有显式记录 | 按记录的值（`developer` / `viewer` / **显式排除**） |
| 无显式记录 | 按 §2.2 默认规则 |
| `owner` | 由 `projects.created_by` 决定，**不入记录表** |

**为什么这样设计**：① 新建用户不用补记录，默认规则自动生效；② 权限中途被改只改显式记录，不污染默认规则。
**「显式排除」的用途**：覆盖默认（例如扩展项目默认 viewer，要把某人设为不可见就得显式写排除）。

> **只记结果，不记过程**：记录表里存的**只有「最终权限状态」**，**不记录**「谁在何时授权的」。
> 因此 `admin` 给自己加权限，与业务上添加一个成员，**在数据上完全等价** —— 不设独立审计通道、
> 不加「由管理员授予」之类的标记。整个模型只有两样东西：**显式记录** + **默认规则**。
>
> 注：现有 `project_memberships` 表已有一个 `created_by` 列（记录"谁把此人加进来的"）。
> 按"只记结果"它**不再有新含义**，建议**保留不管**（无代码依赖其做判断）。

### 2.4 目标状态矩阵

| 能力 | admin（默认） | owner | developer | viewer | 非成员 |
|---|---|---|---|---|---|
| 读项目（普通项目） | **✖** | ✔ | ✔ | ✔ | ✖ |
| 读项目（扩展项目） | **✖** | ✔ | ✔ | ✔ | ✖（除非显式排除） |
| 项目文件 —— 写 | — | ✔ | ✔ | ✖ | ✖ |
| 建任务单 / 跑会话 | — | ✔ | ✔ | ✖ | ✖ |
| 调整他人权限 | **✔（特权）** | 部分（见 §2.5） | ✖ | ✖ | ✖ |
| 删除项目 | — | ✔ | ✖ | ✖ | ✖ |
| **创建扩展项目** | ✔ | ✖ | ✖ | ✖ | ✖ |

> `admin` 列为**默认**状态；admin 经管理中心给自己加权限后，即等同于对应项目角色。

### 2.5 权限调整矩阵

| 操作者 | 被操作对象 | 允许范围 |
|---|---|---|
| **`admin`**（无论是否该项目 owner） | 任意 **owner** | ✖ 不可调整 —— owner 不可变更 |
| | 任意**非 owner** | ✔ 自由：`developer` / `viewer` / 非成员 |
| **普通用户 · owner** | 任意 **owner** | ✖ 不可调整 |
| | **`admin`** · 非 owner | ⚠ **只能提高、不能降低**：非成员→viewer/developer；viewer→developer 允许，反过来禁止 |
| | **普通用户** · 非 owner | ✔ 自由 |
| **普通用户 · 非 owner** | **只能操作自己** | ⚠ **只能降低、不能提高**：developer→viewer/非成员；viewer→非成员 |

**两条保护性设计**：① 普通用户-owner **不能降低 admin 的权限**（平台管理员不会被租户锁在项目外）；
② 普通用户-非 owner **只能降低自己**（相当于主动退出/降级，但不能自我提权）。

### 2.6 隐藏列表（与权限正交）

每个用户可**主动隐藏**自己看到的部分项目 —— **纯展示偏好，完全不影响其在项目中的权限**（仍能被 @、仍能被加权限）。

### 2.7 角色迁移（存量数据）

| 旧值 | 新值 | 数量 | 说明 |
|---|---|---|---|
| 系统 `developer` | → `user` | **6 人** | 已核实：这 6 人**一个扩展项目都没建过** → 零损失 |
| 项目 `manager` | → `developer` | 1 条 | 新模型只有 3 档，落到最高的非 owner 档 |
| 项目 `member` | → `developer` | 3 条 | 能力不变 |
| 项目 `owner` 记录行 | **删除** | 312 条 | owner 由 `projects.created_by` 决定，不入记录表 → 冗余行清理 |
| 项目 `viewer` | 不变 | 11 条 | 转为显式记录 |

### 2.8 代码改动点

| 位置 | 改动 |
|---|---|
| `schema.sql:33` | 系统角色 CHECK → `('admin','user')` |
| `schema.sql:122` | 项目角色 CHECK → `('developer','viewer','none')`（`none` = 显式排除） |
| `backend/repositories/users.ts:26,317`、`types/rows.ts:48` | 去 `developer` 类型 |
| `backend/routes/admin.ts:106-107` | `normalizeEmployeeRole` 只接受 `admin` / `user` |
| `backend/routes/projects.ts:2173` | 建扩展项目 → **仅 `admin`** |
| `backend/services/access-control.ts` **全项目读取路径** | **删掉 `if (user.role === 'admin') return true` 短路**；改为「显式记录 → 否则默认规则」两段式 |
| `services/access-control.ts` 新增 | ① `defaultRoleFor(user, project)` ② `effectiveRole(user, project)` ③ `canAdjustPermission(operator, target, project, to)` |
| `repositories/project-memberships.ts` | 角色集合改 3 档；owner 不再入表 |
| `services/session-context-sections.ts:155,161` | 角色渲染去掉"开发者"分支 |

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

**新增需求**：扩展项目（`kind='extension'`）的**读权限**要放开给普通用户，且**锁死只读** ——
当前完全没有这条规则（access-control 对 extension 零特殊处理）。

**整改**

| 编号 | 内容 |
|---|---|
| **B** | 新增**扩展项目例外**：非 `admin` 者恒按 `viewer` 对待 —— `canReadProject` 恒真、`canManageProject` 恒假、写操作恒假；**且禁止把 `user` 设为扩展项目的 `owner`/`developer`**（成员管理入口同步收口）。管理员在扩展项目中 ≡ `owner` |

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

## 4. 前端适配

> **性质**：前端改动只解决**用户体验**（不让用户点了才报错）。**真正的门禁是后端 A ~ Q** ——
> 前端一处不改也不影响安全；反过来，**只改前端等于没改**。
>
> **现状**：前端没有集中的权限逻辑，是「**后端下发标志、前端只管渲染**」的模式
> （例如 `issue.can_manage` 由后端算好下发）。本次**沿用并强化**，不另造一套规则。
>
> **规模**：约 6 个文件，集中在 4.1 / 4.2 / 4.3 三组。

> **完整菜单清单（逐项标注更改计划）见 HTML 版 §4.1**。以下为需要改动的细则。

### 4.2 用户创建与管理（系统角色：去 `developer`）

| 界面 | 文件 : 行 | 现状 | 要改成 |
|---|---|---|---|
| 用户列表 · 角色徽章（三色） | `panels.tsx:795`、`1142` | admin 琥珀 / developer 紫 / user 青 | 去掉紫档，两档 |
| 用户列表 · 角色文案 | `panels.tsx:803`、`1143` | 管理员 / **开发者** / 成员 | 去"开发者"；"成员"→**普通用户** |
| 新建用户 · 角色下拉 | `panels.tsx:1041` | 接受 admin/developer | 只 admin/user |
| 编辑用户 · 角色下拉 | `panels.tsx:407`、`1200` | 同上 | 同上 |
| 用户类型定义 | `panels.tsx:294`、`330` | `'user' \| 'developer' \| 'admin'` | `'user' \| 'admin'` |
| ⚠️ **命令文本解析（协议串）** | `panels.tsx:358-360` | 从命令里解析角色 token（含 developer） | **不擅自改** —— 需先确认外部调用方 |
| 用户组 | `panels.tsx:296-298`、`330`、`363-376` | group_id / group_name | **不受影响**（保留） |

### 4.2 项目权限配置（项目角色：四档 → 三档）

| 界面 | 文件 : 行 | 现状 | 要改成 |
|---|---|---|---|
| 项目团队面板 · 角色类型 | `ProjectTeamPanel.tsx:5` | `'owner'\|'manager'\|'member'\|'viewer'` | `'owner'\|'developer'\|'viewer'` |
| ├ 角色文案表 | `:25-29` | 负责人 / 项目管理员 / 项目成员 / 项目访客 | 负责人 / **项目开发者** / 项目访客 |
| ├ 可切换角色顺序 | `:33` | `['member','manager','viewer','owner']` | `['developer','viewer','owner']` |
| ├ 徽章配色表 | `:35-39` | 4 个键 | 3 个键 |
| ├ 筛选 Tab | `:45-48` | 负责人 / 管理员 / 成员 / 访客 | 负责人 / 开发者 / 访客 |
| └ 计数初始值 | `:61` | `{owner,manager,member,viewer}` | 3 个键 |
| 成员邀请 · 角色类型 | `project-member-invite.tsx:5` | `'viewer'\|'member'\|'manager'` | `'viewer'\|'developer'`（邀请不含 owner） |
| ├ 选项与提示 | `:17-19` | 成员(可读可写) / 管理员(可管理成员) / 访客(只读) | 开发者(可读可写) / 访客(只读) |
| ├ 筛选 Tab | `:26-28` | 管理员 / 成员 / 访客 | 开发者 / 访客 |
| └ 默认角色 | `:21` | `'member'` | `'developer'` |
| 项目设置 · 权限设置文案 | `ProjectSettingsPanel.tsx:846-847`、`898` | 写死 owner/manager/member/viewer | 改为 owner/developer/viewer |
| 项目可见性 | `ProjectSettingsPanel.tsx:91-92` | private / public（**已退役**） | 建议顺手清理 |

### 4.3 扩展项目（新增：普通用户锁死只读）

| 界面 | 文件 : 行 | 现状 | 要改成 |
|---|---|---|---|
| **新建项目 · 扩展项目入口** | `new-project-modal.tsx:98` | `role === 'admin' \|\| 'developer'` | **仅 `admin`** |
| **扩展项目内的运行入口** | `ProjectItemsPanel.tsx:89` | 只看 `kind === 'extension'` | 叠加**权限钳制**：普通用户隐藏写 / 跑入口 |

### 4.4 Skill / Memory 配置（基本不受影响）

| 界面 | 文件 | 现状 | 判断 |
|---|---|---|---|
| Skill 管理 | `components/skills.tsx` | scope 只有 user / project 两档 | **与角色模型正交，不用改** |
| Memory 管理 | `components/memories.tsx` | 同上 | **不用改** |
| 上下文项访问配置弹窗 | `components/context-access.tsx:15,55,81-82` | 只有创建者（全权）+ 访客（可读可用不可改）；访客即 `allow_user_ids` | **与项目角色正交**，是否调整**待定** |
| ContextPanel 角色文案 | `pages/ContextPanel.tsx:130` | `role==='admin' ? '管理员' : '成员'` | 文案"成员"→"普通用户" |

### 4.5 其它（不受影响）

管理中心入口 `shell.tsx:1510`、管理员按钮 `ProjectSettingsPanel.tsx:880` —— 均为 `role === 'admin'`，不受影响。

### 4.6 配套后端改动：R　下发统一「权限块」

后端在各返回体（项目 / 会话 / 问题 / 研究）附带由 `access-control.ts` **同一批函数**算出的结果：

```json
"permissions": {
  "effective_role": "viewer",      // 扩展项目里 user 恒为 viewer（钳制在此实现）
  "can_read": true, "can_write_files": false, "can_run_session": false,
  "can_manage_members": false, "can_manage_project": false, "can_delete": false
}
```

外加全局的 `me.permissions.can_create_extension_project`。
**关键**：扩展项目「`user` 锁死 viewer」的钳制**只在这一处实现**，前端各处判断自然跟着对。

### 4.7 建议：角色枚举收口

当前项目角色在 **3 个文件各写一份**（TeamPanel / member-invite / SettingsPanel 文案），系统角色在 2 处。
建议新增 `frontend/src/constants/roles.ts`：角色集合、标签、配色、选项**只在这里定义**，三处引用。
本次改动量再降一半，以后也不会漏。

### 4.8 验证

按简易模式 SOP：改码 → playwright 截图（`127.0.0.1:45618`，`fuqingxu/fuqingxu`）→ `display_images` 展示 →
不满足则重来 → 通过后 `python3 start.py` 部署。

重点验证三个界面：① 项目团队面板角色下拉只剩 owner/developer/viewer；
② 用户管理面板系统角色只剩 管理员/普通用户；③ 扩展项目页面以普通用户登录，写 / 跑入口全部消失。

---

## 5. 整改清单（汇总）

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
| **R** | 接口 | 后端下发统一「权限块」（项目 / 会话 / 问题 / 研究各返回体） | 功能 |
| **S** | 前端 | 前端适配：角色集合与文案、扩展项目只读钳制、角色枚举收口 | 功能 |
| **T** | 权限 | 「**默认规则 + 显式记录**」两段式判定；**删掉 admin 短路**；owner 不入表 | 🔴 安全 |
| **U** | 权限 | **权限调整矩阵** + 管理中心新增「**用户与权限**」Tab | 🔴 安全 |
| **V** | 前端 | **隐藏列表**（用户级展示偏好，与权限正交） | 功能 |

---

## 6. 已拍板的策略边界

| # | 决策 | 影响 |
|---|---|---|
| 1 | 项目创建者对项目内**所有**会话有全部权限 | **保持现状**，不改 `canOperateSession` |
| 2 | 扩展项目：**默认** 创建者 owner、**其他人 viewer**（对普通用户可见）；不可被提升 | 见 §2.2 / **B** |
| 10 | 系统角色简化为 `admin` / `user`（取消 `developer`） | 见 §2.6；迁移见 §2.5 |
| 11 | 项目内角色简化为 `owner` / `developer` / `viewer`（取消 `manager` / `member`） | 见 §2.6 |
| 12 | ~~`admin` 对所有项目拥有 `owner` 同等权限~~ **已作废**：admin 也走默认规则，但可去管理中心给自己加权限 | 见 §2.2 / **T** |
| 13 | 仅 `admin` 可创建扩展项目 | 见 §2.8 |
| 14 | **默认权限规则**：扩展→其他人 viewer；普通→其他人非成员 | 见 §2.2 |
| 15 | **显式记录优先，否则默认规则** | 见 §2.3 / **T** |
| 16 | **权限调整矩阵** | 见 §2.5 / **U** |
| 17 | 隐藏列表：纯展示偏好，**不影响权限** | 见 §2.6 / **V** |
| 18 | 管理中心**新增「用户与权限」Tab** | 见 §4.6 / **U** |
| 3 | 只读成员：**不能对话、不能改删文件** | 见 C、D |
| 4 | `bindPathManual` 普通用户堵掉、仅管理员保留 | 见 A |
| 5 | 公用 `/tmp`、`~/.claude` 隔离**延后** | 见 §6 |
| 6 | 被移出项目者：彻底断权（**含自己创建的会话**） | 见 E |
| 7 | 沙盒按「**会话归谁**」判定 | 见 N |
| 8 | 管理员不套沙盒；普通用户强制套 | 见 P |
| 9 | 沙盒不可用 → 回退「不允许创建普通用户」 | 见 Q |

---

## 7. 已知并接受的缺口（延后，不阻塞本轮）

| 缺口 | 后果 |
|---|---|
| 公用 `/tmp` | Agent 可读 `/tmp/tmux-<uid>/` 插座（跨用户偷看 AI 面板）；该插座同时是"指挥沙盒外进程"的通道 |
| 公用 `~/.claude` | 任一 Agent 可读**全体用户的提问历史、会话转录、凭据** |
| Agent 与后端同 uid | 应用层是唯一防线，无 OS 级兜底 |
| Landlock 不可限制面 | `chmod` / `stat` / `chdir` 等（内核 man page CAVEATS 明载） |
| 无自定义错误话术 | 被拦时只有 `Permission denied`，无法从错误码区分沙盒 |

---

## 8. 分阶段与验收

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
