# 设计师之眼与 Import Map 兼容性修复设计

## 背景

拓展页由 `mobius/backend/routes/ext.ts` 在 `<head>` 开头注入设计师之眼。当前注入项本身是 `type="module"`，会在页面自带的 `importmap` 解析前触发模块加载。使用裸模块标识符（例如 `three`）的零编译拓展因此忽略后续 import map，整个业务模块图停止执行。

线上宣传页已稳定复现：控制台出现 `Failed to resolve module specifier "three"`，只保留 HTML 中原有的 2 个 canvas，5 个 Three.js 场景与滚动揭示逻辑未初始化。纯 CSS 动画不受影响。

## 目标

- 设计师之眼仍覆盖 Mobius 主前端和所有拓展页。
- 拓展页的设计师之眼加载不得早于页面 import map 的解析。
- 不修改任何拓展自身的 HTML、Three.js 或动画代码。
- 不改变桌面宿主栏、标签栏、快捷键、元素选择、提示词和自进化功能。
- 对没有 import map 的纯静态或构建型拓展保持兼容。

## 方案比较

### 方案 A：把模块脚本插到最后一个 import map 后面

优点是保持直接模块脚本。缺点是需要用字符串或 HTML 解析逻辑识别任意拓展的 import map 位置；不同 HTML 结构、大小写、属性顺序和多个 script 会扩大兼容面。

### 方案 B：在 DOM 就绪后使用内联动态导入

优点是不依赖页面结构。缺点是增加内联脚本内容，并且不利于单独缓存和静态资源存在性检查。

### 方案 C：注入延迟执行的经典外部加载器（采用）

在 `<head>` 开头注入 `<script defer src="/extension/_sdk/designer-eye/loader.js"></script>`。加载器是经典脚本，解析时不会触发模块图；`defer` 保证它在 HTML 和 import map 解析后执行，再通过相对路径 `import('./index.js')` 启动设计师之眼。资源统一走已经稳定对外的 `/extension/_sdk/` 路由，避免公网代理拒绝新的根路径前缀。

该方案不依赖拓展 HTML 的具体排列，加载器可单独缓存、单独返回 200，并能用小型回归测试约束“经典 + defer + 动态导入”的契约。

## 文件边界

- 新增 `mobius/frontend/public/designer-eye/loader.js`：只负责动态导入 `index.js` 并记录加载失败。
- 新增 `mobius/backend/services/designer-eye-loader.ts`：只生成稳定的经典延迟加载标签。
- 修改 `mobius/backend/routes/ext.ts`：复用生成函数并公开只读的 Designer Eye SDK 静态目录，不改宿主栏和标签栏实现。
- 修改 `mobius/frontend/index.html`：主前端也统一使用 Designer Eye SDK 静态路径。
- 新增 `mobius/tests/designer-eye-extension-loader.js`：验证生成标签不再是 module、必须带 defer，并验证加载器动态导入入口。
- 修改 `mobius/package.json`：增加单项回归测试命令。

## 错误处理

设计师之眼不是拓展业务页面的启动依赖。加载器必须捕获动态导入异常并记录 `[designer-eye] load failed`，不能产生未处理 Promise rejection，也不能阻止拓展业务模块执行。

## 验收

1. 回归测试先在旧实现上失败，最小修改后通过。
2. Mobius 后端 TypeScript 类型检查通过。
3. Mobius 前端构建通过，构建输出包含 `public/designer-eye/loader.js`。
4. 浏览器验证宣传页无 import map/`three` 错误，canvas 数量从 2 恢复为 7，滚动揭示为 7/7。
5. 浏览器验证 `window.__MOBIUS_DESIGNER_EYE__` 已安装。
6. 部署后 `/extension/_sdk/designer-eye/loader.js` 与 `/extension/_sdk/designer-eye/index.js` 均返回 HTTP 200 和 JavaScript MIME。
