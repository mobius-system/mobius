# Mobius HTTP API 指南

本文件是 `skills/mobius-assistant/SKILL.md` 的补全. `SKILL.md` 讲"小莫是谁、能做什么事", 本文件讲"怎么用 HTTP API 把它落到能调用的请求上".

## 1. 通用约定

### 1.1 基础地址
- 后端监听在 `MOBIUS_PORT`(默认 `45614`), Vite 前端在 `VITE_PORT`(默认 `45616`). Debug 启动后所有 API 通过 `http://localhost:${MOBIUS_PORT}` 访问.
- 文档里出现的 `${BASE}` 即 `http://localhost:45614`, 在你自己的环境里请用实际的端口替换.
- 后端路由统一以 `/api/...` 开头. 仅 `/code-server/...` 与 `/extension/...` 例外.

### 1.2 鉴权
- 登录后端会签发 JWT, 有效期 7 天, 返回字段叫 `token`. 把它写到所有非公开请求的 `Authorization: Bearer <token>` 头里.
- 部分下载类接口(SSE, 文件下载)允许把 token 放在 query string 上(`?token=<token>`), 详见每条接口的"鉴权"一栏.
- 管理员专属接口(`/api/admin/*`)在 `auth` 中间件之上再加 `req.user.role === 'admin'`, 非管理员用户会拿到 403.

### 1.3 错误返回
- 大部分路由失败时返回 `{ "error": "<中文说明>" }`, 状态码语义沿用 HTTP 约定(400 参数错, 401 未登录, 403 无权, 404 不存在, 409 冲突, 500 内部错误).
- 文件类接口可能返回 413(超过大小限制)或 502/504(后端执行失败/超时).

### 1.4 复用一个 token
- 整个文档里用 `${TOKEN}` 引用登录返回的 token. 如果你用 `bash` 测试, 可以先 `export TOKEN=$(curl ... | jq -r .token)`, 后续命令直接 `${TOKEN}` 引用即可.

### 1.5 关于 `authOrQuery` 与 SSE
- `/api/sessions/:id/events` 是 Server-Sent Events 端点, 用 `curl -N` 拉流. 鉴权允许 `Authorization` 头或 `?token=` query.

---

## 2. 完整 API 清单(按 mount 路径分组)

### 2.1 鉴权 `/api/auth`

- **`GET /api/auth/config`** — 公共接口, 查看后端是否启用密码登录.
  ```bash
  curl -sS "${BASE}/api/auth/config"
  ```

- **`POST /api/auth/login`** — 拿 token.
  ```bash
  curl -sS -X POST "${BASE}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"alice","password":"your_password"}'
  ```

- **`GET /api/auth/me`** — 用 token 拿当前登录用户.
  ```bash
  curl -sS "${BASE}/api/auth/me" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/auth/change-password`** — 改密码.
  ```bash
  curl -sS -X POST "${BASE}/api/auth/change-password" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"old_password":"old123456","new_password":"new123456"}'
  ```

- **`GET /api/auth/branding`** — 公共接口(无 auth), 返回全站品牌配置, 供登录页首屏渲染. 字段 `{ hideLogo, systemNameZh, systemNameEn, hiddenFolderName, appDir }`.
  ```bash
  curl -sS "${BASE}/api/auth/branding"
  ```

- **`GET /api/auth/user-search?q=<关键字>`** — 资源访问面板的用户选择器, 按关键字返回最多 12 个活跃用户 `{ id, display_name, role }`. `q` 为空时返回前 12 条.
  ```bash
  curl -sS "${BASE}/api/auth/user-search?q=ali" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/auth/users-by-id`** — 一次性按 id 数组反查用户信息(上限 64, 超出截断, 去重去空). Body `{ "ids": ["alice","bob"] }`.
  ```bash
  curl -sS -X POST "${BASE}/api/auth/users-by-id" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"ids":["alice","bob"]}'
  ```

### 2.2 健康 `/api/health`

- **`GET /api/health`** — 后端 + agent bridge 状态(无 auth).
  ```bash
  curl -sS "${BASE}/api/health"
  ```

- **`GET /api/health/memory`** — 服务器内存占用(60s 缓存).
  ```bash
  curl -sS "${BASE}/api/health/memory"
  ```

- **`GET /api/v2/health`** — 元信息:版本、git commit、启动时间、uptime.
  ```bash
  curl -sS "${BASE}/api/v2/health"
  ```

- **`GET /api/v2/hello`** — 健康冒烟测试.
  ```bash
  curl -sS "${BASE}/api/v2/hello"
  ```

- **`GET /api/v2/db-check`** — 数据库表行数(无 auth).
  ```bash
  curl -sS "${BASE}/api/v2/db-check"
  ```

### 2.3 文件与工作区 `/api/files`

- **`POST /api/files/upload`** — `multipart/form-data`, 字段名 `file`. 落到 `<work_dir>/uploads/<原文件名>`.
  ```bash
  curl -sS -X POST "${BASE}/api/files/upload" \
    -H "Authorization: Bearer ${TOKEN}" \
    -F "file=@/path/to/local.txt"
  ```

- **`GET /api/files/download?path=<abs>`** — 下载. 鉴权支持 `Authorization` 头或 `?token=` query.
  ```bash
  curl -sS -OJ "${BASE}/api/files/download?path=/home/alice/work/report.pdf" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/files/files?path=<rel>&scope=shared|user`** — 列目录. 不传 `scope` 默认查用户 `work_dir`; 传 `scope=shared` 切到共享 skill 库.
  ```bash
  curl -sS "${BASE}/api/files/files?path=/imac-demo" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/files/files/mkdir`** — 在 `work_dir` 下递归建目录. Body `{ "path": "/imac-demo/new-dir" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/files/files/mkdir" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"path":"/imac-demo/new-dir"}'
  ```

- **`GET /api/files/files/read?path=<rel>&scope=shared|user`** — 读文本(>1MB 拒绝). 图片返回 `{ type: "image", url: "/api/download?path=..." }`.
  ```bash
  curl -sS "${BASE}/api/files/files/read?path=/notes.md" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`PUT /api/files/files/write?scope=shared`** — 仅允许编辑共享 skill 库(`scope` 必须是 `shared`). Body `{ "path": "/<rel>", "content": "..." }`. 写入前自动备份原文件.
  ```bash
  curl -sS -X PUT "${BASE}/api/files/files/write?scope=shared" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"path":"/skills/my-skill/SKILL.md","content":"---\nname: my-skill\n---\nbody"}'
  ```

### 2.4 项目 `/api/projects`

- **`GET /api/projects`** — 当前用户可见项目列表.
  ```bash
  curl -sS "${BASE}/api/projects" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/projects`** — 新建项目. Body 字段:
  - `name` 必填;
  - `description` 选填;
  - `bindPath` 必填(项目要绑的服务器目录);
  - `bindPathManual` 选填, `true` = 不校验路径存在/在 work_dir 内(给老项目兜底);
  - `gitRepos` 选填, 形如 `[{ "url": "https://...", "name": "repo" }]`;
  - `defaultUseWorktree` 选填, 默认 `true`;
  - `researchEnabled` 选填, 默认 `false`. 一旦 `true` 强制 `defaultUseWorktree=false`;
  - `visibility` 选填, `private|users|groups|public`, 默认 `private`;
  - `allow_user_ids` / `allow_group_ids` / `deny_user_ids` / `deny_group_ids` 选填, 配合 visibility;
  - `guidedDemoKind` 选填, 演示项目专用.
  ```bash
  curl -sS -X POST "${BASE}/api/projects" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "name": "imac-demo",
      "description": "演示项目",
      "bindPath": "/imac-demo",
      "gitRepos": [{"url": "https://github.com/example/repo.git"}],
      "defaultUseWorktree": true,
      "researchEnabled": false,
      "visibility": "private"
    }'
  ```

- **`DELETE /api/projects/:id`** — 管理员硬删. Body `{ "password": "...", "confirm": "<项目名或 id>" }`. 也支持 `cleanup_demo_workspace: true` 同步删演示工作区.
  ```bash
  curl -sS -X DELETE "${BASE}/api/projects/abc12345" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"password":"admin_pwd","confirm":"imac-demo","cleanup_demo_workspace":true}'
  ```

- **`POST /api/projects/:id/hide`** — 当前用户隐藏(对拓展项目 = 仅隐藏卡片, 数据不动).
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/hide" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/projects/:id/unhide`** — 取消隐藏.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/unhide" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`PATCH /api/projects/:id/star`** — 设置星标. Body `{ "starred": true|false }`.
  ```bash
  curl -sS -X PATCH "${BASE}/api/projects/abc12345/star" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"starred": true}'
  ```

- **`PATCH /api/projects/:id`** — 修改项目设置. 字段任意组合:
  - `name` / `description` / `visibility` 文本字段;
  - `bindPath` + `bindPathManual` 切换绑定路径;
  - `gitRepos` 替换 git 仓库数组;
  - `defaultUseWorktree` / `researchEnabled` 互斥规则见 `POST /api/projects`;
  - `forgottenFlagMessage` / `forgottenFlagIssueIntervalMinutes` / `forgottenFlagResearchIntervalMinutes` 管理员级别的"被遗忘 flag"提醒;
  - `allow_user_ids` / `allow_group_ids` / `deny_user_ids` / `deny_group_ids` 权限白/黑名单.
  ```bash
  curl -sS -X PATCH "${BASE}/api/projects/abc12345" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "description": "新描述",
      "defaultUseWorktree": false,
      "forgottenFlagIssueIntervalMinutes": 30
    }'
  ```

- **`GET /api/projects/:id/git-tracking?limit=<n>`** — 项目 git 追踪快照.
  ```bash
  curl -sS "${BASE}/api/projects/abc12345/git-tracking?limit=20" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/projects/:id/deploy-version`** — 仅 Mobius 自迭代项目;管理员限定. Body `{ "git_hash": "<7-40 位 commit>" }` 或 `{ "hash": ... }` / `{ "commit": ... }`.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/self/deploy-version" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"git_hash":"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"}'
  ```

- **`POST /api/projects/:id/hard-reset-version`** — 同上,但 `git_hash` 之前所有版本会被备份到 `discard/<timestamp>` 分支.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/self/hard-reset-version" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"git_hash":"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"}'
  ```

- **`GET /api/projects/:id/architecture-session-preset/context-preview`** 与 **`POST /api/projects/:id/architecture-session-preset/context-preview`** — 项目架构图 Session 预览. 接受 GET query 或 POST JSON: `name` / `description` / `excluded_skill_ids` / `excluded_memory_ids` / `language`.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/architecture-session-preset/context-preview" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"扫描项目结构","description":"读各模块入口并整理依赖","language":"zh"}'
  ```

- **`GET /api/projects/:id/architecture-session-preset/session-selection-defaults`** — 默认勾选 Skill/Memory 集合.
  ```bash
  curl -sS "${BASE}/api/projects/abc12345/architecture-session-preset/session-selection-defaults" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/projects/:id/architecture-issue`** — 在项目下创建"梳理架构"专用 Issue.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/architecture-issue" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/projects/:id/architecture-figure`** — 取项目结构图(`arch.png` / `arch.svg` / `arch.jpg`). 返回图片二进制.
  ```bash
  curl -sS -o arch.png "${BASE}/api/projects/abc12345/architecture-figure" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/projects/:id/user-context-whitelist`** — 当前用户在该项目的 Skill/Memory 白名单.
  ```bash
  curl -sS "${BASE}/api/projects/abc12345/user-context-whitelist" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`PATCH /api/projects/:id/user-context-whitelist`** — 设置白名单. Body:
  - `skill_whitelist_enabled` / `builtin_skill_whitelist_enabled` / `memory_whitelist_enabled` 三个布尔开关;
  - `skill_ids` / `builtin_skill_ids` / `memory_ids` 对应 ID 数组(开关关闭时传 `null` 表示"全部允许").
  ```bash
  curl -sS -X PATCH "${BASE}/api/projects/abc12345/user-context-whitelist" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "skill_whitelist_enabled": true,
      "skill_ids": ["skill-uuid-1","skill-uuid-2"],
      "memory_whitelist_enabled": false
    }'
  ```

- **`POST /api/projects/:id/guided-demo/import/clear-upload-sample`** — 清理导入演示项目里上传的样例.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/guided-demo/import/clear-upload-sample" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/projects/:id/files?path=<rel>`** — 列项目 `bind_path` 下文件, 同时返回 `vscode_web_url` / `bind_path_writable` / `cs_url_token_required`.
  ```bash
  curl -sS "${BASE}/api/projects/abc12345/files?path=/" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/projects/:id/file/download?path=<rel>`** — 流式下载 `bind_path` 下单个文件 (原生文件编辑器右键"下载"). 只读, 拒绝符号链接与目录; `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`. 错误体 `{ error, code }`, code: `NOT_FOUND` / `SYMLINK_UNSUPPORTED` / `OUTSIDE_ROOT` / `INVALID_NAME`.
- **`POST /api/projects/:id/files/copy`** — 同项目内复制文件/目录. Body `{ "sourcePath": "/a/x.pdf", "targetDir": "/b" }`. 拒绝符号链接(含中间目录)、目录复制到自身/子目录; 同名返回 409 `{ error, code: "CONFLICT" }` (不静默覆盖); 目录异步递归复制带上限(文件数/大小/深度), 失败清理半成品. 返回 `{ sourcePath, path, type, copied }`.
- **`POST /api/projects/:id/files/rename`** — 重命名文件/目录. Body `{ "path": "/a/x.pdf", "newName": "y.pdf" }`. 拒绝根目录/符号链接/非法名(含 `/` `\` 控制符 `.` `..` 保留名)/同名冲突(409). 返回 `{ oldPath, path, name, renamed }`. 写操作均校验项目可读 + `bind_path` 可写 + 目标父目录 W_OK.

- **`GET /api/projects/overview?ids=<id,id>&limit=<n>`** — 批量查多个项目的 issue/research 计数与概览条目(`ids` 逗号分隔或数组; `limit` 每项条数 1–20). 无读权限或被隐藏的项目自动跳过.
  ```bash
  curl -sS "${BASE}/api/projects/overview?ids=abc12345,def67890&limit=5" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/projects/:id/sessions-overview?issue_ids=<id,id>`** — 查指定项目下若干 issue/research 的活跃会话预览(还接受 `research_ids` / `preview_limit`).
  ```bash
  curl -sS "${BASE}/api/projects/abc12345/sessions-overview?issue_ids=iss12345" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/projects/search?q=<关键词>&limit=<n>`** — 按关键词搜当前用户可见的项目.
  ```bash
  curl -sS "${BASE}/api/projects/search?q=demo&limit=20" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/projects/view-prefs`** / **`PATCH /api/projects/view-prefs`** — 当前用户的项目视图偏好; PATCH Body `{ "hide_others_projects": true|false }`(也接受驼峰 `hideOthersProjects`).

- **`GET /api/projects/muted`** — 当前用户已静音的项目列表.

成员管理(列表/候选只需读权限, 增删改需项目管理权限 `canManage`):

- **`GET /api/projects/:id/members`** — 成员列表 + 计数 + 当前用户的管理能力(`can_manage` / `actor_role`).
- **`GET /api/projects/:id/member-candidates?q=<关键字>`** — 搜索可加为成员的员工(前缀匹配 id/display_name, 最多 30 条, 仅返回脱敏字段).
- **`POST /api/projects/:id/members`** — 批量加成员. Body `{ "user_ids": ["..."], "role"?: "member|owner"(owner 仅项目负责人/管理员) }`.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/members" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"user_ids":["bob","carol"],"role":"member"}'
  ```
- **`PATCH /api/projects/:id/members/:userId`** — 改成员角色. Body `{ "role": "<新角色>" }`.
- **`DELETE /api/projects/:id/members/:userId`** — 移除成员(移除 owner 需项目负责人/管理员).

- **`POST /api/projects/:id/mute`** / **`POST /api/projects/:id/unmute`** — 静音/取消静音(同时写 hidden 状态).

- **`POST /api/projects/:id/git-action`** — 在项目仓库执行 Git 操作. Body `{ "action": "status|log|pull|push|..." }`. 需 `canManage`.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/git-action" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"action":"status"}'
  ```

项目待办(列表只需读权限, 增删改需 `canManage`):

- **`GET /api/projects/:id/todos`** — 待办列表 `{ items: [...] }`.
- **`POST /api/projects/:id/todos`** — 新建. Body `{ "title": "<必填>", "description"?: "...", "completed"?: false, "sort_order"?: <n> }`.
- **`PATCH /api/projects/:id/todos/:todoId`** — 更新(部分字段: `title` / `description` / `completed` / `sort_order`).
- **`DELETE /api/projects/:id/todos/:todoId`** — 删除.
- **`PUT /api/projects/:id/todos/reorder`** — 重排. Body `{ "ids": ["<有序 id 数组>"] }`.

打包下载(只需读权限):

- **`GET /api/projects/:id/package/items`** — 列出可打包的文件条目.
- **`POST /api/projects/:id/package/estimate`** — 估算选中文件打包大小. Body `{ "names": ["..."] }`.
- **`POST /api/projects/:id/package/download`** — 打包下载(响应为 zip 流). Body `{ "names": ["..."] }`.

远程算力文件(只需读权限; `remote` 必须在项目 aimux 清单内):

- **`GET /api/projects/:id/remote-file-sources`** — 项目注册的远程机器清单.
- **`GET /api/projects/:id/remote-files?remote=<name>&path=</>`** — 列远程目录.
- **`GET /api/projects/:id/remote-file?remote=<name>&path=<file>`** — 读远程单个文件.
- **`POST /api/projects/:id/remote-file`** — 写远程单个文件. Body `{ "remote": "<name>", "path": "<file>", "content": "..." }`.

项目文件读写(原生文件编辑器用; 只读项目可读不可写):

- **`GET /api/projects/:id/file?path=<rel>`** — 读 `bind_path` 下单个文件(>1.5MB 截断并标 `truncated`).
- **`POST /api/projects/:id/file`** — 覆盖保存已存在文件(不新建). Body `{ "path": "<rel>", "content": "<≤5MB>" }`.
- **`POST /api/projects/:id/import-zip`** — 上传 zip/tar 解压导入 `bind_path`(`multipart` 字段 `file`). 需 `canManage`.
- **`POST /api/projects/:id/files/move`** — 移动. Body `{ "sourcePath": "/a/x", "targetDir": "/b" }`.
- **`POST /api/projects/:id/files/mkdir`** — 建目录. Body `{ "parentPath"?: "/", "name": "<新目录名>" }`.
- **`POST /api/projects/:id/files/create`** — 建空文件(已存在返回 409). Body `{ "parentPath"?: "/", "name": "<新文件名>" }`.
  > 文件写操作同名冲突统一返回 409 `{ error, code: "CONFLICT" }`, 不静默覆盖; 均防路径穿越与符号链接.

端口转发(读只需读权限, 写端口需可写 + bind_path):

- **`GET /api/projects/:id/main-project-port`** — 读项目主端口 `{ port, valid, exists }`.
- **`POST /api/projects/:id/main-project-port`** — 保存主端口. Body `{ "port": <1–65535> }`.
- **`GET /api/projects/:id/ssh-forward-config`** — SSH 端口转发配置(读环境变量与私钥, 返回 `enabled/host/port/user/private_key`).

### 2.5 任务单 `/api/issues` 与 `/api/projects/:projectId/issues`

项目维度(`/api/projects/:projectId/issues`):

- **`GET /api/projects/:projectId/issues?status=active|completed`** — 项目下 Issue 列表.
  ```bash
  curl -sS "${BASE}/api/projects/abc12345/issues?status=active" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/projects/:projectId/issues`** — 新建 Issue. Body:
  - `title` 必填;
  - `description` 必填;
  - `use_worktree` 选填, 默认取项目 `default_use_worktree`;
  - `worktree_branch` 选填, 留空用 issue id 当分支名;
  - `visibility` / `allow_user_ids` / `allow_group_ids` / `deny_user_ids` / `deny_group_ids` 选填.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/issues" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "title": "梳理项目结构",
      "description": "读各模块入口并整理依赖图",
      "use_worktree": true,
      "worktree_branch": "scan-arch"
    }'
  ```

Issue 维度(`/api/issues`):

- **`GET /api/issues/:id`** — 单个 Issue 详情.
  ```bash
  curl -sS "${BASE}/api/issues/iss12345" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/issues/:id/skills`** — Issue 可见的 Skill(`available` / `selected` / `excluded` / `effective`).
  ```bash
  curl -sS "${BASE}/api/issues/iss12345/skills" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`PATCH /api/issues/:id`** — 改 Issue. 字段:
  - `title` / `description` / `status`(仅 `active|completed`);
  - `pinned` 布尔;
  - `selected_skills` / `excluded_skills` 数组, 字符串 ID;
  - `visibility` / `allow_user_ids` / `allow_group_ids` / `deny_user_ids` / `deny_group_ids`.
  ```bash
  curl -sS -X PATCH "${BASE}/api/issues/iss12345" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "description": "更新描述",
      "selected_skills": ["builtin:mobius-assistant","skill-uuid-2"]
    }'
  ```

- **`GET /api/issues/:id/context-preview`** 与 **`POST /api/issues/:id/context-preview`** — 预览 Session 注入上下文. 接受 GET query 或 POST JSON: `name` / `description` / `excluded_skill_ids` / `excluded_memory_ids` / `language`.
  ```bash
  curl -sS -X POST "${BASE}/api/issues/iss12345/context-preview" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "name": "扫描",
      "description": "读各模块入口",
      "excluded_skill_ids": [],
      "excluded_memory_ids": ["mem-uuid-1"],
      "language": "zh"
    }'
  ```

- **`GET /api/issues/:id/session-selection-defaults`** — 新 Session 勾选默认.
  ```bash
  curl -sS "${BASE}/api/issues/iss12345/session-selection-defaults" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/issues/:id/complete`** — 标记完成.
  ```bash
  curl -sS -X POST "${BASE}/api/issues/iss12345/complete" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`DELETE /api/issues/:id`** — 删 Issue.
  ```bash
  curl -sS -X DELETE "${BASE}/api/issues/iss12345" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/issues/:id/skills`** — Issue 视角可见的 skill 列表(用户级 ∪ 项目级), 含 `available` / `selected` / `excluded` / `effective`.
  ```bash
  curl -sS "${BASE}/api/issues/iss12345/skills" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/issues/:id/knowledge/content`** — 读 Issue 级任务知识文件内容(项目须有 bind_path; 不存在返回 `{ ok, content:'', exists:false }`).
  ```bash
  curl -sS "${BASE}/api/issues/iss12345/knowledge/content" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/issues/:id/knowledge/upload`** — 写入/覆盖 Issue 级任务知识. Body `{ "content": "<正文, 去空格后非空>" }`. 需 `canManageIssue`.
  ```bash
  curl -sS -X POST "${BASE}/api/issues/iss12345/knowledge/upload" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"content":"# 任务知识\n\n本 issue 要修复 ..."}'
  ```

- **`PATCH /api/issues/:id/star`** — 当前用户对该 issue 的个人收藏(区别于项目级 `pinned`). Body `{ "starred": true|false }`.
  ```bash
  curl -sS -X PATCH "${BASE}/api/issues/iss12345/star" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"starred":true}'
  ```

### 2.6 Research `/api/researches` 与 `/api/projects/:projectId/researches`

> Research 系统需要项目设置 `research_enabled=1`, 并且会自动关闭该项目的 `defaultUseWorktree`.

项目维度(`/api/projects/:projectId/researches`):

- **`GET /api/projects/:projectId/researches?status=active|completed`** — Research 列表.
  ```bash
  curl -sS "${BASE}/api/projects/abc12345/researches?status=active" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/projects/:projectId/researches`** — 新建 Research. Body: `title` / `description` 必填; `visibility` 等可选.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/researches" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "title": "对比 3 种 LLM Agent 框架",
      "description": "从架构、易用性、性能三个维度比较"
    }'
  ```

Research 维度(`/api/researches`):

- **`GET /api/researches/:id`** — Research 详情.
  ```bash
  curl -sS "${BASE}/api/researches/res12345" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`PATCH /api/researches/:id`** — 改 Research. 字段同 Issue.
  ```bash
  curl -sS -X PATCH "${BASE}/api/researches/res12345" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"description":"更新范围","pinned":true}'
  ```

- **`GET /api/researches/:id/context-preview`** 与 **`POST /api/researches/:id/context-preview`** — Session 上下文预览. 字段同 Issue, 多一个 `role`(`chief_researcher` 或 `research_assistant`).
  ```bash
  curl -sS -X POST "${BASE}/api/researches/res12345/context-preview" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "name": "chief 探索",
      "description": "主研究员开场",
      "role": "chief_researcher",
      "excluded_skill_ids": [],
      "excluded_memory_ids": [],
      "language": "zh"
    }'
  ```

- **`GET /api/researches/:id/session-selection-defaults`** — 默认勾选.
  ```bash
  curl -sS "${BASE}/api/researches/res12345/session-selection-defaults" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/researches/:id/research-agent-skills`** — 该 Research 可用 agent skill(`research-` 前缀且 frontmatter 含 `research_role`).
  ```bash
  curl -sS "${BASE}/api/researches/res12345/research-agent-skills" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/researches/:id/complete`** — 标记完成.
  ```bash
  curl -sS -X POST "${BASE}/api/researches/res12345/complete" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

Research Session `/api/researches/:researchId/sessions`:

- **`GET /api/researches/:researchId/sessions`** — Research 下的 Session 列表.
  ```bash
  curl -sS "${BASE}/api/researches/res12345/sessions" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/researches/:researchId/sessions`** — 新建 Research Session(不自动启动). Body:
  - `name` 必填;
  - `description` 选填;
  - `role` 必填, `chief_researcher` 或 `research_assistant`(`chief_researcher` 一个 Research 只允许一个);
  - `model` / `language` 选填, `language` 仅 `zh|en`;
  - `excluded_skill_ids` / `excluded_memory_ids` 选填;
  - `suppress_join_notice` 选填, `true` = 不在 blackboard 写"加入团队"通知.
  ```bash
  curl -sS -X POST "${BASE}/api/researches/res12345/sessions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "name": "主研究员",
      "description": "统筹研究方向",
      "role": "chief_researcher",
      "model": "codex",
      "language": "zh",
      "excluded_skill_ids": [],
      "excluded_memory_ids": []
    }'
  ```

Blackboard `/api/research-blackboard`:

- **`GET /api/research-blackboard/:researchId`** — 读取 blackboard 文件(可由 agent 直接 curl,无 auth). 返回 `application/x-ndjson`.
  ```bash
  curl -sS "${BASE}/api/research-blackboard/res12345" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/research-blackboard/:researchId`** — 追加一条 blackboard 记录. Body: `author`(必填)/ `content`(必填)/ `metadata`(对象,可选).
  ```bash
  curl -sS -X POST "${BASE}/api/research-blackboard/res12345" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "author": "research_assistant:ses12345",
      "content": "已完成 3 篇论文摘要整理, 结论见 blackboard 末尾",
      "metadata": {"event": "summary_posted","ref":"arxiv.org/abs/2501.00001"}
    }'
  ```

Research Graph `/api/research-graph`:

- **`GET /api/research-graph/:researchId`** — 读取 `research-graph.yml`, 转成 `{ nodes, edges, file }` JSON.
  ```bash
  curl -sS "${BASE}/api/research-graph/res12345" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/research-graph/:researchId/image?path=<相对 graph 文件的相对路径>`** — 取图里引用的图片. 鉴权走 `downloadAuth`, 支持 `?token=` query.
  ```bash
  curl -sS -OJ "${BASE}/api/research-graph/res12345/image?path=figures/diagram.png" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

### 2.7 执行会话 `/api/sessions` 与 `/api/issues/:issueId/sessions`

全局 Session(`/api/sessions`):

- **`GET /api/sessions/prompt-stats`** — 5h 提问聚合 + tmux 窗口活跃数(给前端 NewSessionModal 显示模型负载).
  ```bash
  curl -sS "${BASE}/api/sessions/prompt-stats" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/sessions/model-options`** — 当前用户可用的模型选项.
  ```bash
  curl -sS "${BASE}/api/sessions/model-options" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`PATCH /api/sessions/:id`** — 改 Session 名称或状态(`active|completed|archived`).
  ```bash
  curl -sS -X PATCH "${BASE}/api/sessions/ses12345" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"新名字","status":"archived"}'
  ```

- **`DELETE /api/sessions/:id`** — 永久删除. Body 可选 `notify_others: true`, Research Session 会在 blackboard 写"已离开团队"通知.
  ```bash
  curl -sS -X DELETE "${BASE}/api/sessions/ses12345" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"notify_others":true}'
  ```

- **`DELETE /api/sessions/:id/permanent`** — 同上,别名.
  ```bash
  curl -sS -X DELETE "${BASE}/api/sessions/ses12345/permanent" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/sessions/:id/terminate`** — 优雅终止正在执行的后台 agent.
  ```bash
  curl -sS -X POST "${BASE}/api/sessions/ses12345/terminate" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/sessions/:id/stop`** — 给后台 agent 发 `C-c × 3`,软停.
  ```bash
  curl -sS -X POST "${BASE}/api/sessions/ses12345/stop" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/sessions/:id/events`** — SSE 流:首包 `connected` / `subscribed` / `history` / `jsonl_meta` / `jsonl_history`, 之后 `jsonl_entry` / `typing` / `server_error`. 鉴权支持 `Authorization` 头或 `?token=` query. `?full=1` 让 jsonl 一次性回灌完整历史(默认只灌末尾 DEFAULT_HISTORY_TAIL 条).
  ```bash
  curl -N "${BASE}/api/sessions/ses12345/events" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/sessions/:id/jsonl-history?from=<idx>&limit=<n>`** — 拉指定窗口 jsonl,给"展开全部"补齐用.
  ```bash
  curl -sS "${BASE}/api/sessions/ses12345/jsonl-history?from=0&limit=200" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/sessions/:id/status`** — 进程存活 + PID + 任务标记 + worktree 状态.
  ```bash
  curl -sS "${BASE}/api/sessions/ses12345/status" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/sessions/:id/turns`** — 按 turn 聚合的消息列表.
  ```bash
  curl -sS "${BASE}/api/sessions/ses12345/turns" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/sessions/:id/inputs`** — 用户输入回放(从 `<bind_path>/.imac/inputs/<sessionId>.jsonl` 读,DB 兜底合并).
  ```bash
  curl -sS "${BASE}/api/sessions/ses12345/inputs" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/sessions/:id/context-preview`** — 预览 Session 上下文(快照优先, 没快照就实时构建).
  ```bash
  curl -sS "${BASE}/api/sessions/ses12345/context-preview" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/sessions/:id/selection-snapshot`** — Session 右栏 Skill/Memory 快照(`source: created | context | live`).
  ```bash
  curl -sS "${BASE}/api/sessions/ses12345/selection-snapshot" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/sessions/:id/messages`** — 给 Session 发一条用户消息,启动新一轮(自动落到对应 backend). Body:
  - `content` 必填;
  - `input_text` 选填, 用户原始输入(可与 content 不同,给 jsonl 留底);
  - `request_id` 选填, 给前端做幂等.
  ```bash
  curl -sS -X POST "${BASE}/api/sessions/ses12345/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "content": "请扫一遍 mobius/extension/finance-news-wall 并告诉我结构",
      "input_text": "请扫一遍 mobius/extension/finance-news-wall 并告诉我结构",
      "request_id": "client-req-001"
    }'
  ```

Issue 维度(`/api/issues/:issueId/sessions`):

- **`GET /api/issues/:issueId/sessions`** — Issue 下 Session 列表(带 `job_accomplished` / `job_failed` 标记).
  ```bash
  curl -sS "${BASE}/api/issues/iss12345/sessions" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/issues/:issueId/sessions`** — 在 Issue 下创建 Session(不自动启动). Body:
  - `name` 必填;
  - `description` 选填;
  - `model` 选填(支持前端短键 `codex` / `opus` / `sonnet` 或管理员白名单 key);
  - `language` 选填, `zh|en`;
  - `excluded_skill_ids` / `excluded_memory_ids` 选填.
  ```bash
  curl -sS -X POST "${BASE}/api/issues/iss12345/sessions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "name": "扫描项目结构",
      "description": "读各模块入口并整理依赖图",
      "model": "codex",
      "language": "zh",
      "excluded_skill_ids": ["skill-uuid-1"],
      "excluded_memory_ids": []
    }'
  ```

- **`GET /api/sessions/default-model`** — 系统级全局默认模型偏好 key(未设置时 `model: null`).
  ```bash
  curl -sS "${BASE}/api/sessions/default-model" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`PATCH /api/sessions/:id/model`** — 原地更换会话模型(模型被删导致只读时, "更换模型并继续"用此). Body `{ "model": "<新模型 key>" }`. 旧 agent 活跃则先 close.
  ```bash
  curl -sS -X PATCH "${BASE}/api/sessions/ses12345/model" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"model":"codex"}'
  ```

- **`POST /api/sessions/:id/predicted-next-questions`** — 基于 session 历史预测用户可能追问的问题. 返回 `{ session_id, questions, meta }`.
  ```bash
  curl -sS -X POST "${BASE}/api/sessions/ses12345/predicted-next-questions" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/sessions/:id/features/files`** — 从 session JSONL 抽取"文件修改"特征清单.

- **`GET /api/sessions/:id/features/bash`** — 抽取 Bash/shell 命令特征(按时间顺序).

- **`GET /api/sessions/:id/features/git-diff?file=<路径>`** — 按文件特征清单限定路径读 git diff(无 diff 回退文件内容); `file` 不在清单内则 400.
  ```bash
  curl -sS "${BASE}/api/sessions/ses12345/features/git-diff?file=src/foo.ts" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/sessions/:id/emphasize`** — 进行中临时把某个 skill/memory "再喂一遍"给 agent. Body `{ "kind": "skill|memory", "id": "<id>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/sessions/ses12345/emphasize" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"kind":"memory","id":"mem-uuid-1"}'
  ```

### 2.8 历史任务 `/api/tasks`(v1 旧接口)

- **`GET /api/tasks`** — 当前用户全部历史 task 列表(已迁移到 v2 sessions, 仅兼容保留).
  ```bash
  curl -sS "${BASE}/api/tasks" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/tasks`** — 旧式创建 task. Body: `name` 必填, `description` / `issue_id` 选填.
  ```bash
  curl -sS -X POST "${BASE}/api/tasks" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"旧式 task","description":"..."}'
  ```

- **`GET /api/tasks/:id`** — 单个 task.
  ```bash
  curl -sS "${BASE}/api/tasks/old12345" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`PATCH /api/tasks/:id`** — 改 task. 字段: `name` / `description` / `status` / `risk_level`(`medium|low`).
  ```bash
  curl -sS -X PATCH "${BASE}/api/tasks/old12345" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"新名字","risk_level":"low"}'
  ```

- **`DELETE /api/tasks/:id`** — 删除(进回收站).
  ```bash
  curl -sS -X DELETE "${BASE}/api/tasks/old12345" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/tasks/:id/restore`** — 从回收站还原.
  ```bash
  curl -sS -X POST "${BASE}/api/tasks/old12345/restore" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`DELETE /api/tasks/:id/permanent`** — 永久删除.
  ```bash
  curl -sS -X DELETE "${BASE}/api/tasks/old12345/permanent" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/tasks/:id/messages?limit=<n>`** — task 消息列表(可分页).
  ```bash
  curl -sS "${BASE}/api/tasks/old12345/messages?limit=50" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/tasks/:id/bookmarks`** — task 收藏消息列表.
  ```bash
  curl -sS "${BASE}/api/tasks/old12345/bookmarks" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/tasks/:id/risk`** — task 风险等级(无 auth, 给 wrapper/hooks 调用).
  ```bash
  curl -sS "${BASE}/api/tasks/old12345/risk"
  ```

- **`GET /api/tasks/recent?limit=<n>`** — 当前用户最近活跃的 session/任务列表(`limit` 默认 12, 钳到 1–50).
  ```bash
  curl -sS "${BASE}/api/tasks/recent?limit=20" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

### 2.9 消息 `/api/messages`

- **`PATCH /api/messages/:id/bookmark`** — 切换收藏.
  ```bash
  curl -sS -X PATCH "${BASE}/api/messages/msg12345/bookmark" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

### 2.10 Skill `/api/skills` 与 `/api/projects/:projectId/skills`

用户级(`/api/skills`):

- **`GET /api/skills`** — 当前用户级 Skill 列表.
  ```bash
  curl -sS "${BASE}/api/skills" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/skills/catalog`** — 全平台可见 Skill 目录(其他用户/项目的也能读).
  ```bash
  curl -sS "${BASE}/api/skills/catalog" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/skills/catalog/:id`** — 目录里某一条详情.
  ```bash
  curl -sS "${BASE}/api/skills/catalog/skill-uuid-1" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/skills/copy`** — 从目录复制到自己的用户级(快照模式). Body: `{ "source_id": "<id>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/skills/copy" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"source_id":"skill-uuid-1"}'
  ```

- **`GET /api/skills/:id/access`** — 取权限信息.
  ```bash
  curl -sS "${BASE}/api/skills/skill-uuid-1/access" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`PATCH /api/skills/:id/access`** — 改权限. Body: `visibility` / `allow_user_ids` / `allow_group_ids` / `deny_user_ids` / `deny_group_ids`.
  ```bash
  curl -sS -X PATCH "${BASE}/api/skills/skill-uuid-1/access" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"visibility":"users","allow_user_ids":["alice","alice"]}'
  ```

- **`POST /api/skills/:id/hide`** / **`POST /api/skills/:id/unhide`** — 当前用户隐藏/取消隐藏.
  ```bash
  curl -sS -X POST "${BASE}/api/skills/skill-uuid-1/hide" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/skills/:id`** — 单个 Skill 详情(只能读自己用户级的).
  ```bash
  curl -sS "${BASE}/api/skills/skill-uuid-1" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/skills`** — 调 `npx --yes skills add <name>` 安装到用户级. Body: `{ "name": "<skill 名>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/skills" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"anthropic/skills"}'
  ```

- **`POST /api/skills/import-local`** — 从服务器本地绝对路径导入. Body: `{ "path": "<abs 路径>" }`(可指向单文件或目录).
  ```bash
  curl -sS -X POST "${BASE}/api/skills/import-local" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"path":"/home/alice/work/my-skill"}'
  ```

- **`DELETE /api/skills/:id`** — 删.
  ```bash
  curl -sS -X DELETE "${BASE}/api/skills/skill-uuid-1" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/skills/:id/move`** — 移到项目级. Body: `{ "project_id": "<项目 id>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/skills/skill-uuid-1/move" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"project_id":"abc12345"}'
  ```

项目级(`/api/projects/:projectId/skills`):

- **`GET /api/projects/:projectId/skills`** — 项目级 Skill 列表.
  ```bash
  curl -sS "${BASE}/api/projects/abc12345/skills" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/projects/:projectId/skills/import-file`** — 上传一份 `SKILL.md` 内容(字符串, 1MB 内),导入为项目级 Skill. Body: `{ "content": "...", "name": "<可选, 留空从 frontmatter 取>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/skills/import-file" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"content":"---\nname: my-skill\n---\nbody content","name":"my-skill"}'
  ```

- **`GET /api/projects/:projectId/skills/:id/access`** / **`PATCH /api/projects/:projectId/skills/:id/access`** — 同用户级, 字段一样.

- **`POST /api/projects/:projectId/skills/:id/hide`** / **`POST /api/projects/:projectId/skills/:id/unhide`** — 同用户级.

- **`GET /api/projects/:projectId/skills/:id`** — 单个 Skill 详情.
  ```bash
  curl -sS "${BASE}/api/projects/abc12345/skills/skill-uuid-1" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/projects/:projectId/skills`** — 装到项目级. Body: `{ "name": "<skill 名>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/skills" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"anthropic/skills"}'
  ```

- **`POST /api/projects/:projectId/skills/import-local`** — 从服务器本地绝对路径导入.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/skills/import-local" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"path":"/srv/skills/my-skill"}'
  ```

- **`POST /api/projects/:projectId/skills/copy`** — 从目录复制到本项目.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/skills/copy" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"source_id":"skill-uuid-1"}'
  ```

- **`DELETE /api/projects/:projectId/skills/:id`** — 删项目级 Skill.
  ```bash
  curl -sS -X DELETE "${BASE}/api/projects/abc12345/skills/skill-uuid-1" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/projects/:projectId/skills/:id/move`** — 项目级 → 用户级或另一个项目. Body: `{ "scope": "user|project", "project_id": "<仅 scope=project 时>" }`. `scope` 缺省为 `user`.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/skills/skill-uuid-1/move" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"scope":"project","project_id":"proj67890"}'
  ```

### 2.11 Memory `/api/memories` 与 `/api/projects/:projectId/memories`

用户级(`/api/memories`):

- **`GET /api/memories`** — 用户级 Memory 列表.
  ```bash
  curl -sS "${BASE}/api/memories" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/memories/catalog`** / **`GET /api/memories/catalog/:id`** — 全平台 Memory 目录.
  ```bash
  curl -sS "${BASE}/api/memories/catalog" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/memories/copy`** — 从目录复制. Body: `{ "source_id": "<id>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/memories/copy" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"source_id":"mem-uuid-1"}'
  ```

- **`POST /api/memories/import-local`** — 从服务器本地绝对路径导入. Body: `{ "path": "<abs 路径>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/memories/import-local" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"path":"/home/alice/work/notes"}'
  ```

- **`GET /api/memories/:id/access`** / **`PATCH /api/memories/:id/access`** — 权限.
  ```bash
  curl -sS "${BASE}/api/memories/mem-uuid-1/access" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/memories/:id/hide`** / **`POST /api/memories/:id/unhide`** — 隐藏/取消.
  ```bash
  curl -sS -X POST "${BASE}/api/memories/mem-uuid-1/hide" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/memories/:id`** — 详情.
  ```bash
  curl -sS "${BASE}/api/memories/mem-uuid-1" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/memories`** — 新建. Body: `name` 必填, `description` / `body` 选填.
  ```bash
  curl -sS -X POST "${BASE}/api/memories" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"host-ssh","description":"常用跳板机","body":"host1:22 user=alice"}'
  ```

- **`PATCH /api/memories/:id`** — 改. Body 同上.
  ```bash
  curl -sS -X PATCH "${BASE}/api/memories/mem-uuid-1" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"description":"新描述","body":"new body"}'
  ```

- **`DELETE /api/memories/:id`** — 删.
  ```bash
  curl -sS -X DELETE "${BASE}/api/memories/mem-uuid-1" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/memories/:id/move`** — 移到项目级. Body: `{ "project_id": "<项目 id>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/memories/mem-uuid-1/move" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"project_id":"abc12345"}'
  ```

项目级(`/api/projects/:projectId/memories`):

- **`GET /api/projects/:projectId/memories`** — 项目级 Memory 列表.
  ```bash
  curl -sS "${BASE}/api/projects/abc12345/memories" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/projects/:projectId/memories/project-knowledge/refresh`** — 手动刷新项目知识沉淀.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/memories/project-knowledge/refresh" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/projects/:projectId/memories/project-knowledge/upload`** — 上传 markdown 当作项目知识. Body: `{ "content": "<markdown, 1MB 内>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/memories/project-knowledge/upload" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"content":"# 项目知识\n\n本项目主要做 X..."}'
  ```

- **`GET /api/projects/:projectId/memories/:id/access`** / **`PATCH /api/projects/:projectId/memories/:id/access`** — 权限.

- **`POST /api/projects/:projectId/memories/:id/hide`** / **`POST /api/projects/:projectId/memories/:id/unhide`** — 隐藏/取消.

- **`GET /api/projects/:projectId/memories/:id`** — 详情(自动同步项目知识).
  ```bash
  curl -sS "${BASE}/api/projects/abc12345/memories/mem-uuid-1" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/projects/:projectId/memories`** — 新建项目级 Memory. Body: `name` / `description` / `body`.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/memories" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"项目约定","body":"提交信息必须包含 issue id"}'
  ```

- **`PATCH /api/projects/:projectId/memories/:id`** — 改.
  ```bash
  curl -sS -X PATCH "${BASE}/api/projects/abc12345/memories/mem-uuid-1" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"body":"新内容"}'
  ```

- **`POST /api/projects/:projectId/memories/copy`** — 从目录复制到本项目.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/memories/copy" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"source_id":"mem-uuid-1"}'
  ```

- **`POST /api/projects/:projectId/memories/import-local`** — 从服务器本地绝对路径导入.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/memories/import-local" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"path":"/srv/memories/team"}'
  ```

- **`DELETE /api/projects/:projectId/memories/:id`** — 删.
  ```bash
  curl -sS -X DELETE "${BASE}/api/projects/abc12345/memories/mem-uuid-1" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/projects/:projectId/memories/:id/move`** — 项目级 → 用户级或另一个项目. Body: `{ "scope": "user|project", "project_id": "<仅 scope=project 时>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/memories/mem-uuid-1/move" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"scope":"user"}'
  ```

- **`POST /api/memories/import-file`**(用户级) — 上传单个 `.md` 文件创建用户级 Memory. 支持 `multipart/form-data`(字段 `file`)或 JSON `{ "content": "...", "filename": "..." }` 两种入参.

项目级补充(`/api/projects/:projectId/memories`):

- **`POST /api/projects/:projectId/memories/aimux-remote-inventory`** — 用选中的 aimux remote 生成项目级"远程算力清单" Memory(会替换旧清单). Body `{ "selected_names": ["..."], "remote_paths": { "<name>": "<path>" }, "hardware_by_name": { ... }, "markdown": "..." }`. 需 `canManageProject`.

- **`GET /api/projects/:projectId/memories/project-knowledge/lock`** — 查项目规划写入锁状态 `{ locked, locked_at }`(Agent 写 `project_knowledge.md` 前会建 `.planning_lock`).

- **`GET /api/projects/:projectId/memories/project-knowledge/content`** — 读当前 `project_knowledge.md` 正文(规划编辑器初始化用; 不存在返回 `{ content:'', exists:false }`).

- **`GET /api/projects/:projectId/memories/project-knowledge/history`** — 列项目知识历史快照(按时间倒序, 保留最近 30 份).

- **`GET /api/projects/:projectId/memories/project-knowledge/history/:filename`** — 读单个历史快照内容(供 diff/查看).

- **`POST /api/projects/:projectId/memories/project-knowledge/restore`** — 把指定历史快照回滚覆盖当前 `project_knowledge.md` 再同步 Memory(覆盖前先对当前内容做一次快照备份). Body `{ "filename": "<快照文件名>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/projects/abc12345/memories/project-knowledge/restore" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"filename":"20260801-120000.md"}'
  ```

### 2.12 小莫助理 `/api/assistant`

> 这套是小莫问答入口, 不是被 assistant 直接读 Skill 的 Skill 列表. 详细见 `SKILL.md`.

- **`GET /api/assistant/sessions?limit=<n>`** — 当前用户的小莫 Session 列表.
  ```bash
  curl -sS "${BASE}/api/assistant/sessions?limit=10" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/assistant/workspace`** — 当前用户的小莫项目 + Issue.
  ```bash
  curl -sS "${BASE}/api/assistant/workspace" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/assistant/preset`** — 当前用户的小莫预设(模型/语言/勾选资料).
  ```bash
  curl -sS "${BASE}/api/assistant/preset" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/assistant/preset`** — 保存小莫预设. Body: `preset.name` / `preset.description` / `preset.model` / `preset.language`(zh|en)/ `preset.role`(`chief_researcher|research_assistant`)/ `preset.excluded_skill_ids` / `preset.excluded_memory_ids` / `preset.required_skill_ids`. 当保存的预设和当前 Session 已有勾选不一致, 默认返回 409 要求确认, 加 `delete_current_session: true` 才会真删.
  ```bash
  curl -sS -X POST "${BASE}/api/assistant/preset" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "preset": {
        "name": "小莫助理",
        "description": "你是小莫, 莫比乌斯AI的项目助理...",
        "model": "codex",
        "language": "zh",
        "role": "research_assistant",
        "excluded_skill_ids": [],
        "excluded_memory_ids": [],
        "required_skill_ids": ["builtin:mobius-assistant"]
      },
      "delete_current_session": true
    }'
  ```

- **`GET /api/assistant/preset/context-preview`** 与 **`POST /api/assistant/preset/context-preview`** — 预览预设上下文. 字段同 `name` / `description` / `excluded_skill_ids` / `excluded_memory_ids` / `language`.
  ```bash
  curl -sS -X POST "${BASE}/api/assistant/preset/context-preview" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"小莫助理","description":"...","language":"zh"}'
  ```

- **`GET /api/assistant/preset/session-selection-defaults`** — 当前用户默认要排除的 Skill/Memory 列表(给小莫前台勾选用).
  ```bash
  curl -sS "${BASE}/api/assistant/preset/session-selection-defaults" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/assistant/sessions/:id`** — 单个小莫 Session 详情 + 消息 + jsonl 摘要.
  ```bash
  curl -sS "${BASE}/api/assistant/sessions/ses12345" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/assistant/messages`** — 向小莫发问(自动建/复用 Session 并启动). Body:
  - `content` 必填;
  - `request_id` 选填;
  - `client_context` 选填, 给小莫补充浏览器上下文: `{ current_url, origin, pathname, search, hash, auth: { token, authorization, user_id, display_name, role } }`.
  ```bash
  curl -sS -X POST "${BASE}/api/assistant/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "content": "我想做一个 Three.js 光点标志, 帮我设计一个 Issue",
      "request_id": "xm-req-001",
      "client_context": {
        "current_url": "https://imac.local/u/alice",
        "pathname": "/u/alice",
        "auth": {"user_id":"alice","display_name":"alice","role":"user"}
      }
    }'
  ```

- **`POST /api/assistant/transcribe`** — 语音转文字(ASR). `multipart/form-data` 字段 `audio`(单文件 ≤25MB). 返回 `{ ok, text, alternatives, request_id }`.
  ```bash
  curl -sS -X POST "${BASE}/api/assistant/transcribe" \
    -H "Authorization: Bearer ${TOKEN}" \
    -F "audio=@/path/to/voice.wav"
  ```

- **`GET /api/assistant/tts/voices`** — 列出可用 TTS 音色. 返回 `{ ok, default_voice, voices, configured }`(豆包凭据未配时 `configured:false` 且 `voices:[]`).
  ```bash
  curl -sS "${BASE}/api/assistant/tts/voices" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/assistant/speak`** — 文字转语音, 直接返回二进制 audio 字节(带 `Content-Type` / `X-Mobius-TTS-*` 头). Body `{ "text": "<必填, 去空格后非空>", "voice"?: "<音色 id>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/assistant/speak" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"text":"你好, 这是语音播报","voice":"zh_female_vv_uranus_bigtts"}' \
    -o speak.mp3
  ```

### 2.13 管理员 `/api/admin`

- **`GET /api/admin/user-groups`** — 用户组列表.
  ```bash
  curl -sS "${BASE}/api/admin/user-groups" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/admin/user-groups`** — 新建组. Body: `name` 必填, `description` 选填.
  ```bash
  curl -sS -X POST "${BASE}/api/admin/user-groups" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"research-team","description":"研究员组"}'
  ```

- **`PATCH /api/admin/user-groups/:id`** — 改. Body: `name` / `description`.
  ```bash
  curl -sS -X PATCH "${BASE}/api/admin/user-groups/group-uuid-1" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"description":"新描述"}'
  ```

- **`DELETE /api/admin/user-groups/:id`** — 删.
  ```bash
  curl -sS -X DELETE "${BASE}/api/admin/user-groups/group-uuid-1" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/admin/users?include_deleted=0|1`** — 员工列表. 返回里含每个用户的 `stats` 字段(session/任务统计).
  ```bash
  curl -sS "${BASE}/api/admin/users?include_deleted=0" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/admin/users`** — 新建员工. Body:
  - `id` (或 `username`) 必填, `A-Za-z0-9._@-`;
  - `password` 必填, 至少 6 位;
  - `display_name` / `name` 选填;
  - `role` 选填, `user|admin`;
  - `work_dir` / `workDir` 选填, 必须是绝对路径;
  - `group_id` / `groupId` / `group_name` / `groupName` / `group` 选填, 不存在时自动建(`create_group_if_missing: false` 可关闭);
  - `create_group_if_missing` / `createIfMissing` 选填, 默认 true.
  ```bash
  curl -sS -X POST "${BASE}/api/admin/users" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "id": "alice",
      "password": "alice-pwd-001",
      "display_name": "Alice",
      "role": "user",
      "work_dir": "/home/alice/work",
      "group_name": "research-team"
    }'
  ```

- **`POST /api/admin/users/bulk`** — 批量新建. Body: `{ "employees": [ <同 POST /api/admin/users body>, ... ] }`(一次最多 200 个).
  ```bash
  curl -sS -X POST "${BASE}/api/admin/users/bulk" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "employees": [
        {"id":"bob","password":"bob-pwd-001","display_name":"Bob","role":"user"},
        {"id":"carol","password":"carol-pwd-001","display_name":"Carol","role":"user"}
      ]
    }'
  ```

- **`PATCH /api/admin/users/:id/group`** — 调组. Body: `group_id` / `group_name` / `group`(不传 group_id 时按 group_name 匹配).
  ```bash
  curl -sS -X PATCH "${BASE}/api/admin/users/alice/group" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"group_name":"research-team"}'
  ```

- **`DELETE /api/admin/users/:id`** — 软删员工. 不能删当前登录账号, 不能删最后一个 admin.
  ```bash
  curl -sS -X DELETE "${BASE}/api/admin/users/alice" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/admin/tasks?status=<s>&limit=<n>`** — 全站 session 列表(管理员视角).
  ```bash
  curl -sS "${BASE}/api/admin/tasks?status=active&limit=50" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/admin/stats`** — 全站统计: 用户数, 任务数, 5h prompt 聚合, agent bridge 状态.
  ```bash
  curl -sS "${BASE}/api/admin/stats" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/admin/tmux?hours=<n>`** — 后台 tmux 窗口(包含活跃/空闲/已关闭). 默认统计 5h.
  ```bash
  curl -sS "${BASE}/api/admin/tmux?hours=5" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`DELETE /api/admin/tmux/:backend/:sessionId`** — 强杀后台 tmux 窗口. `backend` ∈ `codex|claude_code|tmux-codex|tmux-claude-code|claude|claude-code`.
  ```bash
  curl -sS -X DELETE "${BASE}/api/admin/tmux/codex/ses12345" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/admin/settings/model-prompt-limits`** — 每用户/每模型 5h 动态窗口提问限额.
  ```bash
  curl -sS "${BASE}/api/admin/settings/model-prompt-limits" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`PUT /api/admin/settings/model-prompt-limits`** — 设限额. Body: `{ "model": "<key>", "maxPromptsPerWindow": <n> }` 或 `{ "key": "...", "max_prompts_per_5h": <n> }` 或 `{ "model": "...", "limit": <n> }`.
  ```bash
  curl -sS -X PUT "${BASE}/api/admin/settings/model-prompt-limits" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"model":"codex","maxPromptsPerWindow":120}'
  ```

- **`GET /api/admin/model-access/claude-code`** — Claude Code 模型白名单(不含 settings).
  ```bash
  curl -sS "${BASE}/api/admin/model-access/claude-code" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/admin/model-access/claude-code`** — 增/改一条. Body 含 `key` / `label` / `model` / `settings` 等. 不带 `key` 时新增, 带 `key` 时按该 key upsert.
  ```bash
  curl -sS -X POST "${BASE}/api/admin/model-access/claude-code" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"key":"sonnet","label":"Sonnet","model":"claude-3-5-sonnet","settings":{"region":"us"}}'
  ```

- **`GET /api/admin/model-access/claude-code/:key`** — 单条详情(含 settings).
  ```bash
  curl -sS "${BASE}/api/admin/model-access/claude-code/sonnet" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`PUT /api/admin/model-access/claude-code/:key`** — 按 key 改. Body 同上.
  ```bash
  curl -sS -X PUT "${BASE}/api/admin/model-access/claude-code/sonnet" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"label":"Sonnet (新版)","settings":{"region":"us-east-1"}}'
  ```

- **`DELETE /api/admin/model-access/claude-code/:key`** — 删.
  ```bash
  curl -sS -X DELETE "${BASE}/api/admin/model-access/claude-code/sonnet" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/admin/skill-memory/inventory`** — 列出当前管理员可导出的 Skill / Memory 清单(用户级 = 自己; 项目级 = 全部).
  ```bash
  curl -sS "${BASE}/api/admin/skill-memory/inventory" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/admin/skill-memory/export`** — 按 ID 列表打包 base64 串. Body: `{ "memory_ids": [...], "skill_ids": [...] }`.
  ```bash
  curl -sS -X POST "${BASE}/api/admin/skill-memory/export" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"memory_ids":["mem-uuid-1"],"skill_ids":["skill-uuid-2"]}'
  ```

- **`POST /api/admin/skill-memory/preview`** — 预览备份串. Body: `{ "bundle": "<base64>" }`.
  ```bash
  curl -sS -X POST "${BASE}/api/admin/skill-memory/preview" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"bundle":"<base64 串>"}'
  ```

- **`POST /api/admin/skill-memory/import`** — 导入. Body: `{ "bundle": "<base64>", "target": { "scope": "user|project", "project_id": "<仅 scope=project>" }, "indexes": [<可选, 选导哪些条目>] }`.
  ```bash
  curl -sS -X POST "${BASE}/api/admin/skill-memory/import" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "bundle": "<base64 串>",
      "target": {"scope":"project","project_id":"abc12345"},
      "indexes": [0, 1]
    }'
  ```

- **`PUT /api/admin/settings/global-default-model`** — 设置全局默认模型(空串/null 清除, 恢复系统内置启发式). Body `{ "model": "<key>|''|null" }`. 非空值必须是当前可用模型, 否则 400.
  ```bash
  curl -sS -X PUT "${BASE}/api/admin/settings/global-default-model" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"model":"codex"}'
  ```

- **`PUT /api/admin/settings/model-display-order`** — 设置模型在新建 Session 选择器里的显示顺序. Body `{ "order": ["<key>", ...] }`(也兼容旧字段 `model_order`; 仅保留当前可用模型的 key).

- **`GET /api/admin/settings/auto-generate-session-title`** / **`PUT /api/admin/settings/auto-generate-session-title`** — 查询/设置"自动生成 Session 标题"开关; PUT Body `{ "enabled": true|false }`.

- **`GET /api/admin/settings/admin-assistant-callbacks`** / **`PUT /api/admin/settings/admin-assistant-callbacks`** — 当前管理员是否接收全站 Session 完成/失败回调; PUT Body `{ "enabled": true|false }`.

豆包语音/ASR 凭证(`/api/admin/settings/doubao-voice`):

- **`GET /api/admin/settings/doubao-voice`** — 读豆包 ASR/TTS 凭证(脱敏).
- **`GET /api/admin/settings/doubao-voice/reveal`** — 读明文(不脱敏, 写 reveal 审计).
- **`PUT /api/admin/settings/doubao-voice/asr`** / **`PUT /api/admin/settings/doubao-voice/tts`** — 更新 ASR / TTS 凭证(整个 body 透传给 service 层).
- **`POST /api/admin/settings/doubao-voice/test`** — 用 body 里的**临时凭证**测连通性(不落盘). Body `{ "service": "asr|tts", "appId": "...", "accessToken": "...", "resourceId"?: "...", "endpoint": "<wss/https>", "voiceType"?: "<TTS 用>" }`.

特殊轻模型 API(`/api/admin/settings/light-model-api`, 仅架构师用):

- **`GET /api/admin/settings/light-model-api`** / **`GET .../reveal`** — 读配置(脱敏/明文).
- **`PUT /api/admin/settings/light-model-api`** — 更新配置(整个 body 透传).
- **`POST /api/admin/settings/light-model-api/test`** — 用**已存配置** + body 里临时 `model` 测连通. Body `{ "model": "<key>" }`.

文字隐藏 / 代理配置 / 审计:

- **`GET /api/admin/text-redaction/global`**(普通 `auth`, 全员可读) / **`PUT /api/admin/text-redaction/global`**(`adminAuth`) — 全员强制文字替换隐藏规则; PUT Body `{ "rules": [...] }`.
- **`GET /api/admin/settings/proxy-files`** / **`PUT /api/admin/settings/proxy-files`** — 读/写两个 proxychains 配置(`/etc/proxychains.conf`、`~/proxy_claude.conf`); PUT Body `{ "system"?: "...", "model"?: "..." }`(≤256KB, 禁 NUL).
- **`GET /api/admin/audit-log?limit=<n>&offset=<n>`** — 管理员审计日志(分页); `/api/admin/admin-audit-log` 是等价别名.

用户组项目可见性:

- **`GET /api/admin/user-groups/:id/project-visibility`** — 取某群组的项目可见性 `{ mode, visible_project_ids[], candidates[] }`.
- **`PUT /api/admin/user-groups/:id/project-visibility`** — 设可见性. Body `{ "mode": "default|restricted", "visible_project_ids": ["..."] }`.

Codex 模型接入(`/api/admin/model-access/codex`, 与已记录的 claude-code 完全对称):

- **`GET /api/admin/model-access/codex`** — 全部 Codex 模型接入(不含 TOML 明文).
- **`POST /api/admin/model-access/codex`** — 新增一条(整个 body 透传).
- **`GET /api/admin/model-access/codex/:key`** — 单条详情(含 TOML).
- **`PUT /api/admin/model-access/codex/:key`** — 按 key 改.
- **`DELETE /api/admin/model-access/codex/:key`** — 删(`key === 'mobiusdefault'` 拒绝; 有 session 引用不阻断, 返回 `affected_session_count`).

### 2.14 远端算力 `/api/aimux`

- **`GET /api/aimux/remotes`** — 列出已配置 aimux remote.
  ```bash
  curl -sS "${BASE}/api/aimux/remotes" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/aimux/remotes/test`** — 连通性测试. Body: `{ "name": "<remote 名>", "timeout": <可选, 秒> }`.
  ```bash
  curl -sS -X POST "${BASE}/api/aimux/remotes/test" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"workstation-1","timeout":10}'
  ```

- **`POST /api/aimux/remotes/hardware`** — 探测硬件. Body: `{ "name": "<remote 名>", "timeout": <可选, 秒> }`.
  ```bash
  curl -sS -X POST "${BASE}/api/aimux/remotes/hardware" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"workstation-1","timeout":15}'
  ```

- **`POST /api/aimux/remotes/browse`** — 浏览远端目录. Body: `{ "name": "<remote 名>", "path": "<远端绝对路径>", "timeout": <可选, 秒> }`.
  ```bash
  curl -sS -X POST "${BASE}/api/aimux/remotes/browse" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"workstation-1","path":"/home/user/projects","timeout":10}'
  ```

- **`POST /api/aimux/remotes`** — 新增 remote. Body 由 `aimuxRemote.addRemote` 解析(常见字段: `name` / `host` / `port` / `user` / `identity_file` / `proxy_jump` 等).
  ```bash
  curl -sS -X POST "${BASE}/api/aimux/remotes" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "name": "workstation-1",
      "host": "10.0.0.5",
      "port": 22,
      "user": "alice",
      "identity_file": "/home/alice/.ssh/id_ed25519"
    }'
  ```

### 2.15 会话与群聊 `/api/conversations`

> Mobius 的"聊天"子系统: 支持 1v1 私聊和多人/多 agent 群聊. 发群消息时可 @ 群内的 agent(小莫/分身), 后端会用该 agent owner 身份触发任务并把回复回写群聊.

- **`GET /api/conversations`** — 当前用户的会话列表(按最近活跃排序).
  ```bash
  curl -sS "${BASE}/api/conversations" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/conversations`** — 建群, 当前用户自动作为 owner 加入. Body `{ "name"?: "<群名, 可空>", "members"?: [{ "type": "user|agent", "id": "<id>", "display_name"?: "...", "agent_session_id"?: "..." }] }`. 返回 `{ id, name }`.
  ```bash
  curl -sS -X POST "${BASE}/api/conversations" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"name":"项目讨论","members":[{"type":"user","id":"alice"},{"type":"agent","id":"<agent-id>","agent_session_id":"<sid>"}]}'
  ```

- **`POST /api/conversations/direct`** — 发起或复用与某用户的 1v1 私聊. Body `{ "member_id": "<对方用户 id>" }`(不能为空、不能是自己).
  ```bash
  curl -sS -X POST "${BASE}/api/conversations/direct" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"member_id":"alice"}'
  ```

- **`GET /api/conversations/:id`** — 会话详情 + 成员列表(含在线状态, 仅成员可见; 命中后顺带把该用户未读标为已读).
  ```bash
  curl -sS "${BASE}/api/conversations/conv12345" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/conversations/:id/members`** — 邀请单个成员进群(任意成员均可操作). Body `{ "type": "user|agent", "id": "<id>", "display_name"?: "...", "agent_session_id"?: "..." }`.
  ```bash
  curl -sS -X POST "${BASE}/api/conversations/conv12345/members" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"type":"user","id":"bob"}'
  ```

- **`DELETE /api/conversations/:id`** — 删除/退出会话: owner = 解散整群(`{ ok, dissolved: true }`); 非 owner = 仅自己退出(`{ ok, removed: 1 }`).
  ```bash
  curl -sS -X DELETE "${BASE}/api/conversations/conv12345" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`DELETE /api/conversations/:id/members/:memberType/:memberId`** — 退群 / 移除成员. 路径参数 `memberType` = `user|agent`, `memberId` = 成员 id. 退自己随时; 群主自退会 400(需先转让/解散); 踢别人需相应权限(非群主只能移除"自己名下的 agent").
  ```bash
  curl -sS -X DELETE "${BASE}/api/conversations/conv12345/members/user/bob" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/conversations/:id/messages`** — 发群消息(真人发送, 可选 @agent). Body `{ "content": "<消息文本, trim 后非空, ≤8000 字>", "mentions"?: [{ "type": "agent", "id": "<群内 agent id>", ... }] }`. 后端 fire-and-forget: ① 给离线真人成员远程推送(deepLink `momo://group/<id>`); ② 若 mentions 含群内 agent, 用其 owner 身份执行任务并把回复回写群聊.
  ```bash
  curl -sS -X POST "${BASE}/api/conversations/conv12345/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"content":"@小莫 帮我看一下 README","mentions":[{"type":"agent","id":"<agent-id>"}]}'
  ```

- **`GET /api/conversations/:id/events`** — 群消息 SSE 流: 首包 `history`(回灌最近 50 条) → `ready`({ last_id }) → 有新消息时发 `message`(单条); 每 25s 发一次 `keepalive`. 鉴权支持 `Authorization` 头或 `?token=` query.
  ```bash
  curl -N "${BASE}/api/conversations/conv12345/events" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

### 2.16 拓展 `/api/extensions` 与 `/api/ext`

`/api/extensions` 是元信息接口(metaRouter):

- **`GET /api/extensions`** — 所有已加载拓展 + 最近的 reload 错误.
  ```bash
  curl -sS "${BASE}/api/extensions" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/extensions/:name`** — 单个拓展 manifest.
  ```bash
  curl -sS "${BASE}/api/extensions/finance-news-wall" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/extensions/:name/build-status`** — 编译状态(loading 页轮询).
  ```bash
  curl -sS "${BASE}/api/extensions/finance-news-wall/build-status" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/extensions/_admin/hidden`** — 管理员:被隐藏的拓展项目对.
  ```bash
  curl -sS "${BASE}/api/extensions/_admin/hidden" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/extensions/_admin/hidden/:projectId/:userId/restore`** — 管理员:撤销某用户对某拓展项目的隐藏.
  ```bash
  curl -sS -X POST "${BASE}/api/extensions/_admin/hidden/proj12345/alice/restore" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/extensions/reload`** — 管理员:强制重新扫描 `mobius/extension/` 并 diff DB.
  ```bash
  curl -sS -X POST "${BASE}/api/extensions/reload" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/extensions/:name/rebuild`** — 管理员:强制重新编译该拓展前端.
  ```bash
  curl -sS -X POST "${BASE}/api/extensions/finance-news-wall/rebuild" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

`/api/ext` 是拓展统一调用入口(invokeRouter):

- **`POST /api/ext`** — 调用某个拓展的 handler(在 worker_thread 里跑). Body:
  - `extension_name` 必填, 形如 `finance-news-wall`;
  - `ext_main_payload` 选填, 任意对象, 直接透传给拓展 `main.py` 的入参.
  ```bash
  curl -sS -X POST "${BASE}/api/ext" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{
      "extension_name": "finance-news-wall",
      "ext_main_payload": {"action":"list_news","limit":10}
    }'
  ```

`/extension/<name>/...` 是拓展静态资源 + 共用 SDK(staticRouter, 不通过 `/api`):

- **`GET /extension/_sdk/ext.js`** — 前端 SDK(`extCall` 函数 + `extName`).
  ```bash
  curl -sS "${BASE}/extension/_sdk/ext.js"
  ```

- **`GET /extension/:name/`** — 拓展首页 HTML(注入 `window.__EXT_NAME__`).
  ```bash
  curl -sS "${BASE}/extension/finance-news-wall/" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /extension/:name/<asset>`** — 拓展 dist 资源(`.js` / `.css` / `.svg` / `.png` 等).
  ```bash
  curl -sS "${BASE}/extension/finance-news-wall/assets/index-abc123.js" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`POST /api/extensions/:name/upload`** — 拓展通用文件上传, 存到该拓展 `data_dir/users/<user>/uploads/`. `multipart` 字段 `file`(单文件, 上限由 `MOBIUS_EXT_UPLOAD_MAX_MB` 控制, 默认 50MB). 返回 `{ ok, file: { path, name, stored_name, size, mime_type } }`.
  ```bash
  curl -sS -X POST "${BASE}/api/extensions/finance-news-wall/upload" \
    -H "Authorization: Bearer ${TOKEN}" \
    -F "file=@/path/to/data.csv"
  ```

- **`GET /api/extensions/:name/user-asset/<相对路径>`** — 当前用户读自己在该拓展用户目录下的媒体文件(`<img>`/`<video>` 直链, 鉴权走 `Authorization` 头或 `?token=` query; 扩展名白名单, 支持 Range/ETag).

- **`GET /api/extensions/:name/shared-asset/<相对路径>`** — 任意登录用户读该拓展的共享公共资产(`shared/` 区, 同上鉴权与白名单).

- **`POST /api/extensions/_admin/hidden/:projectId/:userId/purge`** — 管理员: 清空某用户在某拓展项目上的全部数据(即原"拓展 purge"能力的真实路径). 返回删除统计.
  ```bash
  curl -sS -X POST "${BASE}/api/extensions/_admin/hidden/proj12345/alice/purge" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

### 2.17 code-server 反代 `/code-server` 与 `/api/admin/code-server`

- **`GET /code-server/:userId__:projectId/`** — VSCode Web 编辑器, 走反代 + JWT. 首次 navigate 需要把 token 当 `?_jwt=<token>` 拼上, 后端会种 `cc_cs_jwt` cookie 并 302 跳转.
  ```bash
  curl -sS -L "${BASE}/code-server/alice__abc12345/?_jwt=${TOKEN}&folder=/home/alice/work/myproj"
  ```

- **`GET /api/admin/code-server/list`** — 管理员:列出当前活跃的 code-server 池.
  ```bash
  curl -sS "${BASE}/api/admin/code-server/list" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

### 2.18 用户列表 / 全局搜索 / 个人偏好

- **`GET /api/users?q=<关键字>&page=<n>&pageSize=<n>`** — 全部已注册用户(脱敏 `{id, display_name, role}`, 当前用户排第一, 支持搜索 + 分页). 供群聊邀请成员首屏. 返回 `{ users, page, pageSize, total }`.
  ```bash
  curl -sS "${BASE}/api/users?q=ali&page=1&pageSize=50" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/search?q=<关键词>`** — **全局会话正文搜索**(网页"搜索会话"能力). 扫描候选 session 的 JSONL, 返回命中 session + 命中片段. Query: `q`(必填, 2–200 字符) / `case=1`(大小写敏感) / `word=1`(全字匹配) / `stream=1`(SSE 流式: `start → result* → done`, 否则一次 JSON) / `project_id` / `range`(1d|7d 默认|30d|all, 按 session 创建时间收窄候选) / `candidates`(1–600, 默认 200) / `limit`(1–100, 默认 50) / `max_fragments`(1–5, 默认 3).
  ```bash
  # 一次性 JSON
  curl -sS "${BASE}/api/search?q=deploy-version" \
    -H "Authorization: Bearer ${TOKEN}"
  # 流式, 限定项目 + 30 天
  curl -N "${BASE}/api/search?q=README&project_id=abc12345&stream=1&range=30d" \
    -H "Authorization: Bearer ${TOKEN}"
  ```

- **`GET /api/profile/tour-first-login-seen`** / **`POST /api/profile/tour-first-login-seen`** — 查询/标记当前用户是否已看过首登引导. 返回 `{ seen: boolean }`.

- **`GET /api/profile/scene-seen/:scene`** / **`POST /api/profile/scene-seen/:scene`** — 查询/标记某场景的首触引导; `:scene` 白名单 `admin-center / research-page / session-page / self-cognition`.

---

## 3. 常见操作一条龙

下面这套顺序演示了"从登录到发一条小莫消息"的最小可工作流,你可以整段贴到 shell 跑(替换 `${BASE}` 与密码):

```bash
export BASE="http://localhost:45614"

# 1) 登录拿 token
export TOKEN=$(curl -sS -X POST "${BASE}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"your_password"}' | jq -r .token)

# 2) 看自己可见的项目
curl -sS "${BASE}/api/projects" -H "Authorization: Bearer ${TOKEN}" | jq

# 3) 在项目 abc12345 下新建 Issue
ISSUE=$(curl -sS -X POST "${BASE}/api/projects/abc12345/issues" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"title":"整理 README","description":"把 README 改清楚"}' | jq -r .id)
echo "issue=$ISSUE"

# 4) 在 Issue 下新建 Session(不自动启动)
SESSION=$(curl -sS -X POST "${BASE}/api/issues/${ISSUE}/sessions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"name":"整理 README","description":"扫描并修订","model":"codex","language":"zh"}' | jq -r .session_id)
echo "session=$SESSION"

# 5) 给 Session 发第一条消息, 启动 agent
curl -sS -X POST "${BASE}/api/sessions/${SESSION}/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"content":"请扫一遍项目并重写 README, 突出运行方法与目录结构"}' | jq

# 6) 监听 SSE 看 agent 进度
curl -N "${BASE}/api/sessions/${SESSION}/events" \
  -H "Authorization: Bearer ${TOKEN}"
```

如果你想直接用小莫:

```bash
curl -sS -X POST "${BASE}/api/assistant/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"content":"帮我把上面的 Session 起一下"}' | jq
```

---

## 4. 与 `SKILL.md` 的分工

- `SKILL.md` 描述"小莫是谁、能做什么、什么时候该用 `create_session`、什么时候该用 `search_projects`".
- 本文件是"调用清单": 任何一项"小莫动作"在执行前都可以先在这里对到一条 curl, 确认 URL / method / body 后再发给小莫确认.

换句话说: **小莫做的事 = 这里的一条 curl**. 让小莫动作时, 把对应 curl 的 method / 路径 / body 翻译成自然语言, 让用户确认即可.
