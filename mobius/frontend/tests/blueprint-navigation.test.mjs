import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const result = await build({
  entryPoints: [fileURLToPath(new URL('../src/components/project-page/blueprint-navigation.ts', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', write: false,
})
const { blueprintRelativePath, blueprintStorageKey } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

for (const path of ['.imac/blueprints/module/design.html', './.imac/blueprints/module/design.html', '/workspace/app/.imac/blueprints/module/design.html']) {
  assert.equal(blueprintRelativePath(path, '/workspace/app/', '.imac'), '.imac/blueprints/module/design.html')
}
assert.equal(blueprintRelativePath('.custom/blueprints/design.HTM', '/workspace/app', '.custom'), '.custom/blueprints/design.HTM')
for (const path of ['docs/design.html', '.imac/blueprints/design.md', '.imac/blueprints/../secret.html', '.imac/blueprints//design.html', '/workspace/application/.imac/blueprints/design.html', '/elsewhere/.imac/blueprints/design.html', '.imac/blueprints.html']) {
  assert.equal(blueprintRelativePath(path, '/workspace/app', '.imac'), null, path)
}
assert.notEqual(blueprintStorageKey('project-a'), blueprintStorageKey('project-b'))
assert.equal(blueprintStorageKey('project-a'), 'mobius:ui:last-blueprint:project-a')

const source = async path => fs.readFile(new URL(`../src/components/${path}`, import.meta.url), 'utf8')
const chat = await source('chat.tsx')
assert.doesNotMatch(chat.slice(chat.indexOf('function ChatHeaderOverflowMenu'), chat.indexOf('function ChatHeaderOverflowMenu') + 5000), /查看项目蓝图/)
assert.match(chat, /if \(!detail\.remote && blueprintRelativePath[\s\S]*?setProjectBlueprintOpen\(true\)[\s\S]*?return\s*\}/)
assert.match(chat, /openFileRequest=\{blueprintFileRequest\}/)
const actions = await source('advanced-session-actions.tsx')
assert.match(actions, /buttonId="project-blueprint"[\s\S]*?onClick=\{onOpenBlueprint\}[\s\S]*?label="查看项目蓝图"/)
assert.doesNotMatch(actions, /查看文件修改/)
const pane = await source('workspace/code-conversation-pane.tsx')
assert.match(pane, /!rootLoaded \|\| openFileRequest \|\| openRequest/)
assert.match(pane, /localStorage\.getItem\(blueprintStorageKey\(projectId\)\)/)
assert.match(pane, /if \(!tab \|\| tab.loading \|\| tab.error\) return/)
assert.match(pane, /localStorage\.setItem\(blueprintStorageKey\(projectId\), path\)/)
assert.match(pane, /localStorage\.removeItem\(blueprintStorageKey\(projectId\)\)/)
console.log('Blueprint navigation: path routing, project isolation, explicit target priority, persistence and stale-memory fallback passed')
