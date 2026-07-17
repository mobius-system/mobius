import { useEffect, useRef, useState } from 'react'
import { api } from '../store'

type PlanningEditorProps = {
  projectId: string
  sessionId: string | undefined
}

// 系统宏观规划编辑器: 绑定 <bind_path>/.imac/project_knowledge.md.
// - textarea 原生编辑 + 500ms 防抖自动保存 (复用 /project-knowledge/upload 端点).
// - 1s 轮询 .planning_lock 状态, Agent 写入时切只读 + 提示条.
// - 折叠/展开 (MVP 不做拖拽调高, 用固定的较高行数 + 内部滚动).
export function PlanningEditor({ projectId, sessionId }: PlanningEditorProps) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [locked, setLocked] = useState(false)
  const [lockedAt, setLockedAt] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const lastSavedRef = useRef<string>('')
  const skipNextLockReloadRef = useRef<boolean>(false)
  const lockedRef = useRef<boolean>(false)
  const toastTimerRef = useRef<number | null>(null)

  // 初始加载. 加载完成前禁止编辑, 避免用户输入被覆盖.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api(`/api/projects/${projectId}/memories/project-knowledge/content`).then((data: any) => {
      if (cancelled) return
      if (data?.ok) {
        setContent(data.content || '')
        lastSavedRef.current = data.content || ''
      } else {
        setLoadError(data?.error || '加载失败')
      }
    }).catch((e: any) => !cancelled && setLoadError(e?.message || '加载失败'))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [projectId])

  // 同步 lockedRef, 供防抖保存闭包读取最新值.
  useEffect(() => { lockedRef.current = locked }, [locked])

  // 写入锁轮询
  useEffect(() => {
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      api(`/api/projects/${projectId}/memories/project-knowledge/lock`).then((data: any) => {
        if (cancelled) return
        const isLocked = !!data?.locked
        setLocked(isLocked)
        setLockedAt(data?.locked_at || null)
        // 锁刚释放时, 重新读取文件内容 (Agent 可能已 patch).
        if (!isLocked && skipNextLockReloadRef.current) {
          skipNextLockReloadRef.current = false
          api(`/api/projects/${projectId}/memories/project-knowledge/content`).then((d: any) => {
            if (cancelled) return
            if (d?.ok) {
              setContent(d.content || '')
              lastSavedRef.current = d.content || ''
            }
          }).catch(() => {})
        } else if (isLocked) {
          skipNextLockReloadRef.current = true
        }
      }).catch(() => {})
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => { cancelled = true; clearInterval(t) }
  }, [projectId])

  // 防抖保存 500ms. 锁期间不保存, 避免覆盖 Agent 即将写入的内容.
  // 解锁后由锁轮询 effect 重新读取文件, 用户的最后输入会以"重新加载"形式回来.
  useEffect(() => {
    if (content === lastSavedRef.current) return
    const t = setTimeout(() => {
      if (lockedRef.current) return
      setSaving(true)
      setSaveError('')
      api(`/api/projects/${projectId}/memories/project-knowledge/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }).then((data: any) => {
        if (data?.ok) {
          lastSavedRef.current = content
          setSavedAt(new Date().toISOString())
        } else {
          setSaveError(data?.error || '保存失败')
        }
      }).catch((e: any) => setSaveError(e?.message || '保存失败'))
        .finally(() => setSaving(false))
    }, 500)
    return () => clearTimeout(t)
  }, [content, projectId])

  // 清理 toast 定时器
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    }
  }, [])

  function showToast(text: string, kind: 'ok' | 'err' = 'ok') {
    setToast({ text, kind })
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2400)
  }

  // 历史版本回滚后, 强制重新读取文件并更新编辑器内容.
  function reloadContentAfterRestore() {
    api(`/api/projects/${projectId}/memories/project-knowledge/content`).then((d: any) => {
      if (d?.ok) {
        setContent(d.content || '')
        lastSavedRef.current = d.content || ''
        setSavedAt(new Date().toISOString())
      }
    }).catch(() => {})
  }

  // F7: Ctrl+S 强制立即保存 (跳过防抖).
  function forceSaveNow() {
    if (lockedRef.current) {
      showToast('已锁定, 暂无法保存', 'err')
      return
    }
    if (content === lastSavedRef.current) {
      showToast('内容已是最新')
      return
    }
    setSaving(true)
    setSaveError('')
    api(`/api/projects/${projectId}/memories/project-knowledge/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).then((data: any) => {
      if (data?.ok) {
        lastSavedRef.current = content
        setSavedAt(new Date().toISOString())
        showToast('已保存')
      } else {
        setSaveError(data?.error || '保存失败')
        showToast(data?.error || '保存失败', 'err')
      }
    }).catch((e: any) => {
      setSaveError(e?.message || '保存失败')
      showToast(e?.message || '保存失败', 'err')
    }).finally(() => setSaving(false))
  }

  // F6: 3s 静止后向 ChatArea 发送"草稿已就绪"信号, 让输入框预填通知草稿.
  // 借助 window 自定义事件, ChatArea 监听 `mobius:planning-prefill`.
  useEffect(() => {
    if (!sessionId) return
    if (content === lastSavedRef.current) return
    const t = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('mobius:planning-prefill', {
        detail: { sessionId, projectId },
      }))
    }, 3000)
    return () => window.clearTimeout(t)
  }, [content, sessionId, projectId])

  const firstLine = content.split('\n').find(l => l.trim()) || '(空文档)'

  return (
    <div className="rounded-xl border" style={{ borderColor: 'var(--border-color-strong)', background: 'var(--bg-card)' }}>
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
        <div className="flex items-center gap-2 min-w-0">
          <button type="button" onClick={() => setCollapsed(!collapsed)}
            className="inline-flex h-7 items-center px-2 rounded-md text-[12px] hover:bg-[var(--bg-card-hover)]"
            style={{ color: 'var(--text-secondary)' }}
            title={collapsed ? '展开编辑器' : '收起编辑器'}>
            {collapsed ? '▶ 展开' : '▼ 收起'}
          </button>
          <span className="text-[12px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            系统宏观规划编辑器
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-card-hover)', color: 'var(--text-muted)' }}>
            project_knowledge.md
          </span>
          {saving && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>保存中…</span>}
          {!saving && savedAt && !locked && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>已自动保存</span>}
          {saveError && <span className="text-[10px] text-red-400">⚠ {saveError}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={forceSaveNow}
            className="inline-flex h-7 items-center px-2 rounded-md text-[11px] hover:bg-[var(--bg-card-hover)]"
            style={{ color: 'var(--text-secondary)' }}
            title="Ctrl+S 立即保存">
            立即保存
          </button>
          <button type="button" onClick={() => setHistoryOpen(true)}
            className="inline-flex h-7 items-center px-2 rounded-md text-[11px] hover:bg-[var(--bg-card-hover)]"
            style={{ color: 'var(--text-secondary)' }}
            title="查看历史版本">
            历史版本
          </button>
          {locked && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px]"
              style={{ background: 'rgba(245, 158, 11, 0.12)', color: '#fbbf24' }}
              title={lockedAt ? `Agent 写入开始于 ${lockedAt}` : 'Agent 正在写入'}>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              Agent 正在更新规划，编辑器暂时锁定…
            </div>
          )}
        </div>
      </header>
      {!collapsed && (
        <div className="p-2">
          {loadError ? (
            <div className="text-[12px] text-red-400 p-2">加载失败: {loadError}</div>
          ) : loading ? (
            <div className="text-[12px] p-6 text-center" style={{ color: 'var(--text-muted)' }}>加载中…</div>
          ) : (
            <PlanningTextarea
              projectId={projectId}
              content={content}
              locked={locked}
              onChange={setContent}
              onSave={forceSaveNow}
              onNotifyAgent={() => {
                window.dispatchEvent(new CustomEvent('mobius:planning-notify-agent', {
                  detail: { sessionId, projectId },
                }))
                showToast('已通知 Agent 当前规划已更新')
              }}
            />
          )}
          <div className="mt-1.5 text-[10px] px-1" style={{ color: 'var(--text-muted)' }}>
            编辑后 500ms 自动保存 · Ctrl+S 立即保存 · Agent 写入时只读 · 同步为项目级 Memory 供所有会话检索
          </div>
        </div>
      )}
      {collapsed && (
        <div className="px-3 py-2 text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
          {firstLine}
        </div>
      )}
      {historyOpen && (
        <HistoryModal
          projectId={projectId}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => {
            setHistoryOpen(false)
            reloadContentAfterRestore()
            showToast('已回滚到所选版本')
          }}
        />
      )}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] px-4 py-2 rounded-lg text-[12px] shadow-xl"
          style={{
            background: toast.kind === 'ok' ? 'rgba(16, 185, 129, 0.95)' : 'rgba(239, 68, 68, 0.95)',
            color: '#fff',
          }}>
          {toast.text}
        </div>
      )}
    </div>
  )
}

// 包一层 textarea 以便绑定 Ctrl+S + 右键菜单, 不污染主组件.
function PlanningTextarea({
  projectId,
  content,
  locked,
  onChange,
  onSave,
  onNotifyAgent,
}: {
  projectId: string
  content: string
  locked: boolean
  onChange: (v: string) => void
  onSave: () => void
  onNotifyAgent: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null)

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Ctrl+S / Cmd+S: 拦截默认行为并立即保存.
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault()
      onSave()
      return
    }
  }

  function onContextMenu(e: React.MouseEvent<HTMLTextAreaElement>) {
    const ta = textareaRef.current
    if (!ta) return
    const sel = ta.value.substring(ta.selectionStart ?? 0, ta.selectionEnd ?? 0)
    if (!sel.trim()) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, selectedText: sel })
  }

  function closeMenu() { setMenu(null) }

  useEffect(() => {
    if (!menu) return
    const onDoc = () => closeMenu()
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu() }
    document.addEventListener('click', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('click', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [menu])

  async function createExecutionIssueFromSelection() {
    if (!menu?.selectedText) return
    try {
      const title = menu.selectedText.split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 60) || '从规划创建执行任务'
      const resp: any = await api(`/api/projects/${projectId}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: `源自系统宏观规划:\n\n${menu.selectedText}`,
          use_worktree: false,
        }),
      })
      if (resp?.id) {
        window.dispatchEvent(new CustomEvent('mobius:planning-issue-created', {
          detail: { issueId: resp.id, title, sessionId: undefined },
        }))
      }
    } catch {}
    closeMenu()
  }

  return (
    <>
      <textarea
        ref={textareaRef}
        value={content}
        onChange={e => !locked && onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        readOnly={locked}
        placeholder="在此编辑项目宏观规划…"
        className="w-full font-mono text-[12px] leading-relaxed p-3 rounded-lg resize-y"
        style={{
          minHeight: '320px',
          maxHeight: '50vh',
          background: 'var(--input-bg)',
          border: '1px solid var(--input-border)',
          color: locked ? 'var(--text-muted)' : 'var(--text-primary)',
          cursor: locked ? 'not-allowed' : 'text',
        }}
      />
      <div className="mt-1.5 flex items-center justify-end">
        <button type="button"
          onClick={onNotifyAgent}
          disabled={locked}
          className="inline-flex h-7 items-center px-2.5 rounded-md text-[11px] hover:bg-[var(--bg-card-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-color)' }}
          title="把当前规划作为消息发给 Agent 让其据此更新">
          通知 Agent 已更新
        </button>
      </div>
      {menu && (
        <div
          className="fixed z-[130] min-w-[180px] rounded-md py-1 shadow-2xl text-[12px]"
          style={{
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 80),
            background: 'var(--modal-bg)',
            border: '1px solid var(--border-color-strong)',
            color: 'var(--text-primary)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button"
            onClick={createExecutionIssueFromSelection}
            className="block w-full text-left px-3 py-1.5 hover:bg-[var(--bg-card-hover)]">
            从选中行创建执行 Issue
          </button>
        </div>
      )}
    </>
  )
}

type HistoryItem = {
  filename: string
  size: number
  saved_at: string
}

function HistoryModal({
  projectId,
  onClose,
  onRestored,
}: {
  projectId: string
  onClose: () => void
  onRestored: () => void
}) {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [selected, setSelected] = useState<HistoryItem | null>(null)
  const [preview, setPreview] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreErr, setRestoreErr] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api(`/api/projects/${projectId}/memories/project-knowledge/history`).then((data: any) => {
      if (cancelled) return
      if (data?.ok) {
        setItems(Array.isArray(data.items) ? data.items : [])
      } else {
        setErr(data?.error || '加载历史失败')
      }
    }).catch((e: any) => !cancelled && setErr(e?.message || '加载历史失败'))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [projectId])

  function viewSnapshot(item: HistoryItem) {
    setSelected(item)
    setPreview('')
    setPreviewLoading(true)
    api(`/api/projects/${projectId}/memories/project-knowledge/history/${encodeURIComponent(item.filename)}`).then((data: any) => {
      if (data?.ok) setPreview(data.content || '')
      else setPreview(`(读取失败: ${data?.error || '未知错误'})`)
    }).catch((e: any) => setPreview(`(读取失败: ${e?.message || '未知错误'})`))
      .finally(() => setPreviewLoading(false))
  }

  function restore() {
    if (!selected) return
    if (!window.confirm(`确认回滚到 ${new Date(selected.saved_at).toLocaleString()} 的版本? 当前内容会先备份到历史.`)) return
    setRestoring(true)
    setRestoreErr('')
    api(`/api/projects/${projectId}/memories/project-knowledge/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: selected.filename }),
    }).then((data: any) => {
      if (data?.ok) {
        onRestored()
      } else {
        setRestoreErr(data?.error || '回滚失败')
      }
    }).catch((e: any) => setRestoreErr(e?.message || '回滚失败'))
      .finally(() => setRestoring(false))
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <button type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        aria-label="关闭历史版本"
        onClick={onClose}
      />
      <div
        className="relative flex flex-col rounded-2xl shadow-2xl"
        style={{
          background: 'var(--modal-bg)',
          border: '1px solid var(--border-color-strong)',
          width: 'min(960px, calc(100vw - 32px))',
          height: 'min(640px, calc(100vh - 32px))',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>规划历史版本</span>
            <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-card-hover)', color: 'var(--text-muted)' }}>
              保留最近 30 份
            </span>
          </div>
          <button type="button" onClick={onClose}
            className="h-7 w-7 rounded-md text-[14px] hover:bg-[var(--bg-card-hover)]"
            style={{ color: 'var(--text-secondary)' }}
            aria-label="关闭">✕</button>
        </header>
        <div className="flex-1 flex flex-col sm:flex-row min-h-0">
          {/* 移动端 (<640px): 版本列表与 diff 纵向堆叠 — 列表整宽置顶、限高 30vh 自滚,
              否则固定 w-[260px] 侧栏会把 ~343px 宽的弹窗主体里的 diff 挤到 ~83px. */}
          <aside className="w-full sm:w-[260px] max-h-[30vh] sm:max-h-none overflow-y-auto border-b sm:border-b-0 sm:border-r" style={{ borderColor: 'var(--border-color)' }}>
            {loading && (
              <div className="text-[12px] p-4" style={{ color: 'var(--text-muted)' }}>加载中…</div>
            )}
            {err && (
              <div className="text-[12px] p-4 text-red-400">{err}</div>
            )}
            {!loading && !err && items.length === 0 && (
              <div className="text-[12px] p-4" style={{ color: 'var(--text-muted)' }}>暂无历史版本</div>
            )}
            {items.map((it) => {
              const active = selected?.filename === it.filename
              return (
                <button key={it.filename} type="button"
                  onClick={() => viewSnapshot(it)}
                  className="block w-full text-left px-3 py-2 text-[12px] border-b hover:bg-[var(--bg-card-hover)]"
                  style={{
                    borderColor: 'var(--border-color)',
                    background: active ? 'var(--bg-card-hover)' : 'transparent',
                    color: 'var(--text-primary)',
                  }}>
                  <div className="font-medium truncate">{new Date(it.saved_at).toLocaleString()}</div>
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {formatBytes(it.size)}
                  </div>
                </button>
              )
            })}
          </aside>
          <section className="flex-1 flex flex-col min-w-0">
            {selected ? (
              <>
                <div className="flex items-center justify-between px-3 py-2 border-b text-[11px]"
                  style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
                  <span className="truncate">{selected.filename}</span>
                  <button type="button" onClick={restore} disabled={restoring}
                    className="inline-flex h-7 items-center px-2.5 rounded-md text-[11px] hover:bg-[var(--bg-card-hover)] disabled:opacity-40"
                    style={{ color: '#fbbf24', border: '1px solid var(--border-color)' }}>
                    {restoring ? '回滚中…' : '回滚到此版本'}
                  </button>
                </div>
                {restoreErr && (
                  <div className="px-3 py-1.5 text-[11px] text-red-400 border-b" style={{ borderColor: 'var(--border-color)' }}>
                    ⚠ {restoreErr}
                  </div>
                )}
                <div className="flex-1 overflow-auto p-3">
                  {previewLoading ? (
                    <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中…</div>
                  ) : (
                    <pre className="font-mono text-[12px] whitespace-pre-wrap break-words"
                      style={{ color: 'var(--text-primary)' }}>{preview}</pre>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                选择左侧任一历史版本以查看内容
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

function formatBytes(n: number) {
  if (!n || n < 1024) return `${n || 0} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
