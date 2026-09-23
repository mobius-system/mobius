/**
 * install-debug-panel.tsx — 把隐藏的追底诊断浮窗接到 window.debug_panel.
 *
 * 只在 main.tsx 调用一次: 同步注册控制台命令 (零成本), 面板本体走动态 import,
 * 首次唤出时才拉 chunk 并建一个独立 React root — 不进 App 树, 不随业务重渲染.
 *
 * 用法 (F12 控制台): `debug_panel` 打开; `debug_panel = false` 关闭.
 */
import ReactDOM from 'react-dom/client'
import { isDebugPanelVisible, setDebugPanelVisible, subscribeDebugPanelVisible } from './scroll-diagnostics'

let mounted = false
let pending = false

// 独立 root: 挂在 body 末尾, 与 #root 内的应用完全隔离
// Separate root: appended to body, fully isolated from the app under #root
function mountPanelHost(): void {
  if (mounted || pending) return
  pending = true
  void import('../components/debug-panel/ScrollDebugPanel')
    .then(({ ScrollDebugPanelHost }) => {
      const container = document.createElement('div')
      container.id = 'mobius-scroll-debug-panel'
      document.body.appendChild(container)
      // ✨ 核心行: 建独立 root 渲染浮窗宿主, 之后开关只切 store 可见性
      // ✨ Core line: mount the host in its own root; toggling only flips a store flag
      ReactDOM.createRoot(container).render(<ScrollDebugPanelHost />)
      mounted = true
    })
    .catch((error) => {
      // 动态 chunk 拉取失败时降级为 console 日志 (部署更新后旧页面常见)
      // Fall back to console logging when the lazy chunk cannot be fetched
      // eslint-disable-next-line no-console
      console.error('[debug-panel] 加载诊断浮窗失败:', error)
    })
    .finally(() => { pending = false })
}

/** 注册 `debug_panel` 控制台开关 (幂等, 重复调用无副作用). */
export function installDebugPanel(): void {
  if (typeof window === 'undefined') return
  subscribeDebugPanelVisible((visible) => { if (visible) mountPanelHost() })
  if (isDebugPanelVisible()) mountPanelHost()
  try {
    Object.defineProperty(window, 'debug_panel', {
      get() {
        setDebugPanelVisible(true)
        return '✓ 追底诊断浮窗已打开 — 关闭: debug_panel = false；console 日志: debug_scroll'
      },
      set(value: unknown) {
        setDebugPanelVisible(Boolean(value))
      },
      configurable: true,
    })
  } catch {
    // 重复定义或不可配置时忽略
  }
}
