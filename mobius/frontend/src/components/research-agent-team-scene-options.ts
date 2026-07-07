// 轻量选项/类型抽取: 供 modal 静态引用, 避免把 research-agent-team-scene.tsx
// (含全部 three.js) 拉进主 chunk, 从而让 modal 的 lazy(() => import('./research-agent-team-scene'))
// 能真正拆出独立 chunk. 这里不放任何 three.js / React 依赖.

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
