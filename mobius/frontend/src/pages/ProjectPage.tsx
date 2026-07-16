import { useState, useEffect, useMemo, useRef, useCallback, type ReactNode } from 'react'
import { useParams, useNavigate, Navigate } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { useStore, api } from '../store'
import { TopNav } from '../components/shell'
import {
  NewIssueModal, RenameIssueModal, ConfirmModal,
  NewProjectModal, DeleteProjectModal, PathPickerModal,
  NewResearchModal, RenameResearchModal,
} from '../components/modals'
import { ProjectItemsPanel } from '../components/project-page/ProjectItemsPanel'
import { ProjectSettingsPanel } from '../components/project-page/ProjectSettingsPanel'
import { ProjectSidebar } from '../components/project-page/ProjectSidebar'
import { ResizablePanel, useMobileNavBreakpoint, useIsMobile } from '../components/resizable-panel'
import type { GitRepoDraft, IssueConfirmAction, ProjectFilter, ProjectListSection } from '../components/project-page/types'
import {
  DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE,
  intervalInputValue,
  numberInputValue,
  parseBackoffInput,
  parseIntervalInput,
  parsePatienceInput,
} from '../components/project-page/utils'

const ISSUE_PAGE_SIZE = 20
const PROJECT_META_AUTO_SAVE_DELAY_MS = 700

function parseAccessIdLines(value: string) {
  return Array.from(new Set(
    value.split(/[,\n]/).map(id => id.trim()).filter(Boolean)
  ))
}

function stringArraysEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  for (let i = 0; i < a.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function reposEqual(a: any[], b: any[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if ((a[i]?.url || '') !== (b[i]?.url || '')) return false
    if ((a[i]?.name || '') !== (b[i]?.name || '')) return false
  }
  return true
}

function normalizeProjectVisibility(value: any): 'private' | 'team' | 'public' | 'allowlist' {
  return value === 'team' || value === 'public' || value === 'allowlist' ? value : 'private'
}

function forgottenFlagMessageMatches(project: any, draft: string) {
  const saved = typeof project?.forgotten_flag_message === 'string' ? project.forgotten_flag_message : ''
  if (saved.trim()) return draft === saved
  const effective = project?.forgotten_flag_message_effective ?? saved
  return draft === '' || draft === effective
}

function numberDraftMatchesSaved(value: string, saved: any, fallback: number) {
  const n = Number(value)
  if (!Number.isFinite(n)) return false
  return n === Number(numberInputValue(saved, fallback))
}

function intervalDraftMatchesSaved(value: string, saved: any, fallback: number) {
  const n = Number(value)
  if (!Number.isInteger(n)) return false
  return n === Number(intervalInputValue(saved, fallback))
}

// =====================================================================
// Issue 汇总页 /u/:user/p/:project
// 左侧 sidebar：当前 project 的 issue 列表
// 右侧顶部：可编辑 project 元数据
// 右侧主体：issue 卡片（每张卡片：metadata + sessions 清单）
// =====================================================================
export default function ProjectPage() {
  const params = useParams()
  const navigate = useNavigate()
  const { projects, setProjects, currentProject, setCurrentProject,
          issues, issuesMap, setIssues, setIssuesMap, setCurrentIssue,
          researches, researchesMap, setResearches, setResearchesMap, setCurrentResearch,
          sessionsMap, setSessionsMap, setCurrentSession, setCurrentTask } = useStore()
  const userParam = params.user || ''
  const projectId = params.project || ''

  // 项目详情页内容密集 (左栏 + 多面板主区), 把移动端断点提到 1024px,
  // 让平板宽度也进入抽屉式侧栏 + 主区纵向堆叠, 排版更宽松美观.
  useMobileNavBreakpoint(1024)
  const isMobile = useIsMobile()
  // 移动端: 项目设置收进右侧抽屉, 主区以「新建 Issue / 列表」为主.
  const [settingsOpen, setSettingsOpen] = useState(false)

  const [showNewProject, setShowNewProject] = useState(false)
  const [showNewIssue, setShowNewIssue] = useState(false)
  const [showNewResearch, setShowNewResearch] = useState(false)
  const [editingIssue, setEditingIssue] = useState<any>(null)
  const [editingResearch, setEditingResearch] = useState<any>(null)
  const [confirmAction, setConfirmAction] = useState<IssueConfirmAction | null>(null)
  const [showDelete, setShowDelete] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ProjectFilter>('active')
  const SectionKey = `mobius:project:section:${projectId}`
  const sectionInit = (): ProjectListSection => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(SectionKey) : null
    return v === 'researches' || v === 'issues' ? v as ProjectListSection : 'issues'
  }
  const [section, setSection] = useState<ProjectListSection>(sectionInit)
  useEffect(() => { try { localStorage.setItem(SectionKey, section) } catch {} }, [SectionKey, section])
  const [issuePage, setIssuePage] = useState(1)
  const requestedIssueSessionIds = useRef<Set<string>>(new Set())
  // 按项目的 issue / research 列表加载态: 切换到未缓存项目时, 列表先显示 loading,
  // 不再回落渲染上个项目的 issue (旧 issuesMap[projectId] || issues 是闪现旧数据的元凶).
  const [issuesLoading, setIssuesLoading] = useState(false)
  const [researchesLoading, setResearchesLoading] = useState(false)

  // 编辑右侧 project 元数据（inline）
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editBindPath, setEditBindPath] = useState('')
  const [editBindPathManual, setEditBindPathManual] = useState(false)
  const [editGitRepos, setEditGitRepos] = useState<GitRepoDraft[]>([])
  const [editDefaultUseWorktree, setEditDefaultUseWorktree] = useState(true)
  const [editResearchEnabled, setEditResearchEnabled] = useState(false)
  const [editVisibility, setEditVisibility] = useState<'private' | 'team' | 'public' | 'allowlist'>('private')
  const [editAllowUserIds, setEditAllowUserIds] = useState<string[]>([])
  const [editCanPostIssue, setEditCanPostIssue] = useState<boolean>(false)
  const [editCanRunSession, setEditCanRunSession] = useState<boolean>(false)
  const [editDefaultModel, setEditDefaultModel] = useState<string>('')
  const [editForgottenFlagMessage, setEditForgottenFlagMessage] = useState('')
  const [editForgottenFlagIssueInit, setEditForgottenFlagIssueInit] = useState(String(DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES))
  const [editForgottenFlagIssueBackoff, setEditForgottenFlagIssueBackoff] = useState(String(DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF))
  const [editForgottenFlagIssuePatience, setEditForgottenFlagIssuePatience] = useState(String(DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE))
  const [editForgottenFlagResearchInit, setEditForgottenFlagResearchInit] = useState(String(DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES))
  const [editForgottenFlagResearchBackoff, setEditForgottenFlagResearchBackoff] = useState(String(DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF))
  const [editForgottenFlagResearchPatience, setEditForgottenFlagResearchPatience] = useState(String(DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE))
  const [pickerOpen, setPickerOpen] = useState(false)
  const [savingMeta, setSavingMeta] = useState(false)
  const [metaErr, setMetaErr] = useState('')

  const project = currentProject?.id === projectId ? currentProject : projects.find((p: any) => p.id === projectId)
  // 注意: 故意不再 `|| issues` 回落到全局 store —— 那会是上个项目的 issue 列表,
  // 切换项目瞬间会闪现旧数据. 未拉到时返回 [], 由 issuesLoading 控制列表显示 loading.
  const projectIssues = (issuesMap[projectId] || []) as any[]
  const projectResearches = (researchesMap[projectId] || []) as any[]
  const canCreateIssue = project?.can_create_issue !== false
  const canCreateResearch = !!project?.research_enabled && project?.can_create_research !== false

  // 进入页面：清除会话残留 + 拉数据
  useEffect(() => {
    // alive 防竞态: 快速切换项目时, 旧请求的 .finally 不再翻转新项目的 loading 态.
    let alive = true
    setCurrentIssue(null)
    setCurrentResearch(null)
    setCurrentSession(null)
    setCurrentTask(null)
    if (!projects.length) api('/api/projects').then(setProjects).catch(() => {})

    // Issue 列表: 命中缓存 → 立即展示(秒开) + 后台静默刷新; 未缓存 → 显示 loading 直到拉到.
    const issuesCached = !!issuesMap[projectId]
    setIssuesLoading(!issuesCached)
    api(`/api/projects/${projectId}/issues`).then((arr: any) => {
      setIssues(arr); setIssuesMap(projectId, arr)
    }).catch(() => {}).finally(() => { if (alive) setIssuesLoading(false) })

    // Research 列表: 与 Issue 同款逻辑, 行为保持一致.
    const researchesCached = !!researchesMap[projectId]
    setResearchesLoading(!researchesCached)
    api(`/api/projects/${projectId}/researches`).then((arr: any) => {
      setResearches(arr); setResearchesMap(projectId, arr)
      ;(arr || []).slice(0, 30).forEach((research: any) => {
        api(`/api/researches/${research.id}/sessions`).then((ss: any) => setSessionsMap(research.id, ss)).catch(() => {})
      })
    }).catch(() => {}).finally(() => { if (alive) setResearchesLoading(false) })

    return () => { alive = false }
    // 故意不把 issuesMap/researchesMap 放进 deps: 它们仅作"是否命中缓存"的一次性判断,
    // 成功路径会写入它们, 放进 deps 会触发本 effect 自身重跑(反复拉取).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // 同步 currentProject
  useEffect(() => {
    if (project && currentProject?.id !== project.id) setCurrentProject(project)
  }, [project?.id])

  // 若关闭 Research 系统时当前停留在 Research tab, 自动回到 Issue tab.
  useEffect(() => {
    if (!project) return
    if (!project.research_enabled && section === 'researches') setSection('issues')
  }, [project?.research_enabled, section])

  // 同步 inline 编辑表单
  useEffect(() => {
    if (project) {
      setEditName(project.name || '')
      setEditDesc(project.description || '')
      setEditBindPath(project.bind_path || '')
      // 还原持久化的手动标记: 手动设定过的路径再次保存时不再走严格校验, 防止回撤
      setEditBindPathManual(!!project.bind_path_manual)
      setMetaErr('')
      const repos = Array.isArray(project.git_repos) ? project.git_repos : []
      setEditGitRepos(repos.map((r: any) => ({ url: r?.url || '', name: r?.name || '' })))
      setEditDefaultUseWorktree(!!project.default_use_worktree)
      setEditResearchEnabled(!!project.research_enabled)
      setEditVisibility(normalizeProjectVisibility(project.visibility))
      setEditAllowUserIds(Array.isArray(project.access?.allow_user_ids) ? [...project.access.allow_user_ids] : [])
      setEditCanPostIssue(!!project.can_post_issue)
      setEditCanRunSession(!!project.can_run_session)
      setEditDefaultModel(typeof project.default_model === 'string' ? project.default_model : '')
      setEditForgottenFlagMessage(project.forgotten_flag_message_effective ?? (project.forgotten_flag_message || ''))
      setEditForgottenFlagIssueInit(intervalInputValue(project.forgotten_flag_issue_init_minutes ?? project.forgotten_flag_issue_interval_minutes, DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES))
      setEditForgottenFlagIssueBackoff(numberInputValue(project.forgotten_flag_issue_backoff, DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF))
      setEditForgottenFlagIssuePatience(intervalInputValue(project.forgotten_flag_issue_patience, DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE))
      setEditForgottenFlagResearchInit(intervalInputValue(project.forgotten_flag_research_init_minutes ?? project.forgotten_flag_research_interval_minutes, DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES))
      setEditForgottenFlagResearchBackoff(numberInputValue(project.forgotten_flag_research_backoff, DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF))
      setEditForgottenFlagResearchPatience(intervalInputValue(project.forgotten_flag_research_patience, DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE))
    }
  }, [project?.id])

  const filteredIssues = useMemo(() => {
    let arr = projectIssues
    if (filter === 'active') arr = arr.filter((i: any) => i.status !== 'completed')
    else if (filter === 'completed') arr = arr.filter((i: any) => i.status === 'completed')
    if (search.trim()) {
      const q = search.toLowerCase()
      arr = arr.filter((i: any) => i.title?.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q))
    }
    return [...arr].sort((a: any, b: any) => {
      const s = Number(!!b.starred) - Number(!!a.starred)
      if (s) return s
      return Number(!!b.pinned) - Number(!!a.pinned)
    })
  }, [projectIssues, filter, search])

  const filteredResearches = useMemo(() => {
    let arr = projectResearches
    if (filter === 'active') arr = arr.filter((r: any) => r.status !== 'completed')
    else if (filter === 'completed') arr = arr.filter((r: any) => r.status === 'completed')
    if (search.trim()) {
      const q = search.toLowerCase()
      arr = arr.filter((r: any) => r.title?.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q))
    }
    return arr.sort((a: any, b: any) => Number(!!b.pinned) - Number(!!a.pinned))
  }, [projectResearches, filter, search])

  const issueTotalPages = Math.max(1, Math.ceil(filteredIssues.length / ISSUE_PAGE_SIZE))
  const currentIssuePage = Math.min(issuePage, issueTotalPages)
  const pagedIssues = useMemo(() => {
    const start = (currentIssuePage - 1) * ISSUE_PAGE_SIZE
    return filteredIssues.slice(start, start + ISSUE_PAGE_SIZE)
  }, [filteredIssues, currentIssuePage])

  useEffect(() => {
    setIssuePage(1)
  }, [projectId, filter, search])

  useEffect(() => {
    if (issuePage > issueTotalPages) setIssuePage(issueTotalPages)
  }, [issuePage, issueTotalPages])

  useEffect(() => {
    requestedIssueSessionIds.current.clear()
  }, [projectId])

  useEffect(() => {
    pagedIssues.forEach((issue: any) => {
      if (!issue?.id) return
      if (Object.prototype.hasOwnProperty.call(sessionsMap, issue.id)) return
      if (requestedIssueSessionIds.current.has(issue.id)) return
      requestedIssueSessionIds.current.add(issue.id)
      api(`/api/issues/${issue.id}/sessions`)
        .then((ss: any) => setSessionsMap(issue.id, ss))
        .catch(() => { requestedIssueSessionIds.current.delete(issue.id) })
    })
  }, [pagedIssues, sessionsMap, setSessionsMap])

  const refreshIssues = () => api(`/api/projects/${projectId}/issues`).then((arr: any) => { setIssues(arr); setIssuesMap(projectId, arr) }).catch(() => {})
  const refreshResearches = () => api(`/api/projects/${projectId}/researches`).then((arr: any) => { setResearches(arr); setResearchesMap(projectId, arr) }).catch(() => {})

  // F9: 规划编辑器右键菜单创建执行 Issue 后, 刷新 Issue 列表以便立即显示新条目.
  useEffect(() => {
    function onIssueCreated(e: Event) {
      const detail = (e as CustomEvent).detail || {}
      if (detail.projectId && detail.projectId !== projectId) return
      refreshIssues()
    }
    window.addEventListener('mobius:planning-issue-created', onIssueCreated as EventListener)
    return () => window.removeEventListener('mobius:planning-issue-created', onIssueCreated as EventListener)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const handleArchitectureSessionCreated = (issue: any, _session: any) => {
    refreshIssues()
    if (issue?.id) {
      api(`/api/issues/${issue.id}/sessions`).then((ss: any) => setSessionsMap(issue.id, ss)).catch(() => {})
    }
  }

  const openNewIssue = () => {
    if (!canCreateIssue) return
    setShowNewIssue(true)
  }

  const [newIssueForcePlanning, setNewIssueForcePlanning] = useState(false)
  const openNewPlanningIssue = () => {
    if (!canCreateIssue) return
    setNewIssueForcePlanning(true)
    setShowNewIssue(true)
  }

  const openNewResearch = () => {
    if (!canCreateResearch) return
    setShowNewResearch(true)
  }

  const cleanedGitRepos = useMemo(() =>
    editGitRepos
      .map(r => ({ url: (r.url || '').trim(), name: (r.name || '').trim() }))
      .filter(r => r.url)
      .map(r => r.name ? r : { url: r.url }),
    [editGitRepos]
  )

  const editAllowUserIdList = useMemo(() => Array.from(new Set(editAllowUserIds.filter(Boolean))), [editAllowUserIds])
  const savedGitRepos = useMemo(() => Array.isArray(project?.git_repos) ? project.git_repos : [], [project?.git_repos])
  const savedAllowUserIds = useMemo(() =>
    Array.isArray(project?.access?.allow_user_ids) ? project.access.allow_user_ids : [],
    [project?.access?.allow_user_ids]
  )
  const savedVisibility = normalizeProjectVisibility(project?.visibility)
  const isExtensionProject = project?.kind === 'extension'
  const effectiveEditDefaultUseWorktree = editResearchEnabled ? false : editDefaultUseWorktree

  const nameDirty = !!project && editName !== project.name
  const descDirty = !!project && editDesc !== (project.description || '')
  const bindPathDirty = !!project && editBindPath !== (project.bind_path || '')
  const gitReposDirty = !!project && !reposEqual(cleanedGitRepos, savedGitRepos)
  const defaultUseWorktreeDirty = !!project && effectiveEditDefaultUseWorktree !== !!project.default_use_worktree
  const researchEnabledDirty = !!project && editResearchEnabled !== !!project.research_enabled
  const visibilityDirty = !!project && editVisibility !== savedVisibility
  const allowUserIdsDirty = !!project && !stringArraysEqual(editAllowUserIdList, savedAllowUserIds)
  const forgottenFlagMessageDirty = !!project && !forgottenFlagMessageMatches(project, editForgottenFlagMessage)
  const savedDefaultModel = typeof project?.default_model === 'string' ? project.default_model : ''
  const defaultModelDirty = !!project && editDefaultModel !== savedDefaultModel
  const issuePolicyDirty = !!project && (
    !intervalDraftMatchesSaved(
      editForgottenFlagIssueInit,
      project.forgotten_flag_issue_init_minutes ?? project.forgotten_flag_issue_interval_minutes,
      DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES
    ) ||
    !numberDraftMatchesSaved(
      editForgottenFlagIssueBackoff,
      project.forgotten_flag_issue_backoff,
      DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF
    ) ||
    !intervalDraftMatchesSaved(
      editForgottenFlagIssuePatience,
      project.forgotten_flag_issue_patience,
      DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE
    )
  )
  const researchPolicyDirty = !!project && (
    !intervalDraftMatchesSaved(
      editForgottenFlagResearchInit,
      project.forgotten_flag_research_init_minutes ?? project.forgotten_flag_research_interval_minutes,
      DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES
    ) ||
    !numberDraftMatchesSaved(
      editForgottenFlagResearchBackoff,
      project.forgotten_flag_research_backoff,
      DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF
    ) ||
    !intervalDraftMatchesSaved(
      editForgottenFlagResearchPatience,
      project.forgotten_flag_research_patience,
      DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE
    )
  )
  const normalProjectSettingsDirty = !!project && !isExtensionProject && (
    nameDirty ||
    descDirty ||
    bindPathDirty ||
    gitReposDirty ||
    defaultUseWorktreeDirty ||
    researchEnabledDirty ||
    visibilityDirty ||
    allowUserIdsDirty
  )
  const metaDirty = !!project && (
    normalProjectSettingsDirty ||
    forgottenFlagMessageDirty ||
    issuePolicyDirty ||
    researchPolicyDirty ||
    defaultModelDirty
  )

  const saveMeta = useCallback(async () => {
    if (!project) return
    if (project.can_manage === false) {
      setMetaErr('只有项目 owner/admin 可以修改项目设置')
      return
    }
    if (!isExtensionProject && !editName.trim()) {
      setMetaErr('项目名称不能为空')
      return
    }
    const body: any = {}
    if (!isExtensionProject) {
      if (nameDirty) body.name = editName
      if (descDirty) body.description = editDesc
      if (gitReposDirty) body.gitRepos = cleanedGitRepos
      if (visibilityDirty) body.visibility = editVisibility
      if (allowUserIdsDirty) body.allow_user_ids = editAllowUserIdList
      // v3 写权限: 总是把当前勾选状态写回, 即便和旧值一致也写, 避免极端边界下脏值漏写.
      body.can_post_issue = editCanPostIssue
      body.can_run_session = editCanRunSession
      if (defaultUseWorktreeDirty) body.defaultUseWorktree = effectiveEditDefaultUseWorktree
      if (researchEnabledDirty) body.researchEnabled = editResearchEnabled
      // 仅在路径实际变化时提交，避免重新对已存在的(可能是手动设定/work_dir 外)路径做严格校验
      if (bindPathDirty) {
        body.bindPath = editBindPath
        body.bindPathManual = editBindPathManual
      }
      if (defaultModelDirty) body.defaultModel = editDefaultModel || null
    }
    if (forgottenFlagMessageDirty) body.forgottenFlagMessage = editForgottenFlagMessage
    try {
      if (issuePolicyDirty) {
        body.forgottenFlagIssueInitMinutes = parseIntervalInput(editForgottenFlagIssueInit, 'Issue Session Init', 1)
        body.forgottenFlagIssueBackoff = parseBackoffInput(editForgottenFlagIssueBackoff, 'Issue Session Backoff')
        body.forgottenFlagIssuePatience = parsePatienceInput(editForgottenFlagIssuePatience, 'Issue Session Patience')
      }
      if (researchPolicyDirty) {
        body.forgottenFlagResearchInitMinutes = parseIntervalInput(editForgottenFlagResearchInit, 'Research Agent Init', 30)
        body.forgottenFlagResearchBackoff = parseBackoffInput(editForgottenFlagResearchBackoff, 'Research Agent Backoff')
        body.forgottenFlagResearchPatience = parsePatienceInput(editForgottenFlagResearchPatience, 'Research Agent Patience')
      }
    } catch (e: any) {
      setMetaErr(e?.message || '提醒策略格式错误')
      return
    }
    if (!Object.keys(body).length) {
      setMetaErr('')
      return
    }
    setSavingMeta(true)
    setMetaErr('')
    try {
      const updated = await api(`/api/projects/${project.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      setProjects(projects.map((p: any) => p.id === updated.id ? { ...p, ...updated } : p))
      setCurrentProject({ ...project, ...updated })
    } catch (e: any) { setMetaErr(e?.message || '保存失败') }
    finally { setSavingMeta(false) }
  }, [
    project,
    projects,
    isExtensionProject,
    editName,
    editDesc,
    editBindPath,
    editBindPathManual,
    cleanedGitRepos,
    effectiveEditDefaultUseWorktree,
    editResearchEnabled,
    editVisibility,
    editAllowUserIdList,
    editForgottenFlagMessage,
    editForgottenFlagIssueInit,
    editForgottenFlagIssueBackoff,
    editForgottenFlagIssuePatience,
    editForgottenFlagResearchInit,
    editForgottenFlagResearchBackoff,
    editForgottenFlagResearchPatience,
    editDefaultModel,
    nameDirty,
    descDirty,
    bindPathDirty,
    gitReposDirty,
    defaultUseWorktreeDirty,
    researchEnabledDirty,
    visibilityDirty,
    allowUserIdsDirty,
    forgottenFlagMessageDirty,
    issuePolicyDirty,
    researchPolicyDirty,
    defaultModelDirty,
    setProjects,
    setCurrentProject,
  ])

  useEffect(() => {
    if (!project || project.can_manage === false || !metaDirty || savingMeta) return
    const timer = window.setTimeout(() => {
      void saveMeta()
    }, PROJECT_META_AUTO_SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [project?.id, project?.can_manage, metaDirty, savingMeta, saveMeta])

  useEffect(() => {
    if (!metaDirty && metaErr) setMetaErr('')
  }, [metaDirty, metaErr])

  const handleConfirm = async () => {
    if (!confirmAction) return
    const { kind, issue } = confirmAction
    try {
      if (kind === 'complete') await api(`/api/issues/${issue.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) })
      else if (kind === 'reopen') await api(`/api/issues/${issue.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) })
      else if (kind === 'pin') await api(`/api/issues/${issue.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: 1 }) })
      else if (kind === 'unpin') await api(`/api/issues/${issue.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: 0 }) })
      else if (kind === 'delete') await api(`/api/issues/${issue.id}`, { method: 'DELETE' })
    } catch {}
    setConfirmAction(null)
    refreshIssues()
  }

  const toggleIssueStar = (issue: any) => {
    const next = !issue.starred
    // 乐观更新 issuesMap, 让 UI 立即响应
    const updated = (issuesMap[projectId] || []).map((i: any) => i.id === issue.id ? { ...i, starred: next ? 1 : 0 } : i)
    setIssuesMap(projectId, updated)
    if (!issuesMap[projectId]) setIssues(updated)
    api(`/api/issues/${issue.id}/star`, { method: 'PATCH', body: JSON.stringify({ starred: next }) })
      .then(() => refreshIssues())
      .catch(() => { refreshIssues() })
  }

  const toggleResearchStatus = (research: any, status: 'active' | 'completed') => {
    api(`/api/researches/${research.id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      .then(refreshResearches)
      .catch(() => {})
  }

  if (!projectId) return <Navigate to={`/u/${userParam}`} replace />
  if (!project) return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--bg-primary)' }}>
      <TopNav />
      <div className="flex-1 flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
        <div className="text-[13px]">加载项目中...</div>
      </div>
    </div>
  )

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--bg-primary)' }}>
      <TopNav />
      <div className="flex flex-1 min-h-0">
        <ResizablePanel
          storageKey="mobius:ui:sidebar:project-issues"
          defaultWidth={288}
          minWidth={200}
          maxWidth={480}
          side="left"
          className="border-r flex flex-col"
          style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
          <ProjectSidebar
            userParam={userParam}
            projectId={projectId}
            issues={pagedIssues}
            search={search}
            filter={filter}
            issuesLoading={issuesLoading}
            pagination={{
              page: currentIssuePage,
              pageSize: ISSUE_PAGE_SIZE,
              totalItems: filteredIssues.length,
              totalPages: issueTotalPages,
              onPageChange: setIssuePage,
            }}
            onSearchChange={setSearch}
            onFilterChange={setFilter}
            canCreateIssue={canCreateIssue}
            onCreateIssue={openNewIssue}
            onToggleStar={toggleIssueStar}
          />
        </ResizablePanel>

        <main className="flex-1 overflow-y-auto" style={{ background: 'var(--bg-secondary)' }}>
          <div className="max-w-7xl mx-auto p-3 sm:p-6">
            {(() => {
              const settingsPanel = (
                <ProjectSettingsPanel
                  project={project}
                  values={{
                    editName,
                    editDesc,
                    editBindPath,
                    editGitRepos,
                    editDefaultUseWorktree,
                    editResearchEnabled,
                    editVisibility,
                    editAllowUserIds,
                    editCanPostIssue,
                    editCanRunSession,
                    editDefaultModel,
                    editForgottenFlagMessage,
                    editForgottenFlagIssueInit,
                    editForgottenFlagIssueBackoff,
                    editForgottenFlagIssuePatience,
                    editForgottenFlagResearchInit,
                    editForgottenFlagResearchBackoff,
                    editForgottenFlagResearchPatience,
                  }}
                  setters={{
                    setEditName,
                    setEditDesc,
                    setEditBindPath,
                    setEditBindPathManual,
                    setEditGitRepos,
                    setEditDefaultUseWorktree,
                    setEditResearchEnabled,
                    setEditVisibility,
                    setEditAllowUserIds,
                    setEditCanPostIssue,
                    setEditCanRunSession,
                    setEditDefaultModel,
                    setEditForgottenFlagMessage,
                    setEditForgottenFlagIssueInit,
                    setEditForgottenFlagIssueBackoff,
                    setEditForgottenFlagIssuePatience,
                    setEditForgottenFlagResearchInit,
                    setEditForgottenFlagResearchBackoff,
                    setEditForgottenFlagResearchPatience,
                  }}
                  metaErr={metaErr}
                  savingMeta={savingMeta}
                  metaDirty={metaDirty}
                  onDeleteProject={() => setShowDelete(true)}
                  onOpenPathPicker={() => setPickerOpen(true)}
                  onArchitectureSessionCreated={handleArchitectureSessionCreated}
                />
              )
              const itemsPanel = (
                <ProjectItemsPanel
                  project={project}
                  userParam={userParam}
                  projectId={projectId}
                  section={section}
                  filter={filter}
                  search={search}
                  issues={pagedIssues}
                  researches={filteredResearches}
                  sessionsMap={sessionsMap}
                  issuesLoading={issuesLoading}
                  researchesLoading={researchesLoading}
                  issuePagination={{
                    page: currentIssuePage,
                    pageSize: ISSUE_PAGE_SIZE,
                    totalItems: filteredIssues.length,
                    totalPages: issueTotalPages,
                    onPageChange: setIssuePage,
                  }}
                  onSectionChange={setSection}
                  canCreateIssue={canCreateIssue}
                  canCreateResearch={canCreateResearch}
                  onCreateIssue={openNewIssue}
                  onCreatePlanningIssue={openNewPlanningIssue}
                  onCreateResearch={openNewResearch}
                  onEditIssue={setEditingIssue}
                  onEditResearch={setEditingResearch}
                  onIssueConfirm={setConfirmAction}
                  onToggleResearchStatus={toggleResearchStatus}
                  onToggleIssueStar={toggleIssueStar}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              )
              return isMobile ? (
                <>
                  {itemsPanel}
                  <MobileSettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                    {settingsPanel}
                  </MobileSettingsDrawer>
                </>
              ) : (
                <div className="flex gap-6 items-start">
                  {settingsPanel}
                  {itemsPanel}
                </div>
              )
            })()}
          </div>
        </main>
      </div>

      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} onCreated={(p: any) => {
        setShowNewProject(false)
        if (p?.id && p?.created_by) navigate(`/u/${p.created_by}/p/${p.id}`)
      }} />}
      {showNewIssue && <NewIssueModal projectId={projectId} defaultUseWorktree={!!project?.default_use_worktree} forcePlanning={newIssueForcePlanning}
        onClose={() => { setShowNewIssue(false); setNewIssueForcePlanning(false) }}
        onCreated={(iss: any, options) => {
          setShowNewIssue(false)
          setNewIssueForcePlanning(false)
          refreshIssues()
          // 规划模式: 后端已自动创建 Session, 直接跳到 Session 页面.
          if (options?.planningSessionId) {
            navigate(`/u/${userParam}/p/${projectId}/i/${iss.id}?session=${options.planningSessionId}`)
          } else {
            navigate(`/u/${userParam}/p/${projectId}/i/${iss.id}${options?.createFirstSession ? '?newSession=1' : ''}`)
          }
        }} />}
      {showNewResearch && <NewResearchModal projectId={projectId} onClose={() => setShowNewResearch(false)}
        onCreated={(research: any) => { setShowNewResearch(false); refreshResearches(); navigate(`/u/${userParam}/p/${projectId}/r/${research.id}`) }} />}
      {editingIssue && <RenameIssueModal issue={editingIssue} onClose={() => setEditingIssue(null)}
        onRenamed={() => { setEditingIssue(null); refreshIssues() }} />}
      {editingResearch && <RenameResearchModal research={editingResearch} onClose={() => setEditingResearch(null)}
        onRenamed={() => { setEditingResearch(null); refreshResearches() }} />}
      {confirmAction && <ConfirmModal
        title={
          confirmAction.kind === 'complete' ? '完成 Issue' :
          confirmAction.kind === 'reopen' ? '重新打开 Issue' :
          confirmAction.kind === 'pin' ? '置顶 Issue' :
          confirmAction.kind === 'unpin' ? '取消置顶' :
          '删除 Issue'
        }
        message={
          confirmAction.kind === 'delete'
            ? `确定删除 Issue「${confirmAction.issue.title}」？此操作不可恢复。`
            : `确定${confirmAction.kind === 'complete' ? '将此 Issue 标记为完成' :
                 confirmAction.kind === 'reopen' ? '重新打开此 Issue' :
                 confirmAction.kind === 'pin' ? '置顶此 Issue' : '取消置顶此 Issue'}？`
        }
        onConfirm={handleConfirm}
        onClose={() => setConfirmAction(null)}
        confirmText={confirmAction.kind === 'delete' ? '删除' : '确认'}
        confirmClass={confirmAction.kind === 'delete' ? 'bg-red-500 hover:bg-red-600' :
          confirmAction.kind === 'complete' ? 'bg-green-500 hover:bg-green-600' :
          'bg-blue-500 hover:bg-blue-600'} />}
      {pickerOpen && <PathPickerModal initialPath={editBindPath} onClose={() => setPickerOpen(false)}
        onPick={(abs, _rel, manual) => { setEditBindPath(abs); setEditBindPathManual(!!manual); setPickerOpen(false) }} />}
      {showDelete && <DeleteProjectModal project={project} onClose={() => setShowDelete(false)}
        onDeleted={() => { setShowDelete(false); navigate(`/u/${userParam}`) }} />}
    </div>
  )
}

// 移动端「项目设置」抽屉: 从右滑入, 全高 + 内部滚动, 容纳 settings 全部 tab/表单.
// 复用 .mobius-drawer / .mobius-drawer-backdrop 视觉, --right 变体改为右侧滑入.
function MobileSettingsDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <>
      <div className="mobius-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="mobius-drawer mobius-drawer--right mobius-drawer--open"
        role="dialog"
        aria-modal="true"
        aria-label="项目设置"
      >
        <button type="button" className="mobius-drawer-close" onClick={onClose} aria-label="关闭" title="关闭">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        {children}
      </aside>
    </>,
    document.body
  )
}
