import { useEffect, useRef, useState } from 'react'
import type { ReactNode, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { X, Loader2, BookOpen, FileText } from 'lucide-react'
import { api, HIDDEN_FOLDER_NAME } from '../store'

type KnowledgeEditorModalProps = {
  projectId: string
  issueId: string
  onClose: () => void
}

// 知识编辑页面: 两个 tab — 编辑项目知识 (project_knowledge.md) + 编辑本任务知识
// (issue_knowledge/<id>/issue_knowledge.md). 复用 PlanningEditor 的 "加载 + 500ms 防抖保存"
// 模式, 但去掉 lock/history/notify, 保持轻量. 保存直接写回对应 md 文件.
export function KnowledgeEditorModal({ projectId, issueId, onClose }: KnowledgeEditorModalProps) {
  // 默认落在「本任务知识」: 按钮"查看当前知识"在某个 Issue 的 Session 里, 最相关的是该 Issue 的知识.
  const [tab, setTab] = useState<'project' | 'issue'>('issue')

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center px-4" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 bg-black/55 backdrop-blur-sm" aria-label="关闭知识编辑" onClick={onClose} />
      <div
        className="relative flex w-full max-w-[860px] flex-col overflow-hidden rounded-2xl shadow-2xl"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)', maxHeight: 'min(680px, calc(100vh - 48px))' }}
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b px-5 py-3" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex min-w-0 items-center gap-2">
            <BookOpen className="h-4 w-4 flex-shrink-0 text-cyan-400" />
            <div className="min-w-0">
              <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>查看当前知识</div>
              <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>项目通用知识宜精简克制；本任务知识记录仅与当前 Issue 相关的内容</div>
            </div>
          </div>
          <button
            type="button" onClick={onClose}
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex gap-1 px-3" style={{ borderBottom: '1px solid var(--border-color)' }}>
          <TabButton active={tab === 'issue'} onClick={() => setTab('issue')} icon={<FileText className="h-3.5 w-3.5" />}
            label="编辑本任务知识" hint={`${HIDDEN_FOLDER_NAME}/issue_knowledge/${issueId}/issue_knowledge.md`} />
          <TabButton active={tab === 'project'} onClick={() => setTab('project')} icon={<BookOpen className="h-3.5 w-3.5" />}
            label="编辑项目知识" hint={`${HIDDEN_FOLDER_NAME}/project_knowledge.md`} />
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === 'project' ? (
            <KnowledgePane
              key="project"
              loadUrl={`/api/projects/${projectId}/memories/project-knowledge/content`}
              saveUrl={`/api/projects/${projectId}/memories/project-knowledge/upload`}
              fileHint={`${HIDDEN_FOLDER_NAME}/project_knowledge.md · 项目级通用知识, 所有 Session 共享`}
              emptyHint="暂无项目知识。项目知识记录整体事实、通用做法、跨任务复用的经验，请保持精简克制（一个项目下会有大量 Issue）。"
            />
          ) : (
            <KnowledgePane
              key="issue"
              loadUrl={`/api/issues/${issueId}/knowledge/content`}
              saveUrl={`/api/issues/${issueId}/knowledge/upload`}
              fileHint={`${HIDDEN_FOLDER_NAME}/issue_knowledge/${issueId}/issue_knowledge.md · 仅本任务相关`}
              emptyHint="暂无本任务知识。编辑后将保存到该文件，并作为可选 Memory 注入本 Issue 的 Session 上下文。"
            />
          )}
        </div>
      </div>
    </div>
  )
}

function TabButton({ active, onClick, icon, label, hint }: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  label: string
  hint: string
}) {
  return (
    <button
      type="button" onClick={onClick}
      className="inline-flex flex-nowrap items-center gap-1.5 px-3 py-2 text-[12px] border-b-2 -mb-px transition-colors whitespace-nowrap"
      style={{
        borderColor: active ? '#06b6d4' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
        fontWeight: active ? 600 : 400,
      }}
    >
      {icon}
      <span>{label}</span>
      <span className="hidden sm:inline text-[9px] px-1 py-0.5 rounded" style={{ background: 'var(--bg-card-hover)', color: 'var(--text-muted)' }}>{hint}</span>
    </button>
  )
}

function KnowledgePane({ loadUrl, saveUrl, fileHint, emptyHint }: {
  loadUrl: string
  saveUrl: string
  fileHint: string
  emptyHint: string
}) {
  const [content, setContent] = useState('')
  const [exists, setExists] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const lastSavedRef = useRef('')

  useEffect(() => {
    let cancelled = false
    setLoading(true); setLoadError('')
    api(loadUrl).then((data: any) => {
      if (cancelled) return
      if (data?.ok) {
        setContent(data.content || '')
        setExists(!!data.exists)
        lastSavedRef.current = data.content || ''
      } else {
        setLoadError(data?.error || '加载失败')
      }
    }).catch((e: any) => !cancelled && setLoadError(e?.message || '加载失败'))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [loadUrl])

  // 防抖保存 500ms.
  useEffect(() => {
    if (content === lastSavedRef.current) return
    const t = setTimeout(() => {
      setSaving(true); setSaveError('')
      api(saveUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) })
        .then((data: any) => {
          if (data?.ok) { lastSavedRef.current = content; setSavedAt(new Date().toISOString()); setExists(true) }
          else setSaveError(data?.error || '保存失败')
        })
        .catch((e: any) => setSaveError(e?.message || '保存失败'))
        .finally(() => setSaving(false))
    }, 500)
    return () => clearTimeout(t)
  }, [content, saveUrl])

  function forceSave() {
    if (content === lastSavedRef.current) return
    setSaving(true); setSaveError('')
    api(saveUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) })
      .then((data: any) => {
        if (data?.ok) { lastSavedRef.current = content; setSavedAt(new Date().toISOString()); setExists(true) }
        else setSaveError(data?.error || '保存失败')
      })
      .catch((e: any) => setSaveError(e?.message || '保存失败'))
      .finally(() => setSaving(false))
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); forceSave() }
  }

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{fileHint}</span>
        <span className="flex-shrink-0 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {saving ? '保存中…' : saveError
            ? <span className="text-red-400">⚠ {saveError}</span>
            : (savedAt && '已自动保存')}
        </span>
      </div>
      {loadError ? (
        <div className="flex-1 p-3 text-[12px] text-red-400">加载失败: {loadError}</div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />加载中…
        </div>
      ) : (
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={emptyHint}
          className="flex-1 w-full resize-none rounded-lg p-3 font-mono text-[12px] leading-relaxed"
          style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)', minHeight: '320px' }}
        />
      )}
      <div className="mt-1.5 px-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
        编辑后 500ms 自动保存 · Ctrl+S 立即保存{exists ? '' : ' · 首次保存将创建该文件'}
      </div>
    </div>
  )
}
