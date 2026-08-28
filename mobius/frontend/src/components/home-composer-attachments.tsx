import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent } from 'react'
import { LoaderCircle, RefreshCw, X, ZoomIn } from 'lucide-react'
import { uploadAttachmentFile } from './attachments'
import {
  extractClipboardImageFiles,
  extractDroppedImageFiles,
  isImageFile,
} from '../services/home-composer-attachments'

export type HomeComposerAttachment = {
  id: string
  name: string
  size: number
  sourceFile: File
  previewUrl: string
  status: 'uploading' | 'done' | 'error'
  remotePath?: string
  error?: string
}

let attachmentSequence = 0

function makeAttachmentId() {
  attachmentSequence += 1
  return `home-att-${Date.now()}-${attachmentSequence}`
}

function revokePreview(previewUrl?: string) {
  if (!previewUrl) return
  try { URL.revokeObjectURL(previewUrl) } catch {}
}

function isFileDrag(types: readonly string[] | DOMStringList | undefined) {
  if (!types) return false
  return Array.from(types).some(type => (
    type === 'Files' || type === 'public.file-url' || type === 'application/x-moz-file'
  ))
}

export function useHomeComposerAttachments({
  projectId,
  onAttachmentsChanged,
}: {
  projectId: string
  onAttachmentsChanged?: () => void
}) {
  const [attachments, setAttachments] = useState<HomeComposerAttachment[]>([])
  const [isDraggingImages, setIsDraggingImages] = useState(false)
  const attachmentsRef = useRef<HomeComposerAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => () => {
    attachmentsRef.current.forEach(attachment => revokePreview(attachment.previewUrl))
  }, [])

  const startUpload = useCallback((attachment: HomeComposerAttachment) => {
    uploadAttachmentFile(attachment.sourceFile, projectId)
      .then(result => {
        setAttachments(current => current.map(item => (
          item.id === attachment.id
            ? { ...item, status: 'done', remotePath: result.path, size: result.size || item.size, error: undefined }
            : item
        )))
      })
      .catch(reason => {
        setAttachments(current => current.map(item => (
          item.id === attachment.id
            ? { ...item, status: 'error', error: reason?.message || '上传失败' }
            : item
        )))
      })
  }, [projectId])

  const addFiles = useCallback((values: FileList | File[]) => {
    const files = Array.from(values).filter(isImageFile)
    if (files.length === 0) return
    onAttachmentsChanged?.()
    const next = files.map(file => ({
      id: makeAttachmentId(),
      name: file.name || 'image',
      size: file.size || 0,
      sourceFile: file,
      previewUrl: URL.createObjectURL(file),
      status: 'uploading' as const,
    }))
    setAttachments(current => [...current, ...next])
    next.forEach(startUpload)
  }, [onAttachmentsChanged, startUpload])

  const retryAttachment = useCallback((id: string) => {
    const target = attachmentsRef.current.find(attachment => attachment.id === id)
    if (!target || target.status !== 'error') return
    onAttachmentsChanged?.()
    const retrying = { ...target, status: 'uploading' as const, error: undefined }
    setAttachments(current => current.map(attachment => attachment.id === id ? retrying : attachment))
    startUpload(retrying)
  }, [onAttachmentsChanged, startUpload])

  const removeAttachment = useCallback((id: string) => {
    onAttachmentsChanged?.()
    setAttachments(current => {
      const target = current.find(attachment => attachment.id === id)
      revokePreview(target?.previewUrl)
      return current.filter(attachment => attachment.id !== id)
    })
  }, [onAttachmentsChanged])

  const clearAttachments = useCallback(() => {
    const current = attachmentsRef.current
    if (current.length === 0) return
    current.forEach(attachment => revokePreview(attachment.previewUrl))
    attachmentsRef.current = []
    setAttachments([])
    onAttachmentsChanged?.()
  }, [onAttachmentsChanged])

  const handlePaste = useCallback((event: ClipboardEvent<HTMLElement>) => {
    const files = extractClipboardImageFiles(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }, [addFiles])

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event.dataTransfer?.types)) return
    event.preventDefault()
    setIsDraggingImages(true)
  }, [])

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget
    if (!nextTarget || !event.currentTarget.contains(nextTarget as Node)) setIsDraggingImages(false)
  }, [])

  const handleDrop = useCallback((event: DragEvent<HTMLElement>) => {
    setIsDraggingImages(false)
    if (!isFileDrag(event.dataTransfer?.types) && event.dataTransfer.files.length === 0) return
    event.preventDefault()
    const files = extractDroppedImageFiles(event.dataTransfer)
    if (files.length === 0) return
    addFiles(files)
  }, [addFiles])

  const handleFileInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) addFiles(event.target.files)
    event.target.value = ''
  }, [addFiles])

  return {
    attachments,
    readyAttachments: attachments.filter(attachment => attachment.status === 'done' && attachment.remotePath),
    anyUploading: attachments.some(attachment => attachment.status === 'uploading'),
    isDraggingImages,
    fileInputRef,
    openFilePicker: () => fileInputRef.current?.click(),
    handleFileInputChange,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    retryAttachment,
    removeAttachment,
    clearAttachments,
  }
}

function HomeComposerImagePreview({ attachment, onClose }: {
  attachment: HomeComposerAttachment
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
    <div
      className="workbench-layer-modal fixed inset-0 flex flex-col bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`图片预览 ${attachment.name}`}
    >
      <button type="button" className="absolute inset-0 cursor-zoom-out" aria-label="关闭图片预览" onClick={onClose} />
      <div className="relative z-10 flex h-12 items-center justify-between gap-3 border-b border-white/10 px-4 text-white">
        <div className="min-w-0 truncate text-[13px] font-medium">{attachment.name}</div>
        <button type="button" onClick={onClose} aria-label="关闭" title="关闭" className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-white/10 hover:text-white">
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
      <div className="pointer-events-none relative z-10 flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6">
        <img src={attachment.previewUrl} alt={attachment.name} className="pointer-events-auto max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
      </div>
    </div>
  )
}

export function HomeComposerAttachments({
  attachments,
  onRemove,
  onRetry,
}: {
  attachments: HomeComposerAttachment[]
  onRemove: (id: string) => void
  onRetry: (id: string) => void
}) {
  const [previewId, setPreviewId] = useState('')
  const preview = attachments.find(attachment => attachment.id === previewId) || null

  useEffect(() => {
    if (previewId && !preview) setPreviewId('')
  }, [preview, previewId])

  return (
    <>
      {attachments.length > 0 && (
        <div className="mb-1.5 flex max-h-24 flex-wrap items-start gap-2 overflow-y-auto px-2 pt-1" data-home-composer-attachments>
          {attachments.map(attachment => (
            <div key={attachment.id} className="group relative flex items-center gap-1.5" title={attachment.error || attachment.name}>
              <button
                type="button"
                onClick={() => setPreviewId(attachment.id)}
                className="relative block h-10 w-10 cursor-zoom-in overflow-hidden rounded-[var(--radius-control)] border"
                style={{ background: 'var(--surface-base)', borderColor: 'var(--border-strong)' }}
                aria-label={`放大图片 ${attachment.name}`}
              >
                <img src={attachment.previewUrl} alt={attachment.name} className="h-full w-full object-cover" />
                <span className="absolute inset-0 inline-flex items-center justify-center bg-black/35 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <ZoomIn className="h-3.5 w-3.5" strokeWidth={2.2} />
                </span>
                {attachment.status === 'uploading' && (
                  <span className="absolute inset-0 inline-flex items-center justify-center bg-black/45 text-white">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  </span>
                )}
                {attachment.status === 'error' && (
                  <span className="absolute inset-0 inline-flex items-center justify-center bg-black/65 text-[10px] font-medium text-white">失败</span>
                )}
              </button>
              {attachment.status === 'error' && (
                <button
                  type="button"
                  onClick={() => onRetry(attachment.id)}
                  className="workbench-control-sm inline-flex items-center gap-1 border px-1.5 text-[10px] font-medium hover:bg-[var(--surface-control-hover)]"
                  style={{ color: 'var(--status-danger)', borderColor: 'var(--status-danger-border)' }}
                  aria-label={`重试上传 ${attachment.name}`}
                  title={attachment.error || '上传失败'}
                >
                  <RefreshCw className="h-3 w-3" />
                  重试
                </button>
              )}
              <button
                type="button"
                onClick={() => onRemove(attachment.id)}
                className="absolute -right-1.5 -top-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full border opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                style={{ color: 'var(--text-primary)', background: 'var(--surface-overlay)', borderColor: 'var(--border-strong)' }}
                aria-label={`删除附件 ${attachment.name}`}
                title="删除附件"
              >
                <X className="h-2.5 w-2.5" strokeWidth={3} />
              </button>
            </div>
          ))}
        </div>
      )}
      {preview && <HomeComposerImagePreview attachment={preview} onClose={() => setPreviewId('')} />}
    </>
  )
}
