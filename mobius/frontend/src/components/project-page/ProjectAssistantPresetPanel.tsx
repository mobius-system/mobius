import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Settings } from 'lucide-react'
import { api, useStore } from '../../store'
import { AssistantPresetModal } from '../assistant-preset-modal'

type AssistantPresetPayload = {
  project?: any
  issue?: any
  preset?: {
    name?: string
    model?: string
    language?: 'zh' | 'en'
    excluded_skill_ids?: string[]
    excluded_memory_ids?: string[]
  }
  model_label?: string
  current_session?: {
    session_id: string
    name?: string
    model_label?: string
    last_active?: string
  } | null
  deleted_session?: any
}

function languageLabel(language?: string) {
  return language === 'en' ? 'English' : '中文'
}

export function ProjectAssistantPresetPanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<AssistantPresetPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [showPresetModal, setShowPresetModal] = useState(false)
  const setProjects = useStore(state => state.setProjects)

  const refreshProjects = useCallback(() => {
    api('/api/projects').then((arr: any[]) => setProjects(arr || [])).catch(() => {})
  }, [setProjects])

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const payload = await api('/api/assistant/preset') as AssistantPresetPayload
      setData(payload)
      refreshProjects()
    } catch (e: any) {
      setErr(e?.message || '读取小莫预设失败')
    } finally {
      setLoading(false)
    }
  }, [refreshProjects])

  useEffect(() => {
    load()
  }, [load, projectId])

  const preset = data?.preset
  const skillCount = preset?.excluded_skill_ids?.length || 0
  const memoryCount = preset?.excluded_memory_ids?.length || 0

  return (
    <div className="space-y-4">
      <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>小莫助理预设</div>
            <div className="mt-0.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              配置后续新建小莫 Session 使用的模型、语言、技能和记忆。默认只启用小莫内置 Skill，修改预设会要求删除当前小莫 Session。
            </div>
          </div>
          <button type="button" onClick={() => setShowPresetModal(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-500/15 px-3 text-[12px] text-blue-400 transition-colors hover:bg-blue-500/25">
            <Settings className="h-3.5 w-3.5" strokeWidth={1.75} />
            预设配置
          </button>
        </div>
      </div>

      <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>当前配置</div>
          <button type="button" onClick={load} disabled={loading}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--input-border)' }}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.75} />
            刷新
          </button>
        </div>

        {loading && !data ? (
          <div className="py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>正在读取...</div>
        ) : err ? (
          <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">{err}</div>
        ) : preset ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
              <div className="mb-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>名称</div>
              <div className="truncate text-[12px]" style={{ color: 'var(--text-primary)' }}>{preset.name || '小莫助理'}</div>
            </div>
            <div className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
              <div className="mb-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>模型</div>
              <div className="truncate text-[12px]" style={{ color: 'var(--text-primary)' }}>{data?.model_label || preset.model || '默认模型'}</div>
            </div>
            <div className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
              <div className="mb-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>语言</div>
              <div className="truncate text-[12px]" style={{ color: 'var(--text-primary)' }}>{languageLabel(preset.language)}</div>
            </div>
            <div className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
              <div className="mb-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>资料选择</div>
              <div className="truncate text-[12px]" style={{ color: 'var(--text-primary)' }}>
                已排除 Skill {skillCount} 个 / Memory {memoryCount} 个
              </div>
            </div>
          </div>
        ) : (
          <div className="py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>还没有预设数据</div>
        )}
      </div>

      <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>当前小莫会话</div>
        <div className="mt-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {data?.current_session
            ? `当前会继续沿用「${data.current_session.name || data.current_session.session_id}」。保存变更并确认后会删除它，下次提问会创建新的小莫会话。`
            : '当前没有可复用的小莫会话。下次提问会按预设创建新会话。'}
        </div>
        {notice ? <div className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-400">{notice}</div> : null}
      </div>

      {showPresetModal ? (
        <AssistantPresetModal
          zIndexClass="z-[80]"
          onClose={() => setShowPresetModal(false)}
          onSaved={(payload) => {
            setData(payload)
            setNotice(payload.deleted_session ? '已保存预设，并删除当前小莫会话。' : '已保存小莫预设。')
            refreshProjects()
          }}
        />
      ) : null}
    </div>
  )
}
