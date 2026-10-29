/**
 * Guard the split between hard-stop and expedited-send backend paths.
 *
 * The production bug was a lock that ended after C-c while the old tmux window was still exiting.
 * These source-level assertions keep /stop on the dedicated hard-stop method and keep urgent sends
 * on the existing pause-and-next-prompt method. Runtime window-barrier behavior is covered by the
 * companion tmux integration test.
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

const routes = read('backend/routes/sessions.ts')
const runner = read('backend/services/session-message-runner.ts')
const claudeSurface = read('backend/agents/tmux-claude-code.ts')
const claudeLifecycle = read('backend/agents/claude-code-utils/session-lifecycle.ts')
const codex = read('backend/agents/tmux-codex.ts')
const harness = read('backend/agents/deepseek-harness.ts')

const stopRoute = routes.match(/router\.post\('\/:id\/stop'[\s\S]*?router\.post\('\/:id\/pause-to-dequeue'/)?.[0] || ''
assert(stopRoute, 'stop route block must remain discoverable')
assert(stopRoute.includes('backend.pauseCurrentAndTerminateSession({'), '/stop must call the hard-stop backend method')
assert(!stopRoute.includes('backend.pauseCurrentAndResumeFromSession({'), '/stop must not call the expedited-send method')
assert(!/prompt\s*:\s*['"]{2}/.test(stopRoute), '/stop must not encode termination as an empty prompt')

const urgentBranch = runner.match(/if \(urgent\) \{[\s\S]*?\} else \{[\s\S]*?\}/)?.[0] || ''
assert(urgentBranch.includes('pauseCurrentAndResumeFromSession({ ...dispatchOpts, urgent: true })'), 'urgent send must keep its original backend method')
assert(urgentBranch.includes('noPauseCurrentAndQueueQueryAtSession(dispatchOpts)'), 'ordinary send must keep its queue method')

assert(claudeSurface.includes('pauseSessionAndNextPrompt(this, opts)'), 'Claude urgent surface must delegate to next-prompt helper')
assert(claudeSurface.includes('pauseSessionAndTerminate(this, opts)'), 'Claude stop surface must delegate to terminate helper')
assert(claudeLifecycle.includes("tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'M-Enter'])"), 'Claude urgent path must retain M-Enter separation')
assert(claudeLifecycle.includes("tmux(['kill-window', '-t', `${HUB}:${sessionId}`])"), 'Claude stop path must hard-kill a surviving window')
assert(claudeLifecycle.includes('if (windowExists(sessionId)) throw new Error'), 'Claude stop must fail unless the old window is absent')

assert(codex.includes('pauseSessionAndNextPrompt(opts)'), 'Codex urgent surface must delegate to next-prompt helper')
assert(codex.includes('pauseSessionAndTerminate(opts)'), 'Codex stop surface must delegate to terminate helper')
assert(codex.includes("tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'M-Enter'])"), 'Codex urgent path must retain M-Enter separation')
assert(codex.includes("tmux(['kill-window', '-t', `${HUB}:${sessionId}`])"), 'Codex stop path must hard-kill a surviving window')
assert(codex.includes('if (windowExists(sessionId)) throw new Error'), 'Codex stop must fail unless the old window is absent')

assert(harness.includes('pauseCurrentAndTerminateSession(opts:'), 'Harness must expose a dedicated hard-stop method')
assert(harness.includes("if (!String(opts.prompt || '').trim()) throw new Error('urgent send requires prompt')"), 'Harness expedited send must reject the old empty-prompt stop protocol')

console.log('session stop backend contract: ok')
