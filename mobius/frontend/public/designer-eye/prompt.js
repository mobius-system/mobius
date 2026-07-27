function routeHints(page) {
  if (page.scope === 'extension') {
    return [`mobius/extension/${page.extensionName}/frontend/`]
  }
  const path = page.path || ''
  const hints = ['mobius/frontend/src/']
  if (/\/welcome(?:\?|$)/.test(path)) hints.push('mobius/frontend/src/pages/Welcome.tsx')
  else if (/\/mobius_overview_cluster(?:\?|$)/.test(path)) hints.push('mobius/frontend/src/pages/MobiusOverviewClusterPage.tsx')
  else if (/\/mobius_overview(?:\?|$)/.test(path)) hints.push('mobius/frontend/src/pages/MobiusOverviewPage.tsx')
  else if (/\/p\/[^/]+\/i\//.test(path)) hints.push('mobius/frontend/src/pages/IssuePage.tsx', 'mobius/frontend/src/components/chat.tsx')
  else if (/\/p\/[^/]+\/r\//.test(path)) hints.push('mobius/frontend/src/pages/ResearchPage.tsx')
  else if (/\/p\/[^/?]+/.test(path)) hints.push('mobius/frontend/src/pages/ProjectPage.tsx')
  else if (/\/u\/[^/?]+/.test(path)) hints.push('mobius/frontend/src/pages/UserPage.tsx')
  return hints
}

function searchCommands(snapshot) {
  const root = snapshot.page.scope === 'extension'
    ? `mobius/extension/${snapshot.page.extensionName}/frontend`
    : 'mobius/frontend/src'
  const preferred = snapshot.signals
    .filter(item => ['designId', 'dataTour', 'ariaLabel', 'title', 'placeholder', 'text', 'className'].includes(item.kind))
    .slice(0, 4)
  return preferred.map(item => {
    const value = item.value.replace(/'/g, `'"'"'`)
    return `rg -n --fixed-strings '${value}' ${root}`
  })
}

function candidateLines(locationResult) {
  if (locationResult?.candidates?.length) {
    return locationResult.candidates.map((candidate, index) => {
      const matched = Array.isArray(candidate.matched) ? candidate.matched.join('、') : ''
      return `${index + 1}. ${candidate.file}:${candidate.line}\n   置信分：${candidate.score}${matched ? `；匹配：${matched}` : ''}\n   摘要：${candidate.preview || ''}`
    }).join('\n')
  }
  return locationResult?.unavailable || '尚未得到后端候选；请使用下方检索命令定位。'
}

function requirementText(requirement) {
  return String(requirement || '').trim() || '请用户在这里输入改进要求'
}

export function replacePromptRequirement(prompt, requirement) {
  const source = String(prompt || '')
  const updated = source.replace(
    /^(请修改以下 .*修改要求如下：\n)“[^”]*”/,
    (_match, prefix) => `${prefix}“${requirementText(requirement)}”`,
  )
  if (updated !== source) return updated
  const marker = '\n\n先在源代码中定位'
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) return prompt
  return `请修改以下界面元素，修改要求如下：\n“${requirementText(requirement)}”${source.slice(markerIndex)}`
}

function elementPrompt(snapshot, locationResult, index) {
  const attrs = snapshot.element.attributes
  const style = snapshot.element.style
  const hints = routeHints(snapshot.page)
  const commands = searchCommands(snapshot)
  const ancestry = snapshot.element.ancestry.map((item, index) => `${'  '.repeat(index)}${index ? '> ' : ''}${item}`).join('\n')

  return `【元素${index + 1}】
- 语义元素：${snapshot.element.tag}
- 精确命中节点：${snapshot.element.exactTag}
- 稳定选择器：${snapshot.element.selector || '（未生成）'}
- data-design-id：${attrs.designId || '（无）'}
- data-tour：${attrs.dataTour || '（无）'}
- role：${attrs.role || '（无）'}
- aria-label：${attrs.ariaLabel || '（无）'}
- title：${attrs.title || '（无）'}
- placeholder：${attrs.placeholder || '（无）'}
- 可见文字：${snapshot.element.text || '（无或已按隐私规则省略）'}
- 语义类名：${snapshot.element.classes.join(' ') || '（无）'}

【DOM 祖先路径】
${ancestry || '（无）'}

【源码定位候选】
${candidateLines(locationResult)}

【建议检索】
${commands.length ? commands.join('\n') : `rg -n --fixed-strings '${snapshot.element.tag}' ${hints[0]}`}

【脱敏 DOM 摘要】
${snapshot.element.html}

【视觉信息】
- 位置与尺寸：x=${style.rect.x}, y=${style.rect.y}, width=${style.rect.width}, height=${style.rect.height}
- display / position：${style.display} / ${style.position}
- 字体：${style.fontSize} / ${style.fontWeight} / line-height ${style.lineHeight}
- 颜色：text ${style.color}；background ${style.backgroundColor}；border ${style.borderColor}
- 圆角与间距：border-radius ${style.borderRadius}；padding ${style.padding}；gap ${style.gap}
`
}

export function buildAgentPrompt(snapshotOrSnapshots, locationResultOrResults = null, requirement = '') {
  const snapshots = Array.isArray(snapshotOrSnapshots) ? snapshotOrSnapshots.filter(Boolean) : [snapshotOrSnapshots].filter(Boolean)
  if (!snapshots.length) return ''
  const locationResults = Array.isArray(locationResultOrResults) ? locationResultOrResults : [locationResultOrResults]
  const page = snapshots[0].page
  const hints = routeHints(page)
  const elements = snapshots.map((snapshot, index) => elementPrompt(snapshot, locationResults[index] || null, index)).join('\n')

  return `请修改以下 ${snapshots.length} 个界面元素，修改要求如下：
“${requirementText(requirement)}”

先在源代码中分别定位元素1、元素2等目标，不要仅根据截图或视觉位置猜测。定位后先确认每个元素对应的文件、组件或渲染函数，再实施用户提出的具体改动。不要修改 node_modules、dist、release 或构建产物。

【页面上下文】
- 页面标题：${page.title || '（无）'}
- URL 路径：${page.path}
- 页面类型：${page.scope === 'extension' ? `Mobius 拓展（${page.extensionName}）` : 'Mobius 主前端'}
- 推荐代码范围：${hints.join('；')}

${elements}

请按元素1、元素2……的顺序逐一定位和修改。优先使用 data-design-id、data-tour、ARIA、可见文字和祖先上下文确认源码。如果候选有多个，请结合当前路由逐一排除，并说明每个元素的最终确认依据。`
}
