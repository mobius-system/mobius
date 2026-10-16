---
name: mobius-blueprint
description: 为 Mobius 项目编写/更新「项目蓝图」——保存到项目隐藏目录
  <HIDDEN_FOLDER_NAME>/blueprints/<module>/<blueprint_name>.html 的自包含 HTML
  设计文稿，供人类快速理解项目逻辑并做出决策。
---

# Mobius 项目蓝图 (Project Blueprint)

这是 Mobius 内置 Skill。不要让用户安装或调用 Codex / Claude Code 自身的
Skill / Memory 系统，只使用当前 Session 注入的 Mobius 上下文与项目文件。

## 蓝图是什么

蓝图是**给人类看的**项目设计文稿：精妙排版的文字、图像、系统设计图。
目标是让人类在几分钟内理解某个模块/机制的设计逻辑，做出更快的决策。
读者是项目所有者，不是机器——一切为可读性服务。

## 何时写蓝图

用户要求「画/写/制作 XX 的蓝图」「出一份 XX 的设计文稿」，或你在完成一项
重要设计后认为值得沉淀时。已有蓝图内容过时则**覆盖同路径文件**完成更新。

## 路径与命名（硬性规则）

保存到当前项目绑定目录下的：

```
<HIDDEN_FOLDER_NAME>/blueprints/${module}/${blueprint_name}.html
```

- `module` 与 `blueprint_name` 由你按主题自定义：
  - `module` 用英文 kebab-case，按项目子系统划分（如 `frontend`、`backend`、
    `deploy`、`agent-runtime`、`extension`），保持稳定，别为每张图发明新模块；
  - `blueprint_name` 用英文 kebab-case 概括主题（如 `native-file-editor.html`、
    `session-status-pipeline.html`）；
  - HTML 内部 `<title>` 与大标题用中文（或其他自然语言）写清主题。
- 目录不存在就创建；更新 = 写同一路径覆盖。
- 用户在「项目蓝图」Tab（项目设置内）即可阅读：左侧按 module 分组的二级
  清单，右侧默认渲染 HTML 预览，也能切源码编辑。

## HTML 硬性规范

- 单文件自包含：所有 CSS 内联（`<style>`），图示用内联 SVG 或 HTML/CSS 绘制。
- **禁止任何外部依赖**：不引用 CDN、远程字体（包括 Google Fonts）、远程
  图片、外链脚本。图片需要时用内联 SVG 或 data URI。
- 允许 `<script>`（预览沙箱允许脚本，可做折叠/高亮等轻交互），但内容离开
  脚本也必须可读，且脚本不得访问网络。
- 使用系统字体栈（如 `system-ui, -apple-system, "Segoe UI", "PingFang SC",
  "Microsoft YaHei", sans-serif`）。
- 体积控制在 500KB 以内（编辑器预读上限 1.5MB，超限不可编辑）。
- 用 `html { background: ... }` 自带底色，兼顾明暗环境下的可读性。

## 写作规范（为决策服务）

- **结论先行**：首屏给出一段话结论 + 元信息（日期、状态、适用版本/commit）。
- 一屏一主题：一张蓝图讲清一个机制，长度控制在 3-6 屏。
- 系统设计图用内联 SVG：组件框 + 箭头 + 分组，配色克制（3-4 色），
  每个框标出对应源码路径，方便跳转核对。
- 关键取舍用对比表（方案 / 代价 / 收益 / 结论）。
- 引用真实路径与符号名（`file.ts:function`），不凭记忆编造；讲不清的
  地方如实标注「未核实」。

## 完成动作

写完文件后，在回复里给出蓝图相对路径，并提醒用户可在项目的
「设置 → 项目蓝图」Tab 查看。不要把 HTML 全文贴进对话。
