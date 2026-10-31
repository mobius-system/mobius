/*
 * Shared AIMUX command and privilege policy for the terminal and desktop clients.
 */
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const AIMUX_TARGET_VERSION = '0.3.72'
export type GuiMode = 'off' | 'no-elevate' | 'elevate'

/*
 * Match the broker version, falling back to the bundled pin when unavailable.
 */
export function alignTarget(serverVersion: string | null | undefined, pin = AIMUX_TARGET_VERSION): string {
  const v = typeof serverVersion === 'string' ? serverVersion.trim() : ''
  return v || pin
}

/*
 * Use the effective OS user rather than inherited shell identity.
 */
export function currentUsername(): string {
  try { return os.userInfo().username } catch { return process.env.USER || process.env.USERNAME || 'user' }
}

/*
 * Hash the full user and workspace identity to avoid prefix collisions.
 */
export function aimuxWorkspaceHash(username = currentUsername(), cwd = process.cwd()): string {
  return createHash('sha256').update(`${username}:${path.resolve(cwd)}`).digest('hex').slice(0, 10)
}

/*
 * Treat EPERM as alive: insufficient permission does not mean a missing process.
 */
export function pidAlive(
  pid: number,
  probe: (pid: number, signal: number) => void = (p, s) => process.kill(p, s),
): boolean {
  try { probe(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

/*
 * Build the reverse connection arguments shared by both clients.
 */
export function reverseConnectArgs(
  server: string,
  identifier: string,
  token: string,
  platform: NodeJS.Platform = process.platform,
  silentFlag: string | null = null,
  runtimeFile: string | null = null,
  enableGui = false,
  guiNoElevate = false,
): string[] {
  return [
    'reverse', 'connect', `${server.replace(/\/$/, '')}/aimux_bridge`,
    '--identifier', identifier,
    '--token', token,
    '--replace',
    ...(runtimeFile ? ['--runtime', runtimeFile, '--watchdog', runtimeFile] : []),
    ...(platform === 'win32' && silentFlag ? [silentFlag] : []),
    ...(enableGui ? ['--enable-gui'] : []),
    // 只有启用 GUI 时才需要禁止提权。
    // Suppress elevation only when GUI access is enabled.
    ...(enableGui && guiNoElevate ? ['--gui-no-elevate'] : []),
  ]
}

/*
 * Choose only a Windows console flag advertised by the installed runtime.
 */
export function pickSilentFlag(helpText: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return null
  if (/--silent-v2\b/.test(helpText)) return '--silent-v2'
  if (/--slient-v2\b/.test(helpText)) return '--slient-v2'
  if (/--silent-shell\b/.test(helpText)) return '--silent-shell'
  return null
}

/*
 * Detect explicit GUI support before sending the corresponding flag.
 */
export function pickEnableGuiFlag(helpText: string): boolean {
  return /--enable-gui\b/.test(helpText)
}

/*
 * Detect support for GUI access without requesting elevation.
 */
export function pickGuiNoElevateFlag(helpText: string): boolean {
  return /--gui-no-elevate\b/.test(helpText)
}

/*
 * Never request rights absent from the parent process; disable unsupported GUI access.
 */
export function pickGuiArgs(
  mode: GuiMode,
  elevated: boolean,
  supports: { enable: boolean; noElevate: boolean },
  platform: NodeJS.Platform = process.platform,
): { enableGui: boolean; guiNoElevate: boolean } {
  if (mode === 'off' || !supports.enable) return { enableGui: false, guiNoElevate: false }
  if (platform !== 'win32') return { enableGui: true, guiNoElevate: mode === 'no-elevate' && supports.noElevate }
  if (elevated) return { enableGui: true, guiNoElevate: false }
  return supports.noElevate ? { enableGui: true, guiNoElevate: true } : { enableGui: false, guiNoElevate: false }
}
