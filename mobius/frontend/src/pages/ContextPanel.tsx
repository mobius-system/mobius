import { useEffect, useState } from 'react'
import { useStore, api } from '../store'

// ContextPanel 只读地展示「本会话首轮实际注入的上下文快照」.
// 数据源: GET /api/sessions/:id/context-preview
//   - applied=true: 后端返回首轮发消息时落盘的快照本体 (body + sources)
//   - applied=false: 后端按 session 创建时保存的 Skill/Memory 选择快照预览待注入上下文
// 任何时候用户都不应在此面板里编辑, 编辑入口在 UserPage 的 skill/memory 管理.

interface SnapshotSkill { id: string; name: string; description?: string; scope: string; dirName?: string | null }
interface SnapshotMemory { id: string; name: string; description?: string; scope: string }
interface ContextPreview {
  body: string
  sources: {
    skills?: SnapshotSkill[]
    memories?: SnapshotMemory[]
  } | null
  applied: boolean
  pending: boolean
  snapshot_at: string | null
  user_message_count: number
}

const SCOPE_LABEL: Record<string, string> = { user: '用户级', project: '项目级', builtin: '内置', issue: '任务级' }

function formatTime(iso?: string | null) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch { return iso }
}

export default function ContextPanel({ onClose }: { onClose: () => void }) {
  const { user, currentSession, currentIssue, currentProject, theme } = useStore()
  const [preview, setPreview] = useState<ContextPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [showBody, setShowBody] = useState(false)
  const [error, setError] = useState<string>('')
  const [copied, setCopied] = useState(false)

  const isDark = theme !== 'light'
  const textPrimary = isDark ? '#f1f5f9' : '#1e293b'
  const textMuted = isDark ? '#6b7280' : '#64748b'
  const bgPrimary = isDark ? '#111827' : '#ffffff'
  const bgSecondary = isDark ? '#1f2937' : '#f9fafb'
  const borderColor = isDark ? '#374151' : '#d1d5db'

  useEffect(() => {
    if (!currentSession?.session_id) { setPreview(null); return }
    setLoading(true)
    setError('')
    api(`/api/sessions/${currentSession.session_id}/context-preview`)
      .then((r: ContextPreview) => setPreview(r))
      .catch((e: any) => setError(e?.message || '加载失败'))
      .finally(() => setLoading(false))
  }, [currentSession?.session_id])

  const skills = preview?.sources?.skills || []
  const memories = preview?.sources?.memories || []

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" />
      <div className="fixed top-0 right-0 h-full w-[28rem] z-50 flex flex-col shadow-2xl border-l" style={{ background: bgPrimary, borderColor }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
              <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <h2 className="text-[14px] font-semibold" style={{ color: textPrimary }}>会话上下文快照</h2>
              <p className="text-[10px]" style={{ color: textMuted }}>只读 · 在新建会话前定型</p>
            </div>
          </div>
          <button onClick={onClose} className={`w-8 h-8 flex items-center justify-center rounded-lg ${isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-black/[0.06]'} transition-colors`} style={{ color: isDark ? '#6b7280' : '#64748b' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* 注入状态横幅 */}
          {currentSession && (
            <div className="rounded-lg p-3 text-[11px] leading-relaxed" style={{
              background: preview?.applied
                ? (isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)')
                : (isDark ? 'rgba(234,179,8,0.08)' : 'rgba(234,179,8,0.06)'),
              border: `1px solid ${preview?.applied ? (isDark ? 'rgba(34,197,94,0.3)' : 'rgba(34,197,94,0.25)') : (isDark ? 'rgba(234,179,8,0.3)' : 'rgba(234,179,8,0.25)')}`,
              color: preview?.applied ? (isDark ? '#86efac' : '#15803d') : (isDark ? '#fde68a' : '#a16207'),
            }}>
              {loading && '加载快照中...'}
              {!loading && preview?.applied && (
                <>已于 <strong>{formatTime(preview.snapshot_at)}</strong> 注入智能体. 之后修改 Skill/Memory 不影响本会话, 仅对新建会话生效.</>
              )}
              {!loading && preview && !preview.applied && (
                <>本会话还未发过首轮消息, 下次发送时会注入下方创建时定型的上下文快照. 修改 Skill/Memory 仅对新建会话生效.</>
              )}
              {!loading && error && <span style={{ color: '#ef4444' }}>{error}</span>}
            </div>
          )}

          {/* 用户 */}
          <section>
            <h3 className="flex items-center gap-2 text-[12px] font-semibold mb-2" style={{ color: textPrimary }}>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
              用户
            </h3>
            <div className="rounded-lg p-3 space-y-1.5" style={{ background: bgSecondary, border: `1px solid ${borderColor}` }}>
              <div className="flex justify-between text-[11px]">
                <span style={{ color: textMuted }}>姓名</span>
                <span style={{ color: textPrimary }}>{user?.display_name || '-'}</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span style={{ color: textMuted }}>角色</span>
                <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: isDark ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.12)', color: isDark ? '#60a5fa' : '#2563eb' }}>
                  {user?.role === 'admin' ? '管理员' : '成员'}
                </span>
              </div>
            </div>
          </section>

          {/* 项目 */}
          {currentProject && (
            <section>
              <h3 className="flex items-center gap-2 text-[12px] font-semibold mb-2" style={{ color: textPrimary }}>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                项目
              </h3>
              <div className="rounded-lg p-3 space-y-1.5" style={{ background: bgSecondary, border: `1px solid ${borderColor}` }}>
                <div className="flex justify-between text-[11px]">
                  <span style={{ color: textMuted }}>名称</span>
                  <span style={{ color: textPrimary }}>{currentProject.name}</span>
                </div>
                {currentProject.description && (
                  <div className="pt-1.5 border-t" style={{ borderColor }}>
                    <p className="text-[10px] leading-relaxed" style={{ color: textMuted }}>{currentProject.description}</p>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Issue */}
          {currentIssue && (
            <section>
              <h3 className="flex items-center gap-2 text-[12px] font-semibold mb-2" style={{ color: textPrimary }}>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                Issue
              </h3>
              <div className="rounded-lg p-3 space-y-1.5" style={{ background: bgSecondary, border: `1px solid ${borderColor}` }}>
                <div className="flex justify-between text-[11px]">
                  <span style={{ color: textMuted }}>标题</span>
                  <span style={{ color: textPrimary }}>{currentIssue.title}</span>
                </div>
                {currentIssue.description && (
                  <div className="pt-1.5 border-t" style={{ borderColor }}>
                    <p className="text-[10px] leading-relaxed" style={{ color: textMuted }}>{currentIssue.description}</p>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Skill 快照 */}
          {currentSession && (
            <section>
              <h3 className="flex items-center gap-2 text-[12px] font-semibold mb-2" style={{ color: textPrimary }}>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                Skill 快照 ({skills.length})
              </h3>
              <div className="rounded-lg p-3 space-y-1.5" style={{ background: bgSecondary, border: `1px solid ${borderColor}` }}>
                {skills.length === 0 && <p className="text-[10px] italic" style={{ color: textMuted }}>本会话未注入任何 Skill</p>}
                {skills.map(sk => (
                  <div key={sk.id} className="flex items-start justify-between gap-2 text-[11px]">
                    <div className="min-w-0 flex-1">
                      <div style={{ color: textPrimary }} className="truncate">{sk.name}</div>
                      {sk.description && <div className="text-[10px] truncate" style={{ color: textMuted }}>{sk.description}</div>}
                    </div>
                    <span className="px-1.5 py-0.5 rounded text-[10px] shrink-0" style={{ background: isDark ? 'rgba(168,85,247,0.15)' : 'rgba(168,85,247,0.1)', color: isDark ? '#c084fc' : '#7e22ce' }}>
                      {SCOPE_LABEL[sk.scope] || sk.scope}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Memory 快照 */}
          {currentSession && (
            <section>
              <h3 className="flex items-center gap-2 text-[12px] font-semibold mb-2" style={{ color: textPrimary }}>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                Memory 快照 ({memories.length})
              </h3>
              <div className="rounded-lg p-3 space-y-1.5" style={{ background: bgSecondary, border: `1px solid ${borderColor}` }}>
                {memories.length === 0 && <p className="text-[10px] italic" style={{ color: textMuted }}>本会话未注入任何 Memory</p>}
                {memories.map(m => (
                  <div key={m.id} className="flex items-start justify-between gap-2 text-[11px]">
                    <div className="min-w-0 flex-1">
                      <div style={{ color: textPrimary }} className="truncate">{m.name}</div>
                      {m.description && <div className="text-[10px] truncate" style={{ color: textMuted }}>{m.description}</div>}
                    </div>
                    <span className="px-1.5 py-0.5 rounded text-[10px] shrink-0" style={{ background: isDark ? 'rgba(34,197,94,0.15)' : 'rgba(34,197,94,0.1)', color: isDark ? '#86efac' : '#15803d' }}>
                      {SCOPE_LABEL[m.scope] || m.scope}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 完整注入文本 (可折叠) */}
          {currentSession && preview?.body && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <button onClick={() => setShowBody(v => !v)}
                  className="flex-1 flex items-center justify-between text-[12px] font-semibold"
                  style={{ color: textPrimary }}>
                  <span className="flex items-center gap-2">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" /></svg>
                    完整注入文本 ({preview.body.length} 字)
                  </span>
                  <svg className={`w-3.5 h-3.5 transition-transform ${showBody ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </button>
                <button onClick={(e) => {
                    e.stopPropagation()
                    navigator.clipboard.writeText(preview.body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
                  }}
                  className="ml-2 text-[10px] px-2 py-0.5 rounded border transition-colors"
                  style={{ borderColor, color: copied ? '#22c55e' : textMuted }}>
                  {copied ? '✓ 已复制' : '复制'}
                </button>
              </div>
              {showBody && (
                <pre className="rounded-lg p-3 text-[10px] leading-snug whitespace-pre-wrap break-words max-h-96 overflow-y-auto"
                  style={{ background: bgSecondary, border: `1px solid ${borderColor}`, color: textPrimary, fontFamily: 'ui-monospace,SFMono-Regular,monospace' }}>
                  {preview.body}
                </pre>
              )}
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t" style={{ borderColor }}>
          <p className="text-[10px] text-center leading-relaxed" style={{ color: textMuted }}>
            Skill/Memory 在创建会话时定型 · 修改 Skill/Memory 请在 <strong>用户中心</strong>, 新会话才会生效
          </p>
        </div>
      </div>
    </>
  )
}
