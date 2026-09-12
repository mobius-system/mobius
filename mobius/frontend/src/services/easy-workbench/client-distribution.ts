export type ClientRuntime = 'web' | 'desktop' | 'unknown'

export type DesktopDistributionBridge = {
  isDesktop?: boolean
  openStatusPanel?: () => Promise<unknown> | void
}

type ClientWindow = {
  mobiusDesktop?: DesktopDistributionBridge
}

export const CLIENT_DISTRIBUTION_DOCS_URL = 'https://mobius-system.github.io/mobius/'
export const DESKTOP_MANIFEST_URL = '/desktop-builds/manifest.json'

/**
 * Electron preload is the authority for Desktop mode. A normal browser has no
 * bridge at all; a bridge-shaped object without the explicit flag is treated as
 * unknown so distribution actions fail closed. Do not replace this with UA or
 * platform sniffing.
 */
export function detectClientRuntime(scope?: ClientWindow): ClientRuntime {
  const clientWindow: ClientWindow | undefined = scope
    ?? (typeof window !== 'undefined' ? window as unknown as ClientWindow : undefined)
  if (!clientWindow) return 'unknown'
  if (clientWindow.mobiusDesktop?.isDesktop === true) return 'desktop'
  if (typeof clientWindow.mobiusDesktop === 'undefined') return 'web'
  return 'unknown'
}

export function getDesktopDistributionBridge(): DesktopDistributionBridge | undefined {
  if (detectClientRuntime() !== 'desktop' || typeof window === 'undefined') return undefined
  return (window as ClientWindow).mobiusDesktop
}

type DesktopManifestShape = {
  version?: unknown
  builds?: unknown
}

export function hasDesktopDownloadBuilds(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const manifest = value as DesktopManifestShape
  if (typeof manifest.version !== 'string' || !manifest.version.trim() || !Array.isArray(manifest.builds)) return false
  return manifest.builds.some(build => {
    if (!build || typeof build !== 'object') return false
    const candidate = build as Record<string, unknown>
    return typeof candidate.platform === 'string'
      && typeof candidate.arch === 'string'
      && typeof candidate.format === 'string'
      && typeof candidate.file === 'string'
      && candidate.file.length > 0
  })
}

export async function checkDesktopDownloadCapability(signal?: AbortSignal): Promise<void> {
  const response = await fetch(DESKTOP_MANIFEST_URL, { signal, cache: 'no-cache' })
  if (response.status === 404) throw new Error('尚未发布桌面客户端')
  if (!response.ok) throw new Error(`版本服务返回 ${response.status}`)
  if (!hasDesktopDownloadBuilds(await response.json())) throw new Error('版本清单不可用')
}
