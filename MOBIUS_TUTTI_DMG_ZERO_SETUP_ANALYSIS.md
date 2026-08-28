# Mobius 对标 Tutti：DMG 安装与 Codex 零配置分析

> 分析日期：2026-08-27
> 范围：只分析桌面分发、本机 Provider 发现、登录态复用、模型目录、workspace 与任务启动链路；`MOBIUS_UI_SIMPLIFICATION_PLAN.md` 仅作为产品背景，不在本文重写 UI 方案。
> 结论口径：“零额外配置”不等于“什么都不装、什么账号都不登录、没有目录也能改项目”，而是**用户的 Mac 已安装并登录官方 Codex 时，安装 DMG 后不再配置 Mobius 后端、API Key、Node 或 tmux，即可选择文件夹并发出第一条可执行消息**。

## 一、结论先行

**Mobius 目前不能交付 Tutti 式的端到端体验。**原因不是缺 Codex 检测代码，而是当前 DMG 是“远程 Web UI + 本机 aimux”的薄壳：Codex 检测、模型目录和 Codex 会话都在运行 `mobius/server.js` 的机器上执行，因此远程服务器看不到桌面用户的 `PATH`、`HOME`、`~/.codex` 和本机 Codex。要达到目标，缺的是一层**由 Electron 安装、启动和监管的本地完整 Agent runtime**；仅把检测函数接到桌面 UI 不足以完成任务。

三档判断如下：

| 档位 | 判断 | 对应层 |
| --- | --- | --- |
| **现在就能做到** | 能构建 macOS DMG/ZIP；仓库已有 Developer ID 签名、公证、staple/校验的手工链路。独立部署的 Mobius server 若恰好就在同一用户的 Mac 上，也已有 Codex/Claude CLI 检测、官方登录态复用、Codex `app-server model/list` 和 native 模型选择。 | “可打包”与“服务端本机检测”分别成立，**端到端不成立**。当前正式 GitHub Release 流程仍只发布 ZIP 且说明 macOS 未签名，所以“仓库具备能力”不等于“现有发布渠道已交付签名 DMG”。 |
| **现有代码拼一下能做到** | 可把现有 Electron、Mobius server、前端静态资源、SQLite 初始化、provider detector/catalog/model registry 和文件夹选择拼成一个“本机版 beta”；如果继续沿用现有执行器，仍要求本机另装 `tmux`，并要解决原生 Node 依赖签名与本地免登录引导。 | 可以较快得到“本地 UI + 本地后端 + 能发现本机 Codex”的安装包，或继续得到“薄壳 + 远程任务 + aimux”的安装包；**不能仅靠拼装兑现只预装 Codex 即闭环的零配置承诺**。 |
| **做不到 / 架构差一层** | 当前薄壳无法让远端 `mobius/server.js` 直接复用用户 Mac 的 Codex 登录态；aimux 是远程工具/文件节点，不是本机 Codex 会话宿主。若要求“已装且已登录 Codex → 安装 DMG → 打开 → 选文件夹 → 发消息”，还需本地业务 runtime、可靠的本地启动/鉴权/状态目录，以及不依赖外部 tmux 的 Codex 会话适配。 | 差的是**本地完整 runtime 和任务执行边界**，不是单纯缺“检测”按钮。 |

推荐形态是：**本机一体化 Electron，内嵌并监管本地 Mobius server；native Codex 走直接 `codex app-server` 会话适配。**继续“薄壳 + 本机 agent node”会保留远程 Mobius 服务与账号依赖，还必须新造远程控制协议，把模型发现、线程生命周期、事件、权限和本地 workspace 全部下沉到 node；现有 aimux 只覆盖远程工具调用，离这个边界仍有明显距离。

## 二、Tutti 的承诺实际包含哪些层

### 2.1 第 1 层：可安装、签名和公证的桌面制品

官方中文 README 直接提供 “Local macOS（Universal）” DMG 下载，而不是要求用户先部署 tuttid（`examples/tutti/README.zh-CN.md:30-40`）。其正式 release 文档列出 x64、arm64、universal 的 DMG/ZIP、更新元数据与校验和（`examples/tutti/docs/conventions/desktop-release.md:118-158`）。

签名链路也不是一个 `electron-builder --mac` 命令而已：

- `examples/tutti/apps/desktop/package.json:67-85` 启用 Hardened Runtime，声明 `tuttid`、`tutti`、`rtk` 为需要签名的内部二进制，并要求 DMG 签名。
- `examples/tutti/tools/scripts/build-desktop-package.sh:110-176` 对签名构建强制检查 Apple 公证凭据；分别构建 arm64/amd64 的 `tuttid` 和 `tutti`，用 `lipo` 合成并验证 universal binary。
- `examples/tutti/apps/desktop/scripts/notarize-mac-dmg-artifacts.mjs:132-175` 对 DMG 调用 `notarytool submit --wait`，带重试与拒绝日志，随后 staple、validate，并用 `spctl` 验证安装制品。

因此 Tutti 的“DMG”包含可重复发布、签名、公证、架构覆盖与校验，不只是本机能生成一个磁盘镜像。

### 2.2 第 2 层：DMG 内已有本地业务 runtime，而非远程网页薄壳

Tutti 的核心结构是：

```text
Electron renderer
  -> Electron main 监管本机 daemon
  -> 127.0.0.1:随机端口 + 每次启动 bearer token
  -> 本机 tuttid（业务层）
  -> 本机 Codex app-server / Claude SDK runtime
  -> 本机项目目录或托管临时目录
```

`examples/tutti/docs/architecture/desktop-transport.md:10-35,51-79,198-206` 明确 `tuttid` 是本地产品唯一业务层，Electron main 负责 daemon supervision；daemon 绑定 `127.0.0.1:0`，写出实际端口和单次 bearer，桌面自动生成并注入 token。`examples/tutti/apps/desktop/src/main/daemon/tuttidManager.ts:797-839` 从 `Contents/Resources/bin/tuttid` 解析打包后的 daemon 并启动。

DMG 资源不只含 Electron UI：

- `examples/tutti/apps/desktop/package.json:21-59` 把 `tuttid` daemon、`tutti` CLI、browser MCP、Claude SDK sidecar、managed-uv 目录和 RTK 放入 `Resources/bin`；after-pack 再复制 sidecar/browser MCP 的 vendored `node_modules`。
- `examples/tutti/tools/scripts/build-desktop-package.sh:219-231` 让 browser MCP 可离线使用，并把 Claude SDK sidecar 打包；**Claude native binary 明确不进包**，由 tuttid 运行时配置。
- `build-desktop-package.sh:248-277` 对 macOS 特意不装入上游未签名的 `uv/uvx`，避免公证递归校验失败，保留校验后的动态下载 fallback；`build-desktop-package.sh:280-302` 则准备双架构 RTK。
- `examples/tutti/services/tuttid/service/managedruntime/runtime.go:23-40,139-171,189-249,297-340` 定义并下载校验过的 Python/Node/RTK runtime profile；`examples/tutti/services/tuttid/wiring_managed_runtime_preload.go:11-20` 后台预热 Node profile。

所以它是**本地完整产品，但不是完全离线产品**。本地 daemon/CLI/sidecar/RTK 随包交付；部分托管 runtime 可能首启下载。Claude 更特殊：`examples/tutti/services/tuttid/service/agentstatus/claude_binary.go:3-20,109-194` 按 vendored SDK manifest 固定版本和 SHA-256，从 CDN 下载约 50 MB 的原生 binary，npm registry 作为 fallback。

### 2.3 第 3 层：在 GUI 进程环境里发现真正的用户 CLI

Finder 启动的 GUI 通常拿不到交互 shell 的完整 `PATH`。Tutti 为此不是只做 `which codex`：

- `examples/tutti/apps/desktop/src/main/daemon/userShellEnv.ts:3-52` 以超时方式读取 zsh/bash/fish 登录 shell 环境，只接收 PATH、代理和包管理器相关白名单变量。
- `examples/tutti/apps/desktop/src/main/daemon/tuttidManager.ts:731-795` 合并 Electron 环境、用户登录 shell 环境、Tutti 管理 runtime 路径后启动 daemon。
- `examples/tutti/services/tuttid/service/agentstatus/codex_runtime_discovery.go:37-105,227-265` 枚举 PATH 以及 Bun、pnpm、npm、Homebrew 等安装来源，解析 symlink 和 package root，而不是命中第一个名字就结束。
- 多个可用 Codex 安装不是静默猜选：`examples/tutti/docs/conventions/troubleshooting/agent-provider-setup.md:485-537` 规定一个 ready candidate 可自动选择；两个及以上会阻塞并要求用户选择；已保存项失效也要求重选。

这解决的是“GUI 环境看不到终端 CLI”和“同机多份 Codex”的问题。

### 2.4 第 4 层：复用官方登录态，并用 Provider 协议确认可用性

Codex provider 描述符把 runtime 定义为 `codex app-server`，默认认证目录是 `CODEX_HOME` 或 `~/.codex`，监看 `auth.json/config.toml`，并支持导入默认 `~/.codex` 下的历史 session（`examples/tutti/packages/agent/daemon/providerregistry/codex.go:12-93,157-178`）。这说明 Tutti **复用同一用户 HOME 下的官方状态，不要求把 ChatGPT/Codex 密钥再导入一份 Tutti 配置**。

认证并非只看文件是否存在：

- `examples/tutti/services/tuttid/service/agentstatus/codex_auth.go:16-40` 使用 Codex app-server probe。
- `examples/tutti/packages/agent/daemon/runtime/codex_appserver_probe.go:160-214` 发送 `initialize`、`initialized`、`account/read`，且明确是不创建线程、不产生 turn 的只读探测。
- `examples/tutti/services/tuttid/service/agent/codex_model_catalog.go:175-289` 通过 `model/list` 得到真实模型目录。
- `examples/tutti/packages/agent/daemon/runtime/codex_appserver_session.go:35-155` 在会话启动时先过账户/认证门；未认证返回 `auth_required`，认证后才选模型并 `thread/start`。

Claude 侧同样监看 `CLAUDE_CONFIG_DIR`/`~/.claude` 与 `~/.claude.json`，调用 `claude auth status`（`examples/tutti/packages/agent/daemon/providerregistry/claude_code.go:28-74,155-163`）。但“复用 Claude 登录态”不等于直接拿用户任意版本的 Claude binary 跑会话；Tutti 的生产会话由 vendored SDK sidecar 配合上述固定版本、运行时 provision 的原生 binary。

### 2.5 第 5 层：workspace、项目目录和无需 Node/tmux 的启动路径

- **Tutti 账号**：源码中未发现本地 Codex/Claude Agent 启动以 Tutti 账号登录为前置；signed-out 状态仍是正常 workspace UI，只显示登录按钮（`examples/tutti/apps/desktop/src/renderer/src/features/workspace-workbench/ui/WorkspaceAccountMenu.tsx:327-395`）。账号状态明确参与 connector market admission（`examples/tutti/apps/desktop/src/renderer/src/app/windows/workspace/createWorkspaceWindowContainer.ts:235-270`），也用于 Tutti Agent、积分/商业能力。这个“不要求”是对本地 native Agent 主路径的源码推断，不代表所有云端或商业功能免账号。
- **workspace**：Tutti workspace 是本地 SQLite 中的逻辑工作区，不等于宿主目录；启动接口会初始化默认 workspace（`examples/tutti/docs/conventions/workspace-domain.md:7-20,121-150`），用户不必先部署或选择一台远程 workspace server。
- **项目目录**：创建 Agent session 需要 workspace/provider，但 `cwd` 可空（`examples/tutti/services/tuttid/service/agent/service_create.go:22-45,126-158`）；空目录场景由 `examples/tutti/services/tuttid/service/agent/session_directory.go:17-50` 在 state root 下分配托管 session 目录。桌面层也识别 `~/Documents/tutti/session-<uuid>` 为 “No project” 目录（`examples/tutti/apps/desktop/src/renderer/src/features/workspace-user-project/services/internal/desktopWorkspaceUserProjectService.ts:632-668`）。
- **Node**：用户不需要预装 Node；Tutti 有 managed runtime 下载、缓存和 PATH overlay。不过首次缺失 runtime 或需要安装 Provider 时仍可能联网。
- **tmux**：Tutti Agent session 走 provider adapter/app-server/SDK，不以 tmux TUI 为会话内核。对 `examples/tutti` 全仓搜索独立单词 `tmux` 无命中。

### 2.6 “无需额外配置就能干活”的真实边界

| 初始状态 | Tutti 的表现与边界 |
| --- | --- |
| 本机已有且已登录 Codex | 自动发现候选；唯一 ready 候选可自动选；读取同一 `HOME/CODEX_HOME` 登录态；app-server 确认账号、列模型、启动线程。此时最接近宣传中的“装完就能干活”。 |
| 没装 Codex | 不能凭空启动 Codex。provider 描述符提供基于 managed npm 的安装器（`examples/tutti/packages/agent/daemon/providerregistry/codex.go:12-80`，以及 `examples/tutti/services/tuttid/service/agentstatus/installer_codex_cli.go:36-60,83-145`），用户仍需触发安装且需要网络；Codex binary 不在 DMG 内。也可改选其他已可用 Agent。 |
| 装了 Codex、没登录 ChatGPT/Codex | `account/read` 会得到 `auth_required`，不会创建 thread；用户必须完成官方 Codex 登录。Tutti 可以承接登录动作，但不能免除 Provider 账号/订阅。 |
| 同时有多份可用 Codex | 为避免版本/账号混用，需要用户选择，不属于绝对零点击。 |
| 没有项目目录 | 可进入托管的 no-project session 目录，适合问答或从空目录创建内容；它不能修改一个并不存在的既有仓库。要在既有工程工作仍要选择/导入目录。 |
| 无网络且缺 managed runtime/Claude native runtime | 首次准备可能失败；“本地版”不等于所有依赖都离线内置。 |

README 对边界的表述也较诚实：Apps 复用既有 Agent 订阅（`examples/tutti/README.zh-CN.md:141`），不收取额外 Agent 费用（`:161-168`）；若用户没有现有 Agent 订阅，可使用 Tutti Agent 的早期访问/未来计量能力，但 Tutti 本身不替代 coding agent（`:224-244`）。

## 三、Mobius 现在做到哪一层、卡在哪一层

### 3.1 DMG、签名、公证：能力已有，现有产品仍是薄壳

Mobius 已具备相当多的 macOS 制品基础：

- `mobius/desktop/electron-builder.yml:1-52` 配置 DMG/ZIP、Hardened Runtime、entitlements、Developer ID 自动选择和 notarize team ID，并明确提醒缺凭据时 electron-builder 可能静默跳过公证。
- `.cursor/skills/mobius-mac-signing/SKILL.md` 与 `mac-signing-kit/scripts/03-build-signed-dmg.sh:66-123` 已覆盖证书检查、构建、DMG 签名、`notarytool --wait`、staple/validate、挂载后 app 验证。`docs/macOS桌面客户端签名与分发修复方案.md` 记录过从“能打包但用户打不开”到 Developer ID + 公证 + 验收的修复路径；它应视为修复方案/能力说明，不应反推所有历史产物都已合规。

但发布闭环仍有两处事实差距：

1. `.github/workflows/desktop-release.yml:1-15,115-139,168-217` 目前只收集并发布三个 ZIP，release notes 仍写“macOS 包未签名”；没有上传 DMG、签名密钥导入、notary/staple 或独立验证步骤。这与当前 builder 配置和签名工具包存在漂移。因此可以说“仓库能做签名公证 DMG”，不能说“正式流水线现在就在稳定交付它”。
2. `mobius/desktop/README.md:1-11` 明确桌面端是 Fork B 薄壳：登录前是本地页，登录后 `loadURL` 远程 Web UI，本机只运行 `aimux reverse connect`。`electron-builder.yml:6-21` 的 app 文件只有 Electron `out`、manifest、Python 和图标，没有 `mobius/server.js`、backend、构建后的完整 frontend、SQLite schema 或 Agent session runtime。

也就是说，当前 DMG 即使签名和公证完全成功，仍只是**可安装的远程 UI 客户端**，不是 Tutti 那种本机完整产品。

### 3.2 当前桌面数据流：本机 aimux 不等于本机 Codex

```text
用户 Mac
  Mobius Electron -> loadURL(远程 Mobius Web UI)
       |
       +-> 本机 Python venv -> aimux reverse connect ------------------+
                                                                    |
远程/中心 Mobius server                                             |
  provider-cli-detection（看到服务器 HOME/PATH）                     |
  -> tmux window -> 服务器上的 Codex TUI                             |
  -> 可选 aimux MCP remote_* ----------------------------------------+
        才去操作用户 Mac 的文件/桌面能力
```

证据如下：

- `mobius/desktop/electron/main.ts:242-266,447-521` 向配置的远程 server 登录、把 JWT seed 到远程 origin 的 `cc-token`、启动 aimux 后加载远程 UI；`mobius/desktop/electron/lib/tab-manager.ts:163-183` 每个 tab 都是 `loadURL(origin + path)`。README 第 17 行仍称 Web UI 会二次登录，而当前 main 已 seed token；这是文档漂移，但两者都不改变“必须先有远程 Mobius 账号/服务”的事实。
- `mobius/desktop/electron/lib/python-runtime.ts:1-44,139-188` 只优先使用随包 Python，在 app userData 下建 venv，并首启 `pip install aimux`；`mobius/desktop/electron/lib/aimux-supervisor.ts:62-79` 执行的是 `aimux reverse connect <server>/aimux_bridge`。
- `mobius/desktop/electron/main.ts:967-1003` 已能选择/创建本机目录；`mobius/desktop/electron/lib/project-paths.ts:1-18,36-47,65-99` 将映射写进桌面 userData 与用户的 `~/.mobius`。这提供了本机文件入口，但没有把远程数据库里的 project `bind_path` 变成本机路径，也没有把远端 Codex TUI 的 cwd 迁到本机。
- `mobius/backend/services/pc-client-context.ts:37-54,148-166` 只把 aimux remote name 注入 server 侧 Agent 上下文，让 Agent 通过 `remote_*` MCP 操作客户端。它没有把 server 侧的 Codex process 迁到客户端。

因此，“桌面能访问本机文件”不能推出“桌面在本机运行 Codex”，也不能推出远端 detector 能看到本机 CLI。

### 3.3 Codex 自动检测：服务端实现已较完整，放置位置不对

Mobius 后端检测并非空白：

- `mobius/backend/services/provider-cli-detection.cjs:1-8,14-55` 对 Codex/Claude 做有界发现，分别执行 `codex login status` / `claude auth status`，并只向外部 CLI 传 PATH、HOME、CODEX_HOME、代理等安全白名单环境，避免泄漏服务端 JWT/数据库秘密。
- `provider-cli-detection.cjs:191-272` 以**当前 server 进程**的 `os.homedir()` 为 HOME，搜索 PATH、`~/.local/bin`、npm/pnpm/Bun/Volta/asdf/mise/nvm/fnm 和 Homebrew 目录，并补读 login shell PATH。
- `provider-cli-detection.cjs:380-467` 只有官方 status 明确 authenticated、native provider/模型开关允许时才把它标成 native ready；`CODEX_HOME` 默认是该进程用户的 `~/.codex`。
- `mobius/backend/services/codex-model-catalog.cjs:290-408,411-541` 使用 detector 缓存的绝对 Codex 路径启动 `app-server`，完成 `initialize`/`initialized`/`model/list`；失败时保留 last-known-good 或 compatibility fallback。
- `mobius/server.js:420-456` 在监听 HTTP 前并行 warmup provider status，并在 7 秒预算内预热 Codex catalog。普通用户的模型选择器经 `mobius/backend/routes/sessions.ts:179-192` 和 `mobius/frontend/src/components/session-model-picker.tsx:97-115` 消费该列表。

native 模式也不要求管理员先复制一套密钥：`mobius/backend/services/model-access.ts:49-58,454-470` 默认打开 native provider，开关只持久化 enabled，不导入登录态；`mobius/backend/services/model-registry.ts:138-230,477-537` 把已认证 native Codex 的 app-server 模型加入普通会话 picker。管理员可禁用/隐藏 native provider，专用渠道/profile 才涉及管理员导入配置或 API key。

问题是**进程归属**：上述 `os.homedir()`、PATH、`codex login status` 和 `app-server` 全在 `mobius/server.js` 所在机器执行。当前 Electron 不加载这些模块，也不把本机候选或认证协议代理给远端。因此：

- server 部署在 Linux/远程 Mac：检测的是服务器 Codex 与服务器 `~/.codex`。
- server 与用户恰好同机、同 OS 用户运行：才可能复用该用户本机登录态。
- 打包后 GUI 的 PATH 问题虽然 detector 已用 login shell 和已知目录部分缓解，但它只有被放进本机 runtime 后才有意义。

Tutti 的认证探测还比 Mobius 更强一层：Mobius ready 依赖 `codex login status`，只有模型目录使用 app-server；Tutti 用 app-server `account/read` 验证账号，并在同一协议里启动 thread。Mobius 若改成本地 app-server session，应统一这两条语义，避免 CLI status 与真实会话鉴权发生偏差。

### 3.4 “完成任务”仍有哪些前置条件

当前 Mobius native Codex 的实际会话执行不是上述 model catalog 进程，而是 tmux 中的 Codex TUI：

- `mobius/backend/agents/provider-cli-command.js:11-23` 规定 native Codex 不带专用 profile，直接使用同一 `CODEX_HOME/config.toml + auth.json`。
- `mobius/backend/agents/tmux-codex.js:1163-1279` 解析 authenticated native executable，以绝对路径构造 Codex CLI 命令，固定 server 侧 `HOME/CODEX_HOME`，写项目 trust，并在 tmux hub 创建窗口；`:1283-1315` 轮询 TUI 文本哨兵确认 ready。
- `mobius/backend/agents/tmux-operation-log.js:69-122,147-160` 直接 spawn 外部 `tmux -L`。tmux 没有被当前 DMG 打包。
- `mobius/backend/services/workspace.ts:29-70` 要求 session 必须关联 project，project 必须有 server 可见、存在且为目录的 `bind_path`；Mobius 没有 Tutti 的 no-project 托管 session 目录 fallback。

所以现状的前置条件是：

| 条件 | 当前是否仍需要 |
| --- | --- |
| 远程 Mobius 服务 | **需要**。薄壳必须登录配置的 server 并加载其 Web UI。 |
| Mobius 登录/用户 | **需要**。桌面先调用远程 `/api/auth/login`；即使 server 关闭密码登录，也仍依赖 server 中已有用户和本地自动登录配置（`mobius/backend/routes/auth.ts:32-62`）。 |
| aimux | 桌面远程节点路径**需要**；首启用内置 Python 建 venv 并联网安装 aimux，而不是 DMG 内已有可立即运行的固定 aimux artifact。 |
| Codex CLI 与 ChatGPT/Codex 登录 | native 模式必须存在于**会话执行机**，并在同一 HOME 下 authenticated。当前通常是服务器，不是桌面 Mac。 |
| tmux | `tmux-codex` 会话**需要**，安装包未提供。 |
| 项目路径 | 必须有 project + `bind_path`，且此路径对执行 server 可见。桌面选择的本机路径若仅作为 aimux remote target，并不自动成为 server 侧 Codex TUI 的 cwd。 |
| 管理员导入模型/密钥 | native Codex 默认开，不必额外导入密钥；但管理员可禁用/隐藏。使用 Mobius 专用 profile、渠道或其他 provider 时仍可能要求管理员配置和 API key。 |

## 四、为什么“接一下 detector”不够

自动发现至少要与下面四件事处在同一信任和进程边界：

1. 读取真实用户 `HOME/CODEX_HOME`，调用该用户安装的绝对 Codex 路径；
2. 运行 `account/read`、`model/list`，并持续监管 `thread/start`/turn/event；
3. 让 Codex 的 cwd 指向用户刚选择且获授权的本机目录；
4. 把会话状态、错误和中断可靠投影给 Electron UI。

当前 Mobius 只有第 1、2 项的**服务端版本**，第 2 项还只有 model list、没有完整 app-server 会话 adapter；第 3 项是 server `bind_path`；第 4 项围绕 tmux TUI 解析构建。把 detector 结果从 Electron 发给远端只会产生“远端知道本机有 Codex，却无法在本机启动和控制它”的半连接状态，还可能引入让远端任意启动本机进程的新安全面。

## 五、接近 Tutti 的最小可行方案

### 5.1 产品形态选择

选择**本机一体化 Electron（内嵌/监管 Mobius server）**，不选择“继续薄壳 + 本机 agent node”作为零配置主路径。

理由不是要复制 Tutti OS，而是复用 Mobius 当前最强的同机假设：provider detector、model registry、SQLite、workspace resolver 和 session runner 都假设 Provider 与 backend 共用 HOME 和文件系统。把 backend 放到桌面本机，比把这些能力拆成一个新的远程 agent protocol 更小、更可验证。远程协作/aimux 可以作为后续可选模式保留，但不应挡住本机首条消息。

### 5.2 P0：只做成“已装且已登录 Codex”的本机闭环

P0 的验收目标只有一条：**Mac 已安装并登录 Codex → 下载已签名公证 DMG → 拖入 Applications → 打开 → 选择文件夹 → 发送消息 → Codex 在该目录执行并返回结果**。建议包含：

1. **打包并监管本地业务进程**：将生产 frontend、`mobius/server.js`/backend、数据库 migration 和必须的运行依赖作为 app resources；Electron main 以 child/utility process 启动，绑定 `127.0.0.1:0`，生成每次启动 token，健康检查、崩溃重启、退出回收。renderer 只连 main 给出的 loopback endpoint，不接受局域网监听。
2. **本机单用户 bootstrap**：SQLite/state/log 放 `app.getPath('userData')`，首次启动原子初始化；native local 模式建立内部单用户 identity，不要求用户先准备远程 Mobius URL、管理员账号、JWT secret 或数据库目录。它不是绕过远程多用户系统的认证，而是另定义一个仅 loopback 可达的产品模式。
3. **复用现有检测和模型目录**：让 `provider-cli-detection.cjs` 与 `codex-model-catalog.cjs` 真正在 Electron 用户的 Mac 上运行；候选解析后始终用绝对路径。P0 至少处理零个、一个、多个候选：零个给明确安装指引；一个自动选；多个展示路径/版本并让用户选择，不静默猜测。
4. **统一认证 probe**：在真正启动会话前以 app-server `account/read` 为最终权威；`codex login status` 可保留作快速提示。未登录只引导用户运行官方登录，不创建或复制密钥。
5. **文件夹即项目**：Electron picker 返回的本机目录直接在本地 SQLite 建立/更新 project + `bind_path`，进行存在性、目录权限和 TCC 错误检查；不要要求用户理解 server workspace、aimux remote 名或管理员绑定路径。
6. **新增直接 Codex app-server 会话适配**：复用现有 JSONL framing、超时与 `model/list` 代码，但新增 `thread/start/resume`、turn、event、中断、权限与崩溃恢复。P0 不再以 tmux TUI 文本和键盘模拟为本机主路径。否则就必须把“另装 tmux”写进前置条件，无法满足本节的零额外配置定义。
7. **正式 DMG 验收**：把 `mac-signing-kit` 能力移入实际 release job，分别验证 arm64/x64（是否另做 universal 由体积和原生依赖决定）；对 `.app`、所有 Mach-O、DMG 做 `codesign --verify --deep --strict`、`spctl`、notary/staple 校验，并在一台没有开发证书、从未安装 Mobius 的干净 Mac 上跑上述首条消息场景。

P0 会复用很多现有代码，但第 1、2、5、6 项是产品集成/架构工作，不能包装成纯配置改动。特别是第 6 项决定“拼一下本地 server beta”与“真的只需 Codex”的差别。

### 5.3 P1：补齐可靠性，而不是扩建 Tutti OS

1. 增加 provider 状态页：展示候选绝对路径、版本、认证账号类型、最终 `CODEX_HOME`、失败命令和可复制诊断；不展示 token/auth 文件内容。
2. 提供“未安装 / 未登录”的引导与刷新：打开官方安装/登录说明或受控终端动作，完成后重新 probe；仍不在 DMG 内捆绑 Codex。
3. 支持 no-project 临时目录、最近文件夹和权限失效后的重新授权；随后才考虑 Git worktree 等高级能力。
4. 完善 app-server session 的 resume、流式事件、审批、取消、升级兼容、资源上限和孤儿进程回收；把 catalog fallback 与“可以实际启动会话”分开显示，不能因有 compatibility model list 就显示 ready。
5. 收紧 local server attack surface：随机 loopback 端口、短期 bearer、Origin/CSRF 检查、renderer context isolation；明确 local/remote 两种模式，远程账号、aimux 与云同步都应是用户主动开启的增量能力。
6. 建立签名制品 SBOM/校验和、自动更新 channel、旧版本回滚策略和真实 Gatekeeper/TCC 测试矩阵；修复当前 builder、签名 kit、发布 workflow 与 README 之间的漂移。

明确不纳入 P0/P1：Tutti 的 Dock/Launchpad、多 Agent OS、connector market、VM host、应用生态。本文目标只是本地 Codex 的一条完整任务链路。

## 六、macOS 打包与登录态复用的具体风险

### 6.1 PATH 与 HOME 隔离

- 从 Finder/Dock 启动的 Electron 不继承终端初始化后的 PATH。现有 detector 的 login-shell + well-known dirs 值得复用，但必须在**本地 child process 的实际用户上下文**运行；不要把 Electron 的 `resources` 或 `userData` 错当 HOME。
- 使用 `os.homedir()` 得到真实用户 HOME，尊重用户显式 `CODEX_HOME`，默认才是 `$HOME/.codex`；解析成功后用绝对 executable 启动，避免随后 PATH 漂移或命中恶意同名 binary。
- 只传 Provider 所需环境白名单。现有 `provider-cli-detection.cjs:42-64` 的方向正确；不要把 Mobius JWT、数据库口令、管理员模型密钥传播给 native Codex。
- 不读取、不复制、不上传 `~/.codex/auth.json`。让官方 Codex process 在同一 HOME/CODEX_HOME 自己读取；远程模式尤其不能把本机 auth 状态同步到 server。

### 6.2 Hardened Runtime、公证和原生依赖

- Mobius server 依赖含 `better-sqlite3`、`node-pty` 等原生模块（`mobius/package.json:50-73`）。把 server 放进 Electron 后，必须为 Electron ABI 和目标架构重建，确保所有嵌套 Mach-O 都由同一 Developer ID 正确签名；不能只签最外层 `.app`/DMG。
- 当前 DMG 还含 Python runtime，首次又把 aimux 安装到可写 userData。任何需要随包运行的 dylib/可执行文件都必须在公证前固定并签名；运行时下载的内容只能放 app bundle 外的版本化缓存，做来源、哈希、权限与替换校验，不能修改已签名的 `.app`。
- `disable-library-validation`、JIT、unsigned-executable-memory 等 entitlement 会扩大攻击面。当前配置因 Electron/Python而开；本地 server 方案应逐项真机验证后删除不必要权限，不能永久以“先能跑”为理由保留。
- 用户选 Desktop/Documents/外接盘可能触发 TCC 或权限错误。文件 picker 是用户意图入口，但仍要把“目录不可访问/只读/权限后来撤销”作为正常产品状态处理。

### 6.3 绝不应该为了“零配置”塞进 DMG 的内容

- **不要内嵌、改名或 fork Codex binary 来替代用户已安装且已登录的官方 CLI。**这会引入版本更新、许可、供应链、签名、公证和登录态分叉，并破坏“复用官方订阅”的产品承诺。
- 不要打包、复制、迁移或上传用户的 `~/.codex/auth.json`、ChatGPT session、API key；不要把管理员渠道密钥预置到本地版。
- 不要为沿用当前执行器而捆一套 Homebrew、shell 环境或完整 tmux 工具链。直接 app-server adapter 才是更小、可测试的 Provider 边界。
- 不要把远程 Mobius 服务、aimux、云账号、connector market 或多租户控制面变成本机 native Codex 首条消息的必选依赖。

## 七、对“零额外配置”的诚实定义与最终判定

Mobius 可以对外承诺的最窄定义应是：

> **用户的 Mac 已安装官方 Codex 且已完成官方 ChatGPT/Codex 登录；Mobius 不要求另填 API Key、不要求自建/选择 Mobius 后端、不要求安装 Node/tmux。用户安装已签名公证的 DMG，打开后选择一个有权限的文件夹并发消息，即可由本机 Codex 在该目录完成任务。**

这个定义必须同时公开以下非目标：

- 没装 Codex：先安装官方 Codex；Mobius 可以发现、解释和引导，不能声称已经可执行。
- 没登录 Provider：先完成官方登录；Mobius 不替代 ChatGPT/Codex 账号或订阅。
- 没有项目目录：P0 的明确路径是“选择/新建一个文件夹”；P1 可提供托管临时目录，但不能声称能修改不存在的项目。
- 首次下载、macOS 权限、企业代理或多份 Codex 安装仍可能产生一次性选择/授权，这些属于可解释的系统边界，不应伪装成失败或偷偷导入凭据。

按这一定义，**当前答案是否定的**：现有 DMG 打开后仍要远程 Mobius 服务/账号/aimux；Codex 与 tmux 在 server 侧；桌面选择的目录不是 server TUI 的天然 cwd。完成 P0 所列本机 runtime、单用户 bootstrap、folder binding、直接 app-server session 与正式签名发布后，才可以用一条端到端验收证明该承诺成立。

## 八、证据强度与审计说明

- 本文以当前源码行为优先于陈旧说明。例如桌面 README 的“Web UI 二次登录”与 `electron/main.ts` 的 token seed 有漂移；发布 workflow 的“未签名 ZIP”也与 builder/签名 kit 的新能力有漂移，均按两者并列说明。
- `docs/macOS桌面客户端签名与分发修复方案.md` 是历史修复方案，证明已有设计和工具能力，不等同于当前 GitHub Release 已执行完整签名公证。
- Tutti 为嵌套 git 仓库，本次只读分析；Mobius 现有未提交改动没有被回滚或修改。
- 本文没有复述 `MOBIUS_UI_SIMPLIFICATION_PLAN.md` 的界面重构方案，只采用其“首条消息应成为默认主路径”的背景目标。
