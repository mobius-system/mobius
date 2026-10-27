const DATA_IMAGE_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;
const DATA_IMAGE_GLOBAL_PATTERN = /data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)/gi;
const BASE64_PATTERN = /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i;
const UNUSED_BASE64_PLACEHOLDER = '[base64 omitted]';

export type HistoryImagePayload = { mime: string; base64: string };

function normalizeBase64(value: string): string {
  return value.replace(/\s/g, '');
}

function imageFromDataUrl(value: string): HistoryImagePayload | null {
  const match = DATA_IMAGE_PATTERN.exec(value.trim());
  if (!match) return null;
  const base64 = normalizeBase64(match[2]);
  if (!base64 || !BASE64_PATTERN.test(base64)) return null;
  return { mime: match[1], base64 };
}

function addImage(
  image: HistoryImagePayload,
  images: HistoryImagePayload[],
  indexes: Map<string, number>,
): void {
  const key = `${image.mime}\u0000${normalizeBase64(image.base64)}`;
  if (indexes.has(key)) return;
  indexes.set(key, images.length);
  images.push({ mime: image.mime, base64: normalizeBase64(image.base64) });
}

function collectImages(
  value: any,
  images: HistoryImagePayload[],
  indexes: Map<string, number>,
  seen: WeakSet<object>,
  foundBase64Field: { value: boolean },
): void {
  if (typeof value === 'string') {
    const image = imageFromDataUrl(value);
    if (image) {
      addImage(image, images, indexes);
      return;
    }
    let match: RegExpExecArray | null;
    while ((match = DATA_IMAGE_GLOBAL_PATTERN.exec(value)) !== null) {
      addImage({ mime: match[1], base64: match[2] }, images, indexes);
      foundBase64Field.value = true;
    }
    DATA_IMAGE_GLOBAL_PATTERN.lastIndex = 0;
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { collectImages(JSON.parse(trimmed), images, indexes, seen, foundBase64Field); } catch {}
    }
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (
    value.type === 'base64'
    && typeof value.data === 'string'
  ) {
    foundBase64Field.value = true;
  }
  if (value.type === 'base64' && typeof value.data === 'string' && BASE64_PATTERN.test(normalizeBase64(value.data))) {
    addImage({
      mime: typeof value.media_type === 'string' && value.media_type.startsWith('image/') ? value.media_type : 'image/png',
      base64: value.data,
    }, images, indexes);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'base64' && typeof child === 'string') {
      foundBase64Field.value = true;
      continue;
    }
    collectImages(child, images, indexes, seen, foundBase64Field);
  }
}

function imageKey(image: HistoryImagePayload): string {
  return `${image.mime}\u0000${normalizeBase64(image.base64)}`;
}

function imageUrl(sessionId: string, entryUuid: string, index: number): string {
  const query = new URLSearchParams({
    session_id: sessionId,
    entry_uuid: entryUuid,
    image_index: String(index),
  });
  return `/access_base64_image?${query.toString()}`;
}

function projectNode(
  value: any,
  sessionId: string,
  entryUuid: string,
  indexes: Map<string, number>,
  path: string[] = [],
): any {
  if (typeof value === 'string') {
    if (path[path.length - 1] === 'base64') return UNUSED_BASE64_PLACEHOLDER;
    const image = imageFromDataUrl(value);
    if (image) {
      const index = indexes.get(imageKey(image));
      return index === undefined ? UNUSED_BASE64_PLACEHOLDER : imageUrl(sessionId, entryUuid, index);
    }
    const projectedText = value.replace(DATA_IMAGE_GLOBAL_PATTERN, (_match, mime: string, base64: string) => {
      const index = indexes.get(imageKey({ mime, base64 }));
      return index === undefined ? UNUSED_BASE64_PLACEHOLDER : imageUrl(sessionId, entryUuid, index);
    });
    DATA_IMAGE_GLOBAL_PATTERN.lastIndex = 0;
    if (projectedText !== value) return projectedText;
    if (/data:image\//i.test(value)) return UNUSED_BASE64_PLACEHOLDER;
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const projected = projectNode(parsed, sessionId, entryUuid, indexes, path);
        return JSON.stringify(projected);
      } catch {}
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => projectNode(child, sessionId, entryUuid, indexes, [...path, String(index)]));
  }
  if (!value || typeof value !== 'object') return value;

  if (value.type === 'base64' && typeof value.data === 'string') {
    return { ...value, data: UNUSED_BASE64_PLACEHOLDER };
  }

  if ((value.type === 'image' || value.type === 'input_image') && value.source?.type === 'base64' && typeof value.source.data === 'string') {
    const image = {
      mime: typeof value.source.media_type === 'string' && value.source.media_type.startsWith('image/')
        ? value.source.media_type
        : 'image/png',
      base64: value.source.data,
    };
    const index = indexes.get(imageKey(image));
    const { data, ...source } = value.source;
    return {
      ...value,
      source: {
        ...source,
        type: 'url',
        url: index === undefined ? '' : imageUrl(sessionId, entryUuid, index),
      },
    };
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'base64' && typeof child === 'string'
        ? UNUSED_BASE64_PLACEHOLDER
        : projectNode(child, sessionId, entryUuid, indexes, [...path, key]),
    ]),
  );
}

/*
 * Replace image payloads in a history entry with stable same-origin resource URLs.
 */
export function projectHistoryEntryImages(sessionId: string, entry: any, entryUuid?: string): any {
  const images: HistoryImagePayload[] = [];
  const indexes = new Map<string, number>();
  const foundBase64Field = { value: false };
  collectImages(entry, images, indexes, new WeakSet<object>(), foundBase64Field);
  if (images.length === 0 && !foundBase64Field.value) return entry;
  return projectNode(entry, sessionId, String(entryUuid || entry?.uuid || ''), indexes);
}

/*
 * Return one unique image payload from a stored history entry.
 */
export function historyEntryImageAt(entry: any, index: number): HistoryImagePayload | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const images: HistoryImagePayload[] = [];
  collectImages(entry, images, new Map<string, number>(), new WeakSet<object>(), { value: false });
  return images[index] || null;
}
