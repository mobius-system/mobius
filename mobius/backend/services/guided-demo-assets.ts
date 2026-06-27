import * as fs from 'fs';
import * as path from 'path';
import { APP_DIR } from '../config';
import { Memories } from '../repositories/memories';
import { Skills } from '../repositories/skills';

const LOGO_DEMO_SKILL_DIR = 'mobius-extension';
const LOGO_DEMO_SKILL_SOURCE = path.join(APP_DIR, 'skills', LOGO_DEMO_SKILL_DIR);
const LOGO_DEMO_EXTENSION_SOURCE = path.join(APP_DIR, 'mobius', 'extension', 'dot-logo-3d');

const PROJECT_IMPORT_GIT_URL = 'https://github.com/tastejs/todomvc.git';
const PROJECT_IMPORT_SAMPLE_DIR = path.join('upload-samples', 'vanilla-todomvc');
const PROJECT_IMPORT_SAMPLE_ZIP = path.join('upload-samples', 'vanilla-todomvc-upload-sample.zip');
const CONTEXT_SETUP_MATERIALS_DIR = 'context-materials';
const CONTEXT_SETUP_MEMORY_MATERIAL = path.join(CONTEXT_SETUP_MATERIALS_DIR, 'project_knowledge.md');
const CONTEXT_SETUP_SKILL_DIR = LOGO_DEMO_SKILL_DIR;
const CONTEXT_SETUP_SKILL_SOURCE = LOGO_DEMO_SKILL_SOURCE;
const CONTEXT_SETUP_SKILL_MATERIAL_DIR = path.join(CONTEXT_SETUP_MATERIALS_DIR, CONTEXT_SETUP_SKILL_DIR);
const CONTEXT_SETUP_SKILL_MATERIAL_FILE = path.join(CONTEXT_SETUP_SKILL_MATERIAL_DIR, 'SKILL.md');
const CONTEXT_SETUP_MATERIALS_ZIP = path.join(CONTEXT_SETUP_MATERIALS_DIR, 'context-setup-materials.zip');

const LOGO_DEMO_PROJECT_KNOWLEDGE = [
  '# 莫比乌斯光点标志空间案例',
  '',
  '这是演示路线使用的项目知识。它描述一个真实的莫比乌斯拓展原型任务：用 Three.js 制作可调参数的莫比乌斯光点标志空间。',
  '',
  '## 项目背景',
  '',
  '- 项目目标：设计一个新 tab 打开的莫比乌斯特殊应用，画面主体是由大量光点构成的莫比乌斯环。',
  '- 目标用户：已经了解项目、任务单和执行会话基础流程，想继续学习莫比乌斯拓展结构的人。',
  '- 技术边界：保持莫比乌斯拓展目录结构，包含 `extension.json`、`frontend/`、`backend/extension_backend_handler.js`。',
  '- 前端边界：使用 Three.js 和 OrbitControls；优先零编译，通过 importmap 引入浏览器 ESM，不提交 `node_modules/` 或 `frontend/dist/`。',
  '- 后端边界：handler 必须是 CommonJS，不能在模块顶层持有连接或定时器，只能把用户预设写入 `ext_data_dir`。',
  '',
  '## 视觉与交互要求',
  '',
  '- 光点沿莫比乌斯环缓慢流动，明暗按呼吸节奏变化。',
  '- 控制项应覆盖环半径、带宽、扭数、纵向缩放、光点密度、调色盘、视角、流速、呼吸频率和呼吸幅度。',
  '- 交互面板要适合反复调参：标签清楚、控件紧凑、移动端不遮挡主体过多。',
  '- 颜色可以有科技感，但不要只依赖单一紫蓝渐变；调色盘应能看出差异。',
  '',
  '## 执行日志学习目标',
  '',
  '- 本案例还要帮助用户理解智能体执行日志。',
  '- 执行结束后，请在 `AGENT_OUTPUT_GUIDE.md` 中说明常见事件和字段：`user`、`assistant`/`response_item`、`tool_use`/`function_call`、`tool_result`/`function_call_output`、`event_msg`、`session_meta`、`turn_context`、`input`、`result`、`output`、`error`、`usage`、`status`。',
  '- 说明应面向第一次使用莫比乌斯的人，重点讲“怎么看”，不要写内部实现细节。',
  '',
  '## 技能使用建议',
  '',
  '- 使用拓展技能 `mobius-extension` 检查拓展目录、handler 协议、前端 SDK、构建策略和禁忌。',
  '- 如果需要保存用户调参预设，前端只通过 `/extension/_sdk/ext.js` 的 `extCall` 调后端 handler。',
].join('\n');

const LOGO_DEMO_EXTRA_FILES: Record<string, string> = {
  'README.md': [
    '# 莫比乌斯光点标志空间案例',
    '',
    '这是一个演示项目，用来学习莫比乌斯拓展结构、前端入口、后端 handler 约束和执行日志阅读。',
    '',
    '项目中已经准备了一份真实的莫比乌斯拓展原型，文件结构与 `mobius/extension/dot-logo-3d` 一致：',
    '',
    '- `extension.json`: 拓展 manifest，声明名称、展示名、描述和图标。',
    '- `frontend/index.html`: 拓展前端入口，使用 importmap 引入 Three.js。',
    '- `frontend/main.js`: 光点莫比乌斯环、着色器、OrbitControls 和调参逻辑。',
    '- `frontend/styles.css`: 全屏画布、顶部栏、统计面板和控制面板样式。',
    '- `backend/extension_backend_handler.js`: 保存、读取、删除用户调参预设的后端 handler。',
    '',
    '## 执行目标',
    '',
    '请让智能体基于项目知识和 `mobius-extension` 技能做一次设计迭代。它可以小幅改进代码，也可以在现有功能完整时补齐说明文档，但必须先检查真实文件再下结论。',
    '',
    '如果要查看已经上线的完成版拓展，请在莫比乌斯里打开特殊拓展应用 `dot-logo-3d`，入口 URL 是 `/extension/dot-logo-3d/`。',
    '',
    '执行完成后，重点查看：',
    '',
    '- 智能体检查了哪些文件。',
    '- 它是否保持了莫比乌斯拓展协议。',
    '- 它是否更新了 `AGENT_OUTPUT_GUIDE.md`，帮助用户理解执行日志常见字段。',
    '',
  ].join('\n'),
  'AGENT_OUTPUT_GUIDE.md': [
    '# 智能体执行日志速查',
    '',
    '这份文件会由执行会话补充。它面向第一次使用莫比乌斯的人，解释日志卡片里的常见类型和字段。',
    '',
    '请重点覆盖这些内容：',
    '',
    '- `user`: 用户输入或工具结果回传。',
    '- `assistant` / `response_item`: 模型回复、推理片段或工具调用请求。',
    '- `tool_use` / `function_call`: 智能体希望执行的工具，重点看 `name` 和 `input`。',
    '- `tool_result` / `function_call_output`: 工具返回，重点看 `result`、`output`、`stdout`、`stderr`、`error`。',
    '- `event_msg`: 执行状态、token 统计或任务完成事件。',
    '- `session_meta` / `turn_context`: 会话、模型、工作目录等上下文。',
    '- `usage`: 本轮消耗统计。',
    '- `status` / `error`: 是否成功、失败原因或需要用户介入的地方。',
  ].join('\n'),
};

const CONTEXT_SETUP_PROJECT_KNOWLEDGE = [
  '# 莫比乌斯自主开发项目知识',
  '',
  '这是一份用于莫比乌斯自主开发任务的项目知识。它告诉智能体当前系统是什么、代码在哪里、怎么验证，以及哪些边界不能碰。',
  '',
  '## 项目定位',
  '',
  '- 莫比乌斯是自进化 Agent 工作台，把项目资料、任务单和执行会话串起来。',
  '- 核心工作模型是 Project -> Issue -> Session：项目保存长期资料，任务单写清本次目标，执行会话负责真实执行。',
  '- 修改莫比乌斯自身时，应在自迭代项目中创建受控任务，明确文件范围、验收命令和禁止事项。',
  '',
  '## 代码位置',
  '',
  '- 主前端代码在 `mobius/frontend/src/`。',
  '- 后端接口在 `mobius/backend/`。',
  '- 引导中心入口主要在 `mobius/frontend/src/components/guide-help.tsx`。',
  '- Driver.js 引导路线主要在 `mobius/frontend/src/services/tour.ts`。',
  '- 演示状态文件在 `mobius/frontend/src/services/*-demo.ts`。',
  '- 演示素材准备在 `mobius/backend/services/guided-demo-assets.js`。',
  '- 莫比乌斯拓展优先放在 `mobius/extension/<name>/`。',
  '',
  '## 修改边界',
  '',
  '- 只有通用能力、核心流程或共享 UI 才修改主项目。',
  '- 单个拓展应用优先放在 `mobius/extension/<name>/`，不要为了一个拓展改主项目协议。',
  '- 不要改无关文件，不要顺手重构。',
  '- 不要提交 `node_modules/`、`dist/`、临时日志或构建产物。',
  '- 不要写入真实账号、密码、token 或私人凭据。',
  '',
  '## 常用验证',
  '',
  '- 前端构建：`cd mobius/frontend && npm run build`。',
  '- 后端语法检查：`node -c <modified-backend-file.js>`。',
  '- 引导路线修改后，优先用短文案、稳定 `data-tour` 选择器和真实页面检查验证。',
].join('\n');

const CONTEXT_SETUP_FILES: Record<string, string> = {
  'README.md': [
    '# 莫比乌斯开发资料配置案例',
    '',
    '这是一个用于学习项目知识和项目方法的演示项目。它只演示资料配置，不会修改莫比乌斯自身代码。',
    '',
    '## 文件',
    '',
    '- `context-materials/project_knowledge.md`: 项目知识素材，需要手动上传后同步为项目知识。',
    '- `context-materials/mobius-extension/SKILL.md`: 项目方法素材，需要手动上传后导入为项目方法。',
    '- `context-materials/context-setup-materials.zip`: 同一份素材的下载包。',
    '- `CONTEXT_CHECK.md`: 执行会话生成的验证结果文件。',
  ].join('\n'),
  [path.join(CONTEXT_SETUP_MATERIALS_DIR, 'README.md')]: [
    '# 莫比乌斯开发资料配置素材',
    '',
    '这个目录保存本案例要手动导入莫比乌斯的两份真实资料。',
    '',
    '## 项目知识',
    '',
    '`project_knowledge.md` 保存莫比乌斯自主开发项目知识，例如代码位置、验证命令和安全边界。',
    '',
    '## 项目方法',
    '',
    '`mobius-extension/SKILL.md` 保存开发莫比乌斯拓展的稳定做法，例如目录结构、前端 SDK 和后端 handler 协议。',
    '',
    '在引导路线里，先下载这两份文件，再通过页面上传到当前项目。上传成功后，新建执行会话时就能看到它们。',
  ].join('\n'),
  [CONTEXT_SETUP_MEMORY_MATERIAL]: CONTEXT_SETUP_PROJECT_KNOWLEDGE,
  'CONTEXT_CHECK.md': [
    '# 开发资料注入检查',
    '',
    '这份文件由执行会话生成，用来验证项目知识和项目方法是否进入本次 Session。',
  ].join('\n'),
};

const PROJECT_IMPORT_FILES: Record<string, string> = {
  'README.md': [
    '# TodoMVC 导入案例',
    '',
    '这个目录用于学习把已有代码导入莫比乌斯项目。',
    '',
    '## 两种演示入口',
    '',
    '1. Git 仓库下载：让执行会话下载公开仓库 `https://github.com/tastejs/todomvc.git`。',
    '2. 网页编辑器上传：下载 `upload-samples/vanilla-todomvc-upload-sample.zip`，在本机解压后，把文件夹拖入 VSCode Web。',
    '',
    '这两种方式只是常用入口示例，不代表所有导入方式。',
  ].join('\n'),
  'IMPORT_OPTIONS.md': [
    '# 导入方式说明',
    '',
    '## 使用 Git 下载公开仓库',
    '',
    '任务单和执行会话已经预填公开仓库地址：',
    '',
    '`https://github.com/tastejs/todomvc.git`',
    '',
    '执行会话会优先使用浅克隆。如果当前目录不是空目录，会改为克隆到子目录，避免覆盖已有文件。',
    '',
    '## 使用网页编辑器上传本地文件',
    '',
    '本项目已经准备了一份可下载的上传样例：',
    '',
    '`upload-samples/vanilla-todomvc-upload-sample.zip`',
    '',
    '下载到本机并解压后，可以在 VSCode Web 中打开项目目录，然后把解压后的文件夹拖入左侧资源管理器。',
  ].join('\n'),
  [path.join('upload-samples', 'README.md')]: [
    '# 上传样例素材',
    '',
    '`vanilla-todomvc/` 是一份最小可运行的 TodoMVC 风格静态项目。',
    '',
    '`vanilla-todomvc-upload-sample.zip` 是同一份文件打包后的下载样例，用来体验网页编辑器上传本地代码。',
  ].join('\n'),
  [path.join(PROJECT_IMPORT_SAMPLE_DIR, 'README.md')]: [
    '# Vanilla TodoMVC 上传样例',
    '',
    '这是一个最小可运行的 TodoMVC 风格静态项目，用于演示“本地文件上传到莫比乌斯项目目录”。',
    '',
    '直接打开 `index.html` 可以添加、完成、筛选和清空待办事项。数据保存在浏览器 localStorage 中。',
    '',
    '它不是外部仓库的复制品；Git 导入路线使用的真实公开仓库是 `https://github.com/tastejs/todomvc.git`。',
  ].join('\n'),
  [path.join(PROJECT_IMPORT_SAMPLE_DIR, 'index.html')]: [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>Vanilla TodoMVC 上传样例</title>',
    '  <link rel="stylesheet" href="./src/styles.css">',
    '</head>',
    '<body>',
    '  <main class="todo-app" aria-labelledby="app-title">',
    '    <h1 id="app-title">todos</h1>',
    '    <form id="todo-form" class="new-todo-form">',
    '      <input id="new-todo" autocomplete="off" placeholder="要完成什么？" aria-label="新增待办">',
    '      <button type="submit">添加</button>',
    '    </form>',
    '    <section class="toolbar" aria-label="待办筛选">',
    '      <button type="button" data-filter="all" class="active">全部</button>',
    '      <button type="button" data-filter="active">未完成</button>',
    '      <button type="button" data-filter="completed">已完成</button>',
    '    </section>',
    '    <ul id="todo-list" class="todo-list"></ul>',
    '    <footer class="footer">',
    '      <span id="todo-count">0 项待办</span>',
    '      <button type="button" id="clear-completed">清除已完成</button>',
    '    </footer>',
    '  </main>',
    '  <script type="module" src="./src/app.js"></script>',
    '</body>',
    '</html>',
  ].join('\n'),
  [path.join(PROJECT_IMPORT_SAMPLE_DIR, 'package.json')]: [
    '{',
    '  "name": "vanilla-todomvc-upload-sample",',
    '  "version": "0.1.0",',
    '  "private": true,',
    '  "scripts": {',
    '    "start": "python3 -m http.server 5173"',
    '  }',
    '}',
  ].join('\n'),
  [path.join(PROJECT_IMPORT_SAMPLE_DIR, 'src', 'app.js')]: [
    'const STORAGE_KEY = "imac-demo-vanilla-todos";',
    '',
    'const form = document.querySelector("#todo-form");',
    'const input = document.querySelector("#new-todo");',
    'const list = document.querySelector("#todo-list");',
    'const count = document.querySelector("#todo-count");',
    'const clearButton = document.querySelector("#clear-completed");',
    'const filterButtons = Array.from(document.querySelectorAll("[data-filter]"));',
    '',
    'let todos = readTodos();',
    'let filter = "all";',
    '',
    'function readTodos() {',
    '  try {',
    '    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");',
    '    return Array.isArray(parsed) ? parsed : [];',
    '  } catch {',
    '    return [];',
    '  }',
    '}',
    '',
    'function saveTodos() {',
    '  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));',
    '}',
    '',
    'function visibleTodos() {',
    '  if (filter === "active") return todos.filter(todo => !todo.completed);',
    '  if (filter === "completed") return todos.filter(todo => todo.completed);',
    '  return todos;',
    '}',
    '',
    'function render() {',
    '  list.innerHTML = "";',
    '  for (const todo of visibleTodos()) {',
    '    const item = document.createElement("li");',
    '    item.className = todo.completed ? "completed" : "";',
    '',
    '    const checkbox = document.createElement("input");',
    '    checkbox.type = "checkbox";',
    '    checkbox.checked = todo.completed;',
    '    checkbox.addEventListener("change", () => {',
    '      todo.completed = checkbox.checked;',
    '      saveTodos();',
    '      render();',
    '    });',
    '',
    '    const label = document.createElement("span");',
    '    label.textContent = todo.title;',
    '',
    '    const remove = document.createElement("button");',
    '    remove.type = "button";',
    '    remove.textContent = "删除";',
    '    remove.addEventListener("click", () => {',
    '      todos = todos.filter(item => item.id !== todo.id);',
    '      saveTodos();',
    '      render();',
    '    });',
    '',
    '    item.append(checkbox, label, remove);',
    '    list.append(item);',
    '  }',
    '',
    '  const activeCount = todos.filter(todo => !todo.completed).length;',
    '  count.textContent = `${activeCount} 项待办`;',
    '  filterButtons.forEach(button => {',
    '    button.classList.toggle("active", button.dataset.filter === filter);',
    '  });',
    '}',
    '',
    'form.addEventListener("submit", event => {',
    '  event.preventDefault();',
    '  const title = input.value.trim();',
    '  if (!title) return;',
    '  todos = [{ id: crypto.randomUUID(), title, completed: false }, ...todos];',
    '  input.value = "";',
    '  saveTodos();',
    '  render();',
    '});',
    '',
    'filterButtons.forEach(button => {',
    '  button.addEventListener("click", () => {',
    '    filter = button.dataset.filter || "all";',
    '    render();',
    '  });',
    '});',
    '',
    'clearButton.addEventListener("click", () => {',
    '  todos = todos.filter(todo => !todo.completed);',
    '  saveTodos();',
    '  render();',
    '});',
    '',
    'render();',
  ].join('\n'),
  [path.join(PROJECT_IMPORT_SAMPLE_DIR, 'src', 'styles.css')]: [
    ':root {',
    '  color-scheme: light;',
    '  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    '  background: #f5f5f5;',
    '  color: #202124;',
    '}',
    '',
    'body {',
    '  margin: 0;',
    '  min-height: 100vh;',
    '  display: grid;',
    '  place-items: start center;',
    '  padding: 48px 16px;',
    '}',
    '',
    '.todo-app {',
    '  width: min(100%, 560px);',
    '  background: #fff;',
    '  border: 1px solid #e5e7eb;',
    '  box-shadow: 0 18px 45px rgba(15, 23, 42, 0.12);',
    '}',
    '',
    'h1 {',
    '  margin: 0;',
    '  padding: 24px 24px 16px;',
    '  color: #b91c1c;',
    '  font-size: 56px;',
    '  font-weight: 200;',
    '  text-align: center;',
    '}',
    '',
    '.new-todo-form {',
    '  display: flex;',
    '  gap: 8px;',
    '  padding: 0 16px 16px;',
    '}',
    '',
    'input[type="text"], #new-todo {',
    '  min-width: 0;',
    '  flex: 1;',
    '  height: 44px;',
    '  border: 1px solid #d1d5db;',
    '  padding: 0 12px;',
    '  font-size: 16px;',
    '}',
    '',
    'button {',
    '  border: 1px solid #d1d5db;',
    '  background: #f9fafb;',
    '  color: #111827;',
    '  padding: 0 12px;',
    '  cursor: pointer;',
    '}',
    '',
    'button:hover, button.active {',
    '  border-color: #2563eb;',
    '  color: #1d4ed8;',
    '}',
    '',
    '.toolbar, .footer {',
    '  display: flex;',
    '  justify-content: space-between;',
    '  gap: 8px;',
    '  padding: 10px 16px;',
    '  border-top: 1px solid #e5e7eb;',
    '}',
    '',
    '.todo-list {',
    '  list-style: none;',
    '  margin: 0;',
    '  padding: 0;',
    '}',
    '',
    '.todo-list li {',
    '  min-height: 48px;',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 12px;',
    '  padding: 8px 16px;',
    '  border-top: 1px solid #e5e7eb;',
    '}',
    '',
    '.todo-list li.completed span {',
    '  color: #9ca3af;',
    '  text-decoration: line-through;',
    '}',
    '',
    '.todo-list li span {',
    '  flex: 1;',
    '}',
  ].join('\n'),
};

function writeFileIfChanged(filePath: string, content: string): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    try {
      if (fs.readFileSync(filePath, 'utf8') === content) return false;
    } catch {}
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function writeBufferIfChanged(filePath: string, content: Buffer): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    try {
      if (Buffer.compare(fs.readFileSync(filePath), content) === 0) return false;
    } catch {}
  }
  fs.writeFileSync(filePath, content);
  return true;
}

function copyFileIfChanged(src: string, dst: string): boolean {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const content = fs.readFileSync(src);
  if (fs.existsSync(dst)) {
    try {
      if (Buffer.compare(fs.readFileSync(dst), content) === 0) return false;
    } catch {}
  }
  fs.writeFileSync(dst, content);
  return true;
}

function copyExtensionStarter(srcDir: string, dstDir: string, changedFiles: string[]): void {
  const ignoredDirs = new Set(['dist', 'node_modules', '.git']);
  const visit = (src: string, rel: string = '') => {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
      const nextRel = rel ? path.join(rel, entry.name) : entry.name;
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dstDir, nextRel);
      if (entry.isDirectory()) {
        visit(srcPath, nextRel);
      } else if (entry.isFile()) {
        if (copyFileIfChanged(srcPath, dstPath)) changedFiles.push(dstPath);
      }
    }
  };
  visit(srcDir);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer | Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: any[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const normalizedEntries = entries
    .map((entry: any) => ({
      name: String(entry.name || '').replace(/\\/g, '/').replace(/^\/+/, ''),
      data: Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ''), 'utf8'),
    }))
    .filter((entry: any) => entry.name && !entry.name.endsWith('/'))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));

  let offset = 0;
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  for (const entry of normalizedEntries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const checksum = crc32(data);
    const localOffset = offset;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(10, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, data);
    offset += localHeader.length + nameBuffer.length + data.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(10, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBuffer);
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  offset += centralSize;

  const endHeader = Buffer.alloc(22);
  endHeader.writeUInt32LE(0x06054b50, 0);
  endHeader.writeUInt16LE(0, 4);
  endHeader.writeUInt16LE(0, 6);
  endHeader.writeUInt16LE(normalizedEntries.length, 8);
  endHeader.writeUInt16LE(normalizedEntries.length, 10);
  endHeader.writeUInt32LE(centralSize, 12);
  endHeader.writeUInt32LE(centralOffset, 16);
  endHeader.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, endHeader], offset + endHeader.length);
}

function hasProjectSkill(projectId: any, skillName: string): boolean {
  return Skills.listForProject(projectId).some((skill: any) => {
    const id = typeof skill.id === 'string' ? skill.id : '';
    return skill.name === skillName || id.endsWith(`:${skillName}`);
  });
}

function importProjectSkillIfMissing({ user, project, skillName, sourcePath }: any): any {
  if (hasProjectSkill(project.id, skillName)) return null;
  const result = Skills.importLocal({ userId: user.id, projectId: project.id, sourcePath });
  if (!result.ok) return result;
  return result.skills?.[0] || null;
}

function syncProjectKnowledge(project: any, user: any): any {
  const result = Memories.syncProjectKnowledge(project.id, { fallbackUserId: user.id });
  if (!result.ok) return result;
  return { ok: true, memory: result.memory || null };
}

function ensureLogoDemoAssets({ project, user }: any): any {
  if (!project?.id) return { ok: false, error: '项目不存在' };
  if (!user?.id) return { ok: false, error: '用户不存在' };
  const bindPath = (project.bind_path || '').trim();
  if (!bindPath) return { ok: false, error: '项目未绑定路径' };
  if (!fs.existsSync(LOGO_DEMO_EXTENSION_SOURCE)) return { ok: false, error: `示例拓展不存在: ${LOGO_DEMO_EXTENSION_SOURCE}` };
  if (!fs.existsSync(LOGO_DEMO_SKILL_SOURCE)) return { ok: false, error: `示例技能不存在: ${LOGO_DEMO_SKILL_SOURCE}` };

  const changedFiles: any[] = [];
  copyExtensionStarter(LOGO_DEMO_EXTENSION_SOURCE, bindPath, changedFiles);
  if (writeFileIfChanged(path.join(bindPath, '.imac', 'project_knowledge.md'), LOGO_DEMO_PROJECT_KNOWLEDGE)) {
    changedFiles.push(path.join(bindPath, '.imac', 'project_knowledge.md'));
  }
  for (const [rel, content] of Object.entries(LOGO_DEMO_EXTRA_FILES)) {
    const target = path.join(bindPath, rel);
    if (writeFileIfChanged(target, content)) changedFiles.push(target);
  }

  const memoryResult = syncProjectKnowledge(project, user);
  if (!memoryResult.ok) return { ok: false, error: memoryResult.error || '项目记忆同步失败' };
  const skillResult = importProjectSkillIfMissing({
    user,
    project,
    skillName: LOGO_DEMO_SKILL_DIR,
    sourcePath: LOGO_DEMO_SKILL_SOURCE,
  });
  if (skillResult && skillResult.ok === false) return { ok: false, error: skillResult.error || '示例技能导入失败' };

  return {
    ok: true,
    changed_files: changedFiles,
    memory: memoryResult.memory || null,
    skill: skillResult || null,
    skill_dir: LOGO_DEMO_SKILL_DIR,
  };
}

function ensureContextSetupDemoAssets({ project, user }: any): any {
  if (!project?.id) return { ok: false, error: '项目不存在' };
  if (!user?.id) return { ok: false, error: '用户不存在' };
  const bindPath = (project.bind_path || '').trim();
  if (!bindPath) return { ok: false, error: '项目未绑定路径' };
  if (!fs.existsSync(CONTEXT_SETUP_SKILL_SOURCE)) return { ok: false, error: `示例技能不存在: ${CONTEXT_SETUP_SKILL_SOURCE}` };

  const changedFiles = [];
  for (const [rel, content] of Object.entries(CONTEXT_SETUP_FILES)) {
    const target = path.join(bindPath, rel);
    if (writeFileIfChanged(target, content)) changedFiles.push(target);
  }
  const skillMaterialPath = path.join(bindPath, CONTEXT_SETUP_SKILL_MATERIAL_FILE);
  if (copyFileIfChanged(path.join(CONTEXT_SETUP_SKILL_SOURCE, 'SKILL.md'), skillMaterialPath)) changedFiles.push(skillMaterialPath);

  const zipPath = path.join(bindPath, CONTEXT_SETUP_MATERIALS_ZIP);
  const zipBuffer = buildZip([
    {
      name: 'project_knowledge.md',
      data: CONTEXT_SETUP_PROJECT_KNOWLEDGE,
    },
    {
      name: path.join(CONTEXT_SETUP_SKILL_DIR, 'SKILL.md'),
      data: fs.readFileSync(path.join(CONTEXT_SETUP_SKILL_SOURCE, 'SKILL.md')),
    },
    {
      name: 'README.md',
      data: CONTEXT_SETUP_FILES[path.join(CONTEXT_SETUP_MATERIALS_DIR, 'README.md')],
    },
  ]);
  if (writeBufferIfChanged(zipPath, zipBuffer)) changedFiles.push(zipPath);

  return {
    ok: true,
    changed_files: changedFiles,
    memory_material: CONTEXT_SETUP_MEMORY_MATERIAL,
    skill_material_dir: CONTEXT_SETUP_SKILL_MATERIAL_DIR,
    skill_material_file: CONTEXT_SETUP_SKILL_MATERIAL_FILE,
    materials_zip: CONTEXT_SETUP_MATERIALS_ZIP,
    skill_dir: CONTEXT_SETUP_SKILL_DIR,
  };
}

function ensureProjectImportDemoAssets({ project, user }: any): any {
  if (!project?.id) return { ok: false, error: '项目不存在' };
  if (!user?.id) return { ok: false, error: '用户不存在' };
  const bindPath = (project.bind_path || '').trim();
  if (!bindPath) return { ok: false, error: '项目未绑定路径' };

  const changedFiles = [];
  for (const [rel, content] of Object.entries(PROJECT_IMPORT_FILES)) {
    const target = path.join(bindPath, rel);
    if (writeFileIfChanged(target, content)) changedFiles.push(target);
  }

  const zipEntries = Object.entries(PROJECT_IMPORT_FILES)
    .filter(([rel]) => rel.startsWith(PROJECT_IMPORT_SAMPLE_DIR + path.sep))
    .map(([rel, content]) => ({
      name: path.relative(path.join('upload-samples'), rel),
      data: content,
    }));
  const zipPath = path.join(bindPath, PROJECT_IMPORT_SAMPLE_ZIP);
  if (writeBufferIfChanged(zipPath, buildZip(zipEntries))) changedFiles.push(zipPath);

  return {
    ok: true,
    changed_files: changedFiles,
    git_url: PROJECT_IMPORT_GIT_URL,
    upload_sample_dir: PROJECT_IMPORT_SAMPLE_DIR,
    upload_sample_zip: PROJECT_IMPORT_SAMPLE_ZIP,
  };
}

function ensureGuidedDemoAssets({ kind, project, user }: any): any {
  if (!kind) return { ok: true, changed_files: [] };
  if (kind === 'project-import') return ensureProjectImportDemoAssets({ project, user });
  if (kind === 'birthday' || kind === 'first-task') return ensureLogoDemoAssets({ project, user });
  if (kind === 'extension' || kind === 'logo-space') return ensureLogoDemoAssets({ project, user });
  if (kind === 'context-setup') return ensureContextSetupDemoAssets({ project, user });
  return { ok: false, error: '不支持的引导演示类型' };
}

export {
  ensureGuidedDemoAssets,
  ensureLogoDemoAssets,
  ensureContextSetupDemoAssets,
  ensureProjectImportDemoAssets,
};
