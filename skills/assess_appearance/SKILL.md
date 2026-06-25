---
name: assess_appearance
description: 修改小莫助手右下角图标的完整规范——按统一标准重设计动态头像 + 全套状态指示(含录音态)，确保始终动态、美观、且录音状态可见
---

# 修改小莫助手右下角图标 · 完整规范

本 Skill 指导如何**重设计 / 调整「小莫助手」右下角浮动图标(以下称 FAB 图标)**。
目标:让图标**始终在动态变化、好看、美观**,并且**任何重设计后都必须保留全套状态指示(尤其是「录音中」状态)**。

> 适用对象:对 `mobius/frontend` 前端做自迭代的 agent / 用户。
> 作用域:**仅** FAB 图标本身(`assistant-fab` + `mo-avatar` + 状态浮层)。不要改动助手面板(`assistant-panel`)、消息流、语音后端逻辑。

---

## 0. 硬性要求(四条铁律,缺一不可)

任何一次图标修改,最终交付**必须**同时满足以下四条。验收清单(见 §10)逐条核对,任何一条不过则视为失败、返工。

1. **始终动态**:空闲态(非打开、非录音、非说话)也必须有持续运行的动画。图标永远「活着」,不允许静止的死图。
2. **美观**:配色统一、有光晕(halo)与多层深度阴影、明暗主题双适配、动效顺滑不眩晕。
3. **录音状态可见**:`.assistant-fab--voice-recording` + `.assistant-fab__voice-badge` 长按录音时的红色麦克风指示**必须保留且醒目**(见 §5、§6)。
4. **状态系统完整**:说话 / 长按 / 录音 / 转写 / 关闭 / 任务完成 六种状态的视觉指示**一个都不能少**(见 §4),行为契约(TSX 侧)不得破坏。

---

## 1. 图标在哪里(定位地图)

| 角色 | 文件 | 位置 |
|---|---|---|
| FAB 按钮渲染 + 状态变量 | `mobius/frontend/src/components/assistant-chat.tsx` | FAB `<button>` 约 L3372–3413;状态派生约 L3348–3368 |
| 图标组件 `MoAvatar` | 同上 | `MoAvatar()` 约 L615–640 |
| 粒子常量 | 同上 | `MO_PARTICLES = Array.from({length:18},...)` 约 L32 |
| 长按进入录音 | 同上 | `ASSISTANT_FAB_VOICE_HOLD_MS = 1500` 约 L37;`collapsedVoiceHoldState` 约 L1600 |
| FAB 样式(容器/halo/各状态) | `mobius/frontend/src/index.css` | `.assistant-fab*` 约 L1446–1638 |
| 头像样式(球体/环/核/粒子/keyframes) | 同上 | `.mo-avatar*` 约 L4540–4709 |
| 状态动画 keyframes | 同上 | 约 L3359–3393 |
| 减弱动画兜底 | 同上 | `@media (prefers-reduced-motion: reduce)` 约 L4711 起 |

> 行号会漂移,**以选择器名 / 类名 / 函数名为准**,行号仅作辅助定位。

---

## 2. 图标的完整解剖(FAB = 容器 + 头像 + 状态浮层)

```
<button class="assistant-fab fixed bottom-5 right-5 z-[60] w-14 h-14 rounded-full ...">   ← FAB 容器(见 §3)
  ├── <MoAvatar>                                                                          ← 动态头像本体(见 §3.1)
  │     ├── .mo-avatar                      容器,mo-life-float 漂浮
  │     ├── .mo-avatar__field               渐变能量球,mo-field-breathe 呼吸
  │     ├── .mo-avatar__ring--outer         外轨道环,mo-ring-turn
  │     ├── .mo-avatar__ring--inner         内轨道环,mo-ring-turn-reverse
  │     ├── .mo-avatar__core                白蓝高光核,mo-core-pulse
  │     └── .mo-avatar__particle--1..18     18 粒子,各持 drift-a/b/c + 独立 delay/color
  ├── .assistant-fab__speaking-waves        说话时 3 道扩散波环(可选渲染)
  ├── .assistant-fab__hold-ring             长按蓄力旋转环(可选渲染)
  ├── .assistant-fab__voice-badge           录音(红 Mic)/ 转写(蓝旋转 RefreshCw)徽标(可选渲染)
  ├── .assistant-fab__close                 打开态的关闭 X(可选渲染)
  └── .assistant-fab__completion-badge      任务完成绿色提示(可选渲染)
```

容器还有个伪元素 `.assistant-fab::before` —— 这是**招牌光晕**:conic-gradient + blur + 缓慢旋转,决定了「高级感」,重设计务必保留一个等价光晕层。

### 2.1 两种尺寸 / 性能变体

- `.mo-avatar--lg` (46px) 用于 FAB;`.mo-avatar--sm` (26px) 用于消息气泡头像。
- **尺寸用 `em` 单位**(容器 `font-size` 决定整体缩放),内部所有 `.07em`、`left:47%` 等百分比/em 让粒子在 lg/sm 下等比缩放。**重设计时保持 em/百分比体系**,别写死 px,否则 sm 头像会崩。
- `.mo-avatar--lite`:消息列表逐条头像用的**性能变体**,禁用全部无限动画(`animation:none !important`)只渲染静态渐变球。**禁止改动 lite 的禁动画策略**——长会话滚动时 18 粒子 + filter 持续重绘会严重掉帧。

### 2.2 active 加速态

`MoAvatar` 的 `active` prop 为真时(打开/发送中/有活动任务/说话/录音)挂 `.mo-avatar--active`,把主要动画 `animation-duration` 调短(球/核 4.8s、粒子 6.4s),让图标「兴奋起来」。重设计应保留这种「空闲慢、活跃快」的节奏对比。

---

## 3. 动态规范(满足铁律 1:始终动态)

### 3.1 必须存在的动画层

一份合格的图标至少叠 4 层持续动画,确保**任何瞬间都不静止**:

1. **漂浮**:容器级 `mo-life-float`(整体轻位移 + 微缩放 + 微旋)。
2. **呼吸/流光**:能量球 `mo-field-breathe`(饱和度/亮度/形状微变)。
3. **环绕**:外环 `mo-ring-turn` + 内环 `mo-ring-turn-reverse`(双向)。
4. **微粒**:≥10 颗粒子用 `mo-particle-drift-a/b/c`,**每颗独立 `animation-delay`(用负 delay 错峰)**,避免齐步走显得机械。

> 当前用 18 颗粒子覆盖球体四周。减少颗数可以,但**别低于 10**,且**每颗 delay 必须各不相同**(现在用 -1.1s ~ -8.5s 交错)。

### 3.2 节奏与缓动

- 周期**全部用 `infinite`**;时长相互**错开**(球 7.4s / 外环 13s / 内环 9.5s / 核 5.8s / 粒子 8.8s)避免周期性同步导致的「卡顿感」。
- 缓动用 `ease-in-out` / `linear`(旋转类),**禁止线性硬切的闪烁**。

### 3.3 可访问性(必须保留)

- `@media (prefers-reduced-motion: reduce)` 块约 L4711 起,把 `.assistant-fab::before`、`.assistant-fab--speaking`、波环、hold-ring、voice-badge、`.mo-avatar` 全家动画置为 `none`。重设计新增的任何动画元素**都要补进这个媒体查询**,否则违反无障碍。
- `MoAvatar` 与所有浮层都带 `aria-hidden="true"`(纯装饰),保留。

---

## 4. 状态系统(满足铁律 4:六态完整)

FAB 的 `className` 由 `assistant-chat.tsx` 约 L3362–3368 动态拼装。**这是行为契约,TSX 侧不要改;重设计只动 CSS / DOM 外观。**

| 状态 | TSX 变量(约 L3348–3352) | 容器 class | 渲染的浮层 | 用户语义 |
|---|---|---|---|---|
| 说话中(语音播报播放) | `fabSpeaking = voicePlaybackState==='playing'` | `--speaking` | `.assistant-fab__speaking-waves` | 小莫在说话 |
| 长按蓄力(未松手,>1.5s 前的过渡) | `fabVoiceHolding = !open && state==='holding'` | `--voice-holding` | `.assistant-fab__hold-ring` | 继续按进入语音 |
| **录音中** | `fabVoiceRecording = !open && state==='recording'` | `--voice-recording` | `.assistant-fab__voice-badge`(红 `<Mic>`) | 松开结束录音 |
| 转写中 | `fabVoiceTranscribing = !open && voiceState==='transcribing'` | `--voice-transcribing` | `.assistant-fab__voice-badge`(蓝 `<RefreshCw>` 自旋) | 正在转写语音 |
| 打开(面板展开) | `open` | — | `.assistant-fab__close`(X) | 收起小莫 |
| 任务完成未读 | `!open && unreadCompletion>0` | — | `.assistant-fab__completion-badge`(绿) | N 项任务完成 |

`MoAvatar` 的 `active` 在「打开 / 发送中 / 有活动任务 / 说话 / 任一语音态」时为真,加速动画。

**重设计守则**:每个状态都要有**可被一眼区分**的视觉(颜色/形状/动效不同),且**互不冲突**。徽标用 `z-index` 分层(现在 close=3、badge=5、hold-ring=4、waves=1、completion=6、avatar=2),新增浮层注意层级。

---

## 5. 录音状态(满足铁律 3:录音可见)—— 最关键

当前实现(`index.css` 约 L1528–1545、L1588–1591;TSX 约 L3394–3402):

- **红色麦克风徽标** `.assistant-fab__voice-badge`:右下角 26px 圆,`background: rgba(239,68,68,.96)`(红),内含 `<Mic>` 图标,带白色描边 + 红色外发光阴影,`assistant-fab-recording-badge` 动画(1s 缩放 + 阴影脉冲扩散)。
- **容器态** `.assistant-fab--voice-recording::before`:把招牌光晕从青/紫/粉改成「红」基调 conic-gradient,opacity 提到 .9,让整圈泛红,录音感更强。

**重设计录音态时必须保证**:

1. **红色基调不可去**:录音是「危险/进行中」语义,用红(或饱和暖色)与说话(青)/转写(蓝)拉开差距。配色变了仍要保证红是录音专属。
2. **麦克风图标 `<Mic>` 不可替换为无语义图形**:用户要能从图标认出「正在录音」。
3. **徽标必须够大够亮**:`.assistant-fab__voice-badge` 当前 26px、右下外溢 -4px。重设计可调整但**别小于 22px、别藏到 FAB 内部不可见**。
4. **持续脉冲动效**:录音徽标要有 `assistant-fab-recording-badge` 这类循环动画,「正在采集」感。静态红点不合格。
5. **容器整体要有反应**:`--voice-recording` 改 `::before` 光晕色 —— 保留这一层,让录音时整颗图标都泛红脉动,而不只是角落一个小点。
6. **录音态与转写态可区分**:转写是蓝 + 自旋 `<RefreshCw>`(`--voice-transcribing`),别让两者变一样。

> 验收时(见 §9)必须人工触发长按录音并确认:徽标出现、为红色、有脉冲动效、整圈泛红、松手后消失。

---

## 6. 美观规范(满足铁律 2:美观)

### 6.1 配色(建议沿用既有体系)

- 暗主题球体:青 `#2dd4bf` / 蓝 `#38bdf8`/`#7dd3fc` / 紫 `#818cf8`/`#c4b5fd` / 粉 `#f472b6`/`#fda4af` / 金 `#facc15`/`#fde68a`。高光白蓝核。整体偏「能量/生命」冷调 + 暖点缀。
- FAB 容器暗主题:`rgba(10,14,22,.72)` 深玻璃底 + 白 14% 描边 + 多层青/金外发光阴影。
- 明主题(`.light .assistant-fab*`,约 L1615–1638):浅底 + 深字 + 阴影降饱和。**改暗主题配色务必同步 `.light` 一组**,明暗都要好看。
- 录音 = 红 `#ef4444`、转写 = 蓝 `#0ea5e9`、完成 = 绿 `#22c55e`、说话 = 青。**状态色与球体色系分开**,避免混淆。

### 6.2 深度与质感

- **招牌光晕** `.assistant-fab::before`:conic-gradient + `filter:blur(14px)` + 缓慢旋转(`mo-halo-turn`)。重设计至少保留一层等价光晕;说话态把 opacity/saturate 拉满 + 加速(现 `.assistant-fab--speaking::before`)。
- **多层 box-shadow**:底投影(深度)+ 0 0 0 描边色 + 彩色外发光三层打底。hover 提亮发光。
- 玻璃感用半透明底 + backdrop-filter(关闭按钮 `.assistant-fab__close` 已用),新增浮层可沿用。
- 内阴影 `inset` 给球体立体感(`__field` 的 `inset 0 0 ...` + 底部暗 inset)。

### 6.3 动效品味

- 顺滑缓动、周期错峰、幅度克制(位移/缩放 < 5%–8%),**不眩晕、不抖**。
- 进入/退出用短促 cubic-bezier(如 completion 用 `.32s cubic-bezier(.2,.9,.25,1)`)。
- 旋转类用 `linear infinite`;呼吸/脉冲用 `ease-in-out infinite`。

---

## 7. 修改流程(标准步骤)

1. **先读后改**:按 §1 定位,通读 `MoAvatar`、FAB `<button>` 渲染段、`.assistant-fab*` 与 `.mo-avatar*` 两段 CSS,理解现状再动手。
2. **明确改什么**:只改(a)配色/质感、(b)动画节奏、(c)粒子/环/核造型、(d)状态浮层外观。**不要改** TSX 的状态变量、长按时长、`aria-hidden`、lite 性能策略、reduced-motion 策略。
3. **改 CSS 优先**:绝大多数外观调整只动 `index.css`。需要新增 DOM 层(如更多粒子)才动 `MoAvatar`,且务必同步 reduced-motion。
4. **保持 em/百分比体系**:头像内部尺寸继续用 em/%;只有徽标/徽章等「固定信息密度」元素可用 px。
5. **明暗双改**:改暗主题一组配色,**立刻同步 `.light` 一组**。
6. **补 reduced-motion**:新动画元素全部加进 §3.3 媒体查询。
7. **本地构建验证**:`cd mobius/frontend && npm run build`(= `vite build`)必须通过,见 §8。
8. **人工验收**:按 §9 逐状态截图核对,§10 清单全过。
9. **提交上线**:见 §11。

---

## 8. 构建命令

```bash
# 仅验证前端编译是否通过(快):
cd /app/mobius/frontend && npm run build

# 纯前端改动,编译 + promote 产物(不重启后端、无交互,适合自动化迭代):
cd /app && python3 start.py --only-update-frontend

# 全量(编译 + 重启后端 + code-server,非交互环境会卡 attach 提示,慎用):
cd /app && python3 start.py
```

`vite build` 报错先修 TSX/CSS 语法,再继续。

---

## 9. 人工验收(逐状态,建议截图核对)

浏览器打开应用,操作右下角小莫图标,确认每个状态视觉正确:

- [ ] **空闲态**(刚进页面、未打开):球体呼吸、双环旋转、粒子飘移、外圈光晕缓转 —— **明显在动**。
- [ ] **hover**:放大发光增强。
- [ ] **打开**:出现 X 关闭符;`active` 加速,动画变快。
- [ ] **说话**(触发一条回复的语音播报):3 道扩散波环 + 容器轻微上浮 + 光晕加亮加速。
- [ ] **长按蓄力**(收起态长按 FAB < 1.5s):hold-ring 旋转环出现。
- [ ] **录音中**(长按 ≥ 1.5s):**右下红色 Mic 徽标 + 脉冲扩散 + 整圈泛红光晕**(§5 六条逐条确认)。
- [ ] **转写中**(松手后短暂):徽标变蓝 + RefreshCw 自旋。
- [ ] **任务完成**:未读时绿色「任务已完成」徽章从上方弹出。
- [ ] **明主题**:切换 light,所有状态配色/可读性正常,不刺眼。
- [ ] **reduced-motion**:系统开「减弱动态效果」,所有无限动画停止、静态仍美观、各状态徽标仍可辨认。
- [ ] **消息气泡 sm 头像**:lite 态静态球,长会话滚动不卡顿。

---

## 10. 交付验收清单(铁律对照)

- [ ] **铁律 1 始终动态**:空闲态 ≥4 层动画在跑、粒子 ≥10 颗错峰、全 `infinite`。
- [ ] **铁律 2 美观**:配色统一、招牌光晕在、多层深度阴影、明暗双适配、动效不眩晕。
- [ ] **铁律 3 录音可见**:红 Mic 徽标 + 脉冲 + 泛红光晕,§5 六条全过。
- [ ] **铁律 4 状态完整**:说话/长按/录音/转写/关闭/完成六态一个不缺且可区分。
- [ ] `npm run build` 通过。
- [ ] 未破坏 TSX 状态契约、长按时长、`aria-hidden`、lite 性能、reduced-motion。
- [ ] sm 头像未崩(em 体系完好)。
- 任一条不过 → 返工,不得交付。

---

## 11. 提交上线(遵循项目规则)

每次完成修改,**先 commit 所有文件**(含非本人改动的),再执行 `python3 start.py` 更新代码。

- commit message 格式:`<用户名>: <代码变动说明>`(用户名用英文或拼音,如 `chenyang: ...`)。
- commit message 仅说明本次图标变动(配色/动效/状态等)。
- commit 后 `python3 start.py`(或 `--only-update-frontend`)编译 + promote 前端产物。

---

## 12. 禁止事项(反模式)

- ❌ 把空闲态改成静止死图(违反铁律 1)。
- ❌ 删除/弱化红色录音徽标或去掉其脉冲动效(违反铁律 3)。
- ❌ 丢弃任何一种状态浮层或让两态外观撞车(违反铁律 4)。
- ❌ 拆掉招牌光晕 `.assistant-fab::before`、改用扁平无阴影。
- ❌ 给头像内部写死 px(破坏 sm/lg 等比缩放)。
- ❌ 改动 lite 性能变体的 `animation:none` 策略。
- ❌ 新增动画却不补 `prefers-reduced-motion`。
- ❌ 改暗主题配色却忘了同步 `.light` 一组。
- ❌ 改 TSX 的状态派生 / 长按时长 / `aria-hidden` 等**行为契约**。
- ❌ 跳过 `npm run build` 与人工逐状态验收就交付。
