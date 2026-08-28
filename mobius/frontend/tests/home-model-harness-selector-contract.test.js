import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSource = relativePath => fs.readFileSync(path.join(here, '..', relativePath), 'utf8')
const homeSource = readSource('src/pages/UserPage.tsx')
const selectorSource = readSource('src/components/home-model-harness-select.tsx')
const createSource = readSource('src/services/create-conversation.ts')

assert.match(homeSource, /<HomeModelHarnessSelect[\s\S]*projectId=\{selectedProjectId\}[\s\S]*value=\{selectedModel\}/, '首页必须渲染模型与 Harness 组合选择器')
assert.match(homeSource, /createDefaultConversation\(\{[\s\S]*model: selectedModel/, '首页创建会话时必须透传用户选择的组合')
assert.match(homeSource, /disabled=\{!prompt\.trim\(\) \|\| !selectedModel \|\| sending\}/, '组合未就绪时首页发送按钮必须禁用')
assert.match(selectorSource, /api\('\/api\/sessions\/model-options'\)/, '组合选项必须来自统一模型目录接口')
assert.match(selectorSource, /tmux-codex[\s\S]*Codex[\s\S]*tmux-claude-code[\s\S]*Claude Code[\s\S]*deepseek-harness[\s\S]*DeepSeek Harness/, '选择器必须明确展示对应 Harness')
assert.match(selectorSource, /resolveDefaultModelKey\(\{ projectDefaultModel, globalDefaultModel \}\)/, '选择器必须遵循项目默认与系统默认')
assert.match(createSource, /const requestedModel = String\(args\.model \|\| ''\)\.trim\(\)[\s\S]*const model = requestedModel \|\|/, '创建服务必须优先采用首页显式选择')

console.log('home model and harness selector contract test passed')
