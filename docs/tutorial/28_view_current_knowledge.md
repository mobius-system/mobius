# 查看当前知识

‍

Mobius 把会话能「看到」的知识分成两层：**项目知识**（项目级通用经验，本项目所有 Session 共享）和**本任务知识**（只与当前 Issue 相关）。在任意一个执行会话里，你都能随时打开「查看当前知识」编辑器，查看和修改这两层知识。

## 1. 在执行会话的工具栏点「查看当前知识」

- 打开任意一个项目里的执行会话（Session），在底部工具栏点 **「查看当前知识」**。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/tut28-toolbar.jpg)

## 2. 双 tab 编辑器

- 弹出编辑器，默认停在 **「编辑本任务知识」**——记录仅与当前 Issue 相关的经验，可作为可选 Memory 注入本 Issue 的 Session。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/tut28-issue-tab.jpg)

## 3. 切到「编辑项目知识」

- 上方切到 **「编辑项目知识」**——记录项目整体事实、通用做法、跨任务可复用的经验。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/tut28-project-tab.jpg)

!!! tip "两层知识的分工"
    - **项目知识**务必**精简克制**：一个项目下会有大量 Issue，这里只放真正通用的东西。
    - **本任务知识**记录只和当前任务相关的细节，写多了也不影响别的任务。
    - 两层都**直接编辑、500ms 自动保存**，也可 `Ctrl+S` / `Cmd+S` 立即保存；切 tab 或关弹窗前不到 500ms 的改动会自动刷盘，不会丢。

!!! note "文件在哪"
    - 项目知识 → `<隐藏目录>/project_knowledge.md`
    - 本任务知识 → `<隐藏目录>/issue_knowledge/<IssueId>/issue_knowledge.md`

    `<隐藏目录>` 默认是 `.imac`（本机）或 `.mobius`（新装）。本任务知识默认作为可选 Memory 注入本 Issue 的 Session——可在创建 Session 时勾选/取消。
