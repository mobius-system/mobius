<p align="right">
  <a href="./README.md"><strong>English</strong></a>
  ·
  <a href="./README.zh.md"><strong>简体中文</strong></a>
</p>

<div align="center">

# <img src="mobius/frontend/public/logo.png" alt="Mobius logo" height="42" valign="middle" /> Mobius

<h3>
首个自进化的开源 Agent OS<br />
一个系统，连接你的团队、AI 智能体、设备与算力
</h3>

<p align="center">
  <a href="https://github.com/mobius-system/mobius/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/mobius-system/mobius?style=for-the-badge" /></a>
  <a href="https://github.com/mobius-system/mobius"><img alt="Status" src="https://img.shields.io/badge/status-evolving-orange?style=for-the-badge" /></a>
  <a href="https://mobius.nutshellai.cn/"><img alt="Website" src="https://img.shields.io/badge/website-000000?style=for-the-badge&logo=About.me&logoColor=white" /></a>
  <a href="https://mobius-system.github.io/mobius/"><img alt="Docs" src="https://img.shields.io/badge/docs-000000?style=for-the-badge&logo=readthedocs&logoColor=white" /></a>
</p>

</div>

<p align="center">
  <img src="https://serve.nutshellai.cn/publish/auto/readme/github-cover-v1.png" alt="Mobius GitHub cover" width="100%" />
</p>

> **在模型飞速进步的时代，试图打造适合所有人的完美 AI 系统，就像寻找莫比乌斯环的尽头，终究徒劳无功。**
>
> Mobius 是一个把模型、Agent、项目、设备和算力放进同一个工作网络的自进化 Agent OS。它会随你的使用不断改写自身，每次改动都留有记录、可以追溯。

## 快速开始

已有 Docker 环境？从下面的路径开始，启动后就能进入 Mobius 工作台。首次构建会下载镜像和依赖，耗时取决于网络与机器配置。

### 方法1：容器（推荐，适用于 Windows / Linux / macOS）

> macOS 一键安装（一行命令）：`bash <(curl -fsSL https://serve.nutshellai.cn/publish/auto/tutorial/deploy-mac-v21.sh)`，[演示视频](https://www.bilibili.com/video/BV1AAtT6aEoR)
>
> Windows 一键安装：`irm https://serve.nutshellai.cn/publish/auto/tutorial/deploy-windows-v6.ps1 | iex`，[演示视频](https://www.bilibili.com/video/BV1yk4y6iER9/)
>
> 模型配置：接入国内外 CodingPlan 订阅，一次接入，全平台、全系统、全设备可用，[演示视频](https://www.bilibili.com/video/BV1oC4m6aENv/)

对专业用户，我们推荐用下面的命令手动安装，效果与一键安装完全等价。

```bash
# 1. 克隆仓库（建议先 fork，再 clone；这样自进化后可直接提交到自己的仓库）
git clone https://github.com/mobius-system/mobius.git && cd mobius

# 2. 生成并校验配置
python3 conf_prepare.py --docker && python3 conf_check.py --docker

# 3. 构建镜像（base 镜像仅含环境，不含代码）
docker build -t mobius-system-base:latest -f deploy/Dockerfile .
docker build -t mobius-system-exe:latest .

# 4. 启动
docker compose up
```

### 直接部署（Linux / macOS）

```bash
# 1. 安装前置依赖（tmux、git 等）
sudo apt install tmux python3 git curl proxychains openssh-server build-essential

# 2. 安装编码 Agent（任选其一，建议两者都装）
npm install -g @anthropic-ai/claude-code @openai/codex

# 3. 克隆仓库（建议先 fork，再 clone）
git clone https://github.com/mobius-system/mobius.git && cd mobius

# 4. 生成并校验配置
python3 conf_prepare.py && python3 conf_check.py

# 5. 安装依赖（前端 + 后端）
cd ./mobius && npm install && cd ./frontend && npm install && cd ../..

# 6. 运行
python3 start.py
```

完整部署指南见[文档](https://mobius-system.github.io/mobius/)。开始后的第一个动作，可以参考[导入项目并开始任务](https://mobius-system.github.io/mobius/tutorial/02a_import_project_and_begin_first_job.html)、[监控 Agent](https://mobius-system.github.io/mobius/tutorial/08_monitor_agents.html)和[创建研究 Agent 团队](https://mobius-system.github.io/mobius/tutorial/20_research_agent_team.html)。

## 一个工作台，覆盖所有场景

- 按手头任务切换到最顺手的界面

<p align="center">
  <img src="https://github.com/user-attachments/assets/4c948e53-5c8e-4ae5-8eb3-d3ca035908c9" alt="界面布局切换：常规、Copilot、服务器协作、自动科研" width="480" />
</p>

- 在一个总览里看清每个 Agent 正在做什么

<p align="center">
  <img src="https://github.com/user-attachments/assets/7868ef41-068f-4316-ae6b-b17561a119ac" alt="项目总览仪表盘：智能体状态与任务进度" width="480" />
</p>

## 单线任务流难以承载复杂现实任务

大模型通常沿着一条因果链推进问题。模型越强，这一条线可以走得越远，但不会因此同时出现在多个地方：它仍然要在同一个上下文里排队、判断和切换。

现实任务往往要求几套互不相同的规则同时成立。一个 Agent 需要随时停下来向人申请危险操作授权，另一个 Agent 却要彻夜运行、尽量不打扰任何人。把两套要求塞进同一个上下文，只会让它反复权衡；拆成多个 Agent，各自守住自己的边界，工作才能真正并行。

再强的模型，提升的也是一个 Agent 的能力。并行推进、上下文隔离、跨设备协作，这些是多个 Agent 组织起来才有的系统级能力。

Mobius 是一个智能体操作系统，不同模型、不同 Harness 的 Agent 可以在不同硬件设备上协作。

## 多智能体协作

Mobius 通过两个层次实现多智能体合作。第一层是临时建立的跨会话连接：计划之外出现了信息互通需求，人在对话中按下键盘上的 **@** 键即可选择另一个 Agent。选“只读引用”，当前 Agent 读取对方的完整上下文，但不干预或唤醒对方；选“开启交流”，两个 Agent 便能双向交换信息。

第二层是事前预设的智能体群：你预计一个开放任务需要复杂的群体交互，就把不同角色的 Agent 放入同一群组。它们通过共享的“群黑板”自主通讯、分工协作，入群即开始参与。

| 对比 | 跨会话连接 | 智能体群 |
|---|---|---|
| 本质 | 事后补建 | 事前预设 |
| 启动 | 人工 **@** 连接 | 入群自动参与 |
| 方向 | 单向或双向 | 双向 |
| 兼容 | 通用能力 | 可“跨会话连接”连接群组外Agent |
| 结构 | 两个会话点对点 | 多个 Agent 共享群黑板 |
| 适合 | 临时互通 | 复杂开放任务 |

在快速版本迭代中，可以让“NPM 发布”“PYPI 发布”“Github 创建 Release”各司其职；在模型训练中，则可以组成“实验复现”“曲线绘制”“Research 流图追踪”“报告撰写”团队。

<p align="center">
  <img src="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=ZDQ2ZTY1MzM2N2FiYzA2ODE2NGQxZjllY2Q2YjZjMzhfZmQxYTA3OWNhZWVhZWYwZDUyNDA4ODNlZTQyNGY3MzdfSUQ6NzY3NTc4OTUxNzQyMDMwMTUxNF8xNzg3MTU5MDQzOjE3ODcxNjI2NDNfVjM" alt="Mobius 多智能体协作" width="720" />
</p>

## 跨设备联通

Agent 不必都住在同一台机器上。Mobius 在同一个任务网络里调度浏览器、终端、GPU 集群、嵌入式开发板、云服务器和工作站，让不同模型、不同 Harness 驱动的 Agent 在各自擅长的设备上工作。

通过 SSH、AIMUX 和可控代理访问你的资源：

<p align="center">
  <img src="https://github.com/user-attachments/assets/cd5ef0ba-1d38-4017-bf8a-e7b93d17fca0" alt="SSH 与 AIMUX 接入路径" width="480" />
</p>

## 自动科研流水线

Mobius 把多个 Agent 编排成一条自主科研流水线：读论文、抽取方法、复现实验、绘制曲线、追踪 Research 流图、汇总并撰写报告。给出一个科研目标，这条流水线会自己一直往前推。

<p align="center">
  <img src="https://serve.nutshellai.cn/publish/auto/readme/can-do-research.gif" alt="自动科研演示" width="480" />
</p>

## 小莫：自然语言交互入口

小莫是整个系统的自然语言入口。创建项目、拆分任务、启动 Agent、追踪进度、审批决策，直接对它说就行。界面上能点的，小莫都能做；界面上做不到的，小莫也能处理。它支持语音输入、多端使用（Web、PC、移动端）和可配置的提醒。

<p align="center">
  <img src="https://serve.nutshellai.cn/publish/auto/readme/xiaomo.jpg" alt="小莫助理界面" width="720" />
</p>

**在网页上。** 不用装任何东西，打开浏览器就是完整工作台。

<p align="center">
  <img src="https://serve.nutshellai.cn/publish/auto/readme/xiaomo-app.jpg" alt="手机端小莫" width="720" />
</p>

**在手机上。** 随时和 Agent 对话、追踪进度、审批决策。iOS 与 Android 端现已完全可用。

<p align="center">
  <img src="https://serve.nutshellai.cn/publish/auto/readme/xiaomo-desktop-v2.png" alt="桌面端小莫" width="720" />
</p>

**在桌面上。** 原生桌面客户端，把 PC 变成 Mobius 工作站：直接读写本地项目文件、把本机接入为可控节点、多标签工作区。Windows、macOS、Linux 都能用。

> 本页的演示素材均由小莫自己制作，录制过程零人工参与。

## 任意模型，任意智能体

Mobius 与具体模型解耦。GPT、Claude、GLM、Codex 都可以在同一个项目和任务网络中做执行引擎，按任务类型、成本或性能自由组合。

模型配置演示：[莫比乌斯接入国内外 CodingPlan 订阅，一次接入，全平台、全系统、全设备可用](https://www.bilibili.com/video/BV1oC4m6aENv/)

## 自进化能力

Mobius 会根据你的输入改写自身。发一段修改需求、一张截图或一个参考链接，它会变成真实的代码、界面、插件或流程更新，不打断你手头的工作。每一次迭代，都在后台悄悄替换“忒修斯之船”上的一块木板。

<p align="center">
  <img src="https://serve.nutshellai.cn/publish/auto/readme/can-do-agent-os.gif" alt="自进化 Agent OS 演示" width="480" />
</p>

[查看自进化示例](https://mobius-system.github.io/mobius/self-evo-demo/)

Mobius 还会按你的需求孵化新的拓展：金融看板、PPT 生成器、科研工作台、实时门户。每个拓展都自带前端、后端 handler、数据目录和调用入口，可持续进化。

<p align="center">
  <img src="https://serve.nutshellai.cn/publish/auto/readme/can-do-extensions.gif" alt="拓展演示" width="480" />
</p>

<table>
  <tr>
    <td width="50%">
      <strong>沉浸式 Web 体验</strong><br />
      <sub>把视觉创意变成可运行的拓展应用。</sub><br />
      <img src="https://serve.nutshellai.cn/publish/auto/readme/extension-matrix-rounded.png" alt="黑客帝国风格拓展" />
    </td>
    <td width="50%">
      <strong>金融新闻墙</strong><br />
      <sub>追踪实时市场叙事。</sub><br />
      <img src="https://serve.nutshellai.cn/publish/auto/readme/extension-finance-news-wall-rounded.png" alt="金融新闻墙" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>世界杯门户</strong><br />
      <sub>数据丰富的体育门户。</sub><br />
      <img src="https://serve.nutshellai.cn/publish/auto/readme/extension-world-cup-rounded.png" alt="世界杯拓展" />
    </td>
    <td width="50%">
      <strong>PPT 生成器</strong><br />
      <sub>从主题和素材生成演示文稿。</sub><br />
      <img src="https://serve.nutshellai.cn/publish/auto/readme/extension-ppt-maker-rounded.png" alt="PPT 生成器拓展" />
    </td>
  </tr>
</table>

## 人机协作团队

成员、Agent、任务和交付物集中在同一个视图。谁在做什么、哪些需要确认、风险在哪里，负责人一眼就能看到。

<p align="center">
  <img src="https://serve.nutshellai.cn/publish/auto/readme/can-do-team-collab.gif" alt="团队协作演示" width="480" />
</p>

## 延伸阅读

### 最新动态

- **2026-08-09** — **Windows 一键安装**：一条 PowerShell 命令，即可在全新的 Windows 机器上装好 Mobius TUI。
- **2026-08-02** — **简易模式上线**：可选的无干扰布局（跨项目近期会话 + JSONL + 悬浮输入框）。首次使用时会在简易与常规两种模式之间做一次选择，之后随时可从主题菜单切换。
- **2026-08-02** — **TUI 发布**：在任意终端通过 TUI 连接 Mobius，像使用 Codex 一样使用它。
- **2026-07-26** — **搜索优化**：搜索结果经 SSE 流式返回，支持大小写/全字匹配，点击任一结果即可跳转到对应的 JSONL 卡片。
- **2026-07-14** — **代码对话 v2** 工作空间模式：三栏布局——文件浏览器、内置 CodeMirror 编辑器（支持语法高亮与就地保存）、对话面板。

### 已完成

- ✅ **移动端 App** — 在 iOS 和 Android 上使用小莫和完整的 Agent 控制
- ✅ **桌面端 App** — 原生连接器，将 PC 设备（Windows、macOS、Linux）接入 Mobius

### 接下来

- **拓展市场**：发现、分享和安装社区拓展。
- **多语言与本地化**：把界面和文档本地化为更多语言。

### 参与贡献

Issue、插件、文档、Bug 报告、使用案例，皆欢迎。如果你也想要一个能自己进化的 AI 系统，欢迎加入我们。

### 加入微信群

扫描下方二维码，加入 Mobius 微信群，和团队及社区交流。

<p align="center">
  <img src="https://serve.nutshellai.cn/publish/auto/tutorial/wechat-group-qr.png" alt="微信群二维码" width="240" />
</p>

<p align="center">
  <a href="https://github.com/mobius-system/mobius">GitHub</a>
  ·
  <a href="https://mobius.nutshellai.cn/">Website</a>
  ·
  <a href="https://mobius-system.github.io/mobius/">Docs</a>
</p>

### 致谢

特别感谢以下项目与社区：

- [Codex](https://github.com/openai/codex) —— AI 编程智能体
- [LINUX DO](https://linux.do/) —— 活跃的 Linux 与技术社区
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/) —— 大模型自进化基础设施
