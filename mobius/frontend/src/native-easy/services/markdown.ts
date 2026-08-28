import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import { remarkFileTargets } from '../components/code-artifacts/remark-file-targets'

// 全局复用的 react-markdown 插件配置:
//  - remarkGfm   : GitHub Flavored Markdown (表格/删除线/任务列表/自动链接)
//  - remarkMath  : 解析 $...$ 行内与 $$...$$ 块级 LaTeX 公式 (产生 inlineMath/math 节点)
//  - rehypeKatex : 把 math 节点渲染成 KaTeX HTML (依赖全局 katex.min.css, 见 main.tsx)
//  - rehypeHighlight : 代码块语法高亮 (注入 hljs-* class, 颜色由 index.css 的 prose-chat 提供)
// KaTeX 字体随 katex.min.css 以相对路径引用, Vite 构建时本地化打包, 不连接任何外部 CDN。
export const MARKDOWN_REMARK_PLUGINS: any[] = [remarkGfm, remarkMath, remarkFileTargets]
export const MARKDOWN_REHYPE_PLUGINS: any[] = [rehypeKatex, rehypeHighlight as any]
