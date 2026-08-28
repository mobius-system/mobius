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

export const HOME_COMPOSER_IMAGE_ACCEPT = HOME_COMPOSER_IMAGE_EXTENSIONS.join(',')

export function isImagePath(value: string): boolean {
  const path = String(value || '').trim().toLowerCase().split(/[?#]/, 1)[0]
  return HOME_COMPOSER_IMAGE_EXTENSIONS.some(extension => path.endsWith(extension))
}

export function isImageFile(file: File): boolean {
  const path = (file as File & { path?: string }).path || file.name || ''
  return isImagePath(path) || String(file.type || '').toLowerCase().startsWith('image/')
}

function appendUniqueFile(target: File[], seen: Set<File>, file: File | null) {
  if (!file || seen.has(file)) return
  seen.add(file)
  target.push(file)
}

export function extractClipboardImageFiles(
  clipboardData: Pick<DataTransfer, 'files' | 'items'> | null | undefined,
): File[] {
  if (!clipboardData) return []
  const files: File[] = []
  const seen = new Set<File>()

  for (let index = 0; index < clipboardData.files.length; index += 1) {
    const file = clipboardData.files[index]
    if (file && isImageFile(file)) appendUniqueFile(files, seen, file)
  }
  for (let index = 0; index < clipboardData.items.length; index += 1) {
    const item = clipboardData.items[index]
    if (!item || !String(item.type || '').toLowerCase().startsWith('image/')) continue
    appendUniqueFile(files, seen, item.getAsFile())
  }

  return files
}

export function extractDroppedImageFiles(
  dataTransfer: Pick<DataTransfer, 'files' | 'items'> | null | undefined,
): File[] {
  if (!dataTransfer) return []
  const files: File[] = []
  const seen = new Set<File>()

  for (let index = 0; index < dataTransfer.files.length; index += 1) {
    const file = dataTransfer.files[index]
    if (file && isImageFile(file)) appendUniqueFile(files, seen, file)
  }
  for (let index = 0; index < dataTransfer.items.length; index += 1) {
    const item = dataTransfer.items[index]
    if (!item || item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && isImageFile(file)) appendUniqueFile(files, seen, file)
  }

  return files
}
