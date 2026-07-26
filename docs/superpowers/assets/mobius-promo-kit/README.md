# Mobius 宣传片素材库

这套素材服务于《Mobius 宣传视频逐镜头优化稿》，采用“系统线框＋品牌能量轨迹”方向。现有 Mobius 环形动画继续使用：

<https://mobius.nutshellai.cn/mobius-ring-standalone.html>

本目录补齐静态 Logo、七项能力、人类与智能体节点、设备外框、模型与算力资源，以及路径动画配件。所有素材均可用于深色和浅色画面。

## 快速入口

- `00-preview/overview-dark-4k.png`：深色背景总览。
- `00-preview/overview-light-4k.png`：浅色背景总览。
- `01-logo/`：Logo SVG 与 4096px 透明 PNG。
- `02-capabilities/`：七项能力默认态与激活态。
- `03-people-agents/`：人物、智能体节点和状态配件。
- `04-device-frames/`：Web、PC、手机空白屏／示例屏设备框。
- `05-compute-resources/`：模型、服务器、GPU、工作站和设备。
- `06-motion-guides/`：关系配件与动画指南。
- `manifest.json`：129 项素材的分类、主题、状态、尺寸和路径索引。

每个分类中的 `svg/` 是可编辑源文件，`png/` 是透明背景成品。

## 命名规则

文件名按以下顺序组合：

```text
<类别>-<名称>-<状态>-<主题>.<格式>
```

例子：

```text
capability-self-evolution-active-dark.svg
resource-gpu-active-light.png
agent-terminal-hex-dark.svg
device-mobile-sample-light.png
```

- 没有写 `active` 的能力／资源文件即默认态。
- `dark` 与 `light` 表示线条针对的背景主题，文件本身仍保持透明。
- Logo 为通用版本，不带主题后缀。

## 品牌色

| 名称 | 色值 | 用途 |
|---|---|---|
| Cyan | `#22D3EE` | 光轨起点、连接建立 |
| Sky | `#7DD3FC` | 轻量高亮、界面连接 |
| Violet | `#8B5CF6` | 品牌主色、系统核心 |
| Lavender | `#A78BFA` | 渐变过渡 |
| Magenta | `#EC4899` | 激活终点、能力生长 |
| Pink | `#F472B6` | 柔和发光、强调 |
| Dark canvas | `#030014` | 宣传片深色空间 |
| Light canvas | `#F7F9FF` | 浅色演示／PPT |

## 在制作软件中使用

### After Effects

1. 优先导入 SVG；如果当前 AE 版本不能直接保留 SVG 路径，先在 Illustrator 或 Figma 中打开并另存为 AI。
2. 导入为合成，保留图层尺寸。
3. 需要描边动画时，将矢量图层转换为形状图层。
4. 根据 `06-motion-guides/animation-guide.md` 中的分组 ID，对结构、能量轨迹和状态指示器分别制作动画。

### Premiere Pro／剪映

- 直接使用相应主题的透明 PNG。
- 图标统一导出为 1024×1024，缩放时建议保持在原尺寸的 20%～100%。
- 设备框长边为 2160px，可直接放入 4K 时间线；真实录屏放在设备框下方并用遮罩限制在屏幕区域。
- 不建议把深色版 PNG 放在浅色画面上再加阴影；直接使用 `light` 版本。

### Figma

- 拖入 SVG 后可继续编辑路径、描边和渐变。
- 保留原始分组名称，不要将所有路径扁平化，方便回到 AE 制作分层动画。
- 组合图标时保持至少 12% 的安全留白。

## Logo 使用

- `logo-geometric-color`：路径动画、无限缩放和常规品牌展示。
- `logo-textured-color`：Logo 正式揭示、片尾定帧和封面。
- `logo-monochrome-white`：深色但颜色复杂的画面。
- `logo-monochrome-ink`：浅色文档和打印。
- `logo-brand-gradient`：需要更克制、无额外粒子的品牌渐变版本。

不要拉伸 Logo、改变交叉关系、增加外框，或把 Logo 放在与品牌渐变过于接近的高饱和背景上。

## 七项能力的镜头对应

| 文件名称 | 分镜能力 |
|---|---|
| `self-evolution` | 持续自进化 |
| `xiaomo` | 智能小莫 |
| `team-development` | 复杂项目团队协作开发 |
| `multi-agent` | 多智能体编队 |
| `multi-device` | Web／PC／移动端协同 |
| `resource-routing` | 连接一切并调度模型、设备与算力 |
| `extension-incubation` | 按需孵化拓展 |

默认态用于能力环未激活节点；激活态用于旁白讲到该能力时的点亮状态。不要同时把七个节点全部设为激活态。

## 重新生成与校验

环境需要 Python 3、CairoSVG 和 Pillow：

```bash
python3 docs/superpowers/assets/mobius-promo-kit/scripts/generate_assets.py
python3 -m unittest docs/superpowers/assets/mobius-promo-kit/scripts/test_asset_system.py -v
```

生成器会按 `asset_system.py` 中的统一色板和几何规则重建 SVG、PNG、清单和预览图。手工调整可编辑 SVG 后，不要再次运行生成器覆盖它；应先把修改同步回生成器。
