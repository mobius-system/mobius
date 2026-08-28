import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { api } from '../../store'

type ProjectTodo = {
  id: string
  project_id: string
  title: string
  description: string
  completed: boolean
  sort_order: number
  created_by: string
  updated_by?: string | null
  created_at: string
  updated_at: string
  completed_at?: string | null
  created_by_name?: string
  updated_by_name?: string
}

type ProjectTodosPanelProps = {
  projectId: string
  canManage: boolean
}

type TodoRowProps = {
  todo: ProjectTodo
  canManage: boolean
  busy: boolean
  onUpdate: (todo: ProjectTodo, patch: Partial<Pick<ProjectTodo, 'title' | 'description' | 'completed'>>) => Promise<void>
  onDelete: (todo: ProjectTodo) => Promise<void>
}

function sortTodos(items: ProjectTodo[]) {
  return [...items].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1
    if ((a.sort_order || 0) !== (b.sort_order || 0)) return (a.sort_order || 0) - (b.sort_order || 0)
    return String(a.created_at || '').localeCompare(String(b.created_at || ''))
  })
}

function TodoRow({ todo, canManage, busy, onUpdate, onDelete }: TodoRowProps) {
  const [titleDraft, setTitleDraft] = useState(todo.title || '')
  const [descriptionDraft, setDescriptionDraft] = useState(todo.description || '')

  useEffect(() => {
    setTitleDraft(todo.title || '')
    setDescriptionDraft(todo.description || '')
  }, [todo.id, todo.title, todo.description])

  const commitTitle = async () => {
    const next = titleDraft.trim()
    if (!canManage || busy || next === todo.title) return
    if (!next) {
      setTitleDraft(todo.title || '')
      return
    }
    await onUpdate(todo, { title: next })
  }

  const commitDescription = async () => {
    if (!canManage || busy || descriptionDraft === (todo.description || '')) return
    await onUpdate(todo, { description: descriptionDraft })
  }

  return (
    <div
      className="rounded-lg border px-3 py-2.5"
      style={{
        borderColor: 'var(--border-color)',
        background: todo.completed ? 'rgba(34,197,94,0.06)' : 'var(--bg-secondary)',
      }}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={todo.completed}
          disabled={!canManage || busy}
          onChange={(event) => onUpdate(todo, { completed: event.target.checked })}
          className="mt-1 h-4 w-4 shrink-0 accent-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={todo.completed ? '取消完成' : '标记完成'}
        />
        <div className="min-w-0 flex-1 space-y-1.5" data-text-redaction-ignore="true">
          <input
            value={titleDraft}
            disabled={!canManage || busy}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                setTitleDraft(todo.title || '')
                event.currentTarget.blur()
              }
            }}
            className={`w-full rounded-md border px-2 py-1.5 text-[13px] leading-5 focus:outline-none focus:border-blue-500/30 disabled:opacity-70 ${todo.completed ? 'line-through' : ''}`}
            style={{
              background: 'var(--input-bg)',
              borderColor: 'var(--input-border)',
              color: todo.completed ? 'var(--text-muted)' : 'var(--text-primary)',
            }}
          />
          <textarea
            value={descriptionDraft}
            disabled={!canManage || busy}
            onChange={(event) => setDescriptionDraft(event.target.value)}
            onBlur={commitDescription}
            rows={2}
            placeholder="描述"
            className="w-full resize-none rounded-md border px-2 py-1.5 text-[12px] leading-5 focus:outline-none focus:border-blue-500/30 placeholder:!text-[var(--placeholder-color)] disabled:opacity-70"
            style={{
              background: 'var(--input-bg)',
              borderColor: 'var(--input-border)',
              color: 'var(--text-secondary)',
            }}
          />
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            更新于 {new Date(todo.updated_at || todo.created_at).toLocaleString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}
          </div>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => onDelete(todo)}
            disabled={busy}
            title="删除待办"
            aria-label="删除待办"
            className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} /> : <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />}
          </button>
        )}
      </div>
    </div>
  )
}

export function ProjectTodosPanel({ projectId, canManage }: ProjectTodosPanelProps) {
  const [items, setItems] = useState<ProjectTodo[]>([])
  const [newTitle, setNewTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')

  const sortedItems = useMemo(() => sortTodos(items), [items])
  const activeItems = sortedItems.filter((item) => !item.completed)
  const completedItems = sortedItems.filter((item) => item.completed)

  const setTodoBusy = (id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (busy) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const loadTodos = async () => {
    if (!projectId) return
    setLoading(true)
    setError('')
    try {
      const data = await api(`/api/projects/${projectId}/todos`)
      setItems(Array.isArray(data?.items) ? data.items : [])
    } catch (e: any) {
      setError(e?.message || '读取项目待办失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let alive = true
    const run = async () => {
      if (!projectId) return
      setLoading(true)
      setError('')
      try {
        const data = await api(`/api/projects/${projectId}/todos`)
        if (alive) setItems(Array.isArray(data?.items) ? data.items : [])
      } catch (e: any) {
        if (alive) setError(e?.message || '读取项目待办失败')
      } finally {
        if (alive) setLoading(false)
      }
    }
    run()
    return () => { alive = false }
  }, [projectId])

  const addTodo = async () => {
    const title = newTitle.trim()
    if (!title || creating || !canManage) return
    setCreating(true)
    setError('')
    try {
      const todo = await api(`/api/projects/${projectId}/todos`, {
        method: 'POST',
        body: JSON.stringify({ title }),
      })
      setItems((prev) => sortTodos([...prev, todo]))
      setNewTitle('')
    } catch (e: any) {
      setError(e?.message || '添加项目待办失败')
    } finally {
      setCreating(false)
    }
  }

  const updateTodo = async (
    todo: ProjectTodo,
    patch: Partial<Pick<ProjectTodo, 'title' | 'description' | 'completed'>>,
  ) => {
    if (!canManage || busyIds.has(todo.id)) return
    const previous = items
    setTodoBusy(todo.id, true)
    setError('')
    setItems((prev) => sortTodos(prev.map((item) => item.id === todo.id ? { ...item, ...patch } : item)))
    try {
      const updated = await api(`/api/projects/${projectId}/todos/${todo.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      setItems((prev) => sortTodos(prev.map((item) => item.id === todo.id ? updated : item)))
    } catch (e: any) {
      setItems(previous)
      setError(e?.message || '保存项目待办失败')
    } finally {
      setTodoBusy(todo.id, false)
    }
  }

  const deleteTodo = async (todo: ProjectTodo) => {
    if (!canManage || busyIds.has(todo.id)) return
    const previous = items
    setTodoBusy(todo.id, true)
    setError('')
    setItems((prev) => prev.filter((item) => item.id !== todo.id))
    try {
      await api(`/api/projects/${projectId}/todos/${todo.id}`, { method: 'DELETE' })
    } catch (e: any) {
      setItems(previous)
      setError(e?.message || '删除项目待办失败')
    } finally {
      setTodoBusy(todo.id, false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>项目待办</h3>
          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {activeItems.length} 未完成 · {completedItems.length} 已完成
          </div>
        </div>
        <button
          type="button"
          onClick={loadTodos}
          disabled={loading}
          className="h-8 px-3 rounded-lg text-[12px] bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors border border-blue-500/20 disabled:opacity-50"
        >
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {canManage && (
        <div className="flex items-center gap-2">
          <input
            value={newTitle}
            disabled={creating}
            data-text-redaction-ignore="true"
            onChange={(event) => setNewTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addTodo()
              }
            }}
            placeholder="新增待办"
            className="h-9 min-w-0 flex-1 rounded-lg border px-3 text-[13px] focus:outline-none focus:border-blue-500/30 placeholder:!text-[var(--placeholder-color)] disabled:opacity-60"
            style={{
              background: 'var(--input-bg)',
              borderColor: 'var(--input-border)',
              color: 'var(--text-primary)',
            }}
          />
          <button
            type="button"
            onClick={addTodo}
            disabled={creating || !newTitle.trim()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-500/20 bg-blue-500/15 px-3 text-[12px] text-blue-400 transition-colors hover:bg-blue-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} /> : <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />}
            添加
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="rounded-lg border px-3 py-8 text-center text-[12px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
          正在读取项目待办...
        </div>
      ) : sortedItems.length === 0 ? (
        <div className="rounded-lg border border-dashed px-3 py-8 text-center text-[12px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
          暂无项目待办
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            {activeItems.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                canManage={canManage}
                busy={busyIds.has(todo.id)}
                onUpdate={updateTodo}
                onDelete={deleteTodo}
              />
            ))}
          </div>
          {completedItems.length > 0 && (
            <div className="space-y-2 border-t pt-3" style={{ borderColor: 'var(--border-color)' }}>
              {completedItems.map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  canManage={canManage}
                  busy={busyIds.has(todo.id)}
                  onUpdate={updateTodo}
                  onDelete={deleteTodo}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
