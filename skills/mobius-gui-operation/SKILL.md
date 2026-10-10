---
name: mobius-gui-operation
description: AIMUX操作远程设备的图形界面。铁律：界面操作只能用 remote_gui_* 统一接口，禁止用系统命令注入键鼠。两种方法：① 模拟人类（只回截图 + 模型在图上定位 + 坐标注入真实键鼠，万能通用但慢）② 图形转文本结构（走无障碍元素树，快但不可靠）。含游戏类界面的鼠标双模式判断（有无鼠标指针决定点击能否作用到 UI）。当需要操作远程设备的桌面软件（IM、浏览器、办公软件、游戏、Qt/Electron 客户端等）时使用。含实测跑通的案例步骤，每次操作后都要确认是否生效。
---




# 铁律 —— 界面操作只走 remote_gui_* 统一接口

**这是最高优先级的约束，高于下面任何方法的便利性考量。**

- 允许使用的接口只有：`remote_gui_diagnostics`、`remote_gui_list_windows`、`remote_gui_focus_window`、`remote_gui_look`、`remote_gui_act`、`remote_gui_read_text`、`remote_gui_wait_for`。
- **绝对禁止**用 PowerShell / cmd / BAT / 任何系统命令去控制界面、注入键鼠。具体禁例：`SendKeys`、`keybd_event`、`mouse_event`、`SetForegroundWindow`、`-EncodedCommand`、AutoHotkey、nircmd、`wshell.SendKeys` 等等。
- 若某个 `action` 报错，**先查附录三**：`keypress requires keys` 属于「参数没传对」而不是「用不了」，照附录三传 `keys` 就能用。**绝不降级去调系统命令绕道**。确实用不了时，才改用其它 `action` —— `click` / `moveMouse` / `drag` / `scroll` / `typeText` / `press`；或者改变操作路径，走界面上的别的按钮、别的入口。
- **禁止**用 Base64 / `-EncodedCommand` 这类形式执行命令。执行的东西必须一眼看得清，藏起来本身就是错的。
- 每次 `act` 之后都要 `look` 确认；没生效就换 `action` 或换路径，不要原样重试。


# GUI操作方法1 - 模拟人类

`look` 只回截图 → 模型在图上定位并给出像素坐标 → `act` 注入真实键鼠 → 再 `look` 确认生效。
人怎么做，它就怎么做：看屏幕、点、再看一眼。

## 优缺点

优点：万能，通用
缺点：速度慢，开销大，需要模型有原生多模态能力；如果是纯文本模型 + 外挂多模态分析工具，理论上也可以，但需要注意【坐标矫正】（见下面的案例）

## 案例

目的：发送钉钉消息

步骤（React循环，主要是 remote_gui_look -> remote_gui_act -> remote_gui_look -> remote_gui_act -> ...，直到目标达成）：

- 使用 `remote_gui_diagnostics` 工具，目的是确认远端 GUI 辅助组件可用（accessibility 与 screenRecording 均为 true）。
- 使用 `remote_gui_list_windows` 工具，目的是找到目标窗口「阿里钉」（iDingTalk.exe），记下它的 `rootRef`。
- 使用 `remote_gui_focus_window` 工具，目的是把目标窗口切到前台并置顶；其中工具的参数来源于上一步的 `rootRef`。
- 使用 `remote_gui_look` 工具，目的是拿到窗口截图；其中工具的参数来源于 `rootRef`，并传 `include_image=true` + `max_output_tokens=1`（屏蔽无障碍元素树，只回图像）。本次截图 `1024×660`，窗口 `framePoints=(4247,139,2326,1500)`。
- 使用 `remote_gui_act` 工具（`action="click"`），目的是点中消息输入框；其中工具的参数 `look_id` 来源于紧邻上一步 `remote_gui_look` 的返回值（必填），`x=697, y=554` 来源于上一步的截图——模型直接在图上定位到输入框并取它的像素坐标；另传 `policy="foreground"`、`preserve_focus=true`（这两个参数**每次 act 都要带**）。
- 使用 `remote_gui_look` 工具（同上，`include_image=true` + `max_output_tokens=1`），目的是查看图片，确认上一步点击是否生效。
- 使用 `remote_gui_act` 工具（`action="typeText"`），目的是输入消息正文；其中工具的参数 `text="hello world"` 是正文内容本身，`look_id` 来源于紧邻上一步 `remote_gui_look` 的返回值（必填），`x=697, y=554` 沿用上一步截图坐标（输入框内任意点均可，作用只是让输入焦点落在框内）。
- 使用 `remote_gui_look` 工具（同上），目的是确认上一步打字是否生效。
- 使用 `remote_gui_act` 工具（`action="click"`），目的是点中「发送(S)」按钮；其中工具的参数 `look_id` 来源于紧邻上一步 `remote_gui_look` 的返回值（必填），`x=949, y=629` 来源于截图——模型在图上定位到发送按钮并取它的像素坐标。
- 使用 `remote_gui_look` 工具（同上），目的是确认上一步发送是否生效，检查：消息气泡「hello world」出现在「我」的会话里，且输入框已清空。

坐标问题：
- `act` 的 `x,y` 是 `look` 返回的那张【缩放截图】的像素，工具**内部会反演**回物理像素，不需要你操心。
- 如果你不具备多模态能力，依靠工具调用【外挂多模态模型】实现图像理解，请务必注意观察【外挂多模态模型】是否有涉及分辨率变换的预处理步骤。如果涉及分辨率变化，那记得做【坐标矫正】。

取图口径：`remote_gui_look` 没有「只回图像」的开关（`include_image=false` 是反过来，只有大纲）。本方法一律传 `include_image=true` + `max_output_tokens=1`：响应里不含 `outline` 字段，只剩窗口元数据与 `image_path`（大纲仍会构建，省掉的是响应体积，完整大纲约 10 万字符量级）。

## 分辨率与开销（`max_dimension`）

`remote_gui_look` 的 `max_dimension` 管截图**最长边**像素，三档选一个：

| 用途 | 值 | 相对开销 |
|---|---|---|
| 快速推理 | `512` | 1× |
| 常规 | `1024`（默认） | 4× |
| 需要高清 | `2048` | 9× |

`act` 的 `x,y` 就是这张缩放图的像素，工具内部**按同一个比例尺反演**回窗口坐标，换档不会让点击偏，不需要你操心。

## 熟练度与开销

上面的操作，都是act一下，看一眼结果。为了减小开销，如果你认为已经比较熟练了，可以看一眼操作多次。


---

# GUI操作方法2 - 图形转文本结构

用 `look` 的无障碍元素树（每个元素带 `ref` / `role` / `name` / `rect`）直接按元素操作，不注入真实键鼠。

## 优缺点

优点：效率高，速度快
缺点：不适用于复杂软件，不可靠

## 案例

目的：用计算器算 12×79

步骤：

- 使用 `remote_exec_command` 工具，目的是启动计算器（`calc.exe`）。
- 使用 `remote_gui_list_windows` 工具，目的是找到「计算器」窗口（win32calc.exe），记下它的 `rootRef`。
- 使用 `remote_gui_look` 工具，目的是拿到无障碍元素树；其中工具的参数来源于 `rootRef`，`include_image=false`、`max_output_tokens` 放大以取全树。本次返回 28 个 `canPress=true` 的按钮，每个都带 `ref` / `role` / `title` / `rect`。
- 使用 `remote_gui_act` 工具（`action="press"`），目的是按下数字与运算符键；其中工具的参数 `ref` 来源于上一步元素树里 `title` 等于目标字符的按钮（依次取 `title="1"` → `"2"` → `"乘"` → `"7"` → `"9"` → `"等于"`）。本方法**不需要** `policy` / `preserve_focus`——返回 `delivery: ax` 说明走的是无障碍语义路径，没有注入真实键鼠。
- 使用 `remote_gui_read_text` 工具，目的是读回计算结果；其中工具的参数 `ref` 来源于元素树中 `title="结果"` 的元素。本次读回 `948`，与 12×79 相符。

补充：`press` 驱动的是 UIA 的 Invoke / Toggle 模式，`outcome: worked` 即表示控件已响应；若控件不暴露这些模式，工具会回退到键鼠注入，那时 `delivery` 会变成 `hid`。



# 附录一：游戏类界面 —— 鼠标两种模式（判断「点击能否作用到 UI」的前提）

3D类游戏（第一人称、第三人称）的鼠标经常有两种工作模式，且一个游戏的鼠标模式会在不同页面快速改变，**动手点击 UI 前必须先判断当前是哪一种**：

1. **视角模式**：鼠标移动用来转动视角，点击 = 开枪 / 挥剑 / 攻击 / 交互。识别特征：**界面上没有鼠标指针**。
2. **HUD 模式**：鼠标是普通指针，可以正常点击界面按钮。识别特征：**界面上有鼠标指针**。

要点：

- 视角模式下，合成点击**不会穿透到 HUD**。此时点图标「无变化」是必然结果——**不是坐标错，也不是注入失败**。反复去校准坐标、换注入方式，全是白费力气。
- **打开菜单 / 呼出界面 = 从视角模式切进 HUD 模式**，只有切进去之后，点击 UI 才有意义。
- 若截图工具不渲染硬件鼠标指针、肉眼判不出模式，就用一次「有确定反馈的点击」当探针来判定，**不要连续盲点**。
- 止损线：同一个元素连续 1~2 次点击无反应，立刻改换 `action` 或改走别的操作路径，不要原样重试同一动作。



# 附录二：窗口创建后被改尺寸 → `framePoints` 不刷新，坐标被悄悄缩放

当窗口尺寸变化时，`framePoints` 不刷新，因此需要小心！

## 实测数据（坑的样子）

| 阶段 | 截图/rect | framePoints | 结论 |
|---|---|---|---|
| 标准型 | 448×649 | 448×649 | - |
| 切科学型后 | 838×649 | **仍 448×649** | framePoints 不刷新 |

误点表现：本想按 `÷` `4` `=` `sin`，实际点成 `fact(` `cos` `sinh(`——表达式变成 `sinh(cosd(fact(π…`，算出 `1.16310990518437001`。**这类「点错但每次都有反应」的症状，先查 framePoints 一致性。**

## 规避：重启一下目标程序

让窗口重新创建



# 附录三：`remote_gui_act` 的参数盲区 —— `requires keys` 不是「用不了」

`keypress` 报 `keypress requires keys`，**不是这个 action 不可用**，是参数没传对。按下面传就能用。


## 正确调用姿势

四个条件要**同时**满足：

| 要素 | 值 | 缺了会怎样 |
|---|---|---|
| `keys` | 键名数组，如 `["F1"]`、`["ctrl","c"]` | `keypress requires keys` |
| target | `ref`，或 `x`+`y`（截图坐标） | `target needs ref (preferred, from the look outline) or x/y image coordinates` |
| `policy` | `"foreground"` | 默认的 `ax_only` 会拦掉原始输入 |
| 前台 | 见下 | 键打给了别的窗口，`outcome` 照样是 `unknown` |
| `keep_pressdown_ms` | 游戏/引擎类窗口给 `50~150` | 普通软件无妨；**游戏里毫无反应**（见下一节）|

示例：

```
remote_gui_look   root_ref="@w3", include_image=true, max_output_tokens=1  → 取回 look_id
remote_gui_act    look_id=…, action="keypress", x=512, y=288, policy="foreground", keys=["F1"]
remote_gui_look   确认生效
```

**前台谁来管**，二选一：

- **不传** `preserve_focus`（默认）→ 工具会先把目标窗口切到前台再注入。**keypress 推荐这条，最省事。**
- **传** `preserve_focus=true` → 工具**不动**前台，键发给「当前本来就聚焦的那个窗口」。走这条就必须自己先 `remote_gui_focus_window`。

> `preserve_focus=true` 的语义是「保持现状、别切前台」，**不是**「保持目标窗口在前台」。原始输入的落点永远是**当前前台窗口**，跟 `look_id` 对应的窗口是哪个无关。

## 键名写法（大小写不敏感）

| 类别 | 可用名 |
|---|---|
| 编辑 | `enter` / `return`、`tab`、`backspace`、`delete`、`space`、`escape` / `esc` |
| 方向 | `left` / `right` / `up` / `down`（`arrowleft` 等别名亦可） |
| 翻页 | `home`、`end`、`pageup`、`pagedown` |
| 修饰 | `ctrl` / `control`、`shift`、`alt` / `option`、`win` / `cmd` / `meta` |
| 功能键 | `f1` ~ `f24` |
| 字符键 | 单个字母 / 数字，如 `a`、`7` |

组合键就是一个数组按顺序放，如 `["ctrl","c"]`：内部把前面的键按住、最后一个按下再抬起，最后逆序松开修饰键。

## 按住时长（`keep_pressdown_ms`）—— 游戏类窗口的第二道关

扫描码只解决「键能不能被**认出来**」。游戏这类**按帧轮询**的程序还有第二道关：**键得在某一帧采样时仍然按着**。

默认 `keep_pressdown_ms=0` 时，按下和抬起塞在同一次 `SendInput` 里，间隔不到 1 毫秒。60 帧的画面每 16.7ms 才采一次样 —— 这一毫秒大概率整个落在两次采样之间，游戏**每一帧看到的都是「松开」**，等于你没按过。

| 值 | 结果 |
|---|---|
| `0`（默认） | 普通软件正常；**游戏 / 引擎类窗口毫无反应** |
| `50 ~ 150` | 横跨 3~9 帧，游戏能采到。**游戏里就用这个区间** |

实测（绝区零，同一个扫描码、同一个游戏状态、同一个 `remote_gui_act` 调用）：

| `keep_pressdown_ms` | 结果 |
|---|---|
| `0` | 无反应 |
| `100` | 活动面板正常开 / 关 ✅ |
