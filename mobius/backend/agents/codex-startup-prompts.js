const UPDATE_PROMPT_SENTINELS = [
  'Update available!',
  'Skip until next version',
]

// 更新提示关闭后，其文字仍可能留在 tmux scrollback 中。ready 探测会同时读取
// 当前屏幕与最近历史，因此不能仅靠“屏幕文本仍命中 + 时间间隔”重复发送 2 + Enter：
// 第二次按键会落进正常 composer，产生一条幽灵用户消息 "2"。每个新窗口只允许
// 处理一次更新提示；tmux send-keys 是同步命令，失败则由调用方直接终止本次启动。
function createCodexUpdatePromptGuard() {
  let handled = false
  return (screen) => {
    if (handled || !UPDATE_PROMPT_SENTINELS.every((sentinel) => screen.includes(sentinel))) return false
    handled = true
    return true
  }
}

module.exports = {
  UPDATE_PROMPT_SENTINELS,
  createCodexUpdatePromptGuard,
}
