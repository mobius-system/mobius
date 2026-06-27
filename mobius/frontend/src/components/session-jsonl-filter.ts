import { useMemo, useRef } from 'react'
import { jsonlEntrySummaryKey } from './jsonl-view'

const MAJOR_JSONL_TYPES = new Set([
  'user', 'assistant', 'attachment', 'system', 'queue-operation',
  'session_meta', 'turn_context', 'event_msg', 'response_item', 'error',
])

const JSONL_SEQUENCE_KEYS = new Set(['line_no', 'lineNo', '_line_no', '_lineNo', '__line_no', '__lineNo'])
const JSONL_DUPLICATE_SIGNATURE_CACHE = new WeakMap<object, string>()

type VisibleJsonlState = {
  entries: any[]
  hideMinor: boolean
  visibleJsonl: any[]
  minorCount: number
  isMinorByIndex: boolean[]
  plainUserContents: Set<string>
  previousUserMessages: Set<string>
  lastSignature: string | null
  lastSummaryKey: string
}

function normalizeJsonlForDuplicateCheck(value: any, depth = 0): any {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => normalizeJsonlForDuplicateCheck(item, depth + 1))

  const out: Record<string, any> = {}
  for (const key of Object.keys(value).sort()) {
    if (depth === 0 && JSONL_SEQUENCE_KEYS.has(key)) continue
    const child = value[key]
    if (typeof child !== 'undefined') out[key] = normalizeJsonlForDuplicateCheck(child, depth + 1)
  }
  return out
}

function jsonlDuplicateSignature(entry: any): string {
  if (entry && typeof entry === 'object') {
    const cached = JSONL_DUPLICATE_SIGNATURE_CACHE.get(entry)
    if (cached !== undefined) return cached
  }
  try {
    const encoded = JSON.stringify(normalizeJsonlForDuplicateCheck(entry))
    const signature = typeof encoded === 'string' ? encoded : String(entry)
    if (entry && typeof entry === 'object') JSONL_DUPLICATE_SIGNATURE_CACHE.set(entry, signature)
    return signature
  } catch {
    const signature = String(entry)
    if (entry && typeof entry === 'object') JSONL_DUPLICATE_SIGNATURE_CACHE.set(entry, signature)
    return signature
  }
}

function userMessageContentForEventMirror(entry: any): string | null {
  if (entry?.type !== 'user') return null
  const content = entry?.message?.content
  return typeof content === 'string' ? content : null
}

function entryHasMobiusField(entry: any): boolean {
  return Boolean(entry && Object.prototype.hasOwnProperty.call(entry, 'mobius') && entry.mobius)
}

function eventMsgMirrorsPreviousUser(entry: any, previousUserMessages: Set<string>): boolean {
  if (entry?.type !== 'event_msg') return false
  const message = entry?.payload?.message
  return typeof message === 'string' && previousUserMessages.has(message)
}

function isPlainUserEntry(entry: any): boolean {
  return entry?.type === 'user' && !entryHasMobiusField(entry) && userMessageContentForEventMirror(entry) !== null
}

function computeVisibleJsonl(entries: any[], hideMinor: boolean): VisibleJsonlState {
  const hiddenIndexes = new Set<number>()
  const visibleJsonl: any[] = []
  const isMinorByIndex: boolean[] = []
  let minorCount = 0

  let runStart = 0
  let previousEntrySignature: string | null = null
  let previousSummaryKey = ''

  const closeRun = (endExclusive: number) => {
    if (endExclusive - runStart <= 1) return
    for (let i = runStart; i < endExclusive - 1; i++) hiddenIndexes.add(i)
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const signature = jsonlDuplicateSignature(entry)
    const summaryKey = jsonlEntrySummaryKey(entry)
    const sameAsPrevious = i > 0 && (
      signature === previousEntrySignature
      || (!!summaryKey && summaryKey === previousSummaryKey)
    )

    if (!sameAsPrevious) {
      closeRun(i)
      runStart = i
    }

    previousEntrySignature = signature
    previousSummaryKey = summaryKey
  }
  closeRun(entries.length)

  const plainUserContents = new Set<string>()
  for (const entry of entries) {
    if (!isPlainUserEntry(entry)) continue
    const content = userMessageContentForEventMirror(entry)
    if (content !== null) plainUserContents.add(content)
  }

  const previousUserMessages = new Set<string>()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const mirroredUserMessage = eventMsgMirrorsPreviousUser(entry, previousUserMessages)
    const duplicateMobiusCard =
      entry?.type === 'user' &&
      entryHasMobiusField(entry) &&
      plainUserContents.has(userMessageContentForEventMirror(entry) ?? '')
    const isMinor =
      !MAJOR_JSONL_TYPES.has(entry?.type) || hiddenIndexes.has(i) || mirroredUserMessage || duplicateMobiusCard

    isMinorByIndex[i] = isMinor
    if (isMinor) minorCount += 1
    if (!hideMinor || !isMinor) visibleJsonl.push(entry)

    const userMessage = userMessageContentForEventMirror(entry)
    if (userMessage !== null) previousUserMessages.add(userMessage)
  }

  return {
    entries,
    hideMinor,
    visibleJsonl,
    minorCount,
    isMinorByIndex,
    plainUserContents,
    previousUserMessages,
    lastSignature: previousEntrySignature,
    lastSummaryKey: previousSummaryKey,
  }
}

function canUseAppendFastPath(prev: VisibleJsonlState | null, entries: any[], hideMinor: boolean) {
  if (!prev || prev.hideMinor !== hideMinor) return false
  if (entries.length <= prev.entries.length) return false
  if (prev.entries.length === 0) return false
  return prev.entries[prev.entries.length - 1] === entries[prev.entries.length - 1]
}

function appendVisibleJsonl(prev: VisibleJsonlState, entries: any[]): VisibleJsonlState | null {
  const tail = entries.slice(prev.entries.length)
  if (tail.length === 0 || tail.length > 500) return null
  // A later plain user card can retroactively hide an earlier mobius-decorated user card.
  // That is rare and correctness-sensitive, so fall back to the full pass.
  if (tail.some(isPlainUserEntry)) return null

  const next: VisibleJsonlState = {
    entries,
    hideMinor: prev.hideMinor,
    visibleJsonl: prev.visibleJsonl,
    minorCount: prev.minorCount,
    isMinorByIndex: prev.isMinorByIndex.slice(),
    plainUserContents: new Set(prev.plainUserContents),
    previousUserMessages: new Set(prev.previousUserMessages),
    lastSignature: prev.lastSignature,
    lastSummaryKey: prev.lastSummaryKey,
  }

  for (let offset = 0; offset < tail.length; offset++) {
    const entry = tail[offset]
    const index = prev.entries.length + offset
    const signature = jsonlDuplicateSignature(entry)
    const summaryKey = jsonlEntrySummaryKey(entry)
    const sameAsPrevious = index > 0 && (
      signature === next.lastSignature
      || (!!summaryKey && summaryKey === next.lastSummaryKey)
    )

    if (sameAsPrevious) {
      const previousIndex = index - 1
      if (!next.isMinorByIndex[previousIndex]) {
        next.isMinorByIndex[previousIndex] = true
        next.minorCount += 1
        if (next.hideMinor) {
          const previousEntry = entries[previousIndex]
          next.visibleJsonl = next.visibleJsonl.filter(item => item !== previousEntry)
        }
      }
    }

    const mirroredUserMessage = eventMsgMirrorsPreviousUser(entry, next.previousUserMessages)
    const duplicateMobiusCard =
      entry?.type === 'user' &&
      entryHasMobiusField(entry) &&
      next.plainUserContents.has(userMessageContentForEventMirror(entry) ?? '')
    const isMinor =
      !MAJOR_JSONL_TYPES.has(entry?.type) || mirroredUserMessage || duplicateMobiusCard

    next.isMinorByIndex[index] = isMinor
    if (isMinor) next.minorCount += 1
    if (!next.hideMinor || !isMinor) {
      next.visibleJsonl = next.visibleJsonl.concat(entry)
    }

    const userMessage = userMessageContentForEventMirror(entry)
    if (userMessage !== null) next.previousUserMessages.add(userMessage)
    next.lastSignature = signature
    next.lastSummaryKey = summaryKey
  }

  return next
}

export function useVisibleJsonl(entries: any[], hideMinor: boolean) {
  const stateRef = useRef<VisibleJsonlState | null>(null)

  return useMemo(() => {
    const previous = stateRef.current
    const next = canUseAppendFastPath(previous, entries, hideMinor)
      ? appendVisibleJsonl(previous!, entries) || computeVisibleJsonl(entries, hideMinor)
      : computeVisibleJsonl(entries, hideMinor)
    stateRef.current = next
    return {
      visibleJsonl: next.visibleJsonl,
      minorCount: next.minorCount,
    }
  }, [entries, hideMinor])
}
