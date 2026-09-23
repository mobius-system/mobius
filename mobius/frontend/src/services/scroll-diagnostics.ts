/**
 * scroll-diagnostics.ts — jsonl 追底诊断浮窗的数据总线.
 *
 * 设计: 组件挂载时用 registerDiagProbe() 注册一个只读 probe (纯函数, 返回当前快照),
 * 浮窗按固定频率轮询所有 probe 并渲染; 组件卸载即注销. 本模块不参与任何业务逻辑,
 * 不存 React 状态, 未打开浮窗时全部开销 = 每次 probe 调用一个 Map 遍历.
 *
 * 术语: row = 一行 "标签: 值"; flag = 一个布尔诊断开关, blocking=true 表示
 * "只要它为真, 追底就一定不会发生", 浮窗据此在顶部给出结论行.
 */

export type DiagTone = 'ok' | 'warn' | 'bad' | 'muted'

export type DiagRow = { label: string; value: string; tone?: DiagTone }

export type DiagFlag = {
  key: string
  label: string
  active: boolean
  detail?: string
  // 为真时浮窗顶部结论行报 "追底已停". 非阻塞项 (如"已在底部") 留空.
  blocking?: boolean
}

export type DiagSection = {
  // 全局唯一即可, 同 id 实例 (简易模式 keepalive 会同时挂多个 ChatArea) 靠 title 区分.
  key: string
  title: string
  subtitle?: string
  tone?: DiagTone
  rows: DiagRow[]
  flags?: DiagFlag[]
}

export type DiagProbe = () => DiagSection | null | undefined

const probes = new Map<number, DiagProbe>()
let nextProbeId = 1

/** 注册一个诊断探针, 返回注销函数 (组件 effect 里直接 return 它). */
export function registerDiagProbe(probe: DiagProbe): () => void {
  const id = nextProbeId++
  probes.set(id, probe)
  return () => { probes.delete(id) }
}

/** 轮询全部探针. 单个探针抛错只丢它自己, 不影响其余区块. */
export function collectDiagSections(): DiagSection[] {
  const out: DiagSection[] = []
  for (const probe of Array.from(probes.values())) {
    try {
      const section = probe()
      if (section) out.push(section)
    } catch {
      // 诊断自身不能把页面带崩
      // Diagnostics must never take the page down
    }
  }
  return out
}

export function collectBlockingFlags(sections: DiagSection[]): DiagFlag[] {
  const out: DiagFlag[] = []
  for (const section of sections) {
    for (const flag of section.flags || []) {
      if (flag.active && flag.blocking) out.push(flag)
    }
  }
  return out
}

// ── 浮窗可见性 (无 React 依赖, 供 install 脚本与标题栏按钮共用) ──
let visible = false
const visibilityListeners = new Set<(value: boolean) => void>()

export function isDebugPanelVisible(): boolean {
  return visible
}

export function setDebugPanelVisible(next: boolean): void {
  if (visible === next) return
  visible = next
  visibilityListeners.forEach((listener) => listener(visible))
}

export function subscribeDebugPanelVisible(listener: (value: boolean) => void): () => void {
  visibilityListeners.add(listener)
  return () => { visibilityListeners.delete(listener) }
}

// ── 展示辅助 ──
export function ms(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value < 1000) return `${Math.round(value)}ms`
  return `${(value / 1000).toFixed(1)}s`
}

export function px(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${Math.round(value)}px`
}

export function bool(value: boolean, on = '是', off = '否'): string {
  return value ? on : off
}

/** 当前前端产物: vite dev 会双调用 effect, 生产构建不会 — 追底"因 A"只在前者出现. */
export function frontendBuildKind(): string {
  if (typeof window === 'undefined') return '未知环境'
  // 直接看产物特征而不是 import.meta.env: 前者同时说明"React 是开发构建"这一事实本身.
  // Detect the dev server at runtime: it also implies React runs in development mode.
  const win = window as unknown as Record<string, unknown>
  const isDevServer = typeof win.$RefreshReg$ === 'function' || !!document.querySelector('script[src="/@vite/client"]')
  return isDevServer ? 'vite dev — StrictMode 双调用生效' : '生产构建'
}
