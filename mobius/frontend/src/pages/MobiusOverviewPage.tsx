import { useCallback, useEffect, useMemo, useState } from 'react'
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

const NODE_SIZES = {
  project: { width: 230, height: 76 },
  subject: { width: 250, height: 66 },
  session: { width: 250, height: 58 },
}

const EMPTY_GRAPH_DATA: ProjectGraphData = {
  issues: [],
  researches: [],
  sessionsByIssue: {},
  sessionsByResearch: {},
}

function sortByRecent(items: any[]) {
  return [...(items || [])].sort((a: any, b: any) => {
    const pinnedDiff = Number(!!b?.pinned) - Number(!!a?.pinned)
    if (pinnedDiff !== 0) return pinnedDiff
    return new Date(b?.last_active || b?.created_at || 0).getTime() - new Date(a?.last_active || a?.created_at || 0).getTime()
  })
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
  const x1 = from.x + from.width
  const y1 = from.y + from.height / 2
  const x2 = to.x
  const y2 = to.y + to.height / 2
  const mid = Math.max(64, (x2 - x1) * 0.55)
  return `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`
}

function buildGraph(project: any, data: ProjectGraphData): { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number } {
  if (!project?.id) return { nodes: [], edges: [], width: 900, height: 560 }

  const parentX = 390
  const childX = 720
  const startY = 72
  const minGroupHeight = 96
  const childGap = 74
  const groupGap = 38
  const parentItems = [
    ...sortByRecent(data.issues).map((item) => ({ kind: 'issue' as const, item, children: data.sessionsByIssue[item.id] || [] })),
    ...sortByRecent(data.researches).map((item) => ({ kind: 'research' as const, item, children: data.sessionsByResearch[item.id] || [] })),
  ]

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
    width: 1040,
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
      className={`absolute flex flex-col justify-between overflow-hidden rounded-lg border px-3 py-2 text-left shadow-sm transition-all duration-500 hover:-translate-y-0.5 hover:shadow-lg ${selected ? 'ring-2' : ''}`}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        color: 'var(--text-primary)',
        background: selected ? 'color-mix(in srgb, var(--bg-active) 78%, var(--modal-bg))' : 'var(--card-bg)',
        borderColor: selected ? accent : 'var(--border-color)',
        ['--tw-ring-color' as any]: accent,
      }}
    >
      <span className="flex min-w-0 items-start gap-2">
        <span
          className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
          style={{ color: accent, background: `${accent}1f` }}
        >
          <NodeIcon kind={node.kind} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold leading-5">{node.title}</span>
          <span className="mt-0.5 block truncate text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>
            {kindLabel(node.kind, node.source?.research_role)}
          </span>
        </span>
      </span>
      <span className="flex items-center gap-1.5 text-[10px] leading-4" style={{ color: 'var(--text-secondary)' }}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} />
        <span className="truncate">{meta}</span>
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

  useEffect(() => {
    setCurrentProject(null)
    setCurrentIssue(null)
    setCurrentResearch(null)
    setCurrentSession(null)
    setCurrentTask(null)
  }, [setCurrentProject, setCurrentIssue, setCurrentResearch, setCurrentSession, setCurrentTask])

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
    () => sortByRecent((projects || []).filter((project: any) => !project.hidden && projectMatchesSearch(project, query))),
    [projects, query]
  )

  const selectedProject = useMemo(
    () => visibleProjects.find((project: any) => project.id === selectedProjectId)
      || projects.find((project: any) => project.id === selectedProjectId)
      || visibleProjects[0]
      || null,
    [visibleProjects, projects, selectedProjectId]
  )

  useEffect(() => {
    if (!selectedProject?.id) return
    setCurrentProject(selectedProject)
    setSelectedNode(null)
  }, [selectedProject?.id, setCurrentProject])

  const loadProjectGraph = useCallback((projectId: string) => {
    if (!projectId || graphDataByProject[projectId] || loadingProjectId === projectId) return
    setLoadingProjectId(projectId)
    setError('')
    Promise.all([
      api(`/api/projects/${encodeURIComponent(projectId)}/issues`),
      api(`/api/projects/${encodeURIComponent(projectId)}/researches`),
      api(`/api/projects/${encodeURIComponent(projectId)}/sessions-overview`),
    ])
      .then(([issues, researches, sessionsOverview]: any[]) => {
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

  const graph = useMemo(
    () => buildGraph(selectedProject, selectedProject?.id ? graphDataByProject[selectedProject.id] || EMPTY_GRAPH_DATA : EMPTY_GRAPH_DATA),
    [selectedProject, graphDataByProject]
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
            {isLoadingGraph && (
              <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                加载中
              </div>
            )}
            {error && <div className="max-w-[360px] truncate text-[12px] text-red-400">{error}</div>}
          </div>

          <div className="absolute inset-0 overflow-auto pt-[58px]">
            <div className="relative" style={{ width: graph.width, height: graph.height }}>
              <svg className="absolute inset-0 h-full w-full overflow-visible" width={graph.width} height={graph.height}>
                <defs>
                  <linearGradient id="overviewEdgeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="var(--accent-primary)" stopOpacity="0.5" />
                    <stop offset="100%" stopColor="var(--text-muted)" stopOpacity="0.25" />
                  </linearGradient>
                </defs>
                {graph.edges.map((edge) => {
                  const from = nodeMap.get(edge.from)
                  const to = nodeMap.get(edge.to)
                  if (!from || !to) return null
                  return (
                    <path
                      key={edge.id}
                      d={edgePath(from, to)}
                      fill="none"
                      stroke="url(#overviewEdgeGradient)"
                      strokeWidth={1.6}
                      strokeLinecap="round"
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
                  <div className="text-[12px] leading-5">这个 Project 还没有可展示的 Issue、Research 或会话。</div>
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
