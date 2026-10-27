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
// AttachmentComposer = 单一边框容器内依次放 [附件芯片] + children(文本框, 右列绝对定位附件按钮) + [上传状态提示行],
// 拖拽 / Ctrl+V 粘贴 / 点击上传三合一, 与快捷菜单的融合输入框形态一致.
// =====================================================================
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Paperclip, X, ZoomIn } from 'lucide-react'

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

// 多种常见扩展名 → 简短分类标签 (用于无缩略图的文件芯片)
export function fileExtBadge(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (!ext || ext === name.toLowerCase()) return 'FILE'
  return ext.slice(0, 4).toUpperCase()
}

export type AttachmentImagePreview = {
  id: string
  name: string
  src: string
}

// 输入框附件芯片: 图片缩略图 (点击放大) / 文件短标签 + 删除按钮 + 上传状态.
// 欢迎页 / 简易会话内 / 专业模式三处共用同一个芯片 —— 位置与样式必须一致,
// 否则同一个附件在不同页面长得不一样 (issue 2026-10-26).
export function AttachmentChip({ att, theme, onRemove, onPreview }: {
  att: Attachment
  theme: 'dark' | 'light' | 'purple'
  onRemove: () => void
  onPreview?: (preview: AttachmentImagePreview) => void
}) {
  const isImage = att.kind === 'image' && att.previewUrl
  const isDark = theme !== 'light'
  const baseStyle: CSSProperties = {
    background: isDark ? '#111827' : '#ffffff',
    border: `1px solid ${isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.10)'}`,
  }
  const fileLabel = fileExtBadge(att.name).slice(0, 2)
  return (
    <div className="relative group flex-shrink-0" title={`${att.name}${att.size ? ` · ${formatFileSize(att.size)}` : ''}`}>
      {isImage ? (
        <button
          type="button"
          onClick={() => onPreview?.({ id: att.id, name: att.name, src: att.previewUrl! })}
          className="w-6 h-6 rounded-md overflow-hidden relative block text-left focus:outline-none focus:ring-2 focus:ring-blue-500/35 cursor-zoom-in"
          style={baseStyle}
          title={`${att.name} · 点击预览`}
          aria-label={`预览图片 ${att.name}`}>
          <img src={att.previewUrl} alt={att.name} className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-black/35 text-white opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity inline-flex items-center justify-center">
            <ZoomIn className="w-3 h-3" strokeWidth={2.2} />
          </div>
          {att.status === 'uploading' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <svg className="w-3 h-3 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
              </svg>
            </div>
          )}
          {att.status === 'error' && (
            <div className="absolute inset-0 flex items-center justify-center bg-red-500/60 text-white text-[length:var(--fs-xs)] font-semibold" title={att.error}>
              失败
            </div>
          )}
        </button>
      ) : (
        <div
          className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 relative text-[length:var(--fs-2xs)] font-semibold leading-none"
          style={{ ...baseStyle, color: isDark ? '#bfdbfe' : '#2563eb' }}>
          <span>{fileLabel}</span>
          {att.status === 'uploading' && (
            <div className="absolute inset-0 rounded-md flex items-center justify-center bg-black/50">
              <svg className="w-3 h-3 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
              </svg>
            </div>
          )}
          {att.status === 'error' && (
            <div className="absolute inset-0 rounded-md flex items-center justify-center bg-red-500/70 text-white text-[length:var(--fs-2xs)] font-semibold" title={att.error}>
              !
            </div>
          )}
        </div>
      )}
      <button type="button" onClick={(e) => { e.stopPropagation(); onRemove() }}
        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center text-white shadow opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
        style={{ background: '#1f2937' }}
        title="移除">
        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6L18 18" />
        </svg>
      </button>
    </div>
  )
}

// 图片放大预览弹层 (点击附件缩略图打开)
export function AttachmentImagePreviewModal({ preview, onClose }: {
  preview: AttachmentImagePreview
  onClose: () => void
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-black/80 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`图片预览 ${preview.name}`}>
      <button className="absolute inset-0 cursor-zoom-out" type="button" aria-label="关闭图片预览" onClick={onClose} />
      <div className="relative z-10 h-12 flex items-center justify-between gap-3 px-4 border-b border-white/10 text-white">
        <div className="min-w-0 text-[length:var(--fs-lg)] font-medium truncate">{preview.name}</div>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          aria-label="关闭"
          className="h-8 w-8 rounded-full inline-flex items-center justify-center text-white/80 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0">
          <X className="w-4 h-4" strokeWidth={2} />
        </button>
      </div>
      <div className="relative z-10 flex-1 min-h-0 flex items-center justify-center p-4 sm:p-6 pointer-events-none">
        <img
          src={preview.src}
          alt={preview.name}
          className="max-w-full max-h-full object-contain rounded-lg shadow-2xl pointer-events-auto"
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    </div>
  )
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

// 整合附件输入壳: 单一边框容器内依次放 [附件芯片] + children(文本框, 右列绝对定位附件按钮) + [上传状态提示行].
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
                  {a.status === 'error' && <div className="absolute inset-0 bg-red-500/60 text-white text-[length:var(--fs-2xs)] flex items-center justify-center">失败</div>}
                </div>
              ) : (
                <div className="h-9 px-2 rounded-md flex items-center gap-1 text-[length:var(--fs-xs)]"
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
      {/* 附件上传按钮: 与 NewSessionModal 描述框 innerControl (稍后再写) 同款样式,
          绝对定位在其正下方 — innerControl 在 top-10(2.5rem)/h-6, 故 top-[4.5rem] 保持
          与 展开→稍后再写 相同的 8px 间距节奏; 包在 children 外层 relative 里,
          附件芯片出现时随文本框一起下移, 永远贴着文本框右列. */}
      <div className="relative">
        {children}
        <button type="button" onClick={() => fileRef.current?.click()}
          className="absolute right-2 top-[4.5rem] inline-flex h-6 w-20 items-center gap-1 whitespace-nowrap rounded-lg border px-1.5 text-[length:var(--fs-xs)] transition-colors hover:bg-blue-500/10"
          style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)', background: 'var(--input-bg)' }}>
          <Paperclip className="h-3 w-3" strokeWidth={1.9} /> <span>附件</span>
        </button>
      </div>
      <div className="flex items-center gap-2 px-3 pb-2">
        <span className="text-[length:var(--fs-xs)]" style={{ color: 'var(--text-muted)' }}>{attachments.length > 0 ? `${attachments.filter(a => a.status === 'done').length}/${attachments.length} 已上传` : '可粘贴截图或拖入文件'}</span>
      </div>
    </div>
  )
}
