/**
 * claude-code-utils/session-lifecycle.ts — Create, resume, queue, pause,
 * terminate and spawn one tmux-backed claude session.
 *
 * These are the bodies the backend's public entry points run under the
 * per-session lock. They take the backend as their first argument so the
 * backend class itself stays a thin, readable surface; see ClaudeBackendHost
 * for the exact slice of it they may touch.
 */
import fs from 'fs'

import type { ClaudeBackendHost, ClaudeDispatchOpts } from './types'
import { HUB } from './constants'
import { buildClaudeLaunch } from './launch-command'
import { sleep, sendMaybeInitialContextPrompt } from './prompt'
import { clearRunning, markRunning } from './running-flags'
import { ensureWatcher } from './runtime-store'
import { ensureProjectTrusted, jsonlPathOf } from './session-paths'
import { ensureHub, invalidatePaneTail, claudePaneStillBusy, windowExists } from './tmux-window'
import { waitForTuiReady } from './tui-ready'
import { resolveClaudeProxyMode, unpackLaunch } from './proxy'
import { sandboxCommand } from '../../services/agent-sandbox'
import {
  clearWindowOwner,
  prepareSpawn,
  sandboxPolicyFor,
} from '../../services/user-isolation'
import { resolveDispatchIdentity } from '../../services/session-dispatch-identity'
const { safeRemoveFlagDir } = require('../../utils/session-flags')
const { log, tmux } = require('../tmux-operation-log')

/*
 * Open the round as early as possible: the user card is written the moment dispatch is entered, not
 * after the spawn. Waiting would let the first sync beat us and file the startup preamble into
 * "round 0" instead of the round this prompt actually belongs to.
 */
export function writeMobiusPromptEarly(backend: ClaudeBackendHost, opts: ClaudeDispatchOpts) {
  if (!opts?.sessionId || !opts?.mobiusPromptRecord) return
  // 写卡片失败只吞掉，不能因此拖垮这次派发
  // A failed card write is swallowed; it must not break the dispatch
  try { backend.harnessWriteMobiusCoreEntry(opts.sessionId, opts.mobiusPromptRecord, opts.cwd) } catch {}
}

/*
 * Create path: spawn a window when none is live, otherwise adopt the one that is, then deliver the
 * first prompt and drop the running flag.
 *
 * Reuse is the defining tmux-mode trait: windows outlive a backend restart, so a live window is
 * adopted instead of duplicated, matching the old hub.startSession idempotence. That is deliberately
 * unlike the stream-json backend, which always creates fresh.
 *
 * Adopting needs a runtime row, and a window that predates the restart has none. The caller's
 * agentSessionId is the only thing that can rebuild it (it names the jsonl to tail), so without one
 * the else-branch below can do nothing.
 */
export async function createSession(backend: ClaudeBackendHost, opts: ClaudeDispatchOpts) {
  const { sessionId, cwd, flagRoot, displayName, initialPrompt, agentSessionId, isInitialContextPrompt = false, aimuxRemoteName, aimuxGuiAuthorized } = opts
  let { userId } = opts
  const { model, useProxy, proxyMode, settingsPath, forceNoProxy, captureStream } = unpackLaunch(opts)
  if (!sessionId || !cwd) throw new Error('createNewSession 需要 sessionId + cwd')
  if (!initialPrompt) throw new Error('createNewSession 需要 initialPrompt')
  if (!fs.existsSync(cwd)) throw new Error(`cwd 不存在: ${cwd}`)
  // 入口兜底: 派发方只转发部分字段时从会话行补齐 userId, 否则隔离用户会按宿主 HOME 记账
  // Entry fallback: fill a missing userId from the session row so an isolated user's
  // transcript/trust paths are the sandbox HOME, not the service user's HOME.
  userId = resolveDispatchIdentity(sessionId, { userId }).userId || userId

  // 窗口还活着就复用，重启后不重复拉起
  // A live window is reused, so a restart never spawns a duplicate
  if (!windowExists(sessionId)) {
    await spawnWindow(backend, { sessionId, userId, cwd, flagRoot, model, useProxy, proxyMode, displayName, agentSessionId, settingsPath, captureStream, forceNoProxy, aimuxRemoteName, aimuxGuiAuthorized, sandboxPolicy: (opts as any).sandboxPolicy })
  } else {
    // 重启后窗口还在但runtime可能为空，补建一条
    // The window is live but may have no runtime row; rebuild one
    if (!backend.runtime.has(sessionId) && agentSessionId) {
      const jp = jsonlPathOf(cwd, agentSessionId, userId)
      const finalSettingsPath = settingsPath || null
      const resolved = resolveClaudeProxyMode(useProxy, forceNoProxy, false, proxyMode)
      backend.runtime.set(sessionId, {
        agentSessionId, cwd, flagRoot: flagRoot || cwd, model: model || null, useProxy: resolved.useProxy,
        settingsPath: finalSettingsPath, forceNoProxy: resolved.forceNoProxy, displayName: displayName || null,
        jsonlPath: jp, startedAt: Date.now(), watch: null,
      })
      backend._persistEntry(sessionId, {
        agentSessionId, cwd, flagRoot: flagRoot || cwd, model, useProxy: resolved.useProxy,
        settingsPath: finalSettingsPath, forceNoProxy: resolved.forceNoProxy, displayName,
        jsonlPath: jp, startedAt: Date.now(),
      })
      // 补建后要重新挂监听, 否则窗口的输出不会推到订阅方
      // Attach the watcher after the row is rebuilt, or no output reaches subscribers
      ensureWatcher(backend, sessionId)
    }
  }

  const entry = backend.runtime.get(sessionId)
  await sendMaybeInitialContextPrompt(backend.name, sessionId, initialPrompt, isInitialContextPrompt)
  // 每条消息都重刷运行标记，agent完成后自己删
  // Every message refreshes the running flag; the agent removes it
  markRunning(flagRoot || entry?.flagRoot || entry?.cwd || cwd, sessionId)
  return {
    sessionId,
    agentSessionId: entry?.agentSessionId || null,
    jsonlPath: entry?.jsonlPath || null,
    startedAt: entry?.startedAt || Date.now(),
  }
}

/*
 * Queue path: append a prompt to a live session, or respawn the window first when it is gone. Chat
 * draws no first/follow-up distinction, so every message after create arrives here, and this is also
 * what pauseSession calls once it has interrupted the running turn.
 *
 * The respawn has to reconstruct what the original spawn built, hence the "opts first, last
 * persisted row second" chain for every field: a follow-up message carries almost nothing itself,
 * and without that fallback the window would come back on the wrong cwd, model or proxy tier.
 *
 * suppressRunningFlag is for a caller that owns the flag lifecycle itself and does not want this
 * path to touch it.
 */
export async function queueSession(backend: ClaudeBackendHost, opts: ClaudeDispatchOpts) {
  const { sessionId, userId, prompt, cwd, flagRoot, displayName, agentSessionId, isInitialContextPrompt = false, suppressRunningFlag = false, aimuxRemoteName, aimuxGuiAuthorized } = opts
  let { model, useProxy, proxyMode: proxyModeArg, settingsPath, forceNoProxy, captureStream } = unpackLaunch(opts)
  if (!sessionId) throw new Error('需要 sessionId')
  if (!prompt) throw new Error('需要 prompt')

  if (!windowExists(sessionId)) {
    // 无活窗口必须重开；字段优先opts，其次持久化行
    // No live window means respawn; opts wins, the persisted row is the fallback
    const persisted = backend.runtime.get(sessionId)
    const finalCwd = cwd || persisted?.cwd
    const finalAgentSid = agentSessionId || persisted?.agentSessionId
    const finalSettingsPath = settingsPath || persisted?.settingsPath || null
    const proxyMode = resolveClaudeProxyMode(
      useProxy,
      forceNoProxy || persisted?.forceNoProxy,
      persisted?.useProxy ?? false,
      proxyModeArg ?? persisted?.proxyMode,
    )
    if (!finalCwd) throw new Error(`session ${sessionId} 没活 window 且无 cwd, 无法 spawn`)
    await spawnWindow(backend, {
      sessionId,
      userId,
      cwd: finalCwd,
      flagRoot: flagRoot || persisted?.flagRoot || finalCwd,
      model: model || persisted?.model,
      useProxy: proxyMode.useProxy,
      proxyMode: proxyMode.proxyMode,
      settingsPath: finalSettingsPath,
      captureStream: captureStream || (persisted?.captureStream ?? false),
      forceNoProxy: proxyMode.forceNoProxy,
      displayName: displayName ?? (persisted?.displayName ?? undefined),
      agentSessionId: finalAgentSid ?? undefined,
      aimuxRemoteName,
      aimuxGuiAuthorized,
      sandboxPolicy: (opts as any).sandboxPolicy || null,
    })
  }
  await sendMaybeInitialContextPrompt(backend.name, sessionId, prompt, isInitialContextPrompt)
  const entry = backend.runtime.get(sessionId)
  if (!suppressRunningFlag) markRunning(flagRoot || entry?.flagRoot || entry?.cwd || cwd, sessionId)
}

/*
 * Pause path for a live window: interrupt the running turn, then either stop for good (no prompt,
 * clear the running flag) or hand the new prompt to the queue path.
 *
 * Two interrupt flavours, both measured on the real TUI: urgent sends a single C-c (enough to break
 * a turn), /stop sends three (a lone C-c is regularly swallowed). Neither may wait with
 * spawnSync('sleep'): that blocks the event loop and freezes the whole backend, so the pauses use
 * await setTimeout.
 *
 * The /stop hard-stop fallback is safe to escalate because a killed window is respawned by
 * queueSession on the next message, so the session itself continues.
 *
 * An absent window is not an error: the caller asked to stop something that is already not running.
 */
export async function pauseSession(backend: ClaudeBackendHost, opts: ClaudeDispatchOpts) {
  const { sessionId, prompt, cwd, flagRoot, urgent = false, mobiusPromptRecord = null } = opts
  if (!sessionId) throw new Error('需要 sessionId')
  const persisted = backend.runtime.get(sessionId)

  if (windowExists(sessionId)) {
    if (urgent) {
      // 加急只发一次C-c即可打断，实测一次就够
      // Urgent sends one C-c; one press is enough in practice
      // 不要用spawnSync睡眠，会阻塞事件循环
      // Use await setTimeout; spawnSync('sleep') blocks the event loop
      tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'C-c'])
      await sleep(250)
      // 旧输入可能回到输入框，先Alt+Enter分隔
      // Old input can return to the box; Alt+Enter keeps it separate
      tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'M-Enter'])
      await sleep(80)
    } else {
      // /stop连发3次C-c，TUI会吞掉其中一次
      // /stop fires 3 C-c; the TUI swallows one of them
      for (let i = 0; i < 3; i++) {
        tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'C-c'])
        if (i < 2) await sleep(50)
      }
      // 等TUI消化这次打断
      // Give the TUI a moment to digest the interrupt
      await sleep(300)
      // 停不掉就kill-window硬停，保证生效
      // Escalate to kill-window so /stop always stops the agent
      // 只有空提示词的软停走这里，带新提示词不杀窗口
      // Only the empty-prompt soft stop escalates; a new prompt keeps the window
      // 二次确认加700ms等待，避免误杀已软停的窗口
      // Double confirmation with a 700ms wait avoids killing a soft-stopped window
      if (!prompt) {
        invalidatePaneTail(sessionId)
        if (claudePaneStillBusy(sessionId)) {
          await sleep(700)
          invalidatePaneTail(sessionId)
          if (windowExists(sessionId) && claudePaneStillBusy(sessionId)) {
            tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
            log(`[tmux-claude-code] /stop fallback: C-c×3 未停止, kill-window=${sessionId}`)
          }
        }
      }
    }
  }

  if (!prompt) {
    clearRunning(flagRoot || persisted?.flagRoot || persisted?.cwd || cwd, sessionId)
    // 空提示词=只打断不发送，同时清掉运行标记
    // An empty prompt means interrupt only; clear the running flag
    return
  }

  // 走队列路径，死窗口会在里面重开
  // Hand off to the queue path, which respawns a dead window
  await queueSession(backend, {
    sessionId,
    prompt,
    cwd: persisted?.cwd ?? undefined,
    flagRoot: persisted?.flagRoot ?? undefined,
    model: persisted?.model ?? undefined,
    useProxy: persisted?.useProxy,
    displayName: persisted?.displayName ?? undefined,
    agentSessionId: persisted?.agentSessionId ?? undefined,
    // 恢复的提示词不算首次上下文，避免重放开场白
    // A resumed prompt is not initial context, so no greeting replay
    isInitialContextPrompt: false,
    mobiusPromptRecord,
  })
}

/*
 * Tear the session down for good: stop the watcher, drop the per-session withproxy file, remove the
 * runtime and persisted rows, kill the window, clear the flag dir.
 *
 * The archive row survives on purpose, so history still resolves after the window is gone.
 *
 * Returns { sessionId, killed, wasWorking } so the caller (the delete route) can raise a notice:
 * killed=true means a live background claude code really was killed; wasWorking=true means it was
 * still in a turn (a running task got forcibly interrupted).
 */
export async function terminateSession(backend: ClaudeBackendHost, sessionId: string) {
  const wasAlive = windowExists(sessionId)
  // 内部会再查存活，必须在杀窗口前采样
  // isWorking re-checks aliveness, so sample before the kill
  const wasWorking = wasAlive && backend.isWorking(sessionId)
  const entry = backend.runtime.get(sessionId)
  if (entry?.watch?.stop) { try { entry.watch.stop() } catch {} }
  // 删掉数字雨用的withproxy临时文件
  // Delete the digital-rain per-session withproxy file
  if (entry?.withProxyPath) { try { fs.unlinkSync(entry.withProxyPath) } catch {} }
  // 项目隐藏目录下的会话配置保留: 终止时不删目录, 便于事后排查
  // Session config under the project hidden folder is kept on terminate for post-mortem.
  backend.runtime.delete(sessionId)
  backend._forgetPersisted(sessionId)
  if (wasAlive) {
    tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
    log(`[tmux-claude-code] terminate: killed window=${sessionId} (wasWorking=${wasWorking})`)
  }
  // 沙箱窗口属主表同步清掉: 窗口已死, 留着会让后续 tmux 调用被路由进容器
  // Drop the sandbox owner row too: a dead window must not keep routing tmux into a container
  clearWindowOwner(sessionId)
  // 顺手删掉标记目录，避免agent没删而留垃圾
  // Drop the flag dir too, in case the agent never removed it
  const flagRoot = entry?.flagRoot || entry?.cwd
  if (flagRoot) {
    safeRemoveFlagDir(flagRoot, sessionId, 'tmux-claude-code')
  }
  return { sessionId, killed: wasAlive, wasWorking }
}

/*
 * Start a new tmux window that runs the interactive claude TUI and register the session's runtime
 * state in memory and on disk.
 *
 * Everything that decides what the agent runs (settings, MCP, proxy tier, environment) is built by
 * buildClaudeLaunch; what remains here is the process side: sandbox wrapping, the window itself and
 * the readiness wait.
 *
 * Resume is opportunistic: an agentSessionId whose jsonl is not visible under this cwd degrades to
 * a fresh session inside buildClaudeLaunch.
 *
 * new-window returns before the TUI has drawn, so waitForTuiReady polls the pane until the footer
 * sentinel shows, auto-confirming every blocking dialog. A TUI that never becomes ready has its
 * window killed rather than left behind.
 */
export async function spawnWindow(backend: ClaudeBackendHost, opts: ClaudeDispatchOpts) {
  let { sessionId, cwd, userId, flagRoot, model, useProxy, proxyMode: proxyModeArg, displayName, agentSessionId, settingsPath, captureStream = false, forceNoProxy = false, aimuxRemoteName, aimuxGuiAuthorized, sandboxPolicy = null } = opts
  // 入参可为null，此处归一为非空，兜底在调用方
  // Nullable args become non-null here; the persisted fallback is the caller's
  if (!sessionId || !cwd) throw new Error('_spawnWindow 需要 sessionId + cwd')
  // 入口兜底: 中断后加急重开只带一部分参数, 缺失的 userId/远端绑定从会话行补齐.
  // 缺 userId 会导致 prepareSpawn 返回 null (失去沙箱)、MCP 不注入、CLI 环境不导出.
  // Entry fallback: interrupt-and-resume respawns forward only a subset of options;
  // fill userId / aimux binding from the session row. A missing userId would drop the
  // sandbox container, the MCP config and the CLI environment.
  const identity = resolveDispatchIdentity(sessionId, { userId, aimuxRemoteName, aimuxGuiAuthorized })
  userId = identity.userId || userId
  aimuxRemoteName = identity.aimuxRemoteName || aimuxRemoteName
  aimuxGuiAuthorized = identity.aimuxGuiAuthorized ?? aimuxGuiAuthorized
  if (!sandboxPolicy && userId && identity.role !== 'admin') {
    sandboxPolicy = sandboxPolicyFor(
      { id: userId, role: identity.role },
      { userId: String(userId), projectId: identity.projectId, workDir: cwd },
    ) || null
  }
  const finalFlagRoot = flagRoot || cwd
  // 确保承载所有agent窗口的hub会话存在
  // Make sure the hub session hosting every agent window exists
  ensureHub()

  // 配置面: settings/钩子/MCP/代理/环境 一起生成, 失败直接抛出不启动
  // Config side: settings, hook, MCP, proxy and env are assembled in one step that fails loudly
  const launch = await buildClaudeLaunch({
    sessionId,
    userId,
    cwd,
    flagRoot: finalFlagRoot,
    model: model || null,
    useProxy: !!useProxy,
    proxyMode: proxyModeArg ?? null,
    settingsPath: settingsPath || null,
    captureStream,
    forceNoProxy,
    agentSessionId: agentSessionId || null,
    displayName: displayName || null,
    aimuxRemoteName,
    aimuxGuiAuthorized,
  })

  // 预先写好目录信任，TUI就不会弹"trust this folder"
  // Pre-set the trust so the trust-folder dialog never shows up
  // 这一步失败由就绪轮询里的截屏自动确认兜底
  // A failure here falls back to the screenshot auto-confirm in the ready poll
  ensureProjectTrusted(cwd, userId)

  // 在hub会话里建后台窗口，在cwd下跑bash -lc cmd
  // Create the background window in the hub, running bash -lc cmd in cwd
  const launchCmd = sandboxCommand(sandboxPolicy || null, launch.cmd)
  // 隔离用户: 先确保沙箱容器与容器内 tmux server 就绪, 窗口归属登记后显式走容器
  // Isolated users: bring the container and its tmux server up first, then target it explicitly
  const sbxContainer = prepareSpawn(userId, sessionId)
  // ✨ 真正拉起 agent 的唯一一步
  // The one step that actually starts the agent ✨
  const r = tmux(['new-window', '-d', '-t', HUB, '-n', sessionId, '-c', cwd, 'bash', '-lc', launchCmd],
    { container: sbxContainer || undefined })
  // 失败时带出stderr，便于定位命令级问题
  // Surface stderr on failure so command-level problems are diagnosable
  if (r.status !== 0) throw new Error(`tmux new-window 失败: ${r.stderr}`)
  log(`[tmux-claude-code] started: window=${sessionId} cwd=${cwd} claude_session=${launch.claudeSessionId} proxy_mode=${launch.proxyMode}${launch.settingsPath ? ` settings=${launch.settingsPath}` : ''}`)

  // 等TUI就绪，超时会杀掉窗口并抛出
  // Wait for the TUI, which kills the window and throws on timeout
  await waitForTuiReady(sessionId, cwd)
  log(`[tmux-claude-code] window=${sessionId} TUI ready`)

  // jsonl路径由cwd和claude会话id推导，不做探测
  // The jsonl path is derived from cwd and the claude session id
  const jp = jsonlPathOf(cwd, launch.claudeSessionId, userId)
  // 在内存里登记这个窗口的运行时状态
  // Register this window's runtime state in memory
  backend.runtime.set(sessionId, {
    agentSessionId: launch.claudeSessionId,
    cwd, flagRoot: finalFlagRoot, model: model || null, useProxy: launch.useProxy, proxyMode: launch.proxyMode,
    settingsPath: launch.settingsPath, withProxyPath: launch.withProxyPath, captureStream: !!captureStream,
    forceNoProxy: launch.forceNoProxy, displayName: displayName || null,
    jsonlPath: jp, startedAt: Date.now(), watch: null,
  })
  // 同样的核心状态落盘，服务重启后能原样恢复
  // Persist the same core state so a service restart can restore it
  backend._persistEntry(sessionId, {
    agentSessionId: launch.claudeSessionId, cwd, flagRoot: finalFlagRoot,
    model: model || null, useProxy: launch.useProxy,
    settingsPath: launch.settingsPath, withProxyPath: launch.withProxyPath, captureStream: !!captureStream,
    forceNoProxy: launch.forceNoProxy, displayName: displayName || null,
    jsonlPath: jp, startedAt: Date.now(),
  })
  // 起jsonl监听，agent输出才能持续推给订阅方
  // Start the jsonl watcher so agent output keeps flowing to subscribers
  ensureWatcher(backend, sessionId)

  // 建窗即打标记，每次提交刷新，agent完成后自删
  // Spawn drops the flag, every prompt refreshes it, the agent removes it
  // 标记锚在仓库根而非worktree里的cwd，重建不会误删
  // Rooted at the repo root, not the worktree cwd, so a rebuild cannot delete it
  markRunning(finalFlagRoot, sessionId)
}
