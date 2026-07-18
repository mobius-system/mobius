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
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { api, useStore } from '../store'
import { TopNav, timeAgoPrecise } from '../components/shell'

type TimeRangeKey = '24h' | '48h' | '72h' | '7d' | '30d'
type ParentKind = 'issue' | 'research'
type SessionKind = 'session' | 'research_agent'
type SelectionKind = 'project' | ParentKind | SessionKind

type ProjectGraphData = {
  issues: any[]
  researches: any[]
  sessionsByIssue: Record<string, any[]>
  sessionsByResearch: Record<string, any[]>
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
}

type ProjectCluster = {
  id: string
  title: string
  source: any
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

type ClusterShape =
  | { type: 'circle'; cx: number; cy: number; r: number }
  | { type: 'capsule'; x1: number; y1: number; x2: number; y2: number; r: number }
  | { type: 'polygon'; points: Point[] }

type Point = { x: number; y: number }

type Selection =
  | { kind: 'project'; id: string; title: string; source: any; cluster: ProjectCluster }
  | { kind: ParentKind; id: string; title: string; source: any; cluster: ParentCluster }
  | { kind: SessionKind; id: string; title: string; source: any; session: ClusterSession }

type HitTarget =
  | { kind: 'project'; cluster: ProjectCluster }
  | { kind: ParentKind; cluster: ParentCluster }
  | { kind: SessionKind; session: ClusterSession }

function isSessionSelection(selection: Selection): selection is { kind: SessionKind; id: string; title: string; source: any; session: ClusterSession } {
  return selection.kind === 'session' || selection.kind === 'research_agent'
}

function isParentSelection(selection: Selection): selection is { kind: ParentKind; id: string; title: string; source: any; cluster: ParentCluster } {
  return selection.kind === 'issue' || selection.kind === 'research'
}

function isClusterSelection(selection: Selection): selection is { kind: 'project'; id: string; title: string; source: any; cluster: ProjectCluster } | { kind: ParentKind; id: string; title: string; source: any; cluster: ParentCluster } {
  return selection.kind === 'project' || selection.kind === 'issue' || selection.kind === 'research'
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

const MIN_ZOOM = 0.25
const MAX_ZOOM = 3.2
const ZOOM_STEP = 1.18
const TOP_BAR_HEIGHT = 58
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

function projectMatchesSearch(project: any, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return String(project?.name || '').toLowerCase().includes(q)
    || String(project?.description || '').toLowerCase().includes(q)
    || String(project?.id || '').toLowerCase().includes(q)
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
  if (selection.kind === 'project') return 'Project'
  if (selection.kind === 'issue') return 'Issue'
  if (selection.kind === 'research') return 'Research'
  if (selection.kind === 'research_agent') return selection.source?.research_role === 'chief_researcher' ? 'Chief Researcher' : 'Research Agent'
  return 'Session'
}

function getSelectionPath(userParam: string, selection: Selection | null) {
  if (!selection || !userParam) return ''
  if (selection.kind === 'project') return `/u/${encodeURIComponent(userParam)}/p/${encodeURIComponent(selection.id)}`
  const projectId = isSessionSelection(selection)
    ? selection.session.projectId
    : selection.cluster.projectId
  const base = `/u/${encodeURIComponent(userParam)}/p/${encodeURIComponent(projectId)}`
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

function seededOffset(id: string, scale: number) {
  const h = hashValue(id)
  const a = (h % 6283) / 1000
  const r = (((h >> 8) % 1000) / 1000) * scale
  return { x: Math.cos(a) * r, y: Math.sin(a) * r }
}

function projectAnchor(index: number) {
  if (index === 0) return { x: 0, y: 0 }
  const angle = index * 2.399963
  const radius = 190 + Math.sqrt(index) * 120
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

function parentAnchor(project: { x: number; y: number }, index: number, count: number) {
  if (count <= 1) return { x: project.x, y: project.y }
  const angle = index * 2.399963
  const ring = 72 + Math.sqrt(index) * 34
  return { x: project.x + Math.cos(angle) * ring, y: project.y + Math.sin(angle) * ring }
}

function buildClusterModel(projects: any[], dataByProject: Record<string, ProjectGraphData>, cutoffMs: number) {
  const nodes: ClusterSession[] = []
  const parentClusters: ParentCluster[] = []
  const projectClusters: ProjectCluster[] = []
  const orderedProjects = sortByRecent(projects)

  orderedProjects.forEach((project: any, projectIndex: number) => {
    const rawData = dataByProject[project.id] || EMPTY_GRAPH_DATA
    const filtered = filterGraphDataByActivity(rawData, cutoffMs)
    const pAnchor = projectAnchor(projectIndex)
    const color = projectColor(project.id)
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
        const jitter = seededOffset(`${project.id}:${parent.item.id}:${id}`, 1.6)
        const node: ClusterSession = {
          id,
          kind: isResearchAgent(session) ? 'research_agent' : 'session',
          title: sessionTitle(session),
          status: session.agent_status || session.status,
          activeMs: activeTimeMs(session),
          activeAt: activeTimeValue(session),
          projectId: project.id,
          projectName: project.name || project.id,
          parentId: parent.item.id,
          parentKind: parent.kind,
          parentTitle: parentTitle(parent.item),
          source: session,
          x: anchor.x + slot.x + jitter.x,
          y: anchor.y + slot.y + jitter.y,
          vx: 0,
          vy: 0,
          r: session.agent_status === 'running' ? 6.2 : isResearchAgent(session) ? 5.2 : 4.6,
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

  return { nodes, parentClusters, projectClusters }
}

function axialToPoint(q: number, r: number, spacing: number): Point {
  return {
    x: spacing * Math.sqrt(3) * (q + r / 2),
    y: spacing * 1.5 * r,
  }
}

function hexRingSlots(ring: number, spacing: number) {
  const directions = [
    { q: -1, r: 1 },
    { q: -1, r: 0 },
    { q: 0, r: -1 },
    { q: 1, r: -1 },
    { q: 1, r: 0 },
    { q: 0, r: 1 },
  ]
  const slots: Point[] = []
  let q = ring
  let r = 0
  for (const dir of directions) {
    for (let step = 0; step < ring; step += 1) {
      slots.push(axialToPoint(q, r, spacing))
      q += dir.q
      r += dir.r
    }
  }
  return slots
}

function balancedHexGridSlots(count: number, spacing = 22) {
  if (count <= 0) return []
  const slots: Point[] = [{ x: 0, y: 0 }]
  for (let ring = 1; slots.length < count && ring < 512; ring += 1) {
    const ringSlots = hexRingSlots(ring, spacing)
    const remaining = count - slots.length
    if (remaining >= ringSlots.length) {
      slots.push(...ringSlots)
      continue
    }
    const used = new Set<number>()
    for (let i = 0; i < remaining; i += 1) {
      let idx = Math.floor(((i + 0.5) * ringSlots.length) / remaining) % ringSlots.length
      while (used.has(idx)) idx = (idx + 1) % ringSlots.length
      used.add(idx)
      slots.push(ringSlots[idx])
    }
  }
  return slots.slice(0, count)
}

function parentBubbleRadius(cluster: ParentCluster) {
  const gridRadius = cluster.sessions.reduce((maxRadius, node) => {
    return Math.max(maxRadius, Math.hypot(node.hexX, node.hexY) + node.r + 22)
  }, 0)
  return Math.max(38, gridRadius)
}

function updateParentBubble(cluster: ParentCluster) {
  const radius = parentBubbleRadius(cluster)
  cluster.cx = cluster.anchorX
  cluster.cy = cluster.anchorY
  cluster.radius = radius
  cluster.shape = { type: 'circle', cx: cluster.anchorX, cy: cluster.anchorY, r: radius }
}

function updateProjectBubble(cluster: ProjectCluster) {
  if (!cluster.parents.length) {
    cluster.cx = cluster.anchorX
    cluster.cy = cluster.anchorY
    cluster.radius = 80
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
  const radius = Math.max(
    92,
    ...cluster.parents.map((parent) => Math.hypot(parent.cx - cx, parent.cy - cy) + parent.radius + 34),
  )
  cluster.cx = cx
  cluster.cy = cy
  cluster.radius = radius
  cluster.shape = { type: 'circle', cx, cy, r: radius }
}

function updateClusterShapes(parentClusters: ParentCluster[], projectClusters: ProjectCluster[]) {
  parentClusters.forEach(updateParentBubble)
  projectClusters.forEach(updateProjectBubble)
}

function translateParentCluster(cluster: ParentCluster, dx: number, dy: number) {
  cluster.anchorX += dx
  cluster.anchorY += dy
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
          if (pa) translateProjectCluster(pa, -sep.x, -sep.y)
          if (pb) translateProjectCluster(pb, sep.x, sep.y)
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
        const sep = separateCircles(a.cx, a.cy, a.radius, b.cx, b.cy, b.radius, 18)
        if (!sep) continue
        moved = true
        translateProjectCluster(a, -sep.x, -sep.y)
        translateProjectCluster(b, sep.x, sep.y)
      }
    }
    updateClusterShapes(parentClusters, projectClusters)
    if (!moved) break
  }
}

function tickLayout(nodes: ClusterSession[], parentClusters: ParentCluster[], projectClusters: ProjectCluster[], alpha: number) {
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

  updateClusterShapes(parentClusters, projectClusters)
  constrainSessionsToParents(parentClusters)
  resolveSessionOverlaps(nodes)
  updateClusterShapes(parentClusters, projectClusters)
  resolveParentAndProjectOverlaps(parentClusters, projectClusters)
  constrainSessionsToParents(parentClusters)
  resolveSessionOverlaps(nodes)
  updateClusterShapes(parentClusters, projectClusters)
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

function worldBounds(nodes: ClusterSession[]) {
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
  const color = selection?.kind === 'project'
    ? selection.cluster.color
    : selection && isParentSelection(selection)
      ? selection.cluster.color
      : selection
        ? sessionColor(selection.session)
        : 'var(--accent-primary)'
  const recentSessions = selection?.kind === 'project'
    ? sortByRecent(selection.cluster.sessions, (session) => session.activeMs).slice(0, 12)
    : selection && isParentSelection(selection)
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
              {selection.kind === 'project' ? <GitBranch className="h-4 w-4" /> : selection.kind === 'issue' ? <CircleDot className="h-4 w-4" /> : selection.kind === 'research' ? <FlaskConical className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
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
            <InfoRow label="状态" value={statusLabel(selection.source?.agent_status || selection.source?.status)} />
            <InfoRow label="ID" value={selection.id} />
            <InfoRow label="活跃" value={timeAgoPrecise(activeTimeValue(selection.source) || (selection.kind === 'project' ? selection.cluster.activeMs : isParentSelection(selection) ? selection.cluster.activeMs : selection.session.activeAt))} />
            {selection.kind !== 'project' && <InfoRow label="Project" value={isSessionSelection(selection) ? selection.session.projectName : selection.cluster.projectName} />}
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
            {(selection.kind === 'project' || isParentSelection(selection)) && (
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
                          <span className="block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{session.parentTitle} · {timeAgoPrecise(session.activeAt || '')}</span>
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
  const modelRef = useRef<{ nodes: ClusterSession[]; parents: ParentCluster[]; projects: ProjectCluster[] }>({ nodes: [], parents: [], projects: [] })
  const selectedRef = useRef<Selection | null>(null)
  const alphaRef = useRef(0.85)
  const pausedRef = useRef(false)
  const zoomRef = useRef(1)
  const offsetRef = useRef({ x: 0, y: 0 })
  const sizeRef = useRef({ width: 1, height: 1, dpr: 1 })
  const frameRef = useRef<number | null>(null)
  const viewportAnimationRef = useRef<null | { frame: number; startedAt: number; duration: number; fromZoom: number; toZoom: number; fromOffset: Point; toOffset: Point }>(null)
  const dragRef = useRef<null | {
    pointerId: number
    mode: 'pan' | 'node'
    startX: number
    startY: number
    originX: number
    originY: number
    node?: ClusterSession
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

  const model = useMemo(() => buildClusterModel(candidateProjects, graphDataByProject, cutoffMs), [candidateProjects, graphDataByProject, cutoffMs])
  const activeProjectIds = useMemo(() => new Set(model.projectClusters.map((project) => project.id)), [model.projectClusters])
  const visibleProjects = useMemo(
    () => candidateProjects.filter((project: any) => activeProjectIds.has(project.id) || loadingIds.has(project.id) || !graphDataByProject[project.id]),
    [candidateProjects, activeProjectIds, loadingIds, graphDataByProject],
  )
  const loadingCount = loadingIds.size

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
    const { nodes, parents, projects: projectClusters } = modelRef.current
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
    return null
  }, [])

  const selectionFromHit = useCallback((hit: HitTarget | null): Selection | null => {
    if (!hit) return null
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
    const { nodes, parents, projects: projectClusters } = modelRef.current
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary') || '#0f172a'
    ctx.fillRect(0, 0, width, height)
    ctx.translate(offsetRef.current.x, offsetRef.current.y)
    ctx.scale(zoomRef.current, zoomRef.current)

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

    nodes.forEach((node) => {
      const fill = sessionColor(node)
      ctx.beginPath()
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2)
      ctx.fillStyle = fill
      ctx.fill()
      ctx.lineWidth = 1.6 / zoomRef.current
      ctx.strokeStyle = 'rgba(255,255,255,0.72)'
      ctx.stroke()
      if (node.fixed) {
        ctx.beginPath()
        ctx.arc(node.x, node.y, node.r + 5, 0, Math.PI * 2)
        ctx.strokeStyle = rgba(fill, 0.55)
        ctx.lineWidth = 2 / zoomRef.current
        ctx.stroke()
      }
    })

    if (zoomRef.current > 0.62) {
      parents.forEach((cluster) => {
        if (cluster.radius < 42) return
        drawClusterLabel(
          ctx,
          cluster.title,
          cluster.cx,
          cluster.cy - cluster.radius + 19,
          Math.max(48, Math.min(180, cluster.radius * 1.45)),
          cluster.color,
          '500 10px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
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
    modelRef.current = {
      nodes: model.nodes,
      parents: model.parentClusters,
      projects: model.projectClusters,
    }
    updateClusterShapes(model.parentClusters, model.projectClusters)
    alphaRef.current = 0.9
    setSelected(null)
    setHoverLabel(null)
    requestAnimationFrame(() => fitView(model.nodes, 0.82, true))
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
    const bounds = worldBounds(nodes)
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
      if (!pausedRef.current && alphaRef.current > 0.018) {
        tickLayout(modelRef.current.nodes, modelRef.current.parents, modelRef.current.projects, alphaRef.current)
        alphaRef.current *= 0.986
      } else {
        updateClusterShapes(modelRef.current.parents, modelRef.current.projects)
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
    cancelViewportAnimation()
    const world = worldFromEvent(event)
    const hit = hitTest(world)
    const node = hit && isSessionHit(hit) ? hit.session : null
    dragRef.current = {
      pointerId: event.pointerId,
      mode: node ? 'node' : 'pan',
      startX: event.clientX,
      startY: event.clientY,
      originX: offsetRef.current.x,
      originY: offsetRef.current.y,
      node: node || undefined,
      moved: false,
      hit,
    }
    if (node) {
      node.fixed = true
      node.x = world.x
      node.y = world.y
      alphaRef.current = Math.max(alphaRef.current, 0.34)
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    const world = worldFromEvent(event)
    if (drag && drag.pointerId === event.pointerId) {
      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 3
      drag.moved = drag.moved || moved
      if (drag.mode === 'node' && drag.node) {
        drag.node.x = world.x
        drag.node.y = world.y
        drag.node.vx = 0
        drag.node.vy = 0
        alphaRef.current = Math.max(alphaRef.current, 0.2)
      } else if (drag.mode === 'pan') {
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
    } else if (hit.kind === 'issue' || hit.kind === 'research') {
      setHoverLabel({ x: sx, y: sy, title: hit.cluster.title, meta: `${hit.kind === 'research' ? 'Research' : 'Issue'} · ${hit.cluster.sessions.length} 个会话` })
    } else if (isSessionHit(hit)) {
      setHoverLabel({ x: sx, y: sy, title: hit.session.title, meta: `${hit.session.parentTitle} · ${timeAgoPrecise(hit.session.activeAt || '')}` })
    }
  }

  const handlePointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.mode === 'node' && drag.node) {
      const node = drag.node
      window.setTimeout(() => {
        node.fixed = false
        alphaRef.current = Math.max(alphaRef.current, 0.18)
      }, 900)
    }
    if (!drag.moved) {
      const selection = selectionFromHit(drag.hit || hitTest(worldFromEvent(event)))
      setSelected(selection)
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
    const cluster = modelRef.current.projects.find((item) => item.id === projectId)
    if (!cluster) return
    setSelected({ kind: 'project', id: cluster.id, title: cluster.title, source: cluster.source, cluster })
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
              <div className="truncate text-[14px] font-semibold">Mobius 点阵会话地图</div>
              <div className="mt-0.5 flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
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
