/**
 * session-context-parity.js — 新旧 formatBody 输出逐字节一致性验证.
 *
 * 旧实现逐字复制在 ./session-context-legacy-baseline.ts (服务端依赖参数化),
 * 新实现是 services/session-context.ts 的 sections 编排。两侧用同一组确定性桩
 * (token 工厂 / isGitRepoRoot / pcTaskModePrompt / 内置记忆), 对多组 sources 断言
 * 输出完全一致 —— 重构不允许改变注入给模型的 prompt 文本。
 *
 * 运行: node --require tsx/cjs tests/session-context-parity.js
 */
const { makeLegacyFormatBody } = require('./session-context-legacy-baseline')
const { formatBody } = require('../backend/services/session-context')
const { BUILTIN_MEMORIES } = require('../backend/services/builtin-memories')

// ── 确定性桩 (新旧两侧共用) ────────────────────────────────────────────────
const stubDeps = {
  PORT: 45616,
  HIDDEN_FOLDER_NAME: '.imac',
  SKILLS_SUBDIR: 'skills-sub',
  createChiefTeamToken: (r, s) => `CHIEF-TOK<${r}|${s}>`,
  createResearchSessionToken: (r, s) => `SESS-TOK<${r}|${s}>`,
  RESEARCH_SESSION_TOKEN_HEADER: 'x-test-session-token',
  TEAM_TOKEN_HEADER: 'x-test-team-token',
  isGitRepoRoot: (root) => String(root || '').startsWith('/repo'),
  isAssistantSession: (session) => !!session && typeof session.session_key === 'string' && session.session_key.startsWith('assistant-question:'),
  pcTaskModePrompt: (raw, lang) => (raw && raw.work_mode && ['hub', 'pc', 'dual'].includes(raw.work_mode) && raw.aimux_id)
    ? `PC-PROMPT<${raw.work_mode}|${raw.aimux_id}|${lang}>`
    : '',
  BUILTIN_MEMORIES,
}

const newFormatDeps = {
  createResearchSessionToken: stubDeps.createResearchSessionToken,
  createChiefTeamToken: stubDeps.createChiefTeamToken,
  isGitRepoRoot: stubDeps.isGitRepoRoot,
  isAssistantSession: stubDeps.isAssistantSession,
  pcTaskModePrompt: stubDeps.pcTaskModePrompt,
  builtinMemories: stubDeps.BUILTIN_MEMORIES,
  env: { port: stubDeps.PORT, hiddenFolderName: stubDeps.HIDDEN_FOLDER_NAME, skillsSubdir: stubDeps.SKILLS_SUBDIR },
  blackboardTokenHeader: stubDeps.RESEARCH_SESSION_TOKEN_HEADER,
  teamTokenHeader: stubDeps.TEAM_TOKEN_HEADER,
}

const legacyFormatBody = makeLegacyFormatBody(stubDeps)

// ── sources 矩阵 ──────────────────────────────────────────────────────────
const USER = { id: 'fuqingxu', display_name: '付清旭', role: 'admin' }
const USER2 = { id: 'alice', display_name: '', role: 'developer' }
const PROJECT = { id: 'p1', name: 'imac-self-develop', description: 'imac自进化', bind_path: '/repo/imac-test' }
const PROJECT_NOBIND = { id: 'p2', name: '裸项目', description: '', bind_path: '' }
const ISSUE = { id: '25eb1b82', title: '前端修改（9月）', description: '初始消息卡片改进\n仅前端', status: 'in_progress', use_worktree: true, worktree_branch: 'wt/initial-card' }
const ISSUE_NOWT = { id: '0c7e8c7f', title: '普通任务', description: '', status: 'active', use_worktree: false, worktree_branch: '' }
const SESSION = { session_id: 'c1524307', name: '前端修改（9月） 2026-09-01 16:41', description: '初始消息卡片改进（仅前端）', status: 'active', pc_client_metadata: null }
const SESSION_PC = { ...SESSION, session_id: 'pc123', pc_client_metadata: { work_mode: 'dual', aimux_id: 'aimux-9' } }
const SESSION_ASSISTANT = { ...SESSION, session_id: 'asst1', session_key: 'assistant-question:fuqingxu:x1' }
const SESSION_DRAFT = { ...SESSION, session_id: '(待创建)' }
const RESEARCH = { id: '3b782686', title: '深度研究', description: '多智能体协作', status: 'active', mode: 'chief_led', assistant_limit: 5 }
const RESEARCH_CUSTOM = { id: '9017cdba', title: 'Custom Research', description: '', status: 'active', mode: 'custom' }
const SKILLS = [
  { name: 'mobius-self-iter', dirName: 'mobius-self-iter', description: 'What to do after self iter' },
  { name: '裸skill', dirName: '', description: '' },
]
const MEMORIES = [
  { name: '向用户展示图像', description: 'display_images 用法', body: '图片路径必须是绝对路径。\n第二行\n含\r\nCRLF' },
  { name: '无描述记忆', description: '', body: '只有正文' },
]
const PEERS = [
  { research_role: 'chief_researcher', session_id: 'aaa111', name: '首席', status: 'active' },
  { research_role: '', session_id: 'bbb222', name: '队员', status: 'completed' },
]

const CASES = [
  ['zh-issue-full', { user: USER, project: PROJECT, issue: ISSUE, session: SESSION, skills: SKILLS, memories: MEMORIES, language: 'zh' }],
  ['en-issue-full', { user: USER2, project: PROJECT, issue: ISSUE, session: SESSION, skills: SKILLS, memories: MEMORIES, language: 'en' }],
  ['zh-research-chief', { user: USER, project: PROJECT, research: RESEARCH, session: { ...SESSION, research_role: 'chief_researcher' }, research_peers: PEERS, skills: SKILLS, memories: MEMORIES, language: 'zh' }],
  ['en-research-chief', { user: USER, project: PROJECT, research: RESEARCH, session: { ...SESSION, research_role: 'chief_researcher' }, research_peers: PEERS, skills: SKILLS, memories: MEMORIES, language: 'en' }],
  ['zh-research-assistant-draft', { user: USER, project: PROJECT, research: RESEARCH_CUSTOM, session: { ...SESSION_DRAFT, research_role: 'research_assistant' }, research_peers: [], skills: [], memories: [], language: 'zh' }],
  ['en-research-assistant-draft', { user: USER, project: PROJECT, research: RESEARCH_CUSTOM, session: { ...SESSION_DRAFT, research_role: 'research_assistant' }, research_peers: [], skills: [], memories: [], language: 'en' }],
  ['zh-worktree-not-repo', { user: USER, project: { ...PROJECT, bind_path: '/not/a/repo' }, issue: ISSUE, session: SESSION, skills: [], memories: [], language: 'zh' }],
  ['en-worktree-not-repo', { user: USER, project: { ...PROJECT, bind_path: '/not/a/repo' }, issue: ISSUE, session: SESSION, skills: [], memories: [], language: 'en' }],
  ['zh-assistant-session', { user: USER, project: PROJECT, issue: ISSUE, session: SESSION_ASSISTANT, skills: [], memories: [], language: 'zh' }],
  ['en-assistant-session', { user: USER, project: PROJECT, issue: ISSUE, session: SESSION_ASSISTANT, skills: [], memories: [], language: 'en' }],
  ['zh-pc-task-mode', { user: USER, project: PROJECT, issue: ISSUE_NOWT, session: SESSION_PC, skills: [], memories: [], language: 'zh' }],
  ['en-pc-task-mode', { user: USER, project: PROJECT, issue: ISSUE_NOWT, session: SESSION_PC, skills: [], memories: [], language: 'en' }],
  ['zh-minimal', { user: null, project: null, issue: null, session: null, skills: [], memories: [], language: 'zh' }],
  ['en-minimal', { user: null, project: null, issue: null, session: null, skills: [], memories: [], language: 'en' }],
  ['zh-no-bindpath', { user: USER, project: PROJECT_NOBIND, issue: ISSUE_NOWT, session: SESSION, skills: [], memories: MEMORIES, language: 'zh' }],
  ['en-no-bindpath', { user: USER, project: PROJECT_NOBIND, issue: ISSUE_NOWT, session: SESSION, skills: [], memories: MEMORIES, language: 'en' }],
  ['zh-research-no-issue-hint', { user: USER, project: PROJECT, research: RESEARCH_CUSTOM, session: SESSION, research_peers: PEERS.slice(0, 1), skills: SKILLS.slice(0, 1), memories: MEMORIES.slice(0, 1), language: 'zh' }],
  ['en-research-no-issue-hint', { user: USER, project: PROJECT, research: RESEARCH_CUSTOM, session: SESSION, research_peers: PEERS.slice(0, 1), skills: SKILLS.slice(0, 1), memories: MEMORIES.slice(0, 1), language: 'en' }],
  ['zh-empty-body-memory-nobind', { user: USER, project: PROJECT_NOBIND, issue: ISSUE_NOWT, session: SESSION, skills: [], memories: [{ name: '空正文记忆', description: 'd', body: '' }], language: 'zh' }],
  ['en-empty-body-memory-nobind', { user: USER, project: PROJECT_NOBIND, issue: ISSUE_NOWT, session: SESSION, skills: [], memories: [{ name: 'empty', description: '', body: '' }], language: 'en' }],
  ['zh-language-fallback', { user: USER, project: PROJECT, issue: ISSUE_NOWT, session: SESSION, skills: [], memories: [], language: 'fr' }],
  ['zh-empty-everything', { user: USER, project: PROJECT, issue: null, session: SESSION, skills: [], memories: [], language: 'zh' }],
]

// 内存段为空时 (builtinMemories 也清空) 的补充用例: 走 deps 覆盖
const CASES_NO_BUILTIN = [
  ['zh-no-memory-at-all', { user: USER, project: PROJECT, issue: ISSUE_NOWT, session: SESSION, skills: SKILLS, memories: [], language: 'zh' }],
  ['en-no-memory-at-all', { user: USER, project: PROJECT, issue: ISSUE_NOWT, session: SESSION, skills: SKILLS, memories: [], language: 'en' }],
]

function showContext(text, idx) {
  const from = Math.max(0, idx - 60)
  const to = Math.min(text.length, idx + 60)
  const esc = (s) => s.replace(/\n/g, '⏎').replace(/\t/g, '⇥')
  return `[${from}..${to}] …${esc(text.slice(from, idx))}▶${esc(text.slice(idx, to))}…`
}

let failures = 0
let total = 0

function runCase(name, sources, deps) {
  total += 1
  deps = deps || newFormatDeps
  const legacy = legacyFormatBody(sources, deps)
  const modern = formatBody(sources, deps)
  if (legacy === modern) {
    console.log(`  ok   ${name}  (${legacy.length} chars)`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}: legacy ${legacy.length} chars vs modern ${modern.length} chars`)
  let idx = 0
  while (idx < Math.min(legacy.length, modern.length) && legacy[idx] === modern[idx]) idx += 1
  console.log(`    first divergence at char ${idx}:`)
  console.log(`    legacy : ${showContext(legacy, idx)}`)
  console.log(`    modern : ${showContext(modern, idx)}`)
  if (process.env.PARITY_DUMP) {
    const fs = require('fs')
    fs.writeFileSync(`/tmp/parity-${name}-legacy.txt`, legacy)
    fs.writeFileSync(`/tmp/parity-${name}-modern.txt`, modern)
    console.log(`    dumped to /tmp/parity-${name}-{legacy,modern}.txt`)
  }
}

console.log('session-context formatBody parity (legacy vs sections)')
for (const [name, sources] of CASES) runCase(name, sources)
for (const [name, sources] of CASES_NO_BUILTIN) {
  const legacyDeps = { ...stubDeps, BUILTIN_MEMORIES: [] }
  const modernDeps = { ...newFormatDeps, builtinMemories: [] }
  const legacy = makeLegacyFormatBody(legacyDeps)(sources, legacyDeps)
  const modern = formatBody(sources, modernDeps)
  total += 1
  if (legacy === modern) console.log(`  ok   ${name}  (${legacy.length} chars)`)
  else {
    failures += 1
    console.log(`  FAIL ${name}`)
    let idx = 0
    while (idx < Math.min(legacy.length, modern.length) && legacy[idx] === modern[idx]) idx += 1
    console.log(`    first divergence at char ${idx}:`)
    console.log(`    legacy : ${showContext(legacy, idx)}`)
    console.log(`    modern : ${showContext(modern, idx)}`)
  }
}

// ── 自洽性: 每个块的 build 输出首行必须命中自身 pattern ──────────────────────
const { SESSION_SECTIONS } = require('../backend/services/session-context-sections')
let selfCheckFailures = 0
const probeCtx = {
  ...CASES[2][1],
  env: newFormatDeps.env,
  builtin_memories: newFormatDeps.builtinMemories,
  blackboard_session_token: 'SESS-TOK<x>',
  blackboard_token_header: newFormatDeps.blackboardTokenHeader,
  chief_team_token: 'CHIEF-TOK<x>',
  team_token_header: newFormatDeps.teamTokenHeader,
  worktree_is_repo_root: false,
  pc_task_mode_prompt_zh: 'PC',
  pc_task_mode_prompt_en: 'PC',
  session_is_assistant: false,
}
for (const section of SESSION_SECTIONS) {
  const zhText = section.build.zh(probeCtx, section.title)
  const enText = section.build.en(probeCtx, section.title)
  for (const [lang, text] of [['zh', zhText], ['en', enText]]) {
    if (!text) continue
    const firstLine = text.split('\n')[0]
    if (!section.pattern[lang].test(firstLine + '\n')) {
      selfCheckFailures += 1
      console.log(`  SELF-CHECK FAIL ${section.key}[${lang}]: first line not matched by own pattern: ${JSON.stringify(firstLine)}`)
    }
  }
}
if (selfCheckFailures === 0) console.log(`  self-check ok: all ${SESSION_SECTIONS.length} sections' build output matches own pattern`)

console.log('')
if (failures > 0 || selfCheckFailures > 0) {
  console.log(`${failures + selfCheckFailures} failure(s) out of ${total} parity cases + self-check`)
  process.exit(1)
}
console.log(`all ${total} parity cases byte-identical`)
