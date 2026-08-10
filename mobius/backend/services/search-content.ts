/**
 * 判断搜索命中是否落在 Mobius 自动注入的上下文框架中。
 *
 * 同一条用户消息可能同时包含上下文和真实问题。只有位于起始说明与
 * “用户的问题”标题之间的文本才应从全局搜索结果中隐藏；标题之后的
 * 用户原始问题仍然可以命中。
 */

type MarkerPair = { start: string[]; end: string[] };

const ZH_MARKERS: MarkerPair = {
  start: ['【以下信息描述了你正在协助的用户】', '以下信息描述了你正在协助的用户'],
  end: ['【用户的问题】', '## 用户的问题'],
};

const EN_MARKERS: MarkerPair = {
  start: [
    '【The following describes the user you are assisting',
    'The following describes the user you are assisting',
  ],
  end: ["【User's Question】", "## User's Question"],
};

function isBetweenMarkerPair(text: string, matchStart: number, matchLength: number, markers: MarkerPair): boolean {
  if (!text || matchStart < 0) return false;
  const matchEnd = matchStart + Math.max(0, matchLength);
  const starts: Array<{ index: number; length: number }> = [];
  for (const marker of markers.start) {
    let index = text.indexOf(marker);
    while (index >= 0) {
      starts.push({ index, length: marker.length });
      index = text.indexOf(marker, index + Math.max(1, marker.length));
    }
  }
  starts.sort((a, b) => b.index - a.index);
  for (const opening of starts) {
    if (opening.index >= matchStart) continue;
    const contentStart = opening.index + opening.length;
    let end = -1;
    for (const marker of markers.end) {
      const candidate = text.indexOf(marker, contentStart);
      if (candidate >= 0 && (end < 0 || candidate < end)) end = candidate;
    }
    if (end >= 0 && matchStart >= contentStart && matchEnd <= end) return true;
  }
  return false;
}

export function is_mobius_attached_content_zh(text: string, matchStart: number, matchLength: number): boolean {
  return isBetweenMarkerPair(String(text || ''), matchStart, matchLength, ZH_MARKERS);
}

export function is_mobius_attached_content_en(text: string, matchStart: number, matchLength: number): boolean {
  return isBetweenMarkerPair(String(text || ''), matchStart, matchLength, EN_MARKERS);
}

export function is_mobius_attached_content(text: string, matchStart: number, matchLength: number): boolean {
  return is_mobius_attached_content_zh(text, matchStart, matchLength)
    || is_mobius_attached_content_en(text, matchStart, matchLength);
}
