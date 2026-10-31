import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = fs.readFileSync(new URL('../src/components/search-modal.tsx', import.meta.url), 'utf8')
const handler = source.slice(source.indexOf('  const openSession ='), source.indexOf('  const openFragmentPreview ='))
const compiled = ts.transpileModule(`${handler}\nopenSession(result, fragment)`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText
const fragment = { uuid: 'message-1', timestamp: '2026-10-31T12:00:00Z', snippet: 'search result' }
const result = {
  session_id: 'session-1', project_id: 'project-1', issue_id: 'issue-1',
  scope_type: 'issue', fragments: [fragment],
}

for (const isDesktop of [false, true]) {
  const calls = []
  vm.runInNewContext(compiled, {
    result, fragment, layoutMode: 'default', user: { id: 'user-1' },
    localStorage: { setItem: (...args) => calls.push(['store', ...args]) },
    window: {
      ...(isDesktop ? { mobiusDesktop: { isDesktop: true } } : {}),
      open: (...args) => calls.push(['open', ...args]),
    },
    onNavigate: (...args) => calls.push(['navigate', ...args]),
    close: () => calls.push(['close']),
  })
  const target = '/u/user-1/p/project-1/i/issue-1?session=session-1&match=message-1&ts=2026-10-31T12%3A00%3A00Z'
  assert.deepEqual(calls[0], ['store', 'mobius:search-hits:session-1', JSON.stringify(result.fragments)])
  assert.deepEqual(calls.slice(1), isDesktop
    ? [['navigate', target], ['close']]
    : [['open', target, '_blank', 'noopener,noreferrer']])
}

console.log('Search session navigation keeps web search open and closes desktop search')
