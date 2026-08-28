import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const chatSource = fs.readFileSync(path.join(testDir, '../src/components/chat.tsx'), 'utf8')
const effectStart = chatSource.indexOf("if (!toolDrawerOpen || (activeToolTab !== 'files' && activeToolTab !== 'diff')) return")
const effectEnd = chatSource.indexOf('\n\n  const selectedToolFile', effectStart)

assert.ok(effectStart >= 0 && effectEnd > effectStart, 'must find the Session file auto-scan effect')
const autoScanEffect = chatSource.slice(effectStart, effectEnd)

assert.match(
  autoScanEffect,
  /if \(toolFilesReady \|\| toolFilesLoading\) return[\s\S]*?void loadToolFiles\(\)/,
  'an empty completed result must not trigger another automatic scan',
)
assert.match(autoScanEffect, /\[[^\]]*toolFilesLoading[^\]]*toolFilesReady[^\]]*\]/, 'the effect must react to readiness changes')
assert.doesNotMatch(autoScanEffect, /toolFiles\.length \|\| toolFilesLoading/, 'file count cannot represent whether the first scan completed')

console.log('session-file-scan ok')
