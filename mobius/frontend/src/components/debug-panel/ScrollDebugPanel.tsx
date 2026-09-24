/**
 * ScrollDebugPanel.tsx — 追底诊断浮窗 (隐藏, 由 window.debug_panel 唤出).
 *
 * 数据全部来自 services/scroll-diagnostics 的探针注册表 + scroll-debug 的事件环,
 * 本组件只读不写, 不持有任何业务状态; 样式全用内联, 避免与全局 CSS 的 !important 规则打架.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  collectBlockingFlags,
  collectDiagSections,
  frontendBuildKind,
  isDebugPanelVisible,
  setDebugPanelVisible,
  subscribeDebugPanelVisible,
  type DiagFlag,
  type DiagSection,
  type DiagTone,
} from '../../services/scroll-diagnostics'
import { clearScrollDebugEvents, readScrollDebugEvents, type ScrollDebugEvent } from '../scroll-debug'

const REFRESH_MS = 250
const EVENT_ROWS = 60
const PANEL_WIDTH = 460

const C = {
  bg: 'rgba(9, 14, 26, 0.96)',
  bgSoft: 'rgba(255, 255, 255, 0.04)',
  border: '#22304d',
  text: '#e2e8f0',
  muted: '#8fa3bf',
  ok: '#34d399',
  warn: '#fbbf24',
  bad: '#f87171',
}

function toneColor(tone: DiagTone | undefined): string {
  if (tone === 'ok') return C.ok
  if (tone === 'warn') return C.warn
  if (tone === 'bad') return C.bad
  return C.text
}

function clockOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function FlagChip({ flag }: { flag: DiagFlag }) {
  const active = flag.active
  const color = !active ? C.muted : flag.blocking ? C.bad : C.warn
  return (
    <span
      title={flag.detail || flag.key}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px',
        borderRadius: 999, fontSize: 'var(--fs-xs)', lineHeight: '14px', whiteSpace: 'nowrap',
        border: `1px solid ${active ? color : C.border}`,
        background: active ? `${color}1f` : 'transparent',
        color,
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 999, background: color }} />
      {flag.label}
    </span>
  )
}

function SectionCard({ section, collapsed, onToggle }: {
  section: DiagSection
  collapsed: boolean
  onToggle: (key: string) => void
}) {
  const blocking = (section.flags || []).filter((f) => f.active && f.blocking)
  const accent = blocking.length ? C.bad : toneColor(section.tone)
  return (
    <div style={{ border: `1px solid ${C.border}`, borderLeft: `3px solid ${accent}`, borderRadius: 8, marginBottom: 8, background: C.bgSoft }}>
      <div
        onClick={() => onToggle(section.key)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ color: C.muted, fontSize: 'var(--fs-xs)' }}>{collapsed ? '▶' : '▼'}</span>
        <span style={{ color: accent, fontWeight: 600, fontSize: 'var(--fs-sm)' }}>{section.title}</span>
        {section.subtitle && <span style={{ color: C.muted, fontSize: 'var(--fs-xs)' }}>· {section.subtitle}</span>}
      </div>
      {!collapsed && (
        <div style={{ padding: '0 8px 8px' }}>
          {section.rows.map((row) => (
            <div key={row.label} style={{ display: 'flex', gap: 8, padding: '2px 0', borderTop: `1px solid rgba(255,255,255,0.04)` }}>
              <span style={{ color: C.muted, flex: '0 0 44%', fontSize: 'var(--fs-xs)' }}>{row.label}</span>
              <span style={{ color: toneColor(row.tone), flex: 1, fontSize: 'var(--fs-xs)', wordBreak: 'break-all' }}>{row.value}</span>
            </div>
          ))}
          {(section.flags || []).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
              {(section.flags || []).map((flag) => <FlagChip key={flag.key} flag={flag} />)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function ScrollDebugPanel() {
  const [sections, setSections] = useState<DiagSection[]>([])
  const [events, setEvents] = useState<ScrollDebugEvent[]>([])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [copied, setCopied] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  useEffect(() => {
    const tick = () => {
      setSections(collectDiagSections())
      setEvents(readScrollDebugEvents())
    }
    tick()
    const timer = window.setInterval(tick, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      // 拖拽中只改位置, 不触发任何 React 之外的重活
      // Dragging only moves the box; nothing else re-renders
      setPos({ left: e.clientX - dragRef.current.dx, top: Math.max(0, e.clientY - dragRef.current.dy) })
    }
    const onUp = () => { dragRef.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const blocking = useMemo(() => collectBlockingFlags(sections), [sections])
  const chaseSection = sections.find((s) => s.key === 'chase')
  const loopDead = (chaseSection?.flags || []).some((f) => f.key === 'chase.loop-dead' && f.active)

  // 结论行: 环死了优先报因 A, 否则列出当前所有阻塞追底的开关.
  // Verdict line: a dead chase loop wins, otherwise list every blocking flag.
  let verdict = '追底正常'
  let verdictTone: DiagTone = 'ok'
  if (loopDead) {
    verdict = '追底环已死 — 条目驱动的追底不会再启动 (因 A)'
    verdictTone = 'bad'
  } else if (blocking.length > 0) {
    verdict = `追底已停 — ${blocking.map((f) => f.label).join(' + ')}`
    verdictTone = 'bad'
  }

  const copySnapshot = useCallback(() => {
    const payload = {
      at: new Date().toISOString(),
      build: frontendBuildKind(),
      verdict,
      sections,
      events: events.slice(-EVENT_ROWS),
    }
    try {
      void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板被拒时忽略, 用户仍可框选文本
      // Ignore clipboard rejection, the text is still selectable
    }
  }, [events, sections, verdict])

  const positionStyle: React.CSSProperties = pos
    ? { left: pos.left, top: pos.top }
    : { right: 16, top: 64 }

  return (
    <div
      data-testid="scroll-debug-panel"
      style={{
        position: 'fixed', ...positionStyle, zIndex: 2147483000, width: PANEL_WIDTH,
        maxHeight: '78vh', display: 'flex', flexDirection: 'column',
        background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10,
        boxShadow: '0 18px 48px rgba(0,0,0,0.55)', color: C.text,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 'var(--fs-sm)', backdropFilter: 'blur(6px)',
      }}
    >
      <div
        onMouseDown={(e) => { dragRef.current = { dx: e.clientX - (pos?.left ?? e.clientX), dy: e.clientY - (pos?.top ?? e.clientY) } }}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderBottom: `1px solid ${C.border}`, cursor: 'move' }}
      >
        <span style={{ fontWeight: 700, letterSpacing: 0.3 }}>追底诊断</span>
        <span style={{ color: C.muted, fontSize: 'var(--fs-xs)' }}>{frontendBuildKind()}</span>
        <span style={{ flex: 1 }} />
        <button onClick={copySnapshot} style={btnStyle}>{copied ? '已复制' : '复制'}</button>
        <button onClick={() => clearScrollDebugEvents()} style={btnStyle}>清事件</button>
        <button onClick={() => setDebugPanelVisible(false)} style={btnStyle}>关闭</button>
      </div>

      <div style={{ padding: '6px 9px', borderBottom: `1px solid ${C.border}`, color: toneColor(verdictTone) }}>
        {verdict}
        {blocking.length > 0 && (
          <div style={{ marginTop: 3, color: C.muted, fontSize: 'var(--fs-xs)' }}>
            {blocking.map((f) => `${f.label}: ${f.detail || ''}`).join('  |  ')}
          </div>
        )}
      </div>

      <div style={{ overflowY: 'auto', padding: 8, flex: 1 }}>
        {sections.length === 0 && <div style={{ color: C.muted }}>暂无探针 — 打开一个会话后这里会列出各环节状态</div>}
        {sections.map((section) => (
          <SectionCard
            key={section.key}
            section={section}
            collapsed={!!collapsed[section.key]}
            onToggle={(key) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))}
          />
        ))}

        <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.bgSoft }}>
          <div style={{ padding: '6px 8px', color: C.muted, fontWeight: 600 }}>事件流 (最新在上, 共 {events.length})</div>
          <div style={{ maxHeight: 190, overflowY: 'auto', padding: '0 8px 8px' }}>
            {events.length === 0 && <div style={{ color: C.muted }}>暂无事件</div>}
            {/* 最新在上: 打开浮窗时第一眼就是"刚才发生了什么" */}
            {/* Newest first: the first thing read is what just happened */}
            {events.slice(-EVENT_ROWS).reverse().map((event, index) => (
              <div key={`${event.at}-${index}`} style={{ display: 'flex', gap: 6, padding: '1px 0' }}>
                <span style={{ color: C.muted, flex: '0 0 74px' }}>{clockOf(event.at)}</span>
                <span style={{ flex: 1, wordBreak: 'break-word' }}>{event.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 浮窗宿主: 常驻挂载, 只在可见时渲染面板本体 (隐藏时彻底不占开销). */
export function ScrollDebugPanelHost() {
  const [visible, setVisible] = useState(isDebugPanelVisible())
  useEffect(() => subscribeDebugPanelVisible(setVisible), [])
  if (!visible) return null
  return <ScrollDebugPanel />
}

const btnStyle: React.CSSProperties = {
  background: 'transparent', color: C.text, border: `1px solid ${C.border}`,
  borderRadius: 5, padding: '2px 7px', fontSize: 'var(--fs-xs)', cursor: 'pointer', fontFamily: 'inherit',
}
