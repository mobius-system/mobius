import assert from 'node:assert/strict'
import { resolveSelection } from '../public/designer-eye/dom.js'

function element(tagName, parentElement = null, semantic = false) {
  return {
    tagName,
    parentElement,
    matches: () => semantic,
  }
}

const semanticHost = element('BUTTON', null, true)
const directParent = element('SPAN', semanticHost)
const exact = element('SVG', directParent)

assert.equal(resolveSelection(exact).semantic, exact, '默认应选择鼠标下的精确元素')
assert.equal(resolveSelection(exact, true).semantic, semanticHost, 'Alt/Option 应选择最近的交互宿主')
assert.equal(resolveSelection(exact, false, true).semantic, directParent, 'Shift 应选择直接父元素')
assert.equal(resolveSelection(exact, true, true).semantic, directParent, 'Shift 应比 Alt/Option 优先')

const detached = element('DIV')
assert.equal(resolveSelection(detached, false, true).semantic, detached, '无父元素时应保留当前元素')

console.log('designer-eye DOM selection tests passed')
