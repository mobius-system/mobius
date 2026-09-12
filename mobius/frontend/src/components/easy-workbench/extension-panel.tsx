import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Lock,
  PanelRightClose,
  RotateCw,
} from 'lucide-react'
import type { ExtensionPanelState } from '../../services/easy-workbench/workbench-panes'

// 极简模式右侧栏的「类浏览器」扩展面板。由全局事件 mobius:open-extension-panel
// 触发 (左栏「我的创作」点扩展条目时派发)，挂在 workbench-shell 的 right 槽位。
// 拓展项目本质就是一个网页，所以这里直接用浏览器形态来承载:
//   地址栏(只读) + 后退/前进/刷新 + 新标签打开 + 收起。iframe 自己维护历史栈。
// 右栏由 workbench-panes 统一调度: open=false 时整个面板 display:none 但保持挂载,
// iframe 内容不丢; data-open="true" 时 CSS 才会撑开侧栏 (与 SessionToolDrawer 同契约)。
//
// 实时渲染: 面板打开时轮询拓展入口页与其引用资源的 ETag (条件 GET, 304 极廉价),
// 中间会话一旦改了拓展产物 (dist 重建 / 零编译文件直改), 签名变化即自动 reload iframe,
// 让右栏始终展示任务区的最新结果, 不需要用户手点刷新。
export type { ExtensionPanelState }

const AUTO_SYNC_INTERVAL_MS = 3_000
const SYNC_BADGE_MS = 1_600

// 从入口 html 里粗提本站资源引用 (script/link/img source), 用于逐个条件 GET 校验。
function extractAssetUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = []
  const push = (raw: string) => {
    if (!raw || /^(https?:|data:|blob:|#|mailto:)/i.test(raw)) return
    try { urls.push(new URL(raw, baseUrl).pathname) } catch { /* 非法引用忽略 */ }
  }
  const patterns = [
    /<script[^>]+src=["']([^"']+)["']/gi,
    /<link[^>]+href=["']([^"']+)["']/gi,
    /<img[^>]+src=["']([^"']+)["']/gi,
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(html))) push(match[1])
  }
  return Array.from(new Set(urls))
}

// 拓展当前"指纹": 入口 html 全文 + 各引用资源的 ETag。任何一个变化都代表产物更新。
async function fetchExtensionSignature(url: string, etagsRef: { current: Map<string, string> }): Promise<string | null> {
  try {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) return null
    const html = await response.text()
    const parts = [html]
    const etags = etagsRef.current
    for (const asset of extractAssetUrls(html, url)) {
      // 同一资源沿用上次 ETag 做条件 GET: 未变 → 304 (无响应体), 变了 → 200 + 新 ETag。
      const previous = etags.get(asset)
      const assetResponse = await fetch(asset, previous ? { headers: { 'if-none-match': previous } } : {})
      if (assetResponse.status === 304) {
        parts.push(`${asset}@${previous || ''}`)
        continue
      }
      if (!assetResponse.ok) { parts.push(`${asset}@err`); continue }
      const etag = assetResponse.headers.get('etag') || String(assetResponse.headers.get('content-length') || '')
      if (etag) etags.set(asset, etag)
      parts.push(`${asset}@${etag}`)
    }
    return parts.join('|')
  } catch {
    return null
  }
}

export const EXTENSION_PANEL_OPEN_EVENT = 'mobius:open-extension-panel'
export const EXTENSION_PANEL_CLOSE_EVENT = 'mobius:close-extension-panel'

export function openExtensionPanel(payload: ExtensionPanelState) {
  window.dispatchEvent(new CustomEvent(EXTENSION_PANEL_OPEN_EVENT, { detail: payload }))
}

export function closeExtensionPanel() {
  window.dispatchEvent(new CustomEvent(EXTENSION_PANEL_CLOSE_EVENT))
}

export function ExtensionPanel({
  panel,
  open,
  onClose,
}: {
  panel: ExtensionPanelState
  open: boolean
  onClose: () => void
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [justSynced, setJustSynced] = useState(false)

  // ── 实时渲染: 面板打开期间轮询拓展指纹, 变化即自动 reload ──
  // 指纹 = 入口 html 文本 + 引用资源 ETag。资源 ETag 缓存在 ref 里走条件 GET,
  // 未变化的请求都是 304, 轮询开销可忽略。切换拓展 (panel.name/url 变) 时重置基线。
  const assetEtagsRef = useRef(new Map<string, string>())
  const signatureRef = useRef<string | null>(null)
  useEffect(() => {
    assetEtagsRef.current = new Map()
    signatureRef.current = null
  }, [panel.name, panel.url])
  useEffect(() => {
    if (!open) return
    let stopped = false
    let timer = 0
    const tick = async () => {
      if (stopped) return
      const signature = await fetchExtensionSignature(panel.url, assetEtagsRef)
      if (stopped) return
      if (signature && signatureRef.current !== null && signature !== signatureRef.current) {
        // 产物变了: 静默重载 iframe, 右上角亮一下「已同步」。
        signatureRef.current = signature
        setReloadKey(key => key + 1)
        setJustSynced(true)
        window.setTimeout(() => setJustSynced(false), SYNC_BADGE_MS)
      } else if (signature) {
        signatureRef.current = signature
      }
      timer = window.setTimeout(tick, AUTO_SYNC_INTERVAL_MS)
    }
    void tick()
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [open, panel.url])

  // 记录 iframe 内部历史位置, 用于点亮/点暗后退前进按钮。
  useEffect(() => {
    setCanGoBack(false)
    setCanGoForward(false)
  }, [panel.url, reloadKey])

  const syncHistoryState = () => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    try {
      const history = iframe.contentWindow.history
      setCanGoBack(history.length > 1)
      setCanGoForward(false)
    } catch {
      // 跨源 iframe 读不到 history — 按钮保持可用, 由浏览器忽略无效导航。
      setCanGoBack(true)
    }
  }

  const navigateHistory = (delta: number) => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    try {
      iframe.contentWindow.history.go(delta)
      window.setTimeout(syncHistoryState, 200)
    } catch {
      // 同源限制下 iframe 加载的是同源 /extension/ 路径, 正常不会到这里。
    }
  }

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose, open])

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      data-extension-panel
      data-open={open ? 'true' : 'false'}
      aria-hidden={!open}
      style={{ background: 'var(--surface-right)' }}
    >
      {/* 浏览器式工具条 */}
      <header className="flex flex-shrink-0 items-center gap-1 border-b px-1.5 py-1.5" style={{ borderColor: 'var(--border-default)' }}>
        <button type="button" onClick={() => navigateHistory(-1)} disabled={!canGoBack}
          className="workbench-icon-btn disabled:opacity-35" aria-label="后退" title="后退">
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => navigateHistory(1)} disabled={!canGoForward}
          className="workbench-icon-btn disabled:opacity-35" aria-label="前进" title="前进">
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => setReloadKey(key => key + 1)}
          className="workbench-icon-btn" aria-label="刷新" title="刷新">
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        {/* 地址栏 (只读, 展示当前拓展页位置) */}
        <div
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full border px-2.5 py-1"
          style={{ borderColor: 'var(--border-default)', background: 'var(--surface-control)' }}
          title={panel.url}
        >
          <Lock className="h-3 w-3 flex-shrink-0" style={{ color: 'var(--status-success)' }} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {panel.url}
          </span>
          {justSynced && (
            <span
              className="flex-shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium"
              style={{ background: 'color-mix(in srgb, var(--status-success) 16%, transparent)', color: 'var(--status-success)' }}
              role="status"
            >
              已同步
            </span>
          )}
        </div>
        <button type="button" onClick={() => window.open(panel.url, '_blank')}
          className="workbench-icon-btn" aria-label="新标签打开" title="新标签打开">
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onClose} className="workbench-icon-btn" aria-label="收起浏览器" title="收起浏览器 (Esc)">
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      </header>
      {/* 页面标题条 */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: 'var(--border-default)' }}>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }} title={panel.displayName}>
          {panel.displayName}
        </span>
        <span className="flex-shrink-0 text-[10px]" style={{ color: 'var(--text-muted)' }}>拓展预览</span>
      </div>
      <iframe
        ref={iframeRef}
        key={`${panel.name}:${reloadKey}`}
        src={panel.url}
        title={panel.displayName}
        onLoad={syncHistoryState}
        className="min-h-0 w-full flex-1 border-0"
        style={{ background: '#ffffff' }}
      />
    </div>
  )
}
