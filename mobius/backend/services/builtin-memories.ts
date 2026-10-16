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
      '`display-files` 是一个与人类交互的命令。',
      '对于你希望用户看到的源码、HTML、Markdown、README 文件，尤其是核心产物性质、总结性质的文件，都使用这个命令把这个文件呈现给用户',
      '所谓**呈现**，意思是在前端显示文件卡片，点击卡片会在当前会话的简易文件侧栏打开文件；而且支持的远程文本文件可以直接编辑并保存。',
      '对于中枢文件，虽然你也可以直接在回复中直接告诉用户产物的路径，但这需要用户自己手动复制路径，容易给入门用户造成困扰。建议使用 ``',
      '项目中枢文件可传项目绑定目录内的绝对路径，也可传相对路径；绝对路径必须位于绑定目录内。支持预览文本、源码、HTML 和 README。',
      '远程文件使用 `display-files --remote <remote-name> [--root <remote-root>] <relative-path>...`。路径相对于 `--root`；未提供 root 时使用项目为该 remote 配置的路径。远程文件路径不能以 `/` 开头，也不能包含 `..`。',
      '示例：`display-files --remote gptac-zs-dev --root /workspace/app src/main.py README.md`',
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
  // {
  //   scope: 'builtin',
  //   name: '向用户呈现中枢文件',
  //   description: '为用户呈现文件路径时使用标准 markdown 格式 [文件相对路径](文件绝对路径), 便于点击跳转。（注意，这种方式呈现的文件必须存在中枢上。如果文件在其他计算机上，不要使用[...](...)语法，建议额外使用display-files）。',
  //   body: [
  //     '当你为用户呈现文件时，需要使用标准的markdown格式，形式是 [文件相对路径](文件绝对路径)，举例：',
  //     '',
  //     '| 文件 | 路径 | 大小 |',
  //     '|---|---|---|',
  //     '| `3dbc83ce.log` | [best-api/log/debug/3dbc83ce.log](/home/mobius/cc-workspace/kind_star/best-api/log/debug/3dbc83ce.log) | 153 KB |',
  //   ].join('\n'),
  // },
];
