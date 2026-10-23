/**
 * agent-backend-contract.test — every method the rest of the backend calls on
 * an agent backend must still exist on one of the backend classes.
 *
 * Why this exists: the agent backends are reached through a dynamically typed
 * registry (`agents.get(name)` returns any), so tsc cannot see these calls. A
 * refactor that moved a private method out of a backend produced no error at
 * all — six call sites guarded the call with `typeof backend._x === 'function'`
 * and quietly resolved null, which blanked the chat. This scan turns that
 * silent class of breakage into a failing test.
 *
 * It reads source text instead of instantiating the backends: constructing
 * them starts jsonl watchers, opens the shared database and spawns tmux.
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

// 后端类实现文件: 方法名从这里静态解析
// Backend implementation files; method names are parsed from their source
const BACKEND_FILES = [
  'backend/agents/tmux-claude-code.ts',
  'backend/agents/tmux-codex.ts',
  'backend/agents/deepseek-harness.ts',
  'backend/agents/base.ts',
]

// 扫描后端调用面的目录
// Directories scanned for `backend.<method>(` call sites
const CALLER_DIRS = ['backend/routes', 'backend/services', 'backend/utils']

// 非方法调用的误报 (日志文案 / 注释里的示意写法)
// False positives: log text and illustrative names inside comments
const IGNORE = new Set(['jobAccomplished', 'isXxx'])

function methodsOfSource(src) {
  const names = new Set()
  let inClass = false
  for (const line of src.split('\n')) {
    if (/^class \w+/.test(line)) { inClass = true; continue }
    if (!inClass) continue
    const m = line.match(/^ {2}(?:async )?(?:get |set )?([A-Za-z_$][\w$]*)\s*\(/)
    if (m) names.add(m[1])
  }
  return names
}

// 去掉块注释与行注释, 扫描只看真实代码 (注释里会举例写 backend._x)
// Strip block and line comments; only real code is scanned
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function listFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listFiles(full, acc)
    else if (/\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) acc.push(full)
  }
  return acc
}

const available = new Set()
for (const rel of BACKEND_FILES) {
  for (const name of methodsOfSource(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) available.add(name)
}

const missing = new Map()
for (const dir of CALLER_DIRS) {
  for (const file of listFiles(path.join(ROOT, dir))) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    for (const line of src.split('\n')) {
      const re = /\bbackend\??\.([A-Za-z_][\w]*)\s*\(/g
      let m
      while ((m = re.exec(line)) !== null) {
        const name = m[1]
        if (IGNORE.has(name) || available.has(name)) continue
        const where = path.relative(ROOT, file)
        if (!missing.has(name)) missing.set(name, [])
        missing.get(name).push(`${where}:${src.slice(0, line.length ? src.indexOf(line) : 0).split('\n').length}`)
      }
    }
  }
}

const report = [...missing.entries()]
  .map(([name, sites]) => `  ${name} — called at ${[...new Set(sites)].join(', ')}`)
  .join('\n')
assert.strictEqual(missing.size, 0, `后端调用面引用了不存在的 backend 方法:\n${report}`)

// 反向检查: 六处 "typeof backend?.x === 'function'" 探针也必须指向真实方法
// Reverse check: every typeof probe must point at a method that exists
const probeRe = /typeof\s+backend\??\.([A-Za-z_][\w]*)\s*===/g
const badProbes = []
for (const dir of CALLER_DIRS) {
  for (const file of listFiles(path.join(ROOT, dir))) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    let m
    while ((m = probeRe.exec(src)) !== null) {
      if (!available.has(m[1])) badProbes.push(`${path.relative(ROOT, file)}: ${m[1]}`)
    }
  }
}
assert.deepStrictEqual(badProbes, [], `探针检查了不存在的方法:\n  ${badProbes.join('\n  ')}`)

console.log(`agent backend contract: ok (${available.size} methods, ${missing.size} missing)`)
process.exit(0)
