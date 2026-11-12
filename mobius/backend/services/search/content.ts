const Segmenter = (Intl as any).Segmenter;
if (!Segmenter) throw new Error('全文搜索需要支持 Intl.Segmenter 的 Node.js');
const segmenter = new Segmenter('zh', { granularity: 'word' });

export type SearchOptions = { caseSensitive?: boolean; wholeWord?: boolean };

export function searchWords(text: string): string[] {
  const words = new Set<string>();
  const normalized = text.normalize('NFKC').toLowerCase();
  let offset = 0;
  while (offset < normalized.length) {
    let end = Math.min(offset + 4096, normalized.length);
    if (end < normalized.length) {
      const window = normalized.slice(offset, end);
      const boundaries = [...window.matchAll(/\s/gu)];
      const lastBoundary = boundaries[boundaries.length - 1];
      if (lastBoundary) end = offset + lastBoundary.index! + lastBoundary[0].length;
    }
    for (const part of segmenter.segment(normalized.slice(offset, end))) {
      if (part.isWordLike) words.add(part.segment);
    }
    offset = end;
  }
  return [...words];
}

export function indexTokens(text: string): string {
  return searchWords(text).map(word => 'x' + Buffer.from(word).toString('hex')).join(' ');
}

export function parseSearchQuery(value: unknown): { query: string; terms: string[]; match: string } {
  const query = String(value || '').trim();
  if (query.length < 2 || query.length > 200) throw new Error('请输入 2～200 个字符');
  const terms = query.split(/\s+/u).filter(Boolean);
  if (terms.length > 8) throw new Error('最多输入 8 个关键词');
  const words = searchWords(query);
  if (!words.length || words.length > 32) throw new Error('请输入有效的关键词，或减少关键词数量');
  return { query, terms, match: words.map(word => '"x' + Buffer.from(word).toString('hex') + '"').join(' AND ') };
}

export function stripAttachedContext(text: string): string {
  const pairs = [
    { start: /(?:【)?以下信息描述了你正在协助的用户/g, end: /【用户的问题】|## 用户的问题/g },
    { start: /(?:【)?The following describes the user you are assisting/g, end: /【User's Question】|## User's Question/g },
  ];
  for (const pair of pairs) {
    pair.start.lastIndex = 0;
    let opening: RegExpExecArray | null;
    while ((opening = pair.start.exec(text))) {
      pair.end.lastIndex = opening.index + opening[0].length;
      const closing = pair.end.exec(text);
      if (!closing) break;
      text = text.slice(0, opening.index) + '\n\n' + text.slice(closing.index + closing[0].length);
      pair.start.lastIndex = opening.index;
    }
  }
  return text;
}

export function stripImageData(text: string): string {
  return text.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi, ' ');
}

function serializeSearchValue(value: any): string {
  return stripImageData(JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === 'object' &&
      (['image', 'input_image', 'image_url'].includes(nested.type) ||
        nested.type === 'base64' && String(nested.media_type || '').startsWith('image/'))) return undefined;
    return nested;
  }) || '');
}

export function extractSearchContent(entry: any): { role: string; text: string } | null {
  if (!entry || typeof entry !== 'object') return null;
  const message = entry.message || {};
  const payload = entry.payload || {};
  const role = message.role || payload.role || entry.type;
  const parts: string[] = [];
  const append = (value: any): void => {
    if (typeof value === 'string') parts.push(stripImageData(value));
    else if (Array.isArray(value)) value.forEach(append);
    else if (value && typeof value === 'object') {
      if (['image', 'input_image', 'image_url'].includes(value.type)) return;
      if (typeof value.text === 'string') parts.push(value.text);
      else if (typeof value.input_text === 'string') parts.push(value.input_text);
      else if (typeof value.output_text === 'string') parts.push(value.output_text);
      else if (value.type === 'thinking' && typeof value.thinking === 'string') parts.push(value.thinking);
      else if (value.type === 'tool_use') parts.push(value.name || '', serializeSearchValue(value.input ?? {}));
      else if (value.type === 'tool_result') append(value.content);
    }
  };
  append(message.content ?? payload.content ?? entry.content);
  if (!parts.length && ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
    const value = payload.arguments ?? payload.input ?? payload.output ?? payload.content ?? '';
    parts.push(payload.name || '', typeof value === 'string' ? stripImageData(value) : serializeSearchValue(value));
  }
  if (!parts.length && entry.type === 'event_msg' && ['user_message', 'agent_message'].includes(payload.type)) append(payload.message);
  const text = stripAttachedContext(parts.join('\n').replace(/\x00/g, ''));
  if (!text.trim()) return null;
  return { role: role || 'unknown', text };
}

export function matchingSnippet(text: string, terms: string[], options: SearchOptions): string | null {
  const hits: number[] = [];
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = options.wholeWord ? `(?<![\\w])${escaped}(?![\\w])` : escaped;
    const match = new RegExp(pattern, options.caseSensitive ? 'u' : 'iu').exec(text);
    if (!match) return null;
    hits.push(match.index);
  }
  const windows = hits.map((hit, index) => ({ start: Math.max(0, hit - 70), end: Math.min(text.length, hit + terms[index].length + 100) }))
    .sort((left, right) => left.start - right.start);
  const merged: typeof windows = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }
  return merged.map(window => (window.start ? '…' : '') + text.slice(window.start, window.end) + (window.end < text.length ? '…' : '')).join('\n…\n');
}
