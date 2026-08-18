export type ForgottenFlagMeta = {
  runId?: string | null;
  startedAt?: string | null;
  content?: string | null;
  mtimeMs?: number | null;
};

export type ForgottenFlagNotifyState = {
  flagKey?: string;
  flagMtimeMs?: number | null;
  flagStartedAt?: string | null;
  inactiveSince?: number | null;
  lastNotifiedAt?: number | null;
  count?: number;
  [key: string]: unknown;
};

export function flagKeyForMeta(meta: ForgottenFlagMeta): string {
  return meta.runId
    || meta.startedAt
    || (meta.content ? `content:${meta.content}` : `mtime:${meta.mtimeMs || 'unknown'}`);
}

export function isSameFlagState(
  state: ForgottenFlagNotifyState | null | undefined,
  meta: ForgottenFlagMeta,
): boolean {
  if (!state) return false;
  const flagKey = flagKeyForMeta(meta);
  return Boolean(
    (state.flagKey && state.flagKey === flagKey)
    || (!state.flagKey && meta.mtimeMs != null && state.flagMtimeMs === meta.mtimeMs),
  );
}

export function observeInactiveFlag(
  state: ForgottenFlagNotifyState | null | undefined,
  meta: ForgottenFlagMeta,
  nowMs: number,
): { state: ForgottenFlagNotifyState; sameFlag: boolean; startedNow: boolean } {
  const flagKey = flagKeyForMeta(meta);
  const sameFlag = isSameFlagState(state, meta);
  const current = sameFlag && state
    ? state
    : {
        flagKey,
        flagMtimeMs: meta.mtimeMs ?? null,
        flagStartedAt: meta.startedAt || null,
        lastNotifiedAt: null,
        count: 0,
      };
  const existingInactiveSince = Number(current.inactiveSince);
  if (Number.isFinite(existingInactiveSince) && existingInactiveSince > 0) {
    return { state: current, sameFlag, startedNow: false };
  }
  return {
    state: { ...current, inactiveSince: nowMs },
    sameFlag,
    startedNow: true,
  };
}

export function observeWorkingFlag(
  state: ForgottenFlagNotifyState | null | undefined,
  meta: ForgottenFlagMeta,
): ForgottenFlagNotifyState | null | undefined {
  if (!state || !isSameFlagState(state, meta) || state.inactiveSince == null) return state;
  return { ...state, inactiveSince: null };
}

export function continuousInactiveMs(state: ForgottenFlagNotifyState, nowMs: number): number {
  const inactiveSince = Number(state.inactiveSince);
  if (!Number.isFinite(inactiveSince) || inactiveSince <= 0) return 0;
  return Math.max(0, nowMs - inactiveSince);
}
