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
      '| `3dbc83ce.log` | [best-api/log/debug/3dbc83ce.log](/home/fuqingxu/cc-workspace/kind_star/best-api/log/debug/3dbc83ce.log) | 153 KB |',
    ].join('\n'),
  },
];
