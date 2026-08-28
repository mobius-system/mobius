import { useState, useEffect, useCallback, useMemo } from 'react'
import { api, useStore } from '../store'

// =====================================================================
// CopyFromCatalogModal — 新建 Skill / Memory 时「从其他用户和其他项目复制」
//   - GET  {catalogUrl}            列出全平台所有用户级/项目级条目
//   - GET  {catalogUrl}/{id}       拿单条 body 预览
//   - POST {copyUrl} { source_id } 快照复制到当前 scope (用户级 / 某项目级)
// 复制后是独立副本, 源后续修改不影响副本.
// 默认隐藏「当前用户自己的用户级」条目 (那些已在"我的"里, 不算"从其他人复制").
// =====================================================================
export function CopyFromCatalogModal({
  kind, catalogUrl, copyUrl, targetLabel, onClose, onCopied,
}: {
  kind: 'skill' | 'memory'
  catalogUrl: string
  copyUrl: string
  targetLabel: string
  onClose: () => void
  onCopied: () => void
}) {
  const { user } = useStore()
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set())
  const [viewing, setViewing] = useState<{ id: string; name: string } | null>(null)

  const noun = kind === 'skill' ? 'Skill' : 'Memory'
  const visibilityLabel = (value: any, itemScope: string) => {
    if (value === 'inherit') return itemScope === 'project' ? '继承项目' : '仅自己'
    if (value === 'team') return '同组'
    if (value === 'public') return '公开'
    if (value === 'allowlist') return '指定用户'
    return '仅自己'
  }

  const refresh = useCallback(() => {
    setLoading(true); setErr('')
    api(catalogUrl)
      .then((arr: any[]) => { setItems(Array.isArray(arr) ? arr : []); setLoading(false) })
      .catch(e => { setErr(e?.message || '加载失败'); setItems([]); setLoading(false) })
  }, [catalogUrl])

  useEffect(() => { refresh() }, [refresh])

  // 过滤掉「自己的用户级」(已是"我的"); 其余按搜索词过滤.
  const visible = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return items
      .filter(it => !(it.scope === 'user' && user && it.owner_id === user.id))
      .filter(it => !kw
        || (it.name || '').toLowerCase().includes(kw)
        || (it.description || '').toLowerCase().includes(kw))
  }, [items, q, user])

  const groups = useMemo(() => {
    const proj = visible.filter(it => it.scope === 'project')
    const usr = visible.filter(it => it.scope === 'user')
    return [
      { key: 'user', label: '其他用户 (用户级)', rows: usr },
      { key: 'project', label: '项目级 (所有项目)', rows: proj },
    ].filter(g => g.rows.length > 0)
  }, [visible])

  const handleCopy = async (it: any) => {
    setBusyId(it.id); setErr('')
    try {
      await api(copyUrl, { method: 'POST', body: JSON.stringify({ source_id: it.id }) })
      setDoneIds(prev => new Set(prev).add(it.id))
      onCopied()
    } catch (e: any) {
      setErr(e?.message || '复制失败')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-[820px] max-h-[85vh] rounded-2xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              从其他用户/项目复制 {noun}
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded border" style={{ borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
              复制到: {targetLabel}
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors" style={{ color: 'var(--text-muted)' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="px-5 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)}
            placeholder={`搜索 ${noun} 名称 / 描述...`}
            className="w-full px-2.5 py-1.5 rounded text-[12px] focus:outline-none focus:border-blue-500/30"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
          <p className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>
            复制是快照: 复制后与源彼此独立, 源后续修改不会影响副本. 列表已隐藏你自己的用户级 {noun}.
          </p>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-4">
          {err && <pre className="text-[11px] text-red-400 whitespace-pre-wrap break-all">{err}</pre>}
          {loading ? (
            <div className="text-[12px] py-6 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          ) : groups.length === 0 ? (
            <div className="text-[12px] py-6 text-center" style={{ color: 'var(--text-muted)' }}>
              没有可复制的 {noun}{q.trim() ? '(尝试清空搜索)' : ''}
            </div>
          ) : groups.map(g => (
            <div key={g.key}>
              <div className="text-[13px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
                {g.label} · {g.rows.length}
              </div>
              <div className="space-y-2">
                {g.rows.map(it => {
                  const done = doneIds.has(it.id)
                  const isProject = it.scope === 'project'
                  return (
                    <div key={it.id} className="p-3 bg-[var(--bg-card)] rounded-lg hover:bg-[var(--bg-card-hover)] transition-colors">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{it.name}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded border"
                              style={isProject
                                ? { color: '#22c55e', background: 'rgba(34,197,94,0.10)', borderColor: 'rgba(34,197,94,0.25)' }
                                : { color: '#60a5fa', background: 'rgba(96,165,250,0.10)', borderColor: 'rgba(96,165,250,0.25)' }}>
                              {isProject ? '项目级' : '用户级'}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded"
                              style={{ color: '#60a5fa', background: 'rgba(96,165,250,0.08)' }}>
                              {visibilityLabel(it.visibility, it.scope)}
                            </span>
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              {isProject ? `项目 ${it.owner_id}` : `用户 ${it.owner_id}`}
                              {it.created_by && it.created_by !== it.owner_id ? ` · by ${it.created_by}` : ''}
                            </span>
                            {typeof it.body_length === 'number' && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap" style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)' }}>
                                {it.body_length} 字符
                              </span>
                            )}
                          </div>
                          {it.description && (
                            <p className="text-[11px] line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{it.description}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button onClick={() => setViewing({ id: it.id, name: it.name })} title={`查看 ${noun} 内容`}
                            className="h-7 px-2 text-[11px] rounded border transition-colors hover:bg-[var(--bg-hover)]"
                            style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>查看</button>
                          <button onClick={() => handleCopy(it)} disabled={busyId === it.id || done}
                            className="h-7 px-2.5 text-[11px] rounded border transition-colors hover:bg-blue-500/10 hover:text-blue-400 disabled:opacity-50"
                            style={done
                              ? { color: '#22c55e', borderColor: 'rgba(34,197,94,0.4)' }
                              : { color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                            {busyId === it.id ? '复制中…' : done ? '✓ 已复制' : '复制到这里'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border-color)' }}>
          <button onClick={onClose}
            className="h-8 px-4 text-[12px] rounded border"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>完成</button>
        </div>
      </div>

      {viewing && (
        <CatalogBodyViewer
          url={`${catalogUrl}/${encodeURIComponent(viewing.id)}`}
          title={viewing.name}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}

// 目录条目内容预览 (复用 GET {catalogUrl}/{id}, 返回含 body 的详情)
function CatalogBodyViewer({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  useEffect(() => {
    api(url)
      .then((d: any) => { setBody(d?.body || ''); setLoading(false) })
      .catch(e => { setErr(e?.message || '加载失败'); setLoading(false) })
  }, [url])
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-[760px] max-h-[80vh] rounded-2xl shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors" style={{ color: 'var(--text-muted)' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-auto p-5">
          {loading ? <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
            : err ? <div className="text-[12px] text-red-400">{err}</div>
            : <pre className="text-[12px] leading-relaxed whitespace-pre-wrap font-mono p-4 rounded-xl border"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-primary)' }}>{body}</pre>}
        </div>
      </div>
    </div>
  )
}
