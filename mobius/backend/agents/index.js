/**
 * agents/index.js — backend 工厂 + module-level singleton registry.
 *
 * 用法:
 *   const agents = require('../agents')
 *   const backend = agents.get('tmux-claude-code')
 *   await backend.createNewSession({...})
 *
 * 注册的 backend:
 *   - 'tmux-claude-code'   TUI + tmux paste-buffer + jsonl 文件 tail
 *   - 'tmux-codex'         Codex TUI + tmux paste-buffer + $CODEX_HOME rollout jsonl tail
 */
const { TmuxClaudeCodeBackend } = require('./tmux-claude-code')
const { TmuxCodexBackend } = require('./tmux-codex')
const { DeepSeekHarnessBackend } = require('./deepseek-harness')

const singletons = {}

function get(name) {
  if (!singletons[name]) {
    switch (name) {
      case 'tmux-claude-code': singletons[name] = new TmuxClaudeCodeBackend(); break
      case 'tmux-codex':       singletons[name] = new TmuxCodexBackend(); break
      case 'deepseek-harness':  singletons[name] = new DeepSeekHarnessBackend(); break
      default: throw new Error(`unknown agent backend: ${name}`)
    }
  }
  return singletons[name]
}

module.exports = { get }
