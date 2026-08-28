export const HOME_COMPOSER_IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.heic',
  '.heif',
] as const

export function isImagePath(value: string): boolean {
  const path = String(value || '').trim().toLowerCase().split(/[?#]/, 1)[0]
  return HOME_COMPOSER_IMAGE_EXTENSIONS.some(extension => path.endsWith(extension))
}

export function isImageFile(file: File): boolean {
  const path = (file as File & { path?: string }).path || file.name || ''
  return isImagePath(path) || String(file.type || '').toLowerCase().startsWith('image/')
}

function appendUniqueFile(target: File[], seen: Set<File>, signatures: Set<string>, file: File | null) {
  if (!file || seen.has(file)) return
  // A single clipboard image is exposed through both DataTransfer.files and
  // DataTransfer.items in some browsers. Calling getAsFile() may create a new
  // File with a different lastModified value, so that timestamp cannot be part
  // of the identity used to merge the two clipboard views.
  const signature = [file.name, file.size, file.type].join('\u0000')
  if (signatures.has(signature)) return
  seen.add(file)
  signatures.add(signature)
  target.push(file)
}

export function extractClipboardFiles(
  clipboardData: Pick<DataTransfer, 'files' | 'items'> | null | undefined,
): File[] {
  if (!clipboardData) return []
  const files: File[] = []
  const seen = new Set<File>()
  const signatures = new Set<string>()

  for (let index = 0; index < clipboardData.files.length; index += 1) {
    const file = clipboardData.files[index]
    appendUniqueFile(files, seen, signatures, file)
  }
  for (let index = 0; index < clipboardData.items.length; index += 1) {
    const item = clipboardData.items[index]
    if (!item || (item.kind && item.kind !== 'file')) continue
    appendUniqueFile(files, seen, signatures, item.getAsFile())
  }

  return files
}

export function extractDroppedFiles(
  dataTransfer: Pick<DataTransfer, 'files' | 'items'> | null | undefined,
): File[] {
  if (!dataTransfer) return []
  const files: File[] = []
  const seen = new Set<File>()
  const signatures = new Set<string>()

  for (let index = 0; index < dataTransfer.files.length; index += 1) {
    const file = dataTransfer.files[index]
    appendUniqueFile(files, seen, signatures, file)
  }
  for (let index = 0; index < dataTransfer.items.length; index += 1) {
    const item = dataTransfer.items[index]
    if (!item || item.kind !== 'file') continue
    appendUniqueFile(files, seen, signatures, item.getAsFile())
  }

  return files
}
