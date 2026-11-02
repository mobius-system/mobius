import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const chat = fs.readFileSync(new URL('../src/components/chat.tsx', import.meta.url), 'utf8')
const easy = fs.readFileSync(new URL('../src/pages/EasyModePage.tsx', import.meta.url), 'utf8')
function run(source, globals = {}) {
  const context = { ...globals }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
  return context
}
function between(source, start, end) { const i = source.indexOf(start); assert(i >= 0, start); const j = source.indexOf(end, i); assert(j > i, end); return source.slice(i, j) }
const chaseSource = between(chat, '  const chase = () => {', '  // 浮窗探针:')
for (const gap of [1, 8, 24, 25, 1000]) {
  let top = 2000 - 500 - gap, seq = 0
  const pending = new Map(), effects = []
  const el = { scrollHeight: 2000, clientHeight: 500, get scrollTop() { return top }, set scrollTop(v) { top = Math.min(1500, Math.round(v)) } }
  const state = { current: 0 }
  const env = run(chaseSource + '\nglobalThis.schedule = schedulePin;', {
    LERP_FOLLOW_K: 0.06, LERP_SNAP_PX: 24, rafRef: state, chaseFrameRef: { current: 0 },
    containerRef: { current: el }, matchActiveRef: { current: false }, searchHighlightActiveRef: { current: false }, userScrolledUpRef: { current: false },
    diagRef: { current: { frames: 0, scheduleAttempts: 0, scheduleBlocked: 0 } }, scrollDebug() {},
    requestAnimationFrame(fn) { pending.set(++seq, fn); return seq }, cancelAnimationFrame(id) { pending.delete(id) }, useEffect(fn) { effects.push(fn) },
  })
  env.schedule()
  let frames = 0
  while (pending.size && frames++ < 200) { const [id, cb] = pending.entries().next().value; pending.delete(id); cb() }
  assert.equal(top, 1500, `must reach bottom from gap ${gap}`)
  assert.equal(pending.size, 0, 'RAF loop must finish')
  assert.equal(state.current, 0)
  env.schedule(); effects[0]()(); assert.equal(state.current, 0, 'StrictMode cleanup clears cancelled handle')
  env.schedule(); assert.equal(pending.size, 1, 'can schedule again after cleanup')
}
console.log('PASS scrolling reaches bottom and stops; cancelled RAF can restart')
const tabSource = between(chat, '  const handleExpandedInputKeyDown =', '  useEffect(() => {\n    if (!inputMenuOpen)')
for (const variant of ['normal', 'shift', 'ime', 'native-ime', 'keycode-ime', 'ctrl']) {
  let output = 'abcdef', prevented = false
  const el = { selectionStart: 1, selectionEnd: 4 }
  const env = run(tabSource + '\nglobalThis.handler = handleExpandedInputKeyDown;', {
    input: output, composingRef: { current: variant === 'ime' }, useCallback: fn => fn,
    setInput: v => { output = v }, requestAnimationFrame: fn => fn(),
  })
  env.handler({ key: 'Tab', shiftKey: variant === 'shift', ctrlKey: variant === 'ctrl', nativeEvent: { isComposing: variant === 'native-ime', keyCode: variant === 'keycode-ime' ? 229 : 9 }, currentTarget: el, preventDefault() { prevented = true } })
  assert.equal(output, variant === 'normal' ? 'a    ef' : 'abcdef')
  assert.equal(prevented, variant === 'normal')
  if (variant === 'normal') assert.equal(el.selectionStart, 5)
}
console.log('PASS Tab replaces selection; modifiers and IME remain untouched')
const helpers = fs.readFileSync(new URL('../src/services/easy-mode-defaults.ts', import.meta.url), 'utf8')
const exports = {}; run(helpers, { exports })
const ensure = between(easy, 'async function ensureEasyIssue(', 'function readListMode')
for (const title of ['日常会话', 'a random chat', ' A RANDOM CHAT ']) {
  let posts = 0
  const ctx = run(ensure + '\nglobalThis.ensure = ensureEasyIssue;', { ...exports, api: async (url, opts) => { if (opts) posts++; return [{ id: 'existing', title }] } })
  assert.equal((await ctx.ensure('p', '日常会话')).id, 'existing'); assert.equal(posts, 0)
}
const submit = between(easy, '  const submitWelcomePrompt = async () => {', '  const handleDeleteSession')
for (const kind of ['stale', 'readonly', 'valid', 'legacy']) {
  const requests = [], errors = [], selections = []
  const fallback = { id: 'fallback', name: kind === 'legacy' ? 'let-us-chat' : '快捷任务', created_by: 'user' }
  const chosen = { id: 'chosen', name: 'Chosen', can_create_session: kind !== 'readonly' }
  const projects = [fallback, ...(kind === 'valid' || kind === 'readonly' ? [chosen] : [])]
  const selection = { createProject: false, projectId: kind === 'legacy' ? '' : 'chosen', issueId: 'old-issue', issueTitle: 'Old', model: 'model', language: 'zh', excludedSkills: ['excluded'], excludedMemories: [], projectName: '', projectPath: '' }
  const ctx = run(submit + '\nglobalThis.submit = submitWelcomePrompt;', {
    ...exports, welcomePrompt: 'hello', welcomeAttachmentsReady: false, welcomeCreating: false, welcomeAttachmentsUploading: false,
    welcomeAttachments: [], appendAttachmentsToDesc: x => x, welcomeSelection: selection, projects, user: { id: 'user' },
    setWelcomeSelection: fn => selections.push(fn(selection)), setCreateErrorToast: x => errors.push(x), setWelcomeCreating() {}, setProjects() {},
    ensureEasyIssue: async id => ({ id: `${id}-issue`, title: '日常会话' }), formatDefaultSessionName: () => 'test',
    api: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { session_id: 'new' } },
    scheduleRefreshAfterSend() {}, handleSessionCreated() {}, setWelcomePrompt() {}, clearWelcomeAttachments() {},
  })
  await ctx.submit()
  if (kind === 'readonly') { assert.equal(requests.length, 0); assert.equal(errors.length, 1); assert.equal(selections[0].projectId, '') }
  else { assert.equal(errors.length, 0); assert.equal(requests[0].url, kind === 'valid' ? '/api/issues/old-issue/sessions' : '/api/issues/fallback-issue/sessions'); assert.equal(requests[0].body.excluded_skill_ids.length, kind === 'valid' ? 1 : 0) }
}
console.log('PASS legacy names reused; stale/read-only project selections cannot submit to the wrong issue')
const visibility = between(chat, '  const sessionToolVisibilityOptions =', '  const renderSessionToolGroup =')
for (const isAdminUser of [false, true]) for (const layout of ['default', 'stacked', 'easy']) {
 const ctx = run(visibility + '\nglobalThis.options = sessionToolVisibilityOptions;', { isAdminUser, layout, useMemo: fn => fn(), SESSION_TOOL_VISIBILITY_OPTIONS: [{ id: 'terminal' }, { id: 'jsonl-meta' }, { id: 'other' }] })
 assert.equal(ctx.options.some(x => x.id === 'terminal'), isAdminUser)
 assert.equal(ctx.options.some(x => x.id === 'jsonl-meta'), layout === 'easy')
}
console.log('PASS visibility settings match admin access and layout')
const deviceSource = fs.readFileSync(new URL('../src/components/aimux-link-indicator.tsx', import.meta.url), 'utf8')
const deviceExports = {}
run(between(deviceSource, 'function parsePcMeta(', 'function getDesktopBridge('), { exports: deviceExports })
for (const raw of [null, '{bad json', { aimux_id: 'remote', work_mode: 'dual', gui_authorized: true }, JSON.stringify({ aimux_id: 'remote', work_mode: 'pc', gui_authorized: true })]) {
  const result = deviceExports.continuationDevice({ pc_client_metadata: raw })
  const valid = raw && raw !== '{bad json'
  assert.equal(result.aimuxId, valid ? 'remote' : null)
  assert.equal(result.guiAuthorized, !!valid)
  assert.equal(result.requiresAimux, !!valid)
}
console.log('PASS continuation device parses object/JSON metadata and safely handles missing/invalid metadata')
