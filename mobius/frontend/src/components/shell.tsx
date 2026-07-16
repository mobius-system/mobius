import { useState, useEffect, useRef } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useStore, api } from '../store'
import { ChangePasswordModal, AimuxGuideModal, DesktopDownloadModal, MobileDownloadModal } from './modals'
import { GlobalCreateMenu, GlobalCreateRoot, type CreateKind } from './global-create'
import { SearchModal } from './search-modal'
import { AimuxStatusBadge } from './aimux-status-badge'
import { ProjectPathBindGate } from './project-path-bind-gate'
import { AdminPanel } from './panels'
import { MobiusLogo } from './mobius-logo'
import { GuideHelpModal } from './guide-help'
import { CustomThemePalette } from './custom-theme-palette'
import { Check, ChevronDown, CircleDot, CircleQuestionMark, FlaskConical, History, Menu, MessageSquare, Moon, Palette, Plus, Search, Sliders, Sun, WavesHorizontal, createLucideIcon } from 'lucide-react'
import { THEME_OPTIONS, getThemeOption } from '../theme'
import { applyCustomThemeToRoot, customThemeSwatches, getBaseOption, loadActiveCustomThemeId, loadCustomThemes, saveActiveCustomThemeId, type CustomTheme } from '../services/custom-themes'
import { useIsMobile } from './resizable-panel'
import { DesktopDragHandle, WindowControls } from './window-controls'
import { WorkspaceLayoutToggle } from './workspace/workspace-layout-toggle'

// 桌面端标题栏: Electron 窗口下顶栏充当可拖拽标题栏 (VSCode 风)。
// isDesktop 来自 window.mobiusDesktop (preload 注入); 平台用 navigator.platform 判:
// mac 交通灯在左 → 顶栏左让位; win/linux 窗口按钮在右 → 操作区右让位。Web 端 IS_DESKTOP=false, 零影响。
const DESKTOP_BRIDGE = typeof window !== 'undefined' ? (window as { mobiusDesktop?: { isDesktop?: boolean } }).mobiusDesktop : undefined
const IS_DESKTOP = !!DESKTOP_BRIDGE?.isDesktop
const IS_MAC_PLATFORM = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

const GithubIcon = createLucideIcon('github', [
  ['path', { d: 'M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22', key: 'github' }],
])

// =====================================================================
// 主题辅助
// =====================================================================
export function tc(theme: string, darkClass: string, lightClass: string) {
  return theme !== 'light' ? darkClass : lightClass
}

// =====================================================================
// 时间相关工具
// =====================================================================
export function isRecentlyActive(date: string) {
  if (!date) return false
  return (Date.now() - new Date(date).getTime()) < 30000
}

export function timeAgo(date: string) {
  if (!date) return ''
  const diff = Date.now() - new Date(date).getTime()
  const days = Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)))
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days <= 7) return `${days}天前`
  return '更早'
}

// 精确到分钟的时间显示，用于黑板等需要精确时间的场景
export function timeAgoPrecise(date: string) {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) {
    const diffMs = now.getTime() - d.getTime()
    if (diffMs < 60 * 1000) return '刚刚'
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 60) return `${diffMin}分钟前 ${hhmm}`
    return `今天 ${hhmm}`
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()) {
    return `昨天 ${hhmm}`
  }
  const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (d.getFullYear() === now.getFullYear()) return `${mmdd} ${hhmm}`
  return `${d.getFullYear()}-${mmdd} ${hhmm}`
}

function LinklessRouteButton({ to, className = '', children, onClick, onAuxClick, newTab = false, ...props }: any) {
  const navigate = useNavigate()
  const openTarget = (event: any) => {
    if (!to) return
    if (newTab || event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.button === 1) {
      window.open(to, '_blank', 'noopener,noreferrer')
      return
    }
    navigate(to)
  }

  return (
    <button
      type="button"
      {...props}
      className={`appearance-none border-0 bg-transparent text-left cursor-pointer ${className}`}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        openTarget(event)
      }}
      onAuxClick={(event) => {
        onAuxClick?.(event)
        if (event.defaultPrevented) return
        if (event.button !== 1) return
        event.preventDefault()
        openTarget(event)
      }}
    >
      {children}
    </button>
  )
}

export function groupTasksByDate(tasks: any[]) {
  const groups: [string, any[]][] = [['今天', []], ['昨天', []], ['更早', []]]
  const now = Date.now()
  for (const t of tasks) {
    if (!t.last_active) continue
    const diff = now - new Date(t.last_active).getTime()
    const days = Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)))
    if (days === 0) groups[0][1].push(t)
    else if (days === 1) groups[1][1].push(t)
    else groups[2][1].push(t)
  }
  return groups.filter(([_, items]) => items.length > 0)
}

// =====================================================================
// 系统资源指示器 — 位于主题切换按钮左侧
// 约束: 读取频率不得超过每分钟 1 次 (前端 60s 轮询 + 后端 60s 缓存双重保证)
// 低占用时不显示，避免顶栏长期展示无行动价值的状态噪音。
// 磁盘占用 > 85%、内存占用 > 70% 时整体显示红色。
// =====================================================================
const RESOURCE_USAGE_VISIBLE_THRESHOLD_PERCENT = 70
const VERSION_UPTIME_VISIBLE_MAX_MS = 2 * 60 * 60 * 1000

type MemInfo = { usedPercent: number; usedMb: number; totalMb: number }
type DiskInfo = {
  usedPercent: number
  usedGb: number
  totalGb: number
  availGb: number
  targetPath?: string
  mountPath?: string
}
type HealthInfo = {
  version?: string
  code_version?: string
  git_commit?: string | null
  git_commit_short?: string | null
  started_at?: string
  started_at_ms?: number
  uptime_ms?: number
  sampledAtMs?: number
}

type RecentSession = {
  session_id: string
  name?: string
  project_id?: string | null
  project_name?: string | null
  issue_id?: string | null
  issue_title?: string | null
  research_id?: string | null
  research_title?: string | null
  scope_type?: 'issue' | 'research'
  agent_status?: string
  message_count?: number
  last_active?: string
}

function compactUptime(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '--'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24}h`
}

function healthVersionLabel(health: HealthInfo | null) {
  if (!health) return '--'
  return health.git_commit_short
    || health.git_commit?.slice(0, 7)
    || health.code_version?.split('+').pop()?.slice(0, 7)
    || health.version
    || '--'
}

function healthUptimeMs(health: HealthInfo | null) {
  if (!health) return null
  if (typeof health.started_at_ms === 'number') return Date.now() - health.started_at_ms
  if (typeof health.uptime_ms === 'number') {
    const elapsed = health.sampledAtMs ? Date.now() - health.sampledAtMs : 0
    return health.uptime_ms + elapsed
  }
  return null
}

function DiskIndicator() {
  const [disk, setDisk] = useState<DiskInfo | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const d = await api('/api/health/disk')
        if (alive) setDisk(d)
      } catch { /* 忽略本次失败, 下个周期重试 */ }
    }
    load()
    const t = setInterval(load, 60 * 1000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const pct = disk?.usedPercent
  if (pct == null || pct < RESOURCE_USAGE_VISIBLE_THRESHOLD_PERCENT) return null

  const danger = pct != null && pct > 85
  const color = danger ? '#ef4444' : 'var(--text-muted)'
  const location = disk?.mountPath || disk?.targetPath || '/'
  const title = disk
    ? `系统磁盘占用 ${pct}%（${disk.usedGb} / ${disk.totalGb} GB，可用 ${disk.availGb} GB，挂载点 ${location}）`
    : '系统磁盘占用'

  return (
    <div
      className="h-8 px-2 flex items-center gap-1.5 border rounded-lg select-none"
      title={title}
      style={{ color, borderColor: danger ? 'rgba(239,68,68,0.4)' : 'var(--border-color)' }}>
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M5.25 4.5h13.5l1.5 8.25v4.5a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25v-4.5L5.25 4.5zM3.75 14.25h16.5" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M7.5 17.25h.01M10.5 17.25h.01" />
      </svg>
      <span className="text-[12px] tabular-nums font-medium">
        {pct != null ? `${pct}%` : '--'}
      </span>
    </div>
  )
}

function MemoryIndicator() {
  const [mem, setMem] = useState<MemInfo | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const d = await api('/api/health/memory')
        if (alive) setMem(d)
      } catch { /* 忽略本次失败, 下个周期重试 */ }
    }
    load()
    const t = setInterval(load, 60 * 1000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const pct = mem?.usedPercent
  if (pct == null || pct < RESOURCE_USAGE_VISIBLE_THRESHOLD_PERCENT) return null

  const danger = pct != null && pct > RESOURCE_USAGE_VISIBLE_THRESHOLD_PERCENT
  const color = danger ? '#ef4444' : 'var(--text-muted)'

  return (
    <div
      className="h-8 px-2 flex items-center gap-1.5 border rounded-lg select-none"
      title={mem ? `服务器内存占用 ${pct}%（${mem.usedMb} / ${mem.totalMb} MB）` : '服务器内存占用'}
      style={{ color, borderColor: danger ? 'rgba(239,68,68,0.4)' : 'var(--border-color)' }}>
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z" />
      </svg>
      <span className="text-[12px] tabular-nums font-medium">
        {pct != null ? `${pct}%` : '--'}
      </span>
    </div>
  )
}

function VersionIndicator() {
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const d = await api('/api/v2/health')
        if (alive) setHealth({ ...d, sampledAtMs: Date.now() })
      } catch { /* 忽略本次失败, 下个周期重试 */ }
    }
    load()
    const poll = setInterval(load, 30 * 1000)
    const tick = setInterval(() => setTick(v => v + 1), 10 * 1000)
    return () => {
      alive = false
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [])

  const version = healthVersionLabel(health)
  const uptimeMs = healthUptimeMs(health)
  if (uptimeMs == null || uptimeMs > VERSION_UPTIME_VISIBLE_MAX_MS) return null

  const uptime = compactUptime(uptimeMs)
  const title = health
    ? [
        `版本: ${health.version || '--'}`,
        `commit: ${health.git_commit || health.code_version || '--'}`,
        `启动: ${health.started_at || '--'}`,
        `uptime: ${uptime}`,
      ].join('\n')
    : 'Mobius 版本与启动时长'

  return (
    <div
      className="h-8 max-w-[210px] px-2 flex items-center gap-1.5 border rounded-lg select-none"
      title={title}
      style={{ color: 'var(--text-muted)', borderColor: 'var(--border-color)' }}>
      <span className="text-[11px] font-medium tracking-wide" style={{ color: 'var(--text-muted)' }}>ver</span>
      <span className="text-[12px] tabular-nums truncate" style={{ color: 'var(--text-secondary)' }}>
        {version}
      </span>
      <span className="text-[11px] font-medium tracking-wide" style={{ color: 'var(--text-muted)' }}>up</span>
      <span className="text-[12px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {uptime}
      </span>
    </div>
  )
}

// =====================================================================
// 面包屑下拉切换器 — 顶部导航栏的项目 / Issue / Research 快速切换
// 复用主题/用户菜单同款面板样式 (var(--menu-bg) + 点击外部关闭).
// 列表项不输出 href, 避免浏览器在悬浮时显示目标 URL; 中键/修饰键仍可新窗打开.
// =====================================================================
type SwitcherItem = {
  id: string
  label: string
  meta?: string
  status?: string
  active?: boolean
  to: string
}

function NavSwitcherPanel({
  items,
  loading,
  search,
  onSearchChange,
  onPick,
  emptyText,
}: {
  items: SwitcherItem[]
  loading: boolean
  search: string
  onSearchChange: (v: string) => void
  onPick: () => void
  emptyText: string
}) {
  const q = search.trim().toLowerCase()
  const filtered = q
    ? items.filter(it => it.label.toLowerCase().includes(q) || (it.meta || '').toLowerCase().includes(q))
    : items
  return (
    <div
      className="absolute left-0 top-9 z-50 flex max-h-[60vh] w-[300px] flex-col rounded-lg p-1.5 shadow-xl"
      style={{ background: 'var(--menu-bg)', border: '1px solid var(--border-color)' }}
      onClick={e => e.stopPropagation()}
    >
      <div className="relative mb-1.5">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
        <input
          autoFocus
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="搜索..."
          className="h-7 w-full rounded-md pl-7 pr-2 text-[12px] focus:outline-none"
          style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
        />
      </div>
      <div className="overflow-y-auto">
        {loading ? (
          <div className="px-2 py-3 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
        ) : filtered.length === 0 ? (
          <div className="px-2 py-3 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>{emptyText}</div>
        ) : (
          filtered.map(item => (
            <LinklessRouteButton
              key={item.id}
              to={item.to}
              onClick={onPick}
              title={item.label}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
              style={{ background: item.active ? 'var(--bg-active)' : undefined }}
            >
              <span
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                style={{ background: item.status === 'completed' ? '#4ade80' : 'var(--accent-primary)' }}
                title={item.status === 'completed' ? '已完成' : '进行中'}
              />
              <span className="min-w-0 flex-1">
                <span
                  className="block truncate text-[12px] font-medium leading-5"
                  style={{
                    color: item.status === 'completed' ? 'var(--text-muted)' : 'var(--text-primary)',
                    textDecoration: item.status === 'completed' ? 'line-through' : undefined,
                  }}
                >
                  {item.label}
                </span>
                {item.meta && (
                  <span className="block truncate text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>{item.meta}</span>
                )}
              </span>
              {item.active && <Check className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-secondary)' }} />}
            </LinklessRouteButton>
          ))
        )}
      </div>
    </div>
  )
}

function recentSessionPath(userId: string | undefined, session: RecentSession) {
  if (!userId || !session.session_id || !session.project_id) return ''
  const base = `/u/${encodeURIComponent(userId)}/p/${encodeURIComponent(session.project_id)}`
  const qs = `?session=${encodeURIComponent(session.session_id)}`
  if (session.scope_type === 'research' && session.research_id) {
    return `${base}/r/${encodeURIComponent(session.research_id)}${qs}`
  }
  if (session.issue_id) {
    return `${base}/i/${encodeURIComponent(session.issue_id)}${qs}`
  }
  return ''
}

function RecentSessionsPanel({
  open,
  userId,
  activeSessionId,
  onPick,
}: {
  open: boolean
  userId?: string
  activeSessionId?: string
  onPick: () => void
}) {
  const [sessions, setSessions] = useState<RecentSession[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    api('/api/tasks')
      .then((arr: any) => {
        if (cancelled) return
        const list = (Array.isArray(arr) ? arr : [])
          .filter((s: any) => s?.session_id && s?.status !== 'archived')
          .sort((a: any, b: any) => new Date(b.last_active || 0).getTime() - new Date(a.last_active || 0).getTime())
          .slice(0, 12)
        setSessions(list)
      })
      .catch((e: any) => {
        if (cancelled) return
        setError(e?.message || '最近会话加载失败')
        setSessions([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [open])

  if (!open) return null

  return (
    <div
      className="absolute left-0 top-10 z-50 flex max-h-[min(68vh,520px)] w-[360px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg p-1.5 shadow-xl"
      style={{ background: 'var(--menu-bg)', border: '1px solid var(--border-color)' }}
      onClick={event => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 px-2.5 py-2" style={{ borderBottom: '1px solid var(--border-color)' }}>
        <History className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-secondary)' }} />
        <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>近期活跃会话</span>
      </div>
      <div className="overflow-y-auto py-1">
        {loading ? (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
        ) : error ? (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>{error}</div>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无近期会话</div>
        ) : (
          sessions.map(session => {
            const to = recentSessionPath(userId, session)
            const active = session.session_id === activeSessionId
            const isResearch = session.scope_type === 'research'
            const subject = isResearch
              ? (session.research_title || session.research_id || 'Research')
              : (session.issue_title || session.issue_id || 'Issue')
            const project = session.project_name || session.project_id || '项目'
            const statusColor = session.agent_status === 'running'
              ? '#f59e0b'
              : (active ? 'var(--accent-primary)' : 'var(--text-muted)')

            return (
              <LinklessRouteButton
                key={session.session_id}
                to={to}
                onClick={onPick}
                title={session.name || session.session_id}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${to ? 'hover:bg-[var(--bg-hover)]' : 'cursor-default opacity-60'}`}
                style={{ background: active ? 'var(--bg-active)' : undefined }}
              >
                <span className="mt-1 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md" style={{ background: isResearch ? 'rgba(168,85,247,0.14)' : 'rgba(59,130,246,0.14)', color: isResearch ? '#c084fc' : '#60a5fa' }}>
                  {isResearch ? <FlaskConical className="h-3 w-3" /> : <CircleDot className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium leading-5" style={{ color: 'var(--text-primary)' }}>
                      {session.name || session.session_id}
                    </span>
                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: statusColor }} />
                  </span>
                  <span className="block truncate text-[10px] leading-4" style={{ color: 'var(--text-secondary)' }}>
                    {project} / {subject}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>
                    <span>{timeAgoPrecise(session.last_active || '')}</span>
                    <span className="inline-flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      {session.message_count || 0}
                    </span>
                  </span>
                </span>
                {active && <Check className="mt-1 h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-secondary)' }} />}
              </LinklessRouteButton>
            )
          })
        )}
      </div>
    </div>
  )
}

// =====================================================================
// 顶部导航 — 所有页面共享
// 包含：Mobius logo、面包屑（user/project/issue）、搜索、主题切换、用户菜单
// 管理员通过弹层（覆盖右侧主区域）
// =====================================================================
export function TopNav({ rightExtra }: { rightExtra?: React.ReactNode } = {}) {
  const {
    user,
    theme,
    toggleTheme,
    setTheme,
    backgroundFlowEnabled,
    toggleBackgroundFlow,
    currentProject,
    currentIssue,
    currentResearch,
    projects,
    setProjects,
    issuesMap,
    setIssuesMap,
    researchesMap,
    setResearchesMap,
    logout,
    branding,
    setMobileNavOpen,
  } = useStore()
  // 移动端才显示汉堡按钮 (断点与 ResizablePanel 抽屉态同源, 不会错位)
  const isMobile = useIsMobile()
  const params = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [showChangePw, setShowChangePw] = useState(false)
  const [showAimuxGuide, setShowAimuxGuide] = useState(false)
  const [showDesktopDownload, setShowDesktopDownload] = useState(false)
  const [showMobileDownload, setShowMobileDownload] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [showThemeMenu, setShowThemeMenu] = useState(false)
  const [showRecentSessions, setShowRecentSessions] = useState(false)
  const [showGuideHelp, setShowGuideHelp] = useState(false)
  const [showPalette, setShowPalette] = useState(false)
  // 调色盘里的主题列表与当前激活 id — 在下拉菜单和顶栏按钮里都用到.
  // 每次打开菜单 / 关闭调色盘 / 主题切换时刷新, 避免在下拉里看到陈旧数据.
  const [customThemes, setCustomThemes] = useState<CustomTheme[]>([])
  const [activeCustomId, setActiveCustomId] = useState<string | null>(null)
  // 面包屑下拉切换: 同时只能打开一个 (project / issue / research).
  // 列表数据来自 store (projects / issuesMap / researchesMap), 缺失时打开瞬间按需拉取.
  const [openSwitcher, setOpenSwitcher] = useState<'project' | 'issue' | 'research' | null>(null)
  const [switcherSearch, setSwitcherSearch] = useState('')
  const [projectSwitcherLoading, setProjectSwitcherLoading] = useState(false)
  const [issueSwitcherLoading, setIssueSwitcherLoading] = useState(false)
  const [researchSwitcherLoading, setResearchSwitcherLoading] = useState(false)
  const closeSwitcher = () => { setOpenSwitcher(null); setSwitcherSearch('') }
  // 防重发 + 防竞态 (修复: 切换 issue/research/project 偶发永久卡在"加载中...").
  // 旧实现: useEffect deps 含 issuesMap, 而成功路径 .then(setIssuesMap) 会更新 issuesMap
  // → 触发 effect 自身 cleanup(alive=false). 若请求的 .finally 落在 cleanup 之后, 其
  // `if(alive) setLoading(false)` 被吞, loading 永久卡 true (数据已入 store 但面板一直转圈,
  // 且因缓存命中后续点击不再发请求). 修法: ① fetchedRef 记录"已成功加载(含空结果)的 key",
  // 跨 effect 生命周期持久防重发; ② 请求结果不再 gate alive, 直接写入(用 projectParam 定位, 幂等);
  // ③ 单调递增 seq, 只有"最后一次请求"的 finally 才归零 loading, 杜绝快速切换 project 时的交叉;
  // ④ effect deps 移除 issuesMap/researchesMap, 从根上消除"成功写入触发自身 cleanup".
  const switcherSeqRef = useRef(0)
  const projectFetchedRef = useRef(false)
  const issueFetchedRef = useRef<Record<string, true>>({})
  const researchFetchedRef = useRef<Record<string, true>>({})
  // 顶部「新建」下拉: 项目 / Issue / Research 三入口. Issue/Research 需在项目上下文内.
  const [showNewMenu, setShowNewMenu] = useState(false)
  const [createKind, setCreateKind] = useState<CreateKind | null>(null)
  // 顶栏「搜索」弹窗: 跨项目/Issue/Research 搜索所有会话 JSONL 内容.
  const [showSearch, setShowSearch] = useState(false)

  const refreshCustomThemes = () => {
    const map = loadCustomThemes()
    setCustomThemes(Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt))
    setActiveCustomId(loadActiveCustomThemeId())
  }

  useEffect(() => { refreshCustomThemes() }, [showThemeMenu, showPalette, theme])

  const isDark = theme !== 'light'
  const currentTheme = getThemeOption(theme)
  const activeCustom = activeCustomId ? loadCustomThemes()[activeCustomId] : null
  // 顶栏按钮上要展示的"当前主题":
  // - 有自定义激活: 用自定义的名称, 用调色盘图标
  // - 否则回退到基础主题
  const headerLabel = activeCustom ? activeCustom.name : currentTheme.label
  const headerIconKey: 'light' | 'dark' | 'palette' = activeCustom
    ? 'palette'
    : (theme === 'light' ? 'light' : theme === 'dark' ? 'dark' : 'palette')

  // 关闭用户菜单
  useEffect(() => {
    if (!showUserMenu) return
    const close = () => setShowUserMenu(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [showUserMenu])

  useEffect(() => {
    if (!showThemeMenu) return
    const close = () => setShowThemeMenu(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [showThemeMenu])

  useEffect(() => {
    if (!showRecentSessions) return
    const close = () => setShowRecentSessions(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [showRecentSessions])

  // 新建下拉: 点击外部关闭 (与主题/用户菜单同款机制).
  useEffect(() => {
    if (!showNewMenu) return
    const close = () => setShowNewMenu(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [showNewMenu])

  const userParam = params.user || user?.id
  const projectParam = params.project
  const issueParam = params.issue
  const researchParam = params.research
  const activeSessionId = new URLSearchParams(location.search).get('session') || undefined

  const projectName = currentProject?.name || projectParam
  const issueTitle = currentIssue?.title || issueParam
  const researchTitle = currentResearch?.title || researchParam

  // 顶栏「新建」下拉的可用性: 项目恒可建; Issue/Research 需在项目内且满足权限/开关.
  const inProject = !!projectParam
  const canCreateIssue = inProject && currentProject?.can_create_issue !== false
  const researchEnabled = !!currentProject?.research_enabled
  const canCreateResearch = inProject && researchEnabled && currentProject?.can_create_research !== false

  // 下拉切换器: 打开时点击外部关闭 (与主题/用户菜单一致).
  useEffect(() => {
    if (!openSwitcher) return
    document.addEventListener('click', closeSwitcher)
    return () => document.removeEventListener('click', closeSwitcher)
  }, [openSwitcher])

  // Tab 标题: 项目内显示「<项目名> - 莫比乌斯AI」, 非项目内沿用 branding.systemNameZh.
  // projectName 未异步加载时 fallback 到 projectParam(项目 ID), 保证 tab 不闪空白.
  useEffect(() => {
    const baseName = branding.systemNameZh || ' '
    document.title = inProject ? `${projectName || projectParam} - ${baseName}` : baseName
  }, [branding.systemNameZh, inProject, projectName, projectParam])

  // 打开项目切换器时, 若 store 还没有项目列表则按需拉取.
  useEffect(() => {
    if (openSwitcher !== 'project' || projects.length) return
    if (projectFetchedRef.current) return
    projectFetchedRef.current = true
    const seq = ++switcherSeqRef.current
    setProjectSwitcherLoading(true)
    api('/api/projects')
      .then((arr: any) => { setProjects(arr || []) })
      .catch(() => { projectFetchedRef.current = false })
      .finally(() => { if (switcherSeqRef.current === seq) setProjectSwitcherLoading(false) })
  }, [openSwitcher, projects.length, setProjects])

  // 打开 Issue 切换器时, 若当前项目 issue 列表未缓存则拉取. (空数组也是有效缓存, 不会重复拉.)
  // 故意不把 issuesMap 放进 deps: 成功路径会写入 issuesMap, 若它在 deps 里会触发本 effect
  // 自身 cleanup, 旧 alive-flag 设计下会误杀 .finally 致 loading 永久卡 true (见上方注释).
  useEffect(() => {
    if (openSwitcher !== 'issue' || !projectParam) return
    if (issuesMap[projectParam] || issueFetchedRef.current[projectParam]) return
    issueFetchedRef.current[projectParam] = true
    const seq = ++switcherSeqRef.current
    setIssueSwitcherLoading(true)
    api(`/api/projects/${projectParam}/issues`)
      .then((arr: any) => { setIssuesMap(projectParam, arr || []) })
      .catch(() => { delete issueFetchedRef.current[projectParam] })
      .finally(() => { if (switcherSeqRef.current === seq) setIssueSwitcherLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSwitcher, projectParam])

  // 打开 Research 切换器时, 若当前项目 research 列表未缓存则拉取. (同 issue, 不依赖 researchesMap.)
  useEffect(() => {
    if (openSwitcher !== 'research' || !projectParam) return
    if (researchesMap[projectParam] || researchFetchedRef.current[projectParam]) return
    researchFetchedRef.current[projectParam] = true
    const seq = ++switcherSeqRef.current
    setResearchSwitcherLoading(true)
    api(`/api/projects/${projectParam}/researches`)
      .then((arr: any) => { setResearchesMap(projectParam, arr || []) })
      .catch(() => { delete researchFetchedRef.current[projectParam] })
      .finally(() => { if (switcherSeqRef.current === seq) setResearchSwitcherLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSwitcher, projectParam])

  const projectItems: SwitcherItem[] = (projects as any[])
    .filter(p => p && p.id)
    .map(p => ({
      id: p.id,
      label: p.name || p.id,
      meta: p.kind === 'extension' ? '拓展项目' : (p.is_self_develop ? '自迭代' : (p.created_by ? `@${p.created_by}` : undefined)),
      status: 'active',
      active: p.id === projectParam,
      to: `/u/${p.created_by || userParam}/p/${p.id}`,
    }))

  const issueItems: SwitcherItem[] = ((issuesMap[projectParam ?? ''] || []) as any[])
    .filter(i => i && i.id)
    .map(i => ({
      id: i.id,
      label: i.title || i.id,
      meta: i.session_count ? `${i.session_count} 会话` : undefined,
      status: i.status,
      active: i.id === issueParam,
      to: `/u/${userParam}/p/${projectParam}/i/${i.id}`,
    }))

  const researchItems: SwitcherItem[] = ((researchesMap[projectParam ?? ''] || []) as any[])
    .filter(r => r && r.id)
    .map(r => ({
      id: r.id,
      label: r.title || r.id,
      meta: r.session_count ? `${r.session_count} 会话` : undefined,
      status: r.status,
      active: r.id === researchParam,
      to: `/u/${userParam}/p/${projectParam}/r/${r.id}`,
    }))

  const toggleSwitcher = (which: 'project' | 'issue' | 'research') => {
    setSwitcherSearch('')
    const willOpen = openSwitcher === which ? null : which
    // 打开瞬间若无缓存, 立即置 loading=true (与 setOpenSwitcher 同批 render), 避免面板
    // 首帧因 loading 仍是 false + 无数据而闪现 emptyText ("该项目暂无 Issue" 一晃而过).
    if (willOpen === 'project' && !projects.length) setProjectSwitcherLoading(true)
    if (willOpen === 'issue' && projectParam && !issuesMap[projectParam]) setIssueSwitcherLoading(true)
    if (willOpen === 'research' && projectParam && !researchesMap[projectParam]) setResearchSwitcherLoading(true)
    setOpenSwitcher(willOpen)
  }

  return (
    <>
      <div className={`mobius-topnav h-12 border-b flex items-center justify-between px-5 flex-shrink-0 select-none`}
        style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)', paddingLeft: IS_DESKTOP && IS_MAC_PLATFORM ? '78px' : undefined }}>
        {/* 桌面端拖拽: 不再让整条顶栏 drag (Windows/Electron 下大 drag 父区 + no-drag 洞会吞按钮点击);
            改由下方独立空白 spacer 作唯一 drag 区 (无交互子元素 → 不会被吞, 按钮脱离任何 drag 祖主)。 */}
        {/* 移动端: 汉堡按钮唤出左侧栏抽屉 */}
        {isMobile && (
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="打开侧栏"
            title="项目列表"
            className="mobius-topnav-menu h-9 w-9 flex items-center justify-center rounded-lg border transition-colors hover:bg-[var(--bg-card-hover)] flex-shrink-0"
            style={{ color: 'var(--text-primary)', borderColor: 'var(--border-color)' }}>
            <Menu className="h-5 w-5" strokeWidth={2} />
          </button>
        )}
        {/* Logo + 面包屑 */}
        <div className="mobius-topnav-crumb flex items-center gap-2 min-w-0 flex-shrink-0">
          <div className="relative flex-shrink-0">
            <button
              type="button"
              data-tour="top-nav-brand"
              aria-label="打开近期活跃会话"
              aria-haspopup="menu"
              aria-expanded={showRecentSessions}
              title="近期活跃会话"
              onClick={(event) => {
                event.stopPropagation()
                setShowThemeMenu(false)
                setShowUserMenu(false)
                setShowNewMenu(false)
                closeSwitcher()
                setShowRecentSessions(v => !v)
              }}
              className="flex items-center gap-2 border-0 bg-transparent p-0 text-left flex-shrink-0 cursor-pointer"
            >
              {!branding.hideLogo && <MobiusLogo size={28} />}
              {/* {branding.systemNameEn && (
                <span className="mobius-topnav-brandtext font-semibold text-[14px] tracking-tight" style={{ color: 'var(--text-primary)' }}>
                  {branding.systemNameEn}
                </span>
              )} */}
            </button>
            {showRecentSessions && (
              <RecentSessionsPanel
                open={showRecentSessions}
                userId={user?.id}
                activeSessionId={activeSessionId}
                onPick={() => setShowRecentSessions(false)}
              />
            )}
          </div>
          <span className="mobius-topnav-sep-pre text-[13px]" style={{ color: 'var(--text-muted)' }}>/</span>
          <LinklessRouteButton to={`/u/${userParam}`} className="mobius-topnav-userlink text-[13px] hover:text-blue-400 truncate flex-shrink-0"
            style={{ color: 'var(--text-secondary)', maxWidth: 140 }}>
            {userParam}
          </LinklessRouteButton>
          {projectParam && (
            <>
              <span className="mobius-topnav-sep-post text-[13px]" style={{ color: 'var(--text-muted)' }}>/</span>
              <div className="mobius-topnav-projectcrumb relative flex min-w-0 flex-shrink-0 items-center">
                <LinklessRouteButton to={`/u/${userParam}/p/${projectParam}`}
                  className="text-[13px] hover:text-blue-400 truncate"
                  style={{ color: 'var(--text-secondary)', maxWidth: 180 }}
                  title={projectName}>
                  {projectName}
                </LinklessRouteButton>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggleSwitcher('project') }}
                  title="切换项目"
                  aria-label="切换项目"
                  aria-haspopup="menu"
                  aria-expanded={openSwitcher === 'project'}
                  className="ml-0.5 inline-flex h-6 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)]"
                  style={{ color: 'var(--text-muted)' }}>
                  <ChevronDown className={`h-3 w-3 transition-transform ${openSwitcher === 'project' ? 'rotate-180' : ''}`} />
                </button>
                {openSwitcher === 'project' && (
                  <NavSwitcherPanel
                    items={projectItems}
                    loading={projectSwitcherLoading}
                    search={switcherSearch}
                    onSearchChange={setSwitcherSearch}
                    onPick={closeSwitcher}
                    emptyText="暂无可切换的项目"
                  />
                )}
              </div>
            </>
          )}
          {issueParam && (
            <>
              <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>/</span>
              <div className="relative flex min-w-0 flex-shrink-0 items-center">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggleSwitcher('issue') }}
                  title="切换 Issue"
                  aria-label="切换 Issue"
                  aria-haspopup="menu"
                  aria-expanded={openSwitcher === 'issue'}
                  className="flex min-w-0 items-center gap-0.5 text-[13px] hover:text-blue-400"
                  style={{ color: 'var(--text-primary)' }}>
                  <span className="truncate" style={{ maxWidth: 270 }} title={issueTitle}>{issueTitle}</span>
                  <ChevronDown className={`h-3 w-3 flex-shrink-0 transition-transform ${openSwitcher === 'issue' ? 'rotate-180' : ''}`} style={{ color: 'var(--text-muted)' }} />
                </button>
                {openSwitcher === 'issue' && (
                  <NavSwitcherPanel
                    items={issueItems}
                    loading={issueSwitcherLoading}
                    search={switcherSearch}
                    onSearchChange={setSwitcherSearch}
                    onPick={closeSwitcher}
                    emptyText="该项目暂无 Issue"
                  />
                )}
              </div>
            </>
          )}
          {researchParam && (
            <>
              <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>/</span>
              <div className="relative flex min-w-0 flex-shrink-0 items-center">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggleSwitcher('research') }}
                  title="切换 Research"
                  aria-label="切换 Research"
                  aria-haspopup="menu"
                  aria-expanded={openSwitcher === 'research'}
                  className="flex min-w-0 items-center gap-0.5 text-[13px] hover:text-blue-400"
                  style={{ color: 'var(--text-primary)' }}>
                  <span className="truncate" style={{ maxWidth: 270 }} title={researchTitle}>{researchTitle}</span>
                  <ChevronDown className={`h-3 w-3 flex-shrink-0 transition-transform ${openSwitcher === 'research' ? 'rotate-180' : ''}`} style={{ color: 'var(--text-muted)' }} />
                </button>
                {openSwitcher === 'research' && (
                  <NavSwitcherPanel
                    items={researchItems}
                    loading={researchSwitcherLoading}
                    search={switcherSearch}
                    onSearchChange={setSwitcherSearch}
                    onPick={closeSwitcher}
                    emptyText="该项目暂无 Research"
                  />
                )}
              </div>
            </>
          )}
        </div>

        {/* 桌面端唯一拖拽区: 独立空白 spacer, 通过 IPC 手动拖窗; 不再使用 -webkit-app-region: drag。 */}
        <DesktopDragHandle className="flex-1 self-stretch" aria-hidden />

        {/* 右侧操作 */}
        <div className="mobius-topnav-actions flex min-w-0 flex-shrink items-center gap-1.5 xl:gap-2">
          {rightExtra}
          {/* 桌面端 aimux 反向连接状态徽标 — 仅 Electron 检测到时渲染（搜索按钮左侧） */}
          <AimuxStatusBadge />
          {/* 桌面端项目本地路径绑定闸门 — 仅 Electron + 进入未绑定项目时弹窗（替代旧 Electron 注入 overlay） */}
          <ProjectPathBindGate projectId={projectParam} />
          {/* 新建下拉 — 全局 4 类创建 (项目 / Issue / Session / Research Agent) */}
          <GlobalCreateMenu
            open={showNewMenu}
            onOpenChange={setShowNewMenu}
            onPick={setCreateKind}
            inProject={inProject}
            currentProject={currentProject}
          />
          {/* 工作区布局切换 (会话 ↔ 代码对话) — 仅 Issue/Research 路由渲染, 桌面端可见 */}
          <WorkspaceLayoutToggle />
          {/* 顶栏搜索 — 跨项目/Issue/Research 搜索所有会话内容 (紧邻 +新建) */}
          <button
            type="button"
            onClick={() => setShowSearch(true)}
            title="搜索会话内容"
            aria-label="搜索会话内容"
            data-tour="top-search"
            className="mobius-search-trigger h-8 flex shrink-0 items-center gap-1.5 rounded-lg px-2 border hover:bg-[var(--bg-card-hover)] transition-colors"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color)' }}>
            <Search className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
            {/* {!isMobile && <span className="mobius-topnav-search-label text-[12px] font-medium">搜索</span>} */}
          </button>
          <button
            type="button"
            onClick={() => setShowGuideHelp(true)}
            title="帮助与引导"
            data-tour="top-guide-help"
            className="h-8 w-8 flex shrink-0 items-center justify-center border rounded-lg hover:bg-[var(--bg-card-hover)] transition-colors"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color)' }}
          >
            <CircleQuestionMark className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
          <a
            href="https://github.com/nutshellai-tech/mobius.git"
            target="_blank"
            rel="noopener noreferrer"
            title="GitHub"
            aria-label="GitHub"
            className="h-8 flex shrink-0 items-center gap-1.5 rounded-lg px-2 border hover:bg-[var(--bg-card-hover)] transition-colors"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color)' }}
          >
            <GithubIcon className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
          </a>
          {!IS_DESKTOP && (
            <div data-tour="top-system-status" className="mobius-topnav-status flex shrink-0 items-center gap-2">
              <DiskIndicator />
              <MemoryIndicator />
              <VersionIndicator />
            </div>
          )}
          <div className="relative shrink-0" data-tour="top-theme-toggle">
            <button
              type="button"
              onClick={(event) => {
                if (event.altKey) {
                  toggleTheme()
                  return
                }
                event.stopPropagation()
                setShowThemeMenu(v => !v)
              }}
              title={`当前主题: ${headerLabel}。Alt+点击切换下一个主题`}
              aria-label="选择主题"
              aria-expanded={showThemeMenu}
              className="h-8 max-w-[128px] min-w-0 px-2 flex items-center justify-center gap-1.5 border rounded-lg hover:bg-[var(--bg-card-hover)] transition-colors"
              style={{
                color: 'var(--text-secondary)',
                borderColor: 'var(--border-color)',
              }}
            >
              {headerIconKey === 'light' ? <Sun className="w-3.5 h-3.5 shrink-0" strokeWidth={2} /> : headerIconKey === 'dark' ? <Moon className="w-3.5 h-3.5 shrink-0" strokeWidth={2} /> : <Sliders className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />}
              <span className="mobius-topnav-theme-label min-w-0 max-w-[80px] truncate text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>{headerLabel}</span>
            </button>
            {showThemeMenu && (
              <div
                className="absolute right-0 top-10 z-50 max-h-[calc(100vh-82px)] w-[260px] overflow-y-auto rounded-lg p-1.5 shadow-xl"
                style={{ background: 'var(--menu-bg)', border: '1px solid var(--border-color)' }}
                onClick={event => event.stopPropagation()}
              >
                {THEME_OPTIONS.map(option => {
                  const selected = !activeCustom && option.name === theme
                  return (
                    <button
                      key={option.name}
                      type="button"
                      onClick={() => {
                        setTheme(option.name)
                        setShowThemeMenu(false)
                      }}
                      className="w-full rounded-md px-2 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                      style={{ background: selected ? 'var(--bg-active)' : undefined }}
                    >
                      <span className="flex h-5 w-8 shrink-0 overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-color-strong)' }}>
                        {option.swatches.map((color, index) => (
                          <span key={`${option.name}-${color}-${index}`} className="flex-1" style={{ background: color }} />
                        ))}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] font-semibold leading-4" style={{ color: 'var(--text-primary)' }}>{option.label}</span>
                        <span className="block truncate text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>{option.description}</span>
                      </span>
                      {selected ? <Check className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} /> : null}
                    </button>
                  )
                })}
                <div className="my-1.5 border-t" style={{ borderColor: 'var(--border-color)' }} />
                <button
                  type="button"
                  role="switch"
                  aria-checked={backgroundFlowEnabled}
                  onClick={toggleBackgroundFlow}
                  className="w-full rounded-md px-2 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                  style={{ color: 'var(--text-primary)' }}
                >
                  <WavesHorizontal className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-semibold leading-4">背景光流</span>
                    <span className="block truncate text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>
                      缓慢色彩流动 · {backgroundFlowEnabled ? '已开启' : '已关闭'}
                    </span>
                  </span>
                  <span
                    className="relative h-5 w-9 shrink-0 rounded-full border transition-colors"
                    style={{
                      background: backgroundFlowEnabled ? 'color-mix(in srgb, var(--accent-primary) 28%, transparent)' : 'var(--input-bg)',
                      borderColor: backgroundFlowEnabled ? 'color-mix(in srgb, var(--accent-primary) 46%, var(--border-color))' : 'var(--border-color-strong)',
                    }}
                  >
                    <span
                      className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-transform"
                      style={{
                        left: 2,
                        background: backgroundFlowEnabled ? 'var(--accent-primary)' : 'var(--text-muted)',
                        transform: backgroundFlowEnabled ? 'translate(18px, -50%)' : 'translate(0, -50%)',
                        boxShadow: backgroundFlowEnabled ? '0 0 10px color-mix(in srgb, var(--accent-primary) 38%, transparent)' : 'none',
                      }}
                    />
                  </span>
                </button>
                {customThemes.length > 0 && (
                  <>
                    <div className="my-1.5 border-t" style={{ borderColor: 'var(--border-color)' }} />
                    <div className="px-2 py-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      自定义主题
                    </div>
                    {customThemes.map(t => {
                      const [bg, accent] = customThemeSwatches(t)
                      const selected = t.id === activeCustomId
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setTheme(t.base)
                            saveActiveCustomThemeId(t.id)
                            // 同步把覆写挂到 :root.style, 让菜单没打开 / 调色盘没挂载时也能即时生效
                            applyCustomThemeToRoot(t)
                            setActiveCustomId(t.id)
                            setShowThemeMenu(false)
                          }}
                          className="w-full rounded-md px-2 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                          style={{ background: selected ? 'var(--bg-active)' : undefined }}
                        >
                          <span className="flex h-5 w-8 shrink-0 overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-color-strong)' }}>
                            <span className="flex-1" style={{ background: bg }} />
                            <span className="flex-1" style={{ background: accent }} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[12px] font-semibold leading-4 truncate" style={{ color: 'var(--text-primary)' }}>{t.name}</span>
                            <span className="block truncate text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>
                              基于「{getBaseOption(t.base).label}」· {Object.keys(t.overrides).length} 个覆写
                            </span>
                          </span>
                          {selected ? <Check className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} /> : null}
                        </button>
                      )
                    })}
                  </>
                )}
                <div className="my-1.5 border-t" style={{ borderColor: 'var(--border-color)' }} />
                <button
                  type="button"
                  onClick={() => { setShowThemeMenu(false); setShowPalette(true) }}
                  className="w-full rounded-md px-2 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors flex items-center gap-2"
                  style={{ color: 'var(--text-primary)' }}
                >
                  <Palette className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-semibold leading-4">调色盘</span>
                    <span className="block truncate text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>自由调节主题颜色 · 保存到浏览器</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* 用户菜单 */}
          <div className="relative" data-tour="top-user-menu">
            <button onClick={(e) => { e.stopPropagation(); setShowUserMenu(s => !s) }}
              className="h-8 flex items-center gap-2 pl-1 pr-2 border rounded-lg hover:bg-[var(--bg-card-hover)] transition-colors"
              style={{ borderColor: 'var(--border-color)' }}>
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500/30 to-cyan-500/20 flex items-center justify-center text-blue-300 text-[11px] font-semibold border border-blue-500/20">
                {user?.display_name?.[0]}
              </div>
              {!isMobile && <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>{user?.display_name}</span>}
              {!isMobile && <svg className="w-3 h-3" style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>}
            </button>
            {showUserMenu && (
              <div className="absolute right-0 top-10 z-50 rounded-lg shadow-xl py-1 min-w-[180px]"
                style={{ background: 'var(--menu-bg)', border: '1px solid var(--border-color)' }}
                onClick={e => e.stopPropagation()}>
                {user?.role === 'admin' && (
                  <button onClick={() => { setShowUserMenu(false); window.openAdminOverlay?.() }}
                    className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--bg-hover)] flex items-center gap-2"
                    style={{ color: 'var(--text-primary)' }}>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6m6 0h-6m6 0v-6a2 2 0 012-2h2a2 2 0 012 2v6m-6 0h6" /></svg>
                    管理中心
                  </button>
                )}
                <div className="border-t my-0.5" style={{ borderColor: 'var(--border-color)' }} />
                <button onClick={() => { setShowUserMenu(false); setShowAimuxGuide(true) }}
                  className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--bg-hover)] flex items-center gap-2"
                  style={{ color: 'var(--text-primary)' }}>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                  AIMUX 连接指引
                </button>
                <button onClick={() => { setShowUserMenu(false); setShowDesktopDownload(true) }}
                  className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--bg-hover)] flex items-center gap-2"
                  style={{ color: 'var(--text-primary)' }}>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
                  下载桌面客户端
                </button>
                <button onClick={() => { setShowUserMenu(false); setShowMobileDownload(true) }}
                  className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--bg-hover)] flex items-center gap-2"
                  style={{ color: 'var(--text-primary)' }}>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
                  下载移动端 App
                </button>
                <button onClick={() => { setShowUserMenu(false); setShowChangePw(true) }}
                  className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--bg-hover)] flex items-center gap-2"
                  style={{ color: 'var(--text-primary)' }}>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
                  修改密码
                </button>
                <button onClick={() => { setShowUserMenu(false); toggleTheme() }}
                  className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--bg-hover)] flex items-center gap-2 md:hidden"
                  style={{ color: 'var(--text-primary)' }}>
                  <Palette className="w-3.5 h-3.5" />
                  切换主题
                </button>
                <button onClick={() => { setShowUserMenu(false); logout(); navigate('/') }}
                  className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-red-500/10 flex items-center gap-2"
                  style={{ color: '#ef4444' }}>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                  退出登录
                </button>
              </div>
            )}
          </div>
          {/* 桌面端自绘窗口控制按钮 (Win/Linux; macOS 用系统交通灯) */}
          {IS_DESKTOP && !IS_MAC_PLATFORM && <WindowControls />}
        </div>
      </div>

      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
      {showAimuxGuide && <AimuxGuideModal onClose={() => setShowAimuxGuide(false)} />}
      {showDesktopDownload && <DesktopDownloadModal onClose={() => setShowDesktopDownload(false)} />}
      {showMobileDownload && <MobileDownloadModal onClose={() => setShowMobileDownload(false)} />}
      {showGuideHelp && <GuideHelpModal onClose={() => setShowGuideHelp(false)} />}
      {showPalette && <CustomThemePalette onClose={() => setShowPalette(false)} />}
      {showSearch && (
        <SearchModal onClose={() => setShowSearch(false)} onNavigate={navigate} />
      )}
      {createKind && (
        <GlobalCreateRoot
          kind={createKind}
          ctx={{ projectId: projectParam, issueId: issueParam, researchId: researchParam }}
          onClose={() => setCreateKind(null)}
          onNavigate={navigate}
        />
      )}
      <OverlayPanels />
    </>
  )
}

// =====================================================================
// 全局弹层（Admin）
// 通过 store 上挂载的方法触发；这种"弹层"覆盖在主内容上
// =====================================================================
type OverlayKind = 'admin' | null

// 全局打开 overlay 的函数 (供引导系统等外部触发, 如「重温管理中心」按钮先打开 overlay 再启动引导).
window.openAdminOverlay = () => {
  _setOverlay?.('admin')
  window.dispatchEvent(new CustomEvent('imac:admin-overlay-opened'))
}
let _setOverlay: ((kind: OverlayKind) => void) | null = null
function openOverlay(kind: OverlayKind) { _setOverlay?.(kind) }

function OverlayPanels() {
  const [overlay, setOverlay] = useState<OverlayKind>(null)
  useEffect(() => {
    _setOverlay = setOverlay
    return () => { _setOverlay = null }
  }, [])
  if (!overlay) return null
  return (
    <div className="fixed inset-0 z-40 flex" style={{ background: 'var(--bg-secondary)' }}>
      {overlay === 'admin' && <AdminPanel onClose={() => setOverlay(null)} />}
    </div>
  )
}

// =====================================================================
// 简易"加载中"占位
// =====================================================================
export function Loading({ text = '加载中...' }: { text?: string } = {}) {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
      <div className="text-[13px]">{text}</div>
    </div>
  )
}
