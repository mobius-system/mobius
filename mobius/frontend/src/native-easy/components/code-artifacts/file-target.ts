export type CodeArtifactIntent = 'preview' | 'diff' | 'history'
export type CodeArtifactSource = 'message' | 'code-block' | 'jsonl-tool' | 'diff' | 'git-log'

export type CodeArtifactTarget = {
  rawPath: string
  path: string
  line: number | null
  column: number | null
  endLine: number | null
  intent: CodeArtifactIntent
  source: CodeArtifactSource
  commitSha?: string | null
}

export type CodeArtifactOpenRequest = {
  target: CodeArtifactTarget
  trigger?: HTMLElement | null
}

export type CodeArtifactEditorRequest = {
  target: CodeArtifactTarget
  /** 区分对同一路径、同一范围的重复显式打开。 */
  requestKey: number
}

export type FileCandidateContext = 'text' | 'inline-code' | 'href' | 'trusted'

export type FileTargetParseOptions = {
  context?: FileCandidateContext
  intent?: CodeArtifactIntent
  source?: CodeArtifactSource
  commitSha?: string | null
}

export type ProjectPathMetadata = {
  bindPath?: string | null
  vscodeWorkspacePath?: string | null
}

export type ProjectRelativePathResult =
  | { ok: true; path: string }
  | { ok: false; code: 'metadata-unavailable' | 'outside-workspace' | 'unsupported-path'; error: string }

export type FormattedFileTarget = {
  basename: string
  parentPath: string | null
  lineLabel: string | null
  title: string
}

const HASH_LOCATION = /^(.*?)#L(\d+)(?:(?:C(\d+))|(?:-L?(\d+)))?$/i
const COLON_RANGE = /^(.*?):(\d+)-(\d+)$/
const COLON_LOCATION = /^(.*?):(\d+)(?::(\d+))?$/
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/
const UNC_PATH = /^(?:\\\\|\/\/)[^/\\]+[/\\][^/\\]+/
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const NUMERIC_DOTTED_BASENAME = /^\d+(?:\.\d+)+$/
const LIKELY_FILE_NAME = /(?:^|[/\\])(?:\.[A-Za-z][A-Za-z0-9_-]*|[^/\\]+\.[A-Za-z0-9+_-]*[A-Za-z][A-Za-z0-9+_-]*)$/

// These are application destinations, not paths in the selected project. Keep
// the list deliberately explicit so ordinary absolute project paths still work.
const APP_ROUTE_PREFIXES = [
  '/api/', '/u/', '/issues/', '/researches/', '/projects/', '/settings/', '/admin/',
  '/tasks/', '/welcome/', '/login/', '/easy_mode/', '/work/', '/thread/',
]
const APP_ROUTE_EXACT = new Set([
  '/api', '/settings', '/welcome', '/login', '/easy_mode', '/work', '/workspace',
  '/workspace/settings', '/workspace/reviews',
])

function safeDecode(value: string) {
  try { return decodeURIComponent(value) } catch { return value }
}

function positiveInteger(value?: string) {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function normalizeSeparators(value: string) {
  if (value.startsWith('\\\\')) return `//${value.slice(2).replace(/\\/g, '/')}`
  return value.replace(/\\/g, '/')
}

function trimWrappingPunctuation(value: string) {
  let next = value.trim()
  if (next.length >= 2 && ((next.startsWith('`') && next.endsWith('`')) || (next.startsWith('<') && next.endsWith('>')))) {
    next = next.slice(1, -1).trim()
  }
  return next
}

function parseFileUrl(raw: string) {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'file:') return null
    const hash = parsed.hash || ''
    let pathname = safeDecode(parsed.pathname)
    if (parsed.host && parsed.host !== 'localhost') pathname = `//${parsed.host}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1)
    return { path: pathname, hash }
  } catch {
    const body = raw.slice('file://'.length)
    const hashIndex = body.indexOf('#')
    const pathPart = hashIndex >= 0 ? body.slice(0, hashIndex) : body
    const hash = hashIndex >= 0 ? body.slice(hashIndex) : ''
    if (!pathPart) return null
    if (pathPart.startsWith('/')) return { path: safeDecode(pathPart), hash }
    if (WINDOWS_DRIVE.test(pathPart)) return { path: safeDecode(pathPart), hash }
    const slash = pathPart.indexOf('/')
    if (slash < 0) return null
    return { path: `//${pathPart.slice(0, slash)}${safeDecode(pathPart.slice(slash))}`, hash }
  }
}

function splitLocation(value: string) {
  const hash = value.match(HASH_LOCATION)
  if (hash) {
    const line = positiveInteger(hash[2])
    const column = positiveInteger(hash[3])
    const endLine = positiveInteger(hash[4])
    if (line !== null && (endLine === null || endLine >= line)) {
      return { path: hash[1], line, column, endLine }
    }
  }

  const range = value.match(COLON_RANGE)
  if (range) {
    const line = positiveInteger(range[2])
    const endLine = positiveInteger(range[3])
    if (line !== null && endLine !== null && endLine >= line) {
      return { path: range[1], line, column: null, endLine }
    }
  }

  const location = value.match(COLON_LOCATION)
  if (location) {
    const line = positiveInteger(location[2])
    if (line !== null) {
      return { path: location[1], line, column: positiveInteger(location[3]), endLine: null }
    }
  }
  return { path: value, line: null, column: null, endLine: null }
}

/** 外部编辑器只接受文件路径时，复用同一语法移除 line/column/range。 */
export function stripFileTargetLocation(value: string) {
  return splitLocation(String(value || '')).path
}

function isAppRoute(path: string) {
  const normalized = normalizeSeparators(path).replace(/\/+$/, '') || '/'
  if (APP_ROUTE_EXACT.has(normalized)) return true
  return APP_ROUTE_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

function pathSegmentCount(path: string) {
  return normalizeSeparators(path).split('/').filter(Boolean).length
}

/**
 * Inline code often contains a whole command, for example `python3 start.py`.
 * Looking only at the final extension turns that command into a bogus file
 * target. A real path containing spaces is still accepted when its path shape
 * is explicit (`docs/My Guide.md`, `./My File.ts`, an absolute/Windows path).
 */
function hasCommandLikeLeadingToken(path: string) {
  const firstWhitespace = path.search(/\s/)
  if (firstWhitespace < 0) return false
  const firstSeparator = path.search(/[\\/]/)
  return firstSeparator < 0 || firstWhitespace < firstSeparator
}

export function isUnambiguousFileCandidate(raw: string, context: FileCandidateContext = 'text') {
  const value = trimWrappingPunctuation(raw)
  if (!value || value.startsWith('#') || (!/^file:\/\//i.test(value) && value.includes('://')) || /^https?:\/\//i.test(value) || /^mailto:/i.test(value) || /^thread:/i.test(value)) return false

  let locationValue = value
  if (/^file:\/\//i.test(value)) {
    const parsed = parseFileUrl(value)
    if (!parsed) return false
    locationValue = `${parsed.path}${parsed.hash}`
  } else if (URI_SCHEME.test(value) && !WINDOWS_DRIVE.test(value)) {
    return false
  }

  const location = splitLocation(locationValue)
  const path = normalizeSeparators(location.path.trim())
  if (!path || /[?#]/.test(path)) return false
  if (context === 'trusted') return true
  if (hasCommandLikeLeadingToken(path)) return false
  const basename = path.split('/').filter(Boolean).at(-1) || ''
  if (NUMERIC_DOTTED_BASENAME.test(basename)) return false
  const extensionIndex = basename.lastIndexOf('.')
  if (extensionIndex >= 0 && !/[A-Za-z]/.test(basename.slice(extensionIndex + 1))) return false
  if (isAppRoute(path)) return false

  const likelyName = LIKELY_FILE_NAME.test(path)
  if (context === 'text') return likelyName
  const explicitPath = WINDOWS_DRIVE.test(path)
    || UNC_PATH.test(path)
    || path.startsWith('~/')
    || path.startsWith('/')
    || path.startsWith('./')
    || path.startsWith('../')
  if (context === 'inline-code') return likelyName || explicitPath || path.includes('/')
  return likelyName || explicitPath || location.line !== null || pathSegmentCount(path) >= 3
}

export function parseFileTarget(raw: string, options: FileTargetParseOptions = {}): CodeArtifactTarget | null {
  const context = options.context || 'text'
  const value = trimWrappingPunctuation(String(raw || ''))
  if (!isUnambiguousFileCandidate(value, context)) return null

  let locationValue = value
  if (/^file:\/\//i.test(value)) {
    const parsedUrl = parseFileUrl(value)
    if (!parsedUrl) return null
    locationValue = `${parsedUrl.path}${parsedUrl.hash}`
  }
  const location = splitLocation(locationValue)
  const rawPath = safeDecode(location.path.trim())
  const path = normalizeSeparators(rawPath)
  if (!path || (context !== 'trusted' && isAppRoute(path))) return null

  return {
    rawPath,
    path,
    line: location.line,
    column: location.column,
    endLine: location.endLine,
    intent: options.intent || 'preview',
    source: options.source || 'message',
    ...(options.commitSha !== undefined ? { commitSha: options.commitSha } : {}),
  }
}

export function targetFromTrustedPath(raw: string, options: Omit<FileTargetParseOptions, 'context'> = {}) {
  return parseFileTarget(raw, { ...options, context: 'trusted' })
}

export function withFileTargetRange(target: CodeArtifactTarget, line: number, endLine: number = line): CodeArtifactTarget {
  const start = Math.max(1, Math.trunc(line))
  const end = Math.max(start, Math.trunc(endLine))
  return {
    ...target,
    line: start,
    column: target.line === start && end === start ? target.column : null,
    endLine: end > start ? end : null,
  }
}

export function workspaceTabKey(target: Pick<CodeArtifactTarget, 'path'>) {
  return target.path.replace(/\\/g, '/').replace(/^\/+/, '') || target.path
}

export function filePathSegments(path: string) {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.map((name, index) => ({
    name,
    path: parts.slice(0, index + 1).join('/'),
    isFile: index === parts.length - 1,
  }))
}

export function formatFileTarget(target: CodeArtifactTarget): FormattedFileTarget {
  const normalized = target.path.replace(/\/+$/, '') || target.path
  const parts = normalized.split('/').filter(Boolean)
  const basename = parts.pop() || normalized
  const parentPath = parts.length ? parts.join('/') : normalized.startsWith('/') ? '/' : null
  const lineLabel = target.line === null
    ? null
    : target.endLine !== null
      ? `L${target.line}–L${target.endLine}`
      : target.column !== null
        ? `L${target.line}:${target.column}`
        : `L${target.line}`
  const suffix = target.line === null
    ? ''
    : target.endLine !== null
      ? `#L${target.line}-L${target.endLine}`
      : target.column !== null
        ? `#L${target.line}C${target.column}`
        : `#L${target.line}`
  return { basename, parentPath, lineLabel, title: `${target.path}${suffix}` }
}

function normalizeAbsolutePath(value: string) {
  const normalized = normalizeSeparators(value.trim()).replace(/\/+$/, '')
  if (/^[A-Za-z]:\//.test(normalized)) return normalized[0].toLowerCase() + normalized.slice(1)
  return normalized || '/'
}

function isWithin(root: string, candidate: string) {
  const normalizedRoot = normalizeAbsolutePath(root)
  const normalizedCandidate = normalizeAbsolutePath(candidate)
  const caseInsensitive = /^[a-z]:\//.test(normalizedRoot)
  const a = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot
  const b = caseInsensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate
  return b === a || b.startsWith(`${a}/`)
}

function relativeToRoot(root: string, candidate: string) {
  const normalizedRoot = normalizeAbsolutePath(root)
  const normalizedCandidate = normalizeAbsolutePath(candidate)
  return normalizedCandidate.slice(normalizedRoot.length).replace(/^\/+/, '')
}

function inferHomePath(bindPath: string) {
  const normalized = normalizeAbsolutePath(bindPath)
  const match = normalized.match(/^(\/(?:Users|home)\/[^/]+)(?:\/|$)/)
  return match?.[1] || null
}

function cleanRelativePath(value: string) {
  const segments: string[] = []
  for (const segment of normalizeSeparators(value).split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  return `/${segments.join('/')}`
}

export function resolveProjectRelativePath(target: CodeArtifactTarget, metadata?: ProjectPathMetadata | null): ProjectRelativePathResult {
  const bindPath = metadata?.bindPath?.trim()
  if (!bindPath) {
    return { ok: false, code: 'metadata-unavailable', error: '项目路径信息尚未加载' }
  }

  const root = normalizeAbsolutePath(bindPath)
  let candidate = normalizeSeparators(target.path.trim())
  if (!candidate) return { ok: false, code: 'unsupported-path', error: '文件路径为空' }

  if (candidate.startsWith('~/')) {
    const home = inferHomePath(root)
    if (!home) return { ok: false, code: 'unsupported-path', error: '无法在当前项目中解析 ~/ 路径' }
    candidate = `${home}/${candidate.slice(2)}`
  }

  const mounted = candidate.match(/^\/workspaces?\/(.+)$/)
  if (mounted) {
    let segments = mounted[1].split('/').filter(Boolean)
    const projectName = root.split('/').filter(Boolean).pop() || ''
    const projectSegment = segments.indexOf(projectName)
    if (projectSegment >= 0) segments = segments.slice(projectSegment + 1)
    const relative = cleanRelativePath(segments.join('/'))
    return relative
      ? { ok: true, path: relative }
      : { ok: false, code: 'outside-workspace', error: '文件路径超出当前项目' }
  }

  const absolute = candidate.startsWith('/') || WINDOWS_DRIVE.test(candidate) || candidate.startsWith('//')
  if (absolute) {
    if (!isWithin(root, candidate)) {
      return { ok: false, code: 'outside-workspace', error: '文件不在当前项目目录内' }
    }
    return { ok: true, path: `/${relativeToRoot(root, candidate)}` }
  }

  const relative = cleanRelativePath(candidate)
  return relative
    ? { ok: true, path: relative }
    : { ok: false, code: 'outside-workspace', error: '文件路径超出当前项目' }
}
