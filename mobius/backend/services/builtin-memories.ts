/**
 * builtin-memories.ts — 平台自带、与具体用户/项目无关的长期事实.
 *
 * 这些 memory 始终注入 (排在 DB memory 之前), 由 session-context 统一渲染.
 * 拆出独立文件便于集中维护内置事实, 不污染上下文拼装主逻辑.
 */
export interface BuiltinMemory {
  scope: 'builtin';
  name: string;
  description: string;
  body: string;
}

export const BUILTIN_MEMORIES: BuiltinMemory[] = [
  {
    scope: 'builtin',
    name: '会话内展示和编辑文件',
    description: '用 display-files 让会话文件浏览器展示项目文件或 aimux 远程文件。',
    body: [
      '`display-files` 是供 Mobius 前端扫描的标记命令，不会读写文件。凡是生成、修改或交付支持的文本、源码、HTML、Markdown、README 文件，都必须在最终回复前调用它，文件才会显示为可点击卡片。',
      '项目中枢文件可传项目绑定目录内的绝对路径，也可传相对路径；绝对路径必须位于绑定目录内。支持预览文本、源码、HTML 和 README。',
      '远程文件使用 `display-files --remote <remote-name> [--root <remote-root>] <relative-path>...`。路径相对于 `--root`；未提供 root 时使用项目为该 remote 配置的路径。远程文件路径不能以 `/` 开头，也不能包含 `..`。',
      '示例：`display-files --remote gptac-zs-dev --root /workspace/app src/main.py README.md`',
      '点击卡片会在当前会话的简易文件侧栏打开文件；支持的远程文本文件可以直接编辑并保存。',
    ].join('\n'),
  },
  {
    scope: 'builtin',
    name: '向用户展示图像',
    description: 'display_images (bash命令): 将一个或多个图片展示给用户。',
    body: [
      '图片路径【必须是绝对路径】(以 / 开头), 或是 http:// / https:// 开头的 URL。传入相对路径会被拒绝。',
      '参数:',
      '  <图片N>       图片的绝对路径(以 / 开头)或 http(s) URL',
      '示例:',
      '  display_images /home/alice/pics/cat.png',
      '  display_images /home/alice/pics/a.png /home/alice/pics/b.jpg',
      '  display_images https://example.com/photo.jpg',
    ].join('\n'),
  },
  {
    scope: 'builtin',
    name: '向用户呈现文件',
    description: '为用户呈现文件路径时使用标准 markdown 格式 [文件相对路径](文件绝对路径), 便于点击跳转。',
    body: [
      '当你为用户呈现文件时，需要使用标准的markdown格式，形式是 [文件相对路径](文件绝对路径)，举例：',
      '',
      '| 文件 | 路径 | 大小 |',
      '|---|---|---|',
      '| `3dbc83ce.log` | [best-api/log/debug/3dbc83ce.log](/home/mobius/cc-workspace/kind_star/best-api/log/debug/3dbc83ce.log) | 153 KB |',
    ].join('\n'),
  },
];
