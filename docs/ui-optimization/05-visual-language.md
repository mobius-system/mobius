# 05｜视觉语言：颜色、字体与密度

## 结论

Mobius 应学 CodexMonitor 的“语义稳定”，不学它的“皮肤”：用表面差、1px 边界、字号与字重建立层级，把高饱和色限制在焦点、状态和唯一主动作；保留 Mobius 的天蓝品牌强调色、中文字体和代码/Diff 语义。`04-codexmonitor-alignment.md` 已回答“为什么要克制”，本文只给可落地的 token、尺度和表面规则。

判断分级：

- **必须学**：语义 token 不随组件漂移；状态色只有一套；默认工作台使用紧凑尺度；悬停与选中分开。
- **可学**：动效节奏、统一层级表、Dim 的表面策略。
- **不要学**：整页复制 CodexMonitor 的蓝灰/透明皮肤、渐变主按钮、Usage 视觉，以及把英文 11px 原样套到中文。

## 1. CodexMonitor 的设计系统事实

### 1.1 语义 token 与实际色值

CodexMonitor 先在主题文件定义原子 token，再由 `--ds-*` 组件 token 映射。组件不直接决定主题：例如 `--ds-surface-card` 指向 `--surface-card-strong`，`--ds-border-strong` 指向 `--border-stronger`（`examples/CodexMonitor/src/styles/ds-tokens.css:2-18`）。Dim 只改 surface，文字、边界、accent 与状态继承 Dark（`themes.dark.css:16-76`；`themes.dim.css:1-25`）。

| 语义 | CSS 变量 | Dark | Light | Dim | 观察 |
| --- | --- | --- | --- | --- | --- |
| 页面主文字 | `--text-primary` | `#e6e7ea` | `#1a1d24` | 继承 Dark | 不用纯白/纯黑承载全部正文 |
| 强标题 | `--text-strong` | `#ffffff` | `#0e1118` | 继承 Dark | 只给最高层标题或关键值 |
| 次文字 | `--text-muted` | `rgba(255,255,255,.70)` | `rgba(17,20,28,.70)` | 继承 Dark | 仍保持可读，不等于 disabled |
| 弱提示 | `--text-subtle` / `--text-faint` | `.60` / `.50` 白 | `.60` / `.50` 深色 | 继承 Dark | 元数据再降一级，层次连续 |
| 侧栏表面 | `--surface-sidebar` | `rgba(18,18,18,.50)` | `rgba(246,247,250,.82)` | `rgba(41,44,51,.78)` | 区域靠表面差，不靠粗分割线 |
| 顶栏 / Composer | `--surface-topbar` / `--surface-composer` | `rgba(10,14,20,.45)` | `rgba(250,251,253,.90)` | `.72` / `.75` 的 `rgb(35,38,45)` | 顶栏与输入属于同一 chrome 家族 |
| 消息底面 | `--surface-messages` | `rgba(8,10,16,.45)` | `rgba(238,241,246,.90)` | `rgba(32,35,42,.72)` | 主内容与 chrome 有轻微表面差 |
| 普通卡片 | `--surface-card` | `rgba(255,255,255,.04)` | `rgba(255,255,255,.72)` | `rgba(255,255,255,.06)` | 不负责“吸睛”，只负责分组 |
| 强卡片 / Overlay | `--surface-card-strong` / `--surface-context-core` | `.12` 白 / `rgba(10,14,20,.90)` | `.92` 白 / `.90` 白 | `.14` 白 / `rgba(32,35,42,.92)` | Overlay 才提高不透明度 |
| 控件 / Hover | `--surface-control` / `--surface-control-hover` | `.08` / `.14` 白 | `.08` / `.12` 深色 | `.10` / `.16` 白 | hover 是中性表面变化，不抢 accent |
| 选中 | `--surface-active` | `rgba(100,200,255,.14)` | `rgba(77,153,255,.18)` | `rgba(120,205,255,.18)` | active 才带蓝色语义 |
| 细边界 | `--border-subtle` / `--border-muted` | `.08` / `.06` 白 | `.08` / `.06` 深色 | 继承 Dark | 大多数容器只需此层 |
| 强边界 | `--border-strong` / `--border-stronger` | `.14` / `.18` 白 | `.14` / `.18` 深色 | 继承 Dark | 用于焦点容器、Modal、当前项 |
| Accent 边界 | `--border-accent` / `--border-accent-soft` | `rgba(100,200,255,.60)` / `.30` | `rgba(77,153,255,.50)` / `.28` | 继承 Dark | 仅 active/focus，不给所有按钮 |
| Accent 文字 | `--text-accent` | `rgba(164,195,255,.70)` | `rgba(45,93,170,.70)` | 继承 Dark | 是辅助强调，不是品牌色铺底 |
| Success | `--status-success` | `rgba(120,235,190,.95)` | `rgba(30,155,110,.90)` | 继承 Dark | 只表达完成/成功 |
| Warning | `--status-warning` | `rgba(255,175,85,.95)` | `rgba(215,120,20,.90)` | 继承 Dark | 只表达等待/注意 |
| Danger | `--status-error` | `rgba(255,110,110,.95)` | `rgba(200,45,45,.90)` | 继承 Dark | 失败与破坏动作同一家族 |
| Unknown | `--status-unknown` | `rgba(255,255,255,.30)` | `rgba(17,20,28,.25)` | 继承 Dark | 不明状态不伪装成正常状态 |

对应源码为 `examples/CodexMonitor/src/styles/themes.dark.css:16-76`、`themes.light.css:3-55`、`themes.dim.css:3-25`。组件层进一步统一 `--ds-surface-*`、`--ds-border-*`、`--ds-text-*`（`ds-tokens.css:2-34`），Modal 遮罩固定为 `rgba(6,8,12,.55)`（`ds-tokens.css:15`）。

### 1.2 层级不是“更多颜色”

| 建层手段 | CodexMonitor 事实 | Mobius 应用 | 影响表面 |
| --- | --- | --- | --- |
| 表面差 | Sidebar、Messages、Composer、Right panel 各有独立 surface token，但色相接近（`themes.dark.css:26-40`） | 保持 Mobius 深色蓝黑基底，只把 `--bg-primary / secondary / card / menu` 的亮度阶梯拉开 | Home / Rail / Chat / Settings / 高级页 |
| 细边界 | 默认边界 `.06–.08`，强边界 `.14–.18`（`themes.dark.css:55-59`） | 默认容器 1px `--border-color`；仅活动项、Popover、Modal 用 strong | Rail / Chat / Settings / 高级页 |
| 字重 | 侧栏标题 600、会话标题 500，元数据 10px（`sidebar.css:59-60,1157-1168,1289-1320`） | 中文正文 400/500，标题最多 600；不要用 700 补偿层级不清 | 全部 |
| 间距 | Panel gap 8px、header 最小 26px（`ds-tokens.css:26-28`） | 以 4/8/12/16/24 为主；同组 4–8，组间 12–16，页面 gutter 20–24 | 全部 |
| 状态色 | `--status-*` 独立于 accent（`themes.dark.css:73-76`） | “运行/等待/完成/失败”不再由每个组件硬编码蓝黄绿红 | Rail / Chat / 高级页 |

以下地方**不用高饱和**：普通卡片底、顶栏、侧栏文件夹、工具按钮、设置导航、模型/Skill/Memory 标签、已完成的普通消息。CodexMonitor 的 Home 两个动作最终被覆写为强中性卡片而非渐变（`examples/CodexMonitor/src/styles/home.css:812-844`）；Mobius 也不应让“工具”“设置”“项目卡”与发送按钮同级。

### 1.3 控件尺度、阴影和动效

| 项目 | CodexMonitor 实值 | 对 Mobius 的建议 | 分级 / 影响表面 |
| --- | --- | --- | --- |
| 顶栏 | `--main-topbar-height: 44px`（`base.css:58`），padding `10px 24px 12px`（`main.css:355-370`） | 当前 52px（`shell.tsx:819-821`）先保留；浏览器端后续可评估 48px，桌面拖拽区不强压到 44px | 可学；Home / Chat / 高级页 |
| 侧栏 | 默认 `280px`（`base.css:48-53`） | 当前 Rail `272px`（`conversation-rail.tsx:243-246`）合理，保持 264–280 可调范围，不复制固定 280 | 必须保持稳定；Home / Rail / Chat |
| 主内容宽 | `--main-conversation-width: 900px`（`main.css:11-13`） | Home / Chat Composer 当前 `880px`（`UserPage.tsx:407-413`；`index.css:5893-5899`）保留 | 必须学“窄可读列”；Home / Chat |
| 标准按钮 | 13px/600，padding `8px 14px`，圆角 10px（`buttons.css:6-14`） | 工作台按钮 32px 高、12px/500–600、圆角 6–8px；主发送可 32px 正方 | 必须学密度，不照搬圆角；全部 |
| 图标按钮 | 顶栏/侧栏常见 28–32px、圆角 8px（`base.css:176-178`；`sidebar.css:142-149,182-185`） | 统一 32×32；移动触控最小 36–40，沿用 `index.css:6043-6056` | 必须学；TopNav / Rail / Chat |
| 列表行 | 会话行 padding `9px 12px`、12px 字、圆角 14px（`sidebar.css:1029-1128`） | 中文行目标 30–34px；项目头 32px，会话行 28–32px；圆角 6–8px | 必须学密度，不学大胶囊；Rail |
| Composer | 外围 24px gutter、输入 14px/1.5、圆角 20px（`composer.css:1-18,149-179`） | 保持 880px；textarea 14px/1.55；容器圆角由当前 8px提高到 10px 即止 | 可学；Home / Chat |
| 消息 | 消息间 14px；气泡 14px、1.55、圆角 18px（`messages.css:1-28,167-292`） | Mobius JSONL 时间线不必气泡化；只对用户输入/错误摘要用 8–12px 圆角 | 不要学皮肤；Chat |
| Modal | 卡片 strong border，`0 18px 40px rgba(0,0,0,.35)`（`ds-modal.css:21-35`） | Settings 保持单层 1px + 12px 圆角；只保留一层 18–32px 模糊阴影 | 可学；Settings / 高级弹层 |
| Popover | 圆角 10px，item `6px 8px` / 12px，hover 不位移（`ds-popover.css:1-50`） | 统一 8px，菜单项 32px 高；hover 只换 surface | 必须学；Rail / Chat / Settings |
| 动效 | 120/160/220/200ms；active scale `.97`（`ds-tokens.css:45-57`） | 新增统一时长 token；颜色 120ms、Popover 160ms、栏宽 220ms；列表不要 `translateY` | 必须学；全部 |
| 层级 | Modal 10000、Toast 11000（`ds-tokens.css:41-43`） | 统一 Popover/Drawer/Modal/Toast 层级，消除当前 50/60/70/80/90 与 8999/9000 并存 | 必须学；Chat / Settings / 移动端 |

CodexMonitor 的普通按钮 hover 会 `translateY(-1px)`（`buttons.css:51-59`），但 Popover item 明确不位移（`ds-popover.css:39-50`）。Mobius 工作台应以后者为准：按钮靠表面、边界和文字反馈；位移只允许营销/空态大动作，不进入 Rail、TopNav、Tools、Settings。

## 2. Mobius token 对照与建议值

### 2.1 当前问题

Mobius 已有可用的基础阶梯，但还不是完整设计系统：Dark 的 `--border-color` / `--border-color-strong` 只有 `.06/.08`，区分不足；Light 的 `--text-secondary` 与 `--text-muted` 都是 `#64748b`，信息层级合并；状态色没有 token，Rail、Chat、Research 各自硬编码（`index.css:122-172,659-709`；`conversation-rail.tsx:57-61`；`session-status-chip.tsx:34-40`）。此外，`--assistant-*` 用多层渐变与重阴影建立一套独立皮肤（`index.css:173-206,710-743`），与默认工作台的中性表面不连续。

### 2.2 建议 token 表（设计规格，不改代码）

下表中的“建议”是后续实现输入。Dark / Light 都给值；Dim 若以后保留，只改 surface，不复制整套文字和状态。

| Mobius token | 当前 Dark / Light | 问题 | 建议 Dark / Light | 影响表面 |
| --- | --- | --- | --- | --- |
| `--bg-primary` | `#0a0e16` / `#f8fafc` | Dark 可留；Light 与 secondary 反差方向不稳定 | `#0a0e16` / `#f6f7fa` | Home / Rail / Chat / Settings / 高级页 |
| `--bg-secondary` | `#0f1318` / `#fff` | 可用，但职责未命名 | `#0f141b` / `#fff`；另加语义别名 `--surface-content` | Home / Chat / 高级页 |
| `--bg-tertiary` | `#111827` / `#f1f5f9` | 被卡片、代码、控制混用 | `#131a24` / `#eef1f6` | Chat / Settings / 高级页 |
| `--bg-card` | 白 `.02` / 黑 `.025` | 几乎不可见，迫使组件补边/阴影 | 白 `.04` / 白 `.78` | Home / Settings / 高级页 |
| `--bg-card-hover` | 白 `.04` / 黑 `.05` | 与 Dark 普通卡相同 | 白 `.06` / 深色 `.055` | Home / Rail / Settings / 高级页 |
| `--bg-hover` | 白 `.04` / 黑 `.04` | 合理但与 card hover 重叠 | 白 `.05` / 深色 `.055` | 全部交互表面 |
| `--bg-active` | 蓝 `.10` / 蓝 `.08` | Light 太弱，active 可能只靠文字 | `rgba(56,189,248,.13)` / `rgba(37,99,235,.10)` | Rail / Chat / Settings / 高级页 |
| `--border-color` | 白 `.06` / 黑 `.08` | Dark 容器分界过弱 | 白 `.08` / 深色 `.08` | 全部 |
| `--border-color-strong` | 白 `.08` / 黑 `.12` | Dark strong 只等于 Codex subtle | 白 `.14` / 深色 `.14` | Composer / Popover / Settings / 高级页 |
| `--text-primary` | `#f1f5f9` / `#1e293b` | Dark 略刺眼但可用 | `#e6e7ea` / `#1a1d24` | 全部 |
| `--text-secondary` | `#94a3b8` / `#64748b` | Dark 偏蓝，Light 与 muted 重叠 | `rgba(255,255,255,.70)` / `rgba(17,20,28,.70)` | 全部 |
| `--text-muted` | `#6b7280` / `#64748b` | Light 无第三层 | `rgba(255,255,255,.52)` / `rgba(17,20,28,.52)` | Rail / Chat / Settings / 高级页 |
| `--text-dimmed` | `#4b5563` / `#94a3b8` | 语义接近 disabled 但未定义 | `rgba(255,255,255,.36)` / `rgba(17,20,28,.36)` | Chat / 高级页 |
| `--input-bg` | 白 `.03` / 黑 `.03` | Focus 前过弱 | 白 `.05` / 深色 `.035` | Home / Chat / Settings / 高级页 |
| `--input-border` | 白 `.07` / 黑 `.12` | 与全局边界不一致 | `var(--border-color-strong)` / 同左 | Home / Chat / Settings / 高级页 |
| `--modal-bg` | `#111820` / `#fff` | 可用；圆角/层级各组件自定 | `#111820` / `#fff`，映射 `--surface-overlay` | Settings / 高级弹层 |
| `--menu-bg` | `#1a1f2e` / `#fff` | Dark 与页面色相跳变偏紫蓝 | `#151b24` / `rgba(255,255,255,.99)` | Rail / Chat / Settings |
| `--accent-primary` | `#38bdf8` / `#2563eb` | 品牌色本身不是问题，滥用才是 | **保留现值**；只用于 focus、active、链接、唯一主动作 | 全部 |
| `--accent-secondary` | `#2dd4bf` / `#0d9488` | 容易与 success 混淆 | 保留作品牌辅助，不用于“完成” | Home / Chat / 高级页 |
| 新 `--status-running` | 无，常硬编码 `#38bdf8/#22c55e` | 同一 running 在 Rail 蓝、Chat 绿 | Dark `#38bdf8` / Light `#2563eb` | Rail / Chat / 高级页 |
| 新 `--status-waiting` | 无，常硬编码 `#f59e0b/#38bdf8` | waiting 语义冲突 | Dark `#ffaf55` / Light `#d77814` | Rail / Chat / 高级页 |
| 新 `--status-danger` | 无，常硬编码 `#f87171/#ef4444` | 错误与删除色漂移 | Dark `#ff6e6e` / Light `#c82d2d` | Rail / Chat / Settings / 高级页 |
| 新 `--status-success` | 无，常硬编码 `#4ade80/#34d399` | 完成与 running 混用绿色 | Dark `#78ebbe` / Light `#1e9b6e`，通过形状/文案区分 | Rail / Chat / 高级页 |
| 新 `--status-unknown` | 无 | 断线/未知被当普通 muted | Dark `rgba(255,255,255,.30)` / Light `rgba(17,20,28,.25)` | Rail / Chat |
| 新 motion | 分散 `.15s/.18s/.2s/.26s` | 相同动作节奏不同 | `--dur-fast:120ms; --dur-normal:160ms; --dur-slow:220ms` | 全部 |
| 新 layer | `z-50/60/70/80/90` 与 `8999/9000` | Portal 容易互相穿透 | `--layer-popover:1000; --layer-drawer:4000; --layer-modal:10000; --layer-toast:11000` | Rail / Chat / Settings / 移动端 |

状态色需配合“颜色 + 文案/图形”使用，不能只换圆点颜色。当前 `SessionStatusChip` 已提供失败、启动中、执行中、待命、结束文字（`session-status-chip.tsx:27-32`），应保留语义，只把 `toneMap` 的 Tailwind 色统一映射到 token（`session-status-chip.tsx:34-54`）。

### 2.3 字体与密度

Mobius 已自托管 Inter 400–700、Noto Sans SC 400/500/700 和 JetBrains Mono（`index.css:11-82`），这比直接复制 CodexMonitor 的 system font 更适合中英混排。建议：

| 层级 | 建议 | 影响表面 |
| --- | --- | --- |
| 页面标题 | 18–20px / 600；Home 提问保持 20px（当前 `UserPage.tsx:409-411`） | Home / 高级页 |
| 区域标题 | 13–14px / 600 | Rail / Chat / Settings / 高级页 |
| 正文与输入 | 13–14px / 400；Composer 14px / 1.55 | Home / Chat / Settings |
| 控件标签 | 12px / 500–600；按钮默认 32px 高 | 全部 |
| 元数据 | 中文 10–11px / 400–500；不要低于 10px | Rail / Chat / 高级页 |
| 代码 / Diff | 11–12px / 400，行高 1.35；Mobius Code Mono 保留 | Chat / 高级页 |

CodexMonitor 的代码 11px/1.28（`themes.dark.css:11-15`）可以作为密度下限，而不是中文 UI 的统一字号。Mobius 当前 Rail 已是项目/会话 12px、元数据 9px（`conversation-rail.tsx:297-324`）；建议把 9px 时间提高到 10px，不再进一步压缩。

## 3. 表面级落地原则

| 表面 | 必须学 | 可学 | 不要学 |
| --- | --- | --- | --- |
| Home | 中性页面 + 单一 Composer 主动作；最近项目只用边界/active | 900px 可读列、20–24px gutter | CodexMonitor 44px 品牌大标题、Usage、渐变主按钮 |
| Rail | 稳定宽度、单行状态就近、hover 与 active 分离 | 120–160ms 反馈、按项目折叠 | 14–16px 大胶囊照搬、多个彩色对象类型图标 |
| Chat | 消息/工具层级靠间距与细边界；状态色统一 | 900px 内容列、工具摘要按需展开 | 把 JSONL 时间线改成大气泡聊天皮肤 |
| Settings | Overlay 强表面、双栏、统一层级、焦点环 | 12px 圆角与轻阴影 | 主题工坊色彩渗入默认设置导航 |
| 高级页 | 使用同一 token/控件尺度，不自建一套视觉语言 | 局部信息密度可以高于 Home | 为“高级”重新引入重渐变、彩色卡片墙 |

最终原则：**品牌色保留，语义色收敛；能力保留，默认表面降噪。** 具体 chrome 位置见 [06-layout-and-chrome.md](./06-layout-and-chrome.md)，动作与焦点契约见 [07-interaction-and-navigation.md](./07-interaction-and-navigation.md)，实施拆分见 [09-implementation-backlog.md](./09-implementation-backlog.md)。
