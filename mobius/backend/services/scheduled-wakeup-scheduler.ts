import { ScheduledWakeups, type ScheduledWakeupRow } from '../repositories/scheduled-wakeups';
import { Users } from '../repositories/users';
import { runSessionMessage } from './session-message-runner';

const DEFAULT_SCAN_MS = 5_000;
const MAX_ERROR_LENGTH = 2_000;

let timer: NodeJS.Timeout | null = null;
let scanning = false;

/*
 * Deliver one claimed wake-up through the same message path used by an interactive Session.
 */
async function dispatchWakeup(wakeup: ScheduledWakeupRow): Promise<void> {
  const scheduledFor = wakeup.next_run_at!;
  try {
    const user = Users.findAuthById(wakeup.user_id);
    if (!user) throw new Error('定时任务所属用户不可用');
    const content = `[Mobius 定时提醒]\n${wakeup.reminder}`;
    const result = await runSessionMessage({
      user,
      sessionId: wakeup.session_id,
      content,
      inputText: wakeup.reminder,
      hasInputText: true,
      requestId: `scheduled-wakeup:${wakeup.id}:${scheduledFor}`,
      source: 'scheduler.wake-up',
      logger: console,
    });
    ScheduledWakeups.finishRun(wakeup.id, scheduledFor, {
      ok: true,
      turnNumber: result?.turn_number || null,
    });
  } catch (error) {
    const message = String((error as Error)?.message || error).slice(0, MAX_ERROR_LENGTH);
    ScheduledWakeups.finishRun(wakeup.id, scheduledFor, { ok: false, error: message });
    console.warn(`[scheduled-wakeup] dispatch failed (job=${wakeup.id}, session=${wakeup.session_id}): ${message}`);
  }
}

/*
 * Claim every due occurrence once, then dispatch sequentially to avoid a restart-time burst.
 */
async function scanScheduledWakeupsOnce(now: Date = new Date()): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const nowIso = now.toISOString();
    const due = ScheduledWakeups.listDue(nowIso);
    for (const candidate of due) {
      // 领取时先推进下次时间，即使后续投递失败也不会重复触发同一轮
      // Claiming advances the schedule first, so a later delivery failure cannot duplicate this occurrence
      const claimed = ScheduledWakeups.claimDue(candidate.id, nowIso);
      if (claimed) await dispatchWakeup(claimed);
    }
  } catch (error) {
    console.warn('[scheduled-wakeup] scan failed:', (error as Error)?.message || error);
  } finally {
    scanning = false;
  }
}

/*
 * Start the in-process wake-up daemon; the durable database is the restart recovery source.
 */
function startScheduledWakeupScheduler(): NodeJS.Timeout {
  if (timer) return timer;
  const configured = Number(process.env.SCHEDULED_WAKEUP_SCAN_MS || DEFAULT_SCAN_MS);
  const scanMs = Number.isFinite(configured) ? Math.max(1_000, configured) : DEFAULT_SCAN_MS;
  timer = setInterval(() => { void scanScheduledWakeupsOnce(); }, scanMs);
  timer.unref?.();
  setTimeout(() => { void scanScheduledWakeupsOnce(); }, 1_000).unref?.();
  console.log(`[mobius] scheduled wake-up scheduler started (${scanMs}ms scan)`);
  return timer;
}

/*
 * Stop the daemon for tests and graceful lifecycle control.
 */
function stopScheduledWakeupScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export {
  dispatchWakeup,
  scanScheduledWakeupsOnce,
  startScheduledWakeupScheduler,
  stopScheduledWakeupScheduler,
};
