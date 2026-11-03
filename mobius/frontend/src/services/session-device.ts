export type SessionDeviceSelection = { aimuxId: string | null; guiAuthorized: boolean }
export const HUB_DEVICE: SessionDeviceSelection = { aimuxId: null, guiAuthorized: false }

type DesktopDevice = { aimuxId?: string | null; workMode?: 'hub' | 'pc' | 'dual' | null; localPath?: string }

/** Keep preview and creation metadata identical; a remote override never inherits the local PC path. */
export function sessionDeviceMetadata(selection: SessionDeviceSelection, desktop: DesktopDevice = {}) {
  const override = selection.aimuxId?.trim()
  const aimuxId = override || desktop.aimuxId || undefined
  const workMode = override ? 'dual' : desktop.workMode
  if (!workMode) return undefined
  return {
    work_mode: workMode,
    aimux_id: aimuxId,
    local_path: !override || override === desktop.aimuxId ? desktop.localPath || undefined : undefined,
    is_tui: false,
    add_remote_aimux_mcp: true,
    ...(override && selection.guiAuthorized ? { gui_authorized: true } : {}),
  }
}

export function isDeviceRequiredSkill(skill: { id?: string; dirName?: string | null; name?: string }, metadata: ReturnType<typeof sessionDeviceMetadata>) {
  const dir = (skill.dirName || skill.id?.split(':').pop() || skill.name || '').replace(/_/g, '-')
  return ((metadata?.work_mode === 'pc' || metadata?.work_mode === 'dual') && dir === 'mobius-aimux')
    || (metadata?.gui_authorized === true && dir === 'mobius-gui-operation')
}
