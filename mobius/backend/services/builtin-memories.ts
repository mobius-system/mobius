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
    description: '用 display_files 让会话文件浏览器展示项目文件或 aimux 远程文件。',
    body: [
      '`display_files` 是一个与人类交互的命令。',
      '对于你希望用户看到的源码、HTML、Markdown、README 文件，尤其是核心产物性质、总结性质的文件，都使用这个命令把这个文件呈现给用户',
      '所谓**呈现**，意思是在前端显示文件卡片，点击卡片会在当前会话的简易文件侧栏打开文件；而且支持的远程文本文件可以直接编辑并保存。',
      '对于中枢文件，虽然你也可以直接在回复中直接告诉用户产物的路径，但这需要用户自己手动复制路径，容易给入门用户造成困扰。建议使用 ``',
      '项目中枢文件可传项目绑定目录内的绝对路径，也可传相对路径；绝对路径必须位于绑定目录内。支持预览文本、源码、HTML 和 README。',
      '远程文件使用 `display_files --remote <remote-name> [--root <remote-root>] <relative-path>...`。路径相对于 `--root`；未提供 root 时使用项目为该 remote 配置的路径。远程文件路径不能以 `/` 开头，也不能包含 `..`。',
      '示例：`display_files --remote gptac-zs-dev --root /workspace/app src/main.py README.md`',
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
    name: '把文件发布成公开链接',
    description: 'make_file_public_access: 上传本地文件到 Mobius 静态分享，得到免登录公开链接。',
    body: [
      '需要把 HTML / 图片 / 压缩包等文件变成"任何人都能打开"的链接时使用：',
      '`make_file_public_access --path=<本地文件> [--file-name=<链接里的名字>] [--at-dir=<目录>] [--expire=<天数>]`',
      '- `--path` 必填，本地文件路径；`--file-name` 默认取文件名；`--at-dir` 默认放在分享根目录；`--expire` 默认 7 天，最长 3650 天。',
      '- 限制：公开文件不超过 10MB；文件名和每一级目录只允许中文、英文、数字、下划线和单点（不支持连字符/空格），文件名不超过 50 字符，目录路径总计不超过 50 字符。',
      '- 成功时打印 `Public URL:`，把该链接直接给用户即可；同名文件已存在会报错，换个文件名或目录重试。',
      '- 需要程序化处理时加 `--json`，返回完整响应。',
    ].join('\n'),
  },
  {
    scope: 'builtin',
    name: '给当前项目添加记忆',
    description: 'add_project_memory: 把一条长期事实写进当前会话所属项目的 Memory。',
    body: [
      '需要让以后的新会话都记住某条项目事实/约定/踩过的坑时使用：',
      '`add_project_memory --memory-name=<标题> --memory-content=<正文>`',
      '- 项目自动取当前会话所属项目，不需要传项目 ID。',
      '- `--memory-name` 必填、单行、不超过 50 字符；`--memory-content` 必填、不超过 10000 字符（多行请用引号包起来）。',
      '- 与 `.imac/project_knowledge.md` 的区别：Memory 是平台对象，可在新建会话时被勾选注入系统提示词；知识文件是给人/agent 主动阅读的文档。',
    ].join('\n'),
  },
  // {
  //   scope: 'builtin',
  //   name: '向用户呈现中枢文件',
  //   description: '为用户呈现文件路径时使用标准 markdown 格式 [文件相对路径](文件绝对路径), 便于点击跳转。（注意，这种方式呈现的文件必须存在中枢上。如果文件在其他计算机上，不要使用[...](...)语法，建议额外使用display_files）。',
  //   body: [
  //     '当你为用户呈现文件时，需要使用标准的markdown格式，形式是 [文件相对路径](文件绝对路径)，举例：',
  //     '',
  //     '| 文件 | 路径 | 大小 |',
  //     '|---|---|---|',
  //     '| `3dbc83ce.log` | [best-api/log/debug/3dbc83ce.log](/home/mobius/cc-workspace/kind_star/best-api/log/debug/3dbc83ce.log) | 153 KB |',
  //   ].join('\n'),
  // },
];
