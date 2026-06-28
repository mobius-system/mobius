import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Building2,
  Check,
  Clock,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  Package,
  Plus,
  Power,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  UserPlus,
  Users as UsersIcon,
} from 'lucide-react'
import { api, useStore } from '../store'
import {
  TEXT_REDACTION_ENABLED_EVENT,
  TEXT_REDACTION_ENABLED_STORAGE_KEY,
  TEXT_REDACTION_RULES_EVENT,
  TEXT_REDACTION_STORAGE_KEY,
  createTextRedactionRuleId,
  exportTextRedactionRulesCsv,
  exportTextRedactionRulesJson,
  mergeTextRedactionRules,
  parseTextRedactionImport,
  pushTextRedactionRulesToBackend,
  readTextRedactionEnabled,
  readTextRedactionRules,
  syncTextRedactionGlobalOnStartup,
  writeTextRedactionEnabled,
  writeTextRedactionRules,
  type TextRedactionRule,
} from '../services/text-redaction'
import { ToggleSwitch } from './toggle-switch'

type AdminTmuxContext = {
  session_id: string
  session_name: string
  session_status: string
  db_agent_status: string
  model: string
  use_proxy: number | boolean
  scope_type: 'issue' | 'research'
  user: { id: string; display_name: string } | null
  project: { id: string; name: string; bind_path?: string | null } | null
  subject: { type: 'issue' | 'research'; id: string | null; title: string; role?: string | null } | null
  issue_id?: string | null
  research_id?: string | null
  research_role?: string | null
  claude_session_id?: string | null
  created_at: string
  last_active: string
}

type AdminTmuxWindow = {
  backend_key: 'codex' | 'claude_code'
  backend_name: string
  backend_label: string
  session_id: string
  tmux_window_name: string
  tmux_window_index: number | null
  pid: number | null
  pane_dead: boolean
  pane_current_command: string | null
  last_activity_ms: number | null
  last_activity_at: string | null
  agent_session_id: string | null
  state: 'busy' | 'idle' | 'terminated' | 'closed'
  flag_state: 'success' | 'failed' | 'running'
  running_flag_exists: boolean
  failed_flag_exists: boolean
  failed_reason: string | null
  tmux_open: boolean
  tui_agent_pid_exists: boolean
  tui_agent_alive: boolean
  alive: boolean
  working: boolean
  failed: boolean
  job_accomplished: boolean | null
  closable: boolean
  runtime_known: boolean
  cwd: string | null
  flag_root: string | null
  jsonl_path: string | null
  question_count_5h: number
  context: AdminTmuxContext | null
}

type AdminTmuxBackend = {
  key: 'codex' | 'claude_code'
  backend_name: string
  label: string
  available: boolean
  error: string | null
  windows: AdminTmuxWindow[]
  window_count: number
  active_window_count: number
  working_count: number
  closed_count: number
}

type AdminTmuxPayload = {
  window_hours: number
  since: string
  question_count: number
  questions_by_backend: { codex: number; claude_code: number }
  questions_2min: number
  questions_by_backend_2min: { codex: number; claude_code: number }
  window_count: number
  active_tmux_window_count: number
  active_windows_by_backend: { codex: number; claude_code: number }
  working_window_count: number
  closed_window_count: number
  backends: {
    codex: AdminTmuxBackend
    claude_code: AdminTmuxBackend
  }
}

function formatAbsolute(value?: string | null) {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

function formatRelative(value?: string | null) {
  if (!value) return '-'
  const t = new Date(value).getTime()
  if (!Number.isFinite(t)) return '-'
  const diff = Math.max(0, Date.now() - t)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function compactId(value?: string | null) {
  if (!value) return '-'
  if (value.length <= 18) return value
  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

function StatusPill({ win }: { win: AdminTmuxWindow }) {
  const processMap = {
    busy: {
      label: '执行中',
      english: 'Busy',
      hint: 'tmux open + tui agent pid exists + isAlive + isWorking',
    },
    idle: {
      label: '空闲中',
      english: 'Idle',
      hint: 'tmux open + tui agent pid exists + isAlive + not isWorking',
    },
    terminated: {
      label: '进程终止',
      english: 'Terminated',
      hint: 'tmux open + tui agent pid exists + not isAlive',
    },
    closed: {
      label: '已关闭',
      english: 'Closed',
      hint: 'tmux not open',
    },
  }[win.state]
  const flagMap = {
    success: {
      label: '成功',
      hint: 'running.flag 不存在 + failed.flag 不存在',
      cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
    },
    failed: {
      label: '失败',
      hint: 'failed.flag 存在',
      cls: 'bg-red-500/10 text-red-400 border-red-500/25',
    },
    running: {
      label: '运行',
      hint: 'running.flag 存在',
      cls: 'bg-amber-500/10 text-amber-400 border-amber-500/25',
    },
  }[win.flag_state || 'success']
  const label = `${flagMap.label}-${processMap.label}`
  const hint = `${flagMap.hint}; ${processMap.hint}`
  return (
    <span
      title={hint}
      aria-label={`${label}: ${hint}`}
      className={`inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium ${flagMap.cls}`}
    >
      {win.state === 'busy' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
      {label}
      <span className="text-[10px] opacity-70">({processMap.english})</span>
    </span>
  )
}

function StatTile({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-2xl font-semibold leading-none" style={{ color: 'var(--text-primary)' }}>{value}</div>
      {sub && <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  )
}

function EmptyRows({ label }: { label: string }) {
  return (
    <div className="flex h-28 items-center justify-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
      {label}
    </div>
  )
}

type AdminUserStats = {
  session_count?: number
  task_count?: number
  active_count?: number
  completed_count?: number
  archived_count?: number
  total_messages?: number
  prompt_length_total?: number
  prompt_length_count?: number
  prompt_length_avg?: number
  last_active?: string | null
}

type AdminUserRow = {
  id: string
  display_name: string
  role: 'admin' | 'user' | string
  work_dir?: string
  group_id?: string | null
  group_name?: string | null
  group_description?: string | null
  created_at?: string
  deleted_at?: string | null
  stats?: AdminUserStats
}

type AdminUserGroup = {
  id: string
  name: string
  description?: string
  created_at?: string
  updated_at?: string
  active_user_count?: number
  user_count?: number
  is_default?: boolean
}

type EmployeeFormState = {
  id: string
  display_name: string
  password: string
  role: 'user' | 'admin'
  group_id: string
  work_dir: string
}

function toCount(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function formatPromptLength(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '0'
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
}

function parseBulkEmployees(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const commaMode = line.includes(',')
      const parts = commaMode
        ? line.split(',').map((p) => p.trim())
        : line.split(/\s+/).map((p) => p.trim())
      const [id = '', password = '', ...rest] = parts
      const tail = rest.filter(Boolean)
      let role: 'user' | 'admin' = 'user'
      if (tail[0] === 'admin' || tail[0] === 'user') role = tail.shift() as 'user' | 'admin'
      else if (tail[tail.length - 1] === 'admin' || tail[tail.length - 1] === 'user') role = tail.pop() as 'user' | 'admin'
      const workDir = tail.length && tail[tail.length - 1].startsWith('/') ? tail.pop() || '' : ''
      let groupName = ''
      const explicitGroupIndex = tail.findIndex((p) => p.startsWith('group=') || p.startsWith('群组='))
      if (explicitGroupIndex >= 0) {
        groupName = tail[explicitGroupIndex].slice(tail[explicitGroupIndex].indexOf('=') + 1).trim()
        tail.splice(explicitGroupIndex, 1)
      } else if (tail.length >= 2) {
        groupName = tail.pop() || ''
      }
      return {
        id,
        password,
        role,
        display_name: tail.join(commaMode ? ',' : ' '),
        group_name: groupName,
        work_dir: workDir,
      }
    })
}

function AdminUsersPanel() {
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [groups, setGroups] = useState<AdminUserGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState<EmployeeFormState>({ id: '', display_name: '', password: '', role: 'user', group_id: '', work_dir: '' })
  const [bulkText, setBulkText] = useState('')
  const [newGroupName, setNewGroupName] = useState('')
  const [groupDrafts, setGroupDrafts] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [bulkSubmitting, setBulkSubmitting] = useState(false)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [savingGroupId, setSavingGroupId] = useState<string | null>(null)
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null)
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const refresh = async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const [userData, groupData] = await Promise.all([
        api('/api/admin/users'),
        api('/api/admin/user-groups'),
      ])
      setUsers(Array.isArray(userData) ? userData : [])
      setGroups(Array.isArray(groupData) ? groupData : [])
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      if (!quiet) setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const timer = window.setInterval(() => refresh(true), 10000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    setGroupDrafts((prev) => {
      const next: Record<string, string> = {}
      for (const g of groups) next[g.id] = prev[g.id] ?? g.name
      return next
    })
  }, [groups])

  const activeUsers = useMemo(() => users.filter((u) => !u.deleted_at), [users])
  const defaultGroupId = useMemo(() => groups.find((g) => g.is_default)?.id || groups[0]?.id || '', [groups])

  useEffect(() => {
    if (!form.group_id && defaultGroupId) setForm((f) => ({ ...f, group_id: defaultGroupId }))
  }, [defaultGroupId, form.group_id])

  const chartRows = useMemo(() => activeUsers
    .map((u) => {
      const stats = u.stats || {}
      const sessionCount = toCount(stats.session_count ?? stats.task_count)
      return {
        id: u.id,
        name: u.display_name || u.id,
        role: u.role,
        groupName: u.group_name || '默认组',
        sessionCount,
        activeCount: toCount(stats.active_count),
        completedCount: toCount(stats.completed_count),
        archivedCount: toCount(stats.archived_count),
        totalMessages: toCount(stats.total_messages),
        promptLengthTotal: toCount(stats.prompt_length_total),
        promptLengthCount: toCount(stats.prompt_length_count),
        promptLengthAvg: toCount(stats.prompt_length_avg),
        lastActive: stats.last_active || null,
      }
    })
    .sort((a, b) => {
      if (b.sessionCount !== a.sessionCount) return b.sessionCount - a.sessionCount
      return a.name.localeCompare(b.name)
    }), [activeUsers])

  const maxCount = Math.max(1, ...chartRows.map((row) => row.sessionCount))
  const totalSessions = chartRows.reduce((sum, row) => sum + row.sessionCount, 0)
  const activeSessions = chartRows.reduce((sum, row) => sum + row.activeCount, 0)
  const promptLengthTotal = chartRows.reduce((sum, row) => sum + row.promptLengthTotal, 0)
  const promptLengthCount = chartRows.reduce((sum, row) => sum + row.promptLengthCount, 0)
  const averagePromptLength = promptLengthCount > 0 ? promptLengthTotal / promptLengthCount : 0
  const hasRows = chartRows.length > 0
  const totalEmployees = activeUsers.length
  const adminCount = activeUsers.filter((u) => u.role === 'admin').length
  const totalGroups = groups.length

  const fieldStyle = {
    background: 'var(--input-bg)',
    borderColor: 'var(--input-border)',
    color: 'var(--text-primary)',
  }

  const resetForm = () => setForm({ id: '', display_name: '', password: '', role: 'user', group_id: defaultGroupId, work_dir: '' })

  const submitCreate = async () => {
    setError('')
    setNotice('')
    setSubmitting(true)
    try {
      const data = await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ ...form, group_id: form.group_id || defaultGroupId }),
      })
      resetForm()
      await refresh(true)
      const warning = data?.user?.warning ? ` · ${data.user.warning}` : ''
      const groupLabel = data?.user?.group_name ? ` · ${data.user.group_name}` : ''
      setNotice(`${data?.user?.status === 'restored' ? '已恢复' : '已添加'}员工 ${data?.user?.id || form.id}${groupLabel}${warning}`)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const submitBulk = async () => {
    setError('')
    setNotice('')
    const employees = parseBulkEmployees(bulkText)
    if (!employees.length) {
      setError('请先输入批量员工列表')
      return
    }
    setBulkSubmitting(true)
    try {
      const data = await api('/api/admin/users/bulk', {
        method: 'POST',
        body: JSON.stringify({ employees }),
      })
      await refresh(true)
      if (!data?.failed?.length) setBulkText('')
      const warning = [...(data?.created || []), ...(data?.restored || [])].find((u: any) => u.warning)?.warning
      const summary = `批量完成: 新增 ${data?.counts?.created || 0}, 恢复 ${data?.counts?.restored || 0}, 失败 ${data?.counts?.failed || 0}`
      setNotice(warning ? `${summary} · ${warning}` : summary)
      if (data?.failed?.length) {
        const first = data.failed.slice(0, 3).map((f: any) => `第 ${Number(f.index) + 1} 行: ${f.error}`).join('; ')
        setError(first)
      }
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setBulkSubmitting(false)
    }
  }

  const createGroup = async () => {
    const name = newGroupName.trim()
    if (!name) {
      setError('请输入群组名称')
      return
    }
    setError('')
    setNotice('')
    setCreatingGroup(true)
    try {
      const data = await api('/api/admin/user-groups', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      setNewGroupName('')
      await refresh(true)
      setNotice(`已新增群组 ${data?.group?.name || name}`)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setCreatingGroup(false)
    }
  }

  const saveGroup = async (group: AdminUserGroup) => {
    const name = (groupDrafts[group.id] || '').trim()
    if (!name) {
      setError('群组名称不能为空')
      return
    }
    if (name === group.name) return
    setError('')
    setNotice('')
    setSavingGroupId(group.id)
    try {
      const data = await api(`/api/admin/user-groups/${encodeURIComponent(group.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      })
      setGroupDrafts((prev) => ({ ...prev, [group.id]: data?.group?.name || name }))
      await refresh(true)
      setNotice(`已更新群组 ${data?.group?.name || name}`)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSavingGroupId(null)
    }
  }

  const deleteGroup = async (group: AdminUserGroup) => {
    const activeCount = toCount(group.active_user_count)
    if (group.is_default || activeCount > 0) return
    const ok = window.confirm(`删除空群组 ${group.name}？`)
    if (!ok) return
    setError('')
    setNotice('')
    setDeletingGroupId(group.id)
    try {
      await api(`/api/admin/user-groups/${encodeURIComponent(group.id)}`, { method: 'DELETE' })
      setGroupDrafts((prev) => {
        const next = { ...prev }
        delete next[group.id]
        return next
      })
      await refresh(true)
      setNotice(`已删除群组 ${group.name}`)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setDeletingGroupId(null)
    }
  }

  const updateEmployeeGroup = async (row: AdminUserRow, groupId: string) => {
    if (!groupId || groupId === row.group_id) return
    const nextGroup = groups.find((g) => g.id === groupId)
    setError('')
    setNotice('')
    setUpdatingUserId(row.id)
    try {
      await api(`/api/admin/users/${encodeURIComponent(row.id)}/group`, {
        method: 'PATCH',
        body: JSON.stringify({ group_id: groupId }),
      })
      setUsers((prev) => prev.map((u) => u.id === row.id
        ? { ...u, group_id: groupId, group_name: nextGroup?.name || u.group_name }
        : u))
      await refresh(true)
      setNotice(`已将 ${row.display_name || row.id} 调整到 ${nextGroup?.name || '新群组'}`)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setUpdatingUserId(null)
    }
  }

  const deleteEmployee = async (row: AdminUserRow) => {
    const ok = window.confirm(`删除员工账号 ${row.display_name || row.id} (${row.id})？删除后该账号不能登录，历史数据仍保留。`)
    if (!ok) return
    setError('')
    setNotice('')
    setDeletingId(row.id)
    try {
      await api(`/api/admin/users/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      await refresh(true)
      setNotice(`已删除员工 ${row.id}`)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              <UsersIcon className="h-3.5 w-3.5 text-cyan-400" />
              用户管理
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span>员工 {totalEmployees}</span>
              <span>管理员 {adminCount}</span>
              <span>群组 {totalGroups}</span>
              <span>Session {totalSessions}</span>
              <span>活跃 {activeSessions}</span>
              <span>平均提示词 {formatPromptLength(averagePromptLength)} 字</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            title="刷新用户和群组"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}

        {notice && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-400">
            <UserPlus className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span className="break-all">{notice}</span>
          </div>
        )}

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <StatTile icon={<UsersIcon className="h-4 w-4 text-cyan-400" />} label="启用员工" value={totalEmployees} sub={`管理员 ${adminCount}`} />
          <StatTile icon={<Building2 className="h-4 w-4 text-emerald-400" />} label="群组" value={totalGroups} sub="单群组组织分类" />
          <StatTile icon={<BarChart3 className="h-4 w-4 text-sky-400" />} label="Session" value={totalSessions} sub={`活跃 ${activeSessions}`} />
          <StatTile icon={<FileText className="h-4 w-4 text-amber-400" />} label="平均提示词" value={formatPromptLength(averagePromptLength)} sub="任务单 + 执行会话字数" />
          <StatTile icon={<MessageSquare className="h-4 w-4 text-violet-400" />} label="消息" value={chartRows.reduce((sum, row) => sum + row.totalMessages, 0)} sub="全部员工累计" />
        </div>

        {!hasRows ? (
          <div className="mt-4 flex h-24 items-center justify-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {loading ? '加载中...' : '暂无用户'}
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <div className="min-w-[680px] space-y-2">
              {chartRows.map((row) => {
                const width = row.sessionCount > 0
                  ? `${Math.min(100, Math.max(2, (row.sessionCount / maxCount) * 100))}%`
                  : '0%'
                const accent = row.role === 'admin' ? '#f59e0b' : '#38bdf8'
                return (
                  <div key={row.id} className="grid grid-cols-[minmax(150px,220px)_1fr_88px] items-center gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium" title={`${row.name} (${row.id})`} style={{ color: 'var(--text-primary)' }}>
                        {row.name}
                      </div>
                      <div className="truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {row.id} · {row.groupName} · {row.role === 'admin' ? '管理员' : '成员'}
                      </div>
                    </div>
                    <div
                      className="relative h-9 overflow-hidden rounded-md border"
                      title={`总计 ${row.sessionCount} · 活跃 ${row.activeCount} · 完成 ${row.completedCount} · 归档 ${row.archivedCount} · 平均提示词 ${formatPromptLength(row.promptLengthAvg)} 字`}
                      style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)' }}
                    >
                      <div
                        className="absolute inset-y-0 left-0 rounded-md"
                        style={{
                          width,
                          background: `linear-gradient(90deg, ${accent}, rgba(16,185,129,0.72))`,
                          opacity: row.sessionCount > 0 ? 0.9 : 0,
                        }}
                      />
                      <div className="relative z-10 flex h-full items-center justify-between gap-2 px-2.5 text-[11px]">
                        <span className="truncate" style={{ color: row.sessionCount > 0 ? '#f8fafc' : 'var(--text-muted)' }}>
                          活跃 {row.activeCount} · 完成 {row.completedCount} · 归档 {row.archivedCount}
                        </span>
                        <span className="flex-shrink-0 tabular-nums" style={{ color: row.sessionCount > 0 ? '#f8fafc' : 'var(--text-muted)' }}>
                          消息 {row.totalMessages}
                        </span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="tabular-nums text-[18px] font-semibold leading-none" style={{ color: 'var(--text-primary)' }}>
                        {row.sessionCount}
                      </div>
                      <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {formatRelative(row.lastActive)}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-1.5 text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              <Building2 className="h-3.5 w-3.5 text-emerald-400" />
              群组管理
            </h3>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              群组用于员工组织分类；同组项目权限会按这里的归属判断。
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={newGroupName}
            onChange={(e) => { setNewGroupName(e.target.value); setError(''); setNotice('') }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !creatingGroup) createGroup() }}
            placeholder="新群组名称"
            className="h-9 min-w-[220px] rounded-md border px-3 text-[12px] outline-none focus:border-blue-500/50"
            style={fieldStyle}
          />
          <button
            type="button"
            onClick={createGroup}
            disabled={creatingGroup}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            {creatingGroup ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            新增群组
          </button>
        </div>

        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          {groups.map((g) => {
            const activeCount = toCount(g.active_user_count)
            const saving = savingGroupId === g.id
            const deleting = deletingGroupId === g.id
            const draft = groupDrafts[g.id] ?? g.name
            const changed = draft.trim() !== g.name
            return (
              <div key={g.id} className="flex items-center gap-2 rounded-lg border px-3 py-2" style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)' }}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <input
                      value={draft}
                      onChange={(e) => { setGroupDrafts((prev) => ({ ...prev, [g.id]: e.target.value })); setError(''); setNotice('') }}
                      className="h-8 min-w-0 flex-1 rounded-md border px-2 text-[12px] outline-none focus:border-blue-500/50"
                      style={fieldStyle}
                    />
                    {g.is_default && (
                      <span className="flex-shrink-0 rounded-md border border-cyan-500/25 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-400">默认</span>
                    )}
                  </div>
                  <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    启用员工 {activeCount} · 全部记录 {toCount(g.user_count)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => saveGroup(g)}
                  disabled={saving || !changed}
                  title="保存群组名称"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => deleteGroup(g)}
                  disabled={deleting || !!g.is_default || activeCount > 0}
                  title={g.is_default ? '默认组不能删除' : activeCount > 0 ? '只能删除空群组' : '删除空群组'}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-red-500/20 text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-35"
                >
                  {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </div>
            )
          })}
        </div>
      </section>

      <section className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-1.5 text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              <UserPlus className="h-3.5 w-3.5 text-emerald-400" />
              员工账号
            </h3>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              删除账号会立即禁止登录；历史项目、Session 与消息保留。
            </p>
          </div>
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(360px,0.9fr)_minmax(420px,1.1fr)]">
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                value={form.id}
                onChange={(e) => { setForm((f) => ({ ...f, id: e.target.value })); setError(''); setNotice('') }}
                placeholder="员工 ID"
                className="h-9 rounded-md border px-3 text-[12px] outline-none focus:border-blue-500/50"
                style={fieldStyle}
              />
              <input
                value={form.display_name}
                onChange={(e) => { setForm((f) => ({ ...f, display_name: e.target.value })); setError(''); setNotice('') }}
                placeholder="显示名称"
                className="h-9 rounded-md border px-3 text-[12px] outline-none focus:border-blue-500/50"
                style={fieldStyle}
              />
              <input
                type="password"
                value={form.password}
                onChange={(e) => { setForm((f) => ({ ...f, password: e.target.value })); setError(''); setNotice('') }}
                placeholder="初始密码，至少 6 位"
                onKeyDown={(e) => { if (e.key === 'Enter' && !submitting) submitCreate() }}
                className="h-9 rounded-md border px-3 text-[12px] outline-none focus:border-blue-500/50"
                style={fieldStyle}
              />
              <select
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value === 'admin' ? 'admin' : 'user' }))}
                className="h-9 rounded-md border px-3 text-[12px] outline-none focus:border-blue-500/50"
                style={fieldStyle}
              >
                <option value="user">成员</option>
                <option value="admin">管理员</option>
              </select>
              <select
                value={form.group_id || defaultGroupId}
                onChange={(e) => setForm((f) => ({ ...f, group_id: e.target.value }))}
                className="h-9 rounded-md border px-3 text-[12px] outline-none focus:border-blue-500/50"
                style={fieldStyle}
              >
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <input
                value={form.work_dir}
                onChange={(e) => { setForm((f) => ({ ...f, work_dir: e.target.value })); setError(''); setNotice('') }}
                placeholder="工作目录（选填，默认 /home/员工ID/cc-workspace）"
                className="h-9 rounded-md border px-3 text-[12px] outline-none focus:border-blue-500/50"
                style={fieldStyle}
              />
            </div>
            <button
              type="button"
              onClick={submitCreate}
              disabled={submitting}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-emerald-500 px-3 text-[12px] font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              添加员工
            </button>
          </div>

          <div className="space-y-2">
            <textarea
              value={bulkText}
              onChange={(e) => { setBulkText(e.target.value); setError(''); setNotice('') }}
              placeholder={'每行一个员工: ID,密码,角色,显示名称,群组,工作目录\nzhangsan,pass123,user,张三,研发组\nlisi,pass123,user,李四,运营组,/home/lisi/cc-workspace'}
              className="min-h-28 w-full resize-y rounded-md border px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus:border-blue-500/50"
              style={fieldStyle}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                支持逗号或空白分隔；群组不存在时会自动创建。
              </span>
              <button
                type="button"
                onClick={submitBulk}
                disabled={bulkSubmitting}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
              >
                {bulkSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                批量增加
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-[1080px] w-full border-separate border-spacing-y-1 text-left text-[12px]">
            <thead style={{ color: 'var(--text-muted)' }}>
              <tr>
                <th className="px-2 py-1 font-medium">员工</th>
                <th className="px-2 py-1 font-medium">群组</th>
                <th className="px-2 py-1 font-medium">角色</th>
                <th className="px-2 py-1 font-medium">Session</th>
                <th className="px-2 py-1 font-medium">平均提示词</th>
                <th className="px-2 py-1 font-medium">工作目录</th>
                <th className="px-2 py-1 font-medium">创建时间</th>
                <th className="px-2 py-1 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {activeUsers.map((u) => {
                const stats = u.stats || {}
                const deleting = deletingId === u.id
                const updatingGroup = updatingUserId === u.id
                return (
                  <tr key={u.id} className="rounded-md" style={{ background: 'var(--input-bg)' }}>
                    <td className="max-w-[180px] rounded-l-md px-2 py-2">
                      <div className="truncate font-medium" style={{ color: 'var(--text-primary)' }}>{u.display_name || u.id}</div>
                      <div className="truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{u.id}</div>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1.5">
                        <select
                          value={u.group_id || defaultGroupId}
                          disabled={updatingGroup}
                          onChange={(e) => updateEmployeeGroup(u, e.target.value)}
                          className="h-8 min-w-[120px] rounded-md border px-2 text-[11px] outline-none focus:border-blue-500/50 disabled:opacity-60"
                          style={fieldStyle}
                        >
                          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                        </select>
                        {updatingGroup && <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--text-muted)' }} />}
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] ${u.role === 'admin' ? 'border-amber-500/25 bg-amber-500/10 text-amber-400' : 'border-cyan-500/25 bg-cyan-500/10 text-cyan-400'}`}>
                        {u.role === 'admin' ? '管理员' : '成员'}
                      </span>
                    </td>
                    <td className="px-2 py-2 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                      {toCount(stats.session_count ?? stats.task_count)}
                    </td>
                    <td className="px-2 py-2 tabular-nums" style={{ color: 'var(--text-secondary)' }} title="任务单描述 + 任务单标题 + 执行会话目的 + 执行会话名称">
                      {formatPromptLength(stats.prompt_length_avg)} 字
                    </td>
                    <td className="max-w-[250px] px-2 py-2">
                      <div className="truncate font-mono text-[11px]" title={u.work_dir || ''} style={{ color: 'var(--text-muted)' }}>
                        {u.work_dir || '-'}
                      </div>
                    </td>
                    <td className="px-2 py-2" style={{ color: 'var(--text-secondary)' }}>{formatAbsolute(u.created_at)}</td>
                    <td className="rounded-r-md px-2 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => deleteEmployee(u)}
                        disabled={deleting}
                        title="删除员工账号"
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-red-500/20 px-2 text-[11px] text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                      >
                        {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        删除
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function BackendSection({
  backend,
  title,
  accent,
  closingKey,
  showClosedWindows,
  onCloseWindow,
}: {
  backend?: AdminTmuxBackend
  title: string
  accent: string
  closingKey: string | null
  showClosedWindows: boolean
  onCloseWindow: (backendKey: 'codex' | 'claude_code', sessionId: string) => void
}) {
  const allWindows = backend?.windows || []
  const windows = showClosedWindows ? allWindows : allWindows.filter((win) => win.state !== 'closed')
  const hiddenClosedCount = showClosedWindows ? 0 : allWindows.length - windows.length
  return (
    <section className="overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
      <div className="flex min-h-12 items-center justify-between border-b border-[var(--border-color)] px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-4 w-4 flex-shrink-0" style={{ color: accent }} />
          <h3 className="truncate text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
          <span className="rounded-md border border-[var(--border-color)] px-2 py-0.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {backend?.backend_name || '-'}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          <span>{backend?.active_window_count ?? 0} 活跃</span>
          <span>{backend?.window_count ?? 0} Open</span>
          <span>{backend?.working_count ?? 0} Busy</span>
          <span>{backend?.closed_count ?? 0} Closed</span>
          {hiddenClosedCount > 0 && <span>{hiddenClosedCount} 已隐藏</span>}
        </div>
      </div>

      {backend?.error && (
        <div className="flex items-start gap-2 border-b border-red-500/20 bg-red-500/5 px-4 py-3 text-[12px] text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="break-all">{backend.error}</span>
        </div>
      )}

      {!backend ? (
        <EmptyRows label="加载中" />
      ) : windows.length === 0 ? (
        <EmptyRows label={hiddenClosedCount > 0 ? `已隐藏 ${hiddenClosedCount} 个 Closed window` : '当前没有 tmux window'} />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-[1040px] w-full border-collapse">
            <thead>
              <tr className="border-b border-[var(--border-color)] bg-[var(--bg-primary)]">
                {['状态', 'Tmux Window', 'Session', '所属', '运行时', '活动', '5小时提问', '操作'].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {windows.map((win) => {
                const ctx = win.context
                const subject = ctx?.subject
                const closeKey = `${win.backend_key}:${win.session_id}`
                const closing = closingKey === closeKey
                return (
                  <tr key={`${win.backend_key}:${win.session_id}`} className="border-b border-[var(--border-color)] last:border-b-0 hover:bg-[var(--bg-hover)]">
                    <td className="px-4 py-3 align-top"><StatusPill win={win} /></td>
                    <td className="px-4 py-3 align-top">
                      <div className="max-w-[170px] truncate text-[13px] font-medium" title={win.tmux_window_name} style={{ color: 'var(--text-primary)' }}>
                        {win.tmux_window_name}
                      </div>
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        index {win.tmux_window_index ?? '-'}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      {ctx ? (
                        <>
                          <div className="max-w-[220px] truncate text-[13px] font-medium" title={ctx.session_name} style={{ color: 'var(--text-primary)' }}>
                            {ctx.session_name}
                          </div>
                          <div className="mt-1 flex max-w-[220px] items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            <span className="truncate" title={ctx.session_id}>{compactId(ctx.session_id)}</span>
                            <span>·</span>
                            <span>{ctx.user?.display_name || '-'}</span>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="max-w-[220px] truncate text-[13px] font-medium" title={win.session_id} style={{ color: 'var(--text-primary)' }}>
                            {compactId(win.session_id)}
                          </div>
                          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>无 DB 记录</div>
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="max-w-[230px] truncate text-[13px]" title={ctx?.project?.name || ''} style={{ color: 'var(--text-primary)' }}>
                        {ctx?.project?.name || '-'}
                      </div>
                      <div className="mt-1 max-w-[230px] truncate text-[11px]" title={subject?.title || ''} style={{ color: 'var(--text-muted)' }}>
                        {subject ? `${subject.type === 'research' ? 'Research' : 'Issue'}: ${subject.title || subject.id || '-'}` : '-'}
                      </div>
                      {subject?.role && (
                        <div className="mt-1 text-[11px] text-emerald-400">{subject.role}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
                        {win.tmux_open ? `PID ${win.pid || '-'}` : 'tmux 已关闭'}
                      </div>
                      <div className="mt-1 max-w-[180px] truncate text-[11px]" title={win.pane_current_command || ''} style={{ color: 'var(--text-muted)' }}>
                        cmd {win.pane_current_command || '-'}
                      </div>
                      <div className="mt-1 max-w-[180px] truncate text-[11px]" title={win.agent_session_id || ''} style={{ color: 'var(--text-muted)' }}>
                        agent {compactId(win.agent_session_id)}
                      </div>
                      <div className="mt-1 text-[11px]" style={{ color: win.tui_agent_alive ? '#34d399' : 'var(--text-muted)' }}>
                        {win.tui_agent_alive ? 'tui agent isAlive' : win.tmux_open ? 'tui agent not isAlive' : 'tmux not open'}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{formatRelative(win.last_activity_at)}</div>
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>{formatAbsolute(win.last_activity_at)}</div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className="inline-flex h-7 min-w-10 items-center justify-center rounded-md border border-[var(--border-color)] px-2 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {win.question_count_5h}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      {win.closable ? (
                        <button
                          type="button"
                          title="关闭 tmux window"
                          disabled={closing}
                          onClick={() => onCloseWindow(win.backend_key, win.session_id)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-red-500/20 text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {closing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
                        </button>
                      ) : (
                        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>-</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

type ModelPromptLimitRow = {
  key: string
  value?: string
  model?: string
  label: string
  title: string
  sub: string
  backend: string
  imported?: boolean
  use_proxy?: number | boolean
  capture_stream?: number | boolean
  config_path?: string
  limits: ModelPromptLimitConfig
}
type ModelPromptLimitConfig = {
  allUsers5h: number | null
  allUsers5m: number | null
  perUser5h: number | null
  perUser5m: number | null
  tmuxWindows: number
}
type ModelPromptLimitsPayload = {
  window_hours: number
  window_minutes: number
  global_default_model: string | null
  models: ModelPromptLimitRow[]
}
type AdminAssistantCallbacksPayload = {
  enabled: boolean
}

function ModelPromptLimitsCard() {
  const [payload, setPayload] = useState<ModelPromptLimitsPayload | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [savingProxyKey, setSavingProxyKey] = useState<string | null>(null)
  const [savingCaptureKey, setSavingCaptureKey] = useState<string | null>(null)
  const [error, setError] = useState('')

  const fieldKey = (modelKey: string, field: keyof ModelPromptLimitConfig) => `${modelKey}::${field}`
  const readLimitInput = (row: ModelPromptLimitRow, field: keyof ModelPromptLimitConfig) => inputs[fieldKey(row.key, field)] ?? ''
  const limitFields: Array<{ key: keyof ModelPromptLimitConfig; label: string; placeholder: string; hint: string }> = [
    { key: 'allUsers5h', label: '所有用户 5h', placeholder: '不限', hint: '硬限制' },
    { key: 'allUsers5m', label: '所有用户 5m', placeholder: '不限', hint: '硬限制' },
    { key: 'perUser5h', label: '单用户 5h', placeholder: '不限', hint: '硬限制' },
    { key: 'perUser5m', label: '单用户 5m', placeholder: '不限', hint: '硬限制' },
    { key: 'tmuxWindows', label: 'tmux 窗口', placeholder: '12', hint: '软提醒' },
  ]

  const syncInputs = (next: ModelPromptLimitsPayload) => {
    const entries: Array<[string, string]> = []
    for (const row of next.models) {
      const limits = row.limits || { allUsers5h: null, allUsers5m: null, perUser5h: null, perUser5m: null, tmuxWindows: 12 }
      entries.push([fieldKey(row.key, 'allUsers5h'), limits.allUsers5h == null ? '' : String(limits.allUsers5h)])
      entries.push([fieldKey(row.key, 'allUsers5m'), limits.allUsers5m == null ? '' : String(limits.allUsers5m)])
      entries.push([fieldKey(row.key, 'perUser5h'), limits.perUser5h == null ? '' : String(limits.perUser5h)])
      entries.push([fieldKey(row.key, 'perUser5m'), limits.perUser5m == null ? '' : String(limits.perUser5m)])
      entries.push([fieldKey(row.key, 'tmuxWindows'), limits.tmuxWindows == null ? '12' : String(limits.tmuxWindows)])
    }
    setInputs(Object.fromEntries(entries))
  }

  const load = async () => {
    setLoading(true)
    try {
      const next = await api('/api/admin/settings/model-prompt-limits') as ModelPromptLimitsPayload
      setPayload(next)
      syncInputs(next)
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const parseHardLimit = (raw: string, label: string): number | null => {
    const value = raw.trim()
    if (value === '') return null
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`${label}必须是非负整数, 留空表示不限`)
    }
    return Math.floor(n)
  }

  const parseSoftTmuxLimit = (raw: string): number => {
    const value = raw.trim()
    if (value === '') return 12
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) {
      throw new Error('tmux 窗口数量限制必须是非负整数')
    }
    return Math.floor(n)
  }

  const save = async (row: ModelPromptLimitRow, override?: Partial<Record<keyof ModelPromptLimitConfig, string>>) => {
    let limits: ModelPromptLimitConfig
    try {
      const raw = (field: keyof ModelPromptLimitConfig) => override?.[field] ?? readLimitInput(row, field)
      limits = {
        allUsers5h: parseHardLimit(raw('allUsers5h'), '所有用户 5 小时提问次数限制'),
        allUsers5m: parseHardLimit(raw('allUsers5m'), '所有用户 5 分钟提问次数限制'),
        perUser5h: parseHardLimit(raw('perUser5h'), '单个用户 5 小时提问次数限制'),
        perUser5m: parseHardLimit(raw('perUser5m'), '单个用户 5 分钟提问次数限制'),
        tmuxWindows: parseSoftTmuxLimit(raw('tmuxWindows')),
      }
    } catch (e: any) {
      setError(e?.message || String(e))
      return
    }
    setSavingKey(row.key)
    try {
      const next = await api('/api/admin/settings/model-prompt-limits', {
        method: 'PUT',
        body: JSON.stringify({ model: row.key, limits }),
      }) as ModelPromptLimitsPayload
      setPayload(next)
      syncInputs(next)
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSavingKey(null)
    }
  }

  const setDefaults = async (row: ModelPromptLimitRow) => {
    const defaults = { allUsers5h: '', allUsers5m: '', perUser5h: '', perUser5m: '', tmuxWindows: '12' }
    setInputs(prev => ({
      ...prev,
      [fieldKey(row.key, 'allUsers5h')]: '',
      [fieldKey(row.key, 'allUsers5m')]: '',
      [fieldKey(row.key, 'perUser5h')]: '',
      [fieldKey(row.key, 'perUser5m')]: '',
      [fieldKey(row.key, 'tmuxWindows')]: '12',
    }))
    await save(row, defaults)
  }

  const updateLimitInput = (row: ModelPromptLimitRow, field: keyof ModelPromptLimitConfig, value: string) => {
    setInputs(prev => ({ ...prev, [fieldKey(row.key, field)]: value.replace(/[^\d]/g, '') }))
  }

  const hasCustomLimits = (row: ModelPromptLimitRow) => {
    const values = {
      allUsers5h: readLimitInput(row, 'allUsers5h').trim(),
      allUsers5m: readLimitInput(row, 'allUsers5m').trim(),
      perUser5h: readLimitInput(row, 'perUser5h').trim(),
      perUser5m: readLimitInput(row, 'perUser5m').trim(),
      tmuxWindows: readLimitInput(row, 'tmuxWindows').trim(),
    }
    return !!values.allUsers5h || !!values.allUsers5m || !!values.perUser5h || !!values.perUser5m || (values.tmuxWindows !== '' && values.tmuxWindows !== '12')
  }

  const toggleProxy = async (row: ModelPromptLimitRow, nextUseProxy: boolean) => {
    setSavingProxyKey(row.key)
    try {
      const next = await api('/api/admin/settings/model-prompt-limits', {
        method: 'PUT',
        body: JSON.stringify({ model: row.key, useProxy: nextUseProxy }),
      }) as ModelPromptLimitsPayload
      setPayload(next)
      syncInputs(next)
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSavingProxyKey(null)
    }
  }

  // 黑客帝国数字雨 · 捕获实时输出 (仅 claude code). 开启后该模型请求经 token-proxy 中转,
  // 流式 token 被 /api/token_stream 暴露, matrix-rain 拓展渲染成数字瀑布雨.
  const toggleCapture = async (row: ModelPromptLimitRow, nextCapture: boolean) => {
    setSavingCaptureKey(row.key)
    try {
      const next = await api('/api/admin/settings/model-prompt-limits', {
        method: 'PUT',
        body: JSON.stringify({ model: row.key, captureStream: nextCapture }),
      }) as ModelPromptLimitsPayload
      setPayload(next)
      syncInputs(next)
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSavingCaptureKey(null)
    }
  }

  // 全局默认模型偏好: 新建 Session / 快捷新建 / 小莫 在无项目级默认时回落到此模型.
  // 下拉值 '' = 未设置 (恢复系统内置 codex / 小莫 MiniMax 启发式).
  const [globalDefaultSel, setGlobalDefaultSel] = useState('')
  const [savingGlobal, setSavingGlobal] = useState(false)
  useEffect(() => {
    setGlobalDefaultSel(typeof payload?.global_default_model === 'string' ? payload.global_default_model : '')
  }, [payload?.global_default_model])

  const saveGlobalDefault = async (modelKey: string) => {
    setGlobalDefaultSel(modelKey)
    setSavingGlobal(true)
    try {
      const next = await api('/api/admin/settings/global-default-model', {
        method: 'PUT',
        body: JSON.stringify({ model: modelKey || null }),
      }) as ModelPromptLimitsPayload
      setPayload(next)
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
      setGlobalDefaultSel(typeof payload?.global_default_model === 'string' ? payload.global_default_model : '')
    } finally {
      setSavingGlobal(false)
    }
  }

  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>模型创建限制</h3>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            每个模型 4 个提问硬限制只阻止创建新 Session，不影响已有 Session 继续提问；tmux 窗口数量是软提醒，默认 12。
          </div>
        </div>
        <button type="button" onClick={load} disabled={loading}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-60">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}
      {/* 全局默认模型偏好: 新建 Session / 快捷新建 / 小莫 在无项目级默认时回落到此模型 */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5"
        style={{ borderColor: 'rgba(59,130,246,0.30)', background: 'rgba(59,130,246,0.06)' }}>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>全局默认模型</div>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            新建 Session、快捷新建、小莫助理在「项目未设默认模型」时回落到此模型。留空则恢复系统内置默认（GPT-5.5 / 小莫 MiniMax 启发式）。
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={globalDefaultSel}
            disabled={savingGlobal || loading}
            onChange={e => saveGlobalDefault(e.target.value)}
            className="h-8 max-w-[220px] rounded-md border px-2 text-[12px] disabled:opacity-60"
            style={{ borderColor: 'var(--input-border)', background: 'var(--input-bg)', color: 'var(--text-primary)' }}
          >
            <option value="">未设置（系统默认）</option>
            {(payload?.models || []).map(row => (
              <option key={row.key} value={row.key}>{row.title || row.label}</option>
            ))}
          </select>
          {savingGlobal && <RefreshCw className="h-3.5 w-3.5 animate-spin" style={{ color: 'var(--text-muted)' }} />}
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {(payload?.models || []).map(row => {
          const saving = savingKey === row.key
          const savingProxy = savingProxyKey === row.key
          const savingCapture = savingCaptureKey === row.key
          const configured = hasCustomLimits(row)
          const useProxy = row.use_proxy === true || row.use_proxy === 1
          const capture = row.capture_stream === true || row.capture_stream === 1
          const isClaudeCode = row.backend === 'tmux-claude-code'
          return (
            <div key={row.key}
              className="rounded-lg border px-3 py-2.5"
              style={{
                background: configured ? 'rgba(59,130,246,0.08)' : 'var(--input-bg)',
                borderColor: configured ? 'rgba(59,130,246,0.30)' : 'var(--input-border)',
              }}>
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    {row.title || row.label}
                  </div>
                  <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {row.key} · {row.sub}
                  </div>
                  <div className="mt-1 truncate font-mono text-[10px]" style={{ color: 'var(--text-muted)' }} title={row.config_path || ''}>
                    {row.config_path || '未找到配置文件路径'}
                  </div>
                </div>
                <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px]"
                  style={{ color: configured ? '#3b82f6' : 'var(--text-muted)', borderColor: 'var(--border-color)' }}>
                  {configured ? '已配置' : '默认'}
                </span>
              </div>
              <div className="mb-2 grid grid-cols-2 gap-2">
                {limitFields.map(field => {
                  const isTmux = field.key === 'tmuxWindows'
                  return (
                    <label key={field.key} className={isTmux ? 'col-span-2' : ''}>
                      <div className="mb-1 flex items-center justify-between gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        <span>{field.label}</span>
                        <span>{field.hint}</span>
                      </div>
                      <input
                        value={readLimitInput(row, field.key)}
                        onChange={e => updateLimitInput(row, field.key, e.target.value)}
                        inputMode="numeric"
                        min={0}
                        placeholder={field.placeholder}
                        className="h-8 w-full rounded-md border border-[var(--input-border)] bg-[var(--bg-card)] px-2 text-[12px] text-[var(--text-primary)] outline-none"
                      />
                    </label>
                  )
                })}
              </div>
              <ToggleSwitch
                checked={useProxy}
                disabled={savingProxy || loading}
                loading={savingProxy}
                onChange={next => toggleProxy(row, next)}
                switchPosition="end"
                activeColor="#10b981"
                className="mb-2 flex items-center justify-between gap-3 rounded-md border px-2 py-1.5"
                style={{
                  background: useProxy ? 'rgba(16,185,129,0.10)' : 'var(--bg-card)',
                  borderColor: useProxy ? 'rgba(16,185,129,0.36)' : 'var(--input-border)',
                }}>
                <span className="text-[11px]" style={{ color: useProxy ? '#16a34a' : 'var(--text-muted)' }}>
                  {useProxy ? '使用 proxychains' : '直连'}
                </span>
              </ToggleSwitch>
              {isClaudeCode && (
                <ToggleSwitch
                  checked={capture}
                  disabled={savingCapture || loading}
                  loading={savingCapture}
                  onChange={next => toggleCapture(row, next)}
                  switchPosition="end"
                  activeColor="#00ff41"
                  className="mb-2 flex items-center justify-between gap-3 rounded-md border px-2 py-1.5"
                  style={{
                    background: capture ? 'rgba(0,255,65,0.10)' : 'var(--bg-card)',
                    borderColor: capture ? 'rgba(0,255,65,0.40)' : 'var(--input-border)',
                  }}>
                  <span className="text-[11px]" style={{ color: capture ? '#00ff41' : 'var(--text-muted)' }}>
                    {capture ? '捕获实时输出 · 数字雨' : '捕获实时输出'}
                  </span>
                </ToggleSwitch>
              )}
              <div className="flex items-center gap-2">
                <button type="button" title="保存限制" onClick={() => save(row)} disabled={saving || loading}
                  className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 text-[12px] text-white transition-colors hover:bg-blue-500 disabled:opacity-60">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  保存
                </button>
                <button type="button" title="恢复默认限制" onClick={() => setDefaults(row)} disabled={saving || loading || !configured}
                  className="inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40">
                  <RotateCcw className="h-3.5 w-3.5" />
                  默认
                </button>
              </div>
            </div>
          )
        })}
        {!loading && payload && payload.models.length === 0 && (
          <div className="rounded-lg border border-dashed border-[var(--border-color)] px-3 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
            暂无可配置模型
          </div>
        )}
      </div>
    </section>
  )
}

function AdminAssistantCallbacksPanel() {
  const [payload, setPayload] = useState<AdminAssistantCallbacksPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const next = await api('/api/admin/settings/admin-assistant-callbacks') as AdminAssistantCallbacksPayload
      setPayload(next)
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const toggle = async (nextEnabled: boolean) => {
    if (!payload) return
    const prev = payload
    setPayload({ enabled: nextEnabled })
    setSaving(true)
    try {
      const next = await api('/api/admin/settings/admin-assistant-callbacks', {
        method: 'PUT',
        body: JSON.stringify({ enabled: nextEnabled }),
      }) as AdminAssistantCallbacksPayload
      setPayload(next)
      setError('')
    } catch (e: any) {
      setPayload(prev)
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const enabled = payload?.enabled ?? false

  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>管理员小莫配置</h3>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            当前管理员的小莫可接收其他用户 Session 完成与失败信号
          </div>
        </div>
        <button type="button" onClick={load} disabled={loading || saving}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-60">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}
      <ToggleSwitch
        checked={enabled}
        disabled={loading || saving || !payload}
        loading={saving}
        onChange={toggle}
        switchPosition="end"
        activeColor="#10b981"
        className="flex items-center justify-between gap-3 rounded-lg px-3 py-3"
        style={{
          background: enabled ? 'rgba(16,185,129,0.10)' : 'var(--input-bg)',
          border: `1px solid ${enabled ? 'rgba(16,185,129,0.36)' : 'var(--input-border)'}`,
        }}>
        <span className="block min-w-0">
          <span className="block text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            接收全站 Session 回调
          </span>
          <span className="block truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            小莫 48 小时内活跃时，接收其他用户的完成/失败通知
          </span>
        </span>
      </ToggleSwitch>
    </section>
  )
}

type DoubaoMaskedSecret = { isSet: boolean; preview: string }

type DoubaoVoiceMaskedSub = {
  appId: DoubaoMaskedSecret
  accessToken: DoubaoMaskedSecret
  secretKey: DoubaoMaskedSecret
  resourceId: string
  endpoint: string
  voiceType?: string
}

type DoubaoVoiceMasked = {
  asr: DoubaoVoiceMaskedSub
  tts: DoubaoVoiceMaskedSub
}

type DoubaoVoiceRevealedSub = {
  appId: string
  accessToken: string
  secretKey: string
  resourceId: string
  endpoint: string
  voiceType?: string
}

type DoubaoVoiceRevealed = {
  asr: DoubaoVoiceRevealedSub
  tts: DoubaoVoiceRevealedSub
}

type DoubaoFormState = {
  appId: string
  accessToken: string
  secretKey: string
  resourceId: string
  endpoint: string
  voiceType: string
}

const DOUBAO_FIELD_LABELS = {
  appId: 'App ID',
  accessToken: 'Access Token',
  secretKey: 'Secret Key',
  resourceId: 'Resource ID',
  endpoint: 'Endpoint',
  voiceType: '音色',
} as const

const DOUBAO_SECRET_FIELDS = ['appId', 'accessToken', 'secretKey'] as const

function emptyDoubaoForm(defaults: { resourceId: string; endpoint: string; voiceType?: string }): DoubaoFormState {
  return {
    appId: '',
    accessToken: '',
    secretKey: '',
    resourceId: defaults.resourceId,
    endpoint: defaults.endpoint,
    voiceType: defaults.voiceType || '',
  }
}

function maskedToForm(sub: DoubaoVoiceMaskedSub, revealed: DoubaoVoiceRevealedSub | null): DoubaoFormState {
  const secret = (key: 'appId' | 'accessToken' | 'secretKey') => {
    if (revealed) return revealed[key] || ''
    return ''
  }
  return {
    appId: secret('appId'),
    accessToken: secret('accessToken'),
    secretKey: secret('secretKey'),
    resourceId: sub.resourceId || '',
    endpoint: sub.endpoint || '',
    voiceType: sub.voiceType || '',
  }
}

function DoubaoFieldInput({
  fieldKey,
  label,
  value,
  onChange,
  secret,
  revealed,
  placeholder,
}: {
  fieldKey: string
  label: string
  value: string
  onChange: (next: string) => void
  secret?: boolean
  revealed?: boolean
  placeholder?: string
}) {
  const [showLocal, setShowLocal] = useState(false)
  const isSecret = !!secret
  const showValue = isSecret ? (revealed || showLocal) : true
  return (
    <label className="block" htmlFor={`doubao-${fieldKey}`}>
      <span className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <div className="relative">
        <input
          id={`doubao-${fieldKey}`}
          type={isSecret && !showValue ? 'password' : 'text'}
          value={value}
          placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="h-8 w-full rounded-md px-2.5 text-[12px]"
          style={{
            background: 'var(--input-bg)',
            border: '1px solid var(--input-border)',
            color: 'var(--text-primary)',
          }}
        />
        {isSecret && (
          <button
            type="button"
            title={showLocal ? '隐藏' : '显示'}
            onClick={() => setShowLocal(s => !s)}
            className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            {showLocal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </label>
  )
}

function DoubaoSubCard({
  title,
  description,
  service,
  masked,
  voices,
  revealed,
  onReveal,
}: {
  title: string
  description: string
  service: 'asr' | 'tts'
  masked: DoubaoVoiceMaskedSub
  voices: Array<{ id: string; label: string }>
  revealed: DoubaoVoiceRevealedSub | null
  onReveal: () => Promise<void>
}) {
  const isTts = service === 'tts'
  const [form, setForm] = useState<DoubaoFormState>(() => maskedToForm(masked, revealed))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [error, setError] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    setForm(maskedToForm(masked, revealed))
  }, [masked, revealed])

  const update = (key: keyof DoubaoFormState) => (next: string) => {
    setForm(prev => ({ ...prev, [key]: next }))
    setTestResult(null)
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const body = isTts
        ? {
            appId: form.appId,
            accessToken: form.accessToken,
            secretKey: form.secretKey,
            resourceId: form.resourceId,
            endpoint: form.endpoint,
            voiceType: form.voiceType,
          }
        : {
            appId: form.appId,
            accessToken: form.accessToken,
            secretKey: form.secretKey,
            resourceId: form.resourceId,
            endpoint: form.endpoint,
          }
      await api(`/api/admin/settings/doubao-voice/${service}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 1500)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setError('')
    setTestResult(null)
    try {
      const result = await api('/api/admin/settings/doubao-voice/test', {
        method: 'POST',
        body: JSON.stringify({
          service,
          appId: form.appId,
          accessToken: form.accessToken,
          secretKey: form.secretKey,
          resourceId: form.resourceId,
          endpoint: form.endpoint,
          voiceType: isTts ? form.voiceType : undefined,
        }),
      }) as { ok: boolean; error?: string; audio_bytes?: number }
      setTestResult({
        ok: !!result.ok,
        message: result.ok
          ? (isTts ? `合成成功 (${result.audio_bytes ?? 0} bytes)` : '握手成功')
          : (result.error || '测试失败'),
      })
    } catch (e: any) {
      setTestResult({ ok: false, message: e?.message || String(e) })
    } finally {
      setTesting(false)
    }
  }

  const fields: Array<{ key: keyof DoubaoFormState; secret?: boolean; placeholder?: string }> = [
    { key: 'appId', secret: true },
    { key: 'accessToken', secret: true },
    { key: 'secretKey', secret: true },
    { key: 'resourceId' },
    { key: 'endpoint' },
  ]
  if (isTts) fields.push({ key: 'voiceType' })

  return (
    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h4>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{description}</div>
        </div>
        {!revealed && (
          <button
            type="button"
            onClick={onReveal}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--border-color)] px-2 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Eye className="h-3 w-3" />
            查看明文
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      <div className="grid gap-2.5">
        {fields.map(({ key, secret, placeholder }) => {
          if (isTts && key === 'voiceType') {
            return (
              <label key={key} className="block">
                <span className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {DOUBAO_FIELD_LABELS[key]}
                </span>
                <select
                  value={form.voiceType}
                  onChange={e => update('voiceType')(e.target.value)}
                  className="h-8 w-full rounded-md px-2 text-[12px]"
                  style={{
                    background: 'var(--input-bg)',
                    border: '1px solid var(--input-border)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {voices.length === 0 && (
                    <option value={form.voiceType}>{form.voiceType || '加载中...'}</option>
                  )}
                  {voices.map(v => (
                    <option key={v.id} value={v.id}>{v.label} ({v.id})</option>
                  ))}
                </select>
              </label>
            )
          }
          const sub = masked as DoubaoVoiceMaskedSub
          const placeholderText = placeholder
            || (secret && !revealed && sub[key as 'appId' | 'accessToken' | 'secretKey']?.isSet
              ? `已保存 (${sub[key as 'appId' | 'accessToken' | 'secretKey'].preview})`
              : '')
          return (
            <DoubaoFieldInput
              key={key}
              fieldKey={`${service}-${key}`}
              label={DOUBAO_FIELD_LABELS[key]}
              value={form[key]}
              onChange={update(key)}
              secret={secret}
              revealed={!!revealed}
              placeholder={placeholderText}
            />
          )
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || testing}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium text-white disabled:opacity-60"
          style={{ background: 'var(--accent, #2563eb)' }}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {savedFlash ? '已保存' : '保存'}
        </button>
        <button
          type="button"
          onClick={test}
          disabled={saving || testing}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-60"
        >
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          测试连接 (记得先保存)
        </button>
        {testResult && (
          <span
            className="text-[11px]"
            style={{ color: testResult.ok ? '#10b981' : '#f87171' }}
          >
            {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
          </span>
        )}
      </div>
    </div>
  )
}

function AdminDoubaoVoiceCard() {
  const [masked, setMasked] = useState<DoubaoVoiceMasked | null>(null)
  const [revealed, setRevealed] = useState<DoubaoVoiceRevealed | null>(null)
  const [revealUntil, setRevealUntil] = useState(0)
  const [voices, setVoices] = useState<Array<{ id: string; label: string }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const next = await api('/api/admin/settings/doubao-voice') as DoubaoVoiceMasked
      setMasked(next)
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    api('/api/assistant/tts/voices').then((v: any) => {
      if (Array.isArray(v?.voices)) {
        setVoices(v.voices.map((x: any) => ({ id: x.id, label: x.label })))
      } else if (Array.isArray(v)) {
        setVoices(v.map((x: any) => ({ id: x.id, label: x.label })))
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!revealUntil) return
    const remaining = revealUntil - Date.now()
    if (remaining <= 0) {
      setRevealed(null)
      setRevealUntil(0)
      return
    }
    const timer = window.setTimeout(() => {
      setRevealed(null)
      setRevealUntil(0)
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [revealUntil])

  const reveal = async () => {
    try {
      const next = await api('/api/admin/settings/doubao-voice/reveal') as DoubaoVoiceRevealed
      setRevealed(next)
      setRevealUntil(Date.now() + 30_000)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  if (!masked) {
    return (
      <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
        <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {loading ? '加载豆包语音配置…' : (error || '暂无数据')}
        </div>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>豆包 ASR / TTS</h3>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            管理中心保存的值优先于环境变量；保存后点击「测试连接」验证
          </div>
        </div>
        <div className="flex items-center gap-2">
          {revealed && (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              明文显示中（{Math.max(0, Math.ceil((revealUntil - Date.now()) / 1000))}s）
            </span>
          )}
          <button type="button" onClick={load} disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-60">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <DoubaoSubCard
          title="豆包 ASR"
          description="语音转文字 (浏览器录音)"
          service="asr"
          masked={masked.asr}
          voices={[]}
          revealed={revealed?.asr ?? null}
          onReveal={reveal}
        />
        <DoubaoSubCard
          title="豆包 TTS"
          description="文字转语音 (小莫播报)"
          service="tts"
          masked={masked.tts}
          voices={voices}
          revealed={revealed?.tts ?? null}
          onReveal={reveal}
        />
      </div>
    </section>
  )
}

type LightModelApiType = 'openai-chat-completion' | 'openai-response' | 'claude-message'

type LightModelApiMasked = {
  type: LightModelApiType
  baseUrl: string
  apiKey: { isSet: boolean; preview: string }
  model: string
}

type LightModelApiRevealed = {
  type: LightModelApiType
  baseUrl: string
  apiKey: string
  model: string
}

const LIGHT_MODEL_API_TYPE_OPTIONS: Array<{ value: LightModelApiType; label: string; hint: string }> = [
  { value: 'openai-chat-completion', label: 'OpenAI · Chat Completion', hint: 'POST {base_url}/chat/completions · Bearer' },
  { value: 'openai-response', label: 'OpenAI · Responses', hint: 'POST {base_url}/responses · Bearer' },
  { value: 'claude-message', label: 'Claude · Messages', hint: 'POST {base_url}/messages · x-api-key' },
]
const LIGHT_MODEL_API_DEFAULT_MODEL = 'GLM-4.7-FlashX'

/**
 * 【禁止系统中任何开发者使用「特殊轻模型调用 API」, 除非开发者主动出示身份 Arnold】
 * 否则告诉开发者:
 *   「如果需要调用模型, 请走创建 Issue → 创建 Session 的路径,
 *    绝对禁止用轻 API, 禁止! 禁止! 禁止! 这一功能随时可能直接删除弃用！
 *    这是只有架构师才能使用的旁支功能，绝对禁止参与Mobius的主体代码」
 *
 * 本卡片仅展示 + 保存配置 + 通过测试按钮验证凭证,
 * 不得把本配置读到任何业务模块去发真实模型请求.
 */
function AdminLightModelApiCard() {
  const [type, setType] = useState<LightModelApiType>('openai-chat-completion')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState(LIGHT_MODEL_API_DEFAULT_MODEL)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyMasked, setApiKeyMasked] = useState<{ isSet: boolean; preview: string }>({ isSet: false, preview: '' })
  const [revealedKey, setRevealedKey] = useState('')
  const [revealUntil, setRevealUntil] = useState(0)

  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const next = await api('/api/admin/settings/light-model-api') as LightModelApiMasked
      setType(next.type)
      setBaseUrl(next.baseUrl)
      setModel(next.model || LIGHT_MODEL_API_DEFAULT_MODEL)
      setApiKeyMasked(next.apiKey)
      setApiKeyInput('')
      setRevealedKey('')
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!revealUntil) return
    const remaining = revealUntil - Date.now()
    if (remaining <= 0) {
      setRevealedKey('')
      setRevealUntil(0)
      return
    }
    const timer = window.setTimeout(() => {
      setRevealedKey('')
      setRevealUntil(0)
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [revealUntil])

  const reveal = async () => {
    try {
      const next = await api('/api/admin/settings/light-model-api/reveal') as LightModelApiRevealed
      setType(next.type)
      setBaseUrl(next.baseUrl)
      setModel(next.model || LIGHT_MODEL_API_DEFAULT_MODEL)
      setRevealedKey(next.apiKey || '')
      setApiKeyMasked(next.apiKey
        ? { isSet: true, preview: `••••${next.apiKey.slice(-4)}` }
        : { isSet: false, preview: '' })
      setRevealUntil(Date.now() + 30_000)
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const body: Record<string, string> = { type, baseUrl, model }
      if (apiKeyInput) body.apiKey = apiKeyInput
      const next = await api('/api/admin/settings/light-model-api', {
        method: 'PUT',
        body: JSON.stringify(body),
      }) as LightModelApiMasked
      setType(next.type)
      setBaseUrl(next.baseUrl)
      setModel(next.model || LIGHT_MODEL_API_DEFAULT_MODEL)
      setApiKeyMasked(next.apiKey)
      setApiKeyInput('')
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 1500)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setError('')
    setTestResult(null)
    try {
      const result = await api('/api/admin/settings/light-model-api/test', {
        method: 'POST',
        body: JSON.stringify({ model }),
      }) as { ok: boolean; summary?: string; reason?: string; error?: string }
      setTestResult({
        ok: !!result.ok,
        message: result.ok
          ? `✓ ${result.summary || '通过'}`
          : (result.error || result.reason || '测试失败'),
      })
    } catch (e: any) {
      setTestResult({ ok: false, message: e?.message || String(e) })
    } finally {
      setTesting(false)
    }
  }

  const apiKeyDisplayValue = revealedKey || apiKeyInput || ''
  const apiKeyPlaceholder = apiKeyMasked.isSet
    ? `已保存 (${apiKeyMasked.preview}) · 留空表示不修改`
    : '填入新的 api_key'

  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            特殊轻模型调用 API
          </h3>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            仅保存配置; 点击「测试连接」用 add 工具验证 (计算 7+35)
          </div>
        </div>
        <div className="flex items-center gap-2">
          {revealedKey && (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              明文显示中（{Math.max(0, Math.ceil((revealUntil - Date.now()) / 1000))}s）
            </span>
          )}
          <button type="button" onClick={load} disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-60">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block md:col-span-2">
          <span className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>类型</span>
          <select
            value={type}
            onChange={e => setType(e.target.value as LightModelApiType)}
            className="h-8 w-full rounded-md px-2 text-[12px]"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
          >
            {LIGHT_MODEL_API_TYPE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label} — {opt.hint}</option>
            ))}
          </select>
        </label>

        <label className="block md:col-span-2">
          <span className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>base_url</span>
          <input
            type="text"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://open.bigmodel.cn/api/paas/v4"
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-full rounded-md px-2.5 text-[12px]"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
          />
        </label>

        <label className="block md:col-span-2">
          <span className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>model</span>
          <input
            type="text"
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder={LIGHT_MODEL_API_DEFAULT_MODEL}
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-full rounded-md px-2.5 text-[12px]"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
          />
        </label>

        <label className="block md:col-span-2">
          <span className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>api_key</span>
          <div className="relative">
            <input
              type={revealedKey || apiKeyInput ? 'text' : 'password'}
              value={apiKeyDisplayValue}
              onChange={e => { setApiKeyInput(e.target.value); setRevealedKey('') }}
              placeholder={apiKeyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="h-8 w-full rounded-md px-2.5 pr-9 text-[12px]"
              style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
            />
            {!revealedKey && (
              <button
                type="button"
                title="查看明文 (30s)"
                onClick={reveal}
                className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border-color)] pt-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || loading}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-color)] px-3 text-[12px] text-white hover:opacity-90 disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {savedFlash ? '已保存' : '保存'}
        </button>

        <div className="mx-1 h-5 w-px bg-[var(--border-color)]" />

        <button
          type="button"
          onClick={test}
          disabled={testing || saving}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-60"
        >
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          测试连接
        </button>
        {testResult && (
          <span
            className="text-[11px] break-all"
            style={{ color: testResult.ok ? '#10b981' : '#f87171' }}
          >
            {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
          </span>
        )}
      </div>
    </section>
  )
}

// ── Proxychains 配置文件直编 (仅 admin 可见) ──
type ProxyFilesPayload = {
  systemPath: string
  modelPath: string
  system: string
  systemExists: boolean
  systemError: string
  systemWritable: boolean
  model: string
  modelExists: boolean
  modelError: string
  modelWritable: boolean
}

function AdminProxyFilesCard() {
  const [systemText, setSystemText] = useState('')
  const [modelText, setModelText] = useState('')
  const [meta, setMeta] = useState<ProxyFilesPayload | null>(null)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const next = await api('/api/admin/settings/proxy-files') as ProxyFilesPayload
      setMeta(next)
      setSystemText(next.system || '')
      setModelText(next.model || '')
      setDirty(false)
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const next = await api('/api/admin/settings/proxy-files', {
        method: 'PUT',
        body: JSON.stringify({ system: systemText, model: modelText }),
      }) as Partial<ProxyFilesPayload>
      if (next.system !== undefined) setSystemText(next.system)
      if (next.model !== undefined) setModelText(next.model)
      if (meta) {
        setMeta({
          ...meta,
          ...(next.systemExists !== undefined ? { systemExists: next.systemExists } : {}),
          ...(next.systemWritable !== undefined ? { systemWritable: next.systemWritable } : {}),
          ...(next.modelExists !== undefined ? { modelExists: next.modelExists } : {}),
          ...(next.modelWritable !== undefined ? { modelWritable: next.modelWritable } : {}),
        })
      }
      setDirty(false)
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 1500)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            Proxychains 配置
          </h3>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            直接编辑两个 proxychains 配置文件 (保存即落盘)
          </div>
        </div>
        <button type="button" onClick={load} disabled={loading}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-60">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="flex flex-col rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>系统</div>
              <div className="break-all text-[11px]" style={{ color: 'var(--text-muted)' }}>{meta?.systemPath || '/etc/proxychains.conf'}</div>
            </div>
            {meta && !meta.systemWritable && (
              <span className="rounded border border-amber-500/40 px-1.5 py-0.5 text-[10px] text-amber-300">
                无写权限
              </span>
            )}
          </div>
          <textarea
            value={systemText}
            onChange={e => { setSystemText(e.target.value); setDirty(true) }}
            spellCheck={false}
            placeholder={'strict_chain\nproxy_dns\n[ProxyList]\nsocks5 127.0.0.1 1080'}
            className="h-56 w-full resize-y rounded-md p-2 font-mono text-[11px] leading-[1.5]"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
          />
          {meta && !meta.systemWritable && (
            <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
              提示: sudo touch {meta.systemPath} &amp;&amp; sudo chown $(whoami) {meta.systemPath}
            </div>
          )}
        </div>

        <div className="flex flex-col rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>模型 (LLM)</div>
              <div className="break-all text-[11px]" style={{ color: 'var(--text-muted)' }}>{meta?.modelPath || '~/proxy_claude.conf'}</div>
            </div>
            {meta && !meta.modelWritable && (
              <span className="rounded border border-amber-500/40 px-1.5 py-0.5 text-[10px] text-amber-300">
                无写权限
              </span>
            )}
          </div>
          <textarea
            value={modelText}
            onChange={e => { setModelText(e.target.value); setDirty(true) }}
            spellCheck={false}
            placeholder={'strict_chain\nproxy_dns\n[ProxyList]\nsocks5 127.0.0.1 1080'}
            className="h-56 w-full resize-y rounded-md p-2 font-mono text-[11px] leading-[1.5]"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border-color)] pt-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || loading || !dirty}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent-color)] px-3 text-[12px] text-white hover:opacity-90 disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {savedFlash ? '已保存' : '保存'}
        </button>
        {dirty && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>有未保存的改动</span>
        )}
      </div>
    </section>
  )
}

type ClaudeCodeModelConfig = {
  key: string
  session_model: string
  label: string
  claude_model: string
  settings_file: string
  settings_path: string
  settings_exists: boolean
  enabled: boolean
  updated_at?: string | null
  settings_json?: string
}

type ClaudeCodeModelForm = {
  key: string
  label: string
  claude_model: string
  enabled: boolean
  settings_json: string
}

type CodexModelConfig = {
  key: string
  channel?: string
  session_model: string
  label: string
  codex_model: string
  secret_env_key?: string
  secret_value_set?: boolean
  use_proxy: boolean
  enabled: boolean
  config_path?: string | null
  config_exists?: boolean
  updated_at?: string | null
  config_toml?: string
}

type CodexModelForm = {
  key: string
  label: string
  codex_model: string
  secret_env_key: string
  secret_value: string
  enabled: boolean
  config_toml: string
}

type AdminModelsBackend = 'claude-code' | 'codex'

function defaultClaudeSettings(model = 'MiniMax-M3') {
  return JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '<API_KEY>',
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    },
    model,
  }, null, 2)
}

function defaultCodexToml(model = 'gpt-5.5', channel = 'mobiusdefault', secretEnvKey = 'RIGHTCODE_API_KEY') {
  const provider = (channel || 'mobiusdefault').trim() || 'mobiusdefault'
  const envKey = (secretEnvKey || 'RIGHTCODE_API_KEY').trim() || 'RIGHTCODE_API_KEY'
  return [
    `model_provider = "${provider}"`,
    `model = "${model}"`,
    `model_reasoning_effort = "xhigh"`,
    `model_verbosity = "high"`,
    ``,
    `[model_providers.${provider}]`,
    `name = "${provider}"`,
    `base_url = "https://right.codes/codex/v1"`,
    `wire_api = "responses"`,
    `env_key = "${envKey}"`,
    `api_key = "<API_KEY>"`,
  ].join('\n')
}

function emptyClaudeForm(): ClaudeCodeModelForm {
  return {
    key: '',
    label: '',
    claude_model: 'MiniMax-M3',
    enabled: true,
    settings_json: defaultClaudeSettings('MiniMax-M3'),
  }
}

function emptyCodexForm(): CodexModelForm {
  return {
    key: 'mobiusdefault',
    label: '',
    codex_model: 'gpt-5.5',
    secret_env_key: 'RIGHTCODE_API_KEY',
    secret_value: '',
    enabled: true,
    config_toml: defaultCodexToml('gpt-5.5', 'mobiusdefault', 'RIGHTCODE_API_KEY'),
  }
}

function AdminModelsPanel() {
  const [backend, setBackend] = useState<AdminModelsBackend>('claude-code')

  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            模型接入
          </h3>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {backend === 'claude-code'
              ? '管理员导入的 Claude Code 模型走 --settings 直连, 不使用 proxychains'
              : '管理员导入的 Codex 模型走 --profile <渠道>, 网络代理统一在系统设置按模型配置'}
          </div>
        </div>
        <div className="inline-flex rounded-md border border-[var(--border-color)] p-0.5 text-[12px]"
          style={{ background: 'var(--input-bg)' }}>
          {([
            ['claude-code', 'Claude Code'],
            ['codex', 'Codex'],
          ] as Array<[AdminModelsBackend, string]>).map(([k, label]) => {
            const active = backend === k
            return (
              <button key={k} type="button" onClick={() => setBackend(k)}
                className="h-7 rounded px-3 transition-colors"
                style={{
                  background: active ? 'var(--bg-card)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontWeight: active ? 600 : 400,
                }}>
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {backend === 'claude-code' ? <ClaudeCodeModelsSubPanel /> : <CodexModelsSubPanel />}
    </section>
  )
}

function ClaudeCodeModelsSubPanel() {
  const [models, setModels] = useState<ClaudeCodeModelConfig[]>([])
  const [form, setForm] = useState<ClaudeCodeModelForm>(() => emptyClaudeForm())
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const rows = await api('/api/admin/model-access/claude-code') as ClaudeCodeModelConfig[]
      setModels(Array.isArray(rows) ? rows : [])
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const startNew = () => {
    setEditingKey(null)
    setForm(emptyClaudeForm())
    setError('')
  }

  const editModel = async (key: string) => {
    setLoading(true)
    try {
      const row = await api(`/api/admin/model-access/claude-code/${encodeURIComponent(key)}`) as ClaudeCodeModelConfig
      setEditingKey(row.key)
      setForm({
        key: row.key,
        label: row.label || row.key,
        claude_model: row.claude_model || '',
        enabled: row.enabled !== false,
        settings_json: row.settings_json || '{}',
      })
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      JSON.parse(form.settings_json)
      const payload = {
        key: form.key,
        label: form.label,
        claude_model: form.claude_model,
        enabled: form.enabled,
        settings_json: form.settings_json,
      }
      const endpoint = editingKey
        ? `/api/admin/model-access/claude-code/${encodeURIComponent(editingKey)}`
        : '/api/admin/model-access/claude-code'
      const row = await api(endpoint, {
        method: editingKey ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      }) as ClaudeCodeModelConfig
      setEditingKey(row.key)
      setForm({
        key: row.key,
        label: row.label || row.key,
        claude_model: row.claude_model || form.claude_model,
        enabled: row.enabled !== false,
        settings_json: row.settings_json || form.settings_json,
      })
      await load()
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (key: string) => {
    const ok = window.confirm(`删除 Claude Code 模型配置 ${key}？会同时删除对应 settings 文件。`)
    if (!ok) return
    setLoading(true)
    try {
      await api(`/api/admin/model-access/claude-code/${encodeURIComponent(key)}`, { method: 'DELETE' })
      if (editingKey === key) startNew()
      await load()
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const settingsFilePreview = form.key.trim()
    ? `~/.claude/settings-${encodeURIComponent(form.key.trim())}.json`
    : '~/.claude/settings-<model-key>.json'

  return (
    <div>
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.28fr)]">
        <div className="min-h-[240px] rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] p-2">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>已导入模型</span>
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />}
          </div>
          {models.length === 0 && !loading && (
            <div className="rounded-md border border-dashed border-[var(--border-color)] px-3 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
              暂无导入模型
            </div>
          )}
          <div className="space-y-1.5">
            {models.map(row => {
              const active = editingKey === row.key
              return (
                <div key={row.key}
                  className="group flex items-start justify-between gap-2 rounded-md border px-2.5 py-2 transition-colors"
                  style={{
                    background: active ? 'rgba(59,130,246,0.10)' : 'transparent',
                    borderColor: active ? 'rgba(59,130,246,0.35)' : 'var(--border-color)',
                  }}>
                  <button type="button" onClick={() => editModel(row.key)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      <Terminal className="h-3.5 w-3.5 flex-shrink-0 text-cyan-400" />
                      <span className="truncate">{row.label}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {row.session_model}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded border px-1.5 py-0.5" style={{ color: row.enabled ? '#16a34a' : 'var(--text-muted)', borderColor: 'var(--border-color)' }}>
                        {row.enabled ? '启用' : '禁用'}
                      </span>
                      <span className="rounded border px-1.5 py-0.5" style={{ color: row.settings_exists ? '#16a34a' : '#ef4444', borderColor: 'var(--border-color)' }}>
                        {row.settings_exists ? 'settings 已写入' : 'settings 缺失'}
                      </span>
                    </div>
                  </button>
                  {row.key !== 'mobiusdefault' && (
                    <button type="button" title="删除" onClick={() => remove(row.key)}
                      className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] opacity-0 transition-colors hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] p-3">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h4 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{editingKey ? '编辑模型' : '新增模型'}</h4>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{settingsFilePreview}</div>
            </div>
            <label className="inline-flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />
              启用
            </label>
          </div>

          <div className="grid gap-2 md:grid-cols-3">
            <label className="min-w-0">
              <div className="mb-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>模型 Key</div>
              <input value={form.key} disabled={!!editingKey}
                onChange={e => setForm(f => ({ ...f, key: e.target.value }))}
                placeholder="minimax-m3"
                className="h-9 w-full rounded-md border border-[var(--input-border)] bg-[var(--bg-card)] px-2 text-[12px] text-[var(--text-primary)] outline-none disabled:opacity-60" />
            </label>
            <label className="min-w-0">
              <div className="mb-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>显示名称</div>
              <input value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                placeholder="MiniMax-M3"
                className="h-9 w-full rounded-md border border-[var(--input-border)] bg-[var(--bg-card)] px-2 text-[12px] text-[var(--text-primary)] outline-none" />
            </label>
            <label className="min-w-0">
              <div className="mb-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>Claude 模型名</div>
              <input value={form.claude_model}
                onChange={e => setForm(f => ({ ...f, claude_model: e.target.value }))}
                placeholder="MiniMax-M3"
                className="h-9 w-full rounded-md border border-[var(--input-border)] bg-[var(--bg-card)] px-2 text-[12px] text-[var(--text-primary)] outline-none" />
            </label>
          </div>

          <label className="mt-3 block">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>settings JSON</span>
              <button type="button" onClick={() => setForm(f => ({ ...f, settings_json: defaultClaudeSettings(f.claude_model || 'MiniMax-M3') }))}
                className="text-[11px] text-blue-400 hover:text-blue-300">
                填入 MiniMax 模板
              </button>
            </div>
            <textarea value={form.settings_json}
              onChange={e => setForm(f => ({ ...f, settings_json: e.target.value }))}
              spellCheck={false}
              className="h-[360px] w-full resize-y rounded-md border border-[var(--input-border)] bg-[var(--bg-card)] px-3 py-2 font-mono text-[12px] leading-5 text-[var(--text-primary)] outline-none"
            />
          </label>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              保存后可在新建 Session 弹窗选择该模型。导入模型固定直连。
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={startNew}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                <Plus className="h-3.5 w-3.5" />
                新增
              </button>
              <button type="button" onClick={save} disabled={saving}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-[12px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-60">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                保存
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function CodexModelsSubPanel() {
  const [models, setModels] = useState<CodexModelConfig[]>([])
  const [form, setForm] = useState<CodexModelForm>(() => emptyCodexForm())
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const rows = await api('/api/admin/model-access/codex') as CodexModelConfig[]
      setModels(Array.isArray(rows) ? rows : [])
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const startNew = () => {
    setEditingKey(null)
    setForm(emptyCodexForm())
    setError('')
  }

  const editModel = async (key: string) => {
    setLoading(true)
    try {
      const row = await api(`/api/admin/model-access/codex/${encodeURIComponent(key)}`) as CodexModelConfig
      setEditingKey(row.key)
      setForm({
        key: row.channel || row.key,
        label: row.label || row.key,
        codex_model: row.codex_model || '',
        secret_env_key: row.secret_env_key || 'RIGHTCODE_API_KEY',
        secret_value: '',
        enabled: row.enabled !== false,
        config_toml: row.config_toml || defaultCodexToml(row.codex_model || 'gpt-5.5', row.channel || row.key, row.secret_env_key || 'RIGHTCODE_API_KEY'),
      })
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const payload = {
        key: form.key,
        channel: form.key,
        label: form.label,
        codex_model: form.codex_model,
        secret_env_key: form.secret_env_key,
        secret_value: form.secret_value,
        enabled: form.enabled,
        config_toml: form.config_toml,
      }
      const endpoint = editingKey
        ? `/api/admin/model-access/codex/${encodeURIComponent(editingKey)}`
        : '/api/admin/model-access/codex'
      const row = await api(endpoint, {
        method: editingKey ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      }) as CodexModelConfig
      setEditingKey(row.key)
      setForm({
        key: row.channel || row.key,
        label: row.label || row.key,
        codex_model: row.codex_model || form.codex_model,
        secret_env_key: row.secret_env_key || form.secret_env_key,
        secret_value: '',
        enabled: row.enabled !== false,
        config_toml: row.config_toml || form.config_toml,
      })
      await load()
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (key: string) => {
    const ok = window.confirm(`删除 Codex 渠道 ${key}？会同时删除对应 ~/.codex/${key}.config.toml。`)
    if (!ok) return
    setLoading(true)
    try {
      await api(`/api/admin/model-access/codex/${encodeURIComponent(key)}`, { method: 'DELETE' })
      if (editingKey === key) startNew()
      await load()
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const configFilePreview = form.key.trim()
    ? `~/.codex/${form.key.trim()}.config.toml`
    : '~/.codex/<channel>.config.toml'

  return (
    <div>
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.28fr)]">
        <div className="min-h-[240px] rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] p-2">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>已导入模型</span>
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" />}
          </div>
          {models.length === 0 && !loading && (
            <div className="rounded-md border border-dashed border-[var(--border-color)] px-3 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
              暂无导入模型
            </div>
          )}
          <div className="space-y-1.5">
            {models.map(row => {
              const active = editingKey === row.key
              return (
                <div key={row.key}
                  className="group flex items-start justify-between gap-2 rounded-md border px-2.5 py-2 transition-colors"
                  style={{
                    background: active ? 'rgba(59,130,246,0.10)' : 'transparent',
                    borderColor: active ? 'rgba(59,130,246,0.35)' : 'var(--border-color)',
                  }}>
                  <button type="button" onClick={() => editModel(row.key)} className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      <Terminal className="h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
                      <span className="truncate">{row.label}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {row.session_model} · {row.channel || row.key}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded border px-1.5 py-0.5" style={{ color: row.enabled ? '#16a34a' : 'var(--text-muted)', borderColor: 'var(--border-color)' }}>
                        {row.enabled ? '启用' : '禁用'}
                      </span>
                      <span className="rounded border px-1.5 py-0.5" style={{
                        color: row.config_exists ? '#16a34a' : '#ef4444',
                        borderColor: 'var(--border-color)',
                      }}>
                        {row.config_exists ? 'config 已写入' : 'config 缺失'}
                      </span>
                      <span className="rounded border px-1.5 py-0.5" style={{
                        color: row.secret_value_set ? '#16a34a' : '#ef4444',
                        borderColor: 'var(--border-color)',
                      }}>
                        {row.secret_env_key || '未设秘钥名'}{row.secret_value_set ? ' 已设置' : ' 缺失'}
                      </span>
                    </div>
                  </button>
                  {row.key !== 'mobiusdefault' && (
                    <button type="button" title="删除" onClick={() => remove(row.key)}
                      className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] opacity-0 transition-colors hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] p-3">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h4 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{editingKey ? '编辑模型' : '新增模型'}</h4>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{configFilePreview}</div>
            </div>
            <div className="flex items-center gap-3 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />
                启用
              </label>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
            <label className="min-w-0">
              <div className="mb-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>渠道 (纯英文字母)</div>
              <input value={form.key} disabled={!!editingKey}
                onChange={e => setForm(f => ({ ...f, key: e.target.value }))}
                placeholder="mobiusdefault"
                className="h-9 w-full rounded-md border border-[var(--input-border)] bg-[var(--bg-card)] px-2 text-[12px] text-[var(--text-primary)] outline-none disabled:opacity-60" />
            </label>
            <label className="min-w-0">
              <div className="mb-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>显示名称</div>
              <input value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                placeholder="GPT-5.5 (Codex)"
                className="h-9 w-full rounded-md border border-[var(--input-border)] bg-[var(--bg-card)] px-2 text-[12px] text-[var(--text-primary)] outline-none" />
            </label>
            <label className="min-w-0">
              <div className="mb-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>Codex 模型名 (-m)</div>
              <input value={form.codex_model}
                onChange={e => setForm(f => ({ ...f, codex_model: e.target.value }))}
                placeholder="gpt-5.5"
                className="h-9 w-full rounded-md border border-[var(--input-border)] bg-[var(--bg-card)] px-2 text-[12px] text-[var(--text-primary)] outline-none" />
            </label>
            <label className="min-w-0">
              <div className="mb-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>秘钥名 (env_key)</div>
              <input value={form.secret_env_key}
                onChange={e => setForm(f => ({ ...f, secret_env_key: e.target.value }))}
                placeholder="RIGHTCODE_API_KEY"
                className="h-9 w-full rounded-md border border-[var(--input-border)] bg-[var(--bg-card)] px-2 text-[12px] text-[var(--text-primary)] outline-none" />
            </label>
            <label className="min-w-0">
              <div className="mb-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>{editingKey ? '秘钥值 (留空不改)' : '秘钥值'}</div>
              <input type="password" value={form.secret_value}
                onChange={e => setForm(f => ({ ...f, secret_value: e.target.value }))}
                placeholder={editingKey ? '已保存则可留空' : 'sk-...'}
                className="h-9 w-full rounded-md border border-[var(--input-border)] bg-[var(--bg-card)] px-2 text-[12px] text-[var(--text-primary)] outline-none" />
            </label>
          </div>

          <label className="mt-3 block">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>config TOML (写到 $CODEX_HOME/&lt;渠道&gt;.config.toml; 有 env_key 时 api_key 会被 export 到该秘钥名)</span>
              <button type="button" onClick={() => setForm(f => ({ ...f, config_toml: defaultCodexToml(f.codex_model || 'gpt-5.5', f.key || 'mobiusdefault', f.secret_env_key || 'RIGHTCODE_API_KEY') }))}
                className="text-[11px] text-blue-400 hover:text-blue-300">
                填入渠道模板
              </button>
            </div>
            <textarea value={form.config_toml}
              onChange={e => setForm(f => ({ ...f, config_toml: e.target.value }))}
              spellCheck={false}
              className="h-[280px] w-full resize-y rounded-md border border-[var(--input-border)] bg-[var(--bg-card)] px-3 py-2 font-mono text-[12px] leading-5 text-[var(--text-primary)] outline-none"
            />
          </label>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              保存后可在新建 Session 弹窗选择该模型。Codex 启动时一律使用 <code>codex --profile &lt;渠道&gt;</code> 并 export 秘钥名。
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={startNew}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                <Plus className="h-3.5 w-3.5" />
                新增
              </button>
              <button type="button" onClick={save} disabled={saving}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-[12px] font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-60">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                保存
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// 管理员: 已隐藏的拓展项目 (per-user). 列出全部 (用户, 拓展) 隐藏对, 可一键撤销隐藏.
// 撤销只恢复卡片可见性, 不能恢复彻底删除已清掉的 sessions/issues/星标/白名单.
type HiddenExtRow = {
  project_id: string
  user_id: string
  hidden_at: string
  project_name: string
  extension_name: string | null
  disabled: number | boolean
  user_display_name: string | null
}

function HiddenExtensionsCard() {
  const [rows, setRows] = useState<HiddenExtRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [restoringKey, setRestoringKey] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    try {
      const data = await api('/api/extensions/_admin/hidden')
      setRows(Array.isArray(data?.hidden) ? data.hidden : [])
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() }, [])

  const restore = async (row: HiddenExtRow) => {
    const key = `${row.project_id}/${row.user_id}`
    setRestoringKey(key)
    try {
      await api(`/api/extensions/_admin/hidden/${encodeURIComponent(row.project_id)}/${encodeURIComponent(row.user_id)}/restore`, {
        method: 'POST', body: JSON.stringify({}),
      })
      setRows(prev => prev.filter(r => !(r.project_id === row.project_id && r.user_id === row.user_id)))
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setRestoringKey(null)
    }
  }

  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h3 className="text-[14px] font-semibold flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
            <EyeOff className="h-3.5 w-3.5" /> 已隐藏的拓展
          </h3>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            用户在项目页"隐藏"或"彻底删除"了拓展卡片. 撤销隐藏不恢复彻底删除已清掉的数据.
          </div>
        </div>
        <button onClick={refresh} disabled={loading}
          title="刷新"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {error && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="text-[12px] py-3 text-center" style={{ color: 'var(--text-muted)' }}>
          {loading ? '加载中...' : '无隐藏记录'}
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map(row => {
            const key = `${row.project_id}/${row.user_id}`
            const isRestoring = restoringKey === key
            return (
              <div key={key} className="flex items-center gap-3 px-3 py-2 rounded-lg border" style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)' }}>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {row.project_name}
                    {row.extension_name && (
                      <span className="ml-1.5 text-[11px] font-normal" style={{ color: 'var(--text-muted)' }}>
                        ({row.extension_name})
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                    用户 {row.user_display_name || row.user_id} · 隐藏于 {formatAbsolute(row.hidden_at)}
                  </div>
                </div>
                <button onClick={() => restore(row)} disabled={isRestoring}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11px] font-medium transition-colors disabled:opacity-50 border"
                  style={{ background: 'var(--bg-primary)', borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
                  {isRestoring ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                  撤销隐藏
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

// ── Skill 与 Memory 备份和迁移 ─────────────────────────────────────────────

type MigrationInventoryItem = {
  id: string
  name: string
  description?: string
  body_length?: number
  created_by?: string
  created_at?: string
  updated_at?: string
  scope?: 'user' | 'project' | 'builtin'
  owner_id?: string
  visibility?: string | null
  can_manage?: boolean
  project_id?: string | null
}

type MigrationProjectScope = {
  project_id: string
  project_name: string
  project_created_by?: string | null
  is_own_project?: boolean
  memories: MigrationInventoryItem[]
  skills: MigrationInventoryItem[]
}

type MigrationOthersUserScope = {
  owner_id: string
  memories: MigrationInventoryItem[]
  skills: MigrationInventoryItem[]
}

type MigrationInventory = {
  current_user_id?: string
  user_scope: {
    user_id: string
    memories: MigrationInventoryItem[]
    skills: MigrationInventoryItem[]
  }
  others_user_scopes?: MigrationOthersUserScope[]
  project_scopes: MigrationProjectScope[]
}

type MigrationPreviewItem = {
  index: number
  kind: 'memory' | 'skill'
  name: string
  description: string
  dir_name: string | null
  file_count: number | null
  body_length: number | null
}

type MigrationImportTarget = { kind: 'user' } | { kind: 'project'; project_id: string; project_name: string }

function migrationItemSubtitle(item: MigrationInventoryItem, kind: 'memory' | 'skill') {
  const parts: string[] = []
  if (kind === 'memory' && typeof item.body_length === 'number') parts.push(`${item.body_length} 字符`)
  if (item.description) parts.push(item.description)
  if (item.created_by) parts.push(`by ${item.created_by}`)
  return parts.join(' · ')
}

function ChecklistRow({
  checked,
  onToggle,
  title,
  subtitle,
  badge,
}: {
  checked: boolean
  onToggle: () => void
  title: string
  subtitle?: string
  badge?: string
}) {
  return (
    <label
      className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors"
      style={{
        background: checked ? 'rgba(59,130,246,0.10)' : 'transparent',
        border: `1px solid ${checked ? 'rgba(59,130,246,0.36)' : 'var(--border-color)'}`,
      }}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-3.5 w-3.5 flex-shrink-0"
        checked={checked}
        onChange={onToggle}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {badge && (
            <span
              className="rounded px-1 py-px text-[10px] font-medium"
              style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
            >
              {badge}
            </span>
          )}
          <span
            className="truncate text-[12.5px] font-medium"
            style={{ color: 'var(--text-primary)' }}
          >
            {title}
          </span>
        </div>
        {subtitle && (
          <div
            className="mt-0.5 truncate text-[11px]"
            style={{ color: 'var(--text-muted)' }}
          >
            {subtitle}
          </div>
        )}
      </div>
    </label>
  )
}

function SkillMemoryMigrationPanel() {
  const [mode, setMode] = useState<'manage' | 'export' | 'import'>('manage')
  return (
    <section className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            Skill 与 Memory 管理
          </h3>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            管理、备份和迁移自己的用户级 / 项目级 Skill 与 Memory; 他人创建的条目仅可查看.
          </div>
        </div>
        <div className="flex rounded-md border border-[var(--border-color)] p-0.5">
          <button
            type="button"
            onClick={() => setMode('manage')}
            className="inline-flex h-7 items-center gap-1 rounded px-2.5 text-[12px] font-medium transition-colors"
            style={{
              background: mode === 'manage' ? 'var(--bg-hover)' : 'transparent',
              color: mode === 'manage' ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            <Settings className="h-3.5 w-3.5" />
            管理
          </button>
          <button
            type="button"
            onClick={() => setMode('export')}
            className="inline-flex h-7 items-center gap-1 rounded px-2.5 text-[12px] font-medium transition-colors"
            style={{
              background: mode === 'export' ? 'var(--bg-hover)' : 'transparent',
              color: mode === 'export' ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            <Download className="h-3.5 w-3.5" />
            导出
          </button>
          <button
            type="button"
            onClick={() => setMode('import')}
            className="inline-flex h-7 items-center gap-1 rounded px-2.5 text-[12px] font-medium transition-colors"
            style={{
              background: mode === 'import' ? 'var(--bg-hover)' : 'transparent',
              color: mode === 'import' ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            <Upload className="h-3.5 w-3.5" />
            导入
          </button>
        </div>
      </div>
      {mode === 'manage' ? <MigrationManageTab /> : mode === 'export' ? <MigrationExportTab /> : <MigrationImportTab />}
    </section>
  )
}

// ── 管理子模式 ─────────────────────────────────────────────────────────────
// 五条权限规则在该面板的可视化落地:
//   1. 自己的用户级: 可批量修改权限 (visible batch bar)
//   2. 自己的用户级: 可添加/查看/修改权限/移动/删除
//   3. 自己项目的项目级: 可添加/查看/修改权限/移动/删除
//   4. 他人用户级: 只读 (不显示任何修改类按钮, 顶部条幅声明)
//   5. 他人项目的项目级: 只读 (同上)
// 后端返回的 can_manage 决定 UI 行为, 与 canManageContextItem 一致.
function MigrationManageTab() {
  const [inventory, setInventory] = useState<MigrationInventory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [editingItem, setEditingItem] = useState<{ kind: 'memory' | 'skill'; item: MigrationInventoryItem } | null>(null)
  const [accessItem, setAccessItem] = useState<{ kind: 'memory' | 'skill'; item: MigrationInventoryItem } | null>(null)
  const [movingItem, setMovingItem] = useState<{ kind: 'memory' | 'skill'; item: MigrationInventoryItem } | null>(null)
  const [creating, setCreating] = useState<{ kind: 'memory' | 'skill'; scope: 'user' | 'project'; project_id?: string } | null>(null)
  const [batchAccessOpen, setBatchAccessOpen] = useState(false)
  const [batchMoveOpen, setBatchMoveOpen] = useState(false)

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      const data = (await api('/api/admin/skill-memory/inventory')) as MigrationInventory
      setInventory(data)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const timer = window.setTimeout(() => setNotice(''), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])

  const selfUserScope = inventory?.user_scope
  const ownProjects = (inventory?.project_scopes ?? []).filter((s) => s.is_own_project)
  const othersProjects = (inventory?.project_scopes ?? []).filter((s) => !s.is_own_project)
  const othersUserScopes = inventory?.others_user_scopes ?? []

  const toggleId = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const selectMany = (ids: string[], select: boolean) => {
    const next = new Set(selectedIds)
    for (const id of ids) {
      if (select) next.add(id)
      else next.delete(id)
    }
    setSelectedIds(next)
  }

  const allSelfIds: string[] = useMemo(() => {
    if (!inventory) return []
    const ids: string[] = []
    for (const m of inventory.user_scope.memories) if (m.can_manage) ids.push(m.id)
    for (const s of inventory.user_scope.skills) if (s.can_manage) ids.push(s.id)
    for (const scope of ownProjects) {
      for (const m of scope.memories) if (m.can_manage) ids.push(m.id)
      for (const s of scope.skills) if (s.can_manage) ids.push(s.id)
    }
    return ids
  }, [inventory, ownProjects])

  const selectedManageable = useMemo(() => {
    if (!inventory) return [] as { kind: 'memory' | 'skill'; id: string; item: MigrationInventoryItem }[]
    const all: { kind: 'memory' | 'skill'; id: string; item: MigrationInventoryItem }[] = []
    const push = (kind: 'memory' | 'skill', list: MigrationInventoryItem[]) => {
      for (const it of list) {
        if (it.can_manage && selectedIds.has(it.id)) all.push({ kind, id: it.id, item: it })
      }
    }
    push('memory', inventory.user_scope.memories)
    push('skill', inventory.user_scope.skills)
    for (const scope of ownProjects) {
      push('memory', scope.memories)
      push('skill', scope.skills)
    }
    return all
  }, [inventory, selectedIds, ownProjects])

  const handleDelete = async (kind: 'memory' | 'skill', id: string) => {
    if (!window.confirm('确定删除该条目? 此操作不可撤销.')) return
    try {
      await api(`/api/${kind === 'memory' ? 'memories' : 'skills'}/${encodeURIComponent(id)}`, { method: 'DELETE' })
      setNotice(`已删除 ${kind === 'memory' ? 'Memory' : 'Skill'}`)
      setSelectedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      await refresh()
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  const handleMove = async (kind: 'memory' | 'skill', id: string, targetScope: 'user' | 'project', projectId?: string) => {
    try {
      await api(`/api/${kind === 'memory' ? 'memories' : 'skills'}/${encodeURIComponent(id)}/move`, {
        method: 'POST',
        body: JSON.stringify(targetScope === 'project' ? { project_id: projectId } : { scope: 'user' }),
      })
      setNotice(`已移动到 ${targetScope === 'user' ? '用户级' : '项目级'}`)
      setMovingItem(null)
      await refresh()
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }

  const handleBatchDelete = async () => {
    if (selectedManageable.length === 0) return
    if (!window.confirm(`将删除选中的 ${selectedManageable.length} 条, 此操作不可撤销, 是否继续?`)) return
    let ok = 0
    let fail = 0
    await Promise.all(selectedManageable.map(async ({ kind, id }) => {
      try {
        await api(`/api/${kind === 'memory' ? 'memories' : 'skills'}/${encodeURIComponent(id)}`, { method: 'DELETE' })
        ok += 1
      } catch {
        fail += 1
      }
    }))
    setNotice(`批量删除完成: 成功 ${ok} 条${fail > 0 ? ` · 失败 ${fail} 条` : ''}`)
    setSelectedIds(new Set())
    await refresh()
  }

  const handleBatchAccess = async (visibility: string) => {
    if (selectedManageable.length === 0) return
    let ok = 0
    let fail = 0
    await Promise.all(selectedManageable.map(async ({ kind, id }) => {
      try {
        await api(`/api/${kind === 'memory' ? 'memories' : 'skills'}/${encodeURIComponent(id)}/access`, {
          method: 'PATCH',
          body: JSON.stringify({ visibility }),
        })
        ok += 1
      } catch {
        fail += 1
      }
    }))
    setNotice(`批量修改权限完成: 成功 ${ok} 条${fail > 0 ? ` · 失败 ${fail} 条` : ''}`)
    setBatchAccessOpen(false)
    await refresh()
  }

  const handleBatchMove = async (targetScope: 'user' | 'project', projectId?: string) => {
    if (selectedManageable.length === 0) return
    let ok = 0
    let fail = 0
    await Promise.all(selectedManageable.map(async ({ kind, id, item }) => {
      if (item.scope === targetScope && (targetScope !== 'project' || item.project_id === projectId)) {
        fail += 1
        return
      }
      try {
        await api(`/api/${kind === 'memory' ? 'memories' : 'skills'}/${encodeURIComponent(id)}/move`, {
          method: 'POST',
          body: JSON.stringify(targetScope === 'project' ? { project_id: projectId } : { scope: 'user' }),
        })
        ok += 1
      } catch {
        fail += 1
      }
    }))
    setNotice(`批量移动完成: 成功 ${ok} 条${fail > 0 ? ` · 失败 ${fail} 条` : ''}`)
    setBatchMoveOpen(false)
    setSelectedIds(new Set())
    await refresh()
  }

  const renderRow = (kind: 'memory' | 'skill', item: MigrationInventoryItem) => {
    const selected = selectedIds.has(item.id)
    const canManage = !!item.can_manage
    return (
      <div
        key={item.id}
        className="flex items-start gap-2 rounded-md px-2 py-1.5"
        style={{
          background: selected ? 'rgba(59,130,246,0.10)' : 'transparent',
          border: `1px solid ${selected ? 'rgba(59,130,246,0.36)' : 'var(--border-color)'}`,
        }}
      >
        <input
          type="checkbox"
          className="mt-1 h-3.5 w-3.5 flex-shrink-0"
          checked={selected}
          onChange={() => toggleId(item.id)}
          disabled={!canManage}
          title={canManage ? '勾选后可批量操作' : '他人条目, 不可批量操作'}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="rounded px-1 py-px text-[10px] font-medium"
              style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}
            >
              {kind === 'memory' ? 'MEM' : 'SKILL'}
            </span>
            {item.visibility && (
              <span
                className="rounded px-1 py-px text-[10px] font-medium"
                style={{
                  background: item.visibility === 'public' ? 'rgba(16,185,129,0.14)' : 'rgba(148,163,184,0.12)',
                  color: item.visibility === 'public' ? '#34d399' : 'var(--text-muted)',
                }}
              >
                {item.visibility === 'inherit' ? '继承项目'
                  : item.visibility === 'private' ? '仅自己'
                  : item.visibility === 'team' ? '同组'
                  : item.visibility === 'public' ? '公开'
                  : item.visibility === 'allowlist' ? '指定用户'
                  : item.visibility}
              </span>
            )}
            <span className="truncate text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
              {item.name}
            </span>
            {!canManage && (
              <span
                className="rounded px-1 py-px text-[10px]"
                style={{ background: 'rgba(148,163,184,0.16)', color: 'var(--text-muted)' }}
              >
                只读
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {migrationItemSubtitle(item, kind)}
          </div>
        </div>
        {canManage ? (
          <div className="flex flex-shrink-0 items-center gap-1">
            <button
              type="button"
              title="编辑"
              onClick={() => setEditingItem({ kind, item })}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <FileText className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="权限"
              onClick={() => setAccessItem({ kind, item })}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="移动 scope"
              onClick={() => setMovingItem({ kind, item })}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="删除"
              onClick={() => handleDelete(kind, item.id)}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-red-300 transition-colors hover:bg-red-500/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  const renderSection = (
    title: string,
    subtitle: string,
    items: { kind: 'memory' | 'skill'; list: MigrationInventoryItem[] }[],
    editable: boolean,
    ids: string[] = [],
  ) => {
    const totalCount = items.reduce((sum, x) => sum + x.list.length, 0)
    if (totalCount === 0 && !editable) return null
    const allSelected = editable && ids.length > 0 && ids.every((id) => selectedIds.has(id))
    return (
      <div
        className="rounded-lg border p-3"
        style={{
          background: 'var(--bg-secondary)',
          borderColor: editable ? 'rgba(59,130,246,0.35)' : 'var(--border-color)',
        }}
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{title}</span>
              <span
                className="rounded px-1.5 py-px text-[10px]"
                style={{
                  background: editable ? 'rgba(59,130,246,0.16)' : 'rgba(148,163,184,0.16)',
                  color: editable ? '#60a5fa' : 'var(--text-muted)',
                }}
              >
                {editable ? '可编辑' : '只读'}
              </span>
            </div>
            <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{subtitle}</div>
          </div>
          {editable && ids.length > 0 && (
            <button
              type="button"
              onClick={() => selectMany(ids, !allSelected)}
              className="rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
            >
              {allSelected ? '取消全选' : '全选当前分组'}
            </button>
          )}
        </div>
        {totalCount === 0 ? (
          <div
            className="rounded-md border border-dashed border-[var(--border-color)] px-3 py-3 text-center text-[11.5px]"
            style={{ color: 'var(--text-muted)' }}
          >
            暂无内容
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {items.map((group) => group.list.map((it) => renderRow(group.kind, it)))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3" data-tour="skill-memory-manage-panel">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--border-color)] px-2.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
        <button
          type="button"
          onClick={() => setCreating({ kind: 'memory', scope: 'user' })}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--border-color)] px-2.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Plus className="h-3.5 w-3.5" />
          新建我的 Memory
        </button>
        <button
          type="button"
          onClick={() => setCreating({ kind: 'skill', scope: 'user' })}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--border-color)] px-2.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Plus className="h-3.5 w-3.5" />
          新建我的 Skill
        </button>
        {allSelfIds.length > 0 && (
          <button
            type="button"
            onClick={() => selectMany(allSelfIds, !allSelfIds.every((id) => selectedIds.has(id)))}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--border-color)] px-2.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            {allSelfIds.every((id) => selectedIds.has(id)) ? '取消全选我的' : '全选我的'}
          </button>
        )}
        <span className="ml-auto text-[12px]" style={{ color: 'var(--text-muted)' }}>
          已选 {selectedManageable.length} 条 (可管理)
        </span>
      </div>

      {selectedManageable.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-3 py-2"
        >
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
            批量操作 ({selectedManageable.length} 条):
          </span>
          <button
            type="button"
            onClick={() => setBatchAccessOpen(true)}
            className="inline-flex h-7 items-center gap-1 rounded border border-[var(--border-color)] bg-[var(--bg-card)] px-2 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Eye className="h-3.5 w-3.5" />
            批量修改权限
          </button>
          <button
            type="button"
            onClick={() => setBatchMoveOpen(true)}
            className="inline-flex h-7 items-center gap-1 rounded border border-[var(--border-color)] bg-[var(--bg-card)] px-2 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            批量移动
          </button>
          <button
            type="button"
            onClick={handleBatchDelete}
            className="inline-flex h-7 items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-2 text-[11.5px] text-red-300 transition-colors hover:bg-red-500/15"
          >
            <Trash2 className="h-3.5 w-3.5" />
            批量删除
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto inline-flex h-7 items-center rounded px-2 text-[11.5px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          >
            取消选择
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      {notice && (
        <div className="inline-flex items-center gap-1.5 self-start rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1.5 text-[12px] text-emerald-300">
          <Check className="h-3.5 w-3.5" />
          {notice}
        </div>
      )}

      {loading && !inventory && (
        <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          加载中…
        </div>
      )}

      {inventory && (
        <>
          {/* 规则 1, 2: 自己的用户级 — 可批量改权限 + 可增删改移 */}
          {renderSection(
            `我的用户级 (${selfUserScope?.user_id ?? ''})`,
            '完整管理: 添加、查看、修改权限、移动、删除; 支持批量改权限',
            [
              { kind: 'memory', list: selfUserScope?.memories ?? [] },
              { kind: 'skill', list: selfUserScope?.skills ?? [] },
            ],
            true,
            [
              ...(selfUserScope?.memories ?? []).filter((m) => m.can_manage).map((m) => m.id),
              ...(selfUserScope?.skills ?? []).filter((s) => s.can_manage).map((s) => s.id),
            ],
          )}

          {/* 规则 3: 自己项目的项目级 — 可增删改移 */}
          {ownProjects.map((scope) => renderSection(
            `我创建的项目: ${scope.project_name}`,
            scope.project_id,
            [
              { kind: 'memory', list: scope.memories },
              { kind: 'skill', list: scope.skills },
            ],
            true,
            [
              ...scope.memories.filter((m) => m.can_manage).map((m) => m.id),
              ...scope.skills.filter((s) => s.can_manage).map((s) => s.id),
            ],
          ))}

          {/* 规则 4: 他人用户级 — 只读 */}
          {othersUserScopes.length > 0 && (
            <div className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              以下为他人用户级 Skill / Memory, 仅可查看, 不可添加、修改权限、移动或删除.
            </div>
          )}
          {othersUserScopes.map((scope) => renderSection(
            `他人用户级 (${scope.owner_id})`,
            '只读: 不可修改权限、移动或删除',
            [
              { kind: 'memory', list: scope.memories },
              { kind: 'skill', list: scope.skills },
            ],
            false,
          ))}

          {/* 规则 5: 他人项目的项目级 — 只读 */}
          {othersProjects.length > 0 && (
            <div className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              以下为他人项目的项目级 Skill / Memory, 仅可查看, 不可添加、修改权限、移动或删除.
            </div>
          )}
          {othersProjects.map((scope) => renderSection(
            `他人项目: ${scope.project_name}`,
            `创建者: ${scope.project_created_by ?? '(未知)'} · 只读`,
            [
              { kind: 'memory', list: scope.memories },
              { kind: 'skill', list: scope.skills },
            ],
            false,
          ))}
        </>
      )}

      {editingItem && (
        <MigrationItemEditModal
          kind={editingItem.kind}
          item={editingItem.item}
          onClose={() => setEditingItem(null)}
          onSaved={() => {
            setEditingItem(null)
            refresh()
          }}
        />
      )}

      {creating && (
        <MigrationItemEditModal
          kind={creating.kind}
          item={null}
          defaultScope={creating.scope}
          defaultProjectId={creating.project_id}
          onClose={() => setCreating(null)}
          onSaved={() => {
            setCreating(null)
            refresh()
          }}
        />
      )}

      {accessItem && (
        <MigrationItemAccessModal
          kind={accessItem.kind}
          item={accessItem.item}
          onClose={() => setAccessItem(null)}
          onSaved={() => {
            setAccessItem(null)
            refresh()
          }}
        />
      )}

      {movingItem && (
        <MigrationMoveTargetModal
          inventory={inventory}
          kind={movingItem.kind}
          item={movingItem.item}
          onClose={() => setMovingItem(null)}
          onConfirm={(targetScope, projectId) => handleMove(movingItem.kind, movingItem.item.id, targetScope, projectId)}
        />
      )}

      {batchAccessOpen && (
        <MigrationBatchAccessModal
          count={selectedManageable.length}
          onClose={() => setBatchAccessOpen(false)}
          onConfirm={(visibility) => handleBatchAccess(visibility)}
        />
      )}

      {batchMoveOpen && (
        <MigrationMoveTargetModal
          inventory={inventory}
          kind="memory"
          item={null}
          batchCount={selectedManageable.length}
          onClose={() => setBatchMoveOpen(false)}
          onConfirm={(targetScope, projectId) => handleBatchMove(targetScope, projectId)}
        />
      )}
    </div>
  )
}

function MigrationItemEditModal({
  kind,
  item,
  defaultScope,
  defaultProjectId,
  onClose,
  onSaved,
}: {
  kind: 'memory' | 'skill'
  item: MigrationInventoryItem | null
  defaultScope?: 'user' | 'project'
  defaultProjectId?: string
  onClose: () => void
  onSaved: () => void
}) {
  const isCreate = !item
  const [name, setName] = useState(item?.name ?? '')
  const [description, setDescription] = useState(item?.description ?? '')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!item || kind !== 'memory') return
    let alive = true
    api(`/api/memories/${encodeURIComponent(item.id)}`)
      .then((data: any) => { if (alive) setBody(data?.body ?? '') })
      .catch((e: any) => { if (alive) setError(e?.message || String(e)) })
    return () => { alive = false }
  }, [item, kind])

  const handleSave = async () => {
    if (!name.trim()) {
      setError('name 不能为空')
      return
    }
    setSaving(true)
    setError('')
    try {
      if (kind === 'memory') {
        if (isCreate) {
          const payload: any = { name, description, body }
          if (defaultScope === 'project' && defaultProjectId) {
            // 项目级 memory 直接走项目路由
            await api(`/api/projects/${encodeURIComponent(defaultProjectId)}/memories`, {
              method: 'POST', body: JSON.stringify(payload),
            })
          } else {
            await api('/api/memories', { method: 'POST', body: JSON.stringify(payload) })
          }
        } else {
          await api(`/api/memories/${encodeURIComponent(item!.id)}`, {
            method: 'PATCH', body: JSON.stringify({ name, description, body }),
          })
        }
      } else {
        // skill 编辑只支持改名 / 描述, body 由 SKILL.md 文件组成, 不在此处编辑.
        if (isCreate) {
          await api('/api/skills', { method: 'POST', body: JSON.stringify({ name }) })
        } else if (item) {
          await api(`/api/skills/${encodeURIComponent(item.id)}`, {
            method: 'PATCH', body: JSON.stringify({ name, description }),
          })
        }
      }
      onSaved()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-2xl flex-col gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h4 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {isCreate ? `新建 ${kind === 'memory' ? 'Memory' : 'Skill'}` : `编辑 ${kind === 'memory' ? 'Memory' : 'Skill'}`}
          </h4>
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          >
            关闭
          </button>
        </div>
        {error && (
          <div className="rounded-md border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-[12px] text-red-300">
            {error}
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 rounded-md border border-[var(--input-border)] bg-[var(--input-bg)] px-3 text-[13px]"
            style={{ color: 'var(--text-primary)' }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>描述</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="一句话描述 (可空)"
            className="h-9 rounded-md border border-[var(--input-border)] bg-[var(--input-bg)] px-3 text-[13px]"
            style={{ color: 'var(--text-primary)' }}
          />
        </label>
        {kind === 'memory' && (
          <label className="flex min-h-0 flex-1 flex-col gap-1">
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>正文 (Markdown)</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              className="min-h-[200px] w-full flex-1 resize-y rounded-md border border-[var(--input-border)] bg-[var(--input-bg)] p-2 font-mono text-[12px]"
              style={{ color: 'var(--text-primary)' }}
            />
          </label>
        )}
        {kind === 'skill' && (
          <div className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            Skill 的多文件结构不在面板内编辑. 创建会调用 npx 安装; 已存在的 Skill 可改名称与描述, body 请在文件系统中编辑.
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-md border border-[var(--border-color)] px-3 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium text-white transition-colors disabled:opacity-50"
            style={{ background: '#2563eb' }}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

function MigrationItemAccessModal({
  kind,
  item,
  onClose,
  onSaved,
}: {
  kind: 'memory' | 'skill'
  item: MigrationInventoryItem
  onClose: () => void
  onSaved: () => void
}) {
  const baseUrl = kind === 'memory' ? '/api/memories' : '/api/skills'
  const kindLabel = kind === 'memory' ? 'Memory' : 'Skill'
  const [visibility, setVisibility] = useState<string>(item.visibility || (item.scope === 'project' ? 'inherit' : 'private'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const options = item.scope === 'project'
    ? [
        { value: 'inherit', label: '继承项目', description: '跟随所属项目的可见性。' },
        { value: 'private', label: '仅自己', description: '只有创建者和管理员可见。' },
        { value: 'team', label: '同组', description: '同一群组用户可见。' },
        { value: 'public', label: '公开', description: '所有登录用户可见。' },
        { value: 'allowlist', label: '指定用户', description: '只有创建者、管理员和允许名单中的用户可见。' },
      ]
    : [
        { value: 'private', label: '仅自己', description: '只有创建者和管理员可见。' },
        { value: 'team', label: '同组', description: '同一群组用户可见。' },
        { value: 'public', label: '公开', description: '所有登录用户可见。' },
        { value: 'allowlist', label: '指定用户', description: '只有创建者、管理员和允许名单中的用户可见。' },
      ]

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      await api(`${baseUrl}/${encodeURIComponent(item.id)}/access`, {
        method: 'PATCH',
        body: JSON.stringify({ visibility }),
      })
      onSaved()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex w-full max-w-lg flex-col gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h4 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            修改权限 · {kindLabel}
          </h4>
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          >
            关闭
          </button>
        </div>
        <div className="truncate text-[12px]" style={{ color: 'var(--text-muted)' }}>
          目标: {item.name} ({item.id})
        </div>
        {error && (
          <div className="rounded-md border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-[12px] text-red-300">
            {error}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {options.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition-colors"
              style={{
                background: visibility === opt.value ? 'rgba(59,130,246,0.10)' : 'transparent',
                borderColor: visibility === opt.value ? 'rgba(59,130,246,0.36)' : 'var(--border-color)',
              }}
            >
              <input
                type="radio"
                name="visibility"
                value={opt.value}
                checked={visibility === opt.value}
                onChange={() => setVisibility(opt.value)}
                className="mt-0.5 h-3.5 w-3.5"
              />
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>{opt.label}</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{opt.description}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-md border border-[var(--border-color)] px-3 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium text-white transition-colors disabled:opacity-50"
            style={{ background: '#2563eb' }}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            保存权限
          </button>
        </div>
      </div>
    </div>
  )
}

function MigrationBatchAccessModal({
  count,
  onClose,
  onConfirm,
}: {
  count: number
  onClose: () => void
  onConfirm: (visibility: string) => void
}) {
  const [visibility, setVisibility] = useState<string>('private')
  const options = [
    { value: 'private', label: '仅自己', description: '只有创建者和管理员可见' },
    { value: 'team', label: '同组', description: '同一群组用户可见' },
    { value: 'public', label: '公开', description: '所有登录用户可见' },
    { value: 'allowlist', label: '指定用户', description: '只允许指定用户列表可见' },
  ]
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex w-full max-w-lg flex-col gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h4 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            批量修改权限
          </h4>
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          >
            关闭
          </button>
        </div>
        <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          将对选中的 <span style={{ color: 'var(--text-primary)' }}>{count}</span> 条 Skill / Memory 应用统一的可见性. 项目级条目同时支持「继承项目」.
        </div>
        <div className="flex flex-col gap-1.5">
          {options.map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition-colors"
              style={{
                background: visibility === opt.value ? 'rgba(59,130,246,0.10)' : 'transparent',
                borderColor: visibility === opt.value ? 'rgba(59,130,246,0.36)' : 'var(--border-color)',
              }}
            >
              <input
                type="radio"
                name="batch-visibility"
                value={opt.value}
                checked={visibility === opt.value}
                onChange={() => setVisibility(opt.value)}
                className="mt-0.5 h-3.5 w-3.5"
              />
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>{opt.label}</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{opt.description}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-md border border-[var(--border-color)] px-3 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onConfirm(visibility)}
            className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium text-white transition-colors"
            style={{ background: '#2563eb' }}
          >
            <Save className="h-3.5 w-3.5" />
            应用到 {count} 条
          </button>
        </div>
      </div>
    </div>
  )
}

function MigrationMoveTargetModal({
  inventory,
  kind,
  item,
  batchCount,
  onClose,
  onConfirm,
}: {
  inventory: MigrationInventory | null
  kind: 'memory' | 'skill'
  item: MigrationInventoryItem | null
  batchCount?: number
  onClose: () => void
  onConfirm: (targetScope: 'user' | 'project', projectId?: string) => void
}) {
  const [targetScope, setTargetScope] = useState<'user' | 'project'>('user')
  const [projectId, setProjectId] = useState<string>('')
  const ownProjects = (inventory?.project_scopes ?? []).filter((s) => s.is_own_project)
  const kindLabel = kind === 'memory' ? 'Memory' : 'Skill'
  const targetLabel = batchCount
    ? `${batchCount} 条`
    : (item?.name ?? kindLabel)

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex w-full max-w-lg flex-col gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h4 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {batchCount ? '批量移动' : `移动 · ${kindLabel}`}
          </h4>
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          >
            关闭
          </button>
        </div>
        <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          目标: {targetLabel}. 只能移动到自己拥有的位置 (用户级 / 自己创建的项目).
        </div>
        <div className="flex flex-col gap-2">
          <label
            className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition-colors"
            style={{
              background: targetScope === 'user' ? 'rgba(59,130,246,0.10)' : 'transparent',
              borderColor: targetScope === 'user' ? 'rgba(59,130,246,0.36)' : 'var(--border-color)',
            }}
          >
            <input
              type="radio"
              name="move-target"
              checked={targetScope === 'user'}
              onChange={() => setTargetScope('user')}
              className="mt-0.5 h-3.5 w-3.5"
            />
            <div>
              <div className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>用户级</div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>移动到我的用户级 ({inventory?.current_user_id})</div>
            </div>
          </label>
          <label
            className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition-colors"
            style={{
              background: targetScope === 'project' ? 'rgba(59,130,246,0.10)' : 'transparent',
              borderColor: targetScope === 'project' ? 'rgba(59,130,246,0.36)' : 'var(--border-color)',
            }}
          >
            <input
              type="radio"
              name="move-target"
              checked={targetScope === 'project'}
              onChange={() => setTargetScope('project')}
              className="mt-0.5 h-3.5 w-3.5"
            />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>我创建的项目</div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>项目级 (继承项目可见性)</div>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                disabled={targetScope !== 'project' || ownProjects.length === 0}
                className="mt-1.5 h-8 w-full rounded border border-[var(--input-border)] bg-[var(--input-bg)] px-2 text-[12px]"
                style={{ color: 'var(--text-primary)' }}
              >
                <option value="">{ownProjects.length === 0 ? '(没有可写入的项目)' : '请选择项目'}</option>
                {ownProjects.map((p) => (
                  <option key={p.project_id} value={p.project_id}>{p.project_name} ({p.project_id})</option>
                ))}
              </select>
            </div>
          </label>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-md border border-[var(--border-color)] px-3 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              if (targetScope === 'project' && !projectId) return
              onConfirm(targetScope, targetScope === 'project' ? projectId : undefined)
            }}
            disabled={targetScope === 'project' && !projectId}
            className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium text-white transition-colors disabled:opacity-50"
            style={{ background: '#2563eb' }}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            移动
          </button>
        </div>
      </div>
    </div>
  )
}

function MigrationExportTab() {
  const [inventory, setInventory] = useState<MigrationInventory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedMemoryIds, setSelectedMemoryIds] = useState<Set<string>>(new Set())
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [bundle, setBundle] = useState<string>('')
  const [bundleSummary, setBundleSummary] = useState<{ total: number; memories: number; skills: number; bytes: number } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [scopeView, setScopeView] = useState<'self' | 'all'>('self')

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      const data = (await api('/api/admin/skill-memory/inventory')) as MigrationInventory
      setInventory(data)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  const toggleId = (set: Set<string>, setter: (next: Set<string>) => void, id: string) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setter(next)
  }

  const bulkSet = (
    set: Set<string>,
    setter: (next: Set<string>) => void,
    ids: string[],
    select: boolean,
  ) => {
    const next = new Set(set)
    for (const id of ids) {
      if (select) next.add(id)
      else next.delete(id)
    }
    setter(next)
  }

  const handleExport = async () => {
    if (selectedMemoryIds.size === 0 && selectedSkillIds.size === 0) {
      setError('请至少勾选一条 skill 或 memory')
      return
    }
    setExporting(true)
    setError('')
    setBundle('')
    setBundleSummary(null)
    try {
      const data = (await api('/api/admin/skill-memory/export', {
        method: 'POST',
        body: JSON.stringify({
          memory_ids: Array.from(selectedMemoryIds),
          skill_ids: Array.from(selectedSkillIds),
        }),
      })) as { ok: boolean; base64: string; summary: { total: number; memories: number; skills: number; bytes: number } }
      setBundle(data.base64)
      setBundleSummary(data.summary)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setExporting(false)
    }
  }

  const copyToClipboard = async () => {
    if (!bundle) return
    try {
      await navigator.clipboard.writeText(bundle)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (e: any) {
      setError(`复制失败: ${e?.message || String(e)}`)
    }
  }

  const totalSelected = selectedMemoryIds.size + selectedSkillIds.size

  const visibleProjectScopes =
    scopeView === 'all'
      ? (inventory?.project_scopes ?? []).filter((s) => s.memories.length > 0 || s.skills.length > 0)
      : []

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-[var(--border-color)] px-2.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新清单
        </button>
        <div className="flex rounded-md border border-[var(--border-color)] p-0.5">
          <button
            type="button"
            onClick={() => setScopeView('self')}
            className="inline-flex h-7 items-center gap-1 rounded px-2.5 text-[12px] font-medium transition-colors"
            style={{
              background: scopeView === 'self' ? 'var(--bg-hover)' : 'transparent',
              color: scopeView === 'self' ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            显示自己
          </button>
          <button
            type="button"
            onClick={() => setScopeView('all')}
            className="inline-flex h-7 items-center gap-1 rounded px-2.5 text-[12px] font-medium transition-colors"
            style={{
              background: scopeView === 'all' ? 'var(--bg-hover)' : 'transparent',
              color: scopeView === 'all' ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            显示全部
          </button>
        </div>
        <span className="text-[12px] ml-auto" style={{ color: 'var(--text-muted)' }}>
          已勾选 {totalSelected} 条 (Memory {selectedMemoryIds.size} / Skill {selectedSkillIds.size})
        </span>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      {loading && !inventory && (
        <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          加载清单中…
        </div>
      )}

      {inventory && (
        <>
          <MigrationScopeBlock
            title={`用户级 (${inventory.user_scope.user_id})`}
            memories={inventory.user_scope.memories}
            skills={inventory.user_scope.skills}
            selectedMemoryIds={selectedMemoryIds}
            selectedSkillIds={selectedSkillIds}
            onToggleMemory={(id) => toggleId(selectedMemoryIds, setSelectedMemoryIds, id)}
            onToggleSkill={(id) => toggleId(selectedSkillIds, setSelectedSkillIds, id)}
            onBulkMemory={(ids, sel) => bulkSet(selectedMemoryIds, setSelectedMemoryIds, ids, sel)}
            onBulkSkill={(ids, sel) => bulkSet(selectedSkillIds, setSelectedSkillIds, ids, sel)}
          />

          {visibleProjectScopes.map((scope) => (
            <MigrationScopeBlock
              key={scope.project_id}
              title={`项目: ${scope.project_name}`}
              subtitle={scope.project_id}
              memories={scope.memories}
              skills={scope.skills}
              selectedMemoryIds={selectedMemoryIds}
              selectedSkillIds={selectedSkillIds}
              onToggleMemory={(id) => toggleId(selectedMemoryIds, setSelectedMemoryIds, id)}
              onToggleSkill={(id) => toggleId(selectedSkillIds, setSelectedSkillIds, id)}
              onBulkMemory={(ids, sel) => bulkSet(selectedMemoryIds, setSelectedMemoryIds, ids, sel)}
              onBulkSkill={(ids, sel) => bulkSet(selectedSkillIds, setSelectedSkillIds, ids, sel)}
            />
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExport}
              disabled={exporting || totalSelected === 0}
              className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-white transition-colors disabled:opacity-50"
              style={{ background: '#2563eb' }}
            >
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              生成 base64 字符串
            </button>
            {bundleSummary && (
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                共 {bundleSummary.total} 条 (Memory {bundleSummary.memories} / Skill {bundleSummary.skills}) · {bundleSummary.bytes} bytes
              </span>
            )}
          </div>

          {bundle && (
            <div className="flex flex-col gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] p-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  备份字符串 (base64)
                </span>
                <button
                  type="button"
                  onClick={copyToClipboard}
                  className="inline-flex h-7 items-center gap-1 rounded border border-[var(--border-color)] px-2 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
              <textarea
                readOnly
                value={bundle}
                rows={6}
                className="w-full resize-y rounded border border-[var(--input-border)] bg-[var(--bg-secondary)] p-2 font-mono text-[11px]"
                style={{ color: 'var(--text-primary)' }}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function MigrationScopeBlock({
  title,
  subtitle,
  memories,
  skills,
  selectedMemoryIds,
  selectedSkillIds,
  onToggleMemory,
  onToggleSkill,
  onBulkMemory,
  onBulkSkill,
}: {
  title: string
  subtitle?: string
  memories: MigrationInventoryItem[]
  skills: MigrationInventoryItem[]
  selectedMemoryIds: Set<string>
  selectedSkillIds: Set<string>
  onToggleMemory: (id: string) => void
  onToggleSkill: (id: string) => void
  onBulkMemory: (ids: string[], select: boolean) => void
  onBulkSkill: (ids: string[], select: boolean) => void
}) {
  const allMemSelected = memories.length > 0 && memories.every((m) => selectedMemoryIds.has(m.id))
  const allSkSelected = skills.length > 0 && skills.every((s) => selectedSkillIds.has(s.id))
  const isEmpty = memories.length === 0 && skills.length === 0
  return (
    <div className="rounded-lg border border-[var(--border-color)] p-3" style={{ background: 'var(--bg-secondary)' }}>
      <div className="mb-2 flex items-center justify-between">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            {title}
          </div>
          {subtitle && (
            <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {subtitle}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {memories.length > 0 && (
            <button
              type="button"
              onClick={() => onBulkMemory(memories.map((m) => m.id), !allMemSelected)}
              className="rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
            >
              {allMemSelected ? '取消 Memory' : '全选 Memory'}
            </button>
          )}
          {skills.length > 0 && (
            <button
              type="button"
              onClick={() => onBulkSkill(skills.map((s) => s.id), !allSkSelected)}
              className="rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
            >
              {allSkSelected ? '取消 Skill' : '全选 Skill'}
            </button>
          )}
        </div>
      </div>
      {isEmpty ? (
        <div className="rounded-md border border-dashed border-[var(--border-color)] px-3 py-3 text-center text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          这个 scope 下没有 Skill / Memory.
        </div>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              <FileText className="h-3.5 w-3.5" />
              Memory ({memories.length})
            </div>
            {memories.length === 0 ? (
              <div className="rounded-md border border-dashed border-[var(--border-color)] px-2 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                无
              </div>
            ) : memories.map((m) => (
              <ChecklistRow
                key={m.id}
                checked={selectedMemoryIds.has(m.id)}
                onToggle={() => onToggleMemory(m.id)}
                title={m.name}
                subtitle={migrationItemSubtitle(m, 'memory')}
                badge="MEM"
              />
            ))}
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              <Sparkles className="h-3.5 w-3.5" />
              Skill ({skills.length})
            </div>
            {skills.length === 0 ? (
              <div className="rounded-md border border-dashed border-[var(--border-color)] px-2 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                无
              </div>
            ) : skills.map((s) => (
              <ChecklistRow
                key={s.id}
                checked={selectedSkillIds.has(s.id)}
                onToggle={() => onToggleSkill(s.id)}
                title={s.name}
                subtitle={migrationItemSubtitle(s, 'skill')}
                badge="SKILL"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function MigrationImportTab() {
  const [inventory, setInventory] = useState<MigrationInventory | null>(null)
  const [target, setTarget] = useState<MigrationImportTarget>({ kind: 'user' })
  const [bundleInput, setBundleInput] = useState('')
  const [previewItems, setPreviewItems] = useState<MigrationPreviewItem[] | null>(null)
  const [previewMeta, setPreviewMeta] = useState<{ exported_at: string; exported_by: string } | null>(null)
  const [selectedIndexes, setSelectedIndexes] = useState<Set<number>>(new Set())
  const [previewing, setPreviewing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ imported: { kind: string; name: string }[]; skipped: { kind: string; name: string; reason: string }[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    api('/api/admin/skill-memory/inventory')
      .then((data: MigrationInventory) => { if (!cancelled) setInventory(data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const handlePreview = async () => {
    if (!bundleInput.trim()) {
      setError('请粘贴 base64 备份字符串')
      return
    }
    setPreviewing(true)
    setError('')
    setPreviewItems(null)
    setPreviewMeta(null)
    setSelectedIndexes(new Set())
    setResult(null)
    try {
      const data = (await api('/api/admin/skill-memory/preview', {
        method: 'POST',
        body: JSON.stringify({ bundle: bundleInput }),
      })) as { ok: boolean; exported_at: string; exported_by: string; items: MigrationPreviewItem[] }
      setPreviewItems(data.items)
      setPreviewMeta({ exported_at: data.exported_at || '', exported_by: data.exported_by || '' })
      // 默认全选
      setSelectedIndexes(new Set(data.items.map((it) => it.index)))
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setPreviewing(false)
    }
  }

  const handleImport = async () => {
    if (!previewItems) {
      setError('请先点击「预览」')
      return
    }
    if (selectedIndexes.size === 0) {
      setError('请至少勾选一条')
      return
    }
    setImporting(true)
    setError('')
    setResult(null)
    try {
      const targetPayload = target.kind === 'project'
        ? { scope: 'project', project_id: target.project_id }
        : { scope: 'user' }
      const data = (await api('/api/admin/skill-memory/import', {
        method: 'POST',
        body: JSON.stringify({
          bundle: bundleInput,
          target: targetPayload,
          indexes: Array.from(selectedIndexes),
        }),
      })) as { ok: boolean; imported: { kind: string; name: string }[]; skipped: { kind: string; name: string; reason: string }[] }
      setResult({ imported: data.imported || [], skipped: data.skipped || [] })
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setImporting(false)
    }
  }

  const toggleIndex = (idx: number) => {
    const next = new Set(selectedIndexes)
    if (next.has(idx)) next.delete(idx)
    else next.add(idx)
    setSelectedIndexes(next)
  }

  const bulkSelect = (select: boolean, filter?: (it: MigrationPreviewItem) => boolean) => {
    if (!previewItems) return
    const next = new Set(selectedIndexes)
    for (const it of previewItems) {
      if (filter && !filter(it)) continue
      if (select) next.add(it.index)
      else next.delete(it.index)
    }
    setSelectedIndexes(next)
  }

  const targetValue = target.kind === 'user' ? '__user__' : `project:${target.project_id}`
  const onTargetChange = (value: string) => {
    if (value === '__user__') { setTarget({ kind: 'user' }); return }
    if (value.startsWith('project:')) {
      const pid = value.slice('project:'.length)
      const scope = inventory?.project_scopes.find((s) => s.project_id === pid)
      if (scope) setTarget({ kind: 'project', project_id: pid, project_name: scope.project_name })
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
          1. 粘贴 base64 备份字符串
        </label>
        <textarea
          value={bundleInput}
          onChange={(e) => setBundleInput(e.target.value)}
          placeholder="把上一步导出得到的 base64 字符串粘贴到这里"
          rows={5}
          className="w-full resize-y rounded border border-[var(--input-border)] bg-[var(--input-bg)] p-2 font-mono text-[11px]"
          style={{ color: 'var(--text-primary)' }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
          2. 选择导入目标
        </label>
        <select
          value={targetValue}
          onChange={(e) => onTargetChange(e.target.value)}
          className="h-8 rounded border border-[var(--input-border)] bg-[var(--input-bg)] px-2 text-[12px]"
          style={{ color: 'var(--text-primary)' }}
        >
          <option value="__user__">用户级 (当前管理员)</option>
          {inventory?.project_scopes.map((p) => (
            <option key={p.project_id} value={`project:${p.project_id}`}>
              项目: {p.project_name} ({p.project_id})
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handlePreview}
          disabled={previewing || !bundleInput.trim()}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
        >
          {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
          3. 预览备份内容
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      {previewItems && (
        <div className="rounded-lg border border-[var(--border-color)] p-3" style={{ background: 'var(--bg-secondary)' }}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
              4. 勾选要导入的条目 ({selectedIndexes.size} / {previewItems.length})
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => bulkSelect(true)}
                className="rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]">
                全选
              </button>
              <button type="button" onClick={() => bulkSelect(false)}
                className="rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]">
                清空
              </button>
              <button type="button" onClick={() => bulkSelect(true, (it) => it.kind === 'memory')}
                className="rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]">
                仅选 Memory
              </button>
              <button type="button" onClick={() => bulkSelect(true, (it) => it.kind === 'skill')}
                className="rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]">
                仅选 Skill
              </button>
            </div>
          </div>
          {previewMeta && (previewMeta.exported_at || previewMeta.exported_by) && (
            <div className="mb-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              来源: {previewMeta.exported_by || '(未知)'} · 导出时间: {formatAbsolute(previewMeta.exported_at) || '(未知)'}
            </div>
          )}
          <div className="grid gap-1.5 md:grid-cols-2">
            {previewItems.map((it) => (
              <ChecklistRow
                key={it.index}
                checked={selectedIndexes.has(it.index)}
                onToggle={() => toggleIndex(it.index)}
                title={it.name}
                subtitle={
                  it.kind === 'memory'
                    ? `${it.body_length ?? 0} 字符${it.description ? ' · ' + it.description : ''}`
                    : `${it.file_count ?? 0} 个文件${it.dir_name ? ' · ' + it.dir_name : ''}${it.description ? ' · ' + it.description : ''}`
                }
                badge={it.kind === 'memory' ? 'MEM' : 'SKILL'}
              />
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleImport}
              disabled={importing || selectedIndexes.size === 0}
              className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium text-white transition-colors disabled:opacity-50"
              style={{ background: '#16a34a' }}
            >
              {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              5. 导入到 {target.kind === 'user' ? '用户级' : `项目「${target.project_name}」`}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="rounded-lg border border-[var(--border-color)] p-3" style={{ background: 'var(--bg-secondary)' }}>
          <div className="mb-2 flex items-center gap-2 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            <FolderOpen className="h-4 w-4" />
            导入结果
          </div>
          <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            成功 {result.imported.length} 条, 跳过 {result.skipped.length} 条
          </div>
          {result.imported.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[11.5px]" style={{ color: 'var(--text-primary)' }}>
              {result.imported.map((it, i) => (
                <li key={i}>
                  <span className="mr-1 rounded bg-[var(--bg-hover)] px-1 py-px text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {it.kind === 'memory' ? 'MEM' : 'SKILL'}
                  </span>
                  {it.name}
                </li>
              ))}
            </ul>
          )}
          {result.skipped.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              {result.skipped.map((it, i) => (
                <li key={i}>
                  <span className="mr-1 rounded bg-[var(--bg-hover)] px-1 py-px text-[10px]">
                    {it.kind === 'memory' ? 'MEM' : 'SKILL'}
                  </span>
                  {it.name} — {it.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function AdminTextRedactionPanel() {
  const [rules, setRules] = useState<TextRedactionRule[]>(() => readTextRedactionRules())
  const [globallyEnabled, setGloballyEnabled] = useState<boolean>(() => readTextRedactionEnabled())
  const [newKeyword, setNewKeyword] = useState('')
  const [newReplacement, setNewReplacement] = useState('')
  const [importDraft, setImportDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [pushing, setPushing] = useState(false)
  const [globalUpdatedAt, setGlobalUpdatedAt] = useState<string | null>(null)
  const [globalUpdatedBy, setGlobalUpdatedBy] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const isAdmin = useStore((s) => s.user?.role === 'admin')

  useEffect(() => {
    const reload = () => setRules(readTextRedactionRules())
    const reloadEnabled = () => setGloballyEnabled(readTextRedactionEnabled())
    const handleStorage = (event: StorageEvent) => {
      if (event.key === TEXT_REDACTION_STORAGE_KEY) reload()
      if (event.key === TEXT_REDACTION_ENABLED_STORAGE_KEY) reloadEnabled()
    }

    window.addEventListener(TEXT_REDACTION_RULES_EVENT, reload)
    window.addEventListener(TEXT_REDACTION_ENABLED_EVENT, reloadEnabled)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(TEXT_REDACTION_RULES_EVENT, reload)
      window.removeEventListener(TEXT_REDACTION_ENABLED_EVENT, reloadEnabled)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    let cancelled = false
    syncTextRedactionGlobalOnStartup()
      .then((payload) => {
        if (cancelled || !payload) return
        setGlobalUpdatedAt(payload.updatedAt)
        setGlobalUpdatedBy(payload.updatedBy)
        setRules(readTextRedactionRules())
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const activeCount = useMemo(() => (
    rules.filter((rule) => rule.enabled && rule.keyword.trim()).length
  ), [rules])

  const persistRules = (nextRules: TextRedactionRule[], message: string) => {
    const saved = writeTextRedactionRules(nextRules)
    setRules(saved)
    setNotice(message)
  }

  const importRulesFromText = (text: string, sourceLabel = '文本') => {
    const summary = parseTextRedactionImport(text)
    if (summary.rules.length === 0) {
      setNotice(summary.skipped > 0 ? `${sourceLabel}中没有可导入的有效规则` : '请先填写或选择要导入的规则')
      return
    }

    const merged = mergeTextRedactionRules(rules, summary.rules)
    persistRules(
      merged.rules,
      `${sourceLabel}导入完成：新增 ${merged.added} 条，更新 ${merged.updated} 条${summary.skipped > 0 ? `，跳过 ${summary.skipped} 条` : ''}`,
    )
    setImportDraft('')
  }

  const importRulesFromFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      importRulesFromText(String(reader.result || ''), file.name)
    }
    reader.onerror = () => setNotice('文件读取失败，请换一个文件再试')
    reader.readAsText(file, 'utf-8')
  }

  const downloadRules = (format: 'json' | 'csv') => {
    if (rules.length === 0) {
      setNotice('当前没有可导出的规则')
      return
    }

    const content = format === 'json'
      ? exportTextRedactionRulesJson(rules)
      : exportTextRedactionRulesCsv(rules)
    const type = format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8'
    const blob = new Blob([content], { type })
    const url = window.URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    anchor.href = url
    anchor.download = `text-redaction-rules-${stamp}.${format}`
    anchor.click()
    window.URL.revokeObjectURL(url)
    setNotice(`已导出 ${rules.length} 条规则`)
  }

  const addRule = () => {
    const keyword = newKeyword.trim()
    if (!keyword) {
      setNotice('请先填写关键词')
      return
    }

    if (rules.some((rule) => rule.keyword.trim() === keyword)) {
      setNotice('这个关键词已经在列表中')
      return
    }

    persistRules([
      ...rules,
      {
        id: createTextRedactionRuleId(),
        keyword,
        replacement: newReplacement,
        enabled: true,
      },
    ], '规则已添加并立即生效')
    setNewKeyword('')
    setNewReplacement('')
  }

  const updateRule = (id: string, patch: Partial<TextRedactionRule>) => {
    setRules((prev) => prev.map((rule) => (
      rule.id === id ? { ...rule, ...patch } : rule
    )))
  }

  const deleteRule = (id: string) => {
    persistRules(rules.filter((rule) => rule.id !== id), '规则已删除并立即生效')
  }

  const clearRules = () => {
    if (rules.length === 0) return
    const ok = window.confirm('清空全部文字替换规则？')
    if (!ok) return
    persistRules([], '已清空全部规则')
  }

  const toggleGlobalEnabled = () => {
    const next = writeTextRedactionEnabled(!globallyEnabled)
    setGloballyEnabled(next)
    setNotice(next ? '已切换到隐藏模式，规则继续生效' : '已切换到正常模式，全部规则保留未删除')
  }

  const pushGlobalRules = async () => {
    if (rules.length === 0) {
      setNotice('当前没有可推送的规则')
      return
    }
    const ok = window.confirm(
      `将当前 ${rules.length} 条规则推送到后端？\n所有用户登录后会用这套规则覆盖本地，达到全员强制替换。`,
    )
    if (!ok) return
    setPushing(true)
    try {
      const payload = await pushTextRedactionRulesToBackend(rules)
      setGlobalUpdatedAt(payload.updatedAt)
      setGlobalUpdatedBy(payload.updatedBy)
      setNotice(`已推送 ${payload.rules.length} 条规则，其他用户下次进入应用时同步`)
    } catch (e: any) {
      setNotice(e?.message ? `推送失败: ${e.message}` : '推送失败')
    } finally {
      setPushing(false)
    }
  }

  return (
    <section
      data-text-redaction-ignore="true"
      className="overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-color)] px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <EyeOff className="h-4 w-4 text-cyan-400" />
            <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>文字替换隐藏</h3>
          </div>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            临时用于录屏隐藏敏感文字，规则只保存在当前浏览器，可随时清空。关闭后全部规则都会保留，不会被删除。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={globallyEnabled}
            onClick={toggleGlobalEnabled}
            disabled={rules.length === 0}
            className="inline-flex h-8 items-center gap-2 rounded-md border border-[var(--border-color)] px-2.5 text-[12px] font-medium transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: 'var(--text-primary)' }}
            title={rules.length === 0 ? '请先添加至少一条规则' : undefined}
          >
            {globallyEnabled ? <EyeOff className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} /> : <Eye className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />}
            <span>{globallyEnabled ? '隐藏模式 · 已开启' : '正常模式 · 已关闭'}</span>
            <span
              className="relative h-4 w-7 shrink-0 rounded-full border transition-colors"
              style={{
                background: globallyEnabled ? 'color-mix(in srgb, var(--accent-primary) 28%, transparent)' : 'var(--input-bg)',
                borderColor: globallyEnabled ? 'color-mix(in srgb, var(--accent-primary) 46%, var(--border-color))' : 'var(--border-color-strong)',
              }}
            >
              <span
                className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-transform"
                style={{
                  left: 2,
                  background: globallyEnabled ? 'var(--accent-primary)' : 'var(--text-muted)',
                  transform: globallyEnabled ? 'translate(14px, -50%)' : 'translate(0, -50%)',
                }}
              />
            </span>
          </button>
          <span className="rounded-md border border-[var(--border-color)] px-2 py-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            规则 {rules.length} 条{globallyEnabled ? `（启用 ${activeCount}）` : ''}
          </span>
          <button
            type="button"
            onClick={() => downloadRules('json')}
            disabled={rules.length === 0}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] font-medium transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: 'var(--text-secondary)' }}
          >
            <Download className="h-3.5 w-3.5" />
            导出
          </button>
          <button
            type="button"
            onClick={() => persistRules(rules, '规则已保存并立即生效')}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-cyan-500/35 bg-cyan-500/10 px-3 text-[12px] font-medium text-cyan-300 transition-colors hover:bg-cyan-500/15"
          >
            <Save className="h-3.5 w-3.5" />
            保存规则
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={pushGlobalRules}
              disabled={pushing || rules.length === 0}
              title="把当前规则推送到后端，所有用户登录后会同步覆盖本地"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-500/45 bg-amber-500/15 px-3 text-[12px] font-semibold text-amber-200 transition-colors hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              强制所有人替换
            </button>
          )}
          <button
            type="button"
            onClick={clearRules}
            disabled={rules.length === 0}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] font-medium transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: 'var(--text-secondary)' }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            清空
          </button>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-[12px] leading-5 text-cyan-100">
          替换会立即作用于页面里的普通文本、标题提示和占位提示；不会改写输入框内容，避免误保存真实数据。
          命中关键词的文本框会整体模糊（不改 value，仅视觉遮蔽）。
        </div>

        {isAdmin && globalUpdatedAt && (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[12px] leading-5 text-amber-100">
            全员规则最后更新：{formatAbsolute(globalUpdatedAt)}{globalUpdatedBy ? ` · 由 ${globalUpdatedBy}` : ''}
            <span className="ml-1 text-amber-200/70">（其他用户下次进入应用时同步）</span>
          </div>
        )}

        <form
          className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault()
            addRule()
          }}
        >
          <label className="min-w-0">
            <span className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>关键词</span>
            <input
              value={newKeyword}
              onChange={(event) => setNewKeyword(event.target.value)}
              placeholder="例如真实姓名、项目名、地址"
              className="h-9 w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 text-[13px] outline-none focus:border-cyan-500/60"
              style={{ color: 'var(--text-primary)' }}
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>替换为</span>
            <input
              value={newReplacement}
              onChange={(event) => setNewReplacement(event.target.value)}
              placeholder="例如用户A；留空表示直接隐藏"
              className="h-9 w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 text-[13px] outline-none focus:border-cyan-500/60"
              style={{ color: 'var(--text-primary)' }}
            />
          </label>
          <button
            type="submit"
            className="mt-5 inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-cyan-500 px-3 text-[12px] font-semibold text-slate-950 transition-colors hover:bg-cyan-400"
          >
            <Plus className="h-3.5 w-3.5" />
            添加规则
          </button>
        </form>

        <div className="grid gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 lg:grid-cols-[minmax(0,1fr)_260px]">
          <label className="min-w-0">
            <span className="mb-1 block text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>批量导入</span>
            <textarea
              value={importDraft}
              onChange={(event) => setImportDraft(event.target.value)}
              placeholder={'每行一条：关键词 => 替换词\n也支持 CSV：keyword,replacement,enabled\n或粘贴导出的 JSON'}
              rows={5}
              className="min-h-[118px] w-full resize-y rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-[12px] leading-5 outline-none focus:border-cyan-500/60"
              style={{ color: 'var(--text-primary)' }}
            />
          </label>
          <div className="flex min-w-0 flex-col justify-between gap-3">
            <p className="text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
              导入时按关键词合并：已存在的关键词会更新替换词，新关键词会追加。替换词留空表示直接隐藏。
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => importRulesFromText(importDraft)}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-cyan-500 px-3 text-[12px] font-semibold text-slate-950 transition-colors hover:bg-cyan-400"
              >
                <Upload className="h-3.5 w-3.5" />
                导入文本
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--text-secondary)' }}
              >
                <FileText className="h-3.5 w-3.5" />
                选择文件
              </button>
              <button
                type="button"
                onClick={() => downloadRules('json')}
                disabled={rules.length === 0}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] font-medium transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                style={{ color: 'var(--text-secondary)' }}
              >
                <Download className="h-3.5 w-3.5" />
                导出 JSON
              </button>
              <button
                type="button"
                onClick={() => downloadRules('csv')}
                disabled={rules.length === 0}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-[var(--border-color)] px-3 text-[12px] font-medium transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                style={{ color: 'var(--text-secondary)' }}
              >
                <Download className="h-3.5 w-3.5" />
                导出 CSV
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.csv,.txt,text/plain,application/json,text/csv"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) importRulesFromFile(file)
              }}
            />
          </div>
        </div>

        {notice && (
          <div className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1.5 text-[12px] text-emerald-300">
            <Check className="h-3.5 w-3.5" />
            {notice}
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-[var(--border-color)]">
          <div className="grid grid-cols-[80px_minmax(0,1fr)_minmax(0,1fr)_80px] gap-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
            <div>状态</div>
            <div>关键词</div>
            <div>替换词</div>
            <div className="text-right">操作</div>
          </div>

          {rules.length === 0 ? (
            <div className="px-3 py-8 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
              暂无规则。添加后，页面中匹配到的文字会被替换。
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-color)]">
              {rules.map((rule) => (
                <div key={rule.id} className="grid grid-cols-[80px_minmax(0,1fr)_minmax(0,1fr)_80px] items-center gap-2 px-3 py-2">
                  <label className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })}
                      className="h-3.5 w-3.5 accent-cyan-500"
                    />
                    启用
                  </label>
                  <input
                    value={rule.keyword}
                    onChange={(event) => updateRule(rule.id, { keyword: event.target.value })}
                    className="h-8 min-w-0 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 text-[12px] outline-none focus:border-cyan-500/60"
                    style={{ color: 'var(--text-primary)' }}
                  />
                  <input
                    value={rule.replacement}
                    onChange={(event) => updateRule(rule.id, { replacement: event.target.value })}
                    className="h-8 min-w-0 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 text-[12px] outline-none focus:border-cyan-500/60"
                    style={{ color: 'var(--text-primary)' }}
                  />
                  <div className="text-right">
                    <button
                      type="button"
                      title="删除规则"
                      onClick={() => deleteRule(rule.id)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-red-300 transition-colors hover:bg-red-500/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {rules.length > 0 && (
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            修改已有规则后点击“保存规则”生效；空关键词会在保存时自动移除。
          </p>
        )}
      </div>
    </section>
  )
}

type AdminPanelTab = 'users' | 'runtime' | 'redaction' | 'settings' | 'assistant' | 'models' | 'extensions' | 'migration'

const ADMIN_PANEL_TABS: { key: AdminPanelTab; label: string; icon: ReactNode }[] = [
  { key: 'users', label: '用户管理', icon: <UsersIcon className="h-3.5 w-3.5" /> },
  { key: 'runtime', label: '运行监控', icon: <LayoutDashboard className="h-3.5 w-3.5" /> },
  { key: 'redaction', label: '文字替换隐藏', icon: <EyeOff className="h-3.5 w-3.5" /> },
  { key: 'settings', label: '系统设置', icon: <Settings className="h-3.5 w-3.5" /> },
  { key: 'assistant', label: '管理员小莫配置', icon: <Sparkles className="h-3.5 w-3.5" /> },
  { key: 'models', label: '模型接入', icon: <Terminal className="h-3.5 w-3.5" /> },
  { key: 'extensions', label: '拓展管理', icon: <Puzzle className="h-3.5 w-3.5" /> },
  { key: 'migration', label: 'Skill与Memory管理', icon: <Package className="h-3.5 w-3.5" /> },
]

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<AdminPanelTab>('users')
  const [data, setData] = useState<AdminTmuxPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [closingKey, setClosingKey] = useState<string | null>(null)
  const [showClosedWindows, setShowClosedWindows] = useState(false)

  const refresh = async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const next = await api('/api/admin/tmux')
      setData(next)
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      if (!quiet) setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const timer = window.setInterval(() => refresh(true), 5000)
    return () => window.clearInterval(timer)
  }, [])

  const totals = useMemo(() => ({
    questions: data?.question_count ?? 0,
    codexQuestions: data?.questions_by_backend?.codex ?? 0,
    claudeQuestions: data?.questions_by_backend?.claude_code ?? 0,
    codexQuestions2min: data?.questions_by_backend_2min?.codex ?? 0,
    claudeQuestions2min: data?.questions_by_backend_2min?.claude_code ?? 0,
    activeWindows: data?.active_tmux_window_count ?? 0,
    codexActiveWindows: data?.active_windows_by_backend?.codex ?? data?.backends?.codex?.active_window_count ?? 0,
    claudeActiveWindows: data?.active_windows_by_backend?.claude_code ?? data?.backends?.claude_code?.active_window_count ?? 0,
    windows: data?.window_count ?? 0,
    working: data?.working_window_count ?? 0,
    closed: data?.closed_window_count ?? 0,
  }), [data])

  const closeWindow = async (backendKey: 'codex' | 'claude_code', sessionId: string) => {
    const ok = window.confirm(`关闭 ${backendKey} window ${sessionId}？`)
    if (!ok) return
    const key = `${backendKey}:${sessionId}`
    setClosingKey(key)
    try {
      await api(`/api/admin/tmux/${encodeURIComponent(backendKey)}/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      await refresh(true)
      setError('')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setClosingKey(null)
    }
  }

  const activeTabLabel = ADMIN_PANEL_TABS.find((tab) => tab.key === activeTab)?.label || '管理中心'

  return (
    <div className="flex h-screen min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-[var(--border-color)] px-5">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            title="返回"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>管理中心</h2>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {activeTabLabel}{activeTab === 'runtime' ? ` · 5s 刷新 · 统计窗口 ${data?.window_hours || 5} 小时` : ''}
            </div>
          </div>
        </div>
        {activeTab === 'runtime' && (
          <button
            type="button"
            title="刷新运行监控"
            onClick={() => refresh()}
            disabled={loading}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto flex max-w-7xl flex-col gap-4">
          <div className="flex flex-wrap gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] p-2">
            {ADMIN_PANEL_TABS.map((tab) => {
              const active = activeTab === tab.key
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition-colors"
                  style={{
                    background: active ? 'var(--bg-hover)' : 'transparent',
                    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                    border: `1px solid ${active ? 'var(--border-color)' : 'transparent'}`,
                  }}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              )
            })}
          </div>

          {activeTab === 'users' && <AdminUsersPanel />}

          {activeTab === 'redaction' && <AdminTextRedactionPanel />}

          {activeTab === 'settings' && (
            <div className="flex flex-col gap-3">
              <ModelPromptLimitsCard />
              <AdminProxyFilesCard />
            </div>
          )}

          {activeTab === 'models' && <AdminModelsPanel />}

          {activeTab === 'assistant' && (
            <div className="flex flex-col gap-3">
              <AdminAssistantCallbacksPanel />
              <AdminDoubaoVoiceCard />
              <AdminLightModelApiCard />
            </div>
          )}

          {activeTab === 'extensions' && <HiddenExtensionsCard />}

          {activeTab === 'migration' && <SkillMemoryMigrationPanel />}

          {activeTab === 'runtime' && error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-[13px] text-red-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}

          {activeTab === 'runtime' && (
            <>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
                <StatTile
                  icon={<MessageSquare className="h-4 w-4 text-cyan-400" />}
                  label="5小时提问"
                  value={totals.questions}
                  sub={data?.since ? `自 ${formatAbsolute(data.since)}` : undefined}
                />
                <StatTile
                  icon={<Terminal className="h-4 w-4 text-sky-400" />}
                  label="Codex 提问"
                  value={totals.codexQuestions}
                  sub="tmux-codex"
                />
                <StatTile
                  icon={<Terminal className="h-4 w-4 text-violet-400" />}
                  label="Claude 提问"
                  value={totals.claudeQuestions}
                  sub="tmux-claude-code"
                />
                <StatTile
                  icon={<Terminal className="h-4 w-4 text-sky-400" />}
                  label="Codex 2分钟"
                  value={totals.codexQuestions2min}
                  sub="tmux-codex · 近2分钟"
                />
                <StatTile
                  icon={<Terminal className="h-4 w-4 text-violet-400" />}
                  label="Claude 2分钟"
                  value={totals.claudeQuestions2min}
                  sub="tmux-claude-code · 近2分钟"
                />
                <StatTile
                  icon={<Terminal className="h-4 w-4 text-sky-400" />}
                  label="Codex 活跃窗口"
                  value={totals.codexActiveWindows}
                  sub="当前 tmux-codex"
                />
                <StatTile
                  icon={<Terminal className="h-4 w-4 text-violet-400" />}
                  label="Claude 活跃窗口"
                  value={totals.claudeActiveWindows}
                  sub="当前 tmux-claude-code"
                />
                <StatTile
                  icon={<Server className="h-4 w-4 text-amber-400" />}
                  label="Agent Window"
                  value={totals.windows}
                  sub={`活跃 ${totals.activeWindows} · 不含 hub root`}
                />
                <StatTile
                  icon={<Activity className="h-4 w-4 text-emerald-400" />}
                  label="执行中"
                  value={totals.working}
                  sub={<span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />实时状态</span>}
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2">
                <div className="flex min-w-0 items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  {showClosedWindows ? <Eye className="h-3.5 w-3.5 text-sky-400" /> : <EyeOff className="h-3.5 w-3.5 text-[var(--text-muted)]" />}
                  <span>Closed 窗口</span>
                  <span className="rounded-md border border-[var(--border-color)] px-2 py-0.5 text-[11px]" style={{ color: 'var(--text-primary)' }}>
                    {totals.closed}
                  </span>
                </div>
                <ToggleSwitch
                  checked={showClosedWindows}
                  onChange={setShowClosedWindows}
                  switchPosition="end"
                  activeColor="#0ea5e9"
                  className="inline-flex h-8 items-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
                  style={{ color: 'var(--text-secondary)' }}
                  title="显示或隐藏已关闭的 Codex / Claude Code 窗口">
                  显示已关闭
                </ToggleSwitch>
              </div>

              <BackendSection
                title="Codex"
                accent="#38bdf8"
                backend={data?.backends?.codex}
                closingKey={closingKey}
                showClosedWindows={showClosedWindows}
                onCloseWindow={closeWindow}
              />
              <BackendSection
                title="Claude Code"
                accent="#a78bfa"
                backend={data?.backends?.claude_code}
                closingKey={closingKey}
                showClosedWindows={showClosedWindows}
                onCloseWindow={closeWindow}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
