const EXTENSION_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

export function extensionAppUrlForProject(project: any): string {
  if (!project || project.kind !== 'extension' || project.disabled) return ''
  const extensionName = typeof project.extension_name === 'string' ? project.extension_name.trim() : ''
  if (!EXTENSION_NAME_RE.test(extensionName)) return ''
  return `/extension/${extensionName}/`
}
