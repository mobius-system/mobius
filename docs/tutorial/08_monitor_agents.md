# 如何在管理中心监控智能体

‍

管理员可以在「管理中心 → 运行监控」里实时查看所有正在跑的智能体：每个 tmux 窗口的状态、所属会话、PID、最后活动时间和提问数都一目了然，还能直接关掉卡死的窗口。本篇带你走完一遍。

## 1. 从用户菜单进入管理中心

- 点击页面**右上角的头像 / 用户名**，展开用户菜单。
- 只有**管理员账号**看得到「管理中心」入口，点它进入。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/08_monitor_agents_01.jpg)

## 2. 切到「运行监控」标签

- 管理中心顶部是标题栏（左有返回按钮），下方一排功能标签。
- 点**运行监控**进入智能体监控视图——它会每 5 秒自动刷新一次。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/08_monitor_agents_02.jpg)

## 3. 看全局统计卡片

- 进入后先看顶部一排统计卡片：**5 小时 / 2 分钟提问数**、Codex / Claude Code 各自的活跃窗口数、以及当前**执行中**的窗口数。
- 统计窗口默认覆盖最近 **5 小时**。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/08_monitor_agents_03.jpg)

- 卡片下方有一个**「显示已关闭」开关**：打开后会一并列出已经结束的 tmux 窗口（含历史 Closed 记录），方便回溯。

## 4. 查看 Codex 后端的窗口表

- 每个**后端**（Codex / Claude Code）各占一个独立区块，右上角实时显示「活跃 / Open / Busy / Closed」计数。
- 表里**一行一个 tmux 窗口**，关键列含义：

![image](https://serve.nutshellai.cn/publish/auto/tutorial/08_monitor_agents_04.jpg)

- **① 区块概览**：Codex / Claude Code 各自的活跃、Busy、Closed 计数。
- **② 状态列**：药丸标签四种状态——`执行中 (Busy)`、`空闲中 (Idle)`、`进程终止 (Terminated)`、`已关闭 (Closed)`，颜色不同一眼可辨。
- **③ Session 列**：会话名 + 触发它的用户。
- **④ 运行时列**：tmux 窗口的 PID、当前 cmd、agent id，判断进程是否还活着。
- **⑤ 活动列**：最后一次活动的时间（相对 + 绝对）。
- **⑥ 5 小时提问数**：该窗口在统计窗口内的提问计数。
- **⑦ 操作列**：可关闭的窗口会出现红色电源按钮，点一下即可关掉卡死的 tmux 窗口。

## 5. Claude Code 区块同理

- 往下滚是 **Claude Code** 后端区块，格式与 Codex 完全一致。
- 重点看**状态药丸**：`运行-执行中` 表示正在干活，`运行-空闲中` 表示进程活着但没在工作；如果出现`进程终止`或`已关闭`，说明这个智能体已经停了。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/08_monitor_agents_05.jpg)

## 6. 自动刷新 & 手动刷新

- 运行监控**每 5 秒**自动拉取一次最新状态，无需手动操作。
- 想立刻刷新时，点标题栏右上角的**刷新按钮**即可。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/08_monitor_agents_06.jpg)

‍

> 一句话总结：管理中心 → 运行监控，**全程自动刷新**，看每个智能体窗口的状态、会话、PID 和提问数，卡死的窗口直接在操作列关掉。
