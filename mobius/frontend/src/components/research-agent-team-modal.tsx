import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Loader2, Lock, Rocket, Trash2, Users, X, Sparkles, Layers } from 'lucide-react'
import { api, useStore } from '../store'
import { ErrBanner } from './modals'
import { SCENE_KIND_OPTIONS, AVATAR_KIND_OPTIONS } from './research-agent-team-scene'
import type { ResearchTeamSceneAgent, SceneKind, AvatarKind } from './research-agent-team-scene'

type ResearchRole = 'chief_researcher' | 'research_assistant'
type SessionLanguage = 'zh' | 'en'

type SessionModelOption = {
  key: string
  label: string
  title: string
  sub: string
  backend?: string
}

type AgentSkill = {
  id: string
  name: string
  description?: string
  research_role?: string
  scope: string
}

type SelectableItem = {
  id: string
  name: string
  description?: string
  scope: string
  dirName?: string | null
}

type TeamAgent = {
  id: string
  sessionId?: string
  locked: boolean
  role: ResearchRole
  name: string
  purpose: string
  model: string
  language: SessionLanguage
  mainSkillId: string
  excludedSkillIds: string[]
  excludedMemoryIds: string[]
  messageCount?: number
  status?: string
}

type EditingTarget = {
  agentId: string
  field: 'name' | 'purpose'
}

type SelectionPanel = {
  agentId: string
  type: 'skill' | 'memory'
}

type ExistingSession = {
  session_id: string
  name: string
  description?: string
  research_role?: ResearchRole | null
  model?: string
  model_label?: string
  language?: SessionLanguage
  message_count?: number
  agent_status?: string
  last_active?: string
}

const MAX_TEAM_SIZE = 12
const DEFAULT_MODEL = 'codex'
const ResearchAgentTeamScene = lazy(() => import('./research-agent-team-scene')
  .then(mod => ({ default: mod.ResearchAgentTeamScene })))
const FALLBACK_MODEL_OPTIONS: SessionModelOption[] = [
]
const SCOPE_LABEL: Record<string, string> = { user: '用户级', project: '项目级', builtin: '内置' }

const DEFAULT_TEAM_PRESETS = [
  {
    key: 'chief',
    role: 'chief_researcher' as ResearchRole,
    name: '具体研究执行 Agent',
    purpose: '负责具体执行研究任务：拆解研究课题、推进研究过程、整合阶段结论，并把关键动作和结果写入 Research Blackboard。',
    skillName: 'research-chief-agent',
  },
  {
    key: 'graph',
    role: 'research_assistant' as ResearchRole,
    name: 'Research Graph 绘制 Agent',
    purpose: '负责根据 Research Blackboard 绘制和维护 research-graph.yml，让研究结构、节点关系和状态能在 Research Graph 中展示。',
    skillName: 'research-generate-graph',
  },
  {
    key: 'image',
    role: 'research_assistant' as ResearchRole,
    name: '复杂图像绘制 Agent',
    purpose: '负责根据 Research Blackboard 中的进展和结论绘制复杂图像、架构图、曲线或论文风格示意图，并把产物写回 Blackboard。',
    skillName: 'research-image-agent',
  },
]

function makeLocalId() {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function roleLabel(role: ResearchRole) {
  return role === 'chief_researcher' ? 'chief' : 'assistant'
}

function ResearchAgentTeamSceneFallback() {
  return (
    <div className="flex h-full min-h-[360px] items-center justify-center gap-2 rounded-lg border text-[13px]"
      style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
      <Loader2 className="h-4 w-4 animate-spin" />
      加载团队画布...
    </div>
  )
}

function sessionRole(session: ExistingSession): ResearchRole {
  return session.research_role === 'chief_researcher' ? 'chief_researcher' : 'research_assistant'
}

function agentSkillInstruction(skill?: AgentSkill | null) {
  return skill ? `你的任务是按照 ${skill.name} skill 中的指示完成任务` : ''
}

function appendMainSkillInstruction(purpose: string, skill?: AgentSkill | null) {
  const instruction = agentSkillInstruction(skill)
  if (!instruction) return purpose.trim()
  const trimmed = purpose.trim()
  if (trimmed.includes(instruction)) return trimmed
  return trimmed ? `${trimmed}\n\n${instruction}` : instruction
}

function findSkillByName(skills: AgentSkill[], name: string) {
  const normalized = name.replace(/_/g, '-')
  return skills.find((sk) => {
    const skName = (sk.name || '').replace(/_/g, '-')
    const skId = (sk.id || '').replace(/_/g, '-')
    return skName === normalized || skId === normalized || skId.endsWith(`:${normalized}`)
  }) || null
}

function modelLabel(modelOptions: SessionModelOption[], model: string) {
  const opt = modelOptions.find(item => item.key === model)
  return opt?.label || opt?.title || model
}

function sortExistingSessions(items: ExistingSession[]) {
  return [...items].sort((a, b) => {
    const ar = sessionRole(a) === 'chief_researcher' ? 0 : 1
    const br = sessionRole(b) === 'chief_researcher' ? 0 : 1
    if (ar !== br) return ar - br
    return new Date(b.last_active || 0).getTime() - new Date(a.last_active || 0).getTime()
  })
}

function normalizeSkillExclusions(base: string[], mainSkillId: string, agentSkills: AgentSkill[]) {
  const next = new Set(base)
  agentSkills.forEach((sk) => next.add(sk.id))
  if (mainSkillId) next.delete(mainSkillId)
  return Array.from(next)
}

function selectedSkillCount(agent: TeamAgent, skills: SelectableItem[], agentSkills: AgentSkill[]) {
  const agentSkillIds = new Set(agentSkills.map(sk => sk.id))
  return skills.filter((sk) => {
    if (agentSkillIds.has(sk.id)) return sk.id === agent.mainSkillId
    return !agent.excludedSkillIds.includes(sk.id)
  }).length
}

function selectedMemoryCount(agent: TeamAgent, memories: SelectableItem[]) {
  return memories.filter(m => !agent.excludedMemoryIds.includes(m.id)).length
}

function contentForStart(name: string, description: string) {
  return [name.trim(), description.trim()].filter(Boolean).join('\n\n')
}

function buildInitialAgents({
  existingSessions,
  agentSkills,
  defaultExcludedSkillIds,
  defaultExcludedMemoryIds,
  defaultModel,
}: {
  existingSessions: ExistingSession[]
  agentSkills: AgentSkill[]
  defaultExcludedSkillIds: string[]
  defaultExcludedMemoryIds: string[]
  defaultModel: string
}) {
  const existingAgents: TeamAgent[] = sortExistingSessions(existingSessions).map((s) => ({
    id: `existing-${s.session_id}`,
    sessionId: s.session_id,
    locked: true,
    role: sessionRole(s),
    name: s.name || s.session_id,
    purpose: s.description || '',
    model: s.model || defaultModel,
    language: s.language === 'en' ? 'en' : 'zh',
    mainSkillId: '',
    excludedSkillIds: [],
    excludedMemoryIds: [],
    messageCount: Number(s.message_count || 0),
    status: s.agent_status === 'running' ? '执行中' : '已创建',
  }))
  const hasChief = existingAgents.some(agent => agent.role === 'chief_researcher')
  const output: TeamAgent[] = []

  if (hasChief) {
    output.push(...existingAgents)
  } else {
    const chiefPreset = DEFAULT_TEAM_PRESETS[0]
    const mainSkill = findSkillByName(agentSkills, chiefPreset.skillName)
    output.push({
      id: makeLocalId(),
      locked: false,
      role: 'chief_researcher',
      name: chiefPreset.name,
      purpose: chiefPreset.purpose,
      model: defaultModel,
      language: 'zh',
      mainSkillId: mainSkill?.id || '',
      excludedSkillIds: normalizeSkillExclusions(defaultExcludedSkillIds, mainSkill?.id || '', agentSkills),
      excludedMemoryIds: defaultExcludedMemoryIds,
    })
    output.push(...existingAgents)
  }

  const assistantPresets = DEFAULT_TEAM_PRESETS.slice(1)
  let presetIndex = 0
  while (output.length < Math.min(3, MAX_TEAM_SIZE) && presetIndex < assistantPresets.length) {
    const preset = assistantPresets[presetIndex++]
    const mainSkill = findSkillByName(agentSkills, preset.skillName)
    output.push({
      id: makeLocalId(),
      locked: false,
      role: 'research_assistant',
      name: preset.name,
      purpose: preset.purpose,
      model: defaultModel,
      language: 'zh',
      mainSkillId: mainSkill?.id || '',
      excludedSkillIds: normalizeSkillExclusions(defaultExcludedSkillIds, mainSkill?.id || '', agentSkills),
      excludedMemoryIds: defaultExcludedMemoryIds,
    })
  }

  return output.slice(0, MAX_TEAM_SIZE)
}

export function ResearchAgentTeamModal({
  researchId,
  existingSessions,
  defaultNamePrefix,
  defaultDescription,
  onClose,
  onDone,
  onRefresh,
}: {
  researchId: string
  existingSessions: ExistingSession[]
  defaultNamePrefix?: string
  defaultDescription?: string
  onClose: () => void
  onDone: (session: any) => void
  onRefresh: () => void
}) {
  const { theme } = useStore()
  const isDark = theme !== 'light'
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')
  const [progress, setProgress] = useState<string[]>([])
  const [modelOptions, setModelOptions] = useState<SessionModelOption[]>(FALLBACK_MODEL_OPTIONS)
  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>([])
  const [availableSkills, setAvailableSkills] = useState<SelectableItem[]>([])
  const [availableMemories, setAvailableMemories] = useState<SelectableItem[]>([])
  const [defaultExcludedSkillIds, setDefaultExcludedSkillIds] = useState<string[]>([])
  const [defaultExcludedMemoryIds, setDefaultExcludedMemoryIds] = useState<string[]>([])
  const [agents, setAgents] = useState<TeamAgent[]>([])
  const [editingTarget, setEditingTarget] = useState<EditingTarget | null>(null)
  const [mode, setMode] = useState<'single' | 'team'>('team')
  const [sceneKind, setSceneKind] = useState<SceneKind>('space')
  const [avatarKind, setAvatarKind] = useState<AvatarKind>('robot')
  const [selectionPanel, setSelectionPanel] = useState<SelectionPanel | null>(null)
  const initializedRef = useRef(false)

  const selectedAgent = useMemo(
    () => agents.find(agent => agent.id === editingTarget?.agentId) || agents[0] || null,
    [agents, editingTarget?.agentId],
  )
  const selectedText = selectedAgent && editingTarget
    ? editingTarget.field === 'name' ? selectedAgent.name : selectedAgent.purpose
    : ''
  const selectedFieldLabel = editingTarget?.field === 'name' ? '名称' : '目的'
  const agentSkillIds = useMemo(() => new Set(agentSkills.map(sk => sk.id)), [agentSkills])

  useEffect(() => {
    let alive = true
    async function load() {
      setLoadingConfig(true)
      setErr('')
      try {
        const [models, defaults, preview, skills] = await Promise.all([
          api('/api/sessions/model-options').catch(() => FALLBACK_MODEL_OPTIONS),
          api(`/api/researches/${researchId}/session-selection-defaults`),
          api(`/api/researches/${researchId}/context-preview`, {
            method: 'POST',
            body: JSON.stringify({
              name: defaultNamePrefix || 'Research Agent 团队',
              description: defaultDescription || '创建 Research Agent 团队',
              role: 'research_assistant',
              language: 'zh',
              excluded_skill_ids: [],
              excluded_memory_ids: [],
            }),
          }),
          api(`/api/researches/${researchId}/research-agent-skills`).catch(() => []),
        ])
        if (!alive) return
        const nextModels = Array.isArray(models) && models.length > 0 ? models : FALLBACK_MODEL_OPTIONS
        const nextAgentSkills = Array.isArray(skills) ? skills : []
        const skillsAll = Array.isArray(preview?.sources?.skills) ? preview.sources.skills : []
        const memoriesAll = Array.isArray(preview?.sources?.memories) ? preview.sources.memories : []
        const skillIds = new Set(skillsAll.map((s: SelectableItem) => s.id))
        const memoryIds = new Set(memoriesAll.map((m: SelectableItem) => m.id))
        const defaultSkillEx = Array.isArray(defaults?.excluded_skill_ids)
          ? defaults.excluded_skill_ids.filter((id: string) => skillIds.has(id))
          : []
        const defaultMemoryEx = Array.isArray(defaults?.excluded_memory_ids)
          ? defaults.excluded_memory_ids.filter((id: string) => memoryIds.has(id))
          : []
        setModelOptions(nextModels)
        setAgentSkills(nextAgentSkills)
        setAvailableSkills(skillsAll)
        setAvailableMemories(memoriesAll)
        setDefaultExcludedSkillIds(defaultSkillEx)
        setDefaultExcludedMemoryIds(defaultMemoryEx)
        const defaultModel = nextModels[0]?.key || DEFAULT_MODEL
        const initialAgents = buildInitialAgents({
          existingSessions,
          agentSkills: nextAgentSkills,
          defaultExcludedSkillIds: defaultSkillEx,
          defaultExcludedMemoryIds: defaultMemoryEx,
          defaultModel,
        })
        initializedRef.current = true
        setAgents(initialAgents)
        const firstEditable = initialAgents.find(agent => !agent.locked) || initialAgents[0] || null
        setEditingTarget(firstEditable ? { agentId: firstEditable.id, field: 'purpose' } : null)
      } catch (e: any) {
        if (alive) setErr(e?.message || '加载团队创建配置失败')
      } finally {
        if (alive) setLoadingConfig(false)
      }
    }
    load()
    return () => { alive = false }
  }, [researchId])

  useEffect(() => {
    if (!initializedRef.current) return
    setAgents(prev => prev.map(agent => ({
      ...agent,
      excludedSkillIds: agent.locked
        ? agent.excludedSkillIds
        : normalizeSkillExclusions(
          agent.excludedSkillIds.filter(id => !agentSkillIds.has(id)),
          agent.mainSkillId,
          agentSkills,
        ),
    })))
  }, [agentSkillIds, agentSkills])

  const updateAgent = useCallback((agentId: string, patch: Partial<TeamAgent>) => {
    setAgents(prev => prev.map(agent => {
      if (agent.id !== agentId || agent.locked) return agent
      return { ...agent, ...patch }
    }))
  }, [])

  const selectedMainSkill = useCallback((agent: TeamAgent) => {
    return agentSkills.find(sk => sk.id === agent.mainSkillId) || null
  }, [agentSkills])

  const setMainSkill = (agent: TeamAgent, mainSkillId: string) => {
    if (agent.locked) return
    updateAgent(agent.id, {
      mainSkillId,
      excludedSkillIds: normalizeSkillExclusions(
        agent.excludedSkillIds.filter(id => !agentSkillIds.has(id)),
        mainSkillId,
        agentSkills,
      ),
    })
  }

  const addAssistant = () => {
    if (agents.length >= MAX_TEAM_SIZE) return
    const index = agents.filter(agent => agent.role === 'research_assistant').length + 1
    const next: TeamAgent = {
      id: makeLocalId(),
      locked: false,
      role: 'research_assistant',
      name: `研究助理 ${index}`,
      purpose: '协助 chief 完成研究子任务，并把关键进展写回 Research Blackboard。',
      model: modelOptions[0]?.key || DEFAULT_MODEL,
      language: 'zh',
      mainSkillId: '',
      excludedSkillIds: normalizeSkillExclusions(defaultExcludedSkillIds, '', agentSkills),
      excludedMemoryIds: defaultExcludedMemoryIds,
    }
    setAgents(prev => [...prev, next])
    setEditingTarget({ agentId: next.id, field: 'purpose' })
  }

  // 模式切换: 单个 Agent (只留一个待创建) / Agent 团队 (补满预设到 3).
  const switchMode = (next: 'single' | 'team') => {
    if (next === mode || submitting) return
    setMode(next)
    const defaultModelKey = modelOptions[0]?.key || DEFAULT_MODEL
    if (next === 'single') {
      const unlocked = agents.filter(a => !a.locked)
      const keep = unlocked[0] || null
      let nextAgents = agents.filter(a => a.locked || (keep && a.id === keep.id))
      if (nextAgents.length === 0) {
        nextAgents = [{
          id: makeLocalId(), locked: false, role: 'research_assistant', name: '研究助理 1',
          purpose: '协助完成研究子任务，并把关键进展写回 Research Blackboard。',
          model: defaultModelKey, language: 'zh', mainSkillId: '',
          excludedSkillIds: normalizeSkillExclusions(defaultExcludedSkillIds, '', agentSkills),
          excludedMemoryIds: defaultExcludedMemoryIds,
        }]
      }
      setAgents(nextAgents)
      const first = nextAgents.find(a => !a.locked) || nextAgents[0]
      if (first) setEditingTarget({ agentId: first.id, field: 'purpose' })
    } else {
      const hasChief = agents.some(a => a.role === 'chief_researcher')
      const nextAgents = [...agents]
      if (!hasChief) {
        const preset = DEFAULT_TEAM_PRESETS[0]
        const ms = findSkillByName(agentSkills, preset.skillName)
        nextAgents.unshift({
          id: makeLocalId(), locked: false, role: 'chief_researcher', name: preset.name, purpose: preset.purpose,
          model: defaultModelKey, language: 'zh', mainSkillId: ms?.id || '',
          excludedSkillIds: normalizeSkillExclusions(defaultExcludedSkillIds, ms?.id || '', agentSkills),
          excludedMemoryIds: defaultExcludedMemoryIds,
        })
      }
      while (nextAgents.length < 3 && nextAgents.length < MAX_TEAM_SIZE) {
        const preset = DEFAULT_TEAM_PRESETS[nextAgents.length % DEFAULT_TEAM_PRESETS.length]
        const ms = findSkillByName(agentSkills, preset.skillName)
        nextAgents.push({
          id: makeLocalId(), locked: false, role: preset.role, name: preset.name, purpose: preset.purpose,
          model: defaultModelKey, language: 'zh', mainSkillId: ms?.id || '',
          excludedSkillIds: normalizeSkillExclusions(defaultExcludedSkillIds, ms?.id || '', agentSkills),
          excludedMemoryIds: defaultExcludedMemoryIds,
        })
      }
      setAgents(nextAgents)
    }
  }

  const deleteAgent = (agentId: string) => {
    const target = agents.find(agent => agent.id === agentId)
    if (!target || target.locked || target.role === 'chief_researcher') return
    const next = agents.filter(agent => agent.id !== agentId)
    setAgents(next)
    if (editingTarget?.agentId === agentId) {
      const replacement = next.find(agent => !agent.locked) || next[0] || null
      setEditingTarget(replacement ? { agentId: replacement.id, field: 'purpose' } : null)
    }
  }

  const chooseField = (agentId: string, field: 'name' | 'purpose') => {
    setEditingTarget({ agentId, field })
    setErr('')
  }

  const updateSelectedText = (value: string) => {
    if (!editingTarget) return
    updateAgent(editingTarget.agentId, editingTarget.field === 'name' ? { name: value } : { purpose: value })
  }

  const toggleSelection = (agent: TeamAgent, itemId: string, type: SelectionPanel['type']) => {
    if (agent.locked) return
    if (type === 'skill') {
      if (agentSkillIds.has(itemId)) return
      const set = new Set(agent.excludedSkillIds)
      set.has(itemId) ? set.delete(itemId) : set.add(itemId)
      updateAgent(agent.id, {
        excludedSkillIds: normalizeSkillExclusions(Array.from(set), agent.mainSkillId, agentSkills),
      })
      return
    }
    const set = new Set(agent.excludedMemoryIds)
    set.has(itemId) ? set.delete(itemId) : set.add(itemId)
    updateAgent(agent.id, { excludedMemoryIds: Array.from(set) })
  }

  const sceneAgents: ResearchTeamSceneAgent[] = useMemo(() => agents.map(agent => ({
    id: agent.id,
    name: agent.name,
    purpose: agent.purpose,
    role: agent.role,
    modelLabel: modelLabel(modelOptions, agent.model),
    mainSkillName: selectedMainSkill(agent)?.name || (agent.locked ? '已创建' : '完全自定义'),
    locked: agent.locked,
    status: agent.status,
  })), [agents, modelOptions, selectedMainSkill])

  const writeTeamRecord = async (finalAgents: TeamAgent[], errors: string[]) => {
    const members = finalAgents.map(agent => ({
      session_id: agent.sessionId || null,
      name: agent.name,
      role: agent.role === 'chief_researcher' ? 'chief_researcher' : 'research_assistant',
      model: agent.model,
      language: agent.language,
      main_skill: selectedMainSkill(agent)?.name || null,
      locked: agent.locked,
      status: agent.status || null,
    }))
    const content = [
      `Research Agent 团队已加入并启动: 共 ${finalAgents.length} 个 Agent。`,
      ...members.map((m, index) => `${index + 1}. ${m.role}: session_id=${m.session_id || '-'}, name=${m.name}, main_skill=${m.main_skill || '完全自定义'}`),
      errors.length > 0 ? `部分步骤失败: ${errors.length} 项。` : '',
    ].filter(Boolean).join('\n')
    await api(`/api/research-blackboard/${researchId}`, {
      method: 'POST',
      body: JSON.stringify({
        author: 'HR',
        content,
        metadata: {
          event: 'team_joined',
          team_size: finalAgents.length,
          members,
          errors,
        },
      }),
    })
  }

  const submit = async () => {
    setErr('')
    setProgress([])
    const hasChief = agents.some(agent => agent.role === 'chief_researcher')
    if (!hasChief) {
      setErr('团队必须包含一个 chief Agent')
      return
    }
    if (agents.length > MAX_TEAM_SIZE) {
      setErr(`Agent 数量不能超过 ${MAX_TEAM_SIZE} 个`)
      return
    }
    const invalid = agents.find(agent => !agent.locked && (!agent.name.trim() || !agent.purpose.trim()))
    if (invalid) {
      setErr(`请补全「${invalid.name || '未命名 Agent'}」的名称和目的`)
      setEditingTarget({ agentId: invalid.id, field: !invalid.name.trim() ? 'name' : 'purpose' })
      return
    }

    setSubmitting(true)
    const errors: string[] = []
    let finalAgents = agents.map(agent => ({ ...agent }))
    const appendProgress = (line: string) => setProgress(prev => [...prev, line])

    for (const agent of finalAgents) {
      const mainSkill = selectedMainSkill(agent)
      const description = appendMainSkillInstruction(agent.purpose, mainSkill)
      let sessionId = agent.sessionId

      if (!agent.locked) {
        appendProgress(`创建 ${roleLabel(agent.role)}「${agent.name}」...`)
        try {
          const created = await api(`/api/researches/${researchId}/sessions`, {
            method: 'POST',
            body: JSON.stringify({
              name: agent.name.trim(),
              description,
              role: agent.role,
              model: agent.model,
              language: agent.language,
              excluded_skill_ids: normalizeSkillExclusions(agent.excludedSkillIds, agent.mainSkillId, agentSkills),
              excluded_memory_ids: agent.excludedMemoryIds,
              suppress_join_notice: true,
            }),
          })
          sessionId = created.session_id
          agent.sessionId = sessionId
          agent.locked = true
          agent.messageCount = 0
          agent.status = '已创建'
          appendProgress(`已创建「${agent.name}」`)
        } catch (e: any) {
          const msg = `创建「${agent.name}」失败：${e?.message || '未知错误'}`
          errors.push(msg)
          agent.status = '创建失败'
          appendProgress(msg)
          continue
        }
      }

      const shouldStart = !!sessionId && Number(agent.messageCount || 0) === 0
      if (shouldStart) {
        const content = contentForStart(agent.name, description)
        if (!content.trim()) {
          appendProgress(`跳过启动「${agent.name}」：没有可发送内容`)
          continue
        }
        appendProgress(`启动「${agent.name}」...`)
        try {
          await api(`/api/sessions/${sessionId}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              content,
              request_id: `team-start-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            }),
          })
          agent.messageCount = 1
          agent.status = '已启动'
          appendProgress(`已启动「${agent.name}」`)
        } catch (e: any) {
          const msg = `启动「${agent.name}」失败：${e?.message || '未知错误'}`
          errors.push(msg)
          agent.status = '启动失败'
          appendProgress(msg)
        }
      } else if (sessionId) {
        appendProgress(`保留已启动的「${agent.name}」`)
      }
    }

    try {
      if (finalAgents.some(agent => agent.sessionId)) {
        appendProgress('写入团队 Blackboard 记录...')
        await writeTeamRecord(finalAgents.filter(agent => agent.sessionId), errors)
        appendProgress('已写入团队 Blackboard 记录')
      }
    } catch (e: any) {
      const msg = `写入 Blackboard 团队记录失败：${e?.message || '未知错误'}`
      errors.push(msg)
      appendProgress(msg)
    }

    setAgents(finalAgents)
    onRefresh()
    setSubmitting(false)

    if (errors.length > 0) {
      setErr(errors.join('\n'))
      return
    }

    const chief = finalAgents.find(agent => agent.role === 'chief_researcher' && agent.sessionId)
    if (chief) {
      onDone({
        session_id: chief.sessionId,
        name: chief.name,
        description: chief.purpose,
        research_role: chief.role,
      })
    } else {
      onClose()
    }
  }

  const panelAgent = selectionPanel ? agents.find(agent => agent.id === selectionPanel.agentId) || null : null
  const panelItems = selectionPanel?.type === 'skill' ? availableSkills : availableMemories

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
      <div className="relative flex h-[min(820px,calc(100vh-32px))] w-[min(1320px,calc(100vw-32px))] flex-col rounded-2xl border shadow-2xl"
        style={{ background: 'var(--modal-bg)', borderColor: 'var(--border-color)' }}>
        <div className="flex h-14 flex-shrink-0 items-center justify-between border-b px-5" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: 'var(--bg-card-hover)', color: 'var(--text-primary)' }}>
              <Users className="h-4 w-4" strokeWidth={1.8} />
            </div>
            <div>
              <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>{mode === 'single' ? '创建单个 Research Agent' : '创建 Research Agent 团队'}</div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {agents.length}/{MAX_TEAM_SIZE} 个 Agent · 逐个创建并自动启动
              </div>
            </div>
          </div>
          <button onClick={onClose} disabled={submitting}
            className="rounded-lg p-1.5 transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40"
            style={{ color: 'var(--text-muted)' }}>
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>

        {loadingConfig ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            <Loader2 className="h-4 w-4 animate-spin" />
            加载团队配置...
          </div>
        ) : (
          <div className="grid flex-1 min-h-0 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(430px,0.42fr)_minmax(0,0.58fr)]">
            <section className="flex min-h-0 flex-col gap-3">
              {/* Tab 栏: 一个 Agent 一个 Tab, 可水平滚动(用全局统一滚动条样式); 切 Tab 同步高亮右侧 3D 形象 */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                {agents.map((agent, index) => {
                  const active = selectedAgent?.id === agent.id
                  return (
                    <button key={agent.id} type="button" onClick={() => chooseField(agent.id, 'purpose')} disabled={submitting}
                      title={agent.name}
                      className="group relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition-colors"
                      style={active
                        ? { borderColor: 'rgba(56,189,248,0.55)', background: isDark ? 'rgba(56,189,248,0.1)' : 'rgba(14,165,233,0.08)', color: 'var(--text-primary)' }
                        : { borderColor: 'var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold"
                        style={{ background: agent.role === 'chief_researcher' ? 'rgba(16,185,129,0.18)' : 'rgba(59,130,246,0.18)', color: agent.role === 'chief_researcher' ? '#10b981' : '#3b82f6' }}>
                        {index + 1}
                      </span>
                      <span className="max-w-[92px] truncate">{agent.name || `Agent ${index + 1}`}</span>
                      {agent.locked && <Lock className="h-3 w-3" style={{ color: 'var(--text-muted)' }} />}
                      {!agent.locked && agent.role !== 'chief_researcher' && (
                        <span role="button" onClick={(e) => { e.stopPropagation(); deleteAgent(agent.id) }}
                          className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded text-red-400 opacity-0 transition-opacity hover:bg-red-500/10 group-hover:opacity-100">
                          <X className="h-3 w-3" />
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* 选中 Tab 的完整配置面板: 名称/目的/模型/语言/主Skill/Skill/Memory 集中编辑 */}
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
                {selectedAgent ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: selectedAgent.role === 'chief_researcher' ? 'rgba(16,185,129,0.12)' : 'rgba(59,130,246,0.12)', color: selectedAgent.role === 'chief_researcher' ? '#10b981' : '#3b82f6' }}>{roleLabel(selectedAgent.role)}</span>
                      {selectedAgent.locked && <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-muted)' }}><Lock className="h-3 w-3" /> 已创建·锁定</span>}
                      <span className="ml-auto truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{selectedAgent.status || (selectedAgent.locked ? '已创建' : '待创建')}</span>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>名称</label>
                      <input value={selectedAgent.name} disabled={selectedAgent.locked || submitting}
                        onChange={e => updateAgent(selectedAgent.id, { name: e.target.value })}
                        className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none focus:border-blue-500/40 disabled:opacity-60"
                        style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }} />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>目的 / 职责</label>
                      <textarea value={selectedAgent.purpose} disabled={selectedAgent.locked || submitting}
                        onChange={e => updateAgent(selectedAgent.id, { purpose: e.target.value })}
                        className="h-20 w-full resize-none rounded-md border px-2.5 py-2 text-[12px] leading-relaxed outline-none focus:border-blue-500/40 disabled:opacity-60"
                        style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>模型</label>
                        <select value={selectedAgent.model} disabled={selectedAgent.locked || submitting}
                          onChange={e => updateAgent(selectedAgent.id, { model: e.target.value })}
                          className="h-9 w-full rounded-md border px-2 text-[12px] outline-none disabled:opacity-60"
                          style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}>
                          {modelOptions.map(opt => <option key={opt.key} value={opt.key}>{opt.title || opt.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>语言</label>
                        <select value={selectedAgent.language} disabled={selectedAgent.locked || submitting}
                          onChange={e => updateAgent(selectedAgent.id, { language: e.target.value === 'en' ? 'en' : 'zh' })}
                          className="h-9 w-full rounded-md border px-2 text-[12px] outline-none disabled:opacity-60"
                          style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}>
                          <option value="zh">中文</option>
                          <option value="en">English</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>主 Skill（选定后关联自动锁定 · 冲突互斥）</label>
                      <select value={selectedAgent.mainSkillId} disabled={selectedAgent.locked || submitting}
                        onChange={e => setMainSkill(selectedAgent, e.target.value)}
                        className="h-9 w-full rounded-md border px-2 text-[12px] outline-none disabled:opacity-60"
                        style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}>
                        <option value="">{selectedAgent.locked ? '已创建' : '完全自定义'}</option>
                        {agentSkills.map(sk => <option key={sk.id} value={sk.id}>{sk.name}</option>)}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={() => setSelectionPanel({ agentId: selectedAgent.id, type: 'skill' })} disabled={selectedAgent.locked || submitting}
                        className="h-9 rounded-md border px-2 text-[12px] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-60"
                        style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
                        Skill {selectedSkillCount(selectedAgent, availableSkills, agentSkills)}/{availableSkills.length}
                      </button>
                      <button onClick={() => setSelectionPanel({ agentId: selectedAgent.id, type: 'memory' })} disabled={selectedAgent.locked || submitting}
                        className="h-9 rounded-md border px-2 text-[12px] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-60"
                        style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
                        Memory {selectedMemoryCount(selectedAgent, availableMemories)}/{availableMemories.length}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无 Agent，在右侧 3D 画布点击 ＋ 添加</div>
                )}
              </div>
            </section>

            <section className="flex min-h-0 flex-col gap-3">
              {/* 场景切换 / 形象素材选择 工具栏 (需求4) */}
              <div className="flex flex-wrap items-center gap-3 rounded-lg border p-2" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
                <label className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  <Layers className="h-3.5 w-3.5" /> 场景
                  <select value={sceneKind} onChange={e => setSceneKind(e.target.value as SceneKind)}
                    className="h-8 rounded-md border px-2 text-[12px] outline-none"
                    style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}>
                    {SCENE_KIND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
                <label className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  <Sparkles className="h-3.5 w-3.5" /> 形象
                  <select value={avatarKind} onChange={e => setAvatarKind(e.target.value as AvatarKind)}
                    className="h-8 rounded-md border px-2 text-[12px] outline-none"
                    style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}>
                    {AVATAR_KIND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
              </div>
              <Suspense fallback={<ResearchAgentTeamSceneFallback />}>
                <ResearchAgentTeamScene
                  agents={sceneAgents}
                  selectedId={selectedAgent?.id || null}
                  onSelect={(id) => chooseField(id, 'purpose')}
                  theme={theme}
                  sceneKind={sceneKind}
                  avatarKind={avatarKind}
                  onAdd={addAssistant}
                  addDisabled={submitting || agents.length >= MAX_TEAM_SIZE}
                  onDelete={deleteAgent}
                />
              </Suspense>
              <div className="min-h-[96px] rounded-lg border p-3" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}>
                {err && <ErrBanner className="mb-2">{err}</ErrBanner>}
                {progress.length > 0 ? (
                  <div className="max-h-20 overflow-y-auto text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    {progress.map((line, idx) => <div key={`${line}-${idx}`}>{line}</div>)}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" strokeWidth={1.8} />
                    {mode === 'single' ? '单个 Agent 模式：创建并自动启动该 Agent。' : '团队模式：逐个创建并自动启动，已有 Agent 保持锁定。'}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        <div className="flex h-14 flex-shrink-0 items-center justify-end gap-2 border-t px-5" style={{ borderColor: 'var(--border-color)' }}>
          <button onClick={onClose} disabled={submitting}
            className="h-9 rounded-xl border px-4 text-[13px] transition-colors disabled:opacity-40"
            style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)' }}>
            取消
          </button>
          <button onClick={submit} disabled={loadingConfig || submitting}
            className="inline-flex h-9 items-center gap-2 rounded-xl bg-emerald-500 px-4 text-[13px] text-white transition-colors hover:bg-emerald-600 disabled:opacity-40">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" strokeWidth={1.8} />}
            {submitting ? '创建并启动中...' : (mode === 'single' ? '创建并启动 Agent' : '创建并启动团队')}
          </button>
        </div>

        {selectionPanel && panelAgent && (
          <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm">
            <div className="flex max-h-[min(640px,calc(100vh-80px))] w-[min(560px,calc(100vw-48px))] flex-col rounded-2xl border p-4 shadow-2xl"
              style={{ background: 'var(--modal-bg)', borderColor: 'var(--border-color)' }}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {panelAgent.name} · {selectionPanel.type === 'skill' ? 'Skill' : 'Memory'}
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {selectionPanel.type === 'skill'
                      ? `${selectedSkillCount(panelAgent, availableSkills, agentSkills)}/${availableSkills.length} 已选择`
                      : `${selectedMemoryCount(panelAgent, availableMemories)}/${availableMemories.length} 已选择`}
                  </div>
                </div>
                <button onClick={() => setSelectionPanel(null)} className="rounded-lg p-1.5 hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-muted)' }}>
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border p-2" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
                {panelItems.length === 0 ? (
                  <div className="py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无可选项</div>
                ) : panelItems.map((item) => {
                  const isAgentSkill = selectionPanel.type === 'skill' && agentSkillIds.has(item.id)
                  const isMain = selectionPanel.type === 'skill' && panelAgent.mainSkillId === item.id
                  const checked = selectionPanel.type === 'skill'
                    ? (isMain || (!isAgentSkill && !panelAgent.excludedSkillIds.includes(item.id)))
                    : !panelAgent.excludedMemoryIds.includes(item.id)
                  const disabled = panelAgent.locked || submitting || isAgentSkill
                  return (
                    <label key={item.id}
                      className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-[12px] ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-[var(--bg-hover)]'}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleSelection(panelAgent, item.id, selectionPanel.type)}
                        className="mt-0.5 accent-blue-500"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate" style={{ color: 'var(--text-primary)' }}>{item.name}</div>
                        {item.description && <div className="truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{item.description}</div>}
                      </div>
                      {isMain && <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-blue-400 bg-blue-500/10">主Skill</span>}
                      {isAgentSkill && !isMain && <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-red-400 bg-red-500/10">互斥</span>}
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--bg-card-hover)', color: 'var(--text-muted)' }}>
                        {SCOPE_LABEL[item.scope] || item.scope}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
