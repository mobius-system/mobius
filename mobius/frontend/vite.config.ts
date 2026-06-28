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
  const threeSrcMarker = '/node_modules/three/src/'
  const threeSrcIndex = normalizedId.indexOf(threeSrcMarker)
  if (threeSrcIndex !== -1) {
    const rel = normalizedId.slice(threeSrcIndex + threeSrcMarker.length)
    if (rel.startsWith('renderers/')) return 'three-renderers'
  }
  if (normalizedId.includes('/node_modules/three/build/')) return 'three'
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
