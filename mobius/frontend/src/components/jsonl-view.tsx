/**
 * jsonl-view.tsx — 展示当前 agent backend JSONL 里的原始 entries.
 *
 * 该文件原本 ~3000 行, 已按职责拆分到 ./viewer/ 下:
 *   - viewer/types.ts            共享类型
 *   - viewer/themes.ts           卡片配色主题
 *   - viewer/utils.ts            叶子级纯函数
 *   - viewer/entry-extract.ts    entry → 结构化数据抽取 (Edit/Write/Bash/Read/tool_result/display_images/本地命令)
 *   - viewer/entry-classify.ts   entry 布尔谓词 + tour target
 *   - viewer/header-summary.ts   卡片标题栏摘要
 *   - viewer/oversized.ts        超大卡片渲染截断保护
 *   - viewer/rounds.ts           对话轮次分组逻辑
 *   - viewer/KeyNode.tsx         JSON 树递归节点
 *   - viewer/text-preview.tsx    行号文本预览 / markdown 占位
 *   - viewer/CodeDiff.tsx        Edit 代码差异
 *   - viewer/WritePreview.tsx    Write 文件预览
 *   - viewer/BashCards.tsx       Bash 命令卡片 + 返回结果
 *   - viewer/ReadCards.tsx       Read 文件读取卡片 + 结果
 *   - viewer/LocalCommandBlock.tsx  本地命令产物块
 *   - viewer/DisplayImages.tsx   display_images 图像卡片 + 放大弹窗
 *   - viewer/LiveTailCard.tsx    实时尾部卡 (LIVE)
 *   - viewer/EntryCard.tsx       单条 entry 卡片 (核心)
 *   - viewer/RoundGroups.tsx     轮次/续接分组容器
 *   - viewer/JsonlView.tsx       顶层视图
 *
 * 这里只做聚合再导出, 保持对外 API 不变 (其它文件仍从 './jsonl-view' import 同名符号).
 */
export { JsonlView } from './viewer/JsonlView'
export { JsonEntryCard } from './viewer/EntryCard'
export { JsonlLiveTailCard } from './viewer/LiveTailCard'
export { DisplayImagesCard } from './viewer/DisplayImages'
export { jsonlEntrySummaryKey } from './viewer/header-summary'
