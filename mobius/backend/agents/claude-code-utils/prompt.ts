/**
 * claude-code-utils/prompt.ts — Deliver a prompt into a running claude TUI.
 *
 * The paste is atomic (bracketed paste through a tmux buffer), the landing is
 * probed on the pane, and Enter is re-sent because the TUI's input-mode switch
 * occasionally swallows the first one. Nothing here goes through argv, so a
 * long prompt cannot hit ARG_MAX and never shows up in ps.
 */
import {
  HUB,
  INITIAL_CONTEXT_DELAY_MS,
  INITIAL_CONTEXT_GREETING_CHOICES,
  PASTE_PLACEHOLDER_RE,
  PASTE_PROBE_INTERVAL_MS,
  PASTE_SLEEP_MAX_MS,
  SUBMIT_ENTER_ATTEMPTS,
  SUBMIT_ENTER_INTERVAL_MS,
} from './constants'
import { windowExists } from './tmux-window'
const { log, tmux } = require('../tmux-operation-log')
import { containerForWindow } from '../../services/user-isolation'
import { recordPromptPaste } from '../../services/agent-prompt-events'

/*
 * Promise-based pause, the only sleep idiom this backend uses: the async
 * paths (ready poll, paste probe, submit-echo gaps) must not block node's
 * event loop the way a spawnSync('sleep') would — every session shares
 * that loop with the HTTP server, so a blocking sleep freezes them all.
 */
export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/*
 * Last 10 chars of the prompt once all whitespace is stripped, or null when
 * nothing is left.
 *
 * Taking the tail of the *whitespace-stripped* text rather than the literal
 * tail is what makes the probe survive the TUI's own line wrapping: the pane
 * is stripped the same way before comparing, so a marker split across two
 * screen rows still matches. It also means a CJK tail works, which the
 * earlier printable-ASCII-only version could not handle at all.
 */
export function findPasteMarker(text: string) {
  // 去掉所有空白再取尾部，面板侧也会同样处理
  // Strip all whitespace first, the pane side is stripped the same way
  const compact = String(text ?? '').replace(/\s+/g, '')
  // 全空白的提示词没有可比对的探针，返回null
  // An all-whitespace prompt leaves nothing to match, return null
  return compact ? compact.slice(-10) : null
}

/*
 * Pick how the very first context prompt is delivered into a freshly spawned Claude Code TUI:
 * a greeting first, straight in, or after a settle delay. A TUI that is still starting up can
 * drop input that arrives before it is ready to accept it, so the two warm-up variants buy it
 * time — and something harmless to render — before the real context lands. Which variant is
 * actually needed was never pinned down, so sessions are split evenly across all three and the
 * log line records the one that ran.
 */
export function pickInitialContextPlan() {
  const roll = Math.random()
  // 两个阈值把随机数均分成三档，不是随手取的分数
  // The two thresholds split the roll into equal thirds, not arbitrary fractions
  if (roll < 1 / 3) return 'greeting_then_context'
  if (roll < 2 / 3) return 'direct_context'
  return 'delay_then_context'
}

/*
 * Pick one of the fixed short greetings used by the greeting_then_context plan. The greeting is
 * only a warm-up nudge that gets the TUI to render and accept input before the real context
 * lands, so a tiny pool is enough — the text itself carries no meaning.
 */
export function pickInitialContextGreeting() {
  const index = Math.floor(Math.random() * INITIAL_CONTEXT_GREETING_CHOICES.length)
  return INITIAL_CONTEXT_GREETING_CHOICES[index]
}

/*
 * Deliver a prompt into an already-running claude TUI window: stage the text in a tmux buffer,
 * paste it as one bracketed block, wait until the pane proves it landed, then press Enter.
 * Shared by the initial-context dispatch and the normal queue path; both call it only after
 * ensuring the window exists.
 *
 * The prompt never goes through argv (load-buffer reads stdin), so a long prompt cannot hit
 * ARG_MAX and its text never shows up in ps.
 *
 * Bracketed paste (-p) is mandatory: without it a \n inside the text is read as Return, so a
 * multi-line message submits early at the first newline and the rest plus the explicit Enter
 * become a second message (the root cause of multi-line splits). -p was removed historically
 * because the Enter after it was occasionally swallowed — the confirm-style re-send below is the
 * fix, which is why both stay.
 *
 * Note the two meanings of -p: bracketed paste for paste-buffer, print-to-stdout for capture-pane.
 *
 * The landing check accepts either the tail probe (findPasteMarker) or a collapsed-paste
 * placeholder: a big paste is rendered as "[Pasted text N lines]" instead of its own text, so
 * the probe could never match and the wait would always burn its full budget.
 */
export async function sendPromptToWindow(backendName: string, sessionId: string, text: string) {
  // 检查tmux窗口是否存在，不存在抛出错误
  // Check tmux window exist, if not, throw error
  if (!windowExists(sessionId)) {
    throw new Error(`window ${sessionId} 不存在`)
  }
  // 隔离用户的窗口在沙箱容器里，所有 tmux 调用都带上同一个容器
  // A sandboxed user's window lives in its container; reuse one container for every call
  const container = containerForWindow(sessionId) || undefined

  // 取提示词去掉空白后的最后10个字符作为探针，取不到为null
  // Take the last 10 whitespace-stripped chars of the prompt as probe, null if none
  const marker = findPasteMarker(text)
  // 记录窗口、长度和探针，探针可能含中文，加引号便于辨认
  // Log window, length and probe; quotes make a CJK probe easier to read
  log(`[tmux-claude-code] sendPrompt window=${sessionId} len=${text.length} marker=${marker ? JSON.stringify(marker) : '(none)'}`)

  // tmux buffer全局共享，用进程号加毫秒命名避免并发互撞
  // tmux buffers are server-global, name by pid and ms to avoid clashes
  const bufName = `imac_${process.pid}_${Date.now()}`
  // 末尾的-表示从stdin读，提示词不进命令行，避免超长和泄漏
  // Trailing - reads stdin, keeps the prompt out of argv and ps
  const r1 = tmux(['load-buffer', '-b', bufName, '-'], { input: text, container })
  // 装载buffer失败直接抛出
  // Throw when loading the buffer fails
  if (r1.status !== 0) throw new Error(`tmux load-buffer 失败: ${r1.stderr}`)

  // -p括号粘贴，-d粘贴成功后删buffer，-t指定目标窗口
  // -p bracketed paste, -d drops the buffer on success, -t targets the window
  const r2 = tmux(['paste-buffer', '-p', '-d', '-b', bufName, '-t', `${HUB}:${sessionId}`], { container })
  if (r2.status !== 0) {
    // -d只在成功时生效，失败要手动清掉buffer
    // -d only fires on success, so clean the buffer by hand here
    tmux(['delete-buffer', '-b', bufName], { container })
    throw new Error(`tmux paste-buffer 失败: ${r2.stderr}`)
  }

  // 记录等待起点，命中日志里要算耗时
  // Record the wait start, the hit log reports elapsed time
  const pasteWaitStartedAt = Date.now()

  // 轮询面板直到探针或折叠占位符出现，说明文字已渲染或已被折叠接收
  // Poll the pane until the probe or the collapsed-paste placeholder shows
  const deadline = pasteWaitStartedAt + PASTE_SLEEP_MAX_MS
  let saw = false
  let attempt = 0
  while (Date.now() < deadline) {
    // 每200ms截屏一次
    // Capture the pane every 200ms
    await sleep(PASTE_PROBE_INTERVAL_MS)
    attempt += 1
    // 只截最后80行，够覆盖输入框且开销小
    // Only the last 80 lines, enough for the input box and cheap
    const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-S', '-80'])
    // 截屏失败也要记一笔，排查时能区分没粘上还是没截到
    // Log a failed capture too, so a miss can be told apart from a blank screen
    if (pane.status !== 0) {
      log(`[tmux-claude-code] paste poll window=${sessionId} attempt=${attempt} capture=failed`)
      continue
    }
    // 比对前去掉面板里的空格和换行，避免TUI折行导致匹配不上
    // Strip the pane's whitespace before comparing, so TUI wrapping cannot break the match
    const compactPane = pane.stdout.replace(/\s+/g, '')
    const hitMarker = !!marker && compactPane.includes(marker)
    const hitPlaceholder = PASTE_PLACEHOLDER_RE.test(pane.stdout)
    // 每次轮询都记录结果，命中与否都要能看到
    // Log every poll, hit or miss, so the whole match stays visible when debugging
    log(`[tmux-claude-code] paste poll window=${sessionId} attempt=${attempt} marker=${hitMarker} placeholder=${hitPlaceholder} elapsed=${Date.now() - pasteWaitStartedAt}ms`)
    if (hitMarker || hitPlaceholder) {
      saw = true
      break
    }
  }
  // 超时也照样发回车，不能把这一轮卡死
  // Send Enter anyway on timeout, do not strand the turn
  if (!saw) console.warn(`[tmux-claude-code] paste marker/placeholder did not appear within ${PASTE_SLEEP_MAX_MS}ms (attempts=${attempt}), Enter 仍发送`)

  // 提交回车：括号粘贴是原子的，多发几次不会拆开消息
  // Submit Enter: bracketed paste is atomic, extra sends never split it
  // 而TUI切换输入模式时会吞掉第一次，故重发N次幂等
  // The TUI's input-mode switch swallows the first one, so re-send N times
  for (let i = 0; i < SUBMIT_ENTER_ATTEMPTS; i++) {
    // 发送回车提交提示词
    // Send Enter to submit the prompt
    const r = tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
    // 回车都发不出去说明窗口有问题，直接抛出
    // A window that cannot take Enter will not recover, throw
    if (r.status !== 0) throw new Error(`tmux send-keys Enter 失败: ${r.stderr}`)
    // 最后一次不用再等
    // No wait after the last attempt
    if (i < SUBMIT_ENTER_ATTEMPTS - 1) await sleep(SUBMIT_ENTER_INTERVAL_MS)
  }

  // 记录一次提示词投递，内部吞异常不影响投递
  // Record one prompt delivery, it swallows its own failures
  recordPromptPaste({ backendName, sessionId, contentLength: text.length })
}

/*
 * Deliver a prompt into an already-running claude TUI window. A non-initial
 * prompt goes straight through; only the very first context of a freshly
 * spawned session takes the warm-up split described at
 * pickInitialContextPlan.
 */
export async function sendMaybeInitialContextPrompt(backendName: string, sessionId: string, text: string, isInitialContextPrompt?: boolean) {
  // 不是首次上下文就直接发，不走预热分支
  // A non-initial prompt is sent straight, no warm-up branch
  if (!isInitialContextPrompt) {
    await sendPromptToWindow(backendName, sessionId, text)
    return
  }

  const plan = pickInitialContextPlan()
  if (plan === 'greeting_then_context') {
    const greeting = pickInitialContextGreeting()
    log(`[tmux-claude-code] initial context plan=${plan} greeting=${JSON.stringify(greeting)} delay_ms=${INITIAL_CONTEXT_DELAY_MS}`)
    // 先甩一句问候让TUI渲染起来并接受输入
    // Throw a greeting first so the TUI renders and accepts input
    await sendPromptToWindow(backendName, sessionId, greeting)
    // 等TUI稳定后再发真正的上下文
    // Give the TUI time to settle before the real context lands
    await sleep(INITIAL_CONTEXT_DELAY_MS)
    await sendPromptToWindow(backendName, sessionId, text)
    return
  }

  if (plan === 'delay_then_context') {
    log(`[tmux-claude-code] initial context plan=${plan} delay_ms=${INITIAL_CONTEXT_DELAY_MS}`)
    // 先干等一段让TUI起来，再发上下文
    // Wait out the startup before sending the context
    await sleep(INITIAL_CONTEXT_DELAY_MS)
    await sendPromptToWindow(backendName, sessionId, text)
    return
  }

  // 剩下的direct_context档不做预热，直接发
  // The remaining direct_context plan sends straight, no warm-up
  log(`[tmux-claude-code] initial context plan=${plan}`)
  await sendPromptToWindow(backendName, sessionId, text)
}
