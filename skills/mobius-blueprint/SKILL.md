---
name: mobius-blueprint
description: 为 Mobius 项目编写/更新「项目蓝图」——保存到项目隐藏目录
  <MOBIUS_HIDDEN_FOLDER_NAME>/blueprints/<module>/<blueprint_name>.html 的自包含 HTML
  设计文稿，供人类快速理解项目逻辑并做出决策。也适用于编写可托管的
  HTML 操作部署文档（亮/暗双主题、等距字体对齐、TL;DR 正向化）。
---

# Mobius 项目蓝图 (Project Blueprint) + HTML 写作规范

这是 Mobius 内置 Skill。不要让用户安装或调用 Codex / Claude Code 自身的
Skill / Memory 系统，只使用当前 Session 注入的 Mobius 上下文与项目文件。

本文档分两部分：**一、蓝图规范**（项目设计文稿）；**二、通用 HTML 写作规范**
（操作部署文档等，含双主题、等距字体、CDN 托管）。两类场景侧重点不同，
按实际任务取用相应规则。

MOBIUS_HIDDEN_FOLDER_NAME 通常为 `.mobius`，运行 `echo $MOBIUS_HIDDEN_FOLDER_NAME` 查看。


## 一、蓝图是什么

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

## 蓝图 HTML 硬性规范

- 单文件自包含：所有 CSS 内联（`<style>`），图示用内联 SVG 或 HTML/CSS 绘制。
- **禁止任何外部依赖**：不引用 CDN、远程字体（包括 Google Fonts）、远程
  图片 URL、外链脚本。
- **图片放蓝图旁边，用相对路径引用**（见下节「蓝图里的图片」）：截图这类
  大图不要 base64 塞进 HTML。
- 允许 `<script>`（预览沙箱允许脚本，可做折叠/高亮等轻交互），但内容离开
  脚本也必须可读，且脚本不得访问网络。
- 使用系统字体栈（如 `system-ui, -apple-system, "Segoe UI", "PingFang SC",
  "Microsoft YaHei", sans-serif`）。
- 体积控制在 500KB 以内（编辑器预读上限 1.5MB，超限不可编辑）。
- 用 `html { background: ... }` 自带底色，兼顾明暗环境下的可读性。

## 蓝图里的图片（截图 / 照片 / 生成图）

蓝图预览是 `srcDoc` + `sandbox="allow-scripts"` 的沙箱 iframe，文档自身
拿不到项目文件。Mobius 会在**预览时**把 HTML 里的相对图片读出来、在内存里
换成 data URI 再送进 iframe，所以：

- HTML 文件里写**相对路径**，磁盘上保持小体积；图片本体放在蓝图旁边的
  `assets/` 目录里。
- 支持三种写法（按优先级）：

  | 写法 | 含义 | 示例 |
  |------|------|------|
  | `./assets/x.png` | 相对当前蓝图所在目录 | `<img src="./assets/overview.png">` |
  | `../shared/x.png` | 上跳目录 | `<img src="../shared/logo.png">` |
  | `/…/x.png` | 项目根相对 | `<img src="/.mobius/blueprints/backend/assets/x.png">` |

- 只处理**图片类引用**：`<img src>`、`<source src/srcset>`、`<video src/poster>`、
  SVG `<image href>`，以及 `<style>` / `style=""` 里的 `url(...)`。
  `http(s):`、`data:`、`//host/...`、`#锚点` 原样保留（规范上也不该出现远程图）。
- 单张 ≤ 2MB；截图建议先压成 webp 或优化过的 png。小图标（< 100KB）仍可直接
  data URI 内联，保证 HTML 单独外发时也可读。
- 图片加载失败不会阻断整篇预览：那张图显示为裂图，其余内容照常。

### 制作步骤

1. 截图/生成图落到项目目录（会话里常见的 `/tmp/...` 路径不在项目内，先拷进来）：

   ```bash
   mkdir -p <项目绑定目录>/.mobius/blueprints/<module>/assets
   cp /tmp/shot.png <项目绑定目录>/.mobius/blueprints/<module>/assets/<name>.png
   ```

2. HTML 里引用：`<img src="./assets/<name>.png" alt="一句话说明这张图在讲什么">`。
3. 在「项目蓝图」Tab 里打开即可看到图；点左侧文件树里的图片文件也能直接预览，
   用来核对路径有没有写错。
4. 已有蓝图如果曾把截图 base64 内联成巨型 HTML（> 1.5MB 就无法编辑了），
   把图片抽到 `assets/` 再改成本地引用，文件会立刻瘦回几十 KB。

> 注意：图片存在项目目录里，会进 git。大图请压缩，别把原始 4K 截图直接提交。

## 写作规范（为决策服务）

- **逻辑至上**：关注逻辑的连贯性，在html内部，缓缓展开待介绍的主题，绝不允许冷不丁出现前面没有介绍过的东西（包括英文缩写、脚本、路径等）。
- **结论先行**：首屏给出一段话结论 + 元信息（日期、状态、适用版本/commit）。
- **语言自然**：详情见 ../mobius-human-style-writing/SKILL.md
- 一屏一主题：一张蓝图讲清一个机制，长度控制在 3-6 屏。
- 系统设计图用内联 SVG：组件框 + 箭头 + 分组，配色克制（3-4 色），
  每个框标出对应源码路径，方便跳转核对。
- 关键取舍用对比表（方案 / 代价 / 收益 / 结论）。
- 引用真实路径与符号名（`file.ts:function`），不凭记忆编造；讲不清的
  地方如实标注「未核实」。

## 视觉与结构规范（活样板：`blueprint_example_for_manual.html`）

同目录的 `blueprint_example_for_manual.html` 是排版的活样板，蓝图取用其中
与「自包含」不冲突的部分：

- **亮/暗双色板**：CSS 变量 + `:root[data-theme="dark"|"light"]`，默认跟随
  `prefers-color-scheme`，右下角悬浮圆形按钮切换（日/月图标）。
- **骨架**：`h1` + `.meta` 元信息行 + `.box ok` 的 TL;DR + `.toc` 锚点目录
  （`columns: 2`）+ 带 `id` 的编号 `h2` 章节 + `.footer` 页脚。
- **写作**：TL;DR 只写「做了什么」（正向）；主体章节只写正向陈述，负面经验
  （坑、失败模式、边界限制）集中到文末独立的「附录：避坑大全」，用
  「症状 → 根因 → 解法」三列表格收纳。
- **排版要素**：`.box info/ok` 信息框、`.tag` 标签、斑马纹表格、
  `pre.mono-result` 等距结果框（key-value 对齐）。
- 现成范例见项目隐藏目录下 `blueprints/{aimux,sandbox,system,frontend,backend}/*.html`。

蓝图对样板的**两处覆盖**（蓝图必须自包含、且在沙箱里运行）：

1. **不嵌 `@font-face`、不引 CDN / 远程字体**（Part 二 允许，蓝图不允许）。
   等宽场景走系统等宽栈；`pre.mono-result` 只把 ASCII 放在列首、中文只出现在
   行尾，换任何字体都不串列。
2. **脚本必须沙箱安全**：预览 iframe 是 `sandbox="allow-scripts"` 独立源
   （`location.origin === "null"`），`localStorage` / `sessionStorage` 会抛
   `SecurityError` —— 访问一律 `try/catch` 兜底（代价是主题选择在预览里不
   持久化，下次按系统偏好重来）。脚本只做折叠 / 主题这类轻交互，不访问网络。
3. **图示不许交给联网渲染库**：`<div class="mermaid">` + 从 jsdelivr `import`
   的写法在 Mobius 环境里拉不到包（实测 `net::ERR_CONNECTION_RESET`），预览
   会退化成一大段 `flowchart TD ...` 源码文本。图一律画成内联 SVG 或
   HTML/CSS 框线（仓内已有先例）。

## 完成动作

写完文件后，在回复里给出蓝图相对路径，并提醒用户可在项目的
「设置 → 项目蓝图」Tab 查看。不要把 HTML 全文贴进对话。


## 二、通用 HTML 写作规范（操作部署文档等）

适用于「操作手册 / 部署文档 / 运维 SOP」类 HTML（会托管到 CDN 供团队查阅，
与上述「项目蓝图」预览沙箱场景不同，因此**允许自托管 Web Font 和 CDN 资源**）。
这类文档的目标是产出一篇结构清晰、可长期复用、读起来像操作手册而非踩坑
流水账的文档。

### 核心原则（三条，缺一不可）

#### 1. TL;DR 只写「做了什么」，正向陈述

文档开头的 TL;DR（一句话摘要）只描述**完成了什么、达成了什么**。
- ✅ 只写：部署了什么模型、用了什么配置、验证结果如何
- ❌ 不写：遇到了什么坑、不要怎么做、什么会失败
- ❌ 不写：背景里的负面约束（如「跨节点不可靠所以不用 X」——这种归附录）

> TL;DR 的读者只想 3 秒判断「这篇讲的是不是我需要的」。负面信息在这里是噪声。

#### 2. 主体章节零负面陷阱

正文每一章都是**正向操作指南**：该做什么、参数是什么、怎么验证。
- 涉及「不要做 X / 否则会 Y / 某某不可靠」的内容，**全部移到末尾的「避坑附录」**
- 主体里只出现「采用 X」「配置为 Y」这类肯定句
- 即便是出于解释一个选择（如「为什么用方案 B」），主体里只一句话点明选择，**失败模式的细节进附录**
- 操作性提示（如「IP 会变，每次现探」）不算负面陷阱，可保留，但用中性语气、不挂警告框

> 主体是给人照着做的；附录是给人排错时翻的。混在一起会让照做的人一直被「会出错」打断。

#### 3. 避坑集中收录在末尾附录

文末设一个独立附录章（如「避坑大全 / 故障排查」），用「症状 → 根因 → 解法」
三列表格收纳所有负面经验。
- 主体里被移走的警告框、失败解释、「3 个坑」类内容，统一汇到这里
- 附录可以长、可以全，因为它只在出问题时被检索
- 主体章节用锚点链接到附录相关条目（可选），保持主体干净

### 视觉与交互规范

#### 主题：亮色 / 暗色双模式 + 悬浮切换按钮

- 默认跟随系统 `prefers-color-scheme`，用户切换后用 `localStorage` 记住
- 悬浮按钮固定在右下角（`position: fixed`），小圆形，显示日/月图标
- 用 CSS 变量定义两套色板，`[data-theme="dark|light"]` 在 `<html>` 上切换

```css
:root[data-theme="dark"]  { --bg:#0d1117; --text:#e6edf3; ... }
:root[data-theme="light"] { --bg:#fff;    --text:#1f2328; ... }
```

```js
var html = document.documentElement;
var saved = localStorage.getItem('theme');
if (!saved) saved = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
html.dataset.theme = saved;
document.getElementById('themeBtn').onclick = function(){
  var t = html.dataset.theme === 'dark' ? 'light' : 'dark';
  html.dataset.theme = t; localStorage.setItem('theme', t);
};
```

### 排版要素

| 要素 | 用途 |
|------|------|
| **代码块 `<pre>`** | 命令、配置、脚本。等宽字体 + 横向滚动 |
| **行内 `<code>`** | 路径、参数名、IP |
| **表格** | 参数清单、节点清单、症状-根因-解法 |
| **彩色信息框** | 主体仅用「正向提示框」（如验证结果 ✅）；警告/危险框只在附录 |
| **可折叠 `<details>`** | 长脚本展开查看，避免刷屏 |
| **目录锚点** | 顶部 TOC，每章带 `id`，可跳转 |
| **等距结果框 `pre.mono-result`** | 验证结果、分发统计等「key-value 对齐」或「数字列对齐」的内容 |

### 等距字体对齐规则（中文 2 格、英文 1 格）

验证结果框、统计输出这类内容需要严格列对齐。中英文混合时，必须确保 CJK
字符占 2 倍英文字符宽度，否则 `finish_reason:` 和 `tool_calls:` 这种 key 列
会错位。

#### 方案：自托管 Web Font（访客无需本地字体）

光在 CSS `font-family` 里写字体名是**不够的**——访客机器大概率没装 Ubuntu
Mono / Inconsolata / Noto Sans Mono CJK，会 fallback 到系统比例字体，
`font-variant-east-asian: full-width` 对 fallback 字体不保证生效，结果就是
「自己看是对的、别人看是歪的」。**必须嵌入 Web Font 并自托管到 CDN。**

**第一步：下载 woff2 字体文件**（连外网用 proxychains）：

```bash
# Inconsolata（英文等宽，~17KB）—— 作者实测认可的 2:1 等宽字体之一
proxychains4 -q curl -sL \
  "https://cdn.jsdelivr.net/npm/@fontsource/inconsolata/files/inconsolata-latin-400-normal.woff2" \
  -o Inconsolata-Regular.woff2
# Noto Sans SC（中文，~1.1MB）—— 配 full-width 强制中文全宽
proxychains4 -q curl -sL \
  "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff2" \
  -o NotoSansSC-Regular.woff2
file *.woff2   # 确认是 "Web Open Font Format (Version 2)"，若返回 HTML 说明被墙，需 proxychains
```

> ⚠️ `curl` 直连 jsDelivr / Google Fonts 在国内沙箱会返回 HTML 重定向页（几十
> 字节），不是字体。**必须 proxychains4**。`file` 命令验证是 woff2 再进行下一步。

**第二步：上传字体文件到 CDN**（自托管，国内访客加载快）：

```bash
python3 upload_to_cdn.py --folder webfonts --file Inconsolata-Regular.woff2 --filename Inconsolata-Regular.woff2
python3 upload_to_cdn.py --folder webfonts --file NotoSansSC-Regular.woff2 --filename NotoSansSC-Regular.woff2
```

**第三步：HTML 里 `@font-face` + `unicode-range` 分流**（英文走 Inconsolata，
中文走 NotoSC + full-width）：

```css
@font-face {
  font-family: "Inconsolata";
  src: url("https://serve.nutshellai.cn/publish/auto/webfonts/Inconsolata-Regular.woff2") format("woff2");
  font-weight: 400; font-style: normal; font-display: swap;
  unicode-range: U+0000-007F, U+00A0-00FF, U+2000-206F;  /* 拉丁/标点 */
}
@font-face {
  font-family: "NotoSC-Mono";
  src: url("https://serve.nutshellai.cn/publish/auto/webfonts/NotoSansSC-Regular.woff2") format("woff2");
  font-weight: 400; font-style: normal; font-display: swap;
  unicode-range: U+4E00-9FFF, U+3000-30FF;  /* CJK */
}

pre.mono-result {
  font-family: "Inconsolata", "NotoSC-Mono", monospace;
  font-variant-east-asian: full-width;   /* CJK 强制全宽（2 格） */
  font-feature-settings: "fwid" 1;
  white-space: pre;                       /* 不自动换行，保列对齐 */
  letter-spacing: 0;                       /* 关闭字距微调 */
}
```

要点：
- **英文等宽字体首选 Ubuntu Mono 或 Inconsolata**（观感最好的 2:1 等宽字体，
  作者实测认可的唯二）；不用 JetBrains Mono / Fira Code 等
- **必须自托管 Web Font**：`font-family` 光写名字，访客没装就 fallback 到比例
  字体，对齐全垮。字体文件上传 CDN，`@font-face` + `font-display: swap`
- **用 `unicode-range` 分流**：英文走 Inconsolata（小，17KB），中文走
  NotoSC-Mono（大，1.1MB），浏览器只按需加载对应子集
- `font-variant-east-asian: full-width` 强制 CJK 走全宽（2 格）——前提是字体含
  `fwid` 特性表（Noto Sans SC 有）
- `white-space: pre` + `letter-spacing: 0` 避免自动换行和字距微调破坏对齐
- 手动在源码里用空格补齐 key 列（如 `content:        ''`），配合等宽字体才能对齐

#### ★ CDN 缓存坑（更新 HTML 不生效）

serve.nutshellai.cn 前面是阿里云 CDN（Tengine），会缓存 HTML。改了 HTML 后
即使源站文件已更新（md5 已变），公网 curl 拿到的还是旧的
（`X-Cache: HIT TCP_MEM_HIT`），导致改了没效果。

**解法：换文件名上传**（cache-busting）。如 `xxx.html` → `xxx-v2.html`，新 URL
无缓存，立即生效。旧 URL 等缓存自然过期或联系运维刷新。

诊断方法：
```bash
# 比较本地 md5 与 CDN 公网 md5
md5sum local.html
curl -s "https://serve.nutshellai.cn/.../local.html" | md5sum
# 不一致 = CDN 缓存了旧版 → 换文件名
curl -sI URL | grep -i 'x-cache\|age\|last-modified'   # HIT = 命中缓存
```

### HTML 转义（写代码块时最易出错）

`<pre>` 里出现的 `<` `>` `&` 必须转义为 `&lt;` `&gt;` `&amp;`，否则被浏览器
当成标签解析、内容被截断。尤其注意 shell 的 `&&`、重定向 `>`、JSON 的 `<`。

### 章节骨架（操作文档推荐）

```
1. TL;DR                      ← 正向一句话（本文做了什么）
2. 集群/环境信息              ← 节点、IP、版本（中性事实）
3. 架构总览                   ← 图示 + 一句话点明方案选择（细节进附录）
4. 前置检查                   ← source 环境 / 验证注册 / 互通
5. 启动参数详解               ← 完整命令 + 逐参数表（只写「用什么」）
6. 部署脚本                   ← 可折叠源码
7. 启动流程                   ← 分发 → 启动 → 轮询就绪
8. 负载均衡                   ← 配置 + 要点（正向）
9. 验证                       ← 4 步 + 实测结果（✅）
10. 功能验证（工具调用等）    ← 要点 + 命令 + 结果
11. 运维命令
12. 附录：避坑大全            ← 所有负面经验集中于此（症状-根因-解法表）
```

### 自检清单（写完逐条过）

- [ ] TL;DR 是否只含「做了什么」，没有任何「不要 / 不可靠 / 会失败」？
- [ ] 主体每章是否只有正向陈述？警告框是否都搬到了附录？
- [ ] 末尾是否有独立的避坑附录？
- [ ] 亮/暗主题是否都能正常显示，悬浮按钮是否切换并持久化？
- [ ] `<pre>` 里的 `<` `>` `&` 是否都已转义？
- [ ] 是否有目录锚点可跳转？
- [ ] 长脚本是否用了 `<details>` 折叠？
- [ ] 等距字体是否**自托管 Web Font**（不只写 font-family 名字）？`@font-face`
      + `unicode-range` 分流 + CDN 自托管 woff2？
- [ ] 验证结果框 / 统计输出是否用了 `pre.mono-result`，中英文列对齐正确
      （中文 2 格英文 1 格）？
- [ ] 更新 HTML 后是否**换了文件名**绕过 CDN 缓存？本地 md5 与公网 curl md5
      是否一致？
