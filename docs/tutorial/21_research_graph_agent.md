# 启用 Graph 绘图 Agent

‍

默认团队里的「**Research Graph 绘制 Agent**」是研究结构的维护者——它根据 Research Blackboard 的进展，绘制并更新 `research-graph.yml`，让课题的节点关系和状态在 Research Graph 中可视化。

## 操作

- 在团队面板选中「**Research Graph 绘制 Agent**」成员标签。
- 它的「主 Skill」已自动绑定 **research-generate-graph**（无需手填）。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/tut21-graph.jpg)

!!! tip
    该 Agent 不需要你写 prompt——它按 skill 指示读 Blackboard、产出 graph。只要团队里保留这个成员并启动，Research Graph 就会随研究推进自动更新。
