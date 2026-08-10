import { useEffect, useRef } from 'react'
import { ExternalLink, LayoutList, Rows3, Settings, Wrench } from 'lucide-react'
import { IssueCard } from './IssueCard'
import { ProjectTabButton, ProjectTabList } from './ProjectTabs'
import { PrimaryActionButton } from '../primary-action-button'
import { ResearchCard } from './ResearchCard'
import { ListLoadingHint } from '../list-loading-hint'
import type { IssueConfirmAction, ProjectCardDensity, ProjectFilter, ProjectIssuePagination, ProjectListSection } from './types'
import type { ProjectSessionMatchMap } from '../../services/project-session-search'

const EXTENSION_DEVELOPMENT_LINKS: Record<string, { label: string; href: string; description: string }> = {
  'finance-news-wall': {
    label: '继续开发金融新闻墙',
    href: '/u/alice/p/9a533442/i/baf5d4dd?session=4921f111',
    description: '打开原来的开发任务和会话，继续修改金融新闻墙代码。',
  },
}

type ProjectItemsPanelProps = {
  project: any
  userParam: string
  projectId: string
  section: ProjectListSection
  filter: ProjectFilter
  search: string
  issues: any[]
  researches: any[]
  sessionsMap: Record<string, any[]>
  sessionMatchesByIssue: ProjectSessionMatchMap
  sessionMatchesByResearch: ProjectSessionMatchMap
  sessionSearchLoading?: boolean
  issuePagination: ProjectIssuePagination
  researchPagination: ProjectIssuePagination
  density: ProjectCardDensity
  desktopWorkspace?: boolean
  scrollResetKey: string
  // 切换到未缓存项目时, 列表先显示 loading 而不是闪现"暂无 Issue/Research".
  issuesLoading?: boolean
  researchesLoading?: boolean
  canCreateIssue?: boolean
  canCreateResearch?: boolean
  onSectionChange: (section: ProjectListSection) => void
  onDensityChange: (density: ProjectCardDensity) => void
  onCreateIssue: () => void
  onCreatePlanningIssue?: () => void
  onCreateResearch: () => void
  onEditIssue: (issue: any) => void
  onEditResearch: (research: any) => void
  onIssueConfirm: (action: IssueConfirmAction) => void
  onToggleResearchStatus: (research: any, status: 'active' | 'completed') => void
  onToggleIssueStar: (issue: any) => void
  onOpenSettings?: () => void
}

export function ProjectItemsPanel({
  project,
  userParam,
  projectId,
  section,
  filter,
  search,
  issues,
  researches,
  sessionsMap,
  sessionMatchesByIssue,
  sessionMatchesByResearch,
  sessionSearchLoading = false,
  issuePagination,
  researchPagination,
  density,
  desktopWorkspace = false,
  scrollResetKey,
  issuesLoading = false,
  researchesLoading = false,
  canCreateIssue = true,
  canCreateResearch = true,
  onSectionChange,
  onDensityChange,
  onCreateIssue,
  onCreatePlanningIssue,
  onCreateResearch,
  onEditIssue,
  onEditResearch,
  onIssueConfirm,
  onToggleResearchStatus,
  onToggleIssueStar,
  onOpenSettings,
}: ProjectItemsPanelProps) {
  const listScrollRef = useRef<HTMLDivElement>(null)
  const extensionName = typeof project.extension_name === 'string' ? project.extension_name : ''
  const canRunExtension = project.kind === 'extension' && !!extensionName && !project.disabled
  const extensionRunUrl = extensionName ? `/extension/${extensionName}/` : ''
  const developmentLink = extensionName ? EXTENSION_DEVELOPMENT_LINKS[extensionName] : null
  const compact = density === 'compact'
  const activePagination = section === 'issues' ? issuePagination : researchPagination
  const showPagination = activePagination.totalItems > activePagination.pageSize

  useEffect(() => {
    if (!desktopWorkspace) return
    listScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [desktopWorkspace, scrollResetKey])

  const runExtension = () => {
    if (!canRunExtension) return
    window.location.assign(extensionRunUrl)
  }

  const openDevelopmentLink = () => {
    if (!developmentLink?.href) return
    window.location.assign(developmentLink.href)
  }

  return (
    <div
      className={`w-full min-w-0 ${desktopWorkspace ? 'h-full min-h-0 flex flex-1 flex-col overflow-hidden' : ''}`}
      data-tour="project-items-panel">
      {project.kind === 'extension' && (
        <div
          data-tour="project-extension-entry"
          className="mb-3 rounded-xl border p-4"
          style={{ borderColor: 'rgba(99,102,241,0.28)', background: 'rgba(99,102,241,0.07)' }}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                拓展应用入口
              </div>
              <div className="mt-1 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
                打开应用用于使用这个拓展；继续开发代码请进入原来的开发 Issue。
              </div>
              {developmentLink && (
                <div className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>
                  {developmentLink.description}
                </div>
              )}
            </div>
            <div className="flex flex-shrink-0 flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={runExtension}
                disabled={!canRunExtension}
                data-tour="project-extension-open"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                style={{ color: '#c4b5fd', borderColor: 'rgba(167,139,250,0.34)', background: 'rgba(167,139,250,0.12)' }}
                title={canRunExtension ? `打开 ${project.name}` : '拓展目录已删除或入口不可用'}
              >
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} />
                打开应用
              </button>
              {developmentLink && (
                <button
                  type="button"
                  onClick={openDevelopmentLink}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-blue-500/25 bg-blue-500/15 px-3 text-[12px] font-medium text-blue-400 transition-colors hover:bg-blue-500/25"
                  title={developmentLink.description}
                >
                  <Wrench className="h-3.5 w-3.5" strokeWidth={1.8} />
                  {developmentLink.label}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      <div
        className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 mb-3"
        style={{ background: 'var(--bg-secondary)' }}>
        <div className="flex items-center gap-2 min-w-0">
          {onOpenSettings && !desktopWorkspace && (
            <button
              type="button"
              onClick={onOpenSettings}
              title="项目设置"
              aria-label="项目设置"
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border"
              style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
          {/* 桌面端: Issue/Research 这组 section tab 已外移到 ProjectPage 左侧边栏, 这里不再渲染. */}
          {!desktopWorkspace && (
            <ProjectTabList>
              <ProjectTabButton active={section === 'issues'} onClick={() => onSectionChange('issues')} data-tour="project-issue-tab">
                Issue
              </ProjectTabButton>
              <ProjectTabButton
                active={section === 'researches'}
                activeClassName="bg-emerald-500/15 text-emerald-400"
                onClick={() => onSectionChange('researches')}
                disabled={!project.research_enabled}
              >
                Research
              </ProjectTabButton>
              {project.kind === 'extension' && (
                <ProjectTabButton
                  onClick={runExtension}
                  disabled={!canRunExtension}
                  title={canRunExtension ? `运行 ${project.name}` : '拓展目录已删除或入口不可用'}
                  inactiveColor={canRunExtension ? '#a78bfa' : 'var(--text-muted)'}
                >
                  打开应用
                </ProjectTabButton>
              )}
            </ProjectTabList>
          )}
          {showPagination && (
            <ProjectPaginationControls pagination={activePagination} itemLabel={section === 'issues' ? '任务' : '研究'} />
          )}
        </div>
        <div className="flex items-center gap-2">
          <div
            className="flex h-8 items-center rounded-md border p-0.5"
            style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}
            role="group"
            aria-label="卡片显示密度">
            <button
              type="button"
              onClick={() => onDensityChange('compact')}
              aria-pressed={compact}
              title="精简显示"
              className="inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors"
              style={{ color: compact ? '#60a5fa' : 'var(--text-muted)', background: compact ? 'rgba(59,130,246,0.12)' : 'transparent' }}>
              <Rows3 className="h-3.5 w-3.5" strokeWidth={1.8} />
              精简
            </button>
            <button
              type="button"
              onClick={() => onDensityChange('detailed')}
              aria-pressed={!compact}
              title="详情显示"
              className="inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors"
              style={{ color: !compact ? '#60a5fa' : 'var(--text-muted)', background: !compact ? 'rgba(59,130,246,0.12)' : 'transparent' }}>
              <LayoutList className="h-3.5 w-3.5" strokeWidth={1.8} />
              详情
            </button>
          </div>
          <PrimaryActionButton onClick={() => section === 'issues' ? onCreateIssue() : onCreateResearch()}
            data-tour={section === 'issues' ? 'project-new-issue' : 'project-new-research'}
            disabled={section === 'issues' ? !canCreateIssue : (!project.research_enabled || !canCreateResearch)}
            icon={<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>}>
            {section === 'issues' ? '新建任务' : '新建研究'}
          </PrimaryActionButton>
        </div>
      </div>

      <div
        ref={listScrollRef}
        className={desktopWorkspace ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 pb-6' : ''}>

      {section === 'issues' ? (
        <IssueList
          issues={issues}
          sessionsMap={sessionsMap}
          sessionMatchesByIssue={sessionMatchesByIssue}
          userParam={userParam}
          projectId={projectId}
          filter={filter}
          search={search}
          pagination={issuePagination}
          compact={compact}
          issuesLoading={issuesLoading}
          sessionSearchLoading={sessionSearchLoading}
          canCreateIssue={canCreateIssue}
          onCreateIssue={onCreateIssue}
          onCreatePlanningIssue={onCreatePlanningIssue}
          onEditIssue={onEditIssue}
          onIssueConfirm={onIssueConfirm}
          onToggleIssueStar={onToggleIssueStar}
        />
      ) : !project.research_enabled ? (
        <div className="rounded-2xl border-dashed border-2 p-10 text-center" style={{ borderColor: 'var(--border-color)' }}>
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            请先在项目设置中勾选「启用研究系统」
          </div>
        </div>
      ) : (
        <ResearchList
          researches={researches}
          sessionsMap={sessionsMap}
          sessionMatchesByResearch={sessionMatchesByResearch}
          userParam={userParam}
          projectId={projectId}
          filter={filter}
          search={search}
          researchesLoading={researchesLoading}
          sessionSearchLoading={sessionSearchLoading}
          pagination={researchPagination}
          compact={compact}
          canCreateResearch={canCreateResearch}
          onCreateResearch={onCreateResearch}
          onEditResearch={onEditResearch}
          onToggleResearchStatus={onToggleResearchStatus}
        />
      )}
      </div>
    </div>
  )
}

type IssueListProps = {
  issues: any[]
  sessionsMap: Record<string, any[]>
  sessionMatchesByIssue: ProjectSessionMatchMap
  userParam: string
  projectId: string
  filter: ProjectFilter
  search: string
  pagination: ProjectIssuePagination
  compact: boolean
  issuesLoading?: boolean
  sessionSearchLoading?: boolean
  canCreateIssue: boolean
  onCreateIssue: () => void
  onCreatePlanningIssue?: () => void
  onEditIssue: (issue: any) => void
  onIssueConfirm: (action: IssueConfirmAction) => void
  onToggleIssueStar: (issue: any) => void
}

function IssueList({
  issues,
  sessionsMap,
  sessionMatchesByIssue,
  userParam,
  projectId,
  filter,
  search,
  pagination,
  compact,
  issuesLoading = false,
  sessionSearchLoading = false,
  canCreateIssue,
  onCreateIssue,
  onCreatePlanningIssue,
  onEditIssue,
  onIssueConfirm,
  onToggleIssueStar,
}: IssueListProps) {
  if (issues.length === 0) {
    // 切换项目首次拉取 issue 列表时, 不要直接渲染"暂无 Issue"空态, 先显示 loading.
    if (issuesLoading || (sessionSearchLoading && !!search.trim())) {
      return (
        <div className="rounded-2xl border-dashed border-2 p-10 text-center" style={{ borderColor: 'var(--border-color)' }}>
          <ListLoadingHint />
        </div>
      )
    }
    const showQuickPlanning = !search.trim() && filter === 'all' && !!onCreatePlanningIssue
    return (
      <div className="rounded-2xl border-dashed border-2 p-10 text-center" style={{ borderColor: 'var(--border-color)' }}>
        <div className="text-[13px] mb-3" style={{ color: 'var(--text-muted)' }}>
          {search.trim() || filter !== 'all' ? '没有匹配的任务或会话' : '暂无任务'}
        </div>
        <div className="flex items-center justify-center gap-2 flex-wrap">
          <button onClick={onCreateIssue} disabled={!canCreateIssue} data-tour="project-empty-create-issue"
            className="h-9 px-4 rounded-lg text-[13px] text-blue-400 bg-blue-500/10 hover:bg-blue-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            创建第一个任务
          </button>
          {showQuickPlanning && (
            <button onClick={onCreatePlanningIssue} disabled={!canCreateIssue}
              className="h-9 px-4 rounded-lg text-[13px] text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              创建交互式系统宏观规划
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className={`grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 ${compact ? 'gap-2' : 'gap-3'}`}>
        {issues.map((issue: any) => (
          <IssueCard
            key={issue.id}
            issue={issue}
            sessions={sessionsMap[issue.id] || []}
            searchMatches={sessionMatchesByIssue[issue.id] || []}
            searchQuery={search}
            userParam={userParam}
            projectId={projectId}
            compact={compact}
            onEdit={onEditIssue}
            onConfirm={onIssueConfirm}
            onToggleStar={onToggleIssueStar}
          />
        ))}
      </div>
      {pagination.totalItems > pagination.pageSize && <ProjectPaginationControls pagination={pagination} compact itemLabel="任务" />}
    </div>
  )
}

type ProjectPaginationControlsProps = {
  pagination: ProjectIssuePagination
  compact?: boolean
  itemLabel: string
}

function ProjectPaginationControls({ pagination, compact = false, itemLabel }: ProjectPaginationControlsProps) {
  const pageStart = pagination.totalItems === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1
  const pageEnd = Math.min(pagination.page * pagination.pageSize, pagination.totalItems)
  const goToPage = (page: number) => pagination.onPageChange(Math.min(Math.max(page, 1), pagination.totalPages))

  // 上一页/下一页作为文字按钮内联到页码信息后 (与通用 PaginationControls 的 inlinePageSwitch 同款).
  const inlineButtonClass = 'align-baseline text-[11px] transition-colors hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-[var(--text-muted)]'

  return (
    <div className={`flex items-center gap-1.5 text-[11px] tabular-nums flex-wrap ${compact ? 'pt-1' : ''}`} style={{ color: 'var(--text-muted)' }}>
      <span>显示 {pageStart}-{pageEnd} / {pagination.totalItems} 个{itemLabel}</span>
      <span>·</span>
      <span>第 {pagination.page} / {pagination.totalPages} 页</span>
      <span>·</span>
      <button
        type="button"
        onClick={() => goToPage(pagination.page - 1)}
        disabled={pagination.page <= 1}
        className={inlineButtonClass}
      >
        上一页
      </button>
      <span>·</span>
      <button
        type="button"
        onClick={() => goToPage(pagination.page + 1)}
        disabled={pagination.page >= pagination.totalPages}
        className={inlineButtonClass}
      >
        下一页
      </button>
    </div>
  )
}

type ResearchListProps = {
  researches: any[]
  sessionsMap: Record<string, any[]>
  sessionMatchesByResearch: ProjectSessionMatchMap
  userParam: string
  projectId: string
  filter: ProjectFilter
  search: string
  researchesLoading?: boolean
  sessionSearchLoading?: boolean
  pagination: ProjectIssuePagination
  compact: boolean
  canCreateResearch: boolean
  onCreateResearch: () => void
  onEditResearch: (research: any) => void
  onToggleResearchStatus: (research: any, status: 'active' | 'completed') => void
}

function ResearchList({
  researches,
  sessionsMap,
  sessionMatchesByResearch,
  userParam,
  projectId,
  filter,
  search,
  researchesLoading = false,
  sessionSearchLoading = false,
  pagination,
  compact,
  canCreateResearch,
  onCreateResearch,
  onEditResearch,
  onToggleResearchStatus,
}: ResearchListProps) {
  if (researches.length === 0) {
    // 切换项目首次拉取 research 列表时, 不要直接渲染"暂无 Research"空态, 先显示 loading.
    if (researchesLoading || (sessionSearchLoading && !!search.trim())) {
      return (
        <div className="rounded-2xl border-dashed border-2 p-10 text-center" style={{ borderColor: 'var(--border-color)' }}>
          <ListLoadingHint />
        </div>
      )
    }
    return (
      <div className="rounded-2xl border-dashed border-2 p-10 text-center" style={{ borderColor: 'var(--border-color)' }}>
        <div className="text-[13px] mb-3" style={{ color: 'var(--text-muted)' }}>
          {search.trim() || filter !== 'all' ? '没有匹配的研究或智能体' : '暂无研究'}
        </div>
        <button onClick={onCreateResearch} disabled={!canCreateResearch}
          className="h-9 px-4 rounded-lg text-[13px] text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
          创建第一个研究
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className={`grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 ${compact ? 'gap-2' : 'gap-3'}`}>
      {researches.map((research: any) => (
        <ResearchCard
          key={research.id}
          research={research}
          sessions={sessionsMap[research.id] || []}
          searchMatches={sessionMatchesByResearch[research.id] || []}
          searchQuery={search}
          userParam={userParam}
          projectId={projectId}
          compact={compact}
          onEdit={onEditResearch}
          onToggleStatus={onToggleResearchStatus}
        />
      ))}
      </div>
      {pagination.totalItems > pagination.pageSize && <ProjectPaginationControls pagination={pagination} compact itemLabel="研究" />}
    </div>
  )
}
