import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowUpRight,
  CircleDot,
  FlaskConical,
  GitBranch,
  LocateFixed,
  MessageSquare,
  MousePointer2,
  PanelRightClose,
  Pause,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  UserRound,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { api, useStore } from '../store'
import { TopNav, timeAgoPrecise } from '../components/shell'

type TimeRangeKey = '24h' | '48h' | '72h' | '7d' | '30d'
type ClusterMode = 'project' | 'creator'
type ParentKind = 'issue' | 'research'
type SessionKind = 'session' | 'research_agent'
type SelectionKind = 'creator' | 'project' | ParentKind | SessionKind

type ProjectGraphData = {
  issues: any[]
  researches: any[]
  sessionsByIssue: Record<string, any[]>
  sessionsByResearch: Record<string, any[]>
}

type ClusterModel = {
  mode: ClusterMode
  nodes: ClusterSession[]
  parentClusters: ParentCluster[]
  projectClusters: ProjectCluster[]
  creatorClusters: CreatorCluster[]
}

type ClusterSession = {
  id: string
  kind: SessionKind
  title: string
  status?: string
  activeMs: number
  activeAt?: string
  projectId: string
  projectName: string
  creatorId: string
  parentId: string
  parentKind: ParentKind
  parentTitle: string
  source: any
  x: number
  y: number
  vx: number
  vy: number
  r: number
  hexX: number
  hexY: number
  fixed?: boolean
}

type ParentCluster = {
  id: string
  kind: ParentKind
  title: string
  projectId: string
  projectName: string
  creatorId: string
  source: any
  sessions: ClusterSession[]
  activeMs: number
  cx: number
  cy: number
  radius: number
  color: string
  shape: ClusterShape
  anchorX: number
  anchorY: number
  targetAnchorX?: number
  targetAnchorY?: number
}

type ProjectCluster = {
  id: string
  title: string
  source: any
  creatorId: string
  creatorName: string
  parents: ParentCluster[]
  sessions: ClusterSession[]
  activeMs: number
  cx: number
  cy: number
  radius: number
  color: string
  shape: ClusterShape
  anchorX: number
  anchorY: number
}

type CreatorCluster = {
  id: string
  title: string
  source: any
  projects: ProjectCluster[]
  sessions: ClusterSession[]
  activeMs: number
  cx: number
  cy: number
  radius: number
  color: string
  shape: ClusterShape
}

type ClusterShape =
  | { type: 'circle'; cx: number; cy: number; r: number }
  | { type: 'capsule'; x1: number; y1: number; x2: number; y2: number; r: number }
  | { type: 'polygon'; points: Point[] }

type Point = { x: number; y: number }

type Selection =
  | { kind: 'creator'; id: string; title: string; source: any; cluster: CreatorCluster }
  | { kind: 'project'; id: string; title: string; source: any; cluster: ProjectCluster }
  | { kind: ParentKind; id: string; title: string; source: any; cluster: ParentCluster }
  | { kind: SessionKind; id: string; title: string; source: any; session: ClusterSession }

type HitTarget =
  | { kind: 'creator'; cluster: CreatorCluster }
  | { kind: 'project'; cluster: ProjectCluster }
  | { kind: ParentKind; cluster: ParentCluster }
  | { kind: SessionKind; session: ClusterSession }

function isSessionSelection(selection: Selection): selection is { kind: SessionKind; id: string; title: string; source: any; session: ClusterSession } {
  return selection.kind === 'session' || selection.kind === 'research_agent'
}

function isParentSelection(selection: Selection): selection is { kind: ParentKind; id: string; title: string; source: any; cluster: ParentCluster } {
  return selection.kind === 'issue' || selection.kind === 'research'
}

function isClusterSelection(selection: Selection): selection is { kind: 'creator'; id: string; title: string; source: any; cluster: CreatorCluster } | { kind: 'project'; id: string; title: string; source: any; cluster: ProjectCluster } | { kind: ParentKind; id: string; title: string; source: any; cluster: ParentCluster } {
  return selection.kind === 'creator' || selection.kind === 'project' || selection.kind === 'issue' || selection.kind === 'research'
}

function isSessionHit(hit: HitTarget): hit is { kind: SessionKind; session: ClusterSession } {
  return hit.kind === 'session' || hit.kind === 'research_agent'
}

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

const MIN_ZOOM = 0.1
const MAX_ZOOM = 3.2
const ZOOM_STEP = 1.18
const TOP_BAR_HEIGHT = 58
const SESSION_RADIUS_SCALE = 2
const PROJECT_TARGET_GAP = 34
const PROJECT_COLLISION_GAP = 18
const DOMINANT_PROJECT_ANCHOR_PULL = 0.08
const PROJECT_GATHER_MIN_ALPHA = 0.24
const PROJECT_GATHER_STRENGTH = 0.075
const PROJECT_GATHER_MAX_STEP = 28
const PROJECT_GATHER_STOP_EXCESS = 2
const CREATOR_TARGET_GAP = 44
const CREATOR_COLLISION_GAP = 28
const CLUSTER_RADIUS_GROW_LERP = 0.42
const CLUSTER_RADIUS_SHRINK_LERP = 0.2
const EXISTING_PARENT_ANCHOR_REPACK_LERP = 0.28
const PROJECT_COLORS = ['#0ea5e9', '#22c55e', '#f97316', '#a855f7', '#14b8a6', '#e11d48', '#84cc16', '#6366f1', '#f59e0b', '#06b6d4']

function activeTimeMs(item: any) {
  const value = item?.last_session_activity_at || item?.last_active || item?.updated_at || item?.created_at
  const ms = new Date(value || 0).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function activeTimeValue(item: any) {
  return item?.last_session_activity_at || item?.last_active || item?.updated_at || item?.created_at || ''
}

function sortByRecent<T>(items: T[], getter: (item: T) => number = (item: any) => activeTimeMs(item)) {
  return [...(items || [])].sort((a, b) => getter(b) - getter(a))
}

function isActiveWithin(item: any, cutoffMs: number) {
  return activeTimeMs(item) >= cutoffMs
}

function compactCount(value: any) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1000) return `${Math.floor(n / 100) / 10}k`
  return String(n)
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function clampZoom(value: number) {
  if (!Number.isFinite(value)) return 1
  return clamp(value, MIN_ZOOM, MAX_ZOOM)
}

function smoothValue(current: number, target: number, growFactor = CLUSTER_RADIUS_GROW_LERP, shrinkFactor = CLUSTER_RADIUS_SHRINK_LERP) {
  if (!Number.isFinite(current)) return target
  if (Math.abs(current - target) < 0.4) return target
  const factor = target > current ? growFactor : shrinkFactor
  return current + (target - current) * factor
}

function hashValue(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash)
}

function projectColor(projectId: string) {
  return PROJECT_COLORS[hashValue(projectId) % PROJECT_COLORS.length]
}

function creatorColor(creatorId: string) {
  return PROJECT_COLORS[hashValue(`creator:${creatorId}`) % PROJECT_COLORS.length]
}

function projectCreatorId(project: any) {
  return String(project?.created_by || 'unknown')
}

function projectCreatorName(project: any) {
  return String(project?.created_by_name || project?.created_by || '未知创建者')
}

function rgba(hex: string, alpha: number) {
  const clean = hex.replace('#', '')
  const n = parseInt(clean.length === 3 ? clean.split('').map((ch) => ch + ch).join('') : clean, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function statusLabel(value: any) {
  if (value === 'completed') return '已完成'
  if (value === 'archived') return '已归档'
  if (value === 'running') return '运行中'
  if (value === 'stale') return '停滞'
  if (value === 'idle') return '空闲'
  if (value === 'failed') return '失败'
  return '进行中'
}

function sessionColor(session: ClusterSession) {
  if (session.source?.agent_status === 'running' || session.status === 'running') return '#22c55e'
  if (session.source?.job_failed || session.status === 'failed') return '#ef4444'
  if (session.source?.job_accomplished || session.status === 'completed') return '#38bdf8'
  if (session.status === 'stale') return '#f59e0b'
  if (session.kind === 'research_agent') return '#a855f7'
  return '#94a3b8'
}

function sessionRadius(session: any) {
  const base = session.agent_status === 'running' ? 6.2 : isResearchAgent(session) ? 5.2 : 4.6
  return base * SESSION_RADIUS_SCALE
}

function projectMatchesSearch(project: any, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return String(project?.name || '').toLowerCase().includes(q)
    || String(project?.description || '').toLowerCase().includes(q)
    || String(project?.id || '').toLowerCase().includes(q)
    || String(project?.created_by || '').toLowerCase().includes(q)
    || String(project?.created_by_name || '').toLowerCase().includes(q)
}

function parentTitle(parent: any) {
  return parent?.title || parent?.name || parent?.id || '未命名'
}

function sessionTitle(session: any) {
  return session?.name || session?.title || session?.session_id || session?.id || '未命名会话'
}

function isResearchAgent(session: any) {
  return session?.scope_type === 'research' || !!session?.research_id || !!session?.research_role
}

function selectionKindLabel(selection: Selection | null) {
  if (!selection) return ''
  if (selection.kind === 'creator') return 'Creator'
  if (selection.kind === 'project') return 'Project'
  if (selection.kind === 'issue') return 'Issue'
  if (selection.kind === 'research') return 'Research'
  if (selection.kind === 'research_agent') return selection.source?.research_role === 'chief_researcher' ? 'Chief Researcher' : 'Research Agent'
  return 'Session'
}

function getSelectionPath(userParam: string, selection: Selection | null) {
  if (!selection || !userParam) return ''
  if (selection.kind === 'creator') return `/u/${encodeURIComponent(selection.id)}`
  if (selection.kind === 'project') return `/u/${encodeURIComponent(selection.cluster.creatorId || userParam)}/p/${encodeURIComponent(selection.id)}`
  const projectId = isSessionSelection(selection)
    ? selection.session.projectId
    : selection.cluster.projectId
  const creatorId = isSessionSelection(selection)
    ? selection.session.creatorId
    : selection.cluster.creatorId
  const base = `/u/${encodeURIComponent(creatorId || userParam)}/p/${encodeURIComponent(projectId)}`
  if (selection.kind === 'issue') return `${base}/i/${encodeURIComponent(selection.id)}`
  if (selection.kind === 'research') return `${base}/r/${encodeURIComponent(selection.id)}`
  if (isSessionSelection(selection)) {
    if (selection.session.parentKind === 'research') {
      return `${base}/r/${encodeURIComponent(selection.session.parentId)}?session=${encodeURIComponent(selection.id)}`
    }
    return `${base}/i/${encodeURIComponent(selection.session.parentId)}?session=${encodeURIComponent(selection.id)}`
  }
  return ''
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

function projectAnchor(index: number) {
  if (index === 0) return { x: 0, y: 0 }
  const angle = index * 2.399963
  const radius = 190 + Math.sqrt(index) * 120
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

function creatorAnchor(index: number) {
  if (index === 0) return { x: 0, y: 0 }
  const angle = index * 2.399963
  const radius = 520 + Math.sqrt(index) * 300
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

function projectAnchorWithinCreator(creator: Point, index: number, count: number) {
  if (count <= 1) return creator
  const angle = index * 2.399963
  const ring = 210 + Math.sqrt(index) * 150
  return { x: creator.x + Math.cos(angle) * ring, y: creator.y + Math.sin(angle) * ring }
}

function parentAnchor(project: { x: number; y: number }, index: number, count: number) {
  if (count <= 1) return { x: project.x, y: project.y }
  const angle = index * 2.399963
  const ring = 72 + Math.sqrt(index) * 34
  return { x: project.x + Math.cos(angle) * ring, y: project.y + Math.sin(angle) * ring }
}

function buildClusterModel(projects: any[], dataByProject: Record<string, ProjectGraphData>, cutoffMs: number, mode: ClusterMode): ClusterModel {
  const nodes: ClusterSession[] = []
  const parentClusters: ParentCluster[] = []
  const projectClusters: ProjectCluster[] = []
  const creatorClusters: CreatorCluster[] = []
  const orderedProjects = sortByRecent(projects)
  const filteredByProject = new Map<string, ProjectGraphData>()
  const layoutOrder = orderedProjects
    .map((project: any) => {
      const filtered = filterGraphDataByActivity(dataByProject[project.id] || EMPTY_GRAPH_DATA, cutoffMs)
      const sessionCount = Object.values(filtered.sessionsByIssue).reduce((sum, sessions) => sum + sessions.length, 0)
        + Object.values(filtered.sessionsByResearch).reduce((sum, sessions) => sum + sessions.length, 0)
      filteredByProject.set(project.id, filtered)
      return { project, sessionCount, activeMs: activeTimeMs(project) }
    })
    .filter((entry) => entry.sessionCount > 0)
    .sort((a, b) => b.sessionCount - a.sessionCount || b.activeMs - a.activeMs)
  const projectAnchorById = new Map<string, Point>()
  if (mode === 'project') {
    layoutOrder.forEach((entry, index) => projectAnchorById.set(entry.project.id, projectAnchor(index)))
  } else {
    const entriesByCreator = new Map<string, typeof layoutOrder>()
    layoutOrder.forEach((entry) => {
      const creatorId = projectCreatorId(entry.project)
      const entries = entriesByCreator.get(creatorId) || []
      entries.push(entry)
      entriesByCreator.set(creatorId, entries)
    })
    const creatorGroups = [...entriesByCreator.entries()]
      .map(([creatorId, entries]) => ({
        creatorId,
        entries,
        sessionCount: entries.reduce((sum, entry) => sum + entry.sessionCount, 0),
        activeMs: Math.max(...entries.map((entry) => entry.activeMs)),
      }))
      .sort((a, b) => b.sessionCount - a.sessionCount || b.activeMs - a.activeMs)
    creatorGroups.forEach((group, creatorIndex) => {
      const anchor = creatorAnchor(creatorIndex)
      group.entries.forEach((entry, projectIndex) => {
        projectAnchorById.set(entry.project.id, projectAnchorWithinCreator(anchor, projectIndex, group.entries.length))
      })
    })
  }

  orderedProjects.forEach((project: any, projectIndex: number) => {
    const filtered = filteredByProject.get(project.id) || EMPTY_GRAPH_DATA
    const pAnchor = projectAnchorById.get(project.id) || projectAnchor(projectIndex)
    const color = projectColor(project.id)
    const creatorId = projectCreatorId(project)
    const creatorName = projectCreatorName(project)
    const parents = [
      ...sortByRecent(filtered.issues).map((item) => ({ kind: 'issue' as const, item, sessions: filtered.sessionsByIssue[item.id] || [] })),
      ...sortByRecent(filtered.researches).map((item) => ({ kind: 'research' as const, item, sessions: filtered.sessionsByResearch[item.id] || [] })),
    ].sort((a, b) => activeTimeMs(b.item) - activeTimeMs(a.item))
    const projectSessions: ClusterSession[] = []
    const projectParents: ParentCluster[] = []

    parents.forEach((parent, parentIndex) => {
      const anchor = parentAnchor(pAnchor, parentIndex, parents.length)
      const parentSessions: ClusterSession[] = []
      const sortedSessions = sortByRecent(parent.sessions)
      const slots = balancedHexGridSlots(sortedSessions.length)
      sortedSessions.forEach((session: any, sessionIndex: number) => {
        const id = session.session_id || session.id
        const slot = slots[sessionIndex] || { x: 0, y: 0 }
        const node: ClusterSession = {
          id,
          kind: isResearchAgent(session) ? 'research_agent' : 'session',
          title: sessionTitle(session),
          status: session.agent_status || session.status,
          activeMs: activeTimeMs(session),
          activeAt: activeTimeValue(session),
          projectId: project.id,
          projectName: project.name || project.id,
          creatorId,
          parentId: parent.item.id,
          parentKind: parent.kind,
          parentTitle: parentTitle(parent.item),
          source: session,
          x: anchor.x + slot.x,
          y: anchor.y + slot.y,
          vx: 0,
          vy: 0,
          r: sessionRadius(session),
          hexX: slot.x,
          hexY: slot.y,
        }
        nodes.push(node)
        parentSessions.push(node)
        projectSessions.push(node)
      })
      if (parentSessions.length > 0) {
        const cluster: ParentCluster = {
          id: parent.item.id,
          kind: parent.kind,
          title: parentTitle(parent.item),
          projectId: project.id,
          projectName: project.name || project.id,
          creatorId,
          source: parent.item,
          sessions: parentSessions,
          activeMs: Math.max(...parentSessions.map((session) => session.activeMs)),
          cx: anchor.x,
          cy: anchor.y,
          radius: 40,
          color,
          shape: { type: 'circle', cx: anchor.x, cy: anchor.y, r: 40 },
          anchorX: anchor.x,
          anchorY: anchor.y,
        }
        parentClusters.push(cluster)
        projectParents.push(cluster)
      }
    })

    if (projectSessions.length > 0) {
      projectClusters.push({
        id: project.id,
        title: project.name || project.id,
        source: project,
        creatorId,
        creatorName,
        parents: projectParents,
        sessions: projectSessions,
        activeMs: Math.max(...projectSessions.map((session) => session.activeMs)),
        cx: pAnchor.x,
        cy: pAnchor.y,
        radius: 90,
        color,
        shape: { type: 'circle', cx: pAnchor.x, cy: pAnchor.y, r: 90 },
        anchorX: pAnchor.x,
        anchorY: pAnchor.y,
      })
    }
  })

  if (mode === 'creator') {
    const projectsByCreator = new Map<string, ProjectCluster[]>()
    projectClusters.forEach((project) => {
      const grouped = projectsByCreator.get(project.creatorId) || []
      grouped.push(project)
      projectsByCreator.set(project.creatorId, grouped)
    })
    projectsByCreator.forEach((creatorProjects, creatorId) => {
      const sessions = creatorProjects.flatMap((project) => project.sessions)
      const title = creatorProjects[0]?.creatorName || creatorId
      const cx = creatorProjects.reduce((sum, project) => sum + project.cx, 0) / Math.max(1, creatorProjects.length)
      const cy = creatorProjects.reduce((sum, project) => sum + project.cy, 0) / Math.max(1, creatorProjects.length)
      creatorClusters.push({
        id: creatorId,
        title,
        source: { id: creatorId, display_name: title },
        projects: creatorProjects,
        sessions,
        activeMs: Math.max(...sessions.map((session) => session.activeMs)),
        cx,
        cy,
        radius: 150,
        color: creatorColor(creatorId),
        shape: { type: 'circle', cx, cy, r: 150 },
      })
    })
  }

  updateClusterShapes(parentClusters, projectClusters, creatorClusters)
  return { mode, nodes, parentClusters, projectClusters, creatorClusters }
}

function parentClusterKey(cluster: Pick<ParentCluster, 'projectId' | 'kind' | 'id'>) {
  return `${cluster.projectId}:${cluster.kind}:${cluster.id}`
}

function sessionNodeKey(node: Pick<ClusterSession, 'projectId' | 'parentKind' | 'parentId' | 'id'>) {
  return `${node.projectId}:${node.parentKind}:${node.parentId}:${node.id}`
}

function spawnPointAround(center: Point, key: string, radius: number) {
  const h = hashValue(key)
  const angle = ((h % 6283) / 1000)
  const distance = radius * (0.45 + (((h >> 9) % 1000) / 1000) * 0.55)
  return {
    x: center.x + Math.cos(angle) * distance,
    y: center.y + Math.sin(angle) * distance,
  }
}

function spawnPointOnRing(center: Point, key: string, radius: number) {
  const angle = ((hashValue(key) % 6283) / 1000)
  return {
    x: center.x + Math.cos(angle) * radius,
    y: center.y + Math.sin(angle) * radius,
  }
}

function projectSpawnPoint(project: ProjectCluster, previousProjects: ProjectCluster[]) {
  if (!previousProjects.length) return { x: project.anchorX, y: project.anchorY }
  let weight = 0
  let cx = 0
  let cy = 0
  previousProjects.forEach((cluster) => {
    const w = Math.max(1, Math.sqrt(cluster.sessions.length))
    weight += w
    cx += cluster.cx * w
    cy += cluster.cy * w
  })
  const center = { x: cx / Math.max(1, weight), y: cy / Math.max(1, weight) }
  const outerRadius = previousProjects.reduce((maxRadius, cluster) => {
    return Math.max(maxRadius, Math.hypot(cluster.cx - center.x, cluster.cy - center.y) + cluster.radius)
  }, 0)
  return spawnPointOnRing(center, `project:${project.id}`, outerRadius + project.radius + PROJECT_TARGET_GAP + 72)
}

function remapSelection(selection: Selection | null, model: ClusterModel): Selection | null {
  if (!selection) return null
  if (selection.kind === 'creator') {
    const cluster = model.creatorClusters.find((item) => item.id === selection.id)
    return cluster ? { kind: 'creator', id: cluster.id, title: cluster.title, source: cluster.source, cluster } : null
  }
  if (selection.kind === 'project') {
    const cluster = model.projectClusters.find((item) => item.id === selection.id)
    return cluster ? { kind: 'project', id: cluster.id, title: cluster.title, source: cluster.source, cluster } : null
  }
  if (selection.kind === 'issue' || selection.kind === 'research') {
    const cluster = model.parentClusters.find((item) => item.projectId === selection.cluster.projectId && item.kind === selection.kind && item.id === selection.id)
    return cluster ? { kind: cluster.kind, id: cluster.id, title: cluster.title, source: cluster.source, cluster } : null
  }
  if (!isSessionSelection(selection)) return null
  const node = model.nodes.find((item) => (
    item.projectId === selection.session.projectId
    && item.parentKind === selection.session.parentKind
    && item.parentId === selection.session.parentId
    && item.kind === selection.kind
    && item.id === selection.id
  ))
  return node ? { kind: node.kind, id: node.id, title: node.title, source: node.source, session: node } : null
}

function reconcileClusterModel(previous: ClusterModel, desired: ClusterModel): ClusterModel {
  if (previous.mode !== desired.mode || (!previous.nodes.length && !previous.parentClusters.length && !previous.projectClusters.length)) {
    updateClusterShapes(desired.parentClusters, desired.projectClusters, desired.creatorClusters)
    return desired
  }

  const previousProjectById = new Map(previous.projectClusters.map((cluster) => [cluster.id, cluster]))
  const previousParentByKey = new Map(previous.parentClusters.map((cluster) => [parentClusterKey(cluster), cluster]))
  const previousNodeByKey = new Map(previous.nodes.map((node) => [sessionNodeKey(node), node]))
  const desiredProjectById = new Map(desired.projectClusters.map((cluster) => [cluster.id, cluster]))
  const projectById = new Map<string, ProjectCluster>()
  const parentByKey = new Map<string, ParentCluster>()
  const projectClusters: ProjectCluster[] = []
  const parentClusters: ParentCluster[] = []
  const nodes: ClusterSession[] = []
  const creatorClusters: CreatorCluster[] = []

  desired.projectClusters.forEach((desiredProject) => {
    const previousProject = previousProjectById.get(desiredProject.id)
    const spawn = previousProject
      ? { x: previousProject.anchorX, y: previousProject.anchorY, cx: previousProject.cx, cy: previousProject.cy }
      : (() => {
          const point = projectSpawnPoint(desiredProject, previous.projectClusters)
          return { x: point.x, y: point.y, cx: point.x, cy: point.y }
        })()
    const cluster: ProjectCluster = {
      ...desiredProject,
      parents: [],
      sessions: [],
      anchorX: spawn.x,
      anchorY: spawn.y,
      cx: spawn.cx,
      cy: spawn.cy,
      radius: previousProject?.radius || desiredProject.radius,
      shape: previousProject?.shape || { type: 'circle', cx: spawn.cx, cy: spawn.cy, r: desiredProject.radius },
    }
    projectById.set(cluster.id, cluster)
    projectClusters.push(cluster)
  })

  desired.parentClusters.forEach((desiredParent) => {
    const project = projectById.get(desiredParent.projectId)
    if (!project) return
    const key = parentClusterKey(desiredParent)
    const previousParent = previousParentByKey.get(key)
    const desiredProject = desiredProjectById.get(desiredParent.projectId)
    const targetAnchor = desiredProject
      ? {
          x: project.anchorX + desiredParent.anchorX - desiredProject.anchorX,
          y: project.anchorY + desiredParent.anchorY - desiredProject.anchorY,
        }
      : { x: desiredParent.anchorX, y: desiredParent.anchorY }
    const spawn = previousParent
      ? { x: previousParent.anchorX, y: previousParent.anchorY, cx: previousParent.cx, cy: previousParent.cy }
      : (() => {
          const point = spawnPointAround(
            { x: project.anchorX, y: project.anchorY },
            `parent:${key}`,
            Math.max(54, Math.min(150, project.radius * 0.42)),
          )
          return { x: point.x, y: point.y, cx: point.x, cy: point.y }
        })()
    if (previousParent) {
      spawn.x = smoothValue(previousParent.anchorX, targetAnchor.x, EXISTING_PARENT_ANCHOR_REPACK_LERP, EXISTING_PARENT_ANCHOR_REPACK_LERP)
      spawn.y = smoothValue(previousParent.anchorY, targetAnchor.y, EXISTING_PARENT_ANCHOR_REPACK_LERP, EXISTING_PARENT_ANCHOR_REPACK_LERP)
      spawn.cx += spawn.x - previousParent.anchorX
      spawn.cy += spawn.y - previousParent.anchorY
    }
    const cluster: ParentCluster = {
      ...desiredParent,
      sessions: [],
      anchorX: spawn.x,
      anchorY: spawn.y,
      cx: spawn.cx,
      cy: spawn.cy,
      radius: previousParent?.radius || desiredParent.radius,
      shape: previousParent?.shape || { type: 'circle', cx: spawn.cx, cy: spawn.cy, r: desiredParent.radius },
      targetAnchorX: targetAnchor.x,
      targetAnchorY: targetAnchor.y,
    }
    parentByKey.set(key, cluster)
    parentClusters.push(cluster)
    project.parents.push(cluster)
  })

  desired.nodes.forEach((desiredNode) => {
    const parent = parentByKey.get(parentClusterKey({
      projectId: desiredNode.projectId,
      kind: desiredNode.parentKind,
      id: desiredNode.parentId,
    }))
    const project = projectById.get(desiredNode.projectId)
    if (!parent || !project) return
    const key = sessionNodeKey(desiredNode)
    const previousNode = previousNodeByKey.get(key)
    const node: ClusterSession = { ...desiredNode }
    if (previousNode) {
      node.x = previousNode.x
      node.y = previousNode.y
      node.vx = previousNode.vx
      node.vy = previousNode.vy
      node.fixed = previousNode.fixed
    } else {
      const target = { x: parent.anchorX + desiredNode.hexX, y: parent.anchorY + desiredNode.hexY }
      const siblings = parent.sessions
      const center = siblings.length
        ? {
            x: siblings.reduce((sum, item) => sum + item.x, 0) / siblings.length,
            y: siblings.reduce((sum, item) => sum + item.y, 0) / siblings.length,
          }
        : { x: parent.anchorX, y: parent.anchorY }
      const spawn = spawnPointAround(center, `session:${key}`, Math.max(16, desiredNode.r * 2.6))
      node.x = spawn.x
      node.y = spawn.y
      node.vx = (target.x - spawn.x) * 0.025
      node.vy = (target.y - spawn.y) * 0.025
    }
    nodes.push(node)
    parent.sessions.push(node)
    project.sessions.push(node)
  })

  if (desired.mode === 'creator') {
    const previousCreatorById = new Map(previous.creatorClusters.map((cluster) => [cluster.id, cluster]))
    desired.creatorClusters.forEach((desiredCreator) => {
      const creatorProjects = desiredCreator.projects
        .map((project) => projectById.get(project.id))
        .filter((project): project is ProjectCluster => !!project)
      if (creatorProjects.length === 0) return
      const previousCreator = previousCreatorById.get(desiredCreator.id)
      creatorClusters.push({
        ...desiredCreator,
        projects: creatorProjects,
        sessions: creatorProjects.flatMap((project) => project.sessions),
        cx: previousCreator?.cx ?? desiredCreator.cx,
        cy: previousCreator?.cy ?? desiredCreator.cy,
        radius: previousCreator?.radius ?? desiredCreator.radius,
        shape: previousCreator?.shape ?? desiredCreator.shape,
      })
    })
  }

  updateClusterShapes(parentClusters, projectClusters, creatorClusters)
  resolveParentAndProjectOverlaps(parentClusters, projectClusters)
  if (desired.mode === 'creator') resolveCreatorClusterOverlaps(creatorClusters)
  return { mode: desired.mode, nodes, parentClusters, projectClusters, creatorClusters }
}

function axialToPoint(q: number, r: number, spacing: number): Point {
  return {
    x: spacing * Math.sqrt(3) * (q + r / 2),
    y: spacing * 1.5 * r,
  }
}

type HexCell = Point & { q: number; r: number }

function hexRingCells(ring: number, spacing: number): HexCell[] {
  if (ring <= 0) return [{ q: 0, r: 0, ...axialToPoint(0, 0, spacing) }]
  const directions = [
    { q: -1, r: 1 },
    { q: -1, r: 0 },
    { q: 0, r: -1 },
    { q: 1, r: -1 },
    { q: 1, r: 0 },
    { q: 0, r: 1 },
  ]
  const slots: HexCell[] = []
  let q = ring
  let r = 0
  for (const dir of directions) {
    for (let step = 0; step < ring; step += 1) {
      slots.push({ q, r, ...axialToPoint(q, r, spacing) })
      q += dir.q
      r += dir.r
    }
  }
  return slots
}

function hexCapacity(ring: number) {
  return 1 + 3 * ring * (ring + 1)
}

function hexGridCandidates(count: number, spacing: number) {
  let ringLimit = 0
  while (hexCapacity(ringLimit) < count + 6) ringLimit += 1
  const cells: HexCell[] = []
  for (let ring = 0; ring <= ringLimit + 1; ring += 1) {
    cells.push(...hexRingCells(ring, spacing))
  }
  return cells
}

function sampleHexOffsets(spacing: number, count: number) {
  const subdivisions = count <= 18 ? 6 : 4
  const offsets: Point[] = []
  for (let qi = -subdivisions; qi <= subdivisions; qi += 1) {
    for (let ri = -subdivisions; ri <= subdivisions; ri += 1) {
      const q = qi / subdivisions
      const r = ri / subdivisions
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) > 1) continue
      offsets.push(axialToPoint(q, r, spacing))
    }
  }
  return offsets
}

function recenterLayout(points: Point[]) {
  const cx = points.reduce((sum, point) => sum + point.x, 0) / Math.max(1, points.length)
  const cy = points.reduce((sum, point) => sum + point.y, 0) / Math.max(1, points.length)
  return points.map((point) => {
    const x = point.x - cx
    const y = point.y - cy
    return { x: Math.abs(x) < 0.001 ? 0 : x, y: Math.abs(y) < 0.001 ? 0 : y }
  })
}

function scoreHexLayout(points: Point[], spacing: number) {
  if (points.length <= 1) return 0
  let maxRadius = 0
  let moment = 0
  let varX = 0
  let varY = 0
  let cov = 0
  let minPair = Infinity
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const radius = Math.hypot(a.x, a.y)
    maxRadius = Math.max(maxRadius, radius)
    moment += radius * radius
    varX += a.x * a.x
    varY += a.y * a.y
    cov += a.x * a.y
    for (let j = i + 1; j < points.length; j += 1) {
      const b = points[j]
      minPair = Math.min(minPair, Math.hypot(a.x - b.x, a.y - b.y))
    }
  }
  varX /= points.length
  varY /= points.length
  cov /= points.length
  moment /= points.length
  const trace = Math.max(1, varX + varY)
  const anisotropy = Math.sqrt((varX - varY) ** 2 + 4 * cov * cov) / trace
  const targetMinPair = spacing * Math.sqrt(3)
  const pairPenalty = Math.abs((Number.isFinite(minPair) ? minPair : targetMinPair) - targetMinPair)
  const shapePenalty = points.length <= 2 ? 0 : anisotropy * 18
  return maxRadius * 8 + moment * 0.045 + pairPenalty * 2.8 + shapePenalty
}

function orderHexSlots(points: Point[]) {
  return [...points].sort((a, b) => {
    const row = Math.round(a.y * 1000) - Math.round(b.y * 1000)
    if (row !== 0) return row
    return a.x - b.x
  })
}

function balancedHexGridSlots(count: number, spacing = 22): Point[] {
  if (count <= 0) return []
  if (count === 1) return [{ x: 0, y: 0 }]
  const candidates = hexGridCandidates(count, spacing)
  let best: Point[] = []
  let bestScore = Infinity
  sampleHexOffsets(spacing, count).forEach((offset) => {
    const chosen = [...candidates]
      .sort((a, b) => {
        const da = (a.x - offset.x) ** 2 + (a.y - offset.y) ** 2
        const db = (b.x - offset.x) ** 2 + (b.y - offset.y) ** 2
        if (da !== db) return da - db
        return Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x)
      })
      .slice(0, count)
    const layout = recenterLayout(chosen)
    const score = scoreHexLayout(layout, spacing)
    if (score < bestScore) {
      bestScore = score
      best = layout
    }
  })
  if (best.length === 0) {
    best = recenterLayout(candidates.slice(0, count))
  }
  return orderHexSlots(best)
}

function parentBubbleRadius(cluster: ParentCluster) {
  const gridRadius = cluster.sessions.reduce((maxRadius, node) => {
    return Math.max(maxRadius, Math.hypot(node.hexX, node.hexY) + node.r + 22)
  }, 0)
  return Math.max(38, gridRadius)
}

function updateParentBubble(cluster: ParentCluster) {
  if (cluster.targetAnchorX !== undefined && cluster.targetAnchorY !== undefined) {
    const nextAnchorX = smoothValue(cluster.anchorX, cluster.targetAnchorX, EXISTING_PARENT_ANCHOR_REPACK_LERP, EXISTING_PARENT_ANCHOR_REPACK_LERP)
    const nextAnchorY = smoothValue(cluster.anchorY, cluster.targetAnchorY, EXISTING_PARENT_ANCHOR_REPACK_LERP, EXISTING_PARENT_ANCHOR_REPACK_LERP)
    const dx = nextAnchorX - cluster.anchorX
    const dy = nextAnchorY - cluster.anchorY
    cluster.anchorX = nextAnchorX
    cluster.anchorY = nextAnchorY
    cluster.sessions.forEach((node) => {
      node.x += dx
      node.y += dy
    })
  }
  const radius = smoothValue(cluster.radius, parentBubbleRadius(cluster))
  cluster.cx = cluster.anchorX
  cluster.cy = cluster.anchorY
  cluster.radius = radius
  cluster.shape = { type: 'circle', cx: cluster.anchorX, cy: cluster.anchorY, r: radius }
}

function updateProjectBubble(cluster: ProjectCluster) {
  if (!cluster.parents.length) {
    cluster.cx = cluster.anchorX
    cluster.cy = cluster.anchorY
    cluster.radius = smoothValue(cluster.radius, 80)
    cluster.shape = { type: 'circle', cx: cluster.anchorX, cy: cluster.anchorY, r: cluster.radius }
    return
  }
  let weight = 0
  let cx = 0
  let cy = 0
  cluster.parents.forEach((parent) => {
    const w = Math.max(1, parent.sessions.length)
    weight += w
    cx += parent.cx * w
    cy += parent.cy * w
  })
  cx /= Math.max(1, weight)
  cy /= Math.max(1, weight)
  const targetRadius = Math.max(
    92,
    ...cluster.parents.map((parent) => Math.hypot(parent.cx - cx, parent.cy - cy) + parent.radius + 34),
  )
  cluster.cx = cx
  cluster.cy = cy
  cluster.radius = smoothValue(cluster.radius, targetRadius)
  cluster.shape = { type: 'circle', cx, cy, r: cluster.radius }
}

function updateCreatorBubble(cluster: CreatorCluster) {
  if (!cluster.projects.length) return
  let weight = 0
  let cx = 0
  let cy = 0
  cluster.projects.forEach((project) => {
    const w = Math.max(1, Math.sqrt(project.sessions.length))
    weight += w
    cx += project.cx * w
    cy += project.cy * w
  })
  cx /= Math.max(1, weight)
  cy /= Math.max(1, weight)
  const targetRadius = Math.max(
    138,
    ...cluster.projects.map((project) => Math.hypot(project.cx - cx, project.cy - cy) + project.radius + 52),
  )
  cluster.cx = cx
  cluster.cy = cy
  cluster.radius = smoothValue(cluster.radius, targetRadius)
  cluster.shape = { type: 'circle', cx, cy, r: cluster.radius }
}

function updateClusterShapes(parentClusters: ParentCluster[], projectClusters: ProjectCluster[], creatorClusters: CreatorCluster[] = []) {
  parentClusters.forEach(updateParentBubble)
  projectClusters.forEach(updateProjectBubble)
  creatorClusters.forEach(updateCreatorBubble)
}

function translateParentCluster(cluster: ParentCluster, dx: number, dy: number) {
  cluster.anchorX += dx
  cluster.anchorY += dy
  if (cluster.targetAnchorX !== undefined) cluster.targetAnchorX += dx
  if (cluster.targetAnchorY !== undefined) cluster.targetAnchorY += dy
  cluster.cx += dx
  cluster.cy += dy
  if (cluster.shape.type === 'circle') {
    cluster.shape.cx += dx
    cluster.shape.cy += dy
  }
  cluster.sessions.forEach((node) => {
    node.x += dx
    node.y += dy
  })
}

function translateProjectCluster(cluster: ProjectCluster, dx: number, dy: number) {
  cluster.anchorX += dx
  cluster.anchorY += dy
  cluster.cx += dx
  cluster.cy += dy
  if (cluster.shape.type === 'circle') {
    cluster.shape.cx += dx
    cluster.shape.cy += dy
  }
  cluster.parents.forEach((parent) => translateParentCluster(parent, dx, dy))
}

function translateCreatorCluster(cluster: CreatorCluster, dx: number, dy: number) {
  cluster.projects.forEach((project) => translateProjectCluster(project, dx, dy))
  cluster.cx += dx
  cluster.cy += dy
  if (cluster.shape.type === 'circle') {
    cluster.shape.cx += dx
    cluster.shape.cy += dy
  }
}

function separateCircles(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
  gap: number,
) {
  let dx = bx - ax
  let dy = by - ay
  let dist = Math.hypot(dx, dy)
  if (dist < 0.001) {
    dx = 0.01
    dy = 0.01
    dist = Math.hypot(dx, dy)
  }
  const minDist = ar + br + gap
  if (dist >= minDist) return null
  const nx = dx / dist
  const ny = dy / dist
  const push = (minDist - dist) / 2 + 0.35
  return { x: nx * push, y: ny * push }
}

function constrainSessionsToParents(parentClusters: ParentCluster[]) {
  parentClusters.forEach((cluster) => {
    const limit = Math.max(12, cluster.radius - 16)
    cluster.sessions.forEach((node) => {
      const dx = node.x - cluster.anchorX
      const dy = node.y - cluster.anchorY
      const dist = Math.hypot(dx, dy)
      const maxDist = Math.max(4, limit - node.r)
      if (dist <= maxDist) return
      const nx = dx / Math.max(1, dist)
      const ny = dy / Math.max(1, dist)
      node.x = cluster.anchorX + nx * maxDist
      node.y = cluster.anchorY + ny * maxDist
      node.vx *= 0.35
      node.vy *= 0.35
    })
  })
}

function resolveSessionOverlaps(nodes: ClusterSession[]) {
  for (let iter = 0; iter < 3; iter += 1) {
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i]
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j]
        const sep = separateCircles(a.x, a.y, a.r, b.x, b.y, b.r, a.parentId === b.parentId ? 4 : 8)
        if (!sep) continue
        if (!a.fixed) {
          a.x -= sep.x
          a.y -= sep.y
        }
        if (!b.fixed) {
          b.x += sep.x
          b.y += sep.y
        }
      }
    }
  }
}

function resolveParentAndProjectOverlaps(parentClusters: ParentCluster[], projectClusters: ProjectCluster[]) {
  const projectById = new Map(projectClusters.map((cluster) => [cluster.id, cluster]))
  const centerProject = dominantProjectCluster(projectClusters)
  updateClusterShapes(parentClusters, projectClusters)

  for (let iter = 0; iter < 10; iter += 1) {
    let moved = false
    for (let i = 0; i < parentClusters.length; i += 1) {
      const a = parentClusters[i]
      for (let j = i + 1; j < parentClusters.length; j += 1) {
        const b = parentClusters[j]
        const sep = separateCircles(a.cx, a.cy, a.radius, b.cx, b.cy, b.radius, 12)
        if (!sep) continue
        moved = true
        if (a.projectId === b.projectId) {
          translateParentCluster(a, -sep.x, -sep.y)
          translateParentCluster(b, sep.x, sep.y)
        } else {
          const pa = projectById.get(a.projectId)
          const pb = projectById.get(b.projectId)
          if (pa?.id === centerProject?.id) {
            if (pb) translateProjectCluster(pb, sep.x * 2, sep.y * 2)
          } else if (pb?.id === centerProject?.id) {
            if (pa) translateProjectCluster(pa, -sep.x * 2, -sep.y * 2)
          } else {
            if (pa) translateProjectCluster(pa, -sep.x, -sep.y)
            if (pb) translateProjectCluster(pb, sep.x, sep.y)
          }
        }
      }
    }
    updateClusterShapes(parentClusters, projectClusters)
    if (!moved) break
  }

  for (let iter = 0; iter < 8; iter += 1) {
    let moved = false
    for (let i = 0; i < projectClusters.length; i += 1) {
      const a = projectClusters[i]
      for (let j = i + 1; j < projectClusters.length; j += 1) {
        const b = projectClusters[j]
        const sep = separateCircles(a.cx, a.cy, a.radius, b.cx, b.cy, b.radius, PROJECT_COLLISION_GAP)
        if (!sep) continue
        moved = true
        if (a.id === centerProject?.id) {
          translateProjectCluster(b, sep.x * 2, sep.y * 2)
        } else if (b.id === centerProject?.id) {
          translateProjectCluster(a, -sep.x * 2, -sep.y * 2)
        } else {
          translateProjectCluster(a, -sep.x, -sep.y)
          translateProjectCluster(b, sep.x, sep.y)
        }
      }
    }
    updateClusterShapes(parentClusters, projectClusters)
    if (!moved) break
  }
}

function dominantCreatorCluster(creatorClusters: CreatorCluster[]) {
  return creatorClusters.reduce<CreatorCluster | null>((best, cluster) => {
    if (!best) return cluster
    const countDiff = cluster.sessions.length - best.sessions.length
    if (countDiff !== 0) return countDiff > 0 ? cluster : best
    return cluster.activeMs > best.activeMs ? cluster : best
  }, null)
}

function resolveCreatorClusterOverlaps(creatorClusters: CreatorCluster[]) {
  const centerCreator = dominantCreatorCluster(creatorClusters)
  creatorClusters.forEach(updateCreatorBubble)
  for (let iter = 0; iter < 8; iter += 1) {
    let moved = false
    for (let i = 0; i < creatorClusters.length; i += 1) {
      const a = creatorClusters[i]
      for (let j = i + 1; j < creatorClusters.length; j += 1) {
        const b = creatorClusters[j]
        const sep = separateCircles(a.cx, a.cy, a.radius, b.cx, b.cy, b.radius, CREATOR_COLLISION_GAP)
        if (!sep) continue
        moved = true
        if (a.id === centerCreator?.id) {
          translateCreatorCluster(b, sep.x * 2, sep.y * 2)
        } else if (b.id === centerCreator?.id) {
          translateCreatorCluster(a, -sep.x * 2, -sep.y * 2)
        } else {
          translateCreatorCluster(a, -sep.x, -sep.y)
          translateCreatorCluster(b, sep.x, sep.y)
        }
      }
    }
    creatorClusters.forEach(updateCreatorBubble)
    if (!moved) break
  }
}

function dominantProjectCluster(projectClusters: ProjectCluster[]) {
  return projectClusters.reduce<ProjectCluster | null>((best, cluster) => {
    if (!best) return cluster
    const countDiff = cluster.sessions.length - best.sessions.length
    if (countDiff !== 0) return countDiff > 0 ? cluster : best
    return cluster.activeMs > best.activeMs ? cluster : best
  }, null)
}

function projectGatherExcess(projectClusters: ProjectCluster[]) {
  if (projectClusters.length <= 1) return 0
  const centerProject = dominantProjectCluster(projectClusters)
  if (!centerProject) return 0
  return projectClusters.reduce((maxExcess, cluster) => {
    if (cluster.id === centerProject.id) return maxExcess
    const dist = Math.hypot(cluster.cx - centerProject.cx, cluster.cy - centerProject.cy)
    const targetDist = centerProject.radius + cluster.radius + PROJECT_TARGET_GAP
    return Math.max(maxExcess, dist - targetDist)
  }, 0)
}

function creatorGatherExcess(creatorClusters: CreatorCluster[]) {
  if (creatorClusters.length === 0) return 0
  let maxExcess = creatorClusters.reduce((maxValue, creator) => Math.max(maxValue, projectGatherExcess(creator.projects)), 0)
  if (creatorClusters.length <= 1) return maxExcess
  const centerCreator = dominantCreatorCluster(creatorClusters)
  if (!centerCreator) return maxExcess
  creatorClusters.forEach((cluster) => {
    if (cluster.id === centerCreator.id) return
    const dist = Math.hypot(cluster.cx - centerCreator.cx, cluster.cy - centerCreator.cy)
    const targetDist = centerCreator.radius + cluster.radius + CREATOR_TARGET_GAP
    maxExcess = Math.max(maxExcess, dist - targetDist)
  })
  return maxExcess
}

function attractProjectClusters(projectClusters: ProjectCluster[], alpha: number, anchorToOrigin = true) {
  if (projectClusters.length <= 1) return
  const centerProject = dominantProjectCluster(projectClusters)
  if (!centerProject) return
  const gatherAlpha = Math.max(alpha, PROJECT_GATHER_MIN_ALPHA)
  const centerOffset = Math.hypot(centerProject.cx, centerProject.cy)
  if (anchorToOrigin && centerOffset > 0.5) {
    const pull = Math.min(9, centerOffset * DOMINANT_PROJECT_ANCHOR_PULL) * gatherAlpha
    translateProjectCluster(centerProject, (-centerProject.cx / centerOffset) * pull, (-centerProject.cy / centerOffset) * pull)
  }
  const centerX = centerProject.cx
  const centerY = centerProject.cy

  projectClusters.forEach((cluster) => {
    if (cluster.id === centerProject.id) return
    const dx = centerX - cluster.cx
    const dy = centerY - cluster.cy
    const dist = Math.hypot(dx, dy)
    const restDistance = centerProject.radius + cluster.radius + PROJECT_TARGET_GAP
    if (dist <= restDistance) return
    const pull = Math.min(PROJECT_GATHER_MAX_STEP, (dist - restDistance) * PROJECT_GATHER_STRENGTH) * gatherAlpha
    translateProjectCluster(cluster, (dx / dist) * pull, (dy / dist) * pull)
  })
}

function attractCreatorClusters(creatorClusters: CreatorCluster[], alpha: number) {
  if (creatorClusters.length <= 1) return
  const centerCreator = dominantCreatorCluster(creatorClusters)
  if (!centerCreator) return
  const gatherAlpha = Math.max(alpha, PROJECT_GATHER_MIN_ALPHA)
  const centerOffset = Math.hypot(centerCreator.cx, centerCreator.cy)
  if (centerOffset > 0.5) {
    const pull = Math.min(9, centerOffset * DOMINANT_PROJECT_ANCHOR_PULL) * gatherAlpha
    translateCreatorCluster(centerCreator, (-centerCreator.cx / centerOffset) * pull, (-centerCreator.cy / centerOffset) * pull)
  }
  const centerX = centerCreator.cx
  const centerY = centerCreator.cy
  creatorClusters.forEach((cluster) => {
    if (cluster.id === centerCreator.id) return
    const dx = centerX - cluster.cx
    const dy = centerY - cluster.cy
    const dist = Math.hypot(dx, dy)
    const restDistance = centerCreator.radius + cluster.radius + CREATOR_TARGET_GAP
    if (dist <= restDistance) return
    const pull = Math.min(PROJECT_GATHER_MAX_STEP, (dist - restDistance) * PROJECT_GATHER_STRENGTH) * gatherAlpha
    translateCreatorCluster(cluster, (dx / dist) * pull, (dy / dist) * pull)
  })
}

function tickLayout(nodes: ClusterSession[], parentClusters: ParentCluster[], projectClusters: ProjectCluster[], creatorClusters: CreatorCluster[], mode: ClusterMode, alpha: number) {
  const parentById = new Map(parentClusters.map((cluster) => [cluster.id, cluster]))
  const projectById = new Map(projectClusters.map((cluster) => [cluster.id, cluster]))
  const n = nodes.length

  nodes.forEach((node) => {
    const parent = parentById.get(node.parentId)
    const project = projectById.get(node.projectId)
    if (!node.fixed) {
      if (parent) {
        const targetX = parent.anchorX + node.hexX
        const targetY = parent.anchorY + node.hexY
        node.vx += (targetX - node.x) * 0.09 * alpha
        node.vy += (targetY - node.y) * 0.09 * alpha
      }
      if (project) {
        node.vx += (project.anchorX - node.x) * 0.0025 * alpha
        node.vy += (project.anchorY - node.y) * 0.0025 * alpha
      }
    }
  })

  for (let i = 0; i < n; i += 1) {
    const a = nodes[i]
    for (let j = i + 1; j < n; j += 1) {
      const b = nodes[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let dist = Math.hypot(dx, dy)
      if (dist < 0.01) {
        dx = 0.01 + ((hashValue(`${a.id}:${b.id}`) % 100) / 1000)
        dy = 0.01
        dist = Math.hypot(dx, dy)
      }
      const sameParent = a.parentId === b.parentId
      const sameProject = a.projectId === b.projectId
      const minDist = a.r + b.r + (sameParent ? 7 : sameProject ? 14 : 22)
      const influence = sameParent ? 84 : sameProject ? 130 : 178
      if (dist > influence && dist > minDist) continue
      const nx = dx / dist
      const ny = dy / dist
      const overlap = Math.max(0, minDist - dist)
      const repel = (sameParent ? 0.22 : sameProject ? 0.4 : 0.68) * alpha
      const strength = (overlap * 0.08 + repel / Math.max(1, dist * 0.025)) * 0.5
      if (!a.fixed) {
        a.vx -= nx * strength
        a.vy -= ny * strength
      }
      if (!b.fixed) {
        b.vx += nx * strength
        b.vy += ny * strength
      }
    }
  }

  nodes.forEach((node) => {
    if (node.fixed) {
      node.vx = 0
      node.vy = 0
      return
    }
    node.vx = clamp(node.vx * 0.82, -12, 12)
    node.vy = clamp(node.vy * 0.82, -12, 12)
    node.x += node.vx
    node.y += node.vy
  })

  updateClusterShapes(parentClusters, projectClusters, creatorClusters)
  if (mode === 'creator') {
    creatorClusters.forEach((creator) => attractProjectClusters(creator.projects, alpha, false))
    creatorClusters.forEach(updateCreatorBubble)
    attractCreatorClusters(creatorClusters, alpha)
  } else {
    attractProjectClusters(projectClusters, alpha)
  }
  updateClusterShapes(parentClusters, projectClusters, creatorClusters)
  constrainSessionsToParents(parentClusters)
  resolveSessionOverlaps(nodes)
  updateClusterShapes(parentClusters, projectClusters, creatorClusters)
  resolveParentAndProjectOverlaps(parentClusters, projectClusters)
  if (mode === 'creator') resolveCreatorClusterOverlaps(creatorClusters)
  constrainSessionsToParents(parentClusters)
  resolveSessionOverlaps(nodes)
  updateClusterShapes(parentClusters, projectClusters, creatorClusters)
}

function tickProjectGatherOnly(parentClusters: ParentCluster[], projectClusters: ProjectCluster[], creatorClusters: CreatorCluster[], mode: ClusterMode, alpha: number) {
  updateClusterShapes(parentClusters, projectClusters, creatorClusters)
  if (mode === 'creator') {
    creatorClusters.forEach((creator) => attractProjectClusters(creator.projects, alpha, false))
    creatorClusters.forEach(updateCreatorBubble)
    attractCreatorClusters(creatorClusters, alpha)
  } else {
    attractProjectClusters(projectClusters, alpha)
  }
  updateClusterShapes(parentClusters, projectClusters, creatorClusters)
  resolveParentAndProjectOverlaps(parentClusters, projectClusters)
  if (mode === 'creator') resolveCreatorClusterOverlaps(creatorClusters)
  updateClusterShapes(parentClusters, projectClusters, creatorClusters)
}

function drawShape(ctx: CanvasRenderingContext2D, shape: ClusterShape) {
  if (shape.type === 'circle') {
    ctx.beginPath()
    ctx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2)
    return
  }
  if (shape.type === 'capsule') {
    const dx = shape.x2 - shape.x1
    const dy = shape.y2 - shape.y1
    const len = Math.max(1, Math.hypot(dx, dy))
    const nx = -dy / len
    const ny = dx / len
    const a1 = Math.atan2(ny, nx)
    const a2 = a1 + Math.PI
    ctx.beginPath()
    ctx.moveTo(shape.x1 + nx * shape.r, shape.y1 + ny * shape.r)
    ctx.lineTo(shape.x2 + nx * shape.r, shape.y2 + ny * shape.r)
    ctx.arc(shape.x2, shape.y2, shape.r, a1, a2)
    ctx.lineTo(shape.x1 - nx * shape.r, shape.y1 - ny * shape.r)
    ctx.arc(shape.x1, shape.y1, shape.r, a2, a1)
    ctx.closePath()
    return
  }
  const points = shape.points
  ctx.beginPath()
  if (!points.length) return
  if (points.length < 3) {
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    })
    return
  }
  const first = points[0]
  const last = points[points.length - 1]
  ctx.moveTo((first.x + last.x) / 2, (first.y + last.y) / 2)
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length]
    ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2)
  })
  ctx.closePath()
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function drawClusterLabel(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, maxWidth: number, color: string, font: string) {
  ctx.font = font
  ctx.textBaseline = 'middle'
  const text = textEllipsis(ctx, label, Math.max(36, maxWidth))
  const width = Math.min(maxWidth, ctx.measureText(text).width + 14)
  const height = 18
  const left = x - width / 2
  const top = y - height / 2
  roundedRectPath(ctx, left, top, width, height, 6)
  ctx.fillStyle = 'rgba(7, 18, 24, 0.72)'
  ctx.fill()
  ctx.strokeStyle = rgba(color, 0.28)
  ctx.lineWidth = 0.7 / zoomSafe(ctx)
  ctx.stroke()
  ctx.fillStyle = rgba(color, 0.9)
  ctx.fillText(text, x - ctx.measureText(text).width / 2, y + 0.5)
}

function drawDiamondPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x, y - r)
  ctx.lineTo(x + r, y)
  ctx.lineTo(x, y + r)
  ctx.lineTo(x - r, y)
  ctx.closePath()
}

function drawCirclePath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
}

function drawSessionPath(ctx: CanvasRenderingContext2D, node: ClusterSession, r = node.r) {
  if (node.kind === 'research_agent') {
    drawDiamondPath(ctx, node.x, node.y, r * 0.96)
    return
  }
  drawCirclePath(ctx, node.x, node.y, r)
}

function drawSessionNode(ctx: CanvasRenderingContext2D, node: ClusterSession, now: number, zoom: number) {
  const fill = sessionColor(node)
  const isRunning = node.source?.agent_status === 'running' || node.status === 'running'
  const isFailed = node.source?.job_failed || node.status === 'failed'
  const isCompleted = node.source?.job_accomplished || node.status === 'completed'
  const pulse = (Math.sin(now / 420 + (hashValue(node.id) % 628) / 100) + 1) / 2
  const glowRadius = node.r * (isRunning ? 3.15 + pulse * 0.55 : isFailed ? 2.65 : node.kind === 'research_agent' ? 2.35 : 2.05)
  const glow = ctx.createRadialGradient(node.x, node.y, node.r * 0.25, node.x, node.y, glowRadius)
  glow.addColorStop(0, rgba(fill, isRunning ? 0.55 : isFailed ? 0.46 : 0.34))
  glow.addColorStop(0.42, rgba(fill, isRunning ? 0.2 + pulse * 0.1 : 0.15))
  glow.addColorStop(1, rgba(fill, 0))
  drawCirclePath(ctx, node.x, node.y, glowRadius)
  ctx.fillStyle = glow
  ctx.fill()

  if (isRunning) {
    drawCirclePath(ctx, node.x, node.y, node.r + 4 + pulse * 7)
    ctx.strokeStyle = rgba(fill, 0.2 + pulse * 0.42)
    ctx.lineWidth = Math.max(1, 1.7 / zoom)
    ctx.stroke()
  }

  drawSessionPath(ctx, node)
  const body = ctx.createRadialGradient(node.x - node.r * 0.34, node.y - node.r * 0.42, node.r * 0.12, node.x, node.y, node.r * 1.15)
  body.addColorStop(0, 'rgba(255,255,255,0.96)')
  body.addColorStop(0.22, rgba(fill, 0.95))
  body.addColorStop(1, rgba(fill, 0.74))
  ctx.fillStyle = body
  ctx.fill()
  ctx.lineWidth = Math.max(1, 1.45 / zoom)
  ctx.strokeStyle = isFailed ? 'rgba(255,255,255,0.86)' : 'rgba(255,255,255,0.72)'
  ctx.stroke()

  drawSessionPath(ctx, node, node.r + 1.8)
  ctx.strokeStyle = rgba(fill, isRunning ? 0.9 : 0.62)
  ctx.lineWidth = Math.max(1, 1.1 / zoom)
  ctx.stroke()

  if (isCompleted) {
    drawCirclePath(ctx, node.x, node.y, node.r * 0.46)
    ctx.strokeStyle = 'rgba(255,255,255,0.82)'
    ctx.lineWidth = Math.max(1, 1.4 / zoom)
    ctx.stroke()
  }

  if (isFailed) {
    ctx.beginPath()
    ctx.moveTo(node.x - node.r * 0.42, node.y - node.r * 0.42)
    ctx.lineTo(node.x + node.r * 0.42, node.y + node.r * 0.42)
    ctx.moveTo(node.x + node.r * 0.42, node.y - node.r * 0.42)
    ctx.lineTo(node.x - node.r * 0.42, node.y + node.r * 0.42)
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = Math.max(1, 1.6 / zoom)
    ctx.stroke()
  }

  if (node.fixed) {
    drawCirclePath(ctx, node.x, node.y, node.r + 7)
    ctx.strokeStyle = rgba(fill, 0.62)
    ctx.lineWidth = Math.max(1, 2 / zoom)
    ctx.stroke()
  }
}

function zoomSafe(ctx: CanvasRenderingContext2D) {
  const transform = ctx.getTransform()
  return Math.max(0.1, Math.hypot(transform.a, transform.b))
}

function pointInShape(point: Point, shape: ClusterShape) {
  if (shape.type === 'circle') return Math.hypot(point.x - shape.cx, point.y - shape.cy) <= shape.r
  if (shape.type === 'capsule') {
    const dx = shape.x2 - shape.x1
    const dy = shape.y2 - shape.y1
    const lenSq = Math.max(1, dx * dx + dy * dy)
    const t = clamp(((point.x - shape.x1) * dx + (point.y - shape.y1) * dy) / lenSq, 0, 1)
    const x = shape.x1 + dx * t
    const y = shape.y1 + dy * t
    return Math.hypot(point.x - x, point.y - y) <= shape.r
  }
  let inside = false
  const pts = shape.points
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const pi = pts[i]
    const pj = pts[j]
    if (((pi.y > point.y) !== (pj.y > point.y)) && point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x) {
      inside = !inside
    }
  }
  return inside
}

function textEllipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (ctx.measureText(text).width <= maxWidth) return text
  let next = text
  while (next.length > 2 && ctx.measureText(`${next}...`).width > maxWidth) {
    next = next.slice(0, -1)
  }
  return `${next}...`
}

function worldBounds(nodes: ClusterSession[], creatorClusters: CreatorCluster[] = []) {
  if (!nodes.length) return { minX: -300, minY: -220, maxX: 300, maxY: 220 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  nodes.forEach((node) => {
    minX = Math.min(minX, node.x - 120)
    minY = Math.min(minY, node.y - 120)
    maxX = Math.max(maxX, node.x + 120)
    maxY = Math.max(maxY, node.y + 120)
  })
  creatorClusters.forEach((cluster) => {
    minX = Math.min(minX, cluster.cx - cluster.radius - 24)
    minY = Math.min(minY, cluster.cy - cluster.radius - 36)
    maxX = Math.max(maxX, cluster.cx + cluster.radius + 24)
    maxY = Math.max(maxY, cluster.cy + cluster.radius + 24)
  })
  return { minX, minY, maxX, maxY }
}

function InfoRow({ label, value }: { label: string; value: any }) {
  if (value === undefined || value === null || value === '') return null
  return (
    <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 border-b py-2 text-[12px]" style={{ borderColor: 'var(--border-color)' }}>
      <div style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="min-w-0 break-words" style={{ color: 'var(--text-primary)' }}>{String(value)}</div>
    </div>
  )
}

function DetailDrawer({ selection, userParam, onClose }: { selection: Selection | null; userParam: string; onClose: () => void }) {
  const navigate = useNavigate()
  const path = getSelectionPath(userParam, selection)
  const color = selection && isClusterSelection(selection)
    ? selection.cluster.color
    : selection
      ? sessionColor(selection.session)
      : 'var(--accent-primary)'
  const recentSessions = selection && isClusterSelection(selection)
    ? sortByRecent(selection.cluster.sessions, (session) => session.activeMs).slice(0, 12)
    : []

  return (
    <aside
      className={`absolute bottom-0 right-0 top-0 z-20 w-[392px] max-w-[calc(100vw-24px)] border-l shadow-2xl transition-transform duration-300 ${selection ? 'translate-x-0' : 'translate-x-full'}`}
      style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}
      aria-hidden={!selection}
    >
      {selection && (
        <div className="flex h-full flex-col">
          <div className="flex items-start gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--border-color)' }}>
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg" style={{ color, background: rgba(color, 0.14) }}>
              {selection.kind === 'creator' ? <UserRound className="h-4 w-4" /> : selection.kind === 'project' ? <GitBranch className="h-4 w-4" /> : selection.kind === 'issue' ? <CircleDot className="h-4 w-4" /> : selection.kind === 'research' ? <FlaskConical className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                {selectionKindLabel(selection)}
              </div>
              <h2 className="mt-1 break-words text-[16px] font-semibold leading-6" style={{ color: 'var(--text-primary)' }}>
                {selection.title}
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
            {(selection.source?.description || selection.source?.summary) && (
              <div className="mb-4 rounded-lg border p-3 text-[12px] leading-5" style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)', background: 'var(--bg-secondary)' }}>
                {selection.source.description || selection.source.summary}
              </div>
            )}
            {selection.kind !== 'creator' && <InfoRow label="状态" value={statusLabel(selection.source?.agent_status || selection.source?.status)} />}
            <InfoRow label="ID" value={selection.id} />
            <InfoRow label="活跃" value={timeAgoPrecise(activeTimeValue(selection.source) || (isClusterSelection(selection) ? selection.cluster.activeMs : selection.session.activeAt))} />
            {(isParentSelection(selection) || isSessionSelection(selection)) && <InfoRow label="Project" value={isSessionSelection(selection) ? selection.session.projectName : selection.cluster.projectName} />}
            {selection.kind === 'project' && <InfoRow label="创建者" value={selection.cluster.creatorName} />}
            {isSessionSelection(selection) && (
              <>
                <InfoRow label="归属" value={`${selection.session.parentKind === 'research' ? 'Research' : 'Issue'} · ${selection.session.parentTitle}`} />
                <InfoRow label="模型" value={selection.source?.model || selection.source?.model_label} />
                <InfoRow label="语言" value={selection.source?.language} />
                <InfoRow label="角色" value={selection.source?.research_role} />
                <InfoRow label="消息" value={selection.source?.message_count} />
                <InfoRow label="记录" value={selection.source?.raw_entry_count} />
                <InfoRow label="成本" value={`$${Number(selection.source?.total_cost_usd || 0).toFixed(4)}`} />
              </>
            )}
            {selection.kind === 'creator' && (
              <>
                <InfoRow label="项目" value={selection.cluster.projects.length} />
                <InfoRow label="活跃主题" value={selection.cluster.projects.reduce((sum, project) => sum + project.parents.length, 0)} />
              </>
            )}
            {isClusterSelection(selection) && (
              <>
                <InfoRow label="活跃会话" value={selection.cluster.sessions.length} />
                {selection.kind === 'project' && <InfoRow label="活跃主题" value={selection.cluster.parents.length} />}
                <div className="mt-4">
                  <div className="mb-2 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>最近 Session / Agent</div>
                  <div className="space-y-1">
                    {recentSessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => navigate(getSelectionPath(userParam, { kind: session.kind, id: session.id, title: session.title, source: session.source, session }))}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                      >
                        <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: sessionColor(session) }} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px]" style={{ color: 'var(--text-primary)' }}>{session.title}</span>
                          <span className="block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{selection.kind === 'creator' ? `${session.projectName} · ` : ''}{session.parentTitle} · {timeAgoPrecise(session.activeAt || '')}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
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

export default function MobiusOverviewClusterPage() {
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
  const [clusterMode, setClusterMode] = useState<ClusterMode>(() => {
    try {
      return localStorage.getItem('mobius:overview-cluster-mode') === 'creator' ? 'creator' : 'project'
    } catch {
      return 'project'
    }
  })
  const [timeRange, setTimeRange] = useState<TimeRangeKey>('24h')
  const [graphDataByProject, setGraphDataByProject] = useState<Record<string, ProjectGraphData>>({})
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Selection | null>(null)
  const [hoverLabel, setHoverLabel] = useState<{ x: number; y: number; title: string; meta: string } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [paused, setPaused] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const modelRef = useRef<ClusterModel>({ mode: clusterMode, nodes: [], parentClusters: [], projectClusters: [], creatorClusters: [] })
  const selectedRef = useRef<Selection | null>(null)
  const didInitialFitRef = useRef(false)
  const pendingAutoFitRef = useRef(false)
  const settledAutoFitTimerRef = useRef<number | null>(null)
  const userViewportInteractedRef = useRef(false)
  const alphaRef = useRef(0.85)
  const pausedRef = useRef(false)
  const zoomRef = useRef(1)
  const offsetRef = useRef({ x: 0, y: 0 })
  const sizeRef = useRef({ width: 1, height: 1, dpr: 1 })
  const frameRef = useRef<number | null>(null)
  const viewportAnimationRef = useRef<null | { frame: number; startedAt: number; duration: number; fromZoom: number; toZoom: number; fromOffset: Point; toOffset: Point }>(null)
  const dragRef = useRef<null | {
    pointerId: number
    mode: 'pan'
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
    hit?: HitTarget | null
  }>(null)

  const selectedRange = useMemo(
    () => TIME_RANGE_OPTIONS.find((option) => option.key === timeRange) || TIME_RANGE_OPTIONS[0],
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

  useEffect(() => {
    api('/api/projects?all=true')
      .then((arr: any[]) => setProjects(sortByRecent(arr || [])))
      .catch((e: any) => setError(e?.message || '项目加载失败'))
  }, [setProjects])

  const candidateProjects = useMemo(
    () => sortByRecent((projects || []).filter((project: any) => (
      !project.hidden
      && projectMatchesSearch(project, query)
      && isActiveWithin(project, cutoffMs)
    ))),
    [projects, query, cutoffMs],
  )

  const loadProjectGraph = useCallback((projectId: string) => {
    if (!projectId || graphDataByProject[projectId] || loadingIds.has(projectId)) return
    setLoadingIds((prev) => new Set(prev).add(projectId))
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
        qs.set('preview_limit', '500')
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
      .finally(() => setLoadingIds((prev) => {
        const next = new Set(prev)
        next.delete(projectId)
        return next
      }))
  }, [graphDataByProject, loadingIds])

  useEffect(() => {
    let cancelled = false
    const ids = candidateProjects.map((project: any) => project.id).filter((id: string) => !graphDataByProject[id])
    const run = async () => {
      for (let index = 0; index < ids.length; index += 3) {
        if (cancelled) return
        ids.slice(index, index + 3).forEach((id: string) => loadProjectGraph(id))
        await new Promise((resolve) => window.setTimeout(resolve, 80))
      }
    }
    run()
    return () => { cancelled = true }
  }, [candidateProjects, graphDataByProject, loadProjectGraph])

  const model = useMemo(() => buildClusterModel(candidateProjects, graphDataByProject, cutoffMs, clusterMode), [candidateProjects, graphDataByProject, cutoffMs, clusterMode])
  const activeProjectIds = useMemo(() => new Set(model.projectClusters.map((project) => project.id)), [model.projectClusters])
  const visibleProjects = useMemo(
    () => candidateProjects.filter((project: any) => activeProjectIds.has(project.id) || loadingIds.has(project.id) || !graphDataByProject[project.id]),
    [candidateProjects, activeProjectIds, loadingIds, graphDataByProject],
  )
  const loadingCount = loadingIds.size
  const pendingProjectCount = useMemo(
    () => candidateProjects.reduce((count: number, project: any) => count + (graphDataByProject[project.id] ? 0 : 1), 0),
    [candidateProjects, graphDataByProject],
  )
  const visibleCreatorGroups = useMemo(() => {
    const groups = new Map<string, { id: string; title: string; projects: any[]; activeMs: number }>()
    visibleProjects.forEach((project: any) => {
      const id = projectCreatorId(project)
      const group = groups.get(id) || { id, title: projectCreatorName(project), projects: [], activeMs: 0 }
      group.projects.push(project)
      group.activeMs = Math.max(group.activeMs, activeTimeMs(project))
      groups.set(id, group)
    })
    return [...groups.values()].sort((a, b) => b.projects.length - a.projects.length || b.activeMs - a.activeMs)
  }, [visibleProjects])

  const worldFromClientPoint = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const sx = clientX - rect.left
    const sy = clientY - rect.top
    return {
      x: (sx - offsetRef.current.x) / zoomRef.current,
      y: (sy - offsetRef.current.y) / zoomRef.current,
    }
  }, [])

  const worldFromEvent = useCallback((event: PointerEvent<HTMLCanvasElement>) => worldFromClientPoint(event.clientX, event.clientY), [worldFromClientPoint])

  const hitTest = useCallback((world: Point): HitTarget | null => {
    const { nodes, parentClusters: parents, projectClusters, creatorClusters } = modelRef.current
    let bestNode: ClusterSession | null = null
    let bestDist = Infinity
    const hitRadius = Math.max(9, 11 / zoomRef.current)
    for (const node of nodes) {
      const dist = Math.hypot(world.x - node.x, world.y - node.y)
      if (dist <= node.r + hitRadius && dist < bestDist) {
        bestDist = dist
        bestNode = node
      }
    }
    if (bestNode) return { kind: bestNode.kind, session: bestNode }
    for (let i = parents.length - 1; i >= 0; i -= 1) {
      const cluster = parents[i]
      if (pointInShape(world, cluster.shape)) return { kind: cluster.kind, cluster }
    }
    for (let i = projectClusters.length - 1; i >= 0; i -= 1) {
      const cluster = projectClusters[i]
      if (pointInShape(world, cluster.shape)) return { kind: 'project', cluster }
    }
    for (let i = creatorClusters.length - 1; i >= 0; i -= 1) {
      const cluster = creatorClusters[i]
      if (pointInShape(world, cluster.shape)) return { kind: 'creator', cluster }
    }
    return null
  }, [])

  const selectionFromHit = useCallback((hit: HitTarget | null): Selection | null => {
    if (!hit) return null
    if (hit.kind === 'creator') return { kind: 'creator', id: hit.cluster.id, title: hit.cluster.title, source: hit.cluster.source, cluster: hit.cluster }
    if (hit.kind === 'project') return { kind: 'project', id: hit.cluster.id, title: hit.cluster.title, source: hit.cluster.source, cluster: hit.cluster }
    if (hit.kind === 'issue' || hit.kind === 'research') return { kind: hit.kind, id: hit.cluster.id, title: hit.cluster.title, source: hit.cluster.source, cluster: hit.cluster }
    if (!isSessionHit(hit)) return null
    return { kind: hit.session.kind, id: hit.session.id, title: hit.session.title, source: hit.session.source, session: hit.session }
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width, height, dpr } = sizeRef.current
    const { nodes, parentClusters: parents, projectClusters, creatorClusters, mode } = modelRef.current
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary') || '#0f172a'
    ctx.fillRect(0, 0, width, height)
    ctx.translate(offsetRef.current.x, offsetRef.current.y)
    ctx.scale(zoomRef.current, zoomRef.current)

    if (mode === 'creator') {
      creatorClusters.forEach((cluster) => {
        drawShape(ctx, cluster.shape)
        ctx.fillStyle = rgba(cluster.color, 0.075)
        ctx.fill()
        ctx.lineWidth = 1.05 / zoomRef.current
        ctx.strokeStyle = rgba(cluster.color, 0.32)
        ctx.stroke()
      })
    }

    projectClusters.forEach((cluster) => {
      drawShape(ctx, cluster.shape)
      ctx.fillStyle = rgba(cluster.color, 0.105)
      ctx.fill()
      ctx.lineWidth = 0.8 / zoomRef.current
      ctx.strokeStyle = rgba(cluster.color, 0.18)
      ctx.stroke()
    })

    parents.forEach((cluster) => {
      drawShape(ctx, cluster.shape)
      ctx.fillStyle = rgba(cluster.color, cluster.kind === 'research' ? 0.17 : 0.145)
      ctx.fill()
      ctx.lineWidth = 0.75 / zoomRef.current
      ctx.strokeStyle = rgba(cluster.color, 0.3)
      ctx.stroke()
    })

    if (zoomRef.current > 0.35) {
      if (mode === 'creator') {
        creatorClusters.forEach((cluster) => {
          drawClusterLabel(
            ctx,
            cluster.title,
            cluster.cx,
            cluster.cy - cluster.radius + 24,
            Math.max(90, cluster.radius * 1.1),
            cluster.color,
            '700 14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          )
        })
      }
      projectClusters.forEach((cluster) => {
        if (cluster.radius < 64) return
        drawClusterLabel(
          ctx,
          cluster.title,
          cluster.cx,
          cluster.cy - cluster.radius + 24,
          Math.max(70, cluster.radius * 1.25),
          cluster.color,
          '600 13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        )
      })
    }

    const now = performance.now()
    nodes.forEach((node) => drawSessionNode(ctx, node, now, zoomRef.current))

    if (zoomRef.current > 0.48) {
      parents.forEach((cluster) => {
        if (cluster.sessions.length === 0) return
        if (cluster.radius < 42 && cluster.sessions.length > 1) return
        const compact = cluster.radius < 42 || cluster.sessions.length === 1
        drawClusterLabel(
          ctx,
          cluster.title,
          cluster.cx,
          cluster.cy - cluster.radius - (compact ? 8 : -19),
          Math.max(compact ? 64 : 48, Math.min(180, cluster.radius * (compact ? 2 : 1.45))),
          cluster.color,
          `500 ${compact ? 9 : 10}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
        )
      })
    }

    const currentSelected = selectedRef.current
    if (currentSelected) {
      if (isSessionSelection(currentSelected)) {
        const node = currentSelected.session
        ctx.beginPath()
        ctx.arc(node.x, node.y, node.r + 8, 0, Math.PI * 2)
        ctx.strokeStyle = rgba(sessionColor(node), 0.85)
        ctx.lineWidth = 2.5 / zoomRef.current
        ctx.stroke()
      } else if (isClusterSelection(currentSelected)) {
        const cluster = currentSelected.cluster
        drawShape(ctx, cluster.shape)
        ctx.lineWidth = 2.2 / zoomRef.current
        ctx.strokeStyle = rgba(cluster.color, 0.78)
        ctx.stroke()
      }
    }
  }, [])

  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  useEffect(() => {
    const previous = modelRef.current
    const reconciled = reconcileClusterModel(previous, model)
    const wasEmpty = previous.nodes.length === 0
    modelRef.current = reconciled
    alphaRef.current = Math.max(alphaRef.current, wasEmpty ? 0.9 : 0.58)
    setSelected((current) => remapSelection(current, reconciled))
    setHoverLabel(null)
    if (!didInitialFitRef.current && reconciled.nodes.length > 0) {
      didInitialFitRef.current = true
      requestAnimationFrame(() => fitView(reconciled.nodes, 0.82, true))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  const cancelViewportAnimation = useCallback(() => {
    const animation = viewportAnimationRef.current
    if (!animation) return
    cancelAnimationFrame(animation.frame)
    viewportAnimationRef.current = null
  }, [])

  const fitView = useCallback((nodes = modelRef.current.nodes, maxZoom = 1.25, smooth = false) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { width, height } = sizeRef.current
    const bounds = worldBounds(nodes, modelRef.current.creatorClusters)
    const bw = Math.max(1, bounds.maxX - bounds.minX)
    const bh = Math.max(1, bounds.maxY - bounds.minY)
    const nextZoom = clampZoom(Math.min(maxZoom, width / bw, height / bh) * 0.86)
    const nextOffset = {
      x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * nextZoom,
      y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * nextZoom,
    }
    if (smooth) {
      cancelViewportAnimation()
      const startedAt = performance.now()
      const fromZoom = zoomRef.current
      const fromOffset = { ...offsetRef.current }
      const duration = 480
      const step = (now: number) => {
        const rawT = clamp((now - startedAt) / duration, 0, 1)
        const t = 1 - Math.pow(1 - rawT, 3)
        zoomRef.current = fromZoom + (nextZoom - fromZoom) * t
        offsetRef.current = {
          x: fromOffset.x + (nextOffset.x - fromOffset.x) * t,
          y: fromOffset.y + (nextOffset.y - fromOffset.y) * t,
        }
        setZoom(zoomRef.current)
        if (rawT < 1) {
          const frame = requestAnimationFrame(step)
          viewportAnimationRef.current = { frame, startedAt, duration, fromZoom, toZoom: nextZoom, fromOffset, toOffset: nextOffset }
        } else {
          zoomRef.current = nextZoom
          offsetRef.current = nextOffset
          setZoom(nextZoom)
          viewportAnimationRef.current = null
        }
        draw()
      }
      const frame = requestAnimationFrame(step)
      viewportAnimationRef.current = { frame, startedAt, duration, fromZoom, toZoom: nextZoom, fromOffset, toOffset: nextOffset }
      return
    }
    cancelViewportAnimation()
    zoomRef.current = nextZoom
    offsetRef.current = nextOffset
    setZoom(nextZoom)
    draw()
  }, [cancelViewportAnimation, draw])

  useEffect(() => {
    if (!pendingAutoFitRef.current || loadingCount > 0 || pendingProjectCount > 0 || model.nodes.length === 0) return undefined
    const timer = window.setTimeout(() => {
      if (!pendingAutoFitRef.current) return
      pendingAutoFitRef.current = false
      fitView(modelRef.current.nodes, 0.9, true)
      settledAutoFitTimerRef.current = window.setTimeout(() => {
        settledAutoFitTimerRef.current = null
        if (!userViewportInteractedRef.current) fitView(modelRef.current.nodes, 0.9, true)
      }, 12000)
    }, 320)
    return () => window.clearTimeout(timer)
  }, [fitView, loadingCount, model.nodes.length, pendingProjectCount])

  useEffect(() => () => {
    if (settledAutoFitTimerRef.current != null) window.clearTimeout(settledAutoFitTimerRef.current)
  }, [])

  useEffect(() => () => cancelViewportAnimation(), [cancelViewportAnimation])

  useEffect(() => {
    const viewport = viewportRef.current
    const canvas = canvasRef.current
    if (!viewport || !canvas) return undefined
    const resize = () => {
      const rect = viewport.getBoundingClientRect()
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
      sizeRef.current = { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr }
      canvas.width = Math.floor(sizeRef.current.width * dpr)
      canvas.height = Math.floor(sizeRef.current.height * dpr)
      canvas.style.width = `${sizeRef.current.width}px`
      canvas.style.height = `${sizeRef.current.height}px`
      fitView(modelRef.current.nodes, 1.2)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(viewport)
    resize()
    return () => observer.disconnect()
  }, [fitView])

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  useEffect(() => {
    const step = () => {
      const currentModel = modelRef.current
      const gatherExcess = currentModel.mode === 'creator'
        ? creatorGatherExcess(currentModel.creatorClusters)
        : projectGatherExcess(currentModel.projectClusters)
      const needsProjectGather = gatherExcess > PROJECT_GATHER_STOP_EXCESS
      if (!pausedRef.current && alphaRef.current > 0.018) {
        tickLayout(
          currentModel.nodes,
          currentModel.parentClusters,
          currentModel.projectClusters,
          currentModel.creatorClusters,
          currentModel.mode,
          needsProjectGather ? Math.max(alphaRef.current, PROJECT_GATHER_MIN_ALPHA) : alphaRef.current,
        )
        alphaRef.current *= 0.986
      } else if (!pausedRef.current && needsProjectGather) {
        tickProjectGatherOnly(
          currentModel.parentClusters,
          currentModel.projectClusters,
          currentModel.creatorClusters,
          currentModel.mode,
          PROJECT_GATHER_MIN_ALPHA,
        )
      } else {
        updateClusterShapes(currentModel.parentClusters, currentModel.projectClusters, currentModel.creatorClusters)
      }
      draw()
      frameRef.current = requestAnimationFrame(step)
    }
    frameRef.current = requestAnimationFrame(step)
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
    }
  }, [draw])

  const applyZoom = (nextZoom: number, anchor?: Point) => {
    userViewportInteractedRef.current = true
    cancelViewportAnimation()
    const currentZoom = zoomRef.current
    const clampedZoom = clampZoom(nextZoom)
    if (Math.abs(clampedZoom - currentZoom) < 0.001) return
    const offset = offsetRef.current
    const target = anchor || { x: sizeRef.current.width / 2, y: sizeRef.current.height / 2 }
    const ratio = clampedZoom / currentZoom
    const nextOffset = {
      x: target.x - (target.x - offset.x) * ratio,
      y: target.y - (target.y - offset.y) * ratio,
    }
    zoomRef.current = clampedZoom
    offsetRef.current = nextOffset
    setZoom(clampedZoom)
    draw()
  }

  const handleQueryChange = (value: string) => {
    if (settledAutoFitTimerRef.current != null) window.clearTimeout(settledAutoFitTimerRef.current)
    settledAutoFitTimerRef.current = null
    userViewportInteractedRef.current = false
    pendingAutoFitRef.current = true
    setQuery(value)
  }

  const handleTimeRangeChange = (value: TimeRangeKey) => {
    if (value === timeRange) return
    if (settledAutoFitTimerRef.current != null) window.clearTimeout(settledAutoFitTimerRef.current)
    settledAutoFitTimerRef.current = null
    userViewportInteractedRef.current = false
    pendingAutoFitRef.current = true
    setTimeRange(value)
  }

  const handleClusterModeChange = (value: ClusterMode) => {
    if (value === clusterMode) return
    if (settledAutoFitTimerRef.current != null) window.clearTimeout(settledAutoFitTimerRef.current)
    settledAutoFitTimerRef.current = null
    userViewportInteractedRef.current = false
    pendingAutoFitRef.current = true
    setSelected(null)
    setHoverLabel(null)
    setClusterMode(value)
    try { localStorage.setItem('mobius:overview-cluster-mode', value) } catch {}
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      applyZoom(zoomRef.current * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      })
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    userViewportInteractedRef.current = true
    cancelViewportAnimation()
    const world = worldFromEvent(event)
    const hit = hitTest(world)
    dragRef.current = {
      pointerId: event.pointerId,
      mode: 'pan',
      startX: event.clientX,
      startY: event.clientY,
      originX: offsetRef.current.x,
      originY: offsetRef.current.y,
      moved: false,
      hit,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    const world = worldFromEvent(event)
    if (drag && drag.pointerId === event.pointerId) {
      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3
      drag.moved = drag.moved || moved
      if (drag.mode === 'pan') {
        offsetRef.current = {
          x: drag.originX + event.clientX - drag.startX,
          y: drag.originY + event.clientY - drag.startY,
        }
      }
      return
    }
    const hit = hitTest(world)
    if (!hit) {
      setHoverLabel(null)
      return
    }
    const rect = canvasRef.current?.getBoundingClientRect()
    const sx = rect ? event.clientX - rect.left : 0
    const sy = rect ? event.clientY - rect.top : 0
    if (hit.kind === 'project') {
      setHoverLabel({ x: sx, y: sy, title: hit.cluster.title, meta: `${hit.cluster.parents.length} 个主题 · ${hit.cluster.sessions.length} 个会话` })
    } else if (hit.kind === 'creator') {
      setHoverLabel({ x: sx, y: sy, title: hit.cluster.title, meta: `${hit.cluster.projects.length} 个项目 · ${hit.cluster.sessions.length} 个会话` })
    } else if (hit.kind === 'issue' || hit.kind === 'research') {
      setHoverLabel({ x: sx, y: sy, title: hit.cluster.title, meta: `${hit.kind === 'research' ? 'Research' : 'Issue'} · ${hit.cluster.sessions.length} 个会话` })
    } else if (isSessionHit(hit)) {
      setHoverLabel({ x: sx, y: sy, title: hit.session.title, meta: `${hit.session.parentTitle} · ${timeAgoPrecise(hit.session.activeAt || '')}` })
    }
  }

  const handlePointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.moved) {
      const selection = selectionFromHit(drag.hit || hitTest(worldFromEvent(event)))
      setSelected(selection)
      if (selection?.kind === 'creator') setCurrentProject(null)
      if (selection?.kind === 'project') setCurrentProject(selection.source)
      if (selection?.kind === 'issue') setCurrentIssue(selection.source)
      if (selection?.kind === 'research') setCurrentResearch(selection.source)
      if (selection && isSessionSelection(selection)) setCurrentSession(selection.source)
    }
    dragRef.current = null
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
  }

  const focusProject = (projectId: string) => {
    cancelViewportAnimation()
    const cluster = modelRef.current.projectClusters.find((item) => item.id === projectId)
    if (!cluster) return
    setSelected({ kind: 'project', id: cluster.id, title: cluster.title, source: cluster.source, cluster })
  }

  const focusCreator = (creatorId: string) => {
    cancelViewportAnimation()
    const cluster = modelRef.current.creatorClusters.find((item) => item.id === creatorId)
    if (!cluster) return
    setCurrentProject(null)
    setSelected({ kind: 'creator', id: cluster.id, title: cluster.title, source: cluster.source, cluster })
  }

  const reheat = () => {
    alphaRef.current = 0.75
    setPaused(false)
  }

  return (
    <div className="flex h-screen flex-col" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <TopNav />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-[292px] flex-shrink-0 flex-col border-r" style={{ borderColor: 'var(--border-color)', background: 'var(--sidebar-bg)' }}>
          <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border-color)' }}>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" style={{ color: 'var(--accent-primary)' }} />
              <div className="text-[13px] font-semibold">Cluster Overview</div>
              <div className="ml-auto rounded-md px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--text-muted)', background: 'var(--bg-hover)' }}>
                {clusterMode === 'creator' ? visibleCreatorGroups.length : visibleProjects.length}
              </div>
            </div>
            <div className="relative mt-3">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
              <input
                value={query}
                onChange={(event) => handleQueryChange(event.target.value)}
                className="h-8 w-full rounded-md border bg-transparent pl-8 pr-2 text-[12px] outline-none transition-colors focus:border-[var(--accent-primary)]"
                style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
                placeholder="搜索 Project / 创建者"
              />
            </div>
            <div className="mt-3 grid grid-cols-2 rounded-md border p-0.5" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
              {([
                { key: 'project' as const, label: '项目聚集', icon: GitBranch },
                { key: 'creator' as const, label: '创建者聚集', icon: UserRound },
              ]).map((option) => {
                const active = clusterMode === option.key
                const Icon = option.icon
                return (
                  <button
                    key={option.key}
                    type="button"
                    data-cluster-mode={option.key}
                    onClick={() => handleClusterModeChange(option.key)}
                    className="flex h-7 items-center justify-center gap-1.5 rounded text-[11px] font-medium transition-colors"
                    style={{ color: active ? '#fff' : 'var(--text-secondary)', background: active ? 'var(--accent-primary)' : 'transparent' }}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {visibleProjects.length === 0 ? (
              <div className="px-3 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>没有匹配项目或创建者</div>
            ) : clusterMode === 'creator' ? (
              visibleCreatorGroups.map((creator) => {
                const cluster = model.creatorClusters.find((item) => item.id === creator.id)
                return (
                  <button
                    key={creator.id}
                    type="button"
                    onClick={() => focusCreator(creator.id)}
                    title={creator.title}
                    className="mb-1 flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ background: selected?.kind === 'creator' && selected.id === creator.id ? 'var(--bg-active)' : undefined }}
                  >
                    <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full" style={{ color: creatorColor(creator.id), background: rgba(creatorColor(creator.id), 0.14) }}>
                      <UserRound className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{creator.title}</span>
                      <span className="mt-0.5 flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        <span>{creator.projects.length} Projects</span>
                        <span>{cluster ? compactCount(cluster.sessions.length) : '加载中'} Sessions</span>
                      </span>
                    </span>
                  </button>
                )
              })
            ) : (
              visibleProjects.map((project: any) => {
                const cluster = model.projectClusters.find((item) => item.id === project.id)
                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => focusProject(project.id)}
                    title={project.name}
                    className="mb-1 flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ background: selected?.kind === 'project' && selected.id === project.id ? 'var(--bg-active)' : undefined }}
                  >
                    <span className="mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: projectColor(project.id) }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{project.name}</span>
                      <span className="mt-0.5 flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        <span>{cluster ? compactCount(cluster.sessions.length) : loadingIds.has(project.id) ? '加载中' : '0'} Sessions</span>
                        <span>{timeAgoPrecise(activeTimeValue(project))}</span>
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
              <MousePointer2 className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold">Mobius 点阵会话地图 · {clusterMode === 'creator' ? '创建者聚集' : '项目聚集'}</div>
              <div className="mt-0.5 flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {clusterMode === 'creator' && <span>{model.creatorClusters.length} Creators</span>}
                <span>{model.projectClusters.length} Projects</span>
                <span>{model.parentClusters.length} Issues / Research</span>
                <span>{model.nodes.length} Sessions / Agents</span>
                {loadingCount > 0 && <span>{loadingCount} 个项目加载中</span>}
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center rounded-md border p-0.5" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
              {TIME_RANGE_OPTIONS.map((option) => {
                const active = option.key === timeRange
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => handleTimeRangeChange(option.key)}
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
            <div className="flex flex-shrink-0 items-center rounded-md border p-0.5" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
              <button type="button" title="缩小" onClick={() => applyZoom(zoomRef.current / ZOOM_STEP)} className="flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-secondary)' }}>
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <button type="button" title="适应视图" onClick={() => fitView(modelRef.current.nodes, 1.25)} className="flex h-7 min-w-[58px] items-center justify-center gap-1 rounded px-1.5 text-[11px] font-medium transition-colors hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-secondary)' }}>
                <LocateFixed className="h-3 w-3" />
                {Math.round(zoom * 100)}%
              </button>
              <button type="button" title="放大" onClick={() => applyZoom(zoomRef.current * ZOOM_STEP)} className="flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-secondary)' }}>
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex flex-shrink-0 items-center rounded-md border p-0.5" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
              <button type="button" title={paused ? '继续布局' : '暂停布局'} onClick={() => setPaused((value) => !value)} className="flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-secondary)' }}>
                {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              </button>
              <button type="button" title="重新布局" onClick={reheat} className="flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-secondary)' }}>
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </div>
            {error && <div className="max-w-[360px] truncate text-[12px] text-red-400">{error}</div>}
          </div>

          <div ref={viewportRef} className="absolute inset-x-0 bottom-0 top-[58px] overflow-hidden">
            <canvas
              ref={canvasRef}
              className="block h-full w-full cursor-crosshair"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            />
            {hoverLabel && (
              <div
                className="pointer-events-none absolute z-10 max-w-[280px] rounded-md border px-2.5 py-1.5 text-[11px] shadow-xl"
                style={{
                  left: Math.min(sizeRef.current.width - 286, hoverLabel.x + 12),
                  top: Math.max(8, hoverLabel.y + 12),
                  color: 'var(--text-primary)',
                  borderColor: 'var(--border-color)',
                  background: 'color-mix(in srgb, var(--modal-bg) 96%, transparent)',
                }}
              >
                <div className="truncate font-semibold">{hoverLabel.title}</div>
                <div className="mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{hoverLabel.meta}</div>
              </div>
            )}
            {!loadingCount && model.nodes.length === 0 && (
              <div className="absolute left-1/2 top-1/2 flex w-[340px] -translate-x-1/2 -translate-y-1/2 items-center gap-3 rounded-lg border p-4" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)', background: 'var(--card-bg)' }}>
                <Sparkles className="h-5 w-5 flex-shrink-0" />
                <div className="text-[12px] leading-5">最近{selectedRange.label}内没有可展示的活跃 Session 或 Research Agent。</div>
              </div>
            )}
          </div>

          <DetailDrawer selection={selected} userParam={userParam} onClose={() => setSelected(null)} />
        </main>
      </div>
    </div>
  )
}
