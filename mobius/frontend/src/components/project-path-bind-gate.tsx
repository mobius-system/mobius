// 项目本地工作路径绑定闸门（桌面端，替代旧 Electron 主进程注入的 project-overlay）。
// 仅当 Electron 桌面端 (window.mobiusDesktop.isDesktop) 且当前在某项目页时生效：
//   进入项目 → 拉取 project:bind-status → 未绑定则强制弹窗让用户选/确认本机路径。
// 已绑定(主进程会必要时补建目录)则静默放行。绑定确认走 confirmProjectPath IPC。
import { memo, useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'

interface BindStatus {
  bound: boolean
  path: string | null
  defaultPath?: string
  projectName?: string
  machineInfo?: string
}

interface DesktopBridge {
  isDesktop?: boolean
  getProjectBindStatus?: (projectId: string) => Promise<BindStatus | null>
  pickDirectory?: () => Promise<string | null>
  confirmProjectPath?: (projectId: string, path: string) => Promise<{ ok?: boolean; error?: string } | null>
}

function getDesktopBridge(): DesktopBridge | undefined {
  return typeof window !== 'undefined'
    ? (window as { mobiusDesktop?: DesktopBridge }).mobiusDesktop
    : undefined
}

function ProjectPathBindGateInner({ projectId }: { projectId?: string }) {
  const md = getDesktopBridge()
  const [status, setStatus] = useState<BindStatus | null>(null)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // 仅桌面端 + 有 projectId 时拉取绑定状态；切换项目重新判定。
  useEffect(() => {
    if (!md?.isDesktop || !projectId) { setStatus(null); return }
    let cancelled = false
    md.getProjectBindStatus?.(projectId)
      .then(s => {
        if (cancelled || !s) return
        setStatus(s)
        if (!s.bound) setPath(s.defaultPath || '')
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [md, projectId])

  // 非 Electron / 已绑定 / 尚未在项目页 → 不渲染。
  if (!md?.isDesktop || !projectId || !status || status.bound) return null

  const projectName = status.projectName || projectId
  const machineInfo = status.machineInfo || ''

  const browse = async () => {
    if (!md?.pickDirectory) return
    const picked = await md.pickDirectory()
    if (picked) { setPath(picked); setErr('') }
  }

  const confirm = async () => {
    if (!md?.confirmProjectPath || !projectId) return
    const p = path.trim()
    if (!p) { setErr('路径不能为空'); return }
    setBusy(true); setErr('')
    try {
      const r = await md.confirmProjectPath(projectId, p)
      if (r && r.ok) {
        // 绑定成功：标记已绑定以关闭弹窗
        setStatus({ ...status, bound: true, path: p })
      } else {
        setErr((r && r.error) || '绑定失败')
      }
    } catch (e) {
      setErr((e as Error).message || '绑定失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[2147483646] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/45" />
      <div
        className="relative w-[460px] max-w-[calc(100vw-40px)] rounded-[14px] p-[22px_24px] shadow-2xl"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}
      >
        <h3 className="text-[16px] font-semibold mb-2.5">绑定本地工作路径</h3>
        <p className="text-[13px] mb-3.5" style={{ color: 'var(--text-secondary)' }}>
          本项目「{projectName}」还没有绑定这台机器{machineInfo ? `（${machineInfo}）` : ''}的本地工作路径。您必须选择一个本地路径才能继续。
        </p>
        <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>本地路径</label>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={path}
            autoFocus
            onChange={e => { setPath(e.target.value); setErr('') }}
            onKeyDown={e => { if (e.key === 'Enter' && !busy) { e.preventDefault(); void confirm() } }}
            className="flex-1 min-w-0 h-9 px-3 rounded-lg text-[13px] outline-none focus:border-blue-500/40 font-mono"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
          />
          <button
            type="button"
            onClick={browse}
            disabled={busy}
            className="h-9 shrink-0 px-3 rounded-lg text-[13px] flex items-center gap-1.5 disabled:opacity-50"
            style={{ background: 'var(--bg-card-hover)', border: '1px solid var(--input-border)', color: 'var(--text-secondary)' }}
          >
            <FolderOpen className="w-3.5 h-3.5" strokeWidth={1.8} />
            浏览…
          </button>
        </div>
        {err && <div className="text-[12px] mb-2" style={{ color: '#ef4444' }}>{err}</div>}
        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="h-9 px-5 rounded-[9px] text-[14px] font-semibold text-white disabled:opacity-60"
            style={{ background: '#0a84ff' }}
          >
            {busy ? '处理中…' : '确认绑定'}
          </button>
        </div>
      </div>
    </div>
  )
}

export const ProjectPathBindGate = memo(ProjectPathBindGateInner)
