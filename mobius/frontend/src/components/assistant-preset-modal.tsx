import { useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { api } from '../store'
import {
  NewSessionModal,
  type SessionPresetConfig,
  type SessionPersonalityOption,
} from './modals'

type AssistantPresetPayload = {
  project?: any
  issue?: any
  preset?: SessionPresetConfig
  personality_options?: SessionPersonalityOption[]
  model_label?: string
  current_session?: {
    session_id: string
    name?: string
    model_label?: string
    created_at?: string
    last_active?: string
  } | null
  deleted_session?: any
}

type AssistantPresetError = Error & {
  status?: number
  data?: any
}

const ASSISTANT_REQUIRED_SKILL = {
  dirName: 'mobius-assistant',
  name: 'mobius-assistant',
  label: 'skills/mobius-assistant/SKILL.md',
}

const ASSISTANT_PERSONALITY_OPTIONS: SessionPersonalityOption[] = [
  { key: 'balanced', label: '默认小莫', description: '友好、清楚、自然' },
  { key: 'serious', label: '严肃的小莫', description: '克制、准确、结构化' },
  { key: 'playful', label: '调皮的小莫', description: '轻快一点，关键操作仍严谨' },
  { key: 'proactive', label: '热情主动的小莫', description: '主动补全方案和下一步' },
  { key: 'gentle', label: '温和耐心的小莫', description: '解释充分，适合引导场景' },
  { key: 'concise', label: '干练的小莫', description: '结论先行，减少铺垫' },
]

async function postAssistantPreset(preset: SessionPresetConfig, deleteCurrentSession: boolean) {
  const token = localStorage.getItem('cc-token')
  const res = await fetch('/api/assistant/preset', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      preset,
      delete_current_session: deleteCurrentSession,
    }),
  })
  if (res.status === 401) {
    localStorage.removeItem('cc-token')
    window.location.href = '/'
    throw new Error('Unauthorized')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`) as AssistantPresetError
    err.status = res.status
    err.data = data
    throw err
  }
  return data as AssistantPresetPayload
}

function LoadingPresetModal({
  title,
  message,
  onClose,
  zIndexClass,
}: {
  title: string
  message: string
  onClose: () => void
  zIndexClass: string
}) {
  return (
    <div className={`fixed inset-0 ${zIndexClass} flex items-center justify-center`}>
      <button type="button" className="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-label="关闭" onClick={onClose} />
      <div className="relative w-[360px] max-w-[calc(100vw-32px)] rounded-2xl p-6 shadow-2xl"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="mb-2 text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
        <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span>{message}</span>
        </div>
      </div>
    </div>
  )
}

function PresetErrorModal({
  message,
  onClose,
  zIndexClass,
}: {
  message: string
  onClose: () => void
  zIndexClass: string
}) {
  return (
    <div className={`fixed inset-0 ${zIndexClass} flex items-center justify-center`}>
      <button type="button" className="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-label="关闭" onClick={onClose} />
      <div className="relative w-[380px] max-w-[calc(100vw-32px)] rounded-2xl p-6 shadow-2xl"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <h3 className="mb-2 text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>预设配置失败</h3>
        <p className="mb-5 text-[13px] leading-relaxed text-red-400">{message}</p>
        <button type="button" onClick={onClose} className="h-9 w-full rounded-xl border text-[13px]"
          style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)', background: 'var(--bg-card-hover)' }}>
          关闭
        </button>
      </div>
    </div>
  )
}

function DeleteSessionConfirmModal({
  session,
  saving,
  error,
  onConfirm,
  onClose,
}: {
  session?: AssistantPresetPayload['current_session']
  saving: boolean
  error: string
  onConfirm: () => void
  onClose: () => void
}) {
  const name = session?.name || session?.session_id || '当前小莫会话'
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <button type="button" className="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-label="取消删除当前小莫会话" onClick={saving ? undefined : onClose} />
      <div className="relative w-[420px] max-w-[calc(100vw-32px)] rounded-2xl p-6 shadow-2xl"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="mb-3 flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>删除当前小莫会话</h3>
            <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              保存新的预设后，当前会话「{name}」使用的模型和资料快照会过期。确认后会关闭后台执行，并永久删除这个小莫会话。
            </p>
          </div>
        </div>
        {error ? <div className="mb-3 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{error}</div> : null}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={saving}
            className="h-9 flex-1 rounded-xl border text-[13px] disabled:opacity-40"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)', background: 'var(--bg-card-hover)' }}>
            取消
          </button>
          <button type="button" onClick={onConfirm} disabled={saving}
            className="h-9 flex-1 rounded-xl bg-red-500 text-[13px] text-white transition-colors hover:bg-red-600 disabled:opacity-40">
            {saving ? '处理中...' : '删除并保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function AssistantPresetModal({
  onClose,
  onSaved,
  zIndexClass = 'z-[90]',
}: {
  onClose: () => void
  onSaved?: (payload: AssistantPresetPayload) => void
  zIndexClass?: string
}) {
  const [payload, setPayload] = useState<AssistantPresetPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [pendingPreset, setPendingPreset] = useState<SessionPresetConfig | null>(null)
  const [pendingSession, setPendingSession] = useState<AssistantPresetPayload['current_session']>(null)
  const [confirmSaving, setConfirmSaving] = useState(false)
  const [confirmErr, setConfirmErr] = useState('')
  const [saveErr, setSaveErr] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadErr('')
    api('/api/assistant/preset')
      .then((data: AssistantPresetPayload) => {
        if (!alive) return
        setPayload(data)
      })
      .catch((e: any) => {
        if (!alive) return
        setLoadErr(e?.message || '读取小莫预设失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [])

  const savePreset = async (preset: SessionPresetConfig, deleteCurrentSession: boolean) => {
    const data = await postAssistantPreset(preset, deleteCurrentSession)
    setPayload(data)
    onSaved?.(data)
    onClose()
  }

  const handlePresetSaved = (preset: SessionPresetConfig) => {
    setConfirmErr('')
    setSaveErr('')
    savePreset(preset, false).catch((e: AssistantPresetError) => {
      if (e.status === 409) {
        setPendingPreset(preset)
        setPendingSession(e.data?.current_session || payload?.current_session || null)
        return
      }
      setSaveErr(e?.message || '保存小莫预设失败')
    })
  }

  const confirmDeleteAndSave = () => {
    if (!pendingPreset || confirmSaving) return
    setConfirmSaving(true)
    setConfirmErr('')
    savePreset(pendingPreset, true)
      .catch((e: any) => setConfirmErr(e?.message || '删除当前小莫会话失败'))
      .finally(() => setConfirmSaving(false))
  }

  if (loading) {
    return (
      <LoadingPresetModal
        title="小莫预设配置"
        message="正在读取当前预设..."
        onClose={onClose}
        zIndexClass={zIndexClass}
      />
    )
  }

  if (loadErr || !payload?.preset || !payload?.project) {
    return (
      <PresetErrorModal
        message={loadErr || '没有读取到小莫预设'}
        onClose={onClose}
        zIndexClass={zIndexClass}
      />
    )
  }

  return (
    <>
      <NewSessionModal
        projectId={payload.project.id}
        mode="preset"
        initialPreset={payload.preset}
        defaultName="小莫助理"
        defaultDescription="你是小莫，莫比乌斯AI的项目助理。先读取skills/mobius-assistant/SKILL.md获取你的服务指南，再执行任务。征求用户的确认时，你必须参考“正确服务话术案例”与用户沟通！"
        entityLabel="小莫助理会话"
        requiredSkill={ASSISTANT_REQUIRED_SKILL}
        personalityOptions={payload.personality_options?.length ? payload.personality_options : ASSISTANT_PERSONALITY_OPTIONS}
        presetContextPreviewEndpoint="/api/assistant/preset/context-preview"
        presetSelectionDefaultsEndpoint="/api/assistant/preset/session-selection-defaults"
        showExistingSessionAction={false}
        modalZIndexClass={zIndexClass}
        onClose={onClose}
        onCreated={() => {}}
        onPresetSaved={handlePresetSaved}
      />
      {pendingPreset ? (
        <DeleteSessionConfirmModal
          session={pendingSession}
          saving={confirmSaving}
          error={confirmErr}
          onConfirm={confirmDeleteAndSave}
          onClose={() => {
            if (confirmSaving) return
            setPendingPreset(null)
            setPendingSession(null)
            setConfirmErr('')
          }}
        />
      ) : null}
      {saveErr ? (
        <PresetErrorModal
          message={saveErr}
          onClose={() => setSaveErr('')}
          zIndexClass="z-[100]"
        />
      ) : null}
    </>
  )
}
