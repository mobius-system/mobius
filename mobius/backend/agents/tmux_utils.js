const { tmux } = require('./tmux-operation-log')

function take_tmux_window_text(target, capture_head_and_tail_line = 100) {
  const tailCap = tmux(['capture-pane', '-pt', target, '-p', '-S', `-${capture_head_and_tail_line}`])
  const hs = tmux(['display-message', '-p', '-t', target, '#{history_size}'])
  const hsN = Number((hs.stdout || '').trim())
  const headCap = Number.isFinite(hsN) && hsN > capture_head_and_tail_line * 2
    ? tmux(['capture-pane', '-pt', target, '-p', '-S', `-${hsN}`, '-E', String(-hsN + capture_head_and_tail_line - 1)])
    : { status: 1, stdout: '' }
  const text = [headCap.status === 0 ? headCap.stdout : '', tailCap.status === 0 ? tailCap.stdout : ''].filter(Boolean).join('\n')
  return {
    text,
    historySize: Number.isFinite(hsN) ? hsN : 0,
  }
}

module.exports = { take_tmux_window_text }
