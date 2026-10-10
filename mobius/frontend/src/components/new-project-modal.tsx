// =====================================================================
// 新建项目弹窗 (NewProjectModal) — 全局唯一的新建项目实现
//
// 从 modals.tsx 抽出为独立文件, 并吸收原 global-create.tsx「新建项目」表单的
// 压缩包导入能力: 项目名可留空由压缩包文件名推断, 创建后自动解压 + git init.
// =====================================================================
import { Suspense, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Dices, Eye, FlaskConical, FolderOpen, FolderPlus, Puzzle, Upload } from 'lucide-react'
import { api, useStore } from '../store'
import { draftClear, draftLoad, draftSave } from '../services/input-drafts'
import { randomProjectBindPath } from '../services/session-naming'
import { lazyWithRetry } from '../services/handle-stale-chunk'
import { formatFileSize } from './attachments'
import { ErrBanner } from './error-banner'
import { ExpandableTextarea } from './expandable-textarea'
import { ProjectMemberInvite, type MemberInput } from './project-member-invite'
import { ToggleSwitch } from './toggle-switch'

// 路径选择弹窗只在点"选择路径"时出现, 按需加载: 静态 import 会把整个 modals 模块(连同
// markdown 渲染栈)拖进引用本文件的页面.
// The path picker loads on demand; a static import would drag the whole modals module along.
const PathPickerModal = lazyWithRetry(() => import('./modals').then(module => ({ default: module.PathPickerModal })))

type ProjectVisibility = 'private' | 'public'
const PROJECT_VISIBILITY_OPTIONS: Array<{ value: ProjectVisibility; label: string; description: string }> = [
  { value: 'private', label: '私有', description: '只有项目成员（含创建者）能看到本项目。' },
  { value: 'public', label: '公开', description: '所有登录用户都能看到本项目；仅项目成员可写。' },
]

type NewProjectKind = 'default' | 'research' | 'extension'
const NEW_PROJECT_KIND_LABELS: Record<NewProjectKind, string> = {
  default: '经典项目',
  research: '研究项目',
  extension: '莫比乌斯拓展项目',
}

// 三张项目类型卡片的悬浮强调色, 各自对齐图标颜色以便一眼区分
// Per-kind hover accent for the three project-kind cards, matching each icon color
const PROJECT_KIND_HOVER: Record<NewProjectKind, string> = {
  default: 'hover:border-blue-500/45 hover:bg-blue-500/10',
  research: 'hover:border-emerald-500/45 hover:bg-emerald-500/10',
  extension: 'hover:border-violet-500/45 hover:bg-violet-500/10',
}

// 长路径中间省略, 保留首尾便于识别
// Middle-ellipsize a long path, keeping both ends readable
function middleEllipsisPath(value: string, maxLength = 64) {
  const text = String(value || '')
  if (text.length <= maxLength) return text
  const available = Math.max(8, maxLength - 3)
  const headLength = Math.max(4, Math.floor(available * 0.45))
  const tailLength = Math.max(4, available - headLength)
  return `${text.slice(0, headLength)}...${text.slice(-tailLength)}`
}

export function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (p: any) => void }) {
  const DRAFT_KEY = 'new-project'
  const { theme, user } = useStore()
  const initialDraft = draftLoad<{
    name?: string
    desc?: string
    bindPath?: string
    bindPathManual?: boolean
    defaultUseWorktree?: boolean
    researchEnabled?: boolean
    visibility?: ProjectVisibility
    projectKind?: NewProjectKind
    extensionName?: string
    canPostIssue?: boolean
    canRunSession?: boolean
    inviteMembers?: MemberInput[]
  }>(DRAFT_KEY)
  const [name, setName] = useState(initialDraft?.name || '')
  const [desc, setDesc] = useState(initialDraft?.desc || '')
  const initialBindPathFromDraft = initialDraft?.bindPath?.trim() ? (initialDraft.bindPath || '') : ''
  const [bindPath, setBindPath] = useState(initialBindPathFromDraft || randomProjectBindPath(user?.work_dir))
  const [bindPathSource, setBindPathSource] = useState<'auto' | 'custom'>(initialBindPathFromDraft ? 'custom' : 'auto')
  const [bindPathManual, setBindPathManual] = useState(!!initialDraft?.bindPathManual)
  const [defaultUseWorktree, setDefaultUseWorktree] = useState(typeof initialDraft?.defaultUseWorktree === 'boolean' ? initialDraft.defaultUseWorktree : false)
  const [researchEnabled, setResearchEnabled] = useState(!!initialDraft?.researchEnabled)
  const [visibility, setVisibility] = useState<ProjectVisibility>(
    initialDraft?.visibility === 'public'
      ? initialDraft.visibility
      : 'private'
  )
  const [inviteMembers, setInviteMembers] = useState<MemberInput[]>(
    Array.isArray(initialDraft?.inviteMembers) ? initialDraft.inviteMembers.filter((m) => m && m.user_id) : []
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  // 代码压缩包: 选填, 创建项目后自动解压到绑定路径 + git init (压缩包不写草稿, File 无法序列化)
  // Optional code archive: extracted into the bind path right after creation (never drafted)
  const [archiveFile, setArchiveFile] = useState<File | null>(null)
  const archiveInputRef = useRef<HTMLInputElement>(null)
  const initialKind = initialDraft?.projectKind === 'research' || initialDraft?.projectKind === 'extension' ? initialDraft.projectKind : 'default'
  const canCreateExtensionProject = user?.role === 'admin'
  const initialProjectKind: NewProjectKind = canCreateExtensionProject || initialKind !== 'extension' ? initialKind : 'default'
  const initialDraftHasContent = !!(
    initialDraft?.name?.trim()
    || initialDraft?.desc?.trim()
    || initialDraft?.bindPath?.trim()
    || initialDraft?.extensionName?.trim()
  )
  const [projectKind, setProjectKind] = useState<NewProjectKind>(initialProjectKind)
  const [step, setStep] = useState<'type' | 'details'>(initialDraftHasContent ? 'details' : 'type')
  const [extensionName, setExtensionName] = useState(initialDraft?.extensionName || '')
  // v3 写权限: 默认关闭, 与后端 schema 默认一致; private 项目这两个开关无效, 但允许 owner 主动打开.
  const [canPostIssue, setCanPostIssue] = useState<boolean>(!!initialDraft?.canPostIssue)
  const [canRunSession, setCanRunSession] = useState<boolean>(!!initialDraft?.canRunSession)

  useEffect(() => {
    if (projectKind === 'extension' || bindPathSource !== 'auto') return
    if (bindPath.trim() || !user?.work_dir) return
    setBindPath(randomProjectBindPath(user.work_dir))
    setBindPathManual(false)
  }, [bindPath, bindPathSource, projectKind, user?.work_dir])

  useEffect(() => {
    const hasDraftContent = !!(name.trim() || desc.trim() || extensionName.trim() || (bindPath.trim() && bindPathSource === 'custom'))
    if (hasDraftContent) {
      draftSave(DRAFT_KEY, { name, desc, bindPath, bindPathManual, defaultUseWorktree, researchEnabled, visibility, inviteMembers, projectKind, extensionName, canPostIssue, canRunSession }, { minChars: 0 })
    } else {
      draftClear(DRAFT_KEY)
    }
  }, [name, desc, bindPath, bindPathSource, bindPathManual, defaultUseWorktree, researchEnabled, visibility, inviteMembers, projectKind, extensionName, canPostIssue, canRunSession])

  const refreshRandomBindPath = () => {
    let next = randomProjectBindPath(user?.work_dir)
    if (!next) {
      setErr('当前用户尚未配置工作目录，无法生成随机绑定路径')
      return
    }
    for (let i = 0; i < 5 && next === bindPath; i += 1) next = randomProjectBindPath(user?.work_dir)
    setBindPath(next)
    setBindPathManual(false)
    setBindPathSource('auto')
    setErr('')
  }

  const chooseProjectKind = (kind: NewProjectKind) => {
    if (kind === 'extension' && !canCreateExtensionProject) return
    setProjectKind(kind)
    setErr('')
    if (kind === 'default') {
      setResearchEnabled(false)
      setDefaultUseWorktree(false)
      setExtensionName('')
    } else if (kind === 'research') {
      setResearchEnabled(true)
      setDefaultUseWorktree(false)
      setExtensionName('')
    }
    setStep('details')
  }

  const submit = async () => {
    // 项目名留空时, 若上传了压缩包则用压缩包文件名推断
    // Fall back to the archive file name when the project name is empty
    const inferredName = archiveFile
      ? archiveFile.name.replace(/\.(zip|tar\.gz|tgz|tar\.bz2|tar\.xz|tar|gz|bz2|xz)$/i, '').replace(/[._\s]+$/, '').trim()
      : ''
    const finalName = name.trim() || inferredName
    if (projectKind === 'extension') {
      if (!canCreateExtensionProject) { setErr('只有管理员可以创建莫比乌斯拓展项目'); return }
      if (!extensionName.trim()) { setErr('请输入拓展标识名'); return }
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(extensionName.trim())) { setErr('拓展标识名格式：以小写字母开头，可包含小写字母、数字和连字符，1-32字符'); return }
    } else {
      if (!finalName) { setErr('请输入项目名称, 或上传压缩包以自动命名'); return }
      if (!bindPath.trim()) { setErr('请选择项目绑定路径 (必填)'); return }
    }
    setLoading(true); setErr('')
    try {
      const effectiveWt = researchEnabled ? false : defaultUseWorktree
      const body: any = {
        name: projectKind === 'extension' ? name.trim() : finalName,
        description: desc,
        visibility,
      }
      if (projectKind === 'extension') {
        body.kind = 'extension'
        body.extensionName = extensionName.trim()
      } else {
        body.can_post_issue = canPostIssue
        body.can_run_session = canRunSession
        body.bindPath = bindPath
        body.bindPathManual = bindPathManual
        body.defaultUseWorktree = effectiveWt
        body.researchEnabled = projectKind === 'research' ? true : researchEnabled
        // 首批项目成员 (带角色; 排除创建者本人, 他自动成为项目所有者).
        body.members = inviteMembers.filter(m => m.user_id && m.user_id !== user?.id)
      }
      const p = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if ((p as any)?.error) { setErr((p as any).error); return }
      // 上传了压缩包: 解压到刚建好的空项目目录 (零冲突, 后端自动 git init)
      // Uploaded archive: extracted into the freshly created empty project dir
      if (archiveFile && (p as any)?.id) {
        try {
          const fd = new FormData()
          fd.append('file', archiveFile, archiveFile.name)
          await api(`/api/projects/${(p as any).id}/import-zip`, { method: 'POST', body: fd })
        } catch (e: any) {
          draftClear(DRAFT_KEY)
          setErr(`项目「${finalName}」已创建, 但代码导入失败: ${e?.message || '未知错误'}。可关闭后进入该项目, 用「项目文件」的「上传 ZIP」重传。`)
          return
        }
      }
      draftClear(DRAFT_KEY)
      onCreated({ ...p, name: projectKind === 'extension' ? name.trim() : finalName })
    } catch (e: any) { setErr(e?.message || '创建失败') } finally { setLoading(false) }
  }

  const visibilityOption = PROJECT_VISIBILITY_OPTIONS.find(option => option.value === visibility) || PROJECT_VISIBILITY_OPTIONS[0]
  const writablePermissions = Number(!!canPostIssue) + Number(!!canRunSession)
  const permissionDetail = projectKind === 'extension'
    ? '拓展项目仅设置可见范围'
    : visibility === 'private'
      ? '仅创建者可写'
      : writablePermissions === 2
        ? '读者可建任务单和执行会话'
        : canPostIssue
          ? '读者可建任务单'
          : canRunSession
            ? '读者可执行会话'
            : '读者不可写'
  const bindPathDisplay = middleEllipsisPath(bindPath, 70)

  const visibilityControl = (
    <div>
      <label className="block text-[length:var(--fs-sm)] mb-1" style={{ color: 'var(--text-muted)' }}>项目可见性</label>
      <div className="grid grid-cols-2 gap-1.5">
        {PROJECT_VISIBILITY_OPTIONS.map((option) => {
          const active = visibility === option.value
          return (
            <button key={option.value} type="button" onClick={() => setVisibility(option.value)}
              title={option.description}
              className="h-8 rounded-lg border text-[length:var(--fs-md)] transition-colors"
              style={active
                ? { background: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.48)', color: '#60a5fa' }
                : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
              {option.label}
            </button>
          )
        })}
      </div>
      <p className="text-[length:var(--fs-sm)] mt-1" style={{ color: 'var(--text-muted)' }}>
        {visibilityOption.description}
      </p>
      {projectKind === 'extension' ? (
        <p className="text-[length:var(--fs-sm)] mt-2" style={{ color: 'var(--text-muted)' }}>
          拓展项目的写权限由系统管理；这里仅设置谁能看到这个项目。
        </p>
      ) : (
        <div className="mt-2 space-y-1.5">
          <ToggleSwitch
            checked={canPostIssue}
            onChange={v => { setCanPostIssue(v); setErr('') }}
            className="flex items-center gap-3 text-[length:var(--fs-md)]"
            style={{ color: 'var(--text-secondary)' }}>
            读者可创建任务单 (private 永远只允许 owner, 不受此开关影响)
          </ToggleSwitch>
          <ToggleSwitch
            checked={canRunSession}
            onChange={v => { setCanRunSession(v); setErr('') }}
            className="flex items-center gap-3 text-[length:var(--fs-md)]"
            style={{ color: 'var(--text-secondary)' }}>
            读者可启动执行会话 (同上, private 永远只允许 owner)
          </ToggleSwitch>
        </div>
      )}
    </div>
  )

  const permissionSettingsModal = permissionOpen ? (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={() => setPermissionOpen(false)} />
      <div className="relative w-[420px] max-w-[calc(100vw-32px)] rounded-2xl p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h4 className="text-[length:var(--fs-2xl)] font-semibold mb-1" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>修改项目权限</h4>
        <p className="mb-4 text-[length:var(--fs-md)]" style={{ color: 'var(--text-muted)' }}>添加项目成员（谁能看到 / 使用本项目，由成员列表决定）。</p>
        <div className="mt-3">
          <ProjectMemberInvite
            value={inviteMembers}
            onChange={setInviteMembers}
            currentUserId={user?.id}
            extensionProject={projectKind === 'extension'}
          />
        </div>
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={() => setPermissionOpen(false)}
            className="flex-1 h-9 rounded-xl text-[length:var(--fs-lg)] btn-primary transition-colors">
            完成
          </button>
        </div>
      </div>
    </div>
  ) : null

  const projectKindOptions: Array<{
    kind: NewProjectKind
    label: string
    description: string
    note: string
    icon: React.ReactNode
  }> = [
    {
      kind: 'default',
      label: '经典项目（推荐）',
      description: '导入或新建一个项目，后续可以随时转化为研究项目。',
      note: '默认不启动研究系统',
      icon: <FolderPlus className="h-5 w-5" strokeWidth={1.8} />,
    },
    {
      kind: 'research',
      label: '研究项目',
      description: '通过多智能体协作完成需要持续整夜甚至数周的开放研究任务。',
      note: '自动启用研究，并禁用 git worktree',
      icon: <FlaskConical className="h-5 w-5" strokeWidth={1.8} />,
    },
    {
      kind: 'extension',
      label: '莫比乌斯拓展项目',
      description: '创建一个有漂亮前端+后端的拓展项目，满足您的任何需求。',
    note: canCreateExtensionProject ? '能直接在本系统主页打开的特殊拓展项目，内嵌到本系统之中' : '仅管理员可创建',
      icon: <Puzzle className="h-5 w-5" strokeWidth={1.8} />,
    },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div data-tour="project-modal" className="relative w-[575px] max-w-[calc(100vw-32px)] rounded-2xl p-6 shadow-2xl" style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        {step === 'type' ? (
          <>
            <h3 className="text-[length:var(--fs-2xl)] font-semibold mb-1" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>选择项目类型</h3>
            <p className="mb-4 text-[length:var(--fs-md)]" style={{ color: 'var(--text-muted)' }}>先选择本次要创建的项目类型，下一步再填写细节。</p>
            <div className="space-y-2.5">
              {projectKindOptions.map(opt => {
                const disabled = opt.kind === 'extension' && !canCreateExtensionProject
                return (
                  <button
                    key={opt.kind}
                    type="button"
                    disabled={disabled}
                    onClick={() => chooseProjectKind(opt.kind)}
                    data-tour={`project-kind-${opt.kind}`}
                    className={`group flex w-full items-start gap-3 rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] p-3 text-left transition-[transform,border-color,background-color] duration-300 ease-out disabled:cursor-not-allowed disabled:opacity-45 ${disabled ? '' : 'hover:-translate-y-0.5 ' + PROJECT_KIND_HOVER[opt.kind]}`}
                    style={{ color: 'var(--text-primary)' }}>
                    <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border transition-transform duration-300 ease-out group-hover:scale-110"
                      style={{ color: opt.kind === 'research' ? '#34d399' : opt.kind === 'extension' ? '#a78bfa' : '#60a5fa', borderColor: 'var(--input-border)', background: 'rgba(255,255,255,0.03)' }}>
                      {opt.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[length:var(--fs-lg)] font-semibold">{opt.label}</span>
                      <span className="mt-0.5 block text-[length:var(--fs-md)] leading-5" style={{ color: 'var(--text-secondary)' }}>{opt.description}</span>
                      <span className="mt-1 block text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>{opt.note}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            {err && <ErrBanner className="mt-4">{err}</ErrBanner>}
            <div className="mt-5 flex gap-2">
              <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[length:var(--fs-lg)] bg-[var(--bg-card-hover)] border" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-2">
              <button type="button" onClick={() => { setErr(''); setStep('type') }}
                title="返回选择项目类型"
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border bg-[var(--bg-card-hover)]"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
              </button>
              <div className="min-w-0">
                <h3 className="text-[length:var(--fs-2xl)] font-semibold" style={{ color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }}>新建{NEW_PROJECT_KIND_LABELS[projectKind]}</h3>
                <p className="mt-0.5 text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>
                  {projectKind === 'default'
                    ? '经典项目默认不启动研究系统。'
                    : projectKind === 'research'
                      ? '研究项目会自动启用研究，并禁用 git worktree。'
                      : '拓展项目会创建 mobius/extension 下的可加载拓展骨架。'}
                </p>
              </div>
            </div>
            <div className="space-y-3 mb-4">
              <input autoFocus value={name} onChange={e => { setName(e.target.value); setErr('') }}
                data-tour="project-name-input"
                placeholder={archiveFile ? '项目名称（留空则用压缩包文件名）' : '项目名称'}
                onKeyDown={e => e.key === 'Enter' && submit()}
                className="w-full h-10 px-3 rounded-xl text-[length:var(--fs-lg)] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
              <ExpandableTextarea value={desc} onValueChange={setDesc}
                placeholder="项目描述（选填）"
                overlayTitle="编辑项目描述"
                className="w-full h-20 px-3 py-2 rounded-xl text-[length:var(--fs-lg)] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30 resize-none"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
              {projectKind === 'extension' ? (
                <div>
                  <input value={extensionName} onChange={e => { setExtensionName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); setErr('') }}
                    placeholder="拓展标识名，如 my-awesome-ext"
                    maxLength={32}
                    className="w-full h-10 px-3 rounded-xl text-[length:var(--fs-lg)] placeholder:!text-[var(--placeholder-color)] focus:outline-none focus:border-blue-500/30"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
                  <p className="text-[length:var(--fs-sm)] mt-1" style={{ color: 'var(--text-muted)' }}>小写字母开头，可含小写字母、数字和连字符，1-32字符。</p>
                </div>
              ) : (
                <>
                  <p className="text-[length:var(--fs-sm)] -mt-1" style={{ color: 'var(--text-muted)' }}>
                    您希望把项目放置于什么位置？
                    {bindPathManual
                      ? <span className="text-amber-400"> · 手动输入路径</span>
                      : <span> · 自动创建目录</span>}
                  </p>
                  <div className="flex items-center gap-2">
                    <input value={bindPathDisplay} readOnly placeholder="绑定路径（必填，限家目录下）"
                      data-tour="project-path-input"
                      title={bindPath}
                      aria-label={bindPath ? `绑定路径：${bindPath}` : '绑定路径'}
                      className="flex-1 h-10 px-3 rounded-xl text-[length:var(--fs-lg)] placeholder:!text-[var(--placeholder-color)] focus:outline-none cursor-pointer"
                      onClick={() => setPickerOpen(true)}
                      style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: theme !== 'light' ? '#f1f5f9' : '#1e293b' }} />
                    <button type="button" onClick={() => setPickerOpen(true)}
                      data-tour="project-path-picker"
                      className="h-10 px-3 rounded-xl text-[length:var(--fs-md)] bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors border border-blue-500/20 flex items-center gap-1.5">
                      <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.8} />
                      选择路径
                    </button>
                    <button type="button" onClick={refreshRandomBindPath}
                      title="换一个随机路径名"
                      aria-label="换一个随机路径名"
                      className="h-10 w-10 flex-shrink-0 rounded-xl text-blue-400 bg-blue-500/15 hover:bg-blue-500/25 transition-colors border border-blue-500/20 inline-flex items-center justify-center">
                      <Dices className="h-4 w-4" strokeWidth={1.8} />
                    </button>
                  </div>

                  {/* 代码压缩包: 选填, 创建成功后自动解压到项目目录 */}
                  <input
                    ref={archiveInputRef}
                    type="file"
                    accept=".zip,.tar,.tar.gz,.tgz,.tar.bz2,.tar.xz"
                    className="hidden"
                    onChange={e => { setArchiveFile(e.target.files?.[0] || null); setErr('') }}
                  />
                  <button type="button" onClick={() => archiveInputRef.current?.click()}
                    data-tour="project-archive"
                    className="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-card-hover)]"
                    style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)' }}>
                    <Upload className="h-4 w-4 flex-shrink-0 text-blue-400" strokeWidth={1.75} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--fs-md)] font-medium" style={{ color: archiveFile ? (theme !== 'light' ? '#cbd5e1' : '#334155') : 'var(--text-muted)' }}>
                        {archiveFile ? archiveFile.name : '点击选择代码压缩包（选填）'}
                      </span>
                      <span className="mt-0.5 block text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>
                        {archiveFile ? `${formatFileSize(archiveFile.size)} · 创建时自动解压 + git init` : '留空创建空项目; 上传则解压代码并自动 git init'}
                      </span>
                    </span>
                    {archiveFile && (
                      <span role="button" tabIndex={0}
                        onClick={e => { e.stopPropagation(); setArchiveFile(null); if (archiveInputRef.current) archiveInputRef.current.value = '' }}
                        className="flex-shrink-0 text-[length:var(--fs-sm)]" style={{ color: '#60a5fa' }}>移除</span>
                    )}
                  </button>

                  <ToggleSwitch
                    data-tour="project-worktree-toggle"
                    checked={!researchEnabled && defaultUseWorktree}
                    disabled={researchEnabled}
                    onChange={setDefaultUseWorktree}
                    className="flex items-center gap-3 text-[length:var(--fs-lg)]"
                    style={{ color: theme !== 'light' ? '#cbd5e1' : '#334155' }}>
                    默认使用 git worktree（新建任务时该选项默认打钩）
                  </ToggleSwitch>
                  {researchEnabled && (
                    <p className="text-[length:var(--fs-sm)] -mt-1" style={{ color: 'var(--text-muted)' }}>已启用研究系统，本项目强制禁用 worktree</p>
                  )}
                  {projectKind === 'default' && (
                    <ToggleSwitch
                      data-tour="project-research-toggle"
                      checked={researchEnabled}
                      onChange={enabled => {
                        setResearchEnabled(enabled)
                        if (enabled) setDefaultUseWorktree(false)
                      }}
                      className="flex items-center gap-3 text-[length:var(--fs-lg)]"
                      style={{ color: theme !== 'light' ? '#cbd5e1' : '#334155' }}>
                      启用研究系统（默认关闭，开启后自动禁用 git worktree）
                    </ToggleSwitch>
                  )}
                </>
              )}
              <button type="button" onClick={() => setPermissionOpen(true)}
                data-tour="project-visibility"
                className="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-card-hover)]"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)' }}>
                <Eye className="h-4 w-4 flex-shrink-0 text-blue-400" strokeWidth={1.75} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[length:var(--fs-md)] font-medium" style={{ color: theme !== 'light' ? '#cbd5e1' : '#334155' }}>设置项目成员</span>
                  <span className="mt-0.5 block truncate text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>
                    {inviteMembers.length ? `已选 ${inviteMembers.length} 位成员` : '点击添加项目成员（创建后可随时修改）'}
                  </span>
                </span>
                <span className="flex-shrink-0 text-[length:var(--fs-sm)]" style={{ color: '#60a5fa' }}>修改</span>
              </button>
            </div>
            {err && <ErrBanner>{err}</ErrBanner>}
            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 h-9 rounded-xl text-[length:var(--fs-lg)] bg-[var(--bg-card-hover)] border" style={{ color: theme !== 'light' ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>取消</button>
              <button onClick={submit} disabled={loading}
                data-tour="project-submit"
                className="flex-1 h-9 rounded-xl text-[length:var(--fs-lg)] btn-primary transition-colors disabled:opacity-40">
                {loading ? '创建中...' : '创建'}
              </button>
            </div>
          </>
        )}
      </div>
      {permissionSettingsModal}
      {pickerOpen && projectKind !== 'extension' && (
        <Suspense fallback={null}>
          <PathPickerModal initialPath={bindPath} onClose={() => setPickerOpen(false)} onPick={(abs, _rel, manual) => { setBindPath(abs); setBindPathManual(!!manual); setBindPathSource('custom'); setPickerOpen(false) }} />
        </Suspense>
      )}
    </div>
  )
}
