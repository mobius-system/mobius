/** Extract the final folder name from either a Windows or POSIX path. */
export function localFolderName(localPath: string): string {
  const normalized = localPath.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).pop() || ''
}
