# 网页终端：打开目录终端，也能直看 Agent 后台

‍

> 在任意会话（Issue 的 Session 或 Research 的 Agent）里，不用切到外部 SSH，点两下就能弹出一个网页终端。你可以选择进入当前项目目录跑命令，也可以直接 attach 到当前 Agent 的 tmux 后台，看它真实在做什么。

## ① 点击「打开终端」

进入任意会话后，在会话工具区点击「**打开终端**」。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/26_web_terminal_agent_01_open-button_v2.jpg)

## ② 选择打开方式

弹窗会给出两个选项：

- **在当前目录打开终端**：进入当前项目目录，适合查文件、跑脚本、看日志。
- **打开终端并显示 Agent 后台**：打开终端后自动 attach 到当前会话对应的 Agent tmux 窗口。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/26_web_terminal_agent_02_mode-choice_v2.jpg)

## ③ 在当前目录直接运行命令

选择「在当前目录打开终端」后，顶部会显示绿色「**已连接**」，下方就是一个真实 shell。工作目录默认是当前项目目录，输入命令回车即可实时执行。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/26_web_terminal_agent_03_cwd-terminal_v2.jpg)

## ④ 打开 Agent 后台

选择「打开终端并显示 Agent 后台」后，Mobius 会先打开 Web 终端，再自动执行 `tmux attach`，进入当前会话的 Agent 后台窗口。这里适合检查 Agent TUI 状态、观察是否卡住、复制后台日志。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/26_web_terminal_agent_04_agent-terminal_v2.jpg)

‍

> 小贴士：按 **Esc 不会关闭弹窗**（Esc 留给 vim、tmux、Agent TUI 等程序用），点右上角的 ✕ 或点弹窗外的遮罩即可关闭。关闭 Web 终端只会断开这次查看，不会杀掉正在运行的 Agent 后台。
