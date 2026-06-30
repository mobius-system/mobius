# 创建研究任务（启用 Research 系统）

‍

Research（深度研究）是 Mobius 的多智能体科研工作面。它按项目开启——在项目设置里勾选「启用 Research 系统」后，该项目就会出现 Research 标签，可在其下创建任意多个研究课题，并为每个课题组建 Agent 团队协同攻关。

## 1. 在项目设置中启用 Research 系统

- 打开项目页，左侧「项目设置」面板里勾选「**启用 Research 系统**」（设置会实时保存）。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/tut19-enable.jpg)

!!! note "副作用"
    启用 Research 后，本项目**强制禁用 git worktree**（研究 Agent 需直接在主 checkout 上协作），已建会话不受影响。

## 2. 新建一个研究课题

- 切到顶部的「**Research**」标签 → 点「**新建 Research**」，填写课题标题与描述 → 「创建」。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/tut19-newresearch.jpg)

- 创建后会得到一张研究卡片，进入研究即可在右侧「新 Agent」处组建团队、开启科研。
