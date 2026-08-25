import fs from 'fs';
import path from 'path';

const AUTO_COMPACT_INTERVAL = 10;
const AUTO_COMPACT_DIR = '/tmp/mobius-assistant-auto-compact';

function countFileForSession(sessionId: string): string {
  return path.join(AUTO_COMPACT_DIR, `${encodeURIComponent(String(sessionId || ''))}.count`);
}

function readCount(sessionId: string): number {
  try {
    const count = Number.parseInt(fs.readFileSync(countFileForSession(sessionId), 'utf8').trim(), 10);
    return Number.isFinite(count) && count > 0 ? Math.min(count, AUTO_COMPACT_INTERVAL) : 0;
  } catch {
    return 0;
  }
}

function writeCount(sessionId: string, count: number): void {
  fs.mkdirSync(AUTO_COMPACT_DIR, { recursive: true });
  fs.writeFileSync(countFileForSession(sessionId), String(count), 'utf8');
}

function clearAssistantAutoCompactCount(sessionId: string): void {
  try {
    fs.unlinkSync(countFileForSession(sessionId));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[assistant-auto-compact] clear failed (${sessionId}): ${error?.message || error}`);
    }
  }
}

async function afterAssistantHumanInputQueued(
  sessionId: string,
  enqueueCompact: () => Promise<void>,
): Promise<boolean> {
  const nextCount = Math.min(readCount(sessionId) + 1, AUTO_COMPACT_INTERVAL);
  writeCount(sessionId, nextCount);
  if (nextCount < AUTO_COMPACT_INTERVAL) return false;

  try {
    await enqueueCompact();
    clearAssistantAutoCompactCount(sessionId);
    return true;
  } catch (error: any) {
    console.warn(`[assistant-auto-compact] compact failed (${sessionId}): ${error?.message || error}`);
    return false;
  }
}

export {
  AUTO_COMPACT_INTERVAL,
  afterAssistantHumanInputQueued,
  clearAssistantAutoCompactCount,
  countFileForSession,
};
