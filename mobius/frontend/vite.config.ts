import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// MOBIUS mobius 前端 (:45616): 默认连后端 ($MOBIUS_PORT).
// 老 9830/9810 正式服已退役, mobius 现在既是开发也是生产.
// 可用 VITE_API_TARGET / VITE_PORT 覆盖.
const mobiusPort = process.env.MOBIUS_PORT
const apiTarget = process.env.VITE_API_TARGET || `http://localhost:${mobiusPort}`
// 域名反代 (cloud-N.example.com 等) 会被 vite host 校验拦截.
// 前导点 = 该域名及全部子域. 逗号分隔可配多个; 设为 'all' 关闭校验(不建议).
const allowedHosts = (process.env.VITE_ALLOWED_HOSTS || '.example.com')
  .split(',').map(s => s.trim()).filter(Boolean)
// 经 https 域名反代时 HMR ws 客户端要连 wss:443 而非 ws:45616.
// VITE_HMR_* 由 .env.default 提供; 裸 `npm run dev` 本地直连不设 -> vite 默认行为.
// 故意不设 hmr.host: 留空时客户端用页面自身 hostname 回连, 各 cloud-N 子域各自连对.
const hmr: Record<string, unknown> = {}
if (process.env.VITE_HMR_PROTOCOL) hmr.protocol = process.env.VITE_HMR_PROTOCOL
if (process.env.VITE_HMR_CLIENT_PORT) hmr.clientPort = Number(process.env.VITE_HMR_CLIENT_PORT)
const buildOutDir = process.env.MOBIUS_FRONTEND_OUT_DIR || '../public'

function manualChunks(id: string) {
  const normalizedId = id.replace(/\\/g, '/')
  // React 运行时必须独占一个 vendor chunk: 否则下面把 @uiw/@codemirror 强制分包时,
  // Rollup 会把 react/react-dom 这些 CJS 共享模块并进 codemirror chunk, 于是入口
  // chunk 为了几个 kB 的 react 静态 import 整个 400+ kB 的编辑器 chunk, 每个页面
  // 首屏都白拉一份 CodeMirror.
  // React must own a vendor chunk: otherwise the forced @uiw/@codemirror split below
  // drags react/react-dom into the codemirror chunk, so the entry chunk statically
  // imports 400+ kB of editor code on every first paint.
  if (/^.*\/node_modules\/(react|react-dom|scheduler)\//.test(normalizedId)) return 'react-vendor'
  const threeSrcMarker = '/node_modules/three/src/'
  const threeSrcIndex = normalizedId.indexOf(threeSrcMarker)
  if (threeSrcIndex !== -1) {
    const rel = normalizedId.slice(threeSrcIndex + threeSrcMarker.length)
    if (rel.startsWith('renderers/')) return 'three-renderers'
  }
  if (normalizedId.includes('/node_modules/three/build/')) return 'three'
  // Markdown 渲染栈里的两个大件单独成 chunk: 它们只在渲染到公式/代码块时才真正用到,
  // 拆开后可各自缓存, 也让首屏无关的 markdown chunk 不再顶到 600 kB 告警线.
  // Two heavy Markdown-runtime libraries get their own chunks so they cache independently and
  // the markdown chunk stops tripping the 600 kB warning; none of them is on the first paint.
  // 注意排除 .css: main.tsx 全局引了 katex.min.css, 若把它也归进 katex chunk, 入口就会为了
  // 一个样式文件静态 import 整个 500 kB 的 katex JS —— 与上面 React 被 codemirror 吞掉同款事故.
  // Exclude CSS: main.tsx imports katex.min.css globally, and folding it into the katex chunk
  // would make the entry statically import 500 kB of katex JS just for a stylesheet.
  if (normalizedId.includes('/node_modules/katex/') && !normalizedId.endsWith('.css')) return 'katex'
  if (normalizedId.includes('/node_modules/highlight.js/')) return 'highlight'
  // CodeMirror 编辑器核心 (view/state/language/commands/autocomplete/search/theme-one-dark + @uiw):
  // 抽成独立可缓存 vendor chunk, 让 code-conversation 业务代码 chunk 保持极小, 且跨部署可缓存.
  // 语言包仍然不进核心 chunk; 但统一收敛到 codemirror-langs 这个 lazy chunk, 避免每种语言
  // 散成匿名 index-* 小块。由于 CodeMirrorEditor 自身已 React.lazy, 这些语言包只会在打开
  // 代码对话并选择可编辑文件之后才加载。@lezer/* 保留在核心 vendor，避免和
  // @codemirror/language 形成 chunk 互相引用。
  if (normalizedId.includes('/node_modules/@uiw/')) return 'codemirror'
  if (normalizedId.includes('/node_modules/@codemirror/lang-')) {
    return 'codemirror-langs'
  }
  if (normalizedId.includes('/node_modules/@codemirror/') &&
      !normalizedId.includes('/node_modules/@codemirror/lang-')) {
    return 'codemirror'
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT) || 45616,
    host: process.env.VITE_HOST || '127.0.0.1',
    allowedHosts: allowedHosts.includes('all') ? true : allowedHosts,
    hmr: Object.keys(hmr).length ? hmr : undefined,
    proxy: {
      '/api': apiTarget,
      // v2 后端没挂 code-server 反代时这条 proxy 是 noop (后端 404), 留着等以后开通
      '/code-server': { target: apiTarget, ws: true, changeOrigin: false },
      // 拓展系统: /extension/<name>/* 与 /extension/_sdk/ext.js 由后端 staticRouter 提供.
      // dev 模式必须代理到后端, 否则新 tab 打开 /extension/<name>/ 会被 vite SPA fallback 吞掉.
      '/extension': apiTarget,
      // Next.js 静态导出的 chunk/runtime 走绝对根路径 /_next/static/..., 跟 HTML 挂在哪无关.
      // 见 backend/routes/ext.js 里 unprefixedNextRouter 的注释, 必须代理到后端, 否则
      // vite SPA fallback 会吞掉, 浏览器拿到的是 mobius 主前端 HTML, 报 "Loading chunk failed".
      '/_next': apiTarget,
      // 桌面客户端 zip 由后端 server.js 的 /desktop-builds 静态路由分发 (build.py 产物).
      // dev 模式必须代理, 否则下载菜单链接被 vite SPA fallback 吞掉 → 404.
      '/desktop-builds': apiTarget,
      // aimux bridge 由后端 server.js 反代并注入 bridge token (设备清单/连接状态/切换设备).
      // dev 模式必须代理, 否则 vite SPA fallback 返回 index.html → 设备下拉恒空.
      '/aimux_bridge': { target: apiTarget, ws: true, changeOrigin: false },
    }
  },
  build: {
    outDir: buildOutDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  }
})
