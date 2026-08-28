import type { CodeArtifactTarget } from './code-artifacts/file-target'

export type SessionToolOrigin = 'session' | 'issue' | 'research' | 'message'

export type SessionToolObjectContext = {
  origin: SessionToolOrigin
  originLabel: string
  target: CodeArtifactTarget | null
  trigger: HTMLElement | null
}

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/
const UNC_PATH = /^(?:\\\\|\/\/)/

function normalizedSegments(value: string) {
  return String(value || '')
    .trim()
    .replace(/^file:\/\//i, '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment && segment !== '.')
}

export function isAbsoluteToolPath(value: string) {
  const path = String(value || '').trim()
  return path.startsWith('/') || path.startsWith('~/') || WINDOWS_ABSOLUTE.test(path) || UNC_PATH.test(path)
}

/**
 * Session tools never need to echo an unverified absolute path. Relative paths
 * retain their useful project context; absolute paths are reduced to basename
 * until the project file API has resolved them inside the authorized workspace.
 */
export function safeToolPathLabel(value: string) {
  const raw = String(value || '').trim()
  if (!raw) return '当前对象'
  const segments = normalizedSegments(raw)
  const basename = segments.at(-1) || '当前对象'
  if (isAbsoluteToolPath(raw) || segments.includes('..')) return basename
  return segments.join('/') || basename
}

export function safeToolDirectoryLabel(target?: CodeArtifactTarget | null) {
  if (!target?.path) return ''
  if (isAbsoluteToolPath(target.path)) return ''
  const segments = normalizedSegments(target.path)
  if (segments.includes('..') || segments.length < 2) return ''
  return segments.slice(0, -1).join('/')
}

export function sanitizeToolError(value: unknown, fallback: string) {
  const message = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : ''
  if (!message.trim()) return fallback
  if (/ENOENT|no such file or directory/i.test(message)) {
    return '当前工作区已找不到这个文件，可能已被删除或路径已变化'
  }
  return message
    .replace(/file:\/\/[^\s"'`<>]+/gi, '受限路径')
    .replace(/[A-Za-z]:[\\/][^\s"'`<>]+/g, '受限路径')
    .replace(/(^|[\s"'`])(\/(?:Users|home|private|var|tmp|opt|srv|mnt|Volumes|workspace|workspaces)\/[^\s"'`<>]+)/g, '$1受限路径')
}

export function sessionToolOriginLabel(origin: SessionToolOrigin, entityLabel = '') {
  if (origin === 'message') return '来源消息'
  if (origin === 'issue') return entityLabel ? `Issue · ${entityLabel}` : '来源 Issue'
  if (origin === 'research') return entityLabel ? `Research · ${entityLabel}` : '来源 Research'
  return '来源会话'
}
