const SENSITIVE_NAME_RE = /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|credential|cookie|session)/i
const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'])
const SEMANTIC_OWNER_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  '[role]',
  '[data-design-id]',
  '[data-tour]',
  '[aria-label]',
  '[contenteditable="true"]',
].join(',')

const UTILITY_CLASS_RE = /^(?:lucide(?:-|$)|(?:[a-z]{0,4}:)?(?:flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|overflow|truncate|transition|duration|ease|cursor|select|pointer-events|z-|m[trblxy]?[-\[]|p[trblxy]?[-\[]|w[-\[]|h[-\[]|min-|max-|text-|font-|leading-|tracking-|bg-|border|rounded|shadow|opacity|gap-|space-|items-|justify-|content-|self-|place-|shrink-|grow|basis-|order-|top-|right-|bottom-|left-|inset-|translate|scale|rotate|hover:|focus:|dark:))/

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value)
  return String(value).replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`)
}

function normalizeText(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function safeAttributeValue(element, name) {
  if (!element.hasAttribute(name) || SENSITIVE_NAME_RE.test(name)) return ''
  const value = element.getAttribute(name) || ''
  if (SENSITIVE_NAME_RE.test(value)) return ''
  return normalizeText(value, 180)
}

function visibleText(element) {
  if (FORM_TAGS.has(element.tagName) || element.isContentEditable) return ''
  return normalizeText(element.innerText || element.textContent || '', 180)
}

function meaningfulClasses(element) {
  return Array.from(element.classList || [])
    .map(item => item.trim())
    .filter(item => item.length >= 4 && item.length <= 80)
    .filter(item => !item.includes('[') && !item.includes(':') && !UTILITY_CLASS_RE.test(item))
    .slice(0, 10)
}

function isUniqueSelector(selector) {
  try {
    return document.querySelectorAll(selector).length === 1
  } catch {
    return false
  }
}

function stableSelectorFor(element) {
  const designId = safeAttributeValue(element, 'data-design-id')
  if (designId) return `[data-design-id="${cssEscape(designId)}"]`

  const dataTour = safeAttributeValue(element, 'data-tour')
  if (dataTour) return `[data-tour="${cssEscape(dataTour)}"]`

  if (element.id) {
    const byId = `#${cssEscape(element.id)}`
    if (isUniqueSelector(byId)) return byId
  }

  const ariaLabel = safeAttributeValue(element, 'aria-label')
  if (ariaLabel) {
    const selector = `${element.tagName.toLowerCase()}[aria-label="${cssEscape(ariaLabel)}"]`
    if (isUniqueSelector(selector)) return selector
  }

  const title = safeAttributeValue(element, 'title')
  if (title) {
    const selector = `${element.tagName.toLowerCase()}[title="${cssEscape(title)}"]`
    if (isUniqueSelector(selector)) return selector
  }

  return ''
}

function selectorSegment(element) {
  const stable = stableSelectorFor(element)
  if (stable) return stable

  const tag = element.tagName.toLowerCase()
  const classes = meaningfulClasses(element).slice(0, 2)
  if (classes.length) {
    const withClasses = `${tag}.${classes.map(cssEscape).join('.')}`
    if (isUniqueSelector(withClasses)) return withClasses
  }

  const parent = element.parentElement
  if (!parent) return tag
  const siblings = Array.from(parent.children).filter(item => item.tagName === element.tagName)
  if (siblings.length <= 1) return tag
  return `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`
}

function buildSelector(element) {
  const stable = stableSelectorFor(element)
  if (stable) return stable

  const parts = []
  let current = element
  while (current && current !== document.body && parts.length < 6) {
    parts.unshift(selectorSegment(current))
    const candidate = parts.join(' > ')
    if (isUniqueSelector(candidate)) return candidate
    current = current.parentElement
  }
  return parts.join(' > ')
}

function describeElement(element) {
  const tag = element.tagName.toLowerCase()
  const stable = stableSelectorFor(element)
  if (stable) return stable
  const role = safeAttributeValue(element, 'role')
  const aria = safeAttributeValue(element, 'aria-label')
  const classes = meaningfulClasses(element).slice(0, 2)
  let out = tag
  if (role) out += `[role="${role}"]`
  if (aria) out += `[aria-label="${aria}"]`
  if (classes.length) out += `.${classes.join('.')}`
  return out
}

function buildAncestry(element) {
  const ancestry = []
  let current = element
  while (current && current !== document.documentElement && ancestry.length < 6) {
    ancestry.unshift(describeElement(current))
    current = current.parentElement
  }
  return ancestry
}

function sanitizedHtmlSummary(element) {
  const tag = element.tagName.toLowerCase()
  const allowed = [
    'id', 'class', 'role', 'type', 'name', 'title', 'placeholder', 'aria-label',
    'aria-describedby', 'aria-labelledby', 'data-tour', 'data-design-id', 'href',
  ]
  const attrs = []
  for (const name of allowed) {
    if (name === 'href' && element.tagName !== 'A') continue
    const value = safeAttributeValue(element, name)
    if (!value) continue
    const safe = name === 'href' ? value.replace(/[?#].*$/, '') : value
    attrs.push(`${name}="${safe.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`)
  }
  const text = visibleText(element)
  const opening = `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`
  if (['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag)) return opening
  return `${opening}${text ? text.replace(/</g, '&lt;') : '…'}</${tag}>`
}

function safeLocationPath() {
  try {
    const url = new URL(location.href)
    const queryNames = Array.from(new Set(url.searchParams.keys()))
    const query = queryNames.length
      ? `?${queryNames.map(name => `${encodeURIComponent(name)}=<value>`).join('&')}`
      : ''
    return `${url.pathname}${query}${url.hash ? '#<hash>' : ''}`
  } catch {
    return location.pathname || '/'
  }
}

function computedStyleSnapshot(element) {
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return {
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    display: style.display,
    position: style.position,
    color: style.color,
    backgroundColor: style.backgroundColor,
    borderColor: style.borderColor,
    borderRadius: style.borderRadius,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
    padding: style.padding,
    gap: style.gap,
  }
}

function signal(kind, value, weight) {
  const normalized = normalizeText(value, 160)
  return normalized ? { kind, value: normalized, weight } : null
}

function collectSignals(element, ancestryElements) {
  const signals = [
    signal('designId', safeAttributeValue(element, 'data-design-id'), 100),
    signal('dataTour', safeAttributeValue(element, 'data-tour'), 95),
    signal('id', element.id, 88),
    signal('ariaLabel', safeAttributeValue(element, 'aria-label'), 85),
    signal('title', safeAttributeValue(element, 'title'), 82),
    signal('placeholder', safeAttributeValue(element, 'placeholder'), 80),
    signal('name', safeAttributeValue(element, 'name'), 72),
    signal('text', visibleText(element), 70),
    ...meaningfulClasses(element).map(value => signal('className', value, 55)),
  ]
  for (const ancestor of ancestryElements.slice(-4, -1)) {
    signals.push(signal('ancestorDataTour', safeAttributeValue(ancestor, 'data-tour'), 48))
    signals.push(signal('ancestorAriaLabel', safeAttributeValue(ancestor, 'aria-label'), 42))
  }
  const unique = new Map()
  for (const item of signals.filter(Boolean)) {
    const key = `${item.kind}:${item.value}`
    if (!unique.has(key)) unique.set(key, item)
  }
  return Array.from(unique.values()).slice(0, 18)
}

function semanticOwnerOf(exact, forceExact = false) {
  if (forceExact) return exact
  let current = exact
  // 图标组件常有 path/circle → svg → span → wrapper → button 等多层结构。
  // 对所有命中节点统一向上寻找语义宿主，避免只列举部分 SVG 标签而漏掉 circle/polyline。
  for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
    if (current.matches?.(SEMANTIC_OWNER_SELECTOR)) return current
  }
  return exact
}

export function elementBelowPoint(x, y, designerHost) {
  const stack = document.elementsFromPoint(x, y)
  return stack.find(element => element !== designerHost && !designerHost.contains(element) && element !== document.documentElement && element !== document.body) || null
}

export function resolveSelection(exact, forceExact = false) {
  return {
    exact,
    semantic: semanticOwnerOf(exact, forceExact),
  }
}

export function createElementSnapshot(selection) {
  const element = selection.semantic
  const ancestryElements = []
  let current = element
  while (current && current !== document.documentElement && ancestryElements.length < 6) {
    ancestryElements.unshift(current)
    current = current.parentElement
  }

  const extensionName = typeof window.__EXT_NAME__ === 'string' ? window.__EXT_NAME__ : ''
  const attributes = {
    id: element.id || '',
    role: safeAttributeValue(element, 'role'),
    type: safeAttributeValue(element, 'type'),
    name: safeAttributeValue(element, 'name'),
    title: safeAttributeValue(element, 'title'),
    placeholder: safeAttributeValue(element, 'placeholder'),
    ariaLabel: safeAttributeValue(element, 'aria-label'),
    dataTour: safeAttributeValue(element, 'data-tour'),
    designId: safeAttributeValue(element, 'data-design-id'),
  }

  return {
    page: {
      title: normalizeText(document.title, 160),
      path: safeLocationPath(),
      scope: extensionName ? 'extension' : 'core',
      extensionName,
    },
    element: {
      tag: element.tagName.toLowerCase(),
      exactTag: selection.exact.tagName.toLowerCase(),
      text: visibleText(element),
      attributes,
      classes: meaningfulClasses(element),
      selector: buildSelector(element),
      ancestry: buildAncestry(element),
      html: sanitizedHtmlSummary(element),
      style: computedStyleSnapshot(element),
    },
    signals: collectSignals(element, ancestryElements),
    capturedAt: new Date().toISOString(),
  }
}

export function targetRect(element) {
  const rect = element.getBoundingClientRect()
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  }
}
