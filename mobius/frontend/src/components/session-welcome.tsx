import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Brain, Eye, Plus, Puzzle, Rocket, Upload, X } from 'lucide-react'
import { api } from '../store'
import { normalizeGithubSkillInput } from './skills'
import { SkillMarketLink } from './skill-market-link'

const AUTO_CONFIRM_SECONDS = 4

// =====================================================================
// SessionStartModal — Session 还没有任何消息时, 进入对话界面就跳出
// 一个居中弹窗, 直接展示 Session 元数据中的 name / description 作为
// "目的 / 待解决的问题", 不需要用户再次输入:
//   - 「立即执行!」 -> 触发 onConfirm(), 由 ChatArea 把元数据拼成消息发出去
//   - 「暂不执行」 -> 触发 onDismiss(), 仅关闭弹窗, 保留欢迎屏供浏览
// =====================================================================
export function SessionStartModal({
  sessionName,
  sessionDescription,
  onConfirm,
  onDismiss,
  autoConfirm = true,
}: {
  sessionName?: string
  sessionDescription?: string
  onConfirm: () => Promise<void> | void
  onDismiss: () => void
  autoConfirm?: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [countdown, setCountdown] = useState(AUTO_CONFIRM_SECONDS)
  const [autoPending, setAutoPending] = useState(autoConfirm)
  const submittingRef = useRef(false)
  const onConfirmRef = useRef(onConfirm)
  onConfirmRef.current = onConfirm

  const handleConfirm = useCallback(async () => {
    if (submittingRef.current) return
    submittingRef.current = true
    setAutoPending(false)
    setLoading(true); setErr('')
    try {
      await onConfirmRef.current()
    } catch (e: any) {
      setErr(e?.message || '发送失败')
    } finally {
      submittingRef.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!autoConfirm) {
      setAutoPending(false)
      return
    }
    if (!autoPending) return
    setCountdown(AUTO_CONFIRM_SECONDS)
    const startedAt = Date.now()
    const interval = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
      setCountdown(Math.max(AUTO_CONFIRM_SECONDS - elapsedSeconds, 0))
    }, 250)
    const timer = setTimeout(() => {
      setAutoPending(false)
      void handleConfirm()
    }, AUTO_CONFIRM_SECONDS * 1000)

    return () => {
      clearInterval(interval)
      clearTimeout(timer)
    }
  }, [autoConfirm, autoPending, handleConfirm])

  const modalHint = loading
    ? '正在发送开始执行指令'
    : autoConfirm && autoPending
      ? `本次会话的目的 / 待解决的问题如下, ${countdown} 秒后自动执行`
      : '本次会话的目的 / 待解决的问题如下'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 msg-enter"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
    >
      <div
        data-tour="session-start-modal"
        className="rounded-2xl border max-w-md w-full p-6 shadow-2xl"
        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--bg-card-hover)', color: 'var(--text-primary)' }}>
            <Rocket className="w-5 h-5" strokeWidth={1.75} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>
              是否开始执行?
            </div>
            <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              {modalHint}
            </div>
          </div>
        </div>
        <div
          className="rounded-lg border p-3 mb-5 max-h-[40vh] overflow-auto"
          style={{ borderColor: 'var(--border-color)', background: 'rgba(255,255,255,0.02)' }}
        >
          {sessionName && (
            <div className="mb-2">
              <div
                className="text-[12px] font-medium mb-1"
                style={{ color: 'var(--text-muted)' }}
              >
                Session 目的
              </div>
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {sessionName}
              </div>
            </div>
          )}
          {sessionDescription ? (
            <div className={sessionName ? 'mt-2 pt-2 border-t' : ''} style={{ borderColor: 'var(--border-color)' }}>
              <div
                className="text-[12px] font-medium mb-1"
                style={{ color: 'var(--text-muted)' }}
              >
                待解决的问题
              </div>
              <div className="text-[12.5px] whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                {sessionDescription}
              </div>
            </div>
          ) : (
            !sessionName && (
              <div className="text-[12px] italic" style={{ color: 'var(--text-muted)' }}>
                当前 Session 暂未填写目的与描述
              </div>
            )
          )}
        </div>
        {err && (
          <div className="mb-3 text-[11.5px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {err}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            disabled={loading}
            className="px-4 py-2 text-[12.5px] rounded-lg border transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--border-color)' }}
          >
            暂不执行
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            data-tour="session-start-confirm"
            className="px-5 py-2 text-[12.5px] font-medium rounded-full btn-primary transition-colors shadow-sm disabled:opacity-60 disabled:cursor-wait"
          >
            {loading ? '发送中...' : autoConfirm && autoPending ? `立即执行 (${countdown}s)` : '立即执行!'}
          </button>
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// SessionWelcomeCards — Session 对话尚未开始时（无消息、未注入上下文）
// 的欢迎屏：展示当前 Session 范围内可用的 Memory / Skill 列表，
// 并标注每个条目属于 用户级、项目级还是内置。
//
// 数据来源:
//   - 用户级 memory : GET /api/memories
//   - 项目级 memory : GET /api/projects/<projectId>/memories
//   - 用户级 skill  : GET /api/skills
//   - 项目级 skill  : GET /api/projects/<projectId>/skills
// 后端返回的列表项里已带 scope/owner_id 字段, 这里前端为安全起见再次标注.
// =====================================================================

type Scope = 'user' | 'project' | 'builtin' | 'issue'

type Item = {
  id: string
  name: string
  description?: string
  scope?: Scope
}

const SCOPE_STYLE: Record<Scope, { label: string; color: string; bg: string; border: string }> = {
  project: { label: '项目级', color: '#22c55e', bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.25)' },
  user: { label: '用户级', color: '#60a5fa', bg: 'rgba(96,165,250,0.08)', border: 'rgba(96,165,250,0.25)' },
  builtin: { label: '内置', color: '#c084fc', bg: 'rgba(168,85,247,0.08)', border: 'rgba(168,85,247,0.25)' },
  issue: { label: '任务级', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)' },
}

// 排序: 项目级 → 用户级 → 内置
const scopeOrder = (s?: Scope) => (s === 'project' ? 0 : (s === 'user' ? 1 : 2))

function ScopeBadge({ scope }: { scope: Scope }) {
  const s = SCOPE_STYLE[scope] || SCOPE_STYLE.user
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 border"
      style={{ color: s.color, background: s.bg, borderColor: s.border }}
    >
      {s.label}
    </span>
  )
}

function CardList({
  title,
  hint,
  loading,
  items,
  emptyText,
  icon,
}: {
  title: string
  hint: string
  loading: boolean
  items: Item[]
  emptyText: string
  icon: React.ReactNode
}) {
  return (
    <div
      className="flex flex-col rounded-xl border overflow-hidden"
      style={{ background: 'var(--bg-tertiary, rgba(255,255,255,0.02))', borderColor: 'var(--border-color)' }}
    >
      <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border-color)' }}>
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <div className="min-w-0">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</div>
            <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{hint}</div>
          </div>
        </div>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)' }}
        >
          {loading ? '...' : items.length}
        </span>
      </div>
      <div className="flex-1 max-h-72 overflow-auto p-2 space-y-1.5">
        {loading ? (
          <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
        ) : items.length === 0 ? (
          <div className="text-[12px] py-4 text-center" style={{ color: 'var(--text-muted)' }}>{emptyText}</div>
        ) : (
          items.map((it) => (
            <div
              key={it.id}
              className="p-2 rounded-lg border"
              style={{ background: 'rgba(255,255,255,0.015)', borderColor: 'rgba(255,255,255,0.04)' }}
            >
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[12px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {it.name}
                </span>
                <ScopeBadge scope={it.scope ?? 'user'} />
              </div>
              {it.description && (
                <p className="text-[10.5px] line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                  {it.description}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// =====================================================================
// SessionSkillMemoryEditor — 右栏底部, 只读展示当前 session 创建时定型的
// skill / memory 选择快照. 创建后不再读取全局列表计算勾选状态, 避免全局
// Skill/Memory 后续变化导致本 Session 展示漂移.
// =====================================================================
type EditorItem = {
  id: string
  name: string
  description?: string
  scope: Scope
  body?: string
  enabled?: boolean
}

interface SelectionSnapshotResponse {
  snapshot: {
    skills?: EditorItem[]
    memories?: EditorItem[]
    all_skills?: EditorItem[]
    all_memories?: EditorItem[]
    totals?: { skills?: number; memories?: number }
  }
  snapshot_at?: string | null
  source?: 'created' | 'context' | 'live'
  legacy?: boolean
}

// =====================================================================
// 非精简模式 Skill/Memory 标签展开状态持久化 (localStorage).
// 用户主动关闭或切换 tab 后, 下次进入任意会话侧栏按记忆恢复, 而非每次回到默认.
// 'closed' 表示用户主动收起两个 tab (区别于"从未设置"的缺失键 → 走 initialPanel 默认).
// 仅在 persistActivePanel=true 时读写; 精简模式弹窗由用户点哪个按钮决定, 不持久化.
// =====================================================================
const ACTIVE_PANEL_STORAGE_KEY = 'mobius:skill-memory-active-panel'

function readStoredActivePanel(): null | 'skill' | 'memory' | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const value = window.localStorage.getItem(ACTIVE_PANEL_STORAGE_KEY)
    if (value === 'skill' || value === 'memory') return value
    if (value === 'closed') return null
    return undefined
  } catch {
    return undefined
  }
}

function writeStoredActivePanel(panel: null | 'skill' | 'memory'): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ACTIVE_PANEL_STORAGE_KEY, panel === null ? 'closed' : panel)
  } catch {
    /* 忽略隐私模式 / 配额满等写入失败 */
  }
}

// 文件名安全化: 非 [A-Za-z0-9._-] 替为 '-', 兜底 'item'.
function safeFilenamePart(name: string): string {
  const s = (name || '').trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return (s || 'item').slice(0, 64)
}

// 若 body 已以 YAML frontmatter 开头则原样返回, 否则补一行 `name: <name>` frontmatter.
function ensureSkillFrontmatter(name: string, body: string): string {
  const raw = body.replace(/\r\n/g, '\n')
  if (/^\s*---\s*\n/.test(raw)) return raw
  return `---\nname: ${name}\n---\n\n${raw}`
}

// =====================================================================
// AddSkillMemoryBar — Skill/Memory 面板顶部的"快速添加"入口.
// 收起态是一个 "+ 添加" 虚线按钮; 展开态是内联精简表单:
//   - skill: ① 粘贴 SKILL.md (name + 正文, 可含 frontmatter) 或上传 .md/.zip
//            ② 从 GitHub 装 (owner/repo -> 后端 npx skills add)
//   - memory: 写一条 (name + 正文) 或上传 .md/.zip (memory 无 GitHub 分发概念)
// 默认装到"用户级" (baseUrl 不带 projectId), 对当前用户所有任务可用.
// 成功后调 onAdded() 触发外层重新拉取 selection-snapshot, 新条目立刻出现在下方列表,
// 用户再点"追加/强调"即可注入当前会话 (对后续对话回合生效).
// =====================================================================
function AddSkillMemoryBar({ kind, onAdded }: { kind: 'skill' | 'memory'; onAdded: () => void }) {
  const isSkill = kind === 'skill'
  const baseUrl = isSkill ? '/api/skills' : '/api/memories'
  const accent = isSkill ? '#60a5fa' : '#22d3ee'
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'manual' | 'github'>('manual')
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [ghName, setGhName] = useState('')
  const [ghHint, setGhHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const reset = () => { setName(''); setBody(''); setGhName(''); setGhHint(''); setErr('') }

  const submitManual = async () => {
    const n = name.trim()
    if (!n) { setErr('名称不能为空'); return }
    if (isSkill && !body.trim()) { setErr('SKILL.md 正文不能为空'); return }
    setErr(''); setBusy(true)
    try {
      if (isSkill) {
        const content = ensureSkillFrontmatter(n, body)
        await api(`${baseUrl}/import-file`, {
          method: 'POST',
          body: JSON.stringify({ name: n, content, filename: `${safeFilenamePart(n)}.md` }),
        })
      } else {
        await api(baseUrl, { method: 'POST', body: JSON.stringify({ name: n, body }) })
      }
      reset(); setOpen(false); onAdded()
    } catch (e: any) {
      setErr(e?.message || '添加失败')
    } finally { setBusy(false) }
  }

  const submitGithub = async () => {
    const n = ghName.trim()
    if (!n) { setErr('请输入 owner/repo (如 vercel-labs/agent-skills)'); return }
    setErr(''); setBusy(true)
    try {
      await api(baseUrl, { method: 'POST', body: JSON.stringify({ name: n }) })
      reset(); setOpen(false); onAdded()
    } catch (e: any) {
      setErr(e?.message || '安装失败 (若本机 GitHub 不通, 需先在 .env 配置 MOBIUS_SKILLS_PROXY)')
    } finally { setBusy(false) }
  }

  const uploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setErr(''); setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await api(`${baseUrl}/import-file`, { method: 'POST', body: fd })
      reset(); setOpen(false); onAdded()
    } catch (e: any) {
      setErr(e?.message || '上传导入失败')
    } finally { setBusy(false) }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-tour={isSkill ? 'session-skill-add' : 'session-memory-add'}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed px-2 py-1.5 text-[11px] transition-colors hover:bg-[var(--bg-card-hover)]"
        style={{ borderColor: 'var(--border-color-strong)', color: accent }}
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2} />
        添加 {isSkill ? 'Skill' : 'Memory'}
      </button>
    )
  }

  return (
    <div className="space-y-1.5 rounded-lg border p-2" style={{ borderColor: 'var(--border-color-strong)', background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex flex-wrap items-center gap-1">
        {isSkill ? (
          <>
            <SegBtn active={mode === 'manual'} onClick={() => { setMode('manual'); setErr('') }} color={accent}>粘贴 / 上传</SegBtn>
            <SegBtn active={mode === 'github'} onClick={() => { setMode('github'); setErr('') }} color={accent}>从 GitHub 装</SegBtn>
          </>
        ) : (
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>写一条 Memory 或上传文件</span>
        )}
        {isSkill && <SkillMarketLink className="ml-auto" />}
        <button type="button" onClick={() => { reset(); setOpen(false) }} className={`${isSkill ? '' : 'ml-auto'} text-[10px] hover:underline`} style={{ color: 'var(--text-muted)' }}>收起</button>
      </div>

      {mode === 'github' && isSkill ? (
        <>
          <input
            value={ghName}
            onChange={e => {
              const raw = e.target.value
              const clean = normalizeGithubSkillInput(raw)
              if (clean && clean !== raw.trim()) {
                setGhName(clean)
                setGhHint(`已从粘贴的命令 / URL 自动提取为: ${clean}`)
              } else {
                setGhName(raw)
                setGhHint('')
              }
              setErr('')
            }}
            placeholder="可直接粘贴安装命令或 GitHub URL (自动提取); 例: owner/repo 或 owner/repo@skill-name"
            className="w-full rounded border px-2 py-1 text-[11px] outline-none"
            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
          />
          {ghHint && (
            <div className="break-words text-[9.5px] leading-snug" style={{ color: '#fbbf24' }}>{ghHint}</div>
          )}
          <div className="text-[9.5px] leading-snug" style={{ color: 'var(--text-muted)' }}>
            后端执行 <code className="font-mono">npx skills add</code>, 从 GitHub 拉取并写为用户级 Skill.
          </div>
        </>
      ) : (
        <>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={isSkill ? 'Skill 名称 (如 my-skill)' : 'Memory 名称'}
            className="w-full rounded border px-2 py-1 text-[11px] outline-none"
            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
          />
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={isSkill ? 4 : 3}
            placeholder={isSkill ? 'SKILL.md 正文 (可含 --- frontmatter ---, 否则自动补 name)' : 'Memory 正文'}
            data-text-redaction-ignore="true"
            className="w-full resize-y rounded border px-2 py-1 font-mono text-[11px] outline-none"
            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}
          />
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".md,.markdown,.zip,.tar,.tar.gz,.tgz,.tbz,.tbz2,.tar.bz2,.txz,.tar.xz,application/zip,application/x-tar,application/gzip,text/markdown"
            onChange={uploadFile}
          />
        </>
      )}

      {err && <div className="break-words text-[10px] text-red-400">{err}</div>}

      <div className="flex items-center gap-1.5">
        {mode === 'manual' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[10.5px] disabled:opacity-50"
            style={{ borderColor: 'var(--border-color-strong)', color: 'var(--text-secondary)' }}
          >
            <Upload className="h-3 w-3" strokeWidth={1.9} /> 上传文件
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={mode === 'github' ? submitGithub : submitManual}
          className="btn-primary ml-auto rounded px-3 py-1 text-[10.5px] disabled:opacity-60"
        >
          {busy ? '处理中...' : (mode === 'github' ? '安装' : '添加')}
        </button>
      </div>
      <div className="text-[9px] leading-snug" style={{ color: 'var(--text-muted)' }}>
        作为用户级添加 (对你所有任务可用). 添加后在下方列表点「追加」即可注入当前会话, 对后续对话生效.
      </div>
    </div>
  )
}

function SegBtn({ active, onClick, color, children }: { active: boolean; onClick: () => void; color: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border px-2 py-0.5 text-[10.5px] transition-colors"
      style={{
        color: active ? '#fff' : 'var(--text-secondary)',
        borderColor: active ? color : 'var(--border-color)',
        background: active ? color : 'transparent',
      }}
    >
      {children}
    </button>
  )
}

export function SessionSkillMemoryEditor({
  sessionId,
  initialPanel = null,
  persistActivePanel = false,
}: {
  sessionId?: string
  initialPanel?: null | 'skill' | 'memory'
  persistActivePanel?: boolean
}) {
  const [memories, setMemories] = useState<EditorItem[]>([])
  const [skills, setSkills] = useState<EditorItem[]>([])
  const [totals, setTotals] = useState({ skills: 0, memories: 0 })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  // 按钮三态: idle / sending / done. key = `${kind}:${itemId}`
  const [emphasizeState, setEmphasizeState] = useState<Record<string, 'idle' | 'sending' | 'done'>>({})
  const [activePanel, setActivePanel] = useState<null | 'skill' | 'memory'>(() => {
    if (persistActivePanel) {
      const stored = readStoredActivePanel()
      if (stored !== undefined) return stored
    }
    return initialPanel
  })
  // 切换/收起 tab 时同步写回 localStorage (仅 persistActivePanel=true 的非精简侧栏).
  const setActivePanelAndPersist = useCallback((next: null | 'skill' | 'memory') => {
    setActivePanel(next)
    if (persistActivePanel) writeStoredActivePanel(next)
  }, [persistActivePanel])
  const [previewItem, setPreviewItem] = useState<null | { kind: 'skill' | 'memory'; item: EditorItem }>(null)
  // 添加 skill/memory 成功后自增 reloadKey, 触发 selection-snapshot 重新拉取, 新条目立即出现在下方列表.
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey(k => k + 1), [])

  useEffect(() => {
    let cancelled = false
    if (!sessionId) {
      setMemories([])
      setSkills([])
      setTotals({ skills: 0, memories: 0 })
      setPreviewItem(null)
      setLoading(false)
      return () => { cancelled = true }
    }
    setLoading(true)
    setError('')
    api(`/api/sessions/${sessionId}/selection-snapshot`)
      .then((res: SelectionSnapshotResponse) => {
        if (cancelled) return
        const snap = res.snapshot || {}
        const skillItems = (snap.all_skills && snap.all_skills.length > 0 ? snap.all_skills : snap.skills || [])
          .map((it) => ({ ...it, enabled: it.enabled !== false }))
        const memoryItems = (snap.all_memories && snap.all_memories.length > 0 ? snap.all_memories : snap.memories || [])
          .map((it) => ({ ...it, enabled: it.enabled !== false }))
        const sortFn = (a: EditorItem, b: EditorItem) => {
          if (!!a.enabled !== !!b.enabled) return a.enabled ? -1 : 1
          if (a.scope !== b.scope) return scopeOrder(a.scope) - scopeOrder(b.scope)
          return (a.name || '').localeCompare(b.name || '')
        }
        setSkills(skillItems.sort(sortFn))
        setMemories(memoryItems.sort(sortFn))
        setTotals({
          skills: snap.totals?.skills ?? skillItems.length,
          memories: snap.totals?.memories ?? memoryItems.length,
        })
      })
      .catch((e: any) => {
        if (cancelled) return
        setError(e?.message || '加载失败')
        setSkills([])
        setMemories([])
        setTotals({ skills: 0, memories: 0 })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [sessionId, reloadKey])

  const handleEmphasize = useCallback(async (kind: 'skill' | 'memory', itemId: string) => {
    if (!sessionId) return
    const key = `${kind}:${itemId}`
    setEmphasizeState((prev) => ({ ...prev, [key]: 'sending' }))
    try {
      await api(`/api/sessions/${sessionId}/emphasize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, id: itemId }),
      })
      setEmphasizeState((prev) => ({ ...prev, [key]: 'done' }))
      setTimeout(() => {
        setEmphasizeState((prev) => {
          if (prev[key] !== 'done') return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
      }, 1500)
    } catch (e: any) {
      setEmphasizeState((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      // 简单的错误提示: 不阻断其他按钮, 用 alert 兜底
      window.alert?.(e?.message || '发送失败')
    }
  }, [sessionId])

  const renderList = (
    items: EditorItem[],
    emptyText: string,
    kind: 'skill' | 'memory',
  ) => {
    if (loading) return <div className="text-[11px] py-2 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
    if (error) return <div className="text-[11px] py-2 text-center text-red-400">{error}</div>
    if (items.length === 0) return <div className="text-[11px] py-2 text-center" style={{ color: 'var(--text-muted)' }}>{emptyText}</div>
    return (
      <div className="space-y-1">
        {items.map(it => {
          const enabled = it.enabled !== false
          const scopeStyle = SCOPE_STYLE[it.scope] || SCOPE_STYLE.user
          const stateKey = `${kind}:${it.id}`
          const btnState = emphasizeState[stateKey] || 'idle'
          const btnLabel = btnState === 'sending' ? '发送中...' : btnState === 'done' ? '✓' : (enabled ? '强调' : '追加')
          const btnDisabled = !sessionId || btnState === 'sending' || btnState === 'done'
          return (
            <div key={it.id}
              className="flex items-start gap-2 px-2 py-1.5 rounded border text-[11px]"
              style={{
                borderColor: 'var(--border-color)',
                background: enabled ? 'rgba(255,255,255,0.02)' : 'transparent',
              }}>
              <div className={`min-w-0 flex-1 ${enabled ? '' : 'opacity-65'}`}>
                <div className="flex items-start gap-2">
                  {/* <input
                    type="checkbox"
                    checked={enabled}
                    disabled
                    readOnly
                    className="mt-0.5 flex-shrink-0 accent-blue-500"
                  /> */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate" style={{ color: 'var(--text-primary)' }}>{it.name}</span>
                      <span
                        className="text-[9px] px-1 py-px rounded flex-shrink-0 border"
                        style={{
                          color: scopeStyle.color,
                          background: scopeStyle.bg,
                          borderColor: scopeStyle.border,
                        }}>
                        {scopeStyle.label}
                      </span>
                    </div>
                    {it.description && (
                      <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>{it.description}</div>
                    )}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewItem({ kind, item: it })}
                className="flex-shrink-0 text-[10px] px-2 py-0.5 rounded border transition-colors inline-flex items-center gap-1 hover:bg-[var(--bg-card-hover)]"
                style={{
                  color: 'var(--text-secondary)',
                  borderColor: 'var(--border-color-strong)',
                  background: 'transparent',
                }}
                title={`浏览 ${it.name} 的快照正文`}
                aria-label={`浏览 ${it.name} 的快照正文`}
              >
                <Eye className="h-3 w-3" strokeWidth={1.9} />
              </button>
              <button
                type="button"
                disabled={btnDisabled}
                onClick={() => handleEmphasize(kind, it.id)}
                className="flex-shrink-0 text-[10px] px-2 py-0.5 rounded border transition-colors disabled:opacity-50 disabled:cursor-wait"
                style={{
                  color: btnState === 'done' ? '#22c55e' : 'var(--text-primary)',
                  borderColor: btnState === 'done' ? 'rgba(34,197,94,0.25)' : 'var(--border-color-strong)',
                  background: btnState === 'done' ? 'rgba(34,197,94,0.08)' : 'rgba(255,255,255,0.04)',
                }}
              >
                {btnLabel}
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  const enabledSkills = skills.filter(it => it.enabled !== false).length
  const enabledMemories = memories.filter(it => it.enabled !== false).length
  const skillTotal = totals.skills || skills.length
  const memoryTotal = totals.memories || memories.length
  const skillActive = activePanel === 'skill'
  const memActive = activePanel === 'memory'

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {/* Tabs: 点击切换面板, 再次点击当前 tab 收起; 列表直接内联展示在下方, 不再弹窗.
            下划线 tab 样式: 两个 tab 紧挨成 tab 条, 激活态底部彩色下划线 + 主色加粗, 未激活弱化. */}
        <div className="grid grid-cols-2 items-stretch">
          <button
            type="button"
            onClick={() => setActivePanelAndPersist(activePanel === 'skill' ? null : 'skill')}
            aria-pressed={skillActive}
            className={`min-h-9 w-full px-2 py-2 text-center text-[12px] leading-snug transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex min-w-0 items-center justify-center gap-1.5 overflow-hidden border-b-2 ${skillActive ? 'border-blue-400 font-medium' : 'border-transparent hover:bg-[var(--bg-card-hover)]'}`}
            style={{ color: skillActive ? 'var(--text-primary)' : 'var(--text-muted)' }}
          >
            <Puzzle className="h-3.5 w-3.5 flex-shrink-0 text-blue-400" strokeWidth={1.9} />
            <span className="btn-label">Skill ({enabledSkills}/{skillTotal} 启用)</span>
          </button>
          <button
            type="button"
            onClick={() => setActivePanelAndPersist(activePanel === 'memory' ? null : 'memory')}
            aria-pressed={memActive}
            data-tour="session-memory-toggle"
            className={`min-h-9 w-full px-2 py-2 text-center text-[12px] leading-snug transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex min-w-0 items-center justify-center gap-1.5 overflow-hidden border-b-2 ${memActive ? 'border-cyan-400 font-medium' : 'border-transparent hover:bg-[var(--bg-card-hover)]'}`}
            style={{ color: memActive ? 'var(--text-primary)' : 'var(--text-muted)' }}
          >
            <Brain className="h-3.5 w-3.5 flex-shrink-0 text-cyan-400" strokeWidth={1.9} />
            <span className="btn-label">Memory ({enabledMemories}/{memoryTotal} 启用)</span>
          </button>
        </div>

        {/* 内联菜单: 直接占据 tab 下方剩余空间, 无独立背景/边框/圆角, 无缝融入侧栏 */}
        {activePanel && (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* "快速添加"入口作为列表的第一项, 与列表项同处一个滚动容器、共用 space-y-1 间距,
                风格统一(虚线 border 区分其为操作入口, 其余为数据项). 添加成功后 reload() 立即
                把新条目刷进下方列表, 用户可点"追加/强调"注入当前会话 (对后续对话生效). */}
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
              <AddSkillMemoryBar kind={activePanel} onAdded={reload} />
              {skillActive
                ? renderList(skills, '暂无 Skill', 'skill')
                : renderList(memories, '暂无 Memory', 'memory')}
            </div>
          </div>
        )}
      </div>

      {previewItem && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center px-4" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            aria-label="关闭正文浏览"
            onClick={() => setPreviewItem(null)}
          />
          <div
            className="relative flex w-full max-w-[860px] flex-col overflow-hidden rounded-2xl shadow-2xl"
            style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)', maxHeight: 'min(760px, calc(100vh - 48px))' }}
            onClick={e => e.stopPropagation()}
          >
            <header className="flex items-start justify-between gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--border-color)' }}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {previewItem.kind === 'skill'
                    ? <Puzzle className="h-4 w-4 flex-shrink-0 text-blue-400" strokeWidth={1.9} />
                    : <BookOpen className="h-4 w-4 flex-shrink-0 text-cyan-400" strokeWidth={1.9} />}
                  <h3 className="min-w-0 text-[15px] font-semibold leading-6 break-words" style={{ color: 'var(--text-primary)' }}>
                    {previewItem.item.name}
                  </h3>
                  <ScopeBadge scope={previewItem.item.scope} />
                  <span
                    className="shrink-0 rounded border px-1.5 py-0.5 text-[10px]"
                    style={{ color: 'var(--text-muted)', borderColor: 'var(--border-color)', background: 'rgba(255,255,255,0.04)' }}
                  >
                    {(previewItem.item.body || '').length} 字
                  </span>
                </div>
                {previewItem.item.description && (
                  <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    {previewItem.item.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setPreviewItem(null)}
                className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--bg-card-hover)]"
                style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
                aria-label="关闭正文浏览"
                title="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-auto p-5">
              <pre
                className="m-0 min-h-[360px] whitespace-pre-wrap break-words rounded-xl border p-4 text-[12px] leading-relaxed"
                style={{
                  background: 'var(--bg-primary)',
                  borderColor: 'var(--border-color)',
                  color: 'var(--text-primary)',
                  fontFamily: 'ui-monospace,SFMono-Regular,"Noto Sans SC",monospace',
                }}
              >
                {previewItem.item.body || '这个快照条目没有可浏览的正文。'}
              </pre>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export function SessionSkillMemoryModal({
  sessionId,
  initialPanel,
  onClose,
}: {
  sessionId?: string
  initialPanel: 'skill' | 'memory'
  onClose: () => void
}) {
  const title = initialPanel === 'skill' ? '当前会话 Skill' : '当前会话 Memory'

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        aria-label="关闭 Skill / Memory 弹窗"
        onClick={onClose}
      />
      <div
        className="relative flex h-[min(680px,calc(100vh-32px))] w-[min(760px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl shadow-2xl"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
        onClick={event => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b px-5 py-3" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex min-w-0 items-center gap-2">
            {initialPanel === 'skill'
              ? <Puzzle className="h-4 w-4 flex-shrink-0 text-blue-400" strokeWidth={1.9} />
              : <Brain className="h-4 w-4 flex-shrink-0 text-cyan-400" strokeWidth={1.9} />}
            <h3 className="truncate text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
            aria-label="关闭 Skill / Memory 弹窗"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col p-3">
          <SessionSkillMemoryEditor
            key={initialPanel}
            sessionId={sessionId}
            initialPanel={initialPanel}
          />
        </div>
      </div>
    </div>
  )
}

export function SessionWelcomeCards({ projectId }: { projectId?: string }) {
  const [memories, setMemories] = useState<Item[]>([])
  const [skills, setSkills] = useState<Item[]>([])
  const [memLoading, setMemLoading] = useState(true)
  const [skillLoading, setSkillLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setMemLoading(true)
    const memReqs: Promise<Item[]>[] = [
      api('/api/memories').then((arr: any[]) =>
        (Array.isArray(arr) ? arr : []).map((x) => ({ ...x, scope: 'user' as const })),
      ).catch(() => []),
    ]
    if (projectId) {
      memReqs.push(
        api(`/api/projects/${projectId}/memories`).then((arr: any[]) =>
          (Array.isArray(arr) ? arr : []).map((x) => ({ ...x, scope: 'project' as const })),
        ).catch(() => []),
      )
    }
    Promise.all(memReqs).then((lists) => {
      if (cancelled) return
      const merged = lists.flat()
      merged.sort((a, b) => {
        if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
        return (a.name || '').localeCompare(b.name || '')
      })
      setMemories(merged)
      setMemLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    setSkillLoading(true)
    const skillReqs: Promise<Item[]>[] = [
      api('/api/skills').then((arr: any[]) =>
        (Array.isArray(arr) ? arr : []).map((x) => ({ ...x, scope: 'user' as const })),
      ).catch(() => []),
    ]
    if (projectId) {
      skillReqs.push(
        api(`/api/projects/${projectId}/skills`).then((arr: any[]) =>
          (Array.isArray(arr) ? arr : []).map((x) => ({ ...x, scope: 'project' as const })),
        ).catch(() => []),
      )
    }
    Promise.all(skillReqs).then((lists) => {
      if (cancelled) return
      const merged = lists.flat()
      merged.sort((a, b) => {
        if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
        return (a.name || '').localeCompare(b.name || '')
      })
      setSkills(merged)
      setSkillLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

  return (
    <div className="msg-enter">
      <div className="mb-4 text-center">
        <div className="text-[13px] font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
          Session 尚未开始
        </div>
        <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          发送第一条消息后, 以下 Memory 与 Skill 将随上下文一起注入到 prompt
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <CardList
          title="可用 Memory"
          hint="记忆片段 — 持久化的上下文与个人笔记"
          loading={memLoading}
          items={memories}
          emptyText="暂无 Memory"
          icon={
            <svg className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          }
        />
        <CardList
          title="可用 Skill"
          hint="技能包 — 注入 SKILL.md 供智能体调用"
          loading={skillLoading}
          items={skills}
          emptyText="暂无 Skill"
          icon={
            <svg className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          }
        />
      </div>
    </div>
  )
}
