export type BlueprintFileRequest = { projectId: string; sessionId?: string; path: string; remote?: string; root?: string }

export function blueprintRelativePath(path: string, bindPath: string, hiddenFolder: string): string | null {
  const normalized = path.replace(/\\/g, '/')
  const root = bindPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const relative = normalized.startsWith('/')
    ? (root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : '')
    : normalized.replace(/^(?:\.\/)+/, '')
  const parts = relative.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return null
  return parts[0] === hiddenFolder && parts[1] === 'blueprints' && parts.length > 2 && /\.html?$/i.test(relative)
    ? relative : null
}

export function blueprintStorageKey(projectId: string): string {
  return `mobius:ui:last-blueprint:${projectId}`
}
