import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = relative => fs.readFileSync(path.resolve(here, '..', relative), 'utf8')

const chrome = read('src/components/advanced-page-chrome.tsx')
const project = read('src/pages/ProjectPage.tsx')
const issue = read('src/pages/IssuePage.tsx')
const research = read('src/pages/ResearchPage.tsx')
const admin = read('src/components/panels.tsx')
const adminOverlay = read('src/components/admin-overlay.tsx')
const home = read('src/pages/UserPage.tsx')
const issueCard = read('src/components/project-page/IssueCard.tsx')
const researchCard = read('src/components/project-page/ResearchCard.tsx')

assert.match(chrome, /advancedPageReturnNavigation[\s\S]*workbenchReturnLabel[\s\S]*data-advanced-page-back/, '共享 chrome 必须统一返回 helper、来源标签与按钮语法')
for (const [label, source] of [['Project', project], ['Issue', issue], ['Research', research], ['Admin', admin]]) {
  assert.match(source, /<AdvancedPageChrome/, `${label} 必须消费共享高级页 chrome`)
  assert.doesNotMatch(source, /history\.back\(|navigate\(-1\)/, `${label} 返回不得只依赖浏览器 history`)
}

assert.match(home, /projectPath\(p\.created_by, p\.id, \{ returnTo: homeReturnTo \}\)/, 'Home 进入 Project 必须携带来源')
assert.match(project, /workbenchLocationPath[\s\S]*returnTo=\{projectSourcePath\}/, 'Project 必须保留自身完整来源链并传给子对象')
assert.match(issueCard, /issuePath\(userParam, projectId, issue\.id, \{ returnTo \}\)/, 'Project 进入 Issue 必须携带 Project 来源')
assert.match(researchCard, /researchPath\(userParam, projectId, research\.id, \{ returnTo \}\)/, 'Project 进入 Research 必须携带 Project 来源')
assert.match(issue, /readWorkbenchReturnTo\(search, issueFallback\)/, 'Issue 深链必须有 Project fallback')
assert.match(research, /sessionParam \? sessionPath\(userParam, sessionParam\) : researchFallback/, 'Research 深链必须优先返回来源 Session，否则回 Project')
assert.match(adminOverlay, /safeWorkbenchReturnTo[\s\S]*window\.location\.pathname[\s\S]*returnTo=\{request\.returnTo\}/, 'Admin 必须记录并展示来源上下文')

console.log('advanced page navigation contract test passed')
