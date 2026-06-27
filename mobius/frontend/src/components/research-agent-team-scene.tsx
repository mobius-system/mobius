import { useEffect, useMemo, useRef } from 'react'
import { AdditiveBlending, DoubleSide, RepeatWrapping, SRGBColorSpace } from 'three/src/constants.js'
import { AmbientLight } from 'three/src/lights/AmbientLight.js'
import { DirectionalLight } from 'three/src/lights/DirectionalLight.js'
import { HemisphereLight } from 'three/src/lights/HemisphereLight.js'
import { BufferGeometry } from 'three/src/core/BufferGeometry.js'
import { Float32BufferAttribute } from 'three/src/core/BufferAttribute.js'
import { BoxGeometry } from 'three/src/geometries/BoxGeometry.js'
import { CircleGeometry } from 'three/src/geometries/CircleGeometry.js'
import { ConeGeometry } from 'three/src/geometries/ConeGeometry.js'
import { CylinderGeometry } from 'three/src/geometries/CylinderGeometry.js'
import { PlaneGeometry } from 'three/src/geometries/PlaneGeometry.js'
import { TorusGeometry } from 'three/src/geometries/TorusGeometry.js'
import { RingGeometry } from 'three/src/geometries/RingGeometry.js'
import { SphereGeometry } from 'three/src/geometries/SphereGeometry.js'
import { OctahedronGeometry } from 'three/src/geometries/OctahedronGeometry.js'
import { TorusKnotGeometry } from 'three/src/geometries/TorusKnotGeometry.js'
import { ExtrudeGeometry } from 'three/src/geometries/ExtrudeGeometry.js'
import { IcosahedronGeometry } from 'three/src/geometries/IcosahedronGeometry.js'
import { LatheGeometry } from 'three/src/geometries/LatheGeometry.js'
import { LineBasicMaterial } from 'three/src/materials/LineBasicMaterial.js'
import { MeshBasicMaterial } from 'three/src/materials/MeshBasicMaterial.js'
import { MeshStandardMaterial } from 'three/src/materials/MeshStandardMaterial.js'
import { MeshPhysicalMaterial } from 'three/src/materials/MeshPhysicalMaterial.js'
import { PointsMaterial } from 'three/src/materials/PointsMaterial.js'
import { SpriteMaterial } from 'three/src/materials/SpriteMaterial.js'
import { PerspectiveCamera } from 'three/src/cameras/PerspectiveCamera.js'
import { Raycaster } from 'three/src/core/Raycaster.js'
import type { Object3D } from 'three/src/core/Object3D.js'
import { clamp } from 'three/src/math/MathUtils.js'
import { Color } from 'three/src/math/Color.js'
import { Quaternion } from 'three/src/math/Quaternion.js'
import { Vector2 } from 'three/src/math/Vector2.js'
import { Vector3 } from 'three/src/math/Vector3.js'
import { Group } from 'three/src/objects/Group.js'
import { Line } from 'three/src/objects/Line.js'
import { LineSegments } from 'three/src/objects/LineSegments.js'
import { Mesh } from 'three/src/objects/Mesh.js'
import { Points } from 'three/src/objects/Points.js'
import { Sprite } from 'three/src/objects/Sprite.js'
import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js'
import { Scene } from 'three/src/scenes/Scene.js'
import { FogExp2 } from 'three/src/scenes/FogExp2.js'
import { CanvasTexture } from 'three/src/textures/CanvasTexture.js'
import { Shape } from 'three/src/extras/core/Shape.js'
import { PMREMGenerator } from 'three/src/extras/PMREMGenerator.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { ThemeName } from '../theme'

export type ResearchTeamSceneAgent = {
  id: string
  name: string
  purpose?: string
  role: 'chief_researcher' | 'research_assistant'
  modelLabel?: string
  mainSkillName?: string
  locked?: boolean
  status?: string
}

// 九个截然不同的场景 (灵感取自 threejs.org 经典示例: 城市天际线 / 研究实验室 / 深空星港 /
// 霓虹合成波网格 / 螺旋粒子星河 / 镜面海面 / 极光山谷 / 机械机库 / 全息训练场).
export type SceneKind = 'city' | 'lab' | 'space' | 'neon' | 'galaxy' | 'ocean' | 'aurora' | 'hangar' | 'grid'
// 七个截然不同的形象: 方块机器人 / 晶体核心 / 双螺旋 / 宇航机器人 / 水母 / 蘑菇 / 企鹅.
export type AvatarKind = 'robot' | 'crystal' | 'helix' | 'droid' | 'jellyfish' | 'mushroom' | 'penguin'

export const SCENE_KIND_OPTIONS: { value: SceneKind; label: string }[] = [
  { value: 'city', label: '城市天际线' },
  { value: 'lab', label: '研究实验室' },
  { value: 'space', label: '深空星港' },
  { value: 'neon', label: '霓虹合成波' },
  { value: 'galaxy', label: '螺旋星河' },
  { value: 'ocean', label: '镜面海面' },
  { value: 'aurora', label: '极光山谷' },
  { value: 'hangar', label: '机械机库' },
  { value: 'grid', label: '全息训练场' },
]
export const AVATAR_KIND_OPTIONS: { value: AvatarKind; label: string }[] = [
  { value: 'robot', label: '方块机器人' },
  { value: 'crystal', label: '晶体核心' },
  { value: 'helix', label: '双螺旋' },
  { value: 'droid', label: '宇航机器人' },
  { value: 'jellyfish', label: '水母' },
  { value: 'mushroom', label: '蘑菇' },
  { value: 'penguin', label: '企鹅' },
]

type SceneProps = {
  agents: ResearchTeamSceneAgent[]
  selectedId: string | null
  onSelect: (id: string) => void
  theme: ThemeName
  sceneKind?: SceneKind
  avatarKind?: AvatarKind
  canAdd?: boolean
  onAdd?: () => void
}

type SceneTarget = {
  center: Vector3
  cameraDistance: number
  stageRadius: number
}

type Palette = {
  background: number
  fog: number
  sky: number
  skyTop: number
  skyBottom: number
  ground: number
  groundFar: number
  stage: number
  platform: number
  runway: number
  runwaySoft: number
  building: number
  buildingTop: number
  labelBg: string
  labelBgSelected: string
  labelText: string
  labelMuted: string
  labelSkill: string
}

const CHIEF_COLOR = 0x10b981
const ASSISTANT_COLOR = 0x3b82f6
const LOCKED_COLOR = 0x94a3b8

function paletteForTheme(theme: SceneProps['theme']): Palette {
  if (theme === 'light') {
    return {
      background: 0xeaf4ff,
      fog: 0xdbeafe,
      sky: 0xf8fbff,
      skyTop: 0xeaf2ff,
      skyBottom: 0xf8fbff,
      ground: 0xd7e4ef,
      groundFar: 0xb9c8d6,
      stage: 0xe8f1f8,
      platform: 0x7dd3fc,
      runway: 0x0ea5e9,
      runwaySoft: 0x93c5fd,
      building: 0x9fb2c3,
      buildingTop: 0xe5f0fb,
      labelBg: 'rgba(248,250,252,0.93)',
      labelBgSelected: 'rgba(239,246,255,0.98)',
      labelText: '#0f172a',
      labelMuted: '#475569',
      labelSkill: '#1d4ed8',
    }
  }
  if (theme === 'purple') {
    return {
      background: 0x160f2a,
      fog: 0x251442,
      sky: 0x2e1b55,
      skyTop: 0x241245,
      skyBottom: 0x0d0720,
      ground: 0x1e1731,
      groundFar: 0x3c2b61,
      stage: 0x211b36,
      platform: 0xa78bfa,
      runway: 0x7dd3fc,
      runwaySoft: 0xc084fc,
      building: 0x352855,
      buildingTop: 0x8b5cf6,
      labelBg: 'rgba(25,18,45,0.91)',
      labelBgSelected: 'rgba(35,24,68,0.96)',
      labelText: '#f8fafc',
      labelMuted: '#c4b5fd',
      labelSkill: '#93c5fd',
    }
  }
  return {
    background: 0x08111d,
    fog: 0x0f172a,
    sky: 0x102235,
    skyTop: 0x0f1f33,
    skyBottom: 0x050a14,
    ground: 0x111827,
    groundFar: 0x233249,
    stage: 0x101827,
    platform: 0x38bdf8,
    runway: 0x22d3ee,
    runwaySoft: 0x3b82f6,
    building: 0x182338,
    buildingTop: 0x334155,
    labelBg: 'rgba(8,13,23,0.9)',
    labelBgSelected: 'rgba(15,23,42,0.95)',
    labelText: '#f8fafc',
    labelMuted: '#94a3b8',
    labelSkill: '#93c5fd',
  }
}

type ScenePalette = {
  bg: number
  fog: number
  sky: number
  skyTop: number
  skyBottom: number
  ground: number
  groundFar: number
  stage: number
  platform: number
  runway: number
  runwaySoft: number
  building: number
  buildingTop: number
}

// 每个场景一套截然不同的色板 (深色为主, light 主题给出柔和变体). 取自 threejs.org 各经典示例的视觉基调.
const SCENE_PALETTES: Record<SceneKind, { dark: ScenePalette; light: Partial<ScenePalette> }> = {
  city: {
    dark: { bg: 0x08111d, fog: 0x0f172a, sky: 0x102235, skyTop: 0x0f1f33, skyBottom: 0x050a14, ground: 0x111827, groundFar: 0x233249, stage: 0x101827, platform: 0x38bdf8, runway: 0x22d3ee, runwaySoft: 0x3b82f6, building: 0x182338, buildingTop: 0x334155 },
    light: { bg: 0xeaf4ff, fog: 0xdbeafe, sky: 0xf8fbff, skyTop: 0xeaf2ff, skyBottom: 0xf8fbff, ground: 0xd7e4ef, groundFar: 0xb9c8d6, stage: 0xe8f1f8, platform: 0x7dd3fc, runway: 0x0ea5e9, runwaySoft: 0x93c5fd, building: 0x9fb2c3, buildingTop: 0xe5f0fb },
  },
  lab: {
    dark: { bg: 0x04140d, fog: 0x082017, sky: 0x064e3b, skyTop: 0x072a1c, skyBottom: 0x021008, ground: 0x0a1f15, groundFar: 0x065f46, stage: 0x06170f, platform: 0x34d399, runway: 0x6ee7b7, runwaySoft: 0x10b981, building: 0x14532d, buildingTop: 0x4ade80 },
    light: { bg: 0xecfdf5, fog: 0xd1fae5, sky: 0x065f46, skyTop: 0xa7f3d0, skyBottom: 0xecfdf5, ground: 0xa7f3d0, groundFar: 0x6ee7b7, stage: 0xd1fae5, platform: 0x34d399, runway: 0x10b981, runwaySoft: 0x34d399, building: 0x065f46, buildingTop: 0x4ade80 },
  },
  space: {
    dark: { bg: 0x05030f, fog: 0x0b0524, sky: 0x1e1b4b, skyTop: 0x1a1140, skyBottom: 0x04020c, ground: 0x0d0a26, groundFar: 0x4c1d95, stage: 0x0a0820, platform: 0xa78bfa, runway: 0xc084fc, runwaySoft: 0x818cf8, building: 0x1e1b4b, buildingTop: 0x818cf8 },
    light: { bg: 0xddd6fe, fog: 0xc7d2fe, sky: 0x312e81, skyTop: 0x6d5fd0, skyBottom: 0xe0e7ff, ground: 0x312e81, groundFar: 0x4c1d95, stage: 0xede9fe, platform: 0xa78bfa, runway: 0x8b5cf6, runwaySoft: 0x6366f1, building: 0x4338ca, buildingTop: 0x818cf8 },
  },
  neon: {
    dark: { bg: 0x0a0420, fog: 0x140833, sky: 0x2a0a4a, skyTop: 0x3b1066, skyBottom: 0x0a0218, ground: 0x110628, groundFar: 0x3b0a5a, stage: 0x0a0420, platform: 0xf0abfc, runway: 0x22d3ee, runwaySoft: 0xe879f9, building: 0x1a0a33, buildingTop: 0xf472b6 },
    light: { bg: 0xfbe8ff, fog: 0xf5d0fe, sky: 0x7e22ce, skyTop: 0xa21caf, skyBottom: 0xfce7f3, ground: 0xf3e8ff, groundFar: 0xd8b4fe, stage: 0xfdf4ff, platform: 0xd946ef, runway: 0x06b6d4, runwaySoft: 0xc026d3, building: 0x86198f, buildingTop: 0xf472b6 },
  },
  galaxy: {
    dark: { bg: 0x03030a, fog: 0x070318, sky: 0x0a0820, skyTop: 0x0c0826, skyBottom: 0x020108, ground: 0x050410, groundFar: 0x0f0a2a, stage: 0x04030c, platform: 0x818cf8, runway: 0xa5b4fc, runwaySoft: 0xc4b5fd, building: 0x0a0820, buildingTop: 0x6366f1 },
    light: { bg: 0xeef2ff, fog: 0xe0e7ff, sky: 0x1e1b4b, skyTop: 0x4f46e5, skyBottom: 0xeef2ff, ground: 0xc7d2fe, groundFar: 0x818cf8, stage: 0xeef2ff, platform: 0x6366f1, runway: 0x818cf8, runwaySoft: 0xa5b4fc, building: 0x312e81, buildingTop: 0x6366f1 },
  },
  ocean: {
    dark: { bg: 0x041820, fog: 0x062a33, sky: 0x0e3a4a, skyTop: 0x1a4a5a, skyBottom: 0x06151c, ground: 0x06222b, groundFar: 0x0a3340, stage: 0x03141a, platform: 0x38bdf8, runway: 0x22d3ee, runwaySoft: 0x0ea5e9, building: 0x0a2832, buildingTop: 0x7dd3fc },
    light: { bg: 0xe0f2fe, fog: 0xbae6fd, sky: 0x0e7490, skyTop: 0x67a4c9, skyBottom: 0xe0f2fe, ground: 0x7dd3fc, groundFar: 0x38bdf8, stage: 0xf0f9ff, platform: 0x0ea5e9, runway: 0x06b6d4, runwaySoft: 0x0284c7, building: 0x075985, buildingTop: 0x38bdf8 },
  },
  aurora: {
    dark: { bg: 0x04101a, fog: 0x06202c, sky: 0x062236, skyTop: 0x08243a, skyBottom: 0x020a12, ground: 0x04141e, groundFar: 0x0a2230, stage: 0x03101a, platform: 0x5eead4, runway: 0x6ee7b7, runwaySoft: 0x5eead4, building: 0x061a26, buildingTop: 0x34d399 },
    light: { bg: 0xe6fbf4, fog: 0xc7f5e7, sky: 0x0f766e, skyTop: 0x5eead4, skyBottom: 0xecfdf5, ground: 0x99f6e4, groundFar: 0x5eead4, stage: 0xf0fdfa, platform: 0x14b8a6, runway: 0x10b981, runwaySoft: 0x14b8a6, building: 0x115e59, buildingTop: 0x34d399 },
  },
  hangar: {
    dark: { bg: 0x0c0f14, fog: 0x141a22, sky: 0x1a2230, skyTop: 0x1c2632, skyBottom: 0x06090d, ground: 0x11161e, groundFar: 0x1c2530, stage: 0x0e131a, platform: 0xfbbf24, runway: 0xf59e0b, runwaySoft: 0xfde68a, building: 0x2a3340, buildingTop: 0xfbbf24 },
    light: { bg: 0xeef1f5, fog: 0xdfe4ea, sky: 0x475569, skyTop: 0x97a3b5, skyBottom: 0xeef1f5, ground: 0xcbd2da, groundFar: 0x94a3b8, stage: 0xe2e6ec, platform: 0xf59e0b, runway: 0xd97706, runwaySoft: 0xfbbf24, building: 0x64748b, buildingTop: 0xf59e0b },
  },
  grid: {
    dark: { bg: 0x03101a, fog: 0x06222e, sky: 0x06222e, skyTop: 0x082a3a, skyBottom: 0x020a12, ground: 0x04161f, groundFar: 0x0a2a38, stage: 0x03121a, platform: 0x22d3ee, runway: 0x67e8f9, runwaySoft: 0x22d3ee, building: 0x0a2a38, buildingTop: 0x67e8f9 },
    light: { bg: 0xe0f7fb, fog: 0xbdf2f9, sky: 0x0e7490, skyTop: 0x5eb3c7, skyBottom: 0xe0f7fb, ground: 0xa5e8f2, groundFar: 0x67e8f9, stage: 0xeefafc, platform: 0x06b6d4, runway: 0x22d3ee, runwaySoft: 0x67e8f9, building: 0x0e7490, buildingTop: 0x22d3ee },
  },
}

// 场景切换: 用该场景专属色板覆盖主题 palette 的环境/舞台色 (标签色仍跟随主题).
function applySceneKind(palette: Palette, sceneKind: SceneKind | undefined, theme: SceneProps['theme']): Palette {
  if (!sceneKind || sceneKind === 'city') return palette
  const sp = SCENE_PALETTES[sceneKind]
  const colors = theme === 'light' ? { ...sp.dark, ...sp.light } : sp.dark
  return {
    ...palette,
    background: colors.bg,
    fog: colors.fog,
    sky: colors.sky,
    skyTop: colors.skyTop,
    skyBottom: colors.skyBottom,
    ground: colors.ground,
    groundFar: colors.groundFar,
    stage: colors.stage,
    platform: colors.platform,
    runway: colors.runway,
    runwaySoft: colors.runwaySoft,
    building: colors.building,
    buildingTop: colors.buildingTop,
  }
}

function truncateText(text: string, max: number) {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function roleLabel(role: ResearchTeamSceneAgent['role']) {
  return role === 'chief_researcher' ? 'chief' : 'assistant'
}

function layoutAgents(count: number) {
  return Array.from({ length: count }, (_, index) => {
    if (index === 0) return new Vector3(0, 0, 2.15)
    const rank = Math.ceil(index / 2)
    const side = index % 2 === 1 ? -1 : 1
    return new Vector3(side * rank * 2.25, 0, 2.15 - rank * 1.72)
  })
}

function boundsForPositions(positions: Vector3[]) {
  if (positions.length === 0) {
    return { minX: -2, maxX: 2, minZ: -2, maxZ: 2 }
  }
  return positions.reduce((acc, p) => ({
    minX: Math.min(acc.minX, p.x),
    maxX: Math.max(acc.maxX, p.x),
    minZ: Math.min(acc.minZ, p.z),
    maxZ: Math.max(acc.maxZ, p.z),
  }), {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  })
}

function computeTarget(positions: Vector3[], aspect: number): SceneTarget {
  const bounds = boundsForPositions(positions)
  const width = Math.max(6.4, bounds.maxX - bounds.minX + 4.6)
  const depth = Math.max(6.6, bounds.maxZ - bounds.minZ + 5.2)
  const center = new Vector3(
    (bounds.minX + bounds.maxX) / 2,
    0.55,
    (bounds.minZ + bounds.maxZ) / 2 - 0.28,
  )
  const stageRadius = Math.max(width, depth) * 0.62
  const cameraDistance = clamp(Math.max(depth * 1.35, width / Math.max(aspect, 0.55) * 1.2), 8.6, 18)
  return { center, cameraDistance, stageRadius }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function hexToCss(hex: number) {
  return `#${hex.toString(16).padStart(6, '0')}`
}

function makeLabelTexture(agent: ResearchTeamSceneAgent, selected: boolean, theme: SceneProps['theme']) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 188
  const ctx = canvas.getContext('2d')!
  const palette = paletteForTheme(theme)
  const isChief = agent.role === 'chief_researcher'
  const accent = selected ? '#38bdf8' : isChief ? '#10b981' : '#3b82f6'

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.shadowColor = theme === 'light' ? 'rgba(15,23,42,0.16)' : 'rgba(0,0,0,0.42)'
  ctx.shadowBlur = 16
  ctx.shadowOffsetY = 8
  roundRect(ctx, 18, 16, 476, 152, 18)
  ctx.fillStyle = selected ? palette.labelBgSelected : palette.labelBg
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.lineWidth = selected ? 4 : 2
  ctx.strokeStyle = accent
  ctx.stroke()

  ctx.fillStyle = accent
  roundRect(ctx, 36, 34, 54, 28, 14)
  ctx.fill()
  ctx.font = '700 16px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.fillText(isChief ? 'C' : 'A', 63, 54)
  ctx.textAlign = 'left'

  ctx.font = '700 31px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.fillStyle = palette.labelText
  ctx.fillText(truncateText(agent.name || '未命名 Agent', 18), 104, 58)

  ctx.font = '500 21px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.fillStyle = palette.labelMuted
  ctx.fillText(`${roleLabel(agent.role)} · ${truncateText(agent.modelLabel || '默认模型', 18)}`, 38, 98)

  ctx.font = '500 20px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.fillStyle = palette.labelSkill
  ctx.fillText(truncateText(agent.mainSkillName || '完全自定义', 28), 38, 130)

  const status = agent.locked ? '已创建 · 锁定' : agent.status || ''
  if (status) {
    ctx.font = '700 18px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.fillStyle = status.includes('失败') ? '#ef4444' : selected ? '#38bdf8' : '#10b981'
    ctx.fillText(truncateText(status, 18), 38, 156)
  }

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

function makeAddLabelTexture(theme: SceneProps['theme']) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const palette = paletteForTheme(theme)
  const accent = '#10b981'

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.shadowColor = theme === 'light' ? 'rgba(15,23,42,0.16)' : 'rgba(0,0,0,0.42)'
  ctx.shadowBlur = 16
  ctx.shadowOffsetY = 8
  roundRect(ctx, 18, 14, 476, 100, 18)
  ctx.fillStyle = palette.labelBg
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.lineWidth = 3
  ctx.setLineDash([12, 9])
  ctx.strokeStyle = accent
  ctx.stroke()
  ctx.setLineDash([])

  ctx.font = '700 30px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.fillStyle = accent
  ctx.textAlign = 'center'
  ctx.fillText('＋  添加 Agent', canvas.width / 2, 76)
  ctx.textAlign = 'left'

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

// 天空: 顶→底垂直渐变画布, 作为 scene.background (深色场景做出深邃天空感).
function makeSkyTexture(topHex: number, bottomHex: number) {
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height)
  grad.addColorStop(0, hexToCss(topHex))
  grad.addColorStop(1, hexToCss(bottomHex))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

// 柔光圆点贴图: 给粒子(星河/星场)用, 避免 hard 方块.
function makeDotTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.35, 'rgba(255,255,255,0.85)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 64, 64)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

// 合成波太阳贴图: 顶黄→粉→紫垂直渐变, 下半叠透明横纹(经典 synthwave 落日).
function makeSunTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height)
  grad.addColorStop(0, '#fde047')
  grad.addColorStop(0.4, '#fb923c')
  grad.addColorStop(0.62, '#f472b6')
  grad.addColorStop(1, '#a21caf')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(128, 128, 126, 0, Math.PI * 2)
  ctx.fill()
  // 下半透明横纹
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 7; i += 1) {
    const y = 150 + i * 12
    const h = 4 + i * 1.4
    ctx.fillRect(0, y, 256, h)
  }
  ctx.globalCompositeOperation = 'source-over'
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

// 霓虹网格贴图: 透明底 + 青/品红网格线, 平铺后随 offset 滚动.
function makeGridTexture(lineHex: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, 128, 128)
  ctx.strokeStyle = lineHex
  ctx.lineWidth = 3
  ctx.shadowColor = lineHex
  ctx.shadowBlur = 8
  ctx.beginPath()
  ctx.moveTo(0, 0); ctx.lineTo(128, 0)
  ctx.moveTo(0, 0); ctx.lineTo(0, 128)
  ctx.stroke()
  const texture = new CanvasTexture(canvas)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

// 极光缎带贴图: 纵向多色渐变(绿→青→紫) + 上下透明羽化.
function makeAuroraTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height)
  grad.addColorStop(0, 'rgba(52,211,153,0)')
  grad.addColorStop(0.25, 'rgba(52,211,153,0.95)')
  grad.addColorStop(0.5, 'rgba(45,212,191,0.9)')
  grad.addColorStop(0.75, 'rgba(129,140,248,0.85)')
  grad.addColorStop(1, 'rgba(167,139,250,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 32, 256)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

// 警示斑马纹贴图 (黄/深灰对角条), 机库对接口地标.
function makeStripeTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#111827'
  ctx.fillRect(0, 0, 64, 64)
  ctx.fillStyle = '#fbbf24'
  ctx.save()
  ctx.translate(32, 32)
  ctx.rotate(Math.PI / 4)
  for (let x = -64; x < 64; x += 22) ctx.fillRect(x, -48, 11, 96)
  ctx.restore()
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

function disposeObject(object: Object3D) {
  object.traverse((child: any) => {
    if (child.geometry) child.geometry.dispose()
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach((m: any) => {
        if (m.map) m.map.dispose()
        m.dispose()
      })
      else {
        if (child.material.map) child.material.map.dispose()
        child.material.dispose()
      }
    }
  })
}

function setAgentId(object: Object3D, agentId: string) {
  object.userData.agentId = agentId
  object.traverse((child) => {
    child.userData.agentId = agentId
  })
}

function makeLine(points: Vector3[], color: number, opacity: number) {
  const geometry = new BufferGeometry().setFromPoints(points)
  const material = new LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  return new Line(geometry, material)
}

function addGround(root: Group, target: SceneTarget, palette: Palette, theme: SceneProps['theme']) {
  const R = target.stageRadius
  const ground = new Mesh(new PlaneGeometry(R * 7, R * 6), new MeshStandardMaterial({
    color: palette.ground, roughness: 0.78, metalness: 0.02,
  }))
  ground.rotation.x = -Math.PI / 2
  ground.position.set(target.center.x, -0.08, target.center.z - R * 0.7)
  root.add(ground)

  const farGround = new Mesh(new PlaneGeometry(R * 7, R * 2.8), new MeshBasicMaterial({
    color: palette.groundFar, transparent: true, opacity: theme === 'light' ? 0.26 : 0.18, depthWrite: false,
  }))
  farGround.rotation.x = -Math.PI / 2
  farGround.position.set(target.center.x, -0.055, target.center.z - R * 2.25)
  root.add(farGround)
}

function addFogBands(root: Group, target: SceneTarget, palette: Palette, theme: SceneProps['theme']) {
  const R = target.stageRadius
  const mat = new MeshBasicMaterial({
    color: palette.fog, transparent: true, opacity: theme === 'light' ? 0.22 : 0.28, depthWrite: false,
  })
  for (let i = 0; i < 3; i += 1) {
    const band = new Mesh(new PlaneGeometry(R * 5.2, R * 0.48), mat.clone())
    band.position.set(target.center.x, 0.32 + i * 0.16, target.center.z - R * (1.35 + i * 0.48))
    band.rotation.x = -Math.PI * 0.36
    root.add(band)
  }
}

// 星场粒子: 球壳内随机散布的发光点, 用于深空/极光/星河背景.
function makeStarField(count: number, innerR: number, outerR: number, size: number, dotTex: CanvasTexture, colorVariation = false) {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const warm = new Color(0xfff1c9)
  const cool = new Color(0xb6c6ff)
  for (let i = 0; i < count; i += 1) {
    const r = innerR + Math.random() * (outerR - innerR)
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(Math.random() * 1.4 - 0.4)
    positions[i * 3] = Math.sin(phi) * Math.cos(theta) * r
    positions[i * 3 + 1] = Math.abs(Math.cos(phi)) * r * 0.7 + 1.2
    positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r
    const c = colorVariation && Math.random() > 0.7 ? warm : cool
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3))
  const mat = new PointsMaterial({
    size, map: dotTex, vertexColors: true, transparent: true,
    depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true,
  })
  const points = new Points(geo, mat)
  return points
}

type BackdropBuild = { root: Group; animate?: (t: number) => void }

// city: 城市天际线 (沿用的方块楼群 + 地面 + 雾带).
function makeCityline(target: SceneTarget, palette: Palette, theme: SceneProps['theme']) {
  const root = new Group()
  const blockMaterial = new MeshStandardMaterial({
    color: palette.building, roughness: 0.8, metalness: 0.08,
    emissive: new Color(palette.buildingTop).multiplyScalar(theme === 'light' ? 0.015 : 0.045),
  })
  const capMaterial = new MeshBasicMaterial({
    color: palette.buildingTop, transparent: true, opacity: theme === 'light' ? 0.18 : 0.28, depthWrite: false,
  })

  const count = 72
  const spread = Math.max(target.stageRadius * 4.8, 28)
  const backZ = target.center.z - target.stageRadius * 2.35
  for (let i = 0; i < count; i += 1) {
    const n = i + 1
    const lane = i % 3
    const x = (((n * 47) % 113) / 112 - 0.5) * spread
    const z = backZ - lane * 2.15 - (((n * 31) % 97) / 96) * 2.2
    const h = 0.6 + (((n * 43) % 100) / 99) * 3.2
    const w = 0.28 + (((n * 19) % 100) / 99) * 0.85
    const d = 0.28 + (((n * 23) % 100) / 99) * 0.65
    const block = new Mesh(new BoxGeometry(w, h, d), blockMaterial.clone())
    block.position.set(target.center.x + x, h / 2 - 0.08, z)
    root.add(block)
    if (i % 4 === 0) {
      const cap = new Mesh(new BoxGeometry(w * 0.72, 0.035, d * 0.72), capMaterial.clone())
      cap.position.set(block.position.x, h + 0.02, block.position.z)
      root.add(cap)
    }
  }
  return root
}

function makeBackdropCity(target: SceneTarget, palette: Palette, theme: SceneProps['theme']): BackdropBuild {
  const root = new Group()
  addGround(root, target, palette, theme)
  root.add(makeCityline(target, palette, theme))
  addFogBands(root, target, palette, theme)
  return { root }
}

// lab: 研究实验室 — 发光反应堆管道 + 半球温室 + 连接横梁 (绿调).
function makeBackdropLab(target: SceneTarget, palette: Palette, theme: SceneProps['theme']): BackdropBuild {
  const root = new Group()
  addGround(root, target, palette, theme)
  const R = target.stageRadius
  const backZ = target.center.z - R * 2.1
  const shellMat = new MeshStandardMaterial({ color: palette.building, roughness: 0.5, metalness: 0.3, transparent: true, opacity: 0.5 })
  const liquidMats: MeshBasicMaterial[] = []
  const liquid = (color: number) => {
    const m = new MeshBasicMaterial({ color, transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false })
    liquidMats.push(m)
    return m
  }
  const domeMat = new MeshStandardMaterial({ color: palette.platform, roughness: 0.3, metalness: 0.2, transparent: true, opacity: 0.32, emissive: new Color(palette.platform).multiplyScalar(0.12), side: DoubleSide })

  for (let i = 0; i < 7; i += 1) {
    const x = target.center.x + (i - 3) * (R * 0.62)
    const z = backZ - (i % 2) * 1.6
    const h = 2.4 + ((i * 37) % 100) / 100 * 1.8
    // 玻璃外壳
    const shell = new Mesh(new CylinderGeometry(0.42, 0.42, h, 20, 1, true), shellMat.clone())
    shell.position.set(x, h / 2 - 0.08, z)
    root.add(shell)
    // 发光液柱
    const liq = new Mesh(new CylinderGeometry(0.26, 0.26, h * 0.92, 16), liquid(i % 2 ? palette.runway : palette.runwaySoft))
    liq.position.set(x, h * 0.46 - 0.08, z)
    root.add(liq)
    // 顶帽
    const cap = new Mesh(new CylinderGeometry(0.5, 0.42, 0.18, 20), new MeshStandardMaterial({ color: palette.buildingTop, roughness: 0.4, metalness: 0.5 }))
    cap.position.set(x, h - 0.04, z)
    root.add(cap)
  }
  // 半球温室
  for (let i = 0; i < 3; i += 1) {
    const x = target.center.x + (i - 1) * (R * 1.5)
    const z = backZ - 3.2
    const dome = new Mesh(new SphereGeometry(1.1, 28, 16, 0, Math.PI * 2, 0, Math.PI / 2), domeMat.clone())
    dome.position.set(x, -0.06, z)
    root.add(dome)
  }
  // 连接横梁
  const beamMat = new MeshStandardMaterial({ color: palette.buildingTop, roughness: 0.5, metalness: 0.4, emissive: new Color(palette.runwaySoft).multiplyScalar(0.08) })
  for (let i = 0; i < 6; i += 1) {
    const beam = new Mesh(new BoxGeometry(R * 1.4, 0.07, 0.07), beamMat.clone())
    beam.position.set(target.center.x + (i - 2.5) * 0.1, 3.6 + (i % 2) * 0.4, backZ + 0.6)
    root.add(beam)
  }
  addFogBands(root, target, palette, theme)

  const animate = (t: number) => {
    const pulse = 0.62 + Math.sin(t * 1.6) * 0.26
    liquidMats.forEach((m, i) => { m.opacity = pulse * (0.7 + (i % 3) * 0.12) })
  }
  return { root, animate }
}

// space: 深空星港 — 密集星场 + 带环行星 + 星云气团 (紫调).
function makeBackdropSpace(target: SceneTarget, palette: Palette, theme: SceneProps['theme']): BackdropBuild {
  const root = new Group()
  const dotTex = makeDotTexture()
  const stars = makeStarField(1500, target.stageRadius * 2.4, target.stageRadius * 6.5, 0.09, dotTex, true)
  root.add(stars)

  // 带环行星
  const planet = new Group()
  const planetCore = new Mesh(new SphereGeometry(2.1, 48, 48), new MeshStandardMaterial({
    color: palette.building, roughness: 0.7, metalness: 0.1,
    emissive: new Color(palette.buildingTop).multiplyScalar(theme === 'light' ? 0.05 : 0.12),
  }))
  planet.add(planetCore)
  const planetRing = new Mesh(new RingGeometry(2.7, 4.1, 80), new MeshBasicMaterial({
    color: palette.runway, transparent: true, opacity: theme === 'light' ? 0.5 : 0.6, side: DoubleSide, blending: AdditiveBlending, depthWrite: false,
  }))
  planetRing.rotation.x = Math.PI / 2.4
  planet.add(planetRing)
  planet.position.set(target.center.x - target.stageRadius * 2.4, 5.2, target.center.z - target.stageRadius * 4.6)
  root.add(planet)

  // 星云气团
  const nebulaMat = (c: number, op: number) => new SpriteMaterial({ map: dotTex, color: c, transparent: true, opacity: op, blending: AdditiveBlending, depthWrite: false })
  const nebula1 = new Sprite(nebulaMat(0x7c3aed, theme === 'light' ? 0.18 : 0.32)); nebula1.scale.set(16, 16, 1); nebula1.position.set(target.center.x + 9, 5, target.center.z - 14)
  const nebula2 = new Sprite(nebulaMat(0x2563eb, theme === 'light' ? 0.14 : 0.26)); nebula2.scale.set(13, 13, 1); nebula2.position.set(target.center.x - 11, 3.5, target.center.z - 16)
  root.add(nebula1, nebula2)

  const animate = (t: number) => {
    stars.rotation.y = t * 0.015
    planet.rotation.y = t * 0.08
    planetRing.rotation.z = t * 0.12
  }
  return { root, animate }
}

// neon: 霓虹合成波 — 滚动网格地面 + 合成波落日 + 线框山 (品红/青).
function makeBackdropNeon(target: SceneTarget, palette: Palette, theme: SceneProps['theme']): BackdropBuild {
  const root = new Group()
  const R = target.stageRadius
  // 网格地面 (延伸至地平线, 贴图随时间滚动)
  const gridTex = makeGridTexture(theme === 'light' ? '#d946ef' : '#22d3ee')
  gridTex.repeat.set(10, 16)
  const grid = new Mesh(new PlaneGeometry(R * 9, R * 7, 1, 1), new MeshBasicMaterial({
    map: gridTex, transparent: true, opacity: theme === 'light' ? 0.6 : 0.8, side: DoubleSide, blending: AdditiveBlending, depthWrite: false,
  }))
  grid.rotation.x = -Math.PI / 2
  grid.position.set(target.center.x, -0.04, target.center.z - R * 1.6)
  root.add(grid)

  // 合成波太阳
  const sun = new Mesh(new CircleGeometry(2.4, 64), new MeshBasicMaterial({ map: makeSunTexture(), transparent: true, depthWrite: false }))
  sun.position.set(target.center.x, 2.1, target.center.z - R * 4.2)
  root.add(sun)
  // 太阳光晕
  const sunGlow = new Sprite(new SpriteMaterial({ map: makeDotTexture(), color: 0xf472b6, transparent: true, opacity: theme === 'light' ? 0.3 : 0.45, blending: AdditiveBlending, depthWrite: false }))
  sunGlow.scale.set(9, 9, 1); sunGlow.position.copy(sun.position)
  root.add(sunGlow)

  // 线框山 (两侧三角剪影)
  const mtnMat = new MeshBasicMaterial({ color: palette.buildingTop, wireframe: true, transparent: true, opacity: theme === 'light' ? 0.5 : 0.7 })
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 0; i < 3; i += 1) {
      const mtn = new Mesh(new ConeGeometry(2.4 + i * 0.6, 3 + i * 0.8, 4), mtnMat.clone())
      mtn.position.set(target.center.x + s * (R * 1.8 + i * 1.4), 1.2, target.center.z - R * (2.4 + i * 0.5))
      mtn.rotation.y = Math.PI / 4
      root.add(mtn)
    }
  }

  const animate = (t: number) => {
    gridTex.offset.y = (t * 0.18) % 1
    const s = 1 + Math.sin(t * 1.2) * 0.04
    sun.scale.setScalar(s)
  }
  return { root, animate }
}

// galaxy: 螺旋粒子星河 — 数千粒子组成旋臂, 核心暖外缘冷, 缓慢自转 (threejs.org galaxy 经典).
function makeBackdropGalaxy(target: SceneTarget, palette: Palette, theme: SceneProps['theme']): BackdropBuild {
  const root = new Group()
  const dotTex = makeDotTexture()
  const COUNT = 7000
  const arms = 4
  const spin = 1.1
  const maxR = target.stageRadius * 2.4
  const positions = new Float32Array(COUNT * 3)
  const colors = new Float32Array(COUNT * 3)
  const inside = new Color(theme === 'light' ? 0xfbbf24 : 0xfff0c4)
  const outside = new Color(theme === 'light' ? 0x6366f1 : 0x6d8bff)
  for (let i = 0; i < COUNT; i += 1) {
    const r = Math.pow(Math.random(), 0.62) * maxR
    const branch = (i % arms) / arms * Math.PI * 2
    const spinAngle = r * spin / maxR * 3.2
    const randomness = Math.pow(Math.random(), 3) * (Math.random() < 0.5 ? 1 : -1) * 0.34 * (r / maxR + 0.2)
    const angle = branch + spinAngle + randomness
    positions[i * 3] = Math.cos(angle) * r + target.center.x
    positions[i * 3 + 1] = (Math.random() - 0.5) * 0.5 * Math.pow(1 - r / maxR, 1.6) + 0.6
    positions[i * 3 + 2] = Math.sin(angle) * r + (target.center.z - target.stageRadius * 1.8)
    const c = inside.clone().lerp(outside, r / maxR)
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3))
  const galaxy = new Points(geo, new PointsMaterial({
    size: 0.085, map: dotTex, vertexColors: true, transparent: true,
    depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true,
  }))
  root.add(galaxy)
  // 核心光球
  const core = new Sprite(new SpriteMaterial({ map: dotTex, color: theme === 'light' ? 0xfbbf24 : 0xffe7a8, transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false }))
  core.scale.set(4.5, 4.5, 1)
  core.position.set(target.center.x, 0.6, target.center.z - target.stageRadius * 1.8)
  root.add(core)
  // 背景星
  root.add(makeStarField(900, target.stageRadius * 3, target.stageRadius * 7, 0.07, dotTex, true))

  const animate = (t: number) => { galaxy.rotation.y = t * 0.06 }
  return { root, animate }
}

// ocean: 镜面海面 — 顶点波动的水面 + 地平线落日 + 反光 (青蓝).
function makeBackdropOcean(target: SceneTarget, palette: Palette, theme: SceneProps['theme']): BackdropBuild {
  const root = new Group()
  const R = target.stageRadius
  const SEG = 48
  const waterGeo = new PlaneGeometry(R * 9, R * 6, SEG, SEG)
  const baseY = waterGeo.attributes.position.array.slice(0)
  const water = new Mesh(waterGeo, new MeshStandardMaterial({
    color: palette.ground, roughness: 0.22, metalness: 0.65,
    emissive: new Color(palette.platform).multiplyScalar(theme === 'light' ? 0.04 : 0.08),
  }))
  water.rotation.x = -Math.PI / 2
  water.position.set(target.center.x, -0.06, target.center.z - R * 1.5)
  root.add(water)
  // 水面之上薄雾带
  addFogBands(root, target, palette, theme)
  // 地平线落日
  const sun = new Sprite(new SpriteMaterial({ map: makeDotTexture(), color: theme === 'light' ? 0xfbbf24 : 0xfde68a, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }))
  sun.scale.set(6, 6, 1)
  sun.position.set(target.center.x, 2.4, target.center.z - R * 4.4)
  root.add(sun)

  const animate = (t: number) => {
    const pos = waterGeo.attributes.position as any
    const arr = pos.array as Float32Array
    for (let i = 0; i < arr.length; i += 3) {
      const x = baseY[i]
      const y = baseY[i + 1]
      arr[i + 2] = Math.sin(x * 0.6 + t * 1.4) * 0.12 + Math.sin(y * 0.9 + t * 1.1) * 0.1
    }
    pos.needsUpdate = true
    waterGeo.computeVertexNormals()
    const s = 1 + Math.sin(t * 0.9) * 0.06
    sun.scale.set(6 * s, 6 * s, 1)
  }
  return { root, animate }
}

// aurora: 极光山谷 — 多条飘动极光缎带 + 山影 + 星空 (青绿/紫).
function makeBackdropAurora(target: SceneTarget, palette: Palette, theme: SceneProps['theme']): BackdropBuild {
  const root = new Group()
  const R = target.stageRadius
  // 深色谷底
  const floor = new Mesh(new PlaneGeometry(R * 8, R * 5), new MeshStandardMaterial({ color: palette.ground, roughness: 0.9, metalness: 0.0 }))
  floor.rotation.x = -Math.PI / 2
  floor.position.set(target.center.x, -0.08, target.center.z - R * 1.4)
  root.add(floor)
  // 星空
  const dotTex = makeDotTexture()
  root.add(makeStarField(1100, R * 2.6, R * 6.5, 0.07, dotTex, true))
  // 极光缎带
  const auroraTex = makeAuroraTexture()
  const ribbons: { mesh: Mesh; base: number; phase: number }[] = []
  const ribbonGeo = new PlaneGeometry(R * 5.4, 7.5)
  for (let i = 0; i < 5; i += 1) {
    const mat = new MeshBasicMaterial({ map: auroraTex, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false, side: DoubleSide })
    const ribbon = new Mesh(ribbonGeo, mat)
    ribbon.position.set(
      target.center.x + (i - 2) * (R * 0.55),
      4.6 + (i % 2) * 0.5,
      target.center.z - R * (3.6 + (i % 3) * 0.5),
    )
    ribbon.rotation.x = -Math.PI * 0.12
    root.add(ribbon)
    ribbons.push({ mesh: ribbon, base: 0.5 + (i % 3) * 0.08, phase: i * 0.9 })
  }
  // 山影 (前后两层三角剪影)
  const mtnMat = new MeshBasicMaterial({ color: theme === 'light' ? 0x115e59 : 0x04141e, transparent: true, opacity: 1 })
  for (let layer = 0; layer < 2; layer += 1) {
    for (let i = 0; i < 7; i += 1) {
      const w = 3 + ((i * 29) % 100) / 100 * 2.4
      const h = 2.2 + ((i * 53) % 100) / 100 * (layer === 0 ? 2.6 : 1.6)
      const mtn = new Mesh(new ConeGeometry(w, h, 4), mtnMat.clone())
      mtn.position.set(
        target.center.x + (i - 3) * (R * 0.95) + (layer ? 0.5 : 0),
        h / 2 - 0.1,
        target.center.z - R * (layer === 0 ? 2.4 : 3.4),
      )
      mtn.rotation.y = Math.PI / 4
      root.add(mtn)
    }
  }

  const animate = (t: number) => {
    ribbons.forEach((rb) => {
      const mat = rb.mesh.material as MeshBasicMaterial
      mat.opacity = rb.base + Math.sin(t * 0.7 + rb.phase) * 0.22
      rb.mesh.scale.x = 1 + Math.sin(t * 0.4 + rb.phase) * 0.08
      rb.mesh.rotation.z = Math.sin(t * 0.3 + rb.phase) * 0.05
    })
  }
  return { root, animate }
}

// 全息网格面板: XY 平面的发光线网格 (LineSegments), 旋转后当地面/墙/顶.
function makeGridPlane(size: number, divisions: number, color: number, opacity: number) {
  const step = size / divisions
  const half = size / 2
  const pts: number[] = []
  for (let i = 0; i <= divisions; i += 1) {
    const v = -half + i * step
    pts.push(-half, v, 0, half, v, 0)
    pts.push(v, -half, 0, v, half, 0)
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(pts, 3))
  const mat = new LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: AdditiveBlending })
  return new LineSegments(geo, mat)
}

// hangar: 机械机库 — 钢结构立柱 + 龙门吊 + 后墙机柜阵列(指示灯闪烁) + 警示地标 + 顶灯 (钢铁灰+琥珀).
function makeBackdropHangar(target: SceneTarget, palette: Palette, theme: SceneProps['theme']): BackdropBuild {
  const root = new Group()
  addGround(root, target, palette, theme)
  const R = target.stageRadius
  const cx = target.center.x
  const cz = target.center.z
  const back = cz - R * 2.6
  const steel = new MeshStandardMaterial({ color: palette.building, roughness: 0.62, metalness: 0.55 })
  const steelLite = new MeshStandardMaterial({
    color: palette.buildingTop, roughness: 0.5, metalness: 0.45,
    emissive: new Color(palette.buildingTop).multiplyScalar(theme === 'light' ? 0.05 : 0.1),
  })
  const span = R * 2.0
  // 四角钢柱
  ;([[1, 1], [-1, 1], [1, -1], [-1, -1]] as const).forEach(([sx, sz]) => {
    const pillar = new Mesh(new BoxGeometry(0.36, 7.4, 0.36), steel.clone())
    pillar.position.set(cx + sx * span, 3.6, back + (sz > 0 ? R * 1.0 : 0))
    root.add(pillar)
  })
  // 龙门吊: 主梁(沿X) + 横轨(沿Z) + 小车 + 钩缆
  const gantryZ = back + R * 0.5
  const mainBeam = new Mesh(new BoxGeometry(span * 2.2, 0.34, 0.34), steel.clone())
  mainBeam.position.set(cx, 7.0, gantryZ); root.add(mainBeam)
  const rail = new Mesh(new BoxGeometry(0.34, 0.34, R * 2.2), steel.clone())
  rail.position.set(cx, 7.0, gantryZ); root.add(rail)
  const trolley = new Mesh(new BoxGeometry(0.5, 0.34, 0.5), steelLite.clone())
  trolley.position.set(cx, 6.8, gantryZ); root.add(trolley)
  root.add(makeLine([new Vector3(cx, 6.6, gantryZ), new Vector3(cx, 4.4, gantryZ)], palette.runwaySoft, theme === 'light' ? 0.4 : 0.6))
  const hook = new Mesh(new BoxGeometry(0.14, 0.14, 0.14), steelLite.clone())
  hook.position.set(cx, 4.3, gantryZ); root.add(hook)
  // 后墙机柜阵列 + 指示灯
  const ledMats: MeshBasicMaterial[] = []
  for (let i = 0; i < 11; i += 1) {
    const x = cx + (i - 5) * (R * 0.4)
    const rack = new Mesh(new BoxGeometry(0.5, 4.4, 0.5), steel.clone())
    rack.position.set(x, 2.1, back - 0.2); root.add(rack)
    for (let l = 0; l < 5; l += 1) {
      const led = new Mesh(new BoxGeometry(0.035, 0.035, 0.02), new MeshBasicMaterial({ color: l % 2 ? palette.runway : palette.runwaySoft, transparent: true, opacity: 0.9 }))
      led.position.set(x - 0.18 + l * 0.09, 3.9, back + 0.06)
      root.add(led)
      ledMats.push(led.material)
    }
  }
  // 对接口警示地标
  const stripeTex = makeStripeTexture()
  stripeTex.wrapS = RepeatWrapping
  stripeTex.wrapT = RepeatWrapping
  stripeTex.repeat.set(6, 1)
  const stripe = new Mesh(new PlaneGeometry(R * 3.6, 0.5), new MeshBasicMaterial({ map: stripeTex, transparent: true, opacity: theme === 'light' ? 0.55 : 0.7, depthWrite: false }))
  stripe.rotation.x = -Math.PI / 2
  stripe.position.set(cx, 0.02, cz + R * 0.95)
  root.add(stripe)
  // 顶灯
  const lightMat = new SpriteMaterial({ map: makeDotTexture(), color: palette.runwaySoft, transparent: true, opacity: theme === 'light' ? 0.4 : 0.6, blending: AdditiveBlending, depthWrite: false })
  ;[-1, 0, 1].forEach((i) => {
    const l = new Sprite(lightMat.clone())
    l.scale.set(2.2, 2.2, 1)
    l.position.set(cx + i * R * 1.2, 6.6, back + R * 0.6)
    root.add(l)
  })
  addFogBands(root, target, palette, theme)
  const animate = (t: number) => {
    ledMats.forEach((m, i) => { m.opacity = 0.35 + Math.abs(Math.sin(t * 1.8 + i * 0.4)) * 0.6 })
  }
  return { root, animate }
}

// grid: 全息训练场 — 封闭式发光线网格竞技场(地+顶+三面墙) + 上下扫描全息面 (青蓝). 适合机器人训练/仿真.
function makeBackdropGrid(target: SceneTarget, palette: Palette, theme: SceneProps['theme']): BackdropBuild {
  const root = new Group()
  const R = target.stageRadius
  const cx = target.center.x
  const arenaZ = target.center.z - R * 0.4
  const S = R * 2.6
  const H = R * 2.4
  const col = palette.runway
  const op = theme === 'light' ? 0.32 : 0.46

  const floor = makeGridPlane(S, 14, col, op)
  floor.rotation.x = -Math.PI / 2
  floor.position.set(cx, -0.02, arenaZ)
  root.add(floor)

  const ceil = makeGridPlane(S, 10, col, op * 0.4)
  ceil.rotation.x = Math.PI / 2
  ceil.position.set(cx, H, arenaZ)
  root.add(ceil)

  const wallB = makeGridPlane(S, 12, col, op * 0.8)
  wallB.position.set(cx, H / 2, arenaZ - S / 2)
  root.add(wallB)

  const wallL = makeGridPlane(S, 12, col, op * 0.6)
  wallL.rotation.y = Math.PI / 2
  wallL.position.set(cx - S / 2, H / 2, arenaZ)
  root.add(wallL)

  const wallR = makeGridPlane(S, 12, col, op * 0.6)
  wallR.rotation.y = Math.PI / 2
  wallR.position.set(cx + S / 2, H / 2, arenaZ)
  root.add(wallR)

  // 全息扫描面 (上下扫)
  const scan = new Mesh(new PlaneGeometry(S, S), new MeshBasicMaterial({ color: col, transparent: true, opacity: 0.1, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }))
  scan.rotation.x = -Math.PI / 2
  scan.position.set(cx, 0.04, arenaZ)
  root.add(scan)

  // 四角发光立柱
  const pillarMat = new MeshBasicMaterial({ color: palette.platform, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false })
  ;([[1, 1], [1, -1], [-1, 1], [-1, -1]] as const).forEach(([sx, sz]) => {
    const p = new Mesh(new BoxGeometry(0.07, H, 0.07), pillarMat.clone())
    p.position.set(cx + sx * S / 2, H / 2, arenaZ + sz * S / 2)
    root.add(p)
  })

  const animate = (t: number) => {
    const m = scan.material as MeshBasicMaterial
    scan.position.y = (Math.sin(t * 0.5) * 0.5 + 0.5) * H
    m.opacity = 0.06 + Math.abs(Math.cos(t * 0.5)) * 0.14
  }
  return { root, animate }
}

function makeBackdrop(target: SceneTarget, palette: Palette, theme: SceneProps['theme'], sceneKind: SceneKind | undefined): BackdropBuild {
  switch (sceneKind) {
    case 'lab': return makeBackdropLab(target, palette, theme)
    case 'space': return makeBackdropSpace(target, palette, theme)
    case 'neon': return makeBackdropNeon(target, palette, theme)
    case 'galaxy': return makeBackdropGalaxy(target, palette, theme)
    case 'ocean': return makeBackdropOcean(target, palette, theme)
    case 'aurora': return makeBackdropAurora(target, palette, theme)
    case 'hangar': return makeBackdropHangar(target, palette, theme)
    case 'grid': return makeBackdropGrid(target, palette, theme)
    case 'city':
    default: return makeBackdropCity(target, palette, theme)
  }
}

// 共享舞台: 圆形平台 + 光环 + 跑道线 (Agent 始终站在此处, 不随场景变).
function makeStage(target: SceneTarget, palette: Palette, theme: SceneProps['theme']) {
  const root = new Group()
  const radius = target.stageRadius

  const platform = new Mesh(new CircleGeometry(radius, 96), new MeshStandardMaterial({
    color: palette.stage, roughness: 0.52, metalness: 0.18,
    emissive: new Color(palette.platform).multiplyScalar(theme === 'light' ? 0.025 : 0.06),
  }))
  platform.rotation.x = -Math.PI / 2
  platform.scale.z = 0.55
  platform.position.set(target.center.x, 0.012, target.center.z + radius * 0.1)
  root.add(platform)

  const ring = new Mesh(new TorusGeometry(radius * 0.98, 0.018, 8, 128), new MeshBasicMaterial({
    color: palette.platform, transparent: true, opacity: theme === 'light' ? 0.35 : 0.48, depthWrite: false, blending: AdditiveBlending,
  }))
  ring.rotation.x = Math.PI / 2
  ring.scale.z = 0.55
  ring.position.copy(platform.position)
  ring.position.y = 0.045
  root.add(ring)

  for (let i = -3; i <= 3; i += 1) {
    const alpha = i === 0 ? 0.34 : 0.15
    root.add(makeLine([
      new Vector3(target.center.x + i * radius * 0.28, 0.05, target.center.z + radius * 0.7),
      new Vector3(target.center.x + i * radius * 0.46, 0.05, target.center.z - radius * 1.1),
    ], palette.runwaySoft, theme === 'light' ? alpha * 0.72 : alpha))
  }
  return root
}

function makeFormationLines(positions: Vector3[], palette: Palette, theme: SceneProps['theme']) {
  const root = new Group()
  if (positions.length < 2) return root
  const chief = positions[0]
  const opacity = theme === 'light' ? 0.36 : 0.52
  const leftWing = positions.filter((_, index) => index > 0 && index % 2 === 1)
  const rightWing = positions.filter((_, index) => index > 0 && index % 2 === 0)
  if (leftWing.length > 0) root.add(makeLine([chief, ...leftWing].map(p => new Vector3(p.x, 0.08, p.z)), palette.runway, opacity))
  if (rightWing.length > 0) root.add(makeLine([chief, ...rightWing].map(p => new Vector3(p.x, 0.08, p.z)), palette.runway, opacity))
  return root
}

type AvatarBuild = { group: Group; clickable: Object3D[]; animate?: (t: number) => void }

// 虹彩珠光材质 (清漆层 + iridescence 油膜虹彩): 用于花瓣/翅膀/冰晶等"精致"形象.
function pearlMat(color: number, selected: boolean, side: 0 | 1 | 2 = 0): MeshPhysicalMaterial {
  const mat = new MeshPhysicalMaterial({
    color, metalness: 0.25, roughness: 0.18,
    clearcoat: 1, clearcoatRoughness: 0.08,
    iridescence: 1, iridescenceIOR: 1.3, iridescenceThicknessRange: [120, 420],
    emissive: new Color(color).multiplyScalar(selected ? 0.12 : 0.05),
  })
  if (side) mat.side = side
  return mat
}

// 真玻璃材质 (transmission 折射透过背景 + 虹彩): 用于琉璃花瓶.
function glassMat(color: number, selected: boolean): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    color, metalness: 0, roughness: 0.05,
    transmission: 0.9, thickness: 0.5, ior: 1.45,
    clearcoat: 1, clearcoatRoughness: 0.04,
    iridescence: 0.7, iridescenceIOR: 1.25, iridescenceThicknessRange: [100, 400],
    transparent: true, side: DoubleSide,
    emissive: new Color(color).multiplyScalar(selected ? 0.08 : 0.03),
  })
}

function makeAgentAvatar(agent: ResearchTeamSceneAgent, color: number, selected: boolean, theme: SceneProps['theme'], avatarKind: AvatarKind = 'robot', phase = 0): AvatarBuild {
  const bodyColor = agent.locked ? LOCKED_COLOR : color
  const glow = new Color(bodyColor)
  const bodyMat = new MeshStandardMaterial({
    color: bodyColor, roughness: 0.38, metalness: 0.36,
    emissive: glow.clone().multiplyScalar(selected ? 0.15 : 0.045),
  })
  const topMat = new MeshStandardMaterial({
    color: theme === 'light' ? 0xf1f5f9 : 0x1f2a3f, roughness: 0.5, metalness: 0.22,
    emissive: glow.clone().multiplyScalar(selected ? 0.05 : 0.018),
  })
  const panelMat = new MeshBasicMaterial({ color: selected ? 0xdbeafe : bodyColor, transparent: true, opacity: selected ? 0.84 : 0.62 })
  const glowMat = new MeshBasicMaterial({ color: selected ? 0x38bdf8 : bodyColor, transparent: true, opacity: selected ? 0.4 : 0.16, depthWrite: false, blending: AdditiveBlending })
  const visorMat = new MeshStandardMaterial({
    color: selected ? 0x38bdf8 : 0x0ea5e9, roughness: 0.22, metalness: 0.3,
    emissive: new Color(selected ? 0x38bdf8 : 0x0ea5e9).multiplyScalar(selected ? 0.6 : 0.35),
  })

  const group = new Group()
  const pivot = new Group() // 浮动 pivot (放身体, 地面光圈保持静止)
  group.add(pivot)

  const pad = new Mesh(new CircleGeometry(selected ? 0.82 : 0.74, 56), glowMat)
  pad.rotation.x = -Math.PI / 2
  pad.scale.z = 0.48
  pad.position.y = 0.012
  const ring = new Mesh(new TorusGeometry(selected ? 0.72 : 0.58, selected ? 0.025 : 0.014, 8, 96), glowMat.clone())
  ring.rotation.x = Math.PI / 2
  ring.scale.z = 0.6
  ring.position.y = 0.055
  group.add(pad, ring)

  const clickable: Object3D[] = []
  // 形象内置动画收集器 (统一支持多旋翼/多关节自旋). 第一 effect 的帧循环通过返回的 animate 调用.
  const updaters: Array<(t: number) => void> = []
  const spin = (obj: Object3D, speed: number, axis: 'x' | 'y' | 'z' = 'y') => updaters.push((t) => { obj.rotation[axis] = t * speed })

  if (avatarKind === 'crystal') {
    const body = new Mesh(new OctahedronGeometry(0.66, 0), bodyMat); body.position.y = 0.82
    const top = new Mesh(new OctahedronGeometry(0.26, 0), topMat); top.position.y = 1.5
    const shell = new Mesh(new OctahedronGeometry(0.72, 0), panelMat.clone()); shell.position.y = 0.82
    pivot.add(body, top, shell)
    clickable.push(body, top, shell)
    spin(body, 0.3)
  } else if (avatarKind === 'helix') {
    // 双螺旋: 两条相位相反的螺旋珠链 + 连接横档, 整体绕 Y 旋转 (DNA/生物科技感).
    const turns = 2.6
    const segs = 18
    const hr = 0.34
    const height = 1.6
    const beadGeo = new SphereGeometry(0.09, 14, 14)
    const beadMatA = bodyMat
    const beadMatB = topMat.clone(); beadMatB.color = new Color(theme === 'light' ? 0x0ea5e9 : 0x38bdf8)
    const rungGeo = new CylinderGeometry(0.022, 0.022, 1, 8)
    const rungMat = panelMat.clone()
    const up = new Vector3(0, 1, 0)
    const q = new Quaternion()
    for (let s = 0; s < 2; s += 1) {
      for (let i = 0; i < segs; i += 1) {
        const tt = i / (segs - 1)
        const ang = tt * turns * Math.PI * 2 + s * Math.PI
        const x = Math.cos(ang) * hr
        const z = Math.sin(ang) * hr
        const y = tt * height - height / 2 + 0.82
        const bead = new Mesh(beadGeo, s === 0 ? beadMatA : beadMatB)
        bead.position.set(x, y, z)
        pivot.add(bead)
        clickable.push(bead)
        if (s === 0 && i % 2 === 0) {
          const ang2 = ang + Math.PI
          const p2 = new Vector3(Math.cos(ang2) * hr, y, Math.sin(ang2) * hr)
          const mid = new Vector3((x + p2.x) / 2, y, (z + p2.z) / 2)
          const dir = new Vector3().subVectors(p2, new Vector3(x, y, z))
          const len = dir.length()
          const rung = new Mesh(rungGeo, rungMat.clone())
          rung.position.copy(mid)
          rung.scale.y = len
          q.setFromUnitVectors(up, dir.normalize())
          rung.quaternion.copy(q)
          pivot.add(rung)
          clickable.push(rung)
        }
      }
    }
    spin(pivot, 0.55)
  } else if (avatarKind === 'droid') {
    // 宇航机器人: 球形机体(滚动) + 装饰环 + 顶部小头(独眼+天线). BB-8/球童式.
    const bodySpin = new Group(); bodySpin.position.y = 0.5
    const ball = new Mesh(new SphereGeometry(0.5, 36, 28), bodyMat)
    const ringA = new Mesh(new TorusGeometry(0.5, 0.03, 8, 40), topMat); ringA.rotation.x = Math.PI / 2
    const ringB = new Mesh(new TorusGeometry(0.36, 0.025, 8, 32), panelMat.clone()); ringB.rotation.x = Math.PI / 2.3
    bodySpin.add(ball, ringA, ringB)
    const head = new Group(); head.position.set(0, 1.0, 0.04)
    const dome = new Mesh(new SphereGeometry(0.22, 24, 18), topMat)
    const droidEye = new Mesh(new SphereGeometry(0.05, 14, 14), visorMat); droidEye.position.set(0, 0.02, 0.2)
    const ant = new Mesh(new CylinderGeometry(0.01, 0.01, 0.13, 8), topMat); ant.position.set(0.06, 0.2, 0)
    head.add(dome, droidEye, ant)
    pivot.add(bodySpin, head)
    clickable.push(ball, dome)
    spin(bodySpin, 0.4)
    updaters.push((t) => { head.rotation.z = Math.sin(t * 0.8 + phase) * 0.06; head.position.x = Math.sin(t * 0.8 + phase) * 0.03 })
  } else if (avatarKind === 'jellyfish') {
    // 水母: 半球形伞盖(半透明发光) + 8 条飘动触手 (空灵漂浮).
    const bellMat = bodyMat.clone(); bellMat.transparent = true; bellMat.opacity = 0.82
    const bell = new Mesh(new SphereGeometry(0.55, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2), bellMat); bell.position.y = 0.92
    const inner = new Mesh(new SphereGeometry(0.4, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), glowMat.clone()); inner.position.y = 0.92
    const tentacles: Mesh[] = []
    for (let i = 0; i < 8; i += 1) {
      const a = i / 8 * Math.PI * 2
      const r = 0.34
      const len = 0.55 + (i % 3) * 0.16
      const tg = new Mesh(new CylinderGeometry(0.016, 0.006, len, 8), glowMat.clone())
      tg.position.set(Math.cos(a) * r, 0.92 - len / 2, Math.sin(a) * r)
      pivot.add(tg); tentacles.push(tg)
    }
    pivot.add(bell, inner)
    clickable.push(bell)
    updaters.push((t) => {
      const p = 1 + Math.sin(t * 1.4) * 0.06
      bell.scale.set(p, 1 + Math.sin(t * 1.4) * 0.09, p); inner.scale.copy(bell.scale)
      tentacles.forEach((tg, i) => { tg.rotation.x = Math.sin(t * 1.2 + i) * 0.22; tg.rotation.z = Math.cos(t * 1.0 + i) * 0.22 })
    })
  } else if (avatarKind === 'mushroom') {
    // 蘑菇: 圆盖(带白斑) + 茎 + 底座 (柔和呼吸).
    const stem = new Mesh(new CylinderGeometry(0.2, 0.28, 0.6, 18), new MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 })); stem.position.y = 0.4
    const base = new Mesh(new SphereGeometry(0.3, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), new MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.6 })); base.scale.set(1, 0.5, 1); base.position.y = 0.12
    const cap = new Mesh(new SphereGeometry(0.62, 30, 22, 0, Math.PI * 2, 0, Math.PI / 2), bodyMat); cap.scale.set(1, 0.78, 1); cap.position.y = 0.7
    const spotMat = new MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.55 })
    const spots: Array<[number, number, number, number]> = [[0, 0.92, 0, 0.11], [0.3, 0.84, 0.05, 0.08], [-0.3, 0.84, 0.08, 0.085], [0.18, 0.86, -0.26, 0.08], [-0.16, 0.83, -0.22, 0.075], [0.02, 0.8, 0.32, 0.07]]
    spots.forEach(([x, y, z, r]) => { const s = new Mesh(new SphereGeometry(r, 12, 10), spotMat); s.position.set(x, y, z); pivot.add(s); clickable.push(s) })
    pivot.add(stem, base, cap)
    clickable.push(cap, stem)
    updaters.push((t) => { const p = 1 + Math.sin(t * 1.5 + phase) * 0.04; cap.scale.set(p, 0.78 + Math.sin(t * 1.5 + phase) * 0.03, p) })
  } else if (avatarKind === 'penguin') {
    // 企鹅: 椭圆身 + 白腹 + 头 + 橙喙 + 双翅 + 橙脚 (左右摇摆走).
    const bellyMat = new MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.5 })
    const beakMat = new MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.4 })
    const body = new Mesh(new SphereGeometry(0.46, 24, 22), bodyMat); body.scale.set(1, 1.25, 0.92); body.position.y = 0.6
    const belly = new Mesh(new SphereGeometry(0.34, 20, 18), bellyMat); belly.scale.set(0.6, 1.1, 0.5); belly.position.set(0, 0.58, 0.28)
    const head = new Mesh(new SphereGeometry(0.3, 22, 20), bodyMat); head.position.y = 1.2
    const eyeMat = new MeshBasicMaterial({ color: 0x0f172a })
    const eL = new Mesh(new SphereGeometry(0.035, 10, 10), eyeMat); eL.position.set(-0.1, 1.26, 0.26)
    const eR = new Mesh(new SphereGeometry(0.035, 10, 10), eyeMat); eR.position.set(0.1, 1.26, 0.26)
    const beak = new Mesh(new ConeGeometry(0.07, 0.18, 10), beakMat); beak.rotation.x = Math.PI / 2; beak.position.set(0, 1.16, 0.3)
    const wingL = new Mesh(new SphereGeometry(0.22, 14, 12), bodyMat); wingL.scale.set(0.25, 1, 0.7); wingL.position.set(-0.42, 0.62, 0)
    const wingR = new Mesh(new SphereGeometry(0.22, 14, 12), bodyMat); wingR.scale.set(0.25, 1, 0.7); wingR.position.set(0.42, 0.62, 0)
    const footL = new Mesh(new BoxGeometry(0.12, 0.06, 0.2), beakMat); footL.position.set(-0.13, 0.06, 0.06)
    const footR = new Mesh(new BoxGeometry(0.12, 0.06, 0.2), beakMat); footR.position.set(0.13, 0.06, 0.06)
    pivot.add(body, belly, head, eL, eR, beak, wingL, wingR, footL, footR)
    clickable.push(body, head, beak)
    updaters.push((t) => { pivot.rotation.z = Math.sin(t * 2.2 + phase) * 0.08 })
  } else {
    // robot (默认): 方块机器人
    const base = new Mesh(new BoxGeometry(0.82, 0.2, 0.72), bodyMat); base.position.y = 0.15
    const body = new Mesh(new BoxGeometry(0.64, 0.9, 0.56), bodyMat); body.position.y = 0.7
    const top = new Mesh(new BoxGeometry(0.44, 0.34, 0.44), topMat); top.position.y = 1.32
    const frontPanel = new Mesh(new BoxGeometry(0.44, 0.12, 0.045), panelMat); frontPanel.position.set(0, 0.78, 0.305)
    const topPanel = new Mesh(new BoxGeometry(0.28, 0.075, 0.04), panelMat.clone()); topPanel.position.set(0, 1.35, 0.245)
    pivot.add(base, body, top, frontPanel, topPanel)
    clickable.push(base, body, top, frontPanel, topPanel)
    const selectedFrame = selected ? new Mesh(new BoxGeometry(0.92, 1.34, 0.035), glowMat.clone()) : null
    if (selectedFrame) { selectedFrame.position.set(0, 0.78, -0.31); pivot.add(selectedFrame) }
  }

  setAgentId(group, agent.id)
  // avatar 禁止乱动: 关闭漂浮 + 所有自旋/摆动, 形象保持静止.
  return { group, clickable }
}

// "+" 占位槽: emerald 光圈/虚线感圆环 + 3D 十字(立在 xy 平面, 从相机侧 +z 看是完整加号). 点击触发 onAdd.
function makeAddNode(theme: SceneProps['theme']) {
  const emerald = 0x10b981
  const glowMat = new MeshBasicMaterial({ color: emerald, transparent: true, opacity: 0.16, depthWrite: false, blending: AdditiveBlending })
  const ringMat = new MeshBasicMaterial({ color: emerald, transparent: true, opacity: 0.55, depthWrite: false })
  const barMat = new MeshStandardMaterial({
    color: emerald, roughness: 0.42, metalness: 0.3,
    emissive: new Color(emerald).multiplyScalar(theme === 'light' ? 0.06 : 0.14), transparent: true, opacity: 0.9,
  })

  const group = new Group()
  const pad = new Mesh(new CircleGeometry(0.74, 56), glowMat)
  pad.rotation.x = -Math.PI / 2
  pad.scale.z = 0.48
  pad.position.y = 0.012
  const ring = new Mesh(new TorusGeometry(0.58, 0.014, 8, 96), ringMat.clone())
  ring.rotation.x = Math.PI / 2
  ring.scale.z = 0.6
  ring.position.y = 0.055
  const barH = new Mesh(new BoxGeometry(0.72, 0.16, 0.16), barMat); barH.position.y = 0.78
  const barV = new Mesh(new BoxGeometry(0.16, 0.72, 0.16), barMat.clone()); barV.position.y = 0.78
  group.add(pad, ring, barH, barV)

  // 可点击区: 除十字 bar 外, 把整个光圈(pad)/圆环(ring)也纳入 —— 否则用户点显眼的大圆盘几乎都点空(pad/ring 不在 clickable 里), 只有命中 0.16 宽的细 bar 才生效. onAdd 逻辑不变(三者均经 traverse 带 userData.addNode).
  const clickable: Object3D[] = [pad, ring, barH, barV]
  group.traverse((child) => { child.userData.addNode = true })
  return { group, clickable }
}

export function ResearchAgentTeamScene({ agents, selectedId, onSelect, theme, sceneKind, avatarKind = 'robot', canAdd = false, onAdd }: SceneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<WebGLRenderer | null>(null)
  const sceneRef = useRef<Scene | null>(null)
  const cameraRef = useRef<PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const stageRootRef = useRef<Group | null>(null)
  const pieceRootRef = useRef<Group | null>(null)
  const raycasterRef = useRef(new Raycaster())
  const pointerRef = useRef(new Vector2())
  const clickableRef = useRef<Object3D[]>([])
  const animatorsRef = useRef<Array<(t: number) => void>>([])
  const skyTexRef = useRef<CanvasTexture | null>(null)
  const frameRef = useRef<number | null>(null)
  const onSelectRef = useRef(onSelect)
  const onAddRef = useRef(onAdd)
  const lastLayoutKeyRef = useRef('')

  const slotCount = agents.length + (canAdd ? 1 : 0)
  const positions = useMemo(() => layoutAgents(slotCount), [slotCount])

  useEffect(() => {
    onSelectRef.current = onSelect
    onAddRef.current = onAdd
  }, [onSelect, onAdd])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const palette = paletteForTheme(theme)
    const scene = new Scene()
    scene.background = new Color(palette.background)
    scene.fog = new FogExp2(palette.fog, theme === 'light' ? 0.018 : 0.028)

    const camera = new PerspectiveCamera(39, 1, 0.1, 120)
    camera.position.set(0, 5.4, 10)
    camera.lookAt(0, 0.55, 0)

    const renderer = new WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.outputColorSpace = SRGBColorSpace
    host.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 0.55, 0)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.autoRotate = false
    controls.enablePan = false
    controls.minDistance = 6.5
    controls.maxDistance = 26
    controls.maxPolarAngle = Math.PI / 2.08
    controls.update()

    scene.add(new HemisphereLight(palette.sky, palette.groundFar, theme === 'light' ? 0.86 : 0.74))
    scene.add(new AmbientLight(0xffffff, theme === 'light' ? 0.34 : 0.18))
    const key = new DirectionalLight(0xffffff, theme === 'light' ? 1.12 : 1.35)
    key.position.set(4.8, 9, 6.5)
    scene.add(key)

    // 环境贴图: PMREM 处理的 RoomEnvironment, 给金属/玻璃/宝石材质提供柔和反射 (让"精致"形象有真实质感).
    const pmrem = new PMREMGenerator(renderer)
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
    scene.environment = envRT.texture
    scene.environmentIntensity = theme === 'light' ? 0.6 : 0.5

    const stageRoot = new Group()
    const pieceRoot = new Group()
    scene.add(stageRoot, pieceRoot)

    sceneRef.current = scene
    cameraRef.current = camera
    rendererRef.current = renderer
    controlsRef.current = controls
    stageRootRef.current = stageRoot
    pieceRootRef.current = pieceRoot

    const resize = () => {
      const rect = host.getBoundingClientRect()
      const width = Math.max(1, Math.floor(rect.width))
      const height = Math.max(1, Math.floor(rect.height))
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }

    const ro = new ResizeObserver(resize)
    ro.observe(host)
    resize()

    const animate = (time: number) => {
      controls.update()
      const t = time * 0.001
      for (const fn of animatorsRef.current) fn(t)
      renderer.render(scene, camera)
      frameRef.current = requestAnimationFrame(animate)
    }
    frameRef.current = requestAnimationFrame(animate)

    let pointerDown: { x: number, y: number } | null = null
    const handlePointerDown = (event: PointerEvent) => {
      pointerDown = { x: event.clientX, y: event.clientY }
    }
    const handlePointerUp = (event: PointerEvent) => {
      if (!pointerDown) return
      const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y)
      pointerDown = null
      if (moved > 5) return
      const rect = renderer.domElement.getBoundingClientRect()
      pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycasterRef.current.setFromCamera(pointerRef.current, camera)
      const hits = raycasterRef.current.intersectObjects(clickableRef.current, true)
      const addHit = hits.find(item => item.object.userData.addNode)
      if (addHit) { onAddRef.current?.(); return }
      const hit = hits.find(item => item.object.userData.agentId)
      const id = hit?.object?.userData?.agentId
      if (id) onSelectRef.current(String(id))
    }
    renderer.domElement.addEventListener('pointerdown', handlePointerDown)
    renderer.domElement.addEventListener('pointerup', handlePointerUp)
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.cursor = 'pointer'

    return () => {
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown)
      renderer.domElement.removeEventListener('pointerup', handlePointerUp)
      ro.disconnect()
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      controls.dispose()
      animatorsRef.current = []
      disposeObject(stageRoot)
      disposeObject(pieceRoot)
      if (skyTexRef.current) { skyTexRef.current.dispose(); skyTexRef.current = null }
      scene.clear()
      envRT.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      rendererRef.current = null
      sceneRef.current = null
      cameraRef.current = null
      controlsRef.current = null
      stageRootRef.current = null
      pieceRootRef.current = null
      clickableRef.current = []
    }
  }, [theme])

  useEffect(() => {
    const scene = sceneRef.current
    const stageRoot = stageRootRef.current
    const pieceRoot = pieceRootRef.current
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!scene || !stageRoot || !pieceRoot || !camera || !controls) return

    const palette = applySceneKind(paletteForTheme(theme), sceneKind, theme)
    scene.fog = new FogExp2(palette.fog, theme === 'light' ? 0.018 : 0.028)
    // 天空渐变贴图
    if (skyTexRef.current) { skyTexRef.current.dispose(); skyTexRef.current = null }
    const skyTex = makeSkyTexture(palette.skyTop, palette.skyBottom)
    skyTexRef.current = skyTex
    scene.background = skyTex

    const target = computeTarget(positions, camera.aspect || 1.35)
    const layoutKey = `${agents.length}:${positions.map(p => `${p.x.toFixed(2)},${p.z.toFixed(2)}`).join('|')}:${target.center.x.toFixed(2)},${target.center.z.toFixed(2)},${target.cameraDistance.toFixed(2)}`
    if (layoutKey !== lastLayoutKeyRef.current) {
      lastLayoutKeyRef.current = layoutKey
      controls.target.set(target.center.x, target.center.y, target.center.z - 0.35)
      controls.minDistance = Math.max(5.8, target.cameraDistance * 0.56)
      controls.maxDistance = Math.max(14, target.cameraDistance * 1.75)
      camera.position.set(target.center.x, target.center.y + 4.8, target.center.z + target.cameraDistance)
      controls.update()
    }

    const animators: Array<(t: number) => void> = []

    disposeObject(stageRoot)
    stageRoot.clear()
    stageRoot.add(makeStage(target, palette, theme))
    stageRoot.add(makeFormationLines(positions, palette, theme))
    const backdrop = makeBackdrop(target, palette, theme, sceneKind)
    stageRoot.add(backdrop.root)
    if (backdrop.animate) animators.push(backdrop.animate)

    disposeObject(pieceRoot)
    pieceRoot.clear()
    clickableRef.current = []

    agents.forEach((agent, index) => {
      const position = positions[index] || new Vector3()
      const selected = selectedId === agent.id
      const color = agent.role === 'chief_researcher' ? CHIEF_COLOR : ASSISTANT_COLOR
      const { group, clickable, animate } = makeAgentAvatar(agent, agent.locked ? LOCKED_COLOR : color, selected, theme, avatarKind, index * 0.7)
      const depthScale = clamp(1.02 + (position.z - target.center.z) * 0.035, 0.9, 1.14)
      group.position.copy(position)
      group.scale.setScalar((selected ? 1.06 : 1) * depthScale)

      const texture = makeLabelTexture(agent, selected, theme)
      const sprite = new Sprite(new SpriteMaterial({
        map: texture, transparent: true, depthTest: false, depthWrite: false,
      }))
      sprite.renderOrder = 4
      sprite.position.set(0, 2.25, 0.08)
      sprite.scale.set(selected ? 2.85 : 2.62, selected ? 1.05 : 0.96, 1)
      group.add(sprite)

      pieceRoot.add(group)
      clickableRef.current.push(...clickable)
      if (animate) animators.push(animate)
    })

    if (canAdd) {
      const position = positions[agents.length] || new Vector3()
      const { group, clickable } = makeAddNode(theme)
      const depthScale = clamp(1.02 + (position.z - target.center.z) * 0.035, 0.9, 1.14)
      group.position.copy(position)
      group.scale.setScalar(depthScale)

      const texture = makeAddLabelTexture(theme)
      const sprite = new Sprite(new SpriteMaterial({
        map: texture, transparent: true, depthTest: false, depthWrite: false,
      }))
      sprite.renderOrder = 4
      // 浮窗下移贴近可点击的十字(原 y=2.05 离十字 y≈0.78 过远, 点到浮窗文字会落空), 并让浮窗本身也参与点击
      sprite.position.set(0, 1.45, 0.08)
      sprite.scale.set(2.0, 0.5, 1)
      sprite.userData.addNode = true
      group.add(sprite)

      pieceRoot.add(group)
      clickableRef.current.push(...clickable, sprite)
    }

    animatorsRef.current = animators
  }, [agents, positions, selectedId, theme, sceneKind, avatarKind, canAdd])

  return (
    <div className="relative h-full min-h-[360px] overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
      <div ref={hostRef} className="absolute inset-0" />
      {agents.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
          暂无 Agent
        </div>
      )}
    </div>
  )
}
