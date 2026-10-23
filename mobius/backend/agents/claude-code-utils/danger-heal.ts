/**
 * claude-code-utils/danger-heal.ts — Cancel the dangerous-operation box and
 * tell the agent to use a gentler command.
 *
 * Even under --dangerously-skip-permissions claude still raises a one-time
 * confirmation for some destructive commands. The agent then waits on the box
 * and the session looks hung, so realTimeInfo hands the detection here and
 * never blocks on it.
 */
import { DANGER_HEAL_COOLDOWN_MS, HUB } from './constants'
import { sleep } from './prompt'
import { invalidatePaneTail, windowExists } from './tmux-window'
import type { ClaudeBackendHost } from './types'
const { log, tmux } = require('../tmux-operation-log')

// 禁止自愈并发跑同一个会话，并记住上次的警告文本做冷却
// One heal at a time per session, plus the last warning text for the cooldown
const dangerHealState = new Map<string, { healing: boolean; lastWarning: string; lastTs: number }>()

/*
 * Throttle for the danger-box heal: one heal at a time per session, and the same warning text never
 * re-triggers inside DANGER_HEAL_COOLDOWN_MS. Both gates are needed — a dirty Esc plus the 5s pane
 * cache would otherwise let realTimeInfo fire the heal over and over and turn the agent into a
 * broken record.
 *
 * Called by realTimeInfo on a detectDangerPermission hit. Fire-and-forget: it returns immediately
 * and the promise chain only exists to clear the healing flag again.
 */
export function maybeHealDangerPermission(backend: ClaudeBackendHost, sessionId: string, warning: string) {
  const st = dangerHealState.get(sessionId) || { healing: false, lastWarning: '', lastTs: 0 }
  const now = Date.now()
  // 已经在自愈中，不重复触发
  // Already healing, do not trigger a second time
  if (st.healing) return
  // 同一条警告在冷却期内也忽略，避免刷屏
  // The same warning stays ignored during the cooldown
  if (warning === st.lastWarning && now - st.lastTs < DANGER_HEAL_COOLDOWN_MS) return
  dangerHealState.set(sessionId, { healing: true, lastWarning: warning, lastTs: now })
  healDangerPermission(backend, sessionId, warning)
    .catch((e) => log(`[tmux-claude-code] danger heal 失败 session=${sessionId}: ${e?.message || e}`))
    .finally(() => {
      const cur = dangerHealState.get(sessionId)
      if (cur) dangerHealState.set(sessionId, { ...cur, healing: false })
    })
}

/*
 * The heal itself, detached async so it never blocks realTimeInfo or the /status poll:
 *   1) Esc cancels the box — claude goes back to the input state without running the dangerous
 *      command, which is what the dialog's own "Esc to cancel" offers
 *   2) wait 5s for the TUI to settle, so the dialog is really gone before the next prompt lands
 *   3) pauseCurrentAndResumeFromSession sends "$warning, please skip or try commands that are less
 *      aggressive." (it interrupts with C-c×3, then queues the new prompt; an agent still inside its
 *      old turn after the Esc is reset that way)
 *
 * The window is re-checked before step 3: it may have died during the 5s wait.
 */
async function healDangerPermission(backend: ClaudeBackendHost, sessionId: string, warning: string) {
  if (!windowExists(sessionId)) return
  // ✨ 按 Esc 取消危险操作确认框
  // Esc cancels the dangerous-operation box ✨
  tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Escape'])
  // 清掉面板缓存，后续检查才会看到取消后的画面
  // Drop the pane cache so later checks see the screen after the cancel
  invalidatePaneTail(sessionId)
  log(`[tmux-claude-code] danger permission 检测到, 已 Esc 取消 (session=${sessionId}): ${warning}`)
  await sleep(5000)
  if (!windowExists(sessionId)) return
  await backend.pauseCurrentAndResumeFromSession({
    sessionId,
    prompt: `${warning}, please skip or try commands that are less aggressive.`,
    urgent: false,
  })
  log(`[tmux-claude-code] danger permission 已 resume 提示 agent 跳过/换温和命令 (session=${sessionId})`)
}
