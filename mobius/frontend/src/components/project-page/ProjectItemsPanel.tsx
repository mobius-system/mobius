import { ExternalLink, Settings, Wrench } from 'lucide-react'
import { IssueCard } from './IssueCard'
import { ProjectTabButton, ProjectTabList } from './ProjectTabs'
import { PrimaryActionButton } from '../primary-action-button'
import { ResearchCard } from './ResearchCard'
import { ListLoadingHint } from '../list-loading-hint'
import type { IssueConfirmAction, ProjectFilter, ProjectIssuePagination, ProjectListSection } from './types'

const EXTENSION_DEVELOPMENT_LINKS: Record<string, { label: string; href: string; description: string }> = {
  'finance-news-wall': {
    label: '继续开发金融新闻墙',
    href: '/u/alice/p/9a533442/i/baf5d4dd?session=4921f111',
    description: '打开原来的开发 Issue 和 Session，继续修改金融新闻墙代码。',
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
  issuePagination: ProjectIssuePagination
  // 切换到未缓存项目时, 列表先显示 loading 而不是闪现"暂无 Issue/Research".
  issuesLoading?: boolean
  researchesLoading?: boolean
  canCreateIssue?: boolean
  canCreateResearch?: boolean
  onSectionChange: (section: ProjectListSection) => void
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
  issuePagination,
  issuesLoading = false,
  researchesLoading = false,
  canCreateIssue = true,
  canCreateResearch = true,
  onSectionChange,
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
  const extensionName = typeof project.extension_name === 'string' ? project.extension_name : ''
  const canRunExtension = project.kind === 'extension' && !!extensionName && !project.disabled
  const extensionRunUrl = extensionName ? `/extension/${extensionName}/` : ''
  const developmentLink = extensionName ? EXTENSION_DEVELOPMENT_LINKS[extensionName] : null

  const runExtension = () => {
    if (!canRunExtension) return
    window.location.assign(extensionRunUrl)
  }

  const openDevelopmentLink = () => {
    if (!developmentLink?.href) return
    window.location.assign(developmentLink.href)
  }

  return (
    <div className="w-full lg:w-1/2" data-tour="project-items-panel">
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
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              title="项目设置"
              aria-label="项目设置"
              className="lg:hidden h-8 w-8 flex items-center justify-center rounded-lg border flex-shrink-0"
              style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
            >
              <Settings className="w-4 h-4" />
            </button>
          )}
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
        </div>
        <PrimaryActionButton onClick={() => section === 'issues' ? onCreateIssue() : onCreateResearch()}
          data-tour={section === 'issues' ? 'project-new-issue' : 'project-new-research'}
          disabled={section === 'issues' ? !canCreateIssue : (!project.research_enabled || !canCreateResearch)}
          icon={<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>}>
          {section === 'issues' ? '新建 Issue' : '新建 Research'}
        </PrimaryActionButton>
      </div>

      {section === 'issues' ? (
        <IssueList
          issues={issues}
          sessionsMap={sessionsMap}
          userParam={userParam}
          projectId={projectId}
          filter={filter}
          search={search}
          pagination={issuePagination}
          issuesLoading={issuesLoading}
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
            请先在项目设置中勾选「启用 Research 系统」
          </div>
        </div>
      ) : (
        <ResearchList
          researches={researches}
          sessionsMap={sessionsMap}
          userParam={userParam}
          projectId={projectId}
          filter={filter}
          search={search}
          researchesLoading={researchesLoading}
          canCreateResearch={canCreateResearch}
          onCreateResearch={onCreateResearch}
          onEditResearch={onEditResearch}
          onToggleResearchStatus={onToggleResearchStatus}
        />
      )}
    </div>
  )
}

type IssueListProps = {
  issues: any[]
  sessionsMap: Record<string, any[]>
  userParam: string
  projectId: string
  filter: ProjectFilter
  search: string
  pagination: ProjectIssuePagination
  issuesLoading?: boolean
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
  userParam,
  projectId,
  filter,
  search,
  pagination,
  issuesLoading = false,
  canCreateIssue,
  onCreateIssue,
  onCreatePlanningIssue,
  onEditIssue,
  onIssueConfirm,
  onToggleIssueStar,
}: IssueListProps) {
  if (issues.length === 0) {
    // 切换项目首次拉取 issue 列表时, 不要直接渲染"暂无 Issue"空态, 先显示 loading.
    if (issuesLoading) {
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
          {search.trim() || filter !== 'all' ? '没有匹配的 Issue' : '暂无 Issue'}
        </div>
        <div className="flex items-center justify-center gap-2 flex-wrap">
          <button onClick={onCreateIssue} disabled={!canCreateIssue} data-tour="project-empty-create-issue"
            className="h-9 px-4 rounded-lg text-[13px] text-blue-400 bg-blue-500/10 hover:bg-blue-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            创建第一个 Issue
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

  const showPagination = pagination.totalItems > pagination.pageSize

  return (
    <div className="space-y-3">
      {showPagination && <IssuePaginationControls pagination={pagination} />}
      <div className="grid grid-cols-1 gap-4">
        {issues.map((issue: any) => (
          <IssueCard
            key={issue.id}
            issue={issue}
            sessions={sessionsMap[issue.id] || []}
            userParam={userParam}
            projectId={projectId}
            onEdit={onEditIssue}
            onConfirm={onIssueConfirm}
            onToggleStar={onToggleIssueStar}
          />
        ))}
      </div>
      {showPagination && <IssuePaginationControls pagination={pagination} compact />}
    </div>
  )
}

type IssuePaginationControlsProps = {
  pagination: ProjectIssuePagination
  compact?: boolean
}

function IssuePaginationControls({ pagination, compact = false }: IssuePaginationControlsProps) {
  const pageStart = pagination.totalItems === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1
  const pageEnd = Math.min(pagination.page * pagination.pageSize, pagination.totalItems)
  const goToPage = (page: number) => pagination.onPageChange(Math.min(Math.max(page, 1), pagination.totalPages))

  return (
    <div className={`flex items-center justify-between gap-3 ${compact ? 'pt-1' : ''}`}>
      <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
        显示 {pageStart}-{pageEnd} / {pagination.totalItems} 个 Issue · 第 {pagination.page} / {pagination.totalPages} 页
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => goToPage(pagination.page - 1)}
          disabled={pagination.page <= 1}
          className="h-8 sm:h-7 px-2.5 rounded-md border text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
        >
          上一页
        </button>
        <button
          type="button"
          onClick={() => goToPage(pagination.page + 1)}
          disabled={pagination.page >= pagination.totalPages}
          className="h-8 sm:h-7 px-2.5 rounded-md border text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
        >
          下一页
        </button>
      </div>
    </div>
  )
}

type ResearchListProps = {
  researches: any[]
  sessionsMap: Record<string, any[]>
  userParam: string
  projectId: string
  filter: ProjectFilter
  search: string
  researchesLoading?: boolean
  canCreateResearch: boolean
  onCreateResearch: () => void
  onEditResearch: (research: any) => void
  onToggleResearchStatus: (research: any, status: 'active' | 'completed') => void
}

function ResearchList({
  researches,
  sessionsMap,
  userParam,
  projectId,
  filter,
  search,
  researchesLoading = false,
  canCreateResearch,
  onCreateResearch,
  onEditResearch,
  onToggleResearchStatus,
}: ResearchListProps) {
  if (researches.length === 0) {
    // 切换项目首次拉取 research 列表时, 不要直接渲染"暂无 Research"空态, 先显示 loading.
    if (researchesLoading) {
      return (
        <div className="rounded-2xl border-dashed border-2 p-10 text-center" style={{ borderColor: 'var(--border-color)' }}>
          <ListLoadingHint />
        </div>
      )
    }
    return (
      <div className="rounded-2xl border-dashed border-2 p-10 text-center" style={{ borderColor: 'var(--border-color)' }}>
        <div className="text-[13px] mb-3" style={{ color: 'var(--text-muted)' }}>
          {search.trim() || filter !== 'all' ? '没有匹配的 Research' : '暂无 Research'}
        </div>
        <button onClick={onCreateResearch} disabled={!canCreateResearch}
          className="h-9 px-4 rounded-lg text-[13px] text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
          创建第一个 Research
        </button>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      {researches.map((research: any) => (
        <ResearchCard
          key={research.id}
          research={research}
          sessions={sessionsMap[research.id] || []}
          userParam={userParam}
          projectId={projectId}
          onEdit={onEditResearch}
          onToggleStatus={onToggleResearchStatus}
        />
      ))}
    </div>
  )
}
