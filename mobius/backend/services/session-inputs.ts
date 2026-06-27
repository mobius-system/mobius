import * as fs from 'fs';
import * as path from 'path';

const INPUT_LIST_FILE = 'session_input_list.json';

function safeSessionId(sessionId: any): string {
  const sid = String(sessionId || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(sid)) throw new Error('session_id 格式非法');
  return sid;
}

function resolveSessionInputListPath(projectRoot: any, sessionId: any): { sessionId: string; dir: string; filePath: string } {
  const rawRoot = String(projectRoot || '').trim();
  if (!rawRoot) throw new Error('项目未绑定路径');

  const root = path.resolve(rawRoot);
  const sid = safeSessionId(sessionId);
  const baseDir = path.resolve(root, '.imac', 'session_inputs');
  const sessionDir = path.resolve(baseDir, sid);
  if (sessionDir !== baseDir && !sessionDir.startsWith(baseDir + path.sep)) {
    throw new Error('session input 路径越界');
  }
  return {
    sessionId: sid,
    dir: sessionDir,
    filePath: path.join(sessionDir, INPUT_LIST_FILE),
  };
}

function normalizeEntry(entry: any, index: number, sessionId: string): any {
  if (typeof entry === 'string') {
    return {
      id: `legacy-${index}`,
      session_id: sessionId,
      input_text: entry,
      content: entry,
      created_at: '',
    };
  }
  if (!entry || typeof entry !== 'object') return null;

  const inputText = typeof entry.input_text === 'string'
    ? entry.input_text
    : (typeof entry.input === 'string' ? entry.input : '');
  const content = typeof entry.content === 'string' ? entry.content : inputText;
  if (!inputText && !content) return null;

  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : `legacy-${index}`,
    session_id: typeof entry.session_id === 'string' && entry.session_id ? entry.session_id : sessionId,
    input_text: inputText,
    content,
    created_at: typeof entry.created_at === 'string' ? entry.created_at : '',
    request_id: typeof entry.request_id === 'string' ? entry.request_id : null,
    turn_number: Number.isFinite(Number(entry.turn_number)) ? Number(entry.turn_number) : null,
  };
}

function readSessionInputs(projectRoot: any, sessionId: any): { entries: any[]; filePath: string } {
  const resolved = resolveSessionInputListPath(projectRoot, sessionId);
  if (!fs.existsSync(resolved.filePath)) {
    return { entries: [], filePath: resolved.filePath };
  }

  const raw = fs.readFileSync(resolved.filePath, 'utf8');
  if (!raw.trim()) return { entries: [], filePath: resolved.filePath };

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw Object.assign(new Error(`session_input_list.json 解析失败: ${e.message}`), {
      filePath: resolved.filePath,
    });
  }

  const list = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed?.inputs) ? parsed.inputs : []);
  const entries = list
    .map((entry: any, index: number) => normalizeEntry(entry, index, resolved.sessionId))
    .filter(Boolean);

  return { entries, filePath: resolved.filePath };
}

function appendSessionInput({ projectRoot, sessionId, inputText = '', content = '', requestId = null, turnNumber = null }: {
  projectRoot: any;
  sessionId: any;
  inputText?: string;
  content?: string;
  requestId?: any;
  turnNumber?: any;
}): any {
  const resolved = resolveSessionInputListPath(projectRoot, sessionId);
  const body = String(content || '');
  const typed = String(inputText || '');
  if (!typed && !body) return null;

  fs.mkdirSync(resolved.dir, { recursive: true });
  const current = readSessionInputs(projectRoot, resolved.sessionId).entries;
  const now = new Date().toISOString();
  const entry = {
    id: `input-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    session_id: resolved.sessionId,
    input_text: typed,
    content: body,
    created_at: now,
    request_id: requestId || null,
    turn_number: Number.isFinite(Number(turnNumber)) ? Number(turnNumber) : null,
  };

  const next = [...current, entry];
  const tmp = `${resolved.filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, resolved.filePath);
  return entry;
}

export {
  appendSessionInput,
  readSessionInputs,
  resolveSessionInputListPath,
};
