/**
 * claude-code-utils/running-flags.ts — The out-of-process task flag.
 *
 * <root>/.imac/flags/<sessionId>/running.flag marks "a task is in flight".
 * Dispatch drops and refreshes it, the agent removes it when the task ends
 * (success or failure, per the session-context hint), and
 * isJobGoalAccomplished reads its presence.
 */
const {
  safeWriteRunningFlag,
  safeRemoveRunningFlag,
} = require('../../utils/session-flags')

/*
 * Drop (and refresh) the session's running flag.
 *
 * root is flagRoot, the project repo root (bind_path): the same as cwd
 * outside a worktree, but the repo root rather than cwd inside one, so the
 * agent's first step of cleaning / rebuilding the worktree cannot delete
 * the flag by mistake.
 *
 * safeWriteRunningFlag swallows fs errors: a flag that cannot be written
 * must not fail the prompt dispatch.
 */
export function markRunning(root: string | null | undefined, sessionId: string) {
  return safeWriteRunningFlag(root, sessionId, {}, 'tmux-claude-code')
}

/*
 * Remove running.flag, i.e. declare the task finished from our side. Only
 * the interrupt-only /stop path calls it (empty prompt: nothing new is
 * queued, so nothing may stay marked as running); on a normal completion
 * the agent removes the flag itself.
 */
export function clearRunning(root: string | null | undefined, sessionId: string) {
  return safeRemoveRunningFlag(root, sessionId, 'tmux-claude-code')
}
