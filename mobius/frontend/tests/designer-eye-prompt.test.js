import assert from 'node:assert/strict'
import { buildAgentPrompt, replacePromptRequirement } from '../public/designer-eye/prompt.js'

function snapshot(selector, text, x) {
  return {
    page: {
      title: '测试页面',
      path: '/u/demo/p/project/i/issue',
      scope: 'core',
      extensionName: '',
    },
    element: {
      tag: 'button',
      exactTag: 'span',
      text,
      attributes: {
        designId: '',
        dataTour: selector.slice(1),
        role: '',
        ariaLabel: text,
        title: '',
        placeholder: '',
      },
      classes: [],
      selector,
      ancestry: ['main', selector],
      html: `<button data-tour="${selector.slice(1)}">${text}</button>`,
      style: {
        rect: { x, y: 20, width: 100, height: 36 },
        display: 'inline-flex',
        position: 'static',
        fontSize: '14px',
        fontWeight: '600',
        lineHeight: '20px',
        color: 'rgb(255, 255, 255)',
        backgroundColor: 'rgb(124, 58, 237)',
        borderColor: 'rgb(124, 58, 237)',
        borderRadius: '8px',
        padding: '8px 12px',
        gap: '4px',
      },
    },
    signals: [{ kind: 'dataTour', value: selector.slice(1), weight: 95 }],
  }
}

const first = snapshot('#first-action', '第一个操作', 10)
const second = snapshot('#second-action', '第二个操作', 130)
const prompt = buildAgentPrompt(
  [first, second],
  [
    { candidates: [{ file: 'mobius/frontend/src/First.tsx', line: 12, score: 95, matched: ['dataTour'], preview: 'first' }] },
    { candidates: [{ file: 'mobius/frontend/src/Second.tsx', line: 28, score: 91, matched: ['ariaLabel'], preview: 'second' }] },
  ],
  '调整两个操作的视觉层级',
)

assert.match(prompt, /^请修改以下 2 个界面元素/)
assert.match(prompt, /【元素1】[\s\S]*#first-action[\s\S]*First\.tsx:12/)
assert.match(prompt, /【元素2】[\s\S]*#second-action[\s\S]*Second\.tsx:28/)
assert(prompt.indexOf('【元素1】') < prompt.indexOf('【元素2】'), '元素编号必须与传入的选择顺序一致')

const updated = replacePromptRequirement(prompt, '新的 $& 修改要求')
assert.match(updated, /^请修改以下 2 个界面元素/)
assert(updated.includes('“新的 $& 修改要求”'), '修改要求中的替换符号必须按普通文本保留')
assert(updated.includes('【元素1】') && updated.includes('【元素2】'), '更新要求不能破坏多元素内容')

console.log('designer-eye prompt tests passed')
