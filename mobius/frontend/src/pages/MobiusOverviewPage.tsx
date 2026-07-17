import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Activity,
  ArrowUpRight,
  CircleDot,
  FlaskConical,
  GitBranch,
  MessageSquare,
  PanelRightClose,
  Search,
  Sparkles,
} from 'lucide-react'
import { api, useStore } from '../store'
import { TopNav, timeAgoPrecise } from '../components/shell'

type EntityKind = 'project' | 'issue' | 'research' | 'session'

type GraphNode = {
  id: string
  kind: EntityKind
  title: string
  description?: string
  status?: string
  parentId?: string
  projectId?: string
  source: any
  x: number
  y: number
  width: number
  height: number
}

type GraphEdge = {
  id: string
  from: string
  to: string
}

type ProjectGraphData = {
  issues: any[]
  researches: any[]
  sessionsByIssue: Record<string, any[]>
  sessionsByResearch: Record<string, any[]>
}

type TimeRangeKey = '24h' | '48h' | '72h' | '7d' | '30d'

const NODE_SIZES = {
  project: { width: 260, height: 38 },
  subject: { width: 260, height: 34 },
  session: { width: 260, height: 32 },
}
const NODE_DOT_SIZE = 18

const EMPTY_GRAPH_DATA: ProjectGraphData = {
  issues: [],
  researches: [],
  sessionsByIssue: {},
  sessionsByResearch: {},
}

const TIME_RANGE_OPTIONS: Array<{ key: TimeRangeKey; label: string; ms: number }> = [
  { key: '24h', label: '24小时', ms: 24 * 60 * 60 * 1000 },
  { key: '48h', label: '48小时', ms: 48 * 60 * 60 * 1000 },
  { key: '72h', label: '72小时', ms: 72 * 60 * 60 * 1000 },
  { key: '7d', label: '1周', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '1月', ms: 30 * 24 * 60 * 60 * 1000 },
]

function activeTimeMs(item: any) {
  const value = item?.last_session_activity_at || item?.last_active || item?.updated_at || item?.created_at
  const ms = new Date(value || 0).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function sortByRecent(items: any[]) {
  return [...(items || [])].sort((a: any, b: any) => activeTimeMs(b) - activeTimeMs(a))
}

function isActiveWithin(item: any, cutoffMs: number) {
  return activeTimeMs(item) >= cutoffMs
}

function filterGraphDataByActivity(data: ProjectGraphData, cutoffMs: number): ProjectGraphData {
  const sessionsByIssue: Record<string, any[]> = {}
  const sessionsByResearch: Record<string, any[]> = {}
  const issues = (data.issues || []).filter((issue: any) => {
    const sessions = sortByRecent((data.sessionsByIssue[issue.id] || []).filter((session: any) => isActiveWithin(session, cutoffMs)))
    if (sessions.length === 0) return false
    sessionsByIssue[issue.id] = sessions
    return true
  })
  const researches = (data.researches || []).filter((research: any) => {
    const sessions = sortByRecent((data.sessionsByResearch[research.id] || []).filter((session: any) => isActiveWithin(session, cutoffMs)))
    if (sessions.length === 0) return false
    sessionsByResearch[research.id] = sessions
    return true
  })
  return { issues, researches, sessionsByIssue, sessionsByResearch }
}

function projectMatchesSearch(project: any, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return String(project?.name || '').toLowerCase().includes(q)
    || String(project?.description || '').toLowerCase().includes(q)
    || String(project?.id || '').toLowerCase().includes(q)
}

function statusLabel(value: any) {
  if (value === 'completed') return '已完成'
  if (value === 'archived') return '已归档'
  if (value === 'running') return '运行中'
  if (value === 'stale') return '停滞'
  if (value === 'idle') return '空闲'
  return '进行中'
}

function kindLabel(kind: EntityKind, role?: string | null) {
  if (kind === 'project') return 'Project'
  if (kind === 'issue') return 'Issue'
  if (kind === 'research') return 'Research'
  if (role === 'chief_researcher') return 'Chief Researcher'
  if (role === 'research_assistant') return 'Research Agent'
  return 'Session'
}

function nodeAccent(kind: EntityKind, source?: any) {
  if (kind === 'project') return '#22c55e'
  if (kind === 'research') return '#a855f7'
  if (kind === 'issue') return '#38bdf8'
  if (source?.agent_status === 'running') return '#f59e0b'
  if (source?.job_failed) return '#ef4444'
  if (source?.job_accomplished || source?.status === 'completed') return '#22c55e'
  return '#94a3b8'
}

function compactCount(value: any) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1000) return `${Math.floor(n / 100) / 10}k`
  return String(n)
}

function getNodePath(userParam: string, node: GraphNode) {
  const projectId = node.projectId || node.source?.project_id || node.source?.id
  if (!userParam || !projectId) return ''
  const base = `/u/${encodeURIComponent(userParam)}/p/${encodeURIComponent(projectId)}`
  if (node.kind === 'project') return base
  if (node.kind === 'issue') return `${base}/i/${encodeURIComponent(node.id)}`
  if (node.kind === 'research') return `${base}/r/${encodeURIComponent(node.id)}`
  if (node.source?.scope_type === 'research' && node.source?.research_id) {
    return `${base}/r/${encodeURIComponent(node.source.research_id)}?session=${encodeURIComponent(node.id)}`
  }
  if (node.source?.issue_id) {
    return `${base}/i/${encodeURIComponent(node.source.issue_id)}?session=${encodeURIComponent(node.id)}`
  }
  return ''
}

function edgePath(from: GraphNode, to: GraphNode) {
  const x1 = from.x + NODE_DOT_SIZE
  const y1 = from.y + from.height / 2
  const x2 = to.x
  const y2 = to.y + to.height / 2
  const dx = Math.max(80, x2 - x1)
  const curve = Math.max(64, dx * 0.5)
  const sameLineBow = Math.abs(y2 - y1) < 8 ? 18 : 0
  return `M ${x1} ${y1} C ${x1 + curve} ${y1 + sameLineBow}, ${x2 - curve} ${y2 - sameLineBow}, ${x2} ${y2}`
}

function buildGraph(project: any, data: ProjectGraphData): { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number } {
  if (!project?.id) return { nodes: [], edges: [], width: 900, height: 560 }

  const parentX = 330
  const childX = 610
  const startY = 44
  const minGroupHeight = 44
  const childGap = 38
  const groupGap = 24
  const parentItems = [
    ...sortByRecent(data.issues).map((item) => ({ kind: 'issue' as const, item, children: data.sessionsByIssue[item.id] || [] })),
    ...sortByRecent(data.researches).map((item) => ({ kind: 'research' as const, item, children: data.sessionsByResearch[item.id] || [] })),
  ].sort((a, b) => activeTimeMs(b.item) - activeTimeMs(a.item))

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let cursor = startY

  parentItems.forEach(({ kind, item, children }) => {
    const sortedChildren = sortByRecent(children)
    const groupHeight = Math.max(minGroupHeight, Math.max(1, sortedChildren.length) * childGap)
    const parentY = cursor + groupHeight / 2 - NODE_SIZES.subject.height / 2
    nodes.push({
      id: item.id,
      kind,
      title: item.title || item.id,
      description: item.description || '',
      status: item.status,
      parentId: project.id,
      projectId: project.id,
      source: item,
      x: parentX,
      y: parentY,
      width: NODE_SIZES.subject.width,
      height: NODE_SIZES.subject.height,
    })
    edges.push({ id: `${project.id}:${item.id}`, from: project.id, to: item.id })

    const childStart = cursor + groupHeight / 2 - ((sortedChildren.length - 1) * childGap + NODE_SIZES.session.height) / 2
    sortedChildren.forEach((session: any, idx: number) => {
      const sessionId = session.session_id || session.id
      nodes.push({
        id: sessionId,
        kind: 'session',
        title: session.name || sessionId,
        description: session.description || '',
        status: session.agent_status || session.status,
        parentId: item.id,
        projectId: project.id,
        source: session,
        x: childX,
        y: childStart + idx * childGap,
        width: NODE_SIZES.session.width,
        height: NODE_SIZES.session.height,
      })
      edges.push({ id: `${item.id}:${sessionId}`, from: item.id, to: sessionId })
    })

    cursor += groupHeight + groupGap
  })

  const contentHeight = Math.max(560, cursor + 60)
  const projectNode: GraphNode = {
    id: project.id,
    kind: 'project',
    title: project.name || project.id,
    description: project.description || '',
    status: project.disabled ? 'archived' : 'active',
    projectId: project.id,
    source: project,
    x: 72,
    y: contentHeight / 2 - NODE_SIZES.project.height / 2,
    width: NODE_SIZES.project.width,
    height: NODE_SIZES.project.height,
  }

  return {
    nodes: [projectNode, ...nodes],
    edges,
    width: 930,
    height: contentHeight,
  }
}

function NodeIcon({ kind }: { kind: EntityKind }) {
  if (kind === 'project') return <GitBranch className="h-4 w-4" />
  if (kind === 'research') return <FlaskConical className="h-4 w-4" />
  if (kind === 'issue') return <CircleDot className="h-4 w-4" />
  return <MessageSquare className="h-4 w-4" />
}

function GraphNodeButton({
  node,
  selected,
  onSelect,
}: {
  node: GraphNode
  selected: boolean
  onSelect: (node: GraphNode) => void
}) {
  const accent = nodeAccent(node.kind, node.source)
  const meta = node.kind === 'project'
    ? `${compactCount(node.source?.issue_count)} Issues · ${compactCount(node.source?.research_count)} Research`
    : node.kind === 'session'
      ? `${statusLabel(node.status)} · ${compactCount(node.source?.raw_entry_count ?? node.source?.message_count)} 条记录`
      : `${statusLabel(node.status)} · ${compactCount(node.source?.session_count)} 个会话`

  return (
    <button
      type="button"
      onClick={() => onSelect(node)}
      title={node.title}
      className={`absolute flex items-center gap-2 rounded-md px-0 py-0 text-left transition-all duration-500 hover:-translate-y-0.5 ${selected ? 'z-10' : ''}`}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        color: 'var(--text-primary)',
      }}
    >
      <span
        className={`flex flex-shrink-0 items-center justify-center rounded-full border shadow-sm transition-all duration-300 ${selected ? 'scale-125' : ''}`}
        style={{
          width: NODE_DOT_SIZE,
          height: NODE_DOT_SIZE,
          color: selected ? '#fff' : accent,
          background: selected ? accent : 'var(--bg-primary)',
          borderColor: accent,
          boxShadow: selected ? `0 0 0 5px ${accent}24` : undefined,
        }}
      >
        <span className="h-2 w-2 rounded-full" style={{ background: selected ? '#fff' : accent }} />
      </span>
      <span
        className="min-w-0 flex-1 rounded-md px-2 py-1 transition-colors"
        style={{ background: selected ? 'var(--bg-active)' : 'transparent' }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[12px] font-semibold leading-4">{node.title}</span>
          <span className="flex-shrink-0 text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>
            {kindLabel(node.kind, node.source?.research_role)}
          </span>
        </span>
        <span className="block truncate text-[10px] leading-4" style={{ color: 'var(--text-secondary)' }}>{meta}</span>
      </span>
    </button>
  )
}

function InfoRow({ label, value }: { label: string; value: any }) {
  if (value === undefined || value === null || value === '') return null
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-3 border-b py-2 text-[12px]" style={{ borderColor: 'var(--border-color)' }}>
      <div style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="min-w-0 break-words" style={{ color: 'var(--text-primary)' }}>{String(value)}</div>
    </div>
  )
}

function DetailDrawer({
  node,
  userParam,
  onClose,
}: {
  node: GraphNode | null
  userParam: string
  onClose: () => void
}) {
  const navigate = useNavigate()
  const path = node ? getNodePath(userParam, node) : ''
  const accent = node ? nodeAccent(node.kind, node.source) : 'var(--accent-primary)'

  return (
    <aside
      className={`absolute bottom-0 right-0 top-0 z-20 w-[380px] max-w-[calc(100vw-24px)] border-l shadow-2xl transition-transform duration-300 ${node ? 'translate-x-0' : 'translate-x-full'}`}
      style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}
      aria-hidden={!node}
    >
      {node && (
        <div className="flex h-full flex-col">
          <div className="flex items-start gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--border-color)' }}>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg" style={{ color: accent, background: `${accent}1f` }}>
              <NodeIcon kind={node.kind} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {kindLabel(node.kind, node.source?.research_role)}
              </div>
              <h2 className="mt-1 break-words text-[16px] font-semibold leading-6" style={{ color: 'var(--text-primary)' }}>
                {node.title}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--text-muted)' }}
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {node.description && (
              <div className="mb-4 rounded-lg border p-3 text-[12px] leading-5" style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }}>
                {node.description}
              </div>
            )}
            <InfoRow label="状态" value={statusLabel(node.status)} />
            <InfoRow label="ID" value={node.id} />
            <InfoRow label="活跃" value={timeAgoPrecise(node.source?.last_active || '')} />
            <InfoRow label="创建" value={timeAgoPrecise(node.source?.created_at || '')} />
            <InfoRow label="模型" value={node.source?.model || node.source?.model_label} />
            <InfoRow label="语言" value={node.source?.language} />
            <InfoRow label="角色" value={node.source?.research_role} />
            <InfoRow label="消息" value={node.source?.message_count} />
            <InfoRow label="记录" value={node.source?.raw_entry_count} />
            <InfoRow label="路径" value={node.source?.bind_path} />
            {node.kind === 'session' && (
              <div className="mt-4 grid grid-cols-2 gap-2">
                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Agent</div>
                  <div className="mt-1 text-[13px] font-semibold" style={{ color: nodeAccent(node.kind, node.source) }}>{statusLabel(node.source?.agent_status)}</div>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>成本</div>
                  <div className="mt-1 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    ${Number(node.source?.total_cost_usd || 0).toFixed(4)}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="border-t p-4" style={{ borderColor: 'var(--border-color)' }}>
            <button
              type="button"
              disabled={!path}
              onClick={() => path && navigate(path)}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-md text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              style={{ color: '#fff', background: path ? 'var(--accent-primary)' : 'var(--bg-hover)' }}
            >
              <ArrowUpRight className="h-4 w-4" />
              打开
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}

export default function MobiusOverviewPage() {
  const params = useParams()
  const userParam = params.user || ''
  const {
    projects,
    setProjects,
    setCurrentProject,
    setCurrentIssue,
    setCurrentResearch,
    setCurrentSession,
    setCurrentTask,
  } = useStore()
  const [query, setQuery] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [graphDataByProject, setGraphDataByProject] = useState<Record<string, ProjectGraphData>>({})
  const [loadingProjectId, setLoadingProjectId] = useState('')
  const [error, setError] = useState('')
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [timeRange, setTimeRange] = useState<TimeRangeKey>('7d')
  const [viewportOffset, setViewportOffset] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
  const viewportOffsetRef = useRef({ x: 0, y: 0 })
  const graphCanvasRef = useRef<HTMLDivElement | null>(null)
  const panFrameRef = useRef<number | null>(null)

  const selectedRange = useMemo(
    () => TIME_RANGE_OPTIONS.find((option) => option.key === timeRange) || TIME_RANGE_OPTIONS[3],
    [timeRange],
  )
  const cutoffMs = useMemo(() => Date.now() - selectedRange.ms, [selectedRange.ms])

  useEffect(() => {
    setCurrentProject(null)
    setCurrentIssue(null)
    setCurrentResearch(null)
    setCurrentSession(null)
    setCurrentTask(null)
  }, [setCurrentProject, setCurrentIssue, setCurrentResearch, setCurrentSession, setCurrentTask])

  useEffect(() => () => {
    if (panFrameRef.current != null) cancelAnimationFrame(panFrameRef.current)
  }, [])

  useEffect(() => {
    api('/api/projects?all=true')
      .then((arr: any[]) => {
        const next = sortByRecent(arr || [])
        setProjects(next)
        setSelectedProjectId((current) => current || next[0]?.id || '')
      })
      .catch((e: any) => setError(e?.message || '项目加载失败'))
  }, [setProjects])

  const visibleProjects = useMemo(
    () => sortByRecent((projects || []).filter((project: any) => (
      !project.hidden
      && projectMatchesSearch(project, query)
      && isActiveWithin(project, cutoffMs)
    ))),
    [projects, query, cutoffMs]
  )

  const selectedProject = useMemo(
    () => visibleProjects.find((project: any) => project.id === selectedProjectId)
      || visibleProjects[0]
      || null,
    [visibleProjects, selectedProjectId]
  )

  useEffect(() => {
    if (!visibleProjects.length) {
      setSelectedProjectId('')
      setCurrentProject(null)
      setSelectedNode(null)
      return
    }
    if (!selectedProjectId || !visibleProjects.some((project: any) => project.id === selectedProjectId)) {
      setSelectedProjectId(visibleProjects[0].id)
    }
  }, [visibleProjects, selectedProjectId, setCurrentProject])

  useEffect(() => {
    if (selectedProject?.id) setCurrentProject(selectedProject)
    setSelectedNode(null)
    const nextOffset = { x: 0, y: 0 }
    viewportOffsetRef.current = nextOffset
    setViewportOffset(nextOffset)
    if (graphCanvasRef.current) graphCanvasRef.current.style.transform = 'translate3d(0px, 0px, 0)'
  }, [selectedProject?.id, timeRange, setCurrentProject])

  const loadProjectGraph = useCallback((projectId: string) => {
    if (!projectId || graphDataByProject[projectId] || loadingProjectId === projectId) return
    setLoadingProjectId(projectId)
    setError('')
    Promise.all([
      api(`/api/projects/${encodeURIComponent(projectId)}/issues`),
      api(`/api/projects/${encodeURIComponent(projectId)}/researches`),
    ])
      .then(([issues, researches]: any[]) => {
        const issueIds = (issues || []).map((issue: any) => String(issue?.id || '').trim()).filter(Boolean)
        const researchIds = (researches || []).map((research: any) => String(research?.id || '').trim()).filter(Boolean)
        const qs = new URLSearchParams()
        if (issueIds.length > 0) qs.set('issue_ids', issueIds.join(','))
        if (researchIds.length > 0) qs.set('research_ids', researchIds.join(','))
        qs.set('preview_limit', '100')
        return api(`/api/projects/${encodeURIComponent(projectId)}/sessions-overview?${qs.toString()}`)
          .then((sessionsOverview: any) => ({ issues, researches, sessionsOverview }))
      })
      .then(({ issues, researches, sessionsOverview }: any) => {
        setGraphDataByProject((prev) => ({
          ...prev,
          [projectId]: {
            issues: issues || [],
            researches: researches || [],
            sessionsByIssue: sessionsOverview?.issues || {},
            sessionsByResearch: sessionsOverview?.researches || {},
          },
        }))
      })
      .catch((e: any) => setError(e?.message || '图谱加载失败'))
      .finally(() => setLoadingProjectId(''))
  }, [graphDataByProject, loadingProjectId])

  useEffect(() => {
    if (!selectedProject?.id) return
    loadProjectGraph(selectedProject.id)
  }, [selectedProject?.id, loadProjectGraph])

  const activeGraphData = useMemo(
    () => filterGraphDataByActivity(
      selectedProject?.id ? graphDataByProject[selectedProject.id] || EMPTY_GRAPH_DATA : EMPTY_GRAPH_DATA,
      cutoffMs,
    ),
    [selectedProject?.id, graphDataByProject, cutoffMs],
  )
  const graph = useMemo(
    () => buildGraph(selectedProject, activeGraphData),
    [selectedProject, activeGraphData]
  )
  const nodeMap = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes])
  const isLoadingGraph = !!selectedProject?.id && loadingProjectId === selectedProject.id && !graphDataByProject[selectedProject.id]

  const selectProject = (project: any) => {
    setSelectedProjectId(project.id)
    setCurrentProject(project)
  }

  const handleSelectNode = (node: GraphNode) => {
    setSelectedNode(node)
    if (node.kind === 'issue') setCurrentIssue(node.source)
    if (node.kind === 'research') setCurrentResearch(node.source)
    if (node.kind === 'session') setCurrentSession(node.source)
  }

  const handlePanStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, input, select, textarea, a')) return
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewportOffsetRef.current.x,
      originY: viewportOffsetRef.current.y,
    }
    setIsPanning(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const schedulePanTransform = () => {
    if (panFrameRef.current != null) return
    panFrameRef.current = requestAnimationFrame(() => {
      panFrameRef.current = null
      const el = graphCanvasRef.current
      if (!el) return
      const { x, y } = viewportOffsetRef.current
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`
    })
  }

  const handlePanMove = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    event.preventDefault()
    viewportOffsetRef.current = {
      x: pan.originX + event.clientX - pan.startX,
      y: pan.originY + event.clientY - pan.startY,
    }
    schedulePanTransform()
  }

  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (pan && pan.pointerId === event.pointerId) {
      panRef.current = null
      setIsPanning(false)
      setViewportOffset(viewportOffsetRef.current)
      try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
    }
  }

  return (
    <div className="flex h-screen flex-col" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <TopNav />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-[292px] flex-shrink-0 flex-col border-r" style={{ borderColor: 'var(--border-color)', background: 'var(--sidebar-bg)' }}>
          <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border-color)' }}>
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4" style={{ color: 'var(--accent-primary)' }} />
              <div className="text-[13px] font-semibold">Projects</div>
              <div className="ml-auto rounded-md px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--text-muted)', background: 'var(--bg-hover)' }}>
                {visibleProjects.length}
              </div>
            </div>
            <div className="relative mt-3">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 w-full rounded-md border bg-transparent pl-8 pr-2 text-[12px] outline-none transition-colors focus:border-[var(--accent-primary)]"
                style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                placeholder="搜索 Project"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {visibleProjects.length === 0 ? (
              <div className="px-3 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>没有匹配项目</div>
            ) : (
              visibleProjects.map((project: any) => {
                const active = project.id === selectedProject?.id
                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => selectProject(project)}
                    title={project.name}
                    className="mb-1 flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ background: active ? 'var(--bg-active)' : undefined }}
                  >
                    <span
                      className="mt-1 h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ background: active ? 'var(--accent-primary)' : 'var(--text-muted)' }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{project.name}</span>
                      <span className="mt-0.5 flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        <span>{compactCount(project.issue_count)} Issues</span>
                        <span>{compactCount(project.research_count)} Research</span>
                      </span>
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </aside>

        <main className="relative min-w-0 flex-1 overflow-hidden">
          <div className="absolute inset-x-0 top-0 z-10 flex h-[58px] items-center gap-3 border-b px-5" style={{ borderColor: 'var(--border-color)', background: 'color-mix(in srgb, var(--bg-primary) 92%, transparent)' }}>
            <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ color: 'var(--accent-primary)', background: 'var(--bg-hover)' }}>
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold">{selectedProject?.name || '选择 Project'}</div>
              <div className="mt-0.5 flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                <span>{graph.nodes.filter((node) => node.kind === 'issue').length} Issues</span>
                <span>{graph.nodes.filter((node) => node.kind === 'research').length} Research</span>
                <span>{graph.nodes.filter((node) => node.kind === 'session').length} Sessions / Agents</span>
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center rounded-md border p-0.5" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
              {TIME_RANGE_OPTIONS.map((option) => {
                const active = option.key === timeRange
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setTimeRange(option.key)}
                    className="h-7 rounded px-2.5 text-[11px] font-medium transition-colors"
                    style={{
                      color: active ? '#fff' : 'var(--text-secondary)',
                      background: active ? 'var(--accent-primary)' : 'transparent',
                    }}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
            {isLoadingGraph && (
              <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                加载中
              </div>
            )}
            {error && <div className="max-w-[360px] truncate text-[12px] text-red-400">{error}</div>}
          </div>

          <div
            className={`absolute inset-0 overflow-hidden pt-[58px] ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
            onPointerDown={handlePanStart}
            onPointerMove={handlePanMove}
            onPointerUp={endPan}
            onPointerCancel={endPan}
          >
            <div
              ref={graphCanvasRef}
              className={`relative will-change-transform ${isPanning ? '' : 'transition-transform duration-150'}`}
              style={{
                width: graph.width,
                height: graph.height,
                transform: `translate3d(${viewportOffset.x}px, ${viewportOffset.y}px, 0)`,
              }}
            >
              <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" width={graph.width} height={graph.height}>
                {graph.edges.map((edge) => {
                  const from = nodeMap.get(edge.from)
                  const to = nodeMap.get(edge.to)
                  if (!from || !to) return null
                  return (
                    <path
                      key={edge.id}
                      d={edgePath(from, to)}
                      fill="none"
                      stroke="rgba(148, 163, 184, 0.58)"
                      strokeWidth={1.55}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="transition-all duration-500"
                    />
                  )
                })}
              </svg>
              {graph.nodes.map((node) => (
                <GraphNodeButton
                  key={`${selectedProject?.id}:${node.id}`}
                  node={node}
                  selected={selectedNode?.id === node.id && selectedNode?.kind === node.kind}
                  onSelect={handleSelectNode}
                />
              ))}
              {!isLoadingGraph && selectedProject && graph.nodes.length <= 1 && (
                <div
                  className="absolute left-[360px] top-[220px] flex w-[320px] items-center gap-3 rounded-lg border p-4"
                  style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)', background: 'var(--card-bg)' }}
                >
                  <Activity className="h-5 w-5 flex-shrink-0" />
                  <div className="text-[12px] leading-5">这个 Project 在{selectedRange.label}内没有可展示的活跃 Session 或 Research Agent。</div>
                </div>
              )}
            </div>
          </div>

          <DetailDrawer node={selectedNode} userParam={userParam} onClose={() => setSelectedNode(null)} />
        </main>
      </div>
    </div>
  )
}
