import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, BookOpen, CheckCircle2, ChevronDown, CircleQuestionMark, Download, PlayCircle, RefreshCw, Settings2, Sparkles, X, type LucideIcon } from 'lucide-react'
import { api, useStore } from '../store'
import { createBirthdayDemoState, readBirthdayDemoState } from '../services/birthday-demo'
import { createProjectImportDemoState } from '../services/project-import-demo'
import { createContextSetupDemoState } from '../services/context-setup-demo'
import { readExtensionDemoState } from '../services/extension-demo'
import {
  SELF_EVOLVE_MEMORY_BODY,
  SELF_EVOLVE_REQUIRED_MEMORY_NAME,
  createSelfEvolveDemoState,
} from '../services/self-evolve-demo'
import {
  LOGO_REVIEW_ISSUE_TITLE,
  LOGO_REVIEW_PROJECT_ID,
  LOGO_REVIEW_PROJECT_NAME,
  LOGO_REVIEW_SESSION_NAME,
  createLogoReviewDemoState,
  type LogoReviewDemoState,
} from '../services/logo-review-demo'
import {
  startBirthdayDemoTour,
  startContextSetupDemoTour,
  startIntroTour,
  startLogoReviewDemoTour,
  startProjectImportDemoTour,
  startSelfEvolveDemoTour,
} from '../services/tour'
import { MobiusLogo } from './mobius-logo'

type GuideDemoKind = 'birthday' | 'logo-review' | 'project-import' | 'context-setup' | 'self-evolve'
type GuideRouteKind = 'intro' | GuideDemoKind

export const SELF_EVOLVE_DEMO_TIMESTAMP_TEXT = '自迭代演示时间：2026-06-13 02:21:36 UTC'

type SelfEvolveProjectCandidate = {
  id?: string
  name?: string
  description?: string
  bind_path?: string
  is_self_develop?: boolean
  kind?: string
  hidden?: boolean
  disabled?: boolean
  starred?: boolean
  created_by?: string
  last_active?: string
}

type GuideHelpModalProps = {
  firstLogin?: boolean
  onClose: (opts?: { rememberNoAuto?: boolean; started?: boolean }) => void
}

const GUIDE_TONE = '#38bdf8'
const GUIDE_HEADER_BG = 'linear-gradient(0deg, rgba(56, 189, 248, 0.065), rgba(56, 189, 248, 0.065)), var(--bg-secondary)'
const GUIDE_HEADER_BG_CLOSED = 'linear-gradient(0deg, rgba(56, 189, 248, 0.035), rgba(56, 189, 248, 0.035)), var(--bg-secondary)'
const GUIDE_CONTENT_BG = 'var(--bg-primary)'
const GUIDE_INTERACTIVE_BG = 'linear-gradient(0deg, rgba(56, 189, 248, 0.085), rgba(56, 189, 248, 0.085)), var(--bg-secondary)'
const GUIDE_INTERACTIVE_BORDER = 'rgba(56, 189, 248, 0.28)'
const GUIDE_ACTION_TEXT = '#082f49'

type GuidePreludeStage = {
  title: string
  body: string[]
  action: 'next' | 'demo'
}

const GUIDE_PRELUDE_STAGES: GuidePreludeStage[] = [
  {
    title: '欢迎使用莫比乌斯系统',
    body: [
      '这里不是普通聊天框，而是一个围绕真实项目工作的智能系统。',
      '你可以把代码、资料和目标交给它，再让智能体一步步完成任务。',
      '接下来，我们先用一个演示项目看完整流程。',
    ],
    action: 'next',
  },
  {
    title: '莫比乌斯系统是一个具备自我重塑能力的智能系统',
    body: [
      '它不仅能帮您开发新项目，或者进一步改造现有项目。',
      '它还能链接算力集群，自动做实验、整理结果并写文章。',
      '更重要的是，它可以对自身的所有功能进行重塑。',
    ],
    action: 'next',
  },
  {
    title: '现在，我们一起来尝试创建一个演示项目',
    body: [
      '系统会带你创建一个光点拓展演示项目，写清楚任务目标。',
      '随后启动智能体，让它读取原型文件、检查结构，并留下执行记录。',
      '如果暂时不想创建内容，可以点击跳过进入路线选择。',
    ],
    action: 'demo',
  },
]

const GUIDE_ROUTES: Array<{
  kind: GuideRouteKind
  title: string
  subtitle: string
  description: string
  action: string
  icon: LucideIcon
}> = [
  {
    kind: 'birthday',
    title: '创建演示项目',
    subtitle: '第一次完成任务',
    description: '适合第一次使用。系统会带你创建光点拓展演示项目、写任务、启动智能体，并打开真实执行会话。',
    action: '创建演示项目',
    icon: Sparkles,
  },
  {
    kind: 'logo-review',
    title: '验收完成案例',
    subtitle: '直接看同一任务的完成版',
    description: `不等待新智能体跑完，直接进入固定完成项目「${LOGO_REVIEW_PROJECT_NAME}」，学习如何验收结果和打开拓展应用。`,
    action: '查看完成版',
    icon: CheckCircle2,
  },
  {
    kind: 'intro',
    title: '认识页面',
    subtitle: '只看页面布局，不创建内容',
    description: '适合暂时不想创建演示项目时使用。它只会高亮页面入口，不会创建项目或修改文件。',
    action: '认识页面',
    icon: BookOpen,
  },
  {
    kind: 'project-import',
    title: '导入已有代码',
    subtitle: '上传本地文件或下载公开仓库',
    description: '适合已经有代码的人。你可以选择网页上传，也可以让智能体从公开 Git（代码下载工具）仓库下载。',
    action: '选择导入方式',
    icon: Download,
  },
  {
    kind: 'context-setup',
    title: '配置开发资料',
    subtitle: '让智能体带上规则和方法',
    description: '适合长期维护莫比乌斯。你会导入项目知识和项目方法，再验证它们是否进入执行会话。',
    action: '开始配置',
    icon: Settings2,
  },
  {
    kind: 'self-evolve',
    title: '莫比乌斯自迭代',
    subtitle: '让系统安全修改自己',
    description: '适合想改进莫比乌斯本身的人。系统会带你创建一个受控任务，只修改一处演示文字。',
    action: '开始自迭代',
    icon: RefreshCw,
  },
]

const RECOMMENDED_ROUTE = GUIDE_ROUTES.find(route => route.kind === 'birthday')!
const REVIEW_ROUTE = GUIDE_ROUTES.find(route => route.kind === 'logo-review')!
const OPTIONAL_HELP_ROUTE = GUIDE_ROUTES.find(route => route.kind === 'intro')!
const MORE_GUIDE_ROUTES = GUIDE_ROUTES.filter(route => route.kind !== 'birthday' && route.kind !== 'logo-review' && route.kind !== 'intro')

function AccordionHeader({
  title,
  summary,
  icon: Icon,
  open,
  onToggle,
}: {
  title: string
  summary: string
  icon: LucideIcon
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-[var(--bg-card-hover)] transition-colors"
      style={{
        color: 'var(--text-primary)',
        background: open ? GUIDE_HEADER_BG : GUIDE_HEADER_BG_CLOSED,
        borderLeft: `3px solid ${open ? GUIDE_TONE : 'rgba(56, 189, 248, 0.36)'}`,
      }}
    >
      <span
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ color: GUIDE_TONE, background: 'rgba(56, 189, 248, 0.12)' }}
      >
        <Icon className="w-4 h-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold">{title}</span>
        <span className="block text-[12px] mt-1 leading-5" style={{ color: 'var(--text-muted)' }}>{summary}</span>
      </span>
      <ChevronDown
        className={`w-4 h-4 mt-2 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        style={{ color: 'var(--text-muted)' }}
      />
    </button>
  )
}

function StreamingText({
  text,
  active,
  className = '',
  delayMs = 0,
}: {
  text: string
  active: boolean
  className?: string
  delayMs?: number
}) {
  const [visible, setVisible] = useState(active ? '' : text)

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!active || reduceMotion) {
      setVisible(text)
      return undefined
    }
    setVisible('')
    let index = 0
    const intervalMs = text.length > 80 ? 15 : 26
    let timer: number | undefined
    const delay = window.setTimeout(() => {
      timer = window.setInterval(() => {
        index += 1
        setVisible(text.slice(0, index))
        if (index >= text.length && timer !== undefined) window.clearInterval(timer)
      }, intervalMs)
    }, delayMs)
    return () => {
      window.clearTimeout(delay)
      if (timer) window.clearInterval(timer)
    }
  }, [active, delayMs, text])

  return (
    <span className={`guide-stream-text ${className}`}>
      {visible}
      {active && visible.length < text.length ? <span className="guide-stream-cursor" aria-hidden="true" /> : null}
    </span>
  )
}

function GuidePrelude({
  onSkip,
  onStartDemo,
  starting,
  err,
}: {
  onSkip: () => void
  onStartDemo: () => void
  starting: boolean
  err: string
}) {
  const [stageIndex, setStageIndex] = useState(0)
  const stage = GUIDE_PRELUDE_STAGES[stageIndex]

  const advance = () => {
    if (stage.action === 'demo') {
      onStartDemo()
      return
    }
    setStageIndex(index => Math.min(index + 1, GUIDE_PRELUDE_STAGES.length - 1))
  }

  return (
    <div className={`guide-prelude-shell guide-prelude-narrative-stage-${stageIndex}`}>
      <div className="guide-prelude-content">
        <div className="guide-prelude-card" key={`stage-card-${stageIndex}`}>
          <div className="guide-prelude-card-rail" aria-hidden="true">
            {GUIDE_PRELUDE_STAGES.map((_, index) => (
              <span
                key={index}
                className={index === stageIndex ? 'active' : index < stageIndex ? 'done' : ''}
                style={{ top: `${index * 50}%` }}
              />
            ))}
          </div>
          <div className="guide-prelude-progress" aria-hidden="true">
            {stageIndex + 1} / {GUIDE_PRELUDE_STAGES.length}
          </div>
          <h2 className={`guide-prelude-title ${stageIndex === 1 ? 'is-long' : ''} ${stageIndex === 0 ? 'has-logo-after' : ''}`} key={`title-${stageIndex}`}>
            <span className="guide-prelude-title-copy">
              <StreamingText text={stage.title} active />
            </span>
            {stageIndex === 0 ? <MobiusLogo size={46} className="guide-prelude-title-logo" /> : null}
          </h2>
          <div className="guide-prelude-body" key={`body-${stageIndex}`}>
            <StreamingText text={stage.body.join('\n')} active delayMs={420} />
          </div>
          <div className="guide-prelude-actions">
            <button type="button" className="guide-prelude-primary" onClick={advance} disabled={starting}>
              下一步
            </button>
            <button type="button" className="guide-prelude-secondary" onClick={onSkip} disabled={starting}>
              跳过
            </button>
          </div>
          {err ? (
            <div className="guide-prelude-error" role="alert">
              {err}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function stateForDemo(kind: GuideDemoKind) {
  if (kind === 'project-import') return createProjectImportDemoState()
  if (kind === 'context-setup') return createContextSetupDemoState()
  if (kind === 'logo-review') return createLogoReviewDemoState()
  const currentBirthdayDemo = readBirthdayDemoState()
  return currentBirthdayDemo?.active ? currentBirthdayDemo : createBirthdayDemoState()
}

function startDemo(kind: GuideDemoKind) {
  if (kind === 'project-import') startProjectImportDemoTour()
  else if (kind === 'context-setup') startContextSetupDemoTour()
  else if (kind === 'self-evolve') startSelfEvolveDemoTour()
  else if (kind === 'logo-review') startLogoReviewDemoTour()
  else startBirthdayDemoTour()
}

function scoreSelfEvolveProject(project: SelfEvolveProjectCandidate, currentUserId: string) {
  const name = String(project.name || '').toLowerCase()
  const bindPath = String(project.bind_path || '')
  let score = 0
  if (project.is_self_develop) score += 100
  if (project.kind !== 'extension') score += 40
  if (!project.hidden) score += 20
  if (!project.disabled) score += 20
  if (project.created_by === currentUserId) score += 15
  if (project.starred) score += 10
  if (name.includes('imac-self-develop')) score += 60
  if (name.includes('system self evolve')) score += 50
  if (name.includes('自迭代') || name.includes('自进化')) score += 45
  if (/\/imac-test\/?$/.test(bindPath)) score += 25
  return score
}

function chooseSelfEvolveProject(projects: SelfEvolveProjectCandidate[], currentUserId: string) {
  const visible = projects.filter(project => project?.id && !project.hidden && !project.disabled)
  const candidates = visible.filter(project => {
    const haystack = `${project.name || ''} ${project.bind_path || ''}`.toLowerCase()
    return !!project.is_self_develop || haystack.includes('/imac-test') || haystack.includes('imac-self-develop') || haystack.includes('system self evolve')
  })
  const normalCandidates = candidates.filter(project => project.kind !== 'extension')
  const pool = normalCandidates.length > 0 ? normalCandidates : candidates
  if (pool.length === 0) return null
  return [...pool].sort((a, b) => {
    const scoreDiff = scoreSelfEvolveProject(b, currentUserId) - scoreSelfEvolveProject(a, currentUserId)
    if (scoreDiff !== 0) return scoreDiff
    const bLast = Date.parse(String(b.last_active || ''))
    const aLast = Date.parse(String(a.last_active || ''))
    return (Number.isFinite(bLast) ? bLast : 0) - (Number.isFinite(aLast) ? aLast : 0)
  })[0]
}

async function ensureSelfEvolveMemory(projectId: string) {
  try {
    const memories = await api(`/api/projects/${projectId}/memories`)
    const exists = Array.isArray(memories)
      ? memories.some((item: any) => String(item?.name || '') === SELF_EVOLVE_REQUIRED_MEMORY_NAME)
      : false
    if (exists) return
    await api(`/api/projects/${projectId}/memories`, {
      method: 'POST',
      body: JSON.stringify({
        name: SELF_EVOLVE_REQUIRED_MEMORY_NAME,
        description: '莫比乌斯自迭代任务使用的代码位置、验证命令和安全边界。',
        body: SELF_EVOLVE_MEMORY_BODY,
      }),
    })
  } catch {
    // 缺少权限时仍允许进入路线，预览页会暴露缺失资料，用户可手动补齐。
  }
}

async function buildLogoReviewPatch(): Promise<Partial<LogoReviewDemoState>> {
  const birthdayState = readBirthdayDemoState()
  const extensionState = readExtensionDemoState()
  const cleanupState = birthdayState?.active && birthdayState.projectId
    ? birthdayState
    : extensionState?.active && extensionState.projectId
      ? extensionState
      : null
  const patch: Partial<LogoReviewDemoState> = cleanupState?.projectId
    ? {
      cleanupProjectId: cleanupState.projectId,
      cleanupProjectName: cleanupState.projectName,
      cleanupProjectRelPath: cleanupState.projectRelPath,
    }
    : {}

  try {
    const issues = await api(`/api/projects/${LOGO_REVIEW_PROJECT_ID}/issues`)
    const issue = Array.isArray(issues)
      ? issues.find((item: any) => String(item?.title || '').includes(LOGO_REVIEW_ISSUE_TITLE)) || issues[0]
      : null
    if (issue?.id) {
      patch.issueId = issue.id
      const sessions = await api(`/api/issues/${issue.id}/sessions`)
      const session = Array.isArray(sessions)
        ? sessions.find((item: any) => String(item?.name || '').includes(LOGO_REVIEW_SESSION_NAME) && item?.job_accomplished === true)
          || sessions.find((item: any) => String(item?.name || '').includes(LOGO_REVIEW_SESSION_NAME))
          || sessions.find((item: any) => item?.job_accomplished === true)
          || sessions[0]
        : null
      if (session?.session_id) patch.sessionId = session.session_id
    }
  } catch {}

  return patch
}

export function GuideHelpModal({ firstLogin = false, onClose }: GuideHelpModalProps) {
  const { user, projects, setProjects } = useStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [rememberNoAuto, setRememberNoAuto] = useState(true)
  const [starting, setStarting] = useState<GuideRouteKind | null>(null)
  const [err, setErr] = useState('')
  const [introOpen, setIntroOpen] = useState(false)
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const [routesOpen, setRoutesOpen] = useState(false)
  const [showPrelude, setShowPrelude] = useState(true)
  const activeBirthdayDemo = !!readBirthdayDemoState()?.active

  const launch = async (kind: GuideRouteKind) => {
    if (!user?.id || starting) return
    setStarting(kind)
    setErr('')
    try {
      const homePath = `/u/${user.id}`
      if (kind === 'intro') {
        onClose({ rememberNoAuto: true, started: true })
        if (location.pathname !== homePath) navigate(homePath)
        window.setTimeout(() => {
          void startIntroTour()
        }, location.pathname === homePath ? 100 : 320)
        return
      }
      if (kind === 'logo-review') {
        const patch = await buildLogoReviewPatch()
        const targetPath = patch.issueId
          ? `/u/${user.id}/p/${LOGO_REVIEW_PROJECT_ID}/i/${patch.issueId}${patch.sessionId ? `?session=${patch.sessionId}` : ''}`
          : `/u/${user.id}/p/${LOGO_REVIEW_PROJECT_ID}`
        onClose({ rememberNoAuto: true, started: true })
        navigate(targetPath)
        window.setTimeout(() => startLogoReviewDemoTour(patch), location.pathname === targetPath ? 80 : 260)
        return
      }
      if (kind === 'self-evolve') {
        let projectList = Array.isArray(projects) && projects.length > 0 ? projects : []
        if (projectList.length === 0) {
          const loaded = await api('/api/projects')
          projectList = Array.isArray(loaded) ? loaded : []
          setProjects(projectList as any)
        }
        const target = chooseSelfEvolveProject(projectList as SelfEvolveProjectCandidate[], user.id)
        if (!target?.id) {
          throw new Error('没有找到可用的莫比乌斯自迭代项目。请先确认已有项目绑定到莫比乌斯代码目录。')
        }
        await ensureSelfEvolveMemory(target.id)
        const patch = createSelfEvolveDemoState({
          projectId: target.id,
          projectName: target.name || '莫比乌斯自迭代项目',
          projectDescription: target.description || '',
          projectRelPath: target.bind_path || '',
        })
        const targetPath = `/u/${user.id}/p/${target.id}`
        onClose({ rememberNoAuto: true, started: true })
        navigate(targetPath)
        window.setTimeout(() => startSelfEvolveDemoTour(patch), location.pathname === targetPath ? 80 : 260)
        return
      }
      const demoState = stateForDemo(kind)
      await api('/api/files/mkdir', {
        method: 'POST',
        body: JSON.stringify({ path: demoState.projectRelPath }),
      })
      onClose({ rememberNoAuto: true, started: true })
      if (location.pathname !== homePath) navigate(homePath)
      window.setTimeout(() => startDemo(kind), location.pathname === homePath ? 80 : 260)
    } catch (e: any) {
      setErr(e?.message ? `引导没有启动成功：${e.message}` : '引导没有启动成功。请确认页面加载完成后再试。')
      setStarting(null)
    }
  }

  const renderRouteButton = (
    route: typeof GUIDE_ROUTES[number],
    variant: 'primary' | 'secondary' | 'compact' = 'secondary',
  ) => {
    const Icon = route.icon
    const active = starting === route.kind
    const isPrimary = variant === 'primary'
    const actionLabel = active
      ? '正在准备'
      : route.kind === 'birthday' && activeBirthdayDemo
        ? '继续演示项目'
        : route.action
    return (
      <button
        key={route.kind}
        type="button"
        onClick={() => void launch(route.kind)}
        disabled={!!starting}
        className={`w-full rounded-lg border text-left flex items-start gap-3 hover:bg-[var(--bg-card-hover)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${isPrimary ? 'p-4' : 'p-3'}`}
        style={{
          borderColor: isPrimary ? 'rgba(56, 189, 248, 0.48)' : GUIDE_INTERACTIVE_BORDER,
          background: isPrimary
            ? 'linear-gradient(0deg, rgba(56, 189, 248, 0.14), rgba(56, 189, 248, 0.14)), var(--bg-secondary)'
            : variant === 'compact'
              ? 'var(--bg-secondary)'
              : GUIDE_INTERACTIVE_BG,
        }}
      >
        <span
          className={`${isPrimary ? 'w-11 h-11' : 'w-10 h-10'} rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5`}
          style={{ color: GUIDE_TONE, background: 'rgba(56, 189, 248, 0.12)' }}
        >
          <Icon className={isPrimary ? 'w-5 h-5' : 'w-4 h-4'} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block">
            <span className={`${isPrimary ? 'text-[15px]' : 'text-[13px]'} font-semibold`} style={{ color: isPrimary ? 'var(--text-primary)' : GUIDE_TONE }}>
              {route.title}
            </span>
            <span className="block text-[11px] mt-0.5" style={{ color: 'var(--text-dimmed)' }}>{route.subtitle}</span>
          </span>
          <span className={`${isPrimary ? 'text-[13px]' : 'text-[12px]'} block mt-1.5 leading-5`} style={{ color: 'var(--text-muted)' }}>{route.description}</span>
          {route.kind === 'birthday' && activeBirthdayDemo ? (
            <span className="block text-[11px] mt-2" style={{ color: GUIDE_TONE }}>检测到当前页面已有未完成演示，可以继续推进。</span>
          ) : null}
          {route.kind === 'self-evolve' ? (
            <span className="block text-[11px] mt-2 leading-5" style={{ color: 'var(--text-dimmed)' }}>
              {SELF_EVOLVE_DEMO_TIMESTAMP_TEXT}
            </span>
          ) : null}
        </span>
        <span
          className={`${isPrimary ? 'h-9 px-3' : 'h-8 px-2'} rounded-lg flex items-center gap-1.5 text-[12px] font-medium flex-shrink-0 mt-1 whitespace-nowrap`}
          style={{ color: GUIDE_ACTION_TEXT, background: GUIDE_TONE, border: '1px solid rgba(56, 189, 248, 0.52)' }}
        >
          <PlayCircle className="w-3.5 h-3.5" />
          {actionLabel}
        </span>
      </button>
    )
  }

  const close = () => {
    onClose({ rememberNoAuto: firstLogin ? rememberNoAuto : false, started: false })
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className={`absolute inset-0 backdrop-blur-sm ${showPrelude ? 'bg-black/95' : 'bg-black/50'}`} onClick={close} />
      <div
        className={`relative w-full overflow-hidden ${showPrelude ? 'max-w-[1180px] max-h-[calc(100vh-32px)] rounded-2xl shadow-none' : 'max-w-[720px] max-h-[86vh] rounded-xl shadow-2xl'}`}
        style={{ background: showPrelude ? 'transparent' : 'var(--modal-bg)', border: showPrelude ? '0' : '1px solid var(--border-color)' }}
      >
        {showPrelude ? (
          <GuidePrelude
            onSkip={() => {
              setErr('')
              setShowPrelude(false)
            }}
            onStartDemo={() => { void launch('birthday') }}
            starting={starting === 'birthday'}
            err={err}
          />
        ) : (
          <>
            <div className="px-5 py-4 border-b flex items-start gap-3" style={{ borderColor: 'var(--border-color)' }}>
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(56, 189, 248, 0.14)', color: '#38bdf8' }}
              >
                <CircleQuestionMark className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {firstLogin ? '欢迎使用莫比乌斯' : '莫比乌斯帮助与引导'}
                </div>
                <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  {firstLogin
                    ? '第一次建议直接创建一个演示项目。只想看页面布局时，再选择认识页面。'
                    : '第一次建议直接创建一个演示项目。已有代码、开发资料和自迭代可以稍后再看。'}
                </div>
              </div>
              <button
                type="button"
                onClick={close}
                title="关闭"
                className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[var(--bg-card-hover)] transition-colors"
                style={{ color: 'var(--text-muted)' }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto max-h-[calc(86vh-76px)]">
              <div
                className="mb-3 rounded-lg border flex items-center gap-2 px-3 py-2"
                style={{
                  borderColor: 'rgba(56, 189, 248, 0.32)',
                  background: 'rgba(56, 189, 248, 0.075)',
                }}
              >
                <BookOpen className="w-3.5 h-3.5 flex-shrink-0" style={{ color: GUIDE_TONE }} />
                <a
                  href="https://nutshellai-tech.github.io/mobius/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[12px] font-medium hover:underline"
                  style={{ color: GUIDE_TONE }}
                >
                  📖 想看更详细的使用文档？访问 mobius 文档站 →
                </a>
              </div>

              <section className="rounded-lg border overflow-hidden" style={{ borderColor: 'rgba(56, 189, 248, 0.46)', background: 'var(--bg-secondary)' }}>
                <div className="px-4 py-3 border-b" style={{ borderColor: 'rgba(56, 189, 248, 0.26)', background: 'rgba(56, 189, 248, 0.08)' }}>
                  <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>推荐：创建一个演示项目</h3>
                  <p className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-muted)' }}>
                    第一次建议从“创建演示项目”开始。你会更快看到莫比乌斯如何让智能体完成真实任务。
                  </p>
                </div>
                <div className="p-3" style={{ background: GUIDE_CONTENT_BG }}>
                  {renderRouteButton(RECOMMENDED_ROUTE, 'primary')}
                </div>
              </section>

              <section className="mt-3 rounded-lg border overflow-hidden" style={{ borderColor: 'rgba(56, 189, 248, 0.34)', background: 'var(--bg-secondary)' }}>
                <div className="px-4 py-3 border-b" style={{ borderColor: 'rgba(56, 189, 248, 0.22)' }}>
                  <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>验收：查看完成版案例</h3>
                  <p className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-muted)' }}>
                    新智能体执行需要时间。想先学会验收结果、查看拓展应用和继续追问时，可以直接看同一任务的完成版。
                  </p>
                </div>
                <div className="p-3" style={{ background: GUIDE_CONTENT_BG }}>
                  {renderRouteButton(REVIEW_ROUTE, 'secondary')}
                </div>
              </section>

              <section className="mt-3 rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
                  <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>可选帮助</h3>
                  <p className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-muted)' }}>
                    只想看页面布局、不创建内容时，再选择认识页面。
                  </p>
                </div>
                <div className="p-3" style={{ background: GUIDE_CONTENT_BG }}>
                  {renderRouteButton(OPTIONAL_HELP_ROUTE, 'secondary')}
                </div>
              </section>

              <section className="mt-3 rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                <AccordionHeader
                  title="更多路线"
                  summary="已有代码、开发资料和自迭代属于后续路线。"
                  icon={PlayCircle}
                  open={routesOpen}
                  onToggle={() => setRoutesOpen(v => !v)}
                />
                {routesOpen && (
                  <div className="space-y-2 p-3 border-t" style={{ borderColor: 'var(--border-color)', background: GUIDE_CONTENT_BG }}>
                    <div className="rounded-lg border px-3 py-2 text-[12px] leading-5" style={{ color: 'var(--text-muted)', background: 'rgba(56, 189, 248, 0.075)', borderColor: GUIDE_INTERACTIVE_BORDER }}>
                      第一次建议从“创建演示项目”开始。已有代码选导入，长期维护先配置开发资料，想改进系统本身再走自迭代。
                    </div>
                    {MORE_GUIDE_ROUTES.map(route => renderRouteButton(route, 'compact'))}
                  </div>
                )}
              </section>

              <section className="mt-3 rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                <AccordionHeader
                  title="莫比乌斯是什么"
                  summary="把真实项目、长期资料、任务目标和执行记录串起来。"
                  icon={CircleQuestionMark}
                  open={introOpen}
                  onToggle={() => setIntroOpen(v => !v)}
                />
                {introOpen && (
                  <div className="px-4 pb-4 pt-3 border-t" style={{ borderColor: 'var(--border-color)', background: GUIDE_CONTENT_BG }}>
                    <div className="space-y-3 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
                      <p>
                        莫比乌斯是面向真实项目的智能体工作台。它把代码目录、项目资料、任务目标和执行记录放在同一个工作流里。
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                          <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>能做什么</div>
                          <p className="mt-1">
                            它可以让智能体改代码、整理资料、检查结果、写说明，也可以把完成后的拓展应用打开给你验收。
                          </p>
                        </div>
                        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                          <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>和聊天的区别</div>
                          <p className="mt-1">
                            普通聊天主要回答问题；莫比乌斯会把回答落到项目文件、执行日志和可追溯的交付结果里。
                          </p>
                        </div>
                        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                          <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>为什么要存资料</div>
                          <p className="mt-1">
                            项目规则、启动命令、常用方法和安全边界可以长期保存。新的执行会话会直接带上这些背景。
                          </p>
                        </div>
                        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                          <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>什么是拓展网页</div>
                          <p className="mt-1">
                            拓展网页是运行在莫比乌斯里的小应用。完成案例会带你打开真实入口，看到交付物怎么被使用。
                          </p>
                        </div>
                      </div>
                      <p>
                        你可以把一次工作理解成：先把背景放进项目，再写清本次任务，最后让智能体执行并留下证据。
                      </p>
                    </div>
                  </div>
                )}
              </section>

              <section className="mt-3 rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                <AccordionHeader
                  title="莫比乌斯怎么组织工作"
                  summary="项目放长期背景，任务单写本次目标，执行会话负责开工和验收。"
                  icon={BookOpen}
                  open={workflowOpen}
                  onToggle={() => setWorkflowOpen(v => !v)}
                />
                {workflowOpen && (
                  <div className="border-t" style={{ borderColor: 'var(--border-color)', background: GUIDE_CONTENT_BG }}>
                    <div className="px-4 pt-3 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
                      一次工作通常分成三层。先把长期背景放进项目，再用任务单写清这次目标，最后创建执行会话让智能体真正开工。
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr] gap-2 p-3 items-stretch">
                      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                        <BookOpen className="w-4 h-4 mb-2" style={{ color: GUIDE_TONE }} />
                        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>项目</div>
                        <p className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-muted)' }}>
                          项目是一块工作空间。代码目录、背景资料、项目规则和常用方法都放在这里。
                        </p>
                        <p className="text-[12px] mt-2 leading-5" style={{ color: 'var(--text-muted)' }}>
                          适合保存会被反复使用的信息，比如启动命令、目录说明、设计约束、远程机器地址。
                        </p>
                      </div>
                      <div className="hidden md:flex items-center justify-center" style={{ color: 'var(--text-dimmed)' }}>
                        <ArrowRight className="w-4 h-4" />
                      </div>
                      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                        <CheckCircle2 className="w-4 h-4 mb-2" style={{ color: GUIDE_TONE }} />
                        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>任务单</div>
                        <p className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-muted)' }}>
                          任务单是一张工作说明。目标、限制条件、输入材料和完成标准都写在这里。
                        </p>
                        <p className="text-[12px] mt-2 leading-5" style={{ color: 'var(--text-muted)' }}>
                          好的任务单会让智能体少猜测：例如要改哪个功能、不能碰哪些文件、完成后要怎样说明结果。
                        </p>
                      </div>
                      <div className="hidden md:flex items-center justify-center" style={{ color: 'var(--text-dimmed)' }}>
                        <ArrowRight className="w-4 h-4" />
                      </div>
                      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                        <Settings2 className="w-4 h-4 mb-2" style={{ color: GUIDE_TONE }} />
                        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>执行会话</div>
                        <p className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-muted)' }}>
                          执行会话是一次实际开工。模型、带入资料、用户输入、工具调用和最终回复都留在这里。
                        </p>
                        <p className="text-[12px] mt-2 leading-5" style={{ color: 'var(--text-muted)' }}>
                          你可以用它验收结果、继续追问、要求返工，或把完整执行记录交给后来的人查看。
                        </p>
                      </div>
                    </div>
                    <div className="px-3 pb-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>资料怎么进入会话</div>
                        <p className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-muted)' }}>
                          创建执行会话前会有预览页。保持勾选的项目知识和项目方法，会固定成本次执行的资料快照。
                        </p>
                      </div>
                      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
                        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>怎样验收结果</div>
                        <p className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-muted)' }}>
                          先对照任务目标，再看最终回复、文件变化和工具记录。拓展应用还要打开真实网页确认能使用。
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {firstLogin && (
                <label className="mt-4 flex items-center gap-2 text-[12px] select-none cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={rememberNoAuto}
                    onChange={e => setRememberNoAuto(e.target.checked)}
                    className="w-4 h-4 accent-blue-500"
                  />
                  以后登录不自动弹出；需要时我会从右上角问号打开。
                </label>
              )}

              {err && (
                <div className="mt-3 rounded-lg border px-3 py-2 text-[12px]" style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.08)' }}>
                  {err}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
