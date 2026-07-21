# 使用指南 - 声明可合作计算机

‍

> 当某个任务临时需要远程算力、或要让当前会话的智能体去操作另外几台机器时，你可以**一次性声明**哪些计算机可与它合作——把一份「可合作计算机清单 + aimux 用法」作为一条普通消息发给当前 agent，它即可用 `aimux` 连接这些机器。
>
> 与[添加远程算力](04_add_remote_server.md)的区别：那条会**写入项目 Memory**、之后每个新会话都带上；而「声明」只对**当前这一个会话**生效，**不写 Memory**，用完即止、不污染项目长期记忆。

### 1. 在会话工具栏点「可合作计算机」

打开任意一个执行会话（Session），在底部输入区的工具栏里，找到琥珀色的【**可合作计算机**】按钮（网络图标，位于「打开终端」与「修改模型并继续」之间）。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/30_declare_cooperable_01_toolbar.jpg)

### 2. 勾选要声明的远程计算机

弹出的「声明可合作计算机」窗口读取本机 `aimux remote` 列表（即 `~/.ssh/config` 里登记的主机与已连接的桌面端 bridge）。勾选你授权给当前会话的那些机器，右侧会实时生成将要发送的声明文本。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/30_declare_cooperable_02_modal.jpg)

- **① 远程计算机清单**：`reachable` 表示已免密探测通过，`auth-required` 表示网络可达但登录认证未通，`connected` 是已连接的桌面端 bridge。
- **② 勾选**：可逐台勾选，也可「全选」。
- **③ 发送内容预览**：勾选后实时生成 Markdown 声明（含主机表 + aimux 使用说明）。

### 3. 确认 → 发送给当前会话

勾选完毕、确认预览无误后，点右下角【**发送给当前会话**】。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/30_declare_cooperable_03_checked.jpg)

> 注意顶部提示：**点击确认后，内容将作为一条消息发送给当前会话的 agent，不会写入 Memory。**

### 4. 声明已作为消息发给 agent

声明文本作为一条普通用户消息进入对话，开头是 `【用户声明：以下计算机可与当前会话的 agent 合作……】`。当前 agent 读到后，即可在本次任务中用 `aimux new --remote <Host> ...` 连接并调度这些机器。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/30_declare_cooperable_04_sent.jpg)

‍

> 小贴士：声明是**一次性的**——只对当前会话有效，换会话即失效。若某台机器几乎所有任务都要用，改用[添加远程算力](04_add_remote_server.md)写进项目 Memory 更省事；只在本任务临时用一下，就用「声明」。
