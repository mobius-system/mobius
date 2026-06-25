export type TextRedactionRule = {
  id: string
  keyword: string
  replacement: string
  enabled: boolean
}

export type TextRedactionImportSummary = {
  rules: TextRedactionRule[]
  skipped: number
}

export const TEXT_REDACTION_STORAGE_KEY = 'mobius:temporary-text-redaction-rules'
export const TEXT_REDACTION_RULES_EVENT = 'mobius:text-redaction-rules-changed'
export const TEXT_REDACTION_ENABLED_STORAGE_KEY = 'mobius:text-redaction-enabled'
export const TEXT_REDACTION_ENABLED_EVENT = 'mobius:text-redaction-enabled-changed'
export const TEXT_REDACTION_IGNORE_SELECTOR = '[data-text-redaction-ignore="true"]'
export const TEXT_REDACTION_GLOBAL_CACHE_KEY = 'mobius:text-redaction-global-cache'
export const TEXT_REDACTION_GLOBAL_SYNC_EVENT = 'mobius:text-redaction-global-synced'
export const TEXT_REDACTION_GLOBAL_API_PATH = '/api/admin/text-redaction/global'
export const TEXT_REDACTION_MASK_CLASS = 'mobius-text-redaction-mask'

type TextNodeState = {
  original: string
  redacted: string
}

type AttributeState = {
  original: string
  redacted: string
}

const REDACTED_ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRule(value: unknown, index: number): TextRedactionRule | null {
  if (!isPlainObject(value)) return null

  const keyword = typeof value.keyword === 'string' ? value.keyword.trim() : ''
  if (!keyword) return null

  const replacement = typeof value.replacement === 'string' ? value.replacement : ''
  const id = typeof value.id === 'string' && value.id.trim()
    ? value.id.trim()
    : `rule-${index}`

  return {
    id,
    keyword,
    replacement,
    enabled: value.enabled !== false,
  }
}

function activeRules(rules: TextRedactionRule[]) {
  return rules
    .filter((rule) => rule.enabled && rule.keyword)
    .sort((a, b) => b.keyword.length - a.keyword.length)
}

function parseEnabled(value: unknown) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value !== 'string') return true

  const normalized = value.trim().toLowerCase()
  if (!normalized) return true
  if (['false', '0', 'no', 'off', 'disabled', '停用', '禁用', '否'].includes(normalized)) return false
  return true
}

function parseCsvRows(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      quoted = true
      continue
    }

    if (char === ',') {
      row.push(field)
      field = ''
      continue
    }

    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }

    field += char
  }

  row.push(field)
  rows.push(row)
  return rows
}

function looksLikeHeader(columns: string[]) {
  const normalized = columns.map((column) => column.trim().toLowerCase())
  const first = normalized[0] || ''
  const second = normalized[1] || ''
  return ['keyword', '关键词', '原文', '敏感词'].includes(first)
    && ['replacement', '替换词', '替换为', '隐藏为'].includes(second)
}

function ruleFromColumns(columns: unknown[], index: number): TextRedactionRule | null {
  const keyword = typeof columns[0] === 'string' ? columns[0].trim() : ''
  if (!keyword) return null

  return {
    id: createTextRedactionRuleId(),
    keyword,
    replacement: typeof columns[1] === 'string' ? columns[1] : '',
    enabled: parseEnabled(columns[2]),
  }
}

function ruleFromTextLine(line: string, index: number): TextRedactionRule | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  if (trimmed.includes('\t')) {
    return ruleFromColumns(trimmed.split('\t'), index)
  }

  const arrowMatch = trimmed.match(/^(.+?)\s*(?:=>|->|=)\s*([\s\S]*)$/)
  if (arrowMatch) {
    return ruleFromColumns([arrowMatch[1], arrowMatch[2]], index)
  }

  if (trimmed.includes(',')) {
    return ruleFromColumns(parseCsvRows(trimmed)[0] || [], index)
  }

  return ruleFromColumns([trimmed, ''], index)
}

function normalizeImportedRules(items: unknown[]) {
  const rules: TextRedactionRule[] = []
  let skipped = 0
  const byKeyword = new Map<string, TextRedactionRule>()

  items.forEach((item, index) => {
    let rule: TextRedactionRule | null = null

    if (isPlainObject(item)) {
      rule = normalizeRule({
        id: createTextRedactionRuleId(),
        keyword: typeof item.keyword === 'string' ? item.keyword : item['关键词'],
        replacement: typeof item.replacement === 'string' ? item.replacement : item['替换词'],
        enabled: parseEnabled(item.enabled ?? item['启用']),
      }, index)
    } else if (Array.isArray(item)) {
      rule = ruleFromColumns(item, index)
    } else if (typeof item === 'string') {
      rule = ruleFromTextLine(item, index)
    }

    if (!rule) {
      skipped += 1
      return
    }

    byKeyword.set(rule.keyword.trim(), rule)
  })

  rules.push(...byKeyword.values())
  return { rules, skipped }
}

export function parseTextRedactionImport(text: string): TextRedactionImportSummary {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!raw) return { rules: [], skipped: 0 }

  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return normalizeImportedRules(parsed)
    if (isPlainObject(parsed) && Array.isArray(parsed.rules)) return normalizeImportedRules(parsed.rules)
  } catch (_) {
    /* Fall back to line, CSV, or tab separated text. */
  }

  const rows = parseCsvRows(raw)
    .filter((row) => row.some((field) => field.trim()))

  if (rows.length > 0 && rows.every((row) => row.length > 1)) {
    const dataRows = looksLikeHeader(rows[0]) ? rows.slice(1) : rows
    return normalizeImportedRules(dataRows)
  }

  return normalizeImportedRules(raw.split('\n'))
}

export function mergeTextRedactionRules(
  currentRules: TextRedactionRule[],
  importedRules: TextRedactionRule[],
) {
  const next = [...currentRules]
  const indexByKeyword = new Map<string, number>()
  let added = 0
  let updated = 0

  next.forEach((rule, index) => {
    const keyword = rule.keyword.trim()
    if (keyword) indexByKeyword.set(keyword, index)
  })

  importedRules.forEach((rule) => {
    const keyword = rule.keyword.trim()
    if (!keyword) return

    const existingIndex = indexByKeyword.get(keyword)
    if (existingIndex == null) {
      indexByKeyword.set(keyword, next.length)
      next.push({ ...rule, keyword, id: createTextRedactionRuleId() })
      added += 1
      return
    }

    next[existingIndex] = {
      ...next[existingIndex],
      keyword,
      replacement: rule.replacement,
      enabled: rule.enabled,
    }
    updated += 1
  })

  return { rules: next, added, updated }
}

function csvCell(value: unknown) {
  const text = String(value ?? '')
  return `"${text.replace(/"/g, '""')}"`
}

export function exportTextRedactionRulesJson(rules: TextRedactionRule[]) {
  const payload = rules.map((rule) => ({
    keyword: rule.keyword,
    replacement: rule.replacement,
    enabled: rule.enabled,
  }))

  return `${JSON.stringify({ rules: payload }, null, 2)}\n`
}

export function exportTextRedactionRulesCsv(rules: TextRedactionRule[]) {
  const lines = [
    ['keyword', 'replacement', 'enabled'].map(csvCell).join(','),
    ...rules.map((rule) => [
      rule.keyword,
      rule.replacement,
      rule.enabled ? 'true' : 'false',
    ].map(csvCell).join(',')),
  ]

  return `${lines.join('\n')}\n`
}

function redactValue(value: string, rules: TextRedactionRule[]) {
  if (!value || rules.length === 0) return value

  let next = value
  for (const rule of rules) {
    if (!rule.keyword) continue
    next = next.split(rule.keyword).join(rule.replacement)
  }
  return next
}

function canUseLocalStorage() {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  } catch (_) {
    return false
  }
}

export function createTextRedactionRuleId() {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function readTextRedactionRules(): TextRedactionRule[] {
  if (!canUseLocalStorage()) return []

  try {
    const raw = window.localStorage.getItem(TEXT_REDACTION_STORAGE_KEY)
    if (!raw) return []

    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed
      .map((item, index) => normalizeRule(item, index))
      .filter((item): item is TextRedactionRule => !!item)
  } catch (_) {
    return []
  }
}

export function writeTextRedactionRules(rules: TextRedactionRule[]) {
  const normalized = rules
    .map((item, index) => normalizeRule(item, index))
    .filter((item): item is TextRedactionRule => !!item)

  if (canUseLocalStorage()) {
    try {
      window.localStorage.setItem(TEXT_REDACTION_STORAGE_KEY, JSON.stringify(normalized))
      window.dispatchEvent(new Event(TEXT_REDACTION_RULES_EVENT))
    } catch (_) {
      /* localStorage can be blocked in restricted browser modes. */
    }
  }

  return normalized
}

export function readTextRedactionEnabled(): boolean {
  if (!canUseLocalStorage()) return true

  try {
    const raw = window.localStorage.getItem(TEXT_REDACTION_ENABLED_STORAGE_KEY)
    if (raw == null) return true
    return String(raw).trim().toLowerCase() !== 'false'
  } catch (_) {
    return true
  }
}

export function writeTextRedactionEnabled(enabled: boolean) {
  if (!canUseLocalStorage()) return enabled

  try {
    window.localStorage.setItem(TEXT_REDACTION_ENABLED_STORAGE_KEY, enabled ? 'true' : 'false')
    window.dispatchEvent(new Event(TEXT_REDACTION_ENABLED_EVENT))
  } catch (_) {
    /* localStorage can be blocked in restricted browser modes. */
  }

  return enabled
}

// ── 全员规则同步 (管理员推送到后端, 当前用户 runtime 启动时拉一次覆盖本地) ──

export type TextRedactionGlobalPayload = {
  rules: TextRedactionRule[]
  updatedAt: string | null
  updatedBy: string | null
}

async function fetchTextRedactionGlobalFromBackend(): Promise<TextRedactionGlobalPayload | null> {
  try {
    const token = window.localStorage.getItem('cc-token')
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(TEXT_REDACTION_GLOBAL_API_PATH, { headers })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    if (!data || typeof data !== 'object') return null
    const rawRules = Array.isArray(data.rules) ? data.rules : []
    const rules = rawRules
      .map((item: unknown, index: number) => normalizeRule(item, index))
      .filter((item): item is TextRedactionRule => !!item)
    return {
      rules,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
      updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : null,
    }
  } catch (_) {
    return null
  }
}

function readTextRedactionGlobalCache(): { updatedAt: string | null } | null {
  if (!canUseLocalStorage()) return null
  try {
    const raw = window.localStorage.getItem(TEXT_REDACTION_GLOBAL_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return { updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null }
  } catch (_) {
    return null
  }
}

function writeTextRedactionGlobalCache(updatedAt: string | null) {
  if (!canUseLocalStorage()) return
  try {
    window.localStorage.setItem(
      TEXT_REDACTION_GLOBAL_CACHE_KEY,
      JSON.stringify({ updatedAt }),
    )
  } catch (_) {
    /* ignore */
  }
}

/**
 * 启动时调用一次. 拉取后端全员规则:
 *   - 如果后端没有规则 (rules 为空) → 啥也不做, 保留用户本地规则.
 *   - 如果后端有规则, 且 updatedAt 与本地缓存不同 → 用后端规则覆盖本地 STORAGE_KEY,
 *     并更新缓存. 同时确保 enabled=true.
 * 返回拉取到的 payload, 调用方可用于 UI 展示 updatedAt.
 */
export async function syncTextRedactionGlobalOnStartup(): Promise<TextRedactionGlobalPayload | null> {
  const payload = await fetchTextRedactionGlobalFromBackend()
  if (!payload) return null
  if (payload.rules.length === 0) return payload

  const cache = readTextRedactionGlobalCache()
  if (cache && cache.updatedAt && cache.updatedAt === payload.updatedAt) {
    return payload
  }

  writeTextRedactionRules(payload.rules)
  writeTextRedactionEnabled(true)
  writeTextRedactionGlobalCache(payload.updatedAt)
  try { window.dispatchEvent(new Event(TEXT_REDACTION_GLOBAL_SYNC_EVENT)) } catch (_) { /* ignore */ }
  return payload
}

/**
 * 管理员: 把当前本地规则推送到后端, 全员下次启动时同步.
 */
export async function pushTextRedactionRulesToBackend(rules: TextRedactionRule[]): Promise<TextRedactionGlobalPayload> {
  const token = window.localStorage.getItem('cc-token')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(TEXT_REDACTION_GLOBAL_API_PATH, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ rules }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error || `HTTP ${res.status}`)
  }
  const rawRules = Array.isArray((data as { rules?: unknown[] })?.rules) ? (data as { rules: unknown[] }).rules : []
  const normalized = rawRules
    .map((item: unknown, index: number) => normalizeRule(item, index))
    .filter((item): item is TextRedactionRule => !!item)
  const payload: TextRedactionGlobalPayload = {
    rules: normalized,
    updatedAt: typeof (data as { updatedAt?: unknown }).updatedAt === 'string'
      ? (data as { updatedAt: string }).updatedAt : null,
    updatedBy: typeof (data as { updatedBy?: unknown }).updatedBy === 'string'
      ? (data as { updatedBy: string }).updatedBy : null,
  }
  writeTextRedactionGlobalCache(payload.updatedAt)
  try { window.dispatchEvent(new Event(TEXT_REDACTION_GLOBAL_SYNC_EVENT)) } catch (_) { /* ignore */ }
  return payload
}

function elementIgnoresRedaction(element: Element) {
  if (element.closest(TEXT_REDACTION_IGNORE_SELECTOR)) return true

  const tagName = element.tagName.toUpperCase()
  if (tagName === 'SCRIPT' || tagName === 'STYLE' || tagName === 'NOSCRIPT') return true
  if ((element as HTMLElement).isContentEditable) return true

  return false
}

function textNodeIgnoresRedaction(node: Text) {
  const parent = node.parentElement
  if (!parent) return true

  const tagName = parent.tagName.toUpperCase()
  if (tagName === 'TEXTAREA' || tagName === 'INPUT') return true

  return elementIgnoresRedaction(parent)
}

export function startTextRedactionRuntime() {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.body) {
    return () => {}
  }

  const textStates = new WeakMap<Text, TextNodeState>()
  const attributeStates = new WeakMap<Element, Map<string, AttributeState>>()
  const trackedTexts = new Set<Text>()
  const trackedElements = new Set<Element>()
  let enabled = readTextRedactionEnabled()
  let rules = enabled ? activeRules(readTextRedactionRules()) : []

  const applyTextNode = (node: Text) => {
    if (textNodeIgnoresRedaction(node)) return

    const current = node.nodeValue || ''
    const previous = textStates.get(node)
    const original = previous && current === previous.redacted ? previous.original : current
    const redacted = redactValue(original, rules)

    textStates.set(node, { original, redacted })
    trackedTexts.add(node)
    if (current !== redacted) node.nodeValue = redacted
  }

  const applyElementAttributes = (element: Element) => {
    if (elementIgnoresRedaction(element)) return

    let state = attributeStates.get(element)
    if (!state) {
      state = new Map()
      attributeStates.set(element, state)
      trackedElements.add(element)
    }

    for (const attr of REDACTED_ATTRIBUTES) {
      const value = element.getAttribute(attr)
      if (value == null) {
        state.delete(attr)
        continue
      }

      const previous = state.get(attr)
      const original = previous && value === previous.redacted ? previous.original : value
      const redacted = redactValue(original, rules)

      state.set(attr, { original, redacted })
      if (value !== redacted) element.setAttribute(attr, redacted)
    }
  }

  const applySubtree = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      applyTextNode(node as Text)
      return
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return

    const element = node as Element
    if (elementIgnoresRedaction(element)) return

    applyElementAttributes(element)
    for (let child = element.firstChild; child; child = child.nextSibling) {
      applySubtree(child)
    }
  }

  const applyAll = () => {
    enabled = readTextRedactionEnabled()
    rules = enabled ? activeRules(readTextRedactionRules()) : []
    applySubtree(document.body)
    applyMaskScan(document.body)
  }

  // ── 文本框 mask: textarea / 文本 input 的 value 命中关键词时, 整框视觉模糊. ──
  // 不改 value (避免污染表单提交), 只用 CSS filter: blur().
  const MASKABLE_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'number', ''])
  const maskedElements = new Set<HTMLElement>()

  function ensureMaskStyleElement() {
    const STYLE_ID = 'mobius-text-redaction-mask-style'
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = `
.${TEXT_REDACTION_MASK_CLASS} {
  filter: blur(5px);
  transition: filter .12s ease-in-out;
}
.${TEXT_REDACTION_MASK_CLASS}:focus {
  filter: blur(3px);
}
.${TEXT_REDACTION_MASK_CLASS}::placeholder {
  filter: none;
}
`.trim()
    document.head.appendChild(style)
  }

  function isMaskableElement(element: Element): element is HTMLElement {
    if (!(element instanceof HTMLElement)) return false
    if (element.closest(TEXT_REDACTION_IGNORE_SELECTOR)) return false
    const tag = element.tagName.toUpperCase()
    if (tag === 'TEXTAREA') return true
    if (tag === 'INPUT') {
      const type = (element.getAttribute('type') || '').toLowerCase()
      return MASKABLE_INPUT_TYPES.has(type)
    }
    return false
  }

  function elementNeedsMask(element: HTMLElement) {
    if (!enabled || rules.length === 0) return false
    const value = element.value || ''
    if (!value) return false
    for (const rule of rules) {
      if (!rule.keyword) continue
      if (value.includes(rule.keyword)) return true
    }
    return false
  }

  const applyMaskToElement = (element: HTMLElement) => {
    if (!isMaskableElement(element)) return
    if (elementNeedsMask(element)) {
      if (!element.classList.contains(TEXT_REDACTION_MASK_CLASS)) {
        element.classList.add(TEXT_REDACTION_MASK_CLASS)
      }
      maskedElements.add(element)
    } else if (element.classList.contains(TEXT_REDACTION_MASK_CLASS)) {
      element.classList.remove(TEXT_REDACTION_MASK_CLASS)
    }
  }

  const applyMaskScan = (root: Node) => {
    if (root.nodeType !== Node.ELEMENT_NODE && root !== document.body) return
    const scope = root === document.body ? document.body : (root as Element)
    if (!(scope instanceof Element)) return
    const candidates = scope.querySelectorAll<HTMLElement>(
      'textarea, input[type="text"], input[type="search"], input[type="url"], input[type="email"], input[type="tel"], input[type="number"], input:not([type])',
    )
    candidates.forEach(applyMaskToElement)
    if (isMaskableElement(scope)) applyMaskToElement(scope)
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        applyTextNode(mutation.target as Text)
        continue
      }

      if (mutation.type === 'attributes') {
        applyElementAttributes(mutation.target as Element)
        continue
      }

      for (const node of mutation.addedNodes) {
        applySubtree(node)
      }
    }
  })

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: REDACTED_ATTRIBUTES,
  })

  const handleStorage = (event: StorageEvent) => {
    if (event.key === TEXT_REDACTION_STORAGE_KEY || event.key === TEXT_REDACTION_ENABLED_STORAGE_KEY) {
      applyAll()
    }
  }

  const handleInput = (event: Event) => {
    const target = event.target
    if (target instanceof HTMLElement) applyMaskToElement(target)
  }

  ensureMaskStyleElement()
  window.addEventListener(TEXT_REDACTION_RULES_EVENT, applyAll)
  window.addEventListener(TEXT_REDACTION_ENABLED_EVENT, applyAll)
  window.addEventListener(TEXT_REDACTION_GLOBAL_SYNC_EVENT, applyAll)
  window.addEventListener('storage', handleStorage)
  document.body.addEventListener('input', handleInput, true)
  applyAll()
  // 拉一次后端全员规则. 启动时调用, 不轮询. 失败/无规则都不影响本地.
  void syncTextRedactionGlobalOnStartup().catch(() => {})

  return () => {
    observer.disconnect()
    window.removeEventListener(TEXT_REDACTION_RULES_EVENT, applyAll)
    window.removeEventListener(TEXT_REDACTION_ENABLED_EVENT, applyAll)
    window.removeEventListener(TEXT_REDACTION_GLOBAL_SYNC_EVENT, applyAll)
    window.removeEventListener('storage', handleStorage)
    document.body.removeEventListener('input', handleInput, true)

    for (const node of trackedTexts) {
      const state = textStates.get(node)
      if (state && node.nodeValue === state.redacted) node.nodeValue = state.original
    }

    for (const element of trackedElements) {
      const state = attributeStates.get(element)
      if (!state) continue

      for (const [attr, attrState] of state.entries()) {
        if (element.getAttribute(attr) === attrState.redacted) {
          element.setAttribute(attr, attrState.original)
        }
      }
    }

    for (const element of maskedElements) {
      element.classList.remove(TEXT_REDACTION_MASK_CLASS)
    }
    maskedElements.clear()
  }
}
