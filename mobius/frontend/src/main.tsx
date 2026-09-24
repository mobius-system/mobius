import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './font-tiers.css'
import './index.css'
// KaTeX 公式样式 (remark-math + rehype-katex 渲染 $...$ / $$...$$ LaTeX 所需)。
// 字体走相对路径, Vite 本地化打包, 不连外部 CDN; 仅引入一次, 全局生效。
import 'katex/dist/katex.min.css'
import { installStaleChunkHandler } from './services/handle-stale-chunk'
import { installDebugPanel } from './services/install-debug-panel'
import { effectiveFontTierValues, applyFontTierValues } from './services/font-tiers'

// 字体档位覆写 (外观→字体设置 保存的值) 需在首帧前生效, 避免闪回默认字号
applyFontTierValues(effectiveFontTierValues())
installStaleChunkHandler()
// 隐藏的追底诊断浮窗: F12 里输入 `debug_panel` 唤出 (本体懒加载, 平时零开销)
installDebugPanel()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
