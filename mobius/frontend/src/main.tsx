import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
// KaTeX 公式样式 (remark-math + rehype-katex 渲染 $...$ / $$...$$ LaTeX 所需)。
// 字体走相对路径, Vite 本地化打包, 不连外部 CDN; 仅引入一次, 全局生效。
import 'katex/dist/katex.min.css'
import { installStaleChunkHandler } from './services/handle-stale-chunk'

installStaleChunkHandler()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
