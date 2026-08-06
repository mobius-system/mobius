import { useMemo } from 'react'

export function SearchMatchText({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    const source = String(text || '')
    const needle = query.trim()
    if (!source || !needle) return [{ text: source, matched: false }]

    const sourceLower = source.toLocaleLowerCase()
    const needleLower = needle.toLocaleLowerCase()
    const result: Array<{ text: string; matched: boolean }> = []
    let cursor = 0
    while (cursor < source.length) {
      const index = sourceLower.indexOf(needleLower, cursor)
      if (index < 0) {
        result.push({ text: source.slice(cursor), matched: false })
        break
      }
      if (index > cursor) result.push({ text: source.slice(cursor, index), matched: false })
      result.push({ text: source.slice(index, index + needle.length), matched: true })
      cursor = index + needle.length
    }
    return result
  }, [text, query])

  return <>{parts.map((part, index) => part.matched ? (
    <mark key={index} className="rounded-sm bg-blue-500/20 text-inherit">{part.text}</mark>
  ) : <span key={index}>{part.text}</span>)}</>
}
