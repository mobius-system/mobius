// ProjectFileSource — 统一中枢 REST 与 Electron 本机 IPC 的文件操作抽象。
// 原生编辑器右键菜单只依赖此接口, 不直接判断 REST 或 IPC (设计文档 §10)。
// 两种实现统一抛出 FileOperationError(code), 菜单层只据 code 选文案。
import type { Entry } from '../project-files'
import { FileOperationError, type FileOperationErrorCode, type FileSourceKind } from './file-tree-ops'

export type FileListResult = { entries: Entry[] }
export type FileCopyResult = { path: string; type: 'file' | 'dir' }
export type FileRenameResult = { oldPath: string; path: string; name: string }
export type FileCreateKind = 'file' | 'dir'
export type FileCreateResult = { path: string; type: FileCreateKind; name: string }

export interface ProjectFileSource {
  readonly kind: FileSourceKind
  readonly rootPath: string
  readonly writable: boolean
  listDir(relPath: string): Promise<FileListResult>
  downloadFile(relPath: string): Promise<void>
  copyEntry(sourcePath: string, targetDir: string): Promise<FileCopyResult>
  renameEntry(relPath: string, newName: string): Promise<FileRenameResult>
  createEntry(parentPath: string, name: string, kind: FileCreateKind): Promise<FileCreateResult>
}

// 读响应错误体 { error, code } 并抛 FileOperationError; 成功直接返回。
async function throwIfFileOpError(res: Response): Promise<void> {
  if (res.ok) return
  let code: FileOperationErrorCode = 'UNKNOWN'
  let msg = `HTTP ${res.status}`
  try {
    const data = await res.json()
    if (data?.error) msg = String(data.error)
    if (data?.code) code = data.code as FileOperationErrorCode
  } catch {
    /* 非 JSON 错误体, 保留 HTTP 状态文案 */
  }
  throw new FileOperationError(code, msg)
}

function triggerBlobDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

// 中枢 REST 数据源。download 用带 Authorization 的 fetch 取 Blob 再触发下载 (api 助手会吞 code)。
export class HubProjectFileSource implements ProjectFileSource {
  readonly kind = 'hub' as const
  constructor(readonly projectId: string, readonly rootPath: string, readonly writable: boolean) {}
  private token(): string {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('cc-token')) || ''
  }
  private authHeaders(): Record<string, string> {
    const t = this.token()
    return t ? { Authorization: `Bearer ${t}` } : {}
  }
  async listDir(relPath: string): Promise<FileListResult> {
    const res = await fetch(`/api/projects/${this.projectId}/files?path=${encodeURIComponent(relPath)}`, { headers: this.authHeaders() })
    await throwIfFileOpError(res)
    const data = await res.json()
    return { entries: (data?.entries || []) as Entry[] }
  }
  async downloadFile(relPath: string): Promise<void> {
    const res = await fetch(`/api/projects/${this.projectId}/file/download?path=${encodeURIComponent(relPath)}`, { headers: this.authHeaders() })
    await throwIfFileOpError(res)
    const blob = await res.blob()
    const name = relPath.split('/').filter(Boolean).pop() || 'download'
    triggerBlobDownload(blob, name)
  }
  async copyEntry(sourcePath: string, targetDir: string): Promise<FileCopyResult> {
    const res = await fetch(`/api/projects/${this.projectId}/files/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ sourcePath, targetDir }),
    })
    await throwIfFileOpError(res)
    const data = await res.json()
    return { path: data.path, type: data.type === 'dir' ? 'dir' : 'file' }
  }
  async renameEntry(relPath: string, newName: string): Promise<FileRenameResult> {
    const res = await fetch(`/api/projects/${this.projectId}/files/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ path: relPath, newName }),
    })
    await throwIfFileOpError(res)
    return await res.json()
  }
  async createEntry(parentPath: string, name: string, kind: FileCreateKind): Promise<FileCreateResult> {
    const endpoint = kind === 'dir' ? 'mkdir' : 'create'
    const res = await fetch(`/api/projects/${this.projectId}/files/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ parentPath, name }),
    })
    await throwIfFileOpError(res)
    const data = await res.json()
    return { path: data.path, type: data.type === 'dir' ? 'dir' : 'file', name: data.name || name }
  }
}

type LocalFileOpResult = {
  ok?: boolean
  error?: string
  code?: string
  path?: string
  type?: string
  oldPath?: string
  name?: string
  entries?: Entry[]
}

// Electron 本机数据源需要的 bridge 形状 (window.mobiusDesktop 子集)。
export type DesktopFileBridge = {
  listProjectLocalFiles(projectId: string, path: string): Promise<LocalFileOpResult & { bind_path?: string }>
  downloadProjectLocalFile(projectId: string, path: string): Promise<LocalFileOpResult>
  copyProjectLocalEntry(projectId: string, sourcePath: string, targetDir: string): Promise<LocalFileOpResult>
  renameProjectLocalEntry(projectId: string, path: string, newName: string): Promise<LocalFileOpResult>
}

// Electron 本机数据源。所有路径由主进程重新校验; 这里只把 { ok, error, code } 归一成异常。
export class LocalProjectFileSource implements ProjectFileSource {
  readonly kind = 'local' as const
  constructor(readonly projectId: string, readonly rootPath: string, readonly writable: boolean, private bridge: DesktopFileBridge) {}
  private unwrap(r: LocalFileOpResult, fallback: string): void {
    if (r?.ok) return
    throw new FileOperationError((r?.code as FileOperationErrorCode) || 'UNKNOWN', r?.error || fallback)
  }
  async listDir(relPath: string): Promise<FileListResult> {
    const r = await this.bridge.listProjectLocalFiles(this.projectId, relPath)
    this.unwrap(r, '加载本机文件失败')
    return { entries: r.entries || [] }
  }
  async downloadFile(relPath: string): Promise<void> {
    const r = await this.bridge.downloadProjectLocalFile(this.projectId, relPath)
    // CANCELLED (保存对话框取消) 不应弹错误; unwrap 也抛出, 由调用方按 code 判定静默。
    this.unwrap(r, '下载失败')
  }
  async copyEntry(sourcePath: string, targetDir: string): Promise<FileCopyResult> {
    const r = await this.bridge.copyProjectLocalEntry(this.projectId, sourcePath, targetDir)
    this.unwrap(r, '复制失败')
    return { path: r.path || '', type: r.type === 'dir' ? 'dir' : 'file' }
  }
  async renameEntry(relPath: string, newName: string): Promise<FileRenameResult> {
    const r = await this.bridge.renameProjectLocalEntry(this.projectId, relPath, newName)
    this.unwrap(r, '重命名失败')
    return { oldPath: r.oldPath || relPath, path: r.path || relPath, name: r.name || newName }
  }
  async createEntry(_parentPath: string, _name: string, _kind: FileCreateKind): Promise<FileCreateResult> {
    throw new FileOperationError('READ_ONLY', '本机文件创建暂未接入桌面端')
  }
}
