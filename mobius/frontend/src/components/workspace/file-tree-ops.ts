// 原生文件编辑器右键菜单: 纯逻辑与共享类型 (无 React 依赖, 便于单测)。
// 与后端 FileOpErrorCode / backend/services/project-file-ops.ts 保持一致。
import type { Entry, FileTreeTarget } from '../project-files'

export type { FileTreeTarget }

export type FileSourceKind = 'hub' | 'local'

// 统一错误码: REST 与 Electron IPC 共用, 菜单层只据此选择文案, 不解析字符串。
export type FileOperationErrorCode =
  | 'NOT_FOUND'
  | 'READ_ONLY'
  | 'CONFLICT'
  | 'INVALID_NAME'
  | 'OUTSIDE_ROOT'
  | 'SYMLINK_UNSUPPORTED'
  | 'TOO_LARGE'
  | 'CANCELLED'
  | 'UNKNOWN'

export class FileOperationError extends Error {
  readonly code: FileOperationErrorCode
  constructor(code: FileOperationErrorCode, message: string) {
    super(message)
    this.name = 'FileOperationError'
    this.code = code
  }
}

// 应用内文件剪贴板 (不写入系统剪贴板); 记录来源 projectId + source 以禁止跨项目/跨数据源粘贴。
export type FileClipboardItem = {
  projectId: string
  source: FileSourceKind
  relPath: string
  type: 'file' | 'dir'
  name: string
}

// posix dirname 用于 / 开头的相对路径。/ -> /; /a -> /; /a/b/c -> /a/b。
export function dirnameRel(relPath: string): string {
  const p = (relPath || '/').replace(/\/+$/g, '') || '/'
  if (p === '/') return '/'
  const idx = p.lastIndexOf('/')
  if (idx <= 0) return '/'
  return p.slice(0, idx)
}

export function joinRel(dir: string, name: string): string {
  if (dir === '/' || dir === '') return '/' + name
  return dir + '/' + name
}

// 粘贴目标目录: 右键目录->该目录; 右键文件->文件所在目录; 根空白->根目录('/')。
export function targetDirForPaste(target: FileTreeTarget | null): string {
  if (!target) return '/'
  return target.entry.type === 'dir' ? target.relPath : dirnameRel(target.relPath)
}

export type PasteCheck = { ok: boolean; reason?: string }

// 粘贴前置检查: 剪贴板非空、目标可写、同项目同数据源、非"目录复制到自身/子目录"。
export function canPaste(
  clip: FileClipboardItem | null,
  target: FileTreeTarget | null,
  currentProjectId: string,
  currentSource: FileSourceKind,
  writable: boolean,
): PasteCheck {
  if (!clip) return { ok: false, reason: '剪贴板为空' }
  if (!writable) return { ok: false, reason: '当前数据源只读' }
  if (clip.projectId !== currentProjectId || clip.source !== currentSource) {
    return { ok: false, reason: '暂不支持跨项目或跨数据源粘贴' }
  }
  const targetDir = targetDirForPaste(target)
  // 拒绝把目录复制到自身或其子目录 (否则递归爆炸)。
  if (clip.type === 'dir' && (clip.relPath === targetDir || targetDir.startsWith(clip.relPath + '/'))) {
    return { ok: false, reason: '不能将目录复制到自身或其子目录' }
  }
  return { ok: true }
}

const ERROR_MESSAGES: Record<FileOperationErrorCode, string> = {
  NOT_FOUND: '文件已不存在，文件树已刷新',
  READ_ONLY: '目标目录只读或无写权限',
  CONFLICT: '目标目录已存在同名文件或目录，请先重命名',
  INVALID_NAME: '名称不合法',
  OUTSIDE_ROOT: '路径越出项目根目录',
  SYMLINK_UNSUPPORTED: '不支持操作符号链接',
  TOO_LARGE: '目录过大（文件数量或总大小超限）',
  CANCELLED: '已取消',
  UNKNOWN: '操作失败，请重试',
}

// 错误码 -> 默认文案 (服务端未给 message 时用)。服务端给了可读 message 时调用方应优先用之。
export function errorCodeToMessage(code: FileOperationErrorCode | string | undefined): string {
  if (code && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code)) {
    return (ERROR_MESSAGES as Record<string, string>)[code]
  }
  return ERROR_MESSAGES.UNKNOWN
}

// 内联重命名的初始选区: 选中文件名主体 (到首个 '.'), 保留扩展名; 目录/隐藏文件全选。
export function selectRenameRange(name: string): { start: number; end: number } {
  const dot = name.indexOf('.')
  if (dot <= 0) return { start: 0, end: name.length }
  return { start: 0, end: dot }
}

// 客户端名称预校验 (与后端 validateNewName 同规则), 用于提交按钮启用态。
export function isNameValidClient(raw: string): boolean {
  const name = (raw || '').trim()
  if (!name || name.length > 255) return false
  if (name === '.' || name === '..') return false
  if (/[\/\\\x00-\x1f]/.test(name)) return false
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) return false
  return true
}

// 目录重命名后, 把 expanded 集合里以 oldRel 为前缀的路径迁移到 newRel。
export function migrateExpandedPaths(expanded: Set<string>, oldRel: string, newRel: string): Set<string> {
  const next = new Set<string>()
  for (const p of expanded) {
    if (p === oldRel) next.add(newRel)
    else if (p.startsWith(oldRel + '/')) next.add(newRel + p.slice(oldRel.length))
    else next.add(p)
  }
  return next
}
