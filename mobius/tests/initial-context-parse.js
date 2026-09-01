/**
 * initial-context-parse.js — 前端初始消息解析器断言.
 *
 * ① 用真实会话 JSONL (27KB 首轮包装消息, claude type:user 形态) 验证 zh 辨识/切块/问题切分;
 * ② 用新 formatBody 生成的 en 包装消息验证英文路径;
 * ③ 用注入 `## 标题` 的 memory 正文验证有序锚点扫描的防误切 (后向标题/未知标题不切)。
 *
 * 运行: node --require tsx/cjs tests/initial-context-parse.js
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { extractInitialContext, initialContextSummaryLine } = require('../frontend/src/components/viewer/initial-context')
const { formatBody } = require('../backend/services/session-context')

const failures = []
function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

// ── ① 真实 JSONL (中文, claude type:user) ──────────────────────────────────
const realJsonl = path.join(os.homedir(), '.claude/projects/-home-tianyi-imac-test/e74bf815-bba7-4e82-9b49-df7f217dc6ba.jsonl')
if (!fs.existsSync(realJsonl)) {
  console.log(`  skip 真实 JSONL 用例 (文件不存在: ${realJsonl})`)
} else {
  let firstUser = null
  for (const line of fs.readFileSync(realJsonl, 'utf-8').split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e.type === 'user' && typeof e.message?.content === 'string' && e.message.content.includes('以下信息描述了你正在协助的用户')) {
        firstUser = e
        break
      }
    } catch {}
  }
  check('真实 JSONL: 找到首轮包装消息', !!firstUser)
  if (firstUser) {
    const match = extractInitialContext(firstUser)
    check('真实 JSONL: 辨识为初始消息 (zh)', !!match && match.language === 'zh')
    check('真实 JSONL: 问题切分正确 (以会话名开头, 含 easy_mode 路径)',
      !!match && match.question.startsWith('前端修改（8月）') && match.question.includes('/u/yiteam-admin/easy_mode'))
    const keys = match ? match.blocks.map((b) => b.key) : []
    check('真实 JSONL: 块序列符合拼装顺序',
      JSON.stringify(keys) === JSON.stringify(['user', 'project', 'memory', 'skills', 'completionFlag', 'issue', 'session']),
      JSON.stringify(keys))
    const memBlock = match ? match.blocks.find((b) => b.key === 'memory') : null
    const subCount = memBlock ? (memBlock.body.match(/^### /gm) || []).length : 0
    check('真实 JSONL: memory 块保留全部子记忆 (### 数量>5)', subCount > 5, `subCount=${subCount}`)
    check('真实 JSONL: 摘要行为「初始 · 问题首行」', initialContextSummaryLine(match).startsWith('初始 · 前端修改'), initialContextSummaryLine(match))
  }
}

// ── ② 英文包装 (codex response_item 形态) ─────────────────────────────────
const enSources = {
  user: { id: 'alice', display_name: 'Alice', role: 'developer' },
  project: { name: 'demo', description: 'desc', bind_path: '/repo/demo' },
  issue: { id: 'i1', title: 'Fix login', description: 'redirect bug', status: 'in_progress', use_worktree: false, worktree_branch: '' },
  session: { session_id: 's1', name: 'session one', description: '', status: 'active', pc_client_metadata: null },
  skills: [{ name: 'sk1', dirName: 'sk1', description: 'd1' }],
  memories: [],
  language: 'en',
}
const stubDeps = {
  createResearchSessionToken: (r, s) => `T<${r}|${s}>`,
  createChiefTeamToken: (r, s) => `C<${r}|${s}>`,
  isGitRepoRoot: () => false,
  isAssistantSession: () => false,
  pcTaskModePrompt: () => '',
  builtinMemories: [{ name: 'bm', description: 'bd', body: 'bb' }],
  env: { port: 1, hiddenFolderName: '.imac', skillsSubdir: 'skills-sub' },
  blackboardTokenHeader: 'x-s',
  teamTokenHeader: 'x-t',
}
const enBody = formatBody(enSources, stubDeps)
const enQuestion = 'Please fix the redirect loop\nwhen using easy mode.'
const enWrapped = `${enBody}\n\n---\n\n## User's Question\n${enQuestion}`
const enEntry = { type: 'response_item', payload: { type: 'message', role: 'user', content: enWrapped } }
const enMatch = extractInitialContext(enEntry)
check('英文: 辨识 (en)', !!enMatch && enMatch.language === 'en')
check('英文: 问题完整切出', enMatch ? enMatch.question === enQuestion : false, JSON.stringify(enMatch && enMatch.question))
check('英文: 块序列含 user/project/memory/skills/completionFlag/issue/session',
  enMatch && ['user', 'project', 'memory', 'skills', 'completionFlag', 'issue', 'session']
    .every((k) => enMatch.blocks.some((b) => b.key === k)))

// ── ③ 防误切: memory 正文里的 `## 标题` ────────────────────────────────────
const trickyDeps = { ...stubDeps, builtinMemories: [] }
const trickySources = {
  ...enSources,
  memories: [{ name: 'tricky', description: 'd', body: 'body line\n## 用户\nbackward title\n## Not In Catalog\nunknown title\nmore body' }],
}
const trickyBody = formatBody(trickySources, trickyDeps)
const trickyWrapped = `${trickyBody}\n\n---\n\n## User's Question\nq`
const trickyMatch = extractInitialContext({ type: 'user', message: { content: trickyWrapped } })
const trickyMem = trickyMatch ? trickyMatch.blocks.find((b) => b.key === 'memory') : null
check('防误切: memory 正文中的后向/未知 ## 标题不产生新块',
  trickyMatch && trickyMatch.blocks.map((b) => b.key).join(',') === 'user,project,memory,skills,completionFlag,issue,session',
  trickyMatch && trickyMatch.blocks.map((b) => b.key).join(','))
check('防误切: memory 正文原样保留在 memory 块内',
  !!trickyMem && trickyMem.body.includes('## 用户') && trickyMem.body.includes('## Not In Catalog'))

// 非初始消息不误判
const plain = extractInitialContext({ type: 'user', message: { content: '请帮我看一下这个报错\n## 用户的问题\n假标题' } })
check('非初始消息: 不误判', plain === null)

console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} failure(s): ${failures.join(', ')}`)
  process.exit(1)
}
console.log('all initial-context parse assertions passed')
