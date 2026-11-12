import express from 'express';
import { auth } from '../../middleware/auth';
import { db } from '../../../db';
import { canReadSession } from '../access-control';
import { agentJsonlPathOf } from '../agent-jsonl-path';
import * as agents from '../../agents';
import { backendNameForSessionModel } from '../model-registry';
import { parseSearchQuery } from './content';
import { refreshSearchSources, searchHistory } from './service';

const router = express.Router();

function refreshSources(): void {
  try {
    const sessions = db.prepare('SELECT session_id,model FROM sessions_v2 WHERE deleted_at IS NULL').all() as any[];
    refreshSearchSources(sessions.map(session => {
      const backend = backendNameForSessionModel(session.model);
      return { sessionId: session.session_id, backend, path: agentJsonlPathOf(agents.get(backend), session.session_id) };
    }));
  } catch (error: any) { console.warn('[search] source refresh:', error.message); }
}
setImmediate(refreshSources);
setInterval(refreshSources, 30000).unref();

router.get('/', auth, async (req, res) => {
  const started = Date.now();
  const user = (req as any).user;
  let parsed: ReturnType<typeof parseSearchQuery>;
  try { parsed = parseSearchQuery(req.query.q); }
  catch (error: any) { res.status(400).json({ error: error.message }); return; }
  const allowedKeys = new Set(['q', 'project_id', 'session_id', 'range', 'limit', 'max_fragments', 'case', 'word']);
  if (Object.keys(req.query).some(key => !allowedKeys.has(key))) {
    res.status(400).json({ error: '不支持的搜索参数' }); return;
  }
  const range = String(req.query.range || '7d');
  const days: Record<string, number | null> = { '1d': 1, '7d': 7, '30d': 30, all: null };
  if (!(range in days)) { res.status(400).json({ error: '无效的时间范围' }); return; }
  const projectId = String(req.query.project_id || '');
  const sessionId = String(req.query.session_id || '');
  const conditions = ['s.deleted_at IS NULL'];
  const parameters: any[] = [];
  if (projectId) { conditions.push('s.project_id=?'); parameters.push(projectId); }
  if (sessionId) { conditions.push('s.session_id=?'); parameters.push(sessionId); }
  if (days[range] != null) {
    conditions.push('COALESCE(s.last_active,s.created_at)>=?');
    parameters.push(new Date(Date.now() - days[range]! * 86400000).toISOString());
  }
  const rows = db.prepare(`SELECT s.*,p.name AS project_name,p.description AS project_description,
    i.title AS issue_title,r.title AS research_title FROM sessions_v2 s
    JOIN projects p ON p.id=s.project_id LEFT JOIN issues i ON i.id=s.issue_id
    LEFT JOIN researches r ON r.id=s.research_id WHERE ${conditions.join(' AND ')}
    ORDER BY s.last_active DESC,s.session_id`).all(...parameters) as any[];
  const readable = rows.filter(row => canReadSession(user, row) && (projectId || sessionId
    || !/的小莫(?:助理|项目)$/.test(row.project_name || '')));
  const clamp = (value: any, fallback: number, maximum: number): number => {
    const number = Number(value ?? fallback);
    return Number.isFinite(number) ? Math.max(1, Math.min(maximum, Math.floor(number))) : fallback;
  };
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const found = await searchHistory({ query: parsed.query, sessionIds: readable.map(row => row.session_id),
      caseSensitive: req.query.case === '1', wholeWord: req.query.word === '1',
      limit: clamp(req.query.limit, 50, 100), maxFragments: clamp(req.query.max_fragments, 3, sessionId ? 100 : 5) }, controller.signal);
    if (controller.signal.aborted) return;
    const byId = new Map(readable.map(row => [row.session_id, row]));
    const results = found.hits.flatMap((hit: any) => {
      const current = db.prepare('SELECT * FROM sessions_v2 WHERE session_id=? AND deleted_at IS NULL').get(hit.session_id) as any;
      if (!current || !canReadSession(user, current)) return [];
      const row = byId.get(hit.session_id)!;
      return [{ session_id: row.session_id, session_name: row.name, project_id: row.project_id,
        project_name: row.project_name, issue_id: row.issue_id, issue_title: row.issue_title,
        research_id: row.research_id, research_title: row.research_title, scope_type: row.scope_type,
        last_active: row.last_active, model: row.model, fragments: hit.fragments }];
    });
    res.json({ query: parsed.query, results, total: results.length, range, indexing: found.indexing,
      unavailable_sessions: found.unavailable_sessions, truncated: found.truncated, took_ms: Date.now() - started });
  } catch (error: any) {
    if (!controller.signal.aborted) res.status(503).json({ error: error.message });
  }
});

export = router;
