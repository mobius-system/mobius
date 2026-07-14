import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  NodeResizer,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'
import ReactMarkdown from 'react-markdown'
import { Settings } from 'lucide-react'
import { api, HIDDEN_FOLDER_NAME } from '../store'

type VisualEffect = 'in_progress' | 'completed' | 'failed' | 'successful'

interface GraphNode {
  id: number
  color: string | null
  parent_nodes: number[]
  visual_effects: VisualEffect[]
  main_content: string
  owner: string
  attached_images: string[]
}

interface GraphEdge {
  id?: string
  source: string
  target: string
}

interface GraphPayload {
  exists: boolean
  nodes: GraphNode[]
  edges: GraphEdge[]
  file?: string
  error?: string
}

const DEFAULT_TEXT_NODE_WIDTH = 280
const DEFAULT_TEXT_NODE_HEIGHT = 210 // 默认 4:3 (280:210)
const DEFAULT_TEXT_NODE_FONT_SIZE = 11
const TEXT_NODE_WIDTH_RANGE = { min: 220, max: 520, step: 10 }
const TEXT_NODE_HEIGHT_RANGE = { min: 160, max: 420, step: 10 }
const TEXT_NODE_FONT_SIZE_RANGE = { min: 10, max: 18, step: 1 }
const GAP_X = 60
const GAP_Y = 90
const IMG_W = DEFAULT_TEXT_NODE_WIDTH * 2 // 图像节点默认尺寸保持不受普通节点设置影响
const IMG_H = DEFAULT_TEXT_NODE_HEIGHT * 2
const IMG_GAP = 80 // 图像节点与常规节点包围盒之间的留白
const IMG_STACK_GAP = 28 // 同侧图像节点垂直堆叠间距

type TextNodeSettings = {
  width: number
  height: number
  fontSize: number
}

type LayoutMode = 'grid' | 'hierarchy'
const DEFAULT_LAYOUT_MODE: LayoutMode = 'grid'

// ChatGPT 风格: 只保留单一温和动画 (fade-up). 多种特效已收敛, 减少视觉负担.
type ReplayEffect = 'fade'
const REPLAY_EFFECTS: { value: ReplayEffect; label: string }[] = [
  { value: 'fade', label: '淡入上滑' },
]
type ReplayAnim = { effect: ReplayEffect; durationMs: number }

const REPLAY_CSS = `
.rg-anim { animation-duration: var(--rg-dur, 420ms); animation-fill-mode: both; animation-timing-function: cubic-bezier(.2,.8,.3,1); }
@keyframes rg-fade { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
.rg-anim-fade { animation-name: rg-fade }
.rg-anim-pop, .rg-anim-slide, .rg-anim-flip, .rg-anim-zoom { animation-name: rg-fade }
`

const EFFECT_META: Record<VisualEffect, { label: string; cls: string }> = {
  in_progress: { label: '进行中', cls: 'bg-blue-500/8 text-blue-300 border-blue-500/25' },
  completed: { label: '已完成', cls: 'bg-slate-500/8 text-slate-300 border-slate-500/25' },
  successful: { label: '成功', cls: 'bg-emerald-500/8 text-emerald-300 border-emerald-500/25' },
  failed: { label: '失败', cls: 'bg-red-500/8 text-red-300 border-red-500/25' },
}

function ringColorFor(effects: VisualEffect[]): string | undefined {
  if (effects.includes('failed')) return 'rgba(239,68,68,0.55)'
  if (effects.includes('successful')) return 'rgba(16,185,129,0.55)'
  if (effects.includes('in_progress')) return 'rgba(59,130,246,0.55)'
  return undefined
}

function posStorageKey(researchId: string) {
  return `rg-pos:${researchId}`
}

function loadPositions(researchId: string): Record<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(posStorageKey(researchId))
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function savePositions(researchId: string, positions: Record<string, { x: number; y: number }>) {
  try {
    localStorage.setItem(posStorageKey(researchId), JSON.stringify(positions))
  } catch {}
}

function dagreLayout(nodes: GraphNode[], edges: GraphEdge[], nodeSize: TextNodeSettings) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 90, marginx: 40, marginy: 40 })
  nodes.forEach((n) => g.setNode(String(n.id), { width: nodeSize.width, height: nodeSize.height }))
  edges.forEach((e) => g.setEdge(e.source, e.target))
  dagre.layout(g)
  const out: Record<string, { x: number; y: number }> = {}
  nodes.forEach((n) => {
    const p = g.node(String(n.id))
    if (p) out[String(n.id)] = { x: p.x - nodeSize.width / 2, y: p.y - nodeSize.height / 2 }
  })
  return out
}

// Kahn 拓扑排序(父先子后), 同层按 id 稳定排序; 成环节点(残留)按 id 追加到末尾
function topoOrder(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const ids = nodes.map((x) => String(x.id))
  const idSet = new Set(ids)
  const children = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  ids.forEach((id) => { children.set(id, []); indeg.set(id, 0) })
  edges.forEach((e) => {
    if (!idSet.has(e.source) || !idSet.has(e.target)) return
    children.get(e.source)!.push(e.target)
    indeg.set(e.target, (indeg.get(e.target) || 0) + 1)
  })
  const order: string[] = []
  const work = new Map(indeg)
  let queue = ids.filter((id) => (work.get(id) || 0) === 0).sort((a, b) => Number(a) - Number(b))
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const c of children.get(id) || []) {
      work.set(c, (work.get(c) || 0) - 1)
      if ((work.get(c) || 0) === 0) queue.push(c)
    }
    queue.sort((a, b) => Number(a) - Number(b))
  }
  if (order.length < ids.length) {
    const seen = new Set(order)
    ids.filter((id) => !seen.has(id)).sort((a, b) => Number(a) - Number(b)).forEach((id) => order.push(id))
  }
  return order
}

// 拓扑方格网: 按拓扑顺序(父先子后)逐行从左到右填入近正方形网格, 最大化空间利用率
function topoGridLayout(nodes: GraphNode[], edges: GraphEdge[], nodeSize: TextNodeSettings) {
  const out: Record<string, { x: number; y: number }> = {}
  const n = nodes.length
  if (n === 0) return out

  const order = topoOrder(nodes, edges)

  // 选列数使包围盒最接近正方形 (节点本身宽大于高, 需据此修正)
  let bestC = Math.ceil(Math.sqrt(n))
  let bestScore = Infinity
  for (let C = 1; C <= n; C++) {
    const rows = Math.ceil(n / C)
    const cols = Math.min(n, C)
    const W = cols * nodeSize.width + (cols - 1) * GAP_X
    const H = rows * nodeSize.height + (rows - 1) * GAP_Y
    const score = Math.abs(Math.log(W / H))
    if (score < bestScore) { bestScore = score; bestC = C }
  }
  const C = bestC

  // 按拓扑顺序逐行从左到右填充
  for (let i = 0; i < order.length; i++) {
    const r = Math.floor(i / C)
    const col = i - r * C
    out[order[i]] = { x: col * (nodeSize.width + GAP_X), y: r * (nodeSize.height + GAP_Y) }
  }
  return out
}

function computeLayout(mode: LayoutMode, nodes: GraphNode[], edges: GraphEdge[], nodeSize: TextNodeSettings) {
  return mode === 'hierarchy' ? dagreLayout(nodes, edges, nodeSize) : topoGridLayout(nodes, edges, nodeSize)
}

function modeStorageKey(researchId: string) {
  return `rg-mode:${researchId}`
}

function loadMode(researchId: string): LayoutMode {
  try {
    const v = localStorage.getItem(modeStorageKey(researchId))
    return v === 'hierarchy' || v === 'grid' ? v : DEFAULT_LAYOUT_MODE
  } catch {
    return DEFAULT_LAYOUT_MODE
  }
}

function saveMode(researchId: string, mode: LayoutMode) {
  try {
    localStorage.setItem(modeStorageKey(researchId), mode)
  } catch {}
}

type ImgSize = { w: number; h: number }

function imgSizeStorageKey(researchId: string) {
  return `rg-imgsize:${researchId}`
}

function loadImgSizes(researchId: string): Record<string, ImgSize> {
  try {
    const raw = localStorage.getItem(imgSizeStorageKey(researchId))
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveImgSizes(researchId: string, sizes: Record<string, ImgSize>) {
  try {
    localStorage.setItem(imgSizeStorageKey(researchId), JSON.stringify(sizes))
  } catch {}
}

const imgNodeId = (ownerId: number) => `img:${ownerId}`

function imageUrl(researchId: string, absPath: string) {
  const token = localStorage.getItem('cc-token') || ''
  return `/api/research-graph/${researchId}/image?path=${encodeURIComponent(absPath)}&token=${encodeURIComponent(token)}`
}

type CardData = {
  node: GraphNode
  researchId: string
  horizontal: boolean
  nodeWidth: number
  nodeHeight: number
  fontSize: number
  anim?: ReplayAnim
}

function GraphNodeCard({ data }: NodeProps<Node<CardData>>) {
  const { node, researchId, horizontal, nodeWidth, nodeHeight, fontSize, anim } = data
  const ring = ringColorFor(node.visual_effects)
  const accent = node.color || 'var(--border-color)'
  const pulsing = node.visual_effects.includes('in_progress')
  const metaFontSize = Math.max(10, Math.round(fontSize * 0.92))
  const badgeFontSize = Math.max(10, Math.round(fontSize * 0.9))
  const badgeSize = Math.max(20, badgeFontSize + 10)
  const effectFontSize = Math.max(9, Math.round(fontSize * 0.82))

  return (
    <div
      className={`rounded-xl border shadow-lg overflow-hidden text-left flex flex-col${anim ? ` rg-anim rg-anim-${anim.effect}` : ''}`}
      style={{
        width: nodeWidth,
        height: nodeHeight,
        background: 'var(--bg-primary)',
        borderColor: ring || 'var(--border-color)',
        boxShadow: ring ? `0 0 0 2px ${ring}` : undefined,
        ...(anim ? { ['--rg-dur' as any]: `${anim.durationMs}ms` } : {}),
      }}
    >
      <Handle type="target" position={horizontal ? Position.Left : Position.Top} style={{ background: accent, width: 8, height: 8 }} />
      <div className="h-1.5 flex-shrink-0" style={{ background: accent }} />
      <div className="px-3 py-2 flex items-center gap-2 border-b flex-shrink-0" style={{ borderColor: 'var(--border-color)' }}>
        <span
          className="inline-flex items-center justify-center rounded-md font-bold flex-shrink-0"
          style={{ width: badgeSize, height: badgeSize, background: accent, color: '#fff', fontSize: badgeFontSize }}
        >
          {node.id}
        </span>
        <div className="flex-1 min-w-0 truncate" style={{ color: 'var(--text-muted)', fontSize: metaFontSize }} title={node.owner}>
          {node.owner ? `责任人: ${node.owner}` : '未指定责任人'}
        </div>
        {pulsing && <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse flex-shrink-0" />}
      </div>

      {node.visual_effects.length > 0 && (
        <div className="px-3 pt-2 flex flex-wrap gap-1 flex-shrink-0">
          {node.visual_effects.map((e) => (
            <span key={e} className={`px-1.5 py-0.5 rounded border leading-none ${EFFECT_META[e].cls}`} style={{ fontSize: effectFontSize }}>
              {EFFECT_META[e].label}
            </span>
          ))}
        </div>
      )}

      <div
        className="px-3 py-2 leading-relaxed nodrag prose-graph overflow-y-auto flex-1 min-h-0"
        style={{ color: 'var(--text-secondary)', fontSize }}
      >
        <ReactMarkdown
          components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}
        >
          {node.main_content || '_(无正文)_'}
        </ReactMarkdown>
      </div>

      {node.attached_images.length > 0 && (
        <div className="px-3 pb-3 pt-2 flex flex-nowrap gap-2 nodrag flex-shrink-0 overflow-x-auto">
          {node.attached_images.map((p) => (
            <a key={p} href={imageUrl(researchId, p)} target="_blank" rel="noreferrer" title={p} className="flex-shrink-0">
              <img
                src={imageUrl(researchId, p)}
                alt={p.split('/').pop() || 'image'}
                className="w-16 h-16 object-cover rounded border"
                style={{ borderColor: 'var(--border-color)' }}
                loading="lazy"
              />
            </a>
          ))}
        </div>
      )}
      <Handle type="source" position={horizontal ? Position.Right : Position.Bottom} style={{ background: accent, width: 8, height: 8 }} />
    </div>
  )
}

type ImageCardData = {
  images: string[]
  researchId: string
  ownerId: number
  handleLeft: boolean
  onResize: (id: string, w: number, h: number) => void
  anim?: ReplayAnim
}

function ImageNodeCard({ id, data }: NodeProps<Node<ImageCardData>>) {
  const { images, researchId, ownerId, handleLeft, onResize, anim } = data
  const single = images.length === 1

  return (
    <div
      className={`w-full h-full rounded-xl border shadow-lg overflow-hidden flex flex-col${anim ? ` rg-anim rg-anim-${anim.effect}` : ''}`}
      style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)', ...(anim ? { ['--rg-dur' as any]: `${anim.durationMs}ms` } : {}) }}
    >
      <NodeResizer
        minWidth={160}
        minHeight={120}
        lineStyle={{ borderColor: 'var(--text-muted)' }}
        handleStyle={{ width: 8, height: 8, borderRadius: 2, background: 'var(--text-muted)' }}
        onResizeEnd={(_e, p) => onResize(id, p.width, p.height)}
      />
      <Handle type="target" position={handleLeft ? Position.Left : Position.Right} isConnectable={false} style={{ background: 'var(--text-muted)', width: 8, height: 8 }} />
      <div className="px-2 py-1 text-[10px] flex-shrink-0 border-b flex items-center gap-1" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-color)' }}>
        <span>节点 {ownerId} · 图像 ({images.length})</span>
      </div>
      <div
        className="flex-1 min-h-0 p-1 grid gap-1 overflow-auto cursor-move"
        style={{ gridTemplateColumns: single ? '1fr' : 'repeat(2, minmax(0, 1fr))' }}
      >
        {images.map((p) => (
          <a
            key={p}
            href={imageUrl(researchId, p)}
            target="_blank"
            rel="noreferrer"
            title={`${p}（拖动可移动节点, 单击新标签打开）`}
            draggable={false}
            className="min-h-0 flex items-center justify-center cursor-move"
          >
            <img
              src={imageUrl(researchId, p)}
              alt={p.split('/').pop() || 'image'}
              draggable={false}
              className="max-w-full max-h-full w-full h-full object-contain rounded"
              loading="lazy"
            />
          </a>
        ))}
      </div>
    </div>
  )
}

function GraphInner({ researchId }: { researchId: string }) {
  const nodeTypes = useMemo(() => ({ graphCard: GraphNodeCard, imageCard: ImageNodeCard }), [])
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [state, setState] = useState<{ loading: boolean; error: string | null; exists: boolean }>({
    loading: true,
    error: null,
    exists: false,
  })
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => loadMode(researchId))
  const [textNodeWidth, setTextNodeWidth] = useState(DEFAULT_TEXT_NODE_WIDTH)
  const [textNodeHeight, setTextNodeHeight] = useState(DEFAULT_TEXT_NODE_HEIGHT)
  const [textNodeFontSize, setTextNodeFontSize] = useState(DEFAULT_TEXT_NODE_FONT_SIZE)
  const textNodeSettings = useMemo<TextNodeSettings>(() => ({
    width: textNodeWidth,
    height: textNodeHeight,
    fontSize: textNodeFontSize,
  }), [textNodeWidth, textNodeHeight, textNodeFontSize])
  const prevTextNodeSettingsRef = useRef<TextNodeSettings>(textNodeSettings)
  const modeRef = useRef<LayoutMode>(layoutMode)
  modeRef.current = layoutMode
  const positionsRef = useRef<Record<string, { x: number; y: number }>>({})
  const dataRef = useRef<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] })
  const imgSizeRef = useRef<Record<string, ImgSize>>({})
  const { fitView, setCenter, getZoom } = useReactFlow()

  // 动画回放
  const [replaying, setReplaying] = useState(false)
  const [revealedCount, setRevealedCount] = useState(0)
  const [showReplaySettings, setShowReplaySettings] = useState(false)
  const [speedMs, setSpeedMs] = useState(800)
  const [effect, setEffect] = useState<ReplayEffect>('fade')
  const [tracking, setTracking] = useState(true)
  const trackingRef = useRef(tracking)
  trackingRef.current = tracking
  const revealOrderRef = useRef<string[]>([])
  const timersRef = useRef<number[]>([])
  const animDur = Math.min(700, Math.max(220, Math.round(speedMs * 1.3)))

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((t) => clearTimeout(t))
    timersRef.current = []
  }, [])

  const stopReplay = useCallback(() => {
    clearTimers()
    setReplaying(false)
  }, [clearTimers])

  useEffect(() => () => clearTimers(), [clearTimers])

  const persistImgSize = useCallback((id: string, w: number, h: number) => {
    imgSizeRef.current = { ...imgSizeRef.current, [id]: { w, h } }
    saveImgSizes(researchId, imgSizeRef.current)
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, style: { ...n.style, width: w, height: h } } : n)))
  }, [researchId, setNodes])

  // 统一构建: 常规节点先按 layout 定位; 图像节点不参与 layout, 在常规位置确定后就近浮出
  const buildNodes = useCallback((mode: LayoutMode, forceAuto: boolean) => {
    const { nodes: rawNodes, edges: rawEdges } = dataRef.current
    const saved = forceAuto ? {} : loadPositions(researchId)
    const imgSizes = imgSizeRef.current
    const auto = computeLayout(mode, rawNodes, rawEdges, textNodeSettings)
    const horizontal = mode === 'grid'
    const merged: Record<string, { x: number; y: number }> = {}

    const regular: Node[] = rawNodes.map((n) => {
      const id = String(n.id)
      const pos = saved[id] || auto[id] || { x: 0, y: 0 }
      merged[id] = pos
      return {
        id,
        type: 'graphCard',
        position: pos,
        style: { width: textNodeSettings.width, height: textNodeSettings.height },
        data: {
          node: n,
          researchId,
          horizontal,
          nodeWidth: textNodeSettings.width,
          nodeHeight: textNodeSettings.height,
          fontSize: textNodeSettings.fontSize,
        },
      }
    })

    const imageNodes: Node[] = []
    const imageEdges: Edge[] = []
    const imageOwners = rawNodes.filter((n) => n.attached_images.length > 0)
    if (imageOwners.length > 0) {
      // 常规节点包围盒: 图像节点一律摆到盒外, 不遮盖卡片
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of rawNodes) {
        const p = merged[String(n.id)]
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x + textNodeSettings.width); maxY = Math.max(maxY, p.y + textNodeSettings.height)
      }
      const centerX = (minX + maxX) / 2
      const sizeOf = (n: GraphNode) => imgSizes[imgNodeId(n.id)] || { w: IMG_W, h: IMG_H }

      // 按 owner 水平位置分到左/右两侧, 同侧按 owner 的 y 排序后垂直堆叠互不重叠
      const sides: Record<'left' | 'right', GraphNode[]> = { left: [], right: [] }
      for (const n of imageOwners) {
        const c = merged[String(n.id)].x + textNodeSettings.width / 2
        sides[c < centerX ? 'left' : 'right'].push(n)
      }
      const autoPos: Record<number, { x: number; y: number }> = {}
      for (const side of ['left', 'right'] as const) {
        sides[side].sort((a, b) => merged[String(a.id)].y - merged[String(b.id)].y)
        let cursor = -Infinity
        for (const n of sides[side]) {
          const size = sizeOf(n)
          const y = Math.max(merged[String(n.id)].y, cursor)
          const x = side === 'left' ? minX - IMG_GAP - size.w : maxX + IMG_GAP
          autoPos[n.id] = { x, y }
          cursor = y + size.h + IMG_STACK_GAP
        }
      }

      for (const n of imageOwners) {
        const id = imgNodeId(n.id)
        const size = sizeOf(n)
        const onRight = merged[String(n.id)].x + textNodeSettings.width / 2 >= centerX
        const pos = saved[id] || autoPos[n.id]
        merged[id] = pos
        imageNodes.push({
          id,
          type: 'imageCard',
          position: pos,
          style: { width: size.w, height: size.h },
          data: { images: n.attached_images, researchId, ownerId: n.id, handleLeft: onRight, onResize: persistImgSize },
        })
        imageEdges.push({
          id: `eimg:${n.id}`,
          source: String(n.id),
          target: id,
          type: 'straight',
          style: { stroke: 'var(--text-muted)', strokeWidth: 1, strokeDasharray: '4 4' },
        })
      }
    }

    const parentEdges: Edge[] = rawEdges.map((e, index) => ({
      id: e.id || `e:${e.source}:${e.target}:${index}`,
      source: e.source,
      target: e.target,
      type: 'smoothstep',
      animated: true,
      style: { stroke: 'var(--text-muted)' },
    }))

    positionsRef.current = merged
    if (forceAuto) savePositions(researchId, merged)
    setNodes([...regular, ...imageNodes])
    setEdges([...parentEdges, ...imageEdges])
  }, [researchId, persistImgSize, setNodes, setEdges, textNodeSettings])

  const fetchGraph = useCallback(() => {
    stopReplay()
    setState((s) => ({ ...s, loading: true, error: null }))
    api(`/api/research-graph/${researchId}`)
      .then((payload: GraphPayload) => {
        dataRef.current = { nodes: payload.nodes, edges: payload.edges }
        imgSizeRef.current = loadImgSizes(researchId)
        buildNodes(modeRef.current, false)
        setState({ loading: false, error: null, exists: payload.exists })
      })
      .catch((e: any) => setState({ loading: false, error: e?.message || '加载失败', exists: false }))
  }, [researchId, buildNodes, stopReplay])

  useEffect(() => { fetchGraph() }, [researchId])

  useEffect(() => {
    const prev = prevTextNodeSettingsRef.current
    const changed = prev.width !== textNodeSettings.width ||
      prev.height !== textNodeSettings.height ||
      prev.fontSize !== textNodeSettings.fontSize
    prevTextNodeSettingsRef.current = textNodeSettings
    if (!changed || dataRef.current.nodes.length === 0) return

    stopReplay()
    buildNodes(modeRef.current, true)
    requestAnimationFrame(() => fitView({ duration: 250 }))
  }, [textNodeSettings, buildNodes, fitView, stopReplay])

  const onNodeDragStop = useCallback((_e: any, node: Node) => {
    positionsRef.current = { ...positionsRef.current, [node.id]: node.position }
    savePositions(researchId, positionsRef.current)
  }, [researchId])

  const relayout = useCallback((mode: LayoutMode) => {
    stopReplay()
    buildNodes(mode, true)
    setLayoutMode(mode)
    saveMode(researchId, mode)
    requestAnimationFrame(() => fitView({ duration: 300 }))
  }, [buildNodes, researchId, fitView, stopReplay])

  const resetLayout = useCallback(() => {
    localStorage.removeItem(posStorageKey(researchId))
    relayout(modeRef.current)
  }, [researchId, relayout])

  const toggleLayout = useCallback(() => {
    relayout(modeRef.current === 'grid' ? 'hierarchy' : 'grid')
  }, [relayout])

  // 回放顺序: 常规节点按拓扑序, 每个 owner 之后紧跟其图像卡片
  const computeRevealOrder = useCallback(() => {
    const { nodes: rawNodes, edges: rawEdges } = dataRef.current
    const haveImg = new Set(rawNodes.filter((n) => n.attached_images.length > 0).map((n) => String(n.id)))
    const seq: string[] = []
    for (const id of topoOrder(rawNodes, rawEdges)) {
      seq.push(id)
      if (haveImg.has(id)) seq.push(imgNodeId(Number(id)))
    }
    return seq
  }, [])

  const startReplay = useCallback(() => {
    clearTimers()
    const seq = computeRevealOrder()
    if (seq.length === 0) return
    revealOrderRef.current = seq
    // 跟踪模式: 保持当前缩放, 仅平移; 否则按既有行为先框住全图
    if (!trackingRef.current) fitView({ duration: 300 })
    setReplaying(true)
    setRevealedCount(0)
    seq.forEach((id, i) => {
      timersRef.current.push(window.setTimeout(() => {
        setRevealedCount(i + 1)
        // 跟踪: 把画面中心移到新跳出的常规卡片 (图像卡片不移动中心), 缩放保持不变
        if (trackingRef.current && !id.startsWith('img:')) {
          const pos = positionsRef.current[id]
          if (pos) {
            setCenter(
              pos.x + textNodeSettings.width / 2,
              pos.y + textNodeSettings.height / 2,
              { zoom: getZoom(), duration: Math.max(150, Math.min(speedMs, 500)) },
            )
          }
        }
      }, i * speedMs + 30))
    })
    timersRef.current.push(window.setTimeout(() => setReplaying(false), (seq.length - 1) * speedMs + 30 + animDur + 120))
  }, [clearTimers, computeRevealOrder, fitView, setCenter, getZoom, speedMs, animDur, textNodeSettings])

  // 回放期间: 未揭示的节点/边隐藏, 已揭示的带入场动画
  const displayNodes = useMemo(() => {
    if (!replaying) return nodes
    const revealed = new Set(revealOrderRef.current.slice(0, revealedCount))
    const anim: ReplayAnim = { effect, durationMs: animDur }
    return nodes.map((n) => {
      const shown = revealed.has(n.id)
      return { ...n, hidden: !shown, data: { ...n.data, anim: shown ? anim : undefined } }
    })
  }, [nodes, replaying, revealedCount, effect, animDur])

  const displayEdges = useMemo(() => {
    if (!replaying) return edges
    const revealed = new Set(revealOrderRef.current.slice(0, revealedCount))
    return edges.map((e) => ({ ...e, hidden: !(revealed.has(e.source) && revealed.has(e.target)) }))
  }, [edges, replaying, revealedCount])

  if (state.loading) {
    return <div className="flex items-center justify-center h-full text-[13px]" style={{ color: 'var(--text-muted)' }}>正在加载 Research Graph...</div>
  }
  if (state.error) {
    return <div className="flex items-center justify-center h-full text-[13px] text-red-400">{state.error}</div>
  }
  if (!state.exists || nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
        <div className="text-[14px]" style={{ color: 'var(--text-muted)' }}>
          {state.exists ? 'research-graph.yml 中暂无有效节点' : '当前 Research 尚未创建 research-graph.yml'}
        </div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          文件位置: <code>{HIDDEN_FOLDER_NAME}/blackboard/{researchId}/research-graph.yml</code>
        </div>
        <button onClick={fetchGraph} className="h-8 px-3 rounded-md text-[12px] bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15 transition-colors">
          重新加载
        </button>
      </div>
    )
  }

  return (
    <div className="relative w-full h-full" data-tour="research-graph">
      <style>{REPLAY_CSS}</style>
      <div className="absolute top-3 right-3 z-10 flex gap-2">
        <button onClick={replaying ? stopReplay : startReplay} title="从头逐个回放节点出现过程"
          className="h-7 px-2.5 rounded-md text-[11px] border transition-colors"
          style={{
            borderColor: replaying ? 'rgba(239,68,68,0.5)' : '#10b981',
            color: replaying ? '#f87171' : '#10b981',
            background: replaying ? 'rgba(239,68,68,0.08)' : 'rgba(16,185,129,0.08)',
          }}>
          {replaying ? '■ 停止' : '▶ 回放'}
        </button>
        <button onClick={() => setShowReplaySettings((v) => !v)} title="图表设置: 回放 / 普通节点"
          className="h-7 px-2 inline-flex items-center justify-center rounded-md text-[11px] bg-[var(--bg-primary)] border hover:bg-[var(--bg-hover)] transition-colors"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
          <Settings className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
        <button onClick={toggleLayout} title="切换布局: 拓扑方格网 / 层级"
          className="h-7 px-2.5 rounded-md text-[11px] bg-[var(--bg-primary)] border hover:bg-[var(--bg-hover)] transition-colors"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
          {layoutMode === 'grid' ? '布局: 方格' : '布局: 层级'}
        </button>
        <button onClick={fetchGraph} title="重新从 yml 加载"
          className="h-7 px-2.5 rounded-md text-[11px] bg-[var(--bg-primary)] border hover:bg-[var(--bg-hover)] transition-colors"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
          刷新
        </button>
        <button onClick={resetLayout} title="清除本地拖拽位置, 重新自动布局"
          className="h-7 px-2.5 rounded-md text-[11px] bg-[var(--bg-primary)] border hover:bg-[var(--bg-hover)] transition-colors"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
          重置布局
        </button>
      </div>
      {showReplaySettings && (
        <div className="absolute top-12 right-3 z-20 w-64 p-3 rounded-md border shadow-xl flex flex-col gap-3"
          style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}>
          <label className="flex items-center justify-between text-[11px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
            <span>跟踪新卡片 (居中, 不变缩放)</span>
            <input type="checkbox" checked={tracking} onChange={(e) => setTracking(e.target.checked)} className="accent-emerald-500" />
          </label>
          <div>
            <div className="flex items-center justify-between text-[11px] mb-1" style={{ color: 'var(--text-secondary)' }}>
              <span>速度 (每张间隔)</span>
              <span style={{ color: 'var(--text-muted)' }}>{speedMs}ms</span>
            </div>
            <input type="range" min={80} max={1200} step={20} value={speedMs}
              onChange={(e) => setSpeedMs(Number(e.target.value))} className="w-full accent-emerald-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[11px] mb-1" style={{ color: 'var(--text-secondary)' }}>
              <span>节点宽度</span>
              <span style={{ color: 'var(--text-muted)' }}>{textNodeWidth}px</span>
            </div>
            <input type="range"
              min={TEXT_NODE_WIDTH_RANGE.min}
              max={TEXT_NODE_WIDTH_RANGE.max}
              step={TEXT_NODE_WIDTH_RANGE.step}
              value={textNodeWidth}
              onChange={(e) => setTextNodeWidth(Number(e.target.value))}
              className="w-full accent-emerald-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[11px] mb-1" style={{ color: 'var(--text-secondary)' }}>
              <span>节点高度</span>
              <span style={{ color: 'var(--text-muted)' }}>{textNodeHeight}px</span>
            </div>
            <input type="range"
              min={TEXT_NODE_HEIGHT_RANGE.min}
              max={TEXT_NODE_HEIGHT_RANGE.max}
              step={TEXT_NODE_HEIGHT_RANGE.step}
              value={textNodeHeight}
              onChange={(e) => setTextNodeHeight(Number(e.target.value))}
              className="w-full accent-emerald-500" />
          </div>
          <div>
            <div className="flex items-center justify-between text-[11px] mb-1" style={{ color: 'var(--text-secondary)' }}>
              <span>字体大小</span>
              <span style={{ color: 'var(--text-muted)' }}>{textNodeFontSize}px</span>
            </div>
            <input type="range"
              min={TEXT_NODE_FONT_SIZE_RANGE.min}
              max={TEXT_NODE_FONT_SIZE_RANGE.max}
              step={TEXT_NODE_FONT_SIZE_RANGE.step}
              value={textNodeFontSize}
              onChange={(e) => setTextNodeFontSize(Number(e.target.value))}
              className="w-full accent-emerald-500" />
          </div>
          <div>
            <div className="text-[11px] mb-1" style={{ color: 'var(--text-secondary)' }}>入场特效</div>
            <div className="flex flex-wrap gap-1">
              {REPLAY_EFFECTS.map((ef) => (
                <button key={ef.value} onClick={() => setEffect(ef.value)}
                  className="px-2 py-1 rounded text-[11px] border transition-colors"
                  style={{
                    borderColor: effect === ef.value ? '#10b981' : 'var(--border-color)',
                    color: effect === ef.value ? '#10b981' : 'var(--text-secondary)',
                    background: effect === ef.value ? 'rgba(16,185,129,0.1)' : 'transparent',
                  }}>
                  {ef.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} color="var(--border-color)" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable style={{ background: 'var(--bg-secondary)' }} />
      </ReactFlow>
    </div>
  )
}

export default function ResearchGraph({ researchId }: { researchId: string }) {
  return (
    <ReactFlowProvider>
      <GraphInner researchId={researchId} />
    </ReactFlowProvider>
  )
}
