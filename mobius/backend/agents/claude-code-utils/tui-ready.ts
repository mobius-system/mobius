/**
 * claude-code-utils/tui-ready.ts — Wait until the freshly spawned claude TUI
 * is usable, auto-confirming every dialog that would otherwise block it.
 *
 * new-window returns before the TUI has drawn, so readiness is a poll on the
 * pane. While waiting, each blocking dialog gets its own sentinel set and its
 * own rate-limited key press, because send-keys is occasionally swallowed and
 * the same dialog may need a second press. A TUI that never becomes ready has
 * its window killed rather than left behind.
 */
import {
  API_KEY_PRESS_INTERVAL_MS,
  API_KEY_PROMPT_SENTINELS,
  BYPASS_WARN_INTERVAL_MS,
  BYPASS_WARN_SENTINELS,
  FULLSCREEN_UPSELL_INTERVAL_MS,
  FULLSCREEN_UPSELL_SENTINELS,
  HUB,
  ONBOARDING_PRESS_INTERVAL_MS,
  ONBOARDING_PROMPT_SENTINELS,
  READY_POLL_MS,
  READY_SENTINEL,
  READY_TIMEOUT_MS,
  TRUST_PRESS_INTERVAL_MS,
  TRUST_PROMPT_SENTINELS,
} from './constants'
import { sleep } from './prompt'
const { log, tmux } = require('../tmux-operation-log')
import { take_tmux_window_text } from '../tmux_utils'

/** One auto-confirm rule: the texts that identify the dialog and the keys that dismiss it. */
interface DialogRule {
  sentinels: string[]
  intervalMs: number
  /** Key sequence to send; a function so the trust box can move off "No, exit" first. */
  keys: (screen: string) => string[]
  /** Log line written when a press is sent. */
  describe: string
}

const DIALOG_RULES: DialogRule[] = [
  // 信任框2.1.296起默认高亮"No, exit"，选中它时先下移到"Yes, I trust this folder"
  // The trust box highlights "No, exit" since 2.1.296, so move down to "Yes, I trust this folder"
  {
    sentinels: TRUST_PROMPT_SENTINELS,
    intervalMs: TRUST_PRESS_INTERVAL_MS,
    keys: (screen) => (screen.includes('❯ No, exit') ? ['Down', 'Enter'] : ['Enter']),
    describe: '检测到目录信任对话框, 已自动确认信任',
  },
  // 首次启动的引导页(选文本样式/欢迎屏)也按回车确认
  // First-run onboarding pages are confirmed with Enter too
  {
    sentinels: ONBOARDING_PROMPT_SENTINELS,
    intervalMs: ONBOARDING_PRESS_INTERVAL_MS,
    keys: () => ['Enter'],
    describe: '检测到首次启动引导对话框, 已自动确认',
  },
  // 自定义API Key弹窗按1选环境变量的key
  // The custom-API-key dialog: press 1 to use the env key
  {
    sentinels: API_KEY_PROMPT_SENTINELS,
    intervalMs: API_KEY_PRESS_INTERVAL_MS,
    keys: () => ['1', 'Enter'],
    describe: '检测到 API Key 对话框, 已自动选择使用环境变量 Key',
  },
  // bypass警告高亮的"No, exit"是退出，下移一格到"Yes, I accept"再回车才接受
  // The bypass warning highlights "No, exit", so move down to "Yes, I accept" then Enter
  {
    sentinels: BYPASS_WARN_SENTINELS,
    intervalMs: BYPASS_WARN_INTERVAL_MS,
    keys: () => ['Down', 'Enter'],
    describe: '检测到 Bypass Permissions 警告, 已自动确认接受',
  },
  // 全屏渲染器推广弹窗默认高亮"1. Yes"，下移一格选"2. Not now"保持经典渲染
  // The fullscreen-renderer upsell highlights "1. Yes, try it", so move down to "2. Not now"
  {
    sentinels: FULLSCREEN_UPSELL_SENTINELS,
    intervalMs: FULLSCREEN_UPSELL_INTERVAL_MS,
    keys: () => ['Down', 'Enter'],
    describe: '检测到全屏渲染器推广弹窗, 已选择 Not now 保持经典渲染',
  },
]

/*
 * Poll the pane until the ready sentinel shows, auto-confirming any blocking
 * dialog on the way. Returns normally when ready; kills the window and throws
 * when the deadline passes, so a half-started TUI is never left behind.
 * The window target carries HUB:<id>, so the isolation router reaches the
 * sandbox container for a sandboxed user.
 */
export async function waitForTuiReady(sessionId: string, cwd: string) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  // 每个弹窗一个时间戳，互相独立限流，避免刷屏
  // One timestamp per dialog, rate-limited independently so the TUI is not flooded
  const lastPress = new Map<DialogRule, number>()
  const target = `${HUB}:${sessionId}`
  // 轮询面板到截止时间，每轮先查就绪再处理弹窗
  // Poll the pane until the deadline: readiness first, then the dialogs
  while (Date.now() < deadline) {
    // 截屏失败按空屏处理，下一轮重试
    // A failed capture counts as an empty screen, the next round retries
    const { text: screen } = take_tmux_window_text(target, 100)
    // 出现就绪锚点即结束等待
    // The ready sentinel ends the wait
    if (screen.includes(READY_SENTINEL)) return

    for (const rule of DIALOG_RULES) {
      if (!rule.sentinels.some((s) => screen.includes(s))) continue
      const now = Date.now()
      // 限流重发，TUI偶尔吞掉send-keys，直到弹窗消失
      // Rate-limited re-send covers a swallowed send-keys until the box goes
      if (now - (lastPress.get(rule) || 0) <= rule.intervalMs) continue
      for (const key of rule.keys(screen)) {
        // ✨ 真正解除阻塞的按键
        // The keystroke that actually unblocks the TUI ✨
        tmux(['send-keys', '-t', target, key])
      }
      lastPress.set(rule, now)
      log(`[tmux-claude-code] window=${sessionId} ${rule.describe}`)
    }
    // 歇一个轮询间隔再看屏
    // Wait one poll interval, then look at the screen again
    await sleep(READY_POLL_MS)
  }
  // 超时没就绪就杀掉刚建的窗口再抛出，不留废窗口
  // Not ready in time: kill the window just created and throw
  tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
  throw new Error(`claude TUI 未在 ${READY_TIMEOUT_MS}ms 内 ready (cwd=${cwd}).`)
}
