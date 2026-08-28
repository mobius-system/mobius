const path = require('path')

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function assertAbsoluteExecutable(executable, label) {
  if (!path.isAbsolute(executable)) throw new Error(`${label} CLI executable 必须是绝对路径`)
}

function buildCodexCliExec({ executable, useProxy, proxyConfig, profileKey, subcommand, codexArgs }) {
  assertAbsoluteExecutable(executable, 'Codex')
  const executableArg = shellQuote(executable)
  const cliParts = [executableArg]
  // native 模式不传 profile，Codex 会直接使用 $CODEX_HOME/config.toml + auth.json。
  if (profileKey) cliParts.push('--profile', shellQuote(profileKey))
  if (subcommand) cliParts.push(shellQuote(subcommand))
  cliParts.push(...(codexArgs || []).map(shellQuote))
  const cli = cliParts.join(' ')
  return useProxy
    ? `exec proxychains -q -f ${shellQuote(proxyConfig)} ${cli}`
    : `exec ${cli}`
}

function buildClaudeCliExec({ executable, useProxy, proxyConfig, settingsArg, claudeArgs }) {
  assertAbsoluteExecutable(executable, 'Claude Code')
  const executableArg = shellQuote(executable)
  // native 模式 settingsArg 为空，不能回填一个并不存在的 Mobius settings 文件。
  const cli = [executableArg, String(settingsArg || '').trim(), ...(claudeArgs || [])]
    .filter(Boolean)
    .join(' ')
  return useProxy
    ? `exec proxychains -q -f ${shellQuote(proxyConfig)} ${cli}`
    : `exec ${cli}`
}

module.exports = {
  buildClaudeCliExec,
  buildCodexCliExec,
}
