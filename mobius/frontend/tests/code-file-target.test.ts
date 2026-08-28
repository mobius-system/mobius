import assert from 'node:assert/strict'
import {
  formatFileTarget,
  parseFileTarget,
  resolveProjectRelativePath,
  stripFileTargetLocation,
  withFileTargetRange,
  workspaceTabKey,
  filePathSegments,
} from '../src/components/code-artifacts/file-target'
import { highlightFileLines, highlightLanguageId, splitHighlightedHtml } from '../src/components/code-artifacts/highlight-file-lines'
import { codeLanguageFromPath } from '../src/components/code-artifacts/CodeBlock'
import { findFileTargetsInText, remarkFileTargets } from '../src/components/code-artifacts/remark-file-targets'
import { EditorState } from '@codemirror/state'
import { editorSelectionForLocation } from '../src/components/workspace/code-mirror-editor'

function test(name: string, run: () => void) {
  try {
    run()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

test('parses colon line and column', () => {
  const target = parseFileTarget('src/components/chat.tsx:42:7')
  assert.ok(target)
  assert.equal(target.path, 'src/components/chat.tsx')
  assert.equal(target.line, 42)
  assert.equal(target.column, 7)
  assert.equal(target.endLine, null)
})

test('preserves hash line range', () => {
  const target = parseFileTarget('/workspace/repo/src/a.ts#L12-L30')
  assert.ok(target)
  assert.equal(target.path, '/workspace/repo/src/a.ts')
  assert.equal(target.line, 12)
  assert.equal(target.endLine, 30)
  assert.equal(formatFileTarget(target).lineLabel, 'L12–L30')
})

test('normalizes explicit editor ranges without inventing columns', () => {
  const target = parseFileTarget('src/a.ts:12:7')
  assert.ok(target)
  assert.deepEqual(withFileTargetRange(target, 12, 12), target)
  assert.deepEqual(withFileTargetRange(target, 20, 24), {
    ...target,
    line: 20,
    column: null,
    endLine: 24,
  })
})

test('does not resolve workspace paths before metadata', () => {
  const target = parseFileTarget('/workspace/repo/src/a.ts#L4')
  assert.ok(target)
  assert.equal(target.path, '/workspace/repo/src/a.ts')
  assert.deepEqual(resolveProjectRelativePath(target), {
    ok: false,
    code: 'metadata-unavailable',
    error: '项目路径信息尚未加载',
  })
  assert.deepEqual(resolveProjectRelativePath(target, { bindPath: '/Users/me/repo' }), { ok: true, path: '/src/a.ts' })
  const nested = parseFileTarget('/workspaces/alice/repo/src/a.ts')
  assert.ok(nested)
  assert.deepEqual(resolveProjectRelativePath(nested, { bindPath: '/Users/me/repo' }), { ok: true, path: '/src/a.ts' })
})

test('rejects natural-language slash phrases', () => {
  assert.equal(parseFileTarget('app/daemon'), null)
  assert.deepEqual(findFileTargetsInText('This app/daemon behavior is intentional.'), [])
})

test('rejects version and section numbers as file targets', () => {
  for (const candidate of ['1.1', '/1.1', '2.0', '1.2.3', 'report.1', '/src/report.0']) {
    assert.equal(parseFileTarget(candidate), null)
    assert.equal(parseFileTarget(candidate, { context: 'inline-code' }), null)
    assert.equal(parseFileTarget(candidate, { context: 'href' }), null)
  }
  assert.deepEqual(findFileTargetsInText('## 1.1 调研方案'), [])
  assert.deepEqual(findFileTargetsInText('详见第 1.1 节'), [])
})

test('requires text paths to look like files while preserving trusted paths', () => {
  assert.equal(parseFileTarget('/tmp'), null)
  assert.equal(parseFileTarget('/foo'), null)
  assert.ok(parseFileTarget('/src/a.ts'))
  assert.ok(parseFileTarget('.gitignore', { context: 'inline-code' }))
  assert.ok(parseFileTarget('Dockerfile', { context: 'trusted' }))
  assert.ok(parseFileTarget('Makefile', { context: 'trusted' }))
  assert.ok(parseFileTarget('/etc/hosts', { context: 'trusted' }))
})

test('rejects app routes', () => {
  assert.equal(parseFileTarget('/api/projects/abc/file:12'), null)
  assert.equal(parseFileTarget('/u/alice/s/session.ts:12'), null)
  assert.equal(parseFileTarget('/workspace/settings#L12'), null)
})

test('supports Windows and file URLs', () => {
  const windows = parseFileTarget('C:\\repo\\src\\main.ts:8:2')
  assert.ok(windows)
  assert.equal(windows.path, 'C:/repo/src/main.ts')
  assert.equal(windows.line, 8)
  assert.equal(windows.column, 2)

  const unc = parseFileTarget('\\\\server\\share\\src\\main.ts#L5-L9')
  assert.ok(unc)
  assert.equal(unc.path, '//server/share/src/main.ts')
  assert.equal(unc.endLine, 9)

  const fileUrl = parseFileTarget('file:///repo/src/a%20b.ts#L42C7')
  assert.ok(fileUrl)
  assert.equal(fileUrl.path, '/repo/src/a b.ts')
  assert.equal(fileUrl.line, 42)
  assert.equal(fileUrl.column, 7)
})

test('maps editor line, column and range to CodeMirror offsets', () => {
  const doc = EditorState.create({ doc: 'one\nsecond\nthird\nfour' }).doc
  assert.deepEqual(editorSelectionForLocation(doc, 2, 3), { anchor: 6, head: 6 })
  assert.deepEqual(editorSelectionForLocation(doc, 2, null, 3), { anchor: 4, head: 16 })
  assert.deepEqual(editorSelectionForLocation(doc, 99, 99, 120), { anchor: doc.length, head: doc.length })
  assert.equal(editorSelectionForLocation(doc, 0), null)
})

test('strips locations from VSCode file payloads without promising navigation', () => {
  assert.equal(stripFileTargetLocation('/repo/src/a.ts:42:7'), '/repo/src/a.ts')
  assert.equal(stripFileTargetLocation('/repo/src/a.ts:12-30'), '/repo/src/a.ts')
  assert.equal(stripFileTargetLocation('/repo/src/a.ts#L12-L30'), '/repo/src/a.ts')
  assert.equal(stripFileTargetLocation('C:\\repo\\src\\a.ts:8'), 'C:\\repo\\src\\a.ts')
})

test('linkifies text and inline-friendly file names without touching web URLs', () => {
  assert.deepEqual(findFileTargetsInText('See src/a.ts:3 and https://example.com/src/b.ts:4.'), [
    { start: 4, end: 14, raw: 'src/a.ts:3' },
  ])
  assert.ok(parseFileTarget('README.md', { context: 'inline-code' }))
})

test('keeps shell commands as code instead of bogus file targets', () => {
  for (const command of [
    'python3 start.py',
    'python scripts/start.py',
    'git diff src/components/chat.tsx',
    'cat /tmp/output.log',
  ]) {
    assert.equal(parseFileTarget(command, { context: 'inline-code' }), null)
  }
  assert.ok(parseFileTarget('docs/My Guide.md', { context: 'inline-code' }))
  assert.ok(parseFileTarget('./My File.ts', { context: 'inline-code' }))
})

test('remark file targets skips fenced code and converts inline code', () => {
  const tree: any = {
    type: 'root',
    children: [
      { type: 'paragraph', children: [{ type: 'inlineCode', value: 'src/a.ts#L2-L4' }] },
      { type: 'code', value: 'src/inside-fence.ts:9' },
    ],
  }
  remarkFileTargets()(tree)
  assert.equal(tree.children[0].children[0].type, 'link')
  assert.match(tree.children[0].children[0].data.hProperties['data-file-target'], /%22endLine%22%3A4/)
  assert.equal(tree.children[1].type, 'code')
})

test('remark file targets leaves an inline shell command intact', () => {
  const tree: any = {
    type: 'root',
    children: [
      { type: 'paragraph', children: [{ type: 'inlineCode', value: 'python3 start.py' }] },
    ],
  }
  remarkFileTargets()(tree)
  assert.equal(tree.children[0].children[0].type, 'inlineCode')
  assert.equal(tree.children[0].children[0].value, 'python3 start.py')
})

test('keeps preview targets inside the selected project', () => {
  const inside = parseFileTarget('/Users/me/repo/src/a.ts#L8-L10')
  const outside = parseFileTarget('/Users/me/other/a.ts#L8')
  const traversal = parseFileTarget('../secrets.txt#L1')
  assert.ok(inside && outside && traversal)
  assert.deepEqual(resolveProjectRelativePath(inside, { bindPath: '/Users/me/repo' }), { ok: true, path: '/src/a.ts' })
  assert.equal(resolveProjectRelativePath(outside, { bindPath: '/Users/me/repo' }).ok, false)
  assert.equal(resolveProjectRelativePath(traversal, { bindPath: '/Users/me/repo' }).ok, false)
})

test('workspace tabs key off the project-relative path', () => {
  assert.equal(workspaceTabKey({ path: '/mobius/backend/routes/harnesses.ts' }), 'mobius/backend/routes/harnesses.ts')
  assert.equal(workspaceTabKey({ path: 'src\\a.ts' }), 'src/a.ts')
})

test('file breadcrumbs keep folder and file segments', () => {
  const crumbs = filePathSegments('mobius/backend/routes/aimux-bridge-proxy.ts')
  assert.equal(crumbs.at(-1)?.name, 'aimux-bridge-proxy.ts')
  assert.equal(crumbs.at(-1)?.isFile, true)
  assert.equal(crumbs[0]?.path, 'mobius')
})

test('highlights python keywords without leaking raw tags', () => {
  const lines = highlightFileLines('import os\n# note\nname = "mobius"\n', 'python')
  assert.match(lines[0], /hljs-keyword/)
  assert.match(lines[1], /hljs-comment/)
  assert.match(lines[2], /hljs-string/)
  assert.doesNotMatch(lines.join(''), /<script/)
})

test('highlights common languages and text formats from path', () => {
  assert.equal(codeLanguageFromPath('src/a.ts'), 'typescript')
  assert.equal(codeLanguageFromPath('app.go'), 'go')
  assert.equal(codeLanguageFromPath('Dockerfile'), 'dockerfile')
  assert.equal(codeLanguageFromPath('Makefile'), 'makefile')
  assert.equal(codeLanguageFromPath('.env'), 'ini')
  assert.equal(codeLanguageFromPath('schema.proto'), 'protobuf')
  assert.equal(highlightLanguageId('typescript'), 'typescript')
  assert.equal(highlightLanguageId('dockerfile'), 'dockerfile')
  assert.equal(highlightLanguageId('text'), '')
  assert.match(highlightFileLines('const x: string = "ok"', 'typescript').join(''), /hljs-keyword|hljs-string/)
  assert.match(highlightFileLines('{ "ok": true }', 'json').join(''), /hljs-number|hljs-literal|hljs-attr/)
  assert.match(highlightFileLines('FROM node:20\nCOPY . .', 'dockerfile').join(''), /hljs-keyword/)
  assert.match(highlightFileLines('name: mobius\ncount: 1', 'yaml').join(''), /hljs-attr|hljs-number|hljs-string/)
  assert.match(highlightFileLines('# title\n\nHello `code`', 'markdown').join(''), /hljs-section|hljs-code/)
  assert.equal(highlightFileLines('<script>alert(1)</script>', 'text')[0], '&lt;script&gt;alert(1)&lt;/script&gt;')
})

test('splits highlighted HTML across line-spanning spans', () => {
  const lines = splitHighlightedHtml('<span class="hljs-comment">one\ntwo</span>')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /hljs-comment/)
  assert.match(lines[1], /hljs-comment/)
  assert.match(lines[0], /<\/span>$/)
})

console.log('code file target tests passed')
