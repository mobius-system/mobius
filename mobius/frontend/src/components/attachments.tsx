// =====================================================================
// 附件上传共享模块 — 供「新建 Session」两个入口共用 (传统两步菜单 + 顶栏一步快捷菜单).
//
// 抽成独立模块的原因: global-create.tsx 已经单向 import modals.tsx, 若 modals 再反向
// import global-create 会形成环依赖; 故把附件相关原语 + 整合壳放到这个无依赖的中立
// 文件里, 两个入口各自按需引入.
//
// 提供: Attachment 类型 / newAttId / formatFileSize / uploadAttachmentFile /
//       appendAttachmentsToDesc / AttachmentComposer (整合附件输入壳)
//
// AttachmentComposer = 单一边框容器内依次放 [附件芯片] + children(文本框) + [上传工具条],
// 拖拽 / Ctrl+V 粘贴 / 点击上传三合一, 与快捷菜单的融合输入框形态一致.
// =====================================================================
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Paperclip, X } from 'lucide-react'

export type Attachment = {
  id: string
  name: string
  size: number
  path?: string
  previewUrl?: string
  kind: 'image' | 'file'
  status: 'uploading' | 'done' | 'error'
  error?: string
}

let _attSeq = 0
export function newAttId() { _attSeq += 1; return `att-${Date.now()}-${_attSeq}` }

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 上传单文件到 /api/upload (FormData field 'file'); 不能复用 store.api (它默认 JSON header).
export async function uploadAttachmentFile(file: File, projectId?: string): Promise<{ path: string; name: string; size: number }> {
  const token = localStorage.getItem('cc-token') || ''
  const form = new FormData()
  form.append('file', file, file.name)
  const url = projectId ? `/api/upload?project_id=${encodeURIComponent(projectId)}` : '/api/upload'
  const res = await fetch(url, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  })
  const data = await res.json().catch(() => ({} as any))
  if (!res.ok) throw new Error(data?.error || `上传失败 (HTTP ${res.status})`)
  return { path: data.path, name: data.name, size: data.size }
}

// 把附件以 markdown 追加到描述末尾, 供后端 agent 在服务器侧访问.
export function appendAttachmentsToDesc(desc: string, atts: Attachment[]): string {
  const done = atts.filter(a => a.status === 'done' && a.path)
  if (done.length === 0) return desc
  const lines = done.map(a => a.kind === 'image' ? `![${a.name}](${a.path})` : `📎 [${a.name}](${a.path})`)
  return `${desc.replace(/\s+$/, '')}\n\n--- 附件 ---\n${lines.join('\n')}`
}

// 整合附件输入壳: 单一边框容器内依次放 [附件芯片] + children(文本框) + [上传工具条].
// children 应是**无边框透明背景**的文本输入 (border-0 bg-transparent), 外边框由本组件统一提供.
// 拖拽 / Ctrl+V 粘贴 / 点击上传三合一. 一个弹窗内只挂一个实例, 避免粘贴重复入列.
export function AttachmentComposer({ attachments, setAttachments, projectId, dark, children }: {
  attachments: Attachment[]
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>
  projectId?: string
  dark: boolean
  children: ReactNode
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files)
    arr.forEach(file => {
      const isImg = file.type.startsWith('image/')
      const att: Attachment = {
        id: newAttId(), name: file.name, size: file.size,
        previewUrl: isImg ? URL.createObjectURL(file) : undefined,
        kind: isImg ? 'image' : 'file', status: 'uploading',
      }
      setAttachments(prev => [...prev, att])
      uploadAttachmentFile(file, projectId)
        .then(res => setAttachments(prev => prev.map(a => a.id === att.id ? { ...a, status: 'done', path: res.path } : a)))
        .catch(e => setAttachments(prev => prev.map(a => a.id === att.id ? { ...a, status: 'error', error: e?.message || '上传失败' } : a)))
    })
  }, [projectId, setAttachments])

  // 全局粘贴监听 (挂载期间): 仅处理图片.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const imgs: File[] = []
      for (let i = 0; i < items.length; i += 1) {
        const f = items[i].getAsFile()
        if (f && f.type.startsWith('image/')) imgs.push(f)
      }
      if (imgs.length > 0) { e.preventDefault(); addFiles(imgs) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFiles])

  const remove = (id: string) => setAttachments(prev => {
    const target = prev.find(a => a.id === id)
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
    return prev.filter(a => a.id !== id)
  })

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files) }}
      className="relative rounded-xl transition-colors focus-within:border-blue-500/40"
      style={{ background: 'var(--input-bg)', border: `1px solid ${dragOver ? 'rgba(59,130,246,0.6)' : 'var(--input-border)'}` }}
    >
      <input ref={fileRef} type="file" multiple className="hidden" onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = '' }} />
      {attachments.length > 0 && (
        <div className="flex flex-wrap items-start gap-1.5 px-3 pt-2.5">
          {attachments.map(a => (
            <div key={a.id} className="relative group flex-shrink-0" title={`${a.name}${a.size ? ` · ${formatFileSize(a.size)}` : ''}`}>
              {a.kind === 'image' && a.previewUrl ? (
                <div className="w-9 h-9 rounded-md overflow-hidden relative" style={{ background: dark ? '#111827' : '#fff', border: '1px solid var(--input-border)' }}>
                  <img src={a.previewUrl} alt={a.name} className="w-full h-full object-cover" />
                  {a.status === 'uploading' && <div className="absolute inset-0 bg-black/40" />}
                  {a.status === 'error' && <div className="absolute inset-0 bg-red-500/60 text-white text-[9px] flex items-center justify-center">失败</div>}
                </div>
              ) : (
                <div className="h-9 px-2 rounded-md flex items-center gap-1 text-[10px]"
                  style={{ background: dark ? '#111827' : '#fff', border: '1px solid var(--input-border)', color: 'var(--text-secondary)' }}>
                  <Paperclip className="w-3 h-3" /><span className="max-w-[80px] truncate">{a.name}</span>
                </div>
              )}
              <button type="button" onClick={() => remove(a.id)}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <X className="w-2.5 h-2.5" strokeWidth={3} />
              </button>
            </div>
          ))}
        </div>
      )}
      {children}
      <div className="flex items-center gap-2 px-3 pb-2">
        <button type="button" onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-lg text-[12px] transition-colors hover:bg-[var(--bg-card-hover)]"
          style={{ color: 'var(--text-secondary)' }}>
          <Paperclip className="w-3.5 h-3.5" /> 附件
        </button>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{attachments.length > 0 ? `${attachments.filter(a => a.status === 'done').length}/${attachments.length} 已上传` : '可粘贴截图或拖入文件'}</span>
      </div>
    </div>
  )
}
