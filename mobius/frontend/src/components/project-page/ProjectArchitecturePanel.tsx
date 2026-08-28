import { useCallback, useEffect, useState } from 'react'
import { Download, ExternalLink, FileCode2, Image, RefreshCw, Settings } from 'lucide-react'
import { api, HIDDEN_FOLDER_NAME } from '../../store'
import {
  EXISTING_SESSION_ACTION_LABEL,
  NewSessionModal,
  normalizeExistingSessionAction,
  type ExistingSessionAction,
  type SessionPresetConfig,
} from '../modals'

const ARCHITECTURE_PRESET_KEY_PREFIX = 'project-architecture-session-preset:'
const ARCHITECTURE_REQUIRED_SKILL = {
  dirName: 'mobius-architecture-draw',
  name: 'mobius-architecture-draw',
  label: 'skills/mobius-architecture-draw/SKILL.md',
}

function presetStorageKey(projectId: string) {
  return `${ARCHITECTURE_PRESET_KEY_PREFIX}${projectId}`
}

function readPreset(projectId: string): SessionPresetConfig | null {
  try {
    const raw = localStorage.getItem(presetStorageKey(projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.name !== 'string' || typeof parsed.description !== 'string') return null
    return {
      name: parsed.name,
      description: parsed.description,
      model: typeof parsed.model === 'string' ? parsed.model : 'codex',
      role: parsed.role === 'chief_researcher' ? 'chief_researcher' : 'research_assistant',
      language: parsed.language === 'en' ? 'en' : 'zh',
      existing_session_action: normalizeExistingSessionAction(parsed.existing_session_action),
      excluded_skill_ids: Array.isArray(parsed.excluded_skill_ids) ? parsed.excluded_skill_ids.filter((id: any) => typeof id === 'string') : [],
      excluded_memory_ids: Array.isArray(parsed.excluded_memory_ids) ? parsed.excluded_memory_ids.filter((id: any) => typeof id === 'string') : [],
      required_skill_ids: Array.isArray(parsed.required_skill_ids) ? parsed.required_skill_ids.filter((id: any) => typeof id === 'string') : [],
      saved_at: typeof parsed.saved_at === 'string' ? parsed.saved_at : undefined,
    }
  } catch {
    return null
  }
}

function writePreset(projectId: string, preset: SessionPresetConfig) {
  localStorage.setItem(presetStorageKey(projectId), JSON.stringify(preset))
}

function sanitizeExcludedSkills(preset: SessionPresetConfig) {
  const required = new Set(preset.required_skill_ids || [])
  return (preset.excluded_skill_ids || []).filter(id => {
    const normalized = id.replace(/_/g, '-')
    return !required.has(id)
      && normalized !== 'builtin:mobius-architecture-draw'
      && !normalized.endsWith(':mobius-architecture-draw')
  })
}

function makeRequestId() {
  return `architecture-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function architecturePrompt(preset: SessionPresetConfig) {
  return [
    preset.description.trim(),
    '请现在开始执行：分析当前项目结构，生成或刷新系统结构剖析图。必须使用当前 Session 注入的 Mobius 内置 Skill「mobius-architecture-draw」作为执行规范，不要依赖 Codex 或 Claude Code 自身的 Skill/Memory 系统。',
    `请优先生成单文件 HTML/SVG 架构图，并保存到 ${HIDDEN_FOLDER_NAME}/generated_figures/arch.html；如需要兼容截图或封面，可额外保存 arch.svg / arch.png / arch.jpg。完成后删除本 session 的 running.flag。`,
  ].filter(Boolean).join('\n\n')
}

function readFigureName(res: Response) {
  const raw = res.headers.get('X-Architecture-Figure-Name') || ''
  if (!raw) return ''
  try { return decodeURIComponent(raw) } catch { return raw }
}

type ArchitectureFigureKind = 'html' | 'svg' | 'image' | ''

function readFigureKind(res: Response, fileName: string): ArchitectureFigureKind {
  const header = res.headers.get('X-Architecture-Figure-Kind')
  if (header === 'html' || header === 'svg' || header === 'image') return header
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.svg')) return 'svg'
  return 'image'
}

function sessionLabel(session: any) {
  return session?.name || session?.session_id || '未命名会话'
}

function existingSessionActionLabel(action?: ExistingSessionAction) {
  return EXISTING_SESSION_ACTION_LABEL[normalizeExistingSessionAction(action)]
}

export function ProjectArchitecturePanel({
  projectId,
  onSessionCreated,
}: {
  projectId: string
  onSessionCreated: (issue: any, session: any) => void
}) {
  const [preset, setPreset] = useState<SessionPresetConfig | null>(() => readPreset(projectId))
  const [showPresetModal, setShowPresetModal] = useState(false)
  const [starting, setStarting] = useState(false)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [imageName, setImageName] = useState('')
  const [figureKind, setFigureKind] = useState<ArchitectureFigureKind>('')
  const [imageExists, setImageExists] = useState<boolean | null>(null)
  const [imageLoading, setImageLoading] = useState(false)
  const [imageErr, setImageErr] = useState('')

  useEffect(() => {
    setPreset(readPreset(projectId))
  }, [projectId])

  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl)
    }
  }, [imageUrl])

  const loadFigure = useCallback(async () => {
    setImageLoading(true)
    setImageErr('')
    const token = localStorage.getItem('cc-token')
    try {
      const res = await fetch(`/api/projects/${projectId}/architecture-figure?t=${Date.now()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (res.status === 404) {
        setImageExists(false)
        setImageName('')
        setFigureKind('')
        setImageUrl('')
        return
      }
      if (res.status === 401) {
        localStorage.removeItem('cc-token')
        window.location.href = '/'
        return
      }
      if (!res.ok) {
        let message = `HTTP ${res.status}`
        try {
          const data = await res.json()
          if (data?.error) message = data.error
        } catch {}
        throw new Error(message)
      }
      const blob = await res.blob()
      const nextUrl = URL.createObjectURL(blob)
      const nextName = readFigureName(res)
      setImageExists(true)
      setImageName(nextName)
      setFigureKind(readFigureKind(res, nextName))
      setImageUrl(prev => {
        if (prev) URL.revokeObjectURL(prev)
        return nextUrl
      })
    } catch (e: any) {
      setImageExists(false)
      setImageErr(e?.message || '读取项目结构图失败')
      setImageUrl('')
      setImageName('')
      setFigureKind('')
    } finally {
      setImageLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    loadFigure()
  }, [loadFigure])

  const savePreset = (nextPreset: SessionPresetConfig) => {
    writePreset(projectId, nextPreset)
    setPreset(nextPreset)
    setShowPresetModal(false)
    setErr('')
    setNotice('')
  }

  const handleExistingSessions = async (issueId: string, action: ExistingSessionAction) => {
    const list = await api(`/api/issues/${issueId}/sessions`)
    const oldSessions = Array.isArray(list) ? list.filter((s: any) => s?.session_id) : []
    if (oldSessions.length === 0) return ''

    if (action === 'block_new') {
      const names = oldSessions.slice(0, 3).map(sessionLabel).join('、')
      throw new Error(`已存在 ${oldSessions.length} 个旧会话（${names}${oldSessions.length > 3 ? ' 等' : ''}），已按预设阻止新会话运行。`)
    }

    if (action === 'terminate_old') {
      for (const session of oldSessions) {
        await api(`/api/sessions/${session.session_id}/terminate`, { method: 'POST' })
      }
      return `已终止 ${oldSessions.length} 个旧会话。`
    }

    if (action === 'delete_old') {
      for (const session of oldSessions) {
        await api(`/api/sessions/${session.session_id}`, { method: 'DELETE' })
      }
      return `已删除 ${oldSessions.length} 个旧会话。`
    }

    return ''
  }

  const createOrRefresh = async () => {
    if (!preset) return
    setStarting(true)
    setErr('')
    setNotice('')
    try {
      const ensured = await api(`/api/projects/${projectId}/architecture-issue`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      const issue = ensured.issue
      const existingAction = normalizeExistingSessionAction(preset.existing_session_action)
      const existingMessage = existingAction === 'ignore' ? '' : await handleExistingSessions(issue.id, existingAction)
      const session = await api(`/api/issues/${issue.id}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
          name: preset.name,
          description: preset.description,
          model: preset.model,
          role: preset.role || 'research_assistant',
          language: preset.language || 'zh',
          excluded_skill_ids: sanitizeExcludedSkills(preset),
          excluded_memory_ids: preset.excluded_memory_ids || [],
        }),
      })
      await api(`/api/sessions/${session.session_id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content: architecturePrompt(preset),
          input_text: architecturePrompt(preset),
          request_id: makeRequestId(),
        }),
      })
      await loadFigure()
      setNotice([
        existingMessage,
        `已创建会话「${session.name || session.session_id}」，正在后台生成项目结构图。`,
      ].filter(Boolean).join(' '))
      onSessionCreated(issue, session)
    } catch (e: any) {
      setErr(e?.message || '创建项目结构绘制会话失败')
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>会话预设</div>
            <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
              {preset ? `${preset.name} · ${preset.language === 'en' ? 'English' : '中文'} · ${existingSessionActionLabel(preset.existing_session_action)}` : '未配置'}
            </div>
          </div>
          <button onClick={() => setShowPresetModal(true)}
            className="h-8 px-3 rounded-lg text-[12px] bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors inline-flex items-center gap-1.5">
            <Settings className="w-3.5 h-3.5" strokeWidth={1.75} />
            预设配置
          </button>
        </div>
      </div>

      <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
        <button onClick={createOrRefresh}
          disabled={!preset || starting}
          className="h-9 px-4 rounded-lg text-[13px] btn-primary transition-colors inline-flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed">
          <RefreshCw className={`w-3.5 h-3.5 ${starting ? 'animate-spin' : ''}`} strokeWidth={1.75} />
          {starting ? '创建中...' : '创建或刷新项目结构图'}
        </button>
        {err && <div className="mt-3 text-[12px] text-red-400">{err}</div>}
        {notice && <div className="mt-3 text-[12px] text-emerald-400">{notice}</div>}
      </div>

      <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold inline-flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
              {figureKind === 'html'
                ? <FileCode2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                : <Image className="w-3.5 h-3.5" strokeWidth={1.75} />}
              系统结构剖析图
            </div>
            {imageName && (
              <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {imageName}{figureKind === 'html' ? ' · 单文件 HTML 预览已禁用脚本' : ''}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {imageUrl && figureKind === 'image' && (
              <a href={imageUrl} target="_blank" rel="noreferrer"
                className="h-7 px-2 rounded-md text-[11px] border hover:bg-[var(--bg-card-hover)] transition-colors inline-flex items-center gap-1.5"
                style={{ color: 'var(--text-secondary)', borderColor: 'var(--input-border)' }}>
                <ExternalLink className="w-3 h-3" strokeWidth={1.75} />
                打开
              </a>
            )}
            {imageUrl && (
              <a href={imageUrl} download={imageName || 'arch.html'}
                className="h-7 px-2 rounded-md text-[11px] border hover:bg-[var(--bg-card-hover)] transition-colors inline-flex items-center gap-1.5"
                style={{ color: 'var(--text-secondary)', borderColor: 'var(--input-border)' }}>
                <Download className="w-3 h-3" strokeWidth={1.75} />
                下载
              </a>
            )}
            <button onClick={loadFigure} disabled={imageLoading}
              className="h-7 px-2 rounded-md text-[11px] border hover:bg-[var(--bg-card-hover)] transition-colors disabled:opacity-40"
              style={{ color: 'var(--text-secondary)', borderColor: 'var(--input-border)' }}>
              刷新
            </button>
          </div>
        </div>
        {imageLoading ? (
          <div className="text-[12px] py-8 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
        ) : imageErr ? (
          <div className="text-[12px] py-8 text-center text-red-400">{imageErr}</div>
        ) : imageExists && imageUrl ? (
          figureKind === 'html' ? (
            <iframe
              src={imageUrl}
              title="系统结构剖析图"
              sandbox=""
              className="w-full h-[70vh] rounded-lg border"
              style={{ borderColor: 'var(--border-color)', background: '#0b1020' }}
            />
          ) : (
            <img src={imageUrl} alt="系统结构剖析图" className="w-full max-h-[70vh] object-contain rounded-lg border" style={{ borderColor: 'var(--border-color)' }} />
          )
        ) : (
          <div className="text-[12px] py-8 text-center" style={{ color: 'var(--text-muted)' }}>系统结构剖析图不存在或正在绘制中</div>
        )}
      </div>

      {showPresetModal && (
        <NewSessionModal
          projectId={projectId}
          mode="preset"
          initialPreset={preset}
          requiredSkill={ARCHITECTURE_REQUIRED_SKILL}
          defaultName="项目结构绘制"
          defaultDescription={`请分析当前项目结构，生成或刷新系统结构剖析图。优先生成单文件 HTML/SVG 架构图并保存到 ${HIDDEN_FOLDER_NAME}/generated_figures/arch.html；可额外保存 arch.svg / arch.png / arch.jpg 作为兼容预览。`}
          onClose={() => setShowPresetModal(false)}
          onCreated={() => {}}
          onPresetSaved={savePreset}
        />
      )}
    </div>
  )
}
