# 使用指南 - 添加远程算力（aimux remote）

‍

> 把一台或多台远端 SSH 机器登记成**项目级 Memory**，之后在该项目新建执行会话时，智能体就能一句话调度它们 —— 例如 `aimux new --remote <Host> --cwd <远程路径> --name <会话名>`。
>
> 主机名、路径、状态和硬件都会随环境变化，所以这里生成的是**记忆（Memory）而不是技能（Skill）**；私钥路径这类敏感信息也只存在记忆里。

### 1. 进入项目的「项目级 Memory」

打开任意项目，在右侧**项目设置**里找到「项目级 Memory」卡片，点击青色的【**添加远程算力**】按钮。

![image](https://serve.gptacademic.cn/publish/auto/tutorial/04_add_remote_server_01_memory_panel.png)

### 2. 弹窗总览

点开后弹出「添加远程算力」窗口，分左右两栏。左栏是远程机器清单与操作，右栏是新增表单与记忆预览。

![image](https://serve.gptacademic.cn/publish/auto/tutorial/04_add_remote_server_02_modal_overview.png)

- **① 远程机器清单**：自动读取本机 `aimux remote` 列表与 `~/.ssh/config`，`reachable` 表示已通过免密 SSH 探测，`auth-required` 表示还需要处理登录认证。
- **② 全选 / 刷新**：批量勾选，或重新拉取最新清单。
- **③ 连通测试**：确认主机名（Host）当前是否可达，建任务前先测能减少无效等待。
- **④ 硬件探测**：探测 GPU / CPU / 内存摘要，让后续智能体判断哪些任务该走 GPU。
- **⑤ 新增 remote**：清单里没有的目标机器，在这里录入 `Alias / HostName / SSH user / Port / IdentityFile`。
- **⑥ 记忆预览**：勾选机器后，实时生成将要写入的 Markdown 记忆。
- **⑦ 创建记忆**：确认后点这里写入。

### 3. 勾选 → 测试 → 探测硬件 → 填工作目录

- 勾选要授权给本项目的远程机器（**①**）。
- 点【**测试**】确认可达；点【**硬件**】探测算力（结果会回填到该行）。
- 在每台机器下填写默认**远程工作目录**（**②**）：可手填，也可点【浏览】在远端真实路径里选，或用快捷 `~` / `/workspace` / `/root` / `/home`。
- 清单里没有的机器，在右侧表单填好（**③**），点【添加并探测】即可加入清单。
- 下方预览（**④**）会随勾选实时更新。

![image](https://serve.gptacademic.cn/publish/auto/tutorial/04_add_remote_server_03_interact.png)

### 4. 创建项目 Memory

确认预览无误后，点右下角【**创建项目 Memory**】。

![image](https://serve.gptacademic.cn/publish/auto/tutorial/04_add_remote_server_04_create.png)

### 5. 记忆已写入，新会话自动带上

记忆出现在「项目级 Memory」列表中。之后在该项目**新建执行会话**时，这条记忆会作为上下文自动带上 —— 智能体就能按记忆里的格式调度远端算力。

![image](https://serve.gptacademic.cn/publish/auto/tutorial/04_add_remote_server_05_result.png)

‍

> 小贴士：记忆在**创建会话时**定型带入；机器配置变化后，重新生成一次记忆即可，无需改动已有会话。
