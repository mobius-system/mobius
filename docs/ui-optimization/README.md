# Mobius UI 优化文档索引

本目录把“为什么要简化”和“下一轮具体怎么改”分开。总边界只有一句：保留 Mobius 的 Project / Issue / Research / Session / Skill / Memory / 模型与 Harness / 编辑器 / Admin / 桌面端 / AIMUX 能力，不把默认工作台改造成 Tutti OS、Cursor IDE 或 CodexMonitor 皮肤。

## 01–04：问题、边界与工作台纪律

| 文档 | 回答的问题 | 使用时机 |
| --- | --- | --- |
| [01-tutti-ia-analysis.md](./01-tutti-ia-analysis.md) | Tutti 如何用信息架构隐藏复杂度 | 理解参考产品，不直接生成任务 |
| [02-mobius-complexity-audit.md](./02-mobius-complexity-audit.md) | Mobius 的复杂度来自哪里 | 查问题来源与历史证据 |
| [03-feature-cut-list.md](./03-feature-cut-list.md) | 哪些能力退出默认表面、移到哪里 | 审查能力是否被误删或误升格 |
| [04-codexmonitor-alignment.md](./04-codexmonitor-alignment.md) | Mobius 应对齐哪些工作台纪律 | 作为 05–09 的前置原则与现状基线 |

## 05–09：本轮深入设计与实施输入

| 文档 | 回答的问题 | 主要产物 |
| --- | --- | --- |
| [05-visual-language.md](./05-visual-language.md) | 颜色、字体、密度、圆角、层级怎么收敛 | CodexMonitor token 实值表；Mobius token 建议值；表面影响范围 |
| [06-layout-and-chrome.md](./06-layout-and-chrome.md) | 哪些 chrome 常驻，哪些按需出现 | CodexMonitor / Mobius 对应图；Home 与 Session 目标骨架 |
| [07-interaction-and-navigation.md](./07-interaction-and-navigation.md) | 每个用户动作点哪里、去哪、怎么回 | 当前路径对照；入口、焦点、返回、原地重试的逐项契约 |
| [08-capability-presentation.md](./08-capability-presentation.md) | 完整能力如何被看见但不挤满首屏 | 15 类能力的源码入口、默认暴露和建议位置矩阵 |
| [09-implementation-backlog.md](./09-implementation-backlog.md) | 下一轮按什么顺序改哪些文件 | P0/P1/P2 可执行任务、依赖、风险与验收方式 |

## 10–12：代码文件、点击契约与 Git 只读查看

01–09 没有展开代码文件的渲染器、消息文件点击、行号定位或 commit 历史；08 只规定了附件 / Diff / Git 应放在哪个入口。以下三份文档补齐对象与交互层，不重复 05–09 的工作台纪律。

| 文档 | 回答的问题 | 主要产物 |
| --- | --- | --- |
| [10-code-file-rendering.md](./10-code-file-rendering.md) | 消息里的代码、路径、行号、文件与 Diff 现在分别怎样渲染 | CodexMonitor parser/preview 审计；Mobius 多渲染链流程图；逐项差距与取舍 |
| [11-code-click-and-git-history.md](./11-code-click-and-git-history.md) | 点路径、行号、Diff、commit 后去哪，怎样返回 | 完整点击/键盘契约；两产品 Git 关系模型；Mobius 只读 Git 查看面 |
| [12-code-git-implementation-plan.md](./12-code-git-implementation-plan.md) | 下一轮怎样按 P0/P1/P2 实现而不碰执行协议 | 文件级任务、用户结果、harness/SSE 边界、验收矩阵与拆单顺序 |

## 13：CodexMonitor 桌面主壳复用规格

| 文档 | 回答的问题 | 主要产物 |
| --- | --- | --- |
| [13-codexmonitor-main-shell-reuse.md](./13-codexmonitor-main-shell-reuse.md) | 如果把 CodexMonitor 的左栏、中心层、按需右栏、薄顶栏与贴底 Composer 作为 Mobius 默认骨架，每项能力具体放哪、怎么跳、怎么回 | 槽位级源码对照；Mobius 能力一一映射；12 条操作路径；Home / Session 目标壳；主壳专用 P0/P1/P2 拆单 |

## 推荐阅读路径

- 做视觉 token：先读 05，再读 09 的 P0。
- 改页面骨架：先读 06，再用 08 检查能力没有丢。
- 改任何入口或路由：以 07 为交互真相源，再读 09 的导航任务。
- 评审需求是否越界：回看 03、04；不要从 05 的色值反推产品能力。
- 改消息 Markdown / JSONL 文件呈现：读 10，再按 12 的 P0 拆单。
- 改文件点击、Diff 或 Git 历史：以 11 的点击契约为真相源，再执行 12 对应阶段。
- 实现默认桌面主壳：先读 13 的槽位映射和跳转契约，再回看 09 / 12 的边界与分期。

本文档集是源码审计与实现规格，不代表本轮已修改前端。源码行号以 2026-08-28 工作区快照为准。

## 14：工具调用显示与折叠

| 文档 | 回答的问题 | 主要产物 |
| --- | --- | --- |
| [14-tool-call-display-and-fold.md](./14-tool-call-display-and-fold.md) | 模型回复里的工具过程应怎样分组、默认展开什么、运行中怎样说话、命令输出怎样露出 | CodexMonitor / Mobius 双回复面对照；默认 Easy 时间线折叠契约；不改协议的 P0/P1/P2 文件级拆单 |
